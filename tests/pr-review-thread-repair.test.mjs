/**
 * RED gates for `gaia-pr-review-thread-repair/1` — the durable half of issue #43.
 *
 * The S family holds everything that survives a crash, a race or a lost response: the append-only
 * ledger under compare-and-swap, the bounded lease, orphan reconciliation, the two closed effects,
 * the missed-delivery repair, the DuckDB-readable projection, and the commit-only repair sensor.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { FACTORY_TELEMETRY_MACHINE } from '../src/factory-telemetry.mjs';
import { PORTFOLIO_DRAIN_MACHINE } from '../src/portfolio-drain.mjs';
import {
  PR_REVIEW_THREAD_TRANSITIONS,
  prReviewThreadIdentity,
} from '../src/pr-review-thread.mjs';
import {
  EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION,
  PR_REVIEW_REPAIR_LEASE_MS,
  PR_REVIEW_REPAIR_MACHINE,
  PR_REVIEW_REPAIR_PROJECTION_SCHEMA,
  PR_REVIEW_REPAIR_TRANSITION_FIELDS,
  PrReviewRepairError,
  appendPrReviewRepairTransition,
  measurePrReviewThreadRepair,
  prReviewRepairLedgerPath,
  projectPrReviewRepairLedger,
  readPrReviewRepairLedger,
  repairIdentityMarker,
  runPrReviewThreadRepairPump,
} from '../src/pr-review-thread-repair.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPAIR_MODULE = join(ROOT, 'src', 'pr-review-thread-repair.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-pr-review-thread-'));
test.after(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));
let sequence = 0;
const scratch = () => join(SCRATCH, `case-${sequence += 1}`);

const REVIEWED_HEAD = 'a'.repeat(40);
const CURRENT_HEAD = 'b'.repeat(40);
const REPAIR_HEAD = 'c'.repeat(40);
const ANCHOR = '1'.repeat(64);
const SOURCE_REVISION = '3'.repeat(64);
const NOW = '2026-08-31T12:00:00.000Z';
const OWNER_A = 'a1'.repeat(16);
const OWNER_B = 'b2'.repeat(16);
const OWNER_C = 'c3'.repeat(16);
const LEASE_MS = 120_000;

const IDENTITY = prReviewThreadIdentity({
  repository: 'GuitarAlchemist/gaia',
  pullRequestNumber: 39,
  reviewThreadId: 'PRRT_thread_1',
  reviewedHeadOid: REVIEWED_HEAD,
});

const comment = (over = {}) => ({
  id: 'RT_comment_1', body: 'P1: the lock is released before the swap lands.', ...over,
});

function observation(over = {}) {
  const built = {
    schema: 'gaia-pr-review-thread-observation/1',
    observedAt: NOW,
    repository: 'GuitarAlchemist/gaia',
    pullRequest: { number: 39, baseBranch: 'main' },
    review: {
      id: 'PRR_review_1',
      state: 'COMMENTED',
      submittedAt: '2026-08-31T11:00:00.000Z',
      reviewedHeadOid: REVIEWED_HEAD,
    },
    reviewThread: {
      id: 'PRRT_thread_1',
      path: 'src/pr-review-thread.mjs',
      line: 42,
      isResolved: false,
      isOutdated: false,
      disputed: false,
      comments: [comment()],
    },
    currentHeadOid: REVIEWED_HEAD,
    applicability: { anchorDigestAtReview: ANCHOR, anchorDigestAtCurrentHead: ANCHOR },
    repair: null,
    checks: null,
    run: { runId: 'pr-review-thread-pump-r0', laneGeneration: 1 },
    sourceRevision: SOURCE_REVISION,
  };
  const merged = { ...built, ...over };
  for (const key of ['pullRequest', 'review', 'reviewThread', 'applicability', 'run']) {
    if (over[key]) merged[key] = { ...built[key], ...over[key] };
  }
  return merged;
}

const REPAIR = Object.freeze({
  headOid: REPAIR_HEAD,
  descendsFromReviewedHead: true,
  touchesAnchorPath: true,
  commitsAheadOfReviewedHead: 1,
  addressedCommentIds: ['RT_comment_1'],
});

const CHECKS = Object.freeze({
  headOid: REPAIR_HEAD,
  requiredContexts: ['build', 'test'],
  conclusions: [
    { context: 'build', conclusion: 'SUCCESS' },
    { context: 'test', conclusion: 'SUCCESS' },
  ],
});

const repaired = (over = {}) => observation({ repair: REPAIR, checks: CHECKS, ...over });

const postedComment = (over = {}) => ({
  id: 'IC_comment_1',
  url: 'https://github.com/GuitarAlchemist/gaia/pull/39#discussion_r1',
  marker: IDENTITY,
  ...over,
});

function fakeEffects({
  read = () => ({ isResolved: false, comments: [] }),
  post = () => postedComment(),
  resolve = () => ({ isResolved: true }),
} = {}) {
  const counts = new Map();
  const bump = (name) => counts.set(name, (counts.get(name) ?? 0) + 1);
  return {
    counts: (name) => counts.get(name) ?? 0,
    requests: [],
    port: Object.freeze({
      readReviewThread: async (request) => { bump('readReviewThread'); return read(request); },
      postReviewThreadComment: async (request) => {
        bump('postReviewThreadComment');
        return post(request);
      },
      resolveReviewThread: async (request) => { bump('resolveReviewThread'); return resolve(request); },
    }),
  };
}

function fakeAuthority({ consume } = {}) {
  const intents = [];
  return {
    intents,
    port: Object.freeze({
      async consume(request) {
        intents.push(request.intent);
        if (consume) return consume(request);
        return {
          status: 'AUTHORIZED',
          grantId: request.grant?.grantId ?? 'grant-1',
          intentRevision: request.intent.intentRevision,
        };
      },
    }),
  };
}

const drive = (directory, {
  observation: observed = observation(), effects, authority, owner = OWNER_A,
  now = NOW, leaseMs = LEASE_MS, grant = { grantId: 'grant-1' }, module,
} = {}) => (module ?? { runPrReviewThreadRepairPump }).runPrReviewThreadRepairPump({
  directory,
  observation: observed,
  grant,
  authority: (authority ?? fakeAuthority()).port,
  effects: (effects ?? fakeEffects()).port,
  owner,
  leaseMs,
  now: () => new Date(now),
});

const verbs = (directory, module) => (module ?? { readPrReviewRepairLedger })
  .readPrReviewRepairLedger({ directory }).transitions.map((entry) => entry.transition);

async function refusalCode(fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof PrReviewRepairError, `expected PrReviewRepairError, got ${error}`);
    return error.code;
  }
  return assert.fail('expected a refusal');
}

/** Drive one thread from first sight to a resolved thread. Three ticks, two effects. */
async function fullLifecycle(directory, ports = {}) {
  const effects = ports.effects ?? fakeEffects();
  const authority = ports.authority ?? fakeAuthority();
  const first = await drive(directory, { effects, authority });
  const second = await drive(directory, { observation: repaired(), effects, authority });
  const third = await drive(directory, { observation: repaired(), effects, authority });
  return { effects, authority, ticks: [first, second, third] };
}

/* ------------------------------------------------------------------------------------------- *
 * S1-S4 — one thread, one claim, and nothing published before its evidence
 * ------------------------------------------------------------------------------------------ */

test('S1: a fresh actionable thread is received, classified and claimed, and touches nothing', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  const tick = await drive(directory, { effects });
  assert.deepEqual(tick.appended, ['RECEIVED', 'CLASSIFIED', 'CLAIMED']);
  assert.equal(tick.outcome, 'CLAIMED');
  assert.equal(tick.threadIdentity, IDENTITY);
  assert.equal(tick.effect, 'NONE');
  assert.equal(tick.authority, 'NONE');
  assert.equal(effects.counts('postReviewThreadComment'), 0);
  assert.equal(effects.counts('resolveReviewThread'), 0);
  assert.deepEqual(verbs(directory), ['RECEIVED', 'CLASSIFIED', 'CLAIMED']);
});

test('S2: a non-actionable thread is received and classified, and never claimed', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  const tick = await drive(directory, {
    observation: observation({
      reviewThread: { comments: [comment({ body: '[P3] a smaller thing.' })] },
    }),
    effects,
  });
  assert.deepEqual(tick.appended, ['RECEIVED', 'CLASSIFIED']);
  assert.equal(tick.state, 'NOT_ACTIONABLE');
  // PROGRESSED, not NONE: two records landed. An outcome that said nothing happened while the
  // ledger grew would contradict `appended` in the same reading.
  assert.equal(tick.outcome, 'PROGRESSED');
  assert.equal(tick.blocksMerge, false);
  assert.equal(effects.counts('readReviewThread'), 0, 'a non-actionable thread asks GitHub nothing');
});

test('S3: the whole lifecycle runs, in order, with exactly one comment and one resolution', async () => {
  const directory = scratch();
  const { effects, ticks } = await fullLifecycle(directory);
  assert.equal(ticks[1].outcome, 'COMMENTED');
  assert.equal(ticks[2].outcome, 'RESOLVED');
  assert.equal(ticks[1].effect, 'GITHUB_REVIEW_THREAD_COMMENT');
  assert.equal(ticks[2].effect, 'GITHUB_REVIEW_THREAD_RESOLUTION');
  assert.equal(effects.counts('postReviewThreadComment'), 1);
  assert.equal(effects.counts('resolveReviewThread'), 1);

  const seen = verbs(directory);
  const distinct = PR_REVIEW_THREAD_TRANSITIONS.filter((verb) => seen.includes(verb));
  assert.deepEqual(distinct, [
    'RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED',
  ], 'every lifecycle transition issue #43 names is durable');
  assert.ok(
    seen.indexOf('COMMENTED') < seen.indexOf('RESOLVED'),
    'the evidence is on the pull request before the thread that would show it is closed',
  );
});

test('S4: a further tick after resolution performs nothing and appends nothing', async () => {
  const directory = scratch();
  const { effects } = await fullLifecycle(directory);
  const before = readPrReviewRepairLedger({ directory }).revision;
  const again = await drive(directory, {
    observation: repaired({ reviewThread: { isResolved: true } }), effects,
  });
  assert.deepEqual(again.appended, []);
  assert.equal(again.outcome, 'NONE');
  assert.equal(again.state, 'THREAD_RESOLVED');
  assert.equal(readPrReviewRepairLedger({ directory }).revision, before);
  assert.equal(effects.counts('resolveReviewThread'), 1, 'still exactly one resolution');
});

/* ------------------------------------------------------------------------------------------- *
 * S5-S9 — the compare-and-swap, the lease, and the orphan a killed owner leaves
 * ------------------------------------------------------------------------------------------ */

test('S5: a transition appended from a head the caller never observed is a lost update', async () => {
  const directory = scratch();
  await drive(directory, {});
  const ledger = readPrReviewRepairLedger({ directory });
  assert.equal(
    await refusalCode(() => appendPrReviewRepairTransition({
      directory,
      transition: { ...ledger.transitions[0], owner: OWNER_B, revision: undefined },
      expectedLedgerRevision: EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION,
    })),
    'LedgerCasMismatch',
  );
});

test('S6: replaying an identical transition is a no-op, from the head that wrote it', async () => {
  const directory = scratch();
  await drive(directory, {});
  const ledger = readPrReviewRepairLedger({ directory });
  const { revision, ...body } = ledger.transitions[0];
  const replayed = appendPrReviewRepairTransition({
    directory, transition: body, expectedLedgerRevision: EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION,
  });
  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.ledger.count, ledger.count, 'a retried caller adds nothing');
});

test('S7: a second supervisor holding no claim fails closed against an unexpired lease', async () => {
  const directory = scratch();
  await drive(directory, { owner: OWNER_A });
  const effects = fakeEffects();
  assert.equal(
    await refusalCode(() => drive(directory, {
      observation: repaired(), owner: OWNER_B, effects,
    })),
    'RepairInFlight',
  );
  assert.equal(effects.counts('postReviewThreadComment'), 0, 'the loser performs no effect');
  assert.deepEqual(verbs(directory), ['RECEIVED', 'CLASSIFIED', 'CLAIMED'], 'and writes nothing');
});

test('S8: an expired claim is an orphan — it reconciles instead of wedging forever', async () => {
  const directory = scratch();
  await drive(directory, { owner: OWNER_A });
  const later = new Date(Date.parse(NOW) + LEASE_MS + 1_000).toISOString();
  const effects = fakeEffects();
  const tick = await drive(directory, {
    observation: repaired(), owner: OWNER_B, now: later, effects,
  });
  assert.equal(tick.outcome, 'COMMENTED');
  assert.equal(effects.counts('readReviewThread'), 1, 'GitHub is asked exactly once');
  assert.equal(effects.counts('postReviewThreadComment'), 1);
});

test('S9: a caller resuming its own interrupted claim does not deadlock against itself', async () => {
  const directory = scratch();
  await drive(directory, { owner: OWNER_A });
  const tick = await drive(directory, { observation: repaired(), owner: OWNER_A });
  assert.equal(tick.outcome, 'COMMENTED', 'my own claim is not a stranger\'s claim');
});

/* ------------------------------------------------------------------------------------------- *
 * S10-S14 — a lost response, a missed delivery, and a thread somebody else closed
 * ------------------------------------------------------------------------------------------ */

test('S10: a comment whose response was lost is adopted by its marker, never posted twice', async () => {
  const directory = scratch();
  await drive(directory, {});
  // The request reached GitHub; the response did not. The ledger holds a claim and no COMMENTED.
  const lost = fakeEffects({ post: () => { throw new Error('socket closed'); } });
  assert.equal(
    await refusalCode(() => drive(directory, { observation: repaired(), effects: lost })),
    'EffectFailed',
  );

  const recovering = fakeEffects({
    read: () => ({ isResolved: false, comments: [postedComment()] }),
  });
  const tick = await drive(directory, {
    observation: repaired(),
    effects: recovering,
    now: new Date(Date.parse(NOW) + LEASE_MS + 1_000).toISOString(),
  });
  assert.equal(tick.outcome, 'COMMENTED');
  assert.equal(tick.effect, 'NONE', 'adoption is not an effect');
  assert.equal(tick.comment.id, 'IC_comment_1');
  assert.equal(recovering.counts('postReviewThreadComment'), 0, 'nothing is posted twice');
});

test('S11: a resolution whose response was lost is adopted from isResolved', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  await drive(directory, { effects });
  await drive(directory, { observation: repaired(), effects });
  const lost = fakeEffects({
    read: () => ({ isResolved: false, comments: [postedComment()] }),
    resolve: () => { throw new Error('socket closed'); },
  });
  assert.equal(
    await refusalCode(() => drive(directory, { observation: repaired(), effects: lost })),
    'EffectFailed',
  );

  const recovering = fakeEffects({
    read: () => ({ isResolved: true, comments: [postedComment()] }),
  });
  const tick = await drive(directory, {
    observation: repaired(),
    effects: recovering,
    now: new Date(Date.parse(NOW) + LEASE_MS + 1_000).toISOString(),
  });
  assert.equal(tick.outcome, 'RESOLVED');
  assert.equal(tick.effect, 'NONE');
  assert.equal(recovering.counts('resolveReviewThread'), 0, 'nothing is resolved twice');
});

test('S12: two comments carrying the identity marker fail closed rather than guess', async () => {
  const directory = scratch();
  await drive(directory, {});
  const ambiguous = fakeEffects({
    read: () => ({
      isResolved: false,
      comments: [postedComment(), postedComment({ id: 'IC_comment_2' })],
    }),
  });
  assert.equal(
    await refusalCode(() => drive(directory, { observation: repaired(), effects: ambiguous })),
    'ReconciliationAmbiguous',
  );
  assert.equal(ambiguous.counts('postReviewThreadComment'), 0);
});

test('S13: a thread a human resolved first is never claimed as this pump\'s resolution', async () => {
  const directory = scratch();
  await drive(directory, {});
  const closed = fakeEffects({ read: () => ({ isResolved: true, comments: [] }) });
  const tick = await drive(directory, { observation: repaired(), effects: closed });
  assert.equal(tick.state, 'THREAD_RESOLVED');
  assert.equal(tick.outcome, 'NONE');
  assert.equal(closed.counts('postReviewThreadComment'), 0);
  assert.ok(
    !verbs(directory).includes('RESOLVED'),
    'the ledger never records a resolution this pump did not perform',
  );
});

test('S14: a missed delivery reconciled by a later poll produces one lane, not a second', async () => {
  const directory = scratch();
  const { effects } = await fullLifecycle(directory);
  const before = readPrReviewRepairLedger({ directory }).revision;

  // The webhook for this thread was missed. The poller sees the same thread later, from a
  // different run, at a different clock, through a different supervisor.
  const polled = repaired({
    observedAt: '2026-09-01T09:00:00.000Z',
    run: { runId: 'reconciliation-sweep', laneGeneration: 9 },
    sourceRevision: '9'.repeat(64),
    reviewThread: { isResolved: true },
  });
  const tick = await drive(directory, {
    observation: polled, effects, owner: OWNER_C, now: '2026-09-01T09:00:00.000Z',
  });
  assert.equal(tick.threadIdentity, IDENTITY, 'the identity is the deduplication');
  assert.deepEqual(tick.appended, []);
  assert.equal(readPrReviewRepairLedger({ directory }).revision, before);
  assert.equal(effects.counts('postReviewThreadComment'), 1, 'exactly one comment, ever');
  assert.equal(effects.counts('resolveReviewThread'), 1, 'exactly one resolution, ever');

  const lanes = projectPrReviewRepairLedger({ directory }).projection.lanes;
  assert.equal(lanes.length, 1, 'one thread is one lane, however many deliveries it took');
});

/* ------------------------------------------------------------------------------------------- *
 * S15-S19 — the four refusals, re-derived from a fresh observation and never from the ledger
 * ------------------------------------------------------------------------------------------ */

test('S15: a finding that went stale between the claim and the resolution is refused', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  await drive(directory, { effects });
  await drive(directory, { observation: repaired(), effects });
  const tick = await drive(directory, {
    observation: repaired({ reviewThread: { isOutdated: true } }), effects,
  });
  assert.equal(tick.outcome, 'REFUSED');
  assert.equal(tick.refusal, 'FINDING_STALE');
  assert.equal(effects.counts('resolveReviewThread'), 0);
  assert.ok(verbs(directory).includes('REFUSED'));
});

test('S15b: a head that moved but whose anchor is re-proven still resolves, on the same lane', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  await drive(directory, { effects });
  await drive(directory, { observation: repaired(), effects });
  const tick = await drive(directory, {
    observation: repaired({ currentHeadOid: CURRENT_HEAD }), effects,
  });
  assert.equal(tick.outcome, 'RESOLVED');
  assert.equal(
    tick.threadIdentity, IDENTITY,
    'the current head is not identity; only the reviewed head the finding was made on is',
  );
  assert.equal(effects.counts('resolveReviewThread'), 1);
});

test('S16: a disputed thread is refused and never resolved', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  await drive(directory, { effects });
  await drive(directory, { observation: repaired(), effects });
  const tick = await drive(directory, {
    observation: repaired({ reviewThread: { disputed: true } }), effects,
  });
  assert.equal(tick.refusal, 'THREAD_DISPUTED');
  assert.equal(effects.counts('resolveReviewThread'), 0);
});

test('S17: an unverified repair is refused and never resolved', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  await drive(directory, { effects });
  await drive(directory, { observation: repaired(), effects });
  const tick = await drive(directory, {
    observation: repaired({
      checks: {
        ...CHECKS,
        conclusions: [
          { context: 'build', conclusion: 'SUCCESS' },
          { context: 'test', conclusion: 'FAILURE' },
        ],
      },
    }),
    effects,
  });
  assert.equal(tick.refusal, 'REPAIR_UNVERIFIED');
  assert.equal(effects.counts('resolveReviewThread'), 0);
});

test('S18: a partially addressed thread is refused and never resolved', async () => {
  const directory = scratch();
  const twoComments = {
    comments: [
      comment({ id: 'c1', body: 'P1: the first finding.' }),
      comment({ id: 'c2', body: 'P1: the second finding.' }),
    ],
  };
  const covered = { ...REPAIR, addressedCommentIds: ['c1', 'c2'] };
  const effects = fakeEffects();
  await drive(directory, { observation: observation({ reviewThread: twoComments }), effects });
  await drive(directory, {
    observation: repaired({ reviewThread: twoComments, repair: covered }), effects,
  });
  const tick = await drive(directory, {
    observation: repaired({
      reviewThread: twoComments, repair: { ...REPAIR, addressedCommentIds: ['c1'] },
    }),
    effects,
  });
  assert.equal(tick.refusal, 'PARTIALLY_ADDRESSED');
  assert.equal(effects.counts('resolveReviewThread'), 0);
});

test('S19: a refusal is terminal — a later tick never revives the lane', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  await drive(directory, { effects });
  await drive(directory, {
    observation: repaired({ reviewThread: { disputed: true } }), effects,
  });
  const after = readPrReviewRepairLedger({ directory }).revision;
  const revived = await drive(directory, { observation: repaired(), effects });
  assert.deepEqual(revived.appended, []);
  assert.equal(revived.state, 'REFUSED');
  assert.equal(readPrReviewRepairLedger({ directory }).revision, after);
  assert.equal(effects.counts('resolveReviewThread'), 0);
});

/* ------------------------------------------------------------------------------------------- *
 * S20-S23 — authority, and the boundary between commenting and resolving
 * ------------------------------------------------------------------------------------------ */

test('S20: each effect consumes its own grant, bound to its own durable intent', async () => {
  const directory = scratch();
  const authority = fakeAuthority();
  await fullLifecycle(directory, { authority });
  assert.equal(authority.intents.length, 2, 'two effects, two separately authorized intents');
  assert.deepEqual(
    authority.intents.map((intent) => intent.action),
    ['POST_REVIEW_THREAD_COMMENT', 'RESOLVE_REVIEW_THREAD'],
    'a grant for commenting cannot perform a resolution',
  );
  for (const intent of authority.intents) {
    assert.equal(intent.repository, 'GuitarAlchemist/gaia');
    assert.equal(intent.itemKind, 'PULL_REQUEST');
    assert.equal(intent.itemNumber, 39);
    assert.match(intent.intentRevision, /^[a-f0-9]{64}$/u);
    assert.equal(intent.snapshotRevision, SOURCE_REVISION);
  }
  assert.notEqual(
    authority.intents[0].intentRevision, authority.intents[1].intentRevision,
    'each intent is the durable record that actually preceded its request',
  );
});

test('S21: an authority refusal writes a refusal and performs no effect', async () => {
  const directory = scratch();
  await drive(directory, {});
  const effects = fakeEffects();
  const refusing = fakeAuthority({ consume: () => ({ status: 'DENIED' }) });
  assert.equal(
    await refusalCode(() => drive(directory, {
      observation: repaired(), effects, authority: refusing,
    })),
    'AuthorityRefused',
  );
  assert.equal(effects.counts('postReviewThreadComment'), 0);
  assert.ok(verbs(directory).includes('REFUSED'));
});

test('S22: the effect port is closed to exactly one read, one comment and one resolution', async () => {
  const directory = scratch();
  assert.equal(
    await refusalCode(() => runPrReviewThreadRepairPump({
      directory,
      observation: observation(),
      grant: { grantId: 'grant-1' },
      authority: fakeAuthority().port,
      effects: { readReviewThread: async () => ({ isResolved: false, comments: [] }) },
      owner: OWNER_A,
      now: () => new Date(NOW),
    })),
    'InvalidAdapter',
  );

  const source = readFileSync(REPAIR_MODULE, 'utf8');
  const methods = [...source.matchAll(/effects\.([A-Za-z]+)\(/gu)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(methods)].sort(),
    ['postReviewThreadComment', 'readReviewThread', 'resolveReviewThread'],
  );
});

test('S23: nothing in this slice can merge, approve, dismiss, push or close', async () => {
  for (const file of ['pr-review-thread.mjs', 'pr-review-thread-repair.mjs']) {
    const source = readFileSync(join(ROOT, 'src', file), 'utf8');
    // Argv-shaped and identifier-shaped, not substring-shaped: `merge-base --is-ancestor` is a
    // read-only question about the commit graph and must stay reachable.
    for (const token of [
      "'merge'", "'push'", "'--force'", "'approve'", "'dismiss'", "'close'", "'ready'",
      'mergePullRequest', 'approvePullRequest', 'dismissReview', 'markPullRequestReadyForReview',
    ]) {
      assert.ok(!source.includes(token), `${file} must not be able to spell ${token}`);
    }
  }
});

/* ------------------------------------------------------------------------------------------- *
 * S24-S27 — the durable record, its machine, and the DuckDB-readable projection
 * ------------------------------------------------------------------------------------------ */

test('S24: no existing durable machine is invalidated, and this one is its own', () => {
  assert.equal(
    PORTFOLIO_DRAIN_MACHINE.rulesRevision,
    '9d49b709619777fb0f39baf40c8e26e8cf7b65eb9626e17376ecc44d99b0afe8',
    'changing the drain rules would make every receipt already on disk unreadable',
  );
  assert.equal(
    FACTORY_TELEMETRY_MACHINE.rulesRevision,
    'f39674d9e0f36e576af868888250c021fae634dd27031f4eec06019d4e963af9',
    'changing the telemetry rules would make every event already on disk unreadable',
  );
  assert.equal(PR_REVIEW_REPAIR_MACHINE.machineId, 'gaia-pr-review-thread-repair');
  assert.equal(PR_REVIEW_REPAIR_MACHINE.machineVersion, 1);
  assert.match(PR_REVIEW_REPAIR_MACHINE.rulesRevision, /^[a-f0-9]{64}$/u);
  for (const existing of [PORTFOLIO_DRAIN_MACHINE, FACTORY_TELEMETRY_MACHINE]) {
    assert.notEqual(PR_REVIEW_REPAIR_MACHINE.machineId, existing.machineId);
    assert.notEqual(PR_REVIEW_REPAIR_MACHINE.rulesRevision, existing.rulesRevision);
  }
  assert.ok(PR_REVIEW_REPAIR_LEASE_MS > 0 && PR_REVIEW_REPAIR_LEASE_MS <= 3_600_000);
});

test('S25: a tampered record is detected on read, and the chain must be contiguous', async () => {
  const directory = scratch();
  await drive(directory, {});
  const path = prReviewRepairLedgerPath(directory);
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const record = JSON.parse(lines[0]);
  record.transition = { ...record.transition, severity: 'P3' };
  writeFileSync(path, [JSON.stringify(record), ...lines.slice(1)].join('\n') + '\n', 'utf8');
  assert.throws(() => readPrReviewRepairLedger({ directory }), /altered|revision|corrupt/iu);
});

test('S26: the projection is a deterministic, flat, DuckDB-readable relation', async () => {
  const directory = scratch();
  await fullLifecycle(directory);
  const projection = projectPrReviewRepairLedger({ directory });
  assert.equal(projection.schema, PR_REVIEW_REPAIR_PROJECTION_SCHEMA);
  assert.equal(projection.effect, 'NONE');
  assert.equal(projection.authority, 'NONE');
  assert.deepEqual(projection, projectPrReviewRepairLedger({ directory }), 'deterministic replay');

  const { rows } = projection.projection;
  assert.ok(rows.length >= 7);
  const columns = Object.keys(rows[0]).sort();
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), columns, 'a relation, not a bag of shapes');
    for (const [column, value] of Object.entries(row)) {
      assert.ok(
        value === null || ['string', 'number', 'boolean'].includes(typeof value),
        `${column} must be a scalar DuckDB can read from newline-delimited JSON`,
      );
    }
    assert.equal(JSON.parse(JSON.stringify(row)).threadIdentity, row.threadIdentity);
  }
  const ordinals = rows.map((row) => `${row.threadIdentity}:${String(row.ordinal).padStart(6, '0')}`);
  assert.deepEqual(ordinals, [...ordinals].sort(), 'sorted by identity then ordinal, not arrival');
  for (const verb of [
    'RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED',
  ]) {
    assert.ok(rows.some((row) => row.transition === verb), `the projection carries ${verb}`);
  }
});

test('S27: the transition schema is closed, and no review prose can reach a durable record', async () => {
  const directory = scratch();
  await fullLifecycle(directory, {
    effects: fakeEffects(),
  });
  const secret = 'the lock is released before the swap lands';
  const raw = readFileSync(prReviewRepairLedgerPath(directory), 'utf8');
  assert.ok(!raw.includes(secret), 'untrusted review prose never becomes durable');
  assert.ok(!raw.includes('body'), 'there is no field for it to arrive in');

  for (const transition of readPrReviewRepairLedger({ directory }).transitions) {
    assert.deepEqual(
      Object.keys(transition).sort(), [...PR_REVIEW_REPAIR_TRANSITION_FIELDS].sort(),
    );
  }
  assert.ok(PR_REVIEW_REPAIR_TRANSITION_FIELDS.includes('reviewedHeadOid'));
  assert.ok(PR_REVIEW_REPAIR_TRANSITION_FIELDS.includes('severity'));
  assert.ok(PR_REVIEW_REPAIR_TRANSITION_FIELDS.includes('reviewState'));
});

/* ------------------------------------------------------------------------------------------- *
 * S28-S30 — the repair sensor asks git about commits, and never about a working tree
 * ------------------------------------------------------------------------------------------ */

function repository() {
  const directory = scratch();
  const git = (...args) => execFileSync('git', args, {
    cwd: directory, encoding: 'utf8', windowsHide: true,
  });
  execFileSync('git', ['init', '-q', '-b', 'main', directory], { windowsHide: true });
  git('config', 'user.email', 'gate@example.invalid');
  git('config', 'user.name', 'Gate');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(directory, 'anchor.mjs'), 'export const value = 1;\n', 'utf8');
  writeFileSync(join(directory, 'other.mjs'), 'export const other = 1;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'reviewed head');
  const reviewedHeadOid = git('rev-parse', 'HEAD').trim();
  return { directory, git, reviewedHeadOid };
}

test('S28: a repair commit that fixes the anchored path is measured as evidence', () => {
  const { directory, git, reviewedHeadOid } = repository();
  writeFileSync(join(directory, 'anchor.mjs'), 'export const value = 2;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'repair');

  const measured = measurePrReviewThreadRepair({
    worktree: directory,
    reviewedHeadOid,
    repairRef: 'HEAD',
    anchorPath: 'anchor.mjs',
    addressedCommentIds: ['RT_comment_1'],
    observedAt: new Date().toISOString(),
  });
  assert.equal(measured.headOid, git('rev-parse', 'HEAD').trim());
  assert.equal(measured.descendsFromReviewedHead, true);
  assert.equal(measured.touchesAnchorPath, true);
  assert.equal(measured.commitsAheadOfReviewedHead, 1);
  assert.deepEqual(measured.addressedCommentIds, ['RT_comment_1']);
});

test('S29: a commit that touches another file, or an unrelated head, is reported as such', () => {
  const { directory, git, reviewedHeadOid } = repository();
  writeFileSync(join(directory, 'other.mjs'), 'export const other = 2;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'elsewhere');
  const elsewhere = measurePrReviewThreadRepair({
    worktree: directory,
    reviewedHeadOid,
    repairRef: 'HEAD',
    anchorPath: 'anchor.mjs',
    addressedCommentIds: [],
    observedAt: new Date().toISOString(),
  });
  assert.equal(elsewhere.touchesAnchorPath, false, 'a repair that misses the anchor is not proof');
  assert.equal(elsewhere.descendsFromReviewedHead, true);

  git('checkout', '-q', '--orphan', 'unrelated');
  git('commit', '-q', '--allow-empty', '-m', 'unrelated root');
  const unrelated = measurePrReviewThreadRepair({
    worktree: directory,
    reviewedHeadOid,
    repairRef: 'HEAD',
    anchorPath: 'anchor.mjs',
    addressedCommentIds: [],
    observedAt: new Date().toISOString(),
  });
  assert.equal(unrelated.descendsFromReviewedHead, false);
});

test('S30: an uncommitted change cannot move any value the sensor returns', () => {
  const { directory, git, reviewedHeadOid } = repository();
  writeFileSync(join(directory, 'anchor.mjs'), 'export const value = 2;\n', 'utf8');
  git('add', '-A');
  git('commit', '-q', '-m', 'repair');
  const observedAt = new Date().toISOString();
  const before = measurePrReviewThreadRepair({
    worktree: directory,
    reviewedHeadOid,
    repairRef: 'HEAD',
    anchorPath: 'anchor.mjs',
    addressedCommentIds: [],
    observedAt,
  });
  writeFileSync(join(directory, 'anchor.mjs'), 'export const value = 99;\n', 'utf8');
  writeFileSync(join(directory, 'staged.mjs'), 'export const staged = 1;\n', 'utf8');
  git('add', 'staged.mjs');
  assert.deepEqual(
    measurePrReviewThreadRepair({
      worktree: directory,
      reviewedHeadOid,
      repairRef: 'HEAD',
      anchorPath: 'anchor.mjs',
      addressedCommentIds: [],
      observedAt,
    }),
    before,
    'a dirty tree and a staged file are invisible because the sensor never asks about them',
  );

  const argv = [];
  measurePrReviewThreadRepair({
    worktree: directory,
    reviewedHeadOid,
    repairRef: 'HEAD',
    anchorPath: 'anchor.mjs',
    addressedCommentIds: [],
    observedAt,
    run: (worktree, args) => {
      argv.push(args);
      return execFileSync('git', args, { cwd: worktree, encoding: 'utf8', windowsHide: true });
    },
  });
  for (const args of argv) {
    for (const forbidden of ['status', 'stash', 'add', 'commit', 'checkout', '--cached', '--staged']) {
      assert.ok(!args.includes(forbidden), `the sensor must not ask git ${forbidden}: ${args}`);
    }
    if (args[0] === 'diff') {
      assert.ok(
        args.some((argument) => /^[a-f0-9]{40}\.\.[a-f0-9]{40}$/u.test(argument))
        || args.filter((argument) => /^[a-f0-9]{40}$/u.test(argument)).length === 2,
        `every diff is between two commits: ${args}`,
      );
    }
  }
});

/* ------------------------------------------------------------------------------------------- *
 * S31 — the interleaving no single-process barrier can stage
 * ------------------------------------------------------------------------------------------ */

const RACE_CHILD = `
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [modulePath, planPath, label] = process.argv.slice(2);
const plan = JSON.parse(readFileSync(planPath, 'utf8'));
const { runPrReviewThreadRepairPump } = await import(pathToFileURL(modulePath).href);

// A barrier, not a clock: it spins on a durable marker and never sleeps. The deadline exists only
// so that a sibling which dies cannot hang the suite.
const spin = (path) => {
  const deadline = Date.now() + 60000;
  while (!existsSync(path)) {
    if (Date.now() > deadline) throw new Error('barrier timed out: ' + path);
  }
};
const meet = (prefix, attempt) => {
  writeFileSync(join(plan.root, prefix + attempt + '.' + label), label, 'utf8');
  for (const other of plan.labels) spin(join(plan.root, prefix + attempt + '.' + other));
};

const results = [];
for (let attempt = 0; attempt < plan.attempts; attempt += 1) {
  meet('gate-', attempt);
  let posts = 0;
  let outcome = null;
  let code = null;
  try {
    const tick = await runPrReviewThreadRepairPump({
      directory: join(plan.root, 'ledger-' + attempt),
      observation: plan.observation,
      grant: { grantId: 'grant-' + label },
      authority: {
        async consume(request) {
          return {
            status: 'AUTHORIZED',
            grantId: 'grant-' + label,
            intentRevision: request.intent.intentRevision,
          };
        },
      },
      effects: {
        async readReviewThread() {
          // Both processes have now read the same durable head. Release them together.
          meet('read-', attempt);
          return { isResolved: false, comments: [] };
        },
        async postReviewThreadComment() { posts += 1; return plan.comment; },
        async resolveReviewThread() { return { isResolved: true }; },
      },
      owner: plan.owner,
      leaseMs: plan.leaseMs,
      now: () => new Date(plan.now),
    });
    outcome = tick.outcome;
  } catch (error) {
    code = typeof error.code === 'string' ? error.code : error.name;
  }
  results.push({ attempt, posts, outcome, code });
  meet('done-', attempt);
}
writeFileSync(join(plan.root, 'result.' + label + '.json'), JSON.stringify(results), 'utf8');
`;

test('S31 CROSS-PROCESS: two supervisors post exactly one comment on one thread', async () => {
  const root = scratch();
  const child = join(root, 'race-child.mjs');
  const attempts = 6;
  const labels = ['A', 'B'];
  const owners = { A: OWNER_A, B: OWNER_B };
  const ledger = (attempt) => join(root, `ledger-${attempt}`);

  // Each round starts from a lane already carried to VERIFIED under a THIRD owner whose lease has
  // run out. Both racers therefore reconcile, which is what puts an awaited port call between
  // their ledger read and the compare-and-swap that orders them.
  const seeded = new Date(Date.parse(NOW) - LEASE_MS - 60_000).toISOString();
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const effects = fakeEffects();
    await drive(ledger(attempt), { owner: OWNER_C, now: seeded, effects });
    await drive(ledger(attempt), {
      observation: repaired(),
      owner: OWNER_C,
      now: seeded,
      effects: fakeEffects({ post: () => { throw new Error('socket closed'); } }),
    }).catch(() => {});
    assert.ok(verbs(ledger(attempt)).includes('VERIFIED'), 'the lane is staged at VERIFIED');
    assert.ok(!verbs(ledger(attempt)).includes('COMMENTED'), 'and has not commented');
  }

  writeFileSync(child, RACE_CHILD, 'utf8');
  const planPath = (label) => join(root, `plan-${label}.json`);
  for (const label of labels) {
    writeFileSync(planPath(label), JSON.stringify({
      attempts,
      labels,
      root,
      owner: owners[label],
      leaseMs: LEASE_MS,
      now: NOW,
      observation: repaired(),
      comment: postedComment(),
    }), 'utf8');
  }

  const run = (label) => new Promise((settle, reject) => {
    const racer = spawn(
      process.execPath, [child, REPAIR_MODULE, planPath(label), label],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let diagnostics = '';
    racer.stderr.on('data', (chunk) => { diagnostics += chunk; });
    racer.on('error', reject);
    racer.on('close', (code) => (code === 0
      ? settle()
      : reject(new Error(`race child ${label} exited ${code}: ${diagnostics}`))));
  });
  await Promise.all(labels.map(run));

  const reported = Object.fromEntries(labels.map((label) => [
    label, JSON.parse(readFileSync(join(root, `result.${label}.json`), 'utf8')),
  ]));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const round = labels.map((label) => reported[label][attempt]);
    const seen = JSON.stringify(round);
    assert.equal(
      round.reduce((total, entry) => total + entry.posts, 0), 1,
      `attempt ${attempt}: exactly one process may post a comment; got ${seen}`,
    );
    assert.equal(
      round.filter((entry) => entry.outcome === 'COMMENTED').length, 1,
      `attempt ${attempt}: exactly one process may report COMMENTED; got ${seen}`,
    );
    const loser = round.find((entry) => entry.outcome !== 'COMMENTED');
    assert.ok(
      ['RepairRaceLost', 'RepairInFlight'].includes(loser.code),
      `attempt ${attempt}: the loser must fail closed by name; got ${seen}`,
    );
    assert.equal(
      verbs(ledger(attempt)).filter((verb) => verb === 'COMMENTED').length, 1,
      `attempt ${attempt}: the durable ledger records exactly one comment; got ${seen}`,
    );
  }
});

/* ------------------------------------------------------------------------------------------- *
 * S32-S35 — mechanism-revert controls
 * ------------------------------------------------------------------------------------------ */

const MUTANTS = mkdtempSync(join(tmpdir(), 'gaia-pr-review-thread-mutants-'));
test.after(() => rmSync(MUTANTS, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

/**
 * Write one mutated copy of a shipped module, IMPORT it, and hand back the live module.
 *
 * A control that only greps for a literal cannot fail when a mechanism is removed — it fails when
 * a variable is renamed. Every control below therefore RUNS its mutant and asserts a behavioural
 * divergence; `assert.notEqual` here is only the stale-find-string guard, never the assertion.
 */
async function importMutant(name, file, mutate) {
  const source = readFileSync(join(ROOT, 'src', file), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing; its find-string is stale`);
  const rewritten = mutated.replaceAll(
    "from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`,
  );
  const path = join(MUTANTS, `${name}.mjs`);
  writeFileSync(path, rewritten, 'utf8');
  return import(pathToFileURL(path).href);
}

test('S32 MECHANISM REVERT: without the compare-and-swap a lost update lands', async () => {
  const mutant = await importMutant(
    'repair-cas-reverted', 'pr-review-thread-repair.mjs',
    (source) => source.replace(
      'const divergent = before.revision !== expectedLedgerRevision;',
      'const divergent = false;',
    ),
  );
  const directory = scratch();
  await drive(directory, { module: mutant });
  const ledger = mutant.readPrReviewRepairLedger({ directory });
  const { revision, ...body } = ledger.transitions[0];
  mutant.appendPrReviewRepairTransition({
    directory,
    transition: { ...body, owner: OWNER_B },
    expectedLedgerRevision: mutant.EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION,
  });
  assert.equal(
    mutant.readPrReviewRepairLedger({ directory }).count, ledger.count + 1,
    'with the compare-and-swap reverted a caller that observed nothing still lands a record',
  );
});

test('S33 MECHANISM REVERT: without the marker match a lost response becomes a second comment', async () => {
  const mutant = await importMutant(
    'repair-reconciliation-reverted', 'pr-review-thread-repair.mjs',
    (source) => source.replace(
      '(entry) => entry.marker === threadIdentity',
      '() => false',
    ),
  );
  const directory = scratch();
  await drive(directory, { module: mutant });
  const duplicating = fakeEffects({
    read: () => ({ isResolved: false, comments: [postedComment()] }),
  });
  const tick = await drive(directory, {
    observation: repaired(), effects: duplicating, module: mutant,
  });
  assert.equal(tick.outcome, 'COMMENTED');
  assert.equal(
    duplicating.counts('postReviewThreadComment'), 1,
    'with reconciliation reverted the already-posted comment is posted a second time',
  );
});

test('S34 MECHANISM REVERT: without the applicability gate a stale finding is resolved', async () => {
  const mutant = await importMutant(
    'applicability-reverted', 'pr-review-thread.mjs',
    (source) => source.replace(
      "if (applicable.verdict !== 'APPLIES') {",
      'if (false) {',
    ),
  );
  const stale = observation({
    repair: REPAIR, checks: CHECKS, reviewThread: { isOutdated: true },
  });
  const reading = mutant.planPrReviewThreadRepair({
    observation: stale,
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(
    reading.action, 'RESOLVE',
    'with the applicability gate reverted a thread GitHub calls outdated is resolved anyway',
  );
});

test('S35 MECHANISM REVERT: without the coverage superset a partial repair is resolved', async () => {
  const mutant = await importMutant(
    'coverage-reverted', 'pr-review-thread.mjs',
    (source) => source.replace(
      'actionableCommentIds.every((id) => addressed.has(id))',
      'actionableCommentIds.some((id) => addressed.has(id))',
    ),
  );
  const partial = observation({
    repair: { ...REPAIR, addressedCommentIds: ['c1'] },
    checks: CHECKS,
    reviewThread: {
      comments: [
        comment({ id: 'c1', body: 'P1: the first finding.' }),
        comment({ id: 'c2', body: 'P1: the second finding.' }),
      ],
    },
  });
  const reading = mutant.planPrReviewThreadRepair({
    observation: partial,
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(
    reading.action, 'RESOLVE',
    'with the superset reverted, addressing one of two P1 comments closes the whole thread',
  );
});

/* ------------------------------------------------------------------------------------------- *
 * S36 — the identity marker that makes reconciliation exact rather than probable
 * ------------------------------------------------------------------------------------------ */

test('S36: the identity marker is derived from the identity and appears in the posted body', async () => {
  const marker = repairIdentityMarker(IDENTITY);
  assert.ok(marker.includes(IDENTITY));
  assert.equal(repairIdentityMarker(IDENTITY), marker, 'the marker is a function of the identity');

  const directory = scratch();
  let posted = null;
  const effects = fakeEffects({
    post: (request) => { posted = request; return postedComment(); },
  });
  await drive(directory, { effects });
  await drive(directory, { observation: repaired(), effects });
  assert.equal(posted.threadIdentity, IDENTITY);
  assert.ok(posted.body.includes(marker), '"probably ours" is how one lane adopts another\'s work');
  assert.match(posted.idempotencyKey, /^[a-f0-9]{64}$/u);
});
