#!/usr/bin/env python3
"""TESSERA Explorer — Flask backend (real tiles only)"""
from flask import Flask, jsonify, request, render_template
from flask_cors import CORS
import numpy as np
import pandas as pd
import json
import urllib.request
import urllib.parse

app = Flask(__name__)
CORS(app)

# ── GeoTessera ─────────────────────────────────────────────────────────────
from geotessera import GeoTessera
GT = GeoTessera()
print("✓ GeoTessera ready")

EMBED_DIM  = 128
MAX_PX     = 128  # keep tile responses small

# Server-side tile cache: tile_id → np.ndarray (N, D)
import uuid
_TILE_CACHE: dict = {}

# ── ROUTES ─────────────────────────────────────────────────────────────────
@app.route("/")
def index():
    return render_template("index.html")

@app.route("/api/tile", methods=["POST"])
def api_tile():
    d        = request.json
    lat      = float(d["lat"])
    lon      = float(d["lon"])
    year     = int(d.get("year", 2024))
    size_deg = float(d.get("size_deg", 0.1))
    size_deg = min(max(size_deg, 0.001), 0.5)

    half = size_deg / 2
    bbox = (lon - half, lat - half, lon + half, lat + half)  # (min_lon, min_lat, max_lon, max_lat)

    try:
        mosaic, transform, crs = GT.fetch_mosaic_for_region(bbox, year=year)
        H, W, D = mosaic.shape
        print(f"  mosaic raw {W}×{H}, transform: c={transform.c:.4f} f={transform.f:.4f} a={transform.a} e={transform.e}")

        if H == 0 or W == 0:
            return jsonify({"error": "No TESSERA data for this area/year"}), 404

        # Derive actual geographic bounds from the affine transform
        west   = transform.c
        north  = transform.f
        px_lon = abs(transform.a)
        px_lat = abs(transform.e)

        # Validate that the returned tile actually overlaps our requested bbox
        tile_south = north - H * px_lat
        tile_east  = west  + W * px_lon
        overlap = not (tile_east  < lon - half or west        > lon + half or
                       tile_south > lat + half or north       < lat - half)
        if not overlap:
            return jsonify({
                "error": f"No TESSERA coverage at this location for {year}. "
                         f"The nearest tile is at "
                         f"lat {(north+tile_south)/2:.2f}, lon {(west+tile_east)/2:.2f}. "
                         f"Pan the map to a forested area with TESSERA coverage and try again.",
            }), 404

        # Crop to requested bbox at native resolution before downsampling
        req_west  = lon - half
        req_east  = lon + half
        req_north = lat + half
        req_south = lat - half

        c0 = max(0, int((req_west  - west)  / px_lon))
        c1 = min(W, int((req_east  - west)  / px_lon) + 1)
        r0 = max(0, int((north - req_north) / px_lat))
        r1 = min(H, int((north - req_south) / px_lat) + 1)

        if c1 > c0 and r1 > r0:
            mosaic = mosaic[r0:r1, c0:c1]
            west   = west  + c0 * px_lon
            north  = north - r0 * px_lat
            H, W   = mosaic.shape[:2]
            print(f"  cropped to {W}×{H} at native res (c0={c0} c1={c1} r0={r0} r1={r1})")

        # Geographic extent in degrees (constant regardless of downsampling)
        extent_lon = W * px_lon
        extent_lat = H * px_lat

        # Downsample to MAX_PX (nearest-neighbour)
        if max(H, W) > MAX_PX:
            H_new  = min(H, MAX_PX)
            W_new  = min(W, MAX_PX)
            h_idx  = np.round(np.linspace(0, H - 1, H_new)).astype(int)
            w_idx  = np.round(np.linspace(0, W - 1, W_new)).astype(int)
            mosaic = mosaic[np.ix_(h_idx, w_idx)]
            H, W   = H_new, W_new

        # Recompute pixel size from fixed extent / new dimensions
        px_lon = extent_lon / W
        px_lat = extent_lat / H

        mosaic = np.nan_to_num(mosaic, nan=0.0)
        emb    = mosaic.reshape(-1, D).astype(np.float32)
        print(f"  ✓ tile {W}×{H} px, {D}d  west={west:.4f} north={north:.4f} px={px_lon:.6f}")

        # Cache embeddings + geo info server-side
        tile_id = str(uuid.uuid4())
        _TILE_CACHE.clear()
        _TILE_CACHE[tile_id] = {
            "emb":     emb,
            "width":   W,
            "height":  H,
            "west":    west,
            "north":   north,
            "px_lon":  px_lon,
            "px_lat":  px_lat,
        }

        return jsonify({
            "lat": lat, "lon": lon, "year": year,
            "size_deg": size_deg,
            "west": west, "north": north,
            "px_lon": px_lon, "px_lat": px_lat,
            "width": W, "height": H,
            "dim": D,
            "tile_id": tile_id,
            "source": "TESSERA",
        })
    except Exception as e:
        print(f"  ✗ tile error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/embedding", methods=["POST"])
def api_embedding():
    """Single-pixel embedding at a lat/lon via point sampling."""
    d    = request.json
    lat  = float(d["lat"])
    lon  = float(d["lon"])
    year = int(d.get("year", 2024))

    try:
        emb = GT.sample_embeddings_at_points([(lon, lat)], year=year)
        vec = emb[0]
        if np.any(np.isnan(vec)):
            return jsonify({"error": "no_coverage"}), 404
        return jsonify({"embedding": vec.tolist()})
    except Exception as e:
        print(f"  ✗ embedding error: {e}")
        return jsonify({"error": str(e)}), 500

@app.route("/api/similarity", methods=["POST"])
def api_similarity():
    d         = request.json
    tile_id   = d.get("tile_id")
    threshold = float(d.get("threshold", 0.60))

    if tile_id not in _TILE_CACHE:
        return jsonify({"error": "Tile not found — please reload the tile first"}), 400

    cache  = _TILE_CACHE[tile_id]
    emb    = cache["emb"]                   # (N, D)
    W      = cache["width"]
    H      = cache["height"]
    west   = cache["west"]
    north  = cache["north"]
    px_lon = cache["px_lon"]
    px_lat = cache["px_lat"]

    # ── filter to polygon pixels only ──────────────────────────────────────
    polygon = d.get("polygon")              # [[lat, lon], ...]
    if polygon and len(polygon) >= 3:
        poly_xy = [(p[1], p[0]) for p in polygon]   # (lon, lat) pairs

        def _in_poly(x, y):
            inside = False
            n = len(poly_xy)
            j = n - 1
            for i in range(n):
                xi, yi = poly_xy[i]
                xj, yj = poly_xy[j]
                if ((yi > y) != (yj > y)) and (x < (xj - xi) * (y - yi) / (yj - yi) + xi):
                    inside = not inside
                j = i
            return inside

        poly_idx = []
        tile_south = north - H * px_lat
        tile_east  = west  + W * px_lon
        print(f"  tile bounds: W={west:.4f} E={tile_east:.4f} S={tile_south:.4f} N={north:.4f}")
        poly_lats = [p[0] for p in polygon]
        poly_lons = [p[1] for p in polygon]
        print(f"  poly bounds: W={min(poly_lons):.4f} E={max(poly_lons):.4f} "
              f"S={min(poly_lats):.4f} N={max(poly_lats):.4f}")

        for py in range(H):
            pLat = north - (py + 0.5) * px_lat
            for px_col in range(W):
                pLon = west + (px_col + 0.5) * px_lon
                if _in_poly(pLon, pLat):
                    poly_idx.append(py * W + px_col)

        print(f"  polygon pixels found: {len(poly_idx)} / {H*W}")
        poly_idx = np.array(poly_idx, dtype=np.int32)

        if len(poly_idx) == 0:
            return jsonify({
                "error": "No tile pixels overlap the polygon. "
                         "The TESSERA tile may not cover this area — try a different location.",
                "tile_bounds": {"west": west, "east": tile_east,
                                "south": tile_south, "north": north},
            }), 400

        emb_poly = emb[poly_idx]
    else:
        poly_idx = np.arange(len(emb), dtype=np.int32)
        emb_poly = emb

    # L2-normalise
    norms    = np.linalg.norm(emb_poly, axis=1, keepdims=True)
    norms    = np.where(norms == 0, 1.0, norms)
    emb_n    = emb_poly / norms

    if "exemplar_embeddings" in d:
        ref = np.array(d["exemplar_embeddings"], dtype=np.float32)
    else:
        ref = emb_poly[d["exemplar_indices"]]

    ref_norms = np.linalg.norm(ref, axis=1, keepdims=True)
    ref_norms = np.where(ref_norms == 0, 1.0, ref_norms)
    ref_n     = ref / ref_norms

    # Cosine similarity — max across exemplars → (P,)
    sims = (emb_n @ ref_n.T).max(axis=1).astype(float)

    mask = sims >= threshold
    similar_pixels = [
        {"idx": int(poly_idx[i]), "sim": round(float(sims[i]), 4)}
        for i in np.where(mask)[0]
    ]

    counts, _ = np.histogram(sims, bins=np.linspace(0, 1, 11))

    return jsonify({
        "similar_pixels": similar_pixels,
        "similar_count":  len(similar_pixels),
        "total_pixels":   int(len(poly_idx)),
        "threshold":      threshold,
        "histogram":      counts.tolist(),
        "sim_min":        round(float(sims.min()), 4),
        "sim_max":        round(float(sims.max()), 4),
    })

def _reproject_to_wgs84(df, lat_col, lon_col):
    """Detect projected coordinates and reproject to WGS84.
    Returns (df_with_wgs84_coords, crs_note_string).
    If already geographic, returns (df, 'WGS84').
    """
    try:
        lats = pd.to_numeric(df[lat_col], errors='coerce').dropna()
        lons = pd.to_numeric(df[lon_col], errors='coerce').dropna()
        if lats.empty or lons.empty:
            return df, "WGS84"

        # Already geographic?
        if lats.between(-90, 90).all() and lons.between(-180, 180).all():
            return df, "WGS84"

        # Looks projected — easting is in lon_col, northing in lat_col
        avg_e = float(lons.mean())
        avg_n = float(lats.mean())
        hemisphere_base = 32600 if avg_n > 0 else 32700   # N or S UTM

        from pyproj import Transformer
        for zone in range(1, 61):
            epsg = hemisphere_base + zone
            try:
                t = Transformer.from_crs(f"EPSG:{epsg}", "EPSG:4326", always_xy=True)
                test_lon, test_lat = t.transform(avg_e, avg_n)
                # For UTM zone Z, central meridian = 6Z−183, range [6Z−186, 6Z−180]
                if (6*zone - 186) <= test_lon <= (6*zone - 180):
                    # Correct zone found — reproject all rows
                    e_vals = pd.to_numeric(df[lon_col], errors='coerce').fillna(avg_e).values
                    n_vals = pd.to_numeric(df[lat_col], errors='coerce').fillna(avg_n).values
                    new_lons, new_lats = t.transform(e_vals, n_vals)
                    df = df.copy()
                    df[lon_col] = new_lons
                    df[lat_col] = new_lats
                    note = f"auto-reprojected EPSG:{epsg} → WGS84"
                    print(f"  ✓ {note}  (zone {zone}, sample: {test_lat:.4f}°N {test_lon:.4f}°E)")
                    return df, note
            except Exception:
                continue

        return df, "unknown projection (could not reproject)"
    except Exception as ex:
        print(f"  CRS detection error: {ex}")
        return df, "WGS84"


@app.route("/api/reference-points", methods=["POST"])
def api_reference_points():
    if "file" not in request.files:
        return jsonify({"error": "no file"}), 400
    f    = request.files["file"]
    name = f.filename.lower()
    try:
        df = pd.read_csv(f) if name.endswith(".csv") else pd.read_excel(f)
        df.columns = [c.strip().lower() for c in df.columns]
        lat_col = next((c for c in df.columns if "lat" in c), None)
        lon_col = next((c for c in df.columns if "lon" in c), None)
        if not lat_col or not lon_col:
            return jsonify({"error": "Need lat/lon columns"}), 400

        # Auto-reproject if coordinates are not WGS84
        df, crs_note = _reproject_to_wgs84(df, lat_col, lon_col)
        print(f"  ref file cols: {list(df.columns)}  lat={lat_col} lon={lon_col}  crs={crs_note}")

        label_cols = [c for c in df.columns if c not in (lat_col, lon_col)]
        rows = []
        for _, r in df.iterrows():
            try:
                props = {}
                for c in label_cols:
                    try:
                        props[c] = '' if pd.isna(r[c]) else str(r[c])
                    except Exception:
                        props[c] = ''
                rows.append({
                    "lat":   float(r[lat_col]),
                    "lon":   float(r[lon_col]),
                    "props": props,
                })
            except Exception:
                pass
        return jsonify({"points": rows, "count": len(rows),
                        "label_cols": label_cols, "crs": crs_note})
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route("/api/forest-mask", methods=["POST"])
def api_forest_mask():
    d = request.json
    s, w, n, e = d["south"], d["west"], d["north"], d["east"]
    if (n - s) > 0.5 or (e - w) > 0.5:
        return jsonify({"error": "zoom_in"}), 400

    query = f"""[out:json][timeout:20][maxsize:2000000];
(
  way["natural"="wood"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});
  way["landuse"="forest"]({s:.5f},{w:.5f},{n:.5f},{e:.5f});
);
out geom;"""

    try:
        data = urllib.parse.urlencode({"data": query}).encode()
        req  = urllib.request.Request(
            "https://overpass-api.de/api/interpreter",
            data=data,
            headers={"User-Agent": "TESSERA-Explorer/1.0"},
        )
        with urllib.request.urlopen(req, timeout=25) as resp:
            result = json.loads(resp.read())
        return jsonify(result)
    except Exception as ex:
        return jsonify({"error": str(ex)}), 502

@app.route("/health")
def health():
    return jsonify({"ok": True, "tessera": True})

if __name__ == "__main__":
    print("Open http://localhost:5001")
    app.run(debug=True, port=5001)
