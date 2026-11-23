'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing Calendar Filter in a normal browser
 * (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - ?data=NAME  data set (see DATASETS). Made-up daily data.
 * - The sheet has Start date / End date on its tiles ({MIN} / {MAX} FIXED: never changed by the
 *   filter) and an "Order Date" filter on its Filters shelf: categorical (Exact Date) or a range.
 * - The filter is kept in localStorage per data set (like a filter saved in the workbook).
 *   applyFilterAsync / applyRangeFilterAsync / clearFilterAsync change it and fire FilterChanged
 *   and SummaryDataChanged; the preview page shows it as the Filters pane would.
 * - Settings live in localStorage too, so the text box, the calendar window and the Format dialog
 *   (three frames) see each other's changes, as inside Tableau.
 * - Dialogs: displayDialogAsync asks the preview page to open the window (sized like Tableau would);
 *   closeDialog(payload) resolves it; sendDialogMessageToParentAsync reaches the text box through
 *   the preview page (DialogMessageReceived).
 * - ?failInit=N / ?hangInit=N: first N handshakes fail / never answer.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const page = (/([a-z]+)\.html$/.exec(location.pathname) || [])[1] || 'index';
  const isDialog = page === 'configure' || page === 'picker';

  const DATASETS = {
    default: 'Exact Date filter, 42 null dates',
    range: 'Range-of-dates filter',
    datetime: 'Exact Date filter on a date-time',
    nonull: 'Exact Date filter, no null dates',
    relative: 'Relative-date filter (message)',
    nofilter: 'No filter on the Filters shelf (message)',
    notiles: 'Nothing on Start / End (message)'
  };
  const dataName = DATASETS[params.get('data')] ? params.get('data') : 'default';
  const SET_KEY = 'cfMockSettings:' + dataName;
  const FILTER_KEY = 'cfMockFilter:' + dataName;
  const PAYLOAD_KEY = 'cfMockPayload:' + page;
  const FIELD = 'Order Date';
  const KIND = dataName === 'range' ? 'range' : dataName === 'relative' ? 'relative-date' : 'categorical';

  // ---- Data: the days that have rows ---------------------------------------------
  let seed = 11;
  function rnd () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  function iso (t) { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }
  const DAYS = []; // iso strings
  (function () {
    const now = new Date();
    const end = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - 3 * 864e5; // data lands 3 days late
    for (let t = Date.UTC(2024, 2, 4); t <= end; t += 864e5) {
      const d = new Date(t);
      const m = d.getUTCMonth();
      const day = d.getUTCDate();
      if ((m === 11 && day >= 25) || (m === 0 && day === 1)) continue; // holiday gap
      if (d.getUTCFullYear() === 2025 && m === 7 && day >= 10 && day <= 23) continue; // two missing weeks
      const w = d.getUTCDay();
      if ((w === 5 || w === 6) && rnd() < 0.3) continue; // some quiet weekends
      DAYS.push(iso(t));
    }
  })();
  const HAS_NULL = dataName !== 'nonull';
  const MIN_DAY = DAYS[0];
  const MAX_DAY = DAYS[DAYS.length - 1];

  function rawOf (day) { return dataName === 'datetime' ? [day + ' 09:15:00', day + ' 14:40:00'] : [day]; }
  function dv (v) { return v == null ? { value: '%null%', nativeValue: null, formattedValue: 'Null' } : { value: v, nativeValue: v, formattedValue: v }; }

  // ---- The filter (stored like the workbook stores it) -----------------------------
  function readFilter () {
    try { const f = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null'); if (f) return f; } catch (e) { /* ignore */ }
    return { all: true };
  }
  function writeFilter (f) {
    localStorage.setItem(FILTER_KEY, JSON.stringify(f));
    parent.postMessage({ type: 'cf-filter', text: describe(f) }, '*');
    setTimeout(function () {
      filterHandlers.forEach(function (h) { h({ fieldName: FIELD }); });
      dataHandlers.forEach(function (h) { h({}); });
    }, 30);
  }
  function describe (f) {
    if (KIND === 'range') {
      if (f.all) return FIELD + ': all dates (range filter cleared)';
      return FIELD + ': range ' + f.min + ' to ' + f.max + ' · null option: ' + f.nullOption;
    }
    if (f.all) return FIELD + ': (All)';
    const vals = f.values || [];
    return FIELD + ': ' + (f.exclude ? 'excludes ' : '') + vals.length + ' value' + (vals.length === 1 ? '' : 's') + ' — ' + vals.slice(0, 5).map(function (v) { return v == null || v === '%null%' ? 'Null' : v; }).join(', ') + (vals.length > 5 ? ', …' : '');
  }
  window.mockDescribeFilter = function () { return describe(readFilter()); };

  /** Does any row pass the filter? (Start / End are FIXED, but an empty sheet has no rows at all.) */
  function anyRowPasses () {
    const f = readFilter();
    if (f.all) return true;
    if (KIND === 'range') {
      if (f.nullOption === 'null-values') return HAS_NULL;
      return DAYS.some(function (d) { return d >= f.min && d <= f.max; }) || (f.nullOption === 'all-values' && HAS_NULL);
    }
    const set = {};
    (f.values || []).forEach(function (v) { set[v == null ? '%null%' : String(v).slice(0, 10)] = true; });
    const inData = DAYS.some(function (d) { return set[d]; });
    const nullIn = !!set['%null%'];
    return f.exclude ? (DAYS.some(function (d) { return !set[d]; }) || (HAS_NULL && !nullIn)) : (inData || (HAS_NULL && nullIn));
  }

  function buildTable () {
    if (dataName === 'notiles') return { name: 'Summary', columns: [], data: [], totalRowCount: 0, isSummaryData: true };
    const columns = [
      { fieldName: 'Start Date', fieldId: '[mock].[none:Calculation_start:ok]', index: 0, dataType: 'date' },
      { fieldName: 'End Date', fieldId: '[mock].[none:Calculation_end:ok]', index: 1, dataType: 'date' }
    ];
    const data = anyRowPasses() ? [[dv(MIN_DAY), dv(MAX_DAY)]] : [];
    return { name: 'Summary', columns: columns, data: data, totalRowCount: data.length, isSummaryData: true };
  }

  function makeFilter () {
    const f = readFilter();
    if (KIND === 'relative-date') return { fieldName: FIELD, filterType: 'relative-date', worksheetName: 'Calendar' };
    if (KIND === 'range') {
      return {
        fieldName: FIELD,
        filterType: 'range',
        worksheetName: 'Calendar',
        minValue: dv(f.all ? MIN_DAY : f.min),
        maxValue: dv(f.all ? MAX_DAY : f.max),
        nullOption: f.all ? 'all-values' : f.nullOption,
        includeNullValues: f.all || f.nullOption !== 'non-null-values'
      };
    }
    const domain = [];
    DAYS.forEach(function (d) { rawOf(d).forEach(function (r) { domain.push(dv(r)); }); });
    if (HAS_NULL) domain.push(dv(null));
    let applied;
    if (f.all) applied = domain.slice();
    else applied = (f.values || []).map(function (v) { return dv(v === '%null%' ? null : v); });
    return {
      fieldName: FIELD,
      filterType: 'categorical',
      worksheetName: 'Calendar',
      isAllSelected: !!f.all,
      isExcludeMode: !f.all && !!f.exclude,
      appliedValues: applied,
      getDomainAsync: function () { return Promise.resolve({ type: 'database', values: domain }); }
    };
  }

  // ---- Settings ----------------------------------------------------------------
  function readSettings () {
    try { const s = localStorage.getItem(SET_KEY); if (s) return JSON.parse(s); } catch (e) { /* ignore */ }
    return {};
  }
  let pending = readSettings();
  const settingsHandlers = [];
  const filterHandlers = [];
  const dataHandlers = [];
  window.addEventListener('storage', function (e) {
    if (e.key !== SET_KEY) return;
    pending = readSettings();
    settingsHandlers.forEach(function (h) { h({}); });
  });

  // ---- Dialogs and preview buttons -------------------------------------------------
  let dialogDone = null;
  const msgHandlers = [];
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d) return;
    if (d.type === 'cf-dialog-closed' && dialogDone) {
      const done = dialogDone;
      dialogDone = null;
      done(d.payload);
    }
    if (d.type === 'cf-dialog-message') msgHandlers.forEach(function (h) { h({ message: d.message }); });
    if (d.type === 'cf-configure' && !isDialog) { const c = tableau.extensions._configure; if (c) c(); }
    if (d.type === 'cf-external' && !isDialog) {
      // A change made in the Filters pane: the last 7 days with data (categorical) or that span (range).
      const last = DAYS.slice(-7);
      writeFilter(KIND === 'range' ? { min: last[0], max: last[last.length - 1], nullOption: 'non-null-values' } : { values: [].concat.apply([], last.map(rawOf)), exclude: false });
    }
    if (d.type === 'cf-external-clear' && !isDialog) writeFilter({ all: true });
  });

  const worksheet = {
    name: 'Calendar (mock)',
    getFiltersAsync: function () { return Promise.resolve(dataName === 'nofilter' ? [] : [makeFilter()]); },
    applyFilterAsync: function (field, values, updateType, options) {
      console.log('mock applyFilterAsync', field, (values || []).length + ' values', JSON.stringify((values || []).slice(0, 4)), updateType, JSON.stringify(options || {}));
      writeFilter({ values: (values || []).map(function (v) { return v == null ? '%null%' : v; }), exclude: !!(options && options.isExcludeMode) });
      return Promise.resolve(field);
    },
    applyRangeFilterAsync: function (field, o) {
      console.log('mock applyRangeFilterAsync', field, JSON.stringify(o));
      writeFilter({ min: iso(+o.min), max: iso(+o.max), nullOption: o.nullOption || 'non-null-values' });
      return Promise.resolve(field);
    },
    clearFilterAsync: function (field) { console.log('mock clearFilterAsync', field); writeFilter({ all: true }); return Promise.resolve(field); },
    getSummaryDataAsync: function (opts) {
      return new Promise(function (r) { setTimeout(function () { r(buildTable()); }, 40); });
    },
    getSummaryDataReaderAsync: function () {
      const t = buildTable();
      let released = false;
      return Promise.resolve({
        pageCount: 1,
        totalRowCount: t.data.length,
        getPageAsync: function () {
          if (released) return Promise.reject(new Error('mock: reader already released'));
          return Promise.resolve({ columns: t.columns, data: t.data, totalRowCount: t.data.length, isSummaryData: true });
        },
        getAllPagesAsync: function () { return Promise.resolve({ columns: t.columns, data: t.data, totalRowCount: t.data.length, isSummaryData: true }); },
        releaseAsync: function () { released = true; return Promise.resolve(); }
      });
    },
    getVisualSpecificationAsync: function () {
      const enc = dataName === 'notiles' ? [] : [
        { id: 'start', field: { id: '[mock].[none:Calculation_start:ok]', name: 'Start Date' } },
        { id: 'end', field: { id: '[mock].[none:Calculation_end:ok]', name: 'End Date' } }
      ];
      return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: enc }] });
    },
    addEventListener: function (t, h) {
      if (t === 'summary-data-changed') dataHandlers.push(h);
      if (t === 'filter-changed') filterHandlers.push(h);
      return function () {};
    }
  };

  window.tableau = {
    TableauEventType: {
      SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed',
      FilterChanged: 'filter-changed', DialogMessageReceived: 'dialog-message-received'
    },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    FilterUpdateType: { Add: 'add', All: 'all', Replace: 'replace', Remove: 'remove' },
    FilterNullOption: { NullValues: 'null-values', NonNullValues: 'non-null-values', AllValues: 'all-values' },
    FilterDomainType: { Relevant: 'relevant', Database: 'database' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function (opts) {
        window.tableau.extensions._configure = opts && opts.configure;
        if (!isDialog) setTimeout(function () { parent.postMessage({ type: 'cf-filter', text: describe(readFilter()) }, '*'); }, 50);
        return new Promise(function (r) { setTimeout(r, 30); });
      },
      initializeDialogAsync: function () { return Promise.resolve(localStorage.getItem(PAYLOAD_KEY) || ''); },
      worksheetContent: { worksheet: worksheet },
      settings: {
        get: function (k) { return pending[k]; },
        set: function (k, v) { pending[k] = v; },
        getAll: function () { return pending; },
        saveAsync: function () { localStorage.setItem(SET_KEY, JSON.stringify(pending)); return Promise.resolve(pending); },
        addEventListener: function (t, h) { if (t === 'settings-changed') settingsHandlers.push(h); return function () {}; }
      },
      ui: {
        displayDialogAsync: function (url, payload, opts) {
          const kind = /picker\.html$/.test(url) ? 'picker' : 'configure';
          localStorage.setItem('cfMockPayload:' + kind, payload || '');
          parent.postMessage({ type: 'cf-open-dialog', url: url + '?mock&data=' + dataName, kind: kind, options: opts || {} }, '*');
          return new Promise(function (resolve, reject) {
            dialogDone = function (p) {
              if (p == null) { const e = new Error('Extension dialog closed by user.'); e.errorCode = 'dialog-closed-by-user'; reject(e); } else resolve(p);
            };
          });
        },
        closeDialog: function (payload) { parent.postMessage({ type: 'cf-close-dialog', payload: payload == null ? ' ' : payload }, '*'); },
        sendDialogMessageToParentAsync: function (message) { parent.postMessage({ type: 'cf-dialog-message-up', message: message }, '*'); return Promise.resolve(); },
        sendDialogMessageAsync: function () { return Promise.resolve(); },
        addEventListener: function (t, h) { if (t === 'dialog-message-received') msgHandlers.push(h); return function () {}; }
      }
    }
  };
})();

// Dev only: index.html?mock&failInit=N / &hangInit=N to test the automatic reload.
(function () {
  const m = /[?&]failInit=(\d+)/.exec(location.search) || [0, 0];
  const h = /[?&]hangInit=(\d+)/.exec(location.search) || [0, 0];
  if (!(+m[1] || +h[1]) || !(window.tableau && tableau.extensions)) return;
  const tries = +((/extRetry=(\d+)/.exec(location.hash) || [])[1] || 0);
  const real = tableau.extensions.initializeAsync;
  tableau.extensions.initializeAsync = function (opts) {
    if (tries < +h[1]) return new Promise(function () {});
    if (tries < +m[1]) return Promise.reject(new Error('mock: handshake rejected (failInit)'));
    return real.call(tableau.extensions, opts);
  };
})();
