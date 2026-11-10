# Changelog — KPI Card

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `kpiCard.trex`.

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
