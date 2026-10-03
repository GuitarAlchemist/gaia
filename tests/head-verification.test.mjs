import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { FactoryAgentError, verifyCommittedHead } from '../src/factory-agent.mjs';
import { validateAutonomousVerification } from '../src/autonomous-factory-contract.mjs';
import {
  HEAD_VERIFICATION_FIELDS, HEAD_VERIFICATION_SCHEMA, HeadVerificationError,
  headVerificationRevision, requireHeadVerification, sealHeadVerification,
} from '../src/head-verification.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-head-verification-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));

const CLI = fileURLToPath(new URL('../scripts/verify-head.mjs', import.meta.url));
const PINNED = process.version.replace(/^v/u, '');
const PASSING = "import test from 'node:test';\ntest('head', () => {});\n";
const FAILING = "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
  + "test('head', () => { assert.equal(1, 2); });\n";

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }).trim();
let fixtures = 0;
const evidenceDir = () => join(scratch, `evidence-${fixtures += 1}`);

/** A repository whose base commit has no test and whose head commit adds one, pinned to this Node. */
function fixture({ testSource = PASSING, pin = PINNED } = {}) {
  const repo = join(scratch, `repo-${fixtures += 1}`);
  git(scratch, 'init', '-q', repo);
  git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'README.md'), 'fixture\n', 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'base');
  const base = git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, '.node-version'), `${pin}\n`, 'utf8');
  writeFileSync(join(repo, 'head.test.mjs'), testSource, 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'head');
  return { repo, base, head: git(repo, 'rev-parse', 'HEAD') };
}

/** A runner that returns a fixed, well-formed result, so a receipt depends only on the bytes. */
const fixedRunner = ({ passed = true } = {}) => async () => ({
  runtime: { version: process.version, pinned: PINNED },
  command: 'node --test --test-reporter=spec',
  termination: 'exit',
  exitCode: passed ? 0 : 1,
  output: `ℹ tests 1\nℹ pass ${passed ? 1 : 0}\nℹ fail ${passed ? 0 : 1}\n`,
});

const refusedWith = code => error => error instanceof FactoryAgentError && error.code === code;

test('a passing head yields the factory\'s own record, bound to the exact base..HEAD bytes', async () => {
  const { repo, base, head } = fixture();
  const result = await verifyCommittedHead({ worktree: repo, baseHead: base, evidenceDir: evidenceDir() });

  assert.equal(result.headSha, head);
  assert.equal(result.verification.schema, 'gaia-factory-verification/1');
  assert.equal(result.verification.command, 'node --test --test-reporter=spec');
  assert.deepEqual(result.verification.runtime, { version: process.version, pinned: PINNED });
  assert.deepEqual(result.verification.counts, { tests: 1, pass: 1, fail: 0 });
  assert.equal(result.verification.passed, true);
  assert.equal(result.changeSet.baseHead, base);
  assert.equal(result.changeSet.statusBytes, 0);
  assert.deepEqual(result.changeSet.files.map(file => file.path), ['.node-version', 'head.test.mjs']);
  assert.equal(result.verification.candidateIdentity, result.changeSet.identity);
  // The factory contract's own validator accepts the record unchanged: one recipe, not two.
  validateAutonomousVerification(result.verification, 'verification', result.changeSet.identity);
  assert.equal(readFileSync(result.verification.evidence.path, 'utf8').includes('ℹ pass 1'), true);

  const receipt = sealHeadVerification(result);
  assert.deepEqual(Object.keys(receipt), HEAD_VERIFICATION_FIELDS);
  assert.equal(receipt.schema, HEAD_VERIFICATION_SCHEMA);
  assert.equal(receipt.effect, 'NONE');
  assert.equal(receipt.authority, 'NONE');
  assert.equal(receipt.baseSha, base);
  assert.equal(requireHeadVerification(receipt), receipt);
});

test('a failing head is recorded as not passed, never refused and never passed', async () => {
  const { repo, base } = fixture({ testSource: FAILING });
  const result = await verifyCommittedHead({ worktree: repo, baseHead: base, evidenceDir: evidenceDir() });

  assert.equal(result.verification.passed, false);
  assert.deepEqual(result.verification.counts, { tests: 1, pass: 0, fail: 1 });
  assert.notEqual(result.verification.exitCode, 0);
  assert.equal(requireHeadVerification(sealHeadVerification(result)).verification.passed, false);
});

test('a head pinned to another Node is refused by the factory\'s own runtime check', async () => {
  const { repo, base } = fixture({ pin: '0.0.1' });
  await assert.rejects(
    verifyCommittedHead({ worktree: repo, baseHead: base, evidenceDir: evidenceDir() }),
    refusedWith('VerificationRuntimeMismatch'),
  );
});

test('a dirty tree, a malformed base and a base that is not an ancestor are refused before any test runs', async () => {
  const { repo, base } = fixture();
  let runs = 0;
  const runVerification = async () => { runs += 1; return fixedRunner()(); };

  for (const baseHead of [base.slice(0, 12), 'main', base.toUpperCase(), undefined]) {
    await assert.rejects(
      verifyCommittedHead({ worktree: repo, baseHead, evidenceDir: evidenceDir(), runVerification }),
      refusedWith('BaseHeadInvalid'),
    );
  }

  git(repo, 'checkout', '-q', '-b', 'sibling', base);
  writeFileSync(join(repo, 'sibling.txt'), 'elsewhere\n', 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'sibling');
  const sibling = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', '-');
  await assert.rejects(
    verifyCommittedHead({ worktree: repo, baseHead: sibling, evidenceDir: evidenceDir(), runVerification }),
    refusedWith('BaseNotAncestor'),
  );

  writeFileSync(join(repo, 'untracked.txt'), 'dirty\n', 'utf8');
  await assert.rejects(
    verifyCommittedHead({ worktree: repo, baseHead: base, evidenceDir: evidenceDir(), runVerification }),
    refusedWith('CleanWorktreeRequired'),
  );
  assert.equal(runs, 0);
});

test('a subdirectory of the worktree is refused before any test runs, from the function and the CLI', async () => {
  // Git calls a subdirectory "inside the work tree", but from there `.node-version` is
  // absent, so a head pinned to another Node would run and pass unpinned.
  const { repo, base } = fixture({ pin: '0.0.1' });
  const sub = join(repo, 'sub');
  mkdirSync(sub);
  writeFileSync(join(sub, 'sub.test.mjs'), PASSING, 'utf8');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'sub');
  let runs = 0;
  const runVerification = async () => { runs += 1; return fixedRunner()(); };
  const unused = evidenceDir();
  await assert.rejects(
    verifyCommittedHead({ worktree: sub, baseHead: base, evidenceDir: unused, runVerification }),
    refusedWith('WorktreeRootRequired'),
  );
  assert.equal(runs, 0);
  assert.equal(existsSync(unused), false);

  const out = join(scratch, `receipt-${fixtures += 1}.json`);
  const run = cli(repo, ['--base', base, '--evidence-dir', evidenceDir(), '--out', out, '--worktree', 'sub']);
  assert.equal(run.status, 2, run.stdout);
  assert.match(run.stderr, /WorktreeRootRequired/u);
  assert.equal(existsSync(out), false);
});

test('a verification run that writes into the worktree is the factory\'s VerificationMutation', async () => {
  const { repo, base } = fixture();
  const runVerification = async ({ cwd }) => {
    writeFileSync(join(cwd, 'left-behind.txt'), 'mutation\n', 'utf8');
    return fixedRunner()();
  };
  await assert.rejects(
    verifyCommittedHead({ worktree: repo, baseHead: base, evidenceDir: evidenceDir(), runVerification }),
    refusedWith('VerificationMutation'),
  );
});

test('the receipt is a pure function of the run: sealing is byte-identical, runs differ only in evidence path', async () => {
  const { repo, base } = fixture();
  const first = await verifyCommittedHead({
    worktree: repo, baseHead: base, evidenceDir: evidenceDir(), runVerification: fixedRunner(),
  });
  const second = await verifyCommittedHead({
    worktree: repo, baseHead: base, evidenceDir: evidenceDir(), runVerification: fixedRunner(),
  });

  assert.equal(JSON.stringify(sealHeadVerification(first)), JSON.stringify(sealHeadVerification(first)));
  const withoutPath = ({ verification: { evidence: { path, ...evidence }, ...verification }, ...rest }) =>
    ({ ...rest, verification: { ...verification, evidence } });
  assert.notEqual(first.verification.evidence.path, second.verification.evidence.path);
  assert.deepEqual(withoutPath(first), withoutPath(second));
});

test('the verifier refuses every tampering, and the untouched receipt passes', async () => {
  const { repo, base } = fixture();
  const receipt = sealHeadVerification(await verifyCommittedHead({
    worktree: repo, baseHead: base, evidenceDir: evidenceDir(), runVerification: fixedRunner(),
  }));
  const copy = () => structuredClone(receipt);
  assert.equal(requireHeadVerification(copy()).revision, receipt.revision);

  const mutations = {
    'unknown field': value => { value.approved = true; },
    'missing field': value => { delete value.changeSet; },
    'effect claimed': value => { value.effect = 'MERGE'; },
    'authority claimed': value => { value.authority = 'host-user-process'; },
    'short head': value => { value.headSha = value.headSha.slice(0, 7); },
    'base apart from its change-set': value => { value.baseSha = value.headSha; },
    'revision': value => { value.revision = '0'.repeat(64); },
    'count without revision': value => { value.verification.counts.pass = 2; },
    'passed contradicts counts': value => { value.verification.counts.fail = 1; },
    'record bound elsewhere': value => { value.verification.candidateIdentity = 'f'.repeat(64); },
    'change-set identity': value => { value.changeSet.identity = 'e'.repeat(64); },
    'dirty change-set': value => { value.changeSet.statusBytes = 3; },
    'evidence policy': value => { value.verification.evidence.policy = 'public'; },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    const value = copy();
    mutate(value);
    assert.throws(() => requireHeadVerification(value),
      error => error instanceof HeadVerificationError && error.code === 'HeadVerificationInvalid', name);
  }
  for (const value of [null, [], 'receipt', Object.assign(Object.create(null), copy())]) {
    assert.throws(() => requireHeadVerification(value), HeadVerificationError);
  }
});

test('re-sealed forgeries with a valid revision are each stopped by the check that owns them', async () => {
  const { repo, base } = fixture();
  const receipt = sealHeadVerification(await verifyCommittedHead({
    worktree: repo, baseHead: base, evidenceDir: evidenceDir(), runVerification: fixedRunner(),
  }));
  const sha256 = text => createHash('sha256').update(text).digest('hex');
  // The factory's change-set identity recipe, restated so a forgery can be internally consistent.
  const identityOf = ({ baseHead, statusBytes, statusSha256, patchBytes, patchSha256, files }) =>
    sha256(`${JSON.stringify({ baseHead, statusBytes, statusSha256, patchBytes, patchSha256, files })}\n`);
  const reseal = value => ({ ...value, revision: headVerificationRevision(value) });

  const forgeries = {
    'passed contradicts counts (factory validateVerification)': value => {
      value.verification.counts.fail = 1;
    },
    'record bound to another change-set (factory validateVerification)': value => {
      value.verification.candidateIdentity = 'f'.repeat(64);
    },
    'a dirty change-set, consistently re-identified (clean-head rule)': value => {
      value.changeSet.statusBytes = 3;
      value.changeSet.statusSha256 = sha256('abc');
      value.changeSet.identity = identityOf(value.changeSet);
      value.verification.candidateIdentity = value.changeSet.identity;
    },
    'a change-set file outside the repository (factory validateChangeSet)': value => {
      value.changeSet.files[0].path = '../outside';
      value.changeSet.identity = identityOf(value.changeSet);
      value.verification.candidateIdentity = value.changeSet.identity;
    },
    'an effect claimed': value => { value.effect = 'MERGE'; },
    'a short head': value => { value.headSha = value.headSha.slice(0, 7); },
  };
  for (const [name, forge] of Object.entries(forgeries)) {
    const value = structuredClone(receipt);
    forge(value);
    assert.throws(() => requireHeadVerification(reseal(value)),
      error => error instanceof HeadVerificationError && error.code === 'HeadVerificationInvalid', name);
  }
});

function cli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', windowsHide: true });
}

test('CLI: a passing head exits 0 and leaves a receipt the verifier accepts', () => {
  const { repo, base, head } = fixture();
  const out = join(scratch, `receipt-${fixtures += 1}.json`);
  const run = cli(repo, ['--base', base, '--evidence-dir', evidenceDir(), '--out', out]);

  assert.equal(run.status, 0, run.stderr);
  const receipt = requireHeadVerification(JSON.parse(readFileSync(out, 'utf8')));
  assert.equal(receipt.headSha, head);
  assert.equal(receipt.verification.passed, true);
  assert.match(run.stdout, new RegExp(`^Head verification: PASS \\| head ${head.slice(0, 12)} \\| base ${base.slice(0, 12)} `, 'u'));
  assert.match(run.stdout, /tests 1 \| pass 1 \| fail 0/u);
  assert.match(run.stdout, new RegExp(`receipt ${receipt.revision}`, 'u'));
});

test('CLI: a failing head exits 1 and still leaves its receipt', () => {
  const { repo, base } = fixture({ testSource: FAILING });
  const out = join(scratch, `receipt-${fixtures += 1}.json`);
  const run = cli(repo, ['--base', base, '--evidence-dir', evidenceDir(), '--out', out]);

  assert.equal(run.status, 1, run.stderr);
  assert.equal(requireHeadVerification(JSON.parse(readFileSync(out, 'utf8'))).verification.passed, false);
  assert.match(run.stdout, /^Head verification: FAIL /u);
});

test('CLI: a refusal or a usage error exits 2 and writes no receipt; an existing receipt is never replaced', () => {
  const pinned = fixture({ pin: '0.0.1' });
  const out = join(scratch, `receipt-${fixtures += 1}.json`);
  const refused = cli(pinned.repo, ['--base', pinned.base, '--evidence-dir', evidenceDir(), '--out', out]);
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /VerificationRuntimeMismatch/u);
  assert.equal(existsSync(out), false);

  const { repo, base } = fixture();
  const flagAsValue = ['--base', base, '--evidence-dir', evidenceDir(), '--out', '--worktree'];
  for (const args of [[], ['--base', base], ['--base', base, '--out', out], ['--bogus', 'x'], ['stray'], flagAsValue]) {
    const run = cli(repo, args);
    assert.equal(run.status, 2, args.join(' '));
    assert.equal(existsSync(out), false);
  }
  assert.equal(existsSync(join(repo, '--worktree')), false, 'a flag is never taken as a value');

  writeFileSync(out, 'earlier receipt\n', 'utf8');
  const unused = evidenceDir();
  const kept = cli(repo, ['--base', base, '--evidence-dir', unused, '--out', out]);
  assert.equal(kept.status, 2);
  assert.match(kept.stderr, /ReceiptExists/u);
  assert.equal(readFileSync(out, 'utf8'), 'earlier receipt\n');
  assert.equal(existsSync(unused), false, 'an existing receipt stops the CLI before any run reserves evidence');
});
