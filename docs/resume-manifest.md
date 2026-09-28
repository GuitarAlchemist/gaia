# Resume-prompt check (W1) — refusing a lane prompt that disagrees with the tree or the artifact set

Status: shipped check, observation adapter and CLI for issue #104. It launches and resumes
nothing, grants no authority, and approves nothing. It is the single resume entrypoint; no runner
in this repository calls it yet (see [Entrypoint](#entrypoint)).

## Operator problem

Three of three resume defects the fleet recorded were disagreements between what a prompt said
and what the world was. None was a context-budget failure (Architect R0, sections 1.1 and 1.2;
the drain adversary's round 49; the coordinator's record of the same day).

| Defect | What the prompt said | What the world was | Cost |
| --- | --- | --- | --- |
| Y1 | subject `…\gaia-pr92-r3-review-7da3004`, commit `e98df9e15bc32b95f25ddb3` (abbreviated) | that worktree was at `7da3004`; the live head `e98df9e` was in another worktree | a verdict on `7da3004` would have been labelled `e98df9e` |
| Y2 | CI base pinned at `a94b5774` | `origin/main` had been `e697021` since #85 merged | a reviewer would pin a base one merge stale |
| B16/B19 | cited the R0 Standards review and told the lane not to wait for Spec | the R0 Spec review also returned `REQUEST_CHANGES` on the same head `1df8d87` | one repair round and one dual-review round lost |

The coordinator's post-check that missed Y1 counted the live commit once and read that as
success. Issue #104 first proposed the count-of-two rule it wished it had run
(`SubjectNamedTwice`); grooming corrected it: naming a subject twice is not an integrity
mechanism. A prompt that names the wrong subject twice passes a count; a correct prompt that
names its subject once fails it.

## Design It Twice

**A — record-drift manifest (the first candidate, PR #158).** Seal the prompt digest, one
observed tree (`head`, an opaque workspace identity) and an artifact set when a lane suspends;
refuse the resume when a later observation differs. Small and pure. But it compares a record
with a later observation of itself and never compares what the prompt *declares* with the world.
A manifest sealed when Y1's prompt was written records the R3 worktree faithfully and then agrees
with it; Y2 has no base to compare; B16/B19's omission is in the prompt's citations, which the
manifest never reads. It could express none of the three observed defects, and its workspace
identity had no collector.

**B — declared-binding check (selected).** The manifest is the structured declaration the prompt
is written against: subject worktree, subject generation (the full commit), an optional base pin,
and the upstream artifacts that may block it. One fresh observation of the world is compared with
the declaration, and the prompt text must carry each declared binding, because the lane acts on
the text. Confidence comes from comparing the declared generation with the observed `HEAD`, never
from repetition.

Also rejected: parsing the declaration out of free-text prompt headers. The recorded prompts
spell it three ways ("Immutable subject:", "Exclusive worktree:", "in `<path>`"), so a parser is
a heuristic with false negatives of its own. The declaration is given as structured values.

## Contract

[`src/resume-manifest.mjs`](../src/resume-manifest.mjs) is pure and imports only `node:crypto`.

- `buildResumeManifest({ subjectPath, declaredCommit, baseRef, basePin, upstreamArtifacts })`
  returns a frozen `gaia-resume-manifest/1` declaration. Paths are absolute; the commit is a full
  lowercase 40-hex identifier and is never expanded from an abbreviation; the base is
  `<remote>/<branch>` plus its pin, both or neither; upstream artifacts have distinct file names,
  because the prompt cites them by name.
- `checkResumePrompt({ promptText, manifest, observation })` returns a frozen
  `gaia-resume-verdict/1`: `RESUME_AGREED` or `RESUME_REFUSED`, `authority: NONE`, the prompt's
  SHA-256 and length (never its text), the declared and observed subject and base, each upstream
  artifact's classification, and every refusal.

[`src/resume-manifest-git.mjs`](../src/resume-manifest-git.mjs) is the observation adapter.
`observeResumeWorld(manifest)` requires the subject to be the root of a Git worktree, reads
`HEAD` and `git status --porcelain` (untracked files included) with optional locks off so it does
not even refresh the index, resolves the base with `git ls-remote` against a configured remote,
and reads each upstream artifact as bounded strict UTF-8. Variables that would point Git at
another repository are removed from its environment. It decides nothing.

[`scripts/check-resume-prompt.mjs`](../scripts/check-resume-prompt.mjs) composes the two
(`npm run resume:check`).

### Rules, in decision order

Every rule is decided and every refusal is reported, so one run lists everything to fix.

| Code | Rule | Observed defect |
| --- | --- | --- |
| `RESUME_BINDING_NOT_CITED` | The prompt text carries the declared subject path, the full declared commit, and the base pin when one is declared. A whole-token match: a longer sibling name is another worktree, an abbreviation is not the full commit, and separators and letter case do not change a Windows path. | Y1 as the operator meant it: the declaration was right, the text still named R3 |
| `RESUME_SUBJECT_COMMIT_MISMATCH` | `HEAD` of the subject worktree equals the declared commit. | Y1 |
| `RESUME_SUBJECT_DIRTY` | The subject worktree has no staged, unstaged or untracked change. | Y1's "verified clean at spawn" |
| `RESUME_BASE_PIN_STALE` | The pin equals the base resolved on its remote at check time, not the local tracking ref. | Y2 |
| `RESUME_BLOCKING_INPUT_OMITTED` | Every upstream artifact that names the declared commit (in full or by a 7-to-40-hex abbreviation) and carries a verdict line (`APPROVE` or `REQUEST_CHANGES`, Markdown emphasis ignored) or a trailing `<NAME>_COMPLETE` marker is cited by file name. | B16/B19 |

Issue #104 says a blocking artifact cites "the predecessor head". In every recorded resume the
prior round's verdicts judged exactly the head the next lane starts from: the R0 reviews judged
`1df8d87`, the R1 entry; the R1 reviews judged `e7d0fe2`, the R2 entry. The declared commit is
that head, so the rule binds to it.

Input the check cannot judge throws `ResumeManifestError` instead of producing a verdict:
`RESUME_MANIFEST_INVALID`, `RESUME_PROMPT_INVALID`, `RESUME_OBSERVATION_INVALID`, and, from the
adapter, `RESUME_OBSERVATION_UNAVAILABLE` with one of `SUBJECT_UNREADABLE`,
`SUBJECT_NOT_WORKTREE_ROOT`, `BASE_REMOTE_UNKNOWN`, `BASE_UNRESOLVED`, `UPSTREAM_UNREADABLE`,
`UPSTREAM_TOO_LARGE`. An unobservable world is never agreement.

Exit codes: `0` agreed · `2` usage error, including a malformed declaration such as an
abbreviated commit · `3` refused or fail-closed. There is no `1`: a prompt that disagrees with its
world is not launched, so every refusal is fail-closed.

## Entrypoint

One entrypoint: `node scripts/check-resume-prompt.mjs`, run immediately before a lane is spawned
from a prompt file and before every resume of it, including each `--resume` retry, since the
world can move between attempts. Anything other than exit `0` means do not launch.

```powershell
node scripts/check-resume-prompt.mjs --prompt prompts\pr85-r2-repair.txt `
  --subject D:\lanes\gaia-hosted-parallel-lanes-r0 --commit <40-hex entry> `
  --upstream D:\fleet\pr85-r1-standards-review.md --upstream D:\fleet\pr85-r1-spec-review.md
```

No runtime in this repository spawns or resumes a lane from a prompt file. The autonomous factory
writes its worker prompt from a structured intent inside an admitted clean linked worktree, so it
has no hand-built prompt to disagree with its tree; the fleet launcher that does (`run-lane.ps1`)
lives outside the repository. Issue #103 owns bringing that runner in. When it lands it composes
`observeResumeWorld` and `checkResumePrompt` exactly as the CLI does, before every attempt, and
should derive the declaration from its own launch parameters rather than from a retyped copy.

## Evidence

[`tests/resume-manifest.test.mjs`](../tests/resume-manifest.test.mjs) reproduces each recorded
defect with its real commit identities and the world the record states, one gate per refusal and
one mechanism revert per gate; the corrected PR #92 R4 prompt and the PR #85 R2 prompt are the
positive controls. Its prompts and review artifacts are shape-faithful reconstructions: they keep
the binding lines, citations, verdict and marker lines each defect turns on and replace the
prose. The verbatim fleet files live outside this repository and are not copied into it.

[`tests/check-resume-prompt-cli.test.mjs`](../tests/check-resume-prompt-cli.test.mjs) runs the
CLI against real Git worktrees with a bare remote. Its base case leaves the subject's own
tracking ref stale while the remote moves, so a resolver reading the local ref would agree where
this one refuses.

## What the check does not claim

Each residual names the observation that would show it matters.

- It checks the declaration it is given. A pin written in the prompt but not passed with
  `--base`, or a review not passed with `--upstream`, is not checked. Falsifier: a resumed lane
  that followed an undeclared pin or an unlisted verdict.
- Citation is presence, not exclusivity. A half-applied substitution that left both the declared
  worktree and another one in the text passes the citation rule. Falsifier: a lane that followed
  the other path.
- A verdict on an earlier generation than the declared commit does not block, which matters for a
  reviewer prompt over a repaired head. Falsifier: a resumed reviewer that missed a verdict on the
  head immediately before its subject.
- A verdict word inside a sentence, or a marker that is not the last non-empty line, is not
  recognised.
- An artifact that does not exist yet is not seen. B16/B19's Spec review was still being written
  when R1 was spawned; waiting for a pending reviewer is an operator decision, not a file.
- Agreement is one observation at one instant. It is not authority, not approval, and not proof
  that the artifacts were right. The check writes nothing.

## Reversibility

Freely reversible. Two modules, one CLI, their tests and this document are the whole footprint;
no schema, receipt, ledger or bus verb changes. Deleting them removes the check and changes no
other behaviour.
