'use strict';

/**
 * Narrative Card — Tableau Viz Extension.
 *
 * Marks card tiles (declared in narrative-card.trex):
 *   measures  1–12 measures (drop each separately)
 *   date      0–4 date fields at any level (optional; without it the single aggregated row is used)
 *
 * Draws sentences written by the dashboard builder with live numbers inside, e.g.
 *   "{Revenue} this month, {Revenue.change} vs last month."
 * The template language (parser + renderer) lives in config.js (Nc.parseTemplate / Nc.renderTemplate).
 * Each measure is ordered by date and compared exactly like the Narrative Card does (latest value or month to
 * date; previous date or same day last month; % or pp change).
 *
 * Appearance and the template come from the Format dialog (configure.html) and are stored in the
 * workbook through tableau.extensions.settings.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc, toNumber = ExtCore.toNumber, isMN = ExtCore.isMN, isNumericCol = ExtCore.isNumericCol,
    cleanName = ExtCore.cleanName;

  // Per-measure settings are saved under this name, so it must never change: it strips only the
  // aggregations older versions stripped (cleanName, used for labels, knows more).
  function keyName (name) {
    return String(name || '').replace(/^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|ATTR)\((.*)\)$/i, '$2');
  }

  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null;    // { measures: [{ key, label, data }], dateFields, hasDate } (see extract)
  var lastData = null; // the series of the measure being worked on: { points: [{ label, v, fv }], calendar, grain, … }
  var renderToken = 0;

  var MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  var WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'body', 'text', 'hint', 'tooltip'].forEach(function (id) {
      el[id.replace(/-(\w)/g, function (_, c) { return c.toUpperCase(); })] =
        document.getElementById(id);
    });

    el.card.addEventListener('mousemove', onCardHover);
    el.card.addEventListener('mouseleave', onCardLeave);
    el.card.addEventListener('click', onCardClick);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') clearPicked(); });

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
    return tableau.extensions.initializeAsync({ configure: configure }).then(function () {
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      boot.ok();
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Nc.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, requestRefresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () { cfg = Nc.read(); if (limitChanged()) refresh(); else paint(); }
      );

      if (window.ResizeObserver) {
        new ResizeObserver(function () { layout(); if (deferred && isShown()) scheduleRefresh(); }).observe(document.body);
      } else {
        window.addEventListener('resize', layout);
      }

      return scheduleRefresh();
    }).catch(function (err) {
      if (initDone) {
        console.error('Narrative Card failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Narrative Card failed to initialize:', err);
      if (!boot.retry('handshake failed')) showRetry();
    });
  }

  // Handshake timeout: 4 s on the first load, +2 s per reload (4, 6, 8, 10 s → about 28 s
  // before giving up). A late answer still draws the chart, even after giving up.
  var INIT_TIMEOUT = 4000;
  var INIT_TIMEOUT_STEP = 2000;

  /** A click reloads the card. */
  function showRetry (why) {
    showEmpty((why || 'Could not connect to Tableau.') + '<br><u>Click to reload this card.</u>');
    el.hint.style.cursor = 'pointer';
    el.hint.onclick = function () { if (window.ExtBoot) ExtBoot.reload(); else location.reload(); };
  }

  /** Opens the Format dialog ("Format Extension" on the Marks card). */
  function configure () {
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html';
    var options = { width: 560, height: 760 };
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) {
      options.dialogStyle = tableau.DialogStyle.Modal; // stays in front of Tableau until Done; the card behind it still updates live
    }
    // The dialog can't read the Marks card: it gets the field names for its token list (and the
    // parameters, asked for once, now that the builder is working on the text).
    var ready = paramsState === 0 ? loadParams() : Promise.resolve();
    return ready.then(function () {
      var payload = JSON.stringify({
        fields: fieldNames(lastFields ? lastFields.value : []),
        params: Object.keys(params).map(function (k) { return params[k].name; })
      });
      return tableau.extensions.ui.displayDialogAsync(url, payload, options);
    }).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.error('Narrative Card dialog error:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Refresh scheduling. Tableau runs extension requests one at a time, shared
  // with the rest of the dashboard, so each card keeps at most one data request
  // going, waits for a burst of filter changes to settle, and doesn't ask for
  // data while its zone is hidden (it catches up when shown again).
  // ---------------------------------------------------------------------------
  var REFRESH_DELAY = 150; // ms to wait for a burst of changes to settle
  var CALL_RETRIES = 2;     // extra tries for a call Tableau rejected (never for a slow one)
  var inFlight = false;
  var rerun = false;
  var deferred = false;
  var refreshTimer = 0;

  function isShown () {
    return document.body.clientWidth > 0 && document.body.clientHeight > 0;
  }

  /** SummaryDataChanged: wait briefly, so several changes in a row fetch once. */
  function requestRefresh () {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(scheduleRefresh, REFRESH_DELAY);
  }

  function scheduleRefresh () {
    if (!isShown()) { deferred = true; return Promise.resolve(); }
    deferred = false;
    if (inFlight) { rerun = true; return Promise.resolve(); }
    inFlight = true;
    return refresh().then(done, done);
    function done () {
      inFlight = false;
      if (rerun) { rerun = false; scheduleRefresh(); }
    }
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
      // Every call waits in Tableau's single queue for the whole dashboard, so the card
      // makes as few as it can: one data call, and the Marks card only when this browser
      // hasn't seen these columns before (cached per column set).
      var tFields = 0;
      var tData = 0;
      var table = await withRetry(readSummaryData, 'getSummaryDataAsync').then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });
      if (token !== renderToken) return;

      var sig = table.error ? '' : columnsSignature(table);
      // The cache only speeds up the first draw of a page load; it's checked against the
      // Marks card shortly after, and every later refresh asks the Marks card.
      var fields = sig && first ? cachedFields(sig) : null;
      if (fields && !fieldsComplete(fields, table)) fields = null;
      if (fields) {
        T.mark('fields from cache (Marks card not asked)');
        setTimeout(function () { verifyFields(sig); }, VERIFY_DELAY);
      } else {
        fields = await withRetry(getEncodedFields, 'getVisualSpecificationAsync');
        tFields = ms();
        if (first) T.mark('fields received (Marks card)');
        if (token !== renderToken) return;
        if (sig && fields.value.length && fieldsComplete(fields, table)) storeFields(sig, fields);
      }

      if (!fields.value.length) {
        model = null;
        if (first) { T.mark('no fields on the Marks card'); T.done('Narrative Card load timings'); }
        showEmpty('Drag measures onto the <b>Measures</b> tile (one at a time) and, if you want changes, a date onto <b>Date</b>.');
        return;
      }

      if (table && table.error) throw table.error;

      lastTable = table;
      lastFields = fields;
      model = extract(table, fields);
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Narrative Card load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Narrative Card render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Narrative Card load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  // After a draw from cached fields, ask the Marks card once (later, so it doesn't hold up
  // other extensions on the dashboard) and redraw if the pills differ.
  var VERIFY_DELAY = 4000;
  var lastTable = null;
  var lastFields = null;

  async function verifyFields (sig) {
    try {
      var fields = await withRetry(getEncodedFields, 'getVisualSpecificationAsync');
      if (!lastFields || !lastTable || columnsSignature(lastTable) !== sig) return; // a newer refresh already ran
      var names = function (f) { return f.value.concat(f.date, f.details || [], f.extra || []).map(function (x) { return x.id + '|' + x.name; }).join('\u0001'); };
      if (fields.value.length && fieldsComplete(fields, lastTable)) storeFields(sig, fields);
      if (fields.value.length && names(fields) !== names(lastFields)) {
        lastFields = fields;
        model = extract(lastTable, fields);
        paint();
      }
    } catch (e) { /* keep the cached fields */ }
  }

  /** Fields worth caching: a date pill was reported, or there's no column left over for one. */
  function fieldsComplete (fields, table) {
    var n = ((table && table.columns) || []).filter(function (c) { return !isMN(c); }).length;
    return (fields.date || []).length > 0 || n <= (fields.value || []).length + (fields.details || []).length + (fields.extra || []).length;
  }

  /** { value: [fields of the Measures tile], date: [fields of the Date tile] } in the order they were dropped. */
  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = { value: [], date: [], details: [], extra: [] };
    marks.encodings.forEach(function (enc) {
      if (!enc.field) return;
      // Measures on Tableau's own Tooltip tile only claim their column (fields.details); the card does not use them.
      // Anything else on a built-in tile (Detail, dimensions on Tooltip) only adds rows: those
      // columns are kept out of the date/measure matching (fields.extra).
      var type = String(enc.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : enc.id;
      if (id === 'tooltip' && isMeasureField(enc.field)) id = 'details';
      else if (id === 'measures') id = 'value';
      else if (id !== 'date') id = 'extra';
      fields[id].push(enc.field);
    });
    return fields;
  }

  function isMeasureField (f) {
    var role = String(f.role || '').toLowerCase();
    if (role === 'measure') return true;
    if (role === 'dimension') return false;
    return /^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|STDEV|STDEVP|VAR|VARP|PCT\d+)\(/i.test(String(f.name || ''));
  }

  // One call (get-summary-data) instead of three for the reader (create, page, release).
  // A narrative sheet has one row per date at most, far below any paging limit.
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

  // Marks card fields per column set: in memory, and in this browser's localStorage so the
  // next page load skips that call too. Same columns => same fields on the same tiles.
  var FIELDS_KEY = 'narrative-card:fields:v1';
  var fieldsMem = null;

  function fieldsStore () {
    if (fieldsMem) return fieldsMem;
    fieldsMem = {};
    try { fieldsMem = JSON.parse(window.localStorage.getItem(FIELDS_KEY) || '{}') || {}; } catch (e) { /* ignore */ }
    return fieldsMem;
  }

  function cachedFields (sig) {
    var f = fieldsStore()[sig];
    if (f && f.value && f.date) { f.details = f.details || []; f.extra = f.extra || []; }
    return f && f.value && f.date ? f : null;
  }

  function storeFields (sig, fields) {
    var all = fieldsStore();
    var slim = function (list) { return (list || []).map(function (f) { return { id: f.id || f.fieldId, name: f.name || f.fieldName }; }); };
    all[sig] = { value: slim(fields.value), date: slim(fields.date), details: slim(fields.details), extra: slim(fields.extra), t: Date.now() };
    var keys = Object.keys(all);
    if (keys.length > 60) { // keep the newest 60 column sets
      keys.sort(function (a, b) { return (all[a].t || 0) - (all[b].t || 0); });
      keys.slice(0, keys.length - 60).forEach(function (k) { delete all[k]; });
    }
    try { window.localStorage.setItem(FIELDS_KEY, JSON.stringify(all)); } catch (e) { /* ignore */ }
  }

  function columnsSignature (table) {
    return (table && table.columns ? table.columns : []).map(function (c) { return c.fieldId || c.fieldName; }).join('\u0001');
  }

  /** A call Tableau rejects (busy server) is tried again a couple of times, after a short random pause. */
  async function withRetry (fn, what) {
    for (var i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= CALL_RETRIES) throw err;
        console.warn('Narrative Card: ' + what + ' failed, retrying', err);
        await new Promise(function (r) { setTimeout(r, 400 * (i + 1) * (i + 1) + Math.random() * 400); });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Pill → summary-data column matching
  // ---------------------------------------------------------------------------
  // The Marks card (pills) and the sheet data (columns) don't always describe a field the
  // same way: a published data source gives them different data-source ids
  // ([sqlproxy.x].[sum:Sales:qk] vs [federated.y].[sum:Sales:qk]), a renamed field shows its
  // new caption on one side and the original name on the other, and a date pill can come back
  // without its field at all. So pills are matched in rounds — exact id, id without the data
  // source, exact name, name without aggregation, underlying field name — each round over all
  // pills before the next, and whatever is still unmatched is filled by role from the free
  // columns: date-like columns for the Date tile, numbers for measures.
  var DATE_PART_RE = /^(YEAR|YR|TYEAR|QUARTER|QR|TQUARTER|MONTH|MN|MY|TMONTH|WEEK|WK|TWEEK|DAY|DY|MDY|TDAY|WEEKDAY|HOUR|MINUTE|SECOND|ISO[A-Z]*|DATETRUNC|DATEPART)\(/i;
  function looksLikeDateCol (c) {
    return /^date(-?time)?$/i.test(String(c.dataType || '')) || DATE_PART_RE.test(String(c.fieldName || ''));
  }
  function looksAggregated (c) { return /^(SUM|AVG|MIN|MAX|CNT|CNTD|COUNT|COUNTD|MEDIAN|AGG|ATTR|STDEV|STDEVP|VAR|VARP|PCT\d+)\(/i.test(String(c.fieldName || '')); }
  function normName (s) { return String(s || '').replace(/^[A-Z_]+\((.*)\)$/i, '$1').trim().toLowerCase(); }
  function pillId (f) { return f ? String(f.id || f.fieldId || '') : ''; }
  function pillName (f) { return f ? String(f.name || f.fieldName || f.caption || '') : ''; }
  /** "[federated.x].[sum:Sales:qk]" → "sum:sales:qk" */
  function idTail (id) {
    var s = String(id || '').trim();
    var m = /\[((?:[^\]]|\]\])*)\]\s*$/.exec(s);
    return (m ? m[1] : s).trim().toLowerCase();
  }
  /** "[federated.x].[sum:Sales:qk]" → "sales"; "[Calculation_12]" → "calculation_12" */
  function idBase (id) {
    var parts = idTail(id).split(':');
    return (parts.length >= 3 ? parts.slice(1, -1).join(':') : parts.join(':')).trim();
  }

  /**
   * Finds the column of every pill at once. Returns { value: [column|null per value pill],
   * date: [columns, coarse order not applied], mn, mv }.
   *  - the same measure twice on the tile comes as one column (both read it);
   *  - Measure Names / Measure Values in the data: measures stay null (read from MV rows).
   */
  function resolveColumns (table, fields) {
    var cols = table.columns || [];
    var cMN = cols.find(function (c) { return /^measure names$/i.test(String(c.fieldName || '')); }) || null;
    var cMV = cols.find(function (c) { return /^measure values$/i.test(String(c.fieldName || '')); }) || null;
    var pivoted = !!(cMN && cMV);
    var taken = [];
    var free = function () { return cols.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); }); };
    var pills = [];
    (fields.date || []).forEach(function (f, i) { pills.push({ tile: 'date', i: i, f: f, col: null }); });
    (fields.value || []).forEach(function (f, i) { pills.push({ tile: 'value', i: i, f: f, col: null }); });
    (fields.details || []).forEach(function (f, i) { pills.push({ tile: 'details', i: i, f: f, col: null }); });
    (fields.extra || []).forEach(function (f, i) { pills.push({ tile: 'extra', i: i, f: f, col: null }); });

    var rounds = [
      function (f, c) { var id = pillId(f); return !!id && !!c.fieldId && c.fieldId === id; },
      function (f, c) { var t = idTail(pillId(f)); return !!t && t === idTail(c.fieldId); },
      function (f, c) { var n = pillName(f); return !!n && c.fieldName === n; },
      function (f, c) { var n = normName(pillName(f)); return !!n && normName(c.fieldName) === n; },
      function (f, c) {
        var pb = idBase(pillId(f));
        var cb = idBase(c.fieldId);
        var pn = normName(pillName(f));
        var cn = normName(c.fieldName);
        return (!!pb && (pb === cn || pb === cb)) || (!!cb && cb === pn);
      }
    ];
    rounds.forEach(function (test) {
      pills.forEach(function (p) {
        if (p.col || (!pillId(p.f) && !pillName(p.f))) return;
        var hits = free().filter(function (c) { return test(p.f, c); });
        var fits = p.tile === 'date' || p.tile === 'extra'
          ? function (c) { return looksLikeDateCol(c) || !(isNumericCol(c) || looksAggregated(c)); }
          : function (c) { return !looksLikeDateCol(c); };
        var x = hits.find(fits) || hits[0];
        if (x) { p.col = x; taken.push(x); }
      });
    });

    var values = pills.filter(function (p) { return p.tile === 'value'; });
    var dets = pills.filter(function (p) { return p.tile === 'details'; });
    var measures = values.concat(dets);
    // Same field twice (on a tile, or on Measure and Details): one column, read by both.
    measures.forEach(function (p) {
      if (p.col) return;
      var twin = measures.find(function (o) {
        return o !== p && o.col && ((pillId(o.f) && pillId(o.f) === pillId(p.f)) || (pillName(o.f) && pillName(o.f) === pillName(p.f)));
      });
      if (twin) p.col = twin.col;
    });

    var guessed = [];
    var take = function (p, x) { if (x) { p.col = x; taken.push(x); guessed.push(p.tile + ' "' + pillName(p.f) + '" → ' + x.fieldName); } };
    // Unmatched date pills: a date-like column first, then any non-measure-looking one.
    pills.forEach(function (p) {
      if (p.tile !== 'date' || p.col) return;
      take(p, free().find(looksLikeDateCol) || free().find(function (c) { return !isNumericCol(c) && !looksAggregated(c); }));
    });
    // Unmatched measures: a number that isn't a date part, then anything that isn't date-like.
    if (!pivoted) {
      measures.forEach(function (p) {
        if (p.col) return;
        take(p, free().find(function (c) { return isNumericCol(c) && !looksLikeDateCol(c); }) ||
          free().find(function (c) { return !looksLikeDateCol(c); }));
      });
    }
    var dates = pills.filter(function (p) { return p.tile === 'date' && p.col; }).map(function (p) { return p.col; });
    // Built-in tile fields were matched above, so date-like columns left over (a date pill the
    // Marks card didn't report) are dates, and so is anything that doesn't look like a measure.
    free().forEach(function (c) {
      if (looksLikeDateCol(c) || !(isNumericCol(c) || looksAggregated(c))) { taken.push(c); dates.push(c); guessed.push('extra date → ' + c.fieldName); }
    });
    if (guessed.length && !resolveColumns.logged) {
      resolveColumns.logged = true;
      console.info('Narrative Card: matched fields by role:', guessed, '\npills:', JSON.stringify({ value: (fields.value || []).map(function (f) { return [pillId(f), pillName(f)]; }), date: (fields.date || []).map(function (f) { return [pillId(f), pillName(f)]; }) }),
        '\ncolumns:', JSON.stringify(cols.map(function (c) { return [c.fieldId, c.fieldName, c.dataType]; })));
    }
    // Measure Names rows per measure: by name, else (renamed pill) by position on the tile.
    var mnLabels = [];
    var detLabels = [];
    if (pivoted) {
      var seen = [];
      (table.data || []).forEach(function (r) {
        var c = r[cMN.index];
        var n = c && (c.formattedValue != null ? c.formattedValue : c.value);
        if (n != null && seen.indexOf(String(n)) < 0) seen.push(String(n));
      });
      seen.reverse(); // summary data arrives last-to-first
      var used = [];
      mnLabels = values.map(function (p) {
        var want = normName(pillName(p.f));
        var hit = seen.find(function (n) { return normName(n) === want; });
        if (hit) used.push(hit);
        return hit || null;
      });
      var rest = seen.filter(function (n) { return used.indexOf(n) < 0; });
      mnLabels = mnLabels.map(function (n) { return n || rest.shift() || null; });
      detLabels = dets.map(function (p) {
        var want = normName(pillName(p.f));
        return seen.find(function (n) { return normName(n) === want; }) || null;
      });
    }
    return {
      value: values.map(function (p) { return p.col; }), date: dates, mn: cMN, mv: cMV, mnLabels: mnLabels,
      details: dets.map(function (p) { return p.col; }), detLabels: detLabels
    };
  }

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
    return rank[p] || (m ? 5 : 5); // exact dates count as day level
  }

  /**
   * Turns one date cell into something sortable. Handles real dates (exact or
   * truncated), numeric date parts (YEAR 2026, MONTH 5, WEEK 18, QUARTER 2)
   * and named parts ("May", "Q2", "Monday", "May 2026").
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
      var parsed = Date.parse(s);
      if (!isNaN(parsed)) return parsed;
    }
    return NaN;
  }

  /**
   * A real calendar date for a cell, or null for date parts (YEAR 2026,
   * "May", "Q2"). Returned as { y, m (0-11), d, t: UTC ms at midnight }.
   */
  function toDay (cell) {
    if (!cell) return null;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    var y, m, d;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      // Tableau sends dates as UTC midnight; anything else is a local time.
      var utc = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
      y = utc ? v.getUTCFullYear() : v.getFullYear();
      m = utc ? v.getUTCMonth() : v.getMonth();
      d = utc ? v.getUTCDate() : v.getDate();
    } else {
      var iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v == null ? '' : v).trim());
      if (!iso) return null;
      y = +iso[1]; m = +iso[2] - 1; d = +iso[3];
    }
    return { y: y, m: m, d: d, t: Date.UTC(y, m, d) };
  }

  function compareKeys (a, b) {
    for (var i = 0; i < a.key.length; i++) {
      var x = a.key[i];
      var y = b.key[i];
      var xn = isNaN(x);
      var yn = isNaN(y);
      if (xn && yn) continue;
      if (xn) return 1;
      if (yn) return -1;
      if (x !== y) return x - y;
    }
    return a.i - b.i; // Tableau's own order as the tie-breaker
  }

  /** One measure of the Measures tile → its date-ordered series (the proven single-measure reader). */
  function extractOne (table, fields, res) {
    var rows = table.data || [];
    res = res || resolveColumns(table, fields);
    var cValue = res.value[0] || null;
    var cDates = res.date.slice();
    // Measure Names / Measure Values: this card reads Measure Values on its own rows.
    var cMV = null;
    if (!cValue && res.mn && res.mv) {
      var f0 = fields.value[0];
      var want = [normName(f0.name), normName(cleanName(f0.name))];
      if (res.mnLabels && res.mnLabels[0]) want.push(normName(res.mnLabels[0]));
      var mine = rows.filter(function (r) {
        var c = r[res.mn.index];
        var n = normName(c && (c.formattedValue != null ? c.formattedValue : c.value));
        return want.indexOf(n) >= 0;
      });
      if (mine.length) { rows = mine; cMV = res.mv; }
    }
    // Coarse → fine, so YEAR + MONTH sorts by year first.
    cDates = cDates
      .map(function (c, k) { return { c: c, k: k, g: granularity(c.fieldName) }; })
      .sort(function (a, b) { return a.g - b.g || a.k - b.k; })
      .map(function (o) { return o.c; });

    var label = cleanName(cValue && !cMV ? cValue.fieldName : (cMV && res.mnLabels && res.mnLabels[0]) || fields.value[0].name);

    // The finest date column that holds real dates drives the calendar logic
    // (Points shown window, same day last month, month to date).
    var cDay = null;
    for (var ci = cDates.length - 1; ci >= 0 && !cDay; ci--) {
      for (var ri = 0; ri < rows.length; ri++) {
        var cellD = rows[ri][cDates[ci].index];
        var raw = cellD && (cellD.nativeValue != null ? cellD.nativeValue : cellD.value);
        if (raw == null || raw === '%null%' || raw === '') continue;
        if (toDay(cellD)) cDay = cDates[ci];
        break;
      }
    }

    if (!cValue && cMV) cValue = cMV;
    if (!cValue) {
      console.warn('Narrative Card: no column for', fields.value[0], 'in', table.columns.map(function (c) { return c.fieldName + ' [' + c.fieldId + ']'; }));
      return { label: label, points: [], hasDate: cDates.length > 0, dateIssue: 'Couldn’t find the measure in the sheet data.' };
    }

    // Many rows share the same date (extra detail on the sheet), so each
    // distinct date is parsed once.
    var memo = cDates.map(function () { return new Map(); });
    var dayMemo = new Map();
    var parsed = function (k, cell) {
      var raw = cell ? (cell.nativeValue != null ? cell.nativeValue : cell.value) : null;
      if (raw instanceof Date) raw = 'd' + raw.getTime();
      else if (typeof raw === 'number') raw = 'n' + raw;
      var id = String(raw) + '\u0001' + (cell ? cell.formattedValue : '');
      var hit = memo[k].get(id);
      if (!hit) { hit = { o: ordinal(cell), f: cell ? cell.formattedValue : undefined, id: id }; memo[k].set(id, hit); }
      return hit;
    };
    var dayOf = function (cell) {
      var raw = cell ? (cell.nativeValue != null ? cell.nativeValue : cell.value) : null;
      if (raw instanceof Date) return toDay(cell);
      var id = String(raw);
      if (!dayMemo.has(id)) dayMemo.set(id, toDay(cell));
      return dayMemo.get(id);
    };

    // Rows with the same dates are added up straight away (same result as
    // merging them after the sort), so only one point per date gets sorted.
    var byDate = new Map();
    var pts = [];
    // Position of each row in the summary data as Tableau sent it (Tableau's own tooltip needs it).
    var origin = rows === table.data ? null : new Map(table.data.map(function (r, j) { return [r, j]; }));
    rows.forEach(function (r, i) {
      var cell = r[cValue.index];
      var v = toNumber(cell);
      if (!isFinite(v)) return;
      var key = new Array(cDates.length);
      var lab = new Array(cDates.length);
      var ids = new Array(cDates.length);
      var raws = new Array(cDates.length);
      for (var k = 0; k < cDates.length; k++) {
        var pc = parsed(k, r[cDates[k].index]);
        raws[k] = r[cDates[k].index] ? r[cDates[k].index].value : null; // raw cell value, for selecting in Tableau
        key[k] = pc.o;
        lab[k] = pc.f;
        ids[k] = pc.id;
      }
      var gid = cDates.length && ids.indexOf(null) < 0 ? ids.join('') : null;
      if (gid !== null) {
        var prev = byDate.get(gid);
        if (prev) { prev.v += v; prev.fv = null; return; }
      }
      var pt = {
        i: i,
        ri: origin ? origin.get(r) : i, // summary-data row index as sent (first row when several share a date)
        v: v,
        fv: cell.formattedValue,
        key: key,
        day: cDay ? dayOf(r[cDay.index]) : null,
        label: lab.join(' · '),
        raws: raws
      };
      if (gid !== null) byDate.set(gid, pt);
      pts.push(pt);
    });

    if (cDates.length) {
      pts.sort(compareKeys);
      // Merge rows that share the same date (only happens with extra detail).
      var merged = [];
      pts.forEach(function (p) {
        var prev = merged[merged.length - 1];
        if (prev && prev.label === p.label) {
          prev.v += p.v;
          prev.fv = null;
        } else {
          merged.push(p);
        }
      });
      pts = merged;
    } else if (pts.length > 1) {
      // No date: collapse to one total.
      var total = pts.reduce(function (s, p) { return s + p.v; }, 0);
      pts = [{ i: 0, ri: pts[0].ri, v: total, fv: null, key: [], label: '' }];
    }

    var issue = '';
    if (fields.date.length && !cDates.length) {
      issue = 'Couldn’t find the date field in the sheet data. Try removing and re-adding it.';
    } else if (!cDates.length) {
      issue = 'Drag a date field onto the Date tile to show the trend and the change.';
    } else if (pts.length < 2) {
      issue = 'Only one date in the data, so there’s no trend or change to show yet.';
    }

    var calendar = !!cDay && pts.length > 0 && pts.every(function (p) { return p.day; });
    return {
      label: label,
      points: pts,
      hasDate: cDates.length > 0,
      dateFields: cDates.map(function (c) { return c.fieldName; }), // fieldNames as in the summary data
      dateIssue: issue,
      calendar: calendar, // every point has a real date
      grain: calendar ? granularity(cDay.fieldName) : 0
    };
  }

  /**
   * Summary data → one ordered series per measure on the Measures tile:
   * { measures: [{ key, label, data }], dateFields, hasDate }.
   * Each measure is read exactly like a single-number card (extractOne).
   */
  function extract (table, fields) {
    var res = resolveColumns(table, fields);
    var seen = {};
    var measures = (fields.value || []).map(function (f, i) {
      var name = pillName(f);
      var base = keyName(name) || name || 'Measure';
      seen[base] = (seen[base] || 0) + 1;
      var key = seen[base] > 1 ? base + ' #' + seen[base] : base;
      var data = extractOne(table, { value: [f], date: fields.date || [] },
        { value: [res.value[i]], date: res.date, mn: res.mn, mv: res.mv, mnLabels: [(res.mnLabels || [])[i]] });
      return { key: key, label: cleanName(name) || base, data: data };
    });
    var first = measures.find(function (m) { return m.data.dateFields; });
    return {
      measures: measures,
      dateFields: first ? first.data.dateFields : [],
      hasDate: measures.some(function (m) { return m.data.hasDate; })
    };
  }

  /** Names for the Format dialog's token list: [{ key, label }] in tile order. */
  function fieldNames (fieldsOnTile) {
    var seen = {};
    return (fieldsOnTile || []).map(function (f) {
      var name = pillName(f);
      var base = keyName(name) || name || 'Measure';
      seen[base] = (seen[base] || 0) + 1;
      return { key: seen[base] > 1 ? base + ' #' + seen[base] : base, label: cleanName(name) || base };
    });
  }

  // ---------------------------------------------------------------------------
  // Date logic, per measure (proven single-number card logic; `lastData` is the measure being worked on)
  // ---------------------------------------------------------------------------

  /** Rolls days up into one value: `how` = sum | avg (defaults to the % Change setting). */
  var itemAgg = ''; // the measure's own roll-up (sum | avg) while its values are computed; '' = the tabs' settings
  function aggregate (vals, how) {
    var sum = vals.reduce(function (s, v) { return s + v; }, 0);
    return (itemAgg || how || cfg.change.mtdAgg) === 'avg' ? sum / vals.length : sum;
  }

  function sameMonth (a, b) { return a && b && a.y === b.y && a.m === b.m; }

  /** Month-to-date value at point `idx`: day 1 of its month through that date. */
  function mtdValue (idx, how) {
    var all = lastData.points;
    var p = all[idx];
    if (!p.day) return p.v;
    var vals = [];
    for (var j = idx; j >= 0 && sameMonth(all[j].day, p.day); j--) vals.push(all[j].v);
    return aggregate(vals, how);
  }

  /** The same day one month earlier, clamped to that month's last day (31 Mar → 28/29 Feb). */
  function sameDayLastMonth (day) {
    var y = day.m === 0 ? day.y - 1 : day.y;
    var m = day.m === 0 ? 11 : day.m - 1;
    var last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    var d = Math.min(day.d, last);
    return { y: y, m: m, d: d, t: Date.UTC(y, m, d) };
  }

  function isMtd () { return cfg.change.period === 'mtd' && lastData && lastData.calendar; }

  /** Big number set to month to date (Big number tab), and the data has real dates. */
  function isNumberMtd () { return cfg.number.period === 'mtd' && lastData && lastData.calendar; }

  /**
   * What point `idx` is compared with, per the % Change settings:
   *   compareTo  previous   the date point before it
   *              prevMonth  the same day last month
   *   period     day        single-day values
   *              mtd        month-to-date values (needs real dates)
   * → { cur, base, baseLabel } or null when there's nothing to compare with.
   */
  function comparison (idx) {
    var c = cfg.change;
    var all = lastData.points;
    var p = all[idx];
    if (!p) return null;
    var mtd = c.period === 'mtd';
    if ((mtd || c.compareTo === 'prevMonth') && !p.day) return null;
    var cur = mtd ? mtdValue(idx) : p.v;

    if (c.compareTo === 'prevMonth') {
      var tgt = sameDayLastMonth(p.day);
      if (mtd) {
        var vals = [];
        var lastLabel = '';
        for (var j = idx - 1; j >= 0; j--) {
          var q = all[j];
          if (!q.day || q.day.t < Date.UTC(tgt.y, tgt.m, 1)) break;
          if (sameMonth(q.day, tgt) && q.day.d <= tgt.d) {
            vals.push(q.v);
            if (!lastLabel) lastLabel = q.label;
          }
        }
        if (!vals.length) return null;
        return { cur: cur, base: aggregate(vals), baseLabel: lastLabel + ' MTD' };
      }
      for (var k = idx - 1; k >= 0; k--) {
        if (!all[k].day || all[k].day.t < tgt.t) break;
        if (all[k].day.t === tgt.t) return { cur: cur, base: all[k].v, baseLabel: all[k].label };
      }
      return null;
    }

    if (idx < 1) return null;
    var prev = all[idx - 1];
    return {
      cur: cur,
      base: mtd ? mtdValue(idx - 1) : prev.v,
      baseLabel: (prev.label || 'previous') + (mtd ? ' MTD' : '')
    };
  }

  /** Words for the change text: "than <this>". */
  function comparisonWord () {
    var c = cfg.change;
    var mtd = isMtd();
    if (c.compareTo === 'prevMonth') return mtd ? 'last month MTD' : 'same day last month';
    var word = (cfg.change.periodWord || '').trim() || 'period';
    return 'previous ' + word + (mtd ? ' MTD' : '');
  }

  // ---------------------------------------------------------------------------
  // Header, frame and picture export (plumbing kept from the single-number card)
  // ---------------------------------------------------------------------------
  // Save as picture (optional): PNG only, the card is HTML with a small SVG trend line.
  var snap = null;
  function syncSnapshot () {
    var on = !!(cfg && cfg.export && cfg.export.picture) && window.ExtSnapshot;
    if (on && !snap) {
      snap = ExtSnapshot.button({
        host: el.card,
        element: el.card,
        title: function () { return (el.title && el.title.textContent) || worksheet && worksheet.name || 'Narrative Card'; }
      });
    }
    if (on) snap.refresh();
    else if (snap) { snap.destroy(); snap = null; }
  }

  function applyFont (node, f) {
    node.style.fontFamily = Nc.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Nc.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.card.style.borderRightColor = c.divider ? c.dividerColor : 'transparent';
    el.card.style.borderRightWidth = c.divider ? '1px' : '0';
  }

  function paintHeader () {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Nc.iconHtml(ic.builtinId, ic.color, iconTarget());
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
    el.title.textContent = t.text || '';
    el.title.style.textAlign = t.align || 'left';
    el.title.style.display = t.show && t.text ? '' : 'none';

    // An empty or hidden explanation still takes up its line (when "Keep
    // space" is on), so the big numbers of cards side by side line up.
    var ex = cfg.explanation;
    var hasText = ex.show && !!String(ex.text || '').trim();
    applyFont(el.explanation, ex);
    el.explanation.style.textAlign = t.align || 'left';
    el.explanation.textContent = hasText ? ex.text : '\u00A0';
    el.explanation.style.display = hasText || ex.reserveSpace ? '' : 'none';
    updateIconSpan();
  }

  /** Icons are 24px on their longer side: 24 wide if landscape, 24 tall if portrait. */
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

  /** Icon size from Format → Icon: px on the longer side (default 24, as in Figma). */
  function iconTarget () {
    var n = Number(cfg.icon.size);
    return isFinite(n) && n > 0 ? Math.max(8, Math.min(128, n)) : 24;
  }

  function setIconBox (w, h) {
    el.icon.style.width = w + 'px';
    el.icon.style.height = h + 'px';
    iconBoxH = h;
    updateIconSpan();
  }

  var iconBoxH = 0;

  /**
   * Figma layout (24px icon): icon centred on the title, explanation below it.
   * Once the icon is clearly taller than the title line it spans title and
   * explanation instead, so the explanation isn't pushed down.
   */
  function updateIconSpan () {
    var head = el.icon.parentNode;
    var titleH = el.title.offsetHeight || 19;
    var hasExplanation = el.explanation.style.display !== 'none';
    head.classList.toggle('icon-span', hasExplanation && iconBoxH > titleH * 1.5);
  }

  /** Value the big number shows: the latest date, or month to date (Big number tab only). */
  function bigValue (idx) {
    var p = lastData.points[idx];
    if (isNumberMtd()) return { v: mtdValue(idx, cfg.number.mtdAgg), fv: null };
    return { v: p.v, fv: p.fv };
  }

  // ---------------------------------------------------------------------------
  // Parameters: for <Parameter name> in the template. Only asked for when the template uses one.
  // ---------------------------------------------------------------------------
  var params = {};
  var paramWatch = {};
  var paramsState = 0; // 0 not asked, 1 asking, 2 done

  function usesParams () { return /<[^<>\n]+>/.test(String((cfg && cfg.template && cfg.template.text) || '')); }

  function loadParams () {
    try {
      if (!worksheet || !worksheet.getParametersAsync) { paramsState = 2; return Promise.resolve(); }
      paramsState = 1;
      return worksheet.getParametersAsync().then(function (list) {
        var next = {};
        (list || []).forEach(function (p) {
          var cv = p.currentValue || {};
          next[String(p.name).toLowerCase()] = { name: p.name, value: cv.formattedValue != null ? String(cv.formattedValue) : String(cv.value) };
          var id = p.id || p.name;
          if (!paramWatch[id] && p.addEventListener && tableau.TableauEventType.ParameterChanged) {
            paramWatch[id] = true;
            p.addEventListener(tableau.TableauEventType.ParameterChanged, function () { loadParams(); });
          }
        });
        var changed = JSON.stringify(next) !== JSON.stringify(params);
        params = next;
        paramsState = 2;
        if (changed && model && cfg) paint();
      }).catch(function (e) { paramsState = 2; console.info('Narrative Card: parameters not available', e && e.message); });
    } catch (e) { paramsState = 2; return Promise.resolve(); }
  }

  function paramMap () {
    var o = {};
    Object.keys(params).forEach(function (k) { o[k] = params[k].value; });
    return o;
  }

  // ---------------------------------------------------------------------------
  // Per-measure values for the template
  // ---------------------------------------------------------------------------
  var fieldList = []; // [{ key, label, cur, fv, cmpCur, prev, prevLabel, date }] one per measure
  var phrase = 'previous period';

  /** Latest value, comparison value and date of every measure (the base card's date logic, per measure). */
  function computeFields () {
    fieldList = model.measures.map(function (m) {
      lastData = m.data;
      var own = itemFor({ key: m.key }).mtdAgg;
      itemAgg = own === 'sum' || own === 'avg' ? own : '';
      var pts = m.data.points;
      var f = { key: m.key, label: m.label, cur: NaN, fv: null, cmpCur: NaN, prev: NaN, prevLabel: '', date: '' };
      if (pts.length) {
        var idx = pts.length - 1;
        var big = bigValue(idx);
        f.cur = big.v;
        f.fv = big.fv;
        var cmp = comparison(idx);
        if (cmp) { f.cmpCur = cmp.cur; f.prev = cmp.base; f.prevLabel = cmp.baseLabel; }
        f.date = pts[idx].label ? pts[idx].label + (isNumberMtd() ? ' MTD' : '') : '';
      }
      return f;
    });
    itemAgg = '';
    lastData = model.measures[0].data;
    phrase = comparisonWord();
    lastData = null;
  }

  function itemFor (f) { return Nc.measureItem(cfg.measures, f.key); }

  /** The template to draw: the builder's text, or one sentence per measure while it is empty. */
  function templateText () {
    var t = String((cfg.template && cfg.template.text) || '');
    return t.trim() ? t : Nc.defaultTemplate(fieldList.map(function (f) { return f.label; }), phrase);
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!model || !cfg) return;
    if (!model.measures.some(function (m) { return m.data.points.length; })) {
      showEmpty(model.measures.length && model.measures[0].data.dateIssue && model.hasDate
        ? model.measures[0].data.dateIssue : 'Couldn’t find the measures in the sheet data.');
      return;
    }
    if (paramsState === 0 && usesParams()) loadParams();
    computeFields();
    el.card.classList.remove('is-empty');
    hideTooltip();
    paintCard();
    paintHeader();
    paintText();
    layout();
    paintPicked();
    syncSnapshot();
  }

  function paintText () {
    var t = cfg.text;
    applyFont(el.text, t);
    el.text.style.lineHeight = String(Number(t.lineHeight) > 0 ? t.lineHeight : 1.5);
    el.text.style.textAlign = t.align || 'left';
    el.text.style.setProperty('--gap', (Number(t.paragraphGap) || 0) + 'px');
    el.text.style.setProperty('--unknown', t.unknownColor || '#C0392B');
    el.body.className = 'body v-' + (t.vAlign || 'top');
    el.text.innerHTML = Nc.renderTemplate(templateText(), {
      fields: fieldList, item: itemFor, params: paramMap(), change: cfg.change, highlight: cfg.highlight
    });
  }

  function layout () {
    if (!cfg || el.card.classList.contains('is-empty')) return;
    updateIconSpan();
    el.body.style.marginTop = el.card.querySelector('.head').offsetHeight > 0 ? '10px' : '0';
  }

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  // ---------------------------------------------------------------------------
  // Tooltip: hover a number to see the full values behind it (or Tableau's own tooltip, if chosen)
  // ---------------------------------------------------------------------------
  /** The measure's settings with a full (unabbreviated) number format. */
  function fullItem (item) {
    var pct = item.scale === 'percent' || item.scale === 'percentDynamic';
    return Object.assign({}, item, { scale: pct ? 'percent' : 'none' });
  }

  function onCardHover (e) {
    if (!cfg || !model || el.card.classList.contains('is-empty')) return;
    if (tableauTipOn() && tableauHover(e)) return;
    var span = e.target && e.target.closest ? e.target.closest('.nc-num[data-f]') : null;
    var f = span ? fieldList.find(function (x) { return x.key === span.getAttribute('data-f'); }) : null;
    if (!f) { hideTooltip(); return; }
    var item = fullItem(itemFor(f));
    var html = '<div class="tt-date">' + esc(f.label) + (f.date ? ' · ' + esc(f.date) : '') + '</div>';
    html += '<div class="tt-value">' + esc(Nc.formatItem(item, f.cur, null, {})) + '</div>';
    var ci = isFinite(f.prev) ? Nc.changeInfo(f, itemFor(f), cfg.change, null) : null;
    if (ci) {
      var col = ci.good === null ? cfg.highlight.neutralColor : ci.good ? cfg.highlight.goodColor : cfg.highlight.badColor;
      html += '<div class="tt-change" style="color:' + esc(col) + '">' + Nc.ARROW[ci.dir] + ' ' + esc(ExtCore.fixed(Math.abs(ci.amount), ci.dec) + ci.suffix) + '</div>' +
        '<div class="tt-note">vs ' + esc(f.prevLabel) + ' (' + esc(Nc.formatItem(item, f.prev, null)) + ')</div>';
    } else {
      html += '<div class="tt-note">No value to compare with</div>';
    }
    var tt = el.tooltip;
    tt.innerHTML = html;
    tt.style.fontFamily = Nc.fontStack(cfg.text.font);
    tt.style.display = 'block';
    var tw = tt.offsetWidth;
    var th = tt.offsetHeight;
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var left = e.clientX + 14;
    if (left + tw > vw - 4) left = e.clientX - tw - 14;
    var top = e.clientY + 14;
    if (top + th > vh - 4) top = e.clientY - th - 14;
    tt.style.left = Math.max(4, Math.min(left, vw - tw - 4)) + 'px';
    tt.style.top = Math.max(4, Math.min(top, vh - th - 4)) + 'px';
  }

  // Tableau's own tooltip (optional): the row of the latest date, as sent in the summary data.
  var tipFailed = false;  // this Tableau has no hoverTupleAsync: use our own tooltip from now on
  var tipRow;             // row last sent to Tableau (undefined = none)

  function tableauTipOn () {
    return !!(cfg && cfg.interaction && cfg.interaction.tableauTooltip) && !tipFailed;
  }

  /** The measure whose latest date the click / Tableau tooltip refers to: the first one with data. */
  function leadPoint () {
    for (var i = 0; model && i < model.measures.length; i++) {
      var pts = model.measures[i].data.points;
      if (pts.length) return pts[pts.length - 1];
    }
    return null;
  }

  function tableauHover (e) {
    var p = leadPoint();
    var ri = p && p.ri != null ? p.ri : null;
    if (ri === tipRow) return true; // same row: nothing to send
    if (ExtCore.hoverTooltip(worksheet, ri, { x: e.clientX, y: e.clientY }) === false) { tipFailed = true; return false; }
    tipRow = ri;
    el.tooltip.style.display = 'none';
    return true;
  }

  function onCardLeave () {
    hideTooltip();
    if (tipRow !== undefined) { tipRow = undefined; ExtCore.hoverTooltip(worksheet, null); }
  }

  function hideTooltip () {
    if (el.tooltip) el.tooltip.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Click selects the latest date in Tableau (optional)
  // ---------------------------------------------------------------------------
  var picked = null; // label of the selected date, or null

  function selectionOn () {
    return !!(cfg && cfg.interaction && cfg.interaction.selectInTableau);
  }

  function onCardClick (e) {
    if (!selectionOn() || e.detail > 1 || !model || el.card.classList.contains('is-empty')) return;
    var names = model.dateFields || [];
    var p = leadPoint();
    if (!names.length || !p || !p.raws) return; // no Date tile: nothing to select
    if (picked === p.label) { clearPicked(); return; }
    var sel = names.map(function (n, k) { return { fieldName: n, value: [p.raws[k]] }; });
    if (ExtCore.select(worksheet, sel, 'Narrative Card')) { picked = p.label; paintPicked(); }
  }

  function clearPicked () {
    if (picked === null) return;
    picked = null;
    ExtCore.clearSelection(worksheet);
    paintPicked();
  }

  /** Pointer cursor and a thin outline while a date is selected. */
  function paintPicked () {
    var on = selectionOn() && !!(model && model.dateFields && model.dateFields.length);
    if (!selectionOn() && picked !== null) picked = null;
    el.card.style.cursor = on ? 'pointer' : '';
    el.card.style.setProperty('--picked-color', (cfg && cfg.icon.color) || '#EB644C');
    el.card.classList.toggle('is-picked', on && picked !== null);
  }

  window.NarrativeCard = { init: init, _ordinal: ordinal, _toDay: toDay, _sameDayLastMonth: sameDayLastMonth };
})();
