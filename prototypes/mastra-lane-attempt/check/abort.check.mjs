/**
 * E4. The coordinator orders an abort while the run waits for a person. Gaia decides ABORTED from
 * its own order, not from anything the executor says, and the canceled Mastra run cannot be
 * completed by a resume that comes afterwards.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { replayLaneAttempt } from '../../../src/lane-attempt.mjs';
import { createAttemptObserver, observeStream } from '../src/attempt-observer.mjs';
import { approval, coordinatorClock, gaiaAttempt, mastraWith } from './fixtures.mjs';

const START = '2026-10-13T11:00:00.000Z';

test('E4: a coordinator abort decides ABORTED, and the canceled run refuses a later resume', async () => {
  const mastra = mastraWith({ approval: approval() });
  const run = await mastra.getWorkflow('approval').createRun();
  const observer = createAttemptObserver(['prepare', 'gate', 'publish']);
  const clock = coordinatorClock(START);
  const attempt = gaiaAttempt({ startedAt: clock(), heartbeatTimeoutMs: 60_000 });

  await observeStream(run.stream({ inputData: { n: 1 } }), observer, clock);
  const orderedAt = clock();
  observer.abort(orderedAt);
  await run.cancel();

  const decision = replayLaneAttempt({ attempt, events: observer.events(), now: clock.peek() });
  assert.equal(decision.decision, 'ABORTED');
  assert.equal(decision.decisiveAt, orderedAt);
  assert.equal(decision.compensation.report, 'SEND_LANE_ABORTED');

  const stored = await mastra.getWorkflow('approval').getWorkflowRunById(run.runId);
  assert.equal(stored.status, 'canceled');
  await assert.rejects(run.resume({ step: 'gate', resumeData: { approved: true } }),
    /This workflow run was not suspended/, 'a resume after the cancel is refused');
  assert.equal((await mastra.getWorkflow('approval').getWorkflowRunById(run.runId)).status, 'canceled');
});
