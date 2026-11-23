'use strict';

/**
 * Stand-in for the Tableau Extensions API, for previewing Calendar Filter in a normal browser
 * (dev/preview.html). Loaded only when the page URL has ?mock.
 *
 * - ?data=NAME  data set (see DATASETS). Made-up daily data, sent last-to-first like Tableau.
 * - Settings live in localStorage (one set per data set), so the text box, the calendar window and
 *   the Format dialog (three frames) see each other's changes, as inside Tableau.
 * - selectMarksByValueAsync / clearSelectedMarksAsync keep a selection that getSelectedMarksAsync
 *   returns (so a reload restores the filter) and that the preview shows under the zone.
 * - Dialogs: displayDialogAsync asks the preview page to open the window (sized like Tableau would);
 *   closeDialog(payload) resolves it; sendDialogMessageToParentAsync reaches the text box through
 *   the preview page (DialogMessageReceived).
 * - ?failInit=N / ?hangInit=N: first N handshakes fail / never answer.
 */
(function () {
  const params = new URLSearchParams(location.search);
  const page = (/([a-z]+)\.html$/.exec(location.pathname) || [])[1] || 'index';
  const isDialog = page === 'configure' || page === 'picker';

  const DATASETS = {
    default: 'Order Date + Value, 2024 – Nov 2026, 42 null dates',
    novalue: 'Order Date only (no Value tile)',
    datetime: 'Order Date as date-time (several rows a day)',
    nonull: 'No null dates',
    month: 'Date at month level (shows the fix-it message)',
    empty: 'Nothing on the Date tile'
  };
  const dataName = DATASETS[params.get('data')] ? params.get('data') : 'default';
  const SET_KEY = 'cfMockSettings:' + dataName;
  const SEL_KEY = 'cfMockSelection:' + dataName;
  const PAYLOAD_KEY = 'cfMockPayload:' + page;

  // ---- Data ------------------------------------------------------------------
  let seed = 11;
  function rnd () { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }
  function iso (t) { const d = new Date(t); return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0'); }

  function buildRows () {
    const rows = [];
    if (dataName === 'empty') return rows;
    const now = new Date();
    const end = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - 3 * 864e5; // data lands 3 days late
    for (let t = Date.UTC(2024, 0, 1); t <= end; t += 864e5) {
      const d = new Date(t);
      const m = d.getUTCMonth();
      const day = d.getUTCDate();
      if ((m === 11 && day >= 25) || (m === 0 && day === 1)) continue; // holiday gap
      if (d.getUTCFullYear() === 2025 && m === 7 && day >= 10 && day <= 23) continue; // two missing weeks
      const w = d.getUTCDay();
      let c = (w === 5 || w === 6) ? Math.floor(rnd() * 6) : 8 + Math.floor(rnd() * 25);
      if (c <= 0) continue;
      if (dataName === 'month') {
        if (day !== 1) continue;
        c *= 30;
      }
      if (dataName === 'datetime') {
        ['09:15:00', '14:40:00'].forEach(function (time, i) { rows.push({ date: iso(t) + ' ' + time, value: Math.ceil(c / 2) + i }); });
      } else {
        rows.push({ date: iso(t), value: c });
      }
    }
    if (dataName !== 'nonull' && dataName !== 'month') rows.push({ date: null, value: 42 });
    return rows;
  }
  const ROWS = buildRows();
  const hasValue = dataName !== 'novalue' && dataName !== 'empty';
  const DATE_FIELD = { id: '[mock].[none:Order Date:ok]', name: dataName === 'month' ? 'MONTH(Order Date)' : 'Order Date' };
  const VALUE_FIELD = { id: '[mock].[cnt:Number of Records:qk]', name: 'CNT(Number of Records)' };

  function dateCell (v) {
    return v == null ? { value: '%null%', nativeValue: null, formattedValue: 'Null' } : { value: v, nativeValue: v, formattedValue: v };
  }

  function buildTable () {
    if (dataName === 'empty') return { name: 'Summary', columns: [], data: [], totalRowCount: 0, isSummaryData: true };
    const columns = [{ fieldName: DATE_FIELD.name, fieldId: DATE_FIELD.id, index: 0, dataType: dataName === 'datetime' ? 'date-time' : 'date' }];
    if (hasValue) columns.push({ fieldName: VALUE_FIELD.name, fieldId: VALUE_FIELD.id, index: 1, dataType: 'int' });
    const data = ROWS.map(function (r) {
      const row = [dateCell(r.date)];
      if (hasValue) row.push({ value: r.value, nativeValue: r.value, formattedValue: String(r.value) });
      return row;
    });
    data.reverse(); // Tableau sends summary data last-to-first
    return { name: 'Summary', columns: columns, data: data, totalRowCount: data.length, isSummaryData: true };
  }

  // ---- Selection ---------------------------------------------------------------
  function readSel () { try { return JSON.parse(localStorage.getItem(SEL_KEY) || '[]'); } catch (e) { return []; } }
  function writeSel (list) {
    localStorage.setItem(SEL_KEY, JSON.stringify(list));
    parent.postMessage({ type: 'cf-selection', count: list.length, sample: list.slice(0, 6) }, '*');
    setTimeout(function () { selHandlers.forEach(function (h) { h({}); }); }, 30);
  }
  const selHandlers = [];
  const dataHandlers = [];

  // ---- Settings ----------------------------------------------------------------
  function readSettings () {
    try { const s = localStorage.getItem(SET_KEY); if (s) return JSON.parse(s); } catch (e) { /* ignore */ }
    return {};
  }
  let pending = readSettings();
  const settingsHandlers = [];
  window.addEventListener('storage', function (e) {
    if (e.key !== SET_KEY) return;
    pending = readSettings();
    settingsHandlers.forEach(function (h) { h({}); });
  });

  // ---- Dialogs -----------------------------------------------------------------
  let dialogDone = null;
  const msgHandlers = [];
  window.addEventListener('message', function (e) {
    const d = e.data;
    if (!d) return;
    if (d.type === 'cf-dialog-closed' && dialogDone) {
      const done = dialogDone;
      dialogDone = null;
      done(d.payload);
    }
    if (d.type === 'cf-dialog-message') msgHandlers.forEach(function (h) { h({ message: d.message }); });
    if (d.type === 'cf-configure' && !isDialog) { const c = tableau.extensions._configure; if (c) c(); }
    if (d.type === 'cf-external-clear' && !isDialog) worksheet.clearSelectedMarksAsync();
  });

  const worksheet = {
    name: 'Calendar (mock)',
    selectMarksByValueAsync: function (sel) {
      const vals = (sel && sel[0] && sel[0].value) || [];
      console.log('mock selectMarksByValueAsync', vals.length + ' values', JSON.stringify(vals.slice(0, 5)));
      writeSel(vals);
      return Promise.resolve();
    },
    clearSelectedMarksAsync: function () { console.log('mock clearSelectedMarksAsync'); writeSel([]); return Promise.resolve(); },
    getSelectedMarksAsync: function () {
      const sel = readSel();
      const t = buildTable();
      const want = {};
      sel.forEach(function (v) { want[String(v)] = true; });
      const rows = t.data.filter(function (r) { return want[String(r[0].value)]; });
      return Promise.resolve({ data: [{ name: 'Selected marks', columns: t.columns, data: rows, totalRowCount: rows.length }] });
    },
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
    getSummaryDataReaderAsync: function (pageRowCount) {
      const t = buildTable();
      const size = pageRowCount > 0 ? pageRowCount : 1000;
      let released = false;
      return Promise.resolve({
        pageCount: Math.max(1, Math.ceil(t.data.length / size)),
        totalRowCount: t.data.length,
        getPageAsync: function (p) {
          if (released) return Promise.reject(new Error('mock: reader already released'));
          return Promise.resolve({ columns: t.columns, data: t.data.slice(p * size, (p + 1) * size), totalRowCount: t.data.length, isSummaryData: true });
        },
        getAllPagesAsync: function () { return Promise.resolve({ columns: t.columns, data: t.data, totalRowCount: t.data.length, isSummaryData: true }); },
        releaseAsync: function () { released = true; return Promise.resolve(); }
      });
    },
    getVisualSpecificationAsync: function () {
      const enc = [];
      if (dataName !== 'empty') enc.push({ id: 'date', field: DATE_FIELD });
      if (hasValue) enc.push({ id: 'value', field: VALUE_FIELD });
      return Promise.resolve({ activeMarksSpecificationIndex: 0, marksSpecifications: [{ encodings: enc }] });
    },
    addEventListener: function (t, h) {
      if (t === 'summary-data-changed') dataHandlers.push(h);
      if (t === 'mark-selection-changed') selHandlers.push(h);
      return function () {};
    }
  };
  window.mockDataChanged = function () { dataHandlers.forEach(function (h) { h({}); }); };

  window.tableau = {
    TableauEventType: {
      SummaryDataChanged: 'summary-data-changed', SettingsChanged: 'settings-changed',
      MarkSelectionChanged: 'mark-selection-changed', DialogMessageReceived: 'dialog-message-received'
    },
    DialogStyle: { Modal: 'modal', Modeless: 'modeless', Window: 'window' },
    SelectionUpdateType: { Replace: 'select-replace' },
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
        saveAsync: function () { localStorage.setItem(SET_KEY, JSON.stringify(pending)); return Promise.resolve(pending); },
        addEventListener: function (t, h) { if (t === 'settings-changed') settingsHandlers.push(h); return function () {}; }
      },
      ui: {
        displayDialogAsync: function (url, payload, opts) {
          const kind = /picker\.html$/.test(url) ? 'picker' : 'configure';
          localStorage.setItem('cfMockPayload:' + kind, payload || '');
          parent.postMessage({ type: 'cf-open-dialog', url: url + '?mock&data=' + dataName, kind: kind, options: opts || {} }, '*');
          return new Promise(function (resolve, reject) {
            dialogDone = function (p) {
              if (p == null) { const e = new Error('Extension dialog closed by user.'); e.errorCode = 'dialog-closed-by-user'; reject(e); } else resolve(p);
            };
          });
        },
        closeDialog: function (payload) { parent.postMessage({ type: 'cf-close-dialog', payload: payload == null ? ' ' : payload }, '*'); },
        sendDialogMessageToParentAsync: function (message) { parent.postMessage({ type: 'cf-dialog-message-up', message: message }, '*'); return Promise.resolve(); },
        sendDialogMessageAsync: function () { return Promise.resolve(); },
        addEventListener: function (t, h) { if (t === 'dialog-message-received') msgHandlers.push(h); return function () {}; }
      }
    }
  };
})();

// Dev only: index.html?mock&failInit=N / &hangInit=N to test the automatic reload.
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
