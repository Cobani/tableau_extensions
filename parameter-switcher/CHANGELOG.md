# Changelog — Parameter Switcher

All user-visible changes to this extension. Newest first. The version is the `extension-version` in `parameter-switcher.trex`.

## 1.0.1 — 2026-11-15
- Numbers are now sent to Tableau as text ("2"), which fixes "Error in parameters for command 'set-parameter-value' bad value: value-string" on integer parameters with aliases; the alias is only a fallback.
- Fixed: switching values of an integer parameter with aliases (Display as) failed. The value is now retried as text and as its alias when Tableau refuses the number; the selected value is also matched by alias. Dev preview: new 'Scenario (integer with aliases)' data set.

## 1.0.0 — 2026-11-11
- First version.
