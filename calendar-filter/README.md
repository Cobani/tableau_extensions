# Calendar Filter

<p>
  <img src="examples/example-1.png" alt="Calendar Filter example 1: the text box on a dashboard" width="340">
  <img src="examples/example-2.png" alt="Calendar Filter example 2: the calendar window" width="340">
</p>

A date filter for Tableau dashboards. The extension zone shows one **text box** with the dates
chosen ("Feb 2026 – Apr 2026, Sep 2026"). Clicking it opens a **calendar window** — Tableau's own
dialog window, so it is not limited to the size of the zone — where people pick years, months,
weeks or days, single values, ranges or several values, quick ranges such as *Month to date*, and
whether rows with a **null date** are included.

The choice reaches the dashboard through a **Filter action**: the extension selects this sheet's
marks (one per date), and the action filters the other sheets.

Data used in the examples is made up.

## Set it up (once per dashboard)

1. **Worksheet.** Add the extension to a new worksheet (Marks card → *Viz Extension* →
   `calendar-filter.trex`).
2. **Date tile.** Drop the date you want to filter on the **Date** tile, at day level: right-click it
   and choose **Exact Date** or **Day** (the one with the year). Date-times work too; they are
   grouped by day.
3. **Value tile (optional).** Drop a measure — for example `CNT(Number of Records)` — to show it in
   the calendar cells and shade them (Format → Look).
4. **Dashboard.** Put the worksheet on the dashboard. A short zone is enough (about 60 px high with
   the title, 40 px without).
5. **Filter action.** Dashboard → Actions → Add Action → **Filter**:
   - Source sheets: the calendar worksheet · Run action on: **Select**
   - Target sheets: the sheets to filter
   - Clearing the selection will: **Show all values**
   - Filter: *Selected fields*, the date field (or *All fields*).

That's it: click the text box, pick dates, press **Apply**.

## Using it

| In the calendar window | Does |
|---|---|
| Click | Pick one period (click it again to clear) |
| Shift-click | A range from the last click |
| Ctrl-click (⌘ on Mac) | Add or remove one period |
| Drag across cells | A range |
| Year / Month / Week / Day | Switch granularity (clears the selection) |
| Quick ranges | Today, Yesterday, This / Last week, Last 7 / 30 days, Month to date, This / Last month, Quarter to date, Last 12 months, Year to date, This / Last year |
| Null dates: Include / Exclude / Only | Keep, drop, or show only the rows that have no date |
| Clear | All dates, nulls back to the default |
| Apply · Cancel · Esc | Filter the dashboard · leave it as it was |

The same line of help is shown at the bottom of the window, written for the click behaviour chosen in
Format. The × in the text box clears the filter without opening the calendar.

Weeks show their number (**W47**). Week 1 is the week that holds 1 January, like Tableau's
`WEEK()`; weeks start on Sunday unless Format → Calendar says otherwise.

## Format Extension

| Tab | Settings |
|---|---|
| **Text box** | Title above the box (field name, custom text or none) and its font · text when nothing is filtered · × clear button · calendar icon · height, corners, colours, font |
| **Window** | Filter the dashboard *On Apply* or *Live, on every click* · window size (Small / Medium / Large) · on top of Tableau or floating · how-to line |
| **Calendar** | Week starts on (Sunday, Monday, Saturday) · which granularities are offered · opens at (default **Day**) · days of the next / previous month · click behaviour (Standard, Toggle, Single value, Range only) · drag to select · periods with no data clickable or not · null dates control and default |
| **Quick ranges** | Where they appear (list on the left, dropdown, chips, off) · count back from today or from the latest date in the data · which ones are listed |
| **Look** | Accent colour (any colour or hex code) · font and colours of the window · Value in each cell · shade cells by Value · zone padding and background |
| **Presets** | Export / import / My presets for all these settings, and brand themes |

### Good to know

- **Every date is read.** There is no row limit for this extension: a calendar with missing dates
  would filter wrongly. One row per date is small even for many years of data.
- **Where the window opens** is decided by Tableau (usually the middle of the Tableau window). An
  extension can't place it under the text box.
- **Live mode** sends each click to the dashboard while the window stays open. It needs Tableau
  2023.1 or later; older versions apply when the window closes.
- **After a reload** the text box reads the selection back from Tableau and shows it again, at the
  coarsest granularity that fits (a whole month selected shows as that month).
- **Dates with no data** can't be selected in Tableau (there is no mark for them). Picking only such
  dates clears the filter and the box says so.
- Viewers can use the filter on Tableau Server; only authors can change the Format settings.

## Preview without Tableau

`./serve.sh` in the repo folder, then <http://localhost:8766/calendar-filter/dev/preview.html>.
The preview has made-up data sets (with and without a Value tile, date-times, no nulls, a date at
month level, an empty Date tile) and shows what would be selected in Tableau.
