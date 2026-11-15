# PR #276: exact repository and numeric binding

Review baseline: 4b1b24e79267f729befda848c1ea1d5a05c38523. The two automated
comments are hypotheses until reproduced at the public proposal/verification
interfaces. The repository mismatch regression fails on this baseline.

Two repository bindings were considered before repair: bind policy to the issue's
repository, or to the qualification context. Select the context: cross-repository
research is valid, but it must use the policy of its explicit execution context.
Accept only the canonical repo:owner/name reference form and compare GitHub
repository names case-insensitively. Missing or different identity refuses; no
repository discovery, authority inference or issue decision occurs.

For signed zero, changing shared canonicalJson would change unrelated receipt
formats. Instead select a narrower accepted numeric domain: reject -0 in action
parameters, counters and qualification priority, while preserving ordinary zero.
Verification must also distinguish a receipt tampered from 0 to -0; exact deep
comparison supplements the unchanged digest check. No global serializer changes.

These are corrections to the existing exact-input contract, not new effects or
execution authority. Regression tests must fail before their respective repairs;
valid research fixtures and all human gates remain intact. Existing design
receipts remain historical inputs and are not rewritten to claim new approval.
Rollback is reversal of this local correction; it would reopen the documented
binding failures. No live state, grant, worker or policy is modified.
