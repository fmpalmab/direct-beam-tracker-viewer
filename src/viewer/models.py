"""Data models and request validation for the direct beam tracker viewer."""

from __future__ import annotations

import math
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


class TargetRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    beam_id: int = 0
    l0: float | None = None
    m0: float | None = None
    l1: float | None = None
    m1: float | None = None
    dl: float | None = None
    dm: float | None = None
    # Support 'l' and 'm' as alternative field names
    l: float | None = None
    m: float | None = None

    @model_validator(mode="before")
    @classmethod
    def resolve_aliases(cls, data: Any) -> Any:
        if isinstance(data, dict):
            if "l0" not in data and "l" in data:
                data["l0"] = data["l"]
            if "m0" not in data and "m" in data:
                data["m0"] = data["m"]
        return data

    @model_validator(mode="after")
    def validate_target(self) -> TargetRequest:
        if not (0 <= self.beam_id < 8):
            raise ValueError(f"beam_id must be between 0 and 7, got {self.beam_id}")

        if self.l0 is not None and self.m0 is not None:
            r2 = self.l0 ** 2 + self.m0 ** 2
            if r2 > 1.000001:
                raise ValueError(f"l0^2 + m0^2 must be <= 1.0 (got {r2:.4f})")

        if self.l1 is not None and self.m1 is not None:
            r2 = self.l1 ** 2 + self.m1 ** 2
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
        if not (0 <= self.beam_id < 8):
            raise ValueError(f"beam_id must be between 0 and 7, got {self.beam_id}")

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
        if not (1 <= self.num_active_beams <= 8):
            raise ValueError(
                f"num_active_beams must be between 1 and 8, got {self.num_active_beams}"
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
