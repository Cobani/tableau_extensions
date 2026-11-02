<div align="center">

# Tableau Viz Extensions

**Seven custom chart types for Tableau, built on the Tableau Viz Extensions API.**<br>
Drop fields on the Marks card, style everything from a Format dialog, no code in the workbook.

![Tableau Extensions API 1.17](https://img.shields.io/badge/Tableau%20Extensions%20API-1.17-1f77b4)
![Viz extensions](https://img.shields.io/badge/type-viz%20(worksheet)%20extensions-e8762d)
![No dependencies](https://img.shields.io/badge/dependencies-none-2ea44f)
![Hosted on GitHub Pages](https://img.shields.io/badge/hosted%20on-GitHub%20Pages-222)

[KPI Card](#kpi-card) · [KPI Card Multi](#kpi-card-multi) · [Waterfall](#waterfall) · [Line Chart](#line-chart) · [Bar Chart](#bar-chart) · [Matrix](#matrix) · [Data Lineage](#data-lineage)

</div>

---

## Contents

- [The extensions](#the-extensions)
- [What every extension can do](#what-every-extension-can-do)
- [Extension details](#kpi-card)
- [Getting started in Tableau](#getting-started-in-tableau)
- [Repository layout](#repository-layout)
- [Local development](#local-development)
- [Deploying](#deploying)
- [Author](#author)

## The extensions

| | Extension | What it draws | Marks card tiles | Manifest |
|---|---|---|---|---|
| <img src="kpi-card/preview.png" width="120"> | [**KPI Card**](#kpi-card) | Latest value, % / pp change and a trend line | Measure · Date | [`kpiCard.trex`](kpi-card/kpiCard.trex) |
| <img src="kpi-card-multi/preview.png" width="120"> | [**KPI Card Multi**](#kpi-card-multi) | A row of KPI cards, one per measure, in one zone | Measures · Date | [`kpiCardMulti.trex`](kpi-card-multi/kpiCardMulti.trex) |
| <img src="waterfall/preview.png" width="120"> | [**Waterfall**](#waterfall) | Start → changes → End bridge chart | Start · Changes · End · Breakdown | [`waterfall.trex`](waterfall/waterfall.trex) |
| <img src="line-chart/preview.png" width="120"> | [**Line Chart**](#line-chart) | Lines and areas over a date, dual axis | Date · Measures · Color | [`line-chart.trex`](line-chart/line-chart.trex) |
| <img src="bar-chart/preview.png" width="120"> | [**Bar Chart**](#bar-chart) | Every common bar design, with drill-down | Dimension · Measure · Line · Target | [`bar-chart.trex`](bar-chart/bar-chart.trex) |
| <img src="matrix-table/preview.png" width="120"> | [**Matrix**](#matrix) | Crosstab with heat map, totals and Excel export | Rows · Columns · Measure · Color | [`matrix-table.trex`](matrix-table/matrix-table.trex) |
| <img src="data-lineage/preview.png" width="120"> | [**Data Lineage**](#data-lineage) | Sankey-style lineage flow with search | Levels · Details | [`data-lineage.trex`](data-lineage/data-lineage.trex) |

## What every extension can do

- **Format dialog for everything.** Open it with **Format Extension** on the Marks card (or right-click the chart). The chart updates live behind it; **Cancel** undoes everything since it opened and **Reset tab** restores that tab's defaults. It stays on top of Tableau.
- **Card header** shared by all extensions: an icon (built-in icon set, Tableau shape palettes or your own upload), a title and an explanation line, each with full font control. Titles can show a parameter's value with `<Parameter name>`.
- **One number formatter** across the family: K / M / B / Dynamic / full / Percentage / workbook format, decimals, unit text, `+` sign, and negatives as `−201.4`, `-201.4` or `(201.4)`. Tooltips show full, unabbreviated values.
- **Settings live in the workbook.** They travel with it when you publish to Tableau Server, and new options always come with defaults so older workbooks keep working.
- **Works with dashboard actions.** In the charts, clicking a bar, node or cell selects it in Tableau for filter and highlight actions.
- **Fast loading.** The charts redraw the last render from the browser cache straight after the handshake, keep Tableau API calls to a minimum (important when a dashboard has many extensions), and never reload just because Tableau Server is busy. The Tableau API library and fonts are loaded once from `shared/` and cached for every extension. Add `?debug` to see load timings.
- **Self-contained.** No CDNs or external services: the Tableau Extensions API library and the Lato fonts are bundled.

---

## KPI Card

<img src="kpi-card/preview.png" alt="KPI Card" width="420" align="right">

A single KPI: icon, title, explanation, **big number with unit**, **% or pp change** and a **trend line** (or "vs previous period" text).

**Tiles:** `Measure` (1) · `Date` (up to 4 levels, e.g. Year + Month + Day).

- Transparent background by default, so the card sits on any dashboard colour.
- Big number as a **single day** or **month to date** (sum for flows, average for balances and ratios).
- Compare with the **previous date** or the **same day last month** (month-end days clamp correctly), as **%** or **pp**.
- Arrows and colours follow *Increase is good*, so falling costs can show green.
- Trend line: smooth or straight, gradient fill, points shown, tooltips, height.
- 0–1 ratio support for percentage metrics (0.4523 → `45.23%`, 0.45 vs 0.40 → `+5.00 pp`).

[Full documentation →](kpi-card/README.md)

<br clear="right">

## KPI Card Multi

<img src="kpi-card-multi/preview.png" alt="KPI Card Multi" width="420" align="right">

Up to **12 KPI cards in one extension zone**: each measure on the Measures tile becomes a card that looks and works like the single KPI Card.

**Tiles:** `Measures` (1–12) · `Date` (up to 4 levels).

- **One** permission check, handshake and data request for the whole row instead of one per card, which makes dashboards with many KPIs load much more reliably on Tableau Server.
- **Per-card or shared settings:** a card picker in the Format dialog; options tagged *this card* apply only to it, and **Apply to all** copies them to every card.
- Layout: minimum card width with wrapping rows, gap, and a width weight per card.
- Cards keep their settings when you change the aggregation (`SUM` → `AVG`).

[Full documentation →](kpi-card-multi/README.md)

<br clear="right">

## Waterfall

<img src="waterfall/preview.png" alt="Waterfall" width="100%">

A bridge chart from a **Start** value through any number of **changes** to an **End** value.

**Tiles:** `Start` (1) · `Changes` (up to 30, one bar each, in tile order) · `End` (1, optional — calculated as Start + changes when empty) · `Breakdown` (up to 6 dimensions).

- Per-bar settings: label, colour (increase / decrease or custom), invert sign, total value placement.
- **Breakdown** dimensions split change bars into segments (top 10 shown).
- **Groups:** automatic runs of increases / decreases or custom named groups, with brackets and group totals.
- **Clipped-bar markers** when the axis doesn't start at zero.
- Connector lines, gridlines, zero line; one number format for all labels or each label its own.
- Right-click or double-click a bar to jump straight to its settings.

[Full documentation →](waterfall/README.md)

## Line Chart

<img src="line-chart/preview.png" alt="Line Chart" width="100%">

Lines and areas for any number of measures over a date (or any dimension).

**Tiles:** `Date` (up to 4 levels) · `Measures` (up to 20) · `Color` (1 dimension, optional).

- Each series drawn as a **line, area or hidden**: colour, width, solid / dashed / dotted, straight / smooth / step.
- **Dual axis:** put any series on the left or right axis, each with its own range, title and number format.
- **Stacked** and **100% stacked** areas, gradient fills.
- **Dash the last N segments** to mark an incomplete period.
- **Reference lines:** constant target, average, median, min, max or latest value. **Band** between two measures and a forecast zone.
- Hover crosshair with every series, stacked totals and shares; interactive legend with latest values (click to hide, hover to highlight).

[Full documentation →](line-chart/README.md)

## Bar Chart

<img src="bar-chart/preview.png" alt="Bar Chart" width="100%">

A bar chart for every common bar design, with 22 one-click **Quick looks**.

**Tiles:** `Dimension` (up to 6: bars, then breakdown and drill levels) · `Measure` (up to 12) · `Line` (up to 4 measures drawn over the bars) · `Target` (1). Measures on Tooltip add tooltip rows.

- **Layouts:** vertical or horizontal; grouped, stacked, 100% stacked, left-right comparison and overlapping.
- **Styles:** plain bars, **lollipops** or **filling (progress) bars**, rounded ends, gradients, two-tone fills.
- **Per-dimension roles:** bars, split bars, breakdown segments or **panels** (small multiples).
- **Drill-down** on double-click (expand one bar, show only its detail, or expand all) with Back / Reset.
- **Member icons** per bar, from the built-in set, Tableau shape palettes (bundled for GitHub Pages) or uploads.
- **Targets**, reference lines and bands; **Top N with Others**; sorting by any measure.
- **Comments:** right-click → *Add comment*, shown as a marker or callout and saved in the workbook.
- Rich tooltips (% of total, change vs previous bar, % of target), clickable legend, own right-click menu.
- **Data export** (Excel, CSV, copy) and **presets** (export, import, *My presets*).

[Full documentation →](bar-chart/README.md)

## Matrix

<img src="matrix-table/preview.png" alt="Matrix" width="100%">

A crosstab with tile-style cells, built for reports that end up in Excel.

**Tiles:** `Rows` (up to 6 levels) · `Columns` (up to 6 levels) · `Measure` (up to 10) · `Color` (1 measure, optional). Measures on Tooltip add tooltip rows.

- One **main value** per cell with smaller, faded values under it: other measures, **% of total**, difference, % difference, running total, rank.
- **Heat-map** shading, − / + colours, data bars and colour rules.
- **Group totals that fold**, total rows and columns, banded rows, frozen headers, merged and rotated headers.
- **Diagonal mark** for From → To (transfer) matrices.
- **Export:** Excel *as shown* (colours, merged headers, number formats), Excel / CSV data, CSV crosstab, or **copy table** to paste into Excel or an email.
- Sort rows and columns, highlight row / column on hover, and **presets**.

[Full documentation →](matrix-table/README.md)

## Data Lineage

<img src="data-lineage/preview.png" alt="Data Lineage" width="100%">

A lineage flow: every row is one path, such as *table → data source → workbook → view*.

**Tiles:** `Levels` (up to 6 dimensions, one column of nodes each) · `Details` (up to 8, as subtitles or tooltip lines).

- **Click a node** to highlight every path through it and select it in Tableau.
- **Search** across all columns: highlight or filter to the matching lineage.
- **Collapse / expand** nodes and whole levels; optionally start collapsed with only the first column.
- Node ordering for **fewest crossings**, most paths or name; curved, elbow or straight links.
- Tooltips with upstream / downstream counts per level; scrolls with sticky column headers when there are many nodes.
- **Presets** for the look.

[Full documentation →](data-lineage/README.md)

---

## Getting started in Tableau

1. Download the extension's `.trex` file from the table above (or from its folder).
2. In Tableau Desktop, on a worksheet, open the mark type menu on the Marks card, choose **Add Extension → Access Local Viz Extensions** and pick the `.trex`.
3. Drop fields on the extension's tiles on the Marks card, then click **Format Extension** to style it.

**Tableau Server / Cloud:** add `https://cobani.github.io/tableau_extensions/` to the extension safe list. That one entry covers every extension in this repo.

> After a `.trex` file changes (new version), remove and re-add the extension in the workbook.

## Repository layout

```
tableau_extensions/
├── shared/                  loaded by every extension, downloaded once and cached for all
│   ├── lib/                 Tableau Extensions API 1.17.0 (bundled, no CDN)
│   ├── fonts/               Lato 2.0 (OFL), WOFF2 + fonts.css
│   └── timing.js            load timings (?debug)
├── kpi-card/                one folder per extension:
├── kpi-card-multi/            <name>.trex      manifest (Marks card tiles)
├── waterfall/                 index.html       the viz
├── line-chart/                chart.js / .css  data reading and drawing (KPI cards: card.js)
├── bar-chart/                 configure.*      Format dialog
├── matrix-table/              config.js        defaults, settings, number formatting
├── data-lineage/              icons.js, icons/ built-in icon set
│                              dev/             browser preview with sample data
│                              presets/         sample presets (bar chart, matrix, data lineage)
├── serve.py / serve.sh      local server for all extensions (port 8766)
├── stamp-versions.py        cache-busting for GitHub Pages
└── index.html               landing page
```

Extensions share only what is in `shared/`; everything else lives in the extension's own folder, so changing one extension never affects another.

## Local development

```bash
./serve.sh
```

Then open a browser preview with sample data, no Tableau needed (add `?debug` for load timings):

| Extension | Preview |
|---|---|
| KPI Card Multi | http://localhost:8766/kpi-card-multi/dev/preview.html |
| Waterfall | http://localhost:8766/waterfall/dev/preview.html |
| Line Chart | http://localhost:8766/line-chart/dev/preview.html |
| Bar Chart | http://localhost:8766/bar-chart/dev/preview.html |
| Matrix | http://localhost:8766/matrix-table/dev/preview.html |
| Data Lineage | http://localhost:8766/data-lineage/dev/preview.html |

The local server also lists your Tableau shape palettes (from *My Tableau Repository* and the Tableau Desktop install) for the icon pickers. Python 3 standard library only.

Checks before committing:

```bash
for f in */*.js */dev/*.js shared/*.js; do node --check "$f"; done
xmllint --noout */*.trex
python3 stamp-versions.py
```

## Deploying

Hosted on GitHub Pages from `main` (root): `https://cobani.github.io/tableau_extensions/<extension>/`.

1. `python3 stamp-versions.py` adds content hashes to every script and stylesheet link, so browsers never mix old and new files. Bar Chart: run `python3 bar-chart/bundle_shapes.py` first if the bundled shape palettes changed.
2. Commit and push to `main`.

## Author

**Ilyas Coban** · [LinkedIn](https://www.linkedin.com/in/ilyascoban/)
