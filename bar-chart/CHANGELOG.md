# Changelog — Bar Chart

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `bar-chart.trex`.

## 1.4.0 — 2026-11-17
- Fonts updated to Lato 2.015 with all nine weights (Hairline to Black, upright and italic); Light, Semibold and Black now use real font files, and Hairline, Thin and Heavy are new options in every Weight list.
- Dimension tile takes up to 8 fields (was 6).

## 1.3.3 — 2026-11-17
- Names between the two sides wrap when they don't fit (long single words break too); left-right layout wraps them as well.

## 1.3.2 — 2026-11-17
- Diverging up-down with names between the two sides: Category axis Direction (Horizontal / Angled / Vertical) now applies.

## 1.3.1 — 2026-11-17
- The Saudi riyal sign (⃁) now shows correctly everywhere (title, explanation, numbers, tooltips, Format dialog, saved pictures) instead of "?" or a box: the sign is bundled as a tiny font.

## 1.3.0 — 2026-11-16
- Title and explanation can show worksheet fields and parameters: {Sales}, {Sales.avg|K|1}, {Region}, {Region.count}, {Order Date.last}, <Parameter name>. Format → Title & text has Insert field / Insert parameter lists and a preview.

## 1.2.3 — 2026-11-16
- Workbook format follows the pill's own format (right-click the pill → Format…) when it has one, over the field's default number format (Tableau 2025.1+).

## 1.2.2 — 2026-11-16
- Workbook format now works everywhere: Tableau's number format (prefix/suffix, decimals, separators, K/M/B, %, negatives) is read per measure and applied to summed bars, totals, groups, tooltips, lines and axis ticks, not only to single-row bars.

## 1.2.1 — 2026-11-15
- More space between the title and the chart, matching Line Chart (default 'Space above chart' 10 px, plot top margin 8 px).

## 1.2.0 — 2026-11-10
- Small multiples: new 'Small multiples' group on the Grouping tab (Split by, minimum panel width for automatic columns, axis labels on outer panels only, show at most N panels with a 'Showing N of M panels' note). Defaults keep today's look.
- New: dated event markers. With a date on the Dimension tile, Gridlines & Target → Events draws a labelled line at the bar holding each event date (hover shows label and date). Empty by default.
- Presets tab: apply a brand theme or save this chart's look as a theme (shared with the other extensions).
- Optional Tableau tooltip: Tooltip & Actions → Use Tableau's tooltip shows the tooltip designed in Tableau (Tableau 2024.2 or newer); off by default.
- Save as picture: the export menu now also saves the chart as a PNG (Export tab: Save as picture button).
- Format dialog: Undo and Redo (buttons and Ctrl/Cmd+Z), and a search box that finds a setting on any tab.
- The extension now has its own icon in Tableau (remove and re-add the extension to see it).
- New setting Format → Card → Maximum rows: the extension reads at most this many rows from the worksheet (default 1,000; 0 = all) and shows a note in the corner when rows were left out.
- Chart data is no longer kept in the browser between visits (the last-render cache is removed; old entries are deleted).
- Errors now show a small ! mark in the corner with details you can copy for support, instead of pointing to the browser console.
- Dynamic number scale adds T for trillions; number formatting, settings loading and pill-name matching now come from one shared, tested library used by every extension.

## 1.1.3 — 2026-11-10
- Progress bars can fill up to the total of all bars or a Detail-tile measure.

## 1.1.2 — 2026-11-02
- Left-right sides follow the data order or a per-value pick.
- Fixed the line tooltip showing "—" instead of the line value.
- Value Text, Stacked bars: "Total in the legend" adds a Total legend item.
- "Use shared format" moved to Values on the line; the line's own format now applies to line values, legend totals and the line axis.
- More reliable start-up: if Tableau rejects the connection, a file fails to load or Tableau is slow to answer, the extension reloads itself (up to 3 times) and offers a manual reload after 90 seconds.

## Earlier
- Developed in the former per-extension repository.
