# Parameter Switcher — Tableau Viz Extension

A control, not a chart. It shows the allowed values of **one Tableau parameter** as tabs, buttons, pills, a dropdown, a toggle or a
stepper, and sets the parameter when one is clicked, so a dashboard gets good-looking switches (metric picker, period picker, view
toggle) in the same style as the other extensions. Part of the `tableau_extensions` repo (shared files in `../shared/`).

## Run it

```bash
cd .. && chmod +x serve.sh && ./serve.sh     # from the tableau_extensions repo root
```

In Tableau Desktop (2024.2+): Marks card → mark type dropdown → **Add Extension** → **Access Local Extensions** → `parameter-switcher.trex`.
Then right-click the control → **Format Extension** → **Control** → pick the parameter.

To try it without Tableau, open <http://localhost:8766/parameter-switcher/dev/preview.html>. It has seven data sets (`?data=`):
a list parameter as tabs (`default`), as pills (`period`), two values as a toggle (`toggle`), a range as a stepper (`range`),
a parameter that allows all values with 14 or 40 values on the Options tile (`options`, `many`), and no parameter chosen (`none`).
The mock changes the parameter like Tableau does; add `?rejectChange` to see a rejected change revert with a message.

## Marks card tile

| Tile | What to drop | Drives |
| --- | --- | --- |
| **Options** (optional) | one dimension | the choices, for a parameter that allows **all values**: its distinct values in worksheet order |

With nothing on the tile the choices are the parameter's own list of allowed values, or its range stepped by the step size
(a range with more than 500 steps becomes a stepper that moves by the step size). A worksheet with no fields at all works.

## What it does

- **Styles**: tabs (underline), segmented buttons, pills, dropdown, toggle (exactly two choices; otherwise segmented), stepper
  (◀ value ▶). More than 12 choices (setting) switch to the dropdown automatically; tabs and pills otherwise scroll sideways, or wrap.
- **Always in step with Tableau**: the selected choice mirrors the parameter's current value, also when it is changed elsewhere
  (another control, a dashboard action, the parameter card).
- **Click** selects at once, asks Tableau to change the parameter, and goes back with a short message if Tableau refuses.
- **Keyboard**: arrow keys / Home / End move between choices, Enter or Space selects. The choices are a `radiogroup` (`aria-checked`).
- **Labels** are Tableau's formatted values; rename or hide a choice in *Format → Choices* (matched by value, so the parameter is never
  set to the label).

## Format dialog

**Control** (parameter, style, many-choices fallback, direction, align, position, size, equal widths, gap, shape, text) ·
**Choices** (rename / hide each value) · **Colors** (normal / hover / selected) · Icon · Title & text (header, off by default) ·
Card (padding, background, maximum rows, save as picture) · Presets. The window stays on top of Tableau and the control updates live.

## Presets

The last tab saves and loads every setting. **Export** "Look only" leaves out the parameter name, choice labels and texts that name your
data. It also has **Brand theme** (shared by all extensions). Samples: `presets/Default.json` and `presets/Dark-pills.json`.

## Settings and deploying

Everything is saved in the workbook under one settings key (`parameterSwitcher1`). The parameter is stored by its name.

1. The Tableau Extensions API library is bundled in `../shared/lib/` (no CDN).
2. Host the repo over HTTPS and change `<source-location><url>` in `parameter-switcher.trex`.
3. Add the URL to the Tableau Server/Cloud extension safe list. `dev/` doesn't need to be deployed.

Tableau reads the `.trex` only when the extension is added, so after editing it, remove the extension and add it again.

### Load timings (debug)

Open DevTools, pick this extension's frame, run `localStorage.setItem('extDebug', '1')` and reload to see where load time goes.

## Data limit, errors and privacy

- **Maximum rows.** At most 1,000 rows are read for the Options tile by default. Change it in *Format → Card → Maximum rows* (0 = all rows). When rows are left out, a note in the bottom-left corner says "Showing the first N rows".
- **Errors.** If something goes wrong, a small **!** mark appears in the bottom-right corner. Click it for details you can copy (extension version, Extensions API version, the error) and a Reload button.
- **Nothing is kept in the browser.** The control is always drawn from live parameter and worksheet data; no data is stored between visits.
- **What changed in each version:** [CHANGELOG.md](CHANGELOG.md).
