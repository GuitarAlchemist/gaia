import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { canonicalContinuityJson } from '../src/continuity-contract.mjs';
import { createContinuityController } from '../src/continuity-controller.mjs';
import { openContinuityStore } from '../src/continuity-store.mjs';

const D = character => character.repeat(64);
const MODULE = pathToFileURL(join(import.meta.dirname, '..', 'src', 'continuity-controller.mjs')).href;
const STORE_MODULE = pathToFileURL(join(import.meta.dirname, '..', 'src', 'continuity-store.mjs')).href;
const CRASH_CHILD = join(import.meta.dirname, 'continuity-crash-child.mjs');
const acceptance = operationId => ({
  operationId, expectedRevision: 0, workIdentity: D('1'), workGeneration: 0,
  successorSlot: 'review-successor', actorRef: 'act-0002',
  sessionRef: 'session-generation-0', sessionGeneration: 0,
  capabilityDigest: D('4'), commitmentDigest: D('2'), incomingReviewDigest: D('3'),
});

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-continuity-store-'));
  const path = join(dir, 'continuity.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 50 }));
  return path;
}

function openController(options) {
  return createContinuityController({ store: openContinuityStore(options) });
}

function exactObjectBytes(bytes, fixed = {}) {
  const empty = canonicalContinuityJson({ ...fixed, data: '' });
  assert.ok(Buffer.byteLength(empty, 'utf8') <= bytes);
  const value = { ...fixed, data: 'x'.repeat(bytes - Buffer.byteLength(empty, 'utf8')) };
  assert.equal(Buffer.byteLength(canonicalContinuityJson(value), 'utf8'), bytes);
  return value;
}

function snapshot(path) {
  const db = new DatabaseSync(path);
  const result = {
    clock: db.prepare(`SELECT clock_sequence,clock_head,last_candidate_utc
      FROM continuity_meta WHERE id=1`).get(),
    state: db.prepare('SELECT revision,state_json FROM continuity_state WHERE id=1').get() ?? null,
    operations: Number(db.prepare('SELECT count(*) AS count FROM continuity_operations').get().count),
    inspections: Number(db.prepare('SELECT count(*) AS count FROM continuity_inspections').get().count),
    events: Number(db.prepare('SELECT count(*) AS count FROM continuity_events').get().count),
  };
  db.close();
  return result;
}

function operation(store, index, outcome, operationClass = 'lifecycle') {
  return store.runOperation({
    operationId: `bound-operation-${index}`,
    requestDigest: D((index % 10).toString()),
    operationClass,
    transition: ({ mintTime }) => {
      mintTime();
      return outcome;
    },
  });
}

function runWorker(path, command) {
  const source = `
    const { parentPort, workerData } = require('node:worker_threads');
    Promise.all([import(workerData.module), import(workerData.storeModule)]).then(([controllerModule, storeModule]) => {
      let controller;
      try {
        const store = storeModule.openContinuityStore({ path: workerData.path,
          clockEpoch: '${D('a')}', clock: () => '2026-09-20T00:00:00.000Z' });
        controller = controllerModule.createContinuityController({ store });
        const response = controller.acceptGeneration0Bytes(workerData.command);
        parentPort.postMessage({ ok: true, response });
      } catch (error) {
        parentPort.postMessage({ ok: false, code: error.code });
      } finally { controller?.close(); }
    });`;
  return new Promise((resolve, reject) => {
    const worker = new Worker(source, { eval: true,
      workerData: { module: MODULE, storeModule: STORE_MODULE, path, command } });
    worker.once('message', resolve);
    worker.once('error', reject);
  });
}

test('SQLite WAL is active and concurrent duplicate claims linearize once', async t => {
  const path = scratch(t);
  const bootstrap = openController({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:00:00.000Z' });
  bootstrap.close();
  const db = new DatabaseSync(path);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  db.close();

  const results = await Promise.all([
    runWorker(path, acceptance('claim-a')),
    runWorker(path, acceptance('claim-b')),
  ]);
  assert.equal(results.filter(result => result.ok).length, 1);
  assert.deepEqual(results.filter(result => !result.ok).map(result => result.code), ['STALE_REVISION']);
  const reader = openController({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:01:00.000Z' });
  assert.equal(reader.status().revision, 1);
  reader.close();
});

test('a force-killed process with an open store transaction rolls back and releases the lock', async t => {
  const path = scratch(t);
  const controller = openController({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:00:00.000Z' });
  controller.close();

  const child = fork(CRASH_CHILD, [], { stdio: ['ignore', 'pipe', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const transactionOpen = new Promise((resolve, reject) => {
    child.stdout.once('data', chunk => resolve(chunk.toString('utf8')));
    child.once('error', reject);
  });
  child.send({ mode: 'pre-commit', path, command: acceptance('uncommitted'),
    clockEpoch: D('a'), candidateUtc: '2026-09-20T00:00:00.000Z' });
  assert.match(await transactionOpen, /TRANSACTION_OPEN/u);
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exited;

  const rolledBack = snapshot(path);
  assert.equal(rolledBack.clock.clock_sequence, 0);
  assert.equal(rolledBack.operations, 0);
  assert.equal(rolledBack.state, null);

  const restarted = openController({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:00:00.000Z' });
  assert.equal(restarted.acceptGeneration0(acceptance('uncommitted')).revision, 1);
  restarted.close();
});

test('a killed controller exact-replays a committed response after restart', async t => {
  const path = scratch(t);
  const child = fork(CRASH_CHILD, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  t.after(() => { if (child.exitCode === null) child.kill(); });
  const committed = new Promise((resolve, reject) => {
    child.once('message', resolve);
    child.once('error', reject);
  });
  child.send({ path, command: acceptance('crash-boundary'), clockEpoch: D('a'),
    candidateUtc: '2026-09-20T00:00:00.000Z' });
  assert.deepEqual(await committed, { type: 'commit-complete-response-withheld' });
  const exited = new Promise(resolve => child.once('exit', resolve));
  child.kill();
  await exited;

  const restarted = openController({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:05:00.000Z' });
  const retry = restarted.acceptGeneration0Bytes(acceptance('crash-boundary'));
  assert.equal(JSON.parse(retry).revision, 1);
  assert.equal(restarted.status().revision, 1);
  assert.equal(restarted.status().acceptedAt.candidateUtc, '2026-09-20T00:00:00.000Z');
  assert.equal(restarted.canonicalStatus(), canonicalContinuityJson(restarted.status()));
  restarted.close();
  assert.equal(snapshot(path).clock.clock_sequence, 1);
});

test('pre-existing empty, foreign, and partial databases fail closed', t => {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-continuity-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const paths = ['empty.sqlite', 'foreign.sqlite', 'partial.sqlite'].map(name => join(dir, name));
  closeSync(openSync(paths[0], 'w'));
  const foreign = new DatabaseSync(paths[1]);
  foreign.exec('CREATE TABLE alien(value TEXT) STRICT');
  foreign.close();
  const partial = new DatabaseSync(paths[2]);
  partial.exec(`CREATE TABLE continuity_meta (
    id INTEGER PRIMARY KEY, schema_version INTEGER NOT NULL, clock_epoch TEXT NOT NULL,
    clock_sequence INTEGER NOT NULL, clock_head TEXT NOT NULL, last_candidate_utc TEXT) STRICT`);
  partial.close();
  for (const path of paths) {
    assert.throws(() => openContinuityStore({ path, clockEpoch: D('a') }),
      error => error.code === 'STORE_CORRUPT');
  }
});

test('an accepted ledger with its singleton state erased fails closed on reopen', t => {
  const path = scratch(t);
  const controller = openController({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:00:00.000Z' });
  controller.acceptGeneration0(acceptance('accepted-before-erasure'));
  controller.close();
  const raw = new DatabaseSync(path);
  raw.exec('DELETE FROM continuity_state');
  raw.close();
  assert.throws(() => openContinuityStore({ path, clockEpoch: D('a') }),
    error => error.code === 'STORE_CORRUPT');
});

test('response, state, and event bounds accept 32768 bytes and roll back 32769 bytes', t => {
  for (const kind of ['response', 'state', 'event']) {
    const path = scratch(t);
    const store = openContinuityStore({ path, clockEpoch: D('a'),
      clock: () => '2026-09-20T00:00:00.000Z' });
    const outcome = bytes => ({
      response: kind === 'response' ? exactObjectBytes(bytes) : { ok: true },
      ...(kind === 'state' ? { state: { revision: 1, ...exactObjectBytes(bytes) } } : {}),
      ...(kind === 'event' ? { event: exactObjectBytes(bytes, { type: 'bounded-event' }) } : {}),
    });
    operation(store, 1, outcome(32_768));
    const before = snapshot(path);
    assert.throws(() => operation(store, 2, outcome(32_769)),
      error => error.code === 'BOUND_EXCEEDED', `${kind} should refuse the first excess byte`);
    assert.deepEqual(snapshot(path), before, `${kind} refusal must roll back every durable write`);
    store.close();
  }
});

test('the twelfth lifecycle operation is accepted and the thirteenth rolls back', t => {
  const path = scratch(t);
  const store = openContinuityStore({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:00:00.000Z' });
  for (let index = 0; index < 12; index += 1) operation(store, index, { response: { index } });
  const before = snapshot(path);
  assert.equal(before.operations, 12);
  assert.throws(() => operation(store, 12, { response: { index: 12 } }),
    error => error.code === 'BOUND_EXCEEDED');
  assert.deepEqual(snapshot(path), before);
  store.close();
});

test('aggregate payload accepts 524288 bytes and rolls back the first excess byte', t => {
  const path = scratch(t);
  const store = openContinuityStore({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:00:00.000Z' });
  for (let index = 0; index < 8; index += 1) {
    operation(store, index, { response: exactObjectBytes(32_768),
      event: exactObjectBytes(32_768, { type: `bounded-event-${index}` }) });
  }
  const before = snapshot(path);
  assert.equal(before.operations, 8);
  assert.equal(before.events, 8);
  assert.throws(() => operation(store, 8, { response: { excess: true } }),
    error => error.code === 'BOUND_EXCEEDED');
  assert.deepEqual(snapshot(path), before);
  store.close();
});

test('inspection responses share the 524288-byte durable aggregate ceiling', t => {
  const path = scratch(t);
  const store = openContinuityStore({ path, clockEpoch: D('a'),
    clock: () => '2026-09-20T00:00:00.000Z' });
  for (let index = 0; index < 16; index += 1) {
    operation(store, index, { response: exactObjectBytes(32_768) }, 'inspection');
  }
  const before = snapshot(path);
  assert.equal(before.inspections, 16);
  const replay = operation(store, 0, { response: exactObjectBytes(32_768) }, 'inspection');
  assert.equal(replay.replayed, true);
  assert.deepEqual(snapshot(path), before);
  assert.throws(() => operation(store, 16, { response: { excess: true } }, 'inspection'),
    error => error.code === 'BOUND_EXCEEDED');
  assert.deepEqual(snapshot(path), before);
  store.close();
});
