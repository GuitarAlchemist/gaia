# Intent: autonomous continuation of bounded Gaia factory work

Owner: Gaia repository operator (the requesting user).
Status: implementation requested; runtime verification in progress.
Date: 2026-09-12.

Next artifact: [design, plan, and verification contract](docs/autonomous-factory.md).

Origin: the user's request in Codex task `01a04b30-bd3a-7530-8f4f-185954d433c9`,
2026-09-12. The user asked why every run required manual input, stated that the pump
must be autonomous, accepted implementing a persistent, limited, revocable
authorization, then requested applying the
[Claude Academy SDLC playbook](https://academy.claude.com/courses/ai-native-sdlc-playbook).
Related observed work: [issue #141](https://github.com/GuitarAlchemist/gaia/issues/141)
and [Draft #145](https://github.com/GuitarAlchemist/gaia/pull/145).

Acceptance provenance: the user authorized this implementation in the conversation.
This file records that scope; it is not a separately reviewed design, a signed runtime
grant, or evidence of live activation. Git history records its subsequent revisions.

## Problem and outcome

The operator had to paste an intent revision and unlock a key to run #141 against
Draft #145. The reported run ended `CANDIDATE_READY` after 3m 35s with exit code zero.
This demonstrates completion of that supervised candidate stage, not autonomous
delivery, test success, publication, or merge. Routine eligible factory work should
continue under previously established bounded authority without repeated prompts.

## Scope and constraints

Implement the smallest runtime continuation seam and an agent workflow that retains
accepted intent, immediate machine feedback, independent review, and honest terminal
evidence. Standing authority must be limited and revocable; exact runtime limits and
activation evidence belong to the implementation's authority contract and receipt.
Freshness, verification, acceptance, and authority retain their separate meanings.

This request does not itself authorize unrestricted repository effects, production
deployment, new paid API workloads, removal of branch protection, or treating an
author's review as independent. Existing authorized in-scope work continues without
repeated user confirmation; a material expansion needs its own recorded authority.

## Acceptance criteria

- An eligible operation can reach the bounded candidate stage without per-run human
  text or key prompts after the required standing authority has been provisioned.
- Invalid, revoked, exhausted, or out-of-scope authority refuses before its
  protected effect; uncertain completion reconciles without duplicating work.
- Focused failure tests and independent review bind to the exact changed revision.
- The delivery workflow links intent, implementation, verification, and issue/PR
  evidence while distinguishing local availability from a running live pump.
- Report any unconfigured credential, scheduler, publication adapter, or production
  gate as a remaining integration condition, not as successful autonomous operation.

## Evaluation cases and boundaries

#141/#145 supplies the manual-prompt case. The reported elapsed time is one observation,
not a performance baseline. [Issue #143's reconciliation repair](docs/issue143-append-reconciliation.md)
supplies the lost-acknowledgement case; its deterministic reproduction does not establish
the original live cause. Measure prompts per eligible run, repeat effects, time awaiting
authority, and candidate-to-publication time from linked receipts/PR history. Baselines
are `UNKNOWN` until measured; no numeric improvement or live activation is claimed here.

## Open questions and later stages

The first execution boundary is one configured local host producing a candidate.
Automatic publication, merge, cross-host execution, and production deployment require
their own acceptance criteria and implementation evidence. A candidate does not
resolve those later stages by itself. If the accepted outcome changes, update this
intent in the same reviewed change as the design and implementation.
