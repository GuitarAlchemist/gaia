/**
 * E5. Recovery re-executes. A run whose step performed a side effect and then went quiet stays
 * `running` in storage. A second Mastra instance over the same store lists it as active, and
 * `restart()` runs the step again: the side effect happens twice, while the first execution is
 * still alive. Gaia had already ended attempt 1 with STOP_ATTEMPT_PROCESS; nothing in Mastra's
 * restart waited for that stop. Re-driving belongs to a new Gaia attempt, after the stop.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '@mastra/core/storage';

import { replayLaneAttempt } from '../../../src/lane-attempt.mjs';
import { createAttemptObserver, observeStream } from '../src/attempt-observer.mjs';
import { coordinatorClock, countedEffect, gaiaAttempt, mastraWith, settle } from './fixtures.mjs';

const START = '2026-10-13T12:00:00.000Z';

test('E5: restart re-executes a side effect while the first execution still lives', async () => {
  const hang = { on: true };
  const { build, ledger } = countedEffect(hang);
  const store = new InMemoryStore();
  const clock = coordinatorClock(START);

  const first = mastraWith({ counted: build() }, store);
  const run1 = await first.getWorkflow('counted').createRun();
  const observer = createAttemptObserver(['effect']);
  const attempt1 = gaiaAttempt({ startedAt: clock(), heartbeatTimeoutMs: 60_000 });
  let firstExecutionEnded = false;
  observeStream(run1.stream({ inputData: {} }), observer, clock).finally(() => { firstExecutionEnded = true; });
  await settle();
  assert.equal(ledger.effects, 1);

  clock.advance(120_000);
  const decision1 = replayLaneAttempt({ attempt: attempt1, events: observer.events(), now: clock.peek() });
  assert.equal(decision1.decision, 'HEARTBEAT_TIMEOUT');
  assert.equal(decision1.compensation.undo[0], 'STOP_ATTEMPT_PROCESS');

  // A second process over the same store, as after a crash or on a second replica.
  hang.on = false;
  const second = mastraWith({ counted: build() }, store);
  const active = await second.getWorkflow('counted').listActiveWorkflowRuns();
  assert.ok(active.runs.some((r) => r.runId === run1.runId), 'the quiet run is listed as active');
  const run2 = await second.getWorkflow('counted').createRun({ runId: run1.runId });
  const restarted = await run2.restart();
  await settle();

  assert.equal(restarted.status, 'success');
  assert.equal(ledger.effects, 2, 'the side effect ran twice: recovery is at-least-once');
  assert.equal(firstExecutionEnded, false, 'and the first execution was never stopped or fenced');
});
