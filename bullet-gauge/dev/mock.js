'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the chart and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=default | single | norange | negative | big | renamed
 *     default   8 stores: Actual, Target, 3 Ranges, Comparison
 *     single    no Category: one mark for the whole worksheet
 *     norange   Actual + Target only (bands are % of target)
 *     negative  negative actuals, zero targets, empty (null) values
 *     big       1,200 stores (more than the 1,000-row limit: row note, Top N)
 *     renamed   pills renamed in Tableau ("//New name"): field and column names differ
 * - Rows are sent last-to-first, like Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var DS_KEY = 'bgMockData';
  var SET_KEY = 'bgMockSettings';
  var PAYLOAD_KEY = 'bgMockPayload';

  function m (name) { return { name: name, id: '[' + name + ']' }; }

  var STORES = ['Harbor St', 'Maple Ave', 'Old Town', 'Riverside', 'Hilltop', 'Station Sq', 'Lakeview', 'Market Hall'];
  // actual, target, poor limit, ok limit, good limit, last year
  var STORE_ROWS = [
    [1240, 1200, 600, 1000, 1500, 1105],
    [980, 1150, 575, 960, 1440, 1010],
    [1410, 1300, 650, 1080, 1620, 1250],
    [610, 900, 450, 750, 1125, 700],
    [875, 850, 425, 710, 1060, 790],
    [1530, 1400, 700, 1170, 1750, 1380],
    [330, 600, 300, 500, 750, 395],
    [720, 800, 400, 670, 1000, 690]
  ];

  function big () {
    var rows = [];
    var seed = 7;
    function rnd () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
    for (var i = 1; i <= 1200; i++) {
      var t = Math.round(500 + rnd() * 1500);
      rows.push(['Store ' + (i < 10 ? '000' : i < 100 ? '00' : i < 1000 ? '0' : '') + i, Math.round(t * (0.4 + rnd() * 0.9)), t, Math.round(t * 0.5), Math.round(t * 0.85), Math.round(t * 1.2), Math.round(t * (0.5 + rnd() * 0.8))]);
    }
    return rows;
  }

  var FIELDS = { actual: 'SUM(Sales)', target: 'SUM(Sales Target)', ranges: ['SUM(Poor Limit)', 'SUM(OK Limit)', 'SUM(Good Limit)'], compare: 'SUM(Last Year Sales)', category: ['Store'] };
  function withStores (idx) {
    return STORES.map(function (s, i) { return [s].concat(idx.map(function (k) { return STORE_ROWS[i][k]; })); });
  }

  var DATASETS = {
    default: { cols: ['Store', 'a', 't', 'r1', 'r2', 'r3', 'c'], rows: withStores([0, 1, 2, 3, 4, 5]), fields: FIELDS },
    single: { cols: ['a', 't', 'r1', 'r2', 'r3', 'c'], rows: [[8695, 8900, 4450, 7400, 11100, 8120]], fields: Object.assign({}, FIELDS, { category: [] }) },
    norange: { cols: ['Store', 'a', 't'], rows: withStores([0, 1]), fields: Object.assign({}, FIELDS, { ranges: [], compare: null }) },
    negative: {
      cols: ['Store', 'a', 't', 'c'],
      rows: [['Harbor St', 420, 500, 380], ['Maple Ave', -150, 200, 60], ['Old Town', 310, 0, null], ['Riverside', -60, -100, -140],
        ['Hilltop', null, 400, 300], ['Station Sq', 0, 250, 90], ['Lakeview', 95, null, 80], ['Market Hall', -230, 150, -10]],
      fields: Object.assign({}, FIELDS, { ranges: [] })
    },
    big: { cols: ['Store', 'a', 't', 'r1', 'r2', 'r3', 'c'], rows: big(), fields: FIELDS },
    renamed: { cols: ['Store', 'a', 't', 'r1', 'r2', 'r3', 'c'], rows: withStores([0, 1, 2, 3, 4, 5]), fields: FIELDS, rename: true }
  };

  var dsName = params.get('data') || localStorage.getItem(DS_KEY) || 'default';
  var DS = DATASETS[dsName] || DATASETS.default;
  var RENAME = DS.rename || /[?&]rename\b/.test(location.search);

  function fieldNames () {
    var f = DS.fields;
    var names = {};
    names.Store = f.category[0];
    names.a = f.actual;
    names.t = f.target;
    names.c = f.compare;
    names.r1 = f.ranges[0]; names.r2 = f.ranges[1]; names.r3 = f.ranges[2];
    return names;
  }

  // Renamed pills: the Marks card says "Revenue (renamed)", the data column "Calculation_1".
  function pillName (key, name) { return RENAME && (key === 'a' || key === 'Store') ? (key === 'a' ? 'Revenue (renamed)' : 'Shop') : name; }
  function columnName (key, name, i) { return RENAME && (key === 'a' || key === 'Store') ? 'Calculation_' + (4410 + i) : name; }

  function cell (v) {
    if (v == null) return { value: '%null%', nativeValue: null, formattedValue: 'Null' };
    return { value: v, nativeValue: v, formattedValue: typeof v === 'number' ? v.toLocaleString('en-US') : String(v) };
  }

  function buildTable () {
    var names = fieldNames();
    var columns = DS.cols.map(function (k, i) {
      var n = columnName(k, names[k], i);
      return { fieldName: n, fieldId: '[' + n + ']', dataType: k === 'Store' ? 'string' : 'float', index: i };
    });
    // last-to-first, like Tableau
    var data = DS.rows.slice().reverse().map(function (r) { return r.map(cell); });
    return { columns: columns, data: data };
  }

  function encodings () {
    var names = fieldNames();
    var enc = [];
    var f = DS.fields;
    f.category.forEach(function () { enc.push({ id: 'category', field: m(pillName('Store', names.Store)) }); });
    enc.push({ id: 'actual', field: m(pillName('a', names.a)) });
    if (f.target && DS.cols.indexOf('t') >= 0) enc.push({ id: 'target', field: m(names.t) });
    ['r1', 'r2', 'r3'].forEach(function (k) { if (DS.cols.indexOf(k) >= 0) enc.push({ id: 'ranges', field: m(names[k]) }); });
    if (f.compare && DS.cols.indexOf('c') >= 0) enc.push({ id: 'compare', field: m(names.c) });
    return enc;
  }

  // ---- settings ----------------------------------------------------------
  function loadSettings () {
    try { return JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { return {}; }
  }
  var pending = loadSettings();
  var settingsHandlers = [];
  window.addEventListener('storage', function (e) {
    if (e.key === SET_KEY) {
      pending = loadSettings();
      settingsHandlers.forEach(function (h) { h({}); });
    }
  });

  var configureFn = null;
  var dialogResolve = null;
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'bg-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'bg-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
        window.__bgConfigure = configureFn;
        return Promise.resolve();
      },
      initializeDialogAsync: function () {
        return Promise.resolve(localStorage.getItem(PAYLOAD_KEY) || '');
      },
      settings: {
        get: function (k) { return pending[k]; },
        set: function (k, v) { pending[k] = v; },
        getAll: function () { return pending; },
        saveAsync: function () {
          localStorage.setItem(SET_KEY, JSON.stringify(pending));
          // storage events don't fire in the frame that wrote, so notify it too
          settingsHandlers.forEach(function (h) { h({}); });
          return Promise.resolve();
        },
        addEventListener: function (type, h) { settingsHandlers.push(h); }
      },
      worksheetContent: {
        worksheet: {
          name: 'Mock sheet',
          addEventListener: function () {},
          hoverTupleAsync: function (id, ctx) { console.log('mock hoverTupleAsync', id, JSON.stringify(ctx || null)); return Promise.resolve(); },
          selectMarksByValueAsync: function (sel) { console.log('mock selectMarksByValueAsync', JSON.stringify(sel)); return Promise.resolve(); },
          clearSelectedMarksAsync: function () { console.log('mock clearSelectedMarksAsync'); return Promise.resolve(); },
          getVisualSpecificationAsync: function () {
            return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: encodings() }] });
          },
          getSummaryDataReaderAsync: function () {
            var t = buildTable();
            return Promise.resolve({
              getAllPagesAsync: function () { return Promise.resolve(t); },
              releaseAsync: function () { return Promise.resolve(); }
            });
          }
        }
      },
      ui: {
        displayDialogAsync: function (url, payload) {
          localStorage.setItem(PAYLOAD_KEY, payload || '');
          var target = window.parent !== window ? window.parent : null;
          if (target) target.postMessage({ type: 'bg-open-dialog', url: url }, '*');
          else window.open(url, 'bg-dialog', 'width=600,height=760');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'bg-close-dialog' }, '*');
          else window.close();
        }
      }
    }
  };
})();

// Dev only: index.html?mock&failInit=N makes the first N handshakes fail, and &hangInit=N makes the
// first N never answer (timeout), to test the automatic reload.
(function () {
  var m = /[?&]failInit=(\d+)/.exec(location.search) || [0, 0];
  var h = /[?&]hangInit=(\d+)/.exec(location.search) || [0, 0];
  if (!(+m[1] || +h[1]) || !(window.tableau && tableau.extensions)) return;
  var tries = +((/(?:ext|kpi)Retry=(\d+)/.exec(location.hash) || [])[1] || 0);
  var real = tableau.extensions.initializeAsync;
  tableau.extensions.initializeAsync = function (opts) {
    if (tries < +h[1]) return new Promise(function () {});
    if (tries < +m[1]) return Promise.reject(new Error('mock: handshake rejected (failInit)'));
    return real.call(tableau.extensions, opts);
  };
})();

// getSummaryDataAsync (the extensions use it below 10,000 rows) on top of the mock's reader, honouring maxRows.
(function () {
  var ws = window.tableau && window.tableau.extensions && window.tableau.extensions.worksheetContent && window.tableau.extensions.worksheetContent.worksheet;
  if (!ws || ws.getSummaryDataAsync) return;
  ws.getSummaryDataAsync = function (opts) {
    return ws.getSummaryDataReaderAsync(undefined, opts).then(function (r) { return r.getAllPagesAsync(); }).then(function (t) {
      var n = opts && opts.maxRows;
      return n ? { columns: t.columns, data: t.data.slice(0, n) } : t;
    });
  };
})();
