/**
 * Bar Chart: data. Parameters, the Marks card fields, summary data, column matching, extract(),
 * then the view model: rows, series, colours, nodes, sorting, Top N, drill and stacking values.
 *
 * No DOM here: everything returns plain objects that the drawing files paint.
 * Cross-file calls go through B.<name>() at call time (see chart-state.js).
 */
'use strict';

(function () {
  const B = window.BcChart, S = B.S; // shared namespace and mutable state, see chart-state.js
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var toNumber = ExtCore.toNumber, isMN = ExtCore.isMN, isNumericCol = ExtCore.isNumericCol, norm = ExtCore.norm, cleanName = ExtCore.cleanName, findColumn = ExtCore.findColumn;
  // Constants and pure helpers from chart-state.js (loaded first, so safe to copy here).
  var SEP = B.SEP, TILES = B.TILES, SS = B.SS, CS = B.CS;

  // ---------------------------------------------------------------------------
  // Parameters: for <Parameter> in the title / explanation and measure names
  // ---------------------------------------------------------------------------
  function loadParams () {
    try {
      if (!S.worksheet || !S.worksheet.getParametersAsync) return Promise.resolve();
      return S.worksheet.getParametersAsync().then(function (list) {
        var next = {};
        (list || []).forEach(function (p) {
          var cv = p.currentValue || {};
          next[String(p.name).toLowerCase()] = { name: p.name, value: cv.formattedValue != null ? String(cv.formattedValue) : String(cv.value) };
          var id = p.id || p.name;
          if (!S.paramWatch[id] && p.addEventListener && tableau.TableauEventType.ParameterChanged) {
            S.paramWatch[id] = true;
            p.addEventListener(tableau.TableauEventType.ParameterChanged, function () { loadParams().then(function () { B.schedule(); }); });
          }
        });
        var changed = JSON.stringify(next) !== JSON.stringify(S.params);
        S.params = next;
        if (changed && S.raw) B.schedule();
      }).catch(function (e) { console.info('Bar Chart: parameters not available', e && e.message); });
    } catch (e) { return Promise.resolve(); }
  }

  /** Current value of a parameter (name with or without "Parameters."), or null. */
  function paramValue (name) {
    var k = String(name || '').trim().replace(/^\[?parameters\]?\./i, '').replace(/^\[|\]$/g, '').toLowerCase();
    return S.params[k] ? S.params[k].value : null;
  }

  /** "<Region Param> by Customer" → "West by Customer". Unknown <…> are left as written. */
  function fillParams (text) {
    return String(text || '').replace(/<([^<>]+)>/g, function (all, nm) {
      var v = paramValue(nm);
      return v != null ? v : all;
    });
  }

  /** Display name of a Measure / Line / Target / Tooltip field: default, custom text or a parameter's value. */
  function nameOf (f, legacy) {
    if (!f) return '';
    var N = S.cfg && S.cfg.names ? S.cfg.names[f.key] : null;
    if (N && N.mode === 'param') { var pv = paramValue(N.param); if (pv != null && pv !== '') return pv; return legacy || f.name; }
    if (N && N.mode === 'custom') return N.text ? fillParams(N.text) : f.name;
    if (N && N.mode === 'default') return f.name;
    return legacy || f.name;
  }
  function measureLabel (m) { return nameOf(m, Bc.seriesCfg(S.cfg, m.key).label); }
  function lineLabel (l) { return nameOf(l, Bc.lineCfg(S.cfg, l.key).label); }
  function fieldLabel (x) { return nameOf(x, ''); }

  async function getEncodedFields () {
    var spec = await S.worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = {};
    TILES.forEach(function (t) { fields[t] = []; });
    marks.encodings.forEach(function (e) {
      if (!e.field) return;
      var type = String(e.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : e.id;
      // Detail and Tooltip are Tableau's own tiles. Everything on Tooltip (dimension or
      // measure, discrete or continuous) becomes a "name: value" tooltip row, in tile
      // order; measures on Detail too. Dimensions on Detail only add rows.
      if (id === 'tooltip') id = 'tooltip';
      else if (id === 'detail') id = isMeasureField(e.field) ? 'tooltip' : 'detail';
      (fields[id] = fields[id] || []).push(e.field);
    });
    return fields;
  }

  function isMeasureField (f) {
    var role = String(f.role || '').toLowerCase();
    if (role === 'measure') return true;
    if (role === 'dimension') return false;
    return /^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|STDEV|STDEVP|VAR|VARP|PCT\d+)\(/i.test(String(f.name || ''));
  }

  /**
   * The worksheet's summary data, up to the row limit in the settings (Format → Card → Maximum
   * rows; 0 = all). When rows were left out, a small note says so in the corner.
   */
  async function readSummaryData (extra) {
    var limit = ExtCore.rowLimit(S.cfg.data.maxRows);
    var table = await ExtCore.readSummary(S.worksheet, { limit: limit, columnsToIncludeById: extra && extra.columnsToIncludeById });
    if (!extra) { S.lastLimit = limit; ExtCore.rowNotice(table); }
    return table;
  }

  /** True when the row limit in the settings no longer matches the data that was read. */
  function limitChanged () {
    return S.lastLimit != null && ExtCore.rowLimit(S.cfg.data.maxRows) !== S.lastLimit;
  }

  function isDateCol (c) { return /date/i.test(String(c.dataType || '')); }

  /** Renamed pills: unmatched fields take the free columns in order (see Waterfall). */
  function matchLeftovers (table, reqs, taken, pivoted) {
    var free = function () {
      return table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    };
    var take = function (r, c) { if (c) { r.col = c; taken.push(c); r.guessed = true; } };
    reqs.forEach(function (r) {
      if (!r.col && r.dim) take(r, free().find(function (x) { return !isNumericCol(x); }));
    });
    if (!pivoted) {
      reqs.forEach(function (r) {
        if (!r.col && !r.dim) take(r, free().find(isNumericCol));
      });
    }
    reqs.forEach(function (r) {
      if (!r.col && (r.dim || !pivoted)) take(r, free()[0]);
    });
    var guessed = reqs.filter(function (r) { return r.guessed; });
    if (guessed.length) {
      console.info('Bar Chart: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  function cellText (cell) {
    if (!cell) return '';
    var f = cell.formattedValue;
    if (f == null || f === '%null%') f = cell.value;
    return f == null || f === '%null%' ? 'Null' : String(f);
  }

  /**
   * Summary data → rows with every tile's values:
   *   { d: [Dimension tile values], dd: [date ms per level | null], v: { measure: n },
   *     fv: { measure: Tableau text }, l: { line: n }, t: target, x: { tooltip measure: n } }
   * Which Dimension fields make the bars and which are the breakdown is
   * decided per paint (prepareRows), so it can change in the Format dialog.
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var cMN = table.columns.find(function (c) { return /^measure names$/i.test(c.fieldName); });
    var cMV = table.columns.find(function (c) { return /^measure values$/i.test(c.fieldName); });

    function dimReq (f) { return { field: f, dim: true, col: null, key: f.name, name: cleanName(f.name) }; }
    var used = {};
    function measReq (f, kind) {
      var key = f.name;
      while (used[kind + key]) key += '+';
      used[kind + key] = 1;
      return { field: f, dim: false, col: null, key: key, name: cleanName(f.name), kind: kind };
    }
    var cats = fields.category.map(dimReq);
    var meas = fields.values.map(function (f) { return measReq(f, 'v'); });
    var lines = fields.line.map(function (f) { return measReq(f, 'l'); });
    var target = fields.target.map(function (f) { return measReq(f, 't'); });
    var extras = fields.tooltip.map(function (f) {
      if (isMeasureField(f)) return measReq(f, 'x');
      var r = dimReq(f);
      r.kind = 'xd';
      while (used['xd' + r.key]) r.key += '+';
      used['xd' + r.key] = 1;
      return r;
    });
    var details = (fields.detail || []).map(dimReq);

    var reqs = cats.concat(details, meas, lines, target, extras);
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    // The same field on two tiles (e.g. Sales on Measure and Line, Region on Dimension and
    // Tooltip) comes as one column: every tile that uses it reads that column.
    reqs.forEach(function (r) {
      if (r.col) return;
      var same = reqs.find(function (o) { return o !== r && o.col && o.field && r.field && (o.field.id && o.field.id === r.field.id || o.field.name === r.field.name); });
      if (same) r.col = same.col;
    });
    matchLeftovers(table, reqs, taken, !!(cMN && cMV));

    var isDate = cats.map(function (r) { return !!r.col && isDateCol(r.col); });

    function cellOf (row, r, mn) {
      if (r.col) return row[r.col.index];
      if (cMN && cMV && (mn === norm(r.field.name) || mn === norm(r.name))) return row[cMV.index];
      return null;
    }

    var out = [];
    var dateCache = {}; // the same axis values repeat on many rows
    rows.forEach(function (row) {
      var mn = cMN ? norm(row[cMN.index].formattedValue || row[cMN.index].value) : null;
      var o = { d: [], dd: [], v: {}, fv: {}, l: {}, t: NaN, x: {}, xt: {}, xf: {} };
      cats.forEach(function (r, i) {
        var cell = r.col ? row[r.col.index] : null;
        o.d.push(cellText(cell));
        var dt = null;
        if (cell) {
          var nv = cell.nativeValue != null ? cell.nativeValue : cell.value;
          var dkey = nv instanceof Date ? null : (isDate[i] ? nv : cellText(cell)) + '';
          if (dkey != null && dkey in dateCache) dt = dateCache[dkey];
          else {
            var pd = Bc.parseDate(nv instanceof Date ? nv : (isDate[i] ? nv : cellText(cell)));
            dt = pd ? pd.getTime() : null;
            if (dkey != null) dateCache[dkey] = dt;
          }
        }
        o.dd.push(dt);
      });
      var any = false;
      meas.forEach(function (r) {
        var cell = cellOf(row, r, mn);
        if (!cell) return;
        var n = toNumber(cell);
        if (!isFinite(n)) return;
        o.v[r.key] = n; o.fv[r.key] = cell.formattedValue; any = true;
      });
      lines.forEach(function (r) { var c = cellOf(row, r, mn); var n = toNumber(c); if (isFinite(n)) { o.l[r.key] = n; any = true; } });
      target.forEach(function (r) { var c = cellOf(row, r, mn); var n = toNumber(c); if (isFinite(n)) { o.t = n; any = true; } });
      extras.forEach(function (r) {
        var c = cellOf(row, r, mn);
        if (r.dim) { if (c) o.xt[r.key] = cellText(c); return; }
        var n = toNumber(c);
        if (isFinite(n)) { o.x[r.key] = n; if (c.formattedValue != null) o.xf[r.key] = String(c.formattedValue); any = true; }
        else if (c && cellText(c) !== 'Null') o.xt[r.key] = cellText(c); // e.g. ATTR of a text field
      });
      if (any || !cMN) out.push(o);
    });

    var strip = function (r) { return { key: r.key, name: r.name }; };
    return {
      rowsAll: out,
      dimFields: cats.map(function (r, i) { return { key: r.key, name: r.name, isDate: isDate[i] }; }),
      measures: meas.map(strip),
      lines: lines.map(strip),
      target: target[0] ? strip(target[0]) : null,
      extras: extras.map(function (r) { var o = strip(r); if (r.dim) o.dim = true; return o; }),
      // filled per paint by prepareRows()
      rows: [], catFields: [], dims: [], catIsDate: false, seriesIdx: [], seriesFields: [], barIdx: [], dimPos: []
    };
  }

  /** The Target tile's measure. */
  function targetInfo () {
    return S.raw ? S.raw.target : null;
  }

  /** Distinct breakdown combinations in data order (for the dialog's colour lists). */
  function comboList () {
    var seen = {};
    var out = [];
    S.raw.rows.forEach(function (r) {
      var b = S.raw.dimPos.map(function (i) { return r.d[i]; });
      var k = b.join(SEP);
      if (b.length && !seen[k]) { seen[k] = 1; out.push(b); }
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // View: series, categories (nodes), drill, Top N, sorting, groups, colours
  // ---------------------------------------------------------------------------

  function axisTypeOf () {
    var t = S.cfg.chart.axisType;
    if (t === 'measureNames') return 'measureNames';
    if (!S.raw.catFields.length) return S.raw.seriesIdx && S.raw.seriesIdx.length ? 'dimension' : 'measureNames'; // all fields split: one bar
    if (t === 'date') return 'date';
    if (t === 'dimension') return 'dimension';
    return S.raw.catIsDate || S.raw.rows.some(function (r) { return r.cd != null; }) && looksLikeDates() ? 'date' : 'dimension';
  }

  /** Every innermost axis value parses as a date (and they aren't plain small numbers). */
  function looksLikeDates () {
    if (!S.raw.rows.length) return false;
    return S.raw.rows.every(function (r) {
      var t = r.c[r.c.length - 1];
      return r.cd != null && !/^\d{1,3}$/.test(t);
    });
  }

  // ---------------------------------------------------------------------------
  // Rows for this paint: which Dimension fields make the bars (the rest is the
  // breakdown), legend filters, and Top N with Others at the chosen level.
  // ---------------------------------------------------------------------------
  /**
   * Dimension fields whose values (combined, e.g. "West · Consumer") become the
   * series — stacked, 100%, overlapping, left-right, side by side — instead of
   * the measures, like dimensions on Tableau's Color. Absolute indices into
   * raw.dimFields; [] = the measures are the series.
   *   seriesBy 'dims'  the fields in chart.seriesDims (any fields, in that order)
   *   seriesBy 'dim'   (older workbooks) the last field
   *   seriesBy 'auto'  the last field when there is one measure and the layout isn't regular
   *   seriesBy 'all'   every Dimension field: one bar split by all of them (works on any sheet, for presets)
   */
  function seriesFields () {
    var F = S.raw.dimFields || [];
    var P = panelFields();
    var free = F.map(function (f, i) { return i; }).filter(function (i) { return P.indexOf(i) < 0; }); // panel fields don't split bars
    var m = S.cfg.chart.seriesBy;
    if (!free.length || m === 'measures' || S.cfg.chart.axisType === 'measureNames') return [];
    if (m === 'all') return free;
    if (m === 'dims') {
      var keys = F.map(function (f) { return f.key; });
      var out = [];
      (S.cfg.chart.seriesDims || []).forEach(function (k) { var i = keys.indexOf(k); if (i >= 0 && out.indexOf(i) < 0 && P.indexOf(i) < 0) out.push(i); });
      return out;
    }
    if (free.length < 2) return [];
    var lastFree = free[free.length - 1];
    if (m === 'dim') return [lastFree];
    return S.raw.measures.length === 1 && S.cfg.chart.layout !== 'regular' ? [lastFree] : [];
  }

  /**
   * Dimension fields that split the chart into panels (small multiples), like
   * dimensions on Tableau's Rows or Columns: one chart per value (combined when
   * several), in tile order. Absolute indices into raw.dimFields.
   */
  function panelFields () {
    var F = S.raw.dimFields || [];
    if (!F.length) return [];
    var keys = F.map(function (f) { return f.key; });
    var out = [];
    (S.cfg.chart.panelDims || []).forEach(function (k) { var i = keys.indexOf(k); if (i >= 0 && out.indexOf(i) < 0) out.push(i); });
    return out.sort(function (a, b) { return a - b; });
  }

  /** One panel per measure (Measure Names on Rows / Columns): needs 2+ measures, and measures not on the axis. */
  function measurePanels () {
    return !!S.cfg.chart.panelMeasures && S.raw.measures.length > 1 && S.cfg.chart.axisType !== 'measureNames';
  }
  function viewMeasures () { return S.onlyM ? [S.onlyM] : S.raw.measures; }

  function isSeriesField (k) { return !!S.raw.seriesIdx && S.raw.seriesIdx.indexOf(k) >= 0; }

  function prepareRows () {
    var F = B.S.raw.dimFields || [];
    var P = panelFields();
    var S = seriesFields();
    // fields left for the bars and the breakdown, in tile order
    var NS = F.map(function (f, i) { return i; }).filter(function (i) { return S.indexOf(i) < 0 && P.indexOf(i) < 0; });
    B.S.raw.panelIdx = P;
    B.S.raw.panelFields = P.map(function (i) { return F[i]; });
    var L = !NS.length ? 0 : B.S.cfg.chart.showAll ? NS.length : Math.max(1, Math.min(NS.length, Math.round(Number(B.S.cfg.chart.barLevel)) || 1));
    var barIdx = NS.slice(0, L);
    B.S.raw.L = L;
    B.S.raw.barIdx = barIdx;
    B.S.raw.dimPos = NS.slice(L); // absolute index of each breakdown field
    B.S.raw.seriesIdx = S;
    B.S.raw.catFields = barIdx.map(function (i) { return F[i]; });
    B.S.raw.dims = B.S.raw.dimPos.map(function (i) { return F[i]; });
    B.S.raw.catIsDate = L ? !!F[barIdx[L - 1]].isDate : false;
    B.S.raw.seriesFields = S.map(function (i) { return F[i]; });
    // distinct values per Dimension field, in data order
    B.S.raw.levelValues = F.map(function () { return []; });
    var seen = F.map(function () { return {}; });
    B.S.raw.rowsAll.forEach(function (r) {
      r.d.forEach(function (x, i) { if (!seen[i][x]) { seen[i][x] = 1; B.S.raw.levelValues[i].push(x); } });
    });
    // legend: dimension values switched off
    var off = Object.keys(B.S.state.off).filter(function (k) { return k.indexOf('d:') === 0 && B.S.state.off[k]; }).map(function (k) {
      var i = k.indexOf('|');
      return { k: Number(k.slice(2, i)), v: k.slice(i + 1) };
    });
    var rows = off.length ? B.S.raw.rowsAll.filter(function (r) { return !off.some(function (o) { return r.d[o.k] === o.v; }); }) : B.S.raw.rowsAll;
    rows = topNRows(rows, L);
    var last = L ? barIdx[L - 1] : -1;
    B.S.raw.rows = rows.map(function (r) {
      return { c: barIdx.map(function (i) { return r.d[i]; }), b: r.d, sm: S.length ? S.map(function (i) { return r.d[i]; }).join(' \u00b7 ') : null, pm: P.length ? P.map(function (i) { return r.d[i]; }).join(' \u00b7 ') : null, cd: last >= 0 ? r.dd[last] : null, d: r.d, v: r.v, fv: r.fv, l: r.l, t: r.t, x: r.x, xt: r.xt || {}, xf: r.xf || {}, oth: !!r.oth };
    });
  }

  function topNLevel (L) {
    var T = S.cfg.topN;
    var F = S.raw.dimFields || [];
    if (T.level === 'auto' || T.level === '' || T.level == null) return L ? S.raw.barIdx[L - 1] : 0;
    return Math.max(0, Math.min(F.length - 1, Number(T.level) || 0));
  }

  /**
   * Top N per parent at one Dimension level, ranked by one measure (or the
   * total of all), e.g. the top 3 products in each category by Sales. The rest
   * becomes one "Others" member (or is left out).
   */
  function topNRows (rows, L) {
    var T = S.cfg.topN;
    var F = S.raw.dimFields || [];
    if (!T.enabled || !F.length || !(T.n > 0)) return rows;
    var k = topNLevel(L);
    var val = function (r) {
      if (T.by && T.by !== '__total') return Number(r.v[T.by]) || 0;
      return Object.keys(r.v).reduce(function (a, m) { return a + r.v[m]; }, 0);
    };
    // within each parent (e.g. top 3 Sub-Categories in every Category) or across all of them
    var parentOf = T.scope === 'overall' ? function () { return ''; } : function (r) { return r.d.slice(0, k).join(SEP); };
    var groups = {};
    rows.forEach(function (r) {
      var p = parentOf(r);
      var g = groups[p] || (groups[p] = {});
      g[r.d[k]] = (g[r.d[k]] || 0) + val(r);
    });
    var keep = {};
    var rest = {};
    Object.keys(groups).forEach(function (p) {
      var g = groups[p];
      var names = Object.keys(g).sort(function (a, b) { return T.direction === 'bottom' ? g[a] - g[b] : g[b] - g[a]; });
      keep[p] = {};
      names.slice(0, T.n).forEach(function (n) { keep[p][n] = 1; });
      rest[p] = Math.max(0, names.length - T.n);
    });
    // for averages: how many members went into each parent's Others bar
    var restIn = {};
    var seenRest = {};
    rows.forEach(function (r) {
      var p = parentOf(r);
      if (keep[p][r.d[k]]) return;
      var pp = r.d.slice(0, k).join(SEP);
      var key = pp + SEP + r.d[k];
      if (!seenRest[key]) { seenRest[key] = 1; restIn[pp] = (restIn[pp] || 0) + 1; }
    });
    var label = T.label || 'Others';
    var out = [];
    rows.forEach(function (r) {
      var p = parentOf(r);
      if (keep[p][r.d[k]]) { out.push(r); return; }
      if (!T.others) return;
      var c = { d: r.d.slice(), dd: r.dd.slice(), v: {}, fv: {}, l: {}, x: {}, xt: r.xt || {}, t: r.t, oth: true };
      for (var j = k; j < c.d.length; j++) { if (j > k && (isSeriesField(j) || S.raw.panelIdx.indexOf(j) >= 0)) continue; c.d[j] = label; c.dd[j] = null; }
      var div = T.othersAgg === 'avg' ? (restIn[r.d.slice(0, k).join(SEP)] || 1) : 1;
      Object.keys(r.v).forEach(function (m) { c.v[m] = r.v[m] / div; });
      Object.keys(r.l).forEach(function (m) { c.l[m] = r.l[m] / div; });
      Object.keys(r.x).forEach(function (m) { c.x[m] = r.x[m] / div; });
      if (isFinite(c.t)) c.t /= div;
      out.push(c);
    });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Members: what "each bar" is for colours, highlights, icons and groups.
  //   'auto'      the bar's own name
  //   'measures'  the measure name (Measure tile)
  //   'dim:k'     the value of Dimension field k
  // ---------------------------------------------------------------------------
  function memberOf (n, b, src) {
    if (!src || src === 'auto') return n.label;
    if (src === 'measures') return n.measureName || (b && b.s && b.s.measureName) || (S.raw.measures.length === 1 ? S.raw.measures[0].name : null);
    if (src.indexOf('dim:') === 0) {
      var k = Number(src.slice(4));
      if (isSeriesField(k) && b && b.s && b.s.member != null) return S.raw.seriesIdx.length === 1 ? b.s.member : b.s.parts[S.raw.seriesIdx.indexOf(k)];
      return n.dimPath && n.dimPath[k] != null ? n.dimPath[k] : null;
    }
    return n.label;
  }

  /** Dimension level deeper than this bar (its values split the bar into segments), or -1. */
  function deeperLevel (n, src) {
    if (!src || src.indexOf('dim:') !== 0) return -1;
    var k = Number(src.slice(4));
    // a breakdown field this bar isn't split by yet
    if (S.raw.dimPos.indexOf(k) < 0 || (n.dimPath && n.dimPath[k] != null)) return -1;
    return k;
  }

  function palette () { return Bc.paletteColors(S.cfg.colors.palette, S.cfg.colors.paletteEdits); }

  function measureIndex (key) { return S.raw.measures.findIndex(function (m) { return m.key === key; }); }

  function measureColor (key) {
    var i = measureIndex(key);
    var sc = Bc.seriesCfg(S.cfg, key);
    if (sc.color && Bc.normalizeHex(sc.color)) return sc.color;
    var pal = palette();
    return pal[(i < 0 ? 0 : i) % pal.length];
  }

  function measureKeyByName (name) {
    var m = S.raw.measures.find(function (x) { return x.name === name; });
    return m ? m.key : null;
  }

  function dimLevelOf () {
    var lv = S.cfg.colors.dimLevel;
    if (lv === 'auto' || lv === '' || lv == null) return S.raw.L ? S.raw.barIdx[S.raw.L - 1] : 0;
    return Math.max(0, Math.min((S.raw.dimFields || []).length - 1, Number(lv) || 0));
  }

  function dimColor (k, value) {
    var C = S.cfg.colors;
    var c = C.custom[k + '|' + value] || C.custom[value];
    if (c && Bc.normalizeHex(c)) return c;
    var pal = palette();
    var i = S.raw.levelValues && S.raw.levelValues[k] ? S.raw.levelValues[k].indexOf(value) : -1;
    return pal[(i < 0 ? 0 : i) % pal.length];
  }

  /** Colour source that splits bars into segments (Dimensions or Highlight at a deeper level). */
  function colorSegSource () {
    var m = S.view && S.view.cmode ? S.view.cmode : colorMode(S.raw.measures.length);
    if (m === 'dimensions') return 'dim:' + dimLevelOf();
    if (m === 'highlight') return S.cfg.colors.highlightBy || 'auto';
    return null;
  }

  function seriesDefs (axisType) {
    var M = viewMeasures();
    var defs = [];
    if (S.raw.seriesIdx.length && axisType !== 'measureNames') return dimSeriesDefs();
    if (axisType === 'measureNames' || M.length <= 1) {
      var one = M.length === 1 && axisType !== 'measureNames' ? M[0] : null;
      defs.push({ key: one ? one.key : '__v', name: one ? one.name : (M.length === 1 ? M[0].name : 'Value'), measure: one ? one.key : null, measureName: one ? one.name : null });
    } else {
      M.forEach(function (m) { defs.push({ key: m.key, name: m.name, measure: m.key, measureName: m.name }); });
    }
    defs.forEach(function (d, i) {
      var sc = Bc.seriesCfg(S.cfg, d.key);
      d.idx = i;
      var mm = d.measure ? M.find(function (m) { return m.key === d.measure; }) : (M.length === 1 ? M[0] : null);
      if (mm) d.name = measureLabel(mm);
      else if (sc.label) d.name = sc.label;
      d.color = d.measure ? measureColor(d.measure) : S.cfg.colors.single;
    });
    return defs;
  }

  /** Series from the values of a Dimension field (per measure when there are several). */
  function dimSeriesDefs () {
    var M = viewMeasures();
    var S = B.S.raw.seriesIdx;
    var one = S.length === 1;
    var oth = B.S.cfg.topN.label || 'Others';
    var seen = {};
    var mem = [];
    B.S.raw.rows.forEach(function (r) { if (r.sm != null && !seen[r.sm]) { seen[r.sm] = 1; mem.push(r.sm); } });
    var order = one ? (B.S.raw.levelValues[S[0]] || []).filter(function (x) { return seen[x]; }) : [];
    mem.forEach(function (x) { if (order.indexOf(x) < 0) order.push(x); });
    var isOth = function (x) { return B.S.raw.rows.some(function (r) { return r.oth && r.sm === x && String(x).split(' \u00b7 ').indexOf(oth) >= 0; }); };
    var othList = order.filter(isOth);
    order = order.filter(function (x) { return othList.indexOf(x) < 0; }).concat(othList);
    var pal = palette();
    var defs = [];
    M.forEach(function (m) {
      order.forEach(function (x) {
        defs.push({ key: m.key + SS + x, name: M.length > 1 ? measureLabel(m) + ' \u00b7 ' + x : x, measure: m.key, measureName: m.name,
          member: x, parts: String(x).split(' \u00b7 '), memberOthers: othList.indexOf(x) >= 0 });
      });
    });
    defs.forEach(function (d, i) {
      var sc = Bc.seriesCfg(B.S.cfg, d.key);
      d.idx = i;
      if (sc.label) d.name = sc.label;
      var custom = B.S.cfg.colors.custom['s|' + d.member];
      d.color = sc.color && Bc.normalizeHex(sc.color) ? sc.color : d.memberOthers ? B.S.cfg.topN.color
        : one ? dimColor(S[0], d.member) : custom && Bc.normalizeHex(custom) ? custom : pal[order.indexOf(d.member) % pal.length];
    });
    return defs;
  }

  function colorMode (nSeries) {
    var m = S.cfg.colors.mode;
    if (m === 'series') m = 'measures';
    if (m === 'category') m = 'dimensions';
    if (m === 'value') m = 'auto'; // "Gradient by value" was removed
    if (m === 'auto') m = nSeries > 1 ? 'measures' : 'single';
    if (m === 'dimensions' && !(S.raw.dimFields || []).length) m = 'measures';
    return m;
  }

  /** Series key for one measure value. */
  function seriesKeyOf (axisType, mKey, r) {
    if (axisType === 'measureNames') return '__v';
    if (S.raw.seriesIdx.length && r) return mKey + SS + r.sm;
    return mKey;
  }

  function dateLabel (text, ms) {
    var f = S.cfg.axisC.dateFormat;
    if (!f || f === 'auto' || ms == null) return text;
    return Bc.formatDate(new Date(ms), f) || text;
  }

  /** Values of the given fields at their own index (others null), so dimPath[k] is field k's value. */
  function positional (d, idx) {
    var out = [];
    var max = idx.length ? Math.max.apply(null, idx) : -1;
    for (var i = 0; i <= max; i++) out.push(idx.indexOf(i) >= 0 ? d[i] : null);
    return out;
  }

  function newNode (key, path, label) {
    return { key: key, path: path, label: label, depth: 0, parent: null, items: [], ris: [], riSeen: {}, date: null, isOthers: false };
  }

  /** Base nodes (one per axis path) from the rows. */
  function baseNodes (axisType, panel, panelKey) {
    var map = {};
    var list = [];
    var nullZero = S.cfg.numbers.nullAs === 'zero';
    var mkeys = viewMeasures().map(function (m) { return m.key; });
    S.raw.rows.forEach(function (r, ri) {
      if (panel != null && r.pm !== panel) return; // one panel of small multiples
      mkeys.forEach(function (mk) {
        var has = mk in r.v;
        if (!has && !nullZero) return;
        var path = r.c.slice();
        if (axisType === 'measureNames') path.push(S.raw.measures.find(function (m) { return m.key === mk; }).name);
        var single = !path.length; // every Dimension field splits the bars: one bar
        if (single) path = ['All'];
        var key = path.join(SEP);
        var n = map[key];
        if (!n) {
          var last = path[path.length - 1];
          n = map[key] = newNode(key, path, single ? viewMeasures().map(measureLabel).join(' & ') : axisType === 'date' ? dateLabel(last, r.cd) : axisType === 'measureNames' ? measureLabel(S.raw.measures.find(function (m) { return m.key === mk; })) : last);
          n.date = axisType === 'date' ? r.cd : null;
          n.outer = path.slice(0, -1);
          n.dimPath = positional(r.d, S.raw.barIdx);
          n.panel = panelKey != null ? panelKey : r.pm; // small multiples: the panel this bar is in
          n.panelVals = S.raw.panelIdx.map(function (i) { return { field: S.raw.dimFields[i], value: r.d[i] }; });
          if (axisType === 'measureNames') { n.measureName = last; n.measureKey = mk; }
          n.isOthers = !!r.oth && last === (S.cfg.topN.label || 'Others');
          list.push(n);
        }
        n.items.push({ s: seriesKeyOf(axisType, mk, r), m: mk, sm: r.sm, v: has ? r.v[mk] : 0, fv: r.fv[mk], b: r.b, ri: ri });
        if (!n.riSeen[ri]) { n.riSeen[ri] = 1; n.ris.push(ri); }
      });
    });
    list.forEach(finalize);
    return list;
  }

  /** Sums per series, lines, target and extras of a node. */
  function finalize (n) {
    n.vals = {};
    n.mv = {};
    n.total = 0;
    n.items.forEach(function (it) {
      if (it.m) n.mv[it.m] = (n.mv[it.m] || 0) + it.v;
      var o = n.vals[it.s] || (n.vals[it.s] = { v: 0, n: 0, fv: null });
      o.v += it.v; o.n++; o.fv = o.n === 1 ? it.fv : null;
      n.total += it.v;
    });
    n.l = {}; n.x = {}; n.xt = {}; n.xf = {}; n.t = NaN;
    var tg = targetInfo();
    var tk = tg && !S.raw.target ? tg.key : null;
    n.ris.forEach(function (ri) {
      var r = S.raw.rows[ri];
      Object.keys(r.l).forEach(function (k) { n.l[k] = (n.l[k] || 0) + r.l[k]; });
      Object.keys(r.x).forEach(function (k) { n.x[k] = (n.x[k] || 0) + r.x[k]; });
      Object.keys(r.xt || {}).forEach(function (k) { var a = n.xt[k] || (n.xt[k] = []); if (a.indexOf(r.xt[k]) < 0) a.push(r.xt[k]); });
      Object.keys(r.xf || {}).forEach(function (k) { n.xf[k] = n.xf[k] === undefined ? r.xf[k] : null; }); // Tableau's text only for a single row
      var tv = tk ? r.x[tk] : r.t;
      if (isFinite(tv)) n.t = (isFinite(n.t) ? n.t : 0) + tv;
    });
    n.pathLabel = (n.parent ? n.parent.pathLabel + ' › ' : n.outer && n.outer.length ? n.outer.join(' · ') + ' › ' : '') + n.label;
    delete n.riSeen;
    return n;
  }

  /** Drill children of a node: its items split by the next breakdown field. */
  function childrenOf (n) {
    var d = n.depth;
    if (d >= S.raw.dims.length) return [];
    if (n._kids) return n._kids;
    var map = {};
    var list = [];
    n.items.forEach(function (it) {
      var m = it.b[S.raw.dimPos[d]];
      var c = map[m];
      if (!c) {
        c = map[m] = newNode(n.key + CS + m, n.path.concat([m]), m);
        c.depth = d + 1; c.parent = n; c.outer = []; c.date = n.date;
        c.dimPath = (n.dimPath || []).slice(); while (c.dimPath.length <= S.raw.dimPos[d]) c.dimPath.push(null); c.dimPath[S.raw.dimPos[d]] = m;
        c.panel = n.panel; c.panelVals = n.panelVals;
        c.measureName = n.measureName; c.measureKey = n.measureKey;
        c.isOthers = !!S.raw.rows[it.ri].oth && m === (S.cfg.topN.label || 'Others');
        list.push(c);
      }
      c.items.push(it);
      if (!c.riSeen[it.ri]) { c.riSeen[it.ri] = 1; c.ris.push(it.ri); }
    });
    list.forEach(finalize);
    n._kids = sortNodes(list, false);
    return n._kids;
  }

  function sortValue (n) {
    var by = S.cfg.axisC.sortBy;
    if (by && by !== '__total' && n.vals[by]) return n.vals[by].v;
    if (by && by !== '__total' && n.mv && n.mv[by] != null) return n.mv[by];
    return n.total;
  }

  /**
   * Sorts nodes. With nested Axis fields the bars are sorted inside their
   * outer group and the groups keep together (ordered the same way).
   */
  function sortNodes (list, grouped) {
    var o = S.cfg.axisC.sort;
    var cmp;
    if (o === 'date' || o === 'dateDesc') {
      var dir = o === 'date' ? 1 : -1;
      cmp = function (a, b) {
        if (a.date == null || b.date == null) return 0;
        return (a.date - b.date) * dir;
      };
    } else {
      cmp = Bc.comparer(o, sortValue, function (n) { return n.label; });
    }
    var oLast = S.cfg.topN.othersLast;
    var isOth = function (n) { return oLast && n.isOthers; };
    var sortIn = function (items) {
      var rest = items.filter(function (n) { return !isOth(n); });
      return (cmp ? Bc.sortBy(rest, cmp) : rest).concat(items.filter(isOth));
    };
    if (!grouped) return sortIn(list);
    var oLabel = S.cfg.topN.label || 'Others';
    var groups = [];
    var byKey = {};
    list.forEach(function (n) {
      var k = (n.outer || []).join(SEP);
      if (!byKey[k]) {
        byKey[k] = { key: k, label: (n.outer || []).join(' '), items: [], total: 0, date: n.date, oth: oLast && (n.outer || []).indexOf(oLabel) >= 0 };
        groups.push(byKey[k]);
      }
      byKey[k].items.push(n);
      byKey[k].total += sortValue(n);
    });
    var gcmp = o === 'date' || o === 'dateDesc' ? cmp : Bc.comparer(o, function (g) { return g.total; }, function (g) { return g.label; });
    var gs = groups.filter(function (g) { return !g.oth; });
    gs = gcmp ? Bc.sortBy(gs, gcmp) : gs;
    // an Others group goes after the last group of its own parent (e.g. Chairs › Others after Chairs › West)
    groups.filter(function (g) { return g.oth; }).forEach(function (g) {
      var outer = g.items[0].outer || [];
      var pre = outer.slice(0, outer.indexOf(oLabel)).join(SEP);
      var at = -1;
      gs.forEach(function (x, i) { var xo = (x.items[0].outer || []).join(SEP); if (!pre || xo === pre || xo.indexOf(pre + SEP) === 0) at = i; });
      if (at < 0) gs.push(g); else gs.splice(at + 1, 0, g);
    });
    var out = [];
    gs.forEach(function (g) { out = out.concat(sortIn(g.items)); });
    return out;
  }

  /** Top N by total (or one series) — the rest become "Others" or are left out. */
  function applyTopN (list) {
    var T = S.cfg.topN;
    if (!T.enabled || !(T.n > 0) || list.length <= T.n) return list;
    var val = function (n) { return T.by && T.by !== '__total' && n.vals[T.by] ? n.vals[T.by].v : n.total; };
    var ranked = Bc.sortBy(list, function (a, b) { return T.direction === 'bottom' ? val(a) - val(b) : val(b) - val(a); });
    var keep = ranked.slice(0, T.n);
    var keepSet = {};
    keep.forEach(function (n) { keepSet[n.key] = 1; });
    var rest = ranked.slice(T.n);
    var out = list.filter(function (n) { return keepSet[n.key]; });
    if (T.others && rest.length) {
      var o = newNode('__others', [T.label || 'Others'], T.label || 'Others');
      o.isOthers = true;
      o.outer = [];
      o.members = rest.map(function (n) { return n.label; });
      rest.forEach(function (n) {
        n.items.forEach(function (it) { o.items.push(it); });
        n.ris.forEach(function (ri) { if (!o.riSeen[ri]) { o.riSeen[ri] = 1; o.ris.push(ri); } });
      });
      finalize(o);
      if (T.othersAgg === 'avg') {
        var k = rest.length;
        o.items = o.items.map(function (it) { var c = Object.assign({}, it); c.v = it.v / k; return c; });
        Object.keys(o.vals).forEach(function (s) { o.vals[s].v /= k; });
        o.total /= k;
        Object.keys(o.l).forEach(function (s) { o.l[s] /= k; });
        Object.keys(o.x).forEach(function (s) { o.x[s] /= k; });
        if (isFinite(o.t)) o.t /= k;
      }
      out.push(o);
    }
    return out;
  }

  function isHidden (n) {
    var h = S.cfg.interaction.hidden || [];
    return h.indexOf(n.label) >= 0 || h.indexOf(n.key) >= 0 || !!S.state.off['c:' + n.label] || (!!S.state.off['o:'] && n.isOthers);
  }

  function findNode (list, key) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].key === key) return list[i];
      if (key.indexOf(list[i].key + CS) === 0) return findNode(childrenOf(list[i]), key);
    }
    return null;
  }

  /** Visible nodes after drill-down. */
  function drillNodes (base) {
    var D = S.cfg.drill;
    if (!D.enabled || !S.raw.dims.length) return base;
    if (D.mode === 'focus' && S.state.focus.length) {
      var f = findNode(base, S.state.focus[S.state.focus.length - 1]);
      if (f) {
        var kids = childrenOf(f).filter(function (n) { return !isHidden(n); });
        if (kids.length) return kids;
      }
      S.state.focus = [];
      return base;
    }
    if (D.mode === 'expandAll' && S.state.level > 0) {
      var lvl = Math.min(S.state.level, S.raw.dims.length);
      var expand = function (list) {
        var out = [];
        list.forEach(function (n) {
          if (n.depth < lvl && n.depth < S.raw.dims.length) out = out.concat(expand(childrenOf(n)));
          else out.push(n);
        });
        return out;
      };
      return expand(base);
    }
    if (D.mode === 'expandOne') {
      var walk = function (list) {
        var out = [];
        list.forEach(function (n) {
          if (S.state.expanded[n.key] && n.depth < S.raw.dims.length) out = out.concat(walk(childrenOf(n)));
          else out.push(n);
        });
        return out;
      };
      return walk(base);
    }
    return base;
  }

  function isDrilled () {
    var D = S.cfg.drill;
    if (!D.enabled) return false;
    if (D.mode === 'focus') return S.state.focus.length > 0;
    if (D.mode === 'expandAll') return S.state.level > 0;
    return Object.keys(S.state.expanded).length > 0;
  }

  /** Group of each node (shown under the axis): drill parent or outer Dimension fields. */
  function assignGroups (nodes) {
    var G = S.cfg.groups;
    nodes.forEach(function (n) {
      n.grp = null;
      if (G.mode === 'none') return;
      if (n.parent && !(S.cfg.drill.mode === 'focus')) {
        n.grp = { id: 'p:' + n.parent.key, label: n.parent.label, color: G.color };
      } else if (n.outer && n.outer.length) {
        n.grp = { id: 'o:' + n.outer.join(SEP), label: n.outer.join(' · '), color: G.color };
      }
    });
  }

  /** opts.panel: only that panel's rows (opts.reuse: rows already prepared this paint). */
  function buildView (opts) {
    opts = opts || {};
    if (!opts.reuse) prepareRows();
    S.onlyM = opts.measure || null; // a measure panel: just that measure
    try { return buildView1(opts); } finally { S.onlyM = null; }
  }

  function buildView1 (opts) {
    var axisType = axisTypeOf();
    var series = seriesDefs(axisType);
    var all = baseNodes(axisType, opts.panel, opts.panelKey);
    var allSorted = sortNodes(all, S.raw.catFields.length > 1 || axisType === 'measureNames' && S.raw.catFields.length > 0);
    var visible = allSorted.filter(function (n) { return !isHidden(n); });
    // Top N with Dimension fields works on the rows (prepareRows); without, on the measure bars
    var base = (S.raw.dimFields || []).length ? visible : applyTopN(visible);
    if (S.cfg.topN.enabled && !(S.raw.dimFields || []).length) base = sortNodes(base, false);
    var nodes = drillNodes(base).filter(function (n) { return !isHidden(n); });
    assignGroups(nodes);
    var M0 = S.raw.measures.length ? S.raw.measures[0].key : null; // panel per measure: the legend's member items count for every measure
    var visSeries = series.filter(function (s) { return !S.state.off['s:' + s.key] && !(S.onlyM && s.member != null && S.state.off['s:' + M0 + SS + s.member]); });
    var v = {
      axisType: axisType,
      series: series,
      visSeries: visSeries,
      allNodes: allSorted,
      base: base,
      nodes: nodes,
      layout: S.cfg.chart.layout,
      cmode: colorMode(S.onlyM && S.raw.measures.length > 1 ? S.raw.measures.length : series.length),
      measure: S.onlyM ? S.onlyM.key : null,
      noTarget: !!S.onlyM && S.onlyM !== S.raw.measures[0] // the target compares with the first measure: only in its panels
    };
    if (v.layout === 'diverging' && visSeries.length < 2) v.layout = 'regular';
    if ((v.layout === 'stacked' || v.layout === 'stacked100' || v.layout === 'overlap') && visSeries.length < 2) v.layout = 'regular';
    v.style = v.layout === 'regular' || v.layout === 'overlap' || v.layout === 'diverging' ? S.cfg.chart.style : 'bar';
    if (v.layout === 'stacked100' && S.cfg.chart.style === 'progress') v.style = 'bar';
    prepareValues(v);
    return v;
  }

  /**
   * Left-right: the order the values take their sides in — measures in Measure tile order,
   * Dimension values in the worksheet's sort order. Tableau hands viz extensions the summary
   * data last-to-first, so the rows are read backwards.
   */
  function divOrder (S) {
    if (!S.some(function (s) { return s.member != null; })) return S;
    var rank = {};
    var k = 0;
    for (var r = B.S.raw.rows.length - 1; r >= 0; r--) { var m = B.S.raw.rows[r].sm; if (m != null && !(m in rank)) rank[m] = k++; }
    var mIdx = {};
    S.forEach(function (s, i) { if (!(s.measure in mIdx)) mIdx[s.measure] = i; });
    return S.map(function (s, i) { return { s: s, i: i }; }).sort(function (a, b) {
      return (mIdx[a.s.measure] - mIdx[b.s.measure]) ||
        ((a.s.memberOthers ? 1e9 : rank[a.s.member] != null ? rank[a.s.member] : 1e8) - (b.s.memberOthers ? 1e9 : rank[b.s.member] != null ? rank[b.s.member] : 1e8)) || a.i - b.i;
    }).map(function (o) { return o.s; });
  }

  // ---------------------------------------------------------------------------
  // Values as drawn (stacking, 100%, diverging) and colours
  // ---------------------------------------------------------------------------
  function prepareValues (v) {
    var S = v.visSeries;
    var divNeg = {};
    if (v.layout === 'diverging') {
      var DV = B.S.cfg.diverging;
      var negIdx = DV.firstSide === 'neg' ? 0 : 1;
      divOrder(S).forEach(function (s, i) { divNeg[s.key] = i % 2 === negIdx; });
      if (DV.order === 'custom' && DV.sides) {
        S.forEach(function (s) { var side = DV.sides[s.key]; if (side === 'neg' || side === 'pos') divNeg[s.key] = side === 'neg'; });
      }
    }
    v.divNeg = divNeg;
    var totalsBySeries = {};
    v.nodes.forEach(function (n) {
      n.bars = [];
      var pos = 0;
      var neg = 0;
      var sumAbs = 0;
      S.forEach(function (s) { var o = n.vals[s.key]; if (o) sumAbs += Math.abs(o.v); });
      S.forEach(function (s, si) {
        var o = n.vals[s.key];
        if (!o) return;
        var val = o.v;
        totalsBySeries[s.key] = (totalsBySeries[s.key] || 0) + val;
        var shown = val;
        if (v.layout === 'stacked100') shown = sumAbs ? val / sumAbs : 0;
        if (v.layout === 'diverging') shown = divNeg[s.key] ? -Math.abs(val) : Math.abs(val);
        var from = 0;
        var to = shown;
        if (v.layout === 'stacked' || v.layout === 'stacked100' || v.layout === 'diverging') {
          if (shown >= 0) { from = pos; pos += shown; to = pos; } else { from = neg; neg += shown; to = neg; }
        }
        n.bars.push({ node: n, s: s, si: si, v: val, fv: o.fv, shown: shown, from: from, to: to, count: o.n });
      });
      n.stackPos = pos;
      n.stackNeg = neg;
    });
    v.totalsBySeries = totalsBySeries;
    // previous bar of the same series (labels: difference from previous)
    var prev = {};
    v.nodes.forEach(function (n, i) {
      n.idx = i;
      n.bars.forEach(function (b) { b.prev = prev[b.s.key]; prev[b.s.key] = b; });
    });
    assignColors(v);
  }

  function assignColors (v) {
    var C = S.cfg.colors;
    var mode = v.cmode;
    var valField = C.valueField || '__self';
    var valueOf = function (n, b) {
      if (valField === '__self') return b.v;
      if (n.vals[valField]) return n.vals[valField].v;
      if (b.s.member != null) return b.s.measure === valField ? b.v : n.mv && n.mv[valField] != null ? n.mv[valField] : NaN;
      if (n.measureKey) return n.measureKey === valField ? b.v : NaN;
      return NaN;
    };
    var lo = Infinity;
    var hi = -Infinity;
    if (mode === 'value') {
      v.nodes.forEach(function (n) { n.bars.forEach(function (b) { var x = valueOf(n, b); if (isFinite(x)) { lo = Math.min(lo, x); hi = Math.max(hi, x); } }); });
    }
    var hlSrc = C.highlightBy || 'auto';
    var hl = {};
    (C.highlight || []).forEach(function (m) { hl[m] = 1; });
    var hlTop = {};
    if (C.highlightTop > 0) {
      Bc.sortBy(v.nodes.filter(function (n) { return !n.isOthers; }), function (a, b) { return b.total - a.total; })
        .slice(0, C.highlightTop).forEach(function (n) { hlTop[n.key] = 1; });
    }
    var dk = dimLevelOf();

    v.nodes.forEach(function (n) {
      n.bars.forEach(function (b) {
        var c;
        var inherited = false;
        if (n.isOthers) c = S.cfg.topN.color;
        else if (b.s.member != null && (mode === 'measures' || mode === 'single' || (mode === 'dimensions' && isSeriesField(dk)))) c = b.s.color;
        else if (mode === 'measures') {
          var mk = n.measureKey || b.s.measure || measureKeyByName(memberOf(n, b, 'measures'));
          c = mk ? measureColor(mk) : C.single;
        } else if (mode === 'dimensions') {
          if (n.dimPath && n.dimPath[dk] != null) { c = dimColor(dk, n.dimPath[dk]); inherited = dk !== n.dimPath.length - 1; } else c = C.single;
        } else if (mode === 'value') {
          var x = valueOf(n, b);
          c = isFinite(x) ? Bc.mix(C.lowColor, C.highColor, hi > lo ? (x - lo) / (hi - lo) : 1) : C.mutedColor;
        } else if (mode === 'sign') c = b.v < 0 ? C.negColor : C.posColor;
        else if (mode === 'highlight') {
          var mem = memberOf(n, b, hlSrc);
          c = (mem != null && hl[mem]) || hlTop[n.key] ? C.highlightColor : C.mutedColor;
        } else c = Bc.seriesCfg(S.cfg, b.s.key).color || C.single;
        // drilled children that inherit their parent's colour: shades of it
        if (n.parent && S.cfg.drill.tintChildren && !n.isOthers && (mode === 'single' || (mode === 'dimensions' && inherited))) {
          var sib = childrenOf(n.parent);
          var k = sib.indexOf(n);
          c = Bc.tint(c, sib.length > 1 ? (k / (sib.length - 1)) * 0.55 : 0);
        }
        (C.rules || []).some(function (r) {
          var y = Number(r.value);
          var ok = r.op === '>' ? b.v > y : r.op === '>=' ? b.v >= y : r.op === '<' ? b.v < y : r.op === '<=' ? b.v <= y : b.v === y;
          if (ok && Bc.normalizeHex(r.color)) { c = r.color; return true; }
          return false;
        });
        b.color = Bc.normalizeHex(c) || '#8C96A3';
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Small multiples: one chart per value of the Panels fields (Grouping tab),
  // like dimensions on Tableau's Rows or Columns. Same series, colours and legend;
  // optionally one value axis for all panels.
  // ---------------------------------------------------------------------------
  function panelMembers () {
    var P = S.raw.panelIdx;
    var seen = {};
    var data = [];
    S.raw.rows.forEach(function (r) { if (r.pm != null && !seen[r.pm]) { seen[r.pm] = 1; data.push(r.pm); } });
    if (P.length !== 1) return data;
    var order = (S.raw.levelValues[P[0]] || []).filter(function (x) { return seen[x]; });
    data.forEach(function (x) { if (order.indexOf(x) < 0) order.push(x); });
    return order;
  }

  /** The panels: per measure (outer) and/or per value of the panel fields. */
  function panelList () {
    var dims = S.raw.panelIdx && S.raw.panelIdx.length ? panelMembers() : [null];
    var ms = measurePanels() ? S.raw.measures : [null];
    var out = [];
    ms.forEach(function (m) {
      dims.forEach(function (x) {
        var t = [m ? measureLabel(m) : null, x].filter(function (s) { return s != null; }).join(' \u00b7 ');
        out.push({ m: t, v: buildView({ panel: x, measure: m, panelKey: m ? m.key + '\u0005' + (x == null ? '' : x) : x, reuse: true }) });
      });
    });
    return out;
  }

  /** Segments of a bar by the breakdown fields (Waterfall style). */
  function segDims (n) {
    var BD = S.cfg.breakdown;
    var keys = S.raw.dims.map(function (d) { return d.key; });
    var sel = (BD.dims || []).map(function (k) { return keys.indexOf(k); }).filter(function (i) { return i >= 0; });
    if (!sel.length) sel = keys.map(function (k, i) { return i; });
    // breakdown positions → field indices in the row (it.b is the full row)
    return sel.filter(function (i) { return i >= n.depth; }).map(function (i) { return S.raw.dimPos[i]; });
  }

  /**
   * How a bar is split: by the colour field when Colors → Dimensions (or
   * Highlight) uses a field deeper than the bar, else by the breakdown when
   * "Split bars into segments" is on. null = not split.
   */
  function segSpec (n) {
    var src = colorSegSource();
    var k = src ? deeperLevel(n, src) : -1;
    if (k >= 0) return { idx: [k], level: k, color: true };
    if (S.cfg.breakdown.show && S.raw.dims.length > n.depth) {
      var idx = segDims(n);
      if (idx.length) return { idx: idx, color: false };
    }
    return null;
  }

  function segmentsOf (n, sKey, spec) {
    var idx = spec ? spec.idx : segDims(n);
    if (!idx || !idx.length) return [];
    var BD = S.cfg.breakdown;
    var sums = {};
    var order = [];
    n.items.forEach(function (it) {
      if (it.s !== sKey) return;
      var name = idx.map(function (i) { return it.b[i]; }).join(BD.sep == null ? ' · ' : BD.sep);
      if (!(name in sums)) { sums[name] = 0; order.push(name); }
      sums[name] += it.v;
    });
    var segs = order.map(function (k) { return { member: k, v: sums[k] }; });
    return Bc.sortBy(segs, Bc.comparer(BD.order, function (x) { return x.v; }, function (x) { return x.member; }));
  }

  function segColors (segs, color, spec) {
    var BD = S.cfg.breakdown;
    var sh = Bc.shades(color, Math.max(1, segs.length));
    var map = {};
    var others = S.cfg.topN.label || 'Others';
    segs.forEach(function (s, i) {
      if (spec && spec.color) {
        if (s.member === others && S.cfg.topN.enabled) map[s.member] = S.cfg.topN.color;
        else if (S.view.cmode === 'highlight') map[s.member] = (S.cfg.colors.highlight || []).indexOf(s.member) >= 0 ? S.cfg.colors.highlightColor : S.cfg.colors.mutedColor;
        else map[s.member] = dimColor(spec.level, s.member);
        return;
      }
      map[s.member] = BD.colorMode === 'custom' && BD.colors[s.member] ? BD.colors[s.member] : sh[i];
    });
    return map;
  }

  // Called from the other chart files as B.<name>(…).
  B.loadParams = loadParams;
  B.fillParams = fillParams;
  B.measureLabel = measureLabel;
  B.lineLabel = lineLabel;
  B.fieldLabel = fieldLabel;
  B.getEncodedFields = getEncodedFields;
  B.readSummaryData = readSummaryData;
  B.limitChanged = limitChanged;
  B.extract = extract;
  B.targetInfo = targetInfo;
  B.comboList = comboList;
  B.measurePanels = measurePanels;
  B.isSeriesField = isSeriesField;
  B.memberOf = memberOf;
  B.measureColor = measureColor;
  B.dimLevelOf = dimLevelOf;
  B.dimColor = dimColor;
  B.findNode = findNode;
  B.isDrilled = isDrilled;
  B.buildView = buildView;
  B.divOrder = divOrder;
  B.panelList = panelList;
  B.segSpec = segSpec;
  B.segmentsOf = segmentsOf;
  B.segColors = segColors;
})();
