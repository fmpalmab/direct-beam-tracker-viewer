// Direct Beam Tracker & Observatory Dashboard — Frontend Client (F4.1–F4.6)
(function() {
  'use strict';

  // --- Constants & Color Schemes ---
  const BEAM_COLORS = [
    '#00e5ff', '#ff9100', '#00e676', '#d500f9',
    '#ff1744', '#ffea00', '#2979ff', '#ff4081',
    '#14b8a6', '#f97316', '#a855f7', '#06b6d4',
    '#eab308', '#ec4899', '#84cc16', '#6366f1'
  ];

  const CELESTIAL_PRESETS = {
    'cas_a': { ra: 350.866, dec: 58.812 },
    'cyg_a': { ra: 299.868, dec: 40.734 },
    'crab': { ra: 83.633, dec: 22.014 },
    'vir_a': { ra: 187.706, dec: 12.391 },
    '3c273': { ra: 187.278, dec: 2.052 },
    'psr_b0329': { ra: 53.248, dec: 54.579 },
    'sun': { ra: 0.0, dec: 0.0 }
  };

  // --- Global Application State ---
  let activeTab = 'tab-tracker';
  let ws = null;
  let pollTimerFast = null;
  let pollTimerSlow = null;
  let wsRetryTimer = null;
  let toastTimer = null;

  // Telemetry caches
  let currentStatus = null;
  let routineState = null;
  let latestSpectrometer = null;
  let latestGrid = null;
  let latestCorrelator = null;
  let latestAntennaMask = null;

  // Tab 1 (Tracker) State
  // Tab 1 (Tracker) State
  let selectedBeamId = 0;
  let beamTrails = {};
  let specViewMode = 'all';
  let trackerSpecMode = 'overlay'; // 'overlay', 'small-mult', 'sky'
  let specHover = { active: false, x: 0, y: 0 };
  let specZoom = { fMin: 300.0, fMax: 501.3, dbMin: -45.0, dbMax: 10.0, userZoomed: false };
  let waterfallHistory = []; // array of { timestamp, powers: [672] }
  let waterfallHistoriesByBeam = {}; // { [beamId]: array of { timestamp, power } }
  let waterfallBeamId = 0;
  const MAX_WATERFALL_ROWS = 90;

  // Tab 2 (Grid Camera) State & Persistent Decoupled Offscreen Rings
  let gridSliceMode = 'full'; // 'full', 'sub0', 'sub1'
  let gridDisplayMode = 'contour'; // 'contour', 'cells'
  let gridViewMode = 'camera'; // 'camera', 'waterfalls'
  let gridHover = { active: false, x: 0, y: 0, row: -1, col: -1, beamId: -1 };

  const GRID_BEAMS = 16;
  const FREQ_BINS = 168; // e.g. 672 channels downsampled 4x, or full 672
  const HISTORY_LEN = 80;

  // Initialize 16 persistent offscreen waterfall buffers (independent of DOM visibility)
  const gridOffscreen = Array.from({ length: GRID_BEAMS }, () => {
    const c = document.createElement('canvas');
    c.width = FREQ_BINS;
    c.height = HISTORY_LEN;
    return {
      canvas: c,
      ctx: c.getContext('2d', { willReadFrequently: true }),
      rowImage: c.getContext('2d').createImageData(FREQ_BINS, 1)
    };
  });

  // Tab 3 (Correlator) State
  let corrViewMode = 'split'; // 'split', 'dual'
  let baselineAntA = 0;
  let baselineAntB = 4;
  let latestBaselineData = null;
  let fringeAntenna = 4; // one of 0, 4, 6, 8, 32
  let fringeMode = 'ri'; // 'ri', 'amp', 'phase'
  let corrAmpHover = { active: false, i: -1, j: -1, val: 0 };
  let corrPhaseHover = { active: false, i: -1, j: -1, val: 0 };
  let corrSplitHover = { active: false, i: -1, j: -1, isUpper: true, val: 0 };
  let bandpassHover = { active: false, freq: 0, power: 0 };
  let fringeHover = { active: false, freq: 0, val: 0 };

  // Tab 4 (Array) State
  let antViewMode = 'canvas'; // 'canvas', 'cards'

  // --- DOM Elements ---
  // Header
  const utcClockEl = document.getElementById('utc-clock');
  const connBadge = document.getElementById('conn-badge');
  const connLabel = document.getElementById('conn-label');
  const activeBeamsSummary = document.getElementById('active-beams-summary');
  const activeElementsSummary = document.getElementById('active-elements-summary');
  const routineSummary = document.getElementById('routine-summary');
  const toast = document.getElementById('toast-message');

  // Tab 1 Elements (Zone A, B, C)
  const skyCanvas = document.getElementById('sky-canvas');
  const skyCtx = skyCanvas ? skyCanvas.getContext('2d') : null;
  const cursorCoords = document.getElementById('cursor-coords');
  const specCanvas = document.getElementById('spectrometer-canvas');
  const specCtx = specCanvas ? specCanvas.getContext('2d') : null;
  const specViewSelect = document.getElementById('spec-view-select');
  const specResetZoomBtn = document.getElementById('spec-reset-zoom-btn');
  const specCursorReadout = document.getElementById('spec-cursor-readout');
  const specLegend = document.getElementById('spec-legend');
  const specStats = document.getElementById('spec-stats');
  const waterfallCanvas = document.getElementById('waterfall-canvas');
  const waterfallCtx = waterfallCanvas ? waterfallCanvas.getContext('2d') : null;
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
  const btnModeSky = document.getElementById('btn-mode-sky');
  const multiWaterfallStack = document.getElementById('multi-waterfall-stack');

  // Tab 2 Elements
  const gridCanvas = document.getElementById('grid-canvas');
  const gridCtx = gridCanvas ? gridCanvas.getContext('2d') : null;
  const gridHoverReadout = document.getElementById('grid-hover-readout');
  const gridCentroidReadout = document.getElementById('grid-centroid-readout');
  const gridPeakReadout = document.getElementById('grid-peak-readout');
  const gridTotalFlux = document.getElementById('grid-total-flux');
  const gridBeamTbody = document.getElementById('grid-beam-tbody');
  const gridCbMin = document.getElementById('grid-cb-min');
  const gridCbMax = document.getElementById('grid-cb-max');
  const btnViewCamera = document.getElementById('btn-view-camera');
  const btnViewWaterfalls = document.getElementById('btn-view-waterfalls');
  const gridCameraView = document.getElementById('grid-camera-view');
  const gridWaterfallsPanel = document.getElementById('grid-waterfalls-panel');
  const gridWaterfallsMatrix = document.getElementById('grid-waterfalls-matrix');

  // Tab 3 Elements
  const btnCorrViewSplit = document.getElementById('btn-corr-view-split');
  const btnCorrViewDual = document.getElementById('btn-corr-view-dual');
  const corrSplitCard = document.getElementById('corr-split-card');
  const corrDualLayout = document.getElementById('corr-dual-layout');
  const corrSplitCanvas = document.getElementById('corr-split-canvas');
  const corrSplitHoverEl = document.getElementById('corr-split-hover');
  const corrAmpCanvas = document.getElementById('corr-amp-canvas');
  const corrAmpCtx = corrAmpCanvas ? corrAmpCanvas.getContext('2d') : null;
  const corrAmpHoverEl = document.getElementById('corr-amp-hover');
  const corrAmpCbMax = document.getElementById('corr-amp-cb-max');
  const corrPhaseCanvas = document.getElementById('corr-phase-canvas');
  const corrPhaseCtx = corrPhaseCanvas ? corrPhaseCanvas.getContext('2d') : null;
  const corrPhaseHoverEl = document.getElementById('corr-phase-hover');
  const corrBandpassCanvas = document.getElementById('corr-bandpass-canvas');
  const corrBandpassCtx = corrBandpassCanvas ? corrBandpassCanvas.getContext('2d') : null;
  const corrBandpassHoverEl = document.getElementById('corr-bandpass-hover');
  const fringeCanvas = document.getElementById('fringe-canvas');
  const fringeCtx = fringeCanvas ? fringeCanvas.getContext('2d') : null;
  const fringeHoverEl = document.getElementById('fringe-hover');
  const baselineInspectorTitle = document.getElementById('baseline-inspector-title');
  const baselineDelayBadge = document.getElementById('baseline-delay-badge');
  const baseAntAInput = document.getElementById('base-ant-a');
  const baseAntBInput = document.getElementById('base-ant-b');
  const btnInspectBaseline = document.getElementById('btn-inspect-baseline');

  // Tab 4 Elements
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
  const antMasterCtx = antMasterCanvas ? antMasterCanvas.getContext('2d') : null;
  const antMasterHover = document.getElementById('ant-master-hover');
  let selectedAntennaId = 0;
  let masterAntennaHoverInfo = null;

  // --- Utility Functions ---
  function resizeHiDPICanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null; // Guard against hidden tabs

    const targetW = Math.round(rect.width * dpr);
    const targetH = Math.round(rect.height * dpr);
    if (canvas.width !== targetW || canvas.height !== targetH) {
      canvas.width = targetW;
      canvas.height = targetH;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // Work in CSS pixels with HiDPI sharpness
    ctx.imageSmoothingEnabled = false;
    return { ctx, width: rect.width, height: rect.height };
  }

  function showToast(msg, isError = false) {
    if (toastTimer) clearTimeout(toastTimer);
    toast.textContent = msg;
    toast.className = `toast ${isError ? 'error' : 'success'}`;
    toastTimer = setTimeout(() => {
      toast.className = 'toast hidden';
    }, 4500);
  }

  function setConnectionState(state, text) {
    connBadge.className = `status-badge ${state}`;
    connLabel.textContent = text;
  }

  function startUtcClock() {
    function tick() {
      const now = new Date();
      const iso = now.toISOString(); // e.g. 2026-10-17T16:50:00.123Z
      const timeStr = iso.substring(11, 19);
      if (utcClockEl) utcClockEl.textContent = `${timeStr} UTC`;
    }
    tick();
    setInterval(tick, 1000);
  }

  // --- Colormap Palettes ---
  function viridisColor(val) {
    // val in [0, 1]
    const clamped = Math.max(0, Math.min(1, val));
    const r = Math.round(255 * (0.28 + 0.72 * Math.sin(clamped * Math.PI - 0.2)));
    const g = Math.round(255 * (0.01 + 0.95 * Math.sin(clamped * Math.PI * 0.9)));
    const b = Math.round(255 * (0.35 + 0.65 * Math.cos(clamped * Math.PI * 0.8)));
    return [Math.max(0, Math.min(255, r)), Math.max(0, Math.min(255, g)), Math.max(0, Math.min(255, b))];
  }

  function infernoColor(val) {
    // val in [0, 1]
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
    // Fast polynomial Turbo approximation
    const x = Math.max(0, Math.min(1, val));
    const r = Math.round(255 * Math.max(0, Math.min(1, 0.1357 + x * (4.6153 + x * (-42.6603 + x * (132.131 - x * (152.9423 - 59.2863 * x)))))));
    const g = Math.round(255 * Math.max(0, Math.min(1, 0.0914 + x * (2.1941 + x * (4.8429 + x * (-14.1850 + x * (4.27726 + 2.82956 * x)))))));
    const b = Math.round(255 * Math.max(0, Math.min(1, 0.1066 + x * (12.585 + x * (-60.197 + x * (109.0745 - x * (88.5022 - 26.8115 * x)))))));
    return [r, g, b];
  }

  function cyclicPhaseColor(rad) {
    // rad in [-pi, +pi] -> normalize to [0, 1]
    const norm = (rad + Math.PI) / (2 * Math.PI);
    const t = Math.max(0, Math.min(1, norm));
    // Blue (-pi) -> Cyan -> White (0) -> Amber -> Red (+pi)
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

  function powerToColor(power_db) {
    const val = power_db !== undefined ? power_db : 10.0;
    const norm = Math.max(0, Math.min(1, (val - 0.0) / 25.0));
    const rgb = viridisColor(norm);
    return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
  }

  // --- Navigation Tab Switching Router ---
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

        // Redraw canvases on active tab
        requestAnimationFrame(renderActiveTabCanvases);
      });
    });
  }

  function renderActiveTabCanvases() {
    if (activeTab === 'tab-tracker') {
      if (trackerSpecMode === 'sky') {
        drawSkyMap();
      } else {
        drawSpectrometer();
      }
      drawMultiWaterfalls();
    } else if (activeTab === 'tab-grid') {
      if (gridViewMode === 'camera') {
        drawGridHeatmap();
      } else {
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
      if (antViewMode === 'canvas' && latestAntennaMask && latestAntennaMask.antennas) {
        renderAntennaMaskGrid(antennaMaskCanvas, latestAntennaMask.antennas);
      } else {
        renderArrayGrid();
      }
    }
  }

  // --- WebSocket Multi-Stream Client & REST Fallback ---
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
        const payload = JSON.parse(event.data);
        handleIncomingMessage(payload);
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

    // Fast 1 Hz loop for status, spectrometer, grid
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

        if (resSpec && resSpec.ok) {
          handleSpectrometerUpdate(await resSpec.json());
        }

        if (resGrid && resGrid.ok) {
          handleGridUpdate(await resGrid.json());
        }
      } catch (e) {
        setConnectionState('disconnected', 'Disconnected');
      }
    }, 1000);

    // Slow 2 Hz loop for correlator, antenna mask, routine
    pollTimerSlow = setInterval(async () => {
      try {
        const [resCorr, resMask, resRoutine] = await Promise.all([
          fetch('/api/correlator').catch(() => null),
          fetch('/api/antenna_mask').catch(() => null),
          fetch('/api/routine').catch(() => null),
        ]);

        if (resCorr && resCorr.ok) {
          handleCorrelatorUpdate(await resCorr.json());
        }
        if (resMask && resMask.ok) {
          handleAntennaMaskUpdate(await resMask.json());
        }
        if (resRoutine && resRoutine.ok) {
          handleRoutineUpdate(await resRoutine.json());
        }
      } catch (e) {
        // Handled silently
      }
    }, 2000);
  }

  function stopFallbackPolling() {
    if (pollTimerFast) {
      clearInterval(pollTimerFast);
      pollTimerFast = null;
    }
    if (pollTimerSlow) {
      clearInterval(pollTimerSlow);
      pollTimerSlow = null;
    }
  }

  // --- Handlers for Telemetry Streams ---

  // 1. Status Telemetry
  function handleStatusUpdate(status) {
    if (!status) return;
    currentStatus = status;

    // Header status bar
    const maxBeams = 4;
    const activeBeams = status.num_active_beams !== undefined ? status.num_active_beams : (status.beams ? status.beams.length : 0);
    if (activeBeamsSummary) {
      activeBeamsSummary.textContent = `${activeBeams} / ${maxBeams}`;
    }

    const activeAnts = status.active_antennas !== undefined ? status.active_antennas : 64;
    if (activeElementsSummary) {
      activeElementsSummary.textContent = `${activeAnts} / 64`;
    }

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

  // 2. Routine Telemetry
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
    if (activeTab === 'tab-tracker') {
      requestAnimationFrame(drawSkyMap);
    }
  }

  function beamName(beamId) {
    if (routineState && routineState.beam_names) {
      return routineState.beam_names[String(beamId)] || null;
    }
    return null;
  }

  // 3. Spectrometer Telemetry (Engine 1)
  function handleSpectrometerUpdate(specData) {
    if (!specData || !specData.beams) return;
    latestSpectrometer = specData;

    updateSpectrometerViewSelect(specData.beams);
    renderSpectrometerFooter(specData.beams);

    // Append to waterfall history for all active beams
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

    const b = specData.beams[waterfallBeamId] || specData.beams['0'] || specData.beams[0];
    if (b && b.power_db && b.power_db.length > 0) {
      waterfallHistory.unshift({
        timestamp: specData.timestamp,
        power: b.power_db
      });
      if (waterfallHistory.length > MAX_WATERFALL_ROWS) {
        waterfallHistory.pop();
      }
    }

    if (activeTab === 'tab-tracker') {
      if (trackerSpecMode === 'sky') {
        requestAnimationFrame(drawSkyMap);
      } else {
        requestAnimationFrame(drawSpectrometer);
      }
      requestAnimationFrame(drawMultiWaterfalls);
    }
  }

  // 4. Sky Grid Camera Telemetry (Engine 2)
  function handleGridUpdate(frame) {
    if (!frame) return;
    latestGrid = frame;

    // Push 16-beam spectrum ring buffer (decoupled from DOM visibility)
    if (frame.beam_power_spectra) {
      pushGridSpectra(frame.beam_power_spectra);
    }

    // Telemetry readouts
    if (gridCentroidReadout) {
      const cl = (frame.centroid_l !== undefined) ? frame.centroid_l.toFixed(4) : '0.0000';
      const cm = (frame.centroid_m !== undefined) ? frame.centroid_m.toFixed(4) : '0.0000';
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
      const totalDb = (10 * Math.log10(Math.max(1e-12, sumLin))).toFixed(1);
      gridTotalFlux.textContent = `${totalDb} dB`;
    }

    renderGridTable(frame);

    if (activeTab === 'tab-grid') {
      if (gridViewMode === 'camera') {
        requestAnimationFrame(drawGridHeatmap);
      } else {
        requestAnimationFrame(renderGridWaterfalls);
      }
    }
  }

  // 5. Correlator Telemetry (Engine 3)
  function handleCorrelatorUpdate(corr) {
    if (!corr) return;
    latestCorrelator = corr;

    if (activeTab === 'tab-correlator') {
      if (corrViewMode === 'split') {
        requestAnimationFrame(drawSplitCorrelatorMatrix);
      } else {
        requestAnimationFrame(drawCorrelatorMatrices);
      }
      requestAnimationFrame(drawBandpassSpectrum);
      requestAnimationFrame(drawFringePlot);
    } else if (activeTab === 'tab-array') {
      requestAnimationFrame(drawMasterAntennaSpectrometer);
      if (antViewMode === 'canvas' && latestAntennaMask && latestAntennaMask.antennas) {
        requestAnimationFrame(() => renderAntennaMaskGrid(antennaMaskCanvas, latestAntennaMask.antennas));
      } else {
        requestAnimationFrame(renderArrayGrid);
      }
    }
  }

  // 6. Antenna Health & Mask Telemetry (Engine 0)
  function handleAntennaMaskUpdate(maskStatus) {
    if (!maskStatus) return;
    latestAntennaMask = maskStatus;

    if (rfActiveBadge) {
      rfActiveBadge.textContent = `${maskStatus.active_antennas} / ${maskStatus.num_antennas || 64}`;
    }
    if (rfMaskedBadge) {
      rfMaskedBadge.textContent = `${maskStatus.masked_antennas} / ${maskStatus.num_antennas || 64}`;
    }
    if (rfAutodetectBadge) {
      const enabled = !!maskStatus.auto_detect_enabled;
      rfAutodetectBadge.textContent = enabled ? 'ENABLED' : 'DISABLED';
      rfAutodetectBadge.className = `metric-val monospace ${enabled ? 'success' : 'warning'}`;
    }
    if (btnToggleAutodetect) {
      const enabled = !!maskStatus.auto_detect_enabled;
      btnToggleAutodetect.textContent = enabled ? 'Disable Auto-Detect' : 'Enable Auto-Detect';
      if (enabled) {
        btnToggleAutodetect.classList.remove('btn-autodetect-off');
      } else {
        btnToggleAutodetect.classList.add('btn-autodetect-off');
      }
    }
    if (rfBlankingBadge) {
      rfBlankingBadge.textContent = maskStatus.blank_voltages_enabled ? 'RTX 5090 IN-PLACE' : 'OFF';
    }

    if (activeTab === 'tab-array') {
      requestAnimationFrame(drawMasterAntennaSpectrometer);
      if (antViewMode === 'canvas' && maskStatus.antennas) {
        requestAnimationFrame(() => renderAntennaMaskGrid(antennaMaskCanvas, maskStatus.antennas));
      } else {
        requestAnimationFrame(renderArrayGrid);
      }
    }
  }

  // ==========================================================================
  // TAB 1: Astrometric Tracker Logic & Canvas Renderers
  // ==========================================================================

  function updateBeamSelects(beams) {
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

      // Alt/Az calculation from (l, m)
      const r = Math.sqrt(b.l0 * b.l0 + b.m0 * b.m0);
      const altDeg = (90.0 - Math.asin(Math.min(1.0, r)) * 180.0 / Math.PI).toFixed(1);
      const azDeg = ((Math.atan2(b.l0, b.m0) * 180.0 / Math.PI + 360.0) % 360.0).toFixed(1);

      // Seam / Phase Rate
      let seamRateStr = 'Δφ: +0.00 rad/s';
      if (b.dl !== undefined || b.dm !== undefined) {
        const rate = (Math.sqrt((b.dl || 0) ** 2 + (b.dm || 0) ** 2) * 50);
        const sign = (b.dl || 0) >= 0 ? '+' : '-';
        seamRateStr = `Δφ: ${sign}${rate.toFixed(2)} rad/s`;
      } else if (currentStatus && currentStatus.subframe_interpolation_enabled) {
        seamRateStr = 'Δφ: +0.04 rad/s';
      }

      // Peak dB from latest spectrometer if available
      let peakDb = '--';
      if (latestSpectrometer && latestSpectrometer.beams && latestSpectrometer.beams[b.beam_id]) {
        const spec = latestSpectrometer.beams[b.beam_id];
        if (spec.stats && spec.stats.max !== undefined) {
          peakDb = `${spec.stats.max.toFixed(1)} dB`;
        }
      }

      tr.innerHTML = `
        <td style="color: ${color}; font-weight: 700;">● #${b.beam_id}</td>
        <td>${name ? `<strong>${name}</strong>` : '<span class="status-label">Manual</span>'}</td>
        <td>${targetStr}</td>
        <td>${azDeg}° / ${altDeg}°</td>
        <td>(${b.l0 >= 0 ? '+' : ''}${b.l0.toFixed(4)}, ${b.m0 >= 0 ? '+' : ''}${b.m0.toFixed(4)})</td>
        <td><span class="monospace">${seamRateStr}</span></td>
        <td><span class="monospace highlight">${peakDb}</span></td>
        <td><span class="badge badge-xs badge-success">[TRACK]</span></td>
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
    if (waterfallBeamSelect) waterfallBeamSelect.value = beamId;
    waterfallBeamId = beamId;

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
      if (res.ok) {
        beamTrails[beamId] = await res.json();
      }
    } catch (e) {
      // Trail error ignored
    }

    renderBeamTable(currentStatus ? currentStatus.beams : []);
    requestAnimationFrame(drawSkyMap);
  }

  // --- Canvas: Topocentric Sky Map ---
  function drawSkyMap() {
    if (!skyCanvas || !skyCtx) return;
    const w = skyCanvas.width;
    const h = skyCanvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = (w / 2) - 34;

    skyCtx.clearRect(0, 0, w, h);

    // Outer Horizon Circle (r = 1.0)
    skyCtx.strokeStyle = '#22324e';
    skyCtx.lineWidth = 2;
    skyCtx.beginPath();
    skyCtx.arc(cx, cy, r, 0, Math.PI * 2);
    skyCtx.stroke();

    // 30° zenith angle circle (r * 0.5)
    skyCtx.strokeStyle = '#152034';
    skyCtx.lineWidth = 1;
    skyCtx.setLineDash([4, 4]);
    skyCtx.beginPath();
    skyCtx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    skyCtx.stroke();

    // 60° zenith angle circle (r * sin(60°))
    skyCtx.beginPath();
    skyCtx.arc(cx, cy, r * Math.sin(Math.PI / 3), 0, Math.PI * 2);
    skyCtx.stroke();
    skyCtx.setLineDash([]);

    // Cross axes
    skyCtx.strokeStyle = '#18243a';
    skyCtx.beginPath();
    skyCtx.moveTo(cx - r, cy);
    skyCtx.lineTo(cx + r, cy);
    skyCtx.moveTo(cx, cy - r);
    skyCtx.lineTo(cx, cy + r);
    skyCtx.stroke();

    // Cardinal Labels
    skyCtx.fillStyle = '#8fa5c2';
    skyCtx.font = '11px ui-monospace, monospace';
    skyCtx.textAlign = 'center';
    skyCtx.textBaseline = 'middle';
    skyCtx.fillText('N (+m)', cx, cy - r - 16);
    skyCtx.fillText('S (-m)', cx, cy + r + 16);
    skyCtx.fillText('E (+l)', cx + r + 20, cy);
    skyCtx.fillText('W (-l)', cx - r - 20, cy);
    skyCtx.fillText('30°', cx + r * 0.5, cy - 8);
    skyCtx.fillText('60°', cx + r * Math.sin(Math.PI / 3), cy - 8);

    // Center Zenith dot
    skyCtx.fillStyle = '#3b82f6';
    skyCtx.beginPath();
    skyCtx.arc(cx, cy, 3, 0, Math.PI * 2);
    skyCtx.fill();

    // Selected beam trail
    const trail = beamTrails[selectedBeamId];
    if (trail && trail.length > 1) {
      skyCtx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
      skyCtx.lineWidth = 1.8;
      skyCtx.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const pt = trail[i];
        const tx = cx + pt.l0 * r;
        const ty = cy - pt.m0 * r;
        if (i === 0) skyCtx.moveTo(tx, ty);
        else skyCtx.lineTo(tx, ty);
      }
      skyCtx.stroke();
    }

    // Active Beams
    if (currentStatus && currentStatus.beams) {
      currentStatus.beams.forEach(b => {
        const bx = cx + b.l0 * r;
        const by = cy - b.m0 * r;
        const color = BEAM_COLORS[b.beam_id % BEAM_COLORS.length];
        const isSelected = b.beam_id === selectedBeamId;

        // Selection ring
        if (isSelected) {
          skyCtx.strokeStyle = '#ffffff';
          skyCtx.lineWidth = 2;
          skyCtx.beginPath();
          skyCtx.arc(bx, by, 10, 0, Math.PI * 2);
          skyCtx.stroke();
        }

        // Beam dot
        skyCtx.fillStyle = color;
        skyCtx.beginPath();
        skyCtx.arc(bx, by, 5.5, 0, Math.PI * 2);
        skyCtx.fill();

        // Label
        skyCtx.fillStyle = '#ffffff';
        skyCtx.font = 'bold 11px ui-monospace, monospace';
        skyCtx.textAlign = 'left';
        skyCtx.fillText(`B${b.beam_id}`, bx + 9, by - 6);

        const name = beamName(b.beam_id);
        if (name) {
          skyCtx.fillStyle = '#94a3b8';
          skyCtx.font = '10px ui-monospace, monospace';
          skyCtx.fillText(name, bx + 9, by + 10);
        }
      });
    }
  }

  // --- Canvas: 4-Beam 672-Channel Spectrum ---
  function updateSpectrometerViewSelect(beams) {
    if (!specViewSelect) return;
    const currentVal = specViewSelect.value;
    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a) - parseInt(b));
    const expected = ['all', ...beamIds];
    const existing = Array.from(specViewSelect.options).map(o => o.value);

    if (existing.length !== expected.length || !expected.every((val, i) => existing[i] === val)) {
      specViewSelect.innerHTML = '';
      const allOpt = document.createElement('option');
      allOpt.value = 'all';
      allOpt.textContent = 'Overlay All Beams';
      specViewSelect.appendChild(allOpt);

      beamIds.forEach(id => {
        const b = beams[id];
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = b.label || `Beam ${id}`;
        specViewSelect.appendChild(opt);
      });

      if (expected.includes(currentVal)) {
        specViewSelect.value = currentVal;
      }
    }
  }

  function renderSpectrometerFooter(beams) {
    if (!specLegend || !specStats) return;
    specLegend.innerHTML = '';
    specStats.innerHTML = '';

    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a) - parseInt(b));
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
          `<span>Beam ${id}: Max <strong>${b.stats.max.toFixed(1)} dB</strong> | Mean <strong>${b.stats.mean.toFixed(1)} dB</strong> | Peak <strong>${b.stats.peak_freq_mhz.toFixed(1)} MHz</strong></span>`
        );
      }
    });

    specStats.innerHTML = statsTexts.join('');
  }

  function drawSpectrometer() {
    if (!specCanvas || !specCtx) return;
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
      ctx.fillText('Awaiting 672-channel line spectrum telemetry (4 Hz)...', width / 2, height / 2);
      return;
    }

    const beams = latestSpectrometer.beams;
    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a) - parseInt(b));
    if (beamIds.length === 0) return;

    const activeIds = (specViewMode === 'all')
      ? beamIds
      : (beams[specViewMode] ? [specViewMode] : beamIds);

    const padL = 46;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    const fMin = 300.0;
    const fMax = 501.3;
    const dbMin = -45.0;
    const dbMax = 10.0;

    // Small-Multiples Sparklines Mode
    if (trackerSpecMode === 'small-mult') {
      const nPlots = Math.max(1, activeIds.length);
      const subH = plotH / nPlots;

      activeIds.forEach((id, plotIdx) => {
        const b = beams[id];
        if (!b.power_db || b.power_db.length === 0) return;
        const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];
        const subTop = padT + plotIdx * subH;
        const numChannels = b.power_db.length;

        // Label
        ctx.fillStyle = color;
        ctx.font = '600 10px ui-monospace, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'top';
        ctx.fillText(`Beam #${id} (${beamName(id) || 'Manual'})`, padL + 4, subTop + 3);

        // Subplot separator line
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.strokeRect(padL, subTop, plotW, subH);

        // Spectrum line
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        for (let ch = 0; ch < numChannels; ch++) {
          const x = padL + (ch / (numChannels - 1)) * plotW;
          const db = Math.max(dbMin, Math.min(dbMax, b.power_db[ch]));
          const y = subTop + (1.0 - (db - dbMin) / (dbMax - dbMin)) * subH;
          if (ch === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.stroke();
      });

      // Frequency ticks at bottom
      ctx.fillStyle = '#5a7192';
      ctx.font = '9px ui-monospace, monospace';
      ctx.textAlign = 'center';
      const fSteps = [300, 350, 400, 450, 500];
      fSteps.forEach(freq => {
        const x = padL + ((freq - fMin) / (fMax - fMin)) * plotW;
        ctx.fillText(`${freq} MHz`, x, padT + plotH + 4);
      });
      return;
    }

    // Grid lines & dB ticks (Overlay mode)
    ctx.strokeStyle = '#121d33';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#5a7192';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const dbSteps = [-40, -30, -20, -10, 0, 10];
    dbSteps.forEach(db => {
      const y = padT + (1.0 - (db - dbMin) / (dbMax - dbMin)) * plotH;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(padL + plotW, y);
      ctx.stroke();
      ctx.fillText(`${db}`, padL - 6, y);
    });

    // Frequency grid ticks
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const fSteps = [300, 350, 400, 450, 500];
    fSteps.forEach(freq => {
      const x = padL + ((freq - fMin) / (fMax - fMin)) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(`${freq} MHz`, x, padT + plotH + 6);
    });

    // Subband boundary marker at 400.65 MHz
    const subbandX = padL + ((400.65 - fMin) / (fMax - fMin)) * plotW;
    ctx.strokeStyle = '#00e5ff';
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(subbandX, padT);
    ctx.lineTo(subbandX, padT + plotH);
    ctx.stroke();
    ctx.setLineDash([]);

    // Draw spectrum lines
    activeIds.forEach(id => {
      const b = beams[id];
      if (!b.power_db || b.power_db.length === 0) return;

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

    // Hover crosshair inspection
    if (specHover.active && specHover.x >= padL && specHover.x <= padL + plotW) {
      const normX = (specHover.x - padL) / plotW;
      const chIdx = Math.min(671, Math.max(0, Math.round(normX * 671)));
      const freqMhz = 300.0 + chIdx * 0.3;

      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(specHover.x, padT);
      ctx.lineTo(specHover.x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);

      let readout = `Ch ${chIdx} | ${freqMhz.toFixed(2)} MHz`;
      activeIds.forEach(id => {
        const b = beams[id];
        if (b.power_db && b.power_db[chIdx] !== undefined) {
          readout += ` | Beam ${id}: ${b.power_db[chIdx].toFixed(1)} dB`;
        }
      });
      if (specCursorReadout) specCursorReadout.textContent = readout;
    }
  }

  // --- Canvas: Historical Waterfall ---
  function drawWaterfall() {
    if (!waterfallCanvas) return;
    const setup = resizeHiDPICanvas(waterfallCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, width, height);

    if (waterfallHistory.length === 0) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`Waterfall accumulating historical frames for Beam ${waterfallBeamId}...`, width / 2, height / 2);
      return;
    }

    const numRows = waterfallHistory.length;
    const numChannels = 672;
    const rowH = height / MAX_WATERFALL_ROWS;
    const colW = width / numChannels;

    const dbMin = -45.0;
    const dbMax = 15.0;

    for (let r = 0; r < numRows; r++) {
      const powers = waterfallHistory[r].power;
      const y = r * rowH;

      for (let c = 0; c < numChannels; c++) {
        const db = powers[c];
        const norm = (db - dbMin) / (dbMax - dbMin);
        const rgb = viridisColor(norm);

        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(c * colW, y, Math.ceil(colW) + 0.5, Math.ceil(rowH) + 0.5);
      }
    }
  }

  function renderWaterfallCanvas(canvas, history) {
    if (!canvas) return;
    const setup = resizeHiDPICanvas(canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#04070d';
    ctx.fillRect(0, 0, width, height);

    if (!history || history.length === 0) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '10px ui-monospace, monospace';
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
      for (let c = 0; c < numChannels; c++) {
        const norm = (powers[c] - dbMin) / (dbMax - dbMin);
        const rgb = viridisColor(norm);
        ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        ctx.fillRect(c * colW, y, Math.ceil(colW) + 0.5, Math.ceil(rowH) + 0.5);
      }
    }
  }

  function drawMultiWaterfalls() {
    if (!multiWaterfallStack) return;
    if (!latestSpectrometer || !latestSpectrometer.beams) {
      drawWaterfall();
      return;
    }
    const beamIds = Object.keys(latestSpectrometer.beams).sort((a, b) => parseInt(a) - parseInt(b));
    if (beamIds.length <= 1) {
      drawWaterfall();
      const wfMainLabel = document.getElementById('wf-main-label');
      const wfMainPeak = document.getElementById('wf-main-peak');
      const targetId = waterfallBeamId !== undefined ? waterfallBeamId : (beamIds[0] || 0);
      const bObj = latestSpectrometer.beams[targetId];
      const bName = beamName(targetId);
      if (wfMainLabel) wfMainLabel.textContent = `Tracker #${targetId}${bName ? ' (' + bName + ')' : ''}`;
      if (wfMainPeak && bObj && bObj.stats && bObj.stats.max !== undefined) {
        wfMainPeak.textContent = `${bObj.stats.max.toFixed(1)} dB`;
      }
      return;
    }

    // Hide placeholder main when multiple strips exist
    const mainStrip = document.getElementById('waterfall-strip-main');
    if (mainStrip) mainStrip.classList.add('hidden');

    beamIds.forEach(id => {
      let strip = document.getElementById(`wf-strip-beam-${id}`);
      if (!strip) {
        strip = document.createElement('div');
        strip.className = 'waterfall-strip';
        strip.id = `wf-strip-beam-${id}`;
        strip.innerHTML = `
          <div class="waterfall-strip-header">
            <span class="wf-strip-label" id="wf-label-${id}">Tracker #${id}</span>
            <span class="wf-strip-metric monospace" id="wf-peak-${id}">-- dB</span>
          </div>
          <div class="canvas-wrap waterfall-canvas-wrap">
            <canvas id="wf-canvas-${id}" width="600" height="90"></canvas>
          </div>
        `;
        multiWaterfallStack.appendChild(strip);
      }

      const bName = beamName(id);
      const bObj = latestSpectrometer.beams[id];
      const lbl = strip.querySelector(`#wf-label-${id}`);
      const pk = strip.querySelector(`#wf-peak-${id}`);
      if (lbl) lbl.textContent = `Tracker #${id}${bName ? ' (' + bName + ')' : ''}`;
      if (pk && bObj && bObj.stats && bObj.stats.max !== undefined) {
        pk.textContent = `${bObj.stats.max.toFixed(1)} dB`;
      }

      const c = strip.querySelector(`#wf-canvas-${id}`);
      if (c) {
        renderWaterfallCanvas(c, waterfallHistoriesByBeam[id] || []);
      }
    });
  }

  // ==========================================================================
  // TAB 2: 16-Beam 2D Sky Grid Camera Logic & Renderers (F4.3)
  // ==========================================================================

  function pushGridSpectra(gridSpectra16xF) {
    if (!gridSpectra16xF) return;
    for (let b = 0; b < GRID_BEAMS; b++) {
      const spec = gridSpectra16xF[b];
      if (!spec || spec.length === 0) continue;
      const { canvas, ctx, rowImage } = gridOffscreen[b];

      // Shift existing waterfall down by 1px
      ctx.drawImage(canvas, 0, 0, FREQ_BINS, HISTORY_LEN - 1, 0, 1, FREQ_BINS, HISTORY_LEN - 1);

      // Write newest frequency slice at y = 0
      const data = rowImage.data;
      const specLen = spec.length;
      for (let f = 0; f < FREQ_BINS; f++) {
        const srcIdx = Math.floor(f * specLen / FREQ_BINS);
        const val = spec[srcIdx] !== undefined ? spec[srcIdx] : -40.0;
        const norm = Math.max(0, Math.min(1, (val - (-40.0)) / 50.0));
        const [r, g, bl] = viridisColor(norm);
        const p = f * 4;
        data[p] = r;
        data[p + 1] = g;
        data[p + 2] = bl;
        data[p + 3] = 255;
      }
      ctx.putImageData(rowImage, 0, 0);
    }
  }

  function renderGridWaterfalls() {
    if (!gridWaterfallsMatrix) return;

    if (gridWaterfallsMatrix.children.length !== GRID_BEAMS) {
      gridWaterfallsMatrix.innerHTML = '';
      for (let b = 0; b < GRID_BEAMS; b++) {
        const cell = document.createElement('div');
        cell.className = 'grid-wf-cell';
        cell.id = `grid-wf-cell-${b}`;
        const row = Math.floor(b / 4);
        const col = b % 4;
        cell.innerHTML = `
          <div class="grid-wf-cell-header">
            <span>Beam ${b} (R${row}C${col})</span>
            <span class="monospace" id="grid-wf-db-${b}">-- dB</span>
          </div>
          <div class="grid-wf-canvas-wrap">
            <canvas class="grid-wf-canvas" id="grid-wf-canvas-${b}" width="168" height="70"></canvas>
          </div>
        `;
        gridWaterfallsMatrix.appendChild(cell);
      }
    }

    for (let b = 0; b < GRID_BEAMS; b++) {
      const c = document.getElementById(`grid-wf-canvas-${b}`);
      if (c) {
        const setup = resizeHiDPICanvas(c);
        if (setup) {
          const { ctx, width, height } = setup;
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(gridOffscreen[b].canvas, 0, 0, width, height);
        }
      }

      const dbEl = document.getElementById(`grid-wf-db-${b}`);
      if (dbEl && latestGrid && latestGrid.beam_powers && latestGrid.beam_powers[b] !== undefined) {
        dbEl.textContent = `${latestGrid.beam_powers[b].toFixed(1)} dB`;
      }
    }
  }

  function getSlicedBeamPowers(frame) {
    if (!frame || !frame.beam_power_spectra || frame.beam_power_spectra.length !== 16) {
      return frame ? (frame.beam_powers || []) : [];
    }

    if (gridSliceMode === 'full') {
      return frame.beam_powers || [];
    }

    const chStart = gridSliceMode === 'sub0' ? 0 : 336;
    const chEnd = gridSliceMode === 'sub0' ? 336 : 672;
    const powers = [];

    for (let b = 0; b < 16; b++) {
      const spec = frame.beam_power_spectra[b];
      let sumLin = 0;
      for (let ch = chStart; ch < chEnd; ch++) {
        sumLin += Math.pow(10, spec[ch] / 10.0);
      }
      const meanLin = sumLin / (chEnd - chStart);
      powers.push(10.0 * Math.log10(Math.max(1e-12, meanLin)));
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

    let minDb = 100;
    let maxDb = -100;
    powers.forEach(p => {
      if (p < minDb) minDb = p;
      if (p > maxDb) maxDb = p;
    });

    gridBeamTbody.innerHTML = '';
    const peakId = powers.indexOf(maxDb);

    for (let b = 0; b < 16; b++) {
      const row = Math.floor(b / 4);
      const col = b % 4;
      const l = (-0.03 + col * 0.02).toFixed(4);
      const m = (-0.03 + row * 0.02).toFixed(4);
      const db = powers[b].toFixed(1);

      const relPct = Math.max(0, Math.min(100, ((powers[b] - minDb) / (maxDb - minDb + 1e-6)) * 100)).toFixed(0);
      const isPeak = (b === peakId);

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
    if (!gridCanvas) return;
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

    let minDb = 100;
    let maxDb = -100;
    powers.forEach(p => {
      if (p < minDb) minDb = p;
      if (p > maxDb) maxDb = p;
    });

    if (gridCbMin) gridCbMin.textContent = `${minDb.toFixed(1)} dB`;
    if (gridCbMax) gridCbMax.textContent = `${maxDb.toFixed(1)} dB`;

    const pad = 40;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;

    if (gridDisplayMode === 'cells') {
      // Crisp 4x4 Cells
      const cellW = plotW / 4;
      const cellH = plotH / 4;

      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const bIdx = r * 4 + c;
          const p = powers[bIdx];
          const norm = (p - minDb) / (maxDb - minDb + 1e-6);
          const rgb = infernoColor(norm);

          const x = pad + c * cellW;
          const y = pad + (3 - r) * cellH; // flip row so m increases upward

          gridCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          gridCtx.fillRect(x, y, cellW - 2, cellH - 2);

          // Cell label
          gridCtx.fillStyle = norm > 0.6 ? '#000000' : '#ffffff';
          gridCtx.font = 'bold 11px ui-monospace, monospace';
          gridCtx.textAlign = 'center';
          gridCtx.textBaseline = 'middle';
          gridCtx.fillText(`B${bIdx}`, x + cellW / 2, y + cellH / 2 - 8);
          gridCtx.font = '10px ui-monospace, monospace';
          gridCtx.fillText(`${p.toFixed(1)} dB`, x + cellW / 2, y + cellH / 2 + 8);
        }
      }
    } else {
      // Smooth Contour Heatmap using Bilinear Interpolation
      const res = 160;
      const imgData = gridCtx.createImageData(res, res);
      const data = imgData.data;

      // Map 4x4 array (r, c)
      const grid4x4 = [];
      for (let r = 0; r < 4; r++) {
        grid4x4[r] = [];
        for (let c = 0; c < 4; c++) {
          grid4x4[r][c] = powers[r * 4 + c];
        }
      }

      for (let py = 0; py < res; py++) {
        const fy = (res - 1 - py) / (res - 1) * 3; // 0 to 3
        const r0 = Math.floor(fy);
        const r1 = Math.min(3, r0 + 1);
        const ty = fy - r0;

        for (let px = 0; px < res; px++) {
          const fx = px / (res - 1) * 3; // 0 to 3
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

      // Draw interpolated bitmap onto canvas
      const offscreen = document.createElement('canvas');
      offscreen.width = res;
      offscreen.height = res;
      offscreen.getContext('2d').putImageData(imgData, 0, 0);

      gridCtx.imageSmoothingEnabled = true;
      gridCtx.drawImage(offscreen, pad, pad, plotW, plotH);

      // Overlay Beam Center Marks
      for (let r = 0; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
          const bIdx = r * 4 + c;
          const bx = pad + (c / 3) * plotW;
          const by = pad + ((3 - r) / 3) * plotH;

          gridCtx.fillStyle = 'rgba(255, 255, 255, 0.4)';
          gridCtx.beginPath();
          gridCtx.arc(bx, by, 3, 0, Math.PI * 2);
          gridCtx.fill();

          gridCtx.fillStyle = '#ffffff';
          gridCtx.font = '10px ui-monospace, monospace';
          gridCtx.textAlign = 'center';
          gridCtx.fillText(`B${bIdx}`, bx, by - 6);
        }
      }
    }

    // Grid Outer Box & Coordinate Labels
    gridCtx.strokeStyle = '#22324e';
    gridCtx.lineWidth = 1.5;
    gridCtx.strokeRect(pad, pad, plotW, plotH);

    gridCtx.fillStyle = '#8fa5c2';
    gridCtx.font = '10px ui-monospace, monospace';
    gridCtx.textAlign = 'center';
    gridCtx.textBaseline = 'top';
    const lLabels = [-0.03, -0.01, 0.01, 0.03];
    lLabels.forEach((l, i) => {
      const x = pad + (i / 3) * plotW;
      gridCtx.fillText(`l=${l.toFixed(2)}`, x, pad + plotH + 8);
    });

    gridCtx.textAlign = 'right';
    gridCtx.textBaseline = 'middle';
    lLabels.forEach((m, i) => {
      const y = pad + ((3 - i) / 3) * plotH;
      gridCtx.fillText(`m=${m.toFixed(2)}`, pad - 6, y);
    });

    // Peak Beam Gold Halo
    const peakId = powers.indexOf(maxDb);
    const pRow = Math.floor(peakId / 4);
    const pCol = peakId % 4;
    const px = pad + (pCol / 3) * plotW;
    const py = pad + ((3 - pRow) / 3) * plotH;

    gridCtx.strokeStyle = '#fbbf24';
    gridCtx.lineWidth = 2.5;
    gridCtx.beginPath();
    gridCtx.arc(px, py, 16, 0, Math.PI * 2);
    gridCtx.stroke();

    // Transient Centroid Marker (Crosshair & Glow Ring)
    let centL = latestGrid.centroid_l !== undefined ? latestGrid.centroid_l : 0.0;
    let centM = latestGrid.centroid_m !== undefined ? latestGrid.centroid_m : 0.0;

    // Recalculate centroid dynamically if sliced
    if (gridSliceMode !== 'full') {
      let sumWeight = 0;
      let sumL = 0;
      let sumM = 0;
      for (let b = 0; b < 16; b++) {
        const lin = Math.pow(10, powers[b] / 10.0);
        const l = -0.03 + (b % 4) * 0.02;
        const m = -0.03 + Math.floor(b / 4) * 0.02;
        sumWeight += lin;
        sumL += lin * l;
        sumM += lin * m;
      }
      if (sumWeight > 0) {
        centL = sumL / sumWeight;
        centM = sumM / sumWeight;
      }
    }

    const normCentL = Math.max(0, Math.min(1, (centL - (-0.03)) / 0.06));
    const normCentM = Math.max(0, Math.min(1, (centM - (-0.03)) / 0.06));
    const cx = pad + normCentL * plotW;
    const cy = pad + (1 - normCentM) * plotH;

    gridCtx.strokeStyle = '#00e5ff';
    gridCtx.lineWidth = 2;
    gridCtx.beginPath();
    gridCtx.arc(cx, cy, 10, 0, Math.PI * 2);
    gridCtx.stroke();

    gridCtx.beginPath();
    gridCtx.moveTo(cx - 15, cy);
    gridCtx.lineTo(cx + 15, cy);
    gridCtx.moveTo(cx, cy - 15);
    gridCtx.lineTo(cx, cy + 15);
    gridCtx.stroke();
  }

  // ==========================================================================
  // TAB 3: Astron WMMA Correlator Logic & Renderers (F4.4)
  // ==========================================================================

  function drawCorrelatorMatrices() {
    if (!latestCorrelator) return;
    drawSplitCorrelatorMatrix();
    drawAmplitudeMatrix();
    drawPhaseMatrix();
  }

  function drawSplitCorrelatorMatrix() {
    if (!corrSplitCanvas || !latestCorrelator) return;
    const setup = resizeHiDPICanvas(corrSplitCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#03060d';
    ctx.fillRect(0, 0, width, height);

    const cohMatrix = latestCorrelator.coherence_matrix || latestCorrelator.amplitude_matrix;
    const phaseMatrix = latestCorrelator.phase_matrix;
    if (!cohMatrix || !phaseMatrix) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '11px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting 64x64 coherence & phase telemetry...', width / 2, height / 2);
      return;
    }

    const pad = 28;
    const plotW = width - pad * 2;
    const plotH = height - pad * 2;
    const cellW = plotW / 64;
    const cellH = plotH / 64;

    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        const x = pad + j * cellW;
        const y = pad + i * cellH;

        if (i === j) {
          // Diagonal: Auto-correlation / zeroed baseline
          ctx.fillStyle = '#111927';
          ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
        } else if (i < j) {
          // Upper Triangle: Coherence |Γij| in [0, 1] -> Viridis
          const coh = Math.max(0, Math.min(1, cohMatrix[i][j]));
          const rgb = viridisColor(coh);
          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
        } else {
          // Lower Triangle: Fringe Phase φij in [-pi, pi] -> Cyclic Colormap
          const rad = phaseMatrix[i][j];
          const rgb = cyclicPhaseColor(rad);
          ctx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
          ctx.fillRect(x, y, cellW + 0.5, cellH + 0.5);
        }
      }
    }

    // Crisp diagonal dividing line
    ctx.strokeStyle = '#00e5ff';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(pad, pad);
    ctx.lineTo(pad + plotW, pad + plotH);
    ctx.stroke();

    // Highlight selected baseline cell
    if (baselineAntA >= 0 && baselineAntB >= 0) {
      const minAnt = Math.min(baselineAntA, baselineAntB);
      const maxAnt = Math.max(baselineAntA, baselineAntB);

      // Upper cell (minAnt, maxAnt)
      const uX = pad + maxAnt * cellW;
      const uY = pad + minAnt * cellH;
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 2;
      ctx.strokeRect(uX - 0.5, uY - 0.5, cellW + 1, cellH + 1);

      // Lower cell (maxAnt, minAnt)
      const lX = pad + minAnt * cellW;
      const lY = pad + maxAnt * cellH;
      ctx.strokeRect(lX - 0.5, lY - 0.5, cellW + 1, cellH + 1);
    }

    // Outer border & Ticks
    ctx.strokeStyle = '#22324e';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, pad, plotW, plotH);

    ctx.fillStyle = '#8fa5c2';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const ticks = [0, 8, 16, 24, 32, 40, 48, 56, 63];
    ticks.forEach(t => {
      const tx = pad + (t / 63) * plotW;
      ctx.fillText(`${t}`, tx, pad + plotH + 12);
    });

    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ticks.forEach(t => {
      const ty = pad + (t / 63) * plotH;
      ctx.fillText(`${t}`, pad - 6, ty);
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
          baselineInspectorTitle.textContent = `Baseline Inspector: Baseline (${antA}, ${antB}) across 672 Channels`;
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
    if (!corrAmpCanvas || !corrAmpCtx || !latestCorrelator) return;
    const w = corrAmpCanvas.width;
    const h = corrAmpCanvas.height;

    corrAmpCtx.fillStyle = '#060a14';
    corrAmpCtx.fillRect(0, 0, w, h);

    const matrix = latestCorrelator.amplitude_matrix;
    if (!matrix || matrix.length !== 64) {
      corrAmpCtx.fillStyle = '#5a7192';
      corrAmpCtx.font = '11px ui-monospace, monospace';
      corrAmpCtx.textAlign = 'center';
      corrAmpCtx.fillText('Loading 64x64 amplitude matrix...', w / 2, h / 2);
      return;
    }

    const pad = 30;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;

    // Find max amp
    let maxAmp = 0.001;
    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        if (matrix[i][j] > maxAmp) maxAmp = matrix[i][j];
      }
    }
    if (corrAmpCbMax) corrAmpCbMax.textContent = maxAmp.toFixed(1);

    const cellW = plotW / 64;
    const cellH = plotH / 64;

    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        const norm = matrix[i][j] / maxAmp;
        const rgb = turboColor(norm);

        corrAmpCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        corrAmpCtx.fillRect(pad + j * cellW, pad + i * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    // Axes Ticks: 0, 8, 16, 24, 32, 40, 48, 56, 63
    corrAmpCtx.strokeStyle = '#22324e';
    corrAmpCtx.strokeRect(pad, pad, plotW, plotH);

    corrAmpCtx.fillStyle = '#8fa5c2';
    corrAmpCtx.font = '9px ui-monospace, monospace';
    const ticks = [0, 8, 16, 24, 32, 40, 48, 56, 63];

    corrAmpCtx.textAlign = 'center';
    ticks.forEach(t => {
      const x = pad + (t / 63) * plotW;
      corrAmpCtx.fillText(`${t}`, x, pad + plotH + 10);
    });

    corrAmpCtx.textAlign = 'right';
    corrAmpCtx.textBaseline = 'middle';
    ticks.forEach(t => {
      const y = pad + (t / 63) * plotH;
      corrAmpCtx.fillText(`${t}`, pad - 4, y);
    });
  }

  function drawPhaseMatrix() {
    if (!corrPhaseCanvas || !corrPhaseCtx || !latestCorrelator) return;
    const w = corrPhaseCanvas.width;
    const h = corrPhaseCanvas.height;

    corrPhaseCtx.fillStyle = '#060a14';
    corrPhaseCtx.fillRect(0, 0, w, h);

    const matrix = latestCorrelator.phase_matrix;
    if (!matrix || matrix.length !== 64) {
      corrPhaseCtx.fillStyle = '#5a7192';
      corrPhaseCtx.font = '11px ui-monospace, monospace';
      corrPhaseCtx.textAlign = 'center';
      corrPhaseCtx.fillText('Loading 64x64 phase matrix...', w / 2, h / 2);
      return;
    }

    const pad = 30;
    const plotW = w - pad * 2;
    const plotH = h - pad * 2;
    const cellW = plotW / 64;
    const cellH = plotH / 64;

    for (let i = 0; i < 64; i++) {
      for (let j = 0; j < 64; j++) {
        const rad = matrix[i][j];
        const rgb = cyclicPhaseColor(rad);

        corrPhaseCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        corrPhaseCtx.fillRect(pad + j * cellW, pad + i * cellH, cellW + 0.5, cellH + 0.5);
      }
    }

    corrPhaseCtx.strokeStyle = '#22324e';
    corrPhaseCtx.strokeRect(pad, pad, plotW, plotH);

    corrPhaseCtx.fillStyle = '#8fa5c2';
    corrPhaseCtx.font = '9px ui-monospace, monospace';
    const ticks = [0, 8, 16, 24, 32, 40, 48, 56, 63];

    corrPhaseCtx.textAlign = 'center';
    ticks.forEach(t => {
      const x = pad + (t / 63) * plotW;
      corrPhaseCtx.fillText(`${t}`, x, pad + plotH + 10);
    });

    corrPhaseCtx.textAlign = 'right';
    corrPhaseCtx.textBaseline = 'middle';
    ticks.forEach(t => {
      const y = pad + (t / 63) * plotH;
      corrPhaseCtx.fillText(`${t}`, pad - 4, y);
    });
  }

  function drawBandpassSpectrum() {
    if (!corrBandpassCanvas || !corrBandpassCtx || !latestCorrelator) return;
    const w = corrBandpassCanvas.width;
    const h = corrBandpassCanvas.height;

    corrBandpassCtx.fillStyle = '#05080f';
    corrBandpassCtx.fillRect(0, 0, w, h);

    const bp = latestCorrelator.bandpass_db;
    if (!bp || bp.length !== 672) {
      corrBandpassCtx.fillStyle = '#5a7192';
      corrBandpassCtx.font = '11px ui-monospace, monospace';
      corrBandpassCtx.textAlign = 'center';
      corrBandpassCtx.fillText('Loading 672-ch bandpass spectrum...', w / 2, h / 2);
      return;
    }

    const padL = 46;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    let minDb = 100;
    let maxDb = -100;
    bp.forEach(p => {
      if (p < minDb) minDb = p;
      if (p > maxDb) maxDb = p;
    });
    minDb = Math.min(-10.0, Math.floor(minDb / 5) * 5);
    maxDb = Math.max(15.0, Math.ceil(maxDb / 5) * 5);

    // Grid ticks
    corrBandpassCtx.strokeStyle = '#121d33';
    corrBandpassCtx.lineWidth = 1;
    corrBandpassCtx.fillStyle = '#5a7192';
    corrBandpassCtx.font = '10px ui-monospace, monospace';

    const fSteps = [300, 350, 400, 450, 500];
    fSteps.forEach(freq => {
      const x = padL + ((freq - 300) / 201.3) * plotW;
      corrBandpassCtx.beginPath();
      corrBandpassCtx.moveTo(x, padT);
      corrBandpassCtx.lineTo(x, padT + plotH);
      corrBandpassCtx.stroke();
      corrBandpassCtx.fillText(`${freq} MHz`, x, padT + plotH + 8);
    });

    // Subband boundary marker at 400.65 MHz
    const subbandX = padL + ((400.65 - 300) / 201.3) * plotW;
    corrBandpassCtx.strokeStyle = '#00e5ff';
    corrBandpassCtx.setLineDash([3, 3]);
    corrBandpassCtx.beginPath();
    corrBandpassCtx.moveTo(subbandX, padT);
    corrBandpassCtx.lineTo(subbandX, padT + plotH);
    corrBandpassCtx.stroke();
    corrBandpassCtx.setLineDash([]);

    // Curve
    corrBandpassCtx.strokeStyle = '#10b981';
    corrBandpassCtx.lineWidth = 1.8;
    corrBandpassCtx.beginPath();

    for (let ch = 0; ch < 672; ch++) {
      const x = padL + (ch / 671) * plotW;
      const y = padT + (1.0 - (bp[ch] - minDb) / (maxDb - minDb)) * plotH;
      if (ch === 0) corrBandpassCtx.moveTo(x, y);
      else corrBandpassCtx.lineTo(x, y);
    }
    corrBandpassCtx.stroke();
  }

  function drawFringePlot() {
    if (!fringeCanvas || !latestCorrelator) return;
    const setup = resizeHiDPICanvas(fringeCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, width, height);

    let ampArr = null;
    let phaseArr = null;
    let realArr = null;
    let imagArr = null;
    let delayNs = null;

    if (latestBaselineData && latestBaselineData.amplitude && latestBaselineData.phase_rad) {
      ampArr = latestBaselineData.amplitude;
      phaseArr = latestBaselineData.phase_rad;
      delayNs = latestBaselineData.delay_ns;
      realArr = [];
      imagArr = [];
      for (let ch = 0; ch < 672; ch++) {
        realArr.push(ampArr[ch] * Math.cos(phaseArr[ch]));
        imagArr.push(ampArr[ch] * Math.sin(phaseArr[ch]));
      }
    } else {
      const fringes = latestCorrelator.reference_fringes;
      if (!fringes || !fringes[fringeAntenna]) {
        ctx.fillStyle = '#5a7192';
        ctx.font = '11px ui-monospace, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`Awaiting fringe baseline (0, ${fringeAntenna})...`, width / 2, height / 2);
        return;
      }
      const fringe = fringes[fringeAntenna];
      ampArr = fringe.amplitude;
      phaseArr = fringe.phase_rad;
      realArr = fringe.real;
      imagArr = fringe.imag;
    }

    const padL = 46;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    // Grid ticks
    ctx.strokeStyle = '#121d33';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#5a7192';
    ctx.font = '10px ui-monospace, monospace';

    const fSteps = [300, 350, 400, 450, 500];
    fSteps.forEach(freq => {
      const x = padL + ((freq - 300) / 201.3) * plotW;
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillText(`${freq} MHz`, x, padT + plotH + 8);
    });

    if (fringeMode === 'ri') {
      let maxAbs = 0.01;
      for (let ch = 0; ch < 672; ch++) {
        if (Math.abs(realArr[ch]) > maxAbs) maxAbs = Math.abs(realArr[ch]);
        if (Math.abs(imagArr[ch]) > maxAbs) maxAbs = Math.abs(imagArr[ch]);
      }

      // Real
      ctx.strokeStyle = '#00e5ff';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (0.5 - (realArr[ch] / (maxAbs * 2.1))) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      // Imag
      ctx.strokeStyle = '#f59e0b';
      ctx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (0.5 - (imagArr[ch] / (maxAbs * 2.1))) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (fringeMode === 'amp') {
      let maxAmp = 0.01;
      for (let ch = 0; ch < 672; ch++) {
        if (ampArr[ch] > maxAmp) maxAmp = ampArr[ch];
      }

      ctx.strokeStyle = '#10b981';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (1.0 - (ampArr[ch] / maxAmp)) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (fringeMode === 'phase') {
      // Phase (-pi to +pi)
      ctx.strokeStyle = '#d500f9';
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (1.0 - (phaseArr[ch] + Math.PI) / (2 * Math.PI)) * plotH;
        if (ch === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      if (delayNs !== null && delayNs !== undefined) {
        ctx.fillStyle = '#fbbf24';
        ctx.font = '10px ui-monospace, monospace';
        ctx.textAlign = 'right';
        ctx.fillText(`Fitted Geometric Delay τ = ${delayNs.toFixed(2)} ns  [τ = (1/2π)(dφ/df)]`, padL + plotW, padT + 12);
      }
    }
  }

  // ==========================================================================
  // TAB 4: 8x8 Physical Array Health & Live Line Spectrometer Matrix (F4.5)
  // ==========================================================================

  function drawMasterAntennaSpectrometer() {
    if (!antMasterCanvas || !antMasterCtx) return;
    const w = antMasterCanvas.width;
    const h = antMasterCanvas.height;

    antMasterCtx.fillStyle = '#05080f';
    antMasterCtx.fillRect(0, 0, w, h);

    const antennas = (latestAntennaMask && latestAntennaMask.antennas && latestAntennaMask.antennas.length === 64)
      ? latestAntennaMask.antennas
      : null;
    const item = antennas ? antennas[selectedAntennaId] : null;
    const isEnabled = item ? item.enabled : true;
    const row = Math.floor(selectedAntennaId / 8);
    const col = selectedAntennaId % 8;

    // Retrieve spectrum data
    let spectrum = null;
    if (latestCorrelator && latestCorrelator.full_antenna_spectra_db && latestCorrelator.full_antenna_spectra_db[selectedAntennaId]) {
      spectrum = latestCorrelator.full_antenna_spectra_db[selectedAntennaId];
    } else if (item && item.spectrum_db && item.spectrum_db.length > 0) {
      spectrum = item.spectrum_db;
    } else if (latestCorrelator && latestCorrelator.antenna_spectra_db && latestCorrelator.antenna_spectra_db[selectedAntennaId]) {
      spectrum = latestCorrelator.antenna_spectra_db[selectedAntennaId];
    } else {
      spectrum = [];
      for (let i = 0; i < 84; i++) {
        spectrum.push(12.0 + 3.0 * Math.sin((i / 84) * 3 * Math.PI) + Math.sin(i * 0.4) * 0.5);
      }
    }

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

    // Update Header Text & Readouts
    if (antMasterTitle) {
      antMasterTitle.textContent = `Antenna #${String(selectedAntennaId).padStart(2, '0')} Live Line Spectrometer`;
    }
    if (antMasterTile) {
      antMasterTile.textContent = `Physical Tile: Row ${row}, Col ${col}`;
    }
    if (antMasterBadge) {
      antMasterBadge.textContent = isEnabled ? 'NOMINAL (ACTIVE)' : 'MASKED (BLANKED)';
      antMasterBadge.className = `badge ${isEnabled ? 'badge-success' : 'status-masked-badge'}`;
    }
    if (antMasterPeak) {
      antMasterPeak.textContent = `${maxDb.toFixed(1)} dB @ ${peakFreq.toFixed(1)} MHz`;
    }
    if (antMasterMean) {
      antMasterMean.textContent = `${meanDb.toFixed(1)} dB`;
    }
    if (antMasterRms) {
      antMasterRms.textContent = `${item ? item.power_rms.toFixed(2) : '--'} dB`;
    }
    if (antMasterClip) {
      antMasterClip.textContent = `${item ? (item.clip_fraction * 100).toFixed(2) : '--'}%`;
    }
    if (antMasterKurt) {
      antMasterKurt.textContent = `${item ? item.kurtosis.toFixed(2) : '--'}`;
    }
    if (btnToggleSelectedMask) {
      btnToggleSelectedMask.textContent = isEnabled ? `Mask Antenna #${selectedAntennaId}` : `Unmask Antenna #${selectedAntennaId}`;
      btnToggleSelectedMask.className = `btn btn-xs ${isEnabled ? 'btn-danger' : 'btn-primary'}`;
    }

    const padL = 46, padR = 20, padT = 16, padB = 24;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const yMin = Math.min(0, Math.floor(minDb / 5) * 5);
    const yMax = Math.max(25, Math.ceil(maxDb / 5) * 5 + 5);
    const yRange = Math.max(10, yMax - yMin);

    // Horizontal grid lines (dB)
    antMasterCtx.strokeStyle = '#141d2e';
    antMasterCtx.lineWidth = 1;
    antMasterCtx.fillStyle = '#64748b';
    antMasterCtx.font = '9px ui-monospace, monospace';
    antMasterCtx.textAlign = 'right';
    antMasterCtx.textBaseline = 'middle';

    const yStep = yRange > 30 ? 10 : 5;
    for (let db = Math.ceil(yMin / yStep) * yStep; db <= yMax; db += yStep) {
      const y = padT + (1.0 - (db - yMin) / yRange) * plotH;
      antMasterCtx.beginPath();
      antMasterCtx.moveTo(padL, y);
      antMasterCtx.lineTo(padL + plotW, y);
      antMasterCtx.stroke();
      antMasterCtx.fillText(`${db}`, padL - 6, y);
    }

    // Vertical frequency grid lines
    antMasterCtx.textAlign = 'center';
    antMasterCtx.textBaseline = 'top';
    const freqs = [300, 350, 400.8, 450, 501.6];
    freqs.forEach(f => {
      const x = padL + ((f - 300.0) / 201.6) * plotW;
      const isSubbandSplit = Math.abs(f - 400.8) < 0.1;
      antMasterCtx.strokeStyle = isSubbandSplit ? 'rgba(245, 158, 11, 0.45)' : '#141d2e';
      antMasterCtx.lineWidth = isSubbandSplit ? 1.5 : 1;
      if (isSubbandSplit) antMasterCtx.setLineDash([4, 4]);
      else antMasterCtx.setLineDash([]);
      antMasterCtx.beginPath();
      antMasterCtx.moveTo(x, padT);
      antMasterCtx.lineTo(x, padT + plotH);
      antMasterCtx.stroke();
      antMasterCtx.setLineDash([]);

      antMasterCtx.fillStyle = isSubbandSplit ? '#fbbf24' : '#64748b';
      antMasterCtx.fillText(`${f}`, x, padT + plotH + 6);
    });

    if (!isEnabled) {
      // Draw flatline & blanked watermark overlay
      const flatY = padT + plotH - 6;
      antMasterCtx.strokeStyle = '#6366f1';
      antMasterCtx.lineWidth = 2;
      antMasterCtx.beginPath();
      antMasterCtx.moveTo(padL, flatY);
      antMasterCtx.lineTo(padL + plotW, flatY);
      antMasterCtx.stroke();

      antMasterCtx.fillStyle = 'rgba(99, 102, 241, 0.12)';
      antMasterCtx.fillRect(padL, padT, plotW, plotH);
      antMasterCtx.fillStyle = '#a5b4fc';
      antMasterCtx.font = 'bold 12px ui-monospace, monospace';
      antMasterCtx.textAlign = 'center';
      antMasterCtx.textBaseline = 'middle';
      antMasterCtx.fillText('ANTENNA VOLTAGES BLANKED IN VRAM (ZEROED TAPER)', padL + plotW / 2, padT + plotH / 2);
      return;
    }

    // Gradient fill area
    const fillGrad = antMasterCtx.createLinearGradient(0, padT, 0, padT + plotH);
    fillGrad.addColorStop(0, 'rgba(0, 229, 255, 0.28)');
    fillGrad.addColorStop(1, 'rgba(0, 229, 255, 0.01)');

    antMasterCtx.beginPath();
    antMasterCtx.moveTo(padL, padT + plotH);
    for (let i = 0; i < nPoints; i++) {
      const x = padL + (i / Math.max(1, nPoints - 1)) * plotW;
      const y = padT + (1.0 - (spectrum[i] - yMin) / yRange) * plotH;
      antMasterCtx.lineTo(x, y);
    }
    antMasterCtx.lineTo(padL + plotW, padT + plotH);
    antMasterCtx.closePath();
    antMasterCtx.fillStyle = fillGrad;
    antMasterCtx.fill();

    // Line stroke
    const grad = antMasterCtx.createLinearGradient(padL, 0, padL + plotW, 0);
    grad.addColorStop(0, '#00e5ff');
    grad.addColorStop(0.5, '#38bdf8');
    grad.addColorStop(1, '#818cf8');

    antMasterCtx.beginPath();
    for (let i = 0; i < nPoints; i++) {
      const x = padL + (i / Math.max(1, nPoints - 1)) * plotW;
      const y = padT + (1.0 - (spectrum[i] - yMin) / yRange) * plotH;
      if (i === 0) antMasterCtx.moveTo(x, y);
      else antMasterCtx.lineTo(x, y);
    }
    antMasterCtx.strokeStyle = grad;
    antMasterCtx.lineWidth = 1.8;
    antMasterCtx.stroke();

    // Mark Peak Point
    const peakX = padL + (peakIdx / Math.max(1, nPoints - 1)) * plotW;
    const peakY = padT + (1.0 - (maxDb - yMin) / yRange) * plotH;

    antMasterCtx.fillStyle = '#ef4444';
    antMasterCtx.beginPath();
    antMasterCtx.arc(peakX, peakY, 4, 0, 2 * Math.PI);
    antMasterCtx.fill();
    antMasterCtx.strokeStyle = '#ffffff';
    antMasterCtx.lineWidth = 1;
    antMasterCtx.stroke();

    antMasterCtx.fillStyle = '#f87171';
    antMasterCtx.font = 'bold 9px ui-monospace, monospace';
    antMasterCtx.textAlign = peakX > padL + plotW - 90 ? 'right' : 'left';
    antMasterCtx.fillText(`Peak ${maxDb.toFixed(1)} dB`, peakX + (peakX > padL + plotW - 90 ? -8 : 8), peakY - 4);

    // Hover crosshair line
    if (masterAntennaHoverInfo) {
      const { x } = masterAntennaHoverInfo;
      antMasterCtx.strokeStyle = '#00e5ff';
      antMasterCtx.lineWidth = 1;
      antMasterCtx.setLineDash([2, 2]);
      antMasterCtx.beginPath();
      antMasterCtx.moveTo(x, padT);
      antMasterCtx.lineTo(x, padT + plotH);
      antMasterCtx.stroke();
      antMasterCtx.setLineDash([]);
    }
  }

  function drawMiniSpectrometer(canvas, spec, isEnabled, statusRaw) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;

    ctx.fillStyle = '#060913';
    ctx.fillRect(0, 0, w, h);

    // Subband vertical divider line at x = w / 2
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 2]);
    ctx.beginPath();
    ctx.moveTo(w / 2, 0);
    ctx.lineTo(w / 2, h);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!isEnabled) {
      ctx.strokeStyle = '#475569';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(0, h - 3);
      ctx.lineTo(w, h - 3);
      ctx.stroke();
      return;
    }

    if (!spec || spec.length === 0) {
      spec = [];
      for (let i = 0; i < 40; i++) {
        spec.push(10.0 + 3.0 * Math.sin((i / 40) * 2 * Math.PI));
      }
    }

    const n = spec.length;
    let minV = 5, maxV = 25;
    for (let v of spec) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const range = Math.max(8, maxV - minV);

    let strokeColor = '#00e5ff';
    if (statusRaw === 'saturated') {
      strokeColor = '#ef4444';
    } else if (statusRaw === 'high_clip') {
      strokeColor = '#f59e0b';
    }

    // Area fill
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    const fillAlpha = statusRaw === 'saturated' ? 'rgba(239, 68, 68, 0.25)' : statusRaw === 'high_clip' ? 'rgba(245, 158, 11, 0.25)' : 'rgba(0, 229, 255, 0.2)';
    grad.addColorStop(0, fillAlpha);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - ((spec[i] - minV) / range) * (h - 6) - 3;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Line stroke
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * w;
      const y = h - ((spec[i] - minV) / range) * (h - 6) - 3;
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 1.3;
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

  function renderAntennaMaskGrid(canvas, antennas) {
    if (!canvas || !antennas) return;
    const setup = resizeHiDPICanvas(canvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.clearRect(0, 0, width, height);
    const cols = 8, rows = 8, gap = 4;
    const cellW = Math.floor((width - gap * (cols + 1)) / cols);
    const cellH = Math.floor((height - gap * (rows + 1)) / rows);

    antennas.forEach((ant, idx) => {
      const r = Math.floor(idx / cols);
      const c = idx % cols;
      const x = gap + c * (cellW + gap);
      const y = gap + r * (cellH + gap);

      const isSelected = (idx === selectedAntennaId);
      const isMasked = !ant.enabled || ant.status === 'manually_masked' || ant.masked;
      const powerDb = ant.power_rms !== undefined ? ant.power_rms : (ant.power_db !== undefined ? ant.power_db : 10.0);

      // Background fill based on power/RMS or masked status
      ctx.fillStyle = isMasked ? '#2a1215' : powerToColor(powerDb);
      ctx.fillRect(x, y, cellW, cellH);

      // Crisp 1px border (red highlight if masked, cyan highlight if selected)
      if (isSelected) {
        ctx.strokeStyle = '#00e5ff';
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
      } else {
        ctx.strokeStyle = isMasked ? '#ff4d4f' : 'rgba(255,255,255,0.15)';
        ctx.lineWidth = isMasked ? 1.5 : 1;
        ctx.strokeRect(x + 0.5, y + 0.5, cellW - 1, cellH - 1);
      }

      // Crisp vector labels
      ctx.fillStyle = isMasked ? '#ff7875' : '#f0f0f0';
      ctx.font = '600 11px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(`A${String(idx).padStart(2, '0')}`, x + 6, y + 14);

      ctx.fillStyle = isMasked ? '#ff4d4f' : '#a0a0a0';
      ctx.font = '10px ui-monospace, SFMono-Regular, monospace';
      ctx.fillText(isMasked ? 'MASKED' : `${powerDb.toFixed(1)} dB`, x + 6, y + cellH - 6);
    });
  }

  function renderArrayGrid() {
    const antennas = (latestAntennaMask && latestAntennaMask.antennas && latestAntennaMask.antennas.length === 64)
      ? latestAntennaMask.antennas
      : null;

    if (antViewMode === 'canvas') {
      if (antennaMaskCanvas && antennas) {
        renderAntennaMaskGrid(antennaMaskCanvas, antennas);
      }
      return;
    }

    if (!arrayGrid8x8) return;
    arrayGrid8x8.innerHTML = '';

    for (let id = 0; id < 64; id++) {
      const item = antennas ? antennas[id] : null;
      const isEnabled = item ? item.enabled : true;
      const statusRaw = item ? item.status : 'nominal';
      const powerRms = item ? item.power_rms.toFixed(2) : '8.10';
      const clipPct = item ? (item.clip_fraction * 100).toFixed(2) : '0.01';
      const row = Math.floor(id / 8);
      const col = id % 8;

      let statusClass = 'status-nominal';
      let tagLabel = 'OK';

      if (!isEnabled || statusRaw === 'manually_masked') {
        statusClass = 'status-masked';
        tagLabel = 'MASKED';
      } else if (statusRaw === 'dead') {
        statusClass = 'status-dead';
        tagLabel = 'DEAD';
      } else if (statusRaw === 'saturated') {
        statusClass = 'status-saturated';
        tagLabel = 'SAT';
      } else if (statusRaw === 'high_clip') {
        statusClass = 'status-high-clip';
        tagLabel = 'CLIP';
      }

      // Extract spectrum for mini line spectrometer
      let spec = (item && item.spectrum_db && item.spectrum_db.length > 0)
        ? item.spectrum_db
        : (latestCorrelator && latestCorrelator.antenna_spectra_db && latestCorrelator.antenna_spectra_db[id])
          ? latestCorrelator.antenna_spectra_db[id]
          : null;

      let peakDb = '--';
      if (spec && spec.length > 0 && isEnabled) {
        let maxV = -999;
        for (let s of spec) if (s > maxV) maxV = s;
        peakDb = `${maxV.toFixed(1)} dB`;
      }

      const card = document.createElement('div');
      card.className = `antenna-card ${statusClass} ${id === selectedAntennaId ? 'selected' : ''}`;
      card.title = `Antenna #${id} [Tile ${row},${col}]: Click to inspect line spectrum · Click Tag to toggle mask`;

      card.innerHTML = `
        <div class="antenna-card-header">
          <span class="ant-id">#${String(id).padStart(2, '0')}</span>
          <span class="ant-power-peak">${peakDb}</span>
          <span class="ant-status-tag" title="Click to toggle mask">${tagLabel}</span>
        </div>
        <div class="ant-mini-spec-wrap">
          <canvas class="ant-mini-canvas" id="ant-mini-canvas-${id}" width="120" height="38"></canvas>
          ${!isEnabled ? '<div class="ant-mini-watermark">MASKED</div>' : ''}
        </div>
        <div class="ant-metrics">
          <div class="ant-metric-row">
            <span>RMS:</span>
            <span class="ant-metric-val">${powerRms} dB</span>
          </div>
          <div class="ant-metric-row">
            <span>Clip:</span>
            <span class="ant-metric-val">${clipPct}%</span>
          </div>
        </div>
      `;

      // Render mini line spectrometer
      const miniCanvas = card.querySelector(`#ant-mini-canvas-${id}`);
      if (miniCanvas) {
        drawMiniSpectrometer(miniCanvas, spec, isEnabled, statusRaw);
      }

      // Click card selects antenna and updates master inspector
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

      arrayGrid8x8.appendChild(card);
    }
  }


  // ==========================================================================
  // Form Controls & Interaction Handlers
  // ==========================================================================

  function initControls() {
    // Top Tabs
    initTabRouter();

    // Start Clock
    startUtcClock();

    // Steering Subtabs
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

    // Direction Cosines Form
    if (formSteerLm) {
      formSteerLm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const beamId = parseInt(lmBeamSelect.value, 10);
        const l0 = parseFloat(document.getElementById('lm-l0').value);
        const m0 = parseFloat(document.getElementById('lm-m0').value);

        if (isNaN(l0) || isNaN(m0)) {
          showToast('Please enter valid direction cosines l0 and m0', true);
          return;
        }

        const r2 = l0 * l0 + m0 * m0;
        if (r2 > 1.0) {
          showToast(`Invalid direction: l0² + m0² = ${r2.toFixed(4)} > 1.0`, true);
          return;
        }

        const payload = { beam_id: beamId, l0, m0 };
        const l1 = parseFloat(document.getElementById('lm-l1').value);
        const m1 = parseFloat(document.getElementById('lm-m1').value);
        const dl = parseFloat(document.getElementById('lm-dl').value);
        const dm = parseFloat(document.getElementById('lm-dm').value);

        if (!isNaN(l1)) payload.l1 = l1;
        if (!isNaN(m1)) payload.m1 = m1;
        if (!isNaN(dl)) payload.dl = dl;
        if (!isNaN(dm)) payload.dm = dm;

        try {
          const res = await fetch(`/api/beams/${beamId}/target`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const reply = await res.json();
          if (res.ok) {
            showToast(reply.message || `Beam ${beamId} target applied`);
          } else {
            showToast(reply.detail || 'Steer failed', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    // Celestial Presets
    if (celPresetSelect) {
      celPresetSelect.addEventListener('change', () => {
        const val = celPresetSelect.value;
        if (val && CELESTIAL_PRESETS[val]) {
          document.getElementById('cel-ra').value = CELESTIAL_PRESETS[val].ra;
          document.getElementById('cel-dec').value = CELESTIAL_PRESETS[val].dec;
        }
      });
    }

    // Celestial Form
    if (formSteerCelestial) {
      formSteerCelestial.addEventListener('submit', async (e) => {
        e.preventDefault();
        const beamId = parseInt(celBeamSelect.value, 10);
        const ra = parseFloat(document.getElementById('cel-ra').value);
        const dec = parseFloat(document.getElementById('cel-dec').value);

        if (isNaN(ra) || isNaN(dec) || ra < 0 || ra >= 360 || dec < -90 || dec > 90) {
          showToast('RA must be [0, 360) and Dec in [-90, 90]', true);
          return;
        }

        try {
          const res = await fetch(`/api/beams/${beamId}/celestial`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ beam_id: beamId, ra_deg: ra, dec_deg: dec })
          });
          const reply = await res.json();
          if (res.ok) {
            showToast(reply.message || `Beam ${beamId} pointed to celestial target`);
          } else {
            showToast(reply.detail || 'Celestial steer failed', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    // Config Controls
    if (applyBeamsBtn) {
      applyBeamsBtn.addEventListener('click', async () => {
        const val = parseInt(numBeamsSelect.value, 10);
        if (isNaN(val) || val < 1 || val > 16) {
          showToast('Active beams must be between 1 and 16', true);
          return;
        }
        try {
          const res = await fetch('/api/beams/enable', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ num_active_beams: val })
          });
          const reply = await res.json();
          if (res.ok) {
            showToast(reply.message || `Active beams set to ${val}`);
          } else {
            showToast(reply.detail || 'Failed to set active beams', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    if (interpToggle) {
      interpToggle.addEventListener('change', async () => {
        const enabled = interpToggle.checked;
        try {
          const res = await fetch('/api/interpolation', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ enabled })
          });
          const reply = await res.json();
          if (res.ok) {
            showToast(reply.message || `Interpolation ${enabled ? 'enabled' : 'disabled'}`);
          } else {
            showToast(reply.detail || 'Failed to toggle interpolation', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    // Spectrometer View Select & Reset Zoom
    if (specViewSelect) {
      specViewSelect.addEventListener('change', () => {
        specViewMode = specViewSelect.value;
        requestAnimationFrame(drawSpectrometer);
      });
    }

    if (specResetZoomBtn) {
      specResetZoomBtn.addEventListener('click', () => {
        specZoom.userZoomed = false;
        requestAnimationFrame(drawSpectrometer);
      });
    }

    if (specCanvas) {
      specCanvas.addEventListener('mousemove', (e) => {
        const rect = specCanvas.getBoundingClientRect();
        specHover.active = true;
        specHover.x = (e.clientX - rect.left) * (specCanvas.width / rect.width);
        specHover.y = (e.clientY - rect.top) * (specCanvas.height / rect.height);
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

    // Waterfall Controls
    if (waterfallBeamSelect) {
      waterfallBeamSelect.addEventListener('change', () => {
        waterfallBeamId = parseInt(waterfallBeamSelect.value, 10);
        waterfallHistory = [];
        requestAnimationFrame(drawWaterfall);
      });
    }

    if (waterfallClearBtn) {
      waterfallClearBtn.addEventListener('click', () => {
        waterfallHistory = [];
        requestAnimationFrame(drawWaterfall);
      });
    }

    // Sky Map Cursor Hover
    if (skyCanvas) {
      skyCanvas.addEventListener('mousemove', (e) => {
        const rect = skyCanvas.getBoundingClientRect();
        const scaleX = skyCanvas.width / rect.width;
        const scaleY = skyCanvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        const cx = skyCanvas.width / 2;
        const cy = skyCanvas.height / 2;
        const r = (skyCanvas.width / 2) - 34;

        const l = (x - cx) / r;
        const m = (cy - y) / r;

        const rad = Math.sqrt(l * l + m * m);
        const altDeg = (90.0 - Math.asin(Math.min(1.0, rad)) * 180.0 / Math.PI).toFixed(1);
        const azDeg = ((Math.atan2(l, m) * 180.0 / Math.PI + 360.0) % 360.0).toFixed(1);

        if (cursorCoords) {
          cursorCoords.textContent = `l: ${l.toFixed(4)} , m: ${m.toFixed(4)} | Alt: ${altDeg}° Az: ${azDeg}°`;
        }
      });
    }

    // Grid Slicing Buttons
    const sliceBtns = document.querySelectorAll('#grid-slice-buttons .btn');
    sliceBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        sliceBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        gridSliceMode = btn.getAttribute('data-slice');
        if (latestGrid) {
          renderGridTable(latestGrid);
          requestAnimationFrame(drawGridHeatmap);
        }
      });
    });

    // Grid Mode Buttons
    const modeBtns = document.querySelectorAll('#grid-mode-buttons .btn');
    modeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        modeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        gridDisplayMode = btn.getAttribute('data-mode');
        requestAnimationFrame(drawGridHeatmap);
      });
    });

    // Fringe Baseline Buttons
    const fringeBaseBtns = document.querySelectorAll('#fringe-baseline-buttons .btn');
    fringeBaseBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        fringeBaseBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fringeAntenna = parseInt(btn.getAttribute('data-ant'), 10);
        requestAnimationFrame(drawFringePlot);
      });
    });

    // Fringe Mode Buttons
    const fringeModeBtns = document.querySelectorAll('#fringe-mode-buttons .btn');
    fringeModeBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        fringeModeBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        fringeMode = btn.getAttribute('data-mode');
        requestAnimationFrame(drawFringePlot);
      });
    });

    // Toggle Auto-Detect
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
          if (latestAntennaMask) {
            latestAntennaMask.auto_detect_enabled = targetState;
          }
          if (rfAutodetectBadge) {
            rfAutodetectBadge.textContent = targetState ? 'ENABLED' : 'DISABLED';
            rfAutodetectBadge.className = `metric-val monospace ${targetState ? 'success' : 'warning'}`;
          }
          if (btnToggleAutodetect) {
            btnToggleAutodetect.textContent = targetState ? 'Disable Auto-Detect' : 'Enable Auto-Detect';
            if (targetState) {
              btnToggleAutodetect.classList.remove('btn-autodetect-off');
            } else {
              btnToggleAutodetect.classList.add('btn-autodetect-off');
            }
          }
          showToast(targetState ? 'Antenna auto-detection enabled' : 'Antenna auto-detection disabled (manual mode)');
        } else {
          showToast('Failed to toggle auto-detection', true);
        }
      } catch (err) {
        showToast(err.message, true);
      }
    }

    if (btnToggleAutodetect) {
      btnToggleAutodetect.addEventListener('click', toggleAutoDetect);
    }
    if (pillAutodetect) {
      pillAutodetect.addEventListener('click', toggleAutoDetect);
    }

    // Unmask All Button
    if (btnUnmaskAll) {
      btnUnmaskAll.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/antennas/unmask_all', { method: 'POST' });
          if (res.ok) {
            showToast('All 64 antennas unmasked');
            if (latestAntennaMask && latestAntennaMask.antennas) {
              latestAntennaMask.antennas.forEach(a => { a.enabled = true; });
            }
            renderArrayGrid();
            drawMasterAntennaSpectrometer();
          } else {
            showToast('Failed to unmask antennas', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    // Mask All Button
    if (btnMaskAll) {
      btnMaskAll.addEventListener('click', async () => {
        if (!latestAntennaMask || !latestAntennaMask.antennas) return;
        try {
          await Promise.all(latestAntennaMask.antennas.map(a =>
            fetch('/api/antennas/mask', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ antenna_id: a.antenna_id, enabled: false })
            })
          ));
          showToast('All 64 antennas masked (blanked)');
          latestAntennaMask.antennas.forEach(a => { a.enabled = false; });
          renderArrayGrid();
          drawMasterAntennaSpectrometer();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    // Invert Mask Button
    if (btnInvertMask) {
      btnInvertMask.addEventListener('click', async () => {
        if (!latestAntennaMask || !latestAntennaMask.antennas) return;
        try {
          await Promise.all(latestAntennaMask.antennas.map(a =>
            fetch('/api/antennas/mask', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ antenna_id: a.antenna_id, enabled: !a.enabled })
            })
          ));
          showToast('Antenna mask pattern inverted');
          latestAntennaMask.antennas.forEach(a => { a.enabled = !a.enabled; });
          renderArrayGrid();
          drawMasterAntennaSpectrometer();
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    // Toggle Mask for Selected Antenna Button
    if (btnToggleSelectedMask) {
      btnToggleSelectedMask.addEventListener('click', () => {
        const item = (latestAntennaMask && latestAntennaMask.antennas) ? latestAntennaMask.antennas[selectedAntennaId] : null;
        const currentEnabled = item ? item.enabled : true;
        toggleAntennaMask(selectedAntennaId, !currentEnabled);
      });
    }

    // Master Antenna Canvas Hover Inspection
    if (antMasterCanvas && antMasterHover) {
      antMasterCanvas.addEventListener('mousemove', (e) => {
        const rect = antMasterCanvas.getBoundingClientRect();
        const clientX = e.clientX - rect.left;
        const padL = 46, padR = 20;
        const scaleX = antMasterCanvas.width / rect.width;
        const plotW = antMasterCanvas.width - padL - padR;
        const normX = (clientX * scaleX - padL) / plotW;

        if (normX >= 0 && normX <= 1) {
          const fMhz = 300.0 + normX * 201.6;
          const item = (latestAntennaMask && latestAntennaMask.antennas) ? latestAntennaMask.antennas[selectedAntennaId] : null;
          const spec = (item && item.spectrum_db) || [];
          const idx = Math.min(spec.length - 1, Math.max(0, Math.round(normX * (spec.length - 1))));
          const dbVal = spec[idx] !== undefined ? spec[idx] : 0;

          masterAntennaHoverInfo = { x: padL + normX * plotW, fMhz, dbVal };
          antMasterHover.textContent = `${fMhz.toFixed(2)} MHz | ${dbVal.toFixed(1)} dB`;
          antMasterHover.style.left = `${Math.min(rect.width - 130, Math.max(10, clientX + 10))}px`;
          antMasterHover.style.top = '10px';
          antMasterHover.classList.remove('hidden');
          drawMasterAntennaSpectrometer();
        } else {
          masterAntennaHoverInfo = null;
          antMasterHover.classList.add('hidden');
          drawMasterAntennaSpectrometer();
        }
      });

      antMasterCanvas.addEventListener('mouseleave', () => {
        masterAntennaHoverInfo = null;
        antMasterHover.classList.add('hidden');
        drawMasterAntennaSpectrometer();
      });
    }

    // Steer Drawer Toggles (Zone A)
    if (btnToggleSteerDrawer && steerDrawer) {
      btnToggleSteerDrawer.addEventListener('click', () => {
        steerDrawer.classList.toggle('hidden');
      });
    }
    if (btnCloseSteerDrawer && steerDrawer) {
      btnCloseSteerDrawer.addEventListener('click', () => {
        steerDrawer.classList.add('hidden');
      });
    }

    // Zone B Mode Buttons (Overlay All, Small-Mult, Sky Radar)
    if (btnModeOverlay && btnModeSmallMult && btnModeSky) {
      btnModeOverlay.addEventListener('click', () => {
        trackerSpecMode = 'overlay';
        btnModeOverlay.classList.add('active');
        btnModeSmallMult.classList.remove('active');
        btnModeSky.classList.remove('active');
        if (skyCanvas) skyCanvas.classList.add('hidden');
        if (specCanvas) specCanvas.classList.remove('hidden');
        requestAnimationFrame(drawSpectrometer);
      });

      btnModeSmallMult.addEventListener('click', () => {
        trackerSpecMode = 'small-mult';
        btnModeSmallMult.classList.add('active');
        btnModeOverlay.classList.remove('active');
        btnModeSky.classList.remove('active');
        if (skyCanvas) skyCanvas.classList.add('hidden');
        if (specCanvas) specCanvas.classList.remove('hidden');
        requestAnimationFrame(drawSpectrometer);
      });

      btnModeSky.addEventListener('click', () => {
        trackerSpecMode = 'sky';
        btnModeSky.classList.add('active');
        btnModeOverlay.classList.remove('active');
        btnModeSmallMult.classList.remove('active');
        if (specCanvas) specCanvas.classList.add('hidden');
        if (skyCanvas) skyCanvas.classList.remove('hidden');
        requestAnimationFrame(drawSkyMap);
      });
    }

    // Grid Camera & Waterfalls View Toggles (Tab 2)
    if (btnViewCamera && btnViewWaterfalls && gridCameraView && gridWaterfallsPanel) {
      btnViewCamera.addEventListener('click', () => {
        gridViewMode = 'camera';
        btnViewCamera.classList.add('active');
        btnViewWaterfalls.classList.remove('active');
        gridCameraView.classList.remove('hidden');
        gridWaterfallsPanel.classList.add('hidden');
        requestAnimationFrame(drawGridHeatmap);
      });

      btnViewWaterfalls.addEventListener('click', () => {
        gridViewMode = 'waterfalls';
        btnViewWaterfalls.classList.add('active');
        btnViewCamera.classList.remove('active');
        gridCameraView.classList.add('hidden');
        gridWaterfallsPanel.classList.remove('hidden');
        requestAnimationFrame(renderGridWaterfalls);
      });
    }

    // Correlator View Toggles (Tab 3: Split-Triangle vs Dual Matrices)
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

    // Baseline Inspector Manual Controls (Tab 3)
    if (btnInspectBaseline && baseAntAInput && baseAntBInput) {
      btnInspectBaseline.addEventListener('click', () => {
        const a = parseInt(baseAntAInput.value, 10);
        const b = parseInt(baseAntBInput.value, 10);
        if (!isNaN(a) && !isNaN(b) && a >= 0 && a < 64 && b >= 0 && b < 64) {
          inspectBaseline(a, b);
          if (corrViewMode === 'split') requestAnimationFrame(drawSplitCorrelatorMatrix);
        }
      });
    }

    // Split Correlator Canvas Interaction (Hover & Click Cell to Inspect)
    if (corrSplitCanvas) {
      corrSplitCanvas.addEventListener('mousemove', (e) => {
        if (!latestCorrelator) return;
        const rect = corrSplitCanvas.getBoundingClientRect();
        const clientX = e.clientX - rect.left;
        const clientY = e.clientY - rect.top;
        const scale = corrSplitCanvas.width / (window.devicePixelRatio || 1) / rect.width;
        const curX = clientX * scale;
        const curY = clientY * scale;

        const pad = 28;
        const plotW = (rect.width * scale) - pad * 2;
        const plotH = (rect.height * scale) - pad * 2;

        if (curX >= pad && curX <= pad + plotW && curY >= pad && curY <= pad + plotH) {
          const j = Math.min(63, Math.max(0, Math.floor((curX - pad) / (plotW / 64))));
          const i = Math.min(63, Math.max(0, Math.floor((curY - pad) / (plotH / 64))));

          if (corrSplitHoverEl) {
            if (i === j) {
              const autoDb = latestCorrelator.auto_db ? latestCorrelator.auto_db[i] : '--';
              corrSplitHoverEl.textContent = `Antenna #${i} Auto-Power: ${autoDb} dB`;
            } else if (i < j) {
              const coh = latestCorrelator.coherence_matrix ? latestCorrelator.coherence_matrix[i][j].toFixed(4) : (latestCorrelator.amplitude_matrix ? latestCorrelator.amplitude_matrix[i][j].toFixed(4) : '--');
              corrSplitHoverEl.textContent = `Upper Triangle: Baseline (${i}, ${j}) Coherence |Γ| = ${coh} · Click cell to inspect 672-ch baseline`;
            } else {
              const ph = latestCorrelator.phase_matrix ? latestCorrelator.phase_matrix[i][j] : 0;
              const deg = (ph * 180 / Math.PI).toFixed(1);
              corrSplitHoverEl.textContent = `Lower Triangle: Baseline (${i}, ${j}) Fringe Phase φ = ${ph.toFixed(3)} rad (${deg}°) · Click cell to inspect`;
            }
          }
        }
      });

      corrSplitCanvas.addEventListener('mouseleave', () => {
        if (corrSplitHoverEl) {
          corrSplitHoverEl.textContent = 'Hover on matrix to inspect coherence / phase · Click cell to inspect baseline';
        }
      });

      corrSplitCanvas.addEventListener('click', (e) => {
        if (!latestCorrelator) return;
        const rect = corrSplitCanvas.getBoundingClientRect();
        const clientX = e.clientX - rect.left;
        const clientY = e.clientY - rect.top;
        const scale = corrSplitCanvas.width / (window.devicePixelRatio || 1) / rect.width;
        const curX = clientX * scale;
        const curY = clientY * scale;

        const pad = 28;
        const plotW = (rect.width * scale) - pad * 2;
        const plotH = (rect.height * scale) - pad * 2;

        if (curX >= pad && curX <= pad + plotW && curY >= pad && curY <= pad + plotH) {
          const j = Math.min(63, Math.max(0, Math.floor((curX - pad) / (plotW / 64))));
          const i = Math.min(63, Math.max(0, Math.floor((curY - pad) / (plotH / 64))));
          let antA = Math.min(i, j);
          let antB = Math.max(i, j);
          if (antA === antB) {
            antB = (antA + 1) % 64;
          }
          inspectBaseline(antA, antB);
          drawSplitCorrelatorMatrix();
        }
      });
    }

    // Antenna View Mode Buttons (Tab 4: Vector Canvas vs Cards)
    if (btnAntViewCanvas && btnAntViewCards && antennaMaskCanvasWrap && arrayGrid8x8) {
      btnAntViewCanvas.addEventListener('click', () => {
        antViewMode = 'canvas';
        btnAntViewCanvas.classList.add('active');
        btnAntViewCards.classList.remove('active');
        antennaMaskCanvasWrap.classList.remove('hidden');
        arrayGrid8x8.classList.add('hidden');
        if (latestAntennaMask && latestAntennaMask.antennas) {
          renderAntennaMaskGrid(antennaMaskCanvas, latestAntennaMask.antennas);
        }
      });

      btnAntViewCards.addEventListener('click', () => {
        antViewMode = 'cards';
        btnAntViewCards.classList.add('active');
        btnAntViewCanvas.classList.remove('active');
        antennaMaskCanvasWrap.classList.add('hidden');
        arrayGrid8x8.classList.remove('hidden');
        renderArrayGrid();
      });
    }

    // Antenna Mask Canvas Interaction (Hover & Click to Select)
    if (antennaMaskCanvas) {
      antennaMaskCanvas.addEventListener('mousemove', (e) => {
        if (!latestAntennaMask || !latestAntennaMask.antennas) return;
        const rect = antennaMaskCanvas.getBoundingClientRect();
        const clientX = e.clientX - rect.left;
        const clientY = e.clientY - rect.top;
        const scaleX = antennaMaskCanvas.width / (window.devicePixelRatio || 1) / rect.width;
        const scaleY = antennaMaskCanvas.height / (window.devicePixelRatio || 1) / rect.height;
        const x = clientX * scaleX;
        const y = clientY * scaleY;

        const cols = 8, rows = 8, gap = 4;
        const cellW = Math.floor(((rect.width * scaleX) - gap * (cols + 1)) / cols);
        const cellH = Math.floor(((rect.height * scaleY) - gap * (rows + 1)) / rows);

        const col = Math.floor((x - gap) / (cellW + gap));
        const row = Math.floor((y - gap) / (cellH + gap));

        if (col >= 0 && col < cols && row >= 0 && row < rows) {
          const idx = row * cols + col;
          const ant = latestAntennaMask.antennas[idx];
          if (ant && antennaMaskHoverEl) {
            antennaMaskHoverEl.textContent = `Antenna A${String(idx).padStart(2, '0')} [Tile ${row},${col}] | ${ant.enabled ? 'Active' : 'Masked'} | RMS: ${(ant.power_rms || 0).toFixed(2)} dB | Clip: ${((ant.clip_fraction || 0) * 100).toFixed(2)}%`;
            antennaMaskHoverEl.classList.remove('hidden');
          }
        } else if (antennaMaskHoverEl) {
          antennaMaskHoverEl.classList.add('hidden');
        }
      });

      antennaMaskCanvas.addEventListener('mouseleave', () => {
        if (antennaMaskHoverEl) antennaMaskHoverEl.classList.add('hidden');
      });

      antennaMaskCanvas.addEventListener('click', (e) => {
        if (!latestAntennaMask || !latestAntennaMask.antennas) return;
        const rect = antennaMaskCanvas.getBoundingClientRect();
        const clientX = e.clientX - rect.left;
        const clientY = e.clientY - rect.top;
        const scaleX = antennaMaskCanvas.width / (window.devicePixelRatio || 1) / rect.width;
        const scaleY = antennaMaskCanvas.height / (window.devicePixelRatio || 1) / rect.height;
        const x = clientX * scaleX;
        const y = clientY * scaleY;

        const cols = 8, rows = 8, gap = 4;
        const cellW = Math.floor(((rect.width * scaleX) - gap * (cols + 1)) / cols);
        const cellH = Math.floor(((rect.height * scaleY) - gap * (rows + 1)) / rows);

        const col = Math.floor((x - gap) / (cellW + gap));
        const row = Math.floor((y - gap) / (cellH + gap));

        if (col >= 0 && col < cols && row >= 0 && row < rows) {
          const idx = row * cols + col;
          selectedAntennaId = idx;
          drawMasterAntennaSpectrometer();
          renderAntennaMaskGrid(antennaMaskCanvas, latestAntennaMask.antennas);
        }
      });
    }
  }


  // --- Initial Boot Sequence ---
  window.addEventListener('DOMContentLoaded', () => {
    initControls();
    initWebSocket();
  });

})();
