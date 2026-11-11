/**
 * Bar Chart: layout maths. Number formats, text measuring and wrapping, scales and ticks, bar
 * geometry, label text and placement, reference values, legend items and legend capping.
 *
 * Pure calculations (textWidth uses an off-screen canvas); nothing here adds to the page.
 */
'use strict';

(function () {
  const B = window.BcChart, S = B.S; // shared namespace and mutable state, see chart-state.js
  // Constants and pure helpers from chart-state.js (loaded first, so safe to copy here).
  var fx = B.fx, pctFmt = B.pctFmt, rootLabel = B.rootLabel;

  function defaultTitle (v) {
    var m = S.raw.measures.map(B.measureLabel).join(' & ');
    if (v.axisType === 'measureNames' || !S.raw.catFields.length) return m;
    return m + ' by ' + S.raw.catFields[S.raw.catFields.length - 1].name;
  }

  function iconTarget () {
    var n = Number(S.cfg.icon.size);
    return isFinite(n) && n > 0 ? Math.max(8, Math.min(128, n)) : 24;
  }

  // ---------------------------------------------------------------------------
  // Legend
  // ---------------------------------------------------------------------------
  function legendItems (v) {
    var L = S.cfg.legend;
    var items = [];
    var mode = v.cmode;
    if (mode === 'dimensions') {
      var k = B.dimLevelOf();
      var tot = {};
      S.raw.rowsAll.forEach(function (r) {
        var x = r.d[k];
        tot[x] = (tot[x] || 0) + Object.keys(r.v).reduce(function (a, m) { return a + r.v[m]; }, 0);
      });
      var vals = (S.raw.levelValues[k] || []).slice();
      if (S.raw.rows.some(function (r) { return r.oth && r.d[k] === (S.cfg.topN.label || 'Others'); })) vals.push(S.cfg.topN.label || 'Others');
      vals.forEach(function (x) {
        var present = S.raw.rows.some(function (r) { return r.d[k] === x; }) || S.state.off['d:' + k + '|' + x];
        if (!present) return;
        var isOth = x === (S.cfg.topN.label || 'Others') && S.raw.rows.some(function (r) { return r.oth && r.d[k] === x; });
        items.push({ key: 'd:' + k + '|' + x, hover: 'd:' + k + '|' + x, name: x, color: isOth ? S.cfg.topN.color : B.dimColor(k, x), value: tot[x], toggle: !isOth });
      });
    } else if (mode === 'sign') {
      items.push({ id: 'sign:pos', name: 'Positive', color: S.cfg.colors.posColor }, { id: 'sign:neg', name: 'Negative', color: S.cfg.colors.negColor });
    } else if (mode === 'highlight') {
      items.push({ id: 'hl:on', name: 'Highlighted', color: S.cfg.colors.highlightColor }, { id: 'hl:off', name: 'Other', color: S.cfg.colors.mutedColor });
    } else if (mode === 'value') {
      items.push({ ramp: true });
    } else if (v.axisType === 'measureNames') {
      // each bar is a measure
      S.raw.measures.forEach(function (m) {
        var n = v.allNodes.find(function (x) { return x.measureKey === m.key; });
        items.push({ key: 'c:' + m.name, hover: 'c:' + m.name, name: B.measureLabel(m),
          color: mode === 'measures' ? B.measureColor(m.key) : S.cfg.colors.single, value: n ? n.total : null, toggle: true });
      });
    } else {
      // With Top N + Others, each measure gets a "Top N" and an "Others" item
      var oth = S.cfg.topN.enabled && v.nodes.some(function (n) { return n.isOthers; }) || S.state.off['o:'];
      var topWord = (S.cfg.topN.direction === 'bottom' ? 'Bottom ' : 'Top ') + S.cfg.topN.n;
      var othLabel = S.cfg.topN.label || 'Others';
      // each item takes the colour its bars are actually drawn in (stacks split by a dimension,
      // rules, one colour …), so the legend always matches the chart
      var drawnColor = {};
      v.nodes.forEach(function (n) {
        if (n.isOthers) return;
        (n.bars || []).forEach(function (b) { if (!(b.s.key in drawnColor)) drawnColor[b.s.key] = b.color; });
      });
      // a panel per measure and bars split by a dimension: one item per member (it shows/hides it in every panel)
      var perMember = B.measurePanels() && v.series.some(function (s) { return s.member != null; });
      var M0 = S.raw.measures[0].key;
      v.series.forEach(function (s) {
        if (perMember) {
          if (s.measure !== M0) return;
          s = Object.assign({}, s, { name: Bc.seriesCfg(S.cfg, s.key).label || s.member });
        }
        var color = drawnColor[s.key] || (mode === 'measures' ? s.color : (Bc.seriesCfg(S.cfg, s.key).color || S.cfg.colors.single));
        if (!oth) {
          items.push({ key: 's:' + s.key, hover: 's:' + s.key, name: s.name, color: color, value: v.totalsBySeries[s.key], toggle: true });
          return;
        }
        var topV = 0; var othV = 0;
        v.nodes.forEach(function (n) { var o = n.vals[s.key]; if (!o) return; if (n.isOthers) othV += o.v; else topV += o.v; });
        var short = L.topNNames === 'group';
        items.push({ key: 's:' + s.key, hover: 's:' + s.key + '|o:top', name: short ? topWord : s.name + ' – ' + topWord, long: s.name + ' – ' + topWord, short: topWord, color: color, value: topV, toggle: true });
        items.push({ key: 'o:', hover: 's:' + s.key + '|o:oth', name: short ? othLabel : s.name + ' – ' + othLabel, long: s.name + ' – ' + othLabel, short: othLabel, color: S.cfg.topN.color, value: othV, toggle: true });
      });
    }
    // segments with their own colours (Breakdown → Colors → Custom): one item per member
    if (S.cfg.breakdown.show && S.cfg.breakdown.colorMode === 'custom' && S.raw.dims.length && mode !== 'dimensions') {
      var segSeen = {};
      v.nodes.forEach(function (n) {
        if (!B.segSpec(n)) return;
        (n.bars || []).forEach(function (b) {
          B.segmentsOf(n, b.s.key, B.segSpec(n)).forEach(function (sg) {
            if (segSeen[sg.member]) return;
            segSeen[sg.member] = 1;
            var col = S.cfg.breakdown.colors[sg.member];
            if (col) items.push({ id: 'seg:' + sg.member, name: sg.member, color: col });
          });
        });
      });
    }
    if (S.cfg.chart.showBars === false) items = [];
    renameItems(items);
    if (L.sort === 'name') items = Bc.sortBy(items, function (a, b) { return String(a.name).localeCompare(String(b.name)); });
    if (L.sort === 'valDesc') items = Bc.sortBy(items, function (a, b) { return (b.value || 0) - (a.value || 0); });
    if (S.cfg.labels.totalInLegend && items.length && (v.layout === 'stacked' || v.layout === 'stacked100')) {
      var gt = 0; var gany = false;
      v.nodes.forEach(function (n) { (n.bars || []).forEach(function (b) { if (isFinite(b.v)) { gt += b.v; gany = true; } }); });
      items.push({ id: 'tot:', name: 'Total', color: S.cfg.labels.totalColor, value: gany ? gt : null });
    }
    var barCount = items.length;
    if (L.includeLines && S.cfg.chart.showLines !== false) {
      S.raw.lines.forEach(function (l, i) {
        var lc = Bc.lineCfg(S.cfg, l.key);
        var sum = 0; var any = false;
        v.nodes.forEach(function (n) { if (isFinite(n.l[l.key])) { sum += n.l[l.key]; any = true; } });
        items.push({ key: 'l:' + l.key, hover: 'l:' + l.key, name: B.lineLabel(l), color: lineColor(l.key, i), line: lc, toggle: true, value: any ? sum : null, fmt: lineFmt() });
      });
    }
    if (L.includeTarget && B.targetInfo() && S.cfg.target.show && S.cfg.target.style !== 'none' && S.cfg.chart.showBars !== false) {
      var ts = 0; var tany = false;
      v.nodes.forEach(function (n) { if (isFinite(n.t)) { ts += n.t; tany = true; } });
      items.push({ key: 't:', hover: 't:', name: B.fieldLabel(B.targetInfo()), color: S.cfg.target.color, target: true, toggle: true, value: tany ? ts : null });
    }
    if (L.includeRefs) {
      S.cfg.refs.forEach(function (r, i) {
        var rc = Bc.refCfg(r);
        if (!rc.show) return;
        items.push({ key: 'r:' + i, hover: 'r:' + i, name: rc.label ? rc.label.replace(/\{type\}/g, refName(rc)).replace(/:?\s*\{value\}/g, '') || refName(rc) : refName(rc), color: rc.color, ref: rc, toggle: true });
      });
    }
    renameItems(items);
    items.barCount = barCount;
    return items;
  }

  /** Legend → Item names: custom names (may hold <Parameter>), by a stable item id. */
  function renameItems (items) {
    var N = S.cfg.legend.names || {};
    items.forEach(function (it) {
      if (it.ramp || it.orig != null) return;
      it.id = it.id || it.hover || it.key || ('n:' + it.name);
      it.orig = it.name;
      var c = N[it.id];
      if (c != null && String(c).trim() !== '') it.name = B.fillParams(c);
    });
  }

  /**
   * Keeps the legend from eating the chart: a horizontal legend shows at most
   * two rows and a vertical one stays a single column; the rest scrolls.
   */
  function capLegend (lg, vertical) {
    var s = lg.style;
    s.maxHeight = ''; s.overflowY = ''; s.overflowX = '';
    if (!lg.children.length || lg.offsetParent === null) return;
    if (vertical) {
      s.maxHeight = '100%'; s.overflowY = 'auto'; s.overflowX = 'hidden';
      if (lg.scrollHeight > lg.clientHeight + 1) s.justifyContent = 'flex-start'; // centred content can't scroll to its top
      return;
    }
    var rects = Array.prototype.map.call(lg.children, function (c) { return c.getBoundingClientRect(); })
      .filter(function (r) { return r.height > 0; })
      .sort(function (a, b) { return a.top - b.top; });
    var rows = [];
    rects.forEach(function (r) {
      var last = rows[rows.length - 1];
      if (!last || r.top >= last.bottom - 1) rows.push({ top: r.top, bottom: r.bottom });
      else last.bottom = Math.max(last.bottom, r.bottom);
    });
    if (rows.length <= 2) return;
    var cs = getComputedStyle(lg);
    var h = rows[1].bottom - lg.getBoundingClientRect().top + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    s.maxHeight = Math.ceil(h + 1) + 'px';
    s.overflowY = 'auto'; s.overflowX = 'hidden';
  }

  function lineColor (key, i) {
    var lc = Bc.lineCfg(S.cfg, key);
    if (lc.color && Bc.normalizeHex(lc.color)) return lc.color;
    var defaults = ['#17202B', '#EB644C', '#0E7C66', '#6B4FB0'];
    return defaults[i % defaults.length];
  }

  function refName (r) {
    var names = { constant: 'Reference', average: 'Average', median: 'Median', min: 'Minimum', max: 'Maximum', percentile: 'P' + r.percentile, total: 'Total' };
    return names[r.type] || 'Reference';
  }

  /** Every number uses the chart's format (Value Text tab); tooltips can have their own (tipFmt). */
  function fmtOf (f) {
    return S.cfg.format;
  }

  /** Values on the lines + line axis: the chart's format unless Line Chart → "Use shared format" is off. */
  function lineFmt () {
    var LA = S.cfg.lineAxis || {};
    return LA.useGlobalFormat === false && LA.fmt ? LA.fmt : S.cfg.format;
  }

  function tipFmt () {
    return S.cfg.tooltip.ownFormat ? S.cfg.tooltip.fmt : S.cfg.format;
  }

  // ---------------------------------------------------------------------------
  // Chart helpers
  // ---------------------------------------------------------------------------
  function textWidth (text, size, weight, family) {
    var font = (weight || 400) + ' ' + size + 'px ' + Bc.fontStack(family);
    var k = font + '\u0001' + text;
    var w = S.twCache[k];
    if (w !== undefined) return w;
    if (!S.measureCtx) S.measureCtx = document.createElement('canvas').getContext('2d');
    if (S.measureCtx.font !== font) S.measureCtx.font = font;
    w = S.measureCtx.measureText(String(text)).width;
    if (++S.twCount > 20000) { S.twCache = {}; S.twCount = 0; }
    S.twCache[k] = w;
    return w;
  }

  function niceStep (r) {
    if (!(r > 0) || !isFinite(r)) return 1;
    var e = Math.pow(10, Math.floor(Math.log10(r)));
    var f = r / e;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
  }

  /** Axis range + ticks from the data extent and an axis config (base / max / ticks). */
  function scaleFor (lo, hi, a, opts) {
    opts = opts || {};
    if (!isFinite(lo) || !isFinite(hi)) { lo = 0; hi = 1; }
    var base = opts.forceZero ? 'zero' : a.base;
    if (base === 'zero') {
      lo = Math.min(lo, 0); hi = Math.max(hi, 0);
    } else if (base === 'auto') {
      var range = hi - lo || Math.abs(hi) * 0.2 || 1;
      var pad = Math.max(0, Number(a.padding != null ? a.padding : 20) || 0) / 100 * range;
      if (lo >= 0) lo = Math.max(0, lo - pad);
      else if (hi <= 0) hi = Math.min(0, hi + pad);
      else { lo = Math.min(lo, 0); hi = Math.max(hi, 0); }
    } else {
      lo = Number(a.manualMin) || 0;
      hi = Math.max(hi, lo);
    }
    if (a.maxMode === 'manual' && Number(a.manualMax) > lo) hi = Number(a.manualMax);
    if (opts.maxCap != null) hi = Math.min(hi, opts.maxCap);
    if (hi === lo) hi = lo + 1;
    var count = Math.max(2, Math.min(14, Number(a.ticks) || 5));
    var step = niceStep((hi - lo) / count);
    var min = base === 'manual' ? lo : Math.floor(lo / step + 1e-9) * step;
    var max = a.maxMode === 'manual' ? hi : Math.ceil(hi / step - 1e-9) * step;
    if (opts.exactMax != null) max = opts.exactMax;
    if (max <= min) max = min + step;
    var ticks = [];
    for (var t = Math.ceil(min / step - 1e-9) * step; t <= max + step * 1e-6; t += step) {
      ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
    }
    return { min: min, max: max, step: step, ticks: ticks };
  }

  /** Tick texts, with enough decimals to tell neighbours apart. */
  function tickTexts (ticks, f, opts) {
    var maxTick = Math.max.apply(null, ticks.map(Math.abs).concat([0]));
    var force = f.scale === 'dynamic' ? Bc.pickScale(maxTick, 'dynamic')
      : f.scale === 'percentDynamic' ? Bc.pickScale(f.pctFromRatio ? maxTick * 100 : maxTick, 'dynamic') : null;
    var out;
    var use = Bc.clone(f);
    // decimals needed to write every tick exactly (0.25M, not 0.3M)
    var div = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 }[force] || 1;
    var stp = ticks.length > 1 ? Math.abs(ticks[1] - ticks[0]) / div : 1;
    if (/percent/.test(f.scale) && f.pctFromRatio) stp *= 100;
    var need = 0;
    while (need < 4 && Math.abs(Math.round(stp * Math.pow(10, need)) - stp * Math.pow(10, need)) > 1e-6) need++;
    var startDec = opts && opts.exact ? need : Math.max(need, f.decimals);
    for (var d = startDec; d <= Math.max(startDec, 4); d++) {
      use.decimals = d;
      out = ticks.map(function (t) { return Bc.formatNumber(t, use, { forceScale: force }); });
      var u = {};
      out.forEach(function (t) { u[t] = 1; });
      if (opts && opts.abs) out = ticks.map(function (t) { return Bc.formatNumber(t, use, { forceScale: force, abs: true }); });
      if (Object.keys(u).length === out.length || f.scale === 'workbook') break;
    }
    var zero = Bc.formatNumber(0, Bc.merge(f, { decimals: 0 }), { forceScale: '' });
    return out.map(function (t, i) { return ticks[i] === 0 ? zero : t; });
  }

  function wrapText (text, width, maxLines, size, weight, family) {
    var words = String(text).split(/\s+/).filter(Boolean);
    var lines = [];
    var cur = '';
    for (var i = 0; i < words.length; i++) {
      var tryLine = cur ? cur + ' ' + words[i] : words[i];
      if (textWidth(tryLine, size, weight, family) <= width || !cur) cur = tryLine;
      else { lines.push(cur); cur = words[i]; }
    }
    if (cur) lines.push(cur);
    if (!lines.length) lines = [''];
    if (lines.length > maxLines) {
      lines = lines.slice(0, maxLines);
      lines[maxLines - 1] = ellipsize(lines[maxLines - 1] + '…', width, size, weight, family);
    }
    return lines.map(function (l) { return ellipsize(l, width, size, weight, family); });
  }

  function ellipsize (text, width, size, weight, family) {
    text = String(text);
    if (textWidth(text, size, weight, family) <= width) return text;
    var t = text.replace(/…$/, '');
    while (t.length > 1 && textWidth(t + '…', size, weight, family) > width) t = t.slice(0, -1);
    return t + '…';
  }

  /** Rounded polygon through [x, y, r] points (cubic corners, any orientation). */
  function roundPoly (pts) {
    var n = pts.length;
    var d = '';
    for (var i = 0; i < n; i++) {
      var c = pts[i];
      var p = pts[(i - 1 + n) % n];
      var q = pts[(i + 1) % n];
      var r = c[2] || 0;
      if (Array.isArray(r)) {
        // elliptical corner: [distance along the edge to the previous point, along the edge to the next]
        var ra = r[0]; var rb2 = r[1];
        if (!(ra > 0.3 && rb2 > 0.3)) { d += (i ? 'L' : 'M') + fx(c[0]) + ' ' + fx(c[1]); continue; }
        var la = Math.hypot(p[0] - c[0], p[1] - c[1]);
        var lb = Math.hypot(q[0] - c[0], q[1] - c[1]);
        var ea = [c[0] + (p[0] - c[0]) / la * ra, c[1] + (p[1] - c[1]) / la * ra];
        var eb = [c[0] + (q[0] - c[0]) / lb * rb2, c[1] + (q[1] - c[1]) / lb * rb2];
        var ke = 0.5523;
        d += (i ? 'L' : 'M') + fx(ea[0]) + ' ' + fx(ea[1]) +
          'C' + fx(ea[0] + (c[0] - ea[0]) * ke) + ' ' + fx(ea[1] + (c[1] - ea[1]) * ke) + ' ' +
          fx(eb[0] + (c[0] - eb[0]) * ke) + ' ' + fx(eb[1] + (c[1] - eb[1]) * ke) + ' ' + fx(eb[0]) + ' ' + fx(eb[1]);
        continue;
      }
      if (r > 0.3) {
        var lp = Math.hypot(p[0] - c[0], p[1] - c[1]);
        var lq = Math.hypot(q[0] - c[0], q[1] - c[1]);
        r = Math.min(r, lp / 2, lq / 2);
      }
      if (!(r > 0.3)) { d += (i ? 'L' : 'M') + fx(c[0]) + ' ' + fx(c[1]); continue; }
      var a = [c[0] + (p[0] - c[0]) / Math.hypot(p[0] - c[0], p[1] - c[1]) * r, c[1] + (p[1] - c[1]) / Math.hypot(p[0] - c[0], p[1] - c[1]) * r];
      var b = [c[0] + (q[0] - c[0]) / Math.hypot(q[0] - c[0], q[1] - c[1]) * r, c[1] + (q[1] - c[1]) / Math.hypot(q[0] - c[0], q[1] - c[1]) * r];
      var k = 0.5523;
      d += (i ? 'L' : 'M') + fx(a[0]) + ' ' + fx(a[1]) +
        'C' + fx(a[0] + (c[0] - a[0]) * k) + ' ' + fx(a[1] + (c[1] - a[1]) * k) + ' ' +
        fx(b[0] + (c[0] - b[0]) * k) + ' ' + fx(b[1] + (c[1] - b[1]) * k) + ' ' + fx(b[0]) + ' ' + fx(b[1]);
    }
    return d + 'Z';
  }

  // ---------------------------------------------------------------------------
  // Drawing helpers (geometry comes in a "frame": F.P(t, s) maps t along the
  // bar from its base and s across it to pixels, for either orientation)
  // ---------------------------------------------------------------------------
  function barShape (F, rEnd, rBase, endShape) {
    var len = F.len;
    var w = F.wid;
    var P = F.P;
    var pt = function (t, s, r) { var p = P(t, s); return [p[0], p[1], r || 0]; };
    if (len < 0.75) {
      // zero or tiny value: a hairline so the slot isn't empty
      return roundPoly([pt(-0.5, 0), pt(0.5, 0), pt(0.5, w), pt(-0.5, w)]);
    }
    if (endShape === 'arrow') {
      var d = Math.min(Math.max(2, S.cfg.shape.arrowDepth), len, w * 1.5);
      return roundPoly([pt(0, 0, rBase), pt(len - d, 0), pt(len, w / 2), pt(len - d, w), pt(0, w, rBase)]);
    }
    if (endShape === 'pill' && rEnd > 0 && len < rEnd + rBase) {
      // fully round even when the bar is shorter than it is wide: elliptical ends
      var we = Math.min(rEnd, w / 2);
      var wb = Math.min(rBase, w / 2);
      var le = len * rEnd / (rEnd + rBase);
      var lb = len - le;
      return roundPoly([pt(0, 0, [wb, lb]), pt(len, 0, [le, we]), pt(len, w, [we, le]), pt(0, w, [lb, wb])]);
    }
    var re = Math.max(0, Math.min(rEnd, w / 2, len));
    var rb = Math.max(0, Math.min(rBase, w / 2, Math.max(0, len - re)));
    return roundPoly([pt(0, 0, rb), pt(len, 0, re), pt(len, w, re), pt(0, w, rb)]);
  }

  function rectIn (F, t0, t1, s0, s1) {
    var a = F.P(t0, s0); var b = F.P(t1, s0); var c = F.P(t1, s1); var d = F.P(t0, s1);
    return 'M' + fx(a[0]) + ' ' + fx(a[1]) + 'L' + fx(b[0]) + ' ' + fx(b[1]) + 'L' + fx(c[0]) + ' ' + fx(c[1]) + 'L' + fx(d[0]) + ' ' + fx(d[1]) + 'Z';
  }

  function borderAttrs (color) {
    var B = S.cfg.border;
    if (!B.show) return {};
    var c = B.colorMode === 'bar' ? color : B.colorMode === 'custom' ? B.color : Bc.blend(color, -30);
    return { stroke: c, 'stroke-width': B.width, 'stroke-opacity': B.opacity / 100, 'stroke-dasharray': Bc.dashArray(B.style, B.width), 'stroke-linejoin': 'round' };
  }

  function headSize (lblW, lblH) {
    var LP = S.cfg.lollipop;
    return LP.valueInHead ? Math.max(LP.headSize, Math.max(lblW, lblH) + 6) : LP.head === 'none' ? 0 : LP.headSize;
  }

  function linePath (pts, curve, vert) {
    if (pts.length === 1) return 'M' + pts[0].x + ' ' + pts[0].y;
    var d = 'M' + fx(pts[0].x) + ' ' + fx(pts[0].y);
    if (curve === 'step') {
      for (var i = 1; i < pts.length; i++) {
        var a = pts[i - 1]; var b = pts[i];
        if (vert) { var mx = (a.x + b.x) / 2; d += 'H' + fx(mx) + 'V' + fx(b.y) + 'H' + fx(b.x); } else { var my = (a.y + b.y) / 2; d += 'V' + fx(my) + 'H' + fx(b.x) + 'V' + fx(b.y); }
      }
      return d;
    }
    if (curve === 'smooth') {
      for (var j = 0; j < pts.length - 1; j++) {
        var p0 = pts[Math.max(0, j - 1)]; var p1 = pts[j]; var p2 = pts[j + 1]; var p3 = pts[Math.min(pts.length - 1, j + 2)];
        var t = 0.18;
        d += 'C' + fx(p1.x + (p2.x - p0.x) * t) + ' ' + fx(p1.y + (p2.y - p0.y) * t) + ' ' + fx(p2.x - (p3.x - p1.x) * t) + ' ' + fx(p2.y - (p3.y - p1.y) * t) + ' ' + fx(p2.x) + ' ' + fx(p2.y);
      }
      return d;
    }
    for (var k = 1; k < pts.length; k++) d += 'L' + fx(pts[k].x) + ' ' + fx(pts[k].y);
    return d;
  }

  // ---------------------------------------------------------------------------
  // Icons for dimension members
  // ---------------------------------------------------------------------------
  function iconBox () {
    var IC = S.cfg.icons;
    return IC.bg !== 'none' ? Math.round(IC.size * 1.55) : IC.size;
  }

  function iconSpec (n, b) {
    var IC = S.cfg.icons;
    var mem = B.memberOf(n, b, IC.by || 'auto');
    var spec = mem != null ? IC.members[mem] : null;
    if (!spec && IC.fallback) spec = { source: 'builtin', builtinId: IC.fallback };
    if (!spec || (spec.source !== 'builtin' && !spec.dataUrl)) return null;
    return spec;
  }

  // ---------------------------------------------------------------------------
  // Labels: text, placement, collisions
  // ---------------------------------------------------------------------------
  function badgePad (badge, size) {
    switch (badge) {
      case 'pill': case 'rounded': case 'tag': return { x: size * 0.6, y: size * 0.28 };
      case 'circle': case 'ring': case 'hexagon': return { x: size * 0.45, y: size * 0.45 };
      case 'diamond': return { x: size * 0.55, y: size * 0.55 };
      default: return { x: 0, y: 0 };
    }
  }

  function boxLabel (text, size, weight, family, badge) {
    var pad = badgePad(badge, size);
    var w = textWidth(text, size, weight, family) + pad.x * 2;
    var h = size * 1.25 + pad.y * 2;
    if (badge === 'circle' || badge === 'ring' || badge === 'hexagon' || badge === 'diamond') { w = h = Math.max(w, h); }
    return { text: String(text), size: size, weight: weight, family: family, badge: badge || 'none', w: w, h: h, x: 0, y: 0, prio: 0 };
  }

  /** Places a label on a bar frame: outsideEnd | insideEnd | center | insideBase | column. */
  function placeOn (lbl, F, place, off) {
    var along = F.vert ? lbl.h : lbl.w;
    var t;
    if (place === 'insideEnd') t = F.len - off - along / 2;
    else if (place === 'insideBase') t = off + along / 2;
    else if (place === 'center') t = F.len / 2;
    else t = F.len + off + along / 2;
    var p = F.P(t, F.wid / 2);
    lbl.x = p[0]; lbl.y = p[1];
    lbl.F = F; lbl.t = t; lbl.place = place;
    return lbl;
  }

  function shiftAlong (l, d) {
    if (!l.F) return;
    l.t += d;
    var p = l.F.P(l.t, l.F.wid / 2);
    l.x = p[0]; l.y = p[1];
  }

  function labelText (v, b) {
    var LB = S.cfg.labels;
    var f = fmtOf(LB.fmt);
    var n = b.node;
    var value = function () { return Bc.formatNumber(b.v, f, { fv: b.count === 1 ? b.fv : null, signed: true }); };
    var catSum = n.bars.reduce(function (a, x) { return a + Math.abs(x.v); }, 0) || 1;
    var tot = v.totalsBySeries[b.s.key] || 1;
    switch (LB.content) {
      case 'pctTotal': return Bc.formatNumber(b.v / tot, pctFmt(f));
      case 'pctCat': return Bc.formatNumber(b.v / catSum, pctFmt(f));
      case 'valuePct': return value() + ' (' + Bc.formatNumber(v.visSeries.length > 1 ? b.v / catSum : b.v / tot, pctFmt(f)) + ')';
      case 'diffPrev': return b.prev ? Bc.formatNumber(b.v - b.prev.v, Bc.merge(f, { plusSign: true }), { signed: true }) : '';
      case 'pctDiffPrev': return b.prev && b.prev.v ? Bc.formatNumber((b.v - b.prev.v) / Math.abs(b.prev.v), Bc.merge(pctFmt(f), { plusSign: true }), { signed: true }) : '';
      case 'rank': return '#' + rankOf(v, b);
      case 'nameValue': return n.label + ': ' + value();
      default: return value();
    }
  }

  function rankOf (v, b) {
    var vals = v.nodes.map(function (n) { var x = n.bars.find(function (y) { return y.s.key === b.s.key; }); return x ? x.v : -Infinity; });
    vals.sort(function (a, c) { return c - a; });
    return vals.indexOf(b.v) + 1;
  }

  function sumSide (n, sign) {
    return n.bars.reduce(function (a, b) { return a + ((b.shown >= 0) === (sign > 0) ? b.v : 0); }, 0);
  }

  function totalText (v, n) {
    return Bc.formatNumber(n.bars.reduce(function (a, b) { return a + b.v; }, 0), fmtOf(S.cfg.labels.totalFmt));
  }

  function wantLabel (v, n, b) {
    var w = S.cfg.labels.which;
    if (w === 'all') return true;
    if (!v._which) {
      v._which = {};
      v.visSeries.forEach(function (s) {
        var bars = [];
        v.nodes.forEach(function (x) { x.bars.forEach(function (y) { if (y.s.key === s.key) bars.push(y); }); });
        if (!bars.length) return;
        var mn = bars[0]; var mx = bars[0];
        bars.forEach(function (y) { if (y.v < mn.v) mn = y; if (y.v > mx.v) mx = y; });
        v._which[s.key] = { min: mn, max: mx, first: bars[0], last: bars[bars.length - 1] };
      });
    }
    var o = v._which[b.s.key];
    if (!o) return false;
    if (w === 'minmax') return b === o.min || b === o.max;
    return b === o[w];
  }

  function barLabel (v, b, F, place, item, family, inner) {
    var LB = S.cfg.labels;
    var text = labelText(v, b);
    var lbl = boxLabel(text, LB.size, LB.weight, family, LB.badge);
    lbl.italic = LB.italic;
    lbl.prio = Math.abs(b.v);
    lbl.item = item;
    lbl.barColor = b.color;
    lbl.key = 'c:' + rootLabel(b.node) + '|s:' + b.s.key;
    if (!text) { lbl.hidden = true; return lbl; }
    var off = LB.offset;
    if (v.style === 'lollipop' && (place === 'outsideEnd')) off += headSize(0, 0) / 2;
    var along = F.vert ? lbl.h : lbl.w;
    var across = F.vert ? lbl.w : lbl.h;
    var inside = place === 'insideEnd' || place === 'insideBase' || place === 'center';
    if (inside && v.style === 'lollipop') { place = 'outsideEnd'; inside = false; off += headSize(0, 0) / 2; }
    if (inside && (along + 2 * Math.min(off, 4) > F.len || across > F.wid + 4)) {
      if (LB.insideFallback && !inner) { place = 'outsideEnd'; inside = false; } else { lbl.hidden = true; }
    }
    placeOn(lbl, F, place, off);
    var badgeFill = LB.badge === 'none' ? null : LB.badgeFill === 'white' ? '#FFFFFF' : LB.badgeFill === 'custom' ? LB.badgeColor : b.color;
    lbl.bgFill = badgeFill;
    lbl.bgStroke = badgeFill && (LB.badgeBorder || LB.badge === 'ring') ? (LB.badgeFill === 'bar' ? Bc.blend(b.color, -18) : b.color) : null;
    if (LB.badge === 'ring') { lbl.bgFill = '#FFFFFF'; lbl.bgStroke = b.color; }
    var m = LB.colorMode;
    if (lbl.bgFill) lbl.fill = m === 'custom' ? LB.color : m === 'blend' ? Bc.blend(b.color, LB.blend) : (lbl.bgFill === '#FFFFFF' ? Bc.readable(b.color) : Bc.contrastText(lbl.bgFill));
    else if (m === 'bar') lbl.fill = b.color;
    else if (m === 'blend') lbl.fill = Bc.blend(b.color, LB.blend);
    else if (m === 'custom') lbl.fill = LB.color;
    else lbl.fill = inside && v.style !== 'progress' ? Bc.contrastText(b.color) : inside ? Bc.contrastText(b.color) : Bc.readable(b.color);
    if (inside && v.style === 'progress' && place === 'insideBase') lbl.fill = m === 'auto' ? Bc.contrastText(b.color) : lbl.fill;
    return lbl;
  }

  function resolveLabels (labels, W, H) {
    var mode = S.cfg.labels.overlap;
    var placed = [];
    var list = labels.filter(function (l) { return !l.hidden; });
    list.sort(function (a, b) { return (b.prio || 0) - (a.prio || 0); });
    var scales = mode === 'shrink' ? [1, 0.86, 0.74] : [1];
    list.forEach(function (l) {
      var ok = false;
      for (var i = 0; i < scales.length && !ok; i++) {
        var s = scales[i];
        var box = { x0: l.x - l.w * s / 2 - 1, x1: l.x + l.w * s / 2 + 1, y0: l.y - l.h * s / 2 - 1, y1: l.y + l.h * s / 2 + 1 };
        var inBounds = box.x0 >= -4 && box.x1 <= W + 4 && box.y0 >= -4 && box.y1 <= H + 4;
        var clash = mode !== 'none' && placed.some(function (p) { return box.x0 < p.x1 && box.x1 > p.x0 && box.y0 < p.y1 && box.y1 > p.y0; });
        if (inBounds && !clash) { ok = true; l.scale = s; placed.push(box); }
      }
      if (!ok) l.hidden = true;
    });
  }

  // ---------------------------------------------------------------------------
  // Misc helpers used by drawChart
  // ---------------------------------------------------------------------------

  function maxCatLabelW (v) {
    var AC = S.cfg.axisC;
    return Math.max.apply(null, v.nodes.map(function (n) { return textWidth(n.label, AC.size, AC.weight, AC.font); }).concat([10]));
  }

  function groupRuns (nodes) {
    var runs = [];
    var cur = null;
    nodes.forEach(function (n, i) {
      var id = n.grp ? n.grp.id : null;
      if (!cur || cur.id !== id) {
        cur = { id: id, grp: n.grp, i0: i, i1: i, i: runs.length };
        runs.push(cur);
        n.runStart = true;
      } else {
        cur.i1 = i;
        n.runStart = false;
      }
      n.run = cur;
    });
    return runs;
  }

  function labelStep (nodes, slot, vert) {
    var AC = S.cfg.axisC;
    if (!AC.hideLabelsAuto || !(slot > 0)) return 1;
    if (vert) {
      var need = AC.orientation === 'wrap' ? AC.size * 2.4 : AC.size * 1.3;
      return Math.max(1, Math.ceil(need / slot));
    }
    return Math.max(1, Math.ceil(AC.size * 1.15 / slot));
  }

  /** Progress bars: the value each bar fills up to. */
  function progressMaxFn (v) {
    var PR = S.cfg.progress;
    var maxV = 0;
    var totV = 0;
    var inUnit = true;
    v.nodes.forEach(function (n) { n.bars.forEach(function (b) { maxV = Math.max(maxV, b.shown); if (b.shown > 0) totV += b.shown; if (Math.abs(b.shown) > 1.0001) inUnit = false; }); });
    var dKey = null;
    if (PR.max === 'detail' && S.raw) {
      var dms = (S.raw.extras || []).filter(function (x) { return !x.dim; });
      var hit = dms.filter(function (x) { return x.key === PR.detailField; })[0] || dms[0];
      dKey = hit ? hit.key : null;
    }
    var mode = PR.max;
    var f = S.cfg.format;
    if (mode === 'auto') mode = inUnit ? 'one' : (maxV <= 100 && /percent/.test(f.scale) && !f.pctFromRatio) ? 'hundred' : 'max';
    if (mode === 'percent') mode = inUnit ? 'one' : 'hundred';
    return function (n) {
      switch (mode) {
        case 'one': return 1;
        case 'hundred': return 100;
        case 'target': return isFinite(n.t) && n.t > 0 ? n.t : maxV;
        case 'total': return totV > 0 ? totV : maxV;
        case 'detail': var dv = dKey && n.x ? n.x[dKey] : NaN; return isFinite(dv) && dv > 0 ? dv : maxV;
        case 'fixed': return Number(PR.fixed) || maxV;
        default: return maxV;
      }
    };
  }

  function refValues (v) {
    var out = [];
    (S.cfg.refs || []).forEach(function (r0, ri) {
      var r = Bc.refCfg(r0);
      if (!r.show || S.state.off['r:' + ri]) return;
      var vals = [];
      v.nodes.forEach(function (n) {
        if (v.layout === 'stacked' || v.layout === 'stacked100') { vals.push(n.stackPos + n.stackNeg); return; }
        n.bars.forEach(function (b) {
          if (r.scope && r.scope.indexOf('series:') === 0 && 'series:' + b.s.key !== r.scope) return;
          vals.push(b.shown);
        });
      });
      var a = refCalc(r.type, vals, r);
      if (!isFinite(a)) return;
      var b = r.bandTo ? refCalc(r.bandTo, vals, r) : a;
      out.push({ cfg: r, a: a, b: isFinite(b) ? b : a, band: !!r.bandTo && isFinite(b) });
    });
    return out;
  }

  function refCalc (type, vals, r) {
    if (type === 'constant') return Number(r.value);
    if (!vals.length) return NaN;
    var s = vals.slice().sort(function (a, b) { return a - b; });
    var sum = s.reduce(function (a, b) { return a + b; }, 0);
    var q = function (p) { var i = (s.length - 1) * p; var lo = Math.floor(i); var hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
    switch (type) {
      case 'average': return sum / s.length;
      case 'median': return q(0.5);
      case 'min': return s[0];
      case 'max': return s[s.length - 1];
      case 'percentile': return q(Math.max(0, Math.min(100, r.percentile)) / 100);
      case 'total': return sum;
      default: return NaN;
    }
  }

  // ---------------------------------------------------------------------------
  // Comments on bars
  // ---------------------------------------------------------------------------
  function commentsOf (n) { return (S.cfg.comments.items && S.cfg.comments.items[n.key]) || []; }

  // Called from the other chart files as B.<name>(…).
  B.defaultTitle = defaultTitle;
  B.iconTarget = iconTarget;
  B.legendItems = legendItems;
  B.capLegend = capLegend;
  B.lineColor = lineColor;
  B.refName = refName;
  B.fmtOf = fmtOf;
  B.lineFmt = lineFmt;
  B.tipFmt = tipFmt;
  B.textWidth = textWidth;
  B.scaleFor = scaleFor;
  B.tickTexts = tickTexts;
  B.wrapText = wrapText;
  B.ellipsize = ellipsize;
  B.barShape = barShape;
  B.rectIn = rectIn;
  B.borderAttrs = borderAttrs;
  B.headSize = headSize;
  B.linePath = linePath;
  B.iconBox = iconBox;
  B.iconSpec = iconSpec;
  B.badgePad = badgePad;
  B.boxLabel = boxLabel;
  B.placeOn = placeOn;
  B.shiftAlong = shiftAlong;
  B.labelText = labelText;
  B.sumSide = sumSide;
  B.totalText = totalText;
  B.wantLabel = wantLabel;
  B.barLabel = barLabel;
  B.resolveLabels = resolveLabels;
  B.maxCatLabelW = maxCatLabelW;
  B.groupRuns = groupRuns;
  B.labelStep = labelStep;
  B.progressMaxFn = progressMaxFn;
  B.refValues = refValues;
  B.commentsOf = commentsOf;
  // ---------------------------------------------------------------------------
  // Dated event markers (Gridlines & Target tab → Events)
  // ---------------------------------------------------------------------------
  /** Start of the bucket after the one starting at `d` (ms), given the step from the bucket before. */
  function bucketEnd (d, prev) {
    var day = 86400000;
    var dt = new Date(d);
    if (prev == null) return d + day;
    var gap = Math.round((d - prev) / day);
    var months = gap >= 28 && gap <= 31 ? 1 : gap >= 89 && gap <= 92 ? 3 : gap >= 181 && gap <= 184 ? 6 : gap >= 365 && gap <= 366 ? 12 : 0;
    if (months && dt.getDate() === 1) return new Date(dt.getFullYear(), dt.getMonth() + months, 1).getTime();
    return d + (d - prev);
  }

  /**
   * The events to draw in a view: [{ i (index in v.nodes), date (ms), text, label, color }].
   * Only with a date axis; an event belongs to the bar whose date bucket (from its own date to the next
   * bar's date) holds the event date; events before the first or after the last bucket are left out.
   */
  function eventMarks (v) {
    var EV = S.cfg.events;
    if (!EV || EV.show === false || !EV.items || !EV.items.length || v.axisType !== 'date') return [];
    var dates = [];
    v.nodes.forEach(function (n) { if (n.depth === 0 && n.date != null && dates.indexOf(n.date) < 0) dates.push(n.date); });
    if (!dates.length) return [];
    dates.sort(function (a, b) { return a - b; });
    var out = [];
    var used = {};
    EV.items.forEach(function (it) {
      var m = it && /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(it.date || '').trim());
      if (!m) return;
      var t = new Date(+m[1], +m[2] - 1, +m[3]).getTime();
      var k = -1;
      for (var j = 0; j < dates.length; j++) {
        var end = j + 1 < dates.length ? dates[j + 1] : bucketEnd(dates[j], j ? dates[j - 1] : null);
        if (t >= dates[j] && t < end) { k = j; break; }
      }
      if (k < 0) return;
      var idx = -1;
      for (var q = 0; q < v.nodes.length; q++) { if (v.nodes[q].depth === 0 && v.nodes[q].date === dates[k]) { idx = q; break; } }
      if (idx < 0) return;
      var key = idx + '|' + t + '|' + (it.label || '');
      if (used[key]) return;
      used[key] = 1;
      out.push({ i: idx, date: t, dateText: m[0], text: String(it.label || ''), color: it.color || EV.color });
    });
    return out;
  }
  B.eventMarks = eventMarks;
})();
