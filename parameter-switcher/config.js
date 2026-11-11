'use strict';

/**
 * Parameter Switcher — shared configuration.
 *
 * Loaded by both the control (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, the choice labels and the
 * built-in icon set.
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var clone = ExtCore.clone, normalizeHex = ExtCore.normalizeHex, rgba = ExtCore.rgba, fontStack = ExtCore.fontStack,
    merge = ExtCore.merge, pickScale = ExtCore.pickScale, fixed = ExtCore.fixed, formatScaled = ExtCore.formatScaled;

  var STORAGE_KEY = 'parameterSwitcher1';

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
   * Every setting, with the value a new switcher starts with. Saved settings are merged over
   * this, so a setting added later never breaks an old workbook.
   */
  var DEFAULTS = {
    // ---- Which parameter ----------------------------------------------------
    parameter: {
      name: '' // the Tableau parameter this control sets (chosen in Format → Control; empty = nothing chosen yet)
    },
    // ---- Choices ------------------------------------------------------------
    options: {
      labels: {}, // text shown instead of a value: { "<raw value as text>": "My label" }  (empty = Tableau's formatted value)
      hidden: {} // values left out of the control: { "<raw value as text>": true }
    },
    // ---- The control itself -------------------------------------------------
    control: {
      style: 'tabs', // tabs (underline) | segmented (joined buttons) | pills | dropdown | toggle (2 values) | stepper (previous / value / next)
      layout: 'horizontal', // horizontal | vertical | wrap
      align: 'left', // left | center | right | stretch (fill the width)
      vAlign: 'top', // top | middle | bottom — where the control sits in a tall zone
      equalWidth: false, // every choice as wide as the widest
      gap: 6, // px between choices (pills, wrap, vertical)
      size: 'M', // S | M | L — text and padding
      radius: 6, // px corner radius (pills are always round)
      borderWidth: 1, // px
      borderColor: '#D5D9DF',
      font: 'Lato',
      weight: 500, // normal choices
      selectedWeight: 700, // the selected choice
      italic: false,
      autoDropdown: true, // too many choices for the chosen style: use the dropdown instead
      autoDropdownAbove: 12 // "too many" = more than this many choices
    },
    // ---- Colours per state --------------------------------------------------
    colors: {
      normal: { text: '#68707D', bg: '#FFFFFF' }, // bg: segmented / pills / toggle track / dropdown / stepper (tabs have none)
      hover: { text: '#263244', bg: '#F1F3F5' },
      selected: { text: '#EB644C', bg: '#FDEDEA', accent: '#EB644C' } // accent: the underline of tabs
    },
    // ---- Header (all off by default: a control normally needs no heading) ----
    icon: {
      show: false,
      source: 'builtin', // builtin | upload | shape
      builtinId: 'fg-bar-chart-solid',
      size: 24, // px on the icon's longer side
      color: '#EB644C', // tints built-in icons only
      dataUrl: '',
      name: ''
    },
    title: {
      show: false,
      text: '', // empty → the parameter's name
      align: 'left', // left | center | right
      font: 'Lato',
      size: 16,
      weight: 500,
      color: '#68707D',
      italic: false
    },
    explanation: {
      show: false,
      reserveSpace: false,
      text: '',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: true
    },
    interaction: {
      // Nothing here: a control sets a parameter, it does not select marks or show a tooltip. The section
      // exists only so repo tests that look for it keep passing.
      selectInTableau: false,
      tableauTooltip: false
    },
    export: {
      picture: false // button on the control that saves it as a PNG picture
    },
    // ---- Data ---------------------------------------------------------------
    data: {
      maxRows: 1000 // rows read for the Options tile; 0 = no limit (Format → Card → Maximum rows)
    },
    card: {
      padding: 15,
      bgColor: '#FFFFFF',
      bgOpacity: 0,
      divider: false, // dashed right border
      dividerColor: '#E2E4E8'
    }
  };

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
        html = '<span class="ps-icon-mask" style="display:block;width:' + size.w + 'px;height:' + size.h +
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

  function escHtml (s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

/**
   * Which settings each brand-theme key drives (see shared/theme.js). Only plain look settings;
   * the per-value maps (options.labels / hidden) are never themed.
   */
  var THEME_MAP = {
    'fonts.family': ['control.font', 'title.font', 'explanation.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.titleWeight': ['title.weight'],
    'fonts.textSize': ['explanation.size'],
    'colors.title': ['title.color'],
    'colors.muted': ['explanation.color', 'colors.normal.text'],
    'colors.accent': ['icon.color', 'colors.selected.accent', 'colors.selected.text'],
    'colors.background': ['card.bgColor'],
    'colors.backgroundOpacity': ['card.bgOpacity'],
    'card.padding': ['card.padding'],
    'colors.divider': ['card.dividerColor']
  };

  // -------------------------------------------------------------------------
  // Choices: the labels and hidden values the Format dialog edits
  // -------------------------------------------------------------------------
  /** The text shown for a choice: the label set in Format → Choices, else Tableau's formatted value. */
  function labelFor (options, key, formatted) {
    var l = options && options.labels && options.labels[key];
    return l != null && String(l).trim() !== '' ? String(l) : String(formatted == null ? key : formatted);
  }

  function isHidden (options, key) {
    return !!(options && options.hidden && options.hidden[key]);
  }

  /** Font size and padding of the three control sizes. */
  var SIZES = {
    S: { font: 12, padY: 4, padX: 10, height: 26 },
    M: { font: 14, padY: 6, padX: 14, height: 32 },
    L: { font: 16, padY: 9, padX: 18, height: 40 }
  };

  window.Ps = {
    STORAGE_KEY: STORAGE_KEY,
    DEFAULTS: DEFAULTS,
    THEME_MAP: THEME_MAP,
    SIZES: SIZES,
    labelFor: labelFor,
    isHidden: isHidden,
    escHtml: escHtml,
    FONTS: FONTS,
    ICONS: ICONS,
    findIcon: findIcon,
    ICON_GROUPS: ICON_GROUPS,
    iconHtml: iconHtml,
    iconSvg: iconSvg,
    clone: clone,
    merge: merge,
    read: read,
    write: write,
    pickScale: pickScale,
    fixed: fixed,
    formatScaled: formatScaled,
    fontStack: fontStack,
    normalizeHex: normalizeHex,
    rgba: rgba
  };
})();
