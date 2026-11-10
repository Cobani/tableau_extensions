/**
 * Bar Chart: interaction. Live preview from the Format dialog, hover and tooltip, pinned
 * tooltip, click / select in Tableau, drill, right-click menu, comments editor.
 *
 * No drawing of the plot here: changes go through S and then B.paint().
 */
'use strict';

(function () {
  const B = window.BcChart, S = B.S; // shared namespace and mutable state, see chart-state.js
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc;
  // Constants and pure helpers from chart-state.js (loaded first, so safe to copy here).
  var CS = B.CS, pctFmt = B.pctFmt, rootLabel = B.rootLabel, parseKey = B.parseKey, selKey = B.selKey;

  // ---------------------------------------------------------------------------
  // Live preview: the Format dialog also writes its settings to localStorage
  // (same origin), so the chart redraws at once instead of waiting for Tableau
  // to save them; the chart sends back what the dialog lists (fields, legend
  // items …) so the dialog stays current. Tableau's save still follows.
  // ---------------------------------------------------------------------------
  function onLiveSettings (e) {
    if (e.key !== 'barchart:live:' + S.liveId || !e.newValue) return;
    try {
      var o = JSON.parse(e.newValue);
      S.liveActive = true;
      S.cfg = Bc.merge(Bc.DEFAULTS, o.cfg);
    } catch (err) { return; }
    if (B.limitChanged()) B.refresh(); else B.schedule();
    clearTimeout(S.infoTimer);
    S.infoTimer = setTimeout(function () {
      try { if (S.raw) window.localStorage.setItem('barchart:info:' + S.liveId, JSON.stringify(dialogInfo(null))); } catch (err) { /* ignore */ }
    }, 120);
  }

  /** What the dialog needs to list: series, members, lines, dims, bars with comments. */
  function dialogInfo (focus) {
    var info = { focus: focus || null, liveId: S.liveId, series: [], members: [], lines: [], dims: [], combos: [], measures: [], bars: [], hasTarget: false, catCount: 0, axisType: 'dimension' };
    if (!S.raw) return info;
    var v = S.view || B.buildView();
    info.series = v.series.map(function (s) { return { key: s.key, name: s.name, color: s.color }; });
    var dvo = B.divOrder(v.visSeries);
    var dvi = S.cfg.diverging.firstSide === 'neg' ? 0 : 1;
    info.divAuto = {}; // left-right side each value takes from the data order (Format dialog: Pick each value's side)
    dvo.forEach(function (s, i) { info.divAuto[s.key] = i % 2 === dvi ? 'neg' : 'pos'; });
    info.divOrder = dvo.map(function (s) { return s.key; });
    var seen = {};
    v.allNodes.forEach(function (n) { if (!seen[n.label]) { seen[n.label] = 1; info.members.push(n.label); } });
    info.lines = S.raw.lines.map(function (l) { return { key: l.key, name: l.name }; });
    info.dims = S.raw.dims.map(function (d) { return { key: d.key, name: d.name }; });
    info.combos = B.comboList().slice(0, 400);
    info.measures = S.raw.measures.map(function (m) { return { key: m.key, name: m.name }; });
    info.bars = v.nodes.map(function (n) { return { key: n.key, label: n.label, path: n.pathLabel }; });
    info.hasTarget = !!B.targetInfo();
    info.extras = S.raw.extras.map(function (x) { return { key: x.key, name: x.name }; });
    info.levels = (S.raw.dimFields || []).map(function (f, i) { return { key: f.key, name: f.name, values: (S.raw.levelValues[i] || []).slice(0, 500) }; });
    info.L = S.raw.L;
    try {
      info.legendItems = B.legendItems(v).filter(function (it) { return !it.ramp; }).map(function (it) { return { id: it.id, name: it.orig, long: it.long, short: it.short }; });
    } catch (e) { info.legendItems = []; }
    info.params = Object.keys(S.params).map(function (k) { return { name: S.params[k].name, value: S.params[k].value }; });
    info.target = S.raw.target ? { key: S.raw.target.key, name: S.raw.target.name } : null;
    info.labels = {};
    S.raw.measures.forEach(function (m) { info.labels[m.key] = B.measureLabel(m); });
    S.raw.lines.forEach(function (l) { info.labels[l.key] = B.lineLabel(l); });
    S.raw.extras.forEach(function (x) { info.labels[x.key] = B.fieldLabel(x); });
    if (S.raw.target) info.labels[S.raw.target.key] = B.fieldLabel(S.raw.target);
    info.seriesIdx = S.raw.seriesIdx || [];
    info.seriesName = (S.raw.seriesFields || []).map(function (f) { return f.name; }).join(' · ') || null;
    info.barCandidates = (S.raw.dimFields || []).filter(function (f, i) { return (S.raw.seriesIdx || []).indexOf(i) < 0 && (S.raw.panelIdx || []).indexOf(i) < 0; }).map(function (f) { return f.name; });
    info.catCount = S.raw.catFields.length;
    info.axisType = v.axisType;
    info.isDate = S.raw.catIsDate;
    return info;
  }

  // ---------------------------------------------------------------------------
  // Hover highlight
  // ---------------------------------------------------------------------------
  function indexHover () {
    S.hoverEls = Array.prototype.map.call(S.el.plot.querySelectorAll('[data-k]'), function (e) {
      var it = e.hasAttribute('data-i') ? S.drawn[Number(e.getAttribute('data-i'))] : null;
      return { e: e, have: parseKey(e.getAttribute('data-k')), it: it || null, dim: false };
    });
    S.state.hoverKey = null;
    S.lastHover = null;
    // many marks: no fade transitions (they make every hover restyle hundreds of elements)
    S.el.plot.classList.toggle('many', S.drawn.length > 250);
  }

  function setHover (key) {
    if (S.state.hoverKey === key) return;
    S.state.hoverKey = key;
    var want = key ? (key.indexOf('d:') === 0 ? { d: key.slice(2) } : parseKey(key)) : null;
    if (want && (want.t != null || want.r != null)) want = null;
    var dk = want && want.d != null ? Number(want.d.slice(0, want.d.indexOf('|'))) : -1;
    var dv = want && want.d != null ? want.d.slice(want.d.indexOf('|') + 1) : null;
    for (var x = 0; x < S.hoverEls.length; x++) {
      var rec = S.hoverEls[x];
      var have = rec.have;
      var dim = false;
      if (!want) dim = false;
      else if (have.l != null) dim = want.l == null || want.l !== have.l;
      else if (want.l != null) dim = true;
      else if (dk >= 0) {
        var it = rec.it;
        var n = it && it.node;
        if (n) {
          var dp = n.dimPath || [];
          dim = B.isSeriesField(dk) ? !(it.b && it.b.s && it.b.s.parts && it.b.s.parts[S.raw.seriesIdx.indexOf(dk)] === dv)
            : dp[dk] != null ? dp[dk] !== dv : !n.items.some(function (q) { return q.b[dk] === dv; });
        }
      } else {
        dim = (want.c != null && want.c !== have.c) || (want.s != null && want.s !== have.s);
        if (!dim && want.o != null && rec.it && rec.it.node) dim = (want.o === 'oth') !== !!rec.it.node.isOthers;
      }
      if (dim !== rec.dim) { rec.dim = dim; rec.e.classList.toggle('is-dim', dim); }
    }
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------
  function itemFromEvent (e) {
    var g = e.target.closest ? e.target.closest('[data-i]') : null;
    if (!g) return null;
    return S.drawn[Number(g.getAttribute('data-i'))] || null;
  }
  function onHoverEvent (e) {
    var first = !S.hoverEvt;
    S.hoverEvt = { target: e.target, clientX: e.clientX, clientY: e.clientY };
    if (first) requestAnimationFrame(function () { var ev = S.hoverEvt; S.hoverEvt = null; if (ev) onHover(ev); });
  }

  function clearHoverNow () {
    clearTimeout(S.hoverClear); S.hoverClear = null;
    S.hoverEvt = null;
    S.lastHover = null;
    if (!S.state.pinned) hideTooltip();
    setHover(null);
  }

  function onHover (e) {
    if (!S.cfg || S.el.menu.style.display === 'block' || S.state.pinned) return;
    var d = itemFromEvent(e);
    if (!d) {
      if (!S.hoverClear) S.hoverClear = setTimeout(function () { S.hoverClear = null; S.lastHover = null; hideTooltip(); setHover(null); }, 140);
      return;
    }
    clearTimeout(S.hoverClear); S.hoverClear = null;
    var seg = e.target.getAttribute && e.target.getAttribute('data-seg');
    if (S.lastHover && S.lastHover.d === d && S.lastHover.seg === seg) {
      if (S.cfg.tooltip.show) placeTooltip(e.clientX, e.clientY);
      return;
    }
    S.lastHover = { d: d, seg: seg };
    if (S.cfg.hover.dimOthers) {
      if (d.kind === 'line') setHover('l:' + d.line.key);
      else if (d.b) setHover('c:' + rootLabel(d.node) + (S.view.visSeries.length > 1 ? '|s:' + d.b.s.key : ''));
    }
    if (!S.cfg.tooltip.show) return;
    showTooltip(d, e.clientX, e.clientY, false, seg != null ? Number(seg) : null);
  }

  function showTooltip (d, x, y, pinned, segIdx) {
    var tt = S.el.tooltip;
    tt.innerHTML = tooltipHtml(d, pinned, segIdx);
    tt.style.fontFamily = Bc.fontStack(S.cfg.numbers.font);
    tt.classList.toggle('is-pinned', !!pinned);
    tt.style.display = 'block';
    if (pinned) wirePinned(d);
    S.ttSize = { w: tt.offsetWidth, h: tt.offsetHeight }; // measured once per content
    placeTooltip(x, y);
  }
  function placeTooltip (x, y) {
    var tt = S.el.tooltip;
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = Math.min(Math.max(4, x + 12), vw - S.ttSize.w - 4);
    var top = y - S.ttSize.h - 12;
    if (top < 4) top = Math.min(y + 16, vh - S.ttSize.h - 4);
    tt.style.left = left + 'px';
    tt.style.top = Math.max(4, top) + 'px';
  }

  function fullOpts (fv, count) {
    return { full: S.cfg.tooltip.fullNumbers, fv: count === 1 ? fv : null };
  }

  /** Rows for the tooltip list: breakdown members, or every series of the category. */
  function tooltipRows (d) {
    var V = d.v || S.view; // the panel this bar is in (small multiples)
    var n = d.node;
    var TT = S.cfg.tooltip;
    if (TT.showBreakdown && S.raw.dims.length > n.depth && d.b) {
      var idx = [];
      for (var i = n.depth; i < S.raw.dims.length; i++) idx.push(i);
      var sums = {};
      var order = [];
      n.items.forEach(function (it) {
        if (it.s !== d.b.s.key) return;
        var name = idx.map(function (k) { return it.b[S.raw.dimPos[k]]; }).join(' · ');
        if (!(name in sums)) { sums[name] = 0; order.push(name); }
        sums[name] += it.v;
      });
      var spec = B.segSpec(n);
      var segs = spec ? B.segmentsOf(n, d.b.s.key, spec) : [];
      var colors = spec ? B.segColors(segs, d.b.color, spec) : {};
      var sh = Bc.shades(d.b.color, Math.max(1, order.length));
      var rows = order.map(function (k, j) { return { name: k, v: sums[k], color: colors[k] || sh[j] }; });
      if (rows.length > 1 || (rows.length === 1 && rows[0].name !== n.label)) {
        return { title: S.raw.dims.slice(n.depth).map(function (x) { return x.name; }).join(' · '), rows: rows, total: d.b.v };
      }
    }
    if (V.visSeries.length > 1 && TT.showSeries) {
      return { title: S.raw.seriesIdx.length ? S.raw.seriesFields.map(function (f) { return f.name; }).join(' · ') : 'Measure', rows: n.bars.map(function (b) { return { name: b.s.name, v: b.v, color: b.color, fv: b.fv, count: b.count, me: d.b && b.s.key === d.b.s.key }; }), total: n.bars.reduce(function (a, b) { return a + Math.abs(b.v); }, 0) };
    }
    return null;
  }

  function sortRows (rows, order) {
    var cmp = Bc.comparer(order === 'name' ? 'name' : order, function (r) { return r.v; }, function (r) { return r.name; });
    return Bc.sortBy(rows, cmp);
  }

  function tooltipHtml (d, pinned, segIdx) {
    var V = d.v || S.view;
    var n = d.node;
    var TT = S.cfg.tooltip;
    var f = B.tipFmt();
    var html = '';
    if (pinned) html += '<button class="tt-close" type="button" data-act="close" title="Close">×</button>';
    var path = n.parent ? n.pathLabel.slice(0, n.pathLabel.lastIndexOf(' › ')) : (n.outer && n.outer.length ? n.outer.join(' · ') : '');
    if (path) html += '<div class="tt-path">' + esc(path) + '</div>';
    html += '<div class="tt-name">' + esc(n.label) + '</div>';

    if (d.kind === 'line') {
      var lc = Bc.lineCfg(S.cfg, d.line.key);
      html += '<div class="tt-series"><span class="sw" style="display:inline-block;width:12px;height:3px;background:' + d.color + '"></span>' + esc(B.lineLabel(d.line)) + '</div>';
      html += '<div class="tt-value" style="color:' + d.color + '">' + esc(Bc.formatNumber(d.lv, B.tipFmt(), { full: TT.fullNumbers })) + '</div>';
    } else if (d.b) {
      var b = d.b;
      if (V.series.length > 1 && TT.showSeries) {
        html += '<div class="tt-series"><span class="sw" style="display:inline-block;width:9px;height:9px;border-radius:2px;background:' + b.color + '"></span>' + esc(b.s.name) + '</div>';
      } else if (S.raw.measures.length === 1 || V.axisType !== 'measureNames') {
        html += '<div class="tt-note">' + esc(b.s.name) + '</div>';
      }
      html += '<div class="tt-value" style="color:' + Bc.readable(b.color) + '">' + esc(Bc.formatNumber(b.v, f, fullOpts(b.fv, b.count))) + '</div>';
      if (TT.showPct) {
        var tot = V.totalsBySeries[b.s.key];
        var notes = [];
        if (tot && V.nodes.length > 1) notes.push(Bc.formatNumber(b.v / tot, pctFmt(f)) + ' of total');
        if (V.visSeries.length > 1) {
          var cs = n.bars.reduce(function (a, x) { return a + Math.abs(x.v); }, 0);
          if (cs) notes.push(Bc.formatNumber(b.v / cs, pctFmt(f)) + ' of ' + esc(n.label));
        }
        if (b.prev && b.prev.v) notes.push(Bc.formatNumber((b.v - b.prev.v) / Math.abs(b.prev.v), Bc.merge(pctFmt(f), { plusSign: true }), { signed: true }) + ' vs ' + esc(b.prev.node.label));
        if (notes.length) html += '<div class="tt-note">' + notes.join(' · ') + '</div>';
      }
      if (B.targetInfo() && !V.noTarget && isFinite(n.t) && S.cfg.target.inTooltip) {
        html += '<div class="tt-note">' + esc(B.fieldLabel(B.targetInfo())) + ': ' + esc(Bc.formatNumber(n.t, f, { full: TT.fullNumbers })) +
          (n.t ? ' (' + Bc.formatNumber(n.total / n.t, pctFmt(f)) + ' achieved)' : '') + '</div>';
      }
      if (n.isOthers && n.members) html += '<div class="tt-note">' + n.members.length + ' members: ' + esc(n.members.slice(0, 6).join(', ')) + (n.members.length > 6 ? '…' : '') + '</div>';

      var R = tooltipRows(d);
      if (R && R.rows.length) {
        var order = S.state.ttSort || TT.sort;
        var rows = sortRows(R.rows, order);
        var max = pinned ? rows.length : Math.max(1, TT.maxRows);
        html += '<div class="tt-rows">';
        if (pinned) {
          var btn = function (key, label) {
            var on = order === key || (key === 'val' && (order === 'valDesc' || order === 'valAsc')) || (key === 'name' && (order === 'name' || order === 'nameDesc'));
            var arrow = on ? (order === 'valAsc' || order === 'name' ? ' ▲' : ' ▼') : '';
            return '<button type="button" data-sort="' + key + '" class="' + (on ? 'is-on' : '') + '">' + label + arrow + '</button>';
          };
          html += '<div class="tt-head"><span class="nm">' + btn('name', esc(R.title || 'Name')) + '</span>' + btn('val', 'Value') + (TT.showPct ? '<span class="pc">%</span>' : '') + '</div>';
        } else if (R.title) {
          html += '<div class="tt-head"><span class="nm">' + esc(R.title) + '</span></div>';
        }
        var segName = segIdx != null && d.segs && d.segs[segIdx] ? d.segs[segIdx].seg.member : null;
        if (segIdx != null && d.item && d.item.segs) segName = d.item.segs[segIdx] && d.item.segs[segIdx].seg.member;
        rows.slice(0, max).forEach(function (r) {
          var me = r.me || (segName != null && r.name === segName);
          html += '<div class="tt-row"' + (me ? ' style="font-weight:700"' : '') + '><span class="sw" style="background:' + r.color + '"></span><span class="nm">' + esc(r.name) +
            '</span><span class="vl">' + esc(Bc.formatNumber(r.v, f, fullOpts(r.fv, r.count))) + '</span>' +
            (TT.showPct ? '<span class="pc">' + (R.total ? esc(Bc.formatNumber(r.v / R.total, pctFmt(f))) : '') + '</span>' : '') + '</div>';
        });
        if (rows.length > max) html += '<div class="tt-more">+ ' + (rows.length - max) + ' more — click the bar to see all</div>';
        html += '</div>';
      }
    }

    if (TT.showLines && d.kind !== 'line' && S.raw.lines.length) {
      var lr = S.raw.lines.filter(function (l) { return isFinite(n.l[l.key]); });
      if (lr.length) {
        html += '<div class="tt-rows">' + lr.map(function (l) {
          var lc2 = Bc.lineCfg(S.cfg, l.key);
          return '<div class="tt-row"><span class="sw" style="height:3px;background:' + B.lineColor(l.key, S.raw.lines.indexOf(l)) + '"></span><span class="nm">' + esc(B.lineLabel(l)) +
            '</span><span class="vl">' + esc(Bc.formatNumber(n.l[l.key], B.tipFmt(), { full: TT.fullNumbers })) + '</span></div>';
        }).join('') + '</div>';
      }
    }
    if (TT.showExtra && S.raw.extras.length) {
      var tgi = B.targetInfo();
      // every Tooltip-tile field as "name: value", in tile order
      var xr = S.raw.extras.filter(function (x) {
        return isFinite(n.x[x.key]) || (n.xt && n.xt[x.key] && n.xt[x.key].length);
      });
      if (xr.length) {
        html += '<div class="tt-rows tt-kv">' + xr.map(function (x) {
          var val;
          if (!isFinite(n.x[x.key])) {
            var a = n.xt[x.key];
            val = a.length <= 3 ? a.join(', ') : a.slice(0, 3).join(', ') + ' +' + (a.length - 3) + ' more';
          } else val = n.xf && n.xf[x.key] && !n.isOthers ? n.xf[x.key] : Bc.formatNumber(n.x[x.key], f, { full: TT.fullNumbers });
          return '<div class="tt-row"><span class="nm">' + esc(B.fieldLabel(x)) + ':</span><span class="vl">' + esc(val) + '</span></div>';
        }).join('') + '</div>';
      }
    }
    var notes2 = B.commentsOf(n);
    if (notes2.length && S.cfg.comments.show) {
      notes2.forEach(function (c) {
        html += '<div class="tt-comment" style="border-left-color:' + (c.color || S.cfg.comments.color) + '">' + esc(c.text) +
          (c.author || c.date ? '<div class="by">' + esc([c.author, c.date].filter(Boolean).join(' · ')) + '</div>' : '') + '</div>';
      });
    }
    if (!pinned) {
      var hints = [];
      if (TT.pinOnClick) hints.push('Click to pin');
      if (canDrill(n) && S.cfg.interaction.dblclick === 'drill') hints.push('double-click to drill down');
      if (hints.length) html += '<div class="tt-hint">' + hints.join(' · ') + '</div>';
    }
    return html;
  }

  function wirePinned (d) {
    var tt = S.el.tooltip;
    Array.prototype.forEach.call(tt.querySelectorAll('[data-sort]'), function (b) {
      b.addEventListener('click', function () {
        var cur = S.state.ttSort || S.cfg.tooltip.sort;
        var k = b.getAttribute('data-sort');
        if (k === 'val') S.state.ttSort = cur === 'valDesc' ? 'valAsc' : 'valDesc';
        else S.state.ttSort = cur === 'name' ? 'nameDesc' : 'name';
        var r = tt.getBoundingClientRect();
        tt.innerHTML = tooltipHtml(d, true);
        wirePinned(d);
        tt.style.left = r.left + 'px';
        tt.style.top = r.top + 'px';
      });
    });
    var close = tt.querySelector('[data-act="close"]');
    if (close) close.addEventListener('click', unpin);
  }

  function unpin () {
    if (!S.state.pinned) return;
    S.state.pinned = null;
    S.state.ttSort = null;
    hideTooltip();
  }

  function hideTooltip () {
    if (S.el.tooltip) { S.el.tooltip.style.display = 'none'; S.el.tooltip.classList.remove('is-pinned'); }
  }

  function hideTooltipIfStale () {
    if (S.state.pinned) { S.state.pinned = null; S.state.ttSort = null; }
    hideTooltip();
  }

  // ---------------------------------------------------------------------------
  // Click, double-click, drill
  // ---------------------------------------------------------------------------
  /** The bar (or line point), its value label, or its name on the axis under the pointer. */
  function hitFromEvent (e) {
    var d = itemFromEvent(e);
    if (d) return { d: d, n: d.node };
    var c = e.target.closest ? e.target.closest('[data-cat]') : null;
    var n = c ? S.catRefs[Number(c.getAttribute('data-cat'))] : null;
    return n ? { d: null, n: n } : null;
  }
  function onClick (e) {
    if (!S.cfg) return;
    if (e.detail > 1) return; // second click of a double-click
    var hit = hitFromEvent(e);
    if (hit && hit.d && hit.d.kind === 'comment') { openNote(hit.d.node, e.clientX, e.clientY); return; }
    var x = e.clientX; var y = e.clientY;
    var run = function () { S.clickTimer = null; doClick(hit, x, y); };
    // wait a moment when a double-click does something, so a double-click doesn't select first
    clearTimeout(S.clickTimer);
    if (hit && S.cfg.interaction.dblclick && S.cfg.interaction.dblclick !== 'none') S.clickTimer = setTimeout(run, 240);
    else run();
  }

  function doClick (hit, x, y) {
    if (!hit) {
      unpin();
      if (S.state.sel) clearSelection();
      return;
    }
    var same = S.state.sel === selKey(hit.n);
    if (hit.d && S.cfg.tooltip.show && S.cfg.tooltip.pinOnClick) {
      if (same && S.state.pinned) unpin();
      else { S.state.pinned = hit.d; S.state.ttSort = null; showTooltip(hit.d, x, y, true); }
    }
    if (S.cfg.interaction.selectInTableau) {
      // click the selected category again → undo; another one → select that instead
      if (same) clearSelection();
      else { S.state.sel = selKey(hit.n); selectInTableau(hit.n); markSelection(); }
    }
  }

  function clearSelection () {
    S.state.sel = null;
    clearTableauSelection();
    markSelection();
  }

  /** Fades everything but the selected category (bars, value labels, names, icons). */
  function markSelection () {
    if (!S.el.plot || !S.view) return;
    var sel = S.state.sel;
    if (sel && !S.catRefs.some(function (n) { return selKey(n) === sel; }) && !S.drawn.some(function (it) { return it.node && selKey(it.node) === sel; })) { S.state.sel = sel = null; }
    Array.prototype.forEach.call(S.el.plot.querySelectorAll('[data-i],[data-cat]'), function (e) {
      var n = null;
      if (e.hasAttribute('data-i')) { var it = S.drawn[Number(e.getAttribute('data-i'))]; n = it && it.node; }
      else n = S.catRefs[Number(e.getAttribute('data-cat'))];
      e.classList.toggle('is-unsel', !!(sel && n && selKey(n) !== sel));
    });
    S.el.plot.classList.toggle('has-sel', !!sel);
  }

  function onDblClick (e) {
    clearTimeout(S.clickTimer); S.clickTimer = null;
    var hit = hitFromEvent(e);
    var d = hit && (hit.d || (hit.n.bars && hit.n.bars[0] ? S.drawn.find(function (x) { return x.node === hit.n && x.kind === 'bar'; }) : null));
    if (!d || !S.cfg) return;
    unpin();
    var act = S.cfg.interaction.dblclick;
    if (act === 'drill' && canDrill(d.node)) drillDown(d.node);
    else if (act === 'drill' && d.node.parent && S.cfg.drill.mode === 'expandOne') collapse(d.node.parent);
    else if (act === 'format' || act === 'drill') B.openDialog({ tab: 'bars', item: d.b ? d.b.s.key : null, member: d.node.label });
  }

  function canDrill (n) {
    return !!(S.cfg.drill.enabled && S.raw && S.raw.dims.length > n.depth);
  }
  function drillDown (n) {
    var D = S.cfg.drill;
    if (D.mode === 'focus') S.state.focus.push(n.key);
    else if (D.mode === 'expandAll') S.state.level = Math.min(S.raw.dims.length, n.depth + 1);
    else { S.state.expanded[n.key] = true; S.expOrder.push(n.key); }
    S.state.animate = true;
    B.paint();
  }

  function collapse (n) {
    Object.keys(S.state.expanded).forEach(function (k) { if (k === n.key || k.indexOf(n.key + CS) === 0) delete S.state.expanded[k]; });
    S.expOrder = S.expOrder.filter(function (k) { return S.state.expanded[k]; });
    S.state.animate = true;
    B.paint();
  }

  function drillUp () {
    var D = S.cfg.drill;
    if (D.mode === 'focus') S.state.focus.pop();
    else if (D.mode === 'expandAll') S.state.level = Math.max(0, S.state.level - 1);
    else {
      var k = S.expOrder.pop();
      while (k && !S.state.expanded[k]) k = S.expOrder.pop();
      if (k) delete S.state.expanded[k];
      else S.state.expanded = {};
    }
    S.state.animate = true;
    B.paint();
  }

  function resetDrill () {
    S.state.expanded = {}; S.expOrder = []; S.state.focus = []; S.state.level = 0;
    S.state.animate = true;
    B.paint();
  }

  /** Selects the bar's members in Tableau (for dashboard actions). Silently skipped if not supported. */
  function selectInTableau (n) {
    try {
      var sel = [];
      var root = n; var chain = [];
      while (root) { chain.unshift(root); root = root.parent; }
      var top = chain[0];
      if (S.view.axisType !== 'measureNames') {
        S.raw.catFields.forEach(function (f, i) { if (top.path[i] != null) sel.push({ fieldName: f.name, value: [top.path[i]] }); });
      }
      chain.slice(1).forEach(function (c, i) { if (S.raw.dims[i]) sel.push({ fieldName: S.raw.dims[i].name, value: [c.label] }); });
      (n.panelVals || []).forEach(function (pv) { sel.push({ fieldName: pv.field.name, value: [pv.value] }); }); // small multiples: that panel only
      ExtCore.select(S.worksheet, sel, 'Bar Chart');
    } catch (e) { /* not supported */ }
  }

  function clearTableauSelection () {
    ExtCore.clearSelection(S.worksheet);
  }

  // ---------------------------------------------------------------------------
  // Right-click menu
  // ---------------------------------------------------------------------------
  function onContextMenu (e) {
    if (!S.cfg || !S.cfg.interaction.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    S.state.pinned = null;
    var d = itemFromEvent(e);
    var items = [];
    var n = d && d.node;
    if (n) {
      items.push({ head: n.pathLabel + (d.b && S.view.visSeries.length > 1 ? ' · ' + d.b.s.name : '') });
      items.push(['Format “' + (d.b && S.view.cmode === 'measures' ? d.b.s.name : n.label) + '” colour…', function () { B.openDialog({ tab: 'bars', item: d.b ? d.b.s.key : null, member: n.label }); }]);
      var nc = B.commentsOf(n).length;
      items.push([nc ? 'Comments (' + nc + ')…' : 'Add comment…', function () { openNote(n, e.clientX, e.clientY); }]);
      if (canDrill(n)) items.push(['Drill down to ' + S.raw.dims[n.depth].name, function () { drillDown(n); }]);
      if (n.parent && S.cfg.drill.mode === 'expandOne') items.push(['Collapse “' + n.parent.label + '”', function () { collapse(n.parent); }]);
      items.push(null);
      items.push(['Keep only “' + rootLabel(n) + '”', function () { keepOnly(n); }]);
      items.push(['Hide “' + rootLabel(n) + '”', function () { hideMember(rootLabel(n)); }]);
      var hl = (S.cfg.colors.highlight || []).indexOf(n.label) >= 0;
      items.push([hl ? 'Remove highlight' : 'Highlight “' + n.label + '”', function () { toggleHighlight(n.label); }]);
    }
    if (B.isDrilled()) {
      items.push(null);
      items.push(['Drill up', drillUp], ['Reset drill-down', resetDrill]);
    }
    var hidden = (S.cfg.interaction.hidden || []).length;
    if (hidden) items.push(['Show hidden bars (' + hidden + ')', function () { setSaved(function (c) { c.interaction.hidden = []; }); }]);
    items.push(null);
    items.push(['Chart type…', function () { B.openDialog({ tab: 'type' }); }],
      ['Bars…', function () { B.openDialog({ tab: 'bars' }); }],
      ['Value text…', function () { B.openDialog({ tab: 'labels' }); }],
      ['Dimension axis…', function () { B.openDialog({ tab: 'dimaxis' }); }],
      ['Measure axis…', function () { B.openDialog({ tab: 'measaxis' }); }],
      ['Legend…', function () { B.openDialog({ tab: 'legend' }); }],
      null,
      ['Format extension…', function () { B.openDialog(null); }]);

    var m = S.el.menu;
    m.innerHTML = '';
    var prevSep = true;
    items.forEach(function (it) {
      if (!it) { if (!prevSep) m.appendChild(document.createElement('hr')); prevSep = true; return; }
      prevSep = false;
      if (it.head) { var h = document.createElement('div'); h.className = 'menu-head'; h.textContent = it.head; m.appendChild(h); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', function () { hideMenu(); it[1](); });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    m.style.left = Math.max(2, Math.min(e.clientX, vw - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(2, Math.min(e.clientY, vh - m.offsetHeight - 4)) + 'px';
  }

  function hideMenu () {
    if (S.el.menu) S.el.menu.style.display = 'none';
  }

  /** Changes a saved setting from the chart (works while authoring; viewers keep it for the session). */
  function setSaved (fn) {
    var c = Bc.read();
    fn(c);
    fn(S.cfg);
    S.state.animate = true;
    B.paint();
    try {
      Bc.write(c).catch(function (err) { console.info('Bar Chart: setting kept for this session only', err && err.message); });
    } catch (e) { /* read-only */ }
  }

  function hideMember (label) {
    setSaved(function (c) { if (c.interaction.hidden.indexOf(label) < 0) c.interaction.hidden.push(label); });
  }

  function keepOnly (n) {
    var keep = rootLabel(n);
    var others = S.view.allNodes.map(function (x) { return x.label; }).filter(function (l) { return l !== keep; });
    setSaved(function (c) { c.interaction.hidden = others.slice(); });
  }

  function toggleHighlight (label) {
    setSaved(function (c) {
      var i = c.colors.highlight.indexOf(label);
      if (i >= 0) c.colors.highlight.splice(i, 1); else c.colors.highlight.push(label);
      c.colors.mode = 'highlight';
      c.colors.highlightBy = 'auto';
    });
  }

  // ---------------------------------------------------------------------------
  // Comment editor
  // ---------------------------------------------------------------------------
  function openNote (n, x, y) {
    hideMenu();
    unpin();
    var box = S.el.note;
    var list = B.commentsOf(n);
    box.innerHTML = '';
    var title = document.createElement('div');
    title.className = 'ne-title';
    title.textContent = 'Comments — ' + n.pathLabel;
    box.appendChild(title);
    if (list.length) {
      var ul = document.createElement('div');
      ul.className = 'ne-list';
      list.forEach(function (c) {
        var row = document.createElement('div');
        row.className = 'ne-item';
        var t = document.createElement('span');
        t.textContent = c.text + (c.author || c.date ? '  — ' + [c.author, c.date].filter(Boolean).join(', ') : '');
        var del = document.createElement('button');
        del.type = 'button';
        del.textContent = 'Delete';
        del.addEventListener('click', function () { saveNotes(n, list.filter(function (x) { return x.id !== c.id; }), msg); closeNote(); });
        row.append(t, del);
        ul.appendChild(row);
      });
      box.appendChild(ul);
    }
    var ta = document.createElement('textarea');
    ta.placeholder = 'Write a comment for this bar…';
    box.appendChild(ta);
    var rowB = document.createElement('div');
    rowB.className = 'ne-row';
    var msg = document.createElement('span');
    msg.className = 'msg';
    var cancel = B.button('Close', closeNote);
    var save = B.button('Add', function () {
      var text = ta.value.trim();
      if (!text) { ta.focus(); return; }
      var d = new Date();
      var entry = { id: 'n' + Date.now().toString(36), text: text, author: S.cfg.comments.author || '', date: d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2), color: '' };
      saveNotes(n, list.concat([entry]), msg).then(function (ok) { if (ok) closeNote(); });
    });
    save.className = 'primary';
    rowB.append(msg, cancel, save);
    box.appendChild(rowB);
    box.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    box.style.left = Math.max(4, Math.min(x, vw - box.offsetWidth - 4)) + 'px';
    box.style.top = Math.max(4, Math.min(y, vh - box.offsetHeight - 4)) + 'px';
    setTimeout(function () { ta.focus(); }, 0);
  }

  function saveNotes (n, list, msg) {
    var c = Bc.read();
    if (list.length) c.comments.items[n.key] = list; else delete c.comments.items[n.key];
    S.cfg.comments.items = Bc.clone(c.comments.items);
    B.paint();
    try {
      return Bc.write(c).then(function () { return true; }).catch(function () {
        if (msg) msg.textContent = 'Saved for this session only: comments are stored in the workbook while you edit it.';
        return false;
      });
    } catch (e) {
      return Promise.resolve(false);
    }
  }

  function closeNote () { if (S.el.note) S.el.note.style.display = 'none'; }

  // Called from the other chart files as B.<name>(…).
  B.onLiveSettings = onLiveSettings;
  B.dialogInfo = dialogInfo;
  B.indexHover = indexHover;
  B.setHover = setHover;
  B.onHoverEvent = onHoverEvent;
  B.clearHoverNow = clearHoverNow;
  B.unpin = unpin;
  B.hideTooltip = hideTooltip;
  B.hideTooltipIfStale = hideTooltipIfStale;
  B.onClick = onClick;
  B.markSelection = markSelection;
  B.onDblClick = onDblClick;
  B.drillUp = drillUp;
  B.resetDrill = resetDrill;
  B.onContextMenu = onContextMenu;
  B.hideMenu = hideMenu;
  B.closeNote = closeNote;
})();
