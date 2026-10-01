# Organization-neutral core

Status: a test gate (#183). It reads `src/` and grants nothing.

Gaia is published under one organization but has to stay usable by another (#49). The first step
is a rule the test suite enforces: **no file in `src/` names the organization it runs for.**

## The rule

`tests/organization-neutral.test.mjs` scans every file under `src/`, at any depth and comments
included, for two kinds of identity literal:

- **the owning organization's name**, in any case and anywhere, even inside a longer identifier
  such as an environment-style constant;
- **a literal GitHub owner**: `github.com/<owner>`, `github.com:<owner>` (SSH),
  `api.github.com/repos/<owner>`, `api.github.com/orgs/<owner>`, `api.github.com/users/<owner>`
  or `githubusercontent.com/<owner>`, whatever the owner.

An owner built from inputs, such as `` `https://github.com/${owner}/${repo}` ``, is not a literal
and is not reported. A literal owner is reported even when the repository after it comes from an
input. A GitHub path that is not an owner reads as one too: `github.com/login`, `github.com:443`
or `uploads.github.com/repos/…`, for example. Build such a path from an input or keep it out of
the core.

Tests and scripts are not scanned. A test may name the organization it runs against, and a
composition root under `scripts/` is where an organization's values are supplied.

When a hit appears, there are two ways out:

1. **Move the literal out of the core.** Accept the value as an input and let the caller supply
   it. A default belongs in the composition root under `scripts/`, never in `src/`.
2. **Allowlist it**, only when the literal is a published contract identifier that has to stay
   verbatim. Today's one entry is still pending publication, and says so. The entry names:
   - the file;
   - the exact literal;
   - a written reason.

   It excuses only a hit that lies inside that literal, written as a complete string literal, in
   that file.

The gate refuses:

- an unexplained hit;
- more than one allowlist entry;
- an entry without a reason;
- an entry that no hit uses. When a literal leaves the core, its exception goes with it.

## The allowlist

The allowlist has one entry. Its reason is written once, in the test.

| File | Literal | In short |
| --- | --- | --- |
| `src/epistemic-research.mjs` | `RESEARCH_PROPOSAL_SCHEMA`, the Demerzel `epistemic-research-proposal-v0.1` schema URI | The receiver's schema pins this URI, so it stays verbatim. That schema is still an open Demerzel pull request; re-check the exception when it lands. |

## Adding an organization profile later

The scanner proves only that the core does not name its organization. Running Gaia for a second
organization goes further, and #49 tracks it:

- every organization or repository identity reaches the core as an input, as it already does for
  the hosted pump: `scripts/hosted-draft-pump.mjs` reads `--repository` or `GAIA_REPOSITORY`
  and hands that identity to every adapter that checks it;
- one profile per organization, supplied by a composition root, holds its repositories, labels,
  policies and actors;
- a synthetic second-organization fixture runs one pump path end to end. That is the next slice
  on #49.

The scanner does not cover a bare repository name. `src/epistemic-research.mjs` still names
`gaia` as the proposal's origin repository, which the pending Demerzel schema pins too. That belongs to
#49's inventory, not to this gate.
