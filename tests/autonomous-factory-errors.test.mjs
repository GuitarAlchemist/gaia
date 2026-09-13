import assert from 'node:assert/strict';
import test from 'node:test';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runAutonomousCli } from '../scripts/github-portfolio-autonomous.mjs';
import { runAutonomousFactory } from '../src/autonomous-factory.mjs';

const cli = fileURLToPath(new URL('../scripts/github-portfolio-autonomous.mjs', import.meta.url));
const parseFailure = (() => { try { JSON.parse('gh shim: not json'); } catch (error) { return error; } })();

// RegExp.test coerces its argument, so every one of these must reach the named
// fallback instead of leaking `undefined`, a non-string, or a spoofed token.
const coerced = [
  ['a missing code on an untyped TypeError', new TypeError('gh payload shape')],
  ['a missing code on a JSON.parse SyntaxError', parseFailure],
  ['a thrown null', null],
  ['a thrown undefined', undefined],
  ['a thrown bare string', 'boom'],
  ['a numeric code', Object.assign(new Error('numeric'), { code: 86 })],
  ['an array code coercible to a valid token', Object.assign(new Error('array'), { code: ['PolicyRevoked'] })],
  ['an object code with a spoofing toString', Object.assign(new Error('object'), { code: { toString: () => 'PolicyRevoked' } })],
  ['an empty-string code', Object.assign(new Error('empty'), { code: '' })],
  ['a code with an interior space', Object.assign(new Error('space'), { code: 'Policy Revoked' })],
  ['a code starting with a digit', Object.assign(new Error('digit'), { code: '9Lives' })],
  ['a 65-character code', Object.assign(new Error('long'), { code: `A${'a'.repeat(64)}` })],
];
const preserved = ['PolicyRevoked', 'A', 'gh-2.0_ratelimit', 'undefined', `A${'a'.repeat(63)}`];

function refusalProbe(thrown) {
  const consumed = [];
  return { consumed, args: {
    repository: 'Example/app', policyRevision: 'test-policy',
    store: { get: () => null,
      start: request => { consumed.push(request); throw new Error('authority must not be consumed'); },
      finish: () => consumed.push('finish') },
    execution: { execute: () => { consumed.push('execute'); throw new Error('provider must not launch'); },
      findReceipt: () => null },
    draftAdmission: { target: async () => ({}), read: async () => ({}) },
    githubRead: { read: async () => { throw thrown; } },
  } };
}

for (const [name, thrown] of coerced) {
  test(`pre-authority failure with ${name} serializes the AutonomousRunFailed diagnostic`, async () => {
    const probe = refusalProbe(thrown);
    const refusal = await runAutonomousFactory(probe.args);
    assert.deepEqual(refusal, { schema: 'gaia-autonomous-factory-result/1', status: 'REFUSED', code: 'AutonomousRunFailed' });
    assert.match(JSON.stringify(refusal), /"code":"AutonomousRunFailed"/);
    assert.deepEqual(probe.consumed, []);
  });
}

for (const code of preserved) {
  test(`pre-authority failure keeps its own valid diagnostic code ${JSON.stringify(code)}`, async () => {
    const probe = refusalProbe(Object.assign(new Error('coded refusal'), { code }));
    const refusal = await runAutonomousFactory(probe.args);
    assert.equal(refusal.status, 'REFUSED');
    assert.equal(refusal.code, code);
    assert.deepEqual(probe.consumed, []);
  });
}

// The actual CLI tick boundary: a PATH-first gh shim answers `gh run list` without any
// network, so the discovery failure surfaces exactly where `watch` would see it.
for (const [name, shimBody, expected] of [
  ['non-JSON discovery output (untyped SyntaxError)',
    'process.stdout.write("gh shim: not json\\n"); process.exit(0);', 'HostReadFailed'],
  ['a non-array run list (typed refusal)',
    'process.stdout.write(JSON.stringify({})); process.exit(0);', 'InvalidRunList'],
]) {
  test(`actual CLI tick reports ${name} as ${expected}`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'gaia-auto-diag-tick-'));
    const state = join(root, 'state');
    const clone = join(root, 'clone');
    const bin = join(root, 'bin');
    for (const dir of [state, clone, bin]) mkdirSync(dir);
    const gh = join(bin, process.platform === 'win32' ? 'gh.exe' : 'gh');
    copyFileSync(process.execPath, gh);
    chmodSync(gh, 0o755);
    const shim = join(bin, 'gh-shim.cjs');
    writeFileSync(shim, `${shimBody}\n`);
    const saved = { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS };
    const tty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    const written = [];
    const write = value => written.push(value);
    try {
      process.env.PATH = `${bin}${delimiter}${saved.PATH ?? ''}`;
      // Node's NODE_OPTIONS parser treats backslashes inside quotes as escapes.
      process.env.NODE_OPTIONS = `--require "${shim.replaceAll('\\', '/')}"`;
      process.stdout.isTTY = true;
      assert.equal(await runAutonomousCli(['enable', '--state', state, '--repository', 'Example/app'], { write }), 0);
      assert.equal(await runAutonomousCli(['tick', '--state', state, '--clone', clone], { write }), 1);
      const result = written.at(-1);
      assert.equal(result.status, 'REFUSED');
      assert.equal(result.code, expected);
      assert.match(JSON.stringify(result), new RegExp(`"code":"${expected}"`));
    } finally {
      process.env.PATH = saved.PATH;
      if (saved.NODE_OPTIONS === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = saved.NODE_OPTIONS;
      if (tty) Object.defineProperty(process.stdout, 'isTTY', tty);
      else delete process.stdout.isTTY;
      rmSync(root, { recursive: true, force: true });
    }
  });
}

// The shipped process boundary: a preloaded probe makes the observability check throw,
// so the escape crosses the top-level catch and lands on stderr with its exit code.
const probes = {
  'an untyped escape': ['new TypeError("injected untyped failure")', 'AutonomousCliFailed'],
  'a thrown-null escape': ['null', 'AutonomousCliFailed'],
  'a coded escape': ['Object.assign(new Error("injected coded failure"), { code: "InjectedProbe" })', 'InjectedProbe'],
};
for (const [name, [expression, expected]] of Object.entries(probes)) {
  test(`spawned CLI stderr reports ${name} as ${expected}`, () => {
    const root = mkdtempSync(join(tmpdir(), 'gaia-auto-diag-cli-'));
    const state = join(root, 'state');
    const clone = join(root, 'clone');
    mkdirSync(state);
    mkdirSync(clone);
    writeFileSync(join(state, 'authority.sqlite'), '');
    const probe = join(root, 'probe.cjs');
    writeFileSync(probe, `Object.defineProperty(process.stdout, 'isTTY', { get() { throw ${expression}; } });\n`);
    try {
      const tick = spawnSync(process.execPath, [cli, 'tick', '--state', state, '--clone', clone],
        { encoding: 'utf8', windowsHide: true, input: '',
          env: { ...process.env, NODE_OPTIONS: `--require "${probe.replaceAll('\\', '/')}"` } });
      assert.equal(tick.status, 1);
      assert.equal(tick.stderr.trim(), expected);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
