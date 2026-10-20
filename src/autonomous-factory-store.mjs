import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AutonomousFactoryContractError as AutonomousFactoryStoreError,
  autonomousJobKey,
  autonomousPublicationOperationId as publicationOperationId,
  canonicalAutonomousJson as encode,
  isAutonomousDigest as digest,
  isAutonomousRepository as repositoryName,
  validateAutonomousIntent as validateIntent,
  validateAutonomousJob as validateJob,
  validateAutonomousPublication as validatePublication,
  validateAutonomousReceipt as validateReceipt,
} from './autonomous-factory-contract.mjs';

export { AutonomousFactoryContractError as AutonomousFactoryStoreError,
  autonomousJobKey } from './autonomous-factory-contract.mjs';

// One trusted OS user, one real local disk. These checks reject static symlinks;
// they are not an OS sandbox, protection against the owner replacing files, or
// cross-host fencing. Keep this authority database outside worker worktrees.
const fail = code => { throw new AutonomousFactoryStoreError(code); };
const sha256 = value => createHash('sha256').update(value).digest('hex');

// Development ledgers created before repository identity was folded retain their captured keys and
// evidence paths. They are accepted only under the exact legacy recipe and are aliased by the new
// durable key; new admissions can never mint a legacy key.
function validateStoredJob(row) {
  const intent = validateIntent(JSON.parse(row.intent_json));
  const currentKey = autonomousJobKey(intent);
  const legacyKey = sha256(encode({ repository: intent.repository, itemId: intent.itemId,
    draftNumber: intent.draft.number }, 'StoreCorrupt'));
  if (![currentKey, legacyKey].includes(row.job_key)
    || row.idempotency_key !== sha256(encode({ grantId: row.job_key,
      intentRevision: intent.intentRevision }, 'StoreCorrupt'))) fail('StoreCorrupt');
  return { jobKey: row.job_key, intent, idempotencyKey: row.idempotency_key };
}
const matchesJobKey = (job, jobKey) => job.jobKey === jobKey
  || autonomousJobKey(job.intent) === jobKey;

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
        const job = validateStoredJob(row);
        if (!policy || job.intent.repository.toLowerCase() !== policy.repository.toLowerCase()
          || row.repository !== job.intent.repository
          || row.item_id !== job.intent.itemId || row.draft_number !== job.intent.draft.number
          || !['STARTED', 'COMPLETED'].includes(row.state)
          || (row.state === 'STARTED' ? row.receipt_json !== null : typeof row.receipt_json !== 'string')) fail('StoreCorrupt');
        const receipt = row.receipt_json === null ? null : JSON.parse(row.receipt_json);
        if (receipt !== null) validateReceipt(receipt, job);
        return { ...job, state: row.state, receipt };
      });
      // A publication spends one unit of the same lifetime budget as a run (#236).
      const publications = db.prepare('SELECT * FROM autonomous_publications ORDER BY rowid').all().map(row => {
        const job = jobs.find(item => item.jobKey === row.job_key);
        if (!job) fail('StoreCorrupt');
        return validatePublication({ jobKey: row.job_key, operationId: row.operation_id,
          intent: JSON.parse(row.intent_json), state: row.state,
          receipt: row.receipt_json === null ? null : JSON.parse(row.receipt_json) }, job, 'StoreCorrupt');
      });
      if (jobs.length + publications.length > (policy?.max_runs ?? 0)
        || jobs.filter(job => job.state === 'STARTED').length > 1) fail('StoreCorrupt');
      return { policy, jobs, publications };
    } catch { fail('StoreCorrupt'); }
  }
  function projection({ policy, jobs, publications }) {
    return { configured: policy !== null, enabled: policy?.enabled === 1,
      repository: policy?.repository ?? null, maxRuns: policy?.max_runs ?? null,
      usedRuns: jobs.length + publications.length,
      activeJobKey: jobs.find(job => job.state === 'STARTED')?.jobKey ?? null, jobs,
      publications: publications.map(({ jobKey, operationId, state, receipt }) => ({ jobKey, operationId, state, receipt })) };
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
          job_key TEXT PRIMARY KEY, repository TEXT NOT NULL COLLATE NOCASE, item_id TEXT NOT NULL,
          draft_number INTEGER NOT NULL, intent_json TEXT NOT NULL, idempotency_key TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('STARTED','COMPLETED')), receipt_json TEXT,
          UNIQUE(repository,item_id,draft_number),
          CHECK((state='STARTED' AND receipt_json IS NULL) OR (state='COMPLETED' AND receipt_json IS NOT NULL))) STRICT;`);
      } else if (!['autonomous_jobs,autonomous_policy', 'autonomous_jobs,autonomous_policy,autonomous_publications']
        .includes(tables.map(table => table.name).sort().join(','))) fail('StoreCorrupt');
      // Additive for ledgers created before #236; a reader older than #236 refuses this table.
      db.exec(`CREATE TABLE IF NOT EXISTS autonomous_publications (
        job_key TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, intent_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('STARTED','COMPLETED')), receipt_json TEXT,
        CHECK((state='STARTED' AND receipt_json IS NULL) OR (state='COMPLETED' AND receipt_json IS NOT NULL))) STRICT`);
      // Adds the provider-identity constraint to development databases without rewriting captured
      // repository spelling, job keys, idempotency keys, receipts, or external evidence paths.
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS autonomous_jobs_repository_item_draft_nocase '
        + 'ON autonomous_jobs(repository COLLATE NOCASE,item_id,draft_number)');
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
      return transaction(() => readState().jobs.find(job => matchesJobKey(job, jobKey)) ?? null);
    },
    start(input) {
      const job = validateJob(input);
      return transaction(() => {
        const { policy, jobs, publications } = readState();
        if (!policy || !policy.enabled) fail('PolicyDisabled');
        if (job.intent.repository.toLowerCase() !== policy.repository.toLowerCase()) fail('RepositoryMismatch');
        if (jobs.some(existing => matchesJobKey(existing, job.jobKey))) fail('JobExists');
        if (jobs.some(existing => existing.state === 'STARTED')) fail('HostBusy');
        if (jobs.length + publications.length >= policy.max_runs) fail('BudgetExhausted');
        db.prepare("INSERT INTO autonomous_jobs VALUES (?,?,?,?,?,?,'STARTED',NULL)").run(
          job.jobKey, job.intent.repository, job.intent.itemId, job.intent.draft.number,
          encode(job.intent, 'InvalidIntent'), job.idempotencyKey);
        // The caller receives authority only after transaction() commits STARTED.
        return { status: 'AUTHORIZED', grantId: job.jobKey, intentRevision: job.intent.intentRevision };
      });
    },
    finish({ jobKey, receipt }) {
      if (!digest(jobKey)) fail('InvalidJob');
      if (receipt?.schema === 'gaia-autonomous-retirement/1') fail('OperatorActionRequired');
      return transaction(() => {
        const job = readState().jobs.find(item => matchesJobKey(item, jobKey));
        if (!job) fail('JobMissing');
        const serialized = validateReceipt(receipt, job);
        if (job.state === 'COMPLETED' && encode(job.receipt, 'StoreCorrupt') !== serialized) fail('ReceiptConflict');
        if (job.state === 'STARTED') db.prepare("UPDATE autonomous_jobs SET state='COMPLETED', receipt_json=? WHERE job_key=?")
          .run(serialized, job.jobKey);
        return { ...job, state: 'COMPLETED', receipt: JSON.parse(serialized) };
      });
    },
    publication(jobKey) {
      if (!digest(jobKey)) fail('InvalidJob');
      return transaction(() => {
        const { jobs, publications } = readState();
        const job = jobs.find(item => matchesJobKey(item, jobKey));
        return job ? publications.find(item => item.jobKey === job.jobKey) ?? null : null;
      });
    },
    // The publication's authority point (#236): policy, budget and one operation per job are
    // decided here, before any effect. A retry of the same operation re-checks the policy only.
    beginPublication({ jobKey, intent }) {
      if (!digest(jobKey)) fail('InvalidJob');
      return transaction(() => {
        const { policy, jobs, publications } = readState();
        if (!policy || !policy.enabled) fail('PolicyDisabled');
        const job = jobs.find(item => matchesJobKey(item, jobKey));
        if (!job) fail('JobMissing');
        if (job.state !== 'COMPLETED' || job.receipt?.status !== 'CANDIDATE_READY') fail('CandidateNotReady');
        const row = validatePublication({ jobKey: job.jobKey, intent, state: 'STARTED', receipt: null,
          operationId: publicationOperationId(job, intent?.revision) }, job);
        const existing = publications.find(item => item.jobKey === job.jobKey);
        if (existing) {
          if (existing.operationId !== row.operationId) fail('PublicationConflict');
          if (existing.state === 'COMPLETED') fail('PublicationCompleted');
          return { status: 'AUTHORIZED', operationId: row.operationId };
        }
        if (jobs.length + publications.length >= policy.max_runs) fail('BudgetExhausted');
        db.prepare("INSERT INTO autonomous_publications VALUES (?,?,?,'STARTED',NULL)").run(
          job.jobKey, row.operationId, encode(row.intent, 'InvalidPublication'));
        return { status: 'AUTHORIZED', operationId: row.operationId };
      });
    },
    // Records an observed push; it spends nothing, so a revoked policy still records it.
    finishPublication({ jobKey, receipt }) {
      if (!digest(jobKey)) fail('InvalidJob');
      return transaction(() => {
        const { jobs, publications } = readState();
        const job = jobs.find(item => matchesJobKey(item, jobKey));
        const existing = job && publications.find(item => item.jobKey === job.jobKey);
        if (!existing) fail('PublicationMissing');
        const completed = validatePublication({ ...existing, state: 'COMPLETED', receipt }, job);
        const serialized = encode(completed.receipt, 'InvalidPublication');
        if (existing.state === 'COMPLETED' && encode(existing.receipt, 'StoreCorrupt') !== serialized) fail('ReceiptConflict');
        if (existing.state === 'STARTED') db.prepare("UPDATE autonomous_publications SET state='COMPLETED', receipt_json=? WHERE job_key=?")
          .run(serialized, job.jobKey);
        return completed.receipt;
      });
    },
    // Explicit operator compensation, never called by normal watch/reconciliation.
    // It preserves consumed identity/budget and fences late conflicting completion.
    retireClosed({ jobKey, expectedIntentRevision, observation }) {
      if (!digest(jobKey) || !digest(expectedIntentRevision)) fail('InvalidJob');
      return transaction(() => {
        const job = readState().jobs.find(item => matchesJobKey(item, jobKey));
        if (!job) fail('JobMissing');
        if (job.intent.intentRevision !== expectedIntentRevision) fail('IntentChanged');
        const receipt = { schema: 'gaia-autonomous-retirement/1', status: 'ABANDONED',
          jobKey: job.jobKey, intentRevision: expectedIntentRevision,
          idempotencyKey: job.idempotencyKey, observation };
        const serialized = validateReceipt(receipt, job);
        if (job.state === 'COMPLETED' && encode(job.receipt, 'StoreCorrupt') !== serialized) fail('ReceiptConflict');
        if (job.state === 'STARTED') db.prepare("UPDATE autonomous_jobs SET state='COMPLETED', receipt_json=? WHERE job_key=?")
          .run(serialized, job.jobKey);
        return JSON.parse(serialized);
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  });
}
