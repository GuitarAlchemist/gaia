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
   owns linked-worktree isolation, candidate identity, review non-mutation, one
   bounded repair, and receipt semantics. Small adapters own the exact Claude and
   Codex invocations.

Design 3 was selected. It has the smallest stable public seam while hiding the
volatile CLI mechanics. The v1 profiles are intentionally closed rather than
pretending arbitrary commands are safe providers.

## Contract

`executeAgentFactory` requires:

- a clean linked Git worktree, never a primary checkout;
- a non-empty task;
- one host-user worker process instructed to write only in that worktree;
- one sandbox-requested read-only reviewer adapter returning exactly `APPROVE` or
  `REQUEST_CHANGES`;
- one explicit repair adapter, used at most once and only after the initial reviewer
  returns `REQUEST_CHANGES`.

The worker must produce at least one regular-file change. Gaia binds the base
commit, index tree, Git status bytes, binary patch, and each changed or deleted
file. A mismatched final worker HEAD or index is refused. The reviewer receives a copy
of the candidate identity. Gaia binds the complete worktree tree (including
ignored files) before review and refuses if that tree, HEAD, index, or candidate
identity changes during review.

An initial `APPROVE` ends the run exactly as before. An initial `REQUEST_CHANGES`
does not become success and does not start a loop. Gaia gives one repair adapter the
exact initial candidate identity and the exact reviewer output. The repair must keep
HEAD and the index unchanged and must produce a different, non-empty candidate
identity. A fresh reviewer then judges that repaired identity. Its verdict is the
authoritative `reviewer` and determines `completed` or `rejected`; a second
`REQUEST_CHANGES` ends rejected and can never invoke another repair.

Receipts without a repair retain the v1 shape. Repaired receipts add optional
`repair` and `reviews` fields: `reviews.initial` preserves the first rejection,
`reviews.final` equals the authoritative `reviewer`, and `changeSet` is the repaired
candidate. Worker, initial-review, repair, and final-review outputs are persisted as
four separately named content-addressed evidence objects.

The command resolves reparse points and reserves its receipt plus an exclusive
content-addressed evidence directory physically outside the worktree before
model execution. Successful raw model outputs are treated as sensitive local
evidence: they are never embedded in the public receipt, but their exact paths,
sizes, and SHA-256 identities are bound there and replayed after persistence.
Successful review, rejected review, launch failure, timeout, output overflow, and
protocol failure all produce distinct machine-readable outcomes. Approval grants
no publication authority.

Repair absence, malformed repair output, repair HEAD/index mutation, removal of the
candidate, and a claimed repair that leaves the candidate identity unchanged fail with
typed errors. The portfolio layer records those failures as `EXECUTION_FAILED` after
the existing one-use grant is spent. Repair receives no second grant or idempotency key.

The public `scripts/factory-agent.mjs` composition wires the closed Claude repair
profile explicitly and selects either the default Codex reviewer or the optional Pi
reviewer with `--reviewer pi`. Worker, repair, and each reviewer invocation receive the
same caller-bounded timeout; importing its `runFactoryAgentCli` seam performs no command
and allows the composition to be verified without spawning subscription providers.

## CLI progress contract

The public composition wraps the worker, reviewer, and repair adapters; the pure factory
state machine has no progress callback. By default `stderr` receives redacted human
lines for validation, `execution_starting`, worker start/completion, initial review
start/verdict, optional repair start/completion, final review start/verdict, and terminal
outcome. This direct CLI has no grant and never emits `authorized_execution`.
`--progress-format jsonl` selects one closed `gaia-cli-progress/1` JSON object per line;
the only other accepted value is the default `human`. `stdout` remains the final run JSON
only.

The optional `--otel-endpoint` seam exports one cycle span and child spans for the
worker, each review, and the bounded repair. The endpoint parser accepts only explicit
HTTP loopback addresses. Span attributes are closed to phase, the fixed
`ZERO_ADDITIONAL_DOLLARS` cost policy, and `authority_effect: NONE`; caller text,
paths, prompts, provider output, and evidence never enter telemetry. Export failures
are swallowed because observation must never change execution outcome or authority.

Every JSON record carries monotone elapsed milliseconds and
`remainingProviderTimeUpperBoundMs`. The latter is `--timeout-ms` multiplied by the
maximum number of provider invocations still reachable (four initially, then at most
three, two, one, and zero). It is an upper bound on remaining provider time only, not a
prediction or an end-to-end ETA; local Git inspection, evidence persistence, and receipt
I/O are deliberately not assigned fictional deadlines. Human lines render both durations
in seconds/minutes/hours and label the bound `(not an ETA)`. While a provider is running,
an unreferenced 10-second timer refreshes its stage, elapsed time, and bound; it is stopped
on completion or failure. Each callback also carries an active generation token, so a
timer retained by a failed `stop` or `unref` cannot emit after cleanup or terminal
outcome. Records use closed stage, verdict, and outcome values and never
interpolate task text, paths, secrets, provider identity, or provider output. Clock,
writer, and timer failures degrade observability only and cannot change execution or
receipts.

## Provider boundaries

- Claude runs non-interactively as the host user with a prompt-requested
  linked-worktree scope. This is deliberately **not** called OS containment:
  bypass-permissions can reach whatever the host user can reach, while Gaia
  observes only the candidate worktree and Git controls.
- Codex runs ephemerally with requested `read-only` sandboxing. Gaia additionally
  verifies the complete candidate tree and Git controls after review.
- Pi is an alternative reviewer only. It must report ready `openai-codex` OAuth before
  model launch, receives a digest-checked patch capped at 1 MiB, runs without a session,
  project-local approval, extensions, skills, or implicit context, and exposes only
  `read`, `grep`, `find`, and `ls`. It has no writer or shell tool.
- All provider profiles receive a minimal OS environment allowlist. API keys, provider
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
Also reject this seam if one `REQUEST_CHANGES` can cause two repairs, the final reviewer
does not receive the repaired identity, a second rejection starts a loop, or a repair
failure is represented as an ordinary rejected candidate.

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
