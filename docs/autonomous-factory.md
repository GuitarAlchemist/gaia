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

What is rendered is deliberately narrow: closed event, block, model and configured-tool
names, tool outcome, byte sizes, booleans, and the presence/size of stderr. Unknown,
case-variant, and confusable provider identifiers become the fixed token `unknown`;
provider spellings are never rendered. Prompts, assistant prose, tool inputs and tool
results appear only as a size, because those are where task text, file bodies and
credentials live. Control characters are replaced as defense in depth. Stderr payloads
are withheld too: provider diagnostics may echo credentials or input. The stream budget
is separate from the small JSON result bound and both are enforced; exceeding either
stops the provider. The CLI requires a writable inherited terminal before opening the
authority store (`ObservabilityRequired`); a failed output sink stops
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

### Decision: close the observability boundary before authority (ENG-02)

Independent review of head `7a458e479aacc6417fd56236634e0293a41a8d84` found two ways the
visible-stream claim could fail: an already-unwritable TTY was rejected only after `STARTED`, and
printable provider-controlled identifiers could pass through the renderer
([preflight](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057534488),
[renderer](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057534485)).
Two perspectives and three placements were compared before implementation.

- **Authority perspective — rejected: check terminal state inside `store.start()`.** The store has no
  terminal capability and must not couple durable authority to one process UI.
- **Transport perspective — rejected: rely on the streaming adapter's late observability check and
  character sanitization.** The late check follows authority consumption, while sanitization makes
  payload terminal-safe but does not make printable payload confidential.
- **Composition/projection perspective — selected: share one writable-TTY predicate between the CLI
  preflight and streaming adapter, and project every provider identifier through exact closed
  vocabularies.** The preflight runs before the store opens. Known event/block/tool/model values
  remain visible; unknown, case-variant, or confusable values become a fixed `unknown` token. The
  renderer retains only normalized tool names, never the provider spelling.

A sink can still fail after preflight, so `AgentObservationFailed` remains the runtime backstop.
The host remains the one authority consumer and the renderer remains a zero-authority projection.
Reversibility class: **freely reversible in code but unsafe for authority and confidentiality**.
The exact pre-repair inputs were `scripts/github-portfolio-autonomous.mjs`
`5381ecd539df1f10fad1bbd1cb67028bb61e7c2c0c672b1d8f171d2454551f18`,
`src/factory-visible-claude.mjs` `6805ddcd4cab26d58be97fb12205f438963d201aa2cef1527de73024b806e883`,
`tests/factory-streaming-claude.test.mjs` `094c4c5b99fa12069e497ddcca3eb6f2067deca54b9388f940a2d207af3b1e22`,
`tests/autonomous-factory-errors.test.mjs` `c6770f140e24f665217b800a08a8dc45690c6b5e72c6711959de6ab543fd3a0f`,
and the independent findings linked above.

### Decision: terminal receipts must carry replayable factory evidence (ENG-02)

Independent review of head `2d6cb73006185ea1317cafb93a879214ab73f49e`
([thread](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057322231))
showed that the autonomous wrapper accepted only a few scalar factory fields. A skeletal receipt
could therefore settle `STARTED` without worker evidence, a measured change set, or reviewer
evidence. Two validation placements were compared before implementation.

- **Rejected: keep scalar spot checks in the autonomous wrapper.** This is locally small but allows
  the wrapper to manufacture terminal truth from a status and verdict while omitting the evidence
  structures that make those claims replayable.
- **Rejected: import the execution module into the authority/store contract.** Reusing execution
  code directly would couple the pure persisted-contract reader to filesystem, process, and Git
  mechanisms, reversing the architecture's dependency direction.
- **Selected: validate the closed factory receipt projection in the pure autonomous contract.** The
  terminal reader requires the base binding, worker evidence descriptor, measured change-set
  identity and files, and reviewer evidence descriptor before it can settle a job. It recomputes
  the change-set identity with the factory's documented recipe and preserves the existing exact
  job, intent, idempotency, task, base, status, and approval bindings. Missing or contradictory
  evidence remains `InvalidReceipt`, so reconciliation retains the occupied slot.

Reversibility class: **freely reversible in code but unsafe in operation**; rollback reopens the
reproduced false-terminal path. This does not prove the referenced evidence files still exist or
that their claims are true; it proves only that the persisted terminal shape contains the bounded,
content-addressed structures emitted by the factory. The exact pre-repair inputs were
`docs/autonomous-factory.md` `c8e48b38a3ab51c6d219fd9184b594228398557d2ff8bd33fa10d05695ae1869`,
`src/autonomous-factory-contract.mjs` `17a7c37224dd5bfa4b8f35b75e5a783da61de2b9ce7adc5f32eaff651a6dfa7f`,
`src/factory-agent.mjs` `932e54b7c3eb049c7c514ad225be874e732deea445672c4d299a3862aec738d6`,
and the independent finding linked above.

### Decision: replay completed candidate sidecars after interruption (ENG-02)

Independent review of head `9bda592a4a09da1a6b2dd7e5db4f7cbea9db103e`
([thread](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057486468))
showed a recovery gap: the authority store can commit a terminal receipt before the host emits its
rebuildable artifact-chain sidecar. A crash in that interval, or a transient first write failure,
left later ticks skipping the completed job and therefore never retried the sidecar. Two independent
perspectives and three materially different placements were compared before implementation.

- **Authority perspective — rejected: make sidecar success part of `store.finish()`.** This would
  keep a job `STARTED` when a projection write fails, occupying the single execution slot and
  promoting a rebuildable file into terminal authority.
- **Authority perspective — rejected: add a durable sidecar outbox to SQLite.** It would make the
  transition atomic, but requires an authority-schema migration and a second lifecycle for data
  already reconstructible from the validated receipt and intent.
- **Projection perspective — selected: replay every completed receipt through the idempotent
  emitter before ordinary scheduling.** `WRITTEN` and `UNCHANGED` prove convergence without another
  worker invocation; `FAILED` remains explicit, does not rewrite conflicting evidence, and does not
  prevent another completed projection or unrelated eligible work from being attempted. Recovery
  precedes disabled-policy and exhausted-budget refusal because it consumes no authority or run.

The host composition remains the one named sidecar writer. `COMPLETED` remains terminal truth;
projection status cannot alter the receipt, release or occupy a slot, or call worker execution or
receipt reconciliation. Reversibility class: **freely reversible in code but unsafe for recovery**;
rollback restores the interval in which a durable terminal receipt can permanently lack its chain.
The exact pre-repair inputs were `scripts/github-portfolio-autonomous.mjs`
`f555fb3ba76bcc04f109fd5dd8e89d7686b24dc32c77cf85feac125a16e0031b`,
`src/autonomous-factory.mjs` `4c8bf9da787866e45f6bf82949096d9bd3586ef4a40f3554c2cb2e2b3601cc82`,
`src/autonomous-factory-store.mjs` `38ac960b329b992ed52c2da46644d9583c0f025e74ba0bf8d6bd7a6d32d638cd`,
`src/artifact-chain-files.mjs` `ef0d6f6fe4e96f4e0381863ed903faa4507098b488779e66d828ed1c54af882e`,
`docs/autonomous-factory.md` `b261decfba4b4414f155d4d1c7a9dcf8db5302dd6bdda620ead71e84b21ef5b3`,
`docs/artifact-chain.md` `fd3d31e6317ff2882bbac18eb857beb787561a6aec715e322ffebdc15e20f104`,
and the independent finding linked above.

### Decision: publish execution receipts before terminal authority (ENG-02)

Independent review of head `ab5843d32534f17090b2e455ae7d0da8d275f44f`
([thread](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057605985))
showed that `receipt.json` bytes were flushed but its two newly created namespace entries were not:
the receipt in the idempotency directory and that directory in the evidence root. A power loss could
therefore leave SQLite `COMPLETED` while replay had no pathname from which to rebuild the candidate
chain. Two perspectives and three materially different repairs were compared before implementation.

- **Execution perspective — selected: make the receipt writer own namespace publication.** A new
  receipt is flushed and closed, then the idempotency directory and evidence root are flushed before
  execution returns on POSIX. Every valid existing-receipt path repeats those barriers, so a complete
  receipt left by an earlier uncertain flush can reconcile without another provider invocation. On
  Windows, where Node does not expose a portable directory-fsync handle, the writer reopens and
  flushes the receipt as the strongest available per-entry metadata barrier and makes no claim of
  equivalent directory durability.
- **Authority perspective — rejected: journal receipt bytes in SQLite.** This could reconstruct a
  missing file uniformly, but would add a second execution-evidence owner, a schema migration and a
  new pre-terminal receipt lifecycle to solve a publication defect at the existing writer boundary.
- **Projection perspective — rejected: reconstruct from the terminal ledger only.** This could help
  after `COMPLETED`, but not after the provider effect and receipt write while the job remains
  `STARTED`; it would also manufacture file provenance from a different store.

A write, close or publication-barrier failure is the path-free typed refusal
`ExecutionReceiptDurabilityUncertain`. Complete bytes are retained because the provider effect may
already have happened. The job remains `STARTED`; reconciliation validates the existing operation
binding, retries publication without rerunning the provider, and only then may commit `COMPLETED`.
Corrupt or foreign receipts retain their existing refusals. Reversibility class: **freely reversible
in code but unsafe for recovery**; rollback restores a crash interval in which terminal authority can
outlive the pathname needed by its evidence projection. The exact pre-repair inputs were
`docs/autonomous-factory.md` `2cc6c0716607a40bde0e78bdd3dfc91c66578fffe4d0f7387f15fa8fac9a0da1`,
`src/github-portfolio-execution.mjs` `4aa5fce1e12eb29b4fe22696d9832493f584d14b2753475196a107be5e6583b3`,
`tests/github-portfolio-execution.test.mjs` `d4f2de9709eadd2eded35602f2c1b74c450322cddd79b6d821ced3aec7eadc92`,
`ARCHITECTURE.md` `5ded57ae736b6fb55fd7ff5808fd054e73c1676ee3b2ea06b22d06082adf7be3`,
and the independent finding linked above.

### Superseded decision: comparison-only GitHub repository identity (ENG-02)

**Superseded by the durable-identity decision below after exact-head review reproduced a
case-only double-authority path. Preserved here as immutable Failure Evidence, not current design.**

Independent review of head `ab5843d32534f17090b2e455ae7d0da8d275f44f`
([thread](https://github.com/GuitarAlchemist/gaia/pull/146#discussion_r4057605976))
showed that one-time policy, preview, admission and execution did not share GitHub's
case-insensitive owner/name semantics. A case-only difference could refuse before authority, or—if
fixed at only the first check—consume `STARTED` and then fail at execution with no receipt. Two
identity designs were compared across the complete path before implementation.

- **Semantic-comparison perspective — selected: preserve spelling and compare ASCII owner/name
  case-insensitively at provider-identity seams.** Target selection, autonomous preview scope,
  policy/job replay, store admission and execution scope all accept case-only variants. The stored
  policy and provider intent retain their original bytes, so existing job keys, intent revisions,
  idempotency keys and receipts remain unchanged. The database row repository must still exactly
  equal its captured intent repository; disagreement there is corruption, not provider identity.
- **Canonical-storage perspective — rejected: lowercase every persisted repository.** This would
  simplify future equality but requires a versioned migration of policy rows, intents, job keys,
  idempotency keys and bound receipts. Rewriting stable identity to repair comparison semantics
  would invalidate evidence already produced under the current recipes.

Case-only variants proceed silently as one GitHub repository. Genuinely different repositories keep
`RepositoryScopeMismatch` before provider invocation or `RepositoryMismatch` at direct store
admission. Malformed values retain their existing contract refusals. Reversibility class: **freely
reversible in storage terms but unsafe for configured policy**; rollback can strand an immutable
policy or move a scope failure past authority consumption. The exact pre-repair inputs were
`docs/autonomous-factory.md` `b0681a8c226239f8213aa2afc76325a990dd3a394dbf59cd1cd2ebc1ef6aa638`,
`src/autonomous-factory.mjs` `4c8bf9da787866e45f6bf82949096d9bd3586ef4a40f3554c2cb2e2b3601cc82`,
`src/autonomous-factory-store.mjs` `38ac960b329b992ed52c2da46644d9583c0f025e74ba0bf8d6bd7a6d32d638cd`,
`src/github-portfolio.mjs` `9bae4db1fb9aaf99c0e7980a4cc9e158325c0225c40ed701d094d31385539404`,
`src/github-portfolio-execution.mjs` `1000bbcac044849a8a360804e88b0acfe6d3c2f8eb9bb952cd7ca1206afcea29`,
`tests/autonomous-factory.test.mjs` `548c6d6b9d97d384cf59a7f8d572721995d31e856fd77f1167db3598cc14267e`,
`tests/autonomous-factory-store.test.mjs` `f13f493acdb51a7b60d7d108969dce3e4e1c5500f8984de8945a56665548449b`,
`tests/github-portfolio-execution.test.mjs` `ce17272eeb62d3843c3a86b890142066b9b496723b593fa91c834858c0df261f`,
and the independent finding linked above.

### Decision: accept exactly the two producer receipt forms (ENG-02)

A permissive validator that merely checked any fields it recognized was rejected: it let a direct
receipt carry stray repair claims and let a repaired receipt settle without proving the initial and
final review relationship. Importing the process-owning factory implementation into the pure store
contract was also rejected because it reverses the dependency boundary.

**Selected:** the contract is an exact two-form union matching `executeAgentFactory`. Direct
approval has no `repair` or `reviews` and its sole reviewer approves. Repaired output requires
`repair` and `reviews` together; repair evidence, host authority and scope are closed; initial and
repaired candidate identities differ; the repaired identity equals the terminal change-set identity;
the initial review is `REQUEST_CHANGES`; the top-level reviewer is byte-canonical equal to the final
review; and that final verdict alone controls ready versus rejected status. Any missing, mixed or
extra form remains `InvalidReceipt` and keeps `STARTED` occupied. This is freely reversible in code
but unsafe to relax because a false terminal receipt spends durable authority.

### Decision: case-insensitive durable identity, original evidence spelling (ENG-02)

Comparison-only folding was rejected because two processes could still persist distinct keys or
SQLite identities for one GitHub repository. Lowercasing stored intents and receipts was rejected
because it would rewrite captured provider evidence and strand existing evidence directories.

**Selected:** new autonomous job keys hash the lowercase repository identity, while intent, policy,
row and receipt spelling stays exactly as captured. SQLite independently enforces
`repository COLLATE NOCASE, item_id, draft_number` uniqueness. Development ledgers created before
this constraint gain the index transactionally; legacy keys remain under their original recipe and
are aliased by the new key rather than rewritten, so restart and redelivery reconcile one authority
against the original idempotency path. A collision while installing the index is corruption and
fails closed. The shared `isAutonomousRepository` predicate now gates policy, hosted discovery and
portfolio execution, avoiding narrower local regexes such as the one that rejected valid
`Owner/.github`. Reversibility is unsafe without an equivalent provider-identity constraint.

### Decision: the host runs the tests, the models only read the result (#163)

Until #163 no step executed a test. The visible worker's tools are `Read,Write,Edit,Glob,Grep`,
the reviewer is read-only, and the prompt told both that "tests are run separately by the
supervisor", a step that did not exist. Issue 104's candidate settled `CANDIDATE_READY` with an
`APPROVE` while one of its own tests and the README gate-count test failed. Giving the worker a
shell was rejected: it widens provider authority and still leaves "tests passed" as model prose.

**Selected:** `executeAgentFactory` accepts a `runVerification` adapter, and the autonomous
composition always supplies `runNodeTestVerification`. After the worker, and again after the one
repair, the host runs `node --test --test-reporter=spec` in the candidate worktree with
`process.execPath`:

- **Runtime.** A `.node-version` in the worktree must equal the host runtime, or the run refuses
  with `VerificationRuntimeMismatch`. `watch` and `tick` check the trusted clone's pin before
  consuming a run.
- **Bounds.** 30 minutes and 8 MiB of combined output. A timeout or an output overflow kills the
  process tree and is recorded as a failed run (`termination: timeout | output-limit`), not
  thrown.
- **Environment.** The same allow-list as the subscription providers, plus `NO_COLOR`, so GitHub
  and provider credentials are not inherited. The candidate's code still runs as the host user,
  with the network available: this is the same trust as the worker that wrote it, not a sandbox.
- **Postcondition.** Git HEAD, the index, the change set and the worktree tree must be unchanged
  afterwards, else `VerificationMutation`.

The receipt gains `verification`: schema `gaia-factory-verification/1`, command, runtime version and
pin, the measured `candidateIdentity`, termination, exit code, the `ℹ tests/pass/fail` counts, and
the output as content-addressed evidence with role `verification` (`verification-final` after a
repair, with both runs under `verifications.initial/final`). `passed` means a normal exit 0 with
at least one test and zero failures; the contract recomputes it rather than trusting it. The
reviewer receives the facts and, when the run failed, the last 16 KiB of output, as data. The
repair worker receives that output appended to the review findings.

Status: `completed`, hence `CANDIDATE_READY`, now needs an `APPROVE` **and** a passing run. An
approval over a failing run is `rejected`; repair is still driven only by a `REQUEST_CHANGES`
review, so the publication gate's repaired form is unchanged. `terminal()` validates new receipts
with `requireVerification`, so a composition without the adapter cannot settle a candidate. Stored
receipts from before #163 carry no verification and remain readable. The same change aligns the
contract with the factory's `reviewer-initial` evidence role for a repaired receipt, which it
previously refused.

## Ownership and recovery

The application owns preview, authority consumption, execution and reconciliation.
The host owns downloads and checkout preparation. SQLite owns serialized revocation,
budget and unique admission. Six bus verbs and the manual operator remain unchanged.

The stable job key derives from the lowercase GitHub repository identity, issue node ID and Draft
number; captured repository spelling remains evidence rather than identity. Changing
portfolio/source, case spelling or restarting cannot create a second job for that Draft. STARTED
committed under `BEGIN IMMEDIATE` is the authorization linearization point. Losing
actors receive `JobExists` or `HostBusy` without invoking the provider. The execution
key binds that job key and fresh intent revision.

Before new selection, a STARTED job is reconciled with its original intent/key. A bound
completed/rejected factory receipt or a measured `no-change` receipt closes it. Missing, corrupt or mismatched evidence
returns `RECONCILIATION_REQUIRED`, retaining the slot. Even a crash before invocation
cannot establish safe absence: there is no automatic lock stealing or blind relaunch.
Before policy and budget gates or new selection, the host also replays every COMPLETED
receipt through the candidate-sidecar emitter. This projection recovery invokes no
worker, consumes no run, continues after per-job failure, and leaves terminal authority
untouched. Revocation and starts serialize in one database; GitHub readback and process
spawn are not atomic. Remote source movement in that interval remains a limitation; the
local source is rechecked immediately before execution.

This guarantee covers actors sharing this registry. Manual runs, another database,
another host and malicious OS-user modification are outside it. Reconcile prior
manual jobs, especially #141/#145, before activation; an empty registry is not proof
that no previous worker ran. Rollback is revoke and stop the owned watcher, retaining
all state and candidate work.

### No-candidate results and explicit retirement

A successful worker invocation with no Git candidate now publishes a bound factory
receipt with `status: no-change`, reason `NoCandidateChange`, its worker evidence,
and the measured empty change set. The autonomous result is `NO_CANDIDATE`, not
`CANDIDATE_READY` or a review rejection. Empty files alone are insufficient: both
status and patch must have zero bytes and the empty-content digest, with the
original base and recomputed change-set identity. There is no reviewer or repair
claim. This does not prove the issue is implemented. The used run is not refunded.
Candidate-sidecar recovery skips this non-candidate outcome.

Older failures with only worker output remain unresolved; no receipt is synthesized
from provider prose. For an obsolete job whose issue is completed and whose
unmerged Draft is closed at the original head/ref, the operator may explicitly retire
the job. First stop the old watcher and its owned provider processes and preserve
a database backup plus the original worktree/evidence. This is an operator
precondition, not a liveness inference made by the command. Closing a Draft does not
cancel an already authorized process. Do not delete any candidate edits.

```powershell
node scripts/github-portfolio-autonomous.mjs retire-closed --state C:\Gaia\state --job <job-key> --intent-revision <original-intent-revision>
# Inspect RETIREMENT_PREVIEW, then explicitly apply the same bounded request:
node scripts/github-portfolio-autonomous.mjs retire-closed --state C:\Gaia\state --job <job-key> --intent-revision <original-intent-revision> --apply true
```

Each nonterminal invocation rereads only the exact issue and pull request through
GitHub GETs. Wrong repository/id/number, open issue, non-completed closure, merged
PR, moved head/ref or unavailable evidence refuses. Preview makes no terminal
write. Apply records `gaia-autonomous-retirement/1`, status `ABANDONED`, with the
original job/intent/execution identities and closed observations. It neither runs
an agent nor writes GitHub, and is never invoked by watch. No past success,
review, absence of effects, or reconciliation of a hosted Draft operation is claimed.

The SQLite `BEGIN IMMEDIATE` transaction serializes retirement against completion:
one terminal wins, same-result repeats replay, conflicting late results refuse.
The row remains COMPLETED (meaning *job terminal*), its budget remains consumed,
and the same issue/Draft cannot run again. No candidate sidecar is minted.

These additive terminal contracts require this reader revision or newer on restart;
old readers fail closed rather than understand them. Do not erase state to roll
back or re-enable authority. Preserve the original database backup as evidence,
not as a way to restore spent capacity. Design alternatives and the incident are
in [the bounded repair intent](../intent/pump-no-candidate/intent.md).

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
