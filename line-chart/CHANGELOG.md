# Changelog — Line Chart

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `line-chart.trex`.

## 1.2.0 — 2026-11-10
- The extension now has its own icon in Tableau (remove and re-add the extension to see it).
- Optional: click a point to select it in Tableau, so dashboard filter and highlight actions fire (Format, Legend and tooltip, Click selects in Tableau).
- New setting Format → Card → Maximum rows: the extension reads at most this many rows from the worksheet (default 1,000; 0 = all) and shows a note in the corner when rows were left out.
- Chart data is no longer kept in the browser between visits (the last-render cache is removed; old entries are deleted).
- Errors now show a small ! mark in the corner with details you can copy for support, instead of pointing to the browser console.
- Dynamic number scale adds T for trillions; number formatting, settings loading and pill-name matching now come from one shared, tested library used by every extension.

## 1.1.2 — 2026-11-02
- "Use shared format" moved to Values on the line; the line's own format now applies to line values, legend totals and the line axis.
- More reliable start-up: if Tableau rejects the connection, a file fails to load or Tableau is slow to answer, the extension reloads itself (up to 3 times) and offers a manual reload after 90 seconds.

## Earlier
- Developed in the former per-extension repository.
