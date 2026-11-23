'use strict';

/**
 * Calendar Filter — the calendar window (picker.html), opened by a click on the text box.
 *
 * It is a Tableau dialog window, so it can be larger than the extension zone. It can't read the
 * worksheet: the text box sends the Start / End dates, the days that have data (when the date
 * filter lists them) and the filter in force (see chart.js). Settings (look, granularities, click
 * behaviour…) are read from the workbook.
 *
 * Only days between Start and End can be picked. With a "range of dates" filter (rangeOnly) the
 * choice is always one continuous range: whatever is picked is filled from the first to the last.
 *
 * Apply mode (Format → Window):
 *   button  the choice is a draft until Apply; Cancel / Esc / × leave the dashboard as it was
 *   live    every change is sent straight to the text box, which sets the filter
 */
(function () {
  var cfg = null;
  var data = null;    // { start, end, days (null = all), set, rangeOnly, hasNull, field, minY, maxY }
  var st = null;      // the draft: { gran, sel: Set of period starts, nullState }
  var page = { y: 2026, m: 0 };
  var ui = { anchor: null, pending: null, menu: false, note: '' };
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
      var sel = Array.isArray(s.sel) ? s.sel : [];
      st = { gran: sel.length ? Cf.firstGran(cfg, s.gran) : Cf.firstGran(cfg, cfg.calendar.openAt), sel: new Set(sel), nullState: s.nullState || cfg.nulls.default };
      if (cfg.nulls.control === 'hidden' && !st.sel.size) st.nullState = cfg.nulls.default;
      live = cfg.window.apply === 'live';
      canMessage = !!(tableau.extensions.ui && tableau.extensions.ui.sendDialogMessageToParentAsync);
      var last = Array.from(st.sel).sort(function (a, b) { return b - a; })[0];
      var at = Cf.parts(last != null ? Math.min(Math.max(last, data.start), data.end) : data.end);
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
    var t = Cf.today();
    var start = typeof p.start === 'number' ? p.start : t - 365;
    var end = typeof p.end === 'number' ? p.end : t;
    var days = Array.isArray(p.days) ? p.days.slice().sort(function (a, b) { return a - b; }) : null;
    var set = null;
    if (days) { set = {}; days.forEach(function (d) { set[d] = true; }); }
    return {
      start: Math.min(start, end),
      end: Math.max(start, end),
      days: days,
      set: set,
      rangeOnly: !!p.rangeOnly,
      hasNull: !!p.hasNull,
      field: p.field || 'Date',
      minY: Cf.parts(Math.min(start, end)).y,
      maxY: Cf.parts(Math.max(start, end)).y
    };
  }

  /** Does the day have data? (Every day between Start and End when the filter doesn't list its values.) */
  function hasData (d) { return d >= data.start && d <= data.end && (!data.set || !!data.set[d]); }

  /** Days in the period [s, next) that can be picked, and how many have data. */
  function pinfo (g, s) {
    var e = Cf.periodNext(g, s);
    var lo = Math.max(s, data.start);
    var hi = Math.min(e - 1, data.end);
    if (lo > hi) return { inRange: false, n: 0 };
    var n = 0;
    if (!data.set) n = hi - lo + 1;
    else for (var d = lo; d <= hi; d++) if (data.set[d]) n++;
    return { inRange: true, n: n };
  }

  // ---------------------------------------------------------------------------
  // Sending the result
  // ---------------------------------------------------------------------------
  function stateOut () {
    return { gran: st.gran, sel: Array.from(st.sel).sort(function (a, b) { return a - b; }), nullState: st.nullState };
  }

  /** A "range of dates" filter holds one continuous range: fill the gaps. */
  function fillRange () {
    if (!data.rangeOnly || st.sel.size < 2) return;
    var list = Array.from(st.sel).sort(function (a, b) { return a - b; });
    var full = Cf.periodRange(st.gran, list[0], list[list.length - 1]);
    if (full.length !== list.length) {
      st.sel = new Set(full);
      ui.note = 'This date filter is a range, so the dates in between are included.';
    }
  }

  /** After every change: redraw, and in live mode tell the text box. */
  function changed () {
    fillRange();
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
  /** Can't be picked: outside Start – End, or (when set so) no data. */
  function isOff (g, s) {
    var i = pinfo(g, s);
    return !i.inRange || (cfg.selection.emptyPeriods === 'off' && i.n === 0);
  }

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
    var ctrl = (ev.ctrlKey || ev.metaKey) && !data.rangeOnly; // a range filter can't hold separate values
    if (mode === 'single') {
      if (st.sel.has(s) && st.sel.size === 1) st.sel = new Set(); else st.sel = new Set([s]);
      return;
    }
    if (mode === 'range') {
      if (ui.pending == null) { ui.pending = s; st.sel = new Set([s]); } else { st.sel = new Set(rangeOf(ui.pending, s)); ui.pending = null; }
      return;
    }
    var toggle = mode === 'toggle' && !data.rangeOnly;
    if (ev.shiftKey && ui.anchor != null) {
      var r = rangeOf(ui.anchor, s);
      if (ctrl || toggle) r.forEach(function (x) { st.sel.add(x); }); else st.sel = new Set(r);
      return;
    }
    if (ctrl || toggle) {
      if (st.sel.has(s)) st.sel.delete(s); else st.sel.add(s);
      ui.anchor = s;
      return;
    }
    if (st.sel.size === 1 && st.sel.has(s)) { st.sel = new Set(); ui.anchor = null; return; }
    st.sel = new Set([s]);
    ui.anchor = s;
  }

  function applyQuick (id) {
    var anchor = cfg.quick.anchor === 'data' ? data.end : Cf.today();
    var q = Cf.quickRange(id, anchor, cfg.calendar.weekStart);
    if (!q) return;
    st.gran = q.g;
    var list = Cf.periodRange(q.g, q.a, q.b).filter(function (s) { return pinfo(q.g, s).inRange; });
    st.sel = new Set(list);
    ui.anchor = q.b; ui.pending = null;
    ui.note = list.length ? '' : 'That range is outside the Start and End dates.';
    if (st.nullState === 'only') st.nullState = cfg.nulls.default;
    var e = Cf.parts(Math.min(Math.max(q.b, data.start), data.end));
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
      ui.note = '';
      var s = +cell.getAttribute('data-s');
      var mode = cfg.selection.mode;
      if (cfg.selection.drag && (mode === 'multi' || mode === 'toggle') && !ev.shiftKey && !isOff(st.gran, s)) {
        var add = (mode === 'toggle' || ev.ctrlKey || ev.metaKey) && !data.rangeOnly;
        drag = { from: s, to: s, base: add ? new Set(st.sel) : new Set(), moved: false, ev: { shiftKey: false, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey } };
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
      if ((b = t.closest('[data-g]'))) { setGran(b.getAttribute('data-g')); ui.menu = false; ui.note = ''; changed(); return; }
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
        st.sel = new Set(); st.nullState = cfg.nulls.default; ui.anchor = null; ui.pending = null; ui.note = '';
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

  function cell (g, s, text, cls) {
    var i = pinfo(g, s);
    var c = 'cell';
    if (st.sel.has(s)) c += ' is-sel';
    if (!i.inRange) c += ' is-outside';
    else if (!i.n) c += ' is-empty';
    if (isOff(g, s)) c += ' is-off';
    if (ui.pending === s) c += ' is-pending';
    if (cls) c += ' ' + cls;
    var tip = Cf.label(g, s, true, cfg.calendar.weekStart) + (!i.inRange ? ' — outside the Start and End dates' : !i.n ? ' — no data' : '');
    return '<div class="' + c + '" data-s="' + s + '" title="' + esc(tip) + '">' + text + '</div>';
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
    var wide = window.innerWidth >= 540;
    if (g === 'Y') {
      for (var y = data.minY; y <= data.maxY; y++) items.push(Cf.dayOf(y, 0, 1));
      var cols = Math.min(items.length, 4);
      return { cls: 'grid--years', style: 'grid-template-columns:repeat(' + cols + ',1fr);grid-auto-rows:minmax(0,64px)', html: items.map(function (s) { return cell(g, s, Cf.label(g, s, false, ws)); }).join('') };
    }
    if (g === 'M') {
      for (var m = 0; m < 12; m++) items.push(Cf.dayOf(page.y, m, 1));
      return { cls: 'grid--months', style: 'grid-template-columns:repeat(' + (wide ? 4 : 3) + ',1fr);grid-auto-rows:1fr', html: items.map(function (s) { return cell(g, s, Cf.label(g, s, false, ws)); }).join('') };
    }
    var mStart = Cf.dayOf(page.y, page.m, 1);
    var mEnd = Cf.dayOf(page.y, page.m + 1, 1) - 1;
    var first = Cf.periodStart('W', mStart, ws);
    var head = weekdayHead();
    var s;
    if (g === 'W') {
      for (s = first; s <= mEnd; s += 7) items.push(s);
      var hd = '<div class="wrow wrow--head"><span class="wnum"></span>' + head.map(function (x) { return '<span>' + x + '</span>'; }).join('') + '</div>';
      return {
        cls: 'grid--weeks',
        style: 'grid-template-columns:1fr;grid-template-rows:auto repeat(' + items.length + ',1fr)',
        html: hd + items.map(function (x) {
          var inner = '<span class="wnum">W' + Cf.weekNumber(x, ws).n + '</span>';
          for (var i = 0; i < 7; i++) {
            var p = Cf.parts(x + i);
            var off = p.m !== page.m || !hasData(x + i);
            inner += '<span class="' + (off ? 'is-out' : '') + '">' + p.d + '</span>';
          }
          return cell('W', x, inner, 'wrow');
        }).join('')
      };
    }
    var rows = 0;
    for (s = first; s <= mEnd; s += 7) rows++;
    for (var k = 0; k < rows * 7; k++) items.push(first + k);
    return {
      cls: 'grid--days',
      style: 'grid-template-columns:repeat(7,1fr);grid-template-rows:auto repeat(' + rows + ',1fr)',
      html: head.map(function (x) { return '<div class="wkhd">' + x + '</div>'; }).join('') + items.map(function (x) {
        var out = Cf.parts(x).m !== page.m;
        if (out && !cfg.calendar.adjacentDays) return '<div class="cell is-blank"></div>';
        return cell('D', x, String(Cf.parts(x).d), out ? 'is-out' : '');
      }).join('')
    };
  }

  function navBounds () {
    var a = Cf.parts(data.start);
    var b = Cf.parts(data.end);
    if (st.gran === 'M') return [page.y > a.y, page.y < b.y];
    return [page.y * 12 + page.m > a.y * 12 + a.m, page.y * 12 + page.m < b.y * 12 + b.m];
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
    el.title.textContent = data.field + ' · ' + Cf.label('D', data.start, true) + ' – ' + Cf.label('D', data.end, true);

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

    var qb = function (q) { return '<button type="button" data-q="' + q[0] + '">' + esc(q[1]) + '</button>'; };
    el.chips.innerHTML = cfg.quick.position === 'chips' ? quick.map(qb).join('') : '';
    el.chips.style.display = cfg.quick.position === 'chips' && quick.length ? '' : 'none';
    el.side.innerHTML = cfg.quick.position === 'side' ? quick.map(qb).join('') : '';
    el.side.style.display = cfg.quick.position === 'side' && quick.length ? '' : 'none';
    el.menu.innerHTML = cfg.quick.position === 'dropdown' ? quick.map(qb).join('') : '';
    el.menu.style.display = ui.menu && cfg.quick.position === 'dropdown' ? '' : 'none';

    var gr = gridHtml();
    el.grid.className = 'grid ' + gr.cls;
    el.grid.setAttribute('style', gr.style);
    el.grid.innerHTML = gr.html;

    var sum = Cf.summary(stateOut(), cfg, 3);
    el.draft.textContent = ui.note || (live ? 'Filter: ' : 'Selected: ') + (sum || cfg.box.placeholder);
    el.draft.classList.toggle('is-note', !!ui.note);

    var n = '';
    if (data.hasNull) { // no null dates: nothing to choose
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

    el.help.textContent = Cf.helpText(cfg, data.rangeOnly) + ' · Esc: ' + (live ? 'close' : 'cancel');
    el.help.style.display = cfg.window.help ? '' : 'none';
  }

  window.addEventListener('resize', function () { if (cfg) render(); });

  window.CalendarFilterPicker = { init: init };
})();
