'use strict';

/**
 * ExtTheme — one brand theme that every extension can apply, so a dashboard with
 * several extensions looks like one product.
 *
 * Loaded (once wired into the pages) after core.js and before the extension's config.js. The
 * engine knows nothing about a particular chart: each extension's config.js publishes a
 * THEME_MAP that says which of its settings each theme key drives. Applying a theme only
 * copies values into settings that already exist, so old workbooks and presets keep loading.
 *
 *   Theme file (JSON). Every key is optional: a theme only changes what it names.
 *   {
 *     "type": "tableau-extensions-theme", "version": 1, "name": "Midnight",
 *     "fonts":   { "family": "Lato",       // text font of titles, labels, axes, legends
 *                  "titleSize": 16, "titleWeight": 500,
 *                  "textSize": 12,          // explanation / subtitle size
 *                  "numberWeight": 700 },   // headline numbers and totals
 *     "colors":  { "text": "#17202B",       // strong text drawn on the card (axis categories, panel titles)
 *                  "title": "#68707D",      // title (most extensions use the muted grey)
 *                  "muted": "#68707D",      // explanation / subtitle, small headers
 *                  "number": "#263244",     // the big number of a KPI card
 *                  "axisText": "#55606E",   // value-axis labels, legend text
 *                  "axisLine": "#C9CDD4",   // axis and zero lines
 *                  "accent": "#EB644C",     // icon, highlight, crosshair, comment marks
 *                  "accent2": "#2F4B7C",    // single bar colour, band, default step colour
 *                  "positive": "#0E7C66",   // increase bars, positive differences
 *                  "negative": "#B4431E",   // decrease bars, negative differences
 *                  "changeUp": "#2E9E6A",   // % change text, up
 *                  "changeDown": "#E35263", // % change text, down
 *                  "neutral": "#68707D",    // % change text, no change
 *                  "background": "#FFFFFF", "backgroundOpacity": 0,   // card (and plot) background, 0-100
 *                  "grid": "#ECEEF1",       // grid lines
 *                  "divider": "#E2E4E8",    // divider between cards, legend border
 *                  "series": ["#2F4B7C", "#EB644C"] },  // palette for series / categories (1-12 colours)
 *     "card":    { "padding": 15 },
 *     "numbers": { "scale": "dynamic",      // none | K | M | B | dynamic | workbook | percent | percentDynamic
 *                  "decimals": 1,
 *                  "negative": "minus" }    // minus | hyphen | paren
 *   }
 *
 *   THEME_MAP (in each config.js): themeKey ("colors.text") → list of settings paths. An entry is
 *   a path string, or an object (declarative, so a map survives JSON and can be tested):
 *     { path, map: { themeValue: settingValue } }   convert a value
 *     { path, scale: 100 }                          setting = theme value × scale
 *     { path, set: 'house' }                        write this constant whenever the key is applied
 *     { path, create: true }                        the last path part may not exist yet (palette edits)
 *   Per-measure / per-member maps (free-form {} in DEFAULTS) are never themed, except through
 *   `create`. Extensions without a path for a key simply ignore that key.
 *
 *   Default values: shared/themes/Default.json names only keys whose default is the same in every
 *   extension that maps it, so applying it to a fresh config changes nothing.
 *
 *   API: validate, parse, apply, fromSettings, list, save, remove, STORE_KEY, CURRENT_VERSION, MIGRATIONS
 *   Tests: tests/theme.test.js
 */
(function (root) {
  const core = root.ExtCore || (typeof require !== 'undefined' ? require('./core.js') : null);

  const TYPE = 'tableau-extensions-theme';
  /**
   * Theme format version. When a key changes shape, bump this and add a step to MIGRATIONS
   * (key = the version it upgrades from) so older theme files keep working.
   */
  const CURRENT_VERSION = 1;
  const MIGRATIONS = {};
  const STORE_KEY = 'tableau-extensions:themes:v1';

  const SCALES = ['none', 'K', 'M', 'B', 'dynamic', 'workbook', 'percent', 'percentDynamic'];
  const NEGATIVE = ['minus', 'hyphen', 'paren'];

  // Every documented key: path → how to check it. Order = order in a theme made by fromSettings.
  const hex = { t: 'hex' };
  const SCHEMA = {
    'fonts.family': { t: 'font' },
    'fonts.titleSize': { t: 'num', min: 6, max: 96 },
    'fonts.titleWeight': { t: 'num', min: 100, max: 900 },
    'fonts.textSize': { t: 'num', min: 6, max: 96 },
    'fonts.numberWeight': { t: 'num', min: 100, max: 900 },
    'colors.text': hex, 'colors.title': hex, 'colors.muted': hex, 'colors.number': hex,
    'colors.axisText': hex, 'colors.axisLine': hex, 'colors.accent': hex, 'colors.accent2': hex,
    'colors.positive': hex, 'colors.negative': hex, 'colors.changeUp': hex, 'colors.changeDown': hex,
    'colors.neutral': hex, 'colors.background': hex,
    'colors.backgroundOpacity': { t: 'num', min: 0, max: 100 },
    'colors.grid': hex, 'colors.divider': hex,
    'colors.series': { t: 'hexlist', min: 1, max: 12 },
    'card.padding': { t: 'num', min: 0, max: 80 },
    'numbers.scale': { t: 'enum', values: SCALES },
    'numbers.decimals': { t: 'num', min: 0, max: 6, int: true },
    'numbers.negative': { t: 'enum', values: NEGATIVE }
  };
  const KEYS = Object.keys(SCHEMA);

  function isObj (o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
  function get (o, p) { return p.split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o); }
  function clone (o) { return JSON.parse(JSON.stringify(o)); }

  /** Checks one value against its schema entry: the cleaned value, or undefined when it is not valid. */
  function clean (spec, v) {
    if (spec.t === 'hex') return core.normalizeHex(v) || undefined;
    if (spec.t === 'font') return typeof v === 'string' && v.trim() && v.length <= 80 ? v.trim() : undefined;
    if (spec.t === 'num') {
      if (typeof v !== 'number' || !isFinite(v) || v < spec.min || v > spec.max) return undefined;
      return spec.int ? Math.round(v) : v;
    }
    if (spec.t === 'enum') return spec.values.indexOf(v) >= 0 ? v : undefined;
    if (spec.t === 'hexlist') {
      if (!Array.isArray(v)) return undefined;
      const out = v.map(core.normalizeHex);
      if (out.some(function (c) { return !c; }) || out.length < spec.min || out.length > spec.max) return undefined;
      return out;
    }
    return undefined;
  }

  function put (o, p, v) {
    const parts = p.split('.');
    let t = o;
    parts.slice(0, -1).forEach(function (k) { if (!isObj(t[k])) t[k] = {}; t = t[k]; });
    t[parts[parts.length - 1]] = v;
  }

  /**
   * Checks a theme object. Returns { ok, error, theme, dropped, unknown }:
   *   theme    cleaned copy (colours as #RRGGBB, bad values removed)
   *   dropped  ['colors.text (not a colour)', …]   values that were ignored
   *   unknown  ['colors.foo', …]                   keys this version does not know (warning only)
   */
  function validate (obj) {
    if (!isObj(obj)) return { ok: false, error: 'This is not a theme.' };
    if (obj.type !== TYPE) return { ok: false, error: 'This file is not a Tableau extensions theme.' };
    const ver = obj.version == null ? 1 : obj.version;
    if (typeof ver !== 'number' || ver < 1) return { ok: false, error: 'This theme has no valid version number.' };
    if (ver > CURRENT_VERSION) return { ok: false, error: 'This theme was made with a newer version. Update the extensions, then import it again.' };
    const theme = { type: TYPE, version: CURRENT_VERSION, name: typeof obj.name === 'string' && obj.name.trim() ? obj.name.trim().slice(0, 60) : 'Theme' };
    const dropped = [];
    const unknown = [];
    KEYS.forEach(function (k) {
      const v = get(obj, k);
      if (v === undefined) return;
      const c = clean(SCHEMA[k], v);
      if (c === undefined) dropped.push(k + ' (not a valid value)');
      else put(theme, k, c);
    });
    ['fonts', 'colors', 'card', 'numbers'].forEach(function (g) {
      if (obj[g] === undefined) return;
      if (!isObj(obj[g])) { dropped.push(g + ' (not a group)'); return; }
      Object.keys(obj[g]).forEach(function (k) { if (!SCHEMA[g + '.' + k]) unknown.push(g + '.' + k); });
    });
    return { ok: true, theme: theme, dropped: dropped, unknown: unknown };
  }

  /** Text of a theme file → cleaned theme. Throws Error with a plain-English message. */
  function parse (text) {
    let obj;
    try { obj = JSON.parse(text); } catch (e) { throw new Error('This file is not valid JSON. Choose a theme file you exported.'); }
    if (!isObj(obj) || obj.type !== TYPE) throw new Error('This file is not a Tableau extensions theme.');
    let v = obj.version == null ? 1 : obj.version;
    if (typeof v === 'number' && v > CURRENT_VERSION) throw new Error('This theme was made with a newer version. Update the extensions, then import it again.');
    for (; typeof v === 'number' && v < CURRENT_VERSION; v++) if (MIGRATIONS[v]) obj = MIGRATIONS[v](obj) || obj;
    const r = validate(obj);
    if (!r.ok) throw new Error(r.error);
    return r.theme;
  }

  function entryOf (e) { return typeof e === 'string' ? { path: e } : e; }

  /**
   * Returns a copy of `settings` with the theme's values written to every path its themeMap names
   * for those keys. A path that does not exist in the settings is skipped (except `create`),
   * and so is a value whose type does not fit the existing setting. Pure: nothing is mutated.
   */
  function apply (settings, theme, themeMap) {
    const out = clone(settings);
    if (!isObj(theme) || !isObj(themeMap)) return out;
    KEYS.forEach(function (k) {
      const v = get(theme, k);
      if (v === undefined || !themeMap[k]) return;
      themeMap[k].forEach(function (raw) {
        const e = entryOf(raw);
        let val = 'set' in e ? e.set : v;
        if (e.map) { val = e.map[v]; if (val === undefined) return; }
        if (e.scale && typeof val === 'number') val = val * e.scale;
        const cur = get(out, e.path);
        if (e.create) {
          const parts = e.path.split('.');
          const parent = get(out, parts.slice(0, -1).join('.'));
          if (!isObj(parent)) return;
        } else if (cur === undefined || (cur !== null && cur !== '' && typeof cur !== typeof val)) {
          return;
        }
        put(out, e.path, clone(val));
      });
    });
    return out;
  }

  /** Makes a theme out of a styled chart: reads the first usable mapped path of each theme key. */
  function fromSettings (settings, themeMap, name) {
    const theme = { type: TYPE, version: CURRENT_VERSION, name: name || 'My theme' };
    if (!isObj(themeMap)) return theme;
    KEYS.forEach(function (k) {
      (themeMap[k] || []).some(function (raw) {
        const e = entryOf(raw);
        if ('set' in e) return false;
        let v = get(settings, e.path);
        if (v === undefined) return false;
        if (e.map) {
          const back = Object.keys(e.map).filter(function (t) { return e.map[t] === v; })[0];
          if (back === undefined) return false;
          v = SCHEMA[k].t === 'num' ? Number(back) : back;
        }
        if (e.scale && typeof v === 'number') v = v / e.scale;
        const c = clean(SCHEMA[k], v);
        if (c === undefined) return false;
        put(theme, k, c);
        return true;
      });
    });
    return theme;
  }

  // ---------------------------------------------------------------------------
  // Saved themes (browser storage, shared by every extension because they share one origin)
  // ---------------------------------------------------------------------------
  function store () { try { return root.localStorage || null; } catch (e) { return null; } }

  function readAll () {
    try {
      const s = store();
      const arr = JSON.parse((s && s.getItem(STORE_KEY)) || '[]');
      if (!Array.isArray(arr)) return [];
      return arr.map(function (t) { const r = validate(t); return r.ok ? r.theme : null; }).filter(Boolean);
    } catch (e) { return []; }
  }

  /** Themes saved in this browser, oldest first. */
  function list () { return readAll(); }

  /** Saves (or replaces, by name) a theme. Returns { ok, error }. */
  function save (theme) {
    const r = validate(theme);
    if (!r.ok) return r;
    try {
      const s = store();
      if (!s) return { ok: false, error: 'This browser does not allow saving themes.' };
      const all = readAll().filter(function (t) { return t.name !== r.theme.name; });
      all.push(r.theme);
      s.setItem(STORE_KEY, JSON.stringify(all));
      return { ok: true };
    } catch (e) { return { ok: false, error: 'This browser does not allow saving themes.' }; }
  }

  function remove (name) {
    try {
      const s = store();
      if (!s) return false;
      const all = readAll();
      const rest = all.filter(function (t) { return t.name !== name; });
      s.setItem(STORE_KEY, JSON.stringify(rest));
      return rest.length !== all.length;
    } catch (e) { return false; }
  }

  const api = {
    TYPE: TYPE, CURRENT_VERSION: CURRENT_VERSION, MIGRATIONS: MIGRATIONS, STORE_KEY: STORE_KEY, KEYS: KEYS,
    validate: validate, parse: parse, apply: apply, fromSettings: fromSettings, list: list, save: save, remove: remove
  };

  root.ExtTheme = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
