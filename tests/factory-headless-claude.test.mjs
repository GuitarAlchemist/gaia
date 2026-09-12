import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { writeFileSync } from 'node:fs';
import { createHeadlessClaudeAdapters, createVisibleClaudeAdapters } from '../src/factory-visible-claude.mjs';

const context = { cwd: '.', task: 'Change fixture', baseHead: 'a'.repeat(40),
  env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'never-forward', ANTHROPIC_AUTH_TOKEN: 'never-forward' } };

function completed(request, extra = {}) {
  writeFileSync(request.resultPath, JSON.stringify({ schema: 'gaia-visible-agent-result/1',
    binding: request.binding, status: 'completed', summary: 'Fixture changed; tests not run.', ...extra }));
}

test('headless accepts a non-TTY caller using subscription-only restricted print mode', async () => {
  let stopped = false;
  const adapters = createHeadlessClaudeAdapters({ launch: (request) => {
    assert.ok(request.args.includes('--print'));
    assert.ok(request.args.includes('--restricted'));
    assert.equal(request.args[request.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(request.args[request.args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(request.args[request.args.indexOf('--tools') + 1], 'Read,Write,Edit,Glob,Grep');
    assert.equal(request.args[request.args.indexOf('--allowedTools') + 1], 'Read,Write,Edit,Glob,Grep');
    assert.equal(request.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(request.args.includes('--allow-dangerously-skip-permissions'), false);
    assert.equal(request.env.ANTHROPIC_API_KEY, undefined);
    assert.equal(request.env.ANTHROPIC_AUTH_TOKEN, undefined);
    let close;
    const closed = new Promise((resolve) => { close = resolve; });
    completed(request);
    return { closed, stop: async () => { stopped = true; close({ code: 0 }); } };
  } });
  const result = await adapters.runWorker(context);
  assert.equal(result.provider, 'claude-subscription');
  assert.equal(stopped, true);
  await assert.rejects(createVisibleClaudeAdapters({ isInteractive: () => false,
    launch: () => assert.fail('visible must refuse') }).runWorker(context), { code: 'InteractiveRequired' });
});

test('headless reviewer and repair use fresh attempt identities and preserve role ports', async () => {
  const bindings = [];
  const adapters = createHeadlessClaudeAdapters({ launch: (request) => {
    bindings.push(request.binding);
    completed(request, request.args.at(-1).includes('bounded Gaia reviewer') ? { verdict: 'REQUEST_CHANGES' } : {});
    return { closed: Promise.resolve({ code: 0 }), stop: async () => {} };
  } });
  assert.equal((await adapters.runReviewer({ ...context, changeSet: { identity: 'candidate-a' } })).verdict, 'REQUEST_CHANGES');
  await adapters.runRepair({ ...context, initialCandidate: { identity: 'candidate-a' }, findings: 'Repair fixture.' });
  assert.notEqual(bindings[0], bindings[1]);
});

for (const scenario of ['wrong-binding', 'timeout', 'shutdown-mutation', 'failed-exit']) {
  test(`headless ${scenario} cannot yield accepted evidence and always stops provider`, async () => {
    let stopped = false;
    const adapters = createHeadlessClaudeAdapters({ launch: (request) => {
      let close;
      const closed = new Promise((resolve) => { close = resolve; });
      if (scenario !== 'timeout') completed(request, scenario === 'wrong-binding' ? { binding: 'previous-attempt' } : {});
      if (scenario === 'failed-exit') close({ code: 1 });
      return { closed, stop: async () => {
        stopped = true;
        if (scenario === 'shutdown-mutation') writeFileSync(request.resultPath, '{}');
        close({ code: 0 });
      } };
    } });
    const code = scenario === 'timeout' ? 'AgentTimeout' : scenario === 'failed-exit' ? 'AgentFailed' : 'AgentProtocol';
    await assert.rejects(adapters.runWorker(context, { timeoutMs: 10 }), { code });
    assert.equal(stopped, true);
  });
}

for (const scenario of ['output-limit', 'timeout', 'success']) {
test(`headless process launch ${scenario} uses ignored stdin and no shell or window`, async () => {
  const provider = new EventEmitter();
  provider.pid = 123456;
  provider.stdout = new PassThrough();
  provider.stderr = new PassThrough();
  let stopped = false;
  const stopProvider = () => { stopped = true; queueMicrotask(() => provider.emit('close', null)); };
  mock.method(childProcess, 'spawn', (command, args, options) => {
    assert.equal(options.shell, false);
    assert.equal(options.windowsHide, true);
    if (command === 'taskkill.exe') {
      assert.deepEqual(args, ['/PID', '123456', '/T', '/F']);
      const killer = new EventEmitter();
      stopProvider();
      queueMicrotask(() => killer.emit('close', 0));
      return killer;
    }
    assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    queueMicrotask(() => {
      if (scenario !== 'timeout') {
        provider.stdout.write(Buffer.alloc(40));
        provider.stderr.write(Buffer.alloc(40));
      }
      if (scenario === 'success') {
        const prompt = args.at(-1);
        const resultPath = prompt.match(/Write this result to (.*); do no further work/u)[1];
        const { binding } = JSON.parse(prompt.split('\n').find((line) => line.startsWith('{"schema":')));
        completed({ resultPath, binding });
      }
    });
    return provider;
  });
  if (process.platform !== 'win32') mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, -123456);
    assert.equal(signal, 'SIGKILL');
    stopProvider();
  });
  syncBuiltinESMExports();
  try {
    const run = createHeadlessClaudeAdapters().runWorker(context,
      { timeoutMs: scenario === 'timeout' ? 10 : 1000, maxOutputBytes: scenario === 'output-limit' ? 64 : 1024 });
    if (scenario === 'success') assert.equal((await run).provider, 'claude-subscription');
    else await assert.rejects(run, { code: scenario === 'timeout' ? 'AgentTimeout' : 'AgentOutputLimit' });
    assert.equal(stopped, true);
  } finally { mock.restoreAll(); syncBuiltinESMExports(); }
});
}
