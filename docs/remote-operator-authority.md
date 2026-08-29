# Remote operator authority R0 design

## Operator problem

The portfolio operator correctly requires a human to confirm one freshly measured intent and
unlock a dedicated signing key. On Windows that currently means a local terminal plus a masked
passphrase dialog. The mechanism is safe but hostile to remote operation, and automating the
prompt would destroy the human-authority property it protects.

The goal is one remote-friendly operator action without turning a URL, GitHub token, comment,
label, environment variable, file or agent process into authority.

## Constraints

- Gaia measures the intent from a fresh GitHub read. A caller cannot nominate an intent digest.
- The operator reviews the normalized fields whose full revision is authorized.
- Approval is short-lived, domain-separated, bound to one executor and consumed once.
- No private key, passphrase, assertion, bearer grant or OAuth token enters argv, environment,
  repository files, progress, receipts or diagnostics.
- A locator can reveal where an approval is waiting but can never spend it.
- Consumption is durably recorded before execution starts. Ambiguous post-consumption failure
  becomes `RECONCILE_REQUIRED`; Gaia does not mint replacement authority.
- The existing control room remains a pure `effect=NONE`, `authority=NONE` read model.

## Design It Twice

Three materially different Interfaces were compared.

### A. One deep `run` Interface

`PortfolioOperator.run({ portfolioRevision, repository })` hides fresh measurement, remote
presentation, passkey verification, claim consumption, execution and receipts. An approval URL
is an observation only. This maximizes Depth and makes safe operation the default.

Its cost is an owned online authority broker, transactional storage, credential enrollment and
a stable HTTPS WebAuthn relying-party origin.

### B. Transport-neutral operator plus exact-intent authority Seam

The external `PortfolioOperator.run` Interface stays unchanged. Construction selects an
`ExactIntentAuthority` Adapter whose internal Interface is:

```text
consumeExactIntent({ measurement, executionBinding }) -> AuthorityConsumption
```

Local platform and remote passkey Adapters share the same post-consumption result. The Interface
never exposes `sign`, `grant`, `approve` or a bearer capability. This adds flexibility without
making callers reconstruct the protocol.

Its cost is compatibility work between local and remote Adapters and an explicit reconciliation
state for a crash after authority consumption.

### C. Browser workflow Interface

`request`, `read`, `beginDecision` and `completeDecision` map directly to browser and WebAuthn
round trips. This makes the UI easy to build but publishes the protocol decomposition as a
shallow Interface. Every non-browser caller would need to learn ordering, freshness and replay
rules.

### Selected hybrid: A externally, B internally

The external Module keeps one operational entry point. The remote/browser choreography is an
Adapter behind the exact-intent authority Seam. This gives callers the Leverage of one safe
operation and keeps protocol change Locality inside the authority implementation.

The current encrypted-file Adapter remains available as a legacy local Adapter. It is not the
strict remote profile because its private key is a file even though the passphrase is not.

## Selected Interface

```text
PortfolioOperator.run({ portfolioRevision, repository }) -> OperatorReceipt

ExactIntentAuthority.consumeExactIntent({
  measurement: {
    portfolioRevision, snapshotRevision, intentRevision,
    action, repository, itemKind, itemId, itemNumber, task, revision
  },
  executionBinding: { algorithm, publicKey, thumbprint, nonce }
}) -> AuthorityConsumption
```

`AuthorityConsumption` contains only post-consumption evidence: claim/request/intent revisions,
executor thumbprint, method, approval/consumption/expiry times and a broker receipt signature.
It contains no assertion, credential material or reusable grant.

## Remote Adapter protocol

1. The operator freshly materializes the exact intent and creates an ephemeral executor keypair
   in memory.
2. The owned broker independently re-materializes the intent from the pinned portfolio plus a
   fresh GitHub read. It refuses any byte-level disagreement.
3. The broker stores a closed request binding the full measurement, audience, nonce, expiry and
   executor public-key thumbprint.
4. The browser shows only the broker-stored sanitized measurement. GitHub identity may route the
   request but is not authority.
5. A registered passkey performs user verification. Its challenge binds the request revision,
   decision, origin and relying-party ID.
6. The executor proves possession of its ephemeral private key.
7. One transaction records the broker receipt and changes `APPROVED` to `CONSUMED`. Replays,
   concurrent tabs and network retries can observe the same result but cannot consume again.
8. Gaia verifies the broker receipt, derives its deterministic idempotency identity and starts
   execution. Provider progress remains redacted and non-authoritative.

The claim TTL starts after human approval. Waiting for the operator is not itself a refusal.

## Dependency categories and Adapters

- **In-process:** canonicalization, digesting, closed-schema validation, domain separation,
  display sanitization, receipt redaction and state-transition validation.
- **Local-substitutable:** request/claim/receipt persistence and clock. Production uses a
  transactional store Adapter; tests use an in-memory Adapter.
- **Remote but owned:** authority broker. Production uses HTTPS; tests use an in-memory Adapter.
- **True external:** GitHub reads and WebAuthn authenticator. Production uses the existing GitHub
  Adapter and browser platform APIs; tests use controlled fakes.

## Error contract

Refusals are closed, typed and redacted: `PortfolioRevisionMismatch`, `IntentMismatch`,
`RepositoryScopeMismatch`, `RequestExpired`, `SubjectNotAllowed`, `UserVerificationRequired`,
`ApprovalCancelled`, `ChallengeMismatch`, `OriginMismatch`, `RpIdMismatch`, `AssertionInvalid`,
`ExecutorBindingMismatch`, `AlreadyConsumed`, `ConcurrentConsume`, `LedgerUnavailable`,
`AuthorityUnavailable` and `ResponseInvalid`.

After consumption, execution or local-receipt ambiguity is never reported as `REFUSED`. It is
`EXECUTION_FAILED` or `RECONCILE_REQUIRED` because the one-use authority has already been spent.

## Falsifier and rejection criteria

The decisive adversary controls the CLI, network, approval locator and a valid GitHub/PAT
identity but lacks the enrolled human authenticator. If it can cause `CONSUMED` or execution even
once, the design is rejected. Two concurrent consumers producing two execution starts also
reject it.

Reject any implementation that trusts a caller-supplied intent digest, exposes a transferable
bearer grant, treats GitHub activity as human authority, cannot atomically record one-use
consumption, or puts authority secrets into argv, environment, files, logs or receipts.

## R0 implementation boundary

R0 may implement and adversarially test the exact-intent authority Seam with an in-memory owned
broker Adapter. That prototype grants no production authority. A live Adapter is blocked until
Gaia has an explicitly selected stable HTTPS relying-party origin, protected credential
enrollment/recovery and a transactional store. Those are one-way-door operational decisions;
they must not be inferred from a localhost prototype.

