# Narrative Card — Tableau Viz Extension

Sentences written by the dashboard builder, with live numbers inside:

> `{Revenue} this month, {Revenue.change} vs last month. {Orders} orders at an average of {Avg Order Value}.`
> → "1.3M this month, ▲ 4.2% vs last month. 18,420 orders at an average of 71.20."

Every measure is read like the KPI Card reads its measure: latest value or month to date, compared with the previous date or the
same day last month, as a % or pp change, with an "increase is good" colour per measure. Part of the `tableau_extensions` repo
(shared files in `../shared/`).

## Run it

```bash
cd .. && chmod +x serve.sh && ./serve.sh     # from the tableau_extensions repo root
```

In Tableau Desktop (2024.2+): Marks card → mark type dropdown → **Add Extension** → **Access Local Extensions** → `narrative-card.trex`.

To try it without Tableau, open <http://localhost:8766/narrative-card/dev/preview.html>. It has six sample data sets (four measures
with daily dates over 26 months, no date, falls / zeros / nulls, renamed pills, a long template, 2,500 daily rows) and opens the
Format dialog next to the card. `window.mockSetParam('Region Param', 'East')` in the card frame changes a sample parameter.

## Marks card tiles

| Tile | What to drop | Needed |
|---|---|---|
| **Measures** | 1 to 12 measures, each one separately | yes |
| **Date** | 0 to 4 date fields at any level (year, quarter, month, week, day, exact date; combine e.g. YEAR + MONTH) | optional |

Without a Date tile the single aggregated row is used: `{Name}` works, change tokens (`.change`, `.diff`, `.previous`, `.direction`)
render empty and `{if}` conditions on them are false. Click-to-select needs a Date tile.

## Template language

Written in *Format → Template*, which also lists the fields of the card as clickable buttons and has a help panel.

| Write | You get |
|---|---|
| `{Name}` | the measure's current value in its own format (*Numbers* tab). The name is the pill name without SUM / AVG, any capitals; a measure's *Label* works too |
| `{Name.change}` | % or pp change vs the comparison (*Comparison* tab), with ▲ / ▼ and the good / bad / neutral colour |
| `{Name.diff}` | the difference, always positive (`{Name.diff\|+}` keeps the sign) |
| `{Name.previous}` | the value it is compared with |
| `{Name.date}` | the date the value is for |
| `{Name.direction}` | `rose` / `fell` / `was flat` (the words are settings) |
| `{Name.name}` | the measure's name (or its label) |
| `{Name\|1}` | override: decimals |
| `{Name\|M}` | override: scale `none`, `K`, `M`, `B` or `dynamic` |
| `{Name\|%}` | override: as a percentage |
| `{Name\|+}` | override: plus sign on positive numbers |
| `{Name\|M\|1}` | overrides combine |
| `{if Name.change > 0}…{else}…{end}` | a condition. Operators `>` `>=` `<` `<=` `=` `!=` against a number. One level, no nesting. `{else}` is optional |
| `{if has Name.change}…{end}` | true when there is a figure (a date to compare with) |
| `<Parameter name>` | the current value of a Tableau parameter |

- A name that matches no measure renders as the raw token in red, so typos are visible.
- Each line is a paragraph. A line starting with `- ` is a bullet. `**bold**` and `*italic*`. Nothing else: HTML typed into the
  template is shown as text, never run.
- In conditions the number is the value (`{if Orders < 1000}`), or for `.change` the % (pp) change, for `.diff` / `.previous` the value.
- Lines that end up empty (a false condition, an empty change token) disappear.
- With an empty template the card writes one sentence per measure: `Revenue: 1.3M (▲ 4.2% vs previous period)`.

The parser and renderer are plain functions in `config.js` (`Nc.parseTemplate`, `Nc.renderTemplate`) and have no DOM or Tableau
dependency.

## Format dialog

Every change is saved straight away and the card behind the window updates live. Cancel restores what was saved on open.

| Tab | Settings |
|---|---|
| **Template** | the text, fields as buttons (value, change, diff, previous, date, direction), parameters, if / bullet / bold snippets, help |
| **Style** | text font, size, weight, colour, line height, alignment, vertical position, paragraph gap; weight and colour of the numbers; good / bad / neutral colours, arrows on or off, the three direction words |
| **Numbers** | what `{Name}` shows (latest date or month to date), then per measure: label, format (dynamic, K / M / B, full, percentage, workbook), decimals, unit, "increase is good", change as % or pp, own MTD roll-up |
| **Comparison** | previous date or same day last month; single day or month to date; % or pp; decimals; period word |
| **Icon**, **Title & text** | optional header, as in the KPI Card (off by default) |
| **Card** | padding, background, divider, maximum rows, click selects in Tableau, Tableau's tooltip, save as picture |
| **Presets** | export / import, saved presets, Brand theme |

Per-measure settings are stored under the pill name without its aggregation, so changing SUM to AVG keeps them; a repeated
measure gets `#2` after its name.

## Number and change logic

Unchanged from the KPI Card, applied to each measure on its own (see `../kpi-card/README.md`): rows are ordered by the Date tile
(coarse to fine), the latest date gives the value, *Month to date* sums (or averages) day 1 of the month through the latest date,
*Same day last month* clamps to the month's last day, and a change needs a real date on the Date tile (not date parts).

## Click, tooltip, picture

- **Click selects in Tableau** (on by default): a click selects the latest date, so dashboard actions fire. Click again or press Esc to clear.
- **Hover** a number for its full, unabbreviated value, the date and the comparison. *Use Tableau's tooltip* shows the one designed in Tableau instead.
- **Save as picture** (on by default): button in the top-right corner on hover, PNG.

## Presets

The last tab saves and loads every setting. "Look only" leaves out the template, per-measure formats, title and explanation text and the
row limit. Samples: `presets/Default.json` and `presets/Editorial.json`.

## Settings and deploying

Everything is saved in the workbook under one settings key (`narrativeCard1`).

1. The Tableau Extensions API library is bundled in `../shared/lib/` (no CDN).
2. Host the repo over HTTPS and change `<source-location><url>` in `narrative-card.trex`.
3. Add the URL to the Tableau Server/Cloud extension safe list. `dev/` doesn't need to be deployed.

Tableau reads the `.trex` only when the extension is added, so after editing it, remove the extension and add it again.

## Data limit, errors and privacy

- **Maximum rows.** The extension reads at most 1,000 rows from the worksheet by default. Change it in *Format → Card → Maximum rows* (0 = all rows). When rows are left out, a note in the bottom-left corner says "Showing the first N rows".
- **Errors.** If something goes wrong, a small **!** mark appears in the bottom-right corner. Click it for details you can copy (extension version, Extensions API version, the error) and a Reload button.
- **Nothing is kept in the browser.** The card is always drawn from live worksheet data; no data is stored between visits (only which Marks card field matches which column, per column set).
- **Parameters** are asked for from Tableau only when the template contains `<…>`.
- **What changed in each version:** [CHANGELOG.md](CHANGELOG.md).
