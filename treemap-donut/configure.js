'use strict';

/**
 * Format dialog for the Treemap & Donut extension ("Format Extension" on the Marks
 * card, or right-click in the chart).
 *
 * Every change is saved straight away (debounced), so the chart behind the
 * dialog updates live. Cancel restores what was stored on open.
 * The chart passes the first-level members and the Category names as the dialog
 * payload, because a dialog can't read the worksheet.
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var hist = null; // undo / redo steps (shared/dialog.js)
  var activeTab = 'chart';
  var shapeIndex = null;
  var info = { levels: 0, dims: [], hasColor: false, members: [], focus: null };

  var WEIGHTS = ExtDialog.WEIGHTS;

  // Controls shared by every Format dialog: shared/dialog.js.
  const kit = ExtDialog.kit({
    get: get,
    set: set,
    fonts: Td.FONTS
  });
  const h = ExtDialog.h, P = ExtDialog.P, group = ExtDialog.group, help = ExtDialog.help,
    escapeHtml = ExtDialog.escapeHtml, blobToIconDataUrl = ExtDialog.blobToIconDataUrl,
    setStatus = ExtDialog.setStatus, baseUrl = ExtDialog.baseUrl;
  const row = kit.row, textRow = kit.textRow, numberRow = kit.numberRow, rangeRow = kit.rangeRow,
    checkboxRow = kit.checkboxRow, selectRow = kit.selectRow, segRow = kit.segRow, colorRow = kit.colorRow,
    unitRow = kit.unitRow, fontFamilyRow = kit.fontFamilyRow, fontRows = kit.fontRows;
  const copyText = ExtDialog.copyText, download = ExtDialog.download,
    getAt = ExtDialog.getAt, setAt = ExtDialog.setAt, delAt = ExtDialog.delAt;

  var TABS = [
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'chart', label: 'Chart', build: buildChartTab, keys: ['chart', 'interaction'] },
    { id: 'layout', label: 'Layout', build: buildLayoutTab, keys: ['layout'] },
    { id: 'labels', label: 'Labels', build: buildLabelsTab, keys: ['labels'] },
    { id: 'colors', label: 'Colours', build: buildColorsTab, keys: ['colors'] },
    { id: 'center', label: 'Centre & legend', build: buildCenterTab, keys: ['center', 'legend'] },
    { id: 'numbers', label: 'Numbers', build: buildNumbersTab, keys: ['numbers', 'format', 'colorFormat'] },
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
        info.levels = p.levels || 0;
        info.dims = p.dims || [];
        info.hasColor = !!p.hasColor;
        info.members = p.members || [];
        info.focus = p.focus || null;
      } catch (e) { /* opened without payload */ }

      cfg = Td.read();
      original = Td.clone(cfg);

      if (info.focus && info.focus.tab) activeTab = info.focus.tab;

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
      console.error('Treemap & Donut dialog failed to initialize:', err);
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
    tab.keys.forEach(function (k) { cfg[k] = Td.clone(Td.DEFAULTS[k]); });
    changed();
    buildTabs();
  }

  // ---------------------------------------------------------------------------
  // Number format editor
  // ---------------------------------------------------------------------------
  function fmtRows (g, base) {
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
      sample.textContent = 'Preview: ' + Td.formatNumber(1284500, f) + '   ' + Td.formatNumber(45200, f) + '   ' + Td.formatNumber(-3100, f) + '   ' + Td.formatNumber(0, f);
    };
    upd();
    g.addEventListener('input', upd);
    g.addEventListener('change', upd);
    g.appendChild(sample);
  }

  // ---------------------------------------------------------------------------
  // Chart tab
  // ---------------------------------------------------------------------------
  function buildChartTab (p) {
    var mode = cfg.chart.mode;
    var g1 = group(p, 'Chart');
    g1.appendChild(segRow('Type', 'chart.mode', [['treemap', 'Treemap'], ['donut', 'Donut'], ['pie', 'Pie']], rebuild));
    if (mode === 'treemap') {
      g1.appendChild(segRow('Levels shown at once', 'chart.depth', [[1, 'One'], [2, 'Two']], rebuild));
      g1.appendChild(help('Two: each group of the first level gets a header and contains its second-level tiles. Needs two or more Category fields.'));
    } else {
      g1.appendChild(help('A donut or pie shows one level at a time: click a slice to look inside it.'));
    }
    g1.appendChild(selectRow('Order', 'chart.sort', Td.SORTS));
    if (mode !== 'treemap') {
      g1.appendChild(rangeRow('Group slices below', 'chart.othersThreshold', 0, 20, 0.5, '%'));
      g1.appendChild(help('Slices smaller than this share of their parent are grouped into “Others”. 0 keeps every slice.'));
    }
    g1.appendChild(numberRow('Most items per parent', 'chart.maxItems', 0, 200, 1));
    g1.appendChild(help('The smallest items beyond this number are grouped into “Others”. 0 = no limit.'));
    g1.appendChild(checkboxRow('Show the path above the chart', 'chart.breadcrumb'));
    g1.appendChild(textRow('Name of the top level', 'chart.rootName', 'All'));

    var g4 = group(p, 'Interaction');
    g4.appendChild(selectRow('Click', 'interaction.click', [
      ['drill', 'Opens the tile (items without children are selected)'],
      ['select', 'Selects it in Tableau'],
      ['both', 'Click selects, double-click opens']]));
    g4.appendChild(checkboxRow('Selecting sends the value to Tableau', 'interaction.selectInTableau'));
    g4.appendChild(help('Every level down to the clicked item is selected, so dashboard actions can filter by it.'));
    g4.appendChild(checkboxRow('Show tooltip', 'interaction.tooltip'));
    g4.appendChild(checkboxRow('Use Tableau’s tooltip', 'interaction.tableauTooltip'));
    g4.appendChild(checkboxRow('Right-click menu', 'interaction.rightClickMenu'));
  }

  // ---------------------------------------------------------------------------
  // Layout tab
  // ---------------------------------------------------------------------------
  function buildLayoutTab (p) {
    var g1 = group(p, 'Treemap');
    g1.appendChild(numberRow('Space between tiles (px)', 'layout.gap', 0, 20, 1));
    g1.appendChild(numberRow('Space inside a group (px)', 'layout.padding', 0, 20, 1));
    g1.appendChild(numberRow('Corner radius (px)', 'layout.radius', 0, 20, 1));
    g1.appendChild(numberRow('Group header height (px)', 'layout.headerHeight', 10, 40, 1));
    var g2 = group(p, 'Donut and pie');
    g2.appendChild(rangeRow('Ring thickness', 'layout.thickness', 10, 90, 1, '%'));
    g2.appendChild(help('Share of the radius. Not used by the pie.'));
    g2.appendChild(numberRow('Gap between slices (px)', 'layout.sliceGap', 0, 10, 0.5));
    var g3 = group(p, 'Border');
    g3.appendChild(colorRow('Colour', 'layout.borderColor'));
    g3.appendChild(numberRow('Width (px)', 'layout.borderWidth', 0, 6, 0.5));
  }

  // ---------------------------------------------------------------------------
  // Labels tab
  // ---------------------------------------------------------------------------
  function buildLabelsTab (p) {
    var g1 = group(p, 'Show');
    g1.appendChild(checkboxRow('Labels', 'labels.show'));
    g1.appendChild(checkboxRow('Name', 'labels.name'));
    g1.appendChild(checkboxRow('Value', 'labels.value'));
    g1.appendChild(checkboxRow('Share of the parent (“34% of Apparel”)', 'labels.shareParent'));
    g1.appendChild(checkboxRow('Share of the total', 'labels.shareTotal'));
    g1.appendChild(numberRow('Decimals in %', 'labels.shareDecimals', 0, 3, 1));
    g1.appendChild(help('Treemap labels are clipped to their tile and left out when they do not fit; the tooltip has everything.'));
    var g2 = group(p, 'Treemap labels');
    g2.appendChild(numberRow('Hide labels on tiles narrower than (px)', 'labels.minWidth', 0, 400, 1));
    g2.appendChild(numberRow('Hide labels on tiles lower than (px)', 'labels.minHeight', 0, 200, 1));
    g2.appendChild(numberRow('Group header size (px)', 'labels.headerSize', 6, 32, 1));
    g2.appendChild(selectRow('Group header weight', 'labels.headerWeight', WEIGHTS));
    var g3 = group(p, 'Donut and pie labels');
    g3.appendChild(selectRow('Placement', 'labels.donutPlacement', [['outside', 'Outside, with leader lines'], ['legend', 'Legend only']]));
    g3.appendChild(help('Outside labels need room; in a small frame the chart falls back to the tooltip and centre text.'));
    var g4 = group(p, 'Text');
    g4.appendChild(fontFamilyRow('Font', 'labels.font'));
    g4.appendChild(numberRow('Size (px)', 'labels.size', 6, 48, 1));
    g4.appendChild(selectRow('Weight', 'labels.weight', WEIGHTS));
    g4.appendChild(segRow('Colour', 'labels.colorMode', [['auto', 'Contrast on the tile'], ['custom', 'Custom']], rebuild));
    if (cfg.labels.colorMode === 'custom') g4.appendChild(colorRow('Text colour', 'labels.color'));
    else g4.appendChild(help('Outside labels use the colour set under “Custom”; switch to it to change them.'));
  }

  // ---------------------------------------------------------------------------
  // Colours tab
  // ---------------------------------------------------------------------------
  function buildColorsTab (p) {
    var C = cfg.colors;
    var g1 = group(p, 'Colour by');
    g1.appendChild(segRow('Colours', 'colors.mode', [['tint', 'Tints of the parent'], ['member', 'First level'], ['measure', 'Colour measure']], rebuild));
    if (C.mode === 'measure') {
      if (!info.hasColor) g1.appendChild(help('Nothing is on the Colour tile yet: until you add a measure there, tiles use tints of the parent.'));
      g1.appendChild(colorRow('Lowest', 'colors.rampLow'));
      g1.appendChild(checkboxRow('Centre the scale on a value', 'colors.rampCenter', rebuild));
      if (C.rampCenter) {
        g1.appendChild(colorRow('Middle', 'colors.rampMid'));
        g1.appendChild(numberRow('Centre value', 'colors.rampCenterValue', -1000000000, 1000000000, 0.01));
      }
      g1.appendChild(colorRow('Highest', 'colors.rampHigh'));
      g1.appendChild(segRow('Lowest value', 'colors.rampMin', [['auto', 'From the data'], ['manual', 'Fixed']], rebuild));
      if (C.rampMin === 'manual') g1.appendChild(numberRow('Lowest at', 'colors.rampMinValue', -1000000000, 1000000000, 0.01));
      g1.appendChild(segRow('Highest value', 'colors.rampMax', [['auto', 'From the data'], ['manual', 'Fixed']], rebuild));
      if (C.rampMax === 'manual') g1.appendChild(numberRow('Highest at', 'colors.rampMaxValue', -1000000000, 1000000000, 0.01));
      g1.appendChild(colorRow('No value', 'colors.nullColor'));
      g1.appendChild(help('A small bar under the chart shows the scale. Its number format is on the Numbers tab.'));
    } else {
      if (C.mode === 'tint') g1.appendChild(rangeRow('Lighter per level', 'colors.tintStep', 0, 50, 1, '%'));
      g1.appendChild(help('Each first-level member gets a colour; the items inside use it ' + (C.mode === 'tint' ? 'in lighter tints.' : 'as it is.')));
      var g2 = group(p, 'Palette');
      (C.palette || []).forEach(function (_c, i) { g2.appendChild(colorRow('Colour ' + (i + 1), ['colors', 'palette', i])); });
      var g3 = group(p, 'Own colour for a member');
      if (!info.members.length) g3.appendChild(help('Fill the Category tile first; then the first-level members are listed here.'));
      info.members.forEach(function (name) {
        var base = ['colors', 'overrides', name];
        var r = row(name);
        var cb = h('input', { type: 'checkbox' });
        cb.checked = !!(C.overrides && C.overrides[name]);
        cb.addEventListener('change', function () {
          if (cb.checked) set(base, C.overrides && C.overrides[name] || '#2F4B7C');
          else { delete cfg.colors.overrides[name]; changed(); }
          rebuild();
        });
        r.appendChild(cb);
        g3.appendChild(r);
        if (cb.checked) g3.appendChild(colorRow('Colour of ' + name, base));
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Centre & legend tab
  // ---------------------------------------------------------------------------
  function buildCenterTab (p) {
    var g1 = group(p, 'Centre text (donut)');
    g1.appendChild(checkboxRow('Show', 'center.show'));
    g1.appendChild(textRow('Title above the total', 'center.title', 'Total'));
    g1.appendChild(checkboxRow('Hovering a slice shows it in the centre', 'center.hover'));
    g1.appendChild(checkboxRow('Show its share', 'center.showShare'));
    g1.appendChild(numberRow('Value size (px)', 'center.valueSize', 8, 60, 1));
    g1.appendChild(selectRow('Value weight', 'center.valueWeight', WEIGHTS));
    g1.appendChild(colorRow('Value colour', 'center.valueColor'));
    g1.appendChild(numberRow('Text size (px)', 'center.textSize', 6, 32, 1));
    g1.appendChild(colorRow('Text colour', 'center.textColor'));
    var g2 = group(p, 'Legend');
    g2.appendChild(selectRow('Position', 'legend.position', [['off', 'Off'], ['right', 'Right'], ['bottom', 'Bottom']]));
    g2.appendChild(numberRow('Most entries', 'legend.maxItems', 1, 60, 1));
    g2.appendChild(numberRow('Text size (px)', 'legend.size', 6, 32, 1));
    g2.appendChild(colorRow('Text colour', 'legend.color'));
    g2.appendChild(help('With a Colour measure the legend is a bar showing the scale. A small frame leaves the legend out.'));
  }

  // ---------------------------------------------------------------------------
  // Numbers tab
  // ---------------------------------------------------------------------------
  function buildNumbersTab (p) {
    var g1 = group(p, 'Size format');
    fmtRows(g1, 'format');
    var g2 = group(p, 'Colour measure format');
    fmtRows(g2, 'colorFormat');
    g2.appendChild(help('For the tooltip and the colour bar. A growth ratio such as 0.12 reads best as Percentage with “0–1 ratio” on.'));
    var g3 = group(p, 'Chart text');
    g3.appendChild(fontFamilyRow('Font', 'numbers.font'));
    g3.appendChild(help('Font of all text in the chart. Sizes and colours are on the Labels tab.'));
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
        var r = Td.iconHtml(ic.builtinId, ic.color);
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
        Td.ICON_GROUPS.forEach(function (groupName) {
          var icons = Td.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Td.iconHtml(icon.id, ic.color).html;
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
    g1.appendChild(textRow('Title', 'title.text', 'Defaults to "Size by Category"'));
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
  var PRESET_TYPE = 'tableau-treemap-donut-preset';
  var PRESET_STORE = 'treemapDonut:presets:v1';

  /**
   * Settings tied to this worksheet's fields and data (member colours, texts naming the data, row limit).
   * "Look only" presets leave them out, and an import keeps the chart's own unless asked otherwise.
   */
  var FIELD_PATHS = [
    'title.text', 'explanation.text', // text that names this worksheet's data
    'chart.rootName', // name of the top of the breadcrumb
    'colors.overrides', // per-member colours, keyed by first-level member name
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
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer Treemap & Donut. Update the extension, then import it again.');
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  /** Only the settings that differ from the defaults (smaller files, future-proof). */
  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : Td.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? Td.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    var s = Td.clone(cfg);
    if (scope === 'look') FIELD_PATHS.forEach(function (p) { delAt(s, p); });
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'Treemap & Donut preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: diffFromDefaults(s, Td.DEFAULTS) || {}
    };
  }

  /** Accepts a preset file, or the raw settings JSON of a workbook. */
  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a Treemap & Donut preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o.treemapDonut1) { try { o = typeof o.treemapDonut1 === 'string' ? JSON.parse(o.treemapDonut1) : o.treemapDonut1; } catch (e) { /* fall through */ } }
    var known = Object.keys(o).filter(function (k) { return k in Td.DEFAULTS; });
    if (!known.length) throw new Error('No Treemap & Donut settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    pr = migratePreset(pr);
    var next = Td.merge(Td.DEFAULTS, pr.settings);
    var own = pr.scope === 'look' || keepFields;
    FIELD_PATHS.forEach(function (p) {
      var has = getAt(pr.settings, p) !== undefined;
      if (own || !has) setAt(next, p, Td.clone(getAt(cfg, p)));
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
    return (String(name || 'treemap-donut-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'treemap-donut-preset') + '.json';
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
    g1.appendChild(help('Saves this chart’s settings as a preset you can import into another Treemap & Donut, in this or any workbook.'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Dark treemap' });
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
      ? 'Chart type, colours, labels, numbers, icon, card… Leaves out what belongs to this sheet’s data: member colours, title and explanation text, row limit.'
      : 'Every setting, including member colours. Best for a copy of the same sheet.'));

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
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'member colours, title and explanation text, row limit' })]));
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
        name: 'Treemap & Donut',
        themeMap: Td.THEME_MAP,
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
      return Td.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }


  window.TreemapDonutConfigure = { init: init };
})();
