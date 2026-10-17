---
name: tri-engine-pipeline
description: >-
  Guides setup, execution, verification, and operation of the 64-Antenna Dual-NIC 100GbE DPDK
  Tri-Engine pipeline in Kotekan and the 4-panel real-time observatory dashboard in direct-beam-tracker-viewer.
  Use when the user asks to launch, run, test, or configure the synthetic benchmark or live RFSoC DPDK pipeline.
---

# 64-Antenna DPDK Tri-Engine Pipeline & Observatory Viewer

This skill provides step-by-step procedures to configure, launch, and operate the **64-Antenna Dual-NIC 100GbE DPDK Tri-Engine Pipeline** on the RFSoC node (`NVIDIA RTX 5090` + `Intel Xeon w5-3525`) and the real-time zero-disk **4-Panel Observatory Dashboard**.

---

## 1. Architecture Quick Reference

The system couples Kotekan's high-performance C++/CUDA signal processing backend with an asynchronous Python/FastAPI WebSocket telemetry engine:

- **Engine 0 (Array Health & In-Place Masking):** `cudaAntennaMaskCommand` inspects 64 antenna elements across Subband 0 (300.0–400.5 MHz) and Subband 1 (400.8–501.3 MHz), detects dead or rail-clipped ADC channels, and zeroes bad voltages in VRAM before beamforming and correlation (`blank_voltages_enabled: true`).
- **Engine 1 (Direct Astrometric Tracker):** `cudaDirectBeamTrackerCommand` forms 4 steerable astrometric beams (e.g. Sgr A*, Vela Pulsar, Crab Pulsar, Transit) in VRAM and computes mean power spectra via warp-shuffle time reduction (`reduce_beam_power_kernel`).
- **Engine 2 (16-Beam 2D Sky Grid Camera):** `cudaDirectBeamTrackerCommand` synthesizes a $4 \times 4$ directional cosine $(l, m)$ grid with `grid_step: 0.02` rad (~1.15°) in VRAM for real-time transient detection and centroid tracking.
- **Engine 3 (Astron WMMA Tensor Core Correlator):** `cudaCorrelatorAstron` computes 2,080 cross-baselines and 64 autocorrelations. Integrated visibilities (5.68 MB per subband) transfer D2H for analysis.
- **Zero-Disk Invariant:** Formed beam voltages remain purely in GPU VRAM (`gpu_buffer_depth: 3`), eliminating 32.2 GB/s of PCIe bottleneck. Only reduced spectra (~27 KB) and integrated visibilities cross PCIe.

---

## 2. Mode A: Offline Synthetic Smoke Test (Zero Hardware Dependency)

Use this mode for offline testing, UI validation, and development without physical RFSoC or 100GbE hardware.

### Step 1: Build Kotekan (if not already compiled)
```bash
cmake --build /home/fpalma/kotekan/build --parallel
```

### Step 2: Launch the Tri-Engine Synthetic Pipeline
```bash
/home/fpalma/kotekan/build/kotekan/kotekan -c /home/fpalma/kotekan/charts/config/64antennas_tri_engine_benchmark.yaml
```
*Note: Kotekan will start its REST server on `127.0.0.1:12048` and execute 20 synthetic frames per run.*

### Step 3: Validate Port 12048 Endpoints
```bash
# Verify 4-beam direct tracker (672 channels)
curl -s http://127.0.0.1:12048/direct_tracker/beam_power | jq '{max_beams, num_subbands, total_freq_channels}'

# Verify 16-beam sky grid camera (672 channels)
curl -s http://127.0.0.1:12048/grid_tracker/beam_power | jq '{max_beams, num_subbands, total_freq_channels, grid_step_rad}'

# Verify 64-element array health & mask status
curl -s http://127.0.0.1:12048/antenna_mask/status | jq '{num_elements, blank_voltages_enabled, subbands: (.subbands | length)}'
```

### Step 4: Launch the Observatory Dashboard
In a separate terminal:
```bash
cd /home/fpalma/direct-beam-tracker-viewer
uv run viewer --kotekan-url http://127.0.0.1:12048 --port 8088
```
Open **`http://localhost:8088`** in your browser.

---

## 3. Mode B: Live 64-Antenna 100GbE DPDK Pipeline (RFSoC Production)

Use this mode on the RFSoC node (`Intel Xeon w5-3525` + `NVIDIA RTX 5090`) with live Dual Intel E810-C 100GbE streaming.

### Step 1: Verify Hardware Prerequisites
- Ensure 2MB / 1GB hugepages are allocated:
  ```bash
  cat /proc/meminfo | grep -i huge
  ```
- Ensure NIC interfaces are bound to DPDK driver (`vfio-pci` or `uio_pci_generic`):
  ```bash
  dpdk-devbind.py --status
  ```

### Step 2: Verify CPU Core Isolation
The production config reserves cores:
- Worker CPU Affinity: `[6, 7, 8, 9]`
- DPDK Ingest lcores: `[3, 5]` (Port 0 on core 3, Port 1 on core 5)
- DPDK Master Coordinator lcore: `4`

### Step 3: Launch Production Pipeline with `sudo`
```bash
sudo /home/fpalma/kotekan/build/kotekan/kotekan -c /home/fpalma/kotekan/charts/config/64antennas_tri_engine_dpdk.yaml
```

### Step 4: Launch Dashboard
```bash
cd /home/fpalma/direct-beam-tracker-viewer
uv run viewer --kotekan-url http://127.0.0.1:12048 --port 8088
```

---

## 4. Observatory Dashboard Operations Guide

The dashboard at `http://localhost:8088` features 4 real-time telemetry panels:

### Persistent Top Status Bar
- **System Indicator**: Green pulsating dot indicates live connection to Kotekan REST & WebSocket streams.
- **RF Band**: Displays active band `300.0 – 501.6 MHz` (672 coarse channels).
- **Subband Monitors**: Displays status of Subband 0 (`300.0 MHz`, Ch 0–335) and Subband 1 (`400.8 MHz`, Ch 336–671).
- **Antenna Health Badge**: Shows active elements count (e.g. `64/64 Active` or `60/64 Active (4 Masked)`).

### Tab 1 — Direct Astrometric Multi-Beam Tracker (Engine 1)
- **Polar Sky Map**: Plots directional cosine positions $(l, m)$ of all active beams within the unit circle horizon.
- **Spectrum Display**: 672-channel power spectrum with interactive beam toggles (Beams 0–3).
- **Waterfall Canvas**: Rolling time-frequency spectrogram showing signal intensity over time.
- **Target Steering Controls**:
  - Celestial presets: Steer to Sgr A*, Vela Pulsar, or Crab Pulsar.
  - Custom Coordinates: Enter target RA (hours/deg) and Dec (deg), or local directional cosines $(l, m)$.
  - Phase interpolation: Toggle between Nearest Frame, Linear, or Spline interpolation.

### Tab 2 — 16-Beam 2D Sky Grid Camera (Engine 2)
- **$4 \times 4$ Sky Heatmap**: Visualizes spatial power distribution across 16 beams spaced by 0.02 rad (~1.15°).
- **Contour Mode**: Toggles bicubic spatial upsampling for smooth brightness contours.
- **Subband Slicing**: Switch between Full Band (300–501.6 MHz), Lower Subband (300–400.8 MHz), or Upper Subband (400.8–501.6 MHz).
- **Centroid Coordinates**: Real-time display of peak transient coordinates $(l_{peak}, m_{peak})$ and SNR.

### Tab 3 — Astron WMMA Correlator & Visibilities (Engine 3)
- **$64 \times 64$ Correlation Matrix**: Side-by-side normalized correlation amplitude ($\|V_{ij}\| / \sqrt{V_{ii} V_{jj}}$) and phase ($\arg(V_{ij})$ in degrees).
- **Autocorrelation Bandpass**: Plots 672-channel bandpass for all 64 elements with filter presets for reference antennas (`0, 4, 6, 8, 32`).
- **Interactive Baseline Selector**: Click any $(i, j)$ cell in the matrix to view the 672-channel cross-power spectrum and fringe phase $\phi_{ij}(f)$.

### Tab 4 — 8×8 Array Health & RFSoC Masking (Engine 0)
- **Physical 64-Element Grid**: Interactive $8 \times 8$ antenna layout representing physical tile locations.
- **Diagnostic Telemetry**: Displays RMS power, 4-bit ADC rail clipping %, and health status (`OK`, `DEAD`, `SATURATED`, `MANUAL MASK`).
- **Interactive Masking**: Click any antenna tile to toggle its mask. The change applies synchronously to hardware blanking and beamformer tapers via `POST /api/antennas/mask`.

---

## 5. Automated Helper Scripts

Helper scripts are located in `scripts/`:

- **Run Synthetic Pipeline & Viewer Together**:
  ```bash
  ./.agents/skills/tri-engine-pipeline/scripts/run_synthetic.sh
  ```
- **Verify All Port 12048 Endpoints**:
  ```bash
  ./.agents/skills/tri-engine-pipeline/scripts/verify_pipeline.sh
  ```
- **Execute Pytest Test Suite**:
  ```bash
  uv run pytest -v
  ```
