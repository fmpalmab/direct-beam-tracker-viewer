#!/usr/bin/env bash
set -euo pipefail

KOTEKAN_DIR="/home/fpalma/kotekan"
VIEWER_DIR="/home/fpalma/direct-beam-tracker-viewer"
CONFIG="$KOTEKAN_DIR/charts/config/64antennas_tri_engine_benchmark.yaml"
KOTEKAN_BIN="$KOTEKAN_DIR/build/kotekan/kotekan"

echo "=========================================================="
echo " CHARTS 64-Antenna Tri-Engine Synthetic Pipeline Launcher"
echo "=========================================================="

if [ ! -f "$KOTEKAN_BIN" ]; then
    echo "ERROR: Kotekan binary not found at $KOTEKAN_BIN"
    echo "Please build with: cmake --build $KOTEKAN_DIR/build --parallel"
    exit 1
fi

echo "1. Starting Kotekan synthetic benchmark pipeline in background..."
"$KOTEKAN_BIN" -c "$CONFIG" &
KOTEKAN_PID=$!
echo "Kotekan PID: $KOTEKAN_PID"

cleanup() {
    echo ""
    echo "Shutting down..."
    curl -s http://127.0.0.1:12048/kill >/dev/null 2>&1 || true
    kill "$KOTEKAN_PID" 2>/dev/null || true
    wait "$KOTEKAN_PID" 2>/dev/null || true
    echo "Clean exit complete."
}
trap cleanup EXIT INT TERM

echo "2. Waiting for Kotekan REST server on 127.0.0.1:12048..."
for i in {1..30}; do
    if curl -s http://127.0.0.1:12048/direct_tracker/status >/dev/null 2>&1; then
        echo "Kotekan REST server is responsive!"
        break
    fi
    sleep 0.5
done

echo "3. Querying stitched 672-channel status..."
curl -s http://127.0.0.1:12048/direct_tracker/beam_power | jq '{max_beams, num_subbands, total_freq_channels}' || true

echo "4. Launching Viewer on http://localhost:8088..."
cd "$VIEWER_DIR"
uv run viewer --kotekan-url http://127.0.0.1:12048 --port 8088
