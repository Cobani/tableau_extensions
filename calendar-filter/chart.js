'use strict';

/**
 * Calendar Filter — Tableau Viz Extension.
 *
 * A filter, not a chart. The zone shows one text box with the dates currently chosen. Clicking it
 * opens the calendar in Tableau's own dialog window (picker.html), so the calendar is not limited
 * to the size of the zone. The choice is written into the date filter on this sheet's Filters
 * shelf; sharing that filter ("Apply to Worksheets → All Using This Data Source") makes it filter
 * the dashboard, and it shows in the Filters pane like any other filter.
 *
 * Marks card tiles (calendar-filter.trex):
 *   start   Start date: the first day the calendar offers, e.g. {MIN([Onboarding Start Date])}
 *   end     End date: the last day, e.g. {MAX([Onboarding Start Date])}
 * Use FIXED level-of-detail calculations: they are computed before the date filter, so the calendar
 * keeps showing every date between Start and End while the filter narrows this very sheet.
 *
 * The date filter (found with getFiltersAsync; Format → Calendar → Date filter picks one when the
 * shelf has several):
 *   categorical (Exact Date / Day, discrete)  any days: single, ranges, several · nulls Include/Exclude/Only
 *   range       (continuous "Range of dates") one continuous range · nulls via the null option
 *
 * The chosen filter lives in the workbook's filter (saved with the workbook, in custom views, shown
 * in the Filters pane). After a reload or a change made elsewhere (FilterChanged) the text box
 * reads the filter back and rebuilds the granularity from it (Cf.inferState).
 *
 * Talking to the calendar window:
 *   payload in   { state, start, end, days (null = every day can be picked), rangeOnly, hasNull, field }
 *   live mode    the window sends { type: 'state', state } with sendDialogMessageToParentAsync
 *   on close     closeDialog(JSON { type: 'apply' | 'cancel' | 'close', state })
 */
(function () {
  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null;          // see buildModel()
  var applied = null;        // the filter in force: { gran, sel, nullState }
  var dialogOpen = false;
  var renderToken = 0;
  var ownChange = 0;         // time of our last filter call (its FilterChanged is ours)
  var notice = '';           // short warning under the box
  var lastRange = null;      // { start, end } from the last read that had them

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'title', 'box', 'boxText', 'boxIcon', 'boxClear', 'notice', 'hint'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    // Handshake recovery: reload the frame (up to 3 times) when Tableau rejects or never answers.
    var boot = window.ExtBoot || { attempt: 0, retry: function () { return false; }, ok: function () {} };
    var initDone = false;
    var hintTimer = setTimeout(function () { if (!initDone) showEmpty('Loading…'); }, 2500);
    var initTimeout = INIT_TIMEOUT + INIT_TIMEOUT_STEP * boot.attempt;
    var watchdog = setTimeout(function () {
      if (initDone) return;
      if (!boot.retry('no handshake after ' + initTimeout / 1000 + ' s')) showRetry('Tableau has not answered yet.');
    }, initTimeout);

    if (window.ExtTiming) ExtTiming.mark('initializeAsync start', boot.attempt ? 'reload #' + boot.attempt : '');
    return tableau.extensions.initializeAsync({ configure: configure }).then(function () {
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      boot.ok();
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Cf.read();
      applied = Cf.emptyState(cfg);

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, requestRefresh);
      if (tableau.TableauEventType.FilterChanged) {
        worksheet.addEventListener(tableau.TableauEventType.FilterChanged, onFilterChanged);
      }
      tableau.extensions.settings.addEventListener(tableau.TableauEventType.SettingsChanged, function () {
        var before = cfg;
        cfg = Cf.read();
        if (before.filter.field !== cfg.filter.field) { scheduleRefresh(); return; }
        if (before.calendar.weekStart !== cfg.calendar.weekStart && applied.gran === 'W' && applied.sel.length) {
          applied = Cf.emptyState(cfg);
          applyFilter();
        } else if (Cf.grans(cfg).indexOf(applied.gran) < 0) {
          applied.gran = Cf.firstGran(cfg, applied.gran);
        }
        paint();
      });
      if (tableau.extensions.ui && tableau.extensions.ui.addEventListener && tableau.TableauEventType.DialogMessageReceived) {
        try { tableau.extensions.ui.addEventListener(tableau.TableauEventType.DialogMessageReceived, onDialogMessage); } catch (e) { /* older Tableau: Apply only */ }
      }

      el.box.addEventListener('click', function (e) {
        if (e.target.closest && e.target.closest('#boxClear')) return;
        openCalendar();
      });
      el.box.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openCalendar(); }
      });
      el.boxClear.addEventListener('click', function (e) {
        e.stopPropagation();
        applied = Cf.emptyState(cfg);
        applyFilter();
        paint();
      });

      return scheduleRefresh();
    }).catch(function (err) {
      if (initDone) {
        console.error('Calendar Filter failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Calendar Filter failed to initialize:', err);
      if (!boot.retry('handshake failed')) showRetry();
    });
  }

  var INIT_TIMEOUT = 4000;
  var INIT_TIMEOUT_STEP = 2000;

  function showRetry (why) {
    showEmpty((why || 'Could not connect to Tableau.') + '<br><u>Click to reload this filter.</u>');
    el.hint.style.cursor = 'pointer';
    el.hint.onclick = function () { if (window.ExtBoot) ExtBoot.reload(); else location.reload(); };
  }

  function folderUrl () { return window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, ''); }

  /** Opens the Format dialog ("Format Extension" on the Marks card). Always on top of Tableau. */
  function configure () {
    var options = { width: 520, height: 720 };
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) options.dialogStyle = tableau.DialogStyle.Modal;
    var payload = JSON.stringify({
      field: model ? model.caption : '',
      filters: model ? model.filterNames : []
    });
    return tableau.extensions.ui.displayDialogAsync(folderUrl() + 'configure.html', payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.error('Calendar Filter dialog error:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // The calendar window
  // ---------------------------------------------------------------------------
  function openCalendar () {
    if (dialogOpen || !model || model.issue || !model.range) return;
    var size = Cf.WINDOW_SIZES[cfg.window.size] || Cf.WINDOW_SIZES.M;
    var options = { width: size.w, height: size.h };
    var DS = tableau.DialogStyle || {};
    var style = cfg.window.dialog === 'floating' ? DS.Modeless : DS.Modal;
    if (style) options.dialogStyle = style;
    var payload = JSON.stringify({
      state: applied,
      start: model.range.start,
      end: model.range.end,
      days: model.days,
      rangeOnly: model.kind === 'range',
      hasNull: model.hasNull,
      field: model.caption
    });
    dialogOpen = true;
    el.box.classList.add('is-open');
    tableau.extensions.ui.displayDialogAsync(folderUrl() + 'picker.html', payload, options).then(function (result) {
      var msg = parse(result);
      if (msg && (msg.type === 'apply' || msg.type === 'close') && msg.state) take(msg.state);
    }, function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.error('Calendar Filter: calendar window error', err);
    }).then(function () {
      dialogOpen = false;
      el.box.classList.remove('is-open');
    });
  }

  function parse (text) {
    try { return text ? JSON.parse(text) : null; } catch (e) { return null; }
  }

  /** Live mode: every change in the window arrives here. */
  var liveTimer = 0;
  function onDialogMessage (ev) {
    var msg = parse(ev && ev.message);
    if (!msg || msg.type !== 'state' || !msg.state) return;
    clearTimeout(liveTimer);
    liveTimer = setTimeout(function () { take(msg.state); }, 150); // a drag sends many in a row
  }

  /** Makes a state from the window the filter in force. */
  function take (state) {
    var next = {
      gran: Cf.firstGran(cfg, state.gran),
      sel: Array.isArray(state.sel) ? state.sel.filter(function (x) { return typeof x === 'number' && isFinite(x); }) : [],
      nullState: ['include', 'exclude', 'only'].indexOf(state.nullState) >= 0 ? state.nullState : cfg.nulls.default
    };
    if (JSON.stringify(next) === JSON.stringify(applied)) return;
    applied = next;
    applyFilter();
    paint();
  }

  // ---------------------------------------------------------------------------
  // Writing the date filter
  // ---------------------------------------------------------------------------
  function utcDate (day) { return new Date(day * 864e5); }

  function allDays () {
    var out = [];
    if (!model || !model.range) return out;
    for (var d = model.range.start; d <= model.range.end; d++) out.push(d);
    return out;
  }

  function applyFilter () {
    notice = '';
    if (!model || model.issue || !model.filter) return;
    var name = model.filter.fieldName;
    var T = tableau;
    var r = Cf.resolve(applied, model.days || allDays(), model.hasNull);
    ownChange = Date.now();
    var call;
    if (r.all) {
      call = worksheet.clearFilterAsync(name);
    } else if (model.kind === 'range') {
      var NO = T.FilterNullOption || { AllValues: 'all-values', NonNullValues: 'non-null-values', NullValues: 'null-values' };
      var only = applied.nullState === 'only';
      var lo = !only && r.days.length ? r.days[0] : model.range.start;
      var hi = !only && r.days.length ? r.days[r.days.length - 1] : model.range.end;
      var opt = only ? NO.NullValues : r.nulls ? NO.AllValues : NO.NonNullValues;
      call = worksheet.applyRangeFilterAsync(name, { min: utcDate(lo), max: utcDate(hi), nullOption: opt });
    } else {
      var U = T.FilterUpdateType || { Replace: 'replace' };
      if (!applied.sel.length && applied.nullState === 'exclude') {
        // Every date but no null: exclude the null value (a short list instead of every date).
        call = model.nullRaw.length
          ? worksheet.applyFilterAsync(name, model.nullRaw, U.Replace, { isExcludeMode: true })
          : worksheet.clearFilterAsync(name);
      } else {
        var vals = [];
        r.days.forEach(function (d) { Array.prototype.push.apply(vals, model.raw[d] || [Cf.iso(d)]); });
        if (r.nulls) Array.prototype.push.apply(vals, model.nullRaw);
        if (!vals.length) {
          notice = applied.nullState === 'only' ? 'No null dates in the data — showing all dates' : 'No data in these dates — showing all dates';
          call = worksheet.clearFilterAsync(name);
        } else {
          call = worksheet.applyFilterAsync(name, vals, U.Replace, { isExcludeMode: false });
        }
      }
    }
    Promise.resolve(call).catch(function (err) {
      console.error('Calendar Filter: Tableau did not accept the filter', err);
      notice = 'Tableau did not accept the filter. Click the ! mark for details.';
      paint();
    });
  }

  /** Someone else changed the filter (the Filters pane, a reset, a custom view): read it back. */
  var filterTimer = 0;
  function onFilterChanged (ev) {
    if (Date.now() - ownChange < 1500) return;
    if (ev && ev.fieldName && model && model.filter && ev.fieldName !== model.filter.fieldName) return;
    clearTimeout(filterTimer);
    filterTimer = setTimeout(scheduleRefresh, 200);
  }

  /** The state the filter shows now. Keeps ours when it means the same dates (ours remembers the granularity). */
  function stateFromFilter (f) {
    var days = model.days || allDays();
    var picked = [];
    var nullSel = false;
    var all = false;
    if (model.kind === 'range') {
      var opt = String(f.nullOption || (f.includeNullValues ? 'all-values' : 'non-null-values')).toLowerCase().replace(/[^a-z]/g, '');
      if (opt === 'nullvalues') return { gran: Cf.firstGran(cfg, cfg.calendar.openAt), sel: [], nullState: 'only' };
      nullSel = opt === 'allvalues';
      var lo = Cf.cellDay(f.minValue);
      var hi = Cf.cellDay(f.maxValue);
      lo = lo == null ? model.range.start : lo;
      hi = hi == null ? model.range.end : hi;
      if (lo <= model.range.start && hi >= model.range.end) all = true;
      else days.forEach(function (d) { if (d >= lo && d <= hi) picked.push(d); });
    } else if (f.isAllSelected) {
      all = true;
      nullSel = model.hasNull;
    } else {
      var inList = {};
      var nullIn = false;
      (f.appliedValues || []).forEach(function (dv) {
        if (Cf.isNullCell(dv)) { nullIn = true; return; }
        var d = Cf.cellDay(dv);
        if (d != null) inList[d] = true;
      });
      if (f.isExcludeMode) {
        days.forEach(function (d) { if (!inList[d]) picked.push(d); });
        nullSel = model.hasNull && !nullIn;
        if (picked.length === days.length) all = true;
      } else {
        days.forEach(function (d) { if (inList[d]) picked.push(d); });
        nullSel = nullIn;
      }
    }
    if (all) {
      return nullSel || !model.hasNull ? Cf.emptyState(cfg) : { gran: Cf.firstGran(cfg, cfg.calendar.openAt), sel: [], nullState: 'exclude' };
    }
    var cur = Cf.resolve(applied, days, model.hasNull);
    if (!cur.all && JSON.stringify(cur.days) === JSON.stringify(picked) && cur.nulls === nullSel) return applied;
    return Cf.inferState(picked, nullSel, days, cfg);
  }

  // ---------------------------------------------------------------------------
  // Data: Start / End from the summary data, the date filter from the Filters shelf
  // ---------------------------------------------------------------------------
  var REFRESH_DELAY = 150;
  var CALL_RETRIES = 2;
  var inFlight = false;
  var rerun = false;
  var refreshTimer = 0;

  function requestRefresh () {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(scheduleRefresh, REFRESH_DELAY);
  }

  function scheduleRefresh () {
    if (inFlight) { rerun = true; return Promise.resolve(); }
    inFlight = true;
    return refresh().then(done, done);
    function done () {
      inFlight = false;
      if (rerun) { rerun = false; scheduleRefresh(); }
    }
  }

  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {} };
    var first = token === 1;
    if (first) T.mark('data requested');
    try {
      var table = await withRetry(function () { return ExtCore.readSummary(worksheet, { limit: 0 }); }, 'getSummaryData');
      if (token !== renderToken) return;
      var fields = await withRetry(getFields, 'getVisualSpecificationAsync');
      if (token !== renderToken) return;
      var filters = await withRetry(function () { return worksheet.getFiltersAsync(); }, 'getFiltersAsync');
      if (token !== renderToken) return;
      if (first) T.mark('data received');
      var m = await buildModel(table, fields, filters || []);
      if (token !== renderToken) return;
      model = m;
      if (!m.issue && m.filter) applied = stateFromFilter(m.filter);
      paint();
      if (first) { T.mark('text box drawn'); T.done('Calendar Filter load timings'); }
    } catch (err) {
      console.error('Calendar Filter render failed:', err);
      if (first) T.done('Calendar Filter load timings');
      if (token === renderToken) showEmpty('Could not read the data. Click the ! mark in the corner for details.');
    }
  }

  /** The fields on the Start date and End date tiles: { start, end } (either may be null). */
  async function getFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var out = { start: null, end: null };
    (marks.encodings || []).forEach(function (enc) {
      if (!enc.field) return;
      var type = String(enc.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : enc.id;
      if (id === 'start' && !out.start) out.start = enc.field;
      if (id === 'end' && !out.end) out.end = enc.field;
    });
    return out;
  }

  /** The first day found in a column (LOD values are the same on every row). */
  function dayIn (table, field, taken) {
    var col = field ? ExtCore.findColumn(table, field, taken) : null;
    if (!col) return { day: null, col: null };
    var rows = table.data || [];
    for (var i = 0; i < rows.length; i++) {
      var d = Cf.cellDay(rows[i][col.index]);
      if (d != null) return { day: d, col: col };
    }
    return { day: null, col: col };
  }

  function filterKind (f) {
    var t = String((f && f.filterType) || '').toLowerCase();
    if (t.indexOf('categorical') >= 0) return 'categorical';
    if (t.indexOf('relative') >= 0) return 'relative';
    if (t.indexOf('range') >= 0) return 'range';
    return t || 'other';
  }

  /** Is this filter on a date? Range: its min / max are dates. Categorical: its values are. */
  function looksLikeDate (f) {
    var k = filterKind(f);
    if (k === 'range') return Cf.cellDay(f.minValue) != null || Cf.cellDay(f.maxValue) != null;
    if (k === 'categorical') {
      if ((f.appliedValues || []).some(function (dv) { return Cf.cellDay(dv) != null; })) return true;
      return /date|day/i.test(f.fieldName || '');
    }
    return false;
  }

  /**
   * {
   *   range: { start, end } · filter: the Tableau filter · kind: 'categorical' | 'range'
   *   days: sorted days in the filter's list of values (categorical), null = every day (range)
   *   raw: { day: [values as the filter lists them] } · hasNull · nullRaw · caption · filterNames · issue
   * }
   */
  async function buildModel (table, fields, filters) {
    var m = { range: null, filter: null, kind: '', days: null, raw: {}, hasNull: false, nullRaw: [], caption: '', filterNames: [], issue: '' };
    m.filterNames = filters.map(function (f) { return f.fieldName; });
    if (!fields.start || !fields.end) {
      m.issue = 'Drop the first date on <b>Start date</b> and the last date on <b>End date</b>, e.g. <code>{MIN([Order Date])}</code> and <code>{MAX([Order Date])}</code>.';
      return m;
    }
    var s = dayIn(table, fields.start);
    var e = dayIn(table, fields.end, s.col ? [s.col] : []);
    if (s.day != null && e.day != null) lastRange = { start: Math.min(s.day, e.day), end: Math.max(s.day, e.day) };
    // A filter that leaves this sheet with no rows empties Start / End: keep the last ones seen.
    m.range = lastRange;

    var want = cfg.filter.field;
    var f = want ? filters.find(function (x) { return x.fieldName === want; }) : null;
    if (!f) f = filters.find(function (x) { return (filterKind(x) === 'categorical' || filterKind(x) === 'range') && looksLikeDate(x); });
    if (!f) f = filters.find(function (x) { return filterKind(x) === 'relative'; }); // explained below
    if (!f) {
      m.issue = 'Put the date to filter on this sheet’s <b>Filters</b> shelf (Exact Date values, or a range of dates) and set it to <b>Apply to Worksheets → All Using This Data Source</b>.';
      return m;
    }
    m.filter = f;
    m.kind = filterKind(f);
    m.caption = captionOf(f.fieldName);
    if (m.kind !== 'categorical' && m.kind !== 'range') {
      m.issue = 'The filter on “' + ExtCore.esc(f.fieldName) + '” is a relative-date filter. Edit it to <b>Exact Date</b> values or a <b>Range of dates</b>.';
      return m;
    }
    if (m.kind === 'range') {
      m.hasNull = true; // a range of dates always has the null option (Tableau can't tell us whether nulls exist)
    } else {
      var dom = null;
      try {
        var DT = tableau.FilterDomainType || { Database: 'database' };
        dom = await withRetry(function () { return f.getDomainAsync(DT.Database); }, 'getDomainAsync');
      } catch (err) { console.warn('Calendar Filter: could not read the filter’s values', err); }
      var days = [];
      ((dom && dom.values) || []).forEach(function (dv) {
        if (Cf.isNullCell(dv)) { m.hasNull = true; m.nullRaw.push(dv.value == null ? null : dv.value); return; }
        var d = Cf.cellDay(dv);
        if (d == null) return;
        if (!m.raw[d]) { m.raw[d] = []; days.push(d); }
        var v = typeof dv.value === 'string' ? dv.value : Cf.iso(d);
        if (m.raw[d].indexOf(v) < 0) m.raw[d].push(v);
      });
      days.sort(function (a, b) { return a - b; });
      if (!m.range && days.length) m.range = { start: days[0], end: days[days.length - 1] };
      m.days = m.range ? days.filter(function (d) { return d >= m.range.start && d <= m.range.end; }) : days;
    }
    if (!m.range) {
      m.issue = 'Start date and End date are empty. Use FIXED calculations such as <code>{MAX([Order Date])}</code>, which the date filter does not change.';
    }
    return m;
  }

  /** "DAY(Order Date)" / "MDY(Order Date)" → "Order Date". */
  function captionOf (name) {
    var s = String(name || '');
    var mm = /^[A-Za-z]+\((.*)\)$/.exec(s);
    return ExtCore.cleanName(mm ? mm[1] : s);
  }

  async function withRetry (fn, what) {
    for (var i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= CALL_RETRIES) throw err;
        console.warn('Calendar Filter: ' + what + ' failed, retrying', err);
        await new Promise(function (r) { setTimeout(r, 400 * (i + 1) * (i + 1) + Math.random() * 400); });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Drawing the text box
  // ---------------------------------------------------------------------------
  function applyFont (node, f) {
    node.style.fontFamily = Cf.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = f.weight;
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    node.style.color = f.color;
  }

  function paint () {
    if (!cfg) return;
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.background = c.bgOpacity > 0 ? Cf.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    document.documentElement.style.setProperty('--cf-accent', cfg.look.accent);
    if (!model) return;
    if (model.issue) { showEmpty(model.issue); return; }
    el.card.classList.remove('is-empty');
    el.hint.innerHTML = '';

    var t = cfg.title;
    var titleText = t.mode === 'field' ? model.caption : t.mode === 'custom' ? t.text : '';
    el.title.textContent = titleText;
    el.title.style.display = titleText ? '' : 'none';
    applyFont(el.title, t);

    var b = cfg.box;
    applyFont(el.box, b);
    el.box.style.background = b.bgColor;
    el.box.style.borderColor = b.borderColor;
    el.box.style.borderRadius = b.radius + 'px';
    el.box.style.height = b.height + 'px';
    el.boxIcon.style.display = b.icon ? '' : 'none';

    var sum = Cf.summary(applied, cfg, 2);
    el.boxText.textContent = sum || b.placeholder;
    el.boxText.classList.toggle('is-placeholder', !sum);
    el.box.title = (sum || b.placeholder) + ' — click to change';
    el.box.setAttribute('aria-label', (titleText ? titleText + ': ' : '') + (sum || b.placeholder) + '. Open the calendar.');
    el.boxClear.style.display = b.clearButton && Cf.isFiltered(applied, cfg) ? '' : 'none';
    el.notice.textContent = notice;
    el.notice.style.display = notice ? '' : 'none';
  }

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    el.hint.innerHTML = html;
  }

  window.CalendarFilter = { init: init, _captionOf: captionOf, _filterKind: filterKind };
})();
