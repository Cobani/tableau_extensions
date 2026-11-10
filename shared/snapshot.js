'use strict';

/**
 * ExtSnapshot — turns what an extension has drawn into a picture file (PNG, or SVG where possible).
 *
 * Plain browser JavaScript, no dependencies. Loaded after core.js by the page that offers
 * "Save as picture". Nothing here knows about a particular chart: pass the element to capture
 * (usually #card). Every function is async or returns a value; none throws synchronously, and a
 * rejected promise always carries an Error with a plain-English message.
 *
 *   png(element, options)      → Promise<Blob>              the element as rendered, as a PNG
 *   svg(element, options)      → Promise<{ text, kind }>    a standalone SVG document
 *   download(blobOrText, fileName, mime) → boolean          starts a download (works in a Tableau frame)
 *   fileName(title, ext)       → 'Sales by store 2026-11-10.png'   safe name from title + local date
 *   save(element, { format: 'png' | 'svg', title, scale, background, full, vector, padding, maxPixels })
 *                              → Promise<boolean>           render + download (false = download blocked)
 *   menuItems({ element, title, vector, background, full, onError })
 *                              → [{ id: 'png', label: 'Picture (PNG)', run }, { id: 'svg', label: 'Vector (SVG)', run }]
 *                                plain data for an EXISTING export menu to append; svg only when `vector` is given;
 *                                run() returns the promise of save(). element / title / vector may be functions.
 *   button({ host, element, title, vector, background, full, position, onError })
 *                              → { el, refresh(), destroy() }   a "Save as picture" icon button in the top-right of
 *                                `host` (shown on hover / keyboard focus). One item: saves the PNG; with `vector`:
 *                                opens a PNG / SVG menu. Styles are injected from here (<style id="ext-snapshot-style">).
 *   _                          pure helpers, for tests/snapshot.test.js
 *
 * How an extension uses it (title/vector/element may be functions, read at click time):
 *   // 1. No export button yet (kpi-card, waterfall, data-lineage ...):
 *   ExtSnapshot.button({ host: card, element: card, title: function () { return worksheetName; } });
 *   // with an SVG chart, also offer a vector file:
 *   ExtSnapshot.button({ host: card, element: card, title: name, vector: function () { return card.querySelector('svg'); } });
 *   // 2. An export menu exists (bar-chart, line-chart, matrix-table export.js): append to its list
 *   items = items.concat(ExtSnapshot.menuItems({ element: card, title: name, vector: svgFn }));   // each: { id, label, run }
 *
 * png options: scale (default 2; pixels = CSS size × scale), background (CSS colour under the element;
 * default = first non-transparent background found walking up, else white; 'transparent' = none),
 * padding (px, default 0), maxPixels (default 16e6; scale is reduced to stay under it), full (default
 * false: a scrolling element is captured as seen; true: its whole scrollable content).
 *
 * svg: if the element IS an <svg>, or options.vector is an <svg> element, that SVG is returned with
 * its computed styles written into attributes (opens in PowerPoint, Illustrator, Figma) → kind 'vector'.
 * Otherwise the same document used for the PNG is returned → kind 'html'.
 *
 * How the PNG is made: the element is cloned with every computed style written inline, images and CSS
 * background images turned into data URLs, canvases into images, the web fonts in use embedded as data
 * URLs; the clone goes into an SVG <foreignObject>, that SVG is loaded as an image (from a data: URL —
 * a blob: URL would taint the canvas) and drawn on a canvas.
 *
 * Left out of the picture: data-snapshot="skip", .tooltip, #tooltip, #menu, #ext-error-badge, #ext-error-panel, #ext-row-notice,
 * and anything hidden / display:none.
 *
 * Known limits:
 *  - Cross-origin images and fonts are skipped (they would taint the canvas): they show blank / fall back.
 *    Web fonts must come from the same origin as the page (shared/fonts/ does).
 *  - kind 'html' SVG only renders in browsers (it contains HTML); PowerPoint/Illustrator/Figma won't show it.
 *  - Vector SVG refers to fonts by name only: a machine without Lato falls back to another font.
 *  - A scrolled container is reproduced with an absolutely positioned wrapper: unusual layouts
 *    (grid items placed by the container) may shift slightly. Video, iframe and object are left out.
 *  - Very large pictures are limited by maxPixels and by the browser's canvas size (16384 px a side).
 */
(function (root) {
  const XHTML = 'http://www.w3.org/1999/xhtml';
  const SVGNS = 'http://www.w3.org/2000/svg';
  const DEFAULT_MAX_PIXELS = 16e6;
  const MAX_SIDE = 16384;
  const MAX_NAME = 80;
  const SKIP_IDS = ['ext-error-badge', 'ext-error-panel', 'ext-row-notice'];
  const DROP_TAGS = ['script', 'noscript', 'style', 'link', 'template', 'meta', 'iframe', 'video', 'audio', 'object', 'embed'];
  // SVG containers that are never drawn themselves: copied as they are.
  const SVG_RAW = ['defs', 'clippath', 'mask', 'marker', 'pattern', 'lineargradient', 'radialgradient', 'symbol', 'filter', 'title', 'desc', 'metadata'];
  const URL_PROPS = ['background-image', 'mask-image', '-webkit-mask-image', 'border-image-source', 'list-style-image'];
  const WRAP_PROPS = ['flex-direction', 'flex-wrap', 'justify-content', 'align-items', 'align-content', 'gap', 'grid-template-columns', 'grid-template-rows', 'grid-auto-flow', 'text-align'];

  // ---------------------------------------------------------------------------
  // Pure helpers (no DOM)
  // ---------------------------------------------------------------------------
  /** Scale to use so that width × height × scale² stays under maxPixels and each side under 16384. */
  function limitScale (w, h, scale, maxPixels) {
    let s = Number(scale);
    if (!(s > 0)) s = 2;
    const cap = Number(maxPixels) > 0 ? Number(maxPixels) : DEFAULT_MAX_PIXELS;
    const W = Math.max(1, Number(w) || 1);
    const H = Math.max(1, Number(h) || 1);
    let limited = false;
    if (W * s * H * s > cap) { s = Math.sqrt(cap / (W * H)); limited = true; }
    if (Math.max(W, H) * s > MAX_SIDE) { s = MAX_SIDE / Math.max(W, H); limited = true; }
    if (limited) s = Math.floor(s * 1000) / 1000;
    return Math.max(s, 0.01);
  }

  /** A title made safe for a file name: no path / reserved characters, no leading dots, at most 80 characters; '' gives 'chart'. */
  function cleanFileName (title) {
    let s = String(title == null ? '' : title).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    s = s.replace(/^[.\s]+/, '');
    if (s.length > MAX_NAME) s = s.slice(0, MAX_NAME).replace(/[\ud800-\udbff]$/, '');
    s = s.replace(/[.\s]+$/, '');
    if (!s) return 'chart';
    if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
    return s;
  }

  function pad2 (n) { return (n < 10 ? '0' : '') + n; }

  /** 'Sales by store 2026-11-10.png' (local date; `date` is only for tests). */
  function fileName (title, ext, date) {
    const d = date && typeof date.getFullYear === 'function' ? date : new Date();
    const stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    const e = String(ext == null ? 'png' : ext).replace(/^\./, '').replace(/[^a-z0-9]/gi, '') || 'png';
    return cleanFileName(title) + ' ' + stamp + '.' + e;
  }

  const URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)/gi;

  /** Every url(...) target in a CSS value, in order, without quotes. */
  function cssUrls (value) {
    const out = [];
    String(value == null ? '' : value).replace(URL_RE, function (m, a, b, c) {
      out.push(a != null ? a : (b != null ? b : (c || '')));
      return m;
    });
    return out;
  }

  /** Rewrites each url(...) of a CSS value; map(url) returns the new target, or null/undefined to keep it. Output uses url("…"). */
  function replaceCssUrls (value, map) {
    return String(value == null ? '' : value).replace(URL_RE, function (m, a, b, c) {
      const u = a != null ? a : (b != null ? b : (c || ''));
      const r = map(u);
      return r == null ? m : 'url("' + String(r).replace(/"/g, '%22') + '")';
    });
  }

  function dataUrl (mime, base64) { return 'data:' + (mime || 'application/octet-stream') + ';base64,' + base64; }

  /** fill: url("http://host/page.html#grad") becomes url("#grad") when the target is the page itself. */
  function localizeFragmentUrls (value, pageUrl) {
    const base = String(pageUrl || '').split('#')[0];
    if (!base || String(value).indexOf('url(') < 0) return value;
    return replaceCssUrls(value, function (u) {
      const i = u.indexOf('#');
      return i > 0 && u.slice(0, i) === base ? u.slice(i) : null;
    });
  }

  /** True for '', 'transparent' and rgba(..., 0). */
  function isTransparentColor (c) {
    const s = String(c == null ? '' : c).trim().toLowerCase();
    if (!s || s === 'transparent') return true;
    const m = /^rgba?\(([^)]*)\)$/.exec(s);
    if (!m) return false;
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    return parts.length >= 4 && Number(parts[3]) === 0;
  }

  /** 'Lato', "Segoe UI", sans-serif gives ['lato', 'segoe ui', 'sans-serif'] */
  function splitFamilies (value) {
    return String(value == null ? '' : value).split(',').map(function (f) {
      return f.trim().replace(/^["']|["']$/g, '').toLowerCase();
    }).filter(Boolean);
  }

  function weightRange (w) {
    const s = String(w == null ? '' : w).trim().toLowerCase();
    if (!s || s === 'normal') return [400, 400];
    if (s === 'bold') return [700, 700];
    const n = s.split(/\s+/).map(Number).filter(function (x) { return x === x; });
    if (!n.length) return [400, 400];
    return [n[0], n[n.length - 1]];
  }

  function styleKey (s) { return /italic|oblique/i.test(String(s || '')) ? 'italic' : 'normal'; }

  /** Does an @font-face rule ({ weight, style }) cover a used { weight, style }? */
  function fontRuleMatches (rule, used) {
    if (styleKey(rule.style) !== styleKey(used.style)) return false;
    const r = weightRange(rule.weight);
    const u = weightRange(used.weight)[0];
    return u >= r[0] && u <= r[1];
  }

  function fontMime (url) {
    const m = /\.(woff2|woff|ttf|otf)(?:[?#]|$)/i.exec(String(url || ''));
    const e = m ? m[1].toLowerCase() : '';
    return { woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf' }[e] || 'application/octet-stream';
  }

  function stripInvalidXml (s) { return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, ''); }

  function escText (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escAttr (s) { return escText(s).replace(/"/g, '&quot;'); }

  function toError (e, what) {
    if (e instanceof Error) return e;
    return new Error(what + ': ' + (e && e.message ? e.message : String(e)));
  }

  // ---------------------------------------------------------------------------
  // Browser helpers
  // ---------------------------------------------------------------------------
  function resolveElement (element, what) {
    const el = typeof element === 'string' ? document.getElementById(element) : element;
    if (!el || el.nodeType !== 1 || typeof el.getBoundingClientRect !== 'function') {
      throw new Error('ExtSnapshot.' + what + ': no element to capture (pass the chart element).');
    }
    return el;
  }

  function sameOrigin (url) {
    try {
      const u = new URL(url, document.baseURI);
      return u.protocol === 'data:' || u.protocol === 'blob:' || u.origin === location.origin;
    } catch (e) { return false; }
  }

  function absUrl (url, base) {
    try { return new URL(url, base || document.baseURI).href; } catch (e) { return url; }
  }

  /** Fetches a same-origin URL and returns it as a data: URL (cached per job). */
  function toDataUrl (url, cache, mimeHint) {
    if (/^data:/i.test(url)) return Promise.resolve(url);
    if (cache[url]) return cache[url];
    cache[url] = fetch(url, { credentials: 'same-origin' }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      return new Promise(function (resolve, reject) {
        const fr = new FileReader();
        fr.onload = function () { resolve(String(fr.result)); };
        fr.onerror = function () { reject(fr.error || new Error('read failed')); };
        fr.readAsDataURL(blob);
      });
    }).then(function (d) {
      return mimeHint && /^data:(application\/octet-stream)?;/i.test(d) ? d.replace(/^data:[^;]*;/, 'data:' + mimeHint + ';') : d;
    });
    return cache[url];
  }

  function delay (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function loadImage (url) {
    return new Promise(function (resolve, reject) {
      const img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('The browser could not draw the picture (the content may be too large or use something it cannot render).')); };
      img.src = url;
    });
  }

  /** First non-transparent computed background from the element upwards, else white. */
  function findBackground (el) {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const c = getComputedStyle(n).backgroundColor;
      if (!isTransparentColor(c)) return c;
    }
    return '#ffffff';
  }

  function isSkipped (el) {
    const a = el.getAttribute && el.getAttribute('data-snapshot');
    if (a === 'skip' || SKIP_IDS.indexOf(el.id) >= 0) return true;
    // Hover-only UI must never leak into a picture: this is the ONE place the skip list lives.
    if (el.id === 'tooltip' || el.id === 'menu') return true;
    const cl = el.classList;
    return !!(cl && cl.contains('tooltip'));
  }

  /** Computed style of a bare element of this kind, from a clean iframe (so only differences get written). */
  function defaultsFor (ctx, el) {
    const key = el.namespaceURI + ' ' + el.localName;
    if (ctx.defaults[key]) return ctx.defaults[key];
    const out = {};
    if (ctx.doc) {
      try {
        const e = el.namespaceURI === XHTML ? ctx.doc.createElement(el.localName) : ctx.doc.createElementNS(el.namespaceURI, el.localName);
        ctx.doc.body.appendChild(e);
        const cs = ctx.win.getComputedStyle(e);
        for (let i = 0; i < cs.length; i++) out[cs[i]] = cs.getPropertyValue(cs[i]);
        e.remove();
      } catch (err) { /* then every property is written */ }
    }
    ctx.defaults[key] = out;
    return out;
  }

  /** Inline style text: every property that differs from the default or from the parent's value. */
  function styleText (cs, def, pcs, ctx) {
    let out = '';
    for (let i = 0; i < cs.length; i++) {
      const n = cs[i];
      let v = cs.getPropertyValue(n);
      if (v === '') continue;
      if (def[n] === v && (!pcs || pcs.getPropertyValue(n) === v)) continue;
      if (v.indexOf('url(') >= 0 && v.indexOf('#') >= 0) v = localizeFragmentUrls(v, ctx.page);
      out += n + ':' + v + ';';
    }
    return out;
  }

  function noteFont (ctx, cs) {
    splitFamilies(cs.fontFamily).forEach(function (f) { ctx.used.push({ family: f, weight: cs.fontWeight, style: cs.fontStyle }); });
  }

  function inlineImgSrc (ctx, clone, src) {
    const u = src.currentSrc || src.src;
    if (!u || /^data:/i.test(u) || !sameOrigin(u)) return;
    ctx.tasks.push(toDataUrl(u, ctx.cache).then(function (d) {
      clone.setAttribute('src', d);
      clone.removeAttribute('srcset');
    }).catch(function () {}));
  }

  function inlineSvgImage (ctx, clone, src) {
    const raw = src.getAttribute('href') || src.getAttribute('xlink:href');
    if (!raw || /^data:/i.test(raw)) return;
    const u = absUrl(raw);
    if (!sameOrigin(u)) return;
    ctx.tasks.push(toDataUrl(u, ctx.cache).then(function (d) {
      clone.removeAttribute('xlink:href');
      clone.setAttribute('href', d);
    }).catch(function () {}));
  }

  function inlineCssUrls (ctx, clone, cs) {
    URL_PROPS.forEach(function (p) {
      const v = cs.getPropertyValue(p);
      if (!v || v.indexOf('url(') < 0) return;
      const urls = cssUrls(v).filter(function (u) { return u && !/^data:/i.test(u) && u.charAt(0) !== '#' && sameOrigin(u); });
      if (!urls.length) return;
      const map = {};
      ctx.tasks.push(Promise.all(urls.map(function (u) {
        return toDataUrl(u, ctx.cache).then(function (d) { map[u] = d; }).catch(function () {});
      })).then(function () {
        clone.style.setProperty(p, replaceCssUrls(v, function (u) { return map[u] || null; }));
      }));
    });
  }

  function pseudoNode (src, which, cs, ctx) {
    let pcs;
    try { pcs = getComputedStyle(src, which); } catch (e) { return null; }
    const c = pcs.content;
    if (!c || c === 'none' || c === 'normal' || pcs.display === 'none') return null;
    if (!(/^"([^"\\]|\\.)*"$/.test(c) || /^'([^'\\]|\\.)*'$/.test(c))) return null;
    const text = c.slice(1, -1).replace(/\\([0-9a-f]{1,6})\s?/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); }).replace(/\\(.)/g, '$1');
    const span = src.ownerDocument.createElement('span');
    span.setAttribute('style', styleText(pcs, defaultsFor(ctx, { namespaceURI: XHTML, localName: 'span' }), cs, ctx));
    if (text) span.appendChild(src.ownerDocument.createTextNode(text));
    return span;
  }

  /** Clones `src` with computed styles inline. Returns null for anything that must not appear. */
  function cloneTree (src, ctx, parentCs, isRoot) {
    if (src.nodeType === 3 || src.nodeType === 4) return src.cloneNode(false);
    if (src.nodeType !== 1) return null;
    const tag = String(src.localName || '').toLowerCase();
    if (!isRoot) {
      if (isSkipped(src)) return null;
      if (DROP_TAGS.indexOf(tag) >= 0) return null;
      if (src.namespaceURI === SVGNS && SVG_RAW.indexOf(tag) >= 0) return src.cloneNode(true);
    }
    const cs = getComputedStyle(src);
    if (cs.display === 'none') return null;
    noteFont(ctx, cs);

    let clone;
    if (tag === 'canvas') {
      clone = src.ownerDocument.createElement('img');
      try { clone.setAttribute('src', src.toDataURL('image/png')); } catch (e) { /* tainted: stays empty */ }
      if (src.width) clone.setAttribute('width', String(src.width));
      if (src.height) clone.setAttribute('height', String(src.height));
    } else {
      clone = src.cloneNode(false);
      clone.removeAttribute('class');
      clone.removeAttribute('style');
      Array.from(clone.attributes).forEach(function (a) { if (/^on/i.test(a.name)) clone.removeAttribute(a.name); });
    }
    const def = defaultsFor(ctx, tag === 'canvas' ? { namespaceURI: XHTML, localName: 'img' } : src);
    clone.setAttribute('style', styleText(cs, def, parentCs, ctx));
    inlineCssUrls(ctx, clone, cs);

    if (tag === 'img') inlineImgSrc(ctx, clone, src);
    else if (tag === 'image' && src.namespaceURI === SVGNS) inlineSvgImage(ctx, clone, src);
    else if (tag === 'input') {
      clone.setAttribute('value', src.value);
      if (src.checked) clone.setAttribute('checked', 'checked'); else clone.removeAttribute('checked');
    } else if (tag === 'textarea') clone.textContent = src.value;
    else if (tag === 'option' && src.selected) clone.setAttribute('selected', 'selected');

    if (tag === 'canvas' || tag === 'img' || tag === 'input' || tag === 'textarea') return clone;

    const kids = [];
    const html = src.namespaceURI === XHTML;
    if (html) { const b = pseudoNode(src, '::before', cs, ctx); if (b) kids.push(b); }
    for (let n = src.firstChild; n; n = n.nextSibling) {
      const c = cloneTree(n, ctx, cs, false);
      if (c) kids.push(c);
    }
    if (html) { const a = pseudoNode(src, '::after', cs, ctx); if (a) kids.push(a); }

    // A static picture must not show scrollbars.
    if (/^(auto|scroll)$/.test(cs.overflowX) || /^(auto|scroll)$/.test(cs.overflowY)) clone.style.setProperty('overflow', 'hidden');
    const sl = src.scrollLeft || 0;
    const st = src.scrollTop || 0;
    if (html && (sl || st) && !(isRoot && ctx.full)) {
      // Reproduce the scroll offset: the content moves inside a clipped box.
      const wrap = src.ownerDocument.createElement('div');
      const disp = /flex/.test(cs.display) ? 'flex' : (/grid/.test(cs.display) ? 'grid' : 'block');
      let w = 'position:absolute;left:0;top:0;box-sizing:border-box;width:' + src.scrollWidth + 'px;height:' + src.scrollHeight + 'px;display:' + disp +
        ';padding:' + cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft + ';transform:translate(' + (-sl) + 'px,' + (-st) + 'px);';
      WRAP_PROPS.forEach(function (p) { const v = cs.getPropertyValue(p); if (v) w += p + ':' + v + ';'; });
      wrap.setAttribute('style', w);
      kids.forEach(function (k) { wrap.appendChild(k); });
      clone.style.setProperty('overflow', 'hidden');
      if (cs.position === 'static') clone.style.setProperty('position', 'relative');
      clone.appendChild(wrap);
    } else {
      kids.forEach(function (k) { clone.appendChild(k); });
    }
    return clone;
  }

  /** @font-face rules for the fonts in use, with same-origin files embedded as data URLs. */
  async function collectFontCss (used, cache) {
    if (!used.length || !document.styleSheets) return '';
    const families = {};
    used.forEach(function (u) { families[u.family] = true; });
    const found = [];
    const walk = function (holder, base, depth) {
      let list;
      try { list = holder.cssRules; } catch (e) { return; }
      if (!list || depth > 6) return;
      Array.from(list).forEach(function (r) {
        if (r.type === 5) found.push({ rule: r, base: base });
        else if (r.type === 3 && r.styleSheet) walk(r.styleSheet, r.styleSheet.href || base, depth + 1);
        else if (r.cssRules) walk(r, base, depth + 1);
      });
    };
    Array.from(document.styleSheets).forEach(function (s) { walk(s, s.href || document.baseURI, 0); });

    const famOf = function (f) { return splitFamilies(f.rule.style.getPropertyValue('font-family'))[0]; };
    const byFamily = found.filter(function (f) { const fam = famOf(f); return fam && families[fam]; });
    const matched = byFamily.filter(function (f) {
      const r = { weight: f.rule.style.getPropertyValue('font-weight'), style: f.rule.style.getPropertyValue('font-style') };
      return used.some(function (u) { return u.family === famOf(f) && fontRuleMatches(r, u); });
    });
    const chosen = matched.length ? matched : byFamily;

    const out = await Promise.all(chosen.map(async function (f) {
      const st = f.rule.style;
      const parts = st.getPropertyValue('src').match(/url\(\s*(?:"[^"]*"|'[^']*'|[^)\s]*)\s*\)(?:\s*format\([^)]*\))?/g) || [];
      const ok = [];
      for (const p of parts) {
        const u = absUrl(cssUrls(p)[0] || '', f.base);
        if (!u || !sameOrigin(u)) continue;
        try {
          const d = await toDataUrl(u, cache, fontMime(u));
          ok.push(p.replace(/url\(\s*(?:"[^"]*"|'[^']*'|[^)\s]*)\s*\)/, 'url("' + d + '")'));
        } catch (e) { /* skip this file */ }
      }
      if (!ok.length) return '';
      let css = '@font-face{font-family:' + st.getPropertyValue('font-family') + ';';
      ['font-style', 'font-weight', 'font-stretch', 'unicode-range'].forEach(function (p) {
        const v = st.getPropertyValue(p);
        if (v) css += p + ':' + v + ';';
      });
      return css + 'src:' + ok.join(',') + ';}';
    }));
    return out.filter(Boolean).join('\n');
  }

  function measure (el, full) {
    const r = el.getBoundingClientRect();
    const fit = function (x) { return Math.max(0, Math.ceil(x - 0.01)); };
    let w = fit(r.width);
    let h = fit(r.height);
    if (full && el.scrollHeight) {
      const cs = getComputedStyle(el);
      const bx = (parseFloat(cs.borderLeftWidth) || 0) + (parseFloat(cs.borderRightWidth) || 0);
      const by = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      w = Math.max(w, fit(el.scrollWidth + bx));
      h = Math.max(h, fit(el.scrollHeight + by));
    }
    return { w: w, h: h };
  }

  function buildDocument (w, h, pad, inner, fontCss, bg) {
    const W = w + 2 * pad;
    const H = h + 2 * pad;
    return '<svg xmlns="' + SVGNS + '" width="' + W + '" height="' + H + '" viewBox="0 0 ' + W + ' ' + H + '">' +
      (fontCss ? '<style>' + escText(fontCss) + '</style>' : '') +
      (bg ? '<rect width="100%" height="100%" fill="' + escAttr(bg) + '"/>' : '') +
      '<foreignObject x="' + pad + '" y="' + pad + '" width="' + w + '" height="' + h + '">' + inner + '</foreignObject></svg>';
  }

  /** The foreignObject SVG text for an element (shared by png() and svg() kind 'html'). */
  async function renderHtml (el, o, bg) {
    const full = o.full === true;
    const pad = Math.max(0, Math.round(Number(o.padding) || 0));
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* ignore */ }
    const size = measure(el, full);
    if (!size.w || !size.h) throw new Error('Nothing to capture: the element has no size (is it hidden?).');

    const ctx = { used: [], tasks: [], cache: {}, defaults: {}, full: full, page: String(location.href || ''), doc: null, win: null };
    let frame = null;
    try {
      frame = document.createElement('iframe');
      frame.setAttribute('aria-hidden', 'true');
      frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1000px;height:1000px;border:0;visibility:hidden;pointer-events:none';
      document.body.appendChild(frame);
      ctx.doc = frame.contentDocument;
      ctx.win = frame.contentWindow;
      if (!ctx.doc || !ctx.doc.body) ctx.doc = null;
    } catch (e) { ctx.doc = null; }

    try {
      const clone = cloneTree(el, ctx, null, true);
      if (!clone) throw new Error('Nothing to capture.');
      const cs = getComputedStyle(el);
      const st = clone.style;
      st.setProperty('margin', '0');
      st.setProperty('box-sizing', 'border-box');
      st.setProperty('width', size.w + 'px');
      st.setProperty('height', size.h + 'px');
      st.setProperty('transform', 'none');
      st.setProperty('translate', 'none');
      st.setProperty('float', 'none');
      st.setProperty('position', cs.position === 'static' ? 'static' : 'relative');
      if (cs.position !== 'static') { st.setProperty('left', '0'); st.setProperty('top', '0'); st.setProperty('right', 'auto'); st.setProperty('bottom', 'auto'); }
      if (full) { st.setProperty('overflow', 'visible'); st.setProperty('max-height', 'none'); st.setProperty('max-width', 'none'); }
      await Promise.all(ctx.tasks);
      const fontCss = await collectFontCss(ctx.used, ctx.cache);
      let inner = new XMLSerializer().serializeToString(clone);
      if (clone.namespaceURI === XHTML && !/^<[^>]*\sxmlns=/.test(inner)) inner = inner.replace(/^<([^\s>/]+)/, '<$1 xmlns="' + XHTML + '"');
      const text = stripInvalidXml(buildDocument(size.w, size.h, pad, inner, fontCss, bg));
      return { text: text, width: size.w, height: size.h, pad: pad };
    } finally {
      if (frame && frame.parentNode) frame.parentNode.removeChild(frame);
    }
  }

  // ---------------------------------------------------------------------------
  // PNG
  // ---------------------------------------------------------------------------
  async function pngImpl (element, options) {
    const o = options || {};
    const el = resolveElement(element, 'png');
    const job = await renderHtml(el, o, null);
    const W = job.width + 2 * job.pad;
    const H = job.height + 2 * job.pad;
    const scale = limitScale(W, H, o.scale == null ? 2 : o.scale, o.maxPixels);
    const cw = Math.max(1, Math.round(W * scale));
    const ch = Math.max(1, Math.round(H * scale));
    const bg = o.background == null || o.background === '' ? findBackground(el) : o.background;
    const img = await loadImage('data:image/svg+xml;charset=utf-8,' + encodeURIComponent(job.text));
    try { if (img.decode) await img.decode(); } catch (e) { /* ignore */ }

    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const g = canvas.getContext('2d');
    const paint = function () {
      g.clearRect(0, 0, cw, ch);
      if (bg && bg !== 'transparent' && bg !== 'none') { g.fillStyle = bg; g.fillRect(0, 0, cw, ch); }
      g.drawImage(img, 0, 0, cw, ch);
    };
    paint();
    await delay(40); // fonts / images inside the SVG may finish after load: draw again
    paint();
    return new Promise(function (resolve, reject) {
      try {
        canvas.toBlob(function (b) { if (b) resolve(b); else reject(new Error('The browser could not create the PNG file (the picture may be too large).')); }, 'image/png');
      } catch (e) { reject(new Error('The browser could not create the PNG file: ' + (e && e.message ? e.message : e))); }
    });
  }

  function png (element, options) {
    return pngImpl(element, options).catch(function (e) { throw toError(e, 'ExtSnapshot.png'); });
  }

  // ---------------------------------------------------------------------------
  // SVG
  // ---------------------------------------------------------------------------
  const PAINT_TAGS = ['path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon', 'text', 'tspan', 'textpath', 'use'];
  const TEXT_TAGS = ['text', 'tspan', 'textpath'];

  function pxless (v) { return String(v).replace(/(-?\d*\.?\d+)px/g, '$1'); }

  function setAttr (clone, name, value, skipIf) {
    if (value == null || value === '' || value === skipIf) return;
    clone.setAttribute(name, value);
  }

  /** Clone of an SVG subtree with the computed presentation styles written as attributes. */
  function cloneVector (src, ctx, isRoot) {
    if (src.nodeType === 3 || src.nodeType === 4) return src.cloneNode(false);
    if (src.nodeType !== 1) return null;
    const tag = String(src.localName || '').toLowerCase();
    if (!isRoot) {
      if (isSkipped(src) || tag === 'style' || tag === 'script') return null;
      if (SVG_RAW.indexOf(tag) >= 0) return src.cloneNode(true);
    }
    const cs = getComputedStyle(src);
    if (cs.display === 'none' && !isRoot) return null;
    const clone = src.cloneNode(false);
    clone.removeAttribute('class');
    if (!isRoot) {
      setAttr(clone, 'opacity', cs.opacity, '1');
      if (cs.visibility === 'hidden') clone.setAttribute('visibility', 'hidden');
      if (PAINT_TAGS.indexOf(tag) >= 0) {
        const stroke = localizeFragmentUrls(cs.stroke, ctx.page);
        setAttr(clone, 'fill', localizeFragmentUrls(cs.fill, ctx.page));
        setAttr(clone, 'fill-opacity', cs.fillOpacity, '1');
        setAttr(clone, 'fill-rule', cs.fillRule, 'nonzero');
        setAttr(clone, 'stroke', stroke);
        if (stroke && stroke !== 'none') {
          setAttr(clone, 'stroke-width', pxless(cs.strokeWidth));
          setAttr(clone, 'stroke-opacity', cs.strokeOpacity, '1');
          setAttr(clone, 'stroke-dasharray', pxless(cs.strokeDasharray), 'none');
          setAttr(clone, 'stroke-dashoffset', pxless(cs.strokeDashoffset), '0');
          setAttr(clone, 'stroke-linecap', cs.strokeLinecap, 'butt');
          setAttr(clone, 'stroke-linejoin', cs.strokeLinejoin, 'miter');
          setAttr(clone, 'stroke-miterlimit', cs.strokeMiterlimit, '4');
        }
      }
      if (TEXT_TAGS.indexOf(tag) >= 0) {
        setAttr(clone, 'font-family', cs.fontFamily);
        setAttr(clone, 'font-size', pxless(cs.fontSize));
        setAttr(clone, 'font-weight', cs.fontWeight);
        setAttr(clone, 'font-style', cs.fontStyle, 'normal');
        setAttr(clone, 'text-anchor', cs.textAnchor, 'start');
        setAttr(clone, 'dominant-baseline', cs.dominantBaseline, 'auto');
        setAttr(clone, 'letter-spacing', pxless(cs.letterSpacing), 'normal');
        const dec = cs.textDecorationLine;
        if (dec && dec !== 'none') clone.setAttribute('text-decoration', dec);
      }
      // A transform that comes from CSS (not from an attribute) would be lost otherwise.
      if (cs.transform && cs.transform !== 'none' && !src.hasAttribute('transform')) clone.setAttribute('transform', cs.transform);
      if (tag === 'image') inlineSvgImage(ctx, clone, src);
    }
    if (tag === 'foreignobject') {
      for (let n = src.firstChild; n; n = n.nextSibling) clone.appendChild(n.cloneNode(true));
      return clone;
    }
    for (let n = src.firstChild; n; n = n.nextSibling) {
      const c = cloneVector(n, ctx, false);
      if (c) clone.appendChild(c);
    }
    return clone;
  }

  function isSvgElement (n) {
    return !!n && n.nodeType === 1 && n.namespaceURI === SVGNS && String(n.localName).toLowerCase() === 'svg';
  }

  async function svgImpl (element, options) {
    const o = options || {};
    const el = resolveElement(element, 'svg');
    const target = isSvgElement(o.vector) ? o.vector : (isSvgElement(el) ? el : null);
    const bg = o.background && o.background !== 'transparent' && o.background !== 'none' ? o.background : null;
    if (!target) {
      const job = await renderHtml(el, o, bg);
      return { text: '<?xml version="1.0" encoding="UTF-8"?>\n' + job.text, kind: 'html' };
    }
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) { /* ignore */ }
    const r = target.getBoundingClientRect();
    const w = Math.max(1, Math.ceil(r.width - 0.01));
    const h = Math.max(1, Math.ceil(r.height - 0.01));
    const ctx = { tasks: [], cache: {}, page: String(location.href || '') };
    const clone = cloneVector(target, ctx, true);
    await Promise.all(ctx.tasks);
    clone.removeAttribute('style');
    clone.setAttribute('xmlns', SVGNS);
    clone.setAttribute('width', String(w));
    clone.setAttribute('height', String(h));
    if (!clone.getAttribute('viewBox')) clone.setAttribute('viewBox', '0 0 ' + w + ' ' + h);
    if (bg) {
      const rect = target.ownerDocument.createElementNS(SVGNS, 'rect');
      const vb = clone.getAttribute('viewBox').split(/[\s,]+/).map(Number);
      rect.setAttribute('x', String(vb[0] || 0));
      rect.setAttribute('y', String(vb[1] || 0));
      rect.setAttribute('width', String(vb[2] || w));
      rect.setAttribute('height', String(vb[3] || h));
      rect.setAttribute('fill', bg);
      clone.insertBefore(rect, clone.firstChild);
    }
    const text = stripInvalidXml(new XMLSerializer().serializeToString(clone));
    return { text: '<?xml version="1.0" encoding="UTF-8"?>\n' + text, kind: 'vector' };
  }

  function svg (element, options) {
    return svgImpl(element, options).catch(function (e) { throw toError(e, 'ExtSnapshot.svg'); });
  }

  // ---------------------------------------------------------------------------
  // Download and save
  // ---------------------------------------------------------------------------
  /** Starts a download from inside a Tableau extension frame (same technique as bar-chart/export.js). */
  function download (data, name, mime) {
    try {
      const blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'text/plain;charset=utf-8' });
      if (window.navigator && window.navigator.msSaveOrOpenBlob) { window.navigator.msSaveOrOpenBlob(blob, name); return true; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.rel = 'noopener';
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 4000);
      return true;
    } catch (e) {
      console.warn('Snapshot: download failed', e);
      return false;
    }
  }

  /** Renders and downloads. Resolves false when the browser blocks the download; rejects (Error) when rendering fails. */
  async function save (element, options) {
    const o = options || {};
    const fmt = String(o.format || 'png').toLowerCase() === 'svg' ? 'svg' : 'png';
    const render = {};
    Object.keys(o).forEach(function (k) { if (k !== 'format' && k !== 'title') render[k] = o[k]; });
    if (fmt === 'png') {
      const blob = await png(element, render);
      return download(blob, fileName(o.title, 'png'), 'image/png');
    }
    const r = await svg(element, render);
    return download(r.text, fileName(o.title, 'svg'), 'image/svg+xml;charset=utf-8');
  }

  // ---------------------------------------------------------------------------
  // Save-as-picture control
  // ---------------------------------------------------------------------------
  function val (v) { return typeof v === 'function' ? v() : v; }

  /** Plain menu entries for an existing export menu. */
  function menuItems (opts) {
    const o = opts || {};
    const make = function (format) {
      return function () {
        const so = { format: format, title: val(o.title) };
        if (o.background != null) so.background = o.background;
        if (o.full != null) so.full = val(o.full);
        if (format === 'svg') so.vector = val(o.vector);
        return save(val(o.element), so);
      };
    };
    const out = [{ id: 'png', label: 'Picture (PNG)', run: make('png') }];
    if (o.vector) out.push({ id: 'svg', label: 'Vector (SVG)', run: make('svg') });
    return out;
  }

  const STYLE_ID = 'ext-snapshot-style';
  const STYLE =
    '.ext-snap-host{position:relative}' +
    '.ext-snap-btn{position:absolute;z-index:5;width:28px;height:28px;display:flex;align-items:center;justify-content:center;box-sizing:border-box;border:1px solid #e2e4e8;border-radius:6px;background:#fff;color:#55606e;cursor:pointer;padding:0;opacity:0;transition:opacity .15s}' +
    '.ext-snap-host:hover>.ext-snap-btn,.ext-snap-btn:focus,.ext-snap-btn:focus-visible,.ext-snap-btn.ext-snap-open,.ext-snap-btn.ext-snap-busy{opacity:1}' +
    '.ext-snap-btn:hover{background:#f2f4f6;color:#263244}' +
    '.ext-snap-btn.ext-snap-busy{cursor:progress;animation:ext-snap-pulse 1s ease-in-out infinite}' +
    '@keyframes ext-snap-pulse{50%{opacity:.45}}' +
    '.ext-snap-menu{display:none;position:fixed;z-index:50;min-width:160px;padding:4px 0;background:#fff;border:1px solid #e2e4e8;border-radius:6px;box-shadow:0 6px 18px rgba(38,50,68,.16);font:12.5px/1.3 "Lato",-apple-system,"Segoe UI",Roboto,Arial,sans-serif;color:#263244}' +
    '.ext-snap-menu button{display:block;width:100%;padding:7px 14px;border:0;background:none;font:inherit;color:inherit;text-align:left;cursor:pointer;white-space:nowrap}' +
    '.ext-snap-menu button:hover,.ext-snap-menu button:focus{background:#f2f4f6;outline:none}';
  const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><rect x="2" y="2.5" width="12" height="11" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.8" cy="6" r="1.1" fill="currentColor"/><path d="M2.5 12l3.6-3.4 2.4 2.2 2-1.8 3 3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function ensureStyle () {
    if (document.getElementById(STYLE_ID)) return;
    const st = document.createElement('style');
    st.id = STYLE_ID;
    st.textContent = STYLE;
    document.head.appendChild(st);
  }

  /** A "Save as picture" button in the top-right corner of `host`. Returns { el, refresh(), destroy() }. */
  function button (opts) {
    const o = opts || {};
    const host = typeof o.host === 'string' ? document.getElementById(o.host) : o.host;
    if (!host || host.nodeType !== 1) throw new Error('ExtSnapshot.button: no host element to put the button in.');
    ensureStyle();
    host.classList.add('ext-snap-host');
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ext-snap-btn';
    btn.setAttribute('data-snapshot', 'skip');
    btn.setAttribute('aria-label', 'Save as picture');
    btn.setAttribute('aria-haspopup', 'menu');
    btn.title = 'Save as picture';
    btn.innerHTML = ICON;
    const pos = o.position || {};
    const off = function (k, d) { return (typeof pos[k] === 'number' ? pos[k] : d) + 'px'; };
    if (typeof pos.left === 'number') btn.style.left = off('left', 8); else btn.style.right = off('right', 8);
    if (typeof pos.bottom === 'number') btn.style.bottom = off('bottom', 8); else btn.style.top = off('top', 8);

    const menu = document.createElement('div');
    menu.className = 'ext-snap-menu';
    menu.setAttribute('data-snapshot', 'skip');
    menu.setAttribute('role', 'menu');

    let busy = false;
    let destroyed = false;
    const fail = function (err) {
      if (typeof o.onError === 'function') o.onError(err);
      else console.error('Save as picture failed', err);
    };
    const closeMenu = function () { menu.style.display = 'none'; btn.classList.remove('ext-snap-open'); btn.setAttribute('aria-expanded', 'false'); };
    const isOpen = function () { return menu.style.display === 'block'; };
    const run = function (item) {
      if (busy || destroyed) return;
      busy = true;
      btn.classList.add('ext-snap-busy');
      btn.setAttribute('aria-busy', 'true');
      let p;
      try { p = Promise.resolve(item.run()); } catch (e) { p = Promise.reject(e); }
      p.catch(fail).then(function () {
        busy = false;
        btn.classList.remove('ext-snap-busy');
        btn.removeAttribute('aria-busy');
      });
    };
    const items = function () { return menuItems(o); };

    const onBtn = function (e) {
      e.stopPropagation();
      if (busy) return;
      if (isOpen()) { closeMenu(); return; }
      const list = items();
      if (list.length === 1) { run(list[0]); return; }
      menu.innerHTML = '';
      list.forEach(function (it) {
        const b = document.createElement('button');
        b.type = 'button';
        b.setAttribute('role', 'menuitem');
        b.setAttribute('data-snapshot', 'skip');
        b.textContent = it.label;
        b.addEventListener('click', function (ev) { ev.stopPropagation(); closeMenu(); btn.focus(); run(it); });
        menu.appendChild(b);
      });
      const r = btn.getBoundingClientRect();
      menu.style.display = 'block';
      menu.style.top = (r.bottom + 4) + 'px';
      menu.style.left = Math.max(4, r.right - menu.offsetWidth) + 'px';
      btn.classList.add('ext-snap-open');
      btn.setAttribute('aria-expanded', 'true');
      if (menu.firstChild && e.detail === 0) menu.firstChild.focus(); // opened from the keyboard
    };
    const onDown = function (e) { if (isOpen() && !menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) closeMenu(); };
    const onKey = function (e) { if (e.key === 'Escape' && isOpen()) { closeMenu(); btn.focus(); } };
    const onFocusOut = function (e) {
      const t = e.relatedTarget;
      if (isOpen() && t && t !== btn && !menu.contains(t)) closeMenu();
    };
    btn.addEventListener('click', onBtn);
    btn.addEventListener('focusout', onFocusOut);
    menu.addEventListener('focusout', onFocusOut);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('blur', closeMenu);

    host.appendChild(btn);
    document.body.appendChild(menu);

    return {
      el: btn,
      refresh: function () {
        // Title / vector are read at click time; this re-reads the hover text and closes a stale menu.
        const t = val(o.title);
        btn.title = t ? 'Save as picture: ' + t : 'Save as picture';
        closeMenu();
      },
      destroy: function () {
        destroyed = true;
        document.removeEventListener('mousedown', onDown);
        document.removeEventListener('keydown', onKey);
        window.removeEventListener('blur', closeMenu);
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        if (menu.parentNode) menu.parentNode.removeChild(menu);
      }
    };
  }

  const api = {
    png: png, svg: svg, download: download, fileName: fileName, save: save, menuItems: menuItems, button: button,
    _: {
      DEFAULT_MAX_PIXELS: DEFAULT_MAX_PIXELS, limitScale: limitScale, cleanFileName: cleanFileName, cssUrls: cssUrls,
      replaceCssUrls: replaceCssUrls, dataUrl: dataUrl, localizeFragmentUrls: localizeFragmentUrls,
      isTransparentColor: isTransparentColor, splitFamilies: splitFamilies, fontRuleMatches: fontRuleMatches,
      fontMime: fontMime, stripInvalidXml: stripInvalidXml
    }
  };

  root.ExtSnapshot = api;
})(typeof window !== 'undefined' ? window : globalThis);
