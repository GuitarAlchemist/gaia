# Artifact completion signals R0

## Operator problem

A provider finishes its work, writes its exact terminal artifact marker, and stops. wmux
still reports the wrapper — the shell, the `pwsh -File` launcher, the harness process that
outlives the model — as `running`. Gaia publishes only what wmux reports, so the control
room shows a live lane for work that is already done.

The operator therefore holds two truths that cannot both be acted on:

- the pane is **RUNNING**, so leave it alone;
- the handoff file ends with `..._COMPLETE`, so the work is finished.

There is no state machine between them. Nothing in the product says which reading is about
a process and which is about a task, nothing records the transition, and nothing can be
replayed to justify it. A reaper built on top of this today would be reaping on a guess.

R0 does not build the reaper. R0 makes the two truths separately nameable, separately
sourced and deterministically derived, so a later slice can act on one of them without
inferring it from the other.

## The two axes, and why they are two

**`processLifecycle`** is what wmux observed about a process. It is `RUNNING`, `EXITED` or
`UNKNOWN`, it comes from `wmux agent list` and from nothing else, and this slice does not
change how it is read, mapped or published. The lane's existing `lifecycle` field remains
its home; `taskStates[].processLifecycle` restates it beside the task state so the two can
be read together, and the verifier refuses any observation where the two disagree.

**`taskState`** is what the artifact bytes prove about the work. It is `UNBOUND`,
`RUNNING`, `COMPLETED_EVIDENCE`, `REFUSED_EVIDENCE` or `UNKNOWN`, and it is derived from an
operator-authored, content-addressed binding plus the bytes of the file that binding names.

They are two axes because they answer two questions, and every observed failure of this
product's ancestors came from collapsing two evidence axes into one number. A wrapper that
outlives its provider makes `RUNNING` + `COMPLETED_EVIDENCE` the *normal* state, not a
contradiction. The dashboard must be able to say both.

## Normative contract — `gaia-lane-artifact-bindings/1`

A binding is a statement by an operator: *this exact pane, running this exact agent, will
end by writing this exact marker at the end of this exact file, and here is the source
revision I authored that claim against.* It is input, never output, and it is never
inferred.

### The document

```json
{
  "schema": "gaia-lane-artifact-bindings/1",
  "effect": "NONE",
  "authority": "NONE",
  "bindings": [ { "...": "one binding record" } ],
  "revision": "<64 lowercase hex>"
}
```

Normative rules:

1. The five top-level field names above are the **complete** set. Any other field refuses
   the whole document. A closed set is refused rather than ignored, because a field that is
   ignored is a field a future reader may start honouring.
2. `effect` and `authority` are the literal string `NONE`. A binding file confers no
   authority and authorises no effect; it names evidence to read.
3. `bindings` is an array of at most **64** records, in strictly ascending
   `workspaceId`/`surfaceId`/`agentId` order — the product's existing lane order key — with
   no repeated identity. A duplicate is refused rather than resolved last-write-wins: two
   bindings for one lane is an operator error whose silent resolution would decide which
   artifact counts.
4. `revision` is `sha256` over the canonical JSON of `{schema, effect, authority, bindings}`
   with the bindings projected to their eight fields in a fixed key order. The verifier
   **re-derives** it. A binding file whose revision does not match its content is refused
   in full; no record inside it is used.

### The binding record

The eight field names below are the **complete** set for a record.

| field | rule |
| --- | --- |
| `workspaceId` | bounded identity, and never the `UNKNOWN` sentinel |
| `paneId` | bounded identity, and never the `UNKNOWN` sentinel |
| `surfaceId` | bounded identity, and never the `UNKNOWN` sentinel |
| `agentId` | bounded identity, and never the `UNKNOWN` sentinel |
| `allowedRoot` | absolute, self-resolving local directory path |
| `artifactPath` | absolute, self-resolving local file path strictly beneath `allowedRoot` |
| `completionMarker` | 8–200 ASCII graphic characters, no whitespace |
| `sourceRevision` | 64 lowercase hex — the content address of the source the binding was authored against |

"Bounded identity" is the identity pattern this product already enforces on every lane
field: `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`. It admits no whitespace, quote, angle bracket,
slash or newline, so an identity cannot carry a path, a URL, a command fragment or markup.
The `UNKNOWN` sentinel is additionally refused **in a binding** — it is the honest answer
for an identity wmux never supplied, and a binding that named it would match every lane
whose identity was missing. A binding names one pane or it names nothing.

`completionMarker` is restricted to ASCII graphic characters because a marker is compared
byte-for-byte. Allowing Unicode would put normalisation, confusables and invisible code
points between "the provider wrote its marker" and "the sensor found its marker", and every
one of those differences resolves in the attacker's favour.

### Path safety, stated as one rule

Both paths must satisfy `path.resolve(p) === p`. That single equality refuses relative
paths, `.` and `..` segments, trailing separators, duplicated separators and every
non-canonical spelling in one check, on both platforms, without a bespoke traversal parser.
In addition:

- a path may not begin with two separators, which refuses UNC and network-rooted paths —
  this product reads local files and opens no network;
- a path may not contain a NUL;
- a path is at most 512 characters;
- `artifactPath` must begin with `allowedRoot` followed by the platform separator, and be
  strictly longer than it. The root is a fence, not a hint.

These are **lexical** rules and they are enforced in the pure schema module. The process
boundary enforces the **physical** rule they cannot: after resolving symlinks, the artifact
must still be a regular file beneath the resolved allowed root. A symlink that points out
of the fence is `PATH_ESCAPES_ALLOWED_ROOT`, not a read.

### What can never establish a binding

A binding is established by the binding file and by nothing else. The sensor must never
infer one from a working directory, a git branch, a process tree, a pane label, a prompt,
a command line, a spawn time or an elapsed interval. Each of those is either attacker-
influenced, ambiguous across the operator's real machine, or both: labels are already
duplicated across live panes, worktrees share branches, and a pane label is chosen by
whoever spawned the pane — which may be another agent.

## Normative contract — the task state entry

An observation gains one optional top-level array, `taskStates`. When the sensor runs it is
always present, with one entry per identity in the union of *observed lanes* and *declared
bindings*, in the same strictly ascending identity order the lanes use, at most 128 entries.

The twelve field names below are the **complete** set for an entry.

| field | rule |
| --- | --- |
| `workspaceId`, `paneId`, `surfaceId`, `agentId` | bounded identities |
| `processLifecycle` | `RUNNING` \| `EXITED` \| `UNKNOWN`, equal to the matching lane's `lifecycle`, or `UNKNOWN` when no lane matched |
| `taskState` | `UNBOUND` \| `RUNNING` \| `COMPLETED_EVIDENCE` \| `REFUSED_EVIDENCE` \| `UNKNOWN` |
| `evidenceReason` | one closed token, whose entry in the reason table must name this `taskState` |
| `bindingRevision` | 64 hex content address of the binding record, or `null` exactly when `taskState` is `UNBOUND` |
| `generation` | integer `0 … 1000000` — the lifecycle generation this entry belongs to |
| `artifactDigest` | 64 hex `sha256` of the artifact bytes, or `null` |
| `completionObservedAt` | exact ISO instant of the **first** verified sighting, or `null` |
| `completionEvidenceRevision` | 64 hex content address of the completion evidence, or `null` |

The last three are non-`null` **exactly** when `taskState` is `COMPLETED_EVIDENCE`, and
`null` in every other state. A partial completion is not a completion.

### The reason table

Each reason names exactly one state, so a tampered pair of `taskState` and `evidenceReason`
is refused rather than displayed.

| reason | state |
| --- | --- |
| `NO_BINDING` | `UNBOUND` |
| `ARTIFACT_IN_PROGRESS` | `RUNNING` |
| `NO_COMPLETION_EVIDENCE` | `UNKNOWN` |
| `MARKER_VERIFIED` | `COMPLETED_EVIDENCE` |
| `DUPLICATE_MARKER` | `REFUSED_EVIDENCE` |
| `MARKER_NOT_TERMINAL` | `REFUSED_EVIDENCE` |
| `PATH_ESCAPES_ALLOWED_ROOT` | `REFUSED_EVIDENCE` |
| `NOT_A_REGULAR_FILE` | `REFUSED_EVIDENCE` |
| `ARTIFACT_TOO_LARGE` | `REFUSED_EVIDENCE` |
| `ARTIFACT_UNSTABLE` | `REFUSED_EVIDENCE` |
| `ARTIFACT_UNREADABLE` | `REFUSED_EVIDENCE` |
| `NO_ARTIFACT_OBSERVATION` | `REFUSED_EVIDENCE` |
| `COMPLETION_EVIDENCE_CONTRADICTED` | `REFUSED_EVIDENCE` |
| `REFUSAL_IS_STICKY_WITHIN_GENERATION` | `REFUSED_EVIDENCE` |

### The completion evidence address

```
completionEvidenceRevision = sha256(canonicalJson({
  schema: 'gaia-lane-completion-evidence/1',
  workspaceId, paneId, surfaceId, agentId,
  bindingRevision, generation, artifactDigest, completionObservedAt,
}))
```

The verifier re-derives it. A `COMPLETED_EVIDENCE` entry whose revision does not address
its own binding, generation, digest and instant is refused, which is what stops a
`COMPLETED_EVIDENCE` from being pasted onto a different lane, a different generation or a
different artifact.

## What the sensor does, in order

One tick is a total function of five inputs: the previous observation file, the binding
file, the `wmux agent list` payload, the artifact bytes, and the clock. Given the same five
it produces the same bytes.

1. **Read the previous observation** at `--out`, if the file exists. It is verified with
   the full schema verifier. A corrupt previous observation **refuses the tick** — it is
   not treated as absence, because treating it as absence is exactly the edit that would
   reset a `REFUSED_EVIDENCE` back to `RUNNING`. A previous observation dated after the
   current instant refuses the tick: a clock or a sensor timestamp is wrong and no
   generation can be reasoned about across it.
2. **Read the binding file** named by `--bindings`, if the flag was given. It is verified
   in full, including its re-derived revision. A corrupt or unverifiable binding file
   refuses the tick; it never degrades to "no bindings", because silently unbinding every
   lane is a downgrade an attacker can cause by writing one bad byte.
3. **Read the lanes** exactly as before: one `wmux agent list`, six named fields per record,
   sealed into the existing observation. Nothing in this step changed.
4. **Read each bound artifact, twice.** `lstat` refuses a symlink. `realpath` on the
   artifact and on the allowed root re-checks containment physically. A non-regular file, a
   file over 4 MiB, or bytes that are not valid UTF-8 is a refusal, not a read. The file is
   then read twice and the two `sha256` digests must be equal; if they differ the artifact
   was being written while it was being observed and the evidence is `ARTIFACT_UNSTABLE`.
5. **Derive the task states** with a pure function over (lanes, bindings, artifact evidence,
   previous task states, instant). It opens nothing and holds no clock.
6. **Seal and write.** The observation is verified against its own schema on the way out,
   so the sensor cannot emit a document its consumers would refuse.

## The marker rule

For a `COMPLETED_EVIDENCE`, all of the following must hold on the same stable bytes:

- the marker occurs **exactly once**, counted with overlapping occurrences, so a marker of
  `AAA` in `AAAA` counts as two and is refused;
- the marker is **terminal**: nothing but ASCII whitespace (carriage return, newline, tab,
  space) follows it;
- both reads produced the same digest.

Two occurrences are `DUPLICATE_MARKER`. A single occurrence with content after it is
`MARKER_NOT_TERMINAL`. Both are `REFUSED_EVIDENCE`, not "in progress": a file that contains
the marker in a place the contract does not allow is evidence of something, and the honest
report is that the sensor refuses to read it as completion.

## The state machine

Within one generation the only forward transition is:

```
RUNNING --(exactly one terminal marker on stable bytes)--> COMPLETED_EVIDENCE
```

and it is **monotonic**: once a generation has published `COMPLETED_EVIDENCE`, a later tick
that no longer finds that exact digest does not go back to `RUNNING`. It becomes
`COMPLETION_EVIDENCE_CONTRADICTED` / `REFUSED_EVIDENCE`. A refusal is likewise sticky for
the rest of the generation: `REFUSAL_IS_STICKY_WITHIN_GENERATION`.

`completionObservedAt` is the instant of the **first** verified sighting and is carried
forward unchanged while the digest keeps matching. It never drifts with the tick clock,
because a completion instant that advanced every five seconds would be a pace signal, and
this slice publishes no pace.

### Generations

A generation is one continuous run of one bound agent. It is an integer that starts at `0`
and increases by one, for an identity, when either of these is observed:

- the binding record for that identity content-addresses differently than it did last tick
  (`bindingRevision` changed — a new agent, a new artifact, a new marker or a new source
  revision); or
- the lane's `processLifecycle` was not `RUNNING` last tick and is `RUNNING` now — the pane
  restarted under the same identity.

When the generation changes, **no** prior evidence is carried: the entry is derived from
this tick's artifact bytes alone and starts `UNBOUND` or `RUNNING`. That is what makes a
restarted agent unable to inherit the previous run's completion.

Within a generation `processLifecycle` can only leave `RUNNING`, never return to it, since
returning is by definition a new generation. This is why `taskState: RUNNING` may be
published only when `processLifecycle` is `RUNNING`, and the verifier enforces it.

## What a completion claims, and what it does not

`COMPLETED_EVIDENCE` claims exactly one thing: *the file this binding names ended with the
marker this binding names, its bytes were stable across two reads, and here is their
digest.*

It does not claim, and this slice publishes no field that could be read as, any of:

- **approval** — nobody reviewed anything; a marker is a provider's own assertion;
- **success** — the work may be wrong, and the artifact may say so;
- **portfolio movement** — a wmux lane is not a portfolio item and gains no binding to one;
- **percentage, pace or ETA** — no elapsed time is read, published or divided by anything;
  `spawnTime` remains deliberately unread;
- **GitHub binding** — no repository, issue or pull request is named, derived or implied.

The observation's `effect: 'NONE'` and `authority: 'NONE'` are unchanged and remain
literal. Nothing in this slice kills a provider, closes a pane, sends a key, mutates wmux
or acquires an authority. The six bus verbs are untouched; no verb is added, widened or
re-scoped.

The artifact **path is never published**. The observation already excludes `cmd` because it
carries local absolute paths, and a completion signal that leaked the path would reintroduce
exactly what that exclusion removed. An operator identifies the artifact through
`bindingRevision`, which addresses the binding record they wrote.

## Where the truth lives

The **live truth source is the sealed observation file on disk**, written by the
server-side sensor. Two consequences are normative:

- **The browser never reads local files.** The control room is a rendered artifact. It
  receives a projection; it opens no path, resolves no root and reads no marker. Everything
  in this slice happens before the HTML exists.
- **DuckDB is not the live truth source.** Nothing in this path queries, writes or consults
  an analytics store. An analytics store may later *record* these observations; it may
  never *be* the thing a state transition is read from, because a warehouse row is a copy
  and the transition must be re-derivable from the artifact bytes.

The binding file reaches the sensor through one explicit CLI flag, `--bindings <path>`, on
`scripts/local-lane-sensor.mjs`, and through the same flag on `scripts/local-lanes-watch.mjs`,
which forwards it to the sensor and to nothing else. There is no environment variable, no
discovered default location and no implicit search: an operator who did not pass the flag
gets `UNBOUND` on every lane, which is the truthful answer.

## Fail-closed inventory

Every one of these produces a refusal rather than a reassuring reading:

| input | outcome |
| --- | --- |
| binding file absent, but flag given | tick refused |
| binding file unparseable | tick refused |
| binding file revision does not re-derive | tick refused |
| binding names the `UNKNOWN` identity sentinel | tick refused |
| binding path is relative, non-canonical, UNC or NUL-bearing | tick refused |
| `artifactPath` not strictly beneath `allowedRoot` | tick refused |
| previous observation corrupt | tick refused |
| previous observation dated in the future | tick refused |
| artifact is a symlink, directory or other non-regular file | `REFUSED_EVIDENCE` |
| artifact escapes the root once symlinks are resolved | `REFUSED_EVIDENCE` |
| artifact over 4 MiB | `REFUSED_EVIDENCE` |
| artifact is not valid UTF-8 | `REFUSED_EVIDENCE` |
| bytes changed between the two reads | `REFUSED_EVIDENCE` |
| marker occurs twice | `REFUSED_EVIDENCE` |
| marker is not terminal | `REFUSED_EVIDENCE` |
| a prior completion's digest no longer matches | `REFUSED_EVIDENCE` |
| bound lane, no artifact observation supplied | `REFUSED_EVIDENCE` |
| artifact absent or lacking the marker, pane running | `RUNNING` |
| artifact absent or lacking the marker, pane not running | `UNKNOWN` |
| lane with no binding | `UNBOUND` |

Note the asymmetry, which is deliberate. A malformed **input document** refuses the whole
tick, because it is a statement by the operator and a partly-honoured statement is a
statement nobody made. A malformed **artifact** refuses one entry, because the other lanes
are still truthfully observable and dropping them would under-report exactly the lanes an
operator is looking at.

## What is content-addressed, and what that proves

The observation's `revision` addresses the lane set, over the same seven lane fields it
always did. It is deliberately **not** widened to cover `taskStates`, because the control
room re-derives that revision from its own projection of the lanes; widening the recipe
would make the page refuse every observation this slice produces. Instead each
`COMPLETED_EVIDENCE` carries `completionEvidenceRevision`, re-derived by the verifier from
the entry's own binding, generation, digest and instant.

Both are **content addresses, not authentications**. They prove that a document was not
edited without being resealed. They cannot prove who produced it, and anyone who can write
the file can also recompute a self-consistent address. That limit is why monotonic
reconciliation matters more than the address does: a tamperer who forges a prior
`COMPLETED_EVIDENCE` gains nothing, because the very next tick re-reads the real artifact,
finds no matching digest, and publishes `REFUSED_EVIDENCE`. The one thing a tampered
history cannot produce is a silent, durable, false completion.

The residual gap, stated rather than hidden: a tamperer can *downgrade* a published entry —
rewrite a `RUNNING` to `UNKNOWN`, or a `COMPLETED_EVIDENCE` to `REFUSED_EVIDENCE` — and the
verifier will accept it, because those states carry no evidence to contradict. R0 accepts
that. Downgrades make the dashboard less confident, never more, and the destructive action
a later reaper takes is gated on the confident direction.

## Determinism and replay

The pure derivation is a function. Two runs over identical (lanes, bindings, artifact
evidence, previous task states, instant) produce byte-identical `taskStates`, in the same
order, with the same digests and the same generations. The order is the product's existing
lane order key, so no host collation, ICU version or object construction order can change
it. Replay is therefore a test, not a claim: the suite runs the same tick twice and
compares serialized bytes.

## What R0 does not build

- **No reaper.** Nothing here kills a provider, closes a pane, sends a key or mutates wmux
  state. This slice emits truthful state so that a later slice can be written against a
  transition instead of against a guess.
- **No polling of providers, no network, no install, no paid call.** The only subprocess is
  the single `wmux agent list` the sensor already made.
- **No new bus verb, and no widened authority.** The six verbs are exactly as they were.
- **No inference.** An unbound lane stays `UNBOUND` forever until an operator writes a
  binding for it. That is the point.
