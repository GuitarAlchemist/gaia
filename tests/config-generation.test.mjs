/**
 * config-generation.test.mjs — generated client configs are scratch-local, parseable,
 * point at the bundled server, and cannot land in user-global configuration.
 *
 * The TOML is parsed by a small reader defined here rather than asserted with a
 * regex, so "parseable" means the structure was actually recovered.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import {
  mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync,
  symlinkSync, realpathSync, statSync,
} from 'node:fs';
import { join, dirname, basename, resolve, sep } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { LOCK_TIMEOUT_MS } from '../src/event-log.mjs';
import { safeStartupTimeoutSec, startupTimeoutIsSafe, STARTUP_TIMEOUT_FIXED_MARGIN_SEC } from '../src/ecosystem.mjs';
import { assertWritableOutDir, ProtectedPathError, renderCodexConfig, bundledServerPath } from '../src/templates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GEN = join(ROOT, 'scripts', 'generate-config.mjs');
const TARS = join(ROOT, 'scripts', 'tars-mount.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-interagent-config-'));
let counter = 0;
const freshDir = (name) => {
  const dir = join(SCRATCH, `${name}-${counter += 1}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/** Same, but with a caller-supplied environment — used for the spoofed-home legs. */
function runEnv(exe, args, env) {
  return new Promise((resolve) => {
    const child = spawn(exe, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdin.end();
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Minimal TOML reader for the subset the generator emits: `[table]`, `[a.b]`,
 * `key = "s"`, `key = 's'`, `key = 12`, `key = ['a']`. Comments and blanks ignored.
 * Deliberately strict: an unrecognised non-comment line throws.
 */
function parseToml(text) {
  const root = {};
  let table = root;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      table = header[1].split('.').reduce((acc, part) => (acc[part] ??= {}), root);
      continue;
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line);
    if (!pair) throw new Error(`unparseable TOML line: ${line}`);
    const [, key, rawValue] = pair;
    table[key] = parseTomlValue(rawValue.trim());
  }
  return root;
}

function parseTomlValue(value) {
  if (value.startsWith('[') && value.endsWith(']')) {
    const inner = value.slice(1, -1).trim();
    return inner ? inner.split(/\s*,\s*/).map(parseTomlValue) : [];
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  if (value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
  if (/^-?\d+$/.test(value)) return Number(value);
  throw new Error(`unparseable TOML value: ${value}`);
}

test.after(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

// ---------------------------------------------------------------------------

test('generate-config requires --out and writes nothing without it', { timeout: 30_000 }, async () => {
  const res = await run(GEN, ['--client', 'codex']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--out <dir> is required/);
});

test('generate-config is a dry run without --write', { timeout: 30_000 }, async () => {
  const out = freshDir('codex-dry');
  const res = await run(GEN, ['--client', 'codex', '--out', out]);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout.split('\n')[0]);
  assert.equal(report.mode, 'dry-run');
  assert.equal(report.globalConfigTouched, false);
  assert.deepEqual(readdirSync(out), [], 'nothing was created');
});

test('the generated Codex config parses and points at the bundled server', { timeout: 30_000 }, async () => {
  const out = freshDir('codex');
  const dataDir = freshDir('codex-data');
  const res = await run(GEN, ['--client', 'codex', '--out', out, '--data-dir', dataDir, '--write']);
  assert.equal(res.code, 0, res.stderr);

  const target = join(out, 'config.toml');
  assert.ok(existsSync(target), 'config.toml was written into the directory we named');
  const toml = parseToml(readFileSync(target, 'utf8'));
  const server = toml.mcp_servers['gaia-interagent'];

  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, [bundledServerPath()]);
  assert.ok(existsSync(server.args[0]), 'the configured server path exists on disk');
  assert.equal(server.env.GAIA_INTERAGENT_DATA_DIR, dataDir, 'scratch-local data directory');
  assert.ok(!('url' in server), 'no network transport');
});

test('the generated Codex startup_timeout_sec never equals the lock timeout', { timeout: 30_000 }, async () => {
  const out = freshDir('codex-timeout');
  await run(GEN, ['--client', 'codex', '--out', out, '--write']);
  const toml = parseToml(readFileSync(join(out, 'config.toml'), 'utf8'));
  const startup = toml.mcp_servers['gaia-interagent'].startup_timeout_sec;
  const lockSec = Math.ceil(LOCK_TIMEOUT_MS / 1000);

  assert.equal(typeof startup, 'number');
  assert.notEqual(startup, lockSec, 'equality is the bug: the client kills the server exactly when it is waiting correctly');
  assert.ok(startup >= lockSec + STARTUP_TIMEOUT_FIXED_MARGIN_SEC, `${startup}s leaves the documented margin over ${lockSec}s`);
  assert.equal(startup, safeStartupTimeoutSec(LOCK_TIMEOUT_MS));
});

test('the startup-timeout margin holds across lock timeouts, including pathological ones', () => {
  for (const lockMs of [1, 250, 1_000, 5_000, 10_000, 30_000, 120_000]) {
    const startup = safeStartupTimeoutSec(lockMs);
    const lockSec = Math.ceil(lockMs / 1000);
    assert.notEqual(startup, lockSec, `lock ${lockMs}ms`);
    assert.ok(startup > lockSec, `lock ${lockMs}ms: startup ${startup}s > ${lockSec}s`);
    assert.ok(startupTimeoutIsSafe(startup, lockMs));
    assert.ok(!startupTimeoutIsSafe(lockSec, lockMs), 'a startup timeout equal to the lock wait is reported unsafe');
  }
});

test('the generated Claude config is valid JSON, stdio-only, and scratch-local', { timeout: 30_000 }, async () => {
  const out = freshDir('claude');
  const dataDir = freshDir('claude-data');
  const res = await run(GEN, ['--client', 'claude', '--out', out, '--data-dir', dataDir, '--write']);
  assert.equal(res.code, 0, res.stderr);

  const target = join(out, '.mcp.json');
  const config = JSON.parse(readFileSync(target, 'utf8'));
  const server = config.mcpServers['gaia-interagent'];
  assert.equal(server.type, 'stdio');
  assert.equal(server.command, 'node');
  assert.deepEqual(server.args, [bundledServerPath()]);
  assert.equal(server.env.GAIA_INTERAGENT_DATA_DIR, dataDir);
  assert.equal(Object.keys(config.mcpServers).length, 1);
  assert.ok(config._tools.every((t) => t.startsWith('mcp__gaia-interagent__')));
  assert.equal(config._tools.length, 6, 'six tools, named for the six verbs');

  const loaded = JSON.parse(res.stdout.trim().split('\n').pop());
  assert.match(loaded.load, /--strict-mcp-config/, 'the printed load command is session-scoped');
});

test('generation into user-global client configuration is refused', { timeout: 30_000 }, async () => {
  const forbidden = [
    join(homedir(), '.codex'),
    join(homedir(), '.codex', 'nested'),
    join(homedir(), '.claude'),
    join(homedir(), '.agents', 'plugins'),
  ];
  for (const out of forbidden) {
    assert.throws(() => assertWritableOutDir(out), ProtectedPathError, `refuses ${out}`);
    const res = await run(GEN, ['--client', 'codex', '--out', out, '--write']);
    assert.equal(res.code, 2, `${out} is refused by the script too`);
    assert.match(res.stderr, /REFUSED/);
    assert.match(res.stderr, /never edits/);
  }
});

test('generation into the plugin archive is refused', () => {
  assert.throws(() => assertWritableOutDir(ROOT), ProtectedPathError);
  assert.throws(() => assertWritableOutDir(join(ROOT, 'scripts')), ProtectedPathError);
});

test('an existing config is not overwritten without --force', { timeout: 30_000 }, async () => {
  const out = freshDir('overwrite');
  assert.equal((await run(GEN, ['--client', 'claude', '--out', out, '--write'])).code, 0);
  const first = readFileSync(join(out, '.mcp.json'), 'utf8');
  const second = await run(GEN, ['--client', 'claude', '--out', out, '--write']);
  assert.equal(second.code, 2);
  assert.match(second.stderr, /already exists/);
  assert.equal(readFileSync(join(out, '.mcp.json'), 'utf8'), first, 'the existing file is untouched');
});

test('the tars mount generator writes runtime artifacts and touches no repo', { timeout: 30_000 }, async () => {
  const out = freshDir('tars');
  const dry = await run(TARS, ['--out', out]);
  assert.equal(dry.code, 0, dry.stderr);
  assert.deepEqual(readdirSync(out), [], 'dry run wrote nothing');

  const res = await run(TARS, ['--out', out, '--write']);
  assert.equal(res.code, 0, res.stderr);
  const report = JSON.parse(res.stdout.slice(0, res.stdout.indexOf('\n}') + 2));
  assert.equal(report.tarsRepoTouched, false);
  assert.equal(report.verdict.verdict, 'ADAPTER_ONLY');
  assert.match(report.warning, /Do NOT commit/);

  const call = JSON.parse(readFileSync(join(out, 'tars-configure_mcp_server.json'), 'utf8'));
  assert.equal(call.name, 'gaia-interagent');
  assert.equal(call.command, 'node');
  assert.deepEqual(call.args, [bundledServerPath()]);
  assert.ok(existsSync(join(out, 'tars-local-mcp_config.json')));
});

test('the tars generator refuses a rejected or deferred ecosystem target', { timeout: 30_000 }, async () => {
  const out = freshDir('tars-refuse');
  for (const [repo, word] of [['hari', 'REJECT'], ['ix', 'DEFER']]) {
    const res = await run(TARS, ['--repo', repo, '--out', out, '--write']);
    assert.equal(res.code, 2, `${repo} is refused`);
    assert.match(res.stderr, /REFUSED/);
    assert.match(res.stderr, new RegExp(word));
  }
  assert.deepEqual(readdirSync(out), [], 'a refused target writes nothing');
});

// ---------------------------------------------------------------------------
// the home directory itself, by EXACT match
//
// ~/.codex, ~/.claude, ~/.claude.json and ~/.agents were protected by prefix; the
// home directory itself was not. A client launched from $HOME auto-loads a .mcp.json
// found there, so `--out $HOME --write` installed an auto-loading MCP configuration
// user-wide while reporting globalConfigTouched:false.
//
// It must be an EXACT match and not a prefix ban: tmpdir() on Windows lives under
// $HOME, so a prefix ban would refuse the very scratch directories this product tells
// users to generate into. The guard directly below is what pins that.
// ---------------------------------------------------------------------------

test('the home directory itself is refused as an output directory', () => {
  assert.throws(() => assertWritableOutDir(homedir()), ProtectedPathError, '$HOME is refused');
  assert.throws(() => assertWritableOutDir(join(homedir(), '.')), ProtectedPathError, 'and by any spelling of it');
  try {
    assertWritableOutDir(homedir());
    assert.fail('unreachable');
  } catch (err) {
    assert.match(err.message, /home directory itself/);
    assert.match(err.message, /auto-load/, 'the refusal says WHY, not just no');
  }
});

test('a subdirectory of the home directory is still allowed', () => {
  // The over-refusal guard. A prefix ban breaks tmpdir() on Windows and with it the
  // supported workflow; this is the assertion that would go red for it.
  const scratch = freshDir('under-home');
  assert.equal(assertWritableOutDir(scratch), scratch, 'the suite\'s own scratch dir must stay writable');
  assert.doesNotThrow(() => assertWritableOutDir(join(homedir(), 'gaia-interagent-config')));
  assert.doesNotThrow(() => assertWritableOutDir(join(homedir(), 'scratch', 'nested')));
});

test('--out $HOME --write --force is refused before it can overwrite anything', { timeout: 30_000 }, async () => {
  // Hermetic: os.homedir() reads USERPROFILE on Windows and HOME on POSIX, so a child
  // with both pointed at scratch exercises the real code path without ever naming the
  // user's own home. The child asserts its own homedir first, so a future Node that
  // reads the profile from the registry fails this test loudly instead of escaping
  // into the real $HOME.
  const fakeHome = freshDir('fake-home');
  const sentinel = join(fakeHome, '.mcp.json');
  writeFileSync(sentinel, '{"sentinel":true}\n', 'utf8');
  const before = readFileSync(sentinel, 'utf8');

  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, HOMEPATH: fakeHome };
  const guard = await runEnv(process.execPath,
    ['-e', `process.exit(require('node:os').homedir() === ${JSON.stringify(fakeHome)} ? 0 : 9)`], env);
  assert.equal(guard.code, 0, 'the spoofed home did not take effect; the rest of this test would be meaningless');

  const res = await runEnv(process.execPath, [GEN, '--client', 'claude', '--out', fakeHome, '--write', '--force'], env);
  assert.equal(res.code, 2, `expected a refusal, got ${res.code}: ${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /REFUSED/);
  assert.equal(readFileSync(sentinel, 'utf8'), before, 'the pre-existing file is byte-identical');

  const sub = await runEnv(process.execPath, [GEN, '--client', 'claude', '--out', join(fakeHome, 'cfg'), '--write'], env);
  assert.equal(sub.code, 0, `a subdirectory must still work: ${sub.stderr}`);
});

// ---------------------------------------------------------------------------
// case-insensitive filesystems
//
// Windows and macOS resolve `~/.codex` and `~/.Codex` to ONE directory. The guard
// compared with `===` and `startsWith`, which are case-SENSITIVE, so
// `--out $HOME\.Codex\x --write` wrote a generated config inside the real global
// Codex home, and `--out c:\users\<you> --write` wrote $HOME\.mcp.json — both while
// still reporting globalConfigTouched:false.
//
// On Linux those spellings are genuinely different directories the user owns, so
// folding there would be an over-refusal. The fold is platform-conditional and so
// are these tests. The negative controls below are what stop the fold widening the
// refusal beyond the four named roots and $HOME.
// ---------------------------------------------------------------------------

const CASE_INSENSITIVE_FS = process.platform === 'win32' || process.platform === 'darwin';
const CASE_SKIP = CASE_INSENSITIVE_FS
  ? false
  : 'case-sensitive filesystem: these spellings are different directories and must stay writable';

test('every protected root is refused however its case is spelled', { skip: CASE_SKIP }, () => {
  const home = homedir();
  const variants = [
    join(home, '.Codex'),
    join(home, '.CODEX'),
    join(home, '.Codex', 'gaia-x'),
    join(home, '.codex', 'GAIA-X'),
    join(home, '.Claude'),
    join(home, '.CLAUDE', 'settings.json'),
    join(home, '.Claude.json'),
    join(home, '.AGENTS', 'plugins'),
    join(home, '.Agents'),
  ];
  for (const out of variants) {
    assert.throws(() => assertWritableOutDir(out), ProtectedPathError, `refuses ${out}`);
  }
});

test('the home directory is refused with a lower-cased drive letter', {
  skip: process.platform === 'win32' ? false : 'drive letters are a Windows path feature',
}, () => {
  const home = resolve(homedir());
  const lowerDrive = home.charAt(0).toLowerCase() + home.slice(1);
  assert.throws(() => assertWritableOutDir(lowerDrive), ProtectedPathError, lowerDrive);
  assert.throws(() => assertWritableOutDir(home.toLowerCase()), ProtectedPathError, home.toLowerCase());
  assert.throws(() => assertWritableOutDir(home.toUpperCase()), ProtectedPathError, home.toUpperCase());
});

test('the plugin archive is refused however its case is spelled', { skip: CASE_SKIP }, () => {
  assert.throws(() => assertWritableOutDir(ROOT.toUpperCase()), ProtectedPathError);
  assert.throws(() => assertWritableOutDir(join(ROOT, 'SCRIPTS')), ProtectedPathError);
});

test('NEGATIVE CONTROL: non-protected siblings of the protected roots stay writable', () => {
  // The fold must not turn a prefix comparison into a substring one, and must not
  // capture a directory that merely starts with the same letters. If any assertion
  // here goes red the guard has widened beyond the roots it is documented to name.
  const home = homedir();
  const allowed = [
    join(home, '.codex-scratch'),
    join(home, '.Codex-scratch'),
    join(home, '.claudette'),
    join(home, '.claude.jsonl'),
    join(home, '.agents-scratch'),
    join(home, 'codex'),
    join(home, 'gaia-interagent-config'),
  ];
  for (const out of allowed) {
    assert.doesNotThrow(() => assertWritableOutDir(out), `${out} is not a protected root`);
  }
});

test('NEGATIVE CONTROL: a case-variant path outside every protected root is writable', { skip: CASE_SKIP }, () => {
  const scratch = freshDir('case-control');
  assert.equal(assertWritableOutDir(scratch.toUpperCase()).toLowerCase(), scratch.toLowerCase());
});

test('a case-variant protected path is refused by the generator script too', { timeout: 30_000 }, async () => {
  // Hermetic, exactly like the $HOME leg above: USERPROFILE/HOME point at scratch, so
  // no spelling of the user's REAL global config is ever handed to --write. The child
  // asserts its own homedir first, so a Node that resolves the profile some other way
  // fails loudly instead of escaping into the real $HOME.
  const fakeHome = freshDir('fake-home-case');
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, HOMEPATH: fakeHome };
  const guard = await runEnv(process.execPath,
    ['-e', `process.exit(require('node:os').homedir() === ${JSON.stringify(fakeHome)} ? 0 : 9)`], env);
  assert.equal(guard.code, 0, 'the spoofed home did not take effect; the rest of this test would be meaningless');

  const variant = join(fakeHome, CASE_INSENSITIVE_FS ? '.Codex' : '.codex', 'gaia-x');
  const res = await runEnv(process.execPath, [GEN, '--client', 'claude', '--out', variant, '--write', '--force'], env);
  assert.equal(res.code, 2, `expected a refusal, got ${res.code}: ${res.stdout}${res.stderr}`);
  assert.match(res.stderr, /REFUSED/);
  assert.equal(existsSync(join(variant, '.mcp.json')), false, 'nothing was written under the protected root');

  // NEGATIVE CONTROL: the same command one directory over still succeeds.
  const sibling = join(fakeHome, '.codex-scratch');
  const ok = await runEnv(process.execPath, [GEN, '--client', 'claude', '--out', sibling, '--write'], env);
  assert.equal(ok.code, 0, `a non-protected sibling must still work: ${ok.stderr}`);
  assert.ok(existsSync(join(sibling, '.mcp.json')));

  // An ALIAS spelling, driven through the same shipped command rather than through the
  // exported guard, with --write --force and a real file already in the protected root.
  // The guard being right is one claim; the command a user actually types honouring it
  // is the claim the four documents make.
  const protectedRoot = join(fakeHome, '.codex');
  mkdirSync(protectedRoot, { recursive: true });
  const sentinel = join(protectedRoot, 'config.toml');
  writeFileSync(sentinel, '# pre-existing global config\n', 'utf8');
  const sentinelBefore = readFileSync(sentinel, 'utf8');
  const linked = join(fakeHome, 'link-to-protected');
  symlinkSync(protectedRoot, linked, 'junction');

  const aliases = [linked, join(linked, 'gaia-x')];
  if (process.platform === 'win32') aliases.push('\\\\?\\' + protectedRoot);
  for (const out of aliases) {
    const alias = await runEnv(process.execPath, [GEN, '--client', 'codex', '--out', out, '--write', '--force'], env);
    assert.equal(alias.code, 2, `${out} must be refused, got ${alias.code}: ${alias.stdout}${alias.stderr}`);
    assert.match(alias.stderr, /REFUSED/);
  }
  assert.equal(readFileSync(sentinel, 'utf8'), sentinelBefore,
    'and the file already inside the protected root is byte-identical afterwards');
  assert.deepEqual(readdirSync(protectedRoot), ['config.toml'], 'nothing was created through any alias');
});

// ---------------------------------------------------------------------------
// path IDENTITY, not path spelling  (R6-F01 / R5-F01)
//
// Folding case closed one hole and left several open. One directory has many legal
// spellings on Windows — its 8.3 alias (`CODEX~1`), the extended-length form
// (`\\?\C:\…`), the device form (`\\.\C:\…`), an admin-share UNC form
// (`\\localhost\C$\…`), and any junction pointing at it — and no amount of string
// lowercasing collapses any of them. Three review rounds measured the guard accepting
// spellings that reached the real `~/.codex`, with `config.toml` demonstrably readable
// through them, while four shipped documents said those paths were refused.
//
// The property under test is exact and runs in BOTH directions: two spellings are
// treated as the same directory when, and only when, the filesystem says they are.
// Every over-refusal control below (a junction to a directory that is NOT protected, a
// `\\?\` spelling of an ordinary scratch directory) is what stops the repair being
// "refuse anything unusual", which would refuse legitimate output directories and be
// just as false against the same four documents.
//
// These run against a SPOOFED home containing a real fixture tree, never against the
// developer's own `~/.codex`: `os.homedir()` reads USERPROFILE on Windows and HOME on
// POSIX, and each test asserts the spoof took effect before asserting anything else,
// so a future Node that resolves the profile some other way fails loudly rather than
// silently testing nothing.
// ---------------------------------------------------------------------------

const WIN = process.platform === 'win32';

/** Run `fn` with `homedir()` pointed at `fakeHome`, restoring the real environment after. */
function withHome(fakeHome, fn) {
  const saved = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME, HOMEPATH: process.env.HOMEPATH };
  process.env.USERPROFILE = fakeHome;
  process.env.HOME = fakeHome;
  process.env.HOMEPATH = fakeHome;
  try {
    assert.equal(homedir(), fakeHome, 'the spoofed home did not take effect; the rest of this test would be meaningless');
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/**
 * A fixture home with a real `.codex` directory, a junction/symlink pointing at it, and
 * a junction/symlink pointing at a directory that is NOT protected.
 *
 * The link legs are the ones that work identically on every platform this product
 * supports, so the suite always carries at least one alias spelling that a string
 * comparison cannot collapse — on Linux too, where 8.3, `\\?\` and UNC do not exist.
 */
function identityFixture(name) {
  const fakeHome = freshDir(name);
  const codex = join(fakeHome, '.codex');
  const plain = join(fakeHome, 'ordinary-scratch');
  mkdirSync(codex, { recursive: true });
  mkdirSync(plain, { recursive: true });
  writeFileSync(join(codex, 'config.toml'), '# fixture\n', 'utf8');
  const linkToCodex = join(fakeHome, 'link-to-codex');
  const linkToPlain = join(fakeHome, 'link-to-plain');
  symlinkSync(codex, linkToCodex, 'junction');
  symlinkSync(plain, linkToPlain, 'junction');
  return { fakeHome, codex, plain, linkToCodex, linkToPlain };
}

/** The 8.3 alias Windows generated for `leaf` inside `parent`, or null if the volume has none. */
function shortNameOf(parent, leaf) {
  if (!WIN) return null;
  const listing = spawnSync('cmd.exe', ['/d', '/c', 'dir', '/x', '/a', parent], { encoding: 'utf8' });
  if (listing.status !== 0 || typeof listing.stdout !== 'string') return null;
  const row = listing.stdout.split(/\r?\n/).find((l) => l.endsWith(` ${leaf}`));
  const alias = row?.match(/<DIR>\s+([A-Z0-9~_.-]+)\s+\S/)?.[1];
  return alias && alias !== leaf ? alias : null;
}

test('a protected root is refused through every alias spelling the filesystem resolves to it', () => {
  const { fakeHome, codex, linkToCodex } = identityFixture('identity-alias');
  withHome(fakeHome, () => {
    // Control first: the fixture really is one directory under two names. If this ever
    // stops holding, every refusal below would be trivially correct and prove nothing.
    assert.equal(realpathSync.native(linkToCodex), realpathSync.native(codex),
      'the junction and the protected root are the same directory');
    assert.ok(existsSync(join(linkToCodex, 'config.toml')), 'and the protected file is reachable through it');

    assert.throws(() => assertWritableOutDir(linkToCodex), ProtectedPathError, linkToCodex);
    assert.throws(() => assertWritableOutDir(join(linkToCodex, 'nested')), ProtectedPathError,
      'and so is anything under it');
  });
});

test('a protected root is refused through its 8.3 alias', {
  skip: WIN ? false : '8.3 aliases are a Windows filesystem feature',
}, (t) => {
  const { fakeHome, codex } = identityFixture('identity-83');
  const alias = shortNameOf(fakeHome, '.codex');
  if (alias === null) {
    // Reported as a skip, never as a pass. A volume with 8dot3 name creation disabled
    // has no alias spelling to refuse, and a green tick here would claim a gate ran.
    t.skip('8dot3 name creation is disabled on this volume: no alias spelling exists');
    return;
  }
  assert.ok(alias.includes('~'), `the discovered alias is 8.3-shaped: ${alias}`);
  withHome(fakeHome, () => {
    assert.equal(realpathSync.native(join(fakeHome, alias)), realpathSync.native(codex),
      `${alias} and .codex are the same directory`);
    assert.throws(() => assertWritableOutDir(join(fakeHome, alias)), ProtectedPathError, alias);
    assert.throws(() => assertWritableOutDir(join(fakeHome, alias, 'nested')), ProtectedPathError,
      `and anything under ${alias}`);
  });
});

test('a protected root is refused through the extended-length and device namespaces', {
  skip: WIN ? false : 'the \\\\?\\ and \\\\.\\ namespaces are a Windows path feature',
}, () => {
  const { fakeHome, codex } = identityFixture('identity-ns');
  withHome(fakeHome, () => {
    for (const prefix of ['\\\\?\\', '\\\\.\\']) {
      const spelled = prefix + codex;
      assert.throws(() => assertWritableOutDir(spelled), ProtectedPathError, spelled);
      assert.throws(() => assertWritableOutDir(join(spelled, 'nested')), ProtectedPathError, `${spelled}\\nested`);
    }
    assert.throws(() => assertWritableOutDir('\\\\?\\' + fakeHome), ProtectedPathError,
      'the home directory itself, spelled the long way');
  });
});

test('a protected root is refused through an admin-share UNC spelling of the same volume', {
  skip: WIN ? false : 'UNC admin shares are a Windows feature',
}, (t) => {
  const { fakeHome, codex } = identityFixture('identity-unc');
  const unc = codex.replace(/^([A-Za-z]):/, (_, d) => `\\\\localhost\\${d}$`);
  let reachable = false;
  try { reachable = statSync(unc).isDirectory(); } catch { reachable = false; }
  if (!reachable) {
    t.skip(`the admin share is not reachable on this host: ${unc} names nothing to refuse`);
    return;
  }
  // A subdirectory that REALLY EXISTS inside the protected root. This is the one cell
  // only the filesystem-identity route answers: `realpath` leaves a UNC spelling as a
  // UNC spelling, so the canonical route cannot reduce it, and anchoring an existing
  // path yields that path's own file id rather than its parent's — so neither of the
  // other two routes sees that this is inside `~/.codex`. Without a directory that
  // exists here, disabling the identity route entirely changes no gate.
  const realNested = join(codex, 'already-here');
  mkdirSync(realNested, { recursive: true });

  withHome(fakeHome, () => {
    assert.throws(() => assertWritableOutDir(unc), ProtectedPathError, unc);
    assert.throws(() => assertWritableOutDir(join(unc, 'nested')), ProtectedPathError, `${unc}\\nested`);
    assert.throws(() => assertWritableOutDir(join(unc, 'already-here')), ProtectedPathError,
      'a subdirectory that already exists, reached through the admin share');
    assert.throws(() => assertWritableOutDir(join(unc, 'already-here', 'deeper')), ProtectedPathError,
      'and an absent directory below one that exists, reached the same way');
  });
});

test('a protected root is refused through separator and dot-segment spellings', () => {
  const { fakeHome, codex } = identityFixture('identity-sep');
  withHome(fakeHome, () => {
    const spellings = [
      codex + sep,
      codex + sep + sep,
      join(codex, '.'),
      join(codex, 'x', '..'),
      join(fakeHome, 'absent-sibling', '..', '.codex'),
      codex.split(sep).join(sep + sep),
      codex.replace(/\\/g, '/'),
    ];
    for (const out of spellings) {
      assert.throws(() => assertWritableOutDir(out), ProtectedPathError, out);
    }
  });
});

test('a protected root is refused before it exists, by canonical spelling', () => {
  // The filesystem has no identity to offer for a directory that does not exist, and
  // on a fresh machine none of the four roots does. This is the leg the canonical
  // string comparison carries alone — without it the guard would only work on hosts
  // where the user had already run the client once.
  const fakeHome = freshDir('identity-absent');
  withHome(fakeHome, () => {
    assert.equal(existsSync(join(fakeHome, '.codex')), false, 'the root genuinely does not exist yet');
    assert.throws(() => assertWritableOutDir(join(fakeHome, '.codex')), ProtectedPathError);
    assert.throws(() => assertWritableOutDir(join(fakeHome, '.codex', 'nested')), ProtectedPathError);
    assert.throws(() => assertWritableOutDir(join(fakeHome, '.agents', 'plugins')), ProtectedPathError);
    if (CASE_INSENSITIVE_FS) {
      assert.throws(() => assertWritableOutDir(join(fakeHome, '.CODEX')), ProtectedPathError);
    }
    if (WIN) {
      // The leg that only canonicalisation can carry. Nothing on these paths exists,
      // so there is no file id to compare; unless the spelling is reduced first, a
      // `\\?\` or `\\.\` path shares no prefix with the root it names and walks past.
      assert.throws(() => assertWritableOutDir('\\\\?\\' + join(fakeHome, '.codex')), ProtectedPathError);
      assert.throws(() => assertWritableOutDir('\\\\?\\' + join(fakeHome, '.codex', 'nested')), ProtectedPathError);
      assert.throws(() => assertWritableOutDir('\\\\.\\' + join(fakeHome, '.agents')), ProtectedPathError);
    }
    assert.doesNotThrow(() => assertWritableOutDir(join(fakeHome, '.codex-scratch')),
      'and the absent-root leg does not over-refuse either');
  });
});

/**
 * The admin-share UNC spelling of a directory that exists (`C:\x` → `\\localhost\C$\x`),
 * or `null` where that share names nothing on this host.
 *
 * Returning `null` rather than a guessed string is deliberate: a host with
 * administrative shares disabled has no such spelling to refuse, and a gate that passed
 * anyway would be claiming to have run.
 */
function adminShareOf(existingDir, host = 'localhost') {
  if (!WIN) return null;
  const unc = existingDir.replace(/^([A-Za-z]):/, (_, drive) => `\\\\${host}\\${drive}$`);
  if (unc === existingDir) return null;
  try { return statSync(unc).isDirectory() ? unc : null; } catch { return null; }
}

test('a protected root that does not exist yet is refused through an admin-share UNC spelling', {
  skip: WIN ? false : 'UNC admin shares are a Windows feature',
}, (t) => {
  // The seam between the guard's two routes, which is one cell wide and which three
  // shipped documents assert without qualification. `realpath` does NOT reduce
  // `\\localhost\C$\…` to its drive-letter spelling, so the canonical-string route
  // cannot answer for a UNC path; a protected root that does not exist has no file id,
  // so the identity route declines. Both conditions hold at once on a machine where the
  // client has never been run — which is the machine this generator exists for. The
  // suite covered UNC × an EXISTING root and an absent root × `\\?\`; this is the
  // intersection neither covered, and a real `config.toml` lands in a real protected
  // root through it.
  const fakeHome = freshDir('identity-absent-unc');
  const uncHome = adminShareOf(fakeHome);
  if (uncHome === null) {
    t.skip(`the admin share is not reachable on this host: ${fakeHome} has no UNC spelling to refuse`);
    return;
  }
  // Witness first, and independent of the guard: the two spellings really are one
  // directory. Without this the refusals below could be correct for the wrong reason.
  const local = statSync(fakeHome, { bigint: true });
  const remote = statSync(uncHome, { bigint: true });
  assert.equal(`${remote.dev}:${remote.ino}`, `${local.dev}:${local.ino}`,
    'the admin share and the drive letter name the same directory, so answering differently is wrong');

  withHome(fakeHome, () => {
    for (const root of ['.codex', '.claude', '.claude.json', '.agents']) {
      assert.equal(existsSync(join(fakeHome, root)), false, `${root} genuinely does not exist yet`);
      assert.throws(() => assertWritableOutDir(join(uncHome, root)), ProtectedPathError,
        `${uncHome}\\${root} names an absent protected root`);
      assert.throws(() => assertWritableOutDir(join(uncHome, root, 'nested')), ProtectedPathError,
        `and so does anything under ${uncHome}\\${root}`);
    }
    assert.throws(() => assertWritableOutDir(join('\\\\?\\UNC\\' + uncHome.slice(2), '.codex')),
      ProtectedPathError, 'the same share in the extended-length namespace');

    const byAddress = adminShareOf(fakeHome, '127.0.0.1');
    if (byAddress === null) t.diagnostic('the 127.0.0.1 admin share is not reachable on this host');
    else {
      assert.throws(() => assertWritableOutDir(join(byAddress, '.agents')), ProtectedPathError,
        'the same volume named by address rather than by host name');
    }

    // NEGATIVE CONTROL, in the same breath, because closing this cell must not close the
    // UNC capability itself: an ordinary output directory that does not exist yet stays
    // writable through exactly the spelling that refuses the four roots above.
    assert.doesNotThrow(() => assertWritableOutDir(join(uncHome, 'scratch-that-does-not-exist')),
      'an absent ordinary directory is not a protected root, however it is spelled');
    assert.doesNotThrow(() => assertWritableOutDir(join(uncHome, '.codex-scratch')),
      'nor is an absent sibling whose name merely starts the same way');
    assert.doesNotThrow(() => assertWritableOutDir(join(uncHome, 'a', 'b', 'c')),
      'nor is a deep path none of whose segments exists yet');
  });
});

test('the generator refuses an absent protected root spelled as an admin-share UNC path', {
  skip: WIN ? false : 'UNC admin shares are a Windows feature', timeout: 60_000,
}, async (t) => {
  // The same cell, driven through the command a user types rather than through the
  // exported guard — because the claim the three documents make is about the command.
  // The fixture home is empty: nothing here can be destroyed, which is the point. What
  // is at stake is ground the product promises never to occupy, including a DIRECTORY
  // created where Claude Code expects to create `~/.claude.json` as a FILE.
  const fakeHome = freshDir('identity-absent-unc-e2e');
  const uncHome = adminShareOf(fakeHome);
  if (uncHome === null) {
    t.skip(`the admin share is not reachable on this host: ${fakeHome} has no UNC spelling to refuse`);
    return;
  }
  const env = { ...process.env, USERPROFILE: fakeHome, HOME: fakeHome, HOMEPATH: fakeHome };
  const guard = await runEnv(process.execPath,
    ['-e', `process.exit(require('node:os').homedir() === ${JSON.stringify(fakeHome)} ? 0 : 9)`], env);
  assert.equal(guard.code, 0, 'the spoofed home did not take effect; the rest of this test would be meaningless');
  assert.deepEqual(readdirSync(fakeHome), [], 'the fixture home starts empty, as a machine before first run is');

  for (const root of ['.codex', '.agents', '.claude.json']) {
    const res = await runEnv(process.execPath,
      [GEN, '--client', 'codex', '--out', join(uncHome, root), '--write', '--force'], env);
    assert.equal(res.code, 2, `${uncHome}\\${root} must be refused, got ${res.code}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /REFUSED/);
  }
  assert.deepEqual(readdirSync(fakeHome), [],
    'and the generator created nothing at all in a home where the client has never run');

  // NEGATIVE CONTROL: the same UNC spelling of an ordinary directory still writes, so
  // the refusal above is about the root and not about the namespace.
  const ok = await runEnv(process.execPath,
    [GEN, '--client', 'codex', '--out', join(uncHome, 'my-scratch'), '--write'], env);
  assert.equal(ok.code, 0, `an ordinary UNC output directory must still work: ${ok.stdout}${ok.stderr}`);
  assert.ok(existsSync(join(fakeHome, 'my-scratch', 'config.toml')),
    'and it really wrote, through the very spelling that refuses the protected roots');
});

test('$HOME itself is refused through an admin-share UNC spelling, present or absent', {
  skip: WIN ? false : 'UNC admin shares are a Windows feature',
}, (t) => {
  // The same one-cell seam as the test above, one root over — and the branch it lands in
  // is a DIFFERENT one. `$HOME` is refused by EXACT match rather than by prefix, so it is
  // decided by its own comparison and not by `isAtOrInside`, and that comparison had only
  // two of the three routes: `realpath` does not reduce `\\localhost\C$\…`, and a `$HOME`
  // that has not been materialised has no file id, so both declined at once and the
  // anchored route — written for precisely this condition — was never consulted. The two
  // spellings name one directory; refusing one and performing the other is not a refusal.
  // What got performed is named by the refusal message itself: `.mcp.json` in `$HOME` is
  // auto-loaded by any client launched from `$HOME`.
  const parent = freshDir('exact-home-unc');
  const uncParent = adminShareOf(parent);
  if (uncParent === null) {
    t.skip(`the admin share is not reachable on this host: ${parent} has no UNC spelling to refuse`);
    return;
  }
  // Witness first, and independent of the guard: the two spellings of the PARENT really
  // are one directory. That filesystem fact is the whole of what the anchored route uses;
  // without this witness the refusals below could be right for the wrong reason.
  const local = statSync(parent, { bigint: true });
  const remote = statSync(uncParent, { bigint: true });
  assert.equal(`${remote.dev}:${remote.ino}`, `${local.dev}:${local.ino}`,
    'the admin share and the drive letter name the same directory, so answering differently is wrong');

  // ABSENT — the reachable state. `$HOME` set to a path not yet on disk: CI images and
  // containers, a Windows redirected or roaming profile before first materialisation, a
  // service account. That is "a machine where the client has never been run", which is
  // the machine this generator exists for.
  const absentHome = join(parent, 'never-created-home');
  const uncAbsentHome = join(uncParent, 'never-created-home');
  assert.equal(existsSync(absentHome), false, 'the home genuinely does not exist yet');
  withHome(absentHome, () => {
    assert.throws(() => assertWritableOutDir(absentHome), ProtectedPathError,
      'the drive-letter spelling of an absent $HOME is refused');
    assert.throws(() => assertWritableOutDir(uncAbsentHome), ProtectedPathError,
      'and so is the admin-share spelling, because it is the same directory');
    assert.throws(() => assertWritableOutDir('\\\\?\\UNC\\' + uncAbsentHome.slice(2)), ProtectedPathError,
      'the same share in the extended-length namespace');
    const byAddress = adminShareOf(parent, '127.0.0.1');
    if (byAddress === null) t.diagnostic('the 127.0.0.1 admin share is not reachable on this host');
    else {
      assert.throws(() => assertWritableOutDir(join(byAddress, 'never-created-home')), ProtectedPathError,
        'the same volume named by address rather than by host name');
    }

    // NEGATIVE CONTROL, in the same breath, because this is the direction the repair can
    // break: `$HOME` is EXACT-match and must not become a prefix ban. `tmpdir()` on
    // Windows lives under `$HOME`, so a subdirectory reached through the very spelling
    // that refuses `$HOME` has to stay writable — the guard's `samePath` rather than
    // `underPath` is what this pins.
    assert.doesNotThrow(() => assertWritableOutDir(join(uncAbsentHome, 'gaia-interagent-config')),
      'a subdirectory of an absent $HOME, named through the admin share');
    assert.doesNotThrow(() => assertWritableOutDir(join(uncAbsentHome, 'a', 'b', 'c')),
      'and a deep path under it, none of whose segments exists yet');
    assert.doesNotThrow(() => assertWritableOutDir(join(uncParent, 'never-created-home-sibling')),
      'nor is a sibling whose name merely starts the same way the home directory');
  });

  // PRESENT — the state the depth-0 identity route already answered for. Pinned in the
  // same test so the absent cell cannot be closed by breaking the present one, and so the
  // subdirectory control is checked against both states rather than one.
  const presentHome = join(parent, 'materialised-home');
  mkdirSync(presentHome, { recursive: true });
  const uncPresentHome = join(uncParent, 'materialised-home');
  withHome(presentHome, () => {
    assert.throws(() => assertWritableOutDir(presentHome), ProtectedPathError,
      'an existing $HOME by its drive-letter spelling');
    assert.throws(() => assertWritableOutDir(uncPresentHome), ProtectedPathError,
      'and through the admin share, where only the identity route can answer');
    assert.doesNotThrow(() => assertWritableOutDir(join(uncPresentHome, 'gaia-interagent-config')),
      'while a subdirectory of it still writes, through that same spelling');
  });
});

test('the generator refuses an absent $HOME spelled as an admin-share UNC path', {
  skip: WIN ? false : 'UNC admin shares are a Windows feature', timeout: 60_000,
}, async (t) => {
  // The same cell driven through the command a user types, because the claim the
  // documents make is about the command. The harm is not hypothetical and not a
  // near-miss: the file the generator would write here is `.mcp.json` in `$HOME`, the
  // auto-loading user-wide MCP configuration the drive-letter refusal message exists to
  // prevent. One spelling explained the harm; the other performed it.
  const parent = freshDir('exact-home-unc-e2e');
  const uncParent = adminShareOf(parent);
  if (uncParent === null) {
    t.skip(`the admin share is not reachable on this host: ${parent} has no UNC spelling to refuse`);
    return;
  }
  const absentHome = join(parent, 'never-created-home');
  const uncAbsentHome = join(uncParent, 'never-created-home');
  const env = { ...process.env, USERPROFILE: absentHome, HOME: absentHome, HOMEPATH: absentHome };
  const guard = await runEnv(process.execPath,
    ['-e', `process.exit(require('node:os').homedir() === ${JSON.stringify(absentHome)} ? 0 : 9)`], env);
  assert.equal(guard.code, 0, 'the spoofed home did not take effect; the rest of this test would be meaningless');
  assert.equal(existsSync(absentHome), false, 'the home genuinely does not exist yet');

  for (const spelling of [uncAbsentHome, '\\\\?\\UNC\\' + uncAbsentHome.slice(2)]) {
    const res = await runEnv(process.execPath,
      [GEN, '--client', 'claude', '--out', spelling, '--write', '--force'], env);
    assert.equal(res.code, 2, `${spelling} must be refused, got ${res.code}: ${res.stdout}${res.stderr}`);
    assert.match(res.stderr, /REFUSED/);
    assert.match(res.stderr, /home directory itself/,
      'and refused AS the home directory — the message has to name the harm it is preventing');
  }
  assert.equal(existsSync(absentHome), false,
    'and the generator created nothing at all, not even the directory it refused to write into');

  // NEGATIVE CONTROL: a subdirectory of that same absent $HOME, through the same
  // spelling, still writes. The refusal is about the directory, not about the namespace,
  // and `--out ~/gaia-interagent-config` is what the refusal message tells users to type.
  const ok = await runEnv(process.execPath,
    [GEN, '--client', 'claude', '--out', join(uncAbsentHome, 'gaia-interagent-config'), '--write'], env);
  assert.equal(ok.code, 0, `a subdirectory must still work: ${ok.stdout}${ok.stderr}`);
  assert.ok(existsSync(join(absentHome, 'gaia-interagent-config', '.mcp.json')),
    'and it really wrote, through the very spelling that refuses $HOME itself');
  assert.deepEqual(readdirSync(absentHome), ['gaia-interagent-config'],
    'nothing landed in $HOME itself — in particular no auto-loading .mcp.json');
});

test('NEGATIVE CONTROL: identity comparison refuses no directory that is not protected', () => {
  // The over-refusal side of "the same directory when AND ONLY WHEN they are". A guard
  // that answered these with a refusal would satisfy every assertion above and still be
  // wrong, and it would refuse output directories the README tells users to name.
  const { fakeHome, plain, linkToPlain } = identityFixture('identity-control');
  withHome(fakeHome, () => {
    assert.doesNotThrow(() => assertWritableOutDir(plain), 'an ordinary scratch directory');
    assert.doesNotThrow(() => assertWritableOutDir(linkToPlain),
      'a junction is not suspicious in itself: this one points at a directory nobody protects');
    assert.doesNotThrow(() => assertWritableOutDir(join(linkToPlain, 'nested')));
    assert.doesNotThrow(() => assertWritableOutDir(join(fakeHome, '.codex-scratch')),
      'a sibling whose name merely starts with a protected root\'s name');
    assert.doesNotThrow(() => assertWritableOutDir(join(fakeHome, 'does', 'not', 'exist', 'yet')),
      '--out normally names a directory that does not exist yet');
    if (WIN) {
      assert.doesNotThrow(() => assertWritableOutDir('\\\\?\\' + plain),
        'an unusual namespace is not by itself a protected root');
    }
    // The guard's RETURN VALUE is the path the generator then writes to, so it is part
    // of the contract and not an implementation detail: an alias spelling that is
    // allowed must come back canonicalised, or the file lands under a name the caller
    // never resolved. Nothing else in the suite pins this.
    assert.equal(assertWritableOutDir(linkToPlain), realpathSync.native(plain),
      'an allowed alias is returned as the directory it actually names');
    if (WIN) {
      assert.equal(assertWritableOutDir('\\\\?\\' + plain), realpathSync.native(plain),
        'and so is an extended-length spelling of it');
    }
  });
});

/**
 * Every spelling class the shipped documents name, paired with the code that builds
 * that spelling. This is the table the docs-truth gate below is derived from: a class
 * appears here because a document claims it, and the gate then makes the guard answer
 * for it.
 *
 * `spell` returns the spellings to try, or `[]` where the class cannot be constructed
 * on this host — 8.3 aliases, `\\?\` and UNC do not exist on Linux, and a volume with
 * 8dot3 creation disabled has no short name. The gate reports those rather than passing.
 *
 * `needsExistingRoot` marks the two classes that can only be built from a directory that
 * is already there: an 8.3 alias is minted by the filesystem when the directory is
 * created, and a junction must have a target. Every other class is claimed by the
 * documents without qualification, so the gate drives it against a protected root that
 * exists AND against one that does not.
 */
const DOCUMENTED_SPELLINGS = [
  {
    id: 'case variant',
    doc: /case[- ]variant/i,
    spell: (root) => (CASE_INSENSITIVE_FS ? [root.toUpperCase(), root.replace(/\.([a-z])/, (_, c) => `.${c.toUpperCase()}`)] : []),
  },
  {
    id: 'trailing, doubled or forward separators',
    doc: /separator/i,
    spell: (root) => [root + sep, root.split(sep).join(sep + sep), root.replace(/\\/g, '/')],
  },
  {
    id: 'dot segments',
    doc: /dot segment/i,
    spell: (root, home) => [join(root, '.'), join(home, 'absent-sibling', '..', '.codex')],
  },
  {
    id: '8.3 short name',
    doc: /8\.3|CODEX~1/,
    needsExistingRoot: true,
    spell: (_root, home) => {
      const alias = shortNameOf(home, '.codex');
      return alias === null ? [] : [join(home, alias), join(home, alias, 'nested')];
    },
  },
  {
    id: 'extended-length / device namespace',
    doc: /\\\\\?\\/,
    spell: (root) => (WIN ? ['\\\\?\\' + root, '\\\\.\\' + root] : []),
  },
  {
    id: 'admin-share UNC for the same volume',
    // Specific on purpose. A bare `/UNC/i` matched the word "launched" elsewhere in the
    // README, so the previous gate would have stayed green with the UNC row deleted —
    // a vocabulary assertion passing on a coincidence.
    doc: /admin[- ]share UNC/i,
    spell: (_root, home) => {
      const uncHome = adminShareOf(home);
      return uncHome === null ? [] : [join(uncHome, '.codex'), join(uncHome, '.codex', 'nested')];
    },
  },
  {
    id: 'a junction or symlink pointing at it',
    doc: /junction|symlink/i,
    needsExistingRoot: true,
    spell: (_root, home) => [join(home, 'link-to-codex'), join(home, 'link-to-codex', 'nested')],
  },
];

/** The other direction the documents claim: spellings that must STAY writable. */
const DOCUMENTED_WRITABLE = [
  { id: 'a sibling whose name merely starts the same way', spell: (home) => [join(home, '.codex-scratch')] },
  { id: 'a junction to a directory nobody protects', spell: (home) => [join(home, 'link-to-plain')] },
  { id: 'an unusual namespace on your own scratch directory', spell: (home) => (WIN ? ['\\\\?\\' + join(home, 'ordinary-scratch')] : []) },
  { id: 'an output directory that does not exist yet', spell: (home) => [join(home, 'does', 'not', 'exist', 'yet')] },
];

/**
 * The same documented spelling classes, built against `$HOME` ITSELF.
 *
 * Every spelling the table above constructs is `join(fakeHome, '.codex')`, so the gate
 * drove one branch of the guard: the PREFIX branch, `isAtOrInside`. `$HOME` is refused by
 * EXACT match in a separate branch with its own routes, and the documents draw no
 * distinction between the two when they claim a spelling is refused — "and so is your
 * home directory itself" is unqualified, and "the refusal is decided on filesystem
 * identity, not on spelling" is a claim about the guard, not about four fifths of it.
 *
 * A route present in one branch and missing from the other therefore stayed green here
 * while the admin-share UNC spelling of an absent `$HOME` walked past the guard and the
 * generator wrote an auto-loading `.mcp.json` into it. The gate's blind spot was
 * congruent with the code's, which is why a whole green suite did not catch it. This
 * table closes it on the same axis: same claims, same two states, other branch.
 *
 * `id` is the id of the class in DOCUMENTED_SPELLINGS whose documentary claim this row
 * rides on, and the gate asserts that binding — so a documented row deleted there cannot
 * leave these rows quietly asserting a claim no document makes any more.
 */
const DOCUMENTED_EXACT_SPELLINGS = [
  { id: 'case variant', spell: (home) => (CASE_INSENSITIVE_FS ? [home.toUpperCase()] : []) },
  {
    id: 'trailing, doubled or forward separators',
    spell: (home) => [home + sep, home.split(sep).join(sep + sep), home.replace(/\\/g, '/')],
  },
  {
    id: 'dot segments',
    spell: (home) => [join(home, '.'), join(dirname(home), 'absent-sibling', '..', basename(home))],
  },
  { id: 'extended-length / device namespace', spell: (home) => (WIN ? ['\\\\?\\' + home, '\\\\.\\' + home] : []) },
  {
    id: 'admin-share UNC for the same volume',
    // The cell that was open. Nothing on this path exists in the absent state, so the
    // identity route has no id to offer; `realpath` leaves a UNC spelling a UNC spelling,
    // so the canonical-string route cannot reduce it. Only the anchored route answers.
    spell: (home) => {
      const uncParent = adminShareOf(dirname(home));
      if (uncParent === null) return [];
      const uncHome = join(uncParent, basename(home));
      return [uncHome, '\\\\?\\UNC\\' + uncHome.slice(2)];
    },
  },
  {
    id: '8.3 short name',
    needsExistingHome: true,
    spell: (home) => {
      const alias = shortNameOf(dirname(home), basename(home));
      return alias === null ? [] : [join(dirname(home), alias)];
    },
  },
  { id: 'a junction or symlink pointing at it', needsExistingHome: true, spell: (home) => [`${home}-link`] },
];

/**
 * The other direction on the exact-match root, and the one a repair here can break.
 *
 * `$HOME` is refused by EXACT match precisely so its subtree stays writable: `tmpdir()`
 * on Windows lives under `$HOME`, so a prefix ban would refuse the scratch directories
 * this product tells users to generate into and the refusal message's own suggested
 * `--out`. Each row is driven through the same spellings as the refusals above, including
 * the admin share, so a fix that closed the cell by widening `samePath` to `underPath`
 * turns this red rather than shipping.
 */
const DOCUMENTED_EXACT_WRITABLE = [
  { id: 'a subdirectory of $HOME', spell: (home) => [join(home, 'gaia-interagent-config')] },
  { id: 'a deep path under $HOME, none of whose segments exists', spell: (home) => [join(home, 'scratch', 'nested')] },
  {
    id: 'a subdirectory of $HOME through the admin share',
    spell: (home) => {
      const uncParent = adminShareOf(dirname(home));
      return uncParent === null ? [] : [join(uncParent, basename(home), 'gaia-interagent-config')];
    },
  },
  { id: 'a sibling whose name merely starts the same way', spell: (home) => [`${home}-sibling`] },
];

test('the documents describe the guard that ships, in both directions', (t) => {
  // Docs truth is the other half of R6-F01, and a gate that asserts VOCABULARY does not
  // hold it. The previous version of this gate matched `/UNC/i` against the README's
  // spelling table and stayed green while one row of that table was conditionally
  // false — the exact failure mode it was added to prevent, one level up. Presence of a
  // word is not evidence of a behaviour.
  //
  // So this gate is derived from behaviour: for every spelling class the documents name
  // it constructs that spelling against a real fixture and makes the guard answer, in
  // BOTH states the documents decline to distinguish — a protected root that exists and
  // one that does not. A documented row with no refusal behind it turns this red, and so
  // does a refusal of anything the documents promise stays writable.
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const skill = readFileSync(join(ROOT, 'skills', 'gaia-interagent', 'SKILL.md'), 'utf8');
  const header = readFileSync(GEN, 'utf8').slice(0, 2000);

  // Each document's claim is made in one passage, and the class assertions below are
  // scoped to it. Matching a spelling class against the WHOLE document lets an unrelated
  // word carry the assertion — `/UNC/i` matches "launched" — which is the same
  // coincidence-passes-for-evidence failure this gate exists to end.
  const claims = [
    ['README.md', readme.slice(readme.indexOf('**The refusal is decided on filesystem identity'), readme.indexOf('- Codex: load with'))],
    ['SKILL.md', skill.slice(skill.indexOf('## Configuration'), skill.indexOf('## Do not'))],
  ];
  for (const [name, passage] of claims) {
    assert.ok(passage.length > 200, `${name}'s passage about the guard is still where this gate looks for it`);
  }

  for (const [name, text] of [['README.md', readme], ['SKILL.md', skill]]) {
    assert.match(text, /identity/i, `${name} says the comparison is about identity`);
    assert.match(text, /not|stays writable/i, `${name} states the over-refusal direction too`);
  }
  assert.doesNotMatch(readme, /the comparison is\s+case-insensitive, because/,
    'the README no longer describes the guard as a case fold, which is what it stopped being');

  // Present: `.codex` exists, plus the junctions and the ordinary scratch directory.
  const present = identityFixture('docs-truth-present');
  // Absent: nothing at all, as on a machine where the client has never been run. The
  // junction and scratch fixtures are still needed for the writable direction.
  const absent = { fakeHome: freshDir('docs-truth-absent') };
  mkdirSync(join(absent.fakeHome, 'ordinary-scratch'), { recursive: true });
  symlinkSync(join(absent.fakeHome, 'ordinary-scratch'), join(absent.fakeHome, 'link-to-plain'), 'junction');

  const unverified = [];
  for (const cls of DOCUMENTED_SPELLINGS) {
    for (const [name, passage] of claims) {
      assert.match(passage, cls.doc, `${name} names the "${cls.id}" spelling where it makes the claim`);
    }
    const states = cls.needsExistingRoot
      ? [['an existing protected root', present]]
      : [['an existing protected root', present], ['a protected root that does not exist yet', absent]];

    for (const [stateName, fx] of states) {
      const root = join(fx.fakeHome, '.codex');
      withHome(fx.fakeHome, () => {
        const spellings = cls.spell(root, fx.fakeHome);
        if (spellings.length === 0) {
          unverified.push(`${cls.id} (${stateName})`);
          return;
        }
        for (const out of spellings) {
          assert.throws(() => assertWritableOutDir(out), ProtectedPathError,
            `the documents say "${cls.id}" is refused; with ${stateName} it is not: ${out}`);
        }
      });
    }
  }

  for (const cls of DOCUMENTED_WRITABLE) {
    for (const [stateName, fx] of [['an existing protected root', present], ['a protected root that does not exist yet', absent]]) {
      withHome(fx.fakeHome, () => {
        for (const out of cls.spell(fx.fakeHome)) {
          assert.doesNotThrow(() => assertWritableOutDir(out),
            `the documents say "${cls.id}" stays writable; with ${stateName} it does not: ${out}`);
        }
      });
    }
  }

  // The exact-match root. The same documented claims, the other branch of the guard —
  // the half nothing above reaches, because every spelling above is built from
  // `join(fakeHome, '.codex')` and so is decided by `isAtOrInside` alone.
  const exactPresent = present.fakeHome;
  symlinkSync(exactPresent, `${exactPresent}-link`, 'junction');
  const exactAbsent = join(freshDir('docs-truth-exact-absent'), 'never-created-home');
  assert.equal(existsSync(exactAbsent), false,
    'the absent-$HOME state is genuinely absent, or that half of this gate tests the present one twice');

  for (const cls of DOCUMENTED_EXACT_SPELLINGS) {
    assert.ok(DOCUMENTED_SPELLINGS.some((c) => c.id === cls.id),
      `"${cls.id}" must still be a class the documents are held to above, or this row rides on no claim`);
    const states = cls.needsExistingHome
      ? [['a home directory that exists', exactPresent]]
      : [['a home directory that exists', exactPresent], ['a home directory that does not exist yet', exactAbsent]];
    for (const [stateName, home] of states) {
      withHome(home, () => {
        const spellings = cls.spell(home);
        if (spellings.length === 0) {
          unverified.push(`${cls.id} ($HOME itself, ${stateName})`);
          return;
        }
        for (const out of spellings) {
          assert.throws(() => assertWritableOutDir(out), ProtectedPathError,
            `the documents say "${cls.id}" is refused, and say it of $HOME itself; with ${stateName} it is not: ${out}`);
        }
      });
    }
  }

  for (const cls of DOCUMENTED_EXACT_WRITABLE) {
    for (const [stateName, home] of [['a home directory that exists', exactPresent], ['a home directory that does not exist yet', exactAbsent]]) {
      withHome(home, () => {
        for (const out of cls.spell(home)) {
          assert.doesNotThrow(() => assertWritableOutDir(out),
            `$HOME is refused by EXACT match and must not become a prefix ban; "${cls.id}" with ${stateName} was refused: ${out}`);
        }
      });
    }
  }

  // A gate that could quietly verify nothing is not a gate. The three classes that exist
  // on every platform this product supports must always have been driven; anything the
  // host genuinely cannot construct is reported, never counted as a pass.
  for (const entry of unverified) t.diagnostic(`spelling class not constructible on this host: ${entry}`);
  const alwaysAvailable = ['trailing, doubled or forward separators', 'dot segments', 'a junction or symlink pointing at it'];
  for (const id of alwaysAvailable) {
    assert.ok(!unverified.some((u) => u.startsWith(id)),
      `"${id}" exists on every supported platform and must have been driven, not skipped: ${unverified.join(' | ')}`);
  }
  assert.match(header, /identity/i, 'the shipped generator header makes the same claim as the documents');
});

test('the rendered Codex template explains why the timeout is not the lock timeout', () => {
  const text = renderCodexConfig({ serverPath: '<S>', dataDir: '<D>' });
  assert.match(text, /startup_timeout_sec is deliberately/);
  assert.match(text, /never mutates\s+# user-global client configuration/);
  assert.match(text, /no `codex mcp add` was run/, 'the template states the global-mutating path was not taken');
  assert.doesNotMatch(text, /^\s*(?:\$ )?codex mcp add/m, 'and never presents it as a step to run');
});
