# Hybrid semantic search

Gaia's search seam is a local, deterministic retrieval engine. It combines lexical BM25
and exact cosine ranking through Reciprocal Rank Fusion (RRF). It does not train an
embedding model, claim that vector proximity is truth, or grant authority from a match.

## Contracts

`buildGaiaSearchIndex({ documents })` accepts chunks with:

- a unique identifier and exact text;
- a finite non-zero embedding supplied by a local adapter;
- a source URI and exact line range;
- a SHA-256 source-revision digest;
- `FRESH`, `STALE`, or `UNKNOWN` freshness.

The source fields are caller-supplied claims. This module validates their shape and binds
them into the index identity; it does not read the source URI or prove that its bytes match
the claimed revision. A source adapter must perform that verification before describing a
claim as corroborated.

The index stores normalized vectors, lexical statistics, exact text SHA-256 values, and a
content-derived index identity. It contains no timestamp, absolute local path, or provider
claim.

`searchGaiaIndex(index, query)` returns `RETRIEVAL_MATCH` hits with both ranks, citation,
freshness, and `authority: NONE`. The default `FRESH_ONLY` policy returns
`UNKNOWN / NO_FRESH_EVIDENCE` rather than silently promoting stale evidence. Callers may
request `ALL` only when historical results are explicitly useful.

## One-command tracer

```bash
npm run search:hybrid -- \
  --corpus ./corpus.json \
  --query ./query.json \
  --index-out ./state/search/index.json \
  --out ./state/search/result.json
```

The corpus uses `gaia-search-corpus/1`; the query uses `gaia-search-query/1`. Embeddings
are supplied as JSON number arrays. Both output paths must be new, and the command refuses
to overwrite either one.

For a vector-free corpus and query, add `--ix-embed <executable>` and
`--model-cache <directory>`. Gaia sends passage and query requests separately because BGE
uses a query instruction only for queries. The adapter removes provider API keys from the
child environment and accepts only the exact `Xenova/bge-base-en-v1.5` local-only response
contract. It verifies the cached model revision, item order, text SHA-256, dimension, and
every finite vector before the search engine can consume them. IX performs no implicit
model download; a missing cache is a refusal, not a fallback.

## Architectural boundary

- IX generates cached local embeddings; Gaia still owns exact vector ranking.
- DuckDB may inspect persisted indexes, results, drift, latency, and retrieval quality.
- Gaia owns content addressing, freshness policy, citation shape, and receipts.
- The WorkGraph may filter or rerank cited revisions, but a search result cannot mutate it.

The v0 engine intentionally uses exact cosine ranking. HNSW, IVF, or another ANN structure
must beat this baseline on measured portfolio scale, latency, recall, memory, and replay
before adoption. A local embedding adapter is the next slice; this module deliberately does
not download a model or introduce provider spend.
