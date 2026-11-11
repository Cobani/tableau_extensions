/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the chart and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=default | parts | nogroup | near | sparse | big | renamed
 *     default    about 90 contracts over 4 years, 3 groups, exact dates (some overdue)
 *     parts      the same with YEAR + MONTH pills instead of an exact date
 *     nogroup    60 contracts, no Group
 *     near       24 contracts within 10 weeks (weekly buckets, some overdue)
 *     sparse     gaps, a zero, a negative amount, a row without a date, a row without a group
 *     big        2,000 contracts (row limit note)
 *     renamed    like default, with the Amount pill renamed (Marks card name differs from the data column)
 * - Rows are sent last-to-first, like Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var DS_KEY = 'mlMockData';
  var SET_KEY = 'mlMockSettings';
  var PAYLOAD_KEY = 'mlMockPayload';

  function m (name) { return { name: name, id: '[' + name + ']' }; }

  // Made-up retail contracts. Dates are relative to today so overdue / later buckets always show.
  var DAYMS = 86400000;
  var NOW = new Date();
  var TODAY = Date.UTC(NOW.getFullYear(), NOW.getMonth(), NOW.getDate());
  var seed = 7;
  function rnd () { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; }
  var PLACES = ['Harbor St', 'Northland', 'Maple Court', 'Riverside', 'Oak Plaza', 'Stonebridge', 'Eastgate', 'Linden Row', 'Fairview', 'Westfield'];
  var SUPPL = ['Greenfield Foods', 'Bright Packaging', 'Summit Logistics', 'Coastal Textiles', 'Pine Hardware', 'Lakeside Produce', 'Orchard Dairy', 'Nimbus Cleaning', 'Redwood Fixtures', 'Cedar Print'];
  var GROUPS = ['Store leases', 'Supplier contracts', 'Equipment finance'];

  /** items: [{ t (UTC ms), group, item, v }] */
  function makeItems (n, fromDay, toDay, groups, namePrefix) {
    var out = [];
    for (var i = 0; i < n; i++) {
      var g = groups ? groups[Math.floor(rnd() * groups.length)] : null;
      var nm = g === GROUPS[0] ? 'Lease ' + PLACES[i % PLACES.length] + ' ' + (i + 1)
        : g === GROUPS[1] ? 'Contract ' + SUPPL[i % SUPPL.length] + ' ' + (i + 1)
        : (namePrefix || 'Agreement') + ' ' + (i + 1);
      var base = g === GROUPS[0] ? 400000 : g === GROUPS[1] ? 120000 : 60000;
      out.push({ t: TODAY + Math.round(fromDay + rnd() * (toDay - fromDay)) * DAYMS, group: g, item: nm, v: Math.round((base * (0.3 + rnd() * 1.4)) / 100) * 100 });
    }
    return out;
  }

  var DEF = makeItems(90, -120, 4 * 365, GROUPS);
  var NEAR = makeItems(24, -20, 70, GROUPS);
  var NOG = makeItems(60, -60, 3 * 365, null);
  var SPARSE = [
    { t: TODAY - 40 * DAYMS, group: GROUPS[0], item: 'Lease Harbor St 1', v: 250000 },
    { t: TODAY + 100 * DAYMS, group: GROUPS[1], item: 'Contract Greenfield Foods 2', v: 80000 },
    { t: TODAY + 101 * DAYMS, group: GROUPS[1], item: 'Contract Bright Packaging 3', v: 0 },
    { t: TODAY + 500 * DAYMS, group: GROUPS[0], item: 'Lease Northland 4', v: -45000 },
    { t: TODAY + 900 * DAYMS, group: GROUPS[2], item: 'Agreement 5', v: 130000 },
    { t: null, group: GROUPS[2], item: 'Agreement 6', v: 70000 },
    { t: TODAY + 1300 * DAYMS, group: null, item: 'Agreement 7', v: 90000 }
  ];
  var BIG = makeItems(2000, -200, 6 * 365, GROUPS);

  var DATASETS = {
    'default': { items: DEF },
    parts: { items: DEF, parts: true },
    nogroup: { items: NOG, nogroup: true },
    near: { items: NEAR },
    sparse: { items: SPARSE },
    big: { items: BIG },
    renamed: { items: DEF, rename: true }
  };

  var dsName = params.get('data') || localStorage.getItem(DS_KEY) || 'default';
  var DS = DATASETS[dsName] || DATASETS['default'];
  var REN = !!DS.rename || /[?&]rename\b/.test(location.search);

  // Renamed pills: name on the Marks card -> column name in the data
  var N_DATE = 'Maturity date';
  var N_GROUP = 'Contract type';
  var N_ITEM = 'Contract';
  var N_AMT = 'SUM(Amount)';
  function pillAmt () { return REN ? 'Amount due (renamed)' : N_AMT; }
  function colAmt () { return REN ? 'Calculation_4410' : N_AMT; }

  var MONTHN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function cell (v, fmt) {
    return { value: v, nativeValue: v, formattedValue: fmt != null ? fmt : (typeof v === 'number' ? v.toLocaleString('en-US') : v == null ? 'Null' : String(v)) };
  }
  function iso (t) { return new Date(t).toISOString().slice(0, 10); }

  function buildTable () {
    var columns = [];
    var idx = 0;
    function col (name, type) { columns.push({ fieldName: name, fieldId: '[' + name + ']', dataType: type, index: idx++ }); }
    if (DS.parts) { col('YEAR(' + N_DATE + ')', 'int'); col('MONTH(' + N_DATE + ')', 'int'); } else col(N_DATE, 'date');
    if (!DS.nogroup) col(N_GROUP, 'string');
    col(N_ITEM, 'string');
    col(colAmt(), 'float');
    var data = [];
    // Tableau sends the rows last-to-first
    DS.items.slice().reverse().forEach(function (it) {
      var row = [];
      if (DS.parts) {
        if (it.t == null) { row.push(cell(null), cell(null)); } else {
          var d = new Date(it.t);
          row.push(cell(d.getUTCFullYear(), String(d.getUTCFullYear())), cell(d.getUTCMonth() + 1, MONTHN[d.getUTCMonth()]));
        }
      } else row.push(it.t == null ? cell(null) : cell(iso(it.t) + ' 00:00:00', iso(it.t)));
      if (!DS.nogroup) row.push(cell(it.group));
      row.push(cell(it.item), cell(it.v));
      data.push(row);
    });
    return { columns: columns, data: data };
  }

  function encodings () {
    var e = [];
    if (DS.parts) { e.push({ id: 'date', field: m('YEAR(' + N_DATE + ')') }, { id: 'date', field: m('MONTH(' + N_DATE + ')') }); } else e.push({ id: 'date', field: m(N_DATE) });
    e.push({ id: 'amount', field: m(pillAmt()) });
    if (!DS.nogroup) e.push({ id: 'color', field: m(N_GROUP) });
    e.push({ id: 'detail', field: m(N_ITEM) });
    return e;
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
    if (e.data && e.data.type === 'ml-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'ml-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed' },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    ErrorCodes: { DialogClosedByUser: 'dialog-closed-by-user' },
    extensions: {
      initializeAsync: function (opts) {
        configureFn = opts && opts.configure;
        window.__mlConfigure = configureFn;
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
          if (target) target.postMessage({ type: 'ml-open-dialog', url: url }, '*');
          else window.open(url, 'ml-dialog', 'width=600,height=760');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'ml-close-dialog' }, '*');
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
