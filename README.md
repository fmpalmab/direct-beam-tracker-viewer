# Direct Beam Tracker Viewer

A lightweight web viewer and observatory control plane for the **Kotekan Direct Beam Tracker** pipeline (`cudaAntennaMaskCommand` -> `cudaRfiMitigationCommand` -> `cudaDirectBeamTrackerCommand`), integrated with **CHARTS SEFD/sensitivity modeling** (`charts-sefd`) and **complex gain calibration export** (`charts-utils`).

The viewer talks to a running Kotekan instance **exclusively through its REST API** — no binary coupling, no shared memory.

## Key Capabilities

1. **Direct Astrometric Tracker (Tab 1)**:
   - Live beam status (`GET /direct_tracker/status`): direction cosines `(l0, m0, n0)`, celestial targets `(RA, Dec)`, active physical/raw antennas, LST, and seam/phase rates.
   - Steer any beam (`1..16` active beams) by direction cosines or J2000 RA/Dec, toggle subframe phase interpolation, and view live 672-channel line spectra & synchronized 90-step waterfalls.
2. **Real-Time RFI Mitigation (Tab 2 · `cudaRfiMitigationCommand`)**:
   - Live 672-channel RFI diagnostics canvas (`GET /rfi_mitigation/channels`) displaying channel power (`LSB²`), Spectral Kurtosis (`SK`), passband `freq_mad_z`, static notch bands, and dynamic flag masks (`GET /rfi_mitigation/status`).
   - Live controls for detector toggles and thresholds (`POST /rfi_mitigation/configure`), selective/global EMA baseline reset (`POST /rfi_mitigation/reset_ema`), and one-click passband pre-whitening gain push (`POST /rfi_mitigation/set_gains`).
3. **SEFD, Sensitivity & Calibration (Tab 3 · `charts-sefd` & `charts-utils`)**:
   - Live 4-bit F-engine quantizer diagnostics (`sigma` [LSB], `eta_q`, `q_rms`, optimal window compliance) derived from clean channel power.
   - Elevation-corrected tied-array `SEFD_beam` (from nominal zenith `SEFD_0 = 721 kJy`), RFI-aware clean bandwidth `dnu_clean = 201.6 MHz * (1 - f_rfi)`, 1s continuum noise floor `sigma_S` [Jy], and 10-sigma 1ms FRB fluence limit `F_min` [Jy ms].
   - Calibration hot-reload accepting either `charts-utils` `.npz` gain solutions (automatically converted to `(672, 64)` `complex64` `.npy`, with optional `zero_flagged` and `sync_rfi_notches`) or `.npy` tables (`POST /direct_tracker/reload_gains`), A/B global & per-beam calibration toggles (`POST /direct_tracker/set_calibration`), and 2D spatial taper controls (`POST /direct_tracker/set_taper`).
4. **8×8 Array Health & Masking (Tab 4 · `cudaAntennaMaskCommand`)**:
   - Real-time 64-element health grid and per-antenna 672-channel / 84-bin spectra polled directly from `GET /antenna_mask/status` and `GET /antenna_mask/channel_power` without requiring a correlator.

Designed to be **gentle on the processing node**: a single server-side `StatusPoller` queries Kotekan at 1–4 Hz and fans out to any number of browsers over `/ws` WebSocket.

## Observation Routine

`--routine` runs a precomputed observation script on top of the tracker using `tools/verified_targets_10beams.json` (SIMBAD-verified sources for the Carén site):

```bash
uv run viewer --kotekan http://localhost:12048 --port 8088 \
  --routine --routine-targets tools/verified_targets_10beams.json
```

- At each set hour (default 60 min steps), beams are re-pointed via `POST /direct_tracker/set_celestial_target` and target labels are pushed over `/ws`.
- Routine endpoints: `GET /api/routine`, `GET /api/routine/schedule`, `POST /api/routine/apply` (see [docs/API.md](docs/API.md)).

## Quick Start (`uv`)

```bash
# 1. Start Kotekan with cudaAntennaMaskCommand, cudaRfiMitigationCommand, and cudaDirectBeamTrackerCommand
#    REST server default: http://localhost:12048

# 2. On the processing node, from this directory:
uv sync
uv run viewer --kotekan http://localhost:12048 --port 8088

# 3. On each operator PC, forward the port and open the browser:
ssh -L 8088:localhost:8088 user@processing-node
#    -> http://localhost:8088
```

Full setup, multi-PC access, and LAN options: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

## Layout

```
direct-beam-tracker-viewer/
├── pyproject.toml         # uv project (deps + `viewer` entry point)
├── docs/
│   ├── PLANNING.md        # Architecture & implementation spec
│   ├── API.md             # Kotekan & Viewer REST/WebSocket reference
│   └── DEPLOYMENT.md      # Setup, SSH tunnel, multi-PC access
├── src/viewer/
│   ├── server.py          # FastAPI app: proxies/aggregates REST, serves static & WS
│   ├── client.py          # Typed async client for Kotekan tracker/RFI/mask endpoints
│   ├── models.py          # Pydantic v2 telemetry & control schemas
│   ├── poller.py          # Single background poller + ring buffer + WS broadcast
│   ├── sefd_utils.py      # charts-sefd & charts-utils integration + analytical fallbacks
│   ├── spectrometer.py    # 672-ch formed beam spectrometer processor
│   ├── routine.py         # Precomputed observation routine scheduler
│   └── static/            # Vanilla HTML/JS/CSS canvas dashboard (no build step)
└── tests/
```

## Development

```bash
uv sync --dev
uv run ruff check .
uv run pytest tests/ -q
```
