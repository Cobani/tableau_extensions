'use strict';

/**
 * Bullet & Gauge — shared configuration.
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

  var STORAGE_KEY = 'bulletGauge1';

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


  // Font settings used by the category and value labels.
  function fontDef (size, weight, color, italic) {
    return { font: 'Lato', size: size, weight: weight, color: color, italic: !!italic };
  }

  var MODES = [['bullet', 'Bullet rows'], ['gauge', 'Gauges'], ['progress', 'Progress bars']];
  var SORTS = [['none', 'As in the data'], ['actual', 'Actual, high to low'], ['pct', '% of target, high to low']];

  /**
   * Every setting, with the value a fresh chart starts with. Stored as one JSON string under
   * STORAGE_KEY; new settings must default to the old behaviour.
   */
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
      text: '', // empty → the Actual measure's name
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
    numbers: {
      mode: 'all', // all | each: "each" gives the value and the % of target their own format
      font: 'Lato' // font of the tooltip
    },
    format: fmtCopy(), // number format of values
    pctFormat: (function () { var f = fmtCopy(); f.scale = 'none'; f.decimals = 0; f.plusSign = false; f.unit = '%'; f.unitPosition = 'suffix'; return f; })(), // used when numbers.mode = each

    // ---- Chart --------------------------------------------------------------
    chart: {
      mode: 'bullet', // bullet | gauge | progress
      rowHeight: 34, // bullet / progress: height of one row, px
      gaugeSize: 150, // gauge: smallest width of one gauge, px (more gauges fit side by side when wider)
      gap: 8, // space between rows / gauges, px
      sort: 'none', // none | actual | pct
      topN: 0, // 0 = all categories, otherwise only the first N after sorting
      tooltip: true,
      rightClickMenu: true
    },

    // ---- Scale --------------------------------------------------------------
    scale: {
      shared: false, // false: every row / gauge has its own scale; true: all use the largest maximum
      maxMode: 'auto', // auto (largest of actual, target, ranges, comparison) | fixed
      max: 100 // fixed maximum
    },

    // ---- Ranges (qualitative bands) -------------------------------------------
    ranges: {
      source: 'auto', // auto: Ranges measures when present, else % of target | percent: always % of target
      thresholds: [60, 85, 100], // % of target where each band ends (when no Ranges measures)
      style: 'tints', // tints (one colour) | three (poor / ok / good colours)
      color: '#6B7A8F', // base colour for tints
      poorColor: '#F2B8AE',
      okColor: '#F6E0A4',
      goodColor: '#BFE0C8',
      reverse: false, // lower is better: the darkest band / the "good" colour moves to the low end
      track: '#EEF0F3' // the area behind the bands (where no band reaches)
    },

    // ---- Actual bar / arc ---------------------------------------------------
    actual: {
      colorMode: 'single', // single | status (below / near / at-or-above target)
      color: '#2F4B7C',
      belowColor: '#B4431E',
      nearColor: '#D99A1E',
      atColor: '#0E7C66',
      nearPct: 85, // status: from this % of target = "near"
      atPct: 100, // status: from this % of target = "at or above"
      thickness: 38, // % of the band height (bullet) / band width (gauge)
      radius: 2
    },

    // ---- Target tick --------------------------------------------------------
    target: {
      show: true,
      color: '#17202B',
      thickness: 3
    },

    // ---- Comparison tick ----------------------------------------------------
    compare: {
      show: true,
      color: '#E07A1F',
      thickness: 2
    },

    // ---- Labels -------------------------------------------------------------
    labels: {
      showCategory: true,
      category: fontDef(12, 500, '#17202B', false),
      value: fontDef(12, 700, '#17202B', false),
      showPct: true, // "% of target" next to the value
      pctColor: '#68707D',
      labelWidth: 30 // bullet / progress: widest the label column may be, % of the width
    },

    interaction: {
      selectInTableau: true, // click a row / gauge to select its category in Tableau
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
   * it until the Presets tab offers "Apply theme".
   */
  var THEME_MAP = {
    'fonts.family': ['title.font', 'explanation.font', 'numbers.font', 'labels.category.font', 'labels.value.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.titleWeight': ['title.weight'],
    'fonts.textSize': ['explanation.size'],
    'colors.title': ['title.color'],
    'colors.muted': ['explanation.color', 'labels.pctColor'],
    'colors.accent': ['icon.color'],
    'colors.accent2': ['actual.color'],
    'colors.background': ['card.bgColor'],
    'colors.backgroundOpacity': ['card.bgOpacity'],
    'card.padding': ['card.padding'],
    'colors.text': ['labels.category.color', 'labels.value.color', 'target.color'],
    'colors.positive': ['actual.atColor'],
    'colors.negative': ['actual.belowColor'],
    'colors.divider': ['card.dividerColor'],
    'numbers.scale': ['format.scale'],
    'numbers.decimals': ['format.decimals'],
    'numbers.negative': ['format.negStyle']
  };

  window.Bg = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    FORMAT: FORMAT,
    MODES: MODES,
    SORTS: SORTS,
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
    dashArray: dashArray
  };
  // The icon helpers in icons.js / the KPI picker code refer to Kpi3.
  window.Kpi3 = window.Kpi3 || window.Bg;
})();
