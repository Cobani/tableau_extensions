'use strict';

/**
 * Treemap & Donut — shared configuration.
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

  var STORAGE_KEY = 'treemapDonut1';

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

  /** Sort options for tiles and slices (per parent). */
  var SORTS = [['valDesc', 'Size, largest first'], ['valAsc', 'Size, smallest first'], ['name', 'Name, A to Z'],
    ['nameDesc', 'Name, Z to A'], ['data', 'Order in the data']];

  /** Compare function for a sort key, over items read by `val(x)` and `name(x)`. Ties keep their order. */
  function comparer (order, val, name) {
    var byName = function (a, b) { return String(name(a)).localeCompare(String(name(b)), undefined, { numeric: true, sensitivity: 'base' }); };
    switch (order) {
      case 'valDesc': return function (a, b) { return val(b) - val(a); };
      case 'valAsc': return function (a, b) { return val(a) - val(b); };
      case 'name': return byName;
      case 'nameDesc': return function (a, b) { return byName(b, a); };
      default: return null;
    }
  }

  /** Stable sort of a copy of `list`. */
  function sortBy (list, cmp) {
    if (!cmp) return list.slice();
    return list.map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) { return cmp(a.x, b.x) || a.i - b.i; })
      .map(function (o) { return o.x; });
  }

  /** Default palette for the first-level members (colour-blind friendly, muted). */
  var PALETTE = ['#2F4B7C', '#EB644C', '#0E7C66', '#E0A526', '#7A5195', '#4C9BB5', '#B4431E', '#7F9A3B', '#C45C8F', '#55606E'];

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
      text: '', // empty → "<Size> by <Category>"
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

    // ---- Numbers ----------------------------------------------------------
    numbers: {
      font: 'Lato' // font of all chart text
    },
    format: fmtCopy(), // number format of sizes (the "+" option is not used)
    colorFormat: fmtCopy(), // number format of the Colour measure (tooltip, legend bar); e.g. scale 'percent' for a growth ratio

    // ---- Chart ------------------------------------------------------------
    chart: {
      mode: 'treemap', // treemap | donut | pie
      depth: 2, // treemap: levels shown at once (1 or 2); the donut always shows one level (the one you drilled into)
      sort: 'valDesc', // order of tiles / slices inside each parent (see SORTS)
      othersThreshold: 2, // donut / pie: slices below this % of their parent are grouped into "Others" (0 = never)
      maxItems: 0, // most tiles / slices per parent, the rest become "Others" (0 = no limit)
      breadcrumb: true, // path "All › Apparel › Shoes" above the chart
      rootName: 'All' // name of the top of the breadcrumb
    },

    // ---- Layout -----------------------------------------------------------
    layout: {
      padding: 3, // treemap: space inside a group, around its tiles (px)
      gap: 1, // treemap: space between tiles (px)
      radius: 2, // treemap: tile corner radius (px)
      headerHeight: 18, // treemap, depth 2: height of a group's header strip (px)
      thickness: 55, // donut: ring thickness, % of the radius
      sliceGap: 1.5, // donut / pie: gap between slices (px)
      borderColor: '#FFFFFF', // line around tiles and slices
      borderWidth: 1
    },

    // ---- Labels -----------------------------------------------------------
    labels: {
      show: true,
      name: true,
      value: true,
      shareParent: false, // "34% of Apparel"
      shareTotal: false, // "12% of total"
      shareDecimals: 0,
      donutPlacement: 'outside', // outside (with leader lines) | legend (no labels on the chart)
      minWidth: 44, // treemap: a tile narrower than this (px) has no label
      minHeight: 18, // treemap: a tile lower than this (px) has no label
      font: 'Lato',
      size: 11,
      weight: 600,
      colorMode: 'auto', // auto (contrast on the tile) | custom
      color: '#17202B',
      headerSize: 11, // group header text (treemap, depth 2)
      headerWeight: 700
    },

    // ---- Colours ----------------------------------------------------------
    colors: {
      mode: 'tint', // member (first-level colour for everything below) | tint (children are lighter tints) | measure (Colour tile)
      palette: PALETTE.slice(),
      overrides: {}, // first-level member name → colour
      tintStep: 18, // tint: % lighter per level
      rampLow: '#B4431E', // measure: lowest Colour value
      rampMid: '#F3EFE6', // measure: middle (used when "Centre on" is on)
      rampHigh: '#0E7C66', // measure: highest
      rampCenter: true, // measure: diverging ramp, the middle colour sits on the centre value
      rampCenterValue: 0,
      rampMin: 'auto', // auto | manual
      rampMax: 'auto',
      rampMinValue: -0.1,
      rampMaxValue: 0.1,
      nullColor: '#C9CDD4' // no Colour value
    },

    // ---- Centre text (donut) -----------------------------------------------
    center: {
      show: true,
      hover: true, // hover a slice: its name, value and share replace the total
      title: 'Total',
      valueSize: 22,
      valueWeight: 700,
      valueColor: '#17202B',
      textSize: 11,
      textColor: '#68707D',
      showShare: true
    },

    // ---- Legend ------------------------------------------------------------
    legend: {
      position: 'off', // off | right | bottom
      size: 11,
      color: '#55606E',
      maxItems: 12 // most entries listed; the Colour measure ramp is always one bar
    },

    interaction: {
      click: 'drill', // drill | select | both (click selects, double click drills)
      selectInTableau: true, // selecting sends every level's value to Tableau (dashboard actions)
      tableauTooltip: false, // hover shows the tooltip designed in Tableau instead of this extension's own
      tooltip: true, // the extension's own tooltip
      rightClickMenu: true
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

  /** Shades of one colour for breakdown segments: first = the colour itself. */
  function shades (hex, n) {
    var out = [];
    for (var i = 0; i < n; i++) out.push(tint(hex, n <= 1 ? 0 : (i / (n - 1)) * 0.62));
    return out;
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
    'fonts.family': ['title.font', 'explanation.font', 'numbers.font', 'labels.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.titleWeight': ['title.weight'],
    'fonts.textSize': ['explanation.size'],
    'colors.title': ['title.color'],
    'colors.muted': ['explanation.color', 'center.textColor'],
    'colors.accent': ['icon.color'],
    'colors.background': ['card.bgColor', 'layout.borderColor'],
    'colors.backgroundOpacity': ['card.bgOpacity'],
    'card.padding': ['card.padding'],
    'fonts.numberWeight': ['center.valueWeight'],
    'colors.text': ['labels.color', 'center.valueColor'],
    'colors.axisText': ['legend.color'],
    'colors.positive': ['colors.rampHigh'],
    'colors.negative': ['colors.rampLow'],
    'colors.divider': ['card.dividerColor'],
    'numbers.scale': ['format.scale'],
    'numbers.decimals': ['format.decimals'],
    'numbers.negative': ['format.negStyle']
  };

  window.Td = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    FORMAT: FORMAT,
    SORTS: SORTS,
    PALETTE: PALETTE,
    comparer: comparer,
    sortBy: sortBy,
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
    rgb: rgb,
    rgba: rgba,
    tint: tint,
    shades: shades,
    contrastText: contrastText,
    dashArray: dashArray
  };
  // The icon helpers in icons.js / the KPI picker code refer to Kpi3.
  window.Kpi3 = window.Kpi3 || window.Td;
})();
