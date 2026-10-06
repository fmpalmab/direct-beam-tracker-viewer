# Direct Beam Tracker Viewer

A lightweight web viewer and control panel for the **Kotekan Direct Beam Tracker**
(`cudaDirectBeamTrackerCommand` stage). It talks to a running kotekan instance
**exclusively through its REST API** — no binary coupling, no shared memory.

The viewer lets an operator:

- See the live state of all beams (`GET /direct_tracker/status`): pointing
  direction (l, m, n), celestial target (RA/Dec), grid index, active antennas.
- Steer any beam by direction cosines or by RA/Dec celestial target.
- Enable/disable beams, mask/unmask antennas, toggle phase interpolation.
- Plot beam pointings on a sky (l, m) map with recent trails.

Designed to be **gentle on the processing node**: a single server-side poller
queries kotekan at 2 Hz and fans out to any number of browsers over WebSocket.

## Quick start (uv)

```bash
# 1. kotekan must be running with the direct beam tracker stage loaded.
#    REST server default: http://localhost:12048

# 2. On the processing node, from this directory:
uv sync
uv run viewer --kotekan http://localhost:12048 --port 8088

# 3. On each operator PC, forward the port and open the browser:
ssh -L 8088:localhost:8088 user@processing-node
#    → http://localhost:8088
```

Full setup, multi-PC access, and LAN option: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Scope

This repo contains **only the viewer** (frontend + thin REST client backend).
The beamformer itself lives in the kotekan repo
(`kotekan-direct-beamformer/lib/cuda/`). All control flows through the
endpoints documented in [docs/API.md](docs/API.md).

## Layout

```
direct-beam-tracker-viewer/
├── pyproject.toml         # uv project (deps + `viewer` entry point)
├── docs/
│   ├── PLANNING.md        # Executable implementation spec (for coding AI)
│   ├── API.md             # REST endpoint reference (confirmed vs kotekan source)
│   └── DEPLOYMENT.md      # Setup, SSH tunnel, multi-PC access
├── src/viewer/
│   ├── server.py          # FastAPI app: proxies/aggregates kotekan REST, serves static
│   ├── client.py          # Typed async client for the tracker endpoints
│   ├── poller.py          # Single 2 Hz status poller + ring buffer + WS broadcast
│   └── static/            # Frontend (HTML/JS canvas sky map, controls — no build step)
└── tests/
```

## Development

```bash
uv sync --dev
uv run pytest tests/ -q
```
