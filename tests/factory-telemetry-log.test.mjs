import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { CorruptLogError, LockTimeoutError } from '../src/event-log.mjs';
import {
  FACTORY_TELEMETRY_MACHINE,
  buildFactoryTelemetryEvent,
} from '../src/factory-telemetry.mjs';
import {
  EMPTY_FACTORY_TELEMETRY_LOG_REVISION,
  FACTORY_TELEMETRY_LOG_RECORD_SCHEMA,
  FACTORY_TELEMETRY_LOG_SCHEMA,
  FactoryTelemetryLogError,
  appendFactoryTelemetryEvent,
  factoryTelemetryLogLockPath,
  factoryTelemetryLogPath,
  projectFactoryTelemetryLog,
  readFactoryTelemetryLog,
} from '../src/factory-telemetry-log.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'gaia-factory-telemetry-log-test-'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const SUBJECT = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemId: 'issue-27',
  itemNumber: 27,
  lane: 'LANE_A',
  agent: 'CLAUDE_WORKER',
  itemRevision: 'a'.repeat(64),
});

const NOW = '2026-08-29T18:30:00.000Z';

function run(steps, runId = 'run-27-alpha') {
  const events = [];
  let previous = null;
  for (const step of steps) {
    previous = buildFactoryTelemetryEvent({ runId, subject: SUBJECT, previous, ...step });
    events.push(previous);
  }
  return events;
}

const ARC = run([
  { event: 'run.started', observedAt: '2026-08-29T18:00:00.000Z' },
  { event: 'run.heartbeat', observedAt: '2026-08-29T18:00:05.000Z' },
  { event: 'gate.entered', gate: 'CLAIMED', observedAt: '2026-08-29T18:00:06.000Z' },
]);

let scratchCounter = 0;
function dir(name) {
  scratchCounter += 1;
  return join(ROOT, `${name}-${scratchCounter}`);
}

/** Build one durable line exactly as the writer would, so a read gate discriminates. */
function logLine({
  event, ordinal = 0, previousRevision = null, machine = FACTORY_TELEMETRY_MACHINE, revision,
}) {
  const body = {
    type: 'factory-telemetry.event',
    schema: FACTORY_TELEMETRY_LOG_RECORD_SCHEMA,
    ...machine,
    ordinal,
    previousRevision,
    event,
  };
  return `${canonicalJson({ ...body, revision: revision ?? sha256(canonicalJson(body)) })}\n`;
}

function appendAll(directory, events, notAfter = NOW) {
  let head = EMPTY_FACTORY_TELEMETRY_LOG_REVISION;
  for (const event of events) {
    const result = appendFactoryTelemetryEvent({
      directory, event, expectedLogRevision: head, notAfter,
    });
    head = result.log.revision;
  }
  return head;
}

test('an unused telemetry directory reads as the empty content-addressed head', () => {
  const directory = dir('empty');
  const log = readFactoryTelemetryLog({ directory });

  assert.equal(log.schema, FACTORY_TELEMETRY_LOG_SCHEMA);
  assert.equal(log.revision, EMPTY_FACTORY_TELEMETRY_LOG_REVISION);
  assert.equal(log.count, 0);
  assert.deepEqual(log.events, []);
  assert.equal(existsSync(directory), false);
});

test('appending the observed arc writes one chained durable record per event', () => {
  const directory = dir('arc');
  const head = appendAll(directory, ARC);
  const log = readFactoryTelemetryLog({ directory });

  assert.equal(log.revision, head);
  assert.equal(log.count, 3);
  assert.deepEqual(log.events.map(({ event }) => event), [
    'run.started', 'run.heartbeat', 'gate.entered',
  ]);
  const lines = readFileSync(factoryTelemetryLogPath(directory), 'utf8').split('\n');
  assert.equal(lines.at(-1), '');
  assert.equal(lines.length, 4);
  const records = lines.slice(0, 3).map((line) => JSON.parse(line));
  assert.deepEqual(records.map(({ ordinal }) => ordinal), [0, 1, 2]);
  assert.equal(records[0].previousRevision, null);
  assert.equal(records[1].previousRevision, records[0].revision);
  assert.equal(records[2].previousRevision, records[1].revision);
  assert.equal(existsSync(factoryTelemetryLogLockPath(directory)), false);
});

test('the durable bytes carry only the closed typed fields', () => {
  const directory = dir('closed-bytes');
  appendAll(directory, ARC);
  const records = readFileSync(factoryTelemetryLogPath(directory), 'utf8')
    .split('\n').filter(Boolean).map((line) => JSON.parse(line));

  for (const record of records) {
    assert.deepEqual(Object.keys(record).sort(), [
      'event', 'machineId', 'machineVersion', 'ordinal', 'previousRevision', 'revision',
      'rulesRevision', 'schema', 'type',
    ]);
    assert.deepEqual(Object.keys(record.event).sort(), [
      'agent', 'blocker', 'event', 'evidenceRevision', 'gate', 'itemId', 'itemNumber',
      'itemRevision', 'lane', 'machineId', 'machineVersion', 'observedAt', 'previousRevision',
      'repository', 'revision', 'rulesRevision', 'runId', 'schema', 'sequence',
    ]);
  }
});

test('a single writer wins: a stale expected head fails closed and writes nothing', () => {
  const directory = dir('cas');
  appendAll(directory, ARC.slice(0, 1));
  const before = readFactoryTelemetryLog({ directory });

  assert.throws(
    () => appendFactoryTelemetryEvent({
      directory,
      event: ARC[1],
      expectedLogRevision: EMPTY_FACTORY_TELEMETRY_LOG_REVISION,
      notAfter: NOW,
    }),
    (error) => error instanceof FactoryTelemetryLogError && error.code === 'LogCasMismatch',
  );
  assert.equal(readFactoryTelemetryLog({ directory }).revision, before.revision);
  assert.equal(readFactoryTelemetryLog({ directory }).count, 1);
});

test('duplicate delivery of one identical fact is idempotent and appends nothing', () => {
  const directory = dir('duplicate');
  const head = appendAll(directory, ARC.slice(0, 2));

  const replayed = appendFactoryTelemetryEvent({
    directory,
    event: ARC[1],
    expectedLogRevision: EMPTY_FACTORY_TELEMETRY_LOG_REVISION,
    notAfter: NOW,
  });

  assert.equal(replayed.duplicate, true);
  assert.equal(replayed.log.revision, head);
  assert.equal(replayed.log.count, 2);
  assert.equal(readFactoryTelemetryLog({ directory }).count, 2);
});

test('NEGATIVE CONTROL: an impossible transition is refused and nothing is written', () => {
  const directory = dir('transition');
  const head = appendAll(directory, ARC);

  assert.throws(
    () => appendFactoryTelemetryEvent({
      directory,
      event: buildFactoryTelemetryEvent({
        runId: 'run-27-alpha',
        subject: SUBJECT,
        previous: ARC[2],
        event: 'gate.entered',
        gate: 'PUBLISHED',
        observedAt: '2026-08-29T18:00:07.000Z',
      }),
      expectedLogRevision: head,
      notAfter: NOW,
    }),
    (error) => error?.code === 'TelemetryTransitionInvalid',
  );
  assert.equal(readFactoryTelemetryLog({ directory }).count, 3);
});

test('NEGATIVE CONTROL: an event observed after the writer clock is refused', () => {
  const directory = dir('future');
  assert.throws(
    () => appendFactoryTelemetryEvent({
      directory,
      event: ARC[0],
      expectedLogRevision: EMPTY_FACTORY_TELEMETRY_LOG_REVISION,
      notAfter: '2026-08-29T17:59:59.999Z',
    }),
    (error) => error?.code === 'TelemetryTimestampFuture',
  );
  assert.equal(readFactoryTelemetryLog({ directory }).count, 0);
});

test('NEGATIVE CONTROL: a torn final line fails closed rather than dropping a fact', () => {
  const directory = dir('torn');
  appendAll(directory, ARC.slice(0, 2));
  const path = factoryTelemetryLogPath(directory);
  writeFileSync(path, readFileSync(path, 'utf8').slice(0, -12), 'utf8');

  assert.throws(() => readFactoryTelemetryLog({ directory }), CorruptLogError);
});

test('NEGATIVE CONTROL: a tampered record, a broken chain and a foreign machine fail closed', () => {
  const tampered = dir('tampered');
  mkdirSync(tampered, { recursive: true });
  writeFileSync(
    factoryTelemetryLogPath(tampered),
    logLine({ event: ARC[0], revision: 'f'.repeat(64) }),
    'utf8',
  );
  assert.throws(() => readFactoryTelemetryLog({ directory: tampered }), CorruptLogError);

  const reordered = dir('reordered');
  mkdirSync(reordered, { recursive: true });
  writeFileSync(
    factoryTelemetryLogPath(reordered),
    logLine({ event: ARC[0] }) + logLine({ event: ARC[1], ordinal: 5, previousRevision: null }),
    'utf8',
  );
  assert.throws(() => readFactoryTelemetryLog({ directory: reordered }), CorruptLogError);

  const foreign = dir('foreign');
  mkdirSync(foreign, { recursive: true });
  writeFileSync(
    factoryTelemetryLogPath(foreign),
    logLine({
      event: ARC[0],
      machine: { ...FACTORY_TELEMETRY_MACHINE, machineVersion: 2 },
    }),
    'utf8',
  );
  assert.throws(() => readFactoryTelemetryLog({ directory: foreign }), CorruptLogError);
});

test('NEGATIVE CONTROL: the log is never read or written without its lock', () => {
  const directory = dir('lock');
  appendAll(directory, ARC.slice(0, 1));
  mkdirSync(factoryTelemetryLogLockPath(directory), { recursive: true });

  assert.throws(
    () => readFactoryTelemetryLog({ directory, lockOptions: { timeoutMs: 25 } }),
    LockTimeoutError,
  );
  assert.throws(
    () => appendFactoryTelemetryEvent({
      directory,
      event: ARC[1],
      expectedLogRevision: EMPTY_FACTORY_TELEMETRY_LOG_REVISION,
      notAfter: NOW,
      lockOptions: { timeoutMs: 25 },
    }),
    LockTimeoutError,
  );
});

test('the log projection is passive, deterministic and replays the same head twice', () => {
  const directory = dir('projection');
  appendAll(directory, ARC);

  const first = projectFactoryTelemetryLog({ directory, notAfter: NOW });
  const second = projectFactoryTelemetryLog({ directory, notAfter: NOW });

  assert.equal(first.effect, 'NONE');
  assert.equal(first.authority, 'NONE');
  assert.equal(first.logRevision, readFactoryTelemetryLog({ directory }).revision);
  assert.equal(second.projection.revision, first.projection.revision);
  assert.equal(first.projection.runs.length, 1);
  assert.equal(first.projection.runs[0].runState, 'IN_GATE');
  assert.equal(first.projection.runs[0].currentGate, 'CLAIMED');
  assert.equal(first.projection.runs[0].lastHeartbeatAt, '2026-08-29T18:00:05.000Z');
});

test('an explicit directory is required at every telemetry log seam', () => {
  for (const directory of ['', '  ', null, 42]) {
    assert.throws(
      () => readFactoryTelemetryLog({ directory }),
      (error) => error instanceof FactoryTelemetryLogError
        && error.code === 'LogPathInvalid',
      `${String(directory)} must not be accepted`,
    );
  }
  assert.throws(
    () => appendFactoryTelemetryEvent({
      directory: dir('bad-cas'), event: ARC[0], expectedLogRevision: 'nope', notAfter: NOW,
    }),
    (error) => error instanceof FactoryTelemetryLogError && error.code === 'LogRequestInvalid',
  );
});
