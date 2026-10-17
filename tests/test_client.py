"""Unit tests for TrackerClient."""

from __future__ import annotations

import json

import httpx
import pytest

from viewer.client import TrackerClient, TrackerError
from viewer.models import CelestialRequest, TargetRequest


@pytest.mark.asyncio
async def test_get_status(mock_client: TrackerClient, mock_backend) -> None:
    status = await mock_client.get_status()
    assert status.active_antennas == 32
    assert status.num_active_beams == 2
    assert status.subframe_interpolation_enabled is True
    assert len(status.beams) == 2
    assert status.beams[0].beam_id == 0
    assert status.beams[0].l0 == 0.1
    assert status.beams[0].celestial_target.is_set is True


@pytest.mark.asyncio
async def test_set_target(mock_client: TrackerClient, mock_backend) -> None:
    req = TargetRequest(beam_id=0, l0=0.3, m0=-0.4)
    reply = await mock_client.set_target(req)
    assert "updated" in reply

    last_req = mock_backend.last_request
    assert last_req["method"] == "POST"
    assert last_req["path"] == "/direct_tracker/set_target"
    payload = json.loads(last_req["body"])
    assert payload["beam_id"] == 0
    assert payload["l0"] == 0.3
    assert payload["m0"] == -0.4


@pytest.mark.asyncio
async def test_set_celestial_target(mock_client: TrackerClient, mock_backend) -> None:
    req = CelestialRequest(beam_id=1, ra_deg=180.5, dec_deg=-45.2)
    reply = await mock_client.set_celestial_target(req)
    assert "celestial" in reply.lower()

    last_req = mock_backend.last_request
    assert last_req["method"] == "POST"
    assert last_req["path"] == "/direct_tracker/set_celestial_target"
    payload = json.loads(last_req["body"])
    assert payload["beam_id"] == 1
    assert payload["ra_deg"] == 180.5
    assert payload["dec_deg"] == -45.2


@pytest.mark.asyncio
async def test_set_num_active_beams(mock_client: TrackerClient, mock_backend) -> None:
    reply = await mock_client.set_num_active_beams(4)
    assert "4" in reply

    last_req = mock_backend.last_request
    assert last_req["method"] == "POST"
    assert last_req["path"] == "/direct_tracker/enable_beam"
    payload = json.loads(last_req["body"])
    assert payload == {"num_active_beams": 4}


@pytest.mark.asyncio
async def test_mask_antenna(mock_client: TrackerClient, mock_backend) -> None:
    reply = await mock_client.mask_antenna(antenna_id=7, enabled=True)
    assert "Antenna 7" in reply

    last_req = mock_backend.last_request
    assert last_req["method"] == "POST"
    assert last_req["path"] == "/antenna_mask/mask_antenna"
    payload = json.loads(last_req["body"])
    assert payload == {"antenna_id": 7, "enabled": True}


@pytest.mark.asyncio
async def test_get_inspect_frame_success(
    mock_client: TrackerClient, mock_backend
) -> None:
    frame = await mock_client.get_inspect_frame("test_buffer")
    assert frame == b"\x00\x01\x02\x03"

    last_req = mock_backend.last_request
    assert last_req["method"] == "GET"
    assert last_req["path"] == "/inspect_frame/test_buffer"


@pytest.mark.asyncio
async def test_get_inspect_frame_not_found(mock_client: TrackerClient) -> None:
    frame = await mock_client.get_inspect_frame("nonexistent_buffer")
    assert frame is None


@pytest.mark.asyncio
async def test_get_inspect_frame_exception() -> None:
    def exception_handler(request: httpx.Request) -> httpx.Response:
        raise httpx.RequestError("Network error", request=request)

    transport = httpx.MockTransport(exception_handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://mock")
    client = TrackerClient(base_url="http://mock", client=http_client)

    frame = await client.get_inspect_frame("some_buffer")
    assert frame is None


@pytest.mark.asyncio
async def test_set_interpolation(mock_client: TrackerClient, mock_backend) -> None:
    reply = await mock_client.set_interpolation(enabled=False)
    assert "Interpolation" in reply

    last_req = mock_backend.last_request
    assert last_req["method"] == "POST"
    assert last_req["path"] == "/direct_tracker/set_interpolation"
    payload = json.loads(last_req["body"])
    assert payload == {"enabled": False}


@pytest.mark.asyncio
async def test_tracker_error_passthrough() -> None:
    def error_handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(400, text="Invalid parameter in stage")

    transport = httpx.MockTransport(error_handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://mock")
    client = TrackerClient(base_url="http://mock", client=http_client)

    with pytest.raises(TrackerError) as exc_info:
        await client.get_status()

    assert exc_info.value.status_code == 400
    assert "Invalid parameter" in exc_info.value.message


@pytest.mark.asyncio
async def test_connect_retry() -> None:
    calls = 0

    def retry_handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ConnectError("Connection refused")
        return httpx.Response(200, text="Success on retry")

    transport = httpx.MockTransport(retry_handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://mock")
    client = TrackerClient(base_url="http://mock", client=http_client)

    reply = await client.set_num_active_beams(2)
    assert calls == 2
    assert "Success on retry" in reply


@pytest.mark.asyncio
async def test_timeout_and_protocol_retry() -> None:
    calls = 0

    def retry_handler(request: httpx.Request) -> httpx.Response:
        nonlocal calls
        calls += 1
        if calls == 1:
            raise httpx.ReadTimeout("Timeout waiting for kotekan")
        return httpx.Response(200, text="Success on retry after timeout")

    transport = httpx.MockTransport(retry_handler)
    http_client = httpx.AsyncClient(transport=transport, base_url="http://mock")
    client = TrackerClient(base_url="http://mock", client=http_client)

    reply = await client.set_num_active_beams(4)
    assert calls == 2
    assert "Success on retry" in reply


@pytest.mark.asyncio
async def test_get_beam_power(mock_client: TrackerClient, mock_backend) -> None:
    bp = await mock_client.get_beam_power("/direct_tracker")
    assert bp.rest_prefix == "/direct_tracker"
    assert bp.max_beams == 4
    assert bp.total_freq_channels == 672
    assert len(bp.beam_power) == 4
    assert len(bp.beam_power[0]) == 672


@pytest.mark.asyncio
async def test_get_grid_beam_power(mock_client: TrackerClient, mock_backend) -> None:
    bp = await mock_client.get_grid_beam_power()
    assert bp.rest_prefix == "/grid_tracker"
    assert bp.max_beams == 16
    assert bp.enable_grid_mode is True
    assert len(bp.beam_power) == 16
    assert len(bp.beam_power[0]) == 672


@pytest.mark.asyncio
async def test_get_antenna_mask_status(
    mock_client: TrackerClient, mock_backend
) -> None:
    ams = await mock_client.get_antenna_mask_status()
    assert ams.num_elements == 64
    assert ams.auto_detect_enabled is True
    assert ams.blank_voltages_enabled is True
    assert len(ams.subbands) == 2
    assert len(ams.antennas) == 64


@pytest.mark.asyncio
async def test_set_auto_detect(mock_client: TrackerClient, mock_backend) -> None:
    reply = await mock_client.set_auto_detect(False)
    assert "updated successfully" in reply
    assert mock_backend.auto_detect_enabled is False

    last_req = mock_backend.last_request
    assert last_req["method"] == "POST"
    assert last_req["path"] == "/antenna_mask/configure"
    payload = json.loads(last_req["body"])
    assert payload == {"auto_detect_enabled": False}

    # Re-enable
    reply2 = await mock_client.set_auto_detect(True)
    assert "updated successfully" in reply2
    assert mock_backend.auto_detect_enabled is True


@pytest.mark.asyncio
async def test_reset_antenna_masks(mock_client: TrackerClient, mock_backend) -> None:
    reply = await mock_client.reset_antenna_masks()
    assert "reset to active" in reply
    assert mock_backend.active_antennas == 64
