// Direct Beam Tracker Viewer — Frontend Client
(function() {
  const BEAM_COLORS = [
    '#00e5ff', '#ff9100', '#00e676', '#d500f9',
    '#ff1744', '#ffea00', '#2979ff', '#ff4081',
    '#14b8a6', '#f97316', '#a855f7', '#06b6d4',
    '#eab308', '#ec4899', '#84cc16', '#6366f1'
  ];

  let currentStatus = null;
  let routineState = null;
  let selectedBeamId = 0;
  let beamTrails = {};
  let ws = null;
  let pollTimer = null;
  let wsRetryTimer = null;
  let toastTimer = null;

  // DOM Elements
  const canvas = document.getElementById('sky-canvas');
  const ctx = canvas.getContext('2d');
  const connBadge = document.getElementById('conn-badge');
  const connLabel = document.getElementById('conn-label');
  const activeSummary = document.getElementById('active-summary');
  const activeAntennasCount = document.getElementById('active-antennas-count');
  const routineSummary = document.getElementById('routine-summary');
  const beamTableBody = document.getElementById('beam-table-body');
  const antennaGrid = document.getElementById('antenna-grid');
  const numBeamsSelect = document.getElementById('num-beams-select');
  const applyBeamsBtn = document.getElementById('apply-beams-btn');
  const interpToggle = document.getElementById('interp-toggle');
  const toast = document.getElementById('toast-message');
  const cursorCoords = document.getElementById('cursor-coords');

  const lmBeamSelect = document.getElementById('lm-beam-id');
  const celBeamSelect = document.getElementById('cel-beam-id');
  const formSteerLm = document.getElementById('form-steer-lm');
  const formSteerCel = document.getElementById('form-steer-celestial');

  // Spectrometer DOM Elements
  const specCanvas = document.getElementById('spectrometer-canvas');
  const specCtx = specCanvas ? specCanvas.getContext('2d') : null;
  const specViewSelect = document.getElementById('spec-view-select');
  const specResetZoomBtn = document.getElementById('spec-reset-zoom-btn');
  const specCursorReadout = document.getElementById('spec-cursor-readout');
  const specLegend = document.getElementById('spec-legend');
  const specStats = document.getElementById('spec-stats');

  // All Beams Grid View Elements
  const mapPanel = document.getElementById('map-panel');
  const specPanel = document.getElementById('spectrometer-panel');
  const allBeamsPanel = document.getElementById('all-beams-panel');
  const allBeamsGridEl = document.getElementById('all-beams-grid');
  const btnViewSingle = document.getElementById('btn-view-single');
  const btnViewGrid = document.getElementById('btn-view-grid');
  const btnViewSingleGrid = document.getElementById('btn-view-single-grid');
  const btnViewGridActive = document.getElementById('btn-view-grid-active');

  let currentViewMode = 'overview';
  let historyAllFetched = false;
  let allBeamsGrid = null;

  // Spectrometer State
  let latestSpectrometer = null;
  let specViewMode = 'all';
  let specHover = { active: false, x: 0, y: 0 };
  let specZoom = { fMin: 300.0, fMax: 501.3, dbMin: -45.0, dbMax: 10.0, userZoomed: false };
  let specDrag = { isDragging: false, startX: 0, startY: 0, currentX: 0, currentY: 0 };

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

  // --- WebSocket & Fallback Polling ---

  function initWebSocket() {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${proto}//${window.location.host}/ws`;
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnectionState('live', 'Live (WS)');
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'spectrometer') {
          handleSpectrometerUpdate(data.data || data);
        } else if (data.type === 'routine') {
          handleRoutineUpdate(data.data || data);
        } else {
          handleStatusUpdate(data);
        }
      } catch (err) {
        console.error('Failed to parse websocket message', err);
      }
    };

    ws.onclose = () => {
      setConnectionState('fallback', 'Polling (2s)');
      startFallback();
      clearTimeout(wsRetryTimer);
      wsRetryTimer = setTimeout(initWebSocket, 5000);
    };

    ws.onerror = () => {
      ws.close();
    };
  }

  function startFallback() {
    if (pollTimer) return;
    pollTimer = setInterval(async () => {
      try {
        const res = await fetch('/api/status');
        if (res.ok) {
          const data = await res.json();
          setConnectionState('fallback', 'Polling (2s)');
          handleStatusUpdate(data);
        } else {
          setConnectionState('disconnected', 'Disconnected');
        }

        const resSpec = await fetch('/api/spectrometer');
        if (resSpec.ok) {
          const specData = await resSpec.json();
          handleSpectrometerUpdate(specData);
        }

        const resRoutine = await fetch('/api/routine');
        if (resRoutine.ok) {
          handleRoutineUpdate(await resRoutine.json());
        }
      } catch (e) {
        setConnectionState('disconnected', 'Disconnected');
      }
    }, 2000);
  }

  // --- Observation Routine ---

  function beamName(beamId) {
    if (routineState && routineState.beam_names) {
      return routineState.beam_names[String(beamId)] || null;
    }
    return null;
  }

  function handleRoutineUpdate(data) {
    routineState = data;

    if (routineSummary) {
      if (!routineState || !routineState.enabled) {
        routineSummary.textContent = 'Routine: off';
        routineSummary.parentElement.hidden = routineState ? !routineState.enabled : true;
      } else if (routineState.last_error) {
        routineSummary.textContent = `Routine: ERROR (${routineState.last_error})`;
        routineSummary.parentElement.hidden = false;
      } else {
        const next = routineState.next_slot_time_local || '--:--';
        routineSummary.textContent = `Routine: ON · next change ${next}`;
        routineSummary.parentElement.hidden = false;
      }
    }

    if (currentStatus) {
      updateBeamSelects(currentStatus.beams);
      renderBeamTable(currentStatus.beams);
    }
    requestAnimationFrame(drawSkyMap);
  }

  // --- Status Update Handler ---

  function handleStatusUpdate(status) {
    currentStatus = status;

    // Header stats
    activeSummary.textContent = `${status.num_active_beams} beam${status.num_active_beams === 1 ? '' : 's'} active`;
    activeAntennasCount.textContent = status.active_antennas;

    // Inputs sync
    if (document.activeElement !== numBeamsSelect) {
      numBeamsSelect.value = status.num_active_beams;
    }
    interpToggle.checked = status.subframe_interpolation_enabled;

    // Beam dropdowns
    updateBeamSelects(status.beams);

    // Table render
    renderBeamTable(status.beams);

    // Antenna grid render
    renderAntennaGrid(status.active_raw_elements);

    // Redraw canvas
    requestAnimationFrame(drawSkyMap);

    // Update all beams grid
    if (allBeamsGrid) {
      allBeamsGrid.updateStatus(status);
    }
  }

  function updateBeamSelects(beams) {
    const prevLm = lmBeamSelect.value;
    const prevCel = celBeamSelect.value;

    lmBeamSelect.innerHTML = '';
    celBeamSelect.innerHTML = '';

    const ids = beams.length > 0 ? beams.map(b => b.beam_id) : [0];
    ids.forEach(id => {
      const name = beamName(id);
      const optLm = document.createElement('option');
      optLm.value = id;
      optLm.textContent = `Beam ${id}${name ? ' — ' + name : ''}`;
      lmBeamSelect.appendChild(optLm);

      const optCel = document.createElement('option');
      optCel.value = id;
      optCel.textContent = `Beam ${id}${name ? ' — ' + name : ''}`;
      celBeamSelect.appendChild(optCel);
    });

    if (ids.includes(parseInt(prevLm, 10))) lmBeamSelect.value = prevLm;
    if (ids.includes(parseInt(prevCel, 10))) celBeamSelect.value = prevCel;
  }

  function renderBeamTable(beams) {
    if (!beams || beams.length === 0) {
      beamTableBody.innerHTML = '<tr><td colspan="6" class="empty-state">No active beams</td></tr>';
      return;
    }

    beamTableBody.innerHTML = '';
    beams.forEach(b => {
      const tr = document.createElement('tr');
      if (b.beam_id === selectedBeamId) tr.classList.add('selected');

      const color = BEAM_COLORS[b.beam_id % BEAM_COLORS.length];
      const targetStr = b.celestial_target && b.celestial_target.is_set
        ? `${b.celestial_target.ra_deg.toFixed(2)}°, ${b.celestial_target.dec_deg.toFixed(2)}°`
        : 'Direction cosines';

      const name = beamName(b.beam_id);
      tr.innerHTML = `
        <td style="color: ${color}; font-weight: bold;">● Beam ${b.beam_id}${name ? ` — ${name}` : ''}</td>
        <td>${b.l0.toFixed(4)}</td>
        <td>${b.m0.toFixed(4)}</td>
        <td>${b.n0.toFixed(4)}</td>
        <td>${b.grid_index}</td>
        <td>${targetStr}</td>
      `;

      tr.addEventListener('click', () => selectBeam(b.beam_id));
      beamTableBody.appendChild(tr);
    });
  }

  async function selectBeam(beamId) {
    selectedBeamId = beamId;
    lmBeamSelect.value = beamId;
    celBeamSelect.value = beamId;

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

    // Fetch history trail
    try {
      const res = await fetch(`/api/history?beam_id=${beamId}`);
      if (res.ok) {
        beamTrails[beamId] = await res.json();
      }
    } catch (e) {
      console.error('Failed to fetch beam history', e);
    }

    renderBeamTable(currentStatus ? currentStatus.beams : []);
    requestAnimationFrame(drawSkyMap);
  }

  function renderAntennaGrid(activeElements) {
    const activeSet = new Set(activeElements || []);
    let maxElem = 31;
    if (activeElements && activeElements.length > 0) {
      maxElem = Math.max(maxElem, Math.max(...activeElements));
    }
    // Round up to multiple of 8
    maxElem = Math.max(31, Math.ceil((maxElem + 1) / 8) * 8 - 1);

    antennaGrid.innerHTML = '';
    for (let id = 0; id <= maxElem; id++) {
      const cell = document.createElement('div');
      const isActive = activeSet.has(id);
      cell.className = `antenna-cell ${isActive ? 'active' : ''}`;
      cell.textContent = id;
      cell.title = `Antenna ${id}: ${isActive ? 'Active' : 'Masked'}`;

      cell.addEventListener('click', async () => {
        try {
          const res = await fetch('/api/antennas/mask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ antenna_id: id, enabled: !isActive })
          });
          const reply = await res.json();
          if (res.ok) {
            showToast(reply.message || `Antenna ${id} updated`);
          } else {
            showToast(reply.detail || 'Failed to toggle antenna', true);
          }
        } catch (err) {
          showToast(err.message, true);
        }
      });

      antennaGrid.appendChild(cell);
    }
  }

  // --- Canvas Sky Map ---

  function drawSkyMap() {
    if (document.hidden || currentViewMode !== 'overview') return;
    const w = canvas.width;
    const h = canvas.height;
    const cx = w / 2;
    const cy = h / 2;
    const r = (w / 2) - 34; // Radius of horizon unit circle

    ctx.clearRect(0, 0, w, h);

    // Horizon circle (r = 1)
    ctx.strokeStyle = '#243447';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.stroke();

    // 30° zenith angle (r * sin(30°) = 0.5 * r)
    ctx.strokeStyle = '#1e2b3c';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, 0, Math.PI * 2);
    ctx.stroke();

    // 60° zenith angle (r * sin(60°) = 0.866 * r)
    ctx.beginPath();
    ctx.arc(cx, cy, r * Math.sin(Math.PI / 3), 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Cross axes: l (East/West), m (North/South)
    ctx.strokeStyle = '#1a2636';
    ctx.beginPath();
    ctx.moveTo(cx - r, cy);
    ctx.lineTo(cx + r, cy);
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx, cy + r);
    ctx.stroke();

    // Axis Labels
    ctx.fillStyle = '#8ba2b9';
    ctx.font = '11px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('N (+m)', cx, cy - r - 16);
    ctx.fillText('S (-m)', cx, cy + r + 16);
    ctx.fillText('E (+l)', cx + r + 20, cy);
    ctx.fillText('W (-l)', cx - r - 20, cy);
    ctx.fillText('30°', cx + r * 0.5, cy - 8);
    ctx.fillText('60°', cx + r * Math.sin(Math.PI / 3), cy - 8);

    // Center Zenith dot
    ctx.fillStyle = '#3b4d63';
    ctx.beginPath();
    ctx.arc(cx, cy, 2.5, 0, Math.PI * 2);
    ctx.fill();

    // Selected beam trail
    const trail = beamTrails[selectedBeamId];
    if (trail && trail.length > 1) {
      ctx.strokeStyle = 'rgba(0, 229, 255, 0.45)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      for (let i = 0; i < trail.length; i++) {
        const pt = trail[i];
        const tx = cx + pt.l0 * r;
        const ty = cy - pt.m0 * r;
        if (i === 0) ctx.moveTo(tx, ty);
        else ctx.lineTo(tx, ty);
      }
      ctx.stroke();
    }

    // Active beams
    if (currentStatus && currentStatus.beams) {
      currentStatus.beams.forEach(b => {
        const bx = cx + b.l0 * r;
        const by = cy - b.m0 * r;
        const color = BEAM_COLORS[b.beam_id % BEAM_COLORS.length];
        const isSelected = b.beam_id === selectedBeamId;

        // Selection ring
        if (isSelected) {
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth = 2;
          ctx.beginPath();
          ctx.arc(bx, by, 9, 0, Math.PI * 2);
          ctx.stroke();
        }

        // Beam dot
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(bx, by, 5, 0, Math.PI * 2);
        ctx.fill();

        // Label
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 11px monospace';
        ctx.textAlign = 'left';
        ctx.fillText(`B${b.beam_id}`, bx + 8, by - 6);

        // Routine target name
        const name = beamName(b.beam_id);
        if (name) {
          ctx.fillStyle = '#9fb3c8';
          ctx.font = '10px monospace';
          ctx.fillText(name, bx + 8, by + 10);
        }
      });
    }
  }

  // Canvas Mouse Coordinates
  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const x = (e.clientX - rect.left) * scaleX;
    const y = (e.clientY - rect.top) * scaleY;
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const r = (canvas.width / 2) - 34;

    const l = (x - cx) / r;
    const m = (cy - y) / r;
    cursorCoords.textContent = `l: ${l.toFixed(4)} , m: ${m.toFixed(4)}`;
  });

  // --- Form & Action Handlers ---

  // Tabs
  document.getElementById('tab-btn-lm').addEventListener('click', () => {
    document.getElementById('tab-btn-lm').classList.add('active');
    document.getElementById('tab-btn-celestial').classList.remove('active');
    formSteerLm.classList.add('active');
    formSteerCel.classList.remove('active');
  });

  document.getElementById('tab-btn-celestial').addEventListener('click', () => {
    document.getElementById('tab-btn-celestial').classList.add('active');
    document.getElementById('tab-btn-lm').classList.remove('active');
    formSteerCel.classList.add('active');
    formSteerLm.classList.remove('active');
  });

  // Steer Direction Cosines
  formSteerLm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const beamId = parseInt(lmBeamSelect.value, 10);
    const l0 = parseFloat(document.getElementById('lm-l0').value);
    const m0 = parseFloat(document.getElementById('lm-m0').value);

    if (isNaN(l0) || isNaN(m0)) {
      showToast('Please enter valid l0 and m0', true);
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
      const data = await res.json();
      if (res.ok) {
        showToast(data.message || `Beam ${beamId} steered`);
      } else {
        showToast(data.detail || 'Steer failed', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Steer Celestial
  formSteerCel.addEventListener('submit', async (e) => {
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
      const data = await res.json();
      if (res.ok) {
        showToast(data.message || `Beam ${beamId} pointed to RA/Dec`);
      } else {
        showToast(data.detail || 'Celestial steer failed', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Num active beams
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
      const data = await res.json();
      if (res.ok) {
        showToast(data.message || `Active beams set to ${val}`);
      } else {
        showToast(data.detail || 'Failed to set active beams', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // Interpolation toggle
  interpToggle.addEventListener('change', async () => {
    const checked = interpToggle.checked;
    try {
      const res = await fetch('/api/interpolation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled: checked })
      });
      const data = await res.json();
      if (res.ok) {
        showToast(data.message || `Interpolation ${checked ? 'enabled' : 'disabled'}`);
      } else {
        showToast(data.detail || 'Failed to toggle interpolation', true);
      }
    } catch (err) {
      showToast(err.message, true);
    }
  });

  // --- Spectrometer Logic & Canvas Rendering ---

  function handleSpectrometerUpdate(specData) {
    if (!specData || !specData.beams) return;
    latestSpectrometer = specData;

    // Update view dropdown options if beam set changed
    updateSpectrometerViewSelect(specData.beams);

    // Update legend pills & stats in panel footer
    renderSpectrometerFooter(specData.beams);

    // Redraw canvas
    requestAnimationFrame(drawSpectrometer);

    // Update all beams grid
    if (allBeamsGrid) {
      allBeamsGrid.updateSpectrometer(specData);
    }
  }

  function updateSpectrometerViewSelect(beams) {
    if (!specViewSelect) return;
    const currentVal = specViewSelect.value;
    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a) - parseInt(b));

    const existingOptions = Array.from(specViewSelect.options).map(o => o.value);
    const expectedOptions = ['all', ...beamIds];

    const needsRebuild = existingOptions.length !== expectedOptions.length ||
      !expectedOptions.every((val, i) => existingOptions[i] === val);

    if (needsRebuild) {
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

      if (expectedOptions.includes(currentVal)) {
        specViewSelect.value = currentVal;
      }
    }
  }

  function renderSpectrometerFooter(beams) {
    if (!specLegend || !specStats) return;

    specLegend.innerHTML = '';
    specStats.innerHTML = '';

    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a) - parseInt(b));
    let statsTexts = [];

    beamIds.forEach(id => {
      const b = beams[id];
      const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];

      // Pill
      const pill = document.createElement('div');
      pill.className = 'spec-pill';
      pill.innerHTML = `
        <span class="spec-pill-dot" style="background-color: ${color};"></span>
        <span>${b.label || `Beam ${id}`}</span>
      `;
      specLegend.appendChild(pill);

      // Stats
      if (b.stats) {
        statsTexts.push(
          `<span>Beam ${id}: Min <strong>${b.stats.min} dB</strong> | Max <strong>${b.stats.max} dB</strong> | Mean <strong>${b.stats.mean} dB</strong> | Peak <strong>${b.stats.peak_freq_mhz} MHz</strong></span>`
        );
      }
    });

    specStats.innerHTML = statsTexts.join('');
  }

  function drawSpectrometer() {
    if (!specCanvas || !specCtx) return;
    if (document.hidden || currentViewMode !== 'overview') return;

    const width = specCanvas.width;
    const height = specCanvas.height;

    // Background matching deep dark Grafana panel from charts32
    specCtx.fillStyle = '#181b1f';
    specCtx.fillRect(0, 0, width, height);

    if (!latestSpectrometer || !latestSpectrometer.beams) {
      specCtx.fillStyle = '#8ba2b9';
      specCtx.font = '12px ui-monospace, monospace';
      specCtx.textAlign = 'center';
      specCtx.textBaseline = 'middle';
      specCtx.fillText('Connecting to output formed beams spectrometer (1 Hz)...', width / 2, height / 2);
      return;
    }

    const beams = latestSpectrometer.beams;
    const beamIds = Object.keys(beams).sort((a, b) => parseInt(a) - parseInt(b));
    if (beamIds.length === 0) return;

    // Filter active beams according to view mode
    const activeIds = (specViewMode === 'all')
      ? beamIds
      : (beams[specViewMode] ? [specViewMode] : beamIds);

    // Layout padding
    const padL = 52;
    const padR = 18;
    const padT = 16;
    const padB = 30;
    const plotW = width - padL - padR;
    const plotH = height - padT - padB;

    if (plotW <= 0 || plotH <= 0) return;

    // Auto-scale dB range if user has not zoomed
    let dbMin = specZoom.dbMin;
    let dbMax = specZoom.dbMax;
    let fMin = specZoom.fMin;
    let fMax = specZoom.fMax;

    if (!specZoom.userZoomed) {
      let dataMin = 100.0;
      let dataMax = -100.0;
      activeIds.forEach(id => {
        const b = beams[id];
        if (b.stats) {
          dataMin = Math.min(dataMin, b.stats.min);
          dataMax = Math.max(dataMax, b.stats.max);
        }
      });
      if (dataMin < dataMax) {
        dbMin = Math.floor(dataMin / 5) * 5 - 5;
        dbMax = Math.ceil(dataMax / 5) * 5 + 5;
        specZoom.dbMin = dbMin;
        specZoom.dbMax = dbMax;
      }
    }

    const xToPx = (f) => padL + ((f - fMin) / (fMax - fMin)) * plotW;
    const yToPx = (db) => padT + plotH - ((db - dbMin) / (dbMax - dbMin)) * plotH;
    const pxToX = (px) => fMin + ((px - padL) / plotW) * (fMax - fMin);

    // 1. Grid & Ticks
    specCtx.lineWidth = 1;
    specCtx.strokeStyle = '#22262e';
    specCtx.fillStyle = '#8ba2b9';
    specCtx.font = '10px ui-monospace, monospace';
    specCtx.textAlign = 'right';
    specCtx.textBaseline = 'middle';

    // Horizontal Y Grid (Power dB)
    const dbStep = (dbMax - dbMin) <= 30 ? 5 : 10;
    const firstDb = Math.ceil(dbMin / dbStep) * dbStep;
    specCtx.beginPath();
    for (let db = firstDb; db <= dbMax; db += dbStep) {
      const y = yToPx(db);
      if (y >= padT && y <= padT + plotH) {
        specCtx.moveTo(padL, y);
        specCtx.lineTo(padL + plotW, y);
        specCtx.fillText(`${db.toFixed(0)} dB`, padL - 6, y);
      }
    }
    specCtx.stroke();

    // Vertical X Grid (Frequency MHz)
    const fSpan = fMax - fMin;
    const fStep = fSpan <= 50 ? 10 : (fSpan <= 120 ? 25 : 50);
    const firstF = Math.ceil(fMin / fStep) * fStep;
    specCtx.textAlign = 'center';
    specCtx.textBaseline = 'top';
    specCtx.beginPath();
    for (let f = firstF; f <= fMax; f += fStep) {
      const x = xToPx(f);
      if (x >= padL && x <= padL + plotW) {
        specCtx.moveTo(x, padT);
        specCtx.lineTo(x, padT + plotH);
        specCtx.fillText(`${f.toFixed(0)}`, x, padT + plotH + 6);
      }
    }
    specCtx.stroke();

    // Axes border
    specCtx.strokeStyle = '#2e3846';
    specCtx.strokeRect(padL, padT, plotW, plotH);

    // Unit labels
    specCtx.fillStyle = '#64748b';
    specCtx.textAlign = 'right';
    specCtx.textBaseline = 'bottom';
    specCtx.fillText('Power', padL - 6, padT - 2);
    specCtx.textAlign = 'right';
    specCtx.textBaseline = 'top';
    specCtx.fillText('MHz', padL + plotW, padT + plotH + 6);

    // 2. Draw Spectra Lines (Clipped to plot area)
    specCtx.save();
    specCtx.beginPath();
    specCtx.rect(padL, padT, plotW, plotH);
    specCtx.clip();

    activeIds.forEach(id => {
      const b = beams[id];
      if (!b.frequencies_mhz || !b.power_db || b.frequencies_mhz.length === 0) return;

      const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];
      specCtx.strokeStyle = color;
      specCtx.lineWidth = 1.75;
      specCtx.beginPath();

      const freqs = b.frequencies_mhz;
      const powers = b.power_db;
      let first = true;

      for (let i = 0; i < freqs.length; i++) {
        const f = freqs[i];
        if (f < fMin - 2 || f > fMax + 2) continue;
        const x = xToPx(f);
        const y = yToPx(powers[i]);
        if (first) {
          specCtx.moveTo(x, y);
          first = false;
        } else {
          specCtx.lineTo(x, y);
        }
      }
      specCtx.stroke();
    });

    specCtx.restore();

    // 3. Drag-Zoom Selection Box
    if (specDrag.isDragging) {
      const x0 = Math.max(padL, Math.min(specDrag.startX, specDrag.currentX));
      const x1 = Math.min(padL + plotW, Math.max(specDrag.startX, specDrag.currentX));
      const y0 = Math.max(padT, Math.min(specDrag.startY, specDrag.currentY));
      const y1 = Math.min(padT + plotH, Math.max(specDrag.startY, specDrag.currentY));

      specCtx.fillStyle = 'rgba(0, 229, 255, 0.12)';
      specCtx.fillRect(x0, y0, x1 - x0, y1 - y0);
      specCtx.strokeStyle = 'rgba(0, 229, 255, 0.75)';
      specCtx.lineWidth = 1;
      specCtx.setLineDash([4, 3]);
      specCtx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      specCtx.setLineDash([]);
    }

    // 4. Hover Crosshair & Dynamic Readout
    if (specHover.active && specHover.x >= padL && specHover.x <= padL + plotW) {
      const hoverFreq = pxToX(specHover.x);
      specCtx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      specCtx.lineWidth = 1;
      specCtx.setLineDash([2, 2]);
      specCtx.beginPath();
      specCtx.moveTo(specHover.x, padT);
      specCtx.lineTo(specHover.x, padT + plotH);
      specCtx.stroke();
      specCtx.setLineDash([]);

      let readoutParts = [`Freq: ${hoverFreq.toFixed(2)} MHz`];

      activeIds.forEach(id => {
        const b = beams[id];
        if (!b.frequencies_mhz || b.frequencies_mhz.length === 0) return;

        const freqs = b.frequencies_mhz;
        let bestIdx = 0;
        let minDiff = 1e9;
        for (let i = 0; i < freqs.length; i++) {
          const diff = Math.abs(freqs[i] - hoverFreq);
          if (diff < minDiff) {
            minDiff = diff;
            bestIdx = i;
          }
        }

        const pVal = b.power_db[bestIdx];
        const color = BEAM_COLORS[parseInt(id, 10) % BEAM_COLORS.length];

        // Draw dot marker on curve
        const dotX = xToPx(freqs[bestIdx]);
        const dotY = yToPx(pVal);
        if (dotY >= padT && dotY <= padT + plotH) {
          specCtx.fillStyle = color;
          specCtx.beginPath();
          specCtx.arc(dotX, dotY, 4, 0, Math.PI * 2);
          specCtx.fill();
        }

        readoutParts.push(`<span style="color: ${color}; font-weight: bold;">Beam ${id}: ${pVal.toFixed(1)} dB</span>`);
      });

      if (specCursorReadout) {
        specCursorReadout.innerHTML = readoutParts.join(' &nbsp;|&nbsp; ');
      }
    }
  }

  // --- Spectrometer Interactivity & Mouse Events ---
  if (specCanvas) {
    specCanvas.addEventListener('mousemove', (e) => {
      const rect = specCanvas.getBoundingClientRect();
      const scaleX = specCanvas.width / rect.width;
      const scaleY = specCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      specHover = { active: true, x, y };

      if (specDrag.isDragging) {
        specDrag.currentX = x;
        specDrag.currentY = y;
      }

      drawSpectrometer();
    });

    specCanvas.addEventListener('mouseleave', () => {
      specHover.active = false;
      if (specDrag.isDragging) {
        specDrag.isDragging = false;
      }
      if (specCursorReadout) {
        specCursorReadout.textContent = 'Hover cursor on chart to inspect frequency and beam power';
      }
      drawSpectrometer();
    });

    specCanvas.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return; // Left click only
      const rect = specCanvas.getBoundingClientRect();
      const scaleX = specCanvas.width / rect.width;
      const scaleY = specCanvas.height / rect.height;
      const x = (e.clientX - rect.left) * scaleX;
      const y = (e.clientY - rect.top) * scaleY;

      // Only drag if inside plot area
      if (x >= 52 && x <= specCanvas.width - 18 && y >= 16 && y <= specCanvas.height - 30) {
        specDrag = { isDragging: true, startX: x, startY: y, currentX: x, currentY: y };
      }
    });

    specCanvas.addEventListener('mouseup', (e) => {
      if (!specDrag.isDragging) return;
      specDrag.isDragging = false;

      const padL = 52;
      const padR = 18;
      const padT = 16;
      const padB = 30;
      const plotW = specCanvas.width - padL - padR;
      const plotH = specCanvas.height - padT - padB;

      const x0 = Math.min(specDrag.startX, specDrag.currentX);
      const x1 = Math.max(specDrag.startX, specDrag.currentX);
      const y0 = Math.min(specDrag.startY, specDrag.currentY);
      const y1 = Math.max(specDrag.startY, specDrag.currentY);

      if (x1 - x0 > 15 && y1 - y0 > 15) {
        // Calculate new zoom ranges
        const f0 = specZoom.fMin + ((x0 - padL) / plotW) * (specZoom.fMax - specZoom.fMin);
        const f1 = specZoom.fMin + ((x1 - padL) / plotW) * (specZoom.fMax - specZoom.fMin);
        const db1 = specZoom.dbMin + ((padT + plotH - y0) / plotH) * (specZoom.dbMax - specZoom.dbMin);
        const db0 = specZoom.dbMin + ((padT + plotH - y1) / plotH) * (specZoom.dbMax - specZoom.dbMin);

        specZoom.fMin = Math.max(295.0, Math.min(f0, f1));
        specZoom.fMax = Math.min(505.0, Math.max(f0, f1));
        specZoom.dbMin = Math.min(db0, db1);
        specZoom.dbMax = Math.max(db0, db1);
        specZoom.userZoomed = true;
      }
      drawSpectrometer();
    });

    specCanvas.addEventListener('dblclick', () => {
      resetSpectrometerZoom();
    });
  }

  function resetSpectrometerZoom() {
    specZoom = { fMin: 300.0, fMax: 501.3, dbMin: -45.0, dbMax: 10.0, userZoomed: false };
    drawSpectrometer();
  }

  if (specResetZoomBtn) {
    specResetZoomBtn.addEventListener('click', () => {
      resetSpectrometerZoom();
    });
  }

  if (specViewSelect) {
    specViewSelect.addEventListener('change', (e) => {
      specViewMode = e.target.value;
      drawSpectrometer();
    });
  }

  // --- All Beams Multi-Square Grid Renderer ---

  class AllBeamsGridRenderer {
    constructor(containerEl, onSelectBeam) {
      this.container = containerEl;
      this.onSelectBeam = onSelectBeam;
      this.tiles = new Map();
      this.latestStatus = null;
      this.latestSpec = null;
      this.trails = new Map();
      this.rafId = null;
    }

    ensureTile(beamId) {
      if (this.tiles.has(beamId)) return this.tiles.get(beamId);

      const card = document.createElement('div');
      card.className = 'beam-square-card';
      card.innerHTML = `
        <div class="beam-square-header">
          <span class="beam-square-title">Beam ${beamId}</span>
          <span class="beam-square-meta">--</span>
        </div>
        <div class="beam-square-canvases">
          <canvas class="beam-sky-canvas" width="140" height="140"></canvas>
          <canvas class="beam-spec-canvas" width="220" height="140"></canvas>
        </div>
      `;
      card.addEventListener('click', () => this.onSelectBeam(beamId));
      this.container.appendChild(card);

      const skyCanvas = card.querySelector('.beam-sky-canvas');
      const specCanvas = card.querySelector('.beam-spec-canvas');
      const tile = {
        root: card,
        skyCtx: skyCanvas.getContext('2d', { alpha: false }),
        specCtx: specCanvas.getContext('2d', { alpha: false }),
        titleEl: card.querySelector('.beam-square-title'),
        metaEl: card.querySelector('.beam-square-meta'),
        lastTitle: '',
        lastMeta: '',
      };
      this.tiles.set(beamId, tile);
      return tile;
    }

    setHistoryAll(historyMap) {
      if (!historyMap) return;
      for (const [beamIdStr, samples] of Object.entries(historyMap)) {
        const bId = parseInt(beamIdStr, 10);
        this.trails.set(bId, samples.map(s => ({ l0: s.l0, m0: s.m0 })));
      }
      this.scheduleRender();
    }

    updateStatus(status) {
      this.latestStatus = status;
      if (status && status.beams) {
        for (const b of status.beams) {
          if (!this.trails.has(b.beam_id)) {
            this.trails.set(b.beam_id, []);
          }
          const trail = this.trails.get(b.beam_id);
          trail.push({ l0: b.l0, m0: b.m0 });
          if (trail.length > 120) trail.shift();
        }
      }
      this.scheduleRender();
    }

    updateSpectrometer(specData) {
      this.latestSpec = specData;
      this.scheduleRender();
    }

    scheduleRender() {
      if (document.hidden || currentViewMode !== 'grid' || this.rafId !== null) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = null;
        this.renderAll();
      });
    }

    renderAll() {
      if (!this.latestStatus || !this.latestStatus.beams) return;
      const activeCount = this.latestStatus.num_active_beams || 0;
      const specBeams = this.latestSpec?.beams || {};

      for (const beam of this.latestStatus.beams) {
        const id = beam.beam_id;
        const isActive = id < activeCount;
        const tile = this.ensureTile(id);
        tile.root.classList.toggle('inactive', !isActive);
        tile.root.classList.toggle('selected', id === selectedBeamId);

        const spec = specBeams[id];
        const rName = beamName(id);
        const targetName = rName || spec?.target_name || (beam.celestial_target?.is_set ? `RA ${beam.celestial_target.ra_deg?.toFixed(1)}°` : '');
        const titleText = targetName ? `B${id}: ${targetName}` : `Beam ${id}`;
        if (tile.lastTitle !== titleText) {
          tile.titleEl.textContent = titleText;
          tile.lastTitle = titleText;
        }

        const peakDb = spec?.stats?.peak_power_db;
        const metaText = `l=${beam.l0.toFixed(3)} m=${beam.m0.toFixed(3)}` +
          (peakDb !== undefined ? ` | ${peakDb.toFixed(1)} dB` : '');
        if (tile.lastMeta !== metaText) {
          tile.metaEl.textContent = metaText;
          tile.lastMeta = metaText;
        }

        this.drawSkySquare(tile.skyCtx, beam, this.trails.get(id) || []);
        if (spec && spec.power_db) {
          this.drawMiniSpectrum(tile.specCtx, spec.power_db);
        }
      }
    }

    drawSkySquare(ctx, beam, trail) {
      const w = 140, h = 140, cx = 70, cy = 70, r = 60;
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, w, h);

      // Horizon circle (l^2 + m^2 = 1) & crosshairs
      ctx.strokeStyle = '#262c3a';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.moveTo(cx - r, cy); ctx.lineTo(cx + r, cy);
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx, cy + r);
      ctx.stroke();

      // Trail path
      if (trail.length > 1) {
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.45)';
        ctx.beginPath();
        for (let i = 0; i < trail.length; i++) {
          const px = cx + trail[i].l0 * r;
          const py = cy - trail[i].m0 * r;
          if (i === 0) ctx.moveTo(px, py);
          else ctx.lineTo(px, py);
        }
        ctx.stroke();
      }

      // Current beam position dot
      const bx = cx + beam.l0 * r;
      const by = cy - beam.m0 * r;
      const color = BEAM_COLORS[beam.beam_id % BEAM_COLORS.length] || '#38bdf8';
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(bx, by, 4, 0, Math.PI * 2);
      ctx.fill();
    }

    drawMiniSpectrum(ctx, powerDb) {
      const w = 220, h = 140;
      ctx.fillStyle = '#0d1117';
      ctx.fillRect(0, 0, w, h);

      const n = powerDb.length;
      if (!n) return;
      const stride = Math.max(1, Math.floor(n / 168));
      const minDb = -45.0, maxDb = 10.0;

      ctx.strokeStyle = '#34d399';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let first = true;
      for (let i = 0; i < n; i += stride) {
        const x = (i / (n - 1)) * (w - 8) + 4;
        const norm = Math.max(0, Math.min(1, (powerDb[i] - minDb) / (maxDb - minDb)));
        const y = h - 6 - norm * (h - 12);
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
  }

  function switchViewMode(mode) {
    currentViewMode = mode;
    if (mode === 'grid') {
      if (mapPanel) mapPanel.style.display = 'none';
      if (specPanel) specPanel.style.display = 'none';
      if (allBeamsPanel) allBeamsPanel.style.display = 'block';
      if (btnViewSingle) btnViewSingle.classList.remove('active');
      if (btnViewGrid) btnViewGrid.classList.add('active');

      if (!historyAllFetched) {
        historyAllFetched = true;
        fetch('/api/history/all?limit=120')
          .then(res => res.ok ? res.json() : null)
          .then(data => {
            if (data && allBeamsGrid) allBeamsGrid.setHistoryAll(data);
          })
          .catch(() => {});
      }
      if (allBeamsGrid) allBeamsGrid.scheduleRender();
    } else {
      if (mapPanel) mapPanel.style.display = 'block';
      if (specPanel) specPanel.style.display = 'block';
      if (allBeamsPanel) allBeamsPanel.style.display = 'none';
      if (btnViewSingle) btnViewSingle.classList.add('active');
      if (btnViewGrid) btnViewGrid.classList.remove('active');
      requestAnimationFrame(drawSkyMap);
      requestAnimationFrame(drawSpectrometer);
    }
  }

  if (btnViewSingle) btnViewSingle.addEventListener('click', () => switchViewMode('overview'));
  if (btnViewGrid) btnViewGrid.addEventListener('click', () => switchViewMode('grid'));
  if (btnViewSingleGrid) btnViewSingleGrid.addEventListener('click', () => switchViewMode('overview'));
  if (btnViewGridActive) btnViewGridActive.addEventListener('click', () => switchViewMode('grid'));

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      if (currentViewMode === 'overview') {
        requestAnimationFrame(drawSkyMap);
        requestAnimationFrame(drawSpectrometer);
      } else if (allBeamsGrid) {
        allBeamsGrid.scheduleRender();
      }
    }
  });

  if (allBeamsGridEl) {
    allBeamsGrid = new AllBeamsGridRenderer(allBeamsGridEl, (beamId) => {
      selectBeam(beamId);
    });
  }

  // Initial draw & connect
  drawSkyMap();
  drawSpectrometer();
  fetch('/api/routine')
    .then(res => res.ok ? res.json() : null)
    .then(data => { if (data) handleRoutineUpdate(data); })
    .catch(() => {});
  initWebSocket();
})();

