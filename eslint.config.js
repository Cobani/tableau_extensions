// Lint rules: catch real mistakes (undefined names, unused code, redeclared variables), not style.
// Run: npm run lint
const globals = require('globals');

const shared = { tableau: 'readonly', ExtCore: 'readonly', ExtBoot: 'readonly', ExtTiming: 'readonly', ExtDialog: 'readonly', ExtTheme: 'readonly', ExtSnapshot: 'readonly', KpiBoot: 'readonly' };
// Each extension's own globals (chart / config / dialog / helpers), see the table in AGENTS.md.
const ext = {};
['KpiCard', 'KpiCardConfig', 'KpiCardConfigure', 'KpiCardMulti', 'KpiCardMultiConfig', 'KpiCardMultiConfigure',
  'Waterfall', 'Wf', 'WaterfallConfigure', 'LineChart', 'Lc', 'LineChartConfigure', 'BarChart', 'Bc', 'BarChartConfigure',
  'MatrixTable', 'Mx', 'MatrixTableConfigure', 'DataLineage', 'Dl', 'DataLineageConfigure',
  'Sankey', 'Sk', 'SankeyConfigure',
  'Funnel', 'Fn', 'FunnelConfigure',
  'BulletGauge', 'Bg', 'BulletGaugeConfigure',
  'ChartExport', 'MxExport', 'KPI_ICONS', 'EXT_ICONS'].forEach(function (n) { ext[n] = 'writable'; });

module.exports = [
  { ignores: ['node_modules/**', 'shared/lib/**', '**/icons.js', '**/presets/**', '**/shapes/**'] },
  {
    files: ['**/*.js'],
    languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: Object.assign({}, globals.browser, shared, ext) },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      'no-var': 'off', // older files use var; new code uses const / let (see AGENTS.md)
      'prefer-const': 'off'
    }
  },
  {
    files: ['tests/**/*.js', 'eslint.config.js'],
    languageOptions: { sourceType: 'commonjs', globals: globals.node }
  },
  {
    files: ['shared/core.js'],
    languageOptions: { globals: { module: 'readonly', globalThis: 'readonly' } }
  },
  {
    files: ['shared/theme.js'],
    languageOptions: { globals: { module: 'readonly', require: 'readonly', globalThis: 'readonly' } }
  }
];
