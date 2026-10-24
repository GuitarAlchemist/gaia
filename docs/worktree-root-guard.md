# Worktree-root guard

Status: design record and Decision Receipt for issue #224 (ENG-02). Code:
[`src/worktree-root.mjs`](../src/worktree-root.mjs), used by
[`src/factory-agent.mjs`](../src/factory-agent.mjs),
[`src/resume-manifest-git.mjs`](../src/resume-manifest-git.mjs),
[`src/autonomous-factory-host.mjs`](../src/autonomous-factory-host.mjs),
[`src/git-gh-publication-effects.mjs`](../src/git-gh-publication-effects.mjs) and
[`src/github-portfolio-execution.mjs`](../src/github-portfolio-execution.mjs).

## Mission brief

Three entry points take a path and then read authority-bearing state through it: the Node pin, the
change-set binding, the HEAD a receipt names.

| entry point | caller | refusal |
|---|---|---|
| `assertLinkedCleanWorktree` | `executeAgentFactory`, `runPiWorker` | `GitWorktreeRequired` |
| `verifyCommittedHead` | `npm run verify:head` | `GitWorktreeRequired`, `WorktreeRootRequired` |
| `observeResumeWorld` | `scripts/check-resume-prompt.mjs` | `SUBJECT_NOT_WORKTREE_ROOT` |

Each one decided "this path is the root of a Git worktree" with its own idiom. #218 R0 added a
fourth idiom, `--is-inside-work-tree` alone, and lost the root binding. From a subdirectory it
sealed a PASS receipt that the verifier accepted, with `pinned: null`, every changed file recorded
as `deleted`, and `node --test` run on the subtree only.

- **Success:** one module owns the root decision. The three entry points call it, and each keeps
  its refusal code or maps it explicitly. The hard cases are tested once, at the guard. A
  mechanism-revert control fails at every call site.
- **Non-goals:**
  - The linked-worktree, cleanliness and ancestry requirements stay where they are.
  - No receipt, CLI flag, workflow or persistent format changes.
  - A lint rule is not a substitute. #224 records why: the obvious lexical rule flags the correct
    resume adapter on every head.

## Measurement

A probe ran the three existing idioms over the same cases, on Git 2.45.1.windows.1 and Node
v26.8.1. The idioms are:

- **A:** `.git` exists at the path, and `--is-inside-work-tree` is `true`.
- **B:** `--is-inside-work-tree` is `true`, and `--show-prefix` is empty.
- **C:** `--is-inside-work-tree` is `true`, and the realpath of `--show-toplevel` equals the realpath
  of the path.

**Without repository locators in the environment, the three idioms agree on every case.** All
three accept these paths:

- the root;
- a relative path to it;
- a trailing separator;
- a `sub\..` path;
- an upper-cased path;
- an 8.3 short name of the root;
- a junction outside the root that points at it;
- a junction inside the root that points at another repository's root (it is that root);
- a primary checkout's root.

All three refuse these paths:

- a subdirectory, including an 8.3 short name of one;
- a junction inside the root that points at one of its own subdirectories;
- a `.git` directory;
- a plain directory;
- a missing path.

**With a repository locator in the environment, every idiom is fooled.**

| environment | A | B | C |
|---|---|---|---|
| `GIT_DIR=<other>/.git` | accepts the root while Git reads `<other>` | accepts a subdirectory, a `.git` directory, a plain directory | same as B |
| `GIT_DIR=<other>/.git`, `GIT_WORK_TREE=<plain>` | refuses | accepts `<plain>` | accepts `<plain>` |

That environment is ordinary. Git exports `GIT_DIR`, `GIT_WORK_TREE` and others to every hook
(githooks(5)), so a `verify:head` started from a hook inherits them. At the base,
`src/resume-manifest-git.mjs` already stripped these variables before every Git call, but the
factory's two Git helpers did not, so both factory entry points could be redirected.

So the failure family has two members:

- an entry point re-implements the root decision and loses the root binding (#218 R0);
- an entry point decides it under an environment that names another repository.

## Invariants

1. **The path names the repository, never the environment.** Every Git call made by the guard or
   by an entry point after it runs without the repository-locator variables.
2. **Root means the realpath of `--show-toplevel` equals the realpath of the path.** On Windows the
   realpath resolves case, 8.3 names and junctions.
3. **A failure to observe is a refusal.** A missing path, a Git failure or an unparsable answer is
   never acceptance.

Usage sketch, before any design:

```js
const root = requireWorktreeRoot(path); // canonical root, or a typed refusal
```

## Design alternatives

### D1. A check that returns the canonical root (minimal surface)

```js
requireWorktreeRoot(path) -> root             // realpath of the worktree root
  throws WorktreeRootError('NOT_A_WORKTREE' | 'NOT_WORKTREE_ROOT')
repositoryNeutralEnvironment(env = process.env) -> env without the locators
```

- **Hidden:** the Git invocation, its environment, the realpath comparison, and the
  Windows aliases.
- **Callers:** each maps the two codes to its own refusal and uses the shared environment for its
  own Git calls.
- **Failure modes:** a caller that catches the error and continues. Every caller is a single `try`
  around one call, so a review sees this.
- **Dependencies:** `node:child_process`, `node:fs`, `node:path`.

### D2. A resolver that returns an observation (maximum adaptability)

```js
observeWorktreeRoot(path) -> { kind: 'ROOT' | 'BELOW_ROOT' | 'NOT_A_WORKTREE', root, prefix }
```

- **Callers:** each decides which kinds it refuses.
- **Gain:** adaptability. A future caller could accept `BELOW_ROOT`.
- **Failure mode:** this is the #218 R0 failure itself. A caller that tests
  `kind !== 'NOT_A_WORKTREE'` re-creates the "inside is enough" idiom, and the module cannot stop
  it.
- **Deletion test:** deleting the module moves almost nothing back to the callers, because the
  decision already lives there.

### D3. A worktree handle that owns every Git read (ports-and-adapters isolation)

```js
openWorktree(path) -> { root, git(args) -> stdout }   // refuses like D1
```

- **Gain:** the handle binds the working directory and the locator-free environment to every later
  read. A caller cannot run Git against the path any other way.
- **Cost:** 20 Git call sites change: the 16 call sites of the factory's two helpers (13 `git`,
  3 `gitInput`) and the 4 call sites of the resume adapter's helper. The 3 entry points change
  too. The two modules' Git failures map differently: a raw throw in the factory, closed details
  in the resume adapter. The handle would then need a mapping hook or two variants.
- **Failure modes:** the diff is large in a 1,000-line module with several authority checks. The
  review surface grows without new protection, since invariant 1 is reachable with one
  environment function.

### Comparison

| | D1 | D2 | D3 |
|---|---|---|---|
| module depth | deep: one call hides the Git invocation, the environment and the realpath comparison | shallow: the decision stays at callers | deepest |
| locality of change | 3 entry points, 3 helpers | 3 entry points | 3 entry points, 20 Git call sites |
| seam placement | at the decision | below the decision | at every Git read |
| reversibility | freely reversible | freely reversible | freely reversible, costly |
| operational risk | low | repeats #218 R0 | diff-size risk |
| testability | one table of cases, one environment control | same table, but no refusal to pin | same as D1, plus a handle contract |

## Decision Receipt

- **Decision:** D1. `requireWorktreeRoot` returns the canonical root or throws `WorktreeRootError`
  with one of two codes. The same module exports `repositoryNeutralEnvironment`, which the factory's
  two Git helpers and the resume adapter's Git helper use for every call. That one line per helper
  gives D3's binding of later reads without D3's rewrite.
- **Alternatives rejected:**
  - D2 leaves the refusal at each caller, which is the failure #224 exists to remove.
  - D3 buys no protection beyond D1 plus the shared environment, at about four times as many
    changed sites (23 against 6).
- **Refusal mapping:**

  | entry point | `NOT_A_WORKTREE` | `NOT_WORKTREE_ROOT` |
  |---|---|---|
  | `assertLinkedCleanWorktree` | `GitWorktreeRequired` | `WorktreeRootRequired` (new here) |
  | `verifyCommittedHead` | `GitWorktreeRequired` | `WorktreeRootRequired` |
  | `observeResumeWorld` | `SUBJECT_NOT_WORKTREE_ROOT` | `SUBJECT_NOT_WORKTREE_ROOT` |

  - **The factory's new code.** `assertLinkedCleanWorktree` first requires a `.git` file at the
    path, and a valid gitfile makes that path its worktree's top. So `WorktreeRootRequired` cannot
    be reached there with a clean environment. It is mapped rather than left unhandled.
  - **The factory's raw failure becomes a refusal.** A `.git` file that Git cannot read used to
    reach the caller as a raw `execFileSync` failure. It is now `GitWorktreeRequired`.
- **Authority delta:** none. No new effect, verb, credential, network call, dependency, CLI flag or
  receipt field.
- **Reversibility:** freely reversible. Reverting restores the three inline checks, and nothing
  persisted depends on the module.
- **Inputs:** base `37ba7bdd1808f91915cf16573f1eaf5d58348c09`, issue #224, Git 2.45.1.windows.1,
  Node v26.8.1.
  `tests/worktree-root.test.mjs` re-runs the measurement above as its case table.

This receipt selects an implementation candidate. It is not independent review, and it grants no
publication or merge authority.

The D3 cost was first given as "about 30" and "~35" call sites, with "about ten times the diff". #243's
R1 Standards review counted 16 factory call sites, and this record now gives the measured figures.
The direction of the comparison is unchanged.

## Known limits

This was measured during #243's review. The guard does not close it.

- **A write into the repository can still create a root.** Git calls a directory its worktree's top
  when it holds a gitfile, or when `core.worktree` in the repository's own `.git/config` names it.
  So a planted copy of a worktree's `.git` file, or that config key, makes a directory below the
  worktree a root. The guard follows Git's definition and does not consult `git worktree list`.
  Each entry point's index-bound cleanliness check still refuses the directory unless it mirrors
  every tracked file. The same key set through `GIT_CONFIG_*`, the global config or `HOME` is
  ignored by Git 2.45.1. A writer to the repository is outside what this guard defends.

## The patch path

`gitInput` runs only `git apply` without `--index`, for the Pi worker's patch. It resolves every
*path* against its working directory. A probe ran the factory's three `apply` invocations from a
worktree root under ten locator environments, and each one patched the working directory and
nothing else.

The *rule* that `--whitespace=error-all` enforces is configuration. `core.whitespace` sets it, and
a `whitespace` attribute overrides it per path. Git reads both from every source the process
inherits.

- **Locators:** #244's R0 Standards review found that an inherited `GIT_DIR` naming a repository
  whose `core.whitespace` drops `trailing-space` let a trailing-space patch through.
- **Configuration sources:** #248 measured the same through the sources the neutral environment
  does not strip: `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `HOME` and
  `XDG_CONFIG_HOME`. A global attributes file did the same, whether found through `HOME` or
  `XDG_CONFIG_HOME` or named by `core.attributesFile`.

So the gate's two `apply` calls pin the rule on the command line, which outranks every other
configuration source:

- `core.whitespace=blank-at-eol,blank-at-eof,space-before-tab`, which is Git's default rule;
- `core.attributesFile` set to the null device, which turns off the global attributes file and its
  XDG default.

#248 listed one alternative: strip `GIT_CONFIG_*` from the helpers and pin the global and system
files. It was not chosen, because it changes every factory Git call, not just the gate. It also
drops the system `core.autocrlf=true` of Git for Windows. Under a replaced `GIT_CONFIG_SYSTEM`, the
probe's trailing-space patch failed on its context rather than its whitespace, as #244's R1 Spec
review had also seen.

The pin also overrides the worktree repository's own `core.whitespace`, because the gate is the
factory's rule. Gaia sets none, so its gate is unchanged. A repository's own `info/attributes`
outranks every pin, so only the neutral environment keeps another repository's attributes out.

`tests/factory-agent.test.mjs` pins this with "ambient Git configuration cannot relax the
whitespace gate on a Pi worker patch". Each row except the clean control first shows that Git
itself accepts the patch. Each mechanism-revert control was run on a throwaway copy:

| rows | relaxed through | refused by | removing that mechanism alone |
|---|---|---|---|
| `GIT_DIR`, `GIT_COMMON_DIR` | another repository's config and `info/attributes` | the neutral environment in `gitInput` | fails both rows (M5) |
| `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`, `GIT_CONFIG_GLOBAL`, `HOME` | `core.whitespace` | the `core.whitespace` pin | fails these four rows |
| `attributes`, an `XDG_CONFIG_HOME` holding `git/attributes` | a `whitespace` attribute | the `core.attributesFile` pin | fails this row |

Without the other repository's `info/attributes`, M5 passed the test: the `core.whitespace` pin
alone outranks that repository's config.

## The cleanliness check

Three factory reads decide what a worktree holds besides its commit:

- the entry check of `executeAgentFactory` and `runPiWorker`, which refuses with
  `CleanWorktreeRequired`;
- the clean check of `verifyCommittedHead`, which refuses the same way;
- a change set, which records the `git status` bytes and lists every untracked file through
  `git ls-files --others --exclude-standard`.

Which untracked files Git reports is configuration. `status.showUntrackedFiles=no` drops them all
from `git status`. An excludes file drops the files it names from both commands. That file is
`core.excludesFile`, or by default `$XDG_CONFIG_HOME/git/ignore` or `$HOME/.config/git/ignore`.
Git reads both settings from every source the process inherits. #251 measured each of them hiding
an untracked file: `status.showUntrackedFiles` through `GIT_CONFIG_COUNT`, `GIT_CONFIG_PARAMETERS`,
`GIT_CONFIG_GLOBAL`, `HOME` and `XDG_CONFIG_HOME`; the excludes file named through
`GIT_CONFIG_COUNT` or `GIT_CONFIG_PARAMETERS`, or found at its default path. A hidden untracked
`.gitattributes` holding `* -whitespace` then let a trailing-space patch through `runPiWorker`,
because a worktree's own attributes outrank the whitespace gate's pins.

So `worktreeStatus` runs the factory's one `git status` with the first pin, and every factory Git
call after the root guard's, the change set's `ls-files` among them, runs under `WORKTREE_VIEW`
from `src/worktree-root.mjs`, which holds the second:

- `--untracked-files=normal`, which is Git's default, so a change set's status bytes are unchanged
  where nothing was set;
- `core.excludesFile=/dev/null`, which turns off the operator's excludes file and its default path.
  Git for Windows warns on every call that it cannot access `os.devNull` (`\\.\nul`) as an
  excludes file, and then skips it. It reads `/dev/null` as empty without a warning, as Git does on
  Linux; an empty value measured the same.

The repository's own `.gitignore` and `info/exclude` still apply. Claude Code hides its
`.claude/settings.local.json` through the operator's global ignore file, and 13 Gaia worktrees on
the author's host held one. Under the pin, both clean checks would have refused them and a change
set would have listed the file, so Gaia's `.gitignore` now names it.

In #251's probe, `core.worktree` and `core.ignoreStat` set through `GIT_CONFIG_COUNT` hid nothing
from `git status`. `core.fsmonitor` and `core.untrackedCache` are the next section's.

Three tests pin this, one per read, over the same seven rows from `tests/helpers/ambient-git.mjs`:
"ambient Git configuration cannot hide an untracked file from the Pi worker entry check", "... an
untracked test file from the head verification", and "... change what a change set measures". Each
row except the clean control first shows that an unpinned `git status` hides the file. Each
mechanism-revert control was run on a throwaway copy, before #256 moved the excludes pin into
`WORKTREE_VIEW`:

| removed | fails |
|---|---|
| `--untracked-files=normal` | the four `status.showUntrackedFiles` rows, in all three tests |
| `core.excludesFile` on `git status` | the two excludes rows, in all three tests |
| `core.excludesFile` on `ls-files` | the two excludes rows, in the change-set test only |
| `worktreeStatus` at one read, back to the unpinned call | every hidden row, in that read's test only |

### What decides that a file changed

Git does not read every file to decide whether it changed. It compares the file's stat data with
its index entry. With `core.fsmonitor` naming a hook, Git asks the hook which paths changed since a
token it stored in the index, and trusts the answer: a path the hook does not name is unchanged.
With `core.untrackedCache` set, Git also stores the list of untracked files in the index, and under
the monitor trusts the hook for that list too. Git reads both settings from every source the
process inherits.

#255's R0 Spec review found the route, and #256 measured it on Git 2.45.1.windows.1. The hook was
two lines of `#!/bin/sh` outside the repository, printing a token and no path, set through
`GIT_CONFIG_COUNT`. Once a read under the hook had stored its token, a tracked edit to
`candidate.txt` and a new `stray.txt` made after it read as follows:

| route | `git status` under #255's pin | the change set before #256 |
|---|---|---|
| clean control | ` M candidate.txt`, `?? stray.txt` | `statusBytes: 30`, both files |
| hook | `?? stray.txt` | `statusBytes: 13`, `patchBytes: 0`, no `candidate.txt` |
| hook and `core.untrackedCache=true` | nothing | `statusBytes: 0`, `patchBytes: 0`; `stray.txt` only through `ls-files` |
| `core.untrackedCache=true` alone | both, as in #255's review | unchanged: the directory's timestamp invalidates the cache |

`git diff` reads the same index, so the change set's `--name-only` and `--binary` missed the edit
too. `git ls-files --others` lists the directories itself and missed nothing. Before #256 the
factory's own entry check stored the token, so:

- a worker's edit was missing from the receipt that the reviewer reviews and the publisher binds;
- a tracked edit, or with the cache a new file, passed the next entry check of `runPiWorker` and the
  next clean check of `verifyCommittedHead`.

`WORKTREE_VIEW` sets `core.fsmonitor=false`, so Git checks each file's stat data itself, and
`core.untrackedCache=false`, so Git lists the directories itself. The monitor pin is the one that
shows the edit: `core.untrackedCache=false` alone shows the new file but not the edit.

The cache pin was not in #256's first design. A Git-only probe had shown both changes under the
monitor pin alone, in both hook routes. Then a mechanism-revert control that removed only the hooks
pin let a new file through the Pi worker's entry check, in the hook-and-cache row, which sets no
hook path. The same cell had passed in the runs before. An untracked cache built while Git trusts
the monitor records each directory's timestamp and does not check it again. Suppose the new file
lands within that timestamp's resolution, and a later read under the hook rewrites the index. The
timestamp then still matches, and the index is no longer racy, so a read without the monitor trusts
the stale list. `holdTimestamp` in `tests/helpers/ambient-git.mjs` sets the directory's timestamp to
one whole second across the prime and the change, so every run meets that case. Measured that way,
the monitor pin alone misses the new file in all four tests that write one, and the cache pin shows
it. With the timestamp held, `core.untrackedCache=true` alone hides the new file too. With the
clock left alone it did not: there, the index written in the same second is racy.

Hooks ran too. Git runs the monitor's hook on every read that consults it. It runs
`post-index-change` when `git status` rewrites the index, which status does whenever an entry's
timestamp is racy. Both came from the operator's configuration. `WORKTREE_VIEW` sets
`core.hooksPath=`, so no hook runs while the factory reads a worktree. With that value, Git looks
for each hook at the root of the current drive (`git rev-parse --git-path hooks/post-index-change`
prints `/post-index-change`). On the author's host, an account without administrator rights cannot
create a file at the root of `C:\`.

The resume check's observation adapter, `src/resume-manifest-git.mjs`, asks the entry check's
question for its `clean` flag, which `RESUME_SUBJECT_DIRTY` reads, so every Git call it makes after
the root guard's runs under the same view. Before #256 an excludes file hid an untracked file from it, and a hook hid an edit
made after another read stored the token. Its `--untracked-files=all` already outranked
`status.showUntrackedFiles`. It runs with optional locks off, so it never stores a token itself.

Six tests pin this:

- "an ambient core.fsmonitor cannot hide the worker's change from the receipt", through
  `executeAgentFactory`;
- "... a change from the Pi worker entry check";
- "... a change from the head verification";
- "... change what a change set measures";
- "no hook from the operator's configuration runs during the factory's reads";
- "CLI: ambient Git configuration cannot make a changed subject read as clean".

The rows are `changeHidingRows` in `tests/helpers/ambient-git.mjs`. Each hook row first shows the
read before #256 missing the change. The publication test of #242 now also installs
`post-index-change` under its `hooksPath` route. Each mechanism-revert control was run on a
throwaway copy:

| removed | fails |
|---|---|
| `core.fsmonitor=false` | all six tests: each hook cell that misses the tracked edit before #256, and the monitor's hook in the hooks test. The hook-and-cache cell that writes a new file stays refused: the cache pin shows that file |
| `core.untrackedCache=false` | the hook-and-cache cell that writes a new file, in the receipt, entry-check, head-verification and change-set tests |
| `core.hooksPath=` | the hooks test, through `post-index-change` |
| `core.excludesFile=/dev/null` | #251's three tests, and the excludes-file and ignore-file rows of the resume test |
| the view on the resume adapter's Git calls | the resume test: its excludes-file, ignore-file and both hook rows |
| the view on the factory's Git calls | #251's three tests and the five factory tests of #256 |
| `--untracked-files=normal` | #251's three tests |

#242's publication test now also installs `post-index-change`. Against the source before #256 it
recorded that hook in one run of two, depending on whether the index was racy. So it is not a
deterministic guard; the hooks test, which makes the index racy, is.

`diff.ignoreSubmodules=all` hides a changed gitlink from `git status` and `git diff`. Gaia has no
submodule, and the view does not pin it. `core.fsmonitor=true`, Git's built-in monitor daemon, was
not started on the host; `core.fsmonitor=false` is the same key set to off.

## What prints the patch

Before #269 the change set's `patchBytes` and `patchSha256` measured `git diff --binary <head> --`.
The Pi reviewer read the same command again, refused `ReviewerInputMismatch` unless it had those
bytes, then showed the patch to the model. Git lets the operator's configuration replace that
output. An external program named by `GIT_EXTERNAL_DIFF`, `diff.external` or a diff driver's
`command` prints in place of the patch. A textconv driver rewrites both sides before Git compares
them. A driver applies through any attributes file Git reads, the operator's `core.attributesFile`
included. Git for Windows ships one: its system `gitconfig` sets `diff.astextplain.textconv`, and
its system `gitattributes` applies that driver to `*.pdf`, `*.doc`, `*.docx`, `*.rtf` and other
document types.

#267's R1 reviews found the route, and #269 measured it on Git 2.45.1.windows.1. `candidate.txt`
changed from `before` to `after`, and each program was a `#!/bin/sh` script outside the repository:

| route | the change set before #269 |
|---|---|
| clean control | `patchBytes: 140`, Git's patch |
| `GIT_EXTERNAL_DIFF`; `diff.external`; a driver's `command` through `core.attributesFile` | `patchBytes: 15`, the program's `nothing to see` |
| a textconv driver that upper-cases, through `core.attributesFile` | `patchBytes: 141` |

The reviewer read under the same environment, so its check agreed with the measurement, and the
model judged a patch other than the change the publisher sends. The file list and the status bytes
stayed right.

`candidatePatch` in `src/factory-agent.mjs` is now the one read. It passes `--no-ext-diff` and
`--no-textconv`, and the change set and the Pi reviewer's default `readPatch` both call it. These
are flags rather than a pin in the view because `GIT_EXTERNAL_DIFF` outranks `diff.external`, so no
configuration value turns it off, and no single key turns off every textconv driver. Nothing
applies the patch `readPatch` returns; it is the reviewer's input only.

The test "an ambient external diff or textconv driver cannot change the patch the reviewer reads"
pins this over `patchSubstitutingRows` in `tests/helpers/ambient-git.mjs`. Each row except the
clean control first shows that an unpinned `git diff` prints another patch. Each mechanism-revert
control was run in place and the file restored:

| removed | fails |
|---|---|
| `--no-ext-diff` | the three external-program rows |
| `--no-textconv` | the textconv row |
| `candidatePatch` in `readPatch`, back to the bare call | every row but the control, as `ReviewerInputMismatch` |
| `candidatePatch` in the change set, back to the bare call | every row but the control |

Where Git used to print something other than its own patch, the factory now measures and shows the
real one, and the real patch meets the limits below where the substitute could pass them. Those
hosts have an external program, or any textconv driver, the `astextplain` that Git for Windows
ships for documents included, so they include hosts with no operator configuration at all. The
three limits apply to any patch Git prints in full, and they predate #269 (#273 tracks typing them):

- **1 MiB, every reviewer.** `runGit` leaves `execFileSync` at Node's default `maxBuffer`, so a
  patch above 1 MiB throws `ENOBUFS` in the measurement. On a stock Git for Windows host, #272's R1
  reviews measured a PDF whose real patch is 1,849,297 bytes and a 900 KB `.docx` whose real patch
  is 1,160,992 bytes; the base measured `astextplain`'s text, 228 and 254 bytes, and went on.
- **About 32,000 characters, the Pi reviewer on Windows.** Its prompt is one command-line argument,
  and Windows caps a command line at 32,767 characters, so a patch of more than about 32,000
  characters fails the launch with `ENAMETOOLONG`. On the same host, R1 Spec measured a 30 KB
  `.docx` whose real patch is 39,457 bytes; the base measured 250 bytes and launched.
- **UTF-8, the Pi reviewer.** `readPatch` decodes UTF-8, so a patch that is not valid UTF-8 no
  longer matches the measured bytes and is refused as `ReviewerInputMismatch`. #272's reviews
  measured a Latin-1 file under an external program and under a converting textconv driver.

Within those limits, a changed document now reaches the receipt and the prompt as Git's own patch;
R1 Spec measured a small `.docx` at 246 bytes before and 302 after.

Settings that only shape the patch's format, such as `diff.noprefix`, `diff.context` or
`color.diff=always`, change its bytes, not the change it shows. Both reads go through the same call
and obey them alike; #272's R0 Spec review measured `color.diff` and `diff.noprefix`.
