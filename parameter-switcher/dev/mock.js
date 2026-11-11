'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing Parameter Switcher in a normal
 * browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage (one set per data set), so the control and the Format dialog
 *   (two frames) see each other's changes, like they do inside Tableau.
 * - ?data=NAME  data set (see DATASETS below; default "default"). Each one starts with its own
 *   parameter and style already chosen, until you save something in the Format dialog.
 * - ?rejectChange  parameter.changeValueAsync rejects, to see the control revert with a message.
 * - changeValueAsync updates the parameter's current value and fires ParameterChanged;
 *   mockSetParameter(name, value) does the same from "elsewhere" (a button in the preview).
 * - Summary data is sent last-to-first, as Tableau does. Only the "options" and "many" sets have a
 *   field on the Options tile; the others have no fields at all (empty summary data).
 * - ?failInit=N / ?hangInit=N: first N start-up handshakes fail / never answer.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const isDialog = /configure\.html$/.test(location.pathname);

  const DATASETS = {
    default: 'Metric (list of 4, tabs)',
    period: 'Period (list of 5, pills)',
    toggle: 'Show targets (2 values, toggle)',
    range: 'Top N (range 5-50 step 5, stepper)',
    options: 'Region (all values, 14 on the Options tile)',
    many: 'Region (40 on the Options tile)',
    none: 'No parameter chosen'
  };
  const dataName = DATASETS[params.get('data')] ? params.get('data') : 'default';
  const SET_KEY = 'psMockSettings:' + dataName;
  const PAYLOAD_KEY = 'psMockPayload';
  const REJECT = params.has('rejectChange');

  // ---- Parameters ----------------------------------------------------------
  function dv (value) { return { value: value, formattedValue: String(value) }; }
  function listDef (name, values, current, dataType) {
    return { name: name, dataType: dataType || 'string', current: current, type: 'list', values: values };
  }
  const NAMES14 = ['Northland', 'Harbor Bay', 'Eastfield', 'Westmoor', 'Southgate', 'Riverside', 'Lakeshore', 'Highland',
    'Valleyview', 'Stonebridge', 'Pinecrest', 'Maple Ridge', 'Cedar Point', 'Sunnydale'];
  const PRE = ['North', 'East', 'West', 'South', 'River', 'Lake', 'Hill', 'Oak', 'Pine', 'Stone'];
  const SUF = ['field', 'port', 'dale', 'brook'];
  const NAMES40 = [];
  PRE.forEach(function (a) { SUF.forEach(function (b) { NAMES40.push(a + b); }); });
  const REGIONS = dataName === 'many' ? NAMES40 : NAMES14;

  const DEFS = [
    listDef('Metric', ['Revenue', 'Orders', 'Units', 'Margin'], 'Revenue'),
    listDef('Period', ['Day', 'Week', 'Month', 'Quarter', 'Year'], 'Month'),
    listDef('Show targets', ['Yes', 'No'], 'Yes'),
    { name: 'Top N', dataType: 'int', current: 10, type: 'range', min: 5, max: 50, step: 5 },
    { name: 'Region', dataType: 'string', current: REGIONS[0], type: 'all' }
  ];

  function makeParameter (d) {
    const handlers = [];
    const p = {
      name: d.name,
      id: '[Parameters].[' + d.name + ']',
      dataType: d.dataType,
      currentValue: dv(d.current),
      allowableValues: d.type === 'list'
        ? { type: 'list', allowableValues: d.values.map(dv) }
        : d.type === 'range'
          ? { type: 'range', minValue: dv(d.min), maxValue: dv(d.max), stepSize: d.step }
          : { type: 'all' },
      addEventListener: function (t, h) { if (t === 'parameter-changed') handlers.push(h); return function () {}; },
      _set: function (v) {
        p.currentValue = dv(v);
        handlers.slice().forEach(function (h) { h({ getParameterAsync: function () { return Promise.resolve(p); } }); });
      },
      changeValueAsync: function (v) {
        console.log('mock changeValueAsync', d.name, JSON.stringify(v));
        return new Promise(function (resolve, reject) {
          setTimeout(function () {
            if (REJECT) { reject(new Error('mock: Tableau rejected the value (?rejectChange)')); return; }
            p._set(v);
            resolve(p.currentValue);
          }, 40);
        });
      }
    };
    return p;
  }
  const PARAMETERS = DEFS.map(makeParameter);
  window.mockParameters = PARAMETERS; // for tests and the preview
  window.mockSetParameter = function (name, value) {
    const p = PARAMETERS.find(function (x) { return x.name === name; });
    if (p) p._set(value);
  };

  /** What each data set starts with: the parameter and the style (until the Format dialog saves something). */
  const SEEDS = {
    default: { parameter: { name: 'Metric' }, control: { style: 'tabs' } },
    period: { parameter: { name: 'Period' }, control: { style: 'pills' } },
    toggle: { parameter: { name: 'Show targets' }, control: { style: 'toggle' } },
    range: { parameter: { name: 'Top N' }, control: { style: 'stepper' } },
    options: { parameter: { name: 'Region' }, control: { style: 'tabs' } },
    many: { parameter: { name: 'Region' }, control: { style: 'tabs' } },
    none: {}
  };

  // ---- Summary data: empty, or one Region dimension -----------------------------
  const hasOptions = dataName === 'options' || dataName === 'many';

  function buildTable () {
    if (!hasOptions) return { name: 'Summary', columns: [], data: [], totalRowCount: 0, isSummaryData: true };
    const rows = REGIONS.map(function (r) { return [{ value: r, nativeValue: r, formattedValue: r }]; });
    rows.reverse(); // Tableau sends summary data last-to-first
    return {
      name: 'Summary',
      columns: [{ fieldName: 'Region', fieldId: '[snap].[none:Region:nk]', index: 0, dataType: 'string' }],
      data: rows, totalRowCount: rows.length, isSummaryData: true
    };
  }

  function readSettings () {
    try {
      const s = localStorage.getItem(SET_KEY);
      if (s) return JSON.parse(s);
    } catch (e) { /* ignore */ }
    // Nothing saved yet: this data set's starting point, stored as the workbook would.
    return { parameterSwitcher1: JSON.stringify(SEEDS[dataName] || {}) };
  }
  let pending = readSettings();
  const settingsHandlers = [];
  const dataHandlers = [];

  window.addEventListener('storage', function (e) {
    if (e.key !== SET_KEY) return;
    pending = readSettings();
    settingsHandlers.forEach(function (h) { h({}); });
  });

  let dialogDone = null;
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ps-dialog-closed' && dialogDone) { const d = dialogDone; dialogDone = null; d(); }
  });

  const worksheet = {
    name: 'Switcher (mock)',
    selectMarksByValueAsync: function (sel) { console.log('mock selectMarksByValueAsync', JSON.stringify(sel)); return Promise.resolve(); },
    clearSelectedMarksAsync: function () { console.log('mock clearSelectedMarksAsync'); return Promise.resolve(); },
    hoverTupleAsync: function (id, ctx) { console.log('mock hoverTupleAsync', id, JSON.stringify(ctx || null)); return Promise.resolve(); },
    getParametersAsync: function () { return Promise.resolve(PARAMETERS.slice()); },
    // One call; honours maxRows like Tableau.
    getSummaryDataAsync: function (opts) {
      return new Promise(function (r) {
        setTimeout(function () {
          const t = buildTable();
          const max = opts && opts.maxRows > 0 ? opts.maxRows : 0;
          if (max && t.data.length > max) t.data = t.data.slice(0, max);
          r(t);
        }, 40);
      });
    },
    // Paged reader (used when the row limit is 0 or 10,000 and over).
    getSummaryDataReaderAsync: function (pageRowCount) {
      const t = buildTable();
      const size = pageRowCount > 0 ? pageRowCount : 1000;
      const pages = Math.max(1, Math.ceil(t.data.length / size));
      let released = false;
      const page = function (p) {
        if (released) return Promise.reject(new Error('mock: reader already released'));
        return Promise.resolve({ columns: t.columns, data: t.data.slice(p * size, (p + 1) * size), totalRowCount: t.data.length, isSummaryData: true });
      };
      return Promise.resolve({
        pageCount: pages,
        totalRowCount: t.data.length,
        getPageAsync: page,
        getAllPagesAsync: function () {
          return Promise.resolve({ columns: t.columns, data: t.data, totalRowCount: t.data.length, isSummaryData: true });
        },
        releaseAsync: function () { released = true; return Promise.resolve(); }
      });
    },
    getVisualSpecificationAsync: function () {
      const enc = hasOptions ? [{ id: 'options', field: { id: '[snap].[none:Region:nk]', name: 'Region' } }] : [];
      return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: enc }] });
    },
    addEventListener: function (t, h) { if (t === 'summary-data-changed') dataHandlers.push(h); return function () {}; }
  };
  window.mockDataChanged = function () { dataHandlers.forEach(function (h) { h({}); }); };

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed', ParameterChanged: 'parameter-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function (opts) {
        window.tableau.extensions._configure = opts && opts.configure;
        return new Promise(function (r) { setTimeout(r, 30); });
      },
      initializeDialogAsync: function () { return Promise.resolve(localStorage.getItem(PAYLOAD_KEY) || ''); },
      worksheetContent: { worksheet: worksheet },
      settings: {
        get: function (k) { return pending[k]; },
        set: function (k, v) { pending[k] = v; },
        getAll: function () { return pending; },
        saveAsync: function () {
          localStorage.setItem(SET_KEY, JSON.stringify(pending));
          return Promise.resolve(pending);
        },
        addEventListener: function (t, h) { if (t === 'settings-changed') settingsHandlers.push(h); return function () {}; }
      },
      ui: {
        displayDialogAsync: function (url, payload) {
          localStorage.setItem(PAYLOAD_KEY, payload || '');
          parent.postMessage({ type: 'ps-open-dialog', url: url + '?mock&data=' + dataName }, '*');
          return new Promise(function (r) { dialogDone = r; });
        },
        closeDialog: function () { parent.postMessage({ type: 'ps-close-dialog' }, '*'); }
      }
    }
  };
  if (!isDialog) window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'ps-configure') { const c = tableau.extensions._configure; if (c) c(); }
  });
})();

// Dev only: index.html?mock&failInit=N makes the first N handshakes fail, and &hangInit=N makes the
// first N never answer (timeout), to test the automatic reload.
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
