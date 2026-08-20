#!/usr/bin/env node
/**
 * Run one real subscription-backed worker and one independent read-only reviewer.
 * The caller supplies an already-created clean linked Git worktree. The primary
 * checkout is never accepted and this command never commits, pushes, or merges.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

import {
  assertPhysicalOutsideWorktree,
  executeAgentFactory,
  FactoryAgentError,
  runClaudeWorker,
  runCodexReviewer,
} from '../src/factory-agent.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new UsageError('expected --worktree <path> --task <text> --out <path>');
    }
    flags[name.slice(2)] = value;
  }
  for (const required of ['worktree', 'task', 'out']) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  if (flags.worker && flags.worker !== 'claude') {
    throw new UsageError('v1 worker profile is exactly claude');
  }
  if (flags.reviewer && flags.reviewer !== 'codex') {
    throw new UsageError('v1 reviewer profile is exactly codex');
  }
  const timeoutMs = flags['timeout-ms'] === undefined ? 10 * 60_000 : Number(flags['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
    throw new UsageError('--timeout-ms must be an integer from 1000 through 1800000');
  }
  return { ...flags, timeoutMs };
}

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

function requirePhysicalOutside(worktree, candidate, label) {
  try {
    assertPhysicalOutsideWorktree(worktree, candidate, label);
  } catch (error) {
    if (error instanceof FactoryAgentError && error.code === 'PhysicalContainment') {
      throw new UsageError(error.message);
    }
    throw error;
  }
}

async function main(argv) {
  const flags = parseArgs(argv);
  const worktree = resolve(flags.worktree);
  const output = resolve(flags.out);
  const evidenceDir = `${output}.evidence`;
  if (existsSync(output)) throw new UsageError(`receipt already exists: ${output}`);
  if (inside(worktree, output)) {
    throw new UsageError('the receipt must be outside the candidate worktree');
  }

  requirePhysicalOutside(worktree, output, 'receipt');
  requirePhysicalOutside(worktree, evidenceDir, 'evidence directory');
  mkdirSync(dirname(output), { recursive: true });
  requirePhysicalOutside(worktree, output, 'receipt');
  writeFileSync(output, serialize({
    schema: 'gaia-agent-factory-run/1',
    status: 'running',
    worker: 'claude-subscription',
    reviewer: 'codex-subscription',
    worktreeRole: 'caller-supplied-linked-worktree',
    evidenceStore: evidenceDir,
  }), { encoding: 'utf8', flag: 'wx' });

  try {
    const receipt = await executeAgentFactory({
      worktree,
      evidenceDir,
      task: flags.task,
      runWorker: (context) => runClaudeWorker(context, { timeoutMs: flags.timeoutMs }),
      runReviewer: (context) => runCodexReviewer(context, { timeoutMs: flags.timeoutMs }),
    });
    const completed = serialize({
      schema: 'gaia-agent-factory-run/1',
      status: receipt.status,
      workerProfile: 'claude-subscription',
      reviewerProfile: 'codex-subscription-read-only',
      result: receipt,
    });
    writeFileSync(output, completed, 'utf8');
    process.stdout.write(completed);
    if (receipt.status === 'rejected') process.exitCode = 3;
  } catch (error) {
    const failed = serialize({
      schema: 'gaia-agent-factory-run/1',
      status: 'failed',
      workerProfile: 'claude-subscription',
      reviewerProfile: 'codex-subscription-read-only',
      error: {
        name: error.name,
        code: error.code ?? 'UnhandledFailure',
        message: error.message,
      },
    });
    writeFileSync(output, failed, 'utf8');
    error.receiptPath = output;
    throw error;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const suffix = error.receiptPath ? `; failure receipt: ${error.receiptPath}` : '';
  process.stderr.write(`${error.name}: ${error.message}${suffix}\n`);
  process.exitCode = error instanceof UsageError ? 2 : error instanceof FactoryAgentError ? 3 : 1;
}
