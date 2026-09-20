# Gaia

Gaia is an evidence-bearing factory with a six-verb, non-privileged coordination
kernel. Start with [ARCHITECTURE.md](ARCHITECTURE.md) for system boundaries and
[engineering principles](docs/engineering-and-research-principles.md) for authority,
independent verification, and load-bearing design decisions.

## Delivery

For the current autonomy work, read [INTENT.md](INTENT.md) first: it records the
user's outcome, accepted scope, and measurable completion criteria.
For an implementation request, a pump continuation, or an incident repair, use
[gaia-delivery](.claude/skills/gaia-delivery/SKILL.md). It carries accepted intent
through bounded work, verification, and the next authorized transition.
GitHub issues hold work scope and disposition; PRs hold reviews and publication
evidence. Link supporting intent/design artifacts to that record or the originating
user request. Keep architecture in `ARCHITECTURE.md` and runtime authority in the
applicable verified capability, never in a prose status file.

## Verification

Use the runtime pinned in [.node-version](.node-version) and commands declared in
[package.json](package.json). Run the changed behavior's focused `node --test
tests/<name>.test.mjs` during implementation, then `npm test`, `npm run verify`,
and `node scripts/architecture-drift.mjs --base <full-base-sha>` before claiming
verification. Healthy evidence has exit code zero and no failing required checks;
report skips, unsupported environments, and unrun checks explicitly.

For review or promotion, read [REVIEW.md](REVIEW.md). A candidate receipt is not
proof of tests, publication, or merge. Bind each claim to the exact revision and
tool output; a review of an older PR head does not approve the current one.

## Learning

For a recurring delivery failure, follow the incident loop and adoption boundaries
in [the SDLC adaptation](docs/ai-native-sdlc.md). Add the regression at the failed
seam and update the smallest relevant instruction; retain one source of truth.
