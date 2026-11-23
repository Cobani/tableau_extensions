'use strict';

/**
 * Calendar Filter — the calendar window (picker.html), opened by a click on the text box.
 *
 * It is a Tableau dialog window, so it can be larger than the extension zone. It can't read the
 * worksheet: the text box sends the dates that have data, their Value, and the filter in force
 * (see chart.js). Settings (look, granularities, click behaviour…) are read from the workbook.
 *
 * Apply mode (Format → Window):
 *   button  the choice is a draft until Apply; Cancel / Esc / × leave the dashboard as it was
 *   live    every change is sent straight to the text box, which filters the dashboard
 */
(function () {
  var cfg = null;
  var data = null;    // { days, cum (prefix sums of values), hasValues, hasNull, nullValue, field, maxDay }
  var st = null;      // the draft: { gran, sel: Set of period starts, nullState }
  var page = { y: 2026, m: 0 };
  var ui = { anchor: null, pending: null, menu: false };
  var drag = null;
  var el = {};
  var live = false;
  var canMessage = false;

  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      cfg = Cf.read();
      var p = {};
      try { p = JSON.parse(payload || '{}'); } catch (e) { p = {}; }
      data = prepare(p);
      var s = p.state || Cf.emptyState(cfg);
      st = { gran: Cf.firstGran(cfg, s.gran || cfg.calendar.openAt), sel: new Set(Array.isArray(s.sel) ? s.sel : []), nullState: s.nullState || cfg.nulls.default };
      if (!st.sel.size && s.gran !== st.gran) st.gran = Cf.firstGran(cfg, cfg.calendar.openAt);
      if (!st.sel.size) st.gran = Cf.firstGran(cfg, cfg.calendar.openAt);
      if (cfg.nulls.control === 'hidden' && !st.sel.size) st.nullState = cfg.nulls.default;
      live = cfg.window.apply === 'live';
      canMessage = !!(tableau.extensions.ui && tableau.extensions.ui.sendDialogMessageToParentAsync);
      var last = Array.from(st.sel).sort(function (a, b) { return b - a; })[0];
      var at = Cf.parts(last != null ? last : (data.maxDay != null ? data.maxDay : Cf.today()));
      page = { y: at.y, m: at.m };
      ['root', 'title', 'hdr', 'chips', 'side', 'grid', 'draft', 'nulls', 'actions', 'help', 'menu'].forEach(function (id) { el[id] = document.getElementById(id); });
      wire();
      render();
    }).catch(function (err) {
      console.error('Calendar Filter: the calendar window failed to start', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Data from the text box
  // ---------------------------------------------------------------------------
  function prepare (p) {
    var days = Array.isArray(p.days) ? p.days.slice() : [];
    var vals = Array.isArray(p.values) && p.values.length === days.length ? p.values : null;
    var cum = [0];
    for (var i = 0; i < days.length; i++) cum.push(cum[i] + (vals ? (Number(vals[i]) || 0) : 1));
    var y = Cf.parts(Cf.today()).y;
    return {
      days: days,
      cum: cum,
      hasValues: !!vals,
      hasNull: !!p.hasNull,
      nullValue: Number(p.nullValue) || 0,
      field: p.field || 'Date',
      maxDay: p.maxDay != null ? p.maxDay : null,
      minY: days.length ? Math.min(Cf.parts(days[0]).y, y) : y,
      maxY: days.length ? Math.max(Cf.parts(days[days.length - 1]).y, y) : y
    };
  }

  /** First index with days[i] >= d. */
  function lower (d) {
    var lo = 0;
    var hi = data.days.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (data.days[mid] < d) lo = mid + 1; else hi = mid; }
    return lo;
  }

  /** { n: dates with data, v: summed Value } for the days a ≤ d < b. */
  function stats (a, b) {
    var i = lower(a);
    var j = lower(b);
    return { n: j - i, v: data.cum[j] - data.cum[i] };
  }

  function pstats (g, s) { return stats(s, Cf.periodNext(g, s)); }

  // ---------------------------------------------------------------------------
  // Sending the result
  // ---------------------------------------------------------------------------
  function stateOut () {
    return { gran: st.gran, sel: Array.from(st.sel).sort(function (a, b) { return a - b; }), nullState: st.nullState };
  }

  /** After every change: redraw, and in live mode tell the text box. */
  function changed () {
    render();
    if (live && canMessage) {
      try {
        Promise.resolve(tableau.extensions.ui.sendDialogMessageToParentAsync(JSON.stringify({ type: 'state', state: stateOut() }))).catch(function (e) {
          console.warn('Calendar Filter: live update not sent', e);
        });
      } catch (e) { canMessage = false; }
    }
  }

  function close (type) {
    var body = { type: type };
    if (type !== 'cancel') body.state = stateOut();
    tableau.extensions.ui.closeDialog(JSON.stringify(body));
  }

  // ---------------------------------------------------------------------------
  // Clicking
  // ---------------------------------------------------------------------------
  function isOff (g, s) { return cfg.selection.emptyPeriods === 'off' && pstats(g, s).n === 0; }

  function setGran (g) {
    if (g === st.gran) return;
    st.gran = g; st.sel = new Set(); ui.anchor = null; ui.pending = null;
  }

  function rangeOf (a, b) { return Cf.periodRange(st.gran, a, b).filter(function (s) { return !isOff(st.gran, s); }); }

  function clickCell (s, ev) {
    var g = st.gran;
    if (isOff(g, s)) return;
    if (st.nullState === 'only') st.nullState = 'include';
    var mode = cfg.selection.mode;
    var ctrl = ev.ctrlKey || ev.metaKey;
    if (mode === 'single') {
      if (st.sel.has(s) && st.sel.size === 1) st.sel = new Set(); else st.sel = new Set([s]);
      return;
    }
    if (mode === 'range') {
      if (ui.pending == null) { ui.pending = s; st.sel = new Set([s]); } else { st.sel = new Set(rangeOf(ui.pending, s)); ui.pending = null; }
      return;
    }
    if (ev.shiftKey && ui.anchor != null) {
      var r = rangeOf(ui.anchor, s);
      if (ctrl || mode === 'toggle') r.forEach(function (x) { st.sel.add(x); }); else st.sel = new Set(r);
      return;
    }
    if (ctrl || mode === 'toggle') {
      if (st.sel.has(s)) st.sel.delete(s); else st.sel.add(s);
      ui.anchor = s;
      return;
    }
    if (st.sel.size === 1 && st.sel.has(s)) { st.sel = new Set(); ui.anchor = null; return; }
    st.sel = new Set([s]);
    ui.anchor = s;
  }

  function applyQuick (id) {
    var anchor = cfg.quick.anchor === 'data' && data.maxDay != null ? data.maxDay : Cf.today();
    var q = Cf.quickRange(id, anchor, cfg.calendar.weekStart);
    if (!q) return;
    st.gran = q.g;
    st.sel = new Set(Cf.periodRange(q.g, q.a, q.b));
    ui.anchor = q.b; ui.pending = null;
    if (st.nullState === 'only') st.nullState = cfg.nulls.default;
    var e = Cf.parts(q.b);
    page = { y: e.y, m: e.m };
  }

  function wire () {
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') { if (ui.menu) { ui.menu = false; render(); } else close(live ? 'close' : 'cancel'); }
    });
    el.grid.addEventListener('mousedown', function (ev) {
      var cell = ev.target.closest('[data-s]');
      if (!cell || ev.button !== 0) return;
      ev.preventDefault();
      var s = +cell.getAttribute('data-s');
      var mode = cfg.selection.mode;
      if (cfg.selection.drag && (mode === 'multi' || mode === 'toggle') && !ev.shiftKey && !isOff(st.gran, s)) {
        var ctrl = ev.ctrlKey || ev.metaKey;
        drag = { from: s, to: s, base: (mode === 'toggle' || ctrl) ? new Set(st.sel) : new Set(), moved: false, ev: { shiftKey: false, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey } };
      } else {
        clickCell(s, ev);
        changed();
      }
    });
    el.grid.addEventListener('mouseover', function (ev) {
      if (!drag) return;
      var cell = ev.target.closest('[data-s]');
      if (!cell) return;
      var s = +cell.getAttribute('data-s');
      if (s === drag.to) return;
      drag.to = s;
      if (s === drag.from && !drag.moved) return;
      drag.moved = true;
      var next = new Set(drag.base);
      rangeOf(drag.from, s).forEach(function (x) { next.add(x); });
      st.sel = next;
      render(); // the dashboard is told once, on release
    });
    document.addEventListener('mouseup', function () {
      if (!drag) return;
      var d = drag;
      drag = null;
      if (!d.moved) clickCell(d.from, d.ev);
      else ui.anchor = d.from;
      changed();
    });
    document.addEventListener('click', function (ev) {
      var t = ev.target;
      var b;
      if ((b = t.closest('[data-g]'))) { setGran(b.getAttribute('data-g')); ui.menu = false; changed(); return; }
      if ((b = t.closest('[data-nav]'))) {
        var dir = +b.getAttribute('data-nav');
        if (st.gran === 'M') page.y += dir; else { var n = page.y * 12 + page.m + dir; page.y = Math.floor(n / 12); page.m = ((n % 12) + 12) % 12; }
        render();
        return;
      }
      if (t.closest('[data-menu]')) { ui.menu = !ui.menu; render(); return; }
      if ((b = t.closest('[data-q]'))) { ui.menu = false; applyQuick(b.getAttribute('data-q')); changed(); return; }
      if ((b = t.closest('[data-null]'))) { st.nullState = b.getAttribute('data-null'); changed(); return; }
      if (t.closest('[data-clear]')) {
        st.sel = new Set(); st.nullState = cfg.nulls.default; ui.anchor = null; ui.pending = null;
        changed();
        return;
      }
      if (t.closest('[data-apply]')) { close('apply'); return; }
      if (t.closest('[data-cancel]')) { close('cancel'); return; }
      if (t.closest('[data-done]')) { close('close'); return; }
      if (ui.menu && !t.closest('#menu')) { ui.menu = false; render(); }
    });
    document.addEventListener('change', function (ev) {
      if (ev.target.hasAttribute('data-nullchk')) { st.nullState = ev.target.checked ? 'include' : 'exclude'; changed(); }
    });
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  var esc = Cf.escHtml;

  function fmtValue (v) { return Cf.formatScaled(v, 'dynamic', Math.abs(v) >= 1000 ? 1 : 0); }

  function heat (v, max) {
    if (!cfg.look.heat || !v || !max) return '';
    return 'background:' + Cf.rgba(cfg.look.accent, 0.06 + 0.34 * (v / max)) + ';';
  }

  function cell (g, s, text, cls, max, withNumber) {
    var ps = pstats(g, s);
    var c = 'cell';
    if (st.sel.has(s)) c += ' is-sel';
    if (!ps.n) c += ' is-empty';
    if (isOff(g, s)) c += ' is-off';
    if (ui.pending === s) c += ' is-pending';
    if (cls) c += ' ' + cls;
    var tip = Cf.label(g, s, true, cfg.calendar.weekStart) + (ps.n ? (data.hasValues ? ' — ' + fmtValue(ps.v) : '') : ' — no data');
    var num = withNumber !== false && cfg.look.cellNumbers && data.hasValues && ps.n ? '<small>' + esc(fmtValue(ps.v)) + '</small>' : '';
    return '<div class="' + c + '" data-s="' + s + '" title="' + esc(tip) + '" style="' + heat(ps.v, max) + '">' + text + num + '</div>';
  }

  function weekdayHead () {
    var ws = cfg.calendar.weekStart;
    var out = [];
    for (var i = 0; i < 7; i++) out.push(Cf.WEEKDAY_LETTERS[(i + ws) % 7]);
    return out;
  }

  function gridHtml () {
    var g = st.gran;
    var ws = cfg.calendar.weekStart;
    var items = [];
    var max = 0;
    var wide = window.innerWidth >= 540;
    if (g === 'Y') {
      for (var y = data.minY; y <= data.maxY; y++) items.push(Cf.dayOf(y, 0, 1));
      items.forEach(function (s) { max = Math.max(max, pstats(g, s).v); });
      var cols = Math.min(items.length, 4);
      return { cls: 'grid--years', style: 'grid-template-columns:repeat(' + cols + ',1fr);grid-auto-rows:minmax(0,64px)', html: items.map(function (s) { return cell(g, s, Cf.label(g, s, false, ws), '', max); }).join('') };
    }
    if (g === 'M') {
      for (var m = 0; m < 12; m++) items.push(Cf.dayOf(page.y, m, 1));
      items.forEach(function (s) { max = Math.max(max, pstats(g, s).v); });
      return { cls: 'grid--months', style: 'grid-template-columns:repeat(' + (wide ? 4 : 3) + ',1fr);grid-auto-rows:1fr', html: items.map(function (s) { return cell(g, s, Cf.label(g, s, false, ws), '', max); }).join('') };
    }
    var mStart = Cf.dayOf(page.y, page.m, 1);
    var mEnd = Cf.dayOf(page.y, page.m + 1, 1) - 1;
    var first = Cf.periodStart('W', mStart, ws);
    var head = weekdayHead();
    var s;
    if (g === 'W') {
      for (s = first; s <= mEnd; s += 7) items.push(s);
      items.forEach(function (x) { max = Math.max(max, pstats('W', x).v); });
      var hd = '<div class="wrow wrow--head"><span class="wnum"></span>' + head.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '<span class="wval"></span></div>';
      return {
        cls: 'grid--weeks',
        style: 'grid-template-columns:1fr;grid-template-rows:auto repeat(' + items.length + ',1fr)',
        html: hd + items.map(function (x) {
          var inner = '<span class="wnum">W' + Cf.weekNumber(x, ws).n + '</span>';
          for (var i = 0; i < 7; i++) {
            var p = Cf.parts(x + i);
            inner += '<span class="' + (p.m !== page.m ? 'is-out' : '') + '">' + p.d + '</span>';
          }
          var ps = pstats('W', x);
          inner += '<span class="wval">' + (cfg.look.cellNumbers && data.hasValues && ps.n ? esc(fmtValue(ps.v)) : '') + '</span>';
          return cell('W', x, inner, 'wrow', max, false);
        }).join('')
      };
    }
    var rows = 0;
    for (s = first; s <= mEnd; s += 7) rows++;
    for (var k = 0; k < rows * 7; k++) items.push(first + k);
    items.forEach(function (x) { if (Cf.parts(x).m === page.m) max = Math.max(max, pstats('D', x).v); });
    return {
      cls: 'grid--days',
      style: 'grid-template-columns:repeat(7,1fr);grid-template-rows:auto repeat(' + rows + ',1fr)',
      html: head.map(function (x) { return '<div class="wkhd">' + x + '</div>'; }).join('') + items.map(function (x) {
        var out = Cf.parts(x).m !== page.m;
        if (out && !cfg.calendar.adjacentDays) return '<div class="cell is-blank"></div>';
        return cell('D', x, String(Cf.parts(x).d), out ? 'is-out' : '', max);
      }).join('')
    };
  }

  function navBounds () {
    if (st.gran === 'M') return [page.y > data.minY, page.y < data.maxY];
    return [page.y * 12 + page.m > data.minY * 12, page.y * 12 + page.m < data.maxY * 12 + 11];
  }

  function render () {
    var L = cfg.look;
    var root = document.documentElement.style;
    root.setProperty('--accent', L.accent);
    root.setProperty('--text', L.textColor);
    root.setProperty('--muted', L.mutedColor);
    root.setProperty('--bg', L.bgColor);
    root.setProperty('--line', Cf.rgba(L.textColor, 0.14));
    root.setProperty('--soft', Cf.rgba(L.accent, 0.08));
    document.body.style.fontFamily = Cf.fontStack(L.font);

    var short = window.innerWidth < 440;
    el.title.textContent = data.field;

    // Header: granularity buttons, page navigation, quick-range dropdown
    var h = '<div class="seg" role="group" aria-label="Granularity">' + Cf.grans(cfg).map(function (g) {
      return '<button type="button" data-g="' + g + '" class="' + (g === st.gran ? 'is-on' : '') + '" aria-pressed="' + (g === st.gran) + '">' + (short ? g : Cf.GRAN_NAMES[g]) + '</button>';
    }).join('') + '</div>';
    if (st.gran === 'Y') {
      h += '<div class="nav"><span>' + data.minY + (data.maxY !== data.minY ? ' – ' + data.maxY : '') + '</span></div>';
    } else {
      var nb = navBounds();
      var pt = st.gran === 'M' ? String(page.y) : (short ? Cf.MON[page.m] : Cf.MONTH_NAMES[page.m]) + ' ' + page.y;
      h += '<div class="nav"><button type="button" data-nav="-1" aria-label="Previous"' + (nb[0] ? '' : ' disabled') + '>‹</button><span>' + pt + '</span><button type="button" data-nav="1" aria-label="Next"' + (nb[1] ? '' : ' disabled') + '>›</button></div>';
    }
    var quick = Cf.quickList(cfg);
    if (cfg.quick.position === 'dropdown' && quick.length) h += '<button type="button" class="pbtn" data-menu="1" aria-haspopup="menu">Quick ranges ▾</button>';
    el.hdr.innerHTML = h;

    el.chips.innerHTML = cfg.quick.position === 'chips' ? quick.map(function (q) { return '<button type="button" data-q="' + q[0] + '">' + esc(q[1]) + '</button>'; }).join('') : '';
    el.chips.style.display = cfg.quick.position === 'chips' && quick.length ? '' : 'none';
    el.side.innerHTML = cfg.quick.position === 'side' ? quick.map(function (q) { return '<button type="button" data-q="' + q[0] + '">' + esc(q[1]) + '</button>'; }).join('') : '';
    el.side.style.display = cfg.quick.position === 'side' && quick.length ? '' : 'none';
    el.menu.innerHTML = quick.map(function (q) { return '<button type="button" data-q="' + q[0] + '">' + esc(q[1]) + '</button>'; }).join('');
    el.menu.style.display = ui.menu && cfg.quick.position === 'dropdown' ? '' : 'none';

    var gr = gridHtml();
    el.grid.className = 'grid ' + gr.cls;
    el.grid.setAttribute('style', gr.style);
    el.grid.innerHTML = gr.html;

    var sum = Cf.summary(stateOut(), cfg, 3);
    el.draft.textContent = (live ? 'Filter: ' : 'Selected: ') + (sum || cfg.box.placeholder);

    var n = '';
    if (data.hasNull) { // no null dates in the data: nothing to choose
      if (cfg.nulls.control === 'seg') {
        n = '<span class="lbl">Null dates</span><div class="seg seg--sm" role="group" aria-label="Null dates">' + [['include', 'Include'], ['exclude', 'Exclude'], ['only', 'Only']].map(function (o) {
          return '<button type="button" data-null="' + o[0] + '" class="' + (st.nullState === o[0] ? 'is-on' : '') + '" aria-pressed="' + (st.nullState === o[0]) + '">' + o[1] + '</button>';
        }).join('') + '</div>';
      } else if (cfg.nulls.control === 'check') {
        n = '<label class="chk"><input type="checkbox" data-nullchk' + (st.nullState !== 'exclude' ? ' checked' : '') + '> Include null dates</label>';
      }
    }
    el.nulls.innerHTML = n;

    el.actions.innerHTML = '<button type="button" class="link" data-clear="1">Clear</button>' + (live
      ? '<button type="button" class="btn btn--primary" data-done="1">Close</button>'
      : '<button type="button" class="btn" data-cancel="1">Cancel</button><button type="button" class="btn btn--primary" data-apply="1">Apply</button>');

    el.help.textContent = Cf.helpText(cfg) + ' · Esc: ' + (live ? 'close' : 'cancel');
    el.help.style.display = cfg.window.help ? '' : 'none';
  }

  window.addEventListener('resize', function () { if (cfg) render(); });

  window.CalendarFilterPicker = { init: init, _stats: function (a, b) { return stats(a, b); } };
})();
