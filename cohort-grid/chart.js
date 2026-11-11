'use strict';

/**
 * Cohort Grid — Tableau Viz Extension.
 *
 * Marks card tiles (declared in cohort-grid.trex):
 *   cohort   Cohort: 1 dimension (first-order month, sign-up week …), one row of the grid each.
 *   period   Period: 1 dimension, the time since the cohort started: a number (0, 1, 2 …)
 *            or a date (counted in months / weeks / days … from the cohort's date).
 *   value    Value: 1 measure, shown (and shaded) in every cell.
 *   size     Cohort size: optional measure; empty = the value of period 0.
 *
 * Header (icon, title, explanation) and card options are the same as in the other
 * extensions; everything else is set in the Format dialog (configure.html).
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc, toNumber = ExtCore.toNumber, isMN = ExtCore.isMN, isNumericCol = ExtCore.isNumericCol,
    cleanName = ExtCore.cleanName, findColumn = ExtCore.findColumn;

  var el = {};
  var worksheet = null;
  var cfg = null;
  var raw = null; // extracted data, see extract()
  var model = null; // what the last paint drew, see buildModel()
  var renderToken = 0;

  /** In-memory state (not saved). */
  var state = {
    ttRow: null, // summary-data row index Tableau's own tooltip is showing for
    ttOff: false // this Tableau has no hoverTupleAsync: use our own tooltip
  };

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'tools', 'exportBtn', 'body', 'plot', 'scroll', 'hint', 'tooltip', 'menu', 'toast'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.scroll.addEventListener('mousemove', onHover);
    el.scroll.addEventListener('mouseleave', function () { hideTooltip(); setHover(null); });
    el.scroll.addEventListener('contextmenu', onContextMenu);
    el.scroll.addEventListener('click', onClick);
    el.scroll.addEventListener('dblclick', onDblClick);
    el.scroll.addEventListener('scroll', function () { hideTooltip(); });
    el.exportBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      var r = el.exportBtn.getBoundingClientRect();
      showMenu(exportItems(), r.right, r.bottom + 4, true);
    });
    document.addEventListener('mousedown', function (e) {
      if (!el.menu.contains(e.target) && e.target !== el.exportBtn) hideMenu();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') { hideMenu(); hideTooltip(); } });
    window.addEventListener('blur', hideMenu);

    // Handshake recovery: the frame is reloaded (fresh handshake, up to 3 times in all) when
    // Tableau rejects the handshake, or when it hasn't answered within the timeout. Tableau
    // answers every extension through one queue for the whole dashboard, so each reload waits
    // a little longer; if the answer arrives before the reload fires, the reload is cancelled.
    // After the last reload it keeps waiting and offers a manual reload.
    var boot = window.ExtBoot || { attempt: 0, retry: function () { return false; }, ok: function () {} };
    var initDone = false;
    var hintTimer = setTimeout(function () {
      if (!initDone) showEmpty('Loading…');
    }, 2500);
    var initTimeout = INIT_TIMEOUT + INIT_TIMEOUT_STEP * boot.attempt;
    var watchdog = setTimeout(function () {
      if (initDone) return;
      if (!boot.retry('no handshake after ' + initTimeout / 1000 + ' s')) showRetry('Tableau has not answered yet.');
    }, initTimeout);

    if (window.ExtTiming) ExtTiming.mark('initializeAsync start', boot.attempt ? 'reload #' + boot.attempt : '');
    return tableau.extensions.initializeAsync({ configure: function () { return openDialog(null); } }).then(function () {
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      boot.ok();
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Cg.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, function () { refresh(); });
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () { cfg = Cg.read(); if (limitChanged()) refresh(); else paint(); }
      );

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      if (initDone) {
        console.error('Cohort Grid failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Cohort Grid failed to initialize:', err);
      if (!boot.retry('handshake failed')) showRetry();
    });
  }

  // Handshake timeout: 4 s on the first load, +2 s per reload (4, 6, 8, 10 s → about 28 s
  // before giving up). A late answer still draws the chart, even after giving up.
  var INIT_TIMEOUT = 4000;
  var INIT_TIMEOUT_STEP = 2000;

  /** A click reloads the extension. */
  function showRetry (why) {
    showEmpty((why || 'Could not connect to Tableau.') + '<br><u>Click to reload.</u>');
    el.hint.style.cursor = 'pointer';
    el.hint.onclick = function () { if (window.ExtBoot) ExtBoot.reload(); else location.reload(); };
  }

  var queued = false;
  var lastW = -1;
  var lastH = -1;
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var w = document.body.clientWidth; var h = document.body.clientHeight;
      if (w === lastW && h === lastH) return;
      lastW = w; lastH = h;
      paint();
    });
  }

  /**
   * Opens the Format dialog. `focus` ({ tab, item }) preselects a tab and an
   * item. The dialog gets the fields and members as payload, because it
   * can't read the worksheet itself.
   */
  function openDialog (focus) {
    hideMenu();
    hideTooltip();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify(dialogInfo(focus));
    var options = { width: 620, height: 780 };
    // On top (Modal) keeps the Format window in front of Tableau until Done; Floating (Modeless) lets you click the workbook but can fall behind it.
    var DS = tableau.DialogStyle || {};
    var style = cfg && cfg.interaction.dialog === 'floating' ? DS.Modeless : DS.Modal;
    if (style) options.dialogStyle = style;
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Cohort Grid dialog:', err && err.message);
    });
  }


  /** What the dialog needs to know: the field names (for hints). */
  function dialogInfo (focus) {
    var info = { focus: focus || null, cohortName: '', periodName: '', valueName: '', sizeName: '', periodIsDate: false, unit: '' };
    if (!raw) return info;
    info.cohortName = raw.cohortField.name;
    info.periodName = raw.periodField.name;
    info.valueName = raw.valueName;
    info.sizeName = raw.sizeName;
    info.periodIsDate = raw.periodIsDate;
    if (model) info.unit = model.unit;
    return info;
  }

  function fieldsSig (fields) {
    var out = {};
    Object.keys(fields).sort().forEach(function (k) {
      out[k] = fields[k].map(function (f) { return (f.id || '') + '|' + (f.name || ''); });
    });
    return JSON.stringify(out);
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  // Custom tiles (cohort-grid.trex: Cohort, Period, Value, Cohort size).
  var TILES = ['cohort', 'period', 'value', 'size'];

  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      var tFields = 0;
      var tData = 0;
      var fieldsP = getEncodedFields().then(function (r) { tFields = ms(); if (first) T.mark('fields received (Marks card)'); return r; });
      var dataP = readSummaryData().then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== renderToken) return;
      var fields = results[0];

      var missing = [['cohort', 'Cohort'], ['period', 'Period'], ['value', 'Value']].filter(function (t) { return !fields[t[0]].length; });
      if (missing.length) {
        raw = null;
        if (first) { T.mark('tiles missing'); T.done('Cohort Grid load timings'); }
        showEmpty('Drag a dimension onto <b>Cohort</b> (e.g. first-order month), a dimension onto <b>Period</b> ' +
          '(periods since the start: 0, 1, 2 … or a date) and a measure onto <b>Value</b>.<br>' +
          'Optional: <b>Cohort size</b>. Without it, the value in period 0 is the size.' +
          '<br><br>Still empty: ' + missing.map(function (t) { return '<b>' + t[1] + '</b>'; }).join(', ') + '.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      raw = extract(table, fields);
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Cohort Grid load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Cohort Grid render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Cohort Grid load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = {};
    TILES.forEach(function (t) { fields[t] = []; });
    marks.encodings.forEach(function (e) {
      if (!e.field) return;
      var type = String(e.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : e.id;
      if (fields[id]) fields[id].push(e.field);
    });
    return fields;
  }

  /**
   * The worksheet's summary data, up to the row limit in the settings (Format → Card → Maximum
   * rows; 0 = all). When rows were left out, a small note says so in the corner.
   */
  var lastLimit = null;
  async function readSummaryData (extra) {
    var limit = ExtCore.rowLimit(cfg.data.maxRows);
    var table = await ExtCore.readSummary(worksheet, { limit: limit, columnsToIncludeById: extra && extra.columnsToIncludeById });
    if (!extra) { lastLimit = limit; ExtCore.rowNotice(table); }
    return table;
  }

  /** True when the row limit in the settings no longer matches the data that was read. */
  function limitChanged () {
    return lastLimit != null && ExtCore.rowLimit(cfg.data.maxRows) !== lastLimit;
  }

  function isDateCol (c) { return /date/i.test(String(c.dataType || '')); }

  // ---------------------------------------------------------------------------
  // Extract: summary data → one record per data row
  // ---------------------------------------------------------------------------
  function cellText (cell) {
    if (!cell) return '';
    var f = cell.formattedValue;
    if (f == null || f === '%null%') f = cell.value;
    return f == null || f === '%null%' ? 'Null' : String(f);
  }

  function dateOf (cell, col, text) {
    if (!cell) return null;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    var d = col && isDateCol(col) ? Cg.parseDate(v) : Cg.parseDate(text != null ? text : v);
    return d ? d.getTime() : null;
  }

  /** Renamed pills: unmatched tiles take the free columns, in the order cohort, period, value, size. */
  function matchLeftovers (table, reqs, taken) {
    var free = function () { return table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); }); };
    var take = function (r, c) { if (c) { r.col = c; taken.push(c); r.guessed = true; } };
    reqs.forEach(function (r) {
      if (r.col) return;
      var f = free();
      var pick;
      if (r.dim) {
        pick = (r.tile === 'period' ? f.find(isDateCol) : null) || f.find(function (x) { return !isNumericCol(x); }) || f[0];
      } else {
        pick = f.find(isNumericCol) || f[0];
      }
      take(r, pick);
    });
    var guessed = reqs.filter(function (r) { return r.guessed; });
    if (guessed.length) {
      console.info('Cohort Grid: matched renamed fields by position:', guessed.map(function (r) { return r.tile + ' → ' + r.col.fieldName; }));
    }
  }

  /**
   * Summary data → { rows: [{ ck, cRaw, cDate, pRaw, pNum, pDate, v, sz, ix }], fields… }
   * ix = 0-based row of table.data (for Tableau's own tooltip). Rows with no value are dropped.
   */
  function extract (table, fields) {
    var reqs = [
      { tile: 'cohort', field: fields.cohort[0], dim: true },
      { tile: 'period', field: fields.period[0], dim: true },
      { tile: 'value', field: fields.value[0], dim: false }
    ];
    if (fields.size[0]) reqs.push({ tile: 'size', field: fields.size[0], dim: false });
    var taken = [];
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    matchLeftovers(table, reqs, taken);
    var by = {};
    reqs.forEach(function (r) { by[r.tile] = r; });
    var cC = by.cohort.col; var pC = by.period.col; var vC = by.value.col; var sC = by.size ? by.size.col : null;

    var rows = [];
    (table.data || []).forEach(function (row, ix) {
      var v = toNumber(row[vC.index]);
      if (!isFinite(v)) return;
      var cc = row[cC.index]; var pc = row[pC.index];
      var ptext = cellText(pc);
      var pn = toNumber(pc);
      if (!isFinite(pn)) { var mm = /-?\d+(\.\d+)?/.exec(ptext); pn = mm ? Number(mm[0]) : NaN; }
      var ctext = cellText(cc);
      rows.push({
        ck: ctext, cRaw: cc ? cc.value : null, cDate: dateOf(cc, cC, ctext),
        pRaw: pc ? pc.value : null, pNum: isDateCol(pC) ? NaN : pn, pDate: dateOf(pc, pC, ptext), ptext: ptext,
        v: v, sz: sC ? toNumber(row[sC.index]) : NaN, ix: ix
      });
    });
    var periodIsDate = isDateCol(pC) || (rows.length > 0 && rows.every(function (r) { return !isFinite(r.pNum); }) && rows.some(function (r) { return r.pDate != null; }));
    return {
      rows: rows,
      periodIsDate: periodIsDate,
      cohortField: { name: cleanName(by.cohort.field.name), fieldName: cC.fieldName, isDate: isDateCol(cC) },
      periodField: { name: cleanName(by.period.field.name), fieldName: pC.fieldName },
      valueName: cleanName(by.value.field.name),
      sizeName: sC ? cleanName(by.size.field.name) : ''
    };
  }

  // ---------------------------------------------------------------------------
  // Model: cohorts × periods, shown values, heat colours
  // ---------------------------------------------------------------------------
  var DAY = 86400000;

  function monthsBetween (a, b) { return (b.getFullYear() - a.getFullYear()) * 12 + b.getMonth() - a.getMonth(); }

  /** Number of whole `unit`s from the cohort's date to the period's date (negative = before the cohort). */
  function periodIndex (unit, cMs, pMs) {
    var a = new Date(cMs); var b = new Date(pMs);
    var days = Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / DAY);
    switch (unit) {
      case 'year': return b.getFullYear() - a.getFullYear();
      case 'quarter': return Math.floor(monthsBetween(a, b) / 3);
      case 'month': return monthsBetween(a, b);
      case 'week': return Math.floor(days / 7);
      default: return days;
    }
  }

  /** Smallest gap between neighbouring period dates (inside a cohort) decides the unit. */
  function detectUnit (groups) {
    var min = Infinity;
    var scan = function (list) {
      var ds = list.slice().sort(function (x, y) { return x - y; });
      for (var i = 1; i < ds.length; i++) { var d = (ds[i] - ds[i - 1]) / DAY; if (d > 0.5 && d < min) min = d; }
    };
    groups.forEach(function (g) { scan(Object.keys(g.pDates).map(Number)); });
    if (!isFinite(min)) scan(groups.map(function (g) { return g.date; }).filter(function (d) { return d != null; }));
    if (!isFinite(min)) return 'month';
    return min <= 1.5 ? 'day' : min <= 10 ? 'week' : min <= 40 ? 'month' : min <= 120 ? 'quarter' : 'year';
  }

  var MAX_PERIODS = 400;

  function pctFmt () {
    return Cg.fmtCopy({ scale: 'percent', decimals: cfg.values.decimals, pctFromRatio: true, thousands: true, unit: '' });
  }

  function periodLabel (n) { return String(cfg.headers.periodLabel || '{n}').replace(/\{n\}/g, String(n)); }

  function buildModel () {
    var V = cfg.values; var HT = cfg.heat;
    var groups = []; var byKey = {};
    raw.rows.forEach(function (r) {
      var g = byKey[r.ck];
      if (!g) { g = byKey[r.ck] = { key: r.ck, label: r.ck, raw: r.cRaw, date: r.cDate, pDates: {}, rows: [], cells: {}, size: null }; groups.push(g); }
      if (g.date == null && r.cDate != null) g.date = r.cDate;
      g.rows.push(r);
      if (r.pDate != null) g.pDates[r.pDate] = 1;
    });

    var unit = cfg.period.unit === 'auto' ? detectUnit(groups) : cfg.period.unit;
    var noDate = 0;
    groups.forEach(function (g) {
      g.rows.forEach(function (r) {
        var idx;
        if (raw.periodIsDate) {
          if (g.date == null || r.pDate == null) { noDate++; return; }
          idx = periodIndex(unit, g.date, r.pDate);
        } else {
          if (!isFinite(r.pNum)) return;
          idx = Math.round(r.pNum);
        }
        if (idx < 0) return;
        var c = g.cells[idx];
        if (!c) c = g.cells[idx] = { v: 0, ix: r.ix, pRaw: r.pRaw, ptext: r.ptext };
        c.v += r.v;
        if (g.size == null && isFinite(r.sz)) g.size = r.sz;
      });
      if (g.size == null && g.cells[0]) g.size = g.cells[0].v;
    });

    // cohorts: dates sort as dates, other names naturally
    var allDates = groups.length > 0 && groups.every(function (g) { return g.date != null; });
    var list = allDates
      ? Cg.sortBy(groups, function (a, b) { return a.date - b.date; })
      : Cg.sortBy(groups, Cg.comparer('name', null, function (g) { return g.label; }));
    var S = cfg.sort;
    if (S.lastCohorts > 0 && list.length > S.lastCohorts) list = list.slice(list.length - S.lastCohorts);
    if (S.cohorts === 'desc') list.reverse();

    // periods: every step from the first to the last one that has data
    var lo = Infinity; var hi = -Infinity;
    list.forEach(function (g) { Object.keys(g.cells).forEach(function (k) { k = +k; if (k < lo) lo = k; if (k > hi) hi = k; }); });
    var periods = [];
    if (isFinite(lo)) for (var k = lo; k <= hi && periods.length < MAX_PERIODS; k++) periods.push(k);
    if (S.firstPeriods > 0) periods = periods.slice(0, S.firstPeriods);

    // shown values
    var mode = V.show;
    list.forEach(function (g) {
      Object.keys(g.cells).forEach(function (k) {
        var c = g.cells[k];
        var prev = g.cells[k - 1];
        c.pct = g.size > 0 ? c.v / g.size : null;
        c.pctPrev = prev && prev.v > 0 ? c.v / prev.v : null;
        c.prevV = prev ? prev.v : null;
        c.d = mode === 'value' ? c.v : mode === 'pct' ? c.pct : c.pctPrev;
      });
    });
    if (V.hidePeriod0 && periods.length && periods[0] === 0) {
      var always = mode === 'pct'
        ? list.every(function (g) { var c = g.cells[0]; return !c || (c.pct != null && Math.abs(c.pct - 1) < 0.0005) || c.pct == null; }) && list.some(function (g) { return g.cells[0] && g.cells[0].pct != null; })
        : mode === 'pctPrev';
      if (always) periods = periods.slice(1);
    }

    // summary row: average of what is shown, per period
    var summary = periods.map(function (p) {
      var xs = [];
      list.forEach(function (g) { var c = g.cells[p]; if (c && c.d != null && isFinite(c.d)) xs.push(c.d); });
      return xs.length ? { d: xs.reduce(function (a, b) { return a + b; }, 0) / xs.length, n: xs.length, idx: p } : { d: null, n: 0, idx: p };
    });

    // heat range, in what the cells show (percent modes: fixed limits are typed as 0–100)
    var k100 = mode === 'value' ? 1 : 0.01;
    var rangeOf = function (xs) {
      var a = Infinity; var b = -Infinity;
      xs.forEach(function (x) { if (x < a) a = x; if (x > b) b = x; });
      if (!isFinite(a)) { a = 0; b = 1; }
      if (HT.minMode === 'fixed') a = Number(HT.min) * k100;
      if (HT.maxMode === 'fixed') b = Number(HT.max) * k100;
      return [a, b];
    };
    var shown = function (g, p) { var c = g.cells[p]; return c && c.d != null && isFinite(c.d) ? c.d : null; };
    var gridVals = [];
    list.forEach(function (g) { periods.forEach(function (p) { var d = shown(g, p); if (d != null) gridVals.push(d); }); });
    var gridRange = rangeOf(gridVals);

    var nf = mode === 'value' ? cfg.format : pctFmt();
    var textOf = function (d) {
      if (d == null) return V.emptyText;
      if (d === 0 && V.zeroText) return V.zeroText;
      return Cg.formatNumber(d, nf);
    };
    var colorOf = function (d, range) {
      var bg;
      if (HT.mode === 'ramp') {
        var span = range[1] - range[0];
        var t = span > 0 ? Math.max(0, Math.min(1, (d - range[0]) / span)) : 1;
        bg = Cg.mix(HT.low, HT.high, t);
      } else bg = HT.noneBg;
      return { bg: bg, fg: HT.mode === 'ramp' && HT.autoText ? Cg.contrastText(bg) : null };
    };

    var cohorts = list.map(function (g, ri) {
      var range = HT.scope === 'row' ? rangeOf(periods.map(function (p) { return shown(g, p); }).filter(function (x) { return x != null; })) : gridRange;
      return {
        g: g, ri: ri,
        cells: periods.map(function (p, pi) {
          var c = g.cells[p];
          if (!c) return { ri: ri, pi: pi, idx: p, g: g, empty: true, text: V.emptyText };
          var d = c.d;
          var cell = { ri: ri, pi: pi, idx: p, g: g, c: c, d: d, text: textOf(d), empty: d == null };
          if (d != null) { var col = colorOf(d, range); cell.bg = col.bg; cell.fg = col.fg; }
          return cell;
        })
      };
    });
    var sumRange = HT.scope === 'row' ? rangeOf(summary.map(function (s) { return s.d; }).filter(function (x) { return x != null; })) : gridRange;
    var sumCells = summary.map(function (s, pi) {
      var cell = { ri: -1, pi: pi, idx: s.idx, summary: true, d: s.d, n: s.n, text: textOf(s.d), empty: s.d == null };
      if (s.d != null) { var col = colorOf(s.d, sumRange); cell.bg = col.bg; cell.fg = col.fg; }
      return cell;
    });

    var maxLabel = 0; var maxSize = 0;
    list.forEach(function (g) {
      maxLabel = Math.max(maxLabel, String(g.label).length);
      if (g.size != null) maxSize = Math.max(maxSize, Cg.formatNumber(g.size, cfg.format).length);
    });
    if (cfg.layout.summary !== 'none') maxLabel = Math.max(maxLabel, String(cfg.layout.summaryLabel).length);

    return {
      cohorts: cohorts, periods: periods, summary: sumCells, unit: unit, mode: mode, noDate: noDate,
      hasSize: list.some(function (g) { return g.size != null; }),
      maxLabel: maxLabel, maxSize: maxSize, nf: nf, truncated: isFinite(hi) && hi - lo + 1 > MAX_PERIODS
    };
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg || !raw) return;
    var m;
    try {
      m = buildModel();
    } catch (e) {
      console.error('Cohort Grid: could not build the grid', e);
      showEmpty('Could not draw the grid. Click the ! mark in the corner for details.');
      return;
    }
    model = m;
    if (!m.cohorts.length || !m.periods.length) {
      if (raw.periodIsDate && m.noDate && !m.periods.length) {
        showEmpty('The cohorts could not be read as dates, so the periods cannot be counted.<br>Use a date (or a date part such as month and year) on <b>Cohort</b>, or a number on <b>Period</b>.');
      } else {
        showEmpty('No values to show. Check that <b>Period</b> counts from the cohort start (0, 1, 2 … or a date on or after the cohort).');
      }
      return;
    }
    el.card.classList.remove('is-empty');
    hideTooltip();
    paintCard();
    paintHeader();
    paintTools();
    drawGrid(m);
  }

  function textCss (s) {
    return 'font-family:' + Cg.fontStack(s.font) + ';font-size:' + s.size + 'px;font-weight:' + s.weight +
      ';font-style:' + (s.italic ? 'italic' : 'normal') + ';color:' + s.color +
      (s.upper != null ? ';text-transform:' + (s.upper ? 'uppercase' : 'none') : '') +
      (s.letterSpacing ? ';letter-spacing:' + (s.letterSpacing / 100) + 'em' : '');
  }

  /** Opaque fill for frozen headers (so scrolled cells don't show through): Card colour with the area and header fills on top. */
  function solidBg () {
    var H = cfg.headers; var c = cfg.card;
    var bg = c.bgColor || '#FFFFFF';
    if (c.plotBgOpacity > 0) bg = Cg.mix(bg, c.plotBg, Math.min(1, c.plotBgOpacity / 100));
    if (H.bgOpacity > 0) bg = Cg.mix(bg, H.bg, Math.min(1, H.bgOpacity / 100));
    return bg;
  }

  function css () {
    var L = cfg.layout; var H = cfg.headers; var HT = cfg.heat; var C = cfg.cells; var I = cfg.interaction;
    var g = L.gap / 2;
    var hb = H.bgOpacity > 0 ? Cg.rgba(H.bg, H.bgOpacity / 100) : 'transparent';
    var s = [];
    s.push('.cg{font-family:' + Cg.fontStack(cfg.numbers.font) + '}');
    s.push('.cg td.c{height:' + L.rowHeight + 'px;border:' + g + 'px solid transparent;background-clip:padding-box;border-radius:' + (L.radius + g) + 'px;' + textCss(C.main) + '}');
    s.push('.cg td.c.e{background-color:' + Cg.rgba(HT.emptyBg, HT.emptyOpacity / 100) + ';color:#8C96A3}');
    s.push('.cg td.c.sm{font-weight:' + (H.summaryBold ? 800 : C.main.weight) + '}');
    s.push('.cg th{background:' + hb + ';padding:' + g + 'px}');
    s.push('.cg th.ch{' + textCss(H.col) + ';text-align:' + H.colAlign + ';vertical-align:bottom;padding-bottom:' + (g + 3) + 'px}');
    s.push('.cg th.rh{' + textCss(H.row) + '}');
    s.push('.cg th.rh .sz,.cg th.k .sz{' + textCss(H.size) + '}');
    s.push('.cg th.k{' + textCss(H.cornerStyle) + ';vertical-align:bottom;text-align:left;padding-bottom:' + (g + 3) + 'px}');
    s.push('.cg th.rh.sm .lb{font-weight:' + (H.summaryBold ? 800 : H.row.weight) + '}');
    if (L.freeze) {
      s.push('.cg thead th,.cg th.rh{position:sticky}.cg thead th{top:0;z-index:2}.cg th.rh{left:0;z-index:1}.cg thead th.k{z-index:3;left:0}');
      var sb = solidBg();
      s.push('.cg.scrolls thead th,.cg.scrolls th.rh{background:' + sb + '}');
    }
    if (I.hover) s.push('.cg td.c.hot{box-shadow:inset 0 0 0 2px ' + I.hoverColor + '}');
    return s.join('\n');
  }

  function labelPx () {
    var H = cfg.headers; var L = cfg.layout;
    var w = model.maxLabel * H.row.size * 0.62 + 10;
    if (L.showSize && model.hasSize) w += Math.max(model.maxSize, String(H.sizeLabel).length) * H.size.size * 0.6 + 16;
    return Math.round(Math.max(64, Math.min(260, w)));
  }

  function rowHeadHtml (label, size, cls, ri) {
    var L = cfg.layout;
    var sz = L.showSize && model.hasSize ? '<span class="sz">' + (size != null ? esc(Cg.formatNumber(size, cfg.format)) : '') + '</span>' : '';
    return '<th class="rh' + cls + '"' + (ri != null ? ' data-r="' + ri + '"' : '') + '><div class="in"><span class="lb" title="' + esc(label) + '">' + esc(label) + '</span>' + sz + '</div></th>';
  }

  function cellHtml (c) {
    var cls = 'c' + (c.empty ? ' e' : '') + (c.summary ? ' sm' : '');
    var st = '';
    if (c.bg) st += 'background-color:' + c.bg + ';';
    if (c.fg) st += 'color:' + c.fg + ';';
    return '<td class="' + cls + '" data-r="' + (c.summary ? 's' : c.ri) + '" data-p="' + c.pi + '"' + (st ? ' style="' + st + '"' : '') + '>' + esc(c.text) + '</td>';
  }

  function summaryRow (m) {
    var L = cfg.layout;
    return '<tr class="sr">' + rowHeadHtml(L.summaryLabel, null, ' sm') + m.summary.map(cellHtml).join('') + '</tr>';
  }

  function drawGrid (m) {
    var L = cfg.layout; var H = cfg.headers;
    var lw = labelPx();
    var parts = [];
    parts.push('<style>' + css() + '</style>');
    parts.push('<table class="cg" id="grid"><colgroup><col class="cl" style="width:' + lw + 'px">');
    m.periods.forEach(function () { parts.push('<col class="cd">'); });
    parts.push('</colgroup><thead><tr>');
    parts.push('<th class="k"><div class="in"><span class="lb">' + esc(H.cornerText) + '</span>' +
      (L.showSize && m.hasSize ? '<span class="sz">' + esc(H.sizeLabel) + '</span>' : '') + '</div></th>');
    m.periods.forEach(function (p, pi) {
      parts.push('<th class="ch" data-p="' + pi + '"><span class="tx">' + esc(periodLabel(p)) + '</span></th>');
    });
    parts.push('</tr></thead><tbody>');
    if (L.summary === 'top') parts.push(summaryRow(m));
    m.cohorts.forEach(function (r) {
      parts.push('<tr data-r="' + r.ri + '">' + rowHeadHtml(r.g.label, r.g.size, '', r.ri) + r.cells.map(cellHtml).join('') + '</tr>');
    });
    if (L.summary === 'bottom') parts.push(summaryRow(m));
    parts.push('</tbody></table>');
    el.scroll.innerHTML = parts.join('');
    el.table = el.scroll.querySelector('table');
    el.hot = null;
    layoutTable(m, lw);
  }

  /** Column widths: the periods share the width, never narrower than the minimum; the grid scrolls when they don't fit. */
  function layoutTable (m, lw) {
    var L = cfg.layout;
    var t = el.table;
    var cols = t.querySelectorAll('col.cd');
    var n = cols.length;
    var avail = el.scroll.clientWidth;
    var room = avail - lw;
    var w = Math.max(L.cellMinWidth, Math.floor(room / Math.max(1, n)));
    var spare = w === Math.floor(room / Math.max(1, n)) ? Math.max(0, room - w * n) : 0;
    var total = lw;
    Array.prototype.forEach.call(cols, function (c, i) {
      var x = w + (i < spare ? 1 : 0);
      c.style.width = x + 'px';
      total += x;
    });
    t.style.width = total + 'px';
    var sc = el.scroll;
    t.classList.toggle('scrolls', !!L.freeze && (sc.scrollHeight > sc.clientHeight + 1 || sc.scrollWidth > sc.clientWidth + 1));
  }

  // ---------------------------------------------------------------------------
  // Hover and tooltip
  // ---------------------------------------------------------------------------
  function cellFromEvent (e) {
    var td = e.target.closest ? e.target.closest('td.c') : null;
    if (!td || !model) return null;
    var r = td.getAttribute('data-r'); var pi = Number(td.getAttribute('data-p'));
    var c = r === 's' ? model.summary[pi] : model.cohorts[Number(r)] && model.cohorts[Number(r)].cells[pi];
    return c ? { c: c, td: td } : null;
  }

  function headFromEvent (e) {
    var th = e.target.closest ? e.target.closest('th') : null;
    if (!th || !model) return null;
    if (th.classList.contains('rh') && th.hasAttribute('data-r')) return { kind: 'cohort', g: model.cohorts[Number(th.getAttribute('data-r'))].g };
    if (th.classList.contains('ch')) return { kind: 'period', idx: model.periods[Number(th.getAttribute('data-p'))] };
    return { kind: 'other' };
  }

  function setHover (td) {
    if (el.hot === td) return;
    if (el.hot) el.hot.classList.remove('hot');
    el.hot = td;
    if (td) td.classList.add('hot');
  }

  function onHover (e) {
    if (!cfg || el.menu.style.display === 'block') return;
    var d = cellFromEvent(e);
    if (!d) { hideTooltip(); setHover(null); return; }
    setHover(d.td);
    if (cfg.interaction.tableauTooltip && !state.ttOff) {
      el.tooltip.style.display = 'none';
      var ix = d.c.c ? d.c.c.ix : null;
      if (ix == null) { tableauTipOff(); return; }
      if (ix !== state.ttRow) {
        if (ExtCore.hoverTooltip(worksheet, ix, { x: e.clientX, y: e.clientY })) { state.ttRow = ix; return; }
        state.ttOff = true; // this Tableau has no such call: our own tooltip for the rest of the session
      } else return;
    }
    if (!cfg.tooltip.show) return;
    showTooltip(d.c, e.clientX, e.clientY);
  }

  function tableauTipOff () {
    if (state.ttRow != null) {
      state.ttRow = null;
      ExtCore.hoverTooltip(worksheet, null);
    }
  }

  function ttRow (name, val) {
    return '<div class="tt-row"><span class="nm">' + esc(name) + '</span><span class="vl">' + esc(val) + '</span></div>';
  }

  function fullNum (v) { return Cg.formatNumber(v, cfg.format, { full: cfg.tooltip.fullNumbers }); }
  function pctText (x) { return x == null ? '—' : Cg.formatNumber(x, Cg.fmtCopy({ scale: 'percent', decimals: Math.max(1, cfg.values.decimals), pctFromRatio: true })); }

  function showTooltip (c, x, y) {
    var tt = el.tooltip;
    var h = [];
    if (c.summary) {
      h.push('<div class="tt-name">' + esc(cfg.layout.summaryLabel) + '</div>');
      h.push('<div class="tt-path">' + esc(periodLabel(c.idx)) + '</div>');
      if (c.d == null) h.push('<div class="tt-note">No data</div>');
      else {
        h.push('<div class="tt-value">' + esc(model.mode === 'value' ? fullNum(c.d) : pctText(c.d)) + '</div>');
        h.push('<div class="tt-note">Average of ' + c.n + ' cohort' + (c.n === 1 ? '' : 's') + '</div>');
      }
    } else {
      var g = c.g;
      h.push('<div class="tt-path">' + esc(raw.cohortField.name) + '</div><div class="tt-name">' + esc(g.label) + '</div>');
      var pl = periodLabel(c.idx);
      h.push('<div class="tt-path">' + esc(raw.periodField.name) + '</div><div class="tt-name">' + esc(pl + (raw.periodIsDate && c.c && c.c.ptext ? ' · ' + c.c.ptext : '')) + '</div>');
      if (!c.c) {
        h.push('<div class="tt-note">No data</div>');
      } else {
        var k = c.c;
        h.push('<div class="tt-series">' + esc(raw.valueName) + '</div><div class="tt-value">' + esc(fullNum(k.v)) + '</div>');
        var rows = [];
        if (g.size != null) rows.push(ttRow(raw.sizeName || 'Cohort size', fullNum(g.size)));
        rows.push(ttRow('% of cohort size', pctText(k.pct)));
        if (k.prevV != null) {
          var diff = k.v - k.prevV;
          var rel = k.prevV > 0 ? ' (' + (diff >= 0 ? '+' : '−') + pctText(Math.abs(diff / k.prevV)) + ')' : '';
          rows.push(ttRow('% of previous period', pctText(k.pctPrev)));
          rows.push(ttRow('Change vs previous', (diff >= 0 ? '+' : '−') + Cg.formatNumber(Math.abs(diff), cfg.format, { full: cfg.tooltip.fullNumbers }) + rel));
        } else if (c.idx > 0) {
          rows.push(ttRow('Change vs previous', '—'));
        }
        h.push('<div class="tt-rows">' + rows.join('') + '</div>');
      }
    }
    tt.innerHTML = h.join('');
    tt.style.fontFamily = Cg.fontStack(cfg.numbers.font);
    tt.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var tw = tt.offsetWidth;
    var th = tt.offsetHeight;
    var left = Math.min(Math.max(4, x + 14), vw - tw - 4);
    var top = y - th - 12;
    if (top < 4) top = Math.min(y + 18, vh - th - 4);
    tt.style.left = left + 'px';
    tt.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip () {
    if (el.tooltip) el.tooltip.style.display = 'none';
    tableauTipOff();
  }

  // ---------------------------------------------------------------------------
  // Clicks
  // ---------------------------------------------------------------------------
  function onClick (e) {
    if (!model) return;
    var d = cellFromEvent(e);
    if (d) { if (cfg.interaction.selectInTableau && !d.c.summary && d.c.c) selectInTableau(d.c.g, d.c.c); return; }
    var hd = headFromEvent(e);
    if (hd && hd.kind === 'cohort' && cfg.interaction.selectInTableau) selectInTableau(hd.g, null);
  }

  function onDblClick (e) {
    if (!cfg || cfg.interaction.dblclick !== 'format') return;
    var d = cellFromEvent(e);
    if (d) { openDialog({ tab: 'heat' }); return; }
    if (headFromEvent(e)) openDialog({ tab: 'headers' });
  }

  /** Selects the cohort (a label click) or the cohort and period (a cell click), by the raw values of the summary data. */
  function selectInTableau (g, cell) {
    var sel = [{ fieldName: raw.cohortField.fieldName, value: [g.raw] }];
    if (cell && cell.pRaw != null) sel.push({ fieldName: raw.periodField.fieldName, value: [cell.pRaw] });
    ExtCore.select(worksheet, sel, 'Cohort Grid');
  }


  function defaultTitle () {
    return raw.valueName + ' by ' + raw.cohortField.name;
  }

  function applyFont (node, f) {
    node.style.fontFamily = Cg.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Cg.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.body.style.marginTop = c.gap + 'px';
    el.plot.style.backgroundColor = c.plotBgOpacity > 0 ? Cg.rgba(c.plotBg, c.plotBgOpacity / 100) : 'transparent';
  }

  function paintHeader () {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Cg.iconHtml(ic.builtinId, ic.color, iconTarget());
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

    var t = cfg.title;
    applyFont(el.title, t);
    el.title.textContent = t.text || defaultTitle();
    el.title.style.textAlign = t.align || 'left';
    el.title.style.display = t.show === false ? 'none' : '';

    var ex = cfg.explanation;
    var hasText = ex.show && !!ex.text;
    applyFont(el.explanation, ex);
    el.explanation.style.textAlign = t.align || 'left';
    el.explanation.textContent = hasText ? ex.text : ' ';
    el.explanation.style.display = hasText || ex.reserveSpace ? '' : 'none';

    var headVisible = showIcon || t.show !== false || hasText || ex.reserveSpace;
    el.card.classList.toggle('no-head', !headVisible);
    if (!headVisible) el.body.style.marginTop = '0px';
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

  function paintTools () {
    var mode = cfg.export.button;
    el.tools.style.display = mode === 'never' ? 'none' : '';
    el.card.classList.toggle('tools-hover', mode === 'hover');
    el.card.classList.toggle('tools-always', mode === 'always');
  }

  // ---------------------------------------------------------------------------
  // Table

  // ---------------------------------------------------------------------------
  // Right-click menu, export menu, toast
  // ---------------------------------------------------------------------------
  function exportItems () {
    return [
      { head: 'Export' },
      ['Excel — grid as shown (.xlsx)', function () { exportXlsx('visual'); }],
      ['Excel — data (.xlsx)', function () { exportXlsx('data'); }],
      ['CSV — grid as shown (.csv)', function () { exportCsv('grid'); }],
      ['CSV — data (.csv)', function () { exportCsv('data'); }],
      null,
      ['Copy grid (paste into Excel)', copyTable]
    ].concat(pictureItems());
  }

  /** "Save as picture" entries (PNG only: the grid is HTML). full: the whole scrollable grid, not just what is visible. */
  function pictureItems () {
    if (!cfg.export.picture || !window.ExtSnapshot) return [];
    var out = [null];
    ExtSnapshot.menuItems({ element: el.card, title: function () { return cfg.export.fileName || cfg.title.text || defaultTitle(); }, full: true }).forEach(function (it) {
      out.push([it.label, function () {
        var p;
        try { p = it.run(); } catch (e) { p = Promise.reject(e); }
        if (p && p.catch) p.catch(function (err) { console.error(err); toast('Couldn’t save the picture. ' + (err && err.message ? err.message : ''), true); });
      }]);
    });
    return out;
  }

  function check (on, text) { return (on ? '✓ ' : '  ') + text; }

  /** Changes a saved setting from the chart (works while authoring; viewers keep it for the session). */
  function setSaved (fn) {
    var c = Cg.read();
    fn(c);
    fn(cfg);
    paint();
    try {
      Cg.write(c).catch(function (err) { console.info('Cohort Grid: setting kept for this session only', err && err.message); });
    } catch (e) { /* read-only */ }
  }

  function onContextMenu (e) {
    if (!cfg || !cfg.interaction.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    var items = [];
    var d = cellFromEvent(e);
    var hd = d ? null : headFromEvent(e);
    if (d && !d.c.summary) {
      items.push({ head: d.c.g.label + '  ×  ' + periodLabel(d.c.idx) });
      if (!d.c.empty) items.push(['Copy value', function () { copyPlain(d.c.text, 'Value copied'); }]);
      items.push(['Format heat map…', function () { openDialog({ tab: 'heat' }); }]);
    } else if (d) {
      items.push({ head: cfg.layout.summaryLabel + '  ×  ' + periodLabel(d.c.idx) });
      items.push(['Format summary row…', function () { openDialog({ tab: 'layout' }); }]);
    } else if (hd) {
      items.push(['Format headers…', function () { openDialog({ tab: 'headers' }); }]);
    }
    if (d || hd) items.push(null);
    items.push({ head: 'Cells show' });
    [['value', 'Value'], ['pct', '% of cohort size'], ['pctPrev', '% of previous period']].forEach(function (o) {
      items.push([check(cfg.values.show === o[0], o[1]), function () { setSaved(function (x) { x.values.show = o[0]; }); }]);
    });
    items.push(null);
    items.push([check(cfg.layout.summary !== 'none', 'Average row'), function () { setSaved(function (x) { x.layout.summary = x.layout.summary === 'none' ? 'bottom' : 'none'; }); }]);
    items.push([check(cfg.sort.cohorts === 'desc', 'Newest cohort first'), function () { setSaved(function (x) { x.sort.cohorts = x.sort.cohorts === 'desc' ? 'asc' : 'desc'; }); }]);
    items.push(null);
    items = items.concat(exportItems().slice(1));
    items.push(null, ['Layout…', function () { openDialog({ tab: 'layout' }); }], ['Format extension…', function () { openDialog(null); }]);
    showMenu(items, e.clientX, e.clientY);
  }

  function showMenu (items, x, y, alignRight) {
    var m = el.menu;
    m.innerHTML = '';
    var prevSep = true;
    items.forEach(function (it, i) {
      if (!it) {
        var nextReal = items.slice(i + 1).some(Boolean);
        if (!prevSep && nextReal) m.appendChild(document.createElement('hr'));
        prevSep = true; return;
      }
      prevSep = false;
      if (it.head) { var hd = document.createElement('div'); hd.className = 'menu-head'; hd.textContent = it.head; m.appendChild(hd); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', function () { hideMenu(); it[1](); });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var left = alignRight ? x - m.offsetWidth : x;
    m.style.left = Math.max(2, Math.min(left, vw - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(2, Math.min(y, vh - m.offsetHeight - 4)) + 'px';
  }

  function hideMenu () {
    if (el.menu) el.menu.style.display = 'none';
  }

  var toastTimer = null;
  function toast (text, error) {
    el.toast.textContent = text;
    el.toast.classList.toggle('is-error', !!error);
    el.toast.style.display = 'block';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.toast.style.display = 'none'; }, error ? 7000 : 4500);
  }

  // ---------------------------------------------------------------------------
  // Export: what is shown (CSV / XLSX), the data behind it, copy to clipboard
  // ---------------------------------------------------------------------------
  function baseName () {
    var n = cfg.export.fileName || (cfg.title.text || defaultTitle());
    n = String(n).replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) || 'Cohort grid';
    var d = new Date();
    return n + ' ' + d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }

  function saved (ok, name) {
    if (ok) toast('Downloaded ' + name + '. If nothing appeared (Tableau Desktop can block downloads), use “Copy grid” and paste into Excel.');
    else toast('Download isn’t available here. Use “Copy grid” and paste into Excel.', true);
  }

  function pt (px) { return Math.round(Number(px) * 0.75 * 10) / 10; }

  function fontSpec (s, colorOver) {
    return { name: String(s.font || cfg.numbers.font || 'Lato'), size: pt(s.size), bold: Number(s.weight) >= 600, italic: !!s.italic, color: colorOver || s.color };
  }

  /** Excel number format of a shown cell. */
  function cellNumFmt () {
    if (model.mode === 'value') return null;
    var dec = Math.max(0, Math.min(6, Number(cfg.values.decimals) || 0));
    return '0' + (dec ? '.' + new Array(dec + 1).join('0') : '') + '%';
  }

  /** The grid as plain text rows: header, then one row per cohort (and the summary row). */
  function gridRows () {
    var m = model; var L = cfg.layout;
    var withSize = L.showSize && m.hasSize;
    var head = [cfg.headers.cornerText].concat(withSize ? [cfg.headers.sizeLabel] : [], m.periods.map(periodLabel));
    var line = function (label, size, cells) {
      return [label].concat(withSize ? [size != null ? Cg.formatNumber(size, cfg.format) : ''] : [], cells.map(function (c) { return c.text; }));
    };
    var rows = [head];
    if (L.summary === 'top') rows.push(line(L.summaryLabel, null, m.summary));
    m.cohorts.forEach(function (r) { rows.push(line(r.g.label, r.g.size, r.cells)); });
    if (L.summary === 'bottom') rows.push(line(L.summaryLabel, null, m.summary));
    return rows;
  }

  /** The grid as sheet cells, the way it is drawn (heat colours, number formats). */
  function visualSheet (noTitle) {
    var m = model; var L = cfg.layout; var H = cfg.headers;
    var withSize = L.showSize && m.hasSize;
    var nLab = withSize ? 2 : 1;
    var totalCols = nLab + m.periods.length;
    var cells = []; var merges = []; var heights = [];
    var put = function (r, c, v) { (cells[r] = cells[r] || [])[c] = v; };
    var top = 0;
    if (cfg.export.includeTitle && !noTitle) {
      if (cfg.title.show !== false) {
        put(0, 0, { v: cfg.title.text || defaultTitle(), s: { font: fontSpec(cfg.title) } });
        if (totalCols > 1) merges.push([0, 0, 0, totalCols - 1]);
        heights[0] = Math.max(20, cfg.title.size * 1.6);
        top = 1;
      }
      if (cfg.explanation.show && cfg.explanation.text) {
        put(top, 0, { v: cfg.explanation.text, s: { font: fontSpec(cfg.explanation) } });
        if (totalCols > 1) merges.push([top, 0, top, totalCols - 1]);
        top++;
      }
      if (top) top++;
    }
    var hdrFill = H.bgOpacity > 0 ? H.bg : null;
    var hs = function (st, h) { return { font: fontSpec(st), fill: hdrFill, align: { h: h, v: 'bottom' } }; };
    put(top, 0, { v: H.cornerText, s: hs(H.cornerStyle, 'left') });
    if (withSize) put(top, 1, { v: H.sizeLabel, s: hs(H.size, 'right') });
    m.periods.forEach(function (p, i) { put(top, nLab + i, { v: periodLabel(p), s: hs(H.col, H.colAlign) }); });
    var r = top + 1;
    var nf = cellNumFmt();
    var cellOut = function (c) {
      if (c.empty || c.d == null) return c.text ? { v: c.text, s: { font: fontSpec(cfg.cells.main, '#8C96A3'), align: { h: 'center', v: 'middle' } } } : null;
      var v = m.mode === 'value' ? Cg.excelValue(c.d, cfg.format) : c.d;
      var fmt = nf || Cg.excelNumFmt(cfg.format, c.d);
      return { v: v, s: { font: fontSpec(cfg.cells.main, c.fg || null), fill: c.bg || null, align: { h: 'center', v: 'middle' }, numFmt: fmt } };
    };
    var addRow = function (label, size, cs, bold) {
      var st = hs(H.row, 'left');
      if (bold) st.font.bold = true;
      put(r, 0, { v: label, s: st });
      if (withSize) put(r, 1, size != null ? { v: size, s: { font: fontSpec(H.size), align: { h: 'right', v: 'middle' }, numFmt: Cg.excelNumFmt(cfg.format, size) } } : null);
      cs.forEach(function (c, i) { var o = cellOut(c); if (o) put(r, nLab + i, o); });
      heights[r] = Math.max(18, L.rowHeight * 0.75);
      r++;
    };
    if (L.summary === 'top') addRow(L.summaryLabel, null, m.summary, true);
    m.cohorts.forEach(function (row) { addRow(row.g.label, row.g.size, row.cells); });
    if (L.summary === 'bottom') addRow(L.summaryLabel, null, m.summary, true);
    var widths = [];
    widths[0] = Math.min(220, Math.max(72, (m.maxLabel + 2) * 7));
    if (withSize) widths[1] = Math.max(64, Math.min(120, (m.maxSize + 2) * 7));
    m.periods.forEach(function (p, i) { widths[nLab + i] = Math.max(52, L.cellMinWidth * 0.9); });
    return { name: 'Cohort grid', cells: cells, merges: merges, colWidths: widths, rowHeights: heights, freeze: { rows: top + 1, cols: 1 }, gridLines: false };
  }

  /** One row per cohort and period that has data: the numbers behind the grid. */
  function dataTable () {
    var m = model;
    var head = [raw.cohortField.name, raw.periodField.name, 'Period number', raw.valueName, m.hasSize ? (raw.sizeName || 'Cohort size') : null, '% of cohort size', '% of previous period']
      .filter(function (x) { return x != null; });
    var out = [];
    m.cohorts.forEach(function (r) {
      m.periods.forEach(function (p, pi) {
        var c = r.cells[pi];
        if (!c || !c.c) return;
        var k = c.c;
        var rec = [r.g.label, raw.periodIsDate && k.ptext ? k.ptext : periodLabel(p), p, k.v];
        if (m.hasSize) rec.push(r.g.size);
        rec.push(k.pct, k.pctPrev);
        out.push(rec);
      });
    });
    return { head: head, rows: out, nText: 2, pct: [head.length - 2, head.length - 1] };
  }

  function exportXlsx (kind) {
    if (!model) return;
    var name = baseName() + '.xlsx';
    try {
      var sheet;
      if (kind === 'data') {
        var d = dataTable();
        var hs = { font: { name: 'Calibri', size: 11, bold: true, color: '#FFFFFF' }, fill: '#27357E', align: { v: 'middle', wrap: true } };
        var cells = [d.head.map(function (x) { return { v: x, s: hs }; })];
        d.rows.forEach(function (rec) {
          cells.push(rec.map(function (v, i) {
            if (i < d.nText || v == null) return v == null ? null : { v: v };
            if (d.pct.indexOf(i) >= 0) return { v: v, s: { numFmt: '0.0%' } };
            if (i === 2) return { v: v };
            return { v: Cg.excelValue(v, cfg.format), s: { numFmt: Cg.excelNumFmt(cfg.format, v) } };
          }));
        });
        var widths = d.head.map(function (h) { return Math.min(300, Math.max(72, String(h).length * 8 + 18)); });
        sheet = { name: 'Data', cells: cells, colWidths: widths, freeze: { rows: 1, cols: 0 }, autoFilter: 'A1:' + CgExport.colName(d.head.length - 1) + (d.rows.length + 1) };
      } else {
        sheet = visualSheet();
      }
      saved(CgExport.download(CgExport.xlsx([sheet]), name), name);
    } catch (e) {
      console.error('Cohort Grid: Excel export failed', e);
      toast('Excel export failed: ' + (e && e.message), true);
    }
  }

  function exportCsv (kind) {
    if (!model) return;
    var name = baseName() + '.csv';
    try {
      var rows;
      if (kind === 'data') { var d = dataTable(); rows = [d.head].concat(d.rows); } else rows = gridRows();
      saved(CgExport.download(CgExport.csv(rows), name, 'text/csv;charset=utf-8'), name);
    } catch (e) {
      console.error('Cohort Grid: CSV export failed', e);
      toast('CSV export failed: ' + (e && e.message), true);
    }
  }

  /** Copies the grid as an HTML table (keeps the heat colours in Excel) plus tab-separated text. */
  function copyTable () {
    if (!model) return;
    var rows = gridRows();
    var m = model; var L = cfg.layout;
    var nLab = L.showSize && m.hasSize ? 2 : 1;
    var cellAt = {};
    var body = [];
    if (L.summary === 'top') body.push(m.summary);
    m.cohorts.forEach(function (r) { body.push(r.cells); });
    if (L.summary === 'bottom') body.push(m.summary);
    body.forEach(function (cs, k) { cs.forEach(function (c, i) { cellAt[(k + 1) + ',' + (nLab + i)] = c; }); });
    var html = ['<table style="border-collapse:collapse">'];
    rows.forEach(function (line, r) {
      html.push('<tr>');
      line.forEach(function (txt, c) {
        var cell = cellAt[r + ',' + c];
        var st = 'font-family:Calibri;font-size:11pt;padding:3px 6px;' + (r === 0 || c < nLab ? 'font-weight:bold;' : 'text-align:center;');
        if (cell && cell.bg) st += 'background:' + cell.bg + ';' + (cell.fg ? 'color:' + cell.fg + ';' : '');
        html.push('<td style="' + st + '">' + esc(txt) + '</td>');
      });
      html.push('</tr>');
    });
    html.push('</table>');
    copyRich(html.join(''), rows.map(function (l) { return l.join('\t'); }).join('\n'), 'Grid copied. Paste it into Excel, Sheets or an email.');
  }

  function copyRich (html, text, msg) {
    var done = false;
    var handler = function (e) {
      try {
        e.clipboardData.setData('text/html', html);
        e.clipboardData.setData('text/plain', text);
        e.preventDefault();
        done = true;
      } catch (x) { /* fall back below */ }
    };
    document.addEventListener('copy', handler);
    try { document.execCommand('copy'); } catch (x) { /* ignore */ }
    document.removeEventListener('copy', handler);
    if (done) { toast(msg); return; }
    if (navigator.clipboard && window.ClipboardItem) {
      navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })])
        .then(function () { toast(msg); }, function () { toast('Couldn’t copy here. Use an export instead.', true); });
    } else {
      toast('Couldn’t copy here. Use an export instead.', true);
    }
  }

  function copyPlain (text, msg) { copyRich(esc(text), text, msg); }

  // ---------------------------------------------------------------------------
  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  window.CohortGrid = {
    init: init,
    _state: state,
    _model: function () { return model; },
    _export: { xlsx: exportXlsx, csv: exportCsv, visualSheet: function () { return visualSheet(); }, dataTable: function () { return dataTable(); }, grid: function () { return gridRows(); } }
  };
})();
