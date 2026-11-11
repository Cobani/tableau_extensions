'use strict';

/**
 * Parameter Switcher — Tableau Viz Extension.
 *
 * A control, not a chart: it shows the allowed values of ONE Tableau parameter as tabs, buttons,
 * pills, a dropdown, a two-way toggle or a stepper, and sets the parameter when one is clicked.
 *
 * Marks card tile (declared in parameter-switcher.trex):
 *   options   Options (optional): one discrete dimension. When present its distinct values, in
 *             worksheet order, are the choices (for parameters that allow "All" values). When
 *             empty the choices are the parameter's own list of allowed values (or its range,
 *             stepped by the step size).
 *
 * Which parameter is set in Format Extension → Control (the dialog gets the worksheet's
 * parameter names from this file). The selected choice always mirrors the parameter's current
 * value, also when it is changed somewhere else on the dashboard (ParameterChanged).
 *
 * Appearance comes from the Format dialog (configure.html) and is stored in the workbook through
 * tableau.extensions.settings.
 */
(function () {
  var esc = ExtCore.esc, isMN = ExtCore.isMN;

  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null;     // what is shown, see buildModel()
  var params = [];      // the worksheet's Tableau parameters
  var watched = {};     // parameter ids that already have a ParameterChanged listener
  var renderToken = 0;
  var changing = 0;     // changes sent to Tableau and not answered yet
  var ui = null;        // handles of the drawn control, see drawControl()
  var msgTimer = 0;

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'control', 'msg', 'hint'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    // Handshake recovery: the frame is reloaded (fresh handshake, up to 3 times in all) when
    // Tableau rejects the handshake, or when it hasn't answered within the timeout. Tableau
    // answers every extension through one queue for the whole dashboard, so each reload waits
    // a little longer; if the answer arrives before the reload fires, the reload is cancelled.
    // After the last reload it keeps waiting and offers a manual reload.
    var boot = window.ExtBoot || { attempt: 0, retry: function () { return false; }, ok: function () {} };
    var initDone = false;
    var hintTimer = setTimeout(function () {
      if (!initDone) showEmpty('Loading…');
    }, 2500);
    var initTimeout = INIT_TIMEOUT + INIT_TIMEOUT_STEP * boot.attempt;
    var watchdog = setTimeout(function () {
      if (initDone) return;
      if (!boot.retry('no handshake after ' + initTimeout / 1000 + ' s')) showRetry('Tableau has not answered yet.');
    }, initTimeout);

    if (window.ExtTiming) ExtTiming.mark('initializeAsync start', boot.attempt ? 'reload #' + boot.attempt : '');
    return tableau.extensions.initializeAsync({ configure: configure }).then(function () {
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      boot.ok();
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Ps.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, requestRefresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          var before = cfg;
          cfg = Ps.read();
          // The parameter (or the row limit) changed: read again. Anything else only redraws.
          if (!before || before.parameter.name !== cfg.parameter.name || limitChanged()) scheduleRefresh();
          else paint();
        }
      );

      if (window.ResizeObserver) {
        new ResizeObserver(function () { layout(); if (deferred && isShown()) scheduleRefresh(); }).observe(document.body);
      } else {
        window.addEventListener('resize', layout);
      }

      return scheduleRefresh();
    }).catch(function (err) {
      if (initDone) {
        console.error('Parameter Switcher failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Parameter Switcher failed to initialize:', err);
      if (!boot.retry('handshake failed')) showRetry();
    });
  }

  // Handshake timeout: 4 s on the first load, +2 s per reload (4, 6, 8, 10 s → about 28 s
  // before giving up). A late answer still draws the control, even after giving up.
  var INIT_TIMEOUT = 4000;
  var INIT_TIMEOUT_STEP = 2000;

  /** A click reloads the control. */
  function showRetry (why) {
    showEmpty((why || 'Could not connect to Tableau.') + '<br><u>Click to reload this control.</u>');
    el.hint.style.cursor = 'pointer';
    el.hint.onclick = function () { if (window.ExtBoot) ExtBoot.reload(); else location.reload(); };
  }

  /** Opens the Format dialog ("Format Extension" on the Marks card). */
  function configure () {
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html';
    var options = { width: 520, height: 720 };
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) {
      options.dialogStyle = tableau.DialogStyle.Modal; // stays in front of Tableau until Done; the control behind it still updates live
    }
    // The dialog can't read the worksheet: it gets the parameter names and the current choices from here.
    var payload = JSON.stringify({
      parameters: params.map(function (p) { return { name: p.name, dataType: p.dataType }; }),
      choices: model && model.choices ? model.choices.map(function (c) { return { key: c.key, label: c.formatted }; }) : []
    });
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.error('Parameter Switcher dialog error:', err);
    });
  }

  // ---------------------------------------------------------------------------
  // Refresh scheduling. Tableau runs extension requests one at a time, shared
  // with the rest of the dashboard, so each control keeps at most one request
  // going, waits for a burst of changes to settle, and doesn't ask for data
  // while its zone is hidden (it catches up when shown again).
  // ---------------------------------------------------------------------------
  var REFRESH_DELAY = 150; // ms to wait for a burst of changes to settle
  var CALL_RETRIES = 2;     // extra tries for a call Tableau rejected (never for a slow one)
  var inFlight = false;
  var rerun = false;
  var deferred = false;
  var refreshTimer = 0;

  function isShown () {
    return document.body.clientWidth > 0 && document.body.clientHeight > 0;
  }

  /** SummaryDataChanged: wait briefly, so several changes in a row fetch once. */
  function requestRefresh () {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(scheduleRefresh, REFRESH_DELAY);
  }

  function scheduleRefresh () {
    if (!isShown()) { deferred = true; return Promise.resolve(); }
    deferred = false;
    if (inFlight) { rerun = true; return Promise.resolve(); }
    inFlight = true;
    return refresh().then(done, done);
    function done () {
      inFlight = false;
      if (rerun) { rerun = false; scheduleRefresh(); }
    }
  }

  // ---------------------------------------------------------------------------
  // Data: the worksheet's parameters, and the Options tile when it has a field
  // ---------------------------------------------------------------------------
  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var first = token === 1;
    if (first) T.mark('data requested');
    try {
      var list = await withRetry(function () { return worksheet.getParametersAsync(); }, 'getParametersAsync');
      if (token !== renderToken) return;
      params = list || [];
      if (first) T.mark('parameters received', params.length + ' parameters');

      var name = cfg.parameter.name;
      if (!name) {
        model = null;
        T.done('Parameter Switcher load timings');
        showEmpty('Choose a parameter in <b>Format Extension</b>.');
        return;
      }
      var p = params.find(function (x) { return x.name === name; }) || null;
      if (!p) {
        model = null;
        T.done('Parameter Switcher load timings');
        showEmpty('The parameter “' + esc(name) + '” was not found in this workbook. Choose another in <b>Format Extension</b>.');
        return;
      }
      watch(p);

      var cells = await readOptions();
      if (token !== renderToken) return;
      model = buildModel(p, cells);
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Parameter Switcher load timings');
      }
    } catch (err) {
      console.error('Parameter Switcher render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Parameter Switcher load timings'); }
      if (token === renderToken) showEmpty('Could not read the parameter. Click the ! mark in the corner for details.');
    }
  }

  /** The worksheet's summary data, up to the row limit (Format → Card → Maximum rows; 0 = all). */
  var lastLimit = null;
  async function readSummaryData () {
    var limit = ExtCore.rowLimit(cfg.data.maxRows);
    var table = await ExtCore.readSummary(worksheet, { limit: limit });
    lastLimit = limit;
    ExtCore.rowNotice(table);
    return table;
  }

  /** True when the row limit in the settings no longer matches the data that was read. */
  function limitChanged () {
    return lastLimit != null && ExtCore.rowLimit(cfg.data.maxRows) !== lastLimit;
  }

  /**
   * The distinct values of the Options field in worksheet order (rows arrive last-to-first, so they
   * are read backwards): [{ raw, formatted }], or null when nothing is on the Options tile. A sheet
   * with no fields at all has empty summary data: that is not an error, it just means no Options.
   */
  async function readOptions () {
    var table = await withRetry(readSummaryData, 'getSummaryDataAsync');
    var cols = ((table && table.columns) || []).filter(function (c) { return !isMN(c); });
    if (!cols.length) return null;
    var field = null;
    try { field = await withRetry(getOptionsField, 'getVisualSpecificationAsync'); } catch (e) { console.warn('Parameter Switcher: could not read the Marks card', e); }
    if (!field) return null;
    var col = ExtCore.findColumn(table, field);
    if (!col) return null;
    var seen = {};
    var out = [];
    for (var i = table.data.length - 1; i >= 0; i--) {
      var cell = table.data[i][col.index];
      if (!cell || cell.value == null) continue;
      var key = String(cell.value);
      if (seen[key]) continue;
      seen[key] = true;
      out.push({ raw: cell.value, formatted: cell.formattedValue != null ? String(cell.formattedValue) : key });
    }
    return out;
  }

  /** The field on the Options tile, or null. */
  async function getOptionsField () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var found = null;
    marks.encodings.forEach(function (enc) {
      if (!enc.field || found) return;
      var type = String(enc.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : enc.id;
      if (id === 'options') found = enc.field;
    });
    return found;
  }

  /** A call Tableau rejects (busy server) is tried again a couple of times, after a short random pause. */
  async function withRetry (fn, what) {
    for (var i = 0; ; i++) {
      try {
        return await fn();
      } catch (err) {
        if (i >= CALL_RETRIES) throw err;
        console.warn('Parameter Switcher: ' + what + ' failed, retrying', err);
        await new Promise(function (r) { setTimeout(r, 400 * (i + 1) * (i + 1) + Math.random() * 400); });
      }
    }
  }

  // ---------------------------------------------------------------------------
  // The model: the choices, and which one is selected
  // ---------------------------------------------------------------------------
  var MAX_RANGE_CHOICES = 500;

  /** The raw value in the parameter's own type, which is what changeValueAsync wants. */
  function coerce (p, raw) {
    var dt = String(p.dataType || '').toLowerCase();
    if (dt === 'int' || dt === 'float') { var n = Number(raw); return isFinite(n) ? n : raw; }
    if (dt === 'string') return String(raw);
    if (dt === 'bool' || dt === 'boolean') return raw === true || String(raw).toLowerCase() === 'true';
    return raw;
  }

  /** Values are compared as strings of the raw value; numbers are normalised (5, 5.0 and "5" agree). */
  function keyOf (p, raw) {
    var dt = String(p.dataType || '').toLowerCase();
    if ((dt === 'int' || dt === 'float') && raw !== '' && raw != null && isFinite(Number(raw))) return String(Number(raw));
    return String(raw);
  }

  /**
   * { param, choices: [{ key, raw, formatted }], range: { min, max, step } | null, stepperOnly, selected (key),
   *   currentText, issue (text when there is nothing to show) }
   */
  function buildModel (p, cells) {
    var av = p.allowableValues || {};
    var type = String(av.type || 'all').toLowerCase();
    var m = { param: p, choices: [], range: null, stepperOnly: false, selected: null, currentText: '', issue: '' };

    if (cells && cells.length) {
      m.choices = cells.map(function (c) { return { key: keyOf(p, c.raw), raw: coerce(p, c.raw), formatted: c.formatted }; });
    } else if (type === 'list') {
      m.choices = (av.allowableValues || []).map(function (dv) {
        return { key: keyOf(p, dv.value), raw: dv.value, formatted: dv.formattedValue != null ? String(dv.formattedValue) : String(dv.value) };
      });
    } else if (type === 'range') {
      var min = Number(av.minValue && av.minValue.value);
      var max = Number(av.maxValue && av.maxValue.value);
      if (!isFinite(min) || !isFinite(max) || max < min) {
        m.issue = 'This parameter’s range can’t be shown as choices. Drop a field on the <b>Options</b> tile to list values.';
      } else {
        var step = Number(av.stepSize);
        if (!(step > 0)) step = /int/i.test(String(p.dataType)) ? 1 : (max - min) / 100 || 1;
        m.range = { min: min, max: max, step: step };
        var count = Math.floor((max - min) / step + 1e-9) + 1;
        if (count <= MAX_RANGE_CHOICES) {
          for (var i = 0; i < count; i++) {
            var v = +(min + i * step).toFixed(10);
            m.choices.push({ key: String(v), raw: v, formatted: String(v) });
          }
        } else {
          m.stepperOnly = true;
        }
      }
    } else {
      m.issue = 'This parameter accepts any value, so there is nothing to list. Drop a field on the <b>Options</b> tile to use its values as choices.';
    }
    if (!m.issue && !m.choices.length && !m.stepperOnly) {
      m.issue = 'This parameter has no values to choose from.';
    }
    syncFromParam(m);
    return m;
  }

  /** Selected key and text from the parameter's current value (Tableau keeps it up to date). */
  function syncFromParam (m) {
    var p = m.param;
    var cv = p.currentValue || {};
    m.selected = cv.value == null ? null : keyOf(p, cv.value);
    var hit = m.choices.find(function (c) { return c.key === m.selected; });
    m.currentText = hit ? Ps.labelFor(cfg.options, hit.key, hit.formatted) : (cv.formattedValue != null ? String(cv.formattedValue) : String(m.selected == null ? '' : m.selected));
  }

  /** Listens once per parameter for changes made anywhere else (another control, a dashboard action, the parameter card). */
  function watch (p) {
    if (watched[p.id || p.name] || !p.addEventListener || !(tableau.TableauEventType && tableau.TableauEventType.ParameterChanged)) return;
    watched[p.id || p.name] = true;
    p.addEventListener(tableau.TableauEventType.ParameterChanged, function (ev) {
      if (changing) return; // our own change; changeValueAsync's answer updates the selection
      var done = function (np) {
        if (model && model.param && model.param.name === p.name) {
          model.param = np || p;
          syncFromParam(model);
          applySelection();
        }
      };
      if (ev && typeof ev.getParameterAsync === 'function') ev.getParameterAsync().then(done, function () { done(p); });
      else done(p);
    });
  }

  /** The choices that are shown: hidden values left out. */
  function visibleChoices () {
    return model.choices.filter(function (c) { return !Ps.isHidden(cfg.options, c.key); });
  }

  /** Style actually drawn: toggle needs exactly two choices, too many choices fall back to the dropdown. */
  function effectiveStyle (n) {
    var c = cfg.control;
    var s = c.style;
    if (model.stepperOnly) return 'stepper';
    if (s === 'toggle' && n !== 2) s = 'segmented';
    if (s !== 'stepper' && c.autoDropdown && n > c.autoDropdownAbove) s = 'dropdown';
    return s;
  }

  // ---------------------------------------------------------------------------
  // Setting the parameter
  // ---------------------------------------------------------------------------
  /**
   * Click: the selection moves at once (optimistic), Tableau is asked, and if Tableau
   * rejects the value the selection goes back with a short message.
   */
  function choose (choice) {
    var m = model;
    if (!m || !m.param || choice.key === m.selected) return;
    var prev = { selected: m.selected, text: m.currentText };
    m.selected = choice.key;
    m.currentText = Ps.labelFor(cfg.options, choice.key, choice.formatted);
    changing++;
    clearMsg();
    applySelection();
    var label = m.currentText;
    var done = function () { changing--; };
    var promise;
    try { promise = Promise.resolve(m.param.changeValueAsync(choice.raw)); } catch (e) { promise = Promise.reject(e); }
    return promise.then(function () {
      done();
      if (model === m) { syncFromParam(m); applySelection(); }
    }, function (err) {
      done();
      console.error('Parameter Switcher: Tableau did not accept the value', choice.raw, err);
      if (model === m) {
        m.selected = prev.selected;
        m.currentText = prev.text;
        applySelection();
        showMsg('Tableau did not accept “' + label + '”. The parameter was not changed.');
      }
    });
  }

  /** Next / previous value of a range too long to list. */
  function stepBy (dir) {
    var m = model;
    var r = m.range;
    var cur = Number(m.param.currentValue && m.param.currentValue.value);
    if (!r || !isFinite(cur)) return;
    var v = Math.min(r.max, Math.max(r.min, +(cur + dir * r.step).toFixed(10)));
    if (v === cur) return;
    return choose({ key: String(v), raw: v, formatted: String(v) });
  }

  function showMsg (text) {
    clearTimeout(msgTimer);
    el.msg.textContent = text;
    el.msg.style.display = '';
    msgTimer = setTimeout(clearMsg, 5000);
  }

  function clearMsg () {
    clearTimeout(msgTimer);
    el.msg.textContent = '';
    el.msg.style.display = 'none';
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg) return;
    if (!model) return; // an empty state is already showing (refresh sets it)
    if (model.issue) { showEmpty(model.issue); return; }
    el.card.classList.remove('is-empty');
    paintCard();
    paintHeader();
    drawControl();
    layout();
    syncSnapshot();
  }

  // Save as picture (optional): PNG only.
  var snap = null;
  function syncSnapshot () {
    var on = !!(cfg && cfg.export && cfg.export.picture) && window.ExtSnapshot;
    if (on && !snap) {
      snap = ExtSnapshot.button({
        host: el.card,
        element: el.card,
        title: function () { return (el.title && el.title.textContent) || (model && model.param && model.param.name) || 'Parameter Switcher'; }
      });
    }
    if (on) snap.refresh();
    else if (snap) { snap.destroy(); snap = null; }
  }

  function applyFont (node, f) {
    node.style.fontFamily = Ps.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Ps.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.card.style.borderRightColor = c.divider ? c.dividerColor : 'transparent';
    el.card.style.borderRightWidth = c.divider ? '1px' : '0';
  }

  function paintHeader () {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      var target = Math.max(8, Math.min(128, Number(ic.size) > 0 ? Number(ic.size) : 24));
      if (ic.source === 'builtin') {
        var r = Ps.iconHtml(ic.builtinId, ic.color, target);
        el.icon.innerHTML = r.html;
      } else {
        var img = new Image();
        img.alt = '';
        img.style.height = target + 'px';
        img.style.width = 'auto';
        img.src = ic.dataUrl;
        el.icon.appendChild(img);
      }
    }

    var t = cfg.title;
    applyFont(el.title, t);
    el.title.textContent = t.text || (model && model.param ? model.param.name : '');
    el.title.style.textAlign = t.align || 'left';
    el.title.style.display = t.show === false ? 'none' : '';

    var ex = cfg.explanation;
    var hasText = ex.show && !!String(ex.text || '').trim();
    applyFont(el.explanation, ex);
    el.explanation.style.textAlign = t.align || 'left';
    el.explanation.textContent = hasText ? ex.text : ' ';
    el.explanation.style.display = hasText || (ex.show && ex.reserveSpace) ? '' : 'none';

    var head = el.title.parentNode;
    var headShown = t.show !== false || showIcon || el.explanation.style.display !== 'none';
    if (head) head.style.display = headShown ? '' : 'none';
    el.card.classList.toggle('has-head', headShown);
  }

  /** Colours, font and sizes go to the card as CSS variables; chart.css does the rest. */
  function paintVars (size) {
    var c = cfg.control;
    var k = cfg.colors;
    var v = {
      '--ps-font': Ps.fontStack(c.font),
      '--ps-fs': size.font + 'px',
      '--ps-py': size.padY + 'px',
      '--ps-px': size.padX + 'px',
      '--ps-h': size.height + 'px',
      '--ps-gap': c.gap + 'px',
      '--ps-radius': c.radius + 'px',
      '--ps-bw': c.borderWidth + 'px',
      '--ps-bc': c.borderColor,
      '--ps-w': String(c.weight),
      '--ps-ws': String(c.selectedWeight),
      '--ps-italic': c.italic ? 'italic' : 'normal',
      '--ps-n-text': k.normal.text,
      '--ps-n-bg': k.normal.bg,
      '--ps-h-text': k.hover.text,
      '--ps-h-bg': k.hover.bg,
      '--ps-s-text': k.selected.text,
      '--ps-s-bg': k.selected.bg,
      '--ps-s-acc': k.selected.accent
    };
    Object.keys(v).forEach(function (name) { el.card.style.setProperty(name, v[name]); });
  }

  function mk (tag, cls, attrs) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }

  /**
   * Builds the control for the current style. Handles for later updates go to `ui`:
   * { style, items: [{ node, choice }], select, value, prev, next }.
   */
  function drawControl () {
    var c = cfg.control;
    var size = Ps.SIZES[c.size] || Ps.SIZES.M;
    paintVars(size);
    var choices = visibleChoices();
    var style = effectiveStyle(choices.length);
    var host = el.control;
    host.innerHTML = '';
    host.className = 'control v-' + (c.vAlign || 'top');
    host.setAttribute('aria-label', cfg.title.text || (model.param && model.param.name) || 'Parameter');

    var wrap = mk('div', 'ctl ctl--' + style + ' lay-' + c.layout + ' al-' + c.align + (c.equalWidth ? ' is-eq' : ''));
    ui = { style: style, items: [], select: null, value: null, prev: null, next: null, wrap: wrap };

    if (style === 'dropdown') {
      wrap.setAttribute('role', 'group');
      var sel = mk('select', 'sel');
      sel.setAttribute('aria-label', host.getAttribute('aria-label'));
      choices.forEach(function (ch, i) {
        var o = mk('option');
        o.value = String(i);
        o.textContent = Ps.labelFor(cfg.options, ch.key, ch.formatted);
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () {
        var ch = choices[Number(sel.value)];
        if (ch) choose(ch);
      });
      ui.select = sel;
      ui.choices = choices;
      wrap.appendChild(sel);
    } else if (style === 'stepper') {
      wrap.setAttribute('role', 'group');
      var prev = mk('button', 'step step--prev', { type: 'button', 'aria-label': 'Previous value' });
      prev.textContent = '◀';
      var next = mk('button', 'step step--next', { type: 'button', 'aria-label': 'Next value' });
      next.textContent = '▶';
      var val = mk('div', 'step-value', { 'aria-live': 'polite' });
      var go = function (dir) {
        if (model.stepperOnly) { stepBy(dir); return; }
        var list = visibleChoices();
        var i = list.findIndex(function (x) { return x.key === model.selected; });
        var to = list[i < 0 ? (dir > 0 ? 0 : list.length - 1) : i + dir];
        if (to) choose(to);
      };
      prev.addEventListener('click', function () { go(-1); });
      next.addEventListener('click', function () { go(1); });
      ui.prev = prev; ui.next = next; ui.value = val; ui.choices = choices;
      wrap.append(prev, val, next);
    } else {
      wrap.setAttribute('role', 'radiogroup');
      wrap.setAttribute('aria-label', host.getAttribute('aria-label'));
      choices.forEach(function (ch) {
        var label = Ps.labelFor(cfg.options, ch.key, ch.formatted);
        var b = mk('button', 'opt', { type: 'button', role: 'radio', 'aria-checked': 'false', tabindex: '-1', title: label });
        b.textContent = label;
        b.addEventListener('click', function () { choose(ch); });
        ui.items.push({ node: b, choice: ch });
        wrap.appendChild(b);
      });
      // Arrow keys move the focus; Enter / Space (a button's own click) select.
      wrap.addEventListener('keydown', function (e) {
        var k = e && e.key;
        var step = k === 'ArrowRight' || k === 'ArrowDown' ? 1 : k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 0;
        var edge = k === 'Home' ? 0 : k === 'End' ? ui.items.length - 1 : -1;
        if (!step && edge < 0) return;
        var i = ui.items.findIndex(function (x) { return x.node === document.activeElement; });
        if (i < 0) i = ui.items.findIndex(function (x) { return x.choice.key === model.selected; });
        var to = edge >= 0 ? edge : (i + step + ui.items.length) % ui.items.length;
        if (e.preventDefault) e.preventDefault();
        ui.items.forEach(function (x, n) { x.node.setAttribute('tabindex', n === to ? '0' : '-1'); });
        if (ui.items[to]) ui.items[to].node.focus();
      });
    }
    host.appendChild(wrap);
    applySelection();
    var chosen = ui.items.find(function (x) { return x.choice.key === model.selected; });
    if (chosen && chosen.node.scrollIntoView) { try { chosen.node.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (e) { /* ignore */ } }
  }

  /** Moves the selected state to the model's selected value without rebuilding (keeps the keyboard focus). */
  function applySelection () {
    if (!ui || !model) return;
    var any = ui.items.some(function (x) { return x.choice.key === model.selected; });
    ui.items.forEach(function (x, i) {
      var on = x.choice.key === model.selected;
      x.node.setAttribute('aria-checked', String(on));
      x.node.classList.toggle('is-selected', on);
      x.node.setAttribute('tabindex', on || (!any && i === 0) ? '0' : '-1');
    });
    if (ui.select) {
      var idx = ui.choices.findIndex(function (x) { return x.key === model.selected; });
      // A value that is not in the list (hidden, or set elsewhere) still shows its text.
      var extra = ui.select.querySelector ? ui.select.querySelector('.cur') : null;
      if (extra && extra.remove) extra.remove();
      if (idx < 0) {
        var o = mk('option', 'cur');
        o.value = '-1';
        o.textContent = model.currentText;
        ui.select.appendChild(o);
        ui.select.value = '-1';
      } else {
        ui.select.value = String(idx);
      }
    }
    if (ui.value) {
      ui.value.textContent = model.currentText;
      var list = ui.choices || [];
      var i = list.findIndex(function (x) { return x.key === model.selected; });
      if (model.stepperOnly) {
        var cur = Number(model.param.currentValue && model.param.currentValue.value);
        ui.prev.disabled = !(cur > model.range.min);
        ui.next.disabled = !(cur < model.range.max);
      } else {
        ui.prev.disabled = i <= 0 && i !== -1;
        ui.next.disabled = i === list.length - 1;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Layout — runs on paint and on resize
  // ---------------------------------------------------------------------------
  function layout () {
    if (!cfg || !ui || el.card.classList.contains('is-empty')) return;
    // Equal widths: every choice as wide as the widest one.
    if (cfg.control.equalWidth && ui.items.length) {
      ui.items.forEach(function (x) { x.node.style.minWidth = ''; });
      var w = 0;
      ui.items.forEach(function (x) { w = Math.max(w, x.node.offsetWidth || 0); });
      if (w > 0) ui.items.forEach(function (x) { x.node.style.minWidth = w + 'px'; });
    }
  }

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    el.hint.innerHTML = html;
  }

  window.ParameterSwitcher = { init: init, _keyOf: keyOf };
})();
