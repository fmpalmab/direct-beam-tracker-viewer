# GEMINI.md — Direct Beam Tracker & Web Viewer Guide

This file points to [`AGENTS.md`](AGENTS.md) for full operational instructions, architecture diagrams, persistent deployment procedures, and troubleshooting guidelines.

## Quick Persistent Launch

```bash
cd /home/fpalma/direct-beam-tracker-viewer
./scripts/start_pipeline.sh     # Starts Kotekan (24h tracker) and Web Viewer in background
./scripts/status_pipeline.sh    # Verifies both services and REST health
./scripts/stop_pipeline.sh      # Cleanly terminates both services
```

* **Viewer UI**: `http://localhost:8088`
* **Kotekan REST API**: `http://127.0.0.1:12048`
* **Alive Antennas**: `[0, 4, 5, 6, 32]` (raw elements `[63, 59, 58, 57, 31]`)
* **Tracked Astros**: Sagittarius A* (Beam 0) and Vela Pulsar (Beam 1)
