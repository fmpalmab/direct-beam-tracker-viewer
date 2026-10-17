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

        if method == "GET" and path == "/direct_tracker/beam_power":
            data = {
                "rest_prefix": "/direct_tracker",
                "enable_grid_mode": False,
                "max_beams": 4,
                "active_beams": self.num_active_beams,
                "num_subbands": 2,
                "total_freq_channels": 672,
                "freq_start_hz": 300000000.0,
                "freq_step_hz": 300000.0,
                "grid_step_rad": 0.02,
                "frame_id": 100,
                "timestamp_utc": 1700000000.0,
                "beam_power": [[1.0] * 672 for _ in range(4)],
            }
            return httpx.Response(200, json=data)

        if method == "GET" and path == "/grid_tracker/beam_power":
            data = {
                "rest_prefix": "/grid_tracker",
                "enable_grid_mode": True,
                "max_beams": 16,
                "active_beams": 16,
                "num_subbands": 2,
                "total_freq_channels": 672,
                "freq_start_hz": 300000000.0,
                "freq_step_hz": 300000.0,
                "grid_step_rad": 0.02,
                "frame_id": 100,
                "timestamp_utc": 1700000000.0,
                "beam_power": [[float(i * 10 + 5)] * 672 for i in range(16)],
            }
            return httpx.Response(200, json=data)

        if method == "GET" and path == "/antenna_mask/status":
            antennas = [
                {
                    "antenna_id": i,
                    "enabled": i in self.active_raw_elements,
                    "power_rms": 8.0 if i in self.active_raw_elements else 0.0,
                    "clip_fraction": 0.001 if i in self.active_raw_elements else 0.0,
                    "kurtosis": 3.0,
                    "robust_z_score": 0.0,
                    "status": "nominal" if i in self.active_raw_elements else "masked",
                }
                for i in range(64)
            ]
            data = {
                "num_elements": 64,
                "num_antennas": 64,
                "auto_detect_enabled": True,
                "blank_voltages_enabled": True,
                "manual_mask": [
                    1 if i in self.active_raw_elements else 0 for i in range(64)
                ],
                "subbands": [
                    {
                        "subband": 0,
                        "freq_start_hz": 300000000.0,
                        "active_mask": [
                            1 if i in self.active_raw_elements else 0 for i in range(64)
                        ],
                        "power_rms": [8.0] * 64,
                        "clip_fraction": [0.001] * 64,
                    },
                    {
                        "subband": 1,
                        "freq_start_hz": 400800000.0,
                        "active_mask": [
                            1 if i in self.active_raw_elements else 0 for i in range(64)
                        ],
                        "power_rms": [8.0] * 64,
                        "clip_fraction": [0.001] * 64,
                    },
                ],
                "active_antennas": len(self.active_raw_elements),
                "active_elements": len(self.active_raw_elements),
                "masked_antennas": 64 - len(self.active_raw_elements),
                "antennas": antennas,
            }
            return httpx.Response(200, json=data)

        if method == "GET" and path.startswith("/inspect_frame/"):
            buffer_name = path.removeprefix("/inspect_frame/")
            if buffer_name in (
                "host_formed_beams_buffer_0",
                "host_formed_beams_buffer_1",
                "test_buffer",
            ):
                return httpx.Response(200, content=b"\x00\x01\x02\x03")
            if buffer_name in (
                "integrated_correlation_buffer_0",
                "integrated_correlation_buffer_1",
            ):
                # 336 * 528 * 2 * 2 * 2 * 4 = 5,677,056 bytes
                num_ints = 336 * 528 * 2 * 2 * 2
                return httpx.Response(200, content=bytes(num_ints * 4))
            return httpx.Response(404, text="Buffer Not Found")

        if method == "POST" and path == "/direct_tracker/set_target":
            body = json.loads(request.content)
            beam_id = body.get("beam_id", 0)
            if beam_id >= 16:
                return httpx.Response(400, text="beam_id >= MAX_DIRECT_BEAMS (16)")
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
            if beam_id >= 16:
                return httpx.Response(400, text="beam_id >= MAX_DIRECT_BEAMS (16)")
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
            self.num_active_beams = min(16, max(1, n))
            return httpx.Response(
                200, text=f"Active beams set to {self.num_active_beams}"
            )

        if method == "POST" and path in (
            "/antenna_mask/mask_antenna",
            "/direct_tracker/mask_antenna",
        ):
            body = json.loads(request.content)
            aid = body.get("antenna_id")
            if aid is None or aid >= 1024 or aid < 0:
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
