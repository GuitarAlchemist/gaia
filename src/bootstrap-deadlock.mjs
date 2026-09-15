/**
 * bootstrap-deadlock.mjs — issue #80's tracer scenario as Place/Transition nets, and the reading of
 * an externally computed reachability analysis as a typed bootstrap state.
 *
 * WHAT THIS DECIDES, AND WHAT IT DOES NOT
 * ---------------------------------------
 * Issue #80 defines a Bootstrap Deadlock as "a circular prerequisite with no currently admissible
 * initial transition", and its first acceptance criterion refuses an acyclic graph. This module
 * states both halves exactly, at a dead marking (no transition admissible there):
 *
 * - the circular set is the largest set of short places and blocked transitions in which every
 *   member transition is short only of member places, and every member place is produced (strictly
 *   given tokens) by some member transition while *every* transition that produces it is short of
 *   some member place. The member places form a siphon: nothing puts tokens into them without
 *   first taking tokens from them, so no transition outside the set is a way in (`blockedAt`);
 * - the marking is a bootstrap deadlock exactly when that set is not empty. Such a set always holds
 *   a cycle, and every member of it is blocked only by facts other members would produce.
 *
 * So a loop downstream of an unobtainable approval is not a bootstrap deadlock, whether it re-enters
 * through the blocked transition or through one of its own: the transition that lacks only the
 * approval is a way in. Nor is a cycle whose entry also needs a place nothing produces. Both read
 * `MISSING_PREREQUISITE` when the net is dead at its initial marking, and `REACHABLE_DEADLOCK` when
 * it gets there after firing. A dead marking reached after firing whose blockage is circular is a
 * bootstrap deadlock too: #80 asks about the *currently* admissible transitions, not only the
 * first. A net whose enumeration was cut short, or whose dead markings IX listed only in part with
 * none of the listed ones circular, is `UNDECIDED`. Nothing is inferred beyond that.
 *
 * The reachability analysis itself is not computed here. Issue #100's grooming asks to avoid a
 * duplicate Petri implementation, and ADR issue #107 routes Rust capabilities through a DuckDB
 * extension port, so the enumeration is IX's `ix_petri_analyze` behind `duckdb-ix-petri.mjs`.
 * This core only (1) declares the nets, (2) content-addresses them and hands IX that address as
 * the net's name, so an analysis is bound to the exact net it describes, and (3) reads an analysis
 * document into a closed reading. The computations it performs are structural, at the dead marking
 * IX reports: what each transition is missing there, the circular set above, and the shortest
 * prerequisite cycle through each member that stays inside the set — the "missing first fact" and
 * "smallest cycle" #80 asks the explanation to carry, never routed through a transition that is
 * blocked for another reason.
 *
 * THE NETS
 * --------
 * Four nets share the places and transitions of the hosted Draft pump observation seam named as
 * #80's tracer scenario ("the run must not be considered healthy merely because the schema exists";
 * "a sealed terminal receipt may seed the first observation"; "only the next independently
 * reconciled run proves steady state"; the bridge "must then emit a Retirement Receipt"):
 *
 * - `asShipped` — the seam read off the code. A run takes no observation; every run seals its own
 *   receipt into the observation (`scripts/hosted-draft-pump.mjs`, `observeTransition`), which is
 *   #80's receipt seed; an observation ages into STALE after 12 h and a later run seals again from
 *   its receipt. `P_STEADY_STATE_PROOF` holds no token, and nothing produces one: that is the
 *   modeller's reading that no code records a steady-state proof, not something IX finds. IX only
 *   works out what follows from it.
 * - `asSpecified` — `asShipped` plus one token in `P_STEADY_STATE_PROOF`: #80's rules, if a later
 *   independently reconciled run did record the proof, so that the seed could retire.
 * - `runGatedOnObservation` — `asShipped` with a run that requires a fresh observation. #80 does not
 *   claim this and the code does not do it; it is the cyclic control a real bootstrap deadlock is
 *   detected on.
 * - `seededGatedControl` — `runGatedOnObservation` with #80's seed installed: a durable fact
 *   (`P_SEED_UNRETIRED`) that makes exactly one transition admissible, a run while no observation is
 *   fresh, as the shipped schedule runs whatever the observation's age. It is the control #80's
 *   grooming requires "not labelled deadlocked". It installs nothing. It is deadlock-free only
 *   while the seed cannot retire, which `P_STEADY_STATE_PROOF = 0` guarantees: with the proof, the
 *   seed retires, and the next STALE observation strands the gated run (a `REACHABLE_DEADLOCK`,
 *   pinned in the tests).
 *
 * `acyclicControl` is a separate two-place net, dead at its initial marking with no cycle, for the
 * acyclic refusal. docs/bootstrap-deadlock.md maps every place and transition to the code.
 */

import { createHash } from 'node:crypto';

export const BOOTSTRAP_DEADLOCK_READING_SCHEMA = 'gaia-bootstrap-deadlock-reading/4';

/** Closed. `BOOTSTRAP_DEADLOCK` is #80's typed state; the others say why it is not that. */
export const BOOTSTRAP_READINGS = Object.freeze([
  'BOOTSTRAP_DEADLOCK', 'MISSING_PREREQUISITE', 'REACHABLE_DEADLOCK', 'NO_DEADLOCK', 'UNDECIDED',
]);

const VERDICTS = Object.freeze(['holds', 'fails', 'unknown']);

export class BootstrapDeadlockError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'BootstrapDeadlockError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new BootstrapDeadlockError(code, message);
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Content address of a net, so a recorded analysis cannot silently describe an edited net. */
export function netRevision(net) {
  return `sha256:${createHash('sha256').update(canonicalJson(net)).digest('hex')}`;
}

/**
 * The document handed to IX: the net, named by its content address. IX echoes the name as
 * `analysis.net`, so `readBootstrapAnalysis` binds an analysis to the exact net by revision rather
 * than by a human label that survives an edit.
 */
export function ixNetDocument(definition) {
  return { ...definition, name: netRevision(definition) };
}

const PLACES = Object.freeze([
  ['P_OBSERVATION_SCHEMA', 'observation schema merged (contract establishment, not liveness)', 1],
  ['P_TICK_DUE', 'scheduled recovery run due', 1],
  ['P_INTAKE_RECEIPT', 'sealed terminal intake receipt', 0],
  ['P_IDLE', 'recovery run finished, next schedule not yet due', 0],
  ['P_NO_FRESH_OBSERVATION', 'no fresh observation: none published, or aged past 12 h (reads STALE)', 1],
  ['P_FRESH_OBSERVATION', 'fresh sealed observation published', 0],
  ['P_NO_SEED', 'no receipt-seeded observation yet', 1],
  ['P_SEED_UNRETIRED', 'receipt seed installed, Retirement Receipt owed', 0],
  ['P_SEED_RETIRED', 'Retirement Receipt emitted for the receipt seed', 0],
  ['P_HEALTH_UNPROVEN', 'steady state not proven', 1],
  ['P_STEADY_STATE', 'steady state proven by a later independently reconciled run', 0],
  ['P_STEADY_STATE_PROOF', 'a later run is reconciled independently of its own receipt', 0],
]);

const TRANSITIONS = Object.freeze([
  ['T_SCHEDULE_TICK', 'next scheduled recovery run starts'],
  ['T_RUN_PUMP', 'run hosted Draft intake'],
  ['T_REFUSE_OBSERVATION', 'observation refused, publish nothing'],
  ['T_SEED_FIRST_OBSERVATION', 'seal the first observation from the run receipt (the seed)'],
  ['T_RESEED_AFTER_STALE', 'seal from the run receipt again after the observation went stale'],
  ['T_RESEAL_FROM_RECEIPT', 'seal a later observation from the run receipt alone'],
  ['T_OBSERVATION_GOES_STALE', 'observation ages past the freshness window'],
  ['T_RECONCILE_NEXT_RUN', 'next run independently reconciled: steady state proven'],
  ['T_RETIRE_SEED', 'emit the Retirement Receipt for the receipt seed'],
  ['T_RECONCILED_RUN', 'steady-state run seals over a fresh observation'],
  ['T_RECONCILED_RUN_AFTER_STALE', 'steady-state run seals over a stale observation'],
]);

/** Every seal: consume the receipt, keep the schema, finish the run. */
const seal = (id, consumed, produced) => [
  ['P_INTAKE_RECEIPT', id], ['P_OBSERVATION_SCHEMA', id], [id, 'P_OBSERVATION_SCHEMA'], [id, 'P_IDLE'],
  ...consumed.map((place) => [place, id]), ...produced.map((place) => [id, place]),
];

const SHIPPED_ARCS = Object.freeze([
  ['P_IDLE', 'T_SCHEDULE_TICK'], ['T_SCHEDULE_TICK', 'P_TICK_DUE'],
  ['P_TICK_DUE', 'T_RUN_PUMP'], ['T_RUN_PUMP', 'P_INTAKE_RECEIPT'],
  ['P_INTAKE_RECEIPT', 'T_REFUSE_OBSERVATION'], ['T_REFUSE_OBSERVATION', 'P_IDLE'],
  ...seal('T_SEED_FIRST_OBSERVATION', ['P_NO_FRESH_OBSERVATION', 'P_NO_SEED'], ['P_FRESH_OBSERVATION', 'P_SEED_UNRETIRED']),
  ...seal('T_RESEED_AFTER_STALE', ['P_NO_FRESH_OBSERVATION', 'P_SEED_UNRETIRED'], ['P_FRESH_OBSERVATION', 'P_SEED_UNRETIRED']),
  ...seal('T_RESEAL_FROM_RECEIPT', ['P_FRESH_OBSERVATION', 'P_SEED_UNRETIRED'], ['P_FRESH_OBSERVATION', 'P_SEED_UNRETIRED']),
  ['P_FRESH_OBSERVATION', 'T_OBSERVATION_GOES_STALE'], ['T_OBSERVATION_GOES_STALE', 'P_NO_FRESH_OBSERVATION'],
  ...seal('T_RECONCILE_NEXT_RUN',
    ['P_FRESH_OBSERVATION', 'P_SEED_UNRETIRED', 'P_HEALTH_UNPROVEN', 'P_STEADY_STATE_PROOF'],
    ['P_FRESH_OBSERVATION', 'P_SEED_UNRETIRED', 'P_STEADY_STATE', 'P_STEADY_STATE_PROOF']),
  ['P_SEED_UNRETIRED', 'T_RETIRE_SEED'], ['P_STEADY_STATE', 'T_RETIRE_SEED'],
  ['T_RETIRE_SEED', 'P_SEED_RETIRED'], ['T_RETIRE_SEED', 'P_STEADY_STATE'],
  ...seal('T_RECONCILED_RUN',
    ['P_FRESH_OBSERVATION', 'P_STEADY_STATE', 'P_STEADY_STATE_PROOF'],
    ['P_FRESH_OBSERVATION', 'P_STEADY_STATE', 'P_STEADY_STATE_PROOF']),
  ...seal('T_RECONCILED_RUN_AFTER_STALE',
    ['P_NO_FRESH_OBSERVATION', 'P_STEADY_STATE', 'P_STEADY_STATE_PROOF'],
    ['P_FRESH_OBSERVATION', 'P_STEADY_STATE', 'P_STEADY_STATE_PROOF']),
]);

/** The prerequisite #80 does not claim: a run that needs a fresh observation (a read arc). */
export const CLAIMED_PREREQUISITE_ARCS = Object.freeze([
  ['P_FRESH_OBSERVATION', 'T_RUN_PUMP'], ['T_RUN_PUMP', 'P_FRESH_OBSERVATION'],
]);

/**
 * #80's Bootstrap Seed on the gated run: "a minimal, explicit, durable initial fact or capability
 * that makes exactly one transition admissible". The durable fact is `P_SEED_UNRETIRED`; the one
 * transition is a run while no observation is fresh, which is what the shipped schedule already
 * does (a six-hourly cron, and `runHostedDraftIntake` takes no observation). Both are read
 * arcs, so running never spends the seed and STALE cannot strand the run while the seed stands.
 * `T_RETIRE_SEED` still consumes it; from then on this transition no longer matches the shipped
 * schedule, which keeps running whatever the observation's age.
 */
export const SEED_ADMITS_RUN = Object.freeze({
  transition: Object.freeze(['T_RUN_PUMP_ON_SEED', 'run hosted Draft intake admitted by the installed seed']),
  arcs: Object.freeze([
    ['P_TICK_DUE', 'T_RUN_PUMP_ON_SEED'], ['T_RUN_PUMP_ON_SEED', 'P_INTAKE_RECEIPT'],
    ['P_SEED_UNRETIRED', 'T_RUN_PUMP_ON_SEED'], ['T_RUN_PUMP_ON_SEED', 'P_SEED_UNRETIRED'],
    ['P_NO_FRESH_OBSERVATION', 'T_RUN_PUMP_ON_SEED'], ['T_RUN_PUMP_ON_SEED', 'P_NO_FRESH_OBSERVATION'],
  ]),
});

function net(name, { tokens = {}, extraArcs = [], extraTransitions = [] } = {}) {
  return {
    name,
    places: PLACES.map(([id, label, initial]) => ({ id, name: label, tokens: tokens[id] ?? initial })),
    transitions: [...TRANSITIONS, ...extraTransitions].map(([id, label]) => ({ id, name: label })),
    arcs: [...SHIPPED_ARCS, ...extraArcs].map(([from, to]) => ({ from, to })),
  };
}

const SEED_INSTALLED = Object.freeze({
  P_NO_FRESH_OBSERVATION: 0, P_FRESH_OBSERVATION: 1, P_NO_SEED: 0, P_SEED_UNRETIRED: 1,
});

export const HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS = deepFreeze({
  asShipped: net('gaia#80 hosted Draft pump observation, as shipped'),
  asSpecified: net('gaia#80 hosted Draft pump observation, as #80 specifies', {
    tokens: { P_STEADY_STATE_PROOF: 1 },
  }),
  runGatedOnObservation: net('gaia#80 hosted Draft pump, run gated on a fresh observation (cyclic control)', {
    extraArcs: CLAIMED_PREREQUISITE_ARCS,
  }),
  seededGatedControl: net('gaia#80 hosted Draft pump, run gated on a fresh observation, seed installed', {
    tokens: SEED_INSTALLED,
    extraArcs: [...CLAIMED_PREREQUISITE_ARCS, ...SEED_ADMITS_RUN.arcs],
    extraTransitions: [SEED_ADMITS_RUN.transition],
  }),
  acyclicControl: {
    name: 'gaia#80 acyclic control: a dispatch nobody requests',
    places: [
      { id: 'P_DISPATCH_REQUESTED', name: 'workflow_dispatch requested', tokens: 0 },
      { id: 'P_INTAKE_RECEIPT', name: 'sealed terminal intake receipt', tokens: 0 },
    ],
    transitions: [{ id: 'T_RUN_PUMP', name: 'run hosted Draft intake' }],
    arcs: [{ from: 'P_DISPATCH_REQUESTED', to: 'T_RUN_PUMP' }, { from: 'T_RUN_PUMP', to: 'P_INTAKE_RECEIPT' }],
  },
});

/** `pre` and `post` weights per transition, keyed by place. */
function incidence(definition) {
  const transitions = new Set(definition.transitions.map(({ id }) => id));
  const pre = new Map([...transitions].map((id) => [id, new Map()]));
  const post = new Map([...transitions].map((id) => [id, new Map()]));
  for (const { from, to, weight = 1 } of definition.arcs) {
    if (transitions.has(to)) pre.get(to).set(from, weight);
    else post.get(from).set(to, weight);
  }
  return { pre, post };
}

/** Whether transition `id` strictly adds tokens to `place` (a read arc produces nothing). */
const produces = ({ pre, post }, id, place) => (post.get(id).get(place) ?? 0) > (pre.get(id).get(place) ?? 0);

/**
 * The shortest directed prerequisite path from transition `start` to place `goal`, as ids, or null.
 * A transition leads to the places it produces; a place leads to the transitions in `through` (a
 * map from transition to how many places it is missing) that need it. Among equally short paths the
 * one through transitions missing fewer places wins, then ids decide, so ties are stable and the
 * explanation follows the path closest to admissible.
 */
function prerequisitePath(graph, start, goal, through) {
  const { pre, post } = graph;
  const byMissingThenId = (left, right) => (through.get(left) - through.get(right)) || (left < right ? -1 : 1);
  const next = (node) => (pre.has(node)
    ? [...post.get(node).keys()].filter((place) => produces(graph, node, place)).sort()
    : [...pre].filter(([id, needs]) => through.has(id) && needs.has(node)).map(([id]) => id).sort(byMissingThenId)
  );
  const parent = new Map([[start, null]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    if (node === goal) {
      const path = [];
      for (let cursor = goal; cursor !== null; cursor = parent.get(cursor)) path.unshift(cursor);
      return path;
    }
    for (const neighbour of next(node)) {
      if (!parent.has(neighbour)) {
        parent.set(neighbour, node);
        queue.push(neighbour);
      }
    }
  }
  return null;
}

/**
 * At a marking given as `Map(place -> tokens)`: for each transition, the pre-set places the marking
 * leaves short, and the shortest cycle `[transition, ..., missing place, transition]` that stays
 * inside the circular set, or null. Sorted by transition id.
 *
 * The circular set is the largest pair of a place set S and a transition set C such that:
 * - a transition is in C when it is blocked and every place it is short of is in S;
 * - a place is in S when some member of C produces it, and *every* producer of it is short of some
 *   place in S.
 * It is found by starting from every short place and every blocked transition and dropping, until
 * nothing changes, whatever breaks its rule.
 *
 * The second rule makes S a siphon in the Petri-net sense (every transition that puts tokens into S
 * takes tokens from S), and a siphon insufficiently marked at a marking stays so whatever else
 * fires: no transition outside it offers a way in, even if every other missing fact were supplied.
 * The first rule, with "some member produces it", makes the siphon one a seed on its own places
 * restarts: every member is blocked only by facts other members would produce. So when the set is
 * not empty it holds a cycle, and the blockage is circular in #80's sense. When a cycle's place has
 * another producer short only of facts outside the set (an approval nothing grants, a spent fact),
 * that producer is a way in, the cycle is downstream of what it lacks, and the place is dropped.
 */
function blockedAt(definition, tokens) {
  const graph = incidence(definition);
  const ids = definition.transitions.map(({ id }) => id).sort();
  const missingOf = new Map(ids.map((id) => [id, [...graph.pre.get(id)]
    .filter(([place, weight]) => (tokens.get(place) ?? 0) < weight)
    .map(([place]) => place)
    .sort()]));
  const circular = new Set(ids.filter((id) => missingOf.get(id).length > 0));
  const places = new Set([...circular].flatMap((id) => missingOf.get(id)));
  const producersOf = new Map([...places].map((place) => [place, ids.filter((id) => produces(graph, id, place))]));
  for (let pruned = true; pruned;) {
    pruned = false;
    for (const id of [...circular]) {
      if (!missingOf.get(id).every((place) => places.has(place))) {
        circular.delete(id);
        pruned = true;
      }
    }
    for (const place of [...places]) {
      const producers = producersOf.get(place);
      const noWayIn = producers.every((id) => missingOf.get(id).some((short) => places.has(short)));
      if (!noWayIn || !producers.some((id) => circular.has(id))) {
        places.delete(place);
        pruned = true;
      }
    }
  }
  const through = new Map([...circular].map((id) => [id, missingOf.get(id).length]));
  return ids.map((id) => {
    const cycle = !circular.has(id) ? null : missingOf.get(id)
      .map((place) => prerequisitePath(graph, id, place, through))
      .filter((path) => path !== null)
      .reduce((best, path) => (best === null || path.length < best.length ? path : best), null);
    return { transition: id, missing: missingOf.get(id), cycle: cycle === null ? null : [...cycle, id] };
  });
}

function deadlocksOf(detail) {
  if (!Array.isArray(detail) || detail.length === 0) fail('AnalysisInvalid', 'a failed deadlock verdict must carry its dead markings');
  return detail.map((entry) => {
    if (entry === null || typeof entry !== 'object'
      || !Array.isArray(entry.tokens) || entry.tokens.some((pair) => !Array.isArray(pair) || pair.length !== 2
        || typeof pair[0] !== 'string' || !Number.isSafeInteger(pair[1]))
      || !Array.isArray(entry.witness) || entry.witness.some((step) => typeof step !== 'string')) {
      fail('AnalysisInvalid', 'a dead marking needs structured tokens and a witness sequence');
    }
    return entry;
  });
}

/** A dead marking as `{ placeId: tokens }`, from IX's structured `tokens`, never its label prose. */
const markingOf = ({ tokens }) => Object.fromEntries(tokens);

/**
 * Read one `ix_petri_analyze` document for `definition` into a closed reading.
 *
 * Fails closed: an unrecognised verdict token, a failed verdict with no structured marking or with
 * a `deadlock_count` below the markings it lists, a `holds` from a truncated enumeration, or an
 * analysis of any other net revision is refused rather than read as `NO_DEADLOCK`. The analysis
 * must have been requested with `ixNetDocument(definition)`, which names the net by its revision.
 *
 * Only the dead markings IX lists are classified (at most 8, in breadth-first order, so the initial
 * marking comes first when it is dead). The first whose blockage is circular makes the reading
 * `BOOTSTRAP_DEADLOCK`, which a longer list could not undo. Otherwise, when every dead marking was
 * listed and the enumeration finished, a dead initial marking is `MISSING_PREREQUISITE` and any
 * other is `REACHABLE_DEADLOCK`. When IX found more dead markings than it lists, or stopped short,
 * an unseen one could be circular, so the reading is `UNDECIDED`. Every reading says how many dead
 * markings IX found (`deadlockCount`) and how many of them were classified (`classifiedDeadlocks`).
 */
export function readBootstrapAnalysis(definition, analysis) {
  if (analysis === null || typeof analysis !== 'object' || Array.isArray(analysis)) {
    fail('AnalysisInvalid', 'the analysis must be an object');
  }
  const revision = netRevision(definition);
  if (analysis.net !== revision) fail('AnalysisNetMismatch', 'the analysis describes another net revision');
  const verdict = analysis.deadlock_free?.verdict;
  if (!VERDICTS.includes(verdict)) fail('AnalysisInvalid', 'unrecognised deadlock verdict');
  if (typeof analysis.truncated !== 'boolean' || !Number.isSafeInteger(analysis.states)) {
    fail('AnalysisInvalid', 'the analysis must state its enumeration');
  }
  const base = {
    schema: BOOTSTRAP_DEADLOCK_READING_SCHEMA,
    net: definition.name,
    netRevision: revision,
    states: analysis.states,
    truncated: analysis.truncated,
  };
  const none = { marking: null, witness: null, blocked: [] };
  const counted = (deadlockCount, classifiedDeadlocks) => ({ ...base, deadlockCount, classifiedDeadlocks });
  if (verdict === 'unknown') return deepFreeze({ ...counted(null, 0), reading: 'UNDECIDED', ...none });
  if (verdict === 'holds') {
    if (analysis.truncated) fail('AnalysisInvalid', 'a truncated enumeration cannot establish deadlock freedom');
    return deepFreeze({ ...counted(0, 0), reading: 'NO_DEADLOCK', ...none });
  }
  const listed = deadlocksOf(analysis.deadlock_free.detail);
  const deadlockCount = analysis.deadlock_count;
  if (!Number.isSafeInteger(deadlockCount) || deadlockCount < listed.length) {
    fail('AnalysisInvalid', 'a failed deadlock verdict must count at least the dead markings it lists');
  }
  const classified = listed.map((deadlock) => {
    const blocked = blockedAt(definition, new Map(deadlock.tokens));
    return { deadlock, blocked, circular: blocked.some(({ cycle }) => cycle !== null) };
  });
  const reading = (reading, { deadlock, blocked }) => deepFreeze({
    ...counted(deadlockCount, listed.length), reading, marking: markingOf(deadlock), witness: [...deadlock.witness], blocked,
  });
  const circular = classified.find((entry) => entry.circular);
  if (circular !== undefined) return reading('BOOTSTRAP_DEADLOCK', circular);
  if (deadlockCount > listed.length || analysis.truncated) {
    return deepFreeze({ ...counted(deadlockCount, listed.length), reading: 'UNDECIDED', ...none });
  }
  const atStart = classified.find(({ deadlock }) => deadlock.witness.length === 0);
  if (atStart !== undefined) return reading('MISSING_PREREQUISITE', atStart);
  return reading('REACHABLE_DEADLOCK', { deadlock: classified[0].deadlock, blocked: [] });
}
