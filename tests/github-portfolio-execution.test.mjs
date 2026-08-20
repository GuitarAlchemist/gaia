import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';

import {
  PortfolioExecutionError,
  createAgentFactoryExecutionAdapter,
} from '../src/github-portfolio-execution.mjs';

test('the execution adapter binds one repository, worktree, task, and evidence directory', async () => {
  const evidenceRoot = mkdtempSync(join(tmpdir(), 'gaia-portfolio-execution-'));
  const calls = [];
  const executeFactory = async (request) => {
    calls.push(request);
    return {
      schema: 'gaia-agent-factory-receipt/1', status: 'completed', task: request.task,
    };
  };
  const adapter = createAgentFactoryExecutionAdapter({
    expectedRepository: 'GuitarAlchemist/ga',
    worktree: 'C:\\tmp\\gaia-linked-worktree',
    evidenceRoot,
    executeFactory,
    runWorker: async () => {},
    runReviewer: async () => {},
  });
  const intent = {
    action: 'RUN_FACTORY_AGENT', repository: 'GuitarAlchemist/ga',
    task: 'Resolve GuitarAlchemist/ga#1: Repair the canonical chatbot',
  };

  try {
    const receipt = await adapter.execute({ intent, idempotencyKey: 'a'.repeat(64) });
    assert.equal(receipt.status, 'completed');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].worktree, 'C:\\tmp\\gaia-linked-worktree');
    assert.equal(calls[0].evidenceDir, join(evidenceRoot, 'a'.repeat(64)));
    assert.equal(calls[0].task, intent.task);
    await assert.rejects(adapter.execute({
      intent: { ...intent, repository: 'GuitarAlchemist/ix' },
      idempotencyKey: 'b'.repeat(64),
    }), (error) => error instanceof PortfolioExecutionError
      && error.code === 'RepositoryScopeMismatch');
    assert.equal(calls.length, 1);
  } finally {
    rmSync(evidenceRoot, { recursive: true, force: true });
  }
});
