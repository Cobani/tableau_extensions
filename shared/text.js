'use strict';

/**
 * ExtText — worksheet fields and Tableau parameters inside the title and the
 * explanation text of every extension.
 *
 * Loaded by every index.html and configure.html after shared/core.js. A change
 * here changes the header of all extensions: it is covered by tests/text.test.js.
 *
 * What a dashboard builder can write (the README of every extension links here):
 *   <Parameter name>     the parameter's current value (as Tableau formats it)
 *   {Field}              a measure: its total over the rows the worksheet sends (AVG / MIN / MAX
 *                        pills: the average / smallest / largest); a dimension: its value, or the
 *                        first three values and "and N more" when there are several
 *   {Field.sum} .avg .min .max .count .first .last    measure statistics (count = rows with a value)
 *   {Field.list} .count .first .last                  dimension: all values, how many, first, last
 *   {Field.name}         the field's name
 *   {Field|K|1} {Field|%} {Field|+} {Field|full}      number overrides: scale (none/full, K, M, B,
 *                        dynamic), decimals, percentage (×100), plus sign; they combine
 * Names are the pill names without SUM / AVG (any capitals); 'SUM(Sales)' itself and a renamed
 * pill's shown name work too. Only fields that are on the worksheet (any Marks card tile) can be
 * used. Anything that matches no field or parameter stays as typed, so old texts with braces or
 * angle brackets look the same as before. "First" and "last" (and the order of a dimension's
 * values) follow the first date on the worksheet, earliest first; without a date, the order
 * Tableau sends, read backwards (summary data usually arrives last-to-first).
 *
 * Chart page (index.html):
 *   ExtText.init({ worksheet, onChange })   onChange(): repaint the header (a parameter changed)
 *   ExtText.setTable(table)                 the summary data just read ({ columns, data })
 *   ExtText.fill(text, opts)                → plain text. opts.tokens: { name: value | fn } chart
 *                                           tokens tried first ({total} in the Sankey…);
 *                                           opts.params(name): an extension's own parameter lookup
 *   ExtText.setParams([{ name, value }])    extensions that read parameters themselves share them
 *   ExtText.ready(worksheet)                Promise: parameters known (call before opening the dialog)
 *   ExtText.addInfo(payloadString)          adds what the Format dialog lists (fields, parameters)
 * Format dialog (configure.html):
 *   ExtText.readPayload(payloadString)      keeps that list; ExtText.dialogData() returns it
 *   ExtText.preview(text, opts)             the text with the chart's numbers, for the dialog
 *   ExtText.unknown(text, opts)             tokens that match nothing (shown as a warning)
 *
 * Parameters are asked from Tableau only when a text contains <…> or the Format dialog opens
 * (calls are answered one at a time for the whole dashboard, so none are added on load).
 * Nothing is stored in the browser.
 */
(function (root) {
  const core = root.ExtCore || (typeof require !== 'undefined' ? require('./core.js') : null);

  const VALUES_KEPT = 200; // distinct dimension values kept per field (the dialog gets 30)
  const STATS = ['sum', 'avg', 'min', 'max', 'count', 'first', 'last', 'list', 'name'];
  const STAT_ALIAS = { average: 'avg', mean: 'avg', total: 'sum', countd: 'count', values: 'list', all: 'list' };
  const DATE_PART = /^(YEAR|QUARTER|MONTH|WEEK|DAY|WEEKDAY|HOUR|MINUTE|TYR|TQR|TMN|TWK|TDY|MY|QY|MDY)\(/i;
  const AGG_PREFIX = /^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|STDEV|STDEVP|VAR|VARP|PCT\d*|USR)\(/i;
  const TOKEN = /\{([^{}]+)\}|<([^<>]+)>/g;

  // ---------------------------------------------------------------------------
  // Model: one entry per summary data column
  // ---------------------------------------------------------------------------
  function cellText (cell) {
    if (!cell) return '';
    const v = cell.formattedValue != null ? cell.formattedValue : cell.value;
    if (v == null || v === '%null%' || v === 'Null') return '';
    return String(v);
  }

  function keysOf (fieldName) {
    const s = String(fieldName || '').trim();
    const out = [s.toLowerCase(), core.norm(s), core.cleanName(s, { alias: true }).toLowerCase(), core.cleanName(s).toLowerCase()]
      .concat(core.nameParts(s));
    return out.filter(function (k, i) { return k && out.indexOf(k) === i; });
  }

  /** A sortable number for a date cell (Date, ISO text, or a date part's number), else NaN. */
  function timeKey (cell) {
    if (!cell) return NaN;
    const v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v == null || v === '' || v === '%null%') return NaN;
    if (typeof v === 'number') return v;
    if (v instanceof Date) return v.getTime();
    const t = Date.parse(String(v));
    return isFinite(t) ? t : (isFinite(Number(v)) ? Number(v) : NaN);
  }

  /**
   * Rows in reading order: by the first date column (date / datetime, or a date part such as
   * MONTH(Order Date)) when there is one, earliest first; otherwise the order Tableau sends,
   * read backwards (summary data usually arrives last-to-first, but not for every view).
   */
  function orderedRows (table) {
    const data = table.data || [];
    const cols = table.columns || [];
    const dc = cols.findIndex(function (c) { return /^date(time)?$/i.test(String(c.dataType || '')) || DATE_PART.test(String(c.fieldName || '')); });
    if (dc >= 0) {
      const idx = cols[dc].index != null ? cols[dc].index : dc;
      const keyed = data.map(function (r, i) { return { r: r, k: timeKey(r[idx]), i: i }; });
      if (keyed.filter(function (x) { return isFinite(x.k); }).length >= data.length / 2) {
        return keyed.sort(function (a, b) {
          const fa = isFinite(a.k); const fb = isFinite(b.k);
          if (fa !== fb) return fa ? -1 : 1;
          return (fa && a.k !== b.k) ? a.k - b.k : b.i - a.i;
        }).map(function (x) { return x.r; });
      }
    }
    return data.slice().reverse();
  }

  /** Summary table → { fields: [{ name, keys, kind, agg, values, count, stats }] }. */
  function buildModel (table) {
    if (!table || !table.columns) return { fields: [] };
    const rows = orderedRows(table);
    const fields = table.columns.map(function (c, ci) {
      const fn = String(c.fieldName || '');
      const idx = c.index != null ? c.index : ci;
      const numeric = core.isNumericCol(c) || /^measure values$/i.test(fn);
      const measure = (AGG_PREFIX.test(fn) && !DATE_PART.test(fn)) || (numeric && !DATE_PART.test(fn) && !core.isMN(c)) || /^measure values$/i.test(fn);
      const m = /^([A-Z]+)\(/i.exec(fn);
      const agg = !measure ? null : m && /^AVG$/i.test(m[1]) ? 'avg' : m && /^MIN$/i.test(m[1]) ? 'min' : m && /^MAX$/i.test(m[1]) ? 'max' : 'sum';
      const seen = {};
      const values = [];
      let count = 0;
      let lastText = '';
      let sum = 0; let n = 0; let min = Infinity; let max = -Infinity; let first = NaN; let last = NaN;
      rows.forEach(function (r) {
        const cell = r[idx];
        const t = cellText(cell);
        if (t !== '') lastText = t;
        if (t !== '' && !seen[t]) { seen[t] = true; count++; if (values.length < VALUES_KEPT) values.push(t); }
        if (!numeric) return;
        const x = core.toNumber(cell);
        if (!isFinite(x)) return;
        sum += x; n++;
        if (x < min) min = x;
        if (x > max) max = x;
        if (!isFinite(first)) first = x;
        last = x;
      });
      const f = { name: core.cleanName(fn, { alias: true }), keys: keysOf(fn), kind: measure ? 'measure' : 'dimension', agg: agg, values: values, count: count, lastValue: lastText };
      if (numeric) f.stats = { sum: n ? sum : NaN, avg: n ? sum / n : NaN, min: n ? min : NaN, max: n ? max : NaN, count: n, first: first, last: last };
      return f;
    });
    return { fields: fields };
  }

  function findField (model, name) {
    const k = String(name || '').trim().toLowerCase();
    if (!k || !model || !model.fields) return null;
    const list = model.fields;
    return list.find(function (f) { return f.keys[0] === k; }) ||
      list.find(function (f) { return f.keys.indexOf(k) >= 0; }) || null;
  }

  // ---------------------------------------------------------------------------
  // Numbers
  // ---------------------------------------------------------------------------
  function parseMods (mods) {
    const o = {};
    (mods || []).forEach(function (raw) {
      const m = String(raw).trim();
      if (/^\d{1,2}$/.test(m)) o.decimals = Number(m);
      else if (/^(none|full)$/i.test(m)) o.scale = 'none';
      else if (/^(k|m|b|t)$/i.test(m)) o.scale = m.toUpperCase();
      else if (/^(dynamic|auto)$/i.test(m)) o.scale = 'dynamic';
      else if (m === '%') o.pct = true;
      else if (m === '+') o.plus = true;
    });
    return o;
  }

  /** A number for a text: dynamic K / M / B, 1 decimal when scaled, whole numbers without decimals. */
  function formatNumber (v, mods, isCount) {
    if (!isFinite(v)) return '—';
    const o = mods || {};
    let x = o.pct ? v * 100 : v;
    const scale = o.scale || (o.pct || isCount ? 'none' : 'dynamic');
    const suffix = core.pickScale(x, scale);
    let d = o.decimals;
    if (d == null) {
      const shown = suffix ? x / core.SCALES[suffix] : x;
      d = isCount ? 0 : o.pct ? 1 : suffix ? 1 : Math.abs(shown - Math.round(shown)) < 1e-9 ? 0 : 2;
    }
    let s = core.formatScaled(x, scale, d);
    if (o.pct) s += '%';
    if (o.plus && x > 0) s = '+' + s;
    return s;
  }

  function joinValues (values, count, all) {
    if (!values.length) return '';
    if (all) return values.join(', ') + (count > values.length ? ' and ' + (count - values.length) + ' more' : '');
    if (count === 1) return values[0];
    if (count <= 3) return values.slice(0, -1).join(', ') + ' and ' + values[values.length - 1];
    return values.slice(0, 3).join(', ') + ' and ' + (count - 3) + ' more';
  }

  /** One field token → text, or null when the stat does not apply. */
  function fieldValue (f, stat, mods) {
    const o = parseMods(mods);
    const hasMods = Object.keys(o).length > 0;
    if (stat === 'name') return f.name;
    const st = f.stats;
    if (!stat) stat = f.kind === 'measure' ? f.agg : null;
    if (!stat) return joinValues(f.values, f.count, false);
    if (stat === 'list') return joinValues(f.values, f.count, true);
    if (stat === 'count') return formatNumber(f.kind === 'measure' && st ? st.count : f.count, o, !hasMods || o.decimals == null);
    if ((stat === 'first' || stat === 'last') && (f.kind !== 'measure' || !st)) {
      return stat === 'first' ? (f.values[0] || '') : (f.lastValue || '');
    }
    if (!st) return null; // .sum of a text field
    return formatNumber(st[stat], o, false);
  }

  function resolveField (model, head, mods) {
    let f = findField(model, head);
    let stat = null;
    if (!f) {
      const dot = head.lastIndexOf('.');
      if (dot <= 0) return null;
      stat = head.slice(dot + 1).trim().toLowerCase();
      stat = STAT_ALIAS[stat] || stat;
      if (STATS.indexOf(stat) < 0) return null;
      f = findField(model, head.slice(0, dot));
      if (!f) return null;
    }
    return fieldValue(f, stat, mods);
  }

  /**
   * The text with every token that matches something replaced; the rest stays as typed.
   * opts: model, params(name) → string | null, tokens { lowercase name: value | fn }.
   */
  function fillWith (text, opts) {
    const o = opts || {};
    const tokens = o.tokens || {};
    return String(text == null ? '' : text).replace(TOKEN, function (all, brace, angle) {
      if (angle != null) {
        const v = o.params ? o.params(angle) : null;
        return v != null ? String(v) : all;
      }
      const parts = brace.split('|');
      const head = parts[0].trim();
      const key = head.toLowerCase();
      if (Object.prototype.hasOwnProperty.call(tokens, key)) {
        const t = tokens[key];
        const v = typeof t === 'function' ? t(parts.slice(1)) : t;
        return v != null ? String(v) : all;
      }
      const v = resolveField(o.model, head, parts.slice(1));
      return v != null ? v : all;
    });
  }

  /** Tokens in a text that match nothing: ['{Sals}', '<Yeer>']. */
  function unknownWith (text, opts) {
    const o = opts || {};
    const tokens = o.tokens || {};
    const out = [];
    String(text == null ? '' : text).replace(TOKEN, function (all, brace, angle) {
      if (angle != null) { if (!o.params || o.params(angle) == null) out.push(all); return all; }
      const parts = brace.split('|');
      const head = parts[0].trim();
      if (Object.prototype.hasOwnProperty.call(tokens, head.toLowerCase())) return all;
      if (resolveField(o.model, head, parts.slice(1)) == null) out.push(all);
      return all;
    });
    return out;
  }

  function paramKey (name) {
    return String(name || '').trim().replace(/^\[?parameters\]?\./i, '').replace(/^\[|\]$/g, '').toLowerCase();
  }

  function lookupIn (list) {
    return function (name) {
      const k = paramKey(name);
      const p = (list || []).find(function (x) { return String(x.name).toLowerCase() === k; });
      return p ? p.value : null;
    };
  }

  // ---------------------------------------------------------------------------
  // Chart side: one extension per page, so one state
  // ---------------------------------------------------------------------------
  const S = { worksheet: null, onChange: null, table: null, model: null, params: null, loading: null, watched: {}, dialog: null };

  function init (o) {
    if (o && o.worksheet) S.worksheet = o.worksheet;
    if (o && o.onChange) S.onChange = o.onChange;
  }

  function setTable (table) { S.table = table; S.model = null; }

  function model () {
    if (!S.model) S.model = buildModel(S.table);
    return S.model;
  }

  function setParams (list) {
    S.params = (list || []).map(function (p) { return { name: String(p.name), value: p.value == null ? '' : String(p.value) }; });
  }

  function loadParams () {
    if (S.loading) return S.loading;
    const ws = S.worksheet;
    if (!ws || !ws.getParametersAsync) { if (!S.params) S.params = []; return Promise.resolve(); }
    const before = JSON.stringify(S.params);
    S.loading = Promise.resolve().then(function () { return ws.getParametersAsync(); }).then(function (list) {
      const next = [];
      (list || []).forEach(function (p) {
        const cv = p.currentValue || {};
        next.push({ name: String(p.name), value: cv.formattedValue != null ? String(cv.formattedValue) : String(cv.value) });
        const id = p.id || p.name;
        const T = root.tableau && root.tableau.TableauEventType;
        if (!S.watched[id] && p.addEventListener && T && T.ParameterChanged) {
          S.watched[id] = true;
          p.addEventListener(T.ParameterChanged, function () { loadParams(); });
        }
      });
      S.params = next;
    }).catch(function (e) {
      if (!S.params) S.params = [];
      console.info('Title text: parameters not available', e && e.message);
    }).then(function () {
      S.loading = null;
      if (JSON.stringify(S.params) !== before && S.onChange) {
        try { S.onChange(); } catch (e) { console.warn('Title text: repaint failed', e && e.message); }
      }
    });
    return S.loading;
  }

  /** Text for the header. Asks Tableau for parameters the first time a text needs one. */
  function fill (text, opts) {
    const o = Object.assign({}, opts || {});
    const s = String(text == null ? '' : text);
    if (!/[{<]/.test(s)) return s;
    if (!o.params) {
      if (!S.params && /<[^<>]+>/.test(s)) loadParams();
      o.params = lookupIn(S.params || []);
    }
    o.model = model();
    return fillWith(s, o);
  }

  function ready (worksheet) {
    if (worksheet) S.worksheet = worksheet;
    if (S.params) return Promise.resolve();
    // never hold the Format dialog back for long: it opens without the list after 1.5 s
    return Promise.race([loadParams(), new Promise(function (resolve) { setTimeout(resolve, 1500); })]).catch(function () { /* the dialog opens anyway */ });
  }

  /** What the Format dialog lists: fields (30 values each at most) and parameters. */
  function dialogInfo () {
    return {
      fields: model().fields.map(function (f) {
        const o = { name: f.name, keys: f.keys, kind: f.kind, agg: f.agg, values: f.values.slice(0, 30), count: f.count, lastValue: f.lastValue };
        if (f.stats) o.stats = f.stats;
        return o;
      }),
      params: (S.params || []).slice()
    };
  }

  function addInfo (payload) {
    try {
      const p = typeof payload === 'string' ? JSON.parse(payload || '{}') : (payload || {});
      p.textInfo = dialogInfo();
      return JSON.stringify(p);
    } catch (e) {
      return payload;
    }
  }

  // ---------------------------------------------------------------------------
  // Dialog side
  // ---------------------------------------------------------------------------
  function readPayload (payload) {
    try {
      const p = typeof payload === 'string' ? JSON.parse(payload || '{}') : (payload || {});
      S.dialog = p.textInfo || null;
    } catch (e) { S.dialog = null; }
    return dialogData();
  }

  function dialogData () {
    const d = S.dialog || {};
    // JSON turns NaN into null: read the stats back as numbers
    const fields = (d.fields || []).map(function (f) {
      if (!f.stats) return f;
      const st = {};
      Object.keys(f.stats).forEach(function (k) { st[k] = f.stats[k] == null ? NaN : f.stats[k]; });
      return Object.assign({}, f, { stats: st });
    });
    return { fields: fields, params: d.params || [], known: !!S.dialog };
  }

  function dialogOpts (opts) {
    const d = dialogData();
    return Object.assign({ model: { fields: d.fields }, params: lookupIn(d.params) }, opts || {});
  }

  function preview (text, opts) { return fillWith(text, dialogOpts(opts)); }
  function unknown (text, opts) { return unknownWith(text, dialogOpts(opts)); }

  const api = {
    STATS: STATS,
    buildModel: buildModel, findField: findField, parseMods: parseMods, formatNumber: formatNumber,
    fillWith: fillWith, unknownWith: unknownWith, lookupIn: lookupIn,
    init: init, setTable: setTable, model: model, setParams: setParams, loadParams: loadParams,
    fill: fill, ready: ready, dialogInfo: dialogInfo, addInfo: addInfo,
    readPayload: readPayload, dialogData: dialogData, preview: preview, unknown: unknown,
    _state: S
  };

  root.ExtText = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
