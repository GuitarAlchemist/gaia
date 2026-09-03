/**
 * pr-delivery-metrics.mjs — the authority half of `gaia-pr-delivery-metrics/1` (issue #89 R0).
 *
 * WHAT THIS IS
 * ------------
 * One pure function chain: GitHub-shaped observations become append-only, content-addressed facts;
 * the facts become one closed set of named intervals and counts; the metrics become one bounded
 * managed Markdown region and one no-effect publication intent. Every number is a function of the
 * facts alone, so an operator with the same observations re-derives the same result rows.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * It holds no provider client, opens no socket, spawns no process, touches no file, and reads no
 * clock: the caller supplies the observed instant. It adds no bus verb and grants no transition,
 * merge, retry, or scheduling authority. `effect` is `NONE` on everything it returns. The
 * analytical store is not imported here at all — the projection this module computes is the
 * authority the summary is rendered from, and a store that disagrees is the store that is wrong.
 *
 * IDENTITY AND COALESCING
 * -----------------------
 * Event identity is `(repository, pullRequestNumber, kind, providerEventId)` digested. A webhook
 * and a poll that saw the same provider event coalesce into one fact carrying both observing
 * sources. Two observations that claim one identity with different evidence are a typed conflict,
 * never a last-writer-wins overwrite, because arrival order must not be able to fabricate state.
 *
 * HEAD GENERATIONS
 * ----------------
 * `DRAFT_OPENED` and every `HEAD_ADVANCED` open a generation. A `*_CURRENT_HEAD` metric reads only
 * facts bound to the current head, so a superseded head's green check stays history and can never
 * satisfy the head under test.
 *
 * MISSING EVIDENCE
 * ----------------
 * An interval nobody witnessed is `null` with a named reason, never `0`. Zero is a measurement.
 *
 * AUTHORITY-BOUND FIELDS
 * ----------------------
 * The initial forecast is the earliest `FORECAST_RECORDED` fact and no later forecast replaces it,
 * in any arrival order. `deliveredAt` comes only from a terminal receipt that carries a closed
 * authority token, binds this exact repository, pull request, and current head, and is corroborated
 * by a `MERGED` fact on that head. A merge observation is evidence; it is not authority.
 */

import { createHash } from 'node:crypto';

export const PR_DELIVERY_FACT_SCHEMA = 'gaia-pr-delivery-fact/1';
export const PR_DELIVERY_FACTS_SCHEMA = 'gaia-pr-delivery-facts/1';
export const PR_DELIVERY_METRICS_SCHEMA = 'gaia-pr-delivery-metrics/1';
export const PR_DELIVERY_TERMINAL_RECEIPT_SCHEMA = 'gaia-pr-delivery-terminal-receipt/1';
export const PR_DELIVERY_PUBLICATION_INTENT_SCHEMA = 'gaia-pr-delivery-publication-intent/1';

export const PR_DELIVERY_SUMMARY_BEGIN = '<!-- gaia-pr-delivery-metrics:begin -->';
export const PR_DELIVERY_SUMMARY_END = '<!-- gaia-pr-delivery-metrics:end -->';

/** The closed event vocabulary. A kind that is not here is a refusal, not an extension. */
export const PR_DELIVERY_EVENT_KINDS = Object.freeze([
  'DRAFT_OPENED', 'HEAD_ADVANCED', 'READY_FOR_REVIEW', 'REVIEW_SUBMITTED',
  'CHECK_QUEUED', 'CHECK_STARTED', 'CHECK_COMPLETED',
  'CONFLICT_OBSERVED', 'CONFLICT_RESOLVED', 'FORECAST_RECORDED', 'MERGED',
]);

/** Where an observation came from. R0 admits fixtures and the two ordinary read channels. */
export const PR_DELIVERY_SOURCES = Object.freeze([
  'GITHUB_FIXTURE', 'GITHUB_POLL', 'GITHUB_WEBHOOK',
]);

/** One scalar outcome token per observation. `NONE` is the absence of an outcome, not a verdict. */
export const PR_DELIVERY_OUTCOMES = Object.freeze([
  'NONE', 'SUCCESS', 'FAILURE', 'CANCELLED', 'APPROVED', 'CHANGES_REQUESTED', 'COMMENTED',
]);

/** The only authority that can state a delivery instant in R0. */
export const PR_DELIVERY_TERMINAL_AUTHORITIES = Object.freeze(['GITHUB_MERGE_RECEIPT']);

export const PR_DELIVERY_INTERVALS = Object.freeze([
  'CI_EXECUTION_CURRENT_HEAD', 'CI_QUEUE_CURRENT_HEAD', 'CONFLICT_REPAIR', 'DRAFT_AGE',
  'TIME_TO_FIRST_REVIEW', 'TIME_TO_GREEN_CURRENT_HEAD', 'TOTAL_LEAD_TIME',
]);

export const PR_DELIVERY_COUNTS = Object.freeze([
  'CHECK_RUNS_CURRENT_HEAD', 'CONFLICT_EPISODES', 'DELIVERY_ROUNDS', 'HEAD_CHANGES',
  'REVIEW_CYCLES',
]);

export const PR_DELIVERY_OBSERVATION_FIELDS = Object.freeze([
  'forecastMaximumMinutes', 'forecastMinimumMinutes', 'headOid', 'kind', 'occurredAt',
  'providerEventId', 'pullRequestNumber', 'repository', 'source', 'subject', 'outcome',
]);

const GENERATION_KINDS = Object.freeze(['DRAFT_OPENED', 'HEAD_ADVANCED']);

const GIT_OID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const REVISION = /^sha256:[a-f0-9]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export class PrDeliveryMetricsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PrDeliveryMetricsError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new PrDeliveryMetricsError(code, message);
}

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

const revisionOf = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

/** The digest of a Markdown body, as the compare-and-set token a caller observed. */
export const prDeliveryBodyRevision = (body) => {
  if (typeof body !== 'string') fail('InvalidBody', 'a pull-request body must be text');
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
};

/**
 * Admit one plain object carrying exactly its schema fields as enumerable data properties, and
 * return a one-read snapshot of it. An accessor could answer the validating read with one value
 * and the capturing read with another, so a getter is refused, and every field is read exactly
 * once — from its descriptor — before anything is validated.
 */
function exactObject(value, fields, subject, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) {
    fail(code, `${subject} must be a plain object`);
  }
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')
      || actual.length !== fields.length
      || [...actual].sort().some((key, index) => key !== [...fields].sort()[index])) {
    fail(code, `${subject} must contain exactly its schema fields`);
  }
  const snapshot = {};
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
      fail(code, `${subject}.${key} must be an enumerable data property, not an accessor`);
    }
    snapshot[key] = descriptor.value;
  }
  return Object.freeze(snapshot);
}

function instant(value, subject, code) {
  if (typeof value !== 'string' || !INSTANT.test(value) || !Number.isFinite(Date.parse(value))
      || new Date(Date.parse(value)).toISOString() !== value) {
    fail(code, `${subject} must be an exact UTC instant`);
  }
  return Date.parse(value);
}

function member(value, closed, subject, code) {
  if (typeof value !== 'string' || !closed.includes(value)) {
    fail(code, `${subject} must be one of ${closed.join(', ')}`);
  }
  return value;
}

function scalarText(value, subject, code) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    fail(code, `${subject} must be canonical text`);
  }
  return value;
}

function pullRequestNumber(value, subject, code) {
  if (!Number.isSafeInteger(value) || value < 1) fail(code, `${subject} must be a pull-request number`);
  return value;
}

function forecastMinutes(value, kind, subject) {
  if (kind !== 'FORECAST_RECORDED') {
    if (value !== null) fail('ObservationInvalid', `${subject} belongs to a forecast observation`);
    return null;
  }
  if (!Number.isSafeInteger(value) || value < 0) fail('ObservationInvalid', `${subject} must be whole minutes`);
  return value;
}

/**
 * Normalize one GitHub-shaped observation into a content-addressed fact.
 *
 * `source` is provenance and is deliberately outside the evidence digest: two channels that saw the
 * same provider event must coalesce rather than collide.
 */
function normalize(input, { repository, number, observedAtMs }) {
  const observation = exactObject(
    input, PR_DELIVERY_OBSERVATION_FIELDS, 'observation', 'ObservationInvalid',
  );
  const source = member(observation.source, PR_DELIVERY_SOURCES, 'observation.source', 'ObservationInvalid');
  const kind = member(observation.kind, PR_DELIVERY_EVENT_KINDS, 'observation.kind', 'ObservationInvalid');
  const outcome = member(observation.outcome, PR_DELIVERY_OUTCOMES, 'observation.outcome', 'ObservationInvalid');
  const subject = scalarText(observation.subject, 'observation.subject', 'ObservationInvalid');
  const providerEventId = scalarText(
    observation.providerEventId, 'observation.providerEventId', 'ObservationInvalid',
  );
  if (typeof observation.headOid !== 'string' || !GIT_OID.test(observation.headOid)) {
    fail('ObservationInvalid', 'observation.headOid must be a Git object id');
  }
  const occurredAtMs = instant(observation.occurredAt, 'observation.occurredAt', 'ObservationInvalid');
  const forecastMinimumMinutes = forecastMinutes(
    observation.forecastMinimumMinutes, kind, 'observation.forecastMinimumMinutes',
  );
  const forecastMaximumMinutes = forecastMinutes(
    observation.forecastMaximumMinutes, kind, 'observation.forecastMaximumMinutes',
  );
  if (forecastMinimumMinutes !== null && forecastMinimumMinutes > forecastMaximumMinutes) {
    fail('ObservationInvalid', 'a forecast window must not end before it starts');
  }
  if (typeof observation.repository !== 'string' || !REPOSITORY.test(observation.repository)) {
    fail('ObservationInvalid', 'observation.repository must be owner/name');
  }
  pullRequestNumber(observation.pullRequestNumber, 'observation.pullRequestNumber', 'ObservationInvalid');
  if (observation.repository !== repository || observation.pullRequestNumber !== number) {
    fail('SubjectMismatch', 'an observation of another pull request is not evidence about this one');
  }
  if (occurredAtMs > observedAtMs) {
    fail('FutureEvidence', 'an instant after the observed instant is not evidence');
  }

  const evidence = {
    schema: PR_DELIVERY_FACT_SCHEMA,
    repository,
    pullRequestNumber: number,
    kind,
    headOid: observation.headOid,
    occurredAt: observation.occurredAt,
    providerEventId,
    subject,
    outcome,
    forecastMinimumMinutes,
    forecastMaximumMinutes,
  };
  return {
    ...evidence,
    eventIdentity: revisionOf({
      repository, pullRequestNumber: number, kind, providerEventId,
    }),
    evidenceRevision: revisionOf(evidence),
    sources: [source],
    occurredAtMs,
  };
}

/**
 * Replay observations into one ordered, deduplicated fact set.
 *
 * The result is independent of arrival order: facts sort by instant, then kind, then identity, and
 * a coalesced fact's observing sources are sorted and unique.
 */
export function ingestPrDeliveryObservations({
  repository, pullRequestNumber: number, observations, observedAt,
} = {}) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    fail('InvalidSubject', 'repository must be owner/name');
  }
  pullRequestNumber(number, 'pullRequestNumber', 'InvalidSubject');
  const observedAtMs = instant(observedAt, 'observedAt', 'InvalidSubject');
  if (!Array.isArray(observations)) fail('InvalidSubject', 'observations must be a list');

  const byIdentity = new Map();
  let coalescedObservations = 0;
  for (const observation of observations) {
    const fact = normalize(observation, { repository, number, observedAtMs });
    const existing = byIdentity.get(fact.eventIdentity);
    if (existing === undefined) {
      byIdentity.set(fact.eventIdentity, fact);
      continue;
    }
    if (existing.evidenceRevision !== fact.evidenceRevision) {
      fail(
        'ObservationConflict',
        `two observations claim ${fact.eventIdentity} with different evidence`,
      );
    }
    existing.sources = [...new Set([...existing.sources, ...fact.sources])].sort();
    coalescedObservations += 1;
  }

  const facts = [...byIdentity.values()]
    .sort((left, right) => left.occurredAtMs - right.occurredAtMs
      || (left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0)
      || (left.eventIdentity < right.eventIdentity ? -1 : 1))
    .map(({ occurredAtMs: _instant, sources, ...fact }) => Object.freeze({
      ...fact, sources: [...sources].sort().join(','),
    }));

  return Object.freeze({
    schema: PR_DELIVERY_FACTS_SCHEMA,
    repository,
    pullRequestNumber: number,
    observedAt,
    facts: Object.freeze(facts),
    // The revision binds the ordered evidence. Observing channels are provenance and are kept on
    // the fact, but a second channel seeing the same event does not make it a different event.
    factsRevision: revisionOf(facts.map(
      ({ eventIdentity, evidenceRevision }) => ({ eventIdentity, evidenceRevision }),
    )),
    coalescedObservations,
    effect: 'NONE',
    authority: 'NONE',
  });
}

/** Seal a terminal receipt so its content and its revision cannot drift apart. */
export function sealPrDeliveryTerminalReceipt({
  repository, pullRequestNumber: number, headOid, deliveredAt, authority,
} = {}) {
  if (typeof repository !== 'string' || !REPOSITORY.test(repository)) {
    fail('TerminalReceiptInvalid', 'receipt.repository must be owner/name');
  }
  pullRequestNumber(number, 'receipt.pullRequestNumber', 'TerminalReceiptInvalid');
  if (typeof headOid !== 'string' || !GIT_OID.test(headOid)) {
    fail('TerminalReceiptInvalid', 'receipt.headOid must be a Git object id');
  }
  instant(deliveredAt, 'receipt.deliveredAt', 'TerminalReceiptInvalid');
  scalarText(authority, 'receipt.authority', 'TerminalReceiptInvalid');
  const body = {
    schema: PR_DELIVERY_TERMINAL_RECEIPT_SCHEMA,
    repository,
    pullRequestNumber: number,
    headOid,
    deliveredAt,
    authority,
  };
  return Object.freeze({ ...body, receiptRevision: revisionOf(body) });
}

const known = (value) => Object.freeze({ known: true, ...value });
const unknown = (reason) => Object.freeze({ known: false, reason });

const interval = (metric, headBinding, from, to, reasons) => {
  if (from === null) return { metric, headBinding, unknownReason: reasons.from };
  if (to === null) return { metric, headBinding, unknownReason: reasons.to };
  if (to.at < from.at) return { metric, headBinding, unknownReason: 'INCONSISTENT_ORDER' };
  return { metric, headBinding, valueMilliseconds: to.at - from.at };
};

const stamp = (fact) => (fact === undefined ? null : { at: Date.parse(fact.occurredAt) });

/**
 * The facts one generation owns: those carrying its head, stamped at or after its opening instant
 * and before the next generation opens. Binding is by generation, not by oid alone. A force-push
 * that returns the branch to an earlier tree (A → B → A) opens a new generation with the old oid,
 * and the earlier generation's checks stay its own history: a delivery round is a push, not a tree.
 */
function boundTo(facts, { headOid, openedAt, supersededAt }) {
  const from = Date.parse(openedAt);
  const until = supersededAt === null ? Number.POSITIVE_INFINITY : Date.parse(supersededAt);
  return facts.filter((fact) => fact.headOid === headOid
    && Date.parse(fact.occurredAt) >= from && Date.parse(fact.occurredAt) < until);
}

function generationsOf(facts) {
  const opens = facts.filter(({ kind }) => GENERATION_KINDS.includes(kind));
  return opens.map((open, index) => {
    const next = opens[index + 1];
    const window = {
      headOid: open.headOid,
      openedAt: open.occurredAt,
      supersededAt: next === undefined ? null : next.occurredAt,
    };
    const bound = boundTo(facts, window);
    const green = bound.find(
      ({ kind, outcome }) => kind === 'CHECK_COMPLETED' && outcome === 'SUCCESS',
    );
    return Object.freeze({
      ordinal: index,
      ...window,
      greenCheckAt: green === undefined ? null : green.occurredAt,
      factCount: bound.length,
    });
  });
}

function forecastOf(facts, subject, terminalReceipt, mergedOnCurrentHead) {
  const recorded = facts.filter(({ kind }) => kind === 'FORECAST_RECORDED');
  const first = recorded[0];
  const last = recorded.at(-1);
  const asForecast = (fact) => (fact === undefined ? unknown('NO_FORECAST_RECORDED') : known({
    minimumMinutes: fact.forecastMinimumMinutes,
    maximumMinutes: fact.forecastMaximumMinutes,
    recordedAt: fact.occurredAt,
    eventIdentity: fact.eventIdentity,
  }));

  let delivered = unknown('NO_AUTHORIZED_TERMINAL_RECEIPT');
  if (terminalReceipt !== null && terminalReceipt !== undefined) {
    const { receiptRevision, ...body } = exactObject(
      terminalReceipt,
      ['schema', 'repository', 'pullRequestNumber', 'headOid', 'deliveredAt', 'authority', 'receiptRevision'],
      'terminalReceipt',
      'TerminalReceiptInvalid',
    );
    if (body.schema !== PR_DELIVERY_TERMINAL_RECEIPT_SCHEMA
        || typeof receiptRevision !== 'string' || !REVISION.test(receiptRevision)
        || revisionOf(body) !== receiptRevision) {
      fail('TerminalReceiptInvalid', 'a terminal receipt must match its own revision');
    }
    if (!PR_DELIVERY_TERMINAL_AUTHORITIES.includes(body.authority)) {
      fail('TerminalReceiptUnauthorized', `${body.authority} cannot state a delivery instant`);
    }
    if (body.repository !== subject.repository
        || body.pullRequestNumber !== subject.pullRequestNumber
        || body.headOid !== subject.currentHeadOid) {
      fail(
        'TerminalReceiptUnbound',
        'a terminal receipt must bind this exact repository, pull request, and current head',
      );
    }
    if (!mergedOnCurrentHead) {
      fail('TerminalReceiptUnwitnessed', 'no merge fact on the current head corroborates the receipt');
    }
    delivered = known({
      instant: body.deliveredAt,
      authority: body.authority,
      receiptRevision,
    });
  }

  const initial = asForecast(first);
  let absoluteError = unknown('NO_AUTHORIZED_TERMINAL_RECEIPT');
  let outcome = unknown('NO_AUTHORIZED_TERMINAL_RECEIPT');
  if (delivered.known && !initial.known) {
    absoluteError = unknown('NO_FORECAST_RECORDED');
    outcome = unknown('NO_FORECAST_RECORDED');
  } else if (delivered.known) {
    const opened = facts.find(({ kind }) => kind === 'DRAFT_OPENED');
    if (opened === undefined) {
      absoluteError = unknown('NO_DRAFT_OPENED');
      outcome = unknown('NO_DRAFT_OPENED');
    } else {
      const start = Date.parse(opened.occurredAt);
      const earliest = start + initial.minimumMinutes * 60_000;
      const latest = start + initial.maximumMinutes * 60_000;
      const midpoint = earliest + Math.round((latest - earliest) / 2);
      const at = Date.parse(delivered.instant);
      absoluteError = known({ value: Math.abs(at - midpoint) });
      outcome = known({ value: at >= earliest && at <= latest ? 'HIT' : 'MISS' });
    }
  }

  return Object.freeze({
    initial,
    current: asForecast(last),
    deliveredAt: delivered,
    absoluteErrorMilliseconds: absoluteError,
    intervalOutcome: outcome,
  });
}

const PR_DELIVERY_FACT_FIELDS = Object.freeze([
  'schema', 'repository', 'pullRequestNumber', 'kind', 'headOid', 'occurredAt', 'providerEventId',
  'subject', 'outcome', 'forecastMinimumMinutes', 'forecastMaximumMinutes', 'eventIdentity',
  'evidenceRevision', 'sources',
]);

/**
 * Re-derive a fact set's revisions before trusting it, exactly as a terminal receipt is re-verified
 * against its own sealed revision. A schema tag is a claim; the digests are the proof. A projection
 * that stamped an unverified `factsRevision` into a published summary would be publishing
 * provenance it never checked.
 */
function verifiedFacts(ingestion) {
  if (!Array.isArray(ingestion.facts)) fail('InvalidIngestion', 'ingestion must carry a fact list');
  for (const fact of ingestion.facts) {
    const { eventIdentity, evidenceRevision, sources: _sources, ...evidence } = exactObject(
      fact, PR_DELIVERY_FACT_FIELDS, 'fact', 'InvalidIngestion',
    );
    const identity = revisionOf({
      repository: evidence.repository,
      pullRequestNumber: evidence.pullRequestNumber,
      kind: evidence.kind,
      providerEventId: evidence.providerEventId,
    });
    if (evidence.schema !== PR_DELIVERY_FACT_SCHEMA
        || evidence.repository !== ingestion.repository
        || evidence.pullRequestNumber !== ingestion.pullRequestNumber
        || revisionOf(evidence) !== evidenceRevision
        || identity !== eventIdentity) {
      fail('FactRevisionMismatch', 'a fact must match its own evidence revision and identity');
    }
  }
  const restated = revisionOf(ingestion.facts.map(
    ({ eventIdentity, evidenceRevision }) => ({ eventIdentity, evidenceRevision }),
  ));
  if (restated !== ingestion.factsRevision) {
    fail('IngestionRevisionMismatch', 'a fact set must match its own facts revision');
  }
  return ingestion.facts;
}

/**
 * Project one closed set of named intervals and counts.
 *
 * Every published row is either a measurement or a named unknown. There is no composite score, and
 * nothing here decides, schedules, or triggers anything.
 */
export function projectPrDeliveryMetrics({ ingestion, currentHeadOid, terminalReceipt = null } = {}) {
  if (!ingestion || typeof ingestion !== 'object' || ingestion.schema !== PR_DELIVERY_FACTS_SCHEMA) {
    fail('InvalidIngestion', 'ingestion must be one gaia-pr-delivery-facts/1 result');
  }
  if (typeof currentHeadOid !== 'string' || !GIT_OID.test(currentHeadOid)) {
    fail('InvalidHead', 'currentHeadOid must be a Git object id');
  }
  const facts = verifiedFacts(ingestion);
  const generations = generationsOf(facts);
  if (!generations.some(({ headOid }) => headOid === currentHeadOid)) {
    fail('CurrentHeadUnwitnessed', 'no observation opens the current head generation');
  }
  const unwitnessed = facts.find(
    ({ headOid }) => !generations.some((generation) => generation.headOid === headOid),
  );
  if (unwitnessed !== undefined) {
    fail('HeadGenerationUnknown', `no generation opens head ${unwitnessed.headOid}`);
  }

  // The current generation is the latest one carrying the current head, and a `*_CURRENT_HEAD`
  // metric reads only the facts that generation owns.
  const currentGeneration = generations.findLast(({ headOid }) => headOid === currentHeadOid);
  const current = boundTo(facts, currentGeneration);
  const firstOf = (list, kind, predicate = () => true) => list
    .find((fact) => fact.kind === kind && predicate(fact));
  const lastOf = (list, kind) => [...list].reverse().find((fact) => fact.kind === kind);

  const draftOpened = stamp(firstOf(facts, 'DRAFT_OPENED'));
  const ready = stamp(firstOf(facts, 'READY_FOR_REVIEW'));
  const firstReview = ready === null
    ? null
    : stamp(firstOf(facts, 'REVIEW_SUBMITTED', ({ occurredAt }) => Date.parse(occurredAt) >= ready.at));
  const conflictObserved = stamp(firstOf(facts, 'CONFLICT_OBSERVED'));
  const conflictResolved = conflictObserved === null
    ? null
    : stamp(firstOf(
      facts, 'CONFLICT_RESOLVED', ({ occurredAt }) => Date.parse(occurredAt) >= conflictObserved.at,
    ));
  const merged = stamp(firstOf(facts, 'MERGED'));
  const queued = stamp(firstOf(current, 'CHECK_QUEUED'));
  const started = stamp(firstOf(current, 'CHECK_STARTED'));
  const completed = stamp(lastOf(current, 'CHECK_COMPLETED'));
  const green = stamp(firstOf(
    current, 'CHECK_COMPLETED', ({ outcome }) => outcome === 'SUCCESS',
  ));
  const openedCurrent = { at: Date.parse(currentGeneration.openedAt) };

  const intervals = [
    interval('DRAFT_AGE', 'PULL_REQUEST', draftOpened, ready, {
      from: 'NO_DRAFT_OPENED', to: 'NO_READY_FOR_REVIEW',
    }),
    interval('TIME_TO_FIRST_REVIEW', 'PULL_REQUEST', ready, firstReview, {
      from: 'NO_READY_FOR_REVIEW', to: 'NO_REVIEW_SUBMITTED',
    }),
    interval('CI_QUEUE_CURRENT_HEAD', 'CURRENT_HEAD', queued, started, {
      from: 'NO_CHECK_QUEUED_ON_CURRENT_HEAD', to: 'NO_CHECK_STARTED_ON_CURRENT_HEAD',
    }),
    interval('CI_EXECUTION_CURRENT_HEAD', 'CURRENT_HEAD', started, completed, {
      from: 'NO_CHECK_STARTED_ON_CURRENT_HEAD', to: 'NO_CHECK_COMPLETED_ON_CURRENT_HEAD',
    }),
    interval('TIME_TO_GREEN_CURRENT_HEAD', 'CURRENT_HEAD', openedCurrent, green, {
      from: 'NO_CURRENT_GENERATION', to: 'NO_GREEN_CHECK_ON_CURRENT_HEAD',
    }),
    interval('CONFLICT_REPAIR', 'PULL_REQUEST', conflictObserved, conflictResolved, {
      from: 'NO_CONFLICT_OBSERVED', to: 'NO_CONFLICT_RESOLVED',
    }),
    interval('TOTAL_LEAD_TIME', 'PULL_REQUEST', draftOpened, merged, {
      from: 'NO_DRAFT_OPENED', to: 'NOT_TERMINAL',
    }),
  ].map(({ metric, headBinding, valueMilliseconds = null, unknownReason = null }) => Object.freeze({
    metric, kind: 'INTERVAL', headBinding, valueMilliseconds, count: null, unknownReason,
  }));

  const counts = [
    ['DELIVERY_ROUNDS', 'PULL_REQUEST', generations.length],
    ['HEAD_CHANGES', 'PULL_REQUEST', generations.length - 1],
    ['REVIEW_CYCLES', 'PULL_REQUEST', facts.filter(({ kind }) => kind === 'REVIEW_SUBMITTED').length],
    ['CHECK_RUNS_CURRENT_HEAD', 'CURRENT_HEAD', current.filter(({ kind }) => kind === 'CHECK_COMPLETED').length],
    ['CONFLICT_EPISODES', 'PULL_REQUEST', facts.filter(({ kind }) => kind === 'CONFLICT_OBSERVED').length],
  ].map(([metric, headBinding, count]) => Object.freeze({
    metric, kind: 'COUNT', headBinding, valueMilliseconds: null, count, unknownReason: null,
  }));

  const rows = Object.freeze([...counts, ...intervals].sort(
    (left, right) => (left.kind < right.kind ? -1 : left.kind > right.kind ? 1
      : left.metric < right.metric ? -1 : 1),
  ));

  const forecast = forecastOf(
    facts,
    {
      repository: ingestion.repository,
      pullRequestNumber: ingestion.pullRequestNumber,
      currentHeadOid,
    },
    terminalReceipt,
    current.some(({ kind }) => kind === 'MERGED'),
  );
  const cost = Object.freeze({
    tokens: unknown('NO_ATTRIBUTED_RECEIPT'),
    providerCost: unknown('NO_ATTRIBUTED_RECEIPT'),
  });

  const body = {
    schema: PR_DELIVERY_METRICS_SCHEMA,
    repository: ingestion.repository,
    pullRequestNumber: ingestion.pullRequestNumber,
    currentHeadOid,
    observedAt: ingestion.observedAt,
    factsRevision: ingestion.factsRevision,
    generations: Object.freeze(generations),
    rows,
    forecast,
    cost,
  };
  return Object.freeze({
    ...body,
    projectionRevision: revisionOf(body),
    effect: 'NONE',
    authority: 'NONE',
  });
}

function formatMilliseconds(value) {
  const total = Math.round(value / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

const renderUnknown = (reason) => `UNKNOWN(${reason})`;

const renderWindow = (forecast) => (forecast.known
  ? `${forecast.minimumMinutes}-${forecast.maximumMinutes}m`
  : renderUnknown(forecast.reason));

/** One bounded Markdown region. Facts and named unknowns only — never a composite score. */
export function renderPrDeliverySummary(projection) {
  if (!projection || typeof projection !== 'object'
      || projection.schema !== PR_DELIVERY_METRICS_SCHEMA) {
    fail('InvalidProjection', 'a summary is rendered from one gaia-pr-delivery-metrics/1 result');
  }
  const { forecast, cost } = projection;
  const value = (row) => {
    if (row.unknownReason !== null) return renderUnknown(row.unknownReason);
    return row.kind === 'INTERVAL' ? formatMilliseconds(row.valueMilliseconds) : String(row.count);
  };
  const delivered = forecast.deliveredAt.known
    ? `${forecast.deliveredAt.instant} (${forecast.deliveredAt.authority})`
    : renderUnknown(forecast.deliveredAt.reason);
  const error = forecast.absoluteErrorMilliseconds.known
    ? formatMilliseconds(forecast.absoluteErrorMilliseconds.value)
    : renderUnknown(forecast.absoluteErrorMilliseconds.reason);
  const outcome = forecast.intervalOutcome.known
    ? forecast.intervalOutcome.value
    : renderUnknown(forecast.intervalOutcome.reason);

  return [
    `### Delivery metrics — ${projection.repository}#${projection.pullRequestNumber}`,
    '',
    '| Metric | Value |',
    '| --- | --- |',
    ...projection.rows.map((row) => `| ${row.metric} | ${value(row)} |`),
    '',
    `Initial ETA ${renderWindow(forecast.initial)} (immutable) · `
      + `current forecast ${renderWindow(forecast.current)} · delivered ${delivered}`,
    `Absolute error ${error} · initial interval ${outcome} · `
      + `tokens ${renderUnknown(cost.tokens.reason)} · cost ${renderUnknown(cost.providerCost.reason)}`,
    '',
    `Head ${projection.currentHeadOid.slice(0, 12)} · facts ${projection.factsRevision} · `
      + `projection ${projection.projectionRevision} · observed ${projection.observedAt}`,
  ].join('\n');
}

/**
 * Replace exactly one managed region, and never a byte outside it.
 *
 * A body carrying no region gains one at the end. A body carrying an unbalanced or repeated region
 * is ambiguous: this refuses rather than guessing which one is ours.
 */
export function applyManagedPrDeliverySummary({ body, summary } = {}) {
  if (typeof body !== 'string') fail('InvalidBody', 'body must be text');
  if (typeof summary !== 'string' || summary.length === 0) fail('InvalidSummary', 'summary must be text');
  if (summary.includes(PR_DELIVERY_SUMMARY_BEGIN) || summary.includes(PR_DELIVERY_SUMMARY_END)) {
    fail('InvalidSummary', 'a summary must not carry the region markers itself');
  }
  const begins = body.split(PR_DELIVERY_SUMMARY_BEGIN).length - 1;
  const ends = body.split(PR_DELIVERY_SUMMARY_END).length - 1;
  const region = `${PR_DELIVERY_SUMMARY_BEGIN}\n${summary}\n${PR_DELIVERY_SUMMARY_END}`;

  if (begins === 0 && ends === 0) {
    const separator = body.length === 0 ? '' : body.endsWith('\n') ? '\n' : '\n\n';
    return Object.freeze({ body: `${body}${separator}${region}\n`, changed: true });
  }
  if (begins !== 1 || ends !== 1) {
    fail('ManagedSectionAmbiguous', 'exactly one managed region is required to replace one');
  }
  const start = body.indexOf(PR_DELIVERY_SUMMARY_BEGIN);
  const finish = body.indexOf(PR_DELIVERY_SUMMARY_END);
  if (finish < start) fail('ManagedSectionAmbiguous', 'the managed region markers are inverted');
  const next = body.slice(0, start) + region + body.slice(finish + PR_DELIVERY_SUMMARY_END.length);
  return Object.freeze({ body: next, changed: next !== body });
}

/**
 * Prepare one compare-and-set publication. This returns an intent and performs no effect: the body
 * it computes is the exact postcondition a separately authorized adapter would have to reconcile.
 */
export function preparePrDeliverySummaryPublication({
  projection, currentHeadOid, observedBody, expectedBodyRevision,
} = {}) {
  if (!projection || typeof projection !== 'object'
      || projection.schema !== PR_DELIVERY_METRICS_SCHEMA) {
    fail('InvalidProjection', 'publication needs one gaia-pr-delivery-metrics/1 result');
  }
  if (typeof expectedBodyRevision !== 'string' || !REVISION.test(expectedBodyRevision)) {
    fail('InvalidBody', 'expectedBodyRevision must be a lowercase SHA-256 revision');
  }
  if (prDeliveryBodyRevision(observedBody) !== expectedBodyRevision) {
    fail('StaleManagedSummary', 'the observed body is not the body this publication expects');
  }
  if (typeof currentHeadOid !== 'string' || !GIT_OID.test(currentHeadOid)) {
    fail('InvalidHead', 'currentHeadOid must be a Git object id');
  }
  if (projection.currentHeadOid !== currentHeadOid) {
    fail('StaleProjectionHead', 'a projection of another head cannot publish this head');
  }
  const applied = applyManagedPrDeliverySummary({
    body: observedBody, summary: renderPrDeliverySummary(projection),
  });
  const body = {
    schema: PR_DELIVERY_PUBLICATION_INTENT_SCHEMA,
    repository: projection.repository,
    pullRequestNumber: projection.pullRequestNumber,
    headOid: currentHeadOid,
    factsRevision: projection.factsRevision,
    projectionRevision: projection.projectionRevision,
    expectedBodyRevision,
    body: applied.body,
    bodyRevision: prDeliveryBodyRevision(applied.body),
    changed: applied.changed,
    effect: 'NONE',
    authority: 'NONE',
  };
  return Object.freeze({ ...body, revision: revisionOf(body) });
}
