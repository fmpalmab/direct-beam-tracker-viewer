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

Enable or disable beams / set the number of active beams.

**Request JSON:** e.g. `{"beam_id": 2, "enabled": true}` or
`{"num_active_beams": 4}` (see source for exact accepted keys — confirm
against `cudaDirectBeamTrackerCommand.cpp` lines ~316–346).

---

## POST /direct_tracker/mask_antenna

Mask/unmask an antenna element.

**Request JSON:** antenna index and mask flag (confirm exact keys in source,
lines ~346–360). Masked antennas are excluded from beamforming.

---

## POST /direct_tracker/set_interpolation

Set weight interpolation mode (e.g. nearest-grid vs. linear).

**Request JSON:** interpolation mode selector (confirm keys in source,
lines ~360–420).

---

## GET /direct_tracker/status

Full tracker state.

**Response JSON:**

```json
{
  "active_antennas": 42,
  "active_raw_elements": [0, 1, 5, ...],
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

## Conventions (from CHARTS AGENTS.md §2.1)

- Direction cosines `(l, m, n)`, `n = sqrt(1 - l^2 - m^2)`, ENU topocentric frame.
- RA/Dec in degrees, J2000.
- Poll `/status` at 1–5 Hz for live display; do not poll faster than the
  kotekan frame cadence.
