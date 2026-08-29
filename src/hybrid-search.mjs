import { createHash } from 'node:crypto';

export const GAIA_SEARCH_INDEX_SCHEMA = 'gaia-hybrid-search-index/1';
export const GAIA_SEARCH_RESULT_SCHEMA = 'gaia-hybrid-search-result/1';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const canonical = (value) => JSON.stringify(value);

function tokens(text) {
  return text.normalize('NFKC').toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_]+/gu) ?? [];
}

function normalized(vector) {
  if (!Array.isArray(vector) || vector.length === 0
      || vector.some((value) => !Number.isFinite(value))) {
    throw new TypeError('embedding must be a non-empty finite number array');
  }
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (magnitude === 0) throw new TypeError('embedding magnitude must be non-zero');
  return vector.map((value) => value / magnitude);
}

function termCounts(values) {
  const counts = new Map();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

function validateSource(source) {
  if (!source || typeof source.uri !== 'string' || source.uri.length === 0
      || !Number.isSafeInteger(source.range?.startLine) || source.range.startLine < 1
      || !Number.isSafeInteger(source.range?.endLine)
      || source.range.endLine < source.range.startLine
      || source.revision?.algorithm !== 'sha256'
      || !/^[0-9a-f]{64}$/u.test(source.revision.digest ?? '')) {
    throw new TypeError('source must contain URI, line range, and sha256 revision');
  }
}

export function buildGaiaSearchIndex({ documents }) {
  if (!Array.isArray(documents) || documents.length === 0) {
    throw new TypeError('documents must be a non-empty array');
  }
  const seen = new Set();
  let dimensions;
  const indexed = documents.map((document) => {
    if (!document || typeof document.id !== 'string' || document.id.length === 0
        || seen.has(document.id) || typeof document.text !== 'string') {
      throw new TypeError('documents require unique non-empty ids and text');
    }
    seen.add(document.id);
    validateSource(document.source);
    if (!['FRESH', 'STALE', 'UNKNOWN'].includes(document.freshness)) {
      throw new TypeError('freshness must be FRESH, STALE, or UNKNOWN');
    }
    const embedding = normalized(document.embedding);
    dimensions ??= embedding.length;
    if (embedding.length !== dimensions) throw new TypeError('embedding dimensions must match');
    const documentTokens = tokens(document.text);
    return {
      id: document.id,
      text: document.text,
      textSha256: sha256(document.text),
      embedding,
      tokens: documentTokens,
      termCounts: Object.fromEntries(termCounts(documentTokens)),
      source: structuredClone(document.source),
      freshness: document.freshness,
    };
  }).sort((left, right) => left.id.localeCompare(right.id, 'en'));
  const documentFrequency = new Map();
  for (const document of indexed) {
    for (const token of new Set(document.tokens)) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  const material = {
    schema: GAIA_SEARCH_INDEX_SCHEMA,
    dimensions,
    documents: indexed,
    documentFrequency: Object.fromEntries([...documentFrequency].sort()),
  };
  return Object.freeze({ ...material, identity: sha256(canonical(material)) });
}

function bm25(index, document, queryTokens) {
  const averageLength = index.documents.reduce((sum, item) => sum + item.tokens.length, 0)
    / index.documents.length;
  const k1 = 1.2;
  const b = 0.75;
  return [...new Set(queryTokens)].reduce((score, token) => {
    const frequency = document.termCounts[token] ?? 0;
    if (frequency === 0) return score;
    const containing = index.documentFrequency[token] ?? 0;
    const idf = Math.log(1 + (index.documents.length - containing + 0.5) / (containing + 0.5));
    const denominator = frequency + k1 * (
      1 - b + b * document.tokens.length / Math.max(1, averageLength)
    );
    return score + idf * frequency * (k1 + 1) / denominator;
  }, 0);
}

const dot = (left, right) => left.reduce((sum, value, index) => sum + value * right[index], 0);

export function searchGaiaIndex(index, {
  text, embedding, limit = 10, freshness = 'FRESH_ONLY',
}) {
  if (index?.schema !== GAIA_SEARCH_INDEX_SCHEMA || typeof text !== 'string') {
    throw new TypeError('a Gaia search index and query text are required');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new TypeError('limit must be an integer from 1 through 100');
  }
  if (!['FRESH_ONLY', 'ALL'].includes(freshness)) {
    throw new TypeError('freshness must be FRESH_ONLY or ALL');
  }
  const queryVector = normalized(embedding);
  if (queryVector.length !== index.dimensions) throw new TypeError('query dimensions must match');
  const candidates = index.documents.filter(
    (document) => freshness === 'ALL' || document.freshness === 'FRESH',
  );
  const queryTokens = tokens(text);
  const allLexical = candidates.map((document) => ({
    id: document.id, score: bm25(index, document, queryTokens),
  }));
  const lexical = allLexical.filter(({ score }) => score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, 'en'));
  const vector = candidates.map((document) => ({
    id: document.id, score: dot(queryVector, document.embedding),
  })).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, 'en'));
  const lexicalRanks = new Map(lexical.map(({ id }, rank) => [id, rank + 1]));
  const vectorRanks = new Map(vector.map(({ id }, rank) => [id, rank + 1]));
  const lexicalScores = new Map(allLexical.map(({ id, score }) => [id, score]));
  const vectorScores = new Map(vector.map(({ id, score }) => [id, score]));
  const hits = candidates.map((document) => {
    const lexicalRank = lexicalRanks.get(document.id) ?? null;
    const vectorRank = vectorRanks.get(document.id) ?? null;
    const rrf = (lexicalRank === null ? 0 : 1 / (60 + lexicalRank))
      + (vectorRank === null ? 0 : 1 / (60 + vectorRank));
    return {
      id: document.id,
      epistemicStatus: 'RETRIEVAL_MATCH',
      freshness: document.freshness,
      score: rrf,
      ranks: { lexical: lexicalRank, vector: vectorRank },
      signals: {
        bm25: lexicalScores.get(document.id),
        cosine: vectorScores.get(document.id),
      },
      excerpt: document.text,
      citation: {
        ...structuredClone(document.source),
        textSha256: document.textSha256,
      },
    };
  }).sort((left, right) => right.score - left.score || left.id.localeCompare(right.id, 'en'))
    .slice(0, limit);
  return Object.freeze({
    schema: GAIA_SEARCH_RESULT_SCHEMA,
    status: hits.length === 0 ? 'UNKNOWN' : 'MATCH',
    ...(hits.length === 0 ? { reason: 'NO_FRESH_EVIDENCE' } : {}),
    authority: 'NONE',
    indexIdentity: index.identity,
    retrieval: {
      lexical: 'BM25_K1_1.2_B_0.75',
      vector: 'EXACT_COSINE',
      fusion: 'RRF_K60',
      embeddingDimensions: index.dimensions,
    },
    hits,
  });
}
