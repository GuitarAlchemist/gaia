/**
 * RED gates for `gaia-pr-review-thread/1` — the contract half of issue #43.
 *
 * The R family holds the reading: severity measured from the thread's own comments and published
 * on its own axis, the closed marker grammar, the applicability table, and the four resolution
 * refusals. Nothing here touches a disk, a clock or a provider.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  PR_REVIEW_ACTIONABLE_SEVERITIES,
  PR_REVIEW_APPLICABILITY_VERDICTS,
  PR_REVIEW_CHECK_CONCLUSIONS,
  PR_REVIEW_ETA_MINIMUM_SAMPLE,
  PR_REVIEW_SEVERITIES,
  PR_REVIEW_STATES,
  PR_REVIEW_THREAD_ACTIONS,
  PR_REVIEW_THREAD_OBSERVATION_FIELDS,
  PR_REVIEW_THREAD_REFUSALS,
  PR_REVIEW_THREAD_SCHEMA,
  PR_REVIEW_THREAD_STATES,
  PR_REVIEW_THREAD_TRANSITIONS,
  PrReviewThreadError,
  classifyReviewThreadSeverity,
  derivePrReviewThreadApplicability,
  estimateRepairEta,
  planPrReviewThreadRepair,
  prReviewThreadIdentity,
  renderRepairChecklist,
  requirePrReviewThreadObservation,
} from '../src/pr-review-thread.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const REVIEWED_HEAD = 'a'.repeat(40);
const CURRENT_HEAD = 'b'.repeat(40);
const REPAIR_HEAD = 'c'.repeat(40);
const ANCHOR_AT_REVIEW = '1'.repeat(64);
const ANCHOR_CHANGED = '2'.repeat(64);
const SOURCE_REVISION = '3'.repeat(64);

const P1_BODY = 'P1: the lock is released before the compare-and-swap lands.';
const P3_BODY = '[P3] this identifier could be shorter.';

const comment = (over = {}) => ({ id: 'RT_comment_1', body: P1_BODY, ...over });

function observation(over = {}) {
  const built = {
    schema: 'gaia-pr-review-thread-observation/1',
    observedAt: '2026-08-31T12:00:00.000Z',
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
    applicability: {
      anchorDigestAtReview: ANCHOR_AT_REVIEW,
      anchorDigestAtCurrentHead: ANCHOR_AT_REVIEW,
    },
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

const repairEvidence = (over = {}) => ({
  headOid: REPAIR_HEAD,
  descendsFromReviewedHead: true,
  touchesAnchorPath: true,
  commitsAheadOfReviewedHead: 1,
  addressedCommentIds: ['RT_comment_1'],
  ...over,
});

const checkEvidence = (over = {}) => ({
  headOid: REPAIR_HEAD,
  requiredContexts: ['build', 'test'],
  conclusions: [
    { context: 'build', conclusion: 'SUCCESS' },
    { context: 'test', conclusion: 'SUCCESS' },
  ],
  ...over,
});

const plan = (over = {}, history = []) => planPrReviewThreadRepair({
  observation: observation(over), history,
});

const repaired = (over = {}) => observation({
  repair: repairEvidence(), checks: checkEvidence(), ...over,
});

const IDENTITY = {
  repository: 'GuitarAlchemist/gaia',
  pullRequestNumber: 39,
  reviewThreadId: 'PRRT_thread_1',
  reviewedHeadOid: REVIEWED_HEAD,
};

const refusalCode = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof PrReviewThreadError, `expected PrReviewThreadError, got ${error}`);
    return error.code;
  }
  return assert.fail('expected a refusal');
};

/* ------------------------------------------------------------------------------------------- *
 * R1-R5 — the closed observation, and the identity deduplication is atomic over
 * ------------------------------------------------------------------------------------------ */

test('R1: the observation carries exactly its schema fields and an unknown one is refused', () => {
  assert.deepEqual([...PR_REVIEW_THREAD_OBSERVATION_FIELDS].sort(), [
    'applicability', 'checks', 'currentHeadOid', 'observedAt', 'pullRequest', 'repair',
    'repository', 'review', 'reviewThread', 'run', 'schema', 'sourceRevision',
  ].sort());
  requirePrReviewThreadObservation(observation());
  assert.equal(
    refusalCode(() => requirePrReviewThreadObservation({ ...observation(), heartbeatAt: 'x' })),
    'ObservationInvalid',
    'a liveness signal must be unsayable, not merely weighted low',
  );
  assert.equal(
    refusalCode(() => requirePrReviewThreadObservation(
      Object.fromEntries(Object.entries(observation()).filter(([k]) => k !== 'checks')),
    )),
    'ObservationInvalid',
  );
});

test('R2: a getter, a symbol key or a foreign prototype is refused rather than read', () => {
  const poisoned = observation();
  Object.defineProperty(poisoned, 'sourceRevision', {
    get: () => SOURCE_REVISION, enumerable: true, configurable: true,
  });
  assert.equal(refusalCode(() => requirePrReviewThreadObservation(poisoned)), 'ObservationInvalid');

  const foreign = Object.assign(Object.create({ inherited: true }), observation());
  assert.equal(refusalCode(() => requirePrReviewThreadObservation(foreign)), 'ObservationInvalid');

  const symbolic = observation();
  symbolic[Symbol('extra')] = 1;
  assert.equal(refusalCode(() => requirePrReviewThreadObservation(symbolic)), 'ObservationInvalid');
});

test('R3: the identity binds exactly repository, pull request, thread and reviewed head', () => {
  const identity = prReviewThreadIdentity(IDENTITY);
  assert.match(identity, /^[a-f0-9]{64}$/u);
  assert.equal(prReviewThreadIdentity({ ...IDENTITY }), identity, 'the recipe is stable');
  assert.equal(
    prReviewThreadIdentity({ ...IDENTITY, repository: 'guitaralchemist/GAIA' }), identity,
    'GitHub owner and repository names are case-insensitive; two spellings are one repository',
  );
  assert.equal(
    refusalCode(() => prReviewThreadIdentity({ ...IDENTITY, extra: 1 })), 'InvalidIdentity',
  );
  for (const field of Object.keys(IDENTITY)) {
    const partial = { ...IDENTITY };
    delete partial[field];
    assert.equal(refusalCode(() => prReviewThreadIdentity(partial)), 'InvalidIdentity');
  }
});

test('R4: two inline comments in one thread are one claim, and the run id is not identity', () => {
  const one = plan();
  const two = plan({
    reviewThread: {
      comments: [comment(), comment({ id: 'RT_comment_2', body: 'P1 — and the same again.' })],
    },
  });
  assert.equal(
    one.threadIdentity, two.threadIdentity,
    'a COMMENTED review with two comments in one thread is one finding, not two lanes',
  );

  const rerun = plan({ run: { runId: 'a-second-run', laneGeneration: 7 } });
  const restated = plan({ observedAt: '2026-09-01T00:00:00.000Z', sourceRevision: '4'.repeat(64) });
  const otherReview = plan({ review: { id: 'PRR_review_2', state: 'CHANGES_REQUESTED' } });
  for (const other of [rerun, restated, otherReview]) {
    assert.equal(
      other.threadIdentity, one.threadIdentity,
      'a re-run, a later clock or a second review of the same thread is the same claim',
    );
  }
});

test('R5: a re-review against a new head is a new claim, because it must be re-proven', () => {
  assert.notEqual(
    prReviewThreadIdentity({ ...IDENTITY, reviewedHeadOid: CURRENT_HEAD }),
    prReviewThreadIdentity(IDENTITY),
    'a finding made on a different head is a different finding',
  );
});

/* ------------------------------------------------------------------------------------------- *
 * R6-R12 — severity is measured from the comments, never from the review state
 * ------------------------------------------------------------------------------------------ */

test('R6: a COMMENTED review carrying a P1 marker blocks merge — the PR #39 defect', () => {
  const reading = plan({ review: { state: 'COMMENTED' } });
  assert.equal(reading.reviewState, 'COMMENTED');
  assert.equal(reading.severity, 'P1');
  assert.equal(reading.blocksMerge, true);
  assert.equal(reading.action, 'CLAIM');
});

test('R7: an APPROVED review carrying a P0 thread still blocks merge', () => {
  const reading = plan({
    review: { state: 'APPROVED' },
    reviewThread: { comments: [comment({ body: '[P0] the credential reaches the log.' })] },
  });
  assert.equal(reading.reviewState, 'APPROVED');
  assert.equal(reading.severity, 'P0');
  assert.equal(reading.blocksMerge, true, 'approval is not a measurement of what the review said');
});

test('R8: a CHANGES_REQUESTED review carrying only a P3 thread does not block merge', () => {
  const reading = plan({
    review: { state: 'CHANGES_REQUESTED' },
    reviewThread: { comments: [comment({ body: P3_BODY })] },
  });
  assert.equal(reading.reviewState, 'CHANGES_REQUESTED');
  assert.equal(reading.severity, 'P3');
  assert.equal(reading.blocksMerge, false);
  assert.equal(reading.state, 'NOT_ACTIONABLE');
  assert.equal(reading.action, 'NONE');
});

test('R9: blocksMerge is a function of severity and never of the review state', () => {
  // Every review state, one P1 thread. If the two facts were ever collapsed, one of these moves.
  for (const state of PR_REVIEW_STATES) {
    const reading = plan({ review: { state } });
    assert.equal(reading.blocksMerge, true, `${state} + P1 must block`);
    assert.equal(reading.severity, 'P1', `${state} must not move the measured severity`);
    assert.equal(reading.reviewState, state, 'the provider fact is republished verbatim');
  }
  for (const state of PR_REVIEW_STATES) {
    const reading = plan({
      review: { state },
      reviewThread: { comments: [comment({ body: P3_BODY })] },
    });
    assert.equal(reading.blocksMerge, false, `${state} + P3 must not block`);
  }
});

test('R10: an absent marker is UNCLASSIFIED with a reason, never a low severity', () => {
  const reading = plan({
    reviewThread: { comments: [comment({ body: 'Could you take another look at this?' })] },
  });
  assert.equal(reading.severity, 'UNCLASSIFIED');
  assert.equal(reading.severityReason, 'NO_SEVERITY_MARKER');
  assert.equal(reading.blocksMerge, false);
  assert.notEqual(reading.severity, 'P3', 'nobody writing a severity is not somebody writing P3');
});

test('R11: the most severe marker across the thread wins, and only P0/P1 are actionable', () => {
  const classified = classifyReviewThreadSeverity([
    comment({ id: 'c1', body: P3_BODY }),
    comment({ id: 'c2', body: 'P1: this one matters.' }),
    comment({ id: 'c3', body: 'Severity: P0' }),
    comment({ id: 'c4', body: 'no marker at all' }),
  ]);
  assert.equal(classified.severity, 'P0');
  assert.deepEqual(classified.actionableCommentIds, ['c2', 'c3'], 'in comment order, P0 and P1');
  assert.equal(classified.reason, 'MARKER_FOUND');
});

test('R12: the marker grammar is closed — a sentence about severity is not a marker', () => {
  const accepted = [
    'P1: the lock is released early.',
    'P0 — the credential reaches the log.',
    'P2 - a smaller thing.',
    '[P1] the lock is released early.',
    '**[P0]** the credential reaches the log.',
    '- P1: inside a list item.',
    'Severity: P1',
    '**Severity**: P0',
    'A preamble line.\nP1: and the marker on the second line.',
  ];
  for (const body of accepted) {
    const { severity } = classifyReviewThreadSeverity([comment({ body })]);
    assert.match(severity, /^P[0-3]$/u, `accepted form must classify: ${JSON.stringify(body)}`);
  }

  const rejected = [
    'this is not a P1 concern',
    'I would call it P1 if it were reachable',
    'see PR1: unrelated',
    'the P10 lane is fine',
    'PP1: not a token',
    'severity is subjective',
  ];
  for (const body of rejected) {
    const { severity, reason } = classifyReviewThreadSeverity([comment({ body })]);
    assert.equal(severity, 'UNCLASSIFIED', `prose must not classify: ${JSON.stringify(body)}`);
    assert.equal(reason, 'NO_SEVERITY_MARKER');
  }
});

/* ------------------------------------------------------------------------------------------- *
 * R13-R18 — does the finding still apply to the current head?
 * ------------------------------------------------------------------------------------------ */

test('R13: the same head with a thread GitHub does not call outdated APPLIES', () => {
  const verdict = derivePrReviewThreadApplicability(observation());
  assert.equal(verdict.verdict, 'APPLIES');
  assert.equal(verdict.basis, 'SAME_HEAD');
});

test('R14: a thread GitHub reports outdated is STALE even on the same head', () => {
  const verdict = derivePrReviewThreadApplicability(observation({
    reviewThread: { isOutdated: true },
  }));
  assert.equal(verdict.verdict, 'STALE');
  assert.equal(verdict.basis, 'THREAD_OUTDATED');
});

test('R15: a moved head whose anchor digest is unchanged is re-proven, not assumed', () => {
  const verdict = derivePrReviewThreadApplicability(observation({
    currentHeadOid: CURRENT_HEAD,
  }));
  assert.equal(verdict.verdict, 'APPLIES');
  assert.equal(verdict.basis, 'ANCHOR_REPROVEN');
});

test('R16: a moved head whose anchor digest changed is STALE', () => {
  const verdict = derivePrReviewThreadApplicability(observation({
    currentHeadOid: CURRENT_HEAD,
    applicability: { anchorDigestAtCurrentHead: ANCHOR_CHANGED },
  }));
  assert.equal(verdict.verdict, 'STALE');
  assert.equal(verdict.basis, 'ANCHOR_CHANGED');
});

test('R17: an unmeasured anchor is UNKNOWN, and UNKNOWN is not a yes', () => {
  for (const over of [
    { anchorDigestAtCurrentHead: 'UNKNOWN' },
    { anchorDigestAtReview: 'UNKNOWN' },
  ]) {
    const verdict = derivePrReviewThreadApplicability(observation({
      currentHeadOid: CURRENT_HEAD, applicability: over,
    }));
    assert.equal(verdict.verdict, 'UNKNOWN');
    assert.equal(verdict.basis, 'ANCHOR_UNKNOWN');
  }
  assert.deepEqual([...PR_REVIEW_APPLICABILITY_VERDICTS], ['APPLIES', 'STALE', 'UNKNOWN']);
});

test('R18: a claim is opened only from APPLIES; STALE and UNKNOWN refuse by name', () => {
  const stale = plan({ reviewThread: { isOutdated: true } });
  assert.equal(stale.action, 'REFUSE');
  assert.equal(stale.refusal, 'FINDING_STALE');

  const unknown = plan({
    currentHeadOid: CURRENT_HEAD,
    applicability: { anchorDigestAtCurrentHead: 'UNKNOWN' },
  });
  assert.equal(unknown.action, 'REFUSE');
  assert.equal(unknown.refusal, 'APPLICABILITY_UNKNOWN');
});

/* ------------------------------------------------------------------------------------------- *
 * R19-R26 — the lifecycle, and the four refusals that stop a resolution
 * ------------------------------------------------------------------------------------------ */

test('R19: a disputed thread is refused, whatever else is true of it', () => {
  const reading = planPrReviewThreadRepair({
    observation: repaired({ reviewThread: { disputed: true } }),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(reading.action, 'REFUSE');
  assert.equal(reading.refusal, 'THREAD_DISPUTED');
});

test('R20: the lifecycle advances CLAIM -> COMMENT -> RESOLVE and nothing skips', () => {
  assert.deepEqual([...PR_REVIEW_THREAD_TRANSITIONS], [
    'RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED', 'REFUSED',
  ]);

  assert.equal(plan().action, 'CLAIM', 'a fresh actionable thread is claimed');

  const claimed = planPrReviewThreadRepair({
    observation: observation(), history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED'],
  });
  assert.equal(claimed.state, 'REPAIR_IN_PROGRESS');
  assert.equal(claimed.action, 'NONE', 'no repair evidence yet, so nothing is published');

  const withRepair = planPrReviewThreadRepair({
    observation: observation({ repair: repairEvidence() }),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED'],
  });
  assert.equal(withRepair.repairProven, true);
  assert.equal(withRepair.state, 'AWAITING_VERIFICATION');
  assert.equal(withRepair.action, 'NONE', 'a repair without passing checks publishes nothing');

  const verified = planPrReviewThreadRepair({
    observation: repaired(), history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED'],
  });
  assert.equal(verified.verificationProven, true);
  assert.equal(verified.state, 'AWAITING_COMMENT');
  assert.equal(verified.action, 'COMMENT');

  const commented = planPrReviewThreadRepair({
    observation: repaired(),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(commented.state, 'AWAITING_RESOLUTION');
  assert.equal(commented.action, 'RESOLVE');
});

test('R21: a resolution never precedes its evidence — RESOLVE requires a durable COMMENTED', () => {
  const reading = planPrReviewThreadRepair({
    observation: repaired(),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED'],
  });
  assert.equal(reading.action, 'COMMENT', 'the evidence comment comes first, always');
});

test('R22: a partially addressed thread is refused, by superset and not by count', () => {
  const twoComments = {
    comments: [
      comment({ id: 'c1', body: 'P1: the first finding.' }),
      comment({ id: 'c2', body: 'P1: the second finding.' }),
    ],
  };
  const reading = planPrReviewThreadRepair({
    observation: repaired({
      reviewThread: twoComments,
      repair: repairEvidence({ addressedCommentIds: ['c1'] }),
    }),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(reading.action, 'REFUSE');
  assert.equal(reading.refusal, 'PARTIALLY_ADDRESSED');

  // The same count, the wrong ids. A count test would pass this and resolve the wrong finding.
  const miscounted = planPrReviewThreadRepair({
    observation: repaired({
      reviewThread: twoComments,
      repair: repairEvidence({ addressedCommentIds: ['c1', 'c1'] }),
    }),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(miscounted.refusal, 'PARTIALLY_ADDRESSED');

  const covered = planPrReviewThreadRepair({
    observation: repaired({
      reviewThread: twoComments,
      repair: repairEvidence({ addressedCommentIds: ['c2', 'c1'] }),
    }),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(covered.action, 'RESOLVE');
});

test('R23: checks run at any head other than the repair head are not evidence about it', () => {
  const reading = planPrReviewThreadRepair({
    observation: repaired({ checks: checkEvidence({ headOid: REVIEWED_HEAD }) }),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });
  assert.equal(reading.action, 'REFUSE');
  assert.equal(reading.refusal, 'REPAIR_UNVERIFIED');
});

test('R24: a required context that failed, or is absent, or has no required set, refuses', () => {
  const at = (checks) => planPrReviewThreadRepair({
    observation: repaired({ checks }),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED'],
  });

  const failed = at(checkEvidence({
    conclusions: [
      { context: 'build', conclusion: 'SUCCESS' },
      { context: 'test', conclusion: 'FAILURE' },
    ],
  }));
  assert.equal(failed.refusal, 'REPAIR_UNVERIFIED');

  const absent = at(checkEvidence({
    conclusions: [{ context: 'build', conclusion: 'SUCCESS' }],
  }));
  assert.equal(absent.refusal, 'REPAIR_UNVERIFIED', 'a missing check is not a passing check');

  const none = at(checkEvidence({ requiredContexts: [], conclusions: [] }));
  assert.equal(none.refusal, 'REPAIR_UNVERIFIED', 'no required check is not proof of anything');

  // A check that has not reported yet is pending, not refused: the lane keeps waiting.
  const pending = at(checkEvidence({
    conclusions: [
      { context: 'build', conclusion: 'SUCCESS' },
      { context: 'test', conclusion: 'UNKNOWN' },
    ],
  }));
  assert.equal(pending.action, 'NONE');
  assert.equal(pending.state, 'AWAITING_VERIFICATION');
  assert.equal(pending.refusal, null);
});

test('R25: a repair that does not descend from the reviewed head, or misses the anchor, waits', () => {
  for (const over of [
    { descendsFromReviewedHead: false },
    { touchesAnchorPath: false },
  ]) {
    const reading = planPrReviewThreadRepair({
      observation: repaired({ repair: repairEvidence(over) }),
      history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED'],
    });
    assert.equal(reading.repairProven, false);
    assert.equal(reading.state, 'REPAIR_IN_PROGRESS');
    assert.equal(reading.action, 'NONE');
  }
});

test('R26: a thread already resolved, or a lane already refused, does nothing further', () => {
  const already = plan({ reviewThread: { isResolved: true } });
  assert.equal(already.state, 'THREAD_RESOLVED');
  assert.equal(already.action, 'NONE');

  const done = planPrReviewThreadRepair({
    observation: repaired(),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED', 'COMMENTED', 'RESOLVED'],
  });
  assert.equal(done.state, 'THREAD_RESOLVED');
  assert.equal(done.action, 'NONE');

  const refused = planPrReviewThreadRepair({
    observation: repaired(), history: ['RECEIVED', 'CLASSIFIED', 'REFUSED'],
  });
  assert.equal(refused.state, 'REFUSED');
  assert.equal(refused.action, 'NONE', 'a refusal is terminal for this identity');
});

test('R27: the lifecycle is monotonic — VERIFIED without REPAIRED is a corrupt history', () => {
  assert.equal(
    refusalCode(() => planPrReviewThreadRepair({
      observation: repaired(), history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'VERIFIED'],
    })),
    'HistoryInvalid',
  );
  assert.equal(
    refusalCode(() => planPrReviewThreadRepair({
      observation: repaired(), history: ['CLASSIFIED', 'RECEIVED'],
    })),
    'HistoryInvalid',
  );
  assert.equal(
    refusalCode(() => planPrReviewThreadRepair({
      observation: repaired(), history: ['RECEIVED', 'ASCENDED'],
    })),
    'HistoryInvalid',
  );
});

/* ------------------------------------------------------------------------------------------- *
 * R28-R31 — the published checklist, its ETA, and what may never reach it
 * ------------------------------------------------------------------------------------------ */

test('R28: the ETA is UNKNOWN with a named reason below the declared sample', () => {
  assert.ok(PR_REVIEW_ETA_MINIMUM_SAMPLE >= 3);
  const short = estimateRepairEta([
    { claimedAt: '2026-08-31T10:00:00.000Z', resolvedAt: '2026-08-31T11:00:00.000Z' },
  ]);
  assert.equal(short.state, 'UNKNOWN');
  assert.equal(short.reason, 'INSUFFICIENT_HISTORY');
  assert.equal(short.medianMs, null, 'a fabricated ETA is worse than no ETA');
  assert.equal(short.sampleSize, 1, 'the sample size still describes the evidence');

  assert.equal(estimateRepairEta([]).state, 'UNKNOWN');
});

test('R29: with enough completed lanes the ETA is the measured median of their durations', () => {
  const lane = (hours) => ({
    claimedAt: '2026-08-31T00:00:00.000Z',
    resolvedAt: new Date(Date.parse('2026-08-31T00:00:00.000Z') + hours * 3_600_000).toISOString(),
  });
  const measured = estimateRepairEta([lane(1), lane(5), lane(3)]);
  assert.equal(measured.state, 'MEASURED');
  assert.equal(measured.medianMs, 3 * 3_600_000, 'the median, not the mean and not the latest');
  assert.equal(measured.sampleSize, 3);
  assert.equal(measured.reason, null);
});

test('R30: the checklist publishes origin, current step, the seven steps and the ETA', () => {
  const reading = planPrReviewThreadRepair({
    observation: repaired(),
    history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED'],
  });
  const body = renderRepairChecklist({
    reading,
    observation: repaired(),
    eta: estimateRepairEta([]),
  });
  assert.equal(typeof body, 'string');
  for (const required of [
    'GuitarAlchemist/gaia', '#39', 'PRRT_thread_1', 'COMMENTED', 'P1',
    REVIEWED_HEAD, REPAIR_HEAD, 'build', 'test', 'INSUFFICIENT_HISTORY',
    reading.threadIdentity,
  ]) {
    assert.ok(body.includes(required), `the checklist states ${required}`);
  }
  for (const step of PR_REVIEW_THREAD_TRANSITIONS.filter((t) => t !== 'REFUSED')) {
    assert.ok(body.includes(step.toLowerCase()), `the checklist lists the ${step} step`);
  }
  assert.ok(/current step/iu.test(body), 'the checklist names the current step');
  assert.ok(/origin/iu.test(body), 'the checklist names its origin');
});

test('R31: no byte of untrusted review prose reaches the published checklist', () => {
  // Assembled at runtime: a literal of this shape in a shipped file is what the credential-shape
  // gate in product.test.mjs exists to reject, and it cannot tell a fixture from the real thing.
  const credentialShaped = ['ghp', '_', 'a'.repeat(36)].join('');
  const secretive = repaired({
    reviewThread: {
      comments: [comment({
        body: `P1: ${credentialShaped} and C:\\Users\\operator\\secret.txt`,
      })],
    },
  });
  const body = renderRepairChecklist({
    reading: planPrReviewThreadRepair({
      observation: secretive,
      history: ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED'],
    }),
    observation: secretive,
    eta: estimateRepairEta([]),
  });
  assert.ok(!body.includes(credentialShaped), 'a token pasted into a review body cannot be republished');
  assert.ok(!body.includes('C:\\Users'), 'nor can an operator path');
  assert.ok(!body.includes('secret.txt'));
});

test('R32: the checklist is deterministic and the reading is content-addressed', () => {
  const observed = repaired();
  const history = ['RECEIVED', 'CLASSIFIED', 'CLAIMED', 'REPAIRED', 'VERIFIED'];
  const first = planPrReviewThreadRepair({ observation: observed, history });
  const second = planPrReviewThreadRepair({ observation: observed, history });
  assert.deepEqual(first, second);
  assert.match(first.revision, /^[a-f0-9]{64}$/u);
  const eta = estimateRepairEta([]);
  assert.equal(
    renderRepairChecklist({ reading: first, observation: observed, eta }),
    renderRepairChecklist({ reading: second, observation: observed, eta }),
  );
});

/* ------------------------------------------------------------------------------------------- *
 * R33-R34 — the closed vocabularies, and what this module cannot do
 * ------------------------------------------------------------------------------------------ */

test('R33: every published vocabulary is closed, frozen and complete', () => {
  const vocabularies = {
    PR_REVIEW_STATES, PR_REVIEW_SEVERITIES, PR_REVIEW_ACTIONABLE_SEVERITIES,
    PR_REVIEW_APPLICABILITY_VERDICTS, PR_REVIEW_CHECK_CONCLUSIONS, PR_REVIEW_THREAD_ACTIONS,
    PR_REVIEW_THREAD_STATES, PR_REVIEW_THREAD_TRANSITIONS, PR_REVIEW_THREAD_REFUSALS,
  };
  for (const [name, vocabulary] of Object.entries(vocabularies)) {
    assert.ok(Object.isFrozen(vocabulary), `${name} is frozen`);
    assert.equal(new Set(vocabulary).size, vocabulary.length, `${name} has no duplicate`);
  }
  assert.deepEqual([...PR_REVIEW_ACTIONABLE_SEVERITIES], ['P0', 'P1']);
  assert.deepEqual([...PR_REVIEW_THREAD_ACTIONS], ['NONE', 'CLAIM', 'COMMENT', 'RESOLVE', 'REFUSE']);
  assert.deepEqual([...PR_REVIEW_THREAD_REFUSALS].sort(), [
    'APPLICABILITY_UNKNOWN', 'FINDING_STALE', 'PARTIALLY_ADDRESSED', 'REPAIR_UNVERIFIED',
    'THREAD_DISPUTED',
  ]);
  for (const severity of PR_REVIEW_ACTIONABLE_SEVERITIES) {
    assert.ok(PR_REVIEW_SEVERITIES.includes(severity));
  }
  assert.equal(PR_REVIEW_THREAD_SCHEMA, 'gaia-pr-review-thread/1');
});

test('R34: the contract reads nothing, performs nothing, and holds no clock', () => {
  const source = readFileSync(join(ROOT, 'src', 'pr-review-thread.mjs'), 'utf8');
  for (const forbidden of [
    'child_process', 'node:http', 'node:https', 'node:net', 'node:fs', 'fetch(',
    'Date.now', 'new Date()', 'setTimeout', 'setInterval',
  ]) {
    assert.ok(!source.includes(forbidden), `the contract must not reach ${forbidden}`);
  }
  // The privileged-verb boundary is S23's, not this gate's. A bare `\bmerge` also forbids the
  // sentence "blocks merge" in a comment and `Array.prototype.push`, so it fails on prose and
  // idiom rather than on authority; S23 checks the argv- and identifier-shaped tokens by which
  // this codebase would actually spell such an effect, across both modules of the slice.
  const reading = plan();
  assert.equal(reading.effect, 'NONE');
  assert.equal(reading.authority, 'NONE');
  assert.ok(Object.isFrozen(reading));
});
