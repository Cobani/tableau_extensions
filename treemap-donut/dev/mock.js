'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the chart and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=default | flat | skewed | odd | big | renamed   (all made up)
 *     default    Department › Category › Product, about 120 leaves, Size = sales, Colour = growth (0-1 ratio)
 *     flat       one level (Region), 9 members
 *     skewed     Region › Store: one region holds 80 % of the total, the rest is many tiny stores
 *     odd        zeros, negatives, missing sizes and colours, a blank member, the same name under different parents
 *     big        1,500 leaves (more than the 1,000-row limit: row note)
 *     renamed    like default, with the first Category pill and the Size pill renamed (Marks card name differs from the data column)
 * - Rows are sent last-to-first, like Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var DS_KEY = 'tdMockData';
  var SET_KEY = 'tdMockSettings';
  var PAYLOAD_KEY = 'tdMockPayload';

  function m (name) { return { name: name, id: '[' + name + ']' }; }

  // Small deterministic random numbers, so a data set looks the same on every load.
  function rng (seed) {
    var s = seed;
    return function () { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  }

  var ADJ = ['Harbor', 'Northland', 'Maple', 'Cedar', 'Riverside', 'Lakeview', 'Hillcrest', 'Stonebridge', 'Eastfield', 'Pinegate'];
  var DEPTS = {
    Apparel: ['Tops', 'Outerwear', 'Bottoms'],
    Footwear: ['Running', 'Casual', 'Boots'],
    Home: ['Kitchen', 'Bedroom', 'Garden'],
    Outdoor: ['Camping', 'Cycling', 'Water sports']
  };
  var KINDS = ['Classic', 'Light', 'Pro', 'Trail', 'Studio', 'Weekend', 'Urban', 'Summit', 'Coast', 'Heritage'];

  /** Rows [dept, category, product, size, growth]. */
  function hierarchy (nProducts, seed, names) {
    var r = rng(seed);
    var rows = [];
    Object.keys(names).forEach(function (d, di) {
      names[d].forEach(function (c, ci) {
        for (var p = 0; p < nProducts; p++) {
          var size = Math.round((40 + Math.pow(r(), 2.2) * 900) * (1 + di * 0.25) * (1 + ci * 0.1)) * 100;
          var growth = Math.round((r() * 0.4 - 0.15) * 1000) / 1000;
          rows.push([d, c, ADJ[(p + ci + di) % ADJ.length] + ' ' + KINDS[(p * 3 + ci) % KINDS.length] + (p >= 10 ? ' ' + (Math.floor(p / 10) + 1) : ''), size, growth]);
        }
      });
    });
    return rows;
  }

  var LEVELS3 = ['Department', 'Category', 'Product'];
  var DEFAULT_ROWS = hierarchy(10, 7, DEPTS);

  var REGIONS = [['Northland', 8200], ['Harbor District', 6400], ['Lakeview', 5100], ['Riverside', 3900], ['Maple Hills', 3300],
    ['Eastfield', 2600], ['Stonebridge', 1800], ['Pinegate', 900], ['Cedar Point', 450]];

  var skewed = [];
  (function () {
    var r = rng(3);
    for (var i = 0; i < 12; i++) skewed.push(['Northland', 'Store ' + (i + 1), 60000 + Math.round(r() * 40000), Math.round((r() * 0.2 - 0.05) * 1000) / 1000]);
    for (var j = 0; j < 40; j++) skewed.push([j % 2 ? 'Harbor District' : 'Eastfield', 'Kiosk ' + (j + 1), 300 + Math.round(r() * 1200), Math.round((r() * 0.2 - 0.1) * 1000) / 1000]);
  })();

  var BIG_NAMES = {};
  ['Apparel', 'Footwear', 'Home', 'Outdoor', 'Toys'].forEach(function (d) {
    BIG_NAMES[d] = [];
    for (var i = 1; i <= 10; i++) BIG_NAMES[d].push('Range ' + i);
  });

  var ODD = [
    ['Apparel', 'Accessories', 'Harbor Scarf', 4200, 0.08], ['Apparel', 'Accessories', 'Maple Gloves', 0, 0.02],
    ['Apparel', 'Tops', 'Classic Tee', 9100, -0.04], ['Apparel', 'Tops', 'Classic Tee', 1500, 0.1],
    ['Apparel', 'Tops', 'Northland Hoodie', -800, -0.2], ['Apparel', 'Tops', 'Lakeview Polo', null, null],
    ['Home', 'Accessories', 'Cedar Candle', 3100, 0.12], ['Home', 'Accessories', 'Pinegate Vase', 2700, null],
    ['Home', 'Kitchen', 'Classic Tee', 5600, 0.01], ['Home', 'Kitchen', 'Riverside Pan', 0, 0],
    ['Footwear', 'Boots', 'Stonebridge Boot', 7400, 0.15], ['Footwear', 'Boots', null, 2300, -0.1],
    ['Toys', 'Puzzles', 'Eastfield Puzzle', -50, 0.3], ['Toys', 'Puzzles', 'Maple Blocks', 0, null]
  ];

  var DATASETS = {
    'default': { dims: LEVELS3, rows: DEFAULT_ROWS, color: 'AVG(Growth)' },
    renamed: { dims: LEVELS3, rows: DEFAULT_ROWS, color: 'AVG(Growth)', rename: true },
    flat: { dims: ['Region'], rows: REGIONS.map(function (x, i) { return [x[0], x[1] * 100, Math.round((Math.sin(i * 1.7) * 0.15) * 1000) / 1000]; }), color: 'AVG(Growth)' },
    skewed: { dims: ['Region', 'Store'], rows: skewed, color: 'AVG(Growth)' },
    odd: { dims: LEVELS3, rows: ODD, color: 'AVG(Growth)' },
    big: { dims: LEVELS3, rows: hierarchy(30, 11, BIG_NAMES), color: 'AVG(Growth)' }
  };

  var dsName = params.get('data') || localStorage.getItem(DS_KEY) || 'default';
  var DS = DATASETS[dsName] || DATASETS['default'];
  var SIZE = 'SUM(Sales)';

  // Renamed pills: name on the Marks card → column name in the data
  function renamed () { return DS.rename || /[?&]rename\b/.test(location.search); }
  function dimPill (name, i) { return renamed() && i === 0 ? name + ' (renamed)' : name; }
  function dimCol (name, i) { return renamed() && i === 0 ? 'Calculation_4410' : name; }
  function sizePill () { return renamed() ? 'Sales (renamed)' : SIZE; }
  function sizeCol () { return renamed() ? 'Calculation_5521' : SIZE; }

  function cell (v, fmt) {
    return { value: v, nativeValue: v, formattedValue: fmt != null ? fmt : (typeof v === 'number' ? v.toLocaleString('en-US') : v == null ? 'Null' : String(v)) };
  }

  function buildTable () {
    var columns = [];
    var data = [];
    var L = DS.dims.length;
    DS.dims.forEach(function (d, i) {
      var n = dimCol(d, i);
      columns.push({ fieldName: n, fieldId: '[' + n + ']', dataType: 'string', index: i });
    });
    var vn = sizeCol();
    columns.push({ fieldName: vn, fieldId: '[' + vn + ']', dataType: 'float', index: L });
    columns.push({ fieldName: DS.color, fieldId: '[' + DS.color + ']', dataType: 'float', index: L + 1 });
    // Tableau sends the rows last-to-first
    DS.rows.slice().reverse().forEach(function (r) {
      var out = [];
      for (var i = 0; i < L; i++) out.push(cell(r[i]));
      out.push(cell(r[L]));
      out.push(r[L + 1] == null ? cell(null) : cell(r[L + 1], (r[L + 1] * 100).toFixed(1) + '%'));
      data.push(out);
    });
    return { columns: columns, data: data };
  }

  function encodings () {
    var out = DS.dims.map(function (d, i) { return { id: 'category', field: m(dimPill(d, i)) }; });
    out.push({ id: 'value', field: m(sizePill()) });
    out.push({ id: 'color', field: m(DS.color) });
    return out;
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
    if (e.data && e.data.type === 'td-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'td-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
        window.__tdConfigure = configureFn;
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
          if (target) target.postMessage({ type: 'td-open-dialog', url: url }, '*');
          else window.open(url, 'td-dialog', 'width=600,height=760');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'td-close-dialog' }, '*');
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
