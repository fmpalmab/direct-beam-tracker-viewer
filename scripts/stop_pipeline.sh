#!/usr/bin/env bash
# ==============================================================================
# Stop Script: Kotekan + Direct Beam Tracker Viewer
# ==============================================================================
set -euo pipefail

echo "Stopping Kotekan process..."
curl -s http://127.0.0.1:12048/kill >/dev/null 2>&1 || true
pkill -f "/kotekan/build/kotekan/kotekan" 2>/dev/null || true
pkill -f "build/kotekan/kotekan" 2>/dev/null || true
if [[ -n "${SUDO_PASS:-}" ]]; then
    echo "${SUDO_PASS}" | sudo -S pkill -f "/kotekan/build/kotekan/kotekan" 2>/dev/null || true
fi
if command -v screen >/dev/null 2>&1; then
    screen -S kotekan -X quit 2>/dev/null || true
fi

echo "Stopping Web Viewer process..."
pkill -f "uv run viewer" 2>/dev/null || true
pkill -f "python.*viewer" 2>/dev/null || true
if command -v screen >/dev/null 2>&1; then
    screen -S viewer -X quit 2>/dev/null || true
fi

sleep 1
echo "Kotekan and Web Viewer have been stopped."
