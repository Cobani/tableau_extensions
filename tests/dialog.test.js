'use strict';
// shared/dialog.js: the Format dialog control builders, run against a tiny stand-in DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./helpers.js');

/** Just enough of the DOM for the builders: elements, fragments, events, <select> value. */
function fakeDocument () {
  function el (tag) {
    const listeners = {};
    const attrs = {};
    const classes = new Set();
    let value = '';
    let selectedIndex = -1;
    const n = {
      tagName: String(tag).toUpperCase(),
      children: [],
      style: {},
      checked: false,
      hidden: false,
      appendChild: function (c) {
        if (c && c.isFragment) { c.children.slice().forEach(function (x) { n.appendChild(x); }); c.children.length = 0; return c; }
        if (c.parent) c.parent.children.splice(c.parent.children.indexOf(c), 1);
        c.parent = n;
        n.children.push(c);
        if (n.tagName === 'SELECT' && selectedIndex < 0) selectedIndex = 0;
        return c;
      },
      append: function () { Array.prototype.forEach.call(arguments, function (c) { n.appendChild(c); }); },
      replaceChild: function (next, old) {
        const i = n.children.indexOf(old);
        n.appendChild(next);
        n.children.splice(n.children.indexOf(next), 1);
        n.children.splice(i, 1, next);
        old.parent = null;
        return old;
      },
      setAttribute: function (k, v) { attrs[k] = String(v); },
      getAttribute: function (k) { return k in attrs ? attrs[k] : null; },
      classList: {
        add: function (c) { classes.add(c); },
        remove: function (c) { classes.delete(c); },
        toggle: function (c, on) { if (on === undefined ? !classes.has(c) : on) classes.add(c); else classes.delete(c); },
        contains: function (c) { return classes.has(c); }
      },
      addEventListener: function (type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
      dispatch: function (type) { (listeners[type] || []).forEach(function (fn) { fn({ type: type, target: n, preventDefault: function () {} }); }); },
      dispatchEvent: function (e) { n.dispatch(e.type); return true; },
      focus: function () {},
      querySelector: function (sel) {
        const all = n.querySelectorAll(sel);
        return all.length ? all[0] : null;
      },
      // Selectors the dialog code uses: tag, tag[type="x"], .class, and comma lists of those, in document order.
      querySelectorAll: function (sel) {
        const tests = sel.split(',').map(function (part) {
          const t = part.trim();
          const cls = /^\.([\w-]+)$/.exec(t);
          if (cls) return function (c) { return String(c.className || '').split(/\s+/).indexOf(cls[1]) >= 0; };
          const m = /^(\w+)(?:\[type="(\w+)"\])?$/.exec(t);
          return function (c) { return c.tagName === m[1].toUpperCase() && (!m[2] || c.type === m[2]); };
        });
        const out = [];
        const walk = function (x) {
          for (const c of x.children) {
            if (tests.some(function (f) { return f(c); })) out.push(c);
            walk(c);
          }
        };
        walk(n);
        return out;
      },
      closest: function (sel) {
        const cls = /^\.([\w-]+)$/.exec(sel)[1];
        for (let x = n; x; x = x.parent) if (String(x.className || '').split(/\s+/).indexOf(cls) >= 0) return x;
        return null;
      }
    };
    // <input>.value is a string (null → ''); <select>.value follows the chosen <option>.
    Object.defineProperty(n, 'value', {
      get: function () {
        if (n.tagName !== 'SELECT') return value;
        const o = n.children[selectedIndex];
        return o ? o.value : '';
      },
      set: function (v) {
        if (n.tagName !== 'SELECT') { value = v === null ? '' : String(v); return; }
        selectedIndex = n.children.findIndex(function (o) { return o.value === String(v); });
      }
    });
    Object.defineProperty(n, 'selectedIndex', {
      get: function () { return selectedIndex; },
      set: function (i) { selectedIndex = i; }
    });
    return n;
  }
  return {
    createElement: el,
    createDocumentFragment: function () { const f = el('#fragment'); f.isFragment = true; return f; },
    getElementById: function () { return null; },
    addEventListener: function () {},
    body: null
  };
}

/** ExtDialog in a sandbox with the fake DOM, plus a kit bound to a plain settings object. */
function setup (settings, options) {
  const win = h.sandbox(['shared/core.js', 'shared/dialog.js']);
  win.document = fakeDocument();
  win.Event = function (type) { this.type = type; };
  const cfg = settings || {};
  const calls = [];
  const get = function (p) { return win.ExtDialog.P(p).reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg); };
  const set = function (p, v) {
    const keys = win.ExtDialog.P(p);
    const last = keys.pop();
    keys.reduce(function (o, k) { if (o[k] == null || typeof o[k] !== 'object') o[k] = {}; return o[k]; }, cfg)[last] = v;
    calls.push([keys.concat(last).join('.'), v]);
  };
  const kit = win.ExtDialog.kit(Object.assign({ get: get, set: set, fonts: ['Lato', 'Arial'] }, options || {}));
  return { win: win, D: win.ExtDialog, kit: kit, cfg: cfg, calls: calls };
}

/** The first descendant with this tag (and type). */
function find (node, tag, type) {
  for (const c of node.children) {
    if (c.tagName === tag.toUpperCase() && (!type || c.type === type)) return c;
    const f = find(c, tag, type);
    if (f) return f;
  }
  return null;
}

test('h builds the element with properties, role attribute and children', function () {
  const t = setup();
  const child = t.D.h('span', { textContent: 'x' });
  const n = t.D.h('div', { className: 'row', role: 'tab', title: 'T' }, [child]);
  assert.equal(n.tagName, 'DIV');
  assert.equal(n.className, 'row');
  assert.equal(n.title, 'T');
  assert.equal(n.getAttribute('role'), 'tab');
  assert.equal(n.role, undefined);
  assert.deepEqual(n.children, [child]);
  assert.equal(t.D.h('p').children.length, 0);
});

test('P splits dotted paths and keeps arrays', function () {
  const t = setup();
  assert.deepEqual(Array.from(t.D.P('a.b')), ['a', 'b']);
  assert.deepEqual(Array.from(t.D.P('a.b', 'c.d')), ['a', 'b', 'c', 'd']);
  const base = ['series', 'Sales.2024'];
  assert.deepEqual(Array.from(t.D.P(base, 'label')), ['series', 'Sales.2024', 'label']);
  assert.deepEqual(base, ['series', 'Sales.2024']); // not changed
});

test('row, group and help build the expected markup', function () {
  const t = setup();
  const r = t.kit.row('Size');
  assert.equal(r.className, 'row');
  assert.equal(r.children[0].tagName, 'LABEL');
  assert.equal(r.children[0].textContent, 'Size');
  const parent = t.D.h('div');
  const g = t.D.group(parent, 'Title');
  assert.equal(g.className, 'group');
  assert.equal(g.children[0].className, 'group-title');
  assert.equal(parent.children[0], g);
  assert.equal(t.D.help('Hi').className, 'help');
});

test('rowDecorator sees every row with its path', function () {
  const seen = [];
  const t = setup({ a: { on: true } }, { rowDecorator: function (r, path, label) { seen.push(path); label.appendChild(t2.D.h('span', { className: 'tag-card' })); } });
  const t2 = t;
  const r = t.kit.checkboxRow('On', 'a.on');
  assert.deepEqual(seen, ['a.on']);
  assert.equal(r.children[0].children[0].className, 'tag-card');
});

test('numberRow clamps to min / max and ignores empty input', function () {
  const t = setup({ n: { size: 12 } });
  const input = find(t.kit.numberRow('Size', 'n.size', 6, 160, 1), 'input');
  assert.equal(input.value, '12');
  input.value = '500'; input.dispatch('input');
  input.value = '2'; input.dispatch('input');
  input.value = ''; input.dispatch('input');
  input.value = 'abc'; input.dispatch('input');
  input.value = '20'; input.dispatch('input');
  assert.deepEqual(t.calls, [['n.size', 160], ['n.size', 6], ['n.size', 20]]);
});

test('checkboxRow sets true / false and runs the after hook', function () {
  const t = setup({ a: { on: false } });
  let after = 0;
  const input = find(t.kit.checkboxRow('On', 'a.on', function () { after++; }), 'input', 'checkbox');
  assert.equal(input.checked, false);
  input.checked = true; input.dispatch('change');
  input.checked = false; input.dispatch('change');
  assert.deepEqual(t.calls, [['a.on', true], ['a.on', false]]);
  assert.equal(after, 2);
});

test('colorRow writes a normalised #RRGGBB and ignores invalid text', function () {
  const t = setup({ c: '#112233' });
  const r = t.kit.colorRow('Color', 'c');
  const picker = find(r, 'input', 'color');
  const hex = find(r, 'input', 'text');
  assert.equal(picker.value, '#112233');
  hex.value = 'abc'; hex.dispatch('input');
  assert.deepEqual(t.calls, [['c', '#AABBCC']]);
  assert.equal(picker.value, '#AABBCC');
  hex.value = 'nope'; hex.dispatch('input');
  assert.equal(t.calls.length, 1);
  assert.ok(hex.classList.contains('is-invalid'));
  hex.dispatch('blur');
  assert.equal(hex.value, '#AABBCC');
  assert.ok(!hex.classList.contains('is-invalid'));
  picker.value = '#ff0000'; picker.dispatch('input');
  assert.deepEqual(t.calls[1], ['c', '#FF0000']);
  // an unreadable stored colour shows black in the picker
  assert.equal(find(setup({ c: 'red' }).kit.colorRow('C', 'c'), 'input', 'color').value, '#000000');
});

test('selectRow sets the chosen value with its original type', function () {
  const t = setup({ w: 400 });
  const sel = find(t.kit.selectRow('Weight', 'w', [[400, 'Regular'], [700, 'Bold']]), 'select');
  assert.equal(sel.value, '400');
  sel.value = '700'; sel.dispatch('change');
  assert.deepEqual(t.calls, [['w', 700]]);
  // with help text the row is wrapped together with a .help line
  const wrapped = t.kit.selectRow('Weight', 'w', [[400, 'Regular']], 'Some help');
  assert.equal(wrapped.children[1].className, 'help');
});

test('selectRow with a value not in the list: blank, or the first option when asked', function () {
  const opts = [['a', 'A'], ['b', 'B']];
  assert.equal(find(setup({ v: 'z' }).kit.selectRow('V', 'v', opts), 'select').selectedIndex, -1);
  assert.equal(find(setup({ v: 'z' }, { selectFirstIfMissing: true }).kit.selectRow('V', 'v', opts), 'select').selectedIndex, 0);
});

test('textRow shows null as "null" unless textNullAsEmpty, and writes what is typed', function () {
  assert.equal(find(setup({ t: null }).kit.textRow('T', 't'), 'input').value, '');
  assert.equal(find(setup({}).kit.textRow('T', 't'), 'input').value, 'undefined');
  assert.equal(find(setup({}, { textNullAsEmpty: true }).kit.textRow('T', 't'), 'input').value, '');
  const t = setup({ t: 'x' });
  const input = find(t.kit.textRow('T', 't', 'hint'), 'input');
  assert.equal(input.placeholder, 'hint');
  input.value = 'y'; input.dispatch('input');
  assert.deepEqual(t.calls, [['t', 'y']]);
});

test('segRow marks the pressed button and sets its value', function () {
  const t = setup({ s: 'a' });
  const seg = find(t.kit.segRow('S', 's', [['a', 'A'], ['b', 'B']]), 'div');
  assert.deepEqual(seg.children.map(function (b) { return b.getAttribute('aria-pressed'); }), ['true', 'false']);
  seg.children[1].dispatch('click');
  assert.deepEqual(t.calls, [['s', 'b']]);
  assert.deepEqual(seg.children.map(function (b) { return b.getAttribute('aria-pressed'); }), ['false', 'true']);
});

test('unitRow: a sign button fills the box and saves it', function () {
  const t = setup({ u: '' });
  const r = t.kit.unitRow('Unit', 'u');
  const field = r.children[1];
  assert.equal(field.className, 'unit-field');
  const signs = field.children[1];
  assert.equal(signs.children.length, t.D.UNIT_SIGNS.length);
  signs.children[3].dispatch('click');
  assert.deepEqual(t.calls, [['u', '$']]);
});

test('fontFamilyRow and fontRows', function () {
  const t = setup({ f: { font: 'Comic', size: 12, weight: 400, color: '#000000', italic: false } });
  const r = t.kit.fontFamilyRow('Font', 'f.font');
  const sel = find(r, 'select');
  const custom = find(r, 'input');
  assert.equal(sel.value, '__custom');
  assert.equal(custom.value, 'Comic');
  sel.value = 'Arial'; sel.dispatch('change');
  assert.equal(custom.hidden, true);
  assert.deepEqual(t.calls, [['f.font', 'Arial']]);
  const g = t.D.h('div');
  t.kit.fontRows(g, 'f');
  assert.equal(g.children.length, 5);
  t.kit.fontRows(g, 'f', false);
  assert.equal(g.children.length, 9);
  // string paths when the dialog asks for them
  const paths = [];
  const s = setup({}, { get: function (p) { paths.push(p); return ''; }, fontPath: function (a, b) { return a + '.' + b; } });
  s.kit.fontRows(s.D.h('div'), 'title', false);
  assert.ok(paths.indexOf('title.size') >= 0);
});

test('getAt / setAt / delAt and escapeHtml', function () {
  const t = setup();
  const o = {};
  t.D.setAt(o, 'a.b.c', 1);
  assert.equal(t.D.getAt(o, 'a.b.c'), 1);
  assert.equal(t.D.getAt(o, 'x.y'), undefined);
  t.D.delAt(o, 'a.b.c');
  assert.deepEqual(JSON.parse(JSON.stringify(o)), { a: { b: {} } });
  assert.equal(t.D.escapeHtml('<b a="1">&</b>'), '&lt;b a=&quot;1&quot;&gt;&amp;&lt;/b&gt;');
});

// ---- Undo / Redo ----------------------------------------------------------
function makeHistory (limit) {
  const t = setup();
  const state = { v: 0 };
  let clock = 0;
  const hist = t.D.history({
    snapshot: function () { return JSON.stringify(state); },
    restore: function (j) { state.v = JSON.parse(j).v; },
    now: function () { return clock; },
    limit: limit
  });
  // a change as the dialog does it: edit, then record()
  const change = function (v, at) { state.v = v; clock = at; return hist.record(); };
  return { hist: hist, state: state, change: change };
}

test('history: opening state cannot be undone; only real changes are recorded', function () {
  const x = makeHistory();
  assert.equal(x.hist.canUndo(), false);
  assert.equal(x.hist.canRedo(), false);
  assert.equal(x.change(0, 1000), false); // same value: nothing recorded
  assert.equal(x.hist.canUndo(), false);
  assert.equal(x.change(1, 2000), true);
  assert.equal(x.hist.canUndo(), true);
  assert.equal(x.hist.undo(), true);
  assert.equal(x.state.v, 0);
  assert.equal(x.hist.canUndo(), false);
  assert.equal(x.hist.undo(), false);
});

test('history: changes within 600 ms are one step, later ones are separate', function () {
  const x = makeHistory();
  x.change(1, 1000); x.change(2, 1300); x.change(3, 1800); // each < 600 ms after the previous: one step
  x.change(4, 3000);
  x.hist.undo();
  assert.equal(x.state.v, 3);
  x.hist.undo();
  assert.equal(x.state.v, 0);
  assert.equal(x.hist.canUndo(), false);
});

test('history: undo and redo go in order, a new change clears redo', function () {
  const x = makeHistory();
  x.change(1, 1000); x.change(2, 3000); x.change(3, 5000);
  x.hist.undo(); x.hist.undo();
  assert.equal(x.state.v, 1);
  assert.equal(x.hist.canRedo(), true);
  x.hist.redo();
  assert.equal(x.state.v, 2);
  x.hist.undo();
  x.change(9, 8000); // new change after undo
  assert.equal(x.hist.canRedo(), false);
  assert.equal(x.hist.redo(), false);
  x.hist.undo();
  assert.equal(x.state.v, 1);
});

test('history: a change right after undo is its own step; record during restore is ignored', function () {
  const x = makeHistory();
  x.change(1, 1000); x.change(2, 3000);
  x.hist.undo();
  x.change(5, 3100); // within 600 ms of the last record, but after an undo
  x.hist.undo();
  assert.equal(x.state.v, 1);
});

test('history: changing back to the previous state leaves no step; seal() splits a step', function () {
  const x = makeHistory();
  x.change(1, 1000);
  x.change(0, 1100); // back to the opening state within the window
  assert.equal(x.hist.canUndo(), false);
  const y = makeHistory();
  y.change(1, 1000);
  y.hist.seal();
  y.change(2, 1100);
  y.hist.undo();
  assert.equal(y.state.v, 1);
});

test('history: keeps at most `limit` steps', function () {
  const x = makeHistory(5);
  for (let i = 1; i <= 20; i++) x.change(i, i * 1000);
  let n = 0;
  while (x.hist.undo()) n++;
  assert.equal(n, 5);
  assert.equal(x.state.v, 15);
});

test('history: clear() makes the current state the opening state', function () {
  const x = makeHistory();
  x.change(1, 1000);
  x.hist.clear();
  assert.equal(x.hist.canUndo(), false);
});

test('history: subscribers hear about every change of what can be undone', function () {
  const x = makeHistory();
  let n = 0;
  x.hist.subscribe(function () { n++; });
  x.change(1, 1000); x.hist.undo(); x.hist.redo();
  assert.equal(n, 3);
});

test('keyboard: Ctrl/Cmd+Z, Shift+Z and Ctrl+Y; never while typing in a text box', function () {
  const D = setup().D;
  assert.equal(D._undoKey({ key: 'z', ctrlKey: true }), 'undo');
  assert.equal(D._undoKey({ key: 'Z', metaKey: true, shiftKey: true }), 'redo');
  assert.equal(D._undoKey({ key: 'y', ctrlKey: true }), 'redo');
  assert.equal(D._undoKey({ key: 'z' }), null);
  assert.equal(D._undoKey({ key: 'y', metaKey: true }), null);
  assert.equal(D._inTextField({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(D._inTextField({ tagName: 'INPUT', type: 'number' }), true);
  assert.equal(D._inTextField({ tagName: 'TEXTAREA' }), true);
  assert.equal(D._inTextField({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(D._inTextField({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(D._inTextField({ tagName: 'SELECT' }), false);
  assert.equal(D._inTextField({ tagName: 'BUTTON' }), false);
});

// ---- Settings search ------------------------------------------------------
test('search match: all words, any case, any order, at least 2 characters', function () {
  const D = setup().D;
  const text = 'Numbers › Big number › Decimal places';
  assert.equal(D._match('decimal', text), true);
  assert.equal(D._match('DECIMAL PLACES', text), true);
  assert.equal(D._match('places decimal', text), true);
  assert.equal(D._match('numbers places', text), true);
  assert.equal(D._match('decimal colour', text), false);
  assert.equal(D._match('d', text), false);
  assert.equal(D._match('', text), false);
  assert.equal(D._match('   ', text), false);
  assert.equal(D._match(null, text), false);
  assert.equal(D._match('de', text), true);
});

test('search index: reads group titles and row labels from a built tab', function () {
  const t = setup({ a: 1, b: 2 });
  const p = t.D.h('section');
  const g = t.D.group(p, 'Title');
  g.appendChild(t.kit.numberRow('Size (px)', 'a', 1, 9, 1));
  g.appendChild(t.kit.numberRow('Size (px)', 'b', 1, 9, 1));
  const g2 = t.D.group(p, 'Axis');
  g2.appendChild(t.kit.checkboxRow('Show axis', 'a'));
  const found = t.D._scanPanel(p).map(function (e) { return [e.group, e.label, e.nth]; });
  assert.equal(JSON.stringify(found), JSON.stringify([['Title', '', 1], ['Title', 'Size (px)', 1], ['Title', 'Size (px)', 2], ['Axis', '', 1], ['Axis', 'Show axis', 1]]));
});
