'use strict';

/**
 * ExtBoot — start-up, recovery and error reporting shared by every extension.
 *
 * In index.html (head, before any other script):
 *   <script src="../shared/boot.js" data-lib="../shared/lib/tableau.extensions.1.17.0.min.js"
 *           data-mock="./dev/mock.js" data-name="Bar Chart" data-ext-version="1.2.0"></script>
 * and at the end of body:
 *   <script>ExtBoot.start(function () { return window.BarChart && BarChart.init(); });</script>
 *
 * What it does:
 *   - Loads the dev mock (only with ?mock in the URL) and then the Tableau
 *     Extensions API library, with ordinary script elements, then calls init.
 *   - Recovery: when a file doesn't arrive, Tableau rejects the handshake, or
 *     the handshake isn't answered in time (the extension calls retry()), the
 *     frame is reloaded, at most 3 times. The count rides in the URL hash.
 *   - Errors: uncaught errors, rejected promises, everything logged with
 *     console.error and anything passed to report() are kept and shown behind a small warning mark in the corner
 *     with copyable details (extension, version, API version, time, error),
 *     because people viewing a dashboard on Tableau Server can't open a console.
 *
 * stamp-versions.py fills in ?v= on data-lib / data-mock and data-ext-version
 * from the .trex.
 */
(function () {
  const script = document.currentScript;
  const data = (script && script.dataset) || {};
  const NAME = data.name || document.title || 'Extension';
  const VERSION = data.extVersion || '';
  const MAX_RELOADS = 3;

  // ---- reload recovery -------------------------------------------------------
  const m = /(?:ext|kpi)Retry=(\d+)/.exec(location.hash);
  const attempt = m ? +m[1] : 0;
  const base = location.pathname + location.search;
  let pending = 0;

  function go (k) {
    try { history.replaceState(null, '', base + (k ? '#extRetry=' + k : '')); } catch (e) { /* ignore */ }
    location.reload();
  }

  /** Schedules a reload; false when the reloads are used up (the caller then shows a message). */
  function retry (why) {
    if (pending) return true;
    if (attempt >= MAX_RELOADS) return false;
    console.warn(NAME + ': ' + why + ', reloading (attempt ' + (attempt + 1) + ' of ' + MAX_RELOADS + ')');
    pending = setTimeout(function () { go(attempt + 1); }, 200 + Math.random() * 1300);
    return true;
  }

  /** The handshake succeeded: cancel a scheduled reload and tidy the URL. */
  function ok () {
    clearTimeout(pending);
    pending = 0;
    if (attempt) { try { history.replaceState(null, '', base); } catch (e) { /* ignore */ } }
  }

  // ---- error reporting -------------------------------------------------------
  const errors = [];
  let badge = null;
  let panel = null;

  function describe (err) {
    if (!err) return 'Unknown error';
    if (typeof err === 'string') return err;
    const parts = [];
    if (err.errorCode) parts.push('[' + err.errorCode + ']');
    parts.push(err.message || String(err));
    if (err.stack) parts.push('\n' + String(err.stack).split('\n').slice(0, 6).join('\n'));
    return parts.join(' ');
  }

  function details () {
    let api = '';
    try { api = (window.tableau && tableau.extensions && tableau.extensions.environment && tableau.extensions.environment.apiVersion) || ''; } catch (e) { /* ignore */ }
    let tv = '';
    try { tv = tableau.extensions.environment.tableauVersion || ''; } catch (e) { /* ignore */ }
    const head = [
      NAME + (VERSION ? ' ' + VERSION : ''),
      'Extensions API: ' + (api || 'not connected') + (tv ? ' · Tableau ' + tv : ''),
      'Page: ' + location.origin + location.pathname,
      'Browser: ' + navigator.userAgent
    ];
    return head.concat(errors.map(function (e) { return '\n' + e.time + ' · ' + e.where + '\n' + e.text; })).join('\n');
  }

  function showBadge () {
    if (!document.body) { document.addEventListener('DOMContentLoaded', showBadge); return; }
    if (!badge) {
      badge = document.createElement('button');
      badge.type = 'button';
      badge.id = 'ext-error-badge';
      badge.setAttribute('aria-label', 'Show error details');
      badge.textContent = '!';
      badge.style.cssText = 'position:fixed;right:6px;bottom:6px;z-index:9998;width:20px;height:20px;padding:0;border-radius:50%;' +
        'border:1px solid #F59E0B;background:#FFFBEB;color:#B45309;font:700 12px/18px sans-serif;cursor:pointer';
      badge.addEventListener('click', togglePanel);
      document.body.appendChild(badge);
    }
    badge.title = errors.length + ' problem' + (errors.length === 1 ? '' : 's') + ' — click for details';
    if (panel && !panel.hidden) panel.querySelector('textarea').value = details();
  }

  function togglePanel () {
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'ext-error-panel';
      panel.style.cssText = 'position:fixed;left:6px;right:6px;bottom:32px;z-index:9999;max-height:70%;display:flex;flex-direction:column;gap:6px;' +
        'padding:10px;border-radius:8px;border:1px solid #E5E7EB;background:#fff;box-shadow:0 6px 24px rgba(0,0,0,.18);font:12px/1.4 sans-serif;color:#1F2933';
      const title = document.createElement('div');
      title.textContent = 'Something went wrong in this extension. Copy these details for support:';
      const ta = document.createElement('textarea');
      ta.readOnly = true;
      ta.style.cssText = 'flex:1;min-height:90px;width:100%;box-sizing:border-box;font:11px/1.4 ui-monospace,Menlo,Consolas,monospace;border:1px solid #E5E7EB;border-radius:4px;padding:6px;resize:none';
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:6px;justify-content:flex-end';
      const mk = function (label, fn) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.style.cssText = 'font:12px sans-serif;padding:3px 10px;border:1px solid #D1D5DB;border-radius:4px;background:#F9FAFB;cursor:pointer';
        b.addEventListener('click', fn);
        row.appendChild(b);
        return b;
      };
      const copy = mk('Copy', function () {
        ta.select();
        let done = false;
        try { done = document.execCommand('copy'); } catch (e) { /* ignore */ }
        if (!done && navigator.clipboard) navigator.clipboard.writeText(ta.value).catch(function () {});
        copy.textContent = 'Copied';
        setTimeout(function () { copy.textContent = 'Copy'; }, 1500);
      });
      mk('Reload', function () { go(0); });
      mk('Close', function () { panel.hidden = true; });
      panel.appendChild(title);
      panel.appendChild(ta);
      panel.appendChild(row);
      document.body.appendChild(panel);
      panel.hidden = true;
    }
    panel.hidden = !panel.hidden;
    if (!panel.hidden) panel.querySelector('textarea').value = details();
  }

  /** Records an error (shown behind the warning mark). `where` says what was being done. */
  function report (err, where) {
    try {
      const text = describe(err);
      // Not errors: a dialog the user closed, the browser's ResizeObserver notice, cross-origin noise.
      if (/dialog.*closed|closed.*by.*user|ResizeObserver loop|^Script error\.?$/i.test(text)) return;
      const last = errors[errors.length - 1];
      if (last && last.text === text) return;
      errors.push({ time: new Date().toISOString(), where: where || 'error', text: text });
      if (errors.length > 20) errors.shift();
      showBadge();
    } catch (e) { /* reporting must never throw */ }
  }

  // Everything the extensions log with console.error is an error worth showing: it is recorded
  // here, so no call site has to remember to report it.
  const consoleError = console.error;
  console.error = function () {
    consoleError.apply(console, arguments);
    const args = Array.prototype.slice.call(arguments);
    const err = args.find(function (a) { return a && typeof a === 'object'; });
    const label = args.filter(function (a) { return typeof a === 'string'; }).join(' ').replace(/[:\s]+$/, '');
    report(err || label, err ? label : 'error');
  };

  window.addEventListener('error', function (e) {
    // Script / stylesheet load failures arrive here too (no e.error): those are handled by start().
    if (e && (e.error || e.message)) report(e.error || e.message, 'uncaught error' + (e.filename ? ' in ' + String(e.filename).split('/').pop() + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', function (e) { report(e && e.reason, 'unhandled promise rejection'); });

  // ---- old browser caches ---------------------------------------------------
  // Versions before November 2026 kept the last drawn chart (with its data) in localStorage.
  // That cache is gone; this removes what those versions left behind in this browser.
  setTimeout(function () {
    try {
      const ls = window.localStorage;
      for (let i = ls.length - 1; i >= 0; i--) {
        const k = ls.key(i);
        if (k && k.indexOf(':last' + 'Render:') > 0) ls.removeItem(k);
      }
    } catch (e) { /* storage not available */ }
  }, 5000);

  // ---- loading ---------------------------------------------------------------
  function load (src) {
    return new Promise(function (resolve, reject) {
      const s = document.createElement('script');
      s.src = src;
      s.async = false;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('could not load ' + src.split('?')[0])); };
      document.head.appendChild(s);
    });
  }

  /**
   * Loads the dev mock (with ?mock) and the Tableau API library (unless a mock
   * already defined it), then calls init(). init returns false when the
   * extension's own files are missing.
   */
  function start (init, opts) {
    const o = opts || {};
    const steps = [];
    if (data.mock && /[?&]mock\b/.test(location.search)) steps.push(function () { return load(data.mock); });
    steps.push(function () {
      if (window.tableau && window.tableau.extensions) return null;
      return data.lib ? load(data.lib) : Promise.reject(new Error('no API library configured'));
    });
    return steps.reduce(function (p, step) { return p.then(step); }, Promise.resolve()).then(function () {
      if (window.ExtTiming) window.ExtTiming.mark('Tableau API library loaded');
      if (!(window.tableau && window.tableau.extensions)) throw new Error('the Tableau API library did not start');
      const r = init();
      if (r === false) throw new Error('a file did not load');
      return r;
    }).catch(function (err) {
      console.error(NAME + ':', err);
      if (o.dialog || !retry((err && err.message) || 'a file did not load')) {
        report(err, 'loading');
        const hint = document.getElementById(o.hint || 'hint');
        if (hint) hint.textContent = 'Could not load the ' + NAME + ' files. Refresh the page to try again.';
      }
    });
  }

  window.ExtBoot = {
    name: NAME,
    version: VERSION,
    attempt: attempt,
    retry: retry,
    reload: function () { go(0); },
    ok: ok,
    report: report,
    errors: errors,
    details: details,
    load: load,
    start: start
  };
  window.KpiBoot = window.ExtBoot; // older name used by the KPI cards
})();
