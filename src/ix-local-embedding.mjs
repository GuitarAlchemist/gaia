import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export class IxLocalEmbeddingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IxLocalEmbeddingError';
    this.code = code;
  }
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

export function runIxLocalEmbeddingInvocation(invocation) {
  const result = spawnSync(invocation.command, invocation.args, {
    env: invocation.env,
    input: invocation.input,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new IxLocalEmbeddingError('IX_EXECUTION_FAILED', 'IX local embedding could not start');
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function embedWithIxLocal({
  executable, modelCache, mode, items,
}, {
  env = process.env,
  runInvocation = runIxLocalEmbeddingInvocation,
} = {}) {
  if (typeof executable !== 'string' || executable.length === 0
      || typeof modelCache !== 'string' || modelCache.length === 0
      || !['query', 'passage'].includes(mode)
      || !Array.isArray(items) || items.length === 0) {
    throw new IxLocalEmbeddingError('REQUEST_INVALID', 'IX embedding request is invalid');
  }
  const ids = new Set();
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)
        || typeof item.text !== 'string' || item.text.length === 0) {
      throw new IxLocalEmbeddingError('REQUEST_INVALID', 'IX embedding items must be unique text');
    }
    ids.add(item.id);
  }
  const request = { schema: 'ix-local-embedding-request/1', mode, items };
  const invocationEnv = { ...env };
  for (const key of [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  ]) delete invocationEnv[key];
  const execution = runInvocation({
    command: executable,
    args: ['--model-cache', modelCache, '--input', '-'],
    env: invocationEnv,
    input: `${JSON.stringify(request)}\n`,
  });
  if (execution.status !== 0) {
    throw new IxLocalEmbeddingError(
      'IX_EMBEDDING_REFUSED', `IX local embedding refused with exit ${execution.status}`,
    );
  }
  let response;
  try {
    response = JSON.parse(execution.stdout);
  } catch {
    throw new IxLocalEmbeddingError('IX_PROTOCOL_INVALID', 'IX response was not valid JSON');
  }
  validateResponse(response, request);
  return response;
}

function validateResponse(response, request) {
  const model = response?.model;
  if (response?.schema !== 'ix-local-embedding-response/1'
      || response.mode !== request.mode
      || model?.id !== 'Xenova/bge-base-en-v1.5'
      || !/^[0-9a-f]{40}$/u.test(model.revision ?? '')
      || !Number.isSafeInteger(model.dimensions) || model.dimensions < 1 || model.dimensions > 4096
      || model.runtime !== 'fastembed' || model.localOnly !== true
      || !Array.isArray(response.items) || response.items.length !== request.items.length) {
    throw new IxLocalEmbeddingError('IX_PROTOCOL_INVALID', 'IX response contract is invalid');
  }
  for (let index = 0; index < request.items.length; index += 1) {
    const expected = request.items[index];
    const actual = response.items[index];
    if (actual?.id !== expected.id || actual.textSha256 !== sha256(expected.text)
        || !Array.isArray(actual.embedding) || actual.embedding.length !== model.dimensions
        || actual.embedding.some((value) => !Number.isFinite(value))) {
      throw new IxLocalEmbeddingError('IX_PROTOCOL_INVALID', 'IX embedding item is invalid');
    }
  }
}
