import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  runFactoryDashboardRefreshCli, runFactoryDashboardRefreshLoop,
} from '../scripts/factory-dashboard-refresh.mjs';

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
  const body = {
    schema: 'gaia-github-portfolio/1',
    policyRevision: 'sha256:portfolio-policy-v1',
    workItems,
  };
  return {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

test('refresh surveys once and publishes a coherent English control room artifact set', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const portfolioPath = join(scratch, 'portfolio.json');
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');
  writeFileSync(portfolioPath, 'old portfolio', 'utf8');
  writeFileSync(snapshotPath, 'old snapshot', 'utf8');
  writeFileSync(htmlPath, 'old html', 'utf8');
  const surveyed = portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  }]);
  const requests = [];
  let stdout = '';

  const snapshot = await runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ], {
    now: () => new Date('2026-08-29T20:00:00.000Z'),
    surveyPortfolio: async (request) => {
      requests.push(request);
      return surveyed;
    },
    writeStdout: (chunk) => { stdout += chunk; },
  });

  assert.deepEqual(requests, [{
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  }]);
  assert.deepEqual(JSON.parse(readFileSync(portfolioPath, 'utf8')), surveyed);
  assert.deepEqual(JSON.parse(readFileSync(snapshotPath, 'utf8')), snapshot);
  assert.equal(snapshot.nextAction.kind, 'CLAIM_FACTORY_RUN');
  assert.match(readFileSync(htmlPath, 'utf8'), /Gaia — real status/u);
  assert.match(stdout, /Gaia control room refreshed/u);
  assert.match(stdout, /CLAIM_FACTORY_RUN/u);
});

test('a failed survey preserves the last complete control room artifact set', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-failure-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const portfolioPath = join(scratch, 'portfolio.json');
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');
  writeFileSync(portfolioPath, 'last portfolio', 'utf8');
  writeFileSync(snapshotPath, 'last snapshot', 'utf8');
  writeFileSync(htmlPath, 'last html', 'utf8');

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ], {
    surveyPortfolio: async () => { throw new Error('GitHub unavailable'); },
  }), /GitHub unavailable/u);

  assert.equal(readFileSync(portfolioPath, 'utf8'), 'last portfolio');
  assert.equal(readFileSync(snapshotPath, 'utf8'), 'last snapshot');
  assert.equal(readFileSync(htmlPath, 'utf8'), 'last html');
});

test('watch retries after failure and never overlaps GitHub surveys', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-watch-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const controller = new AbortController();
  let calls = 0;
  let active = 0;
  let maxActive = 0;
  let waits = 0;
  const errors = [];

  await runFactoryDashboardRefreshLoop([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', join(scratch, 'portfolio.json'),
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--watch-ms', '10000',
  ], {
    signal: controller.signal,
    surveyPortfolio: async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (calls === 1) throw new Error('transient GitHub failure');
        return portfolio([]);
      } finally {
        active -= 1;
      }
    },
    wait: async (milliseconds) => {
      assert.equal(milliseconds, 10_000);
      waits += 1;
      if (waits === 2) controller.abort();
    },
    writeError: (error) => { errors.push(error.message); },
    writeStdout: () => {},
  });

  assert.equal(calls, 2);
  assert.equal(maxActive, 1);
  assert.deepEqual(errors, ['transient GitHub failure']);
  assert.equal(JSON.parse(readFileSync(join(scratch, 'portfolio.json'), 'utf8')).workItems.length, 0);
});
