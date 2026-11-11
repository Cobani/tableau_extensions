'use strict';

/**
 * Sankey — Tableau Viz Extension.
 *
 * Marks card tiles (declared in sankey.trex):
 *   levels  Levels: 2-6 discrete dimensions, outermost (left) first. Each one is a column of
 *           nodes (one per member).
 *   value   Value: one continuous measure. A link between two neighbouring members is as thick
 *           as the summed Value of the rows that pass through both; a node is as tall as the
 *           Value flowing through it. Measures on Tableau's Tooltip tile are listed in the tooltip.
 *
 * Hover a node: everything flowing through it lights up. Hover a link: the link and its two
 * nodes. Click selects the member (node) or both members (link) in Tableau.
 * Header (icon, title, explanation) is KPI Card's; everything else is set in the Format dialog
 * (configure.html), which also opens from the right-click menu.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc, isMN = ExtCore.isMN, cleanName = ExtCore.cleanName, findColumn = ExtCore.findColumn;

  var el = {};
  var worksheet = null;
  var cfg = null;
  var raw = null; // extracted data, see extract()
  var graph = null; // nodes, edges and layout of the last paint, see buildGraph()
  var renderToken = 0;
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SEP = '\u0001';

  /** In-memory state (not saved). */
  var state = {
    sel: null, // the clicked item: { t: 'n' | 'e', id } (node id / link key)
    hover: null, // the hovered item, same shape
    query: '' // search text
  };

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'tools', 'legend', 'legendrow', 'searchbox', 'search', 'plot',
      'svg', 'note', 'hint', 'tooltip', 'menu'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.svg.addEventListener('mousemove', onHover);
    el.plot.addEventListener('mouseleave', function () { setHover(null); hideTooltip(); });
    el.plot.addEventListener('mouseleave', function () { hoverTableau(null); });
    el.plot.addEventListener('scroll', function () { hideTooltip(); hideMenu(); hoverTableau(null); });
    el.plot.addEventListener('click', onClick);
    el.plot.addEventListener('dblclick', onDblClick);
    el.plot.addEventListener('contextmenu', onContextMenu);
    el.card.addEventListener('contextmenu', function (e) { if (!el.plot.contains(e.target) && e.target !== el.search) onContextMenu(e); });
    document.addEventListener('mousedown', function (e) { if (!el.menu.contains(e.target)) hideMenu(); });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        hideMenu();
        if (document.activeElement === el.search && el.search.value) { el.search.value = ''; onSearch(); return; }
        if (state.sel) select(null);
      }
    });
    window.addEventListener('blur', hideMenu);

    var searchTimer = null;
    el.search.addEventListener('input', function () { clearTimeout(searchTimer); searchTimer = setTimeout(onSearch, 140); });
    el.search.addEventListener('keydown', function (e) { if (e.key === 'Enter') { clearTimeout(searchTimer); onSearch(true); } });

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
    return tableau.extensions.initializeAsync({ configure: function () { return openDialog(null); } }).then(function () {
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      boot.ok();
      if (window.ExtTiming) ExtTiming.mark('initializeAsync done (Tableau handshake)');
      worksheet = tableau.extensions.worksheetContent.worksheet;
      cfg = Sk.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, function () { loadParams(); refresh(); });
      loadParams();
      tableau.extensions.settings.addEventListener(tableau.TableauEventType.SettingsChanged, function () {
        // while the dialog's live preview drives the chart, saves (which lag behind it) are ignored
        if (liveActive) return;
        cfg = Sk.read();
        if (limitChanged()) refresh(); else paint();
      });
      window.addEventListener('storage', onLiveSettings);

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      if (initDone) {
        console.error('Sankey failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Sankey failed to initialize:', err);
      if (!boot.retry('handshake failed')) showRetry();
    });
  }

  // Handshake timeout: 4 s on the first load, +2 s per reload (4, 6, 8, 10 s → about 28 s
  // before giving up). A late answer still draws the chart, even after giving up.
  var INIT_TIMEOUT = 4000;
  var INIT_TIMEOUT_STEP = 2000;

  /** A click reloads the extension. */
  function showRetry (why) {
    showEmpty((why || 'Could not connect to Tableau.') + '<br><u>Click to reload.</u>');
    el.hint.style.cursor = 'pointer';
    el.hint.onclick = function () { if (window.ExtBoot) ExtBoot.reload(); else location.reload(); };
  }

  var queued = false;
  var lastSize = '';
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      var sz = el.card.clientWidth + 'x' + el.card.clientHeight;
      if (sz === lastSize && graph) return;
      paint();
    });
  }

  // ---------------------------------------------------------------------------
  // Parameters: for <Parameter> in the title / explanation
  // ---------------------------------------------------------------------------
  var params = {};
  var paramWatch = {};
  function loadParams () {
    try {
      if (!worksheet || !worksheet.getParametersAsync) return Promise.resolve();
      return worksheet.getParametersAsync().then(function (list) {
        var next = {};
        (list || []).forEach(function (p) {
          var cv = p.currentValue || {};
          next[String(p.name).toLowerCase()] = { name: p.name, value: cv.formattedValue != null ? String(cv.formattedValue) : String(cv.value) };
          var id = p.id || p.name;
          if (!paramWatch[id] && p.addEventListener && tableau.TableauEventType.ParameterChanged) {
            paramWatch[id] = true;
            p.addEventListener(tableau.TableauEventType.ParameterChanged, function () { loadParams().then(function () { if (raw) paintHeader(); }); });
          }
        });
        var changed = JSON.stringify(next) !== JSON.stringify(params);
        params = next;
        if (changed && raw && cfg) paintHeader();
      }).catch(function (e) { console.info('Sankey: parameters not available', e && e.message); });
    } catch (e) { return Promise.resolve(); }
  }

  function paramValue (name) {
    var k = String(name || '').trim().replace(/^\[?parameters\]?\./i, '').replace(/^\[|\]$/g, '').toLowerCase();
    return params[k] ? params[k].value : null;
  }

  /** "<Year>" → the parameter's value; {total} {nodes} {links} {flow} → numbers of this chart. */
  function fillText (text) {
    var g = graph;
    return String(text || '')
      .replace(/<([^<>]+)>/g, function (all, nm) { var v = paramValue(nm); return v != null ? v : all; })
      .replace(/\{total\}/gi, function () { return g ? Sk.formatNumber(g.sum, cfg.numbers) : ''; })
      .replace(/\{links\}/gi, function () { return g ? g.edges.length.toLocaleString('en-US') : ''; })
      .replace(/\{nodes\}/gi, function () { return g ? g.nodes.length.toLocaleString('en-US') : ''; })
      .replace(/\{flow\}/gi, function () { return raw ? raw.levels.map(function (f, i) { return legendName(i).toLowerCase(); }).join(' → ') : ''; });
  }

  // ---------------------------------------------------------------------------
  // Live preview: the Format dialog also writes its settings to localStorage
  // (same origin), so the chart redraws at once instead of waiting for Tableau
  // to save them; the chart sends back what the dialog lists. Tableau's save
  // still follows.
  // ---------------------------------------------------------------------------
  var liveId = 'sk' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  var liveActive = false;
  var infoTimer = null;
  function onLiveSettings (e) {
    if (e.key !== 'sankey:live:' + liveId || !e.newValue) return;
    try {
      var o = JSON.parse(e.newValue);
      liveActive = true;
      cfg = Sk.readFrom(o.cfg);
    } catch (err) { return; }
    if (limitChanged()) refresh(); else paint();
    clearTimeout(infoTimer);
    infoTimer = setTimeout(function () {
      try { if (raw) window.localStorage.setItem('sankey:info:' + liveId, JSON.stringify(dialogInfo(null))); } catch (err) { /* ignore */ }
    }, 120);
  }

  function openDialog (focus) {
    hideMenu();
    hideTooltip();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify(dialogInfo(focus));
    var options = { width: 620, height: 780 };
    // On top (Modal) keeps the Format window in front of Tableau until Done; Floating (Modeless) lets you click the workbook but can fall behind it.
    var DS = tableau.DialogStyle || {};
    var style = cfg && cfg.interaction.dialog === 'floating' ? DS.Modeless : DS.Modal;
    if (style) options.dialogStyle = style;
    var done = function () {
      if (!liveActive) return;
      liveActive = false;
      // the dialog may have closed before its last save: the chart has its latest settings, so it saves them
      try {
        if (tableau.extensions.settings.get(Sk.STORAGE_KEY) !== JSON.stringify(cfg)) Sk.write(cfg).catch(function () { /* viewer: can't save */ });
      } catch (e) { /* ignore */ }
      paint();
    };
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).then(done, function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Sankey dialog:', err && err.message);
      done();
    });
  }

  /** What the dialog needs to list: level fields and parameters. */
  function dialogInfo (focus) {
    var info = { focus: focus || null, liveId: liveId, levels: [], params: [], valueName: '' };
    info.params = Object.keys(params).map(function (k) { return { name: params[k].name, value: params[k].value }; });
    if (!raw) return info;
    info.valueName = raw.valueName || '';
    info.levels = raw.levels.map(function (f, i) {
      return { key: f.key, name: f.name, count: graph ? graph.cols[i].length : 0 };
    });
    return info;
  }

  function fieldsSig (fields) {
    var out = {};
    Object.keys(fields).sort().forEach(function (k) {
      out[k] = fields[k].map(function (f) { return (f.id || '') + '|' + (f.name || ''); });
    });
    return JSON.stringify(out);
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  var TILES = ['levels', 'value', 'tooltip', 'detail'];

  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      var tFields = 0;
      var tData = 0;
      var fieldsP = getEncodedFields().then(function (r) { tFields = ms(); if (first) T.mark('fields received (Marks card)'); return r; });
      var dataP = readSummaryData().then(function (r) {
        tData = ms();
        if (first) T.mark('data received', (r && r.data ? r.data.length : 0) + ' rows');
        return r;
      }).catch(function (err) { tData = ms(); return { error: err }; });

      var results = await Promise.all([fieldsP, dataP]);
      if (token !== renderToken) return;
      var fields = results[0];

      var emptyMsg = null;
      if (fields.levels.length < 2) {
        emptyMsg = 'Drag two or more dimensions onto <b>Levels</b>, the outermost (left) one first<br>(e.g. <b>Channel</b>, <b>Category</b>, <b>Region</b>). ' +
          'Each one becomes a column of nodes.<br>Then drop one measure onto <b>Value</b>: it sets how thick the links are.';
      } else if (!fields.value.length) {
        emptyMsg = 'Drop one measure onto <b>Value</b> (e.g. <b>SUM(Sales)</b>): it sets how thick the links are.';
      }
      if (emptyMsg) {
        raw = null;
        graph = null;
        if (first) { T.mark('tiles not filled'); T.done('Sankey load timings'); }
        showEmpty(emptyMsg);
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      var prevSig = raw && raw.sig;
      raw = extract(table, fields);
      raw.sig = fieldsSig(fields);
      if (prevSig && prevSig !== raw.sig) { state.sel = null; state.hover = null; }
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Sankey load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Sankey render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Sankey load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = {};
    TILES.forEach(function (t) { fields[t] = []; });
    marks.encodings.forEach(function (e) {
      if (!e.field) return;
      var type = String(e.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : e.id;
      if (!fields[id]) return; // colour, size … are not used
      fields[id].push(e.field);
    });
    return fields;
  }

  /**
   * The worksheet's summary data, up to the row limit in the settings (Format → Card → Maximum
   * rows; 0 = all). When rows were left out, a small note says so in the corner.
   */
  var lastLimit = null;
  async function readSummaryData (extra) {
    var limit = ExtCore.rowLimit(cfg.data.maxRows);
    var table = await ExtCore.readSummary(worksheet, { limit: limit, columnsToIncludeById: extra && extra.columnsToIncludeById });
    if (!extra) { lastLimit = limit; ExtCore.rowNotice(table); }
    return table;
  }

  /** True when the row limit in the settings no longer matches the data that was read. */
  function limitChanged () {
    return lastLimit != null && ExtCore.rowLimit(cfg.data.maxRows) !== lastLimit;
  }

  function cellText (cell) {
    if (!cell) return null;
    var v = cell.value;
    if (v === null || v === undefined || v === '%null%') return null;
    var f = cell.formattedValue;
    if (f == null || f === '%null%') f = v;
    f = String(f);
    return f === '' ? null : f;
  }

  /**
   * Summary data → { levels: [{ key, name, fieldName }], valueName, extras: [{ key, name, num }],
   *                  rows: [{ p: [label | null per level], r: [raw value per level], v, x: [per extra], ri }], skipped }
   * Rows whose Value is empty, zero or negative are left out and counted in `skipped`.
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var reqs = [];
    var levels = fields.levels.map(function (f) {
      var r = { field: f, key: f.name, name: cleanName(f.name), col: null };
      reqs.push(r);
      return r;
    });
    var valReq = { field: fields.value[0], key: fields.value[0].name, name: cleanName(fields.value[0].name), col: null, num: true };
    reqs.push(valReq);
    var extras = [];
    var seen = {};
    levels.forEach(function (l) { seen[l.key] = 1; });
    seen[valReq.key] = 1;
    ['tooltip', 'detail'].forEach(function (t) {
      fields[t].forEach(function (f) {
        if (seen[f.name]) return;
        seen[f.name] = 1;
        var r = { field: f, key: f.name, name: cleanName(f.name), col: null };
        reqs.push(r);
        extras.push(r);
      });
    });
    reqs.forEach(function (r) { r.col = findColumn(table, r.field, taken); if (r.col) taken.push(r.col); });
    // renamed pills: unmatched fields take the free columns in order (the Value takes a numeric one first)
    var guessed = [];
    var free = function (pred) { return table.columns.find(function (c) { return taken.indexOf(c) < 0 && !isMN(c) && (!pred || pred(c)); }); };
    var take = function (r, c) { if (c) { r.col = c; taken.push(c); guessed.push(r.key + ' → ' + c.fieldName); } };
    if (!valReq.col) take(valReq, free(ExtCore.isNumericCol) || free());
    reqs.forEach(function (r) {
      if (r.col) return;
      take(r, free(function (c) { return !ExtCore.isNumericCol(c); }) || free());
    });
    if (guessed.length) console.info('Sankey: matched renamed fields by position:', guessed);

    var out = [];
    var skipped = 0;
    rows.forEach(function (row, ri) {
      var p = levels.map(function (l) { return l.col ? cellText(row[l.col.index]) : null; });
      if (p.every(function (v) { return v == null; })) return;
      var v = valReq.col ? ExtCore.toNumber(row[valReq.col.index]) : NaN;
      if (!(v > 0)) { skipped++; return; }
      var x = extras.map(function (e) {
        if (!e.col) return null;
        var cell = row[e.col.index];
        return ExtCore.isNumericCol(e.col) ? ExtCore.toNumber(cell) : cellText(cell);
      });
      var rv = levels.map(function (l) { return l.col && row[l.col.index] ? row[l.col.index].value : null; });
      out.push({ p: p, r: rv, v: v, x: x, ri: ri }); // ri: this row's position in the summary data as Tableau sent it
    });
    return {
      levels: levels.map(function (l) { return { key: l.key, name: l.name, fieldName: l.col ? l.col.fieldName : l.key }; }),
      valueName: valReq.name,
      extras: extras.map(function (e) { return { key: e.key, name: e.name, num: !!(e.col && ExtCore.isNumericCol(e.col)) }; }),
      rows: out,
      skipped: skipped
    };
  }

  // ---------------------------------------------------------------------------
  // Names
  // ---------------------------------------------------------------------------
  function nameCfg (i) { return (cfg.names && raw && cfg.names[raw.levels[i].key]) || {}; }
  function headerText (i) { var n = nameCfg(i); return n.header ? fillText(n.header) : raw.levels[i].name; }
  function legendName (i) {
    var n = nameCfg(i);
    if (n.legend) return n.legend;
    return cfg.legend.useHeaders ? headerText(i) : raw.levels[i].name;
  }


  // "Save as picture": PNG of the whole card, including the part scrolled out of view (full: true).
  var pictureBtn = null;
  function paintPictureButton () {
    if (cfg.export && cfg.export.picture) {
      if (!pictureBtn) {
        pictureBtn = ExtSnapshot.button({
          host: el.card,
          element: el.card,
          full: true,
          title: function () { return (el.title && el.title.textContent) || (worksheet && worksheet.name) || 'Sankey'; }
        });
      }
      pictureBtn.refresh();
    } else if (pictureBtn) {
      pictureBtn.destroy();
      pictureBtn = null;
    }
  }

  function applyFont (node, f) {
    node.style.fontFamily = Sk.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function cardBg () {
    var c = cfg.card;
    if (c.plotBgOpacity > 0) return Sk.rgba(c.plotBg, c.plotBgOpacity / 100);
    if (c.bgOpacity > 0) return Sk.rgba(c.bgColor, c.bgOpacity / 100);
    return '#FFFFFF';
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Sk.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.plot.style.marginTop = c.gap + 'px';
    el.plot.style.backgroundColor = c.plotBgOpacity > 0 ? Sk.rgba(c.plotBg, c.plotBgOpacity / 100) : 'transparent';
  }

  function paintHeader () {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';
    var iconH = 0;
    if (showIcon) {
      var t = Math.max(8, Math.min(128, Number(ic.size) || 24));
      if (ic.source === 'builtin') {
        var r = Sk.iconHtml(ic.builtinId, ic.color, t);
        el.icon.innerHTML = r.html;
        iconH = r.h;
      } else {
        var iw = ic.w || 1; var ih = ic.h || 1;
        var W = iw >= ih ? t : Math.max(1, Math.round(t * iw / ih));
        var H = iw >= ih ? Math.max(1, Math.round(t * ih / iw)) : t;
        if (ic.mask) {
          var mk = 'url(' + ic.dataUrl + ') center / contain no-repeat';
          el.icon.innerHTML = '<span style="display:block;width:' + W + 'px;height:' + H + 'px;background-color:' + ic.color +
            ';-webkit-mask:' + mk + ';mask:' + mk + '"></span>';
        } else {
          el.icon.innerHTML = '<img alt="" src="' + ic.dataUrl + '" style="width:' + W + 'px;height:' + H + 'px">';
        }
        iconH = H;
      }
    }

    var ti = cfg.title;
    applyFont(el.title, ti);
    el.title.textContent = fillText(ti.text) || 'Flow';
    el.title.style.textAlign = ti.align || 'left';
    el.title.style.display = ti.show === false ? 'none' : '';

    var ex = cfg.explanation;
    var exText = fillText(ex.text);
    var hasText = ex.show && !!exText;
    applyFont(el.explanation, ex);
    el.explanation.style.textAlign = ti.align || 'left';
    el.explanation.textContent = hasText ? exText : ' ';
    el.explanation.style.display = hasText || ex.reserveSpace ? '' : 'none';

    var head = el.icon.parentNode;
    var headVisible = showIcon || ti.show !== false || hasText || ex.reserveSpace;
    head.style.display = headVisible ? '' : 'none';
    head.classList.toggle('icon-span', hasText && iconH > (el.title.offsetHeight || 19) * 1.5);
  }

  // ---------------------------------------------------------------------------
  // Legend + search
  // ---------------------------------------------------------------------------
  /**
   * Keeps the legend from eating the chart: a horizontal legend shows at most
   * two rows and a vertical one stays a single column; the rest scrolls.
   */
  function capLegend (lg, vertical) {
    var s = lg.style;
    s.maxHeight = ''; s.overflowY = ''; s.overflowX = '';
    if (!lg.children.length || lg.offsetParent === null) return;
    if (vertical) {
      s.maxHeight = '100%'; s.overflowY = 'auto'; s.overflowX = 'hidden';
      if (lg.scrollHeight > lg.clientHeight + 1) s.justifyContent = 'flex-start'; // centred content can't scroll to its top
      return;
    }
    var rects = Array.prototype.map.call(lg.children, function (c) { return c.getBoundingClientRect(); })
      .filter(function (r) { return r.height > 0; })
      .sort(function (a, b) { return a.top - b.top; });
    var rows = [];
    rects.forEach(function (r) {
      var last = rows[rows.length - 1];
      if (!last || r.top >= last.bottom - 1) rows.push({ top: r.top, bottom: r.bottom });
      else last.bottom = Math.max(last.bottom, r.bottom);
    });
    if (rows.length <= 2) return;
    var cs = getComputedStyle(lg);
    var h = rows[1].bottom - lg.getBoundingClientRect().top + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
    s.maxHeight = Math.ceil(h + 1) + 'px';
    s.overflowY = 'auto'; s.overflowX = 'hidden';
  }

  function paintTools () {
    var lg = cfg.legend;
    var L = el.legend;
    L.innerHTML = '';
    L.style.fontFamily = Sk.fontStack(lg.font);
    L.style.fontSize = lg.size + 'px';
    L.style.color = lg.color;
    if (lg.show && cfg.nodes.colorBy === 'level') {
      raw.levels.forEach(function (f, i) {
        var it = document.createElement('span');
        it.className = 'lg-item';
        var sw = document.createElement('span');
        sw.className = 'lg-sw';
        sw.style.background = Sk.levelCfg(cfg, i).color;
        var tx = document.createElement('span');
        tx.textContent = legendName(i);
        it.append(sw, tx);
        L.appendChild(it);
      });
    }
    // where the legend goes
    var inHeader = lg.position === 'header';
    if (inHeader && L.parentNode !== el.tools) el.tools.insertBefore(L, el.searchbox);
    if (!inHeader && L.parentNode !== el.legendrow) el.legendrow.appendChild(L);
    el.legendrow.classList.toggle('is-on', !inHeader && L.children.length > 0);
    el.card.classList.toggle('legend-bottom', lg.position === 'bottom');
    capLegend(L, false);

    var S = cfg.search;
    el.searchbox.classList.toggle('is-on', !!S.show);
    el.search.placeholder = S.placeholder || '';
    el.search.style.width = Math.max(100, Number(S.width) || 180) + 'px';
    el.tools.classList.toggle('is-empty', !(inHeader && L.children.length) && !S.show);
  }


  // ---------------------------------------------------------------------------
  // Graph: nodes (members per level), links (summed Value between neighbouring members)
  // ---------------------------------------------------------------------------
  function matchText (s, q) { return String(s).toLowerCase().indexOf(q) >= 0; }

  function byName (a, b) { return String(a.label).localeCompare(String(b.label), undefined, { numeric: true, sensitivity: 'base' }); }

  /**
   * One node per (level, member); one link per pair of members that follow each other in a row
   * (levels with an empty member are jumped over, or show a "Null" node: data.nulls). The node's
   * value is the sum of the rows through it (= max of inflow / outflow), a link's value the sum
   * of the rows through both ends. Top N: smaller members of a level merge into "Others".
   */
  function buildGraph () {
    var K = raw.levels.length;
    var showNull = cfg.data.nulls === 'show';
    var topN = Math.max(0, Math.floor(Number(cfg.data.topN) || 0));
    var othersLabel = cfg.data.othersLabel || 'Others';

    var keep = null;
    if (topN > 0) {
      keep = [];
      for (var L0 = 0; L0 < K; L0++) {
        var tot = {};
        raw.rows.forEach(function (r) { var lab = r.p[L0]; if (lab != null) tot[lab] = (tot[lab] || 0) + r.v; });
        var names = Object.keys(tot);
        if (names.length <= topN + 1) { keep.push(null); continue; } // merging a single member into "Others" would gain nothing
        names.sort(function (a, b) { return tot[b] - tot[a]; });
        var set = {};
        names.slice(0, topN).forEach(function (nm) { set[nm] = true; });
        keep.push(set);
      }
    }

    var g = { nodes: [], edges: [], cols: [], byId: {}, edgeByKey: {}, rows: [], sum: 0, colTotal: [], skipped: raw.skipped };
    for (var c = 0; c < K; c++) g.cols.push([]);
    var node = function (L, label, rawv, flags) {
      var id = L + SEP + label;
      var n = g.byId[id];
      if (!n) {
        n = { id: id, L: L, label: label, raws: [], rawSeen: {}, isNull: !!flags.isNull, isOthers: !!flags.isOthers, value: 0, in: 0, out: 0, rows: [], ins: [], outs: [] };
        g.byId[id] = n;
        g.nodes.push(n);
        g.cols[L].push(n);
      }
      if (rawv != null && !n.isNull) {
        var k = typeof rawv + String(rawv);
        if (!n.rawSeen[k]) { n.rawSeen[k] = 1; n.raws.push(rawv); }
      }
      return n;
    };

    raw.rows.forEach(function (r) {
      var seq = [];
      for (var L = 0; L < K; L++) {
        var lab = r.p[L];
        var flags = {};
        if (lab == null) {
          if (!showNull) continue;
          lab = 'Null';
          flags.isNull = true;
        } else if (keep && keep[L] && !keep[L][lab]) {
          lab = othersLabel;
          flags.isOthers = true;
        }
        seq.push(node(L, lab, r.r[L], flags));
      }
      if (!seq.length) return;
      var idx = g.rows.length;
      g.rows.push({ v: r.v, x: r.x, ri: r.ri, seq: seq });
      g.sum += r.v;
      seq.forEach(function (n) { n.value += r.v; n.rows.push(idx); });
      for (var i = 0; i + 1 < seq.length; i++) {
        var a = seq[i]; var b = seq[i + 1];
        var key = a.id + SEP + b.id;
        var e = g.edgeByKey[key];
        if (!e) {
          e = { key: key, a: a, b: b, value: 0, rows: [] };
          g.edgeByKey[key] = e;
          g.edges.push(e);
          a.outs.push(e);
          b.ins.push(e);
        }
        e.value += r.v;
        e.rows.push(idx);
        a.out += r.v;
        b.in += r.v;
      }
    });
    g.cols.forEach(function (col, L) { g.colTotal[L] = col.reduce(function (s, n) { return s + n.value; }, 0); });
    orderColumns(g);
    return g;
  }

  /** Sorting inside a column: value (largest first), name, or flow (fewest crossings, weighted by the links' values). */
  function orderColumns (g) {
    var mode = cfg.data.sort;
    var cols = g.cols;
    var tail = function (n) { return n.isOthers ? 2 : n.isNull ? 1 : 0; }; // "Others" and "Null" sink to the bottom
    var base = function (a, b) { return tail(a) - tail(b) || (mode === 'name' ? byName(a, b) : b.value - a.value || byName(a, b)); };
    var renum = function (col) {
      var tot = col.reduce(function (s, n) { return s + n.value; }, 0) || 1;
      var acc = 0;
      col.forEach(function (n, i) { n.ord = i; n.frac = (acc + n.value / 2) / tot; acc += n.value; });
    };
    cols.forEach(function (col) { col.sort(base); renum(col); });
    if (mode !== 'flow' || cols.length < 2) return;

    var bary = function (n, side) {
      var s = 0; var w = 0;
      (side === 'left' ? n.ins : n.outs).forEach(function (e) {
        var o = side === 'left' ? e.a : e.b;
        s += o.frac * e.value; w += e.value;
      });
      return w ? s / w : null;
    };
    var sortCol = function (col, side) {
      var keyed = col.map(function (n) { var b = bary(n, side); return { n: n, k: b == null ? n.frac : b }; });
      keyed.sort(function (a, b) { return tail(a.n) - tail(b.n) || a.k - b.k || a.n.ord - b.n.ord; });
      keyed.forEach(function (x, i) { col[i] = x.n; });
      renum(col);
    };
    for (var it = 0; it < 6; it++) {
      for (var L = 1; L < cols.length; L++) sortCol(cols[L], 'left');
      for (var R = cols.length - 2; R >= 0; R--) sortCol(cols[R], 'right');
    }
    for (var L2 = 1; L2 < cols.length; L2++) sortCol(cols[L2], 'left');
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function sameItem (a, b) { return !!a && !!b && a.t === b.t && a.id === b.id; }
  function itemOf (it) { return it ? (it.t === 'n' ? graph.byId[it.id] : graph.edgeByKey[it.id]) : null; }

  function paint () {
    if (!cfg) return;
    if (!raw) return;
    lastSize = el.card.clientWidth + 'x' + el.card.clientHeight;
    el.card.classList.remove('is-empty');
    el.hint.innerHTML = '';
    hideTooltip();
    hoverTableau(null);

    graph = buildGraph();
    if (!graph.rows.length) {
      var more = raw.skipped ? '<br>' + skippedText(raw.skipped) + '.' : '';
      showEmpty('No rows with a positive <b>Value</b> to draw.' + more);
      return;
    }
    if (state.sel && !itemOf(state.sel)) state.sel = null;
    if (state.hover && !itemOf(state.hover)) state.hover = null;

    paintCard();
    paintHeader();
    paintTools();
    layoutAndDraw();
    applyHighlight();
    paintPictureButton();
    el.note.textContent = raw.skipped ? skippedText(raw.skipped) : '';
  }

  function skippedText (n) {
    return n.toLocaleString('en-US') + (n === 1 ? ' row' : ' rows') + ' with zero or negative values ' + (n === 1 ? 'is' : 'are') + ' not shown';
  }

  // ---------------------------------------------------------------------------
  // Layout + drawing (one SVG: links, nodes, labels, headers)
  // ---------------------------------------------------------------------------
  var measureCtx = null;
  var measureCache = {};
  function textWidth (text, font, size) {
    var key = font + '|' + size;
    var cache = measureCache[key] || (measureCache[key] = {});
    if (cache[text] != null) return cache[text];
    var w;
    try {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      measureCtx.font = font;
      w = measureCtx.measureText(text).width;
    } catch (e) { w = NaN; }
    if (!(w >= 0)) w = text.length * size * 0.56;
    cache[text] = w;
    return w;
  }

  function fitText (text, maxW, font, size) {
    if (textWidth(text, font, size) <= maxW) return text;
    var lo = 0; var hi = text.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (textWidth(text.slice(0, mid) + '…', font, size) <= maxW) lo = mid; else hi = mid - 1;
    }
    return lo > 0 ? text.slice(0, lo).replace(/\s+$/, '') + '…' : '';
  }

  /** Full-precision number for the tooltip. */
  function fullNumber (v) {
    var f = cfg.numbers;
    var t = ExtCore.fixed(v, Number.isInteger(v) ? 0 : 2);
    if (!f.unit) return t;
    return f.unitPosition === 'prefix' ? f.unit + ' ' + t : t + ' ' + f.unit;
  }

  function pct (v, total) { return total > 0 ? ExtCore.fixed(v / total * 100, v / total < 0.1 ? 1 : 0) + '%' : ''; }

  function nodeColors (g) {
    var N = cfg.nodes;
    if (N.colorBy === 'single') { g.nodes.forEach(function (n) { n.color = N.color; }); return; }
    if (N.colorBy !== 'first') { g.nodes.forEach(function (n) { n.color = Sk.levelCfg(cfg, n.L).color; }); return; }
    var pal = (N.palette && N.palette.length ? N.palette : Sk.PALETTE);
    var tot = {};
    g.rows.forEach(function (r) { var id = r.seq[0].id; tot[id] = (tot[id] || 0) + r.v; });
    var ids = Object.keys(tot).sort(function (a, b) { return tot[b] - tot[a]; });
    var idx = {};
    ids.forEach(function (id, i) { idx[id] = i; });
    g.nodes.forEach(function (n) {
      var w = {};
      n.rows.forEach(function (ri) { var id = g.rows[ri].seq[0].id; w[id] = (w[id] || 0) + g.rows[ri].v; });
      var best = null;
      Object.keys(w).forEach(function (id) { if (best == null || w[id] > w[best]) best = id; });
      n.color = pal[(idx[best] || 0) % pal.length];
    });
  }

  function layoutAndDraw () {
    var g = graph;
    var K = g.cols.length;
    var W = Math.max(60, el.plot.clientWidth);
    var Hall = Math.max(60, el.plot.clientHeight);
    var Hd = cfg.headers, N = cfg.nodes, Lb = cfg.labels, Nm = cfg.numbers;
    var hdrH = Hd.show ? Hd.size + 8 + (Hd.totals ? Hd.size : 0) : 0;
    var H = Math.max(40, Hall - hdrH - 4);
    var nodeW = Math.max(6, Math.min(40, Number(N.width) || 14));

    // margins: only a forced label side needs room outside the first / last column
    var maxLw = Math.max(40, Number(Lb.maxWidth) || 170);
    var padL = 2; var padR = 2;
    if (Lb.show && Lb.side === 'right') padR = Math.min(maxLw, W * 0.3) + 10;
    if (Lb.show && Lb.side === 'left') padL = Math.min(maxLw, W * 0.3) + 10;
    var pitch = K > 1 ? Math.max(10, (W - padL - padR - nodeW) / (K - 1)) : 0;

    // vertical scale: one px-per-unit for every column, so heights compare across columns
    var ky = Infinity;
    var gaps = [];
    g.cols.forEach(function (col, L) {
      var n = col.length;
      var gap = n > 1 ? Math.min(Number(N.gap) || 0, 0.35 * H / (n - 1)) : 0;
      gaps[L] = gap;
      var room = H - gap * (n - 1);
      var lo = 0; var hi = room / (g.colTotal[L] || 1);
      for (var it = 0; it < 28; it++) { // nodes never get thinner than 1 px: solve for the scale that still fits
        var mid = (lo + hi) / 2;
        var used = 0;
        col.forEach(function (nd) { used += Math.max(1, nd.value * mid); });
        if (used > room) hi = mid; else lo = mid;
      }
      ky = Math.min(ky, lo);
    });
    if (!isFinite(ky) || ky <= 0) ky = 0.0001;

    g.nodes.forEach(function (n, i) { n.i = i; });
    nodeColors(g);
    g.cols.forEach(function (col, L) {
      var total = 0;
      col.forEach(function (n) { n.h = Math.max(1, n.value * ky); total += n.h; });
      total += gaps[L] * (col.length - 1);
      var y = hdrH + Math.max(0, (H - total) / 2);
      col.forEach(function (n) { n.x = padL + L * pitch; n.y = y; y += n.h + gaps[L]; });
    });

    // link ports: stacked inside each node, ordered by where the other end is
    g.nodes.forEach(function (n) {
      n.outs.sort(function (p, q) { return (p.b.y + p.b.h / 2) - (q.b.y + q.b.h / 2) || p.b.L - q.b.L; });
      n.ins.sort(function (p, q) { return (p.a.y + p.a.h / 2) - (q.a.y + q.a.h / 2) || p.a.L - q.a.L; });
      var yo = n.y; var yi = n.y;
      n.outs.forEach(function (e) { e.t = e.value * ky; e.sy = yo; yo += e.t; });
      n.ins.forEach(function (e) { e.t = e.value * ky; e.ty = yi; yi += e.t; });
    });

    var bFont = Sk.fontStack(Lb.font);

    // gradients (only while there are few links: each one is its own definition)
    var gradient = cfg.links.color === 'gradient' && g.edges.length <= 600;
    var defs = [];
    var linkFill = function (e, i) {
      var c = cfg.links.color;
      if (c === 'single') return cfg.links.singleColor;
      if (c === 'target') return e.b.color;
      if (gradient) {
        var x0 = e.a.x + nodeW; var x1 = e.b.x;
        defs.push('<linearGradient id="g' + i + '" gradientUnits="userSpaceOnUse" x1="' + x0.toFixed(1) + '" x2="' + Math.max(x1, x0 + 1).toFixed(1) +
          '" y1="0" y2="0"><stop offset="0" stop-color="' + e.a.color + '"/><stop offset="1" stop-color="' + e.b.color + '"/></linearGradient>');
        return 'url(#g' + i + ')';
      }
      return e.a.color;
    };

    var f1 = function (v) { return v.toFixed(1); };
    var linkHtml = g.edges.map(function (e, i) {
      var x0 = e.a.x + nodeW; var x1 = e.b.x;
      var xm = (x0 + x1) / 2;
      var t = Math.max(e.t, 0.3);
      var d = 'M' + f1(x0) + ',' + f1(e.sy) + 'C' + f1(xm) + ',' + f1(e.sy) + ' ' + f1(xm) + ',' + f1(e.ty) + ' ' + f1(x1) + ',' + f1(e.ty) +
        'L' + f1(x1) + ',' + f1(e.ty + t) + 'C' + f1(xm) + ',' + f1(e.ty + t) + ' ' + f1(xm) + ',' + f1(e.sy + t) + ' ' + f1(x0) + ',' + f1(e.sy + t) + 'Z';
      return '<path class="lk" data-e="' + i + '" d="' + d + '" fill="' + linkFill(e, i) + '"/>';
    }).join('');

    var nodeHtml = g.nodes.map(function (n, i) {
      return '<rect class="nd" data-n="' + i + '" x="' + f1(n.x) + '" y="' + f1(n.y) + '" width="' + nodeW + '" height="' + f1(n.h) +
        '" rx="' + f1(Math.min(Number(N.radius) || 0, nodeW / 2, n.h / 2)) + '" fill="' + n.color + '"/>';
    }).join('');

    var labelHtml = Lb.show ? drawLabels(g, { K: K, W: W, H: H, hdrH: hdrH, padL: padL, pitch: pitch, nodeW: nodeW, maxLw: maxLw, bFont: bFont }) : '';

    // column headers (+ totals)
    var headHtml = '';
    if (Hd.show) {
      var hFont = Sk.fontStack(Hd.font);
      var hf = Hd.weight + ' ' + Hd.size + 'px ' + hFont;
      g.cols.forEach(function (col, L) {
        var last = L === K - 1 && K > 1;
        var x = last ? padL + L * pitch + nodeW : padL + L * pitch;
        var txt = headerText(L);
        if (Hd.uppercase) txt = txt.toUpperCase();
        var maxW = Math.max(30, (K > 1 ? pitch : W) - 8);
        var shown = fitText(txt, maxW - (Hd.spacing || 0) * Hd.size * txt.length, hf, Hd.size);
        headHtml += '<text class="hd" x="' + f1(x) + '" y="' + (Hd.size + 1) + '" text-anchor="' + (last ? 'end' : 'start') + '" fill="' + Hd.color +
          '" style="font-family:' + hFont + ';font-size:' + Hd.size + 'px;font-weight:' + Hd.weight + ';letter-spacing:' + (Hd.spacing || 0) + 'em">' +
          (shown !== txt ? '<title>' + esc(txt) + '</title>' : '') + esc(shown) + '</text>';
        if (Hd.totals) {
          headHtml += '<text class="hd-total" x="' + f1(x) + '" y="' + (Hd.size * 2 + 3) + '" text-anchor="' + (last ? 'end' : 'start') + '" fill="' + Lb.valueColor +
            '" style="font-family:' + Sk.fontStack(Nm.font) + ';font-size:' + Hd.size + 'px">' + esc(Sk.formatNumber(g.colTotal[L], Nm)) + '</text>';
        }
      });
    }

    var svg = el.svg;
    svg.setAttribute('width', W);
    svg.setAttribute('height', Hall);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + Hall);
    svg.innerHTML = (defs.length ? '<defs>' + defs.join('') + '</defs>' : '') + '<g class="g-links">' + linkHtml + '</g><g class="g-nodes">' + nodeHtml +
      '</g><g class="g-labels">' + labelHtml + '</g><g class="g-heads">' + headHtml + '</g>';
    g.W = W; g.H = Hall;
    var all = function (sel) { return svg.querySelectorAll ? Array.prototype.slice.call(svg.querySelectorAll(sel)) : []; };
    g.linkEls = all('.lk');
    g.nodeEls = all('.nd');
    g.labelEls = {};
    all('.lb').forEach(function (t) { g.labelEls[t.getAttribute('data-l')] = t; });
  }

  /**
   * Labels beside the nodes (right of the node, left in the last column; Format → Nodes & labels).
   * Biggest nodes first: a label that would touch one already placed drops to one line, then is hidden.
   */
  function drawLabels (g, m) {
    var Lb = cfg.labels, Nm = cfg.numbers;
    var K = m.K, pitch = m.pitch, nodeW = m.nodeW, bFont = m.bFont;
    var nameFont = Lb.weight + ' ' + Lb.size + 'px ' + bFont;
    var valSize = Math.max(7, Lb.size - 1);
    var valFont = Lb.valueWeight + ' ' + valSize + 'px ' + bFont;
    var lh1 = Math.round(Lb.size * 1.3);
    var lh2 = Math.round(Lb.size * 1.2 + valSize * 1.2);
    var halo = Lb.halo ? ' stroke="' + Lb.haloColor + '" stroke-width="3" stroke-linejoin="round" paint-order="stroke"' : '';
    var valAttr = ' font-size="' + valSize + '" font-weight="' + Lb.valueWeight + '" fill="' + Lb.valueColor + '"';
    var html = '';
    g.cols.forEach(function (col, L) {
      var side = Lb.side === 'right' ? 'right' : Lb.side === 'left' ? 'left' : (L === K - 1 && K > 1 ? 'left' : 'right');
      var avail;
      var facing = Lb.side === 'auto' && K > 1 && ((side === 'right' && L === K - 2) || (side === 'left' && L === K - 1));
      if (side === 'right') avail = L < K - 1 ? pitch - nodeW - 10 : m.W - (m.padL + L * pitch + nodeW + 6) - 2;
      else avail = L > 0 ? pitch - nodeW - 10 : m.padL + L * pitch - 6 - 2;
      if (facing) avail = (pitch - nodeW - 14) / 2; // two labels face each other across this gap
      avail = Math.min(avail, m.maxLw);
      if (avail < 26) return;
      var placed = [];
      col.slice().sort(function (p, q) { return q.value - p.value; }).forEach(function (n) {
        var cy = n.y + n.h / 2;
        var vs = [];
        if (Lb.showValue) vs.push(Sk.formatNumber(n.value, Nm));
        if (Lb.showPercent) vs.push(pct(n.value, g.colTotal[L]));
        var vline = vs.join(' · ');
        var tryH = vline ? [lh2, lh1] : [lh1];
        for (var k = 0; k < tryH.length; k++) {
          var hh = tryH[k];
          var top = Math.max(m.hdrH, Math.min(cy - hh / 2, m.hdrH + m.H - hh));
          if (placed.some(function (p) { return top < p[1] + 1 && top + hh > p[0] - 1; })) continue;
          var two = !!vline && hh === lh2;
          var x = (side === 'right' ? n.x + nodeW + 6 : n.x - 6).toFixed(1);
          var body;
          var shownAll = true;
          if (two) {
            var fn = fitText(n.label, avail, nameFont, Lb.size);
            var fv = fitText(vline, avail, valFont, valSize);
            shownAll = fn === n.label && fv === vline;
            if (!fn) continue;
            body = '<tspan x="' + x + '" y="' + (top + Lb.size * 0.95).toFixed(1) + '">' + esc(fn) + '</tspan>' +
              '<tspan x="' + x + '" y="' + (top + Lb.size * 1.2 + valSize * 0.95).toFixed(1) + '"' + valAttr + '>' + esc(fv) + '</tspan>';
          } else if (vline && textWidth(n.label + '  ' + vline, nameFont, Lb.size) <= avail) {
            body = '<tspan x="' + x + '" y="' + (top + Lb.size).toFixed(1) + '">' + esc(n.label) + '</tspan><tspan' + valAttr + ' dx="5">' + esc(vline) + '</tspan>';
          } else {
            var fn1 = fitText(n.label, avail, nameFont, Lb.size);
            if (!fn1) continue;
            shownAll = fn1 === n.label && !vline;
            body = '<tspan x="' + x + '" y="' + (top + Lb.size).toFixed(1) + '">' + esc(fn1) + '</tspan>';
          }
          placed.push([top, top + hh]);
          html += '<text class="lb" data-l="' + n.i + '" text-anchor="' + (side === 'right' ? 'start' : 'end') + '"' + halo + ' fill="' + Lb.color +
            '" style="font-family:' + bFont + ';font-size:' + Lb.size + 'px;font-weight:' + Lb.weight + '">' +
            (shownAll ? '' : '<title>' + esc(n.label + (vline ? ' · ' + vline : '')) + '</title>') + body + '</text>';
          break;
        }
      });
    });
    return html;
  }

  // ---------------------------------------------------------------------------
  // Highlight: hover / click an item, or search matches → lit nodes and links, the rest dims
  // ---------------------------------------------------------------------------
  /** Everything that flows through the item: for a node, every row through it; for a link, just the link and its two nodes. */
  function litFor (items) {
    var nodes = {}; var edges = {};
    items.forEach(function (it) {
      if (it.t === 'e') {
        var e = graph.edgeByKey[it.id];
        if (!e) return;
        edges[e.key] = 1; nodes[e.a.id] = 1; nodes[e.b.id] = 1;
        return;
      }
      var n = graph.byId[it.id];
      if (!n) return;
      nodes[n.id] = 1;
      n.rows.forEach(function (ri) {
        var seq = graph.rows[ri].seq;
        for (var i = 0; i < seq.length; i++) {
          nodes[seq[i].id] = 1;
          if (i + 1 < seq.length) edges[seq[i].id + SEP + seq[i + 1].id] = 1;
        }
      });
    });
    return { nodes: nodes, edges: edges };
  }

  function applyHighlight () {
    var g = graph;
    if (!g || !g.linkEls) return;
    var H = cfg.highlight;
    var q = String(state.query || '').trim().toLowerCase();
    var matches = {};
    var items = [];
    if (state.sel) items.push(state.sel);
    else if (H.hover && state.hover) items.push(state.hover);
    var searching = false;
    if (q) {
      var found = [];
      g.nodes.forEach(function (n) { if (matchText(n.label, q)) { matches[n.id] = 1; found.push({ t: 'n', id: n.id }); } });
      if (!items.length) { items = found; searching = true; }
    }
    var lit = items.length || searching ? litFor(items) : null;
    var baseOp = cfg.links.opacity / 100;
    var litOp = H.linkOpacity / 100;
    var dimOp = H.dimOpacity / 100;
    var strict = cfg.search.mode === 'filter' && searching;
    var nodeDim = strict ? 0.06 : Math.max(dimOp, 0.25);
    var linkDim = strict ? 0.02 : dimOp;
    g.edges.forEach(function (e, i) {
      var elx = g.linkEls[i];
      if (elx) elx.setAttribute('fill-opacity', String(lit ? (lit.edges[e.key] ? litOp : linkDim) : baseOp));
    });
    g.nodes.forEach(function (n, i) {
      var op = lit ? (lit.nodes[n.id] ? 1 : nodeDim) : 1;
      var ne = g.nodeEls[i];
      if (ne) {
        ne.setAttribute('opacity', String(op));
        if (matches[n.id]) { ne.setAttribute('stroke', H.matchColor); ne.setAttribute('stroke-width', '2'); }
        else { ne.removeAttribute('stroke'); ne.removeAttribute('stroke-width'); }
      }
      var le = g.labelEls && g.labelEls[i];
      if (le) le.setAttribute('opacity', String(op));
    });
  }

  function onSearch (jump) {
    var q = el.search.value;
    if (q === state.query && !jump) return;
    state.query = q;
    applyHighlight();
  }

  function setHover (it) {
    if (sameItem(it, state.hover)) return;
    state.hover = it;
    applyHighlight();
  }

  // ---------------------------------------------------------------------------
  // Hover, click, select
  // ---------------------------------------------------------------------------
  function itemFromEvent (e) {
    var t = e.target && e.target.closest ? e.target.closest('[data-n],[data-e]') : null;
    if (!t || !graph) return null;
    if (t.getAttribute('data-n') != null) { var n = graph.nodes[Number(t.getAttribute('data-n'))]; return n ? { t: 'n', id: n.id } : null; }
    var ed = graph.edges[Number(t.getAttribute('data-e'))];
    return ed ? { t: 'e', id: ed.key } : null;
  }

  function onHover (e) {
    var it = itemFromEvent(e);
    setHover(it);
    var obj = itemOf(it);
    if (obj && cfg.interaction.tableauTooltip && !tableauTooltipFailed) {
      hideTooltip();
      hoverTableau(obj, e.clientX, e.clientY);
      return;
    }
    hoverTableau(null);
    if (obj && cfg.tooltip.show) showTooltip(it, obj, e.clientX, e.clientY); else hideTooltip();
  }

  // Tableau's own tooltip. A node / link is built from many rows: it uses the first one,
  // graph.rows[i].ri = that row's 0-based position in the summary data as sent.
  var tableauTooltipRow = null;
  var tableauTooltipFailed = false;
  function hoverTableau (obj, x, y) {
    var ri = null;
    if (obj && obj.rows && obj.rows.length) { var r = graph.rows[obj.rows[0]]; if (r && r.ri != null) ri = r.ri; }
    if (ri === tableauTooltipRow) return; // only when the hovered row changes
    if (ri == null && tableauTooltipRow == null) return;
    tableauTooltipRow = ri;
    if (!cfg || tableauTooltipFailed || (ri != null && !cfg.interaction.tableauTooltip)) return;
    if (ExtCore.hoverTooltip(worksheet, ri, { x: x, y: y }) === false) { tableauTooltipFailed = true; tableauTooltipRow = null; }
  }

  function onClick (e) {
    if (e.detail > 1) return;
    var it = itemFromEvent(e);
    hideMenu();
    select(it && !sameItem(it, state.sel) ? it : null);
  }

  function onDblClick (e) {
    var it = itemFromEvent(e);
    if (!it || it.t !== 'n' || cfg.interaction.dblclick !== 'format') return;
    openDialog({ tab: 'levels', item: graph.byId[it.id].L });
  }

  function select (it) {
    state.sel = it;
    applyHighlight();
    if (!cfg.interaction.selectInTableau) return;
    var obj = itemOf(it);
    if (!obj) { clearTableauSelection(); return; }
    var sels = selectionFor(it.t === 'n' ? [obj] : [obj.a, obj.b]);
    if (sels.length) ExtCore.select(worksheet, sels, 'Sankey'); else clearTableauSelection();
  }

  /** A node → its member of the level's field (raw cell values; "Others" selects all its members). A link → both ends. "Null" has nothing to select. */
  function selectionFor (nodes) {
    var out = [];
    nodes.forEach(function (n) {
      if (n.isNull || !n.raws.length) return;
      out.push({ fieldName: raw.levels[n.L].fieldName, value: n.raws.slice() });
    });
    return out;
  }

  function clearTableauSelection () {
    ExtCore.clearSelection(worksheet);
  }

  // ---------------------------------------------------------------------------
  // Tooltip
  // ---------------------------------------------------------------------------
  /** Tooltip tile fields over the rows of a node / link: measures are summed, text lists the first values. */
  function extraRows (rowIdx) {
    var out = [];
    if (!cfg.tooltip.showDetails) return out;
    raw.extras.forEach(function (x, j) {
      if (x.num) {
        var s = 0; var any = false;
        rowIdx.forEach(function (ri) { var v = graph.rows[ri].x[j]; if (v != null && isFinite(v)) { s += v; any = true; } });
        if (any) out.push([x.name, fullNumber(s)]);
      } else {
        var vals = {};
        rowIdx.forEach(function (ri) { var v = graph.rows[ri].x[j]; if (v != null) vals[v] = 1; });
        var list = Object.keys(vals);
        if (list.length) out.push([x.name, list.length <= 3 ? list.join(', ') : list.length + ' values']);
      }
    });
    return out;
  }

  function showTooltip (it, obj, x, y) {
    var html;
    var rows = [];
    if (it.t === 'n') {
      var n = obj;
      html = '<div class="tt-level"><span class="lg-sw" style="background:' + n.color + '"></span>' + esc(headerText(n.L)) + '</div>' +
        '<div class="tt-name">' + esc(n.label) + '</div>';
      rows.push([raw.valueName, fullNumber(n.value)]);
      rows.push(['Share of ' + headerText(n.L), pct(n.value, graph.colTotal[n.L])]);
      rows = rows.concat(extraRows(n.rows));
    } else {
      var e = obj;
      html = '<div class="tt-level"><span class="lg-sw" style="background:' + e.a.color + '"></span>' + esc(headerText(e.a.L)) + ' → ' + esc(headerText(e.b.L)) + '</div>' +
        '<div class="tt-name">' + esc(e.a.label) + ' → ' + esc(e.b.label) + '</div>';
      rows.push([raw.valueName, fullNumber(e.value)]);
      rows.push(['Share of ' + e.a.label + ' outflow', pct(e.value, e.a.out)]);
      rows.push(['Share of ' + e.b.label + ' inflow', pct(e.value, e.b.in)]);
      rows = rows.concat(extraRows(e.rows));
    }
    html += '<div class="tt-rows">' + rows.map(function (r) {
      return '<div class="tt-row"><span class="nm">' + esc(r[0]) + '</span><span class="vl">' + esc(r[1]) + '</span></div>';
    }).join('') + '</div>';
    html += '<div class="tt-hint">click to ' + (sameItem(it, state.sel) ? 'clear' : 'select') + '</div>';
    var t = el.tooltip;
    t.innerHTML = html;
    t.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var w = t.offsetWidth; var h = t.offsetHeight;
    var left = x + 14; var top = y + 14;
    if (left + w > vw - 4) left = Math.max(4, x - w - 14);
    if (top + h > vh - 4) top = Math.max(4, y - h - 14);
    t.style.left = left + 'px';
    t.style.top = top + 'px';
  }

  function hideTooltip () { if (el.tooltip) el.tooltip.style.display = 'none'; }

  // ---------------------------------------------------------------------------
  // Right-click menu
  // ---------------------------------------------------------------------------
  function onContextMenu (e) {
    if (!cfg || !cfg.interaction.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    var it = itemFromEvent(e);
    var obj = itemOf(it);
    var items = [];
    if (obj) {
      var isNode = it.t === 'n';
      items.push({ head: isNode ? headerText(obj.L) + ' · ' + obj.label : obj.a.label + ' → ' + obj.b.label });
      items.push(sameItem(it, state.sel) ? ['Clear selection', function () { select(null); }] : ['Select', function () { select(it); }]);
      if (isNode) {
        items.push(['Search for “' + (obj.label.length > 30 ? obj.label.slice(0, 29) + '…' : obj.label) + '”', function () {
          el.search.value = obj.label; onSearch(true);
        }]);
        items.push(['Format level “' + headerText(obj.L) + '”…', function () { openDialog({ tab: 'levels', item: obj.L }); }]);
      }
      items.push(null);
    } else if (state.sel) {
      items.push(['Clear selection', function () { select(null); }], null);
    }
    if (state.query) items.push(['Clear search', function () { el.search.value = ''; onSearch(); }], null);
    items.push(['Levels & data…', function () { openDialog({ tab: 'levels' }); }],
      ['Nodes & labels…', function () { openDialog({ tab: 'nodes' }); }],
      ['Links & highlight…', function () { openDialog({ tab: 'links' }); }],
      ['Numbers…', function () { openDialog({ tab: 'numbers' }); }],
      null,
      ['Format extension…', function () { openDialog(null); }]);

    var m = el.menu;
    m.innerHTML = '';
    var prevSep = true;
    items.forEach(function (itm) {
      if (!itm) { if (!prevSep) m.appendChild(document.createElement('hr')); prevSep = true; return; }
      prevSep = false;
      if (itm.head) { var h = document.createElement('div'); h.className = 'menu-head'; h.textContent = itm.head; m.appendChild(h); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = itm[0];
      btn.addEventListener('click', function () { hideMenu(); itm[1](); });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    m.style.left = Math.max(2, Math.min(e.clientX, vw - m.offsetWidth - 4)) + 'px';
    m.style.top = Math.max(2, Math.min(e.clientY, vh - m.offsetHeight - 4)) + 'px';
  }

  function hideMenu () { if (el.menu) el.menu.style.display = 'none'; }

  // ---------------------------------------------------------------------------
  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  window.Sankey = { init: init, _state: state, _graph: function () { return graph; } };
})();
