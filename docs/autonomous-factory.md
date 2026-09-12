# Local autonomous factory continuation

Parent intent: [INTENT.md](../INTENT.md). Source baseline:
`a07d95f99a13bdc0ca2b484a1e725b8e042b743f`. This combines the design and
implementation plan for this bounded slice; it is not an activation receipt.

## Decision

The operator had to type a digest and unlock a key for each routine run. The hosted
pump produces a Draft receipt; the portfolio operator starts a factory interactively.
The accepted outcome is automatic continuation to a local candidate under standing
authority, not automatic publication or merge.

Three alternatives were considered before implementation:

- Cache the decrypted manual key: fewer changes, but changes the manual ceremony's
  meaning and retains a signing secret. Rejected.
- Remote authority broker: useful for multiple hosts, but adds a service, credentials
  and operational dependencies before this local need is satisfied. Deferred.
- Selected: a separate local composition with an operator-owned SQLite policy/job
  ledger, reusing portfolio decisions, Draft admission and factory adapters.

Policy permits one repository, one active job and a finite lifetime run budget.
It lasts until revoked or exhausted, with no expiry/renewal service. It is configured
once and cannot be reset through `enable`. Preserve the same database, worktrees and
evidence on restart. Changing state directories is not a retry.

## Usage and topology

Use the pinned Node runtime, a trusted clone with GitHub read access, and existing
Claude subscription authentication. Create an operator-owned local state directory
outside all worker checkouts, then provision once:

```text
node scripts/github-portfolio-autonomous.mjs enable --state C:/Gaia/state --repository OWNER/REPO --max-runs 20
node scripts/github-portfolio-autonomous.mjs watch --state C:/Gaia/state --clone C:/Gaia/trusted-clone
node scripts/github-portfolio-autonomous.mjs status --state C:/Gaia/state
node scripts/github-portfolio-autonomous.mjs revoke --state C:/Gaia/state
```

`tick` performs one pass; `watch` repeats at a default 60-second interval, printing
changed results only. Watch is an explicit host process, not an installed OS service
or Codex automation. No schedule is registered. Revocation prevents future starts;
already authorized work may finish. Stop signals stop between bounded ticks.

Discovery reads the latest 20 successful `main` runs of `hosted-draft-intake.yml` and
downloads their known receipt artifact. Missing artifacts are reported. This bounded
window is not a complete historical backlog; artifact retention limits recovery.
Artifacts remain untrusted input. The existing reader validates shape and identity;
Draft admission checks the exact OPEN Draft on GitHub. Portfolio selection checks
readiness and freshness on both preview and authorized advance. A green no-op is not work.

After authority commits, the host prepares a detached worktree at the exact source
head. `createHeadlessClaudeAdapters` uses restricted file tools, `dontAsk`, print
mode and bounded output. The existing subscription environment removes API fallback.
Print mode does not provide a human workspace trust ceremony: the host must already
be trusted. This is a trusted OS-user boundary, not a sandbox against hostile code or
same-user processes. Network-share databases and multi-tenant runners are unsupported.

## Ownership and recovery

The application owns preview, authority consumption, execution and reconciliation.
The host owns downloads and checkout preparation. SQLite owns serialized revocation,
budget and unique admission. Six bus verbs and the manual operator remain unchanged.

The stable job key derives from repository, issue node ID and Draft number. Changing
portfolio/source or restarting cannot create a second job for that Draft. STARTED
committed under `BEGIN IMMEDIATE` is the authorization linearization point. Losing
actors receive `JobExists` or `HostBusy` without invoking the provider. The execution
key binds that job key and fresh intent revision.

Before new selection, a STARTED job is reconciled with its original intent/key. A bound
completed/rejected factory receipt closes it. Missing, corrupt or mismatched evidence
returns `RECONCILIATION_REQUIRED`, retaining the slot. Even a crash before invocation
cannot establish safe absence: there is no automatic lock stealing or blind relaunch.
Revocation and starts serialize in one database; GitHub readback and process spawn
are not atomic. Remote source movement in that interval remains a limitation; the
local source is rechecked immediately before execution.

This guarantee covers actors sharing this registry. Manual runs, another database,
another host and malicious OS-user modification are outside it. Reconcile prior
manual jobs, especially #141/#145, before activation; an empty registry is not proof
that no previous worker ran. Rollback is revoke and stop the owned watcher, retaining
all state and candidate work.

## Verification and artifact chain

Plan: durable policy tests, application through the real portfolio, noninteractive
provider, hosted receipt discovery and CLI; then full checks and independent review.
Files: `src/autonomous-factory*.mjs`, `src/factory-visible-claude.mjs`,
`scripts/github-portfolio-autonomous.mjs`, and their test files. `npm run test:autonomy`
is the focused deterministic contract suite, not a model-quality evaluation. Full
`npm test` discovers the same tests in existing CI.

This change's chain is INTENT -> this design -> code/test output -> independent review
of that commit -> PR/merge receipt when produced. Git binds document/code snapshots.
Review names required parent commits/digests; changed inputs invalidate freshness,
preserving historical evidence. Runtime links intake operation -> measured Draft/intent
-> STARTED authority -> factory change set/review -> terminal candidate. No generic
artifact graph service or Markdown acceptance-trigger engine is introduced.

Tests force competing starts on independent SQLite connections, revocation ordering,
corruption, exact replay, moved Drafts, lost responses, non-TTY CLI use and provider
cleanup. They prove the enumerated local contract. Live zero-prompt execution needs a
separate canary receipt. Candidate-ready still needs supervisor tests and publication
before being called delivered.
