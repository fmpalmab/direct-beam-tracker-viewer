"""Unit tests for the line spectrometer DSP processor and models."""

from __future__ import annotations

import math

import numpy as np

from viewer.models import (
    BeamInfo,
    CelestialTarget,
    CorrelatorDiagnostics,
    SkyGridFrame,
    Status,
)
from viewer.spectrometer import (
    CHANNELS_PER_STREAM,
    FREQUENCIES_ALL_MHZ,
    KNOWN_CELESTIAL_TARGETS,
    TOTAL_CHANNELS,
    SpectrometerProcessor,
    compute_correlator_diagnostics,
    compute_correlator_telemetry,
    compute_power_spectrum,
    format_sky_grid_frame,
    identify_celestial_target,
    power_to_db,
    unpack_astron_visibilities,
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
    for name, ra, dec in KNOWN_CELESTIAL_TARGETS:
        b = BeamInfo(
            beam_id=0,
            celestial_target=CelestialTarget(is_set=True, ra_deg=ra, dec_deg=dec),
        )
        assert identify_celestial_target(b) == name

    b_unset = BeamInfo(beam_id=0, celestial_target=CelestialTarget(is_set=False))
    assert identify_celestial_target(b_unset) == ""

    b_none = None
    assert identify_celestial_target(b_none) == ""

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


def test_generate_synthetic_spectrum_array() -> None:
    processor = SpectrometerProcessor()
    freqs = np.asarray(FREQUENCIES_ALL_MHZ, dtype=np.float64)
    arr = processor.generate_synthetic_spectrum_array(
        beam_id=0, target_name="Sagittarius A*", freqs=freqs
    )
    assert isinstance(arr, np.ndarray)
    assert arr.shape == (TOTAL_CHANNELS,)
    assert arr.dtype == np.float32 or arr.dtype == np.float64
    assert np.all(arr <= 0.0)
    assert np.all(arr >= -100.0)

    # Legacy helper returns list of floats
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
    # status has 2 active beams, but 10 configured beams in status.beams
    status = Status(
        num_active_beams=2,
        beams=[BeamInfo(beam_id=i) for i in range(10)],
    )
    spec_data = processor.process(None, None, status, max_beams=2, cadence_s=0.25)
    assert spec_data.num_channels == TOTAL_CHANNELS
    assert len(spec_data.beams) == 2
    assert len(spec_data.frequencies_mhz) == TOTAL_CHANNELS


def test_unpack_astron_visibilities_hermitian_symmetry() -> None:
    num_freq = 336
    num_elements = 64
    num_receivers = 32
    num_baselines = num_receivers * (num_receivers + 1) // 2  # 528

    # Create synthetic raw buffer of int32 values: [336, 528, 2, 2, 2]
    rng = np.random.default_rng(999)
    raw_ints = rng.integers(
        -5000, 5000, size=(num_freq, num_baselines, 2, 2, 2), dtype=np.int32
    )
    raw_bytes = raw_ints.tobytes()
    assert len(raw_bytes) == num_freq * num_baselines * 2 * 2 * 2 * 4  # 5,677,056 bytes

    vis = unpack_astron_visibilities(
        raw_bytes, num_freq=num_freq, num_elements=num_elements
    )
    assert vis is not None
    assert vis.shape == (num_freq, num_elements, num_elements)
    assert vis.dtype == np.complex64

    # 1. Verify exact Hermitian symmetry: V_ij = conj(V_ji) across all frequencies
    vis_h = vis.swapaxes(1, 2).conj()
    assert np.allclose(vis, vis_h, atol=1e-6)

    # 2. Verify real diagonal: Im(V_ii) == 0 across all frequencies and elements
    diag_imag = vis[:, np.arange(num_elements), np.arange(num_elements)].imag
    assert np.allclose(diag_imag, 0.0, atol=1e-7)


def test_unpack_astron_visibilities_invalid_and_empty() -> None:
    assert unpack_astron_visibilities(None) is None
    assert unpack_astron_visibilities(b"") is None
    assert unpack_astron_visibilities(b"\x00" * 1000) is None


def test_compute_correlator_diagnostics() -> None:
    # 2 subbands each of shape (336, 64, 64)
    v0 = np.ones((336, 64, 64), dtype=np.complex64)
    v1 = np.full((336, 64, 64), 4.0 + 0.0j, dtype=np.complex64)

    diag = compute_correlator_diagnostics(subband_0=v0, subband_1=v1)
    assert isinstance(diag, CorrelatorDiagnostics)
    assert diag.num_channels == 672
    assert diag.num_elements == 64
    assert len(diag.bandpass_db) == 672
    # Subband 0 power 1.0 -> 0 dB, Subband 1 power 4.0 -> ~6.02 dB
    assert math.isclose(diag.bandpass_db[0], 0.0, abs_tol=0.1)
    assert math.isclose(diag.bandpass_db[336], 6.02, abs_tol=0.1)

    # 64x64 amplitude, phase, and normalized coherence matrices
    assert len(diag.amplitude_matrix) == 64
    assert len(diag.amplitude_matrix[0]) == 64
    assert len(diag.phase_matrix) == 64
    assert len(diag.phase_matrix[0]) == 64
    assert len(diag.coherence_matrix) == 64
    assert len(diag.coherence_matrix[0]) == 64
    assert len(diag.auto_db) == 64

    # Reference fringes for [0, 4, 6, 8, 32]
    expected_refs = [0, 4, 6, 8, 32]
    for ant in expected_refs:
        assert ant in diag.reference_fringes
        rf = diag.reference_fringes[ant]
        assert rf.antenna_a == 0
        assert rf.antenna_b == ant
        assert len(rf.amplitude) == 672
        assert len(rf.phase_rad) == 672
        assert len(rf.real) == 672
        assert len(rf.imag) == 672

    # Per-antenna line spectra
    assert len(diag.antenna_spectra_db) == 64
    assert len(diag.antenna_spectra_db[0]) == 84
    assert len(diag.full_antenna_spectra_db) == 64
    assert len(diag.full_antenna_spectra_db[0]) == 672


def test_compute_correlator_telemetry() -> None:
    # 64x64 visibility matrix with known auto and cross terms
    rng = np.random.default_rng(777)
    vis = (rng.normal(0, 1, (64, 64)) + 1j * rng.normal(0, 1, (64, 64))).astype(np.complex64)
    vis = (vis + vis.conj().T) * 0.5
    np.fill_diagonal(vis, 100.0)

    res = compute_correlator_telemetry(vis, zero_diag=True)
    assert "coherence" in res
    assert "phase" in res
    assert "auto_db" in res

    coh = np.array(res["coherence"])
    assert coh.shape == (64, 64)
    # Diagonal should be 0 when zero_diag=True
    assert np.allclose(np.diag(coh), 0.0)
    # Off-diagonal should be bounded in [0, 1]
    assert np.all(coh >= 0.0)
    assert np.all(coh <= 1.0 + 1e-4)

    phases = np.array(res["phase"])
    assert phases.shape == (64, 64)
    assert np.all(phases >= -np.pi - 1e-3)
    assert np.all(phases <= np.pi + 1e-3)

    auto_db = np.array(res["auto_db"])
    assert len(auto_db) == 64
    # 10 * log10(100) = 20.0 dB
    assert np.allclose(auto_db, 20.0, atol=0.1)


def test_compute_correlator_diagnostics_synthetic_fallback() -> None:
    diag = compute_correlator_diagnostics(vis_cube=None)
    assert isinstance(diag, CorrelatorDiagnostics)
    assert diag.num_channels == 672
    assert diag.num_elements == 64
    assert len(diag.bandpass_db) == 672
    assert len(diag.amplitude_matrix) == 64
    assert len(diag.coherence_matrix) == 64
    assert len(diag.reference_fringes) >= 5


def test_format_sky_grid_frame() -> None:
    # 1. 1D powers with clear peak at beam index 5 (l=-0.01, m=-0.01)
    powers = [1.0] * 16
    powers[5] = 50.0
    frame = format_sky_grid_frame(powers, grid_step_rad=0.02)
    assert isinstance(frame, SkyGridFrame)
    assert frame.peak_beam_id == 5
    assert frame.peak_power == 50.0
    assert frame.grid_step_rad == 0.02
    assert len(frame.grid_power) == 4
    assert len(frame.grid_power[0]) == 4
    assert len(frame.beam_powers) == 16
    assert len(frame.l_coords) == 4
    assert len(frame.m_coords) == 4
    # Centroid should be negative for both l and m since beam 5 is (row=1, col=1) -> -0.01, -0.01
    assert frame.centroid_l < 0.0
    assert frame.centroid_m < 0.0

    # 2. 2D spectrum input (16, 672)
    spectra = np.full((16, 672), 3.0, dtype=np.float32)
    frame_spec = format_sky_grid_frame(spectra)
    assert len(frame_spec.beam_powers) == 16
    assert math.isclose(frame_spec.beam_powers[0], 3.0, abs_tol=0.1)
    assert len(frame_spec.beam_power_spectra) == 16
    assert len(frame_spec.beam_power_spectra[0]) == 672

    # 3. None fallback
    frame_fallback = format_sky_grid_frame(None)
    assert len(frame_fallback.beam_powers) == 16
    assert frame_fallback.peak_power > 0.0


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
