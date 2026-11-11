'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing KPI Card in a normal
 * browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the card and the Format dialog (two frames)
 *   see each other's changes, like they do inside Tableau.
 * - ?data=NAME  data set (see DATASETS below; default "default")
 * - ?rows=N     override the number of daily rows (e.g. 12000 uses the paged reader)
 * - Daily data over about 26 months, so month-to-date, previous month, year-to-date
 *   and the trend line all have data.
 * - Summary data is sent last-to-first, as Tableau does.
 * - ?failInit=N / ?hangInit=N: first N start-up handshakes fail / never answer.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const SET_KEY = 'kcMockSettings';
  const PAYLOAD_KEY = 'kcMockPayload';
  const isDialog = /configure\.html$/.test(location.pathname);

  const DATASETS = {
    default: 'One measure and a date',
    negative: 'Values crossing zero',
    flat: 'Flat (all values equal)',
    zeros: 'All zeros',
    nulls: 'Gaps (missing values)',
    nodate: 'No Date tile',
    tooltip: 'Measures on the Tooltip tile',
    renamed: 'Pill name differs from column name',
    big: '2,500 daily rows (row limit note)'
  };
  const dataName = DATASETS[params.get('data')] ? params.get('data') : 'default';

  let seed = 7;
  function rnd () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function pad (x) { return (x < 10 ? '0' : '') + x; }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAY = 864e5;
  const END = Date.UTC(2026, 10, 9);
  const START = Date.UTC(2024, 8, 1); // about 26 months

  const TIP = [['SUM(Orders)', 1800, 150], ['AVG(Basket Size)', 42.5, 4], ['SUM(Returns)', 0, 60]];

  function spec () {
    const s = {
      measure: { name: 'SUM(Net Sales)', pill: 'SUM(Net Sales)', id: '[m0]' },
      hasDate: true,
      tips: 0,
      days: Math.round((END - START) / DAY) + 1
    };
    if (dataName === 'tooltip') s.tips = 3;
    if (dataName === 'nodate') s.hasDate = false;
    if (dataName === 'renamed') s.pill = 'SUM(Revenue)';
    if (dataName === 'big') s.days = 2500;
    if (params.get('rows') && Number(params.get('rows')) > 0) s.days = Math.floor(Number(params.get('rows')));
    return s;
  }

  function value (kind, i, base) {
    const trend = 1 + i * 0.0006;
    const wave = 1 + 0.08 * Math.sin(i / 9);
    const noise = 1 + (rnd() - 0.5) * 0.1;
    if (kind === 'negative') return Math.round((Math.sin(i / 11) * 40000 + (rnd() - 0.5) * 20000) * 100) / 100;
    if (kind === 'flat') return 25000;
    if (kind === 'zeros') return 0;
    return Math.round(base * trend * wave * noise * 100) / 100;
  }

  function buildTable () {
    const s = spec();
    const cols = [];
    let ci = 0;
    if (s.hasDate) cols.push({ fieldName: 'DAY(Order Date)', fieldId: '[snap].[dy]', index: ci++, dataType: 'date' });
    cols.push({ fieldName: s.measure.name, fieldId: s.measure.id, index: ci++, dataType: 'float' });
    for (let t = 0; t < s.tips; t++) cols.push({ fieldName: TIP[t][0], fieldId: '[d' + t + ']', index: ci++, dataType: 'float' });

    const rows = [];
    if (s.hasDate) {
      const last = dataName === 'big' || params.get('rows') ? END : END;
      for (let i = 0; i < s.days; i++) {
        const t = new Date(last - (s.days - 1 - i) * DAY);
        const iso = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
        rows.push(makeRow(s, i, { value: iso, nativeValue: iso, formattedValue: MONTHS[t.getUTCMonth()] + ' ' + t.getUTCDate() + ', ' + t.getUTCFullYear() }));
      }
    } else {
      rows.push(makeRow(s, 0, null));
    }
    rows.reverse(); // Tableau sends summary data last-to-first
    return { name: 'Summary', columns: cols, data: rows, totalRowCount: rows.length, isSummaryData: true };
  }

  function cell (v, digits) {
    if (v == null) return { value: null, nativeValue: null, formattedValue: 'Null' };
    return { value: v, nativeValue: v, formattedValue: String(Math.round(v * digits) / digits) };
  }

  function makeRow (s, i, dateCell) {
    const row = [];
    if (dateCell) row.push(dateCell);
    let v = value(dataName, i, 31000);
    if (dataName === 'nulls' && (i % 7 === 3 || (i > 600 && i < 615) || i > s.days - 4)) v = null;
    row.push(cell(v, 100));
    for (let t = 0; t < s.tips; t++) {
      const m = TIP[t];
      row.push(cell(Math.round((m[1] + (rnd() - 0.5) * 2 * m[2]) * 100) / 100, 100));
    }
    return row;
  }

  function readSettings () { try { return JSON.parse(localStorage.getItem(SET_KEY) || '{}'); } catch (e) { return {}; } }
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
    if (e.data && e.data.type === 'kc-dialog-closed' && dialogDone) { const d = dialogDone; dialogDone = null; d(); }
  });

  const worksheet = {
    name: 'KPI (mock)',
    // One call; honours maxRows like Tableau.
    selectMarksByValueAsync: function (sel) { console.log('mock selectMarksByValueAsync', JSON.stringify(sel)); return Promise.resolve(); },
    clearSelectedMarksAsync: function () { console.log('mock clearSelectedMarksAsync'); return Promise.resolve(); },
    hoverTupleAsync: function (id, ctx) { console.log('mock hoverTupleAsync', id, JSON.stringify(ctx || null)); return Promise.resolve(); },
    getSummaryDataAsync: function (opts) {
      return new Promise(function (r) {
        setTimeout(function () {
          const t = buildTable();
          const max = opts && opts.maxRows > 0 ? opts.maxRows : 0;
          if (max && t.data.length > max) t.data = t.data.slice(0, max);
          r(t);
        }, 60);
      });
    },
    // Paged reader: 1,000 rows a page so paging is exercised.
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
      const s = spec();
      const enc = [{ id: 'value', field: { id: s.measure.id, name: s.pill } }];
      if (s.hasDate) enc.push({ id: 'date', field: { id: '[snap].[dy]', name: 'DAY(Order Date)' } });
      // Tableau's own Tooltip tile: built-in encodings come with a type.
      for (let t = 0; t < s.tips; t++) enc.push({ id: 'tooltip', type: 'tooltip', field: { id: '[d' + t + ']', name: TIP[t][0], role: 'measure' } });
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
          parent.postMessage({ type: 'kc-open-dialog', url: url + '?mock' }, '*');
          return new Promise(function (r) { dialogDone = r; });
        },
        closeDialog: function () { parent.postMessage({ type: 'kc-close-dialog' }, '*'); }
      }
    }
  };
  if (!isDialog) window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'kc-configure') { const c = tableau.extensions._configure; if (c) c(); }
  });
})();

// Dev only: index.html?mock&failInit=N makes the first N handshakes fail, and &hangInit=N makes the
// first N never answer (timeout), to test the automatic reload.
(function () {
  const m = /[?&]failInit=(\d+)/.exec(location.search) || [0, 0];
  const h = /[?&]hangInit=(\d+)/.exec(location.search) || [0, 0];
  if (!(+m[1] || +h[1]) || !(window.tableau && tableau.extensions)) return;
  const tries = +((/(?:ext|kpi)Retry=(\d+)/.exec(location.hash) || [])[1] || 0);
  const real = tableau.extensions.initializeAsync;
  tableau.extensions.initializeAsync = function (opts) {
    if (tries < +h[1]) return new Promise(function () {});
    if (tries < +m[1]) return Promise.reject(new Error('mock: handshake rejected (failInit)'));
    return real.call(tableau.extensions, opts);
  };
})();
