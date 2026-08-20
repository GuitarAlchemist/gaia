# Real agent factory tracer design

## Problem

The shipped factory smoke proves Gaia's six-verb coordination and evidence path,
but intentionally launches no model and executes no repository work. A useful
software factory needs a smallest end-to-end slice that lets one agent produce a
candidate, lets another agent review it without mutation, and records what really
happened without granting commit, push, merge, or deployment authority.

## Design It Twice

Three interfaces were considered before implementation:

1. **A monolithic Claude script.** Smallest initial diff, but provider-specific
   flags, Git isolation, evidence, and verdict parsing become inseparable.
2. **An arbitrary command runner.** Superficially flexible, but exposes a shallow
   shell-shaped interface and makes authority, quoting, and provider identity
   caller claims.
3. **A provider-neutral factory core with closed provider profiles.** The core
   owns linked-worktree isolation, candidate identity, review non-mutation, and
   receipt semantics. Small adapters own the exact Claude and Codex invocations.

Design 3 was selected. It has the smallest stable public seam while hiding the
volatile CLI mechanics. The v1 profiles are intentionally closed rather than
pretending arbitrary commands are safe providers.

## Contract

`executeAgentFactory` requires:

- a clean linked Git worktree, never a primary checkout;
- a non-empty task;
- one host-user worker process instructed to write only in that worktree;
- one sandbox-requested read-only reviewer adapter returning exactly `APPROVE` or
  `REQUEST_CHANGES`.

The worker must produce at least one regular-file change. Gaia binds the base
commit, index tree, Git status bytes, binary patch, and each changed or deleted
file. A mismatched final worker HEAD or index is refused. The reviewer receives a copy
of the candidate identity. Gaia binds the complete worktree tree (including
ignored files) before review and refuses if that tree, HEAD, index, or candidate
identity changes during review.

The command resolves reparse points and reserves its receipt plus an exclusive
content-addressed evidence directory physically outside the worktree before
model execution. Successful raw model outputs are treated as sensitive local
evidence: they are never embedded in the public receipt, but their exact paths,
sizes, and SHA-256 identities are bound there and replayed after persistence.
Successful review, rejected review, launch failure, timeout, output overflow, and
protocol failure all produce distinct machine-readable outcomes. Approval grants
no publication authority.

## Provider boundaries

- Claude runs non-interactively as the host user with a prompt-requested
  linked-worktree scope. This is deliberately **not** called OS containment:
  bypass-permissions can reach whatever the host user can reach, while Gaia
  observes only the candidate worktree and Git controls.
- Codex runs ephemerally with requested `read-only` sandboxing. Gaia additionally
  verifies the complete candidate tree and Git controls after review.
- Both profiles receive a minimal OS environment allowlist. API keys, provider
  auth-token overrides, cloud-routing flags, custom endpoints, and unrelated
  host secrets are not inherited; the installed subscription logins remain in
  their normal user-profile stores.
- Both are launched without a shell. On Windows, Gaia resolves Claude's native
  executable and invokes the npm Codex JavaScript entry point directly rather
  than interpolating prompts through `cmd.exe`.
- Combined stdout and stderr are bounded and each invocation has a deadline.
  Limit/timeout termination covers the process tree, escalates after a bounded
  grace period, and reports failure only after the child has closed. Non-zero
  stderr is not copied into a public failure receipt.

## Falsifiers

Reject this seam if a primary, submodule-primary, or dirty checkout can run; a
physical alias places receipt/evidence inside the candidate; the final observed
HEAD or index tree differs from its entry value; an ignored reviewer mutation is
accepted; a rejected verdict exits as success;
an API/cloud override reaches a subscription profile; a terminated child keeps
running; or the candidate and model-output evidence cannot be replayed.

The host-user worker remains a disclosed residual. Prompt policy plus post-hoc
worktree observation cannot prove that it avoided network, secrets, installs, or
writes elsewhere. It also cannot prove that a transient Git action was absent if
the host-user worker restores the exact observed HEAD/index before returning.
Any future receipt claiming true workspace containment or historical-action
attestation needs a separate OS/container capability boundary and a new evidence
gate.

## Deliberate residual

This tracer composes with, but does not yet emit through, the six-verb bus. The
next vertical slice will route the task, candidate receipt, handoff, and verdict
through that already-verified control plane without adding a seventh verb.
