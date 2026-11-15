// Integrity-bound proposals only: no executor, model, authority, claim or storage port.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canonicalJson } from './epistemic-research.mjs';
import { qualifyWork } from './work-qualification.mjs';

const KINDS = ['offline-analysis', 'local-test', 'isolated-prototype'];
const reject = code => { throw new Error(code); };
function closed(value, keys, code) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) reject(code);
}
function text(value, code) {
  if (typeof value !== 'string' || !value.length || value.length > 1000 || value.trim() !== value
      || /[\p{Cc}\p{Zl}\p{Zp}\u202a-\u202e\u2066-\u2069]/u.test(value)) reject(code);
  return value;
}
function path(value, prefix = false) {
  text(value, 'SCOPE_INVALID');
  if (!/^[A-Za-z0-9._/-]+$/u.test(value) || value.startsWith('/')
      || value.split('/').some((part, i, all) => part === '.' || part === '..'
        || part === '' && !(prefix && i === all.length - 1))) reject('SCOPE_INVALID');
  return value;
}
function data(value, depth = 0, budget = { nodes: 0 }) {
  budget.nodes += 1;
  if (depth > 6 || budget.nodes > 2048) reject('INVALID_PARAMETERS');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Object.is(value, -0)) reject('INVALID_PARAMETERS');
    return value;
  }
  if (typeof value === 'string') return text(value, 'INVALID_PARAMETERS');
  if (Array.isArray(value)) {
    if (value.length > 16) reject('INVALID_PARAMETERS');
    return value.map(v => data(v, depth + 1, budget));
  }
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
      || Object.keys(value).length > 16) reject('INVALID_PARAMETERS');
  return Object.fromEntries(Object.keys(value).sort().map(key => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)
        || /grant|authority|credential|secret|token|password/iu.test(key)) reject('INVALID_PARAMETERS');
    return [key, data(value[key], depth + 1, budget)];
  }));
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}
const digest = value => createHash('sha256').update(canonicalJson(value)).digest('hex');

export function proposeReversibleDecision(input) {
  closed(input, ['qualification', 'policy', 'owner', 'candidates', 'iteration', 'attempt'], 'INVALID_DECISION_INPUT');
  const p = input.policy;
  closed(p, ['ref', 'version', 'status', 'purpose', 'repository', 'owner', 'allowedKinds',
    'allowedPaths', 'maxIterations', 'maxAttempts', 'modelCalls', 'externalEffects'], 'INVALID_POLICY');
  text(p.repository, 'INVALID_POLICY');
  if (p.status !== 'delegated-reversible' || p.purpose !== 'independent-research'
      || p.modelCalls !== 0 || p.externalEffects !== 0
      || Object.is(p.modelCalls, -0) || Object.is(p.externalEffects, -0)
      || !Array.isArray(p.allowedKinds) || !p.allowedKinds.length
      || p.allowedKinds.length > 3 || p.allowedKinds.some(k => !KINDS.includes(k))
      || !Array.isArray(p.allowedPaths) || !p.allowedPaths.length || p.allowedPaths.length > 16
      || !/^[\w.-]+\/[\w.-]+$/u.test(p.repository)
      || !Number.isSafeInteger(p.maxIterations) || p.maxIterations < 1 || p.maxIterations > 3
      || !Number.isSafeInteger(p.maxAttempts) || p.maxAttempts < 1 || p.maxAttempts > 2) reject('INVALID_POLICY');
  text(p.ref, 'INVALID_POLICY'); text(p.version, 'INVALID_POLICY');
  closed(p.owner, ['id', 'version'], 'OWNER_CONFLICT');
  closed(input.owner, ['id', 'version', 'status'], 'OWNER_CONFLICT');
  for (const value of [p.owner.id, p.owner.version]) text(value, 'OWNER_CONFLICT');
  if (input.owner.status !== 'confirmed' || input.owner.id !== p.owner.id
      || input.owner.version !== p.owner.version) reject('OWNER_CONFLICT');
  if (!Number.isSafeInteger(input.iteration) || Object.is(input.iteration, -0) || input.iteration < 0 || input.iteration >= p.maxIterations
      || !Number.isSafeInteger(input.attempt) || Object.is(input.attempt, -0) || input.attempt < 0 || input.attempt >= p.maxAttempts) reject('BOUNDS_EXHAUSTED');
  const prefixes = p.allowedPaths.map(value => path(value, true));
  let qualification;
  try {
    const q = input.qualification;
    qualification = qualifyWork({ ...q.snapshot, expectedVersions: q.snapshot.expectedVersions ?? undefined });
    if (q.revision !== qualification.revision || q.dispatchAuthorized !== false
        || !Array.isArray(q.effects) || q.effects.length) reject('QUALIFICATION_MISMATCH');
  } catch { reject('QUALIFICATION_MISMATCH'); }
  const contextRepository = /^repo:([\w.-]+\/[\w.-]+)$/u.exec(qualification.snapshot.context.ref)?.[1];
  if (!contextRepository || contextRepository.toLowerCase() !== p.repository.toLowerCase()) reject('REPOSITORY_MISMATCH');
  if (qualification.generationChanged) reject('STALE_QUALIFICATION');
  if (qualification.disposition === 'REJECTED_PROPOSAL') reject('QUALIFICATION_REJECTED');
  if (qualification.blockers.includes('ALREADY_OWNED')) reject('OWNER_CONFLICT');
  if (!Array.isArray(input.candidates) || !input.candidates.length || input.candidates.length > 8) reject('INVALID_CANDIDATES');
  const candidates = input.candidates.map(c => {
    closed(c, ['id', 'kind', 'ownerId', 'scope', 'parameters', 'reason', 'uncertainty', 'test', 'rollback'], 'INVALID_CANDIDATE');
    text(c.id, 'INVALID_CANDIDATE');
    if (!/^[a-z][a-z0-9-]{0,63}$/u.test(c.id) || !p.allowedKinds.includes(c.kind)) reject('INVALID_CANDIDATE');
    if (c.ownerId !== input.owner.id) reject('OWNER_CONFLICT');
    if (!Array.isArray(c.scope) || !c.scope.length || c.scope.length > 16) reject('SCOPE_INVALID');
    const scope = c.scope.map(value => path(value));
    if (new Set(scope).size !== scope.length || scope.some(value => !prefixes.some(prefix =>
      prefix.endsWith('/') ? value.startsWith(prefix) : value === prefix))) reject('SCOPE_EXPANSION');
    const parameters = data(c.parameters);
    if (Buffer.byteLength(canonicalJson(parameters)) > 16384) reject('INVALID_PARAMETERS');
    return { id: c.id, kind: c.kind, ownerId: c.ownerId, scope: scope.sort(), parameters,
      reason: text(c.reason, 'INVALID_CANDIDATE'), uncertainty: text(c.uncertainty, 'INVALID_CANDIDATE'),
      test: text(c.test, 'INVALID_CANDIDATE'), rollback: text(c.rollback, 'INVALID_CANDIDATE') };
  });
  if (new Set(candidates.map(c => c.id)).size !== candidates.length) reject('INVALID_CANDIDATES');
  candidates.sort((a, b) => a.scope.length - b.scope.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const body = {
    schema: 'GaiaReversibleDecisionShadowV0', qualification,
    policy: { ...p, owner: { ...p.owner }, allowedKinds: [...p.allowedKinds], allowedPaths: prefixes },
    owner: { ...input.owner }, iteration: input.iteration, attempt: input.attempt,
    selectionRule: 'least-scope-size-then-id', alternatives: candidates, selected: candidates[0],
    preservedBarriers: [...qualification.blockers],
    humanDecisionUnresolved: qualification.snapshot.decisionMode === 'protected-human',
    outcome: 'NOT_EXECUTED', dispatchAuthorized: false, effects: [],
    evidenceLimit: 'Caller-supplied observations and counters; digest is not authority or a distributed lease',
  };
  return freeze({ ...body, digest: digest(body) });
}

export function verifyReversibleDecision(receipt, currentInput) {
  const current = proposeReversibleDecision(currentInput);
  if (!receipt || receipt.digest !== current.digest || !isDeepStrictEqual(receipt, current)) reject('STALE_RECEIPT');
  return freeze({ state: 'MATCHES_CURRENT_SHADOW', digest: current.digest, dispatchAuthorized: false });
}
