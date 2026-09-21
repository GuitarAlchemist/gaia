import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { commit, replay } from '../src/bus-core.mjs';
import {
  createContinuityBusAdapter,
  createWakeEvidencePort,
} from '../src/bus-evidence-port.mjs';
import { createContinuityController } from '../src/continuity-controller.mjs';
import { openContinuityStore } from '../src/continuity-store.mjs';
import { commitEvents, readEventsConsistent } from '../src/event-log.mjs';

const D = character => character.repeat(64);
const WORK = D('1');
const COMMITMENT = D('2');
const REVIEW = D('3');
const CAP_0 = D('4');
const CAP_1 = D('5');

function commitBus(command) {
  return commitEvents(events => {
    const outcome = commit(replay(events), command);
    assert.equal(outcome.error, null);
    return { events: outcome.events, value: outcome.result };
  });
}

function setup(t, { wrapPort = port => port } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gaia-continuity-wake-'));
  const busDir = join(root, 'bus');
  mkdirSync(busDir, { recursive: true });
  process.env.GAIA_INTERAGENT_DATA_DIR = busDir;
  commitBus({ type: 'register', at: '2026-09-20T00:00:00.000Z', actorId: 'controller' });
  commitBus({ type: 'register', at: '2026-09-20T00:00:01.000Z', actorId: 'successor' });

  const store = openContinuityStore({
    path: join(root, 'continuity.sqlite'),
    clockEpoch: D('a'),
    clock: (() => {
      const values = [
        '2026-09-20T00:01:00.000Z', '2026-09-20T00:02:00.000Z',
        '2026-09-20T00:03:00.000Z', '2026-09-20T00:04:00.000Z',
        '2026-09-20T00:05:00.000Z', '2026-09-20T00:06:00.000Z',
      ];
      let index = 0;
      return () => values[index++];
    })(),
  });
  const controller = createContinuityController({ store, wakeEvidencePort: wrapPort(createWakeEvidencePort()) });
  t.after(() => {
    controller.close();
    rmSync(root, { recursive: true, force: true });
  });
  return controller;
}

function acceptAndReplace(controller) {
  controller.acceptGeneration0({
    operationId: 'accept-generation-0', expectedRevision: 0,
    workIdentity: WORK, workGeneration: 0, successorSlot: 'review-successor',
    actorRef: 'act-0002', sessionRef: 'session-generation-0', sessionGeneration: 0,
    capabilityDigest: CAP_0, commitmentDigest: COMMITMENT, incomingReviewDigest: REVIEW,
  });
  controller.replaceGeneration0({
    operationId: 'replace-generation-0', expectedRevision: 1, sessionGeneration: 0,
    actorRef: 'act-0002', sessionRef: 'session-generation-0', capabilityDigest: CAP_0,
    replacement: { actorRef: 'act-0002', sessionRef: 'session-generation-1',
      sessionGeneration: 1, capabilityDigest: CAP_1 },
  });
}

const wakeInput = {
  intentOperationId: 'wake-intent', checkpointOperationId: 'wake-checkpoint',
  deliveredOperationId: 'wake-delivered', expectedRevision: 2,
  sessionGeneration: 1, actorRef: 'act-0002', sessionRef: 'session-generation-1',
  capabilityDigest: CAP_1, senderActorRef: 'act-0001',
};

test('wake intent, cursor checkpoint, idempotent send, and reconciliation form one durable path', t => {
  const controller = setup(t);
  acceptAndReplace(controller);
  const adapter = createContinuityBusAdapter({ controller });

  const first = adapter.deliver(wakeInput);
  const retry = adapter.deliver(wakeInput);
  const sent = readEventsConsistent().filter(event => event.type === 'message.sent');

  assert.equal(first.state.wake.status, 'DELIVERED');
  assert.deepEqual(retry.state, first.state);
  assert.equal(retry.replayed, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].message.correlationId, first.state.wake.command.correlationId);
  assert.deepEqual(sent[0].message.authority.granted, []);
  assert.deepEqual(sent[0].message.authority.denied, []);
  assert.equal(sent[0].message.authority.effect, 'none');
  assert.throws(() => adapter.deliver({ ...wakeInput, senderActorRef: 'act-0002' }),
    error => error.code === 'OPERATION_CONFLICT');
});

test('a lost send response reconciles the existing post-checkpoint record without duplication', t => {
  let loseResponse = true;
  const controller = setup(t, { wrapPort: port => ({
    captureCheckpoint: () => port.captureCheckpoint(),
    commitAndReconcile(input) {
      const evidence = port.commitAndReconcile(input);
      if (loseResponse) {
        loseResponse = false;
        throw new Error('simulated response loss after durable bus commit');
      }
      return evidence;
    },
  }) });
  acceptAndReplace(controller);
  const adapter = createContinuityBusAdapter({ controller });

  assert.throws(() => adapter.deliver(wakeInput), /simulated response loss/);
  const recovered = adapter.deliver(wakeInput);
  const sent = readEventsConsistent().filter(event => event.type === 'message.sent');

  assert.equal(recovered.state.wake.status, 'DELIVERED');
  assert.equal(sent.length, 1);
});

test('checkpointed wake cannot be cancelled before an exact send retry', t => {
  let refuseSend = true;
  const controller = setup(t, { wrapPort: port => ({
    captureCheckpoint: () => port.captureCheckpoint(),
    commitAndReconcile(input) {
      if (refuseSend) {
        refuseSend = false;
        throw new Error('simulated pre-send stop');
      }
      return port.commitAndReconcile(input);
    },
  }) });
  acceptAndReplace(controller);
  const adapter = createContinuityBusAdapter({ controller });

  assert.throws(() => adapter.deliver(wakeInput), /simulated pre-send stop/);
  const checkpointed = controller.status();
  assert.equal(checkpointed.wake.status, 'CHECKPOINTED');
  assert.throws(() => controller.cancel({
    operationId: 'cancel-checkpointed', expectedRevision: checkpointed.revision,
    sessionGeneration: 1, actorRef: 'act-0002', sessionRef: 'session-generation-1',
    capabilityDigest: CAP_1,
  }), error => error.code === 'WAKE_DELIVERY_IN_PROGRESS');

  const delivered = adapter.deliver(wakeInput);
  assert.equal(delivered.state.wake.status, 'DELIVERED');
  assert.equal(readEventsConsistent().filter(event => event.type === 'message.sent').length, 1);
});

test('raw caller-supplied cursor transitions are not part of the controller API', t => {
  const controller = setup(t);
  assert.equal(controller.checkpointWakeCursor, undefined);
  assert.equal(controller.commitWakeDelivered, undefined);
});

test('a decision is fenced until the exact wake has been reconciled', t => {
  const controller = setup(t);
  acceptAndReplace(controller);
  assert.throws(() => controller.commitDecision({
    operationId: 'decision-before-wake', expectedRevision: 2, sessionGeneration: 1,
    actorRef: 'act-0002', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
    decision: 'ACCEPTED_FOR_NEXT_STAGE', incomingReviewDigest: REVIEW,
    outputArtifact: { mediaType: 'application/json', sha256: D('6'), bytes: 128 },
  }), error => error.code === 'WAKE_REQUIRED');
});

test('a delivered operation-id collision refuses before wake state or bus effect', t => {
  const controller = setup(t);
  acceptAndReplace(controller);
  const adapter = createContinuityBusAdapter({ controller });
  const colliding = { ...wakeInput, deliveredOperationId: 'accept-generation-0' };

  assert.throws(() => adapter.deliver(colliding), error => error.code === 'OPERATION_CONFLICT');
  assert.equal(controller.status().wake, undefined);
  assert.equal(readEventsConsistent().filter(event => event.type === 'message.sent').length, 0);

  const corrected = adapter.deliver({ ...colliding, deliveredOperationId: 'wake-delivered-fixed' });
  const retry = adapter.deliver({ ...colliding, deliveredOperationId: 'wake-delivered-fixed' });
  assert.equal(corrected.state.wake.status, 'DELIVERED');
  assert.deepEqual(retry, { state: corrected.state, replayed: true });
  assert.equal(readEventsConsistent().filter(event => event.type === 'message.sent').length, 1);
});

test('a checkpoint operation-id collision refuses atomically and a corrected retry succeeds', t => {
  const controller = setup(t);
  acceptAndReplace(controller);
  const adapter = createContinuityBusAdapter({ controller });
  const colliding = { ...wakeInput, checkpointOperationId: 'accept-generation-0' };

  assert.throws(() => adapter.deliver(colliding), error => error.code === 'OPERATION_CONFLICT');
  assert.equal(controller.status().revision, 2);
  assert.equal(controller.status().wake, undefined);
  assert.equal(readEventsConsistent().filter(event => event.type === 'message.sent').length, 0);

  const correctedInput = { ...colliding, checkpointOperationId: 'wake-checkpoint-fixed' };
  const corrected = adapter.deliver(correctedInput);
  const retry = adapter.deliver(correctedInput);
  assert.equal(corrected.state.wake.status, 'DELIVERED');
  assert.deepEqual(retry, { state: corrected.state, replayed: true });
  assert.equal(readEventsConsistent().filter(event => event.type === 'message.sent').length, 1);
});

test('exact wake retry returns its original response after a later decision', t => {
  const controller = setup(t);
  acceptAndReplace(controller);
  const adapter = createContinuityBusAdapter({ controller });
  const delivered = adapter.deliver(wakeInput);
  controller.commitDecision({
    operationId: 'decision-after-wake', expectedRevision: 5, sessionGeneration: 1,
    actorRef: 'act-0002', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
    decision: 'ACCEPTED_FOR_NEXT_STAGE', incomingReviewDigest: REVIEW,
    outputArtifact: { mediaType: 'application/json', sha256: D('6'), bytes: 128 },
  });

  const replayed = adapter.deliver(wakeInput);
  assert.deepEqual(replayed, { state: delivered.state, replayed: true });
  assert.equal(replayed.state.revision, 5);
  assert.equal(replayed.state.status, 'ACTIVE');
  assert.equal(controller.status().revision, 6);
  assert.equal(controller.status().status, 'DECIDED');
});

test('composed delivery rejects non-advancing port evidence without committing delivery', t => {
  const controller = setup(t, { wrapPort: port => ({
    captureCheckpoint: () => port.captureCheckpoint(),
    commitAndReconcile({ checkpoint }) {
      return { status: 'EXISTING', record: { type: 'message.sent', message: {} },
        cursor: checkpoint };
    },
  }) });
  acceptAndReplace(controller);
  const adapter = createContinuityBusAdapter({ controller });

  assert.throws(() => adapter.deliver(wakeInput), error => error.code === 'INVALID_BUS_EVIDENCE');
  assert.equal(controller.status().wake.status, 'CHECKPOINTED');
  assert.equal(controller.status().revision, 4);
});
