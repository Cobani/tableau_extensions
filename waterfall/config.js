'use strict';

/**
 * Waterfall — shared configuration.
 *
 * Loaded by both the chart (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, number formatting and
 * the built-in icon set (the same icon set as KPI Card 3).
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  var STORAGE_KEY = 'waterfall1';

  var FONT_STACK_FALLBACK =
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

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

  /** Start / End bar (both share this shape; colours from the Figma mockup). */
  function endBar () {
    return {
      label: '', // empty → the field name
      color: '#3A4656',
      total: {
        show: true,
        position: 'above', // above | inside-top | inside-center | inside-bottom | below
        size: 12,
        weight: 700,
        colorMode: 'custom', // bar | custom
        color: '#17202B',
        fmt: fmtCopy()
      },
      // Shown when the axis doesn't start at zero, so the bar is cut short.
      brk: {
        show: true,
        style: 'slash', // slash (Figma) | zigzag | gap
        pos: 55, // % down the visible bar
        bandColor: '#FFFFFF',
        lineColor: '#55606E'
      }
    };
  }

  /** One value between Start and End. Stored per field under cfg.steps[key]. */
  var STEP = {
    label: '', // empty → the field name
    colorMode: 'sign', // sign (Increase / Decrease colours) | custom
    color: '#2F4B7C',
    invert: false, // treat as an outflow: positive amounts go down
    total: {
      show: true,
      position: 'above', // above | inside-top | inside-center | inside-bottom | below | end
      size: 11,
      weight: 600,
      colorMode: 'bar', // bar | custom
      color: '#17202B',
      fmt: fmtCopy()
    },
    brk: {
      show: true,
      style: 'slash',
      pos: 50,
      bandColor: '#FFFFFF',
      lineColor: '#55606E'
    },
    breakdown: {
      show: true, // split the bar by the Breakdown dimensions
      dims: [], // Breakdown fields this bar uses, in label order (empty → all, tile order)
      sep: ' \u00b7 ', // between dimension values in a segment name
      colorMode: 'shades', // shades (of the bar colour) | custom
      colors: {}, // member → colour (custom)
      showValues: false,
      showNames: false, // "Current 298.2" instead of "298.2"
      position: 'inside', // inside | right | left
      size: 10,
      weight: 400,
      labelColorMode: 'auto', // auto (contrast) | custom
      labelColor: '#17202B',
      fmt: fmtCopy(),
      dividers: true, // thin white line between segments
      minPx: 12, // hide inside labels on segments shorter than this
      order: 'inherit' // segment + tooltip order: inherit (All bars setting) | see BREAKDOWN_ORDERS
    },
    group: '' // custom group id (Groups → Custom)
  };

  /** Sort options for change bars and for breakdown segments. */
  var BAR_SORTS = [['marks', 'Order on the Marks card'], ['valDesc', 'Value, high to low'], ['valAsc', 'Value, low to high'],
    ['desc', 'Size, largest first'], ['asc', 'Size, smallest first']];
  var BREAKDOWN_ORDERS = [['data', 'Default (as in the data)'], ['valDesc', 'Value, high to low'], ['valAsc', 'Value, low to high'],
    ['desc', 'Size, largest first'], ['asc', 'Size, smallest first'], ['name', 'Name, A to Z'], ['nameDesc', 'Name, Z to A']];

  /**
   * Compare function for an order key, over items read by `val(x)` (number)
   * and `name(x)` (string). Ties keep their original order (stable sort).
   */
  function comparer (order, val, name) {
    var byName = function (a, b) { return String(name(a)).localeCompare(String(name(b)), undefined, { numeric: true, sensitivity: 'base' }); };
    switch (order) {
      case 'valDesc': return function (a, b) { return val(b) - val(a); };
      case 'valAsc': return function (a, b) { return val(a) - val(b); };
      case 'desc': return function (a, b) { return Math.abs(val(b)) - Math.abs(val(a)); };
      case 'asc': return function (a, b) { return Math.abs(val(a)) - Math.abs(val(b)); };
      case 'name': return byName;
      case 'nameDesc': return function (a, b) { return byName(b, a); };
      default: return null;
    }
  }

  /** Stable sort of a copy of `list` (older browsers' sort isn't stable). */
  function sortBy (list, cmp) {
    if (!cmp) return list.slice();
    return list.map(function (x, i) { return { x: x, i: i }; })
      .sort(function (a, b) { return cmp(a.x, b.x) || a.i - b.i; })
      .map(function (o) { return o.x; });
  }

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
      text: '', // empty → "Start → End"
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
      mode: 'all', // all (one format for every number) | each (every label has its own)
      font: 'Lato' // font of all chart text
    },
    format: fmtCopy(),

    // ---- Bars -------------------------------------------------------------
    bars: {
      width: 62, // % of the slot
      radius: 2,
      endRadius: 3,
      posColor: '#0E7C66', // Increase (sign colour)
      negColor: '#B4431E', // Decrease
      breakdownOrder: 'data', // data | valDesc | valAsc | desc (size) | asc (size) | name | nameDesc
      sort: 'marks', // order of the change bars: marks | valDesc | valAsc | desc (size) | asc (size)
      sortScope: 'overall', // overall | groups (sort inside each group, groups stay in place)
      calcEnd: true, // End tile empty → End = Start + changes
      balanceIgnoreBreakdown: false, // Start / End: take the value once instead of summing it over the Breakdown members
      tooltip: true,
      rightClickMenu: true
    },
    start: endBar(),
    end: endBar(),
    stepDefaults: JSON.parse(JSON.stringify(STEP)), // used for steps you haven't styled
    steps: {}, // field key → STEP overrides

    // Last seen field names on the Marks card (Changes, Breakdown), so a renamed
    // pill keeps its settings. Written by the chart.
    layout: { steps: [], dims: [] },

    // ---- Groups -----------------------------------------------------------
    groups: {
      mode: 'sign', // none | sign (runs of increases / decreases) | custom
      pos: { text: 'Incoming', color: '#0E7C66', showTotal: true },
      neg: { text: 'Outgoing', color: '#B4431E', showTotal: true },
      custom: {}, // id → { text, color, showTotal }
      lineWidth: 2,
      lineStyle: 'solid', // solid | dashed | dotted | bracket
      size: 11,
      weight: 600,
      separator: ' · ',
      inset: 12, // px the line starts/ends inside the outer bars' slots
      band: false, // shade the area behind the group's bars
      bandOpacity: 6,
      fmt: fmtCopy()
    },

    // ---- Axes -------------------------------------------------------------
    axisY: {
      show: true,
      position: 'left', // left | right
      base: 'auto', // zero | auto (close to the data) | manual
      padding: 20, // auto: room below the lowest level, % of the data range
      manualMin: 0,
      maxMode: 'auto', // auto | manual
      manualMax: 100,
      ticks: 5,
      title: '',
      font: 'Lato',
      size: 10,
      weight: 400,
      color: '#55606E',
      showLine: false,
      lineColor: '#C9CDD4',
      useGlobalFormat: false,
      fmt: (function () { var f = fmtCopy(); f.decimals = 0; f.plusSign = false; return f; })()
    },
    axisX: {
      show: true,
      font: 'Lato',
      size: 11,
      weight: 500,
      color: '#17202B',
      orientation: 'wrap', // wrap | angled | vertical
      maxLines: 2,
      showLine: false,
      lineColor: '#C9CDD4',
      lineWidth: 1
    },

    // ---- Lines ------------------------------------------------------------
    lines: {
      hGrid: { show: true, color: '#ECEEE8', width: 1, style: 'solid' },
      vGrid: { show: false, color: '#ECEEE8', width: 1, style: 'solid' },
      connectors: { show: true, color: '#55606E', width: 1, style: 'dashed' },
      zero: { show: true, color: '#C9CDD4', width: 1, style: 'solid' }
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
  function clone (o) { return JSON.parse(JSON.stringify(o)); }

  function isMap (o) { return o && typeof o === 'object' && !Array.isArray(o) && !Object.keys(o).length; }

  /**
   * Deep-merges stored values over the defaults so new keys get defaults.
   * An empty object in the defaults ({}) is a map (steps, colours, custom
   * groups): the stored map is copied as is.
   */
  function merge (base, over) {
    var out = clone(base);
    if (!over || typeof over !== 'object') return out;
    Object.keys(out).forEach(function (k) {
      if (!(k in over)) return;
      if (isMap(out[k])) {
        if (over[k] && typeof over[k] === 'object') out[k] = clone(over[k]);
      } else if (out[k] && typeof out[k] === 'object' && !Array.isArray(out[k])) {
        out[k] = merge(out[k], over[k]);
      } else if (typeof over[k] === typeof out[k] || out[k] === '' || out[k] == null) {
        out[k] = over[k];
      }
    });
    return out;
  }

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

  /** Settings of one step: stored overrides on top of the step defaults. */
  function stepCfg (cfg, key) {
    return merge(cfg.stepDefaults, cfg.steps[key]);
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------
  var SCALES = { K: 1e3, M: 1e6, B: 1e9 };

  function pickScale (value, scale) {
    if (scale === 'dynamic') {
      var a = Math.abs(value);
      return a >= 1e9 ? 'B' : a >= 1e6 ? 'M' : a >= 1e3 ? 'K' : '';
    }
    return SCALES[scale] ? scale : '';
  }

  function fixed (n, decimals) {
    var d = Math.max(0, Math.min(10, Number(decimals) || 0));
    try {
      return new Intl.NumberFormat('en-US', {
        minimumFractionDigits: d,
        maximumFractionDigits: d
      }).format(n);
    } catch (e) {
      return n.toFixed(d);
    }
  }

  function formatScaled (value, scale, decimals, forceScale) {
    if (!isFinite(value)) return '—';
    var suffix = forceScale != null ? forceScale : pickScale(value, scale);
    var divisor = SCALES[suffix] || 1;
    var text = fixed(value / divisor, decimals);
    if (/^-[0.,]+$/.test(text)) text = text.slice(1);
    return text + suffix;
  }

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

  function fontStack (family) {
    if (!family) return FONT_STACK_FALLBACK;
    return '"' + String(family).replace(/"/g, '') + '", ' + FONT_STACK_FALLBACK;
  }

  function normalizeHex (value) {
    if (typeof value !== 'string') return null;
    var hex = value.trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(hex)) hex = hex.replace(/(.)/g, '$1$1');
    return /^[0-9a-f]{6}$/i.test(hex) ? '#' + hex.toUpperCase() : null;
  }

  function rgb (hex) {
    var h = normalizeHex(hex) || '#000000';
    return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  }

  function rgba (hex, alpha) {
    var c = rgb(hex);
    return 'rgba(' + c[0] + ', ' + c[1] + ', ' + c[2] + ', ' + alpha + ')';
  }

  /** Mixes a colour with white: t = 0 → the colour, t = 1 → white. */
  function tint (hex, t) {
    var c = rgb(hex);
    var m = function (x) { return Math.round(x + (255 - x) * t); };
    return '#' + [m(c[0]), m(c[1]), m(c[2])].map(function (x) { return ('0' + x.toString(16)).slice(-2); }).join('').toUpperCase();
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

  /**
   * Top breakdown segments: with more than TOP_SEGMENTS members, the largest
   * TOP_SEGMENTS (by size) stay in their order and the rest are summed into
   * one "Others" segment, always last. segs: [{ member, v }].
   */
  var TOP_SEGMENTS = 10;
  var OTHERS = 'Others';
  function topSegments (segs) {
    if (!segs || segs.length <= TOP_SEGMENTS) return segs || [];
    var keep = {};
    segs.map(function (sg, i) { return { a: Math.abs(sg.v), i: i }; })
      .sort(function (a, b) { return b.a - a.a || a.i - b.i; })
      .slice(0, TOP_SEGMENTS)
      .forEach(function (x) { keep[x.i] = 1; });
    var out = [];
    var rest = { member: OTHERS, v: 0, others: true, count: 0 };
    segs.forEach(function (sg, i) {
      if (keep[i]) out.push(sg);
      else { rest.v += sg.v; rest.count++; }
    });
    out.push(rest);
    return out;
  }

  function dashArray (style, width) {
    var w = Math.max(0.5, Number(width) || 1);
    if (style === 'dashed') return (3 * w) + ',' + (3 * w);
    if (style === 'dotted') return w + ',' + (2 * w);
    return '';
  }

  window.Wf = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    STEP: STEP,
    FORMAT: FORMAT,
    BAR_SORTS: BAR_SORTS,
    BREAKDOWN_ORDERS: BREAKDOWN_ORDERS,
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
    stepCfg: stepCfg,
    pickScale: pickScale,
    fixed: fixed,
    formatScaled: formatScaled,
    formatNumber: formatNumber,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba,
    tint: tint,
    shades: shades,
    contrastText: contrastText,
    dashArray: dashArray,
    TOP_SEGMENTS: TOP_SEGMENTS,
    OTHERS: OTHERS,
    topSegments: topSegments
  };
  // The icon helpers in icons.js / the KPI picker code refer to Kpi3.
  window.Kpi3 = window.Kpi3 || window.Wf;
})();
