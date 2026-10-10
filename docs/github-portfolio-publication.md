# Authorized GitHub candidate publication

Gaia's publication seam turns one reviewed, content-addressed candidate into a commit,
an explicitly leased branch push, and a pull request. It does not merge, close issues,
or add a seventh bus verb.

## Boundary

`createGitHubCandidatePublicationAdapter` accepts only:

- one exact `gaia-github-candidate-publish-intent/1` with `effect: NONE`;
- a separately signed, single-use `PUBLISH_CANDIDATE` grant bound to that intent revision;
- an effect adapter with the closed methods `observe`, `commit`, `push`, and
  `openPullRequest`.

The controller observes repository identity, HEAD, remote base, and the factory
change-set identity before authority is consumed. The Git implementation repeats each
identity check at the mutation boundary where it remains relevant: local HEAD and bytes
before commit, remote base and deterministic branch before push, then exact branch and
commit bindings when reusing or creating a pull request. Any provider diagnostic is replaced by a
typed, redacted Gaia error before it crosses the module boundary.

Publication uses a deterministic branch name and idempotency key. A remote branch may
be created only with an explicit `--force-with-lease=<branch>:` expectation that it does
not exist. An existing branch is accepted only when it already names the exact candidate
commit. Pull-request creation first searches all pull requests for that exact head branch
and reuses the one exact match; ambiguous or contradictory state is refused.

## Deliberate exclusions

- no merge, direct issue mutation, review submission, label mutation, or deployment;
- an issue-linked pull request may declare `Closes #N`, but that has effect only after a separate authorized merge;
- no arbitrary command/effect list supplied by a caller;
- no authority derived from prompts, bus messages, GitHub labels, or provider output;
- no claim that local commit creation is crash-recoverable yet.

The last point is the next required slice. A process crash after the local commit but
before the push moves local HEAD. A retry therefore fails closed as stale instead of
silently publishing or duplicating work. A durable, content-addressed publication
transition receipt must make that state resumable before unattended operation is safe.

## Verification

The tests exercise the pure publication controller with fake effects and real
temporary Git repositories/worktrees with a fake GitHub process seam. They prove exact ordering,
authority refusal before mutation, provider-error redaction, deterministic identity,
leased branch creation, and the absence of merge capability.

## Bounded staging investigation — 2026-10-10

Origin: the reported Blue policy refusals for `git add CONTEXT.md docs/adr/` and
a replacement wrapper containing that old command as text; related #103/#246.
The current Git/gh effect adapter independently contains `git add --all`, a second
concrete scope-overrun instance. The exact Blue guard implementation, rule, cwd,
ownership/index snapshot and first real action receipt remain unavailable.

The selected local repair keeps the existing publication intent, signed authority,
closed effect sequence and final content-addressed receipt. It derives literal file
targets from the exact factory change-set measurement already bound by admission,
refuses any initial staged change (ownership cannot be inferred), rereads after branch
preparation, verifies paths and bytes after staging, and checks the resulting commit
tree and parent. `commit --only` excludes unrelated index entries appearing after the
last reading. No folder target, blanket stage, arbitrary shell/wrapper parsing,
Run anyway, permission change, retry, reset or stash is supplied.

A generic resumption engine was considered and rejected: it would duplicate lifecycle
ownership without a verified provider-policy port or durable first-action receipt.
The complete admitted candidate remains the scope. The adapter cannot select a safe partial subset from a dirty checkout of ambiguous
ownership. An unstaged/untracked third-party file already included in the signed
candidate digest is indistinguishable here and will be included. Initial complete
host ownership remains an unverified prerequisite; this API supplies no ownership
manifest. Initial staged changes and post-admission drift are refused.

Tests use real temporary Git repositories in the existing CI, plus injected transport
for Github and the existing Ed25519 single-use authority. Quoted old broad command
text in a candidate file is treated as data; the adapter executes only its fixed Git
argv. This does not reproduce or repair the external Blue guard's parsing, and gives
no blanket allowance to wrappers. Delayed observations are refused when the signed
grant expires at consumption; duplicate consumption repeats no mutation. The final
local commit OID is a verified receipt in the harness, not an observed Blue receipt.

Policy-scope refusal (`IndexScopeRefused`) is distinct from publication authority
refusal (`AuthorityRefused`) and streaming `WAITING_PERMISSION`. None supplies new
authority. State-drift/verification refusals remain closed. Host observation is not
an ownership proof or a cross-process lock; concurrent writes to admitted files and
commit hooks can still produce a verification failure after a mutation. The adapter
preserves that evidence and performs no automatic rollback or replay.

Remaining integration blockers: effective premission permission source and CLI
manifest from #246; the exact Blue guard and initial ownership observation; a durable
intermediate first-action record, post-consumption TTL fencing, and recovery after
crash. The existing publication receipt and signed consumption ledger are reused,
but the final receipt alone cannot make an interrupted local commit resumable.
Real mission execution and real Blue resumption remain unverified.

### Reported Blue timing, separate from harness evidence

The supervising task reports instruction received at 2026-10-10T19:35:40Z,
direct `git status` and `git diff --cached` launched at 19:36:16Z (+36 s), and
command termination at 19:36:52Z (+72 s), with no new dialog observed. There is no
detailed stdout here; an empty index remains the worker's assertion. Push and Codex
reply preceded the instruction and cannot establish resumption caused by it.

These are separate observed/reportable stages: instruction, acknowledgement,
first-action start, action finish and verified postcondition. A single 60-second
success boolean would incorrectly erase that distinction. The shipped grant expiry
test covers authority consumption only. It does not implement an acknowledgement
TTL, first-action TTL or result TTL for Blue; such deadlines need an existing
provider observation and durable receipt binding, not a reinterpretation of grant
expiry or a completion marker.

### CI witnesses for the bounded patch

Test-only RED: `d88da6cfb9fdc76b088f33f25e7fbbaa0e972d37`,
[CI 38080425203](https://github.com/GuitarAlchemist/gaia/actions/runs/38080425203).
Windows: 2529 executed, 2524 passed, 3 failed, 2 skipped, 0 cancelled. Linux:
2482 passed, 3 failed, 44 skipped. Architecture passed. All three failures are
the new original-mechanism oracles; the fourth authority regression already passes.
The corrected candidate retains those oracles, adds late-index/owned-content and
literal filename controls, and preserves the original generic diagnostic-redaction
assertions. The draft's current head and CI result bind subsequent verification.

### Commit identity redesign witness

Independent review of `1957ea8a046b221862f3e48b17eec602727e9d06` found that
the adapter read `commitOid` but checked parent/tree through mutable `HEAD`.
That candidate passed [CI 38080798122](https://github.com/GuitarAlchemist/gaia/actions/runs/38080798122);
those passing tests did not establish this invariant. The boundary was marked
`BLOCKED_REDESIGN` before promotion, rather than treating the passing suite as acceptance.

The existing commit effect owns verification of the object its receipt returns.
Two designs were compared: (A) immutable-object parent/tree checks using the returned
OID, selected; (B) serialize mutable HEAD through a cross-process host lock, rejected
because such a lock is not demonstrated here and adds ownership coupling. Selection
is bound to this report's Git revision. No new runner, receipt schema, permission
or lifecycle owner is added. The corrected code checks `${commitOid}^` and
`${commitOid}^{tree}`, so moving HEAD cannot substitute the object being checked.

Test-only second RED: `0752d8966f8ba19945682b1848c133682f9d1626`,
[CI 38081074743](https://github.com/GuitarAlchemist/gaia/actions/runs/38081074743).
Windows: 2529 executed, 2526 passed, 1 failed, 2 skipped, 0 cancelled.
Linux: 2484 passed, 1 failed, 44 skipped; architecture passed.
The public-seam witness creates altered A and correct B, moves HEAD to B after A's
OID is captured, and requires `StagingVerificationFailed` with zero push/PR.
The old mechanism completes publication instead, producing Missing expected rejection.
The exact same test is retained for the correction and independent re-review.

### Verification base reconciliation

While final verification was being scheduled, main advanced independently to
`856adad162fd921eb86fc06b5fb7e490e2b9c5fb` by PR244. Its extra test changed the
README declaration count from2398 to2399, producing a merge conflict with this
patch's four-declaration update. The isolated draft branch is rebased by Git Data
onto that observed base, preserving its existing docs/worktree-root-guard.md and
tests/factory-agent.test.mjs changes. This patch's four declarations make2403.
The corrected effect/controller/test blobs are unchanged; prior RED/initial GREEN
witnesses remain pinned to their original SHA and base. No PR merge is performed.
