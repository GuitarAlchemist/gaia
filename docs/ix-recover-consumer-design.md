# IX recovery consumer: retrospective decision review

Date: 2026-10-26. Subject before this repair: `015b1757e2a79942cf8f0ef18472322a7aea7dbf`.

This record was written **after** the original consumer and its first repairs. No
preimplementation Design It Twice record was found. It does not retroactively satisfy
ENG-02's timing requirement, invent an earlier approval, or authorize promotion. It
records today's comparison and recommendation for independent review; acceptance of
this retrospective remediation remains a human decision before merge.

## Problem, constraints and non-proposal usage

The caller needs one local, pure statistics result with a stable run/attempt identity
after a repeated request or process kill. A successful call preserves the result IX
already published. Conflict, unaudited stages, held ownership, corruption, uncertain
termination and malformed protocol observations must never become success.

The constraints are Node 26 ESM and built-ins only, Windows first, explicit local
executable/governance/spec/store paths, no paid API, no bus/MCP/pump integration,
and no second authority for recovery. IX's process protocol and store are concrete
cross-repository dependencies; test adapters supply observations at the same seam.
Both are deliberately injectable or explicitly selected rather than hidden globals.

The requirement, without choosing an interface, is:

```text
submit identical run identity and inputs
  -> same committed attempt/result, repaired receipt, or an explicit refusal
interrupt the owned experiment process
  -> observed matching termination, or no claim of kill-recovery evidence
```

## Alternatives considered today

### A: explicit CLI consumer; IX owns recovery (recommended)

Interface: retain `runRecoverableStats(request, ports) -> result or typed refusal`.
The concrete process adapter is bounded. The scenario is a separate experiment,
not a runtime scheduler. IX alone owns binding, exclusion, attempt allocation,
publication, store verification and replay. Gaia validates its request, composes
the environment, and admits only a successful invocation with matching run/attempt
observations and completed stages.

This module hides argument serialization, environment filtering, protocol admission
and refusal mapping. Removing it makes those policies reappear in every caller.
The process adapter and deterministic observation fixtures exercise the same caller
interface; the real-binary scenario checks the actual process/store integration.
Its depth comes from preserving these distinctions behind one call, not from adding
a generic factory or new recovery methods. A scenario directory is claimed with an
exclusive final `mkdir`; the scenario owns termination requests and observed exits.

Tradeoffs: stdout/stderr and receipt schema-0 remain provisional, a compatible
executable and protected store are trusted, and the direct-child deadline does not
contain descendants. Protocol drift is localized here. Reversal is freely reversible:
remove consumer/scenario callers; preserve existing IX-owned run directories.

### B: Gaia-owned durable job recovery

Interface: `submit(jobId, bindings, adapter)`, `reconcile(jobId)`, `inspect(jobId)`.
Gaia would own the journal, attempt allocation, lock/fencing, staging, terminal truth
and replay. A process adapter would provide stateless computation; memory and fault
adapters would share the durable module's contract.

This offers greater depth for many providers and concentrates recovery policy in
Gaia. It also requires Windows crash-consistency, concurrency and migration work.
Calling IX's existing recovery store underneath it creates two terminal authorities;
avoiding that requires a separately verified stateless IX path. Persisted jobs would
need draining or migration on rollback. This is feasible with built-ins but exceeds
the accepted consumer scope and has no demonstrated second caller. Not selected.

### C: stateless statistics executor with caller-held receipts

Interface: `statistics(values, priorReceipt?, executor) -> bound statistics receipt`.
The common caller need not know run ids, attempt ids or store layout. The module
could hide numeric validation, input/implementation binding and response checks.

The interface is simpler and adapter change is local, but it loses original-attempt
replay, durable run conflicts, repair after a lost receipt and interruption history.
It requires a new upstream stateless request/response contract. A direct Rust binding
would additionally require a native bridge/distribution unavailable in this zero-new-
dependency Node module. This does not meet the current recovery requirement. Not selected.

## Today's decision and bounded repair

Retain A's existing interface and IX-owned recovery. Do not introduce the proposed
generic adapter factory, Gaia recovery store, native binding or stateless protocol.
The repair has three owners: invocation composition owns case-insensitive removal
of the named inherited environment variables; the scenario owns one exclusive work
directory; its interruption operation owns the requested signal and observed exit.

Before repair, deterministic subprocess fixtures must reproduce mixed-case leakage,
a competing directory claimant and a false successful kill. Positive controls must
still complete all seven scenario expectations. Mechanism-revert controls must
expose each removed safeguard, and a real compatible IX run must be repeated.

The [decision receipt](design-receipts/ix-recover-consumer-2026-10-26.json) binds the
exact bytes of this comparison and the baseline implementation. The three alternative
briefs were generated independently in local read-only contexts; they are advisory,
not independent approval of the selected implementation. Independent Standards and
Spec review of the repaired snapshot remains a separate transition under ENG-08.

No authority is granted by this document or receipt. The original missing design
gate remains part of the historical record, even if the repaired candidate passes.
