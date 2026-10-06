# Implementation Plan — Direct Beam Tracker Viewer

Target executor: a small/fast coding AI. Tasks are ordered, self-contained,
and each has acceptance criteria. Read `docs/API.md` before Task 2.

## Architecture decision

- **Backend:** Python 3.11+, FastAPI + `httpx` (async client to kotekan),
  `uvicorn` server. Serves the static frontend and proxies REST calls so the
  browser never talks to kotekan directly (avoids CORS, adds validation).
- **Frontend:** single-page vanilla JS + Canvas (no build step). Sky map as a
  polar projection of (l, m) inside the unit circle.
- **No database.** Live state is polled; trajectory history kept in-memory
  ring buffer (last N status samples per beam, N=600).

## Milestones & tasks

### M1 — REST client (backend core)

**Task 1.1** — `src/viewer/client.py`: `TrackerClient` class wrapping every
endpoint in API.md with typed methods:
- `get_status() -> Status` (pydantic models: `BeamInfo`, `Status`)
- `set_target(beam_id, l0=None, m0=None, l1=None, m1=None, dl=None, dm=None)`
- `set_celestial_target(beam_id, ra_deg, dec_deg)`
- `enable_beam(beam_id, enabled)` / `set_num_active_beams(n)`
- `mask_antenna(antenna_idx, masked)`
- `set_interpolation(mode)`

Acceptance: `tests/test_client.py` with `respx`-mocked httpx covering each
method's URL, payload, and error passthrough (400 on bad beam_id).

**Task 1.2** — Config: `--kotekan` base URL CLI arg + `KOTEKAN_URL` env var,
default `http://localhost:12048`. Connection timeout 2 s, retry once on
connect error.

### M2 — Backend server

**Task 2.1** — `src/viewer/server.py`: FastAPI app.
- `GET /api/status` → proxy of tracker status (cached 200 ms).
- `POST /api/beams/{id}/target` → validated proxy of `set_target`
  (reject `l^2+m^2 > 1` with 422).
- `POST /api/beams/{id}/celestial` → proxy of `set_celestial_target`
  (validate 0≤RA<360, −90≤Dec≤90).
- `POST /api/beams/{id}/enable`, `POST /api/antennas/{idx}/mask`,
  `POST /api/interpolation`.
- `GET /api/health` → `{kotekan_reachable: bool}`.
- Serves `src/viewer/static/` at `/`.

**Task 2.2** — Background poller: asyncio task polling kotekan status at
2 Hz into a ring buffer; `GET /api/history?beam_id=N` returns it.
WebSocket `/ws` pushing each new status to connected browsers.

Acceptance: `tests/test_server.py` with a fake kotekan (httpx MockTransport)
— endpoints return expected shapes; bad direction cosines → 422.

### M3 — Frontend

**Task 3.1** — `static/index.html` + `app.js`:
- Sky map canvas: unit circle (horizon), grid circles at zenith angles
  30°/60°, E/N axis labels. One colored dot per active beam (from `l0, m0`),
  labeled with beam_id. Trail from `/api/history`.
- Beam table: per-beam l, m, n, grid_index, RA/Dec (if set), enable toggle.

**Task 3.2** — Controls panel:
- Steer form (l, m or RA/Dec) with client-side validation mirroring backend.
- Antenna mask grid (click to toggle, from `active_raw_elements`).
- Interpolation selector.
- Live updates via WebSocket with polling fallback (2 s) if WS drops.

Acceptance: manual test against real kotekan; screenshot in PR description.

### M4 — Packaging

**Task 4.1** — `requirements.txt` (fastapi, uvicorn, httpx, pydantic),
`requirements-dev.txt` (pytest, respx, pytest-asyncio).
**Task 4.2** — `python -m viewer.server` entry point with argparse.
**Task 4.3** — README quick-start verified end-to-end.

## Out of scope

- Beamformer DSP, weight computation, kotekan config (lives in kotekan repo).
- Authentication (assume trusted subnet, same as kotekan REST server).

## Verification

```bash
pytest tests/ -q
python -m viewer.server --kotekan http://localhost:12048 &
# open http://localhost:8080, steer beam 0 to l=0.1, m=0.2,
# confirm dot moves and kotekan /direct_tracker/status reflects it
```
