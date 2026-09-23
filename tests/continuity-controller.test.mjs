import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createContinuityController } from '../src/continuity-controller.mjs';
import { openContinuityStore } from '../src/continuity-store.mjs';

const D = character => character.repeat(64);
const WORK = D('1');
const COMMITMENT = D('2');
const REVIEW = D('3');
const CAP_0 = D('4');
const CAP_1 = D('5');
const OUTPUT = { mediaType: 'application/json', sha256: D('6'), bytes: 128 };
const EPOCH = D('a');
const CURSOR = Object.freeze({
  schema: 'gaia.bus-evidence-cursor/1',
  instanceId: '00000000-0000-4000-8000-000000000001',
  recordCount: 2,
  byteOffset: 200,
  finalEventIdentity: D('7'),
  prefixSha256: D('8'),
});
const POST_CURSOR = Object.freeze({ ...CURSOR, recordCount: 3, byteOffset: 300,
  finalEventIdentity: D('9'), prefixSha256: D('b') });
const FIXTURE_WAKE_PORT = Object.freeze({
  captureCheckpoint: () => CURSOR,
  commitAndReconcile: ({ checkpoint, command }) => {
    assert.deepEqual(checkpoint, CURSOR);
    assert.equal(command.kind, 'continuity-wake');
    return { status: 'APPENDED', record: { fixture: 'wake-record' }, cursor: POST_CURSOR };
  },
});

function setup(t, times = [
  '2026-09-20T00:00:00.000Z', '2026-09-20T00:01:00.000Z',
  '2026-09-20T00:02:00.000Z', '2026-09-20T00:03:00.000Z',
  '2026-09-20T00:04:00.000Z', '2026-09-20T00:05:00.000Z',
]) {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-continuity-'));
  const path = join(dir, 'continuity.sqlite');
  let cursor = 0;
  const controllers = [];
  const open = (overrides = {}) => {
    const { wakeEvidencePort = FIXTURE_WAKE_PORT, ...storeOverrides } = overrides;
    const store = openContinuityStore({
      path,
      clockEpoch: EPOCH,
      clock: () => times[Math.min(cursor++, times.length - 1)],
      ...storeOverrides,
    });
    const controller = createContinuityController({ store, wakeEvidencePort });
    controllers.push(controller);
    return controller;
  };
  t.after(() => {
    for (const controller of controllers) controller.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, path, open };
}

const acceptance = (overrides = {}) => ({
  operationId: 'accept-generation-0', expectedRevision: 0,
  workIdentity: WORK, workGeneration: 0, successorSlot: 'review-successor',
  actorRef: 'act-0002', sessionRef: 'session-generation-0', sessionGeneration: 0,
  capabilityDigest: CAP_0, commitmentDigest: COMMITMENT, incomingReviewDigest: REVIEW,
  ...overrides,
});
const replacement = (overrides = {}) => ({
  operationId: 'replace-generation-0', expectedRevision: 1, sessionGeneration: 0,
  actorRef: 'act-0002', sessionRef: 'session-generation-0', capabilityDigest: CAP_0,
  replacement: { actorRef: 'act-0003', sessionRef: 'session-generation-1',
    sessionGeneration: 1, capabilityDigest: CAP_1 },
  ...overrides,
});
const decision = (overrides = {}) => ({
  operationId: 'decide-generation-1', expectedRevision: 5, sessionGeneration: 1,
  actorRef: 'act-0003', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
  decision: 'ACCEPTED_FOR_NEXT_STAGE', incomingReviewDigest: REVIEW,
  outputArtifact: OUTPUT,
  ...overrides,
});
const consumption = (overrides = {}) => ({
  operationId: 'consume-decision', expectedRevision: 6, sessionGeneration: 1,
  actorRef: 'act-0003', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
  consumerIdentity: 'demerzel-contract-consumer', ordinal: 0,
  ...overrides,
});

function completeFixtureWake(controller) {
  return controller.deliverWake({
    intentOperationId: 'wake-intent', checkpointOperationId: 'wake-checkpoint',
    deliveredOperationId: 'wake-delivered', expectedRevision: 2, sessionGeneration: 1,
    actorRef: 'act-0003', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
    senderActorRef: 'act-0001',
  });
}

test('the bounded lifecycle survives restart and emits the exact neutral receipt shape', t => {
  const { open } = setup(t);
  const first = open();
  const accepted = first.acceptGeneration0(acceptance());
  assert.equal(accepted.revision, 1);
  assert.equal(accepted.state.status, 'ACTIVE');
  first.close();

  const restarted = open();
  assert.equal(restarted.replaceGeneration0(replacement()).revision, 2);
  completeFixtureWake(restarted);
  const decided = restarted.commitDecision(decision());
  assert.equal(decided.state.status, 'DECIDED');
  const consumed = restarted.consumeDecision(consumption());
  assert.equal(consumed.state.status, 'CONSUMED');

  const receipt = restarted.exportPortableReceipt();
  assert.deepEqual(Object.keys(receipt), [
    'schema', 'workIdentity', 'workGeneration', 'successorSlot', 'successor',
    'commitmentDigest', 'incomingReviewDigest', 'decisionDigest', 'decision',
    'outputArtifact', 'consumptionDigest', 'consumption', 'authority', 'receiptDigest',
  ]);
  assert.deepEqual(receipt.authority, { effects: [] });
  assert.equal(receipt.successor.sessionGeneration, 1);
  assert.equal(receipt.consumption.ordinal, 0);
  assert.match(receipt.receiptDigest, /^[a-f0-9]{64}$/u);
});

test('an exact retry is byte-identical before stale fencing and conflicting reuse refuses', t => {
  const { open } = setup(t);
  const controller = open();
  const command = acceptance();
  const first = controller.acceptGeneration0Bytes(command);
  controller.close(); // Simulate a committed response being lost with the controller process.
  const restarted = open();
  restarted.replaceGeneration0(replacement());
  const retry = restarted.acceptGeneration0Bytes(command);
  assert.equal(retry, first, 'an exact retry beats the now-stale revision and session');
  assert.throws(() => restarted.acceptGeneration0Bytes({ ...command, sessionRef: 'other-session' }),
    error => error.code === 'OPERATION_CONFLICT');
});

test('generation zero is permanently fenced after replacement', t => {
  const { open } = setup(t);
  const controller = open();
  controller.acceptGeneration0(acceptance());
  controller.replaceGeneration0(replacement());
  assert.throws(() => controller.commitDecision(decision({
    operationId: 'stale-generation-zero', expectedRevision: 2, sessionGeneration: 0,
    actorRef: 'act-0002', sessionRef: 'session-generation-0', capabilityDigest: CAP_0,
  })), error => error.code === 'STALE_SESSION_GENERATION');
  assert.equal(controller.inspect({ operationId: 'inspect-after-stale', workIdentity: WORK })
    .state.session.sessionGeneration, 1);
});

test('generation-zero completion cannot win against the required replacement', t => {
  const { open } = setup(t);
  const controller = open();
  controller.acceptGeneration0(acceptance());
  assert.throws(() => controller.commitDecision(decision({
    operationId: 'generation-zero-completion', expectedRevision: 1, sessionGeneration: 0,
    actorRef: 'act-0002', sessionRef: 'session-generation-0', capabilityDigest: CAP_0,
  })), error => error.code === 'REPLACEMENT_REQUIRED');
  assert.equal(controller.status().revision, 1, 'the refused completion spent no revision');
  assert.equal(controller.replaceGeneration0(replacement()).revision, 2,
    'replacement still wins the one logical slot');
});

test('cancel and decision contend on one revision and exactly one terminal fact wins', t => {
  const { open } = setup(t);
  const controller = open();
  controller.acceptGeneration0(acceptance());
  controller.replaceGeneration0(replacement());
  const cancelled = controller.cancel({
    operationId: 'cancel-first', expectedRevision: 2, sessionGeneration: 1,
    actorRef: 'act-0003', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
  });
  assert.equal(cancelled.state.status, 'CANCELLED');
  assert.throws(() => controller.commitDecision(decision()), error => error.code === 'STALE_REVISION');
  assert.throws(() => controller.exportPortableReceipt(), error => error.code === 'NOT_CONSUMED');
});

test('decision before cancellation yields the typed committed-decision refusal', t => {
  const { open } = setup(t);
  const controller = open();
  controller.acceptGeneration0(acceptance());
  controller.replaceGeneration0(replacement());
  completeFixtureWake(controller);
  controller.commitDecision(decision());
  assert.throws(() => controller.cancel({
    operationId: 'cancel-after-decision', expectedRevision: 6, sessionGeneration: 1,
    actorRef: 'act-0003', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
  }), error => error.code === 'DECISION_ALREADY_COMMITTED');
});

test('cancellation refuses while durable wake delivery is checkpointed', t => {
  const { open } = setup(t);
  let sendAttempts = 0;
  const controller = open({ wakeEvidencePort: {
    captureCheckpoint: () => CURSOR,
    commitAndReconcile: () => {
      sendAttempts += 1;
      const error = new Error('simulated lost send response');
      error.code = 'SIMULATED_RESPONSE_LOSS';
      throw error;
    },
  } });
  controller.acceptGeneration0(acceptance());
  controller.replaceGeneration0(replacement());
  assert.throws(() => completeFixtureWake(controller), /simulated lost send response/u);
  assert.equal(sendAttempts, 1);
  assert.equal(controller.status().wake.status, 'CHECKPOINTED');
  assert.throws(() => controller.cancel({
    operationId: 'cancel-checkpointed', expectedRevision: 4, sessionGeneration: 1,
    actorRef: 'act-0003', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
  }), error => error.code === 'WAKE_DELIVERY_IN_PROGRESS');
  assert.equal(controller.status().status, 'ACTIVE');
});

test('raw cursor transitions are private and fabricated port evidence cannot deliver a wake', t => {
  const { open } = setup(t);
  const controller = open({ wakeEvidencePort: {
    captureCheckpoint: () => CURSOR,
    commitAndReconcile: () => ({
      status: 'APPENDED', record: { fabricated: true },
      cursor: { ...POST_CURSOR, instanceId: 'not-a-bus-instance' },
    }),
  } });
  assert.equal(controller.checkpointWakeCursor, undefined);
  assert.equal(controller.commitWakeDelivered, undefined);
  controller.acceptGeneration0(acceptance());
  controller.replaceGeneration0(replacement());
  assert.throws(() => completeFixtureWake(controller), error => error.code === 'INVALID_BUS_EVIDENCE');
  assert.equal(controller.status().wake.status, 'CHECKPOINTED');
  assert.throws(() => controller.commitDecision(decision({ expectedRevision: 4 })),
    error => error.code === 'WAKE_REQUIRED');
});

test('consumption is separate, exact replay converges, and a second consumer is fenced', t => {
  const { open } = setup(t);
  const controller = open();
  controller.acceptGeneration0(acceptance());
  controller.replaceGeneration0(replacement());
  completeFixtureWake(controller);
  controller.commitDecision(decision());
  const first = controller.consumeDecision(consumption());
  assert.deepEqual(controller.consumeDecision(consumption()), first);
  assert.throws(() => controller.consumeDecision(consumption({
    operationId: 'second-consumer', expectedRevision: 7, consumerIdentity: 'other-consumer',
  })), error => error.code === 'ALREADY_CONSUMED');
  assert.throws(() => controller.cancel({
    operationId: 'cancel-consumed', expectedRevision: 7, sessionGeneration: 1,
    actorRef: 'act-0003', sessionRef: 'session-generation-1', capabilityDigest: CAP_1,
  }), error => error.code === 'ALREADY_CONSUMED');
});

test('unknown fields refuse before write', t => {
  const { open } = setup(t);
  const controller = open();
  assert.throws(() => controller.acceptGeneration0(acceptance({ surprise: true })),
    error => error.code === 'INVALID_REQUEST');
  assert.equal(controller.status(), null);
});

test('inspection advances durable time without changing continuity revision and replays exactly', t => {
  const times = ['2026-09-20T00:00:00.000Z', '2026-09-20T00:31:00.000Z'];
  const { open } = setup(t, times);
  const controller = open();
  controller.acceptGeneration0(acceptance());
  const first = controller.inspectBytes({ operationId: 'inspect-at-risk', workIdentity: WORK });
  assert.equal(JSON.parse(first).phase, 'AT_RISK');
  assert.equal(JSON.parse(first).revision, 1);
  assert.equal(controller.inspectBytes({ operationId: 'inspect-at-risk', workIdentity: WORK }), first);
  assert.equal(controller.status().revision, 1);
});

test('inspection phases change at exact bounds and STALLED cannot regress after restart', t => {
  const times = [
    '2026-09-20T00:00:00.000Z',
    '2026-09-20T00:29:59.999Z',
    '2026-09-20T00:30:00.000Z',
    '2026-09-20T01:59:59.999Z',
    '2026-09-20T02:00:00.000Z',
  ];
  const { open } = setup(t, times);
  const controller = open();
  controller.acceptGeneration0(acceptance());
  const inspect = (operationId) => controller.inspect({ operationId, workIdentity: WORK }).phase;
  assert.equal(inspect('inspect-before-risk'), 'ADVANCING');
  assert.equal(inspect('inspect-at-risk-boundary'), 'AT_RISK');
  assert.equal(inspect('inspect-before-stalled'), 'AT_RISK');
  assert.equal(inspect('inspect-at-stalled-boundary'), 'STALLED');
  controller.close();

  const restarted = open({ clock: () => '2026-09-20T00:10:00.000Z' });
  const afterBackwardClock = restarted.inspect({
    operationId: 'inspect-after-backward-restart', workIdentity: WORK,
  });
  assert.equal(afterBackwardClock.phase, 'STALLED');
  assert.equal(afterBackwardClock.timeReceipt.candidateUtc, '2026-09-20T02:00:00.000Z');
});

test('inspection traffic cannot exhaust lifecycle operation capacity', t => {
  const { open } = setup(t);
  const controller = open({ clock: () => '2026-09-20T00:00:00.000Z' });
  for (let index = 0; index < 12; index += 1) {
    assert.equal(controller.inspect({
      operationId: `inspect-missing-${index}`, workIdentity: D('9'),
    }).status, 'NOT_FOUND');
  }
  assert.equal(controller.acceptGeneration0(acceptance()).revision, 1);
  for (let index = 0; index < 12; index += 1) {
    assert.equal(controller.inspect({
      operationId: `inspect-active-${index}`, workIdentity: WORK,
    }).status, 'FOUND');
  }
  assert.equal(controller.replaceGeneration0(replacement()).revision, 2);
});

test('inspection replay evidence is retained until its independent bound refuses new work', t => {
  const { open } = setup(t);
  const controller = open({ clock: () => '2026-09-20T00:00:00.000Z' });
  const original = { operationId: 'inspect-original', workIdentity: D('9') };
  const first = controller.inspectBytes(original);
  for (let index = 0; index < 31; index += 1) {
    controller.inspect({ operationId: `inspect-retained-${index}`, workIdentity: D('9') });
  }
  assert.equal(controller.inspectBytes(original), first);
  assert.throws(() => controller.inspect({
    operationId: 'inspect-over-independent-bound', workIdentity: D('9'),
  }), error => error.code === 'BOUND_EXCEEDED');
  assert.equal(controller.acceptGeneration0(acceptance()).revision, 1,
    'the independent inspection bound cannot consume lifecycle capacity');
});

test('unknown work inspection is typed and does not synthesize continuity state', t => {
  const { open } = setup(t);
  const controller = open();
  const result = controller.inspect({ operationId: 'inspect-missing', workIdentity: D('9') });
  assert.equal(result.status, 'NOT_FOUND');
  assert.equal(controller.status(), null);
});
