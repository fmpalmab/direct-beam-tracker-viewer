# Direct Beam Tracker & RFI/SEFD Viewer REST API Reference

Verified against `kotekan/lib/cuda/cudaDirectBeamTrackerCommand.cpp`,
`kotekan/lib/cuda/cudaRfiMitigationCommand.cpp`, and
`kotekan/lib/cuda/cudaAntennaMaskCommand.cpp`.

Base URL (Kotekan): `http://<host>:12048`  
Base URL (Viewer): `http://<host>:8088`

---

## 1. Kotekan Direct Tracker Endpoints (`/direct_tracker/...`)

All `/direct_tracker/...` endpoints also accept `/beam_tracker/...` aliases.

### `GET /direct_tracker/status`

Returns tracker state, spatial taper, calibration status, active antennas, LST, and active beams:

- `active_antennas`, `active_raw_elements`, `active_physical_antennas`
- `num_active_beams`, `max_beams`, `subframe_interpolation_enabled`
- `taper_type`, `taper_pedestal`, `normalize_weights`, `enable_weight_bislc`, `bislc_diagonal_loading`
- `apply_calibration_gains`, `gains_file`, `gains_generation`, `current_lst_hours`
- `beams`: array of `{beam_id, l0, m0, n0, l1, m1, dl, dm, grid_index, calibrated, celestial_target}`

### `POST /direct_tracker/set_target`
Steer a beam by ENU direction cosines `(l0, m0)` with optional `(l1, m1, dl, dm)` trajectory.

### `POST /direct_tracker/set_celestial_target`
Steer a beam by J2000 `(ra_deg, dec_deg)` coordinates.

### `POST /direct_tracker/enable_beam`
Set `{"num_active_beams": N}` (`1..16`).

### `POST /direct_tracker/set_interpolation`
Toggle `{"enabled": bool}` subframe weight interpolation.

### `POST /direct_tracker/set_taper`
Update 2D spatial taper and normalization:
```json
{
  "taper_type": "cosine_pedestal",
  "taper_pedestal": 0.25,
  "normalize_weights": true,
  "enable_weight_bislc": false,
  "bislc_diagonal_loading": 0.0001
}
```
Valid `taper_type` values: `"none"`, `"uniform"`, `"cosine_pedestal"`, `"hamming"`, `"blackman"`, `"blackman_pedestal"`, `"gaussian"`.

### `POST /direct_tracker/set_calibration`
Toggle calibration gains globally (`{"enabled": true}`) or per beam (`{"beam_id": 0, "enabled": false}`) for live A/B testing.

### `POST /direct_tracker/reload_gains`
Hot-reload a `(672, 64)` `complex64` `.npy` gain table:
```json
{"gains_file": "/data/calibration/corr_1113/gains_corr_1113_0_4_32_36_freqflt_672x64.npy"}
```
Returns JSON `{"status": "ok", "gains_file": "...", "gains_generation": 2, "instances": 2}`.

### `GET /direct_tracker/beam_power`
Returns stitched 672-channel beam power spectra `[max_beams][672]`.

---

## 2. Kotekan Real-Time RFI Mitigation Endpoints (`/rfi_mitigation/...`)

### `GET /rfi_mitigation/status`
Returns active thresholds/toggles (`enabled`, `blank_voltages_enabled`, `enable_sk_check`, `sk_sigma_threshold`, `enable_time_burst_check`, `burst_sigma_threshold`, `enable_freq_mad_check`, `freq_window_half_width`, `mad_sigma_threshold`, `enable_saturation_check`, `saturation_fraction_threshold`, `enable_morphology_sir`, `edge_channels_to_ignore`, `enable_persistent_ema`, `ema_alpha`, `static_notch_bands_mhz`) plus summary counters (`total_channels`, `flagged_channels`, `overall_flagged_chunk_fraction`, `top_rfi_channels`).

### `GET /rfi_mitigation/channels`
Returns 672 per-channel stats (`freq_mhz`, `subband`, `local_channel`, `mean_power`, `mean_sk`, `max_sk`, `freq_mad_z`, `flagged_chunk_fraction`, `flag_bits`, `gain`).

`flag_bits` bitmask (`cudaRfiMitigation.hpp` `RfiFlagReason`):
- `1 << 0` (`1`): `RFI_SK_IMPULSIVE`
- `1 << 1` (`2`): `RFI_SK_CW_TONE`
- `1 << 2` (`4`): `RFI_TIME_BURST`
- `1 << 3` (`8`): `RFI_FREQ_MAD`
- `1 << 4` (`16`): `RFI_STATIC_NOTCH`
- `1 << 5` (`32`): `RFI_SATURATION_CLIP`
- `1 << 6` (`64`): `RFI_MORPHOLOGY_SIR`

### `POST /rfi_mitigation/configure`
Partial or full JSON update of any RFI toggle, threshold, `static_notch_bands_mhz` (`[[lo, hi], ...]`), or `reset_ema: true`.

### `POST /rfi_mitigation/reset_ema`
Reset persistent EMA baseline globally (`{"all": true}`) or selectively (`{"freq_mhz": [382.2, 414.0]}`). Returns JSON.

### `POST /rfi_mitigation/set_gains`
Push 336-channel smooth passband pre-whitening gains per subband:
`{"freq_start_hz": 300000000.0, "gains": [...]}`.

---

## 3. Kotekan Antenna Mask & Channel Power Endpoints (`/antenna_mask/...`)

- `GET /antenna_mask/status`: per-element health metrics (`power_rms`, `clip_fraction`, `kurtosis`, `coherence`, `passband_power`, `robust_z_score`, `status`) and `subbands`.
- `GET /antenna_mask/channel_power`: per-subband `[n_local_freq][64]` power matrix in `LSB²` (`mean_active_power`, `channel_power`, `active_physical_antennas`).
- `POST /antenna_mask/mask_antenna`, `POST /antenna_mask/configure`, `POST /antenna_mask/reset`.

---

## 4. Viewer REST & WebSocket Endpoints (`/api/...`, `/ws`)

Mutating `POST` routes enforce `X-API-Token` / `Authorization: Bearer` when `--api-token` / `VIEWER_API_TOKEN` is configured.

| Route | Method | Description |
|---|---|---|
| `/api/status` | `GET` | Latest polled `Status` |
| `/api/history`, `/api/history/all` | `GET` | Ring buffer `(l0, m0)` beam history |
| `/api/health` | `GET` | `{kotekan_reachable, poll_interval_s, spectrometer_interval_s, uptime_s}` |
| `/api/spectrometer`, `/api/spectrometer/{beam_id}` | `GET` | Formed-beam 672-ch line spectra |
| `/api/beam_power` | `GET` | Latest stitched `BeamPowerResponse` |
| `/api/rfi` | `GET` | Latest `RfiStatus` |
| `/api/rfi/channels` | `GET` | Latest 672-ch `RfiChannelsResponse` |
| `/api/rfi/configure` | `POST` | Proxy validated `RfiConfigureRequest` -> Kotekan |
| `/api/rfi/reset_ema` | `POST` | Proxy `RfiResetEmaRequest` -> Kotekan |
| `/api/rfi/prewhiten` | `POST` | Compute smooth SB0/SB1 pre-whitening gains from `/rfi_mitigation/channels` & push |
| `/api/sefd` | `GET` | Live `SefdSensitivitySummary` (4-bit quantizer `sigma`/`eta_q`, elevation-corrected `SEFD_beam`, `sigma_S`, `F_min`) |
| `/api/taper` | `POST` | Proxy validated `TaperRequest` -> `/direct_tracker/set_taper` |
| `/api/calibration/toggle` | `POST` | Proxy `CalibrationToggleRequest` -> `/direct_tracker/set_calibration` |
| `/api/calibration/reload` | `POST` | Convert `.npz` via `charts-utils` (optional `zero_flagged`, `sync_rfi_notches`) & hot-reload `.npy` |
| `/api/antenna_mask` | `GET` | Latest `AntennaMaskStatus` with 84-bin spectra |
| `/api/antennas/{antenna_id}/spectrum` | `GET` | 672-ch antenna spectrum from `/antenna_mask/channel_power` |
| `/api/antennas/mask`, `/api/antennas/auto_detect`, `/api/antennas/unmask_all` | `POST` | Masking controls |
| `/api/beams/{id}/target`, `/api/beams/{id}/celestial`, `/api/beams/enable`, `/api/interpolation` | `POST` | Direct tracker steering & controls |
| `/api/routine`, `/api/routine/schedule`, `/api/routine/apply` | `GET`/`POST` | Precomputed observation routine |
| `/ws` | `WS` | Sends initial snapshots and live pushes (`status`, `spectrometer`, `rfi`, `sefd`, `antenna_mask`, `routine`) |
