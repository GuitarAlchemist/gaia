# AI-native SDLC adaptation for Gaia

This is a scoped adaptation of Anthropic's
[AI-Native SDLC Playbook](https://academy.claude.com/courses/ai-native-sdlc-playbook),
read on 2026-09-12, for the [accepted user request](../INTENT.md).
It is an implementation map, not evidence that every course capability is installed.
The [engineering doctrine](engineering-and-research-principles.md) remains normative;
[ARCHITECTURE.md](../ARCHITECTURE.md) owns runtime boundaries.

## Plays mapped to mechanisms

| Course play | Gaia adaptation and current boundary |
| --- | --- |
| [Capture intent](https://academy.claude.com/courses/ai-native-sdlc-playbook/capture-intent) | Adopted: a versioned intent records the originating user's actual scope and acceptance provenance. GitHub remains the work/disposition record; the intent links to it or the originating request. |
| [Requirements and design](https://academy.claude.com/courses/ai-native-sdlc-playbook/requirements-and-design) | Existing ENG-01/02/07 own framing, alternatives, and reversibility. The delivery skill makes required decisions reviewable without duplicating them into compulsory new files. |
| [Plan mode](https://academy.claude.com/courses/ai-native-sdlc-playbook/plan-mode) | Adopted: inspect and specify the seam before implementation. Prior user authorization persists for in-scope continuation; this does not change an application's mode settings or create runtime authority. |
| [CLAUDE.md](https://academy.claude.com/courses/ai-native-sdlc-playbook/claude-md) | Adopted: a short root entry point routes to canonical architecture, doctrine, commands, and review. |
| [Skills](https://academy.claude.com/courses/ai-native-sdlc-playbook/skills-as-institutional-knowledge) | Adopted: repository-local `gaia-delivery` encodes recurring delivery work. It is advisory; its trigger quality still needs observed session evaluation. |
| [Parallel work](https://academy.claude.com/courses/ai-native-sdlc-playbook/parallel-sessions-and-subagents) | Existing drain agent definitions separate coordinator, reviewer, and publisher. Keep bounded ownership and independent review; this adaptation creates no automatic fanout. |
| [Feedback loop](https://academy.claude.com/courses/ai-native-sdlc-playbook/give-claude-a-feedback-loop) | Existing `node:test`, verification, and architecture checks supply deterministic feedback. Adopted: keep the failing oracle and check during implementation; review any change that weakens it. No test-file lock hook is installed here. |
| [Continuous evals](https://academy.claude.com/courses/ai-native-sdlc-playbook/continuous-evals-in-ci) | Existing CI runs deterministic tests. These are not model/prompt evaluations. Paid model eval runs and a representative task corpus are not implemented by this adaptation. |
| [PR review](https://academy.claude.com/courses/ai-native-sdlc-playbook/ai-in-the-pr-review-loop) | Adopted `REVIEW.md`: Bugs, Security, and Spec criteria map onto existing independent Standards/Spec axes. Managed Claude Code Review and `@claude` repair integration are not installed here. |
| [Approval gates](https://academy.claude.com/courses/ai-native-sdlc-playbook/hooks-as-approval-gates) | Runtime effect preflight remains the enforcement seam. The separate autonomous-continuation implementation supplies its own authority contract. This documentation installs no hooks or managed settings. |
| [CI/CD](https://academy.claude.com/courses/ai-native-sdlc-playbook/ci-cd-integration-and-deployment) | Existing hosted intake/pump workflows and factory adapters cover distinct stages. Their presence does not prove autonomous publication, deployment, or rehearsed rollback; this adaptation activates none of those. |
| [Metrics loop](https://academy.claude.com/courses/ai-native-sdlc-playbook/closing-the-loop-on-metrics) | Adopted incident-to-regression-to-intent procedure below. Continuous sampling, statistical bands, and automatic diagnosis triggers are not implemented here. |

The course retains owner decisions at material gates. Gaia applies its risk-based
approach to previously accepted scope: routine permitted work continues automatically,
while a changed authority boundary follows ENG-02/04/07 and the actual effect policy.
No human prompt is added merely to acknowledge a step whose work is already authorized.

## Artifact chain decision

The user also referenced [the video on INTENT.MD](https://www.youtube.com/watch?v=LoMOPj-lO8U).
Its transcript describes handing versioned artifacts to fresh agent contexts. This
supports artifact-to-artifact handoff, not a new database or a Markdown execution grant.
Gaia already names Artifact Revisions and required/advisory/reference edges in its doctrine.

```text
INTENT.md -> docs/autonomous-factory.md -> code + test evidence
          -> independent review of the same commit -> PR / publication receipt
```

Each handoff names its predecessor's commit or content digest, producer and evidence.
When a required predecessor changes, revalidate dependents and retain old receipts as
history. An old candidate's passing test does not validate new code. Hypothesis: this
reduces repeated explanation and stale approvals. Falsifier: a fresh reviewer cannot
recover scope from these artifacts, or an old review is reused after required inputs
change. Measure that before adding a graph engine. Reuse Git and existing receipts.

[The artifact chain](artifact-chain.md) now implements the machine-checkable part of that handoff:
a digest-pinned manifest over the real files, a pure validator that reports a changed required
predecessor as invalidating its dependents transitively, and a candidate-stage sidecar emitted by
the autonomous host. It adds no graph engine and no store. Automatic Markdown-triggered
transitions remain unimplemented, a fresh chain still proves nothing about the claims inside its
artifacts, and the hypothesis above remains unmeasured.

## Measurable learning loop

For each observation, retain source reference, operation/issue identity, full code
revision, timestamp, units, sample count, and collection window. Baseline and threshold
are `UNKNOWN` until the named source has been measured and a threshold justified.
Missing data never becomes zero or a favorable score.

| Metric | Source and calculation | Baseline |
| --- | --- | --- |
| Human input per eligible run | Operator transcript plus authority receipt: count actual confirmation/key prompts for each eligible operation; report blocked runs separately. | `UNKNOWN` |
| Authority wait | Timestamped prompt/decision events for the same operation; absent timestamps mean unmeasurable, not immediate. | `UNKNOWN` |
| Candidate-to-publication time | Candidate receipt and matching PR head publication event, in seconds; unmatched candidates remain pending/censored. | `UNKNOWN` |
| Review rework | PR history and full-SHA review artifacts: repair rounds caused by Important findings per reviewed change. | `UNKNOWN` |
| Repeat incident / duplicate effect | Linked incident evidence plus effect receipts and authoritative readback, grouped by stable operation identity and failure family. | `UNKNOWN` |

On a demonstrated incident: retain the original evidence in its issue, reproduce the
failed public seam, add a regression with a mechanism-revert control, repair within
accepted scope, and obtain exact-revision independent review. If unresolved work
remains, link a new bounded intent with outcome, owner, limits, and falsifier. Repeated
invariant failures use ENG-09's breaker. A metric alert alone is diagnosis input, not
authority to deploy or widen scope.

Two real cases anchor the first evaluation set:

- **#141 / Draft #145:** the user's transcript reports a manually authorized
  `CANDIDATE_READY` after 3m 35s. This is an autonomy gap observation, not an end-to-end
  delivery benchmark. A future live acceptance run must link standing-authority
  provisioning, zero per-run prompts, the candidate receipt, and each subsequent
  independently verified stage it actually reaches.
- **#143:** [the append reconciliation report](issue143-append-reconciliation.md)
  records deterministic recovery when readback finds the exact commit after a lost
  acknowledgement, with foreign winners and unreadable state still refusing. Reuse
  those adapter regression cases; the original live transport cause remains unproven.

## Selective SlashForge adoption

Origin: the user requested adopting the useful parts of SlashForge in Codex task
`01a04b30-bd3a-7530-8f4f-185954d433c9` on 2026-09-13, after a read-only comparison.
This is a documentation-only adaptation, not installation of SlashForge or a new
runtime mechanism. The existing delivery skill and review policy remain the entry points.

Sources inspected at upstream commit `1fe67b59bc7e4629b2ed9e4d53d5becbb4815b56`:
[instruction coverage](https://github.com/rajdeepratan/SlashForge/blob/1fe67b59bc7e4629b2ed9e4d53d5becbb4815b56/templates/forge-coverage.md),
[investigation handoff](https://github.com/rajdeepratan/SlashForge/blob/1fe67b59bc7e4629b2ed9e4d53d5becbb4815b56/templates/forge-workflow-investigation.md), and
[review coverage](https://github.com/rajdeepratan/SlashForge/blob/1fe67b59bc7e4629b2ed9e4d53d5becbb4815b56/templates/forge-workflow-review-pr.md).
The procedures below are original Gaia wording inspired by those sources; no upstream
templates, scripts, or package files are vendored.

### Instruction coverage check

At planning and final-diff review, inspect newly introduced dependencies, source
languages, top-level modules, and recurring workflows. Compare each with the actual
instructions reached through `CLAUDE.md`, architecture references, and relevant
repository-local rules, skills, and agent definitions. Read their content: a matching
filename is not proof of coverage, and absence of a specialist agent is not a defect.

Record a gap only when it names the changed path, the missing or contradictory
instruction, and a concrete task an agent could mishandle. Put the observation and
its disposition in the existing plan or review artifact: covered, update within
accepted scope, defer with reason, or unknown because a source could not be read.
An unread source is not an empty instruction set. If there is no applicable change,
record not applicable once; ordinary edits need no new coverage document.

Prefer correcting the existing canonical instruction over adding an agent, hook,
skill, or mirrored rule. This advisory check creates no extra human gate, automatic
configuration write, or permission to expand scope. A demonstrated invariant violation
still follows the existing review policy; calling it a coverage note cannot waive it.
Finish when each applicable change has an evidence-linked disposition.

### Visible investigation report

For an investigation or diagnostic handoff, retain one readable report at the existing
issue-linked evidence path. If none exists, use `docs/investigations/<issue-or-slug>.md`
and link it from the issue/PR when publication is authorized. Show its actual path in
chat and open it in the available file/browser panel when supported; if opening fails,
state that and retain the link. A Markdown preview is sufficient; no HTML generator,
hidden `.claude/` report directory, or second status ledger is required.

The report contains the observed outcome (confirmed, not reproduced, intended behavior,
or insufficient evidence), expected versus actual behavior, exact reproduction attempts,
root cause or explicitly labelled hypothesis, affected scope, and proposed next step.
Bind observations to the code revision, environment, commands/results, producer, and
raw evidence paths/digests. Redact secrets before making reports visible. Preserve
earlier evidence; a correction identifies what it supersedes.

Pass the report path and revision or digest to the next session, which checks freshness
and separates observations from proposals before acting under its existing authority.
A report grants no repair permission. It is supporting evidence, not a new stage in the
five-stage artifact chain; it cannot fill missing tests, review, or publication evidence.
Finish when the report is accessible and the next actor can identify what is known,
what remains uncertain, and which action is actually authorized.

### Limits and evaluation

[REVIEW.md](../REVIEW.md#review-coverage) owns explicit review coverage and duplicate-feedback
handling; the drain reviewer consumes it. Independent review stays mandatory under
ENG-08, including small changes. Reuse existing verification commands and revision-bound
evidence rather than adding a second verification workflow.

Do not adopt SlashForge's repeated plan/branch/PR/cleanup prompts, quick-mode self-review
substitution, global setup, or Graphify dependency. A graph could aid exploration, but
its freshness heuristic is not Gaia's exact-revision evidence check. Existing runtime
capabilities, branch protection, and authority boundaries remain unchanged.

Assumption: these small additions help fresh sessions recover scope and expose stale
instructions. The strongest counterargument is process duplication and noisy coverage
notes; keeping the current workflow unchanged is the simpler alternative. For the next
three eligible changes, record useful gaps, false alarms, and handoff re-explanation in
their existing review artifacts. The baseline and benefit are unmeasured, not zero.
Keep the check only if it finds actionable gaps without new routine approval prompts;
narrow or remove it if all findings duplicate existing checks. Rollback is removing
these guidance additions, retaining historical evidence. No machine detector, report
renderer, measured token saving, or unattended-delivery improvement is claimed here.

## Adoption boundary

The new files change agent guidance and review criteria. Machine enforcement lives in
tested runtime and CI code, and operational activation requires separate live evidence.
Keep GitHub as the issue/PR audit record and link receipts rather than maintaining a
second mutable delivery checklist. Global permissions, credentials, deployment policy,
and existing PR #145 are outside this documentation change.
