import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';

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
