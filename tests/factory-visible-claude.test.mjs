import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVisibleClaudeAdapters } from '../src/factory-visible-claude.mjs';

test('visible worker returns bound evidence only after its provider has stopped', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'gaia-visible-test-'));
  let stopped = false;
  const adapters = createVisibleClaudeAdapters({
    isInteractive: () => true,
    launch: (request) => {
      let close;
      const closed = new Promise((resolve) => { close = resolve; });
      writeFileSync(request.resultPath, JSON.stringify({
        schema: 'gaia-visible-agent-result/1', binding: request.binding,
        status: 'completed', summary: 'Changed the requested fixture.',
      }));
      return { closed, stop: async () => { stopped = true; close(); } };
    },
  });
  try {
    const result = await adapters.runWorker({ cwd, task: 'Change fixture', baseHead: 'a'.repeat(40) });
    assert.equal(stopped, true);
    assert.equal(result.provider, 'claude-subscription');
    assert.equal(JSON.parse(result.output).summary, 'Changed the requested fixture.');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

test('visible profile refuses a noninteractive caller without launching a provider', async () => {
  const adapters = createVisibleClaudeAdapters({
    isInteractive: () => false,
    launch: () => { assert.fail('must not launch'); },
  });
  await assert.rejects(adapters.runWorker({ cwd: '.', task: 'x' }), { code: 'InteractiveRequired' });
});

for (const scenario of ['wrong-binding', 'failed', 'exit', 'timeout', 'shutdown-mutation', 'cleanup-failed']) {
  test(`visible provider ${scenario} cannot become successful execution`, async () => {
    let stopped = false;
    const adapters = createVisibleClaudeAdapters({
      isInteractive: () => true,
      launch: (request) => {
        let close;
        const closed = new Promise((resolve) => { close = resolve; });
        if (!['exit', 'timeout'].includes(scenario)) {
          writeFileSync(request.resultPath, JSON.stringify({
            schema: 'gaia-visible-agent-result/1',
            binding: scenario === 'wrong-binding' ? 'old-attempt' : request.binding,
            status: scenario === 'failed' ? 'failed' : 'completed', summary: 'fixture',
          }));
        }
        if (scenario === 'exit') close({ code: 1 });
        return { closed, stop: async () => {
          stopped = true;
          close({ code: 0 });
          if (scenario === 'shutdown-mutation') writeFileSync(request.resultPath, '{}');
          if (scenario === 'cleanup-failed') throw new Error('cleanup refused');
        } };
      },
    });
    await assert.rejects(adapters.runWorker({ cwd: '.', task: 'fixture', baseHead: 'a'.repeat(40) }, { timeoutMs: 10 }));
    assert.equal(stopped, true);
  });
}

test('review verdict is obtained through a fresh restricted visible invocation', async () => {
  const identities = [];
  const adapters = createVisibleClaudeAdapters({
    isInteractive: () => true,
    launch: (request) => {
      identities.push(request.binding);
      assert.equal(request.args.includes('--print'), false);
      assert.equal(request.args.includes('--dangerously-skip-permissions'), false);
      assert.equal(request.args.includes('--restricted'), true);
      assert.equal(request.env.ANTHROPIC_API_KEY, undefined);
      let close;
      const closed = new Promise((resolve) => { close = resolve; });
      writeFileSync(request.resultPath, JSON.stringify({
        schema: 'gaia-visible-agent-result/1', binding: request.binding,
        status: 'completed', summary: 'Read candidate; no commands run.', verdict: 'REQUEST_CHANGES',
      }));
      return { closed, stop: async () => close() };
    },
  });
  const context = { cwd: '.', task: 'review', changeSet: { identity: 'candidate-1' }, env: { ANTHROPIC_API_KEY: 'not-forwarded' } };
  assert.equal((await adapters.runReviewer(context)).verdict, 'REQUEST_CHANGES');
  assert.equal((await adapters.runReviewer(context)).verdict, 'REQUEST_CHANGES');
  assert.notEqual(identities[0], identities[1]);
});

test('a provider crash cannot be accepted even if a completion file was already written', async () => {
  const adapters = createVisibleClaudeAdapters({
    isInteractive: () => true,
    launch: (request) => {
      writeFileSync(request.resultPath, JSON.stringify({ schema: 'gaia-visible-agent-result/1',
        binding: request.binding, status: 'completed', summary: 'then crashed' }));
      return { closed: Promise.resolve({ code: 1 }), stop: async () => {} };
    },
  });
  await assert.rejects(adapters.runWorker({ cwd: '.', task: 'fixture' }), { code: 'AgentFailed' });
});
