// Isolated Windows regression: a synchronous path walk must not hang the test runner.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createStreamingClaudeAdapters } from '../../src/factory-visible-claude.mjs';

const [variant, tool] = process.argv.slice(2);
const root = realpathSync(mkdtempSync(join(tmpdir(), 'gaia-sdk-case-')));
const flipCase = value => [...value].map(char => char === char.toUpperCase() ? char.toLowerCase() : char.toUpperCase()).join('');
const alternateRoot = variant === 'drive' ? flipCase(root[0]) + root.slice(1)
  : variant === 'directory' ? join(dirname(root), flipCase(basename(root))) : root;
mkdirSync(join(root, 'nested'));
writeFileSync(join(root, 'nested', 'owned.txt'), 'owned');
const path = join(alternateRoot, 'nested', tool === 'Edit' ? 'owned.txt' : 'new.txt');
const adapters = createStreamingClaudeAdapters({
  isObservable: () => true, render: () => {},
  sdkTransport: {
    runtime: { sdkVersion: '0.3.296', cliVersion: '2.1.296', protectionsVerified: true },
    query: ({ prompt, options }) => {
      const input = (name, file) => ({ hook_event_name: 'PreToolUse', cwd: options.cwd,
        session_id: options.extraArgs['session-id'], tool_name: name, tool_input: { file_path: file } });
      const iterator = (async function* () {
        const pre = options.hooks.PreToolUse[0].hooks[0];
        const post = options.hooks.PostToolUse[0].hooks[0];
        const ordinary = input(tool, path);
        assert.deepEqual(await pre(ordinary, 'ordinary', {}), {});
        if (tool === 'Write') writeFileSync(path, 'new');
        await post({ ...ordinary, hook_event_name: 'PostToolUse' }, 'ordinary', {});
        const resultPath = join(options.additionalDirectories[0], 'result.json');
        const result = input('Write', resultPath);
        assert.deepEqual(await pre(result, 'result', {}), {});
        const binding = JSON.parse(prompt.split('\n').find(line => line.startsWith('{"schema":'))).binding;
        writeFileSync(resultPath, JSON.stringify({ schema: 'gaia-visible-agent-result/1', binding,
          status: 'completed', summary: 'Injected SDK path fixture; no real Claude execution.' }));
        await post({ ...result, hook_event_name: 'PostToolUse' }, 'result', {});
        yield { type: 'result', session_id: options.extraArgs['session-id'], subtype: 'success',
          is_error: false, permission_denials: [] };
      })();
      iterator.close = () => {};
      return iterator;
    },
  },
});
try {
  const output = await adapters.runWorker({ cwd: root, task: 'case fixture', requiredCapabilities: [{ tool, path }] },
    { timeoutMs: 1_000 });
  assert.equal(JSON.parse(output.output).status, 'completed');
} finally { rmSync(root, { recursive: true, force: true }); }
