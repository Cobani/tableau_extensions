'use strict';
// shared/core.js: every extension depends on these, so each behaviour is pinned here.
const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../shared/core.js');

test('esc escapes HTML and tolerates null', function () {
  assert.equal(core.esc('<a href="x">T&C</a>'), '&lt;a href=&quot;x&quot;&gt;T&amp;C&lt;/a&gt;');
  assert.equal(core.esc(null), '');
  assert.equal(core.esc(0), '0');
});

test('colours', function () {
  assert.equal(core.normalizeHex('abc'), '#AABBCC');
  assert.equal(core.normalizeHex(' #1f2933 '), '#1F2933');
  assert.equal(core.normalizeHex('red'), null);
  assert.equal(core.normalizeHex(12), null);
  assert.deepEqual(core.rgb('#FF8000'), [255, 128, 0]);
  assert.equal(core.rgba('#FF8000', 0.5), 'rgba(255, 128, 0, 0.5)');
  assert.equal(core.rgba('nonsense', 1), 'rgba(0, 0, 0, 1)');
  assert.equal(core.mix('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(core.tint('#000000', 1), '#FFFFFF');
  assert.equal(core.tint('#336699', 0), '#336699');
});

test('fontStack quotes the family and always ends with the fallback', function () {
  assert.equal(core.fontStack(''), core.FONT_STACK_FALLBACK);
  assert.equal(core.fontStack('IBM "Plex" Sans'), '"IBM Plex Sans", ' + core.FONT_STACK_FALLBACK);
});

test('merge: saved settings over defaults', function () {
  const D = { a: 1, s: 'x', on: true, empty: '', nul: null, list: [1, 2], map: {}, sub: { x: 1, y: 'k' } };
  // nothing saved
  assert.deepEqual(core.merge(D, null), D);
  assert.notEqual(core.merge(D, null), D); // a copy
  // matching types are taken, others ignored
  assert.equal(core.merge(D, { a: 5 }).a, 5);
  assert.equal(core.merge(D, { a: '5' }).a, 1);
  assert.equal(core.merge(D, { on: 'yes' }).on, true);
  // '' and null defaults accept anything
  assert.equal(core.merge(D, { empty: 3 }).empty, 3);
  assert.equal(core.merge(D, { nul: 'v' }).nul, 'v');
  // unknown keys (from a newer or older version) are dropped
  assert.equal('zzz' in core.merge(D, { zzz: 1 }), false);
  // lists are replaced only by lists
  assert.deepEqual(core.merge(D, { list: [9] }).list, [9]);
  assert.deepEqual(core.merge(D, { list: { 0: 9 } }).list, [1, 2]);
  // free-form maps ({} in the defaults) take the saved object whole
  assert.deepEqual(core.merge(D, { map: { 'SUM(Sales)': { color: '#fff' } } }).map, { 'SUM(Sales)': { color: '#fff' } });
  assert.deepEqual(core.merge(D, { map: [1] }).map, {});
  // objects merge key by key
  assert.deepEqual(core.merge(D, { sub: { x: 2, extra: 1 } }).sub, { x: 2, y: 'k' });
  assert.deepEqual(core.merge(D, { sub: 'broken' }).sub, { x: 1, y: 'k' });
});

test('number formatting', function () {
  assert.equal(core.formatScaled(1234567, 'dynamic', 2), '1.23M');
  assert.equal(core.formatScaled(999, 'dynamic', 0), '999');
  assert.equal(core.formatScaled(1500, 'dynamic', 1), '1.5K');
  assert.equal(core.formatScaled(2.5e9, 'dynamic', 1), '2.5B');
  assert.equal(core.formatScaled(3e12, 'dynamic', 0), '3T');
  assert.equal(core.formatScaled(-1234567, 'dynamic', 1), '-1.2M');
  assert.equal(core.formatScaled(1234567, 'none', 0), '1,234,567');
  assert.equal(core.formatScaled(1234567, 'none', 0, null, false), '1234567');
  assert.equal(core.formatScaled(1234567, 'K', 0), '1,235K');
  assert.equal(core.formatScaled(1234567, 'dynamic', 1, 'K'), '1,234.6K');
  assert.equal(core.formatScaled(1234567, 'dynamic', 0, ''), '1,234,567');
  assert.equal(core.formatScaled(-0.001, 'none', 2), '0.00'); // never "-0.00"
  assert.equal(core.formatScaled(NaN, 'dynamic', 2), '—');
  assert.equal(core.formatScaled(Infinity, 'dynamic', 2), '—');
  assert.equal(core.fixed(1.005, 99), '1.0050000000'); // decimals are capped at 10
  assert.equal(core.pickScale(5e6, 'B'), 'B');
  assert.equal(core.pickScale(5e6, 'workbook'), '');
});

test('toNumber reads Tableau cells', function () {
  assert.equal(core.toNumber({ value: '12.5' }), 12.5);
  assert.equal(core.toNumber({ value: 'x', nativeValue: 7 }), 7);
  assert.ok(Number.isNaN(core.toNumber({ value: '%null%' })));
  assert.ok(Number.isNaN(core.toNumber({ value: null })));
  assert.ok(Number.isNaN(core.toNumber({ value: '' })));
  assert.ok(Number.isNaN(core.toNumber(null)));
  assert.equal(core.toNumber({ value: 0 }), 0);
});

test('names', function () {
  assert.equal(core.cleanName('SUM(Sales)'), 'Sales');
  assert.equal(core.cleanName('CNTD(Customer Id)'), 'Customer Id');
  assert.equal(core.cleanName('MONTH(Order Date)'), 'Month of Order Date');
  assert.equal(core.cleanName('Sales'), 'Sales');
  assert.equal(core.cleanName('SUM(Sales) // Revenue'), 'SUM(Sales) // Revenue');
  assert.equal(core.cleanName('SUM(Sales) // Revenue', { alias: true }), 'Revenue');
  assert.equal(core.cleanName('SUM(Sales) //', { alias: true }), 'SUM(Sales) //');
  assert.equal(core.cleanName(null), '');
  assert.equal(core.norm('SUM(Sales) '), 'sales');
  assert.deepEqual(core.nameParts('SUM(Sales) // Revenue'), ['revenue', 'sales']);
  assert.equal(core.isMN({ fieldName: 'Measure Names' }), true);
  assert.equal(core.isMN({ fieldName: 'Measure' }), false);
  assert.equal(core.isMN({}), false);
  assert.equal(core.isNumericCol({ dataType: 'float' }), true);
  assert.equal(core.isNumericCol({ dataType: 'string' }), false);
});

test('findColumn: id, exact name, name without aggregation, either half of "a // b"', function () {
  const cols = [
    { fieldId: '[a]', fieldName: 'SUM(Sales)' },
    { fieldId: '[b]', fieldName: 'Profit' },
    { fieldId: '[c]', fieldName: 'Revenue' },
    { fieldId: '[mn]', fieldName: 'Measure Names' }
  ];
  const t = { columns: cols };
  assert.equal(core.findColumn(t, { id: '[b]', name: 'renamed' }, []), cols[1]);
  assert.equal(core.findColumn(t, { name: 'SUM(Sales)' }, []), cols[0]);
  assert.equal(core.findColumn(t, { name: 'AVG(Profit)' }, []), cols[1]);
  assert.equal(core.findColumn(t, { name: 'SUM(x) // Revenue' }, []), cols[2]);
  assert.equal(core.findColumn(t, { name: 'SUM(Sales)' }, [cols[0]]), null); // taken
  assert.equal(core.findColumn(t, { name: 'Measure Names' }, []), null);
  assert.equal(core.findColumn(t, { name: 'Measure Names' }, [], { measureNames: true }), cols[3]);
  assert.equal(core.findColumn(t, { name: 'Nothing' }, []), null);
  assert.equal(core.findColumn(t, null, []), null);
});

// ---- row limit ---------------------------------------------------------------
function fakeWorksheet (n) {
  const calls = [];
  const rows = Array.from({ length: n }, function (_, i) { return [{ value: i }]; });
  const columns = [{ fieldName: 'x', index: 0 }];
  return {
    calls: calls,
    released: 0,
    getSummaryDataAsync: function (o) {
      calls.push(['single', o]);
      return Promise.resolve({ columns: columns, data: o.maxRows ? rows.slice(0, o.maxRows) : rows });
    },
    getSummaryDataReaderAsync: function (size, o) {
      const self = this;
      calls.push(['reader', o]);
      const pageSize = 10000;
      return Promise.resolve({
        pageCount: Math.ceil(n / pageSize),
        totalRowCount: n,
        getAllPagesAsync: function () { return Promise.resolve({ columns: columns, data: rows }); },
        getPageAsync: function (p) { return Promise.resolve({ columns: columns, data: rows.slice(p * pageSize, (p + 1) * pageSize) }); },
        releaseAsync: function () { self.released++; return Promise.resolve(); }
      });
    }
  };
}

test('rowLimit: settings value → whole number, bad values → default 1000', function () {
  assert.equal(core.DEFAULT_MAX_ROWS, 1000);
  assert.equal(core.rowLimit(250.9), 250);
  assert.equal(core.rowLimit('500'), 500);
  assert.equal(core.rowLimit(0), 0);
  assert.equal(core.rowLimit(-5), 1000);
  assert.equal(core.rowLimit(undefined), 1000);
  assert.equal(core.rowLimit('abc'), 1000);
});

test('readSummary: under the limit → everything, one call, selection ignored', async function () {
  const ws = fakeWorksheet(40);
  const t = await core.readSummary(ws, { limit: 100 });
  assert.equal(t.data.length, 40);
  assert.equal(t.truncated, false);
  assert.equal(ws.calls.length, 1);
  assert.equal(ws.calls[0][0], 'single');
  assert.equal(ws.calls[0][1].ignoreSelection, true);
  assert.equal(ws.calls[0][1].maxRows, 101);
});

test('readSummary: over the limit → first N rows, truncated', async function () {
  const ws = fakeWorksheet(2500);
  const t = await core.readSummary(ws, { limit: 1000 });
  assert.equal(t.data.length, 1000);
  assert.equal(t.truncated, true);
  assert.equal(t.limit, 1000);
  assert.equal(t.data[999][0].value, 999);
});

test('readSummary: exactly the limit is not truncated', async function () {
  const t = await core.readSummary(fakeWorksheet(1000), { limit: 1000 });
  assert.equal(t.data.length, 1000);
  assert.equal(t.truncated, false);
});

test('readSummary: limit 0 reads all pages and releases the reader', async function () {
  const ws = fakeWorksheet(25000);
  const t = await core.readSummary(ws, { limit: 0 });
  assert.equal(t.data.length, 25000);
  assert.equal(t.truncated, false);
  assert.equal(ws.released, 1);
});

test('readSummary: large limits page through the reader and stop early', async function () {
  const ws = fakeWorksheet(45000);
  const t = await core.readSummary(ws, { limit: 15000 });
  assert.equal(t.data.length, 15000);
  assert.equal(t.truncated, true);
  assert.equal(ws.released, 1);
  const all = await core.readSummary(fakeWorksheet(12000), { limit: 20000 });
  assert.equal(all.data.length, 12000);
  assert.equal(all.truncated, false);
});

test('readSummary: passes columnsToIncludeById through and releases on errors', async function () {
  const ws = fakeWorksheet(5);
  await core.readSummary(ws, { limit: 10, columnsToIncludeById: ['[a]'] });
  assert.deepEqual(ws.calls[0][1].columnsToIncludeById, ['[a]']);
  const bad = fakeWorksheet(5);
  const orig = bad.getSummaryDataReaderAsync;
  bad.getSummaryDataReaderAsync = function (s, o) {
    return orig.call(bad, s, o).then(function (r) { r.getAllPagesAsync = function () { return Promise.reject(new Error('boom')); }; return r; });
  };
  await assert.rejects(core.readSummary(bad, { limit: 0 }), /boom/);
  assert.equal(bad.released, 1);
});

// ---- selection ---------------------------------------------------------------
test('select: sends valid selections, never throws', function () {
  const sent = [];
  const ws = { selectMarksByValueAsync: function (sel, type) { sent.push([sel, type]); return Promise.resolve(); } };
  assert.equal(core.select(ws, [{ fieldName: 'Region', value: ['East'] }, null, { fieldName: '', value: ['x'] }]), true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0][0].length, 1);
  assert.equal(sent[0][1], 'select-replace');
  assert.equal(core.select(ws, []), false);
  assert.equal(core.select({}, [{ fieldName: 'a', value: [1] }]), false);
  assert.equal(core.select(null, [{ fieldName: 'a', value: [1] }]), false);
  assert.equal(core.select({ selectMarksByValueAsync: function () { throw new Error('x'); } }, [{ fieldName: 'a', value: [1] }]), false);
  core.clearSelection(null);
  core.clearSelection({});
});

test('hoverTooltip: tuple ids are 1-based, 0 hides, false when unsupported', function () {
  const got = [];
  const ws = { hoverTupleAsync: function (id, ctx) { got.push([id, ctx]); return Promise.resolve(); } };
  assert.equal(core.hoverTooltip(ws, 4, { x: 10.4, y: 20.6 }), true);
  assert.deepEqual(got[0], [5, { tooltipAnchorPoint: { x: 10, y: 21 } }]);
  core.hoverTooltip(ws, null);
  assert.deepEqual(got[1], [0, null]);
  assert.equal(core.hoverTooltip({}, 1, { x: 1, y: 1 }), false);
});
