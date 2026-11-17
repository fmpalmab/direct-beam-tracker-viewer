"""Background pollers for kotekan status, formed-beam spectrometer, RFI, SEFD, and antenna masks."""

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
    AntennaChannelPowerResponse,
    AntennaMaskStatus,
    AntennaMetricItem,
    BeamPowerResponse,
    BeamSample,
    RfiChannelItem,
    RfiChannelsResponse,
    RfiStatus,
    RfiTopChannel,
    SefdSensitivitySummary,
    SpectrometerData,
    Status,
)
from .sefd_utils import (
    CHANNEL_WIDTH_MHZ,
    N_CHAN_SUBBAND,
    N_CHAN_TOTAL,
    RFI_FREQ_MAD,
    RFI_SK_CW_TONE,
    RFI_SK_IMPULSIVE,
    RFI_STATIC_NOTCH,
    RFI_TIME_BURST,
    SUBBAND0_START_HZ,
    SUBBAND1_START_HZ,
    compute_sefd_summary,
)
from .spectrometer import (
    FREQUENCIES_ALL_MHZ,
    SpectrometerProcessor,
    power_to_db,
)

logger = logging.getLogger(__name__)


class StatusPoller:
    """Polls kotekan /direct_tracker, /rfi_mitigation, and /antenna_mask REST endpoints.

    - Status telemetry: default 2 Hz (0.5 s cadence).
    - Direct beam power: 4 Hz (0.25 s cadence).
    - Output beams spectrometer: default 1 Hz (1.0 s cadence).
    - RFI mitigation & live SEFD/sensitivity: 1 Hz (1.0 s cadence).
    - Antenna mask & 672-ch per-antenna channel power: 1 Hz (1.0 s cadence).
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
        self.rfi_interval = 1.0  # 1 Hz
        self.antenna_mask_interval = 1.0  # 1 Hz
        self.history_len = history
        self.spectrometer_processor = spectrometer_processor or SpectrometerProcessor()
        self.beam_name_provider = beam_name_provider

        self._latest: Status | None = None
        self._latest_spectrometer: SpectrometerData | None = None
        self._latest_direct_beam_power: BeamPowerResponse | None = None
        self._latest_rfi_status: RfiStatus | None = None
        self._latest_rfi_channels: RfiChannelsResponse | None = None
        self._latest_sefd: SefdSensitivitySummary | None = None
        self._latest_antenna_mask: AntennaMaskStatus | None = None
        self._latest_antenna_spectra_db: list[list[float]] = []

        self._history: dict[int, deque[BeamSample]] = defaultdict(
            lambda: deque(maxlen=self.history_len)
        )
        self._subscribers: set[asyncio.Queue[Status]] = set()
        self._spectrometer_subscribers: set[asyncio.Queue[SpectrometerData]] = set()
        self._rfi_subscribers: set[asyncio.Queue[dict[str, Any]]] = set()
        self._sefd_subscribers: set[asyncio.Queue[SefdSensitivitySummary]] = set()
        self._antenna_mask_subscribers: set[asyncio.Queue[AntennaMaskStatus]] = set()

        self._task: asyncio.Task[None] | None = None
        self._spectrometer_task: asyncio.Task[None] | None = None
        self._beam_power_task: asyncio.Task[None] | None = None
        self._rfi_task: asyncio.Task[None] | None = None
        self._antenna_mask_task: asyncio.Task[None] | None = None
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

    def rfi_latest(self) -> RfiStatus | None:
        """Return most recently fetched RfiStatus."""
        return self._latest_rfi_status

    def rfi_channels_latest(self) -> RfiChannelsResponse | None:
        """Return most recently fetched RfiChannelsResponse."""
        return self._latest_rfi_channels

    def rfi_bundle_latest(self) -> dict[str, Any] | None:
        """Return combined RFI status + channels dict for WebSocket snapshots."""
        if self._latest_rfi_status is None:
            return None
        return {
            "status": self._latest_rfi_status.model_dump(),
            "channels": (
                self._latest_rfi_channels.model_dump()
                if self._latest_rfi_channels is not None
                else {"total_channels": 0, "channels": []}
            ),
        }

    def sefd_latest(self) -> SefdSensitivitySummary | None:
        """Return most recently computed SefdSensitivitySummary."""
        return self._latest_sefd

    def antenna_mask_latest(self) -> AntennaMaskStatus | None:
        """Return most recently fetched AntennaMaskStatus."""
        return self._latest_antenna_mask

    def antenna_spectrum(self, antenna_id: int) -> dict[str, Any]:
        """Return per-antenna spectrum from cudaAntennaMaskCommand channel_power."""
        aid = max(0, min(63, int(antenna_id)))
        spec: list[float] = []
        if (
            self._latest_antenna_spectra_db
            and aid < len(self._latest_antenna_spectra_db)
            and len(self._latest_antenna_spectra_db[aid]) > 0
        ):
            spec = self._latest_antenna_spectra_db[aid]
        elif (
            self._latest_antenna_mask is not None
            and aid < len(self._latest_antenna_mask.antennas)
            and len(self._latest_antenna_mask.antennas[aid].spectrum_db) > 0
        ):
            spec = self._latest_antenna_mask.antennas[aid].spectrum_db
        else:
            rng = np.random.default_rng(aid + 42)
            base_db = 4.8 + 1.5 * np.sin(np.linspace(0, 3 * np.pi, N_CHAN_TOTAL))
            spec = np.round(base_db + rng.normal(0, 0.25, N_CHAN_TOTAL), 2).tolist()

        peak_idx = int(np.argmax(spec)) if len(spec) > 0 else 0
        peak_pwr = float(spec[peak_idx]) if len(spec) > 0 else 0.0
        mean_pwr = float(np.mean(spec)) if len(spec) > 0 else 0.0

        if len(spec) == len(FREQUENCIES_ALL_MHZ):
            freqs = FREQUENCIES_ALL_MHZ
        else:
            freqs = [
                round(300.0 + i * (201.6 / max(1, len(spec) - 1)), 2)
                for i in range(len(spec))
            ]

        phys_id: int | None = None
        if self._latest_antenna_mask and aid < len(self._latest_antenna_mask.antennas):
            phys_id = self._latest_antenna_mask.antennas[aid].physical_id

        return {
            "antenna_id": aid,
            "physical_id": phys_id,
            "frequencies_mhz": freqs,
            "spectrum_db": spec,
            "num_channels": len(spec),
            "peak_freq_mhz": freqs[peak_idx] if peak_idx < len(freqs) else 300.0,
            "peak_power_db": round(peak_pwr, 2),
            "mean_power_db": round(mean_pwr, 2),
        }

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

    def subscribe_rfi(self) -> asyncio.Queue[dict[str, Any]]:
        """Subscribe a new WebSocket client for RFI mitigation updates."""
        q: asyncio.Queue[dict[str, Any]] = asyncio.Queue(maxsize=10)
        self._rfi_subscribers.add(q)
        return q

    def unsubscribe_rfi(self, q: asyncio.Queue[dict[str, Any]]) -> None:
        """Unsubscribe a WebSocket client RFI queue."""
        self._rfi_subscribers.discard(q)

    def subscribe_sefd(self) -> asyncio.Queue[SefdSensitivitySummary]:
        """Subscribe a new WebSocket client for SEFD/sensitivity updates."""
        q: asyncio.Queue[SefdSensitivitySummary] = asyncio.Queue(maxsize=10)
        self._sefd_subscribers.add(q)
        return q

    def unsubscribe_sefd(self, q: asyncio.Queue[SefdSensitivitySummary]) -> None:
        """Unsubscribe a WebSocket client SEFD queue."""
        self._sefd_subscribers.discard(q)

    def subscribe_antenna_mask(self) -> asyncio.Queue[AntennaMaskStatus]:
        """Subscribe a new WebSocket client for AntennaMaskStatus updates."""
        q: asyncio.Queue[AntennaMaskStatus] = asyncio.Queue(maxsize=10)
        self._antenna_mask_subscribers.add(q)
        return q

    def unsubscribe_antenna_mask(self, q: asyncio.Queue[AntennaMaskStatus]) -> None:
        """Unsubscribe a WebSocket client antenna mask queue."""
        self._antenna_mask_subscribers.discard(q)

    async def start(self) -> None:
        """Start status, beam power, spectrometer, RFI/SEFD, and antenna mask polling tasks."""
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
        self._rfi_task = asyncio.create_task(self._rfi_loop(), name="rfi-sefd-poller")
        self._antenna_mask_task = asyncio.create_task(
            self._antenna_mask_loop(), name="antenna-mask-poller"
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
                self._rfi_task,
                self._antenna_mask_task,
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
        self._rfi_task = None
        self._antenna_mask_task = None

    async def _poll_loop(self) -> None:
        """Continuous status polling loop (default 2 Hz)."""
        while self._running:
            t0 = time.monotonic()
            try:
                status = await self.client.get_status()
                if not isinstance(status, Status):
                    raise TypeError("Invalid status payload from client")
                now = time.time()

                self._latest = status
                if not self.healthy:
                    logger.info("Connected to kotekan tracker")
                self.healthy = True
                self._logged_error = False

                for beam in status.beams:
                    sample = BeamSample(ts=now, l0=beam.l0, m0=beam.m0)
                    self._history[beam.beam_id].append(sample)

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
        """4 Hz (0.25 s) loop polling direct tracker beam power."""
        while self._running:
            t0 = time.monotonic()
            try:
                direct_bp = await self.client.get_beam_power("/direct_tracker")
                if isinstance(direct_bp, BeamPowerResponse):
                    self._latest_direct_beam_power = direct_bp
            except asyncio.CancelledError:
                break
            except Exception:
                pass

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
                buf_0, buf_1 = await asyncio.gather(
                    self.client.get_inspect_frame("host_formed_beams_buffer_0"),
                    self.client.get_inspect_frame("host_formed_beams_buffer_1"),
                )

                configured_beams = (
                    len(self._latest.beams)
                    if (self._latest and self._latest.beams)
                    else 2
                )
                spec_data = self.spectrometer_processor.process(
                    buf_0=buf_0 if isinstance(buf_0, bytes) else None,
                    buf_1=buf_1 if isinstance(buf_1, bytes) else None,
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

    def _make_synthetic_rfi(self) -> tuple[RfiStatus, RfiChannelsResponse]:
        """Generate realistic 672-ch RFI telemetry when Kotekan is offline."""
        rng = np.random.default_rng(108)
        items: list[RfiChannelItem] = []
        flagged_items: list[RfiTopChannel] = []
        sum_frac = 0.0

        for i in range(N_CHAN_TOTAL):
            sb = 0 if i < N_CHAN_SUBBAND else 1
            lch = i if sb == 0 else (i - N_CHAN_SUBBAND)
            f0 = SUBBAND0_START_HZ if sb == 0 else SUBBAND1_START_HZ
            freq_mhz = round((f0 * 1.0e-6) + lch * CHANNEL_WIDTH_MHZ, 3)

            # Smooth bandpass centered at ~3.06 LSB^2 (sigma ~ 1.70 LSB, eta_q ~ 0.972)
            band_shape = 3.05 + 0.45 * np.sin(2.0 * np.pi * i / 280.0)
            mean_pwr = float(max(0.4, band_shape + rng.normal(0.0, 0.06)))
            mean_sk = float(np.clip(1.0 + rng.normal(0.0, 0.03), 0.75, 1.35))
            max_sk = float(mean_sk + abs(rng.normal(0.05, 0.03)))
            mad_z = float(rng.normal(0.0, 0.4))
            frac = 0.0
            bits = 0

            if 362.0 <= freq_mhz <= 378.0:
                bits = RFI_STATIC_NOTCH
                frac = 1.0
                mean_pwr *= 1.4
            elif abs(freq_mhz - 414.0) < 0.2:
                bits = RFI_SK_CW_TONE | RFI_FREQ_MAD
                mean_sk = 0.14
                max_sk = 0.28
                mad_z = 16.5
                frac = 1.0
                mean_pwr = 14.2
            elif abs(freq_mhz - 382.2) < 0.2:
                bits = RFI_SK_IMPULSIVE | RFI_TIME_BURST
                mean_sk = 2.65
                max_sk = 4.9
                mad_z = 7.4
                frac = 0.42
                mean_pwr = 8.9

            sum_frac += frac
            item = RfiChannelItem(
                freq_mhz=freq_mhz,
                subband=sb,
                local_channel=lch,
                mean_power=round(mean_pwr, 4),
                mean_sk=round(mean_sk, 4),
                max_sk=round(max_sk, 4),
                freq_mad_z=round(mad_z, 3),
                flagged_chunk_fraction=round(frac, 4),
                flag_bits=bits,
                gain=1.0,
            )
            items.append(item)
            if bits != 0:
                flagged_items.append(
                    RfiTopChannel(
                        freq_mhz=item.freq_mhz,
                        mean_power=item.mean_power,
                        mean_sk=item.mean_sk,
                        max_sk=item.max_sk,
                        freq_mad_z=item.freq_mad_z,
                        flagged_chunk_fraction=item.flagged_chunk_fraction,
                        flag_bits=item.flag_bits,
                    )
                )

        flagged_items.sort(
            key=lambda x: (x.flagged_chunk_fraction, x.max_sk), reverse=True
        )
        rfi_status = RfiStatus(
            enabled=True,
            blank_voltages_enabled=True,
            static_notch_bands_mhz=[[362.0, 378.0]],
            total_channels=len(items),
            flagged_channels=len(flagged_items),
            overall_flagged_chunk_fraction=round(sum_frac / len(items), 5),
            top_rfi_channels=flagged_items[:20],
        )
        rfi_channels = RfiChannelsResponse(
            total_channels=len(items),
            channels=items,
        )
        return rfi_status, rfi_channels

    async def _rfi_loop(self) -> None:
        """1 Hz loop polling RFI mitigation telemetry and computing live SEFD/sensitivity."""
        while self._running:
            t0 = time.monotonic()
            try:
                res_status, res_channels = await asyncio.gather(
                    self.client.get_rfi_status(),
                    self.client.get_rfi_channels(),
                    return_exceptions=True,
                )
                rfi_status = (
                    res_status if isinstance(res_status, RfiStatus) else None
                )
                rfi_channels = (
                    res_channels
                    if isinstance(res_channels, RfiChannelsResponse)
                    and len(res_channels.channels) > 0
                    else None
                )

                if rfi_status is None or rfi_channels is None:
                    syn_status, syn_channels = self._make_synthetic_rfi()
                    if rfi_status is None:
                        rfi_status = syn_status
                    if rfi_channels is None:
                        rfi_channels = syn_channels

                self._latest_rfi_status = rfi_status
                self._latest_rfi_channels = rfi_channels

                sefd_summary = compute_sefd_summary(
                    status=self._latest,
                    antenna_mask=self._latest_antenna_mask,
                    rfi_status=rfi_status,
                    rfi_channels=rfi_channels,
                    beam_names=self.beam_name_provider()
                    if self.beam_name_provider
                    else None,
                )
                self._latest_sefd = sefd_summary

                self._broadcast_rfi(
                    {
                        "status": rfi_status.model_dump(),
                        "channels": rfi_channels.model_dump(),
                    }
                )
                self._broadcast_sefd(sefd_summary)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Error in RFI/SEFD loop: %s", exc)

            elapsed = time.monotonic() - t0
            sleep_time = max(0.01, self.rfi_interval - elapsed)
            try:
                await asyncio.sleep(sleep_time)
            except asyncio.CancelledError:
                break

    def _make_synthetic_antenna_mask(self) -> AntennaMaskStatus:
        """Generate nominal fallback AntennaMaskStatus for 64 antennas."""
        rng = np.random.default_rng(42)
        base_curve = 4.8 + 1.5 * np.sin(np.linspace(0, 3 * np.pi, 84))
        items = []
        for i in range(64):
            noise = rng.normal(0, 0.25, 84)
            spec = np.round(base_curve + noise + rng.uniform(-0.5, 0.5), 2).tolist()
            items.append(
                AntennaMetricItem(
                    antenna_id=i,
                    raw_id=i,
                    physical_id=63 - i,
                    enabled=True,
                    power_rms=round(3.1 + float(rng.uniform(-0.3, 0.3)), 3),
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
            active_raw_elements=list(range(64)),
            active_physical_antennas=list(range(63, -1, -1)),
            antennas=items,
        )

    def _extract_antenna_spectra(
        self,
        ch_pwr: AntennaChannelPowerResponse | None,
        mask_status: AntennaMaskStatus,
    ) -> tuple[list[list[float]], list[list[float]]]:
        """Convert AntennaChannelPowerResponse matrices into 672-ch and 84-bin dB spectra."""
        n_elem = max(64, len(mask_status.antennas))
        masked_set = {
            ant.antenna_id for ant in mask_status.antennas if not ant.enabled
        }

        sb_blocks: list[np.ndarray] = []
        if ch_pwr is not None and ch_pwr.subbands:
            for sb in sorted(ch_pwr.subbands, key=lambda s: s.freq_start_hz):
                if sb.has_channel_power and sb.channel_power:
                    arr = np.asarray(sb.channel_power, dtype=np.float32)
                    if arr.ndim == 2 and arr.shape[0] > 0 and arr.shape[1] > 0:
                        sb_blocks.append(arr)

        if sb_blocks:
            full_lin = (
                np.concatenate(sb_blocks, axis=0)
                if len(sb_blocks) > 1
                else sb_blocks[0]
            )
            full_db = power_to_db(full_lin, floor_db=-30.0)  # (n_freq, n_elem)
            n_freq, actual_elem = full_db.shape
            if actual_elem < n_elem:
                pad = np.full((n_freq, n_elem - actual_elem), -30.0, dtype=np.float32)
                full_db = np.hstack([full_db, pad])
            for m_id in masked_set:
                if 0 <= m_id < n_elem:
                    full_db[:, m_id] = -30.0

            full_list = np.round(full_db.T, 2).tolist()
            num_bins = 84
            bin_sz = max(1, n_freq // num_bins)
            if n_freq >= num_bins and bin_sz > 1:
                mini = (
                    full_db[: num_bins * bin_sz]
                    .reshape(num_bins, bin_sz, n_elem)
                    .mean(axis=1)
                    .T
                )
                mini_list = np.round(mini, 2).tolist()
            else:
                mini_list = np.round(full_db.T, 2).tolist()
            return full_list, mini_list

        # Fallback: realistic deterministic spectra when channel_power isn't populated
        rng = np.random.default_rng(100)
        x = np.linspace(0.0, 3.0 * np.pi, N_CHAN_TOTAL)
        base = 4.8 + 1.5 * np.sin(x)
        full_mat = np.tile(base, (n_elem, 1)) + rng.normal(
            0.0, 0.25, size=(n_elem, N_CHAN_TOTAL)
        )
        for i in range(n_elem):
            if i in masked_set:
                full_mat[i, :] = 0.0
        full_list = np.round(full_mat, 2).tolist()
        mini_mat = full_mat.reshape(n_elem, 84, N_CHAN_TOTAL // 84).mean(axis=2)
        mini_list = np.round(mini_mat, 2).tolist()
        return full_list, mini_list

    async def _antenna_mask_loop(self) -> None:
        """1 Hz loop polling antenna mask status and per-antenna channel power spectra."""
        while self._running:
            t0 = time.monotonic()
            try:
                res_mask, res_ch_pwr = await asyncio.gather(
                    self.client.get_antenna_mask_status(),
                    self.client.get_antenna_channel_power(),
                    return_exceptions=True,
                )

                mask_status = (
                    res_mask
                    if isinstance(res_mask, AntennaMaskStatus)
                    and (len(res_mask.antennas) > 0 or res_mask.num_elements > 0)
                    else None
                )
                if mask_status is None:
                    if self._latest_antenna_mask is None:
                        mask_status = self._make_synthetic_antenna_mask()
                    else:
                        mask_status = self._latest_antenna_mask

                ch_pwr = (
                    res_ch_pwr
                    if isinstance(res_ch_pwr, AntennaChannelPowerResponse)
                    else None
                )

                if mask_status.antennas:
                    masked_set = {
                        ant.antenna_id for ant in mask_status.antennas if not ant.enabled
                    }
                    n_total = len(mask_status.antennas)
                    mask_status.active_antennas = n_total - len(masked_set)
                    mask_status.active_elements = mask_status.active_antennas
                    mask_status.masked_antennas = len(masked_set)

                full_specs, mini_specs = self._extract_antenna_spectra(
                    ch_pwr, mask_status
                )
                self._latest_antenna_spectra_db = full_specs
                for i, ant in enumerate(mask_status.antennas):
                    if i < len(mini_specs):
                        ant.spectrum_db = (
                            [0.0] * len(mini_specs[i])
                            if not ant.enabled
                            else mini_specs[i]
                        )

                self._latest_antenna_mask = mask_status
                self._broadcast_antenna_mask(mask_status)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Error in antenna mask loop: %s", exc)

            elapsed = time.monotonic() - t0
            sleep_time = max(0.01, self.antenna_mask_interval - elapsed)
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

    def _broadcast_rfi(self, payload: dict[str, Any]) -> None:
        """Push RFI mitigation bundle to subscribers, dropping stale items if slow."""
        for q in list(self._rfi_subscribers):
            if q.qsize() >= 5:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                pass

    def _broadcast_sefd(self, sefd: SefdSensitivitySummary) -> None:
        """Push SEFD/sensitivity summary to subscribers, dropping stale items if slow."""
        for q in list(self._sefd_subscribers):
            if q.qsize() >= 5:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(sefd)
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
