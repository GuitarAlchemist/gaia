// A pure shadow assessment. It holds no authority, claim, provider or GitHub port.
import { createHash } from 'node:crypto';

export const WORK_DIMENSIONS = Object.freeze([
  'value', 'coherence', 'currentness', 'duplicates', 'dependencies',
  'acceptance', 'scope', 'permissions', 'budget', 'owner',
]);
const STATES = ['supported', 'contradicted', 'unknown'];
const KINDS = ['research', 'decision', 'split', 'implementation'];
const MODES = ['protected-human', 'delegated-reversible', 'none', 'unknown'];

function invalid() { throw new Error('InvalidWorkQualification'); }
function text(value, max = 500) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max
      || value !== value.trim() || /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value)) invalid();
  return value;
}
function reference(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return { ref: text(value.ref), version: text(value.version, 128) };
}
function evidence(value, required) {
  if (!Array.isArray(value) || value.length > 8 || required && value.length === 0) invalid();
  return value.map(reference);
}
function check(value) {
  if (value === undefined) return { state: 'unknown', reason: 'not-observed', evidence: [] };
  if (!value || !STATES.includes(value.state)) invalid();
  return { state: value.state, reason: text(value.reason),
    evidence: evidence(value.evidence, value.state !== 'unknown') };
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}

export function qualifyWork(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
      || !KINDS.includes(input.proposalKind) || !MODES.includes(input.decisionMode)) invalid();
  const priority = input.priority == null ? null : {
    actor: input.priority.actor, rank: input.priority.rank,
    evidence: evidence(input.priority.evidence, true),
  };
  if (priority && (priority.actor !== 'human' || !Number.isSafeInteger(priority.rank)
      || Object.is(priority.rank, -0) || priority.rank < 0 || priority.rank > 1000)) invalid();
  if (!input.checks || typeof input.checks !== 'object' || Array.isArray(input.checks)) invalid();
  const checks = Object.fromEntries(WORK_DIMENSIONS.map(name => [name, check(input.checks[name])]));
  const expectedVersions = input.expectedVersions === undefined ? null : {
    issue: text(input.expectedVersions?.issue, 128), context: text(input.expectedVersions?.context, 128),
  };
  const snapshot = {
    issue: reference(input.issue), context: reference(input.context), priority,
    proposalKind: input.proposalKind, decisionMode: input.decisionMode,
    decisionEvidence: evidence(input.decisionEvidence, input.decisionMode !== 'unknown'),
    checks, expectedVersions,
  };
  const blockers = [];
  if (snapshot.decisionMode === 'protected-human') blockers.push('WAITING_HUMAN');
  if (checks.dependencies.state === 'contradicted') blockers.push('DEPENDENCY');
  if (checks.owner.state === 'contradicted') blockers.push('ALREADY_OWNED');
  const generationChanged = expectedVersions && (expectedVersions.issue !== snapshot.issue.version
    || expectedVersions.context !== snapshot.context.version);
  if (generationChanged || priority === null || snapshot.decisionMode === 'unknown'
      || WORK_DIMENSIONS.some(name => checks[name].state === 'unknown')
      || ['currentness', 'budget'].some(name => checks[name].state === 'contradicted')) {
    blockers.push('RECONCILE_REQUIRED');
  }
  let disposition;
  if (['value', 'coherence', 'duplicates', 'scope', 'permissions']
    .some(name => checks[name].state === 'contradicted')) disposition = 'REJECTED_PROPOSAL';
  else if (snapshot.proposalKind === 'decision' || snapshot.decisionMode === 'protected-human') disposition = 'DECISION';
  else if (snapshot.proposalKind === 'split' || checks.acceptance.state === 'contradicted') disposition = 'SPLIT';
  else if (snapshot.proposalKind === 'implementation' && blockers.length === 0) disposition = 'READY';
  else disposition = 'RESEARCH';
  const body = { schema: 'GaiaWorkQualificationV0', snapshot, disposition, blockers,
    generationChanged: !!generationChanged, dispatchAuthorized: false, effects: [] };
  return freeze({ ...body, revision: createHash('sha256').update(JSON.stringify(body)).digest('hex') });
}
