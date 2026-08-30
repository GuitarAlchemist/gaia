import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  ObstructionError,
  PORTFOLIO_DRAIN_OBSTRUCTION_SCHEMA,
  PORTFOLIO_DRAIN_OBSTRUCTION_STATES,
  THROUGHPUT_STALL_WINDOW_MS,
  classifyPortfolioDrainObstruction,
} from '../src/portfolio-drain-obstruction.mjs';

const SHA = 'a'.repeat(64);
const DEPENDENCY_SHA = 'b'.repeat(64);
const MODULE_PATH = fileURLToPath(new URL('../src/portfolio-drain-obstruction.mjs', import.meta.url));

const scratch = mkdtempSync(join(tmpdir(), 'gaia-obstruction-mutant-'));
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

function item(itemId, drainState, overrides = {}) {
  return {
    repository: 'GuitarAlchemist/gaia',
    itemKind: 'ISSUE',
    itemId,
    itemNumber: Number(itemId.replace(/\D/gu, '')) || 1,
    title: `Work item ${itemId}`,
    sourceState: 'READY',
    observedPortfolioRevision: SHA,
    drainState,
    hold: null,
    ...overrides,
  };
}

function projection(items = [], { occupied = 0, available = 4, decisions = [] } = {}) {
  const body = {
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: SHA,
    effect: 'NONE',
    authority: 'NONE',
    capacity: 4,
    counts: { occupied, available },
    items,
    decisions,
  };
  return {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

/** A window long enough that a stall is a measured claim rather than an impatient one. */
const LONG_WINDOW = {
  windowStartedAt: '2026-08-29T18:30:20.000Z',
  observedAt: '2026-08-29T18:40:20.000Z',
};
const SHORT_WINDOW = {
  windowStartedAt: '2026-08-29T18:40:00.000Z',
  observedAt: '2026-08-29T18:40:20.000Z',
};

test('an empty drain is NO_ELIGIBLE_WORK bound to its exact evidence, window and recovery', () => {
  const drainProjection = projection();

  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection, ...LONG_WINDOW,
  });

  assert.equal(obstruction.schema, PORTFOLIO_DRAIN_OBSTRUCTION_SCHEMA);
  assert.equal(obstruction.state, 'NO_ELIGIBLE_WORK');
  assert.equal(obstruction.effect, 'NONE');
  assert.equal(obstruction.authority, 'NONE');
  assert.equal(obstruction.evidenceRevision, drainProjection.revision);
  assert.equal(obstruction.dependencyEvidenceRevision, null);
  assert.deepEqual(obstruction.observationWindow, {
    startedAt: '2026-08-29T18:30:20.000Z',
    endedAt: '2026-08-29T18:40:20.000Z',
    durationMs: 600_000,
  });
  assert.deepEqual(obstruction.affectedItemIds, []);
  assert.equal(obstruction.affectedCount, 0);
  assert.equal(obstruction.recovery.kind, 'SURVEY_PORTFOLIO_FOR_NEW_WORK');
  assert.equal(obstruction.recovery.effect, 'NONE');
  assert.equal(obstruction.recovery.authority, 'NONE');
  assert.equal(obstruction.recovery.advisory, true);
  assert.match(obstruction.recovery.label, /\S/u);
  const { revision, ...body } = obstruction;
  assert.equal(revision, createHash('sha256').update(canonicalJson(body)).digest('hex'));
  assert.equal(Object.isFrozen(obstruction), true);
  assert.equal(Object.isFrozen(obstruction.recovery), true);
});

test('NEGATIVE CONTROL: an empty drain and a systemically blocked drain never share an answer', () => {
  const empty = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-1', 'TERMINAL_MERGED'), item('issue-2', 'TERMINAL_CLOSED'),
    ]),
    ...LONG_WINDOW,
  });
  const blocked = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-1', 'BLOCKED_EVIDENCE'), item('issue-2', 'BLOCKED_EVIDENCE'),
    ]),
    ...LONG_WINDOW,
  });

  assert.notEqual(empty.state, blocked.state);
  assert.equal(empty.state, 'NO_ELIGIBLE_WORK');
  assert.equal(blocked.state, 'EVIDENCE_STARVATION');
  assert.deepEqual(blocked.affectedItemIds, ['issue-1', 'issue-2']);
  assert.equal(blocked.affectedCount, 2);
  assert.equal(blocked.recovery.kind, 'COLLECT_MISSING_EVIDENCE');
  assert.match(blocked.label, /2/u);
  assert.deepEqual(blocked.breakdown, [{ state: 'EVIDENCE_STARVATION', count: 2 }]);
});

test('NEGATIVE CONTROL: healthy long-running work is not an obstruction, an expired lane is', () => {
  const drainProjection = projection([item('issue-17', 'RUNNING')], {
    occupied: 1, available: 3,
  });

  const healthy = classifyPortfolioDrainObstruction({
    drainProjection, ...LONG_WINDOW, liveness: [{ itemId: 'issue-17', state: 'ACTIVE' }],
  });
  const expired = classifyPortfolioDrainObstruction({
    drainProjection, ...LONG_WINDOW, liveness: [{ itemId: 'issue-17', state: 'STALE' }],
  });

  assert.equal(healthy.state, 'NONE');
  assert.equal(healthy.recovery, null);
  assert.deepEqual(healthy.affectedItemIds, []);
  assert.equal(expired.state, 'LANE_STALE');
  assert.deepEqual(expired.affectedItemIds, ['issue-17']);
  assert.equal(expired.recovery.kind, 'CHECK_STALE_LANE');
});

test('a claimed lane with no liveness evidence fails closed to LANE_STALE, never to health', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-17', 'CLAIMED')], { occupied: 1, available: 3 }),
    ...LONG_WINDOW,
  });

  assert.equal(obstruction.state, 'LANE_STALE');
  assert.deepEqual(obstruction.affectedItemIds, ['issue-17']);
});

test('eligible work and free capacity that have not moved over the window are a THROUGHPUT_STALL', () => {
  const drainProjection = projection([
    item('issue-1', 'QUEUED'), item('issue-2', 'QUEUED'),
  ], {
    decisions: [{
      action: 'CLAIM_FACTORY_RUN', repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE',
      itemId: 'issue-1', itemNumber: 1, effect: 'NONE', requiredAuthority: 'FACTORY_RUN',
    }],
  });

  const stalled = classifyPortfolioDrainObstruction({ drainProjection, ...LONG_WINDOW });
  const tooEarly = classifyPortfolioDrainObstruction({ drainProjection, ...SHORT_WINDOW });

  assert.equal(THROUGHPUT_STALL_WINDOW_MS, 300_000);
  assert.equal(stalled.state, 'THROUGHPUT_STALL');
  assert.deepEqual(stalled.affectedItemIds, ['issue-1', 'issue-2']);
  assert.equal(stalled.recovery.kind, 'CLAIM_QUEUED_WORK');
  assert.match(stalled.label, /10m/u, 'the measured window is stated, not implied');
  assert.equal(tooEarly.state, 'NONE', 'below the window no stall is claimed');
  assert.equal(tooEarly.observationWindow.durationMs, 20_000);
});

test('a full portfolio with no free capacity is not reported as a throughput stall', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-1', 'QUEUED'), item('issue-2', 'RUNNING'),
    ], { occupied: 4, available: 0 }),
    ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-2', state: 'ACTIVE' }],
  });

  assert.equal(obstruction.state, 'NONE');
});

test('a dependency cycle is reported only from explicitly declared edges', () => {
  const drainProjection = projection([
    item('issue-1', 'QUEUED', { title: 'Blocked by issue-2 and issue-3' }),
    item('issue-2', 'QUEUED', { title: 'Depends on issue-1' }),
    item('issue-3', 'QUEUED', { title: 'Waits for issue-2' }),
  ]);
  const dependencies = {
    evidenceRevision: DEPENDENCY_SHA,
    edges: [
      { itemId: 'issue-1', dependsOnItemId: 'issue-2' },
      { itemId: 'issue-2', dependsOnItemId: 'issue-3' },
      { itemId: 'issue-3', dependsOnItemId: 'issue-1' },
    ],
  };

  const declared = classifyPortfolioDrainObstruction({
    drainProjection, ...LONG_WINDOW, dependencies,
  });
  const proseOnly = classifyPortfolioDrainObstruction({ drainProjection, ...LONG_WINDOW });

  assert.equal(declared.state, 'DEPENDENCY_DEADLOCK');
  assert.deepEqual(declared.affectedItemIds, ['issue-1', 'issue-2', 'issue-3']);
  assert.equal(declared.dependencyEvidenceRevision, DEPENDENCY_SHA);
  assert.equal(declared.recovery.kind, 'BREAK_DEPENDENCY_CYCLE');
  assert.equal(
    proseOnly.state, 'THROUGHPUT_STALL',
    'identical prose without declared edges never becomes a deadlock',
  );
});

test('declared edges that form no cycle are not a deadlock', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-1', 'QUEUED'), item('issue-2', 'QUEUED'), item('issue-3', 'QUEUED'),
    ]),
    ...LONG_WINDOW,
    dependencies: {
      evidenceRevision: DEPENDENCY_SHA,
      edges: [
        { itemId: 'issue-1', dependsOnItemId: 'issue-2' },
        { itemId: 'issue-2', dependsOnItemId: 'issue-3' },
      ],
    },
  });

  assert.equal(obstruction.state, 'THROUGHPUT_STALL');
  assert.equal(obstruction.dependencyEvidenceRevision, DEPENDENCY_SHA);
});

test('a cycle whose members are terminal cannot obstruct anything', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-1', 'TERMINAL_MERGED'), item('issue-2', 'TERMINAL_CLOSED'),
    ]),
    ...LONG_WINDOW,
    dependencies: {
      evidenceRevision: DEPENDENCY_SHA,
      edges: [
        { itemId: 'issue-1', dependsOnItemId: 'issue-2' },
        { itemId: 'issue-2', dependsOnItemId: 'issue-1' },
      ],
    },
  });

  assert.equal(obstruction.state, 'NO_ELIGIBLE_WORK');
});

test('an item declared to depend on itself is a one-member cycle', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'QUEUED')]),
    ...LONG_WINDOW,
    dependencies: {
      evidenceRevision: DEPENDENCY_SHA,
      edges: [{ itemId: 'issue-1', dependsOnItemId: 'issue-1' }],
    },
  });

  assert.equal(obstruction.state, 'DEPENDENCY_DEADLOCK');
  assert.deepEqual(obstruction.affectedItemIds, ['issue-1']);
});

test('RECONCILE_REQUIRED outranks every other observation, including a live lane', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-1', 'RECONCILE_REQUIRED'), item('issue-2', 'RUNNING'),
    ], { occupied: 1, available: 3 }),
    ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-2', state: 'ACTIVE' }],
  });

  assert.equal(obstruction.state, 'RECONCILE_REQUIRED');
  assert.deepEqual(obstruction.affectedItemIds, ['issue-1']);
  assert.equal(obstruction.recovery.kind, 'RECONCILE_DRAIN_EVIDENCE');
});

test('starvation precedence runs nearest the exit first and hides no contributing cause', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-1', 'AWAITING_MERGE_AUTHORITY', { itemKind: 'PULL_REQUEST' }),
      item('issue-2', 'BLOCKED_REVIEW'),
      item('issue-3', 'BLOCKED_DRAFT'),
      item('issue-4', 'BLOCKED_EVIDENCE'),
      item('issue-5', 'BLOCKED_UNKNOWN'),
      item('issue-6', 'BLOCKED_TRIAGE'),
    ]),
    ...LONG_WINDOW,
  });

  assert.equal(obstruction.state, 'AUTHORITY_STARVATION');
  assert.deepEqual(obstruction.affectedItemIds, ['issue-1']);
  assert.equal(obstruction.recovery.kind, 'REQUEST_EXPLICIT_AUTHORITY');
  assert.deepEqual(obstruction.breakdown, [
    { state: 'AUTHORITY_STARVATION', count: 1 },
    { state: 'EVIDENCE_STARVATION', count: 3 },
    { state: 'REVIEW_STARVATION', count: 2 },
  ]);
});

test('review starvation is reported when no item is waiting on authority', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([
      item('issue-2', 'BLOCKED_REVIEW'), item('issue-4', 'BLOCKED_EVIDENCE'),
    ]),
    ...LONG_WINDOW,
  });

  assert.equal(obstruction.state, 'REVIEW_STARVATION');
  assert.deepEqual(obstruction.affectedItemIds, ['issue-2']);
  assert.equal(obstruction.recovery.kind, 'REQUEST_INDEPENDENT_REVIEW');
});

test('consumed authority is a named starvation, never a retryable state', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-9', 'FAILED_AUTHORITY_CONSUMED')]),
    ...LONG_WINDOW,
  });

  assert.equal(obstruction.state, 'AUTHORITY_STARVATION');
  assert.match(obstruction.recovery.label, /\S/u);
  assert.doesNotMatch(canonicalJson(obstruction), /retry|restart|re-run/iu);
});

test('a source claiming a dependency without declared edges is an evidence gap, not a deadlock', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'BLOCKED_DEPENDENCY')]),
    ...LONG_WINDOW,
  });

  assert.equal(obstruction.state, 'EVIDENCE_STARVATION');
  assert.deepEqual(obstruction.affectedItemIds, ['issue-1']);
});

test('an unrecognised drain state fails closed to a named epistemic state, never to NONE', () => {
  const obstruction = classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'SOME_FUTURE_DRAIN_STATE')]),
    ...LONG_WINDOW,
  });

  assert.equal(obstruction.state, 'EVIDENCE_STARVATION');
  assert.deepEqual(obstruction.affectedItemIds, ['issue-1']);
});

test('every reported state belongs to the closed vocabulary', () => {
  assert.deepEqual([...PORTFOLIO_DRAIN_OBSTRUCTION_STATES].sort(), [
    'AUTHORITY_STARVATION', 'DEPENDENCY_DEADLOCK', 'EVIDENCE_STARVATION', 'LANE_STALE',
    'NONE', 'NO_ELIGIBLE_WORK', 'RECONCILE_REQUIRED', 'REVIEW_STARVATION', 'THROUGHPUT_STALL',
  ]);
  for (const drainState of [
    'QUEUED', 'CLAIMED', 'RUNNING', 'CANDIDATE_READY', 'PUBLISHED', 'AWAITING_MERGE_AUTHORITY',
    'BLOCKED_UNKNOWN', 'BLOCKED_DEPENDENCY', 'BLOCKED_HUMAN', 'BLOCKED_DRAFT', 'BLOCKED_EVIDENCE',
    'BLOCKED_REVIEW', 'BLOCKED_TRIAGE', 'BLOCKED_POLICY', 'TERMINAL_DUPLICATE',
    'TERMINAL_ARCHIVED', 'TERMINAL_MERGED', 'TERMINAL_CLOSED', 'TERMINAL_REJECTED',
    'FAILED_AUTHORITY_CONSUMED', 'RECONCILE_REQUIRED',
  ]) {
    const obstruction = classifyPortfolioDrainObstruction({
      drainProjection: projection([item('issue-1', drainState)]), ...LONG_WINDOW,
    });
    assert.equal(
      PORTFOLIO_DRAIN_OBSTRUCTION_STATES.includes(obstruction.state), true,
      `${drainState} produced ${obstruction.state}`,
    );
    if (obstruction.state !== 'NONE') {
      assert.equal(obstruction.evidenceRevision.length, 64);
      assert.equal(typeof obstruction.observationWindow.durationMs, 'number');
      assert.equal(obstruction.affectedCount, obstruction.affectedItemIds.length);
      assert.equal(obstruction.recovery.effect, 'NONE');
      assert.equal(obstruction.recovery.authority, 'NONE');
    }
  }
});

test('a projection whose revision does not match its content is refused, not classified', () => {
  const tampered = { ...projection([item('issue-1', 'QUEUED')]), capacity: 3 };

  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: tampered, ...LONG_WINDOW,
  }), (error) => error instanceof ObstructionError && error.code === 'InvalidProjection');
});

test('a projection claiming an effect or an authority is refused', () => {
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: { ...projection(), authority: 'FACTORY_RUN' }, ...LONG_WINDOW,
  }), (error) => error instanceof ObstructionError && error.code === 'InvalidProjection');
});

test('a window that ends before it starts is refused: evidence from the future is a broken sensor', () => {
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: projection(),
    windowStartedAt: '2026-08-29T18:40:20.000Z',
    observedAt: '2026-08-29T18:30:20.000Z',
  }), (error) => error instanceof ObstructionError && error.code === 'InvalidWindow');
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: projection(), windowStartedAt: 'not-a-time',
    observedAt: '2026-08-29T18:40:20.000Z',
  }), (error) => error instanceof ObstructionError && error.code === 'InvalidWindow');
});

test('an undecided or unknown liveness token is refused rather than guessed', () => {
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'RUNNING')]), ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-1', state: 'MAYBE' }],
  }), (error) => error instanceof ObstructionError && error.code === 'InvalidLiveness');
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'RUNNING')]), ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-2', state: 'ACTIVE' }],
  }), (error) => error instanceof ObstructionError && error.code === 'InvalidLiveness');
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'RUNNING')]), ...LONG_WINDOW,
    liveness: [
      { itemId: 'issue-1', state: 'ACTIVE' }, { itemId: 'issue-1', state: 'STALE' },
    ],
  }), (error) => error instanceof ObstructionError && error.code === 'InvalidLiveness');
});

test('dependency evidence without an exact revision, or naming an unknown item, is refused', () => {
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'QUEUED')]), ...LONG_WINDOW,
    dependencies: { edges: [{ itemId: 'issue-1', dependsOnItemId: 'issue-1' }] },
  }), (error) => error instanceof ObstructionError
    && error.code === 'InvalidDependencyEvidence');
  assert.throws(() => classifyPortfolioDrainObstruction({
    drainProjection: projection([item('issue-1', 'QUEUED')]), ...LONG_WINDOW,
    dependencies: {
      evidenceRevision: DEPENDENCY_SHA,
      edges: [{ itemId: 'issue-1', dependsOnItemId: 'issue-absent' }],
    },
  }), (error) => error instanceof ObstructionError
    && error.code === 'InvalidDependencyEvidence');
});

test('the same evidence classifies identically on replay and mutates no input', () => {
  const build = () => ({
    drainProjection: projection([
      item('issue-1', 'QUEUED'), item('issue-2', 'BLOCKED_EVIDENCE'),
    ]),
    ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-1', state: 'IDLE' }],
    dependencies: {
      evidenceRevision: DEPENDENCY_SHA,
      edges: [{ itemId: 'issue-1', dependsOnItemId: 'issue-2' }],
    },
  });
  const first = build();
  const before = canonicalJson(first);

  const left = classifyPortfolioDrainObstruction(first);
  const right = classifyPortfolioDrainObstruction(build());

  assert.equal(left.revision, right.revision);
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalJson(first), before, 'the classifier mutates none of its inputs');
});

test('the module owns no clock, provider, network, filesystem or retry loop', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');

  assert.deepEqual(
    [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map(([, from]) => from),
    ['node:crypto'],
  );
  for (const forbidden of [
    'Date.now', 'new Date', 'setTimeout', 'setInterval', 'fetch(', 'child_process',
    'node:fs', 'node:http', 'process.env', 'Math.random',
    // No retry loop: nothing here waits, sleeps, catches a failure and tries again, or
    // becomes asynchronous. The one `while` in the module is a bounded traversal of a
    // finite declared-edge graph, which terminates on the graph and never on a clock.
    'async ', 'await ', 'Promise', 'catch', 'retry', 'attempt', 'sleep',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear`);
  }
});

/**
 * Mutation witnesses. Each takes the shipped source, changes exactly one load-bearing
 * declaration in a copy written outside this repository, imports the mutant and asserts the
 * fixtures above notice. A fixture that cannot tell the mutant from the original is not
 * testing the mechanism, and this file would be vacuous without these.
 */
async function importMutant(name, find, replace) {
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.equal(
    source.includes(find), true,
    `the mutation witness targets "${find}", which is no longer in the source`,
  );
  const mutated = source.replace(find, replace);
  assert.notEqual(mutated, source);
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, mutated, 'utf8');
  return import(pathToFileURL(path).href);
}

test('MUTATION WITNESS: the fail-closed unobserved-lane rule is load-bearing', async () => {
  const mutant = await importMutant(
    'lane-liveness',
    "const UNOBSERVED_LANE_LIVENESS = 'STALE';",
    "const UNOBSERVED_LANE_LIVENESS = 'IDLE';",
  );
  const input = {
    drainProjection: projection([item('issue-17', 'CLAIMED')], { occupied: 1, available: 3 }),
    ...LONG_WINDOW,
  };

  assert.equal(classifyPortfolioDrainObstruction(input).state, 'LANE_STALE');
  assert.notEqual(mutant.classifyPortfolioDrainObstruction(input).state, 'LANE_STALE');
});

test('MUTATION WITNESS: the measured stall window is load-bearing', async () => {
  const mutant = await importMutant(
    'stall-window',
    'export const THROUGHPUT_STALL_WINDOW_MS = 300_000;',
    'export const THROUGHPUT_STALL_WINDOW_MS = 0;',
  );
  const input = { drainProjection: projection([item('issue-1', 'QUEUED')]), ...SHORT_WINDOW };

  assert.equal(classifyPortfolioDrainObstruction(input).state, 'NONE');
  assert.equal(mutant.classifyPortfolioDrainObstruction(input).state, 'THROUGHPUT_STALL');
});

test('MUTATION WITNESS: breaking terminal detection reports a blocked drain as an empty one', async () => {
  const mutant = await importMutant(
    'terminal-prefix',
    "const TERMINAL_STATE_PREFIX = 'TERMINAL_';",
    "const TERMINAL_STATE_PREFIX = 'BLOCKED_';",
  );
  const empty = { drainProjection: projection([item('issue-1', 'TERMINAL_MERGED')]), ...LONG_WINDOW };
  const blocked = { drainProjection: projection([item('issue-1', 'BLOCKED_EVIDENCE')]), ...LONG_WINDOW };

  assert.equal(classifyPortfolioDrainObstruction(empty).state, 'NO_ELIGIBLE_WORK');
  assert.equal(classifyPortfolioDrainObstruction(blocked).state, 'EVIDENCE_STARVATION');
  assert.equal(
    mutant.classifyPortfolioDrainObstruction(blocked).state, 'NO_ELIGIBLE_WORK',
    'the mutant declares a fully blocked drain empty — the exact failure F1 names',
  );
  assert.notEqual(
    mutant.classifyPortfolioDrainObstruction(empty).state,
    classifyPortfolioDrainObstruction(empty).state,
  );
});

/**
 * R1 blocker 1 — liveness is a property of lanes, not of every item the projection carries.
 *
 * The design's precedence clause 3 reads "If any *lane* is live, the drain is draining: NONE."
 * An ACTIVE token on a terminal or a blocked item is not a live lane, and must not erase a real
 * obstruction. These are discriminating negative controls: the projection, the window and the
 * declared evidence are held identical and only the item the ACTIVE token sits on varies.
 */
test('NEGATIVE CONTROL: an ACTIVE token on a terminal item never erases a real obstruction', () => {
  const drainProjection = projection([
    item('issue-1', 'BLOCKED_EVIDENCE'),
    item('issue-2', 'BLOCKED_EVIDENCE'),
    item('pr-9', 'TERMINAL_MERGED'),
  ]);

  const unobserved = classifyPortfolioDrainObstruction({ drainProjection, ...LONG_WINDOW });
  const terminalActive = classifyPortfolioDrainObstruction({
    drainProjection, ...LONG_WINDOW, liveness: [{ itemId: 'pr-9', state: 'ACTIVE' }],
  });

  assert.equal(unobserved.state, 'EVIDENCE_STARVATION');
  assert.equal(
    terminalActive.state, 'EVIDENCE_STARVATION',
    'a merged pull request is not a live lane and cannot report the drain healthy',
  );
  assert.deepEqual(terminalActive.affectedItemIds, ['issue-1', 'issue-2']);
  assert.equal(terminalActive.affectedCount, 2);
  assert.equal(terminalActive.recovery.kind, 'COLLECT_MISSING_EVIDENCE');
  assert.deepEqual(
    terminalActive.breakdown, [{ state: 'EVIDENCE_STARVATION', count: 2 }],
    'the breakdown already told the truth; the reported state must now agree with it',
  );
});

test('NEGATIVE CONTROL: an ACTIVE token on a blocked or non-lane item erases nothing', () => {
  const blockedDrain = projection([
    item('issue-1', 'BLOCKED_EVIDENCE'),
    item('issue-2', 'BLOCKED_HUMAN'),
    item('issue-3', 'CANDIDATE_READY'),
  ]);
  const stalledDrain = projection([item('issue-1', 'QUEUED'), item('issue-2', 'QUEUED')]);

  const blockedActive = classifyPortfolioDrainObstruction({
    drainProjection: blockedDrain, ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-1', state: 'ACTIVE' }],
  });
  const candidateActive = classifyPortfolioDrainObstruction({
    drainProjection: blockedDrain, ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-3', state: 'ACTIVE' }],
  });
  const queuedActive = classifyPortfolioDrainObstruction({
    drainProjection: stalledDrain, ...LONG_WINDOW,
    liveness: [{ itemId: 'issue-1', state: 'ACTIVE' }],
  });

  assert.equal(
    blockedActive.state, 'AUTHORITY_STARVATION',
    'a blocked item is not a lane, so its liveness token decides nothing',
  );
  assert.deepEqual(blockedActive.affectedItemIds, ['issue-2']);
  assert.equal(
    candidateActive.state, 'AUTHORITY_STARVATION',
    'a candidate that has never been claimed is not an occupied lane',
  );
  assert.deepEqual(candidateActive.affectedItemIds, ['issue-2']);
  assert.equal(
    queuedActive.state, 'THROUGHPUT_STALL',
    'queued work is what the stall is about; a token on it cannot dismiss the stall',
  );
  assert.deepEqual(queuedActive.affectedItemIds, ['issue-1', 'issue-2']);
});

test('a live lane still reports NONE, so the repair narrowed the predicate and not the policy', () => {
  const drainProjection = projection([
    item('issue-1', 'BLOCKED_EVIDENCE'),
    item('issue-17', 'RUNNING'),
    item('issue-18', 'CLAIMED'),
  ], { occupied: 2, available: 2 });

  const running = classifyPortfolioDrainObstruction({
    drainProjection,
    ...LONG_WINDOW,
    liveness: [
      { itemId: 'issue-17', state: 'ACTIVE' }, { itemId: 'issue-18', state: 'ACTIVE' },
    ],
  });
  const claimedOnly = classifyPortfolioDrainObstruction({
    drainProjection,
    ...LONG_WINDOW,
    liveness: [
      { itemId: 'issue-17', state: 'IDLE' }, { itemId: 'issue-18', state: 'ACTIVE' },
    ],
  });

  assert.equal(running.state, 'NONE');
  assert.equal(running.recovery, null);
  assert.equal(claimedOnly.state, 'NONE', 'one live CLAIMED lane is still a draining drain');
});

test('MUTATION WITNESS: scoping liveness to lanes is load-bearing', async () => {
  const mutant = await importMutant(
    'liveness-scope',
    "const moving = lanes.some(({ itemId }) => decidedLiveness.get(itemId) === 'ACTIVE');",
    "const moving = projection.items.some(({ itemId }) => decidedLiveness.get(itemId) === 'ACTIVE');",
  );
  const input = {
    drainProjection: projection([
      item('issue-1', 'BLOCKED_EVIDENCE'), item('pr-9', 'TERMINAL_MERGED'),
    ]),
    ...LONG_WINDOW,
    liveness: [{ itemId: 'pr-9', state: 'ACTIVE' }],
  };

  assert.equal(classifyPortfolioDrainObstruction(input).state, 'EVIDENCE_STARVATION');
  assert.equal(
    mutant.classifyPortfolioDrainObstruction(input).state, 'NONE',
    'reverting the scope to every item restores the R0 defect: a blocked drain reported healthy',
  );
  assert.equal(mutant.classifyPortfolioDrainObstruction(input).recovery, null);
});
