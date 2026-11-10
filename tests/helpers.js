'use strict';
// Loads browser scripts (shared/core.js, <slug>/config.js, …) into a sandbox with a minimal
// stand-in for window / document / tableau, so their logic can be tested with plain Node.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

/** Every extension folder (has a .trex), sorted. */
function extensions () {
  return fs.readdirSync(ROOT).filter(function (d) {
    const p = path.join(ROOT, d);
    return fs.statSync(p).isDirectory() && fs.readdirSync(p).some(function (f) { return f.endsWith('.trex'); });
  }).sort();
}

function read (rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function exists (rel) { return fs.existsSync(path.join(ROOT, rel)); }

/** The .trex file name and extension-version of one extension folder. */
function trex (slug) {
  const file = fs.readdirSync(path.join(ROOT, slug)).find(function (f) { return f.endsWith('.trex'); });
  const text = read(slug + '/' + file);
  return { file: file, text: text, version: (/extension-version="([^"]+)"/.exec(text) || [])[1], id: (/worksheet-extension id="([^"]+)"/.exec(text) || [])[1] };
}

/**
 * A sandbox with the given scripts run in order. `saved` is the settings JSON
 * string Tableau would return (any key). Returns the sandbox's window.
 */
function sandbox (scripts, saved) {
  const store = {};
  const win = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    Intl: Intl,
    JSON: JSON,
    Math: Math,
    Date: Date,
    Promise: Promise,
    location: { search: '', hash: '', href: 'http://localhost/x/index.html', pathname: '/x/index.html', origin: 'http://localhost' },
    navigator: { userAgent: 'node' },
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {}, key: function () { return null; }, length: 0 },
    document: { getElementById: function () { return null; }, addEventListener: function () {}, createElement: function () { return { style: {}, setAttribute: function () {}, appendChild: function () {} }; }, body: null },
    addEventListener: function () {},
    tableau: {
      extensions: {
        settings: {
          get: function (k) { return saved !== undefined ? saved : store[k]; },
          set: function (k, v) { store[k] = v; },
          saveAsync: function () { return Promise.resolve(); }
        }
      }
    },
    __store: store
  };
  win.window = win;
  win.globalThis = win;
  const ctx = vm.createContext(win);
  scripts.forEach(function (rel) { vm.runInContext(read(rel), ctx, { filename: rel }); });
  return win;
}

/** Scripts an extension's config.js needs, in page order. */
function configScripts (slug) {
  const list = ['shared/core.js'];
  if (exists('shared/theme.js')) list.push('shared/theme.js');
  if (exists(slug + '/icons.js')) list.push(slug + '/icons.js');
  list.push(slug + '/config.js');
  return list;
}

/** The global a config.js publishes (Bc, Wf, KpiCardConfig, …): the one with DEFAULTS and read(). */
function configApi (win) {
  const key = Object.keys(win).find(function (k) {
    const v = win[k];
    return v && typeof v === 'object' && v.DEFAULTS && typeof v.read === 'function' && v.STORAGE_KEY;
  });
  return key ? Object.assign({ __name: key }, win[key]) : null;
}

/** Every leaf path of an object: { a: { b: 1 }, c: [] } → ['a.b', 'c']. Arrays and empty maps are leaves. */
function leafPaths (o, prefix) {
  let out = [];
  Object.keys(o).forEach(function (k) {
    const v = o[k];
    const p = prefix ? prefix + '.' + k : k;
    if (v && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length) out = out.concat(leafPaths(v, p));
    else out.push(p);
  });
  return out;
}

function getPath (o, p) {
  return p.split('.').reduce(function (a, k) { return a == null ? undefined : a[k]; }, o);
}

module.exports = { ROOT: ROOT, extensions: extensions, read: read, exists: exists, trex: trex, sandbox: sandbox, configScripts: configScripts, configApi: configApi, leafPaths: leafPaths, getPath: getPath };
