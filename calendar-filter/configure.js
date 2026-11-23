'use strict';

/**
 * Format dialog for Calendar Filter (opened by "Format Extension" on the Marks card).
 *
 * Every change is saved straight away (debounced), so the text box behind the dialog updates
 * live. Cancel restores what was stored on open.
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var hist = null;
  var activeTab = 'box';
  var fieldName = ''; // the date field's name, sent by the text box

  const kit = ExtDialog.kit({
    get: get,
    set: set,
    fonts: Cf.FONTS,
    fontPath: function (section, key) { return section + '.' + key; }
  });
  const h = ExtDialog.h, group = ExtDialog.group, setStatus = ExtDialog.setStatus;
  const row = kit.row, textRow = kit.textRow, numberRow = kit.numberRow, rangeRow = kit.rangeRow,
    checkboxRow = kit.checkboxRow, selectRow = kit.selectRow, segRow = kit.segRow, colorRow = kit.colorRow,
    fontFamilyRow = kit.fontFamilyRow, fontRows = kit.fontRows;
  const help = ExtDialog.help, copyText = ExtDialog.copyText, download = ExtDialog.download,
    getAt = ExtDialog.getAt, setAt = ExtDialog.setAt, delAt = ExtDialog.delAt;

  var TABS = [
    { id: 'box', label: 'Text box', build: buildBoxTab, keys: ['title', 'box'] },
    { id: 'window', label: 'Window', build: buildWindowTab, keys: ['window'] },
    { id: 'calendar', label: 'Calendar', build: buildCalendarTab, keys: ['calendar', 'selection', 'nulls'] },
    { id: 'quick', label: 'Quick ranges', build: buildQuickTab, keys: ['quick'] },
    { id: 'look', label: 'Look', build: buildLookTab, keys: ['look', 'card'] },
    { id: 'presets', label: 'Presets', build: buildPresetsTab, keys: [] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try { fieldName = JSON.parse(payload || '{}').field || ''; } catch (e) { fieldName = ''; }
      cfg = Cf.read();
      original = Cf.clone(cfg);
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
      document.getElementById('cancel').addEventListener('click', function () { cfg = original; flush().then(close); });
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('Calendar Filter dialog failed to initialize:', err);
    });
  }

  function buildTabs () {
    var nav = document.getElementById('tabs');
    var panels = document.getElementById('panels');
    nav.innerHTML = '';
    panels.innerHTML = '';
    TABS.forEach(function (tab) {
      var b = h('button', { className: 'tab', type: 'button', role: 'tab', textContent: tab.label });
      b.setAttribute('aria-selected', String(tab.id === activeTab));
      b.addEventListener('click', function () { activeTab = tab.id; buildTabs(); });
      nav.appendChild(b);
      var panel = h('section', { className: 'panel', role: 'tabpanel' });
      panel.hidden = tab.id !== activeTab;
      if (!panel.hidden) tab.build(panel);
      panels.appendChild(panel);
    });
  }

  function rebuild () { buildTabs(); }

  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) { cfg[k] = Cf.clone(Cf.DEFAULTS[k]); });
    changed();
    buildTabs();
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
  function buildBoxTab (p) {
    var g1 = group(p, 'Title above the box');
    g1.appendChild(segRow('Show', 'title.mode', [['field', 'Field name'], ['custom', 'Custom'], ['none', 'None']], rebuild));
    if (cfg.title.mode === 'field') g1.appendChild(help('Shows “' + (fieldName || 'the field on the Date tile') + '”.'));
    if (cfg.title.mode === 'custom') g1.appendChild(textRow('Text', 'title.text', 'e.g. Period'));
    if (cfg.title.mode !== 'none') fontRows(g1, 'title');

    var g2 = group(p, 'Text box');
    g2.appendChild(textRow('When nothing is filtered', 'box.placeholder', 'All dates'));
    g2.appendChild(checkboxRow('Clear button (×)', 'box.clearButton'));
    g2.appendChild(help('Clears the filter without opening the calendar. Shown only while something is filtered.'));
    g2.appendChild(checkboxRow('Calendar icon', 'box.icon'));
    g2.appendChild(numberRow('Height (px)', 'box.height', 20, 80, 1));
    g2.appendChild(numberRow('Corner radius (px)', 'box.radius', 0, 40, 1));
    g2.appendChild(colorRow('Background', 'box.bgColor'));
    g2.appendChild(colorRow('Border', 'box.borderColor'));

    var g3 = group(p, 'Text in the box');
    fontRows(g3, 'box');
  }

  function buildWindowTab (p) {
    var g1 = group(p, 'Applying the choice');
    g1.appendChild(segRow('Filter the dashboard', 'window.apply', [['button', 'On Apply'], ['live', 'Live, on every click']], rebuild));
    g1.appendChild(help(cfg.window.apply === 'live'
      ? 'Every click filters the dashboard straight away; the window stays open until Close. Needs Tableau 2023.1 or later — older versions apply when the window closes.'
      : 'Nothing changes on the dashboard until Apply. Cancel, Esc or × close the window and keep the filter as it was.'));

    var g2 = group(p, 'The window');
    g2.appendChild(segRow('Size', 'window.size', [['S', 'Small'], ['M', 'Medium'], ['L', 'Large']]));
    g2.appendChild(help('Small 380 × 400 · Medium 480 × 460 · Large 620 × 520 px. Tableau decides where the window opens (usually the middle of the Tableau window).'));
    g2.appendChild(segRow('Position', 'window.dialog', [['onTop', 'On top of Tableau'], ['floating', 'Floating']]));
    g2.appendChild(help('On top: the window stays in front until it is closed (the dashboard behind still updates in Live mode). Floating: it can go behind the Tableau window.'));
    g2.appendChild(checkboxRow('How-to line at the bottom', 'window.help'));
    g2.appendChild(help('One line that says what click, Shift-click, Ctrl/⌘-click and drag do, for the click behaviour chosen in the Calendar tab.'));
  }

  function buildCalendarTab (p) {
    var g1 = group(p, 'Calendar');
    g1.appendChild(selectRow('Week starts on', 'calendar.weekStart', [[0, 'Sunday'], [1, 'Monday'], [6, 'Saturday']]));
    g1.appendChild(help('Changes the Week rows, their numbers (week 1 holds 1 January, like Tableau’s WEEK) and the day columns. A week filter in force is cleared when this changes.'));
    var r = row('Granularities');
    var wrap = h('div', { className: 'inline' });
    [['showYear', 'Year'], ['showMonth', 'Month'], ['showWeek', 'Week'], ['showDay', 'Day']].forEach(function (o) {
      var input = h('input', { type: 'checkbox' });
      input.checked = !!cfg.calendar[o[0]];
      input.addEventListener('change', function () {
        var next = Cf.clone(cfg.calendar);
        next[o[0]] = input.checked;
        if (!next.showYear && !next.showMonth && !next.showWeek && !next.showDay) { input.checked = true; setStatus('At least one granularity stays on.'); return; }
        set('calendar.' + o[0], input.checked);
      });
      wrap.append(h('label', { className: 'inline-check' }, [input, document.createTextNode(' ' + o[1])]));
    });
    r.appendChild(wrap);
    g1.appendChild(r);
    g1.appendChild(selectRow('Opens at', 'calendar.openAt', [['Y', 'Year'], ['M', 'Month'], ['W', 'Week'], ['D', 'Day']],
      'The granularity shown when nothing is filtered. With a filter, the window opens at the filter’s granularity.'));
    g1.appendChild(checkboxRow('Day view: days of the next / previous month', 'calendar.adjacentDays'));

    var g2 = group(p, 'Clicking');
    g2.appendChild(selectRow('Click behaviour', 'selection.mode', [
      ['multi', 'Standard — click picks one, Shift = range, Ctrl/⌘ = add'],
      ['toggle', 'Toggle — every click adds or removes'],
      ['single', 'Single value only'],
      ['range', 'Range only — click the first, then the last']
    ], 'Toggle suits touch screens and people who don’t know the modifier keys.'));
    g2.appendChild(checkboxRow('Drag across cells to pick a range', 'selection.drag'));
    g2.appendChild(selectRow('Periods with no data', 'selection.emptyPeriods', [['dim', 'Greyed, can still be picked'], ['off', 'Greyed, can’t be picked']]));

    var g3 = group(p, 'Null dates');
    g3.appendChild(selectRow('Control in the window', 'nulls.control', [['seg', 'Include / Exclude / Only'], ['check', 'Include checkbox'], ['hidden', 'Hidden (always the default)']]));
    g3.appendChild(segRow('Default', 'nulls.default', [['include', 'Include nulls'], ['exclude', 'Exclude nulls']]));
    g3.appendChild(help('What a new or cleared filter does with rows that have no date. The control appears only when the data has null dates.'));
  }

  function buildQuickTab (p) {
    var g1 = group(p, 'Quick ranges');
    g1.appendChild(selectRow('Where', 'quick.position', [['side', 'List on the left'], ['dropdown', 'Dropdown in the header'], ['chips', 'Chips under the header'], ['off', 'Off']]));
    g1.appendChild(selectRow('Count back from', 'quick.anchor', [['today', 'Today'], ['data', 'The latest date in the data']],
      'Latest date suits data that lands a day or two late: “Last 7 days” then ends on the last loaded day.'));
    g1.appendChild(help('“To date” ranges and “Last 7 / 30 days” pick exact days, so they switch the calendar to Day. A quick range whose granularity is switched off is not listed.'));
    var g2 = group(p, 'Listed');
    Cf.QUICK.forEach(function (q) { g2.appendChild(checkboxRow(q[1], 'quick.items.' + q[0])); });
  }

  function buildLookTab (p) {
    var g1 = group(p, 'Calendar window');
    g1.appendChild(colorRow('Accent', 'look.accent'));
    g1.appendChild(help('Selected cells, the granularity buttons and Apply. Pick any colour or type a hex code.'));
    g1.appendChild(fontFamilyRow('Font', 'look.font'));
    g1.appendChild(colorRow('Text', 'look.textColor'));
    g1.appendChild(colorRow('Muted text', 'look.mutedColor'));
    g1.appendChild(colorRow('Background', 'look.bgColor'));
    g1.appendChild(checkboxRow('Value in each cell', 'look.cellNumbers'));
    g1.appendChild(checkboxRow('Shade cells by Value', 'look.heat'));
    g1.appendChild(help('Both use the measure on the Value tile. Without one, cells show no number and shading only marks the days that have data.'));

    var g2 = group(p, 'Zone');
    g2.appendChild(numberRow('Padding (px)', 'card.padding', 0, 40, 1));
    g2.appendChild(colorRow('Background', 'card.bgColor'));
    g2.appendChild(rangeRow('Opacity', 'card.bgOpacity', 0, 100, 1, '%'));
    g2.appendChild(help('0% is fully transparent. Set worksheet and container shading to None in Tableau to see through.'));
  }

  // ---------------------------------------------------------------------------
  // Presets (settings presets, not to be confused with Quick ranges)
  // ---------------------------------------------------------------------------
  var PRESET_TYPE = 'tableau-calendar-filter-preset';
  var PRESET_STORE = 'calendarfilter:presets:v1';

  /** Settings that name this filter; "Look only" presets leave them out. */
  var FIELD_PATHS = [
    'title.text' // custom title text
  ];

  var PRESET_VERSION = 1;
  var PRESET_MIGRATIONS = {};

  function migratePreset (pr) {
    var v = pr.version || 1;
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer Calendar Filter. Update the extension, then import it again.');
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : Cf.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? Cf.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    var s = Cf.clone(cfg);
    if (scope === 'look') FIELD_PATHS.forEach(function (pth) { delAt(s, pth); });
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'Calendar Filter preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: diffFromDefaults(s, Cf.DEFAULTS) || {}
    };
  }

  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a Calendar Filter preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o[Cf.STORAGE_KEY]) { try { o = typeof o[Cf.STORAGE_KEY] === 'string' ? JSON.parse(o[Cf.STORAGE_KEY]) : o[Cf.STORAGE_KEY]; } catch (e) { /* fall through */ } }
    var known = Object.keys(o).filter(function (k) { return k in Cf.DEFAULTS; });
    if (!known.length) throw new Error('No Calendar Filter settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    pr = migratePreset(pr);
    var next = Cf.merge(Cf.DEFAULTS, pr.settings);
    var own = pr.scope === 'look' || keepFields;
    FIELD_PATHS.forEach(function (pth) {
      var has = getAt(pr.settings, pth) !== undefined;
      if (own || !has) setAt(next, pth, Cf.clone(getAt(cfg, pth)));
    });
    cfg = next;
    changed();
    buildTabs();
  }

  function loadStore () {
    try { var a = JSON.parse(localStorage.getItem(PRESET_STORE) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  function saveStore (list) {
    try { localStorage.setItem(PRESET_STORE, JSON.stringify(list)); return true; } catch (e) { return false; }
  }

  function fileName (name) {
    return (String(name || 'calendar-filter-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'calendar-filter-preset') + '.json';
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
    var g1 = group(p, 'Export');
    g1.appendChild(help('Saves this filter’s settings as a preset you can import into another Calendar Filter, in this or any workbook. (Today, Month to date… are in the Quick ranges tab.)'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Teal, Monday weeks' });
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
      ? 'Every setting except the custom title text.'
      : 'Every setting, including the custom title text.'));

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
      list.unshift(makePreset(presetUi.scope, nm));
      say(saveStore(list) ? 'Saved “' + nm + '” to My presets.' : 'Couldn’t save in this browser. Download or copy the preset instead.', false);
    });
    bShow.addEventListener('click', function () { ta.value = current(); ta.hidden = !ta.hidden; });
    btns.append(bDl, bCp, bSave, bShow);
    g1.appendChild(btns);
    ta.hidden = true;
    g1.appendChild(ta);

    var g2 = group(p, 'Import');
    g2.appendChild(help('Applies a preset to this filter. Cancel at the bottom undoes it.'));
    g2.appendChild((function () {
      var r = row('Keep this filter’s');
      var input = h('input', { type: 'checkbox' });
      input.checked = presetUi.keepFields;
      input.addEventListener('change', function () { presetUi.keepFields = input.checked; });
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'custom title text' })]));
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

    var g3 = group(p, 'My presets');
    var list = loadStore();
    if (!list.length) {
      g3.appendChild(h('p', { className: 'note', textContent: 'None yet. “Save to My presets” keeps a preset on this computer for this extension, ready for any workbook.' }));
    } else {
      g3.appendChild(help('Kept on this computer for this extension (any workbook). Clearing Tableau’s browser data removes them, so download the ones you want to keep.'));
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
    if (window.ExtTheme && ExtTheme.section) {
      p.appendChild(ExtTheme.section({
        h: h,
        name: 'Calendar Filter',
        themeMap: Cf.THEME_MAP,
        getSettings: function () { return cfg; },
        applySettings: function (next) { cfg = next; changed(); rebuild(); }
      }));
    }
  }

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  function get (path) {
    return path.split('.').reduce(function (o, k) { return o[k]; }, cfg);
  }

  function set (path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    keys.reduce(function (o, k) { return o[k]; }, cfg)[last] = value;
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
      return Cf.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }

  window.CalendarFilterConfigure = { init: init };
})();
