'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing the extension in a
 * normal browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the grid and the Format dialog (two
 *   frames) see each other's changes, like they do inside Tableau.
 * - Sample data: ?data=default | dates | weekly | small | gaps | big | renamed
 *     default  12 monthly cohorts x up to 12 periods (numeric period), decaying retention, Cohort size measure
 *     dates    like default, but Period is a month date (counted from the cohort's month)
 *     weekly   20 weekly cohorts x 20 periods, no Cohort size (period 0 is the size)
 *     small    4 x 4
 *     gaps     missing cells, zeros, a cohort with size 0
 *     big      50 x 50 triangle (1,275 rows: row limit note)
 *     renamed  like default, with the Cohort pill renamed (Marks card name differs from the data column)
 * - ?rename: the first Rows pill is "renamed" (//New name), so the Marks card
 *   reports a different name than the data column, as Tableau does.
 */
(function () {
  var params = new URLSearchParams(location.search);
  var DS_KEY = 'cgMockData';
  var SET_KEY = 'cgMockSettings';
  var PAYLOAD_KEY = 'cgMockPayload';

  // deterministic pseudo-random numbers
  var seed = 11;
  function rnd () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function p2 (n) { return n < 10 ? '0' + n : String(n); }
  function monthDate (i) { return new Date(2025, i, 1); }
  function iso (d) { return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function monthText (d) { return MON[d.getMonth()] + ' ' + d.getFullYear(); }

  /** Retention curve with a little noise: 1 at period 0, decaying. */
  function retention (k, c) { return k === 0 ? 1 : Math.max(0.03, (0.62 - c * 0.004) / (1 + 0.32 * k) + (rnd() - 0.5) * 0.04); }

  /** n cohorts x up to n periods. mk(i, k, size, value) builds each row. */
  function triangle (n, maxK, sizeOf) {
    var rows = [];
    for (var i = 0; i < n; i++) {
      var size = sizeOf(i);
      for (var k = 0; k <= Math.min(maxK, n - 1 - i); k++) rows.push({ i: i, k: k, size: size, v: Math.round(size * retention(k, i)) });
    }
    return rows;
  }

  function monthly (n, dated) {
    var rows = triangle(n, 11, function (i) { return 820 + i * 55 + Math.round(rnd() * 90); });
    return rows.map(function (r) {
      var c = monthDate(r.i);
      var o = { cohort: monthText(c), cohortDate: c, 'SUM(Active customers)': r.v, 'SUM(Customers acquired)': r.size };
      if (dated) { var pd = monthDate(r.i + r.k); o.period = iso(pd); o.periodDate = pd; o.periodText = monthText(pd); } else o.period = r.k;
      return o;
    });
  }

  var DATASETS = {
    'default': function () {
      return { tiles: { cohort: ['First order month'], period: ['Months since first order'], value: ['SUM(Active customers)'], size: ['SUM(Customers acquired)'] }, rows: monthly(12, false), cohortKey: 'cohort', periodKey: 'period' };
    },
    dates: function () {
      return { tiles: { cohort: ['First order month'], period: ['Order month'], value: ['SUM(Active customers)'], size: ['SUM(Customers acquired)'] }, rows: monthly(12, true), cohortKey: 'cohort', periodKey: 'period', dates: true };
    },
    weekly: function () {
      var rows = triangle(20, 19, function (i) { return 300 + Math.round(rnd() * 120); }).map(function (r) {
        var d = new Date(2025, 8, 1 + 7 * r.i);
        return { cohort: 'Week of ' + MON[d.getMonth()] + ' ' + d.getDate(), cohortDate: d, period: r.k, 'SUM(Active customers)': r.v };
      });
      return { tiles: { cohort: ['Sign-up week'], period: ['Weeks since sign-up'], value: ['SUM(Active customers)'], size: [] }, rows: rows, cohortKey: 'cohort', periodKey: 'period' };
    },
    small: function () {
      var rows = triangle(4, 3, function (i) { return 400 - i * 40; }).map(function (r) { return { cohort: 'Cohort ' + String.fromCharCode(65 + r.i), period: r.k, 'SUM(Active customers)': r.v }; });
      return { tiles: { cohort: ['Cohort'], period: ['Period'], value: ['SUM(Active customers)'], size: [] }, rows: rows, cohortKey: 'cohort', periodKey: 'period' };
    },
    gaps: function () {
      var rows = [];
      monthly(8, false).forEach(function (r, ix) {
        if (ix % 7 === 3 || ix % 11 === 5) return; // missing cells
        if (ix % 9 === 4) r['SUM(Active customers)'] = 0; // a real zero
        if (r.cohort === 'Jun 2025') r['SUM(Customers acquired)'] = 0; // a cohort with size 0
        rows.push(r);
      });
      return { tiles: { cohort: ['First order month'], period: ['Months since first order'], value: ['SUM(Active customers)'], size: ['SUM(Customers acquired)'] }, rows: rows, cohortKey: 'cohort', periodKey: 'period' };
    },
    big: function () {
      var rows = triangle(50, 49, function (i) { return 2000 + Math.round(rnd() * 400); }).map(function (r) {
        return { cohort: 'Cohort ' + p2(r.i + 1), period: r.k, 'SUM(Active customers)': r.v };
      });
      return { tiles: { cohort: ['Cohort'], period: ['Weeks since sign-up'], value: ['SUM(Active customers)'], size: [] }, rows: rows, cohortKey: 'cohort', periodKey: 'period' };
    },
    renamed: function () {
      var d = DATASETS['default']();
      d.rename = true;
      return d;
    }
  };

  var dsName = params.get('data') || localStorage.getItem(DS_KEY) || 'default';
  var DS = (DATASETS[dsName] || DATASETS['default'])();
  var RENAME = !!DS.rename || /[?&]rename\b/.test(location.search);

  function cell (v, native, text) {
    if (v == null) return { value: null, nativeValue: null, formattedValue: '%null%' };
    return { value: v, nativeValue: native != null ? native : v, formattedValue: text != null ? text : (typeof v === 'number' ? v.toLocaleString('en-US', { maximumFractionDigits: 2 }) : String(v)) };
  }

  var ORDER = ['cohort', 'period', 'value', 'size'];
  var DIMS = { cohort: 1, period: 1 };

  function allFields () {
    var out = [];
    ORDER.forEach(function (t) { (DS.tiles[t] || []).forEach(function (n) { out.push({ tile: t, name: n }); }); });
    return out;
  }

  function buildTable () {
    var fs = allFields();
    var cols = fs.map(function (f, i) {
      var name = RENAME && f.tile === 'cohort' ? 'Calculation_8812' : f.name;
      var type = f.tile === 'cohort' ? (DS.dates ? 'date' : 'string') : f.tile === 'period' ? (DS.dates ? 'date' : 'int') : 'float';
      return { fieldName: name, fieldId: '[' + name + ']', dataType: type, index: i, tile: f.tile, key: f.name };
    });
    // Like Tableau, hand the rows over last-to-first.
    var data = DS.rows.slice().reverse().map(function (r) {
      return cols.map(function (c) {
        if (c.tile === 'cohort') return DS.dates ? cell(iso(r.cohortDate), r.cohortDate, r.cohort) : cell(r.cohort);
        if (c.tile === 'period') return DS.dates ? cell(r.period, r.periodDate, r.periodText) : cell(r.period);
        return cell(r[c.key]);
      });
    });
    return { columns: cols.map(function (c) { return { fieldName: c.fieldName, fieldId: c.fieldId, dataType: c.dataType, index: c.index }; }), data: data };
  }

  function encodings () {
    return allFields().map(function (f, i) {
      var name = RENAME && f.tile === 'cohort' ? 'Cohort (renamed)' : f.name;
      return { id: f.tile, type: 'custom', field: { name: name, id: '[' + name + ']', role: DIMS[f.tile] ? 'dimension' : 'measure' } };
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
    if (e.data && e.data.type === 'cg-dialog-closed' && dialogResolve) { dialogResolve(''); dialogResolve = null; }
    if (e.data && e.data.type === 'cg-configure' && configureFn) configureFn();
  });

  window.tableau = {
    TableauEventType: { SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed' },
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
          localStorage.setItem(SET_KEY, JSON.stringify(pending));
          settingsHandlers.forEach(function (h) { h({}); });
          return Promise.resolve();
        },
        addEventListener: function (type, h) { settingsHandlers.push(h); }
      },
      worksheetContent: {
        worksheet: {
          name: 'Mock sheet',
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
          clearSelectedMarksAsync: function () { return Promise.resolve(); },
          hoverTupleAsync: function (id, ctx) { console.log('mock hoverTupleAsync', id, JSON.stringify(ctx || null)); return Promise.resolve(); }
        }
      },
      ui: {
        displayDialogAsync: function (url, payload) {
          localStorage.setItem(PAYLOAD_KEY, payload || '');
          var target = window.parent !== window ? window.parent : null;
          if (target) target.postMessage({ type: 'cg-open-dialog', url: url }, '*');
          else window.open(url, 'cg-dialog', 'width=620,height=780');
          return new Promise(function (resolve) { dialogResolve = resolve; });
        },
        closeDialog: function () {
          if (window.parent !== window) window.parent.postMessage({ type: 'cg-close-dialog' }, '*');
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
