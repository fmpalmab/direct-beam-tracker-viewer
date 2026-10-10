"""Precomputed observation routine for the kotekan direct beam tracker.

Keeps ``num_beams`` (default 4) output beams locked on the ``num_beams``
highest-elevation targets from ``tools/verified_targets.json`` (the verified
target catalog for the Carén site). No live sky math runs at observation
time: the schedule — a static table of set hours, each mapping the 4 beams
to the 4 best targets — is generated once at startup, and the runner only
fires REST calls (``enable_beam`` + ``set_celestial_target`` per beam) when
the wall clock crosses each slot time.

Altitudes used for ranking are computed offline from the catalog's transit
times via the hour-angle relation

.. math::

    H(t) = 15^\\circ \\,(t - t_\\mathrm{transit}), \\qquad
    \\sin(\\mathrm{alt}) = \\sin(\\phi)\\sin(\\delta)
        + \\cos(\\phi)\\cos(\\delta)\\cos(H)

with site latitude :math:`\\phi` and target declination :math:`\\delta`.
Kotekan converts RA/Dec to direction cosines once, at command time
(``cudaDirectBeamTrackerCommand.cpp`` ``set_celestial_cb``), so each slot
re-point refreshes the tracking; smaller ``step_minutes`` reduces drift
between slots.

Beam names live in the viewer (kotekan has no name field): the runner
maintains ``beam_id -> label`` and fans it out over WebSocket so the UI,
beam table and spectrometer labels show which target each beam owns.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
from dataclasses import dataclass
from datetime import datetime, timedelta
from pathlib import Path

from pydantic import BaseModel, Field

from .client import TrackerClient
from .models import CelestialRequest

logger = logging.getLogger(__name__)

_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")


class RoutineTarget(BaseModel):
    """One verified catalog target."""

    label: str
    ra_deg: float
    dec_deg: float
    transit_local: str
    max_alt_deg: float | None = None


class BeamAssignment(BaseModel):
    """A beam locked on one target for the duration of a slot."""

    beam_id: int
    label: str
    ra_deg: float
    dec_deg: float
    altitude_deg: float


class RoutineSlot(BaseModel):
    """Set-hour slot: the beam -> target assignment active from this time."""

    time_local: str
    assignments: list[BeamAssignment] = Field(default_factory=list)


class RoutineSchedule(BaseModel):
    """Full static routine: set hours and beam assignments."""

    date_local: str
    site_lat_deg: float
    site_lon_deg: float
    elevation_mask_deg: float
    num_beams: int
    step_minutes: int
    slots: list[RoutineSlot] = Field(default_factory=list)


class RoutineState(BaseModel):
    """Live routine state exposed over the API / WebSocket."""

    enabled: bool = False
    num_beams: int = 4
    date_local: str | None = None
    step_minutes: int = 60
    current_slot: RoutineSlot | None = None
    next_slot_time_local: str | None = None
    beam_names: dict[int, str] = Field(default_factory=dict)
    last_applied_local: str | None = None
    last_error: str | None = None


@dataclass
class TargetCatalog:
    """Parsed verified_targets.json."""

    site_lat_deg: float
    site_lon_deg: float
    site_alt_m: float
    date_local: str
    elevation_mask_deg: float
    targets: list[RoutineTarget]


def load_targets(path: str | Path) -> TargetCatalog:
    """Load and parse a verified_targets.json catalog."""
    raw = Path(path)
    data = json.loads(raw.read_text(encoding="utf-8"))
    site = data["site"]
    return TargetCatalog(
        site_lat_deg=float(site["lat_deg"]),
        site_lon_deg=float(site["lon_deg"]),
        site_alt_m=float(site["alt_m"]),
        date_local=str(data["date_local"]),
        elevation_mask_deg=float(data.get("elevation_mask_deg", 10.0)),
        targets=[
            RoutineTarget(
                label=str(t["label"]),
                ra_deg=float(t["ra_deg"]),
                dec_deg=float(t["dec_deg"]),
                transit_local=str(t["transit_local"]),
                max_alt_deg=float(t["max_alt_deg"])
                if t.get("max_alt_deg") is not None
                else None,
            )
            for t in data["targets"]
        ],
    )


def _transit_hours(transit_local: str) -> float:
    """Parse 'HH:MM' (day markers like '(-1d)' are irrelevant mod 24h)."""
    m = _TIME_RE.search(transit_local)
    if m is None:
        raise ValueError(f"Cannot parse transit time: {transit_local!r}")
    return int(m.group(1)) + int(m.group(2)) / 60.0


def altitude_deg(target: RoutineTarget, lat_deg: float, hours_local: float) -> float:
    """Target altitude at a local solar time, from the catalog transit time.

    Hour angle is periodic mod 24h, so day offsets in the transit string
    ('(-1d)', '(+1d)') do not affect the result.
    """
    hour_angle = ((hours_local - _transit_hours(target.transit_local)) * 15.0) % 360.0
    if hour_angle > 180.0:
        hour_angle -= 360.0
    lat = math.radians(lat_deg)
    dec = math.radians(target.dec_deg)
    sin_alt = math.sin(lat) * math.sin(dec) + math.cos(lat) * math.cos(dec) * math.cos(
        math.radians(hour_angle)
    )
    return math.degrees(math.asin(max(-1.0, min(1.0, sin_alt))))


def generate_schedule(
    catalog: TargetCatalog,
    num_beams: int = 4,
    step_minutes: int = 60,
) -> RoutineSchedule:
    """Build the static set-hour table.

    For each slot the ``num_beams`` targets with the highest altitude above
    the elevation mask win a beam. Assignments are stable: a target that
    stays in the winning set keeps its beam; newcomers take freed beams in
    ascending beam_id order.
    """
    slots: list[RoutineSlot] = []
    prev_assignment: dict[str, int] = {}  # label -> beam_id

    for minutes in range(0, 24 * 60, step_minutes):
        t_hours = minutes / 60.0
        visible = [
            (altitude_deg(t, catalog.site_lat_deg, t_hours), t) for t in catalog.targets
        ]
        visible = [(alt, t) for alt, t in visible if alt >= catalog.elevation_mask_deg]
        visible.sort(key=lambda pair: (-pair[0], pair[1].label))
        chosen = visible[:num_beams]

        by_beam: dict[int, tuple[float, RoutineTarget]] = {}
        # Keep targets that persist from the previous slot on their beam.
        for alt, tgt in chosen:
            if tgt.label in prev_assignment:
                by_beam[prev_assignment[tgt.label]] = (alt, tgt)
        # Newcomers fill freed beams, lowest beam_id first.
        free = sorted(b for b in range(num_beams) if b not in by_beam)
        for alt, tgt in chosen:
            if tgt.label not in prev_assignment and free:
                by_beam[free.pop(0)] = (alt, tgt)

        assignments = [
            BeamAssignment(
                beam_id=beam_id,
                label=tgt.label,
                ra_deg=tgt.ra_deg,
                dec_deg=tgt.dec_deg,
                altitude_deg=round(alt, 2),
            )
            for beam_id, (alt, tgt) in sorted(by_beam.items())
        ]
        slots.append(
            RoutineSlot(
                time_local=f"{minutes // 60:02d}:{minutes % 60:02d}",
                assignments=assignments,
            )
        )
        prev_assignment = {a.label: a.beam_id for a in assignments}

    return RoutineSchedule(
        date_local=catalog.date_local,
        site_lat_deg=catalog.site_lat_deg,
        site_lon_deg=catalog.site_lon_deg,
        elevation_mask_deg=catalog.elevation_mask_deg,
        num_beams=num_beams,
        step_minutes=step_minutes,
        slots=slots,
    )


class RoutineRunner:
    """Applies a precomputed schedule to kotekan at the set hours.

    A single background task watches the local wall clock. When a new slot
    becomes current it POSTs ``enable_beam`` (if the beam count changed)
    and ``set_celestial_target`` for every assigned beam, then updates the
    ``beam_id -> label`` name map and broadcasts the new state to
    WebSocket subscribers. Failed applies (kotekan down) are retried every
    ``retry_s`` seconds until the next successful apply.
    """

    def __init__(
        self,
        client: TrackerClient,
        schedule: RoutineSchedule,
        retry_s: float = 30.0,
    ) -> None:
        self.client = client
        self.schedule = schedule
        self.retry_s = retry_s

        self.names: dict[int, str] = {}
        self.last_error: str | None = None
        self.last_applied_local: str | None = None
        self._applied_key: tuple[str, str] | None = None
        self._active_beams_set: int | None = None
        self._failed = False

        self._subscribers: set[asyncio.Queue[RoutineState]] = set()
        self._task: asyncio.Task[None] | None = None
        self._running = False

    # --- State / subscribers ---

    def beam_names(self) -> dict[int, str]:
        """Current beam_id -> target label map (for the spectrometer poller)."""
        return dict(self.names)

    def state(self) -> RoutineState:
        """Current routine state snapshot."""
        now = datetime.now()
        current, _ = self._current_slot(now)
        return RoutineState(
            enabled=True,
            num_beams=self.schedule.num_beams,
            date_local=self.schedule.date_local,
            step_minutes=self.schedule.step_minutes,
            current_slot=current,
            next_slot_time_local=self._next_boundary(now).strftime("%H:%M"),
            beam_names=dict(self.names),
            last_applied_local=self.last_applied_local,
            last_error=self.last_error,
        )

    def subscribe(self) -> asyncio.Queue[RoutineState]:
        """Subscribe a WebSocket client for routine state updates."""
        q: asyncio.Queue[RoutineState] = asyncio.Queue(maxsize=10)
        self._subscribers.add(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[RoutineState]) -> None:
        self._subscribers.discard(q)

    def _broadcast(self, state: RoutineState) -> None:
        for q in list(self._subscribers):
            if q.qsize() >= 5:
                try:
                    q.get_nowait()
                except asyncio.QueueEmpty:
                    pass
            try:
                q.put_nowait(state)
            except asyncio.QueueFull:
                pass

    # --- Slot clock ---

    def _occurrence(self, slot: RoutineSlot, day: datetime) -> datetime:
        hh, mm = slot.time_local.split(":")
        return day.replace(hour=int(hh), minute=int(mm), second=0, microsecond=0)

    def _current_slot(self, now: datetime) -> tuple[RoutineSlot, datetime]:
        """Most recent slot occurrence at or before ``now`` (wraps midnight)."""
        today = [(self._occurrence(s, now), s) for s in self.schedule.slots]
        past = [(occ, s) for occ, s in today if occ <= now]
        if past:
            occ, slot = max(past, key=lambda pair: pair[0])
            return slot, occ
        # Before the first slot of the day: the last slot of yesterday.
        occ, slot = max(today, key=lambda pair: pair[0])
        return slot, occ - timedelta(days=1)

    def _next_boundary(self, now: datetime) -> datetime:
        """Next slot occurrence strictly after ``now``."""
        upcoming = [
            self._occurrence(s, now)
            for s in self.schedule.slots
            if self._occurrence(s, now) > now
        ]
        if upcoming:
            return min(upcoming)
        return self._occurrence(self.schedule.slots[0], now) + timedelta(days=1)

    # --- Applying slots ---

    async def apply_current(self) -> RoutineState:
        """Force-apply the slot that is current right now."""
        now = datetime.now()
        slot, occ = self._current_slot(now)
        await self._apply_slot(slot)
        self._applied_key = (occ.date().isoformat(), slot.time_local)
        state = self.state()
        self._broadcast(state)
        return state

    async def _apply_slot(self, slot: RoutineSlot) -> None:
        n = len(slot.assignments)
        if n == 0:
            logger.warning(
                "Routine slot %s has no targets above the mask", slot.time_local
            )
            return
        if self._active_beams_set != n:
            reply = await self.client.set_num_active_beams(n)
            self._active_beams_set = n
            logger.info("Routine: enable_beam -> %d (%s)", n, reply.strip())
        for a in slot.assignments:
            reply = await self.client.set_celestial_target(
                CelestialRequest(beam_id=a.beam_id, ra_deg=a.ra_deg, dec_deg=a.dec_deg)
            )
            logger.info(
                "Routine %s: beam %d -> %s (RA %.4f, Dec %.4f, alt %.1f deg) %s",
                slot.time_local,
                a.beam_id,
                a.label,
                a.ra_deg,
                a.dec_deg,
                a.altitude_deg,
                reply.strip(),
            )
        self.names = {a.beam_id: a.label for a in slot.assignments}
        self.last_applied_local = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        self.last_error = None
        self._failed = False

    # --- Background task ---

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._run_loop(), name="routine-runner")
        logger.info(
            "Routine started: %d beams, %d slots (%d min step) for %s",
            self.schedule.num_beams,
            len(self.schedule.slots),
            self.schedule.step_minutes,
            self.schedule.date_local,
        )

    async def stop(self) -> None:
        self._running = False
        if self._task is not None:
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _run_loop(self) -> None:
        while self._running:
            now = datetime.now()
            slot, occ = self._current_slot(now)
            key = (occ.date().isoformat(), slot.time_local)
            if key != self._applied_key:
                try:
                    await self._apply_slot(slot)
                    self._applied_key = key
                    self._broadcast(self.state())
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self._failed = True
                    self.last_error = f"{type(exc).__name__}: {exc}"
                    logger.warning(
                        "Routine apply failed at %s: %s", slot.time_local, exc
                    )

            now = datetime.now()
            delay = (self._next_boundary(now) - now).total_seconds()
            if self._failed:
                delay = min(delay, self.retry_s)
            try:
                await asyncio.sleep(max(0.05, delay))
            except asyncio.CancelledError:
                break
