#!/usr/bin/env bash
set -euo pipefail
cd /home/fpalma/direct-beam-tracker-viewer
exec /usr/local/bin/uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 >> /home/fpalma/direct-beam-tracker-viewer/viewer.log 2>&1
