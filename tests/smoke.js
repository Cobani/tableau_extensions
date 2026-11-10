'use strict';
/**
 * Browser smoke test: opens every extension (chart and Format dialog) with its dev mock and
 * fails on any console error, uncaught error, failed request or error mark.
 *
 * Needs Playwright (not a dependency of this repo, to keep `npm install` small):
 *   npm install --no-save playwright && npx playwright install chromium
 *   python3 serve.py &            # http://localhost:8766
 *   node tests/smoke.js           # optional: node tests/smoke.js bar-chart waterfall
 * CI runs it on every push (.github/workflows/checks.yml).
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.TE_BASE || 'http://localhost:' + (process.env.TE_PORT || '8766');
const only = process.argv.slice(2);

function extensions () {
  return fs.readdirSync(ROOT).filter(function (d) {
    return fs.existsSync(path.join(ROOT, d, 'dev', 'mock.js')) && fs.existsSync(path.join(ROOT, d, 'index.html'));
  }).filter(function (d) { return !only.length || only.indexOf(d) >= 0; }).sort();
}

async function check (context, url, problems) {
  const page = await context.newPage();
  const here = [];
  page.on('console', function (m) { if (m.type() === 'error') here.push('console.error: ' + m.text()); });
  page.on('pageerror', function (e) { here.push('uncaught: ' + e.message); });
  page.on('requestfailed', function (r) { here.push('request failed: ' + r.url()); });
  page.on('response', function (r) { if (r.status() >= 400) here.push('HTTP ' + r.status() + ': ' + r.url()); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(1500);
  if (await page.locator('#ext-error-badge').count()) here.push('error mark shown: ' + (await page.evaluate(function () { return window.ExtBoot.details(); })).split('\n').slice(4).join(' | '));
  const text = await page.evaluate(function () { return document.body.innerText.length + document.querySelectorAll('svg *, canvas, table, .card, .node').length; });
  if (!text) here.push('nothing was drawn');
  const hint = await page.evaluate(function () { const h = document.getElementById('hint'); return h && h.offsetParent ? h.textContent : ''; });
  if (/could not|failed|not answered/i.test(hint)) here.push('message shown: ' + hint);
  here.forEach(function (p) { problems.push(url.replace(BASE, '') + '  →  ' + p); });
  return page;
}

(async function () {
  const { chromium } = require('playwright');
  const browser = await chromium.launch();
  const problems = [];
  const list = extensions();
  for (const slug of list) {
    const context = await browser.newContext({ viewport: { width: 900, height: 520 } });
    const chart = await check(context, BASE + '/' + slug + '/index.html?mock', problems);
    if (process.env.TE_SHOTS) await chart.screenshot({ path: path.join(process.env.TE_SHOTS, slug + '.png') });
    const dialog = await check(context, BASE + '/' + slug + '/configure.html?mock', problems);
    if (process.env.TE_SHOTS) await dialog.screenshot({ path: path.join(process.env.TE_SHOTS, slug + '-format.png') });
    // every tab of the Format dialog builds without errors
    const tabs = await dialog.locator('#tabs [role="tab"], #tabs button').count();
    for (let i = 0; i < tabs; i++) {
      await dialog.locator('#tabs [role="tab"], #tabs button').nth(i).click().catch(function () {});
      await dialog.waitForTimeout(80);
    }
    if (await dialog.locator('#ext-error-badge').count()) problems.push('/' + slug + '/configure.html  →  error after opening every tab');
    if (fs.existsSync(path.join(ROOT, slug, 'dev', 'preview.html'))) await check(context, BASE + '/' + slug + '/dev/preview.html', problems);
    await context.close();
    console.log((problems.some(function (p) { return p.indexOf('/' + slug + '/') === 0; }) ? 'FAIL  ' : 'ok    ') + slug);
  }
  await browser.close();
  if (problems.length) {
    console.error('\n' + problems.join('\n'));
    process.exit(1);
  }
  console.log('\n' + list.length + ' extensions opened without errors.');
})().catch(function (e) { console.error(e); process.exit(1); });
