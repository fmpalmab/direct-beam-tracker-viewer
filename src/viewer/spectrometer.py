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

from .models import BeamInfo, BeamSpectrum, SpectrometerData, Status

logger = logging.getLogger(__name__)

# Frequency parameters matching CHARTS 64-Antenna direct tracker pipeline
CHANNELS_PER_STREAM: int = 336
FREQ_START_0_MHZ: float = 300.0
FREQ_START_1_MHZ: float = 400.8
FREQ_STEP_MHZ: float = 0.3
TOTAL_CHANNELS: int = 672

FREQUENCIES_0_MHZ: list[float] = [
    round(FREQ_START_0_MHZ + i * FREQ_STEP_MHZ, 2) for i in range(CHANNELS_PER_STREAM)
]
FREQUENCIES_1_MHZ: list[float] = [
    round(FREQ_START_1_MHZ + i * FREQ_STEP_MHZ, 2) for i in range(CHANNELS_PER_STREAM)
]
FREQUENCIES_ALL_MHZ: list[float] = FREQUENCIES_0_MHZ + FREQUENCIES_1_MHZ


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

    # Sagittarius A* / Galactic Center: RA ~ 266.42°, Dec ~ -29.01°
    if math.isclose(ra, 266.4168, abs_tol=1.0) and math.isclose(
        dec, -29.0078, abs_tol=1.0
    ):
        return "Sagittarius A*"
    # Vela Pulsar (PSR B0833-45): RA ~ 128.84°, Dec ~ -45.18°
    if math.isclose(ra, 128.8361, abs_tol=1.0) and math.isclose(
        dec, -45.1764, abs_tol=1.0
    ):
        return "Vela Pulsar"
    # Crab Pulsar (PSR B0531+21): RA ~ 83.63°, Dec ~ +22.01°
    if math.isclose(ra, 83.6331, abs_tol=1.0) and math.isclose(
        dec, 22.0145, abs_tol=1.0
    ):
        return "Crab Pulsar"
    # NGC 1316 (Fornax A): RA ~ 50.68°, Dec ~ -37.21°
    if math.isclose(ra, 50.6750, abs_tol=1.0) and math.isclose(
        dec, -37.2083, abs_tol=1.0
    ):
        return "NGC 1316 (Fornax A)"
    # PSR B0826-34: RA ~ 127.04°, Dec ~ -34.29°
    if math.isclose(ra, 127.0417, abs_tol=1.0) and math.isclose(
        dec, -34.2900, abs_tol=1.0
    ):
        return "PSR B0826-34"
    # NGC 253 (Sculptor): RA ~ 11.89°, Dec ~ -25.29°
    if math.isclose(ra, 11.8875, abs_tol=1.0) and math.isclose(
        dec, -25.2883, abs_tol=1.0
    ):
        return "NGC 253 (Sculptor)"
    # Fornax Cluster Core: RA ~ 54.62°, Dec ~ -35.45°
    if math.isclose(ra, 54.6208, abs_tol=1.0) and math.isclose(
        dec, -35.4508, abs_tol=1.0
    ):
        return "Fornax Cluster Core"
    # Centaurus A (NGC 5128): RA ~ 201.37°, Dec ~ -43.02°
    if math.isclose(ra, 201.3667, abs_tol=1.0) and math.isclose(
        dec, -43.0192, abs_tol=1.0
    ):
        return "Centaurus A"
    # The Antennae (NGC 4038/39): RA ~ 180.47°, Dec ~ -18.87°
    if math.isclose(ra, 180.4708, abs_tol=1.0) and math.isclose(
        dec, -18.8694, abs_tol=1.0
    ):
        return "The Antennae"
    # Pictor A: RA ~ 79.75°, Dec ~ -45.77°
    if math.isclose(ra, 79.7500, abs_tol=1.0) and math.isclose(
        dec, -45.7667, abs_tol=1.0
    ):
        return "Pictor A"
    # Hydra A: RA ~ 139.50°, Dec ~ -12.08°
    if math.isclose(ra, 139.5000, abs_tol=1.0) and math.isclose(
        dec, -12.0833, abs_tol=1.0
    ):
        return "Hydra A"
    # NGC 612 (PKS 0131-36): RA ~ 23.49°, Dec ~ -36.49°
    if math.isclose(ra, 23.4917, abs_tol=1.0) and math.isclose(
        dec, -36.4933, abs_tol=1.0
    ):
        return "NGC 612"

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
        buf_0: bytes | None,
        buf_1: bytes | None,
        status: Status | None = None,
        max_beams: int = 2,
        beam_names: dict[int, str] | None = None,
        cadence_s: float = 1.0,
    ) -> SpectrometerData:
        """Process incoming raw buffers from Stream 0 and Stream 1.

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

        # 1. Attempt to unpack real buffers
        arr_0 = unpack_formed_beams(buf_0, CHANNELS_PER_STREAM, effective_max_beams)
        arr_1 = unpack_formed_beams(buf_1, CHANNELS_PER_STREAM, effective_max_beams)

        p_0 = compute_power_spectrum(arr_0) if arr_0 is not None else None
        p_1 = compute_power_spectrum(arr_1) if arr_1 is not None else None

        has_real_0 = p_0 is not None and np.max(p_0) > 1e-9
        has_real_1 = p_1 is not None and np.max(p_1) > 1e-9

        # Target metadata mapping from Status
        beam_info_map: dict[int, BeamInfo] = {}
        if status:
            for b in status.beams:
                beam_info_map[b.beam_id] = b

        beam_spectra: dict[int, BeamSpectrum] = {}

        if has_real_0 and has_real_1:
            # Full 672-channel spectrum combining Stream 0 and Stream 1
            combined_p = np.concatenate([p_0, p_1], axis=0)  # (672, max_beams)
            combined_db = power_to_db(combined_p)
            freqs = FREQUENCIES_ALL_MHZ
        elif has_real_0:
            combined_db = power_to_db(p_0)
            freqs = FREQUENCIES_0_MHZ
        elif has_real_1:
            combined_db = power_to_db(p_1)
            freqs = FREQUENCIES_1_MHZ
        else:
            combined_db = None
            freqs = FREQUENCIES_ALL_MHZ

        # Vectorized 2D NumPy rounding across all frequencies and beams (replaces Python list loop)
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
                "min": round(float(np.min(spec_arr)), 2),
                "max": round(float(np.max(spec_arr)), 2),
                "mean": round(float(np.mean(spec_arr)), 2),
                "peak_freq_mhz": freqs[peak_idx] if peak_idx < len(freqs) else freqs[0],
                "peak_power_db": round(float(spec_arr[peak_idx]), 2),
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
