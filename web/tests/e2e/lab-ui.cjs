/* Lab workspace UI tests in a real browser, at four screen sizes, against `next start`.
 *   NEXT_PUBLIC_SUPABASE_URL=https://stubproject.supabase.co NEXT_PUBLIC_SUPABASE_ANON_KEY=sb_publishable_test npm run build
 *   npx next start -p 3123 &
 *   BASE=http://localhost:3123 DAYFILES=/path/to/dayfiles/NIFTY/WEEK SHOTS=/tmp/lab-ui node tests/e2e/lab-ui.cjs
 * Uses `playwright` (npx playwright install chromium), or `playwright-core` with an installed browser: PW_CHANNEL=msedge.
 * Supabase is replaced by tests/e2e/supabaseMock.cjs (10 stored NIFTY weekly days, 6–17 Oct 2025; status table absent).
 * Day files in DAYFILES must be synthetic sessions in the real file format. */
let pw;
try { pw = require('playwright'); } catch { pw = require('playwright-core'); }
const { chromium } = pw;
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
/** Types into a box the way a person does: scroll to it, click, replace its text. */
const typeIn = async (loc, text) => { await loc.scrollIntoViewIfNeeded(); await loc.click(); await loc.fill(text); };
const runBtn = (page, w) => page.locator(narrow(w) ? '.ws-mbar .run-btn' : '.rail-foot .run-btn');

(async () => {
  const browser = await chromium.launch(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {});
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
        assert(before >= 334 && before <= 402, `rail width ${before}px is outside 336–400`);
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
        await page.locator('#sec-data').scrollIntoViewIfNeeded();
        const t = await page.locator('.rail-checks').innerText();
        assert(/10 sessions will run/.test(t), t);
        assert(/17 Oct 2025/.test(t), 'end is the latest stored day, from the data');
        assert(await page.locator('.cal-day[data-date="2025-10-06"][data-state="partial"]').count() === 1, '6 Oct marked partial');
        // history starts on the first stored day (6 Oct): 2 Oct is outside it and cannot be picked
        assert(await page.locator('.cal-day[data-date="2025-10-02"][data-state="outside"]:disabled').count() === 1, '2 Oct is outside the stored history');
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
      await step(`${name}: the range bar moves the window, cuts it at the stored history and says so; rolling windows run`, async () => {
        const now = () => page.locator('.rb-now').innerText();
        const chip = (t) => page.locator('.rb .rb-chip', { hasText: new RegExp(`^${t.replace('+', '\\+')}$`) });
        assert(/6 Oct 2025 – 17 Oct 2025/.test(await now()) && /10 sessions/.test(await now()), await now());
        // all stored history is selected: nothing before or after it
        assert(await page.locator('.rb-step', { hasText: 'Previous' }).isDisabled() && await page.locator('.rb-step', { hasText: 'Next' }).isDisabled(), 'both moves disabled at the edges');
        assert(/nothing is stored after 17 Oct 2025/.test(await page.locator('.rb-step', { hasText: 'Next' }).getAttribute('title')));
        // the last 7 sessions (9–17 Oct, 9 days); the window before it runs into 6 Oct, the first stored day
        await chip('7D').click();
        assert(/9 Oct 2025 – 17 Oct 2025/.test(await now()), await now());
        await page.locator('.rb-step', { hasText: 'Previous' }).click();
        assert(/6 Oct 2025 – 8 Oct 2025/.test(await now()), await now());
        assert(/Stored data starts on 6 Oct 2025: this window has 3 of the 9 days asked for/.test(await page.locator('.rb-note').innerText()));
        // Next goes back to the 9-day window that was asked for, not a 3-day one
        await page.locator('.rb-step', { hasText: 'Next' }).click();
        assert(/9 Oct 2025 – 17 Oct 2025/.test(await now()), await now());
        await chip('60D').click();
        assert(/6 Oct 2025 – 17 Oct 2025/.test(await now()), '60 sessions: all 10 stored');
        await page.locator('#rb-n').fill('5'); await page.locator('.rb-unit').selectOption('days'); await chip('Use').click();
        assert(/13 Oct 2025 – 17 Oct 2025/.test(await now()), await now());
        await chip('Max').click();
        // rolling: 5-day windows every 5 days over 6–17 Oct: 6–10 and 11–15 Oct; 16–17 Oct are in no window
        await page.locator('.rb-check input').check();
        await page.locator('#rb-w').fill('5'); await page.locator('#rb-s').fill('5');
        assert(/2 windows · the last 2 days are in no window/.test(await page.locator('.rb-plan').innerText()));
        await closeSettings(page, w);
        await runBtn(page, w).click();
        await page.locator('#tab-rolling').click();
        await page.locator('#panel-rolling table').waitFor({ timeout: 40000 });
        const rows = await page.locator('#panel-rolling tbody tr').allInnerTexts();
        assert.strictEqual(rows.length, 2);
        assert(/6 Oct 2025 – 10 Oct 2025\s+5\b/.test(rows[0]) && /11 Oct 2025 – 15 Oct 2025\s+3\b/.test(rows[1]), rows.join(' / '));
        const l = await layout(page);
        assert(l.sideways <= 1, `sideways ${l.sideways}`);
        await page.locator('.rb-check input').uncheck();
        await page.locator('#tab-overview').click();
      });
      await step(`${name}: changing a rule marks the result stale instead of silently re-running real data`, async () => {
        await openSettings(page, w);
        if (await page.locator('#sec-risk-h').getAttribute('aria-expanded') === 'false') await page.locator('#sec-risk-h').click();
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
      await step(`${name}: the guided setup walks seven steps and can be left at any point`, async () => {
        await openSettings(page, w);
        await page.locator('.rail-head button', { hasText: 'Guide me' }).click();
        for (let i = 1; i < 7; i++) {
          assert(new RegExp(`Step ${i} of 7`, 'i').test(await page.locator('.guide').innerText()));
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

  // ---- the configuration controls (Stage 2): time picker, stop/target levels, builder legs, layout at desktop widths
  await step('time picker: typing, the interval list, the grain and the order of times are all enforced', async () => {
    const { ctx, page } = await ctxFor(1440, 900);
    await page.goto(BASE + '/lab');
    await page.locator('.exec').waitFor({ timeout: 30000 });
    await page.locator('#sec-timing-h').click();
    const entry = page.locator('#straddle-entry_time');
    await entry.waitFor();
    // typing a time off the 5-minute grid snaps to it and says so
    await typeIn(entry, '1002'); await entry.press('Enter');
    assert.strictEqual(await entry.inputValue(), '10:00');
    assert(/not allowed here; set to 10:00/.test(await page.locator('.tf[data-role="entry"] .f-meta').innerText()), 'snap note shown');
    // the list: 15-minute steps, filtered by typing, picked with the keyboard
    await page.locator('.tf[data-role="entry"] .tf-open').click();
    await page.locator('.tf-iv button', { hasText: '15 min' }).click();
    const listed = await page.locator('.tf-grid [role="option"]').allInnerTexts();
    assert(listed.includes('10:15') && !listed.includes('10:05'), '15-minute list');
    await typeIn(entry, '103'); assert.deepStrictEqual(await page.locator('.tf-grid [role="option"]').allInnerTexts(), ['10:30'], 'typing 103 filters the 15-minute list to 10:30');
    await entry.press('ArrowDown'); await entry.press('Enter');
    assert.strictEqual(await entry.inputValue(), '10:30');
    // order: an entry after the square-off is an error and blocks Run
    await typeIn(entry, '15:00'); await entry.press('Enter');
    const exit = page.locator('#straddle-exit_time');
    await typeIn(exit, '14:00'); await exit.press('Enter');
    await page.locator('.tf[data-role="entry"] .f-meta [role="alert"]', { hasText: 'before the square-off' }).waitFor();
    assert(await page.locator('.rail-foot .run-btn').isDisabled(), 'Run is disabled while the times are out of order');
    assert(/\d to fix/.test(await page.locator('#sec-timing-h').innerText()), 'section badge counts the problems');
    await typeIn(exit, '15:15'); await exit.press('Enter');
    await page.locator('.rail-foot .run-btn:not([disabled])').waitFor();
    await ctx.close();
  });
  await step('stops and targets: typed values with units, a wide range, a unit switch and an off switch', async () => {
    const { ctx, page } = await ctxFor(1440, 900);
    await page.goto(BASE + '/lab');
    await page.locator('.exec').waitFor({ timeout: 30000 });
    await page.locator('#sec-risk-h').click();
    const sl = page.locator('#straddle-sl_pct-n');
    await typeIn(sl, '250'); await sl.press('Enter');
    assert.strictEqual(await sl.inputValue(), '250', 'a 250% stop is allowed (was capped at 75%)');
    await typeIn(sl, '900'); await sl.press('Enter');
    assert.strictEqual(await sl.inputValue(), '500');
    assert(/outside 5%–500%/.test(await page.locator('#sec-risk .lf').first().innerText()), 'clamp explained');
    const cap = page.locator('#straddle-max_loss_per_lot-on');
    await cap.check();
    assert(Number((await page.locator('#straddle-max_loss_per_lot-n').inputValue()).replace(/,/g, '')) > 0, 'the loss cap switched on with a value');
    // the builder: one field in four units
    await page.goto(BASE + '/lab?s=short_strangle');
    await page.locator('.exec').waitFor({ timeout: 30000 });
    await page.locator('#sec-risk-h').click();
    await page.locator('#short_strangle-short_sl-on').check();
    await page.locator('#sec-risk .lf-units').first().locator('button', { hasText: '₹/lot' }).click();
    const v = page.locator('#short_strangle-short_sl-n');
    await typeIn(v, '2500'); await v.press('Tab');
    assert.strictEqual(await v.inputValue(), '2,500', 'grouped when not being edited');
    assert((await page.locator('#sec-risk-h').innerText()).includes('₹2,500/lot'), 'the section summary reads ₹2,500/lot');
    await ctx.close();
  });
  await step('builder legs: edit a leg, the engine refuses a strike outside the stored window with the reason, reset', async () => {
    const { ctx, page } = await ctxFor(1440, 900);
    await page.goto(BASE + '/lab?s=iron_condor');
    await page.locator('.exec').waitFor({ timeout: 30000 });
    assert.strictEqual(await page.locator('.lt-t tbody tr').count(), 4);
    await page.locator('.lt-ed-btn').nth(3).click();
    const steps = page.locator('.lt-edit .lt-strike input').first();
    await typeIn(steps, '9'); await steps.press('Enter');
    await typeIn(steps, '16'); await steps.press('Enter');
    assert.strictEqual(await steps.inputValue(), '10', 'ATM offset capped at 10 in the editor');
    // a leg relative to another, too far out: the engine's own check names the leg
    await page.locator('.lt-edit select').first().selectOption('leg');
    const rel = page.locator('.lt-edit .lt-strike input').first();
    await typeIn(rel, '16'); await rel.press('Enter'); // L3 is 2 strikes out: 2 + 16 = 18, past the synthetic chain's ATM ± 15
    await page.locator('.lt-gates', { hasText: /L4 is \d+ strikes from ATM; only ATM ± 15 is stored/ }).waitFor();
    assert(await page.locator('.rail-foot .run-btn').isDisabled(), 'Run is disabled while a leg is refused');
    assert(await page.locator('.lt-t tr[data-bad]').count() >= 1, 'the leg row is marked');
    await page.locator('.lt-actions .qbtn', { hasText: 'Reset' }).click();
    await page.locator('.lt-gates').waitFor({ state: 'detached' });
    await page.locator('.rail-foot .run-btn:not([disabled])').waitFor();
    await ctx.close();
  });
  await step('data status: one line with the caveat, the assumptions open below it', async () => {
    const { ctx, page } = await ctxFor(1366, 768);
    await page.goto(BASE + '/lab');
    await page.locator('.exec').waitFor({ timeout: 30000 });
    const h = (await page.locator('.ds-line').boundingBox()).height;
    assert(h <= 44, `status line is ${h}px tall`);
    assert(/not evidence about NIFTY/.test(await page.locator('.ds-line').innerText()));
    await page.locator('.ds-line .qlink', { hasText: 'Assumptions' }).click();
    assert(/Fills/.test(await page.locator('.ds-panel').innerText()));
    await ctx.close();
  });
  await step('desktop widths 1280–1920: no sideways scroll, nothing clipped in the rail, the rail stays short', async () => {
    for (const w of [1280, 1366, 1440, 1536, 1920]) {
      const { ctx, page } = await ctxFor(w, 800);
      for (const s of ['straddle', 'iron_condor']) {
        await page.goto(`${BASE}/lab?s=${s}`);
        await page.locator('.exec').waitFor({ timeout: 30000 });
        for (const id of ['strategy', 'timing', 'risk', 'data', 'capital', 'advanced']) { const h = page.locator(`#sec-${id}-h`); if (await h.getAttribute('aria-expanded') === 'false') await h.click(); }
        await page.waitForTimeout(350);
        const l = await layout(page);
        assert(l.sideways <= 1, `${w}px ${s}: page scrolls sideways by ${l.sideways}px`);
        const rb = await page.locator('.rail-body').evaluate((e) => [e.scrollWidth, e.clientWidth, e.scrollHeight]);
        assert(rb[0] <= rb[1] + 1, `${w}px ${s}: rail content is wider than the rail (${rb[0]} > ${rb[1]})`);
        assert(rb[2] <= 3700, `${w}px ${s}: every rail section open is ${rb[2]}px tall`);
      }
      await ctx.close();
    }
  });

  await step('optimiser: the four-leg model cannot be searched, and the button says why', async () => {
    const { ctx, page } = await ctxFor(1366, 768);
    await page.goto(`${BASE}/lab?s=fourleg`);
    await page.locator('.exec').waitFor({ timeout: 30000 });
    const b = page.locator('.rail-foot .opt-btn');
    assert(await b.isDisabled(), 'Optimise is disabled for the four-leg model');
    assert(/synthetic stock model/.test(await b.getAttribute('title')), 'the reason is on the button');
    await ctx.close();
  });
  {
    const { ctx, page } = await ctxFor(1366, 768);
    const lead = () => page.locator('.exec .m--lead .m-v').innerText();
    await step('optimiser: the estimate comes first; a study gives three labelled answers and a table without the held-out test', async () => {
      await page.goto(`${BASE}/lab?s=straddle`);
      await page.locator('.exec').waitFor({ timeout: 30000 });
      await page.locator('.rail-foot .opt-btn').click();
      await page.locator('.opt-axes').waitFor();
      await page.locator('.opt-setup .figs .m', { hasText: /will try/i }).waitFor({ timeout: 10000 });
      const est = await page.locator('.opt-setup .figs').innerText();
      assert(/grid\s+35\b/i.test(est) && /will try\s+36\b/i.test(est) && /can run\s+36\b/i.test(est), est);
      const l = await layout(page);
      assert(l.sideways <= 1, `optimiser setup scrolls sideways by ${l.sideways}px`);
      await page.screenshot({ path: path.join(SHOTS, 'opt-setup.png') });
      await page.locator('button', { hasText: 'Start the study' }).click();
      await page.locator('.opt-answers').waitFor({ timeout: 90000 });
      const labels = await page.locator('.opt-card .opt-card-h .lbl').allInnerTexts();
      assert.deepStrictEqual(labels.map((t) => t.toLowerCase()), ['in-sample leader', 'best out-of-sample', 'most robust']);
      assert(/not evidence/i.test(await page.locator('.opt-card').first().innerText()), 'the leader is labelled as not evidence');
      assert.strictEqual(await page.locator('.opt-tbl tbody tr').count(), 36, 'every configuration is in the table');
      assert(!/test/i.test(await page.locator('.opt-tbl thead').innerText()), 'no held-out test column in the table');
      // the file the page would save, read inside the page (a real download leaves Playwright crashing on close)
      await page.evaluate(() => { const orig = HTMLAnchorElement.prototype.click; HTMLAnchorElement.prototype.click = function () { if (this.download) { window.__csv = fetch(this.href).then((r) => r.text()); return; } return orig.call(this); }; });
      await page.locator('button', { hasText: 'Export CSV' }).click();
      const head = (await page.evaluate(() => window.__csv)).split('\n')[0];
      assert(head.startsWith('rank_by_training,config,sl_pct,target_per_lot') && !/test|full/.test(head), head);
      const l2 = await layout(page);
      assert(l2.sideways <= 1, `study results scroll sideways by ${l2.sideways}px`);
      await page.screenshot({ path: path.join(SHOTS, 'opt-results.png'), fullPage: true });
    });
    await step('optimiser: "Run a backtest" on an answer loads it into the Lab and reproduces the figure the study measured', async () => {
      const card = page.locator('.opt-card').first();
      const want = (await card.innerText()).match(/held-out test included: net (\S+)/)[1];
      await card.locator('button', { hasText: 'Run a backtest' }).click();
      await page.locator('.exec').waitFor({ timeout: 30000 });
      await page.waitForFunction(() => !document.querySelector('.stale') && document.querySelector('.ws-status')?.getAttribute('data-state') === 'done', null, { timeout: 30000 });
      assert.strictEqual((await lead()).trim(), want);
      assert(/Loaded from the optimisation lab/.test(await page.locator('.rail-note').innerText()), 'the rail says where the settings came from');
    });
    await step('optimiser: a cancelled study keeps what it measured, is saved, and resumes to the end', async () => {
      await page.locator('.rail-foot .opt-btn').click();
      await page.locator('button', { hasText: 'Set up another study' }).click();
      await page.locator('.opt-axes tbody tr', { hasText: 'Entry' }).first().locator('input[type=checkbox]').check();
      await page.locator('.opt-setup .figs .m', { hasText: /will try\s*176/i }).waitFor({ timeout: 10000 });
      await page.locator('button', { hasText: 'Start the study' }).click();
      await page.locator('.opt-rate', { hasText: /a second/ }).waitFor({ timeout: 60000 });
      await page.locator('button', { hasText: 'Cancel, keep what is measured' }).click();
      await page.locator('.ws-empty', { hasText: 'Cancelled' }).waitFor({ timeout: 30000 });
      const n = Number((await page.locator('.ws-empty').innerText()).match(/(\d+) of 176 configurations were measured/)[1]);
      assert(n >= 10 && n < 176, `measured ${n} before the cancel`);
      await page.locator('.opt-tabs button', { hasText: 'Saved' }).click();
      await page.locator('#opt-saved-h').waitFor();
      const saved = await page.locator('#opt-saved-h').locator('xpath=../..').innerText();
      assert(/Cancelled/.test(saved) && /Finished/.test(saved), saved);
      await page.locator('#opt-saved-h').locator('xpath=../..').locator('button', { hasText: 'Resume' }).click();
      await page.locator('.opt-answers').waitFor({ timeout: 90000 });
      assert.strictEqual(await page.locator('.opt-tbl tbody tr').count(), 50, 'the first 50 of 176 rows are shown');
      assert(/176 of 176/.test(await page.locator('.opt-tools').innerText()), 'all 176 configurations are in the table');
    });
    await ctx.close();
  }
  await step('optimiser on a phone: opened from the bottom bar, nothing scrolls sideways', async () => {
    const { ctx, page } = await ctxFor(390, 844);
    await page.goto(`${BASE}/lab?s=short_strangle`);
    await page.locator('.exec').waitFor({ timeout: 30000 });
    await page.locator('.ws-mbar .opt-btn').click();
    await page.locator('.opt-axes').waitFor();
    await page.waitForTimeout(400);
    const l = await layout(page);
    assert(l.sideways <= 1, `sideways ${l.sideways}px`);
    await page.screenshot({ path: path.join(SHOTS, 'opt-phone.png'), fullPage: true });
    await ctx.close();
  });
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
