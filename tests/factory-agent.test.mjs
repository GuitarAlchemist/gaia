import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildClaudeRepairInvocation,
  buildClaudeWorkerInvocation,
  buildCodexReviewerInvocation,
  buildPiWorkerInvocation,
  buildPiReviewerInvocation,
  FactoryAgentError,
  executeAgentFactory,
  measureAgentFactoryChangeSet,
  runBoundedInvocation,
  runPiWorker,
  runPiReviewer,
} from '../src/factory-agent.mjs';
import {
  changeHidingRows, holdTimestamp, patchSubstitutingRows, pre256Status, primeThenChange, rawStatus,
  untrackedHidingRows, withEnvironment,
} from './helpers/ambient-git.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-factory-agent-'));

test.after(() => rmSync(scratch, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(name) {
  const repo = join(scratch, `${name}-repo`);
  const worktree = join(scratch, `${name}-worktree`);
  git(scratch, 'init', repo);
  git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  writeFileSync(join(repo, 'candidate.txt'), 'before\n', 'utf8');
  git(repo, 'add', 'candidate.txt');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'worktree', 'add', '-b', `gaia-${name}`, worktree, 'HEAD');
  return { repo, worktree };
}

const evidenceDir = (name) => join(scratch, `${name}-evidence`);

test('refuses a primary checkout instead of risking the caller repository', async () => {
  const { repo } = fixture('primary-refusal');

  await assert.rejects(
    executeAgentFactory({
      worktree: repo,
      evidenceDir: evidenceDir('primary-refusal'),
      task: 'change candidate.txt',
      runWorker: async () => ({ output: 'unused' }),
      runReviewer: async () => ({ verdict: 'APPROVE', output: 'unused' }),
    }),
    (error) => error instanceof FactoryAgentError && error.code === 'LinkedWorktreeRequired',
  );
});

test('refuses a .git file that Git cannot read as GitWorktreeRequired, not a raw Git failure', async () => {
  const path = join(scratch, 'unreadable-gitfile');
  mkdirSync(path);
  writeFileSync(join(path, '.git'), 'gitdir: nowhere\n', 'utf8');

  await assert.rejects(
    executeAgentFactory({
      worktree: path,
      evidenceDir: evidenceDir('unreadable-gitfile'),
      task: 'change candidate.txt',
      runWorker: async () => ({ output: 'unused' }),
      runReviewer: async () => ({ verdict: 'APPROVE', output: 'unused' }),
    }),
    (error) => error instanceof FactoryAgentError && error.code === 'GitWorktreeRequired',
  );
});

test('an ambient GIT_DIR cannot redirect the factory to another repository', async () => {
  // A hook exports GIT_DIR to its children (githooks(5)). Before #224 every factory Git call
  // inherited it, so a valid linked worktree was read as the other repository and refused.
  const { worktree } = fixture('ambient-worktree');
  const other = join(scratch, 'ambient-other');
  git(scratch, 'init', other);
  git(other, '-c', 'user.name=Gaia Test', '-c', 'user.email=gaia@example.invalid',
    'commit', '--allow-empty', '-m', 'another repository');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const saved = process.env.GIT_DIR;
  let receipt;
  try {
    process.env.GIT_DIR = join(other, '.git');
    receipt = await executeAgentFactory({
      worktree,
      evidenceDir: evidenceDir('ambient'),
      task: 'change candidate.txt',
      runWorker: async ({ cwd }) => {
        writeFileSync(join(cwd, 'candidate.txt'), 'after\n', 'utf8');
        return { provider: 'fixture-worker', output: 'worker complete' };
      },
      runReviewer: async () => ({ provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'ok' }),
    });
  } finally {
    if (saved === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = saved;
  }

  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.base.head, head);
  assert.deepEqual(receipt.changeSet.files.map(({ path, state }) => [path, state]), [
    ['candidate.txt', 'present'],
  ]);
});

test('binds a real worker change and independent approval into one receipt', async () => {
  const { worktree } = fixture('approved');

  const receipt = await executeAgentFactory({
    worktree,
    evidenceDir: evidenceDir('approved'),
    task: 'change candidate.txt',
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'after\n', 'utf8');
      writeFileSync(join(cwd, 'evidence.txt'), 'evidence\n', 'utf8');
      return { provider: 'fixture-worker', output: 'worker complete' };
    },
    runReviewer: async ({ changeSet }) => ({
      provider: 'fixture-reviewer',
      verdict: 'APPROVE',
      output: `reviewed ${changeSet.files.length} files`,
    }),
  });

  assert.equal(receipt.schema, 'gaia-agent-factory-receipt/1');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.base.head.length, 40);
  assert.equal(receipt.worker.provider, 'fixture-worker');
  assert.equal(receipt.reviewer.provider, 'fixture-reviewer');
  assert.equal(receipt.reviewer.verdict, 'APPROVE');
  assert.deepEqual(receipt.changeSet.files.map(({ path, state }) => [path, state]), [
    ['candidate.txt', 'present'],
    ['evidence.txt', 'present'],
  ]);
  assert.equal(receipt.changeSet.files[0].bytes, 6);
  assert.match(receipt.changeSet.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.changeSet.identity, /^[0-9a-f]{64}$/);
  assert.match(receipt.worker.evidence.sha256, /^[0-9a-f]{64}$/);
  assert.match(receipt.reviewer.evidence.sha256, /^[0-9a-f]{64}$/);
  assert.equal(Object.hasOwn(receipt, 'repair'), false);
  assert.equal(Object.hasOwn(receipt, 'reviews'), false);
});

test('fails closed when REQUEST_CHANGES has no explicit repair adapter', async () => {
  const { worktree } = fixture('request-changes');

  await assert.rejects(executeAgentFactory({
    worktree,
    evidenceDir: evidenceDir('request-changes'),
    task: 'change candidate.txt',
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'incorrect\n', 'utf8');
      return { provider: 'fixture-worker', output: 'done' };
    },
    runReviewer: async () => ({
      provider: 'fixture-reviewer', verdict: 'REQUEST_CHANGES', output: 'wrong bytes',
    }),
  }), (error) => error instanceof FactoryAgentError && error.code === 'RepairAdapterRequired');
});

test('stops rejected after one repair and one fresh REQUEST_CHANGES review', async () => {
  const { worktree } = fixture('repair-rejected');
  let reviews = 0;
  let repairs = 0;
  const receipt = await executeAgentFactory({
    worktree,
    evidenceDir: evidenceDir('repair-rejected'),
    task: 'change candidate.txt correctly',
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'incorrect\n', 'utf8');
      return { provider: 'fixture-worker', output: 'worker' };
    },
    runReviewer: async () => {
      reviews += 1;
      return {
        provider: `fixture-reviewer-${reviews}`,
        verdict: 'REQUEST_CHANGES',
        output: reviews === 1 ? 'B01 remains' : 'B02 remains after repair',
      };
    },
    runRepair: async ({ cwd }) => {
      repairs += 1;
      writeFileSync(join(cwd, 'candidate.txt'), 'different but still wrong\n', 'utf8');
      return { provider: 'fixture-repair', output: 'one repair' };
    },
  });

  assert.equal(receipt.status, 'rejected');
  assert.equal(receipt.reviewer.verdict, 'REQUEST_CHANGES');
  assert.equal(receipt.reviewer.provider, 'fixture-reviewer-2');
  assert.equal(receipt.reviews.initial.provider, 'fixture-reviewer-1');
  assert.equal(reviews, 2);
  assert.equal(repairs, 1, 'there is no repair loop');
});

for (const [name, expectedCode, runRepair] of [
  ['repair protocol failure', 'RepairProtocol', async () => ({ output: 'missing provider' })],
  ['repair no-change failure', 'RepairNoChange', async () => ({
    provider: 'fixture-repair', output: 'claimed repair without bytes',
  })],
  ['repair control-state failure', 'RepairGitMutation', async ({ cwd }) => {
    writeFileSync(join(cwd, 'candidate.txt'), 'repair and stage\n', 'utf8');
    git(cwd, 'add', 'candidate.txt');
    return { provider: 'fixture-repair', output: 'staged' };
  }],
]) {
  test(`fails closed on ${name}`, async () => {
    const { worktree } = fixture(name.replaceAll(' ', '-'));
    await assert.rejects(executeAgentFactory({
      worktree,
      evidenceDir: evidenceDir(name.replaceAll(' ', '-')),
      task: 'change candidate.txt',
      runWorker: async ({ cwd }) => {
        writeFileSync(join(cwd, 'candidate.txt'), 'incorrect\n', 'utf8');
        return { provider: 'fixture-worker', output: 'worker' };
      },
      runReviewer: async () => ({
        provider: 'fixture-reviewer', verdict: 'REQUEST_CHANGES', output: 'B01',
      }),
      runRepair,
    }), (error) => error instanceof FactoryAgentError && error.code === expectedCode);
  });
}

test('runs exactly one bounded repair and makes the fresh final review authoritative', async () => {
  const { worktree } = fixture('repair-approved');
  const reviewCalls = [];
  let repairCalls = 0;

  const receipt = await executeAgentFactory({
    worktree,
    evidenceDir: evidenceDir('repair-approved'),
    task: 'change candidate.txt correctly',
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'incorrect\n', 'utf8');
      return { provider: 'fixture-worker', output: 'initial worker output' };
    },
    runReviewer: async ({ changeSet }) => {
      reviewCalls.push(changeSet.identity);
      if (reviewCalls.length === 1) {
        return {
          provider: 'fixture-reviewer-initial',
          verdict: 'REQUEST_CHANGES',
          output: 'FINDING B01: candidate.txt must contain correct bytes',
        };
      }
      assert.equal(readFileSync(join(worktree, 'candidate.txt'), 'utf8'), 'correct\n');
      return {
        provider: 'fixture-reviewer-final', verdict: 'APPROVE', output: 'final approval',
      };
    },
    runRepair: async ({ cwd, initialCandidate, findings }) => {
      repairCalls += 1;
      assert.equal(initialCandidate.identity, reviewCalls[0]);
      assert.equal(findings, 'FINDING B01: candidate.txt must contain correct bytes');
      writeFileSync(join(cwd, 'candidate.txt'), 'correct\n', 'utf8');
      return { provider: 'fixture-repair', output: 'repair output' };
    },
  });

  assert.equal(repairCalls, 1);
  assert.equal(reviewCalls.length, 2, 'there is one initial and one fresh final review');
  assert.notEqual(reviewCalls[0], reviewCalls[1]);
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.reviewer.provider, 'fixture-reviewer-final');
  assert.equal(receipt.reviewer.verdict, 'APPROVE');
  assert.equal(receipt.repair.provider, 'fixture-repair');
  assert.equal(receipt.reviews.initial.verdict, 'REQUEST_CHANGES');
  assert.equal(receipt.reviews.final.verdict, 'APPROVE');
  assert.equal(receipt.changeSet.identity, reviewCalls[1]);
  const evidencePaths = [
    receipt.worker.evidence.path,
    receipt.reviews.initial.evidence.path,
    receipt.repair.evidence.path,
    receipt.reviews.final.evidence.path,
  ];
  assert.equal(new Set(evidencePaths).size, 4, 'each actor has distinct evidence');
});

test('fails closed when the reviewer mutates worker output', async () => {
  const { worktree } = fixture('reviewer-mutation');

  await assert.rejects(
    executeAgentFactory({
      worktree,
      evidenceDir: evidenceDir('reviewer-mutation'),
      task: 'change candidate.txt',
      runWorker: async ({ cwd }) => {
        writeFileSync(join(cwd, 'candidate.txt'), 'worker bytes\n', 'utf8');
        return { provider: 'fixture-worker', output: 'done' };
      },
      runReviewer: async ({ cwd }) => {
        writeFileSync(join(cwd, 'candidate.txt'), 'reviewer bytes\n', 'utf8');
        return { provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'approve' };
      },
    }),
    (error) => error instanceof FactoryAgentError && error.code === 'ReviewerMutation',
  );

  assert.equal(readFileSync(join(worktree, 'candidate.txt'), 'utf8'), 'reviewer bytes\n');
});

test('Claude worker profile is shell-free and strips alternate paid-provider routes', () => {
  const invocation = buildClaudeWorkerInvocation({
    cwd: 'C:\\fixture worktree',
    task: 'change candidate.txt',
    env: {
      PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture',
      ANTHROPIC_API_KEY: 'must-not-leak', ANTHROPIC_AUTH_TOKEN: 'must-not-leak',
      CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1',
      OPENAI_API_KEY: 'must-not-leak', AWS_SECRET_ACCESS_KEY: 'must-not-leak',
    },
  });

  assert.equal(invocation.command, 'claude');
  assert.equal(invocation.cwd, 'C:\\fixture worktree');
  assert.equal(invocation.shell, false);
  assert.equal(invocation.env.PATH, 'fixture-path');
  assert.deepEqual(Object.keys(invocation.env).sort(), ['PATH', 'USERPROFILE']);
  assert.ok(invocation.args.includes('--dangerously-skip-permissions'));
  assert.ok(invocation.args.includes('--no-session-persistence'));
  assert.match(invocation.args.at(-1), /change candidate\.txt/);
  assert.match(invocation.args.at(-1), /Do not commit, push, install/i);
});

test('Claude repair profile binds the initial candidate and exact findings without new authority', () => {
  const invocation = buildClaudeRepairInvocation({
    cwd: 'C:\\fixture worktree',
    task: 'change candidate.txt',
    initialCandidate: { identity: 'b'.repeat(64) },
    findings: 'B01 exact reviewer finding',
    env: {
      PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture',
      ANTHROPIC_API_KEY: 'must-not-leak', OPENAI_API_KEY: 'must-not-leak',
    },
  });

  assert.equal(invocation.command, 'claude');
  assert.equal(invocation.shell, false);
  assert.deepEqual(Object.keys(invocation.env).sort(), ['PATH', 'USERPROFILE']);
  assert.match(invocation.args.at(-1), new RegExp('b{64}', 'u'));
  assert.match(invocation.args.at(-1), /B01 exact reviewer finding/u);
  assert.match(invocation.args.at(-1), /one bounded repair worker/u);
  assert.match(invocation.args.at(-1), /Do not commit, push, install/u);
});

test('Codex reviewer profile is ephemeral, read-only, and strips API routes', () => {
  const invocation = buildCodexReviewerInvocation({
    cwd: 'C:\\fixture worktree',
    task: 'change candidate.txt',
    changeSet: { identity: 'a'.repeat(64), files: [{ path: 'candidate.txt' }] },
    env: {
      PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture',
      OPENAI_API_KEY: 'must-not-leak', OPENAI_BASE_URL: 'https://paid.invalid',
      AZURE_OPENAI_API_KEY: 'must-not-leak', ANTHROPIC_API_KEY: 'must-not-leak',
    },
  });

  assert.equal(invocation.command, 'codex');
  assert.equal(invocation.cwd, 'C:\\fixture worktree');
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.args.slice(0, 4), [
    'exec', '--ephemeral', '--sandbox', 'read-only',
  ]);
  assert.match(invocation.args.at(-1), /VERDICT: APPROVE/);
  assert.match(invocation.args.at(-1), /aaaaaaaa/);
  assert.deepEqual(Object.keys(invocation.env).sort(), ['PATH', 'USERPROFILE']);
});

test('Pi reviewer profile is an ephemeral read-only Codex subscription invocation', () => {
  const invocation = buildPiReviewerInvocation({
    cwd: 'C:\\fixture worktree',
    task: 'change candidate.txt',
    changeSet: { identity: 'c'.repeat(64), files: [{ path: 'candidate.txt' }] },
    env: {
      PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture',
      OPENAI_API_KEY: 'must-not-leak', ANTHROPIC_API_KEY: 'must-not-leak',
      PI_TELEMETRY: '1',
    },
  });

  assert.equal(invocation.command, 'pi');
  assert.equal(invocation.cwd, 'C:\\fixture worktree');
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.env, {
    PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture', PI_TELEMETRY: '0',
  });
  assert.deepEqual(invocation.args.slice(0, 10), [
    '--provider', 'openai-codex', '--model', 'gpt-5.6-luna', '--thinking', 'medium',
    '--print', '--no-session', '--no-context-files', '--no-extensions',
  ]);
  assert.ok(invocation.args.includes('--no-skills'));
  assert.ok(invocation.args.includes('--no-approve'));
  assert.equal(invocation.args.includes('--approve'), false);
  assert.deepEqual(invocation.args.slice(
    invocation.args.indexOf('--tools'), invocation.args.indexOf('--tools') + 2,
  ), ['--tools', 'read,grep,find,ls']);
  assert.match(invocation.args.at(-1), /VERDICT: APPROVE/u);
  assert.match(invocation.args.at(-1), /cccccccc/u);
});

test('Pi worker profile is read-only and requests one machine-validated patch proposal', () => {
  const invocation = buildPiWorkerInvocation({
    cwd: 'C:\\fixture worktree',
    task: 'change the bounded files',
    allowedPaths: ['src/allowed.mjs', 'tests/allowed.test.mjs'],
    env: {
      PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture',
      OPENAI_API_KEY: 'must-not-leak', ANTHROPIC_API_KEY: 'must-not-leak',
      PI_TELEMETRY: '1',
    },
  });

  assert.equal(invocation.command, 'pi');
  assert.equal(invocation.cwd, 'C:\\fixture worktree');
  assert.equal(invocation.shell, false);
  assert.deepEqual(invocation.env, {
    PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture', PI_TELEMETRY: '0',
  });
  assert.ok(invocation.args.includes('--no-session'));
  assert.ok(invocation.args.includes('--no-context-files'));
  assert.ok(invocation.args.includes('--no-extensions'));
  assert.ok(invocation.args.includes('--no-skills'));
  assert.ok(invocation.args.includes('--no-approve'));
  assert.equal(invocation.args.includes('--approve'), false);
  assert.deepEqual(invocation.args.slice(
    invocation.args.indexOf('--tools'), invocation.args.indexOf('--tools') + 2,
  ), ['--tools', 'read,grep,find,ls']);
  assert.match(invocation.args.at(-1), /src\/allowed\.mjs/u);
  assert.match(invocation.args.at(-1), /tests\/allowed\.test\.mjs/u);
  assert.match(invocation.args.at(-1), /Do not commit, push, install/u);
  assert.match(invocation.args.at(-1), /gaia-pi-patch\/1/u);
  assert.match(invocation.args.at(-1), /JSON document/u);
  assert.match(invocation.args.at(-1), /Do not modify files/u);
});

test('Pi worker proves OAuth readiness and applies one exact allowed patch proposal', async () => {
  const { worktree } = fixture('pi-worker-allowed');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const invocations = [];

  const result = await runPiWorker({
    cwd: worktree,
    task: 'change candidate.txt',
    allowedPaths: ['candidate.txt'],
    baseline: { head },
    env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
  }, {
    timeoutMs: 4321,
    runInvocation: async (invocation, options) => {
      invocations.push({ invocation, options });
      if (invocation.args[0] === 'auth') {
        return {
          code: 0, signal: null, stderr: '',
          stdout: '{"status":"ready","provider":"openai-codex","authType":"oauth"}\n',
        };
      }
      const patch = [
        'diff --git a/candidate.txt b/candidate.txt',
        '--- a/candidate.txt',
        '+++ b/candidate.txt',
        '@@ -1 +1 @@',
        '-before',
        '+after',
        '',
      ].join('\n');
      return {
        code: 0, signal: null, stderr: '',
        stdout: `${JSON.stringify({ schema: 'gaia-pi-patch/1', patch })}\n`,
      };
    },
  });

  assert.equal(result.provider, 'pi-openai-codex-subscription');
  assert.match(result.output, /gaia-pi-patch\/1/u);
  assert.deepEqual(result.observedPaths, ['candidate.txt']);
  assert.equal(
    readFileSync(join(worktree, 'candidate.txt'), 'utf8').replaceAll('\r\n', '\n'),
    'after\n',
  );
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].invocation.args, [
    'auth', 'check', '--provider', 'openai-codex', '--json',
  ]);
  assert.equal(invocations[0].invocation.cwd, 'C:\\Users\\fixture');
  assert.deepEqual(invocations.map(({ options }) => options), [
    { timeoutMs: 4321 }, { timeoutMs: 4321 },
  ]);
});

test('ambient Git configuration cannot relax the whitespace gate on a Pi worker patch', async () => {
  // gitInput runs `git apply --whitespace=error-all`, and core.whitespace decides which whitespace
  // is an error. A repository named by an inherited locator (#244) or a configuration source the
  // process inherits (#248) could drop trailing-space and let this patch through.
  const { worktree } = fixture('pi-worker-ambient-whitespace');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const relaxed = '-trailing-space,-blank-at-eof';
  const other = join(scratch, 'pi-worker-ambient-whitespace-other');
  git(scratch, 'init', other);
  git(other, 'config', 'core.whitespace', relaxed);
  // A repository's own attributes outrank every command-line pin, so only the neutral
  // environment keeps another repository's out of the gate.
  writeFileSync(join(other, '.git', 'info', 'attributes'), `* whitespace=${relaxed}\n`, 'utf8');
  const globalConfig = join(scratch, 'pi-worker-ambient-whitespace.gitconfig');
  writeFileSync(globalConfig, `[core]\n\twhitespace = ${relaxed}\n`, 'utf8');
  const home = join(scratch, 'pi-worker-ambient-whitespace-home');
  mkdirSync(home);
  writeFileSync(join(home, '.gitconfig'), `[core]\n\twhitespace = ${relaxed}\n`, 'utf8');
  // A global attributes file overrides core.whitespace per path. The row names it through
  // XDG_CONFIG_HOME, which Git prefers over $HOME/.config and which a Linux runner already sets.
  const xdgConfig = join(scratch, 'pi-worker-ambient-whitespace-xdg');
  mkdirSync(join(xdgConfig, 'git'), { recursive: true });
  writeFileSync(join(xdgConfig, 'git', 'attributes'), `* whitespace=${relaxed}\n`, 'utf8');
  const rows = {
    clean: {},
    GIT_DIR: { GIT_DIR: join(other, '.git') },
    GIT_COMMON_DIR: { GIT_COMMON_DIR: join(other, '.git') },
    GIT_CONFIG_COUNT: {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.whitespace', GIT_CONFIG_VALUE_0: relaxed,
    },
    GIT_CONFIG_PARAMETERS: { GIT_CONFIG_PARAMETERS: `'core.whitespace=${relaxed}'` },
    GIT_CONFIG_GLOBAL: { GIT_CONFIG_GLOBAL: globalConfig },
    HOME: { HOME: home, USERPROFILE: undefined, HOMEDRIVE: undefined, HOMEPATH: undefined },
    attributes: { XDG_CONFIG_HOME: xdgConfig },
  };
  const patch = [
    'diff --git a/candidate.txt b/candidate.txt',
    '--- a/candidate.txt',
    '+++ b/candidate.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after ',
    '',
  ].join('\n');

  const rawGit = {};
  const outcome = {};
  const bytes = {};
  for (const [row, overrides] of Object.entries(rows)) {
    const saved = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
    try {
      for (const [key, value] of Object.entries(overrides)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      try {
        execFileSync('git', ['apply', '--check', '--whitespace=error-all', '-'], {
          cwd: worktree, input: patch, stdio: ['pipe', 'pipe', 'pipe'],
        });
        rawGit[row] = 'accepted';
      } catch {
        rawGit[row] = 'refused';
      }
      outcome[row] = await runPiWorker({
        cwd: worktree,
        task: 'change candidate.txt',
        allowedPaths: ['candidate.txt'],
        baseline: { head },
        env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
      }, {
        runInvocation: async (invocation) => (invocation.args[0] === 'auth'
          ? {
            code: 0, signal: null, stderr: '',
            stdout: '{"status":"ready","provider":"openai-codex","authType":"oauth"}\n',
          }
          : {
            code: 0, signal: null, stderr: '',
            stdout: `${JSON.stringify({ schema: 'gaia-pi-patch/1', patch })}\n`,
          }),
      }).then(
        () => 'accepted',
        (error) => (error instanceof FactoryAgentError ? error.code : String(error)),
      );
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    bytes[row] = readFileSync(join(worktree, 'candidate.txt'), 'utf8').replaceAll('\r\n', '\n');
    git(worktree, 'checkout', '--', 'candidate.txt');
  }

  // Non-vacuity: every row but the control makes Git itself accept the patch.
  assert.deepEqual(rawGit, Object.fromEntries(Object.keys(rows).map((row) => [
    row, row === 'clean' ? 'refused' : 'accepted',
  ])));
  assert.deepEqual(outcome, Object.fromEntries(Object.keys(rows).map((row) => [
    row, 'WorkerPatchRejected',
  ])));
  assert.deepEqual(bytes, Object.fromEntries(Object.keys(rows).map((row) => [row, 'before\n'])));
});

test('ambient Git configuration cannot hide an untracked file from the Pi worker entry check', async () => {
  // A worktree's own .gitattributes outranks the whitespace gate's pins (#250), so the entry
  // check is what keeps an untracked one out. Its `git status` obeyed status.showUntrackedFiles
  // and the excludes file from every configuration source the process inherits (#251).
  const { worktree } = fixture('pi-worker-hidden-untracked');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const rows = untrackedHidingRows(join(scratch, 'pi-worker-hidden-untracked-config'), '.gitattributes');
  writeFileSync(join(worktree, '.gitattributes'), '* -whitespace\n', 'utf8');
  const patch = [
    'diff --git a/candidate.txt b/candidate.txt',
    '--- a/candidate.txt',
    '+++ b/candidate.txt',
    '@@ -1 +1 @@',
    '-before',
    '+after ',
    '',
  ].join('\n');

  const rawGit = {};
  const outcome = {};
  const bytes = {};
  for (const [row, overrides] of Object.entries(rows)) {
    await withEnvironment(overrides, async () => {
      rawGit[row] = rawStatus(worktree);
      outcome[row] = await runPiWorker({
        cwd: worktree,
        task: 'change candidate.txt',
        allowedPaths: ['candidate.txt'],
        baseline: { head },
        env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
      }, {
        runInvocation: async (invocation) => (invocation.args[0] === 'auth'
          ? {
            code: 0, signal: null, stderr: '',
            stdout: '{"status":"ready","provider":"openai-codex","authType":"oauth"}\n',
          }
          : {
            code: 0, signal: null, stderr: '',
            stdout: `${JSON.stringify({ schema: 'gaia-pi-patch/1', patch })}\n`,
          }),
      }).then(
        () => 'accepted',
        (error) => (error instanceof FactoryAgentError ? error.code : String(error)),
      );
    });
    bytes[row] = readFileSync(join(worktree, 'candidate.txt'), 'utf8').replaceAll('\r\n', '\n');
    git(worktree, 'checkout', '--', 'candidate.txt');
  }

  // Non-vacuity: every row but the control hides the file from Git itself.
  assert.deepEqual(rawGit, Object.fromEntries(Object.keys(rows).map((row) => [
    row, row === 'clean' ? 'shown' : 'hidden',
  ])));
  assert.deepEqual(outcome, Object.fromEntries(Object.keys(rows).map((row) => [
    row, 'CleanWorktreeRequired',
  ])));
  assert.deepEqual(bytes, Object.fromEntries(Object.keys(rows).map((row) => [row, 'before\n'])));
});

test('ambient Git configuration cannot change what a change set measures', async () => {
  // A change set records the status bytes and every untracked file, and the publisher binds the
  // same measurement. `git status` and `git ls-files --exclude-standard` obeyed the ambient
  // settings that hide a file from the entry check (#251).
  const { worktree } = fixture('change-set-hidden-untracked');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const rows = untrackedHidingRows(join(scratch, 'change-set-hidden-untracked-config'), 'stray.txt');
  writeFileSync(join(worktree, 'stray.txt'), 'stray\n', 'utf8');

  const rawGit = {};
  const measured = {};
  for (const [row, overrides] of Object.entries(rows)) {
    await withEnvironment(overrides, () => {
      rawGit[row] = rawStatus(worktree);
      measured[row] = measureAgentFactoryChangeSet(worktree, head);
    });
  }

  // Non-vacuity: every row but the control hides the file from Git itself.
  assert.deepEqual(rawGit, Object.fromEntries(Object.keys(rows).map((row) => [
    row, row === 'clean' ? 'shown' : 'hidden',
  ])));
  assert.deepEqual(measured.clean.files.map(({ path }) => path), ['stray.txt']);
  assert.deepEqual(measured, Object.fromEntries(Object.keys(rows).map((row) => [row, measured.clean])));
});

test('an ambient core.fsmonitor cannot hide the worker\'s change from the receipt', async () => {
  // A core.fsmonitor hook tells Git which paths changed since the token a read stored in the index.
  // Before #256 the factory's entry check stored it, and the change set's status and diff then
  // trusted the hook's empty answer: the worker's tracked edit was missing from the receipt the
  // reviewer reviews and the publisher binds.
  const rows = changeHidingRows(join(scratch, 'fsmonitor-receipt-config'));
  const rawGit = {};
  const measured = {};
  let index = 0;
  for (const [row, overrides] of Object.entries(rows)) {
    const { worktree } = fixture(`fsmonitor-receipt-${index += 1}`);
    // Held from before the entry check, which builds the untracked cache first under that row.
    holdTimestamp(worktree);
    await withEnvironment(overrides, async () => {
      const { status, changeSet: { baseHead, identity, ...bytes } } = await executeAgentFactory({
        worktree,
        evidenceDir: evidenceDir(`fsmonitor-receipt-${index}`),
        task: 'change candidate.txt',
        runWorker: async ({ cwd }) => {
          // Any read under the hook stores its token; the factory no longer needs to be the one.
          primeThenChange(cwd, () => {
            writeFileSync(join(cwd, 'candidate.txt'), 'after\n', 'utf8');
            writeFileSync(join(cwd, 'stray.txt'), 'stray\n', 'utf8');
          });
          rawGit[row] = pre256Status(cwd);
          return { provider: 'fixture-worker', output: 'worker complete' };
        },
        runReviewer: async () => ({ provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'ok' }),
      });
      measured[row] = { status, ...bytes };
    });
  }

  // Non-vacuity: under each hook row, the factory's status before #256 misses the worker's change.
  assert.deepEqual(rawGit, {
    clean: ' M candidate.txt|?? stray.txt|',
    fsmonitor: '?? stray.txt|',
    'fsmonitor and untrackedCache': '',
  });
  assert.deepEqual(measured.clean.files.map(({ path }) => path), ['candidate.txt', 'stray.txt']);
  assert.deepEqual(measured, Object.fromEntries(Object.keys(rows).map((row) => [row, measured.clean])));
});

test('an ambient core.fsmonitor cannot hide a change from the Pi worker entry check', async () => {
  // Before #256 a tracked edit made after a read stored the hook's token, or with
  // core.untrackedCache a new file, passed the entry check, and the worker ran on it.
  const rows = changeHidingRows(join(scratch, 'pi-worker-fsmonitor-config'));
  const changes = {
    edit: (cwd) => writeFileSync(join(cwd, 'candidate.txt'), 'edited\n', 'utf8'),
    stray: (cwd) => writeFileSync(join(cwd, 'stray.txt'), 'stray\n', 'utf8'),
  };
  const rawGit = {};
  const outcome = {};
  let invocations = 0;
  let index = 0;
  for (const [row, overrides] of Object.entries(rows)) {
    for (const [change, write] of Object.entries(changes)) {
      const { worktree } = fixture(`pi-worker-fsmonitor-${index += 1}`);
      const head = git(worktree, 'rev-parse', 'HEAD');
      await withEnvironment(overrides, async () => {
        primeThenChange(worktree, write);
        rawGit[`${row} ${change}`] = pre256Status(worktree);
        outcome[`${row} ${change}`] = await runPiWorker({
          cwd: worktree,
          task: 'change candidate.txt',
          allowedPaths: ['candidate.txt'],
          baseline: { head },
          env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
        }, {
          runInvocation: async () => {
            invocations += 1;
            throw new Error('the worker ran');
          },
        }).then(
          () => 'accepted',
          (error) => (error instanceof FactoryAgentError ? error.code : String(error)),
        );
      });
    }
  }

  // Non-vacuity: the factory's status before #256 misses the change in three of the hook cells.
  assert.deepEqual(rawGit, {
    'clean edit': ' M candidate.txt|',
    'clean stray': '?? stray.txt|',
    'fsmonitor edit': '',
    'fsmonitor stray': '?? stray.txt|',
    'fsmonitor and untrackedCache edit': '',
    'fsmonitor and untrackedCache stray': '',
  });
  assert.deepEqual(outcome, Object.fromEntries(Object.keys(rawGit).map((cell) => [
    cell, 'CleanWorktreeRequired',
  ])));
  assert.equal(invocations, 0);
});

test('an ambient core.fsmonitor cannot change what a change set measures', async () => {
  const rows = changeHidingRows(join(scratch, 'change-set-fsmonitor-config'));
  const rawGit = {};
  const measured = {};
  let index = 0;
  for (const [row, overrides] of Object.entries(rows)) {
    const { worktree } = fixture(`change-set-fsmonitor-${index += 1}`);
    const head = git(worktree, 'rev-parse', 'HEAD');
    await withEnvironment(overrides, () => {
      primeThenChange(worktree, () => {
        writeFileSync(join(worktree, 'candidate.txt'), 'after\n', 'utf8');
        writeFileSync(join(worktree, 'stray.txt'), 'stray\n', 'utf8');
      });
      rawGit[row] = pre256Status(worktree);
      const { baseHead, identity, ...bytes } = measureAgentFactoryChangeSet(worktree, head);
      measured[row] = bytes;
    });
  }

  // Non-vacuity: under each hook row, the factory's status before #256 misses the change.
  assert.deepEqual(rawGit, {
    clean: ' M candidate.txt|?? stray.txt|',
    fsmonitor: '?? stray.txt|',
    'fsmonitor and untrackedCache': '',
  });
  assert.equal(measured.clean.statusBytes, 30);
  assert.deepEqual(measured.clean.files.map(({ path }) => path), ['candidate.txt', 'stray.txt']);
  assert.deepEqual(measured, Object.fromEntries(Object.keys(rows).map((row) => [row, measured.clean])));
});

test('no hook from the operator\'s configuration runs during the factory\'s reads', async () => {
  // Git runs the core.fsmonitor hook on every read that consults it, and post-index-change when a
  // read rewrites the index, which `git status` does whenever an entry's timestamp is racy (#256).
  const dir = join(scratch, 'factory-hooks-config');
  const fwd = (path) => path.replaceAll('\\', '/');
  const { fsmonitor } = changeHidingRows(dir);
  const hooks = join(dir, 'hooks');
  mkdirSync(hooks);
  writeFileSync(join(hooks, 'post-index-change'),
    `#!/bin/sh\necho ran >> "${fwd(join(dir, 'post-index-change-ran'))}"\n`, { mode: 0o755 });
  const overrides = {
    ...fsmonitor, GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: fwd(hooks),
  };
  const { worktree } = fixture('factory-hooks');
  const head = git(worktree, 'rev-parse', 'HEAD');
  writeFileSync(join(worktree, 'candidate.txt'), 'after\n', 'utf8');
  const indexFile = git(worktree, 'rev-parse', '--path-format=absolute', '--git-path', 'index');
  // An index file older than every entry makes each entry racy, so a status that may write does.
  const racy = () => utimesSync(indexFile, new Date(2001, 0, 1), new Date(2001, 0, 1));
  const ran = () => ['fsmonitor-ran', 'post-index-change-ran'].filter((name) => existsSync(join(dir, name)));

  racy();
  await withEnvironment(overrides, () => measureAgentFactoryChangeSet(worktree, head));
  const factory = ran();
  racy();
  await withEnvironment(overrides, () => execFileSync('git', ['status', '--porcelain'], {
    cwd: worktree, windowsHide: true,
  }));

  // Non-vacuity: an unpinned `git status` runs both hooks.
  assert.deepEqual({ factory, unpinned: ran() }, {
    factory: [], unpinned: ['fsmonitor-ran', 'post-index-change-ran'],
  });
});

test('an ambient external diff or textconv driver cannot change the patch the reviewer reads', async () => {
  // Before #269 the change set measured whatever `git diff` printed and the Pi reviewer read it
  // under the same environment, so the check that the two agree passed, and the reviewer judged
  // bytes other than the change the publisher sends.
  const rows = patchSubstitutingRows(join(scratch, 'patch-substituting-config'));
  const { worktree } = fixture('patch-substituting');
  const head = git(worktree, 'rev-parse', 'HEAD');
  writeFileSync(join(worktree, 'candidate.txt'), 'after\n', 'utf8');

  const unpinned = {};
  const measured = {};
  const reviewed = {};
  for (const [row, overrides] of Object.entries(rows)) {
    await withEnvironment(overrides, async () => {
      unpinned[row] = execFileSync('git', ['diff', '--binary', head, '--'], {
        cwd: worktree, encoding: 'utf8', windowsHide: true,
      });
      const changeSet = measureAgentFactoryChangeSet(worktree, head);
      measured[row] = { patchBytes: changeSet.patchBytes, patchSha256: changeSet.patchSha256 };
      let prompt = null;
      const outcome = await runPiReviewer({
        cwd: worktree, task: 'change candidate.txt', baseHead: head, changeSet,
        env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
      }, {
        runInvocation: async (invocation) => {
          if (invocation.args[0] === 'auth') {
            return {
              code: 0, signal: null, stderr: '',
              stdout: '{"status":"ready","provider":"openai-codex","authType":"oauth"}\n',
            };
          }
          prompt = invocation.args.at(-1);
          return { code: 0, signal: null, stderr: '', stdout: 'VERDICT: APPROVE\n' };
        },
      }).then(
        ({ verdict }) => verdict,
        (error) => (error instanceof FactoryAgentError ? error.code : String(error)),
      );
      reviewed[row] = { outcome, real: prompt?.includes(unpinned.clean) ?? false };
    });
  }

  // Non-vacuity: under every row but the control, an unpinned `git diff` prints another patch.
  const kind = (row, real) => [row, real ? 'real' : 'substituted'];
  assert.deepEqual(
    Object.fromEntries(Object.entries(unpinned).map(([row, patch]) => kind(row, patch === unpinned.clean))),
    Object.fromEntries(Object.keys(rows).map((row) => kind(row, row === 'clean'))),
  );
  assert.match(unpinned.clean, /^\+after$/mu);
  assert.equal(measured.clean.patchSha256, createHash('sha256').update(unpinned.clean).digest('hex'));
  assert.deepEqual(measured, Object.fromEntries(Object.keys(rows).map((row) => [row, measured.clean])));
  assert.deepEqual(reviewed, Object.fromEntries(Object.keys(rows).map((row) => [
    row, { outcome: 'APPROVE', real: true },
  ])));
});

test('Pi worker refuses an NTFS alternate-data-stream path before authentication', async () => {
  const { worktree } = fixture('pi-worker-ads-refusal');
  const head = git(worktree, 'rev-parse', 'HEAD');
  let called = false;

  await assert.rejects(runPiWorker({
    cwd: worktree,
    task: 'write an invisible stream',
    allowedPaths: ['candidate.txt:gaia-hidden'],
    baseline: { head },
  }, {
    runInvocation: async () => { called = true; },
  }), (error) => error instanceof FactoryAgentError && error.code === 'WorkerScopeInvalid');

  assert.equal(called, false);
});

test('Pi worker refuses an out-of-scope patch before Git creates its target', async () => {
  const { worktree } = fixture('pi-worker-patch-scope');
  const head = git(worktree, 'rev-parse', 'HEAD');
  const patch = [
    'diff --git a/outside.txt b/outside.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/outside.txt',
    '@@ -0,0 +1 @@',
    '+outside',
    '',
  ].join('\n');
  let calls = 0;

  await assert.rejects(runPiWorker({
    cwd: worktree,
    task: 'try an undeclared file',
    allowedPaths: ['candidate.txt'],
    baseline: { head },
    env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
  }, {
    runInvocation: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          code: 0, signal: null, stderr: '',
          stdout: '{"status":"ready","provider":"openai-codex","authType":"oauth"}\n',
        };
      }
      return {
        code: 0, signal: null, stderr: '',
        stdout: `${JSON.stringify({ schema: 'gaia-pi-patch/1', patch })}\n`,
      };
    },
  }), (error) => error instanceof FactoryAgentError && error.code === 'WorkerScopeViolation');

  assert.equal(existsSync(join(worktree, 'outside.txt')), false);
  assert.equal(git(worktree, 'status', '--porcelain'), '');
});

test('Pi worker refuses a direct worktree mutation before considering its proposal', async () => {
  const { worktree } = fixture('pi-worker-direct-mutation');
  const head = git(worktree, 'rev-parse', 'HEAD');
  let calls = 0;

  await assert.rejects(runPiWorker({
    cwd: worktree,
    task: 'must remain a proposal',
    allowedPaths: ['candidate.txt'],
    baseline: { head },
    env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
  }, {
    runInvocation: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          code: 0, signal: null, stderr: '',
          stdout: '{"status":"ready","provider":"openai-codex","authType":"oauth"}\n',
        };
      }
      writeFileSync(join(worktree, 'candidate.txt'), 'mutated directly\n', 'utf8');
      return {
        code: 0, signal: null, stderr: '',
        stdout: '{"schema":"gaia-pi-patch/1","patch":""}\n',
      };
    },
  }), (error) => error instanceof FactoryAgentError && error.code === 'WorkerMutation');
});

test('Pi reviewer proves OAuth readiness before accepting an exact verdict', async () => {
  const invocations = [];
  const patch = 'diff --git a/candidate.txt b/candidate.txt\n+review this exact patch\n';
  const patchSha256 = createHash('sha256').update(patch).digest('hex');
  const result = await runPiReviewer({
    cwd: 'C:\\fixture worktree',
    task: 'change candidate.txt',
    baseHead: 'e'.repeat(40),
    changeSet: {
      identity: 'd'.repeat(64), files: [{ path: 'candidate.txt' }],
      patchBytes: Buffer.byteLength(patch), patchSha256,
    },
    env: { PATH: 'fixture-path', USERPROFILE: 'C:\\Users\\fixture' },
  }, {
    timeoutMs: 4321,
    readPatch: () => patch,
    runInvocation: async (invocation, options) => {
      invocations.push({ invocation, options });
      if (invocation.args[0] === 'auth') {
        return {
          code: 0, signal: null,
          stdout: '{"status":"ready","provider":"openai-codex","authType":"oauth"}\n',
          stderr: '',
        };
      }
      return {
        code: 0, signal: null,
        stdout: 'Reviewed the candidate.\nVERDICT: APPROVE\n', stderr: '',
      };
    },
  });

  assert.equal(result.provider, 'pi-openai-codex-subscription');
  assert.equal(result.verdict, 'APPROVE');
  assert.equal(invocations.length, 2);
  assert.deepEqual(invocations[0].invocation.args, [
    'auth', 'check', '--provider', 'openai-codex', '--json',
  ]);
  assert.equal(invocations[0].invocation.cwd, 'C:\\Users\\fixture');
  assert.equal(invocations[1].invocation.command, 'pi');
  assert.match(invocations[1].invocation.args.at(-1), /review this exact patch/u);
  assert.deepEqual(invocations.map(({ options }) => options), [
    { timeoutMs: 4321 }, { timeoutMs: 4321 },
  ]);
});

test('Pi reviewer refuses API-key readiness before launching a model', async () => {
  const patch = 'diff --git a/candidate.txt b/candidate.txt\n';
  let calls = 0;
  await assert.rejects(runPiReviewer({
    cwd: 'C:\\fixture worktree', task: 'review', baseHead: 'e'.repeat(40),
    changeSet: {
      identity: 'd'.repeat(64), files: [{ path: 'candidate.txt' }],
      patchBytes: Buffer.byteLength(patch),
      patchSha256: createHash('sha256').update(patch).digest('hex'),
    },
  }, {
    readPatch: () => patch,
    runInvocation: async () => {
      calls += 1;
      return {
        code: 0, signal: null, stderr: '',
        stdout: '{"status":"ready","provider":"openai-codex","authType":"api_key"}\n',
      };
    },
  }), (error) => error instanceof FactoryAgentError
    && error.code === 'SubscriptionAuthRequired');
  assert.equal(calls, 1, 'the model invocation must never follow non-OAuth readiness');
});

test('Pi reviewer refuses a patch that does not match the measured candidate', async () => {
  let called = false;
  await assert.rejects(runPiReviewer({
    cwd: 'C:\\fixture worktree', task: 'review', baseHead: 'e'.repeat(40),
    changeSet: {
      identity: 'd'.repeat(64), files: [{ path: 'candidate.txt' }],
      patchBytes: 5, patchSha256: 'a'.repeat(64),
    },
  }, {
    readPatch: () => 'other',
    runInvocation: async () => { called = true; },
  }), (error) => error instanceof FactoryAgentError
    && error.code === 'ReviewerInputMismatch');
  assert.equal(called, false);
});

test('Pi reviewer refuses an oversized patch before authentication or model use', async () => {
  const patch = 'x'.repeat(1_048_577);
  let called = false;
  await assert.rejects(runPiReviewer({
    cwd: 'C:\\fixture worktree', task: 'review', baseHead: 'e'.repeat(40),
    changeSet: {
      identity: 'd'.repeat(64), files: [{ path: 'candidate.txt' }],
      patchBytes: Buffer.byteLength(patch),
      patchSha256: createHash('sha256').update(patch).digest('hex'),
    },
  }, {
    readPatch: () => patch,
    runInvocation: async () => { called = true; },
  }), (error) => error instanceof FactoryAgentError
    && error.code === 'ReviewerInputLimit');
  assert.equal(called, false);
});

test('fails closed when a worker changes HEAD or the Git index', async () => {
  const { worktree } = fixture('worker-commit');
  let reviewerCalled = false;

  await assert.rejects(executeAgentFactory({
    worktree,
    evidenceDir: evidenceDir('worker-commit'),
    task: 'change and commit candidate.txt',
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'committed by worker\n', 'utf8');
      git(cwd, 'add', 'candidate.txt');
      git(cwd, '-c', 'user.name=Gaia Test', '-c', 'user.email=gaia@example.invalid',
        'commit', '-m', 'unauthorized commit');
      return { provider: 'fixture-worker', output: 'committed' };
    },
    runReviewer: async () => {
      reviewerCalled = true;
      return { provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'approve' };
    },
  }), (error) => error instanceof FactoryAgentError && error.code === 'AgentGitMutation');
  assert.equal(reviewerCalled, false);
});

test('rejects a changed file reached through a junction to outside the worktree', {
  skip: process.platform !== 'win32',
}, async () => {
  const { worktree } = fixture('candidate-junction');
  const outside = join(scratch, 'candidate-junction-outside');
  const alias = join(worktree, 'external-alias');
  mkdirSync(outside);
  symlinkSync(outside, alias, 'junction');

  await assert.rejects(executeAgentFactory({
    worktree,
    evidenceDir: evidenceDir('candidate-junction'),
    task: 'write through the alias',
    runWorker: async () => {
      writeFileSync(join(alias, 'external.txt'), 'outside bytes\n', 'utf8');
      return { provider: 'fixture-worker', output: 'done' };
    },
    runReviewer: async () => ({
      provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'approve',
    }),
  }), (error) => error instanceof FactoryAgentError
    && error.code === 'UnsupportedChangedPath');
});

test('detects a reviewer mutation hidden by gitignore', async () => {
  const { worktree } = fixture('ignored-reviewer-mutation');
  writeFileSync(join(worktree, '.gitignore'), 'ignored.txt\n', 'utf8');
  git(worktree, 'add', '.gitignore');
  git(worktree, '-c', 'user.name=Gaia Test', '-c', 'user.email=gaia@example.invalid',
    'commit', '-m', 'ignore fixture');

  await assert.rejects(executeAgentFactory({
    worktree,
    evidenceDir: evidenceDir('ignored-reviewer-mutation'),
    task: 'change candidate.txt',
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'worker bytes\n', 'utf8');
      return { provider: 'fixture-worker', output: 'done' };
    },
    runReviewer: async ({ cwd }) => {
      writeFileSync(join(cwd, 'ignored.txt'), 'reviewer bytes\n', 'utf8');
      return { provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'approve' };
    },
  }), (error) => error instanceof FactoryAgentError && error.code === 'ReviewerMutation');
});

test('refuses a primary submodule checkout as a factory worktree', async () => {
  const child = join(scratch, 'submodule-child');
  const parent = join(scratch, 'submodule-parent');
  git(scratch, 'init', child);
  git(child, 'config', 'user.name', 'Gaia Test');
  git(child, 'config', 'user.email', 'gaia@example.invalid');
  writeFileSync(join(child, 'child.txt'), 'child\n', 'utf8');
  git(child, 'add', 'child.txt');
  git(child, 'commit', '-m', 'child fixture');
  git(scratch, 'init', parent);
  git(parent, 'config', 'user.name', 'Gaia Test');
  git(parent, 'config', 'user.email', 'gaia@example.invalid');
  git(parent, '-c', 'protocol.file.allow=always', 'submodule', 'add', child, 'sub');
  git(parent, 'commit', '-am', 'parent fixture');

  await assert.rejects(executeAgentFactory({
    worktree: join(parent, 'sub'),
    evidenceDir: evidenceDir('submodule-primary'),
    task: 'must not run',
    runWorker: async () => ({ provider: 'unused', output: 'unused' }),
    runReviewer: async () => ({ provider: 'unused', verdict: 'APPROVE', output: 'unused' }),
  }), (error) => error instanceof FactoryAgentError && error.code === 'LinkedWorktreeRequired');
});

test('retains content-addressed worker and reviewer outputs outside the candidate', async () => {
  const { worktree } = fixture('retained-evidence');
  const store = evidenceDir('retained-evidence');
  const receipt = await executeAgentFactory({
    worktree,
    evidenceDir: store,
    task: 'change candidate.txt',
    runWorker: async ({ cwd }) => {
      writeFileSync(join(cwd, 'candidate.txt'), 'after\n', 'utf8');
      return { provider: 'fixture-worker', output: 'worker preimage\n' };
    },
    runReviewer: async () => ({
      provider: 'fixture-reviewer', verdict: 'APPROVE', output: 'review preimage\n',
    }),
  });

  for (const observation of [receipt.worker, receipt.reviewer]) {
    assert.equal(observation.evidence.policy, 'local-sensitive-content-addressed');
    assert.equal(existsSync(observation.evidence.path), true);
    const bytes = readFileSync(observation.evidence.path);
    assert.equal(bytes.byteLength, observation.evidence.bytes);
    assert.match(observation.evidence.path, new RegExp(observation.evidence.sha256, 'u'));
  }
});

test('timeout escalates and waits until a SIGTERM-ignoring child is gone', async () => {
  const started = Date.now();
  await assert.rejects(runBoundedInvocation({
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],
    cwd: scratch,
    env: process.env,
    shell: false,
  }, { timeoutMs: 100, terminationGraceMs: 100 }),
  (error) => error instanceof FactoryAgentError && error.code === 'AgentTimeout');
  assert.ok(Date.now() - started < 3_000);
});

test('output overflow kills the process tree before reporting failure', async () => {
  const marker = join(scratch, 'overflow-child-survived.txt');
  const grandchild = join(scratch, 'overflow-grandchild.mjs');
  const parent = join(scratch, 'overflow-parent.mjs');
  // The grandchild waits before writing its marker, and the assertion below waits
  // longer still, so a tree that was NOT killed is always caught. Both delays are
  // deliberately generous. At 300ms and 500ms this test also imposed an
  // undeclared deadline — kill a process tree within 300ms — which Windows misses
  // under a loaded `node --test`: it passed alone and failed in the full suite,
  // which is a scheduling fact, not a defect in the code under test. What must be
  // proven is that no orphan survives, not how quickly the kill lands.
  writeFileSync(grandchild, [
    "import { writeFileSync } from 'node:fs';",
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'bad'), 3_000);`,
    'setInterval(() => {}, 1_000);',
  ].join('\n'), 'utf8');
  writeFileSync(parent, [
    "import { spawn } from 'node:child_process';",
    `spawn(process.execPath, [${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    "process.stdout.write('x'.repeat(4_096));",
    'setInterval(() => {}, 1_000);',
  ].join('\n'), 'utf8');
  await assert.rejects(runBoundedInvocation({
    command: process.execPath,
    args: [parent],
    cwd: scratch,
    env: process.env,
    shell: false,
  }, { timeoutMs: 2_000, maxOutputBytes: 128, terminationGraceMs: 50 }),
  (error) => error instanceof FactoryAgentError && error.code === 'AgentOutputLimit');
  // Longer than the grandchild's own delay, so an unkilled orphan has finished
  // writing by the time this looks. A shorter wait would pass by racing rather
  // than by the tree actually being dead.
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 4_000));
  assert.equal(existsSync(marker), false);
});
