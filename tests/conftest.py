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
    """In-memory mock of the kotekan direct beam tracker, RFI, and mask REST server."""

    def __init__(self) -> None:
        self.active_antennas: int = 32
        self.active_raw_elements: list[int] = [0, 1, 2, 3, 4]
        self.active_physical_antennas: list[int] = [63, 62, 61, 60, 59]
        self.auto_detect_enabled: bool = True
        self.num_active_beams: int = 2
        self.subframe_interpolation_enabled: bool = True
        self.taper_type: str = "cosine_pedestal"
        self.taper_pedestal: float = 0.25
        self.normalize_weights: bool = True
        self.enable_weight_bislc: bool = False
        self.bislc_diagonal_loading: float = 1e-4
        self.apply_calibration_gains: bool = True
        self.gains_file: str = "/data/calibration/corr_1113/gains_test_672x64.npy"
        self.gains_generation: int = 1
        self.current_lst_hours: float = 12.5
        self.rfi_config: dict[str, Any] = {
            "enabled": True,
            "blank_voltages_enabled": True,
            "time_chunk_size": 256,
            "sample_stride": 1,
            "enable_sk_check": True,
            "sk_sigma_threshold": 4.5,
            "enable_time_burst_check": True,
            "burst_sigma_threshold": 5.0,
            "enable_freq_mad_check": True,
            "freq_window_half_width": 8,
            "mad_sigma_threshold": 6.0,
            "enable_saturation_check": True,
            "saturation_fraction_threshold": 0.02,
            "enable_morphology_sir": True,
            "edge_channels_to_ignore": 0,
            "enable_persistent_ema": True,
            "ema_alpha": 0.02,
            "static_notch_bands_mhz": [[362.0, 378.0]],
        }
        self.rfi_gains: dict[float, list[float]] = {}
        self.beams: list[dict[str, Any]] = [
            {
                "beam_id": 0,
                "l0": 0.1,
                "m0": 0.2,
                "n0": math.sqrt(max(0.0, 1.0 - 0.1**2 - 0.2**2)),
                "grid_index": 100,
                "calibrated": True,
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
                "calibrated": True,
                "celestial_target": {
                    "is_set": False,
                    "ra_deg": None,
                    "dec_deg": None,
                },
            },
        ]
        self.last_request: dict[str, Any] = {}

    def _build_rfi_channels(self) -> list[dict[str, Any]]:
        channels = []
        for i in range(672):
            sb = 0 if i < 336 else 1
            lch = i if sb == 0 else (i - 336)
            f0 = 300.0 if sb == 0 else 400.8
            freq_mhz = round(f0 + lch * 0.3, 3)
            in_notch = any(
                lo <= freq_mhz <= hi
                for lo, hi in self.rfi_config.get("static_notch_bands_mhz", [])
            )
            is_cw = abs(freq_mhz - 414.0) < 0.2
            flag_bits = 16 if in_notch else (10 if is_cw else 0)
            channels.append(
                {
                    "freq_mhz": freq_mhz,
                    "subband": sb,
                    "local_channel": lch,
                    "mean_power": 12.0 if is_cw else 3.06,
                    "mean_sk": 0.15 if is_cw else 1.0,
                    "max_sk": 0.25 if is_cw else 1.08,
                    "freq_mad_z": 15.0 if is_cw else 0.1,
                    "flagged_chunk_fraction": 1.0 if (in_notch or is_cw) else 0.0,
                    "flag_bits": flag_bits,
                    "gain": 1.0,
                }
            )
        return channels

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
                "active_physical_antennas": self.active_physical_antennas,
                "num_active_beams": self.num_active_beams,
                "max_beams": 16,
                "subframe_interpolation_enabled": self.subframe_interpolation_enabled,
                "taper_type": self.taper_type,
                "taper_pedestal": self.taper_pedestal,
                "normalize_weights": self.normalize_weights,
                "enable_weight_bislc": self.enable_weight_bislc,
                "bislc_diagonal_loading": self.bislc_diagonal_loading,
                "apply_calibration_gains": self.apply_calibration_gains,
                "gains_file": self.gains_file,
                "gains_generation": self.gains_generation,
                "current_lst_hours": self.current_lst_hours,
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

        if method == "GET" and path == "/rfi_mitigation/status":
            channels = self._build_rfi_channels()
            flagged = [c for c in channels if c["flag_bits"] != 0]
            top = [
                {
                    "freq_mhz": c["freq_mhz"],
                    "mean_power": c["mean_power"],
                    "mean_sk": c["mean_sk"],
                    "max_sk": c["max_sk"],
                    "freq_mad_z": c["freq_mad_z"],
                    "flagged_chunk_fraction": c["flagged_chunk_fraction"],
                    "flag_bits": c["flag_bits"],
                }
                for c in flagged[:20]
            ]
            data = {
                **self.rfi_config,
                "total_channels": len(channels),
                "flagged_channels": len(flagged),
                "overall_flagged_chunk_fraction": sum(
                    c["flagged_chunk_fraction"] for c in channels
                )
                / len(channels),
                "top_rfi_channels": top,
            }
            return httpx.Response(200, json=data)

        if method == "GET" and path == "/rfi_mitigation/channels":
            channels = self._build_rfi_channels()
            return httpx.Response(
                200, json={"total_channels": len(channels), "channels": channels}
            )

        if method == "POST" and path == "/rfi_mitigation/configure":
            body = json.loads(request.content)
            for k, v in body.items():
                if k in self.rfi_config:
                    self.rfi_config[k] = v
            return httpx.Response(200, text="RFI mitigation updated\n")

        if method == "POST" and path == "/rfi_mitigation/reset_ema":
            body = json.loads(request.content) if request.content else {}
            freqs = body.get("freq_mhz") or []
            if body.get("all") or not freqs:
                return httpx.Response(
                    200, json={"status": "ok", "mode": "all", "instances_updated": 2}
                )
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "mode": "selective",
                    "matched_channels": len(freqs),
                    "instances_updated": 2,
                },
            )

        if method == "POST" and path == "/rfi_mitigation/set_gains":
            body = json.loads(request.content)
            f0 = float(body["freq_start_hz"])
            gains = list(body["gains"])
            self.rfi_gains[f0] = gains
            return httpx.Response(
                200,
                text=f"Updated {len(gains)} digital calibration gains for subband f0={f0 * 1e-6:.1f} MHz\n",
            )

        if method == "GET" and path == "/antenna_mask/status":
            antennas = [
                {
                    "antenna_id": i,
                    "raw_id": i,
                    "physical_id": 63 - i,
                    "enabled": i in self.active_raw_elements,
                    "power_rms": 3.1 if i in self.active_raw_elements else 0.0,
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
                "auto_detect_enabled": self.auto_detect_enabled,
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
                        "power_rms": [3.1] * 64,
                        "clip_fraction": [0.001] * 64,
                    },
                    {
                        "subband": 1,
                        "freq_start_hz": 400800000.0,
                        "active_mask": [
                            1 if i in self.active_raw_elements else 0 for i in range(64)
                        ],
                        "power_rms": [3.1] * 64,
                        "clip_fraction": [0.001] * 64,
                    },
                ],
                "active_antennas": len(self.active_raw_elements),
                "active_elements": len(self.active_raw_elements),
                "masked_antennas": 64 - len(self.active_raw_elements),
                "active_raw_elements": self.active_raw_elements,
                "active_physical_antennas": self.active_physical_antennas,
                "antennas": antennas,
            }
            return httpx.Response(200, json=data)

        if method == "GET" and path == "/antenna_mask/channel_power":
            sb0_row = [3.1 if a in self.active_raw_elements else 0.0 for a in range(64)]
            sb1_row = [3.4 if a in self.active_raw_elements else 0.0 for a in range(64)]
            data = {
                "num_elements": 64,
                "subbands": [
                    {
                        "subband": 0,
                        "freq_start_hz": 300000000.0,
                        "num_elements": 64,
                        "num_local_freq": 336,
                        "has_channel_power": True,
                        "power_rms": sb0_row,
                        "active_physical_antennas": self.active_physical_antennas,
                        "mean_active_power": [3.1] * 336,
                        "channel_power": [sb0_row for _ in range(336)],
                    },
                    {
                        "subband": 1,
                        "freq_start_hz": 400800000.0,
                        "num_elements": 64,
                        "num_local_freq": 336,
                        "has_channel_power": True,
                        "power_rms": sb1_row,
                        "active_physical_antennas": self.active_physical_antennas,
                        "mean_active_power": [3.4] * 336,
                        "channel_power": [sb1_row for _ in range(336)],
                    },
                ],
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
            return httpx.Response(404, text="Buffer Not Found")

        if method == "POST" and path == "/direct_tracker/set_target":
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
                        "calibrated": True,
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
                        "calibrated": True,
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

        if method == "POST" and path == "/direct_tracker/set_taper":
            body = json.loads(request.content)
            if "taper_type" in body:
                self.taper_type = body["taper_type"]
            if "taper_pedestal" in body:
                self.taper_pedestal = float(body["taper_pedestal"])
            if "normalize_weights" in body:
                self.normalize_weights = bool(body["normalize_weights"])
            if "enable_weight_bislc" in body:
                self.enable_weight_bislc = bool(body["enable_weight_bislc"])
            if "bislc_diagonal_loading" in body:
                self.bislc_diagonal_loading = float(body["bislc_diagonal_loading"])
            return httpx.Response(
                200,
                text=f"Taper updated: type={self.taper_type}, pedestal={self.taper_pedestal:.2f}\n",
            )

        if method == "POST" and path == "/direct_tracker/set_calibration":
            body = json.loads(request.content)
            enabled = bool(body.get("enabled", True))
            if "beam_id" in body and body["beam_id"] is not None:
                bid = int(body["beam_id"])
                if bid >= len(self.beams):
                    return httpx.Response(400, text="beam_id exceeds configured max_beams")
                self.beams[bid]["calibrated"] = enabled
                return httpx.Response(
                    200, text=f"Calibration for beam {bid} set to {enabled}\n"
                )
            self.apply_calibration_gains = enabled
            return httpx.Response(200, text=f"Calibration gains set to {enabled}\n")

        if method == "POST" and path == "/direct_tracker/reload_gains":
            body = json.loads(request.content)
            gf = body.get("gains_file", "")
            if not gf:
                return httpx.Response(400, text="No gains_file supplied")
            self.gains_file = gf
            self.gains_generation += 1
            return httpx.Response(
                200,
                json={
                    "status": "ok",
                    "gains_file": self.gains_file,
                    "gains_generation": self.gains_generation,
                    "instances": 2,
                },
            )

        if method == "POST" and path == "/antenna_mask/configure":
            body = json.loads(request.content)
            if "auto_detect_enabled" in body:
                self.auto_detect_enabled = bool(body["auto_detect_enabled"])
            return httpx.Response(
                200, text="Antenna mask configuration updated successfully\n"
            )

        if method == "POST" and path == "/antenna_mask/reset":
            self.active_raw_elements = list(range(64))
            self.active_antennas = 64
            return httpx.Response(200, text="All antenna masks reset to active\n")

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
