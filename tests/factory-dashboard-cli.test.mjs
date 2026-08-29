import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-cli-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function portfolio(workItems) {
  const body = { schema: 'gaia-github-portfolio/1', policyRevision: 'policy-r0', workItems };
  return {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

test('the dashboard CLI turns the drain projection and real progress JSONL into shareable artifacts', () => {
  const projectionPath = join(scratch, 'projection.json');
  const progressPath = join(scratch, 'progress.jsonl');
  const htmlPath = join(scratch, 'control-room.html');
  const snapshotPath = join(scratch, 'control-room.json');
  writeFileSync(projectionPath, `${JSON.stringify({
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: 'a'.repeat(64),
    effect: 'NONE', authority: 'NONE', capacity: 4,
    counts: { occupied: 1, available: 3 },
    items: [{
      repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE', itemId: 'issue-17',
      itemNumber: 17, title: 'Integrate the factory control room', sourceState: 'READY',
      observedPortfolioRevision: 'a'.repeat(64), drainState: 'RUNNING', hold: null,
    }],
    decisions: [], revision: 'b'.repeat(64),
  })}\n`, 'utf8');
  writeFileSync(progressPath, `${JSON.stringify({
    schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 35_000,
    remainingProviderInvocations: 4, remainingProviderTimeUpperBoundMs: 2_400_000,
    heartbeat: true,
  })}\n`, 'utf8');
  const changedAt = new Date('2026-08-29T18:40:15.000Z');
  utimesSync(projectionPath, changedAt, changedAt);
  utimesSync(progressPath, changedAt, changedAt);
  let stdout = '';

  const snapshot = runFactoryDashboardCli([
    '--projection', projectionPath,
    '--progress', progressPath,
    '--html-out', htmlPath,
    '--snapshot-out', snapshotPath,
  ], {
    now: () => new Date('2026-08-29T18:40:20.000Z'),
    writeStdout: (chunk) => { stdout += chunk; },
  });

  assert.equal(snapshot.headline.state, 'ACTIVE');
  assert.equal(snapshot.sourceChangedAt, '2026-08-29T18:40:15.000Z');
  assert.deepEqual(JSON.parse(readFileSync(snapshotPath, 'utf8')), snapshot);
  assert.match(readFileSync(htmlPath, 'utf8'), /Real heartbeat received/u);
  assert.match(stdout, /ACTIVE/u);
  assert.match(stdout, /OBSERVE_ACTIVE_RUN/u);
});

test('the dashboard CLI can reconcile a real Gaia portfolio without a hand-made projection', () => {
  const portfolioPath = join(scratch, 'portfolio.json');
  const htmlPath = join(scratch, 'portfolio-control-room.html');
  const snapshotPath = join(scratch, 'portfolio-control-room.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  }]))}\n`, 'utf8');
  let stdout = '';

  const snapshot = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--html-out', htmlPath,
    '--snapshot-out', snapshotPath,
  ], {
    now: () => new Date('2026-08-29T18:40:20.000Z'),
    writeStdout: (chunk) => { stdout += chunk; },
  });

  assert.equal(snapshot.items[0].drainState, 'QUEUED');
  assert.equal(snapshot.items[0].progress.percentage, 0);
  assert.equal(snapshot.nextAction.kind, 'CLAIM_FACTORY_RUN');
  assert.match(stdout, /CLAIM_FACTORY_RUN/u);
});
