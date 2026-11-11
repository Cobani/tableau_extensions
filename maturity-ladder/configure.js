'use strict';

/**
 * Format dialog for the Maturity Ladder extension ("Format Extension" on the Marks
 * card, or right-click / double-click a bar in the chart).
 *
 * Every change is saved straight away (debounced), so the chart behind the
 * modeless dialog updates live. Cancel restores what was stored on open.
 * The chart passes what it knows as the dialog payload, because a dialog can't read the worksheet.
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var hist = null; // undo / redo steps (shared/dialog.js)
  var activeTab = 'buckets';
  var shapeIndex = null;
  var info = { hasGroup: false, focus: null };

  var WEIGHTS = ExtDialog.WEIGHTS;

  // Controls shared by every Format dialog: shared/dialog.js.
  const kit = ExtDialog.kit({
    get: get,
    set: set,
    fonts: Ml.FONTS
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
    { id: 'buckets', label: 'Buckets', build: buildBucketsTab, keys: ['buckets', 'chart', 'interaction'] },
    { id: 'bars', label: 'Bars', build: buildBarsTab, keys: ['bars'] },
    { id: 'today', label: 'Today & total', build: buildTodayTab, keys: ['today', 'cumulative'] },
    { id: 'labels', label: 'Labels', build: buildLabelsTab, keys: ['labels', 'axes', 'legend'] },
    { id: 'numbers', label: 'Numbers', build: buildNumbersTab, keys: ['numbers', 'format'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card', 'data', 'export'] },
    { id: 'presets', label: 'Presets', build: buildPresetsTab, keys: [] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try {
        var p = JSON.parse(payload || '{}');
        info.hasGroup = !!p.hasGroup;
        info.focus = p.focus || null;
      } catch (e) { /* opened without payload */ }

      cfg = Ml.read();
      original = Ml.clone(cfg);

      if (info.focus) {
        if (info.focus.tab) activeTab = info.focus.tab;
      }

      buildTabs();
      hist = ExtDialog.history({
        snapshot: function () { return JSON.stringify(cfg); },
        restore: function (json) { cfg = JSON.parse(json); changed(); buildTabs(); }
      });
      ExtDialog.footerTools({ history: hist, footer: document.querySelector('.footer') });
      ExtDialog.search({
        tabs: document.getElementById('tabs'),
        container: document.getElementById('panels'),
        getTabs: function () { return TABS; },
        openTab: function (id) { activeTab = id; buildTabs(); }
      });
      document.getElementById('cancel').addEventListener('click', function () {
        cfg = original;
        flush().then(close);
      });
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('Maturity Ladder dialog failed to initialize:', err);
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
    tab.keys.forEach(function (k) { cfg[k] = Ml.clone(Ml.DEFAULTS[k]); });
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
    if (scale === 'workbook') g.appendChild(help('Uses Tableau’s format when a single value is shown; sums fall back to Dynamic.'));
    g.appendChild(numberRow('Decimal places', P(base, 'decimals'), 0, 6, 1));
    g.appendChild(unitRow('Unit', P(base, 'unit'), 'e.g. SAR, M, %'));
    g.appendChild(selectRow('Unit position', P(base, 'unitPosition'), [['suffix', 'After number'], ['prefix', 'Before number']]));
    g.appendChild(selectRow('Negative numbers', P(base, 'negStyle'), [['minus', '−201.4'], ['hyphen', '-201.4'], ['paren', '(201.4)']]));
    var sample = h('div', { className: 'sample' });
    var upd = function () {
      var f = get(base);
      sample.textContent = 'Preview: ' + Ml.formatNumber(1284500, f) + '   ' + Ml.formatNumber(45200, f) + '   ' + Ml.formatNumber(-3100, f) + '   ' + Ml.formatNumber(0, f);
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
  // Buckets tab
  // ---------------------------------------------------------------------------
  function buildBucketsTab (p) {
    var g1 = group(p, 'Bucket size');
    g1.appendChild(selectRow('Group dates by', 'buckets.unit', Ml.UNITS));
    g1.appendChild(help('Automatic picks the smallest unit that gives at most about 36 bars. A unit finer than the dates in the data (for example weeks for YEAR + MONTH pills) is not possible and is raised to the finest the data has.'));

    var g2 = group(p, 'Open-ended bars');
    g2.appendChild(checkboxRow('Overdue bar (everything before today)', 'buckets.overdue'));
    g2.appendChild(textRow('Overdue label', 'buckets.overdueLabel', 'Overdue'));
    g2.appendChild(numberRow('Later bar after N buckets from today', 'buckets.later', 0, 60, 1));
    g2.appendChild(textRow('Later label', 'buckets.laterLabel', 'Later'));
    g2.appendChild(help('0 turns the Later bar off. With N = 12 and month buckets, everything more than a year ahead is added up in one bar on the right. Empty buckets in between stay as gaps.'));

    var g3 = group(p, 'Interaction');
    g3.appendChild(checkboxRow('Click a bar or a segment to select it in Tableau', 'interaction.selectInTableau'));
    g3.appendChild(help('Selects the rows of that bucket (and group). When a bucket mixes several years or date parts, Tableau may also pick neighbouring combinations.'));
    g3.appendChild(checkboxRow('Show tooltip', 'chart.tooltip'));
    g3.appendChild(numberRow('Items listed in the tooltip', 'chart.topItems', 0, 20, 1));
    g3.appendChild(checkboxRow('Use Tableau’s tooltip', 'interaction.tableauTooltip'));
    g3.appendChild(checkboxRow('Right-click menu', 'chart.rightClickMenu'));
  }

  // ---------------------------------------------------------------------------
  // Bars tab
  // ---------------------------------------------------------------------------
  function buildBarsTab (p) {
    var g1 = group(p, 'Bars');
    g1.appendChild(rangeRow('Bar width', 'bars.width', 10, 100, 1, '%'));
    g1.appendChild(numberRow('Corner radius (px)', 'bars.radius', 0, 12, 1));
    g1.appendChild(numberRow('Gap between segments (px)', 'bars.gap', 0, 4, 1));

    var mode = cfg.bars.colorMode;
    var g2 = group(p, 'Colors');
    g2.appendChild(segRow('Colors', 'bars.colorMode', [['single', 'One color'], ['group', 'By group'], ['distance', 'By distance']], rebuild));
    if (mode === 'single') {
      g2.appendChild(colorRow('Color', 'bars.color'));
      g2.appendChild(help('With a Group, the segments of a bar are lighter shades of this color.'));
    } else if (mode === 'group') {
      for (var i = 0; i < cfg.bars.palette.length; i++) g2.appendChild(colorRow('Group color ' + (i + 1), 'bars.palette.' + i));
      g2.appendChild(colorRow('“Other” (more than 12 groups)', 'bars.otherColor'));
      g2.appendChild(help('Groups are numbered from the largest. Without a Group tile every bar uses color 1.'));
    } else {
      g2.appendChild(numberRow('Near: up to (months from today)', 'bars.near', 0, 600, 1));
      g2.appendChild(numberRow('Middle: up to (months)', 'bars.mid', 0, 600, 1));
      g2.appendChild(numberRow('Far: up to (months)', 'bars.far', 0, 600, 1));
      g2.appendChild(colorRow('Overdue', 'bars.overdueColor'));
      g2.appendChild(colorRow('Near', 'bars.distColors.0'));
      g2.appendChild(colorRow('Middle', 'bars.distColors.1'));
      g2.appendChild(colorRow('Far', 'bars.distColors.2'));
      g2.appendChild(colorRow('Beyond far (and Later)', 'bars.distColors.3'));
      g2.appendChild(help('A bar’s color follows how far its first day is from today. With a Group, the segments are shades of it.'));
    }
  }

  // ---------------------------------------------------------------------------
  // Today & running total tab
  // ---------------------------------------------------------------------------
  function buildTodayTab (p) {
    var g1 = group(p, 'Today marker');
    g1.appendChild(checkboxRow('Show the marker', 'today.show'));
    g1.appendChild(textRow('Fixed date (for testing)', 'today.date', 'YYYY-MM-DD, empty = today'));
    g1.appendChild(help('Leave empty to use the real date. A fixed date makes “today” the same on every day, which helps when you check the chart.'));
    g1.appendChild(textRow('Label', 'today.label', 'Today'));
    g1.appendChild(colorRow('Color', 'today.color'));
    g1.appendChild(selectRow('Line', 'today.lineStyle', LINE_STYLES));
    g1.appendChild(numberRow('Line width', 'today.lineWidth', 0.5, 6, 0.5));
    var g2 = group(p, 'Next buckets');
    g2.appendChild(numberRow('Highlight the next N buckets', 'today.highlightNext', 0, 60, 1));
    g2.appendChild(colorRow('Highlight color', 'today.highlightColor'));
    g2.appendChild(help('0 = off. Shades the N buckets that start after today.'));
    var g3 = group(p, 'Running total');
    g3.appendChild(checkboxRow('Show the running total line', 'cumulative.show'));
    g3.appendChild(colorRow('Color', 'cumulative.color'));
    g3.appendChild(numberRow('Line width', 'cumulative.width', 1, 6, 0.5));
    g3.appendChild(checkboxRow('Dot on every bucket', 'cumulative.points'));
    g3.appendChild(textRow('Right axis title', 'cumulative.title', 'Running total'));
  }

  // ---------------------------------------------------------------------------
  // Labels tab
  // ---------------------------------------------------------------------------
  function buildLabelsTab (p) {
    var g1 = group(p, 'Show');
    g1.appendChild(checkboxRow('Total on top of each bar', 'labels.showTotals'));
    g1.appendChild(checkboxRow('Number of items', 'labels.showCounts'));
    g1.appendChild(help('Counts the members of the Item tile, or the rows when there is none. Text never overlaps: labels that do not fit are left out (the tooltip has everything).'));
    [['total', 'Total'], ['count', 'Count'], ['axis', 'Axis']].forEach(function (f) {
      var g = group(p, f[1] + ' text');
      g.appendChild(numberRow('Size (px)', 'labels.' + f[0] + '.size', 6, 48, 1));
      g.appendChild(selectRow('Weight', 'labels.' + f[0] + '.weight', WEIGHTS));
      g.appendChild(colorRow('Color', 'labels.' + f[0] + '.color'));
    });
    var g2 = group(p, 'Number format');
    labelFmt(g2, 'labels.fmt');

    var g3 = group(p, 'Axes');
    g3.appendChild(checkboxRow('Grid lines', 'axes.grid'));
    g3.appendChild(colorRow('Grid color', 'axes.gridColor'));
    g3.appendChild(colorRow('Axis line color', 'axes.lineColor'));
    g3.appendChild(textRow('Left axis title', 'axes.yTitle', 'empty = none'));
    g3.appendChild(textRow('Bottom axis title', 'axes.xTitle', 'empty = none'));

    var g4 = group(p, 'Legend');
    g4.appendChild(checkboxRow('Show the legend (when Group is used)', 'legend.show'));
    g4.appendChild(selectRow('Position', 'legend.position', [['top', 'Above the chart'], ['bottom', 'Below the chart']]));
    g4.appendChild(numberRow('Size (px)', 'legend.size', 6, 24, 1));
    g4.appendChild(colorRow('Text color', 'legend.color'));
  }

  // ---------------------------------------------------------------------------
  // Numbers tab
  // ---------------------------------------------------------------------------
  /** Every label format, so "each" can start from the shared format. */
  function allLabelFmtPaths () {
    return [['labels', 'fmt']];
  }

  function copyGlobalToAll () {
    allLabelFmtPaths().forEach(function (pth) {
      var last = pth[pth.length - 1];
      pth.slice(0, -1).reduce(function (o, k) { return o[k]; }, cfg)[last] = Ml.clone(cfg.format);
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
      ? 'Totals and axis numbers use the format below.'
      : 'The labels have their own format (Labels tab). It started as a copy of the format below.'));

    var g2 = group(p, cfg.numbers.mode === 'all' ? 'Number format' : 'Shared format');
    fmtRows(g2, 'format');
    if (cfg.numbers.mode === 'each') {
      var btn = h('button', { type: 'button', className: 'btn', textContent: 'Copy this format to every label' });
      btn.addEventListener('click', function () { copyGlobalToAll(); setStatus('Copied to every label'); });
      g2.appendChild(btn);
    }

    var g3 = group(p, 'Chart text');
    g3.appendChild(fontFamilyRow('Font', 'numbers.font'));
    g3.appendChild(help('Font of all text in the chart. Sizes and colors are on the Labels tab.'));
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
    var gExp = group(p, 'Export');
    gExp.appendChild(checkboxRow('Save as picture button', 'export.picture'));
    gExp.appendChild(help('Shows a button in the top-right corner (on hover) that saves the chart as a PNG picture.'));
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
        var r = Ml.iconHtml(ic.builtinId, ic.color);
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
        Ml.ICON_GROUPS.forEach(function (groupName) {
          var icons = Ml.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Ml.iconHtml(icon.id, ic.color).html;
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
    g1.appendChild(textRow('Title', 'title.text', 'Defaults to "Maturity ladder"'));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(textRow('Text', 'explanation.text', 'e.g. Web shop, last 30 days'));
    fontRows(g2, 'explanation', true);
  }

  // ---------------------------------------------------------------------------

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------
  var PRESET_TYPE = 'tableau-maturity-ladder-preset';
  var PRESET_STORE = 'maturity-ladder:presets:v1';

  /**
   * Settings tied to this worksheet's fields and data (a fixed Today date,
   * texts naming the data, row limit).
   * "Look only" presets leave them out, and an import keeps the chart's own unless asked otherwise.
   */
  var FIELD_PATHS = [
    'title.text', 'explanation.text', // text that names this worksheet's data
    'today.date', // a fixed date belongs to the sheet it was set for
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
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer Maturity Ladder. Update the extension, then import it again.');
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  /** Only the settings that differ from the defaults (smaller files, future-proof). */
  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : Ml.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? Ml.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    var s = Ml.clone(cfg);
    if (scope === 'look') FIELD_PATHS.forEach(function (p) { delAt(s, p); });
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'MaturityLadder preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: diffFromDefaults(s, Ml.DEFAULTS) || {}
    };
  }

  /** Accepts a preset file, or the raw settings JSON of a workbook. */
  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a Maturity Ladder preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o.maturityLadder1) { try { o = typeof o.maturityLadder1 === 'string' ? JSON.parse(o.maturityLadder1) : o.maturityLadder1; } catch (e) { /* fall through */ } }
    var known = Object.keys(o).filter(function (k) { return k in Ml.DEFAULTS; });
    if (!known.length) throw new Error('No Maturity Ladder settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    pr = migratePreset(pr);
    var next = Ml.merge(Ml.DEFAULTS, pr.settings);
    var own = pr.scope === 'look' || keepFields;
    FIELD_PATHS.forEach(function (p) {
      var has = getAt(pr.settings, p) !== undefined;
      if (own || !has) setAt(next, p, Ml.clone(getAt(cfg, p)));
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
    return (String(name || 'maturity-ladder-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'maturity-ladder-preset') + '.json';
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
    g1.appendChild(help('Saves this chart’s settings as a preset you can import into another Maturity Ladder, in this or any workbook.'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Dark ladder' });
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
      ? 'Bars, colors, labels, numbers, icon, card… Leaves out what belongs to this sheet’s data: a fixed Today date, title and explanation text, row limit.'
      : 'Every setting, including a fixed Today date. Best for a copy of the same sheet.'));

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
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'a fixed Today date, title and explanation text, row limit' })]));
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
    if (window.ExtTheme && ExtTheme.section) {
      p.appendChild(ExtTheme.section({
        h: h,
        name: 'Maturity Ladder',
        themeMap: Ml.THEME_MAP,
        getSettings: function () { return cfg; },
        applySettings: function (next) { cfg = next; changed(); buildTabs(); }
      }));
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
    if (hist) hist.record();
  }

  function flush () {
    clearTimeout(saveTimer);
    return persist();
  }

  function persist () {
    try {
      setStatus('Saving…');
      return Ml.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }


  window.MaturityLadderConfigure = { init: init };
})();
