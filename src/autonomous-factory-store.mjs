import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AutonomousFactoryContractError as AutonomousFactoryStoreError,
  canonicalAutonomousJson as encode,
  isAutonomousDigest as digest,
  isAutonomousRepository as repositoryName,
  validateAutonomousJob as validateJob,
  validateAutonomousReceipt as validateReceipt,
} from './autonomous-factory-contract.mjs';

export { AutonomousFactoryContractError as AutonomousFactoryStoreError,
  autonomousJobKey } from './autonomous-factory-contract.mjs';

// One trusted OS user, one real local disk. These checks reject static symlinks;
// they are not an OS sandbox, protection against the owner replacing files, or
// cross-host fencing. Keep this authority database outside worker worktrees.
const fail = code => { throw new AutonomousFactoryStoreError(code); };
function validatePath(input) {
  if (typeof input !== 'string' || !isAbsolute(input) || input.includes('\0')
    || /^[/\\]{2}/u.test(input)) fail('InvalidPath');
  const path = resolve(input);
  let cursor = path;
  try {
    for (;;) {
      let metadata;
      try { metadata = lstatSync(cursor); }
      catch (error) { if (cursor !== path || error.code !== 'ENOENT') throw error; }
      if (metadata && (metadata.isSymbolicLink() || (cursor === path ? !metadata.isFile() : !metadata.isDirectory()))) fail('InvalidPath');
      const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
    }
    for (const suffix of ['-journal', '-wal', '-shm']) {
      try { const metadata = lstatSync(path + suffix); if (!metadata.isFile() || metadata.isSymbolicLink()) fail('InvalidPath'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  } catch { fail('InvalidPath'); }
  return path;
}

export function openAutonomousFactoryStore({ path: inputPath }) {
  const path = validatePath(inputPath);
  let isNew = false;
  try { lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') fail('InvalidPath'); isNew = true; }
  let db;
  let closed = false;
  function transaction(operation) {
    if (closed) fail('StoreClosed');
    validatePath(path);
    try {
      db.exec('BEGIN IMMEDIATE');
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* The transaction may not have begun. */ }
      if (error instanceof AutonomousFactoryStoreError) throw error;
      fail(error.code === 'ERR_SQLITE_ERROR' && /locked|busy/iu.test(error.message) ? 'StoreBusy' : 'StoreCorrupt');
    }
  }
  function readState() {
    try {
      const policies = db.prepare('SELECT * FROM autonomous_policy').all();
      if (policies.length > 1) fail('StoreCorrupt');
      const policy = policies[0] ?? null;
      if (policy && (policy.id !== 1 || policy.version !== 1 || !repositoryName(policy.repository)
        || !Number.isSafeInteger(policy.max_runs) || policy.max_runs < 1 || policy.max_runs > 1000
        || ![0, 1].includes(policy.enabled))) fail('StoreCorrupt');
      const jobs = db.prepare('SELECT * FROM autonomous_jobs ORDER BY rowid').all().map(row => {
        const job = validateJob({ jobKey: row.job_key, intent: JSON.parse(row.intent_json), idempotencyKey: row.idempotency_key });
        if (!policy || job.intent.repository !== policy.repository || row.repository !== job.intent.repository
          || row.item_id !== job.intent.itemId || row.draft_number !== job.intent.draft.number
          || !['STARTED', 'COMPLETED'].includes(row.state)
          || (row.state === 'STARTED' ? row.receipt_json !== null : typeof row.receipt_json !== 'string')) fail('StoreCorrupt');
        const receipt = row.receipt_json === null ? null : JSON.parse(row.receipt_json);
        if (receipt !== null) validateReceipt(receipt, job);
        return { ...job, state: row.state, receipt };
      });
      if (jobs.length > (policy?.max_runs ?? 0) || jobs.filter(job => job.state === 'STARTED').length > 1) fail('StoreCorrupt');
      return { policy, jobs };
    } catch { fail('StoreCorrupt'); }
  }
  function projection({ policy, jobs }) {
    return { configured: policy !== null, enabled: policy?.enabled === 1,
      repository: policy?.repository ?? null, maxRuns: policy?.max_runs ?? null,
      usedRuns: jobs.length, activeJobKey: jobs.find(job => job.state === 'STARTED')?.jobKey ?? null, jobs };
  }
  try {
    db = new DatabaseSync(path);
    db.exec('PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; PRAGMA journal_mode=DELETE;');
    transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length === 0) {
        // A preexisting empty/erased ledger must not silently become fresh authority.
        if (!isNew) fail('StoreCorrupt');
        db.exec(`CREATE TABLE autonomous_policy (
          id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL CHECK(version=1),
          repository TEXT NOT NULL, max_runs INTEGER NOT NULL CHECK(max_runs BETWEEN 1 AND 1000),
          enabled INTEGER NOT NULL CHECK(enabled IN (0,1))) STRICT;
          CREATE TABLE autonomous_jobs (
          job_key TEXT PRIMARY KEY, repository TEXT NOT NULL, item_id TEXT NOT NULL,
          draft_number INTEGER NOT NULL, intent_json TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('STARTED','COMPLETED')), receipt_json TEXT,
          UNIQUE(repository,item_id,draft_number),
          CHECK((state='STARTED' AND receipt_json IS NULL) OR (state='COMPLETED' AND receipt_json IS NOT NULL))) STRICT;`);
      } else if (tables.map(table => table.name).sort().join(',') !== 'autonomous_jobs,autonomous_policy') fail('StoreCorrupt');
      readState();
    });
  } catch (error) {
    try { db?.close(); } catch { /* Preserve the original refusal. */ }
    if (error instanceof AutonomousFactoryStoreError) throw error;
    fail('StoreCorrupt');
  }
  return Object.freeze({
    configure({ repository, maxRuns }) {
      if (!repositoryName(repository) || !Number.isSafeInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) fail('InvalidPolicy');
      return transaction(() => {
        const state = readState(); if (state.policy) fail('PolicyExists');
        db.prepare('INSERT INTO autonomous_policy VALUES (1,1,?,?,1)').run(repository, maxRuns);
        return projection(readState());
      });
    },
    revoke() {
      return transaction(() => { readState(); db.exec('UPDATE autonomous_policy SET enabled=0 WHERE id=1'); return projection(readState()); });
    },
    status() { return transaction(() => projection(readState())); },
    get(jobKey) {
      if (!digest(jobKey)) fail('InvalidJob');
      return transaction(() => readState().jobs.find(job => job.jobKey === jobKey) ?? null);
    },
    start(input) {
      const job = validateJob(input);
      return transaction(() => {
        const { policy, jobs } = readState();
        if (!policy || !policy.enabled) fail('PolicyDisabled');
        if (job.intent.repository !== policy.repository) fail('RepositoryMismatch');
        if (jobs.some(existing => existing.jobKey === job.jobKey)) fail('JobExists');
        if (jobs.some(existing => existing.state === 'STARTED')) fail('HostBusy');
        if (jobs.length >= policy.max_runs) fail('BudgetExhausted');
        db.prepare("INSERT INTO autonomous_jobs VALUES (?,?,?,?,?,?,'STARTED',NULL)").run(
          job.jobKey, job.intent.repository, job.intent.itemId, job.intent.draft.number,
          encode(job.intent, 'InvalidIntent'), job.idempotencyKey);
        // The caller receives authority only after transaction() commits STARTED.
        return { status: 'AUTHORIZED', grantId: job.jobKey, intentRevision: job.intent.intentRevision };
      });
    },
    finish({ jobKey, receipt }) {
      if (!digest(jobKey)) fail('InvalidJob');
      return transaction(() => {
        const job = readState().jobs.find(item => item.jobKey === jobKey);
        if (!job) fail('JobMissing');
        const serialized = validateReceipt(receipt, job);
        if (job.state === 'COMPLETED' && encode(job.receipt, 'StoreCorrupt') !== serialized) fail('ReceiptConflict');
        if (job.state === 'STARTED') db.prepare("UPDATE autonomous_jobs SET state='COMPLETED', receipt_json=? WHERE job_key=?").run(serialized, jobKey);
        return { ...job, state: 'COMPLETED', receipt: JSON.parse(serialized) };
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
