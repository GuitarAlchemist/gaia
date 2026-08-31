/**
 * first-evidence-draft-pr-delivery.mjs — the durable half of `gaia-first-evidence-draft-pr/1`.
 *
 * This Adapter owns exactly one append-only JSONL file and one lock directory, and performs
 * lock -> re-read -> compare-and-swap -> append -> fsync, in the shape the drain ledger and the
 * telemetry log already use. It is a SEPARATE ledger with its own machine, deliberately: adding a
 * state to either existing machine would change that machine's `rulesRevision` and make every
 * receipt already on disk unreadable, which the rollback clause of the design forbids.
 *
 * THE PROTOCOL
 * ------------
 *   plan -> durable INTENT -> authority -> one effect -> exact reconciliation -> one terminal
 *
 * The `INTENT` is durable BEFORE the request, so a crash between the request and its response is
 * distinguishable from a request that was never made. A later attempt that finds a prior `INTENT`
 * asks GitHub what actually happened before it decides; it never blindly re-creates.
 *
 * THE LINEARIZATION POINT, AND WHY IT IS NOT A PROMISE OR A BARRIER
 * ----------------------------------------------------------------
 * Exactly one durable act orders this operation: the compare-and-swap append of the `INTENT`
 * against the ledger head the caller observed. Two callers that both read the same head cannot
 * both land, because each seals its own ownership token into its claim, so their two claims are
 * different records and the second one is a lost update rather than a replay. The loser performs
 * no effect and writes nothing at all. A process-local promise or a single-process barrier cannot
 * carry this: the callers are separate operating-system processes, and the only thing they share
 * is the file.
 *
 * OWNERSHIP IS BOUNDED, BECAUSE A DEAD OWNER CANNOT RELEASE ANYTHING
 * -----------------------------------------------------------------
 * A live caller and a process that was killed mid-delivery leave the SAME record: an `INTENT` with
 * no terminal. What separates them is the bounded lease sealed into the claim. An unexpired lease
 * is a live owner and a second caller fails closed rather than racing it; an expired one is an
 * orphan, and the operation is reconciled against GitHub by exact repository, base, head and
 * embedded operation identity instead of being wedged forever on a claim nobody holds.
 *
 * WHAT THIS MODULE CANNOT DO
 * --------------------------
 * It holds no GitHub client. The effect port is injected and has exactly two methods, a query and
 * a create. There is no method here that could publish a branch, promote a Draft to ready, or
 * integrate anything, so Draft visibility cannot become approval by accident.
 *
 * THE SENSOR
 * ----------
 * `measureFirstEvidenceCommit` asks git only about commits: `rev-parse`, `rev-list --count` and
 * `merge-base --is-ancestor`. It never asks about the working tree or the index. That is the whole
 * enforcement for "an uncommitted diff is not evidence": the sensor cannot see a dirty tree,
 * because it never asks. This matters because the pre-existing candidate path measures exactly the
 * opposite thing — a working-tree diff whose recorded head is the base commit.
 */

import { execFileSync } from 'node:child_process';
import {
  appendFileSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, rmSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';

import {
  CorruptLogError, LOCK_RM_OPTIONS, LOCK_STALE_MS, LOCK_TIMEOUT_MS, LockTimeoutError,
  parseEventLog,
} from './event-log.mjs';
import {
  DRAFT_PR_TRANSITIONS,
  FirstEvidenceDraftPrError,
  firstEvidenceOperationIdentity,
  planFirstEvidenceDraftPr,
  requireFirstEvidenceObservation,
} from './first-evidence-draft-pr.mjs';
import { isExactInstant } from './local-lane-observation.mjs';

export const FIRST_EVIDENCE_DELIVERY_SCHEMA = 'gaia-first-evidence-draft-pr-delivery/1';
export const FIRST_EVIDENCE_LEDGER_SCHEMA = 'gaia-first-evidence-draft-pr-ledger/1';
export const FIRST_EVIDENCE_LEDGER_RECORD_SCHEMA = 'gaia-first-evidence-draft-pr-ledger-record/1';
export const FIRST_EVIDENCE_PROJECTION_SCHEMA = 'gaia-first-evidence-draft-pr-projection/1';

export const FIRST_EVIDENCE_TRANSITION_FIELDS = Object.freeze([
  'transition', 'operationIdentity', 'owner', 'leaseExpiresAt', 'repository', 'task', 'baseBranch',
  'baseOid', 'headBranch', 'headBranchGeneration', 'evidenceHeadOid', 'run', 'sourceRevision',
  'recordedAt', 'pullRequest', 'refusal', 'revision',
]);

/**
 * How long a claim is honoured before it is treated as an orphan. Closed hexadecimal ownership
 * tokens carry no host name, process id or path, so nothing about the machine that made a claim
 * can reach the durable record; the lease is the only liveness signal, and it is bounded.
 */
export const FIRST_EVIDENCE_LEASE_MS = 120_000;

const MAX_LEASE_MS = 3_600_000;
const OWNER = /^[a-f0-9]{32}$/u;

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

/**
 * The rules this ledger is bound to. Hashed into every record, so a future change to the closed
 * vocabularies is detected on read instead of silently reinterpreting old records.
 */
const MACHINE_RULES = Object.freeze({
  transitions: DRAFT_PR_TRANSITIONS,
  transitionFields: FIRST_EVIDENCE_TRANSITION_FIELDS,
});

export const FIRST_EVIDENCE_DELIVERY_MACHINE = Object.freeze({
  machineId: 'gaia-first-evidence-draft-pr',
  machineVersion: 1,
  rulesRevision: sha256(MACHINE_RULES),
});

export const EMPTY_FIRST_EVIDENCE_LEDGER_REVISION = sha256({
  schema: FIRST_EVIDENCE_LEDGER_SCHEMA,
  machine: FIRST_EVIDENCE_DELIVERY_MACHINE,
  records: [],
});

export class FirstEvidenceDeliveryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'FirstEvidenceDeliveryError';
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new FirstEvidenceDeliveryError(code, message);
};

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function requireDirectory(directory) {
  if (typeof directory !== 'string' || directory.trim() !== directory || directory.length === 0) {
    fail('LedgerPathInvalid', 'directory must be explicit');
  }
  return resolve(directory);
}

function requireRevision(value, field) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) {
    fail('LedgerRequestInvalid', `${field} must be a SHA-256`);
  }
  return value;
}

export function firstEvidenceLedgerPath(directory) {
  return join(requireDirectory(directory), 'first-evidence-draft-pr.jsonl');
}

export function firstEvidenceLedgerLockPath(directory) {
  return join(requireDirectory(directory), 'first-evidence-draft-pr.lock');
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLedgerLock(directory, operation, {
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
} = {}) {
  const root = requireDirectory(directory);
  const lock = firstEvidenceLedgerLockPath(root);
  mkdirSync(root, { recursive: true });
  const deadline = Date.now() + timeoutMs;
  let held = false;
  while (!held) {
    try {
      mkdirSync(lock);
      held = true;
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      if (Date.now() >= deadline) {
        throw new LockTimeoutError(
          `could not acquire ${lock} within ${timeoutMs}ms; refusing to access the first-evidence `
          + `ledger without its lock (fail closed; stale threshold ${staleMs}ms)`,
        );
      }
      sleepSync(15);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lock, LOCK_RM_OPTIONS);
  }
}

/** Seal one transition. The caller supplies every field except the digest over them. */
function sealTransition(body) {
  const supplied = Object.keys(body);
  const expected = FIRST_EVIDENCE_TRANSITION_FIELDS.filter((field) => field !== 'revision');
  if (supplied.length !== expected.length || supplied.some((key) => !expected.includes(key))) {
    fail('TransitionInvalid', 'a transition must contain exactly its schema fields');
  }
  if (!DRAFT_PR_TRANSITIONS.includes(body.transition)) {
    fail('TransitionInvalid', 'unknown transition verb');
  }
  if (!isExactInstant(body.recordedAt)) {
    fail('TransitionInvalid', 'transition.recordedAt must be an exact instant');
  }
  if (typeof body.owner !== 'string' || !OWNER.test(body.owner)) {
    fail('TransitionInvalid', 'transition.owner must be a closed ownership token');
  }
  if (body.leaseExpiresAt !== null && !isExactInstant(body.leaseExpiresAt)) {
    fail('TransitionInvalid', 'transition.leaseExpiresAt must be an exact instant or null');
  }
  requireRevision(body.operationIdentity, 'transition.operationIdentity');
  return deepFreeze({ ...body, revision: sha256(body) });
}

function verifyRecord(record, expectedOrdinal, expectedPreviousRevision) {
  if (!record || record.type !== 'first-evidence-draft-pr.transition'
      || record.schema !== FIRST_EVIDENCE_LEDGER_RECORD_SCHEMA) {
    throw new CorruptLogError('first-evidence ledger contains an unsupported record');
  }
  const { revision, ...body } = record;
  if (typeof revision !== 'string' || !/^[a-f0-9]{64}$/u.test(revision)
      || revision !== sha256(body)) {
    throw new CorruptLogError('first-evidence ledger record revision does not match its content');
  }
  if (record.machineId !== FIRST_EVIDENCE_DELIVERY_MACHINE.machineId
      || record.machineVersion !== FIRST_EVIDENCE_DELIVERY_MACHINE.machineVersion
      || record.rulesRevision !== FIRST_EVIDENCE_DELIVERY_MACHINE.rulesRevision) {
    throw new CorruptLogError('first-evidence ledger record binds an unsupported machine');
  }
  if (record.ordinal !== expectedOrdinal
      || record.previousRevision !== expectedPreviousRevision) {
    throw new CorruptLogError('first-evidence ledger record chain is not contiguous');
  }
  const { revision: transitionRevision, ...transitionBody } = record.transition ?? {};
  if (transitionRevision !== sha256(transitionBody)) {
    throw new CorruptLogError('first-evidence ledger record holds an altered transition');
  }
  return record;
}

function readRecordsUnlocked(directory) {
  const path = firstEvidenceLedgerPath(directory);
  if (!existsSync(path)) return [];
  const records = parseEventLog(readFileSync(path, 'utf8'), { source: path });
  let previousRevision = null;
  for (const [ordinal, record] of records.entries()) {
    verifyRecord(record, ordinal, previousRevision);
    previousRevision = record.revision;
  }
  return records;
}

function snapshot(records) {
  return deepFreeze({
    schema: FIRST_EVIDENCE_LEDGER_SCHEMA,
    machine: FIRST_EVIDENCE_DELIVERY_MACHINE,
    revision: records.at(-1)?.revision ?? EMPTY_FIRST_EVIDENCE_LEDGER_REVISION,
    count: records.length,
    transitions: records.map(({ transition }) => transition),
  });
}

export function readFirstEvidenceLedger({ directory, lockOptions } = {}) {
  const root = requireDirectory(directory);
  if (!existsSync(root)) return snapshot([]);
  return withLedgerLock(root, () => snapshot(readRecordsUnlocked(root)), lockOptions);
}

function appendRecord(directory, record) {
  const path = firstEvidenceLedgerPath(directory);
  appendFileSync(path, `${canonicalJson(record)}\n`, 'utf8');
  const descriptor = openSync(path, 'r+');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

/**
 * Append one transition under compare-and-swap. This is the linearization point.
 *
 * A retried caller legitimately holds a stale head, so replaying the identical content-addressed
 * transition is a no-op — but only from the head that caller observed when it wrote the record it
 * is replaying. A caller that never observed that record is not retrying, it is a lost update, and
 * it is refused rather than absorbed. That distinction is the whole difference between one Draft
 * pull request and two.
 */
export function appendFirstEvidenceTransition({
  directory, transition, expectedLedgerRevision, lockOptions,
}) {
  const root = requireDirectory(directory);
  requireRevision(expectedLedgerRevision, 'expectedLedgerRevision');
  const sealed = sealTransition(transition);
  return withLedgerLock(root, () => {
    const records = readRecordsUnlocked(root);
    const before = snapshot(records);
    const divergent = before.revision !== expectedLedgerRevision;
    const replayedAt = records.findIndex(
      (entry) => entry.transition.revision === sealed.revision,
    );
    const observedWhenWritten = replayedAt <= 0
      ? EMPTY_FIRST_EVIDENCE_LEDGER_REVISION
      : records[replayedAt - 1].revision;
    if (divergent
        && (replayedAt === -1 || observedWhenWritten !== expectedLedgerRevision)) {
      fail('LedgerCasMismatch', 'the first-evidence ledger changed since the caller observed it');
    }
    if (replayedAt !== -1) {
      return deepFreeze({ duplicate: true, ledger: before });
    }
    const body = {
      type: 'first-evidence-draft-pr.transition',
      schema: FIRST_EVIDENCE_LEDGER_RECORD_SCHEMA,
      ...FIRST_EVIDENCE_DELIVERY_MACHINE,
      ordinal: records.length,
      previousRevision: records.at(-1)?.revision ?? null,
      transition: sealed,
    };
    const record = deepFreeze({ ...body, revision: sha256(body) });
    appendRecord(root, record);
    return deepFreeze({ duplicate: false, ledger: snapshot([...records, record]) });
  }, lockOptions);
}

/** Replay the durable ledger into one passive projection. Read-only at every seam. */
export function projectFirstEvidenceLedgerSnapshot(ledger) {
  if (!ledger || ledger.schema !== FIRST_EVIDENCE_LEDGER_SCHEMA
      || !Array.isArray(ledger.transitions)) {
    fail('LedgerSnapshotInvalid', 'a verified first-evidence ledger snapshot is required');
  }
  const byOperation = new Map();
  for (const transition of ledger.transitions) {
    const current = byOperation.get(transition.operationIdentity) ?? {
      operationIdentity: transition.operationIdentity,
      repository: transition.repository,
      task: transition.task,
      headBranch: transition.headBranch,
      headBranchGeneration: transition.headBranchGeneration,
      evidenceHeadOid: transition.evidenceHeadOid,
      intents: 0,
      outcome: 'INTENT',
      pullRequest: null,
      refusal: null,
      recordedAt: transition.recordedAt,
    };
    byOperation.set(transition.operationIdentity, {
      ...current,
      intents: current.intents + (transition.transition === 'INTENT' ? 1 : 0),
      outcome: transition.transition === 'INTENT' ? current.outcome : transition.transition,
      pullRequest: transition.pullRequest ?? current.pullRequest,
      refusal: transition.transition === 'INTENT' ? current.refusal : transition.refusal,
      recordedAt: transition.recordedAt,
    });
  }
  return deepFreeze({
    schema: FIRST_EVIDENCE_PROJECTION_SCHEMA,
    machine: FIRST_EVIDENCE_DELIVERY_MACHINE,
    ledgerRevision: ledger.revision,
    projection: { operations: [...byOperation.values()] },
    effect: 'NONE',
    authority: 'NONE',
  });
}

export function projectFirstEvidenceDraftPr({ directory, lockOptions } = {}) {
  return projectFirstEvidenceLedgerSnapshot(readFirstEvidenceLedger({ directory, lockOptions }));
}

const REFUSAL_TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/u;

/** An error code becomes a token, never prose. An unknown shape becomes `UNKNOWN`. */
function refusalToken(value) {
  const candidate = String(value ?? '')
    .replace(/([a-z0-9])([A-Z])/gu, '$1_$2')
    .toUpperCase();
  return REFUSAL_TOKEN.test(candidate) ? candidate : 'UNKNOWN';
}

const transitionBody = ({
  verb, observed, operationIdentity, owner, leaseExpiresAt, recordedAt, pullRequest, refusal,
}) => ({
  transition: verb,
  operationIdentity,
  owner,
  leaseExpiresAt,
  repository: observed.repository,
  task: observed.task,
  baseBranch: observed.baseBranch,
  baseOid: observed.baseOid,
  headBranch: observed.headBranch,
  headBranchGeneration: observed.headBranchGeneration,
  evidenceHeadOid: observed.evidence?.headOid ?? observed.baseOid,
  run: observed.run,
  sourceRevision: observed.sourceRevision,
  recordedAt,
  pullRequest,
  refusal,
});

const boundPullRequest = (value) => ({
  number: value.number, url: value.url, headOid: value.headOid,
});

/**
 * Does this candidate pull request bind exactly this operation? Anything less exact is a refusal;
 * "probably ours" is how one operation adopts another operation's pull request.
 */
const bindsOperation = (candidate, operationIdentity, observed) => candidate
  && candidate.operationIdentity === operationIdentity
  && candidate.headOid === observed.evidence.headOid
  && candidate.baseBranch === observed.baseBranch
  && candidate.isDraft === true
  && candidate.state === 'OPEN';

const result = (body) => deepFreeze({ ...body, revision: sha256(body) });

/**
 * Create or reuse exactly one Draft pull request for the first evidence-bearing commit.
 *
 * Only `MISSING_DRAFT` reaches an effect. Everything else returns a reading and writes nothing,
 * so a wrapper start, a heartbeat, an empty branch or an uncommitted change cannot reach GitHub
 * even if a caller asks this function to run on every tick.
 */
export async function deliverFirstEvidenceDraftPr({
  directory, observation, grant, authority, effects, now = () => new Date(),
  owner = randomBytes(16).toString('hex'), leaseMs = FIRST_EVIDENCE_LEASE_MS, lockOptions,
}) {
  const root = requireDirectory(directory);
  if (typeof owner !== 'string' || !OWNER.test(owner)) {
    fail('LedgerRequestInvalid', 'owner must be a closed ownership token');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    fail('LedgerRequestInvalid', 'leaseMs must be a bounded positive count of milliseconds');
  }
  const observed = requireFirstEvidenceObservation(observation);
  const decided = planFirstEvidenceDraftPr({ observation });
  const recordedAt = now().toISOString();
  const leaseExpiresAt = new Date(Date.parse(recordedAt) + leaseMs).toISOString();

  const reading = (outcome, pullRequest, effect, consumed, ledgerRevisionBefore, ledgerRevisionAfter) => result({
    schema: FIRST_EVIDENCE_DELIVERY_SCHEMA,
    state: decided.state,
    action: decided.action,
    outcome,
    refusal: decided.refusal,
    operationIdentity: decided.operationIdentity,
    pullRequest,
    ledgerRevisionBefore,
    ledgerRevisionAfter,
    effect,
    authority: consumed,
  });

  const record = ({
    transition, expectedLedgerRevision, pullRequest = null, refusal = null, lease = null,
  }) => appendFirstEvidenceTransition({
    directory: root,
    transition: transitionBody({
      verb: transition,
      observed,
      operationIdentity: decided.operationIdentity,
      owner,
      leaseExpiresAt: lease,
      recordedAt,
      pullRequest,
      refusal,
    }),
    expectedLedgerRevision,
    lockOptions,
  });

  if (decided.action === 'NONE') {
    const before = readFirstEvidenceLedger({ directory: root, lockOptions });
    const mine = before.transitions.filter(
      (entry) => entry.operationIdentity === decided.operationIdentity,
    );
    const settled = mine.find(
      (entry) => entry.transition === 'CREATED' || entry.transition === 'REUSED',
    );
    if (settled) {
      return reading('REUSED', settled.pullRequest, 'NONE', 'NONE', before.revision, before.revision);
    }
    // The next complete provider observation may already carry the Draft whose create response
    // was lost. That exact identity-bound observation is stronger evidence than retrying a query:
    // adopt it durably and perform no authority consumption or provider effect.
    const terminated = mine.some(({ transition }) => transition === 'REFUSED');
    const claims = mine.filter(({ transition }) => transition === 'INTENT');
    const heldByLiveOwner = !terminated && claims.some(
      (entry) => entry.owner !== owner
        && entry.leaseExpiresAt !== null
        && Date.parse(entry.leaseExpiresAt) > Date.parse(recordedAt),
    );
    if (heldByLiveOwner) {
      fail('DeliveryInFlight', 'a live owner holds an unexpired claim for this operation');
    }
    if (decided.state === 'DRAFT_OPEN' && claims.length > 0) {
      const bound = boundPullRequest(decided.pullRequest);
      const after = record({
        transition: 'REUSED', expectedLedgerRevision: before.revision, pullRequest: bound,
      });
      return reading('REUSED', bound, 'NONE', 'NONE', before.revision, after.ledger.revision);
    }
    return reading(
      'NONE',
      decided.pullRequest === null ? null : boundPullRequest(decided.pullRequest),
      'NONE', 'NONE', before.revision, before.revision,
    );
  }

  /**
   * Claim this operation durably, under the compare-and-swap that orders it. A caller whose
   * observed head moved under it loses here — before any authority is consumed and before any
   * request is made — and writes nothing at all.
   */
  const recordIntent = (expectedLedgerRevision) => {
    try {
      return record({ transition: 'INTENT', expectedLedgerRevision, lease: leaseExpiresAt });
    } catch (error) {
      if (error instanceof FirstEvidenceDeliveryError && error.code === 'LedgerCasMismatch') {
        fail(
          'DeliveryRaceLost',
          'another caller ordered this operation first; this caller performs no effect',
        );
      }
      throw error;
    }
  };

  if (decided.action === 'REFUSE') {
    const before = readFirstEvidenceLedger({ directory: root, lockOptions }).revision;
    record({
      transition: 'REFUSED', expectedLedgerRevision: before,
      refusal: refusalToken(decided.refusal),
    });
    fail('PlanRefused', 'the observed drafts do not identify exactly one bound Draft pull request');
  }

  if (!effects || typeof effects.findDraftPullRequest !== 'function'
      || typeof effects.openDraftPullRequest !== 'function'
      || !authority || typeof authority.consume !== 'function') {
    fail('InvalidAdapter', 'the closed Draft effect port and an authority are required');
  }

  const before = readFirstEvidenceLedger({ directory: root, lockOptions });
  const mine = before.transitions.filter(
    (entry) => entry.operationIdentity === decided.operationIdentity,
  );
  const settled = mine.find(
    (entry) => entry.transition === 'CREATED' || entry.transition === 'REUSED',
  );
  if (settled) {
    return reading('REUSED', settled.pullRequest, 'NONE', 'NONE', before.revision, before.revision);
  }
  const terminated = mine.some((entry) => entry.transition === 'REFUSED');
  const claims = mine.filter((entry) => entry.transition === 'INTENT');
  // A live owner and a process that was killed mid-delivery leave the same record. The bounded
  // lease is the only thing that separates them, because a dead owner releases nothing: its claim
  // simply runs out. Treating every unterminated claim as live is what wedges an operation
  // permanently after one crash, and never asks GitHub what actually happened. A caller's own
  // claim is never a stranger's, so resuming one's own interrupted delivery reconciles rather
  // than deadlocking against itself.
  const heldByLiveOwner = !terminated && claims.some(
    (entry) => entry.owner !== owner
      && entry.leaseExpiresAt !== null
      && Date.parse(entry.leaseExpiresAt) > Date.parse(recordedAt),
  );
  if (heldByLiveOwner) {
    fail('DeliveryInFlight', 'a live owner holds an unexpired claim for this operation');
  }
  const reconcilable = claims.length > 0;

  // A prior attempt reached, or may have reached, GitHub. Ask what is actually there before
  // deciding: a lost response is indistinguishable from a request that never arrived, and only
  // GitHub can tell the two apart.
  if (reconcilable) {
    let found;
    try {
      found = await effects.findDraftPullRequest({
        repository: observed.repository,
        baseBranch: observed.baseBranch,
        headBranch: observed.headBranch,
        operationIdentity: decided.operationIdentity,
      });
    } catch {
      fail('ReconciliationFailed', 'reconciliation failed without exposing provider diagnostics');
    }
    if (!Array.isArray(found)) {
      fail('ReconciliationFailed', 'reconciliation did not return a list');
    }
    if (found.length > 1) {
      fail('ReconciliationAmbiguous', 'more than one pull request answers this exact query');
    }
    if (found.length === 1) {
      if (!bindsOperation(found[0], decided.operationIdentity, observed)) {
        fail('ReconciliationConflict', 'the existing pull request does not bind this operation');
      }
      const bound = boundPullRequest(found[0]);
      const after = record({
        transition: 'REUSED', expectedLedgerRevision: before.revision, pullRequest: bound,
      });
      return reading('REUSED', bound, 'NONE', 'NONE', before.revision, after.ledger.revision);
    }
  }

  // Durable BEFORE the request, and ordered by the compare-and-swap inside it. A crash from here
  // on leaves a bounded claim the branch above reconciles once its lease runs out.
  const withIntent = recordIntent(before.revision);
  const headAfterIntent = withIntent.ledger.revision;

  const abandon = (code, message) => {
    record({
      transition: 'REFUSED', expectedLedgerRevision: headAfterIntent, refusal: refusalToken(code),
    });
    fail(code, message);
  };

  let authorization;
  try {
    authorization = await authority.consume({
      grant,
      intent: {
        intentRevision: withIntent.ledger.transitions.at(-1).revision,
        action: 'OPEN_DRAFT_PULL_REQUEST',
        repository: observed.repository,
        itemKind: observed.task.kind,
        itemId: `${observed.task.kind.toLowerCase()}-${observed.task.number}`,
        itemNumber: observed.task.number,
        snapshotRevision: observed.sourceRevision,
      },
    });
  } catch {
    abandon('AuthorityRefused', 'authority refused without exposing diagnostics');
  }
  if (!authorization || authorization.status !== 'AUTHORIZED') {
    abandon('AuthorityRefused', 'authority did not authorize this exact operation');
  }

  let opened;
  try {
    opened = await effects.openDraftPullRequest({
      repository: observed.repository,
      baseBranch: observed.baseBranch,
      headBranch: observed.headBranch,
      commitOid: observed.evidence.headOid,
      operationIdentity: decided.operationIdentity,
      idempotencyKey: sha256({
        operationIdentity: decided.operationIdentity, grantId: authorization.grantId,
      }),
    });
  } catch {
    abandon('EffectFailed', 'the Draft effect failed without exposing provider diagnostics');
  }
  if (!bindsOperation(opened, decided.operationIdentity, observed)) {
    abandon('ProviderResultInvalid', 'the returned pull request does not bind this operation');
  }

  const bound = boundPullRequest(opened);
  const after = record({
    transition: 'CREATED', expectedLedgerRevision: headAfterIntent, pullRequest: bound,
  });
  return reading(
    'CREATED', bound, 'GITHUB_DRAFT_PULL_REQUEST', 'CONSUMED',
    before.revision, after.ledger.revision,
  );
}

function defaultGitRun(worktree, args) {
  return execFileSync('git', args, {
    cwd: worktree, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Measure whether a task branch carries a first evidence-bearing commit.
 *
 * Every question asked here is about the commit graph. The working tree and the index are never
 * consulted, so a staged or unstaged change cannot move any value this function returns.
 */
export function measureFirstEvidenceCommit({
  worktree, baseRef, headRef, observedAt, run = defaultGitRun,
}) {
  if (!isExactInstant(observedAt)) {
    fail('SensorRequestInvalid', 'observedAt must be an exact instant');
  }
  const git = (...args) => String(run(worktree, args) ?? '').trim();
  const oid = (value, field) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
      fail('SensorResultInvalid', `${field} is not a Git object id`);
    }
    return value;
  };
  const headOid = oid(git('rev-parse', headRef), 'headRef');
  const baseOid = oid(git('rev-parse', baseRef), 'baseRef');

  let descends = true;
  try {
    run(worktree, ['merge-base', '--is-ancestor', baseOid, headOid]);
  } catch {
    descends = false;
  }
  if (!descends) {
    fail(
      'EvidenceNotDescendedFromBase',
      'the measured head does not descend from the measured base',
    );
  }

  const counted = Number(git('rev-list', '--count', `${baseOid}..${headOid}`));
  if (!Number.isSafeInteger(counted) || counted < 0) {
    fail('SensorResultInvalid', 'the commit count is not a non-negative integer');
  }
  const raw = git('log', '-1', '--format=%cI', headOid);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    fail('SensorResultInvalid', 'the commit instant is not parseable');
  }
  const committedAt = new Date(parsed).toISOString();
  if (parsed > Date.parse(observedAt)) {
    fail('EvidenceFromFuture', 'the measured commit is dated after the observation');
  }
  return deepFreeze({
    headOid,
    baseOid,
    committedAt,
    durability: 'COMMITTED',
    commitsAheadOfBase: counted,
  });
}

export { FirstEvidenceDraftPrError, firstEvidenceOperationIdentity };
