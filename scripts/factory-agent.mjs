#!/usr/bin/env node
/**
 * Run one real subscription-backed worker, at most one repair, and independent reviews.
 * The caller supplies an already-created clean linked Git worktree. The primary
 * checkout is never accepted and this command never commits, pushes, or merges.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  assertPhysicalOutsideWorktree,
  executeAgentFactory,
  FactoryAgentError,
  runClaudeRepair,
  runClaudeWorker,
  runCodexReviewer,
  runPiWorker,
  runPiReviewer,
} from '../src/factory-agent.mjs';
import { createCliProgress, instrumentFactoryAdapters } from '../src/cli-progress.mjs';
import {
  createFactoryTracer,
  createLoopbackOtlpTraceSink,
  instrumentFactoryTraceAdapters,
} from '../src/factory-tracing.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new UsageError('expected --worktree <path> --task <text> --out <path>');
    }
    const key = name.slice(2);
    if (key === 'allow-write') {
      flags[key] ??= [];
      flags[key].push(value);
    } else {
      flags[key] = value;
    }
  }
  for (const required of ['worktree', 'task', 'out']) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  if (flags.worker && !['claude', 'pi'].includes(flags.worker)) {
    throw new UsageError('--worker must be claude or pi');
  }
  if (flags.worker === 'pi' && !flags['allow-write']?.length) {
    throw new UsageError('--worker pi requires at least one --allow-write path');
  }
  if (flags.worker !== 'pi' && flags['allow-write']?.length) {
    throw new UsageError('--allow-write is available only with --worker pi');
  }
  if (flags.reviewer && !['codex', 'pi'].includes(flags.reviewer)) {
    throw new UsageError('--reviewer must be codex or pi');
  }
  const progressFormat = flags['progress-format'] ?? 'human';
  if (!['human', 'jsonl'].includes(progressFormat)) {
    throw new UsageError('--progress-format must be human or jsonl');
  }
  const timeoutMs = flags['timeout-ms'] === undefined ? 10 * 60_000 : Number(flags['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 30 * 60_000) {
    throw new UsageError('--timeout-ms must be an integer from 1000 through 1800000');
  }
  return { ...flags, timeoutMs, progressFormat };
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

export async function runFactoryAgentCli(argv, {
  executeFactory = executeAgentFactory,
  runWorker = runClaudeWorker,
  runPiWrite = runPiWorker,
  runReviewer = runCodexReviewer,
  runPiReview = runPiReviewer,
  runRepair = runClaudeRepair,
  writeStdout = (chunk) => process.stdout.write(chunk),
  writeProgress = (chunk) => process.stderr.write(chunk),
  nowMs = () => Date.now(),
  progressScheduler,
  heartbeatIntervalMs = 10_000,
  createTraceSink = createLoopbackOtlpTraceSink,
} = {}) {
  const flags = parseArgs(argv);
  const progress = createCliProgress({
    timeoutMs: flags.timeoutMs,
    format: flags.progressFormat,
    write: writeProgress,
    nowMs,
    scheduler: progressScheduler,
    heartbeatIntervalMs,
  });
  progress.validating();
  const worktree = resolve(flags.worktree);
  const output = resolve(flags.out);
  const evidenceDir = `${output}.evidence`;
  const allowedWritePaths = flags['allow-write'] ?? [];
  const workerProfile = flags.worker === 'pi'
    ? 'pi-openai-codex-subscription-bounded-writer'
    : 'claude-subscription';
  const repairProfile = flags.worker === 'pi'
    ? 'disabled-for-pi-writer-v0'
    : 'claude-subscription-bounded-once';
  const reviewerProfile = flags.reviewer === 'pi'
    ? 'pi-openai-codex-subscription-read-only'
    : 'codex-subscription-read-only';
  const selectedReviewer = flags.reviewer === 'pi' ? runPiReview : runReviewer;
  const selectedWorker = flags.worker === 'pi'
    ? (context, options) => runPiWrite({
      ...context,
      allowedPaths: allowedWritePaths,
      baseline: { head: context.baseHead },
    }, options)
    : runWorker;
  const selectedRepair = flags.worker === 'pi' ? undefined : runRepair;
  let traceSink;
  try {
    traceSink = flags['otel-endpoint']
      ? createTraceSink({ endpoint: flags['otel-endpoint'] })
      : undefined;
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
      worker: workerProfile,
      allowedWritePaths,
      reviewer: reviewerProfile,
      repair: repairProfile,
      worktreeRole: 'caller-supplied-linked-worktree',
      evidenceStore: evidenceDir,
    }), { encoding: 'utf8', flag: 'wx' });
  } catch (error) {
    progress.terminalOutcome('FAILED');
    throw error;
  }

  try {
    progress.executionStarting();
    const progressAdapters = instrumentFactoryAdapters({
      runWorker: (context) => selectedWorker(context, { timeoutMs: flags.timeoutMs }),
      runReviewer: (context) => selectedReviewer(context, { timeoutMs: flags.timeoutMs }),
      runRepair: selectedRepair === undefined
        ? undefined
        : (context) => selectedRepair(context, { timeoutMs: flags.timeoutMs }),
      progress,
    });
    const tracer = createFactoryTracer({ sink: traceSink });
    const receipt = await tracer.span('gaia.factory.cycle', {
      'gaia.phase': 'cycle',
    }, async (cycleTracer) => {
      const adapters = instrumentFactoryTraceAdapters({
        ...progressAdapters,
        tracer: cycleTracer,
      });
      return executeFactory({
        worktree,
        evidenceDir,
        task: flags.task,
        ...adapters,
      });
    });
    const completed = serialize({
      schema: 'gaia-agent-factory-run/1',
      status: receipt.status,
      workerProfile,
      allowedWritePaths,
      reviewerProfile,
      repairProfile,
      result: receipt,
    });
    writeFileSync(output, completed, 'utf8');
    writeStdout(completed);
    progress.terminalOutcome(receipt.status === 'completed'
      ? 'COMPLETED'
      : receipt.status === 'rejected' ? 'REJECTED' : 'UNKNOWN');
    if (receipt.status === 'rejected') process.exitCode = 3;
    return receipt;
  } catch (error) {
    progress.terminalOutcome('FAILED');
    const failed = serialize({
      schema: 'gaia-agent-factory-run/1',
      status: 'failed',
      workerProfile,
      allowedWritePaths,
      reviewerProfile,
      repairProfile,
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

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  try {
    await runFactoryAgentCli(process.argv.slice(2));
  } catch (error) {
    const suffix = error.receiptPath ? `; failure receipt: ${error.receiptPath}` : '';
    process.stderr.write(`${error.name}: ${error.message}${suffix}\n`);
    process.exitCode = error instanceof UsageError ? 2 : error instanceof FactoryAgentError ? 3 : 1;
  }
}
