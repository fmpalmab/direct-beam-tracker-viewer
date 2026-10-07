#!/usr/bin/env bash
# ==============================================================================
# Status Script: Kotekan + Direct Beam Tracker Viewer Health & Telemetry
# ==============================================================================
set -u

echo "=========================================================================="
echo " Service Processes:"
echo "=========================================================================="
if pgrep -fl "kotekan" >/dev/null 2>&1; then
    echo "  [RUNNING] Kotekan process(es):"
    pgrep -fl "kotekan" | sed 's/^/    /'
else
    echo "  [STOPPED] Kotekan is not running."
fi

if pgrep -fl "viewer" >/dev/null 2>&1; then
    echo "  [RUNNING] Web Viewer process(es):"
    pgrep -fl "viewer" | sed 's/^/    /'
else
    echo "  [STOPPED] Web Viewer is not running."
fi

echo ""
echo "=========================================================================="
echo " REST Endpoint Health:"
echo "=========================================================================="

echo -n "  Kotekan (:12048): "
STATUS_JSON=$(curl -s http://127.0.0.1:12048/direct_tracker/status 2>/dev/null || true)
if [[ -n "${STATUS_JSON}" && "${STATUS_JSON}" != *"404"* ]]; then
    echo "ONLINE"
    echo "  --- Active Telemetry ---"
    echo "${STATUS_JSON}" | jq '{
        version,
        active_antennas,
        active_physical_antennas,
        active_raw_elements,
        num_active_beams,
        beams: [.beams[] | {beam_id, target: .celestial_target, l0, m0, n0}]
    }' 2>/dev/null | sed 's/^/    /' || echo "    ${STATUS_JSON}"
else
    echo "OFFLINE"
fi

echo ""
echo -n "  Web Viewer (:8088): "
HEALTH_JSON=$(curl -s http://localhost:8088/api/health 2>/dev/null || true)
if [[ -n "${HEALTH_JSON}" ]]; then
    echo "ONLINE"
    echo "    ${HEALTH_JSON}"
else
    echo "OFFLINE"
fi
echo "=========================================================================="
