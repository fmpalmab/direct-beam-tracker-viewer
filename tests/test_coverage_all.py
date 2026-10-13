from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch
import httpx
import pytest
from fastapi.testclient import TestClient

from viewer.client import TrackerClient, TrackerError
from viewer.models import (
    BeamInfo,
    Status,
    TargetRequest,
    CelestialRequest,
    EnableBeamsRequest,
    MaskAntennaRequest,
)
from viewer.poller import StatusPoller
from viewer.server import create_app
from viewer.config import Settings
import viewer.__main__


@pytest.fixture
def mock_settings():
    return Settings(
        kotekan_url="http://mock-kotekan:12048",
        host="127.0.0.1",
        port=8088,
        poll_interval=0.2,
    )


@pytest.fixture
def mock_status():
    return Status(
        active_antennas=10,
        active_raw_elements=[0, 1, 2],
        num_active_beams=1,
        subframe_interpolation_enabled=False,
        beams=[BeamInfo(beam_id=0, l0=0.1, m0=0.2, n0=0.9)],
    )


# --- client.py error handling ---
@pytest.mark.asyncio
async def test_client_error_handling():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="Bad Request")

    transport = httpx.MockTransport(handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://mock")
    client = TrackerClient(base_url="http://mock", client=http_client)

    with pytest.raises(TrackerError):
        await client.set_target(TargetRequest(beam_id=0))

    with pytest.raises(TrackerError):
        await client.set_celestial_target(
            CelestialRequest(beam_id=0, ra_deg=0, dec_deg=0)
        )

    with pytest.raises(TrackerError):
        await client.set_num_active_beams(1)

    with pytest.raises(TrackerError):
        await client.mask_antenna(0, True)

    with pytest.raises(TrackerError):
        await client.set_interpolation(True)


@pytest.mark.asyncio
async def test_client_aclose_owns_client():
    client = TrackerClient(base_url="http://mock")
    await client.aclose()


# --- models.py corner cases ---
def test_models_validation_errors():
    from pydantic import ValidationError

    with pytest.raises(ValidationError):
        TargetRequest(beam_id=9)

    with pytest.raises(ValidationError):
        TargetRequest(l0=0.9, m0=0.9)

    with pytest.raises(ValidationError):
        TargetRequest(l1=0.9, m1=0.9)

    with pytest.raises(ValidationError):
        CelestialRequest(beam_id=9, ra_deg=0, dec_deg=0)

    with pytest.raises(ValidationError):
        CelestialRequest(ra_deg=-10, dec_deg=0)

    with pytest.raises(ValidationError):
        CelestialRequest(ra_deg=0, dec_deg=-100)

    with pytest.raises(ValidationError):
        EnableBeamsRequest(num_active_beams=9)

    with pytest.raises(ValidationError):
        MaskAntennaRequest(antenna_id=-1, enabled=True)


def test_models_aliases():
    req = TargetRequest(l=0.1, m=0.2)
    assert req.l0 == 0.1
    assert req.m0 == 0.2


# --- poller.py corner cases ---
@pytest.mark.asyncio
async def test_poller_corner_cases(mock_status):
    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = mock_status
    poller = StatusPoller(client=client, interval=0.2)

    # test uptime
    assert poller.uptime_s >= 0.0

    # start twice
    await poller.start()
    await poller.start()

    # queue full/empty coverage
    q = poller.subscribe()

    async def mock_put_nowait(*args, **kwargs):
        raise asyncio.QueueFull()

    q.put_nowait = mock_put_nowait
    poller._broadcast(mock_status)

    q.qsize = lambda: 10

    async def mock_get_nowait():
        raise asyncio.QueueEmpty()

    q.get_nowait = mock_get_nowait
    poller._broadcast(mock_status)

    # Sleep interrupted
    await asyncio.sleep(0.01)
    await poller.stop()


# --- server.py corner cases ---
def test_server_error_passthrough(mock_settings):
    def failing_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="Simulated kotekan error")

    transport = httpx.MockTransport(failing_handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://mock")
    client = TrackerClient(base_url="http://mock", client=http_client)
    poller = StatusPoller(client=client, interval=0.2)
    app = create_app(settings=mock_settings, client=client, poller=poller)

    with TestClient(app) as test_client:
        res = test_client.post("/api/beams/0/target", json={"l0": 0.1, "m0": 0.1})
        assert res.status_code == 400

        res = test_client.post(
            "/api/beams/0/celestial", json={"ra_deg": 10.0, "dec_deg": 10.0}
        )
        assert res.status_code == 400

        res = test_client.post("/api/beams/enable", json={"num_active_beams": 4})
        assert res.status_code == 400

        res = test_client.post(
            "/api/antennas/mask", json={"antenna_id": 1, "enabled": True}
        )
        assert res.status_code == 400

        res = test_client.post("/api/interpolation", json={"enabled": True})
        assert res.status_code == 400


def test_server_creation_defaults():
    import os

    env = {
        "KOTEKAN_URL": "http://env-host:12048",
        "VIEWER_HOST": "192.168.1.100",
        "VIEWER_PORT": "8888",
        "VIEWER_POLL_INTERVAL": "0.75",
    }
    with patch.dict(os.environ, env, clear=True):
        app = create_app()
        assert app.state.settings.kotekan_url == "http://env-host:12048"


def test_server_ws_mock(mock_settings, mock_status):
    app = create_app(settings=mock_settings)
    app.state.poller._latest = mock_status
    with patch(
        "starlette.websockets.WebSocket.send_text", side_effect=Exception("mocked err")
    ):
        with TestClient(app) as client:
            with client.websocket_connect("/ws"):
                pass

    app.state.poller._latest = None
    with patch(
        "starlette.websockets.WebSocket.receive_text",
        side_effect=Exception("mocked err"),
    ):
        with TestClient(app) as client:
            with client.websocket_connect("/ws"):
                pass

    with patch("asyncio.Queue.get", side_effect=RuntimeError("queue error")):
        with TestClient(app) as client:
            with client.websocket_connect("/ws"):
                pass


def test_poller_cancel_loop():
    client = AsyncMock(spec=TrackerClient)
    client.get_status.side_effect = asyncio.CancelledError()
    poller = StatusPoller(client=client, interval=0.1)

    async def run_poller():
        await poller.start()
        await asyncio.sleep(0.05)
        await poller.stop()

    asyncio.run(run_poller())


# --- __main__.py ---
def test_main_cli():
    import sys

    test_args = ["viewer", "--port", "12345"]
    with patch.object(sys, "argv", test_args):
        with patch("uvicorn.run") as mock_run:
            viewer.__main__.main()
            mock_run.assert_called_once()


@pytest.mark.asyncio
async def test_poller_queue_full_empty():
    from unittest.mock import Mock

    client = AsyncMock(spec=TrackerClient)
    poller = StatusPoller(client=client, interval=0.1)
    q = poller.subscribe()

    # Queue full
    q.qsize = Mock(return_value=1)
    q.put_nowait = Mock(side_effect=asyncio.QueueFull)
    poller._broadcast(Status())

    # Queue empty
    q.qsize = Mock(return_value=10)
    q.get_nowait = Mock(side_effect=asyncio.QueueEmpty)
    poller._broadcast(Status())
