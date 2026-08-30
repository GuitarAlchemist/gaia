/**
 * control-room-merge-queue-capability.test.mjs — the capability as a published, re-derived and
 * rendered fact, and as the obstruction that stops a wait.
 *
 * Gates K1-K11 and the two mechanism reverts MR1/MR2 of `docs/merge-queue-capability.md`.
 *
 * The operator failure behind this file is that Gaia waited for a pull request to enter a merge
 * queue that did not exist, was told by its own control room to ask a human for a grant nobody
 * could give, and — while a worker was alive — was told nothing at all. The danger in fixing that
 * is displaying an absent mechanism as a slow one, so most of what is asserted here is what the
 * capability section refuses to say: no estimate, no queue position, no pending, no progress.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import {
  ControlRoomError, buildControlRoomSnapshot, renderControlRoomHtml, requireControlRoomSnapshot,
} from '../src/control-room.mjs';
import {
  MERGE_QUEUE_CAPABILITY_STATES, sealMergeQueueCapability,
} from '../src/merge-queue-capability.mjs';
import {
  PORTFOLIO_DRAIN_OBSTRUCTION_STATES, classifyPortfolioDrainObstruction,
} from '../src/portfolio-drain-obstruction.mjs';
import { PORTFOLIO_DRAIN_MACHINE } from '../src/portfolio-drain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SHA = 'a'.repeat(64);
const AT = '2026-08-30T19:18:00.000Z';
const REPOSITORY = 'GuitarAlchemist/gaia';
const REPOSITORY_ID = 'R_kgDOMergeQueue';
const MINUTE_MS = 60_000;

const scratch = mkdtempSync(join(tmpdir(), 'gaia-mq-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Reseal a tampered snapshot, so the digest can never stand in for the re-derivation gate. */
const reseal = (body) => {
  const { revision, ...rest } = body;
  return { ...rest, revision: sha256(canonicalJson(rest)) };
};

/** Load a one-expression mutant of a shipped module, so a gate can be shown to be a mechanism. */
async function importMutant(file, name, mutate) {
  const source = readFileSync(join(ROOT, 'src', file), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const rewritten = mutated.replaceAll(
    "from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`,
  );
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, rewritten, 'utf8');
  return import(pathToFileURL(path).href);
}

const at = (msAfter) => new Date(Date.parse(AT) + msAfter).toISOString();

function item(itemId, drainState, overrides = {}) {
  return {
    repository: REPOSITORY,
    itemKind: 'PULL_REQUEST',
    itemId,
    itemNumber: Number(itemId.replace(/\D/gu, '')) || 34,
    title: `Work item ${itemId}`,
    sourceState: 'READY',
    observedPortfolioRevision: SHA,
    drainState,
    hold: null,
    ...overrides,
  };
}

function projection(items = [], counts = { occupied: 0, available: 4 }) {
  const body = {
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: SHA,
    effect: 'NONE',
    authority: 'NONE',
    capacity: 4,
    counts,
    items,
    decisions: [],
  };
  return { ...body, revision: sha256(canonicalJson(body)) };
}

const ruleset = (overrides = {}) => ({
  rulesetId: '4110',
  name: 'gaia-merge-queue',
  enforcement: 'active',
  targetsDefaultBranch: true,
  mergeQueueRule: { enabled: true },
  ...overrides,
});

/** One sealed capability artifact. The default is the incident: a read that found nothing. */
function capability(overrides = {}, observedAt = AT) {
  const rulesets = overrides.rulesets ?? [];
  const observation = {
    rulesetsRead: 'OK',
    rulesetsComplete: true,
    protectionRead: 'NOT_FOUND',
    adminPermission: 'ABSENT',
    unknownRuleTypes: [],
    ...overrides,
    rulesets,
    rulesetDigest: null,
  };
  return sealMergeQueueCapability({
    observedAt,
    repositoryId: REPOSITORY_ID,
    repository: REPOSITORY,
    defaultBranch: 'main',
    observation: {
      ...observation,
      rulesetDigest: observation.rulesetsRead === 'OK'
        ? sha256(canonicalJson(rulesets.map((entry) => ({ ...entry })))) : null,
    },
  });
}

/** The incident's drain: one published pull request with nowhere to go. */
const WAITING = [item('pr-34', 'PUBLISHED')];

const snapshotWith = (mergeQueueCapability, extra = {}) => buildControlRoomSnapshot({
  drainProjection: projection(WAITING, { occupied: 1, available: 3 }),
  observedAt: AT,
  mergeQueueCapability,
  ...extra,
});

// ---------------------------------------------------------------------------------------------
// K1 — an absent artifact changes nothing at all.
// ---------------------------------------------------------------------------------------------

test('K1: with no artifact the key is omitted entirely and the snapshot revision does not move', () => {
  const without = buildControlRoomSnapshot({
    drainProjection: projection(WAITING, { occupied: 1, available: 3 }), observedAt: AT,
  });
  const explicitNull = snapshotWith(null);
  assert.equal(Object.hasOwn(without, 'mergeQueueCapability'), false,
    'a capability nobody supplied is an absent input, not an UNKNOWN state');
  assert.equal(without.revision, explicitNull.revision,
    'adding the input must not move a published revision for evidence that did not change');
  assert.equal(without.obstruction.state, 'AUTHORITY_STARVATION',
    'and without the evidence the drain reports exactly what it reported before');
});

test('K1: a present but null capability block is refused rather than read as absence', () => {
  const snapshot = reseal({ ...snapshotWith(capability()), mergeQueueCapability: null });
  assert.throws(() => requireControlRoomSnapshot(snapshot),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot');
});

// ---------------------------------------------------------------------------------------------
// K2-K5 — the obstruction, and what selects it.
// ---------------------------------------------------------------------------------------------

test('K2: ABSENT with a published pull request selects CAPABILITY_ABSENT with one exact action', () => {
  const snapshot = snapshotWith(capability());
  assert.equal(snapshot.obstruction.state, 'CAPABILITY_ABSENT');
  assert.deepEqual(snapshot.obstruction.affectedItemIds, ['pr-34']);
  assert.equal(snapshot.obstruction.recovery.kind, 'CREATE_MERGE_QUEUE_RULE');
  assert.equal(snapshot.obstruction.recovery.advisory, true);
  assert.equal(snapshot.obstruction.recovery.effect, 'NONE');
  assert.equal(snapshot.obstruction.recovery.authority, 'NONE');
  assert.notEqual(snapshot.obstruction.recovery.kind, 'REQUEST_EXPLICIT_AUTHORITY',
    'the operator is no longer sent to a human who has nothing to give');
  assert.equal(snapshot.mergeQueueCapability.state, 'ABSENT');
  assert.equal(snapshot.mergeQueueCapability.repositoryId, REPOSITORY_ID,
    'the reading binds the repository identity, not only its name');
  assert.equal(snapshot.mergeQueueCapability.observationAgeMs, 0);
});

test('K3: a live lane does not erase a capability obstruction', () => {
  const drain = projection([item('pr-34', 'PUBLISHED'), item('issue-9', 'RUNNING')],
    { occupied: 1, available: 3 });
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: drain,
    observedAt: AT,
    windowStartedAt: at(-10 * MINUTE_MS),
    liveness: [{ itemId: 'issue-9', state: 'ACTIVE' }],
    mergeQueueCapability: {
      state: 'ABSENT', evidenceRevision: SHA, observationAgeMs: 0,
      repository: REPOSITORY, defaultBranch: 'main',
    },
  });
  assert.equal(obstruction.state, 'CAPABILITY_ABSENT',
    'a busy worker proves a process is alive and proves nothing about whether a queue exists');
});

test('K4: AVAILABLE, and a capability with nothing waiting to merge, select no capability obstruction', () => {
  assert.equal(snapshotWith(capability({ rulesets: [ruleset()] })).obstruction.state,
    'AUTHORITY_STARVATION', 'an available queue obstructs nothing, so the old answer stands');

  const idle = buildControlRoomSnapshot({
    drainProjection: projection([item('issue-1', 'QUEUED')]),
    observedAt: AT,
    mergeQueueCapability: capability(),
  });
  assert.notEqual(idle.obstruction.state, 'CAPABILITY_ABSENT',
    'a repository with no merge queue and nothing waiting to merge is not obstructed by it');
  assert.equal(idle.mergeQueueCapability.state, 'ABSENT',
    'but the reading is still published, so an operator can see it before it bites');
});

test('K5: PERMISSION_DENIED, STALE and UNKNOWN select CAPABILITY_UNVERIFIED', () => {
  const cases = [
    ['PERMISSION_DENIED', capability({ rulesetsRead: 'FORBIDDEN' }), AT, 'GRANT_CAPABILITY_READ'],
    ['UNKNOWN', capability({ rulesetsRead: 'NOT_FOUND' }), AT, 'REPORT_UNREADABLE_CAPABILITY'],
    ['STALE', capability(), at(6 * MINUTE_MS), 'REPROBE_CAPABILITY'],
  ];
  for (const [expected, artifact, observedAt, kind] of cases) {
    const snapshot = buildControlRoomSnapshot({
      drainProjection: projection(WAITING, { occupied: 1, available: 3 }),
      observedAt,
      mergeQueueCapability: artifact,
    });
    assert.equal(snapshot.mergeQueueCapability.state, expected);
    assert.equal(snapshot.obstruction.state, 'CAPABILITY_UNVERIFIED',
      `${expected} is a capability Gaia could not establish, and waiting resolves none of them`);
    assert.equal(snapshot.obstruction.recovery.kind, kind);
  }
});

test('K5: MISCONFIGURED selects CAPABILITY_ABSENT with its own distinct action', () => {
  const snapshot = snapshotWith(capability({ rulesets: [ruleset({ enforcement: 'evaluate' })] }));
  assert.equal(snapshot.mergeQueueCapability.state, 'MISCONFIGURED');
  assert.equal(snapshot.obstruction.state, 'CAPABILITY_ABSENT');
  assert.equal(snapshot.obstruction.recovery.kind, 'CORRECT_MERGE_QUEUE_RULE');
});

/** One live worker, so the headline reads ACTIVE exactly as it did during the incident. */
const RUNNING_OBSERVATION = [{
  itemId: 'issue-9',
  capturedAt: at(-5_000),
  record: {
    schema: 'gaia-cli-progress/1',
    stage: 'worker_running',
    elapsedMs: 35_000,
    remainingProviderInvocations: 4,
    remainingProviderTimeUpperBoundMs: 2_400_000,
    heartbeat: true,
  },
}];

test('K5a: a capability obstruction reaches the headline in a paused and in an active drain', () => {
  const paused = snapshotWith(capability());
  assert.equal(paused.headline.state, 'PAUSED');
  assert.match(paused.headline.detail, /merge queue/u);

  const active = buildControlRoomSnapshot({
    drainProjection: projection([...WAITING, item('issue-9', 'RUNNING')],
      { occupied: 1, available: 3 }),
    observedAt: AT,
    progressObservations: RUNNING_OBSERVATION,
    mergeQueueCapability: capability(),
  });
  assert.equal(active.headline.state, 'ACTIVE', 'a live worker, exactly as in the incident');
  assert.equal(active.obstruction.state, 'CAPABILITY_ABSENT');
  assert.match(
    active.headline.detail, /merge queue/u,
    'and the headline still names the gap, instead of reporting only that something is alive',
  );
});

test('K5a: an occupied lane with no liveness evidence still outranks the capability', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([...WAITING, item('issue-9', 'RUNNING')],
      { occupied: 1, available: 3 }),
    observedAt: AT,
    mergeQueueCapability: capability(),
  });
  assert.equal(snapshot.obstruction.state, 'LANE_STALE',
    'a capability verdict computed beside evidence Gaia does not trust is not reported first');
});

test('K5b: every obstruction state has a label, a recovery, a severity and a translation', () => {
  const source = readFileSync(join(ROOT, 'src', 'control-room.mjs'), 'utf8');
  for (const state of PORTFOLIO_DRAIN_OBSTRUCTION_STATES) {
    assert.equal(source.includes(`${state}:`), true,
      `${state} must appear in every lookup table, or it renders as undefined`);
  }
  // The French label table has no fallback at all, so a missing entry is a literal `undefined`
  // on the page rather than an English word. Both new states are asserted through the renderer.
  for (const artifact of [capability(), capability({ rulesetsRead: 'FORBIDDEN' })]) {
    const html = renderControlRoomHtml(snapshotWith(artifact), { language: 'fr' });
    assert.equal(html.includes('undefined'), false, 'no lookup table falls through in French');
  }
});

test('K5c: no forecast eta is published while a capability obstruction stands', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([...WAITING, item('issue-9', 'RUNNING')],
      { occupied: 1, available: 3 }),
    observedAt: AT,
    mergeQueueCapability: capability(),
    progressObservations: RUNNING_OBSERVATION,
    completedRuns: Array.from({ length: 8 }, () => ({
      workflow: 'portfolio-factory-run', outcome: 'COMPLETED', elapsedMs: 30 * MINUTE_MS,
    })),
  });
  assert.notEqual(snapshot.eta.state, 'FORECAST',
    'an estimate of when something finishes is a claim it is progressing');
});

test('K5d: many waiting items under one absent capability produce one obstruction and one action', () => {
  const many = Array.from({ length: 12 }, (unused, index) => item(`pr-${index + 1}`, 'PUBLISHED'));
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection(many, { occupied: 0, available: 4 }),
    observedAt: AT,
    mergeQueueCapability: capability(),
  });
  assert.equal(snapshot.obstruction.affectedItemIds.length, 12);
  assert.equal(snapshot.obstruction.recovery.kind, 'CREATE_MERGE_QUEUE_RULE');
  assert.equal(typeof snapshot.obstruction.recovery.label, 'string',
    'one missing ruleset is one thing to do, not twelve');
});

test('K5e: the drain machine identity is byte-identical, so no persisted receipt needs migrating', () => {
  // Pinned to a literal rather than recomputed, because recomputing it from the same rules it is
  // derived from would agree with any change to those rules. Capability evidence enters the drain
  // as an explicit input to the classifier, never as a rule of the machine, precisely so this
  // digest cannot move: it is stamped beside every durable receipt already written.
  assert.deepEqual(PORTFOLIO_DRAIN_MACHINE, {
    machineId: 'gaia.portfolio-drain',
    machineVersion: 1,
    rulesRevision: '9d49b709619777fb0f39baf40c8e26e8cf7b65eb9626e17376ecc44d99b0afe8',
  });
});

// ---------------------------------------------------------------------------------------------
// K6-K9 — what the rendered page may and may not say.
// ---------------------------------------------------------------------------------------------

test('K6: no rendered string carries a credential, token, URL, command, path or provider prose', () => {
  for (const language of ['en', 'fr']) {
    const html = renderControlRoomHtml(snapshotWith(capability()), { language });
    const rendered = html.slice(html.indexOf('</style>'));
    for (const forbidden of ['://', 'ghp_', 'github_pat_', 'Bearer ', 'gh api', 'gh ruleset',
      'C:\\', '/repos/', 'Authorization']) {
      assert.equal(rendered.includes(forbidden), false,
        `${forbidden} must never reach the page in ${language}`);
    }
  }
});

test('K7: an absent capability is never worded as queued, pending, in progress or an estimate', () => {
  for (const language of ['en', 'fr']) {
    const html = renderControlRoomHtml(snapshotWith(capability()), { language });
    const rendered = html.slice(html.indexOf('</style>')).toLowerCase();
    for (const forbidden of ['queued', 'pending', 'in progress', 'eta ', 'estimated',
      'en attente de la file', 'en cours de file']) {
      assert.equal(rendered.includes(forbidden), false,
        `"${forbidden}" is not true of a mechanism that does not exist (${language})`);
    }
  }
});

test('K8: the render seam re-derives the state; a resealed capability state is refused', () => {
  const snapshot = snapshotWith(capability());
  const forged = reseal({
    ...snapshot,
    mergeQueueCapability: { ...snapshot.mergeQueueCapability, state: 'AVAILABLE' },
  });
  assert.throws(() => requireControlRoomSnapshot(forged),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot',
    'a state its own carried observation does not decide is refused, digest or no digest');
  assert.equal(requireControlRoomSnapshot(snapshot), snapshot, 'and the honest one is accepted');
});

test('K9: the French document translates both new states and leaks no English copy', () => {
  for (const artifact of [capability(), capability({ rulesetsRead: 'FORBIDDEN' })]) {
    const html = renderControlRoomHtml(snapshotWith(artifact), { language: 'fr' });
    const rendered = html.slice(html.indexOf('</style>'));
    for (const english of ['Create one active repository ruleset', 'Grant the reading identity',
      'waiting on a merge queue']) {
      assert.equal(rendered.includes(english), false, `${english} must not survive into French`);
    }
    assert.match(rendered, /file d’attente de merge/u, 'and the French names the thing');
  }
});

// ---------------------------------------------------------------------------------------------
// K10-K11 — the publisher flag.
// ---------------------------------------------------------------------------------------------

function publish(name, extraArgs = []) {
  const projectionPath = join(scratch, `${name}-projection.json`);
  const htmlPath = join(scratch, `${name}.html`);
  const snapshotPath = join(scratch, `${name}-snapshot.json`);
  writeFileSync(projectionPath, JSON.stringify(
    projection(WAITING, { occupied: 1, available: 3 }),
  ), 'utf8');
  runFactoryDashboardCli([
    '--projection', projectionPath, '--html-out', htmlPath, '--snapshot-out', snapshotPath,
    ...extraArgs,
  ], { now: () => new Date(AT) });
  return {
    html: readFileSync(htmlPath, 'utf8'),
    snapshot: JSON.parse(readFileSync(snapshotPath, 'utf8')),
  };
}

test('K10: the --merge-queue-capability flag plumbs through and refuses an unreadable path', () => {
  const artifactPath = join(scratch, 'capability.json');
  writeFileSync(artifactPath, JSON.stringify(capability()), 'utf8');
  const { snapshot } = publish('k10', ['--merge-queue-capability', artifactPath]);
  assert.equal(snapshot.mergeQueueCapability.state, 'ABSENT');
  assert.equal(snapshot.obstruction.state, 'CAPABILITY_ABSENT');

  assert.throws(() => publish('k10-missing', [
    '--merge-queue-capability', join(scratch, 'nowhere.json'),
  ]));
});

test('K10: without the flag the published document is byte-identical to before the feature', () => {
  const first = publish('k10-absent-a');
  const second = publish('k10-absent-b');
  assert.equal(first.html, second.html);
  assert.equal(Object.hasOwn(second.snapshot, 'mergeQueueCapability'), false);
});

test('K11: deterministic replay through the CLI', () => {
  const artifactPath = join(scratch, 'capability-replay.json');
  writeFileSync(artifactPath, JSON.stringify(capability()), 'utf8');
  const first = publish('k11-a', ['--merge-queue-capability', artifactPath]);
  const second = publish('k11-b', ['--merge-queue-capability', artifactPath]);
  assert.equal(first.snapshot.revision, second.snapshot.revision);
  assert.equal(first.html, second.html);
});

// ---------------------------------------------------------------------------------------------
// Mechanism reverts — each shows a gate tests the mechanism rather than the outcome.
// ---------------------------------------------------------------------------------------------

test('MR1: deciding capability below the live-lane short-circuit is what let a worker hide it', async () => {
  const mutant = await importMutant(
    'portfolio-drain-obstruction.mjs', 'capability-below-moving',
    (source) => source.replace(
      'if (capabilityState !== null) return [capabilityState, idsOf(awaitingMerge)];',
      'if (capabilityState !== null && !moving) return [capabilityState, idsOf(awaitingMerge)];',
    ),
  );
  const input = {
    drainProjection: projection([item('pr-34', 'PUBLISHED'), item('issue-9', 'RUNNING')],
      { occupied: 1, available: 3 }),
    observedAt: AT,
    windowStartedAt: at(-10 * MINUTE_MS),
    liveness: [{ itemId: 'issue-9', state: 'ACTIVE' }],
    mergeQueueCapability: {
      state: 'ABSENT', evidenceRevision: SHA, observationAgeMs: 0,
      repository: REPOSITORY, defaultBranch: 'main',
    },
  };
  assert.equal(mutant.classifyPortfolioDrainObstruction(input).state, 'NONE',
    'the mutant reports a healthy drain that is waiting on nothing — the incident exactly');
  assert.equal(classifyPortfolioDrainObstruction(input).state, 'CAPABILITY_ABSENT',
    'and the shipped precedence is what refuses to');
});

test('MR2: collapsing 403 into 404 is what turns a permission failure into a doomed remediation', async () => {
  const mutant = await importMutant(
    'merge-queue-capability.mjs', 'forbidden-as-not-found',
    (source) => source.replace(
      "if (rulesetsRead === 'FORBIDDEN' || protectionRead === 'FORBIDDEN') return 'PERMISSION_DENIED';",
      "if (false) return 'PERMISSION_DENIED';",
    ),
  );
  const artifact = capability({ rulesetsRead: 'FORBIDDEN' });
  assert.equal(
    mutant.decideMergeQueueCapability({ artifact, observedAt: AT }), 'UNKNOWN',
    'the mutant loses the permission reading entirely',
  );
  const snapshot = snapshotWith(artifact);
  assert.equal(snapshot.mergeQueueCapability.state, 'PERMISSION_DENIED',
    'and the shipped rule keeps a permission failure nameable, so the action can be the right one');
  assert.equal(snapshot.obstruction.recovery.kind, 'GRANT_CAPABILITY_READ');
});

// ---------------------------------------------------------------------------------------------
// K12-K15 — the R1 repairs at the presentation seam. Every one of these is a place where the
// page still read as slow progress: a fabricated data gap, a green instruction to wait, a fact
// deleted by an unobserved lane, and a capability verified beside an obstruction that ignored it.
// ---------------------------------------------------------------------------------------------

/** The incident's exact input: one published pull request, one live worker, ample history. */
const INCIDENT = Object.freeze({
  drainProjection: projection([...WAITING, item('issue-9', 'RUNNING')],
    { occupied: 1, available: 3 }),
  observedAt: AT,
  progressObservations: RUNNING_OBSERVATION,
  completedRuns: Array.from({ length: 8 }, () => ({
    workflow: 'portfolio-factory-run', outcome: 'COMPLETED', elapsedMs: 30 * MINUTE_MS,
  })),
});

const CAPABILITY_ETA_REASON
  = 'A merge queue capability obstruction stands; no completion estimate applies.';

test('K12: the suppressed eta names the capability, not a data gap that does not exist', () => {
  const withoutCapability = buildControlRoomSnapshot({ ...INCIDENT });
  assert.equal(withoutCapability.eta.state, 'FORECAST',
    'the history is ample: eight comparable completed runs, so nothing is missing');
  assert.equal(withoutCapability.pace.sampleSize, 8);

  const snapshot = buildControlRoomSnapshot({ ...INCIDENT, mergeQueueCapability: capability() });
  assert.equal(snapshot.eta.state, 'UNKNOWN');
  assert.equal(snapshot.eta.reason, CAPABILITY_ETA_REASON,
    'the forecast was computed and discarded for a known cause; naming a different one is a fabrication');
  assert.notEqual(snapshot.eta.reason, 'Insufficient comparable history.');
});

test('K12: no rendered missing-evidence sentence carries a negative count', () => {
  const snapshot = buildControlRoomSnapshot({ ...INCIDENT, mergeQueueCapability: capability() });
  for (const language of ['en', 'fr']) {
    const rendered = renderControlRoomHtml(snapshot, { language });
    const body = rendered.slice(rendered.indexOf('</style>'));
    assert.equal(/-\d/u.test(body.replaceAll(/<time>[^<]*<\/time>/gu, '')), false,
      `a negative number is arithmetic nonsense on an operator page (${language})`);
    assert.equal(body.includes('of 5 recorded'), false,
      'and the sample-size sentence belongs to a shortage this drain does not have');
    assert.equal(body.includes('sur 5 enregistrées'), false);
  }
});

test('MR3: reverting the eta reason restores the negative sample count on the page', async () => {
  const mutant = await importMutant('control-room.mjs', 'eta-reason-reverted', (source) => source
    .replace(
      `capabilityObstructed
      ? { state: 'UNKNOWN', label: 'Unknown', reason: CAPABILITY_ETA_REASON }
      : forecast ?? (activeCount === 0`,
      `(capabilityObstructed ? null : forecast) ?? (activeCount === 0`,
    ));
  const snapshot = mutant.buildControlRoomSnapshot({
    ...INCIDENT, mergeQueueCapability: capability(),
  });
  assert.equal(snapshot.eta.reason, 'Insufficient comparable history.');
  const rendered = mutant.renderControlRoomHtml(snapshot, { language: 'en' });
  assert.match(rendered, /-3 more comparable completed portfolio-factory-run samples/u,
    'the mutant tells the operator to record minus three samples, which is the defect');
});

test('K13: a capability obstruction outranks the hero next action and is never styled healthy', () => {
  const snapshot = buildControlRoomSnapshot({ ...INCIDENT, mergeQueueCapability: capability() });
  assert.equal(snapshot.headline.state, 'ACTIVE', 'a live worker, exactly as in the incident');
  assert.equal(snapshot.obstruction.state, 'CAPABILITY_ABSENT');
  assert.notEqual(snapshot.nextAction.kind, 'OBSERVE_ACTIVE_RUN',
    'the field an operator reads first must not say wait while the mechanism does not exist');
  assert.equal(snapshot.nextAction.kind, snapshot.obstruction.recovery.kind,
    'the hero and the obstruction panel name one next move, from one truth');
  assert.equal(snapshot.nextAction.label, snapshot.obstruction.recovery.label);

  for (const language of ['en', 'fr']) {
    const rendered = renderControlRoomHtml(snapshot, { language });
    const hero = rendered.slice(rendered.indexOf('<div class="next"'));
    const panel = hero.slice(0, hero.indexOf('</div>\n  </section>'));
    assert.match(panel, /data-severity="blocked"/u,
      `an obstruction the drain cannot pass is not healthy (${language})`);
    assert.equal(panel.includes('Wait for the worker result'), false);
    assert.equal(panel.includes('Attendre le résultat du worker'), false);
  }
});

test('K13: a live worker with an available capability still reports the ordinary next action', () => {
  const healthy = buildControlRoomSnapshot({
    ...INCIDENT, mergeQueueCapability: capability({ rulesets: [ruleset()] }),
  });
  assert.equal(healthy.nextAction.kind, 'OBSERVE_ACTIVE_RUN',
    'nothing is downgraded when there is no capability obstruction to report');
  assert.match(renderControlRoomHtml(healthy, { language: 'en' }), /data-severity="healthy"/u);
});

test('MR4: reverting the next-action precedence restores the green instruction to wait', async () => {
  const mutant = await importMutant('control-room.mjs', 'next-action-reverted',
    (source) => source.replace('if (capabilityObstruction !== null) {', 'if (false) {'));
  const snapshot = mutant.buildControlRoomSnapshot({
    ...INCIDENT, mergeQueueCapability: capability(),
  });
  assert.equal(snapshot.nextAction.kind, 'OBSERVE_ACTIVE_RUN');
  assert.match(
    mutant.renderControlRoomHtml(snapshot, { language: 'en' }),
    /class="next" data-severity="healthy"/u,
    'the mutant renders "wait for the worker" in green above the obstruction, which is the defect',
  );
});

test('MR5: reverting the next-action severity paints the same obstruction as a warning', async () => {
  const mutant = await importMutant('control-room.mjs', 'next-severity-reverted',
    (source) => source.replace('const nextSeverity = capabilityNext', 'const nextSeverity = false'));
  const snapshot = mutant.buildControlRoomSnapshot({
    ...INCIDENT, mergeQueueCapability: capability(),
  });
  const rendered = mutant.renderControlRoomHtml(snapshot, { language: 'en' });
  assert.match(rendered, /class="next" data-severity="warning"/u,
    'the mutant softens a blocked mechanism into a warning');
  assert.match(
    renderControlRoomHtml(buildControlRoomSnapshot({ ...INCIDENT, mergeQueueCapability: capability() }),
      { language: 'en' }),
    /class="next" data-severity="blocked"/u,
    'and the shipped severity is taken from the obstruction it came from',
  );
});

test('K14: an unobserved lane does not erase the absent capability from the page', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([...WAITING, item('issue-9', 'RUNNING')],
      { occupied: 1, available: 3 }),
    observedAt: AT,
    mergeQueueCapability: capability(),
  });
  assert.equal(snapshot.obstruction.state, 'LANE_STALE',
    'the stale lane still wins the obstruction, because both facts are true and neither is invented');

  for (const language of ['en', 'fr']) {
    const rendered = renderControlRoomHtml(snapshot, { language });
    const body = rendered.slice(rendered.indexOf('</style>'));
    assert.match(body, language === 'fr' ? /file d’attente de merge/u : /merge queue/iu,
      `an independently sealed absent capability survives a defaulted lane liveness (${language})`);
    assert.match(body, /ABSENT/u, 'and it survives as the state it was decided to be');
    assert.match(body, /LANE_STALE/u, 'without displacing the obstruction that did win');
    const lowered = body.toLowerCase();
    for (const forbidden of ['queued', 'pending', 'in progress', 'eta ', 'estimated']) {
      assert.equal(lowered.includes(forbidden), false,
        `"${forbidden}" is not true of a mechanism that does not exist (${language})`);
    }
  }
});

test('K14: the capability panel is total over the closed state vocabulary in both languages', () => {
  const cases = [
    capability(),
    capability({ rulesets: [ruleset()] }),
    capability({ rulesets: [ruleset({ enforcement: 'evaluate' })] }),
    capability({ rulesetsRead: 'FORBIDDEN' }),
    capability({ rulesetsRead: 'NOT_FOUND' }),
  ];
  const seen = new Set();
  for (const artifact of cases) {
    for (const observedAt of [AT, at(6 * MINUTE_MS)]) {
      const snapshot = buildControlRoomSnapshot({
        drainProjection: projection(WAITING, { occupied: 1, available: 3 }),
        observedAt,
        mergeQueueCapability: artifact,
      });
      seen.add(snapshot.mergeQueueCapability.state);
      for (const language of ['en', 'fr']) {
        const rendered = renderControlRoomHtml(snapshot, { language });
        assert.equal(rendered.includes('undefined'), false,
          `no capability lookup table falls through (${snapshot.mergeQueueCapability.state}, ${language})`);
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...MERGE_QUEUE_CAPABILITY_STATES].sort(),
    'every state in the closed vocabulary is rendered by this gate, not only the interesting ones');
});

test('K14: with no capability artifact the page carries no residue of the panel', () => {
  const rendered = renderControlRoomHtml(
    buildControlRoomSnapshot({
      drainProjection: projection(WAITING, { occupied: 1, available: 3 }), observedAt: AT,
    }),
    { language: 'en' },
  );
  assert.equal(rendered.includes('merge-queue-capability'), false,
    'a feature nobody supplied evidence for leaves no stylesheet and no empty section behind');
});

test('MR6: reverting the capability panel deletes the fact under a stale lane', async () => {
  const mutant = await importMutant('control-room.mjs', 'capability-panel-reverted',
    (source) => source.replace(
      '${renderMergeQueueCapability(snapshot, copy, language)}', '',
    ));
  const snapshot = mutant.buildControlRoomSnapshot({
    drainProjection: projection([...WAITING, item('issue-9', 'RUNNING')],
      { occupied: 1, available: 3 }),
    observedAt: AT,
    mergeQueueCapability: capability(),
  });
  const rendered = mutant.renderControlRoomHtml(snapshot, { language: 'en' });
  const body = rendered.slice(rendered.indexOf('</style>'));
  assert.equal(/merge queue/iu.test(body), false,
    'the mutant publishes the absent capability into the snapshot and shows the operator none of it');
});

test('K15: a capability verified beside an obstruction that ignored it is refused', () => {
  const honest = snapshotWith(capability());
  const without = buildControlRoomSnapshot({
    drainProjection: projection(WAITING, { occupied: 1, available: 3 }), observedAt: AT,
  });
  assert.equal(without.obstruction.state, 'AUTHORITY_STARVATION');

  const forged = reseal({
    ...without,
    mergeQueueCapability: honest.mergeQueueCapability,
  });
  assert.equal(forged.mergeQueueCapability.state, 'ABSENT',
    'the capability block is honest, correctly derived and correctly sealed');
  assert.throws(() => requireControlRoomSnapshot(forged),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot',
    'an obstruction classified without the published capability cannot be displayed beside it');
});

test('K15: an obstruction whose carried capability contradicts the published block is refused', () => {
  const honest = snapshotWith(capability());
  const obstruction = reseal({
    ...honest.obstruction,
    capability: { ...honest.obstruction.capability, state: 'STALE' },
  });
  assert.throws(() => requireControlRoomSnapshot(reseal({ ...honest, obstruction })),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot',
    'one reading, published once, cannot be two readings on one page');
});

test('K15: an obstruction carrying a capability the snapshot does not publish is refused', () => {
  const honest = snapshotWith(capability());
  const { mergeQueueCapability, ...stripped } = honest;
  assert.throws(() => requireControlRoomSnapshot(reseal(stripped)),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot',
    'an obstruction may not name evidence the snapshot declines to carry');
});

test('K15: every honest capability snapshot still verifies, including the outranked one', () => {
  const honest = [
    snapshotWith(capability()),
    snapshotWith(capability({ rulesets: [ruleset()] })),
    snapshotWith(capability({ rulesetsRead: 'FORBIDDEN' })),
    buildControlRoomSnapshot({
      drainProjection: projection([...WAITING, item('issue-9', 'RUNNING')],
        { occupied: 1, available: 3 }),
      observedAt: AT,
      mergeQueueCapability: capability(),
    }),
    buildControlRoomSnapshot({
      drainProjection: projection([item('issue-1', 'QUEUED')]),
      observedAt: AT,
      mergeQueueCapability: capability(),
    }),
    buildControlRoomSnapshot({
      drainProjection: projection(WAITING, { occupied: 1, available: 3 }), observedAt: AT,
    }),
  ];
  for (const snapshot of honest) {
    assert.equal(requireControlRoomSnapshot(snapshot), snapshot,
      `${snapshot.obstruction.state} is a snapshot the builder itself produced and must not be refused`);
  }
});

test('MR7: reverting the binding accepts a capability beside an obstruction that ignored it', async () => {
  const mutant = await importMutant('control-room.mjs', 'capability-binding-reverted',
    (source) => source.replace('requireCapabilityBinding(obstruction, snapshot, capability);', ''));
  const honest = snapshotWith(capability());
  const without = buildControlRoomSnapshot({
    drainProjection: projection(WAITING, { occupied: 1, available: 3 }), observedAt: AT,
  });
  const forged = reseal({ ...without, mergeQueueCapability: honest.mergeQueueCapability });
  assert.equal(mutant.requireControlRoomSnapshot(forged), forged,
    'the mutant accepts an ABSENT capability beside "ask a human for a grant" — the incident restored');
});
