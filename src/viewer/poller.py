"""Single background poller for kotekan status with ring buffer history and WebSocket broadcast."""

from __future__ import annotations

import asyncio
from collections import defaultdict, deque
import logging
import time
from typing import Any

from .client import TrackerClient
from .models import BeamSample, Status

logger = logging.getLogger(__name__)


class StatusPoller:
    """Polls kotekan /direct_tracker/status at fixed cadence (default 2 Hz).

    Maintains a ring buffer of recent (l, m) samples per beam and broadcasts
    status updates to connected WebSocket client queues.
    """

    def __init__(
        self,
        client: TrackerClient,
        interval: float = 0.5,
        history: int = 600,
    ) -> None:
        self.client = client
        self.interval = max(0.2, interval)
        self.history_len = history

        self._latest: Status | None = None
        self._history: dict[int, deque[BeamSample]] = defaultdict(
            lambda: deque(maxlen=self.history_len)
        )
        self._subscribers: set[asyncio.Queue[Status]] = set()

        self._task: asyncio.Task[None] | None = None
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

    def history(self, beam_id: int) -> list[BeamSample]:
        """Return history slice for the given beam_id."""
        return list(self._history.get(beam_id, []))

    def subscribe(self) -> asyncio.Queue[Status]:
        """Subscribe a new WebSocket client. Returns a queue that receives Status updates."""
        q: asyncio.Queue[Status] = asyncio.Queue(maxsize=20)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[Status]) -> None:
        """Unsubscribe a WebSocket client queue."""
        self._subscribers.discard(q)

    async def start(self) -> None:
        """Start the background polling task."""
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._poll_loop(), name="status-poller")

    async def stop(self) -> None:
        """Stop the background polling task."""
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
            self._task = None

    async def _poll_loop(self) -> None:
        """Continuous polling loop."""
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

                # Fan out to all connected WebSocket clients
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
