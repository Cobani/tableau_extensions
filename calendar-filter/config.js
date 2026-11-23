'use strict';

/**
 * Calendar Filter — shared configuration and calendar logic.
 *
 * Loaded by the text box (index.html), the calendar window (picker.html) and the Format dialog
 * (configure.html), so all three agree on the settings, the defaults and the date arithmetic.
 *
 * Dates are whole days counted from 1 Jan 1970 (UTC), so there is no time zone or daylight-saving
 * drift anywhere. A "period" is identified by its first day plus its granularity:
 *   Y year · M month · W week (starts on calendar.weekStart) · D day.
 *
 * Settings are one JSON string under STORAGE_KEY, saved inside the workbook. The chosen dates are
 * NOT a setting: they live in the date filter on the sheet's Filters shelf (saved with the workbook,
 * shown in the Filters pane), and the text box reads them back from there.
 */
(function () {
  var clone = ExtCore.clone, merge = ExtCore.merge;

  var STORAGE_KEY = 'calendarFilter1';

  var FONTS = ['Lato', 'Tableau Book', 'Tableau Medium', 'Tableau Semibold', 'Tableau Bold', 'Benton Sans',
    'Arial', 'Helvetica Neue', 'Segoe UI', 'Roboto', 'Open Sans', 'Georgia', 'Times New Roman', 'Courier New'];

  /** The quick ranges offered in the calendar window, in the order they are listed. */
  var QUICK = [
    ['today', 'Today'], ['yesterday', 'Yesterday'], ['thisWeek', 'This week'], ['lastWeek', 'Last week'],
    ['last7', 'Last 7 days'], ['last30', 'Last 30 days'], ['mtd', 'Month to date'], ['thisMonth', 'This month'],
    ['lastMonth', 'Last month'], ['qtd', 'Quarter to date'], ['last12', 'Last 12 months'], ['ytd', 'Year to date'],
    ['thisYear', 'This year'], ['lastYear', 'Last year']
  ];
  var quickItems = {};
  QUICK.forEach(function (q) { quickItems[q[0]] = true; });

  /**
   * Every setting with the value a new filter starts with. Saved settings are merged over this,
   * so a setting added later never breaks an old workbook.
   */
  var DEFAULTS = {
    // ---- Title above the text box -------------------------------------------
    title: {
      mode: 'field', // field (the date field's name) | custom | none
      text: '', // used when mode = custom
      font: 'Lato',
      size: 11,
      weight: 700,
      color: '#68707D',
      italic: false
    },
    // ---- The text box on the dashboard ---------------------------------------
    box: {
      placeholder: 'All dates', // shown when nothing is filtered
      clearButton: true, // × in the box clears the filter without opening the calendar
      icon: true, // calendar icon at the left
      font: 'Lato',
      size: 13,
      weight: 400,
      color: '#17202B',
      italic: false,
      bgColor: '#FFFFFF',
      borderColor: '#C9CDD4',
      radius: 4, // px
      height: 24 // px
    },
    // ---- The calendar window (Tableau's dialog window) -----------------------
    window: {
      apply: 'button', // button (Apply / Cancel) | live (every click filters straight away)
      size: 'M', // S | M | L, see WINDOW_SIZES
      dialog: 'onTop', // onTop (Modal: stays in front of Tableau) | floating (Modeless)
      help: true // how-to line at the bottom (click, Shift, Ctrl/⌘, drag)
    },
    // ---- Calendar -------------------------------------------------------------
    calendar: {
      weekStart: 0, // 0 Sunday · 1 Monday · 6 Saturday
      showYear: true,
      showMonth: true,
      showWeek: true,
      showDay: true,
      openAt: 'D', // granularity shown when nothing is selected: Y | M | W | D
      adjacentDays: true // Day view: days of the previous / next month, greyed but clickable
    },
    // ---- Clicking ---------------------------------------------------------------
    selection: {
      mode: 'multi', // multi (click / Shift range / Ctrl add) | toggle (every click adds or removes) | single | range (start, end)
      drag: true, // drag across cells to select a range (multi and toggle)
      emptyPeriods: 'dim' // dim (greyed, clickable) | off (greyed, can't be clicked)
    },
    // ---- Null dates -------------------------------------------------------------
    nulls: {
      control: 'seg', // seg (Include / Exclude / Only) | check (Include checkbox) | hidden
      default: 'include' // include | exclude — also what Clear goes back to
    },
    // ---- Quick ranges (Today, Month to date, …) ----------------------------------
    quick: {
      position: 'side', // side (list on the left) | dropdown | chips | off
      anchor: 'today', // today | data (the End date tile)
      items: quickItems // which quick ranges are listed
    },
    // ---- Look of the calendar ---------------------------------------------------
    look: {
      accent: '#2E6FD8', // selected cells, buttons, focus
      font: 'Lato',
      textColor: '#17202B',
      mutedColor: '#68707D', // weekday letters, week numbers, help text
      bgColor: '#FFFFFF' // window background
    },
    // ---- Where the calendar's first and last dates come from -------------------------
    range: {
      source: 'tiles', // tiles (Start date / End date on the Marks card) | params (two date parameters)
      startParam: '', // parameter names, used when source = params
      endParam: ''
    },
    // ---- Which filter on the Filters shelf is set ---------------------------------
    filter: {
      field: '' // the filter's field name; empty = the first date filter on the shelf
    },
    card: {
      padding: 4, // px around the text box
      bgColor: '#FFFFFF',
      bgOpacity: 0
    }
  };

  /** Outer size of the calendar window, px. */
  var WINDOW_SIZES = { S: { w: 380, h: 400 }, M: { w: 480, h: 460 }, L: { w: 620, h: 520 } };

  /** Brand themes (shared/theme.js): plain look settings only. Default.json must change nothing. */
  var THEME_MAP = {
    'fonts.family': ['title.font', 'box.font', 'look.font'],
    'colors.title': ['title.color'],
    'colors.text': ['box.color', 'look.textColor'],
    'colors.muted': ['look.mutedColor'],
    'colors.axisLine': ['box.borderColor'],
    'colors.background': ['card.bgColor', 'box.bgColor', 'look.bgColor'],
    'colors.backgroundOpacity': ['card.bgOpacity']
  };

  // ---------------------------------------------------------------------------
  // Settings I/O
  // ---------------------------------------------------------------------------
  function read () {
    try {
      var raw = tableau.extensions.settings.get(STORAGE_KEY);
      return merge(DEFAULTS, raw ? JSON.parse(raw) : null);
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  function write (cfg) {
    tableau.extensions.settings.set(STORAGE_KEY, JSON.stringify(cfg));
    return tableau.extensions.settings.saveAsync();
  }

  function escHtml (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  // ---------------------------------------------------------------------------
  // Days
  // ---------------------------------------------------------------------------
  var DAY_MS = 864e5;
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  var WEEKDAY_LETTERS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  var GRAN_NAMES = { Y: 'Year', M: 'Month', W: 'Week', D: 'Day' };

  /** Day number of a calendar date (month 0-11; overflowing months / days roll over like Date.UTC). */
  function dayOf (y, m, d) { return Math.round(Date.UTC(y, m, d) / DAY_MS); }

  /** { y, m (0-11), d, w (0 Sunday) } of a day number. */
  function parts (n) {
    var t = new Date(n * DAY_MS);
    return { y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate(), w: t.getUTCDay() };
  }

  function iso (n) {
    var p = parts(n);
    return p.y + '-' + String(p.m + 1).padStart(2, '0') + '-' + String(p.d).padStart(2, '0');
  }

  /** Today on the viewer's computer, as a day number. */
  function today () {
    var t = new Date();
    return dayOf(t.getFullYear(), t.getMonth(), t.getDate());
  }

  /**
   * The day of a summary data cell, or null (null date, or not a full date: YEAR(…), "May", …).
   * Tableau sends dates as 'YYYY-MM-DD' (datetimes with a time after it) or as Date objects at
   * UTC midnight; a datetime keeps only its day.
   */
  function cellDay (cell) {
    if (!cell) return null;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    if (v == null || v === '%null%') return null;
    if (v instanceof Date) {
      if (isNaN(v.getTime())) return null;
      var utc = v.getUTCHours() === 0 && v.getUTCMinutes() === 0 && v.getUTCSeconds() === 0;
      return utc ? dayOf(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()) : dayOf(v.getFullYear(), v.getMonth(), v.getDate());
    }
    var m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(String(v).trim());
    return m ? dayOf(+m[1], +m[2] - 1, +m[3]) : null;
  }

  /** True for a cell Tableau sends for a null date. */
  function isNullCell (cell) {
    if (!cell) return false;
    var v = cell.nativeValue != null ? cell.nativeValue : cell.value;
    return v == null || v === '%null%' || (v === '' && /null/i.test(String(cell.formattedValue || '')));
  }

  // ---------------------------------------------------------------------------
  // Periods
  // ---------------------------------------------------------------------------
  /** First day of the period of granularity g that contains day n. */
  function periodStart (g, n, weekStart) {
    var p = parts(n);
    if (g === 'Y') return dayOf(p.y, 0, 1);
    if (g === 'M') return dayOf(p.y, p.m, 1);
    if (g === 'W') return n - ((p.w - (weekStart || 0) + 7) % 7);
    return n;
  }

  /** First day of the next period. */
  function periodNext (g, s) {
    var p = parts(s);
    if (g === 'Y') return dayOf(p.y + 1, 0, 1);
    if (g === 'M') return dayOf(p.y, p.m + 1, 1);
    if (g === 'W') return s + 7;
    return s + 1;
  }

  /** Every period start from a to b (both included, either order). */
  function periodRange (g, a, b) {
    var s = Math.min(a, b);
    var e = Math.max(a, b);
    var out = [];
    for (var x = s; x <= e && out.length < 100000; x = periodNext(g, x)) out.push(x);
    return out;
  }

  /**
   * Week number like Tableau's WEEK(): week 1 is the week that holds 1 January, weeks start on
   * weekStart. A week across New Year is week 1 of the new year. Returns { n, y }.
   */
  function weekNumber (s, weekStart) {
    var y = parts(s + 6).y;
    var first = periodStart('W', dayOf(y, 0, 1), weekStart);
    if (s < first) { y -= 1; first = periodStart('W', dayOf(y, 0, 1), weekStart); }
    return { n: Math.floor((s - first) / 7) + 1, y: y };
  }

  /** "1–7 Nov", "29 Oct–4 Nov", "+ year" when long. */
  function spanText (a, b, long) {
    var p = parts(a);
    var q = parts(b);
    var left = p.d + (p.m !== q.m || p.y !== q.y ? ' ' + MON[p.m] : '') + (p.y !== q.y ? ' ' + p.y : '');
    return left + '–' + q.d + ' ' + MON[q.m] + (long ? ' ' + q.y : '');
  }

  /** Label of one period: short for a cell, long for the text box and messages. */
  function label (g, s, long, weekStart) {
    var p = parts(s);
    if (g === 'Y') return String(p.y);
    if (g === 'M') return long ? MON[p.m] + ' ' + p.y : MON[p.m];
    if (g === 'D') return long ? p.d + ' ' + MON[p.m] + ' ' + p.y : String(p.d);
    var wn = weekNumber(s, weekStart);
    return long ? 'W' + wn.n + ' (' + spanText(s, s + 6, true) + ')' : 'W' + wn.n;
  }

  // ---------------------------------------------------------------------------
  // The filter state: { gran, sel: [period starts], nullState }
  // ---------------------------------------------------------------------------
  function emptyState (cfg) {
    return { gran: firstGran(cfg, cfg.calendar.openAt), sel: [], nullState: cfg.nulls.default };
  }

  /** The granularities switched on, in Year → Day order. */
  function grans (cfg) {
    var c = cfg.calendar;
    var out = [];
    if (c.showYear) out.push('Y');
    if (c.showMonth) out.push('M');
    if (c.showWeek) out.push('W');
    if (c.showDay) out.push('D');
    return out.length ? out : ['D'];
  }

  /** `want` when it is switched on, else the finest one that is. */
  function firstGran (cfg, want) {
    var list = grans(cfg);
    return list.indexOf(want) >= 0 ? want : list[list.length - 1];
  }

  /** Is anything filtered (dates picked, or nulls not at their default)? */
  function isFiltered (state, cfg) {
    return !!(state && ((state.sel && state.sel.length) || state.nullState !== cfg.nulls.default));
  }

  /**
   * The text for the text box / window: "Feb – Apr 2026, Sep 2026 +2 more". Nulls are mentioned
   * only when they differ from the default. '' when nothing is filtered.
   */
  function summary (state, cfg, maxParts) {
    if (!state) return '';
    if (state.nullState === 'only') return 'Null dates only';
    var g = state.gran;
    var ws = cfg.calendar.weekStart;
    var starts = (state.sel || []).slice().sort(function (a, b) { return a - b; });
    var runs = [];
    starts.forEach(function (s) {
      var last = runs[runs.length - 1];
      if (last && periodNext(g, last[1]) === s) last[1] = s; else runs.push([s, s]);
    });
    var texts = runs.map(function (r) {
      if (r[0] === r[1]) return label(g, r[0], true, ws);
      if (g === 'W') return 'W' + weekNumber(r[0], ws).n + '–W' + weekNumber(r[1], ws).n + ' (' + spanText(r[0], r[1] + 6, true) + ')';
      if (g === 'D') return spanText(r[0], r[1], true);
      return label(g, r[0], true, ws) + ' – ' + label(g, r[1], true, ws);
    });
    var max = maxParts || 2;
    var txt = texts.length > max ? texts.slice(0, max).join(', ') + ' +' + (texts.length - max) + ' more' : texts.join(', ');
    var def = cfg.nulls.default;
    if (!txt) return state.nullState === 'exclude' && def !== 'exclude' ? 'All dates, no null' : state.nullState === 'include' && def === 'exclude' ? 'All dates + null' : '';
    if (state.nullState === 'include' && def === 'exclude') txt += ' + null';
    if (state.nullState === 'exclude' && def === 'include') txt += ', no null';
    return txt;
  }

  /**
   * What the state selects, given the data: { days: [day numbers with data], nulls: bool,
   * all: bool (nothing to filter: clear the selection) }.
   * `dataDays` is the sorted list of days that have data.
   */
  function resolve (state, dataDays, hasNull) {
    if (state.nullState === 'only') return { days: [], nulls: true, all: false };
    var sel = state.sel || [];
    if (!sel.length) {
      if (state.nullState === 'exclude' && hasNull) return { days: dataDays.slice(), nulls: false, all: false };
      return { days: [], nulls: false, all: true };
    }
    var g = state.gran;
    var ranges = sel.map(function (s) { return [s, periodNext(g, s)]; }).sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    var j = 0;
    dataDays.forEach(function (d) {
      while (j < ranges.length && ranges[j][1] <= d) j++;
      for (var k = j; k < ranges.length && ranges[k][0] <= d; k++) if (d < ranges[k][1]) { out.push(d); break; }
    });
    return { days: out, nulls: state.nullState === 'include' && hasNull, all: false };
  }

  /**
   * Rebuilds a state from Tableau's selected marks after a reload: the coarsest granularity
   * (switched on) whose periods are each fully selected (every day with data in them), else Day.
   */
  function inferState (selectedDays, nullSelected, dataDays, cfg) {
    var ws = cfg.calendar.weekStart;
    var sel = {};
    selectedDays.forEach(function (d) { sel[d] = true; });
    if (!selectedDays.length) {
      return { gran: firstGran(cfg, cfg.calendar.openAt), sel: [], nullState: nullSelected ? 'only' : cfg.nulls.default };
    }
    var all = dataDays.every(function (d) { return sel[d]; });
    var list = grans(cfg);
    var g;
    var starts = null;
    for (var i = 0; i < list.length && !starts; i++) {
      g = list[i];
      var byPeriod = {};
      dataDays.forEach(function (d) {
        var s = periodStart(g, d, ws);
        var b = byPeriod[s] || (byPeriod[s] = { any: false, full: true });
        if (sel[d]) b.any = true; else b.full = false;
      });
      var ok = true;
      var picked = [];
      Object.keys(byPeriod).forEach(function (k) {
        var b = byPeriod[k];
        if (b.any && !b.full) ok = false;
        if (b.any) picked.push(+k);
      });
      if (ok) starts = picked;
    }
    if (!starts) { g = 'D'; starts = selectedDays.slice(); }
    starts.sort(function (a, b) { return a - b; });
    // Every date picked and no nulls: that is "All dates, nulls excluded".
    if (all && !nullSelected) return { gran: firstGran(cfg, cfg.calendar.openAt), sel: [], nullState: 'exclude' };
    return { gran: g, sel: starts, nullState: nullSelected ? 'include' : 'exclude' };
  }

  // ---------------------------------------------------------------------------
  // Quick ranges
  // ---------------------------------------------------------------------------
  /** { g, a, b }: the granularity and first / last period start of a quick range, counted back from `anchor`. */
  function quickRange (id, anchor, weekStart) {
    var p = parts(anchor);
    var ws = weekStart || 0;
    var wk = periodStart('W', anchor, ws);
    switch (id) {
      case 'today': return { g: 'D', a: anchor, b: anchor };
      case 'yesterday': return { g: 'D', a: anchor - 1, b: anchor - 1 };
      case 'thisWeek': return { g: 'W', a: wk, b: wk };
      case 'lastWeek': return { g: 'W', a: wk - 7, b: wk - 7 };
      case 'last7': return { g: 'D', a: anchor - 6, b: anchor };
      case 'last30': return { g: 'D', a: anchor - 29, b: anchor };
      case 'mtd': return { g: 'D', a: dayOf(p.y, p.m, 1), b: anchor };
      case 'thisMonth': return { g: 'M', a: dayOf(p.y, p.m, 1), b: dayOf(p.y, p.m, 1) };
      case 'lastMonth': return { g: 'M', a: dayOf(p.y, p.m - 1, 1), b: dayOf(p.y, p.m - 1, 1) };
      case 'qtd': return { g: 'D', a: dayOf(p.y, Math.floor(p.m / 3) * 3, 1), b: anchor };
      case 'last12': return { g: 'M', a: dayOf(p.y, p.m - 11, 1), b: dayOf(p.y, p.m, 1) };
      case 'ytd': return { g: 'D', a: dayOf(p.y, 0, 1), b: anchor };
      case 'thisYear': return { g: 'Y', a: dayOf(p.y, 0, 1), b: dayOf(p.y, 0, 1) };
      case 'lastYear': return { g: 'Y', a: dayOf(p.y - 1, 0, 1), b: dayOf(p.y - 1, 0, 1) };
    }
    return null;
  }

  /** The quick ranges to list: switched on, and their granularity is switched on. */
  function quickList (cfg) {
    if (cfg.quick.position === 'off') return [];
    var on = grans(cfg);
    return QUICK.filter(function (q) { return cfg.quick.items[q[0]] !== false && on.indexOf(quickRange(q[0], 0, 0).g) >= 0; });
  }

  /**
   * The how-to text at the bottom of the calendar window, for the click behaviour in use.
   * rangeOnly: the date filter is a range of dates, so Ctrl/⌘ can't add separate values.
   */
  function helpText (cfg, rangeOnly) {
    var s = cfg.selection;
    var mod = /Mac|iPhone|iPad/.test((typeof navigator !== 'undefined' && navigator.platform) || '') ? '⌘' : 'Ctrl';
    if (s.mode === 'single') return 'Click: pick one · Click it again: clear';
    if (s.mode === 'range') return 'Click the first, then the last to pick a range · Click again to start over';
    var parts = rangeOnly
      ? ['Click: pick one', 'Shift-click: range']
      : s.mode === 'toggle'
        ? ['Click: add or remove', 'Shift-click: add a range']
        : ['Click: pick one', 'Shift-click: range', mod + '-click: add or remove'];
    if (s.drag) parts.push('Drag: range');
    return parts.join(' · ');
  }

  window.Cf = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    FONTS: FONTS,
    QUICK: QUICK,
    WINDOW_SIZES: WINDOW_SIZES,
    MON: MON,
    MONTH_NAMES: MONTH_NAMES,
    WEEKDAY_LETTERS: WEEKDAY_LETTERS,
    GRAN_NAMES: GRAN_NAMES,
    clone: clone,
    merge: merge,
    read: read,
    write: write,
    escHtml: escHtml,
    fontStack: ExtCore.fontStack,
    normalizeHex: ExtCore.normalizeHex,
    rgba: ExtCore.rgba,
    formatScaled: ExtCore.formatScaled,
    dayOf: dayOf,
    parts: parts,
    iso: iso,
    today: today,
    cellDay: cellDay,
    isNullCell: isNullCell,
    periodStart: periodStart,
    periodNext: periodNext,
    periodRange: periodRange,
    weekNumber: weekNumber,
    label: label,
    spanText: spanText,
    grans: grans,
    firstGran: firstGran,
    emptyState: emptyState,
    isFiltered: isFiltered,
    summary: summary,
    resolve: resolve,
    inferState: inferState,
    quickRange: quickRange,
    quickList: quickList,
    helpText: helpText
  };
})();
