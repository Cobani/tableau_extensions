'use strict';

/**
 * Funnel — Tableau Viz Extension.
 *
 * Marks card tiles (declared in funnel.trex). Two ways to give the stages:
 *   steps   Stages (measures): 2-12 measures, one per stage, in tile order.
 *   stage   Stage (1 dimension, one member per stage) + value (1 measure).
 * Tableau's own Tooltip tile is accepted too (its fields only add rows).
 *
 * Header (icon, title, explanation) and card options are the same as the other
 * extensions. Everything else is set in the Format dialog (configure.html),
 * which also opens from a right-click on a stage.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc, toNumber = ExtCore.toNumber, isMN = ExtCore.isMN, isNumericCol = ExtCore.isNumericCol,
    norm = ExtCore.norm, cleanName = ExtCore.cleanName, findColumn = ExtCore.findColumn;

  var MAX_STAGES = 12; // more stages than this are not drawn (the corner note says so)

  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null; // see extract()
  var drawn = [];   // stages as drawn: { st }
  var renderToken = 0;
  var selected = null; // key of the stage selected in Tableau (stages from a dimension)
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
    el.svg.addEventListener('click', onStageClick);
    document.addEventListener('click', function (e) {
      const path = e.composedPath ? e.composedPath() : [];
      if (selected && path.indexOf(el.svg) < 0 && path.indexOf(el.menu) < 0) clearPick();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && selected) clearPick(); });
    el.svg.addEventListener('dblclick', function (e) {
      var s = stageFromEvent(e);
      if (s) openDialog({ tab: 'stages', stage: s.key });
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
      cfg = Fn.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          cfg = Fn.read();
          reconcileKeys();
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
        console.error('Funnel failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Funnel failed to initialize:', err);
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
   * Opens the Format dialog. `focus` ({ tab, stage }) preselects a tab and a
   * stage. The dialog gets the current stages as payload, because it can't
   * read the worksheet itself.
   */
  function openDialog (focus) {
    hideMenu();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify({
      focus: focus || null,
      mode: model ? model.mode : '',
      stages: model ? orderStages(model.stages).map(function (s) { return { key: s.key, name: s.name }; }) : []
    });
    var options = { width: 600, height: 760 };
    // Modal keeps the Format window in front of Tableau until Done; the chart behind it still updates live.
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) options.dialogStyle = tableau.DialogStyle.Modal;
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Funnel dialog:', err && err.message);
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

      var ready = fields.steps.length || (fields.stage.length && fields.value.length);
      if (!ready) {
        model = null;
        if (first) { T.mark('no fields on the Marks card'); T.done('Funnel load timings'); }
        if (fields.stage.length) showEmpty('Drag a measure onto <b>Value</b> to size the stages.');
        else if (fields.value.length) showEmpty('Drag a dimension onto <b>Stage</b>: one member per stage.');
        else showEmpty('Drag one measure per stage onto <b>Stages (measures)</b> (2 to ' + MAX_STAGES + ', in order),<br>' +
          'or a dimension onto <b>Stage</b> and a measure onto <b>Value</b>.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      model = extract(table, fields);
      reconcileKeys();
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Funnel load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Funnel render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Funnel load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = { steps: [], stage: [], value: [], extra: [] };
    marks.encodings.forEach(function (enc) {
      if (!enc.field) return;
      // Built-in tiles (Tooltip, Detail) only add rows or tooltip text: matched to their columns, never read as stages.
      var type = String(enc.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : enc.id;
      if (id !== 'steps' && id !== 'stage' && id !== 'value') id = 'extra';
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
      console.info('Funnel: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  /**
   * Summary data → { mode, stages: [...in the order Tableau sent them], dimField }.
   * mode 'measures': one stage per measure on the Stages tile (summed over all rows).
   * mode 'dimension': one stage per member of the Stage dimension (Value summed per member).
   * Stage: { key, name, raw (number or null), fv, row (index in the summary data as sent), rawValue (cell value) }.
   * If Tableau delivers several measures as Measure Names / Measure Values, those are pivoted back.
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var cMN = table.columns.find(function (c) { return /^measure names$/i.test(c.fieldName); });
    var cMV = table.columns.find(function (c) { return /^measure values$/i.test(c.fieldName); });
    var byDim = !fields.steps.length;

    var reqs = [];
    var sReq = null;
    var ms = [];
    if (byDim) {
      sReq = { field: fields.stage[0], dim: true, col: null };
      var vReq = { field: fields.value[0], col: null };
      reqs = [sReq, vReq];
      ms = [vReq];
    } else {
      var seen = {};
      fields.steps.forEach(function (f) {
        var key = f.name;
        while (seen[key]) key += '+'; // the same field twice
        seen[key] = true;
        var r = { field: f, col: null, key: key, name: cleanName(f.name), total: 0, n: 0, fv: null, row: null };
        reqs.push(r);
        ms.push(r);
      });
    }
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    // Fields on the Tooltip / Detail tiles: take their columns out of the guessing below.
    fields.extra.forEach(function (f) { var c = findColumn(table, f, taken); if (c) taken.push(c); });
    matchLeftovers(table, reqs, taken, !!(cMN && cMV));

    function cellOf (m, r) {
      if (m.col) return r[m.col.index];
      if (cMN && cMV) {
        var mn = norm(r[cMN.index].formattedValue || r[cMN.index].value);
        if (mn === norm(m.field.name) || mn === norm(cleanName(m.field.name))) return r[cMV.index];
      }
      return null;
    }

    var stages;
    if (byDim) {
      var by = {};
      stages = [];
      rows.forEach(function (r, ri) {
        if (!sReq.col) return;
        var c = r[sReq.col.index];
        var name = String(c.formattedValue != null ? c.formattedValue : c.value);
        var st = by[name];
        if (!st) { st = by[name] = { key: name, name: name, raw: null, fv: null, row: ri, n: 0, rawValue: c.value }; stages.push(st); }
        var cell = cellOf(ms[0], r);
        var v = cell ? toNumber(cell) : NaN;
        if (!isFinite(v)) return;
        st.raw = (st.raw || 0) + v;
        st.n++;
        st.fv = st.n === 1 ? cell.formattedValue : null;
      });
    } else {
      rows.forEach(function (r, ri) {
        ms.forEach(function (m) {
          var cell = cellOf(m, r);
          var v = cell ? toNumber(cell) : NaN;
          if (!isFinite(v)) return;
          m.total += v;
          m.n++;
          m.fv = m.n === 1 ? cell.formattedValue : null;
          if (m.n === 1) m.row = ri;
        });
      });
      stages = ms.map(function (m) {
        return { key: m.key, name: m.name, raw: m.n ? m.total : null, fv: m.fv, row: m.row, n: m.n, rawValue: null };
      });
    }
    return { mode: byDim ? 'dimension' : 'measures', stages: stages, dimField: byDim && sReq.col ? sReq.col.fieldName : null };
  }

  // ---------------------------------------------------------------------------
  // Renamed pills keep their settings
  //
  // Per-stage settings are stored by pill name (cfg.stages[name]). When a pill is
  // renamed (double-click, "//New name") its name changes but its place on the
  // tile doesn't. The last seen names are kept in this browser (localStorage, not in
  // the workbook: writing workbook settings reloads the extension); a name that
  // disappeared while a new one appeared at the same position is a rename, and its
  // settings move to the new name. The workbook is only written when settings moved.
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

  var LAYOUT_PREFIX = 'funnel:layout:v1:';

  function layoutKey () {
    var host = '';
    try { host = document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { /* ignore */ }
    return LAYOUT_PREFIX + host + '|' + (worksheet && worksheet.name);
  }

  function readLayout () {
    try {
      var l = JSON.parse(window.localStorage.getItem(layoutKey()) || 'null');
      if (Array.isArray(l)) return l;
    } catch (e) { /* ignore */ }
    var c = cfg && cfg.layout && cfg.layout.stages;
    return Array.isArray(c) && c.length ? c : null;
  }

  function writeLayout (l) {
    try { window.localStorage.setItem(layoutKey(), JSON.stringify(l)); } catch (e) { /* ignore */ }
  }

  /** Applies renames to cfg (in memory); saves the workbook only when settings moved. */
  function reconcileKeys () {
    if (!cfg || !model || model.mode !== 'measures') return;
    var cur = model.stages.map(function (s) { return s.key; });
    var stored = readLayout();
    var rs = renames(stored || cur, cur);
    var moved = false;
    Object.keys(rs).forEach(function (oldK) {
      var newK = rs[oldK];
      if (cfg.stages[oldK] && !cfg.stages[newK]) {
        cfg.stages[newK] = cfg.stages[oldK];
        delete cfg.stages[oldK];
        moved = true;
      }
    });
    if (!stored || JSON.stringify(stored) !== JSON.stringify(cur)) writeLayout(cur);
    if (moved && !recentlySaved(JSON.stringify(rs))) {
      // Saving only works while authoring; viewers still get the renames in memory.
      try { Fn.write(cfg).catch(function () { /* read-only */ }); } catch (e) { /* read-only */ }
    }
  }

  /** True if the same rename was already saved in the last minute (never save in a loop). */
  function recentlySaved (sig) {
    try {
      var k = 'funnel:renameSaved';
      var last = JSON.parse(window.sessionStorage.getItem(k) || 'null');
      if (last && last.sig === sig && Date.now() - last.t < 60000) return true;
      window.sessionStorage.setItem(k, JSON.stringify({ sig: sig, t: Date.now() }));
    } catch (e) { /* ignore */ }
    return false;
  }

  // ---------------------------------------------------------------------------
  // Stages as drawn
  // ---------------------------------------------------------------------------
  /**
   * Stages in drawing order, hidden ones still included. Measures follow the tile order.
   * From a dimension: 'data' = as the worksheet shows them (Tableau sends the rows last-to-first, so
   * reversed), 'sent' = as sent, 'valDesc' = largest first, 'manual' = the list in Format → Chart.
   */
  function orderStages (stages) {
    if (model.mode === 'measures') return stages.slice();
    var o = cfg.chart.order;
    var base = stages.slice().reverse();
    if (o === 'sent') return stages.slice();
    if (o === 'valDesc') {
      return base.map(function (s, i) { return { s: s, i: i }; })
        .sort(function (a, b) { return (b.s.raw || 0) - (a.s.raw || 0) || a.i - b.i; })
        .map(function (x) { return x.s; });
    }
    if (o === 'manual') {
      var man = cfg.chart.manual || [];
      var pos = function (s) { var p = man.indexOf(s.key); return p < 0 ? 1e6 : p; };
      return base.map(function (s, i) { return { s: s, i: i }; })
        .sort(function (a, b) { return pos(a.s) - pos(b.s) || a.i - b.i; })
        .map(function (x) { return x.s; });
    }
    return base;
  }

  function fmtOf (labelFmt) {
    return cfg.numbers.mode === 'each' && labelFmt ? labelFmt : cfg.format;
  }

  function pctText (r) { return (r * 100).toFixed(cfg.labels.pctDecimals) + ' %'; }
  function signedPct (r) { return (r < 0 ? '−' : r > 0 ? '+' : '') + Math.abs(r * 100).toFixed(cfg.labels.pctDecimals) + ' %'; }

  function valueText (s) {
    return s.v === 0 ? '0' : Fn.formatNumber(s.v, fmtOf(cfg.labels.fmt), { fv: s.fv });
  }

  function dropText (s) {
    if (s.i === 0) return '';
    var d = s.drop;
    var t = d === 0 ? '0' : (d < 0 ? '−' : '+') + Fn.formatNumber(Math.abs(d), fmtOf(cfg.labels.fmt));
    return s.dropPct == null ? t : t + ' · ' + signedPct(s.dropPct);
  }

  /**
   * The visible stages with everything the drawing needs: label, value (negative and empty → 0), shares and
   * drop-off, colour. Also sets model.negatives / model.capped for the corner note.
   */
  function buildStages () {
    var all = orderStages(model.stages).filter(function (s) { return !Fn.stageCfg(cfg, s.key).hide; });
    model.capped = Math.max(0, all.length - MAX_STAGES);
    var list = all.slice(0, MAX_STAGES);
    model.negatives = 0;
    list = list.map(function (s, i) {
      var sc = Fn.stageCfg(cfg, s.key);
      var neg = s.raw != null && s.raw < 0;
      if (neg) model.negatives++;
      return {
        key: s.key, name: s.name, label: sc.label || s.name, i: i, raw: s.raw, fv: s.fv, row: s.row, rawValue: s.rawValue,
        v: s.raw != null && s.raw > 0 ? s.raw : 0, neg: neg, empty: s.raw == null, color: '', biggest: false
      };
    });
    var first = list[0];
    list.forEach(function (s, i) {
      s.pctFirst = i > 0 && first.v > 0 ? s.v / first.v : null;
      var prev = list[i - 1];
      s.pctPrev = i > 0 && prev.v > 0 ? s.v / prev.v : null;
      s.drop = i > 0 ? s.v - prev.v : 0;
      s.dropPct = s.pctPrev == null ? null : s.pctPrev - 1;
    });
    var worst = null;
    list.forEach(function (s) { if (s.dropPct != null && s.dropPct < -1e-9 && (!worst || s.dropPct < worst.dropPct)) worst = s; });
    if (worst && cfg.conversion.highlightBiggest && list.length > 2) worst.biggest = true;
    list.forEach(function (s) { s.color = colorFor(s, list.length); });
    return list;
  }

  function colorFor (s, n) {
    var C = cfg.colors;
    if (C.mode === 'status') {
      if (s.i === 0) return C.neutral;
      var r = C.statusBase === 'first' ? s.pctFirst : s.pctPrev;
      if (r == null || r > 1 + 1e-9) return C.neutral;
      var p = r * 100;
      return p >= C.goodMin ? C.good : p >= C.warnMin ? C.warn : C.bad;
    }
    if (C.mode === 'perStage') {
      var own = Fn.stageCfg(cfg, s.key).color;
      if (own) return own;
    }
    return Fn.tint(C.color, n <= 1 ? 0 : (s.i / (n - 1)) * (C.tint / 100));
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg) return;
    if (!model) return;
    var list = buildStages();
    if (!list.length) {
      showEmpty('No stages to show. Check the data, or the hidden stages in Format → Stages.');
      return;
    }
    el.card.classList.remove('is-empty');
    hideTooltip();
    paintCard();
    paintHeader(list);
    drawChart(list);
    syncPictureButton();
  }

  // Save as picture (Format → Card → Export). The title and legend are HTML around the SVG, so PNG only.
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
        title: function () { return (el.title && el.title.textContent) || (worksheet && worksheet.name) || 'Funnel'; },
        onError: function (err) { console.error(err); }
      });
      if (picBtn && picBtn.el) picBtn.el.setAttribute('data-snapshot', 'skip');
    }
    picBtn.refresh();
  }

  function applyFont (node, f) {
    node.style.fontFamily = Fn.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Fn.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
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
        var r = Fn.iconHtml(ic.builtinId, ic.color, iconTarget());
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

  var measureCtx = null;
  function textWidth (text, size, weight, family) {
    if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
    measureCtx.font = (weight || 400) + ' ' + size + 'px ' + Fn.fontStack(family);
    return measureCtx.measureText(String(text)).width;
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
  /** Label lines of one stage, in priority order (the lowest ones are dropped first when there is no room). */
  function labelLines (s) {
    var L = cfg.labels;
    var out = [];
    if (L.showName) out.push({ k: 'name', text: s.label, f: L.name });
    if (L.showValue) out.push({ k: 'value', text: valueText(s), f: L.value });
    if (s.i > 0) {
      if (L.showPctFirst && s.pctFirst != null) out.push({ k: 'first', text: pctText(s.pctFirst) + ' of first', f: L.note });
      if (L.showPctPrev && s.pctPrev != null) out.push({ k: 'prev', text: pctText(s.pctPrev) + ' of previous', f: L.note });
      if (L.showDrop) out.push({ k: 'drop', text: dropText(s), f: L.note });
    }
    return out;
  }

  /**
   * Draws the label of one stage into `g`. `o`: { yMid, h, widthAt(y) (shape width at y), cx, left, align,
   * outX, outAvail, forceOut, fill }. Inside the shape when it fits, else beside it, else shortened; never overlapping.
   */
  function placeLabel (g, s, o) {
    var L = cfg.labels;
    var fam = cfg.numbers.font;
    var lines = labelLines(s);
    if (!lines.length) return;
    var lh = function (l) { return l.f.size * 1.25; };
    var tot = function () { return lines.reduce(function (a, l) { return a + lh(l); }, 0); };
    while (tot() > o.h - 2 && lines.length > 1) {
      if (lines.length > 2 && lines[0].k === 'name' && lines[1].k === 'value') {
        lines.splice(0, 2, { k: 'name', text: lines[0].text + '  ' + lines[1].text, f: lines[0].f });
      } else lines.pop();
    }
    if (tot() > o.h + 2) return; // not even one line fits
    var need = Math.max.apply(null, lines.map(function (l) { return textWidth(l.text, l.f.size, l.f.weight, fam); }));
    var th = tot();
    var inAvail = 0;
    if (!o.forceOut) {
      inAvail = Math.min(o.widthAt(o.yMid - th / 2), o.widthAt(o.yMid + th / 2)) - 16;
    }
    var mode = 'hide';
    var width = 0;
    if (!o.forceOut && L.place === 'auto' && need <= inAvail) { mode = 'in'; width = need; }
    else if (o.outAvail >= Math.min(need, 60) && o.outAvail >= 40) { mode = 'out'; width = Math.min(need, o.outAvail); }
    else if (inAvail >= 40) { mode = 'in'; width = inAvail; }
    if (mode === 'hide') return;

    var y = o.yMid - th / 2;
    var inside = mode === 'in';
    var textColor = inside ? Fn.contrastText(o.fill) : null;
    lines.forEach(function (l) {
      var shown = ellipsize(l.text, width, l.f.size, l.f.weight, fam);
      var x, anchor;
      if (inside) { anchor = o.align === 'start' ? 'start' : 'middle'; x = o.align === 'start' ? o.left + 8 : o.cx; }
      else { anchor = 'start'; x = o.outX; }
      var color = inside ? textColor : (l.k === 'drop' && s.biggest ? cfg.conversion.highlightColor : l.f.color);
      var t = node('text', {
        x: x, y: y + lh(l) / 2, 'text-anchor': anchor, 'dominant-baseline': 'central', fill: color,
        'font-size': l.f.size, 'font-weight': l.k === 'drop' && s.biggest ? 700 : l.f.weight, 'font-family': Fn.fontStack(fam)
      }, shown);
      if (shown !== l.text) t.appendChild(node('title', {}, l.text));
      g.appendChild(t);
      y += lh(l);
    });
  }

  /** Corner note under the chart: what was changed to draw it. */
  function noteText () {
    var out = [];
    if (model.negatives) out.push('Negative values are drawn as 0.');
    if (model.capped) out.push('Showing the first ' + MAX_STAGES + ' of ' + (MAX_STAGES + model.capped) + ' stages.');
    return out.join(' ');
  }

  function drawChart (list) {
    var svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawn = [];
    var W = Math.max(1, el.plot.clientWidth);
    var H = Math.max(1, el.plot.clientHeight);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (W < 40 || H < 40) return;

    var C = cfg.chart;
    var family = cfg.numbers.font;
    var n = list.length;
    var shape = C.shape;
    var margin = 6;
    var note = noteText();
    var overall = cfg.conversion.overall && n > 1 && list[0].v > 0;
    var reserve = (overall ? 24 : 0) + (note ? 14 : 0);
    var top = 2;
    var availH = H - top - reserve - 2;
    if (availH < 40) { reserve = 0; overall = false; note = ''; availH = H - 4; }

    var gap0 = shape === 'bars' ? Math.max(C.gap, 14) : C.gap;
    var gap = n > 1 ? Math.max(0, Math.min(gap0, (availH - n * 12) / (n - 1))) : 0;
    var h = Math.max(4, (availH - gap * (n - 1)) / n);
    var maxV = Math.max.apply(null, list.map(function (s) { return s.v; }));
    var Wmax = W - 2 * margin;
    var minW = Math.max(3, Wmax * C.minWidth / 100);
    var cx = W / 2;
    var widths = list.map(function (s) { return s.v > 0 && maxV > 0 ? Math.max(minW, s.v / maxV * Wmax) : minW; });
    var rad = Math.max(0, Math.min(C.radius, h / 2 - 1));
    var loss = cfg.colors.lossColor;

    list.forEach(function (s, i) {
      var y0 = top + i * (h + gap);
      var y1 = y0 + h;
      var w = widths[i];
      var wBot = shape === 'funnel' && i < n - 1 ? widths[i + 1] : w;
      var zero = s.v === 0;
      var g = node('g', { 'class': 'stage', 'data-i': i });
      g.appendChild(node('rect', { x: margin, y: y0, width: Wmax, height: h + (i < n - 1 ? gap : 0), fill: 'transparent' }));
      var left = margin;
      var body = null;
      var wz = Math.max(w, 20);
      if (zero) {
        // Zero or empty: a thin line, the label beside it.
        var lx = shape === 'steps' ? left : cx - wz / 2;
        body = node('rect', { 'class': 'stage-body', x: lx, y: (y0 + y1) / 2 - 1, width: wz, height: 2, fill: s.color });
        g.appendChild(body);
      } else if (shape === 'steps') {
        if (widths[0] - w > 0.5) g.appendChild(node('rect', { x: left + w, y: y0, width: widths[0] - w, height: h, rx: rad, fill: loss }));
        body = node('rect', { 'class': 'stage-body', x: left, y: y0, width: w, height: h, rx: rad, fill: s.color });
        g.appendChild(body);
      } else if (shape === 'bars') {
        if (i < n - 1 && gap > 0) {
          var wn = widths[i + 1];
          g.appendChild(node('polygon', { points: [[cx - w / 2, y1], [cx + w / 2, y1], [cx + wn / 2, y1 + gap], [cx - wn / 2, y1 + gap]].join(' '), fill: loss }));
        }
        body = node('rect', { 'class': 'stage-body', x: cx - w / 2, y: y0, width: w, height: h, rx: rad, fill: s.color });
        g.appendChild(body);
      } else {
        // funnel: sides slope from this stage's width to the next one's
        var r = rad && h > 2 * rad + 2 ? rad : 0;
        var pts = [[cx - w / 2 + r, y0 + r], [cx + w / 2 - r, y0 + r], [cx + wBot / 2 - r, y1 - r], [cx - wBot / 2 + r, y1 - r]];
        body = node('polygon', {
          'class': 'stage-body', points: pts.join(' '), fill: s.color, stroke: r ? s.color : '', 'stroke-width': r ? 2 * r : '', 'stroke-linejoin': 'round'
        });
        g.appendChild(body);
      }
      if (s.biggest) {
        // the biggest drop-off: outline the stage after it
        var ox = shape === 'steps' ? left : cx - Math.max(w, wBot) / 2;
        g.appendChild(node('rect', { x: ox - 1.5, y: y0 - 1.5, width: (zero ? wz : shape === 'funnel' ? Math.max(w, wBot) : w) + 3, height: h + 3, rx: rad + 1.5, fill: 'none',
          stroke: cfg.conversion.highlightColor, 'stroke-width': 2 }));
      }
      if (selected === s.key) {
        g.appendChild(node('rect', { x: (shape === 'steps' ? left : cx - Math.max(w, wBot) / 2) + 0.75, y: y0 + 0.75, width: Math.max(0, Math.max(w, wBot) - 1.5), height: h - 1.5,
          fill: 'none', stroke: '#17202B', 'stroke-width': 1.5, 'stroke-dasharray': '4,3' }));
      }

      var outX = zero ? (shape === 'steps' ? left + wz + 8 : cx + wz / 2 + 8)
        : shape === 'steps' ? left + w + 10 : cx + Math.max(w, wBot) / 2 + 10;
      placeLabel(g, s, {
        yMid: (y0 + y1) / 2, h: h, cx: cx, left: left, align: shape === 'steps' ? 'start' : 'center', fill: s.color,
        forceOut: zero, outX: outX, outAvail: W - margin - outX,
        widthAt: function (y) { return shape === 'funnel' ? w + (wBot - w) * Math.max(0, Math.min(1, (y - y0) / h)) : w; }
      });
      svg.appendChild(g);
      drawn.push({ st: s });
    });

    var yb = H - 2;
    if (note) {
      svg.appendChild(node('text', { x: margin, y: yb - 5, 'text-anchor': 'start', 'dominant-baseline': 'central', fill: cfg.labels.note.color, 'font-size': 10,
        'font-family': Fn.fontStack(family) }, ellipsize(note, W - 2 * margin, 10, 400, family)));
      yb -= 14;
    }
    if (overall) {
      var last = list[n - 1];
      var ov = (last.v / list[0].v);
      var lab = cfg.conversion.overallText ? cfg.conversion.overallText + ': ' : '';
      var tail = pctText(ov);
      var lf = cfg.labels.note;
      var vf = cfg.labels.name;
      var full = lab + tail;
      var shownLab = lab;
      if (textWidth(full, vf.size, vf.weight, family) > W - 2 * margin) shownLab = ellipsize(lab, Math.max(0, W - 2 * margin - textWidth(tail, vf.size, vf.weight, family)), lf.size, lf.weight, family);
      var tx = node('text', { x: cx, y: yb - 12, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'font-family': Fn.fontStack(family) });
      tx.appendChild(node('tspan', { fill: lf.color, 'font-size': lf.size + 1, 'font-weight': lf.weight }, shownLab));
      tx.appendChild(node('tspan', { fill: vf.color, 'font-size': vf.size, 'font-weight': 700 }, tail));
      svg.appendChild(tx);
    }
  }

  // ---------------------------------------------------------------------------
  // Click selects a stage in Tableau (stages from a dimension)
  // ---------------------------------------------------------------------------
  function onStageClick (e) {
    if (!cfg || !model || !cfg.interaction || !cfg.interaction.selectInTableau) return;
    if (e.detail > 1 || el.menu.style.display === 'block') return; // second click of a double-click
    if (model.mode !== 'dimension' || !model.dimField) return; // measures: nothing to select
    var s = stageFromEvent(e);
    if (!s) { clearPick(); return; }
    if (selected === s.key) { clearPick(); return; }
    selected = s.key;
    ExtCore.select(worksheet, [{ fieldName: model.dimField, value: [s.rawValue] }], 'Funnel');
    paint();
  }

  function clearPick () {
    if (!selected) return;
    selected = null;
    ExtCore.clearSelection(worksheet);
    paint();
  }

  function stageFromEvent (e) {
    var g = e.target.closest ? e.target.closest('.stage') : null;
    if (!g) return null;
    var d = drawn[Number(g.getAttribute('data-i'))];
    return d ? d.st : null;
  }

  // Tableau's own tooltip (Format → Chart → Use Tableau's tooltip).
  // Mark → row: index in the summary data exactly as Tableau sent it (0-based); the stage's first row.
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

  function onHover (e) {
    if (!cfg || el.menu.style.display === 'block') return;
    if (useTableauTip()) {
      hideTooltip();
      var hs = stageFromEvent(e);
      sendHoverRow(hs && hs.row != null ? hs.row : null, e);
      if (useTableauTip()) return; // else: this Tableau cannot do it, fall through to our tooltip
    }
    if (!cfg.chart.tooltip) return;
    var s = stageFromEvent(e);
    if (!s) { hideTooltip(); return; }
    var html = '<div class="tt-name">' + esc(s.label) + '</div>';
    html += '<div class="tt-value" style="color:' + s.color + '">' + esc(s.empty ? 'No data' : s.neg ? Fn.formatNumber(s.raw, fmtOf(cfg.labels.fmt)) : valueText(s)) + '</div>';
    if (s.i > 0 && s.pctFirst != null) html += '<div class="tt-note">' + esc(pctText(s.pctFirst)) + ' of first stage</div>';
    if (s.i > 0 && s.pctPrev != null) {
      html += '<div class="tt-note">' + esc(pctText(s.pctPrev)) + ' of previous stage' + (s.pctPrev > 1 ? ' (more than the stage before)' : '') + '</div>';
    }
    if (s.i > 0) html += '<div class="tt-note">Drop-off: ' + esc(dropText(s)) + '</div>';
    if (s.neg) html += '<div class="tt-note">Negative value, drawn as 0.</div>';
    var tt = el.tooltip;
    tt.innerHTML = html;
    tt.style.fontFamily = Fn.fontStack(cfg.numbers.font);
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
    var s = stageFromEvent(e);
    var items = [];
    if (s) items.push(['Format “' + s.label + '”…', { tab: 'stages', stage: s.key }], null);
    items.push(
      ['Chart…', { tab: 'chart' }],
      ['Colors…', { tab: 'colors' }],
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

  window.Funnel = { init: init };
})();
