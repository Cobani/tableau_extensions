'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the chart and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=default | dimension | odd | two | big | renamed
 *     default    one measure per stage (Visits → Product views → Add to basket → Checkout → Orders)
 *     dimension  Stage dimension (6 members) + Value measure
 *     odd        a stage bigger than the one before, a zero and a missing value
 *     two        two stages
 *     big        Stage dimension with 1,200 members (row limit note, 12 stages drawn)
 *     renamed    like default, with the first and second pill renamed (Marks card name differs from the data column)
 * - Rows are sent last-to-first, like Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var DS_KEY = 'fnMockData';
  var SET_KEY = 'fnMockSettings';
  var PAYLOAD_KEY = 'fnMockPayload';

  function m (name) { return { name: name, id: '[' + name + ']' }; }

  // Made-up web shop funnel
  var STAGES = [
    ['SUM(Visits)', 48200], ['SUM(Product views)', 31400], ['SUM(Add to basket)', 9650], ['SUM(Checkout)', 4120], ['SUM(Orders)', 2380]
  ];

  var BIG = [];
  for (var i = 0; i < 1200; i++) BIG.push(['Step ' + (i + 1), Math.round(90000 / (1 + i * 0.35))]);

  var DATASETS = {
    'default': { measures: STAGES },
    renamed: { measures: STAGES, rename: true },
    two: { measures: STAGES.slice(0, 2) },
    odd: { measures: [['SUM(Visits)', 20000], ['SUM(Sign-ups)', 3200], ['SUM(Trial starts)', 4100], ['SUM(Paid plans)', 0], ['SUM(Renewals)', null]] },
    dimension: { dim: 'Funnel step', value: 'SUM(Customers)', members: [['Visited site', 48200], ['Viewed a product', 31400], ['Added to basket', 9650], ['Started checkout', 4120], ['Paid', 2380], ['Reordered', 610]] },
    big: { dim: 'Funnel step', value: 'SUM(Customers)', members: BIG }
  };

  var dsName = params.get('data') || localStorage.getItem(DS_KEY) || 'default';
  var DS = DATASETS[dsName] || DATASETS['default'];

  // Renamed pills: name on the Marks card → column name in the data
  function pillName (name, i) { return (DS.rename || /[?&]rename\b/.test(location.search)) && i === 0 ? 'Visits (renamed)' : name; }
  function colName (name, i) { return (DS.rename || /[?&]rename\b/.test(location.search)) && i === 0 ? 'Calculation_4410' : name; }

  function cell (v, fmt) {
    return { value: v, nativeValue: v, formattedValue: fmt != null ? fmt : (typeof v === 'number' ? v.toLocaleString('en-US') : v == null ? 'Null' : String(v)) };
  }

  function buildTable () {
    var columns = [];
    var data = [];
    if (DS.dim) {
      columns.push({ fieldName: DS.dim, fieldId: '[' + DS.dim + ']', dataType: 'string', index: 0 });
      columns.push({ fieldName: DS.value, fieldId: '[' + DS.value + ']', dataType: 'float', index: 1 });
      // Tableau sends the rows last-to-first
      DS.members.slice().reverse().forEach(function (mm) { data.push([cell(mm[0]), cell(mm[1])]); });
    } else {
      DS.measures.forEach(function (ms, j) {
        var n = colName(ms[0], j);
        columns.push({ fieldName: n, fieldId: '[' + n + ']', dataType: 'float', index: j });
      });
      data.push(DS.measures.map(function (ms) { return cell(ms[1]); }));
    }
    return { columns: columns, data: data };
  }

  function encodings () {
    if (DS.dim) return [{ id: 'stage', field: m(DS.dim) }, { id: 'value', field: m(DS.value) }];
    return DS.measures.map(function (ms, j) { return { id: 'steps', field: m(pillName(ms[0], j)) }; });
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
    if (e.data && e.data.type === 'fn-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'fn-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
        window.__fnConfigure = configureFn;
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
          getSummaryDataReaderAsync: function (n, opts) {
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
          if (target) target.postMessage({ type: 'fn-open-dialog', url: url }, '*');
          else window.open(url, 'fn-dialog', 'width=600,height=760');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'fn-close-dialog' }, '*');
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
