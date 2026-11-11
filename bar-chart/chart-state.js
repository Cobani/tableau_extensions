/**
 * Bar Chart: shared namespace, state and constants (loaded first of the chart files).
 *
 * Here: window.BcChart = { S, constants, tiny pure helpers }. S holds every piece of mutable
 * chart state (settings, data, view, drill/legend/hover state, timers, caches); the other files
 * read and write it as S.<name>. Do not put DOM code or anything that reads Tableau here.
 */
'use strict';

(function () {
  var SVGNS = 'http://www.w3.org/2000/svg';
  var SEP = '\u0001';
  // Handshake timeout: 4 s on the first load, +2 s per reload (4, 6, 8, 10 s → about 28 s
  // before giving up). A late answer still draws the chart, even after giving up.
  var INIT_TIMEOUT = 4000;
  var INIT_TIMEOUT_STEP = 2000;
  // Custom tiles (bar-chart.trex: Dimension, Measure, Line, Target) plus
  // Tableau's own Detail and Tooltip tiles, mapped in getEncodedFields().
  var TILES = ['category', 'values', 'line', 'target', 'tooltip', 'detail'];
  var SS = '\u0002'; // measure ↔ member in a series key
  var CS = '\u0003'; // parent ↔ child in a drilled node key

  function fx (n) { return Math.round(n * 100) / 100; }

  function pctFmt (f) { return Bc.merge(f, { scale: 'percent', pctFromRatio: true, unit: '' }); }

  function rootLabel (n) { while (n.parent) n = n.parent; return n.label; }

  function parseKey (k) {
    var o = {};
    String(k || '').split('|').forEach(function (part) {
      var i = part.indexOf(':');
      if (i > 0) o[part.slice(0, i)] = part.slice(i + 1);
    });
    return o;
  }

  /** A bar's identity for click-selection: its category, and its panel with small multiples. */
  function selKey (n) { return n.key + '\u0004' + (n.panel || ''); }

  window.BcChart = {
    // Every piece of mutable chart state (was a top-level var of chart.js; now S.<name> in every file).
    S: {
      el: {},
      worksheet: null,
      cfg: null,
      raw: null, // extracted data, see extract()
      view: null, // what the last paint drew, see buildView()
      drawn: [], // hit areas: { node, s, kind, i, v (the view / panel it belongs to), lv (line point value) }
      events: [], // dated event markers drawn: { label, dateText, color } (hover tooltip)
      catRefs: [], // nodes of the names on the axis (data-cat), across panels
      renderToken: 0,
      uid: 0,
      /** In-memory state (not saved): legend toggles, drill, pinned tooltip. */
      state: {
        off: {}, // legend items switched off: key → true
        expanded: {}, // drill (expand one): node key → true
        focus: [], // drill (focus): stack of node keys
        level: 0, // drill (expand all): depth
        pinned: null, // drawn item whose tooltip is pinned
        ttSort: null, // pinned tooltip sort override
        animate: true, // grow the bars on the next paint
        hoverKey: null,
        sel: null // node key selected by a click (Click selects the bar in Tableau)
      },
      params: {}, // lower-case name → { name, value }
      paramWatch: {},
      queued: false,
      liveId: 'bc' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      liveActive: false,
      infoTimer: null,
      lastLimit: null,
      /** Measures in the view being built: one with a measure panel, else all. */
      onlyM: null,
      iconBoxH: 0,
      measureCtx: null,
      twCache: {},
      twCount: 0,
      /**
       * Every element that can fade on hover, with its parsed key and drawn item,
       * built once per paint so hovering doesn't query and parse the whole chart.
       */
      hoverEls: [],
      // Mouse moves are handled once per frame; moving within the same bar only moves the tooltip,
      // and crossing the gap between two bars doesn't un-fade and re-fade the whole chart.
      lastHover: null,
      tipRi: null, // summary-data row of the mark Tableau's own tooltip is showing (interaction.tableauTooltip)
      noTableauTip: false, // set when hoverTupleAsync is missing
      hoverClear: null,
      hoverEvt: null,
      ttSize: { w: 0, h: 0 },
      clickTimer: null,
      expOrder: []
    },
    SVGNS: SVGNS,
    SEP: SEP,
    INIT_TIMEOUT: INIT_TIMEOUT,
    INIT_TIMEOUT_STEP: INIT_TIMEOUT_STEP,
    TILES: TILES,
    SS: SS,
    CS: CS,
    fx: fx,
    pctFmt: pctFmt,
    rootLabel: rootLabel,
    parseKey: parseKey,
    selKey: selKey
  };
})();
