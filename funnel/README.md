# Funnel — Tableau Viz Extension

The stages of a process, each narrower than the one before, with the conversion and the drop-off between them
(visits → product views → basket → checkout → orders). Three shapes, a colour per stage or by conversion, and labels that
never overlap. Part of the `tableau_extensions` repo (shared files in `../shared/`).

## Run it

```bash
cd .. && chmod +x serve.sh && ./serve.sh     # from the tableau_extensions repo root
```

In Tableau Desktop (2024.2+): Marks card → mark type dropdown → **Add Extension** → **Access Local Extensions** → `funnel.trex`.

To try it without Tableau, open <http://localhost:8766/funnel/dev/preview.html>. It has six sample data sets (one measure per
stage, a Stage dimension, odd data with a bigger stage, a zero and a null, two stages, 1,200 stage rows, renamed pills) and opens
the Format dialog next to the chart.

## Marks card tiles

Give the stages in one of two ways (the extension detects which):

| Marks card tile | What to drop | Drives |
| --- | --- | --- |
| **Stages (measures)** | 2 to 12 measures, one per stage | the stages, in the order of the pills on the tile |
| **Stage** | one dimension, one member per stage | the stages (use with Value). Order: *Format → Chart → Order* |
| **Value** | one measure | the size of each stage (use with Stage) |
| **Tooltip** (Tableau's own) | any fields | accepted; with *Use Tableau's tooltip* the hover shows Tableau's tooltip |

- A stage larger than the previous one is drawn wider; its conversion is over 100 % and neutral in colour.
- A zero or empty stage is a thin line labelled "0". Negative values are drawn as 0, with a note under the chart.
- More than 12 stages: the first 12 are drawn and a note says so.
- If Tableau delivers the measures as *Measure Names / Measure Values*, the extension pivots them back.

## What it draws

- **Shape** (Format → Chart): *Funnel* (centred trapezoids, sides sloping from one stage to the next), *Bars with drop-off* (centred
  bars, the drop-off as a lighter trapezoid between them) or *Steps* (left-aligned bars, the lost part shaded up to the first stage's width).
- **Labels**: stage name, value, % of the first stage, % of the previous stage (conversion) and the drop-off ("−1,234 · −32 %"). Each can be
  switched off. Text goes inside the shape when it fits, beside it when it does not, is shortened with an ellipsis (full text in the
  tooltip) or left out; it never overlaps.
- **Colours**: one colour getting lighter down the funnel, one colour per stage, or by conversion (good / warning / poor thresholds).
- **Conversion**: the stage after the biggest drop-off is outlined; "Overall conversion" (last stage as % of the first) under the chart.
- **Click** a stage to select it in Tableau (when the stages come from a dimension). **Tooltip**: stage, value, % of first, % of previous, drop-off.
- **Save as picture** button (top-right corner, on hover).

## Format dialog

Icon · Title & text · **Chart** (shape, gap, corner radius, narrowest stage, order incl. manual order, conversion, interaction) ·
**Colors** · **Labels** (what to show, fonts, number format) · **Stages** (per stage: label, own colour, hide) · Numbers · Card ·
Presets. Right-click or double-click a stage in the chart to jump to its settings. The window stays on top of Tableau and the chart updates live.

## Presets

The last tab saves and loads every setting. **Export** "Look only" leaves out per-stage settings, the manual order and texts that name your data.
It also has **Brand theme** (shared by all extensions). Samples: `presets/Default.json` and `presets/Dark.json`.

## Settings and deploying

Per-stage settings are stored by the pill's (or member's) name. Everything is saved in the workbook under one settings key (`funnel1`).
Renaming a pill that holds a stage keeps its settings (the last seen names are remembered in the browser, per worksheet).

1. The Tableau Extensions API library is bundled in `../shared/lib/` (no CDN).
2. Host the repo over HTTPS and change `<source-location><url>` in `funnel.trex`.
3. Add the URL to the Tableau Server/Cloud extension safe list. `dev/` doesn't need to be deployed.

Tableau reads the `.trex` only when the extension is added, so after editing it, remove the extension and add it again.

### Load timings (debug)

Open DevTools, pick this extension's frame, run `localStorage.setItem('extDebug', '1')` and reload to see where load time goes.

## Data limit, errors and privacy

- **Maximum rows.** The extension reads at most 1,000 rows from the worksheet by default. Change it in *Format → Card → Maximum rows* (0 = all rows). When rows are left out, a note in the bottom-left corner says "Showing the first N rows".
- **Errors.** If something goes wrong, a small **!** mark appears in the bottom-right corner. Click it for details you can copy (extension version, Extensions API version, the error) and a Reload button.
- **Nothing is kept in the browser.** The chart is always drawn from live worksheet data; no data is stored between visits.
- **What changed in each version:** [CHANGELOG.md](CHANGELOG.md).
