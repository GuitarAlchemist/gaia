/**
 * E6. Network. Mastra ships PostHog telemetry that is on unless `MASTRA_TELEMETRY_DISABLED` is set.
 * In this prototype's in-process use, no workflow run makes a request. The control proves the spy
 * would see one: Mastra's own feature-usage call reaches PostHog through `fetch` when the variable
 * is unset, and sends nothing once it is set. The spy answers every request itself, so nothing
 * leaves the machine.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

const requests = [];
globalThis.fetch = async (input) => {
  requests.push(new URL(typeof input === 'string' ? input : input.url).host);
  return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
};
delete process.env.MASTRA_TELEMETRY_DISABLED;

const { createAttemptObserver, observeStream } = await import('../src/attempt-observer.mjs');
const { approval, coordinatorClock, mastraWith, settle, threeSteps } = await import('./fixtures.mjs');
const { trackFeatureUsage } = await import('@mastra/core/telemetry');

test('E6: workflow runs make no request, with telemetry left at its default', async () => {
  const mastra = mastraWith({ threeSteps: threeSteps(), approval: approval() });
  const clock = coordinatorClock('2026-10-13T13:00:00.000Z');
  await observeStream((await mastra.getWorkflow('threeSteps').createRun()).stream({ inputData: { n: 0 } }),
    createAttemptObserver(['prepare', 'build', 'report']), clock);
  const run = await mastra.getWorkflow('approval').createRun();
  await run.start({ inputData: { n: 1 } });
  await run.resume({ step: 'gate', resumeData: { approved: true } });
  await settle(200);
  assert.deepEqual(requests, []);
});

test('E6 control: the spy sees Mastra telemetry when it is on, and none once it is disabled', async () => {
  trackFeatureUsage('gaia_prototype_probe', {});
  await settle(500);
  assert.ok(requests.length > 0 && requests.every((host) => /posthog\.com$/.test(host)),
    `telemetry reached the spy: ${JSON.stringify(requests)}`);

  const seen = requests.length;
  process.env.MASTRA_TELEMETRY_DISABLED = '1';
  trackFeatureUsage('gaia_prototype_probe', {});
  await settle(500);
  assert.equal(requests.length, seen, 'MASTRA_TELEMETRY_DISABLED=1 sends nothing');
});
