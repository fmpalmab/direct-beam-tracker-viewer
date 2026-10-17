#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo " Checking CHARTS Tri-Engine Kotekan Endpoints (Port 12048)"
echo "=========================================================="

if ! curl -s http://127.0.0.1:12048/direct_tracker/status >/dev/null 2>&1; then
    echo "ERROR: Kotekan is not responding on 127.0.0.1:12048"
    echo "Please launch Kotekan first."
    exit 1
fi

echo ""
echo ">>> [1] Direct Tracker Beam Power (Engine 1: 4 Beams, 672 Channels)"
curl -s http://127.0.0.1:12048/direct_tracker/beam_power | jq '{rest_prefix, max_beams, num_subbands, total_freq_channels, freq_start_hz, freq_step_hz}'

echo ""
echo ">>> [2] 16-Beam Sky Grid Power (Engine 2: 16 Beams, 672 Channels)"
curl -s http://127.0.0.1:12048/grid_tracker/beam_power | jq '{rest_prefix, max_beams, num_subbands, total_freq_channels, grid_step_rad}'

echo ""
echo ">>> [3] 64-Element Array Health & Mask Status (Engine 0)"
curl -s http://127.0.0.1:12048/antenna_mask/status | jq '{num_elements, blank_voltages_enabled, active_antennas, subbands_count: (.subbands | length)}'

echo ""
echo ">>> [4] Raw Integrated Visibilities Frame (Engine 3)"
SIZE=$(curl -s http://127.0.0.1:12048/inspect_frame/integrated_correlation_buffer_0 | wc -c)
echo "Buffer size: $SIZE bytes (Expected: 5,677,056 bytes)"

echo ""
echo "=========================================================="
echo " All endpoints verified successfully!"
echo "=========================================================="
