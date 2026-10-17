"""Background poller for kotekan status and formed beams line spectrometer."""

from __future__ import annotations

import asyncio
import logging
import time
from collections import defaultdict, deque
from collections.abc import Callable
from typing import Any

import httpx
import numpy as np

from .client import TrackerClient, TrackerError
from .models import (
    AntennaMaskStatus,
    AntennaMetricItem,
    BeamPowerResponse,
    BeamSample,
    CorrelatorDiagnostics,
    SkyGridFrame,
    SpectrometerData,
    Status,
)
from .spectrometer import (
    FREQUENCIES_ALL_MHZ,
    SpectrometerProcessor,
    compute_correlator_diagnostics,
    format_sky_grid_frame,
    unpack_astron_visibilities,
)

logger = logging.getLogger(__name__)


class StatusPoller:
    """Polls kotekan /direct_tracker/status and inspection buffers.

    - Status telemetry: default 2 Hz (0.5 s cadence).
    - Output beams spectrometer: default 1 Hz (1.0 s cadence).
    - Beam power (direct & grid): 4 Hz (0.25 s cadence).
    - Antenna mask and correlator visibilities: 1 Hz (1.0 s cadence).
    Maintains ring buffer history of (l, m) tracks and broadcasts updates to WebSocket queues.
    """

    def __init__(
        self,
        client: TrackerClient,
        interval: float = 0.5,
        spectrometer_interval: float = 1.0,
        history: int = 600,
        spectrometer_processor: SpectrometerProcessor | None = None,
        beam_name_provider: Callable[[], dict[int, str]] | None = None,
    ) -> None:
        self.client = client
        self.interval = max(0.2, interval)
        self.spectrometer_interval = max(0.2, spectrometer_interval)
        self.beam_power_interval = 0.25  # 4 Hz
        self.correlator_interval = 1.0  # 1 Hz
        self.history_len = history
        self.spectrometer_processor = spectrometer_processor or SpectrometerProcessor()
        # Optional beam_id -> target label map (e.g. from the observation routine)
        self.beam_name_provider = beam_name_provider

        self._latest: Status | None = None
        self._latest_spectrometer: SpectrometerData | None = None
        self._latest_direct_beam_power: BeamPowerResponse | None = None
        self._latest_grid: SkyGridFrame | None = None
        self._latest_correlator: CorrelatorDiagnostics | None = None
        self._latest_antenna_mask: AntennaMaskStatus | None = None
        self._latest_vis_cube: np.ndarray | None = None

        self._history: dict[int, deque[BeamSample]] = defaultdict(
            lambda: deque(maxlen=self.history_len)
        )
        self._subscribers: set[asyncio.Queue[Status]] = set()
        self._spectrometer_subscribers: set[asyncio.Queue[SpectrometerData]] = set()
        self._grid_subscribers: set[asyncio.Queue[SkyGridFrame]] = set()
        self._correlator_subscribers: set[asyncio.Queue[CorrelatorDiagnostics]] = set()
        self._antenna_mask_subscribers: set[asyncio.Queue[AntennaMaskStatus]] = set()

        self._task: asyncio.Task[None] | None = None
        self._spectrometer_task: asyncio.Task[None] | None = None
        self._beam_power_task: asyncio.Task[None] | None = None
        self._correlator_mask_task: asyncio.Task[None] | None = None
        self._running: bool = False
        self.healthy: bool = False
        self._logged_error: bool = False
        self.start_time: float = time.time()

    @property
    def uptime_s(self) -> float:
        """Seconds since poller initialized."""
        return time.time() - self.start_time

    def latest(self) -> Status | None:
        """Return most recently fetched Status, or None if none yet."""
        return self._latest

    def spectrometer_latest(self) -> SpectrometerData | None:
        """Return most recently computed SpectrometerData, or None if none yet."""
        return self._latest_spectrometer

    def direct_beam_power_latest(self) -> BeamPowerResponse | None:
        """Return most recently fetched BeamPowerResponse for direct tracker."""
        return self._latest_direct_beam_power

    def grid_latest(self) -> SkyGridFrame | None:
        """Return most recently formatted SkyGridFrame."""
        return self._latest_grid

    def correlator_latest(self) -> CorrelatorDiagnostics | None:
        """Return most recently computed CorrelatorDiagnostics."""
        return self._latest_correlator

    def latest_vis_cube(self) -> np.ndarray | None:
        """Return most recent (672, 64, 64) complex visibility cube if available."""
        return self._latest_vis_cube

    def get_baseline_spectrum(self, ant_i: int, ant_j: int) -> dict[str, Any]:
        """Return 672-channel complex visibility spectrum and delay fit for baseline (ant_i, ant_j)."""
        ant_i = max(0, min(63, int(ant_i)))
        ant_j = max(0, min(63, int(ant_j)))
        if self._latest_vis_cube is not None and self._latest_vis_cube.shape[0] >= 672:
            vis = self._latest_vis_cube[:, ant_i, ant_j]
        else:
            # Synthetic realistic interferometer baseline with geometric delay
            n_f = len(FREQUENCIES_ALL_MHZ)
            freqs = np.array(FREQUENCIES_ALL_MHZ, dtype=np.float64)
            tau_ns = (ant_i - ant_j) * 0.354
            phase = (2.0 * np.pi * (freqs - 300.0) * 1e6 * (tau_ns * 1e-9)) % (2 * np.pi) - np.pi
            rng = np.random.default_rng(ant_i * 64 + ant_j)
            amp = 0.5 + 0.3 * np.cos(np.linspace(0, 4 * np.pi, n_f)) + rng.normal(0, 0.05, n_f)
            amp = np.clip(amp, 0.01, 1.0)
            vis = (amp * np.exp(1j * phase)).astype(np.complex64)

        amp_arr = np.abs(vis)
        phase_arr = np.angle(vis)

        # Estimate delay tau from phase gradient: dphi/df / (2*pi)
        if len(FREQUENCIES_ALL_MHZ) > 1:
            unwrapped = np.unwrap(phase_arr)
            df_hz = (FREQUENCIES_ALL_MHZ[-1] - FREQUENCIES_ALL_MHZ[0]) * 1e6
            dphi = unwrapped[-1] - unwrapped[0]
            delay_ns = float(dphi / (2 * np.pi * max(1.0, df_hz)) * 1e9)
        else:
            delay_ns = 0.0

        return {
            "antenna_a": ant_i,
            "antenna_b": ant_j,
            "frequencies_mhz": FREQUENCIES_ALL_MHZ,
            "amplitude": np.round(amp_arr, 4).tolist(),
            "phase_rad": np.round(phase_arr, 4).tolist(),
            "real": np.round(vis.real, 4).tolist(),
            "imag": np.round(vis.imag, 4).tolist(),
            "delay_ns": round(delay_ns, 3),
        }

    def antenna_mask_latest(self) -> AntennaMaskStatus | None:
        """Return most recently fetched AntennaMaskStatus."""
        return self._latest_antenna_mask

    def history(self, beam_id: int) -> list[BeamSample]:
        """Return history slice for the given beam_id."""
        return list(self._history.get(beam_id, []))

    def all_history(self, max_points: int = 120) -> dict[int, list[BeamSample]]:
        """Return recent history slice for all tracked beams in a single call."""
        result: dict[int, list[BeamSample]] = {}
        for beam_id, dq in self._history.items():
            if max_points and len(dq) > max_points:
                result[beam_id] = list(dq)[-max_points:]
            else:
                result[beam_id] = list(dq)
        return result

    def subscribe(self) -> asyncio.Queue[Status]:
        """Subscribe a new WebSocket client for Status updates."""
        q: asyncio.Queue[Status] = asyncio.Queue(maxsize=20)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[Status]) -> None:
        """Unsubscribe a WebSocket client status queue."""
        self._subscribers.discard(q)

    def subscribe_spectrometer(self) -> asyncio.Queue[SpectrometerData]:
        """Subscribe a new WebSocket client for Spectrometer updates."""
        q: asyncio.Queue[SpectrometerData] = asyncio.Queue(maxsize=10)
        self._spectrometer_subscribers.add(q)
        return q

    def unsubscribe_spectrometer(self, q: asyncio.Queue[SpectrometerData]) -> None:
        """Unsubscribe a WebSocket client spectrometer queue."""
        self._spectrometer_subscribers.discard(q)

    def subscribe_grid(self) -> asyncio.Queue[SkyGridFrame]:
        """Subscribe a new WebSocket client for 4x4 SkyGridFrame updates."""
        q: asyncio.Queue[SkyGridFrame] = asyncio.Queue(maxsize=10)
        self._grid_subscribers.add(q)
        return q

    def unsubscribe_grid(self, q: asyncio.Queue[SkyGridFrame]) -> None:
        """Unsubscribe a WebSocket client grid queue."""
        self._grid_subscribers.discard(q)

    def subscribe_correlator(self) -> asyncio.Queue[CorrelatorDiagnostics]:
        """Subscribe a new WebSocket client for CorrelatorDiagnostics updates."""
        q: asyncio.Queue[CorrelatorDiagnostics] = asyncio.Queue(maxsize=10)
        self._correlator_subscribers.add(q)
        return q

    def unsubscribe_correlator(self, q: asyncio.Queue[CorrelatorDiagnostics]) -> None:
        """Unsubscribe a WebSocket client correlator queue."""
        self._correlator_subscribers.discard(q)

    def subscribe_antenna_mask(self) -> asyncio.Queue[AntennaMaskStatus]:
        """Subscribe a new WebSocket client for AntennaMaskStatus updates."""
        q: asyncio.Queue[AntennaMaskStatus] = asyncio.Queue(maxsize=10)
        self._antenna_mask_subscribers.add(q)
        return q

    def unsubscribe_antenna_mask(self, q: asyncio.Queue[AntennaMaskStatus]) -> None:
        """Unsubscribe a WebSocket client antenna mask queue."""
        self._antenna_mask_subscribers.discard(q)

    async def start(self) -> None:
        """Start status, beam power, spectrometer, and correlator/mask background polling tasks."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop(), name="status-poller")
        self._beam_power_task = asyncio.create_task(
            self._beam_power_loop(), name="beam-power-poller"
        )
        self._spectrometer_task = asyncio.create_task(
            self._spectrometer_loop(), name="spectrometer-poller"
        )
        self._correlator_mask_task = asyncio.create_task(
            self._correlator_mask_loop(), name="correlator-mask-poller"
        )

    async def stop(self) -> None:
        """Stop background polling tasks."""
        self._running = False
        tasks = [
            t
            for t in (
                self._task,
                self._beam_power_task,
                self._spectrometer_task,
                self._correlator_mask_task,
            )
            if t is not None
        ]
        for task in tasks:
            task.cancel()
        for task in tasks:
            try:
                await task
            except asyncio.CancelledError:
                pass
        self._task = None
        self._beam_power_task = None
        self._spectrometer_task = None
        self._correlator_mask_task = None

    async def _poll_loop(self) -> None:
        """Continuous status polling loop (default 2 Hz)."""
        while self._running:
            t0 = time.monotonic()
            try:
                status = await self.client.get_status()
                now = time.time()

                self._latest = status
                if not self.healthy:
                    logger.info("Connected to kotekan tracker")
                self.healthy = True
                self._logged_error = False

                # Update history ring buffers
                for beam in status.beams:
                    sample = BeamSample(ts=now, l0=beam.l0, m0=beam.m0)
                    self._history[beam.beam_id].append(sample)

                # Fan out to status subscribers
                self._broadcast(status)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                self.healthy = False
                if not self._logged_error:
                    logger.warning("Error polling kotekan status: %s", exc)
                    self._logged_error = True

            elapsed = time.monotonic() - t0
            sleep_time = max(0.01, self.interval - elapsed)
            try:
                await asyncio.sleep(sleep_time)
            except asyncio.CancelledError:
                break

    async def _beam_power_loop(self) -> None:
        """4 Hz (0.25 s) loop polling direct tracker beam power and 16-beam sky grid camera."""
        while self._running:
            t0 = time.monotonic()
            # 1. Direct tracker beam power
            try:
                direct_bp = await self.client.get_beam_power("/direct_tracker")
                self._latest_direct_beam_power = direct_bp
            except Exception:
                pass

            # 2. Grid tracker beam power (4x4 sky grid camera)
            try:
                grid_bp = await self.client.get_grid_beam_power()
                grid_frame = format_sky_grid_frame(grid_bp.beam_power)
                self._latest_grid = grid_frame
                self._broadcast_grid(grid_frame)
            except Exception:
                grid_frame = format_sky_grid_frame(None)
                self._latest_grid = grid_frame
                self._broadcast_grid(grid_frame)

            elapsed = time.monotonic() - t0
            sleep_time = max(0.01, self.beam_power_interval - elapsed)
            try:
                await asyncio.sleep(sleep_time)
            except asyncio.CancelledError:
                break

    async def _spectrometer_loop(self) -> None:
        """Continuous spectrometer processing loop (default 1 Hz)."""
        while self._running:
            t0 = time.monotonic()
            try:
                # 1. Fetch inspection frames from both streams concurrently (if available)
                buf_0, buf_1 = await asyncio.gather(
                    self.client.get_inspect_frame("host_formed_beams_buffer_0"),
                    self.client.get_inspect_frame("host_formed_beams_buffer_1"),
                )

                # 2. Process into calibrated power spectra
                configured_beams = (
                    len(self._latest.beams)
                    if (self._latest and self._latest.beams)
                    else 2
                )
                spec_data = self.spectrometer_processor.process(
                    buf_0=buf_0,
                    buf_1=buf_1,
                    status=self._latest,
                    max_beams=configured_beams,
                    beam_names=self.beam_name_provider()
                    if self.beam_name_provider
                    else None,
                    cadence_s=self.spectrometer_interval,
                    direct_beam_power=self._latest_direct_beam_power.beam_power
                    if self._latest_direct_beam_power
                    else None,
                )
                self._latest_spectrometer = spec_data

                # 3. Fan out to spectrometer subscribers
                self._broadcast_spectrometer(spec_data)

            except asyncio.CancelledError:
                break
            except (httpx.HTTPError, TrackerError) as exc:
                logger.warning("Network/client error updating spectrometer: %s", exc)
            except (ValueError, TypeError, AttributeError) as exc:
                logger.warning("Data processing error updating spectrometer: %s", exc)
            except Exception as exc:
                logger.error(
                    "Unexpected error updating spectrometer: %s", exc, exc_info=True
                )

            elapsed = time.monotonic() - t0
            sleep_time = max(0.01, self.spectrometer_interval - elapsed)
            try:
                await asyncio.sleep(sleep_time)
            except asyncio.CancelledError:
                break

    def _make_synthetic_antenna_mask(self) -> AntennaMaskStatus:
        """Generate nominal fallback AntennaMaskStatus for 64 antennas."""
        rng = np.random.default_rng(42)
        base_curve = 12.0 + 3.0 * np.sin(np.linspace(0, 3 * np.pi, 84))
        items = []
        for i in range(64):
            noise = rng.normal(0, 0.4, 84)
            spec = np.round(base_curve + noise + rng.uniform(-1.0, 1.0), 1).tolist()
            items.append(
                AntennaMetricItem(
                    antenna_id=i,
                    enabled=True,
                    power_rms=8.0 + float(rng.uniform(-0.5, 0.5)),
                    clip_fraction=0.001,
                    kurtosis=3.0,
                    robust_z_score=0.0,
                    status="nominal",
                    spectrum_db=spec,
                )
            )
        return AntennaMaskStatus(
            num_elements=64,
            num_antennas=64,
            auto_detect_enabled=True,
            blank_voltages_enabled=True,
            manual_mask=[1] * 64,
            active_antennas=64,
            active_elements=64,
            masked_antennas=0,
            antennas=items,
        )

    async def _correlator_mask_loop(self) -> None:
        """1 Hz loop polling antenna mask and correlation visibilities."""
        while self._running:
            t0 = time.monotonic()

            # 1. Poll Antenna Mask first so masked elements propagate to correlator matrices
            try:
                mask_status = await self.client.get_antenna_mask_status()
                self._latest_antenna_mask = mask_status
            except Exception:
                if self._latest_antenna_mask is None:
                    self._latest_antenna_mask = self._make_synthetic_antenna_mask()
                mask_status = self._latest_antenna_mask

            masked_set: set[int] = {
                ant.antenna_id for ant in mask_status.antennas if not ant.enabled
            }
            mask_status.active_antennas = 64 - len(masked_set)
            mask_status.active_elements = 64 - len(masked_set)
            mask_status.masked_antennas = len(masked_set)

            # 2. Correlator Visibilities
            try:
                buf_0, buf_1 = await asyncio.gather(
                    self.client.get_inspect_frame("integrated_correlation_buffer_0"),
                    self.client.get_inspect_frame("integrated_correlation_buffer_1"),
                )
                vis_0 = unpack_astron_visibilities(buf_0)
                vis_1 = unpack_astron_visibilities(buf_1)
                if vis_0 is not None and vis_1 is not None:
                    vis_cube = np.concatenate([vis_0, vis_1], axis=0)
                    self._latest_vis_cube = vis_cube
                    corr_diag = compute_correlator_diagnostics(
                        vis_cube=vis_cube, masked_antennas=masked_set
                    )
                elif vis_0 is not None:
                    self._latest_vis_cube = vis_0
                    corr_diag = compute_correlator_diagnostics(
                        subband_0=vis_0, masked_antennas=masked_set
                    )
                else:
                    self._latest_vis_cube = None
                    corr_diag = compute_correlator_diagnostics(
                        subband_0=vis_0, subband_1=vis_1, masked_antennas=masked_set
                    )
                self._latest_correlator = corr_diag
                self._broadcast_correlator(corr_diag)
            except Exception as exc:
                logger.debug("Correlator polling error, using fallback: %s", exc)
                self._latest_vis_cube = None
                corr_diag = compute_correlator_diagnostics(masked_antennas=masked_set)
                self._latest_correlator = corr_diag
                self._broadcast_correlator(corr_diag)

            # 3. Attach per-antenna spectra to mask status and broadcast
            if corr_diag and corr_diag.antenna_spectra_db:
                for i, ant in enumerate(mask_status.antennas):
                    if i < len(corr_diag.antenna_spectra_db):
                        ant.spectrum_db = (
                            [0.0] * len(corr_diag.antenna_spectra_db[i])
                            if not ant.enabled
                            else corr_diag.antenna_spectra_db[i]
                        )
            self._broadcast_antenna_mask(mask_status)

            elapsed = time.monotonic() - t0
            sleep_time = max(0.01, self.correlator_interval - elapsed)
            try:
                await asyncio.sleep(sleep_time)
            except asyncio.CancelledError:
                break

    def _broadcast(self, status: Status) -> None:
        """Push status to subscriber queues, dropping stale items if client is slow."""
        for q in list(self._subscribers):
            if q.qsize() >= 10:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(status)
            except asyncio.QueueFull:
                pass

    def _broadcast_spectrometer(self, spec_data: SpectrometerData) -> None:
        """Push spectrometer data to subscribers, dropping stale items if client is slow."""
        for q in list(self._spectrometer_subscribers):
            if q.qsize() >= 5:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(spec_data)
            except asyncio.QueueFull:
                pass

    def _broadcast_grid(self, grid: SkyGridFrame) -> None:
        """Push sky grid frame to subscribers, dropping stale items if client is slow."""
        for q in list(self._grid_subscribers):
            if q.qsize() >= 5:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(grid)
            except asyncio.QueueFull:
                pass

    def _broadcast_correlator(self, corr: CorrelatorDiagnostics) -> None:
        """Push correlator diagnostics to subscribers, dropping stale items if client is slow."""
        for q in list(self._correlator_subscribers):
            if q.qsize() >= 5:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(corr)
            except asyncio.QueueFull:
                pass

    def _broadcast_antenna_mask(self, mask: AntennaMaskStatus) -> None:
        """Push antenna mask status to subscribers, dropping stale items if client is slow."""
        for q in list(self._antenna_mask_subscribers):
            if q.qsize() >= 5:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(mask)
            except asyncio.QueueFull:
                pass
