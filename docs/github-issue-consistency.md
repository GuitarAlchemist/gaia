# GitHub issue consistency

One deterministic audit of a repository's issues, and the mechanical repairs for
what it finds. No model is in the loop: Claude, Codex, auggie, agy, a human, and
CI all run the same command and get the same findings, so a finding is evidence
rather than an opinion.

This document is the rulebook. `skills/github-issue-consistency/SKILL.md` and
`AGENTS.md` point here rather than restating it — a tool that detects drift
between two copies of a convention should not keep three copies of its own.

## Run it

```bash
npm run issues:audit                    # this repository, text report
node scripts/issue-consistency.mjs audit  --repository OWNER/NAME --policy .github/issue-policy.json
node scripts/issue-consistency.mjs audit  --repository OWNER/NAME --format json
node scripts/issue-consistency.mjs repair --repository OWNER/NAME            # dry run
node scripts/issue-consistency.mjs repair --repository OWNER/NAME --apply    # writes
```

`--input FILE` audits a saved `gh issue list --json …` snapshot instead of
calling GitHub, for CI or for a tool with no `gh` credentials.

Exit codes follow the Gaia convention: `0` clean · `1` findings at or above
`--fail-on` (default `blocks`) · `2` usage · `3` fail-closed, nothing audited and
nothing written.

## The guardrail

**A parent link is never converted into a blocking dependency.** In
`classifyIssue()`, any non-empty `dependencies` array produces
`BLOCKED_DEPENDENCY`. `Depends-On` and `Blocked-By` both land there. So promoting
`Parent: #40` to `Depends-On: #40` would mark every child of every epic as
blocked — it would stop admission rather than repair it, and it would do so
silently across dozens of issues at once.

The tool therefore splits prose relationships in two:

| Prose | Rule | Severity | Auto-repair |
|---|---|---|---|
| `Depends on:`, `Blocked by:`, `Duplicate of:` | `prose-relationship` | blocks | yes — the exact trailer |
| `Parent:`, `Part of:`, `Epic:`, `Child of:` | `undeclared-hierarchy` | drift | **never** |

Hierarchy findings carry no `proposal`, so `planRepairs` cannot emit one and
`--apply` has nothing to write. The guardrail is enforced by absence, not by a
check that could be skipped. Recording containment properly needs a
non-blocking relationship the read adapter does not yet have; that is a decision
for a human, and it is the follow-up this rule exists to surface.

## Admission, and the second thing the tool will not write

`classifyIssue()` returns `READY` only when the evidence is *known*. Absence is
not knowledge: `dependencies: 'UNKNOWN'` and `duplicateOf: 'UNKNOWN'` both mean
"nobody said", and either one sends a `ready-for-agent` issue to
`READY_WITH_UNKNOWN` instead. The author asserts the absence explicitly:

```
Depends-On: NONE
Duplicate-Of: NONE
```

`unreachable-ready` reports every issue that asks for admission without them,
and prints the exact lines that would fix it — as a `suggestion`, marked `?`,
never a `proposal`. `planRepairs` reads proposals only, so `repair --apply`
cannot write these. Asserting "this issue has no blocking dependency" is a claim
about the world that no parser can check against the text, and a tool that makes
that claim for an author is guessing. When the issue states a blocker in prose,
the suggestion is withheld entirely and the finding says so.

That is the same shape as the `Parent:` guardrail: the tool reports what it
knows and declines what it would have to invent.

## Rules

Severity answers *what does this cost*, not *how loud is it*.

- **blocks** — a machine that reads issues sees the wrong thing.
- **drift** — humans and machines disagree, or a signal stopped carrying information.
- **hygiene** — only readers and history queries are affected.

| Rule | Severity | Fires when |
|---|---|---|
| `unreachable-ready` | blocks | labelled ready-for-agent but evidence is UNKNOWN, so it can only reach READY_WITH_UNKNOWN |
| `malformed-relationship` | blocks | the relationship block does not parse — the pump would fail reading it |
| `prose-relationship` | blocks | a blocking relationship is stated in prose the parser cannot read |
| `unresolved-reference` | blocks | `#N` names neither an issue nor a pull request |
| `contradictory-status` | blocks | mutually exclusive status labels are both applied |
| `undeclared-hierarchy` | drift | containment stated in prose, with no non-blocking relationship to record it |
| `undeclared-reference` | drift | `#N` mentioned with no relationship trailer at all |
| `invisible-status` | drift | status expressed only by labels no code branches on |
| `satisfied-dependency` | drift | a declared dependency points at a closed issue |
| `unknown-label` | drift | a label outside the policy vocabulary |
| `missing-completion-criteria` | drift | no heading states when the issue is done |
| `stale-grooming` | drift | the body was edited more than a day after its grooming stamp |
| `incomplete-grooming` / `malformed-grooming` | drift | the machine block lost a field or a marker |
| `degenerate-signal` | drift | a label or priority covers ≥ 85% of open issues and no longer discriminates |
| `noncanonical-completion-heading` | hygiene | the completion criterion uses a known alias |
| `type-label-mismatch` | hygiene | title type and type label disagree |
| `stale-workflow-label` | hygiene | a closed issue keeps an active workflow label |
| `unconventional-title` | hygiene | no `type:` prefix, or an unknown type |
| `missing-section` | hygiene | a required heading is absent |
| `oversized-body` | hygiene | the issue is a program, not a slice |
| `unlabelled` / `ungroomed` | hygiene | an open issue carries no labels, or no grooming block |

## What `repair` will and will not do

Repairs are additive and reversible. It will append trailer lines above the
grooming block, add a missing type label, and remove a workflow label from a
closed issue. It will never rewrite or delete authored prose, never touch the
grooming block, never convert a hierarchy claim, and never close, reopen, merge
or comment. Dry run is the default; `--apply` is the only way to write.

## Policy is data

`.github/issue-policy.json` overrides `DEFAULT_POLICY` in
`src/issue-consistency.mjs` key by key; omitted keys keep the default. Another
repository adopts this by copying the script and writing its own policy file —
the label vocabulary, title types, completion heading, grooming marker and
degeneracy threshold are all data.

The one thing that is not policy is the relationship grammar: the audit imports
`declaredRelationships` from `src/github-read-adapter.mjs`, the same function the
portfolio pump uses. The linter cannot drift from the contract it lints, because
there is only one copy of it.

## Where it fits

Run `audit` during maintenance, before grooming, and in CI on a schedule.
`--fail-on blocks` is the gate: a blocking finding means the pump is reading
something untrue. `drift` and `hygiene` are for a human or an agent to work
through, and the ranked text report is ordered for exactly that.
