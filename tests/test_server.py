"""Integration and route tests for the FastAPI viewer server."""

from __future__ import annotations

import asyncio
import httpx
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
    # A client that fails to connect keeps poller._latest as None
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
    app, poller = app_and_poller
    with TestClient(app) as client:
        # Poller starts on lifespan and immediately fetches from mock
        res = client.get("/api/status")
        assert res.status_code == 200
        data = res.json()
        assert data["active_antennas"] == 32
        assert len(data["beams"]) == 2


def test_health_endpoint(app_and_poller) -> None:
    app, poller = app_and_poller
    with TestClient(app) as client:
        res = client.get("/api/health")
        assert res.status_code == 200
        data = res.json()
        assert "kotekan_reachable" in data
        assert data["poll_interval_s"] == 0.2
        assert "uptime_s" in data


def test_target_validation_and_steer(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        # 1. Invalid coords (l^2 + m^2 > 1) -> 422
        res = client.post("/api/beams/0/target", json={"l0": 0.9, "m0": 0.9})
        assert res.status_code == 422

        # 2. Invalid beam_id -> 422
        res = client.post("/api/beams/9/target", json={"l0": 0.1, "m0": 0.2})
        assert res.status_code == 422

        # 3. Valid steer -> 200
        res = client.post("/api/beams/0/target", json={"l0": 0.2, "m0": 0.3})
        assert res.status_code == 200
        assert res.json()["status"] == "ok"


def test_celestial_validation_and_steer(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        # 1. Invalid RA (< 0 or >= 360) -> 422
        res = client.post("/api/beams/0/celestial", json={"ra_deg": 370.0, "dec_deg": 10.0})
        assert res.status_code == 422

        # 2. Invalid Dec (<-90 or > 90) -> 422
        res = client.post("/api/beams/0/celestial", json={"ra_deg": 180.0, "dec_deg": -95.0})
        assert res.status_code == 422

        # 3. Valid celestial steer -> 200
        res = client.post("/api/beams/0/celestial", json={"ra_deg": 83.63, "dec_deg": 22.01})
        assert res.status_code == 200
        assert res.json()["status"] == "ok"


def test_enable_beams_and_controls(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        # Invalid beam count (must be 1..8) -> 422
        res = client.post("/api/beams/enable", json={"num_active_beams": 0})
        assert res.status_code == 422

        res = client.post("/api/beams/enable", json={"num_active_beams": 10})
        assert res.status_code == 422

        # Valid beam count -> 200
        res = client.post("/api/beams/enable", json={"num_active_beams": 4})
        assert res.status_code == 200

        # Antenna mask
        res = client.post("/api/antennas/mask", json={"antenna_id": -1, "enabled": True})
        assert res.status_code == 422

        res = client.post("/api/antennas/mask", json={"antenna_id": 3, "enabled": False})
        assert res.status_code == 200

        # Interpolation
        res = client.post("/api/interpolation", json={"enabled": True})
        assert res.status_code == 200


def test_history_endpoint(app_and_poller) -> None:
    app, poller = app_and_poller
    with TestClient(app) as client:
        # Poller runs in lifespan, populating history
        res = client.get("/api/history?beam_id=0")
        assert res.status_code == 200
        data = res.json()
        assert len(data) >= 1
        assert "l0" in data[0]
        assert "m0" in data[0]
        assert "ts" in data[0]


def test_websocket_streaming(app_and_poller) -> None:
    app, poller = app_and_poller
    with TestClient(app) as client:
        with client.websocket_connect("/ws") as ws:
            # Receives status immediately on connect
            data = ws.receive_json()
            assert data["num_active_beams"] == 2
            assert data["beams"][0]["beam_id"] == 0


def test_static_index(app_and_poller) -> None:
    app, _ = app_and_poller
    with TestClient(app) as client:
        res = client.get("/")
        assert res.status_code == 200
        assert "Direct Beam Tracker" in res.text
