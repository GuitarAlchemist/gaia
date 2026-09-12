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

Before `enable` or `watch`, satisfy the prior-manual-job reconciliation prerequisite
in [Ownership and recovery](#ownership-and-recovery), especially for #141/#145.

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
head. `createStreamingClaudeAdapters` uses the same restricted file tools, `dontAsk`,
print mode and bounded output as `createHeadlessClaudeAdapters`, and additionally
renders provider activity to the terminal running the pump. The existing subscription
environment removes API fallback. Print mode does not provide a human workspace trust
ceremony: the host must already be trusted. This is a trusted OS-user boundary, not a
sandbox against hostile code or same-user processes. Network-share databases and
multi-tenant runners are unsupported.

### Decision: how the pump becomes visible (ENG-02)

The pump ran with `createHeadlessClaudeAdapters`, which drained both provider pipes
and discarded every byte. A run was therefore unobservable: the operator saw a process
live for minutes and then a verdict, with no way to tell work from a stall. Two
genuinely different ways to fix that were considered.

- **Rejected: launch the Claude TUI with an inherited terminal**, as the interactive
  operator profile does. It shows the richest view, but an interactive session presents
  the workspace-trust dialog and waits for a human keystroke — the exact prompt this
  intent exists to remove — and it puts a full-screen application in charge of a
  terminal the pump also writes to. It would trade prompt-free operation for visibility.
- **Selected: keep `--print` and add `--output-format stream-json --verbose`**, parsing
  the newline-delimited events and rendering a short bounded description of each one.
  Execution stays noninteractive, so no trust dialog appears; the tool set, permission
  mode and subscription environment are unchanged; and what reaches the terminal is a
  description, never provider payload. Reversibility class: **freely reversible** —
  point the composition root back at `createHeadlessClaudeAdapters`. Trigger for
  rollback: the rendered stream is found to carry payload or to slow a run.

What is rendered is deliberately narrow: event kind, tool name, tool outcome, byte
sizes, rate-limit status, the result verdict, and the presence/size of stderr. Prompts,
assistant prose, tool inputs and tool results appear only as a size, because those are
where task text, file bodies and credentials live. Control characters are replaced
before anything is written, so a hostile tool name cannot inject an escape sequence.
Stderr payloads are withheld too: provider diagnostics may echo credentials or input.
The stream budget is separate from the small JSON result bound and both are enforced;
exceeding either stops the provider. The CLI requires an inherited terminal before
opening the authority store (`ObservabilityRequired`); a failed output sink stops
the owned provider (`AgentObservationFailed`) rather than accepting invisible work.
If authority was already consumed, existing receipt reconciliation still applies.
Model: `claude-fable-5`, verified against the locally
installed CLI 2.1.269, which rejects `stream-json` under `--print` without `--verbose`.
This adds no tool permission and does not enable any permission-skipping flag.

Inputs read for this decision, lowercase SHA-256 over file bytes at
`4da4112d1dd69e38782b1ca1ecd36e44c888cf66`:

| Input | Digest |
| --- | --- |
| `src/factory-visible-claude.mjs` | `81e2a0279e4e616008f168385c4c8631b58088d98fd6db650153dc2566d3fca0` |
| `src/factory-agent.mjs` | `932e54b7c3eb049c7c514ad225be874e732deea445672c4d299a3862aec738d6` |
| `scripts/github-portfolio-autonomous.mjs` | `ab3e0a2b55102daddc2ce7d6ee784daded1487015db01090c2d167bdf66c9f5f` |
| `tests/factory-headless-claude.test.mjs` | `fb72c4db69b5d8a27df551425dea78ae9e6238455ff7931b8b7ed212dbc2dbc7` |
| `tests/factory-visible-claude.test.mjs` | `95aa5ece5cba937882a1b131cef5f0c83f9dc95c76ff2a0e13cb9ae8cf629ed6` |
| `docs/autonomous-factory.md` | `a6094efe99171f0d78828c64dc01427f50df8e37066615aa602ceecbde9828d4` |

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
