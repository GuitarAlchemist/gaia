/**
 * E1. A Mastra run that finishes is a Gaia attempt that completes: every step reads as a
 * heartbeat, the finish as the marker, and Gaia's own core decides COMPLETE.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { replayLaneAttempt } from '../../../src/lane-attempt.mjs';
import { createAttemptObserver, observeStream, AttemptObserverError } from '../src/attempt-observer.mjs';
import { coordinatorClock, gaiaAttempt, mastraWith, threeSteps } from './fixtures.mjs';

const START = '2026-10-13T08:00:00.000Z';

test('E1: a finished Mastra run is decided COMPLETE by the unchanged Gaia core', async () => {
  const mastra = mastraWith({ threeSteps: threeSteps() });
  const run = await mastra.getWorkflow('threeSteps').createRun();
  const observer = createAttemptObserver(['prepare', 'build', 'report']);
  const clock = coordinatorClock(START);
  const attempt = gaiaAttempt({ startedAt: clock() });

  const result = await observeStream(run.stream({ inputData: { n: 0 } }), observer, clock);
  assert.equal(result.status, 'success');
  assert.deepEqual(result.result, { n: 111 });

  const events = observer.events();
  assert.deepEqual(events.map((e) => e.step ?? e.kind),
    ['L1', 'L1', 'L2', 'L2', 'L3', 'L3', 'MARKER'], 'each step starts and ends as a heartbeat, the finish is the marker');

  const decision = replayLaneAttempt({ attempt, events, now: clock.peek() });
  assert.equal(decision.decision, 'COMPLETE');
  assert.equal(decision.transition, 'T_EXIT_CLEAN');
  assert.equal(decision.decisiveAt, events.at(-1).at);
  assert.equal(decision.compensation, null);
  assert.equal(observer.claims().status, 'success');
});

test('E1 control: the same run past its deadline is not completed by its late marker', async () => {
  const mastra = mastraWith({ threeSteps: threeSteps() });
  const run = await mastra.getWorkflow('threeSteps').createRun();
  const observer = createAttemptObserver(['prepare', 'build', 'report']);
  // Each observed chunk costs two minutes on the coordinator's clock; the deadline is ten.
  const clock = coordinatorClock(START, 120_000);
  const attempt = gaiaAttempt({ startedAt: clock(), deadlineMs: 600_000, heartbeatTimeoutMs: 300_000 });

  await observeStream(run.stream({ inputData: { n: 0 } }), observer, clock);
  const decision = replayLaneAttempt({ attempt, events: observer.events(), now: clock.peek() });
  assert.equal(observer.claims().status, 'success', 'Mastra reports success');
  assert.equal(decision.decision, 'DEADLINE_EXCEEDED', 'Gaia does not accept it');
  assert.equal(decision.decisiveAt, attempt.deadline);
  assert.ok(decision.compensation.lateMarkerAt, 'the marker is reported as late');
  assert.ok(decision.compensation.undo.includes('QUARANTINE_LATE_OUTPUT'));
});

test('E1 refusal: a step the caller did not declare is refused, not counted as progress', async () => {
  const mastra = mastraWith({ threeSteps: threeSteps() });
  const run = await mastra.getWorkflow('threeSteps').createRun();
  const observer = createAttemptObserver(['prepare', 'report']);
  await assert.rejects(observeStream(run.stream({ inputData: { n: 0 } }), observer, coordinatorClock(START)),
    (error) => error instanceof AttemptObserverError && error.code === 'UndeclaredStep' && /build/.test(error.message));
});
