# Context capsule design decision

Status: experimental R1 implementation candidate.

## Decision

Use a minimal manifest-bound Module at the seam between a trusted composition root and exact read-only artifact retrieval:

```js
const capsule = await openContextCapsule(exactManifestRevision, readOnlyRevisionAdapter);
const outcome = await capsule.get('fact-07');
```

The trusted host supplies one immutable, numerically versioned manifest revision and an Adapter with one method: `readRevision(ref) -> Promise<Uint8Array>`. The caller receives one projected fact or a typed fail-closed refusal. The Module performs no discovery, freshness selection, search, persistence, model invocation, scheduling, or bus activity.

This is the selected result of a Design It Twice comparison, not a universal retrieval abstraction.

## Alternatives considered

1. **Minimal manifest-bound capsule — selected.** The small Interface hides byte-digest verification, canonical JSON validation, unique pin selection, bounded projection, immutability, and deterministic receipt construction.
2. **Flexible binding and Adapter registry — rejected for R1.** No second production-shaped Adapter exists. A registry, multiple corpus formats, expected-response descriptors, and extension hooks would be hypothetical surface area.
3. **Prompt-oriented query reader — rejected for R1.** Lexical search, dependency closure, freshness policy, secret scanning, prompt-injection classification, and prompt rendering combine distinct concerns and exceed the evidence.

## Evidence binding

The decision is bounded by the throwaway R2 same-configuration experiment:

- result SHA-256: `3db8551940af1a8d42effd586fc9cc2012dccc5687e8d0787ef2adefa411afe6`;
- verification SHA-256: `6a5a5cf344f1e6fdb2709347d9c0b8bc033e91658d19cfc3862ce5324e1fd398`;
- Gaia base commit: `1fb8fabf4b924de2d835a096d275c27a5048007a`.

Both variants answered 12/12 synthetic facts and the capsule reduced modeled boundary bytes by 94.55%. This single synthetic trial supports an experimental bounded seam only. It does not establish statistical superiority, production security, semantic correctness, or permission to widen authority.

## Invariants

- Pins use lowercase SHA-256 and an immutable decimal revision; aliases such as branches, tags, and `latest` are refused.
- Unknown or traversal-shaped fact IDs are refused before fact bytes are read.
- JSON is strict UTF-8 and must already be in the Module's canonical form; duplicate object names cannot survive this check.
- Only manifest-listed `gaia-context-fact/1` records marked `model-context`, `untrusted-data`, and `authorityEffect: none` may cross the seam.
- Receipts bind request, manifest, source, and response but prove none of correctness, acceptance, global freshness, completion, authorship, or authority.
- The bus remains exactly `register`, `send`, `inbox`, `ack`, `heartbeat`, and `handoff`.

## Reversibility

The decision is freely reversible while the Module is experimental and has no bus/MCP export, persistent schema consumer, or production Adapter. Removing the source, tests, and documentation removes the behavior without data migration.

Revisit the rejected flexible design only when a second real Adapter demonstrates incompatible needs that cannot be hidden behind `readRevision`. Revisit query behavior only as a separate retrieval/policy Module with its own evidence and authority review.
