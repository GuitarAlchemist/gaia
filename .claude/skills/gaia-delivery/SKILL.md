---
name: gaia-delivery
description: Deliver an accepted Gaia change, continue an authorized factory candidate, or turn a delivery incident into a bounded repair with revision-bound verification.
---

# Gaia delivery

Read [the engineering doctrine](../../../docs/engineering-and-research-principles.md)
and [ARCHITECTURE.md](../../../ARCHITECTURE.md). This skill is process guidance;
runtime capabilities and effect adapters enforce authority.

1. **Recover intent.** Read the issue, linked PR, and prior user authorization.
   Record the origin, affected actor, outcome, scope, non-goals, success criteria,
   and unresolved questions in the existing intent artifact or issue. For the
   current autonomy change, use [INTENT.md](../../../INTENT.md); for separate
   non-trivial changes, use `intent/<slug>/intent.md` linked to their origin. Finish
   when the change and its acceptance criteria are concrete. Continue already
   authorized in-scope work without asking the user to repeat approval. A new
   material scope or one-way door follows the doctrine's explicit authority rule.
2. **Choose the seam.** Inspect existing callers and tests; record the smallest
   end-to-end change, changed files, verification, and compensation path in the
   linked design/plan. Apply ENG-02 when its load-bearing trigger is met. A narrow
   repair can keep this in its issue/PR; separate `spec.md` and `plan.md` files are
   useful only when they hold distinct decisions. Finish when another engineer
   could execute the plan and required design decisions are resolved.
3. **Build with feedback.** Reproduce a bug at the public seam before repair and
   retain the failing evidence. Implement the vertical slice and run its focused
   checks. Add refusal and mechanism-revert controls for invariant-bearing fixes.
   Test changes must preserve the original failure oracle or explain the changed
   requirement for independent review. Finish when the slice passes and its
   regression demonstrably detects the original failure.
4. **Verify independently.** Run the repository checks listed in
   [CLAUDE.md](../../../CLAUDE.md), recording commands and revision. Apply
   [REVIEW.md](../../../REVIEW.md) with the existing independent review protocol.
   Fix demonstrated blockers within scope; ENG-09 decides when repair becomes
   redesign. Finish when applicable checks and required independent reviews bind
   to the exact candidate, with remaining gaps explicit.
5. **Continue to the authorized boundary.** Reconcile actual issue/PR state and
   receipts, then perform the next transition allowed by the existing capability.
   Use the same operation identity for uncertain acknowledgement recovery. Finish
   by reporting the observed stage and evidence, not merely that a process exited.
   For unavailable authority, name the exact missing capability and completed work;
   keep credentials out of prompts and never substitute a skill for a grant.
6. **Close the learning loop.** Link an incident or meaningful measured breach to
   its evidence, add a discriminating regression, and create the next bounded
   intent only if unresolved work remains. Use the source and baseline rules in
   [the SDLC adaptation](../../../docs/ai-native-sdlc.md). Finish when the original
   issue/PR links the evidence and follow-up, without a parallel status ledger.
