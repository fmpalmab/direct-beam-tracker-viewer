#!/usr/bin/env bash
# ==============================================================================
# Persistent Launch Script: Kotekan 24h Tracker + Direct Beam Tracker Viewer
# Survives CLI / SSH disconnects using screen or nohup.
# ==============================================================================
set -euo pipefail

KOTEKAN_DIR="/home/fpalma/kotekan"
VIEWER_DIR="/home/fpalma/direct-beam-tracker-viewer"
CONFIG_FILE="${KOTEKAN_DIR}/charts/config/64antennas_direct_tracker.yaml"
KOTEKAN_BIN="${KOTEKAN_DIR}/build/kotekan/kotekan"
KOTEKAN_LOG="${KOTEKAN_DIR}/kotekan_run.log"
VIEWER_LOG="${VIEWER_DIR}/viewer.log"
SUDO_PASS="FP_Charts123!"

echo "[1/4] Checking environment..."
if [[ ! -x "${KOTEKAN_BIN}" ]]; then
    echo "ERROR: Kotekan binary not found at ${KOTEKAN_BIN}. Rebuild first." >&2
    exit 1
fi

echo "[2/4] Cleaning stale hugepages & stopping old instances..."
echo "${SUDO_PASS}" | sudo -S rm -f /dev/hugepages/rtemap_* 2>/dev/null || true
echo "${SUDO_PASS}" | sudo -S pkill -9 -f "${KOTEKAN_BIN}" 2>/dev/null || true
pkill -9 -f "uv run viewer" 2>/dev/null || true
pkill -9 -f "python.*viewer" 2>/dev/null || true
sleep 1

echo "[3/4] Starting Kotekan 24h Direct Beam Tracker in background..."
if command -v screen >/dev/null 2>&1; then
    screen -dmS kotekan bash -c "echo '${SUDO_PASS}' | sudo -S '${KOTEKAN_BIN}' -c '${CONFIG_FILE}' -b 127.0.0.1:12048 2>&1 | tee '${KOTEKAN_LOG}'"
else
    nohup bash -c "echo '${SUDO_PASS}' | sudo -S '${KOTEKAN_BIN}' -c '${CONFIG_FILE}' -b 127.0.0.1:12048" > "${KOTEKAN_LOG}" 2>&1 &
fi

echo "Waiting for Kotekan REST API on port 12048..."
for i in {1..20}; do
    if curl -s http://127.0.0.1:12048/direct_tracker/status >/dev/null 2>&1; then
        echo "  -> Kotekan REST API is UP!"
        break
    fi
    sleep 1
done

echo "[4/4] Starting Direct Beam Tracker Viewer on port 8088..."
cd "${VIEWER_DIR}"
if command -v screen >/dev/null 2>&1; then
    screen -dmS viewer bash -c "cd '${VIEWER_DIR}' && uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 2>&1 | tee '${VIEWER_LOG}'"
else
    nohup uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 > "${VIEWER_LOG}" 2>&1 &
fi

sleep 2
if curl -s http://localhost:8088/api/health >/dev/null 2>&1; then
    echo "  -> Web Viewer is UP at http://0.0.0.0:8088 !"
else
    echo "  -> WARNING: Web Viewer starting up; check logs at ${VIEWER_LOG}"
fi

echo ""
echo "=========================================================================="
echo " Persistent deployment complete! Services will continue running"
echo " even after closing this CLI / terminal session."
echo "=========================================================================="
echo " - Viewer Web UI : http://localhost:8088"
echo " - Kotekan REST  : http://127.0.0.1:12048"
echo " - Kotekan Logs  : ${KOTEKAN_LOG} (or 'screen -r kotekan')"
echo " - Viewer Logs   : ${VIEWER_LOG}  (or 'screen -r viewer')"
echo "=========================================================================="
