# Implementation Plan — Direct Beam Tracker Viewer

Target executor: a coding AI. Tasks are ordered, self-contained, and each has
acceptance criteria. Read `docs/API.md` (fully confirmed against
`cudaDirectBeamTrackerCommand.cpp`) before Task 2. Read `docs/DEPLOYMENT.md`
before Task 5.

## Product goal

A web viewer/control panel for a running kotekan instance with the
`cudaDirectBeamTrackerCommand` stage. Operators reach it from **multiple PCs
through one SSH port-forward** to the processing node:

```
operator laptops ──ssh -L 8088:localhost:8088──▶ processing node
                                                    ├── kotekan  (REST :12048, GPU node, do not disturb)
                                                    └── viewer   (uvicorn :8088, talks to kotekan on localhost)
browser: http://localhost:8088
```

## Hard constraints (do not violate)

1. **Zero added load per extra viewer.** Exactly ONE background poller talks to
   kotekan, regardless of how many browsers are connected. Browsers receive
   pushed copies over WebSocket. Never let a browser poll kotekan directly or
   trigger extra kotekan requests.
2. **Chill cadence.** Poll kotekan `/direct_tracker/status` at **2 Hz**
   (`POLL_INTERVAL_S = 0.5`). This is far below the kotekan frame cadence and
   costs one small JSON GET per 500 ms — negligible on the processing node —
   while feeling live to human eyes (beam dots move smoothly; a celestial
   target at CHARTS drift rates moves << 1 px per update).
3. **No build step, no database.** Vanilla JS + Canvas frontend served as
   static files. History is an in-memory ring buffer only.
4. **uv-managed.** `pyproject.toml` is the single dependency source;
   `uv sync && uv run viewer` is the whole setup (see DEPLOYMENT.md).
5. **localhost binding by default.** The server binds `127.0.0.1` so the only
   access path is the SSH tunnel (same trust model as the kotekan REST
   server). `--host 0.0.0.0` exists for trusted-subnet use but is not the
   default.

## Architecture

```
┌─ processing node ────────────────────────────────────────────┐
│ kotekan :12048 ◄── httpx, 2 Hz, 1 client ── Poller (asyncio) │
│                                                  │           │
│                                          RingBuffer          │
│                                          (600 samples/beam,  │
│                                           = 5 min @ 2 Hz)    │
│                                                  │           │
│   browsers ◄── WebSocket /ws (push on each poll) ┤           │
│   browsers ◄── REST /api/* (control, proxied) ───┴──► kotekan│
└──────────────────────────────────────────────────────────────┘
```

- **Backend:** Python ≥3.11, FastAPI + httpx (async) + uvicorn.
- **Frontend:** `static/` — `index.html`, `app.js`, `style.css`. Sky map =
  polar projection of (l, m) in the unit circle, drawn on `<canvas>`.
- **Control path** (steer, mask, enable) is a thin validated proxy: browser →
  viewer → kotekan. These are rare human clicks, so proxying adds no load.

## File layout to create

```
direct-beam-tracker-viewer/
├── pyproject.toml            # DONE — uv project, deps, [project.scripts] viewer
├── .python-version           # DONE — 3.11
├── README.md                 # DONE — uv quick-start + SSH workflow
├── docs/
│   ├── API.md                # DONE — confirmed endpoint reference
│   ├── PLANNING.md           # this file
│   └── DEPLOYMENT.md         # DONE — setup + SSH tunnel + multi-PC
├── src/viewer/
│   ├── __init__.py           # exists
│   ├── __main__.py           # enables `python -m viewer`
│   ├── config.py             # CLI/env config (argparse + KOTEKAN_URL etc.)
│   ├── models.py             # pydantic: BeamInfo, CelestialTarget, Status, requests
│   ├── client.py             # TrackerClient — async httpx wrapper of API.md
│   ├── poller.py             # single 2 Hz poller + ring buffer + WS broadcast
│   ├── server.py             # FastAPI app factory, routes, static mount, WS
│   └── static/
│       ├── index.html
│       ├── app.js
│       └── style.css
└── tests/
    ├── __init__.py           # exists
    ├── conftest.py           # fake kotekan via httpx.MockTransport + fixtures
    ├── test_client.py
    └── test_server.py
```

## Tasks

### Task 1 — `models.py` + `config.py`

`models.py` (pydantic v2):

- `CelestialTarget { is_set: bool, ra_deg: float | None = None, dec_deg: float | None = None }`
- `BeamInfo { beam_id: int, l0: float, m0: float, n0: float, grid_index: int, celestial_target: CelestialTarget }`
- `Status { active_antennas: int, active_raw_elements: list[int], num_active_beams: int, subframe_interpolation_enabled: bool, beams: list[BeamInfo] }`
  — must parse kotekan's `/direct_tracker/status` response leniently
  (`num_active_beams` / `subframe_interpolation_enabled` present per source
  lines ~369–374; use defaults if absent).
- Request models with validation:
  - `TargetRequest { beam_id: int = 0, l0/m0/l1/m1/dl/dm: float | None }` —
    reject `l0²+m0² > 1` (and `l1²+m1² > 1` if given) with 422.
  - `CelestialRequest { beam_id: int = 0, ra_deg: float, dec_deg: float }` —
    0 ≤ ra < 360, −90 ≤ dec ≤ 90.
  - `EnableBeamsRequest { num_active_beams: int }` — 1 ≤ n ≤ 8.
  - `MaskAntennaRequest { antenna_id: int, enabled: bool }` — antenna_id ≥ 0.
  - `InterpolationRequest { enabled: bool }`.

`config.py`: argparse on `--kotekan` (env `KOTEKAN_URL`, default
`http://localhost:12048`), `--host` (env `VIEWER_HOST`, default `127.0.0.1`),
`--port` (env `VIEWER_PORT`, default `8088`), `--poll-interval` (default 0.5,
floor at 0.2 s — never faster). Return a `Settings` dataclass.

### Task 2 — `client.py`

`TrackerClient(base_url: str)` wrapping `httpx.AsyncClient`
(timeout 2.0 s, one retry on `ConnectError`). Methods map 1:1 to API.md:

- `get_status() -> Status` — `GET /direct_tracker/status`
- `set_target(TargetRequest)` — `POST /direct_tracker/set_target`
- `set_celestial_target(CelestialRequest)` — `POST /direct_tracker/set_celestial_target`
- `set_num_active_beams(n)` — `POST /direct_tracker/enable_beam` with
  `{"num_active_beams": n}` (confirmed source keys)
- `mask_antenna(antenna_id, enabled)` — `POST /direct_tracker/mask_antenna`
  with `{"antenna_id": …, "enabled": …}` — note `enabled=true` means ACTIVE
  (source sets `antenna_mask[id] = enabled ? 1 : 0`; see API.md note)
- `set_interpolation(enabled)` — `POST /direct_tracker/set_interpolation`
  with `{"enabled": bool}`

Kotekan POSTs return **plain text** replies, not JSON — methods return the
text body. On HTTP 400 from kotekan, raise `TrackerError(status, body)`;
the server layer converts it to the same status code downstream.

Acceptance: `tests/test_client.py` using `httpx.MockTransport` — assert URL,
JSON payload, and error passthrough for each method.

### Task 3 — `poller.py`

```python
class StatusPoller:
    def __init__(self, client: TrackerClient, interval: float = 0.5, history: int = 600): ...
    async def start(self) / async def stop(self)          # asyncio task lifecycle
    def latest(self) -> Status | None
    def history(self, beam_id: int) -> list[Sample]        # ring buffer slice
    def subscribe(self) -> asyncio.Queue                   # one queue per WS client
    def unsubscribe(self, q) -> None
```

- Loop: `await client.get_status()` → store in `deque(maxlen=history)` per
  beam (samples are `(unix_ts, l0, m0)`) → put the new `Status` on every
  subscriber queue (non-blocking; drop if a client queue exceeds 10 pending).
- On kotekan error: keep last status, set `self.healthy = False`, log once,
  keep looping (kotekan may restart). Recover silently.
- **There is exactly one poller instance, started in the FastAPI lifespan.**

### Task 4 — `server.py`

FastAPI app factory `create_app(settings) -> FastAPI`; lifespan starts/stops
the poller. Routes:

| Route | Behavior |
|---|---|
| `GET /api/status` | latest polled `Status` (never hits kotekan directly); 503 if none yet |
| `GET /api/history?beam_id=N` | ring buffer for beam N |
| `GET /api/health` | `{kotekan_reachable: bool, poll_interval_s, uptime_s}` |
| `POST /api/beams/{id}/target` | validate `TargetRequest` → `client.set_target` |
| `POST /api/beams/{id}/celestial` | validate → `client.set_celestial_target` |
| `POST /api/beams/enable` | validate → `client.set_num_active_beams` |
| `POST /api/antennas/mask` | validate → `client.mask_antenna` |
| `POST /api/interpolation` | validate → `client.set_interpolation` |
| `WS /ws` | subscribe to poller; push each new status as JSON; on disconnect, unsubscribe |
| `GET /` + static | serve `static/` (`index.html` at `/`) |

`TrackerError` → HTTPException with kotekan's status/body. `beam_id` path
param must match the body's (or body defaults to it).

Entry: `__main__.py` and `[project.scripts] viewer = "viewer.server:main"`;
`main()` parses config and runs
`uvicorn.run(app, host=settings.host, port=settings.port, log_level="info")`.

Acceptance: `tests/test_server.py` with a MockTransport-backed client —
status shape, 422 on `l²+m²>1`, health endpoint, history after injected
polls, WS receive (use `starlette.testclient` / `httpx` ASGI transport).

### Task 5 — Frontend (`static/`)

`index.html`: header (connection badge + kotekan URL), sky-map canvas
(left), right column: beam table, steer form, antenna mask grid, controls.

`app.js`:
- Open `WS /ws`; on message → redraw. On WS close → fall back to fetching
  `/api/status` every 2 s and retry WS every 5 s. Badge shows
  live/fallback/disconnected.
- **Sky map:** unit circle = horizon; concentric circles at zenith angles
  30°/60° (i.e. radii sin(30°), sin(60°) of the unit circle); cross axes
  labeled E (+l) and N (+m). One colored dot per beam at `(l0, m0)`, labeled
  with beam_id; fetch `/api/history` once per beam selection to draw a trail.
  Redraw via `requestAnimationFrame` only when new data arrived.
- **Beam table:** per beam — id, l, m, n, grid_index, RA/Dec if
  `celestial_target.is_set`, and a click-to-select row that fills the steer
  form.
- **Steer form:** tabs for (l, m) and (RA, Dec); client-side validation
  identical to backend (`l²+m² ≤ 1`, RA/Dec ranges); POST to `/api/...`;
  show kotekan's text reply transiently.
- **Antenna mask grid:** one cell per element index 0..max seen; filled =
  active (in `active_raw_elements`), hollow = masked; click toggles via
  `POST /api/antennas/mask` (`enabled = !currentlyActive`).
- **Controls:** num-active-beams stepper (1–8) → `/api/beams/enable`;
  interpolation checkbox (from `subframe_interpolation_enabled`) →
  `/api/interpolation`.
- No frameworks, no npm. Keep total JS < 400 lines.

### Task 6 — Tests & verification

```bash
cd direct-beam-tracker-viewer
uv sync --dev
uv run pytest tests/ -q          # all green
uv run viewer --kotekan http://localhost:12048 &
# with kotekan running: open http://localhost:8088 (via tunnel, see DEPLOYMENT.md),
# steer beam 0 to l=0.1, m=0.2 → dot moves; kotekan /direct_tracker/status agrees.
# open the same URL from a second browser/PC → both update; confirm on the node
# (e.g. kotekan logs or `ss -tnp | grep 12048`) that only ONE poller connection exists.
```

## Out of scope

- Beamformer DSP, weights, kotekan config (kotekan repo).
- Authentication/HTTPS (SSH tunnel is the security boundary; see DEPLOYMENT.md).
- Persistent history (ring buffer only; restart clears it).
