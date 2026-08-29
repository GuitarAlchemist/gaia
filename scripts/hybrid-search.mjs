import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildGaiaSearchIndex, searchGaiaIndex } from '../src/hybrid-search.mjs';
import { embedWithIxLocal } from '../src/ix-local-embedding.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new UsageError('expected paired --name value arguments');
    }
    flags[name.slice(2)] = value;
  }
  for (const required of ['corpus', 'query', 'index-out', 'out']) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  return flags;
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new UsageError(`${label} must be readable JSON`);
  }
}

export function runHybridSearchCli(argv, {
  writeStdout = (chunk) => process.stdout.write(chunk),
  embedLocal = embedWithIxLocal,
} = {}) {
  const flags = parseArgs(argv);
  const corpusPath = resolve(flags.corpus);
  const queryPath = resolve(flags.query);
  const indexPath = resolve(flags['index-out']);
  const resultPath = resolve(flags.out);
  if (indexPath === resultPath) throw new UsageError('index and result paths must differ');
  if (existsSync(indexPath) || existsSync(resultPath)) {
    throw new UsageError('index and result outputs must not already exist');
  }
  const corpus = readJson(corpusPath, 'corpus');
  const query = readJson(queryPath, 'query');
  if (corpus.schema !== 'gaia-search-corpus/1' || !Array.isArray(corpus.documents)) {
    throw new UsageError('corpus must use gaia-search-corpus/1');
  }
  if (query.schema !== 'gaia-search-query/1') {
    throw new UsageError('query must use gaia-search-query/1');
  }
  const ixEmbed = flags['ix-embed'];
  const modelCache = flags['model-cache'];
  if ((ixEmbed === undefined) !== (modelCache === undefined)) {
    throw new UsageError('--ix-embed and --model-cache must be supplied together');
  }
  let documents = corpus.documents;
  let queryEmbedding = query.embedding;
  let embeddingModel;
  let queryEmbeddingModel;
  if (ixEmbed !== undefined) {
    const passage = embedLocal({
      executable: ixEmbed,
      modelCache,
      mode: 'passage',
      items: documents.map(({ id, text }) => ({ id, text })),
    });
    const embeddedQuery = embedLocal({
      executable: ixEmbed,
      modelCache,
      mode: 'query',
      items: [{ id: 'gaia-query', text: query.text }],
    });
    documents = documents.map((document, index) => ({
      ...document,
      embedding: passage.items[index].embedding,
    }));
    queryEmbedding = embeddedQuery.items[0].embedding;
    embeddingModel = passage.model;
    queryEmbeddingModel = embeddedQuery.model;
  }
  const index = buildGaiaSearchIndex({ documents, embeddingModel });
  const result = searchGaiaIndex(index, {
    text: query.text,
    embedding: queryEmbedding,
    embeddingModel: queryEmbeddingModel,
    limit: query.limit,
    freshness: query.freshness,
  });
  mkdirSync(dirname(indexPath), { recursive: true });
  mkdirSync(dirname(resultPath), { recursive: true });
  writeFileSync(indexPath, serialize(index), { encoding: 'utf8', flag: 'wx' });
  writeFileSync(resultPath, serialize(result), { encoding: 'utf8', flag: 'wx' });
  writeStdout(serialize(result));
  return result;
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  try {
    runHybridSearchCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
