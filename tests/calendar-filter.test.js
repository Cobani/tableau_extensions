'use strict';
// calendar-filter: the date arithmetic in config.js (periods, week numbers, the text in the box,
// what a choice selects, reading a selection back after a reload, quick ranges).
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers.js');

function load () { return h.configApi(h.sandbox(h.configScripts('calendar-filter'))); }
const Cf = load();
const D = Cf.dayOf;
function cfg (patch) {
  const c = JSON.parse(JSON.stringify(Cf.DEFAULTS));
  if (patch) patch(c);
  return c;
}
function plain (o) { return JSON.parse(JSON.stringify(o)); }

test('calendar-filter: periods start where they should (Sunday weeks by default)', function () {
  const n = D(2026, 10, 18); // Wed 18 Nov 2026
  assert.equal(Cf.periodStart('Y', n), D(2026, 0, 1));
  assert.equal(Cf.periodStart('M', n), D(2026, 10, 1));
  assert.equal(Cf.periodStart('W', n, 0), D(2026, 10, 15)); // Sunday
  assert.equal(Cf.periodStart('W', n, 1), D(2026, 10, 16)); // Monday
  assert.equal(Cf.periodStart('W', n, 6), D(2026, 10, 14)); // Saturday
  assert.equal(Cf.periodNext('M', D(2026, 11, 1)), D(2027, 0, 1));
  assert.deepEqual(plain(Cf.periodRange('M', D(2026, 3, 1), D(2026, 1, 1))), [D(2026, 1, 1), D(2026, 2, 1), D(2026, 3, 1)]);
});

test('calendar-filter: week numbers follow Tableau (week 1 holds 1 January)', function () {
  assert.deepEqual(plain(Cf.weekNumber(D(2025, 11, 28), 0)), { n: 1, y: 2026 }); // Sun 28 Dec 2025 – Sat 3 Jan 2026
  assert.deepEqual(plain(Cf.weekNumber(D(2026, 0, 4), 0)), { n: 2, y: 2026 });
  assert.deepEqual(plain(Cf.weekNumber(D(2026, 10, 15), 0)), { n: 47, y: 2026 });
  assert.deepEqual(plain(Cf.weekNumber(D(2025, 11, 21), 0)), { n: 52, y: 2025 });
  assert.equal(Cf.label('W', D(2026, 10, 15), true, 0), 'W47 (15–21 Nov 2026)');
});

test('calendar-filter: the text box joins neighbouring periods into ranges', function () {
  const c = cfg();
  const st = { gran: 'M', sel: [D(2026, 1, 1), D(2026, 2, 1), D(2026, 3, 1), D(2026, 8, 1)], nullState: 'include' };
  assert.equal(Cf.summary(st, c), 'Feb 2026 – Apr 2026, Sep 2026');
  assert.equal(Cf.summary({ gran: 'D', sel: [D(2026, 10, 4), D(2026, 10, 5), D(2026, 10, 6)], nullState: 'include' }, c), '4–6 Nov 2026');
  assert.equal(Cf.summary({ gran: 'D', sel: [], nullState: 'include' }, c), '');
  assert.equal(Cf.summary({ gran: 'D', sel: [], nullState: 'exclude' }, c), 'All dates, no null');
  assert.equal(Cf.summary({ gran: 'D', sel: [], nullState: 'only' }, c), 'Null dates only');
  assert.equal(Cf.summary({ gran: 'Y', sel: [D(2024, 0, 1)], nullState: 'exclude' }, c), '2024, no null');
  const many = { gran: 'D', sel: [D(2026, 0, 1), D(2026, 0, 3), D(2026, 0, 5), D(2026, 0, 7)], nullState: 'include' };
  assert.equal(Cf.summary(many, c, 2), '1 Jan 2026, 3 Jan 2026 +2 more');
  const ex = cfg(function (x) { x.nulls.default = 'exclude'; });
  assert.equal(Cf.summary({ gran: 'Y', sel: [D(2025, 0, 1)], nullState: 'include' }, ex), '2025 + null');
});

test('calendar-filter: a choice selects the days with data in it, plus nulls when included', function () {
  const days = [D(2026, 0, 30), D(2026, 1, 2), D(2026, 1, 27), D(2026, 2, 1)];
  assert.deepEqual(plain(Cf.resolve({ gran: 'M', sel: [D(2026, 1, 1)], nullState: 'include' }, days, true)), { days: [D(2026, 1, 2), D(2026, 1, 27)], nulls: true, all: false });
  assert.deepEqual(plain(Cf.resolve({ gran: 'M', sel: [D(2026, 1, 1)], nullState: 'exclude' }, days, true)).nulls, false);
  assert.equal(Cf.resolve({ gran: 'D', sel: [], nullState: 'include' }, days, true).all, true);
  assert.deepEqual(plain(Cf.resolve({ gran: 'D', sel: [], nullState: 'exclude' }, days, true)).days, days);
  assert.deepEqual(plain(Cf.resolve({ gran: 'D', sel: [D(2026, 0, 1)], nullState: 'only' }, days, true)), { days: [], nulls: true, all: false });
  // several periods, out of order
  assert.deepEqual(plain(Cf.resolve({ gran: 'D', sel: [D(2026, 2, 1), D(2026, 0, 30)], nullState: 'exclude' }, days, false)).days, [D(2026, 0, 30), D(2026, 2, 1)]);
});

test('calendar-filter: a selection read back after a reload gets the coarsest granularity that fits', function () {
  const c = cfg();
  const days = [];
  for (let d = D(2026, 0, 1); d <= D(2026, 2, 31); d++) days.push(d);
  const feb = days.filter(function (d) { return d >= D(2026, 1, 1) && d < D(2026, 2, 1); });
  assert.deepEqual(plain(Cf.inferState(feb, false, days, c)), { gran: 'M', sel: [D(2026, 1, 1)], nullState: 'exclude' });
  const wk = [D(2026, 1, 1), D(2026, 1, 2), D(2026, 1, 3), D(2026, 1, 4), D(2026, 1, 5), D(2026, 1, 6), D(2026, 1, 7)]; // Sun–Sat
  assert.deepEqual(plain(Cf.inferState(wk, true, days, c)), { gran: 'W', sel: [D(2026, 1, 1)], nullState: 'include' });
  assert.deepEqual(plain(Cf.inferState([D(2026, 1, 3)], true, days, c)), { gran: 'D', sel: [D(2026, 1, 3)], nullState: 'include' });
  assert.deepEqual(plain(Cf.inferState([], true, days, c)), { gran: 'D', sel: [], nullState: 'only' });
  assert.deepEqual(plain(Cf.inferState(days, false, days, c)), { gran: 'D', sel: [], nullState: 'exclude' });
  // Month switched off: falls to weeks / days
  const noMonth = cfg(function (x) { x.calendar.showMonth = false; x.calendar.showWeek = false; });
  assert.equal(Cf.inferState(feb, false, days, noMonth).gran, 'D');
});

test('calendar-filter: quick ranges count back from the anchor day', function () {
  const a = D(2026, 10, 23); // Mon 23 Nov 2026
  assert.deepEqual(plain(Cf.quickRange('mtd', a, 0)), { g: 'D', a: D(2026, 10, 1), b: a });
  assert.deepEqual(plain(Cf.quickRange('lastMonth', a, 0)), { g: 'M', a: D(2026, 9, 1), b: D(2026, 9, 1) });
  assert.deepEqual(plain(Cf.quickRange('thisWeek', a, 0)), { g: 'W', a: D(2026, 10, 22), b: D(2026, 10, 22) });
  assert.deepEqual(plain(Cf.quickRange('thisWeek', a, 1)), { g: 'W', a: D(2026, 10, 23), b: D(2026, 10, 23) });
  assert.deepEqual(plain(Cf.quickRange('qtd', a, 0)), { g: 'D', a: D(2026, 9, 1), b: a });
  assert.deepEqual(plain(Cf.quickRange('last12', a, 0)), { g: 'M', a: D(2025, 11, 1), b: D(2026, 10, 1) });
  assert.deepEqual(plain(Cf.quickRange('lastMonth', D(2026, 0, 15), 0)), { g: 'M', a: D(2025, 11, 1), b: D(2025, 11, 1) });
  const noWeek = cfg(function (x) { x.calendar.showWeek = false; });
  assert.equal(Cf.quickList(noWeek).some(function (q) { return q[0] === 'thisWeek'; }), false);
  assert.equal(Cf.quickList(cfg(function (x) { x.quick.position = 'off'; })).length, 0);
});

test('calendar-filter: dates from Tableau cells', function () {
  assert.equal(Cf.cellDay({ value: '2026-11-20' }), D(2026, 10, 20));
  assert.equal(Cf.cellDay({ value: '2026-11-20 14:40:00' }), D(2026, 10, 20));
  assert.equal(Cf.cellDay({ value: '%null%' }), null);
  assert.equal(Cf.cellDay({ value: 2026 }), null);
  assert.equal(Cf.isNullCell({ value: '%null%', formattedValue: 'Null' }), true);
  assert.equal(Cf.isNullCell({ value: '2026-01-01' }), false);
});

test('calendar-filter: the how-to line follows the click behaviour', function () {
  assert.match(Cf.helpText(cfg()), /Shift-click: range/);
  assert.match(Cf.helpText(cfg()), /Drag: range/);
  assert.doesNotMatch(Cf.helpText(cfg(function (x) { x.selection.drag = false; })), /Drag/);
  assert.match(Cf.helpText(cfg(function (x) { x.selection.mode = 'single'; })), /pick one/);
  assert.match(Cf.helpText(cfg(function (x) { x.selection.mode = 'toggle'; })), /add or remove/);
});
