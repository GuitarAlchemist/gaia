# Pi writer containment prototype verdict

**Question:** Can an exact path allowlist plus before/after worktree measurement safely
contain a Pi process that receives direct `edit` and `write` tools?

**Verdict:** No.

The state model correctly refuses visible out-of-scope mutations, unsafe path types, and
empty changes. It does not model writes through an existing junction or an absolute path
outside the candidate worktree. Those effects can occur without changing the measured Git
candidate or its in-worktree inventory. Post-run measurement therefore cannot be the sole
containment mechanism.

The production decision is to keep Pi read-only. Pi may propose a bounded textual patch;
Gaia must parse the patch, validate every target against the exact allowlist, run Git's patch
checks, apply it itself, and then remeasure the candidate. Pi receives no direct mutation
tool and no publication or repair authority.
