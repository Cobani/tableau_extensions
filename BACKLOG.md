# Backlog

Planned work, each item written so it can be handed to a person or a model as it stands. Read
`AGENTS.md` first. Take one item per session; finish it (section 6 there) before starting the next.
Items are ordered: earlier ones make later ones cheaper.

## 1. Check the November 2026 additions in real Tableau
Everything added on 10–11 November was tested with unit tests, a fake-DOM harness and a real browser with
mock data, never in Tableau. Per extension, in Tableau Desktop and on Server: click-to-select fires dashboard
actions (date pills especially), *Use Tableau's tooltip* shows the right mark's tooltip (tuple-id mapping),
Save as picture downloads inside the Tableau frame, the Format dialog stays on top, Parameter Switcher
changes int / float / date parameters. Fix what fails, one extension per session.

## 2. Midnight theme gaps
Applying the bundled Midnight theme leaves some elements light or dark-on-dark because their defaults differ
between extensions and are therefore not in `THEME_MAP`: waterfall grid lines and Start / End bars, data-lineage
legend text, matrix-table header colours. Add theme keys for them (new keys, so Default.json stays a no-op).

## 3. Line Chart presets folder
Line Chart has the Presets tab but no bundled `presets/*.json`; add `Default.json` and one alternative.

## 4. Vector SVG export
Save as picture offers PNG everywhere. A true vector SVG needs title and legend drawn inside the chart's
`<svg>` (they are HTML today); do it for bar-chart and line-chart first.

## 5. Gradual modernisation
ESLint runs on every push with `no-undef`, `no-redeclare`, `no-unused-vars`. Remaining warnings:
`npm run lint`. When a function is touched for another reason, move its `var` to `const` / `let`.

## 6. Small fixes noticed in review
- funnel: with more than 12 stages a stray "s." shows next to the row note.
- bullet-gauge: the "showing the first 500" note uses the browser's default font; the `negative` data set
  draws full-width bars when the target is zero.
- bar-chart: an event line crosses the value label of the bar it sits on.
- maturity-ladder: the Today line and the running-total line are drawn through bar total labels; in "by distance
  from today" colouring the legend still shows the group shades, which do not match the bars.

## Not planned (owner's decision)
Arabic / locale support · a licence file · changing the author details in the manifests · calendar
heatmap · diagnostics panel.
