// Direct Beam Tracker & Observatory Dashboard — Frontend Client
(function () {
  'use strict';

  const BEAM_COLORS = [
    '#00e5ff', '#ff9100', '#00e676', '#d500f9',
    '#ff1744', '#ffea00', '#2979ff', '#ff4081',
    '#14b8a6', '#f97316', '#a855f7', '#06b6d4',
    '#eab308', '#ec4899', '#84cc16', '#6366f1'
  ];

  const CELESTIAL_PRESETS = {
    cas_a: { ra: 350.866, dec: 58.812 },
    cyg_a: { ra: 299.868, dec: 40.734 },
    crab: { ra: 83.633, dec: 22.014 },
    vir_a: { ra: 187.706, dec: 12.391 },
    '3c273': { ra: 187.278, dec: 2.052 },
    psr_b0329: { ra: 53.248, dec: 54.579 },
    sun: { ra: 0.0, dec: 0.0 }
  };

  // --- Global Application State ---
  let activeTab = 'tab-tracker';
  let ws = null;
  let pollTimerFast = null;
  let pollTimerSlow = null;
  let wsRetryTimer = null;
  let toastTimer = null;

  let currentStatus = null;
  let routineState = null;
  let latestSpectrometer = null;
  let latestGrid = null;
  let latestCorrelator = null;
  let latestAntennaMask = null;

  // Tab 1 (Tracker) State
  let selectedBeamId = 0;
  let beamTrails = {};
  let specViewMode = 'all';
  let trackerSpecMode = 'overlay'; // 'overlay' | 'small-mult'
  let specHover = { active: false, cssX: 0, cssY: 0 };
  let waterfallHistoriesByBeam = {}; // { [beamId]: Array<{ timestamp, power }> }
  let waterfallFilterMode = 'all'; // 'all' or beamId string
  const MAX_WATERFALL_ROWS = 90;

  // Tab 2 (Grid Camera) State & 16 Persistent Offscreen Waterfall Buffers
  let gridSliceMode = 'full'; // 'full' | 'sub0' | 'sub1'
  let gridDisplayMode = 'contour'; // 'contour' | 'cells'
  let gridRightPanelMode = 'waterfalls'; // 'waterfalls' | 'table'
  let gridDynamicRange = { minDb: -35.0, maxDb: 10.0 };

  const GRID_BEAMS = 16;
  const FREQ_BINS = 168;
  const HISTORY_LEN = 64;

  const gridOffscreen = Array.from({ length: GRID_BEAMS }, () => {
    const c = document.createElement('canvas');
    c.width = FREQ_BINS;
    c.height = HISTORY_LEN;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#050811';
    ctx.fillRect(0, 0, FREQ_BINS, HISTORY_LEN);
    return {
      canvas: c,
      ctx,
      rowImage: ctx.createImageData(FREQ_BINS, 1),
      latestSpec: null
    };
  });

  // Tab 3 (Correlator) State
  let corrViewMode = 'split'; // 'split' | 'dual'
  let baselineAntA = 0;
  let baselineAntB = 4;
  let latestBaselineData = null;
  let fringeAntenna = 4;
  let fringeMode = 'ri'; // 'ri' | 'amp' | 'phase'
  let bandpassHover = { active: false, cssX: 0 };
  let fringeHover = { active: false, cssX: 0 };

  // Tab 4 (Array) State
  let antViewMode = 'canvas'; // 'canvas' | 'cards'
  let selectedAntennaId = 0;
  let masterAntennaHoverInfo = null;
  let hoveredAntennaTile = -1;

  // --- DOM References ---
  const utcClockEl = document.getElementById('utc-clock');
  const connBadge = document.getElementById('conn-badge');
  const connLabel = document.getElementById('conn-label');
  const activeBeamsSummary = document.getElementById('active-beams-summary');
  const activeElementsSummary = document.getElementById('active-elements-summary');
  const routineSummary = document.getElementById('routine-summary');
  const toast = document.getElementById('toast-message');

  // Tab 1
  const skyCanvas = document.getElementById('sky-canvas');
  const cursorCoords = document.getElementById('cursor-coords');
  const specCanvas = document.getElementById('spectrometer-canvas');
  const specViewSelect = document.getElementById('spec-view-select');
  const specResetZoomBtn = document.getElementById('spec-reset-zoom-btn');
  const specCursorReadout = document.getElementById('spec-cursor-readout');
  const specLegend = document.getElementById('spec-legend');
  const specStats = document.getElementById('spec-stats');
  const waterfallBeamSelect = document.getElementById('waterfall-beam-select');
  const waterfallClearBtn = document.getElementById('waterfall-clear-btn');
  const numBeamsSelect = document.getElementById('num-beams-select');
  const applyBeamsBtn = document.getElementById('apply-beams-btn');
  const interpToggle = document.getElementById('interp-toggle');
  const beamTableBody = document.getElementById('beam-table-body');
  const tabBtnLm = document.getElementById('tab-btn-lm');
  const tabBtnCelestial = document.getElementById('tab-btn-celestial');
  const formSteerLm = document.getElementById('form-steer-lm');
  const formSteerCelestial = document.getElementById('form-steer-celestial');
  const lmBeamSelect = document.getElementById('lm-beam-id');
  const celBeamSelect = document.getElementById('cel-beam-id');
  const celPresetSelect = document.getElementById('cel-preset-select');
  const btnToggleSteerDrawer = document.getElementById('btn-toggle-steer-drawer');
  const steerDrawer = document.getElementById('steer-drawer');
  const btnCloseSteerDrawer = document.getElementById('btn-close-steer-drawer');
  const btnModeOverlay = document.getElementById('btn-mode-overlay');
  const btnModeSmallMult = document.getElementById('btn-mode-small-mult');
  const multiWaterfallStack = document.getElementById('multi-waterfall-stack');

  // Tab 2
  const gridCanvas = document.getElementById('grid-canvas');
  const gridHoverReadout = document.getElementById('grid-hover-readout');
  const gridCentroidReadout = document.getElementById('grid-centroid-readout');
  const gridPeakReadout = document.getElementById('grid-peak-readout');
  const gridTotalFlux = document.getElementById('grid-total-flux');
  const gridBeamTbody = document.getElementById('grid-beam-tbody');
  const gridCbMin = document.getElementById('grid-cb-min');
  const gridCbMax = document.getElementById('grid-cb-max');
  const gridWfCbMin = document.getElementById('grid-wf-cb-min');
  const gridWfCbMax = document.getElementById('grid-wf-cb-max');
  const btnViewCamera = document.getElementById('btn-view-camera');
  const btnViewWaterfalls = document.getElementById('btn-view-waterfalls');
  const gridTablePanel = document.getElementById('grid-table-panel');
  const gridWaterfallsPanel = document.getElementById('grid-waterfalls-panel');
  const gridWaterfallsMatrix = document.getElementById('grid-waterfalls-matrix');

  // Tab 3
  const btnCorrViewSplit = document.getElementById('btn-corr-view-split');
  const btnCorrViewDual = document.getElementById('btn-corr-view-dual');
  const corrSplitCard = document.getElementById('corr-split-card');
  const corrDualLayout = document.getElementById('corr-dual-layout');
  const corrSplitCanvas = document.getElementById('corr-split-canvas');
  const corrSplitHoverEl = document.getElementById('corr-split-hover');
  const corrAmpCanvas = document.getElementById('corr-amp-canvas');
  const corrAmpHoverEl = document.getElementById('corr-amp-hover');
  const corrAmpCbMax = document.getElementById('corr-amp-cb-max');
  const corrPhaseCanvas = document.getElementById('corr-phase-canvas');
  const corrPhaseHoverEl = document.getElementById('corr-phase-hover');
  const corrBandpassCanvas = document.getElementById('corr-bandpass-canvas');
  const corrBandpassHoverEl = document.getElementById('corr-bandpass-hover');
  const fringeCanvas = document.getElementById('fringe-canvas');
  const fringeHoverEl = document.getElementById('fringe-hover');
  const baselineInspectorTitle = document.getElementById('baseline-inspector-title');
  const baselineDelayBadge = document.getElementById('baseline-delay-badge');
  const baseAntAInput = document.getElementById('base-ant-a');
  const baseAntBInput = document.getElementById('base-ant-b');
  const btnInspectBaseline = document.getElementById('btn-inspect-baseline');

  // Tab 4
  const rfActiveBadge = document.getElementById('rf-active-badge');
  const rfMaskedBadge = document.getElementById('rf-masked-badge');
  const rfAutodetectBadge = document.getElementById('rf-autodetect-badge');
  const pillAutodetect = document.getElementById('pill-autodetect');
  const rfBlankingBadge = document.getElementById('rf-blanking-badge');
  const arrayGrid8x8 = document.getElementById('array-grid-8x8');
  const btnToggleAutodetect = document.getElementById('btn-toggle-autodetect');
  const btnUnmaskAll = document.getElementById('btn-unmask-all');
  const btnMaskAll = document.getElementById('btn-mask-all');
  const btnInvertMask = document.getElementById('btn-invert-mask');
  const btnAntViewCanvas = document.getElementById('btn-ant-view-canvas');
  const btnAntViewCards = document.getElementById('btn-ant-view-cards');
  const antennaMaskCanvasWrap = document.getElementById('antenna-mask-canvas-wrap');
  const antennaMaskCanvas = document.getElementById('antenna-mask-canvas');
  const antennaMaskHoverEl = document.getElementById('antenna-mask-hover');
  const antMasterTitle = document.getElementById('ant-master-title');
  const antMasterBadge = document.getElementById('ant-master-badge');
  const antMasterTile = document.getElementById('ant-master-tile');
  const antMasterPeak = document.getElementById('ant-master-peak');
  const antMasterMean = document.getElementById('ant-master-mean');
  const antMasterRms = document.getElementById('ant-master-rms');
  const antMasterClip = document.getElementById('ant-master-clip');
  const antMasterKurt = document.getElementById('ant-master-kurt');
  const btnToggleSelectedMask = document.getElementById('btn-toggle-selected-mask');
  const antMasterCanvas = document.getElementById('ant-master-canvas');
  const antMasterHover = document.getElementById('ant-master-hover');

  // --- HiDPI Canvas Utility ---
  function resizeHiDPICanvas(canvas) {
    if (!canvas) return null;
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;

    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = false;
    return { ctx, width: rect.width, height: rect.height, dpr };
  }

  function showToast(msg, isError = false) {
    if (!toast) return;
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className = `toast ${isError ? 'error' : 'success'}`;
    toastTimer = setTimeout(() => {
      toast.className = 'toast hidden';
    }, 4000);
  }

  function setConnectionState(state, text) {
    if (connBadge) connBadge.className = `status-badge ${state}`;
    if (connLabel) connLabel.textContent = text;
  }

  function startUtcClock() {
    function tick() {
      const iso = new Date().toISOString();
      if (utcClockEl) utcClockEl.textContent = `${iso.substring(11, 19)} UTC`;
    }
    tick();
    setInterval(tick, 1000);
  }

  // --- Colormap Palettes ---
  function viridisColor(val) {
    const t = Math.max(0, Math.min(1, val));
    const r = Math.round(255 * Math.max(0, Math.min(1, 0.267 + t * (-0.005 + t * (1.38 + t * (-2.12 + t * 1.47))))));
    const g = Math.round(255 * Math.max(0, Math.min(1, 0.004 + t * (1.02 + t * (0.14 - t * 0.26)))));
    const b = Math.round(255 * Math.max(0, Math.min(1, 0.329 + t * (1.42 + t * (-2.42 + t * 0.81)))));
    return [r, g, b];
  }

  function infernoColor(val) {
    const t = Math.max(0, Math.min(1, val));
    let r, g, b;
    if (t < 0.25) {
      r = Math.round(255 * (t * 4 * 0.4));
      g = 0;
      b = Math.round(255 * (t * 4 * 0.5));
    } else if (t < 0.5) {
      const f = (t - 0.25) * 4;
      r = Math.round(255 * (0.4 + 0.4 * f));
      g = Math.round(255 * (0.1 * f));
      b = Math.round(255 * (0.5 * (1 - f)));
    } else if (t < 0.75) {
      const f = (t - 0.5) * 4;
      r = Math.round(255 * (0.8 + 0.18 * f));
      g = Math.round(255 * (0.1 + 0.5 * f));
      b = Math.round(255 * (0.1 * f));
    } else {
      const f = (t - 0.75) * 4;
      r = 255;
      g = Math.round(255 * (0.6 + 0.38 * f));
      b = Math.round(255 * (0.1 + 0.8 * f));
    }
    return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
  }

  function turboColor(val) {
    const x = Math.max(0, Math.min(1, val));
    const r = Math.round(255 * Math.max(0, Math.min(1, 0.1357 + x * (4.6153 + x * (-42.6603 + x * (132.131 - x * (152.9423 - 59.2863 * x)))))));
    const g = Math.round(255 * Math.max(0, Math.min(1, 0.0914 + x * (2.1941 + x * (4.8429 + x * (-14.1850 + x * (4.27726 + 2.82956 * x)))))));
    const b = Math.round(255 * Math.max(0, Math.min(1, 0.1066 + x * (12.585 + x * (-60.197 + x * (109.0745 - x * (88.5022 - 26.8115 * x)))))));
    return [r, g, b];
  }

  function cyclicPhaseColor(rad) {
    const norm = (rad + Math.PI) / (2 * Math.PI);
    const t = Math.max(0, Math.min(1, norm));
    let r, g, b;
    if (t < 0.5) {
      const f = t * 2;
      r = Math.round(59 + (255 - 59) * f);
      g = Math.round(130 + (255 - 130) * f);
      b = 255;
    } else {
      const f = (t - 0.5) * 2;
      r = 255;
      g = Math.round(255 * (1 - f * 0.7));
      b = Math.round(255 * (1 - f));
    }
    return [r, g, b];
  }

  // --- Tab Router ---
  function initTabRouter() {
    const tabButtons = document.querySelectorAll('.nav-tab');
    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const targetTab = btn.getAttribute('data-tab');
        if (targetTab === activeTab) return;
        activeTab = targetTab;

        tabButtons.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
        const panel = document.getElementById(targetTab);
        if (panel) panel.classList.add('active');

        requestAnimationFrame(renderActiveTabCanvases);
      });
    });

    window.addEventListener('resize', () => {
      requestAnimationFrame(renderActiveTabCanvases);
    });
  }

  function renderActiveTabCanvases() {
    if (activeTab === 'tab-tracker') {
      drawSkyMap();
      drawSpectrometer();
      drawMultiWaterfalls();
    } else if (activeTab === 'tab-grid') {
      drawGridHeatmap();
      if (gridRightPanelMode === 'waterfalls') {
        renderGridWaterfalls();
      }
    } else if (activeTab === 'tab-correlator') {
      if (corrViewMode === 'split') {
        drawSplitCorrelatorMatrix();
      } else {
        drawCorrelatorMatrices();
      }
      drawBandpassSpectrum();
      drawFringePlot();
    } else if (activeTab === 'tab-array') {
      drawMasterAntennaSpectrometer();
      renderArrayGrid();
    }
  }

  // --- WebSocket & Fallback Polling ---
  function initWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnectionState('live', 'Live (WS)');
      stopFallbackPolling();
    };

    ws.onmessage = (event) => {
      try {
        handleIncomingMessage(JSON.parse(event.data));
      } catch (err) {
        console.error('Failed to parse WebSocket telemetry', err);
      }
    };

    ws.onclose = () => {
      setConnectionState('fallback', 'Polling (REST)');
      startFallbackPolling();
      clearTimeout(wsRetryTimer);
      wsRetryTimer = setTimeout(initWebSocket, 4000);
    };

    ws.onerror = () => {
      if (ws) ws.close();
    };
  }

  function handleIncomingMessage(msg) {
    if (!msg) return;
    if (msg.type === 'spectrometer') {
      handleSpectrometerUpdate(msg.data || msg);
    } else if (msg.type === 'grid') {
      handleGridUpdate(msg.data || msg);
    } else if (msg.type === 'correlator') {
      handleCorrelatorUpdate(msg.data || msg);
    } else if (msg.type === 'antenna_mask') {
      handleAntennaMaskUpdate(msg.data || msg);
    } else if (msg.type === 'routine') {
      handleRoutineUpdate(msg.data || msg);
    } else if (msg.type === 'status' || msg.num_active_beams !== undefined) {
      handleStatusUpdate(msg.data || msg);
    }
  }

  function startFallbackPolling() {
    if (pollTimerFast) return;
    pollTimerFast = setInterval(async () => {
      try {
        const [resStatus, resSpec, resGrid] = await Promise.all([
          fetch('/api/status').catch(() => null),
          fetch('/api/spectrometer').catch(() => null),
          fetch('/api/grid').catch(() => null),
        ]);
        if (resStatus && resStatus.ok) {
          handleStatusUpdate(await resStatus.json());
          setConnectionState('fallback', 'Polling (REST)');
        } else {
          setConnectionState('disconnected', 'Disconnected');
        }
        if (resSpec && resSpec.ok) handleSpectrometerUpdate(await resSpec.json());
        if (resGrid && resGrid.ok) handleGridUpdate(await resGrid.json());
      } catch (e) {
        setConnectionState('disconnected', 'Disconnected');
      }
    }, 1000);

    pollTimerSlow = setInterval(async () => {
      try {
        const [resCorr, resMask, resRoutine] = await Promise.all([
          fetch('/api/correlator').catch(() => null),
          fetch('/api/antenna_mask').catch(() => null),
          fetch('/api/routine').catch(() => null),
        ]);
        if (resCorr && resCorr.ok) handleCorrelatorUpdate(await resCorr.json());
        if (resMask && resMask.ok) handleAntennaMaskUpdate(await resMask.json());
        if (resRoutine && resRoutine.ok) handleRoutineUpdate(await resRoutine.json());
      } catch (e) {
        // Ignore transient fallback errors
      }
    }, 2000);
  }

  function stopFallbackPolling() {
    if (pollTimerFast) { clearInterval(pollTimerFast); pollTimerFast = null; }
    if (pollTimerSlow) { clearInterval(pollTimerSlow); pollTimerSlow = null; }
  }

  // --- Stream Handlers ---
  function beamName(beamId) {
    if (routineState && routineState.beam_names && routineState.beam_names[String(beamId)]) {
      return routineState.beam_names[String(beamId)];
    }
    if (latestSpectrometer && latestSpectrometer.beams && latestSpectrometer.beams[beamId]) {
      return latestSpectrometer.beams[beamId].target_name || null;
    }
    return null;
  }

  function handleStatusUpdate(status) {
    if (!status) return;
    currentStatus = status;

    const activeBeams = status.num_active_beams !== undefined
      ? status.num_active_beams
      : (status.beams ? status.beams.length : 0);
    if (activeBeamsSummary) activeBeamsSummary.textContent = `${activeBeams} / 16`;

    const activeAnts = status.active_antennas !== undefined ? status.active_antennas : 64;
    if (activeElementsSummary) activeElementsSummary.textContent = `${activeAnts} / 64`;

    if (numBeamsSelect && document.activeElement !== numBeamsSelect) {
      numBeamsSelect.value = activeBeams;
    }
    if (interpToggle) {
      interpToggle.checked = !!status.subframe_interpolation_enabled;
    }

    updateBeamSelects(status.beams || []);
    renderBeamTable(status.beams || []);

    if (activeTab === 'tab-tracker') {
      requestAnimationFrame(drawSkyMap);
    }
  }

  function handleRoutineUpdate(data) {
    routineState = data;
    if (!routineSummary) return;

    if (!routineState || !routineState.enabled) {
      routineSummary.textContent = 'Routine: OFF';
      routineSummary.className = 'routine-badge off';
    } else if (routineState.last_error) {
      routineSummary.textContent = `Routine: ERR (${routineState.last_error.substring(0, 14)})`;
      routineSummary.className = 'routine-badge err';
    } else {
      const nextTime = routineState.next_slot_time_local || '--:--';
      routineSummary.textContent = `Routine: ON (next ${nextTime})`;
      routineSummary.className = 'routine-badge on';
    }

    if (currentStatus && currentStatus.beams) {
      renderBeamTable(currentStatus.beams);
      updateBeamSelects(currentStatus.beams);
    }
  }

  function handleSpectrometerUpdate(specData) {
    if (!specData || !specData.beams) return;
    latestSpectrometer = specData;

    updateSpectrometerViewSelect(specData.beams);
    renderSpectrometerFooter(specData.beams);

    Object.keys(specData.beams).forEach(id => {
      const bObj = specData.beams[id];
      if (bObj && bObj.power_db && bObj.power_db.length > 0) {
        if (!waterfallHistoriesByBeam[id]) waterfallHistoriesByBeam[id] = [];
        waterfallHistoriesByBeam[id].unshift({
          timestamp: specData.timestamp,
          power: bObj.power_db
        });
        if (waterfallHistoriesByBeam[id].length > MAX_WATERFALL_ROWS) {
          waterfallHistoriesByBeam[id].pop();
        }
      }
    });

    if (currentStatus && currentStatus.beams) {
      renderBeamTable(currentStatus.beams);
    }

    if (activeTab === 'tab-tracker') {
      requestAnimationFrame(() => {
        drawSpectrometer();
        drawMultiWaterfalls();
      });
    }
  }

  function handleGridUpdate(frame) {
    if (!frame) return;
    latestGrid = frame;

    if (frame.beam_power_spectra) {
      pushGridSpectra(frame.beam_power_spectra);
    }

    if (gridCentroidReadout) {
      const cl = frame.centroid_l !== undefined ? frame.centroid_l.toFixed(4) : '0.0000';
      const cm = frame.centroid_m !== undefined ? frame.centroid_m.toFixed(4) : '0.0000';
      gridCentroidReadout.textContent = `(${cl}, ${cm})`;
    }
    if (gridPeakReadout) {
      const pId = frame.peak_beam_id !== undefined ? frame.peak_beam_id : 0;
      const pDb = frame.peak_power !== undefined ? frame.peak_power.toFixed(1) : '--';
      gridPeakReadout.textContent = `Beam ${pId} (${pDb} dB)`;
    }
    if (gridTotalFlux && frame.beam_powers) {
      let sumLin = 0;
      frame.beam_powers.forEach(p => { sumLin += Math.pow(10, p / 10); });
      gridTotalFlux.textContent = `${(10 * Math.log10(Math.max(1e-12, sumLin))).toFixed(1)} dB`;
    }

    renderGridTable(frame);

    if (activeTab === 'tab-grid') {
      requestAnimationFrame(() => {
        drawGridHeatmap();
        if (gridRightPanelMode === 'waterfalls') {
          renderGridWaterfalls();
        }
      });
    }
  }

  function handleCorrelatorUpdate(corr) {
    if (!corr) return;
    latestCorrelator = corr;

    if (activeTab === 'tab-correlator') {
      requestAnimationFrame(() => {
        if (corrViewMode === 'split') {
          drawSplitCorrelatorMatrix();
        } else {
          drawCorrelatorMatrices();
        }
        drawBandpassSpectrum();
        drawFringePlot();
      });
    } else if (activeTab === 'tab-array') {
      requestAnimationFrame(() => {
        drawMasterAntennaSpectrometer();
        renderArrayGrid();
      });
    }
  }

  function handleAntennaMaskUpdate(maskStatus) {
    if (!maskStatus) return;
    latestAntennaMask = maskStatus;

    if (rfActiveBadge) rfActiveBadge.textContent = `${maskStatus.active_antennas} / ${maskStatus.num_antennas || 64}`;
    if (rfMaskedBadge) rfMaskedBadge.textContent = `${maskStatus.masked_antennas} / ${maskStatus.num_antennas || 64}`;
    if (activeElementsSummary) activeElementsSummary.textContent = `${maskStatus.active_antennas} / 64`;

    if (rfAutodetectBadge) {
      const enabled = !!maskStatus.auto_detect_enabled;
      rfAutodetectBadge.textContent = enabled ? 'ENABLED' : 'DISABLED';
      rfAutodetectBadge.className = `metric-val monospace ${enabled ? 'success' : 'warning'}`;
    }
    if (btnToggleAutodetect) {
      const enabled = !!maskStatus.auto_detect_enabled;
      btnToggleAutodetect.textContent = enabled ? 'Disable Auto-Detect' : 'Enable Auto-Detect';
      btnToggleAutodetect.classList.toggle('btn-autodetect-off', !enabled);
    }
    if (rfBlankingBadge) {
      rfBlankingBadge.textContent = maskStatus.blank_voltages_enabled ? 'RTX 5090 IN-PLACE' : 'OFF';
    }

    if (activeTab === 'tab-array') {
      requestAnimationFrame(() => {
        drawMasterAntennaSpectrometer();
        renderArrayGrid();
      });
    }
  }

  // ==========================================================================
  // TAB 1: Direct Astrometric Tracker Renderers
  // ==========================================================================
  function updateBeamSelects(beams) {
    if (!lmBeamSelect || !celBeamSelect) return;
    const prevLm = lmBeamSelect.value;
    const prevCel = celBeamSelect.value;
    lmBeamSelect.innerHTML = '';
    celBeamSelect.innerHTML = '';

    const ids = beams.length > 0 ? beams.map(b => b.beam_id) : [0];
    ids.forEach(id => {
      const name = beamName(id);
      const text = `Beam ${id}${name ? ' — ' + name : ''}`;

      const optLm = document.createElement('option');
      optLm.value = id;
      optLm.textContent = text;
      lmBeamSelect.appendChild(optLm);

      const optCel = document.createElement('option');
      optCel.value = id;
      optCel.textContent = text;
      celBeamSelect.appendChild(optCel);
    });

    if (ids.includes(parseInt(prevLm, 10))) lmBeamSelect.value = prevLm;
    if (ids.includes(parseInt(prevCel, 10))) celBeamSelect.value = prevCel;
  }

  function renderBeamTable(beams) {
    if (!beamTableBody) return;
    if (!beams || beams.length === 0) {
      beamTableBody.innerHTML = '<tr><td colspan="9" class="empty-state">No active tracked beams</td></tr>';
      return;
    }

    beamTableBody.innerHTML = '';
    beams.forEach(b => {
      const tr = document.createElement('tr');
      if (b.beam_id === selectedBeamId) tr.classList.add('selected');

      const color = BEAM_COLORS[b.beam_id % BEAM_COLORS.length];
      const name = beamName(b.beam_id);
      const targetStr = b.celestial_target && b.celestial_target.is_set
        ? `${b.celestial_target.ra_deg.toFixed(2)}°, ${b.celestial_target.dec_deg.toFixed(2)}°`
        : '--';

      const r = Math.sqrt(b.l0 * b.l0 + b.m0 * b.m0);
      const altDeg = (90.0 - Math.asin(Math.min(1.0, r)) * 180.0 / Math.PI).toFixed(1);
      const azDeg = ((Math.atan2(b.l0, b.m0) * 180.0 / Math.PI + 360.0) % 360.0).toFixed(1);

      let seamRateStr = 'Δφ: +0.00 rad/s';
      if (b.dl !== undefined || b.dm !== undefined) {
        const rate = Math.sqrt((b.dl || 0) ** 2 + (b.dm || 0) ** 2) * 50;
        const sign = (b.dl || 0) >= 0 ? '+' : '-';
        seamRateStr = `Δφ: ${sign}${rate.toFixed(2)} rad/s`;
      } else if (currentStatus && currentStatus.subframe_interpolation_enabled) {
        seamRateStr = 'Δφ: +0.04 rad/s';
      }

      let peakDb = '--';
      if (latestSpectrometer && latestSpectrometer.beams && latestSpectrometer.beams[b.beam_id]) {
        const spec = latestSpectrometer.beams[b.beam_id];
        if (spec.stats && spec.stats.max !== undefined) {
          peakDb = `${spec.stats.max.toFixed(1)} dB`;
        }
      }

      tr.innerHTML = `
        <td style="color: ${color}; font-weight: 700;">● #${b.beam_id}</td>
        <td>${name ? `<strong>${name}</strong>` : '<span class="status-label">Steered</span>'}</td>
        <td>${targetStr}</td>
        <td>${azDeg}° / ${altDeg}°</td>
        <td>(${b.l0 >= 0 ? '+' : ''}${b.l0.toFixed(4)}, ${b.m0 >= 0 ? '+' : ''}${b.m0.toFixed(4)})</td>
        <td><span class="monospace">${seamRateStr}</span></td>
        <td><span class="monospace highlight">${peakDb}</span></td>
        <td><span class="badge badge-xs status-nominal-badge">TRACK</span></td>
        <td><button class="btn btn-xs btn-outline btn-steer-action" data-beam="${b.beam_id}">Steer</button></td>
      `;

      tr.addEventListener('click', () => selectBeam(b.beam_id));
      const steerBtn = tr.querySelector('.btn-steer-action');
      if (steerBtn) {
        steerBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          selectBeam(b.beam_id);
          if (steerDrawer) steerDrawer.classList.remove('hidden');
        });
      }
      beamTableBody.appendChild(tr);
    });
  }

  async function selectBeam(beamId) {
    selectedBeamId = beamId;
    if (lmBeamSelect) lmBeamSelect.value = beamId;
    if (celBeamSelect) celBeamSelect.value = beamId;

    if (currentStatus && currentStatus.beams) {
      const b = currentStatus.beams.find(x => x.beam_id === beamId);
      if (b) {
        document.getElementById('lm-l0').value = b.l0.toFixed(4);
        document.getElementById('lm-m0').value = b.m0.toFixed(4);
        if (b.celestial_target && b.celestial_target.is_set) {
          document.getElementById('cel-ra').value = b.celestial_target.ra_deg.toFixed(2);
          document.getElementById('cel-dec').value = b.celestial_target.dec_deg.toFixed(2);
        }
      }
    }

    try {
      const res = await fetch(`/api/history?beam_id=${beamId}`);
      if (res.ok) beamTrails[beamId] = await res.json();
    } catch (e) {
      // Ignore trail errors
    }

    renderBeamTable(currentStatus ? currentStatus.beams : []);
    requestAnimationFrame(drawSkyMap);
  }

  function drawSkyMap() {
    const setup = resizeHiDPICanvas(skyCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    const cx = width / 2;
    const cy = height / 2;
    const r = Math.max(20, Math.min(width, height) / 2 - 18);

    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = '#22324e';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.strokeStyle = '#152034';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#18243a';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();

    ctx.fillStyle = '#8fa5c2';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N', cx, cy - r - 8);
    ctx.fillText('S', cx, cy + r + 8);
    ctx.fillText('E', cx + r + 8, cy);
    ctx.fillText('W', cx - r - 8, cy);

    const trail = beamTrails[selectedBeamId];
    if (trail && trail.length > 1) {
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      trail.forEach((pt, idx) => {
        const tx = cx + pt.l0 * r;
        const ty = cy - pt.m0 * r;
        if (idx === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      });
      ctx.stroke();
    }

    if (currentStatus && currentStatus.beams) {
      currentStatus.beams.forEach(b => {
        const bx = cx + b.l0 * r;
        const by = cy - b.m0 * r;
        const color = BEAM_COLORS[b.beam_id % BEAM_COLORS.length];

        if (b.beam_id === selectedBeamId) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(bx, by, 7, 0, Math.PI * 2);
          ctx.stroke();
        }

        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(bx, by, 4, 0, Math.PI * 2);
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 9px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`B${b.beam_id}`, bx + 6, by - 3);
      });
    }
  }

  function updateSpectrometerViewSelect(beams) {
    if (!specViewSelect) return;
    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const expected = ['all', ...beamIds];
    const existing = Array.from(specViewSelect.options).map(o => o.value);

    if (existing.length !== expected.length || !expected.every((val, i) => existing[i] === val)) {
      const prev = specViewSelect.value;
      specViewSelect.innerHTML = '<option value="all">All Active Beams</option>';
      beamIds.forEach(id => {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = beams[id].label || `Beam ${id}`;
        specViewSelect.appendChild(opt);
      });
      if (expected.includes(prev)) specViewSelect.value = prev;
    }

    if (waterfallBeamSelect) {
      const prevWf = waterfallBeamSelect.value;
      const wfExpected = ['all', ...beamIds];
      const wfExisting = Array.from(waterfallBeamSelect.options).map(o => o.value);
      if (wfExisting.length !== wfExpected.length || !wfExpected.every((v, i) => wfExisting[i] === v)) {
        waterfallBeamSelect.innerHTML = '<option value="all">All Tracked Beams</option>';
        beamIds.forEach(id => {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = `Beam #${id} Only`;
          waterfallBeamSelect.appendChild(opt);
        });
        if (wfExpected.includes(prevWf)) waterfallBeamSelect.value = prevWf;
      }
    }
  }

  function renderSpectrometerFooter(beams) {
    if (!specLegend || !specStats) return;
    specLegend.innerHTML = '';
    specStats.innerHTML = '';

    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const statsTexts = [];

    beamIds.forEach(id => {
      const b = beams[id];
      const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];

      const pill = document.createElement('div');
      pill.className = 'spec-pill';
      pill.innerHTML = `
        <span class="spec-pill-dot" style="background-color: ${color};"></span>
        <span>${b.label || `Beam ${id}`}</span>
      `;
      specLegend.appendChild(pill);

      if (b.stats) {
        statsTexts.push(
          `<span>B${id}: Max <strong>${b.stats.max.toFixed(1)} dB</strong> @ <strong>${b.stats.peak_freq_mhz.toFixed(1)} MHz</strong></span>`
        );
      }
    });

    specStats.innerHTML = statsTexts.join(' · ');
  }

  function drawSpectrometer() {
    const setup = resizeHiDPICanvas(specCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, width, height);

    if (!latestSpectrometer || !latestSpectrometer.beams) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting 672-channel line spectrum telemetry...', width / 2, height / 2);
      return;
    }

    const beams = latestSpectrometer.beams;
    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    if (beamIds.length === 0) return;

    const activeIds = (specViewMode === 'all')
      ? beamIds
      : (beams[specViewMode] ? [specViewMode] : beamIds);

    const padL = 42, padR = 14, padT = 12, padB = 24;
    const plotW = Math.max(10, width - padL - padR);
    const plotH = Math.max(10, height - padT - padB);
    const fMin = 300.0, fMax = 501.3, dbMin = -45.0, dbMax = 10.0;

    if (trackerSpecMode === 'small-mult') {
      const nPlots = Math.max(1, activeIds.length);
      const subH = plotH / nPlots;

      activeIds.forEach((id, plotIdx) => {
        const b = beams[id];
        if (!b || !b.power_db || b.power_db.length === 0) return;
        const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];
        const subTop = padT + plotIdx * subH;
        const numChannels = b.power_db.length;

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.strokeRect(padL, subTop, plotW, subH - 2);

        // Subband split line
        const subX = padL + ((400.8 - fMin) / (fMax - fMin)) * plotW;
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.2)';
        ctx.setLineDash([2, 2]);
        ctx.beginPath();
        ctx.moveTo(subX, subTop);
        ctx.lineTo(subX, subTop + subH - 2);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = color;
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(b.label || `Beam #${id}`, padL + 6, subTop + 4);

        ctx.strokeStyle = color;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (let ch = 0; ch < numChannels; ch++) {
          const x = padL + (ch / (numChannels - 1)) * plotW;
          const db = Math.max(dbMin, Math.min(dbMax, b.power_db[ch]));
          const y = subTop + (1.0 - (db - dbMin) / (dbMax - dbMin)) * (subH - 4);
          if (ch === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });

      ctx.fillStyle = '#5a7192';
      ctx.font = '10px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      [300, 350, 400.8, 450, 500].forEach(freq => {
        const x = padL + ((freq - fMin) / (fMax - fMin)) * plotW;
        ctx.fillText(`${freq} MHz`, x, padT + plotH + 5);
      });
      return;
    }

    // Overlay All Mode
    ctx.strokeStyle = '#121d33';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#5a7192';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    [-40, -30, -20, -10, 0, 10].forEach(db => {
      const y = padT + (1.0 - (db - dbMin) / (dbMax - dbMin)) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${db}`, padL - 6, y);
    });

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [300, 350, 400, 450, 500].forEach(freq => {
      const x = padL + ((freq - fMin) / (fMax - fMin)) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(`${freq} MHz`, x, padT + plotH + 6);
    });

    const subbandX = padL + ((400.8 - fMin) / (fMax - fMin)) * plotW;
    ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(subbandX, padT);
    ctx.lineTo(subbandX, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    activeIds.forEach(id => {
      const b = beams[id];
      if (!b || !b.power_db || b.power_db.length === 0) return;
      const numChannels = b.power_db.length;
      const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];

      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let ch = 0; ch < numChannels; ch++) {
        const x = padL + (ch / (numChannels - 1)) * plotW;
        const db = Math.max(dbMin, Math.min(dbMax, b.power_db[ch]));
        const y = padT + (1.0 - (db - dbMin) / (dbMax - dbMin)) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    });

    if (specHover.active && specHover.cssX >= padL && specHover.cssX <= padL + plotW) {
      const normX = (specHover.cssX - padL) / plotW;
      const chIdx = Math.min(671, Math.max(0, Math.round(normX * 671)));
      const freqMhz = 300.0 + chIdx * 0.3;

      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(specHover.cssX, padT);
      ctx.lineTo(specHover.cssX, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      let readout = `Ch ${chIdx} | ${freqMhz.toFixed(2)} MHz`;
      activeIds.forEach(id => {
        const b = beams[id];
        if (b && b.power_db && b.power_db[chIdx] !== undefined) {
          readout += ` | B${id}: ${b.power_db[chIdx].toFixed(1)} dB`;
        }
      });
      if (specCursorReadout) specCursorReadout.textContent = readout;
    }
  }

  function renderWaterfallCanvas(canvas, history) {
    const setup = resizeHiDPICanvas(canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, width, height);

    if (!history || history.length === 0) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Accumulating 672-ch waterfall history...', width / 2, height / 2);
      return;
    }

    const numRows = history.length;
    const numChannels = 672;
    const rowH = height / MAX_WATERFALL_ROWS;
    const colW = width / numChannels;
    const dbMin = -45.0, dbMax = 15.0;

    for (let r = 0; r < numRows; r++) {
      const powers = history[r].power;
      const y = r * rowH;
      for (let c = 0; c < numChannels; c += 2) {
        const norm = (powers[c] - dbMin) / (dbMax - dbMin);
        const rgb = viridisColor(norm);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(c * colW, y, Math.ceil(colW * 2) + 0.5, Math.ceil(rowH) + 0.5);
      }
    }
  }

  function drawMultiWaterfalls() {
    if (!multiWaterfallStack) return;
    const beams = (latestSpectrometer && latestSpectrometer.beams) ? latestSpectrometer.beams : { 0: { label: 'Beam 0' } };
    const allIds = Object.keys(beams).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
    const displayIds = (waterfallFilterMode === 'all')
      ? allIds
      : (allIds.includes(String(waterfallFilterMode)) ? [String(waterfallFilterMode)] : allIds);

    // Remove stale strips
    Array.from(multiWaterfallStack.children).forEach(child => {
      const stripId = child.getAttribute('data-beam-id');
      if (!displayIds.includes(stripId)) {
        child.remove();
      }
    });

    displayIds.forEach(id => {
      let strip = document.getElementById(`wf-strip-beam-${id}`);
      if (!strip) {
        strip = document.createElement('div');
        strip.className = 'waterfall-strip';
        strip.id = `wf-strip-beam-${id}`;
        strip.setAttribute('data-beam-id', id);
        strip.innerHTML = `
          <div class="waterfall-strip-header">
            <span class="wf-strip-label" id="wf-label-${id}">Tracker #${id}</span>
            <span class="wf-strip-metric monospace" id="wf-peak-${id}">-- dB</span>
          </div>
          <div class="canvas-wrap waterfall-canvas-wrap">
            <canvas id="wf-canvas-${id}"></canvas>
          </div>
        `;
        multiWaterfallStack.appendChild(strip);
      }

      const bObj = beams[id];
      const bName = beamName(id);
      const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];
      const lbl = strip.querySelector(`#wf-label-${id}`);
      const pk = strip.querySelector(`#wf-peak-${id}`);

      if (lbl) {
        lbl.style.color = color;
        lbl.textContent = `● Tracker #${id}${bName ? ' (' + bName + ')' : ''}`;
      }
      if (pk && bObj && bObj.stats && bObj.stats.max !== undefined) {
        pk.textContent = `Peak: ${bObj.stats.max.toFixed(1)} dB @ ${bObj.stats.peak_freq_mhz.toFixed(1)} MHz`;
      }

      const c = strip.querySelector(`#wf-canvas-${id}`);
      if (c) {
        renderWaterfallCanvas(c, waterfallHistoriesByBeam[id] || []);
      }
    });
  }

  // ==========================================================================
  // TAB 2: 16-Beam Sky Grid Camera & 4x4 Spectrograms
  // ==========================================================================
  function pushGridSpectra(gridSpectra16xF) {
    if (!gridSpectra16xF || gridSpectra16xF.length === 0) return;

    // Compute dynamic min/max dB across the 16 beams for high-contrast waterfalls
    let gMin = Infinity, gMax = -Infinity;
    for (let b = 0; b < Math.min(GRID_BEAMS, gridSpectra16xF.length); b++) {
      const s = gridSpectra16xF[b];
      if (!s) continue;
      for (let i = 0; i < s.length; i++) {
        if (s[i] < gMin) gMin = s[i];
        if (s[i] > gMax) gMax = s[i];
      }
    }
    if (isFinite(gMin) && isFinite(gMax) && gMax > gMin) {
      gridDynamicRange.minDb = gMin - 1.5;
      gridDynamicRange.maxDb = gMax + 1.5;
      if (gridWfCbMin) gridWfCbMin.textContent = `${gridDynamicRange.minDb.toFixed(1)} dB`;
      if (gridWfCbMax) gridWfCbMax.textContent = `${gridDynamicRange.maxDb.toFixed(1)} dB`;
    }

    const span = Math.max(4.0, gridDynamicRange.maxDb - gridDynamicRange.minDb);

    for (let b = 0; b < GRID_BEAMS; b++) {
      const spec = gridSpectra16xF[b];
      if (!spec || spec.length === 0) continue;
      const buf = gridOffscreen[b];
      buf.latestSpec = spec;

      // Shift waterfall down by 1px
      buf.ctx.drawImage(buf.canvas, 0, 0, FREQ_BINS, HISTORY_LEN - 1, 0, 1, FREQ_BINS, HISTORY_LEN - 1);

      const data = buf.rowImage.data;
      const specLen = spec.length;
      for (let f = 0; f < FREQ_BINS; f++) {
        const srcIdx = Math.min(specLen - 1, Math.floor((f * specLen) / FREQ_BINS));
        const val = spec[srcIdx];
        const norm = Math.max(0, Math.min(1, (val - gridDynamicRange.minDb) / span));
        const [r, g, bl] = viridisColor(norm);
        const p = f * 4;
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = bl;
        data[p + 3] = 255;
      }
      buf.ctx.putImageData(buf.rowImage, 0, 0);
    }
  }

  function renderGridWaterfalls() {
    if (!gridWaterfallsMatrix) return;

    // Order cells so top row is m = +0.03 (Row 3) matching the 2D spatial heatmap
    if (gridWaterfallsMatrix.children.length !== GRID_BEAMS) {
      gridWaterfallsMatrix.innerHTML = '';
      for (let visualRow = 3; visualRow >= 0; visualRow--) {
        for (let col = 0; col < 4; col++) {
          const b = visualRow * 4 + col;
          const cell = document.createElement('div');
          cell.className = 'grid-wf-cell';
          cell.id = `grid-wf-cell-${b}`;
          cell.innerHTML = `
            <div class="grid-wf-cell-header">
              <span><strong>B${b}</strong> (R${visualRow}C${col})</span>
              <span class="monospace" id="grid-wf-db-${b}">-- dB</span>
            </div>
            <div class="grid-wf-canvas-wrap">
              <canvas class="grid-wf-canvas" id="grid-wf-canvas-${b}"></canvas>
            </div>
          `;
          gridWaterfallsMatrix.appendChild(cell);
        }
      }
    }

    const peakId = latestGrid && latestGrid.peak_beam_id !== undefined ? latestGrid.peak_beam_id : -1;
    const minDb = gridDynamicRange.minDb;
    const maxDb = gridDynamicRange.maxDb;
    const span = Math.max(4.0, maxDb - minDb);

    for (let b = 0; b < GRID_BEAMS; b++) {
      const cell = document.getElementById(`grid-wf-cell-${b}`);
      if (cell) cell.classList.toggle('peak-cell', b === peakId);

      const dbEl = document.getElementById(`grid-wf-db-${b}`);
      if (dbEl && latestGrid && latestGrid.beam_powers && latestGrid.beam_powers[b] !== undefined) {
        dbEl.textContent = `${latestGrid.beam_powers[b].toFixed(1)} dB`;
      }

      const c = document.getElementById(`grid-wf-canvas-${b}`);
      const setup = resizeHiDPICanvas(c);
      if (!setup) continue;
      const { ctx, width, height } = setup;

      const splitY = Math.floor(height * 0.42);
      ctx.fillStyle = '#050811';
      ctx.fillRect(0, 0, width, splitY);

      // Top 42%: Live 1D Line Spectrum
      const spec = gridOffscreen[b].latestSpec;
      if (spec && spec.length > 0) {
        const color = b === peakId ? '#fbbf24' : '#00e5ff';
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (let i = 0; i < spec.length; i++) {
          const x = (i / (spec.length - 1)) * width;
          const norm = Math.max(0, Math.min(1, (spec[i] - minDb) / span));
          const y = splitY - 3 - norm * (splitY - 7);
          if (i === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }

      // Divider
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, splitY);
      ctx.lineTo(width, splitY);
      ctx.stroke();

      // Bottom 58%: Persistent 2D Waterfall
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(gridOffscreen[b].canvas, 0, splitY + 1, width, height - splitY - 1);
    }
  }

  function getSlicedBeamPowers(frame) {
    if (!frame) return [];
    if (gridSliceMode === 'full' || !frame.beam_power_spectra || frame.beam_power_spectra.length !== 16) {
      return frame.beam_powers || [];
    }
    const specLen = frame.beam_power_spectra[0].length;
    const half = Math.floor(specLen / 2);
    const chStart = gridSliceMode === 'sub0' ? 0 : half;
    const chEnd = gridSliceMode === 'sub0' ? half : specLen;
    const powers = [];

    for (let b = 0; b < 16; b++) {
      const spec = frame.beam_power_spectra[b];
      let sumLin = 0;
      for (let ch = chStart; ch < chEnd; ch++) {
        sumLin += Math.pow(10, spec[ch] / 10.0);
      }
      powers.push(10.0 * Math.log10(Math.max(1e-12, sumLin / Math.max(1, chEnd - chStart))));
    }
    return powers;
  }

  function renderGridTable(frame) {
    if (!gridBeamTbody) return;
    const powers = getSlicedBeamPowers(frame);
    if (!powers || powers.length === 0) {
      gridBeamTbody.innerHTML = '<tr><td colspan="6" class="empty-state">No grid camera telemetry</td></tr>';
      return;
    }

    let minDb = Math.min(...powers);
    let maxDb = Math.max(...powers);
    const peakId = powers.indexOf(maxDb);

    gridBeamTbody.innerHTML = '';
    for (let b = 0; b < 16; b++) {
      const row = Math.floor(b / 4);
      const col = b % 4;
      const l = (-0.03 + col * 0.02).toFixed(4);
      const m = (-0.03 + row * 0.02).toFixed(4);
      const db = powers[b].toFixed(1);
      const relPct = Math.max(0, Math.min(100, ((powers[b] - minDb) / (maxDb - minDb + 1e-6)) * 100)).toFixed(0);
      const isPeak = b === peakId;

      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="color: ${BEAM_COLORS[b % BEAM_COLORS.length]}; font-weight: 700;">Beam ${b}</td>
        <td>R${row} / C${col}</td>
        <td>(${l}, ${m})</td>
        <td><span class="monospace ${isPeak ? 'highlight' : ''}">${db} dB</span></td>
        <td>
          <div class="power-bar-wrap">
            <div class="power-bar-fill" style="width: ${relPct}%;"></div>
            <span class="monospace" style="font-size: 10px;">${relPct}%</span>
          </div>
        </td>
        <td>${isPeak ? '<span class="badge badge-accent">★ PEAK BEAM</span>' : '<span class="status-label">Aperture</span>'}</td>
      `;
      gridBeamTbody.appendChild(tr);
    }
  }

  function drawGridHeatmap() {
    const setup = resizeHiDPICanvas(gridCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, width, height);

    if (!latestGrid) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting 16-beam sky grid camera frames (4 Hz)...', width / 2, height / 2);
      return;
    }

    const powers = getSlicedBeamPowers(latestGrid);
    if (!powers || powers.length !== 16) return;

    const minDb = Math.min(...powers);
    const maxDb = Math.max(...powers);
    if (gridCbMin) gridCbMin.textContent = `${minDb.toFixed(1)} dB`;
    if (gridCbMax) gridCbMax.textContent = `${maxDb.toFixed(1)} dB`;

    const pad = 42;
    const plotW = Math.max(20, width - pad * 2);
    const plotH = Math.max(20, height - pad * 2);

    if (gridDisplayMode === 'cells') {
      const cellW = plotW / 4;
      const cellH = plotH / 4;

      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const bIdx = r * 4 + c;
          const p = powers[bIdx];
          const norm = (p - minDb) / (maxDb - minDb + 1e-6);
          const rgb = infernoColor(norm);

          const x = pad + c * cellW;
          const y = pad + (3 - r) * cellH;

          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.fillRect(x, y, cellW - 2, cellH - 2);

          ctx.fillStyle = norm > 0.6 ? '#000000' : '#ffffff';
          ctx.font = 'bold 11px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`B${bIdx}`, x + cellW / 2, y + cellH / 2 - 8);
          ctx.font = '10px ui-monospace, monospace';
          ctx.fillText(`${p.toFixed(1)} dB`, x + cellW / 2, y + cellH / 2 + 8);
        }
      }
    } else {
      const res = 160;
      const offscreen = document.createElement('canvas');
      offscreen.width = res;
      offscreen.height = res;
      const offCtx = offscreen.getContext('2d');
      const imgData = offCtx.createImageData(res, res);
      const data = imgData.data;

      const grid4x4 = [];
      for (let r = 0; r < 4; r++) {
        grid4x4[r] = [powers[r * 4], powers[r * 4 + 1], powers[r * 4 + 2], powers[r * 4 + 3]];
      }

      for (let py = 0; py < res; py++) {
        const fy = ((res - 1 - py) / (res - 1)) * 3;
        const r0 = Math.floor(fy);
        const r1 = Math.min(3, r0 + 1);
        const ty = fy - r0;

        for (let px = 0; px < res; px++) {
          const fx = (px / (res - 1)) * 3;
          const c0 = Math.floor(fx);
          const c1 = Math.min(3, c0 + 1);
          const tx = fx - c0;

          const top = grid4x4[r0][c0] * (1 - tx) + grid4x4[r0][c1] * tx;
          const bot = grid4x4[r1][c0] * (1 - tx) + grid4x4[r1][c1] * tx;
          const val = top * (1 - ty) + bot * ty;
          const norm = (val - minDb) / (maxDb - minDb + 1e-6);
          const rgb = infernoColor(norm);

          const idx = (py * res + px) * 4;
          data[idx] = rgb[0];
          data[idx + 1] = rgb[1];
          data[idx + 2] = rgb[2];
          data[idx + 3] = 255;
        }
      }

      offCtx.putImageData(imgData, 0, 0);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(offscreen, pad, pad, plotW, plotH);
      ctx.imageSmoothingEnabled = false;

      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const bIdx = r * 4 + c;
          const bx = pad + (c / 3) * plotW;
          const by = pad + ((3 - r) / 3) * plotH;

          ctx.fillStyle = 'rgba(255, 255, 255, 0.55)';
          ctx.beginPath();
          ctx.arc(bx, by, 3, 0, Math.PI * 2);
          ctx.fill();

          ctx.fillStyle = '#ffffff';
          ctx.font = '10px ui-monospace, monospace';
          ctx.textAlign = 'center';
          ctx.fillText(`B${bIdx} (${powers[bIdx].toFixed(1)}dB)`, bx, by - 7);
        }
      }
    }

    ctx.strokeStyle = '#22324e';
    ctx.lineWidth = 1.5;
    ctx.strokeRect(pad, pad, plotW, plotH);

    ctx.fillStyle = '#8fa5c2';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [-0.03, -0.01, 0.01, 0.03].forEach((l, i) => {
      ctx.fillText(`l=${l.toFixed(2)}`, pad + (i / 3) * plotW, pad + plotH + 8);
    });

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    [-0.03, -0.01, 0.01, 0.03].forEach((m, i) => {
      ctx.fillText(`m=${m.toFixed(2)}`, pad - 6, pad + ((3 - i) / 3) * plotH);
    });

    const peakId = powers.indexOf(maxDb);
    const pRow = Math.floor(peakId / 4);
    const pCol = peakId % 4;
    const px = pad + (pCol / 3) * plotW;
    const py = pad + ((3 - pRow) / 3) * plotH;

    ctx.strokeStyle = '#fbbf24';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(px, py, 16, 0, Math.PI * 2);
    ctx.stroke();

    const centL = latestGrid.centroid_l !== undefined ? latestGrid.centroid_l : 0.0;
    const centM = latestGrid.centroid_m !== undefined ? latestGrid.centroid_m : 0.0;
    const normCentL = Math.max(0, Math.min(1, (centL + 0.03) / 0.06));
    const normCentM = Math.max(0, Math.min(1, (centM + 0.03) / 0.06));
    const cx = pad + normCentL * plotW;
    const cy = pad + (1 - normCentM) * plotH;

    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, 9, 0, Math.PI * 2);
    ctx.moveTo(cx - 14, cy);
    ctx.lineTo(cx + 14, cy);
    ctx.moveTo(cx, cy - 14);
    ctx.lineTo(cx, cy + 14);
    ctx.stroke();
  }

  // ==========================================================================
  // TAB 3: Astron WMMA Correlator & Baseline Inspector
  // ==========================================================================
  function drawCorrelatorMatrices() {
    if (!latestCorrelator) return;
    drawAmplitudeMatrix();
    drawPhaseMatrix();
  }

  function drawSplitCorrelatorMatrix() {
    const setup = resizeHiDPICanvas(corrSplitCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#03060d';
    ctx.fillRect(0, 0, width, height);

    if (!latestCorrelator || !latestCorrelator.coherence_matrix || !latestCorrelator.phase_matrix) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting 64×64 coherence & phase telemetry...', width / 2, height / 2);
      return;
    }

    const cohMatrix = latestCorrelator.coherence_matrix;
    const phaseMatrix = latestCorrelator.phase_matrix;

    const pad = 28;
    const side = Math.max(64, Math.min(width, height) - pad * 2);
    const ox = Math.floor((width - side) / 2);
    const oy = Math.floor((height - side) / 2);
    const cellW = side / 64;
    const cellH = side / 64;

    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        const x = ox + j * cellW;
        const y = oy + i * cellH;

        if (i === j) {
          ctx.fillStyle = '#111927';
          ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));
        } else if (i < j) {
          const coh = Math.max(0, Math.min(1, cohMatrix[i][j]));
          const rgb = viridisColor(coh);
          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));
        } else {
          const rad = phaseMatrix[i][j];
          const rgb = cyclicPhaseColor(rad);
          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.fillRect(x, y, Math.ceil(cellW), Math.ceil(cellH));
        }
      }
    }

    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(ox, oy);
    ctx.lineTo(ox + side, oy + side);
    ctx.stroke();

    if (baselineAntA >= 0 && baselineAntB >= 0) {
      const minAnt = Math.min(baselineAntA, baselineAntB);
      const maxAnt = Math.max(baselineAntA, baselineAntB);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + maxAnt * cellW - 1, oy + minAnt * cellH - 1, cellW + 2, cellH + 2);
      ctx.strokeRect(ox + minAnt * cellW - 1, oy + maxAnt * cellH - 1, cellW + 2, cellH + 2);
    }

    ctx.strokeStyle = '#22324e';
    ctx.lineWidth = 1;
    ctx.strokeRect(ox, oy, side, side);

    ctx.fillStyle = '#8fa5c2';
    ctx.font = '9px ui-monospace, monospace';
    const ticks = [0, 8, 16, 24, 32, 40, 48, 56, 63];
    ctx.textAlign = 'center';
    ticks.forEach(t => {
      ctx.fillText(`${t}`, ox + (t / 63) * side, oy + side + 10);
    });
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks.forEach(t => {
      ctx.fillText(`${t}`, ox - 5, oy + (t / 63) * side);
    });
  }

  async function inspectBaseline(antA, antB) {
    baselineAntA = antA;
    baselineAntB = antB;
    if (baseAntAInput) baseAntAInput.value = antA;
    if (baseAntBInput) baseAntBInput.value = antB;

    try {
      const res = await fetch(`/api/correlator/baseline/${antA}/${antB}`);
      if (res.ok) {
        latestBaselineData = await res.json();
        if (baselineInspectorTitle) {
          baselineInspectorTitle.textContent = `Baseline Inspector: Baseline (${antA}, ${antB})`;
        }
        if (baselineDelayBadge && latestBaselineData.delay_ns !== undefined) {
          baselineDelayBadge.textContent = `Delay τ: ${latestBaselineData.delay_ns.toFixed(2)} ns`;
        }
        requestAnimationFrame(drawFringePlot);
      }
    } catch (e) {
      console.error('Failed to inspect baseline', e);
    }
  }

  function drawAmplitudeMatrix() {
    const setup = resizeHiDPICanvas(corrAmpCanvas);
    if (!setup || !latestCorrelator || !latestCorrelator.amplitude_matrix) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, width, height);

    const matrix = latestCorrelator.amplitude_matrix;
    const pad = 24;
    const side = Math.max(64, Math.min(width, height) - pad * 2);
    const ox = Math.floor((width - side) / 2);
    const oy = Math.floor((height - side) / 2);

    let maxAmp = 0.001;
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        if (matrix[i][j] > maxAmp) maxAmp = matrix[i][j];
      }
    }
    if (corrAmpCbMax) corrAmpCbMax.textContent = maxAmp.toFixed(1);

    const cellW = side / 64;
    const cellH = side / 64;
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        const rgb = turboColor(matrix[i][j] / maxAmp);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(ox + j * cellW, oy + i * cellH, Math.ceil(cellW), Math.ceil(cellH));
      }
    }
  }

  function drawPhaseMatrix() {
    const setup = resizeHiDPICanvas(corrPhaseCanvas);
    if (!setup || !latestCorrelator || !latestCorrelator.phase_matrix) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#060a14';
    ctx.fillRect(0, 0, width, height);

    const matrix = latestCorrelator.phase_matrix;
    const pad = 24;
    const side = Math.max(64, Math.min(width, height) - pad * 2);
    const ox = Math.floor((width - side) / 2);
    const oy = Math.floor((height - side) / 2);
    const cellW = side / 64;
    const cellH = side / 64;

    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        const rgb = cyclicPhaseColor(matrix[i][j]);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(ox + j * cellW, oy + i * cellH, Math.ceil(cellW), Math.ceil(cellH));
      }
    }
  }

  function drawBandpassSpectrum() {
    const setup = resizeHiDPICanvas(corrBandpassCanvas);
    if (!setup || !latestCorrelator || !latestCorrelator.bandpass_db) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, width, height);

    const bp = latestCorrelator.bandpass_db;
    if (bp.length === 0) return;

    const padL = 42, padR = 14, padT = 12, padB = 22;
    const plotW = Math.max(10, width - padL - padR);
    const plotH = Math.max(10, height - padT - padB);

    const minDb = Math.floor((Math.min(...bp) - 2) / 5) * 5;
    const maxDb = Math.ceil((Math.max(...bp) + 2) / 5) * 5;
    const span = Math.max(5, maxDb - minDb);

    ctx.strokeStyle = '#121d33';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#5a7192';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';

    [300, 350, 400.8, 450, 500].forEach(freq => {
      const x = padL + ((freq - 300) / 201.3) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(`${freq} MHz`, x, padT + plotH + 6);
    });

    const subbandX = padL + ((400.8 - 300) / 201.3) * plotW;
    ctx.strokeStyle = '#00e5ff';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(subbandX, padT);
    ctx.lineTo(subbandX, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.strokeStyle = '#10b981';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let ch = 0; ch < bp.length; ch++) {
      const x = padL + (ch / (bp.length - 1)) * plotW;
      const y = padT + (1.0 - (bp[ch] - minDb) / span) * plotH;
      if (ch === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    if (bandpassHover.active && bandpassHover.cssX >= padL && bandpassHover.cssX <= padL + plotW) {
      const normX = (bandpassHover.cssX - padL) / plotW;
      const ch = Math.min(bp.length - 1, Math.max(0, Math.round(normX * (bp.length - 1))));
      const freq = 300.0 + ch * 0.3;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(bandpassHover.cssX, padT);
      ctx.lineTo(bandpassHover.cssX, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (corrBandpassHoverEl) {
        corrBandpassHoverEl.textContent = `Ch ${ch} (${freq.toFixed(2)} MHz) | Mean Auto: ${bp[ch].toFixed(2)} dB`;
      }
    }
  }

  function drawFringePlot() {
    const setup = resizeHiDPICanvas(fringeCanvas);
    if (!setup || !latestCorrelator) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, width, height);

    let ampArr, phaseArr, realArr, imagArr, delayNs = null;

    if (latestBaselineData && latestBaselineData.amplitude && latestBaselineData.phase_rad) {
      ampArr = latestBaselineData.amplitude;
      phaseArr = latestBaselineData.phase_rad;
      realArr = latestBaselineData.real || ampArr.map((a, i) => a * Math.cos(phaseArr[i]));
      imagArr = latestBaselineData.imag || ampArr.map((a, i) => a * Math.sin(phaseArr[i]));
      delayNs = latestBaselineData.delay_ns;
    } else if (latestCorrelator.reference_fringes && latestCorrelator.reference_fringes[fringeAntenna]) {
      const fringe = latestCorrelator.reference_fringes[fringeAntenna];
      ampArr = fringe.amplitude;
      phaseArr = fringe.phase_rad;
      realArr = fringe.real;
      imagArr = fringe.imag;
    } else {
      ctx.fillStyle = '#5a7192';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Click any baseline cell in the 64×64 matrix to inspect 672-ch fringes...', width / 2, height / 2);
      return;
    }

    const padL = 42, padR = 14, padT = 14, padB = 22;
    const plotW = Math.max(10, width - padL - padR);
    const plotH = Math.max(10, height - padT - padB);
    const nCh = ampArr.length;

    ctx.strokeStyle = '#121d33';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#5a7192';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';

    [300, 350, 400.8, 450, 500].forEach(freq => {
      const x = padL + ((freq - 300) / 201.3) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(`${freq} MHz`, x, padT + plotH + 6);
    });

    if (fringeMode === 'ri') {
      let maxAbs = 0.01;
      for (let ch = 0; ch < nCh; ch++) {
        if (Math.abs(realArr[ch]) > maxAbs) maxAbs = Math.abs(realArr[ch]);
        if (Math.abs(imagArr[ch]) > maxAbs) maxAbs = Math.abs(imagArr[ch]);
      }

      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      for (let ch = 0; ch < nCh; ch++) {
        const x = padL + (ch / (nCh - 1)) * plotW;
        const y = padT + (0.5 - realArr[ch] / (maxAbs * 2.1)) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.strokeStyle = '#f59e0b';
      ctx.beginPath();
      for (let ch = 0; ch < nCh; ch++) {
        const x = padL + (ch / (nCh - 1)) * plotW;
        const y = padT + (0.5 - imagArr[ch] / (maxAbs * 2.1)) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (fringeMode === 'amp') {
      const maxAmp = Math.max(0.01, ...ampArr);
      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let ch = 0; ch < nCh; ch++) {
        const x = padL + (ch / (nCh - 1)) * plotW;
        const y = padT + (1.0 - ampArr[ch] / (maxAmp * 1.05)) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (fringeMode === 'phase') {
      ctx.strokeStyle = '#d500f9';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let ch = 0; ch < nCh; ch++) {
        const x = padL + (ch / (nCh - 1)) * plotW;
        const y = padT + (1.0 - (phaseArr[ch] + Math.PI) / (2 * Math.PI)) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      if (delayNs !== null && delayNs !== undefined) {
        ctx.fillStyle = '#fbbf24';
        ctx.font = 'bold 10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`Fitted Delay τ = ${delayNs.toFixed(2)} ns`, padL + plotW - 4, padT + 10);
      }
    }

    if (fringeHover.active && fringeHover.cssX >= padL && fringeHover.cssX <= padL + plotW) {
      const normX = (fringeHover.cssX - padL) / plotW;
      const ch = Math.min(nCh - 1, Math.max(0, Math.round(normX * (nCh - 1))));
      const freq = 300.0 + ch * 0.3;
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(fringeHover.cssX, padT);
      ctx.lineTo(fringeHover.cssX, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (fringeHoverEl) {
        fringeHoverEl.textContent = `Ch ${ch} (${freq.toFixed(2)} MHz) | |V|=${ampArr[ch].toFixed(3)} | ∠V=${phaseArr[ch].toFixed(2)} rad | Re=${realArr[ch].toFixed(2)}, Im=${imagArr[ch].toFixed(2)}`;
      }
    }
  }

  // ==========================================================================
  // TAB 4: 8x8 Physical Array Health & HiDPI Masking Matrix
  // ==========================================================================
  function getAntennaSpectrum(antId) {
    const antennas = (latestAntennaMask && latestAntennaMask.antennas) ? latestAntennaMask.antennas : null;
    const item = antennas ? antennas[antId] : null;
    if (latestCorrelator && latestCorrelator.full_antenna_spectra_db && latestCorrelator.full_antenna_spectra_db[antId]) {
      return latestCorrelator.full_antenna_spectra_db[antId];
    }
    if (item && item.spectrum_db && item.spectrum_db.length > 0) {
      return item.spectrum_db;
    }
    if (latestCorrelator && latestCorrelator.antenna_spectra_db && latestCorrelator.antenna_spectra_db[antId]) {
      return latestCorrelator.antenna_spectra_db[antId];
    }
    const syn = [];
    for (let i = 0; i < 84; i++) {
      syn.push(12.0 + 3.0 * Math.sin((i / 84) * 3 * Math.PI) + Math.sin(i * 0.4 + antId) * 0.5);
    }
    return syn;
  }

  function drawMasterAntennaSpectrometer() {
    const setup = resizeHiDPICanvas(antMasterCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, width, height);

    const antennas = (latestAntennaMask && latestAntennaMask.antennas && latestAntennaMask.antennas.length === 64)
      ? latestAntennaMask.antennas
      : null;
    const item = antennas ? antennas[selectedAntennaId] : null;
    const isEnabled = item ? item.enabled : true;
    const row = Math.floor(selectedAntennaId / 8);
    const col = selectedAntennaId % 8;

    const spectrum = getAntennaSpectrum(selectedAntennaId);
    const nPoints = spectrum.length;
    let minDb = 100, maxDb = -100, sumDb = 0, peakIdx = 0;
    for (let i = 0; i < nPoints; i++) {
      const v = spectrum[i];
      if (v > maxDb) { maxDb = v; peakIdx = i; }
      if (v < minDb) minDb = v;
      sumDb += v;
    }
    const peakFreq = 300.0 + (peakIdx / Math.max(1, nPoints - 1)) * 201.6;
    const meanDb = nPoints > 0 ? (sumDb / nPoints) : 0;

    if (antMasterTitle) antMasterTitle.textContent = `Antenna #${String(selectedAntennaId).padStart(2, '0')} Live Line Spectrometer`;
    if (antMasterTile) antMasterTile.textContent = `Physical Tile: Row ${row}, Col ${col}`;
    if (antMasterBadge) {
      antMasterBadge.textContent = isEnabled ? 'NOMINAL (ACTIVE)' : 'MASKED (BLANKED)';
      antMasterBadge.className = `badge ${isEnabled ? 'status-nominal-badge' : 'status-masked-badge'}`;
    }
    if (antMasterPeak) antMasterPeak.textContent = `${maxDb.toFixed(1)} dB @ ${peakFreq.toFixed(1)} MHz`;
    if (antMasterMean) antMasterMean.textContent = `${meanDb.toFixed(1)} dB`;
    if (antMasterRms) antMasterRms.textContent = `${item ? item.power_rms.toFixed(2) : '--'} dB`;
    if (antMasterClip) antMasterClip.textContent = `${item ? (item.clip_fraction * 100).toFixed(2) : '--'}%`;
    if (antMasterKurt) antMasterKurt.textContent = `${item ? item.kurtosis.toFixed(2) : '--'}`;
    if (btnToggleSelectedMask) {
      btnToggleSelectedMask.textContent = isEnabled
        ? `Mask Antenna #${String(selectedAntennaId).padStart(2, '0')}`
        : `Unmask Antenna #${String(selectedAntennaId).padStart(2, '0')}`;
    }

    const padL = 44, padR = 18, padT = 14, padB = 22;
    const plotW = Math.max(10, width - padL - padR);
    const plotH = Math.max(10, height - padT - padB);

    const yMin = Math.min(0, Math.floor(minDb / 5) * 5);
    const yMax = Math.max(25, Math.ceil(maxDb / 5) * 5 + 5);
    const yRange = Math.max(10, yMax - yMin);

    ctx.strokeStyle = '#141d2e';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const yStep = yRange > 30 ? 10 : 5;
    for (let db = Math.ceil(yMin / yStep) * yStep; db <= yMax; db += yStep) {
      const y = padT + (1.0 - (db - yMin) / yRange) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${db}`, padL - 6, y);
    }

    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [300, 350, 400.8, 450, 501.6].forEach(f => {
      const x = padL + ((f - 300.0) / 201.6) * plotW;
      const isSplit = Math.abs(f - 400.8) < 0.1;
      ctx.strokeStyle = isSplit ? 'rgba(245, 158, 11, 0.45)' : '#141d2e';
      if (isSplit) ctx.setLineDash([4, 4]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isSplit ? '#fbbf24' : '#64748b';
      ctx.fillText(`${f}`, x, padT + plotH + 5);
    });

    if (!isEnabled) {
      ctx.fillStyle = 'rgba(99, 102, 241, 0.12)';
      ctx.fillRect(padL, padT, plotW, plotH);
      ctx.fillStyle = '#a5b4fc';
      ctx.font = 'bold 12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('ANTENNA VOLTAGES BLANKED IN VRAM (ZEROED TAPER)', padL + plotW / 2, padT + plotH / 2);
      return;
    }

    const fillGrad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    fillGrad.addColorStop(0, 'rgba(0, 229, 255, 0.26)');
    fillGrad.addColorStop(1, 'rgba(0, 229, 255, 0.01)');

    ctx.beginPath();
    ctx.moveTo(padL, padT + plotH);
    for (let i = 0; i < nPoints; i++) {
      const x = padL + (i / Math.max(1, nPoints - 1)) * plotW;
      const y = padT + (1.0 - (spectrum[i] - yMin) / yRange) * plotH;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(padL + plotW, padT + plotH);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let i = 0; i < nPoints; i++) {
      const x = padL + (i / Math.max(1, nPoints - 1)) * plotW;
      const y = padT + (1.0 - (spectrum[i] - yMin) / yRange) * plotH;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    const peakX = padL + (peakIdx / Math.max(1, nPoints - 1)) * plotW;
    const peakY = padT + (1.0 - (maxDb - yMin) / yRange) * plotH;
    ctx.fillStyle = '#ef4444';
    ctx.beginPath();
    ctx.arc(peakX, peakY, 3.5, 0, 2 * Math.PI);
    ctx.fill();

    if (masterAntennaHoverInfo) {
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(masterAntennaHoverInfo.cssX, padT);
      ctx.lineTo(masterAntennaHoverInfo.cssX, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  function renderAntennaMaskGrid(canvas, antennas) {
    const setup = resizeHiDPICanvas(canvas);
    if (!setup || !antennas) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#050811';
    ctx.fillRect(0, 0, width, height);

    const cols = 8, rows = 8, gap = 6;
    const cellW = (width - gap * (cols + 1)) / cols;
    const cellH = (height - gap * (rows + 1)) / rows;

    antennas.forEach((ant, idx) => {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const x = Math.round(gap + c * (cellW + gap));
      const y = Math.round(gap + r * (cellH + gap));
      const w = Math.round(cellW);
      const h = Math.round(cellH);

      const isSelected = idx === selectedAntennaId;
      const isHovered = idx === hoveredAntennaTile;
      const isMasked = !ant.enabled || ant.status === 'manually_masked' || ant.masked;
      const statusRaw = ant.status || 'nominal';
      const powerRms = ant.power_rms !== undefined ? ant.power_rms : 8.0;
      const clipPct = ((ant.clip_fraction || 0) * 100).toFixed(2);

      // Card background
      ctx.fillStyle = isMasked ? '#110d1b' : '#0e1628';
      ctx.fillRect(x, y, w, h);

      // Left status accent bar
      let accentColor = '#10b981';
      let badgeText = 'OK';
      if (isMasked) {
        accentColor = '#6366f1';
        badgeText = 'MASKED';
      } else if (statusRaw === 'saturated') {
        accentColor = '#ef4444';
        badgeText = 'SAT';
      } else if (statusRaw === 'high_clip') {
        accentColor = '#f59e0b';
        badgeText = 'CLIP';
      }
      ctx.fillStyle = accentColor;
      ctx.fillRect(x, y, 3, h);

      // Crisp border
      ctx.strokeStyle = isSelected
        ? '#00e5ff'
        : isHovered
          ? 'rgba(0, 229, 255, 0.6)'
          : isMasked
            ? 'rgba(99, 102, 241, 0.35)'
            : 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      // Header row: #A00 + Status Pill
      ctx.fillStyle = isMasked ? '#a5b4fc' : '#ffffff';
      ctx.font = '700 11px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`#${String(idx).padStart(2, '0')}`, x + 7, y + 5);

      ctx.fillStyle = accentColor;
      ctx.font = '700 9px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(badgeText, x + w - 5, y + 6);

      // Middle: Embedded High-Res 84-Bin Spectrum Sparkline
      const specTop = y + 20;
      const specH = Math.max(14, h - 38);
      const specLeft = x + 6;
      const specW = w - 12;

      ctx.fillStyle = '#060913';
      ctx.fillRect(specLeft, specTop, specW, specH);

      if (!isMasked) {
        const spec = (ant.spectrum_db && ant.spectrum_db.length > 0)
          ? ant.spectrum_db
          : (latestCorrelator && latestCorrelator.antenna_spectra_db && latestCorrelator.antenna_spectra_db[idx])
            ? latestCorrelator.antenna_spectra_db[idx]
            : null;

        if (spec && spec.length > 1) {
          let sMin = 5, sMax = 25;
          for (let k = 0; k < spec.length; k++) {
            if (spec[k] < sMin) sMin = spec[k];
            if (spec[k] > sMax) sMax = spec[k];
          }
          const sSpan = Math.max(6, sMax - sMin);

          ctx.strokeStyle = statusRaw === 'saturated' ? '#ef4444' : '#00e5ff';
          ctx.lineWidth = 1.25;
          ctx.beginPath();
          for (let k = 0; k < spec.length; k++) {
            const sx = specLeft + (k / (spec.length - 1)) * specW;
            const sy = specTop + specH - 2 - ((spec[k] - sMin) / sSpan) * (specH - 4);
            if (k === 0) ctx.moveTo(sx, sy);
            else ctx.lineTo(sx, sy);
          }
          ctx.stroke();
        }
      } else {
        ctx.strokeStyle = '#475569';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(specLeft, specTop + specH - 3);
        ctx.lineTo(specLeft + specW, specTop + specH - 3);
        ctx.stroke();
      }

      // Footer row: RMS & Clip
      ctx.fillStyle = '#8fa5c2';
      ctx.font = '9.5px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`RMS ${powerRms.toFixed(1)}dB`, x + 7, y + h - 4);

      ctx.textAlign = 'right';
      ctx.fillText(`${clipPct}%`, x + w - 5, y + h - 4);
    });
  }

  function drawMiniSpectrometer(canvas, spec, isEnabled, statusRaw) {
    const setup = resizeHiDPICanvas(canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, width, height);

    if (!isEnabled) {
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, height - 3);
      ctx.lineTo(width, height - 3);
      ctx.stroke();
      return;
    }

    if (!spec || spec.length === 0) return;
    const n = spec.length;
    let minV = 5, maxV = 25;
    for (let v of spec) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const range = Math.max(8, maxV - minV);

    ctx.strokeStyle = statusRaw === 'saturated' ? '#ef4444' : statusRaw === 'high_clip' ? '#f59e0b' : '#00e5ff';
    ctx.lineWidth = 1.35;
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * width;
      const y = height - ((spec[i] - minV) / range) * (height - 6) - 3;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  async function toggleAntennaMask(id, nextState) {
    try {
      const res = await fetch('/api/antennas/mask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ antenna_id: id, enabled: nextState })
      });
      const reply = await res.json();
      if (res.ok) {
        showToast(`Antenna #${id} ${nextState ? 'unmasked (enabled)' : 'masked (blanked)'}`);
        if (latestAntennaMask && latestAntennaMask.antennas && latestAntennaMask.antennas[id]) {
          latestAntennaMask.antennas[id].enabled = nextState;
        }
        renderArrayGrid();
        drawMasterAntennaSpectrometer();
      } else {
        showToast(reply.detail || 'Failed to toggle antenna', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  function renderArrayGrid() {
    let antennas = (latestAntennaMask && latestAntennaMask.antennas && latestAntennaMask.antennas.length === 64)
      ? latestAntennaMask.antennas
      : null;

    if (!antennas) {
      antennas = Array.from({ length: 64 }, (_, i) => ({
        antenna_id: i,
        enabled: true,
        power_rms: 8.0,
        clip_fraction: 0.001,
        kurtosis: 3.0,
        status: 'nominal',
        spectrum_db: getAntennaSpectrum(i)
      }));
    }

    if (antViewMode === 'canvas') {
      if (antennaMaskCanvas) {
        renderAntennaMaskGrid(antennaMaskCanvas, antennas);
      }
      return;
    }

    if (!arrayGrid8x8) return;
    arrayGrid8x8.innerHTML = '';

    for (let id = 0; id < 64; id++) {
      const item = antennas[id];
      const isEnabled = item ? item.enabled : true;
      const statusRaw = item ? item.status : 'nominal';
      const powerRms = item ? item.power_rms.toFixed(2) : '8.00';
      const clipPct = item ? (item.clip_fraction * 100).toFixed(2) : '0.01';

      let statusClass = 'status-nominal';
      let tagLabel = 'OK';
      if (!isEnabled || statusRaw === 'manually_masked') {
        statusClass = 'status-masked';
        tagLabel = 'MASKED';
      } else if (statusRaw === 'saturated') {
        statusClass = 'status-saturated';
        tagLabel = 'SAT';
      } else if (statusRaw === 'high_clip') {
        statusClass = 'status-high-clip';
        tagLabel = 'CLIP';
      }

      const spec = getAntennaSpectrum(id);
      const peakDb = (spec && spec.length > 0 && isEnabled) ? `${Math.max(...spec).toFixed(1)} dB` : '--';

      const card = document.createElement('div');
      card.className = `antenna-card ${statusClass} ${id === selectedAntennaId ? 'selected' : ''}`;
      card.innerHTML = `
        <div class="antenna-card-header">
          <span class="ant-id">#${String(id).padStart(2, '0')}</span>
          <span class="ant-power-peak">${peakDb}</span>
          <span class="ant-status-tag" title="Click to toggle mask">${tagLabel}</span>
        </div>
        <div class="ant-mini-spec-wrap">
          <canvas class="ant-mini-canvas" id="ant-mini-canvas-${id}"></canvas>
          ${!isEnabled ? '<div class="ant-mini-watermark">MASKED</div>' : ''}
        </div>
        <div class="ant-metrics">
          <div class="ant-metric-row"><span>RMS:</span><span class="ant-metric-val">${powerRms} dB</span></div>
          <div class="ant-metric-row"><span>Clip:</span><span class="ant-metric-val">${clipPct}%</span></div>
        </div>
      `;

      card.addEventListener('click', (e) => {
        if (e.target && e.target.classList.contains('ant-status-tag')) {
          e.stopPropagation();
          toggleAntennaMask(id, !isEnabled);
          return;
        }
        selectedAntennaId = id;
        document.querySelectorAll('.antenna-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        drawMasterAntennaSpectrometer();
      });

      // Append to DOM first so getBoundingClientRect() returns true dimensions for HiDPI scaling
      arrayGrid8x8.appendChild(card);
      const miniCanvas = card.querySelector(`#ant-mini-canvas-${id}`);
      if (miniCanvas) {
        drawMiniSpectrometer(miniCanvas, spec, isEnabled, statusRaw);
      }
    }
  }

  // ==========================================================================
  // Controls & Event Listeners
  // ==========================================================================
  function initControls() {
    initTabRouter();
    startUtcClock();

    if (tabBtnLm && tabBtnCelestial) {
      tabBtnLm.addEventListener('click', () => {
        tabBtnLm.classList.add('active');
        tabBtnCelestial.classList.remove('active');
        formSteerLm.classList.add('active');
        formSteerCelestial.classList.remove('active');
      });
      tabBtnCelestial.addEventListener('click', () => {
        tabBtnCelestial.classList.add('active');
        tabBtnLm.classList.remove('active');
        formSteerCelestial.classList.add('active');
        formSteerLm.classList.remove('active');
      });
    }

    if (formSteerLm) {
      formSteerLm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const beamId = parseInt(lmBeamSelect.value, 10);
        const l0 = parseFloat(document.getElementById('lm-l0').value);
        const m0 = parseFloat(document.getElementById('lm-m0').value);
        if (isNaN(l0) || isNaN(m0) || l0 * l0 + m0 * m0 > 1.0) {
          showToast('Invalid direction cosines (l0² + m0² must be <= 1.0)', true);
          return;
        }
        const payload = { beam_id: beamId, l0, m0 };
        ['l1', 'm1', 'dl', 'dm'].forEach(k => {
          const v = parseFloat(document.getElementById(`lm-${k}`).value);
          if (!isNaN(v)) payload[k] = v;
        });
        try {
          const res = await fetch(`/api/beams/${beamId}/target`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const reply = await res.json();
          showToast(res.ok ? (reply.message || `Beam ${beamId} steered`) : (reply.detail || 'Steer failed'), !res.ok);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    if (celPresetSelect) {
      celPresetSelect.addEventListener('change', () => {
        const val = celPresetSelect.value;
        if (val && CELESTIAL_PRESETS[val]) {
          document.getElementById('cel-ra').value = CELESTIAL_PRESETS[val].ra;
          document.getElementById('cel-dec').value = CELESTIAL_PRESETS[val].dec;
        }
      });
    }

    if (formSteerCelestial) {
      formSteerCelestial.addEventListener('submit', async (e) => {
        e.preventDefault();
        const beamId = parseInt(celBeamSelect.value, 10);
        const ra = parseFloat(document.getElementById('cel-ra').value);
        const dec = parseFloat(document.getElementById('cel-dec').value);
        try {
          const res = await fetch(`/api/beams/${beamId}/celestial`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ beam_id: beamId, ra_deg: ra, dec_deg: dec })
          });
          const reply = await res.json();
          showToast(res.ok ? (reply.message || `Beam ${beamId} pointed`) : (reply.detail || 'Pointing failed'), !res.ok);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    if (applyBeamsBtn) {
      applyBeamsBtn.addEventListener('click', async () => {
        const val = parseInt(numBeamsSelect.value, 10);
        try {
          const res = await fetch('/api/beams/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ num_active_beams: val })
          });
          const reply = await res.json();
          showToast(res.ok ? `Active beams set to ${val}` : (reply.detail || 'Failed'), !res.ok);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    if (interpToggle) {
      interpToggle.addEventListener('change', async () => {
        try {
          const res = await fetch('/api/interpolation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled: interpToggle.checked })
          });
          showToast(res.ok ? `Interpolation ${interpToggle.checked ? 'enabled' : 'disabled'}` : 'Failed', !res.ok);
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    if (specViewSelect) {
      specViewSelect.addEventListener('change', () => {
        specViewMode = specViewSelect.value;
        requestAnimationFrame(drawSpectrometer);
      });
    }

    if (specCanvas) {
      specCanvas.addEventListener('mousemove', (e) => {
        const rect = specCanvas.getBoundingClientRect();
        specHover.active = true;
        specHover.cssX = e.clientX - rect.left;
        specHover.cssY = e.clientY - rect.top;
        requestAnimationFrame(drawSpectrometer);
      });
      specCanvas.addEventListener('mouseleave', () => {
        specHover.active = false;
        if (specCursorReadout) {
          specCursorReadout.textContent = 'Hover cursor on spectrum to inspect frequency & beam power (dB)';
        }
        requestAnimationFrame(drawSpectrometer);
      });
    }

    if (waterfallBeamSelect) {
      waterfallBeamSelect.addEventListener('change', () => {
        waterfallFilterMode = waterfallBeamSelect.value;
        requestAnimationFrame(drawMultiWaterfalls);
      });
    }

    if (waterfallClearBtn) {
      waterfallClearBtn.addEventListener('click', () => {
        waterfallHistoriesByBeam = {};
        requestAnimationFrame(drawMultiWaterfalls);
      });
    }

    if (skyCanvas) {
      skyCanvas.addEventListener('mousemove', (e) => {
        const rect = skyCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cx = rect.width / 2;
        const cy = rect.height / 2;
        const r = Math.max(20, Math.min(rect.width, rect.height) / 2 - 18);
        const l = (x - cx) / r;
        const m = (cy - y) / r;
        if (cursorCoords) {
          cursorCoords.textContent = `l:${l.toFixed(2)} m:${m.toFixed(2)}`;
        }
      });
    }

    if (btnToggleSteerDrawer && steerDrawer) {
      btnToggleSteerDrawer.addEventListener('click', () => steerDrawer.classList.toggle('hidden'));
    }
    if (btnCloseSteerDrawer && steerDrawer) {
      btnCloseSteerDrawer.addEventListener('click', () => steerDrawer.classList.add('hidden'));
    }

    if (btnModeOverlay && btnModeSmallMult) {
      btnModeOverlay.addEventListener('click', () => {
        trackerSpecMode = 'overlay';
        btnModeOverlay.classList.add('active');
        btnModeSmallMult.classList.remove('active');
        requestAnimationFrame(drawSpectrometer);
      });
      btnModeSmallMult.addEventListener('click', () => {
        trackerSpecMode = 'small-mult';
        btnModeSmallMult.classList.add('active');
        btnModeOverlay.classList.remove('active');
        requestAnimationFrame(drawSpectrometer);
      });
    }

    // Tab 2 Controls
    document.querySelectorAll('#grid-slice-buttons .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#grid-slice-buttons .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        gridSliceMode = btn.getAttribute('data-slice');
        if (latestGrid) {
          renderGridTable(latestGrid);
          requestAnimationFrame(drawGridHeatmap);
        }
      });
    });

    document.querySelectorAll('#grid-mode-buttons .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#grid-mode-buttons .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        gridDisplayMode = btn.getAttribute('data-mode');
        requestAnimationFrame(drawGridHeatmap);
      });
    });

    if (btnViewWaterfalls && btnViewCamera && gridWaterfallsPanel && gridTablePanel) {
      btnViewWaterfalls.addEventListener('click', () => {
        gridRightPanelMode = 'waterfalls';
        btnViewWaterfalls.classList.add('active');
        btnViewCamera.classList.remove('active');
        gridWaterfallsPanel.classList.remove('hidden');
        gridTablePanel.classList.add('hidden');
        requestAnimationFrame(renderGridWaterfalls);
      });
      btnViewCamera.addEventListener('click', () => {
        gridRightPanelMode = 'table';
        btnViewCamera.classList.add('active');
        btnViewWaterfalls.classList.remove('active');
        gridTablePanel.classList.remove('hidden');
        gridWaterfallsPanel.classList.add('hidden');
      });
    }

    // Tab 3 Controls
    if (btnCorrViewSplit && btnCorrViewDual && corrSplitCard && corrDualLayout) {
      btnCorrViewSplit.addEventListener('click', () => {
        corrViewMode = 'split';
        btnCorrViewSplit.classList.add('active');
        btnCorrViewDual.classList.remove('active');
        corrSplitCard.classList.remove('hidden');
        corrDualLayout.classList.add('hidden');
        requestAnimationFrame(drawSplitCorrelatorMatrix);
      });
      btnCorrViewDual.addEventListener('click', () => {
        corrViewMode = 'dual';
        btnCorrViewDual.classList.add('active');
        btnCorrViewSplit.classList.remove('active');
        corrSplitCard.classList.add('hidden');
        corrDualLayout.classList.remove('hidden');
        requestAnimationFrame(drawCorrelatorMatrices);
      });
    }

    document.querySelectorAll('#fringe-baseline-buttons .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#fringe-baseline-buttons .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fringeAntenna = parseInt(btn.getAttribute('data-ant'), 10);
        inspectBaseline(0, fringeAntenna);
        requestAnimationFrame(drawSplitCorrelatorMatrix);
      });
    });

    document.querySelectorAll('#fringe-mode-buttons .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#fringe-mode-buttons .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fringeMode = btn.getAttribute('data-mode');
        requestAnimationFrame(drawFringePlot);
      });
    });

    if (btnInspectBaseline && baseAntAInput && baseAntBInput) {
      btnInspectBaseline.addEventListener('click', () => {
        const a = parseInt(baseAntAInput.value, 10);
        const b = parseInt(baseAntBInput.value, 10);
        if (!isNaN(a) && !isNaN(b) && a >= 0 && a < 64 && b >= 0 && b < 64) {
          inspectBaseline(a, b);
          requestAnimationFrame(drawSplitCorrelatorMatrix);
        }
      });
    }

    if (corrSplitCanvas) {
      function getMatrixCoords(e) {
        const rect = corrSplitCanvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const pad = 28;
        const side = Math.max(64, Math.min(rect.width, rect.height) - pad * 2);
        const ox = Math.floor((rect.width - side) / 2);
        const oy = Math.floor((rect.height - side) / 2);
        if (cx < ox || cx > ox + side || cy < oy || cy > oy + side) return null;
        const j = Math.min(63, Math.max(0, Math.floor(((cx - ox) / side) * 64)));
        const i = Math.min(63, Math.max(0, Math.floor(((cy - oy) / side) * 64)));
        return { i, j };
      }

      corrSplitCanvas.addEventListener('mousemove', (e) => {
        if (!latestCorrelator || !corrSplitHoverEl) return;
        const coords = getMatrixCoords(e);
        if (!coords) return;
        const { i, j } = coords;
        if (i === j) {
          const autoDb = latestCorrelator.auto_db ? latestCorrelator.auto_db[i] : '--';
          corrSplitHoverEl.textContent = `Diagonal (i=${i}): Antenna #${i} Auto-Power = ${autoDb} dB`;
        } else if (i < j) {
          const coh = latestCorrelator.coherence_matrix ? latestCorrelator.coherence_matrix[i][j].toFixed(4) : '--';
          corrSplitHoverEl.textContent = `Upper Triangle: Baseline (${i}, ${j}) Coherence |Γij| = ${coh} · Click to inspect 672-ch fringe`;
        } else {
          const ph = latestCorrelator.phase_matrix ? latestCorrelator.phase_matrix[i][j] : 0;
          corrSplitHoverEl.textContent = `Lower Triangle: Baseline (${i}, ${j}) Phase φij = ${ph.toFixed(3)} rad (${((ph * 180) / Math.PI).toFixed(1)}°) · Click to inspect`;
        }
      });

      corrSplitCanvas.addEventListener('click', (e) => {
        const coords = getMatrixCoords(e);
        if (!coords) return;
        let a = Math.min(coords.i, coords.j);
        let b = Math.max(coords.i, coords.j);
        if (a === b) b = (a + 1) % 64;
        inspectBaseline(a, b);
        requestAnimationFrame(drawSplitCorrelatorMatrix);
      });
    }

    if (corrBandpassCanvas) {
      corrBandpassCanvas.addEventListener('mousemove', (e) => {
        const rect = corrBandpassCanvas.getBoundingClientRect();
        bandpassHover.active = true;
        bandpassHover.cssX = e.clientX - rect.left;
        requestAnimationFrame(drawBandpassSpectrum);
      });
      corrBandpassCanvas.addEventListener('mouseleave', () => {
        bandpassHover.active = false;
        requestAnimationFrame(drawBandpassSpectrum);
      });
    }

    if (fringeCanvas) {
      fringeCanvas.addEventListener('mousemove', (e) => {
        const rect = fringeCanvas.getBoundingClientRect();
        fringeHover.active = true;
        fringeHover.cssX = e.clientX - rect.left;
        requestAnimationFrame(drawFringePlot);
      });
      fringeCanvas.addEventListener('mouseleave', () => {
        fringeHover.active = false;
        requestAnimationFrame(drawFringePlot);
      });
    }

    // Tab 4 Controls
    async function toggleAutoDetect() {
      const currentState = (latestAntennaMask && latestAntennaMask.auto_detect_enabled !== undefined)
        ? latestAntennaMask.auto_detect_enabled
        : true;
      const targetState = !currentState;
      try {
        const res = await fetch('/api/antennas/auto_detect', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: targetState })
        });
        if (res.ok) {
          if (latestAntennaMask) latestAntennaMask.auto_detect_enabled = targetState;
          handleAntennaMaskUpdate(latestAntennaMask);
          showToast(`Auto-detect ${targetState ? 'enabled' : 'disabled'}`);
        }
      } catch (err) {
        showToast(err.message, true);
      }
    }

    if (btnToggleAutodetect) btnToggleAutodetect.addEventListener('click', toggleAutoDetect);
    if (pillAutodetect) pillAutodetect.addEventListener('click', toggleAutoDetect);

    if (btnUnmaskAll) {
      btnUnmaskAll.addEventListener('click', async () => {
        const res = await fetch('/api/antennas/unmask_all', { method: 'POST' });
        if (res.ok && latestAntennaMask && latestAntennaMask.antennas) {
          latestAntennaMask.antennas.forEach(a => { a.enabled = true; });
          renderArrayGrid();
          drawMasterAntennaSpectrometer();
          showToast('All 64 antennas unmasked');
        }
      });
    }

    if (btnMaskAll) {
      btnMaskAll.addEventListener('click', async () => {
        if (!latestAntennaMask || !latestAntennaMask.antennas) return;
        await Promise.all(latestAntennaMask.antennas.map(a =>
          fetch('/api/antennas/mask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ antenna_id: a.antenna_id, enabled: false })
          })
        ));
        latestAntennaMask.antennas.forEach(a => { a.enabled = false; });
        renderArrayGrid();
        drawMasterAntennaSpectrometer();
        showToast('All 64 antennas masked');
      });
    }

    if (btnInvertMask) {
      btnInvertMask.addEventListener('click', async () => {
        if (!latestAntennaMask || !latestAntennaMask.antennas) return;
        await Promise.all(latestAntennaMask.antennas.map(a =>
          fetch('/api/antennas/mask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ antenna_id: a.antenna_id, enabled: !a.enabled })
          })
        ));
        latestAntennaMask.antennas.forEach(a => { a.enabled = !a.enabled; });
        renderArrayGrid();
        drawMasterAntennaSpectrometer();
        showToast('Antenna mask inverted');
      });
    }

    if (btnToggleSelectedMask) {
      btnToggleSelectedMask.addEventListener('click', () => {
        const item = (latestAntennaMask && latestAntennaMask.antennas) ? latestAntennaMask.antennas[selectedAntennaId] : null;
        toggleAntennaMask(selectedAntennaId, !(item ? item.enabled : true));
      });
    }

    if (antMasterCanvas && antMasterHover) {
      antMasterCanvas.addEventListener('mousemove', (e) => {
        const rect = antMasterCanvas.getBoundingClientRect();
        const cssX = e.clientX - rect.left;
        const padL = 44, padR = 18;
        const plotW = rect.width - padL - padR;
        const normX = (cssX - padL) / plotW;
        if (normX >= 0 && normX <= 1) {
          const fMhz = 300.0 + normX * 201.6;
          const spec = getAntennaSpectrum(selectedAntennaId);
          const idx = Math.min(spec.length - 1, Math.max(0, Math.round(normX * (spec.length - 1))));
          masterAntennaHoverInfo = { cssX };
          antMasterHover.textContent = `${fMhz.toFixed(2)} MHz | ${(spec[idx] || 0).toFixed(1)} dB`;
          antMasterHover.classList.remove('hidden');
          requestAnimationFrame(drawMasterAntennaSpectrometer);
        } else {
          masterAntennaHoverInfo = null;
          antMasterHover.classList.add('hidden');
          requestAnimationFrame(drawMasterAntennaSpectrometer);
        }
      });
      antMasterCanvas.addEventListener('mouseleave', () => {
        masterAntennaHoverInfo = null;
        antMasterHover.classList.add('hidden');
        requestAnimationFrame(drawMasterAntennaSpectrometer);
      });
    }

    if (btnAntViewCanvas && btnAntViewCards && antennaMaskCanvasWrap && arrayGrid8x8) {
      btnAntViewCanvas.addEventListener('click', () => {
        antViewMode = 'canvas';
        btnAntViewCanvas.classList.add('active');
        btnAntViewCards.classList.remove('active');
        antennaMaskCanvasWrap.classList.remove('hidden');
        arrayGrid8x8.classList.add('hidden');
        requestAnimationFrame(renderArrayGrid);
      });
      btnAntViewCards.addEventListener('click', () => {
        antViewMode = 'cards';
        btnAntViewCards.classList.add('active');
        btnAntViewCanvas.classList.remove('active');
        antennaMaskCanvasWrap.classList.add('hidden');
        arrayGrid8x8.classList.remove('hidden');
        requestAnimationFrame(renderArrayGrid);
      });
    }

    if (antennaMaskCanvas) {
      function getAntennaTileFromEvent(e) {
        const rect = antennaMaskCanvas.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const cols = 8, rows = 8, gap = 6;
        const cellW = (rect.width - gap * (cols + 1)) / cols;
        const cellH = (rect.height - gap * (rows + 1)) / rows;
        const col = Math.floor((x - gap) / (cellW + gap));
        const row = Math.floor((y - gap) / (cellH + gap));
        if (col >= 0 && col < cols && row >= 0 && row < rows) {
          return row * cols + col;
        }
        return -1;
      }

      antennaMaskCanvas.addEventListener('mousemove', (e) => {
        const idx = getAntennaTileFromEvent(e);
        hoveredAntennaTile = idx;
        if (idx >= 0 && latestAntennaMask && latestAntennaMask.antennas && antennaMaskHoverEl) {
          const ant = latestAntennaMask.antennas[idx];
          if (ant) {
            antennaMaskHoverEl.textContent = `Antenna #${String(idx).padStart(2, '0')} [R${Math.floor(idx / 8)}C${idx % 8}] | ${ant.enabled ? 'ACTIVE' : 'MASKED'} | RMS: ${(ant.power_rms || 0).toFixed(2)} dB | Clip: ${((ant.clip_fraction || 0) * 100).toFixed(2)}% (Double-click to toggle mask)`;
            antennaMaskHoverEl.classList.remove('hidden');
          }
        } else if (antennaMaskHoverEl) {
          antennaMaskHoverEl.classList.add('hidden');
        }
        requestAnimationFrame(renderArrayGrid);
      });

      antennaMaskCanvas.addEventListener('mouseleave', () => {
        hoveredAntennaTile = -1;
        if (antennaMaskHoverEl) antennaMaskHoverEl.classList.add('hidden');
        requestAnimationFrame(renderArrayGrid);
      });

      antennaMaskCanvas.addEventListener('click', (e) => {
        const idx = getAntennaTileFromEvent(e);
        if (idx >= 0) {
          selectedAntennaId = idx;
          drawMasterAntennaSpectrometer();
          renderArrayGrid();
        }
      });

      antennaMaskCanvas.addEventListener('dblclick', (e) => {
        const idx = getAntennaTileFromEvent(e);
        if (idx >= 0 && latestAntennaMask && latestAntennaMask.antennas && latestAntennaMask.antennas[idx]) {
          const ant = latestAntennaMask.antennas[idx];
          toggleAntennaMask(idx, !ant.enabled);
        }
      });
    }
  }

  window.addEventListener('DOMContentLoaded', () => {
    initControls();
    initWebSocket();
    inspectBaseline(0, 4);
  });
})();

