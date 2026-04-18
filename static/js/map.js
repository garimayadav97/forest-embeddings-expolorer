// map.js  —  Leaflet map + polygon draw + exemplar click

const MAP = (() => {
  let map, drawnPolygon, exemplarMarkers = [], similarMarkers = [];
  let mode = 'idle'; // idle | polygon | exemplar
  let drawCoords = [];
  let tempLine = null;

  // ── point-in-polygon (ray casting) ──────────────────────────────────────
  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  }

  // ── forest mask ──────────────────────────────────────────────────────────
  let forestLayers  = [];   // Leaflet polygon layers
  let forestGeoms   = [];   // [{poly:[{x,y}]}] for point-in-polygon tests
  let maskLayer     = null; // dark canvas overlay
  let forestLoaded  = false;

  // ── init ────────────────────────────────────────────────────────────────
  function init() {
    map = L.map('map-container', {
      center: [45.5, -68.5],
      zoom: 9,
      zoomControl: true,
    });

    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles © Esri — Source: Esri, Maxar, Earthstar Geographics',
      maxZoom: 19,
    }).addTo(map);

    map.on('click', onMapClick);
    map.on('mousemove', onMouseMove);
  }

  // ── mode helpers ─────────────────────────────────────────────────────────
  function setMode(m) {
    mode = m;
    const el = document.getElementById('map');
    el.className = m !== 'idle' ? `mode-${m}` : '';
    document.getElementById('mode-tip').style.opacity =
      m === 'idle' ? '0' : '1';
    document.getElementById('mode-tip').textContent =
      m === 'polygon'  ? 'Click to add vertices — double-click to close polygon' :
      m === 'exemplar' ? 'Click pixels outside polygon to set exemplars' : '';
  }

  // ── draw polygon ─────────────────────────────────────────────────────────
  function startPolygon() {
    clearPolygon();
    drawCoords = [];
    setMode('polygon');
  }

  function onMapClick(e) {
    if (mode === 'polygon') {
      if (!isInsideForest(e.latlng.lat, e.latlng.lng)) {
        UI.onForestViolation && UI.onForestViolation();
        return;
      }
      drawCoords.push([e.latlng.lat, e.latlng.lng]);
      redrawTempPoly();
    } else if (mode === 'exemplar') {
      addExemplar(e.latlng.lat, e.latlng.lng);
    }
  }

  function onMouseMove(e) {
    if (mode !== 'polygon' || drawCoords.length === 0) return;
    if (tempLine) map.removeLayer(tempLine);
    const preview = [...drawCoords, [e.latlng.lat, e.latlng.lng]];
    tempLine = L.polyline(preview, { color: '#3ddc84', weight: 1.5, dashArray: '5,5', opacity: 0.7 }).addTo(map);
  }

  function redrawTempPoly() {
    if (drawnPolygon) map.removeLayer(drawnPolygon);
    if (drawCoords.length < 2) return;
    drawnPolygon = L.polygon(drawCoords, {
      color: '#3ddc84', weight: 2, opacity: 0.9,
      fillColor: '#3ddc84', fillOpacity: 0.06,
    }).addTo(map);
  }

  function finishPolygon() {
    if (drawCoords.length < 3) return false;
    if (tempLine) { map.removeLayer(tempLine); tempLine = null; }
    redrawTempPoly();
    setMode('idle');
    UI.onPolygonReady(drawCoords);
    return true;
  }

  function clearPolygon() {
    if (drawnPolygon) { map.removeLayer(drawnPolygon); drawnPolygon = null; }
    if (tempLine)     { map.removeLayer(tempLine);     tempLine     = null; }
    drawCoords = [];
    clearExemplars();
    clearSimilarMarkers();
  }

  // ── exemplar markers ─────────────────────────────────────────────────────
  function startExemplarMode() { setMode('exemplar'); }
  function stopExemplarMode()  { setMode('idle'); }

  function addExemplar(lat, lon) {
    const icon = L.divIcon({
      className: '', iconSize: [12, 12], iconAnchor: [6, 6],
      html: '<div class="exemplar-marker"></div>',
    });
    const m = L.marker([lat, lon], { icon }).addTo(map);
    exemplarMarkers.push({ marker: m, lat, lon });
    UI.onExemplarAdded({ lat, lon });
  }

  function removeExemplar(index) {
    if (exemplarMarkers[index]) {
      map.removeLayer(exemplarMarkers[index].marker);
      exemplarMarkers.splice(index, 1);
    }
  }

  function clearExemplars() {
    exemplarMarkers.forEach(e => map.removeLayer(e.marker));
    exemplarMarkers = [];
  }

  // ── similarity overlay ───────────────────────────────────────────────────
  function showSimilarPixels(pixels, tileMeta) {
    clearSimilarMarkers();
    const { west, north, px_lon, px_lat, width } = tileMeta;

    // Normalise sim scores to [0,1] relative to actual range for better color spread
    const sims   = pixels.map(p => p.sim);
    const simMin = Math.min(...sims);
    const simMax = Math.max(...sims);
    const simRange = simMax - simMin || 1;

    pixels.forEach(({ idx, sim }) => {
      const py   = Math.floor(idx / width);
      const px   = idx % width;
      const pLat = north - (py + 0.5) * px_lat;
      const pLon = west  + (px + 0.5) * px_lon;

      const t       = (sim - simMin) / simRange;   // 0 = lowest match, 1 = highest
      const hue     = Math.round(120 * t);          // red → green
      const opacity = Math.max(0.35, 0.4 + t * 0.6);
      const color   = `hsla(${hue}, 90%, 50%, ${opacity})`;
      const border  = `hsl(${hue}, 90%, 35%)`;

      const icon = L.divIcon({
        className: '',
        iconSize:  [10, 10],
        iconAnchor:[5, 5],
        html: `<div class="pixel-highlight" style="background:${color};border-color:${border};"></div>`,
      });
      const m = L.marker([pLat, pLon], { icon, interactive: false }).addTo(map);
      similarMarkers.push(m);
    });
  }

  function clearSimilarMarkers() {
    similarMarkers.forEach(m => map.removeLayer(m));
    similarMarkers = [];
  }

  // ── reference points ─────────────────────────────────────────────────────
  let refMarkers = [];
  function showReferencePoints(points) {
    refMarkers.forEach(m => map.removeLayer(m));
    refMarkers = [];

    if (!points || !points.length) return;
    console.log('[map] showReferencePoints', points.length, 'pts, first:', JSON.stringify(points[0]));

    points.forEach(p => {
      if (p.lat == null || p.lon == null || isNaN(p.lat) || isNaN(p.lon)) return;
      const color = p.color || '#ffb740';
      const label = String(p.label || '');

      // dot — circleMarker is the most reliable Leaflet primitive
      const dot = L.circleMarker([p.lat, p.lon], {
        radius: 5, fillColor: color, color: '#000',
        weight: 1.5, fillOpacity: 0.9, interactive: false,
      }).addTo(map);
      refMarkers.push(dot);

      // label — tooltip opened manually after addTo
      if (label) {
        dot.bindTooltip(label, {
          permanent:  true,
          direction:  'right',
          offset:     [8, 0],
          className:  'ref-label',
          interactive: false,
        });
        dot.addTo(map);   // ensure it's on the map before openTooltip
        dot.openTooltip();
      }
    });

    // Zoom map to show all loaded points
    const lats = points.map(p => p.lat);
    const lons = points.map(p => p.lon);
    map.fitBounds(
      [[Math.min(...lats), Math.min(...lons)],
       [Math.max(...lats), Math.max(...lons)]],
      { padding: [60, 60], maxZoom: 14 }
    );
  }

  // ── tile bounding box preview ─────────────────────────────────────────────
  let tileBbox = null;
  function showTileBbox(west, north, width, height, pxLon, pxLat) {
    if (tileBbox) map.removeLayer(tileBbox);
    const south = north - height * pxLat;
    const east  = west  + width  * pxLon;
    tileBbox = L.rectangle(
      [[south, west], [north, east]],
      { color: '#00bfa5', weight: 1, fillOpacity: 0, dashArray: '4,4' }
    ).addTo(map);
  }

  // ── forest mask ──────────────────────────────────────────────────────────
  async function loadForestMask() {
    const b = map.getBounds();
    const south = b.getSouth(), west = b.getWest();
    const north = b.getNorth(), east = b.getEast();

    const resp = await fetch('http://localhost:5001/api/forest-mask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ south, west, north, east }),
    });

    if (resp.status === 400) {
      throw new Error('zoom_in');
    }
    if (!resp.ok) throw new Error('Server error ' + resp.status);
    const data = await resp.json();

    clearForestMask();
    let count = 0;
    data.elements.forEach(el => {
      if (el.type !== 'way' || !el.geometry || el.geometry.length < 3) return;
      const latlngs = el.geometry.map(p => [p.lat, p.lon]);
      const layer = L.polygon(latlngs, {
        color:       '#3ddc84',
        weight:      1.2,
        opacity:     0.7,
        fillColor:   '#3ddc84',
        fillOpacity: 0.15,
        interactive: false,
      }).addTo(map);
      forestLayers.push(layer);
      forestGeoms.push(el.geometry.map(p => ({ x: p.lon, y: p.lat })));
      count++;
    });

    // dark inverse mask
    if (!maskLayer) {
      maskLayer = L.rectangle(
        [[-90,-180],[90,180]],
        { color: 'transparent', fillColor: '#000', fillOpacity: 0.40, interactive: false }
      ).addTo(map);
      maskLayer.bringToBack();
      forestLayers.forEach(l => l.bringToFront());
    }

    forestLoaded = count > 0;
    return count;
  }

  function clearForestMask() {
    forestLayers.forEach(l => map.removeLayer(l));
    forestLayers = [];
    forestGeoms  = [];
    if (maskLayer) { map.removeLayer(maskLayer); maskLayer = null; }
    forestLoaded = false;
  }

  function isInsideForest(lat, lon) {
    if (!forestLoaded || forestGeoms.length === 0) return true; // no mask → allow all
    return forestGeoms.some(poly => pointInPoly(lon, lat, poly));
  }

  function getPolygonCenter() {
    if (!drawnPolygon) return null;
    const c = drawnPolygon.getBounds().getCenter();
    return { lat: c.lat, lon: c.lng };
  }

  function getPolygonBbox() {
    if (!drawnPolygon) return null;
    const b = drawnPolygon.getBounds();
    return { minLat: b.getSouth(), maxLat: b.getNorth(),
             minLon: b.getWest(),  maxLon: b.getEast() };
  }

  return {
    init, startPolygon, finishPolygon, clearPolygon,
    startExemplarMode, stopExemplarMode, removeExemplar,
    showSimilarPixels, clearSimilarMarkers, showReferencePoints,
    showTileBbox, getPolygonCenter,
    loadForestMask, clearForestMask,
    getPolygon: () => drawCoords,
    getPolygonBbox,
    getExemplars: () => exemplarMarkers.map(e => ({ lat: e.lat, lon: e.lon })),
    get map() { return map; },
  };
})();
