/**
 * ci-flow.test.mjs — the `gaia-ci-flow/1` artifact and its read model.
 *
 * Gates K1-K20 of `docs/ci-flow-optimization.md`. The operator failure behind all of them is a
 * control room that can say the engineering queue moved and cannot say what CI cost to move it,
 * or — worse — says it with a number derived from evidence that cannot contain the answer.
 *
 * Most of what is asserted here is what the model REFUSES to measure. The single most valuable
 * refusal is K8: subtracting a re-run's original creation instant from its attempt start is
 * arithmetically correct, produces a large plausible number, points the operator at runner
 * scarcity, and is wrong. A gate is the only thing that catches it, because review does not.
 *
 * Every hand-built artifact below is sealed with the shipped digest recipe over whatever fields
 * it carries, so a refusal can never be the digest check standing in for the rule under test.
 * Where a test means to break the digest, it breaks it explicitly.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CI_FLOW_CHECK_FIELDS,
  CI_FLOW_COMPARABLE_CONCLUSIONS,
  CI_FLOW_CONCLUSIONS,
  CI_FLOW_ENQUEUE_BASES,
  CI_FLOW_FIELDS,
  CI_FLOW_FRESH_MS,
  CI_FLOW_MIN_SAMPLE,
  CI_FLOW_OBSERVATION_FIELDS,
  CI_FLOW_PROVIDERS,
  CI_FLOW_REASONS,
  CI_FLOW_SCHEMA,
  CI_FLOW_SOURCE,
  CI_FLOW_TERMINAL_CONCLUSIONS,
  CI_FLOW_TRIGGERS,
  CiFlowError,
  MAX_CI_FLOW_OBSERVATIONS,
  ciFlowObservationIdentity,
  ciFlowRevision,
  deriveCiFlowBlock,
  requireCiFlowArtifact,
  sealCiFlow,
  summarizeCiFlow,
} from '../src/ci-flow.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

/** The instant every reading ends at. */
const OBSERVED = '2026-08-30T19:30:00.000Z';
/** Fourteen days before it, so no window is ever the thing under test here. */
const WINDOW_START = '2026-08-16T19:30:00.000Z';

const at = (msBeforeObserved) => new Date(Date.parse(OBSERVED) - msBeforeObserved).toISOString();

const SHA = 'a3f5c1d90b7e4826af10cc35b9d2e7418f60a5b2';
const OTHER_SHA = 'b'.repeat(40);
const WORK_DIGEST = 'c'.repeat(64);

const MINUTE = 60_000;

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

/**
 * One closed run: enqueued at T-52m, started at T-50m, completed at T-45m. So queue latency is
 * 120000ms and execution is 300000ms, and every duration in these gates is a round number a
 * reader can check by eye.
 */
const observation = (overrides = {}) => ({
  provider: 'GITHUB_ACTIONS',
  repositoryId: 'R_kgDOA1',
  repository: 'GuitarAlchemist/gaia',
  workflow: 'ci.yml',
  runId: '1001',
  attempt: 1,
  sha: SHA,
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
  checks: [check()],
  dependencies: null,
  ...overrides,
});

const sealed = (observations, overrides = {}) => sealCiFlow({
  observedAt: OBSERVED, windowStartedAt: WINDOW_START, sequence: 1, observations, ...overrides,
});

/** A hand-built artifact sealed with the shipped recipe over whatever fields it carries. */
function handBuilt({ observations = [observation()], ...overrides } = {}) {
  const body = {
    schema: CI_FLOW_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt: OBSERVED,
    windowStartedAt: WINDOW_START,
    sequence: 1,
    observations,
    ...overrides,
  };
  return { ...body, revision: ciFlowRevision(body) };
}

const block = (observations, overrides = {}) => deriveCiFlowBlock({
  artifact: sealed(observations, overrides), observedAt: OBSERVED,
});

const refuses = (fn, code = 'InvalidCiFlow') => {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof CiFlowError, `expected a CiFlowError, got ${error}`);
    assert.equal(error.code, code);
    return true;
  });
};

/** `n` distinct comparable runs, so a percentile has a legal sample. */
const runs = (count, shape = () => ({})) => Array.from({ length: count }, (_, index) => observation({
  runId: `20${String(index).padStart(2, '0')}`,
  ...shape(index),
}));

// -----------------------------------------------------------------------------------------------
// K1 — the closed vocabularies are exactly what the contract publishes.
// -----------------------------------------------------------------------------------------------

test('K1: the provider vocabulary is closed and names one provider today', () => {
  assert.deepEqual([...CI_FLOW_PROVIDERS], ['GITHUB_ACTIONS']);
  assert.ok(Object.isFrozen(CI_FLOW_PROVIDERS));
});

test('K1: the conclusion vocabulary is closed, terminal-only, and has no in-progress member', () => {
  assert.deepEqual([...CI_FLOW_CONCLUSIONS].sort(), [
    'ACTION_REQUIRED', 'CANCELLED', 'FAILURE', 'NEUTRAL', 'SKIPPED', 'STARTUP_FAILURE',
    'SUCCESS', 'TIMED_OUT',
  ]);
  assert.deepEqual([...CI_FLOW_TERMINAL_CONCLUSIONS].sort(), [...CI_FLOW_CONCLUSIONS].sort());
  for (const forbidden of ['IN_PROGRESS', 'QUEUED', 'WAITING', 'PENDING', 'REQUESTED', 'RUNNING']) {
    assert.ok(!CI_FLOW_CONCLUSIONS.includes(forbidden), `${forbidden} must be unsayable`);
  }
});

test('K1: the comparable conclusion set is a named constant, not a predicate', () => {
  assert.deepEqual([...CI_FLOW_COMPARABLE_CONCLUSIONS], ['SUCCESS', 'FAILURE']);
  assert.ok(Object.isFrozen(CI_FLOW_COMPARABLE_CONCLUSIONS));
  for (const excluded of ['CANCELLED', 'SKIPPED', 'TIMED_OUT', 'NEUTRAL', 'ACTION_REQUIRED']) {
    assert.ok(!CI_FLOW_COMPARABLE_CONCLUSIONS.includes(excluded));
  }
});

test('K1: the reason vocabulary is closed, frozen and free of duplicates', () => {
  assert.ok(Object.isFrozen(CI_FLOW_REASONS));
  assert.equal(new Set(CI_FLOW_REASONS).size, CI_FLOW_REASONS.length);
  for (const reason of [
    'NOT_EXPOSED', 'INSUFFICIENT_HISTORY', 'STALE', 'CORRUPT', 'NOT_APPLICABLE',
    'ATTEMPT_QUEUE_BASIS_NOT_EXPOSED', 'ATTEMPT_HISTORY_NOT_COLLECTED',
    'NO_PROVEN_DEPENDENCY_GRAPH', 'BILLING_NOT_EXPOSED', 'OBSERVATION_INCOMPLETE',
    'NO_OBSERVATIONS',
  ]) {
    assert.ok(CI_FLOW_REASONS.includes(reason), `${reason} must be a named reason`);
  }
});

test('K1: the enqueue basis and trigger vocabularies are closed', () => {
  assert.deepEqual([...CI_FLOW_ENQUEUE_BASES].sort(), ['ATTEMPT', 'RUN_CREATION']);
  assert.deepEqual([...CI_FLOW_TRIGGERS].sort(),
    ['MANUAL', 'OTHER', 'PULL_REQUEST', 'PUSH', 'SCHEDULE']);
});

// -----------------------------------------------------------------------------------------------
// K2 — the field lists are closed. An unknown field is refused, never ignored.
// -----------------------------------------------------------------------------------------------

test('K2: an unknown top-level field is refused', () => {
  refuses(() => requireCiFlowArtifact(handBuilt({ collector: 'nightly' })));
});

test('K2: an unknown observation field is refused rather than projected away', () => {
  refuses(() => sealed([{ ...observation(), runnerLabel: 'ubuntu-latest' }]));
  refuses(() => requireCiFlowArtifact(handBuilt({
    observations: [{ ...observation(), runnerLabel: 'ubuntu-latest' }],
  })));
});

test('K2: an unknown per-check field is refused', () => {
  refuses(() => sealed([observation({ checks: [{ ...check(), stepCount: 4 }] })]));
});

test('K2: the observation field list carries no field that could hold a patch or a command', () => {
  for (const field of CI_FLOW_OBSERVATION_FIELDS) {
    assert.ok(!/patch|diff|command|script|yaml|apply|write|mutate/iu.test(field),
      `${field} could carry a remediation`);
  }
  assert.ok(CI_FLOW_FIELDS.includes('revision'));
  assert.ok(CI_FLOW_CHECK_FIELDS.includes('workDigest'));
});

// -----------------------------------------------------------------------------------------------
// K3, K4 — only closed observations, and admissibility is checked before identity.
// -----------------------------------------------------------------------------------------------

test('K3: an observation with an unknown conclusion is refused', () => {
  refuses(() => sealed([observation({ conclusion: 'IN_PROGRESS' })]));
  refuses(() => sealed([observation({ conclusion: null })]));
});

test('K3: an observation with no completion instant is refused', () => {
  refuses(() => sealed([observation({ completedAt: null })]));
});

test('K4: a terminal run carrying a non-terminal check is refused at seal', () => {
  refuses(() => sealed([observation({ checks: [check({ conclusion: 'IN_PROGRESS' })] })]));
  refuses(() => sealed([observation({ checks: [check({ conclusion: null })] })]));
});

test('K4: a check with no completion instant is refused, so a truncated read cannot be sealed', () => {
  refuses(() => sealed([observation({ checks: [check({ completedAt: null })] })]));
});

// -----------------------------------------------------------------------------------------------
// K5, K6 — one digest recipe, one ordering, both enforced on read as well as on seal.
// -----------------------------------------------------------------------------------------------

test('K5: the seal is independent of the order the caller happened to spell the fields', () => {
  const forward = observation();
  const reversed = Object.fromEntries(Object.entries(forward).reverse());
  assert.equal(sealed([forward]).revision, sealed([reversed]).revision);
});

test('K5: an artifact whose revision does not match its content is refused', () => {
  const artifact = sealed([observation()]);
  refuses(() => requireCiFlowArtifact({ ...artifact, revision: 'f'.repeat(64) }));
});

test('K5: the digest recipe has exactly one implementation in the shipped source', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow.mjs'), 'utf8');
  assert.equal(source.split('createHash(\'sha256\')').length - 1, 1);
});

test('K6: the sealer orders by identity, not by the order observations were handed over', () => {
  const first = observation({ runId: '1001', attempt: 1 });
  const second = observation({ runId: '1001', attempt: 2, conclusion: 'FAILURE' });
  assert.equal(sealed([second, first]).revision, sealed([first, second]).revision);
  assert.deepEqual(
    sealed([second, first]).observations.map((entry) => entry.attempt), [1, 2],
  );
});

test('K6: a hand-written artifact gets no dispensation the sealer does not enjoy', () => {
  const first = observation({ runId: '1001', attempt: 1 });
  const second = observation({ runId: '1001', attempt: 2, conclusion: 'FAILURE' });
  refuses(() => requireCiFlowArtifact(handBuilt({ observations: [second, first] })));
});

test('K6: a repeated identity is refused, never de-duplicated', () => {
  refuses(() => sealed([observation(), observation()]));
});

test('K6: the identity is the four immutable parts and nothing else', () => {
  const one = observation();
  const renamed = observation({ repository: 'GuitarAlchemist/gaia-renamed' });
  assert.equal(ciFlowObservationIdentity(one), ciFlowObservationIdentity(renamed));
  assert.notEqual(ciFlowObservationIdentity(one),
    ciFlowObservationIdentity(observation({ attempt: 2 })));
  assert.notEqual(ciFlowObservationIdentity(one),
    ciFlowObservationIdentity(observation({ runId: '1002' })));
  assert.notEqual(ciFlowObservationIdentity(one),
    ciFlowObservationIdentity(observation({ repositoryId: 'R_other' })));
});

test('K6: an artifact carries at most the published number of observations', () => {
  refuses(() => sealed(runs(MAX_CI_FLOW_OBSERVATIONS + 1)));
});

// -----------------------------------------------------------------------------------------------
// K7 — the measurement lattice. UNKNOWN carries no value; MEASURED carries no reason.
// -----------------------------------------------------------------------------------------------

const cellsOf = (value, path = 'block') => {
  const found = [];
  if (!value || typeof value !== 'object') return found;
  if (Array.isArray(value)) {
    value.forEach((entry, index) => found.push(...cellsOf(entry, `${path}[${index}]`)));
    return found;
  }
  if (typeof value.state === 'string' && Object.hasOwn(value, 'reasonCode')) {
    found.push([path, value]);
  }
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'observations') continue;
    found.push(...cellsOf(nested, `${path}.${key}`));
  }
  return found;
};

test('K7: every cell obeys UNKNOWN => no value and MEASURED => no reason', () => {
  const measured = block(runs(CI_FLOW_MIN_SAMPLE));
  const withheld = block([]);
  for (const source of [measured, withheld]) {
    const cells = cellsOf(source);
    assert.ok(cells.length >= 8, 'the block must publish cells to check');
    for (const [path, cell] of cells) {
      assert.ok(['MEASURED', 'UNKNOWN'].includes(cell.state), `${path} has state ${cell.state}`);
      if (cell.state === 'UNKNOWN') {
        assert.ok(CI_FLOW_REASONS.includes(cell.reasonCode), `${path} names no known reason`);
        for (const [key, value] of Object.entries(cell)) {
          if (key === 'state' || key === 'reasonCode') continue;
          assert.ok(value === null || Array.isArray(value),
            `${path}.${key} must be null while the cell is UNKNOWN, got ${JSON.stringify(value)}`);
        }
      } else {
        assert.equal(cell.reasonCode, null, `${path} is MEASURED and still names a reason`);
      }
    }
  }
});

test('K7: an empty artifact publishes NO_OBSERVATIONS everywhere, and never a zero', () => {
  const empty = block([]);
  assert.equal(empty.observationCount, 0);
  assert.equal(empty.gate.state, 'UNKNOWN');
  assert.equal(empty.gate.reasonCode, 'NO_OBSERVATIONS');
  assert.equal(empty.gate.conclusion, null);
  assert.equal(empty.phases.executionMs.value, null);
  assert.equal(empty.percentiles.p50Ms, null);
});

// -----------------------------------------------------------------------------------------------
// K8 — the re-run queue-latency trap. The highest-value refusal in the contract.
// -----------------------------------------------------------------------------------------------

test('K8: queue latency is measured on a first attempt with an attempt-scoped basis', () => {
  const measured = block([observation()]);
  assert.equal(measured.phases.queueLatencyMs.state, 'MEASURED');
  assert.equal(measured.phases.queueLatencyMs.value, 2 * MINUTE);
});

test('K8: a re-run whose enqueue basis is the original run creation refuses a queue latency', () => {
  const rerun = block([
    observation({ attempt: 1, conclusion: 'FAILURE' }),
    observation({
      attempt: 2,
      enqueueBasis: 'RUN_CREATION',
      // The original creation instant, two days before this attempt ever started.
      enqueuedAt: at(2 * 24 * 60 * MINUTE),
    }),
  ]);
  assert.equal(rerun.phases.queueLatencyMs.state, 'UNKNOWN');
  assert.equal(rerun.phases.queueLatencyMs.reasonCode, 'ATTEMPT_QUEUE_BASIS_NOT_EXPOSED');
  assert.equal(rerun.phases.queueLatencyMs.value, null);
});

test('K8: a run-creation basis is still honest on attempt one, where it is the same instant', () => {
  const first = block([observation({ attempt: 1, enqueueBasis: 'RUN_CREATION' })]);
  assert.equal(first.phases.queueLatencyMs.state, 'MEASURED');
  assert.equal(first.phases.queueLatencyMs.value, 2 * MINUTE);
});

test('K8: an absent enqueue instant reads NOT_EXPOSED, never zero', () => {
  const bare = block([observation({ enqueuedAt: null, enqueueBasis: 'ATTEMPT' })]);
  assert.equal(bare.phases.queueLatencyMs.state, 'UNKNOWN');
  assert.equal(bare.phases.queueLatencyMs.reasonCode, 'NOT_EXPOSED');
  assert.equal(bare.phases.queueLatencyMs.value, null);
});

// -----------------------------------------------------------------------------------------------
// K9, K10 — retries need the whole attempt chain, and three durations stay three.
// -----------------------------------------------------------------------------------------------

test('K9: a complete attempt chain measures retries as one less than the attempt count', () => {
  const chain = block([
    observation({ attempt: 1, conclusion: 'FAILURE' }),
    observation({ attempt: 2, conclusion: 'FAILURE' }),
    observation({ attempt: 3 }),
  ]);
  assert.equal(chain.retries.state, 'MEASURED');
  assert.equal(chain.retries.value, 2);
});

test('K9: holding only the latest attempt refuses a retry count rather than reporting zero', () => {
  const latestOnly = block([observation({ attempt: 3 })]);
  assert.equal(latestOnly.retries.state, 'UNKNOWN');
  assert.equal(latestOnly.retries.reasonCode, 'ATTEMPT_HISTORY_NOT_COLLECTED');
  assert.equal(latestOnly.retries.value, null);
});

test('K9: a gap in the middle of the chain is as unmeasurable as a missing head', () => {
  const gapped = block([
    observation({ attempt: 1, conclusion: 'FAILURE' }),
    observation({ attempt: 3 }),
  ]);
  assert.equal(gapped.retries.state, 'UNKNOWN');
  assert.equal(gapped.retries.reasonCode, 'ATTEMPT_HISTORY_NOT_COLLECTED');
});

test('K10: terminal duration, total consumed span and attempt count are three quantities', () => {
  const chain = block([
    observation({ attempt: 1, conclusion: 'FAILURE', completedAt: at(46 * MINUTE) }),
    observation({ attempt: 2 }),
  ]);
  const [run] = chain.runs;
  assert.equal(run.attemptCount, 2);
  assert.equal(run.terminalDurationMs, 5 * MINUTE);
  assert.equal(run.totalConsumedMs, 9 * MINUTE);
  assert.notEqual(run.terminalDurationMs, run.totalConsumedMs);
  assert.ok(run.terminalDurationMs <= run.totalConsumedMs);
});

// -----------------------------------------------------------------------------------------------
// K11 — the comparable set, named rather than filtered. The false-win generator.
// -----------------------------------------------------------------------------------------------

test('K11: a cancelled run contributes no duration to the comparable percentiles', () => {
  const honest = block(runs(CI_FLOW_MIN_SAMPLE));
  const contaminated = block([
    ...runs(CI_FLOW_MIN_SAMPLE),
    ...runs(4, (index) => ({
      runId: `90${index}`,
      conclusion: 'CANCELLED',
      completedAt: at(50 * MINUTE - 20_000),
    })),
  ]);
  assert.equal(honest.percentiles.state, 'MEASURED');
  assert.equal(contaminated.percentiles.state, 'MEASURED');
  assert.equal(contaminated.percentiles.sampleSize, CI_FLOW_MIN_SAMPLE);
  assert.equal(contaminated.percentiles.p50Ms, honest.percentiles.p50Ms,
    'four twenty-second cancellations must not move the median');
});

test('K11: timed-out and skipped runs are excluded from the distribution by name', () => {
  const withCensored = block([
    ...runs(CI_FLOW_MIN_SAMPLE),
    observation({ runId: '901', conclusion: 'TIMED_OUT' }),
    observation({ runId: '902', conclusion: 'SKIPPED', completedAt: at(50 * MINUTE) }),
  ]);
  assert.equal(withCensored.percentiles.sampleSize, CI_FLOW_MIN_SAMPLE);
  assert.deepEqual([...withCensored.percentiles.comparableConclusions],
    [...CI_FLOW_COMPARABLE_CONCLUSIONS]);
});

test('K11: a skipped run reads NOT_APPLICABLE for execution, never a measured zero', () => {
  const skipped = block([observation({
    conclusion: 'SKIPPED',
    completedAt: at(50 * MINUTE),
    checks: [check({ conclusion: 'SKIPPED', completedAt: at(50 * MINUTE) })],
  })]);
  assert.equal(skipped.phases.executionMs.state, 'UNKNOWN');
  assert.equal(skipped.phases.executionMs.reasonCode, 'NOT_APPLICABLE');
  assert.equal(skipped.phases.executionMs.value, null);
});

test('K11: cancellations are counted even though their durations are not', () => {
  const counted = block([
    ...runs(CI_FLOW_MIN_SAMPLE),
    observation({ runId: '901', conclusion: 'CANCELLED' }),
  ]);
  assert.equal(counted.cancellations.state, 'MEASURED');
  assert.equal(counted.cancellations.value, 1);
});

// -----------------------------------------------------------------------------------------------
// K12 — binding is proven only.
// -----------------------------------------------------------------------------------------------

test('K12: an absent pull request reads PR_NOT_PROVEN rather than an absence', () => {
  const pushRun = block([observation({ trigger: 'PUSH', pullRequest: null })]);
  assert.equal(pushRun.gate.pullRequestBinding, 'PR_NOT_PROVEN');
  assert.equal(pushRun.gate.pullRequest, null);
});

test('K12: a proven pull request is published as proven', () => {
  const prRun = block([observation({ trigger: 'PULL_REQUEST', pullRequest: 38 })]);
  assert.equal(prRun.gate.pullRequestBinding, 'PROVEN');
  assert.equal(prRun.gate.pullRequest, 38);
});

test('K12: no code path derives a pull-request binding from a branch name', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow.mjs'), 'utf8');
  const suspicious = source.split('\n').filter((line) => /branch/u.test(line)
    && /pullRequest/iu.test(line));
  assert.deepEqual(suspicious, [], 'branch and pull request must never meet on one line');
});

test('K12: a fork run on a feature branch is bound no more than a push run is', () => {
  const fork = block([observation({
    trigger: 'PULL_REQUEST', branch: 'contributor:feature', pullRequest: null,
  })]);
  assert.equal(fork.gate.pullRequestBinding, 'PR_NOT_PROVEN');
});

// -----------------------------------------------------------------------------------------------
// K13, K14 — incoherent time is refused or named, never clamped.
// -----------------------------------------------------------------------------------------------

test('K13: a completion before its start is refused, not clamped to zero', () => {
  refuses(() => sealed([observation({ completedAt: at(51 * MINUTE) })]));
});

test('K13: a check completing before it started is refused', () => {
  refuses(() => sealed([observation({
    checks: [check({ startedAt: at(45 * MINUTE), completedAt: at(50 * MINUTE) })],
  })]));
});

test('K13: an observation dated after the instant it was read is refused, never aged to zero', () => {
  const future = handBuilt({
    observations: [observation({ completedAt: new Date(Date.parse(OBSERVED) + MINUTE).toISOString() })],
  });
  refuses(() => requireCiFlowArtifact(future));
});

test('K13: a reading instant before the artifact instant is refused as incoherent', () => {
  const artifact = sealed([observation()]);
  refuses(
    () => summarizeCiFlow({
      artifact, observedAt: new Date(Date.parse(OBSERVED) - MINUTE).toISOString(),
    }),
    'IncoherentCiFlow',
  );
});

test('K13: no duration in the shipped source is guarded by a zero clamp', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow.mjs'), 'utf8');
  assert.ok(!/Math\.max\(\s*0\s*,/u.test(source), 'a zero clamp would manufacture a measured zero');
  assert.ok(!/localeCompare/u.test(source), 'locale ordering is host- and ICU-dependent');
});

test('K13: a runner acquired outside the enqueue-to-start interval is refused', () => {
  refuses(() => sealed([observation({ runnerAcquiredAt: at(53 * MINUTE) })]));
  refuses(() => sealed([observation({ runnerAcquiredAt: at(44 * MINUTE) })]));
});

test('K14: a phase decomposition larger than the span it decomposes withholds only the split', () => {
  const overrun = block([observation({
    checks: [check({ setupMs: 400 * 1000 })],
  })]);
  assert.equal(overrun.phases.setupMs.state, 'UNKNOWN');
  assert.equal(overrun.phases.setupMs.reasonCode, 'CORRUPT');
  assert.equal(overrun.phases.executionMs.state, 'MEASURED',
    'the span itself is still evidence; only the split is incoherent');
  assert.equal(overrun.phases.executionMs.value, 5 * MINUTE);
});

test('K14: a coherent setup decomposition is measured', () => {
  const measured = block([observation({ checks: [check({ setupMs: 30_000 })] })]);
  assert.equal(measured.phases.setupMs.state, 'MEASURED');
  assert.equal(measured.phases.setupMs.value, 30_000);
});

// -----------------------------------------------------------------------------------------------
// K15 — a partial read reads NOT_EXPOSED, and contributes to no total.
// -----------------------------------------------------------------------------------------------

test('K15: an absent runner instant reads NOT_EXPOSED for startup, never zero', () => {
  const bare = block([observation({ runnerAcquiredAt: null })]);
  assert.equal(bare.phases.runnerStartupMs.state, 'UNKNOWN');
  assert.equal(bare.phases.runnerStartupMs.reasonCode, 'NOT_EXPOSED');
  assert.equal(bare.phases.runnerStartupMs.value, null);
});

test('K15: a carried runner instant is measured', () => {
  const measured = block([observation({ runnerAcquiredAt: at(51 * MINUTE) })]);
  assert.equal(measured.phases.runnerStartupMs.state, 'MEASURED');
  assert.equal(measured.phases.runnerStartupMs.value, MINUTE);
});

test('K15: an observation the producer marked incomplete contributes to no percentile', () => {
  const partial = block([
    ...runs(CI_FLOW_MIN_SAMPLE),
    ...runs(3, (index) => ({ runId: `95${index}`, complete: false })),
  ]);
  assert.equal(partial.percentiles.sampleSize, CI_FLOW_MIN_SAMPLE);
  assert.equal(partial.withheldCount, 3);
  assert.equal(partial.percentiles.sampleSize + partial.withheldCount,
    partial.observationCount, 'no observation may silently vanish from a denominator');
});

test('K15: an absent phase array reads NOT_EXPOSED rather than attributing the whole span', () => {
  const noChecks = block([observation({ checks: [] })]);
  assert.equal(noChecks.phases.setupMs.state, 'UNKNOWN');
  assert.equal(noChecks.phases.setupMs.reasonCode, 'NOT_EXPOSED');
});

// -----------------------------------------------------------------------------------------------
// K16 — percentiles need a legal sample.
// -----------------------------------------------------------------------------------------------

test('K16: fewer than the minimum comparable runs refuses a percentile', () => {
  const thin = block(runs(CI_FLOW_MIN_SAMPLE - 1));
  assert.equal(thin.percentiles.state, 'UNKNOWN');
  assert.equal(thin.percentiles.reasonCode, 'INSUFFICIENT_HISTORY');
  assert.equal(thin.percentiles.p50Ms, null);
  assert.equal(thin.percentiles.p95Ms, null);
  assert.equal(thin.percentiles.sampleSize, CI_FLOW_MIN_SAMPLE - 1,
    'the sample size is still reported, so the operator knows how far off they are');
});

test('K16: at the minimum sample both percentiles are published from one sorted list', () => {
  const spread = block(runs(CI_FLOW_MIN_SAMPLE, (index) => ({
    completedAt: at((50 - (index + 1)) * MINUTE),
  })));
  assert.equal(spread.percentiles.state, 'MEASURED');
  assert.equal(spread.percentiles.sampleSize, CI_FLOW_MIN_SAMPLE);
  assert.equal(spread.percentiles.p50Ms, 3 * MINUTE);
  assert.equal(spread.percentiles.p95Ms, 5 * MINUTE);
  assert.ok(spread.percentiles.p95Ms >= spread.percentiles.p50Ms);
});

// -----------------------------------------------------------------------------------------------
// K17 — billable time is provider-reported or it is not reported.
// -----------------------------------------------------------------------------------------------

test('K17: consumed runner time is refused when the provider reported none', () => {
  const unbilled = block(runs(CI_FLOW_MIN_SAMPLE));
  assert.equal(unbilled.consumedRunner.state, 'UNKNOWN');
  assert.equal(unbilled.consumedRunner.reasonCode, 'BILLING_NOT_EXPOSED');
  assert.equal(unbilled.consumedRunner.totalMs, null);
  assert.equal(unbilled.consumedRunner.minutes, null);
});

test('K17: a provider-reported billable figure is published verbatim and never reconciled', () => {
  const billed = block(runs(CI_FLOW_MIN_SAMPLE, () => ({ billableMs: 3_600_000 })));
  assert.equal(billed.consumedRunner.state, 'MEASURED');
  assert.equal(billed.consumedRunner.totalMs, 5 * 3_600_000);
  assert.equal(billed.consumedRunner.minutes, 300);
  assert.notEqual(billed.consumedRunner.totalMs, billed.percentiles.p50Ms * CI_FLOW_MIN_SAMPLE,
    'billable time and wall clock are two quantities and must not coincide by construction');
});

test('K17: a provider-reported zero is a measured zero, not a missing reading', () => {
  const selfHosted = block(runs(CI_FLOW_MIN_SAMPLE, () => ({ billableMs: 0 })));
  assert.equal(selfHosted.consumedRunner.state, 'MEASURED');
  assert.equal(selfHosted.consumedRunner.totalMs, 0);
});

test('K17: no operating-system multiplier table exists in the shipped source', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow.mjs'), 'utf8');
  assert.ok(!/UBUNTU|MACOS|WINDOWS_RUNNER|multiplier/iu.test(source),
    'a multiplier table is how wall clock becomes a fabricated cost');
});

// -----------------------------------------------------------------------------------------------
// K18 — the slowest check is a vertex; the critical path is a path.
// -----------------------------------------------------------------------------------------------

const chained = () => observation({
  checks: [
    check({ checkId: 'a', name: 'a', startedAt: at(50 * MINUTE), completedAt: at(48 * MINUTE) }),
    check({ checkId: 'b', name: 'b', startedAt: at(48 * MINUTE), completedAt: at(46 * MINUTE) }),
    check({ checkId: 'c', name: 'c', startedAt: at(46 * MINUTE), completedAt: at(44 * MINUTE) }),
    check({ checkId: 'd', name: 'd', startedAt: at(50 * MINUTE), completedAt: at(45 * MINUTE) }),
  ],
  completedAt: at(44 * MINUTE),
  dependencies: [['a', 'b'], ['b', 'c']],
});

test('K18: the critical path is the longest chain, not the longest single check', () => {
  const graphed = block([chained()]);
  assert.equal(graphed.slowestCheck.state, 'MEASURED');
  assert.equal(graphed.slowestCheck.checkId, 'd');
  assert.equal(graphed.slowestCheck.durationMs, 5 * MINUTE);

  assert.equal(graphed.criticalPath.state, 'MEASURED');
  assert.deepEqual([...graphed.criticalPath.checkIds], ['a', 'b', 'c']);
  assert.equal(graphed.criticalPath.durationMs, 6 * MINUTE);
  assert.notEqual(graphed.criticalPath.checkIds.at(-1), graphed.slowestCheck.checkId);
});

test('K18: without a carried edge set the critical path is refused and the slowest check is not', () => {
  const ungraphed = block([observation({ ...chained(), dependencies: null })]);
  assert.equal(ungraphed.criticalPath.state, 'UNKNOWN');
  assert.equal(ungraphed.criticalPath.reasonCode, 'NO_PROVEN_DEPENDENCY_GRAPH');
  assert.equal(ungraphed.criticalPath.durationMs, null);
  assert.deepEqual([...ungraphed.criticalPath.checkIds], []);
  assert.equal(ungraphed.slowestCheck.state, 'MEASURED');
  assert.equal(ungraphed.slowestCheck.durationMs, 5 * MINUTE);
});

test('K18: the critical path never exceeds the run span it lies inside', () => {
  const graphed = block([chained()]);
  assert.ok(graphed.criticalPath.durationMs <= graphed.phases.executionMs.value);
});

test('K18: an edge naming a check that is not carried is refused', () => {
  refuses(() => sealed([observation({ ...chained(), dependencies: [['a', 'missing']] })]));
});

test('K18: a dependency cycle is refused rather than searched forever', () => {
  refuses(() => sealed([observation({
    ...chained(), dependencies: [['a', 'b'], ['b', 'c'], ['c', 'a']],
  })]));
});

// -----------------------------------------------------------------------------------------------
// K19, K20 — a rename moves no number, and a real zero survives.
// -----------------------------------------------------------------------------------------------

test('K19: renaming the repository changes the label and no derived number', () => {
  const before = block(runs(CI_FLOW_MIN_SAMPLE));
  const after = block(runs(CI_FLOW_MIN_SAMPLE, () => ({ repository: 'Someone/renamed' })));
  assert.equal(before.percentiles.p50Ms, after.percentiles.p50Ms);
  assert.equal(before.runCount, after.runCount);
  assert.notEqual(before.gate.repository, after.gate.repository);
});

test('K20: a genuine zero is published as MEASURED, so the lattice is not all-unknown', () => {
  const clean = block(runs(CI_FLOW_MIN_SAMPLE));
  assert.equal(clean.cancellations.state, 'MEASURED');
  assert.equal(clean.cancellations.value, 0);
  assert.equal(clean.retries.state, 'MEASURED');
  assert.equal(clean.retries.value, 0);
});

// -----------------------------------------------------------------------------------------------
// The published block's own disclaimers and freshness.
// -----------------------------------------------------------------------------------------------

test('K20: the block publishes its source, an absent binding and an unclaimed readiness', () => {
  const published = block(runs(CI_FLOW_MIN_SAMPLE));
  assert.equal(published.source, CI_FLOW_SOURCE);
  assert.equal(published.binding, 'NONE');
  assert.equal(published.readiness, 'NOT_CLAIMED');
  assert.equal(published.freshnessWindowMs, CI_FLOW_FRESH_MS);
});

test('K20: stale evidence withholds the present-tense gate and keeps the historical percentiles', () => {
  const artifact = sealed(runs(CI_FLOW_MIN_SAMPLE));
  const later = new Date(Date.parse(OBSERVED) + CI_FLOW_FRESH_MS + MINUTE).toISOString();
  const stale = deriveCiFlowBlock({ artifact, observedAt: later });
  assert.equal(stale.state, 'STALE');
  assert.equal(stale.gate.state, 'UNKNOWN');
  assert.equal(stale.gate.reasonCode, 'STALE');
  assert.equal(stale.percentiles.state, 'MEASURED');
});

test('K20: the block carries its observations verbatim so a reader can re-derive every number', () => {
  const observations = runs(CI_FLOW_MIN_SAMPLE);
  const published = block(observations);
  assert.equal(published.observations.length, CI_FLOW_MIN_SAMPLE);
  const rebuilt = deriveCiFlowBlock({
    artifact: sealCiFlow({
      observedAt: published.observedAt,
      windowStartedAt: published.windowStartedAt,
      sequence: published.sequence,
      observations: published.observations,
    }),
    observedAt: OBSERVED,
  });
  assert.equal(JSON.stringify(rebuilt), JSON.stringify(published));
});

test('K20: a source snapshot that went backwards is refused rather than displayed', () => {
  const artifact = sealed(runs(CI_FLOW_MIN_SAMPLE), { sequence: 2 });
  refuses(
    () => summarizeCiFlow({
      artifact, observedAt: OBSERVED, priorObservation: { observedAt: OBSERVED, sequence: 5 },
    }),
    'IncoherentCiFlow',
  );
});

test('K20: the module holds no clock and opens nothing', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow.mjs'), 'utf8');
  assert.ok(!/new Date\(\)/u.test(source), 'the model must take its instant as an argument');
  assert.ok(!/Date\.now\(\)/u.test(source));
  assert.ok(!/node:fs|node:https|node:http|node:net|fetch\(/u.test(source));
  for (const forbidden of ['workflowPatch', 'applyLever', 'rerun', 'dispatch']) {
    assert.ok(!source.includes(forbidden), `${forbidden} would be a mutation seam`);
  }
});

test('K20: the other sha constant differs, proving the fixtures are not accidentally identical', () => {
  assert.notEqual(SHA, OTHER_SHA);
  assert.equal(WORK_DIGEST.length, 64);
  const distinct = block([observation({ sha: OTHER_SHA })]);
  assert.equal(distinct.gate.sha, OTHER_SHA);
});
