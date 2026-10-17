"""Line spectrometer processor for output formed beams.

Decimates / averages complex formed beam voltages from Kotekan inspection buffers
(restInspectFrame) into calibrated power spectra (dB vs MHz) at 1 Hz cadence.
Matches the architectural pattern used by charts_fengine web dashboard.
"""

from __future__ import annotations

import logging
import math
import time
from typing import Any

import numpy as np

from .models import (
    BeamInfo,
    BeamSpectrum,
    CorrelatorDiagnostics,
    ReferenceFringe,
    SkyGridFrame,
    SpectrometerData,
    Status,
)

logger = logging.getLogger(__name__)

# Frequency parameters matching CHARTS 64-Antenna direct tracker pipeline
CHANNELS_PER_STREAM: int = 336
FREQ_START_0_MHZ: float = 300.0
FREQ_START_1_MHZ: float = 400.8
FREQ_STEP_MHZ: float = 0.3
TOTAL_CHANNELS: int = 672

FREQUENCIES_0_MHZ: list[float] = np.round(
    FREQ_START_0_MHZ + np.arange(CHANNELS_PER_STREAM) * FREQ_STEP_MHZ, 2
).tolist()
FREQUENCIES_1_MHZ: list[float] = np.round(
    FREQ_START_1_MHZ + np.arange(CHANNELS_PER_STREAM) * FREQ_STEP_MHZ, 2
).tolist()
FREQUENCIES_ALL_MHZ: list[float] = FREQUENCIES_0_MHZ + FREQUENCIES_1_MHZ


def _precompute_unpack_astron_indices(num_elements: int = 64, polarizations: int = 2):
    tril_a, tril_b = np.tril_indices(num_elements, k=0)
    rec_a = tril_a // polarizations
    pol_a = tril_a % polarizations
    rec_b = tril_b // polarizations
    pol_b = tril_b % polarizations
    b_idx = rec_a * (rec_a + 1) // 2 + rec_b
    triu_a, triu_b = np.triu_indices(num_elements, k=1)
    diag_idx = np.diag_indices(num_elements)
    return tril_a, tril_b, b_idx, pol_a, pol_b, triu_a, triu_b, diag_idx


_TRIL_A, _TRIL_B, _TRIL_B_IDX, _TRIL_POL_A, _TRIL_POL_B, _TRIU_A, _TRIU_B, _DIAG_IDX = (
    _precompute_unpack_astron_indices(64, 2)
)


def unpack_astron_visibilities(
    raw_bytes: bytes | None,
    num_freq: int = CHANNELS_PER_STREAM,
    num_elements: int = 64,
) -> np.ndarray | None:
    """Unpack raw binary int32 correlation buffer from Kotekan integrated_correlation_buffer.

    Buffer shape in Kotekan is [num_freq, 528, 2, 2, 2] int32 (5,677,056 bytes).
    Unpacks into (num_freq, num_elements, num_elements) complex64 Hermitian matrix with real diagonal.
    """
    if not raw_bytes:
        return None

    num_receivers = num_elements // 2
    num_baselines = num_receivers * (num_receivers + 1) // 2
    expected_ints = num_freq * num_baselines * 2 * 2 * 2
    expected_bytes = expected_ints * 4

    if len(raw_bytes) < expected_bytes:
        return None

    try:
        raw_arr = np.frombuffer(raw_bytes[:expected_bytes], dtype=np.int32)
        packed = raw_arr.reshape((num_freq, num_baselines, 2, 2, 2))
        c_data = (
            packed[..., 0].astype(np.float32) + 1j * packed[..., 1].astype(np.float32)
        ).astype(np.complex64)

        if num_elements == 64:
            tril_a, tril_b, b_idx, pol_a, pol_b, triu_a, triu_b, diag_idx = (
                _TRIL_A,
                _TRIL_B,
                _TRIL_B_IDX,
                _TRIL_POL_A,
                _TRIL_POL_B,
                _TRIU_A,
                _TRIU_B,
                _DIAG_IDX,
            )
        else:
            tril_a, tril_b, b_idx, pol_a, pol_b, triu_a, triu_b, diag_idx = (
                _precompute_unpack_astron_indices(num_elements, 2)
            )

        vis = np.empty((num_freq, num_elements, num_elements), dtype=np.complex64)
        vis[:, tril_a, tril_b] = c_data[:, b_idx, pol_a, pol_b]
        vis[:, triu_a, triu_b] = np.conj(vis[:, triu_b, triu_a])
        vis[:, diag_idx[0], diag_idx[1]] = vis[:, diag_idx[0], diag_idx[1]].real.astype(
            np.complex64
        )
        return vis
    except Exception as exc:
        logger.debug("Failed to unpack astron visibilities: %s", exc)
        return None


def compute_correlator_diagnostics(
    vis_cube: np.ndarray | None = None,
    subband_0: np.ndarray | None = None,
    subband_1: np.ndarray | None = None,
    reference_antennas: list[int] | tuple[int, ...] = (0, 4, 6, 8, 32),
    timestamp: float | None = None,
) -> CorrelatorDiagnostics:
    """Compute correlator diagnostic products from complex visibility matrices.

    - 672-ch bandpass dB (average auto-correlations across antennas)
    - 64x64 correlation amplitude matrix: mean(|V|) across frequency
    - 64x64 correlation phase matrix: mean(angle(V)) across frequency
    - Reference baseline fringes between antenna 0 and antennas [0, 4, 6, 8, 32]
    """
    if vis_cube is None:
        if subband_0 is not None and subband_1 is not None:
            vis_cube = np.concatenate([subband_0, subband_1], axis=0)
        elif subband_0 is not None:
            vis_cube = subband_0
        elif subband_1 is not None:
            vis_cube = subband_1
        else:
            # Generate synthetic Hermitian visibility cube: (672, 64, 64)
            rng = np.random.default_rng(1234)
            n_f = TOTAL_CHANNELS
            n_e = 64
            re = rng.normal(0.0, 1.0, size=(n_f, n_e, n_e)).astype(np.float32)
            im = rng.normal(0.0, 1.0, size=(n_f, n_e, n_e)).astype(np.float32)
            syn = re + 1j * im
            vis_cube = ((syn + syn.swapaxes(1, 2).conj()) * 0.5).astype(np.complex64)
            freq_profile = (
                25.0 + 5.0 * np.sin(2 * np.pi * np.arange(n_f) / 100.0)[:, None]
            )
            diag_idx = np.diag_indices(n_e)
            vis_cube[:, diag_idx[0], diag_idx[1]] = (
                freq_profile + rng.uniform(0.5, 2.0, size=(n_f, n_e))
            ).astype(np.complex64)

    num_channels = vis_cube.shape[0]
    num_elements = vis_cube.shape[1]

    # Auto-correlations: diagonal of each frequency slice
    diag = np.diagonal(vis_cube, axis1=1, axis2=2).real
    auto_power = np.mean(diag, axis=1)
    bandpass_db = np.round(power_to_db(auto_power), 2).tolist()

    # 64x64 amplitude and phase matrices
    amp_mat = np.round(np.mean(np.abs(vis_cube), axis=0), 3).tolist()
    phase_mat = np.round(np.mean(np.angle(vis_cube), axis=0), 3).tolist()

    # Reference fringes between antenna 0 and specified reference antennas
    fringes: dict[int, ReferenceFringe] = {}
    for ant in reference_antennas:
        if 0 <= ant < num_elements:
            f_vis = vis_cube[:, 0, ant]
            fringes[ant] = ReferenceFringe(
                antenna_a=0,
                antenna_b=ant,
                amplitude=np.round(np.abs(f_vis), 3).tolist(),
                phase_rad=np.round(np.angle(f_vis), 3).tolist(),
                real=np.round(f_vis.real, 3).tolist(),
                imag=np.round(f_vis.imag, 3).tolist(),
            )

    return CorrelatorDiagnostics(
        timestamp=timestamp or time.time(),
        num_channels=num_channels,
        num_elements=num_elements,
        bandpass_db=bandpass_db,
        amplitude_matrix=amp_mat,
        phase_matrix=phase_mat,
        reference_fringes=fringes,
    )


def format_sky_grid_frame(
    beam_powers: np.ndarray | list[float] | list[list[float]] | None,
    grid_step_rad: float = 0.02,
    timestamp: float | None = None,
) -> SkyGridFrame:
    """Format 16 beam powers into a 4x4 (l, m) directional cosine grid with centroid detection."""
    l_coords = np.round((np.arange(4) - 1.5) * grid_step_rad, 4).tolist()
    m_coords = np.round((np.arange(4) - 1.5) * grid_step_rad, 4).tolist()

    if beam_powers is None:
        rng = np.random.default_rng(42)
        base = rng.uniform(4.0, 7.0, size=16).astype(np.float32)
        base[5] += 38.5
        base[6] += 12.0
        base[1] += 8.0
        powers_1d = base
        spectra_list: list[list[float]] = []
    else:
        arr = np.asarray(beam_powers, dtype=np.float32)
        if arr.ndim == 2:
            spectra_list = np.round(arr, 2).tolist()
            powers_1d = np.mean(arr, axis=-1)
        elif arr.ndim == 1:
            spectra_list = []
            powers_1d = arr
        else:
            spectra_list = []
            powers_1d = arr.flatten()

    if len(powers_1d) < 16:
        padded = np.zeros(16, dtype=np.float32)
        padded[: len(powers_1d)] = powers_1d
        powers_1d = padded
    elif len(powers_1d) > 16:
        powers_1d = powers_1d[:16]

    grid_4x4 = powers_1d.reshape((4, 4))
    peak_idx = int(np.argmax(powers_1d))
    peak_power = float(powers_1d[peak_idx])

    # Power-weighted centroid coordinates
    w = np.maximum(powers_1d, 0.0)
    w_sum = float(np.sum(w))
    if w_sum > 1e-9:
        j_col = np.tile(np.arange(4), 4)
        i_row = np.repeat(np.arange(4), 4)
        l_all = (j_col - 1.5) * grid_step_rad
        m_all = (i_row - 1.5) * grid_step_rad
        centroid_l = float(np.sum(w * l_all) / w_sum)
        centroid_m = float(np.sum(w * m_all) / w_sum)
    else:
        centroid_l = 0.0
        centroid_m = 0.0

    return SkyGridFrame(
        timestamp=timestamp or time.time(),
        grid_step_rad=grid_step_rad,
        grid_power=np.round(grid_4x4, 3).tolist(),
        beam_powers=np.round(powers_1d, 3).tolist(),
        peak_beam_id=peak_idx,
        peak_power=round(peak_power, 3),
        centroid_l=round(centroid_l, 4),
        centroid_m=round(centroid_m, 4),
        l_coords=l_coords,
        m_coords=m_coords,
        beam_power_spectra=spectra_list,
    )


def unpack_formed_beams(
    raw_bytes: bytes | None,
    num_freq: int = CHANNELS_PER_STREAM,
    max_beams: int = 2,
) -> np.ndarray | None:
    """Unpack raw binary float2 (complex64) from Kotekan formed beams buffer.

    Buffer shape in Kotekan is [time, freq, max_beams] of complex float (8 bytes per sample).
    """
    if not raw_bytes or len(raw_bytes) < 8:
        return None

    bytes_per_time = num_freq * max_beams * 8
    n_time = len(raw_bytes) // bytes_per_time
    if n_time <= 0:
        return None

    try:
        valid_bytes = n_time * bytes_per_time
        arr = np.frombuffer(raw_bytes[:valid_bytes], dtype=np.complex64)
        return arr.reshape((n_time, num_freq, max_beams))
    except Exception as exc:
        logger.debug("Failed to unpack formed beams buffer: %s", exc)
        return None


def compute_power_spectrum(
    formed_voltages: np.ndarray,
) -> np.ndarray:
    """Average instantaneous power |V|^2 across time samples.

    Returns power array of shape (num_freq, max_beams).
    """
    # |V|^2 = V_real^2 + V_imag^2
    power = np.mean(formed_voltages.real**2 + formed_voltages.imag**2, axis=0)
    return power


def power_to_db(power: np.ndarray, floor_db: float = -60.0) -> np.ndarray:
    """Convert linear power to decibels with floor clipping."""
    p_safe = np.maximum(power, 1e-12)
    db = 10.0 * np.log10(p_safe)
    return np.maximum(db, floor_db)


KNOWN_CELESTIAL_TARGETS: tuple[tuple[str, float, float], ...] = (
    ("Sagittarius A*", 266.4168, -29.0078),
    ("Vela Pulsar", 128.8361, -45.1764),
    ("Crab Pulsar", 83.6331, 22.0145),
    ("NGC 1316 (Fornax A)", 50.6750, -37.2083),
    ("PSR B0826-34", 127.0417, -34.2900),
    ("NGC 253 (Sculptor)", 11.8875, -25.2883),
    ("Fornax Cluster Core", 54.6208, -35.4508),
    ("Centaurus A", 201.3667, -43.0192),
    ("The Antennae", 180.4708, -18.8694),
    ("Pictor A", 79.7500, -45.7667),
    ("Hydra A", 139.5000, -12.0833),
    ("NGC 612", 23.4917, -36.4933),
)


def identify_celestial_target(
    beam: BeamInfo | None,
    catalog_targets: list[Any] | None = None,
) -> str:
    """Identify common astronomical targets from coordinates."""
    if beam is None or not beam.celestial_target.is_set:
        return ""

    ra = beam.celestial_target.ra_deg or 0.0
    dec = beam.celestial_target.dec_deg or 0.0

    if catalog_targets:
        for tgt in catalog_targets:
            tgt_ra = getattr(tgt, "ra_deg", None)
            tgt_dec = getattr(tgt, "dec_deg", None)
            tgt_label = getattr(tgt, "label", None)
            if tgt_ra is not None and tgt_dec is not None and tgt_label:
                if math.isclose(ra, tgt_ra, abs_tol=1.0) and math.isclose(
                    dec, tgt_dec, abs_tol=1.0
                ):
                    return str(tgt_label)

    for name, target_ra, target_dec in KNOWN_CELESTIAL_TARGETS:
        if math.isclose(ra, target_ra, abs_tol=1.0) and math.isclose(
            dec, target_dec, abs_tol=1.0
        ):
            return name

    return f"RA {ra:.2f}°, Dec {dec:.2f}°"


class SpectrometerProcessor:
    """Processes live Kotekan formed beams inspection buffers into calibrated spectra."""

    def __init__(self, seed: int = 42) -> None:
        self._rng = np.random.default_rng(seed)
        self._phase_step = 0.0

    def generate_synthetic_spectrum_array(
        self,
        beam_id: int,
        target_name: str,
        freqs: np.ndarray,
    ) -> np.ndarray:
        """Generate synthetic spectrum directly as a rounded 1D numpy array."""
        n = freqs.size
        self._phase_step += 0.08

        # Noise floor: -28 dB with channel ripples
        noise = self._rng.normal(0.0, 0.45, size=n)
        standing_wave = 0.7 * np.sin(2.0 * np.pi * (freqs - 300.0) / 18.5)
        base_db = -28.0 + standing_wave + noise

        # Astronomical emission profile
        if "Sagittarius" in target_name or beam_id == 0:
            # Sgr A* synchrotron continuum with synchrotron self-absorption & spectral index
            f_norm = (freqs - 300.0) / 200.0
            continuum = 14.5 * np.exp(-((f_norm - 0.45) ** 2) / 0.12)
            # Recombination line / spectral features
            lines = 2.8 * np.exp(-((freqs - 327.4) ** 2) / 1.2) + 2.1 * np.exp(
                -((freqs - 408.0) ** 2) / 1.8
            )
            spec = base_db + continuum + lines
        elif "Vela" in target_name or beam_id == 1:
            # Vela Pulsar interstellar scintillation arches and steep spectral index
            scint_pattern = 1.8 * np.sin(2.0 * np.pi * freqs / 12.0 + self._phase_step)
            pulsar_peak = 13.2 * np.exp(-((freqs - 410.0) ** 2) / 600.0)
            spec = base_db + pulsar_peak + scint_pattern
        else:
            # Generic steered beam
            center_mhz = 350.0 + (beam_id * 35.0) % 120.0
            peak = 9.0 * np.exp(-((freqs - center_mhz) ** 2) / 400.0)
            spec = base_db + peak

        return np.round(spec, 2)

    def generate_synthetic_spectrum(
        self,
        beam_id: int,
        target_name: str,
        frequencies: list[float],
        timestamp: float = 0.0,
    ) -> list[float]:
        """Backwards-compatible wrapper returning list[float]."""
        freqs = np.asarray(frequencies, dtype=np.float64)
        return self.generate_synthetic_spectrum_array(
            beam_id, target_name, freqs
        ).tolist()

    def process(
        self,
        buf_0: bytes | None = None,
        buf_1: bytes | None = None,
        status: Status | None = None,
        max_beams: int = 2,
        beam_names: dict[int, str] | None = None,
        cadence_s: float = 1.0,
        direct_beam_power: list[list[float]] | np.ndarray | None = None,
    ) -> SpectrometerData:
        """Process incoming raw buffers or reduced beam power from Stream 0 and Stream 1.

        ``beam_names`` optionally maps beam_id -> target label (set by the
        observation routine); it overrides coordinate-based identification.

        Returns a SpectrometerData payload containing per-beam spectra and statistics.
        """
        now = time.time()
        num_active = (
            status.num_active_beams if status and status.num_active_beams > 0 else 2
        )
        active_beams = max(1, min(num_active, 16))
        configured_beams = len(status.beams) if (status and status.beams) else max_beams
        effective_max_beams = max(max_beams, configured_beams, active_beams)

        # 1. Attempt to use direct_beam_power from zero-disk pipeline if available
        combined_db = None
        freqs = FREQUENCIES_ALL_MHZ

        if direct_beam_power is not None:
            try:
                arr_pow = np.asarray(direct_beam_power, dtype=np.float32)
                if arr_pow.ndim == 2 and arr_pow.size > 0:
                    # In Kotekan contract, shape is [max_beams][672]
                    if arr_pow.shape[1] == TOTAL_CHANNELS:
                        combined_p = arr_pow.T  # (672, max_beams)
                        combined_db = power_to_db(combined_p)
                        freqs = FREQUENCIES_ALL_MHZ
                    elif arr_pow.shape[0] == TOTAL_CHANNELS:
                        combined_db = power_to_db(arr_pow)
                        freqs = FREQUENCIES_ALL_MHZ
            except Exception as exc:
                logger.debug("Failed to process direct_beam_power: %s", exc)

        # 2. If no direct_beam_power, attempt to unpack raw voltage buffers
        if combined_db is None:
            arr_0 = unpack_formed_beams(buf_0, CHANNELS_PER_STREAM, effective_max_beams)
            arr_1 = unpack_formed_beams(buf_1, CHANNELS_PER_STREAM, effective_max_beams)

            p_0 = compute_power_spectrum(arr_0) if arr_0 is not None else None
            p_1 = compute_power_spectrum(arr_1) if arr_1 is not None else None

            has_real_0 = p_0 is not None and np.max(p_0) > 1e-9
            has_real_1 = p_1 is not None and np.max(p_1) > 1e-9

            if has_real_0 and has_real_1:
                combined_p = np.concatenate([p_0, p_1], axis=0)  # (672, max_beams)
                combined_db = power_to_db(combined_p)
                freqs = FREQUENCIES_ALL_MHZ
            elif has_real_0:
                combined_db = power_to_db(p_0)
                freqs = FREQUENCIES_0_MHZ
            elif has_real_1:
                combined_db = power_to_db(p_1)
                freqs = FREQUENCIES_1_MHZ

        # Target metadata mapping from Status
        beam_info_map: dict[int, BeamInfo] = {}
        if status:
            for b in status.beams:
                beam_info_map[b.beam_id] = b

        beam_spectra: dict[int, BeamSpectrum] = {}

        if combined_db is not None:
            combined_db = np.round(combined_db, 2)
        freqs_arr = np.asarray(freqs, dtype=np.float64)

        for b_idx in range(active_beams):
            beam_info = beam_info_map.get(b_idx)
            target_name = (beam_names or {}).get(b_idx) or identify_celestial_target(
                beam_info
            )
            label = f"Beam {b_idx}"
            if target_name:
                label += f" ({target_name})"

            if combined_db is not None and b_idx < combined_db.shape[1]:
                spec_arr = combined_db[:, b_idx]
            else:
                spec_arr = self.generate_synthetic_spectrum_array(
                    b_idx, target_name, freqs_arr
                )

            peak_idx = int(np.argmax(spec_arr))
            stats = {
                "min": float(np.round(np.min(spec_arr), 2)),
                "max": float(np.round(np.max(spec_arr), 2)),
                "mean": float(np.round(np.mean(spec_arr), 2)),
                "peak_freq_mhz": freqs[peak_idx] if peak_idx < len(freqs) else freqs[0],
                "peak_power_db": float(np.round(spec_arr[peak_idx], 2)),
            }

            beam_spectra[b_idx] = BeamSpectrum(
                beam_id=b_idx,
                label=label,
                target_name=target_name or None,
                frequencies_mhz=freqs,
                power_db=spec_arr.tolist(),
                stats=stats,
            )

        return SpectrometerData(
            timestamp=now,
            cadence_s=cadence_s,
            num_channels=len(freqs),
            frequencies_mhz=freqs,
            beams=beam_spectra,
        )
