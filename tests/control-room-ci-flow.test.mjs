/**
 * control-room-ci-flow.test.mjs — the CI flow block as a published, re-derived, rendered section.
 *
 * Gates C1-C7 and the six mechanism reverts MR1-MR6 of `docs/ci-flow-optimization.md`.
 *
 * The operator failure behind this file is a control room that can say the engineering queue moved
 * and cannot say what CI cost to move it. The danger in fixing that is conflation: a green
 * pipeline is not a ready feature, and a CI run is not a unit of delivery. Most of what is
 * asserted here is therefore what the CI section still refuses to touch — the headline, the next
 * action, the obstruction, and every number the flow block publishes.
 *
 * The mechanism reverts are the load-bearing part. Each one makes a single textual change to a
 * shipped module and shows that the gate above it stops holding, which is the difference between
 * a rule that is enforced and a rule that is merely written down.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { CI_FLOW_MIN_SAMPLE, ciFlowObservationIdentity, sealCiFlow } from '../src/ci-flow.mjs';
import {
  ControlRoomError, buildControlRoomSnapshot, renderControlRoomHtml, requireControlRoomSnapshot,
} from '../src/control-room.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SHA = 'a'.repeat(64);
const AT = '2026-08-30T19:30:00.000Z';
const WINDOW_START = '2026-08-16T19:30:00.000Z';
const MINUTE = 60_000;
const at = (msBefore) => new Date(Date.parse(AT) - msBefore).toISOString();

const scratch = mkdtempSync(join(tmpdir(), 'gaia-ci-room-'));
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

/** Reseal a tampered snapshot, so the digest can never stand in for the re-derivation gate. */
const reseal = (body) => {
  const { revision, ...rest } = body;
  return { ...rest, revision: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
};

/** Load a one-expression mutant of a shipped module, so a gate can be shown to be a mechanism. */
async function importMutant(file, name, mutate) {
  const source = readFileSync(join(ROOT, 'src', file), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const rewritten = mutated.replaceAll("from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`);
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, rewritten, 'utf8');
  return import(pathToFileURL(path).href);
}

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
  return { ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

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

const runs = (count, shape = () => ({})) => Array.from({ length: count }, (_, index) => observation({
  runId: `20${String(index).padStart(2, '0')}`,
  ...shape(index),
}));

const ciFlow = (observations = runs(CI_FLOW_MIN_SAMPLE), overrides = {}) => sealCiFlow({
  observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations, ...overrides,
});

const snapshotWith = (artifact, extra = {}) => buildControlRoomSnapshot({
  drainProjection: projection(),
  observedAt: AT,
  ciFlow: artifact,
  ...extra,
});

const ciSection = (html) => {
  const start = html.indexOf('<section class="section-panel ci-flow"');
  assert.notEqual(start, -1, 'the CI flow section is rendered');
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, 'the CI flow section closes');
  return html.slice(start, end + '</section>'.length);
};

const styleOf = (html) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));

// -----------------------------------------------------------------------------------------------
// C1 — the block is published only when the artifact is supplied, and omitted otherwise.
// -----------------------------------------------------------------------------------------------

test('C1: a snapshot built without the artifact omits the key rather than publishing null', () => {
  const bare = buildControlRoomSnapshot({ drainProjection: projection(), observedAt: AT });
  assert.equal(Object.hasOwn(bare, 'ciFlow'), false,
    'a present null would canonicalise into the digest and move every published revision');
  assert.equal(requireControlRoomSnapshot(bare).revision, bare.revision);
});

test('C1: a supplied artifact is published, re-derived and accepted by the verifier', () => {
  const snapshot = snapshotWith(ciFlow());
  assert.equal(snapshot.ciFlow.source, 'GAIA_CI_FLOW');
  assert.equal(snapshot.ciFlow.observationCount, CI_FLOW_MIN_SAMPLE);
  assert.equal(requireControlRoomSnapshot(snapshot).revision, snapshot.revision);
});

test('C1: an incoherent artifact is refused by the builder, never displayed', () => {
  const artifact = ciFlow();
  assert.throws(
    () => snapshotWith({ ...artifact, revision: 'f'.repeat(64) }),
    (error) => {
      assert.ok(error instanceof ControlRoomError);
      assert.equal(error.code, 'InvalidCiFlow');
      return true;
    },
  );
});

test('C1: an artifact dated after the reading instant is refused as incoherent evidence', () => {
  const later = new Date(Date.parse(AT) + MINUTE).toISOString();
  const artifact = sealCiFlow({
    observedAt: later, windowStartedAt: WINDOW_START, sequence: 11, observations: runs(1),
  });
  assert.throws(() => snapshotWith(artifact), (error) => {
    assert.equal(error.code, 'IncoherentEvidence');
    return true;
  });
});

test('C1: a source snapshot that went backwards is refused', () => {
  assert.throws(
    () => snapshotWith(ciFlow(), { priorCiFlow: { observedAt: AT, sequence: 99 } }),
    (error) => {
      assert.equal(error.code, 'IncoherentEvidence');
      return true;
    },
  );
});

// -----------------------------------------------------------------------------------------------
// C2 — the render seam re-derives every number from the block's own carried evidence.
// -----------------------------------------------------------------------------------------------

test('C2: a snapshot whose published percentile is not what its evidence derives is refused', () => {
  const snapshot = snapshotWith(ciFlow());
  const tampered = reseal({
    ...snapshot,
    ciFlow: {
      ...snapshot.ciFlow,
      percentiles: { ...snapshot.ciFlow.percentiles, p50Ms: 1 },
    },
  });
  assert.throws(() => requireControlRoomSnapshot(tampered), (error) => {
    assert.equal(error.code, 'InvalidCiFlow');
    return true;
  });
});

test('C2: an unobserved cell resealed as a measured zero is refused', () => {
  const snapshot = snapshotWith(ciFlow());
  const tampered = reseal({
    ...snapshot,
    ciFlow: {
      ...snapshot.ciFlow,
      phases: {
        ...snapshot.ciFlow.phases,
        runnerStartupMs: { state: 'MEASURED', reasonCode: null, value: 0 },
      },
    },
  });
  assert.throws(() => requireControlRoomSnapshot(tampered), (error) => {
    assert.equal(error.code, 'InvalidCiFlow');
    return true;
  });
});

test('C2: dropping an observation from the carried evidence is refused', () => {
  const snapshot = snapshotWith(ciFlow());
  const tampered = reseal({
    ...snapshot,
    ciFlow: { ...snapshot.ciFlow, observations: snapshot.ciFlow.observations.slice(1) },
  });
  assert.throws(() => requireControlRoomSnapshot(tampered), (error) => {
    assert.equal(error.code, 'InvalidCiFlow');
    return true;
  });
});

// -----------------------------------------------------------------------------------------------
// C3, C4, C5 — both languages, no stylesheet residue, and colour is never the meaning.
// -----------------------------------------------------------------------------------------------

test('C3: the section renders in both published languages', () => {
  const snapshot = snapshotWith(ciFlow());
  const english = ciSection(renderControlRoomHtml(snapshot, { language: 'en' }));
  const french = ciSection(renderControlRoomHtml(snapshot, { language: 'fr' }));
  assert.match(english, /<h2>[^<]*CI[^<]*<\/h2>/u);
  assert.notEqual(french, english, 'the phrasebook must actually differ');
  assert.ok(!/undefined/u.test(french), 'a missing French key renders as undefined');
  assert.ok(!/undefined/u.test(english));
});

test('C4: no CI stylesheet residue remains when the artifact is absent', () => {
  const withArtifact = styleOf(renderControlRoomHtml(snapshotWith(ciFlow())));
  const without = styleOf(renderControlRoomHtml(
    buildControlRoomSnapshot({ drainProjection: projection(), observedAt: AT }),
  ));
  assert.ok(withArtifact.includes('ci-flow'));
  assert.ok(!without.includes('ci-flow'), 'the stylesheet must not carry rules for absent markup');
});

test('C5: every published state carries a data attribute and a word, never only a colour', () => {
  const section = ciSection(renderControlRoomHtml(snapshotWith(ciFlow([
    ...runs(CI_FLOW_MIN_SAMPLE),
    observation({ runId: '900', runnerAcquiredAt: null }),
  ]))));
  assert.match(section, /data-state="MEASURED"/u);
  assert.match(section, /data-state="UNKNOWN"/u);
  assert.match(section, /data-reason="NOT_EXPOSED"/u);
  assert.match(section, /aria-label="/u);
  assert.ok(!/<blink|animation:/u.test(section), 'nothing in a standing measurement animates');
});

test('C5: an unknown cell renders a named reason and never a zero', () => {
  const section = ciSection(renderControlRoomHtml(snapshotWith(ciFlow(runs(2)))));
  assert.match(section, /data-reason="INSUFFICIENT_HISTORY"/u);
  const percentileCell = section.slice(section.indexOf('data-cell="percentiles"'));
  assert.ok(!/>0</u.test(percentileCell.slice(0, 400)),
    'an unmeasured percentile must not render as zero');
});

// -----------------------------------------------------------------------------------------------
// C6, C7 — green CI is not readiness, and it moves nothing that speaks about delivery.
// -----------------------------------------------------------------------------------------------

test('C6: the block publishes an unclaimed readiness and an absent binding', () => {
  const snapshot = snapshotWith(ciFlow());
  assert.equal(snapshot.ciFlow.readiness, 'NOT_CLAIMED');
  assert.equal(snapshot.ciFlow.binding, 'NONE');
  const section = ciSection(renderControlRoomHtml(snapshot));
  assert.match(section, /NOT_CLAIMED|not claimed|non revendiqué/iu,
    'the disclaimer is rendered, not merely carried');
});

test('C7: flipping every conclusion changes the CI block and nothing else', () => {
  const green = snapshotWith(ciFlow(runs(CI_FLOW_MIN_SAMPLE)));
  const red = snapshotWith(ciFlow(runs(CI_FLOW_MIN_SAMPLE, () => ({
    conclusion: 'FAILURE', checks: [check({ conclusion: 'FAILURE' })],
  }))));

  assert.notEqual(canonicalJson(red.ciFlow), canonicalJson(green.ciFlow));
  const { ciFlow: _greenBlock, revision: _greenRevision, ...greenRest } = green;
  const { ciFlow: _redBlock, revision: _redRevision, ...redRest } = red;
  assert.equal(canonicalJson(redRest), canonicalJson(greenRest),
    'a CI conclusion must move no block that speaks about delivery');
});

test('C7: the CI block is passed into no consumer that speaks about delivery', () => {
  const source = readFileSync(join(ROOT, 'src', 'control-room.mjs'), 'utf8');
  assert.notEqual(source.indexOf('const ciFlowBlock ='), -1, 'the block is derived in the builder');
  // The block being absent from the arguments of every consumer is the mechanical form of "a
  // green pipeline is not a unit of delivery". Asserting it on the call sites rather than on the
  // block is what makes it checkable: a reader can see which functions are named here.
  for (const consumer of ['headlineState', 'forecastEta', 'measurePace', 'blockerSummary',
    'nextActionFor', 'itemActivity']) {
    assert.equal(
      new RegExp(String.raw`\b${consumer}\([^)]*ciFlow`, 'u').test(source), false,
      `${consumer} must not be handed the CI block`,
    );
  }
  for (const line of source.split('\n')) {
    if (!line.includes('ciFlowBlock')) continue;
    assert.ok(!/headline|nextAction|obstruction|pace/iu.test(line),
      `the CI block shares a line with a delivery reading: ${line.trim()}`);
  }
});

// -----------------------------------------------------------------------------------------------
// MR1-MR6 — each rule shown to be a mechanism by reverting it.
// -----------------------------------------------------------------------------------------------

test('MR1: admitting an in-progress conclusion is what lets a running job be counted as fast', async () => {
  const running = observation({
    conclusion: 'IN_PROGRESS', checks: [check({ conclusion: 'IN_PROGRESS' })],
  });
  assert.throws(() => sealCiFlow({
    observedAt: AT, windowStartedAt: WINDOW_START, sequence: 1, observations: [running],
  }));

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr1',
    (source) => source.replace("'SUCCESS', 'TIMED_OUT',", "'SUCCESS', 'TIMED_OUT', 'IN_PROGRESS',"));
  const admitted = mutant.sealCiFlow({
    observedAt: AT, windowStartedAt: WINDOW_START, sequence: 1, observations: [running],
  });
  assert.equal(admitted.observations[0].conclusion, 'IN_PROGRESS',
    'the mutant seals what the shipped module refuses');
});

test('MR2: publishing a measured zero instead of a named reason is what reassures falsely', async () => {
  const bare = [observation({ runnerAcquiredAt: null })];
  const shipped = snapshotWith(ciFlow(bare));
  assert.equal(shipped.ciFlow.phases.runnerStartupMs.state, 'UNKNOWN');
  assert.equal(shipped.ciFlow.phases.runnerStartupMs.value, null);

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr2', (source) => source.replace(
    "({ state: 'UNKNOWN', reasonCode, value: null })",
    "({ state: 'MEASURED', reasonCode: null, value: 0 })",
  ));
  const reassuring = mutant.deriveCiFlowBlock({
    artifact: mutant.sealCiFlow({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations: bare,
    }),
    observedAt: AT,
  });
  assert.equal(reassuring.phases.runnerStartupMs.value, 0,
    'the mutant prints a runner startup of zero for evidence nobody has');
});

test('MR3: letting the slowest check populate the critical path renames a vertex as a path', async () => {
  const ungraphed = [observation({
    checks: [
      check({ checkId: 'a', name: 'a', startedAt: at(50 * MINUTE), completedAt: at(48 * MINUTE) }),
      check({ checkId: 'd', name: 'd', startedAt: at(50 * MINUTE), completedAt: at(45 * MINUTE) }),
    ],
    dependencies: null,
  })];
  const shipped = snapshotWith(ciFlow(ungraphed));
  assert.equal(shipped.ciFlow.criticalPath.state, 'UNKNOWN');
  assert.equal(shipped.ciFlow.criticalPath.reasonCode, 'NO_PROVEN_DEPENDENCY_GRAPH');

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr3', (source) => source.replace(
    'const edges = observation.dependencies;', 'const edges = observation.dependencies ?? [];',
  ));
  const renamed = mutant.deriveCiFlowBlock({
    artifact: mutant.sealCiFlow({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations: ungraphed,
    }),
    observedAt: AT,
  });
  assert.equal(renamed.criticalPath.state, 'MEASURED');
  assert.equal(renamed.criticalPath.durationMs, renamed.slowestCheck.durationMs,
    'without the guard, the critical path is just the slowest check wearing a better name');
});

test('MR4: dropping the claimed-identity set lets one observation close two comparisons', async () => {
  const { compareCiFlow, sealCiFlowComparison } = await import('../src/ci-flow-optimization.mjs');
  const baseline = runs(CI_FLOW_MIN_SAMPLE).map((entry, index) => ({
    ...entry, runId: `b${index}`,
  }));
  const candidate = runs(CI_FLOW_MIN_SAMPLE).map((entry, index) => ({
    ...entry,
    runId: `c${index}`,
    completedAt: at(48 * MINUTE),
    checks: [check({ completedAt: at(48 * MINUTE) })],
  }));
  const artifact = ciFlow([...baseline, ...candidate]);
  const identities = (list) => list.map(ciFlowObservationIdentity);
  const pinned = sealCiFlowComparison({
    lever: 'INTRODUCE_CACHING',
    baselineRevision: artifact.revision,
    guard: { maxRegressionMs: 30_000, minImprovementMs: 30_000 },
    observedAt: AT,
    baseline: identities(baseline),
    candidate: identities(candidate),
  });
  const first = compareCiFlow({ comparison: pinned, artifact });
  assert.throws(
    () => compareCiFlow({ comparison: pinned, artifact, claimedIdentities: first.claimedIdentities }),
  );

  const mutant = await importMutant('ci-flow-optimization.mjs', 'ci-flow-mr4',
    (source) => source.replace('if (claimed.has(identity)) {', 'if (false) {'));
  const doubleSpent = mutant.compareCiFlow({
    comparison: pinned, artifact, claimedIdentities: first.claimedIdentities,
  });
  assert.equal(doubleSpent.verdict, first.verdict,
    'without the claim set, the same evidence closes a second comparison');
});

test('MR5: widening the comparable set to admit cancellations is what turns a lever into a false win', async () => {
  const observations = [
    ...runs(CI_FLOW_MIN_SAMPLE),
    ...runs(6, (index) => ({
      runId: `90${index}`,
      conclusion: 'CANCELLED',
      completedAt: at(50 * MINUTE - 20_000),
      checks: [check({ conclusion: 'CANCELLED', completedAt: at(50 * MINUTE - 20_000) })],
    })),
  ];
  const shipped = snapshotWith(ciFlow(observations));
  assert.equal(shipped.ciFlow.percentiles.p50Ms, 5 * MINUTE);

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr5',
    (source) => source.replace("['SUCCESS', 'FAILURE']", "['SUCCESS', 'FAILURE', 'CANCELLED']"));
  const flattering = mutant.deriveCiFlowBlock({
    artifact: mutant.sealCiFlow({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations,
    }),
    observedAt: AT,
  });
  assert.ok(flattering.percentiles.p50Ms < shipped.ciFlow.percentiles.p50Ms,
    'four twenty-second cancellations halve the median once they are admitted');
});

test('MR6: allowing a run-creation basis on a re-run publishes human latency as queue latency', async () => {
  const rerun = [
    observation({ attempt: 1, conclusion: 'FAILURE' }),
    observation({
      attempt: 2, enqueueBasis: 'RUN_CREATION', enqueuedAt: at(2 * 24 * 60 * MINUTE),
    }),
  ];
  const shipped = snapshotWith(ciFlow(rerun));
  assert.equal(shipped.ciFlow.phases.queueLatencyMs.state, 'UNKNOWN');
  assert.equal(shipped.ciFlow.phases.queueLatencyMs.reasonCode,
    'ATTEMPT_QUEUE_BASIS_NOT_EXPOSED');

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr6', (source) => source.replace(
    "if (observation.attempt > 1 && observation.enqueueBasis === 'RUN_CREATION') {",
    'if (false) {',
  ));
  const fabricated = mutant.deriveCiFlowBlock({
    artifact: mutant.sealCiFlow({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations: rerun,
    }),
    observedAt: AT,
  });
  assert.ok(fabricated.phases.queueLatencyMs.value > 24 * 60 * MINUTE,
    'the mutant reports two days of a human not clicking re-run as runner queue latency');
});

test('MR7: dropping the completeness guard publishes a partial read as the current gate', async () => {
  const partial = [observation({ complete: false })];
  const shipped = snapshotWith(ciFlow(partial));
  assert.equal(shipped.ciFlow.gate.state, 'UNKNOWN');
  assert.equal(shipped.ciFlow.gate.reasonCode, 'OBSERVATION_INCOMPLETE');
  assert.equal(shipped.ciFlow.phases.executionMs.state, 'UNKNOWN');

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr7', (source) => source.replace(
    'gateObservation.complete ? null', 'true ? null',
  ));
  const published = mutant.deriveCiFlowBlock({
    artifact: mutant.sealCiFlow({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations: partial,
    }),
    observedAt: AT,
  });
  assert.equal(published.gate.state, 'MEASURED');
  assert.equal(published.phases.executionMs.state, 'MEASURED');
  assert.equal(published.withheldCount, 1,
    'the mutant publishes as the current gate the one observation it withholds as untrustworthy');
});

test('MR8: dropping the span bound lets a critical path outlast the run it lies inside', async () => {
  // Two checks that each occupied the whole run, with an edge between them: the shape a collector
  // produces when it reads edges from one source and timings from another.
  const contradictory = [observation({
    checks: [check({ checkId: 'a', name: 'a' }), check({ checkId: 'b', name: 'b' })],
    dependencies: [['a', 'b']],
  })];
  const shipped = snapshotWith(ciFlow(contradictory));
  assert.equal(shipped.ciFlow.criticalPath.state, 'UNKNOWN');
  assert.equal(shipped.ciFlow.criticalPath.reasonCode, 'CORRUPT');

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr8', (source) => source.replace(
    'if (path.durationMs > spanOf(observation)) {', 'if (false) {',
  ));
  const published = mutant.deriveCiFlowBlock({
    artifact: mutant.sealCiFlow({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations: contradictory,
    }),
    observedAt: AT,
  });
  assert.equal(published.criticalPath.state, 'MEASURED');
  assert.equal(published.criticalPath.durationMs, 2 * published.phases.executionMs.value,
    'the mutant publishes a ten-minute critical path for a five-minute run');
});

test('MR9: reading the setup share against one wall clock is what fires caching on parallel jobs', async () => {
  // Four jobs, each spending a sixth of its own span on setup — below the published quarter.
  const parallel = [observation({
    startedAt: at(50 * MINUTE),
    completedAt: at(49 * MINUTE),
    checks: Array.from({ length: 4 }, (_, index) => check({
      checkId: `p${index}`,
      name: `p${index}`,
      setupMs: 10_000,
      startedAt: at(50 * MINUTE),
      completedAt: at(49 * MINUTE),
    })),
  })];
  const artifact = ciFlow(parallel);
  const { deriveCiFlowCandidates } = await import('../src/ci-flow-optimization.mjs');
  assert.deepEqual(
    deriveCiFlowCandidates({ artifact }).map((entry) => entry.lever).filter(
      (lever) => lever === 'INTRODUCE_CACHING',
    ),
    [],
  );

  const mutant = await importMutant('ci-flow-optimization.mjs', 'ci-flow-mr9',
    (source) => source.replace(
      'const share = (item) => [item.setupMs, spanOf(item)];',
      'const share = () => [setupMs.value, executionMs.value];',
    ));
  const inflated = mutant.deriveCiFlowCandidates({ artifact }).map((entry) => entry.lever);
  assert.ok(inflated.includes('INTRODUCE_CACHING'),
    'summing four numerators against one denominator is what raises the lever falsely');
});

test('MR10: excluding cancelled runs from the bill is what makes cancelling look cheaper', async () => {
  const billed = [
    ...runs(CI_FLOW_MIN_SAMPLE, () => ({ billableMs: 10 * MINUTE })),
    ...runs(6, (index) => ({
      runId: `90${index}`,
      conclusion: 'CANCELLED',
      billableMs: 5 * MINUTE,
      checks: [check({ conclusion: 'CANCELLED' })],
    })),
  ];
  const shipped = snapshotWith(ciFlow(billed));
  assert.equal(shipped.ciFlow.consumedRunner.state, 'MEASURED');
  assert.equal(shipped.ciFlow.consumedRunner.totalMs, 80 * MINUTE);

  const mutant = await importMutant('ci-flow.mjs', 'ci-flow-mr10', (source) => source.replace(
    'function deriveConsumedRunner(observations) {',
    'function deriveConsumedRunner(all) {\n  const observations = all.filter(isComparable);',
  ));
  const flattering = mutant.deriveCiFlowBlock({
    artifact: mutant.sealCiFlow({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 11, observations: billed,
    }),
    observedAt: AT,
  });
  assert.ok(flattering.consumedRunner.totalMs < shipped.ciFlow.consumedRunner.totalMs,
    'thirty minutes the provider really charged vanish from the only cost figure on the card');
  assert.equal(flattering.cancellations.value, shipped.ciFlow.cancellations.value,
    'the cancellations the mutant drops from the bill are still counted beside it');
});
