# Lane resume manifest (W1) — refusing a prompt that disagrees with its tree or artifacts

Status: shipped contract for the check only. This document grants no authority, resumes no
lane, and approves nothing. Wiring the check into a concrete resume path is a separate,
explicitly reviewed change.

## Operator problem

A suspended lane holds three things that must still agree when it resumes: the exact prompt
it was launched with, the worktree state that prompt was written against, and the set of
artifacts the lane had already produced. Nothing binds them today. A resume can replay
yesterday's prompt over a tree that has since moved, or over an artifact set another lane
has extended, and the provider will continue the wrong work with full confidence — the
silent-staleness failure this repository refuses elsewhere by digest, restated at the lane
boundary.

## Contract

[`src/resume-manifest.mjs`](../src/resume-manifest.mjs) is pure: no filesystem, no clock,
no process. It imports only `node:crypto`. The caller supplies every observation.

- `buildLaneResumeManifest({ laneId, prompt, tree, artifacts })` binds one prompt — by
  SHA-256 digest and length, never by text — to one tree observation
  (`{ head, workspaceIdentity }`) and one artifact set (`[{ path, sha256 }]`, strictly
  ascending by path), and seals the body under `manifestDigest`.
- `requireLaneResumeManifest(manifest)` is the total verifier: exact keys both directions,
  closed value patterns, canonical artifact ordering, and the seal. Unknown fields are
  refused, never dropped.
- `checkLaneResumeAgreement({ manifest, prompt, tree, artifacts })` is the resume check.
  It refuses a prompt the manifest does not bind, and refuses a bound prompt whose recorded
  tree or artifact set disagrees with what the caller observes now. On agreement it returns
  a frozen `{ agreement: 'RESUME_AGREED', schema, laneId, manifestDigest }`.

Schema: `gaia-lane-resume-manifest/1`. Bounds: the prompt is 1–16000 characters, matching
the visible provider's launch bound; at most 256 artifacts; artifact paths are safe
repository-relative paths — no absolute path, no `..` or `.` segment, no backslash, no
drive colon, no control character, and never `.git` or anything under it.

## Refusal codes, in decision order

| Code | Meaning |
| --- | --- |
| `RESUME_MANIFEST_INVALID` | The record's shape, vocabulary, ordering or bounds are wrong. |
| `RESUME_MANIFEST_DIGEST_MISMATCH` | The record was resealed or edited; the seal does not match the body. |
| `RESUME_OBSERVATION_INVALID` | The caller's own observation is malformed; never reported as a disagreement. |
| `RESUME_PROMPT_UNBOUND` | The supplied prompt is not the one this manifest binds. |
| `RESUME_TREE_DISAGREEMENT` | The bound prompt was written against a different `head` or workspace identity. |
| `RESUME_ARTIFACT_SET_DISAGREEMENT` | The bound prompt was written against a different artifact set. |

Every disagreement is a typed refusal, never a repair, a clamp, or a "close enough". The
right recovery is to re-derive the prompt from the tree and artifacts actually in front of
the caller, not to edit the manifest.

## What the check does not claim

- The manifest is unauthenticated local evidence. Anyone who can write the file can reseal
  any claim into it, so agreement is a consistency statement between one record and one
  fresh observation — not authority, not approval, and not authenticity.
- Agreement does not say the recorded artifacts were ever correct, that tests passed, or
  that resuming is a good idea. It says only that the prompt, the tree and the artifact set
  still describe the same instant.
- The module performs no effect and holds no capability. It never reads the worktree; the
  caller measures `head`, the workspace identity and the artifact digests through its own
  existing seams and passes them in.

## Reversibility

Freely reversible. The module, its tests and this document are the whole footprint; no
existing schema, receipt, ledger or bus verb changes. Deleting them removes the check and
changes no other behaviour.
