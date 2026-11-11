'use strict';

/**
 * Format dialog for Narrative Card (opened by "Format Extension" on the Marks card).
 *
 * Every change is saved straight away (debounced), so the card behind the
 * modeless dialog updates live. Cancel restores what was stored on open.
 */
(function () {
  var cfg = null;
  var original = null;
  var saveTimer = null;
  var hist = null; // undo / redo steps (shared/dialog.js)
  var activeTab = 'template';
  var shapeIndex = null; // { palettes: [{ name, files: [{ name, url }] }] }
  var fieldList = [];    // [{ key, label }] measures on the Measures tile, sent by the extension
  var paramList = [];    // names of the workbook's parameters, sent by the extension
  var measureIdx = 0;    // measure open on the Numbers tab

  var WEIGHTS = ExtDialog.WEIGHTS;

  // Controls shared by every Format dialog: shared/dialog.js.
  const kit = ExtDialog.kit({
    get: get,
    set: set,
    fonts: Nc.FONTS,
    fontPath: function (section, key) { return section + '.' + key; }
  });
  const h = ExtDialog.h, group = ExtDialog.group, escapeHtml = ExtDialog.escapeHtml,
    blobToIconDataUrl = ExtDialog.blobToIconDataUrl, setStatus = ExtDialog.setStatus, baseUrl = ExtDialog.baseUrl;
  const row = kit.row, textRow = kit.textRow, numberRow = kit.numberRow, rangeRow = kit.rangeRow,
    checkboxRow = kit.checkboxRow, selectRow = kit.selectRow, segRow = kit.segRow, colorRow = kit.colorRow,
    unitRow = kit.unitRow, fontFamilyRow = kit.fontFamilyRow, fontRows = kit.fontRows;
  const help = ExtDialog.help, copyText = ExtDialog.copyText, download = ExtDialog.download,
    getAt = ExtDialog.getAt, setAt = ExtDialog.setAt, delAt = ExtDialog.delAt;

  var TABS = [
    { id: 'template', label: 'Template', build: buildTemplateTab, keys: ['template'] },
    { id: 'style', label: 'Style', build: buildStyleTab, keys: ['text', 'highlight'] },
    { id: 'numbers', label: 'Numbers', build: buildNumbersTab, keys: ['number', 'measures'] },
    { id: 'change', label: 'Comparison', build: buildChangeTab, keys: ['change'] },
    { id: 'icon', label: 'Icon', build: buildIconTab, keys: ['icon'] },
    { id: 'text', label: 'Title & text', build: buildTextTab, keys: ['title', 'explanation'] },
    { id: 'card', label: 'Card', build: buildCardTab, keys: ['card', 'data', 'interaction', 'export'] },
    { id: 'presets', label: 'Presets', build: buildPresetsTab, keys: [] }
  ];

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function init () {
    return tableau.extensions.initializeDialogAsync().then(function (payload) {
      try {
        var info = JSON.parse(payload || '{}');
        fieldList = info.fields || [];
        paramList = info.params || [];
      } catch (e) { fieldList = []; paramList = []; }
      cfg = Nc.read();
      original = Nc.clone(cfg);
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
      console.error('Narrative Card dialog failed to initialize:', err);
    });
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
  }

  function resetTab () {
    var tab = TABS.find(function (t) { return t.id === activeTab; });
    tab.keys.forEach(function (k) { cfg[k] = Nc.clone(Nc.DEFAULTS[k]); });
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
        var r = Nc.iconHtml(ic.builtinId, ic.color);
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
        Nc.ICON_GROUPS.forEach(function (groupName) {
          var icons = Nc.ICONS.filter(function (icon) { return icon.group === groupName; });
          if (!icons.length) return;
          gridWrap.appendChild(h('div', { className: 'grid-title', textContent: groupName + ' (' + icons.length + ')' }));
          var grid = h('div', { className: 'grid' });
          icons.forEach(function (icon) {
            var cell = h('button', { type: 'button', className: 'cell', title: icon.label });
            if (icon.light) cell.classList.add('cell--dark');
            cell.innerHTML = Nc.iconHtml(icon.id, ic.color).html;
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
    g1.appendChild(textRow('Title', 'title.text', 'e.g. Weekly summary'));
    g1.appendChild(segRow('Alignment', 'title.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]));
    g1.appendChild(h('div', { className: 'help', textContent: 'An optional heading above the text (with the icon, if shown). The explanation follows the same alignment.' }));
    fontRows(g1, 'title');

    var g2 = group(p, 'Explanation text');
    g2.appendChild(checkboxRow('Show explanation', 'explanation.show'));
    g2.appendChild(checkboxRow('Keep space when empty', 'explanation.reserveSpace'));
    g2.appendChild(textRow('Text', 'explanation.text', 'e.g. Source: orders system'));
    fontRows(g2, 'explanation', true);
  }

  // ---------------------------------------------------------------------------
  // Template tab: the text, the clickable list of fields, the help panel
  // ---------------------------------------------------------------------------
  var HELP_HTML =
    '<p><b>Fields</b> go in braces. <code>{Revenue}</code> is the latest value, formatted by that measure’s settings (Numbers tab). ' +
    'The name is the measure’s name without SUM / AVG, any capitals. A name that matches nothing stays visible in red so typos show.</p>' +
    '<table class="nc-help-table">' +
    '<tr><td><code>{Name.change}</code></td><td>% or pp change, with an arrow and a good / bad colour</td></tr>' +
    '<tr><td><code>{Name.diff}</code></td><td>the difference (always positive; <code>{Name.diff|+}</code> keeps the sign)</td></tr>' +
    '<tr><td><code>{Name.previous}</code></td><td>the value it is compared with</td></tr>' +
    '<tr><td><code>{Name.date}</code></td><td>the date the value is for</td></tr>' +
    '<tr><td><code>{Name.direction}</code></td><td>rose / fell / was flat (words on the Style tab)</td></tr>' +
    '<tr><td><code>{Name.name}</code></td><td>the measure’s name (or its label)</td></tr>' +
    '</table>' +
    '<p><b>Format on the spot</b> after a bar: <code>{Revenue|1}</code> one decimal, <code>{Revenue|M}</code> millions (K, M, B, none, dynamic), ' +
    '<code>{Rate|%}</code> as a percentage, <code>{Orders|+}</code> with a plus sign. Combine them: <code>{Revenue|M|1}</code>.</p>' +
    '<p><b>Conditions</b> (no nesting): <code>{if Revenue.change &gt; 0}up{else}down{end}</code>. Operators: &gt; &gt;= &lt; &lt;= = !=, against a number. ' +
    'The number is the value, or for .change the % (pp) change, for .diff / .previous the value. <code>{if has Revenue.change}…{end}</code> is true when there is a figure.</p>' +
    '<p><b>Parameters</b>: <code>&lt;Parameter name&gt;</code> inserts a Tableau parameter’s current value.</p>' +
    '<p><b>Layout</b>: each line is a paragraph; a line starting with <code>- </code> is a bullet; <code>**bold**</code> and <code>*italic*</code>. Nothing else (no HTML).</p>' +
    '<p>Change figures need a Date tile; without one they stay empty.</p>';

  var TOKEN_PROPS = [['', 'value'], ['change', 'change'], ['diff', 'diff'], ['previous', 'previous'], ['date', 'date'], ['direction', 'direction']];

  function buildTemplateTab (p) {
    var g = group(p, 'Text');
    g.appendChild(help('Write your sentences. Click a field below to put it in at the cursor. The card behind this window updates as you type. Leave it empty to get one sentence per measure.'));
    var ta = h('textarea', { className: 'nc-template', rows: 9, spellcheck: false, placeholder: '{Revenue} this month, {Revenue.change} vs last month.\n{Orders} orders at an average of {Avg Order Value}.' });
    ta.value = cfg.template.text || '';
    ta.addEventListener('input', function () { set('template.text', ta.value); });
    g.appendChild(ta);

    function insert (text) {
      var s = ta.selectionStart;
      var e = ta.selectionEnd;
      if (s == null) { s = e = ta.value.length; }
      ta.value = ta.value.slice(0, s) + text + ta.value.slice(e);
      ta.selectionStart = ta.selectionEnd = s + text.length;
      ta.focus();
      set('template.text', ta.value);
    }
    function chip (label, text, title) {
      var b = h('button', { className: 'btn btn--small nc-chip', type: 'button', textContent: label, title: title || text });
      b.addEventListener('click', function () { insert(text); });
      return b;
    }

    var g2 = group(p, 'Fields on this card');
    if (!fieldList.length) {
      g2.appendChild(h('p', { className: 'note', innerHTML: 'No measures on the <b>Measures</b> tile yet. Drop measures there on the Marks card, then open Format Extension again.' }));
    } else {
      fieldList.forEach(function (f) {
        var r = h('div', { className: 'nc-field' });
        r.appendChild(h('span', { className: 'nc-field-name', textContent: f.label, title: f.label }));
        var chips = h('span', { className: 'nc-chips' });
        TOKEN_PROPS.forEach(function (tp) {
          chips.appendChild(chip(tp[1], '{' + f.label + (tp[0] ? '.' + tp[0] : '') + '}'));
        });
        r.appendChild(chips);
        g2.appendChild(r);
      });
      var first = fieldList[0].label;
      var snip = h('div', { className: 'nc-chips nc-snippets' });
      snip.appendChild(chip('if … else', '{if ' + first + '.change > 0}…{else}…{end}', 'A condition'));
      snip.appendChild(chip('bullet', '\n- ', 'A bullet line'));
      snip.appendChild(chip('**bold**', '**text**', 'Bold text'));
      g2.appendChild(snip);
    }
    if (paramList.length) {
      var g3 = group(p, 'Parameters');
      var pc = h('div', { className: 'nc-chips' });
      paramList.forEach(function (n) { pc.appendChild(chip('<' + n + '>', '<' + n + '>')); });
      g3.appendChild(pc);
    }

    var g4 = group(p, 'Template language');
    g4.appendChild(h('details', { className: 'nc-help', open: true, innerHTML: '<summary>How to write the text</summary>' + HELP_HTML }));
  }

  // ---------------------------------------------------------------------------
  // Style tab: the text, and the numbers inside it
  // ---------------------------------------------------------------------------
  function buildStyleTab (p) {
    var g1 = group(p, 'Text');
    fontRows(g1, 'text', true);
    g1.appendChild(numberRow('Line height', 'text.lineHeight', 0.8, 3, 0.05));
    g1.appendChild(numberRow('Paragraph gap (px)', 'text.paragraphGap', 0, 80, 1));
    g1.appendChild(segRow('Alignment', 'text.align', [['left', 'Left'], ['center', 'Center'], ['right', 'Right'], ['justify', 'Justify']]));
    g1.appendChild(segRow('Vertical', 'text.vAlign', [['top', 'Top'], ['middle', 'Middle'], ['bottom', 'Bottom']]));
    g1.appendChild(colorRow('Unknown {field} color', 'text.unknownColor'));

    var g2 = group(p, 'Numbers in the text');
    g2.appendChild(selectRow('Weight', 'highlight.weight', WEIGHTS));
    g2.appendChild(colorRow('Color', 'highlight.color'));
    g2.appendChild(h('div', { className: 'help', textContent: 'Applies to {Name}, {Name.diff}, {Name.previous} and to {Name.change} when change colors are off.' }));

    var g3 = group(p, 'Change figures');
    g3.appendChild(checkboxRow('Good / bad colors', 'highlight.changeColors', function () { buildTabs(); }));
    if (cfg.highlight.changeColors) {
      g3.appendChild(colorRow('Good', 'highlight.goodColor'));
      g3.appendChild(colorRow('Bad', 'highlight.badColor'));
      g3.appendChild(colorRow('No change', 'highlight.neutralColor'));
      g3.appendChild(h('div', { className: 'help', textContent: 'Whether an increase is good is set per measure on the Numbers tab.' }));
    }
    g3.appendChild(checkboxRow('Arrows', 'highlight.arrows'));
    g3.appendChild(h('div', { className: 'help', textContent: 'On: ▲ 4.2%. Off: +4.2%. Use {Name.change|+} for the sign form in one place.' }));

    var g4 = group(p, 'Words for {Name.direction}');
    g4.appendChild(textRow('Increase', 'highlight.wordUp', 'rose'));
    g4.appendChild(textRow('Decrease', 'highlight.wordDown', 'fell'));
    g4.appendChild(textRow('No change', 'highlight.wordFlat', 'was flat'));
  }

  // ---------------------------------------------------------------------------
  // Numbers tab: which value, and the format of each measure
  // ---------------------------------------------------------------------------
  /** Index of the measure's entry in measures.items (added with defaults when missing). */
  function ensureItem (key) {
    if (!Array.isArray(cfg.measures.items)) cfg.measures.items = [];
    var items = cfg.measures.items;
    var i = items.findIndex(function (it) { return it && it.key === key; });
    var full = Nc.measureItem(cfg.measures, key);
    if (i < 0) { items.push(full); return items.length - 1; }
    items[i] = full; // fills in settings added later
    return i;
  }

  function buildNumbersTab (p) {
    var g1 = group(p, 'Value shown by {Name}');
    g1.appendChild(segRow('Value', 'number.period', [['day', 'Latest date'], ['mtd', 'Month to date']], function () { buildTabs(); }));
    if (cfg.number.period === 'mtd') {
      g1.appendChild(selectRow('MTD roll-up', 'number.mtdAgg', [['sum', 'Sum of days'], ['avg', 'Average of days']]));
    }
    g1.appendChild(h('div', { className: 'help', textContent: 'Latest date: the value at the latest date. Month to date: day 1 of the latest month through the latest date (needs a real date on the Date tile). A measure can use its own roll-up below.' }));

    if (!fieldList.length) {
      p.appendChild(h('p', { className: 'note', innerHTML: 'No measures on the <b>Measures</b> tile yet. Drop measures there on the Marks card, then open Format Extension again.' }));
      return;
    }
    if (measureIdx >= fieldList.length) measureIdx = 0;
    var d = fieldList[measureIdx];
    var base = 'measures.items.' + ensureItem(d.key);

    var g2 = group(p, 'Measure');
    var r = row('Measure');
    var sel = h('select');
    fieldList.forEach(function (x, i) { sel.appendChild(h('option', { value: String(i), textContent: (i + 1) + '. ' + x.label })); });
    sel.value = String(measureIdx);
    sel.addEventListener('change', function () { measureIdx = Number(sel.value); buildTabs(); });
    r.appendChild(sel);
    g2.appendChild(r);
    g2.appendChild(textRow('Label', base + '.label', d.label));
    g2.appendChild(h('div', { className: 'help', textContent: 'Optional second name for this measure: {Label} works in the template, and {' + d.label + '.name} shows it.' }));

    var g3 = group(p, 'Number format');
    var fmtRow = selectRow('Format', base + '.scale', [
      ['dynamic', 'Dynamic (K / M / B)'], ['K', 'Thousands (K)'], ['M', 'Millions (M)'],
      ['B', 'Billions (B)'], ['none', 'Full number'],
      ['percent', 'Percentage (%)'], ['percentDynamic', 'Percentage, dynamic (K / M / B %)'],
      ['workbook', 'Workbook format']
    ]);
    fmtRow.querySelector('select').addEventListener('change', function () { buildTabs(); });
    g3.appendChild(fmtRow);
    var sc = get(base + '.scale');
    if (sc === 'percent' || sc === 'percentDynamic' || get(base + '.changeType') === 'pp') {
      g3.appendChild(checkboxRow('Metric is a 0–1 ratio', base + '.pctFromRatio'));
      g3.appendChild(h('div', { className: 'help', textContent: 'On: 0.4523 → 45.23% (and 0.45 vs 0.40 → 5.00 pp). Off: 45.23 → 45.23%.' }));
    }
    g3.appendChild(numberRow('Decimal places', base + '.decimals', 0, 6, 1));
    g3.appendChild(unitRow('Unit', base + '.unit', 'e.g. SAR, users'));
    g3.appendChild(selectRow('Unit position', base + '.unitPosition', [['suffix', 'After number'], ['prefix', 'Before number']]));

    var g4 = group(p, 'Change');
    g4.appendChild(checkboxRow('Increase is good', base + '.higherIsBetter'));
    g4.appendChild(h('div', { className: 'help', textContent: 'Untick for cost, churn or defect measures so an increase uses the bad color and a fall the good color.' }));
    g4.appendChild(selectRow('Change as', base + '.changeType', [['auto', 'As on the Comparison tab'], ['percent', '% change'], ['pp', 'pp change']]));
    g4.appendChild(selectRow('MTD roll-up', base + '.mtdAgg', [['auto', 'As on the Numbers / Comparison tabs'], ['sum', 'Sum of days'], ['avg', 'Average of days']]));
    g4.appendChild(h('div', { className: 'help', textContent: 'Use Sum for flows (volumes, counts) and Average for balances and ratios.' }));
  }

  // ---------------------------------------------------------------------------
  // Comparison tab (the Narrative Card logic, for every measure)
  // ---------------------------------------------------------------------------
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
        'Both need a real date on the Date tile (exact date or DAY / MONTH as a date), not date parts. Without a Date tile there is nothing to compare and change figures stay empty.'
    }));

    var g1 = group(p, 'Change figures');
    g1.appendChild(segRow('Type', 'change.type', [['percent', '% change'], ['pp', 'pp change']]));
    g1.appendChild(h('div', { className: 'help', textContent: 'pp change is the difference of two percentages. A measure can override this on the Numbers tab.' }));
    g1.appendChild(numberRow('Decimal places', 'change.decimals', 0, 6, 1));
    g1.appendChild(textRow('Period word', 'change.periodWord', 'period, month, week, year…'));
    g1.appendChild(h('div', { className: 'help', textContent: 'Used by the automatic text when the template is empty: "vs previous period".' }));
  }

  function buildCardTab (p) {
    var g1 = group(p, 'Card');
    g1.appendChild(numberRow('Padding (px)', 'card.padding', 0, 60, 1));
    g1.appendChild(checkboxRow('Dashed right divider', 'card.divider'));
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
    gInt.appendChild(h('div', { className: 'help', textContent: 'Click the card to select its latest date in Tableau, so dashboard filter, highlight and URL actions fire. Needs a Date tile. Click again (or press Esc) to clear.' }));
    gInt.appendChild(checkboxRow('Use Tableau\u2019s tooltip', 'interaction.tableauTooltip'));
    gInt.appendChild(h('div', { className: 'help', textContent: 'Shows the tooltip you design in Tableau (Worksheet \u2192 Tooltip) for the latest date, instead of this extension\u2019s own tooltip on the numbers. Not verified on every Tableau version; if it does not appear, turn it off.' }));
    var gExp = group(p, 'Export');
    gExp.appendChild(checkboxRow('Save as picture button', 'export.picture'));
    gExp.appendChild(h('div', { className: 'help', textContent: 'Shows a button in the top-right corner (on hover) that saves the card as a PNG picture.' }));

  }

  function rebuild () { buildTabs(); }

  var PRESET_TYPE = 'tableau-narrative-card-preset';
  var PRESET_STORE = 'narrativecard:presets:v1';

  /**
   * Settings tied to this worksheet's measures and data (title and explanation text,
   * per-measure tooltip items, row limit). "Look only" presets leave them out, and an
   * import keeps the card's own unless asked otherwise.
   */
  var FIELD_PATHS = [
    'title.text', 'explanation.text', // text that names this card's content
    'template.text', // the sentences, written for this worksheet's measures
    'measures.items', // per-measure format, keyed by measure name
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
    if (v > PRESET_VERSION) throw new Error('This preset was made with a newer Narrative Card. Update the extension, then import it again.');
    for (; v < PRESET_VERSION; v++) if (PRESET_MIGRATIONS[v]) pr = PRESET_MIGRATIONS[v](pr) || pr;
    pr.version = PRESET_VERSION;
    return pr;
  }

  var presetUi = { scope: 'look', name: '', keepFields: true, msg: null, pasted: '' };

  /** Only the settings that differ from the defaults (smaller files, future-proof). */
  function diffFromDefaults (cur, def) {
    if (Array.isArray(cur) || cur == null || typeof cur !== 'object') return JSON.stringify(cur) === JSON.stringify(def) ? undefined : Nc.clone(cur);
    if (def == null || typeof def !== 'object' || Array.isArray(def) || !Object.keys(def).length) {
      return Object.keys(cur).length ? Nc.clone(cur) : undefined;
    }
    var out = {};
    Object.keys(cur).forEach(function (k) {
      var d = diffFromDefaults(cur[k], def[k]);
      if (d !== undefined) out[k] = d;
    });
    return Object.keys(out).length ? out : undefined;
  }

  function makePreset (scope, name) {
    var s = Nc.clone(cfg);
    if (scope === 'look') FIELD_PATHS.forEach(function (p) { delAt(s, p); });
    return {
      type: PRESET_TYPE,
      version: PRESET_VERSION,
      name: name || 'Narrative Card preset',
      scope: scope,
      exported: new Date().toISOString(),
      settings: diffFromDefaults(s, Nc.DEFAULTS) || {}
    };
  }

  /** Accepts a preset file, or the raw settings JSON of a workbook. */
  function parsePreset (text) {
    var o;
    try { o = JSON.parse(String(text).replace(/^﻿/, '')); } catch (e) { throw new Error('This isn’t valid JSON. Paste the whole preset, from { to }.'); }
    if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('This isn’t a Narrative Card preset.');
    if (o.type && o.type !== PRESET_TYPE) throw new Error('This preset is for another extension (' + o.type + ').');
    if (o.type === PRESET_TYPE) {
      if (!o.settings || typeof o.settings !== 'object') throw new Error('The preset has no settings.');
      return migratePreset(o);
    }
    if (o.narrativeCard1) { try { o = typeof o.narrativeCard1 === 'string' ? JSON.parse(o.narrativeCard1) : o.narrativeCard1; } catch (e) { /* fall through */ } }
    var known = Object.keys(o).filter(function (k) { return k in Nc.DEFAULTS; });
    if (!known.length) throw new Error('No Narrative Card settings found in this file.');
    return { type: PRESET_TYPE, version: PRESET_VERSION, name: 'Imported settings', scope: 'all', settings: o };
  }

  function applyImported (pr, keepFields) {
    pr = migratePreset(pr);
    var next = Nc.merge(Nc.DEFAULTS, pr.settings);
    var own = pr.scope === 'look' || keepFields;
    FIELD_PATHS.forEach(function (p) {
      var has = getAt(pr.settings, p) !== undefined;
      if (own || !has) setAt(next, p, Nc.clone(getAt(cfg, p)));
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
    return (String(name || 'narrative-card-preset').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'narrative-card-preset') + '.json';
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
    g1.appendChild(help('Saves this card’s settings as a preset you can import into another Narrative Card, in this or any workbook.'));
    var rName = row('Preset name');
    var name = h('input', { type: 'text', value: presetUi.name, placeholder: 'e.g. Dark card' });
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
      ? 'Text style, number style, comparison, icon and card look. Leaves out what belongs to this sheet’s data: the template, title and explanation text, per-measure formats, row limit.'
      : 'Every setting, including the template, title and explanation text and per-measure formats. Best for a copy of the same sheet.'));

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
    g2.appendChild(help('Applies a preset to this card. Cancel at the bottom undoes it.'));
    g2.appendChild((function () {
      var r = row('Keep this card’s');
      var input = h('input', { type: 'checkbox' });
      input.checked = presetUi.keepFields;
      input.addEventListener('change', function () { presetUi.keepFields = input.checked; });
      r.appendChild(h('div', { className: 'inline' }, [input, h('span', { className: 'help preset-inline-help', textContent: 'title and explanation text, per-measure tooltip items, row limit' })]));
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
        name: 'Narrative Card',
        themeMap: Nc.THEME_MAP,
        getSettings: function () { return cfg; },
        applySettings: function (next) { cfg = next; changed(); rebuild(); }
      }));
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
      return Nc.write(cfg).then(function () { setStatus('Saved'); })
        .catch(function (err) { setStatus('Could not save: ' + (err && err.message)); console.error(err); });
    } catch (err) {
      console.error(err);
      return Promise.resolve();
    }
  }

  function close () {
    tableau.extensions.ui.closeDialog(' ');
  }

  window.NarrativeCardConfigure = { init: init };
})();
