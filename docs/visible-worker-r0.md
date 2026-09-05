# Visible restricted execution profile (R0)

## Decision and acceptance boundary

Reuse the factory's `runWorker`, `runReviewer` and `runRepair` ports. Select the
profile explicitly in the operator CLI; do not alter human confirmation, signing,
Draft admission, grant consumption or candidate verification.

Claude runs interactively in the operator's inherited visible terminal, using the
subscription environment, `--restricted`, a closed file-tool set and no MCP or
shell tool. A fresh private temporary result directory and unpredictable attempt
identity bind its JSON response to the current role, task and base/candidate.
The response is untrusted provider output, never approval or an execution grant.

The supervisor stops and awaits its exact child before accepting output. Timeout,
early exit, malformed/mismatched output and unsuccessful cleanup fail closed.
There is no automatic retry. The existing execution ledger owns redelivery;
this adapter does not add another scheduler, claim or GitHub effect.

Public test seams: factory-compatible adapters against a controlled provider
process boundary, and operator CLI profile selection. Test successful completion,
wrong identity, timeout, premature exit, cleanup failure and headless refusal.
Use real temporary files; do not mock factory internals or infer work from time.

The CLI's working-directory confinement was observed on version 2.1.261: an allowed
Read and Write succeeded while an outside-directory Read was refused. This is not
an OS sandbox proof and does not qualify symlinks or arbitrary future CLI versions.
No shell execution is permitted in this profile; test execution remains a separate
supervisor validation step. Candidate review is a fresh independent invocation.

Only a real admitted and authorized operator run can establish canary success.
This wiring and its fixture tests alone cannot establish autonomous draining.
