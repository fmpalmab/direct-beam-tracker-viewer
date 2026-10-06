"""Configuration parsing for the direct beam tracker viewer."""

from __future__ import annotations

import argparse
import os
from dataclasses import dataclass


@dataclass
class Settings:
    kotekan_url: str = "http://localhost:12048"
    host: str = "127.0.0.1"
    port: int = 8080
    poll_interval: float = 0.5


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
        default=int(os.environ.get("VIEWER_PORT", "8080")),
        help="Port to bind server (default: 8080)",
    )
    parser.add_argument(
        "--poll-interval",
        dest="poll_interval",
        type=float,
        default=float(os.environ.get("VIEWER_POLL_INTERVAL", "0.5")),
        help="Kotekan status polling interval in seconds (default: 0.5, floor: 0.2)",
    )

    parsed = parser.parse_args(args)
    # Floor at 0.2 s — never faster to prevent overloading kotekan
    poll_interval = max(0.2, float(parsed.poll_interval))

    return Settings(
        kotekan_url=parsed.kotekan_url.rstrip("/"),
        host=parsed.host,
        port=parsed.port,
        poll_interval=poll_interval,
    )
