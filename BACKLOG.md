# Backlog

Planned work, each item written so it can be handed to a person or a model as it stands. Read
`AGENTS.md` first. Take one item per session; finish it (section 6 there) before starting the next.
Items are ordered: earlier ones make later ones cheaper.

## 1. Split bar-chart/chart.js into several files
`chart.js` is about 4,200 lines in one closure. Target: `chart-state.js` (one namespace + all shared
mutable state as `S.*`), `chart-data.js`, `chart-layout.js`, `chart-draw.js`, `chart-interact.js`,
`chart.js` (init / refresh / paint). No behaviour change. Proof: identical screenshots for all 13 dev
data sets and a clean smoke test. Risk: local variables that shadow a state name. Strongest model.

## 2. "Save as picture" in every extension
`shared/snapshot.js` (`ExtSnapshot.save(element, { format, title })`) is written and browser-tested
(`shared/dev/snapshot-test.html`) but not wired in. Add PNG and SVG entries to the export menu of
bar-chart, line-chart and matrix-table (`export.js` → `attach`), and add the same export button to
waterfall, data-lineage and both KPI cards. Setting `export.picture` (default on where an export button
already exists, off elsewhere). SVG is true vector only for charts that are one `<svg>`.

## 3. Tableau's own tooltip as an option
`ExtCore.hoverTooltip(worksheet, rowIndex, point)` exists and is tested. Add setting
`tooltip.source: 'extension' | 'tableau'` (default `'extension'`, so nothing changes) to each chart; when
`'tableau'`, hover calls `hoverTooltip` with the summary-data row index of the hovered mark (keep the
original row index on the model while extracting; rows arrive reversed) and the extension's own tooltip
stays hidden; when the call is unavailable, fall back. Must be verified in real Tableau by the owner
before it is announced: tuple-id mapping is the uncertain part.

## 4. One brand theme across all extensions
`shared/theme.js`: a theme is `{ type: 'tableau-extensions-theme', version, name, fonts, colours
(text, muted, accent, positive, negative, background, grid), card (padding, radius, divider), numbers
(decimals, scale, negative style) }`. Each extension gets `themeMap` in config.js: theme key → list of
its own settings paths. Presets tab gains "Apply theme" (file / clipboard / My themes, shared
localStorage key so a theme saved in one extension is offered in all). Test: every `themeMap` path
exists in `DEFAULTS`; applying a theme then exporting a preset round-trips.

## 5. Dated event markers (line-chart, bar-chart with a date axis)
Setting `events: []` of `{ date, label, color, style }`, edited in a list in the Format dialog; drawn as
a vertical line with a label that avoids overlaps. Field-specific → in `FIELD_PATHS`.

## 6. Undo and settings search in the Format dialog
In `shared/dialog.js`: an undo stack of settings snapshots (Ctrl/Cmd+Z and a footer button; Cancel
still restores the opening state) and a search box that lists matching rows across tabs and jumps to
them. One implementation for all seven dialogs.

## 7. Small multiples
bar-chart already has panels (`panelIdx`); make it a documented option with shared axes and a
per-panel title, then port the panel layout to line-chart.

## 8. New extensions (one per session, each starting from a design the owner approves)
Sankey / flow (from data-lineage) · Bullet and gauge (from bar-chart progress bars) · Cohort grid (from
matrix-table) · Funnel (from bar-chart) · Maturity ladder / timeline (from line-chart's time axis) ·
Treemap or donut (from bar-chart drill and legend) · Parameter switcher (from kpi-card-multi layout) ·
Narrative card (from kpi-card's formatter and rules). Follow "New extension" in `AGENTS.md`.

## 9. Gradual modernisation
ESLint runs on every push with `no-undef`, `no-redeclare`, `no-unused-vars`. Remaining warnings:
`npm run lint`. When a function is touched for another reason, move its `var` to `const` / `let`.

## Not planned (owner's decision)
Arabic / locale support · a licence file · changing the author details in the manifests · calendar
heatmap · diagnostics panel.
