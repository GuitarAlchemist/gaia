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

  async function openPage(t, { height, broken = false }) {
    const context = await browser.newContext({ viewport: { width: 1280, height } });
    t.after(() => context.close());
    const page = await context.newPage();
    await page.clock.install();
    let liveState = { ...fixture, observedAt: new Date().toISOString(), drafts: [] };
    const errors = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.route('http://gaia-now.test/**', route => route.fulfill({
      contentType: route.request().url().includes('GAIA_NOW_STATE.json') ? 'application/json' : 'text/html',
      body: route.request().url().includes('GAIA_NOW_STATE.json')
        ? JSON.stringify(liveState)
        : broken ? html.replace('id="humanRootSignal"', 'id="missingHumanRootSignal"') : html,
    }));
    await page.goto('http://gaia-now.test/GAIA_NOW.html');
    await page.waitForLoadState('networkidle');
    return { page, errors, setDrafts: drafts => { liveState = { ...liveState, drafts }; } };
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
});
