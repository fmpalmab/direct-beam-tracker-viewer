"""Configuration parsing for the direct beam tracker viewer."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass


@dataclass
class Settings:
    kotekan_url: str = "http://localhost:12048"
    host: str = "127.0.0.1"
    port: int = 8088
    poll_interval: float = 0.5
    spectrometer_interval: float = 1.0
    routine_enabled: bool = False
    routine_targets_path: str = "tools/verified_targets.json"
    routine_num_beams: int = 4
    routine_step_minutes: int = 60


def parse_args(args: list[str] | None = None) -> Settings:
    """Parse CLI arguments and environment variables into Settings."""
    parser = argparse.ArgumentParser(description="Direct Beam Tracker Viewer")
    parser.add_argument(
        "--kotekan",
        dest="kotekan_url",
        default=os.environ.get("KOTEKAN_URL", "http://localhost:12048"),
        help="Base URL of kotekan REST server (default: http://localhost:12048)",
    )
    parser.add_argument(
        "--host",
        dest="host",
        default=os.environ.get("VIEWER_HOST", "127.0.0.1"),
        help="Host address to bind server (default: 127.0.0.1)",
    )
    parser.add_argument(
        "--port",
        dest="port",
        type=int,
        default=int(os.environ.get("VIEWER_PORT", "8088")),
        help="Port to bind server (default: 8088)",
    )
    parser.add_argument(
        "--poll-interval",
        dest="poll_interval",
        type=float,
        default=float(os.environ.get("VIEWER_POLL_INTERVAL", "0.5")),
        help="Kotekan status polling interval in seconds (default: 0.5, floor: 0.2)",
    )
    parser.add_argument(
        "--spectrometer-interval",
        dest="spectrometer_interval",
        type=float,
        default=float(os.environ.get("VIEWER_SPECTROMETER_INTERVAL", "1.0")),
        help="Line spectrometer polling cadence in seconds (default: 1.0, floor: 0.2)",
    )
    parser.add_argument(
        "--routine",
        dest="routine_enabled",
        action="store_true",
        default=os.environ.get("ROUTINE_ENABLED", "") not in ("", "0", "false"),
        help="Run the precomputed observation routine: 4 beams always on the 4 best targets",
    )
    parser.add_argument(
        "--routine-targets",
        dest="routine_targets_path",
        default=os.environ.get("ROUTINE_TARGETS", "tools/verified_targets.json"),
        help="Path to verified_targets.json catalog (default: tools/verified_targets.json)",
    )
    parser.add_argument(
        "--routine-beams",
        dest="routine_num_beams",
        type=int,
        default=int(os.environ.get("ROUTINE_BEAMS", "4")),
        help="Number of routine output beams (default: 4)",
    )
    parser.add_argument(
        "--routine-step-minutes",
        dest="routine_step_minutes",
        type=int,
        default=int(os.environ.get("ROUTINE_STEP_MINUTES", "60")),
        help="Routine set-hour step in minutes (default: 60)",
    )

    parsed = parser.parse_args(args)
    # Floor at 0.2 s — never faster to prevent overloading kotekan
    poll_interval = max(0.2, float(parsed.poll_interval))
    spectrometer_interval = max(0.2, float(parsed.spectrometer_interval))

    return Settings(
        kotekan_url=parsed.kotekan_url.rstrip("/"),
        host=parsed.host,
        port=parsed.port,
        poll_interval=poll_interval,
        spectrometer_interval=spectrometer_interval,
        routine_enabled=bool(parsed.routine_enabled),
        routine_targets_path=parsed.routine_targets_path,
        routine_num_beams=max(1, min(8, int(parsed.routine_num_beams))),
        routine_step_minutes=max(5, int(parsed.routine_step_minutes)),
    )
