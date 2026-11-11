'use strict';

/**
 * Bullet & Gauge — Tableau Viz Extension.
 *
 * Marks card tiles (declared in bullet-gauge.trex):
 *   category  Category: 0–2 discrete dimensions, one mark per member (none = one mark for the whole worksheet)
 *   actual    Actual: 1 measure (required)
 *   target    Target: 1 measure (optional), drawn as a tick
 *   ranges    Ranges: 0–3 measures, the upper bounds of the qualitative bands (drop each separately)
 *   compare   Comparison: 1 measure (optional), e.g. last year, a thin tick
 *
 * Three looks (settings chart.mode): bullet rows, gauges, progress bars. Header (icon, title,
 * explanation) and card options are the same as the other extensions.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc, toNumber = ExtCore.toNumber, isMN = ExtCore.isMN, isNumericCol = ExtCore.isNumericCol,
    cleanName = ExtCore.cleanName, findColumn = ExtCore.findColumn;

  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null; // see extract()
  var drawn = [];   // marks as drawn: { mark, x, y, w, h }
  var renderToken = 0;
  var selected = null; // key of the category selected in Tableau
  var SVGNS = 'http://www.w3.org/2000/svg';
  var MAX_MARKS = 500; // drawn at most, when Top N is 0 (a note says so)
  var PCT_FMT = { scale: 'none', decimals: 0, pctFromRatio: true, unit: '%', unitPosition: 'suffix', plusSign: false, negStyle: 'minus' };

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'plot', 'svg', 'note', 'hint', 'tooltip', 'menu'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.svg.addEventListener('mousemove', onHover);
    el.svg.addEventListener('mouseleave', onLeave);
    el.svg.addEventListener('contextmenu', onContextMenu);
    el.svg.addEventListener('click', onMarkClick);
    document.addEventListener('click', function (e) {
      const path = e.composedPath ? e.composedPath() : [];
      if (selected && path.indexOf(el.svg) < 0 && path.indexOf(el.menu) < 0) clearPick();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && selected) clearPick(); });
    el.svg.addEventListener('dblclick', function (e) {
      if (markFromEvent(e)) openDialog({ tab: 'chart' });
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
      cfg = Bg.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          cfg = Bg.read();
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
        console.error('Bullet & Gauge failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Bullet & Gauge failed to initialize:', err);
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
   * Opens the Format dialog. `focus` ({ tab }) preselects a tab. The dialog gets what it needs to
   * know about the data as payload, because it can't read the worksheet itself.
   */
  function openDialog (focus) {
    hideMenu();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify({
      focus: focus || null,
      hasCategory: !!(model && model.cats.length),
      hasTarget: !!(model && model.hasTarget),
      nRanges: model ? model.nRanges : 0,
      categories: model ? model.list.length : 0
    });
    var options = { width: 600, height: 760 };
    // Modal keeps the Format window in front of Tableau until Done; the chart behind it still updates live.
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) options.dialogStyle = tableau.DialogStyle.Modal;
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Bullet & Gauge dialog:', err && err.message);
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

      if (!fields.actual.length) {
        model = null;
        if (first) { T.mark('no fields on the Marks card'); T.done('Bullet & Gauge load timings'); }
        showEmpty('Drag a measure onto <b>Actual</b>.<br>Optionally add <b>Target</b>, up to three <b>Ranges</b> (one at a time),<br>a <b>Comparison</b> and a <b>Category</b>.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      model = extract(table, fields);
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Bullet & Gauge load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Bullet & Gauge render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Bullet & Gauge load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = { category: [], actual: [], target: [], ranges: [], compare: [] };
    marks.encodings.forEach(function (enc) {
      if (!enc.field) return;
      (fields[enc.id] = fields[enc.id] || []).push(enc.field);
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
      console.info('Bullet & Gauge: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  /**
   * Summary data → { cats, list, names, hasTarget, hasCompare, nRanges }.
   * One entry per Category member (or one for the whole worksheet): measures are summed over its rows.
   * Rows arrive last-to-first, so "as in the data" order means reading them backwards.
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var reqs = [];
    fields.category.slice(0, 2).forEach(function (f) { reqs.push({ field: f, role: 'category', dim: true, col: null }); });
    ['actual', 'target', 'compare'].forEach(function (role) {
      fields[role].slice(0, 1).forEach(function (f) { reqs.push({ field: f, role: role, dim: false, col: null }); });
    });
    fields.ranges.slice(0, 3).forEach(function (f) { reqs.push({ field: f, role: 'ranges', dim: false, col: null }); });
    reqs.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    matchLeftovers(table, reqs, taken, false);

    var cats = reqs.filter(function (r) { return r.role === 'category' && r.col; });
    var of = function (role) { return reqs.filter(function (r) { return r.role === role && r.col; }); };
    var rAct = of('actual')[0] || null;
    var rTar = of('target')[0] || null;
    var rCmp = of('compare')[0] || null;
    var rRng = of('ranges');
    var measures = [['actual', rAct], ['target', rTar], ['compare', rCmp]];
    rRng.forEach(function (r, i) { measures.push(['r' + i, r]); });

    var groups = {};
    var list = [];
    for (var ri = rows.length - 1; ri >= 0; ri--) {
      var r = rows[ri];
      var key = cats.map(function (c) { return String(r[c.col.index].formattedValue); }).join('\u0001');
      var g = groups[key];
      if (!g) {
        g = groups[key] = {
          key: key,
          label: cats.map(function (c) { return String(r[c.col.index].formattedValue); }).join(' · '),
          sel: cats.map(function (c) { return { fieldName: c.col.fieldName, value: [r[c.col.index].value] }; }),
          row: ri, v: {}, n: {}, fv: {}
        };
        list.push(g);
      }
      measures.forEach(function (m) {
        if (!m[1]) return;
        var cell = r[m[1].col.index];
        var v = toNumber(cell);
        if (!isFinite(v)) return;
        g.v[m[0]] = (g.v[m[0]] || 0) + v;
        g.n[m[0]] = (g.n[m[0]] || 0) + 1;
        g.fv[m[0]] = g.n[m[0]] === 1 ? cell.formattedValue : null;
      });
    }
    return {
      cats: cats.map(function (c) { return { name: cleanName(c.field.name), fieldName: c.col.fieldName }; }),
      list: list,
      names: {
        actual: rAct ? cleanName(rAct.field.name) : 'Actual',
        target: rTar ? cleanName(rTar.field.name) : 'Target',
        compare: rCmp ? cleanName(rCmp.field.name) : 'Comparison',
        ranges: rRng.map(function (r) { return cleanName(r.field.name); })
      },
      hasActual: !!rAct,
      hasTarget: !!rTar && list.some(function (g) { return isFinite(g.v.target); }),
      hasCompare: !!rCmp && list.some(function (g) { return isFinite(g.v.compare); }),
      nRanges: rRng.length
    };
  }

  // ---------------------------------------------------------------------------
  // Marks: values, order, scale, bands
  // ---------------------------------------------------------------------------
  function num (v) { return typeof v === 'number' && isFinite(v) ? v : null; }

  /** One entry per category, sorted and cut to Top N, with its scale and band limits. */
  function buildMarks () {
    var cm = cfg.chart;
    var bullet = cm.mode === 'bullet';
    var marks = model.list.map(function (g, i) {
      var a = num(g.v.actual);
      var t = num(g.v.target);
      var rs = [];
      for (var k = 0; k < model.nRanges; k++) { var rv = num(g.v['r' + k]); if (rv != null) rs.push(rv); }
      rs.sort(function (p, q) { return p - q; });
      return {
        g: g, i: i, key: g.key, label: g.label, sel: g.sel, row: g.row,
        a: a, t: t, c: num(g.v.compare), rs: rs,
        pct: a != null && t != null && t !== 0 ? a / t * 100 : null
      };
    });
    if (cm.sort === 'actual' || cm.sort === 'pct') {
      var f = cm.sort === 'actual' ? 'a' : 'pct';
      marks.sort(function (p, q) {
        if (p[f] == null || q[f] == null) return p[f] == null ? (q[f] == null ? p.i - q.i : 1) : -1;
        return q[f] - p[f] || p.i - q.i;
      });
    }
    var total = marks.length;
    var limit = Number(cm.topN) > 0 ? Math.floor(Number(cm.topN)) : MAX_MARKS;
    var note = '';
    if (total > limit) {
      marks = marks.slice(0, limit);
      note = 'Showing ' + (cm.sort === 'none' ? 'the first ' : 'the top ') + limit + ' of ' + total + (Number(cm.topN) > 0 ? '' : '. Set Top N in Format → Chart.');
    }

    var rg = cfg.ranges;
    var thr = (rg.thresholds || []).map(Number).filter(function (x) { return isFinite(x) && x > 0; }).sort(function (p, q) { return p - q; }).slice(0, 3);
    if (!thr.length) thr = [100];
    var fixedMax = cfg.scale.maxMode === 'fixed' && Number(cfg.scale.max) > 0 ? Number(cfg.scale.max) : null;
    marks.forEach(function (m) {
      var vals = [m.a, m.t, m.c].concat(m.rs).filter(function (v) { return v != null; });
      var top = Math.max.apply(null, vals.concat([0]));
      m.byRange = rg.source !== 'percent' && m.rs.length > 0;
      if (m.byRange) m.bounds = m.rs.slice();
      else {
        var base = m.t != null && m.t > 0 ? m.t : (top > 0 ? top : 1);
        m.bounds = thr.map(function (p) { return base * p / 100; });
      }
      var hi = Math.max.apply(null, vals.concat(m.bounds, [0]));
      m.lo = bullet ? Math.min.apply(null, vals.concat([0])) : 0;
      m.hi = fixedMax != null ? fixedMax : hi;
    });
    if (cfg.scale.shared && marks.length) {
      var lo = Math.min.apply(null, marks.map(function (m) { return m.lo; }));
      var hi2 = Math.max.apply(null, marks.map(function (m) { return m.hi; }));
      marks.forEach(function (m) { m.lo = lo; m.hi = hi2; });
    }
    marks.forEach(function (m) { if (!(m.hi > m.lo)) m.hi = m.lo + 1; });
    return { marks: marks, note: note, total: total };
  }

  /** Band colours, darkest / "poor" first; reversed for "lower is better". */
  function bandColors (n) {
    var rg = cfg.ranges;
    var out = [];
    if (rg.style === 'three') {
      out = n >= 3 ? [rg.poorColor, rg.okColor, rg.goodColor] : n === 2 ? [rg.poorColor, rg.goodColor] : [rg.okColor];
    } else {
      for (var i = 0; i < n; i++) out.push(Bg.tint(rg.color, n === 1 ? 0.7 : 0.4 + 0.45 * i / (n - 1)));
    }
    return rg.reverse ? out.slice(0, n).reverse() : out.slice(0, n);
  }

  /** Colour of the actual bar / arc: one colour, or by how close it is to the target. */
  function actualColor (m) {
    var a = cfg.actual;
    if (a.colorMode !== 'status' || m.pct == null) return a.color;
    var p = cfg.ranges.reverse ? 200 - m.pct : m.pct;
    return p >= a.atPct ? a.atColor : p >= a.nearPct ? a.nearColor : a.belowColor;
  }

  function fmtVal (v, m, key) {
    if (v == null) return '—';
    var fv = m && key && m.g.n[key] === 1 ? m.g.fv[key] : null;
    return Bg.formatNumber(v, cfg.format, { fv: fv });
  }

  function fmtPct (p) {
    return Bg.formatNumber(p, cfg.numbers.mode === 'each' ? cfg.pctFormat : PCT_FMT);
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg || !model) return;
    if (!model.list.length) { showEmpty('No data to show.'); return; }
    var built = buildMarks();
    if (!built.marks.some(function (m) { return m.a != null; })) {
      showEmpty('The <b>' + esc(model.names.actual) + '</b> measure has no values here.');
      return;
    }
    el.card.classList.remove('is-empty');
    hideTooltip();
    paintCard();
    paintHeader();
    drawChart(built.marks);
    el.note.textContent = built.note;
    el.note.style.display = built.note ? '' : 'none';
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
        title: function () { return (el.title && el.title.textContent) || (worksheet && worksheet.name) || 'Bullet & Gauge'; },
        onError: function (err) { console.error(err); }
      });
      if (picBtn && picBtn.el) picBtn.el.setAttribute('data-snapshot', 'skip');
    }
    picBtn.refresh();
  }

  function applyFont (node, f) {
    node.style.fontFamily = Bg.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Bg.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
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
        var r = Bg.iconHtml(ic.builtinId, ic.color, iconTarget());
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
    el.title.textContent = cfg.title.text || (model && model.names.actual) || 'Bullet & Gauge';

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
    measureCtx.font = (weight || 400) + ' ' + size + 'px ' + Bg.fontStack(family);
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
  // Drawing
  // ---------------------------------------------------------------------------
  /** Text that never overflows: shortened with an ellipsis, the full text in a <title>. */
  function fitText (attrs, text, width, f) {
    var shown = ellipsize(text, width, f.size, f.weight, f.font);
    var t = node('text', attrs, shown);
    if (shown !== text) t.appendChild(node('title', {}, text));
    return t;
  }

  function drawChart (marks) {
    var svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawn = [];
    var W = Math.max(1, el.plot.clientWidth);
    var H = Math.max(1, el.plot.clientHeight);
    if (W < 40 || H < 24) return;
    var total = cfg.chart.mode === 'gauge' ? drawGauges(svg, marks, W, H) : drawRows(svg, marks, W, H, cfg.chart.mode);
    total = Math.max(1, Math.ceil(total));
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + total);
    svg.style.height = total + 'px';
    svg.style.width = W + 'px';
  }

  function hitRect (x, y, w, h) {
    return node('rect', { 'class': 'hit', x: x, y: y, width: Math.max(0, w), height: Math.max(0, h), rx: 4, fill: 'transparent' });
  }

  function selectBox (g, m, x, y, w, h) {
    if (selected !== m.key) return;
    g.appendChild(node('rect', { x: x + 0.75, y: y + 0.75, width: Math.max(0, w - 1.5), height: Math.max(0, h - 1.5), rx: 4,
      fill: 'none', stroke: '#17202B', 'stroke-width': 1.5, 'stroke-dasharray': '4,3' }));
  }

  /** Bullet rows and progress bars: label column, bar area, value column. */
  function drawRows (svg, marks, W, H, mode) {
    var lb = cfg.labels;
    var rowH = Math.max(10, Number(cfg.chart.rowHeight) || 34);
    var gap = Math.max(0, Number(cfg.chart.gap) || 0);
    var fam = cfg.labels.value;
    var showPct = lb.showPct;
    var texts = marks.map(function (m) {
      if (mode === 'progress' && m.pct != null && showPct) return fmtPct(m.pct);
      return fmtVal(m.a, m, 'actual') + (mode === 'bullet' && showPct && m.pct != null ? '  ' + fmtPct(m.pct) : '');
    });
    var hasLabel = lb.showCategory && model.cats.length > 0;
    var labelW = 0;
    if (hasLabel) {
      var lw = Math.max.apply(null, marks.map(function (m) { return textWidth(m.label, lb.category.size, lb.category.weight, lb.category.font); }));
      labelW = Math.ceil(Math.min(lw, W * Math.max(10, Math.min(60, Number(lb.labelWidth) || 30)) / 100)) + 10;
    }
    var valueW = Math.ceil(Math.max.apply(null, texts.map(function (t) { return textWidth(t, fam.size, fam.weight, fam.font); }))) + 10;
    // Narrow zone: drop the value column first (it is in the tooltip), then the labels.
    if (W - labelW - valueW < 60) valueW = 0;
    if (W - labelW - valueW < 60) labelW = 0;
    var x0 = labelW;
    var x1 = W - valueW;
    var barW = Math.max(10, x1 - x0);

    marks.forEach(function (m, i) {
      var y = i * (rowH + gap);
      var cy = y + rowH / 2;
      var g = node('g', { 'class': 'mark', 'data-i': i });
      g.appendChild(hitRect(0, y - gap / 2, W, rowH + gap));
      var sx = function (v) { return x0 + (Math.min(m.hi, Math.max(m.lo, v)) - m.lo) / (m.hi - m.lo) * barW; };

      if (labelW > 0) {
        g.appendChild(fitText({ x: 0, y: cy, 'dominant-baseline': 'central' }, m.label, labelW - 10, lb.category));
        g.lastChild.setAttribute('font-family', Bg.fontStack(lb.category.font));
        applyTextStyle(g.lastChild, lb.category);
      }

      if (mode === 'progress') {
        var ph = Math.max(6, Math.min(22, rowH * 0.5));
        var ratio = m.pct != null ? m.pct / 100 : (m.a != null ? (m.a - m.lo) / (m.hi - m.lo) : 0);
        ratio = Math.max(0, Math.min(1, ratio));
        g.appendChild(node('rect', { x: x0, y: cy - ph / 2, width: barW, height: ph, rx: ph / 2, fill: cfg.ranges.track }));
        if (m.a != null && ratio > 0) {
          g.appendChild(node('rect', { 'class': 'actual', x: x0, y: cy - ph / 2, width: Math.max(ph, barW * ratio), height: ph, rx: ph / 2, fill: actualColor(m) }));
        }
      } else {
        var bandH = rowH;
        g.appendChild(node('rect', { x: x0, y: cy - bandH / 2, width: barW, height: bandH, fill: cfg.ranges.track }));
        var cols = bandColors(m.bounds.length);
        var prev = 0;
        m.bounds.forEach(function (b, k) {
          var s = sx(prev);
          var e = sx(b);
          if (e - s > 0.01) g.appendChild(node('rect', { 'class': 'band', x: s, y: cy - bandH / 2, width: e - s, height: bandH, fill: cols[k] }));
          prev = Math.max(prev, b);
        });
        if (m.lo < 0) g.appendChild(node('line', { x1: sx(0), x2: sx(0), y1: cy - bandH / 2, y2: cy + bandH / 2, stroke: '#9AA3AF', 'stroke-width': 1, 'shape-rendering': 'crispEdges' }));
        if (m.a != null) {
          var ah = Math.max(2, bandH * Math.max(5, Math.min(100, Number(cfg.actual.thickness) || 38)) / 100);
          var ax0 = sx(0);
          var ax1 = sx(m.a);
          g.appendChild(node('rect', { 'class': 'actual', x: Math.min(ax0, ax1), y: cy - ah / 2, width: Math.max(1, Math.abs(ax1 - ax0)), height: ah, rx: Math.min(cfg.actual.radius, ah / 2), fill: actualColor(m) }));
        }
        if (cfg.compare.show && m.c != null) {
          g.appendChild(node('line', { 'class': 'cmp', x1: sx(m.c), x2: sx(m.c), y1: cy - bandH * 0.25, y2: cy + bandH * 0.25, stroke: cfg.compare.color, 'stroke-width': cfg.compare.thickness, 'shape-rendering': 'crispEdges' }));
        }
        if (cfg.target.show && m.t != null) {
          g.appendChild(node('line', { 'class': 'tgt', x1: sx(m.t), x2: sx(m.t), y1: cy - bandH * 0.36, y2: cy + bandH * 0.36, stroke: cfg.target.color, 'stroke-width': cfg.target.thickness, 'shape-rendering': 'crispEdges' }));
        }
      }

      if (valueW > 0) {
        var vt = node('text', { x: W, y: cy, 'text-anchor': 'end', 'dominant-baseline': 'central' });
        applyTextStyle(vt, fam);
        var main = mode === 'progress' && m.pct != null && showPct ? fmtPct(m.pct) : fmtVal(m.a, m, 'actual');
        vt.appendChild(document.createTextNode(main));
        if (mode === 'bullet' && showPct && m.pct != null) {
          var ts = node('tspan', { fill: lb.pctColor, 'font-weight': 400 }, '  ' + fmtPct(m.pct));
          vt.appendChild(ts);
        }
        g.appendChild(vt);
      }
      selectBox(g, m, 0, y - gap / 2, W, rowH + gap);
      svg.appendChild(g);
      drawn.push({ mark: m, x: 0, y: y, w: W, h: rowH });
    });
    return marks.length * (rowH + gap) - gap;
  }

  function applyTextStyle (t, f) {
    t.setAttribute('font-family', Bg.fontStack(f.font));
    t.setAttribute('font-size', f.size);
    t.setAttribute('font-weight', f.weight);
    t.setAttribute('font-style', f.italic ? 'italic' : 'normal');
    t.setAttribute('fill', f.color);
  }

  function polar (cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }

  /** A ring segment between radii r0 < r1 and angles a0 < a1 (radians, π = left end, 2π = right end). */
  function arcPath (cx, cy, r0, r1, a0, a1) {
    var large = a1 - a0 > Math.PI ? 1 : 0;
    var p = polar(cx, cy, r1, a0), q = polar(cx, cy, r1, a1), s = polar(cx, cy, r0, a1), t = polar(cx, cy, r0, a0);
    function f (n) { return Math.round(n * 100) / 100; }
    return 'M' + f(p[0]) + ' ' + f(p[1]) + ' A' + f(r1) + ' ' + f(r1) + ' 0 ' + large + ' 1 ' + f(q[0]) + ' ' + f(q[1]) +
      ' L' + f(s[0]) + ' ' + f(s[1]) + ' A' + f(r0) + ' ' + f(r0) + ' 0 ' + large + ' 0 ' + f(t[0]) + ' ' + f(t[1]) + ' Z';
  }

  /** A grid of semi-circular gauges; the number of columns follows the width. */
  function drawGauges (svg, marks, W, H) {
    var lb = cfg.labels;
    var gap = Math.max(0, Number(cfg.chart.gap) || 0);
    var minW = Math.max(60, Number(cfg.chart.gaugeSize) || 150);
    var cols = Math.max(1, Math.min(marks.length, Math.floor((W + gap) / (minW + gap))));
    var cw = (W - gap * (cols - 1)) / cols;
    var rowsN = Math.ceil(marks.length / cols);
    var hasLabel = lb.showCategory && model.cats.length > 0;
    var extra = 8 + (lb.showPct ? 16 : 0) + (hasLabel ? lb.category.size + 10 : 0) + 4;
    var R0 = Math.max(18, cw / 2 - 10);
    var avail = (H - gap * (rowsN - 1)) / rowsN;
    var R, ch;
    if (avail - extra >= 60) { R = Math.min(R0, avail - extra); ch = avail; } // fits the zone: use the room
    else { R = R0; ch = R + extra; } // too many for the zone: natural size, scrolls
    var off = Math.max(0, (ch - R - extra) / 2);

    marks.forEach(function (m, i) {
      var x = (i % cols) * (cw + gap);
      var y = Math.floor(i / cols) * (ch + gap);
      var cx = x + cw / 2;
      var cy = y + off + 8 + R;
      var tb = Math.max(6, Math.min(R * 0.3, 32));
      var g = node('g', { 'class': 'mark', 'data-i': i });
      g.appendChild(hitRect(x, y, cw, ch));
      var ang = function (v) { return Math.PI + Math.PI * Math.max(0, Math.min(1, (v - m.lo) / (m.hi - m.lo))); };

      g.appendChild(node('path', { d: arcPath(cx, cy, R - tb, R, Math.PI, 2 * Math.PI - 0.0001), fill: cfg.ranges.track }));
      var cols2 = bandColors(m.bounds.length);
      var prev = m.lo;
      m.bounds.forEach(function (b, k) {
        var a0 = ang(prev);
        var a1 = ang(b);
        if (a1 - a0 > 0.002) g.appendChild(node('path', { 'class': 'band', d: arcPath(cx, cy, R - tb, R, a0, a1), fill: cols2[k] }));
        prev = Math.max(prev, b);
      });
      if (m.a != null) {
        var at = Math.max(3, tb * Math.min(1, Math.max(5, Number(cfg.actual.thickness) || 38) * 1.6 / 100));
        var rm = R - tb / 2;
        var a2 = ang(Math.max(m.lo, m.a));
        if (a2 - Math.PI > 0.002) g.appendChild(node('path', { 'class': 'actual', d: arcPath(cx, cy, rm - at / 2, rm + at / 2, Math.PI, a2), fill: actualColor(m) }));
      }
      if (cfg.compare.show && m.c != null) {
        var pc = polar(cx, cy, R - tb - 1, ang(m.c)), qc = polar(cx, cy, R - tb * 0.45, ang(m.c));
        g.appendChild(node('line', { 'class': 'cmp', x1: pc[0], y1: pc[1], x2: qc[0], y2: qc[1], stroke: cfg.compare.color, 'stroke-width': cfg.compare.thickness }));
      }
      if (cfg.target.show && m.t != null) {
        var pt = polar(cx, cy, R - tb - 3, ang(m.t)), qt = polar(cx, cy, R + 3, ang(m.t));
        g.appendChild(node('line', { 'class': 'tgt', x1: pt[0], y1: pt[1], x2: qt[0], y2: qt[1], stroke: cfg.target.color, 'stroke-width': cfg.target.thickness }));
      }

      // Big value in the middle: the real number, even when the arc is clamped at zero.
      var vtext = fmtVal(m.a, m, 'actual');
      var vf = lb.value;
      var fs = Math.min(vf.size * 1.8, Math.max(10, R * 0.42));
      var inner = Math.max(10, 1.7 * (R - tb));
      while (fs > 8 && textWidth(vtext, fs, vf.weight, vf.font) > inner) fs -= 1;
      var vt = node('text', { x: cx, y: cy - 3, 'text-anchor': 'middle' }, vtext);
      applyTextStyle(vt, vf);
      vt.setAttribute('font-size', fs);
      g.appendChild(vt);
      var yy = cy;
      if (lb.showPct) {
        yy += 14;
        if (m.pct != null) {
          var pt2 = node('text', { x: cx, y: yy, 'text-anchor': 'middle' }, fmtPct(m.pct));
          applyTextStyle(pt2, { font: vf.font, size: 11, weight: 400, color: lb.pctColor, italic: false });
          g.appendChild(pt2);
        }
      }
      if (hasLabel) {
        var lt = fitText({ x: cx, y: yy + lb.category.size + 3, 'text-anchor': 'middle' }, m.label, cw - 8, lb.category);
        applyTextStyle(lt, lb.category);
        g.appendChild(lt);
      }
      selectBox(g, m, x, y, cw, ch);
      svg.appendChild(g);
      drawn.push({ mark: m, x: x, y: y, w: cw, h: ch });
    });
    return rowsN * ch + gap * (rowsN - 1);
  }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------
  function markFromEvent (e) {
    var g = e.target && e.target.closest ? e.target.closest('.mark') : null;
    if (!g) return null;
    var d = drawn[Number(g.getAttribute('data-i'))];
    return d ? d.mark : null;
  }

  /** Click a row / gauge: select its category in Tableau (dashboard actions fire). Click again to clear. */
  function onMarkClick (e) {
    if (!cfg || !model || !cfg.interaction || !cfg.interaction.selectInTableau) return;
    if (e.detail > 1 || el.menu.style.display === 'block') return; // second click of a double-click
    var m = markFromEvent(e);
    if (!m) { clearPick(); return; }
    if (!model.cats.length || !m.sel.length) return; // no Category: nothing to select
    if (selected === m.key) { clearPick(); return; }
    selected = m.key;
    ExtCore.select(worksheet, m.sel, 'Bullet & Gauge');
    paint();
  }

  function clearPick () {
    if (!selected) return;
    selected = null;
    ExtCore.clearSelection(worksheet);
    paint();
  }

  // Tableau's own tooltip (Format → Interaction): a mark → the first summary-data row of its category,
  // as sent by Tableau (0-based).
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

  function tipRow (name, value, color) {
    return '<div class="tt-row"><span class="nm">' + esc(name) + '</span><span class="vl"' + (color ? ' style="color:' + color + '"' : '') + '>' + esc(value) + '</span></div>';
  }

  function tooltipHtml (m) {
    var n = model.names;
    var html = '<div class="tt-name">' + esc(m.label || n.actual) + '</div>';
    html += '<div class="tt-value" style="color:' + actualColor(m) + '">' + esc(fmtVal(m.a, m, 'actual')) + '</div>';
    var rows = '';
    if (m.t != null) rows += tipRow(n.target, fmtVal(m.t, m, 'target'));
    if (m.pct != null) rows += tipRow('% of target', fmtPct(m.pct));
    if (m.c != null) rows += tipRow(n.compare, fmtVal(m.c, m, 'compare'));
    if (m.byRange) {
      for (var k = 0; k < model.nRanges; k++) {
        if (m.g.v['r' + k] != null) rows += tipRow(n.ranges[k], fmtVal(m.g.v['r' + k], m, 'r' + k));
      }
    } else {
      var thr = (cfg.ranges.thresholds || []).map(Number).filter(function (x) { return isFinite(x) && x > 0; }).sort(function (p, q) { return p - q; }).slice(0, 3);
      m.bounds.forEach(function (b, k) { rows += tipRow((thr[k] != null ? thr[k] : 100) + '% band ends', fmtVal(b)); });
    }
    return html + '<div class="tt-rows">' + rows + '</div>';
  }

  function onHover (e) {
    if (!cfg || el.menu.style.display === 'block') return;
    var m = markFromEvent(e);
    if (useTableauTip()) {
      hideTooltip();
      sendHoverRow(m && m.row != null ? m.row : null, e);
      if (useTableauTip()) return; // else: this Tableau cannot do it, fall through to our tooltip
    }
    if (!cfg.chart.tooltip) return;
    if (!m) { hideTooltip(); return; }
    var tt = el.tooltip;
    tt.innerHTML = tooltipHtml(m);
    tt.style.fontFamily = Bg.fontStack(cfg.numbers.font);
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
    var items = [
      ['Chart…', { tab: 'chart' }],
      ['Scale…', { tab: 'scale' }],
      ['Ranges…', { tab: 'ranges' }],
      ['Actual, target…', { tab: 'actual' }],
      ['Labels…', { tab: 'labels' }],
      ['Numbers…', { tab: 'numbers' }],
      null,
      ['Format extension…', null]
    ];
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

  window.BulletGauge = { init: init };
})();
