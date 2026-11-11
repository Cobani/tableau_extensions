'use strict';

/**
 * Narrative Card — shared configuration and template language.
 *
 * Loaded by both the card (index.html) and the Format dialog (configure.html)
 * so the two agree on the settings shape, the defaults, number
 * formatting, the template parser / renderer and the built-in icon set.
 *
 * Everything is stored as one JSON string under a single settings key, which
 * Tableau persists inside the workbook.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var clone = ExtCore.clone, normalizeHex = ExtCore.normalizeHex, rgba = ExtCore.rgba, fontStack = ExtCore.fontStack,
    merge = ExtCore.merge, esc = ExtCore.esc, pickScale = ExtCore.pickScale, fixed = ExtCore.fixed, formatScaled = ExtCore.formatScaled;

  var STORAGE_KEY = 'narrativeCard1';

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
   * Every setting of the card, with its default. Settings are stored as one JSON string;
   * new settings must always get a default here so old workbooks still load.
   */
  var DEFAULTS = {
    // ---- Header (all optional; off by default so the text can fill the zone) ----
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
      text: '', // empty → nothing (a title is written by the dashboard builder)
      align: 'left', // left | center | right
      font: 'Lato',
      size: 16,
      weight: 500,
      color: '#68707D',
      italic: false
    },
    explanation: {
      show: false,
      reserveSpace: false, // keep the line even when empty/hidden
      text: '',
      font: 'Lato',
      size: 12,
      weight: 400,
      color: '#68707D',
      italic: true
    },
    // ---- The sentences ----
    template: {
      text: '' // the template (see README "Template language"); empty → one sentence per measure
    },
    text: {
      font: 'Lato',
      size: 16,
      weight: 400,
      color: '#263244',
      italic: false,
      lineHeight: 1.5, // multiple of the font size
      align: 'left', // left | center | right | justify
      vAlign: 'top', // top | middle | bottom
      paragraphGap: 8, // px between paragraphs and bullets
      unknownColor: '#C0392B' // colour of {Typo} tokens that match no field
    },
    // Style of the numbers inside the text ({Name}, {Name.change}, …)
    highlight: {
      weight: 700,
      color: '#263244', // '' → same colour as the text
      changeColors: true, // change tokens use the good / bad / neutral colours
      goodColor: '#2E9E6A',
      badColor: '#E35263',
      neutralColor: '#68707D',
      arrows: true, // ▲ ▼ before change figures (off: + / - sign instead)
      wordUp: 'rose', // {Name.direction}
      wordDown: 'fell',
      wordFlat: 'was flat'
    },
    // ---- Numbers ----
    number: {
      period: 'day', // day (latest date) | mtd (month to date) — what {Name} shows
      mtdAgg: 'sum' // sum | avg — how days are rolled up into the MTD value
    },
    // Per-measure format, keyed by pill name (see MEASURE_ITEM)
    measures: {
      items: []
    },
    // ---- Comparison (the date and % change logic of a single-number card, for every measure) ----
    change: {
      compareTo: 'previous', // previous (date point before) | prevMonth (same day last month)
      period: 'day', // day (single day) | mtd (month to date)
      mtdAgg: 'sum', // sum | avg — how days are rolled up into MTD
      type: 'percent', // percent | pp (a measure can override it)
      decimals: 1,
      periodWord: 'period' // "previous period" in the default text
    },
    interaction: {
      selectInTableau: true, // click selects the latest date in Tableau (needs a Date tile)
      tableauTooltip: false // show the tooltip designed in Tableau instead of this extension's own
    },
    export: {
      picture: true // button on the card that saves it as a PNG picture
    },
    data: {
      maxRows: 1000 // rows read from the worksheet; 0 = no limit (Format → Card → Maximum rows)
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
        html = '<span class="nc-icon-mask" style="display:block;width:' + size.w + 'px;height:' + size.h +
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

  // -------------------------------------------------------------------------
  // Per-measure settings. One entry per measure on the Measures tile, matched by key (the pill
  // name without its aggregation, so SUM → AVG keeps its settings; a repeated name gets " #2").
  // -------------------------------------------------------------------------
  var MEASURE_ITEM = {
    key: '',
    label: '', // empty → the measure's name; also accepted as the token name: {Label}
    scale: 'dynamic', // dynamic | K | M | B | none | percent | percentDynamic | workbook
    decimals: 1,
    pctFromRatio: true, // percent formats and pp change: 0.4523 → 45.23%
    unit: '',
    unitPosition: 'suffix', // suffix | prefix
    higherIsBetter: true, // "increase is good": an increase uses the good colour
    mtdAgg: 'auto', // month to date roll-up: auto (Numbers / Comparison tabs) | sum | avg (use avg for balances and ratios)
    changeType: 'auto' // auto (Comparison tab) | percent | pp
  };

  /** Settings of one measure (defaults filled in). */
  function measureItem (measures, key) {
    var items = measures && Array.isArray(measures.items) ? measures.items : [];
    var hit = null;
    for (var i = 0; i < items.length; i++) { if (items[i] && items[i].key === key) { hit = items[i]; break; } }
    var it = merge(MEASURE_ITEM, hit);
    it.key = key;
    return it;
  }

  // -------------------------------------------------------------------------
  // Template language: a small parser and renderer. Pure functions (no DOM, no Tableau), tested in
  // node. Everything that comes from the template or the data goes through esc(): no raw HTML.
  // -------------------------------------------------------------------------
  var PROPS = ['change', 'diff', 'previous', 'date', 'direction', 'name'];
  var SCALE_WORDS = { k: 'K', m: 'M', b: 'B', none: 'none', full: 'none', dynamic: 'dynamic', auto: 'dynamic' };
  var ARROW = { up: '▲', down: '▼', flat: '▶' };

  /** "Avg Order Value.change" → { name: "Avg Order Value", prop: "change" } (the suffix must be a known property). */
  function splitRef (s) {
    s = String(s).trim();
    var i = s.lastIndexOf('.');
    if (i > 0) {
      var p = s.slice(i + 1).trim().toLowerCase();
      if (PROPS.indexOf(p) >= 0) return { name: s.slice(0, i).trim(), prop: p };
    }
    return { name: s, prop: '' };
  }

  /** "M", "1", "%", "+" … → { decimals, scale, percent, plus }. Unknown words are ignored. */
  function parseMods (list) {
    var m = { decimals: null, scale: '', percent: false, plus: false };
    list.forEach(function (w) {
      w = String(w).trim();
      if (/^\d+$/.test(w)) m.decimals = Math.min(10, Number(w));
      else if (w === '%') m.percent = true;
      else if (w === '+') m.plus = true;
      else if (SCALE_WORDS[w.toLowerCase()]) m.scale = SCALE_WORDS[w.toLowerCase()];
    });
    return m;
  }

  /** "Revenue.change > 0" | "has Revenue.change" → condition, or null when it can't be read. */
  function parseCond (s) {
    var has = /^has\s+(.+)$/i.exec(s);
    if (has) return { has: true, ref: splitRef(has[1]) };
    var m = /^(.+?)\s*(>=|<=|!=|>|<|=)\s*(-?\d+(?:\.\d+)?)\s*$/.exec(s);
    if (!m) return null;
    return { has: false, ref: splitRef(m[1]), op: m[2], num: Number(m[3]) };
  }

  /**
   * Template text → { nodes, open }. Nodes: { t: 'text', s } | { t: 'field', raw, name, prop, mods } |
   * { t: 'if', raw, cond, then: [nodes], other: [nodes] }. One level of {if}…{else}…{end}; anything that
   * can't be read (a nested {if}, a stray {end}, a broken condition) stays as plain text.
   */
  function parseTemplate (text) {
    var src = String(text == null ? '' : text);
    var root = [];
    var cur = root;
    var open = null;
    var re = /\{([^{}]*)\}/g;
    var last = 0;
    var m;
    function pushText (s) { if (s) cur.push({ t: 'text', s: s }); }
    while ((m = re.exec(src))) {
      pushText(src.slice(last, m.index));
      last = re.lastIndex;
      var raw = m[0];
      var inner = m[1].trim();
      var low = inner.toLowerCase();
      if (/^if\s/.test(low)) {
        var cond = open ? null : parseCond(inner.slice(2).trim());
        if (!cond) { pushText(raw); continue; }
        open = { t: 'if', raw: raw, cond: cond, then: [], other: [] };
        cur.push(open);
        cur = open.then;
        continue;
      }
      if (low === 'else' && open && cur === open.then) { cur = open.other; continue; }
      if (low === 'end' && open) { open = null; cur = root; continue; }
      if (!inner || low === 'else' || low === 'end') { pushText(raw); continue; }
      var parts = inner.split('|');
      var ref = splitRef(parts[0]);
      cur.push({ t: 'field', raw: raw, name: ref.name, prop: ref.prop, mods: parseMods(parts.slice(1)) });
    }
    pushText(src.slice(last));
    return { nodes: root, open: !!open };
  }

  /** A measure's value text in its own format. `isDiff`: a difference (percent formats say "pp"). */
  function formatItem (item, v, fv, mods, isDiff) {
    mods = mods || {};
    if (!isFinite(v)) return '—';
    var dec = mods.decimals != null ? mods.decimals : item.decimals;
    var scale = item.scale;
    var text;
    if (mods.percent || scale === 'percent' || scale === 'percentDynamic') {
      var dyn = scale === 'percentDynamic' || mods.scale === 'dynamic';
      text = formatScaled(item.pctFromRatio ? v * 100 : v, dyn ? 'dynamic' : 'none', dec) + (isDiff ? ' pp' : '%');
    } else if (scale === 'workbook' && fv && !mods.scale && mods.decimals == null) {
      text = fv;
    } else {
      text = formatScaled(v, mods.scale || (scale === 'workbook' ? 'dynamic' : scale), dec);
    }
    if (mods.plus && v > 0) text = '+' + text;
    if (item.unit) text = item.unitPosition === 'prefix' ? item.unit + ' ' + text : text + ' ' + item.unit;
    return text;
  }

  /**
   * Change of a measure (the comparison value `f.cmpCur` against `f.prev`) →
   * { dir: up|down|flat, amount (signed, in % or pp), diff, good: true|false|null, suffix, dec } or null.
   */
  function changeInfo (f, item, change, decimals) {
    var cur = f.cmpCur;
    var prev = f.prev;
    if (!isFinite(cur) || !isFinite(prev)) return null;
    var type = item.changeType === 'percent' || item.changeType === 'pp' ? item.changeType : change.type;
    var diff = cur - prev;
    var amount, suffix;
    if (type === 'pp') {
      amount = item.pctFromRatio ? diff * 100 : diff;
      suffix = ' pp';
    } else {
      if (prev === 0) return null;
      amount = diff / Math.abs(prev) * 100;
      suffix = '%';
    }
    var dec = decimals != null ? decimals : change.decimals;
    var zero = Number(Math.abs(amount).toFixed(Math.max(0, dec))) === 0;
    var dir = zero ? 'flat' : amount > 0 ? 'up' : 'down';
    return {
      dir: dir, amount: amount, diff: diff, suffix: suffix, dec: dec,
      good: dir === 'flat' ? null : (dir === 'up') === (item.higherIsBetter !== false)
    };
  }

  /** The numeric value a condition compares: value, previous, diff or change (signed); NaN when there is none. */
  function refNumber (f, item, ref, change) {
    switch (ref.prop) {
      case '': return f.cur;
      case 'previous': return f.prev;
      case 'diff': return isFinite(f.cmpCur) && isFinite(f.prev) ? f.cmpCur - f.prev : NaN;
      case 'change': var ci = changeInfo(f, item, change, null); return ci ? ci.amount : NaN;
    }
    return NaN;
  }

  function condTrue (cond, n) {
    if (cond.has) return isFinite(n);
    if (!isFinite(n)) return false;
    switch (cond.op) {
      case '>': return n > cond.num;
      case '>=': return n >= cond.num;
      case '<': return n < cond.num;
      case '<=': return n <= cond.num;
      case '=': return n === cond.num;
      case '!=': return n !== cond.num;
    }
    return false;
  }

  /** Inline CSS of the highlighted numbers. */
  function numStyle (hl, color) {
    var c = color || hl.color;
    return 'font-weight:' + (Number(hl.weight) || 700) + (c ? ';color:' + c : '');
  }

  /**
   * Renders a template to safe HTML.
   *   ctx.fields  [{ key, label, cur, fv, cmpCur, prev, date }]  numbers are NaN when missing
   *   ctx.item    function (field) → its settings (measureItem)
   *   ctx.params  { 'lower case name': 'value' }  for <Parameter name>
   *   ctx.change  the `change` settings   ctx.highlight  the `highlight` settings
   * Unknown {names} render as the raw token in a span of class "nc-unknown".
   */
  function renderTemplate (template, ctx) {
    var tpl = typeof template === 'string' ? parseTemplate(template) : template;
    var hl = ctx.highlight || DEFAULTS.highlight;
    var index = {};
    (ctx.fields || []).forEach(function (f) {
      var it = ctx.item(f);
      [f.label, f.key, it && it.label].forEach(function (n) {
        var k = String(n || '').trim().toLowerCase();
        if (k && !index[k]) index[k] = { f: f, item: it };
      });
    });
    var pieces = [];
    var out = '';
    function piece (html) { pieces.push(html); return '\u0001' + (pieces.length - 1) + '\u0002'; }
    function numSpan (f, text, color) {
      return '<span class="nc-num" data-f="' + esc(f.key) + '" style="' + esc(numStyle(hl, color)) + '">' + esc(text) + '</span>';
    }
    function field (n) {
      var hit = index[n.name.toLowerCase()];
      if (!hit) return '<span class="nc-unknown" title="' + esc('No field called "' + n.name + '"') + '">' + esc(n.raw) + '</span>';
      var f = hit.f;
      var item = hit.item;
      switch (n.prop) {
        case '': return numSpan(f, formatItem(item, f.cur, f.fv, n.mods));
        case 'previous': return isFinite(f.prev) ? numSpan(f, formatItem(item, f.prev, null, n.mods)) : '';
        case 'diff':
          if (!isFinite(f.cmpCur) || !isFinite(f.prev)) return '';
          var d = f.cmpCur - f.prev;
          return numSpan(f, formatItem(item, n.mods.plus ? d : Math.abs(d), null, n.mods, true));
        case 'change':
          var ci = changeInfo(f, item, ctx.change, n.mods.decimals);
          if (!ci) return '';
          var body = ExtCore.fixed(Math.abs(ci.amount), ci.dec) + ci.suffix;
          var text = hl.arrows && !n.mods.plus
            ? ARROW[ci.dir] + ' ' + body
            : (ci.dir === 'up' ? '+' : ci.dir === 'down' ? '-' : '') + body;
          var col = hl.changeColors ? (ci.good === null ? hl.neutralColor : ci.good ? hl.goodColor : hl.badColor) : '';
          return numSpan(f, text, col);
        case 'direction':
          var di = changeInfo(f, item, ctx.change, null);
          return di ? esc(di.dir === 'up' ? hl.wordUp : di.dir === 'down' ? hl.wordDown : hl.wordFlat) : '';
        case 'date': return esc(f.date || '');
        case 'name': return esc(item.label || f.label);
      }
      return '';
    }
    function walk (nodes) {
      nodes.forEach(function (n) {
        if (n.t === 'text') {
          var s = n.s.replace(/[\u0001\u0002]/g, '');
          out += s.replace(/<([^<>\n]+)>/g, function (all, nm) {
            var v = ctx.params ? ctx.params[nm.trim().replace(/^\[?parameters\]?\./i, '').replace(/^\[|\]$/g, '').toLowerCase()] : null;
            return v != null ? piece(esc(v)) : all;
          });
        } else if (n.t === 'field') {
          out += piece(field(n));
        } else if (n.t === 'if') {
          var hit = index[n.cond.ref.name.toLowerCase()];
          var num = hit ? refNumber(hit.f, hit.item, n.cond.ref, ctx.change) : NaN;
          walk(condTrue(n.cond, num) ? n.then : n.other);
        }
      });
    }
    walk(tpl.nodes);

    var back = function (html) { return html.replace(/\u0001(\d+)\u0002/g, function (a, i) { return pieces[Number(i)]; }); };
    var inline = function (line) {
      return back(esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\*(.+?)\*/g, '<i>$1</i>'));
    };
    var blank = function (line) { return !back(esc(line)).replace(/<[^>]*>/g, '').trim(); };
    var html = '';
    var inList = false;
    out.split(/\r?\n/).forEach(function (line) {
      var bullet = /^\s*-\s+(.*)$/.exec(line);
      var body = bullet ? bullet[1] : line;
      if (blank(body)) return;
      if (bullet) {
        if (!inList) { html += '<ul class="nc-ul">'; inList = true; }
        html += '<li>' + inline(body) + '</li>';
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p class="nc-p">' + inline(body.trim()) + '</p>';
      }
    });
    if (inList) html += '</ul>';
    return html;
  }

  /** One sentence per measure, used while the template is empty. `phrase`: "previous period", "same day last month"… */
  function defaultTemplate (labels, phrase) {
    var w = String(phrase || 'previous period').replace(/[{}|]/g, ' ');
    return (labels || []).map(function (l) {
      var n = String(l).replace(/[{}|]/g, ' ').trim();
      return n + ': {' + n + '}{if has ' + n + '.change} ({' + n + '.change} vs ' + w + '){end}';
    }).join('\n');
  }

  /** The change type a measure uses (for the dialog and README wording). */
  function changeTypeOf (item, change) {
    return item.changeType === 'percent' || item.changeType === 'pp' ? item.changeType : change.type;
  }

  /**
   * Which settings each brand-theme key drives (see shared/theme.js). Inert data: nothing reads
   * it until the Presets tab offers "Apply theme". Only plain look settings; per-measure / per-member
   * maps are never themed.
   */
  var THEME_MAP = {
    'fonts.family': ['title.font', 'explanation.font', 'text.font'],
    'fonts.titleSize': ['title.size'],
    'fonts.titleWeight': ['title.weight'],
    'fonts.textSize': ['explanation.size'],
    'colors.title': ['title.color'],
    'colors.muted': ['explanation.color'],
    'colors.accent': ['icon.color'],
    'colors.background': ['card.bgColor'],
    'colors.backgroundOpacity': ['card.bgOpacity'],
    'card.padding': ['card.padding'],
    'fonts.numberWeight': ['highlight.weight'],
    'colors.number': ['highlight.color'],
    'colors.changeUp': ['highlight.goodColor'],
    'colors.changeDown': ['highlight.badColor'],
    'colors.neutral': ['highlight.neutralColor'],
    'colors.divider': ['card.dividerColor']
  };

  window.Nc = {
    MEASURE_ITEM: MEASURE_ITEM,
    measureItem: measureItem,
    parseTemplate: parseTemplate,
    renderTemplate: renderTemplate,
    defaultTemplate: defaultTemplate,
    formatItem: formatItem,
    changeInfo: changeInfo,
    changeTypeOf: changeTypeOf,
    PROPS: PROPS,
    ARROW: ARROW,
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
