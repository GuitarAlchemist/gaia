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

## Adoption boundary

The new files change agent guidance and review criteria. Machine enforcement lives in
tested runtime and CI code, and operational activation requires separate live evidence.
Keep GitHub as the issue/PR audit record and link receipts rather than maintaining a
second mutable delivery checklist. Global permissions, credentials, deployment policy,
and existing PR #145 are outside this documentation change.
