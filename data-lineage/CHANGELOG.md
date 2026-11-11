# Changelog — Data Lineage

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `data-lineage.trex`.

## 1.3.0 — 2026-11-10
- New: apply or save a brand theme in the Presets tab.
- New: option to show Tableau's own tooltip when hovering a node (Search & actions → Tooltip), off by default.
- New: Save as picture button (PNG of the whole lineage), off by default (Card → Export).
- Format dialog: Undo and Redo (buttons and Ctrl/Cmd+Z), and a search box that finds a setting on any tab.
- The extension now has its own icon in Tableau (remove and re-add the extension to see it).
- New setting Format → Card → Maximum rows: the extension reads at most this many rows from the worksheet (default 1,000; 0 = all) and shows a note in the corner when rows were left out.
- Chart data is no longer kept in the browser between visits (the last-render cache is removed; old entries are deleted).
- Errors now show a small ! mark in the corner with details you can copy for support, instead of pointing to the browser console.
- Dynamic number scale adds T for trillions; number formatting, settings loading and pill-name matching now come from one shared, tested library used by every extension.

## 1.2.1 — 2026-11-02
- More reliable start-up: if Tableau rejects the connection, a file fails to load or Tableau is slow to answer, the extension reloads itself (up to 3 times) and offers a manual reload after 90 seconds.

## Earlier
- Developed in the former per-extension repository.
