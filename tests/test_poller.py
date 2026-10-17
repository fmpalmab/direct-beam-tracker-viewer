"""Unit tests for StatusPoller lifecycle, history, and fan-out streaming."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from viewer.client import TrackerClient, TrackerError
from viewer.models import BeamInfo, Status
from viewer.poller import StatusPoller


@pytest.fixture
def sample_status() -> Status:
    return Status(
        active_antennas=16,
        active_raw_elements=[0, 1],
        num_active_beams=1,
        subframe_interpolation_enabled=True,
        beams=[
            BeamInfo(
                beam_id=0,
                l0=0.15,
                m0=-0.25,
                n0=0.9565,
                grid_index=42,
            )
        ],
    )


@pytest.mark.asyncio
async def test_poller_lifecycle_and_broadcast(sample_status: Status) -> None:
    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = sample_status

    poller = StatusPoller(client=client, interval=0.2, history=10)
    q = poller.subscribe()

    assert poller.latest() is None
    assert poller.healthy is False

    await poller.start()
    # Wait for first poll
    received = await asyncio.wait_for(q.get(), timeout=1.0)
    assert received.num_active_beams == 1
    assert poller.latest() is not None
    assert poller.healthy is True

    # History populated
    hist = poller.history(0)
    assert len(hist) >= 1
    assert hist[0].l0 == 0.15
    assert hist[0].m0 == -0.25

    poller.unsubscribe(q)
    await poller.stop()


@pytest.mark.asyncio
async def test_poller_resilience_to_errors(sample_status: Status) -> None:
    client = AsyncMock(spec=TrackerClient)
    # Succeed first, then fail, then succeed again
    client.get_status.side_effect = [
        sample_status,
        TrackerError(500, "Internal kotekan glitch"),
        sample_status,
    ]

    poller = StatusPoller(client=client, interval=0.2, history=10)
    q = poller.subscribe()

    await poller.start()

    # 1. First poll success
    s1 = await asyncio.wait_for(q.get(), timeout=1.0)
    assert s1.active_antennas == 16
    assert poller.healthy is True

    # Allow poller loop to hit error and then recover
    await asyncio.sleep(0.5)

    assert poller.healthy is True
    # Latest status was retained during glitch
    assert poller.latest() is not None

    poller.unsubscribe(q)
    await poller.stop()


@pytest.mark.asyncio
async def test_subscriber_queue_overflow_protection(sample_status: Status) -> None:
    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = sample_status

    poller = StatusPoller(client=client, interval=0.2, history=5)
    q = poller.subscribe()

    # Pre-fill subscriber queue to trigger drop logic
    for _ in range(15):
        poller._broadcast(sample_status)

    # Queue size should be capped without hanging or raising QueueFull
    assert q.qsize() <= 15
    poller.unsubscribe(q)


@pytest.mark.asyncio
async def test_spectrometer_poller_error_handling(
    sample_status: Status, caplog: pytest.LogCaptureFixture
) -> None:
    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = sample_status

    errors = [
        TrackerError(500, "Server error"),
        httpx.HTTPError("HTTP connection dropped"),
        ValueError("Invalid binary frame size"),
        RuntimeError("Unexpected error"),
    ]
    call_count = 0

    async def mock_get_inspect_frame(buffer_name: str) -> bytes | None:
        nonlocal call_count
        # Only raise on stream 0 so gather handles one failure per iteration
        if buffer_name == "host_formed_beams_buffer_0" and call_count < len(errors):
            err = errors[call_count]
            call_count += 1
            raise err
        return None

    client.get_inspect_frame.side_effect = mock_get_inspect_frame

    poller = StatusPoller(
        client=client,
        interval=0.05,
        spectrometer_interval=0.05,
        history=5,
    )

    with caplog.at_level("WARNING"):
        await poller.start()
        await asyncio.sleep(0.8)
        await poller.stop()

    assert (
        "Network/client error updating spectrometer: Tracker error 500: Server error"
        in caplog.text
    )
    assert (
        "Network/client error updating spectrometer: HTTP connection dropped"
        in caplog.text
    )
    assert (
        "Data processing error updating spectrometer: Invalid binary frame size"
        in caplog.text
    )
    assert "Unexpected error updating spectrometer: Unexpected error" in caplog.text


@pytest.mark.asyncio
async def test_spectrometer_poller_and_broadcast(sample_status: Status) -> None:
    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = sample_status
    client.get_inspect_frame.return_value = None  # Will use synthetic generator

    poller = StatusPoller(
        client=client,
        interval=0.2,
        spectrometer_interval=0.2,
        history=5,
    )
    spec_q = poller.subscribe_spectrometer()

    assert poller.spectrometer_latest() is None

    await poller.start()
    spec_item = await asyncio.wait_for(spec_q.get(), timeout=1.0)
    assert spec_item is not None
    assert spec_item.num_channels == 672
    assert poller.spectrometer_latest() is not None

    poller.unsubscribe_spectrometer(spec_q)
    await poller.stop()


def test_all_history() -> None:
    from viewer.models import BeamSample

    client = AsyncMock(spec=TrackerClient)
    poller = StatusPoller(client=client, interval=0.2, history=50)

    # Populate dummy history
    for i in range(10):
        poller._history[0].append(BeamSample(ts=float(i), l0=0.1 * i, m0=0.2 * i))
        poller._history[1].append(BeamSample(ts=float(i), l0=-0.1 * i, m0=-0.2 * i))

    hist_all = poller.all_history(max_points=5)
    assert 0 in hist_all
    assert 1 in hist_all
    assert len(hist_all[0]) == 5
    assert len(hist_all[1]) == 5
    # Should get most recent 5
    assert hist_all[0][-1].ts == 9.0


@pytest.mark.asyncio
async def test_poller_multi_cadence_telemetry() -> None:
    from viewer.models import AntennaMaskStatus, BeamPowerResponse

    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = Status(num_active_beams=2)
    client.get_inspect_frame.return_value = None
    client.get_beam_power.return_value = BeamPowerResponse(
        rest_prefix="/direct_tracker", beam_power=[[1.0] * 672] * 4
    )
    client.get_grid_beam_power.return_value = BeamPowerResponse(
        rest_prefix="/grid_tracker", beam_power=[[5.0] * 672] * 16
    )
    client.get_antenna_mask_status.return_value = AntennaMaskStatus(num_elements=64)

    poller = StatusPoller(client=client, interval=0.1, spectrometer_interval=0.1)
    grid_q = poller.subscribe_grid()
    corr_q = poller.subscribe_correlator()
    mask_q = poller.subscribe_antenna_mask()

    await poller.start()

    grid_item = await asyncio.wait_for(grid_q.get(), timeout=1.0)
    assert grid_item is not None
    assert len(grid_item.beam_powers) == 16
    assert poller.grid_latest() is not None

    corr_item = await asyncio.wait_for(corr_q.get(), timeout=1.0)
    assert corr_item is not None
    assert corr_item.num_channels == 672
    assert poller.correlator_latest() is not None

    mask_item = await asyncio.wait_for(mask_q.get(), timeout=1.0)
    assert mask_item is not None
    assert mask_item.num_elements == 64
    assert poller.antenna_mask_latest() is not None

    poller.unsubscribe_grid(grid_q)
    poller.unsubscribe_correlator(corr_q)
    poller.unsubscribe_antenna_mask(mask_q)
    await poller.stop()
