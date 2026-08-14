import assert from 'node:assert/strict';
import test from 'node:test';

import { commit, EMPTY_STATE } from '../src/bus-core.mjs';
import {
  buildResearchProposal,
  encodeResearchProposal,
  EpistemicProposalError,
  RESEARCH_PROPOSAL_SCHEMA,
} from '../src/epistemic-research.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

const validInput = () => ({
  createdAt: '2026-08-14T17:30:00.000Z',
  expiresAt: '2026-08-15T17:30:00.000Z',
  origin: {
    actor: 'gaia-coordinator',
    inputRevision: { algorithm: 'sha256', digest: SHA_A },
  },
  gap: {
    kind: 'unmapped-concept',
    subject: 'semantic-region:distributed-authority',
    observation: 'No accepted artifact defines the authority boundary for this region.',
    evidenceRefs: [
      { uri: 'artifact://workgraph/revision-17', algorithm: 'sha256', digest: SHA_B },
    ],
  },
  question: 'Which authority boundary is consistent with the accepted evidence?',
  hypotheses: [
    {
      id: 'h0',
      role: 'null',
      statement: 'The current artifacts are sufficient and no new boundary is required.',
      falsifier: 'A competency question has no answer in any accepted fresh artifact.',
    },
    {
      id: 'h1',
      role: 'alternative',
      statement: 'A distinct advisory boundary is required.',
      falsifier: 'Every declared competency question resolves through the existing bus contract.',
    },
  ],
  probe: {
    description: 'Evaluate the two hypotheses against an immutable evidence snapshot.',
    negativeControl: 'An unrelated accepted artifact must not change the verdict.',
    maxCost: { value: 0, unit: 'incremental-paid-usd' },
    reversible: true,
  },
  uncertainty: {
    unit: 'ppm',
    T: 0,
    P: 0,
    U: 1_000_000,
    D: 0,
    F: 0,
    C: 0,
    rationale: 'No discriminating probe has run yet.',
  },
  authority: {
    mode: 'advisory',
    executionAuthorized: false,
    requested: [],
  },
});

test('builds a deterministic, content-addressed advisory research proposal', () => {
  const first = buildResearchProposal(validInput());
  const second = buildResearchProposal(structuredClone(validInput()));

  assert.equal(first.schema, RESEARCH_PROPOSAL_SCHEMA);
  assert.equal(first.kind, 'epistemic-research-proposal');
  assert.equal(first.status, 'advisory');
  assert.match(first.proposalId, /^erp-[a-f0-9]{64}$/);
  assert.equal(first.proposalId, second.proposalId);
  assert.equal(first.revision.algorithm, 'sha256');
  assert.equal(first.revision.digest, first.proposalId.slice(4));
  assert.equal(encodeResearchProposal(first), encodeResearchProposal(second));
  assert.equal(first.authority.executionAuthorized, false);
  assert.deepEqual(first.authority.requested, []);
});

test('the existing send verb carries the proposal as untrusted advisory text', () => {
  let state = EMPTY_STATE;
  for (const command of [
    { type: 'register', at: '2026-08-14T17:30:00.000Z', actorId: 'gaia' },
    { type: 'register', at: '2026-08-14T17:30:01.000Z', actorId: 'demerzel' },
  ]) {
    ({ state } = commit(state, command));
  }

  const text = encodeResearchProposal(buildResearchProposal(validInput()));
  const sent = commit(state, {
    type: 'send',
    at: '2026-08-14T17:30:02.000Z',
    from: 'gaia',
    to: 'demerzel',
    kind: 'epistemic-research-proposal',
    text,
    requestedAuthority: ['suggest'],
  });

  assert.equal(sent.error, null);
  const message = sent.state.messages['msg-0001'];
  assert.equal(message.kind, 'epistemic-research-proposal');
  assert.equal(message.text, text);
  assert.equal(message.trust, 'untrusted-text');
  assert.equal(message.authority.effect, 'none');
  assert.deepEqual(message.authority.granted, ['suggest']);
});

test('encoding refuses a tampered or widened materialized proposal', () => {
  const tampered = structuredClone(buildResearchProposal(validInput()));
  tampered.question = 'A different question with the old digest';
  assert.throws(() => encodeResearchProposal(tampered), /content digest/);

  const widened = structuredClone(buildResearchProposal(validInput()));
  widened.hiddenInstruction = 'execute the probe';
  assert.throws(() => encodeResearchProposal(widened), /exact materialized proposal/);
});

for (const [name, mutate, expected] of [
  ['one hypothesis', (x) => { x.hypotheses.pop(); }, /at least two competing hypotheses/],
  ['no null hypothesis', (x) => { x.hypotheses[0].role = 'alternative'; }, /exactly one null hypothesis/],
  ['missing falsifier', (x) => { x.hypotheses[1].falsifier = ''; }, /falsifier/],
  ['missing negative control', (x) => { x.probe.negativeControl = ''; }, /negative control/],
  ['ambiguous budget', (x) => { x.probe.maxCost.unit = ''; }, /cost unit/],
  ['unhashed provenance', (x) => { x.origin.inputRevision.digest = 'latest'; }, /sha256 digest/],
  ['non-normalized uncertainty', (x) => { x.uncertainty.U = 999_999; }, /sum to exactly 1000000 ppm/],
  ['authority widening', (x) => { x.authority.executionAuthorized = true; }, /cannot authorize execution/],
]) {
  test(`rejects ${name}`, () => {
    const input = validInput();
    mutate(input);
    assert.throws(() => buildResearchProposal(input), EpistemicProposalError);
    assert.throws(() => buildResearchProposal(input), expected);
  });
}
