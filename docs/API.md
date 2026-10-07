# Direct Beam Tracker REST API Reference

Extracted from `kotekan-direct-beamformer/lib/cuda/cudaDirectBeamTrackerCommand.cpp`.
All endpoints are registered under **both** prefixes `/direct_tracker/...` and
`/beam_tracker/...` (aliases, identical behavior). Use `/direct_tracker/`.

Base URL: the kotekan REST server, default `http://<host>:12048`.

---

## POST /direct_tracker/set_target

Steer a beam to direction cosines, optionally with a linear trajectory
(end point or velocity).

**Request JSON:**

| Field | Type | Required | Meaning |
|---|---|---|---|
| `beam_id` | int | no (default 0) | Beam index, `< MAX_DIRECT_BEAMS` (8) |
| `l0` (or `l`) | float | no | Direction cosine l at segment start |
| `m0` (or `m`) | float | no | Direction cosine m at segment start |
| `l1` | float | no | l at segment end (linear interpolation) |
| `m1` | float | no | m at segment end |
| `dl` | float | no | Alternative: l velocity per sample; `l1 = l0 + dl * samples_per_data_set` |
| `dm` | float | no | Alternative: m velocity per sample |

Notes:
- Omitted `l0`/`m0` keep the current values.
- `n = sqrt(1 - l^2 - m^2)` is computed server-side; if `l^2+m^2 > 1`, `n = 0`.
- Setting a target clears the celestial target (`celestial.is_set = false`).

**Errors:** `400` if `beam_id >= MAX_DIRECT_BEAMS`.

---

## POST /direct_tracker/set_celestial_target

Steer a beam to an RA/Dec; kotekan converts to (l, m) internally.

**Request JSON:** `beam_id` (int, default 0), `ra_deg` (float), `dec_deg` (float).

---

## POST /direct_tracker/enable_beam

Set the number of active beams.

**Request JSON:** `{"num_active_beams": 4}` — confirmed against
`cudaDirectBeamTrackerCommand.cpp` (lines ~304–316). Value is clamped to
`MAX_DIRECT_BEAMS` (8). Reply is plain text.

---

## POST /direct_tracker/mask_antenna

Mask/unmask an antenna element.

**Request JSON:** `{"antenna_id": 5, "enabled": true}` — confirmed against
source (lines ~319–347). **Note the polarity:** `enabled: true` means the
antenna is ACTIVE (source sets `antenna_mask[id] = enabled ? 1 : 0` and
masked-out antennas are those with mask 0). 400 if `antenna_id` missing or
≥ `MAX_DIRECT_ANTENNAS`. Reply is plain text.

---

## POST /direct_tracker/set_interpolation

Set weight interpolation mode (e.g. nearest-grid vs. linear).

**Request JSON:** `{"enabled": true}` — confirmed against source
(lines ~350–361). Toggles subframe phase interpolation (linear weight
interpolation within a frame vs. per-frame weights). Reply is plain text.

---

## GET /direct_tracker/status

Full tracker state.

**Response JSON:**

```json
{
  "active_antennas": 42,
  "active_raw_elements": [0, 1, 5, ...],
  "num_active_beams": 2,
  "subframe_interpolation_enabled": true,
  "beams": [
    {
      "beam_id": 0,
      "l0": 0.12, "m0": -0.03, "n0": 0.9923,
      "grid_index": 1234,
      "celestial_target": {"is_set": true, "ra_deg": 83.63, "dec_deg": 22.01}
    }
  ]
}
```

`beams` contains one entry per active beam (`num_active_beams`).
`celestial_target.is_set` is `false` when steered via direction cosines.

---

## Viewer Routine Endpoints (viewer REST, not kotekan)

These are served by the viewer itself when started with `--routine`.

### GET /api/routine

Live routine state. `enabled: false` stub when the routine is off.

```json
{
  "enabled": true,
  "num_beams": 4,
  "date_local": "2026-10-07",
  "step_minutes": 60,
  "current_slot": {
    "time_local": "18:00",
    "assignments": [
      {"beam_id": 0, "label": "PSR J1644-4559", "ra_deg": 251.2, "dec_deg": -46.0, "altitude_deg": 75.7},
      {"beam_id": 1, "label": "PKS B1934-638", "ra_deg": 294.85, "dec_deg": -63.71, "altitude_deg": 53.0},
      {"beam_id": 2, "label": "Sgr A* / Galactic Center", "ra_deg": 266.42, "dec_deg": -29.01, "altitude_deg": 83.2},
      {"beam_id": 3, "label": "3C 353", "ra_deg": 260.12, "dec_deg": -0.98, "altitude_deg": 57.6}
    ]
  },
  "next_slot_time_local": "19:00",
  "beam_names": {"0": "PSR J1644-4559", "1": "PKS B1934-638", "2": "Sgr A* / Galactic Center", "3": "3C 353"},
  "last_applied_local": "2026-10-07 18:00:00",
  "last_error": null
}
```

### GET /api/routine/schedule

Full precomputed set-hour table (same shape as `current_slot` per slot).
`404` when the routine is off.

### POST /api/routine/apply

Force-apply the slot that is current right now (re-points all beams).
`404` when the routine is off.

### WebSocket `/ws`

Routine state changes are pushed as `{"type": "routine", "data": <routine state>}`
(the same payload as `GET /api/routine`); the latest state is sent on connect.

## Conventions (from CHARTS AGENTS.md §2.1)

- Direction cosines `(l, m, n)`, `n = sqrt(1 - l^2 - m^2)`, ENU topocentric frame.
- RA/Dec in degrees, J2000.
- Poll `/status` at 1–5 Hz for live display; do not poll faster than the
  kotekan frame cadence. **The viewer polls at 2 Hz from a single server-side
  poller** and fans out to browsers over WebSocket — see docs/PLANNING.md.
- All POST endpoints reply with **plain text** (not JSON) on success.
