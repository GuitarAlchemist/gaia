import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import { runFactoryDashboardRefreshCli } from '../scripts/factory-dashboard-refresh.mjs';
import { summarizeControlRoomActivity } from '../src/control-room-activity.mjs';
import { renderControlRoomHtml } from '../src/control-room.mjs';

const DASHBOARD_PATH = fileURLToPath(new URL('../scripts/factory-dashboard.mjs', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-cli-'));
const mutantScratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-cli-mutant-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
test.after(() => rmSync(mutantScratch, { recursive: true, force: true }));

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

function projection(value) {
  return {
    ...value,
    revision: createHash('sha256').update(canonicalJson(value)).digest('hex'),
  };
}

test('the dashboard CLI turns the drain projection and real progress JSONL into shareable artifacts', () => {
  const projectionPath = join(scratch, 'projection.json');
  const progressPath = join(scratch, 'progress.jsonl');
  const htmlPath = join(scratch, 'control-room.html');
  const snapshotPath = join(scratch, 'control-room.json');
  writeFileSync(projectionPath, `${JSON.stringify(projection({
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: 'a'.repeat(64),
    effect: 'NONE', authority: 'NONE', capacity: 4,
    counts: { occupied: 1, available: 3 },
    items: [{
      repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE', itemId: 'issue-17',
      itemNumber: 17, title: 'Integrate the factory control room', sourceState: 'READY',
      observedPortfolioRevision: 'a'.repeat(64), drainState: 'RUNNING', hold: null,
    }],
    decisions: [],
  }))}\n`, 'utf8');
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

test('the dashboard CLI refuses multiple raw progress lines with one shared file timestamp', () => {
  const projectionPath = join(scratch, 'ambiguous-projection.json');
  const progressPath = join(scratch, 'ambiguous-progress.jsonl');
  const htmlPath = join(scratch, 'ambiguous-control-room.html');
  const snapshotPath = join(scratch, 'ambiguous-control-room.json');
  writeFileSync(projectionPath, `${JSON.stringify(projection({
    schema: 'gaia-portfolio-drain-projection/1', portfolioRevision: 'a'.repeat(64),
    effect: 'NONE', authority: 'NONE', capacity: 4,
    counts: { occupied: 1, available: 3 },
    items: [{
      repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE', itemId: 'issue-17',
      itemNumber: 17, title: 'Integrate the factory control room', sourceState: 'READY',
      observedPortfolioRevision: 'a'.repeat(64), drainState: 'RUNNING', hold: null,
    }],
    decisions: [],
  }))}\n`, 'utf8');
  const record = {
    schema: 'gaia-cli-progress/1', stage: 'worker_running', elapsedMs: 35_000, heartbeat: true,
  };
  writeFileSync(progressPath, `${JSON.stringify(record)}\n${JSON.stringify({
    ...record, elapsedMs: 40_000,
  })}\n`, 'utf8');

  assert.throws(() => runFactoryDashboardCli([
    '--projection', projectionPath, '--progress', progressPath,
    '--html-out', htmlPath, '--snapshot-out', snapshotPath,
  ]), /multiple raw progress records are ambiguous/u);
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
  // Pin the evidence mtime. Evidence dated after the observation instant is now a typed
  // refusal, so a fixture that leaves the file's real mtime in place tests the machine clock.
  const changedAt = new Date('2026-08-29T18:30:00.000Z');
  utimesSync(portfolioPath, changedAt, changedAt);
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

test('the dashboard CLI says why a paused drain is not moving, and offers one bounded recovery', () => {
  const portfolioPath = join(scratch, 'blocked-portfolio.json');
  const htmlPath = join(scratch, 'blocked-control-room.html');
  const snapshotPath = join(scratch, 'blocked-control-room.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'PULL_REQUEST', itemId: 'pr-41',
    itemNumber: 41, title: 'Awaiting check evidence', state: 'CHECKS_UNKNOWN',
    updatedAt: '2026-08-29T18:00:00.000Z',
  }]))}\n`, 'utf8');
  const changedAt = new Date('2026-08-29T18:30:00.000Z');
  utimesSync(portfolioPath, changedAt, changedAt);
  let stdout = '';

  const snapshot = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--html-out', htmlPath,
    '--snapshot-out', snapshotPath,
  ], {
    now: () => new Date('2026-08-29T18:40:20.000Z'),
    writeStdout: (chunk) => { stdout += chunk; },
  });

  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.obstruction.state, 'EVIDENCE_STARVATION');
  assert.deepEqual(snapshot.obstruction.affectedItemIds, ['pr-41']);
  assert.equal(snapshot.obstruction.recovery.kind, 'COLLECT_MISSING_EVIDENCE');
  assert.equal(snapshot.obstruction.observationWindow.durationMs, 620_000);
  assert.match(stdout, /EVIDENCE_STARVATION/u);
  assert.match(readFileSync(htmlPath, 'utf8'), /Why the drain is not moving/u);
});

test('the dashboard CLI distinguishes an empty drain from a blocked one', () => {
  const portfolioPath = join(scratch, 'empty-portfolio.json');
  const htmlPath = join(scratch, 'empty-control-room.html');
  const snapshotPath = join(scratch, 'empty-control-room.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([]))}\n`, 'utf8');
  // Pin the evidence mtime. Evidence dated after the observation instant is now a typed
  // refusal, so a fixture that leaves the file's real mtime in place tests the machine clock.
  const changedAt = new Date('2026-08-29T18:30:00.000Z');
  utimesSync(portfolioPath, changedAt, changedAt);
  let stdout = '';

  const snapshot = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--html-out', htmlPath,
    '--snapshot-out', snapshotPath,
  ], {
    now: () => new Date('2026-08-29T18:40:20.000Z'),
    writeStdout: (chunk) => { stdout += chunk; },
  });

  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.obstruction.state, 'NO_ELIGIBLE_WORK');
  assert.equal(snapshot.obstruction.recovery.kind, 'SURVEY_PORTFOLIO_FOR_NEW_WORK');
  assert.match(stdout, /NO_ELIGIBLE_WORK/u);
});

test('the dashboard CLI reports a deadlock only from a declared dependency file', () => {
  const portfolioPath = join(scratch, 'cycle-portfolio.json');
  const dependenciesPath = join(scratch, 'cycle-dependencies.json');
  const htmlPath = join(scratch, 'cycle-control-room.html');
  const snapshotPath = join(scratch, 'cycle-control-room.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([
    {
      repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-1', itemNumber: 1,
      title: 'Blocked by issue-2', state: 'READY', updatedAt: '2026-08-29T18:00:00.000Z',
    },
    {
      repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE', itemId: 'issue-2', itemNumber: 2,
      title: 'Blocked by issue-1', state: 'READY', updatedAt: '2026-08-29T18:00:00.000Z',
    },
  ]))}\n`, 'utf8');
  writeFileSync(dependenciesPath, `${JSON.stringify({
    evidenceRevision: 'b'.repeat(64),
    edges: [
      { itemId: 'issue-1', dependsOnItemId: 'issue-2' },
      { itemId: 'issue-2', dependsOnItemId: 'issue-1' },
    ],
  })}\n`, 'utf8');
  const changedAt = new Date('2026-08-29T18:30:00.000Z');
  utimesSync(portfolioPath, changedAt, changedAt);
  utimesSync(dependenciesPath, changedAt, changedAt);
  const options = {
    now: () => new Date('2026-08-29T18:40:20.000Z'),
    writeStdout: () => {},
  };

  const declared = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--dependencies', dependenciesPath,
    '--html-out', htmlPath,
    '--snapshot-out', snapshotPath,
  ], options);
  const proseOnly = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--html-out', htmlPath,
    '--snapshot-out', snapshotPath,
  ], options);

  assert.equal(declared.obstruction.state, 'DEPENDENCY_DEADLOCK');
  assert.deepEqual(declared.obstruction.affectedItemIds, ['issue-1', 'issue-2']);
  assert.equal(declared.obstruction.dependencyEvidenceRevision, 'b'.repeat(64));
  assert.equal(
    proseOnly.obstruction.state, 'THROUGHPUT_STALL',
    'the identical titles are never read as dependencies',
  );
});

test('the dashboard CLI refuses declared edges that name an item the portfolio does not carry', () => {
  const portfolioPath = join(scratch, 'absent-portfolio.json');
  const dependenciesPath = join(scratch, 'absent-dependencies.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-1', itemNumber: 1,
    title: 'Repair a ready issue', state: 'READY', updatedAt: '2026-08-29T18:00:00.000Z',
  }]))}\n`, 'utf8');
  writeFileSync(dependenciesPath, `${JSON.stringify({
    evidenceRevision: 'b'.repeat(64),
    edges: [{ itemId: 'issue-1', dependsOnItemId: 'issue-absent' }],
  })}\n`, 'utf8');

  // Pin the evidence mtime. Evidence dated after the observation instant is now a typed
  // refusal, so a fixture that leaves the file's real mtime in place tests the machine clock.
  const changedAt = new Date('2026-08-29T18:30:00.000Z');
  utimesSync(portfolioPath, changedAt, changedAt);
  utimesSync(dependenciesPath, changedAt, changedAt);
  assert.throws(() => runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--dependencies', dependenciesPath,
    '--html-out', join(scratch, 'absent-control-room.html'),
    '--snapshot-out', join(scratch, 'absent-control-room.json'),
  ], { now: () => new Date('2026-08-29T18:40:20.000Z'), writeStdout: () => {} }),
  /does not carry/u);
});

/**
 * R1 blocker 4, file-fed path. The observation window is the interval over which this publisher
 * has continuously observed this exact projection revision, so its own previous publication is
 * the strongest evidence it has: a byte-identical rewrite of an input moves the mtime but changes
 * no evidence, and must not restart the window.
 */
test('a rewritten input that changes no evidence keeps the observation window, a changed one resets it', () => {
  const portfolioPath = join(scratch, 'continuity-portfolio.json');
  const htmlPath = join(scratch, 'continuity-control-room.html');
  const snapshotPath = join(scratch, 'continuity-control-room.json');
  const write = (workItems, mtime) => {
    writeFileSync(portfolioPath, `${JSON.stringify(portfolio(workItems))}\n`, 'utf8');
    utimesSync(portfolioPath, new Date(mtime), new Date(mtime));
  };
  const ready = {
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  };
  const render = (observedAt) => runFactoryDashboardCli([
    '--portfolio', portfolioPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
  ], { now: () => new Date(observedAt), writeStdout: () => {} });

  write([ready], '2026-08-29T18:00:00.000Z');
  const first = render('2026-08-29T18:01:00.000Z');
  // Same evidence, rewritten byte-identically five minutes later: the mtime moved, nothing else.
  write([ready], '2026-08-29T18:06:00.000Z');
  const rewritten = render('2026-08-29T18:07:00.000Z');
  // Genuinely different evidence.
  write([ready, { ...ready, itemId: 'issue-291', itemNumber: 291 }], '2026-08-29T18:06:00.000Z');
  const changed = render('2026-08-29T18:08:00.000Z');

  assert.equal(first.sourceChangedAt, '2026-08-29T18:00:00.000Z');
  assert.equal(first.obstruction.observationWindow.durationMs, 60_000);
  assert.equal(rewritten.sourceRevision, first.sourceRevision);
  assert.equal(
    rewritten.sourceChangedAt, '2026-08-29T18:00:00.000Z',
    'a moved mtime over an unchanged revision is not a change in the evidence',
  );
  assert.equal(rewritten.obstruction.observationWindow.durationMs, 420_000);
  assert.equal(rewritten.obstruction.state, 'THROUGHPUT_STALL');
  assert.notEqual(changed.sourceRevision, first.sourceRevision);
  assert.equal(
    changed.sourceChangedAt, '2026-08-29T18:06:00.000Z',
    'changed evidence restarts from the mtime it can show, never from the carried instant',
  );
  assert.equal(changed.obstruction.observationWindow.durationMs, 120_000);
  assert.equal(changed.obstruction.state, 'NONE');
});

/**
 * An input mtime after the observation instant shows nothing about how long this revision has
 * been in force, so the adapter declines to assert it rather than measuring from it. This is a
 * decision about what evidence the adapter *has*, taken before any measurement: the control-room
 * seam still refuses outright any caller that hands it evidence dated after its observation, and
 * `tests/control-room.test.mjs` holds that refusal. Disclosed as an R1 correction in
 * `docs/portfolio-drain-obstruction-design.md`.
 */
test('an input mtime after the observation instant is not usable evidence of earlier observation', () => {
  const portfolioPath = join(scratch, 'future-mtime-portfolio.json');
  const htmlPath = join(scratch, 'future-mtime-control-room.html');
  const snapshotPath = join(scratch, 'future-mtime-control-room.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  }]))}\n`, 'utf8');
  const ahead = new Date('2026-08-29T19:00:00.000Z');
  utimesSync(portfolioPath, ahead, ahead);
  const render = (observedAt) => runFactoryDashboardCli([
    '--portfolio', portfolioPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
  ], { now: () => new Date(observedAt), writeStdout: () => {} });

  const first = render('2026-08-29T18:01:00.000Z');
  const later = render('2026-08-29T18:07:00.000Z');

  assert.equal(first.sourceChangedAt, '2026-08-29T18:01:00.000Z');
  assert.equal(
    first.obstruction.observationWindow.durationMs, 0,
    'zero observed duration so far, which is what "no obstruction detectable yet" means',
  );
  assert.equal(first.obstruction.state, 'NONE');
  assert.equal(
    later.sourceChangedAt, '2026-08-29T18:01:00.000Z',
    'and the window then grows from there, so a stall is reachable under a skewed clock',
  );
  assert.equal(later.obstruction.observationWindow.durationMs, 360_000);
  assert.equal(later.obstruction.state, 'THROUGHPUT_STALL');
});

test('MECHANISM REVERT: the revision guard is what stops a window crossing changed evidence', async () => {
  const source = readFileSync(DASHBOARD_PATH, 'utf8');
  const find = '      || published.sourceRevision !== projectionRevision';
  assert.equal(
    source.includes(find), true,
    `the mechanism-revert witness targets "${find}", which is no longer in the source`,
  );
  const mutated = source.replace(find, '      || false')
    .replaceAll("from '../src/", `from '${new URL('../scripts/', import.meta.url).href}../src/`);
  assert.notEqual(mutated, source);
  const mutantPath = join(mutantScratch, 'no-revision-guard.mjs');
  writeFileSync(mutantPath, mutated, 'utf8');
  const mutant = await import(pathToFileURL(mutantPath).href);

  const portfolioPath = join(scratch, 'guard-portfolio.json');
  const htmlPath = join(scratch, 'guard-control-room.html');
  const snapshotPath = join(scratch, 'guard-control-room.json');
  const ready = {
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  };
  const write = (workItems, mtime) => {
    writeFileSync(portfolioPath, `${JSON.stringify(portfolio(workItems))}\n`, 'utf8');
    utimesSync(portfolioPath, new Date(mtime), new Date(mtime));
  };
  const argv = [
    '--portfolio', portfolioPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
  ];
  const options = (observedAt) => ({
    now: () => new Date(observedAt), writeStdout: () => {},
  });

  write([ready], '2026-08-29T18:00:00.000Z');
  mutant.runFactoryDashboardCli(argv, options('2026-08-29T18:05:00.000Z'));
  write([ready, { ...ready, itemId: 'issue-291', itemNumber: 291 }], '2026-08-29T18:04:00.000Z');
  const mutantChanged = mutant.runFactoryDashboardCli(argv, options('2026-08-29T18:05:30.000Z'));

  assert.equal(
    mutantChanged.sourceChangedAt, '2026-08-29T18:00:00.000Z',
    'without the guard the mutant carries a window across evidence that provably changed',
  );
  assert.equal(
    mutantChanged.obstruction.state, 'THROUGHPUT_STALL',
    'and claims a measured stall over evidence it observed for the first time this render',
  );

  write([ready], '2026-08-29T18:00:00.000Z');
  runFactoryDashboardCli(argv, options('2026-08-29T18:05:00.000Z'));
  write([ready, { ...ready, itemId: 'issue-291', itemNumber: 291 }], '2026-08-29T18:04:00.000Z');
  const shipped = runFactoryDashboardCli(argv, options('2026-08-29T18:05:30.000Z'));

  assert.equal(shipped.sourceChangedAt, '2026-08-29T18:04:00.000Z');
  assert.equal(shipped.obstruction.observationWindow.durationMs, 90_000);
  assert.equal(shipped.obstruction.state, 'NONE');
});

/**
 * R2 blocker A — the continuity carrier is evidence, so it is verified rather than trusted.
 *
 * R1 read the previously published snapshot with a bare `JSON.parse` and three shallow field
 * checks, then carried its `sourceChangedAt` forward. One unsealed edit of that field — a file
 * `renderControlRoomHtml` itself refuses — bought a `THROUGHPUT_STALL` measured in years over
 * evidence this publisher had observed for seconds, laundered into a freshly sealed snapshot that
 * then rendered. Every other window mechanism here fails toward "no obstruction detectable yet";
 * this one failed toward a confidently asserted stall.
 */
test('a published carrier the render seam refuses is not a first observation', () => {
  const portfolioPath = join(scratch, 'carrier-portfolio.json');
  const htmlPath = join(scratch, 'carrier-control-room.html');
  const snapshotPath = join(scratch, 'carrier-control-room.json');
  const ready = {
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  };
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([ready]))}\n`, 'utf8');
  const mtime = new Date('2026-08-29T18:00:00.000Z');
  utimesSync(portfolioPath, mtime, mtime);
  const render = (observedAt) => runFactoryDashboardCli([
    '--portfolio', portfolioPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
  ], { now: () => new Date(observedAt), writeStdout: () => {} });

  const first = render('2026-08-29T18:00:30.000Z');
  assert.equal(first.obstruction.observationWindow.durationMs, 30_000);
  assert.equal(first.obstruction.state, 'NONE');

  // One field, edited and NOT resealed. The repository's own render seam already refuses this
  // exact byte sequence; the adapter that reads it must not be more credulous than the renderer.
  const tampered = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  tampered.sourceChangedAt = '2020-01-01T00:00:00.000Z';
  writeFileSync(snapshotPath, `${JSON.stringify(tampered, null, 2)}\n`, 'utf8');
  assert.throws(
    () => renderControlRoomHtml(tampered), /revision/u,
    'the render seam refuses the tampered carrier, so the adapter has a verifier available',
  );

  const afterTamper = render('2026-08-29T18:01:00.000Z');
  assert.notEqual(
    afterTamper.sourceChangedAt, '2020-01-01T00:00:00.000Z',
    'an unverifiable carrier is no prior observation; it must never become the window start',
  );
  assert.equal(
    afterTamper.sourceChangedAt, '2026-08-29T18:00:00.000Z',
    'the window falls back to the mtime it can actually show',
  );
  assert.equal(afterTamper.obstruction.observationWindow.durationMs, 60_000);
  assert.equal(
    afterTamper.obstruction.state, 'NONE',
    'and no stall is invented from evidence this publisher observed for sixty seconds',
  );

  // POSITIVE CONTROL: an untouched carrier this publisher wrote is still carried forward, so the
  // repair verifies the carrier rather than abandoning continuity.
  const continued = render('2026-08-29T18:06:00.000Z');
  assert.equal(continued.sourceChangedAt, '2026-08-29T18:00:00.000Z');
  assert.equal(continued.obstruction.observationWindow.durationMs, 360_000);
  assert.equal(continued.obstruction.state, 'THROUGHPUT_STALL');
});

test('NEGATIVE CONTROL: a resealed carrier that observed evidence before it existed is refused', () => {
  const portfolioPath = join(scratch, 'incoherent-carrier-portfolio.json');
  const htmlPath = join(scratch, 'incoherent-carrier-control-room.html');
  const snapshotPath = join(scratch, 'incoherent-carrier-control-room.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  }]))}\n`, 'utf8');
  const mtime = new Date('2026-08-29T18:00:00.000Z');
  utimesSync(portfolioPath, mtime, mtime);
  const render = (observedAt) => runFactoryDashboardCli([
    '--portfolio', portfolioPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
  ], { now: () => new Date(observedAt), writeStdout: () => {} });

  const honest = render('2026-08-29T18:00:30.000Z');
  const withoutRevision = ({ revision, ...body }) => body;
  const reseal = (body) => ({
    ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  });
  // Fully resealed at both layers, and every binding the render seam checks still holds — the
  // carrier is internally perfect and still claims to have observed evidence from the future.
  const ahead = '2027-01-01T00:00:00.000Z';
  const forged = reseal({
    ...withoutRevision(honest),
    sourceChangedAt: ahead,
    obstruction: reseal({
      ...withoutRevision(honest.obstruction),
      observationWindow: {
        startedAt: ahead,
        endedAt: honest.observedAt,
        durationMs: honest.obstruction.observationWindow.durationMs,
      },
    }),
  });
  writeFileSync(snapshotPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');
  assert.doesNotThrow(
    () => renderControlRoomHtml(forged),
    'the forgery passes every render-seam check, so only a coherence bound can catch it',
  );

  const next = render('2026-08-29T18:01:00.000Z');
  assert.notEqual(next.sourceChangedAt, ahead);
  assert.equal(next.sourceChangedAt, '2026-08-29T18:00:00.000Z');
  assert.equal(next.obstruction.state, 'NONE');
});

/**
 * R2 blocker B — a window start the adapter could not measure is published as such.
 *
 * An input mtime after the observation instant still shows nothing about how long this revision
 * has been in force, and the adapter still declines to assert it. What changes is that the
 * published body now says so: `sourceChangedAtBasis: UNOBSERVED`, sealed into the snapshot
 * revision, and a page that reads "Not yet measured" rather than the most reassuring number
 * available. Falsifier F5 in `docs/portfolio-drain-obstruction-design.md`.
 */
test('a window start the adapter could not measure is published as UNOBSERVED, not as measured zero age', () => {
  const ready = {
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  };
  const observedAt = '2026-08-29T18:01:00.000Z';
  const publish = (label, inputMtime) => {
    const portfolioPath = join(scratch, `basis-${label}-portfolio.json`);
    const htmlPath = join(scratch, `basis-${label}-control-room.html`);
    const snapshotPath = join(scratch, `basis-${label}-control-room.json`);
    writeFileSync(portfolioPath, `${JSON.stringify(portfolio([ready]))}\n`, 'utf8');
    utimesSync(portfolioPath, new Date(inputMtime), new Date(inputMtime));
    const snapshot = runFactoryDashboardCli([
      '--portfolio', portfolioPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
    ], { now: () => new Date(observedAt), writeStdout: () => {} });
    return { snapshot, html: readFileSync(htmlPath, 'utf8') };
  };

  // The mtime lands an hour after the observation instant: unusable as evidence of earlier
  // observation, so the window starts now and says so.
  const unusable = publish('unobserved', '2026-08-29T19:00:00.000Z');
  // The evidence changed at the exact instant it was observed: a real, measured zero-age window.
  const genuine = publish('measured', observedAt);
  // And an ordinary measured window, for contrast.
  const earlier = publish('earlier', '2026-08-29T18:00:00.000Z');

  assert.equal(unusable.snapshot.sourceChangedAt, observedAt);
  assert.equal(unusable.snapshot.obstruction.observationWindow.durationMs, 0);
  assert.equal(unusable.snapshot.obstruction.state, 'NONE');
  assert.equal(unusable.snapshot.sourceChangedAtBasis, 'UNOBSERVED');

  assert.equal(genuine.snapshot.sourceChangedAt, observedAt);
  assert.equal(genuine.snapshot.obstruction.observationWindow.durationMs, 0);
  assert.equal(genuine.snapshot.sourceChangedAtBasis, 'MEASURED');
  assert.equal(earlier.snapshot.sourceChangedAtBasis, 'MEASURED');
  assert.equal(earlier.snapshot.obstruction.observationWindow.durationMs, 60_000);

  const withoutRevision = ({ revision, ...body }) => body;
  assert.notDeepEqual(
    withoutRevision(unusable.snapshot), withoutRevision(genuine.snapshot),
    'F5: the two zero-length windows must not publish equal bodies',
  );
  assert.notEqual(unusable.snapshot.revision, genuine.snapshot.revision);
  assert.equal(
    unusable.snapshot.obstruction.revision, genuine.snapshot.obstruction.revision,
    'the obstruction contract is untouched — the marker records the adapter position only',
  );
  assert.match(unusable.html, /Not yet measured/u);
  assert.doesNotMatch(genuine.html, /Not yet measured/u);

  // And the window still grows from there on the next render, so a stall stays reachable under a
  // clock skewed behind the filesystem — the half R1 did buy, kept.
  const portfolioPath = join(scratch, 'basis-unobserved-portfolio.json');
  const later = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--html-out', join(scratch, 'basis-unobserved-control-room.html'),
    '--snapshot-out', join(scratch, 'basis-unobserved-control-room.json'),
  ], { now: () => new Date('2026-08-29T18:07:00.000Z'), writeStdout: () => {} });
  assert.equal(later.sourceChangedAt, observedAt);
  assert.equal(later.obstruction.state, 'THROUGHPUT_STALL');
  assert.equal(
    later.sourceChangedAtBasis, 'MEASURED',
    'once a verified carrier exists the window start is measured evidence of earlier observation',
  );
});

test('MECHANISM REVERT: verifying the carrier is what stops a tampered file inventing a stall', async () => {
  const source = readFileSync(DASHBOARD_PATH, 'utf8');
  const find = '    published = requireControlRoomSnapshot(JSON.parse(readFileSync(snapshotPath, \'utf8\')));';
  assert.equal(
    source.includes(find), true,
    `the mechanism-revert witness targets "${find}", which is no longer in the source`,
  );
  const mutated = source
    .replace(find, '    published = JSON.parse(readFileSync(snapshotPath, \'utf8\'));')
    .replaceAll("from '../src/", `from '${new URL('../scripts/', import.meta.url).href}../src/`);
  assert.notEqual(mutated, source);
  const mutantPath = join(mutantScratch, 'unverified-carrier.mjs');
  writeFileSync(mutantPath, mutated, 'utf8');
  const mutant = await import(pathToFileURL(mutantPath).href);

  const ready = {
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  };
  const run = (cli, label, observedAt, tamper = false) => {
    const portfolioPath = join(scratch, `revert-${label}-portfolio.json`);
    const snapshotPath = join(scratch, `revert-${label}-control-room.json`);
    if (tamper) {
      const published = JSON.parse(readFileSync(snapshotPath, 'utf8'));
      published.sourceChangedAt = '2020-01-01T00:00:00.000Z';
      writeFileSync(snapshotPath, `${JSON.stringify(published, null, 2)}\n`, 'utf8');
      return null;
    }
    writeFileSync(portfolioPath, `${JSON.stringify(portfolio([ready]))}\n`, 'utf8');
    const mtime = new Date('2026-08-29T18:00:00.000Z');
    utimesSync(portfolioPath, mtime, mtime);
    return cli([
      '--portfolio', portfolioPath,
      '--html-out', join(scratch, `revert-${label}-control-room.html`),
      '--snapshot-out', snapshotPath,
    ], { now: () => new Date(observedAt), writeStdout: () => {} });
  };

  run(mutant.runFactoryDashboardCli, 'mutant', '2026-08-29T18:00:30.000Z');
  run(null, 'mutant', null, true);
  const invented = run(mutant.runFactoryDashboardCli, 'mutant', '2026-08-29T18:01:00.000Z');

  assert.equal(
    invented.sourceChangedAt, '2020-01-01T00:00:00.000Z',
    'without verification the mutant adopts a window start from a file the renderer refuses',
  );
  assert.equal(
    invented.obstruction.state, 'THROUGHPUT_STALL',
    'and asserts a measured stall over evidence it observed for sixty seconds',
  );
  assert.ok(invented.obstruction.observationWindow.durationMs > 200_000_000_000);

  run(runFactoryDashboardCli, 'shipped', '2026-08-29T18:00:30.000Z');
  run(null, 'shipped', null, true);
  const refused = run(runFactoryDashboardCli, 'shipped', '2026-08-29T18:01:00.000Z');

  assert.equal(refused.sourceChangedAt, '2026-08-29T18:00:00.000Z');
  assert.equal(refused.obstruction.state, 'NONE');
});

test('MECHANISM REVERT: the UNOBSERVED basis is what keeps an unmeasured window distinguishable', async () => {
  const source = readFileSync(DASHBOARD_PATH, 'utf8');
  const find = "    return { sourceChangedAt: observedAt, basis: 'UNOBSERVED' };";
  assert.equal(
    source.includes(find), true,
    `the mechanism-revert witness targets "${find}", which is no longer in the source`,
  );
  const mutated = source
    .replace(find, "    return { sourceChangedAt: observedAt, basis: 'MEASURED' };")
    .replaceAll("from '../src/", `from '${new URL('../scripts/', import.meta.url).href}../src/`);
  assert.notEqual(mutated, source);
  const mutantPath = join(mutantScratch, 'no-unobserved-basis.mjs');
  writeFileSync(mutantPath, mutated, 'utf8');
  const mutant = await import(pathToFileURL(mutantPath).href);

  const ready = {
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  };
  const observedAt = '2026-08-29T18:01:00.000Z';
  const publish = (cli, label, inputMtime) => {
    const portfolioPath = join(scratch, `basis-revert-${label}-portfolio.json`);
    writeFileSync(portfolioPath, `${JSON.stringify(portfolio([ready]))}\n`, 'utf8');
    utimesSync(portfolioPath, new Date(inputMtime), new Date(inputMtime));
    return cli([
      '--portfolio', portfolioPath,
      '--html-out', join(scratch, `basis-revert-${label}-control-room.html`),
      '--snapshot-out', join(scratch, `basis-revert-${label}-control-room.json`),
    ], { now: () => new Date(observedAt), writeStdout: () => {} });
  };
  const withoutRevision = ({ revision, ...body }) => body;

  const mutantUnusable = publish(mutant.runFactoryDashboardCli, 'mutant-unusable', '2026-08-29T19:00:00.000Z');
  const mutantGenuine = publish(mutant.runFactoryDashboardCli, 'mutant-genuine', observedAt);
  assert.deepEqual(
    withoutRevision(mutantUnusable), withoutRevision(mutantGenuine),
    'without the UNOBSERVED basis the two cases publish byte-identical bodies again',
  );

  const shippedUnusable = publish(runFactoryDashboardCli, 'shipped-unusable', '2026-08-29T19:00:00.000Z');
  const shippedGenuine = publish(runFactoryDashboardCli, 'shipped-genuine', observedAt);
  assert.notDeepEqual(withoutRevision(shippedUnusable), withoutRevision(shippedGenuine));
});

test('MECHANISM REVERT: the carrier coherence bound is what refuses evidence observed before it existed', async () => {
  const source = readFileSync(DASHBOARD_PATH, 'utf8');
  const find = '  if (Date.parse(published.sourceChangedAt) > Date.parse(published.observedAt)';
  assert.equal(
    source.includes(find), true,
    `the mechanism-revert witness targets "${find}", which is no longer in the source`,
  );
  const mutated = source
    .replace(find, '  if (false')
    .replaceAll("from '../src/", `from '${new URL('../scripts/', import.meta.url).href}../src/`);
  assert.notEqual(mutated, source);
  const mutantPath = join(mutantScratch, 'no-carrier-coherence.mjs');
  writeFileSync(mutantPath, mutated, 'utf8');
  const mutant = await import(pathToFileURL(mutantPath).href);

  const portfolioPath = join(scratch, 'coherence-revert-portfolio.json');
  const htmlPath = join(scratch, 'coherence-revert-control-room.html');
  const snapshotPath = join(scratch, 'coherence-revert-control-room.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio([{
    repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-290',
    itemNumber: 290, title: 'Repair a ready issue', state: 'READY',
    updatedAt: '2026-08-29T18:00:00.000Z',
  }]))}\n`, 'utf8');
  const mtime = new Date('2026-08-29T18:00:00.000Z');
  utimesSync(portfolioPath, mtime, mtime);
  const argv = [
    '--portfolio', portfolioPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
  ];
  const options = (observedAt) => ({ now: () => new Date(observedAt), writeStdout: () => {} });

  const honest = runFactoryDashboardCli(argv, options('2026-08-29T18:00:30.000Z'));
  const withoutRevision = ({ revision, ...body }) => body;
  const reseal = (body) => ({
    ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  });
  const ahead = '2027-01-01T00:00:00.000Z';
  const forged = reseal({
    ...withoutRevision(honest),
    sourceChangedAt: ahead,
    obstruction: reseal({
      ...withoutRevision(honest.obstruction),
      observationWindow: {
        startedAt: ahead,
        endedAt: honest.observedAt,
        durationMs: honest.obstruction.observationWindow.durationMs,
      },
    }),
  });
  const write = () => writeFileSync(snapshotPath, `${JSON.stringify(forged, null, 2)}\n`, 'utf8');

  write();
  assert.throws(
    () => mutant.runFactoryDashboardCli(argv, options('2026-08-29T18:01:00.000Z')),
    { code: 'IncoherentEvidence' },
    'without the bound the mutant hands the seam a window start after the instant it observed',
  );

  write();
  const shipped = runFactoryDashboardCli(argv, options('2026-08-29T18:01:00.000Z'));
  assert.equal(shipped.sourceChangedAt, '2026-08-29T18:00:00.000Z');
  assert.equal(shipped.obstruction.state, 'NONE');
});

// ---------------------------------------------------------------------------
// R3 — the derived activity summary as a published, separately addressed artifact
// ---------------------------------------------------------------------------

function activityScratch(name) {
  const directory = mkdtempSync(join(scratch, `${name}-`));
  const projectionPath = join(directory, 'projection.json');
  writeFileSync(projectionPath, `${JSON.stringify(projection({
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: 'a'.repeat(64),
    effect: 'NONE', authority: 'NONE', capacity: 4,
    counts: { occupied: 1, available: 3 },
    items: [{
      repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE', itemId: 'issue-17',
      itemNumber: 17, title: 'Integrate the factory control room', sourceState: 'READY',
      observedPortfolioRevision: 'a'.repeat(64), drainState: 'CLAIMED', hold: null,
    }],
    decisions: [],
  }))}\n`, 'utf8');
  const changedAt = new Date('2026-08-29T18:40:15.000Z');
  utimesSync(projectionPath, changedAt, changedAt);
  return {
    projectionPath,
    htmlPath: join(directory, 'control-room.html'),
    snapshotPath: join(directory, 'control-room.json'),
    activityPath: join(directory, 'control-room-activity.json'),
  };
}

test('the adapter writes an activity file only when both activity flags are supplied', () => {
  const paths = activityScratch('activity-flags');
  const base = [
    '--projection', paths.projectionPath,
    '--html-out', paths.htmlPath,
    '--snapshot-out', paths.snapshotPath,
  ];
  const options = { now: () => new Date('2026-08-29T18:40:20.000Z'), writeStdout: () => {} };

  runFactoryDashboardCli(base, options);

  assert.equal(existsSync(paths.activityPath), false, 'neither flag writes no extra file');
  const withoutFlags = readFileSync(paths.htmlPath, 'utf8');

  for (const [label, argv] of [
    ['an output with no opt-in', [...base, '--activity-out', paths.activityPath]],
    ['an opt-in with no output', [...base, '--activity', 'on']],
    ['an opt-in outside the closed vocabulary', [
      ...base, '--activity', 'yes', '--activity-out', paths.activityPath,
    ]],
  ]) {
    assert.throws(
      () => runFactoryDashboardCli(argv, options),
      /--activity/u,
      `${label} must be refused`,
    );
    assert.equal(existsSync(paths.activityPath), false, `${label} wrote a file anyway`);
  }

  runFactoryDashboardCli(
    [...base, '--activity', 'on', '--activity-out', paths.activityPath], options,
  );

  assert.equal(existsSync(paths.activityPath), true);
  assert.equal(
    readFileSync(paths.htmlPath, 'utf8'), withoutFlags,
    'the published document is the same either way: the flags publish evidence, not a view',
  );
});

test('the snapshot and the activity written in one tick bind the same revision and instant', () => {
  const paths = activityScratch('activity-binding');

  const snapshot = runFactoryDashboardCli([
    '--projection', paths.projectionPath,
    '--html-out', paths.htmlPath,
    '--snapshot-out', paths.snapshotPath,
    '--activity', 'on',
    '--activity-out', paths.activityPath,
  ], { now: () => new Date('2026-08-29T18:40:20.000Z'), writeStdout: () => {} });

  const published = JSON.parse(readFileSync(paths.activityPath, 'utf8'));
  assert.equal(published.schema, 'gaia-control-room-activity/1');
  assert.equal(published.effect, 'NONE');
  assert.equal(published.authority, 'NONE');
  assert.equal(published.snapshotRevision, snapshot.revision);
  assert.equal(published.sourceRevision, snapshot.sourceRevision);
  assert.equal(published.observedAt, snapshot.observedAt);
  assert.deepEqual(published, summarizeControlRoomActivity({ snapshot }));
  assert.deepEqual(
    published.items.map(({ itemId }) => itemId), ['issue-17'],
    'the occupied lane is summarized rather than silently omitted',
  );
  assert.match(
    readFileSync(paths.htmlPath, 'utf8'), new RegExp(published.revision, 'u'),
    'and the document quotes the exact activity value published beside it',
  );
});

test('the adapter refuses an activity output that aliases another output or its input evidence', () => {
  const paths = activityScratch('activity-alias');
  const options = { now: () => new Date('2026-08-29T18:40:20.000Z'), writeStdout: () => {} };

  for (const [label, activityOut] of [
    ['the snapshot', paths.snapshotPath],
    ['the HTML shell', paths.htmlPath],
    ['the input projection', paths.projectionPath],
  ]) {
    assert.throws(
      () => runFactoryDashboardCli([
        '--projection', paths.projectionPath,
        '--html-out', paths.htmlPath,
        '--snapshot-out', paths.snapshotPath,
        '--activity', 'on',
        '--activity-out', activityOut,
      ], options),
      /outputs must differ|aliases an input evidence path/u,
      `an activity output aliasing ${label} must be refused`,
    );
  }
  assert.equal(
    readFileSync(paths.projectionPath, 'utf8').includes('gaia-portfolio-drain-projection/1'),
    true,
    'and the input evidence it would have overwritten is untouched',
  );
});

test('the GitHub refresh adapter publishes the activity beside the snapshot it belongs to', async (t) => {
  const directory = mkdtempSync(join(scratch, 'activity-refresh-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const portfolioPath = join(directory, 'portfolio.json');
  const snapshotPath = join(directory, 'control-room.json');
  const htmlPath = join(directory, 'control-room.html');
  const activityPath = join(directory, 'control-room-activity.json');
  for (const path of [portfolioPath, snapshotPath, htmlPath, activityPath]) {
    writeFileSync(path, 'stale bytes', 'utf8');
  }
  const surveyed = {
    schema: 'gaia-github-portfolio/1',
    policyRevision: 'sha256:portfolio-policy-v1',
    workItems: [{
      repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE', itemId: 'issue-17',
      itemNumber: 17, title: 'Integrate the factory control room', state: 'READY',
      updatedAt: '2026-08-29T18:00:00.000Z',
    }],
  };

  const snapshot = await runFactoryDashboardRefreshCli([
    '--organization', 'GuitarAlchemist',
    '--policy-revision', 'sha256:portfolio-policy-v1',
    '--portfolio-out', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
    '--activity', 'on',
    '--activity-out', activityPath,
  ], {
    now: () => new Date('2026-08-29T20:00:00.000Z'),
    surveyPortfolio: async () => ({
      ...surveyed,
      revision: createHash('sha256').update(canonicalJson(surveyed)).digest('hex'),
    }),
    writeStdout: () => {},
  });

  const published = JSON.parse(readFileSync(activityPath, 'utf8'));
  assert.equal(published.snapshotRevision, snapshot.revision);
  assert.equal(published.observedAt, snapshot.observedAt);
  assert.match(readFileSync(htmlPath, 'utf8'), new RegExp(published.revision, 'u'));
  await assert.rejects(
    () => runFactoryDashboardRefreshCli([
      '--organization', 'GuitarAlchemist',
      '--policy-revision', 'sha256:portfolio-policy-v1',
      '--portfolio-out', portfolioPath,
      '--snapshot-out', snapshotPath,
      '--html-out', htmlPath,
      '--activity-out', activityPath,
    ], { surveyPortfolio: async () => surveyed, writeStdout: () => {} }),
    /must be supplied together/u,
    'the two flags stay paired through the refresh adapter too',
  );
});
