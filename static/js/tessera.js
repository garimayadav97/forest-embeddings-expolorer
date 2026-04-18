// tessera.js  —  tile fetching + embedding storage

const TESSERA = (() => {
  const API = 'http://localhost:5001';

  let currentTile = null;   // { lat, lon, width, height, dim, source }
  let embeddings  = null;   // Float32Array-like, flattened (N × D)

  async function fetchTile(lat, lon, year = 2024, size_deg = 0.0089) {
    const res = await fetch(`${API}/api/tile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, year, size_deg }),
    });
    if (!res.ok) throw new Error(`Server ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (!data.tile_id) throw new Error('No tile data returned');
    currentTile = {
      lat: data.lat, lon: data.lon,
      width: data.width, height: data.height,
      size_deg: data.size_deg,
      west: data.west, north: data.north,
      px_lon: data.px_lon, px_lat: data.px_lat,
      dim: data.dim, source: data.source,
      tile_id: data.tile_id,
    };
    embeddings = null;   // embeddings live server-side now
    return currentTile;
  }

  function latLonToPixelIdx(lat, lon) {
    if (!currentTile) return null;
    const { lat: tLat, lon: tLon, width, height, size_deg } = currentTile;
    const deg = size_deg / width;
    const halfW = size_deg / 2;
    const halfH = size_deg / 2;
    const px = Math.round((lon - (tLon - halfW)) / deg);
    const py = Math.round(((tLat + halfH) - lat) / deg);
    if (px < 0 || px >= width || py < 0 || py >= height) return null;
    return py * width + px;
  }

  function getEmbeddingsForPolygon(polygonCoords) {
    if (!currentTile || !embeddings) return { indices: [], subset: [] };
    const { lat: tLat, lon: tLon, width, height, size_deg } = currentTile;
    const deg  = size_deg / width;
    const halfW = size_deg / 2;
    const halfH = size_deg / 2;

    // Build a simple point-in-polygon check
    const poly = polygonCoords.map(([lat, lon]) => ({ x: lon, y: lat }));

    const indices = [];
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const pLat = tLat + halfH - py * deg;
        const pLon = tLon - halfW + px * deg;
        if (pointInPoly(pLon, pLat, poly)) {
          indices.push(py * width + px);
        }
      }
    }
    const subset = indices.map(i => embeddings[i]);
    return { indices, subset };
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y;
      const xj = poly[j].x, yj = poly[j].y;
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  async function fetchEmbedding(lat, lon, year = 2024) {
    const res = await fetch(`${API}/api/embedding`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat, lon, year }),
    });
    if (!res.ok) throw new Error(`Server ${res.status}`);
    const data = await res.json();
    return data.embedding;  // float[]
  }

  return {
    fetchTile,
    fetchEmbedding,
    latLonToPixelIdx,
    getEmbeddingsForPolygon,
    getEmbeddings: () => embeddings,
    getTile:       () => currentTile,
  };
})();
