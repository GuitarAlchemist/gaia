import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createStreamingClaudeAdapters } from '../src/factory-visible-claude.mjs';

const inventory = 'ga/state/handoffs/wayfinder-root-inventory-20261003.md';
const capability = (tool, path) => ({ tool, path });
function effective(request, capabilities) {
  const now = Date.now();
  return { schema: 'gaia-effective-permissions/1', source: 'effective-permissions',
    complete: true, binding: request.binding, cwd: request.cwd, permissionMode: 'dontAsk',
    observedAt: now, expiresAt: now + 30_000,
    decisions: capabilities.map(value => ({ ...value, decision: 'allow' })) };
}
function fixture(observePermissions) {
  let launches = 0;
  const adapter = createStreamingClaudeAdapters({ isObservable: () => true, render: () => {},
    observePermissions, launch: request => {
      launches += 1;
      writeFileSync(request.resultPath, JSON.stringify({ schema: 'gaia-visible-agent-result/1',
        binding: request.binding, status: 'completed', summary: 'Fixture only; no Claude resume.' }));
      return { closed: Promise.resolve({ code: 0 }), stop: async () => {} };
    } });
  return { adapter, launches: () => launches };
}
async function refused(run, missing, reason) {
  await assert.rejects(run, failure => {
    assert.equal(failure.code, 'WAITING_PERMISSION');
    assert.equal(failure.status, 'WAITING_PERMISSION');
    assert.deepEqual(failure.missingCapabilities, missing);
    if (reason) assert.equal(failure.reason, reason);
    return true;
  });
}

test('dontAsk with the wrong Edit path and no result Write waits with both exact capabilities and zero launches', async () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-permission-'));
  mkdirSync(join(root, 'ga'));
  const cwd = realpathSync(root);
  let resultPath;
  const f = fixture(request => {
    resultPath = request.resultPath;
    assert.equal(request.cwd, cwd);
    assert.deepEqual(request.requiredCapabilities, [capability('Edit', resolve(cwd, inventory)),
      capability('Write', resultPath)]);
    return effective(request, [capability('Edit', 'state/handoffs/wayfinder-root-inventory-20261003.md')]);
  });
  try {
    const run = f.adapter.runWorker({ cwd: join(root, 'ga', '..'), task: 'Edit inventory',
      requiredCapabilities: [capability('Edit', inventory)] });
    await refused(run, [capability('Edit', resolve(cwd, inventory)), capability('Write', resultPath)]);
    assert.equal(f.launches(), 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('corrected Edit without Write still waits; explicitly observed Edit and result Write launch once', async () => {
  for (const withWrite of [false, true]) {
    let resultPath;
    const f = fixture(request => {
      resultPath = request.resultPath;
      return effective(request, [capability('Edit', inventory),
        ...(withWrite ? [capability('Write', resultPath)] : [])]);
    });
    const run = f.adapter.runWorker({ cwd: '.', task: 'Edit inventory',
      requiredCapabilities: [capability('Edit', inventory)] });
    if (withWrite) assert.equal((await run).provider, 'claude-subscription');
    else await refused(run, [capability('Write', resultPath)]);
    assert.equal(f.launches(), withWrite ? 1 : 0);
  }
});

test('unknown, stale, future, incomplete, wrong-attempt and allowedTools-only observations never authorize', async () => {
  for (const scenario of ['absent', 'throws', 'stale', 'future', 'incomplete', 'binding', 'cwd', 'mode', 'allowedTools']) {
    let required;
    const f = fixture(request => {
      required = request.requiredCapabilities;
      if (scenario === 'absent') return undefined;
      if (scenario === 'throws') throw new Error('sensor unavailable');
      const observation = effective(request, required);
      if (scenario === 'stale') observation.expiresAt = Date.now() - 1;
      if (scenario === 'future') observation.observedAt = Date.now() + 60_000;
      if (scenario === 'incomplete') observation.complete = false;
      if (scenario === 'binding') observation.binding = 'previous-attempt';
      if (scenario === 'cwd') observation.cwd = resolve(request.cwd, 'another');
      if (scenario === 'mode') observation.permissionMode = 'bypassPermissions';
      if (scenario === 'allowedTools') observation.source = 'allowedTools';
      return observation;
    });
    await refused(f.adapter.runWorker({ cwd: '.', task: 'Edit inventory',
      requiredCapabilities: [capability('Edit', inventory)] }), required);
    assert.equal(f.launches(), 0, scenario);
  }
  const f = fixture(undefined);
  await assert.rejects(f.adapter.runWorker({ cwd: '.', task: 'No observer',
    requiredCapabilities: [] }), { code: 'WAITING_PERMISSION' });
  assert.equal(f.launches(), 0);
});

test('effective deny, unknown and conflicting decisions override an allow for the same target', async () => {
  for (const decision of ['deny', 'unknown']) {
    let resultPath;
    const f = fixture(request => {
      resultPath = request.resultPath;
      const observation = effective(request, request.requiredCapabilities);
      observation.decisions.push({ tool: 'Write', path: resultPath, decision });
      return observation;
    });
    await refused(f.adapter.runWorker({ cwd: '.', task: 'Edit inventory',
      requiredCapabilities: [capability('Edit', inventory)] }), [capability('Write', resultPath)]);
    assert.equal(f.launches(), 0);
  }
});

test('missing or invalid business requirements cannot be replaced by structural SPAWN authority', async () => {
  for (const requiredCapabilities of [undefined, [capability('SPAWN', '.')], [capability('Edit', '')]]) {
    const f = fixture(request => effective(request, request.requiredCapabilities));
    await assert.rejects(f.adapter.runWorker({ cwd: '.', task: 'Edit inventory', requiredCapabilities }),
      { code: 'WAITING_PERMISSION', reason: 'MissionRequirementsUnknown' });
    assert.equal(f.launches(), 0);
  }
});
