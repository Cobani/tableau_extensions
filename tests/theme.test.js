'use strict';
// shared/theme.js and every extension's THEME_MAP: a theme can be applied to any extension without
// changing what it must not change (AGENTS.md → existing workbooks come first).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers.js');
const core = require('../shared/core.js');
const theme = require('../shared/theme.js');

const DEFAULT = JSON.parse(h.read('shared/themes/Default.json'));
const MIDNIGHT = JSON.parse(h.read('shared/themes/Midnight.json'));

// Objects made inside the config sandbox belong to another realm: compare plain copies.
function plain (o) { return JSON.parse(JSON.stringify(o)); }
function entry (e) { return typeof e === 'string' ? { path: e } : e; }
function load (slug) {
  const api = h.configApi(h.sandbox(h.configScripts(slug)));
  return { api: api, D: plain(api.DEFAULTS), map: plain(api.THEME_MAP) };
}
/** Is any part of `path` (before its last part) a free-form map ({} in the defaults)? */
function insideMap (D, path) {
  const parts = path.split('.');
  for (let i = 1; i < parts.length; i++) if (core.isMap(h.getPath(D, parts.slice(0, i).join('.')))) return true;
  return false;
}

test('the bundled themes are valid and use only documented keys', function () {
  [DEFAULT, MIDNIGHT].forEach(function (t) {
    const r = theme.validate(t);
    assert.equal(r.ok, true, t.name);
    assert.deepEqual(r.dropped, [], t.name);
    assert.deepEqual(r.unknown, [], t.name);
    assert.deepEqual(r.theme, Object.assign({}, t), t.name + ' is already in normal form');
  });
  assert.equal(MIDNIGHT.colors.backgroundOpacity, 100);
});

h.extensions().forEach(function (slug) {
  test(slug + ': THEME_MAP paths exist in DEFAULTS, outside free-form maps; keys are documented', function () {
    const c = load(slug);
    assert.ok(c.map && Object.keys(c.map).length >= 6, 'no THEME_MAP');
    Object.keys(c.map).forEach(function (k) {
      assert.ok(theme.KEYS.indexOf(k) >= 0, 'undocumented theme key ' + k);
      assert.ok(Array.isArray(c.map[k]) && c.map[k].length, k + ' has no paths');
      c.map[k].forEach(function (raw) {
        const e = entry(raw);
        if (e.create) {
          assert.equal(typeof h.getPath(c.D, e.path.split('.').slice(0, -1).join('.')), 'object', 'parent of ' + e.path);
          return;
        }
        assert.notEqual(h.getPath(c.D, e.path), undefined, e.path + ' is not in DEFAULTS');
        assert.equal(insideMap(c.D, e.path), false, e.path + ' is inside a free-form map');
      });
    });
  });

  test(slug + ': applying Default.json to a fresh config changes nothing', function () {
    const c = load(slug);
    assert.deepEqual(theme.apply(c.D, DEFAULT, c.map), c.D);
  });

  test(slug + ': Midnight changes at least 5 settings and the result still merges unchanged', function () {
    const c = load(slug);
    const out = theme.apply(c.D, MIDNIGHT, c.map);
    const changed = h.leafPaths(out).filter(function (p) { return JSON.stringify(h.getPath(out, p)) !== JSON.stringify(h.getPath(c.D, p)); });
    assert.ok(changed.length >= 5, 'only ' + changed.length + ' changed');
    // merge() drops any value of the wrong type, so equality proves every value has a valid type
    assert.deepEqual(core.merge(c.D, out), out);
    assert.equal(h.getPath(out, 'card.bgOpacity'), 100);
  });

  test(slug + ': fromSettings reads back what Midnight set', function () {
    const c = load(slug);
    const back = theme.fromSettings(theme.apply(c.D, MIDNIGHT, c.map), c.map, 'Back');
    Object.keys(c.map).forEach(function (k) {
      const want = k.split('.').reduce(function (a, p) { return a == null ? undefined : a[p]; }, MIDNIGHT);
      const got = k.split('.').reduce(function (a, p) { return a == null ? undefined : a[p]; }, back);
      if (want !== undefined) assert.deepEqual(got, want, k);
    });
    assert.equal(theme.validate(back).ok, true);
  });
});

test('validate: type, version, normalised colours, dropped values, unknown keys', function () {
  assert.equal(theme.validate(null).ok, false);
  assert.equal(theme.validate({ type: 'preset' }).ok, false);
  assert.match(theme.validate({ type: theme.TYPE, version: 99 }).error, /newer/);
  assert.equal(theme.validate({ type: theme.TYPE, version: 0 }).ok, false);
  const r = theme.validate({
    type: theme.TYPE, name: ' X ',
    colors: { text: 'abc', muted: 'red', backgroundOpacity: 150, series: ['#fff', 'nope'], foo: 1 },
    fonts: { titleSize: '16', family: ' Inter ' }, numbers: { scale: 'huge', decimals: 2.4 }, extra: {}
  });
  assert.equal(r.ok, true);
  assert.equal(r.theme.name, 'X');
  assert.equal(r.theme.colors.text, '#AABBCC');
  assert.equal(r.theme.fonts.family, 'Inter');
  assert.equal(r.theme.numbers.decimals, 2);
  assert.equal('muted' in r.theme.colors, false);
  assert.equal('series' in r.theme.colors, false);
  assert.equal('titleSize' in r.theme.fonts, false);
  assert.equal('scale' in r.theme.numbers, false);
  assert.equal(r.dropped.length, 5);
  assert.deepEqual(r.unknown, ['colors.foo']);
  assert.equal(theme.validate({ type: theme.TYPE }).theme.name, 'Theme'); // a theme may name nothing
});

test('parse: plain-English errors', function () {
  assert.throws(function () { theme.parse('nope'); }, /not valid JSON/);
  assert.throws(function () { theme.parse('{"type":"x"}'); }, /not a Tableau extensions theme/);
  assert.throws(function () { theme.parse('[1]'); }, /not a Tableau extensions theme/);
  assert.throws(function () { theme.parse('{"type":"tableau-extensions-theme","version":2}'); }, /newer/);
  assert.equal(theme.parse(JSON.stringify(MIDNIGHT)).colors.background, '#101826');
});

test('apply: pure, skips missing paths and wrong types, converts values', function () {
  const S = { a: { c: '#000000', n: 5, neg: 'minus', o: 0 }, pal: 'x', edits: {} };
  const copy = JSON.parse(JSON.stringify(S));
  const map = {
    'colors.text': ['a.c', 'a.missing', 'a.n', 'nope.deep'],
    'numbers.negative': [{ path: 'a.neg', map: { paren: 'parens' } }],
    'colors.backgroundOpacity': [{ path: 'a.o', scale: 0.01 }],
    'colors.series': [{ path: 'edits.house', create: true }, { path: 'pal', set: 'house' }, { path: 'gone.house', create: true }]
  };
  const t = { colors: { text: '#111111', backgroundOpacity: 50, series: ['#111111'] }, numbers: { negative: 'paren' } };
  const out = theme.apply(S, t, map);
  assert.deepEqual(S, copy);
  assert.equal(out.a.c, '#111111');
  assert.equal(out.a.n, 5); // a number is not overwritten with a colour
  assert.equal('missing' in out.a, false);
  assert.equal('nope' in out, false);
  assert.equal(out.a.neg, 'parens');
  assert.equal(out.a.o, 0.5);
  assert.deepEqual(out.edits.house, ['#111111']);
  assert.equal(out.pal, 'house');
  assert.equal('gone' in out, false);
  assert.deepEqual(theme.apply(S, t, null), S);
  assert.deepEqual(theme.apply(S, {}, map), S);
  // a value the conversion does not know is skipped
  assert.equal(theme.apply(S, { numbers: { negative: 'minus' } }, map).a.neg, 'minus'); // no 'minus' in the conversion: unchanged
});

test('fromSettings reverses map and scale and skips constants', function () {
  const S = { a: { c: '#abcdef', neg: 'parens', o: 0.5 }, edits: { house: ['#123456'] }, pal: 'house' };
  const map = {
    'colors.text': ['a.gone', 'a.c'],
    'numbers.negative': [{ path: 'a.neg', map: { paren: 'parens' } }],
    'colors.backgroundOpacity': [{ path: 'a.o', scale: 0.01 }],
    'colors.series': [{ path: 'pal', set: 'house' }, { path: 'edits.house', create: true }]
  };
  const t = theme.fromSettings(S, map, 'Mine');
  assert.equal(t.name, 'Mine');
  assert.equal(t.colors.text, '#ABCDEF');
  assert.equal(t.numbers.negative, 'paren');
  assert.equal(t.colors.backgroundOpacity, 50);
  assert.deepEqual(t.colors.series, ['#123456']);
  assert.equal(theme.fromSettings(S, null).type, theme.TYPE);
});

test('save / list / remove use one shared storage key and survive a broken store', function () {
  const vm = require('node:vm');
  const mem = {};
  const win = { localStorage: { getItem: function (k) { return k in mem ? mem[k] : null; }, setItem: function (k, v) { mem[k] = v; }, removeItem: function (k) { delete mem[k]; } } };
  const ctx = vm.createContext(Object.assign({}, win, { ExtCore: core }));
  ctx.window = ctx;
  vm.runInContext(h.read('shared/theme.js'), ctx);
  const T = ctx.ExtTheme;
  assert.equal(T.STORE_KEY, 'tableau-extensions:themes:v1');
  assert.deepEqual(plain(T.list()), []);
  assert.equal(T.save(MIDNIGHT).ok, true);
  assert.equal(T.save(Object.assign({}, MIDNIGHT, { colors: { text: '#fff' } })).ok, true); // same name replaces
  assert.equal(T.list().length, 1);
  assert.equal(T.list()[0].colors.text, '#FFFFFF');
  assert.equal(T.save({ type: 'x' }).ok, false);
  assert.equal(T.remove('nope'), false);
  assert.equal(T.remove('Midnight'), true);
  assert.deepEqual(plain(T.list()), []);
  mem[T.STORE_KEY] = '{broken';
  assert.deepEqual(plain(T.list()), []);
  const none = vm.createContext({ ExtCore: core });
  none.window = none;
  vm.runInContext(h.read('shared/theme.js'), none);
  assert.equal(none.ExtTheme.save(MIDNIGHT).ok, false); // no storage: reported, not thrown
  assert.deepEqual(plain(none.ExtTheme.list()), []);
});

// ---------------------------------------------------------------------------
// ExtTheme.section: the Format dialog's "Brand theme" block
// ---------------------------------------------------------------------------
/** Just enough DOM for section(): elements with children, attributes, events. */
function fakeEl (tag) {
  const listeners = {};
  const attrs = {};
  const n = {
    tagName: String(tag).toUpperCase(), children: [], style: {}, hidden: false, className: '', textContent: '', value: '',
    appendChild: function (c) { if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1); c.parent = n; n.children.push(c); return c; },
    replaceChild: function (next, old) { const i = n.children.indexOf(old); n.children.splice(i, 1, next); next.parent = n; old.parent = null; return old; },
    setAttribute: function (k, v) { attrs[k] = String(v); },
    getAttribute: function (k) { return k in attrs ? attrs[k] : null; },
    addEventListener: function (t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
    click: function () { (listeners.click || []).forEach(function (fn) { fn({ type: 'click', target: n }); }); },
    focus: function () {}, select: function () {}
  };
  return n;
}
function fh (tag, props, children) {
  const n = fakeEl(tag);
  Object.keys(props || {}).forEach(function (k) { if (k === 'role') n.setAttribute('role', props[k]); else n[k] = props[k]; });
  (children || []).forEach(function (c) { n.appendChild(c); });
  return n;
}
function all (node, fn, out) {
  out = out || [];
  node.children.forEach(function (c) { if (fn(c)) out.push(c); all(c, fn, out); });
  return out;
}
function text (node) { return [node.textContent].concat(node.children.map(text)).join(' '); }
function btn (node, label) {
  const b = all(node, function (c) { return c.tagName === 'BUTTON' && c.textContent === label; });
  assert.ok(b.length >= 1, 'no button ' + label);
  return b[0];
}
function msgOf (node) { return all(node, function (c) { return /ext-theme-msg/.test(c.className); })[0]; }

/** theme.js in a sandbox with an in-memory localStorage; bar-chart's real THEME_MAP and DEFAULTS. */
function setupSection (themeMapOverride) {
  const vm = require('node:vm');
  const mem = {};
  const ctx = vm.createContext({
    ExtCore: core, console: console, setTimeout: setTimeout, JSON: JSON,
    localStorage: { getItem: function (k) { return k in mem ? mem[k] : null; }, setItem: function (k, v) { mem[k] = String(v); }, removeItem: function (k) { delete mem[k]; } }
  });
  ctx.window = ctx;
  vm.runInContext(h.read('shared/theme.js'), ctx);
  const bar = load('bar-chart');
  let cfg = bar.D;
  const calls = [];
  const el = ctx.ExtTheme.section({
    h: fh, name: 'Bar Chart',
    themeMap: themeMapOverride === undefined ? bar.map : themeMapOverride,
    getSettings: function () { return cfg; },
    applySettings: function (next) { calls.push(next); cfg = next; }
  });
  return { T: ctx.ExtTheme, el: el, bar: bar, calls: calls };
}

test('section returns an element with the title and the intro text', function () {
  const s = setupSection();
  assert.equal(s.el.tagName, 'DIV');
  assert.match(text(s.el), /Brand theme/);
  assert.match(text(s.el), /works in every extension/);
  assert.match(text(s.el), /No saved themes yet\./);
});

test('clicking Midnight applies it once and reports the number of changed settings', function () {
  const s = setupSection();
  btn(s.el, 'Midnight').click();
  assert.equal(s.calls.length, 1);
  assert.equal(plain(s.calls[0]).card.bgColor.toUpperCase(), MIDNIGHT.colors.background);
  assert.match(msgOf(s.el).textContent, /^Applied “Midnight”\. \d+ settings changed\.$/);
  assert.equal(msgOf(s.el).hidden, false);
});

test('applying Default on defaults reports no change and does not throw', function () {
  const s = setupSection();
  btn(s.el, 'Default').click();
  assert.match(msgOf(s.el).textContent, /This chart already matches the theme\./);
  assert.equal(msgOf(s.el).className.indexOf('is-error'), -1);
});

test('pasted invalid JSON shows an error and applies nothing', function () {
  const s = setupSection();
  all(s.el, function (c) { return c.tagName === 'TEXTAREA'; })[0].value = '{nope';
  btn(s.el, 'Apply pasted').click();
  assert.equal(s.calls.length, 0);
  assert.match(msgOf(s.el).className, /is-error/);
  assert.match(msgOf(s.el).textContent, /not valid JSON/);
});

test('pasted valid theme is applied; ignored values are counted', function () {
  const s = setupSection();
  const t = JSON.stringify(Object.assign({}, MIDNIGHT, { name: 'Pasted', fonts: { titleSize: 9999 } }));
  all(s.el, function (c) { return c.tagName === 'TEXTAREA'; })[0].value = t;
  btn(s.el, 'Apply pasted').click();
  assert.equal(s.calls.length, 1);
  assert.match(msgOf(s.el).textContent, /Applied “Pasted”\..*1 value was ignored\./);
});

test('Save to My themes stores a theme that list() returns, shows it, and Delete removes it', function () {
  const s = setupSection();
  btn(s.el, 'Save to My themes').click();
  const saved = plain(s.T.list());
  assert.equal(saved.length, 1);
  assert.equal(saved[0].name, 'Bar Chart theme');
  assert.match(text(s.el), /Bar Chart theme/);
  assert.doesNotMatch(text(s.el), /No saved themes yet/);
  btn(s.el, 'Delete').click();
  assert.deepEqual(plain(s.T.list()), []);
  assert.match(text(s.el), /No saved themes yet/);
});

test('a throwing applySettings ends as a message, not an exception', function () {
  const s = setupSection();
  const el = s.T.section({ h: fh, name: 'X', themeMap: s.bar.map, getSettings: function () { return s.bar.D; }, applySettings: function () { throw new Error('boom'); } });
  const log = console.error;
  console.error = function () {};
  try { btn(el, 'Midnight').click(); } finally { console.error = log; }
  assert.match(msgOf(el).textContent, /boom/);
});

test('the embedded bundled themes equal the JSON files', function () {
  const T = setupSection().T;
  assert.deepEqual(plain(T.BUNDLED.Default), DEFAULT);
  assert.deepEqual(plain(T.BUNDLED.Midnight), MIDNIGHT);
});

test('a missing or empty themeMap gives the "not available" block', function () {
  [undefined, null, {}].forEach(function (m) {
    const s = setupSection(m === undefined ? null : m);
    assert.match(text(s.el), /Themes are not available for this extension yet\./);
    assert.equal(all(s.el, function (c) { return c.tagName === 'BUTTON'; }).length, 0);
  });
});
