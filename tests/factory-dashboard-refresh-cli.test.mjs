import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
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
  // The obstruction reaches the published artifact through the real GitHub refresh Adapter,
  // not only through the hand-fed dashboard path.
  assert.equal(snapshot.obstruction.schema, 'gaia-portfolio-drain-obstruction/1');
  assert.equal(snapshot.obstruction.effect, 'NONE');
  assert.equal(snapshot.obstruction.authority, 'NONE');
  assert.match(readFileSync(htmlPath, 'utf8'), /Gaia — real status/u);
  assert.match(readFileSync(htmlPath, 'utf8'), /Why the drain is not moving/u);
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

test('refresh refuses an unknown option instead of silently choosing a default', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-option-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', join(scratch, 'portfolio.json'),
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--langauge', 'fr',
  ], {
    surveyPortfolio: async () => portfolio([]),
  }), /unknown option: --langauge/u);
});

test('refresh refuses to replace any source evidence path', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-source-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const receiptsPath = join(scratch, 'receipts.json');
  writeFileSync(receiptsPath, '[]\n', 'utf8');

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', receiptsPath,
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--receipts', receiptsPath,
  ], {
    surveyPortfolio: async () => portfolio([]),
  }), /output path aliases an input evidence path/u);

  assert.equal(readFileSync(receiptsPath, 'utf8'), '[]\n');
});

test('Windows case aliases cannot collapse the three outputs into one file', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-case-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const artifact = join(scratch, 'artifact');

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', artifact.toLowerCase(),
    '--snapshot-out', artifact.toUpperCase(),
    '--html-out', artifact,
  ], {
    surveyPortfolio: async () => portfolio([]),
  }), /portfolio, snapshot, and HTML outputs must differ/u);
});

test('Windows admin-share aliases cannot collapse outputs onto one filesystem object', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-unc-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const localArtifact = join(scratch, 'artifact.json');
  const adminShareArtifact = `\\\\localhost\\${localArtifact[0]}$${localArtifact.slice(2)}`;

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', localArtifact,
    '--snapshot-out', adminShareArtifact,
    '--html-out', join(scratch, 'control-room.html'),
  ], {
    surveyPortfolio: async () => portfolio([]),
  }), /portfolio, snapshot, and HTML outputs must differ/u);
});

test('a path identity changed during survey refuses before any publication', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-swap-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const portfolioDirectory = join(scratch, 'portfolio');
  const snapshotDirectory = join(scratch, 'snapshot');
  const htmlDirectory = join(scratch, 'html');
  mkdirSync(portfolioDirectory);
  mkdirSync(snapshotDirectory);
  mkdirSync(htmlDirectory);
  const portfolioPath = join(portfolioDirectory, 'artifact.json');
  const snapshotPath = join(snapshotDirectory, 'artifact.json');
  const htmlPath = join(htmlDirectory, 'control-room.html');

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ], {
    surveyPortfolio: async () => {
      rmSync(snapshotDirectory, { recursive: true });
      symlinkSync(portfolioDirectory, snapshotDirectory, 'junction');
      return portfolio([]);
    },
  }), /path identities changed before publication|outputs must differ/u);

  assert.throws(() => readFileSync(portfolioPath), /ENOENT/u);
  assert.throws(() => readFileSync(htmlPath), /ENOENT/u);
});

test('a path identity changed by the clock callback cannot overwrite source evidence', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-clock-swap-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const receiptsDirectory = join(scratch, 'receipts');
  const portfolioDirectory = join(scratch, 'portfolio');
  const outputDirectory = join(scratch, 'output');
  mkdirSync(receiptsDirectory);
  mkdirSync(portfolioDirectory);
  mkdirSync(outputDirectory);
  const receiptsPath = join(receiptsDirectory, 'receipts.json');
  const portfolioPath = join(portfolioDirectory, 'receipts.json');
  const snapshotPath = join(outputDirectory, 'control-room.json');
  const htmlPath = join(outputDirectory, 'control-room.html');
  writeFileSync(receiptsPath, '[]\n', 'utf8');
  let changed = false;

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
    '--receipts', receiptsPath,
  ], {
    surveyPortfolio: async () => portfolio([]),
    now: () => {
      if (!changed) {
        changed = true;
        rmSync(portfolioDirectory, { recursive: true });
        symlinkSync(receiptsDirectory, portfolioDirectory, 'junction');
      }
      return new Date('2026-08-29T20:00:00.000Z');
    },
  }), /path identities changed before publication|aliases an input evidence path/u);

  assert.equal(readFileSync(receiptsPath, 'utf8'), '[]\n');
  assert.throws(() => readFileSync(htmlPath), /ENOENT/u);
});

test('an abort raised by the clock callback prevents every publication', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-clock-abort-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const controller = new AbortController();
  const portfolioPath = join(scratch, 'portfolio.json');
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ], {
    signal: controller.signal,
    surveyPortfolio: async () => portfolio([]),
    now: () => {
      controller.abort();
      return new Date('2026-08-29T20:00:00.000Z');
    },
  }), (error) => error?.name === 'AbortError');

  assert.throws(() => readFileSync(portfolioPath), /ENOENT/u);
  assert.throws(() => readFileSync(snapshotPath), /ENOENT/u);
  assert.throws(() => readFileSync(htmlPath), /ENOENT/u);
});

test('a pre-aborted watch performs no GitHub survey and publishes nothing', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-pre-abort-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  let surveys = 0;

  await runFactoryDashboardRefreshLoop([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', join(scratch, 'portfolio.json'),
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--watch-ms', '10000',
  ], {
    signal: controller.signal,
    surveyPortfolio: async () => { surveys += 1; return portfolio([]); },
    writeStdout: () => {},
  });

  assert.equal(surveys, 0);
  assert.throws(() => readFileSync(join(scratch, 'control-room.html')), /ENOENT/u);
});

test('aborting an active survey returns promptly and cannot publish its late result', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-survey-abort-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const controller = new AbortController();
  let surveyStarted;
  const started = new Promise((resolveStarted) => { surveyStarted = resolveStarted; });
  const startedAt = Date.now();

  const run = runFactoryDashboardRefreshLoop([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', join(scratch, 'portfolio.json'),
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--watch-ms', '10000',
  ], {
    signal: controller.signal,
    surveyPortfolio: async () => {
      surveyStarted();
      await new Promise((resolveSurvey) => { setTimeout(resolveSurvey, 350); });
      return portfolio([]);
    },
    writeStdout: () => {},
  });
  await started;
  controller.abort();
  await run;

  assert.ok(Date.now() - startedAt < 200, 'abort should interrupt an active survey');
  assert.throws(() => readFileSync(join(scratch, 'control-room.html')), /ENOENT/u);
  await new Promise((resolveDelay) => { setTimeout(resolveDelay, 400); });
  assert.throws(() => readFileSync(join(scratch, 'control-room.html')), /ENOENT/u);
});

test('aborting a real watch wait stops promptly instead of sleeping through the interval', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-abort-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const controller = new AbortController();
  const startedAt = Date.now();
  const handle = setTimeout(() => controller.abort(), 25);

  await runFactoryDashboardRefreshLoop([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', join(scratch, 'portfolio.json'),
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--watch-ms', '10000',
  ], {
    signal: controller.signal,
    surveyPortfolio: async () => portfolio([]),
    writeStdout: () => {},
  });
  clearTimeout(handle);

  assert.ok(Date.now() - startedAt < 1_000, 'abort should interrupt the 10-second wait');
});
