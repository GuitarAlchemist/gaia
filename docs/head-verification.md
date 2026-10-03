# Head verification receipt

Status: normative for `gaia-head-verification/1` (issue #217). Code: `verifyCommittedHead` in
[`src/factory-agent.mjs`](../src/factory-agent.mjs), the seal and verifier in
[`src/head-verification.mjs`](../src/head-verification.mjs), and the CLI
[`scripts/verify-head.mjs`](../scripts/verify-head.mjs).

## The problem it answers

Four actors check that a change passes the tests, and they do not check the same thing:

| | CI (required) | Autonomous factory | Drain reviewer | Author sessions |
|---|---|---|---|---|
| Pinned Node | yes (`setup-node`) | enforced (`VerificationRuntimeMismatch`) | unstated | prose only |
| Result | check status | `gaia-factory-verification/1` record | prose table | prose |

On 2026-10-03, a pull-request body called five failures "pre-existing". They came from running
the suite on Node v24.12.0 against the v26.8.1 pin, and nothing in the sentence let a reader tell.

## What it does

`npm run verify:head -- --base <40-hex> --evidence-dir <new dir> --out <new file> [--worktree <path>]`

1. **Checks the subject before running anything.** The base must be a full lowercase 40-hex commit (`BaseHeadInvalid`). The path must be a Git worktree (`GitWorktreeRequired`) with an empty `git status --porcelain` (`CleanWorktreeRequired`). The base must be an ancestor of HEAD (`BaseNotAncestor`). An existing `--out` is refused (`ReceiptExists`).
2. **Runs the factory's own verification, unmodified.** `verifyCandidate` with `runNodeTestVerification` refuses a Node other than `.node-version` (`VerificationRuntimeMismatch`), then runs `node --test --test-reporter=spec` with the subscription allow-list environment, under bounded time and output. It keeps the output as content-addressed evidence in a newly reserved directory outside the worktree. It refuses a run that changed Git HEAD, the index or the worktree tree (`VerificationMutation`).
3. **Binds the record to bytes.** The candidate identity is the base..HEAD change-set of the clean worktree, measured by `measureAgentFactoryChangeSet`, the recipe the publisher shares. Its status is empty by construction.
4. **Seals and writes the receipt.** It writes the receipt with exclusive creation and prints one summary line.

Exit codes:
- `0`: the run passed;
- `1`: the run did not pass, and its receipt is still written, because a failure is evidence too;
- `2`: a refusal or a usage error, and no receipt is written.

## The receipt

| Field | Value |
|---|---|
| `schema` | `gaia-head-verification/1` |
| `effect`, `authority` | `NONE`, `NONE` |
| `headSha`, `baseSha` | full 40-hex commits; `baseSha` equals `changeSet.baseHead` |
| `changeSet` | the factory change-set; `statusBytes` 0 and `statusSha256` of the empty string |
| `verification` | the unmodified `gaia-factory-verification/1` record; `candidateIdentity` equals `changeSet.identity` |
| `revision` | sha256 of the factory contract's canonical JSON of every other field |

`requireHeadVerification` is total. It refuses with `HeadVerificationInvalid` in each of these cases:
- a non-plain object;
- a missing or unknown field;
- another schema;
- a claimed effect or authority;
- a malformed head or base;
- a base apart from its change-set;
- a change-set with worktree status;
- a change-set or record that the factory contract's own `validateAutonomousChangeSet` or `validateAutonomousVerification` refuses;
- a revision mismatch.

The record's `passed` is the factory's: exit 0, readable counts, at least one test, and no failure.

## What it is not

A receipt is evidence of one run, on one machine, at one instant. It is not a check status,
an approval, a merge condition, or a substitute for the independent Spec and Standards
reviews that ENG-08 requires. Nothing in this repository reads it as one.

This slice wires it into none of the following, and each would be a later, separate decision:
- CI;
- required checks;
- the publisher;
- the drain reviewer's definition;
- `CLAUDE.md`.

## Design It Twice

- **Selected: a sibling envelope** around the unmodified factory record. The factory contract and the receipts it already persisted do not change. The inner record passes the factory's own validators. A rollback deletes one module, one CLI, one test file and one npm script, and removes the two re-exports.
- **Rejected: widening the record to `gaia-factory-verification/2` with `headSha`.** It would change a contract that autonomous receipts already persist, and every verifier of it, to serve a new consumer.
- **Rejected: a runtime-checking wrapper with no receipt.** It fixes the runtime and leaves the result in prose, so a reviewer or a publisher still cannot bind "tests passed" to a head.

## Known limits

- `gitControlState` runs `git write-tree`, which adds a tree object to the repository's object database. That object is unreferenced and harmless, and the factory makes the same write.
- A refusal from the runtime check happens after the evidence directory is reserved, so that directory is left empty. No receipt is written.
- `headSha` is what HEAD was when the run started. The receipt proves the bytes of the base..HEAD change-set, not that the commit is still the tip of any branch. A consumer re-measures before relying on it.
- The run executes the repository's own tests as the host user, as `node --test` always does. The factory's mutation checks detect changes to the worktree and to Git state, not effects elsewhere on the machine.

## Falsifiers

`tests/head-verification.test.mjs` holds 11 tests. Removing any of the following makes at least one of them fail:
- the pin check;
- the clean-tree, base or ancestor checks;
- the revision equality;
- either factory validator;
- the clean-head rule;
- the effect and authority check;
- the head format check;
- the CLI's receipt guards;
- its PASS and FAIL wording;
- its exit code for a failing run.

Each of those removals was run once as a mutant, and each was killed.
