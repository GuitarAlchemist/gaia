/**
 * head-verification.mjs — one committed head, verified by the factory's own host verification,
 * sealed as a durable, content-addressed receipt (#217).
 *
 * WHY A RECEIPT
 * -------------
 * CI enforces the pinned Node and reports a check status. The autonomous factory enforces it
 * and keeps a machine-checkable record (`gaia-factory-verification/1`, #163). Every other run
 * (an author, a reviewer, an agent) used whatever `node` was on PATH and reported a sentence.
 * On 2026-10-03 that sentence was wrong: a PR body called five failures "pre-existing" that
 * came from running Node 24 against a v26.8.1 pin. A receipt makes the claim checkable.
 *
 * WHAT IT HOLDS, AND WHAT IT DOES NOT
 * -----------------------------------
 * `verifyCommittedHead` (src/factory-agent.mjs) produces the record: the factory's own
 * `verifyCandidate`, unmodified, over the clean base..HEAD change-set. This module only seals it
 * with the head and base it is bound to, and verifies a sealed receipt totally. The inner record
 * and change-set are checked by the factory contract's own validators, so there is one recipe
 * for "tests passed", not two.
 *
 * `effect: NONE` and `authority: NONE`: a receipt is evidence of one run on one machine. It is
 * not an approval, a check status, a merge condition or a substitute for independent review,
 * and nothing in this repository reads it as one.
 *
 * Design It Twice (issue #217): a sibling envelope around the unmodified factory record was
 * selected over widening `gaia-factory-verification/1` to a /2 that would carry `headSha`
 * (which would change a contract persisted autonomous receipts already use), and over a
 * runtime-checking wrapper that leaves the result in prose (which fixes the runtime and keeps
 * the claim uncheckable).
 */

import { createHash } from 'node:crypto';

import {
  AutonomousFactoryContractError, canonicalAutonomousJson,
  validateAutonomousChangeSet, validateAutonomousVerification,
} from './autonomous-factory-contract.mjs';

export const HEAD_VERIFICATION_SCHEMA = 'gaia-head-verification/1';

export const HEAD_VERIFICATION_FIELDS = Object.freeze([
  'schema', 'effect', 'authority', 'headSha', 'baseSha', 'changeSet', 'verification', 'revision',
]);

const FULL_SHA = /^[0-9a-f]{40}$/u;
const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

export class HeadVerificationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HeadVerificationError';
    this.code = code;
  }
}

const invalid = (message) => { throw new HeadVerificationError('HeadVerificationInvalid', message); };

/** The revision covers every field but itself, in the factory contract's canonical form. */
export function headVerificationRevision(body) {
  const canonical = canonicalAutonomousJson({
    schema: body.schema,
    effect: body.effect,
    authority: body.authority,
    headSha: body.headSha,
    baseSha: body.baseSha,
    changeSet: body.changeSet,
    verification: body.verification,
  }, 'InvalidReceipt');
  return createHash('sha256').update(canonical).digest('hex');
}

/** Seal what `verifyCommittedHead` returned. Refuses anything the verifier would refuse. */
export function sealHeadVerification({ headSha, changeSet, verification }) {
  const body = {
    schema: HEAD_VERIFICATION_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    headSha,
    baseSha: changeSet?.baseHead,
    changeSet,
    verification,
  };
  return requireHeadVerification({ ...body, revision: headVerificationRevision(body) });
}

/** Total verifier: returns the receipt unchanged, or throws `HeadVerificationInvalid`. */
export function requireHeadVerification(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    invalid('a head verification receipt is a plain object');
  }
  const keys = Object.keys(value);
  if (keys.length !== HEAD_VERIFICATION_FIELDS.length
      || !HEAD_VERIFICATION_FIELDS.every((field) => keys.includes(field))) {
    invalid(`a head verification receipt has exactly: ${HEAD_VERIFICATION_FIELDS.join(', ')}`);
  }
  if (value.schema !== HEAD_VERIFICATION_SCHEMA) invalid(`schema must be ${HEAD_VERIFICATION_SCHEMA}`);
  if (value.effect !== 'NONE' || value.authority !== 'NONE') {
    invalid('a head verification receipt carries no effect and no authority');
  }
  if (typeof value.headSha !== 'string' || !FULL_SHA.test(value.headSha)
      || typeof value.baseSha !== 'string' || !FULL_SHA.test(value.baseSha)) {
    invalid('headSha and baseSha are full lowercase 40-hex commits');
  }
  const changeSet = value.changeSet;
  if (changeSet === null || typeof changeSet !== 'object' || changeSet.baseHead !== value.baseSha) {
    invalid('the change-set is measured from the receipt\'s base');
  }
  // A committed head is verified from a clean worktree: no status bytes, ever.
  if (changeSet.statusBytes !== 0 || changeSet.statusSha256 !== EMPTY_SHA256) {
    invalid('the change-set of a committed head has no worktree status');
  }
  try {
    validateAutonomousChangeSet(changeSet, value.baseSha, Array.isArray(changeSet.files) && changeSet.files.length === 0);
    validateAutonomousVerification(value.verification, 'verification', changeSet.identity);
  } catch (error) {
    if (error instanceof AutonomousFactoryContractError) {
      invalid(`the factory contract refuses the inner record (${error.code})`);
    }
    throw error;
  }
  let revision;
  try {
    revision = headVerificationRevision(value);
  } catch (error) {
    if (error instanceof AutonomousFactoryContractError) invalid('the receipt is not canonical JSON data');
    throw error;
  }
  if (value.revision !== revision) invalid('the revision does not match the receipt');
  return value;
}
