# tableau_extensions

Ilyas Coban's Tableau **viz (worksheet) extensions**, all in one repo and one GitHub Pages site:
`https://cobani.github.io/tableau_extensions/<slug>/`.

| Folder | Extension | Manifest | Dev preview (after `./serve.sh`) |
|---|---|---|---|
| `kpi-card/` | KPI Card | `kpi-card/kpiCard.trex` | — |
| `kpi-card-multi/` | KPI Card Multi | `kpi-card-multi/kpiCardMulti.trex` | http://localhost:8766/kpi-card-multi/dev/preview.html |
| `waterfall/` | Waterfall | `waterfall/waterfall.trex` | http://localhost:8766/waterfall/dev/preview.html |
| `line-chart/` | Line Chart | `line-chart/line-chart.trex` | http://localhost:8766/line-chart/dev/preview.html |
| `bar-chart/` | Bar Chart | `bar-chart/bar-chart.trex` | http://localhost:8766/bar-chart/dev/preview.html |
| `matrix-table/` | Matrix | `matrix-table/matrix-table.trex` | http://localhost:8766/matrix-table/dev/preview.html |
| `data-lineage/` | Data Lineage | `data-lineage/data-lineage.trex` | http://localhost:8766/data-lineage/dev/preview.html |

Each extension's own README covers its features and Format dialog.

## Layout

```
shared/                 loaded by every extension (one URL → downloaded once, cached for all of them)
  lib/                  Tableau Extensions API 1.17.0 (bundled, no CDN)
  fonts/                Lato 2.0 WOFF2 + fonts.css
  timing.js             load timings (?debug)
<slug>/                 one extension: .trex, index.html, chart/card.js, configure.*, config.js, icons.js, icons/, dev/ …
serve.py / serve.sh     local server for all extensions on :8766 (+ Tableau shape palettes for the Format dialogs)
stamp-versions.py       cache-busting ?v=<hash> on every extension page (incl. ../shared files)
index.html              landing page for the GitHub Pages root
```

Extensions only share what is in `shared/`. Everything else (config, icons, Format dialog code) stays in the
extension's own folder, so changing one extension never changes another.

## Run locally

```bash
chmod +x serve.sh && ./serve.sh
```

## Deploy (GitHub Pages)

1. `python3 stamp-versions.py` (bar-chart: run `python3 bar-chart/bundle_shapes.py` first if shapes changed).
2. Commit and push to `main`. Pages: Settings → Pages → Deploy from branch `main`, folder `/ (root)`.
3. Tableau Server safe list: `https://cobani.github.io/tableau_extensions/` covers all extensions.
4. After a `.trex` change, remove and re-add the extension in the workbook.
