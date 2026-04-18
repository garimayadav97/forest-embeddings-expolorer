# Forest Embeddings Explorer

An interactive web tool for forest habitat similarity search using [TESSERA](https://github.com/ucam-eo/geotessera) satellite-derived forest embeddings. Draw a study polygon on a satellite map, click reference pixels anywhere on the map as exemplars, and instantly find all pixels within your polygon that share similar forest structure — ranked by cosine similarity.

![workflow](https://img.shields.io/badge/status-active-brightgreen) ![python](https://img.shields.io/badge/python-3.9%2B-blue) ![flask](https://img.shields.io/badge/flask-3.x-lightgrey)

<video src="examples/demo.mp4" controls width="100%"></video>

---

## What it does

TESSERA encodes satellite imagery into 128-dimensional embeddings that capture forest structure, species composition, and canopy characteristics. This tool lets you:

- **Draw a study area** polygon on a satellite basemap
- **Set exemplar points** by clicking pixels anywhere on the map — the tool fetches their real TESSERA embeddings
- **Run cosine similarity** to find all pixels inside the polygon that structurally resemble your exemplars
- **Visualise results** as a colour-coded overlay (green = high similarity, red = low) with a similarity histogram
- **Overlay field / inventory data** from a CSV or Excel file — points are auto-reprojected from UTM to WGS84 if needed
- **Restrict drawing to forest** by loading an OpenStreetMap forest mask for the current view

---

## How it works

```
Browser                          Flask backend (localhost:5001)
───────                          ──────────────────────────────
Draw polygon          POST         /api/tile
                                   fetch_mosaic_for_region(bbox)
                                   crop to polygon bbox at native res
                                   downsample to ≤128×128
                                   cache embeddings (UUID tile_id)
                      returns      tile_id, bounds, dimensions

Click exemplar        POST         /api/embedding
                                   sample_embeddings_at_points(lon, lat)
                      returns      128-d float vector

Run similarity        POST         /api/similarity
                                   load tile from cache
                                   filter pixels inside polygon (ray cast)
                                   L2-normalise embeddings
                                   cosine similarity vs exemplars
                                   threshold + histogram
                      returns      similar_pixels [{idx, sim}]
```



## Project structure

```
tessera-explorer/
├── app.py                   ← Flask backend (tile fetch, similarity, OSM proxy)
├── requirements.txt
├── sample_points.csv        ← Example reference points (UTM Zone 19N)
├── static/
│   ├── css/style.css        ← Dark-theme UI
│   └── js/
│       ├── map.js           ← Leaflet map, polygon draw, forest mask
│       ├── tessera.js       ← Tile fetch + embedding API calls
│       ├── similarity.js    ← Similarity search API call
│       └── ui.js            ← Panel state machine, wires everything together
└── templates/
    └── index.html           ← Single-page app shell
```

---

## Setup

### Requirements

- Python 3.9+
- `geotessera` (TESSERA library — install separately per its own instructions)
- Dependencies listed in `requirements.txt`

```bash
pip install -r requirements.txt
```

### Run

```bash
python app.py
# Open http://localhost:5001
```

---

## Workflow

### 1 · Forest Mask *(optional)*
Click **Load Mask** to fetch OpenStreetMap forest polygons for the current view. Drawing will be restricted to forested areas. Use the location search bar (top right) to navigate to your area of interest first.

### 2 · Draw Study Area
Click **Draw Polygon** and place vertices on the map. Double-click to close. The tool automatically fetches the TESSERA tile for that area, cropped to your polygon's bounding box at native resolution (~10 m/pixel) before downsampling.

### 3 · Set Exemplars
Click **Add Exemplar** then click pixels anywhere on the map that represent the forest type you want to find. Each click fetches the real TESSERA embedding at that location. Add as many exemplars as needed — similarity is computed as the max cosine similarity across all exemplars.

### 4 · Run Similarity Search
Adjust the **Min similarity** threshold (0–1) and click **Run Search**. The map overlays matching pixels colour-coded by similarity score. The histogram shows the full distribution across all polygon pixels.

### 5 · Reference Data *(optional)*
Upload a CSV or Excel file with field-collected or inventory points via the **Reference Data** panel. Required columns: `lat`, `lon` (decimal degrees or UTM projected — auto-reprojected). Use the **Label column** dropdown to choose which attribute to display as floating map labels.

---

## Reference data format

| lat | lon | species | year |
|-----|-----|---------|------|
| 45.123 | -68.456 | Balsam Fir | 2022 |
| ... | ... | ... | ... |

- Coordinates can be **WGS84 decimal degrees** or **UTM projected** (any zone) — the backend auto-detects and reprojects using `pyproj`
- Any column beyond `lat`/`lon` is available as a label in the dropdown
- Supports `.csv`, `.xlsx`, `.xls`

---

## Configuration

| Variable | Location | Default | Description |
|----------|----------|---------|-------------|
| `EMBED_DIM` | `app.py` | `128` | TESSERA embedding dimensions |
| `MAX_PX` | `app.py` | `128` | Max tile width/height after downsampling |
| `API` | `tessera.js`, `similarity.js` | `http://localhost:5001` | Backend URL |

---

## Notes

- TESSERA tiles snap to a 0.1° grid — if your polygon is in an area without coverage, the backend returns a helpful error with the nearest covered location
- Large data directories (`global_0.1_degree_*`) are excluded from version control via `.gitignore`
- The OSM forest mask requires zoom level 12+ (view span < 0.5°) to avoid Overpass API timeouts
