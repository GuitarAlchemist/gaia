/**
 * lane-attempt.test.mjs — deadline, heartbeat timeout and compensation decisions (#180).
 *
 * Every instant is a fake clock: the tests hand `now` in and the module reads no clock. The four
 * boundaries #180 names are pinned to the millisecond, the compensation record is asserted on
 * every non-COMPLETE terminal decision, and the decision-to-transition map is checked against the
 * shipped lane net so that a transition added later fails here until `UNMAPPED` is updated.
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
  LaneAttemptError,
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

const beat = (offsetMs, step = 'L3') => ({ at: at(offsetMs), step });

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
    assert.equal(late.compensation.lateMarkerAt, at(markerOffset),
      'the late marker is reported for a person to look at, not read as completion');
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
    assert.ok(transitions.get(id).inputs.includes('L_ATTEMPT_RUNNING'), `${id} leaves a running attempt`);
  }

  const terminal = LANE_ATTEMPT_DECISIONS.filter((decision) => decision !== 'CONTINUE');
  assert.deepEqual([...UNMAPPED].sort(),
    terminal.filter((decision) => !(decision in LANE_ATTEMPT_TRANSITIONS)).sort(),
    'UNMAPPED is exactly the terminal decisions with no transition');

  // The observed provider error is the net's own exit and no decision of this module. Any other
  // transition out of a running attempt is new: map it to its decision and shrink UNMAPPED.
  const leaving = LANE_NET_TEMPLATE.transitions
    .filter((transition) => transition.inputs.includes('L_ATTEMPT_RUNNING'))
    .map((transition) => transition.id).sort();
  assert.deepEqual(leaving, ['T_EXIT_ERROR', ...Object.values(LANE_ATTEMPT_TRANSITIONS)].sort(),
    'a transition added out of L_ATTEMPT_RUNNING must be mapped here before this passes');

  assert.deepEqual([...LANE_ATTEMPT_PRECEDENCE].sort(), terminal.sort(),
    'every terminal decision has a place in the tie order');
});

test('equal instants resolve in precedence order, and a later look gives the same decision', () => {
  const tie = 20 * MINUTE;
  const observation = { heartbeat: beat(tie - ATTEMPT.heartbeatTimeoutMs), markerSeenAt: at(tie), abortOrderedAt: at(tie) };
  assert.equal(decide({ observation, now: at(tie) }).decision, 'ABORTED');
  assert.equal(decide({ observation: { ...observation, abortOrderedAt: null }, now: at(tie) }).decision,
    'HEARTBEAT_TIMEOUT', 'a heartbeat expiring at the marker instant wins over the marker');
  const atDeadline = { ...QUIET, heartbeat: beat(30 * MINUTE - ATTEMPT.heartbeatTimeoutMs) };
  assert.equal(decide({ observation: atDeadline, now: at(30 * MINUTE) }).decision, 'DEADLINE_EXCEEDED',
    'the deadline wins over a heartbeat expiring at the same instant');
  assert.deepEqual(LANE_ATTEMPT_PRECEDENCE, ['ABORTED', 'DEADLINE_EXCEEDED', 'HEARTBEAT_TIMEOUT', 'COMPLETE']);

  // Once every instant is past, the moment the caller asks changes nothing.
  const settled = { heartbeat: beat(3 * MINUTE), markerSeenAt: at(9 * MINUTE), abortOrderedAt: null };
  const answers = [9, 10, 29, 31, 600].map((minutes) => decide({ observation: settled, now: at(minutes * MINUTE) }));
  assert.deepEqual(new Set(answers.map((answer) => `${answer.decision}@${answer.decisiveAt}`)),
    new Set([`HEARTBEAT_TIMEOUT@${at(8 * MINUTE)}`]),
    'the quiet gap from 3 to 8 minutes decides, however late the caller looks');
});

test('malformed attempts and observations are refused with named codes', () => {
  const refused = (code, input) => assert.throws(() => decideLaneAttempt(input),
    (error) => error instanceof LaneAttemptError && error.code === code, code);
  const base = { attempt: ATTEMPT, observation: QUIET, now: at(MINUTE) };
  const attempt = (patch) => ({ ...base, attempt: { ...ATTEMPT, ...patch } });

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
  refused('ObservationOutOfRange', { ...base, observation: { ...QUIET, heartbeat: beat(-1) } });
  refused('ObservationOutOfRange', { ...base, observation: { ...QUIET, markerSeenAt: at(MINUTE + 1) } });
  refused('ObservationOutOfRange', { ...base, observation: { ...QUIET, abortOrderedAt: at(-MINUTE) } });

  assert.ok(LANE_ATTEMPT_REFUSAL_CODES.every((code) => /^[A-Z][A-Za-z]+$/u.test(code)));
});

test('NEGATIVE CONTROL: the module reads no clock, spawns nothing and imports nothing', () => {
  const source = readFileSync(new URL('../src/lane-attempt.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /Date\.now|new Date\(\s*\)|performance\.now|process\.|^import /mu);
  assert.doesNotMatch(source, /child_process|node:fs|setTimeout|setInterval/u);
});
