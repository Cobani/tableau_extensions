/**
 * Bar Chart — Tableau Viz Extension.
 *
 * Marks card tiles (declared in bar-chart.trex):
 *   category   Axis: 0–3 dimensions. One bar per member; outer fields group
 *              the bars. Empty → one bar per measure (Measure Names).
 *   values     Values: the measures the bars show (dropped one by one).
 *   series     Color: optional dimension that splits each category into
 *              coloured bars (grouped, stacked, 100% or left-right).
 *   breakdown  Breakdown: optional dimensions for the tooltip, bar segments
 *              and drill-down (double-click a bar).
 *   line       Line: optional measures drawn as lines over the bars.
 *   target     Target: optional measure drawn as a marker on every bar.
 *   tooltip    Tooltip: optional extra measures for the tooltip.
 *
 * Header (icon, title, explanation) is the same as KPI Card 3; the card
 * options are Waterfall's. Everything else is set in the Format dialog
 * (configure.html), which also opens from the chart's right-click menu.
 *
 * Files (index.html loads them in this order; no build step): chart-state.js (namespace + state S),
 * chart-data.js, chart-layout.js, chart-card.js, chart-draw.js, chart-interact.js, chart.js.
 * This file: init, handshake recovery, refresh (read Tableau), paint orchestration, resize,
 * opening the Format dialog, and window.BarChart. No chart maths or svg drawing here.
 */
'use strict';

(function () {
  const B = window.BcChart, S = B.S; // shared namespace and mutable state, see chart-state.js
  // Constants and pure helpers from chart-state.js (loaded first, so safe to copy here).
  var INIT_TIMEOUT = B.INIT_TIMEOUT, INIT_TIMEOUT_STEP = B.INIT_TIMEOUT_STEP;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'drillbar', 'body', 'legend', 'plot', 'svg', 'hint', 'tooltip', 'menu', 'note'].forEach(function (id) {
      S.el[id] = document.getElementById(id);
    });
    ChartExport.attach(S.el.card, 'Bar Chart');

    // on the plot, not the svg: with small multiples every panel has its own svg
    S.el.plot.addEventListener('mousemove', B.onHoverEvent);
    S.el.plot.addEventListener('mouseleave', function () { B.clearHoverNow(); });
    S.el.plot.addEventListener('contextmenu', B.onContextMenu);
    S.el.plot.addEventListener('click', B.onClick);
    S.el.plot.addEventListener('dblclick', B.onDblClick);
    document.addEventListener('mousedown', function (e) {
      if (!S.el.menu.contains(e.target)) B.hideMenu();
      if (S.state.pinned && !S.el.tooltip.contains(e.target) && !S.el.plot.contains(e.target)) B.unpin();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { B.hideMenu(); B.unpin(); B.closeNote(); }
    });
    window.addEventListener('blur', B.hideMenu);

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
      S.worksheet = tableau.extensions.worksheetContent.worksheet;
      S.cfg = Bc.read();

      S.worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, function () { S.state.animate = true; B.loadParams(); refresh(); });
      B.loadParams();
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          // while the dialog's live preview drives the chart, saves (which lag behind it) are ignored
          if (S.liveActive) return;
          S.cfg = Bc.read();
          if (B.limitChanged()) refresh(); else paint();
        }
      );
      window.addEventListener('storage', B.onLiveSettings);

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      if (initDone) {
        console.error('Bar Chart failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Bar Chart failed to initialize:', err);
      if (!boot.retry('handshake failed')) showRetry();
    });
  }

  /** A click reloads the extension. */
  function showRetry (why) {
    showEmpty((why || 'Could not connect to Tableau.') + '<br><u>Click to reload.</u>');
    S.el.hint.style.cursor = 'pointer';
    S.el.hint.onclick = function () { if (window.ExtBoot) ExtBoot.reload(); else location.reload(); };
  }
  function schedule () {
    if (S.queued) return;
    S.queued = true;
    requestAnimationFrame(function () { S.queued = false; paint(); });
  }

  /**
   * Opens the Format dialog. `focus` ({ tab, item }) preselects a tab and an
   * item (series / member). The dialog gets the fields and members as
   * payload, because it can't read the worksheet itself.
   */
  function openDialog (focus) {
    B.hideMenu();
    B.unpin();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify(B.dialogInfo(focus));
    var options = { width: 620, height: 780 };
    // On top (Modal) keeps the Format window in front of Tableau until Done; Floating (Modeless) lets you click the workbook but can fall behind it.
    var DS = tableau.DialogStyle || {};
    var style = S.cfg && S.cfg.interaction.dialog === 'floating' ? DS.Modeless : DS.Modal;
    if (style) options.dialogStyle = style;
    var done = function () {
      // dialog closed: back to what Tableau saved
      if (!S.liveActive) return;
      S.liveActive = false;
      // the dialog may have closed before its last save: the chart has its latest settings, so it saves them
      try {
        if (tableau.extensions.settings.get(Bc.STORAGE_KEY) !== JSON.stringify(S.cfg)) Bc.write(S.cfg).catch(function () { /* viewer: can't save */ });
      } catch (e) { /* ignore */ }
      paint();
    };
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).then(done, function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Bar Chart dialog:', err && err.message);
      done();
    });
  }

  function fieldsSig (fields) {
    var out = {};
    Object.keys(fields).sort().forEach(function (k) {
      out[k] = fields[k].map(function (f) { return (f.id || '') + '|' + (f.name || ''); });
    });
    return JSON.stringify(out);
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------

  async function refresh () {
    var token = ++S.renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      var tFields = 0;
      var tData = 0;
      var fieldsP = B.getEncodedFields().then(function (r) { tFields = ms(); if (first) T.mark('fields received (Marks card)'); return r; });
      var dataP = B.readSummaryData().then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== S.renderToken) return;
      var fields = results[0];

      if (!fields.values.length) {
        S.raw = null;
        if (first) { T.mark('no measure on Measure'); T.done('Bar Chart load timings'); }
        showEmpty('Drag a measure onto <b>Measure</b> and a dimension onto <b>Dimension</b>.<br>' +
          'More Dimension fields become the breakdown and drill-down levels. Optional: <b>Line</b> draws a line over the bars, ' +
          '<b>Target</b> adds a marker to every bar, and any field on Tableau\'s <b>Tooltip</b> tile adds a tooltip row.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      var prevSig = S.raw && S.raw.sig;
      S.raw = B.extract(table, fields);
      ChartExport.setTable(table);
      S.raw.sig = fieldsSig(fields);
      if (prevSig && prevSig !== S.raw.sig) { S.state.expanded = {}; S.state.focus = []; S.state.level = 0; S.state.off = {}; }
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Bar Chart load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Bar Chart render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Bar Chart load timings'); }
      if (token === S.renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (S.cfg && window.ChartExport) ChartExport.refresh(S.cfg);
    if (!S.cfg || !S.raw) return;
    var v;
    try {
      v = B.buildView();
    } catch (e) {
      console.error('Bar Chart: could not build the chart', e);
      showEmpty('Could not draw the chart. Click the ! mark in the corner for details.');
      return;
    }
    S.view = v;
    if (!v.nodes.length || !v.series.length) {
      showEmpty(v.allNodes.length ? 'Every bar is hidden. Right-click the chart → <b>Show hidden bars</b>.' : 'No values to show.');
      if (v.allNodes.length) { S.el.card.classList.remove('is-empty'); S.el.hint.style.display = 'none'; }
      return;
    }
    S.el.card.classList.remove('is-empty');
    S.el.hint.style.display = '';
    B.hideTooltipIfStale();
    B.paintCard();
    B.paintHeader(v);
    B.paintDrillbar(v);
    B.paintLegend(v);
    drawPlot(v);
    B.indexHover();
    B.markSelection();
    S.state.animate = false;
  }

  function drawPlot (v) {
    var host = S.el.plot.querySelector('.panes');
    if ((!S.raw.panelIdx || !S.raw.panelIdx.length) && !B.measurePanels()) {
      if (host) host.remove();
      S.el.svg.style.display = '';
      B.drawChart(v);
      return;
    }
    var PN = S.cfg.panels;
    var panes = B.panelList()
      .filter(function (p) { return p.v.nodes.length; });
    S.el.svg.style.display = 'none';
    while (S.el.svg.firstChild) S.el.svg.removeChild(S.el.svg.firstChild);
    S.drawn = []; S.catRefs = [];
    if (!host) { host = document.createElement('div'); host.className = 'panes'; S.el.plot.appendChild(host); }
    host.innerHTML = '';
    var n = panes.length;
    var W = S.el.plot.clientWidth; var H = S.el.plot.clientHeight;
    var cols = PN.layout === 'rows' ? 1 : PN.layout === 'columns' ? n
      : PN.columns > 0 ? Math.min(PN.columns, n) : Math.max(1, Math.min(n, Math.round(Math.sqrt(n * (W / Math.max(1, H))))));
    host.style.gridTemplateColumns = 'repeat(' + cols + ', minmax(0, 1fr))';
    host.style.gridTemplateRows = 'repeat(' + Math.ceil(n / cols) + ', minmax(0, 1fr))';
    host.style.gap = PN.gap + 'px';
    panes.forEach(function (p) {
      var d = document.createElement('div'); d.className = 'pane';
      if (PN.showTitle) {
        var t = document.createElement('div'); t.className = 'pane-title'; t.textContent = p.m;
        t.style.fontSize = PN.titleSize + 'px'; t.style.fontWeight = String(PN.titleWeight); t.style.color = PN.titleColor;
        t.style.fontFamily = Bc.fontStack(S.cfg.numbers.font); t.style.textAlign = PN.titleAlign;
        d.appendChild(t);
      }
      var box = document.createElement('div'); box.className = 'pane-plot';
      var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); svg.setAttribute('class', 'svg');
      box.appendChild(svg); d.appendChild(box); host.appendChild(d);
      p.svg = svg; p.box = box;
    });
    // shared value axis: one range for all panels — per measure with a panel per measure,
    // like Measure Names on Rows in Tableau (each measure keeps its own axis)
    var exts = {};
    panes.forEach(function (p) {
      p.W = p.box.clientWidth; p.H = p.box.clientHeight;
      if (!PN.shareAxis) return;
      var e = B.drawChart(p.v, { svg: p.svg, W: p.W, H: p.H, extentOnly: true });
      var k = p.v.measure || '';
      var ext = exts[k];
      if (e) exts[k] = ext ? { lo: Math.min(ext.lo, e.lo), hi: Math.max(ext.hi, e.hi), llo: Math.min(ext.llo, e.llo), lhi: Math.max(ext.lhi, e.lhi) } : e;
    });
    panes.forEach(function (p) { B.drawChart(p.v, { svg: p.svg, W: p.W, H: p.H, append: true, extent: exts[p.v.measure || ''] || null }); });
  }

  // ---------------------------------------------------------------------------

  function showEmpty (html) {
    S.el.card.classList.add('is-empty');
    B.hideTooltip();
    S.el.hint.innerHTML = html;
  }

  window.BarChart = { init: init, _state: S.state, _view: function () { return S.view; } };

  // Called from the other chart files as B.<name>(…).
  B.schedule = schedule;
  B.openDialog = openDialog;
  B.refresh = refresh;
  B.paint = paint;
})();
