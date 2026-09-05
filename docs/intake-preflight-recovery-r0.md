# Intake preflight recovery R0

## Outcome and observed failure

Reject an invalid managed Draft configuration before constructing a runtime or writing
an admission intent. Preserve reconciliation of genuinely ambiguous GitHub effects.

Run https://github.com/GuitarAlchemist/gaia/actions/runs/33972187241 attempt 2
admitted issue #53 but emitted `EFFECT_AMBIGUOUS`, revision
`09eedd7694c60666aad8f9621b9d1340f0f37df7fccfcc3e226034ea64c59825`.
No PR was observed on `codex/issue53-observation-intake-r0` after that run.
The configured claim contained only its schema; the OPEN receipt contained only
schema and kind. Two isolated replays of the actual provider returned
`InvalidEffectClaim` before any provider invocation. The current configuration is
invalid independently of any GitHub availability assumption.

## Bounded change

- Reuse domain validators for the complete OPEN receipt and effect claim at CLI intake
  preflight; do not duplicate their schema in a workflow or CLI.
- Reject malformed configuration before runtime construction. A rejection produces a
  closed, redacted error and a nonzero exit, not a successful ambiguous admission.
- Honor the existing 64 KiB bound for the managed JSON through argument extraction.
  The generic 512-character argument limit rejected complete receipts before parsing;
  incomplete placeholder fixtures had hidden this second defect.
- Test the public CLI boundary, including valid input and malformed claim/receipt cases.
- Do not change the six bus verbs, credentials, effect authority, ledger transition
  table, or safety rules for an effect whose outcome is genuinely unknown.

## Remaining recovery boundary

This rejects schema-malformed configuration only; it does not erase or settle the existing
#53 operation. A well-formed receipt bound to another head can still throw
`StaleCommandGeneration` during execution and become `EFFECT_AMBIGUOUS`. Per-operation
head binding before effect intent remains unresolved. A static shared variable is not a valid source of generation-specific
ownership and fresh effect leases. Full recovery requires a real per-operation receipt
and an audited reconciliation of the existing ambiguity. An absent PR alone does not
prove that an earlier remote request cannot still finish. No blind retry is authorized
by this design, and no autonomy claim follows from a passing preflight test.

Operator input remains single-line minified JSON: the existing argument parser rejects
control characters, including literal newlines. The 64 KiB limit does not change that rule.

Owner: Codex coordinator. Independent review: Standards and Spec on the exact commit.
Next proof: CLI regression goes RED, then GREEN without any ledger or GitHub writes.
