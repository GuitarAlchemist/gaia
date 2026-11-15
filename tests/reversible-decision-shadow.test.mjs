import assert from 'node:assert/strict';
import test from 'node:test';
import { qualifyWork } from '../src/work-qualification.mjs';
import { proposeReversibleDecision, verifyReversibleDecision } from '../src/reversible-decision-shadow.mjs';
import { main } from '../scripts/work-qualification.mjs';

function request() {
  const ref = { ref: 'operator:bounded-research', version: 'mandate-1' };
  return {
    qualification: qualifyWork({ issue: { ref: 'https://github.com/GuitarAlchemist/ix/issues/482', version: 'snapshot-1' },
      context: { ref: 'repo:GuitarAlchemist/gaia', version: '3be8bff' }, priority: null,
      proposalKind: 'decision', decisionMode: 'protected-human', decisionEvidence: [ref], checks: {} }),
    policy: { ref: ref.ref, version: ref.version, status: 'delegated-reversible', purpose: 'independent-research',
      repository: 'GuitarAlchemist/gaia', owner: { id: 'shadow-owner', version: 'claim-1' },
      allowedKinds: ['local-test'], allowedPaths: ['prototypes/lease-shadow/'],
      maxIterations: 2, maxAttempts: 1, modelCalls: 0, externalEffects: 0 },
    owner: { id: 'shadow-owner', version: 'claim-1', status: 'confirmed' }, iteration: 0, attempt: 0,
    candidates: [
      { id: 'two-files', kind: 'local-test', ownerId: 'shadow-owner', scope: ['prototypes/lease-shadow/a.mjs', 'prototypes/lease-shadow/b.mjs'],
        parameters: { clock: 'fake', leaseMs: 30000 }, reason: 'compare two isolated boundaries',
        uncertainty: 'hypothesis only', test: 'expiry emits one terminal record', rollback: 'remove isolated fixture' },
      { id: 'one-file', kind: 'local-test', ownerId: 'shadow-owner', scope: ['prototypes/lease-shadow/probe.mjs'],
        parameters: { clock: 'fake', leaseMs: 30000 }, reason: 'smaller falsifiable boundary',
        uncertainty: 'no live provider evidence', test: 'no renewal expires once', rollback: 'remove isolated fixture' },
    ],
  };
}

test('bounded selector binds immutable evidence, policy, action and alternatives without effects', () => {
  const input = request(), receipt = proposeReversibleDecision(input);
  assert.equal(receipt.selected.id, 'one-file'); assert.equal(receipt.outcome, 'NOT_EXECUTED');
  assert.equal(receipt.dispatchAuthorized, false); assert.equal(receipt.alternatives.length, 2);
  assert.equal(receipt.selected.parameters.leaseMs, 30000); assert.match(receipt.digest, /^[a-f0-9]{64}$/);
  input.candidates[1].parameters.leaseMs = 1;
  assert.equal(receipt.selected.parameters.leaseMs, 30000); assert.ok(Object.isFrozen(receipt.selected.parameters));
});

test('a decision policy must match the qualification context repository, not the researched issue repository', () => {
  const mismatch = request(); mismatch.policy.repository = 'OtherOrganization/other-repository';
  assert.throws(() => proposeReversibleDecision(mismatch), /REPOSITORY_MISMATCH/);
  for (const ref of ['repo:OtherOrganization/other-repository', 'unknown-context',
    'https://github.com/GuitarAlchemist/gaia', 'repo:GuitarAlchemist/gaia/extra']) {
    const input = request(), snapshot = structuredClone(input.qualification.snapshot);
    snapshot.context.ref = ref;
    input.qualification = qualifyWork({ ...snapshot, expectedVersions: undefined });
    assert.throws(() => proposeReversibleDecision(input), /REPOSITORY_MISMATCH/, ref);
  }
  const matched = request(); matched.policy.repository = 'guitaralchemist/GAIA';
  const receipt = proposeReversibleDecision(matched);
  assert.equal(receipt.policy.repository, 'guitaralchemist/GAIA');
  assert.equal(receipt.qualification.snapshot.issue.ref, 'https://github.com/GuitarAlchemist/ix/issues/482');
  assert.equal(receipt.dispatchAuthorized, false);
});

test('a stale evidence or policy generation invalidates the receipt', () => {
  const input = request(), receipt = proposeReversibleDecision(input);
  input.policy.version = 'mandate-2';
  assert.throws(() => verifyReversibleDecision(receipt, input), /STALE_RECEIPT/);
  const changed = request(), snapshot = structuredClone(changed.qualification.snapshot);
  snapshot.context.version = 'new-context';
  changed.qualification = qualifyWork({ ...snapshot, expectedVersions: undefined });
  assert.throws(() => verifyReversibleDecision(receipt, changed), /STALE_RECEIPT/);
});

test('scope expansion and Windows path escape cannot enter the selected action', () => {
  for (const path of ['src/authority.mjs', '../outside.mjs', 'C:/outside.mjs', 'prototypes/lease-shadow/../escape.mjs']) {
    const input = request(); input.candidates[1].scope = [path];
    assert.throws(() => proposeReversibleDecision(input), /SCOPE/);
  }
});

test('protected human decision stays unresolved while independent research can be proposed', () => {
  const input = request(), receipt = proposeReversibleDecision(input);
  assert.ok(receipt.preservedBarriers.includes('WAITING_HUMAN'));
  assert.equal(receipt.humanDecisionUnresolved, true);
  input.policy.purpose = 'accept-human-decision';
  assert.throws(() => proposeReversibleDecision(input), /POLICY/);
});

test('unknown or protected grants and nonzero external spend are refused', () => {
  for (const mutate of [r => { r.policy.status = 'unknown'; }, r => { r.policy.allowedKinds.push('scm-install'); },
    r => { r.policy.modelCalls = 1; }, r => { r.policy.grant = 'admin'; },
    r => { r.policy.repository = ['GuitarAlchemist/gaia']; }]) {
    const input = request(); mutate(input); assert.throws(() => proposeReversibleDecision(input), /POLICY/);
  }
});

test('changed candidate parameters or altered receipt cannot validate against the original decision', () => {
  const input = request(), receipt = proposeReversibleDecision(input);
  input.candidates[1].parameters.leaseMs = 40000;
  assert.throws(() => verifyReversibleDecision(receipt, input), /STALE_RECEIPT/);
  const changed = structuredClone(receipt); changed.selected.parameters.leaseMs = 40000;
  assert.throws(() => verifyReversibleDecision(changed, request()), /STALE_RECEIPT/);
  const arrays = request(); arrays.candidates.forEach(c => { c.id = ['duplicate-id']; });
  assert.throws(() => proposeReversibleDecision(arrays), /INVALID_CANDIDATE/);
});

test('signed zero in scalar, nested or array action parameters is refused instead of sharing the zero digest', async () => {
  for (const parameters of [{ offset: -0 }, { nested: { offset: -0 } }, { offsets: [-0] }]) {
    const input = request(); input.candidates[1].parameters = parameters;
    assert.throws(() => proposeReversibleDecision(input), /INVALID_PARAMETERS/);
  }
  const zero = request(); zero.candidates[1].parameters = { offset: 0 };
  assert.equal(proposeReversibleDecision(zero).selected.parameters.offset, 0);
  const raw = JSON.stringify([zero]).replace('"offset":0', '"offset":-0');
  assert.ok(raw.includes('"offset":-0'));
  assert.equal(await main({ argv: ['--decisions', 'local.json'], read: async () => raw,
    stdout: { write: () => {} }, stderr: { write: () => {} } }), 3);
});

test('signed zero cannot enter iteration, attempt or zero-effect policy counters', () => {
  for (const mutate of [r => { r.iteration = -0; }, r => { r.attempt = -0; },
    r => { r.policy.modelCalls = -0; }, r => { r.policy.externalEffects = -0; }]) {
    const input = request(); mutate(input);
    assert.throws(() => proposeReversibleDecision(input), /BOUNDS|POLICY/);
  }
  const zero = request(); zero.iteration = 0; zero.attempt = 0;
  assert.equal(proposeReversibleDecision(zero).outcome, 'NOT_EXECUTED');
});

test('verification rejects signed-zero receipt tampering even when canonical JSON and digest are unchanged', () => {
  const input = request(); input.candidates[1].parameters = { offset: 0, offsets: [0] };
  const snapshot = structuredClone(input.qualification.snapshot);
  snapshot.priority = { actor: 'human', rank: 0, evidence: [{ ref: 'operator:bounded-research', version: 'mandate-1' }] };
  input.qualification = qualifyWork({ ...snapshot, expectedVersions: undefined });
  const receipt = proposeReversibleDecision(input), accepted = [];
  for (const [name, mutate] of [
    ['scalar', r => { r.selected.parameters.offset = -0; }],
    ['array', r => { r.selected.parameters.offsets[0] = -0; }],
    ['iteration', r => { r.iteration = -0; }],
    ['policy', r => { r.policy.modelCalls = -0; }],
    ['priority', r => { r.qualification.snapshot.priority.rank = -0; }],
  ]) {
    const changed = structuredClone(receipt); mutate(changed);
    assert.equal(changed.digest, receipt.digest);
    try { verifyReversibleDecision(changed, input); accepted.push(name); }
    catch (error) { assert.match(error.message, /STALE_RECEIPT/); }
  }
  assert.deepEqual(accepted, []);
  assert.equal(verifyReversibleDecision(JSON.parse(JSON.stringify(receipt)), input).state, 'MATCHES_CURRENT_SHADOW');
});

test('conflicting owner and exhausted attempt/iteration bounds refuse without another action', () => {
  for (const mutate of [r => { r.owner.id = 'other'; }, r => { r.owner.status = 'conflicting'; },
    r => { r.candidates[0].ownerId = 'other'; }, r => { r.attempt = 1; }, r => { r.iteration = 2; }]) {
    const input = request(); mutate(input); assert.throws(() => proposeReversibleDecision(input), /OWNER|BOUNDS/);
  }
});

test('same inputs verify; the existing shadow CLI emits the same receipt with no effects', async () => {
  const input = request(), receipt = proposeReversibleDecision(input);
  assert.equal(verifyReversibleDecision(receipt, input).dispatchAuthorized, false);
  assert.equal(proposeReversibleDecision(Object.fromEntries(Object.entries(input).reverse())).digest, receipt.digest);
  let output = '';
  assert.equal(await main({ argv: ['--decisions', 'local.json'], read: async () => JSON.stringify([input]),
    stdout: { write: value => { output += value; } }, stderr: { write: () => {} } }), 0);
  assert.equal(JSON.parse(output).results[0].digest, receipt.digest);
});
