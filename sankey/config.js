'use strict';

/**
 * Sankey — shared configuration.
 *
 * Loaded by both the chart (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, colours and the
 * built-in icon set (the same set as KPI Card, Waterfall and Bar Chart).
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var clone = ExtCore.clone, normalizeHex = ExtCore.normalizeHex, rgba = ExtCore.rgba, mix = ExtCore.mix,
    tint = ExtCore.tint, fontStack = ExtCore.fontStack, merge = ExtCore.merge;

  var STORAGE_KEY = 'sankey1';

  var MONO_STACK = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

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

  /** Level colours, by position on the Levels tile (from the design: table, data source, workbook, view). */
  var LEVEL_COLORS = ['#4A5468', '#0F7C7C', '#7B4FD1', '#C2426B', '#E08A2E', '#2F7FC1'];

  /** Look of one level (column), by position. Field-specific texts live in `names`. */
  var LEVEL = {
    color: '#4A5468' // node colour of this level when Nodes → Color by is "Level"
  };

  /** Palette for "Color by first level member" (and the series theme colours). */
  var PALETTE = ['#2F4B7C', '#EB644C', '#0F7C7C', '#E0A030', '#7B4FD1', '#2F7FC1', '#C2426B', '#6E9B3C'];

  var DEFAULTS = {
    // ---- Header + card (Icon and Title & text = KPI Card; Card = Waterfall) --
    icon: {
      show: false,
      source: 'builtin', // builtin | upload
      builtinId: 'fg-bar-chart-solid',
      size: 24,
      color: '#EB644C',
      dataUrl: '',
      name: '',
      mask: false,
      w: 0,
      h: 0
    },
    title: {
      show: true,
      text: 'Flow', // {total} {nodes} {links} {flow} and <Parameter> work here
      align: 'left',
      font: 'Lato',
      size: 16,
      weight: 700,
      color: '#17202B',
      italic: false
    },
    explanation: {
      show: true,
      reserveSpace: false,
      text: '{flow} · hover a flow, click to select it',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: false
    },
    card: {
      padding: 15,
      bgColor: '#FFFFFF',
      bgOpacity: 0,
      gap: 12, // space between the header and the chart
      plotBg: '#FFFFFF',
      plotBgOpacity: 0
    },

    // ---- Levels (columns) ----------------------------------------------------
    levels: [
      { color: LEVEL_COLORS[0] }, { color: LEVEL_COLORS[1] }, { color: LEVEL_COLORS[2] },
      { color: LEVEL_COLORS[3] }, { color: LEVEL_COLORS[4] }, { color: LEVEL_COLORS[5] }
    ],
    names: {}, // level field name → { header, legend } (empty → the field name)
    data: {
      maxRows: 1000, // rows read from the worksheet; 0 = no limit (Format → Card → Maximum rows)
      nulls: 'skip', // skip (the link jumps over the empty level) | show ("Null" node)
      sort: 'flow', // flow (fewest crossings, weighted by value) | value (largest first) | name
      topN: 0, // 0 = off; N = keep the N largest nodes per level, merge the rest into one "Others" node
      othersLabel: 'Others'
    },

    // ---- Numbers ---------------------------------------------------------------
    numbers: {
      scale: 'dynamic', // dynamic (K / M / B) | K | M | B | none (full number) | percent (value is a 0-1 ratio)
      decimals: 1,
      unit: '', // e.g. SAR
      unitPosition: 'suffix', // suffix | prefix
      font: 'Lato' // font of the values in labels, headers and tooltip
    },

    // ---- Column headers ----------------------------------------------------
    headers: {
      show: true,
      totals: false, // the column's total under its name
      font: 'Lato',
      size: 11,
      weight: 700,
      color: '#68707D',
      uppercase: true,
      spacing: 0.06 // letter spacing (em)
    },

    // ---- Nodes (solid rectangles) ----------------------------------------------
    nodes: {
      width: 14, // px, 6-40
      radius: 2,
      gap: 10, // vertical space between nodes (px); shrinks on its own when a column is crowded
      colorBy: 'level', // level (palette by column) | first (by first-level member) | single
      color: '#4A5468', // colour when colorBy is "single"
      palette: PALETTE.slice() // colours for colorBy "first", used in turn
    },

    // ---- Labels (beside the node) ----------------------------------------------
    labels: {
      show: true,
      side: 'auto', // auto (right of the node, left in the last column) | right | left
      showValue: true,
      showPercent: false, // share of the column total
      maxWidth: 170, // px; longer names get an ellipsis
      halo: true, // white outline so text stays readable over links
      haloColor: '#FFFFFF',
      font: 'Lato',
      size: 12,
      weight: 600,
      color: '#17202B',
      valueWeight: 400,
      valueColor: '#68707D'
    },

    // ---- Links (ribbons) -----------------------------------------------------------
    links: {
      color: 'source', // source | target | gradient (source to target) | single
      singleColor: '#C9CDD4',
      opacity: 40 // %
    },

    // ---- Hover / selection highlight -------------------------------------------------
    highlight: {
      hover: true, // hovering a node or link highlights its flow and dims the rest
      linkOpacity: 75, // % for highlighted links
      dimOpacity: 10, // % for everything else
      matchColor: '#EB644C' // outline of nodes matching the search
    },

    // ---- Legend ------------------------------------------------------------------
    legend: {
      show: false, // level colours (only when Color by is "Level")
      position: 'header', // header (right of the title) | top | bottom
      useHeaders: false, // legend names: false = the field names, true = the column headers
      font: 'Lato',
      size: 12,
      color: '#3D4552'
    },

    // ---- Search ------------------------------------------------------------------
    search: {
      show: true,
      placeholder: 'Search nodes…',
      mode: 'highlight', // highlight (matches + their flow) | filter (dim everything else strongly)
      width: 180
    },

    // ---- Tooltip + interaction ---------------------------------------------------
    tooltip: {
      show: true,
      showDetails: true // measures on Tableau's Tooltip tile
    },
    interaction: {
      rightClickMenu: true,
      dblclick: 'format', // format | none
      dialog: 'onTop', // onTop (modal: stays in front of Tableau) | floating (modeless)
      selectInTableau: true, // click a node or link: its values are selected in Tableau (dashboard actions)
      tableauTooltip: false // true: hovering shows the tooltip designed in Tableau instead of this extension's own
    },
    export: {
      picture: true // a "Save as picture" button (PNG) in the top-right corner, shown on hover
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
    if (!icon) return { html: '', w: 0, h: 0, icon: { label: '' } };
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

  // -------------------------------------------------------------------------
  // Settings I/O
  // -------------------------------------------------------------------------

  /** Stored settings over the defaults; every level filled in. */
  function normalize (cfg) {
    var lv = [];
    for (var i = 0; i < 6; i++) {
      var d = DEFAULTS.levels[i];
      lv.push(merge(merge(LEVEL, d), (cfg.levels || [])[i]));
    }
    cfg.levels = lv;
    return cfg;
  }

  function readFrom (obj) { return normalize(merge(DEFAULTS, obj)); }

  function read () {
    try {
      var raw = tableau.extensions.settings.get(STORAGE_KEY);
      return readFrom(raw ? JSON.parse(raw) : null);
    } catch (e) {
      return normalize(clone(DEFAULTS));
    }
  }

  function write (cfg) {
    tableau.extensions.settings.set(STORAGE_KEY, JSON.stringify(cfg));
    return tableau.extensions.settings.saveAsync();
  }

  /** 1234567 → "1.2M". Settings: numbers.scale / decimals / unit / unitPosition. */
  function formatNumber (v, f) {
    f = f || DEFAULTS.numbers;
    if (v == null || !isFinite(v)) return '—';
    var sc = f.scale === 'percentDynamic' ? 'percent' : (['dynamic', 'K', 'M', 'B', 'none', 'percent'].indexOf(f.scale) < 0 ? 'dynamic' : f.scale);
    var t;
    if (sc === 'percent') t = ExtCore.fixed(v * 100, f.decimals) + '%';
    else t = ExtCore.formatScaled(v, sc, f.decimals, sc === 'none' ? '' : undefined);
    var u = String(f.unit || '');
    if (!u) return t;
    return f.unitPosition === 'prefix' ? u + ' ' + t : t + ' ' + u;
  }

  function levelCfg (cfg, i) { return cfg.levels[i] || merge(LEVEL, { color: LEVEL_COLORS[i % LEVEL_COLORS.length] }); }

  // -------------------------------------------------------------------------
  // Fonts + colours
  // -------------------------------------------------------------------------

  /**
   * Which settings each brand-theme key drives (see shared/theme.js). Inert data: nothing reads
   * it until the Presets tab offers "Apply theme". Only plain look settings; per-measure / per-member
   * maps are never themed.
   */
  var THEME_MAP = {
    'fonts.family': ['title.font', 'explanation.font', 'headers.font', 'labels.font', 'numbers.font', 'legend.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.textSize': ['explanation.size'],
    'colors.muted': ['explanation.color', 'headers.color', 'labels.valueColor'],
    'colors.accent': ['icon.color', 'highlight.matchColor'],
    'colors.background': ['card.bgColor', 'card.plotBg'],
    'colors.backgroundOpacity': ['card.bgOpacity', 'card.plotBgOpacity'],
    'card.padding': ['card.padding'],
    'colors.text': ['title.color', 'labels.color'],
    'colors.series': ['nodes.palette'],
    'numbers.scale': ['numbers.scale'],
    'numbers.decimals': ['numbers.decimals']
  };

  window.Sk = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    LEVEL: LEVEL,
    PALETTE: PALETTE,
    formatNumber: formatNumber,
    LEVEL_COLORS: LEVEL_COLORS,
    FONTS: FONTS,
    MONO_STACK: MONO_STACK,
    ICONS: ICONS,
    ICON_GROUPS: ICON_GROUPS,
    findIcon: findIcon,
    iconHtml: iconHtml,
    clone: clone,
    merge: merge,
    normalize: normalize,
    readFrom: readFrom,
    read: read,
    write: write,
    levelCfg: levelCfg,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba,
    mix: mix,
    tint: tint
  };
  window.Kpi3 = window.Kpi3 || window.Sk;
})();
