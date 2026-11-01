---
name: direct-beam-tracker-pipeline
description: >-
  Guides setup, execution, verification, and operation of the dedicated 64-Antenna Dual-NIC 100GbE DPDK
  Direct Beam Tracker pipeline in Kotekan and the real-time observatory dashboard in direct-beam-tracker-viewer on ms-x00.
  Use when launching, configuring, testing, or monitoring the standalone direct beam tracker pipeline and viewer.
---

# 64-Antenna DPDK Direct Beam Tracker Pipeline & Observatory Viewer

This skill provides operational procedures to configure, launch, and operate the **Dedicated 64-Antenna Dual-NIC 100GbE DPDK Direct Beam Tracker Pipeline** on the processing node (`ms-x00`: RTX 5090 GPU, Dual 100GbE Intel E810-C) and the real-time web viewer.

> **Note on Architecture:** The CHARTS project dedicates `ms-x00` strictly to the **Direct Beam Tracker (B-Engine)** and web viewer. Other subsystems (such as the full $N^2$ correlator or transient trigger search) are separated onto their own dedicated processing nodes rather than co-located on `ms-x00`.

---

## 1. System Architecture

```
+-----------------------------------------------------------------------------------+
| Processing Node: ms-x00 (Ubuntu 24.04, RTX 5090 GPU, Dual 100GbE Intel E810-C)     |
|                                                                                   |
|  [RFSoC 1: Ports 0..31]  ──> 100GbE NIC (0000:70:00.0) ──┐                        |
|  [RFSoC 0: Ports 32..63] ──> 100GbE NIC (0000:8f:00.0) ──┴──> [dpdkCore]          |
|                                                                   │ (105 Gbps)    |
|                                                  [network_capture_buf_0 / 1]      |
|                                                                   │               |
|                                                       [cudaAntennaMaskCommand]    |
|                                                                   │ (Alive: 5 ant)|
|                                                    [cudaDirectBeamTrackerCommand] |
|                                                                   │ (10 Beams)    |
|                                                       [host_formed_beams_buffer]  |
|                                                                   │               |
|                                                       Kotekan REST API (:12048)   |
|                                                                   ▲               |
|                                                                   │ (2 Hz poll)   |
|                                                        FastAPI Backend (:8088)    |
|                                                        [uv run viewer]            |
|                                                                   ▲               |
|                                                                   │ (WebSocket)   |
|  Operator Laptops / Workstations ─────────────────────────> Browser UI (:8088)    |
+-----------------------------------------------------------------------------------+
```

- **Data Ingest**: DPDK dual 100GbE streams (Subband 0: 300.0–400.8 MHz, Subband 1: 400.8–501.3 MHz; 672 channels total). Line rate: 105.2 Gbps with 0 packet drops.
- **Antenna Masking**: `cudaAntennaMaskCommand` auto-detects floating/open lines (`dead_power_threshold: 1.0`), preserving the 5 healthy physical antennas `[32, 6, 5, 4, 0]`.
- **Direct Beamforming**: `cudaDirectBeamTrackerCommand` forms up to 10 simultaneous astrometric tracking beams in VRAM with `normalize_weights: true`, sub-sample polynomial trajectory interpolation, and complex gain calibration from `charts/config/gains/gains_sun_transit_1027_interp.npy`.
- **Zero-Disk Invariant**: High-rate baseband voltages remain purely in GPU memory; only reduced spectral power (~27 KB) and telemetry cross PCIe.

---

## 2. Launching and Operating the Pipeline

### Helper Scripts (Recommended)

```bash
cd /home/fpalma/direct-beam-tracker-viewer

# 1. Start the 10-beam tracker + hourly observation routine
SUDO_PASS="FP_Charts123!" ./scripts/start_routine_10beams.sh

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
screen -dmS kotekan bash -c "cd /home/fpalma/kotekan && echo 'FP_Charts123!' | sudo -S /home/fpalma/kotekan/build/kotekan/kotekan -c /home/fpalma/kotekan/charts/config/64antennas_direct_tracker_10beams.yaml -b 127.0.0.1:12048 2>&1 | tee /home/fpalma/kotekan/kotekan_run.log"

# Screen 2: Web Viewer & Observation Routine
screen -dmS viewer bash -c "cd /home/fpalma/direct-beam-tracker-viewer && uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 --routine --routine-targets /home/fpalma/direct-beam-tracker-viewer/tools/verified_targets_10beams.json --routine-beams 10 --routine-step-minutes 60 2>&1 | tee /home/fpalma/direct-beam-tracker-viewer/viewer.log"
```

---

## 3. Verification & Telemetry Checks

```bash
# 1. Direct Tracker Status
curl -s http://127.0.0.1:12048/direct_tracker/status | jq '{active_antennas, num_active_beams, normalize_weights, current_lst_hours}'

# 2. Formed Beam Power (672 channels)
curl -s http://127.0.0.1:12048/direct_tracker/beam_power | jq '{total_freq_channels, active_beams, max_beams, num_subbands}'

# 3. Viewer Health & Routine Status
curl -s http://localhost:8088/api/health | jq .
curl -s http://localhost:8088/api/routine | jq .
```
