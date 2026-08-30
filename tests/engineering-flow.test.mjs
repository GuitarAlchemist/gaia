/**
 * engineering-flow.test.mjs — the `gaia-engineering-flow/1` artifact and its read model.
 *
 * Gates F1-F16 of `docs/engineering-flow-throughput.md`. The operator failure behind all of them
 * is a control room that can say "something is alive" and "nothing tracked is claimed" and cannot
 * say whether the engineering queue moved. Most of what is asserted here is what the model
 * refuses to count.
 *
 * Every hand-built artifact below is sealed with the shipped digest recipe over whatever fields it
 * carries, so a refusal can never be the digest check standing in for the rule under test. Where a
 * test means to break the digest, it breaks it explicitly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ENGINEERING_FLOW_CYCLE_TIME_MIN_SAMPLE,
  ENGINEERING_FLOW_EVENT_FIELDS,
  ENGINEERING_FLOW_FAMILIES,
  ENGINEERING_FLOW_FIELDS,
  ENGINEERING_FLOW_FRESH_MS,
  ENGINEERING_FLOW_OUTCOMES,
  ENGINEERING_FLOW_SCHEMA,
  ENGINEERING_FLOW_SOURCE,
  ENGINEERING_FLOW_SOURCE_KINDS,
  ENGINEERING_FLOW_WINDOWS,
  EngineeringFlowError,
  MAX_ENGINEERING_FLOW_EVENTS,
  deriveEngineeringFlowBlock,
  engineeringFlowRevision,
  requireEngineeringFlowArtifact,
  sealEngineeringFlow,
  summarizeEngineeringFlow,
} from '../src/engineering-flow.mjs';
import { isExactInstant } from '../src/local-lane-observation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SHA = '9df446ffa6b5ea2fc06d51eb29a5dbbe1bcc8732a73b45854bd57db6510183a9';
const OTHER_SHA = 'b'.repeat(64);

/** The instant every window ends at. */
const OBSERVED = '2026-08-30T18:10:00.000Z';
/** Fourteen days before it, so all three windows are complete unless a test says otherwise. */
const WINDOW_START = '2026-08-16T18:10:00.000Z';

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 604_800_000;

const at = (msBeforeObserved) => new Date(Date.parse(OBSERVED) - msBeforeObserved).toISOString();

const event = (overrides = {}) => ({
  eventId: 'gh-issue-17-closed-1',
  occurredAt: at(29 * 60_000),
  family: 'ISSUE',
  outcome: 'CLOSED',
  repository: 'GuitarAlchemist/gaia',
  workItemId: 'issue-17',
  startedAt: null,
  sourceKind: 'GITHUB_EVENT',
  sourceRevision: SHA,
  ...overrides,
});

/**
 * One artifact built field by field and sealed with the shipped recipe.
 *
 * The recipe projects each event to the nine known fields, so an artifact carrying a tenth still
 * seals correctly and the ONLY thing that can refuse it is the field check. That is the property
 * that makes "explicit events only" testable as a mechanism rather than as an outcome.
 */
const handBuilt = ({
  observedAt = OBSERVED, windowStartedAt = WINDOW_START, sequence = 41, events = [], ...rest
} = {}) => ({
  schema: ENGINEERING_FLOW_SCHEMA,
  effect: 'NONE',
  authority: 'NONE',
  observedAt,
  windowStartedAt,
  sequence,
  events,
  revision: engineeringFlowRevision({ observedAt, windowStartedAt, sequence, events }),
  ...rest,
});

const seal = (events, overrides = {}) => sealEngineeringFlow({
  observedAt: OBSERVED, windowStartedAt: WINDOW_START, sequence: 41, events, ...overrides,
});

const refuses = (build, why) => assert.throws(build, (error) => {
  assert.ok(
    error instanceof EngineeringFlowError,
    `${why}: expected an EngineeringFlowError, got ${error?.name}: ${error?.message}`,
  );
  return true;
}, why);

const familyOf = (block, family) => block.families.find((entry) => entry.family === family);
const windowOf = (block, family, window) => familyOf(block, family)
  .windows.find((entry) => entry.window === window);

// ---------------------------------------------------------------------------------------------
// F1 — the closed schema round-trips, seals deterministically, and is deeply frozen.
// ---------------------------------------------------------------------------------------------

test('F1: a sealed artifact round-trips, seals deterministically and is deeply frozen', () => {
  const sealed = seal([event()]);

  assert.equal(sealed.schema, 'gaia-engineering-flow/1');
  assert.equal(sealed.effect, 'NONE');
  assert.equal(sealed.authority, 'NONE');
  assert.equal(sealed.observedAt, OBSERVED);
  assert.equal(sealed.windowStartedAt, WINDOW_START);
  assert.equal(sealed.sequence, 41);
  assert.equal(sealed.events.length, 1);

  // Exactly eight top-level keys and exactly nine per event, and the exported lists say which.
  assert.deepEqual([...ENGINEERING_FLOW_FIELDS].sort(), [
    'authority', 'effect', 'events', 'observedAt', 'revision', 'schema', 'sequence',
    'windowStartedAt',
  ]);
  assert.deepEqual([...ENGINEERING_FLOW_EVENT_FIELDS].sort(), [
    'eventId', 'family', 'occurredAt', 'outcome', 'repository', 'sourceKind', 'sourceRevision',
    'startedAt', 'workItemId',
  ]);
  assert.deepEqual(Object.keys(sealed).sort(), [...ENGINEERING_FLOW_FIELDS].sort());
  assert.deepEqual(Object.keys(sealed.events[0]).sort(), [...ENGINEERING_FLOW_EVENT_FIELDS].sort());

  // Sealing the same evidence twice is byte-identical however the caller ordered it.
  const again = seal([event()]);
  assert.equal(again.revision, sealed.revision);
  assert.deepEqual(again, sealed);

  assert.deepEqual(requireEngineeringFlowArtifact(sealed), sealed);
  assert.ok(Object.isFrozen(sealed), 'the artifact is frozen');
  assert.ok(Object.isFrozen(sealed.events), 'the event list is frozen');
  assert.ok(Object.isFrozen(sealed.events[0]), 'each event is frozen');
});

test('F1: sealing orders events by occurredAt then eventId, whatever order the caller used', () => {
  const early = event({ eventId: 'a-early', occurredAt: at(50 * 60_000) });
  const lateA = event({ eventId: 'a-late', occurredAt: at(10 * 60_000) });
  const lateB = event({ eventId: 'b-late', occurredAt: at(10 * 60_000) });

  const sealed = seal([lateB, early, lateA]);
  assert.deepEqual(sealed.events.map(({ eventId }) => eventId), ['a-early', 'a-late', 'b-late']);
  assert.equal(seal([early, lateA, lateB]).revision, sealed.revision);
});

test('F1: the closed vocabularies are exactly the five families and their outcome table', () => {
  assert.deepEqual([...ENGINEERING_FLOW_FAMILIES], [
    'ISSUE', 'PULL_REQUEST', 'COMMIT', 'FACTORY_RUN', 'EVIDENCE_REVIEW',
  ]);
  assert.deepEqual([...ENGINEERING_FLOW_OUTCOMES.ISSUE], ['OPENED', 'REOPENED', 'CLOSED']);
  assert.deepEqual([...ENGINEERING_FLOW_OUTCOMES.PULL_REQUEST], [
    'OPENED', 'REOPENED', 'MERGED', 'CLOSED_WITHOUT_MERGE',
  ]);
  assert.deepEqual([...ENGINEERING_FLOW_OUTCOMES.COMMIT], [
    'PRODUCED_ON_WORK_BRANCH', 'INTEGRATED_INTO_DEFAULT_BRANCH',
  ]);
  assert.deepEqual([...ENGINEERING_FLOW_OUTCOMES.FACTORY_RUN], ['COMPLETED', 'FAILED']);
  assert.deepEqual([...ENGINEERING_FLOW_OUTCOMES.EVIDENCE_REVIEW], ['APPROVED', 'REFUSED']);
  assert.deepEqual([...ENGINEERING_FLOW_SOURCE_KINDS], [
    'GITHUB_EVENT', 'GIT_HISTORY', 'FACTORY_TELEMETRY', 'DRAIN_RECEIPT', 'EVIDENCE_LEDGER',
  ]);
  assert.deepEqual(ENGINEERING_FLOW_WINDOWS.map(({ window }) => window), ['PT1H', 'P1D', 'P7D']);
  assert.deepEqual(ENGINEERING_FLOW_WINDOWS.map(({ windowMs }) => windowMs), [
    HOUR_MS, DAY_MS, WEEK_MS,
  ]);
  assert.equal(ENGINEERING_FLOW_SOURCE, 'GAIA_ENGINEERING_FLOW');
  assert.equal(ENGINEERING_FLOW_CYCLE_TIME_MIN_SAMPLE, 5);
  assert.equal(MAX_ENGINEERING_FLOW_EVENTS, 512);
});

test('F1: the freshness window is five minutes and is its own constant', () => {
  assert.equal(ENGINEERING_FLOW_FRESH_MS, 300_000);
  // Not borrowed from the heartbeat or lane windows: those answer whether a process or a sensor is
  // alive, this one answers how stale a throughput reading is.
  const source = readFileSync(join(ROOT, 'src', 'engineering-flow.mjs'), 'utf8');
  assert.doesNotMatch(source, /HEARTBEAT_FRESH_MS|LOCAL_LANE_OBSERVATION_FRESH_MS/u);
});

// ---------------------------------------------------------------------------------------------
// F2 — unknown top-level and per-event fields are refused, including `updatedAt`.
// ---------------------------------------------------------------------------------------------

test('F2: an unknown top-level field is refused even when the artifact seals correctly', () => {
  const tampered = handBuilt({ events: [event()], updatedAt: '2026-08-30T18:00:00.000Z' });
  // The digest projects the eight known keys, so this artifact's revision is genuinely correct.
  assert.equal(tampered.revision, engineeringFlowRevision({
    observedAt: OBSERVED, windowStartedAt: WINDOW_START, sequence: 41, events: tampered.events,
  }));
  refuses(() => requireEngineeringFlowArtifact(tampered), 'a top-level updatedAt is refused');
});

test('F2: an inferred-lifecycle field on an event is refused, however the artifact was sealed', () => {
  // The whole "explicit events only" rule reduces to this: there is no field to infer from.
  for (const field of ['updatedAt', 'title', 'body', 'author', 'heartbeat', 'tokens', 'bytes', 'pid']) {
    const events = [{ ...event(), [field]: 'anything at all' }];
    const artifact = handBuilt({ events });
    assert.equal(artifact.revision, engineeringFlowRevision({
      observedAt: OBSERVED, windowStartedAt: WINDOW_START, sequence: 41, events,
    }), `${field} must not enter the digest`);
    refuses(
      () => requireEngineeringFlowArtifact(artifact),
      `an event carrying ${field} is refused`,
    );
    refuses(() => seal(events), `sealing an event carrying ${field} is refused`);
  }
});

test('F2: an artifact that is not an object, or claims an authority, is refused', () => {
  for (const value of [null, undefined, 'artifact', 42, [], []]) {
    refuses(() => requireEngineeringFlowArtifact(value), `${JSON.stringify(value)} is refused`);
  }
  refuses(
    () => requireEngineeringFlowArtifact({ ...handBuilt({ events: [] }), effect: 'WRITE' }),
    'a claimed effect is refused',
  );
  refuses(
    () => requireEngineeringFlowArtifact({ ...handBuilt({ events: [] }), authority: 'ADMIN' }),
    'a claimed authority is refused',
  );
  refuses(
    () => requireEngineeringFlowArtifact({ ...handBuilt({ events: [] }), schema: 'gaia-engineering-flow/2' }),
    'an unsupported schema is refused',
  );
});

test('F2: sequence must be a safe non-negative integer, and events are bounded', () => {
  for (const sequence of [-1, 1.5, '41', Number.NaN, Number.MAX_SAFE_INTEGER + 2, null]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ sequence, events: [] })),
      `sequence ${String(sequence)} is refused`,
    );
  }
  const tooMany = Array.from({ length: MAX_ENGINEERING_FLOW_EVENTS + 1 }, (_, index) => event({
    eventId: `issue-${String(index).padStart(4, '0')}`,
    occurredAt: at((index + 1) * 60_000),
    workItemId: `issue-${index}`,
  }));
  refuses(() => seal(tooMany), 'more than 512 events is refused');
});

test('F2: an event identity outside the bounded pattern is refused', () => {
  for (const eventId of ['', ' leading-space', 'has space', 'has/slash', 'a'.repeat(65), 42, null]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ eventId })] })),
      `event identity ${JSON.stringify(eventId)} is refused`,
    );
  }
  for (const workItemId of ['', 'has space', 'a'.repeat(65), null]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ workItemId })] })),
      `work item identity ${JSON.stringify(workItemId)} is refused`,
    );
  }
});

test('F2: a source revision that is not 64 lowercase hex characters is refused', () => {
  for (const sourceRevision of [SHA.toUpperCase(), 'a'.repeat(63), 'a'.repeat(65), 'zz', null, '']) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ sourceRevision })] })),
      `source revision ${JSON.stringify(sourceRevision)} is refused`,
    );
  }
});

test('F2: a repository is required where the fact is repository-scoped, and optional where it is not', () => {
  for (const family of ['ISSUE', 'PULL_REQUEST', 'COMMIT']) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({
        events: [event({ family, outcome: ENGINEERING_FLOW_OUTCOMES[family][0], repository: null })],
      })),
      `${family} requires a repository`,
    );
  }
  for (const repository of ['no-slash', 'a//b', ' owner/repo', 'owner/repo/extra', '']) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ repository })] })),
      `repository ${JSON.stringify(repository)} is refused`,
    );
  }
  // The two families that are not repository-scoped may say so.
  assert.equal(seal([event({
    family: 'FACTORY_RUN', outcome: 'COMPLETED', repository: null, workItemId: 'run-9',
    sourceKind: 'FACTORY_TELEMETRY',
  })]).events[0].repository, null);
  assert.equal(seal([event({
    family: 'EVIDENCE_REVIEW', outcome: 'APPROVED', repository: null, workItemId: 'review-2',
    sourceKind: 'EVIDENCE_LEDGER',
  })]).events[0].repository, null);
});

// ---------------------------------------------------------------------------------------------
// F3 — non-exact, future and incoherent instants are refused rather than clamped.
// ---------------------------------------------------------------------------------------------

test('F3: an instant that is not exact is refused, never widened', () => {
  // `Date.parse` is not a validator. A partial date must not silently become a confident one.
  for (const occurredAt of [
    '2026-08-30', '2026-08-30T17:41:02Z', '2026-08-30T17:41:02.000+00:00',
    '2026-08-30T17:41:02.000Z (GMT)', 'yesterday', '', null, 1_756_000_000_000,
  ]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ occurredAt })] })),
      `occurredAt ${JSON.stringify(occurredAt)} is refused`,
    );
  }
  for (const observedAt of ['2026-08-30', '2026-08-30T18:10:00Z', null]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ observedAt, events: [] })),
      `observedAt ${JSON.stringify(observedAt)} is refused`,
    );
  }
  for (const windowStartedAt of ['2026-08-16', '2026-08-16T18:10:00Z', null]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ windowStartedAt, events: [] })),
      `windowStartedAt ${JSON.stringify(windowStartedAt)} is refused`,
    );
  }
});

test('F3: future and incoherent instants are refused rather than clamped', () => {
  refuses(
    () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ occurredAt: at(-1000) })] })),
    'an event after the observation instant is refused',
  );
  refuses(
    () => requireEngineeringFlowArtifact(handBuilt({
      windowStartedAt: at(-1000), events: [],
    })),
    'a window that starts after the observation instant is refused',
  );
  refuses(
    () => requireEngineeringFlowArtifact(handBuilt({
      windowStartedAt: at(HOUR_MS), events: [event({ occurredAt: at(2 * HOUR_MS) })],
    })),
    'an event before the window it claims completeness over is refused',
  );
  refuses(
    () => requireEngineeringFlowArtifact(handBuilt({
      events: [event({ occurredAt: at(HOUR_MS), startedAt: at(HOUR_MS - 1000) })],
    })),
    'a start after the event it belongs to is refused',
  );
  for (const startedAt of ['2026-08-29', '2026-08-29T09:12:44Z', 42]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ startedAt })] })),
      `startedAt ${JSON.stringify(startedAt)} is refused`,
    );
  }
});

test('F3: the consumer refuses an artifact observed after the instant it was read', () => {
  const artifact = seal([event()]);
  refuses(
    () => summarizeEngineeringFlow({ artifact, observedAt: at(1000) }),
    'evidence dated after the read instant is refused',
  );
  // One millisecond earlier is ordinary, and measurable.
  assert.equal(
    summarizeEngineeringFlow({ artifact, observedAt: at(-1) }).observationAgeMs, 1,
  );
});

// ---------------------------------------------------------------------------------------------
// F4 — duplicate event identities and non-ascending order are refused.
// ---------------------------------------------------------------------------------------------

test('F4: a repeated event identity is refused, never de-duplicated', () => {
  const events = [
    event({ eventId: 'gh-issue-17-closed-1', occurredAt: at(50 * 60_000) }),
    event({ eventId: 'gh-issue-17-closed-1', occurredAt: at(10 * 60_000) }),
  ];
  refuses(() => requireEngineeringFlowArtifact(handBuilt({ events })), 'a duplicate id is refused');
  refuses(() => seal(events), 'sealing a duplicate id is refused');
});

test('F4: events that are not in strictly ascending order are refused', () => {
  refuses(() => requireEngineeringFlowArtifact(handBuilt({
    events: [
      event({ eventId: 'b', occurredAt: at(10 * 60_000) }),
      event({ eventId: 'a', occurredAt: at(50 * 60_000) }),
    ],
  })), 'descending instants are refused');
  refuses(() => requireEngineeringFlowArtifact(handBuilt({
    events: [
      event({ eventId: 'b', occurredAt: at(10 * 60_000) }),
      event({ eventId: 'a', occurredAt: at(10 * 60_000) }),
    ],
  })), 'a tie broken the wrong way is refused');
});

// ---------------------------------------------------------------------------------------------
// F5 — unsupported family, outcome, family/outcome pair and source kind are refused.
// ---------------------------------------------------------------------------------------------

test('F5: an unsupported family, outcome or source kind is refused', () => {
  for (const family of ['ISSUES', 'issue', 'constructor', '__proto__', 'toString', null, 42]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ family })] })),
      `family ${JSON.stringify(family)} is refused`,
    );
  }
  for (const outcome of ['DONE', 'closed', 'constructor', null]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ outcome })] })),
      `outcome ${JSON.stringify(outcome)} is refused`,
    );
  }
  for (const sourceKind of ['GITHUB', 'github_event', 'constructor', null]) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ sourceKind })] })),
      `source kind ${JSON.stringify(sourceKind)} is refused`,
    );
  }
});

test('F5: an outcome that is real but belongs to another family is refused', () => {
  // Every one of these names is in the vocabulary; none of them is in THAT family's row.
  const wrongPairs = [
    ['ISSUE', 'MERGED'], ['ISSUE', 'COMPLETED'], ['PULL_REQUEST', 'CLOSED'],
    ['COMMIT', 'OPENED'], ['FACTORY_RUN', 'APPROVED'], ['EVIDENCE_REVIEW', 'MERGED'],
  ];
  for (const [family, outcome] of wrongPairs) {
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({
        events: [event({ family, outcome, workItemId: 'subject-1' })],
      })),
      `${family}/${outcome} is refused`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// F6 — contradictory terminals refused; legitimate histories are not.
// ---------------------------------------------------------------------------------------------

test('F6: mutually exclusive terminal outcomes for one subject are refused', () => {
  refuses(() => seal([
    event({
      eventId: 'pr-9-merged', occurredAt: at(3 * HOUR_MS), family: 'PULL_REQUEST',
      outcome: 'MERGED', workItemId: 'pr-9',
    }),
    event({
      eventId: 'pr-9-closed', occurredAt: at(2 * HOUR_MS), family: 'PULL_REQUEST',
      outcome: 'CLOSED_WITHOUT_MERGE', workItemId: 'pr-9',
    }),
  ]), 'a pull request cannot be both merged and closed without merge');

  refuses(() => seal([
    event({
      eventId: 'run-3-completed', occurredAt: at(3 * HOUR_MS), family: 'FACTORY_RUN',
      outcome: 'COMPLETED', workItemId: 'run-3', repository: null,
      sourceKind: 'FACTORY_TELEMETRY',
    }),
    event({
      eventId: 'run-3-failed', occurredAt: at(2 * HOUR_MS), family: 'FACTORY_RUN',
      outcome: 'FAILED', workItemId: 'run-3', repository: null, sourceKind: 'FACTORY_TELEMETRY',
    }),
  ]), 'a factory run cannot be both completed and failed');
});

test('F6: an ordinary reopen history and an ordinary re-review history are NOT contradictions', () => {
  // Refusing these would be a fabricated contradiction, which is the same class of error as a
  // fabricated count.
  const reopened = seal([
    event({ eventId: 'i17-closed-1', occurredAt: at(5 * DAY_MS), outcome: 'CLOSED' }),
    event({ eventId: 'i17-reopened', occurredAt: at(4 * DAY_MS), outcome: 'REOPENED' }),
    event({ eventId: 'i17-closed-2', occurredAt: at(3 * DAY_MS), outcome: 'CLOSED' }),
  ]);
  assert.equal(reopened.events.length, 3);

  const reviewed = seal([
    event({
      eventId: 'rev-1-refused', occurredAt: at(5 * DAY_MS), family: 'EVIDENCE_REVIEW',
      outcome: 'REFUSED', workItemId: 'review-1', repository: null,
      sourceKind: 'EVIDENCE_LEDGER',
    }),
    event({
      eventId: 'rev-1-approved', occurredAt: at(4 * DAY_MS), family: 'EVIDENCE_REVIEW',
      outcome: 'APPROVED', workItemId: 'review-1', repository: null,
      sourceKind: 'EVIDENCE_LEDGER',
    }),
  ]);
  assert.equal(reviewed.events.length, 2);

  // And the exclusion is per subject, not across the whole artifact.
  const twoRequests = seal([
    event({
      eventId: 'pr-1-merged', occurredAt: at(5 * DAY_MS), family: 'PULL_REQUEST',
      outcome: 'MERGED', workItemId: 'pr-1',
    }),
    event({
      eventId: 'pr-2-closed', occurredAt: at(4 * DAY_MS), family: 'PULL_REQUEST',
      outcome: 'CLOSED_WITHOUT_MERGE', workItemId: 'pr-2',
    }),
  ]);
  assert.equal(twoRequests.events.length, 2);
});

test('F6: the exclusion does not leak across families that share a work item identity', () => {
  // `COMPLETED` and `MERGED` are terminals of different families; one subject name in two
  // families is not a contradiction about either of them.
  const shared = seal([
    event({
      eventId: 'x-merged', occurredAt: at(5 * DAY_MS), family: 'PULL_REQUEST', outcome: 'MERGED',
      workItemId: 'subject-1',
    }),
    event({
      eventId: 'x-failed', occurredAt: at(4 * DAY_MS), family: 'FACTORY_RUN', outcome: 'FAILED',
      workItemId: 'subject-1', repository: null, sourceKind: 'FACTORY_TELEMETRY',
    }),
  ]);
  assert.equal(shared.events.length, 2);
});

// ---------------------------------------------------------------------------------------------
// F7 — a tampered revision is refused.
// ---------------------------------------------------------------------------------------------

test('F7: an artifact whose revision does not match its content is refused', () => {
  const sealed = seal([event()]);
  refuses(
    () => requireEngineeringFlowArtifact({ ...sealed, revision: OTHER_SHA }),
    'a wrong revision is refused',
  );
  // The interesting direction: content edited, digest left alone.
  refuses(
    () => requireEngineeringFlowArtifact({ ...sealed, sequence: sealed.sequence + 1 }),
    'an edited sequence is refused',
  );
  refuses(
    () => requireEngineeringFlowArtifact({
      ...sealed,
      events: [{ ...sealed.events[0], outcome: 'OPENED' }],
    }),
    'an edited outcome is refused',
  );
  for (const revision of [null, 42, '', 'not-hex']) {
    refuses(
      () => requireEngineeringFlowArtifact({ ...sealed, revision }),
      `revision ${JSON.stringify(revision)} is refused`,
    );
  }
});

// ---------------------------------------------------------------------------------------------
// F8 — a backwards source snapshot is refused.
// ---------------------------------------------------------------------------------------------

test('F8: an artifact whose observedAt or sequence went backwards is refused', () => {
  const artifact = seal([event()], { sequence: 41 });
  const prior = { observedAt: OBSERVED, sequence: 41 };

  // The same snapshot republished is ordinary.
  assert.equal(
    summarizeEngineeringFlow({ artifact, observedAt: OBSERVED, priorObservation: prior }).sequence,
    41,
  );

  refuses(() => summarizeEngineeringFlow({
    artifact,
    observedAt: OBSERVED,
    priorObservation: { observedAt: OBSERVED, sequence: 42 },
  }), 'a lower sequence than the prior observation is refused');

  refuses(() => summarizeEngineeringFlow({
    artifact,
    observedAt: OBSERVED,
    priorObservation: { observedAt: at(-HOUR_MS), sequence: 41 },
  }), 'an earlier observedAt than the prior observation is refused');

  // Moving forward on both axes is what a healthy producer does.
  const later = sealEngineeringFlow({
    observedAt: at(-HOUR_MS), windowStartedAt: WINDOW_START, sequence: 42, events: [event()],
  });
  assert.equal(summarizeEngineeringFlow({
    artifact: later, observedAt: at(-HOUR_MS), priorObservation: prior,
  }).sequence, 42);
});

// ---------------------------------------------------------------------------------------------
// F9 — exact counts and rates over complete 1h, 24h and 7d windows.
// ---------------------------------------------------------------------------------------------

const ISSUE_HISTORY = [
  event({ eventId: 'i-open-a', occurredAt: at(29 * 60_000), outcome: 'OPENED', workItemId: 'issue-1' }),
  event({ eventId: 'i-close-a', occurredAt: at(20 * 60_000), outcome: 'CLOSED', workItemId: 'issue-2' }),
  event({ eventId: 'i-close-b', occurredAt: at(8 * HOUR_MS), outcome: 'CLOSED', workItemId: 'issue-3' }),
  event({ eventId: 'i-open-b', occurredAt: at(5 * DAY_MS), outcome: 'OPENED', workItemId: 'issue-4' }),
];

test('F9: exact counts, per-outcome breakdowns and rates over each complete window', () => {
  const block = summarizeEngineeringFlow({ artifact: seal(ISSUE_HISTORY), observedAt: OBSERVED });

  const hour = windowOf(block, 'ISSUE', 'PT1H');
  assert.equal(hour.state, 'MEASURED');
  assert.equal(hour.reasonCode, null);
  assert.equal(hour.total, 2);
  assert.equal(hour.ratePerHour, 2);
  assert.deepEqual(hour.outcomes, { OPENED: 1, REOPENED: 0, CLOSED: 1 });

  const day = windowOf(block, 'ISSUE', 'P1D');
  assert.equal(day.state, 'MEASURED');
  assert.equal(day.total, 3);
  assert.equal(day.ratePerHour, 0.125);
  assert.deepEqual(day.outcomes, { OPENED: 1, REOPENED: 0, CLOSED: 2 });

  const week = windowOf(block, 'ISSUE', 'P7D');
  assert.equal(week.state, 'MEASURED');
  assert.equal(week.total, 4);
  // 4 events over 168 hours, rounded to four places by one deterministic formula.
  assert.equal(week.ratePerHour, 0.0238);
  assert.deepEqual(week.outcomes, { OPENED: 2, REOPENED: 0, CLOSED: 2 });

  // Every family is present in every block, so the matrix has a stable shape.
  assert.deepEqual(block.families.map(({ family }) => family), [...ENGINEERING_FLOW_FAMILIES]);
  for (const entry of block.families) {
    assert.deepEqual(entry.windows.map(({ window }) => window), ['PT1H', 'P1D', 'P7D']);
  }
  assert.equal(block.eventCount, 4);
  assert.equal(block.source, 'GAIA_ENGINEERING_FLOW');
  assert.equal(block.binding, 'NONE');
  assert.equal(block.artifactRevision, seal(ISSUE_HISTORY).revision);
});

test('F9: an event exactly one window old is counted by the window that names its age', () => {
  const boundary = seal([event({ eventId: 'edge', occurredAt: at(HOUR_MS) })]);
  const block = summarizeEngineeringFlow({ artifact: boundary, observedAt: OBSERVED });
  assert.equal(windowOf(block, 'ISSUE', 'PT1H').total, 1, 'the closed left bound includes it');
  assert.equal(windowOf(block, 'ISSUE', 'P1D').total, 1);

  const justOutside = seal([event({ eventId: 'edge', occurredAt: at(HOUR_MS + 1) })]);
  const outside = summarizeEngineeringFlow({ artifact: justOutside, observedAt: OBSERVED });
  assert.equal(windowOf(outside, 'ISSUE', 'PT1H').total, 0, 'one millisecond older is outside');
  assert.equal(windowOf(outside, 'ISSUE', 'P1D').total, 1);
});

test('F9: every family counts its own outcomes and no other family moves', () => {
  const block = summarizeEngineeringFlow({
    artifact: seal([
      event({
        eventId: 'pr-merged', occurredAt: at(10 * 60_000), family: 'PULL_REQUEST',
        outcome: 'MERGED', workItemId: 'pr-1',
      }),
      event({
        eventId: 'commit-integrated', occurredAt: at(11 * 60_000), family: 'COMMIT',
        outcome: 'INTEGRATED_INTO_DEFAULT_BRANCH', workItemId: 'commit-abc',
        sourceKind: 'GIT_HISTORY',
      }),
      event({
        eventId: 'run-failed', occurredAt: at(12 * 60_000), family: 'FACTORY_RUN',
        outcome: 'FAILED', workItemId: 'run-1', repository: null,
        sourceKind: 'FACTORY_TELEMETRY',
      }),
      event({
        eventId: 'review-refused', occurredAt: at(13 * 60_000), family: 'EVIDENCE_REVIEW',
        outcome: 'REFUSED', workItemId: 'review-1', repository: null,
        sourceKind: 'EVIDENCE_LEDGER',
      }),
    ]),
    observedAt: OBSERVED,
  });

  assert.deepEqual(windowOf(block, 'PULL_REQUEST', 'PT1H').outcomes, {
    OPENED: 0, REOPENED: 0, MERGED: 1, CLOSED_WITHOUT_MERGE: 0,
  });
  assert.deepEqual(windowOf(block, 'COMMIT', 'PT1H').outcomes, {
    PRODUCED_ON_WORK_BRANCH: 0, INTEGRATED_INTO_DEFAULT_BRANCH: 1,
  });
  assert.deepEqual(windowOf(block, 'FACTORY_RUN', 'PT1H').outcomes, { COMPLETED: 0, FAILED: 1 });
  assert.deepEqual(windowOf(block, 'EVIDENCE_REVIEW', 'PT1H').outcomes, {
    APPROVED: 0, REFUSED: 1,
  });
  // The family with no events in this artifact is measured at zero, not unknown.
  assert.equal(windowOf(block, 'ISSUE', 'PT1H').state, 'MEASURED');
  assert.equal(windowOf(block, 'ISSUE', 'PT1H').total, 0);
});

test('F9: the reading carries its own staleness against its own window', () => {
  const artifact = seal([event()]);
  const fresh = summarizeEngineeringFlow({ artifact, observedAt: OBSERVED });
  assert.equal(fresh.state, 'FRESH');
  assert.equal(fresh.observationAgeMs, 0);
  assert.equal(fresh.freshnessWindowMs, ENGINEERING_FLOW_FRESH_MS);

  const edge = summarizeEngineeringFlow({
    artifact, observedAt: at(-ENGINEERING_FLOW_FRESH_MS),
  });
  assert.equal(edge.state, 'FRESH', 'exactly at the window is still fresh');

  const stale = summarizeEngineeringFlow({
    artifact, observedAt: at(-(ENGINEERING_FLOW_FRESH_MS + 1)),
  });
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.observationAgeMs, ENGINEERING_FLOW_FRESH_MS + 1);
  // Staleness is about the READING, never about the counts: the windows still end at the
  // artifact's own instant, so a stale block keeps reporting exactly what it measured.
  assert.equal(windowOf(stale, 'ISSUE', 'PT1H').total, 1);
  assert.equal(stale.observedAt, OBSERVED);
});

// ---------------------------------------------------------------------------------------------
// F10 / F11 — the difference between 0 and UNKNOWN.
// ---------------------------------------------------------------------------------------------

test('F10: an incomplete window is UNKNOWN with every count null, and never zero', () => {
  // The artifact claims completeness for two hours only: the hour is complete, the day and the
  // week are not.
  const artifact = sealEngineeringFlow({
    observedAt: OBSERVED,
    windowStartedAt: at(2 * HOUR_MS),
    sequence: 1,
    events: [event({ eventId: 'i-close', occurredAt: at(30 * 60_000) })],
  });
  const block = summarizeEngineeringFlow({ artifact, observedAt: OBSERVED });

  assert.equal(windowOf(block, 'ISSUE', 'PT1H').state, 'MEASURED');

  for (const window of ['P1D', 'P7D']) {
    const cell = windowOf(block, 'ISSUE', window);
    assert.equal(cell.state, 'UNKNOWN', `${window} is unknown`);
    assert.equal(cell.reasonCode, 'WINDOW_INCOMPLETE');
    assert.equal(cell.total, null, `${window} total must be null and never 0`);
    assert.equal(cell.ratePerHour, null);
    assert.deepEqual(cell.outcomes, { OPENED: null, REOPENED: null, CLOSED: null });
    assert.equal(cell.queue.state, 'UNKNOWN');
    assert.equal(cell.queue.reasonCode, 'WINDOW_INCOMPLETE');
    assert.deepEqual(
      [cell.queue.inflow, cell.queue.outflow, cell.queue.net], [null, null, null],
    );
    assert.equal(cell.cycleTime.state, 'UNKNOWN');
    assert.equal(cell.cycleTime.reasonCode, 'WINDOW_INCOMPLETE');
    assert.equal(cell.cycleTime.sampleSize, null);
    assert.equal(cell.cycleTime.medianMs, null);
  }

  // Not one zero anywhere in an unknown cell, in any family.
  for (const entry of block.families) {
    for (const cell of entry.windows) {
      if (cell.state !== 'UNKNOWN') continue;
      assert.notEqual(cell.total, 0, `${entry.family}/${cell.window} must not read 0`);
      for (const count of Object.values(cell.outcomes)) assert.equal(count, null);
    }
  }
});

test('F11: a complete window with no events is MEASURED at exactly 0, not unknown', () => {
  const block = summarizeEngineeringFlow({
    artifact: seal([]), observedAt: OBSERVED,
  });
  assert.equal(block.eventCount, 0);
  for (const entry of block.families) {
    for (const cell of entry.windows) {
      assert.equal(cell.state, 'MEASURED', `${entry.family}/${cell.window} is measured`);
      assert.equal(cell.reasonCode, null);
      assert.equal(cell.total, 0);
      assert.equal(cell.ratePerHour, 0);
      for (const count of Object.values(cell.outcomes)) assert.equal(count, 0);
    }
  }
  // The two readings are structurally distinguishable without reading a single word.
  const unknown = summarizeEngineeringFlow({
    artifact: sealEngineeringFlow({
      observedAt: OBSERVED, windowStartedAt: at(30 * 60_000), sequence: 1, events: [],
    }),
    observedAt: OBSERVED,
  });
  assert.notEqual(
    windowOf(unknown, 'ISSUE', 'PT1H').state, windowOf(block, 'ISSUE', 'PT1H').state,
  );
});

test('F10: completeness is decided per window, at exactly the boundary', () => {
  const exactly = summarizeEngineeringFlow({
    artifact: sealEngineeringFlow({
      observedAt: OBSERVED, windowStartedAt: at(HOUR_MS), sequence: 1, events: [],
    }),
    observedAt: OBSERVED,
  });
  assert.equal(windowOf(exactly, 'ISSUE', 'PT1H').state, 'MEASURED', 'exactly complete counts');
  assert.equal(windowOf(exactly, 'ISSUE', 'P1D').state, 'UNKNOWN');

  const oneShort = summarizeEngineeringFlow({
    artifact: sealEngineeringFlow({
      observedAt: OBSERVED, windowStartedAt: at(HOUR_MS - 1), sequence: 1, events: [],
    }),
    observedAt: OBSERVED,
  });
  assert.equal(windowOf(oneShort, 'ISSUE', 'PT1H').state, 'UNKNOWN', 'one millisecond short is not');
});

// ---------------------------------------------------------------------------------------------
// F12 — queue arithmetic where an inflow exists, and a named reason where it does not.
// ---------------------------------------------------------------------------------------------

test('F12: inflow, outflow and net over a complete window, for the families that have an inflow', () => {
  const block = summarizeEngineeringFlow({ artifact: seal(ISSUE_HISTORY), observedAt: OBSERVED });

  assert.deepEqual(windowOf(block, 'ISSUE', 'PT1H').queue, {
    state: 'MEASURED', reasonCode: null, inflow: 1, outflow: 1, net: 0,
  });
  assert.deepEqual(windowOf(block, 'ISSUE', 'P1D').queue, {
    state: 'MEASURED', reasonCode: null, inflow: 1, outflow: 2, net: -1,
  });
  assert.deepEqual(windowOf(block, 'ISSUE', 'P7D').queue, {
    state: 'MEASURED', reasonCode: null, inflow: 2, outflow: 2, net: 0,
  });
});

test('F12: a reopen is inflow, and a merge and a close without merge are both outflow', () => {
  const block = summarizeEngineeringFlow({
    artifact: seal([
      event({
        eventId: 'pr-open', occurredAt: at(50 * 60_000), family: 'PULL_REQUEST',
        outcome: 'OPENED', workItemId: 'pr-1',
      }),
      event({
        eventId: 'pr-reopen', occurredAt: at(40 * 60_000), family: 'PULL_REQUEST',
        outcome: 'REOPENED', workItemId: 'pr-2',
      }),
      event({
        eventId: 'pr-merge', occurredAt: at(30 * 60_000), family: 'PULL_REQUEST',
        outcome: 'MERGED', workItemId: 'pr-3',
      }),
      event({
        eventId: 'pr-close', occurredAt: at(20 * 60_000), family: 'PULL_REQUEST',
        outcome: 'CLOSED_WITHOUT_MERGE', workItemId: 'pr-4',
      }),
    ]),
    observedAt: OBSERVED,
  });
  assert.deepEqual(windowOf(block, 'PULL_REQUEST', 'PT1H').queue, {
    state: 'MEASURED', reasonCode: null, inflow: 2, outflow: 2, net: 0,
  });
});

test('F12: a commit produced on a work branch is inflow, integrated is outflow', () => {
  const block = summarizeEngineeringFlow({
    artifact: seal([
      event({
        eventId: 'c-a', occurredAt: at(50 * 60_000), family: 'COMMIT',
        outcome: 'PRODUCED_ON_WORK_BRANCH', workItemId: 'commit-a', sourceKind: 'GIT_HISTORY',
      }),
      event({
        eventId: 'c-b', occurredAt: at(40 * 60_000), family: 'COMMIT',
        outcome: 'PRODUCED_ON_WORK_BRANCH', workItemId: 'commit-b', sourceKind: 'GIT_HISTORY',
      }),
      event({
        eventId: 'c-c', occurredAt: at(30 * 60_000), family: 'COMMIT',
        outcome: 'INTEGRATED_INTO_DEFAULT_BRANCH', workItemId: 'commit-a',
        sourceKind: 'GIT_HISTORY',
      }),
    ]),
    observedAt: OBSERVED,
  });
  assert.deepEqual(windowOf(block, 'COMMIT', 'PT1H').queue, {
    state: 'MEASURED', reasonCode: null, inflow: 2, outflow: 1, net: 1,
  });
});

test('F12: a family with no observed inflow says so, and never prints a fabricated net', () => {
  const block = summarizeEngineeringFlow({
    artifact: seal([
      event({
        eventId: 'run-ok', occurredAt: at(30 * 60_000), family: 'FACTORY_RUN',
        outcome: 'COMPLETED', workItemId: 'run-1', repository: null,
        sourceKind: 'FACTORY_TELEMETRY',
      }),
      event({
        eventId: 'rev-ok', occurredAt: at(20 * 60_000), family: 'EVIDENCE_REVIEW',
        outcome: 'APPROVED', workItemId: 'review-1', repository: null,
        sourceKind: 'EVIDENCE_LEDGER',
      }),
    ]),
    observedAt: OBSERVED,
  });
  for (const family of ['FACTORY_RUN', 'EVIDENCE_REVIEW']) {
    for (const window of ['PT1H', 'P1D', 'P7D']) {
      const cell = windowOf(block, family, window);
      // The counts are measured; only the queue arithmetic is unknown, and it names why.
      assert.equal(cell.state, 'MEASURED', `${family}/${window} still counts its events`);
      assert.deepEqual(cell.queue, {
        state: 'UNKNOWN', reasonCode: 'NO_OBSERVED_INFLOW',
        inflow: null, outflow: null, net: null,
      }, `${family}/${window} has no fabricated inflow`);
    }
  }
});

test('F12: the structural reason wins over the evidence reason when both are true', () => {
  // An incomplete window over a family that has no inflow outcome satisfies both reasons.
  // NO_OBSERVED_INFLOW is reported, because it is the one that stays true after the window fills.
  const block = summarizeEngineeringFlow({
    artifact: sealEngineeringFlow({
      observedAt: OBSERVED, windowStartedAt: at(30 * 60_000), sequence: 1, events: [],
    }),
    observedAt: OBSERVED,
  });
  assert.equal(windowOf(block, 'FACTORY_RUN', 'PT1H').state, 'UNKNOWN');
  assert.equal(windowOf(block, 'FACTORY_RUN', 'PT1H').queue.reasonCode, 'NO_OBSERVED_INFLOW');
  assert.equal(windowOf(block, 'ISSUE', 'PT1H').queue.reasonCode, 'WINDOW_INCOMPLETE');
});

// ---------------------------------------------------------------------------------------------
// F13 — cycle time only where honest comparable durations exist.
// ---------------------------------------------------------------------------------------------

const closing = (index, durationMs, overrides = {}) => event({
  eventId: `close-${index}`,
  occurredAt: at((index + 1) * HOUR_MS),
  outcome: 'CLOSED',
  workItemId: `issue-${index}`,
  startedAt: new Date(Date.parse(at((index + 1) * HOUR_MS)) - durationMs).toISOString(),
  ...overrides,
});

test('F13: a median is published only at five or more closing events that all carry a start', () => {
  const durations = [10 * 60_000, 20 * 60_000, 30 * 60_000, 40 * 60_000, 50 * 60_000];
  const block = summarizeEngineeringFlow({
    artifact: seal(durations.map((duration, index) => closing(index, duration))),
    observedAt: OBSERVED,
  });
  const day = windowOf(block, 'ISSUE', 'P1D');
  assert.equal(day.cycleTime.state, 'MEASURED');
  assert.equal(day.cycleTime.reasonCode, null);
  assert.equal(day.cycleTime.sampleSize, 5);
  assert.equal(day.cycleTime.medianMs, 30 * 60_000);
});

test('F13: fewer than five closing events is UNKNOWN, and still reports the sample it had', () => {
  const block = summarizeEngineeringFlow({
    artifact: seal([0, 1, 2, 3].map((index) => closing(index, (index + 1) * 60_000))),
    observedAt: OBSERVED,
  });
  const day = windowOf(block, 'ISSUE', 'P1D');
  assert.equal(day.cycleTime.state, 'UNKNOWN');
  assert.equal(day.cycleTime.reasonCode, 'NOT_ENOUGH_COMPARABLE_DURATIONS');
  assert.equal(day.cycleTime.sampleSize, 4);
  assert.equal(day.cycleTime.medianMs, null);
});

test('F13: one closing event without a start withholds the whole cell, never a biased subset', () => {
  // A median over the subset that happens to carry a start is a selection-biased estimate
  // presented as a measurement.
  const events = [0, 1, 2, 3, 4, 5].map((index) => closing(index, (index + 1) * 60_000));
  const withHole = [...events.slice(0, 5), { ...events[5], startedAt: null }];
  const block = summarizeEngineeringFlow({ artifact: seal(withHole), observedAt: OBSERVED });
  const day = windowOf(block, 'ISSUE', 'P1D');
  assert.equal(day.cycleTime.state, 'UNKNOWN');
  assert.equal(day.cycleTime.reasonCode, 'INCOMPLETE_COMPARABLE_DURATIONS');
  assert.equal(day.cycleTime.sampleSize, 6);
  assert.equal(day.cycleTime.medianMs, null);
});

test('F13: only closing outcomes enter the sample, and the median quotes measurePace exactly', () => {
  const events = [
    // Four closes with starts, plus two opens that carry none. The opens must not be counted as
    // a missing duration, and must not enter the sample size.
    ...[0, 1, 2, 3].map((index) => closing(index, (index + 1) * 60_000)),
    event({ eventId: 'open-a', occurredAt: at(9 * HOUR_MS), outcome: 'OPENED', workItemId: 'issue-a' }),
    event({ eventId: 'open-b', occurredAt: at(10 * HOUR_MS), outcome: 'OPENED', workItemId: 'issue-b' }),
  ];
  const day = windowOf(
    summarizeEngineeringFlow({ artifact: seal(events), observedAt: OBSERVED }), 'ISSUE', 'P1D',
  );
  assert.equal(day.total, 6, 'the opens are still counted as events');
  assert.equal(day.cycleTime.sampleSize, 4, 'but only the closes are comparable durations');

  // Six durations: sorted[floor(6 / 2)] is the upper of the two middles, quoting measurePace.
  const six = [1, 2, 3, 4, 5, 6].map(
    (minutes, index) => closing(index, minutes * 60_000),
  );
  const median = windowOf(
    summarizeEngineeringFlow({ artifact: seal(six), observedAt: OBSERVED }), 'ISSUE', 'P1D',
  ).cycleTime;
  assert.equal(median.state, 'MEASURED');
  assert.equal(median.sampleSize, 6);
  assert.equal(median.medianMs, 4 * 60_000);
});

test('F13: a family whose closing outcomes are its only outcomes still measures a median', () => {
  const runs = [1, 2, 3, 4, 5].map((minutes, index) => event({
    eventId: `run-${index}`,
    occurredAt: at((index + 1) * HOUR_MS),
    family: 'FACTORY_RUN',
    outcome: index === 4 ? 'FAILED' : 'COMPLETED',
    workItemId: `run-${index}`,
    repository: null,
    sourceKind: 'FACTORY_TELEMETRY',
    startedAt: new Date(Date.parse(at((index + 1) * HOUR_MS)) - minutes * 60_000).toISOString(),
  }));
  const day = windowOf(
    summarizeEngineeringFlow({ artifact: seal(runs), observedAt: OBSERVED }), 'FACTORY_RUN', 'P1D',
  );
  assert.equal(day.cycleTime.state, 'MEASURED');
  assert.equal(day.cycleTime.sampleSize, 5);
  assert.equal(day.cycleTime.medianMs, 3 * 60_000);
  // A measured median next to an unknown queue is exactly right: this family has durations and
  // has no inflow.
  assert.equal(day.queue.reasonCode, 'NO_OBSERVED_INFLOW');
});

// ---------------------------------------------------------------------------------------------
// F14 — deterministic replay.
// ---------------------------------------------------------------------------------------------

test('F14: identical evidence produces byte-identical blocks, forever', () => {
  const artifact = seal(ISSUE_HISTORY);
  const first = summarizeEngineeringFlow({ artifact, observedAt: OBSERVED });
  const second = summarizeEngineeringFlow({
    artifact: requireEngineeringFlowArtifact(JSON.parse(JSON.stringify(artifact))),
    observedAt: OBSERVED,
  });
  assert.equal(JSON.stringify(first), JSON.stringify(second));

  // And the derivation is the same one the verify seam will call.
  assert.equal(
    JSON.stringify(deriveEngineeringFlowBlock({ artifact, observedAt: OBSERVED })),
    JSON.stringify(first),
  );

  // The block carries its evidence verbatim, so it can be re-derived by anyone holding it.
  assert.deepEqual(first.events, artifact.events);
  assert.ok(Object.isFrozen(first), 'the block is frozen');
});

test('F14: the model holds no clock and reads nothing', () => {
  const source = readFileSync(join(ROOT, 'src', 'engineering-flow.mjs'), 'utf8');
  assert.doesNotMatch(source, /Date\.now\(\)|new Date\(\)/u, 'the module holds no clock');
  assert.doesNotMatch(source, /node:fs|node:child_process|node:http|fetch\(/u, 'it reads nothing');
});

// ---------------------------------------------------------------------------------------------
// F15 — one digest recipe, one exact-instant rule.
// ---------------------------------------------------------------------------------------------

test('F15: the digest recipe has exactly one implementation and is exported', () => {
  const source = readFileSync(join(ROOT, 'src', 'engineering-flow.mjs'), 'utf8');
  assert.equal(
    source.split('createHash(').length - 1, 1,
    'exactly one hash site: two implementations is how two verifiers come to disagree',
  );
  const artifact = seal([event()]);
  assert.equal(artifact.revision, engineeringFlowRevision({
    observedAt: artifact.observedAt,
    windowStartedAt: artifact.windowStartedAt,
    sequence: artifact.sequence,
    events: artifact.events,
  }));
});

test('F15: the exact-instant rule is imported, never re-spelled', () => {
  const source = readFileSync(join(ROOT, 'src', 'engineering-flow.mjs'), 'utf8');
  assert.match(
    source,
    /import \{[^}]*\bisExactInstant\b[^}]*\} from '\.\/local-lane-observation\.mjs'/su,
    'the one exact-instant predicate is imported',
  );
  assert.doesNotMatch(source, /toISOString\(\)\s*===/u, 'and not re-spelled here');
  // The imported rule and the verifier agree, value for value.
  for (const instant of ['2026-08-30', '2026-08-30T18:10:00Z', '2026-08-30T18:10:00.000Z']) {
    const accepted = (() => {
      try {
        requireEngineeringFlowArtifact(handBuilt({ observedAt: instant, events: [] }));
        return true;
      } catch {
        return false;
      }
    })();
    assert.equal(accepted, isExactInstant(instant), `${instant} is judged by one rule`);
  }
});

// ---------------------------------------------------------------------------------------------
// F16 — an activity or capacity signal cannot be expressed at all.
// ---------------------------------------------------------------------------------------------

test('F16: no activity or capacity signal has a name in this vocabulary', () => {
  const signals = [
    'HEARTBEAT', 'TOKEN', 'TOKENS', 'STDOUT_BYTES', 'SPINNER', 'PROCESS_LIVENESS', 'PID',
    'LOCAL_LANE', 'LANE',
  ];
  for (const signal of signals) {
    assert.ok(
      !ENGINEERING_FLOW_FAMILIES.includes(signal), `${signal} is not a family`,
    );
    assert.ok(
      !ENGINEERING_FLOW_SOURCE_KINDS.includes(signal), `${signal} is not a source kind`,
    );
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ family: signal })] })),
      `${signal} cannot be expressed as a family`,
    );
    refuses(
      () => requireEngineeringFlowArtifact(handBuilt({ events: [event({ sourceKind: signal })] })),
      `${signal} cannot be expressed as a source kind`,
    );
  }
  // And there is no such word anywhere in the shipped module.
  const source = readFileSync(join(ROOT, 'src', 'engineering-flow.mjs'), 'utf8');
  for (const forbidden of ['HEARTBEAT', 'SPINNER', 'STDOUT']) {
    assert.doesNotMatch(
      source, new RegExp(`'${forbidden}`, 'u'), `${forbidden} is not a token in this module`,
    );
  }
});
