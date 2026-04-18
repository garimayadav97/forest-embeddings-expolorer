// ui.js  —  panel state machine, wires everything together

const UI = (() => {
  // ── state ────────────────────────────────────────────────────────────────
  let exemplars    = [];   // [{lat, lon, pixelIdx}]
  let polygonReady = false;
  let tileReady    = false;
  let threshold    = 40;

  // ── lifecycle ────────────────────────────────────────────────────────────
  function init() {
    MAP.init();

    // Forest mask
    $('#btn-load-forest').addEventListener('click', async () => {
      const el = $('#status-forest');
      el.style.display = 'block';
      el.className = 'card';
      el.innerHTML = '<span class="spinner"></span> Querying OSM…';
      try {
        const n = await MAP.loadForestMask();
        el.className = 'card accent';
        el.textContent = n > 0
          ? `✓ ${n} forest polygon${n > 1 ? 's' : ''} loaded — drawing restricted to forest`
          : '⚠ No forest areas found in view — pan/zoom to a forested region';
      } catch (e) {
        el.className = 'card';
        el.style.borderLeftColor = 'var(--danger)';
        el.textContent = e.message === 'zoom_in'
          ? '⚠ View too large — zoom in to zoom level 12+ then retry'
          : 'Error: ' + e.message;
      }
    });
    $('#btn-clear-forest').addEventListener('click', () => {
      MAP.clearForestMask();
      const el = $('#status-forest');
      el.style.display = 'none';
    });

    // Polygon controls
    $('#btn-draw').addEventListener('click', () => {
      MAP.startPolygon();
      setStep(1);
    });
    $('#btn-finish-poly').addEventListener('click', () => {
      MAP.finishPolygon();
    });
    $('#btn-clear').addEventListener('click', () => {
      MAP.clearPolygon();
      exemplars = [];
      polygonReady = tileReady = false;
      renderExemplars();
      setStep(0);
    });

    // Exemplar controls
    $('#btn-add-exemplar').addEventListener('click', () => MAP.startExemplarMode());
    $('#btn-stop-exemplar').addEventListener('click', () => MAP.stopExemplarMode());

    // Run
    $('#btn-run').addEventListener('click', runSimilarity);

    // Reference data
    $('#ref-file').addEventListener('change', uploadRefFile);
    $('#ref-upload-area').addEventListener('click', () => $('#ref-file').click());
    $('#ref-col-select').addEventListener('change', e => applyRefLabels(e.target.value));

    // Threshold slider (0–100 maps to 0.00–1.00 cosine similarity)
    const slider = $('#slider-threshold');
    threshold = parseInt(slider.value) / 100;
    slider.addEventListener('input', () => {
      threshold = parseInt(slider.value) / 100;
      $('#threshold-val').textContent = threshold.toFixed(2);
    });

    setStep(0);
  }

  // ── polygon ready callback (called from map.js) ───────────────────────
  async function onPolygonReady(coords) {
    polygonReady = true;
    setStep(2);
    setStatus('tile', 'loading', 'Fetching TESSERA tile…');

    try {
      const center   = MAP.getPolygonCenter();
      const bbox     = MAP.getPolygonBbox();
      const spanLat  = bbox.maxLat - bbox.minLat;
      const spanLon  = bbox.maxLon - bbox.minLon;
      const size_deg = Math.max(spanLat, spanLon) * 1.3; // 30% padding
      const tile     = await TESSERA.fetchTile(center.lat, center.lon, 2024, size_deg);
      tileReady = true;
      MAP.showTileBbox(tile.west, tile.north, tile.width, tile.height, tile.px_lon, tile.px_lat);
      setStatus('tile', 'ok', `${tile.source} · ${tile.width}×${tile.height}px · ${tile.dim}d`);
      setStep(3);
    } catch (e) {
      setStatus('tile', 'err', 'Failed to load tile: ' + e.message);
    }
  }

  // ── exemplar added callback (called from map.js) ──────────────────────
  async function onExemplarAdded({ lat, lon }) {
    const placeholder = { lat, lon, embedding: null };
    exemplars.push(placeholder);
    renderExemplars();
    if (exemplars.length >= 1) setStep(4);
    try {
      placeholder.embedding = await TESSERA.fetchEmbedding(lat, lon);
    } catch (e) {
      console.warn('Exemplar embedding fetch failed', e);
    }
    renderExemplars();
  }

  function removeExemplar(i) {
    MAP.removeExemplar(i);
    exemplars.splice(i, 1);
    renderExemplars();
    if (exemplars.length === 0) setStep(3);
  }

  function renderExemplars() {
    const list = $('#exemplar-list');
    if (exemplars.length === 0) {
      list.innerHTML = '<div style="font-size:11px;color:var(--muted);padding:4px 0;">No exemplars yet</div>';
      return;
    }
    list.innerHTML = exemplars.map((e, i) => `
      <div class="exemplar-item">
        <div class="exemplar-dot"></div>
        <div class="exemplar-coord">${e.lat.toFixed(4)}, ${e.lon.toFixed(4)}<br>
          <span style="color:var(--accent);font-size:9px;">${e.embedding ? '✓ ready' : '⟳ loading…'}</span>
        </div>
        <div class="exemplar-remove" onclick="UI.removeExemplar(${i})">×</div>
      </div>
    `).join('');
  }

  // ── run similarity ────────────────────────────────────────────────────
  async function runSimilarity() {
    if (!tileReady || exemplars.length === 0) return;

    setStatus('results', 'loading', 'Running cosine similarity…');
    $('#results-section').style.display = 'block';

    const validExemplars = exemplars.filter(e => e.embedding !== null);
    if (validExemplars.length === 0) {
      setStatus('results', 'err', 'Exemplar embeddings still loading — try again in a moment');
      return;
    }

    try {
      const tile   = TESSERA.getTile();
      const exEmbs = validExemplars.map(e => e.embedding);
      const result = await SIMILARITY.run({
        tileId:             tile.tile_id,
        exemplarEmbeddings: exEmbs,
        polygon:            MAP.getPolygon(),
        threshold,
      });

      renderResults(result);
      MAP.showSimilarPixels(result.similar_pixels, TESSERA.getTile());
      $('#results-section').style.display = 'block';
      $('#results-divider').style.display = 'block';

    } catch (e) {
      setStatus('results', 'err', 'Error: ' + e.message);
    }
  }

  function renderResults(r) {
    const pct = r.total_pixels > 0
      ? ((r.similar_count / r.total_pixels) * 100).toFixed(1)
      : 0;
    setStatus('results', 'ok',
      `${r.similar_count} / ${r.total_pixels} pixels match · ${pct}% · cosine ≥ ${r.threshold}`);

    // Histogram: 10 bins 0→1
    const maxCount = Math.max(...r.histogram, 1);
    $('#histogram').innerHTML = r.histogram.map((c, i) => {
      const lo = (i * 0.1).toFixed(1), hi = ((i + 1) * 0.1).toFixed(1);
      const active = (i / 10) >= r.threshold;
      return `<div class="hist-bar ${active ? 'active' : ''}"
        style="height:${Math.round(c / maxCount * 100)}%"
        title="${c} pixels · similarity ${lo}–${hi}"></div>`;
    }).join('');
  }

  // ── label colour palette ─────────────────────────────────────────────
  const PALETTE = [
    '#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6',
    '#1abc9c','#e67e22','#34495e','#e91e63','#00bcd4',
  ];
  let labelColorMap = {};
  let paletteIdx = 0;

  function labelColor(label) {
    if (!label) return '#aaa';
    if (!labelColorMap[label]) {
      labelColorMap[label] = PALETTE[paletteIdx % PALETTE.length];
      paletteIdx++;
    }
    return labelColorMap[label];
  }

  // ── reference data state ─────────────────────────────────────────────
  let refRawPoints = [];   // [{lat, lon, props:{col:val,...}}]
  let refLabelCols = [];   // column names available for labelling

  function applyRefLabels(col) {
    // Reset color assignments for a fresh palette per column
    labelColorMap = {};
    paletteIdx    = 0;

    const points = refRawPoints.map(p => ({
      lat:   p.lat,
      lon:   p.lon,
      label: col ? (p.props[col] || '') : '',
      color: labelColor(col ? (p.props[col] || '') : ''),
    }));

    MAP.showReferencePoints(points);

    // Legend
    const counts = {};
    points.forEach(p => { counts[p.label || '—'] = (counts[p.label || '—'] || 0) + 1; });
    const legend = $('#ref-legend');
    legend.innerHTML = Object.entries(counts).map(([label, n]) =>
      `<div class="ref-legend-item">
        <div class="ref-legend-dot" style="background:${labelColor(label)};"></div>
        <span style="flex:1;">${label}</span>
        <span class="ref-legend-count">${n}</span>
      </div>`
    ).join('');
    legend.style.display = 'block';
  }

  // ── reference file upload ────────────────────────────────────────────
  async function uploadRefFile(e) {
    const file = e.target.files[0];
    if (!file) return;

    setStatus('ref', 'loading', 'Parsing file…');
    const fd = new FormData();
    fd.append('file', file);

    try {
      const res  = await fetch('http://localhost:5001/api/reference-points', {
        method: 'POST', body: fd,
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      console.log('[ref] server response:', data);
      refRawPoints = data.points;
      refLabelCols = data.label_cols || [];

      // Populate column dropdown
      const wrap   = $('#ref-col-wrap');
      const select = $('#ref-col-select');
      select.innerHTML = refLabelCols.map(c =>
        `<option value="${c}">${c}</option>`
      ).join('');
      wrap.style.display = refLabelCols.length ? 'block' : 'none';

      // Initial render with first column
      applyRefLabels(refLabelCols[0] || '');
      const crsNote = data.crs && data.crs !== 'WGS84' ? ` · ${data.crs}` : '';
      setStatus('ref', 'ok', `${data.count} points loaded · ${refLabelCols.length} columns${crsNote}`);
      $('#results-divider').style.display = 'block';
    } catch (err) {
      setStatus('ref', 'err', err.message);
    }
  }

  // ── step indicator ────────────────────────────────────────────────────
  function setStep(n) {
    const pills = document.querySelectorAll('.step-pill');
    pills.forEach((p, i) => {
      p.classList.toggle('done',   i < n);
      p.classList.toggle('active', i === n);
    });
    // Toggle visibility of panel sections
    $$('.step-section').forEach(s => {
      const req = parseInt(s.dataset.step || 0);
      s.style.display = req <= n ? 'block' : 'none';
    });
  }

  // ── status helpers ────────────────────────────────────────────────────
  function setStatus(id, type, msg) {
    const el = $(`#status-${id}`);
    if (!el) return;
    el.style.display = 'block';
    el.className = `card ${type === 'ok' ? 'accent' : type === 'err' ? '' : ''}`;
    el.style.borderLeftColor = type === 'ok' ? 'var(--accent)' : type === 'err' ? 'var(--danger)' : 'var(--warn)';
    el.innerHTML = type === 'loading'
      ? `<span class="spinner"></span> ${msg}`
      : msg;
  }

  // ── helpers ───────────────────────────────────────────────────────────
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);

  function onForestViolation() {
    const tip = document.getElementById('mode-tip');
    const orig = tip.textContent;
    tip.textContent = '⚠ Click inside a forest area';
    tip.style.color = 'var(--danger)';
    tip.style.borderColor = 'var(--danger)';
    setTimeout(() => {
      tip.textContent = orig;
      tip.style.color = '';
      tip.style.borderColor = '';
    }, 1500);
  }

  return { init, onPolygonReady, onExemplarAdded, removeExemplar, onForestViolation };
})();

document.addEventListener('DOMContentLoaded', UI.init);
