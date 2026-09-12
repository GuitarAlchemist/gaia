# Scoped manual Draft intake

Status: implementation pending; no live canary has been dispatched.

The operator approved one Draft-creation canary, not permanent admission. The
current manual workflow cannot pass an issue selector, although the CLI and
intake application already support explicit candidates. The old canary policy
targets a completed operation and has expired. Repository-wide normal intake
is not an acceptable substitute while an unrelated operation is quarantined.

## Acceptance criteria

- A manual normal-policy run can select exactly one positive issue number.
- Invalid or incompatible targeting fails before token creation or ledger writes.
- Existing untargeted, labeled, prepare-only and canary behavior is preserved.
- Targeted recovery never calls reconcile or enqueue for a foreign issue.
- No standing repository variable, admission policy or quarantined operation changes.
- A real run receipt and Draft URL are required before claiming canary success.

This slice changes the GitHub Actions input adapter, not the domain admission
authority. Existing identity, policy, ledger and effect reservation gates remain.
