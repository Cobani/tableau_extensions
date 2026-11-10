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

  root.ExtDialog = {
    h: h, P: P, group: group, help: help, wrapRows: wrapRows, escapeHtml: escapeHtml,
    readAsDataUrl: readAsDataUrl, blobToIconDataUrl: blobToIconDataUrl, setStatus: setStatus,
    baseUrl: baseUrl, copyText: copyText, download: download, getAt: getAt, setAt: setAt, delAt: delAt,
    WEIGHTS: WEIGHTS, UNIT_SIGNS: UNIT_SIGNS,
    kit: kit
  };
})(typeof window !== 'undefined' ? window : globalThis);
