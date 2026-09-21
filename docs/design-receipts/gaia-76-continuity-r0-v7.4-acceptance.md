# GAIA [issue #76](https://github.com/GuitarAlchemist/gaia/issues/76) continuity tracer R0 acceptance

This record binds implementation of the bounded continuity tracer to one exact
Design It Twice receipt and its independent review. It does not grant merge,
deployment, spending, credential, administrative, or provider-launch authority.

## Accepted design

- Space VFS path: `design-receipts/gaia-76-continuity-r0-v7.4.md`
- Space VFS sequence: `29`
- SHA-256: `8370407bd2ff6aee466d97e8d7395117e550c2bf208a27fab9af1f9097b76ea8`
- Byte length: `19301`
- Accountable human: `@spareilleux`
- Acceptance evidence: the user explicitly accepted the exact digest and the
  temporary, non-system acquisition of Node `26.8.1` in Codex task
  `01a04b30-bd3a-7530-8f4f-185954d433c9` on 2026-09-20.

The Codex task is not publicly resolvable. The linked GitHub issue is therefore
the durable authority record for scope; this receipt records the task ID only as
local provenance and does not treat it as a public link.

## Independent review

- Space VFS path: `design-reviews/gaia-76-continuity-r0-v7.4-pair-review.md`
- Space VFS sequence: `30`
- SHA-256: `86ebfad9cea57ba4bcf0163f18e7146d03375d23ec6ac0af5d8b336b68cdd371`
- Byte length: `5955`
- Verdict: `PASS — v7.4 is acceptable for exact-digest human design acceptance,
  but implementation is STOPPED.`

The stop was cleared only after the following temporary `npx` probe exited `0`
on 2026-09-20. It was rerun from the reviewed worktree before publication:

```powershell
npx --yes node@26.8.1 --input-type=module -e "import { DatabaseSync } from 'node:sqlite'; import { mkdtempSync, rmSync } from 'node:fs'; import { join } from 'node:path'; import { tmpdir } from 'node:os'; const dir=mkdtempSync(join(tmpdir(),'gaia76-node-sqlite-')); try { const db=new DatabaseSync(join(dir,'probe.sqlite')); const mode=db.prepare('PRAGMA journal_mode=WAL').get().journal_mode; db.exec('CREATE TABLE probe(value INTEGER NOT NULL); BEGIN IMMEDIATE; INSERT INTO probe(value) VALUES (1); COMMIT;'); const value=db.prepare('SELECT value FROM probe').get().value; db.close(); console.log(JSON.stringify({node:process.version,nodeSqlite:true,journalMode:mode,beginImmediateCommitted:value})); } finally { rmSync(dir,{recursive:true,force:true}); }"
```

```text
{"node":"v26.8.1","nodeSqlite":true,"journalMode":"wal","beginImmediateCommitted":1}
```

No system installation or repository dependency was added. The implementation
snapshot and Demerzel consumer revision are recorded below only after their
respective commits exist; until then this receipt is not publication evidence.

## Authorized implementation boundary

- one Gaia Node.js ESM continuity controller and SQLite WAL store;
- one bounded BusEvidencePort using the existing event-log lock and `send`
  transition, without adding a public bus verb;
- one ecosystem-neutral JSON Schema with bounded fixtures;
- one read-only Demerzel Python contract test;
- tests and exact-snapshot independent review.

Redis, Kubernetes, a new broker, a new npm dependency, provider launch, automatic
merge, deployment, paid API use, and authority-bearing effects remain outside the
accepted boundary.

## Platform-bounded publication guarantee

The event log and bus-instance sidecar always flush complete file contents before
delivery evidence is accepted, and an exact retry repeats the publication barrier.
On POSIX, the barrier also fsyncs the containing directory. Node.js does not expose
a reliable dependency-free directory fsync on Windows, so the Windows path reopens
and fsyncs the published file twice. This is the strongest portable synchronous
protocol available within the accepted no-dependency boundary; it is explicitly
not evidence of Windows directory-entry durability across sudden power loss. A
stronger Windows guarantee remains a platform constraint requiring a native helper,
dependency, or different durable substrate and is not claimed by this R0 tracer.
