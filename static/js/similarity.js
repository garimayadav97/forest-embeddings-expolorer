// similarity.js  —  cosine similarity search via backend

const SIMILARITY = (() => {
  const API = 'http://localhost:5001';

  async function run({ tileId, exemplarEmbeddings, polygon, threshold }) {
    const body = { tile_id: tileId, threshold };
    if (exemplarEmbeddings) body.exemplar_embeddings = exemplarEmbeddings;
    if (polygon)            body.polygon             = polygon;
    const res = await fetch(`${API}/api/similarity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Server ${res.status}`);
    }
    return res.json();
  }

  return { run };
})();
