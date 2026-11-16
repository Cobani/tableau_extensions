'use strict';
// bar-chart: "Workbook format" reads Tableau's number format from its formatted values and
// applies it to any number (sums, totals, axis ticks), not only to single-row bars.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers.js');

function api () { return h.configApi(h.sandbox(h.configScripts('bar-chart'))); }

function fmtWith (Bc, samples, values) {
  Bc.setWorkbookPatterns({ m: Bc.workbookPattern(samples) }, 'm');
  const f = Object.assign(Bc.clone(Bc.DEFAULTS.format), { scale: 'workbook', unit: '' });
  return values.map(function (v) { return Bc.formatNumber(v, f); });
}

test('bar-chart: Workbook format follows Tableau\'s pattern for sums and ticks', function () {
  const Bc = api();
  assert.deepEqual(fmtWith(Bc, [[382412.43, '382,412'], [-5300.2, '-5,300']], [1234567.8, -42.4]), ['1,234,568', '-42']);
  assert.deepEqual(fmtWith(Bc, [[382412.431, 'SAR 382,412.43']], [1234567.891]), ['SAR 1,234,567.89']);
  assert.deepEqual(fmtWith(Bc, [[382412431, '382.4M'], [12000000, '12.0M']], [1.5e9, 250000]), ['1,500.0M', '0.3M']);
  assert.deepEqual(fmtWith(Bc, [[0.1234, '12.3%'], [0.5, '50.0%']], [0.98765]), ['98.8%']);
  assert.deepEqual(fmtWith(Bc, [[-1200, '(1,200)'], [3400, '3,400']], [-99999]), ['(99,999)']);
  assert.deepEqual(fmtWith(Bc, [[1234.5, '1.234,50 €'], [12.5, '12,50 €']], [987654.321]), ['987.654,32 €']);
  assert.deepEqual(fmtWith(Bc, [[-1200, '-SAR 1,200.0'], [3400, 'SAR 3,400.0']], [-99999]), ['-SAR 99,999.0']);
});

test('bar-chart: Workbook format without readable samples falls back to Dynamic', function () {
  const Bc = api();
  assert.deepEqual(fmtWith(Bc, [[5, 'n/a']], [1234567]), [Bc.formatNumber(1234567, Object.assign(Bc.clone(Bc.DEFAULTS.format), { scale: 'dynamic', unit: '' }))]);
});
