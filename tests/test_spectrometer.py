"""Unit tests for the line spectrometer DSP processor and models."""

from __future__ import annotations

import math
import numpy as np

from viewer.models import BeamInfo, CelestialTarget, Status
from viewer.spectrometer import (
    CHANNELS_PER_STREAM,
    TOTAL_CHANNELS,
    SpectrometerProcessor,
    compute_power_spectrum,
    identify_celestial_target,
    power_to_db,
    unpack_formed_beams,
)


def test_unpack_formed_beams() -> None:
    n_time = 10
    n_freq = 336
    max_beams = 2

    # Create synthetic float2 (complex64) data: 10 * 336 * 2 * 8 bytes = 53,760 bytes
    data = (
        np.ones((n_time, n_freq, max_beams), dtype=np.float32)
        + 1j * np.ones((n_time, n_freq, max_beams), dtype=np.float32)
    ).astype(np.complex64)
    raw_bytes = data.tobytes()

    unpacked = unpack_formed_beams(raw_bytes, n_freq, max_beams)
    assert unpacked is not None
    assert unpacked.shape == (n_time, n_freq, max_beams)
    assert np.allclose(unpacked, data)

    # Empty / short bytes return None
    assert unpack_formed_beams(b"") is None
    assert unpack_formed_beams(b"123") is None
    assert unpack_formed_beams(None) is None


def test_compute_power_and_db() -> None:
    # 2 time steps, 4 freq channels, 1 beam: V = 3 + 4j -> |V|^2 = 25.0
    data = np.full((2, 4, 1), 3.0 + 4.0j, dtype=np.complex64)
    power = compute_power_spectrum(data)
    assert power.shape == (4, 1)
    assert np.allclose(power, 25.0)

    db = power_to_db(power)
    # 10 * log10(25) = ~13.9794 dB
    assert np.allclose(db, 10.0 * np.log10(25.0), atol=1e-3)


def test_target_identification() -> None:
    b0 = BeamInfo(
        beam_id=0,
        celestial_target=CelestialTarget(
            is_set=True, ra_deg=266.4168, dec_deg=-29.0078
        ),
    )
    assert identify_celestial_target(b0) == "Sagittarius A*"

    b1 = BeamInfo(
        beam_id=1,
        celestial_target=CelestialTarget(
            is_set=True, ra_deg=128.8361, dec_deg=-45.1764
        ),
    )
    assert identify_celestial_target(b1) == "Vela Pulsar"

    b_other = BeamInfo(
        beam_id=2,
        celestial_target=CelestialTarget(is_set=True, ra_deg=100.0, dec_deg=10.0),
    )
    assert "RA 100.00°" in identify_celestial_target(b_other)


def test_processor_with_real_buffers() -> None:
    processor = SpectrometerProcessor()
    n_time = 16
    n_freq = CHANNELS_PER_STREAM
    max_beams = 2

    # Stream 0: baseline power 1.0 -> 0 dB
    arr0 = np.ones((n_time, n_freq, max_beams), dtype=np.complex64)
    # Stream 1: baseline power 4.0 -> ~6.02 dB
    arr1 = np.full((n_time, n_freq, max_beams), 2.0 + 0.0j, dtype=np.complex64)

    status = Status(
        num_active_beams=2,
        beams=[
            BeamInfo(
                beam_id=0,
                celestial_target=CelestialTarget(
                    is_set=True, ra_deg=266.4168, dec_deg=-29.0078
                ),
            ),
            BeamInfo(
                beam_id=1,
                celestial_target=CelestialTarget(
                    is_set=True, ra_deg=128.8361, dec_deg=-45.1764
                ),
            ),
        ],
    )

    spec_data = processor.process(arr0.tobytes(), arr1.tobytes(), status, max_beams=2)
    assert spec_data.num_channels == TOTAL_CHANNELS
    assert len(spec_data.beams) == 2

    b0 = spec_data.beams[0]
    assert b0.beam_id == 0
    assert "Sagittarius" in b0.label
    assert len(b0.frequencies_mhz) == TOTAL_CHANNELS
    assert len(b0.power_db) == TOTAL_CHANNELS
    # First half should be ~0 dB, second half should be ~6.02 dB
    assert math.isclose(b0.power_db[0], 0.0, abs_tol=0.1)
    assert math.isclose(b0.power_db[336], 6.02, abs_tol=0.1)
    assert "peak_freq_mhz" in b0.stats
    assert "mean" in b0.stats


def test_processor_fallback_synthetic() -> None:
    processor = SpectrometerProcessor()
    status = Status(num_active_beams=2)

    # When buffers are None, processor generates realistic synthetic spectra
    spec_data = processor.process(None, None, status, max_beams=2)
    assert spec_data.num_channels == TOTAL_CHANNELS
    assert len(spec_data.beams) == 2

    b0 = spec_data.beams[0]
    assert len(b0.power_db) == TOTAL_CHANNELS
    assert b0.stats["max"] > b0.stats["min"]
    assert b0.stats["mean"] < 0.0  # Should be negative dB floor
