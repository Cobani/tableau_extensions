# Calendar Filter — changelog

## 1.0.0
- New extension: a text box with the dates chosen; a click opens a calendar window (Tableau's dialog, not limited to the zone) to filter by year, month, week or day.
- Sets the date filter on the sheet's Filters shelf (Exact Date values or a range of dates), so the choice shows in the Filters pane and is saved with the workbook.
- Start date and End date tiles (FIXED calculations such as {MIN([Date])} / {MAX([Date])}): the calendar always shows every date between them.
- Single values, ranges (Shift-click or drag) and several values (Ctrl/⌘-click); Toggle, Single value and Range-only click behaviours; how-to line at the bottom.
- Week numbers in the Week view; weeks start on Sunday (Monday or Saturday in Format).
- Quick ranges (Today … Last year), counted back from today or the End date.
- Null dates: Include, Exclude or Only, with a default.
- Apply / Cancel, or Live mode that filters on every click.
- Any accent colour, a 24 px text box, presets and brand themes.
