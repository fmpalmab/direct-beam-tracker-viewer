#!/usr/bin/env bash
# ==============================================================================
# 10-Beam Tracker Observation Routine Launcher for Kotekan & Viewer
# Tracks 10 priority-ranked astronomical targets from verified_targets_10beams.json
# ==============================================================================
set -euo pipefail

KOTEKAN_DIR="/home/fpalma/kotekan"
VIEWER_DIR="/home/fpalma/direct-beam-tracker-viewer"
CONFIG_FILE="${CONFIG_FILE:-${KOTEKAN_DIR}/charts/config/64antennas_direct_tracker_10beams.yaml}"
KOTEKAN_BIN="${KOTEKAN_DIR}/build/kotekan/kotekan"
KOTEKAN_LOG="${KOTEKAN_DIR}/kotekan_run.log"
VIEWER_LOG="${VIEWER_DIR}/viewer.log"
if [[ -f "${VIEWER_DIR}/tools/verified_targets_10beams.json" ]]; then
    TARGETS_CATALOG="${VIEWER_DIR}/tools/verified_targets_10beams.json"
else
    TARGETS_CATALOG="${VIEWER_DIR}/verified_targets_10beams.json"
fi
if [[ -n "${SUDO_PASS:-}" ]]; then
    SUDO_CMD="echo '${SUDO_PASS}' | sudo -S"
else
    SUDO_CMD="sudo"
fi

echo "[1/4] Checking environment..."
if [[ ! -x "${KOTEKAN_BIN}" ]]; then
    echo "ERROR: Kotekan binary not found at ${KOTEKAN_BIN}. Rebuild first." >&2
    exit 1
fi

if [[ ! -f "${CONFIG_FILE}" ]]; then
    echo "Notice: ${CONFIG_FILE} not found; falling back to 64antennas_direct_tracker.yaml"
    CONFIG_FILE="${KOTEKAN_DIR}/charts/config/64antennas_direct_tracker.yaml"
fi

echo "[2/4] Cleaning stale hugepages & stopping old instances..."
eval "${SUDO_CMD} rm -f /dev/hugepages/rtemap_* 2>/dev/null" || true
eval "${SUDO_CMD} pkill -9 -f '${KOTEKAN_BIN}' 2>/dev/null" || true
pkill -9 -f "uv run viewer" 2>/dev/null || true
pkill -9 -f "python.*viewer" 2>/dev/null || true
sleep 1

echo "[3/4] Starting Kotekan 10-Beam Direct Tracker in background..."
if command -v screen >/dev/null 2>&1; then
    screen -dmS kotekan bash -c "${SUDO_CMD} '${KOTEKAN_BIN}' -c '${CONFIG_FILE}' -b 127.0.0.1:12048 2>&1 | tee '${KOTEKAN_LOG}'"
else
    nohup bash -c "${SUDO_CMD} '${KOTEKAN_BIN}' -c '${CONFIG_FILE}' -b 127.0.0.1:12048" > "${KOTEKAN_LOG}" 2>&1 &
fi

echo "Waiting for Kotekan REST API on port 12048..."
for i in {1..20}; do
    if curl -s http://127.0.0.1:12048/direct_tracker/status >/dev/null 2>&1; then
        echo "  -> Kotekan REST API is UP!"
        break
    fi
    sleep 1
done

echo "[4/4] Starting Direct Beam Tracker Viewer with 10-beam routine..."
cd "${VIEWER_DIR}"
ROUTINE_CMD="uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 --routine --routine-targets '${TARGETS_CATALOG}' --routine-beams 10 --routine-step-minutes 60"
if command -v screen >/dev/null 2>&1; then
    screen -dmS viewer bash -c "cd '${VIEWER_DIR}' && ${ROUTINE_CMD} 2>&1 | tee '${VIEWER_LOG}'"
else
    nohup bash -c "cd '${VIEWER_DIR}' && ${ROUTINE_CMD}" > "${VIEWER_LOG}" 2>&1 &
fi

sleep 2
if curl -s http://localhost:8088/api/health >/dev/null 2>&1; then
    echo "  -> Web Viewer & Routine Runner is UP at http://0.0.0.0:8088 !"
else
    echo "  -> WARNING: Web Viewer starting up; check logs at ${VIEWER_LOG}"
fi

echo ""
echo "====================================================================="
echo " Kotekan 10-Beam Tracker Routine is RUNNING in background!"
echo " Catalog: ${TARGETS_CATALOG}"
echo " Targets: 10 Priority Science & Calibration Sources"
echo " Viewer UI: http://localhost:8088 (or http://<ms-x00-ip>:8088)"
echo " Screen sessions: 'kotekan' and 'viewer' (screen -r <name>)"
echo "====================================================================="
