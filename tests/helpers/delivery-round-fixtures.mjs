/**
 * The smallest valid delivery-round inputs (`src/pr-delivery-round-history.mjs`): an R0 opened with
 * a chosen round budget, and the R1 advance receipt that tries to follow it. The field values
 * mirror the fixtures of tests/pr-delivery-round-history.test.mjs.
 */

import { createHash } from 'node:crypto';

export const WORK_KEY = 'a'.repeat(64);
export const HEAD = '1'.repeat(40);

const SUPERVISOR = `gaia:operation:${'5'.repeat(64)}`;
const EXECUTION = `gaia:lane:${'6'.repeat(64)}:${HEAD}`;
const ACCOUNTABLE = 'github:user:gaia-operator';

const digest = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function evidence(overrides = {}) {
  return {
    designCommit: '2'.repeat(40),
    redCommit: '3'.repeat(40),
    greenCommit: 'UNKNOWN(NOT_REACHED)',
    testEvidenceReceipt: 'UNKNOWN(NOT_REACHED)',
    reviewVerdicts: ['UNKNOWN(AWAITING_REVIEW)'],
    result: 'IN_PROGRESS',
    nextStep: 'Run the focused RED gate',
    estimate: {
      range: 'UNKNOWN(INSUFFICIENT_HISTORY)',
      confidence: 'UNKNOWN(INSUFFICIENT_HISTORY)',
      origin: 'ready-receipt:141ef124',
    },
    blocker: {
      class: 'UNKNOWN',
      reason: 'AWAITING_FIRST_EVIDENCE',
      owner: ACCOUNTABLE,
      phaseDeadline: '2026-09-01T22:30:00.000Z',
      nextTransition: 'RED_EVIDENCE_RECORDED',
      escalationAction: 'REQUEST_ARCHITECTURE_REASSESSMENT',
      origin: 'ready-receipt:141ef124',
    },
    origin: 'ready-receipt:141ef124',
    ...overrides,
  };
}

const responsibility = () => ({
  ownershipRevision: '7'.repeat(64),
  accountableOwner: ACCOUNTABLE,
  supervisor: SUPERVISOR,
  executionOwner: EXECUTION,
  reportsTo: SUPERVISOR,
  reviewOwners: {
    standards: 'github:user:standards-reviewer',
    spec: 'github:user:spec-reviewer',
  },
  effectOwner: 'github:app:gaia-draft-pump',
  escalatesTo: ACCOUNTABLE,
});

const command = () => ({
  commandRevision: '8'.repeat(64),
  commandOwner: SUPERVISOR,
  commandPath: [SUPERVISOR, EXECUTION],
  generation: HEAD,
  capabilities: ['ASSIGN', 'REVOKE', 'STOP', 'RETRY', 'ESCALATE'],
});

/** The receipt that opens R0 with `roundBudget` rounds. */
export const openReceipt = (roundBudget) => ({
  schema: 'GaiaRoundReceiptV0',
  kind: 'OPEN',
  revision: 'b'.repeat(64),
  ordinal: 0,
  predecessorRoundKey: 'NONE',
  trigger: 'DRAFT_CREATED',
  roundBudget,
  responsibility: responsibility(),
  command: command(),
  evidence: evidence(),
});

/** The blocker an R1 advance repairs; its class and reason make the failure fingerprint. */
export const REPAIR_BLOCKER = Object.freeze({
  class: 'REPRODUCED_FAILURE',
  reason: 'FOCUSED_TEST_FAILED',
  owner: 'issue-51 writer',
  phaseDeadline: '2026-09-01T23:30:00.000Z',
  nextTransition: 'REPAIR_EVIDENCE_RECORDED',
  escalationAction: 'REQUEST_ARCHITECTURE_REASSESSMENT',
  origin: `test-receipt:${'d'.repeat(12)}`,
});

/** The receipt that asks R0 to advance to R1 for a reproduced blocker. */
export const advanceReceipt = (predecessorRoundKey) => ({
  schema: 'GaiaRoundReceiptV0',
  kind: 'ADVANCE',
  revision: 'c'.repeat(64),
  ordinal: 1,
  predecessorRoundKey,
  trigger: 'REPRODUCED_BLOCKER',
  responsibility: responsibility(),
  command: command(),
  evidence: evidence({
    greenCommit: '4'.repeat(40),
    testEvidenceReceipt: 'd'.repeat(64),
    reviewVerdicts: ['CHANGES_REQUESTED'],
    result: 'REPAIR_REQUIRED',
    nextStep: 'Apply the bounded repair',
    blocker: { ...REPAIR_BLOCKER },
    origin: `blocker-receipt:${'c'.repeat(12)}`,
  }),
});

/** The Draft pull request as observed, carrying `body`. */
export const observation = (body) => ({
  number: 69,
  headRevision: HEAD,
  body,
  bodyRevision: digest(body),
});
