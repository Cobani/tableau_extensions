'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing KPI Card Multi in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the cards and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - ?n=6     number of measures on the Measures tile (1–12)
 * - ?days=60 days of daily data
 * - Summary data is sent last-to-first, as Tableau does.
 * - "Reverse pill order" in the preview reorders the Measures tile (same data columns).
 */
(function () {
  var params = new URLSearchParams(location.search);
  var SET_KEY = 'kcmMockSettings';
  var PAYLOAD_KEY = 'kcmMockPayload';
  var isDialog = /configure\.html$/.test(location.pathname);

  var seed = 11;
  function rnd () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  var MEASURES = [
    ['SUM(Total Balance)', 3.03e9, 0.004],
    ['AVG(Avg Balance per Account)', 5484, 0.01],
    ['AVG(Avg Balance per Non-Zero Account)', 20262, 0.01],
    ['AVG(Avg Balance per Customer)', 6369, 0.01],
    ['SUM(Net Balance Change)', -1.18e7, 0.6],
    ['AVG(Total Deposit Cost)', 0.0237, 0.02],
    ['AVG(Savings Cost)', 0.0325, 0.03],
    ['SUM(Profit Accrued)', 85410, 0.2],
    ['SUM(Profit Paid)', 177400, 0.3],
    ['SUM(Total Customers)', 467789, 0.002],
    ['SUM(Total Accounts)', 551612, 0.002],
    ['SUM(New Accounts)', 1093, 0.4]
  ];

  var n = Math.max(1, Math.min(12, Number(params.get('n')) || 6));
  var days = Math.max(2, Number(params.get('days')) || 60);
  var meas = MEASURES.slice(0, n);

  function pad (x) { return (x < 10 ? '0' : '') + x; }
  var MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function buildTable () {
    var end = Date.UTC(2026, 10, 1);
    var cols = [{ fieldName: 'DAY(Snapshot Date)', fieldId: '[snap].[dy]', index: 0, dataType: 'date' }];
    meas.forEach(function (m, i) { cols.push({ fieldName: m[0], fieldId: '[m' + i + ']', index: i + 1, dataType: 'float' }); });
    var level = meas.map(function (m) { return m[1]; });
    var rows = [];
    for (var d = days - 1; d >= 0; d--) {
      var t = new Date(end - d * 864e5);
      var iso = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
      var row = [{ value: iso, nativeValue: iso, formattedValue: MONTHS[t.getUTCMonth()] + ' ' + t.getUTCDate() + ', ' + t.getUTCFullYear() }];
      meas.forEach(function (m, i) {
        level[i] = level[i] * (1 + (rnd() - 0.5) * m[2] * 0.3);
        row.push({ value: level[i], nativeValue: level[i], formattedValue: String(Math.round(level[i] * 100) / 100) });
      });
      rows.push(row);
    }
    rows.reverse(); // Tableau sends summary data last-to-first
    return { name: 'Summary', columns: cols, data: rows, totalRowCount: rows.length, isSummaryData: true };
  }

  function readSettings () { try { return JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { return {}; } }
  var pending = readSettings();
  var settingsHandlers = [];
  var dataHandlers = [];

  window.addEventListener('storage', function (e) {
    if (e.key !== SET_KEY) return;
    pending = readSettings();
    settingsHandlers.forEach(function (h) { h({}); });
  });

  var dialogDone = null;
  window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'kcm-dialog-closed' && dialogDone) { var d = dialogDone; dialogDone = null; d(); }
  });

  var worksheet = {
    name: 'KPI Row (mock)',
    getSummaryDataAsync: function () {
      return new Promise(function (r) { setTimeout(function () { r(buildTable()); }, 60); });
    },
    getVisualSpecificationAsync: function () {
      var enc = meas.map(function (m, i) { return { id: 'value', field: { id: '[m' + i + ']', name: m[0] } }; });
      if (localStorage.getItem('kcmMockReverse') === '1') enc.reverse(); // pills reordered on the tile, same columns
      enc.push({ id: 'date', field: { id: '[snap].[dy]', name: 'DAY(Snapshot Date)' } });
      return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: enc }] });
    },
    addEventListener: function (t, h) { if (t === 'summary-data-changed') dataHandlers.push(h); return function () {}; }
  };
  window.mockDataChanged = function () { dataHandlers.forEach(function (h) { h({}); }); };

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function () { return new Promise(function (r) { setTimeout(r, 30); }); },
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
          parent.postMessage({ type: 'kcm-open-dialog', url: url + '?mock' }, '*');
          return new Promise(function (r) { dialogDone = r; });
        },
        closeDialog: function () { parent.postMessage({ type: 'kcm-close-dialog' }, '*'); }
      }
    }
  };
  if (!isDialog) window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'kcm-configure') tableau.extensions._configure && tableau.extensions._configure();
  });
  // Remember the configure callback so the preview's "Format Extension" button can call it.
  var init = tableau.extensions.initializeAsync;
  tableau.extensions.initializeAsync = function (opts) { tableau.extensions._configure = opts && opts.configure; return init(opts); };
})();
