/**
 * first-evidence-draft-pr.test.mjs — the closed `gaia-first-evidence-draft-pr/1` contract.
 *
 * RED gates for `docs/first-evidence-draft-pr.md`. The operator failure behind all of them is a
 * control room that can say a lane is alive and cannot say whether the repository moved, so most
 * of what is asserted here is what the model REFUSES to read as repository movement.
 *
 * The four absence states are the spine: `EXPECTED_NONE`, `AWAITING_FIRST_COMMIT`,
 * `MISSING_DRAFT`, `DRAFT_OPEN`. Only `MISSING_DRAFT` may reach an effect, and even then only
 * when exactly one identity-bound reading is possible.
 *
 * The evidence record carries a measured `commitsAheadOfBase`, not a change-set digest. That is
 * deliberate and is the load-bearing difference from the existing publication path, where the
 * candidate is an uncommitted working-tree diff and `candidate.headOid` is the base commit. A
 * Draft PR bound to that value would be bound to a commit that predates the run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DRAFT_PR_PRESENCE_STATES,
  DRAFT_PR_TERMINAL_OUTCOMES,
  DRAFT_PR_TRANSITIONS,
  FIRST_EVIDENCE_DRAFT_FIELDS,
  FIRST_EVIDENCE_DRAFT_PR_SCHEMA,
  FIRST_EVIDENCE_EVIDENCE_FIELDS,
  FIRST_EVIDENCE_IDENTITY_FIELDS,
  FIRST_EVIDENCE_OBSERVATION_FIELDS,
  FIRST_EVIDENCE_OBSERVATION_SCHEMA,
  FIRST_EVIDENCE_RUN_FIELDS,
  FIRST_EVIDENCE_TASK_FIELDS,
  FirstEvidenceDraftPrError,
  deriveDraftVisibilityBlock,
  firstEvidenceOperationIdentity,
  planFirstEvidenceDraftPr,
  requireFirstEvidenceObservation,
} from '../src/first-evidence-draft-pr.mjs';
import { BUS_VERBS } from '../src/bus-core.mjs';

const OBSERVED = '2026-08-30T19:12:00.000Z';
const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const OTHER_OID = 'c'.repeat(40);
const SOURCE_REVISION = 'd'.repeat(64);

const at = (msBeforeObserved) => new Date(Date.parse(OBSERVED) - msBeforeObserved).toISOString();

const IDENTITY = {
  repository: 'GuitarAlchemist/gaia',
  task: { kind: 'ISSUE', number: 35 },
  baseBranch: 'main',
  headBranch: 'codex/draft-pr-on-first-evidence-r0',
  headBranchGeneration: 1,
  evidenceHeadOid: HEAD_OID,
};

const draft = (overrides = {}) => ({
  number: 37,
  url: 'https://github.com/GuitarAlchemist/gaia/pull/37',
  headOid: HEAD_OID,
  baseBranch: 'main',
  isDraft: true,
  state: 'OPEN',
  operationIdentity: firstEvidenceOperationIdentity(IDENTITY),
  ...overrides,
});

const observation = (overrides = {}) => ({
  schema: FIRST_EVIDENCE_OBSERVATION_SCHEMA,
  observedAt: OBSERVED,
  repository: 'GuitarAlchemist/gaia',
  task: { kind: 'ISSUE', number: 35 },
  baseBranch: 'main',
  baseOid: BASE_OID,
  headBranch: 'codex/draft-pr-on-first-evidence-r0',
  headBranchGeneration: 1,
  run: { runId: 'run-7', laneGeneration: 3 },
  sourceRevision: SOURCE_REVISION,
  claim: 'CLAIMED',
  evidence: {
    headOid: HEAD_OID,
    baseOid: BASE_OID,
    committedAt: at(60_000),
    durability: 'COMMITTED',
    commitsAheadOfBase: 1,
  },
  drafts: [],
  ...overrides,
});

const refusalCode = (fn) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof FirstEvidenceDraftPrError, `expected a typed refusal, got ${error}`);
    return error.code;
  }
  return assert.fail('expected a refusal');
};

/* ---------------------------------------------------------------------------------------------
 * D1-D4 — the closed vocabularies
 * ------------------------------------------------------------------------------------------ */

test('D1: the four absence states are exactly the decided vocabulary, in order', () => {
  assert.deepEqual([...DRAFT_PR_PRESENCE_STATES], [
    'EXPECTED_NONE', 'AWAITING_FIRST_COMMIT', 'MISSING_DRAFT', 'DRAFT_OPEN',
  ]);
  assert.ok(Object.isFrozen(DRAFT_PR_PRESENCE_STATES));
});

test('D2: the terminal outcomes are exactly CREATED, REUSED and REFUSED', () => {
  assert.deepEqual([...DRAFT_PR_TERMINAL_OUTCOMES], ['CREATED', 'REUSED', 'REFUSED']);
  assert.deepEqual([...DRAFT_PR_TRANSITIONS], ['INTENT', 'CREATED', 'REUSED', 'REFUSED']);
  assert.ok(Object.isFrozen(DRAFT_PR_TERMINAL_OUTCOMES));
  assert.ok(Object.isFrozen(DRAFT_PR_TRANSITIONS));
});

test('D3: this feature introduces no bus verb', () => {
  assert.deepEqual([...BUS_VERBS], [
    'register', 'send', 'inbox', 'ack', 'heartbeat', 'handoff',
  ]);
});

test('D4: the observation field list is closed and frozen', () => {
  for (const list of [
    FIRST_EVIDENCE_OBSERVATION_FIELDS, FIRST_EVIDENCE_TASK_FIELDS, FIRST_EVIDENCE_RUN_FIELDS,
    FIRST_EVIDENCE_EVIDENCE_FIELDS, FIRST_EVIDENCE_DRAFT_FIELDS, FIRST_EVIDENCE_IDENTITY_FIELDS,
  ]) {
    assert.ok(Object.isFrozen(list));
    assert.deepEqual([...list], [...new Set(list)], 'field lists carry no duplicate');
  }
  assert.deepEqual(
    [...FIRST_EVIDENCE_OBSERVATION_FIELDS].sort(),
    Object.keys(observation()).sort(),
  );
  assert.deepEqual(
    [...FIRST_EVIDENCE_EVIDENCE_FIELDS].sort(),
    Object.keys(observation().evidence).sort(),
  );
  assert.deepEqual([...FIRST_EVIDENCE_DRAFT_FIELDS].sort(), Object.keys(draft()).sort());
});

/* ---------------------------------------------------------------------------------------------
 * D5-D9 — operation identity
 * ------------------------------------------------------------------------------------------ */

test('D5: operation identity binds exactly repository, task, branches, generation and evidence', () => {
  assert.deepEqual([...FIRST_EVIDENCE_IDENTITY_FIELDS], [
    'repository', 'task', 'baseBranch', 'headBranch', 'headBranchGeneration', 'evidenceHeadOid',
  ]);
  assert.match(firstEvidenceOperationIdentity(IDENTITY), /^[a-f0-9]{64}$/u);
});

test('D6: the run, the lane generation, the clock and the source revision are not identity', () => {
  const identityOf = (over) => planFirstEvidenceDraftPr({
    observation: observation(over),
  }).operationIdentity;
  const original = identityOf({});
  assert.equal(identityOf({ run: { runId: 'run-999', laneGeneration: 41 } }), original);
  assert.equal(identityOf({ sourceRevision: 'e'.repeat(64) }), original);
  assert.equal(identityOf({ observedAt: at(-5_000) }), original);
  assert.equal(identityOf({
    evidence: { ...observation().evidence, committedAt: at(120_000) },
  }), original);
});

test('D7: GitHub repository identity is case-insensitive, so operation identity is too', () => {
  assert.equal(
    firstEvidenceOperationIdentity({ ...IDENTITY, repository: 'guitaralchemist/gaia' }),
    firstEvidenceOperationIdentity({ ...IDENTITY, repository: 'GuitarAlchemist/Gaia' }),
  );
});

test('D8: every identity field is load-bearing', () => {
  const variants = [
    { ...IDENTITY, repository: 'GuitarAlchemist/other' },
    { ...IDENTITY, task: { kind: 'ISSUE', number: 36 } },
    { ...IDENTITY, baseBranch: 'release' },
    { ...IDENTITY, headBranch: 'other-topic' },
    { ...IDENTITY, headBranchGeneration: 2 },
    { ...IDENTITY, evidenceHeadOid: OTHER_OID },
  ];
  const seen = new Set([firstEvidenceOperationIdentity(IDENTITY)]);
  for (const variant of variants) seen.add(firstEvidenceOperationIdentity(variant));
  assert.equal(seen.size, variants.length + 1);
});

test('D9: identity refuses a malformed binding rather than hashing it', () => {
  for (const override of [
    { repository: 'not-a-repository' },
    { evidenceHeadOid: 'zz' },
    { headBranchGeneration: 0 },
    { headBranchGeneration: 1.5 },
    { task: { kind: 'DISCUSSION', number: 35 } },
    { headBranch: '../escape' },
    { extra: 'field' },
  ]) {
    assert.equal(
      refusalCode(() => firstEvidenceOperationIdentity({ ...IDENTITY, ...override })),
      'InvalidIdentity',
      `${JSON.stringify(override)} must not produce an identity`,
    );
  }
});

/* ---------------------------------------------------------------------------------------------
 * D10-D14 — the signals that must never create a pull request
 * ------------------------------------------------------------------------------------------ */

test('D10: an unclaimed item with no commit is EXPECTED_NONE and does nothing', () => {
  const plan = planFirstEvidenceDraftPr({
    observation: observation({ claim: 'UNCLAIMED', evidence: null }),
  });
  assert.equal(plan.state, 'EXPECTED_NONE');
  assert.equal(plan.action, 'NONE');
  assert.equal(plan.refusal, null);
});

test('D11: a claimed item with no commit is AWAITING_FIRST_COMMIT and does nothing', () => {
  const plan = planFirstEvidenceDraftPr({ observation: observation({ evidence: null }) });
  assert.equal(plan.state, 'AWAITING_FIRST_COMMIT');
  assert.equal(plan.action, 'NONE');
});

test('D12: an empty branch still standing at its base is AWAITING_FIRST_COMMIT', () => {
  const plan = planFirstEvidenceDraftPr({
    observation: observation({
      evidence: {
        headOid: BASE_OID,
        baseOid: BASE_OID,
        committedAt: at(60_000),
        durability: 'COMMITTED',
        commitsAheadOfBase: 0,
      },
    }),
  });
  assert.equal(plan.state, 'AWAITING_FIRST_COMMIT');
  assert.equal(plan.action, 'NONE');
});

test('D13: a wrapper start, a heartbeat, a live process and a prompt are unsayable here', () => {
  for (const field of [
    'heartbeatAt', 'pid', 'alive', 'liveness', 'prompt', 'promptAcceptedAt', 'wrapperStartedAt',
    'stdoutBytes', 'reasoning', 'command', 'worktreePath', 'token', 'accountId', 'sourceTitle',
    'changeSetIdentity', 'output', 'findings',
  ]) {
    assert.equal(
      refusalCode(() => requireFirstEvidenceObservation(observation({ [field]: 'x' }))),
      'InvalidObservation',
      `${field} must not be expressible as evidence`,
    );
  }
});

test('D14: an uncommitted change carries no durability that qualifies', () => {
  for (const durability of ['DIRTY', 'STAGED', 'PENDING', 'UNCOMMITTED', 'CANDIDATE_READY', '']) {
    assert.equal(refusalCode(() => requireFirstEvidenceObservation(observation({
      evidence: { ...observation().evidence, durability },
    }))), 'InvalidObservation', `${durability} must not qualify as durable evidence`);
  }
});

/* ---------------------------------------------------------------------------------------------
 * D15-D19 — stale, future and corrupt evidence fail closed
 * ------------------------------------------------------------------------------------------ */

test('D15: evidence committed after the observation instant fails closed', () => {
  assert.equal(refusalCode(() => planFirstEvidenceDraftPr({
    observation: observation({
      evidence: { ...observation().evidence, committedAt: at(-1_000) },
    }),
  })), 'EvidenceFromFuture');
});

test('D16: evidence measured against a different base fails closed', () => {
  assert.equal(refusalCode(() => planFirstEvidenceDraftPr({
    observation: observation({
      evidence: { ...observation().evidence, baseOid: OTHER_OID },
    }),
  })), 'EvidenceBaseChanged');
});

test('D17: evidence without a claim is a contradiction, not a healthy idle state', () => {
  assert.equal(refusalCode(() => planFirstEvidenceDraftPr({
    observation: observation({ claim: 'UNCLAIMED' }),
  })), 'EvidenceUnclaimed');
});

test('D18: a commit count that disagrees with the measured oids fails closed', () => {
  assert.equal(refusalCode(() => planFirstEvidenceDraftPr({
    observation: observation({
      evidence: { ...observation().evidence, commitsAheadOfBase: 0 },
    }),
  })), 'EvidenceIncoherent');
  assert.equal(refusalCode(() => planFirstEvidenceDraftPr({
    observation: observation({
      evidence: {
        ...observation().evidence, headOid: BASE_OID, commitsAheadOfBase: 2,
      },
    }),
  })), 'EvidenceIncoherent');
});

test('D19: corrupt, truncated or prototype-poisoned observations are refused', () => {
  for (const evidence of [
    { ...observation().evidence, headOid: 'nope' },
    { ...observation().evidence, committedAt: '2026-08-30' },
    { ...observation().evidence, commitsAheadOfBase: -1 },
    { ...observation().evidence, commitsAheadOfBase: 1.5 },
    { headOid: HEAD_OID, baseOid: BASE_OID, committedAt: at(1), durability: 'COMMITTED' },
    'COMMITTED',
    [],
  ]) {
    assert.equal(
      refusalCode(() => requireFirstEvidenceObservation(observation({ evidence }))),
      'InvalidObservation',
    );
  }
  assert.equal(refusalCode(() => requireFirstEvidenceObservation(
    JSON.parse('{"schema":"gaia-first-evidence-draft-pr-observation/1","__proto__":{"x":1}}'),
  )), 'InvalidObservation');
  assert.equal(refusalCode(() => requireFirstEvidenceObservation(null)), 'InvalidObservation');
  assert.equal(refusalCode(() => requireFirstEvidenceObservation({})), 'InvalidObservation');
});

/* ---------------------------------------------------------------------------------------------
 * D20-D25 — MISSING_DRAFT, DRAFT_OPEN, and the refusals between them
 * ------------------------------------------------------------------------------------------ */

test('D20: MISSING_DRAFT is the one and only state that triggers create-or-reuse', () => {
  const plan = planFirstEvidenceDraftPr({ observation: observation() });
  assert.equal(plan.state, 'MISSING_DRAFT');
  assert.equal(plan.action, 'CREATE_OR_REUSE');
  assert.equal(plan.refusal, null);
  assert.match(plan.operationIdentity, /^[a-f0-9]{64}$/u);

  const byState = {
    EXPECTED_NONE: observation({ claim: 'UNCLAIMED', evidence: null }),
    AWAITING_FIRST_COMMIT: observation({ evidence: null }),
    MISSING_DRAFT: observation(),
    DRAFT_OPEN: observation({ drafts: [draft()] }),
  };
  const triggering = DRAFT_PR_PRESENCE_STATES.filter(
    (state) => planFirstEvidenceDraftPr({ observation: byState[state] }).action === 'CREATE_OR_REUSE',
  );
  assert.deepEqual(triggering, ['MISSING_DRAFT']);
});

test('D21: exactly one identity-bound open draft is DRAFT_OPEN and does nothing', () => {
  const plan = planFirstEvidenceDraftPr({ observation: observation({ drafts: [draft()] }) });
  assert.equal(plan.state, 'DRAFT_OPEN');
  assert.equal(plan.action, 'NONE');
  assert.equal(plan.pullRequest.number, 37);
});

test('D22: two matching drafts are a refusal, never DRAFT_OPEN', () => {
  const plan = planFirstEvidenceDraftPr({
    observation: observation({ drafts: [draft(), draft({ number: 38 })] }),
  });
  assert.equal(plan.state, 'MISSING_DRAFT');
  assert.equal(plan.action, 'REFUSE');
  assert.equal(plan.refusal, 'DraftAmbiguous');
  assert.equal(plan.pullRequest, null);
});

test('D23: a reused branch carrying a foreign operation identity refuses', () => {
  const plan = planFirstEvidenceDraftPr({
    observation: observation({ drafts: [draft({ operationIdentity: 'f'.repeat(64) })] }),
  });
  assert.equal(plan.action, 'REFUSE');
  assert.equal(plan.refusal, 'DraftIdentityConflict');
});

test('D24: a draft already promoted to ready, closed or merged is never silently recreated', () => {
  assert.equal(planFirstEvidenceDraftPr({
    observation: observation({ drafts: [draft({ isDraft: false })] }),
  }).refusal, 'DraftPromoted');
  for (const state of ['CLOSED', 'MERGED']) {
    assert.equal(planFirstEvidenceDraftPr({
      observation: observation({ drafts: [draft({ state })] }),
    }).refusal, 'DraftClosed');
  }
});

test('D25: a draft bound to a different base or head than the evidence refuses', () => {
  assert.equal(planFirstEvidenceDraftPr({
    observation: observation({ drafts: [draft({ baseBranch: 'release' })] }),
  }).refusal, 'DraftIdentityConflict');
  assert.equal(planFirstEvidenceDraftPr({
    observation: observation({ drafts: [draft({ headOid: OTHER_OID })] }),
  }).refusal, 'DraftIdentityConflict');
});

/* ---------------------------------------------------------------------------------------------
 * D26-D28 — determinism and authority
 * ------------------------------------------------------------------------------------------ */

test('D26: the plan is deterministic, deeply frozen, and holds no effect or authority', () => {
  const first = planFirstEvidenceDraftPr({ observation: observation() });
  const second = planFirstEvidenceDraftPr({ observation: observation() });
  assert.deepEqual(first, second);
  assert.equal(first.schema, FIRST_EVIDENCE_DRAFT_PR_SCHEMA);
  assert.equal(first.effect, 'NONE');
  assert.equal(first.authority, 'NONE');
  assert.ok(Object.isFrozen(first));
  assert.throws(() => { first.action = 'REFUSE'; }, TypeError);
});

test('D27: a plan grants no approval, merge, deploy, retry or credential authority', () => {
  const serialized = JSON.stringify(planFirstEvidenceDraftPr({
    observation: observation({ drafts: [draft()] }),
  })).toLowerCase();
  for (const word of ['approve', 'merge', 'deploy', 'ready', 'retry', 'credential']) {
    assert.ok(!serialized.includes(`"${word}`), `${word} must not appear as a plan capability`);
  }
});

test('D28: planning refuses an observation whose repository is not owner/name', () => {
  assert.equal(refusalCode(() => planFirstEvidenceDraftPr({
    observation: observation({ repository: 'https://github.com/o/n' }),
  })), 'InvalidObservation');
});

/* ---------------------------------------------------------------------------------------------
 * D29-D32 — the control-room block, separate from liveness and closed against leakage
 * ------------------------------------------------------------------------------------------ */

test('D29: the visibility block reports draft age, commit age, CI, review gate and obstruction', () => {
  const block = deriveDraftVisibilityBlock({
    observation: observation({ drafts: [draft()] }),
    observedAt: OBSERVED,
    pullRequest: {
      number: 37,
      url: 'https://github.com/GuitarAlchemist/gaia/pull/37',
      openedAt: at(3_600_000),
      ciState: 'PENDING',
      reviewGate: 'NOT_REQUESTED',
    },
  });
  assert.equal(block.state, 'DRAFT_OPEN');
  assert.equal(block.draftAgeMs, 3_600_000);
  assert.equal(block.lastCommitAgeMs, 60_000);
  assert.equal(block.ciState, 'PENDING');
  assert.equal(block.reviewGate, 'NOT_REQUESTED');
  assert.equal(block.obstruction, null);
});

test('D30: the block says in its own vocabulary that it does not measure local liveness', () => {
  const block = deriveDraftVisibilityBlock({
    observation: observation(), observedAt: OBSERVED, pullRequest: null,
  });
  assert.equal(block.liveness, 'NOT_MEASURED_HERE');
  assert.equal(block.state, 'MISSING_DRAFT');
  assert.equal(block.draftAgeMs, null);
  assert.equal(block.lastCommitAgeMs, 60_000);
  assert.equal(block.obstruction, 'MISSING_DRAFT');
  assert.equal(block.ciState, 'UNKNOWN');
  assert.equal(block.reviewGate, 'UNKNOWN');
});

test('D31: every absence state carries its own age, so the operator has a denominator', () => {
  const byState = {
    EXPECTED_NONE: observation({ claim: 'UNCLAIMED', evidence: null }),
    AWAITING_FIRST_COMMIT: observation({ evidence: null }),
    MISSING_DRAFT: observation(),
    DRAFT_OPEN: observation({ drafts: [draft()] }),
  };
  for (const [state, candidate] of Object.entries(byState)) {
    const block = deriveDraftVisibilityBlock({
      observation: candidate, observedAt: OBSERVED, pullRequest: null,
    });
    assert.equal(block.state, state);
    assert.ok(Object.hasOwn(block, 'lastCommitAgeMs'));
    assert.ok(Object.hasOwn(block, 'draftAgeMs'));
    assert.equal(block.effect, 'NONE');
    assert.equal(block.authority, 'NONE');
    assert.match(block.revision, /^[a-f0-9]{64}$/u);
  }
});

test('D32: the block exposes no prompt, reasoning, command, path, credential or provider prose', () => {
  const block = deriveDraftVisibilityBlock({
    observation: observation({ drafts: [draft()] }),
    observedAt: OBSERVED,
    pullRequest: {
      number: 37,
      url: 'https://github.com/GuitarAlchemist/gaia/pull/37',
      openedAt: at(3_600_000),
      ciState: 'PASSING',
      reviewGate: 'APPROVED',
    },
  });
  const strings = [];
  const walk = (value, where) => {
    if (typeof value === 'string') {
      strings.push([where, value]);
      return;
    }
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        assert.ok(
          !/prompt|reason|command|argv|stdout|stderr|token|secret|credential|account|cwd|path|home|prose|title|body/iu
            .test(key),
          `block key ${where}.${key} names a forbidden category`,
        );
        walk(child, `${where}.${key}`);
      }
    }
  };
  walk(block, 'block');
  for (const [where, value] of strings) {
    assert.ok(!value.includes('\\'), `${where} carries a filesystem separator`);
    assert.ok(!/^[A-Za-z]:[/\\]/u.test(value), `${where} carries a drive-rooted path`);
    assert.ok(!value.startsWith('/'), `${where} carries an absolute path`);
    if (value.startsWith('http')) {
      assert.match(value, /^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/\d+$/u, where);
    }
  }
  assert.ok(Object.isFrozen(block));
});
