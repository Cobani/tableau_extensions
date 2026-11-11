'use strict';

/**
 * Cohort Grid — shared configuration.
 *
 * Loaded by both the chart (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, number formatting,
 * colour palettes and the built-in icon set (the same set as KPI Card 3 and
 * Waterfall).
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var clone = ExtCore.clone, normalizeHex = ExtCore.normalizeHex, rgb = ExtCore.rgb, rgba = ExtCore.rgba,
    mix = ExtCore.mix, tint = ExtCore.tint, fontStack = ExtCore.fontStack, merge = ExtCore.merge,
    pickScale = ExtCore.pickScale, fixed = ExtCore.fixed, formatScaled = ExtCore.formatScaled,
    SCALES = ExtCore.SCALES;

  var STORAGE_KEY = 'cohortGrid1';

  /** Font families offered in the dialog. "Lato" ships with the extension. */
  var FONTS = [
    'Lato',
    'IBM Plex Sans',
    'Tableau Book',
    'Tableau Medium',
    'Tableau Semibold',
    'Tableau Bold',
    'Benton Sans',
    'Arial',
    'Helvetica Neue',
    'Segoe UI',
    'Roboto',
    'Open Sans',
    'Georgia',
    'Times New Roman',
    'Courier New'
  ];

  /**
   * Number format: KPI Card's "Big number" options plus Waterfall's signs.
   * Used globally (Numbers tab) and, when the scope is "each", by every part
   * of the chart that writes numbers.
   */
  var FORMAT = {
    scale: 'dynamic', // none | K | M | B | dynamic | workbook | percent | percentDynamic
    decimals: 1,
    pctFromRatio: true, // percent formats: value is a 0–1 ratio (0.4523 → 45.23%)
    thousands: true, // 1,284,500 vs 1284500
    unit: '',
    unitPosition: 'suffix', // suffix | prefix
    unitSpace: true, // "12.5 M SAR" vs "12.5MSAR"
    plusSign: false, // "+262.1" on positive values
    negStyle: 'minus' // minus (−201.4) | hyphen (-201.4) | paren ((201.4))
  };

  function fmtCopy (over) {
    var f = JSON.parse(JSON.stringify(FORMAT));
    Object.keys(over || {}).forEach(function (k) { f[k] = over[k]; });
    return f;
  }


  /** Text style block (headers). */
  function textStyle (over) {
    var s = { font: 'Lato', size: 12, weight: 700, color: '#27357E', italic: false, upper: false, letterSpacing: 0 };
    Object.keys(over || {}).forEach(function (k) { s[k] = over[k]; });
    return s;
  }

  var SORTS = [['asc', 'Oldest first (ascending)'], ['desc', 'Newest first (descending)']];

  var PERIOD_UNITS = [['auto', 'Automatic (smallest gap in the data)'], ['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];

  var DEFAULTS = {
    // ---- Header + card (Icon and Title & text = KPI Card; Card = Waterfall) --
    icon: {
      show: true,
      source: 'builtin', // builtin | upload | shape
      builtinId: 'fg-table',
      size: 24,
      color: '#EB644C',
      dataUrl: '',
      name: ''
    },
    title: {
      show: true,
      text: '', // empty → "<Value> by <Cohort>"
      align: 'left', // left | center | right
      font: 'Lato',
      size: 16,
      weight: 500,
      color: '#68707D',
      italic: false
    },
    explanation: {
      show: true,
      reserveSpace: false,
      text: '',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: true
    },
    // ---- Data ---------------------------------------------------------------
    data: {
      maxRows: 1000 // rows read from the worksheet; 0 = no limit (Format → Card → Maximum rows)
    },
    card: {
      padding: 15,
      bgColor: '#FFFFFF',
      bgOpacity: 0,
      gap: 10, // space between the header and the grid
      plotBg: '#FFFFFF',
      plotBgOpacity: 0
    },

    // ---- Numbers (cell values in "Value" mode, cohort sizes, tooltip) --------
    numbers: {
      font: 'Lato' // font of all grid text
    },
    format: fmtCopy({ scale: 'none', decimals: 0 }),

    // ---- Period --------------------------------------------------------------
    period: {
      unit: 'auto' // date periods: the step between periods (see PERIOD_UNITS); numeric periods ignore it
    },

    // ---- Values: what a cell shows --------------------------------------------
    values: {
      show: 'pct', // value | pct (% of cohort size: retention) | pctPrev (% of the previous period)
      decimals: 0, // decimals of the percentages
      hidePeriod0: false, // hide the first column when it is always 100 % (or empty, as % of previous)
      emptyText: '', // text in cells with no data
      zeroText: '' // empty → write the number; e.g. "0" or "–" to write something else for zero
    },

    // ---- Heat map --------------------------------------------------------------
    heat: {
      mode: 'ramp', // ramp (light → dark) | none (one colour)
      low: '#EAF0FB',
      high: '#2F4B7C',
      minMode: 'auto', // auto (lowest shown value) | fixed
      min: 0, // fixed minimum, in what the cells show (percent modes: 0–100)
      maxMode: 'auto',
      max: 100,
      scope: 'grid', // grid (one scale for the whole grid) | row (each cohort its own scale)
      autoText: true, // white text on dark cells
      noneBg: '#EAF0FB', // cell colour when mode is none
      emptyBg: '#F6F7F9', // background of cells with no data
      emptyOpacity: 100
    },

    // ---- Layout ----------------------------------------------------------------
    layout: {
      cellMinWidth: 52, // px; columns share the width but never get narrower
      rowHeight: 32, // px
      gap: 2, // px between cells
      radius: 4, // px, rounded cells
      showSize: true, // first column shows the cohort size next to the label
      summary: 'none', // none | top | bottom: a row with the average of each period
      summaryLabel: 'Average',
      freeze: true // headers stay in view while scrolling
    },

    // ---- Sort and limits -------------------------------------------------------
    sort: {
      cohorts: 'asc', // asc | desc (dates sort as dates)
      lastCohorts: 0, // keep only the last N cohorts (0 = all)
      firstPeriods: 0 // keep only the first N periods (0 = all)
    },

    // ---- Headers -----------------------------------------------------------------
    headers: {
      periodLabel: 'M{n}', // {n} = the period number: "M{n}", "Month {n}", "+{n}"
      cornerText: 'Cohort', // top-left cell
      sizeLabel: 'Size', // header of the size part of the first column
      col: textStyle({ size: 11, weight: 700, color: '#27357E' }),
      row: textStyle({ size: 12, weight: 700, color: '#27357E' }),
      size: textStyle({ size: 11, weight: 400, color: '#68707D' }),
      cornerStyle: textStyle({ size: 11, weight: 400, color: '#8C96A3', italic: true }),
      colAlign: 'center', // left | center | right
      bg: '#FFFFFF',
      bgOpacity: 0,
      summaryBold: true
    },

    // ---- Cells --------------------------------------------------------------------
    cells: {
      main: { font: 'Lato', size: 12, weight: 600, color: '#17202B', italic: false }
    },

    // ---- Tooltip + interaction ---------------------------------------------------
    tooltip: {
      show: true,
      fullNumbers: true // no K / M / B in the tooltip
    },
    interaction: {
      rightClickMenu: true,
      hover: true, // outline the cell under the mouse
      hoverColor: '#EB644C',
      dblclick: 'format', // format | none
      dialog: 'onTop', // onTop (modal: stays in front of Tableau) | floating (modeless: can go behind Tableau)
      selectInTableau: true, // click a cell selects its cohort and period; click a cohort label selects the cohort
      tableauTooltip: false // show the tooltip designed in Tableau instead of this extension's own
    },

    // ---- Export ---------------------------------------------------------------------
    export: {
      button: 'hover', // hover | always | never
      fileName: '', // empty → the title
      includeTitle: true, // Excel (as shown): title and explanation on top
      picture: true // Save as picture (PNG) entry in the export menu
    }
  };


  // -------------------------------------------------------------------------
  // Built-in icons: only the Figma "Icons for Extension" set (icons.js).
  // -------------------------------------------------------------------------
  var ICONS = (window.KPI3_FIGMA_ICONS || []).map(function (ic) {
    var o = {}; for (var k in ic) o[k] = ic[k]; o.figma = true; return o;
  });

  var ICON_GROUPS = ['Chart icons', 'Others'];

  function findIcon (id) {
    var fallback = ICONS[0];
    for (var i = 0; i < ICONS.length; i++) {
      if (ICONS[i].id === id) return ICONS[i];
      if (ICONS[i].id === DEFAULTS.icon.builtinId) fallback = ICONS[i];
    }
    return fallback;
  }

  function iconSize (icon, target) {
    var t = Number(target) > 0 ? Number(target) : 24;
    var w = icon.w || 24;
    var h = icon.h || 24;
    return w >= h
      ? { w: t, h: Math.max(1, Math.round(t * h / w)) }
      : { w: Math.max(1, Math.round(t * w / h)), h: t };
  }

  function iconHtml (id, color, target) {
    var icon = findIcon(id);
    var size = iconSize(icon, target);
    var html;
    if (icon.src) {
      if (icon.tint) {
        var m = 'url(' + icon.src + ') center / contain no-repeat';
        html = '<span class="kpi3-icon-mask" style="display:block;width:' + size.w + 'px;height:' + size.h +
          'px;background-color:' + color + ';-webkit-mask:' + m + ';mask:' + m + '"></span>';
      } else {
        html = '<img src="' + icon.src + '" alt="" width="' + size.w + '" height="' + size.h +
          '" style="display:block;width:' + size.w + 'px;height:' + size.h + 'px">';
      }
    } else {
      var paint = icon.mode === 'stroke'
        ? 'fill="none" stroke="' + color + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"'
        : 'fill="' + color + '"';
      html = '<svg xmlns="http://www.w3.org/2000/svg" width="' + size.w + '" height="' + size.h + '" viewBox="0 0 24 24" style="display:block">' +
        '<path ' + paint + ' d="' + icon.d + '"/></svg>';
    }
    return { html: html, w: size.w, h: size.h, icon: icon };
  }

  function iconSvg (id, color) { return iconHtml(id, color).html; }

  // -------------------------------------------------------------------------
  // Settings I/O
  // -------------------------------------------------------------------------

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


  // -------------------------------------------------------------------------
  // Number formatting
  // -------------------------------------------------------------------------

  /**
   * Formats a number with a format object (see FORMAT).
   *   opts.signed      write "+" on positive values (when the format asks for it)
   *   opts.fv          Tableau's formatted value (Workbook format)
   *   opts.forceScale  reuse a K/M/B suffix (axis ticks share one)
   *   opts.noUnit      leave the unit off
   *   opts.abs         drop the sign (diverging axis)
   *   opts.full        no K/M/B (tooltips)
   */
  function formatNumber (v, f, opts) {
    opts = opts || {};
    f = f || FORMAT;
    if (v == null || !isFinite(v)) return '—';
    if (opts.abs) v = Math.abs(v);
    var body;
    var neg = v < 0;
    var a = Math.abs(v);
    var scale = f.scale;
    if (opts.full) {
      if (scale === 'workbook' && opts.fv) return String(opts.fv);
      if (scale === 'percentDynamic') scale = 'percent';
      else if (scale !== 'percent') scale = 'none';
    }
    var dec = f.decimals;
    if (opts.full && scale === 'none' && a !== Math.round(a)) dec = Math.max(dec, 2);
    if (scale === 'percent' || scale === 'percentDynamic') {
      var p = f.pctFromRatio ? a * 100 : a;
      body = formatScaled(p, scale === 'percentDynamic' ? 'dynamic' : 'none', dec,
        scale === 'percentDynamic' ? opts.forceScale : '', f.thousands) + '%';
    } else if (scale === 'workbook' && opts.fv) {
      body = String(opts.fv).replace(/^[-−(]\s*/, '').replace(/\)$/, '');
    } else {
      var sc = scale === 'workbook' ? 'dynamic' : scale;
      body = formatScaled(a, sc, dec, opts.forceScale, f.thousands);
    }
    if (!/[1-9]/.test(body)) neg = false;
    if (!opts.noUnit && f.unit) {
      var sp = f.unitSpace === false ? '' : ' ';
      body = f.unitPosition === 'prefix' ? f.unit + sp + body : body + sp + f.unit;
    }
    if (neg) {
      if (f.negStyle === 'paren') return '(' + body + ')';
      return (f.negStyle === 'hyphen' ? '-' : '−') + body;
    }
    if (opts.signed && f.plusSign && /[1-9]/.test(body)) return '+' + body;
    return body;
  }

  // -------------------------------------------------------------------------
  // Dates
  // -------------------------------------------------------------------------
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  /** Date from a Tableau cell value (Date, ISO text, "2024", "Jan 2024", "Q1 2024", "January"…). */
  function parseDate (v) {
    if (v instanceof Date) return isNaN(v) ? null : v;
    if (v == null) return null;
    if (typeof v === 'number') {
      if (v >= 1000 && v <= 9999) return new Date(v, 0, 1);
      return null;
    }
    var s = String(v).trim();
    var m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) return new Date(+m[1], +m[2] - 1, +m[3]);
    if ((m = /^(\d{4})$/.exec(s))) return new Date(+m[1], 0, 1);
    if ((m = /^Q([1-4])\s*[-/ ]?\s*(\d{4})$/i.exec(s))) return new Date(+m[2], (+m[1] - 1) * 3, 1);
    if ((m = /^(\d{4})\s*[-/ ]?\s*Q([1-4])$/i.exec(s))) return new Date(+m[1], (+m[2] - 1) * 3, 1);
    if ((m = /^Q([1-4])$/i.exec(s))) return new Date(2000, (+m[1] - 1) * 3, 1);
    var mi = monthIndex(s.split(/[\s,-]+/)[0]);
    if (mi >= 0) {
      var y = /(\d{4})/.exec(s);
      var yy = /\b(\d{2})$/.exec(s);
      return new Date(y ? +y[1] : yy ? 2000 + +yy[1] : 2000, mi, 1);
    }
    if ((m = /^(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(s))) {
      // Ambiguous d/m vs m/d: Tableau's US format is m/d.
      var a = +m[1]; var b = +m[2];
      return a > 12 ? new Date(+m[3], b - 1, a) : new Date(+m[3], a - 1, b);
    }
    var t = Date.parse(s);
    return isNaN(t) ? null : new Date(t);
  }

  function monthIndex (s) {
    var k = String(s || '').slice(0, 3).toLowerCase();
    for (var i = 0; i < 12; i++) if (MONTHS[i].toLowerCase() === k) return i;
    return -1;
  }

  function pad2 (n) { return (n < 10 ? '0' : '') + n; }

  function formatDate (d, pattern) {
    if (!(d instanceof Date) || isNaN(d)) return '';
    return pattern.replace(/yyyy|yy|MMMM|MMM|MM|dd|Qq|q/g, function (t) {
      switch (t) {
        case 'yyyy': return String(d.getFullYear());
        case 'yy': return pad2(d.getFullYear() % 100);
        case 'MMMM': return MONTHS_LONG[d.getMonth()];
        case 'MMM': return MONTHS[d.getMonth()];
        case 'MM': return pad2(d.getMonth() + 1);
        case 'dd': return pad2(d.getDate());
        case 'Qq': return 'Q' + (Math.floor(d.getMonth() / 3) + 1);
        case 'q': return String(Math.floor(d.getMonth() / 3) + 1);
      }
      return t;
    });
  }

  var DATE_FORMATS = [['auto', 'As Tableau writes it'], ['MMM yyyy', 'Jan 2026'], ['MMM yy', 'Jan 26'], ['MMM', 'Jan'],
    ['MMMM', 'January'], ['yyyy', '2026'], ['Qq yyyy', 'Q1 2026'], ['dd MMM', '05 Jan'], ['dd MMM yyyy', '05 Jan 2026'],
    ['dd/MM/yyyy', '05/01/2026'], ['MM/dd/yyyy', '01/05/2026'], ['yyyy-MM-dd', '2026-01-05']];

  // -------------------------------------------------------------------------
  // Sorting
  // -------------------------------------------------------------------------
  function comparer (order, val, name) {
    var byName = function (a, b) { return String(name(a)).localeCompare(String(name(b)), undefined, { numeric: true, sensitivity: 'base' }); };
    switch (order) {
      case 'valDesc': return function (a, b) { return val(b) - val(a); };
      case 'valAsc': return function (a, b) { return val(a) - val(b); };
      case 'desc': return function (a, b) { return Math.abs(val(b)) - Math.abs(val(a)); };
      case 'asc': return function (a, b) { return Math.abs(val(a)) - Math.abs(val(b)); };
      case 'name': case 'nameAsc': return byName;
      case 'nameDesc': return function (a, b) { return byName(b, a); };
      default: return null;
    }
  }

  function sortBy (list, cmp) {
    if (!cmp) return list.slice();
    return list.map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) { return cmp(a.x, b.x) || a.i - b.i; })
      .map(function (o) { return o.x; });
  }

  // -------------------------------------------------------------------------
  // Colours
  // -------------------------------------------------------------------------

  /** −100 … 100: towards black … towards white. */
  function blend (hex, amount) {
    var a = Math.max(-100, Math.min(100, Number(amount) || 0)) / 100;
    return a < 0 ? mix(hex, '#000000', -a) : mix(hex, '#FFFFFF', a);
  }

  function luminance (hex) {
    var c = rgb(hex).map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrastText (hex) { return luminance(hex) > 0.36 ? '#17202B' : '#FFFFFF'; }

  function dashArray (style, width) {
    var w = Math.max(0.5, Number(width) || 1);
    if (style === 'dashed') return (3 * w) + ',' + (3 * w);
    if (style === 'dotted') return w + ',' + (2 * w);
    return '';
  }

  // -------------------------------------------------------------------------
  // Excel number formats (export): the same look as formatNumber, as an
  // Excel format code. `value` picks the K / M / B suffix for dynamic scales.
  // -------------------------------------------------------------------------
  function excelQuote (s) { return '"' + String(s).replace(/"/g, '') + '"'; }

  function excelNumFmt (f, value) {
    f = f || FORMAT;
    var scale = f.scale;
    var d = Math.max(0, Math.min(10, Number(f.decimals) || 0));
    var body = (f.thousands !== false ? '#,##0' : '0') + (d ? '.' + new Array(d + 1).join('0') : '');
    var suffix = '';
    if (scale === 'percent' || scale === 'percentDynamic') {
      body += '%';
    } else {
      var sc = scale === 'dynamic' || scale === 'workbook' ? pickScale(value || 0, 'dynamic') : (SCALES[scale] ? scale : '');
      var commas = { K: ',', M: ',,', B: ',,,', T: ',,,,' }[sc] || '';
      body += commas;
      if (sc) suffix = excelQuote(sc);
    }
    var pos = body + suffix;
    if (f.unit) {
      var sp = f.unitSpace === false ? '' : ' ';
      pos = f.unitPosition === 'prefix' ? excelQuote(f.unit + sp) + pos : pos + excelQuote(sp + f.unit);
    }
    var neg = f.negStyle === 'paren' ? '(' + pos + ')' : '-' + pos;
    var p = f.plusSign ? '+' + pos : pos;
    return p + ';' + neg + ';' + pos;
  }

  /** The value Excel stores for a number shown with format f (percent of a 0–100 value → ratio). */
  function excelValue (v, f) {
    if ((f.scale === 'percent' || f.scale === 'percentDynamic') && !f.pctFromRatio) return v / 100;
    return v;
  }

  var THEME_MAP = {
    'fonts.family': ['title.font', 'explanation.font', 'numbers.font', 'cells.main.font', 'headers.col.font', 'headers.row.font', 'headers.size.font', 'headers.cornerStyle.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.titleWeight': ['title.weight'],
    'fonts.textSize': ['explanation.size'],
    'colors.title': ['title.color'],
    'colors.muted': ['explanation.color', 'headers.size.color'],
    'colors.accent': ['icon.color', 'interaction.hoverColor'],
    'colors.accent2': ['heat.high'],
    'colors.background': ['card.bgColor', 'card.plotBg', 'headers.bg'],
    'colors.backgroundOpacity': ['card.bgOpacity', 'card.plotBgOpacity', 'headers.bgOpacity'],
    'card.padding': ['card.padding'],
    'numbers.negative': ['format.negStyle']
  };

  window.Cg = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    FORMAT: FORMAT,
    SORTS: SORTS,
    PERIOD_UNITS: PERIOD_UNITS,
    textStyle: textStyle,
    FONTS: FONTS,
    ICONS: ICONS,
    ICON_GROUPS: ICON_GROUPS,
    findIcon: findIcon,
    iconHtml: iconHtml,
    iconSvg: iconSvg,
    clone: clone,
    merge: merge,
    read: read,
    write: write,
    fmtCopy: fmtCopy,
    excelNumFmt: excelNumFmt,
    excelValue: excelValue,
    pickScale: pickScale,
    fixed: fixed,
    formatScaled: formatScaled,
    formatNumber: formatNumber,
    parseDate: parseDate,
    formatDate: formatDate,
    comparer: comparer,
    sortBy: sortBy,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba,
    mix: mix,
    tint: tint,
    blend: blend,
    luminance: luminance,
    contrastText: contrastText,
    dashArray: dashArray
  };
})();
