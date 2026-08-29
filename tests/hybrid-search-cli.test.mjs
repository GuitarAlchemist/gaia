import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runHybridSearchCli } from '../scripts/hybrid-search.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-hybrid-search-cli-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

test('the hybrid-search CLI persists one content-addressed index and cited result', () => {
  const corpusPath = join(scratch, 'corpus.json');
  const queryPath = join(scratch, 'query.json');
  const indexPath = join(scratch, 'index.json');
  const resultPath = join(scratch, 'result.json');
  writeFileSync(corpusPath, `${JSON.stringify({
    schema: 'gaia-search-corpus/1',
    documents: [{
      id: 'lease-safety',
      text: 'Leases and fencing tokens prevent stale writers.',
      embedding: [1, 0],
      source: {
        uri: 'repo://ix/docs/distributed.md',
        range: { startLine: 10, endLine: 10 },
        revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
      },
      freshness: 'FRESH',
    }],
  })}\n`, 'utf8');
  writeFileSync(queryPath, `${JSON.stringify({
    schema: 'gaia-search-query/1',
    text: 'distributed lock safety',
    embedding: [1, 0],
    limit: 1,
  })}\n`, 'utf8');
  let stdout = '';

  const result = runHybridSearchCli([
    '--corpus', corpusPath,
    '--query', queryPath,
    '--index-out', indexPath,
    '--out', resultPath,
  ], { writeStdout: (chunk) => { stdout += chunk; } });

  assert.equal(result.status, 'MATCH');
  assert.equal(result.hits[0].id, 'lease-safety');
  const persistedIndex = JSON.parse(readFileSync(indexPath, 'utf8'));
  const persistedResult = JSON.parse(readFileSync(resultPath, 'utf8'));
  assert.equal(persistedIndex.schema, 'gaia-hybrid-search-index/1');
  assert.match(persistedIndex.identity, /^[0-9a-f]{64}$/u);
  assert.deepEqual(persistedResult, result);
  assert.deepEqual(JSON.parse(stdout), result);
});

test('the hybrid-search CLI can source corpus and query embeddings from local IX', () => {
  const corpusPath = join(scratch, 'ix-corpus.json');
  const queryPath = join(scratch, 'ix-query.json');
  const indexPath = join(scratch, 'ix-index.json');
  const resultPath = join(scratch, 'ix-result.json');
  writeFileSync(corpusPath, `${JSON.stringify({
    schema: 'gaia-search-corpus/1',
    documents: [{
      id: 'lease-safety',
      text: 'Leases and fencing tokens prevent stale writers.',
      source: {
        uri: 'repo://ix/docs/distributed.md',
        range: { startLine: 10, endLine: 10 },
        revision: { algorithm: 'sha256', digest: 'a'.repeat(64) },
      },
      freshness: 'FRESH',
    }],
  })}\n`, 'utf8');
  writeFileSync(queryPath, `${JSON.stringify({
    schema: 'gaia-search-query/1',
    text: 'distributed lock safety',
    limit: 1,
  })}\n`, 'utf8');
  const calls = [];
  const model = {
    id: 'Xenova/bge-base-en-v1.5',
    revision: '4d6cd88e18e51a5e020c2c305726d76ada9c03cf',
    dimensions: 2,
    runtime: 'fastembed',
    localOnly: true,
  };

  const result = runHybridSearchCli([
    '--corpus', corpusPath,
    '--query', queryPath,
    '--index-out', indexPath,
    '--out', resultPath,
    '--ix-embed', 'C:\\tools\\ix-embed.exe',
    '--model-cache', 'C:\\models',
  ], {
    writeStdout: () => {},
    embedLocal: (request) => {
      calls.push(request);
      return {
        model,
        items: request.items.map((item) => ({ id: item.id, embedding: [1, 0] })),
      };
    },
  });

  assert.deepEqual(calls.map(({ mode }) => mode), ['passage', 'query']);
  assert.equal(result.status, 'MATCH');
  assert.deepEqual(result.retrieval.embeddingModel, model);
  assert.deepEqual(JSON.parse(readFileSync(indexPath, 'utf8')).embeddingModel, model);
});
