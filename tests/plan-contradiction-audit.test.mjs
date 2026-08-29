import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  auditPlanClaim,
  encodePlanContradictionAudit,
  PlanContradictionError,
  proposeContradictionRepair,
  verifyContradictionRepair,
} from '../src/plan-contradiction-audit.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const deliveredWithOpenWork = () => ({
  artifact: {
    uri: 'repo://ix/docs/plans/example.md',
    algorithm: 'sha256',
    digest: SHA_A,
  },
  subject: 'ix/example-plan',
  lifecycleScope: 'CURRENT',
  registryStatus: 'DECLARED_DELIVERED',
  checkedCount: 9,
  uncheckedCount: 2,
  deferredOpenCount: 1,
  evidenceStatus: 'DECLARATION_UNVERIFIED',
});

const repairInput = (audit) => ({
  contradictionAudit: audit,
  createdAt: '2026-08-29T16:00:00.000Z',
  expiresAt: '2026-08-30T16:00:00.000Z',
  hypotheses: [
    {
      id: 'h0',
      role: 'null',
      statement: 'The delivered declaration is stale.',
      falsifier: 'Immutable implementation evidence proves the remaining item is intentionally open.',
    },
    {
      id: 'h1',
      role: 'alternative',
      statement: 'The checklist is stale.',
      falsifier: 'The declared open item is absent from the delivered implementation evidence.',
    },
  ],
  probe: {
    description: 'Compare the plan claims with immutable implementation and test evidence.',
    positiveControl: 'A known stale completed plan must produce the expected disposition.',
    negativeControl: 'An unrelated archived plan must not change the proposal.',
    requiredEvidenceRefs: [
      { uri: 'git://ix/commit/evidence', algorithm: 'sha256', digest: SHA_B },
    ],
  },
  budget: {
    maxIncrementalPaidUsd: 0,
    maxInputArtifacts: 4,
    maxDurationMs: 60_000,
  },
  proposedDispositions: ['request-new-evidence', 'qualify-scope'],
  downstreamClaimRefs: [],
  uncertainty: {
    class: 'UNKNOWN',
    rationale: 'No discriminating probe has run.',
  },
});

test('detects one non-deferred open item without collapsing either claim', () => {
  const first = auditPlanClaim(deliveredWithOpenWork());
  const second = auditPlanClaim(structuredClone(deliveredWithOpenWork()));

  assert.equal(first.status, 'CONTRADICTION');
  assert.equal(first.ruleId, 'DELIVERED_WITH_NON_DEFERRED_OPEN_CHECKLIST');
  assert.equal(first.input.nonDeferredOpenCount, 1);
  assert.equal(first.contradiction.leftClaim.value, 'DECLARED_DELIVERED');
  assert.equal(first.contradiction.rightClaim.value, 1);
  assert.equal(first.contradiction.status, 'unresolved');
  assert.equal(first.authority.effect, 'NONE');
  assert.equal(first.authority.sourceMutationAuthorized, false);
  assert.equal(first.authority.executionAuthorized, false);
  assert.deepEqual(first.authority.requestedAuthority, []);
  assert.equal(encodePlanContradictionAudit(first), encodePlanContradictionAudit(second));
});

test('does not manufacture a contradiction from explicitly deferred work', () => {
  const input = deliveredWithOpenWork();
  input.uncheckedCount = 1;
  input.deferredOpenCount = 1;

  const audit = auditPlanClaim(input);
  assert.equal(audit.status, 'NO_STRUCTURAL_CONFLICT');
  assert.equal(audit.contradiction, null);
});

test('preserves missing status evidence as UNKNOWN', () => {
  const input = deliveredWithOpenWork();
  input.registryStatus = 'STATUS_UNKNOWN';

  const audit = auditPlanClaim(input);
  assert.equal(audit.status, 'UNKNOWN');
  assert.equal(audit.contradiction, null);
});

test('rejects mutable aliases, invalid counts, and unsupported lifecycle scope', () => {
  for (const mutate of [
    (input) => { input.artifact.digest = 'latest'; },
    (input) => { input.deferredOpenCount = 3; },
    (input) => { input.lifecycleScope = 'LIVE'; },
    (input) => { input.evidenceStatus = 'EVIDENCE_VERIFIED'; },
  ]) {
    const input = deliveredWithOpenWork();
    mutate(input);
    assert.throws(() => auditPlanClaim(input), PlanContradictionError);
  }
});

test('builds a deterministic zero-authority repair proposal with explicit falsifiers', () => {
  const audit = auditPlanClaim(deliveredWithOpenWork());
  const first = proposeContradictionRepair(repairInput(audit));
  const second = proposeContradictionRepair(structuredClone(repairInput(audit)));

  assert.equal(first.status, 'advisory');
  assert.equal(first.contradictionRevision.digest, audit.contradiction.revision.digest);
  assert.equal(first.authority.effect, 'NONE');
  assert.equal(first.authority.sourceMutationAuthorized, false);
  assert.equal(first.authority.executionAuthorized, false);
  assert.deepEqual(first.authority.requestedAuthority, []);
  assert.equal(first.repairId, second.repairId);
  assert.equal(verifyContradictionRepair(first), true);
});

test('rejects weak, paid, unbounded, or authority-widening repairs', () => {
  const audit = auditPlanClaim(deliveredWithOpenWork());
  for (const [mutate, expected] of [
    [(input) => { input.hypotheses.pop(); }, /competing hypotheses/],
    [(input) => { input.probe.negativeControl = ''; }, /negative control/],
    [(input) => { input.budget.maxIncrementalPaidUsd = 1; }, /zero incremental paid cost/],
    [(input) => { input.budget.maxDurationMs = 0; }, /maxDurationMs/],
    [(input) => { input.budget.maxInputArtifacts = 1_025; }, /maxInputArtifacts/],
    [(input) => { input.expiresAt = '2026-09-30T16:00:00.000Z'; }, /seven days/],
    [(input) => { input.authority = { executionAuthorized: true }; }, /authority/],
  ]) {
    const input = repairInput(audit);
    mutate(input);
    assert.throws(() => proposeContradictionRepair(input), expected);
  }
});

test('verification detects materialized proposal tampering', () => {
  const repair = structuredClone(proposeContradictionRepair(
    repairInput(auditPlanClaim(deliveredWithOpenWork())),
  ));
  repair.uncertainty.rationale = 'Old digest, different claim.';
  assert.throws(() => verifyContradictionRepair(repair), /digest/);
});

test('read-only CLI emits the same canonical audit and leaves input bytes unchanged', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-contradiction-audit-'));
  const inputPath = join(root, 'claim.json');
  writeFileSync(inputPath, JSON.stringify(deliveredWithOpenWork()), 'utf8');
  const before = readFileSync(inputPath);

  const stdout = execFileSync(
    process.execPath,
    ['scripts/plan-contradiction-audit.mjs', 'audit', '--input', inputPath],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );

  assert.equal(stdout, `${encodePlanContradictionAudit(auditPlanClaim(deliveredWithOpenWork()))}\n`);
  assert.deepEqual(readFileSync(inputPath), before);
});
