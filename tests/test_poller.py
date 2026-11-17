"""Unit tests for StatusPoller lifecycle, history, RFI/SEFD, and antenna channel power."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import httpx
import pytest

from viewer.client import TrackerClient, TrackerError
from viewer.models import (
    AntennaChannelPowerResponse,
    AntennaChannelPowerSubband,
    AntennaMaskStatus,
    AntennaMetricItem,
    BeamInfo,
    BeamPowerResponse,
    BeamSample,
    RfiChannelItem,
    RfiChannelsResponse,
    RfiStatus,
    Status,
)
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
    received = await asyncio.wait_for(q.get(), timeout=1.0)
    assert received.num_active_beams == 1
    assert poller.latest() is not None
    assert poller.healthy is True

    hist = poller.history(0)
    assert len(hist) >= 1
    assert hist[0].l0 == 0.15
    assert hist[0].m0 == -0.25

    poller.unsubscribe(q)
    await poller.stop()


@pytest.mark.asyncio
async def test_poller_resilience_to_errors(sample_status: Status) -> None:
    client = AsyncMock(spec=TrackerClient)
    recovered = asyncio.Event()
    call_idx = 0

    async def get_status_seq() -> Status:
        nonlocal call_idx
        call_idx += 1
        if call_idx == 2:
            raise TrackerError(500, "Internal kotekan glitch")
        if call_idx >= 3:
            recovered.set()
        return sample_status

    client.get_status.side_effect = get_status_seq

    poller = StatusPoller(client=client, interval=0.2, history=10)
    q = poller.subscribe()

    await poller.start()

    s1 = await asyncio.wait_for(q.get(), timeout=1.0)
    assert s1.active_antennas == 16
    assert poller.healthy is True

    await asyncio.wait_for(recovered.wait(), timeout=2.0)
    await asyncio.sleep(0.05)

    assert poller.healthy is True
    assert poller.latest() is not None

    poller.unsubscribe(q)
    await poller.stop()


@pytest.mark.asyncio
async def test_subscriber_queue_overflow_protection(sample_status: Status) -> None:
    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = sample_status

    poller = StatusPoller(client=client, interval=0.2, history=5)
    q = poller.subscribe()

    for _ in range(15):
        poller._broadcast(sample_status)

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
    done_ev = asyncio.Event()

    async def mock_get_inspect_frame(buffer_name: str) -> bytes | None:
        nonlocal call_count
        if buffer_name == "host_formed_beams_buffer_0" and call_count < len(errors):
            err = errors[call_count]
            call_count += 1
            if call_count == len(errors):
                done_ev.set()
            raise err
        return None

    client.get_inspect_frame.side_effect = mock_get_inspect_frame

    poller = StatusPoller(
        client=client,
        interval=0.2,
        spectrometer_interval=0.2,
        history=5,
    )

    with caplog.at_level("WARNING"):
        await poller.start()
        await asyncio.wait_for(done_ev.wait(), timeout=3.0)
        await asyncio.sleep(0.05)
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
    client.get_inspect_frame.return_value = None

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
    client = AsyncMock(spec=TrackerClient)
    poller = StatusPoller(client=client, interval=0.2, history=50)

    for i in range(10):
        poller._history[0].append(BeamSample(ts=float(i), l0=0.1 * i, m0=0.2 * i))
        poller._history[1].append(BeamSample(ts=float(i), l0=-0.1 * i, m0=-0.2 * i))

    hist_all = poller.all_history(max_points=5)
    assert 0 in hist_all
    assert 1 in hist_all
    assert len(hist_all[0]) == 5
    assert len(hist_all[1]) == 5
    assert hist_all[0][-1].ts == 9.0


@pytest.mark.asyncio
async def test_poller_rfi_sefd_and_antenna_channel_power() -> None:
    client = AsyncMock(spec=TrackerClient)
    client.get_status.return_value = Status(
        active_antennas=5,
        num_active_beams=2,
        beams=[BeamInfo(beam_id=0, l0=0.0, m0=0.0, n0=1.0), BeamInfo(beam_id=1, l0=0.2, m0=0.1, n0=0.9747)],
    )
    client.get_inspect_frame.return_value = None
    client.get_beam_power.return_value = BeamPowerResponse(
        rest_prefix="/direct_tracker", beam_power=[[1.0] * 672] * 4
    )
    client.get_rfi_status.return_value = RfiStatus(
        enabled=True,
        total_channels=672,
        flagged_channels=10,
        overall_flagged_chunk_fraction=0.015,
    )
    client.get_rfi_channels.return_value = RfiChannelsResponse(
        total_channels=672,
        channels=[
            RfiChannelItem(
                freq_mhz=300.0 + i * 0.3,
                subband=0 if i < 336 else 1,
                local_channel=i % 336,
                mean_power=3.06,
            )
            for i in range(672)
        ],
    )
    client.get_antenna_mask_status.return_value = AntennaMaskStatus(
        num_elements=64,
        antennas=[AntennaMetricItem(antenna_id=i, enabled=True) for i in range(64)],
    )
    client.get_antenna_channel_power.return_value = AntennaChannelPowerResponse(
        num_elements=64,
        subbands=[
            AntennaChannelPowerSubband(
                subband=0,
                freq_start_hz=300.0e6,
                has_channel_power=True,
                channel_power=[[4.0] * 64 for _ in range(336)],
            ),
            AntennaChannelPowerSubband(
                subband=1,
                freq_start_hz=400.8e6,
                has_channel_power=True,
                channel_power=[[8.0] * 64 for _ in range(336)],
            ),
        ],
    )

    poller = StatusPoller(client=client, interval=0.2, spectrometer_interval=0.2)
    rfi_q = poller.subscribe_rfi()
    sefd_q = poller.subscribe_sefd()
    mask_q = poller.subscribe_antenna_mask()

    await poller.start()

    rfi_item = await asyncio.wait_for(rfi_q.get(), timeout=1.5)
    assert rfi_item["status"]["total_channels"] == 672
    assert len(rfi_item["channels"]["channels"]) == 672
    assert poller.rfi_latest() is not None
    assert poller.rfi_channels_latest() is not None

    sefd_item = await asyncio.wait_for(sefd_q.get(), timeout=1.5)
    assert sefd_item.n_alive == 5
    assert 1.5 < sefd_item.quantizer_sigma_lsb < 1.9
    assert len(sefd_item.beams) == 2
    assert poller.sefd_latest() is not None

    mask_item = await asyncio.wait_for(mask_q.get(), timeout=1.5)
    assert mask_item.num_elements == 64
    assert len(mask_item.antennas[0].spectrum_db) == 84
    spec_672 = poller.antenna_spectrum(0)
    assert spec_672["num_channels"] == 672
    assert spec_672["spectrum_db"][0] == pytest.approx(6.02, abs=0.05)
    assert spec_672["spectrum_db"][336] == pytest.approx(9.03, abs=0.05)

    poller.unsubscribe_rfi(rfi_q)
    poller.unsubscribe_sefd(sefd_q)
    poller.unsubscribe_antenna_mask(mask_q)
    await poller.stop()


@pytest.mark.asyncio
async def test_poller_offline_rfi_and_mask_synthetic_fallback() -> None:
    client = AsyncMock(spec=TrackerClient)
    client.get_status.side_effect = httpx.ConnectError("offline")
    client.get_rfi_status.side_effect = httpx.ConnectError("offline")
    client.get_rfi_channels.side_effect = httpx.ConnectError("offline")
    client.get_antenna_mask_status.side_effect = httpx.ConnectError("offline")
    client.get_antenna_channel_power.side_effect = httpx.ConnectError("offline")

    poller = StatusPoller(client=client, interval=0.2, spectrometer_interval=0.2)
    rfi_q = poller.subscribe_rfi()
    sefd_q = poller.subscribe_sefd()
    mask_q = poller.subscribe_antenna_mask()

    await poller.start()

    rfi_item = await asyncio.wait_for(rfi_q.get(), timeout=1.5)
    assert rfi_item["status"]["total_channels"] == 672
    assert rfi_item["status"]["flagged_channels"] > 0

    sefd_item = await asyncio.wait_for(sefd_q.get(), timeout=1.5)
    assert sefd_item.n_alive > 0
    assert sefd_item.clean_bandwidth_mhz < 201.6

    mask_item = await asyncio.wait_for(mask_q.get(), timeout=1.5)
    assert len(mask_item.antennas) == 64
    assert poller.antenna_spectrum(0)["num_channels"] == 672

    poller.unsubscribe_rfi(rfi_q)
    poller.unsubscribe_sefd(sefd_q)
    poller.unsubscribe_antenna_mask(mask_q)
    await poller.stop()
