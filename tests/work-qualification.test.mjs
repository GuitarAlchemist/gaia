import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { qualifyWork, WORK_DIMENSIONS } from '../src/work-qualification.mjs';
import { main } from '../scripts/work-qualification.mjs';

const evidence = () => [{ ref: 'operator:bounded-review', version: 'review-1' }];
function input() {
  return {
    issue: { ref: 'https://github.com/GuitarAlchemist/ix/issues/468', version: 'issue-1' },
    context: { ref: 'repo:GuitarAlchemist/gaia', version: '3be8bff' },
    priority: { actor: 'human', rank: 1, evidence: evidence() },
    proposalKind: 'implementation', decisionMode: 'none', decisionEvidence: evidence(),
    checks: Object.fromEntries(WORK_DIMENSIONS.map((dimension) => [dimension,
      { state: 'supported', reason: 'observed within this proposal scope', evidence: evidence() }])),
  };
}

test('complete supported qualification can propose READY but grants no execution authority', () => {
  const result = qualifyWork(input());
  assert.equal(result.disposition, 'READY');
  assert.deepEqual(result.blockers, []);
  assert.equal(result.dispatchAuthorized, false);
  assert.deepEqual(result.effects, []);
});

test('each unobserved dimension prevents READY, without manufacturing negative observations', () => {
  for (const dimension of WORK_DIMENSIONS) {
    const request = input(); delete request.checks[dimension];
    const result = qualifyWork(request);
    assert.notEqual(result.disposition, 'READY', dimension);
    assert.equal(result.snapshot.checks[dimension].state, 'unknown');
    assert.ok(result.blockers.includes('RECONCILE_REQUIRED'));
  }
});

test('value, coherence, duplicate, scope or permission contradiction rejects this proposal despite priority', () => {
  for (const dimension of ['value', 'coherence', 'duplicates', 'scope', 'permissions']) {
    const request = input(); request.checks[dimension].state = 'contradicted';
    assert.equal(qualifyWork(request).disposition, 'REJECTED_PROPOSAL');
  }
});

test('dependencies, existing ownership and stale observations remain distinct operational barriers', () => {
  const request = input();
  for (const dimension of ['dependencies', 'owner', 'currentness']) request.checks[dimension].state = 'contradicted';
  const result = qualifyWork(request);
  assert.ok(result.blockers.includes('DEPENDENCY'));
  assert.ok(result.blockers.includes('ALREADY_OWNED'));
  assert.ok(result.blockers.includes('RECONCILE_REQUIRED'));
  assert.notEqual(result.disposition, 'READY');
});

test('protected human decision stays DECISION/WAITING_HUMAN even with ten positive dimensions', () => {
  const request = input(); request.proposalKind = 'decision'; request.decisionMode = 'protected-human';
  const result = qualifyWork(request);
  assert.equal(result.disposition, 'DECISION'); assert.ok(result.blockers.includes('WAITING_HUMAN'));
});

test('a delegated reversible technical decision does not acquire an invented human gate', () => {
  const request = input(); request.proposalKind = 'decision'; request.decisionMode = 'delegated-reversible';
  const result = qualifyWork(request);
  assert.equal(result.disposition, 'DECISION'); assert.equal(result.blockers.includes('WAITING_HUMAN'), false);
  assert.equal(result.dispatchAuthorized, false);
});

test('incompatible acceptance or an explicit split proposal produces SPLIT, not an averaged readiness score', () => {
  const request = input(); request.checks.acceptance.state = 'contradicted';
  assert.equal(qualifyWork(request).disposition, 'SPLIT');
  request.proposalKind = 'split'; request.checks.acceptance.state = 'supported';
  assert.equal(qualifyWork(request).disposition, 'SPLIT');
});

test('changed generation or missing human priority requires reconciliation without granting readiness', () => {
  const request = input(); request.expectedVersions = { issue: 'issue-2', context: '3be8bff' };
  assert.ok(qualifyWork(request).blockers.includes('RECONCILE_REQUIRED'));
  delete request.expectedVersions; request.priority = null;
  assert.notEqual(qualifyWork(request).disposition, 'READY');
});

test('frozen snapshot and revision cannot be changed through caller mutation or input key order', () => {
  const request = input(), result = qualifyWork(request);
  request.issue.version = 'mutated'; request.checks.value.evidence[0].version = 'mutated';
  assert.equal(result.snapshot.issue.version, 'issue-1');
  assert.equal(result.snapshot.checks.value.evidence[0].version, 'review-1');
  assert.ok(Object.isFrozen(result.snapshot.checks.value.evidence[0]));
  const same = Object.fromEntries(Object.entries(input()).reverse());
  assert.equal(qualifyWork(same).revision, result.revision);
});

test('invalid observations or unsupported positive claims fail closed without leaking payload text', () => {
  for (const mutate of [r => { r.issue.version = ''; }, r => { r.checks.value.state = 'probably'; },
    r => { r.checks.value.evidence = []; }, r => { r.priority.actor = 'agent'; },
    r => { r.decisionEvidence = []; }]) {
    const request = input(); mutate(request);
    assert.throws(() => qualifyWork(request), /InvalidWorkQualification/);
  }
});

test('public issue snapshots classify468 as RESEARCH and482/484/485 as protected DECISION, never READY', async () => {
  const requests = JSON.parse(await readFile(new URL('./fixtures/work-qualification-issues.json', import.meta.url), 'utf8'));
  assert.deepEqual(requests.map(r => qualifyWork(r).disposition), ['RESEARCH', 'DECISION', 'DECISION', 'DECISION']);
  assert.ok(requests.every(r => qualifyWork(r).dispatchAuthorized === false));
});

test('shadow CLI consumes only bounded local JSON, refuses apply and emits no mutation request', async () => {
  let stdout = '', stderr = '', reads = 0;
  const ports = { stdout: { write: text => { stdout += text; } }, stderr: { write: text => { stderr += text; } },
    read: async () => { reads += 1; return JSON.stringify([input()]); } };
  assert.equal(await main({ ...ports, argv: ['--input', 'snapshot.json'] }), 0);
  assert.equal(JSON.parse(stdout).results[0].dispatchAuthorized, false); assert.equal(reads, 1);
  assert.equal(await main({ ...ports, argv: ['--input', 'snapshot.json', '--apply'] }), 2);
  assert.equal(reads, 1);
  assert.equal(await main({ ...ports, argv: ['--input', 'snapshot.json'], read: async () => 'x'.repeat(262145) }), 3);
  assert.match(stderr, /fail-closed/);
});
