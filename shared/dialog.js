'use strict';

/**
 * ExtDialog — the control builders every Format dialog (configure.js) uses.
 *
 * Loaded by every configure.html after shared/core.js and before the
 * extension's config.js. Nothing here knows about a particular chart: the
 * dialog passes in how it reads and writes its settings. A change here
 * changes every Format dialog, so it is covered by tests/dialog.test.js.
 *
 * Used directly (need nothing from the dialog):
 *   h(tag, props, children)      element with properties ('role' → attribute) and children
 *   P(base, rest)                path helper: P('a.b', 'c') / P(['series', key], 'label') → array
 *   group(parent, title)         titled .group box appended to parent
 *   help(text)                   .help line
 *   wrapRows(frag)               fragment wrapped in a <div>
 *   escapeHtml(s)                HTML-escapes text (null → 'null', as the dialogs always did)
 *   readAsDataUrl(blob)          Promise of a data: URL
 *   blobToIconDataUrl(blob)      small SVGs kept, everything else rasterised to 96 px
 *   setStatus(text)              writes the #status line
 *   baseUrl()                    folder URL of the current page
 *   copyText(text, textarea)     clipboard copy with a select + execCommand fallback
 *   download(text, name)         saves text as a JSON file
 *   getAt / setAt / delAt        dotted-path access on any object (setAt(o, p, undefined) deletes)
 *   WEIGHTS, UNIT_SIGNS          font weight options; currency signs under the Unit box
 *
 * Bound to one dialog by ExtDialog.kit(options):
 *   row(label, path)             .row with a label (options.rowDecorator may mark it)
 *   textRow, unitRow             text box; text box with currency sign buttons
 *   numberRow                    number box, clamped to min / max, empty input ignored
 *   rangeRow                     slider with a readout
 *   checkboxRow                  checkbox, set(path, true / false)
 *   selectRow                    drop-down of [value, label] pairs, optional help line
 *   segRow                       segmented buttons (aria-pressed)
 *   colorRow                     colour picker + hex box (#RRGGBB, invalid text ignored)
 *   fontFamilyRow, fontRows      font list + "Other…"; font / size / weight / colour / italic
 *
 * options:
 *   get(path), set(path, value)  the dialog's own settings access (set saves + live preview)
 *   fonts                        the config's FONTS list
 *   rowDecorator(row, path, label)  optional; called for every row built with a path
 *   fontPath(section, key)       how fontRows builds paths (default P → array)
 *   textNullAsEmpty              textRow shows '' when the value is null / undefined
 *   selectFirstIfMissing         selectRow picks the first option when the value is not listed
 *
 * Undo / Redo and settings search (same hook-up in every configure.js):
 *   history({ snapshot, restore, limit })   steps; record() after every change (see history())
 *   footerTools({ history, footer })        Undo / Redo buttons + Ctrl/Cmd+Z shortcuts
 *   search({ tabs, container, getTabs, openTab })   search box above the tab bar
 *
 * In a configure.js (inside its IIFE, before any builder is called):
 *   var kit = ExtDialog.kit({ get: get, set: set, fonts: Bc.FONTS });
 *   var h = ExtDialog.h, row = kit.row, numberRow = kit.numberRow, …;
 */
(function (root) {
  // ---------------------------------------------------------------------------
  // Plain helpers
  // ---------------------------------------------------------------------------
  function h (tag, props, children) {
    const n = document.createElement(tag);
    Object.keys(props || {}).forEach(function (k) {
      if (k === 'role') n.setAttribute('role', props[k]); else n[k] = props[k];
    });
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  /** Path helper: P('a.b', 'c.d') or P(['series', key], 'label') → array. */
  function P (base, rest) {
    const a = Array.isArray(base) ? base.slice() : String(base).split('.');
    return rest == null ? a : a.concat(String(rest).split('.'));
  }

  function group (parent, title) {
    const g = h('div', { className: 'group' });
    g.appendChild(h('h3', { className: 'group-title', textContent: title }));
    parent.appendChild(g);
    return g;
  }

  function help (text) { return h('div', { className: 'help', textContent: text }); }

  function wrapRows (frag) { const d = h('div'); d.appendChild(frag); return d; }

  function escapeHtml (s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; });
  }

  function readAsDataUrl (blob) {
    return new Promise(function (resolve, reject) {
      const fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(blob);
    });
  }

  /**
   * Small SVGs are kept as vectors; everything else is rasterised so its
   * longer side is 96 px (4× the 24 px display size).
   */
  function blobToIconDataUrl (blob) {
    return readAsDataUrl(blob).then(function (url) {
      const isSvg = /svg/i.test(blob.type) || /^data:image\/svg/i.test(url);
      if (isSvg && url.length < 60000) return url;
      return new Promise(function (resolve, reject) {
        const img = new Image();
        img.onload = function () {
          const w = img.naturalWidth || 96;
          const hh = img.naturalHeight || 96;
          const k = 96 / Math.max(w, hh);
          if (k >= 1 && url.length < 60000) { resolve(url); return; }
          const c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(w * Math.min(k, 1)));
          c.height = Math.max(1, Math.round(hh * Math.min(k, 1)));
          const ctx = c.getContext('2d');
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/png'));
        };
        img.onerror = function () { reject(new Error('unsupported image format')); };
        img.src = url;
      });
    });
  }

  function setStatus (text) {
    document.getElementById('status').textContent = text;
  }

  function baseUrl () {
    return window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '');
  }

  function copyText (text, ta) {
    const fallback = function () {
      try { ta.focus(); ta.select(); return document.execCommand('copy'); } catch (e) { return false; }
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; }, fallback);
    }
    return Promise.resolve(fallback());
  }

  function download (text, name) {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = h('a', { href: url, download: name });
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 1000);
      return true;
    } catch (e) { return false; }
  }

  function getAt (o, path) { return path.split('.').reduce(function (x, k) { return x == null ? undefined : x[k]; }, o); }

  function setAt (o, path, v) {
    const keys = path.split('.');
    const last = keys.pop();
    const t = keys.reduce(function (x, k) { if (x[k] == null || typeof x[k] !== 'object') x[k] = {}; return x[k]; }, o);
    if (v === undefined) delete t[last]; else t[last] = v;
  }

  function delAt (o, path) { setAt(o, path, undefined); }

  const WEIGHTS = [[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [900, 'Black']];

  // Currency signs offered under the Unit box (clicking one fills the box).
  // Saudi riyal and Turkish lira first, then by how widely the currency is used.
  const UNIT_SIGNS = [
    ['⃁', 'Saudi riyal'], ['₺', 'Turkish lira'], ['৳', 'Bangladeshi taka'],
    ['$', 'US dollar'],
    ['€', 'Euro'], ['£', 'Pound sterling'], ['¥', 'Japanese yen / Chinese yuan'],
    ['₹', 'Indian rupee'], ['₩', 'Korean won'], ['₽', 'Russian ruble'],
    ['₱', 'Philippine peso'], ['฿', 'Thai baht']
  ];

  // ---------------------------------------------------------------------------
  // Builders bound to one dialog
  // ---------------------------------------------------------------------------
  function kit (options) {
    const opts = options || {};
    const get = opts.get;
    const set = opts.set;
    const fonts = opts.fonts || [];
    const weights = opts.weights || WEIGHTS;
    const unitSigns = opts.unitSigns || UNIT_SIGNS;
    const fontPath = opts.fontPath || P;
    const normalizeHex = root.ExtCore.normalizeHex;

    function row (label, path) {
      const r = h('div', { className: 'row' });
      const l = h('label', { textContent: label });
      r.appendChild(l);
      if (opts.rowDecorator) opts.rowDecorator(r, path, l);
      return r;
    }

    function textRow (label, path, placeholder) {
      const r = row(label, path);
      const cur = get(path);
      const input = h('input', { type: 'text', value: opts.textNullAsEmpty && cur == null ? '' : cur, placeholder: placeholder || '' });
      input.addEventListener('input', function () { set(path, input.value); });
      r.appendChild(input);
      return r;
    }

    function numberRow (label, path, min, max, step) {
      const r = row(label, path);
      const input = h('input', { type: 'number', min: min, max: max, step: step, value: get(path) });
      input.addEventListener('input', function () {
        const n = Number(input.value);
        if (input.value === '' || !isFinite(n)) return;
        set(path, Math.max(min, Math.min(max, n)));
      });
      r.appendChild(input);
      return r;
    }

    function rangeRow (label, path, min, max, step, unit) {
      const r = row(label, path);
      const wrap = h('div', { className: 'inline' });
      const input = h('input', { type: 'range', min: min, max: max, step: step, value: get(path) });
      const out = h('span', { className: 'readout', textContent: get(path) + (unit || '') });
      input.addEventListener('input', function () { set(path, Number(input.value)); out.textContent = input.value + (unit || ''); });
      wrap.append(input, out);
      r.appendChild(wrap);
      return r;
    }

    function checkboxRow (label, path, after) {
      const r = row(label, path);
      const input = h('input', { type: 'checkbox' });
      input.checked = !!get(path);
      input.addEventListener('change', function () { set(path, input.checked); if (after) after(); });
      r.appendChild(h('div', { className: 'inline' }, [input]));
      return r;
    }

    function selectRow (label, path, options, helpText, after) {
      const r = row(label, path);
      const sel = h('select');
      options.forEach(function (o) { sel.appendChild(h('option', { value: String(o[0]), textContent: o[1] })); });
      sel.value = String(get(path));
      if (opts.selectFirstIfMissing && sel.selectedIndex < 0) sel.selectedIndex = 0;
      sel.addEventListener('change', function () {
        const orig = options.find(function (o) { return String(o[0]) === sel.value; })[0];
        set(path, orig);
        if (after) after();
      });
      r.appendChild(sel);
      if (helpText) { const frag = document.createDocumentFragment(); frag.append(r, h('div', { className: 'help', textContent: helpText })); return wrapRows(frag); }
      return r;
    }

    function segRow (label, path, options, after) {
      const r = row(label, path);
      const seg = h('div', { className: 'seg' });
      options.forEach(function (o) {
        const b = h('button', { type: 'button', textContent: o[1] });
        b.setAttribute('aria-pressed', String(get(path) === o[0]));
        b.addEventListener('click', function () {
          set(path, o[0]);
          Array.prototype.forEach.call(seg.children, function (c) { c.setAttribute('aria-pressed', 'false'); });
          b.setAttribute('aria-pressed', 'true');
          if (after) after();
        });
        seg.appendChild(b);
      });
      r.appendChild(seg);
      return r;
    }

    function colorRow (label, path, after) {
      const r = row(label, path);
      const wrap = h('div', { className: 'inline' });
      const picker = h('input', { type: 'color', value: normalizeHex(get(path)) || '#000000' });
      const hex = h('input', { type: 'text', className: 'hex', value: get(path), maxLength: 7, spellcheck: false });
      picker.addEventListener('input', function () {
        hex.value = picker.value.toUpperCase(); hex.classList.remove('is-invalid');
        set(path, hex.value); if (after) after();
      });
      hex.addEventListener('input', function () {
        const v = normalizeHex(hex.value);
        hex.classList.toggle('is-invalid', !v);
        if (v) { picker.value = v; set(path, v); if (after) after(); }
      });
      hex.addEventListener('blur', function () { hex.value = get(path); hex.classList.remove('is-invalid'); });
      wrap.append(picker, hex);
      r.appendChild(wrap);
      return r;
    }

    function unitRow (label, path, placeholder) {
      const r = textRow(label, path, placeholder);
      const input = r.querySelector('input[type="text"]');
      const field = h('div', { className: 'unit-field' });
      r.replaceChild(field, input);
      field.appendChild(input);
      const signs = h('div', { className: 'unit-signs' });
      unitSigns.forEach(function (s) {
        const b = h('button', { type: 'button', className: 'unit-sign', textContent: s[0], title: s[1] });
        b.addEventListener('click', function () {
          input.value = s[0];
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.focus();
        });
        signs.appendChild(b);
      });
      field.appendChild(signs);
      return r;
    }

    function fontFamilyRow (label, path) {
      const r = row(label, path);
      const wrap = h('div', { className: 'inline' });
      const sel = h('select');
      fonts.forEach(function (f) { sel.appendChild(h('option', { value: f, textContent: f })); });
      sel.appendChild(h('option', { value: '__custom', textContent: 'Other…' }));
      const custom = h('input', { type: 'text', placeholder: 'Installed font name' });
      const current = get(path);
      if (fonts.indexOf(current) >= 0) { sel.value = current; custom.hidden = true; } else { sel.value = '__custom'; custom.value = current; }
      sel.addEventListener('change', function () {
        custom.hidden = sel.value !== '__custom';
        if (sel.value !== '__custom') { set(path, sel.value); } else { custom.focus(); }
      });
      custom.addEventListener('input', function () { if (custom.value.trim()) set(path, custom.value.trim()); });
      wrap.append(sel, custom);
      r.appendChild(wrap);
      return r;
    }

    function fontRows (g, section, withItalic) {
      g.appendChild(fontFamilyRow('Font', fontPath(section, 'font')));
      g.appendChild(numberRow('Size (px)', fontPath(section, 'size'), 6, 160, 1));
      g.appendChild(selectRow('Weight', fontPath(section, 'weight'), weights));
      g.appendChild(colorRow('Color', fontPath(section, 'color')));
      if (withItalic !== false) g.appendChild(checkboxRow('Italic', fontPath(section, 'italic')));
    }

    return {
      h: h, group: group, help: help, wrapRows: wrapRows,
      row: row, textRow: textRow, numberRow: numberRow, rangeRow: rangeRow, checkboxRow: checkboxRow,
      selectRow: selectRow, segRow: segRow, colorRow: colorRow, unitRow: unitRow,
      fontFamilyRow: fontFamilyRow, fontRows: fontRows
    };
  }

  // ---------------------------------------------------------------------------
  // Undo / Redo
  // ---------------------------------------------------------------------------
  /**
   * Step history for a Format dialog. The dialog gives two functions:
   *   snapshot()      JSON string of ALL its working settings (for kpi-card-multi: the whole
   *                   store plus the selected card, so undo can also switch back to that card)
   *   restore(json)   puts such a string back and re-renders. It should go through the dialog's
   *                   normal change path (changed()) so the live preview updates and Done saves it.
   * The dialog calls record() right AFTER every change. record() stores the new state only when it
   * differs from the current one; changes less than 600 ms after the previous one replace that step
   * (a slider drag or typing a number is one step). A real change drops the redo steps. The opening
   * state is the bottom of the stack and can't be undone. Plain logic, no DOM: `now` is injectable.
   */
  function history (opts) {
    const o = opts || {};
    const limit = o.limit || 100;
    const gap = o.coalesceMs == null ? 600 : o.coalesceMs;
    const now = o.now || Date.now;
    const subs = [];
    let stack = [o.snapshot()];
    let idx = 0;
    let busy = false;
    let last = -Infinity; // time of the last record() that made / extended the current step
    function emit () { subs.forEach(function (f) { f(); }); }

    function record () {
      if (busy) return false;
      const s = o.snapshot();
      if (s === stack[idx]) return false;
      const t = now();
      stack.length = idx + 1; // a new change ends the redo line
      if (idx > 0 && t - last < gap) {
        stack[idx] = s;
        if (stack[idx - 1] === s) { stack.pop(); idx--; last = -Infinity; emit(); return true; } // changed back: no step
      } else {
        stack.push(s);
        idx++;
        if (stack.length > limit + 1) { stack.shift(); idx--; }
      }
      last = t;
      emit();
      return true;
    }
    function go (to) {
      idx = to;
      last = -Infinity; // the next change starts its own step
      busy = true; // restore() goes through the dialog's changed(), which calls record(): not a new step
      try { o.restore(stack[idx]); } finally { busy = false; }
      stack[idx] = o.snapshot(); // re-read, so later comparisons use the dialog's own normal form
      emit();
      return true;
    }
    return {
      record: record,
      undo: function () { return idx > 0 ? go(idx - 1) : false; },
      redo: function () { return idx < stack.length - 1 ? go(idx + 1) : false; },
      canUndo: function () { return idx > 0; },
      canRedo: function () { return idx < stack.length - 1; },
      /** The next change starts a new step even if it comes within 600 ms (a button click). */
      seal: function () { last = -Infinity; },
      clear: function () { stack = [o.snapshot()]; idx = 0; last = -Infinity; emit(); },
      subscribe: function (fn) { subs.push(fn); }
    };
  }

  const NON_TEXT_INPUTS = ['checkbox', 'radio', 'range', 'color', 'button', 'submit', 'reset', 'file', 'image'];

  /** True when the browser's own text undo should win (typing in a text, number, search or textarea box). */
  function inTextField (el) {
    if (!el || !el.tagName) return false;
    if (el.isContentEditable) return true;
    if (el.tagName === 'TEXTAREA') return true;
    return el.tagName === 'INPUT' && NON_TEXT_INPUTS.indexOf(String(el.type || 'text').toLowerCase()) < 0;
  }

  /** Which history step a key press asks for: 'undo', 'redo' or null. */
  function undoKey (e) {
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
    const k = String(e.key || '').toLowerCase();
    if (k === 'z') return e.shiftKey ? 'redo' : 'undo';
    if (k === 'y' && e.ctrlKey && !e.shiftKey) return 'redo';
    return null;
  }

  /**
   * Undo / Redo icon buttons in the footer, right after "Reset tab", plus the keyboard shortcuts
   * (Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, Ctrl+Y) except while typing in a text box.
   * options: history, footer (element), onChange (optional, called after each undo / redo).
   */
  function footerTools (options) {
    const hist = options.history;
    const footer = options.footer;
    const undoBtn = h('button', { className: 'btn btn--icon', type: 'button', id: 'undo', textContent: '↶', title: 'Undo (Ctrl/Cmd+Z)' });
    const redoBtn = h('button', { className: 'btn btn--icon', type: 'button', id: 'redo', textContent: '↷', title: 'Redo (Ctrl/Cmd+Shift+Z)' });
    undoBtn.setAttribute('aria-label', 'Undo');
    redoBtn.setAttribute('aria-label', 'Redo');
    const reset = document.getElementById('reset-tab');
    const after = reset && reset.parentNode === footer ? reset.nextSibling : footer.firstChild;
    footer.insertBefore(undoBtn, after);
    footer.insertBefore(redoBtn, undoBtn.nextSibling);

    function sync () { undoBtn.disabled = !hist.canUndo(); redoBtn.disabled = !hist.canRedo(); }
    function run (what) {
      if (!(what === 'undo' ? hist.undo() : hist.redo())) return false;
      if (options.onChange) options.onChange(what);
      return true;
    }
    undoBtn.addEventListener('click', function () { run('undo'); });
    redoBtn.addEventListener('click', function () { run('redo'); });
    // A footer click (Reset tab, Apply to all…) is one step of its own, not part of an earlier drag.
    footer.addEventListener('pointerdown', function () { hist.seal(); });
    document.addEventListener('keydown', function (e) {
      const what = undoKey(e);
      if (!what || inTextField(e.target)) return;
      e.preventDefault();
      run(what);
    });
    hist.subscribe(sync);
    sync();
    return { sync: sync, undoButton: undoBtn, redoButton: redoBtn };
  }

  // ---------------------------------------------------------------------------
  // Settings search
  // ---------------------------------------------------------------------------
  /** All words of the query (at least 2 characters in total) appear in the text, any case, any order. */
  function match (query, text) {
    const q = String(query == null ? '' : query).trim().toLowerCase();
    if (q.length < 2) return false;
    const t = String(text == null ? '' : text).toLowerCase();
    return q.split(/\s+/).every(function (w) { return t.indexOf(w) >= 0; });
  }

  /** Rows and group titles in a built tab: { group, label, key, row, groupEl } (label '' = the group itself). */
  function scanPanel (root) {
    const out = [];
    const count = {};
    function add (group, label, el, isGroup) {
      const key = group + '\u0001' + label;
      count[key] = (count[key] || 0) + 1;
      out.push({ group: group, label: label, key: key, nth: count[key], el: el, isGroup: isGroup });
    }
    Array.prototype.forEach.call(root.querySelectorAll('.group, .row'), function (n) {
      const isGroup = (n.className || '').split(/\s+/).indexOf('group') >= 0;
      if (isGroup) {
        const t = n.querySelector('.group-title');
        const title = t ? t.textContent.trim() : '';
        if (title) add(title, '', n, true);
        return;
      }
      const l = n.children && n.children[0];
      if (!l || String(l.tagName).toUpperCase() !== 'LABEL') return;
      const label = (l.textContent || '').trim();
      if (!label) return;
      const g = n.closest ? n.closest('.group') : null;
      const gt = g && g.querySelector('.group-title');
      add(gt ? gt.textContent.trim() : '', label, n, false);
    });
    return out;
  }

  /**
   * Search box over every tab of a Format dialog. No tab builder is changed: each tab is built once
   * into a detached <section> with its normal build(panel) function, and its .group titles and
   * .row labels are read from the result. The index is rebuilt each time a search starts (after
   * rebuild(), a card change or an undo the labels may differ). Building a tab off-screen can leave
   * a builder's remembered element pointing at the detached copy, so when a search ends without
   * opening a hit the tab that was open is built again through openTab.
   * options: tabs (the tab bar element), container (the panels element),
   *          getTabs() -> [{ id, label, build }], openTab(id) (select that tab and re-render)
   */
  function search (options) {
    const nav = options.tabs;
    const panels = options.container;
    let index = null;
    let indexed = false;
    let origin = null; // id of the tab that was open when the search started
    let active = false;
    let hits = [];

    const input = h('input', { type: 'search', className: 'dlg-search-input', placeholder: 'Search settings…', spellcheck: false });
    input.setAttribute('aria-label', 'Search settings');
    const box = h('div', { className: 'dlg-search' }, [input]);
    nav.parentNode.insertBefore(box, nav);
    const results = h('div', { className: 'body dlg-results' });
    results.hidden = true;
    results.style.display = 'none';
    panels.parentNode.insertBefore(results, panels.nextSibling);

    function openTabId () {
      const tabs = options.getTabs();
      const btns = nav.children || [];
      for (let i = 0; i < btns.length; i++) {
        if (btns[i].getAttribute && btns[i].getAttribute('aria-selected') === 'true' && tabs[i]) return tabs[i].id;
      }
      return tabs.length ? tabs[0].id : null;
    }

    function buildIndex () {
      index = [];
      options.getTabs().forEach(function (tab) {
        const panel = h('section', { className: 'panel' });
        try { tab.build(panel); } catch (e) { return; } // a tab that can't be built is just not searchable
        scanPanel(panel).forEach(function (e) {
          index.push({ tab: tab.id, tabLabel: tab.label, group: e.group, label: e.label, key: e.key, nth: e.nth, isGroup: e.isGroup });
        });
      });
      indexed = true;
    }

    function show (on) {
      active = on;
      panels.style.display = on ? 'none' : '';
      results.hidden = !on;
      results.style.display = on ? '' : 'none';
    }

    function render (q) {
      results.innerHTML = '';
      hits = index.filter(function (e) { return match(q, e.tabLabel + ' ' + e.group + ' ' + e.label); }).slice(0, 80);
      if (!hits.length) {
        results.appendChild(h('p', { className: 'note', textContent: 'No settings match “' + q.trim() + '”.' }));
        return;
      }
      const list = h('div', { className: 'dlg-hits', role: 'listbox' });
      hits.forEach(function (e) {
        const path = [e.tabLabel].concat(e.group ? [e.group] : []).concat(e.label ? [e.label] : []);
        const b = h('button', { type: 'button', className: 'dlg-hit', role: 'option' }, [
          h('span', { className: 'dlg-hit-path', textContent: path.slice(0, -1).join(' › ') + (path.length > 1 ? ' › ' : '') }),
          h('span', { className: 'dlg-hit-label', textContent: path[path.length - 1] })
        ]);
        b.addEventListener('click', function () { go(e); });
        b.addEventListener('keydown', function (ev) {
          const sibs = Array.prototype.slice.call(list.children);
          const i = sibs.indexOf(b);
          if (ev.key === 'ArrowDown' && sibs[i + 1]) { ev.preventDefault(); sibs[i + 1].focus(); }
          if (ev.key === 'ArrowUp') { ev.preventDefault(); (sibs[i - 1] || input).focus(); }
          if (ev.key === 'Escape') { ev.preventDefault(); close(true); input.focus(); }
        });
        list.appendChild(b);
      });
      results.appendChild(list);
    }

    function go (e) {
      input.value = '';
      show(false);
      indexed = false;
      options.openTab(e.tab);
      const live = scanPanel(panels).filter(function (x) { return x.key === e.key && x.nth === e.nth; })[0];
      if (!live || !live.el) { panels.scrollTop = 0; return; }
      if (live.el.scrollIntoView) live.el.scrollIntoView({ block: 'center' });
      live.el.classList.add('is-found');
      setTimeout(function () { live.el.classList.remove('is-found'); }, 1200);
    }

    function close (reopen) {
      input.value = '';
      if (!active) return;
      show(false);
      if (reopen && indexed && origin != null) options.openTab(origin);
      indexed = false;
    }

    input.addEventListener('focus', function () { if (!active) origin = openTabId(); });
    input.addEventListener('input', function () {
      const q = input.value;
      if (q.trim().length < 2) { if (active) { close(true); input.value = q; } return; }
      if (!active) { origin = openTabId(); show(true); }
      if (!indexed) buildIndex();
      render(q);
    });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && (input.value || active)) { ev.preventDefault(); close(true); }
      else if (ev.key === 'Enter' && active && hits.length) { ev.preventDefault(); go(hits[0]); }
      else if (ev.key === 'ArrowDown' && active && results.querySelector('.dlg-hit')) { ev.preventDefault(); results.querySelector('.dlg-hit').focus(); }
    });
    return { input: input, close: close, refresh: function () { indexed = false; } };
  }

  root.ExtDialog = {
    h: h, P: P, group: group, help: help, wrapRows: wrapRows, escapeHtml: escapeHtml,
    readAsDataUrl: readAsDataUrl, blobToIconDataUrl: blobToIconDataUrl, setStatus: setStatus,
    baseUrl: baseUrl, copyText: copyText, download: download, getAt: getAt, setAt: setAt, delAt: delAt,
    WEIGHTS: WEIGHTS, UNIT_SIGNS: UNIT_SIGNS,
    kit: kit,
    history: history, footerTools: footerTools, search: search,
    _match: match, _scanPanel: scanPanel, _undoKey: undoKey, _inTextField: inTextField
  };
})(typeof window !== 'undefined' ? window : globalThis);
