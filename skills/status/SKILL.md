---
name: status
description: Report where every repository, pull request, run and agent session stands, grouped into what is done, what is in flight, what has not started, and what is blocked on the human. Use when the user asks where things stand, says they have lost track, asks for a status or a recap, asks what is left, or asks what needs them.
allowed-tools: Bash(gh *), Bash(git *), Read, Glob, Grep
---

# Status

A status report is a reading of the **systems of record**, written so the user can
act on it. It is not a summary of what you remember.

The failure it prevents: an agent works across several repositories for hours,
then reports confidently on state it never re-read — crediting itself with a
peer's work, calling a thing finished because it pushed a commit. The user then
decides on a picture that was never true.

## Read before you write

Re-read every claim from its source at report time: the API, the log, the working
tree. A peer's report is a claim, not evidence. A push proves bytes moved, never
that CI passed. A merge proves nothing about whether the artifact works — that is
its own reading.

Run these against **every** repository in play, not only the one you are standing in:

```bash
gh pr list --repo OWNER/NAME --state open   --json number,title,isDraft,mergeable,headRefName
gh pr list --repo OWNER/NAME --state merged --limit 30 --json number,title,mergedAt
gh pr view N --repo OWNER/NAME --json statusCheckRollup   # per open PR: real conclusions
gh run list --repo OWNER/NAME --limit 40 --json name,conclusion,headBranch,createdAt
gh issue list --repo OWNER/NAME --state open --json number,title,labels
gh release view TAG --repo OWNER/NAME --json assets

git -C REPO_PATH fetch --quiet                             # before comparing against origin
git -C REPO_PATH status --short
git -C REPO_PATH rev-list --left-right --count origin/main...HEAD
git worktree list                                          # who else holds a tree
```

**The merged query is not optional.** *Done* is the only bucket with no other
source: an open-PR list cannot contain a PR that merged, so without it the agent
populates *Done* from memory — the exact failure the first paragraph of this skill
forbids, in the one bucket where it is most tempted to credit itself.

**`git -C` is not decoration.** `gh` takes `--repo`; `git status` and `git rev-list`
read the working directory and have no equivalent. Running them once while running
the `gh` lines per repository reports one tree as though it covered all of them, and
uncommitted work elsewhere goes silently missing.

**Fetch before comparing.** `rev-list` reads the local remote-tracking ref, whose
freshness is whenever someone last fetched. Without a fetch it prints `0 0` — which
reads as "in sync" with total confidence — while the remote is a dozen commits ahead.

Read what is still moving too: background tasks you started, and other live agent
sessions. A session that went idle without answering has not answered — record the
silence, so it cannot pass for agreement.

These readings get misread often enough to name:

- **`--left-right` order.** The left number counts commits on `main` missing here.
  Reading it backwards turns "two weeks stale" into "162 ahead" and reverses every
  conclusion drawn from it.
- **Stale green.** A check whose run predates a toolchain, workflow or base change
  is green about a world that no longer exists. Compare run date to change date
  before treating it as signal. Say **stale green** in the report when you see it.
- **A truncated list looks like a complete one.** `--limit N` returns N rows and no
  signal that it truncated. Measured on one repository: `--limit 5` reached back 55
  minutes while 32 runs had started in six hours. Check the oldest row's timestamp
  against when the session began, and raise the limit until it covers it.
- **`mergeable` has three values.** GitHub computes it asynchronously and returns
  `UNKNOWN` until it lands. The field looks boolean and is not; either binary answer
  is a guess, so report `UNKNOWN` as unknown.
- **Zero release assets is not zero shipped.** An npm, crates.io, container or
  registry release carries no GitHub asset. Absent assets means "this release ships
  nothing *here*", which is a finding only when assets were the delivery.

## Done when

Every open PR, every run started this session, every uncommitted working tree, and
every peer session you contacted appears in exactly one bucket. An item you cannot
place goes under *Blocked on the human* with the reason you could not place it.

## The four buckets

Group by what the user can do about it. That is what makes a report actionable.

**Done** — finished and verified. Each line carries evidence of the **outcome**, not
of the attempt: a merged-PR number *with what it changed*, a release URL *with its
assets*, a passing check count, a test total, a measured duration.

**Evidence or it is not done** — an unevidenced line belongs in *In progress*,
whatever you believe about it. And an identifier is not evidence: an open, failing,
draft PR has a number too, so `#136` alone says only that someone opened something.
A merge proves bytes moved; whether the artifact works is a separate reading, and if
you have not taken it, say the merge landed and say the artifact is unverified.

**In progress** — running, and will finish on its own. Say what is being waited on
and what will decide it. If a peer session is the thing being waited on, say it may
never reply.

**Not started / paused** — named, with why. Work that was started but never pushed
belongs here. So does work you chose to stop.

**Blocked on the human** — the section with the most value: nothing here moves
until the user acts. Permission denials, merge gates, decisions that are theirs,
authorizations only they can give. Give the exact command or click.

## Rules that keep it honest

- **Report failures plainly, including your own.** If you broke it, say you broke
  it on the same line that says it is fixed.
- **A green no-op is not progress.** A pipeline that ran and did nothing, a test
  that cannot fail, a skipped check — none are evidence.
- **State what you could not verify.** An explicit "not reached" is worth more than
  a confident guess, and it tells the user where to look next.
- **Name the session that did the work.** Where ownership is contested, report it
  as contested rather than resolving it silently.
- **Separate mechanism from judgement.** "The classifier refuses this" and "I judged
  this unwise" are different facts, and the user must be able to tell them apart.
- **Supersede earlier numbers explicitly.** If a figure you reported was wrong, give
  the corrected one and say it replaces the old.

## Shape

Group by repository, then by bucket. Bullets, one claim each. Bold the noun that
carries the line so it scans. Mark buckets with `✅` / `🔄` / `⏸`.

Close with **one** recommendation and why — not a menu. Where a decision is
genuinely the user's, ask exactly one question. Answer in the user's language.

```markdown
## IX

**Done**
- ✅ **v0.3.1 released with a working artifact** → https://github.com/OWNER/ix/releases/tag/v0.3.1
- ✅ v0.3.0 shipped a file **nobody could load** — I broke it, it is fixed
- ✅ **Nightly CI repaired** — red for 12 days, now pinned

**In progress**
- 🔄 **PRs #283 / #284 / #286** — re-running on the pinned workflow, **no failures**, 4 checks in flight

**Not started**
- ⏸ **Linux / macOS support** — build script fixed locally, workflow unwritten, **nothing pushed**

**Blocked on you**
- ⏸ **`gh pr merge` refused by the auto-mode classifier** — every PR ends up with you
```

## Related

Addressing another session is [`skills/gaia-interagent/SKILL.md`](../gaia-interagent/SKILL.md).
What this repository claims about itself — the surface a report must not contradict —
is `README.md`, and the exit-code and fail-closed conventions a run's outcome must be
read against are documented there.
