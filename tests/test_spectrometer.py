"""Unit tests for the line spectrometer DSP processor and models."""

from __future__ import annotations

import math

import numpy as np

from viewer.models import (
    BeamInfo,
    CelestialTarget,
    Status,
)
from viewer.spectrometer import (
    CHANNELS_PER_STREAM,
    FREQUENCIES_ALL_MHZ,
    KNOWN_CELESTIAL_TARGETS,
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

    data = (
        np.ones((n_time, n_freq, max_beams), dtype=np.float32)
        + 1j * np.ones((n_time, n_freq, max_beams), dtype=np.float32)
    ).astype(np.complex64)
    raw_bytes = data.tobytes()

    unpacked = unpack_formed_beams(raw_bytes, n_freq, max_beams)
    assert unpacked is not None
    assert unpacked.shape == (n_time, n_freq, max_beams)
    assert np.allclose(unpacked, data)

    assert unpack_formed_beams(b"") is None
    assert unpack_formed_beams(b"123") is None
    assert unpack_formed_beams(None) is None


def test_compute_power_and_db() -> None:
    data = np.full((2, 4, 1), 3.0 + 4.0j, dtype=np.complex64)
    power = compute_power_spectrum(data)
    assert power.shape == (4, 1)
    assert np.allclose(power, 25.0)

    db = power_to_db(power)
    assert np.allclose(db, 10.0 * np.log10(25.0), atol=1e-3)


def test_target_identification() -> None:
    for name, ra, dec in KNOWN_CELESTIAL_TARGETS:
        b = BeamInfo(
            beam_id=0,
            celestial_target=CelestialTarget(is_set=True, ra_deg=ra, dec_deg=dec),
        )
        assert identify_celestial_target(b) == name

    b_unset = BeamInfo(beam_id=0, celestial_target=CelestialTarget(is_set=False))
    assert identify_celestial_target(b_unset) == ""

    assert identify_celestial_target(None) == ""

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

    arr0 = np.ones((n_time, n_freq, max_beams), dtype=np.complex64)
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
    assert math.isclose(b0.power_db[0], 0.0, abs_tol=0.1)
    assert math.isclose(b0.power_db[336], 6.02, abs_tol=0.1)
    assert "peak_freq_mhz" in b0.stats
    assert "mean" in b0.stats


def test_processor_fallback_synthetic() -> None:
    processor = SpectrometerProcessor()
    status = Status(num_active_beams=2)

    spec_data = processor.process(None, None, status, max_beams=2)
    assert spec_data.num_channels == TOTAL_CHANNELS
    assert len(spec_data.beams) == 2

    b0 = spec_data.beams[0]
    assert len(b0.power_db) == TOTAL_CHANNELS
    assert b0.stats["max"] > b0.stats["min"]
    assert b0.stats["mean"] < 0.0


def test_generate_synthetic_spectrum_array() -> None:
    processor = SpectrometerProcessor()
    freqs = np.asarray(FREQUENCIES_ALL_MHZ, dtype=np.float64)
    arr = processor.generate_synthetic_spectrum_array(
        beam_id=0, target_name="Sagittarius A*", freqs=freqs
    )
    assert isinstance(arr, np.ndarray)
    assert arr.shape == (TOTAL_CHANNELS,)
    assert np.all(arr <= 0.0)
    assert np.all(arr >= -100.0)

    lst = processor.generate_synthetic_spectrum(
        beam_id=0, target_name="Sagittarius A*", frequencies=FREQUENCIES_ALL_MHZ
    )
    assert isinstance(lst, list)
    assert len(lst) == TOTAL_CHANNELS
    assert isinstance(lst[0], float)


def test_target_identification_with_catalog_targets() -> None:
    catalog_targets = [
        {"label": "NGC 1316 (Fornax A)", "ra_deg": 50.675, "dec_deg": -37.2083},
        {"label": "NGC 253 (Sculptor)", "ra_deg": 11.8875, "dec_deg": -25.2883},
    ]
    b = BeamInfo(
        beam_id=3,
        celestial_target=CelestialTarget(is_set=True, ra_deg=50.68, dec_deg=-37.21),
    )
    assert (
        identify_celestial_target(b, catalog_targets=catalog_targets)
        == "NGC 1316 (Fornax A)"
    )


def test_processor_effective_max_beams() -> None:
    processor = SpectrometerProcessor()
    status = Status(
        num_active_beams=2,
        beams=[BeamInfo(beam_id=i) for i in range(10)],
    )
    spec_data = processor.process(None, None, status, max_beams=2, cadence_s=0.25)
    assert spec_data.num_channels == TOTAL_CHANNELS
    assert len(spec_data.beams) == 2
    assert len(spec_data.frequencies_mhz) == TOTAL_CHANNELS


def test_subband_stitching_672_channels() -> None:
    processor = SpectrometerProcessor()
    direct_bp = [[1.0] * TOTAL_CHANNELS for _ in range(4)]
    status = Status(num_active_beams=2)
    spec_data = processor.process(
        None, None, status=status, max_beams=4, direct_beam_power=direct_bp
    )
    assert spec_data.num_channels == TOTAL_CHANNELS
    assert len(spec_data.frequencies_mhz) == TOTAL_CHANNELS
    assert len(spec_data.beams) == 2
    assert len(spec_data.beams[0].power_db) == TOTAL_CHANNELS
