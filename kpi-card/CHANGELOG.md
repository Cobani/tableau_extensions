# Changelog — KPI Card

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `kpiCard.trex`.

## 2.3.0 — 2026-11-10
- Format dialog: Undo and Redo (buttons and Ctrl/Cmd+Z), and a search box that finds a setting on any tab.
- New Presets tab: save a look and reuse it in other worksheets or workbooks (export / import as a file or via the clipboard, My presets in this browser).
- The extension now has its own icon in Tableau (remove and re-add the extension to see it).
- New option Click selects in Tableau (Card tab, off by default): click the card or a trend line point to select its date so dashboard actions fire.
- Added a local preview page (dev/preview.html) with test data sets, for trying the card without Tableau.
- New setting Format → Card → Maximum rows: the extension reads at most this many rows from the worksheet (default 1,000; 0 = all) and shows a note in the corner when rows were left out.
- Leftovers of the old last-render cache are deleted from the browser.
- Errors now show a small ! mark in the corner with details you can copy for support, instead of pointing to the browser console.
- Dynamic number scale adds T for trillions; number formatting, settings loading and pill-name matching now come from one shared, tested library used by every extension.

## 2.2.0 — 2026-11-04
- Measures on Tableau's Tooltip tile now appear in the hover tooltip, each with its own name, number format and colors (single color, positive/negative, or conditional rules).
- Tooltip measure names, values and heading can have their own font, size, weight and italic.

## 2.1.2 — 2026-11-02
- Date columns are found even when the Date tile's field isn't reported (published data sources).
- Fields are matched to columns across published data sources and renamed fields; unmatched ones are filled by role.
- A field match that misses the date is no longer cached, and the Marks card is re-checked after a cached first draw.
- More reliable start-up: if Tableau rejects the connection, a file fails to load or Tableau is slow to answer, the extension reloads itself (up to 3 times) and offers a manual reload after 90 seconds.

## Earlier
- Developed in the former per-extension repository.
