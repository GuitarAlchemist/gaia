/**
 * E2. A Mastra suspension waiting for a person reads as silence to Gaia. Gaia's attempt has no
 * "waiting for a person" state, so the heartbeat timeout ends the attempt. Mastra still accepts
 * the person's resume afterwards: its resume carries no deadline and no reference to Gaia's
 * decision, and the late result is quarantined by Gaia, not by Mastra.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { replayLaneAttempt } from '../../../src/lane-attempt.mjs';
import { createAttemptObserver, observeStream } from '../src/attempt-observer.mjs';
import { approval, coordinatorClock, gaiaAttempt, mastraWith } from './fixtures.mjs';

const START = '2026-10-13T09:00:00.000Z';

test('E2: a suspended Mastra run times out as a Gaia attempt, and its late resume is quarantined', async () => {
  const mastra = mastraWith({ approval: approval() });
  const run = await mastra.getWorkflow('approval').createRun();
  const observer = createAttemptObserver(['prepare', 'gate', 'publish']);
  const clock = coordinatorClock(START);
  const attempt = gaiaAttempt({ startedAt: clock(), deadlineMs: 3_600_000, heartbeatTimeoutMs: 60_000 });

  const paused = await observeStream(run.stream({ inputData: { n: 1 } }), observer, clock);
  assert.equal(paused.status, 'suspended');
  assert.deepEqual(observer.claims().suspended, ['gate']);
  assert.deepEqual(observer.events().map((e) => e.step ?? e.kind), ['L1', 'L1', 'L2'],
    'the gate started, and its suspension added nothing: the run went quiet');
  const lastHeartbeat = observer.events().at(-1);

  // The person takes ten minutes to answer.
  clock.advance(600_000);
  const meanwhile = replayLaneAttempt({ attempt, events: observer.events(), now: clock.peek() });
  assert.equal(meanwhile.decision, 'HEARTBEAT_TIMEOUT');
  assert.equal(meanwhile.decisiveAt, new Date(Date.parse(lastHeartbeat.at) + 60_000).toISOString());
  assert.deepEqual(meanwhile.compensation.undo, ['STOP_ATTEMPT_PROCESS', 'RELEASE_LANE_SLOT', 'DISCARD_UNVERIFIED_OUTPUT']);
  assert.equal(meanwhile.compensation.report, 'ESCALATE_TO_COORDINATOR');

  // Mastra accepts the resume regardless: nothing in it names Gaia's decision or a deadline.
  const finished = await observeStream(run.resumeStream({ step: 'gate', resumeData: { approved: true } }), observer, clock);
  assert.equal(finished.status, 'success', 'Mastra completes the run');
  assert.deepEqual(finished.result, { n: 1002 });

  const after = replayLaneAttempt({ attempt, events: observer.events(), now: clock.peek() });
  assert.equal(after.decision, 'HEARTBEAT_TIMEOUT', 'the first terminal decision stands');
  assert.equal(after.decisiveAt, meanwhile.decisiveAt);
  assert.equal(after.compensation.lateMarkerAt, observer.events().at(-1).at);
  assert.deepEqual(after.compensation.undo, ['STOP_ATTEMPT_PROCESS', 'RELEASE_LANE_SLOT', 'QUARANTINE_LATE_OUTPUT']);
});

test('E2 control: the same answer inside the heartbeat timeout completes the attempt', async () => {
  const mastra = mastraWith({ approval: approval() });
  const run = await mastra.getWorkflow('approval').createRun();
  const observer = createAttemptObserver(['prepare', 'gate', 'publish']);
  const clock = coordinatorClock(START);
  const attempt = gaiaAttempt({ startedAt: clock(), deadlineMs: 3_600_000, heartbeatTimeoutMs: 60_000 });

  await observeStream(run.stream({ inputData: { n: 1 } }), observer, clock);
  clock.advance(30_000);
  await observeStream(run.resumeStream({ step: 'gate', resumeData: { approved: true } }), observer, clock);
  assert.equal(replayLaneAttempt({ attempt, events: observer.events(), now: clock.peek() }).decision, 'COMPLETE');
});

test('E2 authority: any caller holding the run id can resume it; Mastra checks the payload shape only', async () => {
  const mastra = mastraWith({ approval: approval() });
  const run = await mastra.getWorkflow('approval').createRun();
  await run.start({ inputData: { n: 1 } });
  // A second handle, built from nothing but the run id, as an HTTP handler or another process would.
  const stranger = await mastra.getWorkflow('approval').createRun({ runId: run.runId });
  await assert.rejects(stranger.resume({ step: 'gate', resumeData: { approved: 'yes' } }),
    /resume data/i, 'the resume schema is checked');
  const result = await stranger.resume({ step: 'gate', resumeData: { approved: true } });
  assert.equal(result.status, 'success', 'and it is the only check: no grant, intent digest or expiry is asked for');
});
