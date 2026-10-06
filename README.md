# Direct Beam Tracker Viewer

A lightweight web viewer and control panel for the **Kotekan Direct Beam Tracker**
(`cudaDirectBeamTrackerCommand` stage). It talks to a running kotekan instance
**exclusively through its REST API** — no binary coupling, no shared memory.

The viewer lets an operator:

- See the live state of all beams (`GET /direct_tracker/status`): pointing
  direction (l, m, n), celestial target (RA/Dec), grid index, active antennas.
- Steer any beam by direction cosines or by RA/Dec celestial target.
- Enable/disable beams, mask/unmask antennas, set interpolation mode.
- Plot beam pointings on a sky (l, m) map and track them over time.

## Scope

This repo contains **only the viewer** (frontend + thin REST client backend).
The beamformer itself lives in the kotekan repo
(`kotekan-direct-beamformer/lib/cuda/`). All control flows through the
endpoints documented in [`docs/API.md`](docs/API.md).

## Quick start

```bash
# 1. kotekan must be running with the direct beam tracker stage loaded
#    (see config/direct_beamformer_example.yaml in the kotekan package).
#    REST server default: http://localhost:12048

# 2. Start the viewer
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
python -m viewer.server --kotekan http://localhost:12048 --port 8080

# 3. Open http://localhost:8080
```

## Layout

```
direct-beam-tracker-viewer/
├── README.md
├── docs/
│   ├── PLANNING.md        # Milestones & task breakdown for implementation
│   └── API.md             # Full REST endpoint reference (from kotekan source)
├── src/viewer/
│   ├── server.py          # Backend: proxies/aggregates kotekan REST calls
│   ├── client.py          # Typed Python client for the tracker endpoints
│   └── static/            # Frontend (HTML/JS, sky map, controls)
├── tests/
└── requirements.txt
```
