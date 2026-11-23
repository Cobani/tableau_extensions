'use strict';

/**
 * Calendar Filter — Tableau Viz Extension.
 *
 * A filter, not a chart. The zone shows one text box with the dates currently chosen. Clicking it
 * opens the calendar in Tableau's own dialog window (picker.html), so the calendar is not limited
 * to the size of the zone. The choice is passed to the dashboard by selecting this sheet's marks
 * (one mark per date), which a dashboard Filter action turns into a filter on other sheets.
 *
 * Marks card tiles (calendar-filter.trex):
 *   date    Date (required): one date at day level (exact date or DAY). Datetimes are grouped by day.
 *   value   Value (optional): one measure; shown in the calendar cells and used to shade them.
 *
 * The chosen filter is kept in Tableau's mark selection, not in the settings (viewers on Tableau
 * Server can't save settings). After a reload the text box reads the selection back
 * (getSelectedMarksAsync) and rebuilds the granularity from it (Cf.inferState).
 *
 * Talking to the calendar window:
 *   payload in   { state, days, values, hasNull, nullValue, field, maxDay }
 *   live mode    the window sends { type: 'state', state } with sendDialogMessageToParentAsync
 *                after every change (Tableau Extensions API 1.15+; older Tableau falls back to Apply)
 *   on close     closeDialog(JSON { type: 'apply' | 'cancel' | 'close', state })
 */
(function () {
  var esc = ExtCore.esc;

  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null;          // see buildModel()
  var applied = null;        // the filter in force: { gran, sel, nullState }
  var restored = false;      // the selection was read back from Tableau once
  var dialogOpen = false;
  var renderToken = 0;
  var ownSelect = 0;         // time of our last selectMarks / clear call (their MarkSelectionChanged is ours)
  var notice = '';           // short warning shown under the box, e.g. "No data in Feb 2027"

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
      if (tableau.TableauEventType.MarkSelectionChanged) {
        worksheet.addEventListener(tableau.TableauEventType.MarkSelectionChanged, onSelectionChanged);
      }
      tableau.extensions.settings.addEventListener(tableau.TableauEventType.SettingsChanged, function () {
        var before = cfg;
        cfg = Cf.read();
        // The week start or the granularities changed: the old selection may not fit any more.
        if (before.calendar.weekStart !== cfg.calendar.weekStart && applied.gran === 'W' && applied.sel.length) {
          applied = Cf.emptyState(cfg);
          applySelection();
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
        notice = '';
        applySelection();
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
    var payload = JSON.stringify({ field: model ? model.caption : '' });
    return tableau.extensions.ui.displayDialogAsync(folderUrl() + 'configure.html', payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.error('Calendar Filter dialog error:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // The calendar window
  // ---------------------------------------------------------------------------
  function openCalendar () {
    if (dialogOpen || !model || model.issue) return;
    var size = Cf.WINDOW_SIZES[cfg.window.size] || Cf.WINDOW_SIZES.M;
    var options = { width: size.w, height: size.h };
    var DS = tableau.DialogStyle || {};
    var style = cfg.window.dialog === 'floating' ? DS.Modeless : DS.Modal;
    if (style) options.dialogStyle = style;
    var payload = JSON.stringify({
      state: applied,
      days: model.days,
      values: model.hasValues ? model.days.map(function (d) { return model.value[d]; }) : null,
      hasNull: model.hasNull,
      nullValue: model.nullValue,
      field: model.caption,
      maxDay: model.days.length ? model.days[model.days.length - 1] : null
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
    // A drag sends many states in a row: apply the last one.
    liveTimer = setTimeout(function () { take(msg.state); }, 120);
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
    applySelection();
    paint();
  }

  // ---------------------------------------------------------------------------
  // Passing the filter to Tableau: select this sheet's marks
  // ---------------------------------------------------------------------------
  function applySelection () {
    notice = '';
    if (!model || model.issue || !worksheet) return;
    var r = Cf.resolve(applied, model.days, model.hasNull);
    ownSelect = Date.now();
    if (r.all) { ExtCore.clearSelection(worksheet); return; }
    var raws = [];
    r.days.forEach(function (d) { Array.prototype.push.apply(raws, model.raw[d] || []); });
    if (r.nulls) Array.prototype.push.apply(raws, model.nullRaw);
    if (!raws.length) {
      // Tableau can't select "nothing": clear, so the dashboard shows everything, and say so.
      ExtCore.clearSelection(worksheet);
      notice = applied.nullState === 'only' ? 'No null dates in the data — showing all dates' : 'No data in these dates — showing all dates';
      return;
    }
    ExtCore.select(worksheet, [{ fieldName: model.column, value: raws }], 'Calendar Filter');
  }

  /** Someone else changed the selection (Tableau's own clear, a reset): read it back. */
  var selTimer = 0;
  function onSelectionChanged () {
    if (Date.now() - ownSelect < 1500) return;
    clearTimeout(selTimer);
    selTimer = setTimeout(function () { readSelection().then(function (changed) { if (changed) paint(); }); }, 250);
  }

  /** Reads Tableau's selected marks into `applied`. Resolves true when that changed the filter. */
  async function readSelection () {
    if (!model || model.issue || !worksheet.getSelectedMarksAsync) return false;
    var marks;
    try { marks = await worksheet.getSelectedMarksAsync(); } catch (e) { console.warn('Calendar Filter: could not read the selection', e); return false; }
    var days = {};
    var nullSel = false;
    ((marks && marks.data) || []).forEach(function (table) {
      var col = (table.columns || []).find(function (c) { return c.fieldName === model.column; }) ||
        ExtCore.findColumn(table, model.field);
      if (!col) return;
      (table.data || []).forEach(function (row) {
        var cell = row[col.index];
        if (Cf.isNullCell(cell)) { nullSel = true; return; }
        var d = Cf.cellDay(cell);
        if (d != null) days[d] = true;
      });
    });
    var list = Object.keys(days).map(Number).sort(function (a, b) { return a - b; });
    // Same dates as what we hold: keep ours (it remembers the granularity).
    var cur = Cf.resolve(applied, model.days, model.hasNull);
    var curDays = cur.all ? [] : cur.days;
    if (!cur.all && JSON.stringify(curDays) === JSON.stringify(list) && cur.nulls === nullSel) return false;
    if (cur.all && !list.length && !nullSel) return false;
    applied = Cf.inferState(list, nullSel, model.days, cfg);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Data
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
      // Every row: a calendar with missing dates would be wrong, so there is no row limit here.
      var table = await withRetry(function () { return ExtCore.readSummary(worksheet, { limit: 0 }); }, 'getSummaryData');
      if (token !== renderToken) return;
      var fields = await withRetry(getFields, 'getVisualSpecificationAsync');
      if (token !== renderToken) return;
      if (first) T.mark('data received', (table.data || []).length + ' rows');
      model = buildModel(table, fields);
      if (!restored && !model.issue) {
        restored = true;
        var changed = await readSelection();
        // Nothing chosen yet but nulls are excluded by default: apply that once.
        if (!changed && !Cf.isFiltered(applied, cfg) && cfg.nulls.default === 'exclude' && model.hasNull) applySelection();
      }
      paint();
      if (first) { T.mark('text box drawn'); T.done('Calendar Filter load timings'); }
    } catch (err) {
      console.error('Calendar Filter render failed:', err);
      if (first) T.done('Calendar Filter load timings');
      if (token === renderToken) showEmpty('Could not read the data. Click the ! mark in the corner for details.');
    }
  }

  /** The fields on the Date and Value tiles: { date, value } (either may be null). */
  async function getFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var out = { date: null, value: null };
    (marks.encodings || []).forEach(function (enc) {
      if (!enc.field) return;
      var type = String(enc.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : enc.id;
      if (id === 'date' && !out.date) out.date = enc.field;
      if (id === 'value' && !out.value) out.value = enc.field;
    });
    return out;
  }

  /**
   * {
   *   days: sorted day numbers with data · raw: { day: [raw cell values] } (several for datetimes)
   *   value: { day: summed Value } · hasValues · hasNull · nullRaw: [raw values of null dates]
   *   nullValue · column: the date column's fieldName (for selecting) · field · caption · issue
   * }
   */
  function buildModel (table, fields) {
    var m = { days: [], raw: {}, value: {}, hasValues: false, hasNull: false, nullRaw: [], nullValue: 0, column: '', field: fields.date, caption: '', issue: '' };
    if (!fields.date) {
      m.issue = 'Drop a date on the <b>Date</b> tile (as an exact date or Day).';
      return m;
    }
    var col = ExtCore.findColumn(table, fields.date);
    if (!col) { m.issue = 'Could not find the date field in the data. Remove it from the Date tile and add it again.'; return m; }
    var vcol = fields.value ? ExtCore.findColumn(table, fields.value, [col]) : null;
    m.column = col.fieldName;
    m.caption = captionOf(fields.date.name || col.fieldName);
    m.hasValues = !!vcol;
    var bad = 0;
    var rows = table.data || [];
    for (var i = rows.length - 1; i >= 0; i--) { // Tableau sends rows last-to-first
      var cell = rows[i][col.index];
      var v = vcol ? ExtCore.toNumber(rows[i][vcol.index]) : 1;
      if (!isFinite(v)) v = 0;
      if (Cf.isNullCell(cell)) {
        m.hasNull = true;
        m.nullRaw.push(cell ? cell.value : null);
        m.nullValue += v;
        continue;
      }
      var d = Cf.cellDay(cell);
      if (d == null) { bad++; continue; }
      if (!m.raw[d]) { m.raw[d] = []; m.value[d] = 0; m.days.push(d); }
      if (m.raw[d].indexOf(cell.value) < 0) m.raw[d].push(cell.value);
      m.value[d] += v;
    }
    m.days.sort(function (a, b) { return a - b; });
    if (bad && !m.days.length) {
      m.issue = 'The Date tile needs a full date. Right-click the date on the Date tile and choose <b>Exact Date</b> or <b>Day</b> (the one with the year).';
    } else if (m.days.length > 2 && m.days.every(function (d) { return Cf.parts(d).d === 1; })) {
      m.issue = 'The date is at month or year level. Right-click it on the Date tile and choose <b>Exact Date</b> or <b>Day</b>, so every day can be picked.';
    }
    return m;
  }

  /** "DAY(Order Date)" → "Order Date". */
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

  window.CalendarFilter = { init: init, _buildModel: buildModel, _captionOf: captionOf };
})();
