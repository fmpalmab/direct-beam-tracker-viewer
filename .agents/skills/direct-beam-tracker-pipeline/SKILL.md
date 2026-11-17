---
name: direct-beam-tracker-pipeline
description: >-
  Guides setup, execution, verification, and operation of the dedicated 64-Antenna Dual-NIC 100GbE DPDK
  Direct Beam Tracker pipeline (with real-time GPU RFI mitigation and SEFD/calibration monitoring) in Kotekan
  and the real-time observatory dashboard in direct-beam-tracker-viewer on ms-x00.
  Use when launching, configuring, testing, or monitoring the standalone direct beam tracker pipeline and viewer.
---

# 64-Antenna DPDK Direct Beam Tracker Pipeline & Observatory Viewer

This skill provides operational procedures to configure, launch, and operate the **Dedicated 64-Antenna Dual-NIC 100GbE DPDK Direct Beam Tracker Pipeline** on the processing node (`ms-x00`: RTX 5090 GPU, Dual 100GbE Intel E810-C) and the real-time web viewer.

> **Note on Architecture:** The CHARTS project dedicates `ms-x00` strictly to the **Direct Beam Tracker** (`cudaAntennaMaskCommand` -> `cudaRfiMitigationCommand` -> `cudaDirectBeamTrackerCommand`) and web viewer. Full $N^2$ correlation and offline calibration pipelines run separately (or via `charts-utils` / `charts-sefd`), feeding gain solutions and sensitivity models into the viewer.

---

## 1. System Architecture

```
+-----------------------------------------------------------------------------------+
| Processing Node: ms-x00 (Ubuntu 24.04, RTX 5090 GPU, Dual 100GbE Intel E810-C)     |
|                                                                                   |
|  [RFSoC 1: Ports 0..31]  ──> 100GbE NIC (0000:70:00.0) ──┐                        |
|  [RFSoC 0: Ports 32..63] ──> 100GbE NIC (0000:8f:00.0) ──┴──> [dpdkCore]          |
|                                                                   │ (105.2 Gbps)  |
|                                                  [network_capture_buf_0 / 1]      |
|                                                                   │               |
|                                                       [cudaAntennaMaskCommand]    |
|                                                  (/antenna_mask/channel_power)    |
|                                                                   │               |
|                                                       [cudaRfiMitigationCommand]  |
|                                                  (SK / Burst / MAD / EMA / Notch) |
|                                                                   │               |
|                                                    [cudaDirectBeamTrackerCommand] |
|                                                  (Taper / Cal Gains / 1-16 Beams) |
|                                                                   │               |
|                                                       Kotekan REST API (:12048)   |
|                                                                   ▲               |
|                                                                   │ (1–4 Hz poll) |
|                                                        FastAPI Backend (:8088)    |
|                                                  [uv run viewer + sefd_utils]     |
|                                                                   ▲               |
|                                                                   │ (WebSocket)   |
|  Operator Laptops / Workstations ─────────────────────────> Browser UI (:8088)    |
+-----------------------------------------------------------------------------------+
```

- **Data Ingest**: DPDK dual 100GbE streams (Subband 0: 300.0–400.5 MHz, Subband 1: 400.8–501.3 MHz; 672 channels total). Line rate: 105.24 Gbps with 0 packet drops.
- **Antenna Masking**: `cudaAntennaMaskCommand` v2.0 evaluates passband power, spatial coherence, and per-channel antenna power (`GET /antenna_mask/channel_power`) without needing a correlator.
- **Real-Time RFI Mitigation**: `cudaRfiMitigationCommand` performs in-place GPU Spectral Kurtosis (SK), temporal burst MAD, sliding passband MAD, saturation clipping, 1D SIR morphology, persistent EMA tracking, and static notching before beamforming.
- **Direct Beamforming & Calibration**: `cudaDirectBeamTrackerCommand` v2.5 applies 2D spatial tapers and fused complex calibration gains (`POST /direct_tracker/reload_gains`, `POST /direct_tracker/set_taper`, `POST /direct_tracker/set_calibration`).
- **SEFD & Calibration Bridge**: `viewer.sefd_utils` bridges `charts-sefd` and `charts-utils` to compute 4-bit quantizer diagnostics (`sigma`, `eta_q`), elevation-corrected tied-array SEFD, radiometer sensitivity (`sigma_S`, `F_min`), passband pre-whitening gains, and `.npz` -> `(672, 64)` `.npy` hot-reloading.

---

## 2. Launching and Operating the Pipeline

### Helper Scripts (Recommended)

```bash
cd /home/fpalma/direct-beam-tracker-viewer

# 1. Start the 10-beam tracker + hourly observation routine (uses standard sudo for DPDK)
./scripts/start_routine_10beams.sh

# 2. Check live status, PIDs, and REST health
./scripts/status_pipeline.sh

# 3. Stop both services cleanly
./scripts/stop_pipeline.sh
```

### Manual Screen Sessions

```bash
# Clean stale hugepages:
sudo rm -f /dev/hugepages/rtemap_*

# Screen 1: Kotekan Direct Beam Tracker
screen -dmS kotekan bash -c "cd /home/fpalma/kotekan && sudo /home/fpalma/kotekan/build/kotekan/kotekan -c /home/fpalma/kotekan/charts/config/64antennas_direct_tracker_10beams.yaml -b 127.0.0.1:12048 2>&1 | tee /home/fpalma/kotekan/kotekan_run.log"

# Screen 2: Web Viewer & Observation Routine
screen -dmS viewer bash -c "cd /home/fpalma/direct-beam-tracker-viewer && uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 --routine --routine-targets /home/fpalma/direct-beam-tracker-viewer/tools/verified_targets_10beams.json --routine-beams 10 --routine-step-minutes 60 2>&1 | tee /home/fpalma/direct-beam-tracker-viewer/viewer.log"
```

---

## 3. Verification & Telemetry Checks

```bash
# 1. Direct Tracker Status
curl -s http://127.0.0.1:12048/direct_tracker/status | jq '{active_antennas, num_active_beams, taper_type, apply_calibration_gains, gains_generation, current_lst_hours}'

# 2. Real-Time RFI Status
curl -s http://127.0.0.1:12048/rfi_mitigation/status | jq '{enabled, blank_voltages_enabled, flagged_channels, overall_flagged_chunk_fraction}'

# 3. Viewer Health, RFI & SEFD Summary
curl -s http://localhost:8088/api/health | jq .
curl -s http://localhost:8088/api/rfi | jq '{enabled, flagged_channels, overall_flagged_chunk_fraction}'
curl -s http://localhost:8088/api/sefd | jq '{n_alive, quantizer_sigma_lsb, quantizer_eta_q, clean_bandwidth_mhz, array_zenith_sefd_jy, array_sigma_s_1s_jy}'
```
