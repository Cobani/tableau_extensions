'use strict';

/**
 * Format dialog for KPI Card Multi (opened by "Format Extension" on the Marks card).
 *
 * Every change is saved straight away (debounced), so the card behind the
 * modeless dialog updates live. Cancel restores what was stored on open.
 */
(function () {
  var store = null;     // { shared, cards } as saved in the workbook
  var original = null;  // store when the dialog opened (Cancel)
  var cardList = [];    // [{ key, label }] from the extension, in Measures-tile order
  var currentKey = null;
  var cfg = null;       // the selected card's full settings (view); edits are split back into store
  var saveTimer = null;
  var hist = null; // undo / redo steps (shared/dialog.js)
  var activeTab = 'icon';
  var shapeIndex = null; // { palettes: [{ name, files: [{ name, url }] }] }
  var detailList = [];   // [{ key, label }] Details tile measures, sent by the extension
  var detailIdx = 0;     // measure open on the Tooltip tab

  var WEIGHTS = ExtDialog.WEIGHTS;

  // Controls shared by every Format dialog: shared/dialog.js.
  // Rows for a per-card setting say "this card" while a card is selected.
  const rowDecorator = function (r, path, label) {
    if (path && currentKey != null && KpiCardMultiConfig.isPerCard(path)) {
      label.appendChild(h('span', { className: 'tag-card', textContent: 'this card' }));
    }
  };
  const kit = ExtDialog.kit({
    get: get,
    set: set,
    fonts: KpiCardMultiConfig.FONTS,
    fontPath: function (section, key) { return section + '.' + key; },
    rowDecorator: rowDecorator
  });
  const h = ExtDialog.h, group = ExtDialog.group, escapeHtml = ExtDialog.escapeHtml,
    blobToIconDataUrl = ExtDialog.blobToIconDataUrl, setStatus = ExtDialog.setStatus, baseUrl = ExtDialog.baseUrl;
  const row = kit.row, textRow = kit.textRow, numberRow = kit.numberRow, rangeRow = kit.rangeRow,
    checkboxRow = kit.checkboxRow, selectRow = kit.selectRow, segRow = kit.segRow, colorRow = kit.colorRow,
    unitRow = kit.unitRow, fontFamilyRow = kit.fontFamilyRow, fontRows = kit.fontRows;
  const help = ExtDialog.help, copyText = ExtDialog.copyText, download = ExtDialog.download,
    getAt = ExtDialog.getAt, setAt = ExtDialog.setAt, delAt = ExtDialog.delAt;

  var TABS = [
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'number', label: 'Big number', build: buildNumberTab, keys: ['number'] },
    { id: 'change', label: '% Change', build: buildChangeTab, keys: ['change'] },
    { id: 'bottom', label: 'Bottom', build: buildBottomTab, keys: ['bottom'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card', 'data', 'interaction'] },
    { id: 'layout', label: 'Layout', build: buildLayoutTab, keys: ['layout'] },
    { id: 'details', label: 'Tooltip', build: buildDetailsTab, keys: ['details'] },
    { id: 'presets', label: 'Presets', build: buildPresetsTab, keys: [] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try { cardList = (JSON.parse(payload || '{}').cards) || []; } catch (e) { cardList = []; }
      try { detailList = (JSON.parse(payload || '{}').details) || []; } catch (e) { detailList = []; }
      store = KpiCardMultiConfig.read();
      original = KpiCardMultiConfig.clone(store);
      currentKey = cardList.length ? cardList[0].key : null;
      cfg = KpiCardMultiConfig.cardConfig(store, currentKey);
      buildPicker();
      buildTabs();
      hist = ExtDialog.history({
        // Whole store plus the selected card: undo can switch back to the card that was edited.
        snapshot: function () { KpiCardMultiConfig.splitInto(store, currentKey, cfg); return JSON.stringify({ store: store, key: currentKey }); },
        restore: function (json) {
          var s = JSON.parse(json);
          store = s.store;
          currentKey = s.key;
          cfg = KpiCardMultiConfig.cardConfig(store, currentKey);
          buildPicker();
          changed();
          buildTabs();
        }
      });
      ExtDialog.footerTools({ history: hist, footer: document.querySelector('.footer') });
      ExtDialog.search({
        tabs: document.getElementById('tabs'),
        container: document.getElementById('panels'),
        getTabs: function () { return TABS; },
        openTab: function (id) { activeTab = id; buildTabs(); }
      });
      document.getElementById('cancel').addEventListener('click', function () {
        store = original;
        cfg = KpiCardMultiConfig.cardConfig(store, currentKey);
        flush().then(close);
      });
      document.getElementById('apply-all').addEventListener('click', applyToAll);
      document.getElementById('done').addEventListener('click', function () { flush().then(close); });
      document.getElementById('reset-tab').addEventListener('click', resetTab);
    }).catch(function (err) {
      console.error('KPI Card Multi dialog failed to initialize:', err);
    });
  }

  /** Which card is being formatted. Per-card settings are marked "this card". */
  function buildPicker () {
    var box = document.getElementById('picker');
    box.innerHTML = '';
    if (!cardList.length) {
      box.appendChild(h('p', { className: 'note', textContent: 'No measures on the Measures tile yet. Settings below apply to every card.' }));
      return;
    }
    var r = h('div', { className: 'row' });
    r.appendChild(h('label', { textContent: 'Card' }));
    var sel = h('select');
    cardList.forEach(function (c, i) { sel.appendChild(h('option', { value: String(i), textContent: (i + 1) + '. ' + c.label })); });
    sel.value = String(Math.max(0, cardList.findIndex(function (c) { return c.key === currentKey; })));
    sel.addEventListener('change', function () {
      flush();
      currentKey = cardList[Number(sel.value)].key;
      cfg = KpiCardMultiConfig.cardConfig(store, currentKey);
      buildTabs();
    });
    r.appendChild(sel);
    box.appendChild(r);
    box.appendChild(h('div', { className: 'help', innerHTML: 'Settings marked <span class="tag-card">this card</span> apply only to the selected card. Everything else applies to all cards.' }));
  }

  /** Copies this card's per-card settings on the open tab to every card. */
  function applyToAll () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    var secs = tab.keys.concat(activeTab === 'layout' ? ['card'] : []);
    var n = 0;
    secs.forEach(function (sec) {
      Object.keys(cfg[sec]).forEach(function (k) {
        if (!KpiCardMultiConfig.isPerCard(sec + '.' + k)) return;
        if (activeTab === 'card' && k === 'weight') return; // width lives on the Layout tab
        var v = cfg[sec][k];
        store.shared[sec][k] = KpiCardMultiConfig.clone(v);
        Object.keys(store.cards).forEach(function (ck) {
          if (store.cards[ck][sec] && k in store.cards[ck][sec]) store.cards[ck][sec][k] = KpiCardMultiConfig.clone(v);
        });
        n++;
      });
    });
    setStatus(n ? 'Applied to all cards' : 'Nothing card-specific on this tab');
    changed();
  }

  function updateApplyAll () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    var secs = tab.keys.concat(activeTab === 'layout' ? ['card'] : []);
    var has = secs.some(function (sec) {
      return Object.keys(cfg[sec]).some(function (k) {
        return KpiCardMultiConfig.isPerCard(sec + '.' + k) && !(activeTab === 'card' && k === 'weight');
      });
    });
    document.getElementById('apply-all').hidden = !has || cardList.length < 2;
  }

  function buildTabs () {
    var nav = document.getElementById('tabs');
    var panels = document.getElementById('panels');
    nav.innerHTML = '';
    panels.innerHTML = '';

    TABS.forEach(function (tab) {
      var b = h('button', { className: 'tab', type: 'button', role: 'tab', textContent: tab.label });
      b.setAttribute('aria-selected', String(tab.id === activeTab));
      b.addEventListener('click', function () { activeTab = tab.id; buildTabs(); });
      nav.appendChild(b);

      var panel = h('section', { className: 'panel', role: 'tabpanel' });
      panel.hidden = tab.id !== activeTab;
      if (!panel.hidden) tab.build(panel);
      panels.appendChild(panel);
    });
    updateApplyAll();
  }

  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) { cfg[k] = KpiCardMultiConfig.clone(KpiCardMultiConfig.DEFAULTS[k]); });
    changed();
    buildTabs();
  }

  // ---------------------------------------------------------------------------
  // Tabs
  // ---------------------------------------------------------------------------
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
        var r = KpiCardMultiConfig.iconHtml(ic.builtinId, ic.color);
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
        KpiCardMultiConfig.ICON_GROUPS.forEach(function (groupName) {
          var icons = KpiCardMultiConfig.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = KpiCardMultiConfig.iconHtml(icon.id, ic.color).html;
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
    g1.appendChild(checkboxRow('Show title', 'title.show'));
    g1.appendChild(textRow('Title', 'title.text', 'Defaults to the Big number field name'));
    g1.appendChild(segRow('Alignment', 'title.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
    g1.appendChild(h('div', { className: 'help', textContent: 'The explanation text follows the same alignment.' }));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(checkboxRow('Keep space when empty', 'explanation.reserveSpace'));
    g2.appendChild(h('div', { className: 'help', textContent: 'Reserves the explanation line even when it is empty or hidden, so big numbers line up across cards on a dashboard.' }));
    g2.appendChild(textRow('Text', 'explanation.text', 'e.g. % Top-Up vs Local Transfer'));
    fontRows(g2, 'explanation', true);
  }

  function buildNumberTab (p) {
    var g1 = group(p, 'Value');
    g1.appendChild(checkboxRow('Show big number', 'number.show'));
    g1.appendChild(segRow('Value', 'number.period', [['day', 'Single day'], ['mtd', 'Month to date']], function () { buildTabs(); }));
    if (cfg.number.period === 'mtd') {
      g1.appendChild(selectRow('MTD roll-up', 'number.mtdAgg', [['sum', 'Sum of days'], ['avg', 'Average of days']]));
    }
    g1.appendChild(h('div', { className: 'help', textContent: 'Single day: the value at the latest date. Month to date: day 1 of the latest month through the latest date (needs a real date on the Date tile). Independent of the % Change period.' }));
    var fmtRow = selectRow('Number format', 'number.scale', [
      ['dynamic', 'Dynamic (K / M / B)'], ['K', 'Thousands (K)'], ['M', 'Millions (M)'],
      ['B', 'Billions (B)'], ['none', 'Full number'],
      ['percent', 'Percentage (%)'], ['percentDynamic', 'Percentage, dynamic (K / M / B %)'],
      ['workbook', 'Workbook format']
    ]);
    // Show or hide the ratio option as soon as the format changes.
    fmtRow.querySelector('select').addEventListener('change', function () { buildTabs(); });
    g1.appendChild(fmtRow);
    if (cfg.number.scale === 'percent' || cfg.number.scale === 'percentDynamic') {
      g1.appendChild(checkboxRow('Metric is a 0\u20131 ratio', 'number.pctFromRatio'));
      g1.appendChild(h('div', { className: 'help', textContent: 'On: 0.4523 \u2192 45.23%. Off: 45.23 \u2192 45.23%. The % sign is the same size as the number.' }));
    }
    g1.appendChild(numberRow('Decimal places', 'number.decimals', 0, 6, 1));
    g1.appendChild(unitRow('Unit', 'number.unit', 'e.g. SAR, %, users'));
    g1.appendChild(selectRow('Unit position', 'number.unitPosition', [['suffix', 'After number'], ['prefix', 'Before number']]));
    g1.appendChild(numberRow('Unit size (px)', 'number.unitSize', 6, 120, 1));

    var g2 = group(p, 'Style');
    fontRows(g2, 'number', true);
    g2.appendChild(checkboxRow('Shrink to fit width', 'number.shrinkToFit'));

  }

  function buildChangeTab (p) {
    var g0 = group(p, 'Comparison');
    g0.appendChild(segRow('Compare with', 'change.compareTo',
      [['previous', 'Previous date'], ['prevMonth', 'Same day last month']]));
    g0.appendChild(segRow('Period', 'change.period', [['day', 'Single day'], ['mtd', 'Month to date']], function () { buildTabs(); }));
    if (cfg.change.period === 'mtd') {
      g0.appendChild(selectRow('MTD roll-up', 'change.mtdAgg', [['sum', 'Sum of days'], ['avg', 'Average of days']]));
    }
    g0.appendChild(h('div', {
      className: 'help',
      textContent: 'Same day last month: 11 Oct vs 11 Sep (31 Mar vs 28/29 Feb). Month to date: 1–11 Oct vs 1–11 Sep, or vs MTD at the previous date. ' +
        'Both need a real date on the Date tile (exact date or DAY / MONTH as a date), not date parts. Use Sum for flows (volumes, counts) and Average for balances and ratios.'
    }));

    var g1 = group(p, 'Change');
    g1.appendChild(checkboxRow('Show change', 'change.show'));
    g1.appendChild(segRow('Type', 'change.type', [['percent', '% change'], ['pp', 'pp change']], function () { buildTabs(); }));
    var pp = checkboxRow('Metric is a 0–1 ratio', 'change.ppFromRatio');
    pp.hidden = cfg.change.type !== 'pp';
    g1.appendChild(pp);
    if (!pp.hidden) g1.appendChild(h('div', { className: 'help', textContent: 'On: 0.45 vs 0.40 → +5.00 pp. Off: 45 vs 40 → +5.00 pp.' }));
    g1.appendChild(numberRow('Decimal places', 'change.decimals', 0, 6, 1));
    g1.appendChild(checkboxRow('Increase is good', 'change.higherIsBetter'));
    g1.appendChild(h('div', { className: 'help', textContent: 'Untick for cost, churn or defect metrics so an increase shows in the negative colour.' }));

    var g2 = group(p, 'Colors');
    g2.appendChild(colorRow('Positive', 'change.positiveColor'));
    g2.appendChild(colorRow('Negative', 'change.negativeColor'));
    g2.appendChild(colorRow('No change', 'change.neutralColor'));

    var g3 = group(p, 'Font');
    g3.appendChild(fontFamilyRow('Font', 'change.font'));
    g3.appendChild(numberRow('Size (px)', 'change.size', 6, 72, 1));
    g3.appendChild(selectRow('Weight', 'change.weight', WEIGHTS));
  }

  function buildBottomTab (p) {
    var g1 = group(p, 'Bottom of card');
    g1.appendChild(segRow('Show', 'bottom.mode', [['chart', 'Trend line'], ['text', 'Change text'], ['none', 'Nothing']], function () { buildTabs(); }));

    if (cfg.bottom.mode === 'chart') {
      var g2 = group(p, 'Trend line');
      g2.appendChild(h('p', { className: 'note', textContent: 'Plots the Measure by the Date field at whatever level you use. No axes, gridlines or labels are drawn.' }));
      g2.appendChild(segRow('Line style', 'bottom.lineStyle', [['straight', 'Straight'], ['smooth', 'Smooth']]));
      g2.appendChild(colorRow('Main color', 'bottom.chartColor'));
      g2.appendChild(rangeRow('Fill at top', 'bottom.fillOpacity', 0, 100, 1, '%'));
      g2.appendChild(numberRow('Line width (px)', 'bottom.lineWidth', 0.5, 6, 0.1));
      g2.appendChild(numberRow('Points shown', 'bottom.points', 0, 5000, 1));
      g2.appendChild(h('div', { className: 'help', textContent: 'Only the last N days / weeks / months at the level of your Date field: 30 on a day-level date shows the latest date and the 29 calendar days before it, even when some days have no data. 0 shows all.' }));
      g2.appendChild(checkboxRow('Tooltip on hover', 'bottom.showTooltip'));
      g2.appendChild(rangeRow('Chart height', 'bottom.heightPct', 15, 70, 1, '%'));
    } else if (cfg.bottom.mode === 'text') {
      var g3 = group(p, 'Change text');
      g3.appendChild(h('p', { className: 'note', textContent: 'Reads "-12.3M less than previous period". Uses the explanation size and the big number colour, never italic.' }));
      g3.appendChild(textRow('Period word', 'bottom.periodWord', 'period, month, week, year…'));
      g3.appendChild(numberRow('Decimal places', 'bottom.textDecimals', 0, 6, 1));
      g3.appendChild(checkboxRow('Show +/- sign', 'bottom.showSign'));
    }
  }

  function buildLayoutTab (p) {
    var g1 = group(p, 'Row');
    g1.appendChild(numberRow('Min card width (px)', 'layout.minWidth', 60, 2000, 10));
    g1.appendChild(h('div', { className: 'help', textContent: 'As many cards as fit at this width share a row; the rest wrap onto the next row, and rows share the height.' }));
    g1.appendChild(numberRow('Gap between cards (px)', 'layout.gap', 0, 80, 1));

    var g2 = group(p, 'This card');
    g2.appendChild(numberRow('Width weight', 'card.weight', 0.25, 10, 0.25));
    g2.appendChild(h('div', { className: 'help', textContent: 'Share of its row: 2 is twice as wide as a card with 1.' }));
  }

  function buildCardTab (p) {
    var g1 = group(p, 'Card');
    g1.appendChild(numberRow('Padding (px)', 'card.padding', 0, 60, 1));
    g1.appendChild(checkboxRow('Dashed right divider', 'card.divider'));
    g1.appendChild(checkboxRow('Divider after last card in row', 'card.dividerLast'));
    g1.appendChild(colorRow('Divider color', 'card.dividerColor'));

    var g2 = group(p, 'Background');
    g2.appendChild(colorRow('Color', 'card.bgColor'));
    g2.appendChild(rangeRow('Opacity', 'card.bgOpacity', 0, 100, 1, '%'));
    g2.appendChild(h('div', { className: 'help', textContent: '0% is fully transparent. Set worksheet and container shading to None in Tableau to see through.' }));
    var gData = group(p, 'Data');
    gData.appendChild(numberRow('Maximum rows', 'data.maxRows', 0, 1000000, 1));
    gData.appendChild(h('div', { className: 'help', textContent: 'How many rows are read from the worksheet (0 = all). When rows are left out, a note in the corner of the chart says so.' }));
    var gInt = group(p, 'Interaction');
    gInt.appendChild(checkboxRow('Click selects in Tableau', 'interaction.selectInTableau'));
    gInt.appendChild(h('div', { className: 'help', textContent: 'Click a card to select its latest date in Tableau, or a point on the trend line to select that date, so dashboard filter, highlight and go-to-sheet actions fire. Click again to clear. Needs a field on the Date tile.' }));

  }

  // ---------------------------------------------------------------------------
  // Tooltip tab: measures on Tableau's Tooltip tile (list sent by the extension)
  // ---------------------------------------------------------------------------
  function buildDetailsTab (p) {
    var g = group(p, 'Tooltip');
    g.appendChild(checkboxRow('Show Tooltip-tile measures', 'details.show', function () { buildTabs(); }));
    g.appendChild(checkboxRow('Tooltip on the card', 'details.onCard'));
    g.appendChild(h('div', { className: 'help', textContent: 'Measures on the Tooltip tile (Marks card) are listed in the tooltip. On the trend line: the hovered date. Anywhere else on the card: the latest date.' }));
    g.appendChild(textRow('Heading', 'details.title', 'optional, e.g. Details'));
    g.appendChild(h('div', { className: 'help', textContent: 'Applies to every card, except the measures picked per card under "On this card".' }));

    // Which Tooltip-tile measures this card's tooltip shows.
    if (currentKey != null && detailList.length) {
      var gc = group(p, 'On this card');
      gc.firstChild.appendChild(h('span', { className: 'tag-card', textContent: 'this card' }));
      if (!Array.isArray(cfg.details.hidden)) cfg.details.hidden = [];
      detailList.forEach(function (x) {
        var rc = row(x.label);
        var cb = h('input', { type: 'checkbox' });
        cb.checked = cfg.details.hidden.indexOf(x.key) < 0;
        cb.addEventListener('change', function () {
          var hid = cfg.details.hidden.filter(function (k) { return k !== x.key; });
          if (!cb.checked) hid.push(x.key);
          cfg.details.hidden = hid;
          changed();
        });
        rc.appendChild(h('div', { className: 'inline' }, [cb]));
        gc.appendChild(rc);
      });
      gc.appendChild(h('div', { className: 'help', textContent: 'Untick a measure to leave it out of this card\u2019s tooltip. Pick another card at the top to set its own list; "Apply to all" copies this list to every card.' }));
    }

    textStyleGroup(p, 'Measure names', 'details.nameStyle', false);
    textStyleGroup(p, 'Measure values', 'details.valueStyle', false);
    textStyleGroup(p, 'Heading', 'details.headingStyle', true);

    if (!detailList.length) {
      p.appendChild(h('p', { className: 'note', innerHTML: 'No measures on the <b>Tooltip</b> tile yet. Drag measures there on the Marks card, then open Format Extension again.' }));
      return;
    }

    if (detailIdx >= detailList.length) detailIdx = 0;
    var d = detailList[detailIdx];
    var idx = ensureDetailItem(d.key);
    var base = 'details.items.' + idx;

    var g1 = group(p, 'Measure');
    var r = row('Measure');
    var sel = h('select');
    detailList.forEach(function (x, i) { sel.appendChild(h('option', { value: String(i), textContent: (i + 1) + '. ' + x.label })); });
    sel.value = String(detailIdx);
    sel.addEventListener('change', function () { detailIdx = Number(sel.value); buildTabs(); });
    r.appendChild(sel);
    g1.appendChild(r);
    g1.appendChild(checkboxRow('Show on all cards', base + '.show'));
    g1.appendChild(textRow('Name', base + '.label', d.label));

    var g2 = group(p, 'Value format');
    var fmtRow = selectRow('Number format', base + '.scale', [
      ['dynamic', 'Dynamic (K / M / B)'], ['K', 'Thousands (K)'], ['M', 'Millions (M)'],
      ['B', 'Billions (B)'], ['none', 'Full number'],
      ['percent', 'Percentage (%)'], ['percentDynamic', 'Percentage, dynamic (K / M / B %)'],
      ['workbook', 'Workbook format']
    ]);
    fmtRow.querySelector('select').addEventListener('change', function () { buildTabs(); });
    g2.appendChild(fmtRow);
    var sc = get(base + '.scale');
    if (sc === 'percent' || sc === 'percentDynamic') {
      g2.appendChild(checkboxRow('Value is a 0–1 ratio', base + '.pctFromRatio'));
    }
    g2.appendChild(numberRow('Decimal places', base + '.decimals', 0, 6, 1));
    g2.appendChild(unitRow('Unit', base + '.unit', 'e.g. SAR, users'));
    g2.appendChild(selectRow('Unit position', base + '.unitPosition', [['suffix', 'After number'], ['prefix', 'Before number']]));

    colorSpecGroup(p, 'Name color', base + '.name');
    colorSpecGroup(p, 'Value color', base + '.value');
  }

  /** Font, size, weight, italic (and color for the heading) of the tooltip measure text. */
  function textStyleGroup (p, title, path, withColor) {
    var g = group(p, title);
    g.appendChild(fontFamilyRow('Font', path + '.font'));
    g.appendChild(numberRow('Size (px)', path + '.size', 6, 48, 1));
    g.appendChild(selectRow('Weight', path + '.weight', WEIGHTS));
    if (withColor) g.appendChild(colorRow('Color', path + '.color'));
    g.appendChild(checkboxRow('Italic', path + '.italic'));
  }

  /** Index of the measure's entry in details.items (added with defaults when missing). */
  function ensureDetailItem (key) {
    if (!Array.isArray(cfg.details.items)) cfg.details.items = [];
    var items = cfg.details.items;
    var i = items.findIndex(function (it) { return it && it.key === key; });
    var full = KpiCardMultiConfig.detailItem(cfg.details, key);
    if (i < 0) { items.push(full); return items.length - 1; }
    items[i] = full; // fills in settings added later
    return i;
  }

  /** Single color, by sign (+ / − / 0) or conditional rules — for a measure's name or value. */
  function colorSpecGroup (p, title, path) {
    var g = group(p, title);
    g.appendChild(segRow('Color by', path + '.mode', [['single', 'Single'], ['posneg', '+ / −'], ['conditional', 'Conditional']], function () { buildTabs(); }));
    var mode = get(path + '.mode');
    if (mode === 'posneg') {
      g.appendChild(colorRow('Positive', path + '.pos'));
      g.appendChild(colorRow('Negative', path + '.neg'));
      g.appendChild(colorRow('Zero / no value', path + '.zero'));
      return;
    }
    if (mode !== 'conditional') {
      g.appendChild(colorRow('Color', path + '.color'));
      return;
    }
    var rules = get(path + '.rules');
    rules.forEach(function (rule, i) {
      var rp = path + '.rules.' + i;
      var rr = row(i === 0 ? 'If value' : 'Else if');
      var wrap = h('div', { className: 'inline rule' });
      var op = h('select', { className: 'rule-op' });
      KpiCardMultiConfig.DETAIL_OPS.forEach(function (o) { op.appendChild(h('option', { value: o[0], textContent: o[1] })); });
      op.value = rule.op;
      op.addEventListener('change', function () { set(rp + '.op', op.value); buildTabs(); });
      wrap.appendChild(op);
      var num = function (key) {
        var inp = h('input', { type: 'number', step: 'any', value: rule[key], className: 'rule-num' });
        inp.addEventListener('input', function () {
          var n = Number(inp.value);
          if (inp.value !== '' && isFinite(n)) set(rp + '.' + key, n);
        });
        return inp;
      };
      wrap.appendChild(num('v'));
      if (rule.op === 'between') { wrap.appendChild(h('span', { className: 'rule-and', textContent: 'and' })); wrap.appendChild(num('v2')); }
      var pick = h('input', { type: 'color', value: KpiCardMultiConfig.normalizeHex(rule.color) || '#000000' });
      pick.addEventListener('input', function () { set(rp + '.color', pick.value.toUpperCase()); });
      wrap.appendChild(pick);
      var del = h('button', { type: 'button', className: 'rule-del', title: 'Remove rule', textContent: '×' });
      del.addEventListener('click', function () { rules.splice(i, 1); changed(); buildTabs(); });
      wrap.appendChild(del);
      rr.appendChild(wrap);
      g.appendChild(rr);
    });
    var addRow = row('');
    var add = h('button', { type: 'button', className: 'btn', textContent: '+ Add rule' });
    add.addEventListener('click', function () {
      var last = rules[rules.length - 1];
      var nr = KpiCardMultiConfig.clone(KpiCardMultiConfig.DETAIL_RULE);
      if (last) { nr.op = last.op === 'gt' ? 'lt' : last.op; nr.v = last.v; }
      rules.push(nr);
      changed();
      buildTabs();
    });
    addRow.appendChild(h('div', { className: 'inline' }, [add]));
    g.appendChild(addRow);
    g.appendChild(colorRow(rules.length ? 'Otherwise' : 'Color', path + '.other'));
    g.appendChild(h('div', { className: 'help', textContent: 'The first matching rule wins. Rules compare the raw value: a 0–1 ratio stays 0.45 (not 45%), and K / M / B are not applied.' }));
  }

  // ---------------------------------------------------------------------------
  // Presets
  // ---------------------------------------------------------------------------
  /** Rebuild the open tab after a change that shows or hides rows. */
  function rebuild () { buildTabs(); }

  var PRESET_TYPE = 'tableau-kpi-card-multi-preset';
  var PRESET_STORE = 'kpicardmulti:presets:v1';

  /**
   * Settings tied to this worksheet's measures and data (title and explanation text,
   * per-measure tooltip items, row limit). "Look only" presets hold the shared settings
   * without them and without the per-card settings (the `cards` map, keyed by measure name).
   */
  var FIELD_PATHS = [
    'title.text', 'explanation.text', // text that names a measure
    'details.items', // per-measure tooltip settings, keyed by Tooltip-tile measure
    'details.hidden', // per card: which Tooltip-tile measures are left out
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
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer KPI Card Multi. Update the extension, then import it again.');
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  /** Only the settings that differ from the defaults (smaller files, future-proof). */
  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : KpiCardMultiConfig.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? KpiCardMultiConfig.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    KpiCardMultiConfig.splitInto(store, currentKey, cfg); // include edits not saved yet
    var shared = KpiCardMultiConfig.clone(store.shared);
    var settings;
    if (scope === 'look') {
      FIELD_PATHS.forEach(function (p) { delAt(shared, p); });
      settings = diffFromDefaults(shared, KpiCardMultiConfig.DEFAULTS) || {};
    } else {
      settings = { shared: diffFromDefaults(shared, KpiCardMultiConfig.DEFAULTS) || {}, cards: KpiCardMultiConfig.clone(store.cards) };
    }
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'KPI Card Multi preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: settings
    };
  }

  /** Accepts a preset file, or the raw settings JSON of a workbook. */
  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a KPI Card Multi preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o.kpiCardMulti1) { try { o = typeof o.kpiCardMulti1 === 'string' ? JSON.parse(o.kpiCardMulti1) : o.kpiCardMulti1; } catch (e) { /* fall through */ } }
    if (!('shared' in o) && !('cards' in o)) throw new Error('No KPI Card Multi settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    pr = migratePreset(pr);
    KpiCardMultiConfig.splitInto(store, currentKey, cfg);
    var whole = pr.scope === 'all';
    // "Look only" presets hold the shared settings; the cards (keyed by measure name) stay as they are.
    var next = KpiCardMultiConfig.normalizeStore(whole ? pr.settings : { shared: pr.settings });
    var shared = next.shared;
    var own = !whole || keepFields;
    var given = whole ? (pr.settings.shared || {}) : pr.settings;
    FIELD_PATHS.forEach(function (p) {
      var has = getAt(given, p) !== undefined;
      if (own || !has) setAt(shared, p, KpiCardMultiConfig.clone(getAt(store.shared, p)));
    });
    if (own) next.cards = KpiCardMultiConfig.clone(store.cards);
    store = next;
    cfg = KpiCardMultiConfig.cardConfig(store, currentKey);
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
    return (String(name || 'kpi-card-multi-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'kpi-card-multi-preset') + '.json';
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
    g1.appendChild(help('Saves this row of cards’s settings as a preset you can import into another KPI Card Multi, in this or any workbook.'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Dark cards' });
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
      ? 'The shared look of all cards: icon, big number, % change, bottom, card, layout, tooltip styles… Leaves out settings of single cards (marked “this card”) and what belongs to this sheet’s data: title and explanation text, tooltip items, row limit.'
      : 'Every setting, including each card’s own settings, title and explanation text and tooltip items. Best for a copy of the same sheet.'));

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
    g2.appendChild(help('Applies a preset to this row of cards. Cancel at the bottom undoes it.'));
    g2.appendChild((function () {
      var r = row('Keep this row of cards’s');
      var input = h('input', { type: 'checkbox' });
      input.checked = presetUi.keepFields;
      input.addEventListener('change', function () { presetUi.keepFields = input.checked; });
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'each card’s own settings, title and explanation text, tooltip items, row limit' })]));
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
    return path.split('.').reduce(function (o, k) { return o[k]; }, cfg);
  }

  function set (path, value) {
    var keys = path.split('.');
    var last = keys.pop();
    keys.reduce(function (o, k) { return o[k]; }, cfg)[last] = value;
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
      KpiCardMultiConfig.splitInto(store, currentKey, cfg);
      return KpiCardMultiConfig.write(store).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }

  window.KpiCardMultiConfigure = { init: init };
})();
