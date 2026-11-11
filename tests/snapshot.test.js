'use strict';
// shared/snapshot.js: the parts that run without a browser (file names, scale limit, CSS url() helpers).
// The picture itself is checked in a real browser: shared/dev/snapshot-test.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers.js');

const S = h.sandbox(['shared/snapshot.js']).ExtSnapshot;
const U = S._;
const json = function (v) { return JSON.parse(JSON.stringify(v)); };

test('snapshot.js loads without a DOM and exposes the API', function () {
  ['png', 'svg', 'download', 'fileName', 'save'].forEach(function (k) { assert.equal(typeof S[k], 'function', k); });
  assert.equal(typeof U, 'object');
});

test('fileName: title + local date + extension', function () {
  const d = new Date(2026, 10, 10, 13, 5);
  assert.equal(S.fileName('Sales by store', 'png', d), 'Sales by store 2026-11-10.png');
  assert.equal(S.fileName('Sales', '.svg', d), 'Sales 2026-11-10.svg');
  assert.equal(S.fileName('', 'png', d), 'chart 2026-11-10.png');
  assert.equal(S.fileName(null, 'png', new Date(2026, 0, 3)), 'chart 2026-01-03.png');
  assert.match(S.fileName('x'), /^x \d{4}-\d{2}-\d{2}\.png$/);
});

test('fileName: removes characters Windows and macOS reject', function () {
  const n = U.cleanFileName('a/b:c*?"<>|');
  assert.doesNotMatch(n, /[\\/:*?"<>|]/);
  assert.equal(n, 'a b c');
  assert.equal(U.cleanFileName('..hidden.'), 'hidden');
  assert.equal(U.cleanFileName('   '), 'chart');
  assert.equal(U.cleanFileName('...'), 'chart');
  assert.equal(U.cleanFileName('con'), '_con');
  assert.equal(U.cleanFileName('line\nbreak\ttab'), 'line break tab');
});

test('fileName: long titles are cut at about 80 characters, non-ASCII letters are kept', function () {
  const long = U.cleanFileName('x'.repeat(200));
  assert.ok(long.length <= 80 && long.length >= 70, String(long.length));
  assert.equal(U.cleanFileName('Ventes par magasin é ü ñ'), 'Ventes par magasin é ü ñ');
  assert.equal(U.cleanFileName('المبيعات حسب الفرع'), 'المبيعات حسب الفرع');
  assert.equal(U.cleanFileName('销售额 ' + 'a'.repeat(100)).slice(0, 4), '销售额 ');
  const emoji = U.cleanFileName('a'.repeat(79) + '\u{1F600}');
  assert.doesNotMatch(emoji, /[\ud800-\udbff]$/);
});

test('png and svg reject with a clear error when given no element', async function () {
  await assert.rejects(S.png(), /no element/i);
  await assert.rejects(S.png(null, { scale: 2 }), /no element/i);
  await assert.rejects(S.svg(undefined), /no element/i);
  await assert.rejects(S.save(null, { format: 'png' }), /no element/i);
  await assert.rejects(S.save(null, { format: 'svg' }), /no element/i);
});

test('png returns a promise and does not throw synchronously', function () {
  let p;
  assert.doesNotThrow(function () { p = S.png(undefined); });
  assert.equal(typeof p.then, 'function');
  return p.catch(function () {});
});

test('limitScale keeps the picture under maxPixels', function () {
  assert.equal(U.limitScale(400, 240, 2), 2);
  assert.equal(U.limitScale(400, 240, 1.5), 1.5);
  assert.equal(U.limitScale(400, 240, undefined), 2);
  assert.equal(U.limitScale(400, 240, 'x'), 2);
  const s = U.limitScale(4000, 3000, 2, 16e6); // 48e6 px at scale 2
  assert.ok(s < 2 && s > 0);
  assert.ok(4000 * s * 3000 * s <= 16e6);
  assert.ok(4000 * s * 3000 * s > 15e6);
  assert.equal(U.limitScale(2000, 2000, 2, 16e6), 2); // exactly 16e6
  const small = U.limitScale(100, 100, 3, 10000);
  assert.ok(100 * small * 100 * small <= 10000);
  assert.ok(U.limitScale(20000, 10, 2, 16e6) * 20000 <= 16384); // canvas side limit
  assert.equal(U.limitScale(0, 0, 2), 2);
});

test('cssUrls and replaceCssUrls', function () {
  assert.deepEqual(json(U.cssUrls('url("a.png")')), ['a.png']);
  assert.deepEqual(json(U.cssUrls("url('a b.png'), url( c.png ) , none")), ['a b.png', 'c.png']);
  assert.deepEqual(json(U.cssUrls('linear-gradient(red, blue)')), []);
  assert.deepEqual(json(U.cssUrls('url(data:image/png;base64,AAA=)')), ['data:image/png;base64,AAA=']);
  assert.deepEqual(json(U.cssUrls(null)), []);
  assert.equal(U.replaceCssUrls('url(a.png), url("b.png")', function (u) { return u === 'a.png' ? 'data:x' : null; }), 'url("data:x"), url("b.png")');
  assert.equal(U.replaceCssUrls('none', function () { return 'x'; }), 'none');
});

test('localizeFragmentUrls points page-local references back at the fragment', function () {
  const page = 'http://localhost:8766/bar-chart/index.html';
  assert.equal(U.localizeFragmentUrls('url("' + page + '#grad1")', page), 'url("#grad1")');
  assert.equal(U.localizeFragmentUrls('url("' + page + '#g") none', page + '#hash'), 'url("#g") none');
  assert.equal(U.localizeFragmentUrls('url("http://other/x.png#a")', page), 'url("http://other/x.png#a")');
  assert.equal(U.localizeFragmentUrls('#E11D48', page), '#E11D48');
});

test('dataUrl, fontMime, isTransparentColor, stripInvalidXml', function () {
  assert.equal(U.dataUrl('font/woff2', 'AAAA'), 'data:font/woff2;base64,AAAA');
  assert.equal(U.dataUrl('', 'AA'), 'data:application/octet-stream;base64,AA');
  assert.equal(U.fontMime('./fonts/Lato-Regular.woff2?v=3'), 'font/woff2');
  assert.equal(U.fontMime('a.TTF'), 'font/ttf');
  assert.equal(U.fontMime('a.bin'), 'application/octet-stream');
  assert.equal(U.isTransparentColor('rgba(0, 0, 0, 0)'), true);
  assert.equal(U.isTransparentColor('transparent'), true);
  assert.equal(U.isTransparentColor(''), true);
  assert.equal(U.isTransparentColor('rgb(255, 255, 255)'), false);
  assert.equal(U.isTransparentColor('rgba(10, 20, 30, 0.5)'), false);
  assert.equal(U.stripInvalidXml('a\u0000b\u0008c\nd'), 'abc\nd');
});

test('font helpers: family list and rule matching', function () {
  assert.deepEqual(json(U.splitFamilies('"Lato", -apple-system, \'Segoe UI\', sans-serif')), ['lato', '-apple-system', 'segoe ui', 'sans-serif']);
  assert.deepEqual(json(U.splitFamilies('')), []);
  assert.equal(U.fontRuleMatches({ weight: '400', style: 'normal' }, { weight: '400', style: 'normal' }), true);
  assert.equal(U.fontRuleMatches({ weight: '', style: '' }, { weight: '400', style: 'normal' }), true);
  assert.equal(U.fontRuleMatches({ weight: '700', style: 'normal' }, { weight: '400', style: 'normal' }), false);
  assert.equal(U.fontRuleMatches({ weight: 'bold', style: 'normal' }, { weight: '700', style: 'normal' }), true);
  assert.equal(U.fontRuleMatches({ weight: '100 900', style: 'normal' }, { weight: '500', style: 'normal' }), true);
  assert.equal(U.fontRuleMatches({ weight: '400', style: 'italic' }, { weight: '400', style: 'normal' }), false);
  assert.equal(U.fontRuleMatches({ weight: '400', style: 'italic' }, { weight: '400', style: 'oblique 10deg' }), true);
});

test('menuItems: png always, svg only with a vector, with labels', function () {
  const a = S.menuItems({ element: {}, title: 'T' });
  assert.deepEqual(json(a.map(function (i) { return i.id; })), ['png']);
  assert.equal(a[0].label, 'Picture (PNG)');
  assert.equal(typeof a[0].run, 'function');
  const b = S.menuItems({ element: {}, title: 'T', vector: {} });
  assert.deepEqual(json(b.map(function (i) { return i.id; })), ['png', 'svg']);
  assert.equal(b[1].label, 'Vector (SVG)');
  const c = S.menuItems({ vector: function () { return null; } });
  assert.equal(c.length, 2, 'a vector function counts as given');
  assert.equal(S.menuItems().length, 1);
});

test('menuItems: run rejects cleanly with no element, and returns a promise', async function () {
  const items = S.menuItems({ vector: {} });
  for (const i of items) {
    const p = i.run();
    assert.equal(typeof p.then, 'function');
    await assert.rejects(p, /no element/i);
  }
  await assert.rejects(items[0].run(), /no element/i);
  await assert.rejects(items[1].run(), /no element/i);
  await assert.rejects(S.menuItems({ element: function () { return null; } })[0].run(), /no element/i);
});

test('button is exposed', function () { assert.equal(typeof S.button, 'function'); });

test('fileName: arrows become words', function () {
  const win = h.sandbox(['shared/core.js', 'shared/snapshot.js']);
  assert.match(win.ExtSnapshot.fileName('Opening Stock \u2192 Closing Stock', 'png'), /^Opening Stock to Closing Stock \d{4}-\d\d-\d\d\.png$/);
});
