// Direct Beam Tracker Viewer — Frontend Client
(function() {
  const BEAM_COLORS = [
    '#00e5ff', '#ff9100', '#00e676', '#d500f9',
    '#ff1744', '#ffea00', '#2979ff', '#ff4081'
  ];

  let currentStatus = null;
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
        handleStatusUpdate(data);
      } catch (err) {
        console.error('Failed to parse status payload', err);
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
      } catch (e) {
        setConnectionState('disconnected', 'Disconnected');
      }
    }, 2000);
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
  }

  function updateBeamSelects(beams) {
    const prevLm = lmBeamSelect.value;
    const prevCel = celBeamSelect.value;

    lmBeamSelect.innerHTML = '';
    celBeamSelect.innerHTML = '';

    const ids = beams.length > 0 ? beams.map(b => b.beam_id) : [0];
    ids.forEach(id => {
      const optLm = document.createElement('option');
      optLm.value = id;
      optLm.textContent = `Beam ${id}`;
      lmBeamSelect.appendChild(optLm);

      const optCel = document.createElement('option');
      optCel.value = id;
      optCel.textContent = `Beam ${id}`;
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

      tr.innerHTML = `
        <td style="color: ${color}; font-weight: bold;">● Beam ${b.beam_id}</td>
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
    if (isNaN(val) || val < 1 || val > 8) {
      showToast('Active beams must be between 1 and 8', true);
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

  // Initial draw & connect
  drawSkyMap();
  initWebSocket();
})();
