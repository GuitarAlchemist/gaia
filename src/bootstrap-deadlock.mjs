/**
 * bootstrap-deadlock.mjs — issue #80's tracer cycle as Place/Transition nets, and the reading of
 * an externally computed reachability analysis as a typed bootstrap state.
 *
 * WHAT THIS DECIDES, AND WHAT IT DOES NOT
 * ---------------------------------------
 * Issue #80 defines a Bootstrap Deadlock as "a circular prerequisite with no currently admissible
 * initial transition". That definition is a property of the initial marking of a net, and this
 * module states it exactly that way: a dead marking reached by the empty firing sequence. A dead
 * marking reached only after some firing is a different, ordinary deadlock, and a net whose
 * enumeration was cut short is undecided. Nothing is inferred beyond that.
 *
 * The reachability analysis itself is not computed here. Issue #100's grooming asks to avoid a
 * duplicate Petri implementation, and ADR issue #107 routes Rust capabilities through a DuckDB
 * extension port, so the enumeration is IX's `ix_petri_analyze` behind `duckdb-ix-petri.mjs`.
 * This core only (1) declares the nets, (2) content-addresses them so a recorded analysis is bound
 * to the exact net it describes, and (3) reads an analysis document into a closed reading. The one
 * computation it performs is enabledness at the initial marking, to name what each transition is
 * missing — the "missing first fact" #80 asks the explanation to carry.
 *
 * THE THREE NETS
 * --------------
 * All three model the hosted Draft pump observation seam named as #80's tracer scenario, with the
 * same places and transitions. They differ only where the claim under test differs:
 *
 * - `asWritten` — the cycle as #80 states it: a pump run requires a published Control Room
 *   observation, and the first observation can only come from a run.
 * - `asShipped` — the same seam read off the shipped code: the scheduled intake takes no
 *   observation (`runHostedDraftIntake` in src/hosted-draft-pump.mjs), and the producer accepts
 *   `priorObservation = null` (`requireMonotonic` in src/hosted-draft-pump-observation.mjs).
 * - `seededControl` — `asWritten` with a synthetic first observation, the control #80's grooming
 *   requires to be "not labelled deadlocked". It models a seed; it installs nothing.
 *
 * docs/bootstrap-deadlock.md maps every place and transition to the code it stands for.
 */

import { createHash } from 'node:crypto';

export const BOOTSTRAP_DEADLOCK_READING_SCHEMA = 'gaia-bootstrap-deadlock-reading/1';

/** Closed. `BOOTSTRAP_DEADLOCK` is #80's typed state; the others say why it is not that. */
export const BOOTSTRAP_READINGS = Object.freeze([
  'BOOTSTRAP_DEADLOCK', 'REACHABLE_DEADLOCK', 'NO_DEADLOCK', 'UNDECIDED',
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

const PLACES = Object.freeze([
  ['P_OBSERVATION_SCHEMA', 'observation schema merged (contract establishment)', 1],
  ['P_TICK_DUE', 'scheduled recovery tick due', 1],
  ['P_NO_OBSERVATION', 'no pump observation published yet', 1],
  ['P_OBSERVATION', 'verified pump observation published', 0],
  ['P_INTAKE_RECEIPT', 'hosted intake receipt written', 0],
]);

const TRANSITIONS = Object.freeze([
  ['T_RUN_PUMP', 'run hosted Draft intake'],
  ['T_PRODUCE_FIRST_OBSERVATION', 'seal the first observation'],
  ['T_PRODUCE_NEXT_OBSERVATION', 'seal a later observation'],
  ['T_REFUSE_OBSERVATION', 'observation refused, publish nothing'],
]);

/** Arcs every variant shares: production, replacement and refusal of an observation. */
const SHARED_ARCS = Object.freeze([
  ['P_INTAKE_RECEIPT', 'T_PRODUCE_FIRST_OBSERVATION'],
  ['P_NO_OBSERVATION', 'T_PRODUCE_FIRST_OBSERVATION'],
  ['P_OBSERVATION_SCHEMA', 'T_PRODUCE_FIRST_OBSERVATION'],
  ['T_PRODUCE_FIRST_OBSERVATION', 'P_OBSERVATION'],
  ['T_PRODUCE_FIRST_OBSERVATION', 'P_OBSERVATION_SCHEMA'],
  ['T_PRODUCE_FIRST_OBSERVATION', 'P_TICK_DUE'],
  ['P_INTAKE_RECEIPT', 'T_PRODUCE_NEXT_OBSERVATION'],
  ['P_OBSERVATION', 'T_PRODUCE_NEXT_OBSERVATION'],
  ['P_OBSERVATION_SCHEMA', 'T_PRODUCE_NEXT_OBSERVATION'],
  ['T_PRODUCE_NEXT_OBSERVATION', 'P_OBSERVATION'],
  ['T_PRODUCE_NEXT_OBSERVATION', 'P_OBSERVATION_SCHEMA'],
  ['T_PRODUCE_NEXT_OBSERVATION', 'P_TICK_DUE'],
  ['P_INTAKE_RECEIPT', 'T_REFUSE_OBSERVATION'],
  ['T_REFUSE_OBSERVATION', 'P_TICK_DUE'],
]);

/** The run itself. `asWritten` adds the observation prerequisite; `asShipped` has none. */
const RUN_ARCS = Object.freeze([['P_TICK_DUE', 'T_RUN_PUMP'], ['T_RUN_PUMP', 'P_INTAKE_RECEIPT']]);
export const CLAIMED_PREREQUISITE_ARCS = Object.freeze([
  ['P_OBSERVATION', 'T_RUN_PUMP'], ['T_RUN_PUMP', 'P_OBSERVATION'],
]);

function net(name, { tokens = {}, runArcs }) {
  return {
    name,
    places: PLACES.map(([id, label, initial]) => ({ id, name: label, tokens: tokens[id] ?? initial })),
    transitions: TRANSITIONS.map(([id, label]) => ({ id, name: label })),
    arcs: [...runArcs, ...SHARED_ARCS].map(([from, to]) => ({ from, to })),
  };
}

export const HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS = deepFreeze({
  asWritten: net('gaia#80 hosted Draft pump observation, as written', {
    runArcs: [...RUN_ARCS, ...CLAIMED_PREREQUISITE_ARCS],
  }),
  asShipped: net('gaia#80 hosted Draft pump observation, as shipped', { runArcs: RUN_ARCS }),
  seededControl: net('gaia#80 hosted Draft pump observation, as written with a modelled seed', {
    tokens: { P_NO_OBSERVATION: 0, P_OBSERVATION: 1 },
    runArcs: [...RUN_ARCS, ...CLAIMED_PREREQUISITE_ARCS],
  }),
});

/** For each transition, the pre-set places the initial marking leaves short. Sorted by id. */
function blockedAtInitialMarking(definition) {
  const tokens = new Map(definition.places.map(({ id, tokens: count }) => [id, count]));
  return definition.transitions
    .map(({ id }) => ({
      transition: id,
      missing: definition.arcs
        .filter(({ from, to, weight = 1 }) => to === id && (tokens.get(from) ?? 0) < weight)
        .map(({ from }) => from)
        .sort(),
    }))
    .sort((left, right) => (left.transition < right.transition ? -1 : 1));
}

function deadlocksOf(detail) {
  if (!Array.isArray(detail) || detail.length === 0) fail('AnalysisInvalid', 'a failed deadlock verdict must carry its dead markings');
  return detail.map((entry) => {
    if (entry === null || typeof entry !== 'object' || typeof entry.marking !== 'string'
      || !Array.isArray(entry.witness) || entry.witness.some((step) => typeof step !== 'string')) {
      fail('AnalysisInvalid', 'a dead marking needs a marking and a witness sequence');
    }
    return entry;
  });
}

/**
 * Read one `ix_petri_analyze` document for `definition` into a closed reading.
 *
 * Fails closed: an unrecognised verdict token, a failed verdict with no marking, or an analysis
 * naming a different net is refused rather than read as `NO_DEADLOCK`.
 */
export function readBootstrapAnalysis(definition, analysis) {
  if (analysis === null || typeof analysis !== 'object' || Array.isArray(analysis)) {
    fail('AnalysisInvalid', 'the analysis must be an object');
  }
  if (analysis.net !== definition.name) fail('AnalysisNetMismatch', 'the analysis describes another net');
  const verdict = analysis.deadlock_free?.verdict;
  if (!VERDICTS.includes(verdict)) fail('AnalysisInvalid', 'unrecognised deadlock verdict');
  if (typeof analysis.truncated !== 'boolean' || !Number.isSafeInteger(analysis.states)) {
    fail('AnalysisInvalid', 'the analysis must state its enumeration');
  }
  const base = {
    schema: BOOTSTRAP_DEADLOCK_READING_SCHEMA,
    net: definition.name,
    netRevision: netRevision(definition),
    states: analysis.states,
    truncated: analysis.truncated,
  };
  if (verdict === 'unknown') {
    return deepFreeze({ ...base, reading: 'UNDECIDED', marking: null, witness: null, blocked: [] });
  }
  if (verdict === 'holds') {
    return deepFreeze({ ...base, reading: 'NO_DEADLOCK', marking: null, witness: null, blocked: [] });
  }
  const deadlocks = deadlocksOf(analysis.deadlock_free.detail);
  const atStart = deadlocks.find(({ witness }) => witness.length === 0);
  if (atStart !== undefined) {
    return deepFreeze({
      ...base, reading: 'BOOTSTRAP_DEADLOCK', marking: atStart.marking, witness: [],
      blocked: blockedAtInitialMarking(definition),
    });
  }
  return deepFreeze({
    ...base, reading: 'REACHABLE_DEADLOCK', marking: deadlocks[0].marking,
    witness: [...deadlocks[0].witness], blocked: [],
  });
}
