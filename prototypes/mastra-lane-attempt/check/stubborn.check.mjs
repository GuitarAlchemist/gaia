/**
 * E3. A step that ignores cancellation. Gaia decides HEARTBEAT_TIMEOUT and asks for
 * STOP_ATTEMPT_PROCESS. Mastra's `cancel()` aborts a signal and marks the run `canceled`: it stops
 * no code, so the step still performs its side effect after the cancel. Only a process boundary
 * can honour Gaia's stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { replayLaneAttempt } from '../../../src/lane-attempt.mjs';
import { createAttemptObserver, observeStream } from '../src/attempt-observer.mjs';
import { coordinatorClock, gaiaAttempt, mastraWith, settle, stubbornWork } from './fixtures.mjs';

const START = '2026-10-13T10:00:00.000Z';

test('E3: Mastra cancel marks the run canceled while the stubborn step still runs its side effect', async () => {
  const { workflow, effects, release } = stubbornWork();
  const mastra = mastraWith({ stubborn: workflow });
  const run = await mastra.getWorkflow('stubborn').createRun();
  const observer = createAttemptObserver(['start', 'work', 'finish']);
  const clock = coordinatorClock(START);
  const attempt = gaiaAttempt({ startedAt: clock(), heartbeatTimeoutMs: 60_000 });

  const reading = observeStream(run.stream({ inputData: { n: 0 } }), observer, clock);
  await settle();
  assert.deepEqual(observer.events().map((e) => e.step), ['L1', 'L1', 'L2'], 'work started and went quiet');
  assert.deepEqual(effects, ['work started']);

  clock.advance(120_000);
  const decision = replayLaneAttempt({ attempt, events: observer.events(), now: clock.peek() });
  assert.equal(decision.decision, 'HEARTBEAT_TIMEOUT');
  assert.equal(decision.compensation.lastStep, 'L2');
  assert.equal(decision.compensation.undo[0], 'STOP_ATTEMPT_PROCESS');

  // The coordinator honours the compensation the only way Mastra offers in-process.
  await run.cancel();
  const stored = await mastra.getWorkflow('stubborn').getWorkflowRunById(run.runId);
  assert.equal(stored.status, 'canceled', 'Mastra records the run as canceled');

  release();
  const result = await reading;
  await settle();
  assert.deepEqual(effects, ['work started', 'work finished its side effect'],
    'the canceled step still completed its side effect');
  assert.equal(result.status, 'canceled');
  assert.equal(observer.claims().status, 'canceled');
  assert.ok(!observer.events().some((e) => e.step === 'L3'), 'no later step ran');

  const after = replayLaneAttempt({ attempt, events: observer.events(), now: clock.peek() });
  assert.equal(after.decision, 'HEARTBEAT_TIMEOUT');
  assert.equal(after.decisiveAt, decision.decisiveAt);
});
