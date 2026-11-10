/**
 * Bar Chart: the card around the plot. Card style, header (icon, title, explanation), drill
 * breadcrumb, legend.
 *
 * DOM outside the svg only; the plot itself is drawn in chart-draw.js.
 */
'use strict';

(function () {
  const B = window.BcChart, S = B.S; // shared namespace and mutable state, see chart-state.js
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc;

  function applyFont (node, f) {
    node.style.fontFamily = Bc.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = S.cfg.card;
    S.el.card.style.padding = c.padding + 'px';
    S.el.card.style.backgroundColor = c.bgOpacity > 0 ? Bc.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    S.el.body.style.marginTop = c.gap + 'px';
    S.el.plot.style.backgroundColor = c.plotBgOpacity > 0 ? Bc.rgba(c.plotBg, c.plotBgOpacity / 100) : 'transparent';
  }

  function paintHeader (v) {
    var ic = S.cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    S.el.card.classList.toggle('no-icon', !showIcon);
    S.el.icon.style.display = showIcon ? '' : 'none';
    S.el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Bc.iconHtml(ic.builtinId, ic.color, B.iconTarget());
        S.el.icon.innerHTML = r.html;
        setIconBox(r.w, r.h);
      } else if (ic.mask && ic.dataUrl) {
        // uploaded image as a one-colour shape, like the built-ins: follows Size and Color
        var t = B.iconTarget();
        var iw = ic.w || 1; var ih = ic.h || 1;
        var W = iw >= ih ? t : Math.max(1, Math.round(t * iw / ih));
        var H = iw >= ih ? Math.max(1, Math.round(t * ih / iw)) : t;
        var mk = 'url(' + ic.dataUrl + ') center / contain no-repeat';
        S.el.icon.innerHTML = '<span class="kpi3-icon-mask" style="display:block;width:' + W + 'px;height:' + H + 'px;background-color:' + ic.color +
          ';-webkit-mask:' + mk + ';mask:' + mk + '"></span>';
        setIconBox(W, H);
      } else {
        var img = new Image();
        img.alt = '';
        img.onload = function () { sizeImageIcon(img); };
        img.src = ic.dataUrl;
        S.el.icon.appendChild(img);
        if (img.complete) sizeImageIcon(img);
      }
    }

    t = S.cfg.title;
    applyFont(S.el.title, t);
    S.el.title.textContent = t.text ? B.fillParams(t.text) : B.defaultTitle(v);
    S.el.title.style.textAlign = t.align || 'left';
    S.el.title.style.display = t.show === false ? 'none' : '';

    var ex = S.cfg.explanation;
    var exText = B.fillParams(ex.text);
    var hasText = ex.show && !!exText;
    applyFont(S.el.explanation, ex);
    S.el.explanation.style.textAlign = t.align || 'left';
    S.el.explanation.textContent = hasText ? exText : ' ';
    S.el.explanation.style.display = hasText || ex.reserveSpace ? '' : 'none';

    var headVisible = showIcon || t.show !== false || hasText || ex.reserveSpace;
    S.el.card.classList.toggle('no-head', !headVisible);
    if (!headVisible) S.el.body.style.marginTop = '0px';
    updateIconSpan();
  }

  function sizeImageIcon (img) {
    var t = B.iconTarget();
    var w = img.naturalWidth || t;
    var h = img.naturalHeight || t;
    var W, H;
    if (w >= h) { W = t; H = Math.max(1, Math.round(t * h / w)); } else { H = t; W = Math.max(1, Math.round(t * w / h)); }
    img.style.width = W + 'px';
    img.style.height = H + 'px';
    setIconBox(W, H);
  }
  function setIconBox (w, h) {
    S.el.icon.style.width = w + 'px';
    S.el.icon.style.height = h + 'px';
    S.iconBoxH = h;
    updateIconSpan();
  }

  function updateIconSpan () {
    var head = S.el.icon.parentNode;
    var titleH = S.el.title.offsetHeight || 19;
    var hasExplanation = S.el.explanation.style.display !== 'none';
    head.classList.toggle('icon-span', hasExplanation && S.iconBoxH > titleH * 1.5);
  }

  // ---------------------------------------------------------------------------
  // Drill breadcrumb
  // ---------------------------------------------------------------------------
  function paintDrillbar (v) {
    var on = B.isDrilled() && S.cfg.drill.showBar;
    S.el.drillbar.classList.toggle('is-on', on);
    S.el.drillbar.innerHTML = '';
    if (!on) return;
    var back = button('‹ Back', B.drillUp);
    var reset = button('Reset', B.resetDrill);
    var crumb = document.createElement('span');
    crumb.className = 'crumb';
    var D = S.cfg.drill;
    if (D.mode === 'focus') {
      var labels = S.state.focus.map(function (k) { var n = B.findNode(v.base, k); return n ? n.label : ''; });
      crumb.innerHTML = 'All › ' + labels.map(function (l, i) { return i === labels.length - 1 ? '<b>' + esc(l) + '</b>' : esc(l); }).join(' › ');
    } else if (D.mode === 'expandAll') {
      crumb.innerHTML = 'Showing <b>' + esc(S.raw.dims.slice(0, S.state.level).map(function (d) { return d.name; }).join(' › ')) + '</b>';
    } else {
      var names = Object.keys(S.state.expanded).map(function (k) { var n = B.findNode(v.base, k); return n ? n.label : null; }).filter(Boolean);
      crumb.innerHTML = 'Expanded: <b>' + esc(names.join(', ')) + '</b>';
    }
    S.el.drillbar.append(back, reset, crumb);
  }

  function button (text, fn) {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = text;
    b.addEventListener('click', fn);
    return b;
  }

  function paintLegend (v) {
    var L = S.cfg.legend;
    var lg = S.el.legend;
    lg.innerHTML = '';
    lg.style.maxHeight = ''; lg.style.overflowY = ''; lg.style.overflowX = '';
    S.el.body.className = 'body legend-' + L.position;
    if (!L.show) return;
    var items = B.legendItems(v);
    if (L.autoHide && items.length <= 1 && !items.some(function (i) { return i.ramp; })) return;
    lg.style.fontFamily = Bc.fontStack(L.font);
    lg.style.fontSize = L.size + 'px';
    lg.style.fontWeight = String(L.weight);
    lg.style.color = L.color;
    lg.style.columnGap = L.gap + 'px';
    var vertical = L.position === 'left' || L.position === 'right';
    lg.style.justifyContent = vertical ? 'center' : (L.align === 'center' ? 'center' : L.align === 'end' ? 'flex-end' : 'flex-start');
    lg.style.alignItems = vertical ? (L.align === 'center' ? 'center' : L.align === 'end' ? 'flex-end' : 'flex-start') : 'center';
    lg.classList.toggle('is-boxed', !!L.box);
    lg.style.background = L.box ? L.boxColor : '';
    lg.style.borderColor = L.box ? L.boxBorder : '';
    if (L.showTitle) {
      var t = document.createElement('span');
      t.className = 'lg-title';
      t.textContent = L.title || (v.cmode === 'dimensions' && S.raw.dimFields[B.dimLevelOf()] ? S.raw.dimFields[B.dimLevelOf()].name : v.cmode === 'measures' ? 'Measures' : 'Legend');
      lg.appendChild(t);
    }
    var fmt = B.fmtOf(S.cfg.labels.fmt);
    items.forEach(function (it) {
      var d = document.createElement('span');
      d.className = 'lg-item';
      if (it.ramp) {
        var lo = Infinity; var hi = -Infinity;
        v.nodes.forEach(function (n) { n.bars.forEach(function (b) { var x = S.cfg.colors.valueField && S.cfg.colors.valueField !== '__self' && n.vals[S.cfg.colors.valueField] ? n.vals[S.cfg.colors.valueField].v : b.v; lo = Math.min(lo, x); hi = Math.max(hi, x); }); });
        d.innerHTML = '<span>' + esc(Bc.formatNumber(lo, fmt)) + '</span><span class="lg-ramp" style="background:linear-gradient(90deg,' +
          S.cfg.colors.lowColor + ',' + S.cfg.colors.highColor + ')"></span><span>' + esc(Bc.formatNumber(hi, fmt)) + '</span>';
        lg.appendChild(d);
        return;
      }
      d.appendChild(legendMark(it));
      var nm = document.createElement('span');
      nm.className = 'lg-name';
      nm.textContent = it.name;
      d.appendChild(nm);
      if (L.showValues && it.value != null && isFinite(it.value)) {
        var vl = document.createElement('span');
        vl.className = 'lg-val';
        vl.textContent = Bc.formatNumber(it.value, it.fmt || fmt);
        d.appendChild(vl);
      }
      if (it.key && S.state.off[it.key]) d.classList.add('is-off');
      if (it.key && it.toggle && L.interactive) {
        d.classList.add('is-click');
        d.title = 'Click to hide or show';
        d.addEventListener('click', function () {
          if (S.state.off[it.key]) delete S.state.off[it.key]; else S.state.off[it.key] = true;
          S.state.animate = false;
          B.paint();
        });
      }
      if (it.hover && L.hoverHighlight) {
        d.addEventListener('mouseenter', function () { B.setHover(it.hover); });
        d.addEventListener('mouseleave', function () { B.setHover(null); });
      }
      lg.appendChild(d);
    });
    B.capLegend(lg, vertical);
  }

  function legendMark (it) {
    var L = S.cfg.legend;
    var s = Math.max(4, L.markerSize);
    var m = document.createElement('span');
    m.className = 'lg-mark';
    if (it.line || it.ref || it.target) {
      var dash = it.ref ? Bc.dashArray(it.ref.style, 2) : it.line ? Bc.dashArray(it.line.style, 2) : '';
      m.innerHTML = '<svg width="' + (s * 2) + '" height="' + s + '" viewBox="0 0 ' + (s * 2) + ' ' + s + '"><line x1="0" x2="' + (s * 2) + '" y1="' + (s / 2) +
        '" y2="' + (s / 2) + '" stroke="' + it.color + '" stroke-width="2" stroke-dasharray="' + dash + '"/>' +
        (it.line && it.line.marker !== 'none' ? '<circle cx="' + s + '" cy="' + (s / 2) + '" r="' + Math.min(3.5, s / 2) + '" fill="#fff" stroke="' + it.color + '" stroke-width="1.5"/>' : '') + '</svg>';
      return m;
    }
    var shape = L.marker;
    m.style.width = (shape === 'bar' ? s * 1.8 : shape === 'line' ? s * 2 : s) + 'px';
    m.style.height = (shape === 'line' ? 3 : shape === 'bar' ? s * 0.7 : s) + 'px';
    m.style.background = it.color;
    m.style.borderRadius = shape === 'circle' ? '50%' : shape === 'rounded' ? Math.round(s / 3) + 'px' : shape === 'line' ? '2px' : shape === 'bar' ? '2px' : '1px';
    return m;
  }

  // Called from the other chart files as B.<name>(…).
  B.paintCard = paintCard;
  B.paintHeader = paintHeader;
  B.paintDrillbar = paintDrillbar;
  B.button = button;
  B.paintLegend = paintLegend;
})();
