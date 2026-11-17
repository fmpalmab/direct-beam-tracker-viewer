"""Data models and request validation for the direct beam tracker viewer."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, ConfigDict, Field, model_validator

VALID_TAPER_TYPES = frozenset(
    {
        "none",
        "uniform",
        "cosine_pedestal",
        "hamming",
        "blackman",
        "blackman_pedestal",
        "gaussian",
    }
)


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
    l1: float | None = None
    m1: float | None = None
    dl: float = 0.0
    dm: float = 0.0
    grid_index: int = 0
    calibrated: bool = True
    celestial_target: CelestialTarget = Field(default_factory=CelestialTarget)


class Status(BaseModel):
    model_config = ConfigDict(extra="ignore")

    active_antennas: int = 0
    active_raw_elements: list[int] = Field(default_factory=list)
    active_physical_antennas: list[int] = Field(default_factory=list)
    num_active_beams: int = 0
    max_beams: int | None = None
    subframe_interpolation_enabled: bool = False
    taper_type: str | None = None
    taper_pedestal: float | None = None
    normalize_weights: bool | None = None
    enable_weight_bislc: bool | None = None
    bislc_diagonal_loading: float | None = None
    apply_calibration_gains: bool | None = None
    gains_file: str | None = None
    gains_generation: int | None = None
    current_lst_hours: float | None = None
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
    raw_id: int | None = None
    physical_id: int | None = None
    enabled: bool = True
    power_rms: float = 0.0
    clip_fraction: float = 0.0
    dc_fraction: float = 0.0
    iq_imbalance: float = 0.0
    kurtosis: float = 3.0
    coherence: float = 0.0
    passband_power: float = 0.0
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
    active_raw_elements: list[int] = Field(default_factory=list)
    active_physical_antennas: list[int] = Field(default_factory=list)
    antennas: list[AntennaMetricItem] = Field(default_factory=list)


class AntennaChannelPowerSubband(BaseModel):
    model_config = ConfigDict(extra="ignore")

    subband: int = 0
    freq_start_hz: float = 300000000.0
    num_elements: int = 64
    num_local_freq: int = 336
    has_channel_power: bool = False
    power_rms: list[float] = Field(default_factory=list)
    active_physical_antennas: list[int] = Field(default_factory=list)
    mean_active_power: list[float] = Field(default_factory=list)
    channel_power: list[list[float]] = Field(default_factory=list)


class AntennaChannelPowerResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    num_elements: int = 64
    subbands: list[AntennaChannelPowerSubband] = Field(default_factory=list)


class RfiTopChannel(BaseModel):
    model_config = ConfigDict(extra="ignore")

    freq_mhz: float
    mean_power: float = 0.0
    mean_sk: float = 1.0
    max_sk: float = 1.0
    freq_mad_z: float = 0.0
    flagged_chunk_fraction: float = 0.0
    flag_bits: int = 0


class RfiStatus(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = True
    blank_voltages_enabled: bool = True
    time_chunk_size: int = 256
    sample_stride: int = 1
    enable_sk_check: bool = True
    sk_sigma_threshold: float = 4.5
    enable_time_burst_check: bool = True
    burst_sigma_threshold: float = 5.0
    enable_freq_mad_check: bool = True
    freq_window_half_width: int = 8
    mad_sigma_threshold: float = 6.0
    enable_saturation_check: bool = True
    saturation_fraction_threshold: float = 0.02
    enable_morphology_sir: bool = True
    edge_channels_to_ignore: int = 0
    enable_persistent_ema: bool = True
    ema_alpha: float = 0.02
    static_notch_bands_mhz: list[list[float]] = Field(default_factory=list)
    total_channels: int = 672
    flagged_channels: int = 0
    overall_flagged_chunk_fraction: float = 0.0
    top_rfi_channels: list[RfiTopChannel] = Field(default_factory=list)


class RfiChannelItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    freq_mhz: float
    subband: int = 0
    local_channel: int = 0
    mean_power: float = 0.0
    mean_sk: float = 1.0
    max_sk: float = 1.0
    freq_mad_z: float = 0.0
    flagged_chunk_fraction: float = 0.0
    flag_bits: int = 0
    gain: float = 1.0


class RfiChannelsResponse(BaseModel):
    model_config = ConfigDict(extra="ignore")

    total_channels: int = 0
    channels: list[RfiChannelItem] = Field(default_factory=list)


class RfiConfigureRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool | None = None
    blank_voltages_enabled: bool | None = None
    enable_sk_check: bool | None = None
    sk_sigma_threshold: float | None = Field(default=None, gt=0.0)
    enable_time_burst_check: bool | None = None
    burst_sigma_threshold: float | None = Field(default=None, gt=0.0)
    enable_freq_mad_check: bool | None = None
    freq_window_half_width: int | None = Field(default=None, ge=2)
    mad_sigma_threshold: float | None = Field(default=None, gt=0.0)
    enable_saturation_check: bool | None = None
    saturation_fraction_threshold: float | None = Field(default=None, ge=0.0, le=1.0)
    enable_morphology_sir: bool | None = None
    edge_channels_to_ignore: int | None = Field(default=None, ge=0)
    enable_persistent_ema: bool | None = None
    ema_alpha: float | None = Field(default=None, ge=1e-4, le=1.0)
    static_notch_bands_mhz: list[list[float]] | None = None
    reset_ema: bool | None = None

    @model_validator(mode="after")
    def validate_notches(self) -> RfiConfigureRequest:
        if self.static_notch_bands_mhz is not None:
            for band in self.static_notch_bands_mhz:
                if len(band) != 2:
                    raise ValueError(
                        f"Each static notch band must be [lo_mhz, hi_mhz], got {band}"
                    )
                if band[0] > band[1]:
                    raise ValueError(
                        f"Static notch band lo_mhz ({band[0]}) must be <= hi_mhz ({band[1]})"
                    )
        return self


class RfiResetEmaRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    freq_mhz: list[float] | None = None
    all: bool = False


class TaperRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    taper_type: str | None = None
    taper_pedestal: float | None = Field(default=None, ge=0.0, le=1.0)
    enable_weight_bislc: bool | None = None
    bislc_diagonal_loading: float | None = Field(default=None, gt=0.0)
    normalize_weights: bool | None = None

    @model_validator(mode="after")
    def validate_taper(self) -> TaperRequest:
        if self.taper_type is not None and self.taper_type not in VALID_TAPER_TYPES:
            raise ValueError(
                f"taper_type must be one of {sorted(VALID_TAPER_TYPES)}, got {self.taper_type!r}"
            )
        return self


class CalibrationToggleRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    enabled: bool = True
    beam_id: int | None = Field(default=None, ge=0, le=15)


class ReloadGainsRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    gains_file: str = Field(..., min_length=1)
    zero_flagged: bool = False
    sync_rfi_notches: bool = False


class BeamSensitivityItem(BaseModel):
    model_config = ConfigDict(extra="ignore")

    beam_id: int
    label: str = ""
    l0: float = 0.0
    m0: float = 0.0
    n0: float = 1.0
    alt_deg: float = 90.0
    az_deg: float = 0.0
    element_response: float = 1.0
    sefd_beam_jy: float = 0.0
    sigma_s_1s_jy: float = 0.0
    fluence_min_1ms_jy_ms: float = 0.0
    calibrated: bool = True


class SefdSensitivitySummary(BaseModel):
    model_config = ConfigDict(extra="ignore")

    timestamp: float = 0.0
    nominal_zenith_sefd_jy: float = 721000.0
    n_alive: int = 0
    mean_power_lsb2: float = 0.0
    quantizer_sigma_lsb: float = 0.0
    quantizer_eta_q: float = 0.972
    quantizer_q_rms: float = 0.0
    in_optimal_window: bool = False
    total_bandwidth_mhz: float = 201.6
    rfi_flagged_fraction: float = 0.0
    clean_bandwidth_mhz: float = 201.6
    array_zenith_sefd_jy: float = 0.0
    array_sigma_s_1s_jy: float = 0.0
    array_fluence_min_1ms_jy_ms: float = 0.0
    taper_type: str = "cosine_pedestal"
    apply_calibration_gains: bool = True
    source: str = "analytical"
    beams: list[BeamSensitivityItem] = Field(default_factory=list)
