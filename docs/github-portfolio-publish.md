# GitHub candidate publication intent R1

## Decision

`buildGitHubCandidatePublishIntent({ transition, gitObservation })` is a pure dry-run seam
between Gaia's independently reviewed local candidate and a future, separately
authorized GitHub effect adapter. It accepts only a content-addressed
`gaia-github-portfolio-transition/1` whose status is exactly `CANDIDATE_READY`.

The module revalidates, in order:

1. the transition revision;
2. the nested factory intent revision and its portfolio snapshot binding;
3. the consumed authority's exact intent binding and derived idempotency key;
4. the complete execution receipt revision, completed status, task, base HEAD, and
   candidate change-set identity;
5. one caller-observed Git data value containing repository identity, local HEAD,
   GitHub base OID, and current change-set identity.

Only then does it return `gaia-github-candidate-publish-intent/1`. The result labels
the candidate `CALLER_OBSERVED_READ_ONLY_DATA`, has `effect: NONE`, and carries a closed
requested-operation list:
`COMMIT_CANDIDATE`, `PUSH_CANDIDATE_BRANCH`, and `OPEN_PULL_REQUEST`. These strings are
descriptive data. They execute nothing and grant no authority.

## Seam and invariants

The module has no Adapter and accepts no callback. `gitObservation` is owned as inert
JSON data and must contain exactly `repository`, `headOid`, `baseOid`, and
`changeSetIdentity`. A composition root may obtain those fields through a read-only Git
Adapter before calling the builder, but that observation remains a caller claim rather
than something this pure module independently measured.

- The observed repository must equal the factory intent repository.
- Both observed OIDs must still equal the execution receipt's base HEAD. A moved local
  HEAD or moved GitHub base is `CandidateStale`, not an optimistic publish request.
- The observed change-set identity must equal the independently reviewed identity.
- The factory change-set identity is independently recomputed using the exact shipped
  factory recipe: SHA-256 of its fixed-order JSON body followed by one LF.
- The authoritative receipt reviewer must have the exact factory shape, an `APPROVE`
  verdict, its read-only authority and postcondition, and content-addressed evidence whose
  role, path, size, digest, media type, and policy are all bound. After a repair, the exact
  repair record must bind distinct initial and repaired identities, the repaired identity
  must equal the verified current change set, `reviews.initial` must be the factory's
  `reviewer-initial` `REQUEST_CHANGES`, and `reviews.final` must exactly equal the
  authoritative `reviewer-final`.
- Rejected, failed, malformed, accessor-bearing, tampered, mismatched, or stale inputs
  fail with typed `GitHubCandidatePublishError` codes before any output is returned.
- Top-level, nested, and revoked Proxy values are rejected through Node's non-trapping
  Proxy classifier before any prototype, descriptor, or own-key reflection.
- JSON object key order does not affect any revision.
- The returned object and every nested value are frozen.
- The module imports no filesystem, process, child-process, network, credential, Git
  mutation, or GitHub effect capability. It cannot commit, push, open a pull request,
  merge, comment, close, install, or change configuration.
- No Gaia bus verb is added or widened.

## Why this slice stops here

Putting `git push` or `gh pr create` behind a boolean flag would make a dry-run module
carry latent authority. A generic effect plan would also let callers smuggle arbitrary
operations through an apparently safe output. R1 instead emits one closed, deterministic
description. A later slice must consume it through a separately reviewed, explicitly
authorized effect seam and must independently remeasure repository, HEAD, base and
change-set freshness again immediately before mutation. This R1 intent is advisory and
is not evidence that its caller supplied a recent observation.
