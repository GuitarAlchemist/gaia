import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  buildClaudeRepairInvocation,
  buildClaudeWorkerInvocation,
  buildCodexReviewerInvocation,
  buildPiReviewerInvocation,
  FactoryAgentError,
  executeAgentFactory,
  runBoundedInvocation,
  runPiReviewer,
} from '../src/factory-agent.mjs';

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
  writeFileSync(grandchild, [
    "import { writeFileSync } from 'node:fs';",
    `setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'bad'), 300);`,
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
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  assert.equal(existsSync(marker), false);
});
