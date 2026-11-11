# Changelog — Matrix Table

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `matrix-table.trex`.

## 1.1.0 — 2026-11-10
- Presets tab: apply a brand theme or save this look as a theme.
- Option to show Tableau's own tooltip on cells (Tooltip & actions: Use Tableau's tooltip, off by default).
- Save as picture: PNG of the whole matrix in the export menu (Export tab: Save as picture button, on by default).
- Format dialog: Undo and Redo (buttons and Ctrl/Cmd+Z), and a search box that finds a setting on any tab.
- The extension now has its own icon in Tableau (remove and re-add the extension to see it).
- New setting Format → Card → Maximum rows: the extension reads at most this many rows from the worksheet (default 1,000; 0 = all) and shows a note in the corner when rows were left out.
- Chart data is no longer kept in the browser between visits (the last-render cache is removed; old entries are deleted).
- Errors now show a small ! mark in the corner with details you can copy for support, instead of pointing to the browser console.
- Dynamic number scale adds T for trillions; number formatting, settings loading and pill-name matching now come from one shared, tested library used by every extension.

## 1.0.3 — 2026-11-08
- Card background color now drives the frozen header fill; headers are transparent unless the matrix scrolls.

## 1.0.2 — 2026-11-02
- More reliable start-up: if Tableau rejects the connection, a file fails to load or Tableau is slow to answer, the extension reloads itself (up to 3 times) and offers a manual reload after 90 seconds.

## Earlier
- Developed in the former per-extension repository.
