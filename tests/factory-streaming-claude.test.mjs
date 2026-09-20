import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  canRenderProviderActivity, createClaudeStreamRenderer, createStreamingClaudeAdapters,
  describeClaudeStreamEvent, launchStreamingProvider,
} from '../src/factory-visible-claude.mjs';

const context = { cwd: '.', task: 'Change fixture', baseHead: 'a'.repeat(40),
  env: { PATH: process.env.PATH, ANTHROPIC_API_KEY: 'never-forward' } };

function completed(request, extra = {}) {
  writeFileSync(request.resultPath, JSON.stringify({ schema: 'gaia-visible-agent-result/1',
    binding: request.binding, status: 'completed', summary: 'Fixture changed; tests not run.', ...extra }));
}

const collect = () => { const lines = []; return { lines, write: (value) => lines.push(value) }; };

test('the autonomous streaming transport prints a rendered stream and never opens a trust-dialog TUI', async () => {
  const { lines, write } = collect();
  let launched;
  const adapters = createStreamingClaudeAdapters({ isObservable: () => true, render: write, launch: (request) => {
    launched = request;
    assert.ok(request.args.includes('--print'), 'must stay noninteractive print mode');
    assert.equal(request.args[request.args.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(request.args.includes('--verbose'), 'stream-json print mode requires --verbose');
    assert.equal(request.args[request.args.indexOf('--model') + 1], 'claude-fable-5');
    assert.equal(request.args[request.args.indexOf('--permission-prompts') + 1], 'none');
    assert.equal(request.args[request.args.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(request.args[request.args.indexOf('--tools') + 1], 'Read,Write,Edit,Glob,Grep');
    assert.equal(request.args[request.args.indexOf('--allowedTools') + 1], 'Read,Write,Edit,Glob,Grep');
    assert.equal(request.args.includes('--dangerously-skip-permissions'), false);
    assert.equal(request.args.includes('--allow-dangerously-skip-permissions'), false);
    assert.equal(request.env.ANTHROPIC_API_KEY, undefined);
    request.render(`${request.label} tool Read\n`);
    completed(request);
    return { closed: Promise.resolve({ code: 0 }), stop: async () => {} };
  } });
  const result = await adapters.runWorker(context);
  assert.equal(result.provider, 'claude-subscription');
  assert.ok(launched.maxStreamBytes > 65_536, 'the stream budget is independent of the JSON result bound');
  assert.match(lines.join(''), /tool Read/u);
});

test('streaming refuses rather than silently running an invisible worker when nothing can render', async () => {
  assert.equal(canRenderProviderActivity({ isTTY: true, writable: true }), true);
  assert.equal(canRenderProviderActivity({ isTTY: true, writable: false }), false);
  assert.equal(canRenderProviderActivity({ isTTY: false, writable: true }), false);
  const adapters = createStreamingClaudeAdapters({
    isObservable: () => false, launch: () => assert.fail('must not launch an unobservable provider') });
  await assert.rejects(adapters.runWorker(context), { code: 'ObservabilityRequired' });
  if (!process.stdout.isTTY) {
    const defaultAdapter = createStreamingClaudeAdapters({ launch: () => assert.fail('no default invisible launch') });
    await assert.rejects(defaultAdapter.runWorker(context), { code: 'ObservabilityRequired' });
    const { runAutonomousCli } = await import('../scripts/github-portfolio-autonomous.mjs');
    const root = mkdtempSync(join(tmpdir(), 'gaia-observation-preflight-'));
    const state = join(root, 'state'); const clone = join(root, 'clone');
    mkdirSync(state); mkdirSync(clone);
    try {
      await runAutonomousCli(['enable', '--state', state, '--repository', 'Example/app', '--max-runs', '1'],
        { write: () => {} });
      await assert.rejects(runAutonomousCli(['tick', '--state', state, '--clone', clone]),
        { code: 'ObservabilityRequired' }, 'visibility is checked before authority consumption or GitHub access');
      let status;
      await runAutonomousCli(['status', '--state', state], { write: value => { status = value; } });
      assert.equal(status.usedRuns, 0);
      assert.equal(status.activeJobKey, null);
    } finally { rmSync(root, { recursive: true, force: true }); }
  }
});

test('rendered events carry tool names and progress but never prompt text, file bodies, or raw escapes', () => {
  const { lines, write } = collect();
  const renderer = createClaudeStreamRenderer({ write, label: '[gaia worker]' });
  renderer.stdout(Buffer.from(`${[
    JSON.stringify({ type: 'system', subtype: 'init', model: 'claude-fable-5', tools: ['Read', 'Glob'] }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'C:/secret/credentials.txt' } },
      { type: 'text', text: 'SECRET-PROMPT-BODY that must never be echoed' }] } }),
    JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_1', is_error: false,
        content: 'ANTHROPIC_API_KEY=sk-ant-LEAKED\nfile body line two' }] } }),
    JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, duration_ms: 1234 }),
    JSON.stringify({ type: 'PRINTABLE_SECRET_EVENT', subtype: 'PRINTABLE_SECRET_SUBTYPE',
      model: 'PRINTABLE_SECRET_MODEL' }),
    JSON.stringify({ type: 'rate_limit_event', rate_limit_info: {
      status: 'PRINTABLE_SECRET_STATUS', rateLimitType: 'PRINTABLE_SECRET_LIMIT' } }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'PRINTABLE_SECRET_BLOCK' },
      { type: 'tool_use', id: 'toolu_secret', name: 'PRINTABLE_SECRET_TOOL', input: {} },
      { type: 'tool_use', id: 'toolu_case', name: 'read', input: {} }] } }),
    JSON.stringify({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 'toolu_secret', content: 'withheld' },
      { type: 'tool_result', tool_use_id: 'toolu_case', content: 'withheld' }] } }),
  ].join('\n')}\n`));
  renderer.stderr(Buffer.from('provider stderr: ANTHROPIC_API_KEY=sk-ant-LEAKED'));
  const rendered = lines.join('');
  assert.match(rendered, /tool Read/u);
  assert.match(rendered, /result success/u);
  assert.doesNotMatch(rendered, /SECRET-PROMPT-BODY/u);
  assert.doesNotMatch(rendered, /sk-ant-LEAKED/u);
  assert.doesNotMatch(rendered, /credentials\.txt/u);
  assert.doesNotMatch(rendered, /file body line two/u);
  assert.doesNotMatch(rendered, /PRINTABLE_SECRET/u);
  assert.match(rendered, /event unknown/u);
  assert.match(rendered, /block unknown/u);
  assert.equal((rendered.match(/tool unknown/g) ?? []).length, 4,
    'unknown and case-variant tool names stay unknown in both use and result events');
  for (const line of lines) {
    assert.ok(line.endsWith('\n'), 'every rendered event is one terminated line');
    assert.doesNotMatch(line.slice(0, -1), /[\u0000-\u001f\u007f]/u, 'no control bytes reach the terminal');
  }
});

test('hostile provider text cannot inject escape sequences or unbounded lines into the terminal', () => {
  const { lines, write } = collect();
  const renderer = createClaudeStreamRenderer({ write, label: '[gaia worker]' });
  renderer.stdout(Buffer.from(`${JSON.stringify({ type: 'assistant', message: { content: [
    { type: 'tool_use', id: 'x', name: `\u001b[2J\u001b[31mRe\u0007ad${'A'.repeat(4000)}`, input: {} }] } })}\n`));
  renderer.stderr(Buffer.from('\u001b]0;pwned\u0007provider failed: EPERM'));
  const rendered = lines.join('');
  assert.doesNotMatch(rendered, /\u001b/u);
  assert.doesNotMatch(rendered, /\u0007/u);
  assert.match(rendered, /stderr received \d+B/u, 'diagnostic presence stays visible without leaking payloads');
  assert.doesNotMatch(rendered, /provider failed: EPERM/u);
  for (const line of lines) assert.ok(line.length <= 512, `rendered line stayed bounded: ${line.length}`);
});

test('event rendering is bounded and says so instead of flooding the terminal', () => {
  const { lines, write } = collect();
  const renderer = createClaudeStreamRenderer({ write, label: '[gaia worker]', maxEvents: 5 });
  for (let index = 0; index < 200; index += 1) {
    renderer.stdout(Buffer.from(`${JSON.stringify({ type: 'assistant',
      message: { content: [{ type: 'tool_use', id: `t${index}`, name: 'Glob', input: {} }] } })}\n`));
  }
  assert.equal(lines.length, 6, 'five events plus one suppression notice');
  assert.match(lines.at(-1), /suppressed/u);
});

test('a partial multibyte event is reassembled instead of being rendered as replacement bytes', () => {
  const { lines, write } = collect();
  const renderer = createClaudeStreamRenderer({ write, label: '[gaia]' });
  const bytes = Buffer.from(`${JSON.stringify({ type: 'result', subtype: 'succes-e', is_error: false })}\n`
    .replace('succes-e', 'succ\u00e8s'), 'utf8');
  const split = bytes.indexOf(Buffer.from('\u00e8', 'utf8')) + 1;
  renderer.stdout(bytes.subarray(0, split));
  renderer.stdout(bytes.subarray(split));
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], /\ufffd/u);
});

test('an unparsable or malformed event is reported, never trusted and never crashes the run', () => {
  const { lines, write } = collect();
  const renderer = createClaudeStreamRenderer({ write, label: '[gaia]' });
  renderer.stdout(Buffer.from('{not json\n[1,2,3]\nnull\n'));
  assert.equal(lines.length, 3);
  assert.match(lines[0], /unparsable/u);
  assert.match(lines[1], /malformed/u);
  assert.deepEqual(describeClaudeStreamEvent(undefined, new Map()), ['event malformed']);
});

test('the stream byte budget is separate from the small JSON result bound and both are enforced', async () => {
  const adapters = createStreamingClaudeAdapters({ isObservable: () => true, render: () => {}, launch: (request) => {
    assert.ok(request.maxStreamBytes >= 200_000);
    assert.equal(request.maxOutputBytes, 4096);
    completed(request);
    return { closed: Promise.resolve({ code: 0 }), stop: async () => {} };
  } });
  // A 4 KiB JSON result bound with a 256 KiB stream budget is a legitimate run, not an overflow.
  await assert.doesNotReject(adapters.runWorker(context, { maxOutputBytes: 4096, maxStreamBytes: 262_144 }));
  await assert.rejects(adapters.runWorker(context, { maxStreamBytes: 0 }), { code: 'AgentBounds' });
  await assert.rejects(adapters.runWorker(context, { maxStreamBytes: 2 ** 30 }), { code: 'AgentBounds' });
  await assert.rejects(adapters.runWorker(context, { maxOutputBytes: 2 ** 30 }), { code: 'AgentBounds' });
});

test('a real child process is rendered, bounded, and cleaned up by the shipped launcher', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-stream-fixture-'));
  const script = join(dir, 'provider.mjs');
  writeFileSync(script, [
    "const line = (value) => process.stdout.write(JSON.stringify(value) + '\\n');",
    "line({ type: 'system', subtype: 'init', model: 'claude-fable-5', tools: ['Read'] });",
    "line({ type: 'assistant', message: { content: [",
    "  { type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: 'X'.repeat(50) } }] } });",
    "line({ type: 'user', message: { content: [",
    "  { type: 'tool_result', tool_use_id: 'toolu_1', content: 'BODY-THAT-MUST-NOT-APPEAR' }] } });",
    "process.stderr.write('provider note: \\u001b[31mred\\u001b[0m\\n');",
    "line({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, duration_ms: 7 });",
  ].join('\n'));
  const lines = [];
  try {
    const provider = launchStreamingProvider({ command: process.execPath, args: [script], cwd: dir,
      env: { ...process.env }, maxStreamBytes: 65_536, label: '[gaia worker]',
      render: (value) => lines.push(value) });
    assert.deepEqual(await provider.closed, { code: 0 });
    await provider.stop();
    const rendered = lines.join('');
    assert.match(rendered, /session init/u);
    assert.match(rendered, /tool Read/u);
    assert.match(rendered, /result success/u);
    assert.match(rendered, /stderr received \d+B/u);
    assert.doesNotMatch(rendered, /provider note/u);
    assert.doesNotMatch(rendered, /BODY-THAT-MUST-NOT-APPEAR/u);
    assert.doesNotMatch(rendered, /\u001b/u);
    const failedSink = launchStreamingProvider({ command: process.execPath, args: [script], cwd: dir,
      env: { ...process.env }, maxStreamBytes: 65_536, label: '[gaia worker]',
      render: () => { throw new Error('sink unavailable'); } });
    await assert.rejects(failedSink.closed, { code: 'AgentObservationFailed' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a real child process that floods stdout is stopped at the stream bound', { timeout: 10_000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-stream-flood-'));
  const script = join(dir, 'flood.mjs');
  writeFileSync(script, [
    "const payload = JSON.stringify({ type: 'assistant', message: { content: [",
    "  { type: 'tool_use', id: 't', name: 'Glob', input: { q: 'y'.repeat(2000) } }] } }) + '\\n';",
    // A broken limiter must fail this test, not leave an endless provider running.
    'let rounds = 0;',
    'const pump = () => { for (let i = 0; i < 200; i += 1) process.stdout.write(payload);',
    '  if (++rounds < 10) setTimeout(pump, 5); };',
    'pump();',
  ].join('\n'));
  try {
    const provider = launchStreamingProvider({ command: process.execPath, args: [script], cwd: dir,
      env: { ...process.env }, maxStreamBytes: 32_768, label: '[gaia worker]', render: () => {} });
    await assert.rejects(provider.closed, { code: 'AgentStreamLimit' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the autonomous factory CLI is wired to the visible streaming transport', () => {
  const source = readFileSync(new URL('../scripts/github-portfolio-autonomous.mjs', import.meta.url), 'utf8');
  assert.match(source, /createStreamingClaudeAdapters/u);
  assert.doesNotMatch(source, /createHeadlessClaudeAdapters/u,
    'the pump must not fall back to an invisible headless worker');
});
