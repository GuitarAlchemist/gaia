# Scoped manual Draft intake

Status: the input adapter is implemented and tested locally; no live canary has
been dispatched, and no canary run receipt or pump-created Draft URL exists yet.

The operator approved one Draft-creation canary, not permanent admission. The
previous manual workflow could not pass an issue selector, although the CLI and
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

## Implementation

`workflow_dispatch` takes one more optional string input, `target_issue`. It is
read only through the environment, as `GAIA_TARGET_ISSUE`, by the existing
"Require the dedicated pump identity" step — the first step in the job, which runs
before the App token is minted, before the sealed revision is checked out and
before any step reads or writes the ledger. That step:

- refuses anything but one positive issue number inside the JavaScript safe
  integer range, so whitespace, signs, decimals, hex, leading zeros, `0`, and a
  newline that would forge a second `GITHUB_OUTPUT` line are all rejected;
- refuses a selector on anything but a manual normal-policy run: the canary
  pins its own issue through the sealed policy, preparation names its issue
  through `prepare_issue`, and the vars-gated scheduled and labeled paths are
  not manual runs;
- publishes the validated value, and only a validated value, as the step output
  `target_issue`.

The intake step then binds `GAIA_ISSUE_NUMBER` to
`steps.identity.outputs.target_issue || github.event.issue.number`. An empty
selection falls through to the labeled-issue lane. Existing tests cover
preservation of untargeted dispatch, `schedule`, `issues: labeled`, prepare-only
and canary behavior. Nothing is interpolated into a shell command; the CLI reads
`$env:GAIA_ISSUE_NUMBER` exactly as it already did for a labeled issue.

Downstream the value is a candidate, not an authority: `runHostedDraftIntake`
filters unsettled operations to the selected issue, so a targeted run neither
reconciles nor enqueues a foreign operation, and still counts that foreign
operation as unsettled rather than reporting the repository healthy.

Residual: a targeted manual run is recorded in the receipt with
`trigger: ISSUES_LABELED`, because the CLI infers the trigger from the presence of
an issue number. That is a naming inaccuracy in an existing domain field, not a
behavior change, and repairing it is a separate slice.
