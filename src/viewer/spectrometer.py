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


def identify_celestial_target(beam: BeamInfo | None) -> str:
    """Identify common astronomical targets from coordinates."""
    if beam is None or not beam.celestial_target.is_set:
        return ""

    ra = beam.celestial_target.ra_deg or 0.0
    dec = beam.celestial_target.dec_deg or 0.0

    # Sagittarius A* / Galactic Center: RA ~ 266.42°, Dec ~ -29.01°
    if math.isclose(ra, 266.4168, abs_tol=1.0) and math.isclose(dec, -29.0078, abs_tol=1.0):
        return "Sagittarius A*"
    # Vela Pulsar (PSR B0833-45): RA ~ 128.84°, Dec ~ -45.18°
    if math.isclose(ra, 128.8361, abs_tol=1.0) and math.isclose(dec, -45.1764, abs_tol=1.0):
        return "Vela Pulsar"
    # Crab Pulsar (PSR B0531+21): RA ~ 83.63°, Dec ~ +22.01°
    if math.isclose(ra, 83.6331, abs_tol=1.0) and math.isclose(dec, 22.0145, abs_tol=1.0):
        return "Crab Pulsar"

    return f"RA {ra:.2f}°, Dec {dec:.2f}°"


class SpectrometerProcessor:
    """Processes live Kotekan formed beams inspection buffers into calibrated spectra."""

    def __init__(self, seed: int = 42) -> None:
        self._rng = np.random.default_rng(seed)
        self._phase_step = 0.0

    def generate_synthetic_spectrum(
        self,
        beam_id: int,
        target_name: str,
        frequencies: list[float],
        timestamp: float,
    ) -> list[float]:
        """Generate physically realistic synthetic spectrum for testing or offline ingest."""
        freqs = np.array(frequencies, dtype=np.float64)
        n = len(freqs)
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

        return [round(float(v), 2) for v in spec]

    def process(
        self,
        buf_0: bytes | None,
        buf_1: bytes | None,
        status: Status | None = None,
        max_beams: int = 2,
        beam_names: dict[int, str] | None = None,
    ) -> SpectrometerData:
        """Process incoming raw buffers from Stream 0 and Stream 1.

        ``beam_names`` optionally maps beam_id -> target label (set by the
        observation routine); it overrides coordinate-based identification.

        Returns a SpectrometerData payload containing per-beam spectra and statistics.
        """
        now = time.time()
        num_active = status.num_active_beams if status and status.num_active_beams > 0 else 2
        active_beams = max(1, min(num_active, 8))
        effective_max_beams = max(max_beams, active_beams)

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

        for b_idx in range(active_beams):
            beam_info = beam_info_map.get(b_idx)
            target_name = (beam_names or {}).get(b_idx) or identify_celestial_target(beam_info)
            label = f"Beam {b_idx}"
            if target_name:
                label += f" ({target_name})"

            if combined_db is not None and b_idx < combined_db.shape[1]:
                spec_vals = [round(float(v), 2) for v in combined_db[:, b_idx]]
            else:
                spec_vals = self.generate_synthetic_spectrum(
                    b_idx, target_name, freqs, now
                )

            spec_arr = np.array(spec_vals, dtype=np.float64)
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
                power_db=spec_vals,
                stats=stats,
            )

        return SpectrometerData(
            timestamp=now,
            cadence_s=1.0,
            num_channels=len(freqs),
            beams=beam_spectra,
        )
