"""Integration and route tests for the FastAPI viewer server."""

from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import numpy as np
import pytest
from starlette.testclient import TestClient

from viewer.client import TrackerClient
from viewer.config import Settings
from viewer.poller import StatusPoller
from viewer.server import create_app


@pytest.fixture
def app_and_poller(mock_client: TrackerClient, test_settings: Settings):
    poller = StatusPoller(client=mock_client, interval=0.2, history=50)
    app = create_app(settings=test_settings, client=mock_client, poller=poller)
    return app, poller


def test_status_endpoint_returns_503_when_no_status(test_settings: Settings) -> None:
    def failing_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Kotekan offline")

    transport = httpx.MockTransport(failing_handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://mock-offline")
    client = TrackerClient(base_url="http://mock-offline", client=http_client)
    poller = StatusPoller(client=client, interval=0.2, history=50)
    app = create_app(settings=test_settings, client=client, poller=poller)

    with TestClient(app) as test_cli:
        res = test_cli.get("/api/status")
        assert res.status_code == 503
        assert "No status" in res.json()["detail"]


def test_status_endpoint_success(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/status")
        assert res.status_code == 200
        data = res.json()
        assert data["active_antennas"] == 32
        assert data["taper_type"] == "cosine_pedestal"
        assert len(data["beams"]) == 2


def test_health_endpoint(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/health")
        assert res.status_code == 200
        data = res.json()
        assert "kotekan_reachable" in data
        assert data["poll_interval_s"] == 0.2
        assert "uptime_s" in data


def test_removed_tri_engine_routes_return_404(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        assert client.get("/api/grid").status_code == 404
        assert client.get("/api/correlator").status_code == 404
        assert client.get("/api/correlator/baseline/0/4").status_code == 404


def test_target_validation_and_steer(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        res = client.post("/api/beams/0/target", json={"l0": 0.9, "m0": 0.9})
        assert res.status_code == 422

        res = client.post("/api/beams/16/target", json={"l0": 0.1, "m0": 0.2})
        assert res.status_code == 422

        res = client.post("/api/beams/0/target", json={"l0": 0.2, "m0": 0.3})
        assert res.status_code == 200
        assert res.json()["status"] == "ok"


def test_celestial_validation_and_steer(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        res = client.post(
            "/api/beams/0/celestial", json={"ra_deg": 370.0, "dec_deg": 10.0}
        )
        assert res.status_code == 422

        res = client.post(
            "/api/beams/0/celestial", json={"ra_deg": 180.0, "dec_deg": -95.0}
        )
        assert res.status_code == 422

        res = client.post(
            "/api/beams/0/celestial", json={"ra_deg": 83.63, "dec_deg": 22.01}
        )
        assert res.status_code == 200
        assert res.json()["status"] == "ok"


def test_enable_beams_and_controls(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        res = client.post("/api/beams/enable", json={"num_active_beams": 0})
        assert res.status_code == 422

        res = client.post("/api/beams/enable", json={"num_active_beams": 20})
        assert res.status_code == 422

        res = client.post("/api/beams/enable", json={"num_active_beams": 10})
        assert res.status_code == 200

        res = client.post(
            "/api/antennas/mask", json={"antenna_id": -1, "enabled": True}
        )
        assert res.status_code == 422

        res = client.post(
            "/api/antennas/mask", json={"antenna_id": 3, "enabled": False}
        )
        assert res.status_code == 200

        res = client.post("/api/interpolation", json={"enabled": True})
        assert res.status_code == 200


def test_history_endpoint(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/history?beam_id=0")
        assert res.status_code == 200
        data = res.json()
        assert len(data) >= 1
        assert "l0" in data[0]
        assert "m0" in data[0]
        assert "ts" in data[0]


def test_websocket_streaming(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        data = ws.receive_json()
        assert data["num_active_beams"] == 2
        assert data["beams"][0]["beam_id"] == 0


def test_websocket_spectrometer_streaming(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        m1 = ws.receive_json()
        assert "num_active_beams" in m1
        m2 = ws.receive_json()
        if m2.get("type") == "spectrometer":
            assert "beams" in m2["data"]
        else:
            assert "num_active_beams" in m2 or "type" in m2


def test_static_index(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        res = client.get("/")
        assert res.status_code == 200
        assert "Direct Beam Tracker" in res.text
        assert "Real-Time RFI Mitigation" in res.text
        assert "SEFD, Sensitivity &amp; Calibration" in res.text


def test_spectrometer_endpoint(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/spectrometer")
        assert res.status_code == 200
        data = res.json()
        assert data["num_channels"] == 672
        assert "0" in data["beams"]

        res_beam = client.get("/api/spectrometer/0")
        assert res_beam.status_code == 200
        b0 = res_beam.json()
        assert b0["beam_id"] == 0
        assert len(b0["power_db"]) == 672

        res_missing = client.get("/api/spectrometer/7")
        assert res_missing.status_code == 404


def test_rfi_and_sefd_endpoints(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        r_rfi = client.get("/api/rfi")
        assert r_rfi.status_code == 200
        assert r_rfi.json()["total_channels"] == 672

        r_ch = client.get("/api/rfi/channels")
        assert r_ch.status_code == 200
        assert len(r_ch.json()["channels"]) == 672

        r_cfg = client.post(
            "/api/rfi/configure",
            json={
                "sk_sigma_threshold": 5.2,
                "static_notch_bands_mhz": [[362.0, 378.0]],
            },
        )
        assert r_cfg.status_code == 200
        assert r_cfg.json()["status"] == "ok"

        r_ema = client.post("/api/rfi/reset_ema", json={"all": True})
        assert r_ema.status_code == 200
        assert r_ema.json()["status"] == "ok"

        r_pw = client.post("/api/rfi/prewhiten")
        assert r_pw.status_code == 200
        assert r_pw.json()["subbands_updated"] == 2

        r_sefd = client.get("/api/sefd")
        assert r_sefd.status_code == 200
        sefd = r_sefd.json()
        assert sefd["n_alive"] == 32
        assert sefd["quantizer_sigma_lsb"] > 0.0
        assert len(sefd["beams"]) == 2


def test_taper_and_calibration_endpoints(app_and_poller, tmp_path: Path) -> None:
    app, _ = app_and_poller
    npz_file = tmp_path / "gains_test.npz"
    n_freq = 672
    freq_mhz = np.array(
        [300.0 + i * 0.3 for i in range(336)] + [400.8 + i * 0.3 for i in range(336)]
    )
    flagged = np.zeros(n_freq, dtype=bool)
    flagged[20:24] = True
    np.savez(
        npz_file,
        format_version=2,
        gains=np.ones((n_freq, 4), dtype=np.complex128),
        antennas=np.array([0, 4, 32, 36], dtype=int),
        freq_mhz=freq_mhz,
        flagged_channels=flagged,
    )

    with TestClient(app) as client:
        # Invalid taper -> 422
        assert (
            client.post("/api/taper", json={"taper_type": "invalid_window"}).status_code
            == 422
        )

        # Valid taper -> 200
        res_taper = client.post(
            "/api/taper",
            json={
                "taper_type": "hamming",
                "taper_pedestal": 0.15,
                "normalize_weights": True,
            },
        )
        assert res_taper.status_code == 200
        assert "hamming" in res_taper.json()["message"]

        # Toggle calibration
        res_cal = client.post(
            "/api/calibration/toggle", json={"enabled": False, "beam_id": 0}
        )
        assert res_cal.status_code == 200

        # Reload missing .npz -> 400
        res_missing = client.post(
            "/api/calibration/reload",
            json={"gains_file": str(tmp_path / "nonexistent.npz")},
        )
        assert res_missing.status_code == 400

        # Reload valid .npz with zero_flagged + sync_rfi_notches -> 200
        res_reload = client.post(
            "/api/calibration/reload",
            json={
                "gains_file": str(npz_file),
                "zero_flagged": True,
                "sync_rfi_notches": True,
            },
        )
        assert res_reload.status_code == 200
        data = res_reload.json()
        assert data["converted"] is True
        assert data["active_antennas"] == [0, 4, 32, 36]
        assert len(data["synced_notches"]) == 1
        assert data["kotekan"]["gains_generation"] >= 2


def test_health_includes_spectrometer_interval(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/health")
        assert res.status_code == 200
        data = res.json()
        assert "spectrometer_interval_s" in data
        assert data["spectrometer_interval_s"] >= 0.2


def test_all_history_endpoint(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/history/all?limit=50")
        assert res.status_code == 200
        data = res.json()
        assert isinstance(data, dict)
        assert "0" in data or 0 in data


def test_api_token_auth(mock_client: TrackerClient) -> None:
    token_settings = Settings(api_token="supersecret")
    poller = StatusPoller(client=mock_client, interval=0.2, history=50)
    app = create_app(settings=token_settings, client=mock_client, poller=poller)

    with TestClient(app) as client:
        # Unauthenticated mutating requests -> 401
        assert (
            client.post("/api/beams/0/target", json={"l0": 0.1, "m0": 0.2}).status_code
            == 401
        )
        assert (
            client.post("/api/rfi/configure", json={"enabled": False}).status_code
            == 401
        )
        assert client.post("/api/rfi/reset_ema").status_code == 401
        assert client.post("/api/rfi/prewhiten").status_code == 401
        assert client.post("/api/taper", json={"taper_type": "none"}).status_code == 401
        assert (
            client.post("/api/calibration/toggle", json={"enabled": True}).status_code
            == 401
        )
        assert (
            client.post(
                "/api/calibration/reload", json={"gains_file": "/data/g.npy"}
            ).status_code
            == 401
        )

        # Authenticated -> 200
        res = client.post(
            "/api/beams/0/target",
            json={"l0": 0.1, "m0": 0.2},
            headers={"X-API-Token": "supersecret"},
        )
        assert res.status_code == 200

        res_taper = client.post(
            "/api/taper",
            json={"taper_type": "none"},
            headers={"Authorization": "Bearer supersecret"},
        )
        assert res_taper.status_code == 200


def test_antenna_mask_and_spectrum_endpoints(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/antenna_mask")
        assert res.status_code == 200
        data = res.json()
        assert data["num_elements"] == 64
        assert len(data["antennas"]) == 64
        assert len(data["subbands"]) == 2

        res_spec = client.get("/api/antennas/0/spectrum")
        assert res_spec.status_code == 200
        spec = res_spec.json()
        assert spec["antenna_id"] == 0
        assert spec["num_channels"] == 672
        assert len(spec["frequencies_mhz"]) == 672
        assert len(spec["spectrum_db"]) == 672

        res_invalid = client.get("/api/antennas/64/spectrum")
        assert res_invalid.status_code == 422


def test_websocket_multiplexing(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client, client.websocket_connect("/ws") as ws:
        received_types = set()
        for _ in range(8):
            try:
                msg = ws.receive_json()
                if "num_active_beams" in msg:
                    received_types.add("status")
                elif "type" in msg:
                    received_types.add(msg["type"])
            except (Exception, asyncio.CancelledError):
                break
        assert "status" in received_types
        assert any(
            t in received_types
            for t in ("spectrometer", "rfi", "sefd", "antenna_mask")
        )


def test_unmask_all_and_auto_detect_endpoints(app_and_poller) -> None:
    app, _poller = app_and_poller
    with TestClient(app) as client:
        res = client.post("/api/antennas/unmask_all")
        assert res.status_code == 200
        assert res.json()["status"] == "ok"

        res2 = client.post("/api/antennas/auto_detect", json={"enabled": False})
        assert res2.status_code == 200
        assert res2.json()["auto_detect_enabled"] is False


def test_steer_clears_routine_name(
    mock_client: TrackerClient, test_settings: Settings
) -> None:
    from viewer.routine import (
        BeamAssignment,
        RoutineRunner,
        RoutineSchedule,
        RoutineSlot,
    )

    schedule = RoutineSchedule(
        date_local="2026-10-14",
        site_lat_deg=-33.0,
        site_lon_deg=-70.0,
        elevation_mask_deg=10.0,
        num_beams=2,
        step_minutes=60,
        slots=[
            RoutineSlot(
                time_local="12:00",
                assignments=[
                    BeamAssignment(
                        beam_id=0,
                        label="Target A",
                        ra_deg=10.0,
                        dec_deg=-30.0,
                        altitude_deg=70.0,
                    ),
                    BeamAssignment(
                        beam_id=1,
                        label="Target B",
                        ra_deg=20.0,
                        dec_deg=-30.0,
                        altitude_deg=65.0,
                    ),
                ],
            )
        ],
    )
    routine = RoutineRunner(client=mock_client, schedule=schedule)
    routine.names[0] = "Target A"
    routine.names[1] = "Target B"

    poller = StatusPoller(client=mock_client, interval=0.2, history=50)
    app = create_app(
        settings=test_settings, client=mock_client, poller=poller, routine=routine
    )

    with TestClient(app) as client:
        res = client.post("/api/beams/0/target", json={"l0": 0.2, "m0": 0.2})
        assert res.status_code == 200
        assert 0 not in routine.names
        assert routine.names[1] == "Target B"

        res = client.post(
            "/api/beams/1/celestial", json={"ra_deg": 100.0, "dec_deg": -20.0}
        )
        assert res.status_code == 200
        assert 1 not in routine.names


def test_apply_routine_now_no_routine_returns_404(
    mock_client: TrackerClient, test_settings: Settings
) -> None:
    poller = StatusPoller(client=mock_client, interval=0.2, history=50)
    app = create_app(
        settings=test_settings, client=mock_client, poller=poller, routine=None
    )

    with TestClient(app) as client:
        res = client.post("/api/routine/apply")
        assert res.status_code == 404
        assert res.json()["detail"] == "Routine not enabled"
