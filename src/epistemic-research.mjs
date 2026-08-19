/**
 * Pure construction of a bounded epistemic research proposal.
 *
 * This module does not send, persist, schedule, execute, route, spend, or grant
 * authority. Its output is ordinary data that the existing Gaia `send` verb may
 * carry as untrusted text for Demerzel to evaluate.
 */

import { createHash } from 'node:crypto';

export const RESEARCH_PROPOSAL_SCHEMA =
  'https://github.com/GuitarAlchemist/Demerzel/schemas/contracts/epistemic-research-proposal-v0.1';

export const EPISTEMIC_VOCABULARY = Object.freeze({ id: 'gaia-epistemic', version: '0.1.0' });

const GAP_KINDS = new Set([
  'missing-evidence',
  'contradiction',
  'stale-dependency',
  'out-of-distribution',
  'unmapped-concept',
  'failed-control',
  'unexpected-observation',
  'capability-gap',
]);
const HYPOTHESIS_ROLES = new Set(['null', 'alternative']);
const MASS_KEYS = ['T', 'P', 'U', 'D', 'F', 'C'];
const SHA256 = /^[a-f0-9]{64}$/;
const MATERIALIZED_KEYS = [
  'authority', 'createdAt', 'expiresAt', 'gap', 'hypotheses', 'kind', 'origin',
  'probe', 'proposalId', 'question', 'revision', 'schema', 'status',
  'uncertainty', 'vocabulary',
];

export class EpistemicProposalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'EpistemicProposalError';
    this.code = code;
  }
}

const reject = (code, message) => { throw new EpistemicProposalError(code, message); };
const present = (value) => typeof value === 'string' && value.trim().length > 0;

function requireText(value, path) {
  if (!present(value)) reject('MISSING_TEXT', `${path} must be a non-empty string`);
  return value.trim();
}

function requireSha256(value, path) {
  if (!SHA256.test(value)) reject('INVALID_DIGEST', `${path} must be a lowercase sha256 digest`);
  return value;
}

function revisionRef(value, path) {
  if (!value || value.algorithm !== 'sha256') {
    reject('INVALID_DIGEST', `${path}.algorithm must be sha256`);
  }
  return { algorithm: 'sha256', digest: requireSha256(value.digest, `${path}.digest`) };
}

function evidenceRef(value, index) {
  return {
    uri: requireText(value?.uri, `gap.evidenceRefs[${index}].uri`),
    ...revisionRef(value, `gap.evidenceRefs[${index}]`),
  };
}

function uncertaintyMass(value) {
  if (!value || value.unit !== 'ppm') reject('INVALID_UNCERTAINTY', 'uncertainty.unit must be ppm');
  const mass = { unit: 'ppm' };
  for (const key of MASS_KEYS) {
    const item = value[key];
    if (!Number.isInteger(item) || item < 0 || item > 1_000_000) {
      reject('INVALID_UNCERTAINTY', `uncertainty.${key} must be an integer from 0 to 1000000 ppm`);
    }
    mass[key] = item;
  }
  if (MASS_KEYS.reduce((sum, key) => sum + mass[key], 0) !== 1_000_000) {
    reject('INVALID_UNCERTAINTY', 'uncertainty T/P/U/D/F/C must sum to exactly 1000000 ppm');
  }
  mass.rationale = requireText(value.rationale, 'uncertainty.rationale');
  return mass;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

/**
 * Build one immutable, content-addressed proposal. The digest covers `body`,
 * i.e. every field except proposalId and revision. Array order is meaningful;
 * object-key order is canonicalised recursively before hashing.
 */
export function buildResearchProposal(input) {
  if (!input || typeof input !== 'object') reject('INVALID_INPUT', 'proposal input must be an object');

  const created = Date.parse(input.createdAt);
  const expires = Date.parse(input.expiresAt);
  if (Number.isNaN(created)) reject('INVALID_TIME', 'createdAt must be an ISO date-time');
  if (Number.isNaN(expires) || expires <= created) {
    reject('INVALID_TIME', 'expiresAt must be an ISO date-time later than createdAt');
  }

  if (!GAP_KINDS.has(input.gap?.kind)) {
    reject('INVALID_GAP_KIND', `unsupported gap kind: ${String(input.gap?.kind)}`);
  }

  if (!Array.isArray(input.hypotheses) || input.hypotheses.length < 2) {
    reject('WEAK_HYPOTHESIS_SET', 'at least two competing hypotheses are required');
  }
  const hypotheses = input.hypotheses.map((hypothesis, index) => {
    if (!HYPOTHESIS_ROLES.has(hypothesis?.role)) {
      reject('INVALID_HYPOTHESIS_ROLE', `hypotheses[${index}].role must be null or alternative`);
    }
    return {
      id: requireText(hypothesis.id, `hypotheses[${index}].id`),
      role: hypothesis.role,
      statement: requireText(hypothesis.statement, `hypotheses[${index}].statement`),
      falsifier: requireText(hypothesis.falsifier, `hypotheses[${index}].falsifier`),
    };
  });
  if (new Set(hypotheses.map((item) => item.id)).size !== hypotheses.length) {
    reject('DUPLICATE_HYPOTHESIS', 'hypothesis ids must be unique');
  }
  if (hypotheses.filter((item) => item.role === 'null').length !== 1) {
    reject('WEAK_HYPOTHESIS_SET', 'exactly one null hypothesis is required');
  }

  if (!present(input.probe?.negativeControl)) {
    reject('MISSING_NEGATIVE_CONTROL', 'probe requires a non-empty negative control');
  }
  if (input.probe?.maxCost?.value !== 0) {
    reject('PAID_BUDGET_REQUESTED', 'probe.maxCost.value must be zero for this tracer');
  }
  if (!present(input.probe?.maxCost?.unit)) {
    reject('AMBIGUOUS_BUDGET', 'probe requires an explicit cost unit');
  }
  if (input.probe?.reversible !== true) {
    reject('IRREVERSIBLE_PROBE', 'probe.reversible must be true');
  }

  if (input.authority?.mode !== 'advisory'
      || input.authority?.executionAuthorized !== false
      || !Array.isArray(input.authority?.requested)
      || input.authority.requested.length !== 0) {
    reject('AUTHORITY_WIDENING', 'a research proposal cannot authorize execution or request authority');
  }

  const body = {
    schema: RESEARCH_PROPOSAL_SCHEMA,
    kind: 'epistemic-research-proposal',
    status: 'advisory',
    createdAt: new Date(created).toISOString(),
    expiresAt: new Date(expires).toISOString(),
    origin: {
      repo: 'gaia',
      actor: requireText(input.origin?.actor, 'origin.actor'),
      inputRevision: revisionRef(input.origin?.inputRevision, 'origin.inputRevision'),
    },
    gap: {
      kind: input.gap.kind,
      subject: requireText(input.gap.subject, 'gap.subject'),
      observation: requireText(input.gap.observation, 'gap.observation'),
      evidenceRefs: Array.isArray(input.gap.evidenceRefs)
        ? input.gap.evidenceRefs.map(evidenceRef)
        : reject('INVALID_EVIDENCE', 'gap.evidenceRefs must be an array'),
    },
    question: requireText(input.question, 'question'),
    hypotheses,
    probe: {
      description: requireText(input.probe.description, 'probe.description'),
      negativeControl: input.probe.negativeControl.trim(),
      maxCost: { value: 0, unit: input.probe.maxCost.unit.trim() },
      reversible: true,
    },
    uncertainty: uncertaintyMass(input.uncertainty),
    authority: { mode: 'advisory', executionAuthorized: false, requested: [] },
    vocabulary: { ...EPISTEMIC_VOCABULARY },
  };
  const digest = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  return deepFreeze({
    ...body,
    proposalId: `erp-${digest}`,
    revision: { algorithm: 'sha256', digest },
  });
}

/** Recompute every materialized claim before it crosses an adapter boundary. */
export function verifyResearchProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    reject('INVALID_INPUT', 'materialized proposal must be an object');
  }
  const keys = Object.keys(proposal).sort();
  if (canonicalJson(keys) !== canonicalJson([...MATERIALIZED_KEYS].sort())) {
    reject('INVALID_MATERIALIZATION', 'value is not the exact materialized proposal shape');
  }
  if (proposal.schema !== RESEARCH_PROPOSAL_SCHEMA) {
    reject('UNSUPPORTED_SCHEMA', 'proposal does not use the supported epistemic research schema');
  }

  const { proposalId, revision, ...body } = proposal;
  const digest = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');
  if (revision?.algorithm !== 'sha256'
      || revision?.digest !== digest
      || proposalId !== `erp-${digest}`) {
    reject('DIGEST_MISMATCH', 'proposal content digest or proposalId does not match its body');
  }

  const rebuilt = buildResearchProposal({
    createdAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    origin: proposal.origin,
    gap: proposal.gap,
    question: proposal.question,
    hypotheses: proposal.hypotheses,
    probe: proposal.probe,
    uncertainty: proposal.uncertainty,
    authority: proposal.authority,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(proposal)) {
    reject('INVALID_MATERIALIZATION', 'value is not the exact materialized proposal shape');
  }
  return true;
}

/** Encode an already materialized proposal without changing its semantics. */
export function encodeResearchProposal(proposal) {
  verifyResearchProposal(proposal);
  return canonicalJson(proposal);
}
