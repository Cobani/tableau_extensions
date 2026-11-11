'use strict';

/**
 * MaturityLadder — shared configuration.
 *
 * Loaded by both the chart (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, number formatting and
 * the built-in icon set (the same icon set as KPI Card 3).
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var clone = ExtCore.clone, normalizeHex = ExtCore.normalizeHex, rgb = ExtCore.rgb, rgba = ExtCore.rgba,
    tint = ExtCore.tint, fontStack = ExtCore.fontStack, merge = ExtCore.merge, pickScale = ExtCore.pickScale,
    fixed = ExtCore.fixed, formatScaled = ExtCore.formatScaled;

  var STORAGE_KEY = 'maturityLadder1';

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
   * Number format — the same options as KPI Card 3's "Big number" tab, plus
   * how signs are written. Used globally (Numbers tab) and, when the scope is
   * "each label", copied into every label that shows a number.
   */
  var FORMAT = {
    scale: 'dynamic', // none | K | M | B | dynamic | workbook | percent | percentDynamic
    decimals: 1,
    pctFromRatio: true, // percent formats: value is a 0–1 ratio (0.4523 → 45.23%)
    unit: '',
    unitPosition: 'suffix', // suffix | prefix
    plusSign: true, // "+262.1" on increases
    negStyle: 'minus' // minus (−201.4) | hyphen (-201.4) | paren ((201.4))
  };

  function fmtCopy () { return JSON.parse(JSON.stringify(FORMAT)); }

  /** Bucket sizes (Format → Chart). auto picks the unit that gives at most about 36 buckets. */
  var UNITS = [['auto', 'Automatic'], ['week', 'Week'], ['month', 'Month'], ['quarter', 'Quarter'], ['year', 'Year']];

  /** Chart text styles. */
  function font (size, weight, color) { return { size: size, weight: weight, color: color }; }

  var DEFAULTS = {
    icon: {
      show: true,
      source: 'builtin', // builtin | upload | shape
      builtinId: 'fg-bar-chart-solid',
      size: 24,
      color: '#EB644C',
      dataUrl: '',
      name: ''
    },
    title: {
      text: '', // empty → "Maturity ladder"
      font: 'Lato',
      size: 16,
      weight: 500,
      color: '#68707D',
      italic: false
    },
    explanation: {
      show: true,
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
      divider: false,
      dividerColor: '#E2E4E8',
      gap: 10 // space between the header and the chart
    },

    // ---- Numbers (global) ------------------------------------------------
    numbers: {
      mode: 'all', // all (one format for every number) | each (the labels have their own)
      font: 'Lato' // font of all chart text
    },
    format: (function () { var f = fmtCopy(); f.plusSign = false; return f; })(),

    // ---- Buckets: how amounts are grouped in time ----------------------------
    buckets: {
      unit: 'auto', // auto | week | month | quarter | year (auto: the smallest unit with at most about 36 buckets)
      overdue: false, // one extra bar on the left for everything dated before today
      overdueLabel: 'Overdue',
      later: 0, // 0 = off; N = everything more than N buckets after today goes into one "Later" bar on the right
      laterLabel: 'Later'
    },

    // ---- Bars ---------------------------------------------------------------
    bars: {
      width: 70, // bar width, % of the space of one bucket
      radius: 2, // corner radius, px
      colorMode: 'single', // single | group (palette, one colour per Group member) | distance (by how far from today)
      color: '#2F4B7C', // single colour
      palette: ['#2F4B7C', '#EB644C', '#0E7C66', '#D98A1B', '#7A5195', '#3C9BC4', '#B4431E', '#68707D', '#9AA9C4', '#C4A484'],
      otherColor: '#B8BFCA', // the "Other" group (more than 12 groups)
      // distance: colour of a bucket by how far it starts from today, in months
      near: 3, // up to this many months → colour 1
      mid: 12, // up to → colour 2
      far: 36, // up to → colour 3; beyond → colour 4
      overdueColor: '#B4431E',
      distColors: ['#D98A1B', '#3C9BC4', '#2F4B7C', '#9AA9C4'],
      gap: 1 // px between stacked segments
    },

    // ---- Today marker and highlight ------------------------------------------
    today: {
      show: true,
      date: '', // empty → the real today; "YYYY-MM-DD" fixes it (for testing)
      label: 'Today',
      color: '#C2410C',
      lineStyle: 'dashed', // solid | dashed | dotted
      lineWidth: 1.5,
      highlightNext: 0, // shade the next N buckets after today (0 = off)
      highlightColor: '#F2C94C'
    },

    // ---- Running total --------------------------------------------------------
    cumulative: {
      show: false,
      color: '#17202B',
      width: 2,
      points: true, // a dot on every bucket
      title: 'Running total' // right axis title
    },

    // ---- Labels ---------------------------------------------------------------
    labels: {
      showTotals: true, // total on top of each bar when it fits
      showCounts: false, // number of items under the total (Item tile; else rows)
      total: font(11, 700, '#263244'),
      count: font(10, 400, '#68707D'),
      axis: font(11, 400, '#68707D'),
      fmt: (function () { var f = fmtCopy(); f.plusSign = false; return f; })() // used when Numbers → "Each label its own"
    },

    // ---- Axes and legend --------------------------------------------------------
    axes: {
      grid: true,
      gridColor: '#E2E4E8',
      lineColor: '#B8BFCA',
      yTitle: '', // left axis title; empty = none
      xTitle: ''
    },
    legend: {
      show: true, // when the Group tile is used (or colours by group)
      position: 'top', // top | bottom
      size: 11,
      color: '#17202B'
    },

    chart: {
      topItems: 5, // items listed in the tooltip
      tooltip: true,
      rightClickMenu: true
    },

    interaction: {
      selectInTableau: true, // click a bar (or a stack segment) to select its rows in Tableau
      tableauTooltip: false // hover shows the tooltip designed in Tableau instead of this extension's own
    },
    export: {
      picture: true // button in the top-right corner that saves the chart as a PNG
    }
  };

  // -------------------------------------------------------------------------
  // Built-in icons: only the Figma "Icons for Extension" set (icons.js).
  // -------------------------------------------------------------------------
  var ICONS = (window.KPI3_FIGMA_ICONS || []).map(function (ic) {
    var o = {}; for (var k in ic) o[k] = ic[k]; o.figma = true; return o;
  });

  var ICON_GROUPS = ['Chart icons', 'Others'];

  /** Icon by id. Ids of removed icons fall back to the default icon. */
  function findIcon (id) {
    var fallback = ICONS[0];
    for (var i = 0; i < ICONS.length; i++) {
      if (ICONS[i].id === id) return ICONS[i];
      if (ICONS[i].id === DEFAULTS.icon.builtinId) fallback = ICONS[i];
    }
    return fallback;
  }

  /** Display size: `target` px (default 24) on the longer side, keeping proportions. */
  function iconSize (icon, target) {
    var t = Number(target) > 0 ? Number(target) : 24;
    var w = icon.w || 24;
    var h = icon.h || 24;
    return w >= h
      ? { w: t, h: Math.max(1, Math.round(t * h / w)) }
      : { w: Math.max(1, Math.round(t * w / h)), h: t };
  }

  /**
   * Markup for any built-in icon plus its display size.
   *   path icons      inline SVG painted with `color`
   *   Figma, tint     PNG used as a mask over `color` (follows Icon color)
   *   Figma, no tint  plain <img> in its own colours (logos, multi-colour)
   */
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

  /** Kept for existing callers: markup only. */
  function iconSvg (id, color) {
    return iconHtml(id, color).html;
  }

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
  // Formatting helpers
  // -------------------------------------------------------------------------

  /**
   * Formats a number with a format object (see FORMAT).
   *   opts.signed      write "+" on positive values (changes)
   *   opts.fv          Tableau's formatted value (Workbook format)
   *   opts.forceScale  reuse a K/M/B suffix (axis ticks share one)
   *   opts.noUnit      leave the unit off
   *   opts.zeroSign    -1 / 1: sign of a signed value that is exactly 0 (the
   *                    bar's direction). Values that round to 0 keep their own sign.
   */
  function formatNumber (v, f, opts) {
    opts = opts || {};
    f = f || FORMAT;
    if (!isFinite(v)) return '—';
    var body;
    var neg = v < 0;
    var a = Math.abs(v);
    if (f.scale === 'percent' || f.scale === 'percentDynamic') {
      var p = f.pctFromRatio ? a * 100 : a;
      body = formatScaled(p, f.scale === 'percentDynamic' ? 'dynamic' : 'none', f.decimals,
        f.scale === 'percentDynamic' ? opts.forceScale : '') + '%';
    } else if (f.scale === 'workbook' && opts.fv) {
      body = String(opts.fv).replace(/^[-−(]\s*/, '').replace(/\)$/, '');
    } else {
      var sc = f.scale === 'workbook' ? 'dynamic' : f.scale;
      body = formatScaled(a, sc, f.decimals, opts.forceScale);
    }
    // A value that rounds to zero: changes (signed) show the bar's sign
    // (+0.0 / −0.0); other numbers carry no sign.
    var isZero = !/[1-9]/.test(body);
    if (isZero) neg = opts.signed ? (v < 0 || (v === 0 && opts.zeroSign < 0)) : false;
    if (!opts.noUnit && f.unit) body = f.unitPosition === 'prefix' ? f.unit + ' ' + body : body + ' ' + f.unit;
    if (neg) {
      if (f.negStyle === 'paren') return '(' + body + ')';
      return (f.negStyle === 'hyphen' ? '-' : '−') + body;
    }
    if (opts.signed && f.plusSign) return '+' + body;
    return body;
  }

  /** Dark or light text, whichever reads better on `hex`. */
  function contrastText (hex) {
    var c = rgb(hex).map(function (x) {
      x /= 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    var L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    return L > 0.36 ? '#17202B' : '#FFFFFF';
  }

  function dashArray (style, width) {
    var w = Math.max(0.5, Number(width) || 1);
    if (style === 'dashed') return (3 * w) + ',' + (3 * w);
    if (style === 'dotted') return w + ',' + (2 * w);
    return '';
  }

  /**
   * Which settings each brand-theme key drives (see shared/theme.js). Inert data: nothing reads
   * it until the Presets tab offers "Apply theme". Only plain look settings; per-measure / per-member
   * maps are never themed.
   */
  var THEME_MAP = {
    'fonts.family': ['title.font', 'explanation.font', 'numbers.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.titleWeight': ['title.weight'],
    'fonts.textSize': ['explanation.size'],
    'colors.title': ['title.color'],
    'colors.muted': ['explanation.color', 'labels.count.color', 'labels.axis.color'],
    'colors.accent': ['icon.color'],
    'colors.accent2': ['bars.color'],
    'colors.background': ['card.bgColor'],
    'colors.backgroundOpacity': ['card.bgOpacity'],
    'card.padding': ['card.padding'],
    'fonts.numberWeight': ['labels.total.weight'],
    'colors.text': ['legend.color'],
    'colors.number': ['labels.total.color'],
    'colors.negative': ['bars.overdueColor'],
    'colors.divider': ['card.dividerColor', 'axes.gridColor'],
    'numbers.scale': ['format.scale', 'labels.fmt.scale'],
    'numbers.decimals': ['format.decimals', 'labels.fmt.decimals'],
    'numbers.negative': ['format.negStyle', 'labels.fmt.negStyle']
  };

  window.Ml = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    FORMAT: FORMAT,
    UNITS: UNITS,
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
    pickScale: pickScale,
    fixed: fixed,
    formatScaled: formatScaled,
    formatNumber: formatNumber,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba,
    tint: tint,
    contrastText: contrastText,
    dashArray: dashArray  };
  // The icon helpers in icons.js / the KPI picker code refer to Kpi3.
  window.Kpi3 = window.Kpi3 || window.Ml;
})();
