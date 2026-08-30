/**
 * What each live Gaia task is doing, said in at most three sentences.
 *
 * The input is one already-published `gaia-control-room/1` snapshot, and that is the whole input.
 * This module collects no evidence, opens nothing, calls nothing, reads no clock and spends no
 * provider token: it is a *reading* of a value someone else already verified, and it re-verifies
 * that value's own digest before reading a word of it.
 *
 * Every sentence is authored here, from a closed phrasebook, and every interpolated value is a
 * `TOKEN` matching `/^[A-Z][A-Z0-9_]{0,31}$/u`. There is deliberately no field whose content
 * originates outside a closed set, so a prompt, a reasoning trace, a terminal line, a URL or a
 * credential has nowhere to live even if a caller tries — the prohibition is a construction
 * rather than a filter, which is the only form of it that can be believed.
 *
 * Two digests, on purpose. `revision` covers the whole body and therefore moves on every tick,
 * because it binds the observation instant. `contentRevision` covers what the summary *says* plus
 * the freshness lattice it says it under: no age is stored, and the only instant a bullet may
 * carry is the `observedAt` of a verified telemetry transition, which the spine builds to exclude
 * `run.heartbeat`.
 *
 * The exact claim, narrowed to what an independent review reproduced. A tick whose only new events
 * are heartbeats changes NOT ONE SENTENCE: every `kind`, `code`, `params` and `text` is
 * byte-identical, which is what "do not generate text on a ten-second heartbeat" was ever about.
 * `contentRevision` additionally covers `evidenceState`, which is derived from the 30-second
 * freshness window and is therefore clock-derived, so a tick that CROSSES that boundary moves
 * `contentRevision` while every sentence stays identical. An earlier draft of this comment claimed
 * the digest never moves on a clock, and that was false in both directions — a boundary-crossing
 * heartbeat moves it, and so does a tick with no new event at all. Excluding `evidenceState` would
 * have made the shorter sentence true at the price of a digest that stays silent when an
 * operator-visible state changes, which is the worse trade.
 */

import { createHash } from 'node:crypto';

export const CONTROL_ROOM_ACTIVITY_SCHEMA = 'gaia-control-room-activity/1';

export const ACTIVITY_BULLET_KINDS = Object.freeze(['ACTION', 'RESULT', 'CHECKPOINT', 'BLOCKER']);
export const ACTIVITY_EVIDENCE_STATES = Object.freeze(['FRESH', 'PARTIAL', 'STALE', 'UNKNOWN']);
export const ACTIVITY_SOURCES = Object.freeze(['TELEMETRY', 'DRAIN', 'PROGRESS']);

export const MAX_ACTIVITY_ITEMS = 8;
export const MAX_BULLETS_PER_ITEM = 3;
export const MAX_BULLET_TEXT_CHARS = 120;
/**
 * Eight items of three bullets, each bullet carrying a 64-hex digest, an instant, a code, a
 * source, a state and a sentence, canonicalise to roughly 1.3 KB per item. The cap is generous
 * against that arithmetic on purpose: it exists so a future phrasebook edit that would break the
 * fragment budget fails a test rather than a browser, not to make the item cap unreachable.
 */
export const MAX_ACTIVITY_BYTES = 16_384;

const CONTROL_ROOM_SCHEMA = 'gaia-control-room/1';
const TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/u;
const REVISION = /^[a-f0-9]{64}$/u;
/** The spine's honest sentinel for evidence it was never given. It is never invented here. */
const UNKNOWN_EVIDENCE = 'UNKNOWN';
const UNRECOGNISED = 'UNRECOGNISED';

/**
 * A5, as a named fact rather than a comment: `gaia-cli-progress/1` is the running process talking
 * about itself, with no chain, no predecessor digest and no evidence revision. It may therefore
 * say what is *happening* and may never fill the RESULT slot, because a result is a claim that
 * something was produced and nothing ties this record to the thing produced.
 */
const PROGRESS_IS_VERIFIED = false;

/**
 * The phrasebook. English lives here so the published value and the rendered document cannot
 * disagree about it; French is a presentation layer keyed on the same `code`, deriving no fact.
 */
/**
 * A closed lookup table. Null-prototype on purpose: a plain object literal answers `constructor`
 * and `toString`, so a resealed snapshot naming one of those as a `runState` or an event skipped
 * every `=== undefined` guard downstream and threw a raw `TypeError` instead of a typed refusal.
 */
const closedMap = (entries) => Object.freeze(Object.assign(Object.create(null), entries));

const TEMPLATES = closedMap({
  // ACTION — what this task is doing now.
  IN_GATE: 'In gate {gate}.',
  BETWEEN_GATES: 'Running between gates.',
  RUN_BLOCKED: 'Stopped on {blocker}.',
  RUN_FINISHED: 'Run finished.',
  PROGRESS_STAGE: '{sentence} — reported by the run itself, unverified.',
  PROGRESS_STAGE_UNRECOGNISED: 'An unrecognised progress stage was reported; treat it as unobserved.',
  LANE_CLAIMED_UNOBSERVED: 'Lane claimed; no start record has been observed.',
  LANE_RUNNING_UNOBSERVED: 'Recorded as running; no run has been observed.',
  STATE_UNRECOGNISED: 'Unrecognised run state {runState}; treat it as unobserved.',
  // RESULT — the last verified transition, which by construction excludes heartbeats.
  RUN_STARTED: 'Run started.',
  GATE_ENTERED: 'Entered gate {gate}.',
  GATE_PASSED: 'Gate {gate} passed.',
  GATE_FAILED: 'Gate {gate} failed.',
  RUN_BLOCKED_RESULT: 'Run blocked on {blocker}.',
  RUN_COMPLETED: 'Run completed.',
  NO_VERIFIED_RESULT: 'No verified result has been recorded for this item.',
  // CHECKPOINT — the transitions the machine itself admits next. Never a heartbeat: a heartbeat
  // advances no state and produces no evidence, and naming it would invite the next ping to be
  // read as progress.
  AWAIT_GATE_OUTCOME: 'Next verifiable evidence: gate.passed or gate.failed on {gate}.',
  AWAIT_GATE_OR_COMPLETION: 'Next verifiable evidence: a gate.entered record, or run.completed.',
  AWAIT_DRAIN_RECONCILIATION: 'Run finished; the drain has not yet recorded the matching transition.',
  AWAIT_RUN_STARTED: 'Next verifiable evidence: a run.started record for this lane.',
  // BLOCKER — displaces the checkpoint, because a blocked run admits no next transition at all.
  TELEMETRY_BLOCKED: 'Blocked: {blocker}. The run recorded this and stopped.',
  DRAIN_BLOCKED: 'Blocked: {drainState}.',
});

/** The twelve caller-facing CLI progress stages, restated as a closed, digest-sealed table. */
const STAGE_SENTENCES = closedMap({
  VALIDATING: 'Validating run',
  EXECUTION_STARTING: 'Starting execution',
  AUTHORIZED_EXECUTION: 'Authorized execution starting',
  WORKER_RUNNING: 'Worker running',
  WORKER_COMPLETED: 'Worker completed',
  INITIAL_REVIEW_RUNNING: 'Initial review running',
  INITIAL_REVIEW_VERDICT: 'Initial review verdict',
  REPAIR_RUNNING: 'Repair running',
  REPAIR_COMPLETED: 'Repair completed',
  FINAL_REVIEW_RUNNING: 'Final review running',
  FINAL_REVIEW_VERDICT: 'Final review verdict',
  TERMINAL_OUTCOME: 'Run finished',
});

const RESULT_CODES = closedMap({
  'run.started': 'RUN_STARTED',
  'gate.entered': 'GATE_ENTERED',
  'gate.passed': 'GATE_PASSED',
  'gate.failed': 'GATE_FAILED',
  'run.blocked': 'RUN_BLOCKED_RESULT',
  'run.completed': 'RUN_COMPLETED',
});

const ACTION_CODES = closedMap({
  IN_GATE: 'IN_GATE',
  RUNNING: 'BETWEEN_GATES',
  BLOCKED: 'RUN_BLOCKED',
  COMPLETED: 'RUN_FINISHED',
});

const CHECKPOINT_CODES = closedMap({
  IN_GATE: 'AWAIT_GATE_OUTCOME',
  RUNNING: 'AWAIT_GATE_OR_COMPLETION',
  COMPLETED: 'AWAIT_DRAIN_RECONCILIATION',
});

/**
 * `FRESH < PARTIAL < STALE < UNKNOWN`, and an item takes the worst of its bullets. `PARTIAL`
 * ranks below `STALE` because a partial item still has a live heartbeat where a stale one has
 * none; `UNKNOWN` is worst because nothing at all was observed. This is a statement about the
 * *evidence*, never about motion: liveness is carried by the sentence and by the heartbeat chip,
 * so a blocked run with a real digest reads FRESH beside `Stopped on <BLOCKER>`.
 */
const EVIDENCE_RANK = Object.freeze({ FRESH: 0, PARTIAL: 1, STALE: 2, UNKNOWN: 3 });
const LIVENESS_RANK = Object.freeze({ ACTIVE: 0, STALE: 1, IDLE: 2 });
const SLOTS = Object.freeze(['ACTION', 'RESULT', 'CHECKPOINT_OR_BLOCKER']);
const TERMINAL_DRAIN_STATES = Object.freeze(['TERMINAL_MERGED', 'TERMINAL_CLOSED']);
const OCCUPIED_DRAIN_STATES = Object.freeze(['CLAIMED', 'RUNNING']);
const BLOCKED_DRAIN_STATES = Object.freeze([
  'BLOCKED_DEPENDENCY', 'BLOCKED_DRAFT', 'BLOCKED_EVIDENCE', 'BLOCKED_HUMAN',
  'BLOCKED_POLICY', 'BLOCKED_REVIEW', 'BLOCKED_TRIAGE', 'BLOCKED_UNKNOWN',
  'FAILED_AUTHORITY_CONSUMED', 'RECONCILE_REQUIRED',
]);
/** An action from one of these says the lane is occupied and nothing was ever seen on it. */
const UNOBSERVED_ACTIONS = Object.freeze([
  'LANE_CLAIMED_UNOBSERVED', 'LANE_RUNNING_UNOBSERVED', 'STATE_UNRECOGNISED',
]);

/** Every sentence this module can ever emit, named. Nothing outside it can reach an operator. */
export const ACTIVITY_CODES = Object.freeze(Object.keys(TEMPLATES).sort());

export class ControlRoomActivityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlRoomActivityError';
    this.code = code;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
/**
 * An instant must be the exact spelling this product emits, so a partial or locale date cannot be
 * leniently widened into a confident one. Checked by pattern plus `Date.parse` rather than by
 * round-tripping through the Date constructor, because this module owns no clock and the gate
 * that asserts so scans for that constructor by name.
 */
const EXACT_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const isExactInstant = (value) => typeof value === 'string'
  && EXACT_INSTANT.test(value) && Number.isFinite(Date.parse(value));
const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const byteLength = (value) => new TextEncoder().encode(value).length;

/**
 * The producer's own identity. `rulesRevision` digests the phrasebook, the slot precedence, the
 * freshness ranks and the caps, so two identical sentences produced by two different rule sets
 * stay distinguishable and a reviewer can tell a wording change from a world change.
 */
export const CONTROL_ROOM_ACTIVITY_MACHINE = Object.freeze({
  machineId: 'gaia.control-room-activity',
  machineVersion: 1,
  rulesRevision: sha256(canonicalJson({
    actionCodes: ACTION_CODES,
    blockedDrainStates: BLOCKED_DRAIN_STATES,
    caps: {
      bullets: MAX_BULLETS_PER_ITEM,
      bytes: MAX_ACTIVITY_BYTES,
      items: MAX_ACTIVITY_ITEMS,
      text: MAX_BULLET_TEXT_CHARS,
    },
    checkpointCodes: CHECKPOINT_CODES,
    evidenceRank: EVIDENCE_RANK,
    kinds: ACTIVITY_BULLET_KINDS,
    livenessRank: LIVENESS_RANK,
    progressIsVerified: PROGRESS_IS_VERIFIED,
    resultCodes: RESULT_CODES,
    slots: SLOTS,
    sources: ACTIVITY_SOURCES,
    stageSentences: STAGE_SENTENCES,
    states: ACTIVITY_EVIDENCE_STATES,
    templates: TEMPLATES,
    unobservedActions: UNOBSERVED_ACTIONS,
  })),
});

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/**
 * A published snapshot is evidence, so it is verified rather than trusted. The whole summary is
 * derived from `snapshot.revision`; a value whose content moved under that digest, or which
 * claims an effect or an authority, produces nothing at all rather than three confident
 * sentences about a projection nobody can reproduce.
 */
function requireSnapshot(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema !== CONTROL_ROOM_SCHEMA
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || !Array.isArray(value.items)
      || typeof value.revision !== 'string'
      || typeof value.observedAt !== 'string'
      || typeof value.sourceRevision !== 'string'
      || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new ControlRoomActivityError(
      'InvalidSnapshot', 'an authority-free Gaia control-room snapshot is required',
    );
  }
  const { revision, ...body } = value;
  if (revision !== sha256(canonicalJson(body))) {
    throw new ControlRoomActivityError(
      'InvalidSnapshot', 'the control-room snapshot revision does not match its content',
    );
  }
  return value;
}

/** Anything that is not already a closed token is named as unrecognised, never interpolated. */
const asToken = (value) => (typeof value === 'string' && TOKEN.test(value) ? value : UNRECOGNISED);

const asEvidence = (value) => (
  typeof value === 'string' && (REVISION.test(value) || value === UNKNOWN_EVIDENCE)
    ? value : UNKNOWN_EVIDENCE
);

/**
 * One interpolation rule, and the renderer holds the identical one.
 *
 * `values[key] !== undefined` is the load-bearing half. Substituting on `Object.hasOwn` alone let a
 * `params.stage` outside `STAGE_SENTENCES` interpolate the literal string `undefined`, and the
 * exported verifier then ACCEPTED a sentence the producer can never emit — the closed-phrasebook
 * property is exactly what a third party is supposed to be able to check here.
 */
function interpolate(template, values) {
  return template.replaceAll(
    /\{([a-zA-Z]+)\}/gu,
    (whole, key) => (Object.hasOwn(values, key) && values[key] !== undefined ? values[key] : whole),
  );
}

function bullet({
  kind, code, source, verified, params = {}, extra = {},
  evidenceRevision = null, observedAt = null,
}) {
  return {
    kind,
    code,
    source,
    verified,
    params,
    text: interpolate(TEMPLATES[code], { ...params, ...extra }),
    evidenceRevision,
    observedAt,
  };
}

function actionBullet(entry, snapshot) {
  const { telemetry, activity } = entry;
  if (telemetry !== null) {
    const transition = telemetry.lastTransition ?? null;
    const bound = {
      source: 'TELEMETRY',
      verified: true,
      evidenceRevision: transition === null ? UNKNOWN_EVIDENCE : asEvidence(transition.evidenceRevision),
      observedAt: transition === null ? null : transition.observedAt,
    };
    const code = ACTION_CODES[telemetry.runState];
    if (code === undefined) {
      return bullet({
        kind: 'ACTION', code: 'STATE_UNRECOGNISED', ...bound,
        params: { runState: asToken(telemetry.runState) },
      });
    }
    if (code === 'IN_GATE') {
      return bullet({
        kind: 'ACTION', code, ...bound, params: { gate: asToken(telemetry.currentGate) },
      });
    }
    if (code === 'RUN_BLOCKED') {
      return bullet({
        kind: 'ACTION', code, ...bound, params: { blocker: asToken(telemetry.blocker) },
      });
    }
    return bullet({ kind: 'ACTION', code, ...bound });
  }
  if (typeof activity.stage === 'string') {
    // The one unverified source in the product. It binds no digest and no instant this publisher
    // can check, and both absences are stated rather than papered over.
    const stage = asToken(activity.stage.toUpperCase());
    const sentence = STAGE_SENTENCES[stage];
    if (sentence === undefined) {
      return bullet({
        kind: 'ACTION',
        code: 'PROGRESS_STAGE_UNRECOGNISED',
        source: 'PROGRESS',
        verified: PROGRESS_IS_VERIFIED,
      });
    }
    return bullet({
      kind: 'ACTION',
      code: 'PROGRESS_STAGE',
      source: 'PROGRESS',
      verified: PROGRESS_IS_VERIFIED,
      params: { stage },
      extra: { sentence },
    });
  }
  return bullet({
    kind: 'ACTION',
    code: entry.drainState === 'CLAIMED' ? 'LANE_CLAIMED_UNOBSERVED' : 'LANE_RUNNING_UNOBSERVED',
    source: 'DRAIN',
    verified: true,
    evidenceRevision: snapshot.sourceRevision,
  });
}

/**
 * The last verified transition, or the explicit absence of one. An unverified source can never
 * reach this slot: `NO_VERIFIED_RESULT` is a named absence, which an operator can act on, where a
 * blank is only a gap they have to notice.
 */
function resultBullet(entry, snapshot) {
  const transition = entry.telemetry?.lastTransition ?? null;
  const code = transition === null ? undefined : RESULT_CODES[transition.event];
  if (code === undefined) {
    return bullet({
      kind: 'RESULT',
      code: 'NO_VERIFIED_RESULT',
      source: 'DRAIN',
      verified: true,
      evidenceRevision: snapshot.sourceRevision,
    });
  }
  const bound = {
    source: 'TELEMETRY',
    verified: true,
    evidenceRevision: asEvidence(transition.evidenceRevision),
    observedAt: transition.observedAt,
  };
  if (code === 'RUN_BLOCKED_RESULT') {
    return bullet({
      kind: 'RESULT', code, ...bound, params: { blocker: asToken(entry.telemetry.blocker) },
    });
  }
  if (code === 'GATE_ENTERED' || code === 'GATE_PASSED' || code === 'GATE_FAILED') {
    return bullet({ kind: 'RESULT', code, ...bound, params: { gate: asToken(transition.gate) } });
  }
  return bullet({ kind: 'RESULT', code, ...bound });
}

/**
 * Slot three. A blocker displaces the checkpoint because the machine says so: the spine admits
 * no transition out of `BLOCKED`, so there is literally no next evidence to name and printing one
 * would be a fabricated expectation. Staleness is deliberately not a blocker — it is already
 * carried by the evidence state and by the existing blocker mix, and spending this slot on it
 * would suppress the checkpoint an operator needs in order to know whether the run can recover.
 */
function closingBullet(entry, snapshot) {
  const { telemetry } = entry;
  if (telemetry !== null && telemetry.runState === 'BLOCKED') {
    const transition = telemetry.lastTransition ?? null;
    return bullet({
      kind: 'BLOCKER',
      code: 'TELEMETRY_BLOCKED',
      source: 'TELEMETRY',
      verified: true,
      params: { blocker: asToken(telemetry.blocker) },
      evidenceRevision: transition === null
        ? UNKNOWN_EVIDENCE : asEvidence(transition.evidenceRevision),
      observedAt: transition === null ? null : transition.observedAt,
    });
  }
  if (BLOCKED_DRAIN_STATES.includes(entry.drainState)) {
    return bullet({
      kind: 'BLOCKER',
      code: 'DRAIN_BLOCKED',
      source: 'DRAIN',
      verified: true,
      params: { drainState: asToken(entry.drainState) },
      evidenceRevision: snapshot.sourceRevision,
    });
  }
  const code = telemetry === null ? undefined : CHECKPOINT_CODES[telemetry.runState];
  if (code === undefined) {
    return bullet({
      kind: 'CHECKPOINT',
      code: 'AWAIT_RUN_STARTED',
      source: 'DRAIN',
      verified: true,
    });
  }
  const transition = telemetry.lastTransition ?? null;
  return bullet({
    kind: 'CHECKPOINT',
    code,
    source: 'TELEMETRY',
    verified: true,
    params: code === 'AWAIT_GATE_OUTCOME' ? { gate: asToken(telemetry.currentGate) } : {},
    observedAt: transition === null ? null : transition.observedAt,
  });
}

function summarizeItem(entry, snapshot, observedAtMs) {
  const drafted = [actionBullet(entry, snapshot), resultBullet(entry, snapshot), closingBullet(entry, snapshot)];
  const unobserved = UNOBSERVED_ACTIONS.includes(drafted[0].code);
  const bullets = drafted.map((draft) => {
    if (draft.observedAt !== null && Date.parse(draft.observedAt) > observedAtMs) {
      throw new ControlRoomActivityError(
        'IncoherentEvidence',
        `evidence dated ${draft.observedAt} is after the instant the snapshot was observed`,
      );
    }
    const evidenceState = unobserved ? 'UNKNOWN'
      : entry.activity.state === 'STALE' ? 'STALE'
        : !draft.verified || draft.evidenceRevision === UNKNOWN_EVIDENCE ? 'PARTIAL' : 'FRESH';
    return { ...draft, evidenceState };
  });
  const evidenceState = bullets.reduce(
    (worst, one) => (EVIDENCE_RANK[one.evidenceState] > EVIDENCE_RANK[worst]
      ? one.evidenceState : worst),
    'FRESH',
  );
  return {
    itemId: entry.itemId,
    repository: entry.repository,
    itemNumber: entry.itemNumber,
    drainState: entry.drainState,
    runId: entry.telemetry?.runId ?? null,
    lane: entry.telemetry?.lane ?? null,
    agent: entry.telemetry?.agent ?? null,
    evidenceState,
    bullets,
  };
}

/**
 * The one ordering that decides which item is "the current run", exported so the renderer uses it
 * rather than a second comparator of its own.
 *
 * There were two. This module took `activity.items[0]` as the Current run card's subject while the
 * renderer sorted the same items with an extra lifecycle-percentage key and `localeCompare` where
 * this one uses ordinal comparison, so one page could name `issue-3` the current run and `issue-7`
 * the highest-priority work. The percentage key is dropped rather than copied across: it ranks a
 * RUNNING item above a CLAIMED one for a reason that has nothing to do with liveness, and liveness
 * is what the card is about.
 */
export function compareControlRoomItems(left, right) {
  return (LIVENESS_RANK[left.activity?.state] ?? 3) - (LIVENESS_RANK[right.activity?.state] ?? 3)
    || ordinal(left.repository, right.repository)
    || left.itemNumber - right.itemNumber
    || ordinal(left.itemId, right.itemId);
}

/** A live task: not finished, and either holding a lane or carrying an observed run. */
const isLiveTask = (entry) => !TERMINAL_DRAIN_STATES.includes(entry.drainState)
  && (OCCUPIED_DRAIN_STATES.includes(entry.drainState) || entry.telemetry != null);

/**
 * Read one published control-room snapshot and say, for each live task, what it is doing, what it
 * last produced, and what would count as the next evidence.
 */
export function summarizeControlRoomActivity({ snapshot } = {}) {
  const verified = requireSnapshot(snapshot);
  const at = verified.observedAt;
  const observedAtMs = Date.parse(at);
  const selected = verified.items.filter(isLiveTask).sort(compareControlRoomItems);
  const items = selected
    .slice(0, MAX_ACTIVITY_ITEMS)
    .map((entry) => summarizeItem(entry, verified, observedAtMs));
  const counts = { fresh: 0, partial: 0, stale: 0, unknown: 0, items: items.length };
  for (const { evidenceState } of items) counts[evidenceState.toLowerCase()] += 1;

  const body = {
    schema: CONTROL_ROOM_ACTIVITY_SCHEMA,
    machine: CONTROL_ROOM_ACTIVITY_MACHINE,
    effect: 'NONE',
    authority: 'NONE',
    snapshotRevision: verified.revision,
    sourceRevision: verified.sourceRevision,
    telemetryRevision: verified.telemetry?.projectionRevision ?? null,
    observedAt: at,
    freshnessWindowMs: verified.telemetry?.freshnessWindowMs ?? null,
    items,
    omittedCount: selected.length - items.length,
    counts,
    // Deliberately not over the whole body: the sentences, and only the sentences.
    contentRevision: sha256(canonicalJson({ items, machine: CONTROL_ROOM_ACTIVITY_MACHINE })),
  };
  const value = { ...body, revision: sha256(canonicalJson(body)) };
  const size = byteLength(canonicalJson(value));
  if (size > MAX_ACTIVITY_BYTES) {
    throw new ControlRoomActivityError(
      'ActivityTooLarge',
      `the activity summary is ${size} bytes, above the ${MAX_ACTIVITY_BYTES}-byte budget`,
    );
  }
  return deepFreeze(value);
}

/**
 * Total verification of one published `gaia-control-room-activity/1` value, on its own terms.
 *
 * Exported so a machine consumer reading the published file is no more credulous than the
 * renderer displaying it. Binding to a particular snapshot is a separate question and is decided
 * by whoever holds that snapshot; this says only that the value is internally honest.
 */
export function requireControlRoomActivity(value) {
  const refuse = (message) => {
    throw new ControlRoomActivityError('InvalidActivity', message);
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema !== CONTROL_ROOM_ACTIVITY_SCHEMA
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || !Array.isArray(value.items) || typeof value.revision !== 'string'
      || typeof value.contentRevision !== 'string'
      || canonicalJson(value.machine) !== canonicalJson(CONTROL_ROOM_ACTIVITY_MACHINE)) {
    refuse('an authority-free Gaia control-room activity summary is required');
  }
  if (value.items.length > MAX_ACTIVITY_ITEMS || !Number.isSafeInteger(value.omittedCount)
      || value.omittedCount < 0) {
    refuse('the activity summary exceeds its declared item bounds');
  }
  if (!isExactInstant(value.observedAt)) {
    refuse('the activity observation instant is not an exact ISO timestamp');
  }
  for (const entry of value.items) {
    if (!Array.isArray(entry?.bullets) || entry.bullets.length !== MAX_BULLETS_PER_ITEM
        || !ACTIVITY_EVIDENCE_STATES.includes(entry.evidenceState)) {
      refuse('an activity item does not carry exactly three bullets and one evidence state');
    }
    for (const one of entry.bullets) {
      if (!ACTIVITY_BULLET_KINDS.includes(one?.kind) || !ACTIVITY_CODES.includes(one?.code)
          || !ACTIVITY_SOURCES.includes(one?.source)
          || !ACTIVITY_EVIDENCE_STATES.includes(one?.evidenceState)
          || typeof one?.verified !== 'boolean'
          || typeof one?.text !== 'string' || one.text.length > MAX_BULLET_TEXT_CHARS
          || one.text !== interpolate(TEMPLATES[one.code], {
            ...one.params,
            sentence: STAGE_SENTENCES[one.params?.stage],
          })) {
        refuse('an activity bullet is not a sentence this phrasebook can author');
      }
      for (const parameter of Object.values(one.params)) {
        if (typeof parameter !== 'string' || !TOKEN.test(parameter)) {
          refuse('an activity bullet interpolates a value that is not a closed token');
        }
      }
      // Two fields the phrasebook does not author and this verifier used not to look at. They are
      // published, rendered, and were free text: a resealed summary carried a URL, a local path
      // and key-shaped material to the operator's screen through them. Escaping held, so this was
      // never an injection — it was a provenance failure, which is worse to leave undocumented.
      if (one.evidenceRevision !== null && !REVISION.test(one.evidenceRevision ?? '')
          && one.evidenceRevision !== UNKNOWN_EVIDENCE) {
        refuse('an activity bullet evidence revision is neither a digest nor the honest UNKNOWN');
      }
      if (one.observedAt !== null && !isExactInstant(one.observedAt)) {
        refuse('an activity bullet instant is not an exact ISO timestamp');
      }
      // The producer refuses evidence dated after the instant it was observed. A verifier weaker
      // than its producer on a rule the producer will not bend is not a verifier: downstream, the
      // age is a subtraction that clamps, so year-2999 evidence rendered as `0s ago`.
      if (one.observedAt !== null && Date.parse(one.observedAt) > Date.parse(value.observedAt)) {
        refuse('an activity bullet is dated after the instant the summary was observed');
      }
    }
  }
  const { revision, ...body } = value;
  const { contentRevision, ...rest } = body;
  if (contentRevision !== sha256(canonicalJson({
    items: rest.items, machine: rest.machine,
  }))) {
    refuse('the activity content revision does not match the sentences it covers');
  }
  if (revision !== sha256(canonicalJson(body))) {
    refuse('the activity revision does not match its content');
  }
  if (byteLength(canonicalJson(value)) > MAX_ACTIVITY_BYTES) {
    refuse('the activity summary is above its declared byte budget');
  }
  return value;
}
