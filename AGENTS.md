# AGENTS.md — Direct Beam Tracker & Web Viewer

Operational runbook and agent reference for running the **Kotekan Direct Beam Tracker** pipeline (`cudaAntennaMaskCommand` -> `cudaRfiMitigationCommand` -> `cudaDirectBeamTrackerCommand`) and the **Direct Beam Tracker Viewer** web application persistently on the processing node (`ms-x00`).

---

## 1. System Architecture & Topology

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

* **Kotekan REST Server**: Runs on `http://127.0.0.1:12048`. Exposes `/direct_tracker/*`, `/rfi_mitigation/*`, and `/antenna_mask/*` (including `/antenna_mask/channel_power` for 672-ch per-antenna spectra without needing any correlator).
* **Viewer Server**: Runs on `http://0.0.0.0:8088`. Serves the 4-tab static dashboard (Tracker, RFI Mitigation, SEFD/Sensitivity/Calibration, 8×8 Array Health), polls Kotekan from one background `StatusPoller`, computes live 4-bit quantizer & tied-array SEFD diagnostics via `viewer.sefd_utils` (`charts-sefd` + `charts-utils`), and broadcasts over WebSocket `/ws`.
* **Array Convention**: 64 total elements across 2 RFSoCs. RFSoC raw buffer ordering is descending: $\text{raw\_element} = 63 - \text{physical\_antenna}$.

---

## 2. Running Persistently Across CLI / SSH Disconnects

Because Kotekan binds to physical 100GbE hardware interfaces via DPDK and `/dev/vfio/*`, it requires root (`sudo`). Use one of the three verified methods below to ensure both Kotekan and the Viewer stay up continuously.

### Method 1: Using Helper Scripts (Fastest & Recommended)

```bash
cd /home/fpalma/direct-beam-tracker-viewer
./scripts/start_pipeline.sh           # Standard tracker + viewer
./scripts/start_routine_10beams.sh    # 10-beam tracker + hourly observation routine
./scripts/status_pipeline.sh          # Check PIDs and REST health
./scripts/stop_pipeline.sh            # Stop both services cleanly
```

### Method 2: GNU Screen Sessions

```bash
sudo rm -f /dev/hugepages/rtemap_*

# Screen 1: Kotekan Direct Beam Tracker
screen -dmS kotekan bash -c "sudo /home/fpalma/kotekan/build/kotekan/kotekan -c /home/fpalma/kotekan/charts/config/64antennas_direct_tracker_10beams.yaml -b 127.0.0.1:12048 2>&1 | tee /home/fpalma/kotekan/kotekan_run.log"

# Screen 2: Web Viewer & Observation Routine
screen -dmS viewer bash -c "cd /home/fpalma/direct-beam-tracker-viewer && uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 --routine --routine-targets tools/verified_targets_10beams.json --routine-beams 10 --routine-step-minutes 60 2>&1 | tee /home/fpalma/direct-beam-tracker-viewer/viewer.log"
```

### Method 3: Systemd Services

Unit files live in `systemd/`:
```bash
sudo cp /home/fpalma/direct-beam-tracker-viewer/systemd/kotekan-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kotekan-tracker.service

mkdir -p ~/.config/systemd/user
cp /home/fpalma/direct-beam-tracker-viewer/systemd/direct-tracker-viewer.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now direct-tracker-viewer.service
```

---

## 3. Verification & Health Checks

```bash
# 1. Kotekan Direct Tracker, RFI & Channel Power
curl -s http://127.0.0.1:12048/direct_tracker/status | jq '{active_antennas, active_physical_antennas, num_active_beams, taper_type, gains_generation}'
curl -s http://127.0.0.1:12048/rfi_mitigation/status | jq '{enabled, blank_voltages_enabled, flagged_channels, overall_flagged_chunk_fraction}'
curl -s http://127.0.0.1:12048/antenna_mask/channel_power | jq '{num_elements, subbands: [.subbands[] | {subband, num_local_freq, has_channel_power}]}'

# 2. Viewer Health, RFI, and SEFD Summary
curl -s http://localhost:8088/api/health | jq .
curl -s http://localhost:8088/api/rfi | jq '{enabled, flagged_channels, overall_flagged_chunk_fraction}'
curl -s http://localhost:8088/api/sefd | jq '{n_alive, quantizer_sigma_lsb, quantizer_eta_q, clean_bandwidth_mhz, array_zenith_sefd_jy, array_sigma_s_1s_jy}'
```

---

## 4. Operator Browser Access

```bash
# SSH tunnel from any laptop:
ssh -L 8088:localhost:8088 fpalma@ms-x00
# Open http://localhost:8088
```
