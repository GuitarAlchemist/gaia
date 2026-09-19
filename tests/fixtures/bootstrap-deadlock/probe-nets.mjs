/**
 * Small nets that probe how a dead marking is labelled, from the adversarial re-reviews of #150.
 *
 * Their analyses are recorded through the real extension in probe-nets.json, next to this file, by
 * the same runner as the hosted Draft pump nets (see docs/bootstrap-deadlock.md), so every `states`,
 * `state`, `deadlock_count`, `tokens` and `witness` a test reads is one IX returned for that net.
 */

import { HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS } from '../../../src/bootstrap-deadlock.mjs';

/** Places as `[id, tokens]`, transitions as ids, arcs as `[from, to]` or `[from, to, weight]`. */
const small = (name, places, transitions, arcs) => ({
  name,
  places: places.map(([id, tokens]) => ({ id, tokens })),
  transitions: transitions.map((id) => ({ id })),
  arcs: arcs.map(([from, to, weight]) => (weight === undefined ? { from, to } : { from, to, weight })),
});

/** A read arc: `transition` needs a token in `place` and puts it back. */
const reads = (place, transition) => [[place, transition], [transition, place]];

const seeded = HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS.seededGatedControl;
const eight = [0, 1, 2, 3, 4, 5, 6, 7];

export const PROBE_NETS = Object.freeze({
  pureCycle: small('pure cycle', [['A', 0], ['C', 0]], ['T', 'U'],
    [['A', 'T'], ['T', 'C'], ['C', 'U'], ['U', 'A']]),
  wedgesOnCycleLater: small('one step, then the pure cycle', [['S', 1], ['A', 0], ['C', 0]], ['T0', 'T', 'U'],
    [['S', 'T0'], ['A', 'T'], ['T', 'C'], ['C', 'U'], ['U', 'A']]),
  mutualReadArcs: small('T reads A and writes B, U reads B and writes A', [['A', 0], ['B', 0]], ['T', 'U'],
    [...reads('A', 'T'), ['T', 'B'], ...reads('B', 'U'), ['U', 'A']]),
  weightedCycle: small('a cycle one token short on a weight-2 arc', [['A', 1], ['C', 0]], ['T', 'U'],
    [['A', 'T', 2], ['T', 'C'], ['C', 'U'], ['U', 'A']]),
  approvalWithWorkLoop: small('approval nobody grants, plus a reset loop',
    [['P_APPROVAL', 0], ['P_IDLE', 1], ['P_DONE', 0]], ['T_WORK', 'T_RESET'],
    [['P_APPROVAL', 'T_WORK'], ['P_IDLE', 'T_WORK'], ['T_WORK', 'P_DONE'], ['P_DONE', 'T_RESET'], ['T_RESET', 'P_IDLE']]),
  retryLoopBehindApproval: small('a retry loop behind an approval nobody grants',
    [['P_APPROVAL', 0], ['P_RUNNING', 0], ['P_FAILED', 0], ['P_DONE', 0]], ['T_START', 'T_FAIL', 'T_RETRY', 'T_FINISH'],
    [['P_APPROVAL', 'T_START'], ['T_START', 'P_RUNNING'], ['P_RUNNING', 'T_FAIL'], ['T_FAIL', 'P_FAILED'],
      ['P_FAILED', 'T_RETRY'], ['T_RETRY', 'P_RUNNING'], ['P_RUNNING', 'T_FINISH'], ['T_FINISH', 'P_DONE']]),
  blockerPlusUnrelatedLoop: small('approval nobody grants with a reset loop, plus a disconnected empty loop',
    [['P_APPROVAL', 0], ['P_IDLE', 1], ['P_DONE', 0], ['X', 0], ['Y', 0]], ['T_WORK', 'T_RESET', 'TX', 'TY'],
    [['P_APPROVAL', 'T_WORK'], ['P_IDLE', 'T_WORK'], ['T_WORK', 'P_DONE'], ['P_DONE', 'T_RESET'], ['T_RESET', 'P_IDLE'],
      ['X', 'TX'], ['TX', 'Y'], ['Y', 'TY'], ['TY', 'X']]),
  cyclePlusUnproducible: small('a cycle whose entry also needs a place nothing produces',
    [['A', 0], ['B', 0], ['C', 0]], ['T', 'U'], [['A', 'T'], ['B', 'T'], ['T', 'C'], ['C', 'U'], ['U', 'A']]),
  loopAfterWedge: small('one step, then an approval nobody grants',
    [['S', 1], ['P_APPROVAL', 0], ['P_IDLE', 0], ['P_DONE', 0]], ['T0', 'T_WORK', 'T_RESET'],
    [['S', 'T0'], ['T0', 'P_IDLE'], ['P_APPROVAL', 'T_WORK'], ['P_IDLE', 'T_WORK'], ['T_WORK', 'P_DONE'],
      ['P_DONE', 'T_RESET'], ['T_RESET', 'P_IDLE']]),
  hiddenBehindEight: small('eight plain dead ends listed before a circular one',
    [['S', 1], ...eight.map((i) => [`D${i}`, 0]), ['G', 0], ['A', 0], ['C', 0]],
    [...eight.map((i) => `T_A${i}`), 'T_Z', 'T', 'U'],
    [...eight.flatMap((i) => [['S', `T_A${i}`], [`T_A${i}`, `D${i}`]]), ['S', 'T_Z'], ['T_Z', 'G'],
      ['A', 'T'], ['T', 'C'], ['C', 'U'], ['U', 'A'], ...reads('G', 'T'), ...reads('G', 'U')]),
  seededGatedControlWithProof: {
    ...seeded,
    name: `${seeded.name}, with a steady-state proof`,
    places: seeded.places.map((place) => (place.id === 'P_STEADY_STATE_PROOF' ? { ...place, tokens: 1 } : place)),
  },
});
