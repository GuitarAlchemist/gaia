/**
 * lane-attempt.test.mjs — deadline, heartbeat timeout and compensation decisions (#180).
 *
 * Every instant is a fake clock: the tests hand `now` in and the module reads no clock. The four
 * boundaries #180 names are pinned to the millisecond, the compensation record is asserted on
 * every non-COMPLETE terminal decision, the event-log replay is shown not to depend on when the
 * caller asks, and the decision-to-transition map is checked against the shipped lane net so that
 * a transition added later fails here until `UNMAPPED` is updated.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { LANE_NET_TEMPLATE } from '../src/drain-petri-net.mjs';
import {
  COMPENSATION_ACTIONS,
  decideLaneAttempt,
  LANE_ATTEMPT_DECISIONS,
  LANE_ATTEMPT_PRECEDENCE,
  LANE_ATTEMPT_REFUSAL_CODES,
  LANE_ATTEMPT_TRANSITIONS,
  LANE_SLOT_RETURNING_EXITS,
  LaneAttemptError,
  MAX_LANE_ATTEMPT_EVENTS,
  replayLaneAttempt,
  UNMAPPED,
} from '../src/lane-attempt.mjs';

const START = Date.parse('2026-10-01T10:00:00.000Z');
const MINUTE = 60_000;
const at = (offsetMs) => new Date(START + offsetMs).toISOString();

const ATTEMPT = Object.freeze({
  laneId: 'lane-180',
  attemptNumber: 2,
  startedAt: at(0),
  deadline: at(30 * MINUTE),
  heartbeatTimeoutMs: 5 * MINUTE,
});

const QUIET = Object.freeze({ heartbeat: null, markerSeenAt: null, abortOrderedAt: null });

const decide = ({ attempt = ATTEMPT, observation = QUIET, now }) =>
  decideLaneAttempt({ attempt, observation, now });
const replay = (events, now, attempt = ATTEMPT) => replayLaneAttempt({ attempt, events, now });
/** The log as it stood at `now`: a caller reads what has happened, then takes `now`. */
const replayAt = (log, now) => replay(log.filter((event) => Date.parse(event.at) <= Date.parse(now)), now);

const beat = (offsetMs, step = 'L3') => ({ at: at(offsetMs), step });
const HB = (offsetMs, step = 'L3') => ({ kind: 'HEARTBEAT', at: at(offsetMs), step });
const MARKER = (offsetMs) => ({ kind: 'MARKER', at: at(offsetMs) });
const ABORT = (offsetMs) => ({ kind: 'ABORT', at: at(offsetMs) });

/** A transition arc names its place directly or as `{ place, weight }`. */
const arcPlaces = (arcs) => arcs.map((arc) => (typeof arc === 'string' ? arc : arc.place));
const leavesRunning = (transition) => arcPlaces(transition.inputs).includes('L_ATTEMPT_RUNNING');

test('the deadline reached exactly ends the attempt; a millisecond before it does not', () => {
  // A heartbeat every few minutes keeps the attempt alive, so only the deadline can decide.
  const observation = { ...QUIET, heartbeat: beat(29 * MINUTE) };

  const before = decide({ observation, now: at(30 * MINUTE - 1) });
  assert.equal(before.decision, 'CONTINUE');
  assert.equal(before.nextDueAt, at(30 * MINUTE), 'the caller learns when to look again');

  const exactly = decide({ observation, now: at(30 * MINUTE) });
  assert.equal(exactly.decision, 'DEADLINE_EXCEEDED');
  assert.equal(exactly.decisiveAt, at(30 * MINUTE));
  assert.equal(exactly.transition, null, 'the shipped net cannot carry a deadline out of a running attempt');
});

test('a heartbeat just inside the timeout continues; just outside it times out', () => {
  const observation = { ...QUIET, heartbeat: beat(10 * MINUTE, 'L4') };
  const expiry = 10 * MINUTE + ATTEMPT.heartbeatTimeoutMs;

  const inside = decide({ observation, now: at(expiry - 1) });
  assert.equal(inside.decision, 'CONTINUE');
  assert.equal(inside.nextDueAt, at(expiry), 'the heartbeat expiry comes due before the deadline');
  const outside = decide({ observation, now: at(expiry) });
  assert.equal(outside.decision, 'HEARTBEAT_TIMEOUT');
  assert.equal(outside.decisiveAt, at(expiry));
  assert.equal(outside.compensation.lastStep, 'L4');
  assert.equal(outside.compensation.lastHeartbeatAt, at(10 * MINUTE));

  // Before any heartbeat, the timeout runs from the start.
  assert.equal(decide({ now: at(ATTEMPT.heartbeatTimeoutMs - 1) }).decision, 'CONTINUE');
  const silent = decide({ now: at(ATTEMPT.heartbeatTimeoutMs) });
  assert.equal(silent.decision, 'HEARTBEAT_TIMEOUT');
  assert.equal(silent.compensation.lastStep, null);
});

test('a completion marker arriving after the deadline does not complete the attempt', () => {
  const alive = beat(29 * MINUTE);
  const inTime = decide({
    observation: { ...QUIET, heartbeat: alive, markerSeenAt: at(29 * MINUTE + 30_000) },
    now: at(29 * MINUTE + 31_000),
  });
  assert.equal(inTime.decision, 'COMPLETE');
  assert.equal(inTime.transition, 'T_EXIT_CLEAN');
  assert.equal(inTime.compensation, null);

  for (const markerOffset of [30 * MINUTE, 30 * MINUTE + 1]) {
    const late = decide({
      observation: { ...QUIET, heartbeat: alive, markerSeenAt: at(markerOffset) },
      now: at(31 * MINUTE),
    });
    assert.equal(late.decision, 'DEADLINE_EXCEEDED', `a marker at +${markerOffset} ms is late`);
    assert.equal(late.decisiveAt, at(30 * MINUTE));
    assert.equal(late.compensation.lateMarkerAt, at(markerOffset));
    assert.deepEqual(late.compensation.undo,
      ['STOP_ATTEMPT_PROCESS', 'RELEASE_LANE_SLOT', 'QUARANTINE_LATE_OUTPUT'],
      'late output is kept aside for a person, never read as completion and never discarded');
  }
});

test('an abort during a live heartbeat aborts the attempt and asks for lane-aborted', () => {
  const decision = decide({
    observation: { ...QUIET, heartbeat: beat(12 * MINUTE, 'L5'), abortOrderedAt: at(13 * MINUTE) },
    now: at(13 * MINUTE),
  });
  assert.equal(decision.decision, 'ABORTED');
  assert.equal(decision.decisiveAt, at(13 * MINUTE));
  assert.equal(decision.transition, null, 'the shipped net cannot abort a running attempt');
  assert.equal(decision.staleMarkerAt, null);
  assert.deepEqual(decision.compensation, {
    schema: 'gaia-lane-attempt-compensation/1',
    laneId: 'lane-180',
    attemptNumber: 2,
    decision: 'ABORTED',
    decisiveAt: at(13 * MINUTE),
    lastStep: 'L5',
    lastHeartbeatAt: at(12 * MINUTE),
    lateMarkerAt: null,
    undo: ['STOP_ATTEMPT_PROCESS', 'RELEASE_LANE_SLOT', 'DISCARD_UNVERIFIED_OUTPUT'],
    releaseSlotUnless: ['T_EXIT_CLEAN', 'T_EXIT_ERROR'],
    report: 'SEND_LANE_ABORTED',
  });
  assert.ok(Object.isFrozen(decision.compensation.undo), 'the record is frozen data');
});

test('every terminal decision other than COMPLETE carries a compensation record', () => {
  const offsets = [0, 1, 4 * MINUTE, 5 * MINUTE, 12 * MINUTE, 29 * MINUTE, 30 * MINUTE, 45 * MINUTE];
  const seen = new Set();
  for (const now of offsets) {
    for (const heartbeat of [null, beat(0), beat(Math.max(0, now - 1))]) {
      for (const markerSeenAt of [null, at(now)]) {
        for (const abortOrderedAt of [null, at(Math.max(0, now - 1))]) {
          const decision = decide({ observation: { heartbeat, markerSeenAt, abortOrderedAt }, now: at(now) });
          seen.add(decision.decision);
          const terminalFailure = !['CONTINUE', 'COMPLETE'].includes(decision.decision);
          assert.equal(decision.compensation !== null, terminalFailure,
            `${decision.decision} at +${now} ms: a compensation record exactly on failure`);
          if (terminalFailure) {
            assert.equal(decision.compensation.decision, decision.decision);
            assert.equal(decision.compensation.decisiveAt, decision.decisiveAt);
            assert.ok(decision.compensation.undo.length > 0);
            assert.ok(decision.compensation.undo.every((action) => COMPENSATION_ACTIONS.includes(action)));
            assert.equal(typeof decision.compensation.report, 'string');
          }
        }
      }
    }
  }
  assert.deepEqual([...seen].sort(), [...LANE_ATTEMPT_DECISIONS].sort(), 'the grid reaches every decision');
});

test('each mapped decision names a transition leaving L_ATTEMPT_RUNNING, and UNMAPPED is exactly the rest', () => {
  const transitions = new Map(LANE_NET_TEMPLATE.transitions.map((transition) => [transition.id, transition]));
  for (const [decision, id] of Object.entries(LANE_ATTEMPT_TRANSITIONS)) {
    assert.ok(transitions.has(id), `${decision} names ${id}, a transition of the lane net`);
    assert.ok(leavesRunning(transitions.get(id)), `${id} leaves a running attempt`);
  }

  const terminal = LANE_ATTEMPT_DECISIONS.filter((decision) => decision !== 'CONTINUE');
  assert.deepEqual([...UNMAPPED].sort(),
    terminal.filter((decision) => !(decision in LANE_ATTEMPT_TRANSITIONS)).sort(),
    'UNMAPPED is exactly the terminal decisions with no transition');

  // The observed provider error is the net's own exit and no decision of this module. Any other
  // transition out of a running attempt, whatever its arc form, is new: map it and shrink UNMAPPED.
  const leaving = LANE_NET_TEMPLATE.transitions.filter(leavesRunning).map((transition) => transition.id).sort();
  assert.deepEqual(leaving, ['T_EXIT_ERROR', ...Object.values(LANE_ATTEMPT_TRANSITIONS)].sort(),
    'a transition added out of L_ATTEMPT_RUNNING must be mapped here before this passes');
  assert.deepEqual(arcPlaces([{ place: 'L_ATTEMPT_RUNNING', weight: 1 }]), ['L_ATTEMPT_RUNNING'],
    'a weighted arc is read by its place');

  // The slot is released once: the compensation names exactly the exits that would return it.
  const returning = LANE_NET_TEMPLATE.transitions
    .filter((transition) => leavesRunning(transition) && arcPlaces(transition.outputs).includes('LANE_SLOTS'))
    .map((transition) => transition.id).sort();
  assert.deepEqual([...LANE_SLOT_RETURNING_EXITS].sort(), returning);

  assert.deepEqual([...LANE_ATTEMPT_PRECEDENCE].sort(), terminal.sort(),
    'every terminal decision has a place in the tie order');
});

test('equal instants resolve in precedence order', () => {
  const tie = 20 * MINUTE;
  const observation = { heartbeat: beat(tie - ATTEMPT.heartbeatTimeoutMs), markerSeenAt: at(tie), abortOrderedAt: at(tie) };
  assert.equal(decide({ observation, now: at(tie) }).decision, 'ABORTED');
  assert.equal(decide({ observation: { ...observation, abortOrderedAt: null }, now: at(tie) }).decision,
    'HEARTBEAT_TIMEOUT', 'a heartbeat expiring at the marker instant wins over the marker');
  const atDeadline = { ...QUIET, heartbeat: beat(30 * MINUTE - ATTEMPT.heartbeatTimeoutMs) };
  assert.equal(decide({ observation: atDeadline, now: at(30 * MINUTE) }).decision, 'DEADLINE_EXCEEDED',
    'the deadline wins over a heartbeat expiring at the same instant');
  assert.deepEqual(LANE_ATTEMPT_PRECEDENCE, ['ABORTED', 'DEADLINE_EXCEEDED', 'HEARTBEAT_TIMEOUT', 'COMPLETE']);
});

test('replaying the event log keeps a timeout that a later heartbeat would erase from a snapshot', () => {
  // Quiet from 3 to 10 minutes: the timeout fell due at 8, before the marker at 9.
  const log = [HB(3 * MINUTE), MARKER(9 * MINUTE), HB(10 * MINUTE, 'L6')];
  const snapshot = decide({
    observation: { heartbeat: beat(10 * MINUTE, 'L6'), markerSeenAt: at(9 * MINUTE), abortOrderedAt: null },
    now: at(11 * MINUTE),
  });
  assert.equal(snapshot.decision, 'COMPLETE', 'a snapshot only sees the last heartbeat');

  const answers = [9, 11, 29, 31, 600].map((minutes) => replayAt(log, at(minutes * MINUTE)));
  for (const answer of answers) {
    assert.equal(answer.decision, 'HEARTBEAT_TIMEOUT');
    assert.equal(answer.decisiveAt, at(8 * MINUTE));
    assert.equal(answer.compensation.lastHeartbeatAt, at(3 * MINUTE));
    assert.equal(answer.compensation.lateMarkerAt, at(9 * MINUTE));
  }

  // Two heartbeats alone: the gap between them still times the attempt out.
  assert.equal(`${replayAt([HB(3 * MINUTE), HB(10 * MINUTE)], at(11 * MINUTE)).decision}`, 'HEARTBEAT_TIMEOUT');
  assert.equal(replayAt([HB(3 * MINUTE), HB(10 * MINUTE)], at(11 * MINUTE)).decisiveAt, at(8 * MINUTE));
  // A heartbeat landing exactly at the expiry is too late: the boundary is inclusive.
  assert.equal(replayAt([HB(3 * MINUTE), HB(8 * MINUTE)], at(11 * MINUTE)).decision, 'HEARTBEAT_TIMEOUT');

  // With no quiet gap the same marker completes, at every later look.
  const steady = [HB(3 * MINUTE), HB(7 * MINUTE), MARKER(9 * MINUTE), HB(10 * MINUTE)];
  for (const minutes of [9, 11, 600]) {
    const answer = replayAt(steady, at(minutes * MINUTE));
    assert.equal(`${answer.decision}@${answer.decisiveAt}`, `COMPLETE@${at(9 * MINUTE)}`);
  }
});

test('a replayed decision, once terminal, stands at every later now', () => {
  const logs = [
    [HB(2 * MINUTE), HB(6 * MINUTE), ABORT(7 * MINUTE), MARKER(8 * MINUTE)],
    [HB(4 * MINUTE), HB(8 * MINUTE), HB(12 * MINUTE), HB(16 * MINUTE), HB(20 * MINUTE), HB(24 * MINUTE), HB(28 * MINUTE)],
    [MARKER(4 * MINUTE), ABORT(5 * MINUTE)],
    [ABORT(-MINUTE)],
    [HB(-1)],
    [MARKER(-MINUTE)],
    [],
  ];
  for (const [index, log] of logs.entries()) {
    let first = null;
    for (let minutes = 0; minutes <= 40; minutes += 1) {
      const answer = replayAt(log, at(minutes * MINUTE));
      if (first === null && answer.decision !== 'CONTINUE') first = answer;
      if (first !== null) {
        assert.equal(`${answer.decision}@${answer.decisiveAt}`, `${first.decision}@${first.decisiveAt}`,
          `log ${index} at ${minutes} min`);
      }
    }
    assert.notEqual(first, null, `log ${index} reaches a terminal decision`);
  }

  // The log may arrive out of order: replay sorts it by instant, keeping the log order on ties.
  const shuffled = replay([HB(10 * MINUTE, 'L6'), MARKER(9 * MINUTE), HB(3 * MINUTE)], at(11 * MINUTE));
  assert.equal(`${shuffled.decision}@${shuffled.decisiveAt}`, `HEARTBEAT_TIMEOUT@${at(8 * MINUTE)}`);

  // Events of one instant are judged together, whatever their order in the log.
  const expiry = 15 * MINUTE;
  const alive = [HB(2 * MINUTE), HB(6 * MINUTE), HB(expiry - ATTEMPT.heartbeatTimeoutMs)];
  const tied = (events) => replay([...alive, ...events], at(16 * MINUTE)).decision;
  assert.equal(tied([MARKER(expiry), ABORT(expiry)]), 'ABORTED', 'an abort beats a marker of the same instant');
  assert.equal(tied([MARKER(expiry)]), 'HEARTBEAT_TIMEOUT', 'an expiry beats a marker of the same instant');
  assert.equal(tied([ABORT(expiry)]), 'ABORTED', 'an abort beats an expiry of the same instant');

  // Heartbeats of one instant report the highest step, whatever their order in the log.
  for (const steps of [['L3', 'L4'], ['L4', 'L3'], ['L9', 'L10'], ['L10', 'L9']]) {
    const answer = replay([...steps.map((step) => HB(4 * MINUTE, step)), ABORT(5 * MINUTE)], at(6 * MINUTE));
    assert.equal(answer.compensation.lastStep, steps.includes('L10') ? 'L10' : 'L4', steps.join(','));
  }

  // The promise holds while events land in the order of their instants. One stamped earlier that
  // lands later reopens what an earlier replay decided, so the caller keeps the first decision.
  const before = replay([HB(3 * MINUTE)], at(8 * MINUTE));
  assert.equal(`${before.decision}@${before.decisiveAt}`, `HEARTBEAT_TIMEOUT@${at(8 * MINUTE)}`);
  assert.equal(replay([HB(3 * MINUTE), HB(8 * MINUTE - 1)], at(11 * MINUTE)).decision, 'CONTINUE');
});

test('a heartbeat or an abort before the start counts at the start, so skew never blocks the deadline', () => {
  const preStartAbort = decide({ observation: { ...QUIET, abortOrderedAt: at(-1) }, now: at(31 * MINUTE) });
  assert.equal(preStartAbort.decision, 'ABORTED');
  assert.equal(preStartAbort.decisiveAt, at(0), 'a pending abort aborts the attempt as it starts');
  assert.equal(replay([ABORT(-MINUTE)], at(31 * MINUTE)).decisiveAt, at(0));

  const skewedBeat = decide({ observation: { ...QUIET, heartbeat: beat(-1) }, now: at(31 * MINUTE) });
  assert.equal(skewedBeat.decision, 'HEARTBEAT_TIMEOUT', 'a hung lane is still timed out');
  assert.equal(skewedBeat.decisiveAt, at(ATTEMPT.heartbeatTimeoutMs));
  assert.equal(replay([HB(-1)], at(31 * MINUTE)).decision, 'HEARTBEAT_TIMEOUT');
});

test('a marker from before the start never completes the attempt and is reported as stale', () => {
  // An earlier attempt wrote it: it says nothing about this one.
  const leftover = { ...QUIET, markerSeenAt: at(-10 * MINUTE) };
  const early = decide({ observation: leftover, now: at(MINUTE) });
  assert.equal(`${early.decision}@${early.staleMarkerAt}`, `CONTINUE@${at(-10 * MINUTE)}`);
  const hung = decide({ observation: leftover, now: at(6 * MINUTE) });
  assert.equal(`${hung.decision}@${hung.decisiveAt}`, `HEARTBEAT_TIMEOUT@${at(5 * MINUTE)}`);
  assert.equal(hung.staleMarkerAt, at(-10 * MINUTE));
  assert.equal(hung.compensation.lateMarkerAt, null, 'a stale marker is not a late one');
  assert.deepEqual(hung.compensation.undo, ['STOP_ATTEMPT_PROCESS', 'RELEASE_LANE_SLOT', 'DISCARD_UNVERIFIED_OUTPUT']);

  const replayed = replay([MARKER(-MINUTE), MARKER(-10 * MINUTE)], at(MINUTE));
  assert.equal(`${replayed.decision}@${replayed.staleMarkerAt}`, `CONTINUE@${at(-10 * MINUTE)}`,
    'replay reports the first stale marker');
  const fresh = replay([MARKER(-10 * MINUTE), HB(MINUTE), MARKER(2 * MINUTE)], at(3 * MINUTE));
  assert.equal(`${fresh.decision}@${fresh.decisiveAt}`, `COMPLETE@${at(2 * MINUTE)}`,
    'the attempt\'s own marker still counts');
  assert.equal(fresh.staleMarkerAt, at(-10 * MINUTE));

  // A marker exactly at the start is this attempt's.
  assert.equal(decide({ observation: { ...QUIET, markerSeenAt: at(0) }, now: at(MINUTE) }).decision, 'COMPLETE');
  assert.equal(replay([MARKER(0)], at(MINUTE)).staleMarkerAt, null);
});

test('malformed calls, attempts, observations and events are refused with named codes', () => {
  const refused = (code, call, run = decideLaneAttempt) => assert.throws(() => run(call),
    (error) => error instanceof LaneAttemptError && error.code === code, code);
  const base = { attempt: ATTEMPT, observation: QUIET, now: at(MINUTE) };
  const attempt = (patch) => ({ ...base, attempt: { ...ATTEMPT, ...patch } });

  refused('InvalidCall', null);
  refused('InvalidCall', undefined);
  refused('InvalidCall', { ...base, extra: true });
  refused('InvalidAttempt', { ...base, attempt: { ...ATTEMPT, extra: true } });
  refused('InvalidAttempt', { ...base, attempt: null });
  refused('InvalidLaneId', attempt({ laneId: '' }));
  refused('InvalidAttemptNumber', attempt({ attemptNumber: 0 }));
  refused('InvalidAttemptNumber', attempt({ attemptNumber: 1.5 }));
  refused('InvalidInstant', attempt({ startedAt: '2026-10-01 10:00:00Z' }));
  refused('InvalidInstant', attempt({ deadline: '2026-02-30T10:00:00Z' }));
  refused('DeadlineNotAfterStart', attempt({ deadline: at(-1) }));
  refused('DeadlineNotAfterStart', attempt({ deadline: at(0) }));
  refused('InvalidHeartbeatTimeout', attempt({ heartbeatTimeoutMs: -1 }));
  refused('InvalidHeartbeatTimeout', attempt({ heartbeatTimeoutMs: 0 }));
  refused('InvalidHeartbeatTimeout', attempt({ heartbeatTimeoutMs: '300000' }));
  refused('InvalidInstant', { ...base, now: 'now' });
  refused('NowBeforeStart', { ...base, now: at(-1) });
  refused('InvalidObservation', { ...base, observation: { heartbeat: null, markerSeenAt: null } });
  refused('InvalidObservation', { ...base, observation: { ...QUIET, heartbeat: { at: at(0) } } });
  refused('InvalidHeartbeatStep', { ...base, observation: { ...QUIET, heartbeat: { at: at(0), step: 'step=L3' } } });
  refused('ObservationOutOfRange', { ...base, observation: { ...QUIET, markerSeenAt: at(MINUTE + 1) } });

  const log = (events, now = at(MINUTE)) => ({ attempt: ATTEMPT, events, now });
  refused('InvalidEvents', log('not a log'), replayLaneAttempt);
  refused('InvalidEvents', log(new Array(MAX_LANE_ATTEMPT_EVENTS + 1).fill(MARKER(0))), replayLaneAttempt);
  refused('InvalidEvent', log([{ kind: 'EXIT', at: at(0) }]), replayLaneAttempt);
  refused('InvalidEvent', log([{ kind: 'MARKER', at: at(0), step: 'L1' }]), replayLaneAttempt);
  refused('InvalidHeartbeatStep', log([{ kind: 'HEARTBEAT', at: at(0), step: 'L' }]), replayLaneAttempt);
  refused('ObservationOutOfRange', log([HB(MINUTE + 1)]), replayLaneAttempt);

  assert.ok(LANE_ATTEMPT_REFUSAL_CODES.every((code) => /^[A-Z][A-Za-z]+$/u.test(code)));
});

test('every input field is read once, so what is validated is what is decided', () => {
  let reads = 0;
  const attempt = { ...ATTEMPT };
  Object.defineProperty(attempt, 'laneId', {
    enumerable: true,
    get() { reads += 1; return reads === 1 ? 'lane-180' : '../../evil\nInjected: yes'; },
  });
  const decision = decideLaneAttempt({ attempt, observation: QUIET, now: at(31 * MINUTE) });
  assert.equal(reads, 1);
  assert.equal(decision.laneId, 'lane-180');
  assert.equal(decision.compensation.laneId, 'lane-180');

  // The log's length is read once: entries a getter appends while it is read are not decided.
  const log = [HB(MINUTE)];
  Object.defineProperty(log, 0, {
    enumerable: true,
    get() { log.push(ABORT(MINUTE)); return HB(MINUTE); },
  });
  assert.equal(replay(log, at(2 * MINUTE)).decision, 'CONTINUE');
});

const FORBIDDEN = [
  /\bimport\b/u, /\brequire\b/u, /\bglobalThis\b/u, /\bprocess\b/u, /\bfetch\b/u, /Math\.random/u,
  /\bcrypto\b/u, /\bperformance\b/u, /\bIntl\b/u, /\bset(?:Timeout|Interval|Immediate)\b/u, /\beval\b/u,
  /\bFunction\s*\(/u,
];

/** Code that reaches a clock, a process, the network, randomness or another module. */
function breaksPurity(source) {
  // Only comments that open a line are dropped: a '/*' inside a string or a regex stays code.
  const code = source.replace(/^\s*\/\*[\s\S]*?\*\//gmu, '').replace(/^\s*\/\/.*$/gmu, '');
  // The only clock-shaped uses allowed parse or format a caller-supplied instant.
  const dateUses = code.replaceAll('Date.parse(value)', '').replaceAll('new Date(ms)', '');
  return FORBIDDEN.some((pattern) => pattern.test(code)) || /\bDate\b/u.test(dateUses);
}

test('NEGATIVE CONTROL: the module reads no clock, spawns nothing and imports nothing', () => {
  const source = readFileSync(new URL('../src/lane-attempt.mjs', import.meta.url), 'utf8');
  assert.equal(breaksPurity(source), false);

  for (const leak of [
    "await import('node:os');", "import{hostname}from'node:os';", "import'node:os';",
    'Date();', "Date['now']();", '+new Date;', 'globalThis.Date.now();', "globalThis['process'].env;",
    'new Intl.DateTimeFormat().format();', 'Math.random();', 'crypto.randomUUID();',
    "fetch('https://example.invalid');", 'setImmediate(() => {});', 'performance.now();',
  ]) {
    assert.equal(breaksPurity(`${source}\n${leak}\n`), true, `the control rejects ${leak}`);
  }
  // A '/*' in a string or a regex must not hide the code after it up to the next comment's end.
  for (const leak of [
    "const GLOB = 'lanes/*.jsonl'; Date.now();", "const SEP = '/*'; globalThis.process.hrtime();",
    '/a\\/*b/u; Date.now();',
  ]) {
    assert.equal(breaksPurity(`${leak}\n${source}`), true, `the control sees ${leak} before a comment`);
  }
});
