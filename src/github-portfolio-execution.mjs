import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  executeAgentFactory,
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

export function createAgentFactoryExecutionAdapter({
  expectedRepository,
  worktree,
  evidenceRoot,
  executeFactory = executeAgentFactory,
  runWorker = runClaudeWorker,
  runReviewer = runCodexReviewer,
}) {
  const repository = canonicalText(expectedRepository, 'expectedRepository');
  const candidateWorktree = resolve(canonicalText(worktree, 'worktree'));
  if (typeof executeFactory !== 'function' || typeof runWorker !== 'function'
      || typeof runReviewer !== 'function') {
    throw new PortfolioExecutionError('InvalidAdapter', 'factory, worker, and reviewer must be functions');
  }
  const evidenceMetadata = lstatSync(evidenceRoot);
  if (!evidenceMetadata.isDirectory() || evidenceMetadata.isSymbolicLink()) {
    throw new PortfolioExecutionError(
      'InvalidEvidenceRoot', 'evidenceRoot must be a real existing directory',
    );
  }
  const physicalEvidenceRoot = realpathSync.native(evidenceRoot);

  return Object.freeze({
    async execute({ intent, idempotencyKey }) {
      if (!intent || intent.action !== 'RUN_FACTORY_AGENT') {
        throw new PortfolioExecutionError('InvalidIntent', 'only RUN_FACTORY_AGENT is supported');
      }
      if (intent.repository !== repository) {
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
      return executeFactory({
        worktree: candidateWorktree,
        evidenceDir: join(physicalEvidenceRoot, idempotencyKey),
        task,
        runWorker,
        runReviewer,
      });
    },
  });
}
