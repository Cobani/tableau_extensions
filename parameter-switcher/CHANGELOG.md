# Changelog — Parameter Switcher

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `parameter-switcher.trex`.

## 1.1.0 — 2026-11-16
- Title and explanation can show worksheet fields and parameters: {Sales}, {Sales.avg|K|1}, {Region}, {Region.count}, {Order Date.last}, <Parameter name>. Format → Title & text has Insert field / Insert parameter lists and a preview.

## 1.0.2 — 2026-11-15
- Dropdown: only the current value is shown in the selected colour in the open list; the other values use the normal text and background colours.

## 1.0.1 — 2026-11-15
- When Tableau refuses a value, the message under the control now shows what was sent and how Tableau describes the parameter (for diagnosing).
- Fixed: switching an integer (or any list) parameter whose values have aliases ("Display as") failed with "Error in parameters for command 'set-parameter-value' bad value: value-string". The alias is now sent, as Tableau's API requires for aliased list parameters; the selected value is also matched by alias. Dev preview: new "Scenario (integer with aliases)" data set.

## 1.0.0 — 2026-11-11
- First version.
