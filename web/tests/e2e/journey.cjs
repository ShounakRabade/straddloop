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
    await page.getByText('Account report').first().waitFor({ timeout: 30000 });
    await page.getByText('Reconciled').first().waitFor();
    await page.screenshot({ path: path.join(SHOTS, '1-lab-synthetic.png'), fullPage: true });
  });
  await step('summary shows net profit, charges and margin as estimated', async () => {
    const t = await page.locator('.rep-sheet').innerText();
    assert(/Net profit after all charges/.test(t) && /Total charges/.test(t) && /Peak margin blocked/.test(t), 'summary rows');
    assert(/ESTIMATED from a configurable percentage model/.test(t), 'margin limitation shown');
  });
  await step('every report tab renders with its definitions', async () => {
    for (const [tab, expect] of [['Capital & margin', /Notional exposure, peak/], ['Performance', /Return on peak margin/], ['Risk', /Sharpe ratio/], ['Trades', /click a row/], ['Ledger', /Reconciliation/]]) {
      await page.getByRole('tab', { name: tab }).click();
      await page.locator('.rep-sheet').getByText(expect).first().waitFor({ timeout: 5000 });
    }
    await page.screenshot({ path: path.join(SHOTS, '2-ledger-tab.png'), fullPage: true });
    await page.getByRole('tab', { name: 'Trades' }).click();
    await page.locator('.rep-click').first().click();
    await page.locator('.rep-audit').first().waitFor();
    assert(/Execution record/.test(await page.locator('.rep-audit').first().innerText()));
  });
  await step('the four CSV exports download and agree with the page', async () => {
    const out = {};
    for (const [label, key] of [['Tradebook', 'tradebook'], ['Ledger (every fill)', 'ledger'], ['Daily ledger', 'daily'], ['Performance report', 'performance']]) {
      const [dl] = await Promise.all([page.waitForEvent('download'), page.locator('.rep-export').getByRole('button', { name: label }).click()]);
      const f = path.join(SHOTS, await dl.suggestedFilename()); await dl.saveAs(f); out[key] = fs.readFileSync(f, 'utf8');
    }
    assert(out.tradebook.startsWith('trade_no,date,leg') && out.ledger.startsWith('seq,date,time') && out.daily.startsWith('date,status') && /reconciliation,/.test(out.performance));
    const rows = s => s.trim().split('\r\n').length - 1;
    const sumCol = (csv, col) => { const [h, ...r] = csv.trim().split('\r\n'); const i = h.split(',').indexOf(col); return r.reduce((a, l) => a + Number(l.split(',')[i] || 0), 0); };
    assert(rows(out.tradebook) > 0 && rows(out.ledger) >= 2 * rows(out.tradebook), 'fills >= 2 x trades');
    const net = sumCol(out.tradebook, 'net_pnl'), dailyNet = sumCol(out.daily, 'net_realised');
    assert(Math.abs(net - dailyNet) < 0.05, `tradebook net ${net} vs daily net ${dailyNet}`);
    assert(Math.abs(sumCol(out.tradebook, 'charges') - sumCol(out.ledger, 'charges')) < 0.05, 'charges agree between tradebook and ledger');
  });
  await step('a small account with the reject policy rejects trades and says so', async () => {
    await page.getByRole('radio', { name: '₹2 lakh' }).check({ force: true });
    await page.getByText(/rejected for insufficient margin/).first().waitFor({ timeout: 30000 });
    await page.getByRole('tab', { name: 'Capital & margin' }).click();
    const t = await page.locator('.rep-sheet').innerText();
    assert(/Rejected trades\s+[1-9]/.test(t), 'rejected trades counted');
    await page.screenshot({ path: path.join(SHOTS, '3-rejected.png'), fullPage: true });
  });
  await step('switching to ORB and the four-leg model keeps the page working', async () => {
    await page.getByRole('tab', { name: /ORB|Opening/i }).first().click();
    await page.getByText('Account report').first().waitFor({ timeout: 30000 });
    await page.getByRole('tab', { name: /Four|Ratio|leg/i }).first().click();
    await page.getByText(/keeps its own margin model/).waitFor({ timeout: 30000 });
  });

  if (DAYS) {
    await step('real-data path: day files load, date errors are meaningful, ledger runs on real-shaped data', async () => {
      await page.goto(BASE + '/lab?s=straddle&data=real');
      await page.locator('input[type=file]').setInputFiles(fs.readdirSync(DAYS).filter(f => f.endsWith('.gz')).map(f => path.join(DAYS, f)));
      await page.getByText('stored locally').waitFor({ timeout: 20000 });
      await page.getByText('Account report').first().waitFor({ timeout: 40000 });
      assert(/validated/.test(await page.locator('.range-status').innerText()));
      await page.screenshot({ path: path.join(SHOTS, '4-real-days.png'), fullPage: true });
      const dates = page.locator('input[type=date]');
      await dates.nth(0).fill('2025-10-14'); await dates.nth(1).fill('2025-10-07');
      await page.getByText('The start date is after the end date.').waitFor();
      await dates.nth(0).fill('2025-10-06'); await dates.nth(1).fill('2025-10-31');
      await page.getByText(/weekdays in this range have no stored data/).waitFor();
      await dates.nth(0).fill('2019-01-07'); await dates.nth(1).fill('2019-01-09');
      await page.getByText(/None of these dates are stored/).waitFor();
      assert(await page.getByText('Account report').count() === 0, 'a stale report is still shown under an unrunnable range');
      await page.screenshot({ path: path.join(SHOTS, '5-range-errors.png'), fullPage: true });
    });
  }
  await step('no browser console or page errors during the whole journey', async () => { assert.deepStrictEqual(errors.filter(e => !/favicon|Failed to load resource/.test(e)), []); });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/lab');
  await page.getByText('Account report').first().waitFor({ timeout: 30000 });
  await step('phone width: no horizontal page scroll on any report tab', async () => {
    for (const tab of ['Summary', 'Capital & margin', 'Performance', 'Risk', 'Trades', 'Ledger']) {
      await page.getByRole('tab', { name: tab }).click();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), `page scrolls sideways on ${tab}`);
    }
    await page.getByRole('tab', { name: 'Capital & margin' }).click();
    await page.screenshot({ path: path.join(SHOTS, '6-phone.png'), fullPage: false });
  });
  await browser.close();
  const failed = log.filter(l => l[0] === 'FAIL');
  console.log(`\n${log.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
