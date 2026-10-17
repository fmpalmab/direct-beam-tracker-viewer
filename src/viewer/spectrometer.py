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


def compute_correlator_telemetry(
    vis_cube: np.ndarray,
    zero_diag: bool = True,
    masked_antennas: set[int] | None = None,
) -> dict[str, Any]:
    """Compute band-averaged coherence |Gamma_ij|, fringe phase, and auto-power dB from (F, 64, 64) cube."""
    if vis_cube.ndim == 3:
        # Incoherent magnitude average across channels prevents delay fringe-washing
        abs_mean = np.mean(np.abs(vis_cube), axis=0)  # (64, 64)
        auto = np.mean(np.diagonal(vis_cube, axis1=1, axis2=2).real, axis=0)  # (64,)
        # Subband-center phase snapshot for clean spatial phase structure
        mid_f = vis_cube.shape[0] // 2
        phase_rad = np.angle(np.mean(vis_cube[max(0, mid_f - 4) : mid_f + 4], axis=0))
    else:
        abs_mean = np.abs(vis_cube)
        auto = np.real(np.diag(vis_cube))
        phase_rad = np.angle(vis_cube)

    denom = np.sqrt(np.outer(np.maximum(auto, 1e-12), np.maximum(auto, 1e-12))) + 1e-12
    coherence = np.clip(abs_mean / denom, 0.0, 1.0)
    if zero_diag:
        np.fill_diagonal(coherence, 0.0)
        np.fill_diagonal(phase_rad, 0.0)

    if masked_antennas:
        for m_idx in masked_antennas:
            if 0 <= m_idx < coherence.shape[0]:
                coherence[m_idx, :] = 0.0
                coherence[:, m_idx] = 0.0
                phase_rad[m_idx, :] = 0.0
                phase_rad[:, m_idx] = 0.0

    return {
        "coherence": np.round(coherence, 4).tolist(),
        "phase": np.round(phase_rad, 3).tolist(),
        "auto_db": np.round(10.0 * np.log10(np.maximum(auto, 1e-12)), 2).tolist(),
    }


def compute_correlator_diagnostics(
    vis_cube: np.ndarray | None = None,
    subband_0: np.ndarray | None = None,
    subband_1: np.ndarray | None = None,
    reference_antennas: list[int] | tuple[int, ...] = (0, 4, 6, 8, 32),
    timestamp: float | None = None,
    masked_antennas: set[int] | None = None,
) -> CorrelatorDiagnostics:
    """Compute correlator diagnostic products from complex visibility matrices."""
    if vis_cube is None:
        if subband_0 is not None and subband_1 is not None:
            vis_cube = np.concatenate([subband_0, subband_1], axis=0)
        elif subband_0 is not None:
            vis_cube = subband_0
        elif subband_1 is not None:
            vis_cube = subband_1
        else:
            # Realistic synthetic 8x8 phased-array visibility cube: (672, 64, 64)
            rng = np.random.default_rng(1234)
            n_f = TOTAL_CHANNELS
            n_e = 64
            freqs_ghz = (300.0 + np.arange(n_f, dtype=np.float32) * 0.3) * 1e-3  # GHz

            # 8x8 tile coordinates and geometric delay for a point source off-zenith
            ant_idx = np.arange(n_e, dtype=np.float32)
            ax = (ant_idx % 8) - 3.5
            ay = (ant_idx // 8) - 3.5
            tau_ant_ns = 0.42 * ax + 0.28 * ay  # Geometric delay per antenna (ns)

            # Baseline delay matrix (64, 64) and spatial coherence envelope
            dtau_ns = tau_ant_ns[:, None] - tau_ant_ns[None, :]
            dist_tiles = np.sqrt((ax[:, None] - ax[None, :]) ** 2 + (ay[:, None] - ay[None, :]) ** 2)
            spatial_coh = 0.72 * np.exp(-0.18 * dist_tiles) + 0.08

            # Auto-power bandpass shape (~25 linear -> ~14 dB)
            bp_shape = (24.0 + 5.5 * np.sin(2.0 * np.pi * np.arange(n_f, dtype=np.float32) / 110.0))[:, None]
            ant_gains = rng.uniform(0.85, 1.15, size=(1, n_e)).astype(np.float32)
            auto_f = bp_shape * ant_gains  # (672, 64)

            # Complex visibilities with linear phase slope across frequency
            phase_cube = 2.0 * np.pi * (freqs_ghz[:, None, None] - 0.3) * dtau_ns[None, :, :]
            amp_cube = np.sqrt(auto_f[:, :, None] * auto_f[:, None, :]) * spatial_coh[None, :, :]
            noise = (
                rng.normal(0.0, 0.8, size=(n_f, n_e, n_e)).astype(np.float32)
                + 1j * rng.normal(0.0, 0.8, size=(n_f, n_e, n_e)).astype(np.float32)
            )
            noise = 0.5 * (noise + noise.swapaxes(1, 2).conj())
            vis_cube = (amp_cube * np.exp(1j * phase_cube) + noise).astype(np.complex64)
            diag_idx = np.diag_indices(n_e)
            vis_cube[:, diag_idx[0], diag_idx[1]] = auto_f.astype(np.complex64)

    num_channels = vis_cube.shape[0]
    num_elements = vis_cube.shape[1]

    # Auto-correlations: diagonal of each frequency slice
    diag = np.diagonal(vis_cube, axis1=1, axis2=2).real.copy()
    if masked_antennas:
        for m_idx in masked_antennas:
            if 0 <= m_idx < num_elements:
                diag[:, m_idx] = 1e-6

    auto_power = np.mean(diag, axis=1)
    bandpass_db = np.round(power_to_db(auto_power), 2).tolist()

    # 64x64 amplitude, phase, and normalized coherence matrices
    corr_telemetry = compute_correlator_telemetry(
        vis_cube, zero_diag=True, masked_antennas=masked_antennas
    )
    amp_mat_arr = np.mean(np.abs(vis_cube), axis=0)
    np.fill_diagonal(amp_mat_arr, 0.0)
    if masked_antennas:
        for m_idx in masked_antennas:
            if 0 <= m_idx < num_elements:
                amp_mat_arr[m_idx, :] = 0.0
                amp_mat_arr[:, m_idx] = 0.0

    amp_mat = np.round(amp_mat_arr, 3).tolist()
    phase_mat = corr_telemetry["phase"]
    coherence_mat = corr_telemetry["coherence"]
    auto_db_list = corr_telemetry["auto_db"]

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

    # Per-antenna auto-correlation spectra (dB vs channel)
    diag_clean = np.maximum(diag, 1e-6)
    full_spectra_db = power_to_db(diag_clean)  # shape (num_channels, num_elements)
    full_antenna_spectra_db = np.round(full_spectra_db.T, 2).tolist()

    # 84-point decimated spectra for compact real-time 8x8 streaming
    num_bins = 84
    bin_sz = num_channels // num_bins
    if bin_sz > 1:
        mini_spectra = (
            full_spectra_db[: num_bins * bin_sz]
            .reshape(num_bins, bin_sz, num_elements)
            .mean(axis=1)
            .T
        )
        antenna_spectra_db = np.round(mini_spectra, 1).tolist()
    else:
        antenna_spectra_db = np.round(full_spectra_db.T, 1).tolist()

    return CorrelatorDiagnostics(
        timestamp=timestamp or time.time(),
        num_channels=num_channels,
        num_elements=num_elements,
        bandpass_db=bandpass_db,
        amplitude_matrix=amp_mat,
        phase_matrix=phase_mat,
        coherence_matrix=coherence_mat,
        auto_db=auto_db_list,
        reference_fringes=fringes,
        antenna_spectra_db=antenna_spectra_db,
        full_antenna_spectra_db=full_antenna_spectra_db,
    )


def format_sky_grid_frame(
    beam_powers: np.ndarray | list[float] | list[list[float]] | None,
    grid_step_rad: float = 0.02,
    timestamp: float | None = None,
) -> SkyGridFrame:
    """Format 16 beam powers into a 4x4 (l, m) directional cosine grid with centroid detection."""
    l_coords = np.round((np.arange(4) - 1.5) * grid_step_rad, 4).tolist()
    m_coords = np.round((np.arange(4) - 1.5) * grid_step_rad, 4).tolist()
    t_now = timestamp or time.time()
    phase_drift = (t_now % 60.0) * 0.35

    if beam_powers is None:
        rng = np.random.default_rng()
        base = np.array(
            [-28.0, -24.5, -26.0, -29.0, -25.0, -6.5, -14.0, -26.5, -27.0, -18.0, -22.0, -28.0, -29.5, -27.5, -28.5, -30.0],
            dtype=np.float32,
        )
        powers_1d = base + rng.normal(0.0, 0.35, size=16).astype(np.float32)
        f_axis = np.linspace(0, 3 * np.pi, 168)
        band_shape = 2.5 * np.sin(f_axis + phase_drift * 0.2) + 1.2 * np.cos(f_axis * 2.5)
        spectra_list = [
            np.round(powers_1d[b] + band_shape + rng.normal(0, 0.6, 168), 2).tolist()
            for b in range(16)
        ]
    else:
        arr = np.asarray(beam_powers, dtype=np.float32)
        # Convert linear power from Kotekan to dB if values are strictly non-negative and exceed dB range or are small linear floats
        if arr.size > 0 and np.min(arr) >= 0.0 and (np.max(arr) > 100.0 or np.max(arr) < 1.0):
            arr = power_to_db(arr, floor_db=-50.0)

        if arr.ndim == 2:
            # Downsample 672 -> 168 if needed for lightweight 4 Hz WebSocket transport
            if arr.shape[1] == 672:
                arr_168 = arr.reshape(arr.shape[0], 168, 4).mean(axis=-1)
            else:
                arr_168 = arr
            spectra_list = np.round(arr_168, 2).tolist()
            powers_1d = np.mean(arr_168, axis=-1)
        else:
            powers_1d = arr.flatten()
            f_axis = np.linspace(0, 3 * np.pi, 168)
            band_shape = 2.5 * np.sin(f_axis + phase_drift * 0.2)
            rng = np.random.default_rng()
            spectra_list = [
                np.round(powers_1d[b] + band_shape + rng.normal(0, 0.45, 168), 2).tolist()
                for b in range(min(16, len(powers_1d)))
            ]

    if len(powers_1d) < 16:
        padded = np.full(16, -30.0, dtype=np.float32)
        padded[: len(powers_1d)] = powers_1d
        powers_1d = padded
    elif len(powers_1d) > 16:
        powers_1d = powers_1d[:16]

    if len(spectra_list) < 16:
        rng = np.random.default_rng()
        f_axis = np.linspace(0, 3 * np.pi, 168)
        while len(spectra_list) < 16:
            b_idx = len(spectra_list)
            p = float(powers_1d[b_idx])
            spectra_list.append(
                np.round(p + 2.0 * np.sin(f_axis) + rng.normal(0, 0.4, 168), 2).tolist()
            )

    grid_4x4 = powers_1d.reshape((4, 4))
    peak_idx = int(np.argmax(powers_1d))
    peak_power = float(powers_1d[peak_idx])

    # Linear-power-weighted centroid coordinates
    lin_w = np.power(10.0, np.clip(powers_1d, -60.0, 50.0) / 10.0)
    w_sum = float(np.sum(lin_w))
    if w_sum > 1e-12:
        j_col = np.tile(np.arange(4), 4)
        i_row = np.repeat(np.arange(4), 4)
        l_all = (j_col - 1.5) * grid_step_rad
        m_all = (i_row - 1.5) * grid_step_rad
        centroid_l = float(np.sum(lin_w * l_all) / w_sum)
        centroid_m = float(np.sum(lin_w * m_all) / w_sum)
    else:
        centroid_l = 0.0
        centroid_m = 0.0

    return SkyGridFrame(
        timestamp=t_now,
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
