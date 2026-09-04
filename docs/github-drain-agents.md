# GitHub drain agent team R0

Status: R0 delivers three Claude Code subagent definitions under `.claude/agents/`, this
document, and the `node:test` gates in `tests/github-drain-agents.test.mjs`. Nothing in `src/`
or `scripts/` changes. The bus keeps its six non-privileged verbs and no agent is reachable from
the kernel.

## Operator problem

On 2026-09-03 the Gaia fleet drained a portfolio of open pull requests by hand: a coordinator
lane classified each PR, spawned one Spec/adversarial and one Standards review per published
head, spawned bounded repairs when a review requested changes, reconciled the README gate
counter after every merge, and handed the operator the exact merge command. The operator asked
for that practice to be saved in the repository as a specialist agent or a team of agents, and
said the fleet needs coordinators (`gaia-drain-coordinator-status.md:11`).

The practice is worth saving because it was measured, not designed. Four times the second review
axis changed the verdict the first axis had given (`gaia-drain-coordinator-status.md:40-54`,
`gaia-drain-coordinator-status.md:2473`). Every open PR was a draft when the first merge was
attempted, so every merge command would have failed on GitHub even if allowed
(`gaia-drain-coordinator-status.md:73-77`). Every merge re-conflicted every other open PR on one
README line (`gaia-drain-coordinator-status.md:362-372`). A merge was once made on a verdict that
named a different commit than the one merged (`gaia-drain-coordinator-status.md:389`). Each of
those is a rule below, each with the line that motivated it, so the next reader can falsify it.

## Design It Twice

The team is an authority boundary and an orchestration protocol, so ENG-02 applies. Four
interfaces were compared; three are materially different and one is a hybrid that was checked
because it already exists.

### A. One omnibus GitHub agent

One subagent with `Read`, `Bash`, and `Write`, allowed to list, review, repair, mark ready, and
merge. Shortest operator path: "drain the portfolio".

Rejected. The author of a change cannot approve it (ENG-08,
`docs/engineering-and-research-principles.md:73`), and design variants from one context are not
independent review (`docs/engineering-and-research-principles.md:35`). The fleet measured why
that matters: on four of four PRs the second axis, run in a separate context, changed the
outcome the first axis had reached (`gaia-drain-coordinator-status.md:40-54`,
`gaia-drain-coordinator-status.md:105-108`). One context is one axis. An agent that holds the
merge command while it reviews is also the failure the operator CLI rejected as its option (a):
possession of the command becomes possession of the authority
(`docs/github-portfolio-operator.md:16-33`).

### B. Kernel-mediated publication

A `src/` module that models a merge intent, an effect adapter that runs `gh`, and a seventh bus
verb so agents route every GitHub write through Gaia's authority seam. Maximum fidelity to the
architecture map.

Rejected for R0. It adds a GitHub write path to `src/` and a privileged verb, which
`ARCHITECTURE.md:160-164` forbids, and the kernel currently has no merge intent at all:
`ARCHITECTURE.md:17-19` keeps merge authority on Gaia's non-goals list on purpose. Building
the grant seam before the intent exists is the plumbing failure the operator CLI rejected as its
option (b): a signed artifact whose pinned intent can drift from what is executed
(`docs/github-portfolio-operator.md:34-52`). This is the R1 direction, stated under **Should an
Ed25519 grant gate the publisher?** below, once a merge intent is designed on its own evidence.

### C. Three authority-separated edge adapters (chosen)

Three subagents, each with exactly the tools its role needs and a prompt that encodes the
measured rules:

- `github-drain-coordinator` reads GitHub and the tree and writes one ledger;
- `github-drain-reviewer` reads one detached clean clone at one full SHA on one axis and writes
  one artifact;
- `github-drain-publisher` reads an explicit order and two artifacts, re-measures GitHub, and
  runs at most four `gh` write commands.

This is deeper than A at the same width: the operator still says "classify", "review", or
"publish", but the dual-axis requirement, the exact-head binding, the draft-then-ready sequence,
the matched-head merge, and the one-merge-then-reclassify ordering are inside the roles instead
of inside the operator's memory. It is shallower than B by design: no kernel change, no new
seam, freely reversible by deleting three files.

Cost, stated plainly: a subagent's tool list confines the harness surface, not the shell. A
publisher with `Bash` could type a command its prompt forbids. R0 accepts this because the same
fleet measured a second, independent gate: the harness permission classifier denied the merge
command four times before the operator allowed it
(`gaia-drain-coordinator-status.md:73-77`, `gaia-drain-coordinator-status.md:11`). The prompt is
policy; the permission mode and the human at the interactive session are the enforcement. R1
replaces that with a grant.

### D. Reuse the operator CLI as the publisher

`scripts/github-portfolio-operator.mjs run` already binds a human, a key, an intent revision,
and a receipt. Rejected because its execution adapter runs a factory candidate through worker,
reviewer, and bounded repair; it performs no merge, publish, or issue mutation
(`docs/github-portfolio-operator.md:254-260`). Reusing it would be a name, not a mechanism.

## The three roles

Declared tool universe: `Read`, `Grep`, `Glob`, `Bash`, `Write`.

| Agent | Tools | Model |
| --- | --- | --- |
| `github-drain-coordinator` | Read, Grep, Glob, Bash, Write | claude-fable-5-1 |
| `github-drain-reviewer` | Read, Grep, Glob, Bash, Write | claude-fable-5-1 |
| `github-drain-publisher` | Read, Bash | claude-fable-5-1 |

The universe and the model are the fleet's measured launcher defaults (`run-lane.ps1:6-7`). The
verdict-changing R4 Standards review and every R5 review and repair ran on that model
(`prompts/pr92-r4-standards-review-fable.txt:1`). The publisher gets no `Write`, `Grep`, or
`Glob`: it reads an order and two artifacts and returns a receipt as its reply.

### `github-drain-coordinator`

Authority: read GitHub (`gh pr list`, `gh pr view`, `gh pr checks`, `gh issue list`,
`gh issue view`, `gh api` GET only) and the local tree (`git fetch`, `rev-parse`, `merge-base`,
`log`, `diff`, `status`, `ls-files`, `show`); write exactly one file, the ledger. Refuses to
merge, mark ready, edit a body, close or comment, review, label, push, commit, checkout, repair,
resolve a conflict, spawn or message a lane, or edit any other file.

Classification vocabulary, in precedence order: `conflicting`, `changes-requested`,
`unreviewed`, `single-axis`, `dual-approved`, `merge-ready`, with `draft` as a flag beside the
class and `unknown` for a `mergeable` the provider has not computed. Next lane per class:
`reconcile`, `bounded repair`, `review Spec` plus `review Standards`, the missing axis,
`publish` or `wait`, `publish`. The ledger ends with a publication *proposal* that grants
nothing; only the operator turns it into an order.

### `github-drain-reviewer`

Authority: read one subject and the named inputs, run tests and scripts in it, write one
artifact and scratch reproducers outside the subject. Refuses any subject that is not a detached
clean clone at a named full SHA, with these named preconditions: `SUBJECT_MISSING`,
`SHA_NOT_FULL`, `SUBJECT_COMMIT_MISMATCH`, `SUBJECT_NOT_DETACHED`, `SUBJECT_DIRTY`,
`AXIS_INVALID`, `BASE_UNREACHABLE`, `ARTIFACT_UNNAMED`. The artifact carries the fixed-point
identity at start and end, the inputs treated as claims, reproducers with `file:line`,
mechanism-revert controls, the exact commands with counts, residuals in their own section, exactly
`APPROVE` or `REQUEST_CHANGES`, and the completion marker as its last line.

### `github-drain-publisher`

Authority: the four write commands below, only for actions the order names, only after every
check passes. Refuses with a named code otherwise. Never repairs, resolves conflicts, reviews,
pushes, labels, comments outside the ordered issue close, or deletes a branch.

```
gh pr ready N --repo OWNER/NAME
gh pr merge N --repo OWNER/NAME --squash --match-head-commit <headSha>
gh pr edit N --repo OWNER/NAME --body-file <bodyFile>
gh issue close M --repo OWNER/NAME --comment "<closeComment>"
```

## Publisher refusal vocabulary

| Code | Meaning |
| --- | --- |
| `ORDER_DIGEST_MISMATCH` | the order file cannot be read, or its SHA-256 is not the digest the invocation names |
| `ORDER_INCOMPLETE` | a required order field is missing, the SHA is not 40 lowercase hex, or an action is unknown |
| `ARTIFACT_MISSING` | a named review artifact cannot be read, or both name one file |
| `AXIS_MISSING` | the two artifacts do not cover Spec and Standards |
| `SHA_NOT_BOUND` | an artifact's `Subject:` line does not state `detached at <headSha>` (`detached at <approvedSha>` under the reconciliation class), or its `# PR #N` title line does not name the ordered PR; a SHA named elsewhere in the text binds nothing |
| `VERDICT_MISSING` | an artifact lacks the `APPROVE` verdict line or carries a `REQUEST_CHANGES` one |
| `MARKER_MISSING` | an artifact does not end with a completion marker |
| `RECONCILIATION_UNCLASSIFIED` | the order carries `approvedSha` and the commits between it and the head are not exactly the classified `base-merge`, `readme-counter`, and `architecture-record` commits, or the results at the head are absent |
| `HEAD_MISMATCH` | the published head is not the ordered SHA |
| `NOT_MERGEABLE` | `mergeable` is not `MERGEABLE` or `mergeStateStatus` is not `CLEAN` |
| `CHECKS_NOT_GREEN` | a check is failing or still pending |
| `ACTION_NOT_ORDERED` | the caller asked for an action the order does not list |
| `STATE_CHANGED` | the head moved between verification and the merge command |

## Publication order

```
publication-order/1
repository: OWNER/NAME
pullRequest: N
headSha: <40 lowercase hex>
specArtifact: <path>
standardsArtifact: <path>
actions: ready, merge
approvedSha: <40 lowercase hex>          (reconciliation class only)
reconciliation: <sha> <class>; ...       (reconciliation class only)
reconciliationResults: <suite; gate at headSha>   (reconciliation class only)
issuedBy: operator
```

The coordinator writes this block with `issuedBy` blank as a proposal, inside its ledger. The
operator copies it, with `issuedBy: operator`, into a file under the fleet artifact root: that
file is the publication order, a named channel, not prompt text. The operator names the file's
path and its SHA-256 digest in the publisher invocation; the publisher reads the file, recomputes
the digest, and refuses `ORDER_DIGEST_MISMATCH` when they differ or when the order arrives as
pasted text. The `issuedBy` line is a record, not a credential: what makes the order actable is
the publisher's re-measurement of the head, the mergeability, the checks, and the two artifacts.
A publication order never appears in a bus message, a label, a comment, or a review artifact;
the bus may carry a `send` whose text is the order's path and digest, a reference, never the
order itself (`gaia-architect-r1-udp-bridge-design.md:441-453`, `gaia-architect-r1-udp-bridge-design.md:461-467`).

What the channel does not yet do: reserve a receipt before the merge command runs. The R0
publisher has no `Write`; its receipt is its reply, which records the head SHA read immediately
before the merge command. The receipt reserved before authority is spent is the R1 operator
command under **Should an Ed25519 grant gate the publisher?** below.

## The drain sequence the roles encode

1. Every PR opens as a draft and stays one until both axes approve its exact head.
2. The coordinator classifies; unreviewed heads get both axes on one detached clean clone at the
   full SHA, concurrently.
3. A `REQUEST_CHANGES` on either axis sends the PR to a bounded repair whose specification is
   the blocking findings; the new head gets both axes again.
4. Dual `APPROVE` on the exact published head, `MERGEABLE`, `CLEAN`, checks green: the
   coordinator proposes; the operator orders; the publisher marks ready and squash-merges with
   `--match-head-commit`.
5. After one merge, every other open PR re-conflicts on the README gate counter. The
   coordinator reclassifies; the next PR is reconciled alone, its counter derived from the tests
   directory, its head proposed under the reconciliation class below when every commit is
   classified and reviewed on both axes otherwise, before the next order exists.
6. A linked issue is closed with a comment naming the merge commit and the two verdicts, after
   the merge, by order.

## Reconciliation class

A verdict binds to the head the artifact declares as its subject, and the fleet merged three PRs
on 2026-09-03 at heads no artifact declares: #85 at `7f3f92e`, #94 at `881b052`, #92 at
`c59e996`, each the dual-approved head plus a mechanical reconciliation verified by the full suite
and the architecture gate (`gaia-drain-coordinator-status.md:31`,
`gaia-drain-coordinator-status.md:43`, `gaia-drain-coordinator-status.md:45`,
`gaia-drain-coordinator-status.md:51`, at the later record revision in the manifest). Two fresh reviews per reconciliation would re-review one README
counter line after every merge, and every merge re-conflicts every other open PR on that line
(B35). So a publication order may name a head that is the dual-approved head plus
reconciliation-only commits, when it carries:

- `approvedSha`, the head both artifacts declare as their subject;
- `headSha`, the published head;
- `reconciliation`, every first-parent commit in `approvedSha..headSha`, each classified as
  exactly one of `base-merge` (a merge of the base branch: two parents, the second on the base),
  `readme-counter` (the README gate counter derived from the tests directory, nothing else), or
  `architecture-record` (the package.json architecture verification record refreshed over an
  auto-merged `ARCHITECTURE.md`, nothing else);
- `reconciliationResults`, the full-suite count and the architecture-gate verdict measured at
  `headSha`.

Measured by the coordinator in the local tree: with `<tree>` from
`git merge-tree --write-tree approvedSha <base>`, the diff `<tree>..headSha` touches nothing but
`README.md` and `package.json`; the `README.md` delta is the gate counter lines, with the
counter equal to the `^test(` count over the tests directory at `headSha`; the `package.json`
delta is the architecture record. That measurement admits #92's `ARCHITECTURE.md`, which the base
changed and the merge carried in unchanged, and refuses any hand edit. Re-verified by the
publisher from GitHub with GET: the first-parent chain from `headSha` reaches `approvedSha`
through exactly the classified commits; a `base-merge` has two parents with the second on the
base branch; a `readme-counter` commit changes only `README.md`; an `architecture-record`
commit changes only `package.json`; no file outside those two differs between `approvedSha` and
`headSha` unless the base changed it. Any other delta, an unclassified commit, an unknown class,
or missing results is `RECONCILIATION_UNCLASSIFIED`, and the head is `unreviewed`. The artifacts
bind to `approvedSha`; `HEAD_MISMATCH`, `NOT_MERGEABLE`, `CHECKS_NOT_GREEN`, and the merge
command still name `headSha`.

## Rules and the evidence that motivated them

Line anchors are to the fleet directory artifacts at the revisions in the evidence manifest. The
coordinator record is prepend-only, so its line numbers are valid at the named revision only.

| Rule | Encoded in | Evidence |
| --- | --- | --- |
| Dual review on the exact published head is mandatory; one axis is never enough | coordinator classes `unreviewed`, `single-axis`; publisher `AXIS_MISSING` | `gaia-drain-coordinator-status.md:40-54` (R4 Standards reversed the R4 Spec APPROVE, "4 for 4"), `gaia-drain-coordinator-status.md:105-108`, `gaia-drain-coordinator-status.md:2260`, `gaia-drain-coordinator-status.md:2473`, `prompts/pr92-r4-standards-review-fable.txt:1` |
| A verdict binds to the one full head SHA the artifact declares as its subject (`Subject:` line and `# PR #N` title), never to a SHA its text merely names | reviewer `SHA_NOT_FULL`, `SUBJECT_COMMIT_MISMATCH`, artifact shape; coordinator step 3(a); publisher `SHA_NOT_BOUND`, `HEAD_MISMATCH` | `gaia-drain-coordinator-status.md:21`, `gaia-drain-coordinator-status.md:163-164`, `pr92-r5-spec-review.md:5-8`, `prompts/pr92-r5-spec-review-fable.txt:3-4`; the counterexample: `pr92-r5-standards-review.md:7` names the entry `e98df9e` it repaired, where `pr92-r4-standards-review.md:3` had returned `REQUEST_CHANGES` |
| The publication order is a file under the fleet artifact root, read by the digest the invocation names | publisher `ORDER_DIGEST_MISMATCH`; coordinator proposal | `gaia-architect-r1-udp-bridge-design.md:441-453`, `gaia-architect-r1-udp-bridge-design.md:461-467` |
| Never merge on a stale verdict | coordinator step 3 ("counts for nothing"); publisher `HEAD_MISMATCH`, `STATE_CHANGED` | counterexamples the rule closes: `gaia-drain-coordinator-status.md:389` (#85 merged with no verdict at the merged commit), `gaia-drain-coordinator-status.md:161-163` (an R6 verdict carried to an R8 head by a diff argument); the rule as adopted: `gaia-drain-coordinator-status.md:54` |
| A completion marker is evidence that a lane stopped, not approval | coordinator step 3; publisher `MARKER_MISSING` and `VERDICT_MISSING` as two checks | `prompts/gaia-drain-coordinator-claude.txt:14`, `gaia-drain-coordinator-status.md:2357-2358`, `docs/artifact-completion-signals.md:23-38`, `docs/engineering-and-research-principles.md:73` |
| Every PR opens as a draft; `ready` precedes `merge` | coordinator `draft` flag; publisher action order | `gaia-drain-coordinator-status.md:73-77`, `gaia-drain-coordinator-status.md:19`, `gaia-drain-coordinator-status.md:66` |
| The only merge form is squash matched to the head | publisher commands; test gate | `gaia-drain-coordinator-status.md:11`, `gaia-drain-coordinator-status.md:67`, `gaia-drain-coordinator-status.md:77`, `gaia-drain-coordinator-status.md:167-168` |
| B35: reconcile one PR at a time after each merge; derive the README gate counter from the tests directory, never hand-edit it | coordinator step 5 and `reconcile`; publisher stops after one merge | `gaia-drain-coordinator-status.md:362-372`, `gaia-drain-coordinator-status.md:68-69`, `gaia-drain-coordinator-status.md:21`, `gaia-drain-coordinator-status.md:11`, `gaia-drain-coordinator-status.md:169-170`, `gaia-architect-r0-design.md:250-254`, `prompts/pr92-r5-repair-writer-fable.txt:21` |
| Reconciliation class: a published head may be the dual-approved head plus classified reconciliation-only commits; anything else is re-reviewed | coordinator step 3 (`reconciled` flag); publisher `RECONCILIATION_UNCLASSIFIED`; order fields `approvedSha`, `reconciliation`, `reconciliationResults` | `gaia-drain-coordinator-status.md:31`, `gaia-drain-coordinator-status.md:43`, `gaia-drain-coordinator-status.md:45`, `gaia-drain-coordinator-status.md:51` (later record revision, see manifest) |
| A review subject is a detached, clean clone at a named full SHA with `npm ci` done | reviewer preconditions | `gaia-drain-coordinator-status.md:37`, `gaia-drain-coordinator-status.md:126`, `prompts/pr92-r5-spec-review-fable.txt:3-4`, `prompts/pr92-r4-standards-review-fable.txt:3-4`, `gaia-architect-r0-design.md:48-60` (the same refusals proposed for spawn time) |
| Inputs are claims to verify, never conclusions to inherit | reviewer step 2 | `prompts/pr92-r5-spec-review-fable.txt:8`, `pr92-r5-spec-review.md:12-15`, `prompts/pr92-r4-standards-review-fable.txt:1` |
| The review artifact shape: identity, commands, reproducers with `file:line`, controls, residuals apart, one verdict token, marker last, tree byte-identical at start and end | reviewer artifact shape | `pr92-r5-spec-review.md:1-9`, `pr92-r5-spec-review.md:204-215`, `pr92-r5-spec-review.md:226`, `pr92-r5-spec-review.md:243`, `pr92-r5-spec-review.md:302-323`, `pr92-r5-standards-review.md:22-46`, `pr92-r5-standards-review.md:338-352`, `pr92-r5-standards-review.md:363`, `pr92-r5-standards-review.md:381`, `prompts/pr92-r5-spec-review-fable.txt:13-15` |
| Mechanism-revert controls: a gate that passes under the revert binds nothing | reviewer step 4 | `pr94-r1-repair-handoff.md:41-46`, `pr92-r5-standards-review.md:12`, `pr92-r5-standards-review.md:39-46`, `prompts/pr92-r5-repair-writer-fable.txt:20` |
| `mergeable: UNKNOWN` is not conflict evidence | coordinator `unknown` | `docs/pr-conflict-reconciler.md:11-12` |
| PR body edits are file-based and carry the architecture declaration lines | publisher `body` action | `gaia-drain-coordinator-status.md:71`, `gaia-drain-coordinator-status.md:82`, `scripts/architecture-drift.mjs:89-93` |
| An issue is closed after the merge, with a comment naming the merge and the two verdicts | publisher `issue-close` | `gaia-drain-coordinator-status.md:11`, `gaia-drain-coordinator-status.md:164-165` |
| B37: never delete a merged branch | publisher forbids `--delete-branch` | `gaia-drain-coordinator-status.md:13` |
| Artifacts, not messages, are the channel between lanes | all three end with a marker or receipt and send nothing | `gaia-drain-coordinator-status.md:181-182`, `run-lane.ps1:25`, `prompts/pr92-r5-spec-review-fable.txt:17` |
| One merge per publisher invocation; reclassify before the next order | publisher command rules | `gaia-drain-coordinator-status.md:21`, `gaia-drain-coordinator-status.md:68-69` |
| The merge is a human boundary in R0 | publisher `issuedBy: operator`; design C cost | `gaia-drain-coordinator-status.md:73-77`, `gaia-drain-coordinator-status.md:11`, `ARCHITECTURE.md:233-236` |

Two fleet rules are operator notes rather than agent rules, because Claude Code spawns subagents
itself: spawned lanes run in print mode with resume-on-error
(`gaia-drain-coordinator-status.md:176-191`, `gaia-architect-r0-design.md:233-248`,
`run-lane.ps1:12-15`), and a fresh clone must be trusted before a lane is launched in it
(`gaia-drain-coordinator-status.md:242`). Both belong to whoever launches the reviewer on a new
clone.

## Should an Ed25519 grant gate the publisher?

Yes, in R1. The order is text, and `ARCHITECTURE.md:234-236` is explicit that merge rights are
never inferred from agent text, labels, activity, or completion markers. R0 does not contradict
that: the order's only authority content is "the human at the interactive session said go for
this SHA", and everything else the publisher relies on is re-measured from GitHub and from the
two artifacts. The trust is positional (`ARCHITECTURE.md:226-227`), and the harness permission
mode is the second gate the fleet measured.

R0 uses an explicit order instead of a grant for three reasons:

1. There is no merge intent in the kernel to bind a grant to. `docs/github-portfolio-operator.md`
   binds its grant to an intent revision that `advance()` measured from a fresh GitHub read; a
   merge grant needs a `gaia-github-merge-intent/1` with repository, PR, head SHA, base SHA, and
   the digests of the two artifacts, measured the same way. Designing that intent is a kernel
   change with its own Design It Twice, RED gate, and dual review.
2. The grant model deliberately cannot be driven by an agent: the passphrase is read from an
   interactive dialog and never from stdin, argv, or a file
   (`docs/github-portfolio-operator.md:132-133`). A publisher subagent therefore cannot consume a
   grant. In R1 the publisher's shape changes: it verifies and prepares, and the human runs an
   operator command that consumes the grant and merges, leaving a receipt.
3. Building the grant seam without the intent is option (b) of the operator CLI: a signed
   artifact the caller supplies, whose pinned identity can drift from the executed one
   (`docs/github-portfolio-operator.md:34-52`).

What R1 keeps from R0 unchanged: the thirteen refusal codes, the four commands, the matched-head
merge, the one-merge-then-reclassify ordering, and the two artifacts as the only verdict
evidence. What R1 adds: `PREPARE_MERGE_INTENT` as the coordinator's proposal output, a signed
one-use grant consumed through the drain ledger before the merge command, and a receipt reserved
before authority is spent.

## What this slice does not do

- Touches nothing in `src/`, `scripts/`, `.github/`, `package.json`, or `ARCHITECTURE.md`.
- Adds no bus verb; the six verbs are re-asserted by the test gate.
- Wires no agent into the kernel, the control room, the drain ledger, or the operator CLI; no
  file in `src/` or `scripts/` names an agent.
- Replaces neither `run-lane.ps1` nor the fleet directory; the launcher and its artifacts stay
  outside the repository.
- Confers no sandbox: the tool lists bound the harness surface and the prompts bound the shell
  by policy. Enforcement is the permission mode and, in R1, the grant.
- Makes `--match-head-commit` a mechanism. The merge-form gate is a test over prompt prose. The
  mechanism is a `gh` shim on the launcher's PATH that refuses a `pr merge` without the flag or
  with a widening flag; that is a launcher concern
  (`gaia-architect-r1-udp-bridge-design.md:472-474`) and an R1 launcher slice, not this one.

## Test gates

`tests/github-drain-agents.test.mjs` binds: the three files exist and nothing else uses the
prefix; frontmatter parses with `name` equal to the filename, a non-empty `description`, `tools`
equal to the row above and within the declared universe, and the model named above; the
coordinator and reviewer contain no GitHub write command; every merge-command line in the agents
and this document carries `--match-head-commit` and no `--admin`, `--auto`, or
`--delete-branch`; the publisher's `gh` write commands are exactly the four above; the refusal
vocabulary here and in the publisher agree, with `ORDER_DIGEST_MISMATCH` first; the publisher's
`SHA_NOT_BOUND` row, the coordinator's step 3, and the table here bind a verdict to the
artifact's `Subject:` line and `# PR #N` title with no containment wording; the reconciliation
class is named with its three commit classes, its three order fields, and
`RECONCILIATION_UNCLASSIFIED` in both prompts and here; the reviewer requires a full 40-hex SHA,
a detached clean subject, one of two verdict tokens, and a byte-identical tree; the coordinator's classes
and lanes match this document; `BUS_VERBS` is still the six and no `src/` or `scripts/` file
names an agent; every touched file is LF-only; every rule row above cites at least one
`file:line` anchor; and the Design It Twice section names at least three alternatives and one
chosen.

## Evidence manifest

Fleet directory `gaia-wayfinder-plus`, read on 2026-09-03 (outside the repository; not
shipped):

| Artifact | SHA-256 | Note |
| --- | --- | --- |
| `gaia-drain-coordinator-status.md` | `d9106583ef658ecbfd31c177b05696c3906b3375e159f2ab46131e47d6bf628e` | 2988 lines; observation `2026-09-03T23:30:00Z`; prepend-only |
| `gaia-architect-r0-design.md` | `2c642fe9ef2addc44a3b9937c43c133f5f2d03dbb87300de4af03bdd7dfe9894` | sections 1.2, 2.2, 4.1, 4.2 |
| `run-lane.ps1` | `c9a6f5efc6c71737e33d38a4797576180e91003ba54a2ba6cc6d4806dff26c3d` | print-mode launcher, slice W4 |
| `pr92-r5-spec-review.md` | `77d0d2f0a7196013cc0f3c6c69273bd3b20ea8b627bd63050cac5db1f3fd3ab1` | Spec artifact shape |
| `pr92-r5-standards-review.md` | `da3bfa3dca92377a97ced77c8e90b550d04a826f4ec20c1b2ab1e3c2f7f615a7` | Standards artifact shape |
| `pr94-r1-repair-handoff.md` | `bf004e894e7d7a513b95aba7d585ff63859d4051e5c37287b8c845df848defb2` | repair handoff shape, revert harness |
| `prompts/gaia-drain-coordinator-claude.txt` | `14e10c330ef85a378e2c5302dd0dbc20cf9999866cbab8ee84439f269e80eb9f` | coordinator control contract |
| `prompts/pr92-r4-standards-review-fable.txt` | `26d8f4a8847008240fe31267e44c209304d8c4533fbc58886df1b0d20cdfe78d` | the verdict-changing second axis |
| `prompts/pr92-r5-spec-review-fable.txt` | `b77b5b9302dc7075bf1e787014ff0c49c57ce782e58c7537aa28563d2c4135e1` | review prompt shape |
| `prompts/pr92-r5-repair-writer-fable.txt` | `bc133dd1c6b41260daca2b0b1cc57e97726d4b9aef480924d6662c4d96dc4046` | repair prompt shape |
| `gaia-drain-coordinator-status.md` (later revision) | `a957011736391180492d98c652048cc876b3aa290a3bf75288c1078e8091da6d` | 3028 lines; observation `2026-09-04T00:10:00Z`; the reconciliation-class anchors `:31`, `:43`, `:45`, `:51` resolve here, read on 2026-09-04 |
| `gaia-architect-r1-udp-bridge-design.md` | `dbaa6a737674602b565ee549616cb214cf2fca0d434ffea358c2ce1b82c7464d` | sections 5.4 and 6: the order as a file with a digest; the `gh` shim as the merge-form mechanism |
| `pr92-r4-standards-review.md` | `c33577d043670d257e2fbd40e594db2ef33500542cdfa1f7d5a4285bc3faa8c9` | the `REQUEST_CHANGES` at `e98df9e` that containment binding overrode |

Repository files cited are at `ba1034c17c2f4ee40f97822df40a33b903245329` (`origin/main` after the
reconciliation merge; this branch changes none of the cited files except `README.md`).

## Residuals

1. The `model` value is a full model identifier. If the installed Claude Code accepts only the
   alias forms for subagents, the first spawn refuses and `inherit` is the one-line fallback;
   the test gate binds only that a model is named and matches this document.
2. The tool list is not a sandbox (design C cost). The publisher's refusal to type an unordered
   command is policy until R1's grant makes it a mechanism.
3. The coordinator reads verdicts from artifact text with three structural checks (full SHA,
   verdict line, marker). A forged artifact in the fleet directory would pass them; the fleet
   directory is trusted by position, like the local data directory.
4. The record's line anchors drift as it is prepended to. The manifest pins the revision; a
   later reader must resolve the anchors at that digest.
5. The reviewer's `SUBJECT_DIRTY` check uses `--untracked-files=all`, which refuses a subject
   with `node_modules/` unless it is ignored. This repository ignores it; another may not.
6. The publisher re-verifies the reconciliation class structurally from GitHub (commit chain,
   parent count, file sets); the content measurement, the automatic merge tree against the head,
   is the coordinator's, carried in the order. Until R1's merge intent binds it by digest, a
   misclassified reconciliation is caught only by the suite and the gate at `headSha`.
7. The order file's digest binds its bytes, not its author: `issuedBy: operator` stays a
   record, and the receipt reserved before the merge command is the R1 operator command.
