# Normal admission live qualification — issue 127

Status: prepared, not yet proven. Related: #40, #125, #126, #127.

## Bounded operator intent

On September 7 the user authorized activation and a real test after PR126 merged.
The coordinator prepares this evidence branch and the fresh normal policy. These
are supervised preparations, not pump-produced code or proof of autonomy.

The policy is repository-scoped, CREATE_DRAFT only, with one round per operation.
Its one-hour window is 12:10–1:10 PM Toronto EDT / 16:10–17:10 UTC on September 7.
Reviewer identities name assigned agent lanes, not completed approvals.
It is not a copy of the consumed issue122 canary grant. No identity, credential,
agent-execution or merge permissions are broadened.

## Attempt and stopping conditions

1. Validate the policy with the real parser and independently review this branch.
2. Keep `GAIA_NORMAL_POLICY_ENABLED` unset. Dispatch the existing sealed intake
   workflow on this branch once with `normal_policy=true`.
3. The normal workflow selects from the queue; its policy does not pin an issue.
   Issue127 is the intended new candidate. Existing terminal work is not reset.
   If another operation is selected, report that exact result and stop rather
   than claiming issue127 succeeded or dispatching another attempt blindly.
4. Expect the pump, not the coordinator, to create one Draft and persist its
   terminal operation receipt. Read back the exact marker, SHA, App author,
   PR identity, run identity and ledger revision.
5. On failure or ambiguity, preserve evidence and stop for reconciliation.
   Do not re-run creation or renew the policy automatically.

The concurrency fence is the existing durable per-work CAS and EFFECT_STARTED
record. The live Actions attempt binds the executor epoch; stale losers must
perform no new effect. The operation marker is the reconciliation identity.
The workflow recovery group remains non-cancelling and serialized. No changes
to these mechanisms are made by this qualification.

## Result

Not run yet. CI/parser success is not live admission proof. A Draft alone is not
worker execution, merge, issue closure or unattended end-to-end operation.
After the run, add actual receipt URLs and observed timestamps here. The policy
expires without automatic renewal; scheduled enablement remains off.
