# Architecture & Implementation Plan — Direct Beam Tracker Viewer

## Product Goal

A lightweight web observatory control plane for a running Kotekan instance executing the
dedicated Direct Beam Tracker chain:

```
cudaAntennaMaskCommand ──▶ cudaRfiMitigationCommand ──▶ cudaDirectBeamTrackerCommand
```

Operators connect from multiple workstations through an SSH port-forward (`ssh -L 8088:localhost:8088`):

```
operator browsers ◄── WebSocket /ws & REST /api/* ──▶ viewer (:8088, uvicorn)
                                                          │
                                              StatusPoller (1–4 Hz single client)
                                                          ▼
                                                      kotekan (:12048)
```

## Architectural Principles

1. **Single Background Poller**: Exactly one `StatusPoller` communicates with Kotekan regardless of how many browser tabs are connected; updates fan out over `/ws`.
2. **Direct Tracker + RFI + SEFD (No Correlator Required)**:
   - Per-antenna 672-channel and 84-bin spectra come directly from `cudaAntennaMaskCommand` (`GET /antenna_mask/channel_power`).
   - Real-time RFI spectra, bitmask diagnostics, threshold controls, EMA baseline resets, and pre-whitening gains connect to `cudaRfiMitigationCommand` (`/rfi_mitigation/*`).
   - Tied-array SEFD (`SEFD_0 = 721 kJy`), 4-bit F-engine quantizer efficiency (`eta_q`, `sigma` [LSB]), RFI-aware radiometer sensitivity (`sigma_S`, `F_min`), and `.npz` -> `(672, 64)` `.npy` calibration exports integrate `charts-sefd` and `charts-utils` with standalone analytical fallbacks in `viewer.sefd_utils`.
3. **No Build Step, No Database**: Vanilla JS + HiDPI `<canvas>` dashboard in `src/viewer/static/`, in-memory ring buffers only.
4. **uv-Managed**: `pyproject.toml` is the single dependency source (`uv sync --dev`, `uv run viewer`).

## File Layout

```
direct-beam-tracker-viewer/
├── pyproject.toml
├── docs/
│   ├── API.md
│   ├── DEPLOYMENT.md
│   └── PLANNING.md
├── src/viewer/
│   ├── __init__.py
│   ├── __main__.py
│   ├── config.py          # CLI/env Settings (poll interval floored at 0.2 s)
│   ├── models.py          # Pydantic v2 schemas for Tracker, RFI, SEFD, Mask, Calibration
│   ├── client.py          # Typed async httpx client (retry on transient connect/timeout)
│   ├── sefd_utils.py      # charts-sefd / charts-utils bridge + analytical fallbacks
│   ├── spectrometer.py    # 672-ch formed beam power & synthetic spectrum processor
│   ├── poller.py          # Single async poller (status, beam_power, spec, rfi/sefd, mask)
│   ├── routine.py         # Precomputed set-hour celestial schedule runner
│   ├── server.py          # FastAPI app, token auth (`verify_token`), REST + WS `/ws`
│   └── static/
│       ├── index.html     # 4-tab UI (Tracker, RFI Mitigation, SEFD & Cal, 8x8 Array)
│       ├── app.js         # WebSocket client, HiDPI canvas plots, control forms
│       └── style.css      # Dark observatory theme
└── tests/
```
