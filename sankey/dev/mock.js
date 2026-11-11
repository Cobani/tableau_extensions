'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the chart and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=default | two | deep | big | nulls | renamed
 * - ?rename: the first Levels pill is "renamed", so the Marks card reports a
 *   different name than the data column, as Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var SET_KEY = 'skMockSettings';
  var PAYLOAD_KEY = 'skMockPayload';
  var RENAME = params.has('rename');

  // deterministic pseudo-random numbers
  var seed = 11;
  function rnd () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function pick (a) { return a[Math.floor(rnd() * a.length)]; }

  var MOCK_PARAMS = [['Year', '2026']].map(function (p) {
    var o = { name: p[0], id: p[0], currentValue: { value: p[1], formattedValue: p[1] }, _h: [] };
    o.addEventListener = function (t, h) { o._h.push(h); };
    return o;
  });

  // ---- made-up retail data sets ------------------------------------------------
  var CH = ['Online', 'Store', 'Marketplace', 'Wholesale'];
  var CAT = ['Electronics', 'Grocery', 'Apparel', 'Home', 'Beauty', 'Toys'];
  var REG = ['North', 'South', 'East', 'West', 'Central'];

  function rowsOf (names, lists, keep, fn) {
    var out = [];
    (function rec (i, acc) {
      if (i === lists.length) { if (keep() ) out.push(fn(acc)); return; }
      lists[i].forEach(function (v) { rec(i + 1, acc.concat([v])); });
    })(0, []);
    return out;
  }
  function make (names, lists, keep, valueFn) {
    return rowsOf(names, lists, keep, function (acc) {
      var o = {};
      names.forEach(function (n, i) { o[n] = acc[i]; });
      var v = valueFn(acc);
      o['SUM(Sales)'] = v;
      o['SUM(Profit)'] = v == null ? null : Math.round(v * (0.08 + rnd() * 0.2));
      return o;
    });
  }
  function amount () { return Math.round(800 + rnd() * rnd() * 90000); }

  var DATASETS = {
    default: function () {
      return { tiles: { levels: ['Channel', 'Category', 'Region'], value: 'SUM(Sales)', tooltip: ['SUM(Profit)'] },
        rows: make(['Channel', 'Category', 'Region'], [CH, CAT, REG], function () { return rnd() < 0.5; }, amount) };
    },
    two: function () {
      var pairs = [['Online', 'Electronics', 52000], ['Online', 'Apparel', 31000], ['Online', 'Home', 12500], ['Store', 'Grocery', 64000],
        ['Store', 'Apparel', 27000], ['Store', 'Home', 18000], ['Wholesale', 'Grocery', 23000], ['Wholesale', 'Toys', 9000]];
      return { tiles: { levels: ['Source', 'Target'], value: 'SUM(Sales)', tooltip: [] },
        rows: pairs.map(function (p) { return { Source: p[0], Target: p[1], 'SUM(Sales)': p[2] }; }) };
    },
    deep: function () {
      var seg = ['Consumer', 'Corporate', 'Small business'];
      var br = ['Aster', 'Brio', 'Cora', 'Dune'];
      var names = ['Segment', 'Channel', 'Category', 'Brand', 'Region'];
      return { tiles: { levels: names, value: 'SUM(Sales)', tooltip: ['SUM(Profit)'] },
        rows: make(names, [seg, CH, CAT.slice(0, 4), br, REG.slice(0, 3)], function () { return rnd() < 0.18; }, amount) };
    },
    big: function () {
      var names = ['Country', 'City', 'Category', 'Product'];
      var seen = {}; var rows = [];
      var countries = ['Northland', 'Southland', 'Eastland', 'Westland', 'Midland', 'Highland', 'Lakeland', 'Coastland'];
      var guard = 0;
      while (rows.length < 1500 && guard++ < 50000) {
        var c = countries[Math.floor(rnd() * rnd() * countries.length)];
        var city = c + ' city ' + (1 + Math.floor(rnd() * 6));
        var cat = 'Category ' + (1 + Math.floor(rnd() * 12));
        var p = 'Product ' + (1 + Math.floor(rnd() * 120));
        var k = [c, city, cat, p].join('|');
        if (seen[k]) continue;
        seen[k] = 1;
        var v = amount();
        rows.push({ Country: c, City: city, Category: cat, Product: p, 'SUM(Sales)': v, 'SUM(Profit)': Math.round(v * 0.15) });
      }
      return { tiles: { levels: names, value: 'SUM(Sales)', tooltip: ['SUM(Profit)'] }, rows: rows };
    },
    nulls: function () {
      var d = DATASETS.default();
      d.rows = d.rows.slice(0, 24);
      d.rows[1].Category = null;
      d.rows[2].Category = null;
      d.rows[3].Region = null;
      d.rows[5].Channel = null;
      d.rows[6]['SUM(Sales)'] = 0;
      d.rows[7]['SUM(Sales)'] = -4200;
      d.rows[8]['SUM(Sales)'] = null;
      return d;
    }
  };
  DATASETS.renamed = DATASETS.default;

  var DNAME = params.get('data') || 'default';
  if (DNAME === 'renamed') RENAME = true;
  var DSET = (DATASETS[DNAME] || DATASETS.default)();

  function cell (v, measure) {
    if (v == null) return { value: null, nativeValue: null, formattedValue: '%null%' };
    return { value: v, nativeValue: v, formattedValue: measure ? v.toLocaleString('en-US') : String(v) };
  }

  function allFields () {
    var out = [];
    DSET.tiles.levels.forEach(function (n) { out.push({ tile: 'levels', name: n, measure: false }); });
    out.push({ tile: 'value', name: DSET.tiles.value, measure: true });
    (DSET.tiles.tooltip || []).forEach(function (n) { out.push({ tile: 'tooltip', name: n, measure: true }); });
    return out;
  }

  function buildTable () {
    var cols = allFields().map(function (f, i) {
      var name = RENAME && i === 0 ? 'Calculation_8812' : f.name;
      return { fieldName: name, fieldId: '[' + name + ']', dataType: f.measure ? 'float' : 'string', index: i, src: f.name, measure: f.measure };
    });
    // like Tableau: one row per distinct combination, last row first
    var data = DSET.rows.map(function (r) { return cols.map(function (c) { return cell(r[c.src], c.measure); }); }).reverse();
    return { columns: cols.map(function (c) { return { fieldName: c.fieldName, fieldId: c.fieldId, dataType: c.dataType, index: c.index }; }), data: data };
  }

  function encodings () {
    return allFields().map(function (f, i) {
      var name = RENAME && i === 0 ? 'Source table (renamed)' : f.name;
      var builtIn = f.tile === 'tooltip' ? 'tooltip' : null;
      return { id: builtIn || f.tile, type: builtIn || 'custom', field: { name: name, id: '[' + name + ']', role: f.measure ? 'measure' : 'dimension' } };
    });
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
    if (e.data && e.data.type === 'sk-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'sk-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed', ParameterChanged: 'parameter-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    SelectionUpdateType: { Replace: 'select-replace' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
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
          var snap = JSON.stringify(pending);
          return new Promise(function (resolve) {
            setTimeout(function () {
              localStorage.setItem(SET_KEY, snap);
              settingsHandlers.forEach(function (h) { h({}); });
              resolve();
            }, 0);
          });
        },
        addEventListener: function (type, h) { settingsHandlers.push(h); }
      },
      worksheetContent: {
        worksheet: {
          name: 'Mock sheet',
          hoverTupleAsync: function (id, ctx) { console.log('mock hoverTupleAsync', id, JSON.stringify(ctx || null)); return Promise.resolve(); },
          addEventListener: function () {},
          getVisualSpecificationAsync: function () {
            return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: encodings() }] });
          },
          getSummaryDataReaderAsync: function () {
            var t = buildTable();
            return Promise.resolve({
              getAllPagesAsync: function () { return Promise.resolve(t); },
              releaseAsync: function () { return Promise.resolve(); }
            });
          },
          selectMarksByValueAsync: function (sel) { console.log('mock selectMarksByValueAsync', JSON.stringify(sel)); return Promise.resolve(); },
          clearSelectedMarksAsync: function () { console.log('mock clearSelectedMarksAsync'); return Promise.resolve(); },
          getParametersAsync: function () { return Promise.resolve(MOCK_PARAMS); }
        }
      },
      ui: {
        displayDialogAsync: function (url, payload) {
          localStorage.setItem(PAYLOAD_KEY, payload || '');
          var target = window.parent !== window ? window.parent : null;
          if (target) target.postMessage({ type: 'sk-open-dialog', url: url }, '*');
          else window.open(url, 'sk-dialog', 'width=620,height=780');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'sk-close-dialog' }, '*');
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
