/**
 * drain-petri-net.mjs — the pure Petri-net interpreter for the PR drain and the lane lifecycle.
 *
 * WHAT THIS IS
 * ------------
 * Two nets shipped as data (the PR drain and the lane lifecycle), and the evolution rules that
 * move tokens through them. The marking is a pure fold over facts that a collector measured from
 * the durable bus log and the fleet artifacts. Nothing here reads a file, a clock, the
 * environment, a provider, or a database; nothing here fires a transition on a judgement. A
 * transition carries one receptivity id — a named predicate an adapter resolves to `true`,
 * `false`, or `UNKNOWN` — and one named refusal that is reported whenever the predicate does not
 * hold. `UNKNOWN` never fires (fail closed).
 *
 * EVOLUTION RULES
 * ---------------
 * IEC 60848 rules where the drain chart is a sequential function chart, Petri-net rules where a
 * place holds more than one token (the resource places):
 *   1. the initial situation is the initial marking of the net;
 *   2. a transition is enabled when every input place holds at least the arc weight, no inhibitor
 *      place holds a token, and its receptivity is `true`;
 *   3. firing removes the input weights and adds the output weights;
 *   4. every transition enabled on one marking fires in the same step, in priority-then-id order,
 *      except where two of them compete for the same tokens — then the earlier one in that order
 *      fires and the later one is reported as blocked by the resource;
 *   5. a place both emptied and refilled in one step keeps its token (consumption and production
 *      are applied together, and the capacity check is on the resulting marking).
 * Every place has a finite capacity, so the shipped nets are bounded by construction; the
 * reachability check makes that bound explicit.
 *
 * WHAT THIS IS NOT
 * ----------------
 * Not a scheduler, not a ledger, not a permission. `enabled` says the chart admits a transition;
 * `fired` says the evidence shows it happened. Neither grants authority, and no bus verb is added.
 */

import { createHash } from 'node:crypto';

export const DRAIN_PETRI_NET_SCHEMA = 'gaia-drain-petri-net/1';
export const DRAIN_NET_ID = 'gaia.drain-petri-net.pr-drain';
export const LANE_NET_ID = 'gaia.drain-petri-net.lane-lifecycle';

/** The supported live-lane default (ARCHITECTURE.md, "Work lifecycle"). */
export const DEFAULT_PROVIDER_CAPACITY = 4;

export const PLACE_KINDS = Object.freeze(['STEP', 'RESOURCE']);
export const RECEPTIVITY_KINDS = Object.freeze(['LEVEL', 'EDGE', 'CONSTANT']);
export const BLOCK_REASONS = Object.freeze([
  'RECEPTIVITY_FALSE', 'RECEPTIVITY_UNKNOWN', 'INPUT_TOKENS_MISSING', 'RESOURCE_UNAVAILABLE',
  'INHIBITED', 'CAPACITY_EXCEEDED',
]);

export class DrainPetriNetError extends Error {
  constructor(code, message, detail = undefined) {
    super(message);
    this.name = 'DrainPetriNetError';
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

function fail(code, message, detail) {
  throw new DrainPetriNetError(code, message, detail);
}

export const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

export const revisionOf = (value) => `sha256:${createHash('sha256').update(canonicalJson(value)).digest('hex')}`;

const ID = /^[A-Za-z0-9_#./:-]+$/u;
const isId = (value) => typeof value === 'string' && value.length > 0 && value.length <= 200 && ID.test(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isWeight = (value) => Number.isSafeInteger(value) && value >= 1;

const deepFreeze = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
};

const compareIds = (left, right) => (left < right ? -1 : left > right ? 1 : 0);
const byId = (left, right) => compareIds(left.id, right.id);
const byPriorityThenId = (left, right) => (right.priority - left.priority) || byId(left, right);

// ---------------------------------------------------------------------------
// net definition
// ---------------------------------------------------------------------------

function normalizeArcs(list, field, transitionId, places) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) fail('NetInvalid', `${transitionId}.${field} must be a list`);
  const seen = new Set();
  return list.map((arc) => {
    const entry = typeof arc === 'string' ? { place: arc, weight: 1 } : arc;
    if (!entry || typeof entry !== 'object' || !isId(entry.place)) {
      fail('NetInvalid', `${transitionId}.${field} names an invalid place`);
    }
    if (!places.has(entry.place)) fail('NetInvalid', `${transitionId}.${field} names an unknown place ${entry.place}`);
    const weight = entry.weight === undefined ? 1 : entry.weight;
    if (!isWeight(weight)) fail('NetInvalid', `${transitionId}.${field}.${entry.place} weight must be a positive integer`);
    if (seen.has(entry.place)) fail('NetInvalid', `${transitionId}.${field} names ${entry.place} twice`);
    seen.add(entry.place);
    return { place: entry.place, weight };
  }).sort((left, right) => compareIds(left.place, right.place));
}

/**
 * Validate one net definition and return the frozen net with its content revision.
 *
 * A definition is `{netId, places, transitions, receptivities}`. Places carry `kind`
 * (`STEP` or `RESOURCE`), `capacity`, `initial`, and `terminal` (a STEP where an instance may
 * properly complete). Transitions carry `receptivity`, `refusal`, `priority`, `inputs`,
 * `outputs`, and `inhibitors`. Receptivities carry `kind` (`LEVEL`, `EDGE`, or `CONSTANT`),
 * the `fact` they check, and the `channel` that proves it.
 */
export function buildNet(definition) {
  if (!definition || typeof definition !== 'object') fail('NetInvalid', 'a net definition must be an object');
  const { netId, places, transitions, receptivities } = definition;
  if (!isId(netId)) fail('NetInvalid', 'netId must be a closed identifier');
  if (!Array.isArray(places) || places.length === 0) fail('NetInvalid', 'a net needs at least one place');
  if (!Array.isArray(transitions)) fail('NetInvalid', 'transitions must be a list');
  if (!receptivities || typeof receptivities !== 'object' || Array.isArray(receptivities)) {
    fail('NetInvalid', 'receptivities must be an object keyed by receptivity id');
  }

  const placeMap = new Map();
  for (const place of places) {
    if (!place || typeof place !== 'object' || !isId(place.id)) fail('NetInvalid', 'a place needs a closed id');
    if (placeMap.has(place.id)) fail('NetInvalid', `place ${place.id} is declared twice`);
    const kind = place.kind ?? 'STEP';
    if (!PLACE_KINDS.includes(kind)) fail('NetInvalid', `place ${place.id} has an unknown kind ${kind}`);
    const capacity = place.capacity ?? (kind === 'STEP' ? 1 : undefined);
    const initial = place.initial ?? 0;
    if (!isWeight(capacity)) fail('NetInvalid', `place ${place.id} needs a positive finite capacity`);
    if (!isCount(initial) || initial > capacity) {
      fail('NetInvalid', `place ${place.id} initial tokens must lie within its capacity`);
    }
    placeMap.set(place.id, {
      id: place.id, kind, capacity, initial, terminal: Boolean(place.terminal),
      label: typeof place.label === 'string' ? place.label : place.id,
    });
  }

  const receptivityMap = new Map();
  for (const [id, entry] of Object.entries(receptivities)) {
    if (!isId(id)) fail('NetInvalid', `receptivity id ${id} is not closed`);
    if (!entry || typeof entry !== 'object') fail('NetInvalid', `receptivity ${id} must be an object`);
    const kind = entry.kind ?? 'LEVEL';
    if (!RECEPTIVITY_KINDS.includes(kind)) fail('NetInvalid', `receptivity ${id} has an unknown kind ${kind}`);
    if (typeof entry.fact !== 'string' || entry.fact.length === 0) fail('NetInvalid', `receptivity ${id} must name its fact`);
    if (typeof entry.channel !== 'string' || entry.channel.length === 0) fail('NetInvalid', `receptivity ${id} must name its channel`);
    receptivityMap.set(id, { id, kind, fact: entry.fact, channel: entry.channel });
  }

  const transitionMap = new Map();
  for (const transition of transitions) {
    if (!transition || typeof transition !== 'object' || !isId(transition.id)) fail('NetInvalid', 'a transition needs a closed id');
    if (transitionMap.has(transition.id) || placeMap.has(transition.id)) fail('NetInvalid', `id ${transition.id} is not unique`);
    if (!isId(transition.receptivity) || !receptivityMap.has(transition.receptivity)) {
      fail('NetInvalid', `transition ${transition.id} names an undeclared receptivity`);
    }
    if (typeof transition.refusal !== 'string' || !/^[A-Z][A-Z0-9_]*$/u.test(transition.refusal)) {
      fail('NetInvalid', `transition ${transition.id} needs an upper-case refusal name`);
    }
    const priority = transition.priority ?? 0;
    if (!Number.isSafeInteger(priority)) fail('NetInvalid', `transition ${transition.id} priority must be an integer`);
    const inputs = normalizeArcs(transition.inputs, 'inputs', transition.id, placeMap);
    const outputs = normalizeArcs(transition.outputs, 'outputs', transition.id, placeMap);
    const inhibitors = normalizeArcs(transition.inhibitors, 'inhibitors', transition.id, placeMap);
    if (inputs.length === 0) fail('NetInvalid', `transition ${transition.id} needs at least one input place`);
    transitionMap.set(transition.id, {
      id: transition.id, receptivity: transition.receptivity, refusal: transition.refusal, priority,
      inputs, outputs, inhibitors: inhibitors.map(({ place }) => place),
      label: typeof transition.label === 'string' ? transition.label : transition.id,
    });
  }

  const orderedPlaces = [...placeMap.values()].sort(byId);
  const orderedTransitions = [...transitionMap.values()].sort(byPriorityThenId);
  const orderedReceptivities = [...receptivityMap.values()].sort(byId);
  const arcs = [];
  for (const transition of orderedTransitions) {
    for (const { place, weight } of transition.inputs) arcs.push({ from: place, to: transition.id, weight, kind: 'INPUT' });
    for (const { place, weight } of transition.outputs) arcs.push({ from: transition.id, to: place, weight, kind: 'OUTPUT' });
    for (const place of transition.inhibitors) arcs.push({ from: place, to: transition.id, weight: 0, kind: 'INHIBITOR' });
  }
  arcs.sort((left, right) => compareIds(left.from, right.from) || compareIds(left.to, right.to) || compareIds(left.kind, right.kind));

  const content = {
    schema: DRAIN_PETRI_NET_SCHEMA,
    netId,
    places: orderedPlaces,
    transitions: orderedTransitions,
    receptivities: orderedReceptivities,
  };
  return deepFreeze({
    ...content,
    arcs,
    netRevision: revisionOf(content),
    placeIndex: Object.fromEntries(orderedPlaces.map((place) => [place.id, place])),
    transitionIndex: Object.fromEntries(orderedTransitions.map((transition) => [transition.id, transition])),
    receptivityIndex: Object.fromEntries(orderedReceptivities.map((entry) => [entry.id, entry])),
  });
}

function assertNet(net) {
  if (!net || typeof net !== 'object' || net.schema !== DRAIN_PETRI_NET_SCHEMA || !net.placeIndex) {
    fail('NetInvalid', 'expected a net built by buildNet');
  }
}

// ---------------------------------------------------------------------------
// marking
// ---------------------------------------------------------------------------

/** Rule 1: the initial situation. */
export function initialMarking(net) {
  assertNet(net);
  return Object.freeze(Object.fromEntries(net.places.map((place) => [place.id, place.initial])));
}

export function markingRevision(marking) {
  return revisionOf(marking);
}

function normalizeMarking(net, marking) {
  if (!marking || typeof marking !== 'object') fail('MarkingInvalid', 'a marking must be an object');
  const normalized = {};
  for (const place of net.places) {
    const tokens = marking[place.id] ?? 0;
    if (!isCount(tokens)) fail('MarkingInvalid', `${place.id} holds a non-integer token count`);
    if (tokens > place.capacity) fail('MarkingInvalid', `${place.id} exceeds its capacity ${place.capacity}`);
    normalized[place.id] = tokens;
  }
  for (const key of Object.keys(marking)) {
    if (!net.placeIndex[key]) fail('MarkingInvalid', `${key} is not a place of ${net.netId}`);
  }
  return normalized;
}

function receptivityValue(facts, id) {
  const entry = facts?.[id];
  const value = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.value : entry;
  if (value === true || value === false) return value;
  return 'UNKNOWN';
}

function evaluate(net, marking, transition, facts, consumed = {}, produced = {}) {
  const missingSteps = [];
  const missingResources = [];
  for (const { place, weight } of transition.inputs) {
    const available = marking[place] - (consumed[place] ?? 0);
    if (available < weight) (net.placeIndex[place].kind === 'RESOURCE' ? missingResources : missingSteps).push(place);
  }
  const receptivity = net.receptivityIndex[transition.receptivity];
  const value = receptivity.kind === 'CONSTANT' ? true : receptivityValue(facts, transition.receptivity);
  if (missingSteps.length > 0) {
    return { reason: 'INPUT_TOKENS_MISSING', places: missingSteps, value };
  }
  if (missingResources.length > 0) {
    return { reason: 'RESOURCE_UNAVAILABLE', places: missingResources, value };
  }
  const inhibiting = transition.inhibitors.filter((place) => marking[place] > 0);
  if (inhibiting.length > 0) return { reason: 'INHIBITED', places: inhibiting, value };
  const overflow = [];
  for (const { place, weight } of transition.outputs) {
    const consumedHere = transition.inputs.find((arc) => arc.place === place)?.weight ?? 0;
    const resulting = marking[place] - (consumed[place] ?? 0) - consumedHere + (produced[place] ?? 0) + weight;
    if (resulting > net.placeIndex[place].capacity) overflow.push(place);
  }
  if (overflow.length > 0) return { reason: 'CAPACITY_EXCEEDED', places: overflow, value };
  if (value === true) return { reason: null, places: [], value };
  return { reason: value === false ? 'RECEPTIVITY_FALSE' : 'RECEPTIVITY_UNKNOWN', places: [], value };
}

const blockedEntry = (transition, verdict) => Object.freeze({
  transition: transition.id,
  receptivity: transition.receptivity,
  refusal: transition.refusal,
  reason: verdict.reason,
  places: Object.freeze([...verdict.places]),
});

/**
 * Rule 2. Returns the transitions enabled on this marking under these facts, in firing order,
 * and every transition that is waiting: token-ready but held by its receptivity, an inhibitor or
 * a capacity; or asked for by a true edge receptivity while its input tokens are missing. A
 * transition whose step tokens are absent and whose receptivity is not a true edge is inactive
 * and is not listed.
 */
export function enabledTransitions(net, marking, facts = {}) {
  assertNet(net);
  const state = normalizeMarking(net, marking);
  const enabled = [];
  const blocked = [];
  for (const transition of net.transitions) {
    const verdict = evaluate(net, state, transition, facts);
    if (verdict.reason === null) {
      enabled.push(transition.id);
    } else if (verdict.reason !== 'INPUT_TOKENS_MISSING'
      || (verdict.value === true && net.receptivityIndex[transition.receptivity].kind === 'EDGE')) {
      // Level evidence without a token is an inactive transition; edge evidence without a token
      // is a proof the chart did not consume, and the coordinator must see it.
      blocked.push(blockedEntry(transition, verdict));
    }
  }
  return Object.freeze({ enabled: Object.freeze(enabled), blocked: Object.freeze(blocked) });
}

function apply(marking, transitions) {
  const next = { ...marking };
  for (const transition of transitions) {
    for (const { place, weight } of transition.inputs) next[place] -= weight;
  }
  for (const transition of transitions) {
    for (const { place, weight } of transition.outputs) next[place] += weight;
  }
  return Object.freeze(next);
}

/** Rule 3 for one transition. Refuses, by the transition's name, when it is not enabled. */
export function fire(net, marking, transitionId, facts = {}) {
  assertNet(net);
  const transition = net.transitionIndex[transitionId];
  if (!transition) fail('TransitionUnknown', `${transitionId} is not a transition of ${net.netId}`);
  const state = normalizeMarking(net, marking);
  const verdict = evaluate(net, state, transition, facts);
  if (verdict.reason !== null) {
    fail(verdict.reason, `${transitionId} is not enabled: ${transition.refusal}`, blockedEntry(transition, verdict));
  }
  return apply(state, [transition]);
}

/**
 * Rules 4 and 5: one evolution step, computed as a single deterministic fixed point over the
 * whole selected firing set rather than a per-transition scan.
 *
 * A transition is a *candidate* when its receptivity holds and no inhibitor place holds a token
 * — never screened by token or capacity availability, because those depend on what else fires in
 * the same step (rule 5: a resource a transition releases is available, in the same step, to a
 * transition that needs it). Given the current candidate set, every place's one resulting token
 * count is computed from the *combined* consume/produce delta of that whole set:
 * `resulting = marking - totalConsumed + totalProduced`. The set is feasible exactly when every
 * place's resulting count lies in `[0, capacity]`; there is no intermediate, order-sensitive
 * check. When a place's combined delta is infeasible, the single worst-ranked candidate touching
 * that place (lowest priority, then highest id — the last one rule 4 would let fire) is removed
 * and the fixed point is recomputed; this repeats until every place is feasible, so the final
 * result never depends on the order transitions were considered in, only on the declared priority
 * and id. Every removed candidate is reported blocked by the place and reason (missing step
 * tokens, an unavailable resource, or exceeded capacity) that caused its removal.
 *
 * A STEP place (an instance's position) is never fed by same-step production for the purpose of
 * satisfying another transition's consumption: consuming one still requires the token in the
 * *starting* marking, so a genuine multi-hop chain (verdict -> join -> mergeable) advances one
 * hop per call and `replay` folds the remaining hops by calling `step` again. A RESOURCE place
 * (the merge lock, provider capacity) is netted: a transition may consume a unit the same step
 * releases it, so the lock changes hands without an extra call. Every place's capacity — STEP or
 * RESOURCE — is always checked against the resulting count (rule 5).
 * A transition excluded from the outset (a false or unknown receptivity, or an inhibitor) is only
 * worth reporting when its own tokens are already present, or an edge receptivity fired true with
 * no token to consume; a transition that has neither its tokens nor its receptivity is inactive
 * and is not listed.
 */
export function step(net, marking, facts = {}) {
  assertNet(net);
  const state = normalizeMarking(net, marking);
  let candidates = [];
  const reported = [];
  for (const transition of net.transitions) {
    const inhibiting = transition.inhibitors.filter((place) => state[place] > 0);
    const receptivity = net.receptivityIndex[transition.receptivity];
    const value = receptivity.kind === 'CONSTANT' ? true : receptivityValue(facts, transition.receptivity);
    if (inhibiting.length > 0) {
      reported.push(blockedEntry(transition, { reason: 'INHIBITED', places: inhibiting, value }));
      continue;
    }
    if (value !== true) {
      const structural = evaluate(net, state, transition, facts);
      if (structural.reason !== 'INPUT_TOKENS_MISSING' && structural.reason !== 'RESOURCE_UNAVAILABLE') {
        reported.push(blockedEntry(transition, { reason: value === false ? 'RECEPTIVITY_FALSE' : 'RECEPTIVITY_UNKNOWN', places: [], value }));
      } else if (value === true && receptivity.kind === 'EDGE') {
        reported.push(blockedEntry(transition, structural));
      }
      continue;
    }
    // A STEP place is never fed by same-step production (see the joint fixed point below); a
    // transition whose own STEP input is entirely absent from the *starting* marking can never
    // join the firing set no matter what else fires, so it is pruned here — unconditionally, and
    // before the joint fixed point — rather than left to be misattributed as the loser of a
    // resource contention it was never actually part of.
    const missingSteps = transition.inputs.filter(({ place, weight }) => net.placeIndex[place].kind === 'STEP' && state[place] < weight);
    if (missingSteps.length > 0) {
      if (receptivity.kind === 'EDGE') {
        reported.push(blockedEntry(transition, { reason: 'INPUT_TOKENS_MISSING', places: missingSteps.map(({ place }) => place), value }));
      }
      continue;
    }
    candidates.push(transition);
  }
  const worstOf = (contenders) => contenders.reduce((left, right) => (byPriorityThenId(left, right) > 0 ? left : right));
  const deltasOf = (set) => {
    const consumed = {};
    const produced = {};
    for (const transition of set) {
      for (const { place, weight } of transition.inputs) consumed[place] = (consumed[place] ?? 0) + weight;
      for (const { place, weight } of transition.outputs) produced[place] = (produced[place] ?? 0) + weight;
    }
    return { consumed, produced };
  };
  const remove = (violated, arcsOf, reason, shouldReport = () => true) => {
    const toRemove = new Map();
    for (const place of violated) {
      const contenders = candidates.filter((transition) => arcsOf(transition).some((arc) => arc.place === place.id));
      const worst = worstOf(contenders);
      const entry = toRemove.get(worst.id) ?? { reason: reason(place), places: new Set() };
      entry.reason = reason(place);
      entry.places.add(place.id);
      toRemove.set(worst.id, entry);
    }
    for (const [id, entry] of toRemove) {
      const transition = candidates.find((candidate) => candidate.id === id);
      if (shouldReport(transition, entry.reason)) {
        reported.push(blockedEntry(transition, { reason: entry.reason, places: [...entry.places].sort(), value: true }));
      }
    }
    candidates = candidates.filter((candidate) => !toRemove.has(candidate.id));
  };
  // Resolve every starved place (a STEP place's own starting tokens, or a RESOURCE place's netted
  // delta going negative) to a fixed point first: a candidate that cannot possibly hold its tokens
  // is never a legitimate contributor to a *different* place's capacity, so it must not be blamed
  // for an overflow that its own removal — decided on starvation grounds alone — already cures.
  // Every remaining candidate here already cleared the upfront "own STEP token present" screen, so
  // a STEP place found starved now is always two-or-more candidates genuinely contending for one
  // token (like the resource case), never a transition with nothing to contend for.
  for (;;) {
    const { consumed, produced } = deltasOf(candidates);
    const starved = net.places.filter((place) => {
      const have = consumed[place.id] ?? 0;
      const resulting = state[place.id] - have + (produced[place.id] ?? 0);
      return place.kind === 'STEP' ? have > state[place.id] : resulting < 0;
    });
    if (starved.length === 0) break;
    remove(starved, (transition) => transition.inputs, (place) => (place.kind === 'RESOURCE' ? 'RESOURCE_UNAVAILABLE' : 'INPUT_TOKENS_MISSING'));
  }
  for (;;) {
    const { consumed, produced } = deltasOf(candidates);
    const overCapacity = net.places.filter((place) => (
      state[place.id] - (consumed[place.id] ?? 0) + (produced[place.id] ?? 0) > place.capacity
    ));
    if (overCapacity.length === 0) break;
    remove(overCapacity, (transition) => transition.outputs, () => 'CAPACITY_EXCEEDED');
  }
  const next = apply(state, candidates);
  const blocked = reported.sort((left, right) => compareIds(left.transition, right.transition));
  return Object.freeze({
    marking: next,
    fired: Object.freeze(candidates.map((transition) => transition.id)),
    blocked: Object.freeze(blocked),
  });
}

// ---------------------------------------------------------------------------
// replay
// ---------------------------------------------------------------------------

function normalizeFactMap(net, map, field, ordinal) {
  if (map === undefined) return {};
  if (!map || typeof map !== 'object' || Array.isArray(map)) fail('FactEventInvalid', `event ${ordinal}.${field} must be an object`);
  const normalized = {};
  for (const [id, entry] of Object.entries(map)) {
    const receptivity = net.receptivityIndex[id];
    if (!receptivity) fail('FactEventInvalid', `event ${ordinal} names an unknown receptivity ${id}`);
    const expected = field === 'edge' ? 'EDGE' : 'LEVEL';
    if (receptivity.kind !== expected) fail('FactEventInvalid', `event ${ordinal} supplies ${id} as ${field} but it is ${receptivity.kind}`);
    const value = entry && typeof entry === 'object' ? entry.value : entry;
    if (value !== true && value !== false && value !== 'UNKNOWN') {
      fail('FactEventInvalid', `event ${ordinal}.${id} must be true, false, or UNKNOWN`);
    }
    normalized[id] = Object.freeze({
      value,
      evidence: entry && typeof entry === 'object' && entry.evidence !== undefined ? entry.evidence : null,
    });
  }
  return normalized;
}

/** A stable situation must be reached within this many steps of one event. */
export const MAX_EVOLUTION_ITERATIONS = 64;

/**
 * Fold an ordered list of fact events into the marking history.
 *
 * Each event is `{at, source, level, edge}`: `level` facts persist until restated, `edge` facts
 * are true only for the first step of that event. Every event evolves the net to a stable
 * situation (no transition fires) before the next event is read, so a proof that enables a
 * chain fires the chain. Events are folded in the order given; the caller sorts them, and
 * sorting the same events into the same order yields the same history and the same revisions.
 * The history records, per event, what fired, what waited and why, and the marking.
 */
export function replay(net, events, { marking: start } = {}) {
  assertNet(net);
  if (!Array.isArray(events)) fail('FactEventInvalid', 'events must be a list');
  let marking = start === undefined ? initialMarking(net) : Object.freeze(normalizeMarking(net, start));
  let level = {};
  const history = [];
  events.forEach((event, index) => {
    if (!event || typeof event !== 'object') fail('FactEventInvalid', `event ${index} must be an object`);
    if (event.at !== null && event.at !== undefined && typeof event.at !== 'string') {
      fail('FactEventInvalid', `event ${index}.at must be an instant string or null`);
    }
    level = { ...level, ...normalizeFactMap(net, event.level, 'level', index) };
    const edge = normalizeFactMap(net, event.edge, 'edge', index);
    // Evolve to a stable situation. Each edge fact may fire once within this event; unused edges
    // remain available to a transition enabled by an earlier firing, then every edge expires before
    // the next event. This lets one classified head-change enter and complete reconciliation while
    // preventing the same HEAD_ADVANCED edge from cycling the token back into reconciliation.
    const remainingEdge = { ...edge };
    const fired = [];
    const consumeFiredEdges = (transitionIds) => {
      for (const transitionId of transitionIds) {
        const receptivity = net.transitionIndex[transitionId].receptivity;
        if (net.receptivityIndex[receptivity].kind === 'EDGE') delete remainingEdge[receptivity];
        // A classified reconciliation is proof about the newly observed head. When the token was
        // already in P_RECONCILE, HEAD_ADVANCED has no separate transition to consume it; treating
        // it as still pending would immediately invalidate the reconciliation just proven.
        if (transitionId.endsWith('/T_RECONCILED')) {
          delete remainingEdge[transitionId.replace('/T_RECONCILED', '/D_HEAD_ADVANCED')];
        }
      }
    };
    let result = step(net, marking, { ...level, ...remainingEdge });
    fired.push(...result.fired);
    consumeFiredEdges(result.fired);
    let iterations = 1;
    while (result.fired.length > 0) {
      if (iterations >= MAX_EVOLUTION_ITERATIONS) {
        fail('EvolutionUnstable', `event ${index} did not reach a stable situation within ${MAX_EVOLUTION_ITERATIONS} steps`);
      }
      result = step(net, result.marking, { ...level, ...remainingEdge });
      fired.push(...result.fired);
      consumeFiredEdges(result.fired);
      iterations += 1;
    }
    marking = result.marking;
    history.push(Object.freeze({
      ordinal: index,
      at: event.at ?? null,
      source: typeof event.source === 'string' ? event.source : null,
      fired: Object.freeze(fired),
      blocked: result.blocked,
      marking,
      markingRevision: markingRevision(marking),
    }));
  });
  return deepFreeze({
    netId: net.netId,
    netRevision: net.netRevision,
    history,
    marking,
    markingRevision: markingRevision(marking),
    facts: level,
  });
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

const encode = (net, marking) => net.places.map((place) => marking[place.id]).join(',');

/**
 * Explicit reachability on the bounded net with every receptivity treated as free (any
 * transition may fire when its tokens allow), interleaving one transition at a time and ignoring
 * priority, so the explored behaviour is a superset of every fact-driven run. Reports the state
 * count, deadlock markings (no transition enabled and not a proper completion), dead transitions
 * (never enabled in any reachable marking), and the bound. The bound is explicit: `maxStates`
 * markings, refused by name when exceeded; and every place's capacity, so the net is bounded by
 * construction and a marking beyond a capacity is impossible rather than merely unobserved.
 */
export function checkReachability(net, { maxStates = 20_000 } = {}) {
  assertNet(net);
  if (!isWeight(maxStates)) fail('ReachabilityBoundInvalid', 'maxStates must be a positive integer');
  const free = Object.fromEntries(net.receptivities.map((entry) => [entry.id, true]));
  const start = initialMarking(net);
  const seen = new Map([[encode(net, start), start]]);
  const queue = [start];
  const everEnabled = new Set();
  const deadlocks = [];
  while (queue.length > 0) {
    const marking = queue.shift();
    const { enabled } = enabledTransitions(net, marking, free);
    if (enabled.length === 0 && !isProperCompletion(net, marking)) deadlocks.push(marking);
    for (const transitionId of enabled) {
      everEnabled.add(transitionId);
      const next = fire(net, marking, transitionId, free);
      const key = encode(net, next);
      if (!seen.has(key)) {
        if (seen.size >= maxStates) {
          fail('ReachabilityBoundExceeded', `more than ${maxStates} markings are reachable`, { maxStates });
        }
        seen.set(key, next);
        queue.push(next);
      }
    }
  }
  const capacityBound = Math.max(...net.places.map((place) => place.capacity));
  return deepFreeze({
    netId: net.netId,
    netRevision: net.netRevision,
    states: seen.size,
    bound: { maxStates, placeCapacity: capacityBound },
    bounded: true,
    deadlocks,
    deadTransitions: net.transitions.map(({ id }) => id).filter((id) => !everEnabled.has(id)),
    sound: deadlocks.length === 0 && net.transitions.every(({ id }) => everEnabled.has(id)),
  });
}

/** Every initial STEP obligation survives in a terminal place and every RESOURCE is restored. */
export function isProperCompletion(net, marking) {
  assertNet(net);
  let initialStepTokens = 0;
  let terminalStepTokens = 0;
  for (const place of net.places) {
    const tokens = marking[place.id] ?? 0;
    if (place.kind === 'RESOURCE' && tokens !== place.initial) return false;
    if (place.kind === 'STEP') {
      initialStepTokens += place.initial;
      if (tokens > 0 && !place.terminal) return false;
      if (place.terminal) terminalStepTokens += tokens;
    }
  }
  return terminalStepTokens === initialStepTokens;
}

// ---------------------------------------------------------------------------
// the two nets as data
// ---------------------------------------------------------------------------

const STEP = (id, extra = {}) => ({ id, kind: 'STEP', capacity: 1, initial: 0, ...extra });

/**
 * The PR drain, per pull request. Places are prefixed with the instance key at instantiation;
 * `MERGE_LOCK` and `PROVIDER_CAPACITY` are shared resource places (see `instantiate`).
 */
export const DRAIN_NET_TEMPLATE = deepFreeze({
  netId: DRAIN_NET_ID,
  instancePrefix: 'pr#',
  shared: [
    { id: 'MERGE_LOCK', kind: 'RESOURCE', capacity: 1, initial: 1, label: 'one reconciliation-and-merge at a time (B35)' },
    { id: 'PROVIDER_CAPACITY', kind: 'RESOURCE', capacity: DEFAULT_PROVIDER_CAPACITY, initial: DEFAULT_PROVIDER_CAPACITY, label: 'live lanes the provider may run' },
  ],
  places: [
    STEP('P_DRAFT_HEAD', { initial: 1, label: 'draft head published' }),
    STEP('P_REVIEW_SPEC', { label: 'Spec review running at the head' }),
    STEP('P_REVIEW_STANDARDS', { label: 'Standards review running at the head' }),
    STEP('P_SPEC_VERDICT', { label: 'Spec verdict bound to the head' }),
    STEP('P_STANDARDS_VERDICT', { label: 'Standards verdict bound to the head' }),
    STEP('P_DUAL_APPROVED', { label: 'both axes APPROVE at the head' }),
    STEP('P_REPAIR', { label: 'bounded repair running' }),
    STEP('P_RECONCILE', { label: 'reconciliation onto main running' }),
    STEP('P_MERGEABLE', { label: 'mergeable and clean, lock held' }),
    STEP('P_READY', { label: 'ready for review (not a draft)' }),
    STEP('P_MERGED', { label: 'merge confirmed' }),
    STEP('P_ISSUE_RECONCILED', { terminal: true, label: 'linked issue reconciled' }),
    STEP('P_BLOCKED_REDESIGN', { label: 'ENG-09 breaker tripped' }),
  ],
  receptivities: {
    D_HEAD_PUBLISHED: { kind: 'LEVEL', fact: 'the latest recorded observation of the pull request names a full head SHA', channel: 'bus message.sent kind pr-observation (head=)' },
    D_SPEC_VERDICT_BOUND: { kind: 'LEVEL', fact: 'a Spec review artifact titled for this pull request states detached at the current head on its Subject line, carries exactly one verdict line, and ends with its marker', channel: 'artifact bytes: title, Subject header, **Verdict:** line, last non-empty line' },
    D_STANDARDS_VERDICT_BOUND: { kind: 'LEVEL', fact: 'a Standards review artifact bound as above', channel: 'artifact bytes: title, Subject header, **Verdict:** line, last non-empty line' },
    D_BOTH_APPROVE_AT_HEAD: { kind: 'LEVEL', fact: 'the bound Spec verdict and the bound Standards verdict are both APPROVE', channel: 'artifact bytes, both axes' },
    D_ANY_REQUEST_CHANGES_AT_HEAD: { kind: 'LEVEL', fact: 'both axes are bound and at least one verdict is REQUEST_CHANGES', channel: 'artifact bytes, both axes' },
    D_FAILURE_FAMILY_REPEATED: { kind: 'LEVEL', fact: 'two REQUEST_CHANGES artifacts of this pull request at distinct heads carry the same non-empty Family token', channel: 'artifact bytes: Family: line' },
    D_HEAD_ADVANCED: { kind: 'EDGE', fact: 'a recorded observation names a head different from the previous one', channel: 'bus message.sent kind pr-observation (head=)' },
    D_MERGEABLE_CLEAN: { kind: 'LEVEL', fact: 'the latest observation at the current head records mergeable=MERGEABLE', channel: 'bus pr-observation (mergeable=)' },
    D_CONFLICTING: { kind: 'LEVEL', fact: 'the latest observation at the current head records mergeable=CONFLICTING', channel: 'bus pr-observation (mergeable=)' },
    D_RECONCILIATION_CLASSIFIED: { kind: 'EDGE', fact: 'a changed-head observation records reconciliation=CLASSIFIED and checks=ALL_PASS while both review axes APPROVE artifacts bound to that exact head', channel: 'bus pr-observation plus exact-head artifact bytes' },
    D_RECONCILIATION_UNCLASSIFIED: { kind: 'EDGE', fact: 'an observation records reconciliation=UNCLASSIFIED', channel: 'bus pr-observation (reconciliation=)' },
    D_NOT_DRAFT: { kind: 'LEVEL', fact: 'the latest observation at the current head records draft=false', channel: 'bus pr-observation (draft=)' },
    D_MERGE_CONFIRMED: { kind: 'LEVEL', fact: 'the latest observation records state=MERGED with a merge commit', channel: 'bus pr-observation (state=, mergeCommit=)' },
    D_ISSUE_RECONCILED: { kind: 'LEVEL', fact: 'the latest observation records issue=none or issueState=CLOSED', channel: 'bus pr-observation (issue=, issueState=)' },
    D_OPERATOR_REDESIGN_ORDER: { kind: 'LEVEL', fact: 'an operator order (class D) lifts the breaker', channel: 'none in R0: class-D orders never travel on the bus' },
  },
  transitions: [
    { id: 'T_FORK_REVIEWS', receptivity: 'D_HEAD_PUBLISHED', refusal: 'HEAD_UNOBSERVED', inputs: ['P_DRAFT_HEAD', { place: 'PROVIDER_CAPACITY', weight: 2 }], outputs: ['P_REVIEW_SPEC', 'P_REVIEW_STANDARDS'], inhibitors: ['P_BLOCKED_REDESIGN'] },
    { id: 'T_SPEC_VERDICT', receptivity: 'D_SPEC_VERDICT_BOUND', refusal: 'SPEC_VERDICT_NOT_BOUND', inputs: ['P_REVIEW_SPEC'], outputs: ['P_SPEC_VERDICT', 'PROVIDER_CAPACITY'] },
    { id: 'T_STANDARDS_VERDICT', receptivity: 'D_STANDARDS_VERDICT_BOUND', refusal: 'STANDARDS_VERDICT_NOT_BOUND', inputs: ['P_REVIEW_STANDARDS'], outputs: ['P_STANDARDS_VERDICT', 'PROVIDER_CAPACITY'] },
    { id: 'T_BREAKER_TRIP', receptivity: 'D_FAILURE_FAMILY_REPEATED', refusal: 'FAMILY_NOT_REPEATED', priority: 1, inputs: ['P_SPEC_VERDICT', 'P_STANDARDS_VERDICT'], outputs: ['P_BLOCKED_REDESIGN'] },
    { id: 'T_JOIN_APPROVE', receptivity: 'D_BOTH_APPROVE_AT_HEAD', refusal: 'DUAL_APPROVAL_MISSING', inputs: ['P_SPEC_VERDICT', 'P_STANDARDS_VERDICT'], outputs: ['P_DUAL_APPROVED'] },
    { id: 'T_JOIN_REPAIR', receptivity: 'D_ANY_REQUEST_CHANGES_AT_HEAD', refusal: 'NO_REQUEST_CHANGES', inputs: ['P_SPEC_VERDICT', 'P_STANDARDS_VERDICT', 'PROVIDER_CAPACITY'], outputs: ['P_REPAIR'] },
    { id: 'T_REPAIR_PUBLISHED', receptivity: 'D_HEAD_ADVANCED', refusal: 'REPAIR_UNPUBLISHED', inputs: ['P_REPAIR'], outputs: ['P_DRAFT_HEAD', 'PROVIDER_CAPACITY'], inhibitors: ['P_BLOCKED_REDESIGN'] },
    { id: 'T_MERGEABLE', receptivity: 'D_MERGEABLE_CLEAN', refusal: 'NOT_MERGEABLE', inputs: ['P_DUAL_APPROVED', 'MERGE_LOCK'], outputs: ['P_MERGEABLE'] },
    { id: 'T_RECONCILE_START', receptivity: 'D_CONFLICTING', refusal: 'NOT_CONFLICTING', inputs: ['P_DUAL_APPROVED', 'MERGE_LOCK', 'PROVIDER_CAPACITY'], outputs: ['P_RECONCILE'] },
    { id: 'T_RECONFLICTED', receptivity: 'D_CONFLICTING', refusal: 'NOT_CONFLICTING', inputs: ['P_MERGEABLE', 'PROVIDER_CAPACITY'], outputs: ['P_RECONCILE'] },
    { id: 'T_READY_RECONFLICTED', receptivity: 'D_CONFLICTING', refusal: 'NOT_CONFLICTING', inputs: ['P_READY', 'PROVIDER_CAPACITY'], outputs: ['P_RECONCILE'] },
    { id: 'T_DUAL_APPROVED_HEAD_ADVANCED', receptivity: 'D_HEAD_ADVANCED', refusal: 'HEAD_UNCHANGED', priority: 2, inputs: ['P_DUAL_APPROVED', 'MERGE_LOCK', 'PROVIDER_CAPACITY'], outputs: ['P_RECONCILE'] },
    { id: 'T_MERGEABLE_HEAD_ADVANCED', receptivity: 'D_HEAD_ADVANCED', refusal: 'HEAD_UNCHANGED', priority: 2, inputs: ['P_MERGEABLE', 'PROVIDER_CAPACITY'], outputs: ['P_RECONCILE'] },
    { id: 'T_READY_HEAD_ADVANCED', receptivity: 'D_HEAD_ADVANCED', refusal: 'HEAD_UNCHANGED', priority: 2, inputs: ['P_READY', 'PROVIDER_CAPACITY'], outputs: ['P_RECONCILE'] },
    { id: 'T_RECONCILED', receptivity: 'D_RECONCILIATION_CLASSIFIED', refusal: 'RECONCILIATION_UNCLASSIFIED', inputs: ['P_RECONCILE'], outputs: ['P_MERGEABLE', 'PROVIDER_CAPACITY'] },
    { id: 'T_RECONCILE_REJECTED', receptivity: 'D_RECONCILIATION_UNCLASSIFIED', refusal: 'RECONCILIATION_NOT_REJECTED', inputs: ['P_RECONCILE'], outputs: ['P_DRAFT_HEAD', 'MERGE_LOCK', 'PROVIDER_CAPACITY'] },
    { id: 'T_READY', receptivity: 'D_NOT_DRAFT', refusal: 'STILL_DRAFT', inputs: ['P_MERGEABLE'], outputs: ['P_READY'] },
    { id: 'T_MERGE', receptivity: 'D_MERGE_CONFIRMED', refusal: 'MERGE_UNCONFIRMED', inputs: ['P_READY'], outputs: ['P_MERGED', 'MERGE_LOCK'] },
    { id: 'T_ISSUE_RECONCILED', receptivity: 'D_ISSUE_RECONCILED', refusal: 'ISSUE_RECONCILIATION_PENDING', inputs: ['P_MERGED'], outputs: ['P_ISSUE_RECONCILED'] },
    { id: 'T_REDESIGN_RESUMED', receptivity: 'D_OPERATOR_REDESIGN_ORDER', refusal: 'REDESIGN_ORDER_ABSENT', inputs: ['P_BLOCKED_REDESIGN'], outputs: ['P_DRAFT_HEAD'] },
  ],
});

/** The lane lifecycle, per registered lane; `LANE_SLOTS` is the shared resource place. */
export const LANE_NET_TEMPLATE = deepFreeze({
  netId: LANE_NET_ID,
  instancePrefix: 'lane#',
  shared: [
    { id: 'LANE_SLOTS', kind: 'RESOURCE', capacity: DEFAULT_PROVIDER_CAPACITY, initial: DEFAULT_PROVIDER_CAPACITY, label: 'live lane slots' },
  ],
  places: [
    STEP('L_REGISTERED', { initial: 1, label: 'registered on the bus' }),
    STEP('L_ATTEMPT_RUNNING', { label: 'attempt running' }),
    STEP('L_PROVIDER_ERROR', { label: 'exited with a non-zero code (API error)' }),
    STEP('L_EXITED_CLEAN', { label: 'exited 0' }),
    STEP('L_COMPLETED', { label: 'lane-complete sent' }),
    STEP('L_MARKER_VERIFIED', { terminal: true, label: 'artifact digest and marker verified' }),
    STEP('L_EXHAUSTED', { terminal: true, label: 'attempts exhausted' }),
    STEP('L_ABORTED', { terminal: true, label: 'aborted by the coordinator' }),
  ],
  receptivities: {
    L_ATTEMPT_STARTED: { kind: 'EDGE', fact: 'the lane heart-beats attempt=<i>;phase=start', channel: 'bus actor.heartbeat note' },
    L_EXIT_NONZERO: { kind: 'EDGE', fact: 'the lane heart-beats attempt=<i>;exit=<code> with code != 0', channel: 'bus actor.heartbeat note (exit=)' },
    L_EXIT_ZERO: { kind: 'EDGE', fact: 'the lane heart-beats attempt=<i>;exit=0', channel: 'bus actor.heartbeat note (exit=)' },
    L_LANE_COMPLETE_SENT: { kind: 'EDGE', fact: 'the lane sends lane-complete with <artifact>;sha256=<digest>;marker=<M>', channel: 'bus message.sent kind lane-complete' },
    L_LANE_EXHAUSTED_SENT: { kind: 'EDGE', fact: 'the lane sends lane-exhausted', channel: 'bus message.sent kind lane-exhausted' },
    L_LANE_ABORTED_SENT: { kind: 'EDGE', fact: 'the lane sends lane-aborted after an acked abort', channel: 'bus message.sent kind lane-aborted' },
    L_MARKER_DIGEST_EQUAL: { kind: 'LEVEL', fact: 'the artifact named by lane-complete exists, its sha256 equals the sent digest, and its last non-empty line equals the marker', channel: 'artifact bytes against the bus message text' },
  },
  transitions: [
    { id: 'T_START_ATTEMPT', receptivity: 'L_ATTEMPT_STARTED', refusal: 'ATTEMPT_NOT_STARTED', inputs: ['L_REGISTERED', 'LANE_SLOTS'], outputs: ['L_ATTEMPT_RUNNING'] },
    { id: 'T_EXIT_ERROR', receptivity: 'L_EXIT_NONZERO', refusal: 'PROVIDER_ERROR_NOT_OBSERVED', inputs: ['L_ATTEMPT_RUNNING'], outputs: ['L_PROVIDER_ERROR', 'LANE_SLOTS'] },
    { id: 'T_EXIT_CLEAN', receptivity: 'L_EXIT_ZERO', refusal: 'CLEAN_EXIT_NOT_OBSERVED', inputs: ['L_ATTEMPT_RUNNING'], outputs: ['L_EXITED_CLEAN', 'LANE_SLOTS'] },
    { id: 'T_RESUME_AFTER_ERROR', receptivity: 'L_ATTEMPT_STARTED', refusal: 'ATTEMPT_NOT_STARTED', inputs: ['L_PROVIDER_ERROR', 'LANE_SLOTS'], outputs: ['L_ATTEMPT_RUNNING'] },
    { id: 'T_RESUME_AFTER_CLEAN', receptivity: 'L_ATTEMPT_STARTED', refusal: 'ATTEMPT_NOT_STARTED', inputs: ['L_EXITED_CLEAN', 'LANE_SLOTS'], outputs: ['L_ATTEMPT_RUNNING'] },
    { id: 'T_COMPLETE', receptivity: 'L_LANE_COMPLETE_SENT', refusal: 'LANE_COMPLETE_NOT_SENT', inputs: ['L_EXITED_CLEAN'], outputs: ['L_COMPLETED'] },
    { id: 'T_COMPLETE_BEFORE_ATTEMPT', receptivity: 'L_LANE_COMPLETE_SENT', refusal: 'LANE_COMPLETE_NOT_SENT', inputs: ['L_REGISTERED'], outputs: ['L_COMPLETED'] },
    { id: 'T_EXHAUST_AFTER_ERROR', receptivity: 'L_LANE_EXHAUSTED_SENT', refusal: 'LANE_EXHAUSTED_NOT_SENT', inputs: ['L_PROVIDER_ERROR'], outputs: ['L_EXHAUSTED'] },
    { id: 'T_EXHAUST_AFTER_CLEAN', receptivity: 'L_LANE_EXHAUSTED_SENT', refusal: 'LANE_EXHAUSTED_NOT_SENT', inputs: ['L_EXITED_CLEAN'], outputs: ['L_EXHAUSTED'] },
    { id: 'T_ABORT_BEFORE_ATTEMPT', receptivity: 'L_LANE_ABORTED_SENT', refusal: 'LANE_ABORTED_NOT_SENT', inputs: ['L_REGISTERED'], outputs: ['L_ABORTED'] },
    { id: 'T_ABORT_AFTER_ERROR', receptivity: 'L_LANE_ABORTED_SENT', refusal: 'LANE_ABORTED_NOT_SENT', inputs: ['L_PROVIDER_ERROR'], outputs: ['L_ABORTED'] },
    { id: 'T_ABORT_AFTER_CLEAN', receptivity: 'L_LANE_ABORTED_SENT', refusal: 'LANE_ABORTED_NOT_SENT', inputs: ['L_EXITED_CLEAN'], outputs: ['L_ABORTED'] },
    { id: 'T_MARKER_VERIFIED', receptivity: 'L_MARKER_DIGEST_EQUAL', refusal: 'MARKER_UNVERIFIED', inputs: ['L_COMPLETED'], outputs: ['L_MARKER_VERIFIED'] },
  ],
});

const prefixed = (prefix, id) => `${prefix}/${id}`;

/**
 * Unfold one template into a flat net with one copy of the per-instance places, transitions and
 * receptivities per instance key, sharing the template's resource places. Instance keys are
 * sorted so the same set yields the same net and the same revision. `capacity` overrides the
 * token count of every shared resource place sized by the provider default.
 */
export function instantiate(template, instanceKeys, { capacity } = {}) {
  if (!template || typeof template !== 'object' || !Array.isArray(template.places)) fail('NetInvalid', 'a template is required');
  if (!Array.isArray(instanceKeys)) fail('NetInvalid', 'instance keys must be a list');
  const keys = [...new Set(instanceKeys)].sort();
  for (const key of keys) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_.:-]+$/u.test(key)) fail('NetInvalid', `instance key ${key} is not closed`);
  }
  if (capacity !== undefined && !isWeight(capacity)) fail('NetInvalid', 'capacity must be a positive integer');
  const shared = template.shared.map((place) => (
    capacity !== undefined && place.capacity === DEFAULT_PROVIDER_CAPACITY
      ? { ...place, capacity, initial: capacity }
      : { ...place }
  ));
  const sharedIds = new Set(shared.map((place) => place.id));
  const places = [...shared];
  const transitions = [];
  const receptivities = {};
  for (const key of keys) {
    const prefix = `${template.instancePrefix}${key}`;
    const local = (id) => (sharedIds.has(id) ? id : prefixed(prefix, id));
    for (const place of template.places) places.push({ ...place, id: local(place.id) });
    for (const [id, entry] of Object.entries(template.receptivities)) receptivities[local(id)] = { ...entry };
    for (const transition of template.transitions) {
      const arc = (value) => (typeof value === 'string' ? local(value) : { ...value, place: local(value.place) });
      transitions.push({
        ...transition,
        id: local(transition.id),
        receptivity: local(transition.receptivity),
        inputs: (transition.inputs ?? []).map(arc),
        outputs: (transition.outputs ?? []).map(arc),
        inhibitors: (transition.inhibitors ?? []).map(arc),
      });
    }
  }
  return buildNet({ netId: template.netId, places, transitions, receptivities });
}

export const instanceOf = (id) => (id.includes('/') ? id.slice(0, id.indexOf('/')) : null);
export const localIdOf = (id) => (id.includes('/') ? id.slice(id.indexOf('/') + 1) : id);
