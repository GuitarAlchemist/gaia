import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildGaiaSearchIndex,
  searchGaiaIndex,
} from '../src/hybrid-search.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);

function document(overrides) {
  return {
    id: 'doc-a',
    text: 'Leases and fencing tokens prevent stale writers.',
    embedding: [1, 0],
    source: {
      uri: 'repo://ix/docs/distributed.md',
      range: { startLine: 10, endLine: 10 },
      revision: { algorithm: 'sha256', digest: SHA_A },
    },
    freshness: 'FRESH',
    ...overrides,
  };
}

test('hybrid search retrieves a semantic neighbor with immutable citation and no authority', () => {
  const index = buildGaiaSearchIndex({
    documents: [
      document({}),
      document({
        id: 'doc-b',
        text: 'Guitar chord voicing and fretboard positions.',
        embedding: [0, 1],
        source: {
          uri: 'repo://ga/docs/voicings.md',
          range: { startLine: 4, endLine: 4 },
          revision: { algorithm: 'sha256', digest: SHA_B },
        },
      }),
    ],
  });

  const result = searchGaiaIndex(index, {
    text: 'distributed lock safety',
    embedding: [1, 0],
    limit: 1,
  });

  assert.equal(result.status, 'MATCH');
  assert.equal(result.authority, 'NONE');
  assert.equal(result.hits.length, 1);
  assert.equal(result.hits[0].id, 'doc-a');
  assert.equal(result.hits[0].epistemicStatus, 'RETRIEVAL_MATCH');
  assert.equal(result.hits[0].ranks.vector, 1);
  assert.equal(result.hits[0].ranks.lexical, null);
  assert.deepEqual(result.hits[0].signals, { bm25: 0, cosine: 1 });
  assert.deepEqual(result.retrieval, {
    lexical: 'BM25_K1_1.2_B_0.75',
    vector: 'EXACT_COSINE',
    fusion: 'RRF_K60',
    embeddingDimensions: 2,
  });
  assert.deepEqual(result.hits[0].citation, {
    uri: 'repo://ix/docs/distributed.md',
    range: { startLine: 10, endLine: 10 },
    revision: { algorithm: 'sha256', digest: SHA_A },
    textSha256: '08a139e78a36bdd3061927fb07a29d0e0d17e1b015b07aa800c9cc0d70fc308c',
  });
});

test('hybrid search returns UNKNOWN instead of silently promoting stale evidence', () => {
  const index = buildGaiaSearchIndex({
    documents: [document({ freshness: 'STALE' })],
  });

  const current = searchGaiaIndex(index, {
    text: 'distributed lock safety', embedding: [1, 0], limit: 1,
  });
  assert.equal(current.status, 'UNKNOWN');
  assert.equal(current.reason, 'NO_FRESH_EVIDENCE');
  assert.deepEqual(current.hits, []);

  const historical = searchGaiaIndex(index, {
    text: 'distributed lock safety', embedding: [1, 0], limit: 1, freshness: 'ALL',
  });
  assert.equal(historical.status, 'MATCH');
  assert.equal(historical.hits[0].freshness, 'STALE');
});
