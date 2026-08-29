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

The tests exercise the pure publication controller with fake effects and one real
temporary Git worktree with a fake GitHub process seam. They prove exact ordering,
authority refusal before mutation, provider-error redaction, deterministic identity,
leased branch creation, and the absence of merge capability.
