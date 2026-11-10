/**
 * Bar Chart: the svg plot. drawChart() and the helpers that create svg nodes (bars, lollipops,
 * segments, axis breaks, markers, member icons, labels, comments).
 *
 * Only drawing: data comes from the view (chart-data.js), maths from chart-layout.js, and the
 * hit areas recorded in S.drawn are used by chart-interact.js.
 */
'use strict';

(function () {
  const B = window.BcChart, S = B.S; // shared namespace and mutable state, see chart-state.js
  // Constants and pure helpers from chart-state.js (loaded first, so safe to copy here).
  var SVGNS = B.SVGNS, fx = B.fx, rootLabel = B.rootLabel;

  function node (tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] != null && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  function lineAttrs (l) {
    return { stroke: l.color, 'stroke-width': l.width, 'stroke-dasharray': Bc.dashArray(l.style, l.width), 'shape-rendering': 'crispEdges' };
  }

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------
  /**
   * Draws one chart. opts (small multiples): svg / W / H of a panel, append (keep the
   * other panels' hit areas), extentOnly (just return the value range), extent
   * (use this value range, so panels share one axis).
   */
  function drawChart (v, opts) {
    opts = opts || {};
    var svg = opts.svg || B.S.el.svg;
    if (!opts.extentOnly) {
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      if (!opts.append) { B.S.drawn = []; B.S.catRefs = []; }
    }
    var W = Math.max(1, opts.W || B.S.el.plot.clientWidth);
    var H = Math.max(1, opts.H || B.S.el.plot.clientHeight);
    if (!opts.extentOnly) svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (!opts.extentOnly && (W < 40 || H < 40)) return;
    var firstItem = B.S.drawn.length;

    var vert = B.S.cfg.chart.orientation !== 'horizontal';
    var family = B.S.cfg.numbers.font;
    var nodes = v.nodes;
    var N = nodes.length;
    var S = v.visSeries;
    var K = Math.max(1, S.length);
    var lay = v.layout;
    var style = v.style;
    var stacked = lay === 'stacked' || lay === 'stacked100' || lay === 'diverging';
    var sideBySide = lay === 'regular' && K > 1;
    var overlap = lay === 'overlap';
    var AV = B.S.cfg.axisV;
    var AC = B.S.cfg.axisC;
    var LB = B.S.cfg.labels;
    var IC = B.S.cfg.icons;
    var G = B.S.cfg.groups;
    // Show bars / Show lines (Bars and Line Chart tabs)
    var showBars = B.S.cfg.chart.showBars !== false;
    var lines = B.S.cfg.chart.showLines === false ? [] : B.S.raw.lines.filter(function (l) { return !B.S.state.off['l:' + l.key]; });
    var centerDiv = lay === 'diverging' && B.S.cfg.diverging.labels === 'center';
    // no grow animation for big charts: hundreds of animated bars make every refresh feel slow
    var animate = B.S.state.animate && B.S.cfg.chart.animate && nodes.length * Math.max(1, v.visSeries.length) <= 300;
    svg.classList.toggle('animate', !!animate);
    svg.style.setProperty('--ms', Math.max(0, B.S.cfg.chart.animMs) + 'ms');
    svg.style.setProperty('--dim', String(Math.max(5, Math.min(100, B.S.cfg.hover.dimOpacity)) / 100));

    // ---- value extent ------------------------------------------------------
    var lo = Infinity;
    var hi = -Infinity;
    var trackMax = B.progressMaxFn(v);
    if (showBars) nodes.forEach(function (n) {
      if (stacked) { lo = Math.min(lo, n.stackNeg); hi = Math.max(hi, n.stackPos); }
      n.bars.forEach(function (b) {
        if (!stacked) { lo = Math.min(lo, b.shown); hi = Math.max(hi, b.shown); }
        if (style === 'progress') hi = Math.max(hi, trackMax(n, b));
      });
      if (B.targetInfo() && !v.noTarget && !B.S.state.off['t:'] && B.S.cfg.target.show && B.S.cfg.target.style !== 'none' && isFinite(n.t) && lay !== 'stacked100') {
        lo = Math.min(lo, n.t); hi = Math.max(hi, n.t);
      }
    });
    if (lo === Infinity) { lo = 0; hi = 1; }
    var refVals = B.refValues(v);
    refVals.forEach(function (r) { lo = Math.min(lo, r.a, r.b); hi = Math.max(hi, r.a, r.b); });
    // bars hidden: the lines use the main axis
    var lineShared = lines.length && (B.S.cfg.lineAxis.mode === 'shared' || !showBars);
    if (lineShared) nodes.forEach(function (n) { lines.forEach(function (l) { if (isFinite(n.l[l.key])) { lo = Math.min(lo, n.l[l.key]); hi = Math.max(hi, n.l[l.key]); } }); });
    if (opts.extentOnly) {
      var elo = Infinity; var ehi = -Infinity; // the lines' own range, so panels can share the line axis too
      nodes.forEach(function (n) { lines.forEach(function (l) { var x = n.l[l.key]; if (isFinite(x)) { elo = Math.min(elo, x); ehi = Math.max(ehi, x); } }); });
      return { lo: lo, hi: hi, llo: elo, lhi: ehi };
    }
    if (opts.extent) { lo = Math.min(lo, opts.extent.lo); hi = Math.max(hi, opts.extent.hi); }
    var aCfg = AV;
    var sopts = {};
    if (style === 'progress' || lay === 'stacked100') sopts.forceZero = true;
    if (lay === 'stacked100') { aCfg = Bc.merge(AV, { maxMode: 'auto' }); sopts.exactMax = hi > 0 ? 1 : 0; lo = Math.min(lo, 0); }
    if (lay === 'diverging' && B.S.cfg.diverging.symmetric) { var mm = Math.max(Math.abs(lo), Math.abs(hi)); lo = -mm; hi = mm; }
    var sc = B.scaleFor(lo, hi, aCfg, sopts);
    if (lay === 'stacked100' && lo < 0) sc = B.scaleFor(-1, 1, aCfg, { forceZero: true });
    if (lay === 'diverging' && B.S.cfg.diverging.symmetric) {
      var m2 = Math.max(Math.abs(sc.min), Math.abs(sc.max));
      sc = B.scaleFor(-m2, m2, Bc.merge(aCfg, { base: 'zero', maxMode: 'auto' }), {});
    }
    var span = sc.max - sc.min || 1;

    // ---- axis number formats ------------------------------------------------
    var af = B.S.cfg.format;
    if (lay === 'stacked100') af = Bc.merge(af, { scale: 'percent', pctFromRatio: true, decimals: 0, unit: '' });
    var tickText = B.tickTexts(sc.ticks, af, { abs: lay === 'diverging', exact: true });
    var vSize = AV.size;
    var tickThick = 0;
    if (AV.show) {
      tickThick = vert
        ? Math.max.apply(null, tickText.map(function (t) { return B.textWidth(t, vSize, AV.weight, AV.font); })) + 8
        : vSize + 8;
    }
    var vTitle = AV.show && AV.title ? AV.size + 8 : 0;

    // secondary line axis
    var lsc = null;
    var lTick = [];
    var lThick = 0;
    var LA = B.S.cfg.lineAxis;
    if (lines.length && !lineShared) {
      var llo = Infinity; var lhi = -Infinity;
      nodes.forEach(function (n) { lines.forEach(function (l) { var x = n.l[l.key]; if (isFinite(x)) { llo = Math.min(llo, x); lhi = Math.max(lhi, x); } }); });
      if (opts.extent && isFinite(opts.extent.llo)) { llo = Math.min(llo, opts.extent.llo); lhi = Math.max(lhi, opts.extent.lhi); }
      lsc = LA.sync ? sc : B.scaleFor(llo, lhi, Bc.merge(LA, { ticks: sc.ticks.length - 1 }), {});
      var lf = LA.useGlobalFormat ? B.S.cfg.format : LA.fmt;
      lTick = B.tickTexts(lsc.ticks, lf, { exact: LA.useGlobalFormat });
      if (LA.show) {
        lThick = vert ? Math.max.apply(null, lTick.map(function (t) { return B.textWidth(t, LA.size, 400, AV.font); })) + 8 : LA.size + 8;
        if (LA.title) lThick += LA.size + 6;
      }
    }

    // ---- reserves at the bar ends (outside labels, heads, icons, notes) -------
    var lblPad = B.badgePad(LB.badge, LB.size);
    var sampleTexts = [];
    nodes.forEach(function (n) { n.bars.forEach(function (b) { sampleTexts.push(B.labelText(v, b)); }); });
    if (stacked && LB.totals) nodes.forEach(function (n) { sampleTexts.push(B.totalText(v, n)); });
    var lblW = LB.show ? Math.max(0, Math.max.apply(null, sampleTexts.map(function (t) { return B.textWidth(t, LB.size, LB.weight, family); }).concat([0])) + lblPad.x * 2) : 0;
    var lblH = LB.show ? LB.size * 1.25 + lblPad.y * 2 : 0;
    if (LB.badge === 'circle' || LB.badge === 'ring' || LB.badge === 'hexagon' || LB.badge === 'diamond') { lblW = lblH = Math.max(lblW, lblH) * (LB.badge === 'diamond' ? 1.25 : 1); }
    var outsideLbl = LB.show && (LB.position === 'outsideEnd' || (LB.insideFallback && LB.position !== 'column')) && !(style === 'lollipop' && B.S.cfg.lollipop.valueInHead);
    var endRes = 4;
    if (outsideLbl) endRes += (vert ? lblH : lblW) + LB.offset;
    if (stacked && LB.show && LB.totals) endRes = Math.max(endRes, 4 + (vert ? LB.totalSize * 1.3 : lblW) + LB.offset);
    if (style === 'lollipop') {
      var hs = B.headSize(lblW, lblH);
      endRes += hs / 2;
      if (B.S.cfg.lollipop.valueInHead) endRes = Math.max(endRes, hs + 4);
    }
    if (IC.show && IC.placement === 'outside') endRes += B.iconBox() + IC.gap;
    if (AC.show && AC.placement === 'above') endRes += vert ? AC.size * 1.3 + 4 : B.maxCatLabelW(v) + 8;
    if (B.S.cfg.comments.show && Object.keys(B.S.cfg.comments.items).length) endRes += 6;
    var colRes = 0;
    if (LB.show && LB.position === 'column') colRes = (vert ? lblH : lblW) + 10;
    var hasNeg = lo < 0 && !(lay === 'diverging' && centerDiv);
    var negRes = hasNeg ? endRes : 4;
    var posRes = hi > 0 ? endRes + colRes : 4;
    if (lay === 'diverging') { negRes = endRes; posRes = endRes; }

    // ---- category label / icon / group sizes ---------------------------------
    var axisLabels = AC.show && (AC.placement === 'axis' || AC.placement === 'pill');
    var axisIcons = IC.show && IC.placement === 'axis';
    var runs = B.groupRuns(nodes);
    var showGroups = runs.some(function (r) { return r.grp; }) && G.mode !== 'none';
    var nGapRuns = 0;
    runs.forEach(function (r, i) { if (i > 0 && (r.grp || runs[i - 1].grp)) nGapRuns++; });
    var groupGapPx = showGroups ? Math.max(0, B.S.cfg.spacing.groupGap) : 0;

    var M = { l: 4, r: 4, t: 4, b: 4 }; // margins around the plot
    var catLabelThick = 0;
    var iconThick = axisIcons ? B.iconBox() + IC.gap + (IC.accent ? 6 : 0) : 0;
    var groupThick = 0;
    var catTitle = AC.show && AC.title ? AC.size + 8 : 0;
    var xl = []; // category label lines
    var slot;
    var Lc;

    if (vert) {
      // value axis left/right
      var vOnLeft = AV.position !== 'opposite';
      if (vOnLeft) { M.l += tickThick + vTitle; M.r += lThick; } else { M.r += tickThick + vTitle; M.l += lThick; }
      Lc = Math.max(10, W - M.l - M.r);
      slot = (Lc - nGapRuns * groupGapPx) / Math.max(1, N);
      if (axisLabels) {
        var lh = Math.round(AC.size * 1.25);
        if (AC.orientation === 'wrap') {
          xl = nodes.map(function (n) { return B.wrapText(n.label, Math.max(12, slot * 0.96), Math.max(1, AC.maxLines), AC.size, AC.weight, AC.font); });
          catLabelThick = Math.max.apply(null, xl.map(function (ls) { return ls.length; })) * lh + 6;
          if (AC.placement === 'pill') catLabelThick += 8;
        } else {
          var maxLen = Math.max(30, Math.min(H * 0.3, 160));
          xl = nodes.map(function (n) { return [B.ellipsize(n.label, maxLen, AC.size, AC.weight, AC.font)]; });
          var longest = Math.max.apply(null, xl.map(function (ls) { return B.textWidth(ls[0], AC.size, AC.weight, AC.font); }));
          catLabelThick = (AC.orientation === 'angled' ? longest * Math.SQRT1_2 + AC.size : longest) + 10;
        }
      }
      if (showGroups) groupThick = 8 + G.lineWidth + G.size + 6;
      var bottomStuff = catLabelThick + iconThick + groupThick + catTitle;
      if (centerDiv) bottomStuff = iconThick + groupThick + catTitle;
      if (AC.position === 'opposite') M.t += bottomStuff; else M.b += bottomStuff;
    } else {
      var vOnBottom = AV.position !== 'opposite';
      if (vOnBottom) { M.b += tickThick + vTitle; M.t += lThick; } else { M.t += tickThick + vTitle; M.b += lThick; }
      Lc = Math.max(10, H - M.t - M.b);
      slot = (Lc - nGapRuns * groupGapPx) / Math.max(1, N);
      if (axisLabels) {
        var maxW = AC.maxWidth > 0 ? AC.maxWidth : W * 0.36;
        var lw = Math.min(maxW, B.maxCatLabelW(v) + (AC.placement === 'pill' ? 16 : 0));
        catLabelThick = Math.ceil(lw) + 8;
        var lines2 = Math.max(1, Math.min(AC.maxLines, Math.floor(slot / (AC.size * 1.2)) || 1));
        xl = nodes.map(function (n) { return B.wrapText(n.label, lw - (AC.placement === 'pill' ? 16 : 0), lines2, AC.size, AC.weight, AC.font); });
      }
      if (showGroups) {
        var gw = Math.max.apply(null, runs.filter(function (r) { return r.grp; }).map(function (r) { return B.textWidth(r.grp.label, G.size, G.weight, family); }).concat([0]));
        groupThick = Math.min(W * 0.24, gw) + 10 + G.lineWidth + 6;
      }
      var leftStuff = (centerDiv ? 0 : catLabelThick) + iconThick + groupThick + catTitle;
      if (AC.position === 'opposite') M.r += leftStuff; else M.l += leftStuff;
    }

    var px0 = M.l; var px1 = W - M.r; var py0 = M.t; var py1 = H - M.b;
    if (px1 - px0 < 20 || py1 - py0 < 20) return;

    // ---- coordinate helpers ---------------------------------------------------
    // c: position along the category axis; value pixels along the other one.
    var cOrigin = vert ? px0 : py0;
    var vA = vert ? py1 : px0; // pixel of the low end
    var vB = vert ? py0 : px1; // pixel of the high end
    var vLo = vert ? vA - negRes : vA + negRes;
    var vHi = vert ? vB + posRes : vB - posRes;
    if (AV.reversed) { var tmp = vLo; vLo = vHi; vHi = tmp; }
    var cGap = 0;
    var centerL = 0; var centerR = 0;
    if (centerDiv) {
      cGap = catLabelThick;
      var mid = (vLo + vHi) / 2;
      var sgn = vHi > vLo ? 1 : -1;
      centerL = mid - sgn * cGap / 2;
      centerR = mid + sgn * cGap / 2;
    }
    function vpx (val) {
      if (centerDiv) {
        var m = Math.max(Math.abs(sc.min), Math.abs(sc.max)) || 1;
        return val < 0 ? centerL + (val / m) * (centerL - vLo) : centerR + (val / m) * (vHi - centerR);
      }
      return vLo + (val - sc.min) / span * (vHi - vLo);
    }
    function vpxc (val) { return vpx(Math.max(sc.min, Math.min(sc.max, val))); }
    function vbase (val) {
      if (centerDiv) return val < 0 ? centerL : centerR;
      return vpxc(0);
    }
    function XY (c, p) { return vert ? [c, p] : [p, c]; }

    // slot positions (with gaps between groups)
    var cStart = [];
    var acc = cOrigin;
    nodes.forEach(function (n, i) {
      if (i > 0 && showGroups && n.runStart && (n.run.grp || runs[n.run.i - 1].grp)) acc += groupGapPx;
      cStart.push(acc);
      acc += slot;
    });

    // bar widths
    var SP = B.S.cfg.spacing;
    var band = SP.widthMode === 'px' ? Math.min(slot, SP.px * (sideBySide ? K : 1) + (sideBySide ? (K - 1) * SP.seriesGap : 0)) : slot * Math.max(5, Math.min(100, SP.width)) / 100;
    var barW;
    var off = Math.max(0, Math.min(100, B.S.cfg.chart.overlapOffset)) / 100;
    if (sideBySide) barW = Math.max(1, (band - (K - 1) * SP.seriesGap) / K);
    else if (overlap) barW = Math.max(1, band / (1 + (K - 1) * off));
    else barW = SP.widthMode === 'px' ? Math.min(slot, SP.px) : band;
    if (sideBySide && SP.widthMode === 'px') barW = Math.min(SP.px, barW);

    function barSpan (i, b) {
      var cs = cStart[i];
      var bandStart = cs + (slot - band) / 2;
      if (sideBySide) {
        var used = K * barW + (K - 1) * SP.seriesGap;
        var st = cs + (slot - used) / 2 + b.si * (barW + SP.seriesGap);
        return [st, st + barW];
      }
      if (overlap) {
        var st2 = bandStart + b.si * barW * off;
        return [st2, st2 + barW];
      }
      var st3 = cs + (slot - barW) / 2;
      return [st3, st3 + barW];
    }

    // ---- layers ----------------------------------------------------------------
    var defs = node('defs');
    svg.appendChild(defs);
    var L = {};
    ['back', 'grid', 'track', 'bars', 'refs', 'targets', 'lines', 'axes', 'labels', 'icons', 'notes'].forEach(function (k) {
      L[k] = node('g', { class: 'layer-' + k });
      svg.appendChild(L[k]);
    });
    var SH = B.S.cfg.shadow;
    if (SH.show) {
      var f = node('filter', { id: 'bc-shadow', x: '-30%', y: '-30%', width: '160%', height: '160%' });
      f.appendChild(node('feDropShadow', { dx: SH.dx, dy: SH.dy, stdDeviation: Math.max(0, SH.blur) / 2, 'flood-color': SH.color, 'flood-opacity': Math.max(0, Math.min(100, SH.opacity)) / 100 }));
      defs.appendChild(f);
      L.bars.setAttribute('filter', 'url(#bc-shadow)');
    }

    var plotC0 = cOrigin;
    var plotC1 = cOrigin + Lc;
    var valueLine = function (p, g, attrs) {
      var a = XY(plotC0, p); var b = XY(plotC1, p);
      g.appendChild(node('line', Object.assign({ x1: a[0], y1: a[1], x2: b[0], y2: b[1] }, attrs)));
    };

    // group bands
    if (showGroups && G.band) {
      runs.forEach(function (r) {
        if (!r.grp) return;
        var c0 = cStart[r.i0]; var c1 = cStart[r.i1] + slot;
        var x = vert ? c0 : px0; var y = vert ? py0 : c0;
        L.back.appendChild(node('rect', { x: x, y: y, width: vert ? c1 - c0 : px1 - px0, height: vert ? py1 - py0 : c1 - c0, fill: r.grp.color, 'fill-opacity': G.bandOpacity / 100 }));
      });
    }

    // value gridlines + ticks
    var LN = B.S.cfg.lines;
    sc.ticks.forEach(function (t, k) {
      var p = Math.round(vpx(t)) + 0.5;
      if (LN.valueGrid.show && !(t === 0 && LN.zero.show)) valueLine(p, L.grid, lineAttrs(LN.valueGrid));
      if (centerDiv && t !== 0) { var p2 = Math.round(vpx(-t)) + 0.5; if (LN.valueGrid.show) valueLine(p2, L.grid, lineAttrs(LN.valueGrid)); }
      if (AV.show) {
        var attrs = { 'font-size': vSize, 'font-weight': AV.weight, fill: AV.color, 'font-family': Bc.fontStack(AV.font) };
        var put = function (pp, txt) {
          if (vert) {
            var left = AV.position !== 'opposite';
            L.axes.appendChild(node('text', Object.assign({ x: left ? px0 - 6 : px1 + 6, y: pp + vSize * 0.35, 'text-anchor': left ? 'end' : 'start' }, attrs), txt));
          } else {
            var bottom = AV.position !== 'opposite';
            L.axes.appendChild(node('text', Object.assign({ x: pp, y: bottom ? py1 + vSize + 4 : py0 - 6, 'text-anchor': 'middle' }, attrs), txt));
          }
        };
        put(p, tickText[k]);
        if (centerDiv && t !== 0) put(Math.round(vpx(-t)) + 0.5, tickText[k]);
      }
    });
    if (AV.show && AV.title) {
      var tAttrs = { 'font-size': AV.size, 'font-weight': 600, fill: AV.color, 'font-family': Bc.fontStack(AV.font), 'text-anchor': 'middle' };
      if (vert) {
        var tx = AV.position !== 'opposite' ? AV.size : W - 4;
        var ty = (py0 + py1) / 2;
        L.axes.appendChild(node('text', Object.assign({ x: tx, y: ty, transform: 'rotate(-90 ' + tx + ' ' + ty + ')' }, tAttrs), AV.title));
      } else {
        L.axes.appendChild(node('text', Object.assign({ x: (px0 + px1) / 2, y: AV.position !== 'opposite' ? H - 3 : AV.size }, tAttrs), AV.title));
      }
    }
    if (AV.show && AV.showLine) {
      var ap = vert ? (AV.position !== 'opposite' ? px0 + 0.5 : px1 - 0.5) : (AV.position !== 'opposite' ? py1 - 0.5 : py0 + 0.5);
      L.axes.appendChild(node('line', vert ? { x1: ap, x2: ap, y1: py0, y2: py1, stroke: AV.lineColor, 'shape-rendering': 'crispEdges' } : { x1: px0, x2: px1, y1: ap, y2: ap, stroke: AV.lineColor, 'shape-rendering': 'crispEdges' }));
    }

    // category gridlines (between slots)
    if (LN.catGrid.show) {
      for (var gi = 1; gi < N; gi++) {
        var cp = Math.round(cStart[gi] - (cStart[gi] - cStart[gi - 1] - slot) / 2) + 0.5;
        var a1 = XY(cp, vert ? py0 : px0); var a2 = XY(cp, vert ? py1 : px1);
        L.grid.appendChild(node('line', Object.assign({ x1: a1[0], y1: a1[1], x2: a2[0], y2: a2[1] }, lineAttrs(LN.catGrid))));
      }
    }

    // zero line
    if (LN.zero.show && sc.min <= 0 && sc.max >= 0) {
      if (centerDiv) {
        valueLine(Math.round(centerL) + 0.5, L.grid, lineAttrs(LN.zero));
        valueLine(Math.round(centerR) + 0.5, L.grid, lineAttrs(LN.zero));
      } else {
        valueLine(Math.round(vpx(0)) + 0.5, L.axes, lineAttrs(LN.zero));
      }
    }

    // ---- bars ------------------------------------------------------------------
    var labels = []; // collision candidates
    var SHP = B.S.cfg.shape;
    var FL = B.S.cfg.fill;
    var BD = B.S.cfg.border;
    var eps = span * 1e-9;

    var orderBars = function (n) { return overlap ? n.bars.slice().reverse() : n.bars; };
    if (!showBars) nodes.forEach(function (n) { n.endItem = null; });
    else nodes.forEach(function (n, i) {
      var nodeEnd = null; // outermost end of this category (for notes / icons)
      var nodeItems = [];
      orderBars(n).forEach(function (b) {
        var cspan = barSpan(i, b);
        var c0 = cspan[0]; var c1 = cspan[1];
        var from = stacked ? b.from : 0;
        var to = stacked ? b.to : b.shown;
        var pb = stacked ? (centerDiv ? (from === 0 ? (to < 0 ? centerL : centerR) : vpx(from)) : vpxc(from)) : vbase(to);
        var pe = vpxc(to);
        var dirHint = (vHi > vLo ? 1 : -1) * (to < 0 ? -1 : 1);
        var F = frame(c0, c1, pb, pe, dirHint);
        var isLast = !stacked || (to >= 0 ? Math.abs(to - n.stackPos) < 1e-12 : Math.abs(to - n.stackNeg) < 1e-12);
        var isFirst = !stacked || from === 0;
        var g = node('g', { class: 'bar', 'data-i': B.S.drawn.length });
        L.bars.appendChild(g);
        var item = { node: n, b: b, kind: 'bar', c0: c0, c1: c1, pb: pb, pe: pe, F: F, i: i };
        B.S.drawn.push(item);
        g.setAttribute('data-k', 'c:' + rootLabel(n) + '|s:' + b.s.key);

        // radius / shape
        var rEnd = SHP.corners === 'none' ? 0 : SHP.endShape === 'pill' ? F.wid / 2 : SHP.endShape === 'flat' ? 0 : SHP.radius;
        var rBase = SHP.corners === 'all' ? rEnd : 0;
        if (!isLast) rEnd = 0;
        if (!isFirst) rBase = 0;
        var endShape = isLast ? SHP.endShape : 'flat';

        // progress track
        if (style === 'progress') {
          var tm = trackMax(n, b);
          var pt = vpxc(tm);
          var TF = frame(c0, c1, vbase(tm), pt, dirHint);
          var PR = B.S.cfg.progress;
          var trackD = B.barShape(TF, SHP.corners === 'none' ? 0 : (SHP.endShape === 'pill' ? TF.wid / 2 : SHP.radius), SHP.corners === 'all' || SHP.endShape === 'pill' ? (SHP.endShape === 'pill' ? TF.wid / 2 : SHP.radius) : 0, SHP.endShape === 'arrow' ? 'arrow' : 'rounded');
          var tr = node('path', { d: trackD, fill: PR.trackColor, 'fill-opacity': PR.trackOpacity / 100, class: 'track' });
          if (PR.trackBorder) { tr.setAttribute('stroke', PR.trackBorderColor); tr.setAttribute('stroke-width', 1); }
          L.track.appendChild(tr);
          if (PR.trackShadow) {
            var cid0 = 'bc-c' + (++B.S.uid);
            var cp0 = node('clipPath', { id: cid0 }); cp0.appendChild(node('path', { d: trackD })); defs.appendChild(cp0);
            var sh = frame(c0, c0 + F.wid * 0.22, vbase(tm), pt, dirHint);
            L.track.appendChild(node('path', { d: B.barShape(sh, 0, 0, 'flat'), fill: '#000', 'fill-opacity': 0.06, 'clip-path': 'url(#' + cid0 + ')' }));
          }
          item.track = { pt: pt, tm: tm };
          if (PR.showRemaining && tm > b.shown) {
            var rl = B.boxLabel(Bc.formatNumber(tm - b.shown, B.fmtOf(LB.fmt)), Math.max(8, LB.size - 1), 400, family, 'none');
            rl.fill = PR.remainingColor;
            rl.prio = 1;
            B.placeOn(rl, TF, 'insideEnd', LB.offset + 2);
            labels.push(rl);
          }
        }

        if (style === 'lollipop') {
          drawLollipop(g, n, b, F, c0, c1, item, defs);
        } else {
          drawBarBody(g, n, b, F, rBase, rEnd, endShape, item, defs, isLast);
        }

        // clipped bar marker
        var clipLow = (from === 0 ? 0 : from) < sc.min - eps && to > sc.min;
        var clipHigh = to > sc.max + eps || to < sc.min - eps && from > sc.min;
        if (B.S.cfg.brk.show && style !== 'progress' && (clipLow || (b.shown > 0 && sc.min > 0 && isFirst)) && F.len > 16) {
          drawBreak(g, F, F.len * Math.max(4, Math.min(90, B.S.cfg.brk.pos)) / 100, B.S.cfg.brk);
        } else if (B.S.cfg.brk.show && clipHigh && F.len > 16) {
          drawBreak(g, F, F.len * 0.85, B.S.cfg.brk);
        }

        // value label
        if (LB.show && B.wantLabel(v, n, b) && !(stacked && !LB.segments) && !(style === 'lollipop' && B.S.cfg.lollipop.valueInHead)) {
          var place = LB.position;
          if (stacked && (place === 'outsideEnd' || place === 'column') && (!isLast || (LB.totals && lay !== 'diverging') || lay === 'stacked100')) place = 'center'; // diverging draws no totals, so its end bars keep the outside label
          if (stacked && place === 'column') place = 'center';
          labels.push(B.barLabel(v, b, F, place, item, family, stacked && !isLast));
        }
        if (isLast) nodeEnd = { F: F, item: item };
        nodeItems.push({ F: F, item: item });
        // segments of the breakdown
        if (style === 'bar' && B.segSpec(n)) {
          drawSegments(g, n, b, F, item, defs, family, labels);
        }
      });

      // stacked totals
      if (stacked && LB.show && LB.totals && lay !== 'diverging') {
        ['pos', 'neg'].forEach(function (side) {
          var tot = side === 'pos' ? n.stackPos : n.stackNeg;
          if (!tot || (side === 'neg' && !n.stackNeg)) return;
          var cs = cStart[i] + (slot - barW) / 2;
          var F2 = frame(cs, cs + barW, vbase(tot), vpxc(tot), (vHi > vLo ? 1 : -1) * (tot < 0 ? -1 : 1));
          var txt = lay === 'stacked100' ? B.totalText(v, n) : Bc.formatNumber(side === 'pos' ? B.sumSide(n, 1) : B.sumSide(n, -1), B.fmtOf(LB.totalFmt));
          var lbl = B.boxLabel(txt, LB.totalSize, LB.totalWeight, family, 'none');
          lbl.fill = LB.totalColor;
          lbl.prio = 1e15;
          B.placeOn(lbl, F2, 'outsideEnd', LB.offset);
          labels.push(lbl);
        });
      }

      // icons inside / outside the bar
      // one icon per bar when each bar is a measure, else one per category (at the stack's end)
      if (IC.show && IC.placement !== 'axis' && nodeEnd) {
        var perBar = IC.by === 'measures' && v.visSeries.length > 1 && !stacked;
        (perBar ? nodeItems : [nodeEnd]).forEach(function (ne) {
          var F0 = ne.F;
          var isz = B.iconBox();
          var t;
          if (IC.placement === 'base') t = IC.gap + isz / 2;
          else if (IC.placement === 'middle') t = F0.len / 2;
          else if (IC.placement === 'end') t = F0.len - IC.gap - isz / 2;
          else t = F0.len + IC.gap + isz / 2;
          if (IC.placement === 'outside' || F0.len >= isz + IC.gap) {
            var pos = F0.P(t, F0.wid / 2);
            if (drawMemberIcon(L.icons, n, pos[0], pos[1], defs, ne.item.b.color, IC.placement === 'outside' ? 'out' : 'in', ne.item.b) && IC.placement === 'outside') ne.item.iconPad = isz + IC.gap;
          }
        });
      }
      n.endItem = nodeEnd && nodeEnd.item;
    });

    // ---- labels that follow the icons outside ------------------------------------
    labels.forEach(function (l) {
      if (l.item && l.item.iconPad && l.place === 'outsideEnd') B.shiftAlong(l, l.item.iconPad);
    });

    // ---- target markers --------------------------------------------------------------
    var TG = B.S.cfg.target;
    if (showBars && B.targetInfo() && !v.noTarget && !B.S.state.off['t:'] && TG.show && TG.style !== 'none' && lay !== 'stacked100') {
      nodes.forEach(function (n, i) {
        if (!isFinite(n.t)) return;
        var p = vpxc(n.t);
        var span2 = sideBySide || overlap ? [cStart[i] + (slot - band) / 2, cStart[i] + (slot + band) / 2] : barSpan(i, n.bars[0] || { si: 0 });
        var e = Math.max(0, TG.extend) * (span2[1] - span2[0]) / 100;
        var gT = node('g', { class: 'target' });
        labels.forEach(function (l) {
          if (!l.item || l.item.node !== n || l.place !== 'outsideEnd' || !l.F) return;
          var beyond = (p - l.item.pe) * (l.F.dir || 1);
          if (beyond > -TG.width) B.shiftAlong(l, Math.max(0, beyond) + TG.width + 1);
        });
        if (TG.style === 'line') {
          var a = XY(span2[0] - e, p); var b2 = XY(span2[1] + e, p);
          gT.appendChild(node('line', { x1: a[0], y1: a[1], x2: b2[0], y2: b2[1], stroke: TG.color, 'stroke-width': TG.width, 'stroke-linecap': 'round' }));
        } else if (TG.style === 'dot') {
          var cpt = XY((span2[0] + span2[1]) / 2, p);
          gT.appendChild(node('circle', { cx: cpt[0], cy: cpt[1], r: TG.width + 2.5, fill: '#fff', stroke: TG.color, 'stroke-width': TG.width }));
        } else {
          var tp = XY(span2[1] + 2, p);
          var sz = 4 + TG.width * 1.5;
          var pts = vert ? [[tp[0], tp[1]], [tp[0] + sz, tp[1] - sz * 0.7], [tp[0] + sz, tp[1] + sz * 0.7]] : [[tp[0], tp[1]], [tp[0] - sz * 0.7, tp[1] + sz], [tp[0] + sz * 0.7, tp[1] + sz]];
          gT.appendChild(node('polygon', { points: pts.map(function (q) { return q.join(','); }).join(' '), fill: TG.color }));
        }
        L.targets.appendChild(gT);
      });
    }

    // ---- reference lines -------------------------------------------------------------
    refVals.forEach(function (r) {
      var rc = r.cfg;
      var pa = vpxc(r.a);
      if (r.band) {
        var pbb = vpxc(r.b);
        var x0 = vert ? plotC0 : Math.min(pa, pbb);
        var y0 = vert ? Math.min(pa, pbb) : plotC0;
        L.refs.appendChild(node('rect', { x: x0, y: y0, width: vert ? plotC1 - plotC0 : Math.abs(pbb - pa), height: vert ? Math.abs(pbb - pa) : plotC1 - plotC0, fill: rc.color, 'fill-opacity': rc.bandOpacity / 100 }));
      }
      [r.a].concat(r.band ? [r.b] : []).forEach(function (val, j) {
        var pp = Math.round(vpxc(val)) + 0.5;
        valueLine(pp, L.refs, { stroke: rc.color, 'stroke-width': rc.width, 'stroke-dasharray': Bc.dashArray(rc.style, rc.width) });
        if (rc.label && j === 0) {
          var txt = rc.label.replace(/\{type\}/g, B.refName(rc)).replace(/\{value\}/g, Bc.formatNumber(val, B.fmtOf(LB.fmt)));
          var at = rc.labelPos === 'start' ? plotC0 + 2 : rc.labelPos === 'center' ? (plotC0 + plotC1) / 2 : plotC1 - 2;
          var anchor = rc.labelPos === 'start' ? 'start' : rc.labelPos === 'center' ? 'middle' : 'end';
          var q = vert ? [at, pp - 4] : [pp + 4, plotC0 + 10];
          if (!vert) anchor = 'start';
          var lbl = B.boxLabel(txt, Math.max(8, LB.size - 1), 600, family, 'none');
          lbl.fill = rc.color;
          lbl.prio = 1e16;
          lbl.x = anchor === 'end' ? q[0] - lbl.w / 2 : anchor === 'start' ? q[0] + lbl.w / 2 : q[0];
          lbl.y = vert ? q[1] - lbl.h / 2 + 2 : q[1];
          if (!vert) { lbl.x = q[0] + lbl.w / 2; lbl.y = plotC0 + lbl.h / 2; }
          labels.push(lbl);
        }
      });
    });

    // ---- line overlay -------------------------------------------------------------------
    if (lines.length) {
      var lpx = lineShared || !lsc ? vpx : function (val) { return vLo + (val - lsc.min) / ((lsc.max - lsc.min) || 1) * (vHi - vLo); };
      lines.forEach(function (l, li) {
        var lc = Bc.lineCfg(B.S.cfg, l.key);
        var col = B.lineColor(l.key, B.S.raw.lines.indexOf(l));
        var pts = [];
        nodes.forEach(function (n, i) {
          var val = n.l[l.key];
          if (!isFinite(val)) return;
          var c = cStart[i] + slot / 2;
          var p = lpx(val);
          var xy = XY(c, p);
          pts.push({ x: xy[0], y: xy[1], n: n, v: val, c: c, p: p });
        });
        if (!pts.length) return;
        var gl = node('g', { class: 'line-series', 'data-k': 'l:' + l.key, opacity: lc.opacity / 100 });
        L.lines.appendChild(gl);
        var d = B.linePath(pts, lc.curve, vert);
        if (lc.area) {
          var b0 = lpx(Math.max(lineShared || !lsc ? sc.min : lsc.min, 0));
          var first = pts[0]; var last = pts[pts.length - 1];
          var close = vert ? 'L' + last.x + ' ' + b0 + 'L' + first.x + ' ' + b0 + 'Z' : 'L' + b0 + ' ' + last.y + 'L' + b0 + ' ' + first.y + 'Z';
          gl.appendChild(node('path', { d: d + close, fill: col, 'fill-opacity': lc.areaOpacity / 100, stroke: 'none' }));
        }
        gl.appendChild(node('path', { d: d, fill: 'none', stroke: col, 'stroke-width': lc.width, 'stroke-dasharray': Bc.dashArray(lc.style, lc.width), 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
        pts.forEach(function (q) {
          if (lc.marker !== 'none') gl.appendChild(markerShape(lc.marker, q.x, q.y, lc.markerSize, col, lc.markerFill === 'white' ? '#FFFFFF' : col, Math.max(1.2, lc.width * 0.75)));
          var hit = node('circle', { cx: q.x, cy: q.y, r: Math.max(7, lc.markerSize), fill: 'transparent', class: 'bar', 'data-i': B.S.drawn.length, 'data-k': 'l:' + l.key });
          gl.appendChild(hit);
          B.S.drawn.push({ node: q.n, kind: 'line', line: l, lv: q.v, color: col, i: q.n.idx, x: q.x, y: q.y });
          if (lc.labels) {
            var lbl = B.boxLabel(Bc.formatNumber(q.v, B.lineFmt()), lc.labelSize, lc.labelWeight, family, 'none');
            lbl.fill = col;
            lbl.prio = Math.abs(q.v) * 0.5;
            var dy = lc.markerSize / 2 + 3 + lbl.h / 2;
            if (lc.labelPos === 'right') { lbl.x = q.x + lc.markerSize / 2 + 3 + lbl.w / 2; lbl.y = q.y; } else { lbl.x = q.x; lbl.y = q.y + (lc.labelPos === 'below' ? dy : -dy); }
            labels.push(lbl);
          }
        });
        // line axis
        if (lsc && LA.show && li === 0 && !lineShared) {
          lsc.ticks.forEach(function (t, k) {
            var pp = lpx(t);
            if (vert) {
              var right = AV.position !== 'opposite';
              L.axes.appendChild(node('text', { x: right ? px1 + 6 : px0 - 6, y: pp + LA.size * 0.35, 'text-anchor': right ? 'start' : 'end', 'font-size': LA.size, fill: LA.color, 'font-family': Bc.fontStack(AV.font) }, lTick[k]));
            } else {
              L.axes.appendChild(node('text', { x: pp, y: AV.position !== 'opposite' ? py0 - 6 : py1 + LA.size + 4, 'text-anchor': 'middle', 'font-size': LA.size, fill: LA.color, 'font-family': Bc.fontStack(AV.font) }, lTick[k]));
            }
          });
          if (LA.title) {
            var lx = vert ? (AV.position !== 'opposite' ? W - 3 : LA.size) : (px0 + px1) / 2;
            var ly = vert ? (py0 + py1) / 2 : (AV.position !== 'opposite' ? LA.size : H - 3);
            L.axes.appendChild(node('text', { x: lx, y: ly, 'text-anchor': 'middle', 'font-size': LA.size, 'font-weight': 600, fill: LA.color, 'font-family': Bc.fontStack(AV.font), transform: vert ? 'rotate(' + (AV.position !== 'opposite' ? 90 : -90) + ' ' + lx + ' ' + ly + ')' : null }, LA.title));
          }
        }
      });
    }

    // ---- category axis -----------------------------------------------------------------
    var catEdge = vert ? (AC.position === 'opposite' ? py0 : py1) : (AC.position === 'opposite' ? px1 : px0);
    var outward = AC.position === 'opposite' ? -1 : 1; // vertical: +down; horizontal: -left
    if (AC.showLine) {
      var e0 = XY(plotC0, centerDiv ? 0 : catEdge); var e1 = XY(plotC1, catEdge);
      if (!centerDiv) {
        var lpos = Math.round(catEdge) + 0.5;
        L.axes.appendChild(node('line', vert ? { x1: px0, x2: px1, y1: lpos, y2: lpos, stroke: AC.lineColor, 'stroke-width': AC.lineWidth, 'shape-rendering': 'crispEdges' }
          : { x1: lpos, x2: lpos, y1: py0, y2: py1, stroke: AC.lineColor, 'stroke-width': AC.lineWidth, 'shape-rendering': 'crispEdges' }));
      }
      void e0; void e1;
    }
    var step = B.labelStep(nodes, slot, vert);
    var catFont = { 'font-size': AC.size, 'font-weight': AC.weight, 'font-family': Bc.fontStack(AC.font) };
    var catBody = function (n, i) {
      var cc = cStart[i] + slot / 2;
      var color = AC.colorByBar && n.bars[0] ? Bc.readable(n.bars[0].color) : AC.color;
      var barColor = n.bars[0] ? n.bars[0].color : AC.color;
      // axis icons
      var iconOff = 0;
      if (axisIcons) {
        var isz = B.iconBox();
        var ip = vert ? catEdge + outward * (IC.gap + isz / 2) : catEdge - (AC.position === 'opposite' ? -1 : 1) * (IC.gap + isz / 2 + (IC.accent ? 6 : 0));
        var xy = vert ? [cc, ip] : [ip, cc];
        if (drawMemberIcon(L.icons, n, xy[0], xy[1], defs, barColor, 'axis', n.bars[0]) && IC.accent) {
          var ax = vert ? [cc - isz / 2, catEdge + outward * 2, isz, 3] : [catEdge - (AC.position === 'opposite' ? -1 : 1) * 5 - 1.5, cc - isz / 2, 3, isz];
          L.icons.appendChild(node('rect', { x: ax[0], y: ax[1], width: ax[2], height: ax[3], rx: 1.5, fill: barColor }));
        }
        iconOff = isz + IC.gap + (IC.accent ? 6 : 0);
      }
      if (!AC.show) return;
      var item = n.endItem;
      if (AC.placement === 'axis' || AC.placement === 'pill') {
        if (i % step !== 0 && AC.hideLabelsAuto) return;
        var ls = xl[i] || [n.label];
        if (centerDiv) {
          var cpos = (centerL + centerR) / 2;
          var q = XY(cc, cpos);
          L.axes.appendChild(node('text', Object.assign({ x: q[0], y: q[1] + (vert ? 0 : AC.size * 0.35), 'text-anchor': 'middle', fill: color }, catFont), B.ellipsize(n.label, Math.abs(cGap) - 6, AC.size, AC.weight, AC.font)));
          return;
        }
        var lh2 = Math.round(AC.size * 1.25);
        if (AC.placement === 'pill') {
          var tw = Math.max.apply(null, ls.map(function (t) { return B.textWidth(t, AC.size, AC.weight, AC.font); }));
          var pw = Math.min(vert ? slot * 0.94 : catLabelThick - 6, tw + 16);
          var ph = ls.length * lh2 + 6;
          var px = vert ? cc - pw / 2 : catEdge - (AC.position === 'opposite' ? -1 : 1) * (iconOff + 4) - (AC.position === 'opposite' ? 0 : pw);
          var py = vert ? catEdge + outward * (iconOff + 6) - (outward < 0 ? ph : 0) : cc - ph / 2;
          L.axes.appendChild(node('rect', { x: px, y: py, width: pw, height: ph, rx: Math.min(AC.pillRadius, ph / 2), fill: barColor }));
          ls.forEach(function (t, k) {
            L.axes.appendChild(node('text', Object.assign({ x: px + pw / 2, y: py + 3 + AC.size + k * lh2 - 1, 'text-anchor': 'middle', fill: Bc.contrastText(barColor) }, catFont), t));
          });
          return;
        }
        if (vert) {
          var base = catEdge + outward * (iconOff + 6);
          if (AC.orientation === 'wrap') {
            ls.forEach(function (t, k) {
              var yy = outward > 0 ? base + AC.size + k * lh2 - 2 : base - (ls.length - 1 - k) * lh2 - 3;
              L.axes.appendChild(node('text', Object.assign({ x: cc, y: yy, 'text-anchor': 'middle', fill: color }, catFont), t));
            });
          } else {
            var ang = AC.orientation === 'angled' ? -45 : -90;
            var tx2 = cc + AC.size * 0.35;
            var ty2 = base + (outward > 0 ? 2 : -2);
            L.axes.appendChild(node('text', Object.assign({ x: tx2, y: ty2, 'text-anchor': outward > 0 ? 'end' : 'start', fill: color, transform: 'rotate(' + ang + ' ' + tx2 + ' ' + ty2 + ')' }, catFont), ls[0]));
          }
        } else {
          var left = AC.position !== 'opposite';
          var colW = catLabelThick - 8;
          var x0 = left ? catEdge - iconOff - 6 : catEdge + iconOff + 6;
          var anchor;
          var xx;
          if (AC.align === 'center') { anchor = 'middle'; xx = left ? x0 - colW / 2 : x0 + colW / 2; }
          else if (AC.align === 'start') { anchor = left ? 'start' : 'end'; xx = left ? x0 - colW : x0 + colW; }
          else { anchor = left ? 'end' : 'start'; xx = x0; }
          var y0 = cc - (ls.length - 1) * lh2 / 2 + AC.size * 0.35;
          ls.forEach(function (t, k) {
            L.axes.appendChild(node('text', Object.assign({ x: xx, y: y0 + k * lh2, 'text-anchor': anchor, fill: color }, catFont), t));
          });
        }
      } else if (item && (AC.placement === 'insideBase' || AC.placement === 'rotatedInside')) {
        var F1 = item.F;
        var col1 = Bc.contrastText(item.b.color);
        var rot = AC.placement === 'rotatedInside' && vert;
        var tw1 = B.textWidth(n.label, AC.size, AC.weight, AC.font);
        var avail = rot ? F1.len - 12 : (vert ? F1.wid - 6 : F1.len - 12);
        if (avail < 12) return;
        var t1 = B.ellipsize(n.label, avail, AC.size, AC.weight, AC.font);
        if (rot) {
          var p1 = F1.P(8, F1.wid / 2);
          L.labels.appendChild(node('text', Object.assign({ x: p1[0] + AC.size * 0.36, y: p1[1], fill: col1, 'text-anchor': 'start', transform: 'rotate(-90 ' + (p1[0] + AC.size * 0.36) + ' ' + p1[1] + ')' }, catFont), t1));
        } else if (vert) {
          var p2 = F1.P(8 + AC.size * 0.8, F1.wid / 2);
          L.labels.appendChild(node('text', Object.assign({ x: p2[0], y: p2[1], fill: col1, 'text-anchor': 'middle' }, catFont), t1));
        } else {
          var p3 = F1.P(8, F1.wid / 2);
          var right = item.pe >= item.pb;
          L.labels.appendChild(node('text', Object.assign({ x: p3[0], y: p3[1] + AC.size * 0.35, fill: col1, 'text-anchor': right ? 'start' : 'end' }, catFont), t1));
        }
        void tw1;
        // value labels placed at the base would collide with the name
        labels.forEach(function (l) { if (l.item === item && l.place === 'insideBase') l.hidden = true; });
      } else if (item && AC.placement === 'above') {
        var F2b = item.F;
        var lblExtra = 0;
        labels.forEach(function (l) { if (l.item === item && l.place === 'outsideEnd') lblExtra = Math.max(lblExtra, (vert ? l.h : l.w) + LB.offset); });
        var cl = B.boxLabel(n.label, AC.size, AC.weight, AC.font, 'none');
        cl.fill = color;
        cl.prio = 1e14;
        cl.item = item;
        B.placeOn(cl, F2b, 'outsideEnd', 4 + lblExtra + (item.iconPad || 0));
        labels.push(cl);
      }
    };
    // names on the axis are clickable like their bars (data-cat = index in catRefs, across panels)
    nodes.forEach(function (n, i) {
      var c0 = [L.axes, L.labels, L.icons].map(function (g) { return g.childNodes.length; });
      catBody(n, i);
      var ci = B.S.catRefs.push(n) - 1;
      [L.axes, L.labels, L.icons].forEach(function (g, k) {
        for (var j = c0[k]; j < g.childNodes.length; j++) g.childNodes[j].setAttribute('data-cat', ci);
      });
    });
    if (AC.show && AC.title) {
      var ct = { 'font-size': AC.size, 'font-weight': 700, fill: AC.color, 'font-family': Bc.fontStack(AC.font), 'text-anchor': 'middle' };
      if (vert) L.axes.appendChild(node('text', Object.assign({ x: (px0 + px1) / 2, y: AC.position === 'opposite' ? AC.size : H - 3 }, ct), AC.title));
      else {
        var cx2 = AC.position === 'opposite' ? W - 3 : AC.size; var cy2 = (py0 + py1) / 2;
        L.axes.appendChild(node('text', Object.assign({ x: cx2, y: cy2, transform: 'rotate(-90 ' + cx2 + ' ' + cy2 + ')' }, ct), AC.title));
      }
    }

    // ---- groups -------------------------------------------------------------------------
    if (showGroups) {
      var gf = B.fmtOf(G.fmt);
      runs.forEach(function (r) {
        if (!r.grp) return;
        var c0 = cStart[r.i0] + Math.min(6, slot * 0.15);
        var c1 = cStart[r.i1] + slot - Math.min(6, slot * 0.15);
        var txt = r.grp.label;
        if (G.showTotal) {
          var tot = 0;
          for (var q = r.i0; q <= r.i1; q++) tot += nodes[q].total;
          txt += G.separator + Bc.formatNumber(tot, gf);
        }
        var la = { stroke: r.grp.color, 'stroke-width': G.lineWidth, fill: 'none' };
        if (G.lineStyle === 'dashed' || G.lineStyle === 'dotted') la['stroke-dasharray'] = Bc.dashArray(G.lineStyle, G.lineWidth);
        var tAttrs2 = { 'font-size': G.size, 'font-weight': G.weight, fill: G.textColor, 'font-family': Bc.fontStack(family) };
        if (vert) {
          var gy = AC.position === 'opposite'
            ? py0 - catLabelThick - iconThick - 4
            : py1 + catLabelThick + iconThick + 4;
          var dirY = AC.position === 'opposite' ? -1 : 1;
          if (G.lineStyle === 'bracket') L.axes.appendChild(node('path', Object.assign({ d: 'M' + c0 + ' ' + (gy - dirY * 4) + 'V' + gy + 'H' + c1 + 'V' + (gy - dirY * 4) }, la)));
          else if (G.lineStyle !== 'none') L.axes.appendChild(node('line', Object.assign({ x1: c0, x2: c1, y1: gy, y2: gy }, la)));
          var ty3 = gy + dirY * (G.lineWidth / 2 + 3) + (dirY > 0 ? G.size : -2);
          L.axes.appendChild(node('text', Object.assign({ x: (c0 + c1) / 2, y: ty3, 'text-anchor': 'middle' }, tAttrs2), B.ellipsize(txt, Math.max(24, c1 - c0 + slot * 0.3), G.size, G.weight, family)));
        } else {
          var leftSide = AC.position !== 'opposite';
          var gx = leftSide ? px0 - catLabelThick - iconThick - 4 : px1 + catLabelThick + iconThick + 4;
          var dirX = leftSide ? -1 : 1;
          if (G.lineStyle === 'bracket') L.axes.appendChild(node('path', Object.assign({ d: 'M' + (gx - dirX * 4) + ' ' + c0 + 'H' + gx + 'V' + c1 + 'H' + (gx - dirX * 4) }, la)));
          else if (G.lineStyle !== 'none') L.axes.appendChild(node('line', Object.assign({ x1: gx, x2: gx, y1: c0, y2: c1 }, la)));
          var maxGW = groupThick - 10 - G.lineWidth;
          var gl2 = B.wrapText(txt, Math.max(20, maxGW), Math.max(1, Math.floor((c1 - c0) / (G.size * 1.2))), G.size, G.weight, family);
          var gy0 = (c0 + c1) / 2 - (gl2.length - 1) * G.size * 0.6 + G.size * 0.35;
          gl2.forEach(function (t, k) {
            L.axes.appendChild(node('text', Object.assign({ x: gx + dirX * (G.lineWidth / 2 + 5), y: gy0 + k * G.size * 1.2, 'text-anchor': leftSide ? 'end' : 'start' }, tAttrs2), t));
          });
        }
      });
    }

    // ---- comments --------------------------------------------------------------------------
    if (B.S.cfg.comments.show) drawComments(L.notes, nodes, labels, vert, family);

    // ---- label column (aligned at the plot edge) -----------------------------------------
    labels.forEach(function (l) {
      if (l.place !== 'column') return;
      var edge = vert ? py0 + 2 + l.h / 2 : px1 - 2 - l.w / 2;
      if (vert) l.y = edge; else l.x = edge;
    });

    B.resolveLabels(labels, W, H);
    labels.forEach(function (l) { if (!l.hidden) renderLabel(L.labels, l); });

    // remember geometry for hover effects
    v.geom = { vert: vert, px0: px0, px1: px1, py0: py0, py1: py1 };
    for (var di = firstItem; di < B.S.drawn.length; di++) B.S.drawn[di].v = v; // which panel / view each hit area is in

    // ---- grow animation ------------------------------------------------------------------
    if (animate) {
      Array.prototype.forEach.call(L.bars.querySelectorAll('.bar'), function (g) {
        var it = B.S.drawn[Number(g.getAttribute('data-i'))];
        if (!it || !it.F) return;
        var up = vert ? it.pe < it.pb : it.pe > it.pb;
        g.classList.add('grow');
        g.style.transformOrigin = vert ? (up ? '50% 100%' : '50% 0%') : (up ? '0% 50%' : '100% 50%');
        g.style.setProperty('--sx', vert ? '1' : '0');
        g.style.setProperty('--sy', vert ? '0' : '1');
      });
      [L.labels, L.lines, L.icons, L.notes, L.targets, L.track].forEach(function (g) { g.classList.add('fade'); });
    }

    // ------------------------------------------------------------------------------------
    // local drawing helpers (need the scale)
    // ------------------------------------------------------------------------------------
    function frame (c0, c1, b, e, dirHint) {
      var dir = e > b ? 1 : e < b ? -1 : (dirHint || 1) * (vert ? -1 : 1);
      var len = Math.abs(e - b);
      var wid = c1 - c0;
      return {
        len: len, wid: wid, dir: dir, c0: c0, c1: c1, b: b, e: e, vert: vert,
        P: vert
          ? function (t, s) { return [c0 + s, b + dir * t]; }
          : function (t, s) { return [b + dir * t, c0 + s]; }
      };
    }
    void frame;
  }

  function clipFor (defs, d) {
    var id = 'bc-c' + (++S.uid);
    var cp = node('clipPath', { id: id });
    cp.appendChild(node('path', { d: d }));
    defs.appendChild(cp);
    return 'url(#' + id + ')';
  }

  function paintFor (defs, F, color) {
    var FL = S.cfg.fill;
    if (FL.type !== 'gradient' || F.len < 1) return color;
    var id = 'bc-g' + (++S.uid);
    var a = FL.gradientDir === 'across' ? F.P(F.len / 2, 0) : F.P(0, F.wid / 2);
    var b = FL.gradientDir === 'across' ? F.P(F.len / 2, F.wid) : F.P(F.len, F.wid / 2);
    var g = node('linearGradient', { id: id, gradientUnits: 'userSpaceOnUse', x1: fx(a[0]), y1: fx(a[1]), x2: fx(b[0]), y2: fx(b[1]) });
    var other = FL.gradientTo === 'color' ? FL.gradientColor : Bc.tint(color, Math.max(0, Math.min(100, FL.gradientStrength)) / 100);
    g.appendChild(node('stop', { offset: '0', 'stop-color': other }));
    g.appendChild(node('stop', { offset: '1', 'stop-color': color }));
    defs.appendChild(g);
    return 'url(#' + id + ')';
  }

  function drawBarBody (g, n, b, F, rBase, rEnd, endShape, item, defs) {
    var d = B.barShape(F, rEnd, rBase, endShape);
    item.d = d;
    var p = node('path', Object.assign({ class: 'bar-body', d: d, fill: paintFor(defs, F, b.color), 'fill-opacity': S.cfg.fill.opacity / 100 }, B.borderAttrs(b.color)));
    g.appendChild(p);
    if (S.cfg.fill.type === 'twoTone' && F.len > 1) {
      g.appendChild(node('path', { d: B.rectIn(F, 0, F.len, F.wid / 2, F.wid), fill: '#FFFFFF', 'fill-opacity': S.cfg.fill.twoTone / 100, 'clip-path': clipFor(defs, d), 'pointer-events': 'none' }));
    }
  }

  function drawLollipop (g, n, b, F, c0, c1, item, defs) {
    var LP = S.cfg.lollipop;
    var sw = Math.max(1, Math.min(LP.stemWidth, F.wid));
    var s0 = F.wid / 2 - sw / 2;
    if (F.len > 0.5) {
      g.appendChild(node('path', { class: 'bar-body', d: B.rectIn(F, 0, F.len, s0, s0 + sw), fill: b.color, 'fill-opacity': LP.stemOpacity / 100 }));
    }
    // hit area as wide as the slot
    g.appendChild(node('path', { d: B.rectIn(F, 0, F.len + 4, 0, F.wid), fill: 'transparent' }));
    var txt = LP.valueInHead ? B.labelText(S.view, b) : '';
    var tw = txt ? B.textWidth(txt, S.cfg.labels.size, S.cfg.labels.weight, S.cfg.numbers.font) : 0;
    var hs = LP.valueInHead ? Math.max(LP.headSize, tw + 10, S.cfg.labels.size * 1.9) : LP.headSize;
    if (LP.head === 'none' && !LP.valueInHead) return;
    var c = F.P(F.len, F.wid / 2);
    var fill = LP.headFill === 'white' ? '#FFFFFF' : LP.headFill === 'custom' ? LP.headColor : b.color;
    var shape = LP.head === 'none' ? 'circle' : LP.head;
    var stroke = shape === 'ring' || LP.headFill !== 'bar' ? b.color : 'none';
    var el2 = markerShape(shape === 'ring' ? 'circle' : shape, c[0], c[1], hs, stroke, shape === 'ring' && LP.headFill === 'bar' ? '#FFFFFF' : fill, shape === 'ring' ? LP.ringWidth : (stroke !== 'none' ? 1.5 : 0));
    el2.setAttribute('class', 'bar-body');
    g.appendChild(el2);
    item.head = { x: c[0], y: c[1], r: hs / 2 };
    if (txt) {
      var tf = shape === 'ring' || fill === '#FFFFFF' ? Bc.readable(b.color) : Bc.contrastText(fill);
      g.appendChild(node('text', { x: c[0], y: c[1] + S.cfg.labels.size * 0.35, 'text-anchor': 'middle', 'font-size': S.cfg.labels.size, 'font-weight': S.cfg.labels.weight, fill: tf, 'font-family': Bc.fontStack(S.cfg.numbers.font) }, txt));
    }
  }

  function drawSegments (g, n, b, F, item, defs, family, labels) {
    var spec = B.segSpec(n);
    if (!spec) return;
    var segs = B.segmentsOf(n, b.s.key, spec);
    if (segs.length < (spec.color ? 1 : 2) || F.len < 1) return;
    var BD = S.cfg.breakdown;
    var tot = segs.reduce(function (a, s) { return a + Math.abs(s.v); }, 0) || 1;
    var colors = B.segColors(segs, b.color, spec);
    var sg = node('g', { 'clip-path': clipFor(defs, item.d || B.barShape(F, 0, 0, 'flat')) });
    g.appendChild(sg);
    var t = 0;
    item.segs = [];
    segs.forEach(function (s, k) {
      var len = F.len * Math.abs(s.v) / tot;
      var col = colors[s.member];
      sg.appendChild(node('path', { d: B.rectIn(F, t, t + len, 0, F.wid), fill: paintFor(defs, F, col), 'fill-opacity': S.cfg.fill.opacity / 100, 'data-seg': k }));
      if (BD.dividers && k < segs.length - 1) {
        var a = F.P(t + len, 0); var c = F.P(t + len, F.wid);
        sg.appendChild(node('line', { x1: a[0], y1: a[1], x2: c[0], y2: c[1], stroke: '#FFFFFF', 'stroke-width': 1 }));
      }
      item.segs.push({ seg: s, t0: t, t1: t + len, color: col });
      if (BD.showValues) {
        var txt = Bc.formatNumber(s.v, B.fmtOf(BD.fmt));
        if (BD.showNames) txt = s.member + ' ' + txt;
        var lbl = B.boxLabel(txt, BD.size, BD.weight, family, 'none');
        lbl.prio = Math.abs(s.v) * 0.9;
        var along = F.vert ? lbl.h : lbl.w;
        var across = F.vert ? lbl.w : lbl.h;
        var mid = t + len / 2;
        if (BD.position === 'inside') {
          if (len < Math.max(BD.minPx, along + 2) || across > F.wid + 2) return;
          var p = F.P(mid, F.wid / 2);
          lbl.x = p[0]; lbl.y = p[1];
          lbl.fill = BD.labelColorMode === 'custom' ? BD.labelColor : Bc.contrastText(col);
        } else {
          if (len < Math.max(2, BD.minPx * 0.5)) return;
          var right = BD.position === 'right';
          var sOff = right ? F.wid + 4 + across / 2 : -4 - across / 2;
          var p2 = F.P(mid, sOff);
          lbl.x = p2[0]; lbl.y = p2[1];
          lbl.fill = BD.labelColorMode === 'custom' ? BD.labelColor : Bc.readable(col);
        }
        labels.push(lbl);
      }
      t += len;
    });
  }

  /** "Bar continues" marker across a clipped bar, `t` px from its base. */
  function drawBreak (g, F, t, brk) {
    var x0 = -2; var x1 = F.wid + 2;
    var P = function (tt, s) { return F.P(tt, s).map(fx).join(','); };
    if (brk.style === 'zigzag') {
      var teeth = Math.max(2, Math.round((x1 - x0) / 7));
      var tw = (x1 - x0) / teeth;
      var top = []; var bot = [];
      for (var k = 0; k <= teeth; k++) {
        var s = x0 + k * tw;
        var dt = k % 2 ? -2.5 : 2.5;
        top.push(P(t - 4 + dt, s)); bot.push(P(t + 4 + dt, s));
      }
      g.appendChild(node('polygon', { points: top.concat(bot.slice().reverse()).join(' '), fill: brk.bandColor }));
      g.appendChild(node('polyline', { points: top.join(' '), fill: 'none', stroke: brk.lineColor, 'stroke-width': 1 }));
      g.appendChild(node('polyline', { points: bot.join(' '), fill: 'none', stroke: brk.lineColor, 'stroke-width': 1 }));
      return;
    }
    var tilt = brk.style === 'slash' ? 3 : 0;
    g.appendChild(node('polygon', { points: [P(t - 4, x0), P(t - 4 + tilt, x1), P(t + 4 + tilt, x1), P(t + 4, x0)].join(' '), fill: brk.bandColor }));
    if (brk.style === 'slash') {
      g.appendChild(node('polyline', { points: [P(t - 4, x0), P(t - 4 + tilt, x1)].join(' '), stroke: brk.lineColor, 'stroke-width': 1, fill: 'none' }));
      g.appendChild(node('polyline', { points: [P(t + 4, x0), P(t + 4 + tilt, x1)].join(' '), stroke: brk.lineColor, 'stroke-width': 1, fill: 'none' }));
    }
  }

  function markerShape (type, x, y, size, stroke, fill, sw) {
    var r = size / 2;
    var attrs = { fill: fill, stroke: stroke && stroke !== 'none' ? stroke : null, 'stroke-width': stroke && stroke !== 'none' ? sw : null };
    if (type === 'square') return node('rect', Object.assign({ x: x - r, y: y - r, width: size, height: size, rx: Math.min(2, r / 3) }, attrs));
    if (type === 'diamond') return node('polygon', Object.assign({ points: [[x, y - r * 1.2], [x + r * 1.2, y], [x, y + r * 1.2], [x - r * 1.2, y]].map(function (p) { return p.map(fx).join(','); }).join(' ') }, attrs));
    if (type === 'hexagon') {
      var pts = [];
      for (var i = 0; i < 6; i++) { var a = Math.PI / 3 * i - Math.PI / 2; pts.push(fx(x + r * 1.08 * Math.cos(a)) + ',' + fx(y + r * 1.08 * Math.sin(a))); }
      return node('polygon', Object.assign({ points: pts.join(' ') }, attrs));
    }
    if (type === 'ring') return node('circle', Object.assign({ cx: x, cy: y, r: r }, attrs, { fill: '#FFFFFF', stroke: stroke || fill, 'stroke-width': Math.max(1.5, sw) }));
    return node('circle', Object.assign({ cx: x, cy: y, r: r }, attrs));
  }

  /** Draws a member's icon centred at (x, y). kind: axis | in (on the bar) | out. */
  function drawMemberIcon (g, n, x, y, defs, barColor, kind, b) {
    var IC = S.cfg.icons;
    var spec = B.iconSpec(n, b);
    if (!spec) return false;
    var size = IC.size;
    var box = B.iconBox();
    var gi = node('g', { class: 'member-icon' });
    g.appendChild(gi);
    var bgFill = null;
    if (IC.bg !== 'none') {
      bgFill = IC.bgMode === 'bar' ? barColor : IC.bgMode === 'tint' ? Bc.tint(barColor, 0.82) : IC.bgColor;
      var bga = { fill: bgFill };
      if (IC.bg === 'circle') gi.appendChild(node('circle', Object.assign({ cx: x, cy: y, r: box / 2 }, bga)));
      else gi.appendChild(node('rect', Object.assign({ x: x - box / 2, y: y - box / 2, width: box, height: box, rx: IC.bg === 'rounded' ? box * 0.24 : 2 }, bga)));
    }
    var builtin = spec.source === 'builtin';
    var icon = builtin ? Bc.findIcon(spec.builtinId) : null;
    var src = builtin ? icon.src : spec.dataUrl;
    if (!src) return false;
    var tintColor;
    var mode = IC.tint;
    if (mode === 'original' || (mode === 'auto' && !builtin)) tintColor = null;
    else if (mode === 'white') tintColor = '#FFFFFF';
    else if (mode === 'custom') tintColor = IC.color;
    else if (mode === 'bar') tintColor = barColor;
    else tintColor = bgFill ? Bc.contrastText(bgFill) : kind === 'in' ? Bc.contrastText(barColor) : barColor;
    if (builtin && !icon.tint) tintColor = null;
    var dims = { x: x - size / 2, y: y - size / 2, width: size, height: size };
    var img = node('image', Object.assign({ preserveAspectRatio: 'xMidYMid meet' }, dims));
    img.setAttributeNS('http://www.w3.org/1999/xlink', 'href', src);
    img.setAttribute('href', src);
    if (tintColor) {
      var id = 'bc-m' + (++S.uid);
      var m = node('mask', Object.assign({ id: id, maskUnits: 'userSpaceOnUse', style: 'mask-type:alpha' }, dims));
      m.appendChild(img);
      defs.appendChild(m);
      gi.appendChild(node('rect', Object.assign({ fill: tintColor, mask: 'url(#' + id + ')' }, dims)));
    } else {
      gi.appendChild(img);
    }
    return true;
  }

  function renderLabel (g, l) {
    var gl = node('g', { class: 'lbl', 'data-k': l.key || '' });
    // value labels are clickable like their bar
    var li = l.item ? S.drawn.indexOf(l.item) : -1;
    if (li >= 0) gl.setAttribute('data-i', li);
    if (l.scale && l.scale !== 1) gl.setAttribute('transform', 'translate(' + fx(l.x) + ' ' + fx(l.y) + ') scale(' + l.scale + ') translate(' + fx(-l.x) + ' ' + fx(-l.y) + ')');
    var x = l.x; var y = l.y; var w = l.w; var h = l.h;
    if (l.bgFill) {
      var a = { fill: l.bgFill, stroke: l.bgStroke || null, 'stroke-width': l.bgStroke ? (l.badge === 'ring' ? 2.5 : 1.2) : null };
      var r = Math.max(w, h) / 2;
      switch (l.badge) {
        case 'circle': case 'ring': gl.appendChild(node('circle', Object.assign({ cx: x, cy: y, r: r }, a))); break;
        case 'hexagon': gl.appendChild(markerShape('hexagon', x, y, r * 2, a.stroke, a.fill, a['stroke-width'] || 0)); break;
        case 'diamond': gl.appendChild(markerShape('diamond', x, y, r * 1.7, a.stroke, a.fill, a['stroke-width'] || 0)); break;
        case 'pill': gl.appendChild(node('rect', Object.assign({ x: x - w / 2, y: y - h / 2, width: w, height: h, rx: h / 2 }, a))); break;
        case 'tag': {
          gl.appendChild(node('rect', Object.assign({ x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 3 }, a)));
          if (l.F) {
            var base = l.F.P(l.t - (l.F.vert ? h : w) / 2 - 4, l.F.wid / 2);
            var c1 = l.F.P(l.t - (l.F.vert ? h : w) / 2 + 0.5, l.F.wid / 2 - 4);
            var c2 = l.F.P(l.t - (l.F.vert ? h : w) / 2 + 0.5, l.F.wid / 2 + 4);
            gl.appendChild(node('polygon', { points: [base, c1, c2].map(function (p) { return p.map(fx).join(','); }).join(' '), fill: l.bgFill }));
          }
          break;
        }
        default: gl.appendChild(node('rect', Object.assign({ x: x - w / 2, y: y - h / 2, width: w, height: h, rx: 4 }, a)));
      }
    }
    gl.appendChild(node('text', {
      x: fx(x), y: fx(y + l.size * 0.35), 'text-anchor': 'middle', 'font-size': l.size, 'font-weight': l.weight,
      'font-style': l.italic ? 'italic' : null, fill: l.fill || '#17202B', 'font-family': Bc.fontStack(l.family)
    }, l.text));
    g.appendChild(gl);
  }

  function drawComments (g, nodes, labels, vert, family) {
    var C = S.cfg.comments;
    nodes.forEach(function (n) {
      var list = B.commentsOf(n);
      if (!list.length || !n.endItem) return;
      var it = n.endItem;
      var F = it.F;
      var color = list[list.length - 1].color || C.color;
      var p = F.P(F.len, F.wid);
      var gm = node('g', { class: 'comment-mark bar', 'data-i': S.drawn.length });
      S.drawn.push({ node: n, kind: 'comment', b: it.b, F: F });
      var x = p[0]; var y = p[1];
      var count = list.length > 1 ? String(list.length) : '';
      if (C.marker === 'flag') {
        gm.appendChild(node('path', { d: 'M' + x + ' ' + y + 'v-16', stroke: color, 'stroke-width': 1.5 }));
        gm.appendChild(node('path', { d: 'M' + x + ' ' + (y - 16) + 'h10l-3 4 3 4h-10z', fill: color }));
      } else if (C.marker === 'pin') {
        gm.appendChild(node('path', { d: 'M' + x + ' ' + y + 'c-5 -6 -7 -9 -7 -12a7 7 0 1 1 14 0c0 3 -2 6 -7 12z', fill: color }));
        gm.appendChild(node('circle', { cx: x, cy: y - 12, r: 2.6, fill: '#fff' }));
      } else if (C.marker === 'bubble') {
        gm.appendChild(node('path', { d: 'M' + (x - 8) + ' ' + (y - 20) + 'h16a3 3 0 0 1 3 3v8a3 3 0 0 1 -3 3h-9l-4 4v-4h-3a3 3 0 0 1 -3 -3v-8a3 3 0 0 1 3 -3z', fill: color }));
        gm.appendChild(node('text', { x: x, y: y - 11, 'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: '#fff', 'font-family': Bc.fontStack(family) }, count || '…'));
      } else {
        gm.appendChild(node('circle', { cx: x, cy: y, r: count ? 6.5 : 5, fill: color, stroke: '#fff', 'stroke-width': 1.5 }));
        if (count) gm.appendChild(node('text', { x: x, y: y + 3, 'text-anchor': 'middle', 'font-size': 8.5, 'font-weight': 700, fill: '#fff', 'font-family': Bc.fontStack(family) }, count));
      }
      g.appendChild(gm);
      if (C.display === 'callout') {
        var last = list[list.length - 1];
        var txt = B.ellipsize(last.text, C.maxWidth, C.size, 400, family);
        var lbl = B.boxLabel(txt, C.size, 400, family, 'rounded');
        lbl.bgFill = '#FFFFFF';
        lbl.bgStroke = color;
        lbl.fill = '#263244';
        lbl.prio = 1e18;
        var extra = 0;
        labels.forEach(function (l) { if (l.item === it && l.place === 'outsideEnd') extra = Math.max(extra, (vert ? l.h : l.w) + S.cfg.labels.offset); });
        B.placeOn(lbl, F, 'outsideEnd', 8 + extra);
        labels.push(lbl);
      }
    });
  }

  // Called from the other chart files as B.<name>(…).
  B.drawChart = drawChart;
})();
