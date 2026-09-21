import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  fsyncSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { commit, replay } from '../src/bus-core.mjs';
import {
  appendEvents,
  commitEvents,
  flushFileAndPublication,
  logPath,
  migrateLegacyBusInstance,
  readBusInstanceMetadata,
  readEvents,
  withLock,
} from '../src/event-log.mjs';
import {
  BusEvidenceError,
  busMetadataPath,
  captureBusCursor,
  commitAndReconcileFromCursor,
  commitSendIfAbsent,
  reconcileSendFromCursor,
  validateBusCursor,
} from '../src/bus-evidence-port.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'gaia-bus-evidence-test-'));
let counter = 0;

function freshDir(name) {
  const dir = join(ROOT, `${name}-${counter += 1}`);
  mkdirSync(dir, { recursive: true });
  process.env.GAIA_INTERAGENT_DATA_DIR = dir;
  return dir;
}

function commitCommand(command) {
  return commitEvents((events) => {
    const outcome = commit(replay(events), command);
    assert.equal(outcome.error, null);
    return { events: outcome.events, value: outcome.result };
  });
}

function seedActors(name) {
  freshDir(name);
  commitCommand({ type: 'register', at: '2026-09-20T12:00:00.000Z', actorId: 'sender' });
  commitCommand({ type: 'register', at: '2026-09-20T12:00:01.000Z', actorId: 'recipient' });
}

function sendCommand(overrides = {}) {
  return {
    type: 'send',
    at: '2026-09-20T12:00:02.000Z',
    from: 'act-0001',
    to: 'act-0002',
    text: 'wake work-76 successor slot 0',
    kind: 'continuity-wake',
    correlationId: 'continuity-work-76-slot-0',
    expectsReply: false,
    requestedAuthority: [],
    ...overrides,
  };
}

function throwsCode(fn, code) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BusEvidenceError, `expected BusEvidenceError, got ${error.name}: ${error.message}`);
    assert.equal(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('cursor is stable across restart-shaped recapture and names the exact durable prefix', () => {
  seedActors('restart');

  const first = captureBusCursor();
  const second = captureBusCursor();

  assert.deepEqual(second, first);
  assert.match(first.instanceId, /^[0-9a-f-]{36}$/);
  assert.equal(first.recordCount, 2);
  assert.equal(first.byteOffset, readFileSync(logPath()).byteLength);
  assert.match(first.finalEventIdentity, /^[0-9a-f]{64}$/);
  assert.match(first.prefixSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(validateBusCursor(first).checkpoint, first);
});

test('an append advances the current cursor while the prior prefix still validates', () => {
  seedActors('append');
  const before = captureBusCursor();
  commitCommand({ type: 'heartbeat', at: '2026-09-20T12:00:02.000Z', actorId: 'act-0001' });

  const validated = validateBusCursor(before);
  assert.deepEqual(validated.checkpoint, before);
  assert.equal(validated.current.instanceId, before.instanceId);
  assert.equal(validated.current.recordCount, before.recordCount + 1);
  assert.ok(validated.current.byteOffset > before.byteOffset);
  assert.notEqual(validated.current.prefixSha256, before.prefixSha256);
});

test('lost send response exact retry converges on one durable message record', () => {
  seedActors('retry');
  const command = sendCommand();

  const first = commitSendIfAbsent(command);
  const second = commitSendIfAbsent(command);
  const messages = readEvents().filter((event) => event.type === 'message.sent');

  assert.equal(first.status, 'APPENDED');
  assert.equal(second.status, 'EXISTING');
  assert.deepEqual(second.record, first.record);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].message.correlationId, command.correlationId);
  assert.deepEqual(validateBusCursor(first.cursor).checkpoint, first.cursor);
});

test('the same correlation with different send semantics refuses without append', () => {
  seedActors('conflict');
  commitSendIfAbsent(sendCommand());
  const before = readFileSync(logPath());

  throwsCode(
    () => commitSendIfAbsent(sendCommand({ text: 'different wake payload' })),
    'BUS_CORRELATION_CONFLICT',
  );
  assert.deepEqual(readFileSync(logPath()), before);
});

test('correlation conflict is classified before a changed command can reach send validation', () => {
  seedActors('conflict-before-validation');
  commitSendIfAbsent(sendCommand());

  throwsCode(
    () => commitSendIfAbsent(sendCommand({ from: 'unknown-actor', text: 'different wake payload' })),
    'BUS_CORRELATION_CONFLICT',
  );
});

test('multiple durable records for one correlation refuse as duplicate evidence', () => {
  seedActors('duplicate');
  const first = commitSendIfAbsent(sendCommand());
  const duplicate = structuredClone(first.record);
  duplicate.message.messageId = 'msg-9999';
  withLock(() => appendEvents([duplicate]));

  throwsCode(() => commitSendIfAbsent(sendCommand({ from: 'unknown-actor' })), 'BUS_DUPLICATE_SEND');
});

test('equal-length prefix rewrite is detected even when record count and offset are unchanged', () => {
  seedActors('rewrite');
  const checkpoint = captureBusCursor();
  const original = readFileSync(logPath(), 'utf8');
  const rewritten = original.replace('sender', 'xender');
  assert.equal(Buffer.byteLength(rewritten), Buffer.byteLength(original));
  writeFileSync(logPath(), rewritten, 'utf8');

  throwsCode(() => validateBusCursor(checkpoint), 'BUS_PREFIX_MISMATCH');
});

test('rewritten checkpoint prefix followed by a valid append is still detected', () => {
  seedActors('rewrite-append');
  const checkpoint = captureBusCursor();
  const original = readFileSync(logPath(), 'utf8');
  writeFileSync(logPath(), original.replace('sender', 'xender'), 'utf8');
  withLock(() => appendEvents([{ type: 'actor.heartbeat', at: '2026-09-20T12:01:00.000Z', actorId: 'act-0001', note: null }]));

  throwsCode(() => validateBusCursor(checkpoint), 'BUS_PREFIX_MISMATCH');
});

test('truncation below a checkpoint offset fails closed and preserves the remaining bytes', () => {
  seedActors('truncate');
  const checkpoint = captureBusCursor();
  const original = readFileSync(logPath());
  const truncated = original.subarray(0, original.length - 7);
  writeFileSync(logPath(), truncated);

  throwsCode(() => validateBusCursor(checkpoint), 'BUS_LOG_TRUNCATED');
  assert.deepEqual(readFileSync(logPath()), truncated);
});

test('missing sidecar beside a nonempty log fails closed and is never regenerated', () => {
  seedActors('sidecar-loss');
  const checkpoint = captureBusCursor();
  unlinkSync(busMetadataPath());

  throwsCode(() => validateBusCursor(checkpoint), 'BUS_INSTANCE_MISSING');
  assert.equal(readFileSync(logPath()).byteLength > 0, true);
  assert.equal(readFileSync(logPath(), 'utf8').includes('actor.registered'), true);
});

test('sidecar replacement is detected against the checkpoint instance identity', () => {
  seedActors('sidecar-replacement');
  const checkpoint = captureBusCursor();
  writeFileSync(
    busMetadataPath(),
    `${JSON.stringify({ schema: 'gaia.bus-instance/1', instanceId: randomUUID() })}\n`,
    'utf8',
  );

  throwsCode(() => validateBusCursor(checkpoint), 'BUS_INSTANCE_MISMATCH');
});

test('sidecar and log corruption both fail closed without repairing evidence', () => {
  seedActors('sidecar-corrupt');
  const checkpoint = captureBusCursor();
  writeFileSync(busMetadataPath(), '{broken\n', 'utf8');
  throwsCode(() => validateBusCursor(checkpoint), 'BUS_INSTANCE_CORRUPT');

  seedActors('log-corrupt');
  const clean = captureBusCursor();
  const corrupt = Buffer.concat([readFileSync(logPath()), Buffer.from('{broken\n')]);
  writeFileSync(logPath(), corrupt);
  throwsCode(() => validateBusCursor(clean), 'BUS_LOG_CORRUPT');
  assert.deepEqual(readFileSync(logPath()), corrupt);
});

test('a legacy nonempty log requires explicit migration before cursor capture', () => {
  freshDir('legacy');
  writeFileSync(logPath(), `${JSON.stringify({ type: 'actor.registered', at: '2026-09-20T12:00:00.000Z', ref: 'act-0001', name: 'legacy', isNew: true, kind: 'test', declaredCapabilities: [], busAuthority: ['send'] })}\n`, 'utf8');

  throwsCode(() => captureBusCursor(), 'BUS_INSTANCE_MISSING');
  migrateLegacyBusInstance();
  assert.equal(captureBusCursor().recordCount, 1);
});

test('combined send validates, appends, and exact-reconciles under one operation', () => {
  seedActors('combined-send');
  const checkpoint = captureBusCursor();
  const command = sendCommand();

  const first = commitAndReconcileFromCursor({ checkpoint, command });
  const retry = commitAndReconcileFromCursor({ checkpoint, command });

  assert.equal(first.status, 'APPENDED');
  assert.equal(retry.status, 'EXISTING');
  assert.deepEqual(retry.record, first.record);
  assert.deepEqual(retry.cursor, first.cursor);
  assert.equal(readEvents().filter(event => event.type === 'message.sent').length, 1);
});

test('combined send refuses duplicate post-checkpoint evidence', () => {
  seedActors('combined-duplicate');
  const checkpoint = captureBusCursor();
  const command = sendCommand();
  const sent = commitSendIfAbsent(command);
  const duplicate = structuredClone(sent.record);
  duplicate.message.messageId = 'msg-9999';
  withLock(() => appendEvents([duplicate]));

  throwsCode(() => commitAndReconcileFromCursor({ checkpoint, command }), 'BUS_DUPLICATE_SEND');
});

test('combined send refuses conflicting post-checkpoint evidence', () => {
  seedActors('combined-conflict');
  const checkpoint = captureBusCursor();
  const prefix = readFileSync(logPath());
  const command = sendCommand();
  const sent = commitSendIfAbsent(command);
  const conflicting = structuredClone(sent.record);
  conflicting.message.text = 'different durable bytes';
  writeFileSync(logPath(), prefix);
  withLock(() => appendEvents([conflicting]));

  throwsCode(() => commitAndReconcileFromCursor({ checkpoint, command }),
    'BUS_CORRELATION_CONFLICT');
});

test('append retry re-establishes durability after complete bytes outlive a flush failure', () => {
  seedActors('append-flush-retry');
  const checkpoint = captureBusCursor();
  const command = sendCommand();
  let failed = false;
  let failedFlushCount = 0;
  const failFirstFlush = () => {
    failedFlushCount += 1;
    if (!failed) {
      failed = true;
      const error = new Error('injected fsync failure after visible append');
      error.code = 'EIO';
      throw error;
    }
  };

  assert.throws(() => commitAndReconcileFromCursor(
    { checkpoint, command }, undefined, { fsync: failFirstFlush, platformName: 'win32' },
  ), /injected fsync failure/u);
  assert.equal(failedFlushCount, 1);
  assert.equal(readEvents().filter(event => event.type === 'message.sent').length, 1);
  let retryFlushCount = 0;
  const recovered = commitAndReconcileFromCursor({ checkpoint, command }, undefined, {
    platformName: 'win32',
    fsync(fd) { retryFlushCount += 1; fsyncSync(fd); },
  });
  assert.equal(recovered.status, 'EXISTING');
  assert.equal(retryFlushCount, 2, 'Windows retry must repeat both portable file barriers');
  assert.equal(readEvents().filter(event => event.type === 'message.sent').length, 1);
});

test('sidecar retry republishes complete metadata after the publication barrier fails', () => {
  freshDir('sidecar-flush-retry');
  let failedPublicationCount = 0;
  assert.throws(() => readBusInstanceMetadata({
    createIfEmpty: true,
    flushPublication() {
      failedPublicationCount += 1;
      throw new Error('injected sidecar publication failure after durable file contents');
    },
  }), /injected sidecar publication failure/u);
  assert.equal(failedPublicationCount, 1);
  const visible = JSON.parse(readFileSync(busMetadataPath(), 'utf8'));
  let retryPublicationCount = 0;
  let retryFlushCount = 0;
  const recovered = readBusInstanceMetadata({
    createIfEmpty: true,
    flushPublication(path) {
      retryPublicationCount += 1;
      flushFileAndPublication(path, {
        platformName: 'win32',
        fsync(fd) { retryFlushCount += 1; fsyncSync(fd); },
      });
    },
  });
  assert.equal(retryPublicationCount, 1);
  assert.equal(retryFlushCount, 2, 'Windows retry must repeat both portable file barriers');
  assert.equal(recovered.instanceId, visible.instanceId);
});

test('reconciliation refuses missing post-checkpoint evidence', () => {
  seedActors('reconcile-missing');
  const checkpoint = captureBusCursor();
  const prefix = readFileSync(logPath());
  const sent = commitSendIfAbsent(sendCommand());
  writeFileSync(logPath(), prefix);

  throwsCode(() => reconcileSendFromCursor(checkpoint, sent.record), 'BUS_SEND_MISSING');
});

test('reconciliation refuses duplicate post-checkpoint evidence', () => {
  seedActors('reconcile-duplicate');
  const checkpoint = captureBusCursor();
  const sent = commitSendIfAbsent(sendCommand());
  withLock(() => appendEvents([structuredClone(sent.record)]));

  throwsCode(() => reconcileSendFromCursor(checkpoint, sent.record), 'BUS_DUPLICATE_SEND');
});

test('reconciliation refuses conflicting bytes for the same post-checkpoint correlation', () => {
  seedActors('reconcile-conflict');
  const checkpoint = captureBusCursor();
  const prefix = readFileSync(logPath());
  const sent = commitSendIfAbsent(sendCommand());
  const conflicting = structuredClone(sent.record);
  conflicting.message.text = 'different durable bytes';
  writeFileSync(logPath(), prefix);
  withLock(() => appendEvents([conflicting]));

  throwsCode(() => reconcileSendFromCursor(checkpoint, sent.record), 'BUS_CORRELATION_CONFLICT');
});
