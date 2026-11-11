'use strict';

/**
 * Maturity Ladder — Tableau Viz Extension.
 *
 * Marks card tiles (declared in maturity-ladder.trex):
 *   date     Maturity date (1-3 date fields: an exact date or date parts such as YEAR + MONTH)
 *   amount   Amount (1 measure)
 *   color    Group (optional dimension: stacks each bar)
 *   detail   Item (optional dimension: items listed in the tooltip and counted)
 * Tableau's own Tooltip tile is accepted too (its fields only add rows).
 *
 * Each row is put into a time bucket (week / month / quarter / year, or automatic), bars are stacked
 * by group, with an optional Today marker and running-total line. Everything else is set in the Format
 * dialog (configure.html), which also opens from a right-click on the chart.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc, toNumber = ExtCore.toNumber, isMN = ExtCore.isMN, isNumericCol = ExtCore.isNumericCol,
    findColumn = ExtCore.findColumn;

  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null; // see extract()
  var lastM = null; // buckets as drawn (see buildBuckets())
  var drawn = [];   // buckets by index, for hit tests
  var renderToken = 0;
  var selected = null;    // index of the bucket selected in Tableau (others are dimmed)
  var selectedKey = null; // bucket index + group, to toggle the selection off with a second click
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'plot', 'svg', 'hint', 'tooltip', 'menu'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.svg.addEventListener('mousemove', onHover);
    el.svg.addEventListener('mouseleave', onLeave);
    el.svg.addEventListener('contextmenu', onContextMenu);
    el.svg.addEventListener('click', onBarClick);
    document.addEventListener('click', function (e) {
      const path = e.composedPath ? e.composedPath() : [];
      if (selected != null && path.indexOf(el.svg) < 0 && path.indexOf(el.menu) < 0) clearPick();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && selected != null) clearPick(); });
    el.svg.addEventListener('dblclick', function (e) {
      if (hitFromEvent(e)) openDialog({ tab: 'bars' });
    });
    document.addEventListener('mousedown', function (e) {
      if (!el.menu.contains(e.target)) hideMenu();
    });
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
      cfg = Ml.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          cfg = Ml.read();
          if (limitChanged()) refresh();
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
      if (initDone) {
        console.error('Maturity Ladder failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Maturity Ladder failed to initialize:', err);
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
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; paint(); });
  }

  /**
   * Opens the Format dialog. `focus` ({ tab }) preselects a tab. The dialog gets the current buckets as payload, because it can't
   * read the worksheet itself.
   */
  function openDialog (focus) {
    hideMenu();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify({
      focus: focus || null,
      hasGroup: !!(model && model.hasGroup)
    });
    var options = { width: 600, height: 760 };
    // Modal keeps the Format window in front of Tableau until Done; the chart behind it still updates live.
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) options.dialogStyle = tableau.DialogStyle.Modal;
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Maturity Ladder dialog:', err && err.message);
    });
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

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== renderToken) return;
      var fields = results[0];

      var ready = fields.date.length && fields.amount.length;
      if (!ready) {
        model = null;
        if (first) { T.mark('no fields on the Marks card'); T.done('Maturity Ladder load timings'); }
        if (fields.date.length) showEmpty('Drag a measure onto <b>Amount</b>: the value that falls due.');
        else if (fields.amount.length) showEmpty('Drag a date onto <b>Maturity date</b>: when each amount falls due.');
        else showEmpty('Drag a date onto <b>Maturity date</b> and a measure onto <b>Amount</b>.<br>' +
          'Optional: a dimension onto <b>Group</b> (stacks the bars) and one onto <b>Item</b> (listed in the tooltip).');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      model = extract(table, fields);
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Maturity Ladder load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Maturity Ladder render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Maturity Ladder load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = { date: [], amount: [], color: [], detail: [], extra: [] };
    marks.encodings.forEach(function (enc) {
      if (!enc.field) return;
      // Built-in tiles (Tooltip, Detail) only add rows or tooltip text: matched to their columns, never read as dates or amounts.
      var type = String(enc.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : enc.id;
      if (id !== 'date' && id !== 'amount' && id !== 'color' && id !== 'detail') id = 'extra';
      fields[id].push(enc.field);
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
      console.info('Maturity Ladder: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  // ---- dates (same rules as the Line Chart and KPI Card) ---------------------
  // ---- dates (same rules as KPI Card) -----------------------------------------
  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  /**
   * How fine a date column is, so combined fields sort coarse → fine
   * (YEAR before QUARTER before MONTH ...) whatever order they were dropped in.
   */
  function granularity (fieldName) {
    var m = /^(\w+)\(/.exec(String(fieldName || ''));
    var p = m ? m[1].toUpperCase() : '';
    var rank = {
      YEAR: 1, YR: 1, TYEAR: 1,
      QUARTER: 2, QR: 2, TQUARTER: 2,
      MONTH: 3, MN: 3, MY: 3, TMONTH: 3,
      WEEK: 4, WK: 4, TWEEK: 4,
      DAY: 5, DY: 5, MDY: 5, TDAY: 5,
      WEEKDAY: 6,
      HOUR: 7, MINUTE: 8, SECOND: 9
    };
    return rank[p] || 5; // exact dates and other dimensions count as day level
  }

  /**
   * Turns one cell into something sortable. Handles real dates (exact or
   * truncated), numeric date parts (YEAR 2026, MONTH 5, WEEK 18, QUARTER 2)
   * and named parts ("May", "Q2", "Monday", "May 2026"). Other text → NaN
   * (keeps Tableau's order).
   */
  function ordinal (cell) {
    if (!cell) return NaN;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v instanceof Date) return v.getTime();
    if (typeof v === 'number') return v;
    var strs = [v, cell.formattedValue];
    for (var i = 0; i < strs.length; i++) {
      var s = strs[i];
      if (s == null || s === '%null%') continue;
      s = String(s).trim();
      var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
      if (iso) return new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0)).getTime();
      if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
      var q = /^(?:q|quarter\s*)(\d)$/i.exec(s);
      if (q) return Number(q[1]);
      var w = /^(?:w|week\s*)(\d{1,2})$/i.exec(s);
      if (w) return Number(w[1]);
      var low = s.toLowerCase();
      if (/^[a-z]+$/.test(low)) {
        var mi = MONTHS.indexOf(low.slice(0, 3));
        if (mi >= 0 && !/^(mon|tue|wed|thu|fri|sat|sun)/.test(low)) return mi + 1;
        var wi = WEEKDAYS.indexOf(low.slice(0, 3));
        if (wi >= 0) return wi + 1;
      }
      if (/\d/.test(s)) {
        var parsed = Date.parse(s);
        if (!isNaN(parsed)) return parsed;
      }
    }
    return NaN;
  }

  /** A real calendar date for a cell as UTC ms at midnight, or null for date parts. */
  function toDay (cell) {
    if (!cell) return null;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      // Tableau sends dates as UTC midnight; anything else is a local time.
      var utc = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
      return utc ? Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate())
        : Date.UTC(v.getFullYear(), v.getMonth(), v.getDate(), v.getHours(), v.getMinutes());
    }
    var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v == null ? '' : v).trim());
    return iso ? Date.UTC(+iso[1], +iso[2] - 1, +iso[3]) : null;
  }

  // ---------------------------------------------------------------------------
  // Model
  //
  // extract(): summary data → one record per row { t (UTC ms of the day), v, grp, item, fv, row, raw, rawGrp }.
  // buildBuckets(): records → buckets on a time axis (see the settings: buckets.unit / overdue / later).
  // ---------------------------------------------------------------------------
  var DAY = 86400000;
  var UNIT_ORDER = ['week', 'month', 'quarter', 'year'];
  var MAX_AUTO = 36;   // auto unit: at most about this many buckets
  var MAX_GROUPS = 12; // more groups are folded into "Other"

  function isNullCell (c) {
    if (!c) return true;
    var v = c.nativeValue != null ? c.nativeValue : c.value;
    return v == null || v === '%null%' || (c.formattedValue === 'Null' && (v === 'Null' || v == null));
  }

  function cellText (c) {
    if (isNullCell(c)) return null;
    return String(c.formattedValue != null && c.formattedValue !== '' ? c.formattedValue : c.value);
  }

  /** Date of one row as UTC ms at midnight (exact date, or recombined from YEAR / QUARTER / MONTH / WEEK / DAY parts); null = no date. */
  function rowDay (r, cDates) {
    var i;
    for (i = cDates.length - 1; i >= 0; i--) {
      var d = toDay(r[cDates[i].index]);
      if (d != null) return d;
    }
    var y = NaN, mo = NaN, q = NaN, w = NaN, dd = NaN, stamp = null;
    cDates.forEach(function (c) {
      var o = ordinal(r[c.index]);
      if (isNaN(o)) return;
      if (o > 1e5) { var dt = new Date(o); stamp = Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()); return; }
      if (c.grain === 1) y = o; else if (c.grain === 2) q = o; else if (c.grain === 3) mo = o;
      else if (c.grain === 4) w = o; else if (c.grain === 5) dd = o;
    });
    if (stamp != null) return stamp;
    if (isNaN(y)) return null;
    if (isNaN(mo) && !isNaN(w)) return Date.UTC(y, 0, 1) + (w - 1) * 7 * DAY;
    if (isNaN(mo)) mo = !isNaN(q) ? (q - 1) * 3 + 1 : 1;
    return Date.UTC(y, mo - 1, isNaN(dd) ? 1 : dd);
  }

  /** Summary data → { recs, noDate, minRank, hasGroup, hasItem, fields }. */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var dReqs = fields.date.slice(0, 3).map(function (f) { return { field: f, dim: true, col: null }; });
    var gReq = fields.color.length ? { field: fields.color[0], dim: true, col: null } : null;
    var iReq = fields.detail.length ? { field: fields.detail[0], dim: true, col: null } : null;
    var aReq = { field: fields.amount[0], col: null };
    var reqs = dReqs.concat(gReq ? [gReq] : [], iReq ? [iReq] : [], [aReq]);
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    fields.extra.forEach(function (f) { var c = findColumn(table, f, taken); if (c) taken.push(c); });
    matchLeftovers(table, reqs, taken, false);

    // Date columns coarse → fine, so YEAR + MONTH read in the right order.
    var cDates = dReqs.filter(function (r) { return r.col; }).map(function (r) {
      var nm = /^\w+\(/.test(String(r.field && r.field.name)) ? r.field.name : r.col.fieldName;
      return { index: r.col.index, fieldName: r.col.fieldName, grain: granularity(nm) };
    }).sort(function (a, b) { return a.grain - b.grain; });
    var finest = cDates.length ? cDates[cDates.length - 1].grain : 5;
    var minRank = finest >= 4 ? 1 : finest === 3 ? 2 : finest === 2 ? 3 : 4; // finest unit the data can show

    var recs = [];
    var noDate = 0;
    rows.forEach(function (r, ri) {
      var t = cDates.length ? rowDay(r, cDates) : null;
      if (t == null) { noDate++; return; }
      var cell = aReq.col ? r[aReq.col.index] : null;
      var v = cell ? toNumber(cell) : NaN;
      if (!isFinite(v)) return;
      var gc = gReq && gReq.col ? r[gReq.col.index] : null;
      var ic = iReq && iReq.col ? r[iReq.col.index] : null;
      recs.push({
        t: t, v: v, row: ri, fv: cell.formattedValue,
        grp: gc ? (cellText(gc) || '(no group)') : '',
        rawGrp: gc ? gc.value : null,
        item: ic ? cellText(ic) : null,
        raw: cDates.map(function (c) { return { fieldName: c.fieldName, value: r[c.index].value }; })
      });
    });
    return {
      recs: recs, noDate: noDate, minRank: minRank, rowsRead: rows.length,
      hasGroup: !!(gReq && gReq.col), hasItem: !!(iReq && iReq.col),
      groupField: gReq && gReq.col ? gReq.col.fieldName : null
    };
  }

  function todayUtc () {
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(cfg.today.date || '').trim());
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
    var n = new Date();
    return Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  }

  function floorUnit (t, u) {
    var d = new Date(t);
    var y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (u === 'year') return Date.UTC(y, 0, 1);
    if (u === 'quarter') return Date.UTC(y, m - m % 3, 1);
    if (u === 'month') return Date.UTC(y, m, 1);
    return t - ((d.getUTCDay() + 6) % 7) * DAY; // week starts on Monday
  }

  function addUnit (t, u, n) {
    var d = new Date(t);
    var y = d.getUTCFullYear(), m = d.getUTCMonth();
    if (u === 'year') return Date.UTC(y + n, 0, 1);
    if (u === 'quarter') return Date.UTC(y, m + 3 * n, 1);
    if (u === 'month') return Date.UTC(y, m + n, 1);
    return t + 7 * n * DAY;
  }

  function countBuckets (lo, hi, u) {
    var n = 0;
    for (var s = floorUnit(lo, u); s <= hi && n <= MAX_AUTO + 1; s = addUnit(s, u, 1)) n++;
    return n;
  }

  function chooseUnit (lo, hi, today, minRank) {
    var want = cfg.buckets.unit;
    var from = Math.max(minRank - 1, want !== 'auto' && UNIT_ORDER.indexOf(want) >= 0 ? UNIT_ORDER.indexOf(want) : 0);
    if (want !== 'auto' && UNIT_ORDER.indexOf(want) >= 0) return UNIT_ORDER[from];
    var later = Math.max(0, Math.floor(Number(cfg.buckets.later) || 0));
    for (var i = from; i < UNIT_ORDER.length; i++) {
      var u = UNIT_ORDER[i];
      var h = later > 0 ? Math.min(hi, addUnit(floorUnit(today, u), u, later + 1) - 1) : hi;
      if (countBuckets(lo, h, u) <= MAX_AUTO) return u;
    }
    return 'year';
  }

  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  function bucketLabel (s, u, longForm) {
    var d = new Date(s);
    var y = d.getUTCFullYear();
    if (u === 'year') return String(y);
    if (u === 'quarter') return 'Q' + (Math.floor(d.getUTCMonth() / 3) + 1) + ' ' + y;
    if (u === 'month') return MON[d.getUTCMonth()] + ' ' + (longForm ? y : String(y).slice(2));
    return d.getUTCDate() + ' ' + MON[d.getUTCMonth()] + ' ' + (longForm ? y : String(y).slice(2));
  }

  /** Records → { list, unit, groups, grand, today, todayPos, noDate }. */
  function buildBuckets () {
    var recs = model.recs;
    if (!recs.length) return { list: [], noDate: model.noDate };
    var B = cfg.buckets;
    var today = todayUtc();
    var over = B.overdue;
    var later = Math.max(0, Math.floor(Number(B.later) || 0));
    var regular = over ? recs.filter(function (r) { return r.t >= today; }) : recs;
    var lo = regular.length ? Math.min.apply(null, regular.map(function (r) { return r.t; })) : today;
    var hi = regular.length ? Math.max.apply(null, regular.map(function (r) { return r.t; })) : today;
    var unit = chooseUnit(lo, hi, today, model.minRank);
    var horizon = later > 0 ? addUnit(floorUnit(today, unit), unit, later + 1) : Infinity; // first day of "Later"
    if (later > 0) hi = Math.min(hi, horizon - 1);
    var start = floorUnit(today <= hi ? Math.min(lo, today) : lo, unit);
    if (hi < start) hi = start;

    var list = [];
    var index = {};
    for (var s = start; s <= hi; s = addUnit(s, unit, 1)) {
      index[s] = list.length;
      list.push({ s: s, e: addUnit(s, unit, 1), kind: 't', label: '', recs: [] });
    }
    var firstReg = list.length ? 0 : -1;
    var overB = over ? { s: -Infinity, e: today, kind: 'over', label: B.overdueLabel || 'Overdue', recs: [] } : null;
    var laterB = later > 0 ? { s: horizon, e: Infinity, kind: 'later', label: B.laterLabel || 'Later', recs: [] } : null;
    recs.forEach(function (r) {
      if (overB && r.t < today) overB.recs.push(r);
      else if (laterB && r.t >= horizon) laterB.recs.push(r);
      else {
        var k = index[floorUnit(r.t, unit)];
        if (k != null) list[k].recs.push(r);
      }
    });
    var longForm = list.length > 1 && new Date(list[0].s).getUTCFullYear() !== new Date(list[list.length - 1].s).getUTCFullYear() ? false : true;
    list.forEach(function (b) { b.label = bucketLabel(b.s, unit, longForm); });
    if (overB && overB.recs.length) list.unshift(overB);
    if (laterB && laterB.recs.length) list.push(laterB);

    // Groups, largest first; the smallest are folded into "Other".
    var gt = {};
    var gOrder = [];
    recs.forEach(function (r) { if (!(r.grp in gt)) { gt[r.grp] = 0; gOrder.push(r.grp); } gt[r.grp] += Math.abs(r.v); });
    gOrder = gOrder.map(function (g, i) { return { g: g, i: i }; })
      .sort(function (a, b) { return gt[b.g] - gt[a.g] || a.i - b.i; }).map(function (x) { return x.g; });
    var groups = gOrder.slice(0, MAX_GROUPS);
    var hasOther = gOrder.length > MAX_GROUPS;
    if (hasOther) groups.push('Other');
    var gi = {};
    groups.forEach(function (g, i) { gi[g] = i; });
    var otherI = hasOther ? groups.length - 1 : -1;

    var grand = 0;
    var cum = 0;
    var todayPos = null;
    list.forEach(function (b, i) {
      var by = {};
      b.total = 0; b.pos = 0; b.neg = 0;
      var names = {};
      b.recs.forEach(function (r) {
        var k = r.grp in gi ? gi[r.grp] : otherI;
        var sg = by[k] || (by[k] = { gi: k, v: 0, recs: [] });
        sg.v += r.v;
        sg.recs.push(r);
        b.total += r.v;
        names[r.item != null ? r.item : '#' + r.row] = 1;
      });
      b.count = model.hasItem ? Object.keys(names).length : b.recs.length;
      b.segs = Object.keys(by).map(Number).sort(function (a, c) { return a - c; }).map(function (k) { return by[k]; });
      var up = 0, dn = 0;
      b.segs.forEach(function (sg) {
        if (sg.v >= 0) { sg.a = up; sg.b = up + sg.v; up = sg.b; } else { sg.a = dn; sg.b = dn + sg.v; dn = sg.b; }
        if (sg.v >= 0) b.pos += sg.v; else b.neg += sg.v;
      });
      grand += b.total;
      cum += b.total;
      b.cum = cum;
      b.i = i;
      if (b.kind === 't' && today >= b.s && today < b.e) todayPos = i + (today - b.s) / (b.e - b.s);
    });
    if (grand === 0) grand = list.reduce(function (a, b) { return a + Math.abs(b.total); }, 0);
    return { list: list, unit: unit, groups: groups, grand: grand, today: today, todayPos: todayPos, noDate: model.noDate, firstReg: firstReg };
  }

  // ---------------------------------------------------------------------------
  // Colours
  // ---------------------------------------------------------------------------
  function monthsFrom (today, t) {
    var a = new Date(today), b = new Date(t);
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + b.getUTCMonth() - a.getUTCMonth() + (b.getUTCDate() >= a.getUTCDate() ? 0 : -1);
  }

  /** Colour of a bucket in "distance" mode. */
  function distColor (b, M) {
    var Br = cfg.bars;
    if (b.kind === 'over') return Br.overdueColor;
    if (b.kind === 'later') return Br.distColors[3];
    var m = monthsFrom(M.today, b.s);
    if (b.s <= M.today && b.e > M.today) m = 0;
    return m <= Br.near ? Br.distColors[0] : m <= Br.mid ? Br.distColors[1] : m <= Br.far ? Br.distColors[2] : Br.distColors[3];
  }

  function groupColor (gi, M) {
    var Br = cfg.bars;
    if (M.groups[gi] === 'Other' && gi === M.groups.length - 1 && M.groups.length > MAX_GROUPS) return Br.otherColor;
    return Br.palette[gi % Br.palette.length] || Br.color;
  }

  function segColor (b, sg, M) {
    var Br = cfg.bars;
    if (Br.colorMode === 'group' && model.hasGroup) return groupColor(sg.gi, M);
    var base = Br.colorMode === 'distance' ? distColor(b, M) : Br.color;
    if (!model.hasGroup || M.groups.length < 2) return base;
    return Ml.tint(base, Math.min(0.75, sg.gi * 0.6 / Math.max(1, M.groups.length - 1)));
  }

  function fmtOf (labelFmt) {
    return cfg.numbers.mode === 'each' && labelFmt ? labelFmt : cfg.format;
  }

  function money (v, forceScale) { return Ml.formatNumber(v, fmtOf(cfg.labels.fmt), { forceScale: forceScale }); }

  function niceTicks (lo, hi, n) {
    if (!(hi > lo)) { hi = lo + 1; }
    var raw = (hi - lo) / Math.max(1, n);
    var mag = Math.pow(10, Math.floor(Math.log10(raw)));
    var norm = raw / mag;
    var step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    var a = Math.floor(lo / step + 1e-9) * step;
    var z = Math.ceil(hi / step - 1e-9) * step;
    var ticks = [];
    for (var v = a; v <= z + step / 2; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return { min: a, max: z, ticks: ticks };
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg) return;
    if (!model) return;
    var M = buildBuckets();
    if (!M.list.length) {
      showEmpty(model.noDate ? model.noDate + ' row' + (model.noDate === 1 ? '' : 's') + ' without a date: nothing to show.<br>Check the field on <b>Maturity date</b>.'
        : 'No rows with an amount to show. Check the fields on <b>Maturity date</b> and <b>Amount</b>.');
      return;
    }
    el.card.classList.remove('is-empty');
    hideTooltip();
    paintCard();
    paintHeader();
    drawChart(M);
    syncPictureButton();
  }

  var picBtn = null;
  function syncPictureButton () {
    var on = !!(cfg.export && cfg.export.picture) && window.ExtSnapshot;
    if (!on) {
      if (picBtn) { picBtn.destroy(); picBtn = null; }
      return;
    }
    if (!picBtn) {
      picBtn = ExtSnapshot.button({
        host: el.card, element: el.card,
        title: function () { return (el.title && el.title.textContent) || (worksheet && worksheet.name) || 'Maturity Ladder'; },
        onError: function (err) { console.error(err); }
      });
      if (picBtn && picBtn.el) picBtn.el.setAttribute('data-snapshot', 'skip');
    }
    picBtn.refresh();
  }

  function applyFont (node, f) {
    node.style.fontFamily = Ml.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Ml.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.card.style.borderRightColor = c.divider ? c.dividerColor : 'transparent';
    el.card.style.borderRightWidth = c.divider ? '1px' : '0';
    el.plot.style.marginTop = c.gap + 'px';
  }

  function paintHeader () {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Ml.iconHtml(ic.builtinId, ic.color, iconTarget());
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
    el.title.textContent = cfg.title.text || 'Maturity ladder';

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

  var measureCtx = null;
  function textWidth (text, size, weight, family) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = (weight || 400) + ' ' + size + 'px ' + Ml.fontStack(family);
    return measureCtx.measureText(String(text)).width;
  }

  function ellipsize (text, width, size, weight, family) {
    if (textWidth(text, size, weight, family) <= width) return text;
    var t = String(text).replace(/…$/, '');
    while (t.length > 1 && textWidth(t + '…', size, weight, family) > width) t = t.slice(0, -1);
    return t + '…';
  }

  function node (tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] != null && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }
  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------
  function rrect (x, y, w, h, rt, rb) {
    rt = Math.max(0, Math.min(rt, w / 2, h)); rb = Math.max(0, Math.min(rb, w / 2, h - rt));
    return 'M' + (x + rt) + ' ' + y + 'H' + (x + w - rt) + (rt ? 'Q' + (x + w) + ' ' + y + ' ' + (x + w) + ' ' + (y + rt) : '') +
      'V' + (y + h - rb) + (rb ? 'Q' + (x + w) + ' ' + (y + h) + ' ' + (x + w - rb) + ' ' + (y + h) : '') +
      'H' + (x + rb) + (rb ? 'Q' + x + ' ' + (y + h) + ' ' + x + ' ' + (y + h - rb) : '') +
      'V' + (y + rt) + (rt ? 'Q' + x + ' ' + y + ' ' + (x + rt) + ' ' + y : '') + 'Z';
  }

  function textNode (x, y, str, f, anchor, family, extra) {
    var t = node('text', Object.assign({
      x: x, y: y, 'text-anchor': anchor || 'middle', 'font-size': f.size, 'font-weight': f.weight,
      fill: f.color, 'font-family': Ml.fontStack(family)
    }, extra || {}), str);
    return t;
  }

  function noteText (M) {
    return M.noDate ? M.noDate + ' row' + (M.noDate === 1 ? '' : 's') + ' without a date ' + (M.noDate === 1 ? 'is' : 'are') + ' not shown' : '';
  }

  function drawChart (M) {
    var svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawn = [];
    lastM = M;
    var W = Math.max(1, el.plot.clientWidth);
    var H = Math.max(1, el.plot.clientHeight);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (W < 90 || H < 70) return;

    var fam = cfg.numbers.font;
    var L = cfg.labels, A = cfg.axes, Br = cfg.bars, N = M.list.length;
    var ax = L.axis, tf = L.total, cf = L.count;

    // ---- vertical layout ----
    var legendOn = cfg.legend.show && model.hasGroup && M.groups.length > 0;
    var legendH = legendOn ? cfg.legend.size + 8 : 0;
    var todayOn = cfg.today.show && M.todayPos != null;
    var todayH = todayOn ? 14 : 0;
    var note = noteText(M);
    var noteH = note ? 14 : 0;
    var xTitleH = A.xTitle ? 14 : 0;
    var axisH = ax.size + 8;
    var showTot = L.showTotals, showCnt = L.showCounts;
    var headroom = (showTot ? tf.size + 4 : 0) + (showCnt ? cf.size + 2 : 0);
    var hasNeg = M.list.some(function (b) { return b.neg < 0; });
    var hasPos = M.list.some(function (b) { return b.pos > 0; });
    var footroom = hasNeg && showTot ? tf.size + 4 : 0;
    var top = 2 + (legendOn && cfg.legend.position === 'top' ? legendH : 0) + todayH;
    var bottom = axisH + xTitleH + noteH + (legendOn && cfg.legend.position === 'bottom' ? legendH : 0) + 2;
    var ptop = top + (hasPos ? headroom : 0);
    var pbot = H - bottom - footroom;
    if (pbot - ptop < 40) { ptop = top; pbot = H - bottom; headroom = 0; footroom = 0; showTot = false; showCnt = false; }
    var ph = pbot - ptop;

    var ymin = Math.min(0, Math.min.apply(null, M.list.map(function (b) { return b.neg; })));
    var ymax = Math.max(0, Math.max.apply(null, M.list.map(function (b) { return b.pos; })));
    if (ymax === 0 && ymin === 0) ymax = 1;
    var ys = niceTicks(ymin, ymax, Math.max(2, Math.floor(ph / 42)));
    var yy = function (v) { return ptop + (ys.max - v) / (ys.max - ys.min) * ph; };
    var scaleSfx = cfg.format && (cfg.numbers.mode === 'each' ? L.fmt.scale : cfg.format.scale) === 'dynamic'
      ? Ml.pickScale(Math.max(Math.abs(ys.min), Math.abs(ys.max)), 'dynamic') : undefined;
    var tickText = function (v) { return money(v, scaleSfx); };

    var cs = null;
    if (cfg.cumulative.show) {
      var cmin = Math.min(0, Math.min.apply(null, M.list.map(function (b) { return b.cum; })));
      var cmax = Math.max(0, Math.max.apply(null, M.list.map(function (b) { return b.cum; })));
      cs = niceTicks(cmin, cmax || 1, Math.max(2, Math.floor(ph / 42)));
      cs.sfx = (cfg.numbers.mode === 'each' ? L.fmt.scale : cfg.format.scale) === 'dynamic' ? Ml.pickScale(Math.max(Math.abs(cs.min), Math.abs(cs.max)), 'dynamic') : undefined;
    }

    // ---- horizontal layout ----
    var wl = Math.max.apply(null, ys.ticks.map(function (v) { return textWidth(tickText(v), ax.size, ax.weight, fam); }));
    var left = 4 + Math.ceil(wl) + 6 + (A.yTitle ? ax.size + 6 : 0);
    var right = 4;
    if (cs) {
      var wr = Math.max.apply(null, cs.ticks.map(function (v) { return textWidth(money(v, cs.sfx), ax.size, ax.weight, fam); }));
      right = 6 + Math.ceil(wr) + 4 + (cfg.cumulative.title ? ax.size + 6 : 0);
    }
    var pw = W - left - right;
    if (pw < 40) return;
    var band = pw / N;
    var bw = Math.max(1, Math.min(band, band * Br.width / 100));
    var xc = function (i) { return left + (i + 0.5) * band; };

    // ---- legend ----
    if (legendOn) {
      var ly = cfg.legend.position === 'top' ? 2 + cfg.legend.size : H - 2 - 3;
      var lx = left;
      var lf = { size: cfg.legend.size, weight: 400, color: cfg.legend.color };
      for (var g = 0; g < M.groups.length; g++) {
        var nm = M.groups[g] || '(no group)';
        var wtxt = Math.min(140, textWidth(nm, lf.size, 400, fam));
        if (lx + 12 + wtxt > W - 4) {
          svg.appendChild(textNode(lx, ly, '+' + (M.groups.length - g) + ' more', lf, 'start', fam));
          break;
        }
        var sw = groupSwatch(g, M);
        svg.appendChild(node('rect', { x: lx, y: ly - lf.size + 1, width: lf.size - 2, height: lf.size - 2, rx: 2, fill: sw }));
        var shown = ellipsize(nm, wtxt, lf.size, 400, fam);
        svg.appendChild(textNode(lx + lf.size + 2, ly, shown, lf, 'start', fam));
        lx += lf.size + 2 + wtxt + 12;
      }
    }

    // ---- highlight of the next N buckets ----
    var hn = Math.max(0, Math.floor(Number(cfg.today.highlightNext) || 0));
    if (hn > 0 && todayOn) {
      var shown2 = 0;
      for (var hi = 0; hi < N && shown2 < hn; hi++) {
        var hb = M.list[hi];
        if (hb.kind !== 't' || hb.s <= M.today) continue;
        svg.appendChild(node('rect', { x: left + hi * band, y: ptop, width: band, height: ph, fill: cfg.today.highlightColor, 'fill-opacity': 0.22 }));
        shown2++;
      }
    }

    // ---- grid and left axis ----
    var gridG = node('g', {});
    svg.appendChild(gridG);
    ys.ticks.forEach(function (v) {
      var y = yy(v);
      if (A.grid) gridG.appendChild(node('line', { x1: left, x2: left + pw, y1: y, y2: y, stroke: v === 0 ? A.lineColor : A.gridColor, 'stroke-width': 1 }));
      svg.appendChild(textNode(left - 6, y + ax.size * 0.35, tickText(v), ax, 'end', fam));
    });
    if (!A.grid) svg.appendChild(node('line', { x1: left, x2: left + pw, y1: yy(0), y2: yy(0), stroke: A.lineColor }));
    if (A.yTitle) {
      svg.appendChild(textNode(0, 0, A.yTitle, ax, 'middle', fam, { transform: 'translate(' + (ax.size) + ',' + (ptop + ph / 2) + ') rotate(-90)' }));
    }

    // ---- bars ----
    var barsG = node('g', {});
    svg.appendChild(barsG);
    var sel = selected;
    M.list.forEach(function (b, i) {
      var g = node('g', { 'class': 'bk', 'data-i': i });
      var x = left + i * band + (band - bw) / 2;
      g.appendChild(node('rect', { 'class': 'bk-hit', x: left + i * band, y: ptop, width: band, height: ph, fill: 'transparent' }));
      b.segs.forEach(function (sg, k) {
        var y1 = yy(Math.max(sg.a, sg.b)), y2 = yy(Math.min(sg.a, sg.b));
        var h = Math.max(0, y2 - y1);
        if (h <= 0) return;
        var gap = b.segs.length > 1 ? Math.min(Br.gap, h / 3) : 0;
        var up = sg.v >= 0;
        var last = up ? k === lastIndexOf(b.segs, true) : k === lastIndexOf(b.segs, false);
        var yTop = y1 + (up ? 0 : gap), hh = Math.max(0.5, h - gap);
        var rr = Br.radius;
        var p = node('path', {
          'class': 'bk-body', 'data-g': sg.gi, fill: segColor(b, sg, M),
          d: rrect(x, yTop, bw, hh, up && last ? rr : 0, !up && last ? rr : 0)
        });
        g.appendChild(p);
      });
      if (sel != null && sel !== i) g.setAttribute('opacity', '0.35');
      barsG.appendChild(g);
      drawn[i] = b;

      // total and count above (or below, for negative-only) the bar
      if (showTot || showCnt) {
        var above = b.pos > 0 || b.neg === 0;
        var yEdge = above ? yy(b.pos) : yy(b.neg);
        var lines = [];
        if (showTot && b.total !== 0) lines.push({ t: money(b.total), f: tf }); // empty buckets get no "0" label
        if (showCnt) lines.push({ t: b.count + (model.hasItem ? (b.count === 1 ? ' item' : ' items') : (b.count === 1 ? ' row' : ' rows')), f: cf });
        var maxW = Math.max(band - 2, 10);
        var fit = lines.filter(function (l) {
          if (textWidth(l.t, l.f.size, l.f.weight, fam) > maxW && l.f === cf) l.t = String(b.count);
          return textWidth(l.t, l.f.size, l.f.weight, fam) <= maxW;
        });
        var yy0 = above ? yEdge - 4 : yEdge + 4 + tf.size * 0.8;
        fit.forEach(function (l) {
          svg.appendChild(textNode(xc(i), yy0, l.t, l.f, 'middle', fam, { 'pointer-events': 'none' }));
          yy0 += above ? -(l.f.size + 2) : l.f.size + 2;
        });
      }
    });

    // ---- running total ----
    if (cs) {
      var cy = function (v) { return ptop + (cs.max - v) / (cs.max - cs.min) * ph; };
      var C = cfg.cumulative;
      var pts = M.list.map(function (b, i) { return xc(i) + ',' + cy(b.cum); }).join(' ');
      svg.appendChild(node('polyline', { points: pts, fill: 'none', stroke: C.color, 'stroke-width': C.width, 'stroke-linejoin': 'round', 'pointer-events': 'none' }));
      if (C.points) M.list.forEach(function (b, i) { svg.appendChild(node('circle', { cx: xc(i), cy: cy(b.cum), r: Math.max(2, C.width + 0.5), fill: '#fff', stroke: C.color, 'stroke-width': C.width, 'pointer-events': 'none' })); });
      cs.ticks.forEach(function (v) {
        svg.appendChild(textNode(left + pw + 6, cy(v) + ax.size * 0.35, money(v, cs.sfx), ax, 'start', fam));
      });
      if (C.title) svg.appendChild(textNode(0, 0, C.title, ax, 'middle', fam, { transform: 'translate(' + (W - 3) + ',' + (ptop + ph / 2) + ') rotate(90)' }));
    }

    // ---- today marker ----
    if (todayOn) {
      var T = cfg.today;
      var tx = left + M.todayPos * band;
      svg.appendChild(node('line', {
        x1: tx, x2: tx, y1: top - 2, y2: pbot + footroom, stroke: T.color, 'stroke-width': T.lineWidth,
        'stroke-dasharray': Ml.dashArray(T.lineStyle, T.lineWidth), 'pointer-events': 'none'
      }));
      var tl = T.label;
      if (tl) {
        var tfn = { size: Math.max(9, Math.min(12, tf.size)), weight: 600, color: T.color };
        var tw = textWidth(tl, tfn.size, tfn.weight, fam);
        var anchor = tx + tw / 2 > W - 2 ? 'end' : tx - tw / 2 < left ? 'start' : 'middle';
        svg.appendChild(textNode(tx, top - 4, tl, tfn, anchor, fam, { 'pointer-events': 'none' }));
      }
    }

    // ---- bottom axis labels ----
    var labels = M.list.map(function (b) { return b.label; });
    var widest = Math.max.apply(null, labels.map(function (t) { return textWidth(t, ax.size, ax.weight, fam); }));
    var k = Math.max(1, Math.ceil((widest + 8) / band));
    var lastRight = -1e9;
    var ayy = pbot + footroom + ax.size + 3;
    M.list.forEach(function (b, i) {
      if (i % k !== 0 && b.kind === 't') return;
      var t = ellipsize(b.label, Math.max(band * k - 4, 20), ax.size, ax.weight, fam);
      var w = textWidth(t, ax.size, ax.weight, fam);
      var x0 = xc(i) - w / 2;
      if (x0 < lastRight + 4 || x0 < 0 || x0 + w > W) {
        if (x0 < 0) x0 = 0; else if (x0 + w > W) x0 = W - w;
        if (x0 < lastRight + 4) return;
      }
      lastRight = x0 + w;
      var tn = textNode(x0 + w / 2, ayy, t, ax, 'middle', fam);
      if (t !== b.label) tn.appendChild(node('title', {}, b.label));
      svg.appendChild(tn);
    });
    if (A.xTitle) svg.appendChild(textNode(left + pw / 2, ayy + 13, A.xTitle, ax, 'middle', fam));
    if (note) svg.appendChild(textNode(left, H - bottom + axisH + xTitleH + 11 - 0, note, { size: 11, weight: 400, color: ax.color }, 'start', fam, { 'font-style': 'italic' }));
  }

  function lastIndexOf (segs, up) { for (var i = segs.length - 1; i >= 0; i--) if ((segs[i].v >= 0) === up) return i; return -1; }

  /** Legend swatch: the group's palette colour; in single / distance mode the shade used in the stacks. */
  function groupSwatch (g, M) {
    var Br = cfg.bars;
    if (Br.colorMode === 'group') return groupColor(g, M);
    var base = Br.colorMode === 'distance' ? Br.distColors[1] : Br.color;
    return Ml.tint(base, Math.min(0.75, g * 0.6 / Math.max(1, M.groups.length - 1)));
  }

  // ---------------------------------------------------------------------------
  // Click selects a bucket (or one stack segment) in Tableau
  // ---------------------------------------------------------------------------
  /** The bucket and group under an event: { b, gi } or null. */
  function hitFromEvent (e) {
    var g = e.target.closest ? e.target.closest('.bk') : null;
    if (!g) return null;
    var b = drawn[Number(g.getAttribute('data-i'))];
    if (!b) return null;
    var gAttr = e.target.getAttribute ? e.target.getAttribute('data-g') : null;
    return { b: b, gi: gAttr != null && gAttr !== '' ? Number(gAttr) : null };
  }

  function recsOf (hit) {
    return hit.gi == null ? hit.b.recs : (hit.b.segs.find(function (s) { return s.gi === hit.gi; }) || { recs: [] }).recs;
  }

  function onBarClick (e) {
    if (!cfg || !model || !cfg.interaction || !cfg.interaction.selectInTableau) return;
    if (e.detail > 1 || el.menu.style.display === 'block') return;
    var hit = hitFromEvent(e);
    if (!hit || !recsOf(hit).length) { clearPick(); return; }
    var key = hit.b.i + ':' + (hit.gi == null ? '' : hit.gi);
    if (selectedKey === key) { clearPick(); return; }
    selectedKey = key;
    selected = hit.b.i;
    var recs = recsOf(hit);
    var sels = [];
    if (recs[0].raw.length) {
      recs[0].raw.forEach(function (f, ci) {
        var vals = [];
        recs.forEach(function (r) { var v = r.raw[ci].value; if (vals.indexOf(v) < 0) vals.push(v); });
        sels.push({ fieldName: f.fieldName, value: vals });
      });
    }
    if (hit.gi != null && model.groupField) {
      var gv = [];
      recs.forEach(function (r) { if (gv.indexOf(r.rawGrp) < 0) gv.push(r.rawGrp); });
      sels.push({ fieldName: model.groupField, value: gv });
    }
    ExtCore.select(worksheet, sels, 'Maturity Ladder');
    paint();
  }

  function clearPick () {
    if (selected == null) return;
    selected = null;
    selectedKey = null;
    ExtCore.clearSelection(worksheet);
    paint();
  }

  // Tableau's own tooltip (Format → Chart → Use Tableau's tooltip).
  // Mark → row: index in the summary data exactly as Tableau sent it (0-based); the bucket's first row.
  var hoverRow = -2;      // last row sent to Tableau (-2 = nothing sent yet)
  var tableauTipBroken = false; // this Tableau has no hoverTupleAsync: use our own tooltip

  function useTableauTip () {
    return !!(cfg && cfg.interaction && cfg.interaction.tableauTooltip) && !tableauTipBroken;
  }

  function sendHoverRow (row, e) {
    if (row === hoverRow) return;
    hoverRow = row;
    if (!ExtCore.hoverTooltip(worksheet, row, { x: e ? e.clientX : 0, y: e ? e.clientY : 0 })) {
      tableauTipBroken = true;
      hoverRow = -2;
    }
  }

  function endTableauTip () {
    if (hoverRow !== -2 && hoverRow !== null) ExtCore.hoverTooltip(worksheet, null);
    hoverRow = -2;
  }

  function onLeave () {
    hideTooltip();
    if (useTableauTip()) endTableauTip();
  }

  function pctOf (v, M) { return M.grand ? (v / M.grand * 100).toFixed(1) + ' %' : ''; }

  function tooltipHtml (hit) {
    var M = lastM, b = hit.b;
    var html = '<div class="tt-name">' + esc(b.label) + (b.kind === 't' && M.unit !== 'month' && M.unit !== 'year' && M.unit !== 'quarter' ? ' (week)' : '') + '</div>';
    html += '<div class="tt-value">' + esc(money(b.total)) + '</div>';
    var n = b.count;
    html += '<div class="tt-note">' + esc(pctOf(b.total, M)) + ' of ' + esc(money(M.grand)) + ' · ' +
      n + (model.hasItem ? (n === 1 ? ' item' : ' items') : (n === 1 ? ' row' : ' rows')) + '</div>';
    if (model.hasGroup && b.segs.length) {
      html += '<div class="tt-rows">';
      b.segs.forEach(function (sg) {
        var bold = hit.gi === sg.gi ? ' style="font-weight:700"' : '';
        html += '<div class="tt-row"' + bold + '><span class="sw" style="background:' + segColor(b, sg, M) + '"></span><span class="nm">' +
          esc(M.groups[sg.gi] || '(no group)') + '</span><span class="vl">' + esc(money(sg.v)) + '</span></div>';
      });
      html += '</div>';
    }
    if (model.hasItem) {
      var by = {};
      var order = [];
      recsOf(hit).forEach(function (r) {
        var k = r.item != null ? r.item : '(no item)';
        if (!(k in by)) { by[k] = 0; order.push(k); }
        by[k] += r.v;
      });
      order = order.map(function (k, i) { return { k: k, i: i }; })
        .sort(function (a, c) { return Math.abs(by[c.k]) - Math.abs(by[a.k]) || a.i - c.i; }).map(function (x) { return x.k; });
      var top = Math.max(0, Math.floor(Number(cfg.chart.topItems) || 0));
      if (top && order.length) {
        html += '<div class="tt-rows">';
        order.slice(0, top).forEach(function (k) {
          html += '<div class="tt-row"><span class="nm">' + esc(k) + '</span><span class="vl">' + esc(money(by[k])) + '</span></div>';
        });
        if (order.length > top) html += '<div class="tt-note">+' + (order.length - top) + ' more</div>';
        html += '</div>';
      }
    }
    return html;
  }

  function onHover (e) {
    if (!cfg || el.menu.style.display === 'block') return;
    var hit = hitFromEvent(e);
    if (useTableauTip()) {
      hideTooltip();
      var rs = hit ? recsOf(hit) : [];
      sendHoverRow(rs.length ? rs[0].row : null, e);
      if (useTableauTip()) return; // else: this Tableau cannot do it, fall through to our tooltip
    }
    if (!cfg.chart.tooltip) return;
    if (!hit || !lastM) { hideTooltip(); return; }
    var tt = el.tooltip;
    tt.innerHTML = tooltipHtml(hit);
    tt.style.fontFamily = Ml.fontStack(cfg.numbers.font);
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
    if (!cfg || !cfg.chart.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    var items = [];
    items.push(
      ['Buckets…', { tab: 'buckets' }],
      ['Bars…', { tab: 'bars' }],
      ['Today & running total…', { tab: 'today' }],
      ['Labels…', { tab: 'labels' }],
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

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  window.MaturityLadder = { init: init };
})();

