'use strict';
// shared/text.js: fields and parameters in titles and explanation texts.
const test = require('node:test');
const assert = require('node:assert/strict');
const T = require('../shared/text.js');

// Summary data arrives last-to-first: the rows below are shown in Tableau as North, South, East, West.
function table () {
  const col = function (fieldName, dataType, index) { return { fieldName: fieldName, dataType: dataType, index: index }; };
  const row = function (region, month, sales, margin, low) {
    return [
      { value: region, formattedValue: region },
      { value: month, formattedValue: month },
      { value: sales, nativeValue: sales, formattedValue: String(sales) },
      { value: margin, nativeValue: margin, formattedValue: String(margin) },
      { value: low, nativeValue: low, formattedValue: String(low) }
    ];
  };
  return {
    columns: [col('Region', 'string', 0), col('MONTH(Order Date)', 'int', 1), col('SUM(Sales)', 'float', 2), col('AVG(Margin)', 'float', 3), col('MIN(Low)', 'int', 4)],
    data: [row('West', 'May', 400000, 0.4, 7), row('East', 'May', 300000, 0.3, 5), row('South', 'April', 200000, 0.2, 9), row('North', 'April', 100000, 0.1, 3)]
  };
}

function fill (text, extra) {
  return T.fillWith(text, Object.assign({ model: T.buildModel(table()), params: T.lookupIn([{ name: 'Year', value: '2026' }]) }, extra || {}));
}

test('measures: total by default, the pill aggregation for AVG / MIN / MAX', function () {
  assert.equal(fill('{Sales}'), '1.0M');
  assert.equal(fill('{SUM(Sales)}'), '1.0M');
  assert.equal(fill('{sales|full}'), '1,000,000');
  assert.equal(fill('{Margin|%}'), '25.0%');
  assert.equal(fill('{Low}'), '3');
});

test('measure statistics, in the order shown in Tableau', function () {
  assert.equal(fill('{Sales.avg|K|0}'), '250K');
  assert.equal(fill('{Sales.max|full}'), '400,000');
  assert.equal(fill('{Sales.first|K}'), '100.0K');
  assert.equal(fill('{Sales.last|K}'), '400.0K');
  assert.equal(fill('{Sales.count}'), '4');
  assert.equal(fill('{Sales.name}'), 'Sales');
  assert.equal(fill('{Margin.max|%|0}'), '40%');
  assert.equal(fill('{Sales|M|2|+}'), '+1.00M');
});

test('dimensions: one value, a short list, the count, first and last', function () {
  assert.equal(fill('{Region}'), 'North, South, East and 1 more');
  assert.equal(fill('{Month of Order Date}'), 'April and May');
  assert.equal(fill('{Region.list}'), 'North, South, East, West');
  assert.equal(fill('{Region.count}'), '4');
  assert.equal(fill('{Region.first} to {Region.last}'), 'North to West');
  const one = table(); one.data = one.data.slice(0, 1);
  assert.equal(T.fillWith('{Region}', { model: T.buildModel(one) }), 'West');
});

test('parameters, and anything unknown stays as typed', function () {
  assert.equal(fill('Sales <Year>: {Sales}'), 'Sales 2026: 1.0M');
  assert.equal(fill('<[Parameters].[Year]>'), '2026');
  assert.equal(fill('{Sals} <Yeer> {Region.median} {Region.sum}'), '{Sals} <Yeer> {Region.median} {Region.sum}');
  assert.deepEqual(T.unknownWith('{Sals} {Sales} <Yeer> <Year>', { model: T.buildModel(table()), params: T.lookupIn([{ name: 'Year', value: '1' }]) }), ['{Sals}', '<Yeer>']);
  assert.equal(fill('No tokens: a < b > c'), 'No tokens: a < b > c');
});

test('chart tokens are tried first', function () {
  assert.equal(fill('{total} · {Sales}', { tokens: { total: 'T', sales: function () { return 'mine'; } } }), 'T · mine');
});

test('no data: empty values, a dash for numbers', function () {
  const m = T.buildModel({ columns: table().columns, data: [] });
  assert.equal(T.fillWith('[{Region}] [{Sales}]', { model: m }), '[] [—]');
  assert.equal(T.fillWith('{Sales}', { model: T.buildModel(null) }), '{Sales}');
});

test('chart → dialog: the payload carries fields and parameters, NaN survives', async function () {
  T.setTable(table());
  T.setParams([{ name: 'Year', value: '2026' }]);
  await T.ready();
  const payload = T.addInfo(JSON.stringify({ focus: 'text' }));
  assert.equal(JSON.parse(payload).focus, 'text');
  T.readPayload(payload);
  assert.equal(T.preview('{Region.count} regions in <Year>, {Sales}'), '4 regions in 2026, 1.0M');
  assert.deepEqual(T.unknown('{Nope} {Sales}'), ['{Nope}']);
  T.setTable({ columns: table().columns, data: [] });
  T.readPayload(T.addInfo('{}'));
  assert.equal(T.preview('{Sales}'), '—');
});

test('parameters are asked for only when a text needs them, then the header repaints', async function () {
  let calls = 0; let repaints = 0;
  T._state.params = null;
  T.init({ worksheet: { getParametersAsync: function () { calls++; return Promise.resolve([{ name: 'Year', currentValue: { value: 2026, formattedValue: '2026' } }]); } }, onChange: function () { repaints++; } });
  T.setTable(table());
  assert.equal(T.fill('{Sales}'), '1.0M');
  assert.equal(calls, 0);
  assert.equal(T.fill('<Year>'), '<Year>');
  await T._state.loading;
  assert.equal(calls, 1);
  assert.equal(repaints, 1);
  assert.equal(T.fill('<Year>'), '2026');
  assert.equal(calls, 1);
});

test('first / last follow the first date on the worksheet, earliest first', function () {
  const d = function (iso, v) { return [{ value: iso, nativeValue: iso, formattedValue: iso.slice(0, 7) }, { value: v, nativeValue: v }]; };
  const t = { columns: [{ fieldName: 'MONTH(Order Date)', dataType: 'date', index: 0 }, { fieldName: 'SUM(Sales)', dataType: 'float', index: 1 }],
    data: [d('2026-02-01', 20), d('2026-03-01', 30), d('2026-01-01', 10)] };
  const m = T.buildModel(t);
  assert.equal(T.fillWith('{Month of Order Date.first}–{Month of Order Date.last}: {Sales.first} → {Sales.last}', { model: m }), '2026-01–2026-03: 10 → 30');
  assert.equal(T.fillWith('{Month of Order Date}', { model: m }), '2026-01, 2026-02 and 2026-03');
});
