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
