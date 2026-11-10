'use strict';

/**
 * Format dialog for the Waterfall extension ("Format Extension" on the Marks
 * card, or right-click / double-click a bar in the chart).
 *
 * Every change is saved straight away (debounced), so the chart behind the
 * modeless dialog updates live. Cancel restores what was stored on open.
 * The chart passes the current bars and breakdown members as the dialog
 * payload, because a dialog can't read the worksheet.
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var activeTab = 'bars';
  var shapeIndex = null;
  var info = { bars: [], dims: [], combos: [], hasBreakdown: false, focus: null };
  var selectedBar = '__start';

  var WEIGHTS = ExtDialog.WEIGHTS;

  // Controls shared by every Format dialog: shared/dialog.js.
  const kit = ExtDialog.kit({
    get: get,
    set: set,
    fonts: Wf.FONTS
  });
  const h = ExtDialog.h, P = ExtDialog.P, group = ExtDialog.group, help = ExtDialog.help,
    escapeHtml = ExtDialog.escapeHtml, blobToIconDataUrl = ExtDialog.blobToIconDataUrl,
    setStatus = ExtDialog.setStatus, baseUrl = ExtDialog.baseUrl;
  const row = kit.row, textRow = kit.textRow, numberRow = kit.numberRow, rangeRow = kit.rangeRow,
    checkboxRow = kit.checkboxRow, selectRow = kit.selectRow, segRow = kit.segRow, colorRow = kit.colorRow,
    unitRow = kit.unitRow, fontFamilyRow = kit.fontFamilyRow, fontRows = kit.fontRows;
  const copyText = ExtDialog.copyText, download = ExtDialog.download,
    getAt = ExtDialog.getAt, setAt = ExtDialog.setAt, delAt = ExtDialog.delAt;
  var LINE_STYLES = [['solid', 'Solid'], ['dashed', 'Dashed'], ['dotted', 'Dotted']];

  var TABS = [
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'bars', label: 'Bars', build: buildBarsTab, keys: ['bars', 'interaction', 'start', 'end', 'stepDefaults', 'steps'] },
    { id: 'groups', label: 'Groups', build: buildGroupsTab, keys: ['groups'] },
    { id: 'axes', label: 'Axes', build: buildAxesTab, keys: ['axisY', 'axisX'] },
    { id: 'lines', label: 'Lines', build: buildLinesTab, keys: ['lines'] },
    { id: 'numbers', label: 'Numbers', build: buildNumbersTab, keys: ['numbers', 'format'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card', 'data'] },
    { id: 'presets', label: 'Presets', build: buildPresetsTab, keys: [] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try {
        var p = JSON.parse(payload || '{}');
        info.bars = p.bars || [];
        info.dims = p.dims || [];
        info.combos = p.combos || [];
        info.hasBreakdown = !!p.hasBreakdown;
        info.focus = p.focus || null;
      } catch (e) { /* opened without payload */ }

      cfg = Wf.read();
      original = Wf.clone(cfg);

      if (!info.bars.length) {
        // No data passed: list what's stored so the Bars tab still works.
        info.bars = [{ key: '__start', kind: 'start', name: 'Start' }]
          .concat(Object.keys(cfg.steps).map(function (k) { return { key: k, kind: 'step', name: k, sign: 1 }; }))
          .concat([{ key: '__end', kind: 'end', name: 'End' }]);
      }
      if (info.focus) {
        if (info.focus.tab) activeTab = info.focus.tab;
        if (info.focus.bar) selectedBar = info.focus.bar;
      }
      if (!info.bars.some(function (b) { return b.key === selectedBar; })) selectedBar = info.bars[0].key;

      buildTabs();
      document.getElementById('cancel').addEventListener('click', function () {
        cfg = original;
        flush().then(close);
      });
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('Waterfall dialog failed to initialize:', err);
    });
  }

  function buildTabs () {
    var nav = document.getElementById('tabs');
    var panels = document.getElementById('panels');
    var scroll = panels.scrollTop;
    nav.innerHTML = '';
    panels.innerHTML = '';

    TABS.forEach(function (tab) {
      var b = h('button', { className: 'tab', type: 'button', role: 'tab', textContent: tab.label });
      b.setAttribute('aria-selected', String(tab.id === activeTab));
      b.addEventListener('click', function () { activeTab = tab.id; panels.scrollTop = 0; buildTabs(); });
      nav.appendChild(b);

      var panel = h('section', { className: 'panel', role: 'tabpanel' });
      panel.hidden = tab.id !== activeTab;
      if (!panel.hidden) tab.build(panel);
      panels.appendChild(panel);
    });
    panels.scrollTop = scroll;
  }

  /** Rebuild but keep the scroll position (for controls that show/hide rows). */
  function rebuild () { buildTabs(); }

  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) { cfg[k] = Wf.clone(Wf.DEFAULTS[k]); });
    changed();
    buildTabs();
  }

  // ---------------------------------------------------------------------------
  // Number format editor (KPI Card 3 "Big number" options + signs)
  // ---------------------------------------------------------------------------
  function fmtRows (g, base, opts) {
    opts = opts || {};
    var fmtRow = selectRow('Number format', P(base, 'scale'), [
      ['dynamic', 'Dynamic (K / M / B)'], ['K', 'Thousands (K)'], ['M', 'Millions (M)'],
      ['B', 'Billions (B)'], ['none', 'Full number'],
      ['percent', 'Percentage (%)'], ['percentDynamic', 'Percentage, dynamic (K / M / B %)'],
      ['workbook', 'Workbook format']
    ]);
    fmtRow.querySelector('select').addEventListener('change', rebuild);
    g.appendChild(fmtRow);
    var scale = get(P(base, 'scale'));
    if (scale === 'percent' || scale === 'percentDynamic') {
      g.appendChild(checkboxRow('Value is a 0–1 ratio', P(base, 'pctFromRatio')));
      g.appendChild(help('On: 0.4523 → 45.23%. Off: 45.23 → 45.23%.'));
    }
    if (scale === 'workbook') g.appendChild(help('Uses Tableau’s format when a single value is shown; sums (breakdowns, groups, calculated End) fall back to Dynamic.'));
    g.appendChild(numberRow('Decimal places', P(base, 'decimals'), 0, 6, 1));
    g.appendChild(unitRow('Unit', P(base, 'unit'), 'e.g. SAR, M, %'));
    g.appendChild(selectRow('Unit position', P(base, 'unitPosition'), [['suffix', 'After number'], ['prefix', 'Before number']]));
    if (!opts.noSign) g.appendChild(checkboxRow('“+” on increases', P(base, 'plusSign')));
    g.appendChild(selectRow('Negative numbers', P(base, 'negStyle'), [['minus', '−201.4'], ['hyphen', '-201.4'], ['paren', '(201.4)']]));
    var sample = h('div', { className: 'sample' });
    var upd = function () {
      var f = get(base);
      sample.textContent = 'Preview: ' + Wf.formatNumber(1284500, f) + '   ' + Wf.formatNumber(262100, f, { signed: true }) +
        '   ' + Wf.formatNumber(-45200, f, { signed: true }) + '   ' + Wf.formatNumber(0, f, { signed: true, zeroSign: -1 });
    };
    upd();
    g.addEventListener('input', upd);
    g.addEventListener('change', upd);
    g.appendChild(sample);
  }

  /** Format controls for one label: own format when the scope is "each". */
  function labelFmt (g, base) {
    if (cfg.numbers.mode === 'each') {
      fmtRows(g, base);
    } else {
      var note = h('p', { className: 'note' });
      note.innerHTML = 'Uses the shared number format (<a href="#">Numbers tab</a>). Switch the scope there to <b>Each label</b> to format this label on its own.';
      note.querySelector('a').addEventListener('click', function (e) { e.preventDefault(); activeTab = 'numbers'; buildTabs(); });
      g.appendChild(note);
    }
  }

  // ---------------------------------------------------------------------------
  // Bars tab
  // ---------------------------------------------------------------------------
  function barInfo (key) { return info.bars.find(function (b) { return b.key === key; }); }

  function barTitle (b) {
    var s = b.kind === 'start' ? cfg.start : b.kind === 'end' ? cfg.end : cfg.steps[b.key] || {};
    var label = (s && s.label) || b.name;
    return (b.kind === 'start' ? 'Start — ' : b.kind === 'end' ? 'End — ' : '') + label;
  }

  /** Path to a bar's settings; steps get a full copy of the defaults first. */
  function barBase (b) {
    if (b.kind === 'start') return ['start'];
    if (b.kind === 'end') return ['end'];
    cfg.steps[b.key] = Wf.stepCfg(cfg, b.key);
    return ['steps', b.key];
  }

  function buildBarsTab (p) {
    var b = barInfo(selectedBar) || info.bars[0];
    var base = barBase(b);
    var isStep = b.kind === 'step';
    var s = get(base);

    // ---- selector -----------------------------------------------------------
    var g0 = group(p, 'Bar to format');
    var r0 = row('Bar');
    var sel = h('select');
    info.bars.forEach(function (x, i) {
      var label = x.kind === 'step' ? (i + '. ') : '';
      sel.appendChild(h('option', { value: x.key, textContent: label + barTitle(x) }));
    });
    sel.value = b.key;
    sel.addEventListener('change', function () { selectedBar = sel.value; rebuild(); });
    r0.appendChild(sel);
    g0.appendChild(r0);
    g0.appendChild(help(isStep
      ? 'A value between Start and End, from the Changes tile. Tip: right-click or double-click a bar in the chart to jump here.'
      : 'Tip: right-click or double-click a bar in the chart to jump to it.'));

    // ---- bar ----------------------------------------------------------------
    var g1 = group(p, 'Bar');
    g1.appendChild(textRow('Label', P(base, 'label'), b.name));
    if (isStep) {
      g1.appendChild(segRow('Color', P(base, 'colorMode'), [['sign', 'Increase / decrease'], ['custom', 'Custom']], rebuild));
      if (s.colorMode === 'custom') g1.appendChild(colorRow('Bar color', P(base, 'color')));
      else g1.appendChild(help('Uses the Increase / Decrease colours under All bars below.'));
      g1.appendChild(checkboxRow('Invert sign', P(base, 'invert')));
      g1.appendChild(help('Tick for outflows stored as positive amounts, so they go down.'));
    } else {
      g1.appendChild(colorRow('Bar color', P(base, 'color')));
    }

    // ---- total value --------------------------------------------------------
    var g2 = group(p, 'Total value');
    g2.appendChild(checkboxRow('Show total', P(base, 'total.show'), rebuild));
    if (s.total.show) {
      var positions = [['above', 'Above the bar'], ['inside-top', 'Inside, top'], ['inside-center', 'Inside, middle'],
        ['inside-bottom', 'Inside, bottom'], ['below', 'Below the bar']];
      if (isStep) positions.push(['end', 'At the end it moves to (above if up, below if down)']);
      g2.appendChild(selectRow('Place', P(base, 'total.position'), positions));
      g2.appendChild(numberRow('Size (px)', P(base, 'total.size'), 6, 48, 1));
      g2.appendChild(selectRow('Weight', P(base, 'total.weight'), WEIGHTS));
      g2.appendChild(segRow('Color', P(base, 'total.colorMode'), [['bar', 'Bar colour'], ['custom', 'Custom']], rebuild));
      if (s.total.colorMode === 'custom') g2.appendChild(colorRow('Text color', P(base, 'total.color')));
      labelFmt(g2, P(base, 'total.fmt'));
    }

    // ---- clipped bar marker -------------------------------------------------
    var g3 = group(p, 'Clipped bar marker');
    g3.appendChild(checkboxRow('Show when cut short', P(base, 'brk.show'), rebuild));
    g3.appendChild(help(isStep
      ? 'Drawn when the axis range cuts this bar (e.g. a manual axis minimum).'
      : 'Drawn when the axis doesn’t start at zero, so the bar is really longer than it looks.'));
    if (s.brk.show) {
      g3.appendChild(selectRow('Style', P(base, 'brk.style'), [['slash', 'Slanted lines (Figma)'], ['zigzag', 'Zigzag'], ['gap', 'Plain gap']]));
      g3.appendChild(rangeRow('Position', P(base, 'brk.pos'), 10, 90, 1, '%'));
      g3.appendChild(colorRow('Gap color', P(base, 'brk.bandColor')));
      g3.appendChild(help('Match the background behind the chart.'));
      g3.appendChild(colorRow('Line color', P(base, 'brk.lineColor')));
    }

    // ---- breakdown (steps) -----------------------------------------------------
    if (isStep) {
      var g4 = group(p, 'Breakdown');
      if (!info.hasBreakdown) {
        g4.appendChild(h('p', { className: 'note', textContent: 'Drop a dimension on the Breakdown tile to split this bar into segments. These options apply once it’s there.' }));
      }
      g4.appendChild(checkboxRow('Show breakdown', P(base, 'breakdown.show'), rebuild));
      if (s.breakdown.show && info.dims.length) dimPicker(g4, base, s);
      if (s.breakdown.show) {
        var allOrder = (Wf.BREAKDOWN_ORDERS.find(function (o) { return o[0] === cfg.bars.breakdownOrder; }) || ['', ''])[1];
        g4.appendChild(selectRow('Segment order', P(base, 'breakdown.order'),
          [['inherit', 'Same as All bars (' + allOrder.replace(/ \(.*\)$/, '') + ')']].concat(Wf.BREAKDOWN_ORDERS)));
        g4.appendChild(help('Order of the segments in the bar (from the bar’s start) and of the rows in the tooltip.'));
        g4.appendChild(segRow('Colors', P(base, 'breakdown.colorMode'), [['shades', 'Shades of bar colour'], ['custom', 'Custom']], rebuild));
        if (s.breakdown.colorMode === 'custom') {
          var members = memberList(s.breakdown, b);
          if (!members.length) g4.appendChild(help('No breakdown members in the data yet.'));
          var barColor = s.colorMode === 'custom' ? s.color : (b.sign < 0 ? cfg.bars.negColor : cfg.bars.posColor);
          var sh = Wf.shades(barColor, Math.max(1, members.length));
          members.forEach(function (m, i) {
            if (!s.breakdown.colors[m]) s.breakdown.colors[m] = sh[i];
            g4.appendChild(colorRow(m, P(base, 'breakdown.colors').concat([m])));
          });
        }
        g4.appendChild(checkboxRow('Thin divider lines', P(base, 'breakdown.dividers')));
        g4.appendChild(checkboxRow('Show values', P(base, 'breakdown.showValues'), rebuild));
        if (s.breakdown.showValues) {
          g4.appendChild(checkboxRow('Include member name', P(base, 'breakdown.showNames')));
          g4.appendChild(segRow('Place', P(base, 'breakdown.position'), [['inside', 'Inside'], ['left', 'Left of bar'], ['right', 'Right of bar']]));
          g4.appendChild(numberRow('Size (px)', P(base, 'breakdown.size'), 6, 36, 1));
          g4.appendChild(selectRow('Weight', P(base, 'breakdown.weight'), WEIGHTS));
          g4.appendChild(segRow('Text color', P(base, 'breakdown.labelColorMode'), [['auto', 'Automatic'], ['custom', 'Custom']], rebuild));
          if (s.breakdown.labelColorMode === 'custom') g4.appendChild(colorRow('Color', P(base, 'breakdown.labelColor')));
          g4.appendChild(numberRow('Hide below (px)', P(base, 'breakdown.minPx'), 0, 80, 1));
          g4.appendChild(help('Values of segments shorter than this aren’t written.'));
          labelFmt(g4, P(base, 'breakdown.fmt'));
        }
      }

      if (cfg.groups.mode === 'custom') {
        var g5 = group(p, 'Group');
        var ids = Object.keys(cfg.groups.custom);
        g5.appendChild(selectRow('Group', P(base, 'group'), [['', 'None']].concat(ids.map(function (id) { return [id, cfg.groups.custom[id].text || id]; }))));
      }

      var g6 = group(p, 'Copy');
      var copyBtn = h('button', { type: 'button', className: 'btn', textContent: 'Apply these settings to all changes' });
      copyBtn.addEventListener('click', function () {
        var src = Wf.clone(get(base));
        info.bars.filter(function (x) { return x.kind === 'step' && x.key !== b.key; }).forEach(function (x) {
          var cur = Wf.stepCfg(cfg, x.key);
          var copy = Wf.clone(src);
          copy.label = cur.label;
          copy.group = cur.group;
          copy.invert = cur.invert;
          cfg.steps[x.key] = copy;
        });
        var def = Wf.clone(src); def.label = ''; def.group = ''; def.invert = false;
        cfg.stepDefaults = def;
        changed();
        setStatus('Copied to all changes (labels, sign and group kept)');
      });
      var resetBtn = h('button', { type: 'button', className: 'btn', textContent: 'Reset this bar' });
      resetBtn.addEventListener('click', function () { delete cfg.steps[b.key]; changed(); rebuild(); });
      g6.appendChild(h('div', { className: 'inline' }, [copyBtn, resetBtn]));
    }

    // ---- order of the change bars ------------------------------------------
    var gs = group(p, 'Order of the changes');
    gs.appendChild(selectRow('Sort changes', 'bars.sort', Wf.BAR_SORTS, null, rebuild));
    if (cfg.bars.sort !== 'marks') {
      gs.appendChild(segRow('Sort', 'bars.sortScope', [['overall', 'All changes together'], ['groups', 'Within each group']], rebuild));
      gs.appendChild(help(cfg.bars.sortScope === 'groups'
        ? (cfg.groups.mode === 'none'
          ? 'Groups are off (Groups tab), so all changes are sorted together.'
          : 'Each group keeps its place; the bars inside it are sorted. Bars outside any group are sorted among their neighbours.')
        : 'Start and End stay first and last. With Increases / decreases groups, the groups follow the new order.'));
    } else {
      gs.appendChild(help('The order of the pills on the Changes tile. Start and End always stay first and last.'));
    }

    // ---- all bars -----------------------------------------------------------
    var g7 = group(p, 'All bars');
    g7.appendChild(rangeRow('Bar width', 'bars.width', 10, 100, 1, '%'));
    g7.appendChild(numberRow('Corner radius', 'bars.radius', 0, 20, 1));
    g7.appendChild(numberRow('Start/End radius', 'bars.endRadius', 0, 20, 1));
    g7.appendChild(colorRow('Increase color', 'bars.posColor'));
    g7.appendChild(colorRow('Decrease color', 'bars.negColor'));
    g7.appendChild(selectRow('Breakdown order', 'bars.breakdownOrder', Wf.BREAKDOWN_ORDERS, null, rebuild));
    g7.appendChild(help('Segment and tooltip order for every bar whose own Segment order is “Same as All bars”. Value sorts by the signed amount, Size by the amount without its sign.'));
    g7.appendChild(checkboxRow('Start and End ignore the Breakdown', 'bars.balanceIgnoreBreakdown'));
    g7.appendChild(help('On: Start and End take their value once instead of adding it up over the Breakdown members. Use it when they go wrong after adding a Breakdown dimension, e.g. balances from FIXED / EXCLUDE calculations or other values that repeat on every row. For a measure that really changes per member, make it with { EXCLUDE [your Breakdown fields] : SUM([Balance]) }.'));
    g7.appendChild(checkboxRow('Calculate End if empty', 'bars.calcEnd'));
    g7.appendChild(help('With nothing on the End tile, End = Start + changes.'));
    g7.appendChild(checkboxRow('Tooltip on hover', 'bars.tooltip'));
    g7.appendChild(checkboxRow('Right-click menu', 'bars.rightClickMenu'));
    g7.appendChild(checkboxRow('Click selects in Tableau', 'interaction.selectInTableau'));
    g7.appendChild(help('Click a point (line chart) / a breakdown segment (waterfall) to select it in Tableau, so dashboard filter and highlight actions fire. Click it again or an empty area to clear.'));
  }


  // ---------------------------------------------------------------------------
  // Breakdown dimensions (which ones a bar uses, and their order)
  // ---------------------------------------------------------------------------

  /** Dimension keys a bar uses, in order. Empty / unknown → all, tile order. */
  function effectiveDims (bd) {
    var keys = info.dims.map(function (d) { return d.key; });
    var sel = (bd.dims || []).filter(function (k) { return keys.indexOf(k) >= 0; });
    return sel.length ? sel : keys;
  }

  /** Segment names for a bar's dimension choice (matches chart.js). */
  /** Segment names of a bar, as the chart draws them: the top ones, then Others. */
  function memberList (bd, bar) {
    var idx = effectiveDims(bd).map(function (k) { return info.dims.findIndex(function (d) { return d.key === k; }); });
    var name = function (c) { return idx.map(function (i) { return c[i]; }).join(bd.sep == null ? ' \u00b7 ' : bd.sep); };
    var seen = {};
    var out = [];
    info.combos.forEach(function (c) {
      var n = name(c);
      if (!seen[n]) { seen[n] = { member: n, v: 0 }; out.push(seen[n]); }
    });
    var rows = bar && bar.rows;
    if (rows && rows.length) {
      var has = {};
      rows.forEach(function (r) { var c = info.combos[r.c]; if (c) { var n = name(c); seen[n].v += r.raw; has[n] = 1; } });
      out = out.filter(function (sg) { return has[sg.member]; });
    }
    return Wf.topSegments(out).map(function (sg) { return sg.member; });
  }

  /**
   * Checklist of the Breakdown tile's fields: tick the ones this bar splits
   * by; the arrows set the order their values are written in the segment name.
   */
  function dimPicker (g, base, s) {
    var bd = s.breakdown;
    var selected = effectiveDims(bd);
    var others = info.dims.map(function (d) { return d.key; }).filter(function (k) { return selected.indexOf(k) < 0; });
    var nameOf = function (k) { var d = info.dims.find(function (x) { return x.key === k; }); return d ? d.name : k; };

    var r = row('Dimensions');
    var list = h('div', { className: 'dimlist' });
    var save = function (keys) {
      if (!keys.length) { setStatus('Keep at least one dimension, or untick Show breakdown'); rebuild(); return; }
      set(P(base, 'breakdown.dims'), keys);
      rebuild();
    };

    selected.concat(others).forEach(function (k) {
      var on = selected.indexOf(k) >= 0;
      var pos = selected.indexOf(k);
      var item = h('div', { className: 'dimitem' + (on ? '' : ' is-off') });
      var cb = h('input', { type: 'checkbox' });
      cb.checked = on;
      cb.addEventListener('change', function () {
        save(cb.checked ? selected.concat([k]) : selected.filter(function (x) { return x !== k; }));
      });
      var label = h('span', { className: 'dimname', textContent: (on && selected.length > 1 ? (pos + 1) + '. ' : '') + nameOf(k) });
      var up = h('button', { type: 'button', className: 'mini', textContent: '\u25b2', title: 'Earlier in the name' });
      var down = h('button', { type: 'button', className: 'mini', textContent: '\u25bc', title: 'Later in the name' });
      up.disabled = !on || pos === 0;
      down.disabled = !on || pos === selected.length - 1;
      var move = function (d) {
        var a = selected.slice();
        var t = a[pos]; a[pos] = a[pos + d]; a[pos + d] = t;
        save(a);
      };
      up.addEventListener('click', function () { move(-1); });
      down.addEventListener('click', function () { move(1); });
      item.append(cb, label, up, down);
      list.appendChild(item);
    });
    r.appendChild(list);
    g.appendChild(r);

    if (selected.length > 1) {
      g.appendChild(textRow('Name separator', P(base, 'breakdown.sep'), ' \u00b7 '));
      var ex = info.combos[0] ? memberList(bd)[0] : '';
      if (ex) g.appendChild(help('Segments are named like \u201c' + ex + '\u201d. The values of unticked dimensions are added together.'));
    } else {
      g.appendChild(help('Tick more than one to split by their combinations; the arrows set the order of the names.'));
    }
  }

  // ---------------------------------------------------------------------------
  // Groups tab
  // ---------------------------------------------------------------------------
  function buildGroupsTab (p) {
    var G = cfg.groups;
    var g1 = group(p, 'Grouping of changes');
    g1.appendChild(segRow('Group', 'groups.mode', [['none', 'None'], ['sign', 'Increases / decreases'], ['custom', 'Custom']], rebuild));
    g1.appendChild(help(G.mode === 'sign'
      ? 'Consecutive increases form one group and consecutive decreases another, as in the Figma design (Incoming / Outgoing).'
      : G.mode === 'custom' ? 'Make groups below and pick each change’s group. Neighbouring changes in the same group share one line.'
        : 'No group lines under the bars.'));

    if (G.mode === 'sign') {
      [['pos', 'Increases'], ['neg', 'Decreases']].forEach(function (x) {
        var g = group(p, x[1]);
        g.appendChild(textRow('Text', 'groups.' + x[0] + '.text', x[1]));
        g.appendChild(colorRow('Color', 'groups.' + x[0] + '.color'));
        g.appendChild(checkboxRow('Show group total', 'groups.' + x[0] + '.showTotal'));
      });
    }

    if (G.mode === 'custom') {
      var ids = Object.keys(G.custom);
      var gl = group(p, 'Groups');
      if (!ids.length) gl.appendChild(h('p', { className: 'note', textContent: 'No groups yet.' }));
      ids.forEach(function (id) {
        var box = h('div', { className: 'subcard' });
        box.appendChild(textRow('Text', ['groups', 'custom', id, 'text'], 'Group name'));
        box.appendChild(colorRow('Color', ['groups', 'custom', id, 'color']));
        box.appendChild(checkboxRow('Show group total', ['groups', 'custom', id, 'showTotal']));
        var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Remove group' });
        del.addEventListener('click', function () {
          delete G.custom[id];
          Object.keys(cfg.steps).forEach(function (k) { if (cfg.steps[k].group === id) cfg.steps[k].group = ''; });
          changed(); rebuild();
        });
        box.appendChild(del);
        gl.appendChild(box);
      });
      var add = h('button', { type: 'button', className: 'btn', textContent: 'Add group' });
      add.addEventListener('click', function () {
        var n = 1;
        while (G.custom['g' + n]) n++;
        var palette = ['#0E7C66', '#B4431E', '#6B4FB0', '#2F4B7C', '#C4566F', '#8A5CC2'];
        G.custom['g' + n] = { text: 'Group ' + n, color: palette[(n - 1) % palette.length], showTotal: true };
        changed(); rebuild();
      });
      gl.appendChild(add);

      var steps = info.bars.filter(function (b) { return b.kind === 'step'; });
      if (steps.length && ids.length) {
        var ga = group(p, 'Which group each change is in');
        steps.forEach(function (b) {
          var base = barBase(b);
          ga.appendChild(selectRow(barTitle(b), P(base, 'group'), [['', 'None']].concat(ids.map(function (id) { return [id, G.custom[id].text || id]; }))));
        });
      }
    }

    if (G.mode !== 'none') {
      var gs = group(p, 'Style');
      gs.appendChild(selectRow('Line', 'groups.lineStyle', LINE_STYLES.concat([['bracket', 'Bracket']])));
      gs.appendChild(numberRow('Line width', 'groups.lineWidth', 0.5, 8, 0.5));
      gs.appendChild(numberRow('Line inset (px)', 'groups.inset', 0, 60, 1));
      gs.appendChild(numberRow('Text size (px)', 'groups.size', 6, 36, 1));
      gs.appendChild(selectRow('Text weight', 'groups.weight', WEIGHTS));
      gs.appendChild(textRow('Separator', 'groups.separator', ' · '));
      gs.appendChild(checkboxRow('Shade behind bars', 'groups.band', rebuild));
      if (G.band) gs.appendChild(rangeRow('Shade opacity', 'groups.bandOpacity', 1, 40, 1, '%'));
      var gf = group(p, 'Group total format');
      labelFmt(gf, 'groups.fmt');
    }
  }

  // ---------------------------------------------------------------------------
  // Axes tab
  // ---------------------------------------------------------------------------
  function buildAxesTab (p) {
    var a = cfg.axisY;
    var g1 = group(p, 'Vertical axis — range');
    g1.appendChild(segRow('Starts at', 'axisY.base', [['zero', 'Zero'], ['auto', 'Close to the data'], ['manual', 'Fixed value']], rebuild));
    if (a.base === 'auto') {
      g1.appendChild(rangeRow('Room below', 'axisY.padding', 0, 100, 1, '%'));
      g1.appendChild(help('Space under the lowest level, as a share of the data range, then rounded to a tick. Start and End bars get the clipped-bar marker.'));
    } else if (a.base === 'manual') {
      g1.appendChild(numberRow('Minimum', 'axisY.manualMin', -1e15, 1e15, 'any'));
    }
    g1.appendChild(segRow('Ends at', 'axisY.maxMode', [['auto', 'Automatic'], ['manual', 'Fixed value']], rebuild));
    if (a.maxMode === 'manual') g1.appendChild(numberRow('Maximum', 'axisY.manualMax', -1e15, 1e15, 'any'));
    g1.appendChild(numberRow('Tick marks (about)', 'axisY.ticks', 2, 12, 1));

    var g2 = group(p, 'Vertical axis — labels');
    g2.appendChild(checkboxRow('Show axis', 'axisY.show', rebuild));
    if (a.show) {
      g2.appendChild(segRow('Side', 'axisY.position', [['left', 'Left'], ['right', 'Right']]));
      g2.appendChild(textRow('Axis title', 'axisY.title', 'e.g. SAR M'));
      fontRows(g2, 'axisY', false);
      g2.appendChild(checkboxRow('Axis line', 'axisY.showLine', rebuild));
      if (a.showLine) g2.appendChild(colorRow('Line color', 'axisY.lineColor'));
      var g3 = group(p, 'Vertical axis — number format');
      g3.appendChild(checkboxRow('Use shared format', 'axisY.useGlobalFormat', rebuild));
      if (!a.useGlobalFormat) fmtRows(g3, 'axisY.fmt', { noSign: true });
    }

    var x = cfg.axisX;
    var g4 = group(p, 'Horizontal axis');
    g4.appendChild(checkboxRow('Show bar labels', 'axisX.show', rebuild));
    if (x.show) {
      g4.appendChild(segRow('Labels', 'axisX.orientation', [['wrap', 'Horizontal'], ['angled', 'Angled'], ['vertical', 'Vertical']], rebuild));
      if (x.orientation === 'wrap') g4.appendChild(numberRow('Max lines', 'axisX.maxLines', 1, 5, 1));
      fontRows(g4, 'axisX', false);
    }
    g4.appendChild(checkboxRow('Axis line', 'axisX.showLine', rebuild));
    if (x.showLine) {
      g4.appendChild(colorRow('Line color', 'axisX.lineColor'));
      g4.appendChild(numberRow('Line width', 'axisX.lineWidth', 0.5, 6, 0.5));
    }
  }

  // ---------------------------------------------------------------------------
  // Lines tab
  // ---------------------------------------------------------------------------
  function buildLinesTab (p) {
    [['hGrid', 'Horizontal gridlines'], ['vGrid', 'Vertical gridlines (between bars)'],
      ['connectors', 'Connector lines (bar to bar)'], ['zero', 'Zero line']].forEach(function (x) {
      var base = 'lines.' + x[0];
      var g = group(p, x[1]);
      g.appendChild(checkboxRow('Show', base + '.show', rebuild));
      if (get(base + '.show')) {
        g.appendChild(colorRow('Color', base + '.color'));
        g.appendChild(numberRow('Width (px)', base + '.width', 0.5, 6, 0.5));
        g.appendChild(segRow('Style', base + '.style', LINE_STYLES));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Numbers tab
  // ---------------------------------------------------------------------------
  /** Every label format, so "each" can start from the shared format. */
  function allLabelFmtPaths () {
    var paths = [['start', 'total', 'fmt'], ['end', 'total', 'fmt'], ['stepDefaults', 'total', 'fmt'],
      ['stepDefaults', 'breakdown', 'fmt'], ['groups', 'fmt']];
    var keys = {};
    info.bars.forEach(function (b) { if (b.kind === 'step') keys[b.key] = 1; });
    Object.keys(cfg.steps).forEach(function (k) { keys[k] = 1; });
    Object.keys(keys).forEach(function (k) {
      cfg.steps[k] = Wf.stepCfg(cfg, k);
      paths.push(['steps', k, 'total', 'fmt'], ['steps', k, 'breakdown', 'fmt']);
    });
    return paths;
  }

  function copyGlobalToAll () {
    allLabelFmtPaths().forEach(function (pth) {
      var last = pth[pth.length - 1];
      pth.slice(0, -1).reduce(function (o, k) { return o[k]; }, cfg)[last] = Wf.clone(cfg.format);
    });
    changed();
  }

  function buildNumbersTab (p) {
    var g1 = group(p, 'Scope');
    g1.appendChild(segRow('Format', 'numbers.mode', [['all', 'All numbers the same'], ['each', 'Each label its own']], function () {
      if (cfg.numbers.mode === 'each') copyGlobalToAll();
      rebuild();
    }));
    g1.appendChild(help(cfg.numbers.mode === 'all'
      ? 'Bar totals, breakdown values and group totals all use the format below.'
      : 'Each bar’s total, its breakdown values and the group totals have their own format (Bars and Groups tabs). They started as copies of the format below.'));

    var g2 = group(p, cfg.numbers.mode === 'all' ? 'Number format' : 'Shared format');
    fmtRows(g2, 'format');
    if (cfg.numbers.mode === 'each') {
      var btn = h('button', { type: 'button', className: 'btn', textContent: 'Copy this format to every label' });
      btn.addEventListener('click', function () { copyGlobalToAll(); setStatus('Copied to every label'); });
      g2.appendChild(btn);
    }

    var g3 = group(p, 'Chart text');
    g3.appendChild(fontFamilyRow('Font', 'numbers.font'));
    g3.appendChild(help('Font of bar values, breakdown values and group labels. Axis fonts are on the Axes tab; the vertical axis has its own number format there.'));
  }

  function buildCardTab (p) {
    var g1 = group(p, 'Card');
    g1.appendChild(numberRow('Padding (px)', 'card.padding', 0, 60, 1));
    g1.appendChild(numberRow('Space above chart', 'card.gap', 0, 60, 1));
    g1.appendChild(checkboxRow('Dashed right divider', 'card.divider'));
    g1.appendChild(colorRow('Divider color', 'card.dividerColor'));

    var g2 = group(p, 'Background');
    g2.appendChild(colorRow('Color', 'card.bgColor'));
    g2.appendChild(rangeRow('Opacity', 'card.bgOpacity', 0, 100, 1, '%'));
    g2.appendChild(help('0% is fully transparent. Set worksheet and container shading to None in Tableau to see through.'));
    var gData = group(p, 'Data');
    gData.appendChild(numberRow('Maximum rows', 'data.maxRows', 0, 1000000, 1));
    gData.appendChild(h('div', { className: 'help', textContent: 'How many rows are read from the worksheet (0 = all). When rows are left out, a note in the corner of the chart says so.' }));

  }

  function buildIconTab (p) {
    var ic = cfg.icon;

    var preview = h('div', { className: 'icon-preview' });
    var slot = h('div', { className: 'slot' });
    var name = h('div', { className: 'name' });
    preview.append(slot, name);
    var refreshPreview = function () {
      slot.innerHTML = '';
      slot.classList.remove('slot--dark');
      if (!ic.show) { name.textContent = 'Icon hidden'; return; }
      if (ic.source === 'builtin') {
        var r = Wf.iconHtml(ic.builtinId, ic.color);
        slot.innerHTML = r.html;
        slot.classList.toggle('slot--dark', !!r.icon.light);
        name.textContent = r.icon.label;
      } else if (ic.dataUrl) {
        var img = new Image();
        img.onload = function () {
          var w = img.naturalWidth || 24; var hh = img.naturalHeight || 24;
          if (w >= hh) { img.style.width = '24px'; img.style.height = 'auto'; } else { img.style.height = '24px'; img.style.width = 'auto'; }
        };
        img.src = ic.dataUrl;
        slot.appendChild(img);
        name.textContent = ic.name || (ic.source === 'shape' ? 'Tableau shape' : 'Uploaded image');
      } else {
        name.textContent = 'No image chosen yet';
      }
    };
    refreshPreview();

    var g = group(p, 'Icon');
    g.appendChild(preview);
    g.appendChild(checkboxRow('Show icon', 'icon.show', function () { refreshPreview(); }));
    g.appendChild(rangeRow('Size', 'icon.size', 12, 96, 1, ' px'));
    g.appendChild(h('div', { className: 'help', textContent: 'Length of the icon\u2019s longer side. Figma default is 24 px; icons stay sharpest up to about 48 px.' }));

    var sources = [['builtin', 'Built-in'], ['shape', 'Tableau shapes'], ['upload', 'Upload']];
    var sourceRow = row('Source');
    var seg = h('div', { className: 'seg' });
    sources.forEach(function (s) {
      var b = h('button', { type: 'button', textContent: s[1] });
      b.setAttribute('aria-pressed', String(ic.source === s[0]));
      b.addEventListener('click', function () {
        ic.source = s[0];
        if (s[0] === 'builtin') ic.show = true;
        changed();
        buildTabs();
      });
      seg.appendChild(b);
    });
    sourceRow.appendChild(seg);
    g.appendChild(sourceRow);

    var body = group(p, sources.find(function (s) { return s[0] === ic.source; })[1]);

    if (ic.source === 'builtin') {
      var gridWrap = h('div');
      var fillGrid = function () {
        gridWrap.innerHTML = '';
        Wf.ICON_GROUPS.forEach(function (groupName) {
          var icons = Wf.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Wf.iconHtml(icon.id, ic.color).html;
            if (icon.id === ic.builtinId) cell.classList.add('is-active');
            cell.addEventListener('click', function () {
              ic.builtinId = icon.id;
              ic.show = true;
              Array.prototype.forEach.call(gridWrap.querySelectorAll('.cell'), function (c) { c.classList.remove('is-active'); });
              cell.classList.add('is-active');
              changed();
              refreshPreview();
            });
            grid.appendChild(cell);
          });
          gridWrap.appendChild(grid);
        });
      };
      body.appendChild(colorRow('Icon color', 'icon.color', function () { refreshPreview(); fillGrid(); }));
      body.appendChild(h('div', { className: 'help', textContent: 'Recolours the built-in icons.' }));
      fillGrid();
      body.appendChild(gridWrap);
    } else if (ic.source === 'shape') {
      buildShapePicker(body, refreshPreview);
    } else {
      buildUpload(body, refreshPreview);
    }
  }

  /** Lists Tableau shape palettes served by serve.py (/shapes/index.json). */
  function buildShapePicker (body, refreshPreview) {
    var note = h('p', { className: 'note', textContent: 'Loading shape palettes…' });
    body.appendChild(note);

    var loadIndex = shapeIndex ? Promise.resolve(shapeIndex)
      : fetch(baseUrl() + 'shapes/index.json', { cache: 'no-store' })
        .then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); })
        .then(function (j) { shapeIndex = j; return j; });

    loadIndex.then(function (index) {
      var palettes = (index.palettes || []).filter(function (pl) { return pl.files && pl.files.length; });
      if (!palettes.length) {
        note.innerHTML = 'No shape palettes found. serve.py looked in:<br><code>' +
          (index.searched || []).map(escapeHtml).join('</code><br><code>') +
          '</code><br>Set <code>KPI_SHAPES_DIRS</code> before starting it to add folders.';
        return;
      }
      note.textContent = 'Shapes are copied into the workbook when picked, so they keep working after publishing.';

      var selRow = row('Palette');
      var sel = h('select');
      palettes.forEach(function (pl, i) { sel.appendChild(h('option', { value: String(i), textContent: pl.name + ' (' + pl.files.length + ')' })); });
      var remembered = palettes.findIndex(function (pl) { return cfg.icon.name.indexOf(pl.name + ' / ') === 0; });
      sel.value = String(remembered >= 0 ? remembered : 0);
      selRow.appendChild(sel);
      body.appendChild(selRow);

      var grid = h('div', { className: 'grid' });
      body.appendChild(grid);

      var fill = function () {
        grid.innerHTML = '';
        var pl = palettes[Number(sel.value)];
        pl.files.forEach(function (f) {
          var label = pl.name + ' / ' + f.name;
          var cell = h('button', { type: 'button', className: 'cell', title: f.name });
          cell.appendChild(h('img', { src: baseUrl() + f.url, alt: '', loading: 'lazy' }));
          if (cfg.icon.source === 'shape' && cfg.icon.name === label) cell.classList.add('is-active');
          cell.addEventListener('click', function () {
            fetch(baseUrl() + f.url).then(function (r) { return r.blob(); })
              .then(blobToIconDataUrl)
              .then(function (url) {
                cfg.icon.source = 'shape';
                cfg.icon.dataUrl = url;
                cfg.icon.name = label;
                cfg.icon.show = true;
                Array.prototype.forEach.call(grid.children, function (c) { c.classList.remove('is-active'); });
                cell.classList.add('is-active');
                changed();
                refreshPreview();
              })
              .catch(function (e) { setStatus('Could not load that shape: ' + e.message); });
          });
          grid.appendChild(cell);
        });
      };
      sel.addEventListener('change', fill);
      fill();
    }).catch(function () {
      note.innerHTML = 'Tableau shapes are listed by the local helper server. Start the extension with ' +
        '<code>./serve.sh</code> (it runs <code>serve.py</code>), then reopen this dialog. ' +
        'You can still upload a shape file from the <b>Upload</b> tab.';
    });
  }

  function buildUpload (body, refreshPreview) {
    var drop = h('label', { className: 'drop' });
    var input = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/svg+xml,image/webp,image/bmp,.ico' });
    drop.append(input,
      h('b', { textContent: 'Choose an image' }),
      h('span', { textContent: 'or drop it here — PNG, SVG, JPG, GIF. Tableau custom shapes work too.' }));
    body.appendChild(drop);
    body.appendChild(h('p', {
      className: 'note',
      textContent: 'Scaled to 24 px on its longer side. Raster images are stored at 96 px for sharp rendering on high-DPI screens.'
    }));

    var take = function (file) {
      if (!file) return;
      blobToIconDataUrl(file).then(function (url) {
        cfg.icon.source = 'upload';
        cfg.icon.dataUrl = url;
        cfg.icon.name = file.name;
        cfg.icon.show = true;
        changed();
        refreshPreview();
      }).catch(function (e) { setStatus('Could not read that image: ' + e.message); });
    };
    input.addEventListener('change', function () { take(input.files[0]); });
    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.add('is-over'); });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) { e.preventDefault(); drop.classList.remove('is-over'); });
    });
    drop.addEventListener('drop', function (e) { take(e.dataTransfer.files[0]); });
  }

  function buildTextTab (p) {
    var g1 = group(p, 'Title');
    g1.appendChild(textRow('Title', 'title.text', 'Defaults to "Start → End"'));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(textRow('Text', 'explanation.text', 'e.g. % Top-Up vs Local Transfer'));
    fontRows(g2, 'explanation', true);
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------
  var PRESET_TYPE = 'tableau-waterfall-preset';
  var PRESET_STORE = 'waterfall:presets:v1';

  /**
   * Settings tied to this worksheet's fields and data (bar names, per-bar settings,
   * breakdown members and colours, custom groups, texts naming the data, row limit).
   * "Look only" presets leave them out, and an import keeps the chart's own unless asked otherwise.
   */
  var FIELD_PATHS = [
    'title.text', 'explanation.text', // text that names this worksheet's data
    'start.label', 'end.label', 'stepDefaults.label', 'stepDefaults.group', // bar names and group names from the data
    'axisY.title', // axis title names the measure
    'steps', // per-bar settings, keyed by bar (pill) name
    'layout.steps', 'layout.dims', // bars and breakdown fields last seen in this worksheet
    'stepDefaults.breakdown.dims', // which dimensions break the bars down
    'stepDefaults.breakdown.colors', // colours keyed by breakdown member name
    'groups.custom', // custom groups: bars grouped by name
    'data.maxRows' // how many rows this worksheet sends
  ];

  /**
   * Preset format version. Presets keep only the settings that differ from the
   * defaults, so new options reach old presets on their own. When a setting
   * changes shape, bump this and add a step to PRESET_MIGRATIONS (key = the
   * version it upgrades from) so older preset files keep working.
   */
  var PRESET_VERSION = 1;
  var PRESET_MIGRATIONS = {};

  function migratePreset (pr) {
    var v = pr.version || 1;
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer Waterfall. Update the extension, then import it again.');
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  /** Only the settings that differ from the defaults (smaller files, future-proof). */
  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : Wf.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? Wf.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    var s = Wf.clone(cfg);
    if (scope === 'look') FIELD_PATHS.forEach(function (p) { delAt(s, p); });
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'Waterfall preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: diffFromDefaults(s, Wf.DEFAULTS) || {}
    };
  }

  /** Accepts a preset file, or the raw settings JSON of a workbook. */
  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a Waterfall preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o.waterfall1) { try { o = typeof o.waterfall1 === 'string' ? JSON.parse(o.waterfall1) : o.waterfall1; } catch (e) { /* fall through */ } }
    var known = Object.keys(o).filter(function (k) { return k in Wf.DEFAULTS; });
    if (!known.length) throw new Error('No Waterfall settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    pr = migratePreset(pr);
    var next = Wf.merge(Wf.DEFAULTS, pr.settings);
    var own = pr.scope === 'look' || keepFields;
    FIELD_PATHS.forEach(function (p) {
      var has = getAt(pr.settings, p) !== undefined;
      if (own || !has) setAt(next, p, Wf.clone(getAt(cfg, p)));
    });
    cfg = next;
    changed();
    buildTabs();
  }

  function loadStore () {
    try { var a = JSON.parse(localStorage.getItem(PRESET_STORE) || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; }
  }

  function saveStore (list) {
    try { localStorage.setItem(PRESET_STORE, JSON.stringify(list)); return true; } catch (e) { return false; }
  }

  function fileName (name) {
    return (String(name || 'waterfall-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'waterfall-preset') + '.json';
  }

  function presetMsg (g) {
    if (!presetUi.msg) return;
    g.appendChild(h('p', { className: 'preset-msg' + (presetUi.msg.error ? ' is-error' : ''), textContent: presetUi.msg.text }));
    presetUi.msg = null;
  }

  function say (text, error) { presetUi.msg = { text: text, error: !!error }; rebuild(); }

  function describe (pr) {
    var d = pr.exported ? new Date(pr.exported) : null;
    return (pr.scope === 'look' ? 'Look only' : 'Everything') + (d && !isNaN(d) ? ' · ' + d.toLocaleDateString() : '');
  }

  function buildPresetsTab (p) {
    presetMsg(p);
    // ---- Export
    var g1 = group(p, 'Export');
    g1.appendChild(help('Saves this chart’s settings as a preset you can import into another Waterfall, in this or any workbook.'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Dark waterfall' });
    name.addEventListener('input', function () { presetUi.name = name.value; });
    rName.appendChild(name);
    g1.appendChild(rName);
    var rScope = row('Include');
    var seg = h('div', { className: 'seg' });
    [['look', 'Look only'], ['all', 'Everything']].forEach(function (o) {
      var b = h('button', { type: 'button', textContent: o[1] });
      b.setAttribute('aria-pressed', String(presetUi.scope === o[0]));
      b.addEventListener('click', function () { presetUi.scope = o[0]; rebuild(); });
      seg.appendChild(b);
    });
    rScope.appendChild(seg);
    g1.appendChild(rScope);
    g1.appendChild(help(presetUi.scope === 'look'
      ? 'Bars, groups, axes, lines, numbers, icon, card… Leaves out what belongs to this sheet’s data: per-bar settings, breakdown members and colours, custom groups, bar labels, title and explanation text, row limit.'
      : 'Every setting, including per-bar settings, breakdown colours and custom groups. Best for a copy of the same sheet.'));

    var ta = h('textarea', { className: 'preset-json', readOnly: true, spellcheck: false });
    var current = function () { return JSON.stringify(makePreset(presetUi.scope, presetUi.name.trim()), null, 2); };
    var btns = h('div', { className: 'inline preset-btns' });
    var bDl = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Download .json' });
    var bCp = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Copy' });
    var bSave = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Save to My presets' });
    var bShow = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Show JSON' });
    bDl.addEventListener('click', function () {
      var t = current();
      ta.value = t;
      say(download(t, fileName(presetUi.name)) ? 'Downloaded ' + fileName(presetUi.name) + '. If nothing appeared (Tableau Desktop can block downloads), use Copy and paste it into a text file.' : 'Download isn’t available here. Use Copy instead.', false);
    });
    bCp.addEventListener('click', function () {
      var t = current();
      ta.value = t; ta.hidden = false;
      copyText(t, ta).then(function (ok) { say(ok ? 'Copied. Paste it into a .json or text file, an email or chat.' : 'Couldn’t copy. Select the text below and copy it yourself.', !ok); });
    });
    bSave.addEventListener('click', function () {
      var nm = presetUi.name.trim() || 'Preset ' + (loadStore().length + 1);
      var list = loadStore().filter(function (x) { return x.name !== nm; });
      var pr = makePreset(presetUi.scope, nm);
      list.unshift(pr);
      say(saveStore(list) ? 'Saved “' + nm + '” to My presets.' : 'Couldn’t save in this browser. Download or copy the preset instead.', false);
    });
    bShow.addEventListener('click', function () { ta.value = current(); ta.hidden = !ta.hidden; });
    btns.append(bDl, bCp, bSave, bShow);
    g1.appendChild(btns);
    ta.hidden = true;
    g1.appendChild(ta);

    // ---- Import
    var g2 = group(p, 'Import');
    g2.appendChild(help('Applies a preset to this chart. Cancel at the bottom undoes it.'));
    g2.appendChild((function () {
      var r = row('Keep this chart’s');
      var input = h('input', { type: 'checkbox' });
      input.checked = presetUi.keepFields;
      input.addEventListener('change', function () { presetUi.keepFields = input.checked; });
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'per-bar settings, breakdown fields and colours, custom groups, bar labels, title and explanation text, row limit' })]));
      return r;
    })());
    var file = h('input', { type: 'file', accept: '.json,application/json,text/plain' });
    file.style.display = 'none';
    file.addEventListener('change', function () {
      var f = file.files && file.files[0];
      if (!f) return;
      var rd = new FileReader();
      rd.onload = function () {
        try {
          var pr = parsePreset(rd.result);
          applyImported(pr, presetUi.keepFields);
          say('Applied “' + (pr.name || f.name) + '” (' + describe(pr) + ').', false);
        } catch (e) { say(e.message, true); }
      };
      rd.onerror = function () { say('Couldn’t read the file.', true); };
      rd.readAsText(f);
    });
    var paste = h('textarea', { className: 'preset-json', spellcheck: false, placeholder: 'Or paste a preset here' });
    paste.value = presetUi.pasted;
    paste.addEventListener('input', function () { presetUi.pasted = paste.value; });
    var ib = h('div', { className: 'inline preset-btns' });
    var bFile = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Choose file…' });
    bFile.addEventListener('click', function () { file.value = ''; file.click(); });
    var bPaste = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Apply pasted' });
    bPaste.addEventListener('click', function () {
      if (!paste.value.trim()) { say('Paste a preset into the box first.', true); return; }
      try {
        var pr = parsePreset(paste.value);
        applyImported(pr, presetUi.keepFields);
        presetUi.pasted = '';
        say('Applied “' + pr.name + '” (' + describe(pr) + ').', false);
      } catch (e) { say(e.message, true); }
    });
    ib.append(bFile, bPaste, file);
    g2.appendChild(ib);
    g2.appendChild(paste);

    // ---- My presets (this browser)
    var g3 = group(p, 'My presets');
    var list = loadStore();
    if (!list.length) {
      g3.appendChild(h('p', { className: 'note', textContent: 'None yet. “Save to My presets” keeps a preset on this computer for this extension, ready for any workbook. Download or copy a preset to share it or move it to another computer.' }));
    } else {
      g3.appendChild(help('Kept on this computer for this extension (any workbook). Clearing the browser data of Tableau removes them, so download the ones you want to keep.'));
      list.forEach(function (pr, i) {
        var r = h('div', { className: 'preset-item' });
        var t = h('div', { className: 'preset-name' }, [h('b', { textContent: pr.name }), h('span', { className: 'help', textContent: ' ' + describe(pr) })]);
        var apply = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Apply' });
        apply.addEventListener('click', function () { applyImported(pr, presetUi.keepFields); say('Applied “' + pr.name + '”.', false); });
        var dl = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Download' });
        dl.addEventListener('click', function () { download(JSON.stringify(pr, null, 2), fileName(pr.name)); });
        var del = h('button', { type: 'button', className: 'btn btn--small', textContent: 'Delete', title: 'Delete this preset' });
        del.addEventListener('click', function () {
          if (del.dataset.sure) { var l = loadStore(); l.splice(i, 1); saveStore(l); say('Deleted “' + pr.name + '”.', false); return; }
          del.dataset.sure = '1'; del.textContent = 'Sure?';
          setTimeout(function () { delete del.dataset.sure; del.textContent = 'Delete'; }, 2500);
        });
        r.append(t, h('div', { className: 'inline' }, [apply, dl, del]));
        g3.appendChild(r);
      });
    }
  }

  // ---------------------------------------------------------------------------
  // State + persistence
  // ---------------------------------------------------------------------------
  function get (path) {
    return P(path).reduce(function (o, k) { return o == null ? undefined : o[k]; }, cfg);
  }

  function set (path, value) {
    var keys = P(path);
    var last = keys.pop();
    keys.reduce(function (o, k) {
      if (o[k] == null || typeof o[k] !== 'object') o[k] = {};
      return o[k];
    }, cfg)[last] = value;
    changed();
  }

  function changed () {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(persist, 180);
  }

  function flush () {
    clearTimeout(saveTimer);
    return persist();
  }

  function persist () {
    try {
      setStatus('Saving…');
      return Wf.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }


  window.WaterfallConfigure = { init: init };
})();
