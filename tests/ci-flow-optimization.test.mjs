/**
 * ci-flow-optimization.test.mjs — advisory candidates and the pinned-baseline comparison.
 *
 * Gates O1-O6 of `docs/ci-flow-optimization.md`. This is the only module in the slice that can
 * promote a hypothesis to a result, so it is the only one whose defects spend a week of somebody's
 * engineering time.
 *
 * Two gates carry most of the weight. O4 keeps one run from closing two comparisons, which is how
 * a single fast week gets spent twice to justify two unrelated changes. O5 puts the regression
 * guard inside the comparison digest, so a guard loosened after seeing the result cannot pass as
 * the guard that was fixed before it.
 *
 * Nothing here applies a lever. The gates assert that too.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CI_FLOW_MIN_SAMPLE, ciFlowObservationIdentity, sealCiFlow } from '../src/ci-flow.mjs';
import {
  CI_FLOW_CANDIDATE_FIELDS,
  CI_FLOW_COMPARISON_FIELDS,
  CI_FLOW_COMPARISON_SCHEMA,
  CI_FLOW_GUARD_FIELDS,
  CI_FLOW_LEVERS,
  CI_FLOW_VERDICTS,
  CiFlowOptimizationError,
  compareCiFlow,
  deriveCiFlowCandidates,
  sealCiFlowComparison,
} from '../src/ci-flow-optimization.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const OBSERVED = '2026-08-30T19:30:00.000Z';
const WINDOW_START = '2026-08-16T19:30:00.000Z';
const MINUTE = 60_000;
const at = (msBeforeObserved) => new Date(Date.parse(OBSERVED) - msBeforeObserved).toISOString();

const check = (overrides = {}) => ({
  checkId: 'check-build',
  name: 'build',
  conclusion: 'SUCCESS',
  startedAt: at(50 * MINUTE),
  completedAt: at(45 * MINUTE),
  setupMs: null,
  workDigest: null,
  ...overrides,
});

const observation = (overrides = {}) => {
  const run = {
    provider: 'GITHUB_ACTIONS',
    repositoryId: 'R_kgDOA1',
    repository: 'GuitarAlchemist/gaia',
    workflow: 'ci.yml',
    runId: '1001',
    attempt: 1,
    sha: 'a3f5c1d90b7e4826af10cc35b9d2e7418f60a5b2',
    branch: 'main',
    pullRequest: null,
    trigger: 'PUSH',
    enqueueBasis: 'ATTEMPT',
    enqueuedAt: at(52 * MINUTE),
    runnerAcquiredAt: null,
    startedAt: at(50 * MINUTE),
    completedAt: at(45 * MINUTE),
    conclusion: 'SUCCESS',
    billableMs: null,
    complete: true,
    dependencies: null,
    ...overrides,
  };
  // The default check tracks its own run's span and conclusion, so a fixture is never refused
  // for a reason the case was not written to test.
  return {
    ...run,
    checks: overrides.checks ?? [check({
      conclusion: run.conclusion, startedAt: run.startedAt, completedAt: run.completedAt,
    })],
  };
};

const sealed = (observations) => sealCiFlow({
  observedAt: OBSERVED, windowStartedAt: WINDOW_START, sequence: 1, observations,
});

/** `count` runs of `spanMinutes` each, identified by a caller-chosen prefix. */
const arm = (prefix, count, spanMinutes) => Array.from({ length: count }, (_, index) => observation({
  runId: `${prefix}${String(index).padStart(2, '0')}`,
  startedAt: at((50 + index) * MINUTE),
  completedAt: at((50 + index - spanMinutes) * MINUTE),
  enqueuedAt: at((52 + index) * MINUTE),
  checks: [check({
    startedAt: at((50 + index) * MINUTE),
    completedAt: at((50 + index - spanMinutes) * MINUTE),
  })],
}));

/**
 * The shipped identity recipe, imported rather than re-spelled here. A second implementation of
 * an identity is exactly how two readers come to disagree about which run they are talking
 * about, which is the defect this contract refuses everywhere else.
 */
const identitiesOf = (observations) => observations.map(ciFlowObservationIdentity);

const GUARD = Object.freeze({ maxRegressionMs: 30_000, minImprovementMs: 30_000 });

/**
 * A pinned comparison over two arms. The baseline revision defaults to the artifact those two arms
 * alone make up; a case that reads against a WIDER artifact must pin to that artifact instead,
 * because a mismatched pin is its own refusal and would mask the rule under test.
 */
const comparison = (baseline, candidate, overrides = {}) => sealCiFlowComparison({
  lever: 'INTRODUCE_CACHING',
  baselineRevision: sealed([...new Set([...baseline, ...candidate])]).revision,
  guard: GUARD,
  observedAt: OBSERVED,
  baseline: identitiesOf(baseline),
  candidate: identitiesOf(candidate),
  ...overrides,
});

const refuses = (fn, code) => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CiFlowOptimizationError, `expected a CiFlowOptimizationError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
};

// -----------------------------------------------------------------------------------------------
// O1 — a candidate is advisory. It names its evidence and carries nothing that could be applied.
// -----------------------------------------------------------------------------------------------

test('O1: the lever vocabulary is closed and frozen', () => {
  assert.deepEqual([...CI_FLOW_LEVERS].sort(), [
    'CANCEL_SUPERSEDED_RUNS', 'DEDUPLICATE_WORK', 'INTRODUCE_CACHING', 'SAFE_JOB_PARALLELISM',
  ]);
  assert.ok(Object.isFrozen(CI_FLOW_LEVERS));
});

test('O1: a candidate carries exactly a lever, a rationale and its evidence', () => {
  assert.deepEqual([...CI_FLOW_CANDIDATE_FIELDS], ['lever', 'rationale', 'evidence']);
  const candidates = deriveCiFlowCandidates({
    artifact: sealed([observation({ checks: [check({ setupMs: 4 * MINUTE })] })]),
  });
  assert.ok(candidates.length >= 1);
  for (const candidate of candidates) {
    assert.deepEqual(Object.keys(candidate), [...CI_FLOW_CANDIDATE_FIELDS]);
    assert.ok(CI_FLOW_LEVERS.includes(candidate.lever));
    assert.ok(candidate.evidence.length >= 1, 'a candidate with no evidence is an opinion');
    assert.equal(typeof candidate.rationale, 'string');
  }
});

test('O1: no candidate field could carry a patch, and the module writes nothing', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow-optimization.mjs'), 'utf8');
  assert.ok(!/writeFileSync|appendFileSync|execFile|spawn|node:fs/u.test(source));
  for (const forbidden of ['patch', 'diff', 'apply', 'workflows/', 'yaml']) {
    assert.ok(!source.toLowerCase().includes(forbidden), `${forbidden} would be a remediation seam`);
  }
});

test('O1: candidates carry no authority and are ordered deterministically', () => {
  const artifact = sealed([observation({
    checks: [
      check({ checkId: 'x', name: 'x', setupMs: 4 * MINUTE, workDigest: 'd'.repeat(64) }),
      check({ checkId: 'y', name: 'y', setupMs: 4 * MINUTE, workDigest: 'd'.repeat(64) }),
    ],
  })]);
  const once = deriveCiFlowCandidates({ artifact });
  const twice = deriveCiFlowCandidates({ artifact });
  assert.equal(JSON.stringify(once), JSON.stringify(twice));
  assert.deepEqual(once.map((entry) => entry.lever), [...once.map((entry) => entry.lever)].sort());
});

// -----------------------------------------------------------------------------------------------
// O2 — each lever appears only when its own evidence precondition holds.
// -----------------------------------------------------------------------------------------------

const leversOf = (observations) => deriveCiFlowCandidates({ artifact: sealed(observations) })
  .map((candidate) => candidate.lever);

test('O2: no candidate at all is emitted for a clean single run', () => {
  assert.deepEqual(leversOf([observation()]), []);
});

test('O2: superseded runs are proposed only when two runs on one branch overlapped', () => {
  const overlapping = [
    observation({ runId: '1', startedAt: at(50 * MINUTE), completedAt: at(40 * MINUTE) }),
    observation({ runId: '2', startedAt: at(45 * MINUTE), completedAt: at(35 * MINUTE) }),
  ];
  assert.ok(leversOf(overlapping).includes('CANCEL_SUPERSEDED_RUNS'));

  const sequential = [
    observation({ runId: '1', startedAt: at(50 * MINUTE), completedAt: at(45 * MINUTE) }),
    observation({ runId: '2', startedAt: at(44 * MINUTE), completedAt: at(40 * MINUTE) }),
  ];
  assert.ok(!leversOf(sequential).includes('CANCEL_SUPERSEDED_RUNS'));
});

test('O2: overlapping runs on DIFFERENT branches are not superseded work', () => {
  const parallelBranches = [
    observation({ runId: '1', branch: 'main', startedAt: at(50 * MINUTE), completedAt: at(40 * MINUTE) }),
    observation({ runId: '2', branch: 'topic', startedAt: at(45 * MINUTE), completedAt: at(35 * MINUTE) }),
  ];
  assert.ok(!leversOf(parallelBranches).includes('CANCEL_SUPERSEDED_RUNS'));
});

test('O2: safe parallelism needs a proven graph, not merely two sequential checks', () => {
  const sequentialChecks = [
    check({ checkId: 'a', name: 'a', startedAt: at(50 * MINUTE), completedAt: at(48 * MINUTE) }),
    check({ checkId: 'b', name: 'b', startedAt: at(48 * MINUTE), completedAt: at(46 * MINUTE) }),
  ];
  assert.ok(!leversOf([observation({ checks: sequentialChecks, dependencies: null })])
    .includes('SAFE_JOB_PARALLELISM'), 'without a graph, sequence proves no independence');

  assert.ok(leversOf([observation({
    checks: sequentialChecks, completedAt: at(46 * MINUTE), dependencies: [],
  })]).includes('SAFE_JOB_PARALLELISM'), 'an empty edge set proves the two are independent');

  assert.ok(!leversOf([observation({
    checks: sequentialChecks, completedAt: at(46 * MINUTE), dependencies: [['a', 'b']],
  })]).includes('SAFE_JOB_PARALLELISM'), 'a proven edge is the reason they ran in sequence');
});

test('O2: duplicate work needs two checks with the same work digest', () => {
  const digest = 'e'.repeat(64);
  assert.ok(leversOf([observation({
    checks: [
      check({ checkId: 'a', name: 'a', workDigest: digest }),
      check({ checkId: 'b', name: 'b', workDigest: digest }),
    ],
  })]).includes('DEDUPLICATE_WORK'));

  assert.ok(!leversOf([observation({
    checks: [
      check({ checkId: 'a', name: 'a', workDigest: digest }),
      check({ checkId: 'b', name: 'b', workDigest: 'f'.repeat(64) }),
    ],
  })]).includes('DEDUPLICATE_WORK'));

  assert.ok(!leversOf([observation({
    checks: [check({ checkId: 'a', name: 'a' }), check({ checkId: 'b', name: 'b' })],
  })]).includes('DEDUPLICATE_WORK'), 'two absent digests are not a match');
});

test('O2: caching needs a measured setup that is a real share of the execution span', () => {
  assert.ok(leversOf([observation({ checks: [check({ setupMs: 4 * MINUTE })] })])
    .includes('INTRODUCE_CACHING'));
  assert.ok(!leversOf([observation({ checks: [check({ setupMs: 10_000 })] })])
    .includes('INTRODUCE_CACHING'));
  assert.ok(!leversOf([observation({ checks: [check({ setupMs: null })] })])
    .includes('INTRODUCE_CACHING'), 'an unexposed setup is not a small setup');
});

test('O2: an incomplete observation supports no candidate at all', () => {
  assert.deepEqual(
    leversOf([observation({ complete: false, checks: [check({ setupMs: 4 * MINUTE })] })]), [],
  );
});

/** `count` checks that all ran at the same time, each a one-minute span inside a one-minute run. */
const parallelRun = (setupMs, count = 4) => observation({
  startedAt: at(50 * MINUTE),
  completedAt: at(49 * MINUTE),
  checks: Array.from({ length: count }, (_, index) => check({
    checkId: `p${index}`,
    name: `p${index}`,
    setupMs,
    startedAt: at(50 * MINUTE),
    completedAt: at(49 * MINUTE),
  })),
});

test('O2: caching is not raised by summing the setup of jobs that ran at the same time', () => {
  // Four jobs, each spending ten seconds of its own sixty on setup. The true share is one sixth,
  // below the published quarter. Summing the four numerators against ONE wall-clock denominator
  // inflates the share by the fan-out and fires the lever on evidence that does not support it —
  // the same wall-clock error this contract already refuses for cost.
  assert.ok(!leversOf([parallelRun(10_000)]).includes('INTRODUCE_CACHING'),
    'a sixth of each job is not a quarter of anything');
});

test('O2: caching names the check that earns it, not merely the run it ran in', () => {
  const mixed = observation({
    startedAt: at(50 * MINUTE),
    completedAt: at(49 * MINUTE),
    checks: [
      check({
        checkId: 'slow-setup', name: 'slow setup', setupMs: 30_000,
        startedAt: at(50 * MINUTE), completedAt: at(49 * MINUTE),
      }),
      check({
        checkId: 'lean', name: 'lean', setupMs: 1_000,
        startedAt: at(50 * MINUTE), completedAt: at(49 * MINUTE),
      }),
    ],
  });
  const [raised] = deriveCiFlowCandidates({ artifact: sealed([mixed]) })
    .filter((entry) => entry.lever === 'INTRODUCE_CACHING');
  assert.ok(raised, 'a job spending half its own span on setup is a caching candidate');
  assert.equal(raised.evidence.length, 1, 'only the check that clears the share is named');
  assert.ok(raised.evidence[0].startsWith(ciFlowObservationIdentity(mixed)),
    'the named check is anchored to the run it ran in');
  assert.ok(raised.evidence[0].endsWith('slow-setup'));
  assert.ok(!raised.evidence[0].includes('lean'),
    'naming the whole run sends an operator to read four job logs to find the one that matters');
});

test('O2: a coherent parallel run is still readable, so the lever is not silently unreachable', () => {
  // The dual of the inflated ratio: twenty seconds of setup in each of four one-minute jobs sums
  // to eighty against a sixty-second run. Calling that CORRUPT withholds the caching lever from
  // exactly the heavily parallel workflows where caching is most likely to pay.
  assert.ok(leversOf([parallelRun(20_000)]).includes('INTRODUCE_CACHING'),
    'a third of each job IS above the published share');
});

// -----------------------------------------------------------------------------------------------
// O3, O5 — one lever, and a guard fixed before the reading.
// -----------------------------------------------------------------------------------------------

test('O3: a comparison names exactly one lever, and an unknown one is refused', () => {
  const sealedComparison = comparison(arm('b', CI_FLOW_MIN_SAMPLE, 5), arm('c', CI_FLOW_MIN_SAMPLE, 5));
  assert.equal(sealedComparison.schema, CI_FLOW_COMPARISON_SCHEMA);
  assert.equal(sealedComparison.lever, 'INTRODUCE_CACHING');
  assert.equal(typeof sealedComparison.lever, 'string');
  refuses(
    () => comparison(arm('b', 5, 5), arm('c', 5, 5), { lever: 'REWRITE_EVERYTHING' }),
    'InvalidCiFlowComparison',
  );
  refuses(
    () => comparison(arm('b', 5, 5), arm('c', 5, 5), { lever: ['INTRODUCE_CACHING', 'DEDUPLICATE_WORK'] }),
    'InvalidCiFlowComparison',
  );
});

test('O3: the comparison field list is closed and carries no result', () => {
  assert.deepEqual([...CI_FLOW_COMPARISON_FIELDS], [
    'schema', 'effect', 'authority', 'lever', 'baselineRevision', 'guard', 'observedAt',
    'baseline', 'candidate', 'revision',
  ]);
  for (const field of CI_FLOW_COMPARISON_FIELDS) {
    assert.ok(!/verdict|result|keep|revert/iu.test(field),
      'a pinned comparison must not be able to carry its own answer');
  }
  const sealedComparison = comparison(arm('b', 5, 5), arm('c', 5, 5));
  assert.deepEqual(Object.keys(sealedComparison).sort(), [...CI_FLOW_COMPARISON_FIELDS].sort());
  assert.equal(sealedComparison.effect, 'NONE');
  assert.equal(sealedComparison.authority, 'NONE');
});

test('O5: the guard is inside the digest, so loosening it changes the revision', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 5);
  const strict = comparison(baseline, candidate);
  const loosened = comparison(baseline, candidate, {
    guard: { maxRegressionMs: 10 * MINUTE, minImprovementMs: 1 },
  });
  assert.notEqual(loosened.revision, strict.revision);
  assert.deepEqual([...CI_FLOW_GUARD_FIELDS].sort(), ['maxRegressionMs', 'minImprovementMs']);
});

test('O5: a guard missing either bound, or carrying an unknown one, is refused', () => {
  const baseline = arm('b', 5, 5);
  const candidate = arm('c', 5, 5);
  refuses(() => comparison(baseline, candidate, { guard: { maxRegressionMs: 1 } }),
    'InvalidCiFlowComparison');
  refuses(
    () => comparison(baseline, candidate, { guard: { ...GUARD, tolerateRegression: true } }),
    'InvalidCiFlowComparison',
  );
  refuses(() => comparison(baseline, candidate, { guard: { ...GUARD, maxRegressionMs: -1 } }),
    'InvalidCiFlowComparison');
});

// -----------------------------------------------------------------------------------------------
// O4 — one observation cannot close two comparisons.
// -----------------------------------------------------------------------------------------------

test('O4: an identity already claimed by another comparison is refused', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 3);
  const artifact = sealed([...baseline, ...candidate]);
  const first = compareCiFlow({ comparison: comparison(baseline, candidate), artifact });
  assert.equal(first.claimedIdentities.length, 2 * CI_FLOW_MIN_SAMPLE);

  refuses(
    () => compareCiFlow({
      comparison: comparison(baseline, candidate),
      artifact,
      claimedIdentities: first.claimedIdentities,
    }),
    'ObservationAlreadyClaimed',
  );
});

test('O4: an overlap of even one run is enough to refuse the second comparison', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 3);
  const artifact = sealed([...baseline, ...candidate]);
  refuses(
    () => compareCiFlow({
      comparison: comparison(baseline, candidate),
      artifact,
      claimedIdentities: [identitiesOf(candidate)[2]],
    }),
    'ObservationAlreadyClaimed',
  );
});

test('O4: claim sets are pairwise disjoint, so the union equals the sum', () => {
  const first = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  const second = arm('c', CI_FLOW_MIN_SAMPLE, 3);
  const third = arm('d', CI_FLOW_MIN_SAMPLE, 4);
  const fourth = arm('e', CI_FLOW_MIN_SAMPLE, 4);
  const artifact = sealed([...first, ...second, ...third, ...fourth]);

  const pin = { baselineRevision: artifact.revision };
  const one = compareCiFlow({ comparison: comparison(first, second, pin), artifact });
  const two = compareCiFlow({
    comparison: comparison(third, fourth, pin), artifact, claimedIdentities: one.claimedIdentities,
  });
  const union = new Set([...one.claimedIdentities, ...two.claimedIdentities]);
  assert.equal(union.size, one.claimedIdentities.length + two.claimedIdentities.length);
});

test('O4: a comparison whose own two arms overlap is refused before any reading', () => {
  const shared = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  refuses(() => comparison(shared, shared), 'InvalidCiFlowComparison');
});

test('O4: an identity the artifact does not carry is refused, never treated as absent evidence', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 3);
  refuses(
    () => compareCiFlow({
      comparison: comparison(baseline, candidate, { baselineRevision: sealed(baseline).revision }),
      artifact: sealed(baseline),
    }),
    'UnknownObservation',
  );
});

// -----------------------------------------------------------------------------------------------
// O6 — the verdict, and what it refuses to say.
// -----------------------------------------------------------------------------------------------

test('O6: the verdict vocabulary is closed', () => {
  assert.deepEqual([...CI_FLOW_VERDICTS].sort(), ['KEEP', 'REVERT', 'UNKNOWN']);
});

test('O6: a candidate arm that improved past the guard is kept', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 10);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 5);
  const result = compareCiFlow({
    comparison: comparison(baseline, candidate), artifact: sealed([...baseline, ...candidate]),
  });
  assert.equal(result.verdict, 'KEEP');
  assert.equal(result.reasonCode, null);
  assert.equal(result.baselineP50Ms, 10 * MINUTE);
  assert.equal(result.candidateP50Ms, 5 * MINUTE);
  assert.equal(result.deltaMs, -5 * MINUTE);
});

test('O6: a candidate arm that regressed past the guard is reverted', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 10);
  const result = compareCiFlow({
    comparison: comparison(baseline, candidate), artifact: sealed([...baseline, ...candidate]),
  });
  assert.equal(result.verdict, 'REVERT');
  assert.equal(result.deltaMs, 5 * MINUTE);
});

test('O6: a change inside the guard answers UNKNOWN rather than the flattering verdict', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 5);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 5);
  const result = compareCiFlow({
    comparison: comparison(baseline, candidate), artifact: sealed([...baseline, ...candidate]),
  });
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.reasonCode, 'NO_DETECTABLE_EFFECT');
  assert.equal(result.deltaMs, 0);
});

test('O6: an arm below the minimum sample answers UNKNOWN, never KEEP', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE - 1, 10);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 2);
  const result = compareCiFlow({
    comparison: comparison(baseline, candidate), artifact: sealed([...baseline, ...candidate]),
  });
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.reasonCode, 'INSUFFICIENT_HISTORY');
  assert.equal(result.baselineP50Ms, null);
  assert.equal(result.candidateP50Ms, null);
  assert.equal(result.baselineSampleSize, CI_FLOW_MIN_SAMPLE - 1);
});

test('O6: cancellations in the candidate arm cannot manufacture an improvement', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 10);
  const candidate = [
    ...arm('c', CI_FLOW_MIN_SAMPLE, 10),
    ...arm('x', CI_FLOW_MIN_SAMPLE, 10).map((entry) => ({
      ...entry, runId: `z${entry.runId}`, conclusion: 'CANCELLED',
      completedAt: new Date(Date.parse(entry.startedAt) + 20_000).toISOString(),
      checks: [check({
        conclusion: 'CANCELLED',
        startedAt: entry.startedAt,
        completedAt: new Date(Date.parse(entry.startedAt) + 20_000).toISOString(),
      })],
    })),
  ];
  const result = compareCiFlow({
    comparison: comparison(baseline, candidate), artifact: sealed([...baseline, ...candidate]),
  });
  assert.equal(result.candidateP50Ms, 10 * MINUTE,
    'a lever that only cancels more runs must move no median');
  assert.equal(result.verdict, 'UNKNOWN');
  assert.equal(result.candidateSampleSize, CI_FLOW_MIN_SAMPLE);
});

test('O6: the result names the pinned baseline revision and the guard it was read under', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 10);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 5);
  const artifact = sealed([...baseline, ...candidate]);
  const pinned = comparison(baseline, candidate);
  const result = compareCiFlow({ comparison: pinned, artifact });
  assert.equal(result.baselineRevision, pinned.baselineRevision);
  assert.deepEqual(result.guard, { ...GUARD });
  assert.equal(result.lever, 'INTRODUCE_CACHING');
});

test('O6: a comparison pinned to a different artifact revision is refused', () => {
  const baseline = arm('b', CI_FLOW_MIN_SAMPLE, 10);
  const candidate = arm('c', CI_FLOW_MIN_SAMPLE, 5);
  refuses(
    () => compareCiFlow({
      comparison: comparison(baseline, candidate, { baselineRevision: '0'.repeat(64) }),
      artifact: sealed([...baseline, ...candidate]),
    }),
    'BaselineRevisionMismatch',
  );
});

test('O6: nothing in this module performs a revert', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow-optimization.mjs'), 'utf8');
  assert.ok(source.includes("'REVERT'"), 'the verdict is named');
  assert.ok(!/function\s+revert|performRevert|doRevert/u.test(source),
    'a REVERT is the operator instructing themselves, never this module acting');
});
