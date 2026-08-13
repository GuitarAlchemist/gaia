/**
 * prototype-pollution.test.mjs — an inherited object key is not an identity.
 *
 * `state.actors`, `nameIndex`, `messages` and `inboxes` are plain objects, so every
 * membership test written as `map[key]` reads `Object.prototype` for `__proto__`,
 * `constructor`, `toString`, `valueOf` and `hasOwnProperty`. That made five field
 * names addressable as actors, let an unregistered ref send a durable message, threw
 * a raw TypeError out of a reducer documented as never throwing, and — because
 * `aged[ref] = …` in `ageActors` invokes the `__proto__` setter — silently dropped a
 * committed registration on replay.
 *
 * These tests are written to fail against a DENYLIST implementation as much as against
 * the unguarded one: an operator may legitimately name a session `constructor`, and
 * after this repair that must WORK rather than be banned. `legitimate identifiers`
 * below is the test that a denylist cannot pass.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  commit, replay, snapshot, pendingFor, integrityReport,
  EMPTY_STATE, BUS_VERBS, BUS_AUTHORITY,
} from '../src/bus-core.mjs';
import { evidenceReport } from '../src/verify.mjs';
import { assertIntegrationAllowed, EcosystemRefusal } from '../src/ecosystem.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BUS = join(ROOT, 'scripts', 'bus-cli.mjs');
const CTL = join(ROOT, 'scripts', 'gaia-interagent.mjs');
const GEN = join(ROOT, 'scripts', 'generate-config.mjs');
const TARS = join(ROOT, 'scripts', 'tars-mount.mjs');
const GAWATCH = join(ROOT, 'scripts', 'ga-watch.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-interagent-proto-'));
let counter = 0;
const freshDir = (name) => {
  const dir = join(SCRATCH, `${name}-${counter += 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

test.after(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

/** The five keys every plain object answers to without ever having been assigned one. */
const INHERITED = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];

/**
 * A caller-visible payload must never carry the source expression that failed.
 * Leaking `(base.inboxes[m.to] ?? [])` tells an attacker the shape of the reducer and
 * tells an operator nothing actionable.
 */
const LEAKS = [
  /\bis not a function\b/, /\bis not iterable\b/,
  /state\.[a-zA-Z]+\[/, /base\.[a-zA-Z]+\[/, /REQUIRED\[/, /\?\?\s*\[\]/,
];
const assertNoLeak = (text, label) => {
  for (const re of LEAKS) assert.doesNotMatch(String(text), re, `${label} leaks an internal expression`);
};

const at = (n) => new Date(Date.parse('2026-08-09T12:00:00.000Z') + n * 1000).toISOString();

/** Two real actors, minted the only way the bus mints them. */
function twoActors() {
  let state = EMPTY_STATE;
  for (const [i, name] of ['gaia', 'real'].entries()) {
    state = commit(state, { type: 'register', at: at(i), actorId: name, kind: 'worker' }).state;
  }
  return state;
}

function run(script, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end();
    child.on('close', (code) => {
      let json = null;
      try { json = JSON.parse(stdout.trim().split('\n').pop()); } catch { /* left null */ }
      resolve({ code, stdout, stderr, json });
    });
  });
}

// ---------------------------------------------------------------------------
// decide: the write path
// ---------------------------------------------------------------------------

test('register refuses an inherited key as a ref, and mints nothing', () => {
  const state = twoActors();
  for (const key of INHERITED) {
    const out = commit(state, { type: 'register', at: at(9), actorId: 'ghost', ref: key });
    assert.equal(out.error, `unknown ref for re-registration: ${key}`, key);
    assert.deepEqual(out.events.map((e) => e.type), ['command.rejected'],
      'the attempt is still recorded — suppressing the rejection is not the fix');
    assert.equal(Object.hasOwn(out.state.actors, key), false, `${key} did not become an actor`);
    assert.equal(out.state.counters.actor, state.counters.actor, 'no ref was minted');
  }
});

test('register refuses a well-shaped ref the bus never minted', () => {
  const state = twoActors();
  const out = commit(state, { type: 'register', at: at(9), actorId: 'ghost', ref: 'act-9999' });
  assert.equal(out.error, 'unknown ref for re-registration: act-9999');
  assert.equal(Object.hasOwn(out.state.actors, 'act-9999'), false);
});

test('send refuses an inherited key in from, to and replyTo, writing no message', () => {
  const state = twoActors();
  for (const key of INHERITED) {
    const from = commit(state, { type: 'send', at: at(9), from: key, to: 'act-0002', text: 'forged' });
    assert.equal(from.error, `from: unknown actor: ${key}`, key);
    assert.equal(Object.keys(from.state.messages).length, 0, 'no message.sent for a forged sender');
    assertNoLeak(from.error, `send --from ${key}`);

    const to = commit(state, { type: 'send', at: at(9), from: 'act-0001', to: key, text: 'x' });
    assert.equal(to.error, `to: unknown actor: ${key}`, key);
    assert.equal(Object.keys(to.state.messages).length, 0);
    assertNoLeak(to.error, `send --to ${key}`);

    const reply = commit(state, { type: 'send', at: at(9), from: 'act-0001', to: 'act-0002', text: 'x', replyTo: key });
    assert.equal(reply.error, `replyTo: unknown actor: ${key}`, key);
    assert.equal(Object.keys(reply.state.messages).length, 0);
  }
});

test('inbox, heartbeat and handoff refuse an inherited key rather than throwing', () => {
  const state = twoActors();
  for (const key of INHERITED) {
    const inbox = commit(state, { type: 'inbox', at: at(9), actorId: key });
    assert.equal(inbox.error, `actorId: unknown actor: ${key}`, key);
    assertNoLeak(inbox.error, `inbox ${key}`);

    const beat = commit(state, { type: 'heartbeat', at: at(9), actorId: key });
    assert.equal(beat.error, `actorId: unknown actor: ${key}`, key);

    const hand = commit(state, { type: 'handoff', at: at(9), from: key, to: 'act-0002', summary: 's' });
    assert.equal(hand.error, `from: unknown actor: ${key}`, key);
  }
});

test('ack refuses an inherited messageId as unknown, not as misaddressed', () => {
  const state = twoActors();
  for (const key of INHERITED) {
    const out = commit(state, { type: 'ack', at: at(9), actorId: 'act-0001', messageId: key });
    assert.equal(out.error, `unknown messageId: ${key}`, key);
    assert.doesNotMatch(out.error, /addressed to undefined/);
  }
});

test('legitimate identifiers: an actor may genuinely be named constructor', () => {
  // The discriminating case. A denylist implementation fails here, and it is the
  // reason this repair is an own-key check rather than a list of banned words.
  let state = twoActors();
  for (const key of INHERITED) {
    const out = commit(state, { type: 'register', at: at(20), actorId: key, kind: 'worker' });
    assert.equal(out.error, null, `${key} must register: ${out.error}`);
    assert.match(out.result.ref, /^act-\d{4,}$/, `${key} gets a minted ref`);
    assert.equal(out.result.addressing, `addressable as "${key}" or ${out.result.ref}`);
    state = out.state;

    const ref = out.result.ref;
    assert.ok(Array.isArray(state.inboxes[ref]), `${key} owns a real inbox array`);
    const sent = commit(state, { type: 'send', at: at(21), from: key, to: 'act-0001', text: 'hello' });
    assert.equal(sent.error, null, `${key} can send by name: ${sent.error}`);
    assert.equal(sent.result.route, `${ref} -> act-0001`, 'the name resolves to its own minted ref');
    state = sent.state;
  }
  assert.equal(Object.getPrototypeOf(state.actors), Object.prototype, 'the actors map was not re-parented');
  assert.equal(({}).ghost, undefined, 'no global prototype was polluted');
});

test('legitimate re-registration by minted ref still updates in place', () => {
  const state = twoActors();
  const out = commit(state, { type: 'register', at: at(30), actorId: 'renamed', ref: 'act-0002' });
  assert.equal(out.error, null, out.error);
  assert.equal(out.result.ref, 'act-0002', 'the ref is preserved');
  assert.equal(out.state.counters.actor, state.counters.actor, 're-registration mints nothing');
  assert.equal(out.state.actors['act-0002'].registeredAt, state.actors['act-0002'].registeredAt);
  assert.equal(out.state.nameIndex.renamed[0], 'act-0002', 'the new name resolves');
  assert.equal(out.state.nameIndex.real, undefined, 'the freed name stops resolving');
});

// ---------------------------------------------------------------------------
// apply / replay: logs a pre-fix build already wrote
// ---------------------------------------------------------------------------

/** A registration record only the defective build could have committed. */
const legacyRegistration = (ref, name, n) => ({
  type: 'actor.registered', at: at(n), ref, name, isNew: true, kind: 'worker',
  declaredCapabilities: [], busAuthority: [...BUS_AUTHORITY],
});

test('a legacy log carrying an inherited ref replays deterministically and is retained', () => {
  const events = [
    legacyRegistration('act-0001', 'gaia', 1),
    legacyRegistration('__proto__', 'ghost', 2),
  ];
  const state = replay(events);
  assert.equal(JSON.stringify(snapshot(replay(events))), JSON.stringify(snapshot(state)), 'replay is deterministic');
  assert.equal(Object.hasOwn(state.actors, '__proto__'), true,
    'the log durably says the record exists; replay must reproduce it as an OWN key');
  assert.equal(Object.getPrototypeOf(state.actors), Object.prototype, 'the actors map is not re-parented');
  assert.equal(state.actors.name, undefined, 'a field name is not an actor');
  assert.equal(({}).ghost, undefined, 'Object.prototype is untouched');

  const findings = integrityReport(state).findings.map((f) => f.finding);
  assert.ok(findings.includes('unminted-actor-ref'), `integrityReport names it: ${JSON.stringify(findings)}`);

  // …and it still cannot be adopted as a ref by a live command.
  const out = commit(state, { type: 'register', at: at(9), actorId: 'ghost2', ref: '__proto__' });
  assert.equal(out.error, 'unknown ref for re-registration: __proto__');
});

test('a legacy registration on an inherited ref counts exactly once', () => {
  // An under-count is the dangerous direction: the next mint would collide with a ref
  // already in use, from a log the bus merely READ.
  const state = replay([
    legacyRegistration('act-0001', 'gaia', 1),
    legacyRegistration('__proto__', 'ghost', 2),
  ]);
  assert.equal(state.counters.actor, 2, 'both registrations were counted');
  assert.equal(state.actors['__proto__'].registeredAt, at(2));
  assert.equal(Object.getPrototypeOf(state.nameIndex), Object.prototype);
});

test('a legacy message addressed to an inherited key owns a real inbox', () => {
  const events = [
    legacyRegistration('act-0001', 'gaia', 1),
    {
      type: 'message.sent', at: at(5),
      message: {
        messageId: 'msg-0001', correlationId: 'cor-legacy', from: 'act-0001', fromName: 'gaia',
        to: '__proto__', toName: 'ghost', replyTo: 'act-0001', replyToName: 'gaia',
        expectsReply: false, kind: 'note', text: 'legacy', trust: 'untrusted-text',
        authority: { granted: [], denied: [], effect: 'none', neverGrantable: [] },
        flags: [], sentAt: at(5), delivery: 'accepted-for-delivery; not read, not agreed, not completed',
        deliveredAt: null, ackedBy: null, ackedAt: null,
      },
    },
  ];
  const state = replay(events);
  assert.ok(Array.isArray(state.inboxes['__proto__']), 'an OWN inbox array exists for the key');
  assert.deepEqual(pendingFor(state, '__proto__').map((m) => m.messageId), ['msg-0001']);
  assert.equal(Object.getPrototypeOf(state.inboxes), Object.prototype, 'the inbox map is not re-parented');
  const findings = integrityReport(state).findings.map((f) => f.finding);
  assert.ok(findings.includes('unminted-message-party'), JSON.stringify(findings));
});

test('pendingFor never returns an inherited value', () => {
  const state = twoActors();
  for (const key of [...INHERITED, 'name', 'kind', 'status']) {
    assert.deepEqual(pendingFor(state, key), [], key);
    assert.deepEqual(pendingFor(EMPTY_STATE, key), [], `${key} on EMPTY_STATE`);
  }
});

test('a legacy heartbeat for a non-actor conjures no phantom', () => {
  const state = replay([
    legacyRegistration('act-0001', 'gaia', 1),
    { type: 'actor.heartbeat', at: at(3), actorId: 'constructor', note: null },
  ]);
  assert.deepEqual(Object.keys(state.actors), ['act-0001'], 'no phantom actor');
  for (const a of snapshot(state).actors) {
    assert.equal(typeof a.ref, 'string');
    assert.equal(typeof a.name, 'string');
  }
});

test('a legacy poll or ack for an inherited id conjures no message', () => {
  const state = replay([
    legacyRegistration('act-0001', 'gaia', 1),
    { type: 'inbox.polled', at: at(4), actorId: 'act-0001', messageIds: ['toString'] },
    { type: 'message.acked', at: at(5), actorId: 'act-0001', messageId: 'valueOf', note: null },
  ]);
  assert.equal(Object.hasOwn(state.messages, 'toString'), false);
  assert.equal(Object.hasOwn(state.messages, 'valueOf'), false);
  assert.equal(Object.getPrototypeOf(state.messages), Object.prototype);
});

test('apply stays total across every event type carrying an inherited identifier', () => {
  const events = [
    legacyRegistration('act-0001', 'gaia', 1),
    legacyRegistration('constructor', 'ghost', 2),
    { type: 'actor.heartbeat', at: at(3), actorId: '__proto__', note: null },
    { type: 'inbox.polled', at: at(4), actorId: 'hasOwnProperty', messageIds: ['toString'] },
    { type: 'message.acked', at: at(5), actorId: 'valueOf', messageId: 'toString', note: null },
    { type: 'command.rejected', at: at(6), command: 'send', reason: 'nope' },
  ];
  const state = replay(events);
  assert.equal(state.counters.event, events.length, 'every event applied');
  assert.equal(JSON.stringify(snapshot(replay(events))), JSON.stringify(snapshot(state)));
  assert.equal(({}).ghost, undefined);
  assert.equal(Object.getPrototypeOf(state.actors), Object.prototype);
});

// ---------------------------------------------------------------------------
// the verifier can see it
// ---------------------------------------------------------------------------

test('the evidence gate rejects a log whose addresses the bus never minted', () => {
  const genuine = [
    legacyRegistration('act-0001', 'gaia', 1),
    { ...legacyRegistration('act-0002', 'claude-code', 2), kind: 'coordinator' },
    legacyRegistration('act-0003', 'codex', 3),
  ];
  const msg = (n, from, to) => ({
    type: 'message.sent', at: at(10 + n),
    message: {
      messageId: `msg-000${n}`, correlationId: 'cor-thread', from, fromName: from, to, toName: to,
      replyTo: 'act-0001', replyToName: 'gaia', expectsReply: false, kind: 'note', text: `b${n}`,
      trust: 'untrusted-text', authority: { granted: [], denied: [], effect: 'none', neverGrantable: [] },
      flags: [], sentAt: at(10 + n), delivery: 'accepted-for-delivery; not read, not agreed, not completed',
      deliveredAt: null, ackedBy: null, ackedAt: null,
    },
  });
  const tail = [
    { type: 'message.acked', at: at(20), actorId: 'act-0002', messageId: 'msg-0001', note: null },
    {
      type: 'work.handed-off', at: at(21), from: 'act-0002', to: 'act-0003', messageId: 'msg-0003',
      correlationId: 'cor-thread', replyTo: 'act-0001', summary: 's', authorityTransferred: [],
    },
  ];
  const clean = [...genuine, msg(1, 'act-0001', 'act-0002'), msg(2, 'act-0002', 'act-0001'),
    msg(3, 'act-0002', 'act-0003'), ...tail];
  assert.equal(evidenceReport(clean).ok, true,
    evidenceReport(clean).checks.filter((c) => !c.ok).map((c) => c.name).join('; '));

  const forged = [...genuine, msg(1, 'constructor', 'act-0002'), msg(2, 'act-0002', 'act-0001'),
    msg(3, 'act-0002', 'act-0003'), ...tail];
  const report = evidenceReport(forged);
  assert.equal(report.ok, false, 'a forged sender must not certify 10/10');
  const provenance = report.checks.find((c) => c.name === 'every address in the log belongs to an actor this bus minted');
  assert.equal(provenance.ok, false);
  assert.match(provenance.detail, /constructor/);
});

test('doctor and verify agree on a log a pre-fix build wrote', { timeout: 60_000 }, async () => {
  const dir = freshDir('poisoned');
  const events = [
    legacyRegistration('act-0001', 'gaia', 1),
    legacyRegistration('__proto__', 'ghost', 2),
    legacyRegistration('constructor', 'forged', 3),
  ];
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const doc = await run(CTL, ['doctor', '--data-dir', dir]);
  assert.equal(doc.json.replayable, true, 'replayable was never the disputed claim');
  assert.equal(doc.json.integrityOk, false, 'doctor sees the illegitimate refs');
  assert.equal(doc.json.ok, false, 'doctor must not call this log healthy');

  const ver = await run(CTL, ['verify', '--data-dir', dir, '--require-evidence']);
  assert.equal(ver.json.ok, false, 'verify must not call this log healthy either');
  assert.equal(doc.json.ok, ver.json.ok, 'doctor and verify agree');
  const detail = JSON.stringify(doc.json.integrityFindings);
  assert.match(detail, /__proto__/);
  assert.match(detail, /constructor/);
});

// ---------------------------------------------------------------------------
// process level: what a caller actually sees
// ---------------------------------------------------------------------------

test('over the real stdio server, a forged ref never reaches the log', { timeout: 60_000 }, async () => {
  const dir = freshDir('e2e');
  const env = { GAIA_INTERAGENT_DATA_DIR: dir };
  await run(BUS, ['register', '--actorId', 'real'], { env });

  const reg = await run(BUS, ['register', '--actorId', 'ghost', '--ref', '__proto__'], { env });
  assert.equal(reg.code, 1, `expected a bus refusal, got ${reg.code}: ${reg.stdout}${reg.stderr}`);
  assert.deepEqual(reg.json.eventsAppended, ['command.rejected']);
  assertNoLeak(reg.stdout, 'register --ref __proto__');

  const send = await run(BUS, ['send', '--from', 'constructor', '--to', 'real', '--text', 'forged'], { env });
  assert.equal(send.code, 1);
  assertNoLeak(send.stdout, 'send --from constructor');

  const inbox = await run(BUS, ['inbox', '--actorId', 'constructor'], { env });
  assert.equal(inbox.code, 1, 'a bus refusal, not a fail-closed 3 and not a TypeError');
  assert.ok(!inbox.json?.failClosed, 'nothing was fail-closed: the bus answered');
  assertNoLeak(inbox.stdout, 'inbox --actorId constructor');

  const log = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  assert.doesNotMatch(log, /"type":"actor\.registered","at":"[^"]*","ref":"__proto__"/);
  assert.doesNotMatch(log, /"from":"constructor"/);
  assert.doesNotMatch(log, /"type":"message\.sent"/, 'no message was committed at all');
});

test('the control script dispatches on its own commands only', { timeout: 60_000 }, async () => {
  for (const key of INHERITED) {
    const res = await run(CTL, [key]);
    assert.equal(res.code, 2, `${key} is a usage error, not a dispatch: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /usage error: unknown command/);
    assertNoLeak(res.stderr, `control script ${key}`);
  }
});

test('a log that parses but cannot replay fails closed at exit 3 without leaking', { timeout: 60_000 }, async () => {
  const dir = freshDir('unreplayable');
  const log = join(dir, 'events.jsonl');
  // Parses as JSONL with a `type`, so the log reader accepts it; `apply` cannot
  // consume it. Adding a schema is explicitly out of scope — failing closed is the
  // bounded answer, and this pins it.
  writeFileSync(log, JSON.stringify({ type: 'message.sent', at: at(1), message: null }) + '\n', 'utf8');
  const before = readFileSync(log, 'utf8');

  const res = await run(BUS, ['send', '--from', 'a', '--to', 'b', '--text', 'x'], { env: { GAIA_INTERAGENT_DATA_DIR: dir } });
  assert.equal(res.code, 3, `expected fail-closed 3, got ${res.code}: ${res.stdout}${res.stderr}`);
  assert.equal(readFileSync(log, 'utf8'), before, 'the log is byte-unchanged');
  assertNoLeak(res.stdout, 'unreplayable log payload');
});

// ---------------------------------------------------------------------------
// the same principle, applied to the two lookup tables that still read through
// the prototype chain
//
// `an inherited object key is not an identity` was applied to the four bus identity
// maps and to the control script's dispatch table. Two tables at the edge were not:
//
//   - the ecosystem gate read `ECOSYSTEM_VERDICTS[key]` and refused on falsiness.
//     Inherited keys are truthy, so `--repo __proto__` and `--repo constructor`
//     exited 0 carrying a verdict the analysis never gave them — and `constructor`
//     serialised to a report with the `verdict` and `reason` keys missing entirely,
//     because JSON.stringify drops function values.
//   - generate-config tested its client allowlist with `in`, which walks the chain,
//     so `--client constructor` skipped the allowlist message and surfaced a
//     node:path internal error instead.
//
// `toString`, `valueOf` and `hasOwnProperty` were refused only incidentally, because
// `.toLowerCase()` mangles them into non-keys. That is an accident, not a guard, so
// the whole INHERITED array is pointed at both tables below.
// ---------------------------------------------------------------------------

test('the ecosystem gate refuses an inherited key rather than inheriting a verdict', () => {
  for (const key of INHERITED) {
    assert.throws(() => assertIntegrationAllowed(key), EcosystemRefusal, `${key} is not a known target`);
    try {
      assertIntegrationAllowed(key);
      assert.fail('unreachable');
    } catch (err) {
      assert.match(err.message, /unknown ecosystem target/, `${key} is refused as unknown, not as REJECT/DEFER`);
      assertNoLeak(err.message, `ecosystem gate ${key}`);
    }
  }
});

test('NEGATIVE CONTROL: the four real ecosystem targets keep their own verdicts', () => {
  // If the own-key read had been written as a denylist, or had narrowed the table,
  // these would go red. ADAPTER_ONLY still returns; REJECT and DEFER still throw.
  for (const name of ['ga', 'tars', 'GA', ' Tars ']) {
    const allowed = assertIntegrationAllowed(name);
    assert.equal(allowed.verdict, 'ADAPTER_ONLY', name);
    assert.ok(allowed.reason.length > 0, `${name} carries its reason`);
  }
  for (const name of ['hari', 'ix']) {
    assert.throws(() => assertIntegrationAllowed(name), EcosystemRefusal, name);
    try {
      assertIntegrationAllowed(name);
      assert.fail('unreachable');
    } catch (err) {
      assert.doesNotMatch(err.message, /unknown ecosystem target/, `${name} is refused BY VERDICT, not as unknown`);
    }
  }
});

test('ga-watch and tars-mount refuse an inherited --repo at the script edge', { timeout: 60_000 }, async () => {
  const dir = freshDir('eco-repo');
  const inbox = join(dir, 'ga.jsonl');
  writeFileSync(inbox, JSON.stringify({ id: 'r1', at: at(1), kind: 'note' }) + '\n', 'utf8');

  for (const key of INHERITED) {
    const watch = await run(GAWATCH, ['--repo', key, '--inbox', inbox, '--data-dir', dir]);
    assert.equal(watch.code, 1, `ga-watch --repo ${key}: ${watch.stdout}${watch.stderr}`);
    assert.match(watch.stderr, /REFUSED/);
    assertNoLeak(watch.stderr, `ga-watch --repo ${key}`);

    const out = freshDir('eco-out');
    const mount = await run(TARS, ['--repo', key, '--out', out]);
    assert.equal(mount.code, 2, `tars-mount --repo ${key}: ${mount.stdout}${mount.stderr}`);
    assert.match(mount.stderr, /REFUSED/);
    assert.equal(readdirSync(out).length, 0, 'a refused target writes nothing');
  }
});

test('NEGATIVE CONTROL: tars-mount still reports a real ADAPTER_ONLY verdict', { timeout: 60_000 }, async () => {
  // The machine-readable verdict a CI step keys on must survive the own-key read.
  const out = freshDir('eco-ok');
  const res = await run(TARS, ['--repo', 'tars', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout.slice(0, res.stdout.indexOf('\n}') + 2));
  assert.equal(report.verdict.verdict, 'ADAPTER_ONLY');
  assert.equal(report.verdict.repo, 'tars');
  assert.equal(typeof report.verdict.reason, 'string');
});

test('the client allowlist refuses an inherited key with its own message', { timeout: 60_000 }, async () => {
  for (const key of INHERITED) {
    const res = await run(GEN, ['--client', key, '--out', freshDir('client-key')]);
    assert.equal(res.code, 2, `--client ${key}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /--client must be one of: codex, claude/, `${key} reaches the allowlist message`);
    assert.doesNotMatch(res.stderr, /"path" argument/, `${key} must not surface a node:path internal error`);
    assertNoLeak(res.stderr, `generate-config --client ${key}`);
  }
});

test('NEGATIVE CONTROL: the two real clients are still accepted, and a plain typo still names them', { timeout: 60_000 }, async () => {
  for (const client of ['codex', 'claude']) {
    const res = await run(GEN, ['--client', client, '--out', freshDir(`client-${client}`)]);
    assert.equal(res.code, 0, `${client}: ${res.stderr}`);
  }
  const bogus = await run(GEN, ['--client', 'bogus', '--out', freshDir('client-bogus')]);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /--client must be one of: codex, claude/);
});

test('the repair adds no verb: the live surface is still exactly six', { timeout: 60_000 }, async () => {
  const dir = freshDir('tools');
  const res = await run(BUS, ['tools'], { env: { GAIA_INTERAGENT_DATA_DIR: dir } });
  assert.equal(res.code, 0, res.stderr);
  assert.deepEqual([...res.json.result].sort(), ['ack', 'handoff', 'heartbeat', 'inbox', 'register', 'send']);
  assert.equal(res.json.count, 6);
  assert.deepEqual([...BUS_VERBS].sort(), ['ack', 'handoff', 'heartbeat', 'inbox', 'register', 'send']);
});

// ---------------------------------------------------------------------------
// the refs that only a handoff or an ack carries
// ---------------------------------------------------------------------------

/**
 * `integrityReport` walked actors, message parties and inbox owners, and stopped there.
 * Two identity-bearing surfaces were never walked at all:
 *
 *   - `state.handoffs[].from | .to | .replyTo`, pushed verbatim by the `work.handed-off`
 *     reducer with no membership test, and
 *   - `message.ackedBy`, which the `message.acked` reducer sets to `event.actorId` even
 *     when no such actor exists — the actor map is left untouched, so the ack record is
 *     the only durable trace of the forged ref.
 *
 * A log carrying either replays deterministically, reports `integrityFindings: []`, and
 * passed `doctor`, `verify` and the always-gating identity check at the same time. That
 * is the strongest available false negative: the one check that gates on identity was
 * actively certifying the forgery.
 *
 * These gates are written to fail against a DENYLIST exactly as the rest of this file
 * is. `NEGATIVE CONTROL: legitimate handoff and ack refs` hands the same code an actor
 * genuinely NAMED `constructor` on a properly minted ref and requires it to pass.
 */
const handoffLog = ({ from = 'act-0001', to = 'act-0002', replyTo = 'act-0001' } = {}) => [
  legacyRegistration('act-0001', 'gaia', 1),
  legacyRegistration('act-0002', 'peer', 2),
  {
    type: 'work.handed-off', at: at(7), from, to, replyTo,
    messageId: 'msg-0009', correlationId: 'cor-handoff', summary: 'take it',
    authorityTransferred: [],
  },
];

const ackLog = (actorId) => [
  legacyRegistration('act-0001', 'gaia', 1),
  legacyRegistration('act-0002', 'peer', 2),
  {
    type: 'message.sent', at: at(5),
    message: {
      messageId: 'msg-0001', correlationId: 'cor-ack', from: 'act-0001', fromName: 'gaia',
      to: 'act-0002', toName: 'peer', replyTo: 'act-0001', replyToName: 'gaia',
      expectsReply: false, kind: 'note', text: 'body', trust: 'untrusted-text',
      authority: { granted: [], denied: [], effect: 'none', neverGrantable: [] },
      flags: [], sentAt: at(5), delivery: 'accepted-for-delivery; not read, not agreed, not completed',
      deliveredAt: null, ackedBy: null, ackedAt: null,
    },
  },
  { type: 'message.acked', at: at(8), actorId, messageId: 'msg-0001', note: null },
];

const findingNames = (state) => integrityReport(state).findings.map((f) => f.finding);

test('integrityReport walks every party a handoff carries', () => {
  for (const field of ['from', 'to', 'replyTo']) {
    for (const forged of [...INHERITED, 'act-9999', 'gaia', '']) {
      const state = replay(handoffLog({ [field]: forged }));
      const report = integrityReport(state);
      assert.equal(state.handoffs.length, 1, 'the handoff is still retained, never repaired away');
      assert.equal(state.handoffs[0][field], forged, `the log durably says ${field} = ${JSON.stringify(forged)}`);
      assert.equal(report.ok, false,
        `handoff.${field} = ${JSON.stringify(forged)} must be reported: ${JSON.stringify(report.findings)}`);
      assert.ok(report.findings.some((f) => f.finding === 'unminted-handoff-party' && f.subject === forged),
        `named as an unminted handoff party: ${JSON.stringify(report.findings)}`);
    }
  }
});

test('integrityReport walks the ref that acked a message', () => {
  for (const forged of [...INHERITED, 'act-9999', 'peer']) {
    const state = replay(ackLog(forged));
    const report = integrityReport(state);
    assert.equal(state.messages['msg-0001'].ackedBy, forged, 'the log durably says who acked');
    assert.equal(report.ok, false,
      `ackedBy = ${JSON.stringify(forged)} must be reported: ${JSON.stringify(report.findings)}`);
    assert.ok(report.findings.some((f) => f.finding === 'unminted-ack-actor' && f.subject === forged),
      `named as an unminted ack actor: ${JSON.stringify(report.findings)}`);
  }
});

test('NEGATIVE CONTROL: legitimate handoff and ack refs are not condemned', () => {
  // A minted ref is a minted ref whatever the operator called the session. An
  // implementation that banned the five inherited NAMES would pass both gates above
  // and fail this one.
  const state = replay([
    legacyRegistration('act-0001', 'constructor', 1),
    legacyRegistration('act-0002', '__proto__', 2),
    {
      type: 'work.handed-off', at: at(7), from: 'act-0001', to: 'act-0002', replyTo: 'act-0002',
      messageId: 'msg-0009', correlationId: 'cor-handoff', summary: 'take it', authorityTransferred: [],
    },
  ]);
  assert.deepEqual(integrityReport(state).findings, [], 'display names are not identities and are not judged');

  const unacked = replay(ackLog('act-0002').slice(0, -1));
  assert.deepEqual(findingNames(unacked), [], 'ackedBy: null is the normal unacked state, not a forgery');
  assert.deepEqual(findingNames(replay(ackLog('act-0002'))), [], 'an ack by a minted actor is clean');
  assert.equal(integrityReport(replay(handoffLog())).ok, true, 'a fully minted handoff is clean');
  assert.equal(integrityReport(replay([])).ok, true, 'an empty log is vacuously clean');
});

test('the added walks report, and never repair or disturb, deterministic replay', () => {
  const events = [...handoffLog({ from: 'constructor' }), ...ackLog('act-9999').slice(2)];
  const state = replay(events);
  const before = JSON.stringify(snapshot(state));

  const first = integrityReport(state);
  assert.deepEqual(integrityReport(state), first, 'a pure read: same state, same findings, same order');
  assert.deepEqual(integrityReport(replay(events)), first, 'and the same from an independently replayed state');
  assert.equal(JSON.stringify(snapshot(state)), before, 'reporting mutates nothing');
  assert.equal(JSON.stringify(snapshot(replay(events))), before, 'replay(events) == replay(events) still holds');
  assert.equal(Object.getPrototypeOf(state.actors), Object.prototype, 'no map was re-parented');
  assert.equal(({}).gaia, undefined, 'Object.prototype is untouched');
});

test('doctor and verify both condemn a log whose only forged ref is in a handoff or an ack',
  { timeout: 120_000 }, async () => {
    // End to end through the shipped commands, because a pure-function finding no
    // command gates on is not a repair. Both logs replay cleanly and carry no forged
    // message party, so an exit 1 here can only come from the two new walks.
    for (const [label, events] of [
      ['a forged handoff party', handoffLog({ from: 'constructor' })],
      ['a forged ack actor', ackLog('act-9999')],
    ]) {
      const dir = freshDir('forged-ref');
      writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
      const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
      const verify = await run(CTL, ['verify', '--data-dir', dir]);
      assert.equal(doctor.code, 1, `doctor condemns ${label}: ${doctor.stdout}${doctor.stderr}`);
      assert.ok(doctor.json.integrityFindings.length > 0,
        `and names it: ${JSON.stringify(doctor.json.integrityFindings)}`);
      assert.equal(verify.code, 1, `verify condemns ${label} too: ${verify.stdout}${verify.stderr}`);
      assert.equal(verify.json.ok, false, `with ok:false on ${label}`);
    }

    // The other direction, so the gate above cannot be bought by condemning everything.
    const clean = freshDir('forged-ref-clean');
    writeFileSync(join(clean, 'events.jsonl'), handoffLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const doctor = await run(CTL, ['doctor', '--data-dir', clean]);
    const verify = await run(CTL, ['verify', '--data-dir', clean]);
    assert.equal(doctor.code, 0, `doctor passes a clean handoff log: ${doctor.stdout}${doctor.stderr}`);
    assert.equal(verify.code, 0, `and so does verify: ${verify.stdout}${verify.stderr}`);
  });
