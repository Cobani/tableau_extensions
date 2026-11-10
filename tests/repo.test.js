'use strict';
// Repo-wide rules from AGENTS.md that are easy to forget: file set, manifests, versions,
// cache-busting, changelogs, no localhost manifests, no browser cache of chart data.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const h = require('./helpers.js');

const TOP = path.resolve(h.ROOT, '..'); // tableau-extensions/ on Forum's Mac (absent in CI)

h.extensions().forEach(function (slug) {
  const t = h.trex(slug);

  test(slug + ': has the standard files', function () {
    ['index.html', 'configure.html', 'configure.js', 'configure.css', 'config.js', 'README.md', 'CHANGELOG.md', 'dev/preview.html', 'dev/mock.js'].forEach(function (f) {
      assert.ok(h.exists(slug + '/' + f), 'missing ' + slug + '/' + f);
    });
  });

  test(slug + ': manifest id, hosted URL, Format menu item', function () {
    assert.equal(t.id, 'com.ilyascoban.vizext.' + slug.replace(/-/g, ''));
    assert.match(t.text, new RegExp('<url>https://cobani\\.github\\.io/tableau_extensions/' + slug + '/</url>'));
    assert.match(t.text, /<configure-context-menu-item\s*\/>/);
    assert.doesNotMatch(t.text, /localhost|127\.0\.0\.1/);
    assert.match(t.version, /^\d+\.\d+\.\d+$/);
  });

  test(slug + ': CHANGELOG.md starts with the .trex version', function () {
    const first = /^## (\d+\.\d+\.\d+)/m.exec(h.read(slug + '/CHANGELOG.md'));
    assert.ok(first, 'no "## x.y.z" heading');
    assert.equal(first[1], t.version, 'add a "## ' + t.version + '" entry to ' + slug + '/CHANGELOG.md');
  });

  ['index.html', 'configure.html'].forEach(function (page) {
    test(slug + '/' + page + ': shared scripts first, every local file exists and is stamped', function () {
      const html = h.read(slug + '/' + page);
      const boot = html.indexOf('../shared/boot.js');
      const core = html.indexOf('../shared/core.js');
      const cfg = html.indexOf('./config.js');
      assert.ok(boot >= 0 && core > boot && cfg > core, 'order must be boot.js, core.js, config.js');
      assert.match(html, new RegExp('data-ext-version="' + t.version.replace(/\./g, '\\.') + '"'), 'run python3 stamp-versions.py');
      assert.doesNotMatch(html, /document\.write/);
      assert.doesNotMatch(html, /https?:\/\/(?!www\.w3\.org)/, 'no outside hosts (CDNs are blocked by the bank proxy)');
      const re = /(?:src|href|data-lib|data-mock)="(\.{1,2}\/[^"?#]+\.(?:js|css))(\?v=([0-9a-f]+))?"/g;
      let m;
      let n = 0;
      while ((m = re.exec(html))) {
        n++;
        assert.ok(h.exists(path.join(slug, m[1])), page + ' → ' + m[1] + ' does not exist');
        assert.ok(m[3], m[1] + ' has no ?v= stamp: run python3 stamp-versions.py');
      }
      assert.ok(n >= 4);
    });
  });

  test(slug + ': chart data is never kept in the browser', function () {
    ['chart.js', 'card.js'].filter(function (f) { return h.exists(slug + '/' + f); }).forEach(function (f) {
      assert.doesNotMatch(h.read(slug + '/' + f), /lastRender|writeCache|readCacheEntry/, 'the last-render cache was removed on purpose (AGENTS.md)');
    });
  });

  test(slug + ': Format dialog opens on top of Tableau (Modal)', function () {
    const f = ['chart.js', 'card.js'].find(function (x) { return h.exists(slug + '/' + x); });
    assert.match(h.read(slug + '/' + f), /DialogStyle\.Modal|DS\.Modal/);
  });

  test(slug + ': top-level .trex copy is in sync', { skip: !fs.existsSync(path.join(TOP, 'AGENTS.md')) && !fs.existsSync(path.join(TOP, 'CLAUDE.md')) }, function () {
    const copy = path.join(TOP, t.file);
    assert.ok(fs.existsSync(copy), 'copy ' + slug + '/' + t.file + ' to the top-level folder (python3 release.py does it)');
    assert.equal(fs.readFileSync(copy, 'utf8'), t.text, t.file + ' differs from the top-level copy: run python3 release.py');
  });
});

test('no .trex anywhere points at localhost', function () {
  const walk = function (dir) {
    fs.readdirSync(dir, { withFileTypes: true }).forEach(function (e) {
      if (e.name === 'node_modules' || e.name === '.git') return;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.trex')) {
        assert.doesNotMatch(fs.readFileSync(p, 'utf8'), /localhost|127\.0\.0\.1/, p);
        assert.doesNotMatch(e.name, /localhost/i, p);
      }
    });
  };
  walk(h.ROOT);
});

test('the landing page lists every extension', function () {
  const html = h.read('index.html');
  h.extensions().forEach(function (slug) { assert.ok(html.indexOf('./' + slug + '/') >= 0, slug + ' missing from index.html'); });
});
