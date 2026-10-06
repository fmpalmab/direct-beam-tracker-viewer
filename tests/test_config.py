"""Unit tests for configuration and CLI argument parsing."""

from __future__ import annotations

import os
from unittest.mock import patch
from viewer.config import parse_args


def test_default_config() -> None:
    settings = parse_args([])
    assert settings.kotekan_url == "http://localhost:12048"
    assert settings.host == "127.0.0.1"
    assert settings.port == 8088
    assert settings.poll_interval == 0.5


def test_cli_overrides() -> None:
    args = [
        "--kotekan", "http://gpu-node:12048/",
        "--host", "0.0.0.0",
        "--port", "9000",
        "--poll-interval", "1.0",
    ]
    settings = parse_args(args)
    assert settings.kotekan_url == "http://gpu-node:12048"
    assert settings.host == "0.0.0.0"
    assert settings.port == 9000
    assert settings.poll_interval == 1.0


def test_poll_interval_floor() -> None:
    # Floor must be 0.2 s — never faster to protect processing node
    settings = parse_args(["--poll-interval", "0.05"])
    assert settings.poll_interval == 0.2


def test_env_var_fallbacks() -> None:
    env = {
        "KOTEKAN_URL": "http://env-host:12048",
        "VIEWER_HOST": "192.168.1.100",
        "VIEWER_PORT": "8888",
        "VIEWER_POLL_INTERVAL": "0.75",
    }
    with patch.dict(os.environ, env, clear=True):
        settings = parse_args([])
        assert settings.kotekan_url == "http://env-host:12048"
        assert settings.host == "192.168.1.100"
        assert settings.port == 8888
        assert settings.poll_interval == 0.75
