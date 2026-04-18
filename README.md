# TESSERA Explorer

Interactive forest embedding similarity search tool.

## Structure

```
tessera-explorer/
├── app.py                  ← Flask backend
├── requirements.txt
├── static/
│   ├── css/style.css
│   └── js/
│       ├── map.js          ← Leaflet map + polygon drawing
│       ├── tessera.js      ← Tile fetching + embedding logic
│       ├── similarity.js   ← Hamming distance search
│       └── ui.js           ← Panel state machine
├── templates/
│   └── index.html
└── data/
    └── sample_points.csv   ← Optional reference data
```

## Run

```bash
pip install -r requirements.txt
python app.py
# Open http://localhost:5001
```

## Workflow

1. **Draw polygon** on map to define study area
2. **Click exemplar pixels** outside the box to set reference
3. **Run similarity** — finds pixels within polygon matching exemplars
4. **(Optional)** Load CSV/Excel of field or inventory points to overlay
