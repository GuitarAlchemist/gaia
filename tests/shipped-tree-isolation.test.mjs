/**
 * shipped-tree-isolation.test.mjs — the suite never writes inside `src/` (#98).
 *
 * The r8 production gate planted a transient mutant at `src/.r8-checklist-bind-mutant.mjs`
 * and removed it a second later; the r3 gate did the same with three more. Meanwhile the
 * product gates in `product.test.mjs` enumerate every shipped file, and `verify` scans
 * every `.mjs` under `src/`: one full run in three saw the entry in `readdir` and ENOENT on
 * `open` (`product.test.mjs`), or an empty stdout from a crashed `verify` subprocess
 * (`adversarial.test.mjs`). The fix moves the mutants to a scratch directory. These gates
 * measure the invariant the fix restores instead of trusting it: under a preload that
 * refuses every write aimed at `src/`, the mutant-planting gates still pass and refuse
 * nothing; a copy of the r8 gate reverted to plant in `src/` is refused and reported.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const TESTS = join(ROOT, 'tests');
const GUARD = join(TESTS, 'fixtures', 'refuse-src-writes.mjs');
const R8 = join(TESTS, 'pr-review-thread-production-r8.test.mjs');
const R3 = join(TESTS, 'pr-review-thread-production-r3.test.mjs');

const scratch = mkdtempSync(join(tmpdir(), 'gaia-shipped-tree-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

/**
 * Run test files under the guard; return the runner's exit code, its TAP counts, and every
 * refused write. Paths go to the runner with forward slashes: it reads them as globs, and a
 * backslash in a glob is an escape.
 */
function runGuarded(label, files) {
  const log = join(scratch, `${label}.refused.jsonl`);
  const nodeOptions = `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(GUARD).href}`.trim();
  const patterns = files.map((file) => file.replaceAll('\\', '/'));
  const env = {
    ...process.env,
    NODE_OPTIONS: nodeOptions,
    GAIA_SRC_WRITE_GUARD_ROOT: SRC,
    GAIA_SRC_WRITE_GUARD_LOG: log,
  };
  // This gate itself runs inside a `node --test` child, which marks its environment; a
  // nested runner that inherits the mark behaves as a child and runs nothing.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...patterns], {
    cwd: ROOT, encoding: 'utf8', env, windowsHide: true,
  });
  const refused = existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const count = (name) => Number(result.stdout.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] ?? NaN);
  return {
    status: result.status,
    counts: { tests: count('tests'), pass: count('pass'), fail: count('fail') },
    refused,
    output: `${result.stdout}${result.stderr}`,
  };
}

test('the mutant-planting production gates pass without one write under src/', { timeout: 120_000 }, () => {
  const { status, counts, refused, output } = runGuarded('fixed', [R3, R8]);
  assert.deepEqual(refused, [], `every mutant is planted outside src/: ${JSON.stringify(refused)}`);
  assert.ok(counts.tests >= 5 && counts.pass === counts.tests && counts.fail === 0,
    `the four mutant gates and their siblings ran and passed: ${JSON.stringify(counts)}`);
  assert.equal(status, 0, `r3 and r8 still pass with src/ read-only:\n${output.slice(-2000)}`);
  assert.deepEqual(readdirSync(SRC).filter((name) => name.startsWith('.')), [], 'and src/ carries no dotfile afterwards');
});

test('MECHANISM REVERT: an r8 gate that plants its mutant in src/ is refused and reported', { timeout: 120_000 }, () => {
  // The control takes the shipped r8 gate, points its mutant back at the shipped tree the
  // way the pre-fix gate did, and runs that copy from scratch under the same guard. The
  // guard must refuse the write before it lands, so the race can never come back through
  // this control, and must name the path, so the report is attributable.
  const source = readFileSync(R8, 'utf8');
  const srcHref = pathToFileURL(`${SRC}/`).href;
  const reverted = source
    .replace("new URL('../src/', import.meta.url)", `new URL(${JSON.stringify(srcHref)})`)
    .replaceAll("from '../src/", `from '${srcHref}`)
    .replace('const mutantPath = join(mutantScratch, name);', 'const mutantPath = join(SRC, `.${name}`);');
  assert.notEqual(reverted, source, 'the revert changed the gate');
  assert.ok(reverted.includes('join(SRC, `.${name}`)'), 'the revert plants the mutant in src/ again');
  const copy = join(scratch, 'r8-reverted.test.mjs');
  writeFileSync(copy, reverted, 'utf8');

  const { status, counts, refused } = runGuarded('reverted', [copy]);
  assert.ok(counts.tests >= 2 && counts.fail >= 1, `the reverted copy ran and failed: ${JSON.stringify(counts)}`);
  assert.notEqual(status, 0, 'the reverted gate cannot pass with src/ read-only');
  assert.equal(refused.length, 1, `exactly the one planted write is refused: ${JSON.stringify(refused)}`);
  assert.equal(refused[0].operation, 'writeFileSync');
  assert.equal(refused[0].path, join(SRC, '.r8-checklist-bind-mutant.mjs'));
  assert.ok(!existsSync(join(SRC, '.r8-checklist-bind-mutant.mjs')), 'and nothing landed in src/');
});

test('no test names a dotfile under src/ as a place to write', () => {
  // The cheap tripwire for the one spelling used twice before #98. It is not the
  // measurement — the guard above is — but it catches the copy-paste at review time.
  const offenders = readdirSync(TESTS)
    .filter((name) => name.endsWith('.test.mjs'))
    .filter((name) => /\.\.\/src\/\./.test(readFileSync(join(TESTS, name), 'utf8')));
  assert.deepEqual(offenders, []);
});
