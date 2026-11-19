/* End-to-end user journey in a real browser against `next start`.
 *   BASE=http://localhost:3123 DAYFILES=/path/to/dayfiles/NIFTY/WEEK SHOTS=/tmp/shots node tests/e2e/journey.cjs
 * Needs Playwright (a global install is fine) and a built site (npm run build && npm start). */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const BASE = process.env.BASE || 'http://localhost:3000', SHOTS = process.env.SHOTS || '/tmp/straddloop-shots', DAYS = process.env.DAYFILES;
fs.mkdirSync(SHOTS, { recursive: true });
const log = [];
const step = async (name, fn) => { try { await fn(); log.push(['PASS', name]); console.log('PASS', name); } catch (e) { log.push(['FAIL', name, String(e.message).split('\n')[0]]); console.log('FAIL', name, '\n   ', String(e.message).split('\n')[0]); } };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  await step('synthetic run finishes and the account report reconciles', async () => {
    await page.goto(BASE + '/lab');
    await page.locator('.exec').waitFor({ timeout: 30000 });
    await page.locator('#tab-diagnostics').click();
    await page.locator('#panel-diagnostics').getByText(/reconciliation identities hold/).waitFor();
    await page.screenshot({ path: path.join(SHOTS, '1-lab-synthetic.png'), fullPage: true });
  });
  await step('summary shows net profit, charges and margin as estimated', async () => {
    await page.locator('#tab-ledger').click();
    const t = await page.locator('#panel-ledger').innerText();
    assert(/Net profit after all charges/.test(t) && /Total charges/.test(t) && /Peak margin blocked/.test(t), 'summary rows');
    assert(/ESTIMATED from a configurable percentage model/.test(t), 'margin limitation shown');
  });
  await step('every report section renders with its definitions, and a trade opens into its fills', async () => {
    for (const [part, expect] of [['Capital', /Notional exposure, peak/], ['Performance', /Return on peak margin/], ['Risk', /Sharpe ratio/], ['Summary', /Reconciliation/]]) {
      await page.locator('#panel-ledger .chart-pick button', { hasText: part }).click();
      await page.locator('#panel-ledger').getByText(expect).first().waitFor({ timeout: 5000 });
    }
    await page.screenshot({ path: path.join(SHOTS, '2-ledger-tab.png'), fullPage: true });
    await page.locator('#tab-trades').click();
    await page.locator('#panel-trades .rowbtn').first().click();
    assert(/Fill #\d+/.test(await page.locator('#panel-trades .life').innerText()), 'execution record');
  });
  await step('the four CSV exports download and agree with the page', async () => {
    await page.locator('#tab-ledger').click();
    const out = {};
    for (const [label, key] of [['Tradebook', 'tradebook'], ['Ledger (every fill)', 'ledger'], ['Daily ledger', 'daily'], ['Performance report', 'performance']]) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('#panel-ledger .run-actions').getByRole('button', { name: label, exact: true }).click()]);
      const f = path.join(SHOTS, await dl.suggestedFilename()); await dl.saveAs(f); out[key] = fs.readFileSync(f, 'utf8');
    }
    assert(out.tradebook.startsWith('trade_no,date,leg') && out.ledger.startsWith('seq,date,time') && out.daily.startsWith('date,status') && /reconciliation,/.test(out.performance));
    const rows = s => s.trim().split('\r\n').length - 1;
    const sumCol = (csv, col) => { const [h, ...r] = csv.trim().split('\r\n'); const i = h.split(',').indexOf(col); return r.reduce((a, l) => a + Number(l.split(',')[i] || 0), 0); };
    assert(rows(out.tradebook) > 0 && rows(out.ledger) >= 2 * rows(out.tradebook), 'fills >= 2 x trades');
    const net = sumCol(out.tradebook, 'net_pnl'), dailyNet = sumCol(out.daily, 'net_realised');
    assert(Math.abs(net - dailyNet) < 0.05, `tradebook net ${net} vs daily net ${dailyNet}`);
    assert(Math.abs(sumCol(out.tradebook, 'charges') - sumCol(out.ledger, 'charges')) < 0.05, 'charges agree between tradebook and ledger');
    const shown = await page.locator('.exec .m--lead .m-v').innerText();
    const pageNet = Number(shown.replace(/[^\d.]/g, '')) * (/^−/.test(shown) ? -1 : 1);
    assert(Math.abs(Math.round(net) - pageNet) <= 1, `headline ${shown} vs tradebook ${net}`);
  });
  await step('a small account with the reject policy rejects trades and says so', async () => {
    await page.locator('#sec-risk-h').click();
    await page.getByRole('radio', { name: '₹2 lakh' }).check({ force: true });
    await page.locator('.stale[data-kind="alarm"]').getByText(/rejected for insufficient margin/).waitFor({ timeout: 30000 });
    await page.locator('#tab-capital').click();
    assert(Number(await page.locator('#panel-capital .m[data-k="rj"] .m-v').innerText()) >= 1, 'rejected trades counted');
    await page.screenshot({ path: path.join(SHOTS, '3-rejected.png'), fullPage: true });
  });
  await step('switching to ORB and the four-leg model keeps the page working', async () => {
    await page.getByRole('radio', { name: /Opening range breakout/ }).check({ force: true });
    await page.locator('.ws-crumb', { hasText: 'Opening range' }).or(page.locator('.ws-crumb', { hasText: 'ORB' })).first().waitFor({ timeout: 10000 });
    await page.locator('.exec [data-k="sharpe"]').waitFor({ timeout: 30000 });
    await page.getByRole('radio', { name: /Four-leg/ }).check({ force: true });
    await page.locator('.exec').getByText('Months traded').waitFor({ timeout: 30000 });
  });

  if (DAYS) {
    await step('real-data path: day files from this computer load, every day runs, and each gets an outcome', async () => {
      await page.goto(BASE + '/lab?s=straddle&data=real');
      const files = fs.readdirSync(DAYS).filter(f => f.endsWith('.gz')).map(f => path.join(DAYS, f));
      await page.locator('input[type=file]').setInputFiles(files);
      await page.locator('.rail-checks').getByText(`${files.length} sessions will run`).waitFor({ timeout: 20000 });
      await page.locator('.rail-foot .run-btn').click();
      await page.locator('.exec').waitFor({ timeout: 40000 });
      await page.locator('#tab-sessions').click();
      assert.strictEqual(await page.locator('#panel-sessions tbody tr').count(), files.length, 'one row per session');
      await page.screenshot({ path: path.join(SHOTS, '4-real-days.png'), fullPage: true });
    });
  }
  await step('no browser console or page errors during the whole journey', async () => { assert.deepStrictEqual(errors.filter(e => !/favicon|Failed to load resource/.test(e)), []); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/lab');
  await page.locator('.exec').waitFor({ timeout: 30000 });
  await step('phone width: no horizontal page scroll on any results tab', async () => {
    for (const tab of ['overview', 'capital', 'charts', 'trades', 'sessions', 'replay', 'diagnostics', 'ledger']) {
      await page.locator(`#tab-${tab}`).click();
      await page.waitForTimeout(300);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `page scrolls sideways on ${tab}`);
    }
    await page.locator('#tab-capital').click();
    await page.screenshot({ path: path.join(SHOTS, '6-phone.png'), fullPage: false });
  });
  await browser.close();
  const failed = log.filter(l => l[0] === 'FAIL');
  console.log(`\n${log.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
