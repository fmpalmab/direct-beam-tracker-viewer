# AGENTS.md — Direct Beam Tracker & Web Viewer

Operational runbook and agent reference for running the **Kotekan Direct Beam Tracker** pipeline and the **Direct Beam Tracker Viewer** web application persistently on the processing node (`ms-x00`).

---

## 1. System Architecture & Topology

```
+-----------------------------------------------------------------------------------+
| Processing Node: ms-x00 (Ubuntu 24.04, RTX 5090 GPU, Dual 100GbE Intel E810-C)     |
|                                                                                   |
|  [RFSoC 1: Ports 0..31]  ──> 100GbE NIC (0000:70:00.0) ──┐                        |
|  [RFSoC 0: Ports 32..63] ──> 100GbE NIC (0000:8f:00.0) ──┴──> [dpdkCore]          |
|                                                                   │               |
|                                                  [network_capture_buf_0 / 1]      |
|                                                                   │               |
|                                                       [cudaAntennaMaskCommand]    |
|                                                                   │               |
|                                                    [cudaDirectBeamTrackerCommand] |
|                                                                   │               |
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

* **Kotekan REST Server**: Runs on `http://127.0.0.1:12048`. Exposes `/direct_tracker/status`, `/antenna_mask/status`, `/direct_tracker/set_celestial_target`, etc.
* **Viewer Server**: Runs on `http://0.0.0.0:8088`. Serves static HTML/JS/CSS, runs single 2 Hz poller to Kotekan REST, and broadcasts telemetry to browser WebSocket clients.
* **Array Convention**: 64 total antennas across 2 RFSoCs. RFSoC raw buffer ordering is strictly descending: $\text{raw\_element} = 63 - \text{physical\_antenna}$. Currently active/alive antennas: `[0, 4, 5, 6, 32]`, corresponding to raw elements `[63, 59, 58, 57, 31]`.

---

## 2. Running Persistently Across CLI / SSH Disconnects

Because Kotekan binds to physical 100GbE hardware interfaces via DPDK and `/dev/vfio/*`, it requires root (`sudo`). When you close your terminal or the AI CLI exits, processes attached to that shell receive `SIGHUP` and terminate unless detached.

Use one of the three verified methods below to ensure both Kotekan and the Viewer stay up continuously.

### Method 1: Using Helper Scripts (Fastest & Recommended)

Three pre-configured scripts live in `scripts/`:

```bash
# 1. Start both Kotekan (24h tracker) and the Web Viewer in detached background sessions
cd /home/fpalma/direct-beam-tracker-viewer
./scripts/start_pipeline.sh

# 2. Check live status, PIDs, and REST API health of both services
./scripts/status_pipeline.sh

# 3. Stop both services cleanly
./scripts/stop_pipeline.sh
```

---

### Method 2: GNU Screen Sessions (Interactive & Reattachable)

`screen` is installed natively on `ms-x00` (`/usr/bin/screen`).

#### Step 1: Start Kotekan in a detached screen
```bash
# Clean up any stale DPDK hugepages first:
echo 'FP_Charts123!' | sudo -S rm -f /dev/hugepages/rtemap_*

# Launch Kotekan inside a screen named 'kotekan':
screen -dmS kotekan bash -c "echo 'FP_Charts123!' | sudo -S /home/fpalma/kotekan/build/kotekan/kotekan -c /home/fpalma/kotekan/charts/config/64antennas_direct_tracker.yaml -b 127.0.0.1:12048 2>&1 | tee /home/fpalma/kotekan/kotekan_run.log"
```

#### Step 2: Start the Viewer in a detached screen
```bash
# Launch the web viewer inside a screen named 'viewer':
screen -dmS viewer bash -c "cd /home/fpalma/direct-beam-tracker-viewer && uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 2>&1 | tee /home/fpalma/direct-beam-tracker-viewer/viewer.log"
```

To run the precomputed observation routine (up to 10 beams locked on
the highest-elevation verified targets, re-pointed at set hours):
```bash
# Fastest: Start the full 10-beam pipeline (Kotekan + Viewer Routine)
cd /home/fpalma/direct-beam-tracker-viewer
./scripts/start_routine_10beams.sh

# Or manually in screens:
screen -dmS kotekan bash -c "echo 'FP_Charts123!' | sudo -S /home/fpalma/kotekan/build/kotekan/kotekan -c /home/fpalma/kotekan/charts/config/64antennas_direct_tracker_10beams.yaml -b 127.0.0.1:12048 2>&1 | tee /home/fpalma/kotekan/kotekan_run.log"

screen -dmS viewer bash -c "cd /home/fpalma/direct-beam-tracker-viewer && uv run viewer --host 0.0.0.0 --port 8088 --kotekan http://127.0.0.1:12048 --routine --routine-targets verified_targets_10beams.json --routine-beams 10 --routine-step-minutes 60 2>&1 | tee /home/fpalma/direct-beam-tracker-viewer/viewer.log"
```
The routine state is visible in the header badge, `GET /api/routine`, and the
`routine` WebSocket stream; `POST /api/routine/apply` re-points immediately.

### Priority Ranked 10-Beam Target Catalog (`verified_targets_10beams.json`)

| Rank | Target | RA / Dec (J2000) | Transit Alt (Zenith) | Category | Primary Operational Objective |
|:---:|:---|:---|:---:|:---|:---|
| 1 | **NGC 1316 (Fornax A)** | 03h 22m 42s / -37° 12' 30" (50.6750°, -37.2083°) | 86.2° (3.8°) | Calibration / Radio Galaxy | Complex gain/phase calibration; transit amplitude baseline. |
| 2 | **The Sun** | Ephemeris / Variable (198.3903°, -7.7872°) | >80° summer (64.4° mid-Oct) | Solar System | First-light beamforming test, element health, sanity check. |
| 3 | **PSR B0826-34** | 08h 28m 10s / -34° 17' 24" (127.0417°, -34.2900°) | 89.1° (0.9°) | Pulsar Testbed | Broadside dedispersion verification (zero steering aberration). |
| 4 | **Vela Pulsar (B0833-45)** | 08h 35m 20s / -45° 10' 54" (128.8333°, -45.1817°) | 78.2° (11.8°) | Pulsar Testbed | High-SNR single-pulse test for dynamic beam tracking. |
| 5 | **NGC 253 (Sculptor)** | 00h 47m 33s / -25° 17' 18" (11.8875°, -25.2883°) | 81.9° (8.1°) | Primary FRB Target | Core-collapse magnetar hunting (proven magnetar flare host). |
| 6 | **Fornax Cluster Core** | 03h 38m 29s / -35° 27' 03" (54.6208°, -35.4508°) | 88.0° (2.0°) | Primary FRB Target | Beam-multiplexed globular cluster search (6,000+ GCs). |
| 7 | **Centaurus A (NGC 5128)** | 13h 25m 28s / -43° 01' 09" (201.3667°, -43.0192°) | 80.4° (9.6°) | Dual (Calib + FRB) | Secondary flux scale + proximate (3.8 Mpc) merger monitor. |
| 8 | **The Antennae (NGC 4038/39)** | 12h 01m 53s / -18° 52' 10" (180.4708°, -18.8694°) | 75.5° (14.6°) | Secondary FRB Target | Active merger with young massive star clusters. |
| 9 | **Pictor A / Hydra A** | Pictor: 05h 19m / -45° 46' (79.7500°, -45.7667°)<br>Hydra: 09h 18m / -12° 05' (139.5000°, -12.0833°) | 77.7° (12.3°)<br>68.7° (21.3°) | Compact Calibrator | Compact source beam shape and sidelobe pattern mapping. |
| 10 | **NGC 612 (PKS 0131-36)** | 01h 33m 58s / -36° 29' 36" (23.4917°, -36.4933°) | 86.9° (3.1°) | Secondary Baseline | Near-zenith FRB deep search with low foreground confusion. |

#### Managing Screens
* View active sessions: `screen -ls`
* Attach to Kotekan log view: `screen -r kotekan` (Press `Ctrl+A, D` to detach without stopping)
* Attach to Viewer log view: `screen -r viewer` (Press `Ctrl+A, D` to detach)
* Kill a session: `screen -S kotekan -X quit`

---

### Method 3: Systemd Services (Automatic Reboot & Production)

Unit files are provided in `systemd/`:

#### 1. Systemd service for Kotekan (`systemd/kotekan-tracker.service`)
Copy to systemd:
```bash
sudo cp /home/fpalma/direct-beam-tracker-viewer/systemd/kotekan-tracker.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now kotekan-tracker.service
```

#### 2. Systemd user service for Viewer (`systemd/direct-tracker-viewer.service`)
Enable for user `fpalma`:
```bash
mkdir -p ~/.config/systemd/user
cp /home/fpalma/direct-beam-tracker-viewer/systemd/direct-tracker-viewer.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now direct-tracker-viewer.service
```

#### Status and Logs:
```bash
sudo systemctl status kotekan-tracker
systemctl --user status direct-tracker-viewer
journalctl -u kotekan-tracker -f
```

---

## 3. Verification & Health Checks

Once launched, verify end-to-end telemetry from any terminal:

### 1. Kotekan REST Telemetry
```bash
curl -s http://127.0.0.1:12048/direct_tracker/status | jq .
```
Expected output:
* `"num_active_beams": 2`
* `"active_antennas": 5`
* `"active_physical_antennas": [32, 6, 5, 4, 0]`
* `"active_raw_elements": [31, 57, 58, 59, 63]`
* Beam 0: Target RA 266.4168°, Dec -29.0078° (Sagittarius A*, near zenith $n_0 \approx 0.995$)
* Beam 1: Target RA 128.8361°, Dec -45.1764° (Vela Pulsar, rising $n_0 > 0$)

### 2. Viewer Health Check
```bash
curl -s http://localhost:8088/api/health | jq .
# Returns: {"kotekan_reachable": true, "poll_interval_s": 0.5, "uptime_s": ...}
```

### 3. Viewer Status Aggregator
```bash
curl -s http://localhost:8088/api/status | jq .
```

---

## 4. Operator Browser Access

### Option A: Direct LAN Access
If connected to the observatory LAN/VPN:
Browse directly to:
```
http://<ms-x00-ip>:8088
```

### Option B: SSH Port Forwarding (From Any Laptop)
On your local machine:
```bash
ssh -L 8088:localhost:8088 fpalma@ms-x00
```
Then navigate your browser to:
```
http://localhost:8088
```

---

## 5. Troubleshooting & Maintenance

* **Port already in use**:
  ```bash
  # Check if another process is occupying 8088:
  ss -tulpn | grep 8088
  # Kill if necessary:
  fuser -k 8088/tcp
  ```
* **DPDK Hugepage Permission Denied**:
  If Kotekan fails with `open /dev/hugepages/rtemap_* Permission denied`, clean stale hugepage allocations from previous runs:
  ```bash
  echo 'FP_Charts123!' | sudo -S rm -f /dev/hugepages/rtemap_*
  ```
* **Kotekan Process Check**:
  ```bash
  pgrep -fl kotekan
  ```
* **Viewer Log Inspection**:
  ```bash
  tail -f /home/fpalma/direct-beam-tracker-viewer/viewer.log
  tail -f /home/fpalma/kotekan/kotekan_run.log
  ```
