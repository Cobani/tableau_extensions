'use strict';

/**
 * Waterfall — Tableau Viz Extension.
 *
 * Marks card tiles (declared in waterfall.trex):
 *   start      Start value (1 measure)
 *   steps      Changes: any number of measures, dropped one by one. The bars
 *              follow the order of the pills on the tile.
 *   end        End value (1 measure). Empty → Start + changes (optional).
 *   breakdown  Optional dimension that splits each change bar into segments.
 *
 * Header (icon, title, explanation) and card options are the same as KPI
 * Card 3. Everything else is set in the Format dialog (configure.html),
 * which also opens from a right-click on a bar.
 */
(function () {
  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null; // see extract()
  var drawn = [];   // bars as drawn: { bar, x, w, yTop, yBottom }
  var renderToken = 0;
  var clipSeq = 0;
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'plot', 'svg', 'hint', 'tooltip', 'menu'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.svg.addEventListener('mousemove', onHover);
    el.svg.addEventListener('mouseleave', hideTooltip);
    el.svg.addEventListener('contextmenu', onContextMenu);
    el.svg.addEventListener('dblclick', function (e) {
      var b = barFromEvent(e);
      if (b) openDialog({ tab: 'bars', bar: b.key });
    });
    document.addEventListener('mousedown', function (e) {
      if (!el.menu.contains(e.target)) hideMenu();
    });
    window.addEventListener('blur', hideMenu);

    if (window.ExtTiming) ExtTiming.mark('initializeAsync start');
    return tableau.extensions.initializeAsync({ configure: function () { return openDialog(null); } }).then(function () {
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Wf.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          cfg = Wf.read();
          reconcileKeys();
          // Just switched on "ignore the Breakdown": fetch Start / End without it.
          if (cfg.bars.balanceIgnoreBreakdown && model && model.balanceCols && !model.balanceTried) refresh();
          else paint();
        }
      );

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      console.error('Waterfall failed to initialize:', err);
      showEmpty('Could not initialize the extension. See the console for details.');
    });
  }

  var queued = false;
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; paint(); });
  }

  /**
   * Opens the Format dialog. `focus` ({ tab, bar }) preselects a tab and a
   * bar. The dialog gets the current bars and breakdown members as payload,
   * because it can't read the worksheet itself.
   */
  function openDialog (focus) {
    hideMenu();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify({
      focus: focus || null,
      bars: model ? allBars().map(function (b) {
        // rows: the step's value per Breakdown combination, so the dialog can list the top members + Others
        return { key: b.key, kind: b.kind, name: b.name, sign: b.neg || b.v < 0 ? -1 : 1, rows: b.rows || [] };
      }) : [],
      dims: model ? model.dims : [],
      combos: model ? model.combos : [],
      hasBreakdown: !!(model && model.dims.length)
    });
    var options = { width: 600, height: 760 };
    // Modal keeps the Format window in front of Tableau until Done; the chart behind it still updates live.
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) options.dialogStyle = tableau.DialogStyle.Modal;
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Waterfall dialog:', err && err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Last-render cache: on load, draw the previous result straight away (right
  // after the Tableau handshake), then replace it with the live data. Stored in
  // this browser only (localStorage), per worksheet, and only reused when the
  // same fields are on the Marks card. Any storage error just skips the cache.
  // ---------------------------------------------------------------------------
  var CACHE_PREFIX = 'waterfall:lastRender:v1:';
  var CACHE_MAX_AGE = 30 * 24 * 3600 * 1000; // 30 days
  var CACHE_MAX_CHARS = 400000;
  var cacheTried = false;

  function cacheKey () {
    var host = '';
    try { host = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { /* ignore */ }
    return CACHE_PREFIX + host + '|' + (worksheet && worksheet.name);
  }

  /** Identifies what's on the Marks card, so a cache is only used for the same setup. */
  function fieldsSig (fields) {
    var out = {};
    Object.keys(fields).sort().forEach(function (k) {
      out[k] = fields[k].map(function (f) { return (f.id || '') + '|' + (f.name || ''); });
    });
    return JSON.stringify(out);
  }

  // JSON keeps Dates and NaN/Infinity intact.
  function enc (k, v) {
    var raw = this[k];
    if (raw instanceof Date) return { $d: raw.getTime() };
    if (typeof raw === 'number' && !isFinite(raw)) return { $n: String(raw) };
    return v;
  }
  function dec (k, v) {
    if (v && typeof v === 'object') {
      if (Object.prototype.hasOwnProperty.call(v, '$d')) return new Date(v.$d);
      if (Object.prototype.hasOwnProperty.call(v, '$n')) return Number(v.$n);
    }
    return v;
  }

  /** The saved result for this worksheet, if fresh: { sig, data }. */
  function readCacheEntry () {
    try {
      var s = window.localStorage.getItem(cacheKey());
      if (!s) return null;
      var c = JSON.parse(s, dec);
      if (!c || !c.data || !(Date.now() - c.t < CACHE_MAX_AGE)) return null;
      return c;
    } catch (e) { return null; }
  }

  function writeCache (fields, data) {
    try {
      var s = JSON.stringify({ sig: fieldsSig(fields), t: Date.now(), data: data }, enc);
      // Too big to keep: drop the old entry too, so a stale drawing isn't shown on the next load.
      if (s.length > CACHE_MAX_CHARS) { clearCache(); return; }
      try {
        window.localStorage.setItem(cacheKey(), s);
      } catch (full) {
        // Storage full: drop this extension's old entries and try once more.
        for (var i = window.localStorage.length - 1; i >= 0; i--) {
          var k = window.localStorage.key(i);
          if (k && k.indexOf(CACHE_PREFIX) === 0) window.localStorage.removeItem(k);
        }
        window.localStorage.setItem(cacheKey(), s);
      }
    } catch (e) { /* ignore */ }
  }

  function clearCache () {
    try { window.localStorage.removeItem(cacheKey()); } catch (e) { /* ignore */ }
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      // Ask Tableau for the encodings and the data at the same time (one round trip instead of two).
      // A data error only matters when fields are encoded, so it is held until then.
      var tFields = 0;
      var tData = 0;
      var fieldsP = getEncodedFields().then(function (r) { tFields = ms(); if (first) T.mark('fields received (Marks card)'); return r; });
      var dataP = readSummaryData().then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });

      // First load: draw the last result from cache right after the handshake,
      // while Tableau is still working on the fields and the data. If the fields
      // on the Marks card turn out to be different, the cached drawing is removed.
      if (!cacheTried) {
        cacheTried = true;
        var entry = readCacheEntry();
        if (entry && !model) {
          model = entry.data;
          try { paint(); T.mark('cached result drawn'); } catch (e) { model = null; entry = null; }
        }
        if (entry) {
          fieldsP.then(function (f) {
            if (token !== renderToken || model !== entry.data || entry.sig === fieldsSig(f)) return;
            model = null;
            showEmpty('');
            T.mark('cached result removed (fields changed)');
          }).catch(function () { /* handled below */ });
        }
      }

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== renderToken) return;
      var fields = results[0];

      if (!fields.start.length && !fields.steps.length && !fields.end.length) {
        model = null;
        clearCache();
        if (first) { T.mark('no fields on the Marks card'); T.done('Waterfall load timings'); }
        showEmpty('Drag measures onto <b>Start</b>, <b>Changes</b> (one at a time) and <b>End</b>.<br>' +
          'Add a dimension to <b>Breakdown</b> to split the change bars.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      model = extract(table, fields);
      reconcileKeys();
      await fetchBalances(token);
      if (token !== renderToken) return;
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Waterfall load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
      writeCache(fields, model);
    } catch (err) {
      console.error('Waterfall render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Waterfall load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. See the console for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = { start: [], steps: [], end: [], breakdown: [] };
    marks.encodings.forEach(function (enc) {
      if (!enc.field) return;
      (fields[enc.id] = fields[enc.id] || []).push(enc.field);
    });
    return fields;
  }

  /**
   * "Start and End ignore the Breakdown": ask Tableau for only the Start / End
   * columns. If Tableau aggregates them without the Breakdown dimensions (one
   * row), that's the exact value, the same as with no Breakdown on the Marks
   * card. Otherwise the value-once rule in extract() is used.
   */
  async function fetchBalances (token) {
    var bc = model && model.balanceCols;
    if (!bc || !cfg.bars.balanceIgnoreBreakdown) return;
    model.balanceTried = true;
    var ids = [bc.start, bc.end].filter(Boolean);
    if (!ids.length) return;
    try {
      var t = await readSummaryData({ columnsToIncludeById: ids });
      if (token !== renderToken) return;
      var rows = (t && t.data) || [];
      console.info('Waterfall: Start/End without the Breakdown: ' + rows.length + ' row(s)' +
        (rows.length === 1 ? ' — using it.' : ' — Tableau kept the Breakdown, using the value-once rule.'));
      if (rows.length !== 1) return;
      ['start', 'end'].forEach(function (k) {
        if (!bc[k] || !model[k]) return;
        var col = t.columns.find(function (c) { return c.fieldId === bc[k]; });
        if (!col) return;
        var cell = rows[0][col.index];
        var v = toNumber(cell);
        if (isFinite(v)) model[k].once = { raw: v, fv: cell.formattedValue, varies: false, exact: true };
      });
    } catch (e) {
      console.info('Waterfall: Start/End without the Breakdown not available:', e && e.message);
    }
  }

  async function readSummaryData (extra) {
    var opts = { ignoreSelection: true };
    if (extra) Object.keys(extra).forEach(function (k) { opts[k] = extra[k]; });
    var reader = await worksheet.getSummaryDataReaderAsync(undefined, opts);
    try {
      return await reader.getAllPagesAsync();
    } finally {
      await reader.releaseAsync();
    }
  }

  function norm (s) {
    return String(s || '').replace(/^[A-Z_]+\((.*)\)$/i, '$1').trim().toLowerCase();
  }

  /** Name without an inline-calculation comment: "SUM([X]) //New name" → both parts. */
  function nameParts (s) {
    var str = String(s || '');
    var i = str.indexOf('//');
    if (i < 0) return [norm(str)];
    return [norm(str.slice(i + 2)), norm(str.slice(0, i))].filter(Boolean);
  }

  function isMN (c) { return /^measure (names|values)$/i.test(c.fieldName); }
  function isNumericCol (c) { return /^(float|int|real|integer|number)$/i.test(String(c.dataType || '')); }

  /** Column for a field by id or name (exact, without aggregation, or around a // comment). */
  function findColumn (table, field, taken) {
    if (!field) return null;
    var cols = table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    var fid = field.id || field.fieldId;
    var fn = nameParts(field.name);
    return cols.find(function (c) { return fid && c.fieldId && c.fieldId === fid; }) ||
      cols.find(function (c) { return c.fieldName === field.name; }) ||
      cols.find(function (c) { return norm(c.fieldName) === norm(field.name); }) ||
      cols.find(function (c) {
        var cn = nameParts(c.fieldName);
        return cn.some(function (x) { return fn.indexOf(x) >= 0; });
      }) ||
      null;
  }

  /**
   * Fields that couldn't be matched by id or name get the columns nobody else
   * took, in order: dimensions prefer text/date columns, measures numeric ones.
   * This happens when a pill is renamed (double-click, "//New name"): Tableau
   * then reports the field and its data column under different names.
   */
  function matchLeftovers (table, reqs, taken, pivoted) {
    var free = function () {
      return table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    };
    var take = function (r, c) { if (c) { r.col = c; taken.push(c); r.guessed = true; } };
    // 1. dimensions → text / date columns
    reqs.forEach(function (r) {
      if (!r.col && r.dim) take(r, free().find(function (x) { return !isNumericCol(x); }));
    });
    // 2. measures → numeric columns (not when they come as Measure Names / Values)
    if (!pivoted) {
      reqs.forEach(function (r) {
        if (!r.col && !r.dim) take(r, free().find(isNumericCol));
      });
    }
    // 3. anything left (numeric dimensions, columns without a data type) → in order
    reqs.forEach(function (r) {
      if (!r.col && (r.dim || !pivoted)) take(r, free()[0]);
    });
    var guessed = reqs.filter(function (r) { return r.guessed; });
    if (guessed.length) {
      console.info('Waterfall: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  function toNumber (cell) {
    if (!cell) return NaN;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v === null || v === '%null%' || v === '') return NaN;
    return typeof v === 'number' ? v : Number(v);
  }

  function cleanName (name) {
    return String(name || '').replace(/^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|ATTR)\((.*)\)$/i, '$2');
  }

  /**
   * Summary data → { start, steps: [...], end, members }.
   * Each measure is summed per breakdown member (rows) and in total.
   * If Tableau delivers several measures as Measure Names / Measure Values,
   * those are pivoted back into one value per measure.
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var cMN = table.columns.find(function (c) { return /^measure names$/i.test(c.fieldName); });
    var cMV = table.columns.find(function (c) { return /^measure values$/i.test(c.fieldName); });

    // Match every field to its column: first by id / name, then the leftovers by position.
    var bReqs = fields.breakdown.map(function (f) { return { field: f, dim: true, col: null }; });
    function measure (field, kind, key) {
      return { field: field, col: null, kind: kind, key: key, name: cleanName(field.name), total: 0, n: 0, fv: null, per: {} };
    }
    var ms = [];
    if (fields.start[0]) ms.push(measure(fields.start[0], 'start', '__start'));
    var seen = {};
    fields.steps.forEach(function (f) {
      var key = f.name;
      while (seen[key]) key += '+'; // the same field twice
      seen[key] = true;
      ms.push(measure(f, 'step', key));
    });
    if (fields.end[0]) ms.push(measure(fields.end[0], 'end', '__end'));

    var reqs = bReqs.concat(ms);
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    matchLeftovers(table, reqs, taken, !!(cMN && cMV));

    var cBrk = [];
    var fBrk = [];
    bReqs.forEach(function (r) { if (r.col) { cBrk.push(r.col); fBrk.push(r.field); } });

    // Distinct combinations of the Breakdown values, in data order.
    var combos = [];
    var comboSeen = {};

    rows.forEach(function (r) {
      var vals = cBrk.map(function (c) { return String(r[c.index].formattedValue); });
      var ck = vals.join('\u0001');
      if (cBrk.length && !comboSeen[ck]) { comboSeen[ck] = combos.length + 1; combos.push(vals); }
      var mn = cMN ? norm(r[cMN.index].formattedValue || r[cMN.index].value) : null;
      ms.forEach(function (m) {
        var cell = null;
        if (m.col) cell = r[m.col.index];
        else if (cMN && cMV && (mn === norm(m.field.name) || mn === norm(m.name))) cell = r[cMV.index];
        if (!cell) return;
        var v = toNumber(cell);
        if (!isFinite(v)) return;
        m.total += v;
        m.n++;
        m.fv = m.n === 1 ? cell.formattedValue : null;
        if (m.n === 1) m.fv1 = cell.formattedValue;
        if (cBrk.length) m.per[ck] = (m.per[ck] || 0) + v;
      });
    });

    /**
     * Start / End with a Breakdown: the value once, not summed over the
     * Breakdown members (for LOD / non-additive measures that repeat on every
     * row). The most common value; `varies` when the members disagree.
     */
    function once (m) {
      if (!cBrk.length || m.kind === 'step' || !m.n) return null;
      var count = {};
      Object.keys(m.per).forEach(function (k) { var v = m.per[k]; count[v] = (count[v] || 0) + 1; });
      var vals = Object.keys(count).map(Number);
      vals.sort(function (a, b) { return count[b] - count[a] || Math.abs(b) - Math.abs(a); });
      return { raw: vals[0], fv: vals.length === 1 ? m.fv1 : null, varies: vals.length > 1 };
    }

    function bar (m) {
      return {
        key: m.key, kind: m.kind, name: m.name, raw: m.total, fv: m.fv, found: m.n > 0, once: once(m),
        // one row per Breakdown combination: { c: combo index, raw }
        rows: cBrk.length ? Object.keys(m.per).map(function (k) { return { c: comboSeen[k] - 1, raw: m.per[k] }; }) : []
      };
    }

    return {
      start: ms.filter(function (m) { return m.kind === 'start'; }).map(bar)[0] || null,
      steps: ms.filter(function (m) { return m.kind === 'step'; }).map(bar),
      end: ms.filter(function (m) { return m.kind === 'end'; }).map(bar)[0] || null,
      dims: fBrk.map(function (f) { return { key: f.name, name: cleanName(f.name) }; }),
      dimKeys: fields.breakdown.map(function (f) { return f.name; }), // every Breakdown pill, matched or not
      combos: combos,
      members: combos.map(function (c) { return c.join(' \u00b7 '); }),
      missing: ms.filter(function (m) { return !m.n; }).map(function (m) { return m.name; }),
      // Start / End column ids, for reading them without the Breakdown (fetchBalances)
      balanceCols: cBrk.length && !(cMN && cMV) ? {
        start: (ms.find(function (m) { return m.kind === 'start' && m.col; }) || { col: {} }).col.fieldId || null,
        end: (ms.find(function (m) { return m.kind === 'end' && m.col; }) || { col: {} }).col.fieldId || null
      } : null
    };
  }

  // ---------------------------------------------------------------------------
  // Renamed pills keep their settings
  //
  // Settings are stored by field name (cfg.steps[name], breakdown.dims). When a
  // pill is renamed (double-click → "//New name"), its name changes but its
  // place on the tile doesn't. cfg.layout remembers the names last seen; a
  // name that disappeared while a new one appeared at the same position is a
  // rename, and its settings move to the new name.
  // ---------------------------------------------------------------------------
  function renames (prev, cur) {
    var out = {};
    if (!prev || !prev.length || prev.length !== cur.length) return out;
    var gone = prev.filter(function (k) { return cur.indexOf(k) < 0; });
    var added = cur.filter(function (k) { return prev.indexOf(k) < 0; });
    if (!gone.length || gone.length !== added.length) return out;
    gone.forEach(function (k) {
      var n = cur[prev.indexOf(k)];
      if (added.indexOf(n) >= 0) out[k] = n;
    });
    return out;
  }

  // The last seen layout is kept in this browser (localStorage), not in the
  // workbook: writing workbook settings makes Tableau reload the extension,
  // so saving it on every refresh made the chart reload over and over.
  // The workbook is only written when settings really move to a new name.
  var LAYOUT_PREFIX = 'waterfall:layout:v1:';

  function layoutKey () {
    var host = '';
    try { host = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { /* ignore */ }
    return LAYOUT_PREFIX + host + '|' + (worksheet && worksheet.name);
  }

  function readLayout () {
    try {
      var l = JSON.parse(window.localStorage.getItem(layoutKey()) || 'null');
      if (l && Array.isArray(l.steps) && Array.isArray(l.dims)) return l;
    } catch (e) { /* ignore */ }
    // Layout saved in the workbook by the previous version.
    var c = cfg && cfg.layout;
    return c && Array.isArray(c.steps) && c.steps.length ? c : null;
  }

  function writeLayout (l) {
    try { window.localStorage.setItem(layoutKey(), JSON.stringify(l)); } catch (e) { /* ignore */ }
  }

  /** Applies renames to cfg (in memory); saves the workbook only when settings moved. */
  function reconcileKeys () {
    if (!cfg || !model || !model.steps) return;
    var cur = {
      steps: model.steps.map(function (st) { return st.key; }),
      dims: model.dimKeys || (model.dims || []).map(function (d) { return d.key; })
    };
    var stored = readLayout();
    var prev = stored || cur;
    var moved = false;

    var rs = renames(prev.steps, cur.steps);
    Object.keys(rs).forEach(function (oldK) {
      var newK = rs[oldK];
      if (cfg.steps[oldK] && !cfg.steps[newK]) {
        cfg.steps[newK] = cfg.steps[oldK];
        delete cfg.steps[oldK];
        moved = true;
      }
    });

    var rd = renames(prev.dims, cur.dims);
    if (Object.keys(rd).length) {
      [cfg.stepDefaults].concat(Object.keys(cfg.steps).map(function (k) { return cfg.steps[k]; })).forEach(function (sc) {
        var bd = sc && sc.breakdown;
        if (!bd || !Array.isArray(bd.dims)) return;
        bd.dims = bd.dims.map(function (k) { if (rd[k]) { moved = true; return rd[k]; } return k; });
      });
    }

    if (!stored || JSON.stringify(stored) !== JSON.stringify(cur)) writeLayout(cur);
    if (moved && !recentlySaved(JSON.stringify([rs, rd]))) {
      // Saving only works while authoring; viewers still get the renames in memory.
      try { Wf.write(cfg).catch(function () { /* read-only */ }); } catch (e) { /* read-only */ }
    }
  }

  /** True if the same rename was already saved in the last minute (never save in a loop). */
  function recentlySaved (sig) {
    try {
      var k = 'waterfall:renameSaved';
      var last = JSON.parse(window.sessionStorage.getItem(k) || 'null');
      if (last && last.sig === sig && Date.now() - last.t < 60000) return true;
      window.sessionStorage.setItem(k, JSON.stringify({ sig: sig, t: Date.now() }));
    } catch (e) { /* ignore */ }
    return false;
  }

  /**
   * Breakdown dimensions a bar uses, as indexes into model.dims, in the
   * order its segment names are written. Empty / unknown → all, tile order.
   */
  function dimOrder (bd) {
    var idx = (bd.dims || []).map(function (k) {
      return model.dims.findIndex(function (d) { return d.key === k; });
    }).filter(function (i) { return i >= 0; });
    return idx.length ? idx : model.dims.map(function (d, i) { return i; });
  }

  /** Segment name for one Breakdown combination under a dimension order. */
  function memberName (combo, order, sep) {
    return order.map(function (i) { return combo[i]; }).join(sep == null ? ' \u00b7 ' : sep);
  }

  /** All segment names for a dimension order, in data order (for colours). */
  function memberList (order, sep) {
    var seen = {};
    var out = [];
    model.combos.forEach(function (c) {
      var n = memberName(c, order, sep);
      if (!seen[n]) { seen[n] = 1; out.push(n); }
    });
    return out;
  }

  /** A step's rows summed into segments for its chosen dimensions. */
  function stepSegs (st, sc) {
    if (!st.rows.length) return [];
    var order = dimOrder(sc.breakdown);
    var sums = {};
    st.rows.forEach(function (r) {
      var n = memberName(model.combos[r.c], order, sc.breakdown.sep);
      sums[n] = (sums[n] || 0) + (sc.invert ? -r.raw : r.raw);
    });
    return Wf.topSegments(memberList(order, sc.breakdown.sep).filter(function (n) { return n in sums; })
      .map(function (n) { return { member: n, v: sums[n] }; }));
  }

  // ---------------------------------------------------------------------------
  // Bars: values, levels, settings
  // ---------------------------------------------------------------------------

  /** Bars in drawing order with their resolved settings, values and levels. */
  function allBars () {
    var out = [];
    var level = 0;
    var startBar = balanceBar(model.start);
    if (startBar) {
      var s = cfg.start;
      level = startBar.raw;
      var b1 = decorate(startBar, s, 0, startBar.raw, startBar.raw, s.color);
      b1.varies = startBar.varies;
      out.push(b1);
    }
    sortedSteps().forEach(function (it) {
      var st = it.st;
      var sc = it.sc;
      var v = it.v;
      var color = sc.colorMode === 'custom' ? sc.color : (it.neg ? cfg.bars.negColor : cfg.bars.posColor);
      var b = decorate(st, sc, level, level + v, v, color);
      b.neg = it.neg;
      b.segs = stepSegs(st, sc);
      b.members = b.segs.map(function (sg) { return sg.member; });
      b.rows = st.rows;
      level += v;
      out.push(b);
    });
    var endBar = balanceBar(model.end);
    var calculated = false;
    if (!endBar && cfg.bars.calcEnd && (model.start || model.steps.length)) {
      endBar = { key: '__end', kind: 'end', name: 'End', raw: level, fv: null, rows: [] };
      calculated = true;
    }
    if (endBar) {
      var b2 = decorate(endBar, cfg.end, 0, endBar.raw, endBar.raw, cfg.end.color);
      b2.calculated = calculated;
      b2.varies = endBar.varies;
      b2.expected = level;
      out.push(b2);
    }
    return out;
  }

  /**
   * Start / End as drawn. With "Start and End ignore the Breakdown" on, the
   * value is taken once instead of summed over the Breakdown members.
   */
  function balanceBar (src) {
    if (!src || !cfg.bars.balanceIgnoreBreakdown || !src.once) return src;
    var o = {};
    Object.keys(src).forEach(function (k) { o[k] = src[k]; });
    o.raw = src.once.raw;
    o.fv = src.once.fv;
    o.varies = src.once.varies;
    return o;
  }

  /**
   * Change bars with settings and values, in display order: as on the Marks
   * card, or sorted (Bars → All bars → Sort changes). Start and End never move.
   * "Within groups" sorts each run of grouped bars in place.
   */
  function sortedSteps () {
    var items = model.steps.map(function (st) {
      var sc = Wf.stepCfg(cfg, st.key);
      var v = sc.invert ? -st.raw : st.raw;
      // a change of exactly 0 counts as a decrease when its sign is inverted
      return { st: st, sc: sc, v: v, neg: v < 0 || (v === 0 && !!sc.invert) };
    });
    var cmp = Wf.comparer(cfg.bars.sort, function (it) { return it.v; }, function (it) { return it.st.name; });
    if (!cmp) return items;
    var g = cfg.groups;
    if (cfg.bars.sortScope !== 'groups' || g.mode === 'none') return Wf.sortBy(items, cmp);
    var gid = function (it) {
      if (g.mode === 'sign') return it.neg ? 'neg' : 'pos';
      return it.sc.group && g.custom[it.sc.group] ? 'c:' + it.sc.group : '';
    };
    var out = [];
    var run = [];
    items.forEach(function (it, i) {
      if (run.length && gid(run[0]) !== gid(it)) { out = out.concat(Wf.sortBy(run, cmp)); run = []; }
      run.push(it);
      if (i === items.length - 1) out = out.concat(Wf.sortBy(run, cmp));
    });
    return out;
  }

  function decorate (src, s, from, to, v, color) {
    return {
      key: src.key, kind: src.kind, name: src.name, fv: src.fv,
      label: s.label || src.name, s: s, from: from, to: to, v: v, color: color, segs: [],
      level: src.kind === 'step' ? to : v // where the connector to the next bar starts
    };
  }

  function fmtOf (labelFmt) {
    return cfg.numbers.mode === 'each' && labelFmt ? labelFmt : cfg.format;
  }

  function totalText (b) {
    return Wf.formatNumber(b.v, fmtOf(b.s.total.fmt), { signed: b.kind === 'step', fv: b.fv, zeroSign: b.neg ? -1 : 1 });
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg) return;
    if (!model) return;
    var bars = allBars();
    if (!bars.length) {
      showEmpty('No values to show.');
      return;
    }
    el.card.classList.remove('is-empty');
    hideTooltip();
    paintCard();
    paintHeader(bars);
    drawChart(bars);
  }

  function applyFont (node, f) {
    node.style.fontFamily = Wf.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Wf.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.card.style.borderRightColor = c.divider ? c.dividerColor : 'transparent';
    el.card.style.borderRightWidth = c.divider ? '1px' : '0';
    el.plot.style.marginTop = c.gap + 'px';
  }

  function paintHeader (bars) {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Wf.iconHtml(ic.builtinId, ic.color, iconTarget());
        el.icon.innerHTML = r.html;
        setIconBox(r.w, r.h);
      } else {
        var img = new Image();
        img.alt = '';
        img.onload = function () { sizeImageIcon(img); };
        img.src = ic.dataUrl;
        el.icon.appendChild(img);
        if (img.complete) sizeImageIcon(img);
      }
    }

    applyFont(el.title, cfg.title);
    var first = bars[0];
    var last = bars[bars.length - 1];
    el.title.textContent = cfg.title.text ||
      (bars.length > 1 ? first.label + ' → ' + last.label : first.label);

    var ex = cfg.explanation;
    applyFont(el.explanation, ex);
    el.explanation.textContent = ex.text;
    el.explanation.style.display = ex.show && ex.text ? '' : 'none';
    updateIconSpan();
  }

  function sizeImageIcon (img) {
    var t = iconTarget();
    var w = img.naturalWidth || t;
    var h = img.naturalHeight || t;
    var W, H;
    if (w >= h) { W = t; H = Math.max(1, Math.round(t * h / w)); } else { H = t; W = Math.max(1, Math.round(t * w / h)); }
    img.style.width = W + 'px';
    img.style.height = H + 'px';
    setIconBox(W, H);
  }

  function iconTarget () {
    var n = Number(cfg.icon.size);
    return isFinite(n) && n > 0 ? Math.max(8, Math.min(128, n)) : 24;
  }

  var iconBoxH = 0;
  function setIconBox (w, h) {
    el.icon.style.width = w + 'px';
    el.icon.style.height = h + 'px';
    iconBoxH = h;
    updateIconSpan();
  }

  function updateIconSpan () {
    var head = el.icon.parentNode;
    var titleH = el.title.offsetHeight || 19;
    var hasExplanation = el.explanation.style.display !== 'none';
    head.classList.toggle('icon-span', hasExplanation && iconBoxH > titleH * 1.5);
  }

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------
  var measureCtx = null;
  function textWidth (text, size, weight, family) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = (weight || 400) + ' ' + size + 'px ' + Wf.fontStack(family);
    return measureCtx.measureText(String(text)).width;
  }

  function niceStep (raw) {
    if (!(raw > 0) || !isFinite(raw)) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(raw)));
    var f = raw / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }

  /** Axis range and ticks for the current bars and Axes settings. */
  function scaleFor (bars) {
    var a = cfg.axisY;
    var levels = [];
    bars.forEach(function (b) {
      if (b.kind === 'step') levels.push(b.from, b.to); else levels.push(b.v);
    });
    var lo = Math.min.apply(null, levels);
    var hi = Math.max.apply(null, levels);
    var base = a.base;

    if (base === 'zero') {
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    } else if (base === 'auto') {
      var range = hi - lo || Math.abs(hi) * 0.2 || 1;
      var pad = Math.max(0, Number(a.padding) || 0) / 100 * range;
      if (lo >= 0) lo = Math.max(0, lo - pad);
      else if (hi <= 0) hi = Math.min(0, hi + pad);
      else { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    } else {
      lo = Number(a.manualMin) || 0;
      hi = Math.max(hi, lo);
    }
    if (a.maxMode === 'manual' && Number(a.manualMax) > lo) hi = Number(a.manualMax);
    if (hi === lo) hi = lo + 1;

    var count = Math.max(2, Math.min(12, Number(a.ticks) || 5));
    var step = niceStep((hi - lo) / count);
    var min = base === 'manual' ? lo : Math.floor(lo / step + 1e-9) * step;
    var max = a.maxMode === 'manual' ? hi : Math.ceil(hi / step - 1e-9) * step;
    if (max <= min) max = min + step;
    var ticks = [];
    for (var t = Math.ceil(min / step - 1e-9) * step; t <= max + step * 1e-6; t += step) {
      ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    }
    return { min: min, max: max, step: step, ticks: ticks };
  }

  function axisFmt () {
    return cfg.axisY.useGlobalFormat ? cfg.format : cfg.axisY.fmt;
  }

  /** Wraps `text` into at most `maxLines` lines no wider than `width`. */
  function wrapText (text, width, maxLines, size, weight, family) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var tryLine = cur ? cur + ' ' + words[i] : words[i];
      if (textWidth(tryLine, size, weight, family) <= width || !cur) {
        cur = tryLine;
      } else {
        lines.push(cur);
        cur = words[i];
      }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = ellipsize(lines[maxLines - 1] + '…', width, size, weight, family);
    }
    return lines.map(function (l) { return ellipsize(l, width, size, weight, family); });
  }

  function ellipsize (text, width, size, weight, family) {
    if (textWidth(text, size, weight, family) <= width) return text;
    var t = String(text).replace(/…$/, '');
    while (t.length > 1 && textWidth(t + '…', size, weight, family) > width) t = t.slice(0, -1);
    return t + '…';
  }

  /** Runs of steps that belong to the same group. */
  function groupRuns (bars) {
    var g = cfg.groups;
    if (g.mode === 'none') return [];
    var runs = [];
    var cur = null;
    bars.forEach(function (b, i) {
      var id = null;
      var def = null;
      if (b.kind === 'step') {
        if (g.mode === 'sign') { id = b.neg ? 'neg' : 'pos'; def = g[id]; } else if (b.s.group && g.custom[b.s.group]) { id = b.s.group; def = g.custom[b.s.group]; }
      }
      if (cur && cur.id === id && id) {
        cur.i1 = i; cur.total += b.v;
      } else {
        if (cur && cur.id) runs.push(cur);
        cur = { id: id, def: def, i0: i, i1: i, total: id ? b.v : 0, neg: b.neg };
      }
    });
    if (cur && cur.id) runs.push(cur);
    return runs;
  }

  function node (tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] != null && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  function lineAttrs (l) {
    return { stroke: l.color, 'stroke-width': l.width, 'stroke-dasharray': Wf.dashArray(l.style, l.width), 'shape-rendering': 'crispEdges' };
  }

  /** Segments in the bar's breakdown order (its own, or the All bars one). Used for drawing and the tooltip. */
  function orderedSegs (b) {
    var own = b.s.breakdown && b.s.breakdown.order;
    var o = own && own !== 'inherit' ? own : cfg.bars.breakdownOrder;
    // "Others" (the members past the top ones) always comes last.
    var top = b.segs.filter(function (x) { return !x.others; });
    var rest = b.segs.filter(function (x) { return x.others; });
    return Wf.sortBy(top, Wf.comparer(o, function (x) { return x.v; }, function (x) { return x.member; })).concat(rest);
  }

  /**
   * Segment colours. Shades follow the bar's breakdown order: the first
   * segment gets the bar colour, the last the palest shade. Custom colours
   * stay as picked.
   */
  function segColors (b) {
    var bd = b.s.breakdown;
    var shown = orderedSegs(b).map(function (sg) { return sg.member; });
    var list = shown;
    var all = Wf.shades(b.color, Math.max(1, list.length));
    var map = {};
    list.forEach(function (m, i) {
      map[m] = bd.colorMode === 'custom' && bd.colors[m] ? bd.colors[m] : all[i];
    });
    return map;
  }

  function drawChart (bars) {
    var svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawn = [];
    var W = Math.max(1, el.plot.clientWidth);
    var H = Math.max(1, el.plot.clientHeight);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (W < 40 || H < 40) return;

    var family = cfg.numbers.font;
    var ay = cfg.axisY;
    var ax = cfg.axisX;
    var L = cfg.lines;
    var sc = scaleFor(bars);
    var span = sc.max - sc.min;
    var n = bars.length;

    // ---- margins ----------------------------------------------------------
    var af = axisFmt();
    var maxTick = Math.max.apply(null, sc.ticks.map(Math.abs));
    var force = af.scale === 'dynamic' ? Wf.pickScale(maxTick, 'dynamic')
      : af.scale === 'percentDynamic' ? Wf.pickScale(af.pctFromRatio ? maxTick * 100 : maxTick, 'dynamic') : null;
    // Add decimals until the tick labels are distinct (1.2K, 1.4K rather than 1K, 1K).
    var tickText;
    var afUse = Wf.clone(af);
    for (var dec = af.decimals; dec <= Math.max(af.decimals, 4); dec++) {
      afUse.decimals = dec;
      tickText = sc.ticks.map(function (t) { return Wf.formatNumber(t, afUse, { forceScale: force }); });
      var uniq = {};
      tickText.forEach(function (t) { uniq[t] = 1; });
      if (Object.keys(uniq).length === tickText.length || af.scale === 'workbook') break;
    }
    var tickW = ay.show ? Math.max.apply(null, tickText.map(function (t) { return textWidth(t, ay.size, ay.weight, ay.font); })) : 0;

    var left = ay.show && ay.position === 'left' ? Math.ceil(tickW) + 8 : 4;
    var right = ay.show && ay.position === 'right' ? Math.ceil(tickW) + 8 : 4;

    var aboveRoom = 0;
    bars.forEach(function (b) {
      var t = b.s.total;
      if (!t.show) return;
      if (t.position === 'above' || (t.position === 'end' && b.v >= 0)) aboveRoom = Math.max(aboveRoom, t.size + 6);
    });
    var titleH = ay.show && ay.title ? ay.size + 8 : 0;
    var top = Math.max(aboveRoom, titleH ? titleH + 2 : 0, 4);

    var plotW = Math.max(10, W - left - right);
    var slot = plotW / n;
    var bw = Math.max(2, slot * Math.max(5, Math.min(100, cfg.bars.width)) / 100);

    // x labels
    var xl = [];
    var xlH = 0;
    if (ax.show) {
      var lh = Math.round(ax.size * 1.2);
      if (ax.orientation === 'wrap') {
        xl = bars.map(function (b) { return wrapText(b.label, slot * 0.96, Math.max(1, ax.maxLines), ax.size, ax.weight, ax.font); });
        xlH = Math.max.apply(null, xl.map(function (ls) { return ls.length; })) * lh + 8;
      } else {
        var maxLen = Math.max(30, Math.min(H * 0.32, 180));
        xl = bars.map(function (b) { return [ellipsize(b.label, maxLen, ax.size, ax.weight, ax.font)]; });
        var longest = Math.max.apply(null, xl.map(function (ls) { return textWidth(ls[0], ax.size, ax.weight, ax.font); }));
        xlH = ax.orientation === 'angled' ? longest * Math.sin(Math.PI / 4) + ax.size + 8 : longest + 10;
      }
    }

    var runs = groupRuns(bars);
    var G = cfg.groups;
    var gH = runs.length ? 6 + G.lineWidth + 4 + G.size + 4 : 0;

    // labels below bars need room at the bottom of the plot too
    var belowRoom = 0;
    bars.forEach(function (b) {
      var t = b.s.total;
      if (t.show && (t.position === 'below' || (t.position === 'end' && b.v < 0)) && b.kind !== 'step') belowRoom = Math.max(belowRoom, t.size + 6);
    });

    var plotH = H - top - xlH - gH - belowRoom;
    if (plotH < 30) { gH = 0; runs = []; plotH = H - top - xlH - belowRoom; }
    if (plotH < 20) { xlH = 0; xl = []; plotH = H - top; }
    var bottomY = top + plotH;

    var y = function (v) { return top + (sc.max - v) / span * plotH; };
    var clampY = function (v) { return Math.max(top, Math.min(bottomY, y(v))); };
    var slotX = function (i) { return left + i * slot; };

    // ---- layers -------------------------------------------------------------
    var gBack = node('g'), gGrid = node('g'), gBars = node('g'), gConn = node('g'), gLabels = node('g'), gAxes = node('g');
    [gBack, gGrid, gBars, gConn, gLabels, gAxes].forEach(function (g) { svg.appendChild(g); });
    var defs = node('defs');
    svg.insertBefore(defs, svg.firstChild);

    // group bands
    if (G.band) {
      runs.forEach(function (r) {
        gBack.appendChild(node('rect', {
          x: slotX(r.i0), y: top, width: (r.i1 - r.i0 + 1) * slot, height: plotH,
          fill: r.def.color, 'fill-opacity': Math.max(0, Math.min(100, G.bandOpacity)) / 100
        }));
      });
    }

    // horizontal gridlines + y axis labels
    sc.ticks.forEach(function (t, k) {
      var yy = Math.round(y(t)) + 0.5;
      if (L.hGrid.show && !(t === 0 && L.zero.show)) {
        gGrid.appendChild(node('line', Object.assign({ x1: left, x2: W - right, y1: yy, y2: yy }, lineAttrs(L.hGrid))));
      }
      if (ay.show) {
        gAxes.appendChild(node('text', {
          x: ay.position === 'left' ? left - 8 : W - right + 8, y: yy + ay.size * 0.35,
          'text-anchor': ay.position === 'left' ? 'end' : 'start',
          'font-size': ay.size, 'font-weight': ay.weight, fill: ay.color, 'font-family': Wf.fontStack(ay.font)
        }, tickText[k]));
      }
    });
    if (ay.show && ay.title) {
      gAxes.appendChild(node('text', {
        x: ay.position === 'left' ? 0 : W, y: ay.size,
        'text-anchor': ay.position === 'left' ? 'start' : 'end',
        'font-size': ay.size, 'font-weight': ay.weight, fill: ay.color, 'font-family': Wf.fontStack(ay.font)
      }, ay.title));
    }
    if (ay.show && ay.showLine) {
      var axX = ay.position === 'left' ? left + 0.5 : W - right - 0.5;
      gAxes.appendChild(node('line', { x1: axX, x2: axX, y1: top, y2: bottomY, stroke: ay.lineColor, 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
    }

    // vertical gridlines between bars
    if (L.vGrid.show) {
      for (var i = 1; i < n; i++) {
        var xx = Math.round(slotX(i)) + 0.5;
        gGrid.appendChild(node('line', Object.assign({ x1: xx, x2: xx, y1: top, y2: bottomY }, lineAttrs(L.vGrid))));
      }
    }

    // zero line
    if (L.zero.show && sc.min <= 0 && sc.max >= 0) {
      var y0 = Math.round(y(0)) + 0.5;
      gGrid.appendChild(node('line', Object.assign({ x1: left, x2: W - right, y1: y0, y2: y0 }, lineAttrs(L.zero))));
    }

    // ---- bars -------------------------------------------------------------
    var eps = span * 1e-9;
    bars.forEach(function (b, i) {
      var s = b.s;
      var lo = Math.min(b.from, b.to);
      var hi = Math.max(b.from, b.to);
      var x = slotX(i) + (slot - bw) / 2;
      var yTop = clampY(hi);
      var yBot = clampY(lo);
      if (yBot - yTop < 1) {
        // Zero or tiny change: a 1 px line so the slot isn't empty.
        var mid = (yTop + yBot) / 2;
        yTop = mid - 0.5; yBot = mid + 0.5;
      }
      var clipLow = lo < sc.min - eps;
      var clipHigh = hi > sc.max + eps;
      var r = Math.min(b.kind === 'step' ? cfg.bars.radius : cfg.bars.endRadius, bw / 2, (yBot - yTop) / 2);

      var g = node('g', { class: 'bar', 'data-i': i });
      gBars.appendChild(g);
      drawn.push({ bar: b, x: x, w: bw, yTop: yTop, yBot: yBot, i: i });

      var segs = b.kind === 'step' && s.breakdown.show && b.segs.length > 0 ? orderedSegs(b) : null;
      if (segs) {
        var cid = 'wf-clip-' + (++clipSeq);
        var cp = node('clipPath', { id: cid });
        cp.appendChild(node('rect', { x: x, y: yTop, width: bw, height: yBot - yTop, rx: r }));
        defs.appendChild(cp);
        var sg = node('g', { 'clip-path': 'url(#' + cid + ')' });
        g.appendChild(sg);
        // invisible hit area
        sg.appendChild(node('rect', { class: 'bar-body', x: x, y: yTop, width: bw, height: yBot - yTop, fill: b.color }));
        var colors = segColors(b);
        var pos = b.from;
        b.segGeom = [];
        segs.forEach(function (seg, k) {
          var a = pos;
          var c = pos + seg.v;
          pos = c;
          var t1 = clampY(Math.max(a, c));
          var t2 = clampY(Math.min(a, c));
          var col = colors[seg.member] || b.color;
          sg.appendChild(node('rect', { x: x, y: t1, width: bw, height: Math.max(0, t2 - t1), fill: col }));
          if (s.breakdown.dividers && k < segs.length - 1) {
            var yb = Math.round(y(c)) + 0.5;
            if (yb > top && yb < bottomY) sg.appendChild(node('line', { x1: x, x2: x + bw, y1: yb, y2: yb, stroke: '#FFFFFF', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
          }
          b.segGeom.push({ seg: seg, y1: t1, y2: t2, color: col });
        });
      } else {
        g.appendChild(node('rect', { class: 'bar-body', x: x, y: yTop, width: bw, height: yBot - yTop, rx: r, fill: b.color }));
      }

      // Clipped-bar marker: the bar is longer than it looks.
      if (s.brk.show && (clipLow || clipHigh) && yBot - yTop > 14) {
        var c0 = clipLow
          ? yTop + (yBot - yTop) * Math.max(10, Math.min(90, s.brk.pos)) / 100
          : yBot - (yBot - yTop) * Math.max(10, Math.min(90, s.brk.pos)) / 100;
        drawBreak(g, x, bw, c0, s.brk);
      }
    });

    // ---- connectors -------------------------------------------------------
    if (L.connectors.show) {
      for (var j = 0; j < n - 1; j++) {
        var lv = bars[j].level;
        if (lv < sc.min - eps || lv > sc.max + eps) continue;
        var yc = Math.round(y(lv)) + 0.5;
        var d0 = drawn[j];
        var d1 = drawn[j + 1];
        gConn.appendChild(node('line', Object.assign({ x1: d0.x + d0.w, x2: d1.x, y1: yc, y2: yc }, lineAttrs(L.connectors), { 'shape-rendering': 'auto' })));
      }
    }

    // ---- value labels -----------------------------------------------------
    drawn.forEach(function (d) {
      var b = d.bar;
      var t = b.s.total;
      if (t.show) {
        var p = t.position;
        if (p === 'end') p = b.v < 0 || b.neg ? 'below' : 'above';
        var inside = p.indexOf('inside') === 0;
        var yy;
        if (p === 'above') yy = d.yTop - 6;
        else if (p === 'below') yy = d.yBot + t.size + 3;
        else if (p === 'inside-top') yy = d.yTop + t.size + 3;
        else if (p === 'inside-bottom') yy = d.yBot - 4;
        else yy = (d.yTop + d.yBot) / 2 + t.size * 0.35;
        var fill = t.colorMode === 'custom' ? t.color : (inside ? Wf.contrastText(b.color) : b.color);
        var txt = totalText(b);
        // Shrink to the slot width (or bar width when inside) so neighbours don't overlap.
        var room = (inside ? d.w : slot) - 4;
        var tw = textWidth(txt, t.size, t.weight, family);
        var fs = tw > room ? Math.max(7, t.size * room / tw) : t.size;
        gLabels.appendChild(node('text', {
          x: d.x + d.w / 2, y: yy, 'text-anchor': 'middle', 'font-size': fs.toFixed(2), 'font-weight': t.weight,
          fill: fill, 'font-family': Wf.fontStack(family)
        }, txt));
      }

      // breakdown labels
      var bd = b.s.breakdown;
      if (b.kind === 'step' && bd.show && bd.showValues && b.segGeom) {
        var bf = fmtOf(bd.fmt);
        b.segGeom.forEach(function (sg) {
          var h = sg.y2 - sg.y1;
          var txt = Wf.formatNumber(sg.seg.v, bf, { signed: true, zeroSign: b.neg ? -1 : 1 });
          if (bd.showNames) txt = sg.seg.member + ' ' + txt;
          var cy = (sg.y1 + sg.y2) / 2 + bd.size * 0.35;
          var attrs = { 'font-size': bd.size, 'font-weight': bd.weight, 'font-family': Wf.fontStack(family) };
          if (bd.position === 'inside') {
            if (h < Math.max(bd.minPx, bd.size + 1)) return;
            var txtFit = ellipsize(txt, d.w - 4, bd.size, bd.weight, family);
            if (txtFit === '…') return;
            attrs.x = d.x + d.w / 2; attrs['text-anchor'] = 'middle';
            attrs.fill = bd.labelColorMode === 'custom' ? bd.labelColor : Wf.contrastText(sg.color);
            gLabels.appendChild(node('text', Object.assign(attrs, { y: cy }), txtFit));
          } else {
            if (h < 2 && bd.minPx > 0) return;
            var right = bd.position === 'right';
            attrs.x = right ? d.x + d.w + 4 : d.x - 4;
            attrs['text-anchor'] = right ? 'start' : 'end';
            attrs.fill = bd.labelColorMode === 'custom' ? bd.labelColor : sg.color === '#FFFFFF' ? '#55606E' : darker(sg.color);
            gLabels.appendChild(node('text', Object.assign(attrs, { y: cy }), txt));
          }
        });
      }
    });

    // ---- x axis -------------------------------------------------------------
    if (ax.showLine) {
      var yl = Math.round(bottomY) + 0.5;
      gAxes.appendChild(node('line', { x1: left, x2: W - right, y1: yl, y2: yl, stroke: ax.lineColor, 'stroke-width': ax.lineWidth, 'shape-rendering': 'crispEdges' }));
    }
    var labelTop = bottomY + belowRoom;
    if (xl.length) {
      var lh2 = Math.round(ax.size * 1.2);
      xl.forEach(function (lines, i) {
        var cx = slotX(i) + slot / 2;
        var base = { 'font-size': ax.size, 'font-weight': ax.weight, fill: ax.color, 'font-family': Wf.fontStack(ax.font) };
        if (ax.orientation === 'wrap') {
          lines.forEach(function (ln, k) {
            gAxes.appendChild(node('text', Object.assign({ x: cx, y: labelTop + 6 + ax.size + k * lh2, 'text-anchor': 'middle' }, base), ln));
          });
        } else {
          var ang = ax.orientation === 'angled' ? -45 : -90;
          var ty = labelTop + 8;
          var tx = ax.orientation === 'angled' ? cx + ax.size * 0.3 : cx + ax.size * 0.35;
          gAxes.appendChild(node('text', Object.assign({ x: tx, y: ty, 'text-anchor': 'end', transform: 'rotate(' + ang + ' ' + tx + ' ' + ty + ')' }, base), lines[0]));
        }
      });
    }

    // ---- groups -----------------------------------------------------------
    if (runs.length) {
      var gy = labelTop + xlH + 6 + G.lineWidth / 2;
      var gf = fmtOf(G.fmt);
      runs.forEach(function (r) {
        var x1 = slotX(r.i0) + Math.min(G.inset, slot / 3);
        var x2 = slotX(r.i1 + 1) - Math.min(G.inset, slot / 3);
        var la = { stroke: r.def.color, 'stroke-width': G.lineWidth, 'stroke-linecap': 'butt' };
        if (G.lineStyle === 'dashed' || G.lineStyle === 'dotted') la['stroke-dasharray'] = Wf.dashArray(G.lineStyle, G.lineWidth);
        if (G.lineStyle === 'bracket') {
          gAxes.appendChild(node('path', Object.assign({ d: 'M' + x1 + ' ' + (gy - 5) + 'V' + gy + 'H' + x2 + 'V' + (gy - 5), fill: 'none' }, la)));
        } else {
          gAxes.appendChild(node('line', Object.assign({ x1: x1, x2: x2, y1: gy, y2: gy }, la)));
        }
        var txt = r.def.text || '';
        if (r.def.showTotal) {
          var tot = Wf.formatNumber(r.total, gf, { signed: true, zeroSign: (r.id === 'neg' || (r.id !== 'pos' && r.neg)) ? -1 : 1 });
          txt = txt ? txt + G.separator + tot : tot;
        }
        gAxes.appendChild(node('text', {
          x: (x1 + x2) / 2, y: gy + G.lineWidth / 2 + 4 + G.size, 'text-anchor': 'middle',
          'font-size': G.size, 'font-weight': G.weight, fill: r.def.color, 'font-family': Wf.fontStack(family)
        }, ellipsize(txt, Math.max(20, x2 - x1 + slot * 0.4), G.size, G.weight, family)));
      });
    }
  }

  function darker (hex) {
    // Text next to a pale segment: use a darker version so it stays readable.
    var c = Wf.normalizeHex(hex) || '#55606E';
    var v = [1, 3, 5].map(function (k) { return Math.round(parseInt(c.slice(k, k + 2), 16) * 0.7); });
    return '#' + v.map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }

  /** The "bar continues" marker across a clipped bar, centred at y = c. */
  function drawBreak (g, x, w, c, brk) {
    var x0 = x - 2;
    var x1 = x + w + 2;
    var tilt = 3;
    if (brk.style === 'zigzag') {
      var teeth = Math.max(2, Math.round((x1 - x0) / 7));
      var tw = (x1 - x0) / teeth;
      var topPts = [];
      var botPts = [];
      for (var k = 0; k <= teeth; k++) {
        var px = x0 + k * tw;
        var dy = k % 2 ? -2.5 : 2.5;
        topPts.push(px + ',' + (c - 4 + dy));
        botPts.push(px + ',' + (c + 4 + dy));
      }
      g.appendChild(node('polygon', { points: topPts.concat(botPts.slice().reverse()).join(' '), fill: brk.bandColor }));
      g.appendChild(node('polyline', { points: topPts.join(' '), fill: 'none', stroke: brk.lineColor, 'stroke-width': 1 }));
      g.appendChild(node('polyline', { points: botPts.join(' '), fill: 'none', stroke: brk.lineColor, 'stroke-width': 1 }));
      return;
    }
    // slash (Figma) and gap: a band, slanted for slash
    var t = brk.style === 'slash' ? tilt : 0;
    g.appendChild(node('polygon', {
      points: [x0 + ',' + (c - 4), x1 + ',' + (c - 4 - t), x1 + ',' + (c + 4 - t), x0 + ',' + (c + 4)].join(' '),
      fill: brk.bandColor
    }));
    if (brk.style === 'slash') {
      g.appendChild(node('line', { x1: x0, y1: c - 4, x2: x1, y2: c - 4 - t, stroke: brk.lineColor, 'stroke-width': 1 }));
      g.appendChild(node('line', { x1: x0, y1: c + 4, x2: x1, y2: c + 4 - t, stroke: brk.lineColor, 'stroke-width': 1 }));
    }
  }

  // ---------------------------------------------------------------------------
  // Tooltip + right-click menu
  // ---------------------------------------------------------------------------
  function barFromEvent (e) {
    var g = e.target.closest ? e.target.closest('.bar') : null;
    if (!g) return null;
    var d = drawn[Number(g.getAttribute('data-i'))];
    return d ? d.bar : null;
  }

  function onHover (e) {
    if (!cfg || !cfg.bars.tooltip || el.menu.style.display === 'block') return;
    var b = barFromEvent(e);
    if (!b) { hideTooltip(); return; }
    var f = fmtOf(b.s.total.fmt);
    var html = '<div class="tt-name">' + esc(b.label) + '</div>';
    html += '<div class="tt-value" style="color:' + (b.kind === 'step' ? b.color : '#17202B') + '">' +
      esc(Wf.formatNumber(b.v, f, { signed: b.kind === 'step', fv: b.fv, zeroSign: b.neg ? -1 : 1 })) + '</div>';
    if (b.kind === 'step') {
      html += '<div class="tt-note">' + esc(Wf.formatNumber(b.from, f)) + ' → ' + esc(Wf.formatNumber(b.to, f)) + '</div>';
    }
    if (b.varies) {
      html += '<div class="tt-note">Differs between Breakdown members; showing the most common value. Use an EXCLUDE / FIXED calculation for this measure.</div>';
    }
    if (b.kind === 'end' && b.calculated) {
      html += '<div class="tt-note">Calculated: Start + changes</div>';
    } else if (b.kind === 'end' && Math.abs(b.v - b.expected) > Math.max(1e-6, Math.abs(b.v) * 1e-9)) {
      html += '<div class="tt-note">Start + changes = ' + esc(Wf.formatNumber(b.expected, f)) +
        ' (diff ' + esc(Wf.formatNumber(b.v - b.expected, f, { signed: true })) + ')</div>';
    }
    if (b.segs && b.segs.length) {
      var colors = segColors(b);
      var bf = fmtOf(b.s.breakdown.fmt);
      html += '<div class="tt-rows">' + orderedSegs(b).map(function (s) {
        return '<div class="tt-row"><span class="sw" style="background:' + colors[s.member] + '"></span><span class="nm">' +
          esc(s.others ? s.member + ' (' + s.count + ')' : s.member) + '</span><span class="vl">' + esc(Wf.formatNumber(s.v, bf, { signed: true, zeroSign: b.neg ? -1 : 1 })) + '</span></div>';
      }).join('') + '</div>';
    }
    var tt = el.tooltip;
    tt.innerHTML = html;
    tt.style.fontFamily = Wf.fontStack(cfg.numbers.font);
    tt.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var tw = tt.offsetWidth;
    var th = tt.offsetHeight;
    var left = Math.min(Math.max(4, e.clientX + 12), vw - tw - 4);
    var top = e.clientY - th - 12;
    if (top < 4) top = Math.min(e.clientY + 16, vh - th - 4);
    tt.style.left = left + 'px';
    tt.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip () {
    if (el.tooltip) el.tooltip.style.display = 'none';
  }

  function onContextMenu (e) {
    if (!cfg || !cfg.bars.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    var b = barFromEvent(e);
    var items = [];
    if (b) items.push(['Format “' + b.label + '”…', { tab: 'bars', bar: b.key }], null);
    items.push(
      ['Groups…', { tab: 'groups' }],
      ['Axes…', { tab: 'axes' }],
      ['Lines…', { tab: 'lines' }],
      ['Numbers…', { tab: 'numbers' }],
      null,
      ['Format extension…', null]
    );
    var m = el.menu;
    m.innerHTML = '';
    items.forEach(function (it) {
      if (!it) { m.appendChild(document.createElement('hr')); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', function () { openDialog(it[1]); });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    m.style.left = Math.min(e.clientX, vw - m.offsetWidth - 4) + 'px';
    m.style.top = Math.min(e.clientY, vh - m.offsetHeight - 4) + 'px';
  }

  function hideMenu () {
    if (el.menu) el.menu.style.display = 'none';
  }

  function esc (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  window.Waterfall = { init: init };
})();
