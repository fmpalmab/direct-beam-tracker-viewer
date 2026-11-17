"""Unit tests for viewer.sefd_utils (quantizer, SEFD, sensitivity, gains, pre-whitening)."""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from viewer.models import (
    BeamInfo,
    RfiChannelItem,
    RfiChannelsResponse,
    RfiStatus,
    Status,
)
from viewer.sefd_utils import (
    NOMINAL_ZENITH_SEFD_JY,
    RFI_FREQ_MAD,
    RFI_SK_CW_TONE,
    RFI_STATIC_NOTCH,
    TOTAL_BANDWIDTH_HZ,
    beam_geometry_from_lmn,
    compute_beam_sefd,
    compute_prewhitening_gains,
    compute_radiometer_step,
    compute_sefd_summary,
    prepare_gains_for_kotekan,
    quantizer_diagnostics,
)


def test_quantizer_diagnostics_optimal_window() -> None:
    # q_rms ~ 3.5 -> sigma_hat^2 ~ 3.06 LSB^2 -> sigma ~ 1.70 LSB, eta_q ~ 0.946
    # Optimal window [0.933, 2.639] reaches eta_q > 0.97 around sigma ~ 2.4 (power ~ 5.8)
    diag = quantizer_diagnostics(np.array([3.0625, 0.25, 60.0, 5.8]))
    assert diag["sigma"][0] == pytest.approx(1.70, abs=0.08)
    assert 0.94 < diag["eta_q"][0] < 0.96
    assert diag["q_rms"][0] == pytest.approx(3.50, abs=0.05)
    assert bool(diag["in_optimal_window"][0]) is True

    # Very low and heavily saturated powers fall outside optimal window
    assert bool(diag["in_optimal_window"][1]) is False
    assert bool(diag["in_optimal_window"][2]) is False
    assert bool(diag["in_optimal_window"][3]) is True
    assert diag["eta_q"][3] > 0.97


def test_beam_geometry_and_sefd_elevation_dependence() -> None:
    alt_z, az_z = beam_geometry_from_lmn(0.0, 0.0, 1.0)
    assert alt_z == pytest.approx(90.0, abs=1e-6)
    assert az_z == pytest.approx(0.0, abs=1e-6)

    alt_e, az_e = beam_geometry_from_lmn(0.5, 0.0)
    assert alt_e == pytest.approx(60.0, abs=1e-4)
    assert az_e == pytest.approx(90.0, abs=1e-4)

    freqs = np.linspace(300.0, 501.3, 672)
    sefd_zen, b_zen = compute_beam_sefd(
        NOMINAL_ZENITH_SEFD_JY, 90.0, 0.0, freqs, n_alive=4, eta_quant=0.972
    )
    sefd_off, b_off = compute_beam_sefd(
        NOMINAL_ZENITH_SEFD_JY, 50.0, 90.0, freqs, n_alive=4, eta_quant=0.972
    )

    assert b_zen == pytest.approx(1.0, abs=1e-6)
    assert 0.0 < b_off < 1.0
    assert float(np.median(sefd_zen)) == pytest.approx(
        NOMINAL_ZENITH_SEFD_JY / (4 * 0.972), rel=1e-3
    )
    assert float(np.median(sefd_off)) > float(np.median(sefd_zen))

    # Below horizon returns 0 response safely
    _, b_below = compute_beam_sefd(
        NOMINAL_ZENITH_SEFD_JY, -5.0, 0.0, freqs, n_alive=4, eta_quant=0.972
    )
    assert b_below == 0.0


def test_radiometer_step_rfi_bandwidth() -> None:
    res = compute_radiometer_step(
        beam_sefd_jy=185_000.0,
        dnu_hz=TOTAL_BANDWIDTH_HZ,
        tau_s=1.0,
        rfi_flagged_fraction=0.10,
        n_pol=1,
        snr=10.0,
        width_s=1e-3,
    )
    expected_bw_hz = TOTAL_BANDWIDTH_HZ * 0.90
    expected_sigma = 185_000.0 / math.sqrt(expected_bw_hz)
    expected_fmin = 1e3 * 10.0 * 185_000.0 * math.sqrt(1e-3) / math.sqrt(expected_bw_hz)

    assert res["dnu_clean_hz"] == pytest.approx(expected_bw_hz, rel=1e-6)
    assert res["dnu_clean_mhz"] == pytest.approx(201.6 * 0.90, rel=1e-6)
    assert res["sigma_s_jy"] == pytest.approx(expected_sigma, rel=1e-5)
    assert res["fluence_min_jy_ms"] == pytest.approx(expected_fmin, rel=1e-5)


def test_compute_sefd_summary() -> None:
    status = Status(
        active_antennas=4,
        taper_type="none",
        apply_calibration_gains=True,
        beams=[
            BeamInfo(beam_id=0, l0=0.0, m0=0.0, n0=1.0, calibrated=True),
            BeamInfo(beam_id=1, l0=0.3, m0=0.2, n0=0.9327, calibrated=False),
        ],
    )
    rfi_st = RfiStatus(total_channels=672, flagged_channels=34, overall_flagged_chunk_fraction=0.05)
    rfi_ch = RfiChannelsResponse(
        total_channels=672,
        channels=[
            RfiChannelItem(freq_mhz=300.0 + i * 0.3, mean_power=3.06, flag_bits=0)
            for i in range(672)
        ],
    )
    summary = compute_sefd_summary(
        status=status,
        rfi_status=rfi_st,
        rfi_channels=rfi_ch,
        beam_names={0: "Zenith", 1: "Fornax A"},
    )
    assert summary.n_alive == 4
    assert summary.clean_bandwidth_mhz == pytest.approx(201.6 * 0.95, abs=0.2)
    assert len(summary.beams) == 2
    assert summary.beams[0].element_response == pytest.approx(1.0, abs=1e-3)
    assert summary.beams[1].sefd_beam_jy > summary.beams[0].sefd_beam_jy
    assert summary.beams[0].calibrated is True
    assert summary.beams[1].calibrated is False


def test_prepare_gains_for_kotekan_npz_and_zero_flagged(tmp_path: Path) -> None:
    npz_path = tmp_path / "gains_sun_test.npz"
    n_freq = 672
    antennas = np.array([0, 4, 32, 36], dtype=int)
    gains = np.ones((n_freq, 4), dtype=np.complex128) * (1.5 - 0.5j)
    freq_mhz = np.array(
        [300.0 + i * 0.3 for i in range(336)] + [400.8 + i * 0.3 for i in range(336)],
        dtype=float,
    )
    flagged = np.zeros(n_freq, dtype=bool)
    flagged[10:15] = True  # contiguous 5 channels
    bursty = np.zeros(n_freq, dtype=bool)
    bursty[400] = True

    np.savez(
        npz_path,
        format_version=2,
        gains=gains,
        antennas=antennas,
        freq_mhz=freq_mhz,
        flagged_channels=flagged,
        bursty_channels=bursty,
        incoherent_channels=np.zeros(n_freq, dtype=bool),
    )

    prep = prepare_gains_for_kotekan(npz_path, zero_flagged=True, output_dir=tmp_path)
    assert prep["converted"] is True
    assert prep["shape"] == [672, 64]
    assert prep["active_antennas"] == [0, 4, 32, 36]
    assert len(prep["static_notch_bands_mhz"]) >= 2

    out_arr = np.load(prep["npy_path"])
    assert out_arr.shape == (672, 64)
    assert out_arr.dtype == np.complex64
    # Flagged channels zeroed out when zero_flagged=True
    assert np.all(out_arr[10:15, :] == 0)
    assert np.all(out_arr[400, :] == 0)
    # Uncalibrated antennas remain 0+0j
    assert np.all(out_arr[:, 1] == 0)
    # Clean channels on calibrated antennas match
    assert np.allclose(out_arr[0, [0, 4, 32, 36]], 1.5 - 0.5j)


def test_prepare_gains_for_kotekan_npy_passthrough(tmp_path: Path) -> None:
    remote_path = "/data/calibration/corr_1113/gains_672x64.npy"
    prep_remote = prepare_gains_for_kotekan(remote_path, zero_flagged=False)
    assert prep_remote["npy_path"] == remote_path
    assert prep_remote["converted"] is False

    local_npy = tmp_path / "local_672x64.npy"
    np.save(local_npy, np.ones((672, 64), dtype=np.complex64))
    prep_local = prepare_gains_for_kotekan(local_npy, zero_flagged=False)
    assert prep_local["npy_path"] == str(local_npy)
    assert prep_local["converted"] is False
    assert prep_local["shape"] == [672, 64]


def test_compute_prewhitening_gains_excludes_rfi() -> None:
    channels = []
    for i in range(672):
        sb = 0 if i < 336 else 1
        lch = i % 336
        f0 = 300.0 if sb == 0 else 400.8
        freq_mhz = round(f0 + lch * 0.3, 3)
        pwr = 3.0 + 0.01 * lch
        bits = 0
        mad_z = 0.1
        frac = 0.0
        if lch == 100 and sb == 0:
            pwr = 900.0
            bits = RFI_SK_CW_TONE | RFI_FREQ_MAD
            mad_z = 35.0
            frac = 1.0
        elif 206 <= lch <= 210 and sb == 0:
            pwr = 500.0
            bits = RFI_STATIC_NOTCH
            frac = 1.0
        channels.append(
            RfiChannelItem(
                freq_mhz=freq_mhz,
                subband=sb,
                local_channel=lch,
                mean_power=pwr,
                freq_mad_z=mad_z,
                flagged_chunk_fraction=frac,
                flag_bits=bits,
            )
        )

    g_sb0, g_sb1, meta = compute_prewhitening_gains(channels)
    assert len(g_sb0) == 336
    assert g_sb1 is not None
    assert len(g_sb1) == 336
    assert meta["clean_channels"] < 672
    # Flagged channel 100 should stay smoothly aligned with channel 99
    assert abs(g_sb0[100] - g_sb0[99]) < 0.05
