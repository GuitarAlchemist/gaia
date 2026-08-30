import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildControlRoomSnapshot } from '../src/control-room.mjs';
import {
  ACTIVITY_BULLET_KINDS,
  ACTIVITY_CODES,
  ACTIVITY_EVIDENCE_STATES,
  ACTIVITY_SOURCES,
  CONTROL_ROOM_ACTIVITY_MACHINE,
  CONTROL_ROOM_ACTIVITY_SCHEMA,
  MAX_ACTIVITY_BYTES,
  MAX_ACTIVITY_ITEMS,
  MAX_BULLETS_PER_ITEM,
  MAX_BULLET_TEXT_CHARS,
  requireControlRoomActivity,
  summarizeControlRoomActivity,
} from '../src/control-room-activity.mjs';
import {
  buildFactoryTelemetryEvent,
  replayFactoryTelemetry,
} from '../src/factory-telemetry.mjs';

const SHA = 'a'.repeat(64);
const MODULE_PATH = fileURLToPath(new URL('../src/control-room-activity.mjs', import.meta.url));
const mutantScratch = mkdtempSync(join(tmpdir(), 'gaia-control-room-activity-mutant-'));
test.after(() => rmSync(mutantScratch, { recursive: true, force: true }));

/** The worst case the closed vocabulary admits: a 32-character `TOKEN`, the maximum. */
const LONG_GATE = 'INDEPENDENT_REVIEW_LONG_GATE_ABC';
const LONG_BLOCKER = 'TRANSITION_NOT_PERMITTED_LONGEST';

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

function projection(items = [], decisions = []) {
  const body = {
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: SHA,
    effect: 'NONE',
    authority: 'NONE',
    capacity: 4,
    counts: { occupied: 0, available: 4 },
    items,
    decisions,
  };
  return { ...body, revision: sha256(canonicalJson(body)) };
}

function item(overrides = {}) {
  return {
    repository: 'GuitarAlchemist/gaia',
    itemKind: 'ISSUE',
    itemId: 'issue-17',
    itemNumber: 17,
    title: 'Integrate the factory control room',
    sourceState: 'READY',
    observedPortfolioRevision: SHA,
    drainState: 'RUNNING',
    hold: null,
    ...overrides,
  };
}

const TELEMETRY_SUBJECT = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemId: 'issue-17',
  itemNumber: 17,
  lane: 'LANE_A',
  agent: 'CLAUDE_WORKER',
  itemRevision: SHA,
});

/** Replay a real telemetry run through the public kernel, never a hand-written stub. */
function telemetry(steps, { subject = TELEMETRY_SUBJECT, runId = 'run-17-alpha' } = {}) {
  let previous = null;
  const events = steps.map((step) => {
    previous = buildFactoryTelemetryEvent({ runId, subject, previous, ...step });
    return previous;
  });
  return replayFactoryTelemetry({ events });
}

const progressObservation = (stage, capturedAt, heartbeat = true) => ({
  itemId: 'issue-17',
  capturedAt,
  record: {
    schema: 'gaia-cli-progress/1',
    stage,
    elapsedMs: 35_000,
    remainingProviderInvocations: 4,
    remainingProviderTimeUpperBoundMs: 2_400_000,
    heartbeat,
  },
});

/** Re-seal a hand-edited snapshot body so only the edited field differs from an honest one. */
function reseal(snapshot, edit) {
  const draft = structuredClone(snapshot);
  edit(draft);
  delete draft.revision;
  return { ...draft, revision: sha256(canonicalJson(draft)) };
}

const bulletsOf = (activity, index = 0) => activity.items[index].bullets;
const codesOf = (activity, index = 0) => bulletsOf(activity, index).map(({ code }) => code);
const textsOf = (activity, index = 0) => bulletsOf(activity, index).map(({ text }) => text);

/**
 * Load a one-expression mutant of the shipped Module, so a witness can prove the expression it
 * targets is the thing doing the work rather than passing for an unrelated reason.
 */
async function importMutant(name, find, replace) {
  const source = readFileSync(MODULE_PATH, 'utf8');
  assert.equal(
    source.includes(find), true,
    `the mutation witness targets "${find}", which is no longer in the source`,
  );
  const mutated = source.replace(find, replace);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const mutantPath = join(mutantScratch, `${name}.mjs`);
  writeFileSync(mutantPath, mutated, 'utf8');
  return import(pathToFileURL(mutantPath).href);
}

// ---------------------------------------------------------------------------
// 1-3: what an active task says, where each sentence came from, and what it binds
// ---------------------------------------------------------------------------

const BETWEEN_GATES_RUN = [
  { event: 'run.started', observedAt: '2026-08-29T18:39:00.000Z' },
  { event: 'gate.entered', gate: 'WORKER', observedAt: '2026-08-29T18:39:05.000Z' },
  {
    event: 'gate.passed',
    gate: 'WORKER',
    observedAt: '2026-08-29T18:39:58.000Z',
    evidenceRevision: 'b'.repeat(64),
  },
  { event: 'run.heartbeat', observedAt: '2026-08-29T18:40:10.000Z' },
];

const activeSnapshot = (observedAt = '2026-08-29T18:40:20.000Z') => buildControlRoomSnapshot({
  drainProjection: projection([item({ drainState: 'RUNNING' })]),
  observedAt,
  telemetryProjection: telemetry(BETWEEN_GATES_RUN),
});

test('an active run says what it is doing, what it produced and what evidence comes next', () => {
  const snapshot = activeSnapshot();

  const activity = summarizeControlRoomActivity({ snapshot });

  assert.equal(activity.schema, CONTROL_ROOM_ACTIVITY_SCHEMA);
  assert.equal(activity.effect, 'NONE');
  assert.equal(activity.authority, 'NONE');
  assert.equal(activity.items.length, 1);
  assert.equal(bulletsOf(activity).length, MAX_BULLETS_PER_ITEM);
  assert.deepEqual(
    bulletsOf(activity).map(({ kind }) => kind), ['ACTION', 'RESULT', 'CHECKPOINT'],
  );
  assert.deepEqual(codesOf(activity), ['BETWEEN_GATES', 'GATE_PASSED', 'AWAIT_GATE_OR_COMPLETION']);
  assert.deepEqual(textsOf(activity), [
    'Running between gates.',
    'Gate WORKER passed.',
    'Next verifiable evidence: a gate.entered record, or run.completed.',
  ]);
  assert.equal(activity.items[0].evidenceState, 'FRESH');
  assert.equal(activity.items[0].runId, 'run-17-alpha');
  assert.equal(activity.items[0].lane, 'LANE_A');
  assert.equal(activity.items[0].agent, 'CLAUDE_WORKER');
  assert.deepEqual(activity.counts, { fresh: 1, partial: 0, stale: 0, unknown: 0, items: 1 });
  assert.equal(activity.omittedCount, 0);
});

test('every bullet names its source, whether that source is verified, and the evidence it binds', () => {
  const activity = summarizeControlRoomActivity({ snapshot: activeSnapshot() });
  const [action, result, checkpoint] = bulletsOf(activity);

  for (const bullet of bulletsOf(activity)) {
    assert.equal(ACTIVITY_BULLET_KINDS.includes(bullet.kind), true);
    assert.equal(ACTIVITY_SOURCES.includes(bullet.source), true);
    assert.equal(ACTIVITY_EVIDENCE_STATES.includes(bullet.evidenceState), true);
    assert.equal(typeof bullet.verified, 'boolean');
    assert.equal(Object.hasOwn(bullet, 'evidenceRevision'), true);
    assert.equal(Object.hasOwn(bullet, 'observedAt'), true);
  }
  assert.equal(action.source, 'TELEMETRY');
  assert.equal(action.verified, true);
  assert.equal(action.evidenceRevision, 'b'.repeat(64));
  assert.equal(action.observedAt, '2026-08-29T18:39:58.000Z');
  assert.equal(result.source, 'TELEMETRY');
  assert.equal(result.verified, true);
  assert.equal(result.evidenceRevision, 'b'.repeat(64));
  assert.equal(result.observedAt, '2026-08-29T18:39:58.000Z');
  assert.deepEqual(result.params, { gate: 'WORKER' });
  // A checkpoint names evidence that does not exist yet, so it can bind no digest.
  assert.equal(checkpoint.evidenceRevision, null);
});

test('the summary is bound to the exact snapshot, source and telemetry revisions it read', () => {
  const snapshot = activeSnapshot();

  const activity = summarizeControlRoomActivity({ snapshot });

  assert.equal(activity.snapshotRevision, snapshot.revision);
  assert.equal(activity.sourceRevision, snapshot.sourceRevision);
  assert.equal(activity.telemetryRevision, snapshot.telemetry.projectionRevision);
  assert.equal(activity.observedAt, snapshot.observedAt);
  assert.equal(activity.freshnessWindowMs, snapshot.telemetry.freshnessWindowMs);
  assert.deepEqual(activity.machine, CONTROL_ROOM_ACTIVITY_MACHINE);
  assert.match(activity.machine.rulesRevision, /^[a-f0-9]{64}$/u);

  const { revision, ...body } = activity;
  assert.equal(revision, sha256(canonicalJson(body)));
  const { contentRevision, ...rest } = body;
  assert.equal(
    contentRevision,
    sha256(canonicalJson({ machine: rest.machine, items: rest.items })),
    'contentRevision covers what the summary says, and nothing that moves with the clock',
  );
  assert.equal(Object.isFrozen(activity), true);
  assert.equal(Object.isFrozen(activity.items), true);
  assert.equal(Object.isFrozen(bulletsOf(activity)[0]), true);
  assert.equal(Object.isFrozen(bulletsOf(activity)[0].params), true);
  assert.deepEqual(requireControlRoomActivity(activity), activity);
});

// ---------------------------------------------------------------------------
// 4-5: the two negative controls that must never read as health
// ---------------------------------------------------------------------------

test('NEGATIVE CONTROL: an expired heartbeat is STALE, keeps its last known facts, and invents nothing', () => {
  const fresh = summarizeControlRoomActivity({ snapshot: activeSnapshot() });
  const expired = summarizeControlRoomActivity({
    snapshot: activeSnapshot('2026-08-29T18:40:40.001Z'),
  });

  assert.equal(expired.items[0].evidenceState, 'STALE');
  assert.deepEqual(codesOf(expired), codesOf(fresh), 'the recorded facts did not change');
  assert.deepEqual(textsOf(expired), textsOf(fresh), 'and no new sentence was invented');
  for (const bullet of bulletsOf(expired)) assert.equal(bullet.evidenceState, 'STALE');
  assert.deepEqual(expired.counts, { fresh: 0, partial: 0, stale: 1, unknown: 0, items: 1 });
  assert.deepEqual(
    bulletsOf(expired).map(({ observedAt }) => observedAt),
    bulletsOf(fresh).map(({ observedAt }) => observedAt),
    'no age was refreshed: the instants belong to the evidence, not to the page',
  );
});

test('NEGATIVE CONTROL: an occupied lane with no observation is UNKNOWN, never healthy and never silent', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'CLAIMED' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  const activity = summarizeControlRoomActivity({ snapshot });

  assert.equal(activity.items.length, 1, 'absence of evidence is reported, never omitted');
  assert.deepEqual(codesOf(activity), [
    'LANE_CLAIMED_UNOBSERVED', 'NO_VERIFIED_RESULT', 'AWAIT_RUN_STARTED',
  ]);
  assert.equal(activity.items[0].evidenceState, 'UNKNOWN');
  assert.equal(activity.items[0].runId, null);
  assert.deepEqual(activity.counts, { fresh: 0, partial: 0, stale: 0, unknown: 1, items: 1 });
  assert.deepEqual(textsOf(activity), [
    'Lane claimed; no start record has been observed.',
    'No verified result has been recorded for this item.',
    'Next verifiable evidence: a run.started record for this lane.',
  ]);
});

// ---------------------------------------------------------------------------
// 6-7: the heartbeat is inert, by assertion rather than by intention
// ---------------------------------------------------------------------------

test('a tick carrying only heartbeats changes no byte of what the summary says', () => {
  const before = summarizeControlRoomActivity({
    snapshot: buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'RUNNING' })]),
      observedAt: '2026-08-29T18:40:12.000Z',
      telemetryProjection: telemetry(BETWEEN_GATES_RUN),
    }),
  });
  const after = summarizeControlRoomActivity({
    snapshot: buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'RUNNING' })]),
      observedAt: '2026-08-29T18:40:41.000Z',
      telemetryProjection: telemetry([
        ...BETWEEN_GATES_RUN,
        { event: 'run.heartbeat', observedAt: '2026-08-29T18:40:20.000Z' },
        { event: 'run.heartbeat', observedAt: '2026-08-29T18:40:30.000Z' },
        { event: 'run.heartbeat', observedAt: '2026-08-29T18:40:40.000Z' },
      ]),
    }),
  });

  assert.equal(before.items[0].evidenceState, 'FRESH');
  assert.equal(after.items[0].evidenceState, 'FRESH', 'freshness stayed in the same state');
  assert.equal(
    after.contentRevision, before.contentRevision,
    'three heartbeats and eleven seconds changed nothing the summary says',
  );
  assert.deepEqual(canonicalJson(after.items), canonicalJson(before.items));
  assert.notEqual(
    after.revision, before.revision,
    'the value is still re-dated and re-bound, so it cannot be replayed as the older one',
  );
});

test('no checkpoint ever names a heartbeat as the next evidence', () => {
  const runs = [
    BETWEEN_GATES_RUN,
    [...BETWEEN_GATES_RUN, { event: 'gate.entered', gate: 'REVIEW', observedAt: '2026-08-29T18:40:11.000Z' }],
    [...BETWEEN_GATES_RUN, { event: 'run.completed', observedAt: '2026-08-29T18:40:11.000Z' }],
    [...BETWEEN_GATES_RUN, { event: 'run.blocked', blocker: 'NEEDS_HUMAN', observedAt: '2026-08-29T18:40:11.000Z' }],
  ];
  const summaries = runs.map((steps) => summarizeControlRoomActivity({
    snapshot: buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'RUNNING' })]),
      observedAt: '2026-08-29T18:40:20.000Z',
      telemetryProjection: telemetry(steps),
    }),
  }));
  const unobserved = summarizeControlRoomActivity({
    snapshot: buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'CLAIMED' })]),
      observedAt: '2026-08-29T18:40:20.000Z',
    }),
  });

  for (const activity of [...summaries, unobserved]) {
    for (const bullet of bulletsOf(activity)) {
      assert.doesNotMatch(
        bullet.text, /heartbeat/iu,
        `${bullet.code} offered a heartbeat as something to wait for`,
      );
      assert.doesNotMatch(canonicalJson(bullet.params), /heartbeat/iu);
    }
  }
  assert.equal(
    summaries.some(({ items }) => items[0].bullets.some(({ kind }) => kind === 'CHECKPOINT')),
    true,
    'and the assertion is not vacuous: checkpoints were emitted',
  );
});

// ---------------------------------------------------------------------------
// 8-10: blocked, unverified and finished-but-unreconciled
// ---------------------------------------------------------------------------

test('a blocked run gets a blocker bullet and no invented next checkpoint', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    telemetryProjection: telemetry([
      ...BETWEEN_GATES_RUN,
      { event: 'run.blocked', blocker: 'NEEDS_HUMAN', observedAt: '2026-08-29T18:40:11.000Z' },
    ]),
  });

  const activity = summarizeControlRoomActivity({ snapshot });

  assert.deepEqual(codesOf(activity), ['RUN_BLOCKED', 'RUN_BLOCKED_RESULT', 'TELEMETRY_BLOCKED']);
  assert.deepEqual(
    bulletsOf(activity).map(({ kind }) => kind), ['ACTION', 'RESULT', 'BLOCKER'],
  );
  assert.equal(
    bulletsOf(activity).some(({ kind }) => kind === 'CHECKPOINT'), false,
    'a blocked run admits no next transition, so naming one would be a fabricated expectation',
  );
  assert.equal(bulletsOf(activity)[2].text, 'Blocked: NEEDS_HUMAN. The run recorded this and stopped.');
});

test('NEGATIVE CONTROL: an unverified CLI progress record can describe an action but never a result', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [progressObservation('worker_running', '2026-08-29T18:40:15.000Z')],
  });

  const activity = summarizeControlRoomActivity({ snapshot });
  const [action, result] = bulletsOf(activity);

  assert.equal(action.code, 'PROGRESS_STAGE');
  assert.equal(action.source, 'PROGRESS');
  assert.equal(action.verified, false);
  assert.deepEqual(action.params, { stage: 'WORKER_RUNNING' });
  assert.equal(action.text, 'Worker running — reported by the run itself, unverified.');
  assert.equal(
    action.observedAt, null,
    'an unchained self-report binds no instant this publisher can verify',
  );
  assert.equal(result.code, 'NO_VERIFIED_RESULT');
  assert.equal(result.source !== 'PROGRESS', true, 'an unverified source may never fill RESULT');
  assert.equal(activity.items[0].evidenceState, 'PARTIAL');
  assert.deepEqual(activity.counts, { fresh: 0, partial: 1, stale: 0, unknown: 0, items: 1 });
});

test('a finished run whose drain has not caught up says so instead of looking hung', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    telemetryProjection: telemetry([
      ...BETWEEN_GATES_RUN,
      {
        event: 'run.completed',
        observedAt: '2026-08-29T18:40:11.000Z',
        evidenceRevision: 'c'.repeat(64),
      },
    ]),
  });

  const activity = summarizeControlRoomActivity({ snapshot });

  assert.deepEqual(codesOf(activity), [
    'RUN_FINISHED', 'RUN_COMPLETED', 'AWAIT_DRAIN_RECONCILIATION',
  ]);
  assert.equal(
    bulletsOf(activity)[2].text,
    'Run finished; the drain has not yet recorded the matching transition.',
  );
  assert.equal(bulletsOf(activity)[1].evidenceRevision, 'c'.repeat(64));
});

// ---------------------------------------------------------------------------
// 11: a snapshot is evidence, so it is verified rather than trusted
// ---------------------------------------------------------------------------

test('a tampered snapshot is refused, not summarized', () => {
  const honest = activeSnapshot();
  const edited = structuredClone(honest);
  edited.items[0].drainState = 'TERMINAL_MERGED';

  for (const [label, candidate] of [
    ['content moved under an unchanged revision', edited],
    ['a claimed effect', reseal(honest, (draft) => { draft.effect = 'WRITE'; })],
    ['a claimed authority', reseal(honest, (draft) => { draft.authority = 'MERGE'; })],
    ['an unsupported schema', reseal(honest, (draft) => { draft.schema = 'gaia-control-room/2'; })],
    ['no snapshot at all', null],
  ]) {
    assert.throws(
      () => summarizeControlRoomActivity({ snapshot: candidate }),
      (error) => error?.name === 'ControlRoomActivityError' && error.code === 'InvalidSnapshot',
      `${label} must be refused`,
    );
  }
});

// ---------------------------------------------------------------------------
// 12-13: the closed phrasebook, its size budget, and what can never appear
// ---------------------------------------------------------------------------

const LONG_RUN = [
  { event: 'run.started', observedAt: '2026-08-29T18:39:00.000Z' },
  { event: 'gate.entered', gate: LONG_GATE, observedAt: '2026-08-29T18:39:05.000Z' },
];

/** One fixture per reachable phrasebook code, at the worst case the vocabulary admits. */
function everyCodeFixture() {
  const at = '2026-08-29T18:40:20.000Z';
  const running = (steps, drainState = 'RUNNING') => buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState })]),
    observedAt: at,
    telemetryProjection: telemetry(steps),
  });
  const stages = [
    'validating', 'execution_starting', 'authorized_execution', 'worker_running',
    'worker_completed', 'initial_review_running', 'initial_review_verdict', 'repair_running',
    'repair_completed', 'final_review_running', 'final_review_verdict', 'terminal_outcome',
    'an unrecognised stage nobody declared',
  ];
  return [
    running(LONG_RUN),
    running([...LONG_RUN, { event: 'gate.passed', gate: LONG_GATE, observedAt: '2026-08-29T18:39:10.000Z' }]),
    running([...LONG_RUN, { event: 'gate.failed', gate: LONG_GATE, observedAt: '2026-08-29T18:39:10.000Z' }]),
    running([...LONG_RUN, { event: 'run.blocked', blocker: LONG_BLOCKER, observedAt: '2026-08-29T18:39:10.000Z' }]),
    running([{ event: 'run.started', observedAt: '2026-08-29T18:39:00.000Z' }, { event: 'run.completed', observedAt: '2026-08-29T18:39:10.000Z' }]),
    running([{ event: 'run.started', observedAt: '2026-08-29T18:39:00.000Z' }]),
    running(LONG_RUN, 'BLOCKED_REVIEW'),
    reseal(running(LONG_RUN), (draft) => { draft.items[0].telemetry.runState = 'SOMETHING_ELSE'; }),
    buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'CLAIMED' })]), observedAt: at,
    }),
    buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'RUNNING' })]), observedAt: at,
    }),
    ...stages.map((stage) => buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'RUNNING' })]),
      observedAt: at,
      progressObservations: [progressObservation(stage, '2026-08-29T18:40:15.000Z')],
    })),
  ].map((snapshot) => summarizeControlRoomActivity({ snapshot }));
}

test('every phrasebook sentence stays inside the size budget and exercises the whole vocabulary', () => {
  const seen = new Set();

  for (const activity of everyCodeFixture()) {
    for (const bullet of bulletsOf(activity)) {
      seen.add(bullet.code);
      assert.equal(
        bullet.text.length <= MAX_BULLET_TEXT_CHARS, true,
        `${bullet.code} renders ${bullet.text.length} characters: "${bullet.text}"`,
      );
    }
    assert.equal(
      new TextEncoder().encode(canonicalJson(activity)).length <= MAX_ACTIVITY_BYTES, true,
    );
  }
  assert.deepEqual(
    [...seen].sort(), [...ACTIVITY_CODES].sort(),
    'the fixture set must exercise every code the closed phrasebook can emit',
  );
});

test('no bullet can carry prose, a newline, a control character or a URL', () => {
  const everything = [
    ...everyCodeFixture(),
    summarizeControlRoomActivity({ snapshot: activeSnapshot() }),
  ];

  for (const activity of everything) {
    for (const { text, params, code, evidenceRevision } of activity.items.flatMap(
      ({ bullets }) => bullets,
    )) {
      assert.equal(ACTIVITY_CODES.includes(code), true, `${code} is outside the closed vocabulary`);
      assert.doesNotMatch(text, /[\u0000-\u001f\u007f]/u, 'no control character or newline');
      assert.doesNotMatch(text, /https?:|www\.|[<>{}$`]/u, 'no URL and no markup');
      for (const value of Object.values(params)) {
        assert.match(
          String(value), /^[A-Z][A-Z0-9_]{0,31}$/u,
          'every interpolated value is a closed TOKEN',
        );
      }
      assert.equal(
        evidenceRevision === null || evidenceRevision === 'UNKNOWN'
          || /^[a-f0-9]{64}$/u.test(evidenceRevision),
        true,
        'an evidence reference is a digest, the honest UNKNOWN sentinel, or absent',
      );
    }
  }
});

// ---------------------------------------------------------------------------
// 14-16: determinism, the cap, and the module's own purity
// ---------------------------------------------------------------------------

test('the same snapshot summarizes identically on replay and mutates no input', () => {
  const snapshot = activeSnapshot();
  const before = canonicalJson(snapshot);

  const left = summarizeControlRoomActivity({ snapshot });
  const right = summarizeControlRoomActivity({ snapshot });

  assert.equal(left.revision, right.revision);
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.equal(canonicalJson(snapshot), before, 'the summary mutates none of its inputs');
});

test('at most eight items are summarized and the remainder is counted, never dropped', () => {
  const numbers = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection(numbers.map((itemNumber) => item({
      itemId: `issue-${itemNumber}`, itemNumber, drainState: 'RUNNING',
    }))),
    observedAt: '2026-08-29T18:40:20.000Z',
  });

  const activity = summarizeControlRoomActivity({ snapshot });

  assert.equal(activity.items.length, MAX_ACTIVITY_ITEMS);
  assert.equal(activity.omittedCount, 4);
  assert.deepEqual(
    activity.items.map(({ itemNumber }) => itemNumber), [1, 2, 3, 4, 5, 6, 7, 8],
  );
  assert.equal(activity.counts.items, MAX_ACTIVITY_ITEMS);
  assert.equal(
    new TextEncoder().encode(canonicalJson(activity)).length <= MAX_ACTIVITY_BYTES, true,
    'the declared item cap must fit inside the declared byte cap',
  );
});

test('the module owns no clock, provider, network, filesystem or retry loop', () => {
  const source = readFileSync(MODULE_PATH, 'utf8');

  assert.deepEqual(
    [...source.matchAll(/^import .* from '([^']+)';$/gmu)].map(([, from]) => from),
    ['node:crypto'],
  );
  for (const forbidden of [
    'Date.now', 'new Date', 'setTimeout', 'setInterval', 'fetch(', 'child_process',
    'node:fs', 'node:http', 'node:net', 'process.env', 'Math.random',
    'async ', 'await ', 'Promise', 'catch', 'retry', 'sleep',
  ]) {
    assert.equal(source.includes(forbidden), false, `${forbidden} must not appear`);
  }
});

// ---------------------------------------------------------------------------
// mutation witnesses: a fixture that cannot detect the mutant is not testing the mechanism
// ---------------------------------------------------------------------------

test('MUTATION WITNESS: the unverified-source marking is what keeps a self-report out of health', async () => {
  const mutant = await importMutant(
    'progress-is-verified',
    'const PROGRESS_IS_VERIFIED = false;',
    'const PROGRESS_IS_VERIFIED = true;',
  );
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item({ drainState: 'RUNNING' })]),
    observedAt: '2026-08-29T18:40:20.000Z',
    progressObservations: [progressObservation('worker_running', '2026-08-29T18:40:15.000Z')],
  });

  const mutated = mutant.summarizeControlRoomActivity({ snapshot });
  const shipped = summarizeControlRoomActivity({ snapshot });

  assert.equal(mutated.items[0].evidenceState, 'FRESH', 'the mutant reads a self-report as health');
  assert.equal(mutated.items[0].bullets[0].verified, true);
  assert.equal(shipped.items[0].evidenceState, 'PARTIAL');
  assert.equal(shipped.items[0].bullets[0].verified, false);
});

test('MUTATION WITNESS: contentRevision covering only the sentences is what makes a heartbeat inert', async () => {
  const mutant = await importMutant(
    'content-revision-binds-the-clock',
    'canonicalJson({ items, machine: CONTROL_ROOM_ACTIVITY_MACHINE })',
    'canonicalJson({ items, machine: CONTROL_ROOM_ACTIVITY_MACHINE, observedAt: at })',
  );
  const snapshots = [
    buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'RUNNING' })]),
      observedAt: '2026-08-29T18:40:12.000Z',
      telemetryProjection: telemetry(BETWEEN_GATES_RUN),
    }),
    buildControlRoomSnapshot({
      drainProjection: projection([item({ drainState: 'RUNNING' })]),
      observedAt: '2026-08-29T18:40:41.000Z',
      telemetryProjection: telemetry([
        ...BETWEEN_GATES_RUN,
        { event: 'run.heartbeat', observedAt: '2026-08-29T18:40:40.000Z' },
      ]),
    }),
  ];

  const mutated = snapshots.map((snapshot) => mutant.summarizeControlRoomActivity({ snapshot }));
  const shipped = snapshots.map((snapshot) => summarizeControlRoomActivity({ snapshot }));

  assert.notEqual(
    mutated[0].contentRevision, mutated[1].contentRevision,
    'with the observation instant inside it, a heartbeat-only tick moves the content digest',
  );
  assert.equal(shipped[0].contentRevision, shipped[1].contentRevision);
});
