'use strict';

/**
 * KPI Card Multi — shared configuration.
 *
 * Loaded by both the card (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the Figma defaults, number
 * formatting and the built-in icon set.
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var clone = ExtCore.clone, normalizeHex = ExtCore.normalizeHex, rgba = ExtCore.rgba, fontStack = ExtCore.fontStack,
    merge = ExtCore.merge, pickScale = ExtCore.pickScale, fixed = ExtCore.fixed, formatScaled = ExtCore.formatScaled;

  var STORAGE_KEY = 'kpiCardMulti1';

  /** Font families offered in the dialog. "Lato" ships with the extension. */
  var FONTS = [
    'Lato',
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
   * Defaults are taken directly from the Figma component "KPI Card 3"
   * (file Tableau-Dashboards, node 9:2939).
   */
  var DEFAULTS = {
    icon: {
      show: true,
      source: 'builtin', // builtin | upload | shape
      builtinId: 'fg-bar-chart-solid',
      size: 24, // px on the icon's longer side (Figma: 24)
      color: '#EB644C', // Main Colors/Solis — tints built-in icons only
      dataUrl: '',
      name: ''
    },
    title: {
      show: true,
      text: '', // empty → the Big number field name
      align: 'left', // left | center | right
      font: 'Lato',
      size: 16,
      weight: 500, // Lato Medium
      color: '#68707D', // Neutrals/Neptune Dark
      italic: false
    },
    explanation: {
      show: true,
      reserveSpace: true, // keep the line even when empty/hidden, so big numbers line up across cards
      text: '',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: true
    },
    number: {
      show: true,
      period: 'day', // day (latest date) | mtd (month to date) — independent of % Change
      mtdAgg: 'sum', // sum | avg — how days are rolled up into the MTD big number
      font: 'Lato',
      size: 32,
      weight: 700,
      color: '#263244', // Main Colors/Meso
      italic: false,
      decimals: 2,
      scale: 'dynamic', // none | K | M | B | dynamic | workbook | percent | percentDynamic
      unit: '',
      unitSize: 24,
      unitPosition: 'suffix', // suffix | prefix
      shrinkToFit: true,
      pctFromRatio: true // percent formats: metric is a 0–1 ratio (0.4523 → 45.23%)
    },
    change: {
      show: true,
      compareTo: 'previous', // previous (date point before) | prevMonth (same day last month)
      period: 'day', // day (single day) | mtd (month to date)
      mtdAgg: 'sum', // sum | avg — how days are rolled up into MTD
      type: 'percent', // percent | pp
      decimals: 2,
      ppFromRatio: true, // pp: metric is a 0–1 ratio, multiply the difference by 100
      higherIsBetter: true,
      positiveColor: '#2E9E6A',
      negativeColor: '#E35263', // Negative % Change
      neutralColor: '#68707D',
      font: 'Lato',
      size: 12,
      weight: 400
    },
    bottom: {
      mode: 'chart', // chart | text | none
      chartColor: '#ED8095',
      lineStyle: 'smooth', // smooth | straight (Figma)
      lineWidth: 0.9,
      fillOpacity: 35, // % opacity of the gradient at the top of the area
      points: 30, // last N days/weeks/months… (at the Date level) on the trend line (0 = all)
      showTooltip: true,
      heightPct: 44, // share of card height; Figma: 108 / 245
      textDecimals: 1,
      periodWord: 'period',
      showSign: true
    },
    interaction: {
      selectInTableau: false, // click selects the date in Tableau so dashboard actions fire (shared by all cards)
      tableauTooltip: false // show the tooltip designed in Tableau instead of this extension's own (shared by all cards)
    },
    export: {
      picture: false // "Save as picture" button for the whole row of cards (PNG)
    },
    // ---- Data ---------------------------------------------------------------
    data: {
      maxRows: 1000 // rows read from the worksheet; 0 = no limit (Format → Card → Maximum rows)
    },

    card: {
      padding: 15, // Filter Icon Title Padding
      bgColor: '#FFFFFF',
      bgOpacity: 0,
      divider: false, // dashed divider on the right of the cards; off by default
      dividerLast: true, // also draw it after the last card of each row
      dividerColor: '#E2E4E8', // Neutrals/Neptune Pale
      weight: 1 // per card: share of the row width (2 = twice as wide as a 1)
    },
    layout: {
      minWidth: 180, // px — fewer cards fit in a row → they wrap onto the next row
      gap: 0 // px between cards
    },
    details: {
      show: true, // measures on Tableau's Tooltip tile appear in the tooltip
      onCard: true, // hovering the card (outside the trend line) shows the latest date's details
      title: '', // optional heading above the details
      items: [], // per measure, see DETAIL_ITEM
      hidden: [], // per card: keys of Tooltip-tile measures left out of this card's tooltip
      headingStyle: { font: 'Lato', size: 11, weight: 400, color: '#68707D', italic: false },
      nameStyle: { font: 'Lato', size: 12, weight: 400, italic: false },
      valueStyle: { font: 'Lato', size: 12, weight: 700, italic: false }
    }
  };

  /**
   * Settings that belong to one card (one measure). Everything else is shared
   * by every card in the row. The Format dialog marks these "this card".
   */
  var PER_CARD = [
    'icon.show', 'icon.source', 'icon.builtinId', 'icon.dataUrl', 'icon.name',
    'title.text', 'explanation.text',
    'number.period', 'number.mtdAgg', 'number.decimals', 'number.scale', 'number.unit',
    'number.unitPosition', 'number.pctFromRatio',
    'change.show', 'change.compareTo', 'change.period', 'change.mtdAgg', 'change.type',
    'change.decimals', 'change.ppFromRatio', 'change.higherIsBetter',
    'card.weight',
    'details.hidden'
  ];

  // -------------------------------------------------------------------------
  // Built-in icons: only the Figma "Icons for Extension" set (icons.js).
  // -------------------------------------------------------------------------
  var ICONS = (window.KPI_CARD_FIGMA_ICONS || []).map(function (ic) {
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
        html = '<span class="kpi-card-icon-mask" style="display:block;width:' + size.w + 'px;height:' + size.h +
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

  /**
   * Stored shape: { shared: <full settings>, cards: { <card key>: { section: { key: value } } } }
   * shared also holds the starting values of the per-card settings for cards
   * that haven't been formatted yet.
   */
  function read () {
    try {
      var raw = tableau.extensions.settings.get(STORAGE_KEY);
      return normalizeStore(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return normalizeStore(null);
    }
  }

  function normalizeStore (o) {
    o = o && typeof o === 'object' ? o : {};
    var cards = {};
    var src = o.cards && typeof o.cards === 'object' ? o.cards : {};
    Object.keys(src).forEach(function (k) { if (src[k] && typeof src[k] === 'object') cards[k] = src[k]; });
    return { shared: merge(DEFAULTS, o.shared), cards: cards };
  }

  function write (store) {
    tableau.extensions.settings.set(STORAGE_KEY, JSON.stringify(store));
    return tableau.extensions.settings.saveAsync();
  }

  function isPerCard (path) { return PER_CARD.indexOf(path) >= 0; }

  /** Full settings for one card: shared values with that card's own values on top. */
  function cardConfig (store, key) {
    var out = clone(store.shared);
    var own = key != null ? store.cards[key] : null;
    if (own) {
      PER_CARD.forEach(function (path) {
        var parts = path.split('.');
        var sec = own[parts[0]];
        if (sec && parts[1] in sec && typeof sec[parts[1]] === typeof out[parts[0]][parts[1]]) {
          out[parts[0]][parts[1]] = sec[parts[1]];
        }
      });
    }
    return out;
  }

  /**
   * Writes an edited card view back into the store: per-card settings to that
   * card, everything else to shared. Without a key, all goes to shared.
   */
  function splitInto (store, key, view) {
    Object.keys(DEFAULTS).forEach(function (sec) {
      Object.keys(DEFAULTS[sec]).forEach(function (k) {
        var v = clone(view[sec][k]);
        if (key != null && isPerCard(sec + '.' + k)) {
          var own = store.cards[key] = store.cards[key] || {};
          (own[sec] = own[sec] || {})[k] = v;
        } else {
          store.shared[sec][k] = v;
        }
      });
    });
    return store;
  }

  // -------------------------------------------------------------------------
  // Formatting helpers
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Tooltip tile → tooltip. One entry per measure on Tableau's Tooltip tile, matched
  // by key (the measure's name without aggregation, so SUM → AVG keeps it).
  // Colors (name and value each): single | posneg (by the value's sign) |
  // conditional (first matching rule wins, else `other`).
  // -------------------------------------------------------------------------
  var DETAIL_ITEM = {
    key: '',
    label: '', // empty → the measure's name
    show: true,
    scale: 'dynamic', // dynamic | K | M | B | none | percent | percentDynamic | workbook
    decimals: 2,
    pctFromRatio: true,
    unit: '',
    unitPosition: 'suffix', // suffix | prefix
    name: { mode: 'single', color: '#68707D', pos: '#2E9E6A', neg: '#E35263', zero: '#68707D', rules: [], other: '#68707D' },
    value: { mode: 'single', color: '#263244', pos: '#2E9E6A', neg: '#E35263', zero: '#263244', rules: [], other: '#263244' }
  };

  var DETAIL_RULE = { op: 'gt', v: 0, v2: 0, color: '#E35263' };

  /** Comparison operators for conditional colors: [id, label]. */
  var DETAIL_OPS = [
    ['gt', '>'], ['gte', '≥'], ['lt', '<'], ['lte', '≤'],
    ['eq', '='], ['ne', '≠'], ['between', 'between']
  ];

  /** Settings of one Details measure (defaults filled in). */
  function detailItem (details, key) {
    var items = details && Array.isArray(details.items) ? details.items : [];
    var hit = null;
    for (var i = 0; i < items.length; i++) { if (items[i] && items[i].key === key) { hit = items[i]; break; } }
    var it = merge(DETAIL_ITEM, hit);
    it.key = key;
    ['name', 'value'].forEach(function (s) {
      it[s].rules = (Array.isArray(it[s].rules) ? it[s].rules : []).map(function (r) { return merge(DETAIL_RULE, r); });
    });
    return it;
  }

  function ruleMatches (r, v) {
    var a = Number(r.v);
    var b = Number(r.v2);
    switch (r.op) {
      case 'gt': return v > a;
      case 'gte': return v >= a;
      case 'lt': return v < a;
      case 'lte': return v <= a;
      case 'eq': return v === a;
      case 'ne': return v !== a;
      case 'between': return v >= Math.min(a, b) && v <= Math.max(a, b);
    }
    return false;
  }

  /** Color for a value under a color spec { mode, color, pos, neg, zero, rules, other }. */
  function detailColor (spec, v) {
    if (!spec) return '';
    if (spec.mode === 'posneg') {
      if (!isFinite(v)) return spec.zero;
      return v > 0 ? spec.pos : v < 0 ? spec.neg : spec.zero;
    }
    if (spec.mode === 'conditional') {
      if (isFinite(v)) {
        var rules = spec.rules || [];
        for (var i = 0; i < rules.length; i++) { if (ruleMatches(rules[i], v)) return rules[i].color; }
      }
      return spec.other;
    }
    return spec.color;
  }

  /** A Details value as text, with its own format and unit. `fv` = Tableau's formatted value. */
  function formatDetail (item, v, fv) {
    if (!isFinite(v)) return '—';
    var s = item.scale;
    var text;
    if (s === 'percent' || s === 'percentDynamic') {
      text = formatScaled(item.pctFromRatio ? v * 100 : v, s === 'percentDynamic' ? 'dynamic' : 'none', item.decimals) + '%';
    } else if (s === 'workbook' && fv) {
      text = fv;
    } else {
      text = formatScaled(v, s === 'workbook' ? 'dynamic' : s, item.decimals);
    }
    if (item.unit) text = item.unitPosition === 'prefix' ? item.unit + ' ' + text : text + ' ' + item.unit;
    return text;
  }

  function escHtml (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /** Inline font CSS for a style { font, size, weight, italic, color? }. */
  function styleCss (st) {
    if (!st) return '';
    return 'font-family:' + fontStack(st.font).replace(/"/g, "'") + ';font-size:' + (Number(st.size) || 12) + 'px;font-weight:' +
      (Number(st.weight) || 400) + ';font-style:' + (st.italic ? 'italic' : 'normal') + ';' + (st.color ? 'color:' + st.color + ';' : '');
  }

  /**
   * Tooltip block for the Tooltip-tile measures. `list` = [{ key, label }] in tile
   * order; `vals` = { v: [number], fv: [string|null] } aligned with it.
   */
  function detailsHtml (details, list, vals) {
    if (!details || details.show === false || !list || !list.length) return '';
    var rows = '';
    var nameCss = styleCss(details.nameStyle);
    var valueCss = styleCss(details.valueStyle);
    list.forEach(function (d, i) {
      var it = detailItem(details, d.key);
      if (!it.show || (Array.isArray(details.hidden) && details.hidden.indexOf(d.key) >= 0)) return;
      var v = vals && vals.v ? vals.v[i] : NaN;
      var fv = vals && vals.fv ? vals.fv[i] : null;
      rows += '<div class="tt-drow"><span class="tt-dn" style="' + escHtml(nameCss + 'color:' + detailColor(it.name, v)) + '">' +
        escHtml(it.label || d.label) + '</span><span class="tt-dv" style="' + escHtml(valueCss + 'color:' + detailColor(it.value, v)) + '">' +
        escHtml(formatDetail(it, v, fv)) + '</span></div>';
    });
    if (!rows) return '';
    return '<div class="tt-details">' + (details.title ? '<div class="tt-dh" style="' + escHtml(styleCss(details.headingStyle)) + '">' + escHtml(details.title) + '</div>' : '') + rows + '</div>';
  }

  /**
   * Which settings each brand-theme key drives (see shared/theme.js). It applies to store.shared (the settings shared by all cards). Inert data: nothing reads
   * it until the Presets tab offers "Apply theme". Only plain look settings; per-measure / per-member
   * maps are never themed.
   */
  var THEME_MAP = {
    'fonts.family': ['title.font', 'explanation.font', 'number.font', 'change.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.titleWeight': ['title.weight'],
    'fonts.textSize': ['explanation.size'],
    'colors.title': ['title.color'],
    'colors.muted': ['explanation.color'],
    'colors.accent': ['icon.color'],
    'colors.background': ['card.bgColor'],
    'colors.backgroundOpacity': ['card.bgOpacity'],
    'card.padding': ['card.padding'],
    'fonts.numberWeight': ['number.weight'],
    'colors.number': ['number.color'],
    'colors.changeUp': ['change.positiveColor'],
    'colors.changeDown': ['change.negativeColor'],
    'colors.neutral': ['change.neutralColor'],
    'colors.divider': ['card.dividerColor'],
    'numbers.scale': ['number.scale']
  };

  window.KpiCardMultiConfig = {
    DETAIL_ITEM: DETAIL_ITEM,
    DETAIL_RULE: DETAIL_RULE,
    DETAIL_OPS: DETAIL_OPS,
    detailItem: detailItem,
    detailColor: detailColor,
    formatDetail: formatDetail,
    detailsHtml: detailsHtml,
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    FONTS: FONTS,
    ICONS: ICONS,
    findIcon: findIcon,
    ICON_GROUPS: ICON_GROUPS,
    iconHtml: iconHtml,
    iconSvg: iconSvg,
    clone: clone,
    merge: merge,
    PER_CARD: PER_CARD,
    isPerCard: isPerCard,
    read: read,
    write: write,
    normalizeStore: normalizeStore,
    cardConfig: cardConfig,
    splitInto: splitInto,
    pickScale: pickScale,
    fixed: fixed,
    formatScaled: formatScaled,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba
  };
})();
