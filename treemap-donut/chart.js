'use strict';

/**
 * Treemap & Donut — Tableau Viz Extension.
 *
 * Marks card tiles (declared in treemap-donut.trex):
 *   category  Category: 1-4 discrete dimensions = hierarchy levels, outermost first (required)
 *   value     Size: 1 measure (required)
 *   color     Colour: 0-1 measure that shades the tiles, e.g. growth % (optional)
 * Tableau's own Tooltip tile is accepted too (its fields only add rows).
 *
 * Draws the composition of a whole as a treemap, donut or pie. A click drills into a tile / slice
 * that has children (breadcrumb above the chart) and / or selects it in Tableau.
 * Header (icon, title, explanation) and card options are the same as the other extensions.
 * Everything else is set in the Format dialog (configure.html), which also opens from a right-click.
 */
(function () {
  // Shared helpers (shared/core.js); tested in tests/core.test.js.
  var esc = ExtCore.esc, toNumber = ExtCore.toNumber, isMN = ExtCore.isMN, isNumericCol = ExtCore.isNumericCol,
    norm = ExtCore.norm, cleanName = ExtCore.cleanName, findColumn = ExtCore.findColumn;

  var el = {};
  var worksheet = null;
  var cfg = null;
  var model = null; // see extract()
  var drawn = [];   // nodes as drawn: { node, kind, geom, g }
  var renderToken = 0;
  var path = [];    // names of the members drilled into, level 1 downwards
  var selected = null; // key of the node selected in Tableau
  var clickTimer = null;
  var SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    ['card', 'icon', 'title', 'explanation', 'crumbs', 'plot', 'svg', 'note', 'hint', 'tooltip', 'menu'].forEach(function (id) {
      el[id] = document.getElementById(id);
    });

    el.svg.addEventListener('mousemove', onHover);
    el.svg.addEventListener('mouseleave', onLeave);
    el.svg.addEventListener('contextmenu', onContextMenu);
    el.svg.addEventListener('click', onClick);
    document.addEventListener('click', function (e) {
      const path = e.composedPath ? e.composedPath() : [];
      if (selected && path.indexOf(el.svg) < 0 && path.indexOf(el.menu) < 0) clearPick();
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && selected) clearPick(); });
    el.svg.addEventListener('dblclick', onDblClick);
    document.addEventListener('mousedown', function (e) {
      if (!el.menu.contains(e.target)) hideMenu();
    });
    window.addEventListener('blur', hideMenu);

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
      cfg = Td.read();

      worksheet.addEventListener(tableau.TableauEventType.SummaryDataChanged, refresh);
      tableau.extensions.settings.addEventListener(
        tableau.TableauEventType.SettingsChanged,
        function () {
          cfg = Td.read();
          if (limitChanged()) refresh();
          else paint();
        }
      );

      if (window.ResizeObserver) {
        new ResizeObserver(function () { schedule(); }).observe(document.body);
      } else {
        window.addEventListener('resize', schedule);
      }
      return refresh();
    }).catch(function (err) {
      if (initDone) {
        console.error('Treemap & Donut failed to start:', err);
        showEmpty('Could not initialize the extension. Click the ! mark in the corner for details.');
        return;
      }
      initDone = true;
      clearTimeout(watchdog);
      clearTimeout(hintTimer);
      console.error('Treemap & Donut failed to initialize:', err);
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
  function schedule () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () { queued = false; paint(); });
  }

  // ---------------------------------------------------------------------------
  // Dialog
  // ---------------------------------------------------------------------------
  /**
   * Opens the Format dialog. `focus` ({ tab }) preselects a tab. The dialog gets the first-level
   * members as payload (for the per-member colours), because it can't read the worksheet itself.
   */
  function openDialog (focus) {
    hideMenu();
    var url = window.location.href.split(/[?#]/)[0].replace(/[^/]*$/, '') + 'configure.html' +
      (/[?&]mock\b/.test(location.search) ? '?mock' : '');
    var payload = JSON.stringify({
      focus: focus || null,
      levels: model ? model.levels : 0,
      dims: model ? model.dims.map(function (d) { return d.name; }) : [],
      hasColor: !!(model && model.hasColor),
      members: model && model.root ? model.root.children.slice(0, 60).map(function (c) { return c.name; }) : []
    });
    var options = { width: 600, height: 760 };
    // Modal keeps the Format window in front of Tableau until Done; the chart behind it still updates live.
    if (tableau.DialogStyle && tableau.DialogStyle.Modal) options.dialogStyle = tableau.DialogStyle.Modal;
    return tableau.extensions.ui.displayDialogAsync(url, payload, options).catch(function (err) {
      var closed = tableau.ErrorCodes && err && err.errorCode === tableau.ErrorCodes.DialogClosedByUser;
      if (!closed) console.warn('Treemap & Donut dialog:', err && err.message);
    });
  }

  // ---------------------------------------------------------------------------
  // Data
  // ---------------------------------------------------------------------------
  async function refresh () {
    var token = ++renderToken;
    var T = window.ExtTiming || { mark: function () {}, done: function () {}, line: function () {} };
    var t0 = performance.now();
    var first = token === 1;
    var ms = function () { return Math.round(performance.now() - t0); };
    if (first) T.mark('data requested');
    try {
      // Ask Tableau for the encodings and the data at the same time (one round trip instead of two).
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

      if (!fields.category.length || !fields.value.length) {
        model = null;
        if (first) { T.mark('tiles not filled'); T.done('Treemap & Donut load timings'); }
        showEmpty('Drag a dimension (or several, outermost first) onto <b>Category</b> and a measure onto <b>Size</b>.<br>' +
          'Optionally add a measure to <b>Colour</b> to shade the tiles.');
        return;
      }

      var table = results[1];
      if (table && table.error) throw table.error;

      model = extract(table, fields);
      if (selected && !nodeByKey(selected)) selected = null;
      var tp = performance.now();
      paint();
      if (first) {
        T.mark('live result drawn', 'draw ' + Math.round(performance.now() - tp) + ' ms');
        T.done('Treemap & Donut load timings');
      } else {
        T.line('refresh #' + token + ': fields ' + tFields + ' ms, data ' + tData + ' ms (' +
          (table.data ? table.data.length : 0) + ' rows), draw ' + Math.round(performance.now() - tp) + ' ms');
      }
    } catch (err) {
      console.error('Treemap & Donut render failed:', err);
      if (first) { T.mark('render failed', err && err.message); T.done('Treemap & Donut load timings'); }
      if (token === renderToken) showEmpty('Could not read the worksheet data. Click the ! mark in the corner for details.');
    }
  }

  async function getEncodedFields () {
    var spec = await worksheet.getVisualSpecificationAsync();
    var marks = spec.marksSpecifications[spec.activeMarksSpecificationIndex];
    var fields = { category: [], value: [], color: [], extra: [] };
    marks.encodings.forEach(function (enc) {
      if (!enc.field) return;
      // Built-in tiles (Tooltip, Detail) only add rows or tooltip text: matched to their columns, never read as categories.
      var type = String(enc.type || '').toLowerCase();
      var id = type && type !== 'custom' ? type : enc.id;
      if (id !== 'category' && id !== 'value' && id !== 'color') id = 'extra';
      fields[id].push(enc.field);
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

  /**
   * Fields that couldn't be matched by id or name get the columns nobody else
   * took, in order: dimensions prefer text/date columns, measures numeric ones.
   * This happens when a pill is renamed (double-click, "//New name"): Tableau
   * then reports the field and its data column under different names.
   */
  function matchLeftovers (table, reqs, taken, pivoted) {
    var free = function () {
      return table.columns.filter(function (c) { return taken.indexOf(c) < 0 && !isMN(c); });
    };
    var take = function (r, c) { if (c) { r.col = c; taken.push(c); r.guessed = true; } };
    // 1. dimensions → text / date columns
    reqs.forEach(function (r) {
      if (!r.col && r.dim) take(r, free().find(function (x) { return !isNumericCol(x); }));
    });
    // 2. measures → numeric columns (not when they come as Measure Names / Values)
    if (!pivoted) {
      reqs.forEach(function (r) {
        if (!r.col && !r.dim) take(r, free().find(isNumericCol));
      });
    }
    // 3. anything left (numeric dimensions, columns without a data type) → in order
    reqs.forEach(function (r) {
      if (!r.col && (r.dim || !pivoted)) take(r, free()[0]);
    });
    var guessed = reqs.filter(function (r) { return r.guessed; });
    if (guessed.length) {
      console.info('Treemap & Donut: matched renamed fields by position:', guessed.map(function (r) {
        return (r.field && r.field.name) + ' → ' + r.col.fieldName;
      }));
    }
  }

  /**
   * Summary data → a tree of nodes. Level 1 = the first Category field, and so on.
   * Node: { name, key, level, parent, children[], byName, v (size), cv (colour value), row (first
   * summary-data row, as sent), raw (cell value, for selecting in Tableau), fv, i (position in data order),
   * leaf }. Rows arrive last-to-first, so they are read backwards to get "as in the data".
   * Sizes of zero, negative or missing are left out (counted in model.excluded).
   */
  function extract (table, fields) {
    var rows = table.data || [];
    var taken = [];
    var dimReqs = fields.category.map(function (f) { return { field: f, dim: true, col: null }; });
    var vReq = { field: fields.value[0], dim: false, col: null };
    var cReq = fields.color[0] ? { field: fields.color[0], dim: false, col: null } : null;
    var all = dimReqs.concat([vReq], cReq ? [cReq] : []);
    all.forEach(function (r) {
      r.col = findColumn(table, r.field, taken);
      if (r.col) taken.push(r.col);
    });
    // Fields on the Tooltip / Detail tiles: take their columns out of the guessing below.
    fields.extra.forEach(function (f) { var c = findColumn(table, f, taken); if (c) taken.push(c); });
    matchLeftovers(table, all, taken, false);

    var used = dimReqs.filter(function (r) { return r.col; });
    var cols = used.map(function (r) { return r.col; });
    var L = cols.length;
    var m = {
      levels: L,
      dims: used.map(function (r) { return { name: cleanName(r.field.name), fieldName: r.col.fieldName }; }),
      valueName: cleanName(vReq.field.name),
      colorName: cReq ? cleanName(cReq.field.name) : '',
      hasColor: !!(cReq && cReq.col),
      excluded: 0,
      root: null,
      cvals: []
    };
    if (!L || !vReq.col) return m;

    function mk (parent, name, level, cell) {
      return {
        name: name, level: level, parent: parent, key: parent ? parent.key + '\u0001' + name : '',
        children: [], byName: Object.create(null), v: 0, nv: 0, cs: 0, cn: 0, cv: null, row: null,
        raw: cell ? cell.value : null, fv: null, cfv: null, i: parent ? parent.children.length : 0, leaf: false
      };
    }
    var root = mk(null, 'All', 0, null);
    var vi = vReq.col.index;
    var ci = cReq && cReq.col ? cReq.col.index : -1;
    for (var ri = rows.length - 1; ri >= 0; ri--) {
      var r = rows[ri];
      var n = root;
      for (var lvl = 0; lvl < L; lvl++) {
        var cell = r[cols[lvl].index];
        var name = cell && cell.formattedValue != null && cell.formattedValue !== '' ? String(cell.formattedValue) : '(blank)';
        var c = n.byName[name];
        if (!c) {
          c = mk(n, name, lvl + 1, cell);
          n.byName[name] = c;
          n.children.push(c);
        }
        if (c.row == null) c.row = ri;
        n = c;
      }
      var v = toNumber(r[vi]);
      if (isFinite(v)) { n.v += v; n.nv++; if (n.nv === 1) n.fv = r[vi].formattedValue; else n.fv = null; }
      if (ci >= 0) {
        var cv = toNumber(r[ci]);
        if (isFinite(cv)) { n.cs += cv; n.cn++; if (n.cfv == null) n.cfv = r[ci].formattedValue; }
      }
    }

    function fin (n) {
      if (n.level === L) {
        n.leaf = true;
        n.cv = n.cn ? n.cs / n.cn : null;
        if (!(n.nv > 0 && n.v > 0)) n.v = 0;
        else if (n.cv != null) m.cvals.push(n.cv);
        return;
      }
      var keep = [];
      var cs = 0;
      var cw = 0;
      n.v = 0;
      n.children.forEach(function (c) {
        fin(c);
        if (c.v > 0) {
          keep.push(c);
          n.v += c.v;
          if (c.cv != null) { cs += c.cv * c.v; cw += c.v; }
        } else if (c.leaf) m.excluded++;
      });
      n.children = keep;
      n.cv = cw ? cs / cw : null;
    }
    fin(root);
    m.root = root;
    return m;
  }

  // ---------------------------------------------------------------------------
  // View: which node is shown, which items it has, colours
  // ---------------------------------------------------------------------------
  /** The node the chart is drilled into (path = member names from level 1 down). */
  function resolveCur () {
    var n = model.root;
    var ok = [];
    for (var i = 0; i < path.length; i++) {
      var c = n.byName[path[i]];
      if (!c || !c.children.length || c.v <= 0) break;
      n = c;
      ok.push(path[i]);
    }
    path = ok;
    return n;
  }

  function chain (n) {
    var out = [];
    for (; n && n.parent; n = n.parent) out.unshift(n);
    return out;
  }

  var OTHERS_COLOR = '#B8BDC6';

  /**
   * The tiles / slices of `parent`: sorted, then the smallest grouped into one "Others" item
   * (always last) when there are more than Maximum items, or (donut / pie) when they are below the
   * threshold. One item alone is never grouped.
   */
  function viewItems (parent, donut) {
    var ch = cfg.chart;
    var list = Td.sortBy(parent.children, Td.comparer(ch.sort, function (n) { return n.v; }, function (n) { return n.name; }));
    var rest = [];
    var maxN = ch.maxItems > 0 ? ch.maxItems : Infinity;
    var drop = {};
    if (list.length > maxN) {
      list.map(function (n, i) { return { n: n, i: i }; }).sort(function (a, b) { return b.n.v - a.n.v || a.i - b.i; })
        .slice(maxN).forEach(function (x) { drop[x.i] = 1; });
    }
    var thr = donut && ch.othersThreshold > 0 ? ch.othersThreshold : 0;
    var keep = [];
    list.forEach(function (n, i) {
      if (drop[i] || (thr && n.v / parent.v * 100 < thr)) rest.push(n); else keep.push(n);
    });
    if (rest.length === 1) { keep.push(rest[0]); rest = []; }
    if (rest.length > 1) {
      var o = { name: 'Others', others: true, members: rest, level: parent.level + 1, parent: parent, key: parent.key + '\u0001\u0002others',
        children: [], v: 0, cv: null, row: rest[0].row, raw: null, leaf: true, fv: null };
      var cs = 0;
      var cw = 0;
      rest.forEach(function (n) { o.v += n.v; if (n.cv != null) { cs += n.cv * n.v; cw += n.v; } });
      o.cv = cw ? cs / cw : null;
      keep.push(o);
    }
    return keep;
  }

  function mix (a, b, t) { return ExtCore.mix(a, b, Math.max(0, Math.min(1, t))); }

  function colorMode () {
    var m = cfg.colors.mode;
    return m === 'measure' && !(model && model.hasColor) ? 'tint' : m;
  }

  /** Domain of the Colour measure over every leaf (stable while drilling). */
  function domain () {
    var C = cfg.colors;
    var lo = Infinity;
    var hi = -Infinity;
    model.cvals.forEach(function (v) { if (v < lo) lo = v; if (v > hi) hi = v; });
    if (!isFinite(lo)) { lo = 0; hi = 1; }
    if (C.rampMin === 'manual') lo = Number(C.rampMinValue);
    if (C.rampMax === 'manual') hi = Number(C.rampMaxValue);
    if (C.rampCenter) {
      var c = Number(C.rampCenterValue) || 0;
      if (C.rampMin !== 'manual' && lo > c) lo = c;
      if (C.rampMax !== 'manual' && hi < c) hi = c;
    }
    if (!(hi > lo)) hi = lo + 1;
    return { lo: lo, hi: hi };
  }

  function rampColor (v, d) {
    var C = cfg.colors;
    if (v == null || !isFinite(v)) return C.nullColor;
    if (C.rampCenter) {
      var c = Number(C.rampCenterValue) || 0;
      if (v <= c) return mix(C.rampLow, C.rampMid, c > d.lo ? (v - d.lo) / (c - d.lo) : 1);
      return mix(C.rampMid, C.rampHigh, d.hi > c ? (v - c) / (d.hi - c) : 0);
    }
    return mix(C.rampLow, C.rampHigh, (v - d.lo) / (d.hi - d.lo));
  }

  /** Fill colour of a node (cached per paint in n.col). */
  function nodeColor (n) {
    if (n.col) return n.col;
    var C = cfg.colors;
    var mode = colorMode();
    var col;
    if (mode === 'measure') {
      if (!model.dom) model.dom = domain();
      col = n.others && n.cv == null ? OTHERS_COLOR : rampColor(n.cv, model.dom);
    } else if (n.others) {
      col = OTHERS_COLOR;
    } else if (n.level <= 1) {
      var pal = C.palette && C.palette.length ? C.palette : Td.PALETTE;
      col = ExtCore.normalizeHex(C.overrides[n.name]) || ExtCore.normalizeHex(pal[n.i % pal.length]) || '#2F4B7C';
    } else if (mode === 'member') {
      col = nodeColor(n.parent);
    } else {
      col = mix(nodeColor(n.parent), '#FFFFFF', Math.min(0.6, C.tintStep / 100 * (1 + ((n.i % 3) - 1) * 0.5)));
    }
    n.col = col;
    return col;
  }

  function resetColors (n) {
    n.col = null;
    n.children.forEach(resetColors);
  }

  function fmtV (n) { return Td.formatNumber(n.v, cfg.format, { fv: n.fv }); }
  function fmtC (v, fv) { return Td.formatNumber(v, cfg.colorFormat, { fv: fv }); }
  function pct (x) {
    var p = x * 100;
    var d = cfg.labels.shareDecimals;
    if (d === 0 && p > 0 && p < 1) return '<1%';
    return ExtCore.fixed(p, d) + '%';
  }
  function shareOf (n) { return model.root.v > 0 ? n.v / model.root.v : 0; }
  function shareIn (n) { return n.parent && n.parent.v > 0 ? n.v / n.parent.v : 1; }

  /** Label lines of a node: { name, value, share } (each '' when switched off). */
  function labelParts (n) {
    var L = cfg.labels;
    var shares = [];
    if (L.shareParent) shares.push(pct(shareIn(n)) + ' of parent');
    if (L.shareTotal) shares.push(pct(shareOf(n)) + ' of total');
    return { name: L.name ? n.name : '', value: L.value ? fmtV(n) : '', share: shares.join(' · ') };
  }

  var picBtn = null;
  function syncPictureButton () {
    var on = !!(cfg.export && cfg.export.picture) && window.ExtSnapshot;
    if (!on) {
      if (picBtn) { picBtn.destroy(); picBtn = null; }
      return;
    }
    if (!picBtn) {
      picBtn = ExtSnapshot.button({
        host: el.card, element: el.card,
        title: function () { return (el.title && el.title.textContent) || (worksheet && worksheet.name) || 'Treemap & Donut'; },
        onError: function (err) { console.error(err); }
      });
      if (picBtn && picBtn.el) picBtn.el.setAttribute('data-snapshot', 'skip');
    }
    picBtn.refresh();
  }

  function applyFont (node, f) {
    node.style.fontFamily = Td.fontStack(f.font);
    node.style.fontSize = f.size + 'px';
    node.style.fontWeight = String(f.weight);
    node.style.fontStyle = f.italic ? 'italic' : 'normal';
    if (f.color) node.style.color = f.color;
  }

  function paintCard () {
    var c = cfg.card;
    el.card.style.padding = c.padding + 'px';
    el.card.style.backgroundColor = c.bgOpacity > 0 ? Td.rgba(c.bgColor, c.bgOpacity / 100) : 'transparent';
    el.card.style.borderRightColor = c.divider ? c.dividerColor : 'transparent';
    el.card.style.borderRightWidth = c.divider ? '1px' : '0';
    el.plot.style.marginTop = c.gap + 'px';
  }

  function paintHeader () {
    var ic = cfg.icon;
    var showIcon = ic.show && (ic.source === 'builtin' || ic.dataUrl);
    el.card.classList.toggle('no-icon', !showIcon);
    el.icon.style.display = showIcon ? '' : 'none';
    el.icon.innerHTML = '';

    if (showIcon) {
      if (ic.source === 'builtin') {
        var r = Td.iconHtml(ic.builtinId, ic.color, iconTarget());
        el.icon.innerHTML = r.html;
        setIconBox(r.w, r.h);
      } else {
        var img = new Image();
        img.alt = '';
        img.onload = function () { sizeImageIcon(img); };
        img.src = ic.dataUrl;
        el.icon.appendChild(img);
        if (img.complete) sizeImageIcon(img);
      }
    }

    applyFont(el.title, cfg.title);
    el.title.textContent = cfg.title.text || (model.valueName + ' by ' + model.dims.map(function (d) { return d.name; }).join(' › '));

    var ex = cfg.explanation;
    applyFont(el.explanation, ex);
    el.explanation.textContent = ex.text;
    el.explanation.style.display = ex.show && ex.text ? '' : 'none';
    updateIconSpan();
  }

  function sizeImageIcon (img) {
    var t = iconTarget();
    var w = img.naturalWidth || t;
    var h = img.naturalHeight || t;
    var W, H;
    if (w >= h) { W = t; H = Math.max(1, Math.round(t * h / w)); } else { H = t; W = Math.max(1, Math.round(t * w / h)); }
    img.style.width = W + 'px';
    img.style.height = H + 'px';
    setIconBox(W, H);
  }

  function iconTarget () {
    var n = Number(cfg.icon.size);
    return isFinite(n) && n > 0 ? Math.max(8, Math.min(128, n)) : 24;
  }

  var iconBoxH = 0;
  function setIconBox (w, h) {
    el.icon.style.width = w + 'px';
    el.icon.style.height = h + 'px';
    iconBoxH = h;
    updateIconSpan();
  }

  function updateIconSpan () {
    var head = el.icon.parentNode;
    var titleH = el.title.offsetHeight || 19;
    var hasExplanation = el.explanation.style.display !== 'none';
    head.classList.toggle('icon-span', hasExplanation && iconBoxH > titleH * 1.5);
  }

  function ellipsize (text, width, size, weight, family) {
    if (textWidth(text, size, weight, family) <= width) return text;
    var t = String(text).replace(/…$/, '');
    while (t.length > 1 && textWidth(t + '…', size, weight, family) > width) t = t.slice(0, -1);
    return t + '…';
  }

  function node (tag, attrs, text) {
    var n = document.createElementNS(SVGNS, tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] != null && attrs[k] !== '') n.setAttribute(k, attrs[k]);
    });
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------------------------------------------------------------------------
  // Paint
  // ---------------------------------------------------------------------------
  function paint () {
    if (!cfg || !model) return;
    if (!model.root || !model.root.children.length) {
      showEmpty(!model.levels || !model.root
        ? 'Could not match the Category and Size fields to the data. Check the tiles on the Marks card.'
        : 'No items with a positive size to show.' + (model.excluded ? '<br>' + model.excluded + ' item' + (model.excluded === 1 ? ' has' : 's have') + ' zero or negative size.' : ''));
      return;
    }
    el.card.classList.remove('is-empty');
    hideTooltip();
    resetColors(model.root);
    model.dom = null;
    var cur = resolveCur();
    paintCard();
    paintHeader();
    paintCrumbs();
    drawChart(cur);
    paintNote();
    syncPictureButton();
  }

  function paintNote () {
    var n = model.excluded;
    el.note.style.display = n ? 'block' : 'none';
    el.note.textContent = n ? n + ' item' + (n === 1 ? '' : 's') + ' with zero or negative size ' + (n === 1 ? 'is' : 'are') + ' not shown' : '';
  }

  function paintCrumbs () {
    var on = cfg.chart.breadcrumb && model.levels > 1;
    el.crumbs.style.display = on ? '' : 'none';
    if (!on) return;
    el.crumbs.innerHTML = '';
    el.crumbs.style.fontFamily = Td.fontStack(cfg.numbers.font);
    var names = [cfg.chart.rootName || 'All'].concat(path);
    names.forEach(function (nm, i) {
      if (i) el.crumbs.appendChild(textNode('span', 'sep', '›'));
      var last = i === names.length - 1;
      var c = textNode(last ? 'span' : 'button', 'crumb' + (last ? ' is-current' : ''), nm);
      c.title = nm;
      if (!last) {
        c.type = 'button';
        c.addEventListener('click', function () { goUp(i); });
      }
      el.crumbs.appendChild(c);
    });
  }

  function textNode (tag, cls, text) {
    var n = document.createElement(tag);
    n.className = cls;
    n.textContent = text;
    return n;
  }

  function goUp (depth) {
    path = path.slice(0, Math.max(0, depth));
    afterNav();
  }

  function afterNav () {
    hideTooltip();
    if (useTableauTip()) endTableauTip();
    paint();
  }

  // ---------------------------------------------------------------------------
  // Chart
  // ---------------------------------------------------------------------------
  var measureCtx = null;
  function textWidth (text, size, weight, family) {
    text = String(text);
    try {
      if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
      if (measureCtx && measureCtx.measureText) {
        measureCtx.font = (weight || 400) + ' ' + size + 'px ' + Td.fontStack(family);
        var w = measureCtx.measureText(text).width;
        if (w > 0) return w;
      }
    } catch (e) { /* no canvas */ }
    return text.length * size * 0.56;
  }

  function svgText (g, x, y, text, o) {
    var t = node('text', {
      x: x, y: y, 'text-anchor': o.anchor || 'start', 'font-family': Td.fontStack(o.family || cfg.labels.font),
      'font-size': o.size, 'font-weight': o.weight || 400, fill: o.fill, 'dominant-baseline': 'central',
      'font-style': o.italic ? 'italic' : null
    }, text);
    g.appendChild(t);
    return t;
  }

  function mkNode (n, kind, geom) {
    var g = node('g', { 'class': 'node', 'data-i': drawn.length });
    drawn.push({ node: n, kind: kind, geom: geom, g: g });
    el.svg.appendChild(g);
    if (!cfg.interaction.tooltip && !useTableauTip()) g.appendChild(node('title', {}, n.name + ': ' + fmtV(n)));
    return g;
  }

  function drawChart (cur) {
    var svg = el.svg;
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    drawn = [];
    centerRefs = null;
    var W = Math.max(1, el.plot.clientWidth);
    var H = Math.max(1, el.plot.clientHeight);
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    if (W < 40 || H < 40) return;

    var donut = cfg.chart.mode !== 'treemap';
    var items = viewItems(cur, donut);
    var plan = planLegend(W, H, items, donut);
    if (donut) drawDonut(cur, items, plan.box, W, H);
    else drawTreemap(cur, items, plan.box);
    drawLegend(plan);
    drawSelection();
  }

  // ---- Treemap ---------------------------------------------------------------
  /**
   * Squarified layout (Bruls, Huizing, van Wijk): items are placed in rows along the shorter side of
   * the free rectangle, a row grows while its worst aspect ratio improves. Sets it.x / y / w / h.
   */
  function squarify (items, rect) {
    var total = 0;
    items.forEach(function (it) { total += it.v; });
    if (!(total > 0) || !(rect.w > 0) || !(rect.h > 0)) {
      items.forEach(function (it) { it.x = rect.x; it.y = rect.y; it.w = 0; it.h = 0; });
      return;
    }
    var scale = rect.w * rect.h / total;
    var x = rect.x;
    var y = rect.y;
    var w = rect.w;
    var h = rect.h;
    var i = 0;
    var n = items.length;
    function worst (sum, mx, mn, side) {
      var s2 = side * side;
      return Math.max(s2 * mx / (sum * sum), sum * sum / (s2 * mn));
    }
    while (i < n) {
      var side = Math.min(w, h);
      var sum = 0;
      var mx = 0;
      var mn = Infinity;
      var best = Infinity;
      var j = i;
      while (j < n) {
        var a = items[j].v * scale;
        var s2 = sum + a;
        var w2 = worst(s2, Math.max(mx, a), Math.min(mn, a), side);
        if (j > i && w2 > best) break;
        sum = s2; mx = Math.max(mx, a); mn = Math.min(mn, a); best = w2; j++;
      }
      var k;
      if (w >= h) { // a column on the left
        var cw = Math.min(w, sum / h);
        var yy = y;
        for (k = i; k < j; k++) {
          var ih = items[k].v * scale / (cw || 1);
          items[k].x = x; items[k].y = yy; items[k].w = cw; items[k].h = ih;
          yy += ih;
        }
        x += cw; w -= cw;
      } else { // a row on the top
        var rh = Math.min(h, sum / w);
        var xx = x;
        for (k = i; k < j; k++) {
          var iw = items[k].v * scale / (rh || 1);
          items[k].x = xx; items[k].y = y; items[k].w = iw; items[k].h = rh;
          xx += iw;
        }
        y += rh; h -= rh;
      }
      i = j;
    }
  }

  function textFill (fill) {
    var L = cfg.labels;
    return L.colorMode === 'custom' ? L.color : Td.contrastText(fill);
  }

  function drawTreemap (cur, items, box) {
    var Ly = cfg.layout;
    var depth = Math.max(1, Math.min(2, Number(cfg.chart.depth) || 1));
    squarify(items, box);
    items.forEach(function (it) {
      var hasKids = depth >= 2 && !it.others && it.children.length > 0;
      var hh = Ly.headerHeight;
      var pad = Ly.padding;
      var inner = { x: it.x + pad, y: it.y + hh, w: it.w - 2 * pad, h: it.h - hh - pad };
      if (hasKids && inner.w >= 10 && inner.h >= 10 && it.w >= 24) {
        drawGroup(it, inner, hh);
      } else {
        drawTile(it, it);
      }
    });
  }

  function rectAttrs (r, fill) {
    var Ly = cfg.layout;
    var g = Ly.gap / 2;
    var w = Math.max(0, r.w - Ly.gap);
    var h = Math.max(0, r.h - Ly.gap);
    var rad = Math.max(0, Math.min(Ly.radius, w / 2, h / 2));
    return { x: r.x + g, y: r.y + g, width: w, height: h, rx: rad, ry: rad, fill: fill,
      stroke: Ly.borderWidth > 0 ? Ly.borderColor : null, 'stroke-width': Ly.borderWidth > 0 ? Ly.borderWidth : null };
  }

  function drawGroup (it, inner, hh) {
    var Lb = cfg.labels;
    var fill = nodeColor(it);
    var a = rectAttrs(it, fill);
    var g = mkNode(it, 'group', { tag: 'rect', attrs: a });
    a['class'] = 'shape';
    g.appendChild(node('rect', a));
    if (Lb.show && it.w >= Lb.minWidth * 0.6) {
      var txt = it.name + (Lb.value ? '  ' + fmtV(it) : '');
      var maxW = it.w - 2 * cfg.layout.padding - 8;
      var fs = Lb.headerSize;
      var tf = textFill(fill);
      var shown = ellipsize(it.name, maxW, fs, Lb.headerWeight, Lb.font);
      if (Lb.value && shown === it.name) {
        var both = ellipsize(txt, maxW, fs, Lb.headerWeight, Lb.font);
        if (both === txt) shown = txt;
      }
      if (maxW >= 16) svgText(g, it.x + cfg.layout.padding + 4, it.y + hh / 2 + cfg.layout.gap / 2, shown, { size: fs, weight: Lb.headerWeight, fill: tf });
    }
    var kids = viewItems(it, false);
    squarify(kids, inner);
    kids.forEach(function (k) { drawTile(k, k); });
  }

  /** A tile: one rectangle with its label (hidden when it does not fit). */
  function drawTile (n, r) {
    var Lb = cfg.labels;
    var fill = nodeColor(n);
    var a = rectAttrs(r, fill);
    if (a.width < 0.5 || a.height < 0.5) return;
    var g = mkNode(n, 'tile', { tag: 'rect', attrs: a });
    a['class'] = 'shape';
    g.appendChild(node('rect', a));
    if (!Lb.show || r.w < Lb.minWidth || r.h < Lb.minHeight) return;
    var parts = labelParts(n);
    var lines = [parts.name, parts.value, parts.share].filter(Boolean);
    if (!lines.length) return;
    var lh = Lb.size + 3;
    var room = Math.floor((r.h - 8) / lh);
    var maxW = r.w - 10;
    if (room < 1 || maxW < 16) return;
    var tf = textFill(fill);
    var first = parts.name ? 0 : -1;
    lines.slice(0, room).forEach(function (ln, i) {
      var bold = first === 0 && i === 0;
      svgText(g, r.x + 5 + cfg.layout.gap / 2, r.y + 4 + cfg.layout.gap / 2 + lh * i + lh / 2, ellipsize(ln, maxW, Lb.size, bold ? Lb.weight : 400, Lb.font),
        { size: Lb.size, weight: bold ? Lb.weight : 400, fill: tf });
    });
  }

  // ---- Donut / pie ---------------------------------------------------------------
  var centerRefs = null;

  function polar (cx, cy, r, a) { return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
  function f2 (n) { return Math.round(n * 100) / 100; }

  function arcPath (cx, cy, r0, r1, a0, a1) {
    var span = a1 - a0;
    if (span >= Math.PI * 2 - 0.0001) { // full ring: two half arcs each (a single arc can't close)
      var d = 'M' + f2(cx + r1) + ' ' + f2(cy) + 'A' + r1 + ' ' + r1 + ' 0 1 1 ' + f2(cx - r1) + ' ' + f2(cy) +
        'A' + r1 + ' ' + r1 + ' 0 1 1 ' + f2(cx + r1) + ' ' + f2(cy) + 'Z';
      if (r0 > 0) {
        d += 'M' + f2(cx + r0) + ' ' + f2(cy) + 'A' + r0 + ' ' + r0 + ' 0 1 0 ' + f2(cx - r0) + ' ' + f2(cy) +
          'A' + r0 + ' ' + r0 + ' 0 1 0 ' + f2(cx + r0) + ' ' + f2(cy) + 'Z';
      }
      return d;
    }
    var large = span > Math.PI ? 1 : 0;
    var p0 = polar(cx, cy, r1, a0);
    var p1 = polar(cx, cy, r1, a1);
    var d2 = 'M' + f2(p0[0]) + ' ' + f2(p0[1]) + 'A' + r1 + ' ' + r1 + ' 0 ' + large + ' 1 ' + f2(p1[0]) + ' ' + f2(p1[1]);
    if (r0 > 0) {
      var q1 = polar(cx, cy, r0, a1);
      var q0 = polar(cx, cy, r0, a0);
      d2 += 'L' + f2(q1[0]) + ' ' + f2(q1[1]) + 'A' + r0 + ' ' + r0 + ' 0 ' + large + ' 0 ' + f2(q0[0]) + ' ' + f2(q0[1]) + 'Z';
    } else {
      d2 += 'L' + f2(cx) + ' ' + f2(cy) + 'Z';
    }
    return d2;
  }

  function drawDonut (cur, items, box, W, H) {
    var Lb = cfg.labels;
    var Ly = cfg.layout;
    var pie = cfg.chart.mode === 'pie';
    var outside = Lb.show && Lb.donutPlacement === 'outside' && box.w >= 300 && box.h >= 170;
    var lw = outside ? Math.min(150, box.w * 0.27) : 4;
    var R = Math.max(16, Math.min((box.w - 2 * lw) / 2, box.h / 2 - 4));
    var cx = box.x + box.w / 2;
    var cy = box.y + box.h / 2;
    var r0 = pie ? 0 : R * (1 - Math.max(10, Math.min(90, Ly.thickness)) / 100);
    var total = 0;
    items.forEach(function (it) { total += it.v; });
    var a = -Math.PI / 2;
    var slices = [];
    items.forEach(function (it) {
      var span = it.v / total * Math.PI * 2;
      var pad = items.length > 1 ? Math.min(Ly.sliceGap / R / 2, span / 3) : 0;
      var s = { n: it, a0: a + pad, a1: a + span - pad, mid: a + span / 2 };
      a += span;
      var d = arcPath(cx, cy, r0, R, s.a0, s.a1);
      var g = mkNode(it, 'slice', { tag: 'path', attrs: { d: d } });
      var attrs = { d: d, fill: nodeColor(it), 'class': 'shape', 'fill-rule': 'evenodd',
        stroke: Ly.borderWidth > 0 ? Ly.borderColor : null, 'stroke-width': Ly.borderWidth > 0 ? Ly.borderWidth : null, 'stroke-linejoin': 'round' };
      g.appendChild(node('path', attrs));
      slices.push(s);
    });
    if (!pie && cfg.center.show && r0 >= 22) drawCenter(cur, cx, cy, r0);
    if (cfg.chart.mode === 'donut' && path.length) {
      // the hole is a button: back up one level
      el.svg.appendChild(node('circle', { 'class': 'hole', cx: cx, cy: cy, r: r0, fill: 'transparent' }));
    }
    if (outside) drawSliceLabels(slices, cx, cy, R, W, H, box);
  }

  function drawCenter(cur, cx, cy, r0) {
    var C = cfg.center;
    var g = node('g', { 'class': 'center' });
    el.svg.appendChild(g);
    var vs = Math.max(10, Math.min(C.valueSize, r0 * 0.55));
    centerRefs = { cur: cur, r0: r0, vs: vs, cx: cx, cy: cy };
    centerRefs.top = svgText(g, cx, cy - vs * 0.85, '', { anchor: 'middle', size: C.textSize, fill: C.textColor, family: cfg.numbers.font });
    centerRefs.val = svgText(g, cx, cy, '', { anchor: 'middle', size: vs, weight: C.valueWeight, fill: C.valueColor, family: cfg.numbers.font });
    centerRefs.sub = svgText(g, cx, cy + vs * 0.85, '', { anchor: 'middle', size: C.textSize, fill: C.textColor, family: cfg.numbers.font });
    setCenter(null);
  }

  /** Centre text: the total of what is shown, or the hovered slice. */
  function setCenter (n) {
    var c = centerRefs;
    if (!c) return;
    var C = cfg.center;
    var maxW = c.r0 * 1.7;
    var top;
    var val;
    var sub = '';
    if (n) {
      top = n.others ? 'Others (' + n.members.length + ')' : n.name;
      val = fmtV(n);
      sub = C.showShare ? pct(shareIn(n)) + (n.parent && n.parent.parent ? ' of ' + n.parent.name : '') : '';
    } else {
      top = path.length ? c.cur.name : C.title;
      val = Td.formatNumber(c.cur.v, cfg.format, { fv: c.cur.fv });
      if (!path.length && model.levels > 0) val = Td.formatNumber(c.cur.v, cfg.format);
    }
    c.top.textContent = ellipsize(top, maxW, C.textSize, 400, cfg.numbers.font);
    var size = c.vs;
    while (size > 9 && textWidth(val, size, C.valueWeight, cfg.numbers.font) > maxW) size -= 1;
    c.val.setAttribute('font-size', size);
    c.val.textContent = val;
    c.sub.textContent = ellipsize(sub, maxW, C.textSize, 400, cfg.numbers.font);
  }

  /**
   * Labels outside the ring, in a column on each side joined to the slice by a leader line. Each
   * column is spread vertically so labels never overlap; when they do not all fit, the smallest
   * slices lose their label first (they are still in the tooltip).
   */
  function drawSliceLabels (slices, cx, cy, R, W, H, box) {
    var Lb = cfg.labels;
    var lh = Lb.size + 3;
    var gap = 3;
    var top = box.y + 2;
    var bottom = box.y + box.h - 2;
    var sides = { r: [], l: [] };
    slices.forEach(function (s) {
      var parts = labelParts(s.n);
      var line2 = [parts.value, parts.share].filter(Boolean).join(' · ');
      s.lines = [parts.name, line2].filter(Boolean);
      if (!s.lines.length) return;
      s.h = s.lines.length * lh;
      s.right = Math.cos(s.mid) >= 0;
      s.p0 = polar(cx, cy, R, s.mid);
      s.p1 = polar(cx, cy, R + 9, s.mid);
      (s.right ? sides.r : sides.l).push(s);
    });
    ['r', 'l'].forEach(function (k) {
      var list = sides[k];
      var need = function () { return list.reduce(function (t, s) { return t + s.h + gap; }, 0); };
      while (list.length && need() > bottom - top) {
        var smallest = list.reduce(function (m, s) { return s.n.v < m.n.v ? s : m; }, list[0]);
        list.splice(list.indexOf(smallest), 1);
      }
      list.sort(function (a, b) { return a.p1[1] - b.p1[1]; });
      var prev = top;
      list.forEach(function (s) {
        s.y = Math.max(s.p1[1], prev + s.h / 2);
        prev = s.y + s.h / 2 + gap;
      });
      var next = bottom;
      for (var i = list.length - 1; i >= 0; i--) {
        var s = list[i];
        s.y = Math.min(s.y, next - s.h / 2);
        next = s.y - s.h / 2 - gap;
      }
      list.forEach(function (s) {
        var tx = k === 'r' ? cx + R + 16 : cx - R - 16;
        var avail = k === 'r' ? box.x + box.w - tx - 2 : tx - box.x - 2;
        if (avail < 18) return;
        var g = node('g', { 'class': 'leader' });
        g.appendChild(node('polyline', { points: f2(s.p0[0]) + ',' + f2(s.p0[1]) + ' ' + f2(s.p1[0]) + ',' + f2(s.p1[1]) + ' ' +
          f2(tx + (k === 'r' ? -4 : 4)) + ',' + f2(s.y), fill: 'none', stroke: '#B8BDC6', 'stroke-width': 1 }));
        s.lines.forEach(function (ln, i2) {
          var bold = i2 === 0 && cfg.labels.name;
          svgText(g, tx, s.y - s.h / 2 + lh * i2 + lh / 2, ellipsize(ln, avail, Lb.size, bold ? Lb.weight : 400, Lb.font),
            { anchor: k === 'r' ? 'start' : 'end', size: Lb.size, weight: bold ? Lb.weight : 400, fill: Lb.color });
        });
        el.svg.appendChild(g);
      });
    });
  }

  // ---- Legend ----------------------------------------------------------------------
  /**
   * Reserves room for the legend (right column / bottom strip) and the Colour ramp bar, and returns
   * the rest as the chart box. Nothing is reserved when the frame is too small for it.
   */
  function planLegend (W, H, items, donut) {
    var Lg = cfg.legend;
    var pos = Lg.position;
    if (donut && cfg.labels.donutPlacement === 'legend' && pos === 'off') pos = 'right';
    var measure = colorMode() === 'measure';
    var plan = { box: { x: 0, y: 0, w: W, h: H }, pos: 'off', entries: [], ramp: null, size: Lg.size };
    var bottom = 0;
    if (measure && H >= 110) {
      bottom = 30;
      plan.ramp = { y: H - 28 };
    } else if (!measure && pos !== 'off') {
      var entries = items.map(function (n) { return { name: n.others ? 'Others (' + n.members.length + ')' : n.name, color: nodeColor(n) }; });
      if (pos === 'right' && W >= 320) {
        var lw = Math.max(90, Math.min(170, Math.round(W * 0.25)));
        plan.pos = 'right';
        plan.w = lw;
        plan.entries = entries;
        plan.box.w = W - lw;
      } else if (pos !== 'off' && H >= 150) {
        var flow = legendFlow(entries, W);
        plan.pos = 'bottom';
        plan.flow = flow;
        bottom = flow.rows * (Lg.size + 6) + 6;
      }
    }
    plan.box.h = H - bottom;
    plan.bottom = bottom;
    return plan;
  }

  function legendFlow (entries, W) {
    var Lg = cfg.legend;
    var rowH = Lg.size + 6;
    var maxRows = 2;
    var x = 4;
    var row = 0;
    var placed = [];
    var maxN = Math.max(1, Lg.maxItems);
    for (var i = 0; i < entries.length && i < maxN; i++) {
      var w = Math.min(130, textWidth(entries[i].name, Lg.size, 400, cfg.numbers.font)) + 22;
      if (x + w > W - 4 && x > 4) { row++; x = 4; }
      if (row >= maxRows) break;
      placed.push({ e: entries[i], x: x, row: row, w: w });
      x += w;
    }
    return { placed: placed, rows: placed.length ? placed[placed.length - 1].row + 1 : 0, rowH: rowH, more: entries.length - placed.length };
  }

  function drawLegend (plan) {
    var Lg = cfg.legend;
    var fam = cfg.numbers.font;
    var g = node('g', { 'class': 'legend' });
    el.svg.appendChild(g);
    if (plan.ramp) {
      var d = model.dom || (model.dom = domain());
      var W = el.plot.clientWidth;
      var bw = Math.min(180, W - 16);
      var x = (W - bw) / 2;
      var y = plan.ramp.y;
      var C = cfg.colors;
      var defs = node('defs', {});
      var grad = node('linearGradient', { id: 'tdRamp', x1: '0', x2: '1', y1: '0', y2: '0' });
      grad.appendChild(node('stop', { offset: '0', 'stop-color': C.rampLow }));
      if (C.rampCenter) {
        var off = Math.max(0, Math.min(1, ((Number(C.rampCenterValue) || 0) - d.lo) / (d.hi - d.lo)));
        grad.appendChild(node('stop', { offset: f2(off), 'stop-color': C.rampMid }));
      }
      grad.appendChild(node('stop', { offset: '1', 'stop-color': C.rampHigh }));
      defs.appendChild(grad);
      g.appendChild(defs);
      g.appendChild(node('rect', { x: x, y: y, width: bw, height: 8, rx: 2, fill: 'url(#tdRamp)' }));
      svgText(g, x, y + 17, fmtC(d.lo), { size: 10, fill: Lg.color, family: fam });
      svgText(g, x + bw, y + 17, fmtC(d.hi), { size: 10, fill: Lg.color, family: fam, anchor: 'end' });
      if (model.colorName) svgText(g, x + bw / 2, y + 17, ellipsize(model.colorName, bw - 80, 10, 400, fam), { size: 10, fill: Lg.color, family: fam, anchor: 'middle' });
      return;
    }
    if (plan.pos === 'right') {
      var rowH = Lg.size + 6;
      var x0 = el.plot.clientWidth - plan.w + 6;
      var fit = Math.max(1, Math.floor((el.plot.clientHeight - 8) / rowH));
      var maxN = Math.min(Math.max(1, Lg.maxItems), fit);
      var list = plan.entries.slice(0, maxN);
      var more = plan.entries.length - list.length;
      if (more > 0 && list.length > 1) { list = list.slice(0, list.length - 1); more++; }
      var y0 = Math.max(4, (el.plot.clientHeight - (list.length + (more > 0 ? 1 : 0)) * rowH) / 2);
      list.forEach(function (e, i) {
        g.appendChild(node('rect', { x: x0, y: y0 + i * rowH + (rowH - 10) / 2, width: 10, height: 10, rx: 2, fill: e.color }));
        svgText(g, x0 + 16, y0 + i * rowH + rowH / 2, ellipsize(e.name, plan.w - 26, Lg.size, 400, fam), { size: Lg.size, fill: Lg.color, family: fam });
      });
      if (more > 0) svgText(g, x0 + 16, y0 + list.length * rowH + rowH / 2, '+' + more + ' more', { size: Lg.size, fill: Lg.color, family: fam, italic: true });
    } else if (plan.pos === 'bottom') {
      var fl = plan.flow;
      var yb = el.plot.clientHeight - plan.bottom + 4;
      fl.placed.forEach(function (p) {
        var yy = yb + p.row * fl.rowH + fl.rowH / 2;
        g.appendChild(node('rect', { x: p.x, y: yy - 5, width: 10, height: 10, rx: 2, fill: p.e.color }));
        svgText(g, p.x + 15, yy, ellipsize(p.e.name, p.w - 18, Lg.size, 400, fam), { size: Lg.size, fill: Lg.color, family: fam });
      });
    }
  }


  // ---------------------------------------------------------------------------
  // Selection, drilling, hover
  // ---------------------------------------------------------------------------
  function nodeByKey (key) {
    var found = null;
    (function walk (n) {
      if (found) return;
      if (n.key === key) { found = n; return; }
      n.children.forEach(walk);
    })(model.root);
    return found;
  }

  function nodeFromEvent (e) {
    var g = e.target && e.target.closest ? e.target.closest('.node') : null;
    if (!g) return null;
    var d = drawn[Number(g.getAttribute('data-i'))];
    return d ? d.node : null;
  }

  /** Outline around the node selected in Tableau (drawn on top, never catches the mouse). */
  function drawSelection () {
    if (!selected) return;
    drawn.forEach(function (d) {
      if (d.node.key !== selected) return;
      var attrs = {};
      for (var k in d.geom.attrs) attrs[k] = d.geom.attrs[k];
      attrs.fill = 'none';
      attrs.stroke = '#17202B';
      attrs['stroke-width'] = 2;
      attrs['pointer-events'] = 'none';
      attrs['class'] = 'pick';
      el.svg.appendChild(node(d.geom.tag, attrs));
    });
  }

  function canDrill (n) { return !!n && !n.others && n.children.length > 0; }

  function drillInto (n) {
    path = chain(n).map(function (c) { return c.name; });
    afterNav();
  }

  /** Selects a node in Tableau: every level's value down to the node ("Others": all its members at its level). */
  function selectNode (n) {
    if (!cfg.interaction.selectInTableau || !model.dims.length) return;
    var sel = [];
    if (n.others) {
      chain(n.parent).forEach(function (c, i) { sel.push({ fieldName: model.dims[i].fieldName, value: [c.raw] }); });
      sel.push({ fieldName: model.dims[n.level - 1].fieldName, value: n.members.map(function (m) { return m.raw; }) });
    } else {
      chain(n).forEach(function (c, i) { sel.push({ fieldName: model.dims[i].fieldName, value: [c.raw] }); });
    }
    selected = n.key;
    ExtCore.select(worksheet, sel, 'Treemap & Donut');
    paint();
  }

  function clearPick () {
    if (!selected) return;
    selected = null;
    ExtCore.clearSelection(worksheet);
    paint();
  }

  function onClick (e) {
    if (!cfg || !model || !model.root || el.menu.style.display === 'block') return;
    if (e.detail > 1) return; // second click of a double-click: onDblClick handles it
    var how = cfg.interaction.click;
    var hole = e.target.closest && e.target.closest('.hole');
    if (hole) { if (path.length) goUp(path.length - 1); return; }
    var n = nodeFromEvent(e);
    if (!n) { clearPick(); return; }
    clearTimeout(clickTimer);
    if (how === 'drill') {
      if (canDrill(n)) drillInto(n); else if (selected === n.key) clearPick(); else selectNode(n);
    } else if (how === 'select') {
      if (selected === n.key) clearPick(); else selectNode(n);
    } else { // both: a single click selects, a double click drills (waits to tell them apart)
      clickTimer = setTimeout(function () {
        if (selected === n.key) clearPick(); else selectNode(n);
      }, 250);
    }
  }

  function onDblClick (e) {
    if (!cfg || !model || cfg.interaction.click !== 'both') return;
    clearTimeout(clickTimer);
    var n = nodeFromEvent(e);
    if (canDrill(n)) drillInto(n);
  }

  // Tableau's own tooltip (Format → Interaction → Use Tableau's tooltip).
  // Mark → row: index in the summary data exactly as Tableau sent it (0-based); the node's first row.
  var hoverRow = -2;      // last row sent to Tableau (-2 = nothing sent yet)
  var tableauTipBroken = false; // this Tableau has no hoverTupleAsync: use our own tooltip

  function useTableauTip () {
    return !!(cfg && cfg.interaction && cfg.interaction.tableauTooltip) && !tableauTipBroken;
  }

  function sendHoverRow (row, e) {
    if (row === hoverRow) return;
    hoverRow = row;
    if (!ExtCore.hoverTooltip(worksheet, row, { x: e ? e.clientX : 0, y: e ? e.clientY : 0 })) {
      tableauTipBroken = true;
      hoverRow = -2;
    }
  }

  function endTableauTip () {
    if (hoverRow !== -2 && hoverRow !== null) ExtCore.hoverTooltip(worksheet, null);
    hoverRow = -2;
  }

  var centerShown = null;
  function onLeave () {
    hideTooltip();
    if (centerShown) { centerShown = null; setCenter(null); }
    if (useTableauTip()) endTableauTip();
  }

  function tooltipHtml (n) {
    var names = chain(n).map(function (c) { return c.name; });
    if (n.others) names[names.length - 1] = 'Others (' + n.members.length + ')';
    var html = '<div class="tt-name">' + esc(names.join(' › ')) + '</div>';
    html += '<div class="tt-value" style="color:' + nodeColor(n) + '">' + esc(fmtV(n)) + '</div>';
    if (n.parent && n.parent.parent) html += '<div class="tt-note">' + esc(pct(shareIn(n))) + ' of ' + esc(n.parent.name) + '</div>';
    html += '<div class="tt-note">' + esc(pct(shareOf(n))) + ' of total</div>';
    if (model.hasColor && n.cv != null) {
      html += '<div class="tt-note">' + esc(model.colorName) + ': ' + esc(fmtC(n.cv, n.children.length ? null : n.cfv)) + '</div>';
    }
    if (n.others) html += '<div class="tt-note">' + n.members.length + ' smaller items grouped</div>';
    else if (n.children.length) html += '<div class="tt-note">' + n.children.length + ' item' + (n.children.length === 1 ? '' : 's') + ' inside' +
      (cfg.interaction.click !== 'select' ? ' — click to open' : '') + '</div>';
    return html;
  }

  function onHover (e) {
    if (!cfg || !model || el.menu.style.display === 'block') return;
    var n = nodeFromEvent(e);
    if (cfg.chart.mode === 'donut' && cfg.center.hover) {
      var want = n && n.kind !== 'group' ? n : null;
      if (want !== centerShown) { centerShown = want; setCenter(want); }
    }
    if (useTableauTip()) {
      hideTooltip();
      sendHoverRow(n && n.row != null ? n.row : null, e);
      if (useTableauTip()) return; // else: this Tableau cannot do it, fall through to our tooltip
    }
    if (!cfg.interaction.tooltip) return;
    if (!n) { hideTooltip(); return; }
    var tt = el.tooltip;
    tt.innerHTML = tooltipHtml(n);
    tt.style.fontFamily = Td.fontStack(cfg.numbers.font);
    tt.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    var tw = tt.offsetWidth;
    var th = tt.offsetHeight;
    var left = Math.min(Math.max(4, e.clientX + 12), vw - tw - 4);
    var top = e.clientY - th - 12;
    if (top < 4) top = Math.min(e.clientY + 16, vh - th - 4);
    tt.style.left = left + 'px';
    tt.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip () {
    if (el.tooltip) el.tooltip.style.display = 'none';
  }

  function onContextMenu (e) {
    if (!cfg || !cfg.interaction.rightClickMenu) return;
    e.preventDefault();
    hideTooltip();
    var items = [
      ['Chart…', { tab: 'chart' }],
      ['Colours…', { tab: 'colors' }],
      ['Labels…', { tab: 'labels' }],
      ['Numbers…', { tab: 'numbers' }],
      null,
      ['Format extension…', null]
    ];
    var m = el.menu;
    m.innerHTML = '';
    items.forEach(function (it) {
      if (!it) { m.appendChild(document.createElement('hr')); return; }
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = it[0];
      btn.addEventListener('click', function () { openDialog(it[1]); });
      m.appendChild(btn);
    });
    m.style.display = 'block';
    var vw = document.documentElement.clientWidth;
    var vh = document.documentElement.clientHeight;
    m.style.left = Math.min(e.clientX, vw - m.offsetWidth - 4) + 'px';
    m.style.top = Math.min(e.clientY, vh - m.offsetHeight - 4) + 'px';
  }

  function hideMenu () {
    if (el.menu) el.menu.style.display = 'none';
  }

  function showEmpty (html) {
    el.card.classList.add('is-empty');
    hideTooltip();
    el.hint.innerHTML = html;
  }

  window.TreemapDonut = { init: init };
})();
