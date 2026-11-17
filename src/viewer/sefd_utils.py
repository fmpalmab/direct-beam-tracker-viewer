"""SEFD, radiometer sensitivity, 4-bit quantizer diagnostics, and calibration helpers.

Bridges ``charts_sefd`` and ``charts_utils`` into the Direct Beam Tracker Viewer,
with clean analytical fallbacks so the viewer and its test suite also run
standalone without requiring sibling packages installed in the environment.
"""

from __future__ import annotations

import logging
import math
import sys
import tempfile
from collections.abc import Sequence
from pathlib import Path
from typing import Any

import numpy as np

from .models import (
    AntennaMaskStatus,
    BeamSensitivityItem,
    RfiChannelItem,
    RfiChannelsResponse,
    RfiStatus,
    SefdSensitivitySummary,
    Status,
)

logger = logging.getLogger(__name__)

# Nominal CHARTS site & instrument constants (Mena-Parra et al. 2018; SEFD v6)
NOMINAL_ZENITH_SEFD_JY: float = 7.21e5
SUBBAND0_START_HZ: float = 300.0e6
SUBBAND1_START_HZ: float = 400.8e6
CHANNEL_WIDTH_HZ: float = 300.0e3
CHANNEL_WIDTH_MHZ: float = 0.3
N_CHAN_SUBBAND: int = 336
N_CHAN_TOTAL: int = 672
TOTAL_BANDWIDTH_HZ: float = N_CHAN_TOTAL * CHANNEL_WIDTH_HZ  # 201.6 MHz
TOTAL_BANDWIDTH_MHZ: float = N_CHAN_TOTAL * CHANNEL_WIDTH_MHZ

# Flag bitmask matching Kotekan lib/cuda/cudaRfiMitigation.hpp RfiFlagReason
RFI_SK_IMPULSIVE: int = 1 << 0
RFI_SK_CW_TONE: int = 1 << 1
RFI_TIME_BURST: int = 1 << 2
RFI_FREQ_MAD: int = 1 << 3
RFI_STATIC_NOTCH: int = 1 << 4
RFI_SATURATION_CLIP: int = 1 << 5
RFI_MORPHOLOGY_SIR: int = 1 << 6

DEFAULT_ANTENNA_SPECS: dict[float, dict[str, float]] = {
    300e6: {"BW_E": 92.0, "BW_H": 66.0, "gain_dBi": 8.7},
    400e6: {"BW_E": 108.0, "BW_H": 74.0, "gain_dBi": 7.75},
    500e6: {"BW_E": 120.0, "BW_H": 87.0, "gain_dBi": 7.0},
}

# 4-bit 15-level mid-tread F-engine quantizer constants
_QUANT_SAT: int = 7
_QUANT_THRESHOLDS: np.ndarray = np.arange(1, 15, dtype=float) - 7.5
_OPTIMAL_SIGMA: tuple[float, float] = (2.0**-0.1, 2.0**1.4)
_ERF_VEC = np.vectorize(math.erf, otypes=[float])
_SIGMA_GRID: np.ndarray = 2.0 ** np.linspace(-6.0, 8.0, 4001)
_SH2_GRID: np.ndarray | None = None


def _ensure_sibling_repos_on_path() -> None:
    """Add sibling CHARTS repositories to sys.path if present on disk."""
    repo_root = Path(__file__).resolve().parents[2]
    candidate_roots = [repo_root.parent, Path(r"d:\charts")]
    for root in candidate_roots:
        if not root.is_dir():
            continue
        for pkg_dir in ("charts-sefd", "charts-utils", "charts-constants"):
            candidate = root / pkg_dir
            if candidate.is_dir():
                s_path = str(candidate)
                if s_path not in sys.path:
                    sys.path.append(s_path)


def _get_sh2_grid() -> np.ndarray:
    global _SH2_GRID
    if _SH2_GRID is None:
        _SH2_GRID = _analytical_sigma_hat2(_SIGMA_GRID)
    return _SH2_GRID


def _analytical_sigma_hat2(sigma: np.ndarray | float) -> np.ndarray:
    s = np.maximum(np.asarray(sigma, dtype=float), 1e-300)[..., None]
    return 2.0 * _QUANT_SAT**2 - 2.0 * np.sum(
        _QUANT_THRESHOLDS * _ERF_VEC(_QUANT_THRESHOLDS / s), axis=-1
    )


def _analytical_a_coef(sigma: np.ndarray | float) -> np.ndarray:
    sc = np.maximum(np.asarray(sigma, dtype=float), 1e-300)[..., None] / math.sqrt(2.0)
    phi = np.exp(-0.5 * (_QUANT_THRESHOLDS / sc) ** 2) / math.sqrt(2.0 * math.pi)
    return np.sum(phi, axis=-1) / sc[..., 0] - 1.0


def _analytical_quantizer_diagnostics(
    mean_power_lsb2: np.ndarray | Sequence[float] | float,
) -> dict[str, np.ndarray]:
    p = np.asarray(mean_power_lsb2, dtype=float)
    sh2_grid = _get_sh2_grid()
    sigma = np.interp(p, sh2_grid, _SIGMA_GRID, left=np.nan, right=np.nan)
    sigma = np.where((p > sh2_grid[0]) & (p < sh2_grid[-1]), sigma, np.nan)
    with np.errstate(divide="ignore", invalid="ignore"):
        sh2 = _analytical_sigma_hat2(sigma)
        a_c = _analytical_a_coef(sigma)
        eta_q = ((1.0 + a_c) * sigma) ** 2 / sh2
        q_rms = 2.0 * np.sqrt(sh2)
    in_win = (sigma >= _OPTIMAL_SIGMA[0]) & (sigma <= _OPTIMAL_SIGMA[1])
    return {
        "sigma": sigma,
        "eta_q": eta_q,
        "q_rms": q_rms,
        "in_optimal_window": in_win,
    }


def quantizer_diagnostics(
    mean_power_lsb2: np.ndarray | Sequence[float] | float,
) -> dict[str, np.ndarray]:
    """Compute 4-bit F-engine quantizer diagnostics from quantized power (LSB^2).

    Uses ``charts_sefd.quantization`` when available and falls back to the exact
    Mena-Parra et al. (2018) Gaussian quantizer solver.
    """
    _ensure_sibling_repos_on_path()
    try:
        from charts_sefd.quantization import (
            eta_from_sigma,
            in_optimal_window,
            q_rms,
            sigma_from_power,
        )

        sigma = np.asarray(sigma_from_power(mean_power_lsb2), dtype=float)
        eta_q = np.asarray(eta_from_sigma(sigma), dtype=float)
        q_rms_arr = np.asarray(q_rms(sigma), dtype=float)
        in_win = np.asarray(in_optimal_window(sigma), dtype=bool)
        return {
            "sigma": sigma,
            "eta_q": eta_q,
            "q_rms": q_rms_arr,
            "in_optimal_window": in_win,
        }
    except Exception:
        return _analytical_quantizer_diagnostics(mean_power_lsb2)


def beam_geometry_from_lmn(
    l0: float, m0: float, n0: float | None = None
) -> tuple[float, float]:
    """Convert topocentric ENU direction cosines (l0, m0, n0) to (alt_deg, az_deg)."""
    r = min(1.0, math.hypot(float(l0), float(m0)))
    alt_deg = 90.0 - math.degrees(math.asin(r))
    if l0 == 0.0 and m0 == 0.0:
        az_deg = 0.0
    else:
        az_deg = math.degrees(math.atan2(float(l0), float(m0))) % 360.0
    return alt_deg, az_deg


def _get_antenna_specs(specs: dict[float, dict[str, float]] | None = None) -> dict[float, dict[str, float]]:
    if specs is not None:
        return specs
    _ensure_sibling_repos_on_path()
    try:
        from charts_constants.constants import ANTENNA_SPECS

        if isinstance(ANTENNA_SPECS, dict) and ANTENNA_SPECS:
            return ANTENNA_SPECS
    except Exception:
        pass
    return DEFAULT_ANTENNA_SPECS


def _analytical_element_beam(
    alt_deg: float,
    az_deg: float,
    freqs_mhz: np.ndarray,
    specs: dict[float, dict[str, float]] | None = None,
) -> np.ndarray:
    if alt_deg <= 0.0:
        return np.zeros(len(freqs_mhz), dtype=float)
    sp = _get_antenna_specs(specs)
    fk = np.array(sorted(sp), dtype=float)
    f_hz = np.asarray(freqs_mhz, dtype=float) * 1.0e6
    bw_e = np.interp(f_hz, fk, [sp[k]["BW_E"] for k in sorted(sp)])
    bw_h = np.interp(f_hz, fk, [sp[k]["BW_H"] for k in sorted(sp)])
    za = math.radians(90.0 - alt_deg)
    az = math.radians(az_deg)
    tx = math.degrees(math.asin(max(-1.0, min(1.0, math.sin(za) * math.sin(az)))))
    ty = math.degrees(math.asin(max(-1.0, min(1.0, math.sin(za) * math.cos(az)))))
    q = (tx / bw_e) ** 2 + (ty / bw_h) ** 2
    return np.exp(-4.0 * math.log(2.0) * q)


def compute_beam_sefd(
    zenith_sefd_jy: float,
    alt_deg: float,
    az_deg: float,
    freqs_mhz: np.ndarray | Sequence[float],
    n_alive: int,
    eta_quant: float = 0.972,
    specs: dict[float, dict[str, float]] | None = None,
) -> tuple[np.ndarray, float]:
    """Compute per-channel tied-array SEFD [Jy] and mean element response B(alt, az).

    Uses ``charts_sefd.models.{interp_specs, gaussian_power_beam}`` when available
    with an analytical Gaussian element beam fallback.
    """
    f_arr = np.asarray(freqs_mhz, dtype=float).reshape(-1)
    if f_arr.size == 0:
        f_arr = np.linspace(300.0, 501.3, N_CHAN_TOTAL)
    n_eff = max(1, int(n_alive))
    eta_eff = float(np.clip(eta_quant, 1e-3, 1.0))

    if alt_deg <= 0.0:
        return np.full(f_arr.size, np.inf, dtype=float), 0.0

    sp = _get_antenna_specs(specs)
    _ensure_sibling_repos_on_path()
    try:
        from charts_sefd.models import gaussian_power_beam, interp_specs

        fwhm_e, fwhm_h, _gain_dbi = interp_specs(f_arr, sp)
        b_arr = np.asarray(
            gaussian_power_beam(float(alt_deg), float(az_deg), fwhm_e, fwhm_h),
            dtype=float,
        ).reshape(-1)
    except Exception:
        b_arr = _analytical_element_beam(alt_deg, az_deg, f_arr, specs=sp)

    with np.errstate(divide="ignore", invalid="ignore"):
        sefd_arr = np.where(
            b_arr > 1e-6,
            float(zenith_sefd_jy) / (n_eff * eta_eff * b_arr),
            np.inf,
        )
    b_mean = float(np.median(np.clip(b_arr, 0.0, 1.0))) if b_arr.size else 0.0
    return sefd_arr, b_mean


def compute_radiometer_step(
    beam_sefd_jy: float,
    dnu_hz: float = TOTAL_BANDWIDTH_HZ,
    tau_s: float = 1.0,
    rfi_flagged_fraction: float = 0.0,
    n_pol: int = 1,
    snr: float = 10.0,
    width_s: float = 1e-3,
) -> dict[str, float]:
    """Compute RFI-aware clean bandwidth, 1s sigma_S [Jy], and FRB F_min [Jy ms].

    Uses ``charts_sefd.sensitivity.{sigma_s, fluence_min}`` when available with an
    analytical fallback.
    """
    frac = float(np.clip(rfi_flagged_fraction, 0.0, 0.999))
    dnu_clean_hz = max(1.0, float(dnu_hz) * (1.0 - frac))
    if not math.isfinite(beam_sefd_jy) or beam_sefd_jy <= 0.0:
        return {
            "dnu_clean_hz": dnu_clean_hz,
            "dnu_clean_mhz": dnu_clean_hz * 1e-6,
            "sigma_s_jy": 0.0,
            "fluence_min_jy_ms": 0.0,
        }

    _ensure_sibling_repos_on_path()
    try:
        from charts_sefd.sensitivity import fluence_min, sigma_s

        sigma_val = float(
            sigma_s(
                float(beam_sefd_jy),
                1.0,
                dnu_clean_hz,
                max(1e-9, float(tau_s)),
                n_pol=max(1, int(n_pol)),
            )
        )
        fluence_val = 1.0e3 * float(
            fluence_min(
                float(beam_sefd_jy),
                1.0,
                dnu_clean_hz,
                max(1e-9, float(width_s)),
                snr=float(snr),
                n_pol=max(1, int(n_pol)),
            )
        )
    except Exception:
        denom = math.sqrt(max(1, int(n_pol)) * dnu_clean_hz * max(1e-9, float(tau_s)))
        sigma_val = float(beam_sefd_jy) / denom
        f_denom = math.sqrt(max(1, int(n_pol)) * dnu_clean_hz)
        fluence_val = (
            1.0e3
            * float(snr)
            * float(beam_sefd_jy)
            * math.sqrt(max(1e-9, float(width_s)))
            / f_denom
        )

    return {
        "dnu_clean_hz": dnu_clean_hz,
        "dnu_clean_mhz": dnu_clean_hz * 1e-6,
        "sigma_s_jy": sigma_val,
        "fluence_min_jy_ms": fluence_val,
    }


def compute_sefd_summary(
    status: Status | None = None,
    antenna_mask: AntennaMaskStatus | None = None,
    rfi_status: RfiStatus | None = None,
    rfi_channels: RfiChannelsResponse | None = None,
    beam_names: dict[int, str] | None = None,
    zenith_sefd_jy: float = NOMINAL_ZENITH_SEFD_JY,
) -> SefdSensitivitySummary:
    """Aggregate live Kotekan telemetry into an array + per-beam SEFD/sensitivity summary."""
    import time

    _ensure_sibling_repos_on_path()
    source_tag = "analytical"
    try:
        from charts_sefd import models, quantization, sensitivity  # noqa: F401

        source_tag = "charts_sefd"
    except Exception:
        pass

    if status is not None and status.active_antennas > 0:
        n_alive = int(status.active_antennas)
    elif antenna_mask is not None and antenna_mask.active_antennas > 0:
        n_alive = int(antenna_mask.active_antennas)
    else:
        n_alive = 5

    channels = rfi_channels.channels if rfi_channels else []
    clean_powers = [
        ch.mean_power
        for ch in channels
        if ch.mean_power > 0.0 and ch.flag_bits == 0 and math.isfinite(ch.mean_power)
    ]
    if not clean_powers:
        clean_powers = [
            ch.mean_power
            for ch in channels
            if ch.mean_power > 0.0 and math.isfinite(ch.mean_power)
        ]

    mean_power_lsb2 = float(np.median(clean_powers)) if clean_powers else 3.06
    q_diag = quantizer_diagnostics(np.array([mean_power_lsb2], dtype=float))
    sigma_lsb = float(q_diag["sigma"][0]) if np.isfinite(q_diag["sigma"][0]) else 1.70
    eta_q = float(q_diag["eta_q"][0]) if np.isfinite(q_diag["eta_q"][0]) else 0.972
    q_rms = float(q_diag["q_rms"][0]) if np.isfinite(q_diag["q_rms"][0]) else 3.50
    in_opt = bool(q_diag["in_optimal_window"][0])

    if rfi_status is not None and rfi_status.total_channels > 0:
        rfi_frac = float(np.clip(rfi_status.overall_flagged_chunk_fraction, 0.0, 0.999))
        if rfi_frac == 0.0 and rfi_status.flagged_channels > 0:
            rfi_frac = float(rfi_status.flagged_channels) / float(rfi_status.total_channels)
    elif channels:
        rfi_frac = float(np.mean([ch.flagged_chunk_fraction for ch in channels]))
    else:
        rfi_frac = 0.0

    clean_freqs = np.array(
        [ch.freq_mhz for ch in channels if ch.flag_bits == 0], dtype=float
    )
    if clean_freqs.size == 0:
        clean_freqs = np.linspace(300.0, 501.3, N_CHAN_TOTAL)

    zenith_sefd_arr, _ = compute_beam_sefd(
        zenith_sefd_jy=zenith_sefd_jy,
        alt_deg=90.0,
        az_deg=0.0,
        freqs_mhz=clean_freqs,
        n_alive=n_alive,
        eta_quant=eta_q,
    )
    array_zenith_sefd_jy = (
        float(np.nanmedian(zenith_sefd_arr))
        if np.any(np.isfinite(zenith_sefd_arr))
        else zenith_sefd_jy / max(1, n_alive)
    )
    array_rad = compute_radiometer_step(
        beam_sefd_jy=array_zenith_sefd_jy,
        dnu_hz=TOTAL_BANDWIDTH_HZ,
        tau_s=1.0,
        rfi_flagged_fraction=rfi_frac,
    )

    beam_items: list[BeamSensitivityItem] = []
    beams_list = status.beams if status and status.beams else []
    for b in beams_list:
        alt_deg, az_deg = beam_geometry_from_lmn(b.l0, b.m0, b.n0)
        b_sefd_arr, b_resp = compute_beam_sefd(
            zenith_sefd_jy=zenith_sefd_jy,
            alt_deg=alt_deg,
            az_deg=az_deg,
            freqs_mhz=clean_freqs,
            n_alive=n_alive,
            eta_quant=eta_q,
        )
        finite_sefd = b_sefd_arr[np.isfinite(b_sefd_arr)]
        sefd_beam_jy = float(np.median(finite_sefd)) if finite_sefd.size > 0 else 0.0
        rad = compute_radiometer_step(
            beam_sefd_jy=sefd_beam_jy,
            dnu_hz=TOTAL_BANDWIDTH_HZ,
            tau_s=1.0,
            rfi_flagged_fraction=rfi_frac,
        )
        alias = (beam_names or {}).get(b.beam_id, "")
        label = f"Beam {b.beam_id}" + (f" ({alias})" if alias else "")
        beam_items.append(
            BeamSensitivityItem(
                beam_id=b.beam_id,
                label=label,
                l0=round(b.l0, 4),
                m0=round(b.m0, 4),
                n0=round(b.n0, 4),
                alt_deg=round(alt_deg, 2),
                az_deg=round(az_deg, 2),
                element_response=round(b_resp, 4),
                sefd_beam_jy=round(sefd_beam_jy, 1),
                sigma_s_1s_jy=round(rad["sigma_s_jy"], 3),
                fluence_min_1ms_jy_ms=round(rad["fluence_min_jy_ms"], 1),
                calibrated=bool(b.calibrated)
                and (True if status is None or status.apply_calibration_gains is None else bool(status.apply_calibration_gains)),
            )
        )

    return SefdSensitivitySummary(
        timestamp=time.time(),
        nominal_zenith_sefd_jy=zenith_sefd_jy,
        n_alive=n_alive,
        mean_power_lsb2=round(mean_power_lsb2, 4),
        quantizer_sigma_lsb=round(sigma_lsb, 4),
        quantizer_eta_q=round(eta_q, 5),
        quantizer_q_rms=round(q_rms, 4),
        in_optimal_window=in_opt,
        total_bandwidth_mhz=round(TOTAL_BANDWIDTH_MHZ, 2),
        rfi_flagged_fraction=round(rfi_frac, 5),
        clean_bandwidth_mhz=round(array_rad["dnu_clean_mhz"], 2),
        array_zenith_sefd_jy=round(array_zenith_sefd_jy, 1),
        array_sigma_s_1s_jy=round(array_rad["sigma_s_jy"], 3),
        array_fluence_min_1ms_jy_ms=round(array_rad["fluence_min_jy_ms"], 1),
        taper_type=(status.taper_type if status and status.taper_type else "cosine_pedestal"),
        apply_calibration_gains=(
            bool(status.apply_calibration_gains)
            if status and status.apply_calibration_gains is not None
            else True
        ),
        source=source_tag,
        beams=beam_items,
    )


def _merge_flagged_spans(
    freq_mhz: np.ndarray, flagged: np.ndarray
) -> list[list[float]]:
    """Merge contiguous flagged frequency channels into [lo_mhz, hi_mhz] spans."""
    if freq_mhz.size == 0 or flagged.size != freq_mhz.size:
        return []
    order = np.argsort(freq_mhz)
    f_sorted = np.asarray(freq_mhz[order], dtype=float)
    m_sorted = np.asarray(flagged[order], dtype=bool)
    if not np.any(m_sorted):
        return []
    df = float(np.median(np.diff(f_sorted))) if f_sorted.size > 1 else CHANNEL_WIDTH_MHZ
    half = 0.5 * df
    spans: list[list[float]] = []
    start_idx: int | None = None
    for i, flag in enumerate(m_sorted):
        if flag and start_idx is None:
            start_idx = i
        elif not flag and start_idx is not None:
            spans.append(
                [
                    round(float(f_sorted[start_idx] - half), 3),
                    round(float(f_sorted[i - 1] + half), 3),
                ]
            )
            start_idx = None
    if start_idx is not None:
        spans.append(
            [
                round(float(f_sorted[start_idx] - half), 3),
                round(float(f_sorted[-1] + half), 3),
            ]
        )
    return spans


def _write_converted_npy(
    src_path: Path,
    table: np.ndarray,
    zero_flagged: bool,
    output_dir: Path | None = None,
) -> Path:
    suffix = "_freqflt_672x64.npy" if zero_flagged else "_672x64.npy"
    stem = src_path.stem if src_path.is_file() else "gains"
    filename = f"{stem}{suffix}"
    target_dirs = (
        [output_dir]
        if output_dir is not None
        else [
            src_path.parent if src_path.is_file() else src_path,
            Path(tempfile.gettempdir()) / "charts_viewer_gains",
        ]
    )
    for dest_dir in target_dirs:
        try:
            dest_dir.mkdir(parents=True, exist_ok=True)
            out_path = dest_dir / filename
            np.save(out_path, np.asarray(table, dtype=np.complex64))
            return out_path
        except OSError:
            continue
    raise OSError(f"Could not write converted calibration .npy for '{src_path}'")


def _extract_rfi_profile(
    n_freq: int,
    freq_mhz: np.ndarray,
    meta: dict[str, Any],
) -> tuple[np.ndarray, dict[str, Any]]:
    """Build flagged mask and JSON-serializable RFI notch profile from gain metadata."""
    flagged = np.zeros(n_freq, dtype=bool)
    channels_dict: dict[str, list[bool]] = {}
    for key in ("flagged_channels", "bursty_channels", "incoherent_channels"):
        raw = meta.get(key)
        if raw is not None:
            arr = np.asarray(raw, dtype=bool).reshape(-1)
            if arr.shape[0] == n_freq:
                flagged |= arr
                channels_dict[key] = arr.tolist()
                continue
        channels_dict[key] = []

    profile = {
        "freq_mhz": freq_mhz.tolist(),
        "flagged_channels": channels_dict["flagged_channels"],
        "bursty_channels": channels_dict["bursty_channels"],
        "incoherent_channels": channels_dict["incoherent_channels"],
        "static_notch_bands_mhz": _merge_flagged_spans(freq_mhz, flagged),
    }
    return flagged, profile


def _finalize_kotekan_gains_table(
    src: Path,
    table: np.ndarray,
    flagged: np.ndarray,
    zero_flagged: bool,
    output_dir: Path | None,
    rfi_profile: dict[str, Any] | None,
) -> dict[str, Any]:
    """Zero flagged channels if requested, write converted .npy, and return summary."""
    if zero_flagged and np.any(flagged):
        table[flagged, :] = 0.0 + 0.0j

    notches = (
        rfi_profile["static_notch_bands_mhz"] if rfi_profile is not None else []
    )
    out_path = _write_converted_npy(src, table, zero_flagged, output_dir=output_dir)
    active = [
        int(a)
        for a in range(64)
        if np.any(np.isfinite(table[:, a]) & (table[:, a] != 0))
    ]
    return {
        "npy_path": str(out_path),
        "converted": True,
        "shape": list(table.shape),
        "active_antennas": active,
        "static_notch_bands_mhz": notches,
        "rfi_profile": rfi_profile,
    }


def prepare_gains_for_kotekan(
    path: str | Path,
    zero_flagged: bool = False,
    output_dir: str | Path | None = None,
) -> dict[str, Any]:
    """Prepare a ``.npz`` or ``.npy`` gain file into a Kotekan ``(672, 64)`` ``.npy`` table.

    Uses ``charts_utils.cal.gains.load_gains`` and
    ``charts_utils.cal.kotekan_calibration.expand_gains`` when available, with a
    standalone numpy fallback. Unsolved or non-finite entries are zeroed, and
    RFI notch spans are extracted directly from channel flag masks.
    """
    src = Path(path)
    out_dir = Path(output_dir) if output_dir is not None else None

    # Remote / non-local .npy path when no filtering or re-export is requested:
    # pass straight to Kotekan's /direct_tracker/reload_gains endpoint.
    if src.suffix.lower() == ".npy" and not src.exists() and not zero_flagged:
        return {
            "npy_path": str(path),
            "converted": False,
            "shape": None,
            "active_antennas": [],
            "static_notch_bands_mhz": [],
            "rfi_profile": None,
        }

    if not src.exists():
        raise FileNotFoundError(f"Gains file not found: '{path}'")

    # Bare .npy on disk without zero_flagged or custom output_dir
    if src.is_file() and src.suffix.lower() == ".npy" and not zero_flagged and out_dir is None:
        arr = np.load(src, allow_pickle=False)
        if arr.ndim != 2 or arr.shape[1] != 64:
            raise ValueError(
                f"Expected 2D (n_freq, 64) .npy calibration array, got shape {arr.shape}"
            )
        active = [
            int(a)
            for a in range(arr.shape[1])
            if np.any(np.isfinite(arr[:, a]) & (arr[:, a] != 0))
        ]
        return {
            "npy_path": str(src),
            "converted": False,
            "shape": list(arr.shape),
            "active_antennas": active,
            "static_notch_bands_mhz": [],
            "rfi_profile": None,
        }

    _ensure_sibling_repos_on_path()
    try:
        from charts_utils.cal.gains import load_gains
        from charts_utils.cal.kotekan_calibration import expand_gains

        sol = load_gains(src)
        gains = np.asarray(sol.gains)
        if gains.ndim not in (2, 3):
            raise ValueError(f"Expected 2D or 3D gains array, got shape {gains.shape}")
        n_freq, n_sel = gains.shape[0], gains.shape[1]
        antennas = (
            list(sol.antennas) if sol.antennas is not None else list(range(n_sel))
        )
        full = expand_gains(gains, antennas, n_ant=64)

        # expand_gains pads unsolved antennas with 1+0j; Kotekan expects 0+0j for unsolved slots
        table = np.zeros((n_freq, 64), dtype=np.complex64)
        for ant_idx in antennas:
            if 0 <= ant_idx < 64:
                col = full[:, ant_idx]
                valid = np.isfinite(col)
                table[valid, ant_idx] = col[valid].astype(np.complex64)

        freq_mhz = (
            np.asarray(sol.freq_mhz, dtype=float)
            if sol.freq_mhz is not None
            else np.linspace(300.0, 501.3, n_freq)
        )
        if src.is_file() and src.suffix.lower() == ".npy":
            flagged = np.zeros(n_freq, dtype=bool)
            rfi_profile = None
        else:
            flagged, rfi_profile = _extract_rfi_profile(n_freq, freq_mhz, sol.meta)

        return _finalize_kotekan_gains_table(
            src, table, flagged, zero_flagged, out_dir, rfi_profile
        )
    except ImportError:
        pass

    # Standalone numpy fallback
    data = np.load(src, allow_pickle=False)
    if isinstance(data, np.ndarray):
        gains = data
        antennas_fb: list[int] | None = None
        freq_mhz = np.linspace(300.0, 501.3, gains.shape[0])
        flagged = np.zeros(gains.shape[0], dtype=bool)
        rfi_profile = None
    else:
        with data:
            if "gains" not in data.files:
                raise ValueError(f"'{src}' has no 'gains' array (keys: {data.files})")
            gains = np.asarray(data["gains"])
            fmt_ver = (
                int(data["format_version"].item())
                if "format_version" in data.files
                else 1
            )
            if fmt_ver < 2:
                gains = np.conj(gains)
            antennas_fb = (
                [int(a) for a in data["antennas"]] if "antennas" in data.files else None
            )
            freq_mhz = (
                np.asarray(data["freq_mhz"], dtype=float)
                if "freq_mhz" in data.files
                else np.linspace(300.0, 501.3, gains.shape[0])
            )
            meta_dict = {key: data[key] for key in data.files}
            flagged, rfi_profile = _extract_rfi_profile(
                gains.shape[0], freq_mhz, meta_dict
            )

    if gains.ndim == 3:
        gains = np.nanmean(gains, axis=-1)
    if gains.ndim != 2:
        raise ValueError(f"Expected 2D or 3D gains array, got shape {gains.shape}")

    n_freq, n_sel = gains.shape
    if antennas_fb is None:
        antennas_fb = list(range(n_sel))
    if len(antennas_fb) != n_sel:
        raise ValueError(
            f"Antenna list length ({len(antennas_fb)}) does not match gain columns ({n_sel})"
        )

    table = np.zeros((n_freq, 64), dtype=np.complex64)
    for col_idx, ant_idx in enumerate(antennas_fb):
        if 0 <= ant_idx < 64:
            col = gains[:, col_idx]
            valid = np.isfinite(col)
            table[valid, ant_idx] = col[valid].astype(np.complex64)

    return _finalize_kotekan_gains_table(
        src, table, flagged, zero_flagged, out_dir, rfi_profile
    )


def _running_median_1d(arr: np.ndarray, half_width: int = 16) -> np.ndarray:
    n = arr.shape[0]
    out = np.empty(n, dtype=np.float64)
    for i in range(n):
        lo = max(0, i - half_width)
        hi = min(n, i + half_width + 1)
        out[i] = float(np.median(arr[lo:hi]))
    return out


def _compute_subband_gains(
    power: np.ndarray, clean_mask: np.ndarray
) -> list[float]:
    """Compute smooth 1D bandpass gains g(f) = sqrt(env / median(env)) for Kotekan.

    Kotekan's cudaRfiMitigation evaluates P_pre = P / g^2, so setting
    g(f) = sqrt(env(f) / median(env)) flattens the passband baseline.
    """
    n = power.shape[0]
    if n == 0:
        return []
    valid = np.isfinite(power) & (power > 0.0) & clean_mask
    if not np.any(valid):
        valid = np.isfinite(power) & (power > 0.0)
    if not np.any(valid):
        return [1.0] * n

    idx = np.arange(n, dtype=np.float64)
    clean_spec = np.interp(idx, idx[valid], power[valid])
    env = _running_median_1d(clean_spec, half_width=16)
    ref = float(np.median(env))
    if ref <= 0.0:
        return [1.0] * n
    gains = np.sqrt(np.clip(env / ref, 0.0625, 16.0)).astype(np.float32)
    return [round(float(x), 6) for x in gains]


def compute_prewhitening_gains(
    channels: Sequence[RfiChannelItem | dict[str, Any]],
) -> tuple[list[float], list[float] | None, dict[str, Any]]:
    """Compute SB0 (and optional SB1) smooth passband gains from /rfi_mitigation/channels."""
    if not channels:
        raise ValueError("No RFI channel telemetry available for pre-whitening")

    items = sorted(
        (
            c if isinstance(c, RfiChannelItem) else RfiChannelItem.model_validate(c)
            for c in channels
        ),
        key=lambda c: c.freq_mhz,
    )

    sb0 = [c for c in items if c.subband == 0 and c.freq_mhz < 400.65]
    sb1 = [c for c in items if c.subband == 1 or c.freq_mhz >= 400.65]
    if not sb0 and len(items) >= N_CHAN_SUBBAND:
        sb0 = items[:N_CHAN_SUBBAND]
        sb1 = items[N_CHAN_SUBBAND:]

    def _arrays(group: list[RfiChannelItem]) -> tuple[np.ndarray, np.ndarray]:
        pwr = np.array([c.mean_power for c in group], dtype=np.float64)
        frac = np.array([c.flagged_chunk_fraction for c in group], dtype=np.float64)
        bits = np.array([c.flag_bits for c in group], dtype=np.int64)
        mad_z = np.array([c.freq_mad_z for c in group], dtype=np.float64)
        clean = (
            np.isfinite(pwr)
            & (pwr > 0.0)
            & (frac < 0.25)
            & ((bits & ~(RFI_TIME_BURST | RFI_MORPHOLOGY_SIR)) == 0)
            & (np.abs(mad_z) <= 4.0)
        )
        return pwr, clean

    pwr0, clean0 = _arrays(sb0)
    g_sb0 = _compute_subband_gains(pwr0, clean0)

    g_sb1: list[float] | None = None
    clean_count = int(np.sum(clean0))
    if sb1:
        pwr1, clean1 = _arrays(sb1)
        g_sb1 = _compute_subband_gains(pwr1, clean1)
        clean_count += int(np.sum(clean1))

    meta: dict[str, Any] = {
        "clean_channels": clean_count,
        "sb0_channels": len(g_sb0),
        "sb1_channels": len(g_sb1) if g_sb1 is not None else 0,
        "g_sb0_minmax": [round(min(g_sb0), 4), round(max(g_sb0), 4)] if g_sb0 else None,
        "g_sb1_minmax": [round(min(g_sb1), 4), round(max(g_sb1), 4)] if g_sb1 else None,
    }
    return g_sb0, g_sb1, meta
