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
        const m = /^(\w+)(?:\[type="(\w+)"\])?$/.exec(sel);
        const walk = function (x) {
          for (const c of x.children) {
            if (c.tagName === m[1].toUpperCase() && (!m[2] || c.type === m[2])) return c;
            const f = walk(c);
            if (f) return f;
          }
          return null;
        };
        return walk(n);
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
