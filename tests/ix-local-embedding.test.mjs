import test from 'node:test';
import assert from 'node:assert/strict';

import { embedWithIxLocal } from '../src/ix-local-embedding.mjs';

test('Gaia obtains provenance-bound query vectors from the local IX executable', () => {
  let observed;
  const result = embedWithIxLocal({
    executable: 'C:\\tools\\ix-embed.exe',
    modelCache: 'C:\\models',
    mode: 'query',
    items: [{ id: 'query-a', text: 'fencing tokens' }],
  }, {
    env: { OPENAI_API_KEY: 'must-not-pass', ANTHROPIC_API_KEY: 'must-not-pass' },
    runInvocation: (invocation) => {
      observed = invocation;
      return {
        status: 0,
        stderr: '',
        stdout: JSON.stringify({
          schema: 'ix-local-embedding-response/1',
          mode: 'query',
          model: {
            id: 'Xenova/bge-base-en-v1.5',
            revision: '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
            dimensions: 2,
            runtime: 'fastembed',
            localOnly: true,
          },
          items: [{
            id: 'query-a',
            textSha256: '0545c54e24c94e1e96754e48d9087e14007f9f5aa5075e5d2c8408e98f28aa6c',
            embedding: [0.6, 0.8],
          }],
        }),
      };
    },
  });

  assert.equal(observed.command, 'C:\\tools\\ix-embed.exe');
  assert.deepEqual(observed.args, ['--model-cache', 'C:\\models', '--input', '-']);
  assert.equal(observed.env.OPENAI_API_KEY, undefined);
  assert.equal(observed.env.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(JSON.parse(observed.input), {
    schema: 'ix-local-embedding-request/1',
    mode: 'query',
    items: [{ id: 'query-a', text: 'fencing tokens' }],
  });
  assert.deepEqual(result.items[0].embedding, [0.6, 0.8]);
  assert.equal(result.model.localOnly, true);
  assert.equal(result.model.revision, '4d6cd88e18e51a5e020c2c305726d76ada9c03cf');
});
