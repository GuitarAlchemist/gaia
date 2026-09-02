/**
 * runner-provider-probe.mjs — `gaia-provider-capability-receipt/1`, slice R1 of issue #91: the
 * closed runner/provider contracts, and the one read-only question a self-hosted Gaia runner may
 * ask a provider before anything has been executed on its behalf.
 *
 * WHY THIS EXISTS
 * ---------------
 * A self-hosted runner is the most authority-dense thing Gaia can own. It sits on a host that
 * holds real provider sessions, and every convenient shortcut turns a capability question into an
 * unaudited effect: a probe that trusts the label it was handed, a probe that runs for a
 * generation which already lost, a probe that keeps working while the host drains, a probe that
 * records a provider's claim of "I posted a review" as though it were a capability reading.
 *
 * So this module answers exactly one question and does nothing else: *at this exact runner
 * generation, holding this exact lease, may this provider be asked about this exact capability,
 * and what did a read-only observation truthfully say about it?* It installs nothing, downloads
 * nothing, launches nothing, bills nothing, persists nothing, and holds no clock, no filesystem,
 * no process, no network and no credential. `effect` is `NONE` and `authority` is `NONE` on every
 * path it can take, including the successful one.
 *
 * THE FIVE RULES THAT DECIDE EVERY ANSWER
 * ---------------------------------------
 * 1. **Authority, then admission, then reconciliation, then the adapter.** That order is this
 *    slice's linearization point. The provider adapter is the last thing consulted and is not
 *    consulted at all when any earlier gate refuses, so a refusal can never be a side effect.
 * 2. **Work identity is not generation identity.** One host installation keeps one work key for
 *    its whole life and takes a new generation on each registration. Generations are compared by
 *    equality only, in both directions: a future number is refused exactly as a past one is,
 *    because an ordering comparison is how a replayed number comes to look live.
 * 3. **The admission table narrows and never grants.** `CODE_WRITE` and `MERGE_APPROVAL` exist in
 *    the vocabulary so that asking for them is representable and refusable. No row admits either,
 *    so every provider is refused writer and merge authority by one shared mechanism. NotebookLM's
 *    research-only row and `qwen-local`'s empty row are that mechanism, not provider branches.
 * 4. **The adapter is untrusted input.** Its answer is closed-parsed, bound to this mandate, and
 *    required to agree with itself. A claim of effect or authority is refused rather than
 *    recorded, and provider session material has no field to travel in: every observation field is
 *    a closed token, a bounded identifier, or a bounded non-negative integer.
 * 5. **A receipt is minted once per key, or reconciled.** A supplied prior receipt that carries
 *    this idempotency key, this mandate digest, and a revision equal to its own content is
 *    returned byte-identically without re-running the provider. Anything else is a conflict, never
 *    a second, differing receipt for one key.
 *
 * TWO CORRECTIONS THIS MODULE MAKES TO ITS OWN DESIGN
 * ---------------------------------------------------
 * `docs/self-hosted-runner-provider-probe.md` fixed a decision order before the gates were run.
 * Two steps of that order did not survive:
 *
 * - The lease was checked before the mandate deadline. An expired mandate is not work, so there is
 *   nothing for a lease to be held against; checking the lease first reports `LEASE_EXPIRED` for a
 *   runner whose real problem is that its mandate ran out. The deadline now decides first.
 * - The undeclared-MCP-server check ran before the credential-shape check. That order records a
 *   credential-shaped name in a blocker in order to say it was undeclared. The credential shape
 *   now decides first, so such a name is refused before it is republished as anything.
 *
 * It imports a digest and the one shared exact-instant predicate. Instants are additionally
 * required to be the fixed-width UTC form, because this module compares them as strings: the
 * expanded-year form that `Date#toISOString` also produces would sort before every ordinary
 * instant and make an expired mandate look fresh.
 */

import { createHash } from 'node:crypto';

import { isExactInstant } from './local-lane-observation.mjs';

export const RUNNER_IDENTITY_SCHEMA = 'gaia-runner-identity/1';
export const RUNNER_LEASE_SCHEMA = 'gaia-runner-lease/1';
export const PROVIDER_PROBE_MANDATE_SCHEMA = 'gaia-provider-probe-mandate/1';
export const PROVIDER_PROBE_INPUT_SCHEMA = 'gaia-provider-probe-input/1';
export const PROVIDER_PROBE_ADAPTER_SCHEMA = 'gaia-provider-probe-adapter/1';
export const PROVIDER_PROBE_REQUEST_SCHEMA = 'gaia-provider-probe-request/1';
export const PROVIDER_PROBE_OBSERVATION_SCHEMA = 'gaia-provider-capability-observation/1';
export const PROVIDER_PROBE_RECEIPT_SCHEMA = 'gaia-provider-capability-receipt/1';
export const PROVIDER_PROBE_FIXTURE_SCHEMA = 'gaia-provider-probe-fixture/1';

/**
 * The providers a Gaia runner may be registered for. This is a naming vocabulary, not a grant:
 * appearing here lets a runner *declare* a provider, and decides nothing about what may be asked.
 */
export const RUNNER_PROVIDERS = Object.freeze([
  'agy-gemini', 'auggie', 'claude-code', 'junie', 'notebooklm', 'qwen-local',
]);

/**
 * The capability kinds a probe can name. `CODE_WRITE` and `MERGE_APPROVAL` are here so that asking
 * for them is representable and therefore refusable by a mechanism rather than by omission.
 */
export const PROVIDER_CAPABILITY_KINDS = Object.freeze([
  'CODE_WRITE', 'MERGE_APPROVAL', 'READ_ONLY_REVIEW', 'RESEARCH_CITATION',
]);

/**
 * What each provider may be *asked about* at this revision. Every row narrows; no row grants.
 * The answer to an admitted question is still an observation with `NONE` authority.
 *
 * `qwen-local` is empty because the four security gates of
 * `docs/research/2026-09-01-local-chinese-agent-stack.md` have not passed. An empty row is the
 * honest encoding of "not admitted yet"; a missing row would read as permissive, so every
 * registered provider has one.
 */
export const PROVIDER_CAPABILITY_ADMISSION = Object.freeze({
  'agy-gemini': Object.freeze(['READ_ONLY_REVIEW']),
  auggie: Object.freeze(['READ_ONLY_REVIEW']),
  'claude-code': Object.freeze(['READ_ONLY_REVIEW']),
  junie: Object.freeze(['READ_ONLY_REVIEW']),
  notebooklm: Object.freeze(['RESEARCH_CITATION']),
  'qwen-local': Object.freeze([]),
});

export const RUNNER_OPERATING_SYSTEMS = Object.freeze(['LINUX', 'MACOS', 'WINDOWS']);
export const RUNNER_ARCHITECTURES = Object.freeze(['ARM64', 'X64']);

/** What a probe may conclude about a provider. `UNKNOWN` is not a soft `UNAVAILABLE`. */
export const PROVIDER_AVAILABILITIES = Object.freeze(['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']);

/** The units a quota may be counted in. `UNKNOWN` records a quota nobody could read. */
export const PROVIDER_QUOTA_UNITS = Object.freeze(['REQUESTS', 'SESSIONS', 'TOKENS', 'UNKNOWN']);

/**
 * What a provider may report about *itself*. These are the provider's own state, not Gaia
 * refusals: a receipt carrying them is a successful observation of an unavailable provider.
 */
export const PROVIDER_REPORTED_BLOCKERS = Object.freeze([
  'PROVIDER_NOT_INSTALLED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_SECURITY_GATE_PENDING',
  'PROVIDER_TIMEOUT', 'PROVIDER_UNAUTHENTICATED',
]);

/** Why Gaia refused. Each is a fail-closed stop, never a repair and never a retry instruction. */
export const PROVIDER_PROBE_BLOCKERS = Object.freeze([
  'AUTHORITY_WIDENING', 'BUDGET_EXCEEDED', 'CAPABILITY_NOT_ADMITTED',
  'CREDENTIAL_MATERIAL_PRESENT', 'LEASE_ABSENT', 'LEASE_EXPIRED', 'LEASE_FOREIGN',
  'MANDATE_EXPIRED', 'MUTABLE_TARGET_NOT_ADMITTED', 'OBSERVATION_INCOHERENT',
  'OBSERVATION_INVALID', 'OBSERVATION_MISBOUND', 'PROVIDER_ADAPTER_FAILED',
  'PROVIDER_UNREGISTERED', 'RECEIPT_CONFLICT', 'RUNNER_DRAINING', 'RUNNER_MISDELIVERY',
  'STALE_GENERATION', 'UNDECLARED_MCP_SERVER',
]);

export const RUNNER_IDENTITY_FIELDS = Object.freeze([
  'acceptingWork', 'arch', 'capabilities', 'generation', 'os', 'providers', 'runnerId', 'schema',
]);

export const PROVIDER_PROBE_MANDATE_FIELDS = Object.freeze([
  'budget', 'capability', 'corpus', 'deadline', 'declaredMcpServers', 'mandateId', 'provider',
  'runnerGeneration', 'runnerWorkKey', 'schema',
]);

export const RUNNER_LEASE_FIELDS = Object.freeze([
  'capability', 'expiresAt', 'generation', 'holder', 'leaseId', 'provider', 'schema', 'target',
  'workKey',
]);

export const PROVIDER_PROBE_INPUT_FIELDS = Object.freeze([
  'identity', 'lease', 'mandate', 'observedAt', 'priorReceipt', 'schema',
]);

export const PROVIDER_PROBE_OBSERVATION_FIELDS = Object.freeze([
  'authority', 'availability', 'capability', 'credentialsRead', 'effect', 'mandateDigest',
  'mcpServers', 'provider', 'providerBlockers', 'quota', 'schema', 'sourceExposed', 'usage',
]);

export const PROVIDER_PROBE_RECEIPT_FIELDS = Object.freeze([
  'authority', 'availability', 'blocker', 'capability', 'effect', 'idempotencyKey',
  'mandateDigest', 'mcpServers', 'observedAt', 'outcome', 'provider', 'providerBlockers', 'quota',
  'revision', 'runnerGeneration', 'runnerWorkKey', 'schema', 'usage',
]);

export const PROVIDER_PROBE_FIXTURE_FIELDS = Object.freeze([
  'availability', 'capability', 'mcpServers', 'provider', 'providerBlockers', 'quota', 'schema',
  'usage',
]);

const IDENTIFIER = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const RUNNER_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const MAX_GENERATION = 1_000_000;
const MAX_QUANTITY = 1_000_000_000_000;
const INSTANT_LENGTH = 24;

/**
 * A free-form name may be a repository-visible string forever, so it is refused when it is shaped
 * like a published credential prefix. This is a bounded structural check against known prefixes,
 * not a secret scanner, and it is the only place in this module where a value is inspected rather
 * than matched against a closed set.
 */
const CREDENTIAL_PREFIXES = Object.freeze([
  '-----BEGIN', 'AIza', 'AKIA', 'ghp_', 'gho_', 'ghr_', 'ghs_', 'ghu_', 'github_pat_',
  'sk-', 'sk_', 'xoxa-', 'xoxb-', 'xoxp-', 'ya29.',
]);

/** MCP server names are the one free-form field, so they are bounded and then credential-checked. */
const MCP_SERVER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export class RunnerProbeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RunnerProbeError';
    this.code = code;
  }
}

const refuse = (message) => {
  throw new RunnerProbeError('InvalidRunnerProbeInput', message);
};

/** Ordinal comparison. Not `localeCompare`, which is host- and ICU-version-dependent. */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort(ordinal).map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value) => createHash('sha256').update(value).digest('hex');

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/**
 * The fixed-width UTC instant. `Date#toISOString` also emits an expanded-year form, which sorts
 * before every ordinary instant; this module compares instants as strings, so admitting that form
 * would make an expired mandate look fresh.
 */
const isComparableInstant = (value) => isExactInstant(value)
  && value.length === INSTANT_LENGTH && value.endsWith('Z');

const isQuantity = (value, minimum) => Number.isSafeInteger(value)
  && value >= minimum && value <= MAX_QUANTITY;

const isCredentialShaped = (value) => CREDENTIAL_PREFIXES.some((prefix) => value.startsWith(prefix));

function requireClosedFields(value, fields, what) {
  if (!isPlainObject(value)) refuse(`a ${what} object is required`);
  for (const field of Object.keys(value)) {
    if (!fields.includes(field)) refuse(`the ${what} carries an unknown field ${JSON.stringify(field)}`);
  }
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) refuse(`the ${what} is missing ${field}`);
  }
}

/** A closed, sorted, duplicate-free subset of a vocabulary, supplied in canonical order. */
function requireSortedSubset(value, vocabulary, what, { allowEmpty = false } = {}) {
  if (!Array.isArray(value)) refuse(`the ${what} must be an array`);
  if (value.length === 0 && !allowEmpty) refuse(`the ${what} must not be empty`);
  for (const entry of value) {
    if (!vocabulary.includes(entry)) refuse(`${JSON.stringify(entry)} is not a registered ${what}`);
  }
  if (new Set(value).size !== value.length) refuse(`the ${what} repeats an entry`);
  if (canonicalJson(value) !== canonicalJson([...value].sort(ordinal))) {
    refuse(`the ${what} must be supplied in sorted order`);
  }
}

// -------------------------------------------------------------------------------------------
// Runner identity, and the labels derived from it.
// -------------------------------------------------------------------------------------------

export function requireRunnerIdentity(value) {
  requireClosedFields(value, RUNNER_IDENTITY_FIELDS, 'runner identity');
  if (value.schema !== RUNNER_IDENTITY_SCHEMA) refuse(`a ${RUNNER_IDENTITY_SCHEMA} value is required`);
  if (typeof value.runnerId !== 'string' || !RUNNER_ID.test(value.runnerId)) {
    refuse('a runner id must be a bounded lowercase identifier');
  }
  if (!RUNNER_OPERATING_SYSTEMS.includes(value.os)) refuse('the operating system is not registered');
  if (!RUNNER_ARCHITECTURES.includes(value.arch)) refuse('the architecture is not registered');
  if (!Number.isSafeInteger(value.generation)
      || value.generation < 0 || value.generation > MAX_GENERATION) {
    refuse(`a runner generation must be an integer from 0 through ${MAX_GENERATION}`);
  }
  if (typeof value.acceptingWork !== 'boolean') refuse('acceptingWork must be a boolean');
  requireSortedSubset(value.providers, RUNNER_PROVIDERS, 'runner provider');
  requireSortedSubset(value.capabilities, PROVIDER_CAPABILITY_KINDS, 'runner capability');
  return Object.freeze({
    schema: RUNNER_IDENTITY_SCHEMA,
    runnerId: value.runnerId,
    os: value.os,
    arch: value.arch,
    generation: value.generation,
    acceptingWork: value.acceptingWork,
    providers: Object.freeze([...value.providers]),
    capabilities: Object.freeze([...value.capabilities]),
  });
}

/**
 * Stable for the life of one host installation. It deliberately excludes the generation: a key
 * that named both the host and its registration epoch could not detect two live generations of
 * one host, which is the failure this slice exists to make impossible.
 */
export function runnerWorkKey(identity) {
  const verified = requireRunnerIdentity(identity);
  return digest(`${verified.runnerId} ${verified.os} ${verified.arch}`);
}

export function runnerGenerationKey(identity) {
  const verified = requireRunnerIdentity(identity);
  return `${runnerWorkKey(verified)}:${verified.generation}`;
}

/**
 * The closed registration label set, derived from the identity. Labels are never supplied: a
 * supplied label could claim a provider or capability the identity does not declare, and a
 * registration is exactly where such a claim would be believed.
 */
export function runnerLabels(identity) {
  const verified = requireRunnerIdentity(identity);
  const token = (value) => value.toLowerCase().replaceAll('_', '-');
  return Object.freeze([
    'gaia',
    `os:${token(verified.os)}`,
    `arch:${token(verified.arch)}`,
    `generation:${verified.generation}`,
    ...verified.providers.map((provider) => `provider:${token(provider)}`),
    ...verified.capabilities.map((capability) => `capability:${token(capability)}`),
  ].sort(ordinal));
}

// -------------------------------------------------------------------------------------------
// The probe mandate and the lease it is exercised under.
// -------------------------------------------------------------------------------------------

function requireBudget(value) {
  requireClosedFields(value, ['contextTokens', 'tokens', 'wallClockMs'], 'probe budget');
  for (const field of ['contextTokens', 'tokens', 'wallClockMs']) {
    if (!isQuantity(value[field], 1)) refuse(`the budget ${field} must be a positive integer`);
  }
  return Object.freeze({
    tokens: value.tokens, contextTokens: value.contextTokens, wallClockMs: value.wallClockMs,
  });
}

function requireCorpus(value) {
  requireClosedFields(value, ['containsRepositorySource', 'corpusId', 'promptCount'], 'probe corpus');
  if (typeof value.corpusId !== 'string' || !IDENTIFIER.test(value.corpusId)) {
    refuse('a corpus id must be a bounded lowercase identifier');
  }
  if (!isQuantity(value.promptCount, 1)) refuse('a corpus must contain at least one prompt');
  if (value.containsRepositorySource !== false) {
    refuse('a capability probe corpus is synthetic; repository source is not admitted');
  }
  return Object.freeze({
    corpusId: value.corpusId,
    promptCount: value.promptCount,
    containsRepositorySource: false,
  });
}

function requireMcpServerNames(value, what) {
  if (!Array.isArray(value)) refuse(`the ${what} must be an array`);
  for (const name of value) {
    if (typeof name !== 'string' || !MCP_SERVER_NAME.test(name)) {
      refuse(`${JSON.stringify(name)} is not a bounded MCP server name`);
    }
    if (isCredentialShaped(name)) refuse('an MCP server name may not be credential-shaped');
  }
  if (new Set(value).size !== value.length) refuse(`the ${what} repeats a server`);
  return Object.freeze([...value].sort(ordinal));
}

export function requireProviderProbeMandate(value) {
  requireClosedFields(value, PROVIDER_PROBE_MANDATE_FIELDS, 'probe mandate');
  if (value.schema !== PROVIDER_PROBE_MANDATE_SCHEMA) {
    refuse(`a ${PROVIDER_PROBE_MANDATE_SCHEMA} value is required`);
  }
  if (typeof value.mandateId !== 'string' || !IDENTIFIER.test(value.mandateId)) {
    refuse('a mandate id must be a bounded lowercase identifier');
  }
  if (typeof value.runnerWorkKey !== 'string' || !DIGEST.test(value.runnerWorkKey)) {
    refuse('a mandate must name one runner work key');
  }
  if (!Number.isSafeInteger(value.runnerGeneration)
      || value.runnerGeneration < 0 || value.runnerGeneration > MAX_GENERATION) {
    refuse('a mandate must name one runner generation');
  }
  if (!RUNNER_PROVIDERS.includes(value.provider)) refuse('the provider is not registered');
  if (!PROVIDER_CAPABILITY_KINDS.includes(value.capability)) refuse('the capability is not registered');
  if (!isComparableInstant(value.deadline)) refuse('a mandate deadline must be an exact UTC instant');
  return Object.freeze({
    schema: PROVIDER_PROBE_MANDATE_SCHEMA,
    mandateId: value.mandateId,
    runnerWorkKey: value.runnerWorkKey,
    runnerGeneration: value.runnerGeneration,
    provider: value.provider,
    capability: value.capability,
    deadline: value.deadline,
    budget: requireBudget(value.budget),
    declaredMcpServers: requireMcpServerNames(value.declaredMcpServers, 'declared MCP servers'),
    corpus: requireCorpus(value.corpus),
  });
}

export function requireRunnerLease(value) {
  requireClosedFields(value, RUNNER_LEASE_FIELDS, 'runner lease');
  if (value.schema !== RUNNER_LEASE_SCHEMA) refuse(`a ${RUNNER_LEASE_SCHEMA} value is required`);
  for (const field of ['leaseId', 'holder']) {
    if (typeof value[field] !== 'string' || !IDENTIFIER.test(value[field])) {
      refuse(`a lease ${field} must be a bounded lowercase identifier`);
    }
  }
  if (typeof value.workKey !== 'string' || !DIGEST.test(value.workKey)) {
    refuse('a lease must name one runner work key');
  }
  if (!Number.isSafeInteger(value.generation)
      || value.generation < 0 || value.generation > MAX_GENERATION) {
    refuse('a lease must name one runner generation');
  }
  if (!RUNNER_PROVIDERS.includes(value.provider)) refuse('the lease provider is not registered');
  if (!PROVIDER_CAPABILITY_KINDS.includes(value.capability)) {
    refuse('the lease capability is not registered');
  }
  if (!isComparableInstant(value.expiresAt)) refuse('a lease expiry must be an exact UTC instant');
  requireClosedFields(value.target, ['id', 'kind', 'mutable'], 'lease target');
  if (value.target.kind !== 'SYNTHETIC_CORPUS') {
    refuse('a read-only probe lease names a synthetic corpus target');
  }
  if (typeof value.target.id !== 'string' || !IDENTIFIER.test(value.target.id)) {
    refuse('a lease target id must be a bounded lowercase identifier');
  }
  if (typeof value.target.mutable !== 'boolean') refuse('a lease target must declare mutability');
  return Object.freeze({
    schema: RUNNER_LEASE_SCHEMA,
    leaseId: value.leaseId,
    holder: value.holder,
    workKey: value.workKey,
    generation: value.generation,
    provider: value.provider,
    capability: value.capability,
    target: Object.freeze({
      kind: value.target.kind, id: value.target.id, mutable: value.target.mutable,
    }),
    expiresAt: value.expiresAt,
  });
}

export function providerProbeMandateDigest(mandate) {
  return digest(canonicalJson(requireProviderProbeMandate(mandate)));
}

/**
 * One receipt per runner generation, provider, capability and mandate. The generation is inside
 * the key on purpose: a receipt minted by an older generation cannot be replayed into a newer one.
 */
export function providerProbeIdempotencyKey({ workKey, generation, provider, capability, mandateId }) {
  if (typeof workKey !== 'string' || !DIGEST.test(workKey)) refuse('an idempotency key needs a work key');
  if (!Number.isSafeInteger(generation) || generation < 0) refuse('an idempotency key needs a generation');
  if (!RUNNER_PROVIDERS.includes(provider)) refuse('an idempotency key needs a registered provider');
  if (!PROVIDER_CAPABILITY_KINDS.includes(capability)) {
    refuse('an idempotency key needs a registered capability');
  }
  if (typeof mandateId !== 'string' || !IDENTIFIER.test(mandateId)) {
    refuse('an idempotency key needs a mandate id');
  }
  return digest([workKey, generation, provider, capability, mandateId].join(' '));
}

// -------------------------------------------------------------------------------------------
// The receipt.
// -------------------------------------------------------------------------------------------

function receiptRevision(body) {
  return digest(canonicalJson(body));
}

function sealReceipt(body) {
  return Object.freeze({ ...body, revision: receiptRevision(body) });
}

function receiptBody(context, extra) {
  return {
    schema: PROVIDER_PROBE_RECEIPT_SCHEMA,
    outcome: 'BLOCKED',
    blocker: null,
    idempotencyKey: context.idempotencyKey,
    mandateDigest: context.mandateDigest,
    runnerWorkKey: context.workKey,
    runnerGeneration: context.generation,
    provider: context.provider,
    capability: context.capability,
    observedAt: context.observedAt,
    availability: 'UNKNOWN',
    quota: null,
    usage: null,
    mcpServers: Object.freeze([]),
    providerBlockers: Object.freeze([]),
    effect: 'NONE',
    authority: 'NONE',
    ...extra,
  };
}

const blocked = (context, blocker) => sealReceipt(receiptBody(context, { blocker }));

/**
 * A receipt read back from a durable store is verified against itself before it can reconcile
 * anything: a receipt whose revision no longer matches its content is not evidence.
 */
function readPriorReceipt(value) {
  try {
    requireClosedFields(value, PROVIDER_PROBE_RECEIPT_FIELDS, 'prior receipt');
  } catch {
    return null;
  }
  const { revision, ...body } = value;
  if (typeof revision !== 'string' || receiptRevision(body) !== revision) return null;
  return Object.freeze({ ...body, revision });
}

// -------------------------------------------------------------------------------------------
// The provider observation. Everything below this line treats the adapter as untrusted input.
// -------------------------------------------------------------------------------------------

function readQuota(value) {
  if (value === null) return null;
  requireClosedFields(value, ['limit', 'remaining', 'unit'], 'provider quota');
  if (!isQuantity(value.remaining, 0) || !isQuantity(value.limit, 0)) {
    refuse('a quota is counted in bounded non-negative integers');
  }
  if (!PROVIDER_QUOTA_UNITS.includes(value.unit)) refuse('the quota unit is not registered');
  return Object.freeze({ remaining: value.remaining, limit: value.limit, unit: value.unit });
}

function readUsage(value) {
  requireClosedFields(value, ['contextTokens', 'tokens', 'wallClockMs'], 'provider usage');
  for (const field of ['contextTokens', 'tokens', 'wallClockMs']) {
    if (!isQuantity(value[field], 0)) refuse(`the reported ${field} must be a non-negative integer`);
  }
  return Object.freeze({
    tokens: value.tokens, contextTokens: value.contextTokens, wallClockMs: value.wallClockMs,
  });
}

/** Structural parse only. What the observation *claims* is judged afterwards, by name. */
function readObservation(value) {
  requireClosedFields(value, PROVIDER_PROBE_OBSERVATION_FIELDS, 'provider observation');
  if (value.schema !== PROVIDER_PROBE_OBSERVATION_SCHEMA) {
    refuse(`a ${PROVIDER_PROBE_OBSERVATION_SCHEMA} value is required`);
  }
  if (typeof value.mandateDigest !== 'string' || !DIGEST.test(value.mandateDigest)) {
    refuse('an observation must name the mandate it answers');
  }
  if (!RUNNER_PROVIDERS.includes(value.provider)) refuse('the observed provider is not registered');
  if (!PROVIDER_CAPABILITY_KINDS.includes(value.capability)) {
    refuse('the observed capability is not registered');
  }
  if (!PROVIDER_AVAILABILITIES.includes(value.availability)) refuse('the availability is not registered');
  requireSortedSubset(value.providerBlockers, PROVIDER_REPORTED_BLOCKERS, 'provider blocker',
    { allowEmpty: true });
  if (typeof value.effect !== 'string' || typeof value.authority !== 'string') {
    refuse('an observation declares its effect and authority as tokens');
  }
  if (typeof value.sourceExposed !== 'boolean' || typeof value.credentialsRead !== 'boolean') {
    refuse('an observation declares source exposure and credential reads as booleans');
  }
  if (!Array.isArray(value.mcpServers)) refuse('the observed MCP servers must be an array');
  for (const name of value.mcpServers) {
    if (typeof name !== 'string' || !MCP_SERVER_NAME.test(name)) {
      refuse(`${JSON.stringify(name)} is not a bounded MCP server name`);
    }
  }
  if (new Set(value.mcpServers).size !== value.mcpServers.length) {
    refuse('the observed MCP servers repeat a server');
  }
  return Object.freeze({
    schema: value.schema,
    mandateDigest: value.mandateDigest,
    provider: value.provider,
    capability: value.capability,
    availability: value.availability,
    quota: readQuota(value.quota),
    usage: readUsage(value.usage),
    mcpServers: Object.freeze([...value.mcpServers].sort(ordinal)),
    providerBlockers: Object.freeze([...value.providerBlockers]),
    effect: value.effect,
    authority: value.authority,
    sourceExposed: value.sourceExposed,
    credentialsRead: value.credentialsRead,
  });
}

// -------------------------------------------------------------------------------------------
// probeProvider — one question, one receipt, and nothing else.
// -------------------------------------------------------------------------------------------

/**
 * Ask one provider one read-only capability question and return one content-addressed receipt.
 *
 * A malformed *caller* input throws: the caller owns its own contract. An adapter, its answer,
 * and a prior receipt are untrusted, so their defects return a typed blocker instead. Nothing
 * here performs, authorizes, or records an effect.
 */
export function probeProvider(input, providerAdapter) {
  requireClosedFields(input, PROVIDER_PROBE_INPUT_FIELDS, 'probe input');
  if (input.schema !== PROVIDER_PROBE_INPUT_SCHEMA) {
    refuse(`a ${PROVIDER_PROBE_INPUT_SCHEMA} value is required`);
  }
  if (!isComparableInstant(input.observedAt)) refuse('the observed instant must be an exact UTC instant');
  if (input.priorReceipt !== null && !isPlainObject(input.priorReceipt)) {
    refuse('a prior receipt is an object, or null');
  }
  if (!isPlainObject(providerAdapter)
      || providerAdapter.schema !== PROVIDER_PROBE_ADAPTER_SCHEMA
      || typeof providerAdapter.observe !== 'function') {
    refuse(`a ${PROVIDER_PROBE_ADAPTER_SCHEMA} adapter is required`);
  }

  const identity = requireRunnerIdentity(input.identity);
  const mandate = requireProviderProbeMandate(input.mandate);
  const lease = input.lease === null ? null : requireRunnerLease(input.lease);
  const workKey = runnerWorkKey(identity);
  const mandateDigest = digest(canonicalJson(mandate));
  const context = {
    workKey,
    generation: identity.generation,
    provider: mandate.provider,
    capability: mandate.capability,
    observedAt: input.observedAt,
    mandateDigest,
    idempotencyKey: providerProbeIdempotencyKey({
      workKey,
      generation: identity.generation,
      provider: mandate.provider,
      capability: mandate.capability,
      mandateId: mandate.mandateId,
    }),
  };

  // 1-4: authority. Nothing below is reachable by an actor who no longer holds the runner.
  if (mandate.runnerWorkKey !== workKey) return blocked(context, 'RUNNER_MISDELIVERY');
  if (mandate.runnerGeneration !== identity.generation) return blocked(context, 'STALE_GENERATION');
  if (!identity.acceptingWork) return blocked(context, 'RUNNER_DRAINING');
  if (input.observedAt >= mandate.deadline) return blocked(context, 'MANDATE_EXPIRED');
  if (lease === null) return blocked(context, 'LEASE_ABSENT');
  if (lease.workKey !== workKey || lease.generation !== identity.generation
      || lease.provider !== mandate.provider || lease.capability !== mandate.capability
      || lease.target.id !== mandate.corpus.corpusId) {
    return blocked(context, 'LEASE_FOREIGN');
  }
  if (input.observedAt >= lease.expiresAt) return blocked(context, 'LEASE_EXPIRED');
  if (lease.target.mutable) return blocked(context, 'MUTABLE_TARGET_NOT_ADMITTED');

  // 5: admission. The table narrows; it never grants.
  if (!identity.providers.includes(mandate.provider)) return blocked(context, 'PROVIDER_UNREGISTERED');
  if (!identity.capabilities.includes(mandate.capability)
      || !PROVIDER_CAPABILITY_ADMISSION[mandate.provider].includes(mandate.capability)) {
    return blocked(context, 'CAPABILITY_NOT_ADMITTED');
  }

  // 6: reconciliation, before any retry can reach the provider.
  if (input.priorReceipt !== null) {
    const prior = readPriorReceipt(input.priorReceipt);
    if (prior === null || prior.idempotencyKey !== context.idempotencyKey
        || prior.mandateDigest !== mandateDigest) {
      return blocked(context, 'RECEIPT_CONFLICT');
    }
    return prior;
  }

  // 7: the adapter, at last, and only now.
  let answer;
  try {
    answer = providerAdapter.observe(Object.freeze({
      schema: PROVIDER_PROBE_REQUEST_SCHEMA,
      provider: mandate.provider,
      capability: mandate.capability,
      corpusId: mandate.corpus.corpusId,
      promptCount: mandate.corpus.promptCount,
      budget: mandate.budget,
      declaredMcpServers: mandate.declaredMcpServers,
      mandateDigest,
    }));
  } catch {
    return blocked(context, 'PROVIDER_ADAPTER_FAILED');
  }
  if (!isPlainObject(answer)) return blocked(context, 'PROVIDER_ADAPTER_FAILED');

  let observation;
  try {
    observation = readObservation(answer);
  } catch {
    return blocked(context, 'OBSERVATION_INVALID');
  }
  if (observation.mandateDigest !== mandateDigest || observation.provider !== mandate.provider
      || observation.capability !== mandate.capability) {
    return blocked(context, 'OBSERVATION_MISBOUND');
  }
  const available = observation.availability === 'AVAILABLE';
  if (available !== (observation.providerBlockers.length === 0)) {
    return blocked(context, 'OBSERVATION_INCOHERENT');
  }
  // Credential shape decides before undeclared MCP: refusing a credential-shaped name for being
  // undeclared would be republishing it in order to complain about it.
  if (observation.mcpServers.some(isCredentialShaped)) {
    return blocked(context, 'CREDENTIAL_MATERIAL_PRESENT');
  }
  if (observation.mcpServers.some((name) => !mandate.declaredMcpServers.includes(name))) {
    return blocked(context, 'UNDECLARED_MCP_SERVER');
  }
  if (observation.effect !== 'NONE' || observation.authority !== 'NONE'
      || observation.sourceExposed || observation.credentialsRead) {
    return blocked(context, 'AUTHORITY_WIDENING');
  }
  if (observation.usage.tokens > mandate.budget.tokens
      || observation.usage.contextTokens > mandate.budget.contextTokens
      || observation.usage.wallClockMs > mandate.budget.wallClockMs) {
    return blocked(context, 'BUDGET_EXCEEDED');
  }

  return sealReceipt(receiptBody(context, {
    outcome: 'CAPABILITY_OBSERVED',
    availability: observation.availability,
    quota: observation.quota,
    usage: observation.usage,
    mcpServers: observation.mcpServers,
    providerBlockers: observation.providerBlockers,
  }));
}

// -------------------------------------------------------------------------------------------
// The one capability probe this slice ships.
// -------------------------------------------------------------------------------------------

/**
 * A read-only capability probe over a frozen synthetic fixture. It is the whole of this slice's
 * "run a probe": it opens no socket, spawns no process, reads no file, holds no clock, and carries
 * no credential.
 *
 * It writes `effect`, `authority`, `sourceExposed` and `credentialsRead` itself rather than
 * copying them, so a hostile fixture has no field to put an authority claim in — the fixture
 * contract simply has no such field, and supplying one is refused at construction.
 */
export function createSyntheticFixtureProbeAdapter(fixture) {
  requireClosedFields(fixture, PROVIDER_PROBE_FIXTURE_FIELDS, 'probe fixture');
  if (fixture.schema !== PROVIDER_PROBE_FIXTURE_SCHEMA) {
    refuse(`a ${PROVIDER_PROBE_FIXTURE_SCHEMA} value is required`);
  }
  if (!RUNNER_PROVIDERS.includes(fixture.provider)) refuse('the fixture provider is not registered');
  if (!PROVIDER_CAPABILITY_KINDS.includes(fixture.capability)) {
    refuse('the fixture capability is not registered');
  }
  if (!PROVIDER_AVAILABILITIES.includes(fixture.availability)) {
    refuse('the fixture availability is not registered');
  }
  const quota = readQuota(fixture.quota);
  const usage = readUsage(fixture.usage);
  const mcpServers = Object.freeze([...requireMcpServerNames(fixture.mcpServers, 'fixture MCP servers')]);
  requireSortedSubset(fixture.providerBlockers, PROVIDER_REPORTED_BLOCKERS, 'provider blocker',
    { allowEmpty: true });
  const providerBlockers = Object.freeze([...fixture.providerBlockers]);

  return Object.freeze({
    schema: PROVIDER_PROBE_ADAPTER_SCHEMA,
    observe(request) {
      if (!isPlainObject(request) || request.schema !== PROVIDER_PROBE_REQUEST_SCHEMA) {
        refuse('a probe request is required');
      }
      // Answering a question it was not asked would be worse than failing.
      if (request.provider !== fixture.provider || request.capability !== fixture.capability) {
        refuse('this fixture was not built for the provider or capability that was asked about');
      }
      return Object.freeze({
        schema: PROVIDER_PROBE_OBSERVATION_SCHEMA,
        mandateDigest: request.mandateDigest,
        provider: fixture.provider,
        capability: fixture.capability,
        availability: fixture.availability,
        quota,
        usage,
        mcpServers,
        providerBlockers,
        effect: 'NONE',
        authority: 'NONE',
        sourceExposed: false,
        credentialsRead: false,
      });
    },
  });
}
