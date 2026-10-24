# Authorized GitHub candidate publication

Gaia's publication seam turns one reviewed, content-addressed candidate into a commit,
an explicitly leased branch push, and a pull request. It does not merge, close issues,
or add a seventh bus verb.

## Boundary

`createGitHubCandidatePublicationAdapter` accepts only:

- one exact `gaia-github-candidate-publish-intent/1` with `effect: NONE` in its new-branch
  form; a Draft-bound intent belongs to the
  [autonomous Draft publication](autonomous-factory.md#decision-the-pump-publishes-its-candidate-to-its-own-draft-eng-02-236)
  and is refused here;
- a separately signed, single-use `PUBLISH_CANDIDATE` grant bound to that intent revision;
- an effect adapter with the closed methods `observe`, `commit`, `push`, and
  `openPullRequest`.

The controller observes repository identity, HEAD, remote base, and the factory
change-set identity before authority is consumed. The Git implementation repeats each
identity check at the mutation boundary where it remains relevant: local HEAD and bytes
before commit, remote base, deterministic branch and both views of origin before push, then
exact branch and commit bindings when reusing or creating a pull request. Any provider
diagnostic is replaced by a typed, redacted Gaia error before it crosses the module boundary.

Short of the programs and the routes below, the host's environment decides neither the repository
the adapter reads, nor the URL the push names, nor the committed bytes (#258). Every Git and `gh`
call runs without the repository locators, so the worktree decides the repository (#224). Every Git
call of the adapter runs with `-c core.hooksPath=`, `-c core.fsmonitor=false` and
`-c core.useReplaceRefs=false`, so neither a hook from a configured hooks directory nor the file
system monitor runs on the publishing side or acts with the push's credentials: without the second
pin, Git 2.45.1 runs an ambient monitor hook once in `git add --all` and once in `git commit`. Both
views of origin, `git remote get-url --all origin` and its `--push` view, must list exactly one URL,
the bound repository's, or the observation refuses `RepositoryIdentityMismatch` before authority is
consumed. The push reads both views again just before `git push`: a program Git ran since the
observation, such as a clean filter in the factory's measurement or in `git add`, may have rewritten
origin, and the push then refuses `RepositoryIdentityMismatch`, as `PushFailed`, before anything is
sent. The push passes `--no-follow-tags`, and every `gh` call names
`--repo github.com/<owner>/<name>`, so `GH_HOST` cannot send it to another server. Replace refs are
off, so the checks below read the real objects rather than their replacements: through a replace
ref, `git cat-file` shows the replacement while the push sends the real object (the R4 Spec review
measured it). The local commit must have the reviewed HEAD as its only parent, read from the raw
commit object, so a `MERGE_HEAD` left for `git commit` cannot carry other history, and it must hold
exactly the reviewed paths as `git diff --name-status` lists them (a gitlink a submodule ignore
setting hides is the first route below), each in its reviewed state and each present file's blob
equal to the measured bytes, or it refuses `PublishedTreeMismatch` before any push. A global
`core.excludesFile`, `core.autocrlf` or clean filter cannot publish bytes nobody reviewed through
the committed paths; a filter that writes grafts or a `.gitmodules` takes the routes below. Neither
can a change to the worktree after the commit step measured the candidate: a new file, a deleted
file that comes back, or a reviewed file that goes; a nested repository is the exception below. The
factory's own measurement runs no configured hook and no monitor (#256), but it runs clean filters:
one can make such a change, which the tree check refuses, or rewrite origin, which the push's second
reading refuses. The hooks pin leaves an empty `core.hooksPath`, and Git then looks for hooks at the
drive root: a hook placed there still runs, and writing there lies inside the trusted OS-user
boundary below.

Two routes still publish objects nobody reviewed with a `completed` receipt; the R5 Spec review of
#266 measured both, and #271 owns them. The tree check reads `git diff --name-status`, which obeys
`diff.ignoreSubmodules` and `submodule.<name>.ignore`: a nested repository that lands after the
measurement is committed as a gitlink nobody reviewed, whether the setting comes from the
environment, the repository's own configuration, or a `.gitmodules` in the worktree when the check
runs: one already on the base, or one the same late writer adds, even ignored by `.gitignore` and
never committed (the R6 Spec review measured it). And `git push` walks history through grafts,
`info/grafts` or `GIT_GRAFT_FILE`, which `core.useReplaceRefs=false` does not turn off: the bound
repository can receive objects the published branch does not reach. The parent check reads the raw
commit and does not see them. File modes are not checked either.

The environment still chooses the programs Git runs to reach the remote and to sign, among them
`GIT_SSH_COMMAND`, `GIT_SSH` and `core.sshCommand` for an SSH origin, `credential.helper` and
`core.askPass` for an HTTPS one, and `gpg.program` when the configuration signs commits. An SSH
command can carry the push to another server while both views of origin name the bound repository.
The review of #258 measured it on Git 2.45.1 with a stand-in `ssh`, through `GIT_SSH_COMMAND` and
through `core.sshCommand` set with `GIT_CONFIG_COUNT`. These settings belong to the OS user the
factory runs as, and the [autonomous factory](autonomous-factory.md) declares a trusted OS-user
boundary, not a sandbox against same-user processes.

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
silently publishing or duplicating work. A commit refused as `PublishedTreeMismatch`, or a
push refused because origin changed, leaves the same state. A durable, content-addressed
publication transition receipt must make that state resumable before unattended operation is safe.

## Verification

The tests exercise the pure publication controller with fake effects and one real temporary Git
worktree with a fake GitHub process seam. They prove exact ordering, authority refusal before
mutation, provider-error redaction, deterministic identity, leased branch creation, and the absence
of merge capability. One more test drives the real Git effects, with a fake `gh`, against a bare
repository named origin, once per host-environment route: each route publishes the reviewed commit
to the bound branch only, or refuses before any push. The candidate changes a file, adds one and
deletes one. Beside the clean route, three routes set nothing in the environment: the test's runner
adds a file, brings the deleted one back, or removes the changed one after the commit step measured
the candidate. One route sets a clean filter that rewrites the push URL of origin when `git add`
runs it, after the observation. Two more set a clean filter that acts on the publishing side only:
one stores other bytes and plants a replace ref from them to the reviewed blob, the other keeps the
bytes and writes `MERGE_HEAD` to a commit that holds a file nobody reviewed.