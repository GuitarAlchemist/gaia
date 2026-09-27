---
name: github-issue-consistency
description: Audit a GitHub repository's issues for inconsistencies that make the issue tracker lie to the code that reads it — relationships stated in prose the parser cannot see, status labels no code branches on, signals that stopped discriminating, drifted body schemas — and apply the mechanical repairs. Use when the user asks to check, lint, audit, groom, tidy or fix GitHub issues, asks why the portfolio pump cannot see a dependency, asks whether issues follow a convention, or asks to prepare issues for agent admission.
---

# GitHub issue consistency

A deterministic audit. No model decides anything: the rules are code, the
conventions are a JSON policy file, and any tool — Claude Code, Codex, auggie,
agy, a human, CI — running the same command gets the same findings.

## Do this

```bash
node scripts/issue-consistency.mjs audit --repository OWNER/NAME \
  --policy .github/issue-policy.json
```

Then read the report and act on it in severity order. `--format json` gives the
same report as data. `npm run issues:audit` is the shorthand for this repository.

To fix what is mechanically fixable:

```bash
node scripts/issue-consistency.mjs repair --repository OWNER/NAME            # shows the edits
node scripts/issue-consistency.mjs repair --repository OWNER/NAME --apply    # performs them
```

Dry run is the default. Show the user the dry run and let them decide before
`--apply` — these are writes to their tracker, and the audit is not authority to
perform them.

## The rule you must not talk yourself out of

**Never convert a `Parent:` line into `Depends-On:` or `Blocked-By:`.** Every
non-empty `dependencies` entry makes `classifyIssue()` return
`BLOCKED_DEPENDENCY`. A child of an epic is not waiting on the epic, so promoting
parent links would mark whole trees of issues as blocked and stop admission
instead of repairing it.

The tool already enforces this: hierarchy findings (`undeclared-hierarchy`) carry
no proposal, so `repair` has nothing to apply. If you are editing an issue body
by hand, hold the same line. Recording containment needs a non-blocking
relationship the read adapter does not have yet — that is a design decision for
the user, not a repair.

## The other thing the tool will not write

`READY` requires *known* evidence. `dependencies: 'UNKNOWN'` and
`duplicateOf: 'UNKNOWN'` both mean "nobody said", and either one caps a
`ready-for-agent` issue at `READY_WITH_UNKNOWN`. The author asserts the absence
with two lines — `Depends-On: NONE` and `Duplicate-Of: NONE`.

`unreachable-ready` finds every issue asking for admission without them and
prints those lines as a `suggestion` (marked `?`), never a `proposal`. `repair
--apply` cannot write them, by construction. Do not add them by hand either
unless you have checked the issue really has no blocking dependency — it is an
assertion about the world, not a formatting fix. When the issue names a blocker
in prose, the tool withholds the suggestion and says why.

## Reading the report

Severity is what the inconsistency costs, not how loud it is:

- **blocks** — a machine reading the tracker sees something untrue. Fix first.
- **drift** — humans and machines disagree, or a signal stopped carrying information.
- **hygiene** — only readers and history queries are affected.

A `degenerate-signal` finding names a label or priority that is on nearly every
open issue. Do not "fix" those issues; the finding is about the signal. Either
make it discriminate again or remove it.

## Before you propose changing the rules

The rules live in two places, deliberately:

- `.github/issue-policy.json` — the conventions. Label vocabulary, title types,
  completion heading, grooming schema, thresholds. Change this file, not the code.
- `src/issue-consistency.mjs` — the rule engine, and `declaredRelationships`
  imported from `src/github-read-adapter.mjs`, which is the *same* parser the
  portfolio pump uses. Never copy that regex; import it, or the linter drifts
  from the contract it lints.

## Full rulebook

[`docs/github-issue-consistency.md`](../../docs/github-issue-consistency.md) —
every rule, the exit codes, what `repair` will and will not touch, and how
another repository adopts this with its own policy.
