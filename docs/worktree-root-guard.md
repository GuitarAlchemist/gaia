# Worktree-root guard

Status: design record and Decision Receipt for issue #224 (ENG-02). Code:
[`src/worktree-root.mjs`](../src/worktree-root.mjs), used by
[`src/factory-agent.mjs`](../src/factory-agent.mjs) and
[`src/resume-manifest-git.mjs`](../src/resume-manifest-git.mjs).

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
| `attributes`, a `HOME` holding `.config/git/attributes` | a `whitespace` attribute | the `core.attributesFile` pin | fails this row |

Without the other repository's `info/attributes`, M5 passed the test: the `core.whitespace` pin
alone outranks that repository's config.
