"""Async client for the kotekan direct beam tracker, antenna mask, and RFI REST APIs."""

from __future__ import annotations

import logging
from typing import Any

import httpx

from .models import (
    AntennaChannelPowerResponse,
    AntennaMaskStatus,
    BeamPowerResponse,
    CalibrationToggleRequest,
    CelestialRequest,
    RfiChannelsResponse,
    RfiConfigureRequest,
    RfiResetEmaRequest,
    RfiStatus,
    Status,
    TaperRequest,
    TargetRequest,
)

logger = logging.getLogger(__name__)


class TrackerError(Exception):
    """Raised when kotekan responds with an HTTP error."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(f"Tracker error {status_code}: {message}")
        self.status_code = status_code
        self.message = message


class TrackerClient:
    """Typed async client for kotekan direct beam tracker endpoints."""

    def __init__(
        self,
        base_url: str = "http://localhost:12048",
        client: httpx.AsyncClient | None = None,
        timeout: float = 2.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._timeout = timeout
        if client is not None:
            self._client = client
            self._owns_client = False
        else:
            self._client = httpx.AsyncClient(base_url=self.base_url, timeout=timeout)
            self._owns_client = True

    async def _request_with_retry(
        self, method: str, path: str, **kwargs: Any
    ) -> httpx.Response:
        try:
            return await self._client.request(method, path, **kwargs)
        except (httpx.ConnectError, httpx.TimeoutException, httpx.RemoteProtocolError):
            logger.warning("Connection failed on %s %s, retrying once...", method, path)
            return await self._client.request(method, path, **kwargs)

    async def get_status(self) -> Status:
        """Fetch tracker status: GET /direct_tracker/status."""
        resp = await self._request_with_retry("GET", "/direct_tracker/status")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return Status.model_validate(resp.json())

    async def get_beam_power(
        self, prefix: str = "/direct_tracker"
    ) -> BeamPowerResponse:
        """Fetch stitched beam power spectrum: GET {prefix}/beam_power."""
        clean_prefix = "/" + prefix.strip("/")
        resp = await self._request_with_retry("GET", f"{clean_prefix}/beam_power")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return BeamPowerResponse.model_validate(resp.json())

    async def get_antenna_mask_status(self) -> AntennaMaskStatus:
        """Fetch aggregated antenna masking and RF health telemetry: GET /antenna_mask/status."""
        resp = await self._request_with_retry("GET", "/antenna_mask/status")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return AntennaMaskStatus.model_validate(resp.json())

    async def get_antenna_channel_power(self) -> AntennaChannelPowerResponse:
        """Fetch per-antenna per-channel power matrix: GET /antenna_mask/channel_power."""
        resp = await self._request_with_retry("GET", "/antenna_mask/channel_power")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return AntennaChannelPowerResponse.model_validate(resp.json())

    async def get_rfi_status(self) -> RfiStatus:
        """Fetch RFI mitigation thresholds and summary: GET /rfi_mitigation/status."""
        resp = await self._request_with_retry("GET", "/rfi_mitigation/status")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return RfiStatus.model_validate(resp.json())

    async def get_rfi_channels(self) -> RfiChannelsResponse:
        """Fetch per-channel RFI statistics: GET /rfi_mitigation/channels."""
        resp = await self._request_with_retry("GET", "/rfi_mitigation/channels")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return RfiChannelsResponse.model_validate(resp.json())

    async def configure_rfi(
        self, req: RfiConfigureRequest | dict[str, Any]
    ) -> str:
        """Update RFI mitigation configuration: POST /rfi_mitigation/configure."""
        data = (
            req.model_dump(exclude_none=True)
            if isinstance(req, RfiConfigureRequest)
            else dict(req)
        )
        resp = await self._request_with_retry(
            "POST", "/rfi_mitigation/configure", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def reset_rfi_ema(
        self, req: RfiResetEmaRequest | dict[str, Any] | None = None
    ) -> dict[str, Any]:
        """Reset persistent EMA baseline: POST /rfi_mitigation/reset_ema."""
        if req is None:
            data: dict[str, Any] = {"all": True}
        elif isinstance(req, RfiResetEmaRequest):
            data = req.model_dump(exclude_none=True)
        else:
            data = dict(req)
        resp = await self._request_with_retry(
            "POST", "/rfi_mitigation/reset_ema", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        try:
            return dict(resp.json())
        except Exception:
            return {"status": "ok", "message": resp.text}

    async def set_rfi_gains(
        self, freq_start_hz: float, gains: list[float]
    ) -> str:
        """Push digital passband pre-whitening gains: POST /rfi_mitigation/set_gains."""
        data = {"freq_start_hz": float(freq_start_hz), "gains": list(gains)}
        resp = await self._request_with_retry(
            "POST", "/rfi_mitigation/set_gains", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def get_inspect_frame(self, buffer_name: str) -> bytes | None:
        """Fetch raw binary frame snapshot: GET /inspect_frame/{buffer_name}."""
        try:
            resp = await self._client.get(f"/inspect_frame/{buffer_name}")
            if resp.status_code == 200:
                return resp.content
            return None
        except Exception as exc:
            logger.debug("Failed to fetch inspect frame %s: %s", buffer_name, exc)
            return None

    async def set_target(self, req: TargetRequest) -> str:
        """Steer a beam by direction cosines: POST /direct_tracker/set_target."""
        data = req.model_dump(exclude_none=True)
        resp = await self._request_with_retry(
            "POST", "/direct_tracker/set_target", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def set_celestial_target(self, req: CelestialRequest) -> str:
        """Steer a beam by celestial coordinates: POST /direct_tracker/set_celestial_target."""
        data = {
            "beam_id": req.beam_id,
            "ra_deg": req.ra_deg,
            "dec_deg": req.dec_deg,
        }
        resp = await self._request_with_retry(
            "POST", "/direct_tracker/set_celestial_target", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def set_num_active_beams(self, num_active_beams: int) -> str:
        """Set number of active beams: POST /direct_tracker/enable_beam."""
        data = {"num_active_beams": num_active_beams}
        resp = await self._request_with_retry(
            "POST", "/direct_tracker/enable_beam", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def mask_antenna(self, antenna_id: int, enabled: bool) -> str:
        """Mask or unmask an antenna element: POST /antenna_mask/mask_antenna."""
        data = {"antenna_id": antenna_id, "enabled": enabled}
        resp = await self._request_with_retry(
            "POST", "/antenna_mask/mask_antenna", json=data
        )
        if resp.status_code == 404:
            resp = await self._request_with_retry(
                "POST", "/direct_tracker/mask_antenna", json=data
            )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def set_interpolation(self, enabled: bool) -> str:
        """Set subframe interpolation mode: POST /direct_tracker/set_interpolation."""
        data = {"enabled": enabled}
        resp = await self._request_with_retry(
            "POST", "/direct_tracker/set_interpolation", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def set_taper(self, req: TaperRequest | dict[str, Any]) -> str:
        """Update spatial taper and weight normalization: POST /direct_tracker/set_taper."""
        data = (
            req.model_dump(exclude_none=True)
            if isinstance(req, TaperRequest)
            else dict(req)
        )
        resp = await self._request_with_retry(
            "POST", "/direct_tracker/set_taper", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def set_calibration(
        self, req: CalibrationToggleRequest | dict[str, Any]
    ) -> str:
        """Toggle global or per-beam calibration gains: POST /direct_tracker/set_calibration."""
        data = (
            req.model_dump(exclude_none=True)
            if isinstance(req, CalibrationToggleRequest)
            else dict(req)
        )
        resp = await self._request_with_retry(
            "POST", "/direct_tracker/set_calibration", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def reload_gains(self, gains_file: str) -> dict[str, Any]:
        """Hot-reload complex calibration gains: POST /direct_tracker/reload_gains."""
        data = {"gains_file": gains_file}
        resp = await self._request_with_retry(
            "POST", "/direct_tracker/reload_gains", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        try:
            return dict(resp.json())
        except Exception:
            return {"status": "ok", "gains_file": gains_file, "message": resp.text}

    async def set_auto_detect(self, enabled: bool) -> str:
        """Enable or disable RF auto-detect antenna masking: POST /antenna_mask/configure."""
        data = {"auto_detect_enabled": enabled}
        resp = await self._request_with_retry(
            "POST", "/antenna_mask/configure", json=data
        )
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def reset_antenna_masks(self) -> str:
        """Reset all antenna masks to active: POST /antenna_mask/reset."""
        resp = await self._request_with_retry("POST", "/antenna_mask/reset")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return resp.text

    async def aclose(self) -> None:
        """Close client resources."""
        if self._owns_client:
            await self._client.aclose()
