import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { isAutonomousRepository } from './autonomous-factory-contract.mjs';
import {
  executeAgentFactory,
  runClaudeRepair,
  runClaudeWorker,
  runCodexReviewer,
} from './factory-agent.mjs';

export class PortfolioExecutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortfolioExecutionError';
    this.code = code;
  }
}

function canonicalText(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new PortfolioExecutionError('InvalidExecution', `${field} must be canonical text`);
  }
  return value;
}

const SHA256 = /^[a-f0-9]{64}$/u;
const RECEIPT_KEYS = [
  'addressedCommentIds', 'expectedRevision', 'factory', 'idempotencyKey', 'intentDigest',
  'operationIdentity', 'schema',
].sort();

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function receiptBinding(intent, idempotencyKey) {
  const evidence = intent?.reviewThreadEvidence ?? null;
  return {
    operationIdentity: digest({
      kind: 'RUN_FACTORY_AGENT', threadIdentity: evidence?.threadIdentity ?? null,
      idempotencyKey,
    }),
    idempotencyKey,
    intentDigest: digest(intent),
    expectedRevision: evidence?.sourceRevision ?? null,
  };
}

function measuredAddressedCommentIds(intent, factory) {
  const evidence = intent?.reviewThreadEvidence;
  const changed = factory?.changeSet?.files;
  if (!evidence || !Array.isArray(evidence.addressedCommentIds)
      || !Array.isArray(changed)
      || !changed.some(({ path }) => path === evidence.anchorPath)) return [];
  return [...new Set(evidence.addressedCommentIds)].sort();
}

function readBoundReceipt(path, { intent, idempotencyKey }) {
  let receipt;
  try { receipt = JSON.parse(readFileSync(path, 'utf8')); } catch {
    throw new PortfolioExecutionError('CorruptExecutionReceipt', 'factory receipt is not JSON');
  }
  const keys = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
    ? Object.keys(receipt).sort() : [];
  if (JSON.stringify(keys) !== JSON.stringify(RECEIPT_KEYS)
      || receipt.schema !== 'gaia-portfolio-execution-receipt/2'
      || receipt.factory?.schema !== 'gaia-agent-factory-receipt/1'
      || !SHA256.test(receipt.operationIdentity)
      || receipt.idempotencyKey !== idempotencyKey
      || !SHA256.test(receipt.intentDigest)
      || (receipt.expectedRevision !== null && !SHA256.test(receipt.expectedRevision))
      || !Array.isArray(receipt.addressedCommentIds)
      || receipt.addressedCommentIds.some((id) => typeof id !== 'string')) {
    throw new PortfolioExecutionError('CorruptExecutionReceipt', 'factory receipt is not canonical');
  }
  if (intent !== undefined) {
    const expected = receiptBinding(intent, idempotencyKey);
    if (receipt.operationIdentity !== expected.operationIdentity
        || receipt.intentDigest !== expected.intentDigest
        || receipt.expectedRevision !== expected.expectedRevision) {
      throw new PortfolioExecutionError(
        'ExecutionReceiptMismatch', 'factory receipt does not bind the expected operation revision',
      );
    }
  }
  return receipt;
}

function receiptDurabilityUncertain() {
  return new PortfolioExecutionError(
    'ExecutionReceiptDurabilityUncertain',
    'factory receipt publication durability is uncertain',
  );
}

function synchronizeReceiptPublication(path, evidenceDirectory, evidenceRoot) {
  // Node does not expose a portable Windows directory-fsync handle. Reopening the receipt writable
  // and flushing it is the strongest per-entry metadata barrier available there; POSIX flushes both
  // directories whose new names must survive before terminal authority may consume this receipt.
  const targets = process.platform === 'win32'
    ? [[path, 'r+']]
    : [[evidenceDirectory, 'r'], [evidenceRoot, 'r']];
  for (const [target, flags] of targets) {
    let descriptor;
    try {
      descriptor = openSync(target, flags);
      fsyncSync(descriptor);
      closeSync(descriptor);
      descriptor = undefined;
    } catch {
      try { if (descriptor !== undefined) closeSync(descriptor); } catch { /* Keep typed refusal. */ }
      throw receiptDurabilityUncertain();
    }
  }
}

function writeDurableExclusive(path, value, { evidenceDirectory, evidenceRoot }) {
  let descriptor;
  try {
    descriptor = openSync(path, 'wx', 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value)}\n`, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
  } catch {
    try { if (descriptor !== undefined) closeSync(descriptor); } catch { /* Keep typed refusal. */ }
    throw receiptDurabilityUncertain();
  }
  synchronizeReceiptPublication(path, evidenceDirectory, evidenceRoot);
}

function readDurablyPublishedReceipt(path, binding, evidenceDirectory, evidenceRoot) {
  const receipt = readBoundReceipt(path, binding);
  // A complete receipt can remain after an earlier publication barrier failed. Reconciliation must
  // retry that barrier before consuming the receipt, never rerun the provider or assume durability.
  synchronizeReceiptPublication(path, evidenceDirectory, evidenceRoot);
  return receipt;
}

// The only two shapes a github.com remote takes: a URL with a scheme, and the scp-like
// form. Both may carry credentials, a port, and a `.git` suffix; neither is trusted for
// anything except the owner/name it denotes.
const REMOTE_FORMS = [
  /^(?:https?|ssh|git):\/\/(?:[^@/]*@)?github\.com(?::\d+)?\/(.+)$/u,
  /^(?:[^@/:]+@)?github\.com:(.+)$/u,
];

function canonicalRepository(value, field) {
  const text = canonicalText(value, field);
  if (!isAutonomousRepository(text)) {
    throw new PortfolioExecutionError('InvalidExecution', `${field} must be owner/name`);
  }
  return text;
}

// Explicit normalization, applied in this order: one trailing slash run, then one `.git`
// suffix, then a strict owner/name shape. Anything that does not survive all three is
// unrecognized rather than guessed at.
function normalizeRemoteIdentity(url) {
  const trimmed = url.trim();
  for (const form of REMOTE_FORMS) {
    const match = form.exec(trimmed);
    if (!match) continue;
    const path = match[1].replace(/\/+$/u, '').replace(/\.git$/u, '');
    if (isAutonomousRepository(path)) return path;
  }
  return null;
}

// Measures what the checkout says it is, rather than restating what the caller expected.
// No error raised here may contain the remote URL itself: a fetch URL routinely carries
// a credential.
function measureRepositoryIdentity(worktree) {
  let remote;
  try {
    remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: worktree, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw new PortfolioExecutionError(
      'RepositoryIdentityUnavailable',
      'the linked worktree reports no Git origin remote to identify it by',
    );
  }
  const identity = normalizeRemoteIdentity(remote);
  if (identity === null) {
    throw new PortfolioExecutionError(
      'RepositoryIdentityUnrecognized',
      'the origin remote is not a recognizable github.com owner/name',
    );
  }
  return identity;
}

function physicalDirectory(supplied, field, code) {
  let metadata;
  try {
    metadata = lstatSync(supplied);
  } catch {
    throw new PortfolioExecutionError(code, `${field} must be a real existing directory`);
  }
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PortfolioExecutionError(code, `${field} must be a real existing directory`);
  }
  // realpath, not resolve: on Windows a caller-supplied 8.3 short path resolves to itself
  // and would produce a second spelling of the same directory.
  return realpathSync.native(supplied);
}

export function createAgentFactoryExecutionAdapter({
  expectedRepository,
  worktree,
  evidenceRoot,
  executeFactory = executeAgentFactory,
  runWorker = runClaudeWorker,
  runReviewer = runCodexReviewer,
  runRepair = runClaudeRepair,
  runVerification,
}) {
  const repository = canonicalRepository(expectedRepository, 'expectedRepository');
  const suppliedWorktree = resolve(canonicalText(worktree, 'worktree'));
  if (typeof executeFactory !== 'function' || typeof runWorker !== 'function'
      || typeof runReviewer !== 'function' || typeof runRepair !== 'function'
      || (runVerification !== undefined && typeof runVerification !== 'function')) {
    throw new PortfolioExecutionError(
      'InvalidAdapter', 'factory, worker, repair, and reviewer must be functions',
    );
  }
  const physicalEvidenceRoot = physicalDirectory(
    evidenceRoot, 'evidenceRoot', 'InvalidEvidenceRoot',
  );
  const candidateWorktree = physicalDirectory(suppliedWorktree, 'worktree', 'InvalidWorktree');
  const measuredRepository = measureRepositoryIdentity(candidateWorktree);
  // GitHub owner and repository names are case-insensitive, so the comparison is too.
  if (measuredRepository.toLowerCase() !== repository.toLowerCase()) {
    throw new PortfolioExecutionError(
      'RepositoryIdentityMismatch',
      `the linked worktree belongs to ${measuredRepository}, not ${repository}`,
    );
  }

  return Object.freeze({
    async findReceipt({ idempotencyKey, intent }) {
      if (typeof idempotencyKey !== 'string' || !/^[a-f0-9]{64}$/u.test(idempotencyKey)) {
        throw new PortfolioExecutionError(
          'InvalidIdempotencyKey', 'idempotencyKey must be a lowercase SHA-256',
        );
      }
      const evidenceDirectory = join(physicalEvidenceRoot, idempotencyKey);
      const path = join(evidenceDirectory, 'receipt.json');
      if (!existsSync(path)) return null;
      const receipt = readDurablyPublishedReceipt(path, { intent, idempotencyKey },
        evidenceDirectory, physicalEvidenceRoot);
      // Review-thread execution exposes its measured projection to the lane reconciler. Ordinary
      // factory callers receive the exact producer receipt rather than an augmented third form.
      return intent !== undefined && intent?.reviewThreadEvidence === undefined
        ? receipt.factory : { ...receipt.factory, addressedCommentIds: receipt.addressedCommentIds };
    },
    async execute({ intent, idempotencyKey }) {
      if (!intent || intent.action !== 'RUN_FACTORY_AGENT') {
        throw new PortfolioExecutionError('InvalidIntent', 'only RUN_FACTORY_AGENT is supported');
      }
      if (typeof intent.repository !== 'string'
          || intent.repository.toLowerCase() !== repository.toLowerCase()) {
        throw new PortfolioExecutionError(
          'RepositoryScopeMismatch', 'intent repository does not match this execution adapter',
        );
      }
      const task = canonicalText(intent.task, 'intent.task');
      if (typeof idempotencyKey !== 'string' || !/^[a-f0-9]{64}$/u.test(idempotencyKey)) {
        throw new PortfolioExecutionError(
          'InvalidIdempotencyKey', 'idempotencyKey must be a lowercase SHA-256',
        );
      }
      const evidenceDirectory = join(physicalEvidenceRoot, idempotencyKey);
      const existingReceiptPath = join(evidenceDirectory, 'receipt.json');
      if (existsSync(existingReceiptPath)) {
        const existing = readDurablyPublishedReceipt(existingReceiptPath,
          { intent, idempotencyKey }, evidenceDirectory, physicalEvidenceRoot);
        return existing.factory;
      }
      const persistReceipt = async (factory) => {
        mkdirSync(evidenceDirectory, { recursive: true });
        if (!existsSync(existingReceiptPath)) {
          writeDurableExclusive(existingReceiptPath, {
            schema: 'gaia-portfolio-execution-receipt/2',
            ...receiptBinding(intent, idempotencyKey),
            factory,
            addressedCommentIds: measuredAddressedCommentIds(intent, factory),
          }, { evidenceDirectory, evidenceRoot: physicalEvidenceRoot });
          return readBoundReceipt(existingReceiptPath, { intent, idempotencyKey });
        }
        return readDurablyPublishedReceipt(existingReceiptPath,
          { intent, idempotencyKey }, evidenceDirectory, physicalEvidenceRoot);
      };
      const receipt = await executeFactory({
        worktree: candidateWorktree,
        evidenceDir: join(physicalEvidenceRoot, idempotencyKey),
        task,
        runWorker,
        runReviewer,
        runRepair,
        ...(runVerification ? { runVerification } : {}),
        persistReceipt,
      });
      // The authoritative factory can commit through `persistReceipt` before returning. Keep the
      // fallback for older injected factories, but reconciliation always reads the same binding.
      await persistReceipt(receipt);
      return receipt;
    },
  });
}
