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
  let selectedBeamId = 0;
  let beamTrails = {};
  let specViewMode = 'all';
  let specHover = { active: false, x: 0, y: 0 };
  let specZoom = { fMin: 300.0, fMax: 501.3, dbMin: -45.0, dbMax: 10.0, userZoomed: false };
  let waterfallHistory = []; // array of { timestamp, powers: [672] }
  let waterfallBeamId = 0;
  const MAX_WATERFALL_ROWS = 90;

  // Tab 2 (Grid Camera) State
  let gridSliceMode = 'full'; // 'full', 'sub0', 'sub1'
  let gridDisplayMode = 'contour'; // 'contour', 'cells'
  let gridHover = { active: false, x: 0, y: 0, row: -1, col: -1, beamId: -1 };

  // Tab 3 (Correlator) State
  let fringeAntenna = 4; // one of 0, 4, 6, 8, 32
  let fringeMode = 'ri'; // 'ri', 'amp', 'phase'
  let corrAmpHover = { active: false, i: -1, j: -1, val: 0 };
  let corrPhaseHover = { active: false, i: -1, j: -1, val: 0 };
  let bandpassHover = { active: false, freq: 0, power: 0 };
  let fringeHover = { active: false, freq: 0, val: 0 };

  // --- DOM Elements ---
  // Header
  const utcClockEl = document.getElementById('utc-clock');
  const connBadge = document.getElementById('conn-badge');
  const connLabel = document.getElementById('conn-label');
  const activeBeamsSummary = document.getElementById('active-beams-summary');
  const activeElementsSummary = document.getElementById('active-elements-summary');
  const routineSummary = document.getElementById('routine-summary');
  const toast = document.getElementById('toast-message');

  // Tab 1 Elements
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

  // Tab 3 Elements
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

  // Tab 4 Elements
  const rfActiveBadge = document.getElementById('rf-active-badge');
  const rfMaskedBadge = document.getElementById('rf-masked-badge');
  const rfAutodetectBadge = document.getElementById('rf-autodetect-badge');
  const rfBlankingBadge = document.getElementById('rf-blanking-badge');
  const arrayGrid8x8 = document.getElementById('array-grid-8x8');
  const btnUnmaskAll = document.getElementById('btn-unmask-all');

  // --- Utility Functions ---
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
      drawSkyMap();
      drawSpectrometer();
      drawWaterfall();
    } else if (activeTab === 'tab-grid') {
      drawGridHeatmap();
    } else if (activeTab === 'tab-correlator') {
      drawCorrelatorMatrices();
      drawBandpassSpectrum();
      drawFringePlot();
    } else if (activeTab === 'tab-array') {
      renderArrayGrid();
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

    // Append to waterfall history
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
      requestAnimationFrame(drawSpectrometer);
      requestAnimationFrame(drawWaterfall);
    }
  }

  // 4. Sky Grid Camera Telemetry (Engine 2)
  function handleGridUpdate(frame) {
    if (!frame) return;
    latestGrid = frame;

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
      requestAnimationFrame(drawGridHeatmap);
    }
  }

  // 5. Correlator Telemetry (Engine 3)
  function handleCorrelatorUpdate(corr) {
    if (!corr) return;
    latestCorrelator = corr;

    if (activeTab === 'tab-correlator') {
      requestAnimationFrame(drawCorrelatorMatrices);
      requestAnimationFrame(drawBandpassSpectrum);
      requestAnimationFrame(drawFringePlot);
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
      rfAutodetectBadge.textContent = maskStatus.auto_detect_enabled ? 'ENABLED' : 'DISABLED';
    }
    if (rfBlankingBadge) {
      rfBlankingBadge.textContent = maskStatus.blank_voltages_enabled ? 'RTX 5090 IN-PLACE' : 'OFF';
    }

    renderArrayGrid();
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
      beamTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No active tracked beams</td></tr>';
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
        : 'Direction cosines';

      // Alt/Az calculation from (l, m)
      const r = Math.sqrt(b.l0 * b.l0 + b.m0 * b.m0);
      const altDeg = (90.0 - Math.asin(Math.min(1.0, r)) * 180.0 / Math.PI).toFixed(1);
      const azDeg = ((Math.atan2(b.l0, b.m0) * 180.0 / Math.PI + 360.0) % 360.0).toFixed(1);

      // Peak dB from latest spectrometer if available
      let peakDb = '--';
      if (latestSpectrometer && latestSpectrometer.beams && latestSpectrometer.beams[b.beam_id]) {
        const spec = latestSpectrometer.beams[b.beam_id];
        if (spec.stats && spec.stats.max !== undefined) {
          peakDb = `${spec.stats.max.toFixed(1)} dB`;
        }
      }

      tr.innerHTML = `
        <td style="color: ${color}; font-weight: 700;">● Beam ${b.beam_id}</td>
        <td>${name ? `<strong>${name}</strong>` : '<span class="status-label">Manual</span>'}</td>
        <td>(${b.l0.toFixed(4)}, ${b.m0.toFixed(4)})</td>
        <td>${targetStr}</td>
        <td>${altDeg}°, ${azDeg}°</td>
        <td><span class="monospace highlight">${peakDb}</span></td>
      `;

      tr.addEventListener('click', () => selectBeam(b.beam_id));
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
    const w = specCanvas.width;
    const h = specCanvas.height;

    specCtx.fillStyle = '#05080f';
    specCtx.fillRect(0, 0, w, h);

    if (!latestSpectrometer || !latestSpectrometer.beams) {
      specCtx.fillStyle = '#5a7192';
      specCtx.font = '12px ui-monospace, monospace';
      specCtx.textAlign = 'center';
      specCtx.textBaseline = 'middle';
      specCtx.fillText('Awaiting 672-channel line spectrum telemetry (4 Hz)...', w / 2, h / 2);
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
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    const fMin = 300.0;
    const fMax = 501.3;
    const dbMin = -45.0;
    const dbMax = 10.0;

    // Grid lines & dB ticks
    specCtx.strokeStyle = '#121d33';
    specCtx.lineWidth = 1;
    specCtx.fillStyle = '#5a7192';
    specCtx.font = '10px ui-monospace, monospace';
    specCtx.textAlign = 'right';
    specCtx.textBaseline = 'middle';

    const dbSteps = [-40, -30, -20, -10, 0, 10];
    dbSteps.forEach(db => {
      const y = padT + (1.0 - (db - dbMin) / (dbMax - dbMin)) * plotH;
      specCtx.beginPath();
      specCtx.moveTo(padL, y);
      specCtx.lineTo(padL + plotW, y);
      specCtx.stroke();
      specCtx.fillText(`${db}`, padL - 6, y);
    });

    // Frequency grid ticks
    specCtx.textAlign = 'center';
    specCtx.textBaseline = 'top';
    const fSteps = [300, 350, 400, 450, 500];
    fSteps.forEach(freq => {
      const x = padL + ((freq - fMin) / (fMax - fMin)) * plotW;
      specCtx.beginPath();
      specCtx.moveTo(x, padT);
      specCtx.lineTo(x, padT + plotH);
      specCtx.stroke();
      specCtx.fillText(`${freq} MHz`, x, padT + plotH + 6);
    });

    // Subband boundary marker at 400.65 MHz
    const subbandX = padL + ((400.65 - fMin) / (fMax - fMin)) * plotW;
    specCtx.strokeStyle = '#00e5ff';
    specCtx.setLineDash([3, 3]);
    specCtx.beginPath();
    specCtx.moveTo(subbandX, padT);
    specCtx.lineTo(subbandX, padT + plotH);
    specCtx.stroke();
    specCtx.setLineDash([]);

    // Draw spectrum lines
    activeIds.forEach(id => {
      const b = beams[id];
      if (!b.power_db || b.power_db.length === 0) return;

      const numChannels = b.power_db.length;
      const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];

      specCtx.strokeStyle = color;
      specCtx.lineWidth = 1.5;
      specCtx.beginPath();

      for (let ch = 0; ch < numChannels; ch++) {
        const x = padL + (ch / (numChannels - 1)) * plotW;
        const db = Math.max(dbMin, Math.min(dbMax, b.power_db[ch]));
        const y = padT + (1.0 - (db - dbMin) / (dbMax - dbMin)) * plotH;

        if (ch === 0) specCtx.moveTo(x, y);
        else specCtx.lineTo(x, y);
      }
      specCtx.stroke();
    });

    // Hover crosshair inspection
    if (specHover.active && specHover.x >= padL && specHover.x <= padL + plotW) {
      const normX = (specHover.x - padL) / plotW;
      const chIdx = Math.min(671, Math.max(0, Math.round(normX * 671)));
      const freqMhz = 300.0 + chIdx * 0.3;

      specCtx.strokeStyle = '#ffffff';
      specCtx.setLineDash([2, 2]);
      specCtx.beginPath();
      specCtx.moveTo(specHover.x, padT);
      specCtx.lineTo(specHover.x, padT + plotH);
      specCtx.stroke();
      specCtx.setLineDash([]);

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
    if (!waterfallCanvas || !waterfallCtx) return;
    const w = waterfallCanvas.width;
    const h = waterfallCanvas.height;

    waterfallCtx.fillStyle = '#04070d';
    waterfallCtx.fillRect(0, 0, w, h);

    if (waterfallHistory.length === 0) {
      waterfallCtx.fillStyle = '#5a7192';
      waterfallCtx.font = '11px ui-monospace, monospace';
      waterfallCtx.textAlign = 'center';
      waterfallCtx.textBaseline = 'middle';
      waterfallCtx.fillText(`Waterfall accumulating historical frames for Beam ${waterfallBeamId}...`, w / 2, h / 2);
      return;
    }

    const numRows = waterfallHistory.length;
    const numChannels = 672;
    const rowH = h / MAX_WATERFALL_ROWS;
    const colW = w / numChannels;

    const dbMin = -45.0;
    const dbMax = 15.0;

    for (let r = 0; r < numRows; r++) {
      const powers = waterfallHistory[r].power;
      const y = r * rowH;

      for (let c = 0; c < numChannels; c++) {
        const db = powers[c];
        const norm = (db - dbMin) / (dbMax - dbMin);
        const rgb = viridisColor(norm);

        waterfallCtx.fillStyle = `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
        waterfallCtx.fillRect(c * colW, y, Math.ceil(colW) + 0.5, Math.ceil(rowH) + 0.5);
      }
    }
  }

  // ==========================================================================
  // TAB 2: 16-Beam 2D Sky Grid Camera Logic & Renderers (F4.3)
  // ==========================================================================

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
    if (!gridCanvas || !gridCtx) return;
    const w = gridCanvas.width;
    const h = gridCanvas.height;

    gridCtx.fillStyle = '#060a14';
    gridCtx.fillRect(0, 0, w, h);

    if (!latestGrid) {
      gridCtx.fillStyle = '#5a7192';
      gridCtx.font = '12px ui-monospace, monospace';
      gridCtx.textAlign = 'center';
      gridCtx.textBaseline = 'middle';
      gridCtx.fillText('Awaiting 16-beam sky grid camera frames (4 Hz)...', w / 2, h / 2);
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
    drawAmplitudeMatrix();
    drawPhaseMatrix();
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
    if (!fringeCanvas || !fringeCtx || !latestCorrelator) return;
    const w = fringeCanvas.width;
    const h = fringeCanvas.height;

    fringeCtx.fillStyle = '#05080f';
    fringeCtx.fillRect(0, 0, w, h);

    const fringes = latestCorrelator.reference_fringes;
    if (!fringes || !fringes[fringeAntenna]) {
      fringeCtx.fillStyle = '#5a7192';
      fringeCtx.font = '11px ui-monospace, monospace';
      fringeCtx.textAlign = 'center';
      fringeCtx.fillText(`Awaiting fringe baseline (0, ${fringeAntenna})...`, w / 2, h / 2);
      return;
    }

    const fringe = fringes[fringeAntenna];
    const padL = 46;
    const padR = 16;
    const padT = 14;
    const padB = 26;
    const plotW = w - padL - padR;
    const plotH = h - padT - padB;

    // Grid ticks
    fringeCtx.strokeStyle = '#121d33';
    fringeCtx.lineWidth = 1;
    fringeCtx.fillStyle = '#5a7192';
    fringeCtx.font = '10px ui-monospace, monospace';

    const fSteps = [300, 350, 400, 450, 500];
    fSteps.forEach(freq => {
      const x = padL + ((freq - 300) / 201.3) * plotW;
      fringeCtx.beginPath();
      fringeCtx.moveTo(x, padT);
      fringeCtx.lineTo(x, padT + plotH);
      fringeCtx.stroke();
      fringeCtx.fillText(`${freq} MHz`, x, padT + plotH + 8);
    });

    if (fringeMode === 'ri') {
      // Real (Cyan) & Imag (Amber)
      let maxAbs = 0.01;
      for (let ch = 0; ch < 672; ch++) {
        if (Math.abs(fringe.real[ch]) > maxAbs) maxAbs = Math.abs(fringe.real[ch]);
        if (Math.abs(fringe.imag[ch]) > maxAbs) maxAbs = Math.abs(fringe.imag[ch]);
      }

      // Real
      fringeCtx.strokeStyle = '#00e5ff';
      fringeCtx.lineWidth = 1.4;
      fringeCtx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (0.5 - (fringe.real[ch] / (maxAbs * 2.1))) * plotH;
        if (ch === 0) fringeCtx.moveTo(x, y);
        else fringeCtx.lineTo(x, y);
      }
      fringeCtx.stroke();

      // Imag
      fringeCtx.strokeStyle = '#f59e0b';
      fringeCtx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (0.5 - (fringe.imag[ch] / (maxAbs * 2.1))) * plotH;
        if (ch === 0) fringeCtx.moveTo(x, y);
        else fringeCtx.lineTo(x, y);
      }
      fringeCtx.stroke();
    } else if (fringeMode === 'amp') {
      // Amplitude
      let maxAmp = 0.01;
      for (let ch = 0; ch < 672; ch++) {
        if (fringe.amplitude[ch] > maxAmp) maxAmp = fringe.amplitude[ch];
      }

      fringeCtx.strokeStyle = '#10b981';
      fringeCtx.lineWidth = 1.6;
      fringeCtx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (1.0 - (fringe.amplitude[ch] / maxAmp)) * plotH;
        if (ch === 0) fringeCtx.moveTo(x, y);
        else fringeCtx.lineTo(x, y);
      }
      fringeCtx.stroke();
    } else if (fringeMode === 'phase') {
      // Phase (-pi to +pi)
      fringeCtx.strokeStyle = '#d500f9';
      fringeCtx.lineWidth = 1.4;
      fringeCtx.beginPath();
      for (let ch = 0; ch < 672; ch++) {
        const x = padL + (ch / 671) * plotW;
        const y = padT + (1.0 - (fringe.phase_rad[ch] + Math.PI) / (2 * Math.PI)) * plotH;
        if (ch === 0) fringeCtx.moveTo(x, y);
        else fringeCtx.lineTo(x, y);
      }
      fringeCtx.stroke();
    }
  }

  // ==========================================================================
  // TAB 4: 8x8 Physical Array Health & Masking Logic (F4.5)
  // ==========================================================================

  function renderArrayGrid() {
    if (!arrayGrid8x8) return;
    const antennas = (latestAntennaMask && latestAntennaMask.antennas && latestAntennaMask.antennas.length === 64)
      ? latestAntennaMask.antennas
      : null;

    arrayGrid8x8.innerHTML = '';

    for (let id = 0; id < 64; id++) {
      const item = antennas ? antennas[id] : null;
      const isEnabled = item ? item.enabled : true;
      const statusRaw = item ? item.status : 'nominal';
      const powerRms = item ? item.power_rms.toFixed(2) : '8.10';
      const clipPct = item ? (item.clip_fraction * 100).toFixed(2) : '0.01';
      const kurt = item ? item.kurtosis.toFixed(2) : '3.00';

      // Status class mapping
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
        tagLabel = 'SATURATED';
      } else if (statusRaw === 'high_clip') {
        statusClass = 'status-high-clip';
        tagLabel = 'CLIP';
      }

      const card = document.createElement('div');
      card.className = `antenna-card ${statusClass}`;
      card.title = `Antenna ${id}: Click to toggle enable / mask`;

      card.innerHTML = `
        <div class="antenna-card-header">
          <span class="ant-id">#${String(id).padStart(2, '0')}</span>
          <span class="ant-status-tag">${tagLabel}</span>
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
          <div class="ant-metric-row">
            <span>Kurt:</span>
            <span class="ant-metric-val">${kurt}</span>
          </div>
        </div>
      `;

      card.addEventListener('click', async () => {
        try {
          const nextState = !isEnabled;
          const res = await fetch('/api/antennas/mask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ antenna_id: id, enabled: nextState })
          });
          const reply = await res.json();
          if (res.ok) {
            showToast(`Antenna ${id} ${nextState ? 'unmasked (enabled)' : 'masked'}`);
            // Optimistic update
            if (item) item.enabled = nextState;
            renderArrayGrid();
          } else {
            showToast(reply.detail || 'Failed to toggle antenna', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
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

    // Unmask All Button
    if (btnUnmaskAll) {
      btnUnmaskAll.addEventListener('click', async () => {
        if (!latestAntennaMask || !latestAntennaMask.antennas) return;
        const masked = latestAntennaMask.antennas.filter(a => !a.enabled);
        if (masked.length === 0) {
          showToast('All antennas are already active');
          return;
        }

        try {
          await Promise.all(masked.map(a =>
            fetch('/api/antennas/mask', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ antenna_id: a.antenna_id, enabled: true })
            })
          ));
          showToast(`Unmasked ${masked.length} antennas`);
          masked.forEach(a => { a.enabled = true; });
          renderArrayGrid();
        } catch (err) {
          showToast(err.message, true);
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
