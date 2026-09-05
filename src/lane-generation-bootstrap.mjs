/**
 * lane-generation-bootstrap.mjs — `gaia-lane-launch-receipt/1`, R0 of issue #93: the one
 * transition that turns an authoritative generation manifest into either a complete, verified,
 * durably receipted set of lanes, or a refused transition with recoverable cleanup intent.
 *
 * WHY THIS EXISTS
 * ---------------
 * A terminal multiplexer reports a lane as live the instant a child process is created. That
 * answer is true about the process and useless as a launch: on 2026-09-01 a lane was counted
 * live while its pane and surface did not exist, and on 2026-09-02 a grid was expanded around
 * lanes that had already been counted, collapsing four surfaces into stacked tabs. Neither
 * failure is fixable where it was observed, because the missing thing was never a check — it was
 * a durable statement of what the generation was supposed to be, against which a launch could be
 * verified, replayed, or compensated.
 *
 * So this module owns the whole transition and none of the mechanism. It creates no pane, runs no
 * process, opens no file, reads no environment and holds no clock. Two injected ports do the
 * work: an execution boundary and compare-and-set store per stable work identity, and a lane
 * adapter that speaks seven structural operations. Everything this module decides, it decides
 * from closed documents and structured observations.
 *
 * THE FIVE RULES THAT DECIDE EVERY ANSWER
 * ---------------------------------------
 * 1. **The receipt is the linearization point.** A lane is `STARTING` until every postcondition
 *    passes against ONE fresh observation of the visible tree. Before that there is no `ACTIVE`
 *    state to read, so nothing downstream can count a launch that was never verified.
 * 2. **The complete topology exists before any process does.** The whole empty grid for the
 *    generation is built first. A generation is never grown around live surfaces, which is
 *    exactly what turned four panes into four stacked tabs.
 * 3. **Identity is content, never memory.** Work identity, generation identity and operation
 *    identity are digests of the authoritative manifest. A remembered pane identity is never an
 *    input, so a crashed host reconstructs the same generation from the same document.
 * 4. **One executor per work identity.** The store admits one callback at a time, including
 *    same-actor resumption, before provider access. A contender returns EXECUTION_HELD without
 *    provider calls. Record CAS separately detects unexpected revisions; a stale claimant
 *    performs no provider mutation. The bundled adapter proves only same-instance exclusion.
 * 5. **Compensation is bounded by the operation, never by the workspace.** Every created resource
 *    carries this operation's marker, and cleanup addresses marked resources only. There is no
 *    code path here that enumerates a workspace and closes what it finds, which is why an
 *    unrelated workspace is out of reach by construction rather than by care.
 *
 * WHAT A LANE ADAPTER MAY SAY, AND WHAT IT MAY NOT
 * -----------------------------------------------
 * `gaia-lane-provider-capability/1` is the entire admission surface: identity, capabilities,
 * cost/quota observation, authentication mode, liveness evidence contract, and limits. The
 * decision code never branches on the identity — it is carried so a receipt can say which adapter
 * produced the evidence. Every other adapter fact is structural: an agent identity, a pane
 * identity, a surface identity, a lifecycle word from a closed set, a process identity, an
 * observed layout revision. Rendered text is not in the vocabulary, so no amount of it can make a
 * launch true. That is a property of the interface, not a discipline this module practises.
 *
 * WHAT R0 DOES NOT DO
 * -------------------
 * It ships no durable store adapter, no caller-facing entrypoint, no adapter for any real
 * terminal host, no watchdog, and no funnel event. `ttlMs` and `retryBudget` are validated and
 * carried into the receipt for the consumers that will spend them, and are not spent here.
 * docs/lane-generation-bootstrap.md states every omission against issue #93.
 */

import { createHash } from 'node:crypto';

import { LaneLimitError, resolveLaneLimit } from './lanes.mjs';
import { isExactInstant, isSafeLaneIdentity } from './local-lane-observation.mjs';

export const LANE_GENERATION_MANIFEST_SCHEMA = 'gaia-lane-generation-manifest/1';
export const LANE_PROVIDER_CAPABILITY_SCHEMA = 'gaia-lane-provider-capability/1';
export const LANE_GENERATION_RECORD_SCHEMA = 'gaia-lane-generation-record/1';
export const LANE_LAUNCH_RECEIPT_SCHEMA = 'gaia-lane-launch-receipt/1';

/** Digest domain separators. They are never published as documents of their own. */
const WORK_KEY_SCHEMA = 'gaia-lane-work-key/1';
const GENERATION_ID_SCHEMA = 'gaia-lane-generation-id/1';
const OPERATION_ID_SCHEMA = 'gaia-lane-operation-id/1';

export const LANE_MANIFEST_FIELDS = Object.freeze([
  'generationOrdinal', 'lanes', 'policy', 'providerId', 'repository', 'revision', 'schema',
  'workItem', 'workspaceId',
]);
export const LANE_MANIFEST_LANE_FIELDS = Object.freeze([
  'artifactMarker', 'laneId', 'role', 'subject', 'supervisor',
]);
export const LANE_MANIFEST_POLICY_FIELDS = Object.freeze([
  'cleanupPolicy', 'retryBudget', 'startupDeadlineMs', 'ttlMs',
]);
export const LANE_WORK_ITEM_FIELDS = Object.freeze(['kind', 'number']);
export const LANE_SUBJECT_FIELDS = Object.freeze(['kind', 'name']);

export const LANE_WORK_ITEM_KINDS = Object.freeze(['ISSUE', 'PULL_REQUEST']);

/**
 * A lane subject is either an immutable revision or a mutable branch, and the two are kept
 * apart. Collapsing them would let a generation claim to be reconstructible from a name that
 * can point somewhere else tomorrow.
 */
export const LANE_SUBJECT_KINDS = Object.freeze(['BRANCH', 'REVISION']);

export const LANE_ROLES = Object.freeze(['IMPLEMENTER', 'REVIEWER', 'SUPERVISOR', 'WATCHDOG']);

/** The one supervisor value that is not a lane: the human at the root of the reporting graph. */
export const LANE_OPERATOR_SUPERVISOR = 'OPERATOR';

/**
 * One member, because one policy has been implemented. A vocabulary entry for a cleanup mode
 * nothing performs would be a promise with no mechanism behind it.
 */
export const LANE_CLEANUP_POLICIES = Object.freeze(['COMPENSATE_OWN_RESOURCES']);

/** A document-size bound, not a lane policy. `lanes.mjs` owns the supported live-lane count. */
export const LANE_MANIFEST_MAX_LANES = 8;

export const LANE_PROVIDER_CAPABILITY_FIELDS = Object.freeze([
  'authenticationMode', 'capabilities', 'costObservation', 'evidenceContract', 'limits',
  'providerId', 'schema',
]);
export const LANE_COST_OBSERVATION_FIELDS = Object.freeze(['basis', 'remainingUnits']);
export const LANE_EVIDENCE_CONTRACT_FIELDS = Object.freeze(['kind', 'startupDeadlineMs']);
export const LANE_LIMITS_FIELDS = Object.freeze(['maxLanes']);

/** The seven structural operations this transition needs. An adapter implements all or none. */
export const LANE_PROVIDER_CAPABILITIES = Object.freeze([
  'CLOSE_PANE', 'OBSERVE', 'OPERATION_MARKER', 'REAP', 'SPAWN', 'STOP', 'TOPOLOGY',
]);
export const REQUIRED_LANE_PROVIDER_CAPABILITIES = LANE_PROVIDER_CAPABILITIES;

/**
 * How an adapter is authorized, described rather than supplied.
 *
 * There is deliberately no member carrying a secret of any kind. `AMBIENT_SESSION` is a seat the
 * host already holds; `EXTERNAL_OPERATOR` is a human-mediated one; `NONE` needs nothing. This
 * module never holds, reads, forwards or answers for any of them.
 */
export const LANE_AUTHENTICATION_MODES = Object.freeze([
  'AMBIENT_SESSION', 'EXTERNAL_OPERATOR', 'NONE',
]);

/**
 * What an adapter knows about its own remaining capacity. `UNOBSERVED` is the honest answer and
 * it never becomes permission: an unobserved quota admits the generation only because nothing was
 * claimed about it, and no paid work is started here under either basis.
 */
export const LANE_COST_BASES = Object.freeze(['DECLARED_UNITS', 'UNOBSERVED']);

/**
 * The two structural proofs of startup. Both are metadata an adapter reports about a process it
 * created. There is no member for observed output, so an adapter cannot offer rendered text as
 * evidence and this module cannot accept it.
 */
export const LANE_EVIDENCE_KINDS = Object.freeze([
  'DECLARED_ARTIFACT_MARKER', 'STRUCTURED_PROCESS_IDENTITY',
]);

export const LANE_GENERATION_RECORD_FIELDS = Object.freeze([
  'actor', 'generationId', 'generationOrdinal', 'operationId', 'plan', 'receipt', 'schema',
  'state', 'workKey',
]);

/** `ACTIVE` exists only beside a published receipt. There is no state meaning "probably fine". */
export const LANE_GENERATION_STATES = Object.freeze([
  'ACTIVE', 'CLAIMED', 'COMPENSATED', 'COMPENSATING', 'IN_FLIGHT',
]);

export const LANE_LAUNCH_RECEIPT_FIELDS = Object.freeze([
  'actor', 'evidenceKind', 'generationId', 'generationOrdinal', 'lanes', 'layoutRevision',
  'operationId', 'policy', 'providerId', 'publishedAt', 'revision', 'schema', 'workKey',
  'workspaceId',
]);
export const LANE_LAUNCH_RECEIPT_LANE_FIELDS = Object.freeze([
  'agentId', 'artifactMarker', 'laneId', 'paneId', 'role', 'subject', 'supervisor', 'surfaceId',
]);

export const LANE_BOOTSTRAP_OUTCOMES = Object.freeze([
  'LAUNCH_RECEIPT_PUBLISHED', 'LAUNCH_RECEIPT_REPLAYED', 'REFUSED',
]);

/** Whether this attempt started the generation or finished one an earlier attempt left open. */
export const LANE_BOOTSTRAP_RECONCILIATIONS = Object.freeze(['NONE', 'RESUMED']);

/** Every answer this transition can give that is not a receipt. Closed, and published. */
export const LANE_BOOTSTRAP_REFUSALS = Object.freeze([
  'ACTIVE_GENERATION_PRESENT',
  'CAPABILITY_INSUFFICIENT',
  'CLAIM_HELD',
  'EXECUTION_HELD',
  'GENERATION_COMPENSATED',
  'CLEANUP_INCOMPLETE',
  'LANE_LIMIT_EXCEEDED',
  'LAYOUT_CHANGED',
  'OBSERVATION_UNAVAILABLE',
  'PANE_ABSENT',
  'PROCESS_ABSENT',
  'QUOTA_INSUFFICIENT',
  'REPORTING_EDGE_MISSING',
  'SPAWN_FAILED',
  'STACKED_SURFACE',
  'STALE_GENERATION',
  'STALE_REVISION',
  'STARTUP_TIMEOUT',
  'SURFACE_MISMATCH',
  'TOPOLOGY_MISMATCH',
]);

const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const REVISION = /^[0-9a-f]{40}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const LAYOUT_REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

const MAX_STARTUP_DEADLINE_MS = 3_600_000;
const MAX_TTL_MS = 86_400_000;
const MAX_RETRY_BUDGET = 8;
const MAX_DECLARED_UNITS = 1_000_000;

export class LaneGenerationError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LaneGenerationError';
    this.code = code;
  }
}

const invalid = (code) => { throw new LaneGenerationError(code); };

/** Ordinal comparison, not `localeCompare`, which is host- and library-version-dependent. */
const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function canonicalLaneJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalLaneJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort(ordinal).map(
      (key) => `${JSON.stringify(key)}:${canonicalLaneJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const digest = (value) => createHash('sha256').update(canonicalLaneJson(value)).digest('hex');

function deepFreeze(value) {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function ownKeys(value, code) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid(code);
  if (Object.getPrototypeOf(value) !== Object.prototype
    && Object.getPrototypeOf(value) !== null) invalid(code);
  return Object.keys(value).sort(ordinal);
}

function assertExactFields(value, fields, code) {
  const keys = ownKeys(value, code);
  if (keys.length !== fields.length || keys.some((key, index) => key !== fields[index])) {
    invalid(code);
  }
  return value;
}

const isBoundedInteger = (value, min, max) => Number.isSafeInteger(value)
  && value >= min && value <= max;

// ---------------------------------------------------------------------------
// gaia-lane-generation-manifest/1
// ---------------------------------------------------------------------------

/**
 * The content revision of a manifest, over every field except the revision itself.
 *
 * A manifest is authoritative because it is published, not because it is well-shaped, so its
 * revision is what makes a later edit visible. Sealing and verifying share this one function; two
 * spellings of the same digest would be two documents that disagree about what they are.
 */
export function laneManifestRevision(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    invalid('MANIFEST_INVALID');
  }
  const body = { ...input };
  delete body.revision;
  return digest(body);
}

function requireLaneSubject(subject) {
  assertExactFields(subject, LANE_SUBJECT_FIELDS, 'MANIFEST_SUBJECT_INVALID');
  if (!LANE_SUBJECT_KINDS.includes(subject.kind)) invalid('MANIFEST_SUBJECT_INVALID');
  if (typeof subject.name !== 'string') invalid('MANIFEST_SUBJECT_INVALID');
  if (subject.kind === 'REVISION' && !REVISION.test(subject.name)) {
    invalid('MANIFEST_SUBJECT_INVALID');
  }
  if (subject.kind === 'BRANCH'
    && (!BRANCH.test(subject.name) || subject.name.includes('..') || subject.name.includes('//'))) {
    invalid('MANIFEST_SUBJECT_INVALID');
  }
  return { kind: subject.kind, name: subject.name };
}

/**
 * The reporting edge is a graph, validated as one.
 *
 * Every lane must reach the operator by following supervisors. A cycle, a dangling supervisor, or
 * a closed group with no operator above it all produce the same operational failure: work that
 * nobody owns, which then disappears as an exited process instead of arriving as a result.
 */
function requireReportingGraph(lanes) {
  const byId = new Map(lanes.map((lane) => [lane.laneId, lane]));
  for (const lane of lanes) {
    if (lane.supervisor === LANE_OPERATOR_SUPERVISOR) continue;
    if (!byId.has(lane.supervisor)) invalid('MANIFEST_REPORTING_EDGE_UNRESOLVED');
    if (lane.supervisor === lane.laneId) invalid('MANIFEST_REPORTING_EDGE_CYCLIC');
  }
  for (const lane of lanes) {
    const seen = new Set([lane.laneId]);
    let current = lane;
    while (current.supervisor !== LANE_OPERATOR_SUPERVISOR) {
      if (seen.has(current.supervisor)) invalid('MANIFEST_REPORTING_EDGE_CYCLIC');
      seen.add(current.supervisor);
      current = byId.get(current.supervisor);
    }
  }
}

export function requireLaneGenerationManifest(input) {
  assertExactFields(input, LANE_MANIFEST_FIELDS, 'MANIFEST_INVALID');
  if (input.schema !== LANE_GENERATION_MANIFEST_SCHEMA) invalid('MANIFEST_SCHEMA_INVALID');
  if (typeof input.repository !== 'string' || !REPOSITORY.test(input.repository)) {
    invalid('MANIFEST_REPOSITORY_INVALID');
  }

  assertExactFields(input.workItem, LANE_WORK_ITEM_FIELDS, 'MANIFEST_WORK_ITEM_INVALID');
  if (!LANE_WORK_ITEM_KINDS.includes(input.workItem.kind)
    || !isBoundedInteger(input.workItem.number, 1, Number.MAX_SAFE_INTEGER)) {
    invalid('MANIFEST_WORK_ITEM_INVALID');
  }

  if (!isSafeLaneIdentity(input.workspaceId)) invalid('MANIFEST_WORKSPACE_INVALID');
  if (!isSafeLaneIdentity(input.providerId)) invalid('MANIFEST_ADAPTER_IDENTITY_INVALID');
  if (!isBoundedInteger(input.generationOrdinal, 1, Number.MAX_SAFE_INTEGER)) {
    invalid('MANIFEST_ORDINAL_INVALID');
  }

  assertExactFields(input.policy, LANE_MANIFEST_POLICY_FIELDS, 'MANIFEST_POLICY_INVALID');
  if (!isBoundedInteger(input.policy.startupDeadlineMs, 1, MAX_STARTUP_DEADLINE_MS)
    || !isBoundedInteger(input.policy.ttlMs, 1, MAX_TTL_MS)
    || !isBoundedInteger(input.policy.retryBudget, 0, MAX_RETRY_BUDGET)
    || !LANE_CLEANUP_POLICIES.includes(input.policy.cleanupPolicy)) {
    invalid('MANIFEST_POLICY_INVALID');
  }

  if (!Array.isArray(input.lanes) || input.lanes.length === 0
    || input.lanes.length > LANE_MANIFEST_MAX_LANES) {
    invalid('MANIFEST_LANES_INVALID');
  }
  const laneIds = new Set();
  const markers = new Set();
  const lanes = input.lanes.map((lane) => {
    assertExactFields(lane, LANE_MANIFEST_LANE_FIELDS, 'MANIFEST_LANE_INVALID');
    if (!isSafeLaneIdentity(lane.laneId) || lane.laneId === LANE_OPERATOR_SUPERVISOR) {
      invalid('MANIFEST_LANE_IDENTITY_INVALID');
    }
    if (laneIds.has(lane.laneId)) invalid('MANIFEST_LANE_IDENTITY_DUPLICATE');
    laneIds.add(lane.laneId);
    if (!LANE_ROLES.includes(lane.role)) invalid('MANIFEST_LANE_ROLE_INVALID');
    if (!isSafeLaneIdentity(lane.artifactMarker)) invalid('MANIFEST_LANE_MARKER_INVALID');
    if (markers.has(lane.artifactMarker)) invalid('MANIFEST_LANE_MARKER_DUPLICATE');
    markers.add(lane.artifactMarker);
    if (lane.supervisor !== LANE_OPERATOR_SUPERVISOR && !isSafeLaneIdentity(lane.supervisor)) {
      invalid('MANIFEST_REPORTING_EDGE_UNRESOLVED');
    }
    return {
      artifactMarker: lane.artifactMarker,
      laneId: lane.laneId,
      role: lane.role,
      subject: requireLaneSubject(lane.subject),
      supervisor: lane.supervisor,
    };
  });
  requireReportingGraph(lanes);

  const normalized = {
    generationOrdinal: input.generationOrdinal,
    lanes,
    policy: {
      cleanupPolicy: input.policy.cleanupPolicy,
      retryBudget: input.policy.retryBudget,
      startupDeadlineMs: input.policy.startupDeadlineMs,
      ttlMs: input.policy.ttlMs,
    },
    providerId: input.providerId,
    repository: input.repository,
    schema: input.schema,
    workItem: { kind: input.workItem.kind, number: input.workItem.number },
    workspaceId: input.workspaceId,
  };
  if (typeof input.revision !== 'string' || !DIGEST.test(input.revision)) {
    invalid('MANIFEST_REVISION_INVALID');
  }
  if (laneManifestRevision(normalized) !== input.revision) invalid('MANIFEST_REVISION_MISMATCH');
  return deepFreeze({ ...normalized, revision: input.revision });
}

/**
 * Work identity, generation identity and operation identity, derived only from content.
 *
 * Work identity outlives every generation of the same work; generation identity changes with the
 * ordinal or with any manifest byte; operation identity is a function of the generation, which is
 * what makes a retry the same operation rather than a second launch.
 */
export function laneGenerationIdentity(input) {
  const manifest = requireLaneGenerationManifest(input);
  const workKey = digest({
    providerId: manifest.providerId,
    repository: manifest.repository,
    schema: WORK_KEY_SCHEMA,
    workItem: manifest.workItem,
    workspaceId: manifest.workspaceId,
  });
  const generationId = digest({
    generationOrdinal: manifest.generationOrdinal,
    manifestRevision: manifest.revision,
    schema: GENERATION_ID_SCHEMA,
    workKey,
  });
  const operationId = digest({
    generationId,
    purpose: 'BOOTSTRAP',
    schema: OPERATION_ID_SCHEMA,
  });
  return Object.freeze({ generationId, operationId, workKey });
}

// ---------------------------------------------------------------------------
// gaia-lane-provider-capability/1
// ---------------------------------------------------------------------------

export function requireLaneProviderCapability(input) {
  assertExactFields(input, LANE_PROVIDER_CAPABILITY_FIELDS, 'CAPABILITY_INVALID');
  if (input.schema !== LANE_PROVIDER_CAPABILITY_SCHEMA) invalid('CAPABILITY_SCHEMA_INVALID');
  if (!isSafeLaneIdentity(input.providerId)) invalid('CAPABILITY_IDENTITY_INVALID');

  if (!Array.isArray(input.capabilities) || input.capabilities.length === 0
    || input.capabilities.length > LANE_PROVIDER_CAPABILITIES.length) {
    invalid('CAPABILITY_SET_INVALID');
  }
  const capabilities = [...input.capabilities].sort(ordinal);
  const unique = new Set(capabilities);
  if (unique.size !== capabilities.length
    || capabilities.some((entry) => !LANE_PROVIDER_CAPABILITIES.includes(entry))) {
    invalid('CAPABILITY_SET_INVALID');
  }

  if (!LANE_AUTHENTICATION_MODES.includes(input.authenticationMode)) {
    invalid('CAPABILITY_AUTHENTICATION_INVALID');
  }

  assertExactFields(input.costObservation, LANE_COST_OBSERVATION_FIELDS, 'CAPABILITY_COST_INVALID');
  if (!LANE_COST_BASES.includes(input.costObservation.basis)) invalid('CAPABILITY_COST_INVALID');
  if (input.costObservation.basis === 'UNOBSERVED'
    ? input.costObservation.remainingUnits !== null
    : !isBoundedInteger(input.costObservation.remainingUnits, 0, MAX_DECLARED_UNITS)) {
    invalid('CAPABILITY_COST_INVALID');
  }

  assertExactFields(input.evidenceContract, LANE_EVIDENCE_CONTRACT_FIELDS, 'CAPABILITY_EVIDENCE_INVALID');
  if (!LANE_EVIDENCE_KINDS.includes(input.evidenceContract.kind)
    || !isBoundedInteger(input.evidenceContract.startupDeadlineMs, 1, MAX_STARTUP_DEADLINE_MS)) {
    invalid('CAPABILITY_EVIDENCE_INVALID');
  }

  assertExactFields(input.limits, LANE_LIMITS_FIELDS, 'CAPABILITY_LIMITS_INVALID');
  if (!isBoundedInteger(input.limits.maxLanes, 1, LANE_MANIFEST_MAX_LANES)) {
    invalid('CAPABILITY_LIMITS_INVALID');
  }

  return deepFreeze({
    authenticationMode: input.authenticationMode,
    capabilities,
    costObservation: {
      basis: input.costObservation.basis,
      remainingUnits: input.costObservation.remainingUnits,
    },
    evidenceContract: {
      kind: input.evidenceContract.kind,
      startupDeadlineMs: input.evidenceContract.startupDeadlineMs,
    },
    limits: { maxLanes: input.limits.maxLanes },
    providerId: input.providerId,
    schema: input.schema,
  });
}

// ---------------------------------------------------------------------------
// gaia-lane-launch-receipt/1
// ---------------------------------------------------------------------------

function sealLaunchReceipt(body) {
  return deepFreeze({ ...body, revision: digest(body) });
}

export function verifyLaneLaunchReceipt(input) {
  assertExactFields(input, LANE_LAUNCH_RECEIPT_FIELDS, 'RECEIPT_INVALID');
  if (input.schema !== LANE_LAUNCH_RECEIPT_SCHEMA) invalid('RECEIPT_SCHEMA_INVALID');
  if (typeof input.revision !== 'string' || !DIGEST.test(input.revision)) {
    invalid('RECEIPT_REVISION_INVALID');
  }
  const body = { ...input };
  delete body.revision;
  if (digest(body) !== input.revision) invalid('RECEIPT_REVISION_MISMATCH');
  return deepFreeze(structuredClone({ ...input }));
}

// ---------------------------------------------------------------------------
// the durable store port, and its deterministic in-memory adapter
// ---------------------------------------------------------------------------

function requireGenerationRecord(record) {
  assertExactFields(record, LANE_GENERATION_RECORD_FIELDS, 'RECORD_INVALID');
  if (record.schema !== LANE_GENERATION_RECORD_SCHEMA) invalid('RECORD_SCHEMA_INVALID');
  if (!LANE_GENERATION_STATES.includes(record.state)) invalid('RECORD_STATE_INVALID');
  for (const field of ['generationId', 'operationId', 'workKey']) {
    if (typeof record[field] !== 'string' || !DIGEST.test(record[field])) invalid('RECORD_INVALID');
  }
  if (!isSafeLaneIdentity(record.actor)) invalid('RECORD_ACTOR_INVALID');
  if (!isBoundedInteger(record.generationOrdinal, 1, Number.MAX_SAFE_INTEGER)) {
    invalid('RECORD_INVALID');
  }
  return record;
}

/**
 * One record per stable work identity, with compare-and-set on its content revision.
 *
 * Deterministic and in-memory: this is the adapter the contract suite runs against, and the same
 * narrow port a durable local or hosted adapter implements later. It is not a durable store and
 * does not pretend to be one.
 */
export function createMemoryLaneGenerationStore() {
  const heads = new Map();
  // This reservation covers one shared in-process adapter, not independent hosts.
  const executing = new Set();
  return {
    async execute(workKey, operation) {
      if (typeof workKey !== 'string' || !DIGEST.test(workKey)) invalid('STORE_KEY_INVALID');
      if (typeof operation !== 'function') invalid('STORE_OPERATION_INVALID');
      if (executing.has(workKey)) return Object.freeze({ executed: false });
      executing.add(workKey);
      try {
        return Object.freeze({ executed: true, result: await operation() });
      } finally {
        executing.delete(workKey);
      }
    },
    async read(workKey) {
      if (typeof workKey !== 'string' || !DIGEST.test(workKey)) invalid('STORE_KEY_INVALID');
      const head = heads.get(workKey);
      return head === undefined ? null : head;
    },
    async commit(workKey, expectedRevision, record) {
      if (typeof workKey !== 'string' || !DIGEST.test(workKey)) invalid('STORE_KEY_INVALID');
      if (typeof expectedRevision !== 'string'
        || (expectedRevision !== 'NONE' && !DIGEST.test(expectedRevision))) {
        invalid('STORE_REVISION_INVALID');
      }
      requireGenerationRecord(record);
      const head = heads.get(workKey) ?? null;
      const current = head === null ? 'NONE' : head.committedRevision;
      if (current !== expectedRevision) {
        return Object.freeze({ stale: true, currentCommittedRevision: current });
      }
      const committed = deepFreeze({
        committedRevision: digest(record),
        record: structuredClone(record),
      });
      heads.set(workKey, committed);
      return Object.freeze({ committed: true, committedRevision: committed.committedRevision });
    },
  };
}

// ---------------------------------------------------------------------------
// the bootstrap transition
// ---------------------------------------------------------------------------

const PORT_FIELDS = Object.freeze(['actor', 'now', 'provider', 'store']);
const PROVIDER_OPERATIONS = Object.freeze([
  'closePane', 'createTopology', 'describe', 'reapSurface', 'snapshot', 'spawn', 'stopAgent',
]);

const NO_COMPENSATION = Object.freeze({
  agentsStopped: 0, incomplete: false, panesClosed: 0, surfacesReaped: 0,
});

function requireBootstrapPorts(input) {
  assertExactFields(input, PORT_FIELDS, 'PORTS_INVALID');
  if (!isSafeLaneIdentity(input.actor)) invalid('PORTS_ACTOR_INVALID');
  if (typeof input.now !== 'function' || !isExactInstant(input.now())) {
    invalid('PORTS_CLOCK_INVALID');
  }
  if (typeof input.store?.read !== 'function' || typeof input.store?.commit !== 'function'
    || typeof input.store?.execute !== 'function') {
    invalid('PORTS_STORE_INVALID');
  }
  for (const operation of PROVIDER_OPERATIONS) {
    if (typeof input.provider?.[operation] !== 'function') invalid('PORTS_ADAPTER_INVALID');
  }
  return input;
}

const refuse = (refusal, subject = null, compensation = NO_COMPENSATION, committedRevision = null) =>
  Object.freeze({
    outcome: 'REFUSED',
    refusal,
    subject,
    compensation: Object.freeze({ ...compensation }),
    committedRevision,
  });

/**
 * Undo exactly what this operation created, and nothing else.
 *
 * The set of targets is derived from the operation marker carried by every resource this
 * operation created, re-observed fresh. That is narrower than the recorded plan rather than wider
 * than it: a pane this operation created but never recorded is still ours, and a pane somebody
 * else created is unreachable from here even when it sits in the same workspace.
 */
async function compensate(provider, workspaceId, operationMarker, plan) {
  const counts = { agentsStopped: 0, incomplete: false, panesClosed: 0, surfacesReaped: 0 };
  let observed = null;
  try {
    observed = await provider.snapshot({ workspaceId });
  } catch {
    counts.incomplete = true;
  }

  const paneIds = [];
  const surfaceIds = [];
  const agentIds = [];
  if (observed !== null) {
    for (const pane of observed.panes ?? []) {
      if (pane.operationMarker !== operationMarker) continue;
      paneIds.push(pane.paneId);
      for (const surfaceId of pane.surfaceIds ?? []) surfaceIds.push(surfaceId);
    }
    for (const agent of observed.agents ?? []) {
      if (agent.operationMarker !== operationMarker) continue;
      agentIds.push(agent.agentId);
      if (!surfaceIds.includes(agent.surfaceId)) surfaceIds.push(agent.surfaceId);
    }
  } else {
    for (const entry of plan?.panes ?? []) {
      paneIds.push(entry.paneId);
      if (entry.agentId !== null) agentIds.push(entry.agentId);
      if (entry.surfaceId !== null) surfaceIds.push(entry.surfaceId);
    }
  }

  for (const agentId of [...agentIds].reverse()) {
    try {
      await provider.stopAgent({ agentId });
      counts.agentsStopped += 1;
    } catch { counts.incomplete = true; }
  }
  for (const surfaceId of [...surfaceIds].reverse()) {
    try {
      await provider.reapSurface({ surfaceId });
      counts.surfacesReaped += 1;
    } catch { counts.incomplete = true; }
  }
  for (const paneId of [...paneIds].reverse()) {
    try {
      await provider.closePane({ paneId });
      counts.panesClosed += 1;
    } catch { counts.incomplete = true; }
  }
  // An acknowledged effect is not proof of removal. Unavailable or incomplete observations
  // retain the cleanup intent so a later invocation can reconcile it without starting work.
  try {
    const after = await provider.snapshot({ workspaceId });
    if (after?.workspaceId !== workspaceId || !Array.isArray(after.panes)
      || !Array.isArray(after.agents)
      || after.panes.some(pane => pane.operationMarker === operationMarker)
      || after.agents.some(agent => agent.operationMarker === operationMarker)) {
      counts.incomplete = true;
    }
  } catch { counts.incomplete = true; }
  return counts;
}

function laneEvidenceIsPresent(agent, lane, evidenceKind) {
  if (evidenceKind === 'STRUCTURED_PROCESS_IDENTITY') {
    return agent.processIdentity !== null && typeof agent.processIdentity === 'object'
      && isBoundedInteger(agent.processIdentity.pid, 1, Number.MAX_SAFE_INTEGER);
  }
  return agent.evidenceMarker === lane.artifactMarker;
}

/**
 * Verify one fresh observation against the whole plan, and name the first thing that is wrong.
 *
 * Every check answers a reproduced failure rather than a hypothetical one, and the order is the
 * order in which a wrong launch becomes visible: the layout first, then the pane, then the
 * surface it holds, then the agent bound to it, then the process, then its startup evidence, then
 * the reporting edge that makes the lane owned by somebody.
 */
function verifyPlan(observed, plan, manifest, capability, operationMarker, observedAt) {
  if (observed.layoutRevision !== plan.layoutRevision) {
    return { refusal: 'LAYOUT_CHANGED', subject: null };
  }
  const deadlineMs = Math.min(
    manifest.policy.startupDeadlineMs, capability.evidenceContract.startupDeadlineMs,
  );
  const panes = new Map((observed.panes ?? []).map((pane) => [pane.paneId, pane]));
  const agents = new Map((observed.agents ?? []).map((agent) => [agent.agentId, agent]));

  for (const [index, lane] of manifest.lanes.entries()) {
    const entry = plan.panes[index];
    const pane = panes.get(entry.paneId);
    if (pane === undefined || pane.operationMarker !== operationMarker) {
      return { refusal: 'PANE_ABSENT', subject: lane.laneId };
    }
    if ((pane.surfaceIds ?? []).length !== 1) {
      return { refusal: 'STACKED_SURFACE', subject: lane.laneId };
    }
    const agent = agents.get(entry.agentId);
    if (agent === undefined || agent.paneId !== entry.paneId
      || agent.surfaceId !== entry.surfaceId || pane.surfaceIds[0] !== entry.surfaceId) {
      return { refusal: 'SURFACE_MISMATCH', subject: lane.laneId };
    }
    if (agent.lifecycle !== 'RUNNING'
      || !laneEvidenceIsPresent(agent, lane, capability.evidenceContract.kind)) {
      return { refusal: 'PROCESS_ABSENT', subject: lane.laneId };
    }
    if (!isExactInstant(agent.startedAt)) {
      return { refusal: 'STARTUP_TIMEOUT', subject: lane.laneId };
    }
    const elapsedMs = Date.parse(observedAt) - Date.parse(agent.startedAt);
    if (elapsedMs < 0 || elapsedMs > deadlineMs) {
      return { refusal: 'STARTUP_TIMEOUT', subject: lane.laneId };
    }
    if (agent.reportingParent !== lane.supervisor) {
      return { refusal: 'REPORTING_EDGE_MISSING', subject: lane.laneId };
    }
  }
  return null;
}

/**
 * Bootstrap one orchestration generation from its authoritative manifest.
 *
 * Returns a published receipt, a replayed prior receipt, or a typed refusal. It never throws for
 * a state it can name: a thrown value here is either a malformed input or an infrastructure
 * failure of an injected port, and neither is laundered into a reassuring result.
 */
export async function bootstrapLaneGeneration(manifestInput, portsInput) {
  const manifest = requireLaneGenerationManifest(manifestInput);
  const ports = requireBootstrapPorts(portsInput);
  const identity = laneGenerationIdentity(manifest);
  const execution = await ports.store.execute(
    identity.workKey, () => executeLaneGeneration(manifest, ports, identity),
  );
  if (execution?.executed === false) return refuse('EXECUTION_HELD');
  if (execution?.executed !== true) invalid('STORE_EXECUTION_INVALID');
  return execution.result;
}

async function executeLaneGeneration(manifest, ports, identity) {
  const { provider, store } = ports;
  const { workspaceId } = manifest;
  const laneCount = manifest.lanes.length;

  // --- admission: what the adapter says about itself, before anything exists ---------------
  let capability;
  try {
    capability = requireLaneProviderCapability(await provider.describe());
  } catch (error) {
    if (error instanceof LaneGenerationError) return refuse('CAPABILITY_INSUFFICIENT');
    throw error;
  }
  if (capability.providerId !== manifest.providerId) {
    return refuse('CAPABILITY_INSUFFICIENT', manifest.providerId);
  }
  for (const required of REQUIRED_LANE_PROVIDER_CAPABILITIES) {
    if (!capability.capabilities.includes(required)) {
      return refuse('CAPABILITY_INSUFFICIENT', required);
    }
  }
  try {
    resolveLaneLimit({ requested: laneCount });
  } catch (error) {
    if (error instanceof LaneLimitError) return refuse('LANE_LIMIT_EXCEEDED');
    throw error;
  }
  if (laneCount > capability.limits.maxLanes) return refuse('LANE_LIMIT_EXCEEDED');
  if (capability.costObservation.basis === 'DECLARED_UNITS'
    && capability.costObservation.remainingUnits < laneCount) {
    return refuse('QUOTA_INSUFFICIENT');
  }

  // --- election: exactly one actor may hold this generation in flight ----------------------
  const head = await store.read(identity.workKey);
  let expectedRevision = 'NONE';
  let resumed = null;
  if (head !== null) {
    const record = head.record;
    expectedRevision = head.committedRevision;
    if (record.generationOrdinal > manifest.generationOrdinal) {
      return refuse('STALE_GENERATION');
    }
    if (record.generationOrdinal === manifest.generationOrdinal) {
      if (record.generationId !== identity.generationId) return refuse('STALE_GENERATION');
      if (record.state === 'ACTIVE') {
        return Object.freeze({
          outcome: 'LAUNCH_RECEIPT_REPLAYED',
          receipt: verifyLaneLaunchReceipt(record.receipt),
          committedRevision: head.committedRevision,
        });
      }
      if (record.state === 'COMPENSATED') return refuse('GENERATION_COMPENSATED');
      if (record.actor !== ports.actor) return refuse('CLAIM_HELD');
      resumed = record;
    } else if (record.state === 'ACTIVE') {
      return refuse('ACTIVE_GENERATION_PRESENT');
    } else if (record.state !== 'COMPENSATED') {
      return refuse('CLAIM_HELD');
    }
  }

  const recordBody = (state, plan, receipt) => ({
    actor: ports.actor,
    generationId: identity.generationId,
    generationOrdinal: manifest.generationOrdinal,
    operationId: identity.operationId,
    plan,
    receipt,
    schema: LANE_GENERATION_RECORD_SCHEMA,
    state,
    workKey: identity.workKey,
  });

  if (resumed === null) {
    const claimed = await store.commit(
      identity.workKey, expectedRevision, recordBody('CLAIMED', null, null),
    );
    if (claimed.stale === true) return refuse('STALE_REVISION');
    expectedRevision = claimed.committedRevision;
  }

  const marker = identity.operationId;
  // The store may hand its record back frozen, and the plan is filled in below, so it must be
  // this attempt's own copy rather than an alias of whatever the store keeps.
  let plan = resumed?.plan == null ? null : structuredClone(resumed.plan);

  const abort = async (refusal, subject) => {
    const intent = await store.commit(
      identity.workKey, expectedRevision, recordBody('COMPENSATING', plan, null),
    );
    if (intent.stale === true) return refuse('STALE_REVISION');
    expectedRevision = intent.committedRevision;
    const compensation = await compensate(provider, workspaceId, marker, plan);
    if (compensation.incomplete) {
      return refuse('CLEANUP_INCOMPLETE', subject, compensation, expectedRevision);
    }
    const committed = await store.commit(
      identity.workKey, expectedRevision, recordBody('COMPENSATED', plan, null),
    );
    if (committed.stale === true) return refuse('STALE_REVISION', subject, compensation);
    return refuse(refusal, subject, compensation, committed.committedRevision ?? null);
  };

  if (resumed?.state === 'COMPENSATING') return abort('GENERATION_COMPENSATED', null);

  // --- topology: the complete empty grid, before any process exists ------------------------
  const before = await provider.snapshot({ workspaceId });
  if (plan === null) {
    const marked = (before.panes ?? []).filter((pane) => pane.operationMarker === marker);
    if (marked.length > 0) {
      // Panes exist for this operation but no plan records which lane each one belongs to, so
      // the mapping is unknowable rather than guessable. They are ours, so they are undone.
      return abort('TOPOLOGY_MISMATCH', null);
    }
    const topology = await provider.createTopology({
      generationId: identity.generationId,
      laneCount,
      operationMarker: marker,
      workspaceId,
    });
    const paneIds = topology?.paneIds;
    if (!Array.isArray(paneIds) || paneIds.length !== laneCount
      || new Set(paneIds).size !== laneCount || !paneIds.every(isSafeLaneIdentity)
      || typeof topology.layoutRevision !== 'string'
      || !LAYOUT_REVISION.test(topology.layoutRevision)) {
      return abort('TOPOLOGY_MISMATCH', null);
    }
    plan = {
      layoutRevision: topology.layoutRevision,
      panes: manifest.lanes.map((lane, index) => ({
        agentId: null, laneId: lane.laneId, paneId: paneIds[index], surfaceId: null,
      })),
      workspaceId,
    };
    const recorded = await store.commit(
      identity.workKey, expectedRevision, recordBody('IN_FLIGHT', plan, null),
    );
    if (recorded.stale === true) return abort('STALE_REVISION', null);
    expectedRevision = recorded.committedRevision;
  }

  // --- one process per pane, adopting rather than duplicating ------------------------------
  let spawnedAny = false;
  for (const [index, lane] of manifest.lanes.entries()) {
    const entry = plan.panes[index];
    if (entry.agentId !== null) continue;
    const adopted = (before.agents ?? []).find(
      (agent) => agent.operationMarker === marker && agent.paneId === entry.paneId,
    );
    if (adopted !== undefined) {
      entry.agentId = adopted.agentId;
      entry.surfaceId = adopted.surfaceId;
      continue;
    }
    let started;
    try {
      started = await provider.spawn({
        artifactMarker: lane.artifactMarker,
        laneId: lane.laneId,
        operationMarker: marker,
        paneId: entry.paneId,
        role: lane.role,
        subject: lane.subject,
        supervisor: lane.supervisor,
      });
    } catch {
      return abort('SPAWN_FAILED', lane.laneId);
    }
    if (started === null || typeof started !== 'object'
      || !isSafeLaneIdentity(started.agentId) || !isSafeLaneIdentity(started.surfaceId)) {
      return abort('SPAWN_FAILED', lane.laneId);
    }
    if (started.paneId !== entry.paneId) return abort('SURFACE_MISMATCH', lane.laneId);
    entry.agentId = started.agentId;
    entry.surfaceId = started.surfaceId;
    spawnedAny = true;
  }
  if (spawnedAny) {
    const recorded = await store.commit(
      identity.workKey, expectedRevision, recordBody('IN_FLIGHT', plan, null),
    );
    if (recorded.stale === true) return abort('STALE_REVISION', null);
    expectedRevision = recorded.committedRevision;
  }

  // --- the linearization point: one fresh observation decides everything -------------------
  // Every process exists by now, so a host that cannot be observed is compensated, not thrown.
  let observedAt;
  let observed;
  try {
    observedAt = ports.now();
    observed = await provider.snapshot({ workspaceId });
  } catch {
    return abort('OBSERVATION_UNAVAILABLE', null);
  }
  if (!isExactInstant(observedAt) || observed === null || typeof observed !== 'object') {
    return abort('OBSERVATION_UNAVAILABLE', null);
  }
  const failure = verifyPlan(observed, plan, manifest, capability, marker, observedAt);
  if (failure !== null) return abort(failure.refusal, failure.subject);

  const receipt = sealLaunchReceipt({
    actor: ports.actor,
    evidenceKind: capability.evidenceContract.kind,
    generationId: identity.generationId,
    generationOrdinal: manifest.generationOrdinal,
    lanes: manifest.lanes.map((lane, index) => ({
      agentId: plan.panes[index].agentId,
      artifactMarker: lane.artifactMarker,
      laneId: lane.laneId,
      paneId: plan.panes[index].paneId,
      role: lane.role,
      subject: { kind: lane.subject.kind, name: lane.subject.name },
      supervisor: lane.supervisor,
      surfaceId: plan.panes[index].surfaceId,
    })),
    layoutRevision: plan.layoutRevision,
    operationId: identity.operationId,
    policy: { ...manifest.policy },
    providerId: manifest.providerId,
    publishedAt: observedAt,
    schema: LANE_LAUNCH_RECEIPT_SCHEMA,
    workKey: identity.workKey,
    workspaceId,
  });

  const published = await store.commit(
    identity.workKey, expectedRevision, recordBody('ACTIVE', plan, receipt),
  );
  if (published.stale === true) return abort('STALE_REVISION', null);

  return Object.freeze({
    outcome: 'LAUNCH_RECEIPT_PUBLISHED',
    receipt,
    committedRevision: published.committedRevision,
    reconciliation: resumed === null ? 'NONE' : 'RESUMED',
  });
}
