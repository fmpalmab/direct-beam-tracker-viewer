#!/usr/bin/env bash
# ==============================================================================
# Stop Script: Kotekan + Direct Beam Tracker Viewer
# ==============================================================================
set -euo pipefail

SUDO_PASS="FP_Charts123!"

echo "Stopping Kotekan process..."
echo "${SUDO_PASS}" | sudo -S pkill -f "/kotekan/build/kotekan/kotekan" 2>/dev/null || true
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
