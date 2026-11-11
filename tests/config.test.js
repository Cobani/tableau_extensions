'use strict';
// Every extension's config.js: defaults, reading saved settings, and the rules that keep old
// workbooks loading (AGENTS.md → "Settings").
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers.js');

h.extensions().forEach(function (slug) {
  test(slug + ': config.js loads and publishes DEFAULTS, read, write, STORAGE_KEY', function () {
    const api = h.configApi(h.sandbox(h.configScripts(slug)));
    assert.ok(api, 'no config global with DEFAULTS / read / STORAGE_KEY');
    assert.equal(typeof api.write, 'function');
    assert.match(api.STORAGE_KEY, /^[A-Za-z][A-Za-z0-9]*$/);
  });

  test(slug + ': nothing saved → read() gives the defaults', function () {
    const win = h.sandbox(h.configScripts(slug));
    const api = h.configApi(win);
    const cfg = api.read();
    const shared = cfg.shared || cfg; // kpi-card-multi keeps { shared, cards }
    h.leafPaths(api.DEFAULTS).forEach(function (p) {
      assert.deepEqual(JSON.parse(JSON.stringify(h.getPath(shared, p) === undefined ? null : h.getPath(shared, p))),
        JSON.parse(JSON.stringify(h.getPath(api.DEFAULTS, p) === undefined ? null : h.getPath(api.DEFAULTS, p))), 'default lost: ' + p);
    });
  });

  test(slug + ': broken or foreign saved settings never throw', function () {
    ['not json', '[]', '42', 'null', '{"card":"oops","nope":{"a":1}}', '{"shared":"x","cards":7}'].forEach(function (saved) {
      const api = h.configApi(h.sandbox(h.configScripts(slug), saved));
      const cfg = api.read();
      const shared = cfg.shared || cfg;
      assert.equal(typeof shared.card, 'object', 'card section lost for ' + saved);
      assert.equal('nope' in shared, false);
    });
  });

  test(slug + ': the row limit defaults to 1000 and a saved value is kept', function () {
    const api = h.configApi(h.sandbox(h.configScripts(slug)));
    assert.equal(api.DEFAULTS.data.maxRows, 1000);
    const saved = slug === 'kpi-card-multi' ? '{"shared":{"data":{"maxRows":0}},"cards":{}}' : '{"data":{"maxRows":0}}';
    const cfg = h.configApi(h.sandbox(h.configScripts(slug), saved)).read();
    assert.equal((cfg.shared || cfg).data.maxRows, 0);
  });

  test(slug + ': write() then read() round-trips', async function () {
    const win = h.sandbox(h.configScripts(slug));
    const api = h.configApi(win);
    const cfg = api.read();
    await api.write(cfg);
    assert.equal(typeof win.__store[api.STORAGE_KEY], 'string');
    assert.deepEqual(JSON.parse(JSON.stringify(api.read())), JSON.parse(JSON.stringify(cfg)));
  });

  test(slug + ': DEFAULTS never use undefined or functions (they must survive JSON)', function () {
    const api = h.configApi(h.sandbox(h.configScripts(slug)));
    assert.deepEqual(JSON.parse(JSON.stringify(api.DEFAULTS)), JSON.parse(JSON.stringify(api.DEFAULTS, function (k, v) { return v === undefined || typeof v === 'function' ? '__bad__' : v; })));
  });
});

// The settings key is what ties a workbook to its saved formatting: it must never change.
const KEYS = { 'kpi-card': 'kpiCard', waterfall: 'waterfall1', 'line-chart': 'linechart1', 'bar-chart': 'barChart1', 'matrix-table': 'matrixTable1', 'data-lineage': 'dataLineage1', 'kpi-card-multi': 'kpiCardMulti1', 'sankey': 'sankey1', 'funnel': 'funnel1', 'bullet-gauge': 'bulletGauge1' };
Object.keys(KEYS).forEach(function (slug) {
  test(slug + ': settings key is still "' + KEYS[slug] + '"', function () {
    assert.equal(h.configApi(h.sandbox(h.configScripts(slug))).STORAGE_KEY, KEYS[slug]);
  });
});

test('every extension formats numbers the same way (shared formatter)', function () {
  h.extensions().forEach(function (slug) {
    const api = h.configApi(h.sandbox(h.configScripts(slug)));
    if (typeof api.formatScaled !== 'function') return;
    assert.equal(api.formatScaled(1234567, 'dynamic', 2), '1.23M', slug);
    assert.equal(api.formatScaled(3e12, 'dynamic', 0), '3T', slug);
    assert.equal(api.formatScaled(-0.0001, 'none', 1), '0.0', slug);
  });
});
