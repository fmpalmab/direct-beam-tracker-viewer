"""Background poller for kotekan status and formed beams line spectrometer."""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
import logging
import time
from typing import Any, Callable

from .client import TrackerClient
from .models import BeamSample, SpectrometerData, Status
from .spectrometer import SpectrometerProcessor

logger = logging.getLogger(__name__)


class StatusPoller:
    """Polls kotekan /direct_tracker/status and inspection buffers.

    - Status telemetry: default 2 Hz (0.5 s cadence).
    - Output beams spectrometer: default 1 Hz (1.0 s cadence).
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
        self.history_len = history
        self.spectrometer_processor = spectrometer_processor or SpectrometerProcessor()
        # Optional beam_id -> target label map (e.g. from the observation routine)
        self.beam_name_provider = beam_name_provider

        self._latest: Status | None = None
        self._latest_spectrometer: SpectrometerData | None = None
        self._history: dict[int, deque[BeamSample]] = defaultdict(
            lambda: deque(maxlen=self.history_len)
        )
        self._subscribers: set[asyncio.Queue[Status]] = set()
        self._spectrometer_subscribers: set[asyncio.Queue[SpectrometerData]] = set()

        self._task: asyncio.Task[None] | None = None
        self._spectrometer_task: asyncio.Task[None] | None = None
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

    def history(self, beam_id: int) -> list[BeamSample]:
        """Return history slice for the given beam_id."""
        return list(self._history.get(beam_id, []))

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

    async def start(self) -> None:
        """Start both status and spectrometer background polling tasks."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop(), name="status-poller")
        self._spectrometer_task = asyncio.create_task(
            self._spectrometer_loop(), name="spectrometer-poller"
        )

    async def stop(self) -> None:
        """Stop background polling tasks."""
        self._running = False
        for task in (self._task, self._spectrometer_task):
            if task is not None:
                task.cancel()
                try:
                    await task
                except asyncio.CancelledError:
                    pass
        self._task = None
        self._spectrometer_task = None

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

    async def _spectrometer_loop(self) -> None:
        """Continuous spectrometer processing loop (default 1 Hz)."""
        while self._running:
            t0 = time.monotonic()
            try:
                # 1. Fetch inspection frames from both streams
                buf_0 = await self.client.get_inspect_frame("host_formed_beams_buffer_0")
                buf_1 = await self.client.get_inspect_frame("host_formed_beams_buffer_1")

                # 2. Process into calibrated power spectra
                spec_data = self.spectrometer_processor.process(
                    buf_0=buf_0,
                    buf_1=buf_1,
                    status=self._latest,
                    max_beams=self._latest.num_active_beams if self._latest else 2,
                    beam_names=self.beam_name_provider() if self.beam_name_provider else None,
                )
                self._latest_spectrometer = spec_data

                # 3. Fan out to spectrometer subscribers
                self._broadcast_spectrometer(spec_data)

            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.debug("Error updating spectrometer: %s", exc)

            elapsed = time.monotonic() - t0
            sleep_time = max(0.01, self.spectrometer_interval - elapsed)
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
