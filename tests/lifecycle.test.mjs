/**
 * lifecycle.test.mjs — the supported control script, end to end, in real processes.
 *
 * Every command runs against a fresh temp data directory. The assertions that matter
 * most are the negative ones: `initialize` does nothing without --apply, and
 * `uninstall-preview` removes nothing, ever.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CTL = join(ROOT, 'scripts', 'gaia-interagent.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-interagent-lifecycle-'));
let counter = 0;
const freshDir = (name) => {
  const dir = join(SCRATCH, `${name}-${counter += 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function run(args, { env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CTL, ...args], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env } });
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

const ctl = (dir, ...args) => run([...args, '--data-dir', dir]);

/** The bus CLI, for the one thing the control script deliberately has no verb for:
 *  registering an arbitrary extra actor. Used below only to MANUFACTURE the duplicate
 *  name a pre-fix `initialize` used to create by itself. */
const BUS = join(ROOT, 'scripts', 'bus-cli.mjs');
function bus(dir, ...args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BUS, ...args, '--data-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
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

// ---------------------------------------------------------------------------

test('doctor reports a healthy empty workspace and exits 0', { timeout: 30_000 }, async () => {
  const dir = freshDir('doctor');
  const res = await ctl(dir, 'doctor');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.dataDir, dir);
  assert.equal(res.json.bundledServerPresent, true);
  assert.equal(res.json.manifestPresent, true);
  assert.equal(res.json.mcpManifestPresent, true);
  assert.equal(res.json.events, 0);
  assert.equal(res.json.supportedMaxLiveLanes, 4, 'doctor states the supported lane maximum');
  assert.equal(res.json.laneEvidence.nextValidationTarget, 6);
  assert.equal(res.json.laneEvidence.unprovenWithRealClients, 8);
});

// ---------------------------------------------------------------------------
// initialize is idempotent for its own coordinator
//
// `initialize --apply` called `register { actorId: 'gaia' }` with no ref, so a second
// run minted a SECOND actor with the same display name. The ambiguity refusal that
// follows is correct and is one of this bus's better properties — but the product's
// own first documented command manufactured the condition, silently, and the log is
// append-only so the duplicate could never be removed. Every default `--from gaia`
// (ga-watch, wmux-lanes cmdPost, wmux-lanes cmdSweep) broke with it.
// ---------------------------------------------------------------------------

test('running initialize --apply twice leaves exactly one coordinator', { timeout: 60_000 }, async () => {
  const dir = freshDir('init-twice');
  const first = await ctl(dir, 'initialize', '--apply');
  assert.equal(first.code, 0, first.stderr);
  const ref = first.json.result.ref;
  assert.match(ref, /^act-\d{4}$/, 'the first run mints a real ref');

  const second = await ctl(dir, 'initialize', '--apply');
  assert.equal(second.code, 0, `a second run is a no-op, not a refusal: ${second.stderr}`);
  assert.equal(second.json.alreadyRegistered, ref, 'it reports the ref that already exists');
  assert.equal(second.json.registered, false, 'and appended nothing');

  const status = await ctl(dir, 'status');
  assert.equal(status.code, 0, status.stderr);
  const named = status.json.result.actors.filter((a) => a.name === 'gaia');
  assert.equal(named.length, 1, `exactly one actor named gaia, got ${named.length}`);
});

test('the default coordinator name still resolves after a second initialize', { timeout: 60_000 }, async () => {
  // The consequence the duplicate caused, asserted directly: `--from gaia` must keep
  // working. A send that fails with "ambiguous actor name" is this finding, live.
  const dir = freshDir('init-twice-addressing');
  await ctl(dir, 'initialize', '--apply');
  await ctl(dir, 'initialize', '--apply');
  assert.equal((await bus(dir, 'register', '--actorId', 'peer', '--kind', 'worker')).code, 0);

  const send = await ctl(dir, 'send', '--from', 'gaia', '--to', 'peer', '--text', 'hi');
  assert.equal(send.code, 0, `default addressing must survive: ${send.stdout}${send.stderr}`);
  assert.doesNotMatch(`${send.stdout}${send.stderr}`, /ambiguous actor name/);
});

test('a third initialize on an ALREADY ambiguous name refuses rather than adding a fourth', { timeout: 60_000 }, async () => {
  // A directory written by a pre-fix build already carries the duplicate, and the log
  // is append-only so it cannot be repaired. The correct answer there is a refusal
  // that names the candidates, not a third registration.
  const dir = freshDir('init-ambiguous');
  await ctl(dir, 'initialize', '--apply');
  assert.equal((await bus(dir, 'register', '--actorId', 'gaia', '--kind', 'coordinator')).code, 0,
    'manufacture the duplicate a pre-fix initialize created by itself');

  const logFile = join(dir, 'events.jsonl');
  const before = readFileSync(logFile, 'utf8');

  const third = await ctl(dir, 'initialize', '--apply');
  assert.equal(third.code, 1, 'refused');
  assert.match(third.json.error, /refusing to register a third actor named "gaia"/);
  assert.match(third.json.error, /act-0001, act-0002/, 'both refs are named');
  assert.equal(third.json.registered, false);
  assert.deepEqual(third.json.eventsAppended, []);
  assert.equal(readFileSync(logFile, 'utf8'), before, 'the log is byte-unchanged');

  const status = await ctl(dir, 'status');
  assert.equal(status.json.result.actors.filter((a) => a.name === 'gaia').length, 2, 'still two, not three');
});

test('initialize is idempotent for a prototype-shaped coordinator name too', { timeout: 90_000 }, async () => {
  // The pre-check reads the name index, and it must read it by OWN key. A raw
  // `nameIndex['constructor']` reads `Object`, whose `.length` is 1, so a FRESH bus
  // would take the already-exists branch and register nothing at all; `__proto__`
  // reads `Object.prototype`, whose `.length` is undefined, so neither branch fires
  // and the second run duplicates after all. An operator may legitimately name a
  // coordinator either thing, and after this repair that works.
  for (const name of ['__proto__', 'constructor']) {
    const dir = freshDir(`init-proto-${name === '__proto__' ? 'proto' : 'ctor'}`);
    const first = await ctl(dir, 'initialize', '--apply', '--actor', name);
    assert.equal(first.code, 0, `${name} first run: ${first.stderr}`);
    assert.match(first.json.result.ref, /^act-\d{4}$/, `${name} genuinely registered on a fresh bus`);

    const logFile = join(dir, 'events.jsonl');
    const before = readFileSync(logFile, 'utf8');

    const second = await ctl(dir, 'initialize', '--apply', '--actor', name);
    assert.equal(second.code, 0, `${name} second run: ${second.stderr}`);
    assert.equal(second.json.registered, false, `${name} second run appended nothing`);
    assert.equal(second.json.alreadyRegistered, first.json.result.ref);
    assert.equal(readFileSync(logFile, 'utf8'), before, `${name}: the log is byte-unchanged`);

    const status = await ctl(dir, 'status');
    assert.equal(status.json.result.actors.filter((a) => a.name === name).length, 1, name);
  }
});

test('initialize --actor act-0001 does not short-circuit past the ref-shaped-name refusal', { timeout: 60_000 }, async () => {
  // The pre-check must read the name index, NOT resolveActor: resolveActor resolves a
  // REF first, so on a directory containing act-0001 it would report success and mask
  // the refusal the bus already makes. An actor registered under a ref-shaped name is
  // unreachable by its own name, which is why that refusal exists.
  const dir = freshDir('init-ref-shaped');
  const first = await ctl(dir, 'initialize', '--apply');
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.result.ref, 'act-0001', 'the directory now contains act-0001');

  const res = await ctl(dir, 'initialize', '--actor', 'act-0001', '--apply');
  assert.equal(res.code, 1, `the bus must still refuse this: ${res.stdout}${res.stderr}`);
  assert.match(`${res.stdout}${res.stderr}`, /shaped like a bus ref/);
  assert.notEqual(res.json?.alreadyRegistered, 'act-0001', 'it must not report success by ref precedence');

  const status = await ctl(dir, 'status');
  assert.equal(status.json.result.actors.length, 1, 'no second actor was minted');
});

test('NEGATIVE CONTROL: initialize still registers on a fresh directory and under --actor', { timeout: 60_000 }, async () => {
  // The idempotence must not become "never registers". A fresh directory still gets
  // its coordinator, a distinct --actor name still registers alongside, and the
  // dry-run path still writes nothing.
  const dir = freshDir('init-control');
  const dry = await ctl(dir, 'initialize');
  assert.equal(dry.code, 0, dry.stderr);
  assert.equal(existsSync(join(dir, 'events.jsonl')), false, 'dry run appended nothing');

  const first = await ctl(dir, 'initialize', '--apply');
  assert.equal(first.code, 0, first.stderr);
  assert.equal(first.json.result.name, 'gaia');
  assert.deepEqual(first.json.result.nameSharedWith, [], 'the first coordinator shares its name with nobody');

  const other = await ctl(dir, 'initialize', '--apply', '--actor', 'second-coordinator');
  assert.equal(other.code, 0, other.stderr);
  assert.match(other.json.result.ref, /^act-\d{4}$/, 'a different name is a real registration');
  assert.notEqual(other.json.result.ref, first.json.result.ref);

  const status = await ctl(dir, 'status');
  assert.equal(status.json.result.actors.length, 2);
});

test('doctor fails closed with exit 3 on a corrupt log', { timeout: 30_000 }, async () => {
  const dir = freshDir('doctor-corrupt');
  await ctl(dir, 'initialize', '--apply');
  const log = join(dir, 'events.jsonl');
  const before = readFileSync(log, 'utf8');
  writeFileSync(log, before + 'not json\n', 'utf8');

  const res = await ctl(dir, 'doctor');
  assert.equal(res.code, 3, 'fail-closed I/O, not a generic error');
  assert.equal(res.json.replayable, false);
  assert.equal(readFileSync(log, 'utf8'), before + 'not json\n', 'doctor repaired nothing');
});

test('initialize is a dry run by default and writes nothing', { timeout: 30_000 }, async () => {
  const dir = freshDir('init-dry');
  const res = await ctl(dir, 'initialize');
  assert.equal(res.code, 0);
  assert.equal(res.json.mode, 'dry-run');
  assert.equal(res.json.required, '--apply');
  assert.equal(existsSync(join(dir, 'events.jsonl')), false, 'no log was created');
  assert.deepEqual(readdirSync(dir), [], 'the data directory is still empty');
});

test('initialize --apply creates the log and registers a coordinator', { timeout: 30_000 }, async () => {
  const dir = freshDir('init-apply');
  const res = await ctl(dir, 'initialize', '--apply');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.mode, 'apply');
  assert.equal(res.json.result.ref, 'act-0001');
  assert.ok(existsSync(join(dir, 'events.jsonl')));

  // Idempotent in the sense that matters: it never destroys what is already there.
  const before = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const again = await ctl(dir, 'initialize', '--apply');
  assert.equal(again.code, 0);
  assert.ok(readFileSync(join(dir, 'events.jsonl'), 'utf8').startsWith(before), 'the existing log is intact');
});

test('the full lifecycle runs against a fresh directory', { timeout: 90_000 }, async () => {
  const dir = freshDir('full');

  assert.equal((await ctl(dir, 'initialize', '--apply')).code, 0);
  const claude = await ctl(dir, 'send', '--from', 'gaia', '--to', 'gaia', '--text', 'bootstrap');
  assert.equal(claude.code, 0, claude.stderr);

  // Two more lanes, through the low-level verb surface the control script wraps.
  const busCli = join(ROOT, 'scripts', 'bus-cli.mjs');
  const spawnCli = (...args) => new Promise((resolve) => {
    const c = spawn(process.execPath, [busCli, ...args, '--data-dir', dir], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.stdin.end();
    c.on('close', (code) => resolve({ code, json: JSON.parse(out.trim().split('\n').pop()) }));
  });
  const lane = await spawnCli('register', '--actorId', 'claude-code', '--kind', 'worker');
  assert.equal(lane.code, 0);
  const laneRef = lane.json.result.ref;
  const peer = await spawnCli('register', '--actorId', 'codex', '--kind', 'reviewer');
  assert.equal(peer.code, 0);
  const peerRef = peer.json.result.ref;

  const task = await ctl(dir, 'send', '--from', 'gaia', '--to', laneRef,
    '--text', 'summarise the failing test', '--correlationId', 'cor-lifecycle', '--expectsReply');
  assert.equal(task.code, 0, task.stderr);
  const messageId = task.json.result.messageId;

  const box = await ctl(dir, 'inbox', '--actorId', laneRef);
  assert.equal(box.code, 0);
  assert.ok(box.json.result.pending.some((m) => m.messageId === messageId));
  assert.equal(box.json.result.pending.find((m) => m.messageId === messageId).trust, 'untrusted-text');

  const ack = await ctl(dir, 'acknowledge', '--actorId', laneRef, '--messageId', messageId);
  assert.equal(ack.code, 0, ack.stderr);
  assert.equal(ack.json.verb, 'ack', 'acknowledge is the ack verb, not a seventh one');
  assert.match(ack.json.result.meaning, /receipt only/);

  const beat = await ctl(dir, 'heartbeat', '--actorId', laneRef, '--note', 'working');
  assert.equal(beat.code, 0);

  const reply = await ctl(dir, 'send', '--from', laneRef, '--to', 'gaia',
    '--text', 'token refresh race', '--correlationId', 'cor-lifecycle');
  assert.equal(reply.code, 0, reply.stderr);

  const hand = await ctl(dir, 'handoff', '--from', laneRef, '--to', peerRef,
    '--summary', 'draft a fix; do not apply it', '--correlationId', 'cor-lifecycle', '--replyTo', 'gaia');
  assert.equal(hand.code, 0, hand.stderr);
  assert.deepEqual(hand.json.result.authorityTransferred, []);

  const status = await ctl(dir, 'status');
  assert.equal(status.code, 0);
  assert.equal(status.json.result.handoffs.length, 1);
  assert.equal(status.json.result.messages.filter((m) => m.correlationId === 'cor-lifecycle').length, 3);
  assert.equal(status.json.overSupportedLaneLimit, false);

  const verify = await ctl(dir, 'verify');
  assert.equal(verify.code, 0, `verify failed: ${JSON.stringify(verify.json?.sections?.flatMap((s) => s.checks.filter((c) => !c.ok)))}`);
  assert.equal(verify.json.ok, true);
  assert.equal(verify.json.readOnly, true);
  assert.equal(verify.json.evidenceOk, true, 'a genuine three-party correlated exchange satisfies the evidence checks');

  // Pointing verify at that same log as an evidence claim must also pass, and the
  // negative controls must still fail alongside it.
  const asEvidence = await ctl(dir, 'verify', '--evidence', join(dir, 'events.jsonl'));
  assert.equal(asEvidence.code, 0, asEvidence.stderr);
  assert.equal(asEvidence.json.evidenceGatesResult, true);
});

test('verify with --require-evidence fails on a thin log rather than passing it', { timeout: 60_000 }, async () => {
  const dir = freshDir('require-evidence');
  await ctl(dir, 'initialize', '--apply');

  const lenient = await ctl(dir, 'verify');
  assert.equal(lenient.code, 0, 'an empty bus is a correct empty bus');
  assert.equal(lenient.json.evidenceOk, false, 'and verify still says the evidence is thin');

  const strict = await ctl(dir, 'verify', '--require-evidence');
  assert.equal(strict.code, 1, 'claiming the log is evidence makes the evidence checks gate the result');
  assert.equal(strict.json.evidenceGatesResult, true);
});

test('verify carries negative controls that must fail', { timeout: 60_000 }, async () => {
  const dir = freshDir('verify-controls');
  await ctl(dir, 'initialize', '--apply');
  const res = await ctl(dir, 'verify');
  const evidence = res.json.sections.find((s) => s.section === 'evidence');
  const controls = evidence.checks.filter((c) => c.name.startsWith('negative control'));
  assert.ok(controls.length >= 1, 'at least one negative control runs on every verify');
  for (const c of controls) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
  // A near-empty workspace must NOT satisfy the real-exchange checks: that is what
  // makes a passing evidence section mean something.
  assert.equal(evidence.checks.find((c) => c.name === 'at least three actors').ok, false);
});

test('uninstall-preview removes nothing and says what survives', { timeout: 30_000 }, async () => {
  const dir = freshDir('uninstall');
  await ctl(dir, 'initialize', '--apply');
  const logBefore = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  const filesBefore = readdirSync(dir).sort();

  const res = await ctl(dir, 'uninstall-preview');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.destructive, false);
  assert.equal(res.json.removedNothing, true);

  const dataEntry = res.json.entries.find((e) => e.path === dir);
  assert.ok(dataEntry, 'the data directory is listed');
  assert.equal(dataEntry.removedByUninstall, false, 'user data survives an uninstall and the preview says so');
  assert.ok(res.json.entries.some((e) => e.removedByUninstall === true), 'the plugin archive itself is listed as removed');

  assert.deepEqual(readdirSync(dir).sort(), filesBefore, 'nothing in the data directory changed');
  assert.equal(readFileSync(join(dir, 'events.jsonl'), 'utf8'), logBefore, 'the log is byte-identical');
});

test('the control script keeps the bus exit-code contract', { timeout: 60_000 }, async () => {
  const dir = freshDir('exits');
  await ctl(dir, 'initialize', '--apply');

  assert.equal((await ctl(dir, 'heartbeat', '--actorId', 'gaia')).code, 0, '0 = ok');

  const usage = await ctl(dir, 'send', '--from', 'gaia');
  assert.equal(usage.code, 2, '2 = usage error');
  assert.match(usage.stderr, /--to, --text/);

  const refused = await ctl(dir, 'send', '--from', 'gaia', '--to', 'nobody', '--text', 'hi');
  assert.equal(refused.code, 1, '1 = the bus answered and said no');
  assert.match(refused.json.error, /unknown actor/);

  const unknown = await ctl(dir, 'approve', '--actorId', 'gaia');
  assert.equal(unknown.code, 2, 'there is no approve command to invoke');
  assert.match(unknown.stderr, /unknown command/);
});

// ---------------------------------------------------------------------------
// a pure read does not materialise a user-data directory
//
// `withLock` mkdir'd the data directory before it could create the lock inside it,
// and every user-facing read went through it — so merely configuring a client to
// spawn the bundled server created a user-data directory with zero verb calls.
// ---------------------------------------------------------------------------

/** A path that deliberately does not exist yet. Never created by this helper. */
const unborn = (name) => join(SCRATCH, `unborn-${name}-${counter += 1}`);

test('status does not create the data directory', { timeout: 30_000 }, async () => {
  const dir = unborn('status');
  const res = await ctl(dir, 'status');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(res.json.events, 0);
  assert.equal(existsSync(dir), false, 'a read created a user-data directory');
});

test('verify does not create the data directory', { timeout: 60_000 }, async () => {
  const dir = unborn('verify');
  const res = await ctl(dir, 'verify');
  assert.equal(existsSync(dir), false, 'a read-only command created a user-data directory');
  assert.ok(res.json, res.stderr);
});

test('server startup with zero verb calls does not create the data directory', { timeout: 60_000 }, async () => {
  const dir = unborn('startup');
  const server = join(ROOT, 'src', 'mcp-server.mjs');
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [server], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, GAIA_INTERAGENT_DATA_DIR: dir },
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    setTimeout(() => child.stdin.end(), 400);
    child.on('close', resolve);
  });
  assert.equal(code, 0, 'the server started and shut down cleanly');
  assert.equal(existsSync(dir), false, 'startup replay created a user-data directory');
});

test('initialize --apply still creates the data directory', { timeout: 30_000 }, async () => {
  // The guard on the other side: the write path is unchanged.
  const dir = unborn('initialize');
  const res = await ctl(dir, 'initialize', '--apply');
  assert.equal(res.code, 0, res.stderr);
  assert.equal(existsSync(dir), true, 'the write path must still create it');
  assert.equal(existsSync(join(dir, 'events.jsonl')), true);
});

test('the control script exposes no command that could approve, merge, or deploy', { timeout: 30_000 }, async () => {
  const dir = freshDir('no-privilege');
  for (const forbidden of ['approve', 'merge', 'push', 'deploy', 'commit', 'grant', 'admin', 'exec', 'config-write']) {
    const res = await ctl(dir, forbidden);
    assert.equal(res.code, 2, `${forbidden} is not a command`);
    assert.match(res.stderr, /unknown command/);
  }
  const help = await run(['help']);
  assert.equal(help.code, 0);
  for (const forbidden of ['approve', 'deploy']) {
    assert.doesNotMatch(help.stdout, new RegExp(`^\\s+${forbidden}\\b`, 'm'), `help lists no ${forbidden} command`);
  }
});
