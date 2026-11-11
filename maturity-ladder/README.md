# Maturity Ladder — Tableau Viz Extension

Amounts that fall due over time (contracts, leases and agreements by end date): one bar per week, month, quarter or year, stacked by an
optional group, with a Today marker, an optional running total and optional Overdue / Later bars. Part of the `tableau_extensions` repo
(shared files in `../shared/`).

## Run it

```bash
cd .. && chmod +x serve.sh && ./serve.sh     # from the tableau_extensions repo root
```

In Tableau Desktop (2024.2+): Marks card -> mark type dropdown -> **Add Extension** -> **Access Local Extensions** -> `maturity-ladder.trex`.

To try it without Tableau, open <http://localhost:8766/maturity-ladder/dev/preview.html>. It has seven made-up data sets (default: 90
contracts over 4 years in 3 groups; date parts YEAR + MONTH; no group; within 10 weeks; sparse with gaps, a zero, a negative and a missing
date; 2,000 contracts; renamed pills) and opens the Format dialog next to the chart.

## Marks card tiles

| Marks card tile | What to drop | Drives |
| --- | --- | --- |
| **Maturity date** | 1 to 3 date fields: one exact date, or date parts such as YEAR and MONTH (required) | the bucket each row falls in |
| **Amount** | one measure (required) | the bar height |
| **Group** | one dimension (optional) | stacks each bar |
| **Item** | one dimension (optional) | individual items: counted, and the largest listed in the tooltip |
| **Tooltip** (Tableau's own) | any fields | accepted; with *Use Tableau's tooltip* the hover shows Tableau's tooltip |

## What it draws

- **Buckets** (Format -> Buckets): week, month, quarter or year; *Auto* picks the smallest unit that gives at most about 36 buckets (never finer
  than the data's own date level). Empty buckets inside the range are kept. Optional **Overdue** (before today) and **Later** (more than N buckets
  after today; 0 = off) bars.
- **Bars**: stacked vertical bars on a time axis; negative amounts go below zero. Colours: one colour, one per group, or by distance from today
  (thresholds). The total is written on top of each bar when it fits; the item count is optional.
- **Today**: a line and label at today's date (or a fixed date); the next N buckets can be shaded.
- **Running total**: optional line on a right axis.
- **Click** a bar or a stack segment to select that bucket's dates (and group) in Tableau. **Tooltip**: bucket, total, share of the grand total,
  amount per group, the top 5 items and "+N more".
- Rows without a date are left out, with the note "N rows without a date are not shown".
- **Save as picture** button (top-right corner, on hover).

## Format dialog

Icon · Title & text · **Buckets** (unit, overdue, later, interaction) · **Bars** (width, corner radius, colours) · **Today & total** (marker,
highlight, running total) · **Labels** (totals, counts, axes, legend) · Numbers · Card (incl. maximum rows, export) · Presets. Right-click or
double-click a bar to jump to its settings. The window stays on top of Tableau and the chart updates live.

## Presets

The last tab saves and loads every setting. **Export** "Look only" leaves out the texts and the fixed Today date that belong to one worksheet.
It also has **Brand theme** (shared by all extensions). Samples: `presets/Default.json` and `presets/Dark.json`.

## Settings and deploying

Everything is saved in the workbook under one settings key (`maturityLadder1`).

1. The Tableau Extensions API library is bundled in `../shared/lib/` (no CDN).
2. Host the repo over HTTPS and change `<source-location><url>` in `maturity-ladder.trex`.
3. Add the URL to the Tableau Server/Cloud extension safe list. `dev/` doesn't need to be deployed.

Tableau reads the `.trex` only when the extension is added, so after editing it, remove the extension and add it again.

### Load timings (debug)

Open DevTools, pick this extension's frame, run `localStorage.setItem('extDebug', '1')` and reload to see where load time goes.

## Data limit, errors and privacy

- **Maximum rows.** The extension reads at most 1,000 rows from the worksheet by default. Change it in *Format → Card → Maximum rows* (0 = all rows). When rows are left out, a note in the bottom-left corner says "Showing the first N rows".
- **Errors.** If something goes wrong, a small **!** mark appears in the bottom-right corner. Click it for details you can copy (extension version, Extensions API version, the error) and a Reload button.
- **Nothing is kept in the browser.** The chart is always drawn from live worksheet data; no data is stored between visits.
- **What changed in each version:** [CHANGELOG.md](CHANGELOG.md).
