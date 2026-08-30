/**
 * portfolio-drain-obstruction.mjs — why a drain is not draining, from evidence alone.
 *
 * The control room can already say that nothing is moving. It could not say why. `PAUSED` was
 * emitted identically for an EMPTY drain, where every item is terminal and the pause is the
 * correct resting state, and for a systemically BLOCKED drain, where real work exists and every
 * path out of the queue is closed. Those are operationally opposite and were visually identical.
 *
 * This Module reads one already reconciled `gaia-portfolio-drain-projection/1` and names exactly
 * one obstruction from a closed vocabulary of nine states. It reconciles nothing, re-measures no
 * heartbeat, owns no clock, opens no socket, calls no provider, retries nothing and adds no bus
 * verb. `effect` and `authority` are `NONE`, and its recovery action is one sentence of advice
 * bound to evidence — never an instruction the machine executes.
 *
 * THE THREE RULES THAT DECIDE EVERY ANSWER
 * ----------------------------------------
 * 1. **Fail closed to a named state, never to health.** A drain state this vocabulary does not
 *    recognise is an evidence gap, not an absence of a problem. A claimed or running lane with
 *    no liveness evidence is stale, because no heartbeat evidence is not evidence of a heartbeat.
 * 2. **A cycle comes only from declared edges.** A title, body, label or model output is never
 *    read as a dependency. A source state that merely CLAIMS a dependency proves no cycle, so it
 *    is an evidence gap until explicit edges say otherwise.
 * 3. **Every non-`NONE` answer binds its evidence.** The exact projection revision it was derived
 *    from, the observation window it was measured over, the affected item ids and their count,
 *    and exactly one bounded advisory recovery action.
 *
 * The design decision, its rejected alternatives, its falsifiers and its rejection criterion are
 * in `docs/portfolio-drain-obstruction-design.md`.
 */

import { createHash } from 'node:crypto';

export const PORTFOLIO_DRAIN_OBSTRUCTION_SCHEMA = 'gaia-portfolio-drain-obstruction/1';

/** The closed vocabulary. No other value is ever reported. */
export const PORTFOLIO_DRAIN_OBSTRUCTION_STATES = Object.freeze([
  'NONE',
  'NO_ELIGIBLE_WORK',
  'EVIDENCE_STARVATION',
  'LANE_STALE',
  'DEPENDENCY_DEADLOCK',
  'REVIEW_STARVATION',
  'AUTHORITY_STARVATION',
  'RECONCILE_REQUIRED',
  'THROUGHPUT_STALL',
]);

/**
 * How long eligible work and free capacity must sit unchanged before the stall is a measured
 * claim rather than an impatient one.
 *
 * Fixed, not a parameter. A configurable threshold would make `THROUGHPUT_STALL` mean something
 * different depending on the arguments it was produced with, which is the same reason
 * `inventory-digest/1` refuses an exclusion flag. Below this window the answer is `NONE` — "no
 * obstruction detectable yet", not "healthy" — and the window that produced it is bound into the
 * result so a reviewer can see exactly how long was observed.
 */
export const THROUGHPUT_STALL_WINDOW_MS = 300_000;

/** Terminal work obstructs nothing, and this prefix is the only thing that says so. */
const TERMINAL_STATE_PREFIX = 'TERMINAL_';

/** An occupied lane nobody can see is stale. Absence of evidence is never evidence of health. */
const UNOBSERVED_LANE_LIVENESS = 'STALE';

const LANE_STATES = new Set(['CLAIMED', 'RUNNING']);
const ELIGIBLE_STATES = new Set(['QUEUED']);
const LIVENESS_STATES = new Set(['ACTIVE', 'STALE', 'IDLE']);

/**
 * Which starvation each blocked drain state belongs to. `BLOCKED_DEPENDENCY` is deliberately an
 * evidence gap rather than a deadlock: the source claims a dependency and Gaia holds no declared
 * edge that could confirm or refute it. Anything absent from this map is also an evidence gap.
 */
const STARVATION_CLASS = Object.freeze({
  BLOCKED_EVIDENCE: 'EVIDENCE_STARVATION',
  BLOCKED_UNKNOWN: 'EVIDENCE_STARVATION',
  BLOCKED_TRIAGE: 'EVIDENCE_STARVATION',
  BLOCKED_DEPENDENCY: 'EVIDENCE_STARVATION',
  BLOCKED_REVIEW: 'REVIEW_STARVATION',
  BLOCKED_DRAFT: 'REVIEW_STARVATION',
  BLOCKED_HUMAN: 'AUTHORITY_STARVATION',
  BLOCKED_POLICY: 'AUTHORITY_STARVATION',
  AWAITING_MERGE_AUTHORITY: 'AUTHORITY_STARVATION',
  PUBLISHED: 'AUTHORITY_STARVATION',
  FAILED_AUTHORITY_CONSUMED: 'AUTHORITY_STARVATION',
});

/**
 * States that obstruct nothing and therefore contribute to no starvation bucket.
 *
 * `CANDIDATE_READY` is here because the drain already offers it an authority-free
 * `PREPARE_PUBLICATION_INTENT` decision: it is actionable work, not starved work.
 */
const UNOBSTRUCTED_STATES = new Set(['CANDIDATE_READY']);

/**
 * Nearest the exit first. Fixed precedence rather than ranking by count, so the reported cause
 * never depends on a majority vote among unrelated problems; the full breakdown is carried
 * alongside so a larger contributing cause is never hidden.
 */
const STARVATION_PRECEDENCE = Object.freeze([
  'AUTHORITY_STARVATION', 'REVIEW_STARVATION', 'EVIDENCE_STARVATION',
]);

export class ObstructionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ObstructionError';
    this.code = code;
  }
}

const ordinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

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

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

/** Whole seconds, then minutes: the same wording the control room already uses. */
function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

const plural = (count, singular, many) => (count === 1 ? singular : many);

/** The projection is evidence, so it is verified rather than trusted. */
function requireProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || value.schema !== 'gaia-portfolio-drain-projection/1'
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || !Array.isArray(value.items) || !Array.isArray(value.decisions)
      || !value.counts || typeof value.counts !== 'object'
      || !Number.isSafeInteger(value.counts.occupied)
      || !Number.isSafeInteger(value.counts.available)) {
    throw new ObstructionError(
      'InvalidProjection', 'an authority-free Gaia portfolio-drain projection is required',
    );
  }
  const { revision, ...body } = value;
  if (typeof revision !== 'string' || revision !== sha256(canonicalJson(body))) {
    throw new ObstructionError(
      'InvalidProjection', 'the portfolio-drain projection revision does not match its content',
    );
  }
  for (const item of value.items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
        || typeof item.itemId !== 'string' || item.itemId.length === 0
        || typeof item.drainState !== 'string' || item.drainState.length === 0) {
      throw new ObstructionError(
        'InvalidProjection', 'every projected item must carry an item id and a drain state',
      );
    }
  }
  return value;
}

/**
 * The measured observation window, `[startedAt, endedAt]`.
 *
 * A window that ends before it starts is refused: evidence dated after the instant it was
 * observed is a forged or misconfigured sensor, never news.
 */
function requireWindow(windowStartedAt, observedAt) {
  const startedMs = Date.parse(windowStartedAt);
  const endedMs = Date.parse(observedAt);
  if (typeof windowStartedAt !== 'string' || typeof observedAt !== 'string'
      || !Number.isFinite(startedMs) || !Number.isFinite(endedMs) || startedMs > endedMs) {
    throw new ObstructionError(
      'InvalidWindow',
      'the observation window needs two ISO instants and cannot end before it starts',
    );
  }
  return {
    startedAt: windowStartedAt, endedAt: observedAt, durationMs: endedMs - startedMs,
  };
}

/** Liveness is decided by the caller that measured it; an undecided token is refused. */
function requireLiveness(liveness, itemIds) {
  if (!Array.isArray(liveness)) {
    throw new ObstructionError('InvalidLiveness', 'liveness must be an array');
  }
  const decided = new Map();
  for (const entry of liveness) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
        || typeof entry.itemId !== 'string' || !LIVENESS_STATES.has(entry.state)) {
      throw new ObstructionError(
        'InvalidLiveness', 'each liveness entry must name an item and one of ACTIVE, STALE, IDLE',
      );
    }
    if (!itemIds.has(entry.itemId)) {
      throw new ObstructionError(
        'InvalidLiveness', `liveness names ${entry.itemId}, which this projection does not carry`,
      );
    }
    if (decided.has(entry.itemId)) {
      throw new ObstructionError(
        'InvalidLiveness', `conflicting liveness entries for ${entry.itemId}`,
      );
    }
    decided.set(entry.itemId, entry.state);
  }
  return decided;
}

/**
 * Declared dependency edges, and nothing else. An edge naming an item outside this projection is
 * refused rather than dropped: it is evidence about a drain this call is not classifying.
 */
function requireDependencies(dependencies, itemIds) {
  if (dependencies === null || dependencies === undefined) {
    return { evidenceRevision: null, edges: [] };
  }
  if (typeof dependencies !== 'object' || Array.isArray(dependencies)
      || typeof dependencies.evidenceRevision !== 'string'
      || !/^[a-f0-9]{64}$/u.test(dependencies.evidenceRevision)
      || !Array.isArray(dependencies.edges)) {
    throw new ObstructionError(
      'InvalidDependencyEvidence',
      'declared dependencies need an exact SHA-256 evidence revision and an edge array',
    );
  }
  const edges = [];
  for (const edge of dependencies.edges) {
    if (!edge || typeof edge !== 'object' || Array.isArray(edge)
        || typeof edge.itemId !== 'string' || typeof edge.dependsOnItemId !== 'string') {
      throw new ObstructionError(
        'InvalidDependencyEvidence', 'each declared edge needs itemId and dependsOnItemId',
      );
    }
    if (!itemIds.has(edge.itemId) || !itemIds.has(edge.dependsOnItemId)) {
      throw new ObstructionError(
        'InvalidDependencyEvidence',
        `declared edge ${edge.itemId} -> ${edge.dependsOnItemId} names an item this projection `
        + 'does not carry',
      );
    }
    edges.push({ itemId: edge.itemId, dependsOnItemId: edge.dependsOnItemId });
  }
  return { evidenceRevision: dependencies.evidenceRevision, edges };
}

/**
 * Every item that lies on a directed cycle of declared edges, restricted to non-terminal items.
 *
 * Iterative Tarjan strongly-connected components: a component with more than one member is a
 * cycle, and a single member is one only when it declares an edge to itself. Terminal items are
 * removed first, because work that has already ended cannot be waiting on anything.
 */
function itemsInDeclaredCycles(edges, liveItemIds) {
  const adjacency = new Map([...liveItemIds].map((itemId) => [itemId, []]));
  let selfDependent = new Set();
  for (const { itemId, dependsOnItemId } of edges) {
    if (!liveItemIds.has(itemId) || !liveItemIds.has(dependsOnItemId)) continue;
    if (itemId === dependsOnItemId) selfDependent = new Set([...selfDependent, itemId]);
    adjacency.get(itemId).push(dependsOnItemId);
  }
  const index = new Map();
  const lowLink = new Map();
  const onStack = new Set();
  const stack = [];
  const cyclic = new Set(selfDependent);
  let counter = 0;
  for (const root of adjacency.keys()) {
    if (index.has(root)) continue;
    const frame = [{ node: root, next: 0 }];
    index.set(root, counter);
    lowLink.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (frame.length > 0) {
      const top = frame.at(-1);
      const neighbours = adjacency.get(top.node);
      if (top.next < neighbours.length) {
        const neighbour = neighbours[top.next];
        top.next += 1;
        if (!index.has(neighbour)) {
          index.set(neighbour, counter);
          lowLink.set(neighbour, counter);
          counter += 1;
          stack.push(neighbour);
          onStack.add(neighbour);
          frame.push({ node: neighbour, next: 0 });
        } else if (onStack.has(neighbour)) {
          lowLink.set(top.node, Math.min(lowLink.get(top.node), index.get(neighbour)));
        }
        continue;
      }
      frame.pop();
      const parent = frame.at(-1);
      if (parent) {
        lowLink.set(parent.node, Math.min(lowLink.get(parent.node), lowLink.get(top.node)));
      }
      if (lowLink.get(top.node) === index.get(top.node)) {
        const component = [];
        for (let member = stack.pop(); ; member = stack.pop()) {
          onStack.delete(member);
          component.push(member);
          if (member === top.node) break;
        }
        if (component.length > 1) for (const member of component) cyclic.add(member);
      }
    }
  }
  return cyclic;
}

const RECOVERY = Object.freeze({
  NO_ELIGIBLE_WORK: (count) => ({
    kind: 'SURVEY_PORTFOLIO_FOR_NEW_WORK',
    label: 'Run one read-only portfolio survey: nothing in this drain is eligible to move'
      + `${count === 0 ? '' : `, and all ${count} recorded ${plural(count, 'item has', 'items have')} ended`}.`,
  }),
  EVIDENCE_STARVATION: (count) => ({
    kind: 'COLLECT_MISSING_EVIDENCE',
    label: `Collect the missing check or review evidence for the ${count} named `
      + `${plural(count, 'item', 'items')}, then reconcile the drain again.`,
  }),
  LANE_STALE: (count) => ({
    kind: 'CHECK_STALE_LANE',
    label: `Check the ${count} named ${plural(count, 'lane', 'lanes')} whose heartbeat evidence `
      + 'expired, and reconcile before recording another transition.',
  }),
  DEPENDENCY_DEADLOCK: (count) => ({
    kind: 'BREAK_DEPENDENCY_CYCLE',
    label: `Withdraw one declared dependency edge among the ${count} named `
      + `${plural(count, 'item', 'items')}; time alone cannot resolve a cycle.`,
  }),
  REVIEW_STARVATION: (count) => ({
    kind: 'REQUEST_INDEPENDENT_REVIEW',
    label: `Request one independent review for the ${count} named `
      + `${plural(count, 'item', 'items')}.`,
  }),
  AUTHORITY_STARVATION: (count) => ({
    kind: 'REQUEST_EXPLICIT_AUTHORITY',
    label: `Ask a human for the explicit grant the ${count} named `
      + `${plural(count, 'item is', 'items are')} waiting on.`,
  }),
  RECONCILE_REQUIRED: (count) => ({
    kind: 'RECONCILE_DRAIN_EVIDENCE',
    label: `Re-observe the ${count} named ${plural(count, 'item', 'items')} and reconcile the `
      + 'receipt chain before recording another transition.',
  }),
  THROUGHPUT_STALL: (count, durationMs) => ({
    kind: 'CLAIM_QUEUED_WORK',
    label: `Authorize one bounded factory run: ${count} eligible `
      + `${plural(count, 'item', 'items')} and free capacity have not moved for `
      + `${formatDuration(durationMs)}.`,
  }),
});

const LABEL = Object.freeze({
  NONE: () => 'No obstruction is detectable from this evidence over this window.',
  NO_ELIGIBLE_WORK: () => 'The drain is empty: no work item is eligible to move.',
  EVIDENCE_STARVATION: (count) => `${count} ${plural(count, 'item is', 'items are')} blocked `
    + 'awaiting evidence Gaia does not hold.',
  LANE_STALE: (count) => `${count} occupied ${plural(count, 'lane has', 'lanes have')} no live `
    + 'heartbeat evidence.',
  DEPENDENCY_DEADLOCK: (count) => `${count} ${plural(count, 'item lies', 'items lie')} on a `
    + 'declared dependency cycle.',
  REVIEW_STARVATION: (count) => `${count} ${plural(count, 'item is', 'items are')} waiting for a `
    + 'review that has not arrived.',
  AUTHORITY_STARVATION: (count) => `${count} ${plural(count, 'item is', 'items are')} waiting on `
    + 'an explicit authority grant.',
  RECONCILE_REQUIRED: (count) => `${count} ${plural(count, 'item has', 'items have')} recorded `
    + 'evidence that contradicts the current observation.',
  THROUGHPUT_STALL: (count, durationMs) => `${count} eligible `
    + `${plural(count, 'item and', 'items and')} free capacity have not moved for `
    + `${formatDuration(durationMs)}.`,
});

/**
 * Name the one obstruction standing between this drain and its next transition.
 *
 * Pure: same inputs, same content-addressed answer, no input mutated. Exactly one state is
 * reported, chosen in the precedence recorded in the design document — reconcile, stale lane,
 * live motion, declared deadlock, measured stall, empty drain, then the starvations nearest the
 * exit first.
 *
 * @param {object} input
 * @param {object} input.drainProjection exact `gaia-portfolio-drain-projection/1`.
 * @param {string} input.observedAt ISO instant the window ends.
 * @param {string} input.windowStartedAt ISO instant the window starts.
 * @param {Array<{itemId: string, state: string}>} [input.liveness] decided lane liveness.
 * @param {{evidenceRevision: string, edges: Array}|null} [input.dependencies] declared edges.
 */
export function classifyPortfolioDrainObstruction({
  drainProjection, observedAt, windowStartedAt, liveness = [], dependencies = null,
}) {
  const projection = requireProjection(drainProjection);
  const observationWindow = requireWindow(windowStartedAt, observedAt);
  const itemIds = new Set(projection.items.map(({ itemId }) => itemId));
  const decidedLiveness = requireLiveness(liveness, itemIds);
  const declared = requireDependencies(dependencies, itemIds);

  const live = projection.items.filter(
    ({ drainState }) => !drainState.startsWith(TERMINAL_STATE_PREFIX),
  );
  const liveItemIds = new Set(live.map(({ itemId }) => itemId));
  const idsOf = (items) => [...new Set(items.map(({ itemId }) => itemId))].sort(ordinal);

  const reconcile = live.filter(({ drainState }) => drainState === 'RECONCILE_REQUIRED');
  const lanes = live.filter(({ drainState }) => LANE_STATES.has(drainState));
  const staleLanes = lanes.filter(
    ({ itemId }) => (decidedLiveness.get(itemId) ?? UNOBSERVED_LANE_LIVENESS) === 'STALE',
  );
  // Liveness is a property of lanes. A terminal, blocked, candidate or queued item can carry
  // an ACTIVE token — a merged pull request whose worker has not yet reported completion is
  // ordinary — and none of them is the drain draining. Scoping this to every item let one
  // stray token report a fully blocked drain as healthy, which Rule 1 forbids.
  const moving = lanes.some(({ itemId }) => decidedLiveness.get(itemId) === 'ACTIVE');
  const cyclic = itemsInDeclaredCycles(declared.edges, liveItemIds);
  const cycleItems = live.filter(({ itemId }) => cyclic.has(itemId));
  const eligible = live.filter(({ drainState }) => ELIGIBLE_STATES.has(drainState));
  const stalled = eligible.length > 0 && projection.counts.available > 0 && !moving
    && observationWindow.durationMs >= THROUGHPUT_STALL_WINDOW_MS;

  // Anything not recognised above is an evidence gap: an unclassifiable state is never health.
  const starving = new Map(STARVATION_PRECEDENCE.map((state) => [state, []]));
  for (const item of live) {
    if (item.drainState === 'RECONCILE_REQUIRED' || LANE_STATES.has(item.drainState)
        || ELIGIBLE_STATES.has(item.drainState) || UNOBSTRUCTED_STATES.has(item.drainState)) {
      continue;
    }
    starving.get(STARVATION_CLASS[item.drainState] ?? 'EVIDENCE_STARVATION').push(item);
  }

  const breakdown = [
    ['RECONCILE_REQUIRED', reconcile.length],
    ['LANE_STALE', staleLanes.length],
    ['DEPENDENCY_DEADLOCK', cycleItems.length],
    ['THROUGHPUT_STALL', stalled ? eligible.length : 0],
    ...STARVATION_PRECEDENCE.map((state) => [state, starving.get(state).length]),
  ].filter(([, count]) => count > 0)
    .map(([state, count]) => ({ state, count }))
    .sort((leftEntry, rightEntry) => ordinal(leftEntry.state, rightEntry.state));

  const selected = (() => {
    if (reconcile.length > 0) return ['RECONCILE_REQUIRED', idsOf(reconcile)];
    if (staleLanes.length > 0) return ['LANE_STALE', idsOf(staleLanes)];
    if (moving) return ['NONE', []];
    if (cycleItems.length > 0) return ['DEPENDENCY_DEADLOCK', idsOf(cycleItems)];
    if (stalled) return ['THROUGHPUT_STALL', idsOf(eligible)];
    if (live.length === 0) return ['NO_ELIGIBLE_WORK', []];
    for (const state of STARVATION_PRECEDENCE) {
      if (starving.get(state).length > 0) return [state, idsOf(starving.get(state))];
    }
    return ['NONE', []];
  })();
  const [state, affectedItemIds] = selected;
  const count = state === 'NO_ELIGIBLE_WORK' ? projection.items.length : affectedItemIds.length;

  const body = {
    schema: PORTFOLIO_DRAIN_OBSTRUCTION_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    state,
    evidenceRevision: projection.revision,
    dependencyEvidenceRevision: declared.evidenceRevision,
    observationWindow,
    affectedItemIds,
    affectedCount: affectedItemIds.length,
    label: LABEL[state](count, observationWindow.durationMs),
    recovery: state === 'NONE' ? null : {
      ...RECOVERY[state](count, observationWindow.durationMs),
      effect: 'NONE',
      authority: 'NONE',
      advisory: true,
    },
    breakdown,
  };
  return deepFreeze({ ...body, revision: sha256(canonicalJson(body)) });
}
