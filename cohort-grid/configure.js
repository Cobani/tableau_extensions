'use strict';

/**
 * Format dialog for the Cohort Grid extension ("Format Extension" on the
 * Marks card, or the grid's right-click menu).
 *
 * Every change is saved straight away (debounced), so the grid behind the
 * dialog updates live. Cancel restores what was stored on open.
 * The grid passes its field names as the dialog payload,
 * because a dialog can't read the worksheet.
 *
 * The Icon, Title & text, Numbers, Card and Presets tabs are the Bar Chart's
 * (Icon and Title & text come from KPI Card; Card from Waterfall).
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var hist = null; // undo / redo steps (shared/dialog.js)
  var activeTab = 'values';
  var shapeIndex = null;
  var info = { cohortName: '', periodName: '', valueName: '', sizeName: '', periodIsDate: false, unit: '', focus: null };

  var WEIGHTS = ExtDialog.WEIGHTS;

  // Controls shared by every Format dialog: shared/dialog.js.
  const kit = ExtDialog.kit({
    get: get,
    set: set,
    fonts: Cg.FONTS,
    textNullAsEmpty: true,
    selectFirstIfMissing: true
  });
  const h = ExtDialog.h, P = ExtDialog.P, group = ExtDialog.group, help = ExtDialog.help,
    escapeHtml = ExtDialog.escapeHtml, blobToIconDataUrl = ExtDialog.blobToIconDataUrl,
    setStatus = ExtDialog.setStatus, baseUrl = ExtDialog.baseUrl, copyText = ExtDialog.copyText,
    download = ExtDialog.download, getAt = ExtDialog.getAt, setAt = ExtDialog.setAt, delAt = ExtDialog.delAt;
  const row = kit.row, textRow = kit.textRow, numberRow = kit.numberRow, rangeRow = kit.rangeRow,
    checkboxRow = kit.checkboxRow, selectRow = kit.selectRow, segRow = kit.segRow, colorRow = kit.colorRow,
    unitRow = kit.unitRow, fontFamilyRow = kit.fontFamilyRow, fontRows = kit.fontRows;
  var TABS = [
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'values', label: 'Values', build: buildValuesTab, keys: ['values', 'period'] },
    { id: 'heat', label: 'Heat map', build: buildHeatTab, keys: ['heat'] },
    { id: 'layout', label: 'Layout', build: buildLayoutTab, keys: ['layout', 'cells'] },
    { id: 'sort', label: 'Sort & limits', build: buildSortTab, keys: ['sort'] },
    { id: 'headers', label: 'Headers', build: buildHeadersTab, keys: ['headers'] },
    { id: 'tooltip', label: 'Tooltip & actions', build: buildTooltipTab, keys: ['tooltip', 'interaction'] },
    { id: 'export', label: 'Export', build: buildExportTab, keys: ['export'] },
    { id: 'numbers', label: 'Numbers', build: buildNumbersTab, keys: ['numbers', 'format'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card', 'data'] },
    { id: 'presets', label: 'Presets', build: buildPresetsTab, keys: [] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try {
        var p = JSON.parse(payload || '{}');
        Object.keys(info).forEach(function (k) { if (p[k] != null) info[k] = p[k]; });
      } catch (e) { /* opened without payload */ }

      cfg = Cg.read();
      original = Cg.clone(cfg);

      if (info.focus && info.focus.tab) activeTab = info.focus.tab;

      buildTabs();
      hist = ExtDialog.history({
        snapshot: function () { return JSON.stringify(cfg); },
        restore: function (json) { cfg = JSON.parse(json); changed(); buildTabs(); }
      });
      ExtDialog.footerTools({ history: hist, footer: document.querySelector('.footer') });
      ExtDialog.search({
        tabs: document.getElementById('tabs'),
        container: document.getElementById('panels'),
        getTabs: function () { return TABS; },
        openTab: function (id) { activeTab = id; buildTabs(); }
      });
      document.getElementById('cancel').addEventListener('click', function () {
        cfg = original;
        flush().then(close);
      });
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('Cohort Grid dialog failed to initialize:', err);
    });
  }

  function buildTabs () {
    var nav = document.getElementById('tabs');
    var panels = document.getElementById('panels');
    var scroll = panels.scrollTop;
    nav.innerHTML = '';
    panels.innerHTML = '';

    TABS.forEach(function (tab) {
      var b = h('button', { className: 'tab', type: 'button', role: 'tab', textContent: tab.label });
      b.setAttribute('aria-selected', String(tab.id === activeTab));
      b.addEventListener('click', function () { activeTab = tab.id; panels.scrollTop = 0; buildTabs(); });
      nav.appendChild(b);

      var panel = h('section', { className: 'panel', role: 'tabpanel' });
      panel.hidden = tab.id !== activeTab;
      if (!panel.hidden) tab.build(panel);
      panels.appendChild(panel);
    });
    panels.scrollTop = scroll;
  }

  function rebuild () { buildTabs(); }

  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) {
      var path = k.split('.');
      var def = path.reduce(function (o, x) { return o == null ? undefined : o[x]; }, Cg.DEFAULTS);
      var last = path.pop();
      var tgt = path.reduce(function (o, x) { return o[x]; }, cfg);
      tgt[last] = Cg.clone(def);
    });
    changed();
    buildTabs();
  }

  // ---------------------------------------------------------------------------
  // Number format editor (KPI Card "Big number" options + Waterfall signs)
  // ---------------------------------------------------------------------------
  function fmtRows (g, base, opts) {
    opts = opts || {};
    var fmtRow = selectRow('Number format', P(base, 'scale'), [
      ['dynamic', 'Dynamic (K / M / B)'], ['K', 'Thousands (K)'], ['M', 'Millions (M)'],
      ['B', 'Billions (B)'], ['none', 'Full number'],
      ['percent', 'Percentage (%)'], ['percentDynamic', 'Percentage, dynamic (K / M / B %)'],
      ['workbook', 'Workbook format']
    ]);
    fmtRow.querySelector('select').addEventListener('change', rebuild);
    g.appendChild(fmtRow);
    var scale = get(P(base, 'scale'));
    if (scale === 'percent' || scale === 'percentDynamic') {
      g.appendChild(checkboxRow('Value is a 0–1 ratio', P(base, 'pctFromRatio')));
      g.appendChild(help('On: 0.4523 → 45.23%. Off: 45.23 → 45.23%.'));
    }
    if (scale === 'workbook') g.appendChild(help('Uses Tableau’s format when a cell is a single value; totals fall back to Dynamic.'));
    g.appendChild(numberRow('Decimal places', P(base, 'decimals'), 0, 6, 1));
    g.appendChild(checkboxRow('Thousands separator', P(base, 'thousands')));
    g.appendChild(unitRow('Unit', P(base, 'unit'), 'e.g. SAR, M, %'));
    g.appendChild(selectRow('Unit position', P(base, 'unitPosition'), [['suffix', 'After number'], ['prefix', 'Before number']]));
    g.appendChild(checkboxRow('Space before / after unit', P(base, 'unitSpace')));
    if (!opts.noSign) g.appendChild(checkboxRow('“+” on positive values', P(base, 'plusSign')));
    g.appendChild(selectRow('Negative numbers', P(base, 'negStyle'), [['minus', '−201.4'], ['hyphen', '-201.4'], ['paren', '(201.4)']]));
    var sample = h('div', { className: 'sample' });
    var upd = function () {
      var f = get(base);
      sample.textContent = 'Preview: ' + Cg.formatNumber(1284500, f, { signed: true }) + '   ' + Cg.formatNumber(262.1, f, { signed: true }) +
        '   ' + Cg.formatNumber(-45200, f, { signed: true }) + '   ' + Cg.formatNumber(0.4523, f, { signed: true });
    };
    upd();
    g.addEventListener('input', upd);
    g.addEventListener('change', upd);
    g.appendChild(sample);
  }


  function labelOf (list, v) { var x = list.find(function (o) { return o[0] === v; }); return x ? x[1] : v; }

  function note (g, html) { var n = h('p', { className: 'note' }); n.innerHTML = html; g.appendChild(n); return n; }

  function tabLink (n, tab) {
    Array.prototype.forEach.call(n.querySelectorAll('a[data-tab]'), function (a) {
      a.addEventListener('click', function (e) { e.preventDefault(); activeTab = a.getAttribute('data-tab'); buildTabs(); });
    });
    return n;
  }

  /** Font rows plus capitals / letter spacing (header and total label styles). */
  function textStyleRows (g, base) {
    fontRows(g, base);
    g.appendChild(checkboxRow('Capitals', P(base, 'upper')));
    g.appendChild(numberRow('Letter spacing', P(base, 'letterSpacing'), 0, 40, 1));
  }


  // ---------------------------------------------------------------------------
  // Values tab: what a cell shows
  // ---------------------------------------------------------------------------
  function buildValuesTab (p) {
    var g1 = group(p, 'Cells show');
    g1.appendChild(selectRow('Show as', 'values.show', [['pct', '% of cohort size (retention)'], ['value', 'Value'], ['pctPrev', '% of previous period']], null, rebuild));
    g1.appendChild(help(cfg.values.show === 'pct'
      ? 'Each cell divided by the size of its cohort (the Cohort size tile, or the value in period 0).'
      : cfg.values.show === 'pctPrev'
        ? 'Each cell divided by the cell before it in the same cohort: how many stayed from one period to the next.'
        : 'The measure itself, formatted on the Numbers tab.'));
    if (cfg.values.show !== 'value') g1.appendChild(numberRow('Decimal places (%)', 'values.decimals', 0, 4, 1));
    g1.appendChild(checkboxRow('Hide the first period', 'values.hidePeriod0'));
    g1.appendChild(help('Hides period 0 when it is always 100 %.'));
    g1.appendChild(textRow('Empty cells', 'values.emptyText', 'empty = nothing'));
    g1.appendChild(textRow('Zero shown as', 'values.zeroText', 'empty = the number'));

    var g2 = group(p, 'Periods');
    var unit = info.periodIsDate ? ' Now counted in ' + (info.unit || 'months') + '.' : '';
    g2.appendChild(selectRow('Date periods count in', 'period.unit', Cg.PERIOD_UNITS));
    g2.appendChild(help('Only for a date on the Period tile: the number of steps between the cohort’s date and the period’s date. A number on Period is used as it is.' + unit));
  }

  // ---------------------------------------------------------------------------
  // Heat map tab
  // ---------------------------------------------------------------------------
  function buildHeatTab (p) {
    var HT = cfg.heat;
    var g1 = group(p, 'Shading');
    g1.appendChild(segRow('Cells', 'heat.mode', [['ramp', 'Light to dark'], ['none', 'One colour']], rebuild));
    if (HT.mode === 'ramp') {
      g1.appendChild(colorRow('Lowest colour', 'heat.low'));
      g1.appendChild(colorRow('Highest colour', 'heat.high'));
      g1.appendChild(checkboxRow('Text colour follows the cell', 'heat.autoText'));
      g1.appendChild(help('White text on dark cells, dark text on light cells.'));
      g1.appendChild(segRow('One scale for', 'heat.scope', [['grid', 'The whole grid'], ['row', 'Each cohort']]));
    } else {
      g1.appendChild(colorRow('Cell colour', 'heat.noneBg'));
    }
    if (HT.mode === 'ramp') {
      var pct = cfg.values.show !== 'value';
      var g2 = group(p, 'Range');
      g2.appendChild(segRow('Lowest value', 'heat.minMode', [['auto', 'Automatic'], ['fixed', 'Fixed']], rebuild));
      if (HT.minMode === 'fixed') g2.appendChild(numberRow('Lowest' + (pct ? ' (%)' : ''), 'heat.min', -1e9, 1e9, 1));
      g2.appendChild(segRow('Highest value', 'heat.maxMode', [['auto', 'Automatic'], ['fixed', 'Fixed']], rebuild));
      if (HT.maxMode === 'fixed') g2.appendChild(numberRow('Highest' + (pct ? ' (%)' : ''), 'heat.max', -1e9, 1e9, 1));
      g2.appendChild(help('Automatic: the lowest and highest value shown. Fixed values are typed in what the cells show (percentages as 0–100).'));
    }
    var g3 = group(p, 'Empty cells');
    g3.appendChild(colorRow('Colour', 'heat.emptyBg'));
    g3.appendChild(rangeRow('Opacity', 'heat.emptyOpacity', 0, 100, 1, '%'));
    g3.appendChild(help('Cells with no data (the empty corner of the triangle). Not the same as zero.'));
  }

  // ---------------------------------------------------------------------------
  // Layout tab
  // ---------------------------------------------------------------------------
  function buildLayoutTab (p) {
    var g1 = group(p, 'Cells');
    g1.appendChild(numberRow('Narrowest column (px)', 'layout.cellMinWidth', 20, 300, 1));
    g1.appendChild(help('Columns share the width of the worksheet, never narrower than this. When they don’t fit, the grid scrolls.'));
    g1.appendChild(numberRow('Row height (px)', 'layout.rowHeight', 14, 120, 1));
    g1.appendChild(numberRow('Gap between cells (px)', 'layout.gap', 0, 20, 1));
    g1.appendChild(numberRow('Rounded corners (px)', 'layout.radius', 0, 30, 1));
    g1.appendChild(checkboxRow('Freeze headers', 'layout.freeze'));
    g1.appendChild(help('Cohort labels and period headers stay in view while the grid scrolls.'));
    fontRows(g1, 'cells.main');

    var g2 = group(p, 'First column');
    g2.appendChild(checkboxRow('Show cohort size', 'layout.showSize'));
    g2.appendChild(help('Writes the size of each cohort next to its label.'));

    var g3 = group(p, 'Summary row');
    g3.appendChild(segRow('Average row', 'layout.summary', [['none', 'None'], ['top', 'Top'], ['bottom', 'Bottom']], rebuild));
    if (cfg.layout.summary !== 'none') {
      g3.appendChild(textRow('Label', 'layout.summaryLabel', 'Average'));
      g3.appendChild(checkboxRow('Bold', 'headers.summaryBold'));
      g3.appendChild(help('The simple average of the cohorts, period by period, of what the cells show.'));
    }
  }

  // ---------------------------------------------------------------------------
  // Sort and limits tab
  // ---------------------------------------------------------------------------
  function buildSortTab (p) {
    var g1 = group(p, 'Cohorts');
    g1.appendChild(selectRow('Order', 'sort.cohorts', Cg.SORTS));
    g1.appendChild(help('Dates sort as dates, other names in natural order (2, 10, 11).'));
    g1.appendChild(numberRow('Last cohorts only', 'sort.lastCohorts', 0, 1000, 1));
    g1.appendChild(help('Keeps only the newest N cohorts. 0 = all.'));
    var g2 = group(p, 'Periods');
    g2.appendChild(numberRow('First periods only', 'sort.firstPeriods', 0, 1000, 1));
    g2.appendChild(help('Keeps only the first N periods. 0 = all.'));
  }

  // ---------------------------------------------------------------------------
  // Headers tab
  // ---------------------------------------------------------------------------
  function buildHeadersTab (p) {
    var g1 = group(p, 'Period headers');
    g1.appendChild(textRow('Label', 'headers.periodLabel', 'M{n}'));
    g1.appendChild(help('{n} is the period number: “M{n}” → M0, M1 …; “Month {n}”; “+{n}”.'));
    g1.appendChild(segRow('Align', 'headers.colAlign', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
    textStyleRows(g1, 'headers.col');

    var g2 = group(p, 'Cohort labels');
    textStyleRows(g2, 'headers.row');
    var g3 = group(p, 'Cohort size text');
    textStyleRows(g3, 'headers.size');

    var g4 = group(p, 'Top-left corner');
    g4.appendChild(textRow('Text', 'headers.cornerText', 'Cohort'));
    g4.appendChild(textRow('Size column title', 'headers.sizeLabel', 'Size'));
    fontRows(g4, 'headers.cornerStyle');

    var g5 = group(p, 'Background');
    g5.appendChild(colorRow('Color', 'headers.bg'));
    g5.appendChild(rangeRow('Opacity', 'headers.bgOpacity', 0, 100, 1, '%'));
  }

  // ---------------------------------------------------------------------------
  // Tooltip & actions tab
  // ---------------------------------------------------------------------------
  function buildTooltipTab (p) {
    var g1 = group(p, 'Tooltip');
    g1.appendChild(checkboxRow('Show tooltip', 'tooltip.show'));
    g1.appendChild(help('Cohort, period, value, cohort size, % of cohort size and the change from the previous period.'));
    g1.appendChild(checkboxRow('Full numbers', 'tooltip.fullNumbers'));
    g1.appendChild(help('No K / M / B in the tooltip.'));

    var g2 = group(p, 'Mouse');
    g2.appendChild(checkboxRow('Outline the cell under the mouse', 'interaction.hover', rebuild));
    if (cfg.interaction.hover) g2.appendChild(colorRow('Outline colour', 'interaction.hoverColor'));
    g2.appendChild(checkboxRow('Right-click menu', 'interaction.rightClickMenu'));
    g2.appendChild(selectRow('Double-click', 'interaction.dblclick', [['format', 'Opens its settings'], ['none', 'Nothing']]));
    g2.appendChild(segRow('Format window', 'interaction.dialog', [['onTop', 'Always on top'], ['floating', 'Floating']]));
    g2.appendChild(help('Always on top: the Format window stays in front of Tableau until Done or Cancel; the grid behind it still updates live. Floating: you can click the workbook while it is open, but it can fall behind Tableau.'));
    g2.appendChild(checkboxRow('Use Tableau’s tooltip', 'interaction.tableauTooltip'));
    g2.appendChild(help('Shows the tooltip you design in Tableau (Worksheet → Tooltip) instead of this extension’s own tooltip. Needs Tableau 2024.2 or newer. Summary cells have no Tableau tooltip.'));
    g2.appendChild(checkboxRow('Click selects in Tableau', 'interaction.selectInTableau'));
    g2.appendChild(help('A cell selects its cohort and period; a cohort label selects the cohort. Dashboard filter and highlight actions run.'));
  }

  // ---------------------------------------------------------------------------
  // Export tab
  // ---------------------------------------------------------------------------
  function buildExportTab (p) {
    var g1 = group(p, 'Export button');
    g1.appendChild(segRow('Show', 'export.button', [['hover', 'On hover'], ['always', 'Always'], ['never', 'Never']]));
    g1.appendChild(help('The button at the top right, and the right-click menu, export to Excel or CSV and copy the grid.'));
    g1.appendChild(checkboxRow('Save as picture', 'export.picture'));
    g1.appendChild(help('Adds a PNG picture of the whole grid to the export menu.'));
    var g2 = group(p, 'Files');
    g2.appendChild(textRow('File name', 'export.fileName', 'Empty = the title'));
    g2.appendChild(help('Today’s date is added, e.g. “Retention by first order month 2026-11-11.xlsx”.'));
    g2.appendChild(checkboxRow('Title and explanation on top (Excel)', 'export.includeTitle'));
    note(p, '“Grid as shown” exports what the cells show (percentages as numbers Excel can add up, with the heat colours in Excel). “Data” lists one row per cohort and period with the value, cohort size and both percentages. Tableau Desktop can block downloads from extensions: then use <b>Copy grid</b> and paste into Excel.');
  }

  // ---------------------------------------------------------------------------
  // Numbers tab
  // ---------------------------------------------------------------------------
  function buildNumbersTab (p) {
    var g1 = group(p, 'Number format');
    fmtRows(g1, 'format');
    g1.appendChild(help('Used for values, cohort sizes and the tooltip. Percentages use the decimals on the Values tab.'));
    var g2 = group(p, 'Chart text');
    g2.appendChild(fontFamilyRow('Font', 'numbers.font'));
    g2.appendChild(help('Font of the grid and the tooltip. Cell and header fonts are on their tabs.'));
  }

  function buildCardTab (p) {
    var g1 = group(p, 'Card');
    g1.appendChild(numberRow('Padding (px)', 'card.padding', 0, 60, 1));
    g1.appendChild(numberRow('Space above grid', 'card.gap', 0, 60, 1));

    var g2 = group(p, 'Background');
    g2.appendChild(colorRow('Color', 'card.bgColor'));
    g2.appendChild(rangeRow('Opacity', 'card.bgOpacity', 0, 100, 1, '%'));
    g2.appendChild(help('0% is fully transparent. Set worksheet and container shading to None in Tableau to see through. When the grid scrolls, frozen headers are filled with this colour so cells don\'t show through them: match it to the dashboard background.'));

    var g3 = group(p, 'Grid area background');
    g3.appendChild(colorRow('Color', 'card.plotBg'));
    g3.appendChild(rangeRow('Opacity', 'card.plotBgOpacity', 0, 100, 1, '%'));
    g3.appendChild(help('Shades only the area with the grid, e.g. a light panel behind the cells.'));
    var gData = group(p, 'Data');
    gData.appendChild(numberRow('Maximum rows', 'data.maxRows', 0, 1000000, 1));
    gData.appendChild(h('div', { className: 'help', textContent: 'How many rows are read from the worksheet (0 = all). When rows are left out, a note in the corner of the chart says so.' }));

  }

  // ---------------------------------------------------------------------------
  // Presets tab: export / import the chart's settings (file, clipboard, or
  // "My presets" kept in this browser)
  // ---------------------------------------------------------------------------
  var PRESET_TYPE = 'tableau-cohort-grid-preset';
  var PRESET_STORE = 'cohortgrid:presets:v1';

  /**
   * Version of the settings shape inside a preset. When a setting is renamed, moved or
   * changes meaning, raise this and add a step to PRESET_MIGRATIONS (key = the version the
   * step upgrades FROM), so older preset files keep working.
   */
  var PRESET_VERSION = 1;
  var PRESET_MIGRATIONS = {};

  function migratePreset (pr) {
    var v = Number(pr.version) || 1;
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer Cohort Grid. Update the extension, then import it again.');
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  /**
   * Settings tied to this worksheet (title text, explanation
   * and file name). "Look only" presets leave them out, and an
   * import keeps the chart's own unless asked otherwise.
   */
  var FIELD_PATHS = ['title.text', 'explanation.text', 'export.fileName'];

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  /** Only the settings that differ from the defaults (smaller files, future-proof). */
  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : Cg.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? Cg.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    var s = Cg.clone(cfg);
    if (scope === 'look') FIELD_PATHS.forEach(function (p) { delAt(s, p); });
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'Cohort grid preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: diffFromDefaults(s, Cg.DEFAULTS) || {}
    };
  }

  /** Accepts a preset file, or the raw settings JSON of a workbook. */
  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a Cohort Grid preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o.cohortGrid1) { try { o = typeof o.cohortGrid1 === 'string' ? JSON.parse(o.cohortGrid1) : o.cohortGrid1; } catch (e) { /* fall through */ } }
    var known = Object.keys(o).filter(function (k) { return k in Cg.DEFAULTS; });
    if (!known.length) throw new Error('No Cohort Grid settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    var next = Cg.merge(Cg.DEFAULTS, pr.settings);
    FIELD_PATHS.forEach(function (p) {
      var has = getAt(pr.settings, p) !== undefined;
      if (keepFields || pr.scope === 'look' || !has) setAt(next, p, Cg.clone(getAt(cfg, p)));
    });
    cfg = next;
    changed();
  }

  function loadStore () {
    try { var a = JSON.parse(localStorage.getItem(PRESET_STORE) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  function saveStore (list) {
    try { localStorage.setItem(PRESET_STORE, JSON.stringify(list)); return true; } catch (e) { return false; }
  }

  function fileName (name) {
    return (String(name || 'cohort-grid-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'cohort-grid-preset') + '.json';
  }

  function presetMsg (g) {
    if (!presetUi.msg) return;
    g.appendChild(h('p', { className: 'preset-msg' + (presetUi.msg.error ? ' is-error' : ''), textContent: presetUi.msg.text }));
    presetUi.msg = null;
  }

  function say (text, error) { presetUi.msg = { text: text, error: !!error }; rebuild(); }

  function describe (pr) {
    var d = pr.exported ? new Date(pr.exported) : null;
    return (pr.scope === 'look' ? 'Look only' : 'Everything') + (d && !isNaN(d) ? ' · ' + d.toLocaleDateString() : '');
  }

  function buildPresetsTab (p) {
    presetMsg(p);
    // ---- Export
    var g1 = group(p, 'Export');
    g1.appendChild(help('Saves this grid’s settings as a preset you can import into another Cohort Grid, in this or any workbook.'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Retention blue' });
    name.addEventListener('input', function () { presetUi.name = name.value; });
    rName.appendChild(name);
    g1.appendChild(rName);
    var rScope = row('Include');
    var seg = h('div', { className: 'seg' });
    [['look', 'Look only'], ['all', 'Everything']].forEach(function (o) {
      var b = h('button', { type: 'button', textContent: o[1] });
      b.setAttribute('aria-pressed', String(presetUi.scope === o[0]));
      b.addEventListener('click', function () { presetUi.scope = o[0]; rebuild(); });
      seg.appendChild(b);
    });
    rScope.appendChild(seg);
    g1.appendChild(rScope);
    g1.appendChild(help(presetUi.scope === 'look'
      ? 'Values, heat map, layout, headers, numbers, card… Leaves out what belongs to this sheet: title, explanation and file name.'
      : 'Every setting, including the title text. Best for a copy of the same sheet.'));

    var ta = h('textarea', { className: 'preset-json', readOnly: true, spellcheck: false });
    var current = function () { return JSON.stringify(makePreset(presetUi.scope, presetUi.name.trim()), null, 2); };
    var btns = h('div', { className: 'inline preset-btns' });
    var bDl = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Download .json' });
    var bCp = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Copy' });
    var bSave = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Save to My presets' });
    var bShow = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Show JSON' });
    bDl.addEventListener('click', function () {
      var t = current();
      ta.value = t;
      say(download(t, fileName(presetUi.name)) ? 'Downloaded ' + fileName(presetUi.name) + '. If nothing appeared (Tableau Desktop can block downloads), use Copy and paste it into a text file.' : 'Download isn’t available here. Use Copy instead.', false);
    });
    bCp.addEventListener('click', function () {
      var t = current();
      ta.value = t; ta.hidden = false;
      copyText(t, ta).then(function (ok) { say(ok ? 'Copied. Paste it into a .json or text file, an email or chat.' : 'Couldn’t copy. Select the text below and copy it yourself.', !ok); });
    });
    bSave.addEventListener('click', function () {
      var nm = presetUi.name.trim() || 'Preset ' + (loadStore().length + 1);
      var list = loadStore().filter(function (x) { return x.name !== nm; });
      var pr = makePreset(presetUi.scope, nm);
      list.unshift(pr);
      say(saveStore(list) ? 'Saved “' + nm + '” to My presets.' : 'Couldn’t save in this browser. Download or copy the preset instead.', false);
    });
    bShow.addEventListener('click', function () { ta.value = current(); ta.hidden = !ta.hidden; });
    btns.append(bDl, bCp, bSave, bShow);
    g1.appendChild(btns);
    ta.hidden = true;
    g1.appendChild(ta);

    // ---- Import
    var g2 = group(p, 'Import');
    g2.appendChild(help('Applies a preset to this grid. Cancel at the bottom undoes it.'));
    g2.appendChild((function () {
      var r = row('Keep this grid’s');
      var input = h('input', { type: 'checkbox' });
      input.checked = presetUi.keepFields;
      input.addEventListener('change', function () { presetUi.keepFields = input.checked; });
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'title, explanation and file name' })]));
      return r;
    })());
    var file = h('input', { type: 'file', accept: '.json,application/json,text/plain' });
    file.style.display = 'none';
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var pr = parsePreset(rd.result);
          applyImported(pr, presetUi.keepFields);
          say('Applied “' + (pr.name || f.name) + '” (' + describe(pr) + ').', false);
        } catch (e) { say(e.message, true); }
      };
      rd.onerror = function () { say('Couldn’t read the file.', true); };
      rd.readAsText(f);
    });
    var paste = h('textarea', { className: 'preset-json', spellcheck: false, placeholder: 'Or paste a preset here' });
    paste.value = presetUi.pasted;
    paste.addEventListener('input', function () { presetUi.pasted = paste.value; });
    var ib = h('div', { className: 'inline preset-btns' });
    var bFile = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Choose file…' });
    bFile.addEventListener('click', function () { file.value = ''; file.click(); });
    var bPaste = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Apply pasted' });
    bPaste.addEventListener('click', function () {
      if (!paste.value.trim()) { say('Paste a preset into the box first.', true); return; }
      try {
        var pr = parsePreset(paste.value);
        applyImported(pr, presetUi.keepFields);
        presetUi.pasted = '';
        say('Applied “' + pr.name + '” (' + describe(pr) + ').', false);
      } catch (e) { say(e.message, true); }
    });
    ib.append(bFile, bPaste, file);
    g2.appendChild(ib);
    g2.appendChild(paste);

    // ---- My presets (this browser)
    var g3 = group(p, 'My presets');
    var list = loadStore();
    if (!list.length) {
      g3.appendChild(h('p', { className: 'note', textContent: 'None yet. “Save to My presets” keeps a preset on this computer for this extension, ready for any workbook. Download or copy a preset to share it or move it to another computer.' }));
    } else {
      g3.appendChild(help('Kept on this computer for this extension (any workbook). Clearing the browser data of Tableau removes them, so download the ones you want to keep.'));
      list.forEach(function (pr, i) {
        var r = h('div', { className: 'preset-item' });
        var t = h('div', { className: 'preset-name' }, [h('b', { textContent: pr.name }), h('span', { className: 'help', textContent: ' ' + describe(pr) })]);
        var apply = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Apply' });
        apply.addEventListener('click', function () { applyImported(pr, presetUi.keepFields); say('Applied “' + pr.name + '”.', false); });
        var dl = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Download' });
        dl.addEventListener('click', function () { download(JSON.stringify(pr, null, 2), fileName(pr.name)); });
        var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Delete', title: 'Delete this preset' });
        del.addEventListener('click', function () {
          if (del.dataset.sure) { var l = loadStore(); l.splice(i, 1); saveStore(l); say('Deleted “' + pr.name + '”.', false); return; }
          del.dataset.sure = '1'; del.textContent = 'Sure?';
          setTimeout(function () { delete del.dataset.sure; del.textContent = 'Delete'; }, 2500);
        });
        r.append(t, h('div', { className: 'inline' }, [apply, dl, del]));
        g3.appendChild(r);
      });
    }

    // ---- Brand theme (shared by all extensions)
    if (window.ExtTheme && ExtTheme.section) {
      p.appendChild(ExtTheme.section({
        h: h,
        name: 'Cohort Grid',
        themeMap: Cg.THEME_MAP,
        getSettings: function () { return cfg; },
        applySettings: function (next) { cfg = next; changed(); rebuild(); }
      }));
    }
  }
  function buildIconTab (p) {
    var ic = cfg.icon;

    var preview = h('div', { className: 'icon-preview' });
    var slot = h('div', { className: 'slot' });
    var name = h('div', { className: 'name' });
    preview.append(slot, name);
    var refreshPreview = function () {
      slot.innerHTML = '';
      slot.classList.remove('slot--dark');
      if (!ic.show) { name.textContent = 'Icon hidden'; return; }
      if (ic.source === 'builtin') {
        var r = Cg.iconHtml(ic.builtinId, ic.color);
        slot.innerHTML = r.html;
        slot.classList.toggle('slot--dark', !!r.icon.light);
        name.textContent = r.icon.label;
      } else if (ic.dataUrl) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 24; var hh = img.naturalHeight || 24;
          if (w >= hh) { img.style.width = '24px'; img.style.height = 'auto'; } else { img.style.height = '24px'; img.style.width = 'auto'; }
        };
        img.src = ic.dataUrl;
        slot.appendChild(img);
        name.textContent = ic.name || (ic.source === 'shape' ? 'Tableau shape' : 'Uploaded image');
      } else {
        name.textContent = 'No image chosen yet';
      }
    };
    refreshPreview();

    var g = group(p, 'Icon');
    g.appendChild(preview);
    g.appendChild(checkboxRow('Show icon', 'icon.show', function () { refreshPreview(); }));
    g.appendChild(rangeRow('Size', 'icon.size', 12, 96, 1, ' px'));
    g.appendChild(h('div', { className: 'help', textContent: 'Length of the icon\u2019s longer side. Figma default is 24 px; icons stay sharpest up to about 48 px.' }));

    var sources = [['builtin', 'Built-in'], ['shape', 'Tableau shapes'], ['upload', 'Upload']];
    var sourceRow = row('Source');
    var seg = h('div', { className: 'seg' });
    sources.forEach(function (s) {
      var b = h('button', { type: 'button', textContent: s[1] });
      b.setAttribute('aria-pressed', String(ic.source === s[0]));
      b.addEventListener('click', function () {
        ic.source = s[0];
        if (s[0] === 'builtin') ic.show = true;
        changed();
        buildTabs();
      });
      seg.appendChild(b);
    });
    sourceRow.appendChild(seg);
    g.appendChild(sourceRow);

    var body = group(p, sources.find(function (s) { return s[0] === ic.source; })[1]);

    if (ic.source === 'builtin') {
      var gridWrap = h('div');
      var fillGrid = function () {
        gridWrap.innerHTML = '';
        Cg.ICON_GROUPS.forEach(function (groupName) {
          var icons = Cg.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Cg.iconHtml(icon.id, ic.color).html;
            if (icon.id === ic.builtinId) cell.classList.add('is-active');
            cell.addEventListener('click', function () {
              ic.builtinId = icon.id;
              ic.show = true;
              Array.prototype.forEach.call(gridWrap.querySelectorAll('.cell'), function (c) { c.classList.remove('is-active'); });
              cell.classList.add('is-active');
              changed();
              refreshPreview();
            });
            grid.appendChild(cell);
          });
          gridWrap.appendChild(grid);
        });
      };
      body.appendChild(colorRow('Icon color', 'icon.color', function () { refreshPreview(); fillGrid(); }));
      body.appendChild(h('div', { className: 'help', textContent: 'Recolours the built-in icons.' }));
      fillGrid();
      body.appendChild(gridWrap);
    } else if (ic.source === 'shape') {
      buildShapePicker(body, refreshPreview);
    } else {
      buildUpload(body, refreshPreview);
    }
  }

  /** Lists Tableau shape palettes served by serve.py (/shapes/index.json). */
  function buildShapePicker (body, refreshPreview) {
    var note = h('p', { className: 'note', textContent: 'Loading shape palettes…' });
    body.appendChild(note);

    var loadIndex = shapeIndex ? Promise.resolve(shapeIndex)
      : fetch(baseUrl() + 'shapes/index.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (j) { shapeIndex = j; return j; });

    loadIndex.then(function (index) {
      var palettes = (index.palettes || []).filter(function (pl) { return pl.files && pl.files.length; });
      if (!palettes.length) {
        note.innerHTML = 'No shape palettes found. serve.py looked in:<br><code>' +
          (index.searched || []).map(escapeHtml).join('</code><br><code>') +
          '</code><br>Set <code>KPI_SHAPES_DIRS</code> before starting it to add folders.';
        return;
      }
      note.textContent = 'Shapes are copied into the workbook when picked, so they keep working after publishing.';

      var selRow = row('Palette');
      var sel = h('select');
      palettes.forEach(function (pl, i) { sel.appendChild(h('option', { value: String(i), textContent: pl.name + ' (' + pl.files.length + ')' })); });
      var remembered = palettes.findIndex(function (pl) { return cfg.icon.name.indexOf(pl.name + ' / ') === 0; });
      sel.value = String(remembered >= 0 ? remembered : 0);
      selRow.appendChild(sel);
      body.appendChild(selRow);

      var grid = h('div', { className: 'grid' });
      body.appendChild(grid);

      var fill = function () {
        grid.innerHTML = '';
        var pl = palettes[Number(sel.value)];
        pl.files.forEach(function (f) {
          var label = pl.name + ' / ' + f.name;
          var cell = h('button', { type: 'button', className: 'cell', title: f.name });
          cell.appendChild(h('img', { src: baseUrl() + f.url, alt: '', loading: 'lazy' }));
          if (cfg.icon.source === 'shape' && cfg.icon.name === label) cell.classList.add('is-active');
          cell.addEventListener('click', function () {
            fetch(baseUrl() + f.url).then(function (r) { return r.blob(); })
              .then(blobToIconDataUrl)
              .then(function (url) {
                cfg.icon.source = 'shape';
                cfg.icon.dataUrl = url;
                cfg.icon.name = label;
                cfg.icon.show = true;
                Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('is-active'); });
                cell.classList.add('is-active');
                changed();
                refreshPreview();
              })
              .catch(function (e) { setStatus('Could not load that shape: ' + e.message); });
          });
          grid.appendChild(cell);
        });
      };
      sel.addEventListener('change', fill);
      fill();
    }).catch(function () {
      note.innerHTML = 'Tableau shapes are listed by the local helper server. Start the extension with ' +
        '<code>./serve.sh</code> (it runs <code>serve.py</code>), then reopen this dialog. ' +
        'You can still upload a shape file from the <b>Upload</b> tab.';
    });
  }

  function buildUpload (body, refreshPreview) {
    var drop = h('label', { className: 'drop' });
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp,.ico' });
    drop.append(input,
      h('b', { textContent: 'Choose an image' }),
      h('span', { textContent: 'or drop it here — PNG, SVG, JPG, GIF. Tableau custom shapes work too.' }));
    body.appendChild(drop);
    body.appendChild(h('p', {
      className: 'note',
      textContent: 'Scaled to 24 px on its longer side. Raster images are stored at 96 px for sharp rendering on high-DPI screens.'
    }));

    var take = function (file) {
      if (!file) return;
      blobToIconDataUrl(file).then(function (url) {
        cfg.icon.source = 'upload';
        cfg.icon.dataUrl = url;
        cfg.icon.name = file.name;
        cfg.icon.show = true;
        changed();
        refreshPreview();
      }).catch(function (e) { setStatus('Could not read that image: ' + e.message); });
    };
    input.addEventListener('change', function () { take(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) { take(e.dataTransfer.files[0]); });
  }

  function buildTextTab (p) {
    var g1 = group(p, 'Title');
    g1.appendChild(checkboxRow('Show title', 'title.show'));
    g1.appendChild(textRow('Title', 'title.text', 'Empty = Value by Cohort'));
    g1.appendChild(segRow('Alignment', 'title.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
    g1.appendChild(h('div', { className: 'help', textContent: 'The explanation text follows the same alignment.' }));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(checkboxRow('Keep space when empty', 'explanation.reserveSpace'));
    g2.appendChild(h('div', { className: 'help', textContent: 'Reserves the explanation line even when it is empty or hidden, so charts line up across a dashboard.' }));
    g2.appendChild(textRow('Text', 'explanation.text', 'e.g. % Top-Up vs Local Transfer'));
    fontRows(g2, 'explanation', true);
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  function get (path) {
    return P(path).reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg);
  }

  function set (path, value) {
    var keys = P(path);
    var last = keys.pop();
    keys.reduce(function (o, k) {
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      return o[k];
    }, cfg)[last] = value;
    changed();
  }

  function changed () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 180);
    if (hist) hist.record();
  }

  function flush () {
    clearTimeout(saveTimer);
    return persist();
  }

  function persist () {
    try {
      setStatus('Saving…');
      return Cg.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }


  window.CohortGridConfigure = { init: init };
})();

