/**
 * adversarial.test.mjs — the tests that try to break the product's own claims.
 *
 * Each one is written to fail against a tempting wrong implementation, not merely to
 * exercise the happy path: an evidence checker that says yes to everything, a lane
 * policy that silently truncates, a GA watcher that writes GA, a release path that
 * hides a stuck lock, a log that leaks a secret it was handed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync, readdirSync, chmodSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  evidenceReport, evidenceWithNegativeControls, syntheticNegativeLog, tamperedCopy,
  busAuthorityTamperedCopy, ALWAYS_GATING_CHECKS, AUTHORITY_INTEGRITY_CHECKS, EVIDENCE_RICHNESS_CHECKS,
} from '../src/verify.mjs';
import { resolveLaneLimit, admitLane, LaneLimitError, DEFAULT_MAX_LIVE_LANES } from '../src/lanes.mjs';
import { assertIntegrationAllowed, EcosystemRefusal, ECOSYSTEM_VERDICTS, safeStartupTimeoutSec } from '../src/ecosystem.mjs';
import { LOCK_RM_OPTIONS, LOCK_RELEASE_MAX_RETRIES, LOCK_RELEASE_RETRY_DELAY_MS, withLock, lockPath, appendEvents, readEvents } from '../src/event-log.mjs';
import {
  replay, commit, resolveActor, correlationHealthReport, CORRELATION_CLAIM_SLACK,
  CORRELATION_HEADROOM_FLOOR, NEVER_GRANTABLE, BUS_AUTHORITY, EMPTY_STATE,
} from '../src/bus-core.mjs';

/** The one place each gating check's own name is spelled, so a rename cannot drift. */
const CORRELATION_CHECK = 'the correlation issuer still has room to mint';
const IDENTITY_CHECK = 'every address in the log belongs to an actor this bus minted';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CTL = join(ROOT, 'scripts', 'gaia-interagent.mjs');
const GA_WATCH = join(ROOT, 'scripts', 'ga-watch.mjs');
const SERVER = join(ROOT, 'src', 'mcp-server.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-interagent-adv-'));
let counter = 0;
const freshDir = (name) => {
  const dir = join(SCRATCH, `${name}-${counter += 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function run(script, args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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

test.after(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

/** A minimal but genuine multi-party exchange, built with the real reducer's events. */
function realisticLog() {
  const at = (s) => new Date(Date.parse('2026-08-09T12:00:00.000Z') + s * 1000).toISOString();
  const actor = (n, name, kind) => ({
    type: 'actor.registered', at: at(n), ref: `act-000${n}`, name, isNew: true, kind,
    declaredCapabilities: [], busAuthority: ['send', 'receive', 'ack', 'heartbeat', 'handoff'],
  });
  const message = (n, from, to, kind, correlationId) => ({
    type: 'message.sent', at: at(10 + n),
    message: {
      messageId: `msg-000${n}`, correlationId, from, fromName: from, to, toName: to,
      replyTo: 'act-0001', replyToName: 'gaia', expectsReply: true, kind, text: `body ${n}`,
      trust: 'untrusted-text',
      authority: { granted: [], denied: [], effect: 'none', neverGrantable: [...NEVER_GRANTABLE] },
      flags: [], sentAt: at(10 + n), delivery: 'accepted-for-delivery; not read, not agreed, not completed',
      deliveredAt: null, ackedBy: null, ackedAt: null,
    },
  });
  return [
    actor(1, 'gaia', 'coordinator'),
    actor(2, 'claude-code', 'worker'),
    actor(3, 'codex', 'worker'),
    message(1, 'act-0001', 'act-0002', 'note', 'cor-real'),
    message(2, 'act-0002', 'act-0001', 'note', 'cor-real'),
    message(3, 'act-0002', 'act-0003', 'handoff', 'cor-real'),
    { type: 'message.acked', at: at(20), actorId: 'act-0002', messageId: 'msg-0001', note: null },
    {
      type: 'work.handed-off', at: at(21), from: 'act-0002', to: 'act-0003',
      messageId: 'msg-0003', correlationId: 'cor-real', replyTo: 'act-0001',
      summary: 'draft a fix', authorityTransferred: [],
    },
  ];
}

/**
 * The same exchange as `realisticLog`, except one message carries the correlation id
 * a pre-fix build would have accepted from a single `send`. The log replays perfectly
 * and every other check still passes — which is exactly why the evidence surface used
 * to certify it while the bus's auto-issuer was permanently dead.
 */
function poisonedLog() {
  return realisticLog().map((event) => (event.type === 'message.sent' && event.message.messageId === 'msg-0001'
    ? { ...event, message: { ...event.message, correlationId: `cor-${Number.MAX_SAFE_INTEGER - 1}` } }
    : event));
}

/**
 * The same exchange again, with one message's `from` rewritten to an address this bus
 * never minted. It replays perfectly, every richness check still passes, and `doctor`
 * condemns it — which is what made `verify` exiting 0 here a contradiction rather than
 * a difference of opinion between two commands with different jobs.
 */
function forgedAddressLog() {
  return realisticLog().map((event) => (event.type === 'message.sent' && event.message.messageId === 'msg-0001'
    ? { ...event, message: { ...event.message, from: 'constructor', fromName: 'forged' } }
    : event));
}

// ---------------------------------------------------------------------------
// the evidence checker discriminates
// ---------------------------------------------------------------------------

test('the evidence checker accepts a genuine multi-party exchange', () => {
  const report = evidenceReport(realisticLog());
  assert.equal(report.ok, true, report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; '));
});

test('negative control: a synthetic single-actor log is rejected', () => {
  const report = evidenceReport(syntheticNegativeLog());
  assert.equal(report.ok, false, 'a checker that passes this proves nothing about the real log');
  const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  assert.ok(failed.includes('at least three actors'));
  assert.ok(failed.includes('at least one handoff'));
});

test('negative control: a tampered handoff is rejected on the authority invariant', () => {
  const tampered = tamperedCopy(realisticLog());
  const report = evidenceReport(tampered);
  assert.equal(report.ok, false);
  const failed = report.checks.find((c) => c.name === 'no handoff transferred authority');
  assert.equal(failed.ok, false);
  assert.match(failed.detail, /approve/);
});

test('tampering happens in memory: the caller\'s events are untouched', () => {
  const original = realisticLog();
  const before = JSON.stringify(original);
  tamperedCopy(original);
  assert.equal(JSON.stringify(original), before, 'tamperedCopy is a copy, not a mutation');
});

test('a verification run is only ok when both the log passes AND the controls fail', () => {
  const good = evidenceWithNegativeControls(realisticLog());
  assert.equal(good.ok, true);
  assert.ok(good.controls.every((c) => c.ok), 'controls confirm the checker discriminates');

  const bad = evidenceWithNegativeControls(syntheticNegativeLog());
  assert.equal(bad.ok, false, 'a weak log cannot pass just because the controls did');
});

test('an empty log is not evidence of anything', () => {
  assert.equal(evidenceReport([]).ok, false);
});

// ---------------------------------------------------------------------------
// the lane policy refuses rather than truncates
// ---------------------------------------------------------------------------

test('the lane default is 4 and is not quietly raised by any input shape', () => {
  assert.equal(resolveLaneLimit({}).limit, DEFAULT_MAX_LIVE_LANES);
  assert.equal(resolveLaneLimit({ requested: null }).limit, 4);
  assert.equal(resolveLaneLimit({ requested: undefined }).limit, 4);
  assert.equal(resolveLaneLimit({ requested: 4 }).limit, 4);
  assert.equal(resolveLaneLimit({ requested: 1 }).limit, 1);
});

test('a limit above 4 throws rather than silently clamping to 4', () => {
  for (const n of [5, 6, 7, 8, 16]) {
    assert.throws(() => resolveLaneLimit({ requested: n }), LaneLimitError, `${n} is refused`);
  }
  // The discriminating assertion: an implementation that clamps would return 4 here
  // and the caller would believe it got what it asked for.
  let clamped = null;
  try { clamped = resolveLaneLimit({ requested: 8 }); } catch { /* expected */ }
  assert.equal(clamped, null, 'no value is returned at all for a refused limit');
});

test('the experimental flag is bounded by what has been measured', () => {
  assert.equal(resolveLaneLimit({ requested: 6, experimental: true }).limit, 6);
  assert.equal(resolveLaneLimit({ requested: 8, experimental: true }).limit, 8);
  assert.throws(() => resolveLaneLimit({ requested: 9, experimental: true }), LaneLimitError);
  assert.throws(() => resolveLaneLimit({ requested: 100, experimental: true }), LaneLimitError);
});

test('nonsense lane limits are refused, not coerced', () => {
  for (const bad of ['four', 0, -1, 2.5, NaN, {}, []]) {
    assert.throws(() => resolveLaneLimit({ requested: bad }), LaneLimitError, JSON.stringify(bad));
  }
});

test('admission refuses the lane past the limit and names the position', () => {
  assert.deepEqual(admitLane({ live: 3, limit: 4 }), { admitted: true, position: 4, limit: 4 });
  assert.throws(() => admitLane({ live: 4, limit: 4 }), LaneLimitError);
});

// ---------------------------------------------------------------------------
// ecosystem refusals are enforced, not documented
// ---------------------------------------------------------------------------

test('Hari integration is refused by code, not only by prose', () => {
  assert.throws(() => assertIntegrationAllowed('hari'), EcosystemRefusal);
  assert.throws(() => assertIntegrationAllowed('HARI'), EcosystemRefusal);
  assert.equal(ECOSYSTEM_VERDICTS.hari, 'REJECT');
});

test('IX integration is deferred by code', () => {
  assert.throws(() => assertIntegrationAllowed('ix'), EcosystemRefusal);
  assert.equal(ECOSYSTEM_VERDICTS.ix, 'DEFER');
});

test('GA and TARS are permitted as adapters only', () => {
  assert.equal(assertIntegrationAllowed('ga').verdict, 'ADAPTER_ONLY');
  assert.equal(assertIntegrationAllowed('tars').verdict, 'ADAPTER_ONLY');
  assert.throws(() => assertIntegrationAllowed('demerzel'), EcosystemRefusal, 'an unlisted repo is not silently allowed');
});

test('no shipped script contains a hari integration path', () => {
  for (const dir of ['src', 'scripts']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (!name.endsWith('.mjs')) continue;
      const text = readFileSync(join(ROOT, dir, name), 'utf8');
      assert.ok(!/hari-core|hari-mcp|hari_client/.test(text), `${dir}/${name} references no Hari binary or client`);
    }
  }
});

// ---------------------------------------------------------------------------
// Windows lock-release hardening
// ---------------------------------------------------------------------------

test('lock release carries a Windows retry budget without widening ownership', () => {
  assert.ok(LOCK_RELEASE_MAX_RETRIES > 0, 'retries are configured');
  assert.ok(LOCK_RELEASE_RETRY_DELAY_MS > 0);
  assert.equal(LOCK_RM_OPTIONS.maxRetries, LOCK_RELEASE_MAX_RETRIES);
  assert.equal(LOCK_RM_OPTIONS.retryDelay, LOCK_RELEASE_RETRY_DELAY_MS);
  assert.equal(LOCK_RM_OPTIONS.recursive, true);
  assert.equal(LOCK_RM_OPTIONS.force, true);

  // Ownership is unchanged: the ONLY rmSync of a lock is in withLock's finally, on
  // the lock this process just acquired. A retry budget cannot make it remove a lock
  // it does not own, and nothing else in the module removes a lock at all.
  const src = readFileSync(join(ROOT, 'src', 'event-log.mjs'), 'utf8');
  const lockRemovals = [...src.matchAll(/rmSync\(\s*lock\b/g)];
  assert.equal(lockRemovals.length, 1, 'exactly one place removes the lock directory');
  assert.match(src, /finally \{[\s\S]*?rmSync\(lock, LOCK_RM_OPTIONS\)/, 'and it is the holder\'s own finally');
});

test('a lock still round-trips cleanly under repeated acquire/release', () => {
  const dir = freshDir('lock-cycles');
  process.env.GAIA_INTERAGENT_DATA_DIR = dir;
  for (let i = 0; i < 60; i += 1) {
    withLock(() => appendEvents([{ type: 'actor.heartbeat', at: '2026-08-09T12:00:00.000Z', actorId: 'act-0001', note: null }]));
    assert.equal(existsSync(lockPath()), false, `released on cycle ${i}`);
  }
  assert.equal(readEvents().length, 60);
  delete process.env.GAIA_INTERAGENT_DATA_DIR;
});

// ---------------------------------------------------------------------------
// the GA watcher never writes GA
// ---------------------------------------------------------------------------

test('the GA watcher republishes read-only and leaves the GA file byte-identical', { timeout: 90_000 }, async () => {
  const dataDir = freshDir('ga-data');
  const gaDir = freshDir('ga-repo');
  const inbox = join(gaDir, 'inbox.jsonl');
  const body = [
    JSON.stringify({ severity: 'pain', rule: 'no-secret-in-log', tool: 'GaMcpServer' }),
    JSON.stringify({ severity: 'pleasure', rule: 'policy-pass', tool: 'GaMcpServer' }),
  ].join('\n') + '\n';
  writeFileSync(inbox, body, 'utf8');
  const beforeStat = statSync(inbox);

  await run(CTL, ['initialize', '--apply', '--data-dir', dataDir]);

  const dry = await run(GA_WATCH, ['--inbox', inbox, '--data-dir', dataDir]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(dry.json.mode, 'dry-run');
  assert.equal(dry.json.gaWritten, false);
  assert.equal(dry.json.wouldPublish, 2);
  assert.equal(readdirSync(gaDir).length, 1, 'the dry run created nothing beside GA');

  const applied = await run(GA_WATCH, ['--inbox', inbox, '--data-dir', dataDir, '--apply']);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(applied.json.published.length, 2);
  assert.deepEqual(applied.json.requestedAuthority, ['report']);

  assert.equal(readFileSync(inbox, 'utf8'), body, 'the GA file is byte-identical');
  assert.equal(statSync(inbox).size, beforeStat.size);
  assert.deepEqual(readdirSync(gaDir), ['inbox.jsonl'], 'no offset file, lock, or state was written beside GA');
  assert.ok(existsSync(join(dataDir, 'ga-watch-offsets.json')), 'the offset lives in OUR data directory');

  // The republished body carries `report` and nothing privileged.
  const state = replay(readEventsConsistentIn(dataDir));
  const signals = Object.values(state.messages).filter((m) => m.kind === 'ga-signal');
  assert.equal(signals.length, 2);
  for (const s of signals) {
    assert.deepEqual(s.authority.granted, ['report']);
    assert.deepEqual(s.authority.denied, []);
    assert.equal(s.trust, 'untrusted-text');
  }

  // A second run publishes nothing: the offset advanced.
  const again = await run(GA_WATCH, ['--inbox', inbox, '--data-dir', dataDir, '--apply']);
  assert.equal(again.json.newRecords, 0, 'the byte offset prevents republishing');
});

/** Read a log from an arbitrary data directory without disturbing the module default. */
function readEventsConsistentIn(dir) {
  const prior = process.env.GAIA_INTERAGENT_DATA_DIR;
  process.env.GAIA_INTERAGENT_DATA_DIR = dir;
  try {
    return readEvents();
  } finally {
    if (prior === undefined) delete process.env.GAIA_INTERAGENT_DATA_DIR;
    else process.env.GAIA_INTERAGENT_DATA_DIR = prior;
  }
}

test('the GA watcher refuses a rejected ecosystem target', { timeout: 30_000 }, async () => {
  const dataDir = freshDir('ga-refuse');
  const res = await run(GA_WATCH, ['--repo', 'hari', '--inbox', 'whatever', '--data-dir', dataDir]);
  assert.equal(res.code, 1);
  assert.match(res.stderr, /REFUSED/);
  assert.match(res.stderr, /REJECT/);
});

test('an unparseable GA record is reported and skipped, never rewritten', { timeout: 60_000 }, async () => {
  const dataDir = freshDir('ga-bad');
  const gaDir = freshDir('ga-bad-repo');
  const inbox = join(gaDir, 'inbox.jsonl');
  const body = `${JSON.stringify({ severity: 'pain' })}\nthis is not json\n`;
  writeFileSync(inbox, body, 'utf8');
  await run(CTL, ['initialize', '--apply', '--data-dir', dataDir]);

  const res = await run(GA_WATCH, ['--inbox', inbox, '--data-dir', dataDir]);
  assert.equal(res.code, 0);
  assert.equal(res.json.skippedUnparseable.length, 1);
  assert.equal(res.json.newRecords, 1);
  assert.equal(readFileSync(inbox, 'utf8'), body, 'GA was not repaired');
});

// ---------------------------------------------------------------------------
// the log records what it was given, and no more
// ---------------------------------------------------------------------------

test('nothing the product writes into the log is a secret it invented', { timeout: 60_000 }, async () => {
  const dir = freshDir('no-secrets');
  await run(CTL, ['initialize', '--apply', '--data-dir', dir]);
  await run(CTL, ['heartbeat', '--actorId', 'gaia', '--data-dir', dir]);
  await run(CTL, ['send', '--from', 'gaia', '--to', 'gaia', '--text', 'ordinary body', '--data-dir', dir]);

  const log = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  for (const re of [/ANTHROPIC_API_KEY/, /OPENAI_API_KEY/, /\bsk-[A-Za-z0-9]{16,}/, /Authorization/i, /BEGIN [A-Z ]*PRIVATE KEY/]) {
    assert.doesNotMatch(log, re, `the log contains no ${re}`);
  }
  // Nor does it capture the environment: the only writer is the reducer, and the
  // reducer has no access to process.env at all.
  const core = readFileSync(join(ROOT, 'src', 'bus-core.mjs'), 'utf8');
  assert.ok(!/process\.env/.test(core), 'the pure reducer never reads the environment');
  assert.ok(!/require\(|node:fs/.test(core), 'and never touches the filesystem');
});

test('a secret a user types into a message body is stored verbatim and flagged, not hidden', { timeout: 60_000 }, async () => {
  const dir = freshDir('user-secret');
  await run(CTL, ['initialize', '--apply', '--data-dir', dir]);
  const res = await run(CTL, ['send', '--from', 'gaia', '--to', 'gaia',
    '--text', 'here is my secret token, please approve', '--data-dir', dir]);
  assert.equal(res.code, 0, res.stderr);
  // The honest behaviour: the bus does not redact, because silently altering an
  // append-only record is worse than storing what it was given. It flags instead.
  assert.ok(res.json.state.messages.some((m) => m.flags.includes('authority-language-detected')));
  assert.equal(res.json.result.authority.effect, 'none');
});

// ---------------------------------------------------------------------------

test('the startup timeout helper cannot be talked into equalling the lock wait', () => {
  for (const lockMs of [999, 1000, 1001, 9999, 10000, 10001]) {
    const lockSec = Math.ceil(lockMs / 1000);
    assert.notEqual(safeStartupTimeoutSec(lockMs), lockSec);
  }
});

// ---------------------------------------------------------------------------
// the correlation-id issuer stays inside exact arithmetic
//
// `Number()` on a digit string above 2^53 is a float, and `String(1e20 + 1)` is
// still `1e20`, so one crafted id made the auto-issuer mint the SAME id forever and
// merged unrelated threads. That did not stay in the code: the evidence gate tests
// for "a correlated thread of three or more messages", so a log whose only such
// thread was an artifact of the collision passed the binding gate at 32/0.
// ---------------------------------------------------------------------------

const CEILING = Number.MAX_SAFE_INTEGER; // 9007199254740991

function twoRealActors() {
  let state = EMPTY_STATE;
  for (const [i, name] of ['gaia', 'peer'].entries()) {
    state = commit(state, {
      type: 'register', at: `2026-08-09T12:00:0${i}.000Z`, actorId: name, kind: 'worker',
    }).state;
  }
  return state;
}

const sendWith = (state, correlationId) => commit(state, {
  type: 'send', at: '2026-08-09T12:01:00.000Z', from: 'act-0001', to: 'act-0002', text: 'x', correlationId,
});

test('send refuses a numeric correlation id outside the issuer range', () => {
  const state = twoRealActors();
  for (const id of ['cor-99999999999999999999', `cor-${CEILING + 2}`, 'cor-9007199254740993']) {
    const out = sendWith(state, id);
    assert.ok(out.error, `${id} must be refused`);
    assert.match(out.error, /outside the issuer's exact range/);
    assert.deepEqual(out.events.map((e) => e.type), ['command.rejected']);
    assert.equal(Object.keys(out.state.messages).length, 0);
  }
});

test('handoff refuses the same out-of-range correlation id', () => {
  const state = twoRealActors();
  const out = commit(state, {
    type: 'handoff', at: '2026-08-09T12:01:00.000Z', from: 'act-0001', to: 'act-0002',
    summary: 's', correlationId: 'cor-99999999999999999999',
  });
  assert.ok(out.error);
  assert.match(out.error, /outside the issuer's exact range/);
  assert.equal(out.state.handoffs.length, 0);
});

/**
 * A state whose issuer has legitimately reached `n`.
 *
 * Claiming an ordinal near the ceiling is only inside the claim window when the
 * issuer is itself near the ceiling — which in the real world happens by replaying a
 * long-lived log. Setting the counter directly reaches the identical state without
 * minting 9×10^15 messages, and is what the `at the ceiling` test below already does.
 */
const issuerAt = (state, n) => ({ ...state, counters: { ...state.counters, correlation: n } });

test('the correlation boundary is exactly the safe-integer ceiling', () => {
  const state = issuerAt(twoRealActors(), CEILING - 2);
  // 2^53 + 1 and the ceiling itself are refused; the ceiling is refused because the
  // NEXT mint is ordinal + 1 and that addition must still be exact.
  assert.ok(sendWith(state, 'cor-9007199254740993').error, '2^53+1 is refused');
  assert.ok(sendWith(state, `cor-${CEILING}`).error, 'the ceiling itself is refused');

  const below = sendWith(state, `cor-${CEILING - 1}`);
  assert.equal(below.error, null, `ceiling-1 is accepted: ${below.error}`);
  assert.equal(below.state.counters.correlation, CEILING - 1, 'the high-water mark is exact');

  const next = commit(below.state, {
    type: 'send', at: '2026-08-09T12:02:00.000Z', from: 'act-0001', to: 'act-0002', text: 'y',
  });
  assert.equal(next.result.correlationId, `cor-${CEILING}`, 'the next auto id is exactly one higher');
});

test('at the ceiling the issuer refuses to mint rather than re-issuing an id', () => {
  const state = twoRealActors();
  const atCeiling = {
    ...state,
    counters: { ...state.counters, correlation: CEILING },
  };
  const out = commit(atCeiling, {
    type: 'send', at: '2026-08-09T12:03:00.000Z', from: 'act-0001', to: 'act-0002', text: 'z',
  });
  assert.ok(out.error, 'minting past the ceiling is refused');
  assert.match(out.error, /exhausted/);
  // A named thread is still a way through, so the bus is not bricked.
  const named = commit(atCeiling, {
    type: 'send', at: '2026-08-09T12:03:01.000Z', from: 'act-0001', to: 'act-0002', text: 'z',
    correlationId: 'cor-manual-thread',
  });
  assert.equal(named.error, null, named.error);
});

test('the auto-issuer never mints the same correlation id twice after a boundary claim', () => {
  let state = issuerAt(twoRealActors(), CEILING - 5);
  state = sendWith(state, `cor-${CEILING - 3}`).state;
  const issued = [];
  for (let i = 0; i < 3; i += 1) {
    const out = commit(state, {
      type: 'send', at: `2026-08-09T12:0${4 + i}:00.000Z`, from: 'act-0001', to: 'act-0002', text: 'q',
    });
    assert.equal(out.error, null, out.error);
    issued.push(out.result.correlationId);
    state = out.state;
  }
  assert.equal(new Set(issued).size, issued.length, `ids collided: ${issued.join(', ')}`);
});

// ---------------------------------------------------------------------------
// one send must not exhaust the issuer for the whole data directory
//
// `correlationIdError` bounded a caller-supplied ordinal against the TYPE ceiling
// only. The high-water rule then adopted whatever the caller named, so a single
// ordinary `send` carrying `cor-9007199254740990` — an argument the schema documents
// as "groups a family of related messages" — advanced the issuer to one below the
// ceiling. Every later `send` and `handoff` that omitted `correlationId` was refused,
// forever, for that directory; the log is append-only, so the only remedy was
// abandoning it. Both health commands certified the result as healthy.
//
// The claim window below is what keeps the legitimate case working: a caller joining
// a real thread always names an ordinal at or just ahead of the issuer.
// ---------------------------------------------------------------------------

test('one send cannot exhaust the correlation issuer for a data directory', () => {
  const state = twoRealActors();
  const poison = sendWith(state, `cor-${CEILING - 1}`);

  assert.ok(poison.error, 'a claim that far ahead of the issuer is refused');
  assert.match(poison.error, /ahead of the issuer/);
  assert.deepEqual(poison.events.map((e) => e.type), ['command.rejected'], 'the attempt is still recorded');
  assert.equal(Object.keys(poison.state.messages).length, 0, 'no message was committed');
  assert.equal(poison.state.counters.correlation, state.counters.correlation, 'the issuer did not move');

  // The property that actually matters: ordinary traffic still works afterwards.
  let after = poison.state;
  const issued = [];
  for (let i = 0; i < 4; i += 1) {
    const out = commit(after, {
      type: 'send', at: `2026-08-09T12:1${i}:00.000Z`, from: 'act-0001', to: 'act-0002', text: `ordinary ${i}`,
    });
    assert.equal(out.error, null, `send ${i} after the refused claim: ${out.error}`);
    issued.push(out.result.correlationId);
    after = out.state;
  }
  assert.deepEqual(issued, ['cor-0001', 'cor-0002', 'cor-0003', 'cor-0004']);
  assert.equal(after.counters.correlation, 4);
});

test('handoff cannot exhaust the correlation issuer either', () => {
  const state = twoRealActors();
  const out = commit(state, {
    type: 'handoff', at: '2026-08-09T12:01:00.000Z', from: 'act-0001', to: 'act-0002',
    summary: 's', correlationId: `cor-${CEILING - 1}`,
  });
  assert.ok(out.error);
  assert.match(out.error, /ahead of the issuer/);
  assert.equal(out.state.handoffs.length, 0);
  assert.equal(out.state.counters.correlation, 0, 'the issuer did not move');
});

test('the claim window is exact, and its two sides behave differently', () => {
  const state = twoRealActors(); // issuer at 0
  const inside = sendWith(state, `cor-${CORRELATION_CLAIM_SLACK}`);
  assert.equal(inside.error, null, `the last ordinal inside the window is accepted: ${inside.error}`);
  assert.equal(inside.state.counters.correlation, CORRELATION_CLAIM_SLACK, 'and is adopted as the high-water mark');

  const outside = sendWith(state, `cor-${CORRELATION_CLAIM_SLACK + 1}`);
  assert.ok(outside.error, 'one past the window is refused');
  assert.match(outside.error, /ahead of the issuer/);
  assert.match(outside.error, /non-numeric thread name/, 'the refusal names the way through');
});

test('NEGATIVE CONTROL: joining a thread, naming a fresh ordinal, and naming a thread all still work', () => {
  // The fix must bound the claim, not remove it. Everything a legitimate caller does
  // is unchanged: the ported B2 suite covers the same ground against the real reducer.
  let state = twoRealActors();
  const first = commit(state, { type: 'send', at: '2026-08-09T12:20:00.000Z', from: 'act-0001', to: 'act-0002', text: 'a' });
  assert.equal(first.result.correlationId, 'cor-0001');
  state = first.state;

  const joined = sendWith(state, 'cor-0001');
  assert.equal(joined.error, null, `joining the live thread: ${joined.error}`);
  assert.equal(joined.state.counters.correlation, 1, 'joining does not advance the issuer');

  const ahead = sendWith(state, 'cor-0004');
  assert.equal(ahead.error, null, `a modest claim ahead of the issuer: ${ahead.error}`);
  assert.equal(ahead.state.counters.correlation, 4, 'and is still adopted, so it is never re-minted');

  const named = sendWith(state, 'cor-live-smoke');
  assert.equal(named.error, null, named.error);
  assert.equal(named.state.counters.correlation, 1, 'a non-numeric name claims nothing');
});

test('an already-exhausted issuer stays fail-closed and is reported, not certified', () => {
  // A directory a pre-fix build poisoned cannot be repaired — the log is append-only.
  // What must hold is that the bus refuses rather than colliding, and that the health
  // surfaces say so instead of reporting a clean bill.
  const state = twoRealActors();
  const dead = issuerAt(state, CEILING);

  const auto = commit(dead, { type: 'send', at: '2026-08-09T12:30:00.000Z', from: 'act-0001', to: 'act-0002', text: 'x' });
  assert.ok(auto.error, 'the issuer refuses rather than re-minting');
  assert.match(auto.error, /exhausted/);

  const health = correlationHealthReport(dead);
  assert.equal(health.exhausted, true);
  assert.equal(health.ok, false, 'the health report does not certify a dead issuer');
  assert.equal(health.issuerAt, CEILING);

  // A named thread is still a way through, so the bus is not bricked.
  const named = commit(dead, {
    type: 'send', at: '2026-08-09T12:30:01.000Z', from: 'act-0001', to: 'act-0002', text: 'x',
    correlationId: 'cor-manual-thread',
  });
  assert.equal(named.error, null, named.error);
});

test('evidence reporting fails a log whose issuer a poisoned claim already burned out', () => {
  const poisoned = poisonedLog();
  const report = evidenceReport(poisoned);
  const reach = report.checks.find((c) => c.name === CORRELATION_CHECK);
  assert.ok(reach, `the check exists: ${report.checks.map((c) => c.name).join('; ')}`);
  assert.equal(reach.ok, false, 'a poisoned log is reported, not certified');
  assert.match(reach.detail, /msg-0001/);
  assert.equal(report.ok, false, 'and the whole evidence report fails with it');
});

test('doctor and verify both report a poisoned directory instead of certifying it', { timeout: 60_000 }, async () => {
  const dir = freshDir('correlation-poison');
  writeFileSync(join(dir, 'events.jsonl'),
    poisonedLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');

  const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
  assert.equal(doctor.code, 1, `doctor must not certify this directory: ${doctor.stdout}`);
  assert.equal(doctor.json.replayable, true, 'the log is not corrupt — that is the whole point');
  assert.equal(doctor.json.ok, false);
  assert.equal(doctor.json.correlationFindings.length, 1);
  assert.match(doctor.json.error, /runway|exhausted/);
  assert.match(doctor.json.error, /NEW data directory/, 'and the remedy it names is the one that applies');

  const verify = await run(CTL, ['verify', '--data-dir', dir]);
  const reach = verify.json.evidence?.positive?.checks?.find((c) => c.name === CORRELATION_CHECK);
  assert.ok(reach, `verify carries the check: ${JSON.stringify(verify.json.evidence?.positive?.checks?.map((c) => c.name))}`);
  assert.equal(reach.ok, false, 'verify reports the poison rather than reporting "all within range"');

  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'neither command repaired anything');
});

// ---------------------------------------------------------------------------
// `verify`'s exit status agrees with its own embedded check  (R6-F02 / R5-F03)
//
// The previous repair made the correlation-health check truthful and load-bearing.
// That is what exposed this: `verify` carried a red check saying the issuer was dead
// and still exited 0 with `ok:true`, because every evidence check was advisory unless
// the caller passed `--evidence`. A CI reader keys on the exit code and on `ok` — the
// product says so itself, in the `proves` string it ships — so the one surface that
// reports the defect was the one surface that hid it.
//
// The correlation-health check is not an evidence-richness question. "Is this a real
// multi-party exchange" is legitimately false on a fresh workspace and must stay
// advisory there; "can this directory's bus still mint an id" is a defect on every
// run, and a fresh workspace passes it with the whole sequence ahead of it. So that
// one check gates always, and the controls below pin that nothing else moved with it.
// ---------------------------------------------------------------------------

test('verify fails closed on a directory whose issuer is dead, agreeing with its own check', { timeout: 60_000 }, async () => {
  const dir = freshDir('correlation-verify-gate');
  writeFileSync(join(dir, 'events.jsonl'),
    poisonedLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');

  const verify = await run(CTL, ['verify', '--data-dir', dir]);
  const reach = verify.json?.evidence?.positive?.checks?.find((c) => c.name === CORRELATION_CHECK);
  assert.ok(reach, `verify carries the check: ${JSON.stringify(verify.json?.evidence?.positive?.checks?.map((c) => c.name))}`);
  assert.equal(reach.ok, false, 'the embedded check reports the dead issuer');
  assert.equal(verify.json.ok, false, 'and the field a CI reader keys on says the same thing');
  assert.equal(verify.code, 1, `and so does the exit status: got ${verify.code}: ${verify.stdout}${verify.stderr}`);

  const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
  assert.equal(doctor.code, verify.code, 'the two health commands no longer disagree about the same directory');

  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'and verify still wrote nothing');
});

test('verify fails closed on a log carrying an address this bus never minted, agreeing with doctor', { timeout: 60_000 }, async () => {
  // The same defect shape as the dead issuer, on the sibling check. `doctor` already
  // condemns this directory — it is one of the two conditions the README's own
  // exit-code section lists for `doctor` exit 1 — while `verify` exited 0 with
  // `ok:true` and displayed its own red check saying the log carried a forged address.
  //
  // It meets the criterion the repair itself set for what must gate: it is a defect on
  // every run rather than an evidence-richness question, and a fresh workspace passes
  // it vacuously with nothing forged in it. The controls below pin that second half.
  const dir = freshDir('identity-verify-gate');
  writeFileSync(join(dir, 'events.jsonl'),
    forgedAddressLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');

  const verify = await run(CTL, ['verify', '--data-dir', dir]);
  const minted = verify.json?.evidence?.positive?.checks?.find((c) => c.name === IDENTITY_CHECK);
  assert.ok(minted, `verify carries the check: ${JSON.stringify(verify.json?.evidence?.positive?.checks?.map((c) => c.name))}`);
  assert.equal(minted.ok, false, 'the embedded check reports the unminted address');
  assert.match(minted.detail, /constructor/, 'and names it');
  assert.equal(verify.json.ok, false, 'and the field a CI reader keys on says the same thing');
  assert.equal(verify.code, 1, `and so does the exit status: got ${verify.code}: ${verify.stdout}${verify.stderr}`);

  const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
  assert.equal(doctor.code, 1, `doctor condemns this directory: ${doctor.stdout}${doctor.stderr}`);
  assert.equal(doctor.json.replayable, true, 'the log is not corrupt — that is the whole point');
  assert.equal(doctor.code, verify.code, 'the two health commands no longer disagree about the same directory');

  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'and neither command wrote a byte');
});

test('every name verify gates on is a name some check actually emits', () => {
  // The failure mode that selecting checks BY NAME creates: a name that no shipped check
  // ever produces gates on nothing. The code substitutes a FAILING check for an absent
  // name rather than dropping it, so a drift fails closed — but the cheaper guarantee is
  // that the names are right in the first place, and that is what this pins, at the
  // source, against the checks a healthy log actually emits.
  const emitted = new Set(evidenceReport(realisticLog()).checks.map((c) => c.name));
  for (const name of ALWAYS_GATING_CHECKS) {
    assert.ok(emitted.has(name),
      `verify gates on "${name}", which no check emits: ${[...emitted].join(' | ')}`);
  }
  // Compared against the LOCAL literals the rest of this file asserts on, not against
  // the module's own constants — comparing an export to itself would prove nothing.
  assert.deepEqual([...ALWAYS_GATING_CHECKS].sort(), [CORRELATION_CHECK, IDENTITY_CHECK].sort(),
    'and the gating set is those two defect checks, not the evidence-richness ones');
});

test('verify does not certify a directory whose log parses but cannot be replayed', { timeout: 60_000 }, async () => {
  // The log that reaches the absent-name branch without any rename: valid JSON, so it is
  // read; unreplayable, so the evidence report is the single `replayable` check and
  // NEITHER gating check exists to be found.
  //
  // What this gate pins is the OUTCOME, and it says so rather than claiming more. It does
  // NOT isolate the fail-closed substitution: measured, a directory the bus cannot replay
  // also fails `the bundled server answered tools/list`, because the server refuses to
  // start on it and that check always gated. Replacing the substitution with one that
  // gates on the empty set therefore changes no exit code here — a mutant that survives,
  // reported in the handoff rather than smoothed. The substitution is defence in depth
  // whose sole-cause reachability could not be constructed; the rename direction is what
  // the gate above pins.
  const dir = freshDir('verify-unreplayable-log');
  writeFileSync(join(dir, 'events.jsonl'), [
    JSON.stringify({
      type: 'actor.registered', at: '2026-01-01T00:00:00.000Z', ref: 'act-0001', name: 'gaia',
      isNew: true, kind: 'coordinator', declaredCapabilities: [],
      busAuthority: ['send', 'receive', 'ack', 'heartbeat', 'handoff'],
    }),
    JSON.stringify({ type: 'message.sent', at: '2026-01-01T00:00:01.000Z' }),
  ].join('\n') + '\n', 'utf8');
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');

  const verify = await run(CTL, ['verify', '--data-dir', dir]);
  const checks = verify.json?.evidence?.positive?.checks ?? [];
  const replayable = checks.find((c) => c.name === 'replayable');
  assert.ok(replayable, `the report is the replay failure alone: ${JSON.stringify(checks.map((c) => c.name))}`);
  assert.equal(replayable.ok, false, 'the log genuinely does not replay');
  for (const name of [CORRELATION_CHECK, IDENTITY_CHECK]) {
    assert.equal(checks.find((c) => c.name === name), undefined,
      `"${name}" is genuinely absent here, which is the condition under test`);
  }
  assert.equal(verify.json.ok, false, 'and verify does not certify a directory it could not examine');
  assert.equal(verify.code, 1, `it fails closed on such a directory: got ${verify.code}: ${verify.stdout}${verify.stderr}`);

  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), before, 'and it wrote nothing');
});

test('NEGATIVE CONTROL: verify still passes a fresh workspace and an evidence-poor one', { timeout: 60_000 }, async () => {
  // The property this control protects: an empty bus is a CORRECT empty bus. Gating
  // every evidence check on every run would report a fresh workspace as a product
  // failure and train an operator to ignore the command — which is the reason the
  // evidence checks are advisory in the first place. Only the health check moved.
  const fresh = freshDir('verify-fresh');
  const empty = await run(CTL, ['verify', '--data-dir', fresh]);
  assert.equal(empty.code, 0, `a fresh workspace verifies: ${empty.stdout}${empty.stderr}`);
  assert.equal(empty.json.ok, true);

  const thin = freshDir('verify-thin');
  writeFileSync(join(thin, 'events.jsonl'),
    syntheticNegativeLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const poor = await run(CTL, ['verify', '--data-dir', thin]);
  assert.equal(poor.code, 0, `a one-actor log is thin evidence, not a dead bus: ${poor.stdout}${poor.stderr}`);
  assert.equal(poor.json.ok, true, 'evidence richness stays advisory when the caller claimed no evidence');
  assert.equal(poor.json.evidenceOk, false, 'while still reporting that the log is not evidence');

  const health = poor.json.evidence.positive.checks.find((c) => c.name === CORRELATION_CHECK);
  assert.equal(health.ok, true, 'a fresh issuer has the whole sequence ahead of it');

  // The same control for the identity check, which now gates alongside it. Promoting a
  // check is only safe while a correct empty bus still passes it — otherwise the
  // command starts crying wolf and an operator learns to ignore it.
  for (const [label, res] of [['a fresh workspace', empty], ['a one-actor log', poor]]) {
    const minted = res.json.evidence.positive.checks.find((c) => c.name === IDENTITY_CHECK);
    assert.ok(minted, `${label} carries the identity check`);
    assert.equal(minted.ok, true, `${label} has nothing forged in it: ${minted.detail}`);
  }
});

test('claiming a dead-issuer log IS evidence fails, and so does claiming a thin one', { timeout: 60_000 }, async () => {
  // The other direction of the same contract: `--evidence` is a claim that the file
  // IS evidence, so every positive check gates. This is what stops the fix above from
  // being read as "only the health check can ever fail verify".
  const dir = freshDir('verify-claimed');
  const poisoned = join(dir, 'poisoned.jsonl');
  const thin = join(dir, 'thin.jsonl');
  writeFileSync(poisoned, poisonedLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  writeFileSync(thin, syntheticNegativeLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const claimedDead = await run(CTL, ['verify', '--data-dir', dir, '--evidence', poisoned]);
  assert.equal(claimedDead.code, 1, `a dead-issuer log claimed as evidence fails: ${claimedDead.stdout}`);

  const claimedThin = await run(CTL, ['verify', '--data-dir', dir, '--evidence', thin]);
  assert.equal(claimedThin.code, 1, `a one-actor log claimed as evidence fails: ${claimedThin.stdout}`);
  assert.equal(claimedThin.json.evidenceGatesResult, true, 'because the caller claimed it');
});

test('NEGATIVE CONTROL: an ordinary directory is still healthy in doctor and verify', { timeout: 60_000 }, async () => {
  const dir = freshDir('correlation-clean');
  writeFileSync(join(dir, 'events.jsonl'),
    realisticLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
  assert.equal(doctor.code, 0, `an ordinary log stays healthy: ${doctor.stdout}${doctor.stderr}`);
  assert.equal(doctor.json.ok, true);
  assert.equal(doctor.json.correlationExhausted, false);
  assert.deepEqual(doctor.json.correlationFindings, []);
});

test('NEGATIVE CONTROL: the health check passes on an ordinary log and on a named thread', () => {
  const clean = evidenceReport(realisticLog());
  const reach = clean.checks.find((c) => c.name === CORRELATION_CHECK);
  assert.equal(reach.ok, true, `an ordinary log must not trip the new check: ${reach.detail}`);
  assert.equal(clean.ok, true, `the realistic log still passes every check: ${clean.checks.filter((c) => !c.ok).map((c) => c.name).join('; ')}`);
});

test('a non-numeric thread name claims nothing and stays inert', () => {
  let state = twoRealActors();
  const out = sendWith(state, 'cor-live-smoke');
  assert.equal(out.error, null, out.error);
  assert.equal(out.state.counters.correlation, 0, 'a named thread advances no counter');
  state = out.state;
  const next = commit(state, {
    type: 'send', at: '2026-08-09T12:05:00.000Z', from: 'act-0001', to: 'act-0002', text: 'n',
  });
  assert.equal(next.result.correlationId, 'cor-0001');
});

// ---------------------------------------------------------------------------
// correlation HEALTH is measured on the same basis as correlation ADMISSION
//
// The first repair bounded admission against the issuer (which ratchets) but
// measured health against `messages.length` (which does not). Every claim the bus
// itself accepted at the window edge therefore outran the health basis, so a caller
// using only accepted operations drove its own directory into a permanently failing
// `doctor` — permanently, because the log is append-only — while the stated reason
// ("the auto-issuer is dead or one send from it") was false: auto-issue still worked
// and the issuer sat nine orders of magnitude from the ceiling.
//
// Health is now a statement about the issuer's REMAINING RUNWAY to the type ceiling,
// which is the quantity the original defect actually destroyed. The tests below pin
// both sides of that boundary and keep genuine exhaustion failing closed.
// ---------------------------------------------------------------------------

/** Drive the issuer with claims the bus itself accepts, one window at a time. */
function walkIssuer(state, windows) {
  let at = state;
  for (let i = 0; i < windows; i += 1) {
    const out = commit(at, {
      type: 'send', at: `2026-08-09T13:0${i}:00.000Z`, from: 'act-0001', to: 'act-0002', text: `w${i}`,
      correlationId: `cor-${CORRELATION_CLAIM_SLACK * (i + 1)}`,
    });
    assert.equal(out.error, null, `window claim ${i} must be accepted by admission: ${out.error}`);
    at = out.state;
  }
  return at;
}

test('claims the bus accepted never become a health finding against the same log', () => {
  // Three at-window claims, each accepted with ok:true. Under the messages.length
  // basis the second and third were reported as "beyond the issuer's reach" — on a
  // directory whose issuer was at 3,000,002 of 9,007,199,254,740,991.
  const walked = walkIssuer(twoRealActors(), 3);
  assert.equal(walked.counters.correlation, CORRELATION_CLAIM_SLACK * 3, 'the issuer ratcheted as admission intends');

  const health = correlationHealthReport(walked);
  assert.deepEqual(health.findings, [], 'nothing the bus accepted is condemned afterwards');
  assert.equal(health.exhausted, false);
  assert.equal(health.nearExhausted, false);
  assert.equal(health.ok, true, 'a directory built only from accepted operations stays healthy');
  assert.equal(health.headroom, CEILING - CORRELATION_CLAIM_SLACK * 3, 'and the runway it reports is the true one');
});

test('the health boundary is exact, and its two sides behave differently', () => {
  const base = twoRealActors();

  const floor = correlationHealthReport(issuerAt(base, CORRELATION_HEADROOM_FLOOR));
  assert.equal(floor.headroom, CORRELATION_CLAIM_SLACK, 'exactly one claim window of runway left');
  assert.equal(floor.nearExhausted, true, 'one window of runway is the last window');
  assert.equal(floor.ok, false);

  const above = correlationHealthReport(issuerAt(base, CORRELATION_HEADROOM_FLOOR - 1));
  assert.equal(above.headroom, CORRELATION_CLAIM_SLACK + 1);
  assert.equal(above.nearExhausted, false, 'one below the floor is still healthy');
  assert.equal(above.ok, true);

  assert.equal(CORRELATION_HEADROOM_FLOOR, CEILING - CORRELATION_CLAIM_SLACK,
    'the floor is derived from the admission window, not chosen separately');
});

test('genuine exhaustion and near-exhaustion both fail closed, and say which they are', () => {
  const base = twoRealActors();

  const dead = correlationHealthReport(issuerAt(base, CEILING));
  assert.equal(dead.exhausted, true);
  assert.equal(dead.nearExhausted, true, 'exhausted implies the runway is gone');
  assert.equal(dead.headroom, 0);
  assert.equal(dead.ok, false, 'a dead issuer is never certified');

  const oneLeft = correlationHealthReport(issuerAt(base, CEILING - 1));
  assert.equal(oneLeft.exhausted, false, 'one auto-issue remains, so this is not yet exhaustion');
  assert.equal(oneLeft.nearExhausted, true);
  assert.equal(oneLeft.headroom, 1, 'and the report says exactly how much runway is left');
  assert.equal(oneLeft.ok, false);
});

test('doctor stays green on a directory built only from operations it accepted', { timeout: 60_000 }, async () => {
  // The reproduction from the review, end to end through the real CLI: three sends
  // the bus answered ok:true, then a doctor that used to exit 1 forever.
  // Every event below is one the real reducer produced from a command it ACCEPTED —
  // no hand-forged record, which is the whole point of the finding.
  const dir = freshDir('correlation-accepted');
  let state = EMPTY_STATE;
  const events = [];
  for (const [i, name] of ['gaia', 'peer'].entries()) {
    const out = commit(state, { type: 'register', at: `2026-08-09T14:00:0${i}.000Z`, actorId: name, kind: 'worker' });
    assert.equal(out.error, null, out.error);
    events.push(...out.events);
    state = out.state;
  }
  for (const [i, ordinal] of [1_000_000, 2_000_000, 3_000_000].entries()) {
    const out = commit(state, {
      type: 'send', at: `2026-08-09T14:0${i + 1}:00.000Z`, from: 'act-0001', to: 'act-0002', text: 'x',
      correlationId: `cor-${ordinal}`,
    });
    assert.equal(out.error, null, `the bus accepted cor-${ordinal}: ${out.error}`);
    events.push(...out.events);
    state = out.state;
  }
  writeFileSync(join(dir, 'events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');

  const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
  assert.equal(doctor.code, 0, `accepted claims must not condemn the directory: ${doctor.stdout}${doctor.stderr}`);
  assert.equal(doctor.json.ok, true);
  assert.deepEqual(doctor.json.correlationFindings, []);
  assert.equal(doctor.json.correlationExhausted, false);
  assert.equal(doctor.json.correlationIssuerAt, 3_000_000);
  assert.equal(doctor.json.correlationHeadroom, CEILING - 3_000_000, 'and it reports the true remaining runway');

  // And the reason the old message gave is testably false: auto-issue still works.
  const auto = await run(CTL, ['send', '--data-dir', dir, '--from', 'gaia', '--to', 'peer', '--text', 'y']);
  assert.equal(auto.code, 0, `auto-issue is alive: ${auto.stdout}${auto.stderr}`);
  assert.equal(auto.json.result.correlationId, 'cor-3000001');
});

test('verify carries the correlation-health check in the proves string it ships', () => {
  const proved = evidenceWithNegativeControls(realisticLog()).proves;
  assert.match(proved, /issuer range/, 'the range claim it already made stays');
  assert.match(proved, /runway|room to mint|headroom/i,
    'a CI reader keying on evidenceOk never opens the README: the payload must name the check too');
});

test('README documents the doctor exit code for a correlation-health verdict', () => {
  // Documented where the operator looks, not only in a handoff: the exit-code table
  // must admit lifecycle verdicts, and a section must say which condition trips one.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');

  const tableRow = readme.split('\n').find((l) => /^\| 1 \|/.test(l));
  assert.ok(tableRow, 'the exit-code table still has a row for 1');
  assert.match(tableRow, /health|lifecycle/i,
    'the gloss for 1 covers a lifecycle health verdict, not only address refusals');

  const section = readme.split(/^### /m).find((s) => /^`doctor` exits 1/.test(s));
  assert.ok(section, `a doctor exit-code section exists: ${readme.split(/^### /m).map((s) => s.split('\n')[0]).join(' | ')}`);
  assert.match(section, /correlation/i, 'and it names the correlation condition');
  assert.match(section, /runway|headroom/i, 'on the quantity the product actually measures');
  assert.match(section, /new data directory/i, 'with the remedy that applies');
});

test('README documents which verify checks gate its exit code and which do not', { timeout: 120_000 }, async () => {
  // The exit contract is the thing a CI reader depends on, and this section makes a
  // falsifiable claim about it: `verify` exits 1 on exactly the directories `doctor`
  // exits 1 on. The previous version of this gate matched `/always/i`, `/advisory/i`,
  // `/doctor/` — all of which matched prose that was false, because one of the two
  // documented conditions did not gate `verify` at all. Matching a word is not evidence
  // of a behaviour, so this gate now MAKES BOTH COMMANDS ANSWER for every condition the
  // section lists, plus a control in the other direction.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const section = readme.split(/^### /m).find((s) => /^`verify` exits 1/.test(s));
  assert.ok(section, `a verify exit-code section exists: ${readme.split(/^### /m).map((s) => s.split('\n')[0]).join(' | ')}`);
  assert.match(section, /advisory/i, 'evidence richness is still named as the non-gating class');
  assert.match(section, /--evidence|--require-evidence/, 'and the flag that changes the regime is named');
  assert.match(section, /doctor/, 'and the agreement with doctor is claimed');

  // Each condition the DOCTOR section lists as making `doctor` exit 1, with the log that
  // exhibits it. If a condition is ever added to that list without a gating check behind
  // it, the presence assertion below fails and this gate goes red rather than the README
  // quietly becoming false again.
  const doctorSection = readme.split(/^### /m).find((s) => /^`doctor` exits 1/.test(s));
  assert.ok(doctorSection, 'the doctor exit-code section exists');
  const documented = [
    { id: 'an address this bus never minted', doc: /address this bus never minted/i, log: forgedAddressLog },
    { id: 'a correlation issuer with no runway left', doc: /correlation issuer/i, log: poisonedLog },
  ];
  for (const cond of documented) {
    assert.match(doctorSection, cond.doc, `the doctor section lists "${cond.id}"`);
  }
  const listed = doctorSection.split('\n').filter((l) => /^- /.test(l)).length;
  assert.equal(listed, documented.length,
    `every condition the doctor section lists is driven below; it lists ${listed} and this gate drives ${documented.length}`);

  for (const cond of documented) {
    const dir = freshDir(`readme-exit-contract-${documented.indexOf(cond)}`);
    writeFileSync(join(dir, 'events.jsonl'), cond.log().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
    const verify = await run(CTL, ['verify', '--data-dir', dir]);
    assert.equal(doctor.code, 1, `doctor exits 1 on "${cond.id}", as the README says: ${doctor.stdout}${doctor.stderr}`);
    assert.equal(verify.code, 1, `and so does verify, as the README says: ${verify.stdout}${verify.stderr}`);
    assert.equal(verify.json.ok, false, `with ok:false on "${cond.id}"`);
  }

  // "Exactly the directories" runs in the other direction too: a healthy directory and a
  // correct empty one must still pass BOTH commands, or the claim is bought by making
  // `verify` fail everywhere.
  const clean = freshDir('readme-exit-contract-clean');
  writeFileSync(join(clean, 'events.jsonl'), realisticLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  for (const [label, dir] of [['an ordinary log', clean], ['a fresh workspace', freshDir('readme-exit-contract-fresh')]]) {
    const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
    const verify = await run(CTL, ['verify', '--data-dir', dir]);
    assert.equal(doctor.code, 0, `doctor passes ${label}: ${doctor.stdout}${doctor.stderr}`);
    assert.equal(verify.code, 0, `and verify passes ${label} too: ${verify.stdout}${verify.stderr}`);
  }
});

test('an id outside the cor- namespace is not constrained at all', () => {
  const state = twoRealActors();
  for (const id of ['thread-99999999999999999999', 'cor_1e30', 'x-1', 'correlation-12345678901234567890']) {
    const out = sendWith(state, id);
    assert.equal(out.error, null, `${id} must not be refused: ${out.error}`);
  }
});

test('a log poisoned by the old build replays to a usable exact counter', () => {
  // No migration, no rewrite of an append-only file: an ordinal the issuer could
  // never have emitted is simply ignored by the high-water mark.
  const poisoned = [
    ...realisticLog(),
    {
      type: 'message.sent', at: '2026-08-09T12:10:00.000Z',
      message: {
        messageId: 'msg-0009', correlationId: 'cor-99999999999999999999', from: 'act-0001',
        fromName: 'gaia', to: 'act-0002', toName: 'claude-code', replyTo: 'act-0001',
        replyToName: 'gaia', expectsReply: false, kind: 'note', text: 'poison',
        trust: 'untrusted-text',
        authority: { granted: [], denied: [], effect: 'none', neverGrantable: [...NEVER_GRANTABLE] },
        flags: [], sentAt: '2026-08-09T12:10:00.000Z',
        delivery: 'accepted-for-delivery; not read, not agreed, not completed',
        deliveredAt: null, ackedBy: null, ackedAt: null,
      },
    },
  ];
  const state = replay(poisoned);
  assert.ok(Number.isSafeInteger(state.counters.correlation), 'the counter is exact again');
  assert.equal(state.counters.correlation, 0, 'the unreachable ordinal claims nothing');
});

test('the evidence gate rejects a thread manufactured by a correlation collision', () => {
  const collided = realisticLog().map((e) => (e.type === 'message.sent'
    ? { ...e, message: { ...e.message, correlationId: 'cor-100000000000000000000' } }
    : e));
  const report = evidenceReport(collided);
  assert.equal(report.ok, false, 'a collision-forged thread must not satisfy the gate');
  const grammar = report.checks.find((c) => c.name === 'every correlation id is inside the issuer range');
  assert.equal(grammar.ok, false);
});

// ---------------------------------------------------------------------------
// the evidence gate can see the authority field it advertises as its invariant
// ---------------------------------------------------------------------------

test('a widened busAuthority on a registration is rejected', () => {
  const tampered = busAuthorityTamperedCopy(realisticLog());
  const report = evidenceReport(tampered);
  assert.equal(report.ok, false, 'a log claiming approve/admin/deploy must not pass 10/10');
  const c = report.checks.find((x) => x.name === 'every actor.registered carries the frozen busAuthority');
  assert.equal(c.ok, false);
  assert.match(c.detail, /approve|admin|deploy/);
});

test('busAuthorityTamperedCopy is a copy, never a mutation of the caller\'s log', () => {
  const original = realisticLog();
  const before = JSON.stringify(original);
  busAuthorityTamperedCopy(original);
  assert.equal(JSON.stringify(original), before);
});

test('the third negative control runs, and the genuine log still passes', () => {
  const good = evidenceWithNegativeControls(realisticLog());
  assert.equal(good.ok, true, good.positive.checks.filter((c) => !c.ok).map((c) => c.name).join('; '));
  // Match the exact name of the control that actually fired. A /busAuthority/ regex also
  // matches the `busAuthority control not applicable` fallback, which reports ok:true, so
  // the assertion below would pass even with the real control removed.
  const control = good.controls.find(
    (c) => c.name === 'negative control: a widened busAuthority is rejected');
  assert.ok(control, `the real busAuthority control did not run: ${good.controls.map((c) => c.name).join('; ')}`);
  assert.equal(control.ok, true, 'the control must fire, i.e. the tampered copy must be rejected');
});

test('tampering on a superseded registration is still caught', () => {
  // Read from the RAW events, not from replayed state: a later clean re-registration
  // of the same ref would otherwise launder the earlier forged record out of history.
  const log = realisticLog();
  const forgedFirst = log.map((e, i) => (i === 0
    ? { ...e, busAuthority: [...e.busAuthority, 'approve'] }
    : e));
  const superseded = [...forgedFirst, {
    type: 'actor.registered', at: '2026-08-09T12:30:00.000Z', ref: 'act-0001', name: 'gaia',
    isNew: false, kind: 'coordinator', declaredCapabilities: [], busAuthority: [...BUS_AUTHORITY],
  }];
  const report = evidenceReport(superseded);
  const c = report.checks.find((x) => x.name === 'every actor.registered carries the frozen busAuthority');
  assert.equal(c.ok, false, 'the superseded forged record is still in the log and still counts');
});

test('the report says in its own payload that it does not attest provenance', () => {
  const withControls = evidenceWithNegativeControls(realisticLog());
  assert.equal(typeof withControls.proves, 'string');
  assert.match(withControls.proves, /shape/i);
  assert.match(withControls.proves, /provenance|which client|real[- ]client/i);
});

test('the README states the shape-not-provenance limitation', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /shape.*not provenance|not provenance/i,
    'known limitations must say the gate cannot tell a forged log from a real one');
});

test('the README says when the data directory is created', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  assert.match(readme, /created (?:by|on) the first write/i,
    'a reader must be able to tell that loading the plugin alone creates nothing');
});

// ---------------------------------------------------------------------------
// a display name shaped like a ref would be unreachable by its own name
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// the two fail-closed guards on the server boundary
//
// Both were shipped correct and both were uncovered, and the shipped justification
// for one of them was wrong in the direction that invites its deletion: the redaction
// branch was described as unreachable because a broken log breaks at startup first.
// That covers replay failures only. It is reached by ordinary I/O failure, with no log
// damage at all — and the server's own exit code is what a plugin loader reads.
// ---------------------------------------------------------------------------

test('an I/O failure on the log is fail-closed, redacted, and coded', { timeout: 60_000 }, async (t) => {
  const dir = freshDir('readonly-log');
  assert.equal((await run(CTL, ['initialize', '--apply', '--data-dir', dir])).code, 0);
  const log = join(dir, 'events.jsonl');
  const before = readFileSync(log, 'utf8');

  chmodSync(log, 0o444);
  try {
    let stillWritable = false;
    try { appendFileSync(log, ''); stillWritable = true; } catch { /* the point of the probe */ }
    if (stillWritable) {
      t.skip('this user can write a read-only file, so the probe would prove nothing');
      return;
    }

    const res = await run(CTL, ['heartbeat', '--actorId', 'gaia', '--data-dir', dir]);
    assert.equal(res.code, 3, `fail-closed I/O, not a refusal: ${res.stdout}${res.stderr}`);
    assert.equal(res.json.failClosed, true,
      'failClosed:false here collapses "retry with a better address" into "stop and fetch a human"');
    assert.ok(['EPERM', 'EACCES'].includes(res.json.code), `a real errno is carried: ${res.json.code}`);
    assert.equal(res.json.result, null);
    assert.deepEqual(res.json.eventsAppended, [], 'nothing was written');
    assert.match(res.json.error, /internal fault, not a refusal/);
    assert.doesNotMatch(res.json.error, /appendFileSync|fsyncSync|openSync|events\.jsonl/,
      'the failing source expression stays on the server stderr');
  } finally {
    chmodSync(log, 0o644);
  }
  assert.equal(readFileSync(log, 'utf8'), before, 'the log is byte-unchanged');
});

test('NEGATIVE CONTROL: the same call on a writable log is an ordinary success', { timeout: 60_000 }, async () => {
  const dir = freshDir('writable-log');
  assert.equal((await run(CTL, ['initialize', '--apply', '--data-dir', dir])).code, 0);
  const res = await run(CTL, ['heartbeat', '--actorId', 'gaia', '--data-dir', dir]);
  assert.equal(res.code, 0, `${res.stdout}${res.stderr}`);
  assert.equal(res.json.ok, true);
  assert.ok(!res.json.failClosed);
  assert.deepEqual(res.json.eventsAppended, ['actor.heartbeat']);
});

test('a log that parses but cannot replay exits the SERVER 3 at startup, by name', { timeout: 60_000 }, async () => {
  // The server's exit code — not the CLI's. src/mcp-client.mjs classifies on the stderr
  // sentence, so the product's own CLIs report 3 either way; a plugin loader or a
  // supervisor reads the process. Pinning the sentence also pins that classifier.
  const dir = freshDir('unreplayable-startup');
  writeFileSync(join(dir, 'events.jsonl'),
    JSON.stringify({ type: 'inbox.polled', at: '2026-01-01T00:00:00.000Z' }) + '\n', 'utf8');

  const server = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GAIA_INTERAGENT_DATA_DIR: dir },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stderr }));
  });

  assert.equal(server.code, 3, `the server exits 3, not 1: ${server.stderr}`);
  assert.match(server.stderr, /FATAL UnreplayableLogError/);
  assert.match(server.stderr, /Nothing was written and no retry helps/);
  assert.doesNotMatch(server.stderr, /ready on stdio/, 'it never came up');
});

test('NEGATIVE CONTROL: a replayable log starts the server and it exits 0 on stdin close', { timeout: 60_000 }, async () => {
  const dir = freshDir('replayable-startup');
  assert.equal((await run(CTL, ['initialize', '--apply', '--data-dir', dir])).code, 0);

  const server = await new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, GAIA_INTERAGENT_DATA_DIR: dir },
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stderr }));
  });

  assert.equal(server.code, 0, server.stderr);
  assert.match(server.stderr, /ready on stdio/);
  assert.doesNotMatch(server.stderr, /FATAL/);
});

test('a ref-shaped display name is refused rather than minted unaddressable', () => {
  const state = twoRealActors();
  for (const name of ['act-0001', 'act-0004', 'act-12345']) {
    const out = commit(state, { type: 'register', at: '2026-08-09T12:40:00.000Z', actorId: name });
    assert.ok(out.error, `${name} must be refused`);
    assert.match(out.error, /shaped like a bus ref/);
    assert.deepEqual(out.events.map((e) => e.type), ['command.rejected'], 'the attempt is recorded');
    assert.equal(out.state.counters.actor, state.counters.actor, 'nothing was minted');
  }
});

test('a name that merely starts with act is not refused', () => {
  let state = twoRealActors();
  for (const name of ['action-items', 'actor', 'act', 'act-', 'act-x1', 'ACT-0001', 'acting-lead']) {
    const out = commit(state, { type: 'register', at: '2026-08-09T12:41:00.000Z', actorId: name });
    assert.equal(out.error, null, `${name} must still register: ${out.error}`);
    state = out.state;
  }
});

test('ref precedence in resolveActor is unchanged, and genuine duplicates still refuse', () => {
  let state = twoRealActors();
  state = commit(state, { type: 'register', at: '2026-08-09T12:42:00.000Z', actorId: 'twin' }).state;
  state = commit(state, { type: 'register', at: '2026-08-09T12:42:01.000Z', actorId: 'twin' }).state;
  assert.deepEqual(resolveActor(state, 'act-0001'), { ref: 'act-0001' }, 'a ref still wins');
  const ambiguous = resolveActor(state, 'twin');
  assert.match(ambiguous.error, /ambiguous actor name "twin"/);
  assert.equal(ambiguous.candidates.length, 2);
});

// ---------------------------------------------------------------------------
// authority-integrity truth is not evidence richness
// ---------------------------------------------------------------------------

/**
 * `verify` sorted its evidence checks into two buckets and gated on one of them. The
 * gating bucket held two names; everything else — including *every authority invariant
 * the product exists to assert* — fell into the bucket the README called "evidence
 * richness" and shipped as advisory.
 *
 * So a default `verify` exited 0, printed `ok: true`, and displayed its own red check
 * saying a handoff had transferred `approve`, or that a registration claimed an authority
 * the frozen constant does not contain. A CI reader keying on the exit code — the reader
 * this product's own `proves` string says exists — read that as a pass.
 *
 * The two claims below are the whole of the fix, and each is bought only if the other
 * holds. Making everything gate would satisfy the first and destroy the second; keeping
 * everything advisory is where this started.
 */
const authorityViolations = [
  {
    id: 'a handoff that transferred authority',
    check: 'no handoff transferred authority',
    log: () => realisticLog().map((e) => (e.type === 'work.handed-off'
      ? { ...e, authorityTransferred: ['approve'] } : e)),
  },
  {
    id: 'a registration claiming a widened busAuthority',
    check: 'every actor.registered carries the frozen busAuthority',
    log: () => realisticLog().map((e) => (e.type === 'actor.registered' && e.ref === 'act-0002'
      ? { ...e, busAuthority: [...e.busAuthority, 'approve', 'admin'] } : e)),
  },
  {
    id: 'a message granted a never-grantable privilege',
    check: 'no message was granted a privileged authority',
    log: () => realisticLog().map((e) => (e.type === 'message.sent' && e.message.messageId === 'msg-0002'
      ? { ...e, message: { ...e.message, authority: { ...e.message.authority, granted: ['approve'] } } } : e)),
  },
  {
    id: 'a message body stripped of its untrusted-text label',
    check: 'every body is labelled untrusted-text',
    log: () => realisticLog().map((e) => (e.type === 'message.sent' && e.message.messageId === 'msg-0003'
      ? { ...e, message: { ...e.message, trust: 'trusted' } } : e)),
  },
];

test('every evidence check is classified exactly once, and the two classes are disjoint', () => {
  // Classification by exclusion is what makes the gate fail CLOSED: a check added or
  // renamed tomorrow gates by default rather than silently joining the advisory bucket.
  // This gate exists so the published enumeration cannot drift away from that behaviour
  // without going red.
  const shipped = evidenceReport(realisticLog()).checks.map((c) => c.name);
  const authority = [...AUTHORITY_INTEGRITY_CHECKS];
  const richness = [...EVIDENCE_RICHNESS_CHECKS];

  assert.deepEqual([...new Set(shipped)], shipped, 'no check name is used twice');
  assert.deepEqual(authority.filter((n) => richness.includes(n)), [], 'the two classes are disjoint');
  assert.deepEqual([...authority, ...richness].filter((n) => !shipped.includes(n)), [],
    'every classified name is a name the report actually emits');
  assert.deepEqual(shipped.filter((n) => !authority.includes(n) && !richness.includes(n)), [],
    'and every emitted check is classified — an unclassified check is an undocumented gate');
  for (const name of ALWAYS_GATING_CHECKS) {
    assert.ok(authority.includes(name), `${name} was promoted before and stays in the gating class`);
  }
});

test('the richness class is exactly the checks a correct empty workspace legitimately fails', () => {
  // The membership rule, made executable. This is the one test that decides which bucket
  // a check belongs in, so a mutant that moves an authority check into the advisory
  // bucket fails here as well as at the exit code.
  const empty = evidenceReport([]);
  for (const c of empty.checks) {
    if (EVIDENCE_RICHNESS_CHECKS.includes(c.name)) {
      assert.equal(c.ok, false, `"${c.name}" is advisory, so an empty workspace must be the case that fails it`);
    } else {
      assert.equal(c.ok, true, `"${c.name}" gates always, so an empty workspace must pass it: ${c.detail}`);
    }
  }
  assert.deepEqual(empty.checks.filter((c) => !c.ok).map((c) => c.name).sort(), [...EVIDENCE_RICHNESS_CHECKS].sort(),
    'and the failures on an empty log are the richness class, exactly');
});

test('a default verify exits 1 when an authority invariant is violated', { timeout: 180_000 }, async () => {
  for (const violation of authorityViolations) {
    const dir = freshDir('authority-violation');
    writeFileSync(join(dir, 'events.jsonl'), violation.log().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const verify = await run(CTL, ['verify', '--data-dir', dir]);

    assert.equal(verify.code, 1, `verify exits 1 on ${violation.id}: ${verify.stdout}${verify.stderr}`);
    assert.equal(verify.json.ok, false, `with ok:false on ${violation.id}`);
    assert.equal(verify.json.evidenceGatesResult, false,
      'and it does so in the DEFAULT regime — no --evidence, no --require-evidence');

    // The exit must be caused by the authority check, not by an unrelated red. Without
    // this, an implementation that gated on richness too would pass the assertions above
    // while reporting a fresh workspace as a product failure.
    const evidence = verify.json.sections.find((s) => s.section === 'evidence');
    const failed = evidence.checks.filter((c) => !c.ok).map((c) => c.name);
    assert.deepEqual(failed, [violation.check], `exactly the authority check is red: ${JSON.stringify(failed)}`);
  }
});

test('NEGATIVE CONTROL: an honest evidence-poor workspace still exits 0, richness advisory',
  { timeout: 180_000 }, async () => {
    // The other half. A fresh bus and a bus with one registered actor are correct buses,
    // not failed products, and reporting them as failures is what trains an operator to
    // stop reading the command at all.
    const single = freshDir('honest-single-actor');
    writeFileSync(join(single, 'events.jsonl'), JSON.stringify(realisticLog()[0]) + '\n', 'utf8');

    for (const [label, dir] of [['a fresh workspace', freshDir('honest-empty')], ['a single registered actor', single]]) {
      const verify = await run(CTL, ['verify', '--data-dir', dir]);
      assert.equal(verify.code, 0, `verify exits 0 on ${label}: ${verify.stdout}${verify.stderr}`);
      assert.equal(verify.json.ok, true, `with ok:true on ${label}`);
      assert.equal(verify.json.evidenceOk, false, `while still saying plainly that ${label} is not evidence`);

      // Advisory means reported, not hidden. A "fix" that silenced the richness checks
      // would pass the exit assertions and destroy the signal.
      const evidence = verify.json.sections.find((s) => s.section === 'evidence');
      const failed = evidence.checks.filter((c) => !c.ok).map((c) => c.name);
      assert.ok(failed.length > 0, `${label} still reports its unmet richness checks`);
      assert.deepEqual(failed.filter((n) => !EVIDENCE_RICHNESS_CHECKS.includes(n)), [],
        `and nothing but richness is red on ${label}: ${JSON.stringify(failed)}`);
      assert.ok(verify.json.failed >= failed.length, 'the advisory failures are counted in the payload, not dropped');
    }
  });

test('claiming a log IS evidence still gates on richness too', { timeout: 120_000 }, async () => {
  // The regime switch is unchanged by the reclassification: --require-evidence still
  // promotes the advisory class, so the fix cannot be read as "richness never gates".
  const dir = freshDir('required-evidence');
  writeFileSync(join(dir, 'events.jsonl'), JSON.stringify(realisticLog()[0]) + '\n', 'utf8');
  const required = await run(CTL, ['verify', '--data-dir', dir, '--require-evidence']);
  assert.equal(required.code, 1, `--require-evidence gates richness: ${required.stdout}${required.stderr}`);
  assert.equal(required.json.evidenceGatesResult, true);

  const rich = freshDir('required-evidence-rich');
  writeFileSync(join(rich, 'events.jsonl'), realisticLog().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
  const ok = await run(CTL, ['verify', '--data-dir', rich, '--require-evidence']);
  assert.equal(ok.code, 0, `and a genuine exchange still passes it: ${ok.stdout}${ok.stderr}`);
});

test('the README taxonomy names the shipped classes and enumerates what always gates', () => {
  // The previous taxonomy was two buckets, and the second was called "evidence
  // richness" while holding every authority invariant. Matching a word proved nothing
  // then and proves nothing now, so this gate requires the section to enumerate the
  // shipped check names — a rename or a reclassification forces the README to move with
  // it, or this goes red.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const section = readme.split(/^### /m).find((s) => /^`verify` exits 1/.test(s));
  assert.ok(section, `a verify exit-code section exists: ${readme.split(/^### /m).map((s) => s.split('\n')[0]).join(' | ')}`);

  // Whitespace-collapsed, because prose wraps and a check name may straddle two lines.
  // The text still has to be present verbatim word for word.
  const prose = section.replace(/\s+/g, ' ');
  for (const name of AUTHORITY_INTEGRITY_CHECKS) {
    assert.ok(prose.includes(name), `the section lists the always-gating check "${name}"`);
  }
  for (const name of EVIDENCE_RICHNESS_CHECKS) {
    assert.ok(prose.includes(name), `the section lists the advisory check "${name}"`);
  }
  assert.match(section, /advisory/i, 'the advisory class is still named as such');
  assert.match(section, /--evidence|--require-evidence/, 'and the flag that promotes it is named');
  assert.match(section, /authority/i, 'and the class that always gates is named for what it is');

  // The asymmetry with `doctor` is stated rather than papered over: after this change
  // `verify` gates on strictly more than `doctor` does, and a reader must not be told
  // the two agree everywhere.
  assert.match(section, /doctor/, 'the relationship to doctor is still stated');
  assert.ok(/does not|never|beyond|in addition|additionally|more than/i.test(section),
    'and the section says the two are not identical in reach');
});

test('doctor still exits 0 on the authority violations verify now condemns', { timeout: 180_000 }, async () => {
  // Not an endorsement — a pin. `doctor` inspects identity and correlation health and
  // has never inspected the authority invariants, so this repair leaves it unchanged.
  // The README claim is therefore "verify gates on more", and this gate is what makes
  // that claim falsifiable instead of decorative.
  for (const violation of authorityViolations) {
    const dir = freshDir('doctor-authority');
    writeFileSync(join(dir, 'events.jsonl'), violation.log().map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const doctor = await run(CTL, ['doctor', '--data-dir', dir]);
    assert.equal(doctor.code, 0, `doctor does not inspect ${violation.id}: ${doctor.stdout}${doctor.stderr}`);
  }
});
