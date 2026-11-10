'use strict';
// Presets (AGENTS.md → Presets): every extension's configure.js defines the preset format, and every
// bundled preset file in <slug>/presets/ covers every setting of its chart (or lists it in FIELD_PATHS).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');

const MUST_HAVE_PRESET_FILES = ['waterfall', 'kpi-card', 'kpi-card-multi'];

// Known gaps, if any: '<slug>/<file>' or '<slug>' → reason. Keep this empty; fix the preset instead.
const TODO = {};

function todoOpts (key) { return TODO[key] ? { todo: TODO[key] } : {}; }

/** configure.js facts, read from the source text. */
function source (slug) {
  const src = h.read(slug + '/configure.js');
  const type = (/var PRESET_TYPE = '([^']+)'/.exec(src) || [])[1];
  const version = (/var PRESET_VERSION = (\d+)/.exec(src) || [])[1];
  const fp = /var FIELD_PATHS = \[([\s\S]*?)\];/.exec(src);
  const fieldPaths = fp ? (fp[1].replace(/\/\/[^\n]*/g, '').match(/'[^']+'/g) || []).map(function (s) { return s.slice(1, -1); }) : null;
  return {
    src: src,
    type: type,
    version: version === undefined ? undefined : Number(version),
    hasMigrations: /var PRESET_MIGRATIONS = \{/.test(src),
    hasTab: /\{ id: 'presets',[^}]*build: buildPresetsTab/.test(src),
    fieldPaths: fieldPaths
  };
}

const under = function (p, roots) { return roots.some(function (r) { return p === r || p.indexOf(r + '.') === 0; }); };
const isLeaf = function (v) { return !(v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length); };

/** The shared settings of a preset: kpi-card-multi keeps { shared, cards } for scope "all". */
function sharedSettings (slug, pr) {
  return slug === 'kpi-card-multi' && pr.scope === 'all' ? (pr.settings.shared || {}) : pr.settings;
}

h.extensions().forEach(function (slug) {
  const info = source(slug);

  test(slug + ': configure.js defines PRESET_TYPE, PRESET_VERSION, PRESET_MIGRATIONS and a presets tab', todoOpts(slug), function () {
    assert.ok(info.type, 'PRESET_TYPE missing');
    assert.ok(info.version >= 1, 'PRESET_VERSION missing');
    assert.ok(info.hasMigrations, 'PRESET_MIGRATIONS missing');
    assert.ok(info.hasTab, "no { id: 'presets', … build: buildPresetsTab } entry in TABS");
    assert.ok(info.fieldPaths, 'FIELD_PATHS missing');
  });

  const dir = slug + '/presets';
  if (!h.exists(dir)) {
    if (MUST_HAVE_PRESET_FILES.indexOf(slug) >= 0) {
      test(slug + ': has bundled presets', function () { assert.fail(dir + ' is missing: add at least a Default and one other look'); });
    }
    return;
  }
  const files = fs.readdirSync(path.join(h.ROOT, dir)).filter(function (f) { return f.endsWith('.json'); }).sort();
  if (MUST_HAVE_PRESET_FILES.indexOf(slug) >= 0) {
    test(slug + ': has at least two bundled presets', function () { assert.ok(files.length >= 2, dir + ' has ' + files.length + ' file(s)'); });
  }

  files.forEach(function (file) {
    const label = slug + '/presets/' + file;
    const key = slug + '/' + file;
    const win = h.sandbox(h.configScripts(slug));
    const api = h.configApi(win);
    let pr;
    try { pr = JSON.parse(h.read(dir + '/' + file)); } catch (e) { pr = null; }

    test(label + ': valid preset header', todoOpts(key), function () {
      assert.ok(pr && typeof pr === 'object', 'does not parse as JSON');
      assert.equal(pr.type, info.type, 'type must equal PRESET_TYPE of ' + slug + '/configure.js');
      assert.equal(typeof pr.version, 'number', 'version must be a number');
      assert.ok(info.version === undefined || pr.version <= info.version, 'version ' + pr.version + ' is newer than PRESET_VERSION ' + info.version);
      assert.ok(pr.scope === 'look' || pr.scope === 'all', 'scope must be "look" or "all"');
      assert.ok(pr.settings && typeof pr.settings === 'object', 'settings missing');
    });

    test(label + ': covers every setting, no stale settings', todoOpts(key), function () {
      assert.ok(pr && pr.settings, 'no settings to check');
      assert.ok(info.fieldPaths, 'FIELD_PATHS not found in ' + slug + '/configure.js');
      if (info.version !== undefined) {
        assert.equal(pr.version, info.version, label + ': version ' + pr.version + ' is not PRESET_VERSION ' + info.version +
          '. The test cannot run migrations, so bundled presets must be saved at the current version: re-export it');
      }
      const s = sharedSettings(slug, pr);
      const given = {};
      h.leafPaths(s).forEach(function (p) { given[p] = true; });
      const missing = h.leafPaths(api.DEFAULTS).filter(function (p) {
        return !under(p, info.fieldPaths) && !(p in given) && !h.leafPaths(s).some(function (g) { return p.indexOf(g + '.') === 0; });
      });
      assert.deepEqual(missing, [], label + ': missing settings ' + missing.join(', ') +
        ' — add this setting to the preset (or to FIELD_PATHS if it is field-specific) — see AGENTS.md → Presets');
      const stale = h.leafPaths(s).filter(function (p) {
        if (under(p, info.fieldPaths)) return false;
        const parts = p.split('.');
        for (let i = parts.length; i > 0; i--) {
          const v = h.getPath(api.DEFAULTS, parts.slice(0, i).join('.'));
          if (v === undefined) return true;
          if (isLeaf(v)) return false;
        }
        return false;
      });
      assert.deepEqual(stale, [], label + ': stale settings ' + stale.join(', ') +
        ' — DEFAULTS no longer has them: remove them from the preset (or add a migration) — see AGENTS.md → Presets');
    });
  });
});
