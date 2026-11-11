'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing Narrative Card in a normal
 * browser (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - Settings live in localStorage, so the card and the Format dialog (two frames)
 *   see each other's changes, like they do inside Tableau.
 * - ?data=NAME  data set (see DATASETS below; default "default")
 * - ?rows=N     override the number of daily rows (e.g. 12000 uses the paged reader)
 * - Daily data over about 26 months, so month-to-date, previous month and the previous date all have data.
 * - Summary data is sent last-to-first, as Tableau does.
 * - Each data set seeds a sample template the first time it is opened (until you change the text).
 * - window.mockSetParam('Region Param', 'East') changes a Tableau parameter (for <Region Param>).
 * - ?failInit=N / ?hangInit=N: first N start-up handshakes fail / never answer.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const SET_KEY = 'ncMockSettings';
  const PAYLOAD_KEY = 'ncMockPayload';
  const SEED_KEY = 'ncMockSeed';
  const isDialog = /configure\.html$/.test(location.pathname);

  const DATASETS = {
    default: '4 measures + daily dates (26 months)',
    nodate: 'No Date tile (one aggregated row)',
    negative: 'Falls, zeros and nulls',
    renamed: 'Pill names differ from column names',
    long: 'A long template (scrolls / wraps)',
    big: '2,500 daily rows (row limit note)'
  };
  const dataName = DATASETS[params.get('data')] ? params.get('data') : 'default';

  // Sample template per data set (seeded once), plus the settings that make it read right.
  const SEEDS = {
    default: {
      template: { text: '{Revenue} this month, {Revenue.change} vs last month. {Orders} orders at an average of {Avg Order Value|2}.\n- Returns: {Returns} ({Returns.change} vs last month)\n- Region: <Region Param>' },
      number: { period: 'mtd' },
      change: { period: 'mtd', compareTo: 'prevMonth' },
      measures: { items: [{ key: 'Orders', scale: 'none', decimals: 0 }, { key: 'Returns', higherIsBetter: false }, { key: 'Avg Order Value', mtdAgg: 'avg', decimals: 2 }] }
    },
    negative: {
      template: { text: 'Revenue {Revenue.direction} to {Revenue} ({Revenue.diff} {if Revenue.change > 0}more{else}less{end} than before).\n{if Revenue < 0}**Revenue is below zero.**{end}\nOrders: {Orders}. Returns: {Returns}. Typo check: {Revnue}.' }
    },
    long: {
      template: { text: Array.from({ length: 6 }, (_, i) => 'Paragraph ' + (i + 1) + ': **{Revenue}** of revenue and *{Orders}* orders, {Revenue.change} against the previous date, with returns at {Returns|1} and an average order value of {Avg Order Value}. This line is long on purpose so that it wraps over several lines in a small zone.').join('\n') + '\n- First bullet: {Orders.previous}\n- Second bullet: {Returns.diff}' }
    }
  };

  let seed = 7;
  function rnd () { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }
  function pad (x) { return (x < 10 ? '0' : '') + x; }
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DAY = 864e5;
  const END = Date.UTC(2026, 10, 9);
  const START = Date.UTC(2024, 8, 1); // about 26 months

  // [column name, pill name, base value, spread]
  const MEASURES = [
    ['SUM(Revenue)', 'SUM(Revenue)', 43000, 0.1],
    ['SUM(Orders)', 'SUM(Orders)', 600, 0.1],
    ['AVG(Avg Order Value)', 'AVG(Avg Order Value)', 71.2, 0.03],
    ['SUM(Returns)', 'SUM(Returns)', 25, 0.3]
  ];

  function spec () {
    const s = {
      measures: MEASURES.map((m, i) => ({ col: m[0], pill: m[1], id: '[m' + i + ']', base: m[2], spread: m[3] })),
      hasDate: dataName !== 'nodate',
      days: Math.round((END - START) / DAY) + 1
    };
    if (dataName === 'renamed') { s.measures[0].col = 'SUM(Net Sales)'; s.measures[2].col = 'AVG(Basket Value)'; }
    if (dataName === 'big') s.days = 2500;
    if (params.get('rows') && Number(params.get('rows')) > 0) s.days = Math.floor(Number(params.get('rows')));
    return s;
  }

  function value (m, k, i, days) {
    const trend = 1 + i * 0.0006;
    const wave = 1 + 0.08 * Math.sin(i / 9 + k);
    const noise = 1 + (rnd() - 0.5) * 2 * m.spread;
    if (dataName === 'negative') {
      if (k === 0) return Math.round((Math.sin(i / 11) * 40000 + (rnd() - 0.5) * 20000) * 100) / 100;
      if (k === 1) return i > days - 4 || i % 6 === 2 ? null : Math.round(m.base * 0.9 * noise);
      if (k === 3) return 0;
      return Math.round(m.base * (1 - i * 0.0004) * noise * 100) / 100;
    }
    const v = m.base * trend * wave * noise;
    return k === 1 ? Math.round(v) : Math.round(v * 100) / 100;
  }

  function cell (v) {
    if (v == null) return { value: null, nativeValue: null, formattedValue: 'Null' };
    return { value: v, nativeValue: v, formattedValue: String(Math.round(v * 100) / 100) };
  }

  function buildTable () {
    const s = spec();
    const cols = [];
    let ci = 0;
    if (s.hasDate) cols.push({ fieldName: 'DAY(Order Date)', fieldId: '[snap].[dy]', index: ci++, dataType: 'date' });
    s.measures.forEach(function (m) { cols.push({ fieldName: m.col, fieldId: m.id, index: ci++, dataType: 'float' }); });
    const rows = [];
    if (s.hasDate) {
      for (let i = 0; i < s.days; i++) {
        const t = new Date(END - (s.days - 1 - i) * DAY);
        const iso = t.getUTCFullYear() + '-' + pad(t.getUTCMonth() + 1) + '-' + pad(t.getUTCDate());
        const row = [{ value: iso, nativeValue: iso, formattedValue: MONTHS[t.getUTCMonth()] + ' ' + t.getUTCDate() + ', ' + t.getUTCFullYear() }];
        s.measures.forEach(function (m, k) { row.push(cell(value(m, k, i, s.days))); });
        rows.push(row);
      }
    } else {
      // One aggregated row: what Tableau sends without a Date tile.
      rows.push(s.measures.map(function (m, k) { return cell(k === 2 ? 71.2 : k === 1 ? 18420 : k === 0 ? 1312450.5 : 840); }));
    }
    rows.reverse(); // Tableau sends summary data last-to-first
    return { name: 'Summary', columns: cols, data: rows, totalRowCount: rows.length, isSummaryData: true };
  }

  // Parameters (for <Parameter name> in the template). window.mockSetParam('Region Param', 'East') changes one.
  const MOCK_PARAMS = [['Region Param', 'West'], ['Report Month', 'November 2026']].map(function (p) {
    const o = { name: p[0], id: p[0], currentValue: { value: p[1], formattedValue: p[1] }, _h: [] };
    o.addEventListener = function (t, h) { o._h.push(h); };
    return o;
  });
  window.mockSetParam = function (name, v) {
    MOCK_PARAMS.forEach(function (p) { if (p.name === name) { p.currentValue = { value: v, formattedValue: v }; p._h.forEach(function (h) { h({}); }); } });
  };

  // Seed the sample template of this data set while the saved one is empty or still the previous sample.
  (function seedSettings () {
    try {
      const seedObj = SEEDS[dataName];
      const key = 'narrativeCard1';
      const all = JSON.parse(localStorage.getItem(SET_KEY) || '{}');
      const cur = all[key] ? JSON.parse(all[key]) : {};
      const curText = (cur.template && cur.template.text) || '';
      const lastSeed = localStorage.getItem(SEED_KEY) || '';
      if (curText && curText !== lastSeed) return; // the builder's own text: leave it
      const next = seedObj ? JSON.parse(JSON.stringify(seedObj)) : { template: { text: '' } };
      const merged = Object.assign({}, cur, next);
      all[key] = JSON.stringify(merged);
      localStorage.setItem(SET_KEY, JSON.stringify(all));
      localStorage.setItem(SEED_KEY, (seedObj && seedObj.template.text) || '');
    } catch (e) { /* ignore */ }
  })();

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
    if (e.data && e.data.type === 'nc-dialog-closed' && dialogDone) { const d = dialogDone; dialogDone = null; d(); }
  });

  const worksheet = {
    name: 'Narrative (mock)',
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
    getParametersAsync: function () { return Promise.resolve(MOCK_PARAMS); },
    getVisualSpecificationAsync: function () {
      const s = spec();
      const enc = s.measures.map(function (m) { return { id: 'measures', field: { id: m.id, name: m.pill } }; });
      if (s.hasDate) enc.push({ id: 'date', field: { id: '[snap].[dy]', name: 'DAY(Order Date)' } });
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
          parent.postMessage({ type: 'nc-open-dialog', url: url + '?mock' }, '*');
          return new Promise(function (r) { dialogDone = r; });
        },
        closeDialog: function () { parent.postMessage({ type: 'nc-close-dialog' }, '*'); }
      }
    }
  };
  if (!isDialog) window.addEventListener('message', function (e) {
    if (e.data && e.data.type === 'nc-configure') { const c = tableau.extensions._configure; if (c) c(); }
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
