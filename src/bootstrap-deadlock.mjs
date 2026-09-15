/**
 * bootstrap-deadlock.mjs — issue #80's tracer scenario as Place/Transition nets, and the reading of
 * an externally computed reachability analysis as a typed bootstrap state.
 *
 * WHAT THIS DECIDES, AND WHAT IT DOES NOT
 * ---------------------------------------
 * Issue #80 defines a Bootstrap Deadlock as "a circular prerequisite with no currently admissible
 * initial transition", and its first acceptance criterion refuses an acyclic graph. This module
 * states both halves exactly: the initial marking is dead (a dead marking reached by the empty
 * firing sequence), AND some transition blocked there is missing a place that lies on a directed
 * prerequisite cycle back to that same transition. A net dead at its initial marking with no such
 * cycle is `MISSING_PREREQUISITE`, not a bootstrap deadlock. A dead marking reached only after some
 * firing is an ordinary `REACHABLE_DEADLOCK`, and a net whose enumeration was cut short is
 * `UNDECIDED`. Nothing is inferred beyond that.
 *
 * The reachability analysis itself is not computed here. Issue #100's grooming asks to avoid a
 * duplicate Petri implementation, and ADR issue #107 routes Rust capabilities through a DuckDB
 * extension port, so the enumeration is IX's `ix_petri_analyze` behind `duckdb-ix-petri.mjs`.
 * This core only (1) declares the nets, (2) content-addresses them and hands IX that address as
 * the net's name, so an analysis is bound to the exact net it describes, and (3) reads an analysis
 * document into a closed reading. The computations it performs are structural: enabledness at the
 * initial marking, to name what each transition is missing, and the shortest prerequisite cycle
 * through it — the "missing first fact" and "smallest cycle" #80 asks the explanation to carry.
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
 *   #80's receipt seed; an observation ages into STALE after 12 h and the next run seals again from
 *   its receipt. No code records a steady-state proof, a seed identity or a Retirement Receipt, so
 *   `P_STEADY_STATE_PROOF` holds no token.
 * - `asSpecified` — `asShipped` plus one token in `P_STEADY_STATE_PROOF`: #80's rules, with a later
 *   independently reconciled run that proves steady state and lets the seed retire.
 * - `runGatedOnObservation` — `asShipped` with a run that requires a fresh observation. #80 does not
 *   claim this and the code does not do it; it is the cyclic control a real bootstrap deadlock is
 *   detected on.
 * - `seededGatedControl` — `runGatedOnObservation` with a modelled seed already installed, the
 *   control #80's grooming requires not to be labelled a bootstrap deadlock. It installs nothing.
 *
 * `acyclicControl` is a separate two-place net, dead at its initial marking with no cycle, for the
 * acyclic refusal. docs/bootstrap-deadlock.md maps every place and transition to the code.
 */

import { createHash } from 'node:crypto';

export const BOOTSTRAP_DEADLOCK_READING_SCHEMA = 'gaia-bootstrap-deadlock-reading/2';

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

function net(name, { tokens = {}, extraArcs = [] } = {}) {
  return {
    name,
    places: PLACES.map(([id, label, initial]) => ({ id, name: label, tokens: tokens[id] ?? initial })),
    transitions: TRANSITIONS.map(([id, label]) => ({ id, name: label })),
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
    tokens: SEED_INSTALLED, extraArcs: CLAIMED_PREREQUISITE_ARCS,
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

/**
 * The shortest directed prerequisite path from transition `start` to place `goal`, as ids, or null.
 * A transition leads to the places it strictly adds tokens to (a read arc produces nothing); a place
 * leads to the transitions that need it. Neighbours are visited in id order, so ties are stable.
 */
function prerequisitePath({ pre, post }, start, goal) {
  const next = (node) => (pre.has(node)
    ? [...post.get(node)].filter(([place, weight]) => weight > (pre.get(node).get(place) ?? 0)).map(([place]) => place)
    : [...pre].filter(([, needs]) => needs.has(node)).map(([id]) => id)
  ).sort();
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
 * For each transition, the pre-set places the initial marking leaves short, and the shortest cycle
 * `[transition, ..., missing place, transition]` through one of them, or null when none of its
 * missing places can be produced downstream of it. Sorted by transition id.
 */
function blockedAtInitialMarking(definition) {
  const tokens = new Map(definition.places.map(({ id, tokens: count }) => [id, count]));
  const graph = incidence(definition);
  return definition.transitions
    .map(({ id }) => {
      const missing = [...graph.pre.get(id)]
        .filter(([place, weight]) => (tokens.get(place) ?? 0) < weight)
        .map(([place]) => place)
        .sort();
      const cycle = missing
        .map((place) => prerequisitePath(graph, id, place))
        .filter((path) => path !== null)
        .reduce((best, path) => (best === null || path.length < best.length ? path : best), null);
      return { transition: id, missing, cycle: cycle === null ? null : [...cycle, id] };
    })
    .sort((left, right) => (left.transition < right.transition ? -1 : 1));
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
 * Fails closed: an unrecognised verdict token, a failed verdict with no structured marking, or an
 * analysis of any other net revision is refused rather than read as `NO_DEADLOCK`. The analysis must
 * have been requested with `ixNetDocument(definition)`, which names the net by its revision.
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
  if (verdict === 'unknown') return deepFreeze({ ...base, reading: 'UNDECIDED', ...none });
  if (verdict === 'holds') return deepFreeze({ ...base, reading: 'NO_DEADLOCK', ...none });
  const deadlocks = deadlocksOf(analysis.deadlock_free.detail);
  const atStart = deadlocks.find(({ witness }) => witness.length === 0);
  if (atStart !== undefined) {
    const blocked = blockedAtInitialMarking(definition);
    return deepFreeze({
      ...base,
      reading: blocked.some(({ cycle }) => cycle !== null) ? 'BOOTSTRAP_DEADLOCK' : 'MISSING_PREREQUISITE',
      marking: markingOf(atStart), witness: [], blocked,
    });
  }
  return deepFreeze({
    ...base, reading: 'REACHABLE_DEADLOCK', marking: markingOf(deadlocks[0]),
    witness: [...deadlocks[0].witness], blocked: [],
  });
}
