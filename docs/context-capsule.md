# Experimental context capsule

The `ContextCapsule` Module exposes one exact, manifest-listed fact revision to a caller without injecting a whole corpus. It is an experimental read-only module, not a bus feature, artifact store, search engine, RAG system, model runtime, freshness authority, or approval mechanism.

```js
import { openContextCapsule } from '../src/context-capsule.mjs';

const capsule = await openContextCapsule(exactManifestRevision, readOnlyRevisionAdapter);
const outcome = await capsule.get('fact-07');
```

The trusted composition root supplies:

- one exact manifest revision containing a lowercase raw-byte SHA-256 and an immutable decimal revision;
- an Adapter whose only Interface is `readRevision(ref) -> Promise<Uint8Array>`.

The model-facing Interface is only `get(factId)`. It accepts a bounded identifier, never a path, URI, query language, branch, tag, `latest`, glob, or similarity request.

## Success contract

A successful outcome contains:

- one strict `gaia-context-capsule-response/1` projection;
- `trust: untrusted-data` and `authorityEffect: none`;
- the exact pinned source revision;
- a deterministic `gaia-context-capsule-receipt/1`;
- canonical receipt JSON owned by the caller.

The receipt proves that exact pinned bytes produced the response under `exact-pinned-revision/1`. It does **not** prove correctness, acceptance, completion, authenticated authorship, global freshness, or authority. The Module returns the receipt as data and never persists it.

## Refusal contract

Unknown, traversal-shaped, digest-mismatched, malformed, unsafe, unavailable, or oversized facts fail closed. Unsupported schemas and source-identity mismatches remain distinct typed failures. A refusal contains no response, receipt, artifact bytes, Adapter diagnostic, filesystem path, or authority effect.

The initial limits are one MiB for a manifest and 64 KiB for a projected fact. Facts are never silently truncated.

## Authority and transport

The Module performs no write, clock, randomness, environment read, credential read, network access, model invocation, scheduling, or bus activity. Gaia's bus remains exactly:

`register`, `send`, `inbox`, `ack`, `heartbeat`, `handoff`.

If a caller later carries a capsule result over the bus, the existing `send` verb carries it as untrusted text with no requested authority. A capsule receipt must not be confused with the bus `ack`, which means receipt of a message only.

## Current evidence and limitation

The design follows the throwaway R2 same-configuration bake-off, where both variants answered 12/12 synthetic facts and the capsule reduced modeled boundary bytes by 94.55%. That was one exploratory trial on a synthetic corpus. It does not establish statistical superiority or production security; repeated held-out evaluation and independent review remain required before broader promotion.

The alternatives, rejection reasons, exact experiment hashes, invariants, and reversibility trigger are bound in [context-capsule-design.md](context-capsule-design.md).
