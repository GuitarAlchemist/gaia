import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';

// Optional browser coverage: use an installed Playwright, without adding a runtime dependency.
const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require(process.env.GAIA_NOW_PLAYWRIGHT_PATH || 'playwright'));
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND' || process.env.GAIA_NOW_PLAYWRIGHT_PATH) throw error;
}

test('Gaia NOW keeps usable layouts live and recovers structural failures', {
  skip: !chromium && 'Install Playwright separately or set GAIA_NOW_PLAYWRIGHT_PATH to run browser coverage',
}, async t => {
  const html = await readFile(new URL('../docs/control-room/GAIA_NOW.html', import.meta.url), 'utf8');
  const fixture = JSON.parse(await readFile(new URL('../docs/control-room/GAIA_NOW_STATE.json', import.meta.url), 'utf8'));
  const browser = await chromium.launch({
    headless: process.env.GAIA_NOW_HEADED !== '1',
    ...(process.env.GAIA_NOW_BROWSER_PATH ? { executablePath: process.env.GAIA_NOW_BROWSER_PATH } : {}),
  });
  t.after(() => browser.close());

  async function openPage(t, { height, broken = false, now = new Date() }) {
    const context = await browser.newContext({ viewport: { width: 1280, height } });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.clock.install({ time: now });
    let liveState = { ...fixture, observedAt: now.toISOString(), drafts: [] };
    let failRefresh = false;
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('http://gaia-now.test/**', route => route.fulfill({
      status: failRefresh && route.request().url().includes('GAIA_NOW_STATE.json') ? 503 : 200,
      contentType: route.request().url().includes('GAIA_NOW_STATE.json') ? 'application/json' : 'text/html',
      body: route.request().url().includes('GAIA_NOW_STATE.json')
        ? JSON.stringify(liveState)
        : broken ? html.replace('id="humanRootSignal"', 'id="missingHumanRootSignal"') : html,
    }));
    await page.goto('http://gaia-now.test/GAIA_NOW.html');
    await page.waitForLoadState('networkidle');
    return {
      page, errors,
      setDrafts: drafts => { liveState = { ...liveState, drafts }; },
      setState: fields => { liveState = { ...liveState, ...fields }; },
      failRefresh: () => { failRefresh = true; },
    };
  }

  async function capture(page, name) {
    if (!process.env.GAIA_NOW_EVIDENCE_DIR) return;
    await mkdir(process.env.GAIA_NOW_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({ path: join(process.env.GAIA_NOW_EVIDENCE_DIR, `${name}.png`), fullPage: true });
  }

  function draft(number) {
    return { ...fixture.drafts[0], number, title: `Viewport refresh witness ${number}`, mergeStateStatus: 'CLEAN' };
  }

  await t.test('short viewport cold load stays usable in French and English', async t => {
    const { page, errors } = await openPage(t, { height: 300 });
    await capture(page, 'short-cold-load');
    assert.notEqual(await page.locator('body').getAttribute('data-ui-qa'), 'RECOVERED');
    assert.equal(await page.locator('#draftPullRequests').count(), 1);
    assert.equal(await page.locator('#criticalSprintTrend').count(), 1);
    await page.locator('#langToggle').click();
    await page.clock.runFor(1);
    assert.equal(await page.locator('html').getAttribute('lang'), 'en');
    assert.match(await page.locator('#draftPullRequests').innerText(), /DRAFT PRS/);
    assert.notEqual(await page.locator('body').getAttribute('data-ui-qa'), 'RECOVERED');
    assert.deepEqual(errors, []);
  });

  await t.test('live refresh after viewport shrink replaces the previously healthy view', async t => {
    const { page, errors, setDrafts } = await openPage(t, { height: 1400 });
    assert.equal(await page.locator('body').getAttribute('data-ui-qa'), '10/10');
    await page.setViewportSize({ width: 1280, height: 300 });
    setDrafts([draft(901)]);
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    await capture(page, 'short-live-refresh');
    assert.match(await page.locator('#draftPullRequests').innerText(), /Viewport refresh witness 901/);
    assert.notEqual(await page.locator('body').getAttribute('data-ui-qa'), 'RECOVERED');
    assert.deepEqual(errors, []);
  });

  await t.test('long live content can push the trend below the viewport', async t => {
    const { page, errors, setDrafts } = await openPage(t, { height: 900 });
    setDrafts(Array.from({ length: 24 }, (_, index) => draft(910 + index)));
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    await capture(page, 'long-live-refresh');
    assert.equal(await page.locator('#draftPullRequests .draft-row').count(), 24);
    assert.ok(await page.locator('#criticalSprintTrend').evaluate(element => element.getBoundingClientRect().bottom > innerHeight));
    assert.notEqual(await page.locator('body').getAttribute('data-ui-qa'), 'RECOVERED');
    assert.deepEqual(errors, []);
  });

  await t.test('missing structural content still activates recovery', async t => {
    const { page, errors } = await openPage(t, { height: 1400, broken: true });
    assert.equal(await page.locator('body').getAttribute('data-ui-qa'), 'RECOVERED');
    assert.ok(errors.some(message => message.includes('Gaia NOW safe-render rollback')));
  });

  await t.test('backlog counts distinguish ready issues, other issues and open PRs without a double-counted total', async t => {
    const { page, setState } = await openPage(t, { height: 1400 });
    setState({ backlog: { issuesOpen: 38, issuesReady: 1, prsOpen: 2 } });
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    assert.match(await page.locator('#backlogCounts').innerText(), /1 issues prêtes/);
    assert.match(await page.locator('#backlogCounts').innerText(), /37 autres issues/);
    assert.match(await page.locator('#backlogCounts').innerText(), /2 PRs ouvertes/);
    await page.locator('#langToggle').click();
    await page.clock.runFor(1);
    assert.match(await page.locator('#backlogCounts').innerText(), /1 ready issues/);
    assert.match(await page.locator('#backlogCounts').innerText(), /37 other issues/);
    await page.clock.fastForward(61000);
    assert.match(await page.locator('#backlogCounts').innerText(), /NOT LIVE/);
    setState({ backlog: { issuesOpen: 1, issuesReady: 2, prsOpen: -1 } });
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    assert.match(await page.locator('#backlogCounts').innerText(), /not measured/i);
  });

  await t.test('transport refresh cannot replace historical evidence and renders the actual pump run', async t => {
    const { page, setState } = await openPage(t, { height: 1400 });
    setState({ digest: 'transport-witness', contentObservedAt: new Date().toISOString(), providers: {},
      pump: { runId: 999001, status: 'completed', conclusion: 'success', url: 'https://github.com/GuitarAlchemist/gaia/actions/runs/999001', updatedAt: '2026-01-01T00:00:00Z' } });
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    await capture(page, 'transport-pump');
    assert.match(await page.locator('#evidenceSlot').innerText(), /36cb1f1/);
    assert.doesNotMatch(await page.locator('#evidenceSlot').innerText(), /transport-witness/);
    assert.match(await page.locator('#pumpLedger').innerText(), /999001.*completed.*success/s);
    assert.match(await page.locator('#pumpLedger').innerText(), /2026-01-01T00:00:00Z/);
    assert.match(await page.locator('#pumpLedger').innerText(), /COLLECTE FRAÎCHE/);
    assert.match(await page.locator('#pumpLedger').innerText(), /preuve de livraison/i);
    await page.locator('#pumpLedger .pump-message').focus();
    assert.match(await page.locator('#timelinePopover').innerText(), /999001/);
    assert.doesNotMatch(await page.locator('#timelinePopover').innerText(), /33917897845|bd65dd2/);
    await page.locator('#langToggle').click();
    await page.clock.runFor(1);
    assert.match(await page.locator('#pumpLedger').innerText(), /delivery proof/i);
    setState({ pump: { runId: 999002, status: 'in_progress', conclusion: null, url: 'javascript:alert(1)' } });
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    assert.match(await page.locator('#pumpLedger').innerText(), /999002.*in_progress/s);
    assert.doesNotMatch(await page.locator('#pumpLedger').innerText(), /999001/);
    assert.equal(await page.locator('#pumpLedger a').getAttribute('href'), '#');
  });

  await t.test('successful polling of unchanged JSON does not renew its source freshness', async t => {
    const { page } = await openPage(t, { height: 1400 });
    const observed = await page.locator('#draftPullRequests > small').innerText();
    assert.match(await page.locator('#draftPullRequests').innerText(), /COLLECTE FRAÎCHE/);
    await page.clock.fastForward(61000);
    await page.waitForLoadState('networkidle');
    await capture(page, 'unchanged-source-stale');
    assert.match(await page.locator('#draftPullRequests').innerText(), /NON ACTUEL/);
    assert.equal(await page.locator('#draftPullRequests > small').innerText(), observed);
    assert.equal(await page.locator('#draftPullRequests .live-ping').count(), 0);
  });

  await t.test('collection failure retains drafts but labels all current observations stale', async t => {
    const { page, setDrafts, failRefresh } = await openPage(t, { height: 1400 });
    setDrafts([{ ...draft(940), mergeStateStatus: 'DIRTY', checks: { failure: 1 } }]);
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    assert.match(await page.locator('#draftPullRequests').innerText(), /COLLECTE FRAÎCHE/);
    failRefresh();
    await page.clock.fastForward(61000);
    await page.waitForLoadState('networkidle');
    await capture(page, 'stale-collection');
    assert.match(await page.locator('#draftPullRequests').innerText(), /940/);
    for (const id of ['draftPullRequests', 'activeEscalations', 'pumpLedger']) {
      assert.match(await page.locator(`#${id}`).innerText(), /NON ACTUEL/);
      assert.equal(await page.locator(`#${id} .live-ping`).count(), 0);
    }
    await page.locator('#langToggle').click();
    await page.clock.runFor(1);
    assert.match(await page.locator('#draftPullRequests').innerText(), /NOT LIVE/);
  });

  for (const observedAt of ['invalid-time', '2999-01-01T00:00:00Z']) {
    await t.test(`invalid observation time cannot appear fresh: ${observedAt}`, async t => {
      const { page, setState } = await openPage(t, { height: 1400 });
      setState({ observedAt, drafts: [draft(941)] });
      await page.clock.fastForward(16000);
      await page.waitForLoadState('networkidle');
      assert.match(await page.locator('#draftPullRequests').innerText(), /NON ACTUEL/);
      assert.equal(await page.locator('#draftPullRequests .live-ping').count(), 0);
      assert.notEqual(await page.locator('body').getAttribute('data-ui-qa'), 'RECOVERED');
    });
  }

  await t.test('review expander preserves open and closed choices across timer rebuilds with its popover usable', async t => {
    const { page } = await openPage(t, { height: 1400 });
    const details = page.locator('[data-details-key="lane-reviews"]');
    const summary = details.locator(':scope > summary');
    assert.equal(await details.evaluate(element => element.open), false);
    await summary.click();
    assert.equal(await details.evaluate(element => element.open), true);
    assert.equal(await page.locator('#timelinePopover').isVisible(), true);
    assert.match(await page.locator('#timelinePopover').innerText(), /PR/);
    await page.clock.runFor(1);
    await page.clock.fastForward(1100);
    await capture(page, 'review-expander-open-after-rebuild');
    assert.equal(await details.evaluate(element => element.open), true);
    await summary.click();
    assert.equal(await details.evaluate(element => element.open), false);
    assert.equal(await page.locator('#timelinePopover').isVisible(), true);
    await page.clock.runFor(1);
    await page.clock.fastForward(1100);
    await capture(page, 'review-expander-closed-after-rebuild');
    assert.equal(await details.evaluate(element => element.open), false);
    await summary.focus();
    assert.equal(await page.locator('#timelinePopover').isVisible(), true);
  });

  await t.test('impossible calendar dates retain the last valid snapshot as not live', async t => {
    const { page, setState } = await openPage(t, { height: 1400, now: new Date('2026-03-02T00:00:00Z') });
    setState({ drafts: [draft(950)] });
    await page.clock.fastForward(16000);
    await page.waitForLoadState('networkidle');
    assert.match(await page.locator('#draftPullRequests').innerText(), /COLLECTE FRAÎCHE/);
    for (const observedAt of ['2026-02-30T00:00:00Z', '2026-02-29T00:00:00Z', '2026-02-28T24:00:00Z', '2026-03-02T00:60:00Z', '2026-03-02T00:00:60Z', '2026-03-02T00:00:00+24:00']) {
      setState({ observedAt, drafts: [draft(951)] });
      await page.clock.fastForward(16000);
      await page.waitForLoadState('networkidle');
      if (observedAt.includes('02-30')) await capture(page, 'invalid-calendar-retained-snapshot');
      const text = await page.locator('#draftPullRequests').innerText();
      assert.match(text, /Viewport refresh witness 950/, observedAt);
      assert.doesNotMatch(text, /Viewport refresh witness 951/, observedAt);
      assert.match(text, /NON ACTUEL/, observedAt);
      assert.equal(await page.locator('#draftPullRequests .live-ping').count(), 0);
    }
  });

  await t.test('valid leap dates, fractional seconds and offsets remain supported', async t => {
    const { page, setState } = await openPage(t, { height: 1400, now: new Date('2024-02-29T12:00:00Z') });
    for (const observedAt of ['2024-02-29T07:00:00.1234567-05:00', '2024-02-29T13:00:00.123+01:00']) {
      setState({ observedAt, drafts: [draft(952)] });
      await page.clock.fastForward(16000);
      await page.waitForLoadState('networkidle');
      const text = await page.locator('#draftPullRequests').innerText();
      assert.match(text, /Viewport refresh witness 952/);
      assert.match(text, /COLLECTE FRAÎCHE/);
      assert.ok(text.includes(observedAt));
    }
  });
});
