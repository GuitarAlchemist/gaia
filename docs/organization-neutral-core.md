# Organization-neutral core

Gaia is published under one organization but has to stay usable by another (#49). The first step
is a rule the test suite enforces: **no module in `src/` names the organization it runs for.**

## The rule

`tests/organization-neutral.test.mjs` scans every `src/*.mjs` for two kinds of identity literal:

- **the owning organization's name**, in any case, as a whole word;
- **a literal `github.com/<owner>/<repo>` URL**, whatever the owner.

A URL built from inputs, such as `` `https://github.com/${owner}/${repo}` ``, is not a literal and
is not reported. Tests and scripts are not scanned. A test may name the organization it runs
against, and a composition root under `scripts/` is where an organization's values are supplied.

When a hit appears, there are two ways out:

1. **Move the literal out of the core.** Accept the value as an input and let the caller supply
   it. A default belongs in the composition root under `scripts/`, never in `src/`.
2. **Allowlist it**, only when the literal is a published contract identifier that has to stay
   verbatim. The entry names:
   - the file;
   - the exact literal;
   - a written reason.

   It excuses only a hit that lies inside that literal, in that file.

The gate refuses:

- an unexplained hit;
- more than one allowlist entry;
- an entry without a reason;
- an entry that no hit uses. When a literal leaves the core, its exception goes with it.

## The allowlist

The allowlist has one entry:

| File | Literal | Reason |
| --- | --- | --- |
| `src/epistemic-research.mjs` | `RESEARCH_PROPOSAL_SCHEMA`, the Demerzel `epistemic-research-proposal-v0.1` schema URI | A published contract identifier, not configuration. Demerzel owns the schema and the receiver matches the URI verbatim. Changing it is a contract version change, not a per-organization setting. |

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

A new profile changes no file in `src/`, so it cannot add a literal this gate would report.
