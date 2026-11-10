# AGENTS.md — how to work on this repo (for any AI model or person)

Tableau **viz (worksheet) extensions**, hosted on GitHub Pages. Seven extensions, one folder each, no
dependencies, no build step. Read this file before touching anything; it replaces exploring the tree.
`BACKLOG.md` lists the work that is planned next, each item written as a ready-to-run task.

The owner is a Tableau dashboard builder, not a programmer: explain in plain words, show results, and
never leave him a script to run or a decision he did not ask to make.

## 1. The order of thought (follow it every time)

1. **Restate the request in one sentence** and name the extension(s), the tab and the behaviour. If it
   names several things, list them. Do only what was asked; note other things you notice, don't do them.
2. **Find the consequence for existing workbooks.** Every push to `main` is live in real dashboards
   within minutes. Ask: *will a workbook saved last month look or behave differently after this?* If
   yes, either put it behind a new setting whose default keeps the old behaviour, or stop and ask.
   A change that silently alters existing dashboards is the worst mistake available here.
3. **Ask only what is the owner's to decide** (a default that changes what users see, deleting
   something, a trade-off he would care about). Give 2–3 options with what each means for him, and a
   recommendation. Everything else: pick the conventional answer and say which you picked.
4. **Locate before reading.** Files are large. `grep -n` for the function, read only that range. The
   map in section 3 tells you which file owns what.
5. **Prefer the shared, tested function.** If `shared/` has it, use it. If two extensions need the same
   new thing, put it in `shared/` with a test. Per-chart logic stays in the chart's folder.
6. **Change the smallest thing that works.** Edit in place; never re-type a file from tool output;
   never "tidy" code you were not asked to change.
7. **Prove it** (section 6): unit tests, lint, the browser smoke test, and a look at the screenshot. A
   refactor is proven by *identical screenshots before and after*, not by reading the diff.
8. **Say what is unproven.** No AI here can open Tableau. Anything that depends on real Tableau
   (selection accepted, tooltips shown, dialog on top) is reported as "not verified in Tableau: …" so
   the owner knows exactly what to click.
9. **Record it**: changelog line, version bump when user-visible, README where behaviour is described,
   presets when settings change shape, this file when a rule changes. Then commit and push.

When two rules conflict, the earlier one in this list wins: existing workbooks > the request's letter >
elegance.

## 2. Hard rules

| Rule | Why |
|---|---|
| Never rename or remove a settings key, never change `STORAGE_KEY`, never change how per-measure / per-member keys are built | Settings are one JSON blob saved inside each workbook; a renamed key silently resets someone's formatting |
| New settings get a default in `DEFAULTS` that reproduces the old behaviour | Old workbooks load through `merge(DEFAULTS, saved)` |
| Chart data is never stored in the browser (`localStorage`, `sessionStorage`, IndexedDB) | Decided November 2026: privacy on shared machines and with row-level security. Only settings-like things (dialog presets, field-match hints) may be stored |
| The Format dialog opens **on top of Tableau** (`DialogStyle.Modal`) | Owner's standing rule |
| No `.trex` that points at localhost, ever | Owner's standing rule |
| No outside hosts, CDNs, analytics, or new runtime dependencies | The hosting network blocks them; one safe-list entry must cover everything |
| Example, mock and screenshot data is made up (generic retail names) | The repo is public |
| Secrets never go in tracked files, remote URLs, logs or chat | — |
| `shared/` changes need a test and a check of every extension | One file, seven charts |
| Bundled presets hold **every** setting of their chart (field-specific paths excepted) | `tests/presets.test.js` enforces it |
| Do not edit `shared/lib/`, `**/icons.js` by hand, or anything third-party | Generated / vendored |
| The licence situation, the author's contact details in `.trex`, and the push-token setup stay as they are | Owner's decisions |

## 3. Map

```
shared/        core.js    ExtCore   escaping, colours, settings merge, number format, column matching,
                                    summary data with row limit, selection, Tableau tooltip   (tests/core.test.js)
               boot.js    ExtBoot   loads the API library + dev mock, reload recovery, error mark with details
               dialog.js  ExtDialog Format dialog control builders (+ dialog.css base styles) (tests/dialog.test.js)
               snapshot.js ExtSnapshot  PNG / SVG of a drawn chart (not wired into the charts yet)
               timing.js  ExtTiming load timings (?debug)
               lib/, fonts/         Tableau Extensions API 1.17, Lato
<slug>/        <name>.trex          manifest: Marks card tiles, version, hosted URL, icon
               index.html           loads shared/boot.js, core.js, then icons.js, config.js, chart.js
               chart.js|card.js     reads Tableau, builds the model, draws, interaction
               config.js            DEFAULTS, read/write settings, chart-specific formatting
               configure.html/js/css  Format dialog: TABS array, one build function per tab, Presets tab
               dev/mock.js, dev/preview.html   fake Tableau API + side-by-side preview
               presets/*.json       complete sample presets
               README.md, CHANGELOG.md, examples/
tests/         *.test.js  node --test (no browser)      smoke.js  Playwright: opens every chart + dialog
release.py     all checks, stamps, .trex copies, version bump + changelog
stamp-versions.py   ?v=<hash> on every script/style reference (GitHub Pages caching)
tools/make_icons.py manifest icons
```

| Folder | Main JS | Globals (chart / config / dialog) | Settings key | Manifest |
|---|---|---|---|---|
| kpi-card | card.js | KpiCard / KpiCardConfig / KpiCardConfigure | kpiCard | kpiCard.trex |
| kpi-card-multi | card.js | KpiCardMulti / KpiCardMultiConfig / KpiCardMultiConfigure | kpiCardMulti1 | kpiCardMulti.trex |
| waterfall | chart.js | Waterfall / Wf / WaterfallConfigure | waterfall1 | waterfall.trex |
| line-chart | chart.js | LineChart / Lc / LineChartConfigure | linechart1 | line-chart.trex |
| bar-chart | chart.js | BarChart / Bc / BarChartConfigure | barChart1 | bar-chart.trex |
| matrix-table | chart.js (+ export.js) | MatrixTable / Mx / MatrixTableConfigure | matrixTable1 | matrix-table.trex |
| data-lineage | chart.js | DataLineage / Dl / DataLineageConfigure | dataLineage1 | data-lineage.trex |

Versions: `python3 release.py versions`. Manifest id: `com.ilyascoban.vizext.<slug without dashes>`;
hosted at `https://cobani.github.io/tableau_extensions/<slug>/`.

Best references to copy from: **bar-chart** (most features, drill, presets with a real migration),
**line-chart** (cleanest Presets tab), **matrix-table** (CSV/XLSX export), **kpi-card** (date logic),
**kpi-card-multi** (several cards in one zone, shared vs per-card settings), **data-lineage** (HTML nodes
over SVG links).

## 4. Facts about Tableau that are easy to get wrong

- Summary data rows arrive **last-to-first**. "As in the data" order means reading them backwards; mocks
  send rows reversed too.
- Tableau Server answers all extension calls of a whole dashboard through **one serial queue** (roughly
  90 ms per call). Add no API calls on load; never parallelise to "speed up".
- A renamed pill reports its field and its data column under different names: match columns with
  `ExtCore.findColumn` (id → exact name → name without aggregation → either half of `a // b`), then fill
  leftovers by position.
- `selectMarksByValueAsync` wants the column's `fieldName` exactly as in the summary data and the raw
  cell `value` in a list: `[{ fieldName, value: [raw] }]`. Use `ExtCore.select`.
- Tuple ids (for `hoverTupleAsync`) are the 1-based row position in the summary data as sent.
- After any `.trex` change the extension must be removed and re-added in the workbook.
- The dialog cannot read the worksheet: the chart sends what it needs in the dialog payload.
- Rows are capped by `data.maxRows` (default 1,000; 0 = all) via `ExtCore.readSummary`; a truncated
  read shows the corner note through `ExtCore.rowNotice`.

## 5. Recipes

**Add a setting.** `DEFAULTS` in config.js (default = old behaviour) → control in the right tab builder
in configure.js (builders come from `ExtDialog.kit`) → path covered by that tab's `keys` (Reset tab) →
read it in chart.js → if field-specific, add the path to `FIELD_PATHS` → add it to every file in
`presets/` (the coverage test tells you which) → README + changelog.

**Change a setting's shape** (rename, move, new meaning): don't, unless asked. If asked: keep reading
the old shape in config.js, raise `PRESET_VERSION`, add a step to `PRESET_MIGRATIONS`, update `presets/`.

**New extension.** Copy the closest existing folder; new slug, globals, settings key (`<camel>1`),
manifest id and tiles; add it to `index.html` (landing page), `README.md`, the tables in this file and
`KEYS` in `tests/config.test.js`, the globals in `eslint.config.js`, and `tools/make_icons.py`. It must
have dev mock + preview, presets, README, CHANGELOG and pass every test unchanged.

**Refactor.** Screenshot every data set and every dialog tab before (`node tests/smoke.js` with
`TE_SHOTS=<dir>`), change, screenshot again, compare pixels. Data sets with random data or animation
differ between any two runs: compare those by eye.

**Release** (after every piece of work, always):
```
python3 release.py bump <slug> patch|minor "What changed, for a dashboard builder"   # user-visible changes
python3 release.py note <slug> "…"                                                  # more lines, no bump
python3 release.py            # must end with "All checks passed."
git add -A && git commit -m "<slug>: what changed" && git push origin main
```
Then tell the owner which extensions to remove and re-add (only when a `.trex` changed).

## 6. Definition of done

- `python3 release.py` passes (syntax, manifests, stamps, `.trex` copies, lint, tests).
- `node tests/smoke.js` passes (CI runs it on every push; see `.github/workflows/checks.yml`).
- You looked at a screenshot of what you changed.
- New logic has a test. A bug fix has a test that failed before the fix.
- Changelog, version, README, presets and this file are in step with the code.
- Your report states: what changed for the user, what you verified and how, what is **not verified in
  Tableau**, and what the owner has to do (re-add extension, test in the preview, decide something).

## 7. Delegating to another model

Split work only along file boundaries: two workers never edit the same file. Give each worker: this
file, the exact list of files it may touch, the behaviour wanted, the default that protects existing
workbooks, how it will be verified, and the report format ("files changed · what works · what is
unverified · check results"). Workers do not commit, push, stamp or bump; one coordinator runs
`release.py`, the smoke test and the screenshot comparison, reads every diff that touches `shared/`,
and commits. Use the strongest model for anything that touches `shared/`, settings shape or a
refactor across files; smaller models do well on one extension, one feature, docs, mocks and tests.
Never accept "it should work": accept test output and screenshots.

## 8. Writing for users

Sentence case, plain words, short. Say what the user sees ("Click a point to select it in Tableau"),
not how it is built. Empty states name the tile to fill. Errors say what happened and what to do; the
details go behind the "!" mark (`console.error` is recorded there automatically).

## 9. Code style

Plain browser JavaScript in IIFEs, one global per file. New code uses `const` / `let`; older code uses
`var` and is left alone until touched for another reason. No frameworks, no transpiling, no modules.
Comments explain *why* and what would break; they are written for the next reader, who may be a model
with no memory of this conversation.
