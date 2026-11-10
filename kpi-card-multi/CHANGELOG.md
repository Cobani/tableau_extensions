# Changelog — KPI Card Multi

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `kpiCardMulti.trex`.

## 1.2.0 — 2026-11-10
- The extension now has its own icon in Tableau (remove and re-add the extension to see it).
- New option Click selects in Tableau (Card tab, off by default, shared by all cards): click a card or a trend line point to select its date so dashboard actions fire.
- New setting Format → Card → Maximum rows: the extension reads at most this many rows from the worksheet (default 1,000; 0 = all) and shows a note in the corner when rows were left out.
- Leftovers of the old last-render cache are deleted from the browser.
- Errors now show a small ! mark in the corner with details you can copy for support, instead of pointing to the browser console.
- Dynamic number scale adds T for trillions; number formatting, settings loading and pill-name matching now come from one shared, tested library used by every extension.

## 1.1.2 — 2026-11-08
- New checkbox on the Card tab: show a divider after the last card in a row.

## 1.1.1 — 2026-11-08
- A divider is drawn on the right of every card, including the last one in a row.

## 1.1.0 — 2026-11-04
- Measures on Tableau's Tooltip tile now appear in the hover tooltip, each with its own name, number format and colors (single color, positive/negative, or conditional rules).
- Tooltip measure names, values and heading can have their own font, size, weight and italic.
- Choose which Tooltip-tile measures each card's tooltip shows (On this card, per card).

## 1.0.2 — 2026-11-02
- Measures always find their column: renamed pills, duplicates, Measure Names/Values.
- Date columns are found even when the Date tile's field isn't reported (published data sources).
- Fields are matched to columns across published data sources and renamed fields; unmatched ones are filled by role.
- A field match that misses the date is no longer cached, and the Marks card is re-checked after a cached first draw.
- Long card titles wrap onto several lines instead of being cut off.
- More reliable start-up: if Tableau rejects the connection, a file fails to load or Tableau is slow to answer, the extension reloads itself (up to 3 times) and offers a manual reload after 90 seconds.

## Earlier
- Developed in the former per-extension repository.
