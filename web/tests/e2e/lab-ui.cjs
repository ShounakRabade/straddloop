/* Lab workspace UI tests in a real browser, at four screen sizes, against `next start`.
 *   NEXT_PUBLIC_SUPABASE_URL=https://stubproject.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_test npm run build
 *   npx next start -p 3123 &
 *   BASE=http://localhost:3123 DAYFILES=/path/to/dayfiles/NIFTY/WEEK SHOTS=/tmp/lab-ui node tests/e2e/lab-ui.cjs
 * Supabase is replaced by tests/e2e/supabaseMock.cjs (10 stored NIFTY weekly days, 6–17 Oct 2025; status table absent).
 * Day files in DAYFILES must be synthetic sessions in the real file format. */
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path'), assert = require('assert');
const { mockSupabase } = require('./supabaseMock.cjs');
const BASE = process.env.BASE || 'http://localhost:3123', SHOTS = process.env.SHOTS || '/tmp/lab-ui', DAYS = process.env.DAYFILES;
fs.mkdirSync(SHOTS, { recursive: true });
const SIZES = [['desktop-xl', 1920, 1080], ['laptop', 1366, 768], ['tablet', 820, 1180], ['phone', 390, 844]];
const TABS = ['overview', 'capital', 'charts', 'trades', 'sessions', 'replay', 'research', 'diagnostics', 'ledger'];
const log = [];
const step = async (name, fn) => {
  try { await fn(); log.push(['PASS', name]); console.log('PASS', name); }
  catch (e) { log.push(['FAIL', name]); console.log('FAIL', name, '\n   ', String(e.message).split('\n')[0]); }
};

/** Layout facts: sideways page scroll, scroll boxes inside the page flow (the rail and wide tables are allowed), clipped text. */
const layout = (page) => page.evaluate(() => {
  const nested = [], clipped = [];
  for (const el of document.querySelectorAll('.ws-main *')) {
    const cs = getComputedStyle(el);
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1) nested.push(el.className);
    if (cs.overflowX === 'hidden' && el.scrollWidth > el.clientWidth + 2 && el.children.length === 0 && cs.textOverflow !== 'ellipsis') clipped.push(el.className || el.tagName);
  }
  return { sideways: document.documentElement.scrollWidth - innerWidth, nested, clipped, docH: document.documentElement.scrollHeight, wsH: document.querySelector('.ws')?.getBoundingClientRect().height ?? 0 };
});
const narrow = (w) => w < 1024;
const openSettings = async (page, w) => { if (narrow(w)) { await page.locator('.ws-mbar .qbtn').click(); await page.locator('.ws[data-drawer="open"]').waitFor(); await page.waitForTimeout(300); } };
const closeSettings = async (page, w) => { if (narrow(w)) { await page.keyboard.press('Escape'); await page.locator('.ws[data-drawer="closed"]').waitFor(); } };
const runBtn = (page, w) => page.locator(narrow(w) ? '.ws-mbar .run-btn' : '.rail-foot .run-btn');

(async () => {
  const browser = await chromium.launch();
  const errors = [];
  const ctxFor = async (w, h, opts = {}) => {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: opts.reducedMotion });
    await mockSupabase(ctx, { dayDir: DAYS, ...opts.mock });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(`${w}px pageerror: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(`${w}px console: ${m.text()}`); });
    return { ctx, page };
  };

  for (const [name, w, h] of SIZES) {
    const { ctx, page } = await ctxFor(w, h);
    await step(`${name}: synthetic run shows the headline figures without sideways scroll or nested scroll boxes`, async () => {
      await page.goto(BASE + '/lab');
      await page.locator('.exec .m--lead .m-v').waitFor({ timeout: 30000 });
      const l = await layout(page);
      assert(l.sideways <= 1, `page scrolls sideways by ${l.sideways}px`);
      assert.deepStrictEqual(l.nested, [], 'nested scroll boxes in the results');
      assert(Math.abs(l.docH - l.wsH) <= 2, `document (${l.docH}px) is taller than the workspace (${l.wsH}px)`);
      assert(/^[−+]?\u2060?₹[\d,]+$/.test(await page.locator('.exec .m--lead .m-v').innerText()), 'net P&L is a rupee figure');
      await page.screenshot({ path: path.join(SHOTS, `${name}-1-synthetic.png`) });
    });
    await step(`${name}: every results tab renders, stays inside the screen, and the tab is kept in the address`, async () => {
      for (const t of TABS) {
        await page.locator(`#tab-${t}`).click();
        await page.locator(`#panel-${t}`).waitFor({ timeout: 10000 });
        await page.waitForTimeout(t === 'trades' || t === 'replay' ? 800 : 150);
        const l = await layout(page);
        assert(l.sideways <= 1, `${t}: page scrolls sideways by ${l.sideways}px`);
        assert.deepStrictEqual(l.nested, [], `${t}: nested scroll boxes`);
        assert.strictEqual(await page.evaluate(() => location.hash), `#${t}`);
      }
      await page.reload();
      await page.locator('#tab-ledger[aria-selected="true"]').waitFor({ timeout: 30000 });
      await page.locator('#tab-overview').click();
    });
    await step(`${name}: the Research tab shows the five research views and stays mounted when you leave it`, async () => {
      await page.locator('#tab-research').click();
      await page.locator('#panel-research .rs').waitFor({ timeout: 30000 });
      for (const t of ['Reading', 'Regimes', 'Robustness', 'Optimise', 'Diagnostics']) {
        await page.locator(`#panel-research .rs .tabs button:has-text("${t}")`).click();
        await page.waitForTimeout(250);
        const l = await layout(page);
        assert(l.sideways <= 1, `research ${t}: page scrolls sideways by ${l.sideways}px`);
        assert.deepStrictEqual(l.nested, [], `research ${t}: nested scroll boxes`);
      }
      await page.locator('#tab-overview').click();
      assert.strictEqual(await page.locator('#panel-research').evaluate((e) => e.hidden), true, 'the panel is hidden, not unmounted, so a running study survives');
      await page.locator('#tab-diagnostics').click();
      await page.locator('#panel-diagnostics .slot').first().waitFor();
      assert(!/pending|not built yet/i.test(await page.locator('#panel-diagnostics').innerText()), 'diagnostics no longer claims the analytics are pending');
      await page.locator('#tab-overview').click();
    });
    await step(`${name}: the settings panel opens and closes (${narrow(w) ? 'drawer with Escape and scrim' : 'collapse to a spine and back'})`, async () => {
      if (narrow(w)) {
        assert.strictEqual(await page.locator('.ws-rail').evaluate((e) => getComputedStyle(e).visibility), 'hidden', 'drawer hidden at rest');
        await openSettings(page, w);
        const box = await page.locator('.ws-rail').boundingBox();
        assert(box.x >= -1 && box.x + box.width <= w + 1, 'drawer inside the screen');
        await page.screenshot({ path: path.join(SHOTS, `${name}-2-drawer.png`) });
        await page.keyboard.press('Escape');
        await page.locator('.ws[data-drawer="closed"]').waitFor();
        await openSettings(page, w);
        await page.locator('.ws-scrim').click({ position: { x: w - 5, y: 300 } });
        await page.locator('.ws[data-drawer="closed"]').waitFor();
      } else {
        const before = (await page.locator('.ws-rail').boundingBox()).width;
        assert(before >= 318 && before <= 382, `rail width ${before}px is outside 320–380`);
        await page.locator('.rail-head .ib').click();
        await page.locator('.ws[data-rail="collapsed"]').waitFor();
        assert((await page.locator('.ws-rail').boundingBox()).width <= 60, 'collapsed rail is a thin spine');
        assert(await page.locator('.rail-foot .run-btn').isVisible(), 'Run stays reachable when collapsed');
        await page.screenshot({ path: path.join(SHOTS, `${name}-2-collapsed.png`) });
        await page.locator('.ws-bar .ib').first().click();
        await page.locator('.ws[data-rail="open"]').waitFor();
        const rb = await page.locator('.rail-body').evaluate((e) => [e.scrollWidth, e.clientWidth]);
        assert(rb[0] <= rb[1] + 1, `rail content is wider than the rail (${rb[0]} > ${rb[1]})`);
      }
    });
    await step(`${name}: a tooltip opens on focus, stays on screen and closes with Escape`, async () => {
      await openSettings(page, w);
      const tip = page.locator('.rail-body .tip').first();
      await tip.focus();
      const pop = page.locator('.tip-pop');
      await pop.waitFor();
      const b = await pop.boundingBox();
      assert(b.x >= 0 && b.x + b.width <= w && b.y >= 0, 'tooltip inside the screen');
      await page.keyboard.press('Escape');
      await pop.waitFor({ state: 'detached' });
      await closeSettings(page, w);
    });
    await step(`${name}: every chart draws or says why it cannot`, async () => {
      await page.locator('#tab-charts').click();
      const buttons = page.locator('.chart-menu button');
      const n = await buttons.count();
      assert(n >= 10, 'ten charts');
      for (let i = 0; i < n; i++) {
        await buttons.nth(i).click();
        await page.locator('#panel-charts svg, #panel-charts .plot-empty').first().waitFor({ timeout: 5000 });
      }
    });
    await step(`${name}: tradebook filters and expands a row into its fills`, async () => {
      await page.locator('#tab-trades').click();
      await page.locator('#panel-trades .tbl tbody tr').first().waitFor({ timeout: 10000 });
      const shown = async () => (await page.locator('#panel-trades .tb-sum').innerText()).match(/Showing\s+(\d+)\s+of\s+(\d+)/).slice(1).map(Number);
      const [all, total] = await shown();
      assert.strictEqual(all, total, 'unfiltered shows every leg');
      await page.locator('#panel-trades select').first().selectOption('win');
      const [wins] = await shown();
      assert(wins > 0 && wins < total, `win filter: ${wins} of ${total}`);
      assert((await page.locator('#panel-trades .tbl tbody tr.click td:nth-child(10)').allInnerTexts()).every((t) => t.startsWith('+')), 'only winners shown');
      await page.locator('#panel-trades .rowbtn').first().click();
      await page.locator('#panel-trades .life').waitFor();
      assert(/Fill #\d+/.test(await page.locator('#panel-trades .life').innerText()), 'fills listed');
      const lb = await page.locator('#panel-trades .life-grid').boundingBox();
      assert(lb.x + lb.width <= w + 1, 'expanded row stays on screen');
      await page.screenshot({ path: path.join(SHOTS, `${name}-3-trade.png`) });
    });
    await ctx.close();
  }

  if (DAYS) {
    for (const [name, w, h] of [SIZES[1], SIZES[3]]) {
      const { ctx, page } = await ctxFor(w, h);
      await step(`${name}: real data: the calendar starts on the last 30 stored sessions and ends on the latest stored day`, async () => {
        await page.goto(BASE + '/lab?data=real');
        await page.locator('.cal-grid').waitFor({ state: 'attached', timeout: 20000 });
        await openSettings(page, w);
        await page.locator('#sec-period').scrollIntoViewIfNeeded();
        const t = await page.locator('.rail-checks').innerText();
        assert(/10 sessions will run/.test(t), t);
        assert(/17 Oct 2025/.test(t), 'end is the latest stored day, from the data');
        assert(await page.locator('.cal-day[data-date="2025-10-06"][data-state="partial"]').count() === 1, '6 Oct marked partial');
        assert(await page.locator('.cal-day[data-date="2025-10-02"][data-state="holiday"]').count() === 1, '2 Oct marked holiday');
        await page.screenshot({ path: path.join(SHOTS, `${name}-4-calendar.png`) });
      });
      await step(`${name}: presets, clicking two days and the keyboard all set the one date range`, async () => {
        await page.locator('.cal-presets button', { hasText: '7D' }).click();
        await page.locator('.rail-checks', { hasText: '7 sessions will run' }).waitFor();
        await page.locator('.cal-day[data-date="2025-10-08"]').click();
        await page.locator('.cal-day[data-date="2025-10-10"]').click();
        await page.locator('.rail-checks', { hasText: '3 sessions will run' }).waitFor();
        await page.locator('.cal-day[data-date="2025-10-13"]').focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('ArrowRight');
        await page.keyboard.press('Enter');
        await page.locator('.rail-checks', { hasText: '3 sessions will run' }).waitFor();
        assert(/13 Oct 2025 – 15 Oct 2025/.test(await page.locator('.rail-checks').innerText()), 'keyboard range 13–15 Oct');
        await page.locator('.cal-presets button', { hasText: 'Max' }).click();
        await page.locator('.rail-checks', { hasText: '10 sessions will run' }).waitFor();
      });
      await step(`${name}: real run downloads the stored days, runs every one, and lists each session's outcome`, async () => {
        await closeSettings(page, w);
        await runBtn(page, w).click();
        await page.locator('.exec').waitFor({ timeout: 40000 });
        await page.locator('#tab-sessions').click();
        const rows = await page.locator('#panel-sessions tbody tr').count();
        assert.strictEqual(rows, 10, 'ten sessions listed');
        assert(/partial/.test(await page.locator('#panel-sessions tbody tr').first().innerText()), 'partial day labelled');
        const l = await layout(page);
        assert(l.sideways <= 1, `sideways ${l.sideways}`);
      });
      await step(`${name}: changing a rule marks the result stale instead of silently re-running real data`, async () => {
        await openSettings(page, w);
        const slider = page.locator('#straddle-sl_pct');
        await slider.scrollIntoViewIfNeeded();
        await slider.focus();
        await page.keyboard.press('ArrowRight');
        await closeSettings(page, w);
        await page.locator('.stale', { hasText: 'earlier settings' }).waitFor();
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Enter' : 'Control+Enter');
        await page.locator('.stale', { hasText: 'earlier settings' }).waitFor({ state: 'detached', timeout: 30000 });
        assert(await page.locator('.exec .m-d').count() > 0, 'comparison with the default-rules baseline shown');
      });
      await step(`${name}: the guided setup walks eight steps and can be left at any point`, async () => {
        await openSettings(page, w);
        await page.locator('.rail-head button', { hasText: 'Guide me' }).click();
        for (let i = 1; i < 8; i++) {
          assert(new RegExp(`Step ${i} of 8`, 'i').test(await page.locator('.guide').innerText()));
          await page.locator('.guide-nav button', { hasText: 'Next' }).click();
        }
        await page.locator('.guide-nav button', { hasText: 'Run now' }).waitFor();
        await page.locator('.guide button', { hasText: 'Exit guide' }).click();
        await page.locator('.guide').waitFor({ state: 'detached' });
        await closeSettings(page, w);
      });
      await ctx.close();
    }
  }

  await step('loading state: progress is shown while day files download', async () => {
    const { ctx, page } = await ctxFor(1366, 768);
    await ctx.route('https://stubproject.supabase.co/storage/**', async (route) => { await new Promise((r) => setTimeout(r, 1500)); await route.fallback(); });
    await page.goto(BASE + '/lab?data=real');
    await page.locator('.cal-grid').waitFor({ state: 'attached', timeout: 20000 });
    await page.locator('.rail-foot .run-btn').click();
    await page.locator('.ws-status', { hasText: /Downloading/i }).waitFor({ timeout: 5000 });
    await page.screenshot({ path: path.join(SHOTS, 'state-loading.png') });
    await ctx.close();
  });
  for (const [label, mock, expect] of [
    ['signed out', { signedIn: false }, /Sign in/],
    ['not a data reader', { reader: false }, /data readers list/],
    ['nothing uploaded', { days: [] }, /No weekly days are uploaded yet/],
  ]) {
    await step(`empty state, ${label}: the page says why nothing can run and offers the synthetic model`, async () => {
      const { ctx, page } = await ctxFor(1366, 768, { mock });
      await page.goto(BASE + '/lab?data=real');
      await page.locator('.ws-empty').getByText(expect).first().waitFor({ timeout: 20000 });
      assert(await page.locator('.rail-foot .run-btn').isDisabled(), 'Run is disabled');
      assert(await page.locator('.ws-empty button', { hasText: 'Use the synthetic model' }).count() === 1);
      await page.screenshot({ path: path.join(SHOTS, `state-${label.replace(/\s/g, '-')}.png`) });
      await ctx.close();
    });
  }
  await step('reduced motion: section and panel animations are off', async () => {
    const { ctx, page } = await ctxFor(1366, 768, { reducedMotion: 'reduce' });
    await page.goto(BASE + '/lab');
    await page.locator('.exec').waitFor({ timeout: 30000 });
    const m = await page.evaluate(() => ({ sec: getComputedStyle(document.querySelector('.sec-b')).transitionDuration, panel: getComputedStyle(document.querySelector('.panel')).animationName }));
    assert(m.sec.split(',').every((d) => parseFloat(d) === 0), `section transition ${m.sec}`);
    assert.strictEqual(m.panel, 'none');
    await ctx.close();
  });
  await step('no page errors or console errors in any of the above', async () => { assert.deepStrictEqual(errors, []); });

  await browser.close();
  const failed = log.filter((l) => l[0] === 'FAIL');
  console.log(`\n${log.length - failed.length} passed, ${failed.length} failed`);
  process.exit(failed.length ? 1 : 0);
})();
