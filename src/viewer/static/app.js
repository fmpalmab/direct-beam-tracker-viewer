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

  const RFI_FLAG_DEFS = [
    { bit: 1 << 0, label: 'SK_IMP', cls: '' },
    { bit: 1 << 1, label: 'SK_CW', cls: '' },
    { bit: 1 << 2, label: 'BURST', cls: 'burst' },
    { bit: 1 << 3, label: 'FREQ_MAD', cls: 'burst' },
    { bit: 1 << 4, label: 'NOTCH', cls: 'notch' },
    { bit: 1 << 5, label: 'SAT_CLIP', cls: '' },
    { bit: 1 << 6, label: 'SIR', cls: 'burst' }
  ];

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
  let latestRfiStatus = null;
  let latestRfiChannels = null;
  let latestSefd = null;
  let latestAntennaMask = null;
  let cachedAntennaSpectra = {};

  // Tab 1 (Tracker) State
  let selectedBeamId = 0;
  let beamTrails = {};
  let specViewMode = 'all';
  let trackerSpecMode = 'overlay'; // 'overlay' | 'small-mult'
  let specHover = { active: false, cssX: 0, cssY: 0 };
  let waterfallHistoriesByBeam = {};
  let waterfallFilterMode = 'all';
  const MAX_WATERFALL_ROWS = 90;

  // Tab 2 (RFI Mitigation) State
  let rfiMetricMode = 'combined'; // 'combined' | 'power' | 'sk' | 'mad'
  let rfiHover = { active: false, cssX: 0 };
  let rfiFormDirty = false;

  // Tab 3 (SEFD & Calibration) State
  let calTaperDirty = false;

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

  // Tab 2 (RFI)
  const rfiStageBadge = document.getElementById('rfi-stage-badge');
  const rfiBlankingBadge = document.getElementById('rfi-blanking-badge');
  const rfiFlaggedCount = document.getElementById('rfi-flagged-count');
  const rfiOverallPct = document.getElementById('rfi-overall-pct');
  const rfiNotchesCount = document.getElementById('rfi-notches-count');
  const rfiSpectrumCanvas = document.getElementById('rfi-spectrum-canvas');
  const rfiHoverReadout = document.getElementById('rfi-hover-readout');
  const rfiTopTbody = document.getElementById('rfi-top-tbody');
  const rfiTopSummary = document.getElementById('rfi-top-summary');
  const formRfiConfig = document.getElementById('form-rfi-config');
  const btnRfiApplyConfig = document.getElementById('btn-rfi-apply-config');
  const btnRfiResetEma = document.getElementById('btn-rfi-reset-ema');
  const btnRfiPrewhiten = document.getElementById('btn-rfi-prewhiten');

  // Tab 3 (SEFD & Calibration)
  const sefdNAlive = document.getElementById('sefd-n-alive');
  const sefdSourceTag = document.getElementById('sefd-source-tag');
  const sefdQuantSigma = document.getElementById('sefd-quant-sigma');
  const sefdOptWindowBadge = document.getElementById('sefd-opt-window-badge');
  const sefdQuantQrms = document.getElementById('sefd-quant-qrms');
  const sefdEtaQ = document.getElementById('sefd-eta-q');
  const sefdMeanPwr = document.getElementById('sefd-mean-pwr');
  const sefdCleanBw = document.getElementById('sefd-clean-bw');
  const sefdRfiFrac = document.getElementById('sefd-rfi-frac');
  const sefdArrayZenith = document.getElementById('sefd-array-zenith');
  const sefdSigmaS = document.getElementById('sefd-sigma-s');
  const sefdFluenceMin = document.getElementById('sefd-fluence-min');
  const sefdLstReadout = document.getElementById('sefd-lst-readout');
  const sefdBeamTbody = document.getElementById('sefd-beam-tbody');
  const calGainsGen = document.getElementById('cal-gains-gen');
  const calCurrentFile = document.getElementById('cal-current-file');
  const calGlobalToggle = document.getElementById('cal-global-toggle');
  const calGainsInput = document.getElementById('cal-gains-input');
  const calZeroFlagged = document.getElementById('cal-zero-flagged');
  const calSyncNotches = document.getElementById('cal-sync-notches');
  const formReloadGains = document.getElementById('form-reload-gains');
  const formTaperConfig = document.getElementById('form-taper-config');
  const taperTypeSelect = document.getElementById('taper-type-select');
  const taperPedestalInput = document.getElementById('taper-pedestal-input');
  const taperBislcLoading = document.getElementById('taper-bislc-loading');
  const taperNormalizeWeights = document.getElementById('taper-normalize-weights');
  const taperWeightBislc = document.getElementById('taper-weight-bislc');

  // Tab 4 (Array)
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

  function viridisColor(val) {
    const t = Math.max(0, Math.min(1, val));
    const r = Math.round(255 * Math.max(0, Math.min(1, 0.267 + t * (-0.005 + t * (1.38 + t * (-2.12 + t * 1.47))))));
    const g = Math.round(255 * Math.max(0, Math.min(1, 0.004 + t * (1.02 + t * (0.14 - t * 0.26)))));
    const b = Math.round(255 * Math.max(0, Math.min(1, 0.329 + t * (1.42 + t * (-2.42 + t * 0.81)))));
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
    } else if (activeTab === 'tab-rfi') {
      drawRfiSpectrum();
    } else if (activeTab === 'tab-sefd') {
      if (latestSefd) renderSefdSummary(latestSefd);
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
    } else if (msg.type === 'rfi') {
      handleRfiUpdate(msg.data || msg);
    } else if (msg.type === 'sefd') {
      handleSefdUpdate(msg.data || msg);
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
        const [resStatus, resSpec, resRfi, resRfiCh] = await Promise.all([
          fetch('/api/status').catch(() => null),
          fetch('/api/spectrometer').catch(() => null),
          fetch('/api/rfi').catch(() => null),
          fetch('/api/rfi/channels').catch(() => null)
        ]);
        if (resStatus && resStatus.ok) {
          handleStatusUpdate(await resStatus.json());
          setConnectionState('fallback', 'Polling (REST)');
        } else {
          setConnectionState('disconnected', 'Disconnected');
        }
        if (resSpec && resSpec.ok) handleSpectrometerUpdate(await resSpec.json());
        if (resRfi && resRfi.ok) {
          const st = await resRfi.json();
          const ch = (resRfiCh && resRfiCh.ok) ? await resRfiCh.json() : latestRfiChannels;
          handleRfiUpdate({ status: st, channels: ch });
        }
      } catch (e) {
        setConnectionState('disconnected', 'Disconnected');
      }
    }, 1000);

    pollTimerSlow = setInterval(async () => {
      try {
        const [resSefd, resMask, resRoutine] = await Promise.all([
          fetch('/api/sefd').catch(() => null),
          fetch('/api/antenna_mask').catch(() => null),
          fetch('/api/routine').catch(() => null)
        ]);
        if (resSefd && resSefd.ok) handleSefdUpdate(await resSefd.json());
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
    const maxBeams = status.max_beams || 16;
    if (activeBeamsSummary) activeBeamsSummary.textContent = `${activeBeams} / ${maxBeams}`;

    const activeAnts = status.active_antennas !== undefined ? status.active_antennas : 64;
    if (activeElementsSummary) activeElementsSummary.textContent = `${activeAnts} / 64`;

    if (numBeamsSelect && document.activeElement !== numBeamsSelect) {
      numBeamsSelect.value = activeBeams;
    }
    if (interpToggle) {
      interpToggle.checked = !!status.subframe_interpolation_enabled;
    }
    if (sefdLstReadout && status.current_lst_hours !== null && status.current_lst_hours !== undefined) {
      sefdLstReadout.textContent = `LST: ${status.current_lst_hours.toFixed(3)} h`;
    }

    syncCalTaperControls(status);
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

  function handleRfiUpdate(payload) {
    if (!payload) return;
    const status = payload.status ? payload.status : (payload.enabled !== undefined ? payload : null);
    const channels = payload.channels ? payload.channels : null;

    if (status) latestRfiStatus = status;
    if (channels) latestRfiChannels = channels;

    if (latestRfiStatus) {
      if (rfiStageBadge) {
        rfiStageBadge.textContent = latestRfiStatus.enabled ? 'ENABLED' : 'BYPASSED';
        rfiStageBadge.className = `metric-val monospace ${latestRfiStatus.enabled ? 'success' : 'warning'}`;
      }
      if (rfiBlankingBadge) {
        rfiBlankingBadge.textContent = latestRfiStatus.blank_voltages_enabled ? 'IN-PLACE' : 'SHADOW';
      }
      if (rfiFlaggedCount) {
        rfiFlaggedCount.textContent = `${latestRfiStatus.flagged_channels} / ${latestRfiStatus.total_channels || 672}`;
      }
      if (rfiOverallPct) {
        rfiOverallPct.textContent = `${((latestRfiStatus.overall_flagged_chunk_fraction || 0) * 100).toFixed(2)}%`;
      }
      const nNotches = (latestRfiStatus.static_notch_bands_mhz || []).length;
      if (rfiNotchesCount) {
        rfiNotchesCount.textContent = `${nNotches} band${nNotches === 1 ? '' : 's'}`;
      }

      populateRfiControls(latestRfiStatus);
      renderRfiTopTable(latestRfiStatus.top_rfi_channels || []);
    }

    if (activeTab === 'tab-rfi') {
      requestAnimationFrame(drawRfiSpectrum);
    }
  }

  function handleSefdUpdate(sefd) {
    if (!sefd) return;
    latestSefd = sefd;
    renderSefdSummary(sefd);
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
      refreshSelectedAntennaSpectrum();
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
  // TAB 2: Real-Time RFI Mitigation (cudaRfiMitigationCommand)
  // ==========================================================================
  function decodeFlagBitsHtml(bits) {
    if (!bits) return '<span class="badge badge-xs status-nominal-badge">CLEAN</span>';
    const badges = [];
    RFI_FLAG_DEFS.forEach(def => {
      if ((bits & def.bit) !== 0) {
        badges.push(`<span class="rfi-flag-badge ${def.cls}">${def.label}</span>`);
      }
    });
    return badges.length > 0 ? badges.join('') : `<span class="rfi-flag-badge">0x${bits.toString(16)}</span>`;
  }

  function decodeFlagBitsText(bits) {
    if (!bits) return 'CLEAN';
    const names = [];
    RFI_FLAG_DEFS.forEach(def => {
      if ((bits & def.bit) !== 0) names.push(def.label);
    });
    return names.length > 0 ? names.join('|') : `0x${bits.toString(16)}`;
  }

  function populateRfiControls(st) {
    if (!st || rfiFormDirty) return;
    const active = document.activeElement;
    if (formRfiConfig && active && formRfiConfig.contains(active)) return;

    const setCheck = (id, val) => {
      const el = document.getElementById(id);
      if (el) el.checked = !!val;
    };
    const setVal = (id, val) => {
      const el = document.getElementById(id);
      if (el && val !== undefined && val !== null) el.value = val;
    };

    setCheck('rfi-cfg-enabled', st.enabled);
    setCheck('rfi-cfg-blank', st.blank_voltages_enabled);
    setCheck('rfi-cfg-sk', st.enable_sk_check);
    setCheck('rfi-cfg-burst', st.enable_time_burst_check);
    setCheck('rfi-cfg-mad', st.enable_freq_mad_check);
    setCheck('rfi-cfg-sat', st.enable_saturation_check);
    setCheck('rfi-cfg-sir', st.enable_morphology_sir);
    setCheck('rfi-cfg-ema', st.enable_persistent_ema);

    setVal('rfi-cfg-sk-thresh', st.sk_sigma_threshold);
    setVal('rfi-cfg-burst-thresh', st.burst_sigma_threshold);
    setVal('rfi-cfg-mad-thresh', st.mad_sigma_threshold);
    setVal('rfi-cfg-win-half', st.freq_window_half_width);
    setVal('rfi-cfg-sat-thresh', st.saturation_fraction_threshold);
    setVal('rfi-cfg-ema-alpha', st.ema_alpha);
    setVal('rfi-cfg-edge-ignore', st.edge_channels_to_ignore);

    const notchStr = (st.static_notch_bands_mhz || [])
      .map(pair => `${Number(pair[0]).toFixed(1)}-${Number(pair[1]).toFixed(1)}`)
      .join(', ');
    setVal('rfi-cfg-notches', notchStr);
  }

  function parseNotchBandsInput(raw) {
    const text = (raw || '').trim();
    if (!text) return [];
    const bands = [];
    text.split(',').forEach(part => {
      const clean = part.trim();
      if (!clean) return;
      const pieces = clean.split('-').map(s => parseFloat(s.trim()));
      if (pieces.length === 2 && !isNaN(pieces[0]) && !isNaN(pieces[1])) {
        bands.push([Math.min(pieces[0], pieces[1]), Math.max(pieces[0], pieces[1])]);
      }
    });
    return bands;
  }

  function renderRfiTopTable(topList) {
    if (!rfiTopTbody) return;
    if (rfiTopSummary) {
      rfiTopSummary.textContent = `${topList.length} top flagged channel${topList.length === 1 ? '' : 's'}`;
    }
    if (!topList || topList.length === 0) {
      rfiTopTbody.innerHTML = '<tr><td colspan="8" class="empty-state">No flagged RFI channels in current frame</td></tr>';
      return;
    }

    rfiTopTbody.innerHTML = '';
    topList.forEach(ch => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><strong>${ch.freq_mhz.toFixed(3)}</strong></td>
        <td>${ch.mean_power.toFixed(3)}</td>
        <td>${ch.mean_sk.toFixed(3)}</td>
        <td>${ch.max_sk.toFixed(3)}</td>
        <td>${ch.freq_mad_z.toFixed(2)}</td>
        <td><strong>${(ch.flagged_chunk_fraction * 100).toFixed(1)}%</strong></td>
        <td>${decodeFlagBitsHtml(ch.flag_bits)}</td>
        <td><button class="btn btn-xs btn-outline btn-reset-ch-ema" data-freq="${ch.freq_mhz}">Reset EMA</button></td>
      `;
      const btn = tr.querySelector('.btn-reset-ch-ema');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          resetRfiEma([ch.freq_mhz]);
        });
      }
      rfiTopTbody.appendChild(tr);
    });
  }

  function drawRfiSpectrum() {
    const setup = resizeHiDPICanvas(rfiSpectrumCanvas);
    if (!setup) return;
    const { ctx, width, height } = setup;

    ctx.fillStyle = '#05080f';
    ctx.fillRect(0, 0, width, height);

    const channels = latestRfiChannels && latestRfiChannels.channels ? latestRfiChannels.channels : [];
    if (channels.length === 0) {
      ctx.fillStyle = '#5a7192';
      ctx.font = '12px ui-monospace, monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Awaiting 672-channel RFI diagnostics from cudaRfiMitigationCommand...', width / 2, height / 2);
      return;
    }

    const padL = 48, padR = 44, padT = 16, padB = 26;
    const plotW = Math.max(10, width - padL - padR);
    const plotH = Math.max(10, height - padT - padB);
    const fMin = 300.0;
    const fMax = 501.3;
    const n = channels.length;

    const xForFreq = (f) => padL + ((f - fMin) / (fMax - fMin)) * plotW;

    // 1. Static Notch Shaded Spans
    const notches = (latestRfiStatus && latestRfiStatus.static_notch_bands_mhz) || [];
    notches.forEach(pair => {
      if (pair.length < 2) return;
      const x0 = Math.max(padL, xForFreq(pair[0]));
      const x1 = Math.min(padL + plotW, xForFreq(pair[1]));
      if (x1 > x0) {
        ctx.fillStyle = 'rgba(168, 85, 247, 0.14)';
        ctx.fillRect(x0, padT, x1 - x0, plotH);
      }
    });

    // 2. Dynamic Flagged Channel Highlight Bars
    const colW = Math.max(1.2, plotW / n);
    channels.forEach((ch) => {
      if (ch.flag_bits !== 0 && (ch.flag_bits & (1 << 4)) === 0) {
        const cx = xForFreq(ch.freq_mhz);
        ctx.fillStyle = 'rgba(239, 68, 68, 0.22)';
        ctx.fillRect(cx - colW * 0.5, padT, colW, plotH);
      }
    });

    // 3. Grid Lines
    ctx.strokeStyle = '#141d2e';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#64748b';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    [300, 350, 400.8, 450, 500].forEach(freq => {
      const x = xForFreq(freq);
      const isSplit = Math.abs(freq - 400.8) < 0.1;
      ctx.strokeStyle = isSplit ? 'rgba(0, 229, 255, 0.45)' : '#141d2e';
      if (isSplit) ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = isSplit ? '#00e5ff' : '#64748b';
      ctx.fillText(`${freq}`, x, padT + plotH + 6);
    });

    // Compute value ranges
    const powers = channels.map(c => c.mean_power);
    const sks = channels.map(c => c.mean_sk);
    const mads = channels.map(c => c.freq_mad_z);

    const drawSeries = (vals, minVal, maxVal, color, lineW) => {
      const span = Math.max(1e-3, maxVal - minVal);
      ctx.strokeStyle = color;
      ctx.lineWidth = lineW;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = xForFreq(channels[i].freq_mhz);
        const clamped = Math.max(minVal, Math.min(maxVal, vals[i]));
        const y = padT + (1.0 - (clamped - minVal) / span) * plotH;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    const drawLeftAxis = (minVal, maxVal, label) => {
      ctx.fillStyle = '#00e5ff';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.font = '9.5px ui-monospace, monospace';
      for (let k = 0; k <= 4; k++) {
        const v = minVal + (k / 4) * (maxVal - minVal);
        const y = padT + (1.0 - k / 4) * plotH;
        ctx.fillText(v.toFixed(1), padL - 5, y);
      }
      ctx.textAlign = 'left';
      ctx.fillText(label, padL + 4, padT + 8);
    };

    const pMax = Math.max(5.0, Math.min(40.0, Math.max(...powers) * 1.1));
    if (rfiMetricMode === 'power') {
      drawLeftAxis(0.0, pMax, 'Mean Power (LSB²)');
      drawSeries(powers, 0.0, pMax, '#00e5ff', 1.6);
    } else if (rfiMetricMode === 'sk') {
      const skMax = Math.max(2.5, Math.min(10.0, Math.max(...sks) * 1.1));
      drawLeftAxis(0.0, skMax, 'Spectral Kurtosis (SK)');
      drawSeries(sks, 0.0, skMax, '#f59e0b', 1.6);
    } else if (rfiMetricMode === 'mad') {
      const madMax = Math.max(8.0, Math.min(30.0, Math.max(...mads.map(Math.abs)) * 1.1));
      drawLeftAxis(-4.0, madMax, 'Freq MAD Z-Score');
      drawSeries(mads, -4.0, madMax, '#a855f7', 1.6);
    } else {
      // Combined: Power (left axis, cyan) + SK (right axis, amber)
      drawLeftAxis(0.0, pMax, 'Power (LSB²)');
      drawSeries(powers, 0.0, pMax, '#00e5ff', 1.5);

      const skMax = 4.0;
      drawSeries(sks, 0.0, skMax, '#f59e0b', 1.2);
      ctx.fillStyle = '#f59e0b';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.font = '9.5px ui-monospace, monospace';
      for (let k = 0; k <= 4; k++) {
        const v = (k / 4) * skMax;
        const y = padT + (1.0 - k / 4) * plotH;
        ctx.fillText(`SK ${v.toFixed(1)}`, padL + plotW + 5, y);
      }
    }

    if (rfiHover.active && rfiHover.cssX >= padL && rfiHover.cssX <= padL + plotW) {
      const normX = (rfiHover.cssX - padL) / plotW;
      const targetFreq = fMin + normX * (fMax - fMin);
      let best = channels[0];
      let bestDist = Infinity;
      for (let i = 0; i < n; i++) {
        const d = Math.abs(channels[i].freq_mhz - targetFreq);
        if (d < bestDist) { bestDist = d; best = channels[i]; }
      }
      ctx.strokeStyle = '#ffffff';
      ctx.setLineDash([2, 2]);
      ctx.beginPath();
      ctx.moveTo(rfiHover.cssX, padT);
      ctx.lineTo(rfiHover.cssX, padT + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
      if (rfiHoverReadout && best) {
        rfiHoverReadout.textContent =
          `${best.freq_mhz.toFixed(2)} MHz (SB${best.subband} Ch ${best.local_channel}) | Pwr=${best.mean_power.toFixed(2)} LSB² | SK=${best.mean_sk.toFixed(2)} (max ${best.max_sk.toFixed(2)}) | MAD_Z=${best.freq_mad_z.toFixed(2)} | Flag=${(best.flagged_chunk_fraction * 100).toFixed(0)}% [${decodeFlagBitsText(best.flag_bits)}]`;
      }
    }
  }

  async function applyRfiConfig() {
    const payload = {
      enabled: !!document.getElementById('rfi-cfg-enabled')?.checked,
      blank_voltages_enabled: !!document.getElementById('rfi-cfg-blank')?.checked,
      enable_sk_check: !!document.getElementById('rfi-cfg-sk')?.checked,
      sk_sigma_threshold: parseFloat(document.getElementById('rfi-cfg-sk-thresh')?.value || '4.5'),
      enable_time_burst_check: !!document.getElementById('rfi-cfg-burst')?.checked,
      burst_sigma_threshold: parseFloat(document.getElementById('rfi-cfg-burst-thresh')?.value || '5.0'),
      enable_freq_mad_check: !!document.getElementById('rfi-cfg-mad')?.checked,
      mad_sigma_threshold: parseFloat(document.getElementById('rfi-cfg-mad-thresh')?.value || '6.0'),
      freq_window_half_width: parseInt(document.getElementById('rfi-cfg-win-half')?.value || '8', 10),
      enable_saturation_check: !!document.getElementById('rfi-cfg-sat')?.checked,
      saturation_fraction_threshold: parseFloat(document.getElementById('rfi-cfg-sat-thresh')?.value || '0.02'),
      enable_morphology_sir: !!document.getElementById('rfi-cfg-sir')?.checked,
      enable_persistent_ema: !!document.getElementById('rfi-cfg-ema')?.checked,
      ema_alpha: parseFloat(document.getElementById('rfi-cfg-ema-alpha')?.value || '0.02'),
      edge_channels_to_ignore: parseInt(document.getElementById('rfi-cfg-edge-ignore')?.value || '0', 10),
      static_notch_bands_mhz: parseNotchBandsInput(document.getElementById('rfi-cfg-notches')?.value)
    };
    try {
      const res = await fetch('/api/rfi/configure', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const reply = await res.json();
      if (res.ok) {
        rfiFormDirty = false;
        showToast(reply.message || 'RFI configuration updated');
      } else {
        showToast(reply.detail || 'Failed to update RFI configuration', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function resetRfiEma(freqsMhz = null) {
    const payload = (freqsMhz && freqsMhz.length > 0)
      ? { freq_mhz: freqsMhz, all: false }
      : { all: true };
    try {
      const res = await fetch('/api/rfi/reset_ema', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const reply = await res.json();
      if (res.ok) {
        const msg = freqsMhz ? `Reset EMA baseline for ${freqsMhz.join(', ')} MHz` : 'Reset all RFI EMA baselines';
        showToast(msg);
      } else {
        showToast(reply.detail || 'Failed to reset EMA', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  async function pushPrewhiteningGains() {
    try {
      const res = await fetch('/api/rfi/prewhiten', { method: 'POST' });
      const reply = await res.json();
      if (res.ok) {
        showToast(`Pre-whitening gains pushed (${reply.subbands_updated || 1} subbands)`);
      } else {
        showToast(reply.detail || 'Failed to push pre-whitening gains', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ==========================================================================
  // TAB 3: SEFD, Sensitivity & Calibration Renderers
  // ==========================================================================
  function renderSefdSummary(sefd) {
    if (!sefd) return;
    if (sefdNAlive) sefdNAlive.textContent = `${sefd.n_alive} / 64`;
    if (sefdSourceTag) sefdSourceTag.textContent = `Model: ${sefd.source || 'analytical'}`;
    if (sefdQuantSigma) sefdQuantSigma.textContent = `${sefd.quantizer_sigma_lsb.toFixed(3)} LSB`;
    if (sefdQuantQrms) sefdQuantQrms.textContent = `q_rms: ${sefd.quantizer_q_rms.toFixed(2)}`;
    if (sefdOptWindowBadge) {
      sefdOptWindowBadge.textContent = sefd.in_optimal_window ? 'OPTIMAL [0.93–2.64]' : 'OUT OF WINDOW';
      sefdOptWindowBadge.className = `badge badge-xs ${sefd.in_optimal_window ? 'status-nominal-badge' : 'status-clip-badge'}`;
    }
    if (sefdEtaQ) sefdEtaQ.textContent = sefd.quantizer_eta_q.toFixed(4);
    if (sefdMeanPwr) sefdMeanPwr.textContent = `Mean Power: ${sefd.mean_power_lsb2.toFixed(2)} LSB²`;
    if (sefdCleanBw) sefdCleanBw.textContent = `${sefd.clean_bandwidth_mhz.toFixed(1)} MHz`;
    if (sefdRfiFrac) sefdRfiFrac.textContent = `RFI Flagged: ${(sefd.rfi_flagged_fraction * 100).toFixed(2)}% of ${sefd.total_bandwidth_mhz.toFixed(1)} MHz`;
    if (sefdArrayZenith) sefdArrayZenith.textContent = `${(sefd.array_zenith_sefd_jy / 1000.0).toFixed(2)} kJy`;
    if (sefdSigmaS) sefdSigmaS.textContent = `${sefd.array_sigma_s_1s_jy.toFixed(2)} Jy`;
    if (sefdFluenceMin) sefdFluenceMin.textContent = `10σ 1ms F_min: ${sefd.array_fluence_min_1ms_jy_ms.toFixed(0)} Jy ms`;

    if (!sefdBeamTbody) return;
    const beams = sefd.beams || [];
    if (beams.length === 0) {
      sefdBeamTbody.innerHTML = '<tr><td colspan="10" class="empty-state">No active tracked beams</td></tr>';
      return;
    }

    sefdBeamTbody.innerHTML = '';
    beams.forEach(b => {
      const tr = document.createElement('tr');
      const color = BEAM_COLORS[b.beam_id % BEAM_COLORS.length];
      const name = beamName(b.beam_id) || b.label || `Beam ${b.beam_id}`;
      const sefdKjy = b.sefd_beam_jy > 0 ? (b.sefd_beam_jy / 1000.0).toFixed(2) : '--';
      const sigS = b.sigma_s_1s_jy > 0 ? b.sigma_s_1s_jy.toFixed(2) : '--';
      const fMin = b.fluence_min_1ms_jy_ms > 0 ? b.fluence_min_1ms_jy_ms.toFixed(0) : '--';

      tr.innerHTML = `
        <td style="color: ${color}; font-weight: 700;">● #${b.beam_id}</td>
        <td><strong>${name}</strong></td>
        <td>(${b.l0.toFixed(3)}, ${b.m0.toFixed(3)}, ${b.n0.toFixed(3)})</td>
        <td>${b.az_deg.toFixed(1)}° / ${b.alt_deg.toFixed(1)}°</td>
        <td>${b.element_response.toFixed(3)}</td>
        <td><strong class="highlight">${sefdKjy}</strong></td>
        <td>${sigS}</td>
        <td>${fMin}</td>
        <td><span class="badge badge-xs ${b.calibrated ? 'status-nominal-badge' : 'status-clip-badge'}">${b.calibrated ? 'CAL' : 'UNCAL'}</span></td>
        <td><button class="btn btn-xs btn-outline btn-toggle-beam-cal" data-beam="${b.beam_id}" data-cal="${b.calibrated}">${b.calibrated ? 'Disable' : 'Enable'}</button></td>
      `;
      const btn = tr.querySelector('.btn-toggle-beam-cal');
      if (btn) {
        btn.addEventListener('click', (e) => {
          e.stopPropagation();
          toggleBeamCalibration(b.beam_id, !b.calibrated);
        });
      }
      sefdBeamTbody.appendChild(tr);
    });
  }

  function syncCalTaperControls(status) {
    if (!status) return;
    if (calCurrentFile && status.gains_file) {
      calCurrentFile.textContent = status.gains_file;
    }
    if (calGainsGen && status.gains_generation !== null && status.gains_generation !== undefined) {
      calGainsGen.textContent = `Gen: ${status.gains_generation}`;
    }
    if (calGainsInput && status.gains_file && !calGainsInput.value && document.activeElement !== calGainsInput) {
      calGainsInput.value = status.gains_file;
    }
    if (calGlobalToggle && status.apply_calibration_gains !== null && status.apply_calibration_gains !== undefined) {
      calGlobalToggle.checked = !!status.apply_calibration_gains;
    }
    if (calTaperDirty) return;
    const active = document.activeElement;
    if (formTaperConfig && active && formTaperConfig.contains(active)) return;

    if (taperTypeSelect && status.taper_type) taperTypeSelect.value = status.taper_type;
    if (taperPedestalInput && status.taper_pedestal !== null && status.taper_pedestal !== undefined) {
      taperPedestalInput.value = status.taper_pedestal;
    }
    if (taperNormalizeWeights && status.normalize_weights !== null && status.normalize_weights !== undefined) {
      taperNormalizeWeights.checked = !!status.normalize_weights;
    }
    if (taperWeightBislc && status.enable_weight_bislc !== null && status.enable_weight_bislc !== undefined) {
      taperWeightBislc.checked = !!status.enable_weight_bislc;
    }
    if (taperBislcLoading && status.bislc_diagonal_loading !== null && status.bislc_diagonal_loading !== undefined) {
      taperBislcLoading.value = status.bislc_diagonal_loading;
    }
  }

  async function toggleBeamCalibration(beamId, enabled) {
    try {
      const payload = beamId === null ? { enabled } : { beam_id: beamId, enabled };
      const res = await fetch('/api/calibration/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const reply = await res.json();
      if (res.ok) {
        showToast(reply.message || 'Calibration toggle updated');
      } else {
        showToast(reply.detail || 'Failed to toggle calibration', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  }

  // ==========================================================================
  // TAB 4: 8x8 Physical Array Health & HiDPI Masking Matrix
  // ==========================================================================
  async function refreshSelectedAntennaSpectrum() {
    try {
      const res = await fetch(`/api/antennas/${selectedAntennaId}/spectrum`);
      if (res.ok) {
        const data = await res.json();
        if (data && data.spectrum_db && data.spectrum_db.length > 0) {
          cachedAntennaSpectra[selectedAntennaId] = data.spectrum_db;
          if (activeTab === 'tab-array') {
            requestAnimationFrame(drawMasterAntennaSpectrometer);
          }
        }
      }
    } catch (e) {
      // Fall back to 84-bin spectrum attached to AntennaMaskStatus
    }
  }

  function getAntennaSpectrum(antId, preferFull = false) {
    if (preferFull && cachedAntennaSpectra[antId] && cachedAntennaSpectra[antId].length > 0) {
      return cachedAntennaSpectra[antId];
    }
    const antennas = (latestAntennaMask && latestAntennaMask.antennas) ? latestAntennaMask.antennas : null;
    const item = antennas ? antennas[antId] : null;
    if (item && item.spectrum_db && item.spectrum_db.length > 0) {
      return item.spectrum_db;
    }
    const syn = [];
    for (let i = 0; i < 84; i++) {
      syn.push(4.8 + 1.5 * Math.sin((i / 84) * 3 * Math.PI) + Math.sin(i * 0.4 + antId) * 0.3);
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

    const spectrum = getAntennaSpectrum(selectedAntennaId, true);
    const nPoints = spectrum.length;
    let minDb = 100, maxDb = -100, sumDb = 0, peakIdx = 0;
    for (let i = 0; i < nPoints; i++) {
      const v = spectrum[i];
      if (v > maxDb) { maxDb = v; peakIdx = i; }
      if (v < minDb) minDb = v;
      sumDb += v;
    }
    const peakFreq = 300.0 + (peakIdx / Math.max(1, nPoints - 1)) * 201.3;
    const meanDb = nPoints > 0 ? (sumDb / nPoints) : 0;

    if (antMasterTitle) antMasterTitle.textContent = `Antenna #${String(selectedAntennaId).padStart(2, '0')} Live Line Spectrometer (${nPoints}-Ch)`;
    if (antMasterTile) antMasterTile.textContent = `Physical Tile: Row ${row}, Col ${col}`;
    if (antMasterBadge) {
      antMasterBadge.textContent = isEnabled ? 'NOMINAL (ACTIVE)' : 'MASKED (BLANKED)';
      antMasterBadge.className = `badge ${isEnabled ? 'status-nominal-badge' : 'status-masked-badge'}`;
    }
    if (antMasterPeak) antMasterPeak.textContent = `${maxDb.toFixed(1)} dB @ ${peakFreq.toFixed(1)} MHz`;
    if (antMasterMean) antMasterMean.textContent = `${meanDb.toFixed(1)} dB`;
    if (antMasterRms) antMasterRms.textContent = `${item ? item.power_rms.toFixed(2) : '--'} LSB²`;
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
    const yMax = Math.max(15, Math.ceil(maxDb / 5) * 5 + 5);
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
    [300, 350, 400.8, 450, 501.3].forEach(f => {
      const x = padL + ((f - 300.0) / 201.3) * plotW;
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
      const powerRms = ant.power_rms !== undefined ? ant.power_rms : 3.1;
      const clipPct = ((ant.clip_fraction || 0) * 100).toFixed(2);

      ctx.fillStyle = isMasked ? '#110d1b' : '#0e1628';
      ctx.fillRect(x, y, w, h);

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

      ctx.strokeStyle = isSelected
        ? '#00e5ff'
        : isHovered
          ? 'rgba(0, 229, 255, 0.6)'
          : isMasked
            ? 'rgba(99, 102, 241, 0.35)'
            : 'rgba(255, 255, 255, 0.1)';
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      ctx.fillStyle = isMasked ? '#a5b4fc' : '#ffffff';
      ctx.font = '700 11px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(`#${String(idx).padStart(2, '0')}`, x + 7, y + 5);

      ctx.fillStyle = accentColor;
      ctx.font = '700 9px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'right';
      ctx.fillText(badgeText, x + w - 5, y + 6);

      const specTop = y + 20;
      const specH = Math.max(14, h - 38);
      const specLeft = x + 6;
      const specW = w - 12;

      ctx.fillStyle = '#060913';
      ctx.fillRect(specLeft, specTop, specW, specH);

      if (!isMasked) {
        const spec = (ant.spectrum_db && ant.spectrum_db.length > 0) ? ant.spectrum_db : null;
        if (spec && spec.length > 1) {
          let sMin = 0, sMax = 12;
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

      ctx.fillStyle = '#8fa5c2';
      ctx.font = '9.5px ui-monospace, SFMono-Regular, monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'bottom';
      ctx.fillText(`Pwr ${powerRms.toFixed(1)}`, x + 7, y + h - 4);

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
    let minV = 0, maxV = 12;
    for (const v of spec) {
      if (v < minV) minV = v;
      if (v > maxV) maxV = v;
    }
    const range = Math.max(6, maxV - minV);

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
        power_rms: 3.1,
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
      const powerRms = item ? item.power_rms.toFixed(2) : '3.10';
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
          <div class="ant-metric-row"><span>Pwr:</span><span class="ant-metric-val">${powerRms}</span></div>
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
        refreshSelectedAntennaSpectrum();
        drawMasterAntennaSpectrometer();
      });

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

    if (specResetZoomBtn) {
      specResetZoomBtn.addEventListener('click', () => {
        specViewMode = 'all';
        if (specViewSelect) specViewSelect.value = 'all';
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

    // Tab 2 Controls (Real-Time RFI Mitigation)
    document.querySelectorAll('#rfi-metric-buttons .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#rfi-metric-buttons .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        rfiMetricMode = btn.getAttribute('data-metric');
        requestAnimationFrame(drawRfiSpectrum);
      });
    });

    if (rfiSpectrumCanvas) {
      rfiSpectrumCanvas.addEventListener('mousemove', (e) => {
        const rect = rfiSpectrumCanvas.getBoundingClientRect();
        rfiHover.active = true;
        rfiHover.cssX = e.clientX - rect.left;
        requestAnimationFrame(drawRfiSpectrum);
      });
      rfiSpectrumCanvas.addEventListener('mouseleave', () => {
        rfiHover.active = false;
        if (rfiHoverReadout) {
          rfiHoverReadout.textContent = 'Hover spectrum to inspect channel power, SK, MAD z-score & flag bits';
        }
        requestAnimationFrame(drawRfiSpectrum);
      });
    }

    if (formRfiConfig) {
      formRfiConfig.addEventListener('input', () => { rfiFormDirty = true; });
      formRfiConfig.addEventListener('change', () => { rfiFormDirty = true; });
    }
    if (btnRfiApplyConfig) btnRfiApplyConfig.addEventListener('click', applyRfiConfig);
    if (btnRfiResetEma) btnRfiResetEma.addEventListener('click', () => resetRfiEma(null));
    if (btnRfiPrewhiten) btnRfiPrewhiten.addEventListener('click', pushPrewhiteningGains);

    // Tab 3 Controls (SEFD, Sensitivity & Calibration)
    if (calGlobalToggle) {
      calGlobalToggle.addEventListener('change', () => {
        toggleBeamCalibration(null, calGlobalToggle.checked);
      });
    }

    if (formReloadGains) {
      formReloadGains.addEventListener('submit', async (e) => {
        e.preventDefault();
        const path = (calGainsInput ? calGainsInput.value : '').trim();
        if (!path) {
          showToast('Please enter a calibration gains file path', true);
          return;
        }
        try {
          const res = await fetch('/api/calibration/reload', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              gains_file: path,
              zero_flagged: !!(calZeroFlagged && calZeroFlagged.checked),
              sync_rfi_notches: !!(calSyncNotches && calSyncNotches.checked)
            })
          });
          const reply = await res.json();
          if (res.ok) {
            showToast(`Reloaded gains${reply.converted ? ' (converted .npz → .npy)' : ''}`);
          } else {
            showToast(reply.detail || 'Failed to hot-reload gains', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
      });
    }

    if (formTaperConfig) {
      formTaperConfig.addEventListener('input', () => { calTaperDirty = true; });
      formTaperConfig.addEventListener('change', () => { calTaperDirty = true; });
      formTaperConfig.addEventListener('submit', async (e) => {
        e.preventDefault();
        const payload = {
          taper_type: taperTypeSelect ? taperTypeSelect.value : 'cosine_pedestal',
          taper_pedestal: parseFloat(taperPedestalInput ? taperPedestalInput.value : '0.25'),
          normalize_weights: !!(taperNormalizeWeights && taperNormalizeWeights.checked),
          enable_weight_bislc: !!(taperWeightBislc && taperWeightBislc.checked),
          bislc_diagonal_loading: parseFloat(taperBislcLoading ? taperBislcLoading.value : '0.0001')
        };
        try {
          const res = await fetch('/api/taper', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const reply = await res.json();
          if (res.ok) {
            calTaperDirty = false;
            showToast(reply.message || 'Spatial taper updated');
          } else {
            showToast(reply.detail || 'Failed to update taper', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
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
          const fMhz = 300.0 + normX * 201.3;
          const spec = getAntennaSpectrum(selectedAntennaId, true);
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
            antennaMaskHoverEl.textContent = `Antenna #${String(idx).padStart(2, '0')} [R${Math.floor(idx / 8)}C${idx % 8}] | ${ant.enabled ? 'ACTIVE' : 'MASKED'} | Pwr: ${(ant.power_rms || 0).toFixed(2)} LSB² | Clip: ${((ant.clip_fraction || 0) * 100).toFixed(2)}% (Double-click to toggle mask)`;
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
          refreshSelectedAntennaSpectrum();
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
    refreshSelectedAntennaSpectrum();
  });
})();
