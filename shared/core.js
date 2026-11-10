'use strict';

/**
 * ExtCore — helpers every extension uses, in one place.
 *
 * Loaded by every index.html and configure.html before the extension's own
 * config.js. Nothing here knows about a particular chart: no DOM ids, no
 * settings keys. A change here changes all extensions, so every function is
 * covered by tests/core.test.js — run `npm test` before committing.
 *
 *   Text / colour   esc, clone, normalizeHex, rgb, rgba, toHex, mix, tint, fontStack
 *   Settings        isMap, merge
 *   Numbers         SCALES, pickScale, fixed, formatScaled, toNumber
 *   Columns         isMN, isNumericCol, norm, nameParts, cleanName, findColumn
 *   Tableau data    readSummary (row limit), rowNotice
 *   Tableau marks   select, clearSelection, hoverTooltip
 */
(function (root) {
  // ---------------------------------------------------------------------------
  // Text and colour
  // ---------------------------------------------------------------------------
  /** Escapes a value for use in HTML text or a double-quoted attribute. */
  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function clone (o) { return JSON.parse(JSON.stringify(o)); }

  /** '#abc' / 'AABBCC' → '#AABBCC'; anything else → null. */
  function normalizeHex (value) {
    if (typeof value !== 'string') return null;
    let hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/(.)/g, '$1$1');
    return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : null;
  }

  function rgb (hex) {
    const h = normalizeHex(hex) || '#000000';
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function rgba (hex, alpha) {
    const c = rgb(hex);
    return 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + alpha + ')';
  }

  function toHex (c) {
    return '#' + c.map(function (x) {
      return ('0' + Math.max(0, Math.min(255, Math.round(x))).toString(16)).slice(-2);
    }).join('').toUpperCase();
  }

  /** Colour between a (t = 0) and b (t = 1). */
  function mix (a, b, t) {
    const x = rgb(a);
    const y = rgb(b);
    return toHex([0, 1, 2].map(function (i) { return x[i] + (y[i] - x[i]) * t; }));
  }

  /** Lighter version of a colour: t = 0 keeps it, t = 1 is white. */
  function tint (hex, t) { return mix(hex, '#FFFFFF', t); }

  const FONT_STACK_FALLBACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

  function fontStack (family) {
    if (!family) return FONT_STACK_FALLBACK;
    return '"' + String(family).replace(/"/g, '') + '", ' + FONT_STACK_FALLBACK;
  }

  // ---------------------------------------------------------------------------
  // Settings: saved settings merged over DEFAULTS
  // ---------------------------------------------------------------------------
  /** An empty object in DEFAULTS is a free-form map (keyed by pill / member name). */
  function isMap (o) { return !!o && typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length; }

  /**
   * Deep merge of saved settings over defaults. Only keys that exist in the
   * defaults are kept, so settings written by a newer or older version can
   * never break loading:
   *   - free-form map ({} in the defaults): the saved object replaces it
   *   - list: the saved list replaces it (only if it is a list)
   *   - object: merged key by key
   *   - value: taken when its type matches the default (or the default is '' / null)
   */
  function merge (base, over) {
    const out = clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(out).forEach(function (k) {
      if (!(k in over)) return;
      if (isMap(out[k])) {
        if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) out[k] = clone(over[k]);
      } else if (Array.isArray(out[k])) {
        if (Array.isArray(over[k])) out[k] = clone(over[k]);
      } else if (out[k] && typeof out[k] === 'object') {
        out[k] = merge(out[k], over[k]);
      } else if (typeof over[k] === typeof out[k] || out[k] === '' || out[k] == null) {
        out[k] = over[k];
      }
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Numbers
  // ---------------------------------------------------------------------------
  const SCALES = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };

  /** The suffix for a value: 'dynamic' picks by size, 'K' / 'M' / 'B' / 'T' are fixed, anything else none. */
  function pickScale (value, scale) {
    if (scale === 'dynamic') {
      const a = Math.abs(value);
      return a >= 1e12 ? 'T' : a >= 1e9 ? 'B' : a >= 1e6 ? 'M' : a >= 1e3 ? 'K' : '';
    }
    return SCALES[scale] ? scale : '';
  }

  const NF_CACHE = {}; // Intl.NumberFormat is slow to create: one per (decimals, grouping)

  /** Fixed decimals with thousands separators (thousands === false switches them off). */
  function fixed (n, decimals, thousands) {
    const d = Math.max(0, Math.min(10, Number(decimals) || 0));
    const key = d + (thousands !== false ? 'g' : 'n');
    try {
      const nf = NF_CACHE[key] || (NF_CACHE[key] = new Intl.NumberFormat('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d,
        useGrouping: thousands !== false
      }));
      return nf.format(n);
    } catch (e) {
      return n.toFixed(d);
    }
  }

  /** 1234567 → '1.23M'. forceScale ('' / 'K' / …) overrides the scale picked from `scale`. */
  function formatScaled (value, scale, decimals, forceScale, thousands) {
    if (!isFinite(value)) return '—';
    const suffix = forceScale != null ? forceScale : pickScale(value, scale);
    const divisor = SCALES[suffix] || 1;
    let text = fixed(value / divisor, decimals, thousands);
    if (/^-[0.,]+$/.test(text)) text = text.slice(1); // never "-0.00"
    return text + suffix;
  }

  /** A Tableau data cell → number (NaN for nulls and blanks). */
  function toNumber (cell) {
    if (!cell) return NaN;
    const v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v === null || v === '%null%' || v === '') return NaN;
    return typeof v === 'number' ? v : Number(v);
  }

  // ---------------------------------------------------------------------------
  // Columns: matching Marks card pills to summary data columns
  // ---------------------------------------------------------------------------
  function isMN (c) { return /^measure (names|values)$/i.test(String((c && c.fieldName) || '')); }

  function isNumericCol (c) { return /^(float|int|real|integer|number|double)$/i.test(String((c && c.dataType) || '')); }

  /** 'SUM(Sales)' → 'sales': the name without its aggregation, for comparing. */
  function norm (s) {
    return String(s || '').trim().replace(/^[A-Z_]+\((.*)\)$/i, '$1').trim().toLowerCase();
  }

  /** 'Field // Shown name' → both halves, normalised (the shown name first). */
  function nameParts (s) {
    const str = String(s || '');
    const i = str.indexOf('//');
    if (i < 0) return [norm(str)];
    return [norm(str.slice(i + 2)), norm(str.slice(0, i))].filter(Boolean);
  }

  const DATE_PARTS = {
    YEAR: 'Year', QUARTER: 'Quarter', MONTH: 'Month', WEEK: 'Week', DAY: 'Day', WEEKDAY: 'Weekday', HOUR: 'Hour',
    TYR: 'Year', TQR: 'Quarter', TMN: 'Month', TWK: 'Week', TDY: 'Day', MY: 'Month', QY: 'Quarter', MDY: 'Day'
  };
  const AGG = /^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|ATTR|STDEV|VAR)\((.*)\)$/i;

  /**
   * The name to show for a pill: 'SUM(Sales)' → 'Sales', 'MONTH(Order Date)' →
   * 'Month of Order Date'. opts.alias: 'Field // Shown name' → 'Shown name'.
   */
  function cleanName (name, opts) {
    const s = String(name || '');
    if (opts && opts.alias) {
      const i = s.indexOf('//');
      if (i >= 0 && s.slice(i + 2).trim()) return s.slice(i + 2).trim();
    }
    const m = /^([A-Z]+)\((.*)\)$/i.exec(s);
    if (m && DATE_PARTS[m[1].toUpperCase()]) return DATE_PARTS[m[1].toUpperCase()] + ' of ' + m[2];
    return s.replace(AGG, '$2');
  }

  /**
   * The summary data column for a Marks card field: by field id, then exact
   * name, then name without aggregation, then either half of 'a // b'.
   * `taken` columns are skipped. Measure Names / Measure Values columns are
   * skipped unless opts.measureNames is true.
   */
  function findColumn (table, field, taken, opts) {
    if (!field || !table || !table.columns) return null;
    const used = taken || [];
    const keepMN = !!(opts && opts.measureNames);
    const cols = table.columns.filter(function (c) { return used.indexOf(c) < 0 && (keepMN || !isMN(c)); });
    const fid = field.id || field.fieldId;
    const fn = nameParts(field.name);
    return cols.find(function (c) { return fid && c.fieldId && c.fieldId === fid; }) ||
      cols.find(function (c) { return c.fieldName === field.name; }) ||
      cols.find(function (c) { return norm(c.fieldName) === norm(field.name); }) ||
      cols.find(function (c) {
        const cn = nameParts(c.fieldName);
        return cn.some(function (x) { return x && fn.indexOf(x) >= 0; });
      }) ||
      null;
  }

  // ---------------------------------------------------------------------------
  // Tableau data: summary data with a row limit
  // ---------------------------------------------------------------------------
  const DEFAULT_MAX_ROWS = 1000;
  const SINGLE_CALL_MAX = 10000; // getSummaryDataAsync returns at most this many rows

  /** The row limit from settings: a whole number ≥ 0 (0 = no limit); bad values → the default. */
  function rowLimit (value) {
    const n = Number(value);
    if (value === '' || value == null || !isFinite(n) || n < 0) return DEFAULT_MAX_ROWS;
    return Math.floor(n);
  }

  /**
   * Reads the worksheet's summary data, at most `opts.limit` rows (0 = all).
   * Returns { columns, data, truncated, limit }. `truncated` is true when the
   * worksheet has more rows than the limit; show it with rowNotice().
   * opts.columnsToIncludeById is passed through to Tableau.
   *
   * Up to 10,000 rows this is one call to Tableau (calls are answered one at
   * a time for the whole dashboard, so fewer calls load faster); above that
   * the paged reader is used and always released.
   */
  async function readSummary (worksheet, opts) {
    const o = opts || {};
    const limit = rowLimit(o.limit);
    const base = { ignoreSelection: true };
    if (o.columnsToIncludeById) base.columnsToIncludeById = o.columnsToIncludeById;

    if (limit > 0 && limit < SINGLE_CALL_MAX && worksheet.getSummaryDataAsync) {
      const t = await worksheet.getSummaryDataAsync(Object.assign({ maxRows: limit + 1 }, base));
      const rows = t.data || [];
      return { columns: t.columns, data: rows.length > limit ? rows.slice(0, limit) : rows, truncated: rows.length > limit, limit: limit };
    }

    const reader = await worksheet.getSummaryDataReaderAsync(undefined, base);
    try {
      if (!limit) {
        const all = await reader.getAllPagesAsync();
        return { columns: all.columns, data: all.data || [], truncated: false, limit: 0 };
      }
      let columns = null;
      let data = [];
      for (let p = 0; p < reader.pageCount && data.length <= limit; p++) {
        const page = await reader.getPageAsync(p);
        columns = columns || page.columns;
        data = data.concat(page.data || []);
      }
      const total = reader.totalRowCount != null ? reader.totalRowCount : data.length;
      return { columns: columns || [], data: data.slice(0, limit), truncated: total > limit || data.length > limit, limit: limit };
    } finally {
      await reader.releaseAsync();
    }
  }

  /**
   * Shows (or hides) the small "first N rows" note in the bottom-left corner.
   * Pass the result of readSummary(); anything not truncated hides the note.
   */
  function rowNotice (table) {
    if (typeof document === 'undefined' || !document.body) return;
    let n = document.getElementById('ext-row-notice');
    if (!table || !table.truncated) {
      if (n) n.hidden = true;
      return;
    }
    if (!n) {
      n = document.createElement('div');
      n.id = 'ext-row-notice';
      n.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:40;max-width:calc(100% - 12px);padding:3px 8px;border-radius:10px;' +
        'background:rgba(255,247,237,.96);border:1px solid #FDBA74;color:#9A3412;font:500 11px/1.4 ' + FONT_STACK_FALLBACK + ';' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:auto;cursor:default';
      document.body.appendChild(n);
    }
    n.textContent = 'Showing the first ' + fixed(table.limit, 0) + ' rows';
    n.title = 'This worksheet has more rows than the limit. Raise or remove it in Format Extension → Card → Maximum rows.';
    n.hidden = false;
  }

  // ---------------------------------------------------------------------------
  // Tableau marks: selection (dashboard actions) and Tableau's own tooltip
  // ---------------------------------------------------------------------------
  /**
   * Selects marks in Tableau so dashboard filter / highlight / go-to actions
   * fire. `selections` is [{ fieldName, value: [v, …] }] (or a range value
   * { min, max }). Empty → nothing happens. Never throws: Tableau versions
   * without the call, and rejected selections, are logged and ignored.
   * Returns true when the request was sent.
   */
  function select (worksheet, selections, label) {
    try {
      const sel = (selections || []).filter(function (s) { return s && s.fieldName && s.value != null; });
      if (!worksheet || !worksheet.selectMarksByValueAsync || !sel.length) return false;
      const T = root.tableau || {};
      const type = T.SelectionUpdateType ? T.SelectionUpdateType.Replace : 'select-replace';
      worksheet.selectMarksByValueAsync(sel, type).catch(function (err) {
        console.info((label || 'Extension') + ': selection not applied', err && err.message);
      });
      return true;
    } catch (e) {
      return false;
    }
  }

  function clearSelection (worksheet) {
    try {
      if (worksheet && worksheet.clearSelectedMarksAsync) worksheet.clearSelectedMarksAsync().catch(function () {});
    } catch (e) { /* not supported */ }
  }

  /**
   * Tableau's own tooltip (the one edited in Worksheet → Tooltip, including
   * viz-in-tooltip) for one summary data row. `rowIndex` is the row's position
   * in the summary data exactly as Tableau sent it (0-based, before any
   * reversing or sorting); null hides the tooltip. `point` is { x, y } in the
   * extension frame. Returns false when this Tableau version has no
   * hoverTupleAsync, so the caller falls back to the extension's own tooltip.
   */
  function hoverTooltip (worksheet, rowIndex, point) {
    try {
      if (!worksheet || !worksheet.hoverTupleAsync) return false;
      const show = rowIndex != null && rowIndex >= 0;
      const ctx = show && point ? { tooltipAnchorPoint: { x: Math.round(point.x), y: Math.round(point.y) } } : null;
      worksheet.hoverTupleAsync(show ? rowIndex + 1 : 0, ctx).catch(function () {}); // tuple ids are 1-based; 0 = none
      return true;
    } catch (e) {
      return false;
    }
  }

  const api = {
    esc: esc, clone: clone, normalizeHex: normalizeHex, rgb: rgb, rgba: rgba, toHex: toHex, mix: mix, tint: tint,
    FONT_STACK_FALLBACK: FONT_STACK_FALLBACK, fontStack: fontStack,
    isMap: isMap, merge: merge,
    SCALES: SCALES, pickScale: pickScale, fixed: fixed, formatScaled: formatScaled, toNumber: toNumber,
    isMN: isMN, isNumericCol: isNumericCol, norm: norm, nameParts: nameParts, DATE_PARTS: DATE_PARTS, cleanName: cleanName, findColumn: findColumn,
    DEFAULT_MAX_ROWS: DEFAULT_MAX_ROWS, rowLimit: rowLimit, readSummary: readSummary, rowNotice: rowNotice,
    select: select, clearSelection: clearSelection, hoverTooltip: hoverTooltip
  };

  root.ExtCore = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
