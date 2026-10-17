"""Data models and request validation for the direct beam tracker viewer."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator


class CelestialTarget(BaseModel):
    model_config = ConfigDict(extra="ignore")

    is_set: bool = False
    ra_deg: float | None = None
    dec_deg: float | None = None


class BeamInfo(BaseModel):
    model_config = ConfigDict(extra="ignore")

    beam_id: int
    l0: float = 0.0
    m0: float = 0.0
    n0: float = 0.0
    grid_index: int = 0
    celestial_target: CelestialTarget = Field(default_factory=CelestialTarget)


class Status(BaseModel):
    model_config = ConfigDict(extra="ignore")

    active_antennas: int = 0
    active_raw_elements: list[int] = Field(default_factory=list)
    num_active_beams: int = 0
    subframe_interpolation_enabled: bool = False
    beams: list[BeamInfo] = Field(default_factory=list)


class BeamSample(BaseModel):
    ts: float
    l0: float
    m0: float


class BeamSpectrum(BaseModel):
    model_config = ConfigDict(extra="ignore")

    beam_id: int
    label: str
    target_name: str | None = None
    frequencies_mhz: list[float] = Field(default_factory=list)
    power_db: list[float] = Field(default_factory=list)
    stats: dict[str, float] = Field(default_factory=dict)


class SpectrometerData(BaseModel):
    model_config = ConfigDict(extra="ignore")

    timestamp: float
    cadence_s: float = 1.0
    num_channels: int = 672
    frequencies_mhz: list[float] = Field(default_factory=list)
    beams: dict[int, BeamSpectrum] = Field(default_factory=dict)


class TargetRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    beam_id: int = 0
    l0: float | None = None
    m0: float | None = None
    l1: float | None = None
    m1: float | None = None
    dl: float | None = None
    dm: float | None = None
    # Support 'l' and 'm' as alternative field names, excluded from serialization
    l: float | None = Field(default=None, exclude=True)  # noqa: E741
    m: float | None = Field(default=None, exclude=True)

    @model_validator(mode="before")
    @classmethod
    def resolve_aliases(cls, data: Any) -> Any:
        if isinstance(data, dict):
            out = dict(data)
            if out.get("l0") is None and out.get("l") is not None:
                out["l0"] = out["l"]
            if out.get("m0") is None and out.get("m") is not None:
                out["m0"] = out["m"]
            return out
        return data

    @model_validator(mode="after")
    def validate_target(self) -> TargetRequest:
        if not (0 <= self.beam_id < 16):
            raise ValueError(f"beam_id must be between 0 and 15, got {self.beam_id}")

        if self.l0 is not None and self.m0 is not None:
            r2 = self.l0**2 + self.m0**2
            if r2 > 1.000001:
                raise ValueError(f"l0^2 + m0^2 must be <= 1.0 (got {r2:.4f})")

        if self.l1 is not None and self.m1 is not None:
            r2 = self.l1**2 + self.m1**2
            if r2 > 1.000001:
                raise ValueError(f"l1^2 + m1^2 must be <= 1.0 (got {r2:.4f})")

        return self


class CelestialRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    beam_id: int = 0
    ra_deg: float
    dec_deg: float

    @model_validator(mode="after")
    def validate_celestial(self) -> CelestialRequest:
        if not (0 <= self.beam_id < 16):
            raise ValueError(f"beam_id must be between 0 and 15, got {self.beam_id}")

        if not (0.0 <= self.ra_deg < 360.0):
            raise ValueError(f"ra_deg must be in [0, 360), got {self.ra_deg}")

        if not (-90.0 <= self.dec_deg <= 90.0):
            raise ValueError(f"dec_deg must be in [-90, 90], got {self.dec_deg}")

        return self


class EnableBeamsRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    num_active_beams: int

    @model_validator(mode="after")
    def validate_num_beams(self) -> EnableBeamsRequest:
        if not (1 <= self.num_active_beams <= 16):
            raise ValueError(
                f"num_active_beams must be between 1 and 16, got {self.num_active_beams}"
            )
        return self


class MaskAntennaRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    antenna_id: int
    enabled: bool

    @model_validator(mode="after")
    def validate_antenna(self) -> MaskAntennaRequest:
        if self.antenna_id < 0:
            raise ValueError(f"antenna_id must be >= 0, got {self.antenna_id}")
        return self


class InterpolationRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool


class AutoDetectRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool


class BeamPowerResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    rest_prefix: str = "/direct_tracker"
    enable_grid_mode: bool = False
    max_beams: int = 4
    active_beams: int = 2
    num_subbands: int = 2
    total_freq_channels: int = 672
    freq_start_hz: float = 300000000.0
    freq_step_hz: float = 300000.0
    grid_step_rad: float = 0.02
    frame_id: int = 0
    timestamp_utc: float = 0.0
    beam_power: list[list[float]] = Field(default_factory=list)


class SubbandMaskStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    subband: int = 0
    freq_start_hz: float = 300000000.0
    active_mask: list[int] = Field(default_factory=list)
    power_rms: list[float] = Field(default_factory=list)
    clip_fraction: list[float] = Field(default_factory=list)


class AntennaMetricItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    antenna_id: int
    enabled: bool = True
    power_rms: float = 0.0
    clip_fraction: float = 0.0
    kurtosis: float = 3.0
    robust_z_score: float = 0.0
    status: str = "nominal"
    spectrum_db: list[float] = Field(default_factory=list)


class AntennaMaskStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    num_elements: int = 64
    num_antennas: int = 64
    auto_detect_enabled: bool = True
    blank_voltages_enabled: bool = True
    manual_mask: list[int] = Field(default_factory=list)
    subbands: list[SubbandMaskStatus] = Field(default_factory=list)
    active_antennas: int = 64
    active_elements: int = 64
    masked_antennas: int = 0
    antennas: list[AntennaMetricItem] = Field(default_factory=list)


class SkyGridCentroid(BaseModel):
    model_config = ConfigDict(extra="ignore")

    l: float = 0.0  # noqa: E741
    m: float = 0.0
    peak_beam_id: int = 0
    peak_power: float = 0.0


class SkyGridFrame(BaseModel):
    model_config = ConfigDict(extra="ignore")

    timestamp: float = 0.0
    grid_step_rad: float = 0.02
    grid_power: list[list[float]] = Field(default_factory=list)  # 4x4
    beam_powers: list[float] = Field(default_factory=list)  # 16
    peak_beam_id: int = 0
    peak_power: float = 0.0
    centroid_l: float = 0.0
    centroid_m: float = 0.0
    l_coords: list[float] = Field(default_factory=list)
    m_coords: list[float] = Field(default_factory=list)
    beam_power_spectra: list[list[float]] = Field(default_factory=list)


class ReferenceFringe(BaseModel):
    model_config = ConfigDict(extra="ignore")

    antenna_a: int = 0
    antenna_b: int = 0
    amplitude: list[float] = Field(default_factory=list)
    phase_rad: list[float] = Field(default_factory=list)
    real: list[float] = Field(default_factory=list)
    imag: list[float] = Field(default_factory=list)


class CorrelatorDiagnostics(BaseModel):
    model_config = ConfigDict(extra="ignore")

    timestamp: float = 0.0
    num_channels: int = 672
    num_elements: int = 64
    bandpass_db: list[float] = Field(default_factory=list)
    amplitude_matrix: list[list[float]] = Field(default_factory=list)  # 64x64 raw mean amplitude
    phase_matrix: list[list[float]] = Field(default_factory=list)  # 64x64 mean phase
    coherence_matrix: list[list[float]] = Field(default_factory=list)  # 64x64 normalized coherence [0, 1]
    auto_db: list[float] = Field(default_factory=list)  # 64 auto power in dB
    reference_fringes: dict[int, ReferenceFringe] = Field(default_factory=dict)
    antenna_spectra_db: list[list[float]] = Field(default_factory=list)  # 64 x 84 mini spectra
    full_antenna_spectra_db: list[list[float]] = Field(
        default_factory=list
    )  # 64 x 672 full spectra


class BaselineSpectrumResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    antenna_a: int = 0
    antenna_b: int = 0
    frequencies_mhz: list[float] = Field(default_factory=list)
    amplitude: list[float] = Field(default_factory=list)
    phase_rad: list[float] = Field(default_factory=list)
    real: list[float] = Field(default_factory=list)
    imag: list[float] = Field(default_factory=list)
    delay_ns: float = 0.0

