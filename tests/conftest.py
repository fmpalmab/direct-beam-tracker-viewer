"""Pytest fixtures and mock kotekan transport."""

from __future__ import annotations

import json
import math
from typing import Any
import httpx
import pytest

from viewer.client import TrackerClient
from viewer.config import Settings


class MockKotekanBackend:
    """In-memory mock of the kotekan direct beam tracker REST server."""

    def __init__(self) -> None:
        self.active_antennas: int = 32
        self.active_raw_elements: list[int] = [0, 1, 2, 3, 4]
        self.num_active_beams: int = 2
        self.subframe_interpolation_enabled: bool = True
        self.beams: list[dict[str, Any]] = [
            {
                "beam_id": 0,
                "l0": 0.1,
                "m0": 0.2,
                "n0": math.sqrt(max(0.0, 1.0 - 0.1**2 - 0.2**2)),
                "grid_index": 100,
                "celestial_target": {
                    "is_set": True,
                    "ra_deg": 45.0,
                    "dec_deg": 30.0,
                },
            },
            {
                "beam_id": 1,
                "l0": -0.3,
                "m0": 0.4,
                "n0": math.sqrt(max(0.0, 1.0 - (-0.3) ** 2 - 0.4**2)),
                "grid_index": 200,
                "celestial_target": {
                    "is_set": False,
                    "ra_deg": None,
                    "dec_deg": None,
                },
            },
        ]
        self.last_request: dict[str, Any] = {}

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        method = request.method
        self.last_request = {
            "method": method,
            "path": path,
            "body": request.content.decode("utf-8") if request.content else "",
        }

        if method == "GET" and path == "/direct_tracker/status":
            data = {
                "active_antennas": self.active_antennas,
                "active_raw_elements": self.active_raw_elements,
                "num_active_beams": self.num_active_beams,
                "subframe_interpolation_enabled": self.subframe_interpolation_enabled,
                "beams": self.beams[: self.num_active_beams],
            }
            return httpx.Response(200, json=data)

        if method == "POST" and path == "/direct_tracker/set_target":
            body = json.loads(request.content)
            beam_id = body.get("beam_id", 0)
            if beam_id >= 8:
                return httpx.Response(400, text="beam_id >= MAX_DIRECT_BEAMS (8)")
            # Update beam
            while len(self.beams) <= beam_id:
                self.beams.append(
                    {
                        "beam_id": len(self.beams),
                        "l0": 0.0,
                        "m0": 0.0,
                        "n0": 1.0,
                        "grid_index": 0,
                        "celestial_target": {"is_set": False},
                    }
                )
            if "l0" in body:
                self.beams[beam_id]["l0"] = body["l0"]
            if "m0" in body:
                self.beams[beam_id]["m0"] = body["m0"]
            l0 = self.beams[beam_id]["l0"]
            m0 = self.beams[beam_id]["m0"]
            r2 = l0**2 + m0**2
            self.beams[beam_id]["n0"] = (
                math.sqrt(max(0.0, 1.0 - r2)) if r2 <= 1.0 else 0.0
            )
            self.beams[beam_id]["celestial_target"] = {"is_set": False}
            return httpx.Response(200, text=f"Beam {beam_id} target updated")

        if method == "POST" and path == "/direct_tracker/set_celestial_target":
            body = json.loads(request.content)
            beam_id = body.get("beam_id", 0)
            if beam_id >= 8:
                return httpx.Response(400, text="beam_id >= MAX_DIRECT_BEAMS (8)")
            while len(self.beams) <= beam_id:
                self.beams.append(
                    {
                        "beam_id": len(self.beams),
                        "l0": 0.0,
                        "m0": 0.0,
                        "n0": 1.0,
                        "grid_index": 0,
                        "celestial_target": {"is_set": False},
                    }
                )
            self.beams[beam_id]["celestial_target"] = {
                "is_set": True,
                "ra_deg": body["ra_deg"],
                "dec_deg": body["dec_deg"],
            }
            return httpx.Response(200, text=f"Beam {beam_id} celestial target updated")

        if method == "POST" and path == "/direct_tracker/enable_beam":
            body = json.loads(request.content)
            n = body.get("num_active_beams", 1)
            self.num_active_beams = min(8, max(1, n))
            return httpx.Response(
                200, text=f"Active beams set to {self.num_active_beams}"
            )

        if method == "POST" and path == "/direct_tracker/mask_antenna":
            body = json.loads(request.content)
            aid = body.get("antenna_id")
            if aid is None or aid >= 1024:
                return httpx.Response(400, text="Invalid antenna_id")
            enabled = body.get("enabled", False)
            if enabled and aid not in self.active_raw_elements:
                self.active_raw_elements.append(aid)
            elif not enabled and aid in self.active_raw_elements:
                self.active_raw_elements.remove(aid)
            self.active_antennas = len(self.active_raw_elements)
            return httpx.Response(200, text=f"Antenna {aid} mask set to {enabled}")

        if method == "POST" and path == "/direct_tracker/set_interpolation":
            body = json.loads(request.content)
            self.subframe_interpolation_enabled = bool(body.get("enabled", False))
            return httpx.Response(200, text="Interpolation updated")

        return httpx.Response(404, text="Not Found")


@pytest.fixture
def mock_backend() -> MockKotekanBackend:
    return MockKotekanBackend()


@pytest.fixture
def mock_client(mock_backend: MockKotekanBackend) -> TrackerClient:
    transport = httpx.MockTransport(mock_backend.handler)
    http_client = httpx.AsyncClient(
        transport=transport, base_url="http://mock-kotekan:12048"
    )
    return TrackerClient(base_url="http://mock-kotekan:12048", client=http_client)


@pytest.fixture
def test_settings() -> Settings:
    return Settings(
        kotekan_url="http://mock-kotekan:12048",
        host="127.0.0.1",
        port=8088,
        poll_interval=0.2,
    )
