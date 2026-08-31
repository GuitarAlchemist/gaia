/**
 * pr-review-thread-repair.mjs — the durable half of `gaia-pr-review-thread-repair/1`.
 *
 * This Adapter owns exactly one append-only JSONL file and one lock directory, and performs
 * lock -> re-read -> compare-and-swap -> append -> fsync, in the shape the telemetry log, the drain
 * ledger and the first-evidence delivery already use. It is a SEPARATE ledger with its own
 * machine, deliberately: adding the seven lifecycle transitions to either existing machine would
 * change that machine's `rulesRevision` and make every receipt already on disk unreadable.
 *
 * THE PROTOCOL
 * ------------
 *   received -> classified -> claimed -> repaired -> verified -> commented -> resolved
 *
 * Two of those reach GitHub, and only two: one evidence comment, and one resolution of that exact
 * thread. Each is preceded by a durable, leased `CLAIMED` record that names the effect it is about
 * to perform, so a crash between a request and its response stays distinguishable from a request
 * that was never made.
 *
 * THE LINEARIZATION POINT
 * -----------------------
 * Exactly one durable act orders each effect: the compare-and-swap append of that `CLAIMED` intent
 * against the ledger head the caller observed. Two callers that both read the same head cannot
 * both land, because each seals its own ownership token and its own intent into its claim, so
 * their two claims are different records rather than one replay. The loser performs no effect and
 * writes nothing at all. A process-local promise or a single-process barrier cannot carry this:
 * the callers are separate operating-system processes, and the only thing they share is the file.
 *
 * OWNERSHIP IS BOUNDED
 * --------------------
 * A live supervisor and one killed mid-repair leave the same record. What separates them is the
 * bounded lease sealed into the claim. An unexpired lease is a live owner and a second supervisor
 * fails closed rather than racing it; an expired one is an orphan, and the lane is reconciled
 * against GitHub instead of being wedged forever on a claim nobody holds.
 *
 * RECONCILIATION IS EXACT, NOT PROBABLE
 * ------------------------------------
 * The one comment this pump posts carries the thread identity as a marker in its body. A lost
 * response is recovered by finding that exact marker; two comments carrying it is an ambiguity and
 * fails closed. "Probably ours" is how one lane adopts another lane's work.
 *
 * WHAT THIS MODULE CANNOT DO
 * --------------------------
 * It holds no GitHub client. The effect port is injected and has exactly three methods: one read,
 * one comment, one resolution. There is no method here that could integrate, approve, dismiss a
 * review, promote a draft or publish a branch, so a resolved thread cannot become an approval by
 * accident. A thread somebody else closed is never recorded as this pump's resolution.
 *
 * DUCKDB
 * ------
 * `projectPrReviewRepairLedger` replays the ledger into a deterministic flat relation: one row per
 * transition, every column a scalar, sorted by identity then ordinal. That relation is
 * newline-delimited JSON, which DuckDB reads directly. DuckDB itself is not a dependency and this
 * module has no analytical-store call site at all, which is a stronger property than a degradation
 * path around one: its unavailability cannot stop the pump, because the pump never speaks to it.
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
import { isExactInstant } from './local-lane-observation.mjs';
import {
  PR_REVIEW_SEVERITIES,
  PR_REVIEW_STATES,
  PR_REVIEW_THREAD_LIFECYCLE,
  PR_REVIEW_THREAD_REFUSALS,
  PR_REVIEW_THREAD_TRANSITIONS,
  estimateRepairEta,
  planPrReviewThreadRepair,
  prReviewThreadIdentity,
  renderRepairChecklist,
  repairIdentityMarker,
  requirePrReviewThreadObservation,
} from './pr-review-thread.mjs';

export const PR_REVIEW_REPAIR_SCHEMA = 'gaia-pr-review-thread-repair/1';
export const PR_REVIEW_REPAIR_LEDGER_SCHEMA = 'gaia-pr-review-thread-repair-ledger/1';
export const PR_REVIEW_REPAIR_LEDGER_RECORD_SCHEMA = 'gaia-pr-review-thread-repair-ledger-record/1';
export const PR_REVIEW_REPAIR_PROJECTION_SCHEMA = 'gaia-pr-review-thread-repair-projection/1';

export const PR_REVIEW_REPAIR_TRANSITION_FIELDS = Object.freeze([
  'transition', 'threadIdentity', 'intent', 'owner', 'leaseExpiresAt', 'repository', 'pullRequest',
  'reviewThreadId', 'reviewedHeadOid', 'currentHeadOid', 'reviewState', 'severity',
  'actionableCommentIds', 'repairHeadOid', 'recordedAt', 'comment', 'refusal', 'revision',
]);

/** What a `CLAIMED` record is about to do. A claim that names no effect is a plain claim. */
export const PR_REVIEW_REPAIR_INTENTS = Object.freeze(['NONE', 'COMMENT', 'RESOLVE']);

export const PR_REVIEW_REPAIR_OUTCOMES = Object.freeze([
  'NONE', 'CLAIMED', 'PROGRESSED', 'COMMENTED', 'RESOLVED', 'REFUSED',
]);

export const PR_REVIEW_REPAIR_EFFECTS = Object.freeze([
  'NONE', 'GITHUB_REVIEW_THREAD_COMMENT', 'GITHUB_REVIEW_THREAD_RESOLUTION',
]);

/**
 * How long a claim is honoured before it is treated as an orphan. Ownership tokens are 32
 * hexadecimal characters and carry no host name, process id or path, so nothing about the machine
 * that made a claim can reach a durable record; the lease is the only liveness signal.
 */
export const PR_REVIEW_REPAIR_LEASE_MS = 120_000;

const MAX_LEASE_MS = 3_600_000;
const OWNER = /^[a-f0-9]{32}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

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
  transitions: PR_REVIEW_THREAD_TRANSITIONS,
  transitionFields: PR_REVIEW_REPAIR_TRANSITION_FIELDS,
  intents: PR_REVIEW_REPAIR_INTENTS,
  refusals: PR_REVIEW_THREAD_REFUSALS,
});

export const PR_REVIEW_REPAIR_MACHINE = Object.freeze({
  machineId: 'gaia-pr-review-thread-repair',
  machineVersion: 1,
  rulesRevision: sha256(MACHINE_RULES),
});

export const EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION = sha256({
  schema: PR_REVIEW_REPAIR_LEDGER_SCHEMA,
  machine: PR_REVIEW_REPAIR_MACHINE,
  records: [],
});

export class PrReviewRepairError extends Error {
  constructor(errorCode, message) {
    super(message);
    this.name = 'PrReviewRepairError';
    this.code = errorCode;
  }
}

const fail = (errorCode, message) => {
  throw new PrReviewRepairError(errorCode, message);
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
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('LedgerRequestInvalid', `${field} must be a SHA-256`);
  }
  return value;
}

export function prReviewRepairLedgerPath(directory) {
  return join(requireDirectory(directory), 'pr-review-thread-repair.jsonl');
}

export function prReviewRepairLedgerLockPath(directory) {
  return join(requireDirectory(directory), 'pr-review-thread-repair.lock');
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function withLedgerLock(directory, operation, {
  timeoutMs = LOCK_TIMEOUT_MS, staleMs = LOCK_STALE_MS,
} = {}) {
  const root = requireDirectory(directory);
  const lock = prReviewRepairLedgerLockPath(root);
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
          `could not acquire ${lock} within ${timeoutMs}ms; refusing to access the review-thread `
          + `repair ledger without its lock (fail closed; stale threshold ${staleMs}ms)`,
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

/** Seal one transition. Any digest the caller supplies is discarded and re-derived. */
function sealTransition(transition) {
  if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
    fail('TransitionInvalid', 'a transition must be a plain object');
  }
  const { revision: ignored, ...body } = transition;
  const expected = PR_REVIEW_REPAIR_TRANSITION_FIELDS.filter((field) => field !== 'revision');
  const supplied = Object.keys(body);
  if (supplied.length !== expected.length || supplied.some((key) => !expected.includes(key))) {
    fail('TransitionInvalid', 'a transition must contain exactly its schema fields');
  }
  if (!PR_REVIEW_THREAD_TRANSITIONS.includes(body.transition)) {
    fail('TransitionInvalid', 'unknown transition verb');
  }
  if (!PR_REVIEW_REPAIR_INTENTS.includes(body.intent)) {
    fail('TransitionInvalid', 'unknown claim intent');
  }
  if (!PR_REVIEW_STATES.includes(body.reviewState)) {
    fail('TransitionInvalid', 'unknown review state');
  }
  if (!PR_REVIEW_SEVERITIES.includes(body.severity)) {
    fail('TransitionInvalid', 'unknown severity');
  }
  if (body.refusal !== null && !PR_REVIEW_THREAD_REFUSALS.includes(body.refusal)) {
    fail('TransitionInvalid', 'unknown refusal token');
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
  requireRevision(body.threadIdentity, 'transition.threadIdentity');
  return deepFreeze({ ...body, revision: sha256(body) });
}

function verifyRecord(record, expectedOrdinal, expectedPreviousRevision) {
  if (!record || record.type !== 'pr-review-thread-repair.transition'
      || record.schema !== PR_REVIEW_REPAIR_LEDGER_RECORD_SCHEMA) {
    throw new CorruptLogError('review-thread repair ledger contains an unsupported record');
  }
  const { revision, ...body } = record;
  if (typeof revision !== 'string' || !SHA256.test(revision) || revision !== sha256(body)) {
    throw new CorruptLogError(
      'review-thread repair ledger record revision does not match its content',
    );
  }
  if (record.machineId !== PR_REVIEW_REPAIR_MACHINE.machineId
      || record.machineVersion !== PR_REVIEW_REPAIR_MACHINE.machineVersion
      || record.rulesRevision !== PR_REVIEW_REPAIR_MACHINE.rulesRevision) {
    throw new CorruptLogError('review-thread repair ledger record binds an unsupported machine');
  }
  if (record.ordinal !== expectedOrdinal || record.previousRevision !== expectedPreviousRevision) {
    throw new CorruptLogError('review-thread repair ledger record chain is not contiguous');
  }
  const { revision: transitionRevision, ...transitionBody } = record.transition ?? {};
  if (transitionRevision !== sha256(transitionBody)) {
    throw new CorruptLogError('review-thread repair ledger record holds an altered transition');
  }
  return record;
}

function readRecordsUnlocked(directory) {
  const path = prReviewRepairLedgerPath(directory);
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
    schema: PR_REVIEW_REPAIR_LEDGER_SCHEMA,
    machine: PR_REVIEW_REPAIR_MACHINE,
    revision: records.at(-1)?.revision ?? EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION,
    count: records.length,
    transitions: records.map(({ transition }) => transition),
  });
}

export function readPrReviewRepairLedger({ directory, lockOptions } = {}) {
  const root = requireDirectory(directory);
  if (!existsSync(root)) return snapshot([]);
  return withLedgerLock(root, () => snapshot(readRecordsUnlocked(root)), lockOptions);
}

function appendRecord(directory, record) {
  const path = prReviewRepairLedgerPath(directory);
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
 * it is refused rather than absorbed. That distinction is the whole difference between one comment
 * on a review thread and two.
 */
export function appendPrReviewRepairTransition({
  directory, transition, expectedLedgerRevision, lockOptions,
}) {
  const root = requireDirectory(directory);
  requireRevision(expectedLedgerRevision, 'expectedLedgerRevision');
  const sealed = sealTransition(transition);
  return withLedgerLock(root, () => {
    const records = readRecordsUnlocked(root);
    const before = snapshot(records);
    const divergent = before.revision !== expectedLedgerRevision;
    const replayedAt = records.findIndex((entry) => entry.transition.revision === sealed.revision);
    const observedWhenWritten = replayedAt <= 0
      ? EMPTY_PR_REVIEW_REPAIR_LEDGER_REVISION
      : records[replayedAt - 1].revision;
    if (divergent && (replayedAt === -1 || observedWhenWritten !== expectedLedgerRevision)) {
      fail('LedgerCasMismatch', 'the review-thread repair ledger changed since the caller observed it');
    }
    if (replayedAt !== -1) return deepFreeze({ duplicate: true, ledger: before });
    const body = {
      type: 'pr-review-thread-repair.transition',
      schema: PR_REVIEW_REPAIR_LEDGER_RECORD_SCHEMA,
      ...PR_REVIEW_REPAIR_MACHINE,
      ordinal: records.length,
      previousRevision: records.at(-1)?.revision ?? null,
      transition: sealed,
    };
    const record = deepFreeze({ ...body, revision: sha256(body) });
    appendRecord(root, record);
    return deepFreeze({ duplicate: false, ledger: snapshot([...records, record]) });
  }, lockOptions);
}

/* --------------------------------------------------------------------------------------------- *
 * The projection DuckDB reads
 * ------------------------------------------------------------------------------------------- */

const laneOf = (transitions) => transitions.reduce((lane, transition) => ({
  ...lane,
  transitions: [...lane.transitions, transition.transition],
  claimedAt: lane.claimedAt ?? (transition.transition === 'CLAIMED' ? transition.recordedAt : null),
  resolvedAt: transition.transition === 'RESOLVED' ? transition.recordedAt : lane.resolvedAt,
  outcome: transition.transition,
}), {
  transitions: [], claimedAt: null, resolvedAt: null, outcome: 'NONE',
});

/**
 * Replay the durable ledger into one passive projection. Read-only at every seam.
 *
 * `rows` is a relation, not a bag of shapes: every row carries the same columns and every column
 * is a scalar, so the file is directly readable as newline-delimited JSON. Ordering is by identity
 * then ordinal — by what a row IS, never by when it happened to arrive.
 */
export function projectPrReviewRepairLedger({ directory, lockOptions } = {}) {
  const ledger = readPrReviewRepairLedger({ directory, lockOptions });
  const rows = ledger.transitions.map((transition, ordinal) => ({
    threadIdentity: transition.threadIdentity,
    ordinal,
    transition: transition.transition,
    intent: transition.intent,
    repository: transition.repository,
    pullRequestNumber: transition.pullRequest,
    reviewThreadId: transition.reviewThreadId,
    reviewedHeadOid: transition.reviewedHeadOid,
    currentHeadOid: transition.currentHeadOid,
    reviewState: transition.reviewState,
    severity: transition.severity,
    actionableCommentIds: transition.actionableCommentIds.join(','),
    repairHeadOid: transition.repairHeadOid,
    commentId: transition.comment?.id ?? null,
    commentUrl: transition.comment?.url ?? null,
    refusal: transition.refusal,
    owner: transition.owner,
    leaseExpiresAt: transition.leaseExpiresAt,
    recordedAt: transition.recordedAt,
  })).sort((left, right) => (left.threadIdentity === right.threadIdentity
    ? left.ordinal - right.ordinal
    : (left.threadIdentity < right.threadIdentity ? -1 : 1)));

  const identities = [...new Set(ledger.transitions.map((entry) => entry.threadIdentity))].sort();
  const lanes = identities.map((threadIdentity) => {
    const mine = ledger.transitions.filter((entry) => entry.threadIdentity === threadIdentity);
    return {
      threadIdentity,
      repository: mine[0].repository,
      pullRequestNumber: mine[0].pullRequest,
      reviewThreadId: mine[0].reviewThreadId,
      reviewedHeadOid: mine[0].reviewedHeadOid,
      ...laneOf(mine),
    };
  });

  return deepFreeze({
    schema: PR_REVIEW_REPAIR_PROJECTION_SCHEMA,
    machine: PR_REVIEW_REPAIR_MACHINE,
    ledgerRevision: ledger.revision,
    projection: { rows, lanes },
    effect: 'NONE',
    authority: 'NONE',
  });
}

/* --------------------------------------------------------------------------------------------- *
 * The pump
 * ------------------------------------------------------------------------------------------- */

const boundComment = (value) => ({ id: value.id, url: value.url });

/**
 * Does this candidate comment bind exactly this claim? Anything less exact is a refusal; "probably
 * ours" is how one lane adopts another lane's comment.
 */
const bindsThread = (candidate, threadIdentity) => candidate
  && typeof candidate.id === 'string' && candidate.id.length > 0
  && typeof candidate.url === 'string' && candidate.url.startsWith('https://github.com/')
  && candidate.marker === threadIdentity;

const result = (body) => deepFreeze({ ...body, revision: sha256(body) });

/**
 * Advance one review thread by at most one effect.
 *
 * The pump is idempotent by construction: every decision is re-derived from a fresh observation
 * and the durable transitions for this exact identity, never from anything the caller carries
 * between ticks. Running it on every tick of a supervisor loop is safe; running two supervisors
 * against one ledger is safe; running it again after a crash is safe.
 */
export async function runPrReviewThreadRepairPump({
  directory, observation, grant, authority, effects, now = () => new Date(),
  owner = randomBytes(16).toString('hex'), leaseMs = PR_REVIEW_REPAIR_LEASE_MS, lockOptions,
}) {
  const root = requireDirectory(directory);
  if (typeof owner !== 'string' || !OWNER.test(owner)) {
    fail('LedgerRequestInvalid', 'owner must be a closed ownership token');
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > MAX_LEASE_MS) {
    fail('LedgerRequestInvalid', 'leaseMs must be a bounded positive count of milliseconds');
  }
  if (!effects || typeof effects.readReviewThread !== 'function'
      || typeof effects.postReviewThreadComment !== 'function'
      || typeof effects.resolveReviewThread !== 'function'
      || !authority || typeof authority.consume !== 'function') {
    fail('InvalidAdapter', 'the closed three-method review-thread port and an authority are required');
  }

  const observed = requirePrReviewThreadObservation(observation);
  const threadIdentity = prReviewThreadIdentity({
    repository: observed.repository,
    pullRequestNumber: observed.pullRequest.number,
    reviewThreadId: observed.reviewThread.id,
    reviewedHeadOid: observed.review.reviewedHeadOid,
  });
  const recordedAt = now().toISOString();
  if (!isExactInstant(recordedAt)) fail('LedgerRequestInvalid', 'the clock returned no exact instant');
  const leaseExpiresAt = new Date(Date.parse(recordedAt) + leaseMs).toISOString();

  let ledger = readPrReviewRepairLedger({ directory: root, lockOptions });
  const ledgerRevisionBefore = ledger.revision;
  let head = ledger.revision;
  const appended = [];
  let lastRecord = null;

  const mine = () => ledger.transitions.filter((entry) => entry.threadIdentity === threadIdentity);
  const history = () => {
    const seen = new Set(mine().map((entry) => entry.transition));
    return PR_REVIEW_THREAD_TRANSITIONS.filter((verb) => seen.has(verb));
  };

  const append = ({ transition, intent = 'NONE', lease = null, comment = null, refusal = null, reading }) => {
    const outcome = appendPrReviewRepairTransition({
      directory: root,
      transition: {
        transition,
        threadIdentity,
        intent,
        owner,
        leaseExpiresAt: lease,
        repository: observed.repository,
        pullRequest: observed.pullRequest.number,
        reviewThreadId: observed.reviewThread.id,
        reviewedHeadOid: observed.review.reviewedHeadOid,
        currentHeadOid: observed.currentHeadOid,
        reviewState: observed.review.state,
        severity: reading.severity,
        actionableCommentIds: reading.actionableCommentIds,
        repairHeadOid: reading.repairHeadOid,
        recordedAt,
        comment,
        refusal,
      },
      expectedLedgerRevision: head,
      lockOptions,
    });
    ledger = outcome.ledger;
    head = ledger.revision;
    lastRecord = ledger.transitions.at(-1);
    appended.push(transition);
    return outcome;
  };

  /** A caller whose observed head moved under it loses before any authority is consumed. */
  const ordered = (request) => {
    try {
      return append(request);
    } catch (error) {
      if (error instanceof PrReviewRepairError && error.code === 'LedgerCasMismatch') {
        fail(
          'RepairRaceLost',
          'another supervisor ordered this claim first; this one performs no effect',
        );
      }
      throw error;
    }
  };

  const reading = () => planPrReviewThreadRepair({ observation: observed, history: history() });

  const report = (plan, { state, outcome, effect = 'NONE', consumed = 'NONE', comment = null }) => result({
    schema: PR_REVIEW_REPAIR_SCHEMA,
    state: state ?? plan.state,
    action: plan.action,
    outcome,
    refusal: plan.refusal,
    threadIdentity,
    severity: plan.severity,
    reviewState: plan.reviewState,
    blocksMerge: plan.blocksMerge,
    applicability: plan.applicability,
    appended: [...appended],
    comment,
    ledgerRevisionBefore,
    ledgerRevisionAfter: head,
    effect,
    authority: consumed,
  });

  // Ingestion is unconditional, and is itself repaired rather than assumed. A thread nobody
  // classified as actionable is still evidence that a review happened; and a supervisor killed
  // between RECEIVED and CLASSIFIED leaves a lane whose history is no longer a contiguous prefix,
  // so completing a missing prefix here is what stops one crash from wedging that lane forever.
  // The compare-and-swap on the first of these orders two supervisors that see one thread for the
  // first time at the same moment.
  const ingestion = planPrReviewThreadRepair({ observation: observed, history: [] });
  for (const verb of ['RECEIVED', 'CLASSIFIED']) {
    if (!history().includes(verb)) ordered({ transition: verb, reading: ingestion });
  }

  const settled = () => (appended.length === 0 ? 'NONE' : 'PROGRESSED');
  let plan = reading();

  /** Evidence this observation proves that the ledger does not yet carry. */
  const pendingEvidence = () => {
    const seen = history();
    // Evidence accrues only to a live claimed lane. A lane that was refused, or whose thread is
    // already resolved, is terminal, and appending to it would grow a record nobody may act on.
    if (!seen.includes('CLAIMED') || seen.includes('REFUSED') || seen.includes('RESOLVED')) {
      return [];
    }
    // Both are gated on the repair proof, because VERIFIED may never precede REPAIRED: a
    // verification of a repair that was never proven verifies nothing.
    if (!plan.repairProven) return [];
    const pending = seen.includes('REPAIRED') ? [] : ['REPAIRED'];
    return plan.verificationProven && !seen.includes('VERIFIED')
      ? [...pending, 'VERIFIED']
      : pending;
  };

  if (plan.action === 'NONE' && pendingEvidence().length === 0) {
    return report(plan, { outcome: settled() });
  }

  // A live supervisor and one killed mid-repair leave the same record; the bounded lease is the
  // only thing that separates them. A caller's own claim is never a stranger's, so resuming an
  // interrupted repair does not deadlock against itself.
  const heldByLiveOwner = mine().some(
    (entry) => entry.transition === 'CLAIMED'
      && entry.owner !== owner
      && entry.leaseExpiresAt !== null
      && Date.parse(entry.leaseExpiresAt) > Date.parse(recordedAt),
  );
  if (heldByLiveOwner) {
    fail('RepairInFlight', 'a live owner holds an unexpired claim for this review thread');
  }

  if (plan.action === 'REFUSE') {
    ordered({ transition: 'REFUSED', refusal: plan.refusal, reading: plan });
    return report(plan, { state: 'REFUSED', outcome: 'REFUSED' });
  }

  if (plan.action === 'CLAIM') {
    ordered({ transition: 'CLAIMED', lease: leaseExpiresAt, reading: plan });
    return report(plan, { outcome: 'CLAIMED' });
  }

  // The evidence transitions carry no effect: they record that the repair and its verification
  // were proven, from an observation that proved them. They are recorded as soon as they are
  // proven rather than at the moment of the comment, so an operator sees "repaired, awaiting its
  // checks" instead of silence.
  for (const verb of pendingEvidence()) append({ transition: verb, reading: plan });
  plan = reading();
  if (plan.action !== 'COMMENT' && plan.action !== 'RESOLVE') {
    return report(plan, { outcome: settled() });
  }

  // A prior attempt reached, or may have reached, GitHub. Ask what is actually there before
  // deciding: a lost response is indistinguishable from a request that never arrived, and only
  // GitHub can tell the two apart.
  let found;
  try {
    found = await effects.readReviewThread({
      repository: observed.repository,
      pullRequest: observed.pullRequest.number,
      reviewThreadId: observed.reviewThread.id,
    });
  } catch {
    fail('ReconciliationFailed', 'reconciliation failed without exposing provider diagnostics');
  }
  if (!found || typeof found.isResolved !== 'boolean' || !Array.isArray(found.comments)) {
    fail('ReconciliationFailed', 'reconciliation did not return a review thread');
  }
  const ours = found.comments.filter((entry) => entry.marker === threadIdentity);
  if (ours.length > 1) {
    fail('ReconciliationAmbiguous', 'more than one comment carries this claim\'s identity marker');
  }
  if (found.isResolved) {
    if (plan.action !== 'RESOLVE') {
      // Somebody else closed this thread. Recording a resolution this pump did not perform would
      // be a durable claim about an effect that never happened.
      return report(plan, { state: 'THREAD_RESOLVED', outcome: settled() });
    }
    append({ transition: 'RESOLVED', reading: plan });
    return report(plan, { state: 'THREAD_RESOLVED', outcome: 'RESOLVED' });
  }
  if (plan.action === 'COMMENT' && ours.length === 1) {
    if (!bindsThread(ours[0], threadIdentity)) {
      fail('ProviderResultInvalid', 'the existing comment does not bind this claim');
    }
    const adopted = boundComment(ours[0]);
    append({ transition: 'COMMENTED', comment: adopted, reading: plan });
    return report(plan, { outcome: 'COMMENTED', comment: adopted });
  }

  // Durable BEFORE the request, and ordered by the compare-and-swap inside it. The claim names the
  // effect it is about to perform, so the record that precedes a comment and the record that
  // precedes a resolution are different records and cannot be mistaken for one replay.
  const intent = plan.action;
  ordered({ transition: 'CLAIMED', intent, lease: leaseExpiresAt, reading: plan });
  const intentRevision = lastRecord.revision;

  // Terminal, unlike a failed request: no request was made, so there is nothing that may have
  // arrived and nothing to reconcile. The refusal names what actually happened rather than
  // borrowing a token that would record the repair as unverified when it was verified and it was
  // the grant that was refused.
  const abandon = (errorCode, message) => {
    append({ transition: 'REFUSED', refusal: 'AUTHORITY_REFUSED', reading: plan });
    fail(errorCode, message);
  };

  let authorization;
  try {
    authorization = await authority.consume({
      grant,
      intent: {
        intentRevision,
        action: intent === 'COMMENT' ? 'POST_REVIEW_THREAD_COMMENT' : 'RESOLVE_REVIEW_THREAD',
        repository: observed.repository,
        itemKind: 'PULL_REQUEST',
        itemId: `pull-request-${observed.pullRequest.number}`,
        itemNumber: observed.pullRequest.number,
        snapshotRevision: observed.sourceRevision,
      },
    });
  } catch {
    abandon('AuthorityRefused', 'authority refused without exposing diagnostics');
  }
  if (!authorization || authorization.status !== 'AUTHORIZED') {
    abandon('AuthorityRefused', 'authority did not authorize this exact effect');
  }

  const idempotencyKey = sha256({ threadIdentity, intent, grantId: authorization.grantId });

  if (intent === 'COMMENT') {
    const lanes = projectPrReviewRepairLedger({ directory: root, lockOptions }).projection.lanes
      .filter((lane) => lane.threadIdentity !== threadIdentity);
    const body = renderRepairChecklist({
      reading: plan, observation: observed, eta: estimateRepairEta(lanes),
    });
    let posted;
    try {
      posted = await effects.postReviewThreadComment({
        repository: observed.repository,
        pullRequest: observed.pullRequest.number,
        reviewThreadId: observed.reviewThread.id,
        threadIdentity,
        body,
        idempotencyKey,
      });
    } catch {
      // Deliberately NOT terminal: the request may have arrived. The claim stays reconcilable, and
      // its lease is what bounds it.
      fail('EffectFailed', 'the comment effect failed without exposing provider diagnostics');
    }
    if (!bindsThread(posted, threadIdentity)) {
      fail('ProviderResultInvalid', 'the returned comment does not bind this claim');
    }
    const bound = boundComment(posted);
    append({ transition: 'COMMENTED', comment: bound, reading: plan });
    return report(plan, {
      outcome: 'COMMENTED', effect: 'GITHUB_REVIEW_THREAD_COMMENT', consumed: 'CONSUMED',
      comment: bound,
    });
  }

  let resolved;
  try {
    resolved = await effects.resolveReviewThread({
      repository: observed.repository,
      pullRequest: observed.pullRequest.number,
      reviewThreadId: observed.reviewThread.id,
      threadIdentity,
      idempotencyKey,
    });
  } catch {
    fail('EffectFailed', 'the resolution effect failed without exposing provider diagnostics');
  }
  if (!resolved || resolved.isResolved !== true) {
    fail('ProviderResultInvalid', 'the provider did not report this thread as resolved');
  }
  append({ transition: 'RESOLVED', reading: plan });
  return report(plan, {
    outcome: 'RESOLVED', effect: 'GITHUB_REVIEW_THREAD_RESOLUTION', consumed: 'CONSUMED',
  });
}

/* --------------------------------------------------------------------------------------------- *
 * The sensor
 * ------------------------------------------------------------------------------------------- */

function defaultGitRun(worktree, args) {
  return execFileSync('git', args, {
    cwd: worktree, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Measure whether a repair head carries the fix for one anchored finding.
 *
 * Every question asked here is about the commit graph: `rev-parse`, `merge-base --is-ancestor`,
 * `rev-list --count` and a commit-to-commit `diff --name-only`. The working tree and the index are
 * never consulted, so a staged or unstaged change cannot move any value this function returns.
 * That is the whole enforcement for "an uncommitted change is not a repair": the sensor cannot see
 * a dirty tree, because it never asks.
 *
 * It reports facts and refuses to interpret them. A head that does not descend from the reviewed
 * head, or a commit that misses the anchored path, is reported as such and left for the contract
 * to decide; silence would be indistinguishable from proof.
 */
export function measurePrReviewThreadRepair({
  worktree, reviewedHeadOid, repairRef, anchorPath, addressedCommentIds = [], observedAt,
  run = defaultGitRun,
}) {
  if (!isExactInstant(observedAt)) {
    fail('SensorRequestInvalid', 'observedAt must be an exact instant');
  }
  if (typeof anchorPath !== 'string' || anchorPath.length === 0) {
    fail('SensorRequestInvalid', 'anchorPath must be the path the finding is anchored to');
  }
  if (!Array.isArray(addressedCommentIds)) {
    fail('SensorRequestInvalid', 'addressedCommentIds must be an array');
  }
  const git = (...args) => String(run(worktree, args) ?? '').trim();
  const oid = (value, field) => {
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value)) {
      fail('SensorResultInvalid', `${field} is not a Git object id`);
    }
    return value;
  };
  const reviewed = oid(reviewedHeadOid, 'reviewedHeadOid');
  const headOid = oid(git('rev-parse', repairRef), 'repairRef');

  let descendsFromReviewedHead = true;
  try {
    run(worktree, ['merge-base', '--is-ancestor', reviewed, headOid]);
  } catch {
    descendsFromReviewedHead = false;
  }

  const counted = Number(git('rev-list', '--count', `${reviewed}..${headOid}`));
  if (!Number.isSafeInteger(counted) || counted < 0) {
    fail('SensorResultInvalid', 'the commit count is not a non-negative integer');
  }

  const changed = git('diff', '--name-only', reviewed, headOid)
    .split(/\r?\n/u)
    .filter((line) => line.length > 0);

  return deepFreeze({
    headOid,
    descendsFromReviewedHead,
    touchesAnchorPath: changed.includes(anchorPath),
    commitsAheadOfReviewedHead: counted,
    addressedCommentIds: [...addressedCommentIds],
  });
}

export { repairIdentityMarker };
