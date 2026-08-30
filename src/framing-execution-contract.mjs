/**
 * Pure framing of a fully bounded, zero-effect execution request.
 *
 * The output is a contract for later evaluation. It does not plan, fan out,
 * schedule, execute, spend, mutate source, or grant authority.
 */

import { createHash } from 'node:crypto';

import { canonicalJson } from './epistemic-research.mjs';
import {
  advisoryAuthority,
  ADVISORY_HARD_LIMITS,
  ADVISORY_WORK_SHAPE,
  deepFreeze,
  isAdvisoryAuthority,
} from './advisory-policy.mjs';

export const EXECUTION_CONTRACT_SCHEMA = 'urn:gaia:bounded-execution-contract:v0.1';

const SHA256 = /^[a-f0-9]{64}$/;
const CONTRACT_KEYS = [
  'assumptions', 'authority', 'ceilings', 'contractId', 'evaluation',
  'evidenceGates', 'kind', 'outcome', 'request', 'reversibility', 'revision',
  'schema', 'scope', 'status', 'stopConditions', 'workShape',
];
const INPUT_KEYS = [
  'assumptions', 'ceilings', 'evaluation', 'evidenceGates', 'outcome', 'request',
  'scope', 'stopConditions',
];
const REQUEST_KEYS = ['expiresAt', 'id', 'observedAt', 'requester', 'revision'];
const REVISION_KEYS = ['algorithm', 'digest'];
const OUTCOME_KEYS = ['consumer', 'observable'];
const SCOPE_KEYS = ['inScope', 'outOfScope'];
const EVALUATION_KEYS = ['antiMetrics', 'falsifiers', 'rejectionCriteria', 'success'];
const CEILING_KEYS = ['humanAttentionMinutes', 'tokens', 'wallTimeMs'];

export class ExecutionFramingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExecutionFramingError';
    this.code = code;
  }
}

const reject = (code, message) => { throw new ExecutionFramingError(code, message); };
const text = (value, path) => {
  if (typeof value !== 'string' || value.trim().length === 0) {
    reject('MISSING_TEXT', `${path} must be a non-empty string`);
  }
  return value.trim();
};

function textList(value, path) {
  if (!Array.isArray(value) || value.length === 0) {
    reject('MISSING_LIST', `${path} must be a non-empty array`);
  }
  return value.map((item, index) => text(item, `${path}[${index}]`));
}

function digestRef(value, path) {
  if (value?.algorithm !== 'sha256' || !SHA256.test(value?.digest)) {
    reject('INVALID_DIGEST', `${path} must be an immutable lowercase sha256 reference`);
  }
  return { algorithm: 'sha256', digest: value.digest };
}

function isoTime(value, path) {
  const instant = Date.parse(value);
  if (Number.isNaN(instant)) reject('INVALID_TIME', `${path} must be an ISO date-time`);
  return { instant, value: new Date(instant).toISOString() };
}

function positiveInteger(value, path) {
  if (!Number.isInteger(value) || value < 1) {
    reject('INVALID_CEILING', `${path} must be a positive integer`);
  }
  return value;
}

function boundedPositiveInteger(value, path, maximum) {
  const result = positiveInteger(value, path);
  if (result > maximum) {
    reject('UNBOUNDED_CEILING', `${path} exceeds the advisory hard limit of ${maximum}`);
  }
  return result;
}

function digestOf(value) {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

function rejectUnknownKeys(value, allowed, path, requiredObject = false) {
  if (value === undefined && !requiredObject) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    reject('INVALID_SHAPE', `${path} must be an object`);
  }
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key)).sort();
  if (unknown.length > 0) {
    reject('UNSUPPORTED_FIELD', `${path} contains unsupported field(s): ${unknown.join(', ')}`);
  }
}

function validateInputShape(input) {
  rejectUnknownKeys(input, INPUT_KEYS, 'input', true);
  rejectUnknownKeys(input.request, REQUEST_KEYS, 'request');
  rejectUnknownKeys(input.request?.revision, REVISION_KEYS, 'request.revision');
  rejectUnknownKeys(input.outcome, OUTCOME_KEYS, 'outcome');
  rejectUnknownKeys(input.scope, SCOPE_KEYS, 'scope');
  rejectUnknownKeys(input.evaluation, EVALUATION_KEYS, 'evaluation');
  rejectUnknownKeys(input.ceilings, CEILING_KEYS, 'ceilings');
}

const clarificationChecks = [
  ['MISSING_REQUEST_ID', 'request.id', 'Name the request.'],
  ['MISSING_REQUEST_REVISION', 'request.revision', 'Bind the request to an immutable revision.'],
  ['MISSING_REQUESTER', 'request.requester', 'Name the requester.'],
  ['MISSING_OBSERVED_AT', 'request.observedAt', 'State when the request was observed.'],
  ['MISSING_EXPIRES_AT', 'request.expiresAt', 'State when the framing expires.'],
  ['MISSING_OUTCOME_CONSUMER', 'outcome.consumer', 'Name who consumes the outcome.'],
  ['MISSING_OUTCOME_OBSERVABLE', 'outcome.observable', 'State one observable outcome.'],
  ['MISSING_IN_SCOPE', 'scope.inScope', 'List at least one in-scope action.'],
  ['MISSING_OUT_OF_SCOPE', 'scope.outOfScope', 'List at least one explicit exclusion.'],
  ['MISSING_ASSUMPTION', 'assumptions', 'State at least one falsifiable assumption.'],
  ['MISSING_EVIDENCE_GATE', 'evidenceGates', 'State at least one evidence gate.'],
  ['MISSING_SUCCESS_CRITERION', 'evaluation.success', 'State at least one success criterion.'],
  ['MISSING_ANTI_METRIC', 'evaluation.antiMetrics', 'State at least one anti-metric.'],
  ['MISSING_EVALUATION_FALSIFIER', 'evaluation.falsifiers', 'State at least one falsifier.'],
  [
    'MISSING_REJECTION_CRITERION',
    'evaluation.rejectionCriteria',
    'State at least one rejection criterion.',
  ],
  ['MISSING_WALL_TIME_CEILING', 'ceilings.wallTimeMs', 'Bound wall-clock time.'],
  ['MISSING_TOKEN_CEILING', 'ceilings.tokens', 'Bound model tokens.'],
  [
    'MISSING_HUMAN_ATTENTION_CEILING',
    'ceilings.humanAttentionMinutes',
    'Bound human attention.',
  ],
  ['MISSING_STOP_CONDITION', 'stopConditions', 'State at least one stop condition.'],
];

function valueAt(input, path) {
  return path.split('.').reduce((value, key) => value?.[key], input);
}

function isSemanticallyMissing(value) {
  return value === undefined
    || value === null
    || (typeof value === 'string' && value.trim().length === 0)
    || (Array.isArray(value) && value.length === 0);
}

function clarificationIssues(input) {
  const issues = clarificationChecks
    .filter(([, path]) => isSemanticallyMissing(valueAt(input, path)))
    .map(([code, path, prompt]) => ({ code, path, prompt }));
  if (Array.isArray(input.scope?.inScope) && Array.isArray(input.scope?.outOfScope)) {
    const included = new Set(input.scope.inScope
      .filter((value) => typeof value === 'string')
      .map((value) => value.trim().toLowerCase()));
    const overlaps = input.scope.outOfScope.some(
      (value) => typeof value === 'string' && included.has(value.trim().toLowerCase()),
    );
    if (overlaps) {
      issues.push({
        code: 'SCOPE_OVERLAP',
        path: 'scope',
        prompt: 'Resolve items declared both in and out of scope.',
      });
    }
  }
  return issues;
}

function clarificationResult(issues) {
  const body = {
    schema: EXECUTION_CONTRACT_SCHEMA,
    kind: 'execution-framing-clarification',
    status: 'NEEDS_CLARIFICATION',
    issues,
    authority: advisoryAuthority(),
  };
  const digest = digestOf(body);
  return deepFreeze({
    ...body,
    clarificationId: `bfc-${digest}`,
    revision: { algorithm: 'sha256', digest },
  });
}

function materialize(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    reject('INVALID_INPUT', 'framing input must be an object');
  }
  if (Object.hasOwn(input, 'authority')) {
    reject('AUTHORITY_WIDENING', 'authority is fixed and cannot be supplied by the caller');
  }

  const observedAt = isoTime(input.request?.observedAt, 'request.observedAt');
  const expiresAt = isoTime(input.request?.expiresAt, 'request.expiresAt');
  if (expiresAt.instant <= observedAt.instant
      || expiresAt.instant - observedAt.instant > ADVISORY_HARD_LIMITS.maxExpiryMs) {
    reject('INVALID_TIME', 'request expiry must be later than observation and at most seven days');
  }

  const wallTimeMs = boundedPositiveInteger(
    input.ceilings?.wallTimeMs,
    'ceilings.wallTimeMs',
    ADVISORY_HARD_LIMITS.maxDurationMs,
  );

  return {
    schema: EXECUTION_CONTRACT_SCHEMA,
    kind: 'bounded-execution-contract',
    status: 'FRAMED',
    request: {
      id: text(input.request?.id, 'request.id'),
      revision: digestRef(input.request?.revision, 'request.revision'),
      requester: text(input.request?.requester, 'request.requester'),
      observedAt: observedAt.value,
      expiresAt: expiresAt.value,
    },
    outcome: {
      consumer: text(input.outcome?.consumer, 'outcome.consumer'),
      observable: text(input.outcome?.observable, 'outcome.observable'),
    },
    scope: {
      inScope: textList(input.scope?.inScope, 'scope.inScope'),
      outOfScope: textList(input.scope?.outOfScope, 'scope.outOfScope'),
    },
    assumptions: textList(input.assumptions, 'assumptions'),
    evidenceGates: textList(input.evidenceGates, 'evidenceGates'),
    evaluation: {
      success: textList(input.evaluation?.success, 'evaluation.success'),
      antiMetrics: textList(input.evaluation?.antiMetrics, 'evaluation.antiMetrics'),
      falsifiers: textList(input.evaluation?.falsifiers, 'evaluation.falsifiers'),
      rejectionCriteria: textList(
        input.evaluation?.rejectionCriteria,
        'evaluation.rejectionCriteria',
      ),
    },
    ceilings: {
      wallTimeMs,
      tokens: boundedPositiveInteger(
        input.ceilings?.tokens,
        'ceilings.tokens',
        ADVISORY_HARD_LIMITS.maxTokens,
      ),
      humanAttentionMinutes: boundedPositiveInteger(
        input.ceilings?.humanAttentionMinutes,
        'ceilings.humanAttentionMinutes',
        ADVISORY_HARD_LIMITS.maxHumanAttentionMinutes,
      ),
      maxIncrementalPaidUsd: ADVISORY_HARD_LIMITS.maxIncrementalPaidUsd,
    },
    stopConditions: textList(input.stopConditions, 'stopConditions'),
    workShape: ADVISORY_WORK_SHAPE,
    reversibility: 'NO_EFFECT',
    authority: advisoryAuthority(),
  };
}

export function frameExecutionRequest(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    reject('INVALID_INPUT', 'framing input must be an object');
  }
  if (Object.hasOwn(input, 'authority')) {
    reject('AUTHORITY_WIDENING', 'authority is fixed and cannot be supplied by the caller');
  }
  validateInputShape(input);
  const issues = clarificationIssues(input);
  if (issues.length > 0) return clarificationResult(issues);

  const body = materialize(input);
  const digest = digestOf(body);
  return deepFreeze({
    ...body,
    contractId: `bec-${digest}`,
    revision: { algorithm: 'sha256', digest },
  });
}

export function verifyExecutionContract(contract) {
  if (!contract || typeof contract !== 'object'
      || canonicalJson(Object.keys(contract).sort()) !== canonicalJson([...CONTRACT_KEYS].sort())) {
    reject('INVALID_MATERIALIZATION', 'contract is not the exact materialized shape');
  }
  if (contract.schema !== EXECUTION_CONTRACT_SCHEMA
      || contract.kind !== 'bounded-execution-contract'
      || contract.status !== 'FRAMED') {
    reject('UNSUPPORTED_SCHEMA', 'contract does not use the supported schema, kind, and status');
  }
  if (!isAdvisoryAuthority(contract.authority)) {
    reject('AUTHORITY_WIDENING', 'contract authority boundary was widened');
  }
  const { contractId, revision, ...body } = contract;
  const digest = digestOf(body);
  if (revision?.algorithm !== 'sha256'
      || revision.digest !== digest
      || contractId !== `bec-${digest}`) {
    reject('DIGEST_MISMATCH', 'contract digest or contractId does not match its body');
  }
  const rebuilt = materialize({
    request: contract.request,
    outcome: contract.outcome,
    scope: contract.scope,
    assumptions: contract.assumptions,
    evidenceGates: contract.evidenceGates,
    evaluation: contract.evaluation,
    ceilings: {
      wallTimeMs: contract.ceilings?.wallTimeMs,
      tokens: contract.ceilings?.tokens,
      humanAttentionMinutes: contract.ceilings?.humanAttentionMinutes,
    },
    stopConditions: contract.stopConditions,
  });
  if (canonicalJson(rebuilt) !== canonicalJson(body)) {
    reject('INVALID_MATERIALIZATION', 'contract is not the exact deterministic materialization');
  }
  return true;
}

export function encodeExecutionContract(contract) {
  verifyExecutionContract(contract);
  return canonicalJson(contract);
}
