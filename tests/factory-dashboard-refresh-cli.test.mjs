import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  runFactoryDashboardRefreshCli, runFactoryDashboardRefreshLoop,
} from '../scripts/factory-dashboard-refresh.mjs';
import { renderControlRoomHtml } from '../src/control-room.mjs';

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

/**
 * R1 blocker 4 — the refresh observation window.
 *
 * Every tick surveys GitHub and writes a brand-new staged portfolio, so the staged file's mtime is
 * the survey time and says nothing whatever about when the evidence changed. R0 measured the
 * window from that mtime, which reset it to a few milliseconds on every tick: `THROUGHPUT_STALL`
 * was unreachable in the one adapter that actually surveys GitHub, the headline silently degraded
 * to the pre-change sentence, and the displayed evidence age was always `0s`.
 *
 * The window is now the interval over which this publisher has continuously observed this exact
 * content-addressed projection revision, carried forward in the snapshot the command itself
 * published. These ticks drive the public seam and move nothing but the injected clock.
 */
function refreshArgv(portfolioPath, snapshotPath, htmlPath) {
  return [
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ];
}

const READY_ISSUE = Object.freeze({
  repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
  itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
  updatedAt: '2026-08-29T18:00:00.000Z',
});

test('unchanged evidence keeps its observation window across refresh ticks until a stall is measurable', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-window-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const portfolioPath = join(scratch, 'portfolio.json');
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');
  let clockMs = Date.parse('2026-08-29T20:00:00.000Z');
  let surveyed = portfolio([READY_ISSUE]);
  const tick = () => runFactoryDashboardRefreshCli(
    refreshArgv(portfolioPath, snapshotPath, htmlPath),
    {
      now: () => new Date(clockMs),
      surveyPortfolio: async () => surveyed,
      writeStdout: () => {},
    },
  );

  const first = await tick();
  assert.equal(first.sourceChangedAt, '2026-08-29T20:00:00.000Z');
  assert.equal(first.obstruction.observationWindow.durationMs, 0);
  assert.equal(first.obstruction.state, 'NONE', 'nothing has yet been observed sitting still');

  clockMs += 120_000;
  const second = await tick();
  assert.equal(second.sourceRevision, first.sourceRevision);
  assert.equal(
    second.sourceChangedAt, first.sourceChangedAt,
    'a re-survey that produces the same projection revision is not a change in the evidence',
  );
  assert.equal(second.obstruction.observationWindow.durationMs, 120_000);
  assert.equal(second.obstruction.state, 'NONE', 'below the threshold no stall is claimed');

  clockMs += 181_000;
  const third = await tick();
  assert.equal(third.obstruction.observationWindow.durationMs, 301_000);
  assert.equal(
    third.obstruction.state, 'THROUGHPUT_STALL',
    'the state R0 could never reach through the real GitHub refresh adapter',
  );
  assert.equal(third.obstruction.recovery.kind, 'CLAIM_QUEUED_WORK');
  assert.deepEqual(third.obstruction.affectedItemIds, ['issue-290']);
  assert.match(
    third.headline.detail, /1 eligible item and free capacity have not moved for 5m 1s\./u,
    'the headline states the measured window instead of degrading to the pre-change sentence',
  );
  assert.match(readFileSync(htmlPath, 'utf8'), /Throughput stalled/u);

  // The carrier is the published artifact and nothing else, which is what makes an ordinary
  // process restart resume the window: a restarted process reads exactly these bytes.
  assert.equal(
    JSON.parse(readFileSync(snapshotPath, 'utf8')).sourceChangedAt, first.sourceChangedAt,
  );

  // A changed revision resets the window exactly, and never carries a measurement across it.
  surveyed = portfolio([READY_ISSUE, {
    ...READY_ISSUE, itemId: 'issue-291', itemNumber: 291, title: 'A second ready issue',
  }]);
  clockMs += 60_000;
  const fourth = await tick();
  assert.notEqual(fourth.sourceRevision, third.sourceRevision);
  assert.equal(fourth.sourceChangedAt, new Date(clockMs).toISOString());
  assert.equal(fourth.obstruction.observationWindow.durationMs, 0);
  assert.equal(fourth.obstruction.state, 'NONE', 'a fresh revision restarts the measurement');

  // A published snapshot this publisher can no longer read is "no prior observation", which
  // restarts the window rather than inventing one.
  rmSync(snapshotPath);
  clockMs += 400_000;
  const afterLoss = await tick();
  assert.equal(afterLoss.sourceChangedAt, new Date(clockMs).toISOString());
  assert.equal(afterLoss.obstruction.observationWindow.durationMs, 0);
});

test('NEGATIVE CONTROL: the refresh adapter never reads a staged temp-file mtime as evidence age', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-mtime-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const portfolioPath = join(scratch, 'portfolio.json');
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');
  const observedAt = '2026-08-29T20:00:00.000Z';

  const published = await runFactoryDashboardRefreshCli(
    refreshArgv(portfolioPath, snapshotPath, htmlPath),
    {
      now: () => new Date(observedAt),
      surveyPortfolio: async () => portfolio([READY_ISSUE]),
      writeStdout: () => {},
    },
  );

  // The staged portfolio was written at the real wall-clock instant of this test run, which is
  // years away from the injected observation instant. Under R0 that mtime decided the window and
  // this call either produced a 0 ms window or, once the clamp was removed, refused outright.
  assert.equal(published.sourceChangedAt, observedAt);
  assert.equal(published.observedAt, observedAt);
  assert.equal(published.obstruction.observationWindow.startedAt, observedAt);
  assert.equal(published.obstruction.observationWindow.endedAt, observedAt);
});

test('NEGATIVE CONTROL: a clock running backwards refuses the tick and preserves the last artifacts', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-backwards-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const portfolioPath = join(scratch, 'portfolio.json');
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');
  const argv = refreshArgv(portfolioPath, snapshotPath, htmlPath);
  const surveyPortfolio = async () => portfolio([READY_ISSUE]);

  await runFactoryDashboardRefreshCli(argv, {
    now: () => new Date('2026-08-29T20:00:00.000Z'), surveyPortfolio, writeStdout: () => {},
  });
  const published = [portfolioPath, snapshotPath, htmlPath].map(
    (path) => readFileSync(path, 'utf8'),
  );

  await assert.rejects(
    runFactoryDashboardRefreshCli(argv, {
      now: () => new Date('2026-08-29T19:59:00.000Z'), surveyPortfolio, writeStdout: () => {},
    }),
    (error) => {
      assert.equal(error.name, 'ControlRoomError');
      assert.equal(error.code, 'IncoherentEvidence');
      assert.match(error.message, /after the instant it was observed/u);
      return true;
    },
  );

  assert.deepEqual(
    [portfolioPath, snapshotPath, htmlPath].map((path) => readFileSync(path, 'utf8')),
    published,
    'a refused tick leaves the previous complete artifact set byte-identical',
  );
});

/**
 * Mechanism-revert witnesses for the refresh observation window.
 *
 * Each takes the shipped adapter, changes exactly one load-bearing line in a copy written outside
 * this repository, and asserts the ticks above notice. Relative specifiers are rewritten to
 * absolute file URLs so the mutant loads the same unmodified modules the original does; nothing
 * inside the repository is written.
 */
const REFRESH_PATH = fileURLToPath(new URL('../scripts/factory-dashboard-refresh.mjs', import.meta.url));
const SCRIPTS_URL = new URL('../scripts/', import.meta.url).href;
const mutantScratch = mkdtempSync(join(tmpdir(), 'gaia-refresh-mutant-'));
test.after(() => rmSync(mutantScratch, { recursive: true, force: true }));

async function importRefreshMutant(name, find, replace) {
  const source = readFileSync(REFRESH_PATH, 'utf8');
  assert.equal(
    source.includes(find), true,
    `the mechanism-revert witness targets "${find}", which is no longer in the source`,
  );
  const mutated = source
    .replace(find, replace)
    .replaceAll("from '../src/", `from '${SCRIPTS_URL}../src/`)
    .replaceAll("from './", `from '${SCRIPTS_URL}`);
  assert.notEqual(mutated, source);
  const path = join(mutantScratch, `${name}.mjs`);
  writeFileSync(path, mutated, 'utf8');
  return import(pathToFileURL(path).href);
}

test('MECHANISM REVERT: carrying the first observation forward is what makes a stall reachable', async (t) => {
  const mutant = await importRefreshMutant(
    'no-continuity',
    'firstObservationOf(snapshotPath, projectionRevision) ?? observedAt',
    'observedAt',
  );
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-refresh-no-continuity-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const paths = ['portfolio.json', 'control-room.json', 'control-room.html']
    .map((name) => join(scratch, name));
  let clockMs = Date.parse('2026-08-29T20:00:00.000Z');
  const options = {
    now: () => new Date(clockMs),
    surveyPortfolio: async () => portfolio([READY_ISSUE]),
    writeStdout: () => {},
  };

  await mutant.runFactoryDashboardRefreshCli(refreshArgv(...paths), options);
  clockMs += 3_600_000;
  const later = await mutant.runFactoryDashboardRefreshCli(refreshArgv(...paths), options);

  assert.equal(
    later.obstruction.observationWindow.durationMs, 0,
    'reverting the continuity restores the R0 defect: every tick restarts the window',
  );
  assert.equal(later.obstruction.state, 'NONE');
  assert.equal(
    later.headline.detail, 'No tracked factory run is moving right now.',
    'and the headline degrades to the exact pre-change sentence this work exists to replace',
  );
});

/**
 * R2 blocker A, in the adapter this repair lane exists for.
 *
 * `factory:dashboard:refresh` surveys real GitHub and writes a brand-new staged portfolio on
 * every tick, so its window start comes from the control-room snapshot it published last time and
 * from nothing else. R1 read that file with a bare `JSON.parse`: one unsealed edit of its
 * `sourceChangedAt` — a file `renderControlRoomHtml` itself refuses — bought a `THROUGHPUT_STALL`
 * measured in years over evidence observed for thirty seconds, laundered into a freshly sealed,
 * fully renderable artifact set. The carrier is now verified with the same total verifier the
 * render seam applies to those exact bytes, and an unverifiable carrier is no prior observation.
 */
test('the refresh adapter refuses a tampered continuity carrier rather than inventing a stall', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-carrier-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const portfolioPath = join(scratch, 'portfolio.json');
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');
  const surveyed = portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  }]);
  const argv = [
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ];
  const tick = (observedAt) => runFactoryDashboardRefreshCli(argv, {
    now: () => new Date(observedAt),
    surveyPortfolio: async () => surveyed,
    writeStdout: () => {},
  });

  // Tick 1: this revision is new to this publisher, so the window starts now and the published
  // body says the start is not evidence of earlier observation.
  const first = await tick('2026-08-29T20:00:00.000Z');
  assert.equal(first.sourceChangedAt, '2026-08-29T20:00:00.000Z');
  assert.equal(first.obstruction.observationWindow.durationMs, 0);
  assert.equal(first.obstruction.state, 'NONE');
  assert.equal(first.sourceChangedAtBasis, 'UNOBSERVED');
  assert.match(readFileSync(htmlPath, 'utf8'), /Not yet measured/u);

  // Tick 2: the carrier verifies, so continuity holds and the window is now genuinely measured.
  const second = await tick('2026-08-29T20:00:30.000Z');
  assert.equal(second.sourceChangedAt, '2026-08-29T20:00:00.000Z');
  assert.equal(second.obstruction.observationWindow.durationMs, 30_000);
  assert.equal(second.sourceChangedAtBasis, 'MEASURED');

  // One field, edited and NOT resealed — the exact coordinator replay witness.
  const tampered = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  tampered.sourceChangedAt = '2020-01-01T00:00:00.000Z';
  writeFileSync(snapshotPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  assert.throws(
    () => renderControlRoomHtml(tampered), /revision/u,
    'the render seam refuses the tampered carrier, so the adapter has a verifier available',
  );

  const third = await tick('2026-08-29T20:01:00.000Z');
  assert.notEqual(
    third.sourceChangedAt, '2020-01-01T00:00:00.000Z',
    'an unverifiable carrier must never become the window start of a published snapshot',
  );
  assert.equal(third.sourceChangedAt, '2026-08-29T20:01:00.000Z');
  assert.equal(third.obstruction.observationWindow.durationMs, 0);
  assert.equal(
    third.obstruction.state, 'NONE',
    'no stall is invented; the window restarts, which only ever delays a stall',
  );
  assert.equal(third.sourceChangedAtBasis, 'UNOBSERVED');

  // POSITIVE CONTROL: continuity resumes from the freshly published, verifiable carrier, so the
  // repair verifies the carrier rather than abandoning the mechanism blocker 4 delivered.
  const fourth = await tick('2026-08-29T20:06:30.000Z');
  assert.equal(fourth.sourceChangedAt, '2026-08-29T20:01:00.000Z');
  assert.equal(fourth.obstruction.observationWindow.durationMs, 330_000);
  assert.equal(fourth.obstruction.state, 'THROUGHPUT_STALL');
  assert.equal(fourth.sourceChangedAtBasis, 'MEASURED');
  assert.match(readFileSync(htmlPath, 'utf8'), /Throughput stalled/u);
});

// -----------------------------------------------------------------------------------------------
// Hosted Draft pump observation on the refresh path (issue #70, bullet 7).
//
// The refresh adapter is the one an operator actually runs for a hosted fact, and it currently
// forwards only `pr-review-thread-gate` among the optional evidence blocks. A pump block added to
// factory-dashboard.mjs alone would be invisible here, which is precisely where the bug would not
// be noticed. Both gates below therefore assert the forwarding, not the derivation.
// -----------------------------------------------------------------------------------------------

function hostedDraftPumpArtifact() {
  const body = {
    schema: 'gaia-hosted-draft-pump/1',
    effect: 'NONE',
    authority: 'NONE',
    observedAt: '2026-08-29T19:50:00.000Z',
    windowStartedAt: '2026-08-29T18:50:00.000Z',
    sequence: 41,
    repository: 'GuitarAlchemist/gaia',
    repositoryNodeId: 'R_kgDOT3lpUg',
    ledgerRootOid: '1'.repeat(40),
    ledgerRootRevision: '2'.repeat(64),
    transition: {
      tickAt: '2026-08-29T19:49:02.000Z',
      trigger: 'SCHEDULED_RECOVERY',
      outcome: 'EXPECTED_NONE',
      effect: 'NONE',
      operationId: null,
      workKey: null,
      generationKey: null,
      committedRevision: null,
      observedSourceRevision: 'f'.repeat(64),
      workItem: null,
      pullRequest: null,
      blocker: 'NONE',
    },
    unsettledCount: 0,
  };
  return { ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

test('refresh accepts --hosted-draft-pump rather than refusing it as an unknown option', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-pump-option-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const pumpPath = join(scratch, 'hosted-draft-pump.json');
  writeFileSync(pumpPath, JSON.stringify(hostedDraftPumpArtifact()), 'utf8');

  await runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', join(scratch, 'portfolio.json'),
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--hosted-draft-pump', pumpPath,
  ], {
    now: () => new Date('2026-08-29T20:00:00.000Z'),
    surveyPortfolio: async () => portfolio([]),
    writeStdout: () => {},
  });
});

test('the hosted pump block reaches the published snapshot through the GitHub refresh adapter', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-pump-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const snapshotPath = join(scratch, 'control-room.json');
  const htmlPath = join(scratch, 'control-room.html');
  const pumpPath = join(scratch, 'hosted-draft-pump.json');
  writeFileSync(pumpPath, JSON.stringify(hostedDraftPumpArtifact()), 'utf8');

  const snapshot = await runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', join(scratch, 'portfolio.json'),
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
    '--hosted-draft-pump', pumpPath,
  ], {
    now: () => new Date('2026-08-29T20:00:00.000Z'),
    surveyPortfolio: async () => portfolio([]),
    writeStdout: () => {},
  });

  assert.notEqual(snapshot.hostedDraftPump, undefined,
    '--hosted-draft-pump must be forwarded by the refresh adapter, not silently dropped');
  assert.equal(snapshot.hostedDraftPump.source, 'GAIA_HOSTED_DRAFT_PUMP');
  // A scheduled tick that correctly admitted nothing is the healthiest possible reading, and it
  // must be distinguishable from a pump that never ran.
  assert.equal(snapshot.hostedDraftPump.state, 'EXPECTED_NONE');
  assert.equal(snapshot.hostedDraftPump.trigger, 'SCHEDULED_RECOVERY');
  assert.equal(snapshot.hostedDraftPump.operationId, null);
  assert.match(readFileSync(htmlPath, 'utf8'), /data-state="EXPECTED_NONE"/u);
});

test('the refresh adapter refuses a pump evidence path that aliases one of its outputs', async (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-pump-alias-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const pumpPath = join(scratch, 'hosted-draft-pump.json');
  writeFileSync(pumpPath, JSON.stringify(hostedDraftPumpArtifact()), 'utf8');

  await assert.rejects(runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', pumpPath,
    '--snapshot-out', join(scratch, 'control-room.json'),
    '--html-out', join(scratch, 'control-room.html'),
    '--hosted-draft-pump', pumpPath,
  ], {
    surveyPortfolio: async () => portfolio([]),
  }), /output path aliases an input evidence path/u);

  assert.deepEqual(JSON.parse(readFileSync(pumpPath, 'utf8')), hostedDraftPumpArtifact());
});
