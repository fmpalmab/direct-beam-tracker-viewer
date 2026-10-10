"""Async client for the kotekan direct beam tracker REST API."""

from __future__ import annotations

import logging
from typing import Any
import httpx

from .models import CelestialRequest, Status, TargetRequest

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
        except httpx.ConnectError:
            logger.warning("Connection failed on %s %s, retrying once...", method, path)
            return await self._client.request(method, path, **kwargs)

    async def get_status(self) -> Status:
        """Fetch tracker status: GET /direct_tracker/status."""
        resp = await self._request_with_retry("GET", "/direct_tracker/status")
        if resp.is_error:
            raise TrackerError(resp.status_code, resp.text)
        return Status.model_validate(resp.json())

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
        data = {
            k: v
            for k, v in req.model_dump().items()
            if v is not None and k not in ("l", "m")
        }
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
        """Mask or unmask an antenna element: POST /direct_tracker/mask_antenna."""
        data = {"antenna_id": antenna_id, "enabled": enabled}
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

    async def aclose(self) -> None:
        """Close client resources."""
        if self._owns_client:
            await self._client.aclose()
