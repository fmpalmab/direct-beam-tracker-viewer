"""Tests for the precomputed observation routine (schedule + REST runner)."""

from __future__ import annotations

import json
import math
from pathlib import Path

import pytest

from viewer.config import Settings
from viewer.routine import (
    RoutineRunner,
    RoutineTarget,
    altitude_deg,
    generate_schedule,
    load_targets,
)
from viewer.server import create_app
from viewer.spectrometer import SpectrometerProcessor

REAL_CATALOG = Path(__file__).resolve().parents[2] / "tools" / "verified_targets.json"

LAT_DEG = -30.0


def make_target(label: str, transit_h: int, dec_deg: float = LAT_DEG) -> dict:
    return {
        "label": label,
        "ra_deg": 0.0,
        "dec_deg": dec_deg,
        "transit_local": f"{transit_h:02d}:00",
        "max_alt_deg": 90.0 - abs(LAT_DEG - dec_deg),
    }


def write_catalog(tmp_path, targets, mask_deg: float = 10.0) -> Path:
    data = {
        "site": {"lat_deg": LAT_DEG, "lon_deg": -70.0, "alt_m": 400.0},
        "date_local": "2026-10-07",
        "elevation_mask_deg": mask_deg,
        "targets": targets,
    }
    path = tmp_path / "targets.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


@pytest.fixture
def dense_catalog_path(tmp_path) -> Path:
    """8 targets spaced 3h apart at dec = lat: always >= 4 above the mask."""
    return write_catalog(
        tmp_path, [make_target(f"T{h:02d}", h) for h in range(0, 24, 3)]
    )


# --- Altitude math ---


def test_altitude_at_transit_reaches_max_altitude() -> None:
    tgt = RoutineTarget(
        label="x", ra_deg=0.0, dec_deg=LAT_DEG, transit_local="05:00"
    )
    assert altitude_deg(tgt, LAT_DEG, 5.0) == pytest.approx(90.0, abs=1e-6)


def test_altitude_symmetric_around_transit() -> None:
    tgt = RoutineTarget(
        label="x", ra_deg=0.0, dec_deg=LAT_DEG, transit_local="12:00"
    )
    before = altitude_deg(tgt, LAT_DEG, 10.0)
    after = altitude_deg(tgt, LAT_DEG, 14.0)
    assert before == pytest.approx(after, abs=1e-9)
    assert altitude_deg(tgt, LAT_DEG, 12.0) > before


def test_transit_day_markers_are_irrelevant_mod_24h() -> None:
    plain = RoutineTarget(label="a", ra_deg=1.0, dec_deg=-20.0, transit_local="20:41")
    marked = RoutineTarget(
        label="b", ra_deg=1.0, dec_deg=-20.0, transit_local="20:41 (-1d)"
    )
    for t in (0.0, 3.5, 12.0, 21.25):
        assert altitude_deg(plain, LAT_DEG, t) == pytest.approx(
            altitude_deg(marked, LAT_DEG, t), abs=1e-9
        )


@pytest.mark.skipif(not REAL_CATALOG.exists(), reason="real catalog not available")
def test_altitude_matches_verified_catalog_max_alt() -> None:
    catalog = load_targets(REAL_CATALOG)
    for t in catalog.targets:
        hh, mm = t.transit_local.split(":")
        t_hours = int(hh) + int(mm[:2]) / 60.0
        alt = altitude_deg(t, catalog.site_lat_deg, t_hours)
        assert alt == pytest.approx(t.max_alt_deg, abs=0.5), t.label


# --- Schedule generation ---


def test_schedule_assigns_four_highest_targets(dense_catalog_path) -> None:
    catalog = load_targets(dense_catalog_path)
    sched = generate_schedule(catalog, num_beams=4, step_minutes=60)

    assert len(sched.slots) == 24
    for slot in sched.slots:
        assert len(slot.assignments) == 4
        assert [a.beam_id for a in slot.assignments] == [0, 1, 2, 3]

        t_hours = int(slot.time_local[:2]) + int(slot.time_local[3:]) / 60.0
        alts = {
            t.label: altitude_deg(t, catalog.site_lat_deg, t_hours)
            for t in catalog.targets
        }
        visible = [(a, l) for l, a in alts.items() if a >= catalog.elevation_mask_deg]
        best = {l for _, l in sorted(visible, key=lambda x: (-x[0], x[1]))[:4]}
        assert {a.label for a in slot.assignments} == best
        for a in slot.assignments:
            assert a.altitude_deg == pytest.approx(alts[a.label], abs=0.01)


def test_schedule_beam_assignment_is_stable(dense_catalog_path) -> None:
    sched = generate_schedule(load_targets(dense_catalog_path), num_beams=4)

    for prev, cur in zip(sched.slots, sched.slots[1:]):
        prev_beams = {a.label: a.beam_id for a in prev.assignments}
        for a in cur.assignments:
            if a.label in prev_beams:
                assert a.beam_id == prev_beams[a.label], (
                    f"{a.label} moved beams between {prev.time_local} and {cur.time_local}"
                )


def test_schedule_with_few_visible_targets_shrinks(tmp_path) -> None:
    path = write_catalog(tmp_path, [make_target("only1", 6), make_target("only2", 18)])
    sched = generate_schedule(load_targets(path), num_beams=4)
    for slot in sched.slots:
        assert len(slot.assignments) <= 2


@pytest.mark.skipif(not REAL_CATALOG.exists(), reason="real catalog not available")
def test_real_catalog_yields_four_beams_at_every_hour() -> None:
    sched = generate_schedule(load_targets(REAL_CATALOG), num_beams=4, step_minutes=60)
    assert len(sched.slots) == 24
    for slot in sched.slots:
        assert len(slot.assignments) == 4, f"slot {slot.time_local} is short"
        assert [a.beam_id for a in slot.assignments] == [0, 1, 2, 3]


# --- Runner (REST application) ---


async def test_runner_applies_current_slot(
    mock_client, mock_backend, dense_catalog_path
) -> None:
    sched = generate_schedule(load_targets(dense_catalog_path), num_beams=4)
    runner = RoutineRunner(client=mock_client, schedule=sched)

    state = await runner.apply_current()

    assert state.enabled
    assert state.last_error is None
    assert state.last_applied_local is not None
    assert state.current_slot is not None
    assert state.next_slot_time_local is not None

    # kotekan received the beam count and every celestial target
    assert mock_backend.num_active_beams == 4
    assert runner.names == {
        a.beam_id: a.label for a in state.current_slot.assignments
    }
    for a in state.current_slot.assignments:
        beam = mock_backend.beams[a.beam_id]
        assert beam["celestial_target"]["is_set"] is True
        assert beam["celestial_target"]["ra_deg"] == a.ra_deg
        assert beam["celestial_target"]["dec_deg"] == a.dec_deg


async def test_runner_retries_after_failure(
    mock_client, mock_backend, dense_catalog_path
) -> None:
    sched = generate_schedule(load_targets(dense_catalog_path), num_beams=4)
    runner = RoutineRunner(client=mock_client, schedule=sched, retry_s=0.05)

    # Simulate one failed apply loop iteration
    runner._failed = True
    runner.last_error = "ConnectError: kotekan down"
    await runner._apply_slot(runner.schedule.slots[0])
    assert runner._failed is False
    assert runner.last_error is None


# --- Server integration ---


def make_routine_settings(catalog_path: Path) -> Settings:
    return Settings(
        kotekan_url="http://mock-kotekan:12048",
        routine_enabled=True,
        routine_targets_path=str(catalog_path),
        routine_num_beams=4,
        routine_step_minutes=60,
    )


def test_routine_endpoints(mock_client, mock_backend, dense_catalog_path) -> None:
    from starlette.testclient import TestClient

    app = create_app(settings=make_routine_settings(dense_catalog_path), client=mock_client)
    assert app.state.poller.beam_name_provider == app.state.routine.beam_names

    with TestClient(app) as cli:
        res = cli.get("/api/routine")
        assert res.status_code == 200
        assert res.json()["enabled"] is True
        assert res.json()["current_slot"] is not None

        res = cli.get("/api/routine/schedule")
        assert res.status_code == 200
        sched = res.json()
        assert len(sched["slots"]) == 24
        assert sched["num_beams"] == 4

        # Force-apply the current slot
        res = cli.post("/api/routine/apply")
        assert res.status_code == 200
        state = res.json()["state"]
        assert len(state["beam_names"]) == 4
        assert mock_backend.num_active_beams == 4

        # State endpoint now reflects the applied names
        res = cli.get("/api/routine")
        assert res.json()["beam_names"] == state["beam_names"]


def test_routine_endpoints_disabled(mock_client, test_settings) -> None:
    from starlette.testclient import TestClient

    app = create_app(settings=test_settings, client=mock_client)
    with TestClient(app) as cli:
        res = cli.get("/api/routine")
        assert res.status_code == 200
        assert res.json()["enabled"] is False

        res = cli.get("/api/routine/schedule")
        assert res.status_code == 404

        res = cli.post("/api/routine/apply")
        assert res.status_code == 404


def test_spectrometer_labels_use_routine_names() -> None:
    processor = SpectrometerProcessor()
    data = processor.process(
        buf_0=None,
        buf_1=None,
        status=None,
        max_beams=2,
        beam_names={0: "Sgr A* / Galactic Center"},
    )
    assert data.beams[0].target_name == "Sgr A* / Galactic Center"
    assert "Sgr A* / Galactic Center" in data.beams[0].label
    # Unnamed beams fall back to coordinate identification (none here)
    assert data.beams[1].target_name is None
    assert data.beams[1].label == "Beam 1"
