/** One production PR review-thread reconciliation tick. No daemon, merge, push or config effect. */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { synchronizePrReviewThreadDuckDb } from '../src/duckdb-pr-review-thread-telemetry.mjs';
import { createGitGhPrReviewThreadEffects } from '../src/git-gh-pr-review-thread-effects.mjs';
import { createFileEd25519AuthorityAdapter } from '../src/github-portfolio-authority.mjs';
import { createAgentFactoryExecutionAdapter } from '../src/github-portfolio-execution.mjs';
import {
  createBoundedRepairLaneEffects,
  runPrReviewThreadSupervisorTick,
} from '../src/pr-review-thread-supervisor.mjs';

class UsageError extends Error {}

function flags(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    if (!name?.startsWith('--') || argv[index + 1] === undefined) {
      throw new UsageError('expected paired --name value arguments');
    }
    result[name.slice(2)] = argv[index + 1];
  }
  for (const name of [
    'repository', 'pull-request', 'state-dir', 'worktree', 'evidence-root', 'database',
    'public-key', 'authority-ledger', 'grant', 'gate-out',
  ]) {
    if (!result[name]) throw new UsageError(`missing --${name}`);
  }
  return result;
}

const readJson = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));

export function createDisputeEvidenceReader(path) {
  if (!path) return async () => 'UNKNOWN';
  const artifactPath = resolve(path);
  return async ({ repository, pullRequest, reviewThreadId, observedAt, sourceRevision }) => {
    const artifact = readJson(artifactPath);
    if (artifact?.schema !== 'gaia-pr-review-thread-dispute-evidence/1'
        || artifact.repository !== repository || artifact.pullRequest !== pullRequest
        || artifact.reviewThreadId !== reviewThreadId
        || artifact.sourceRevision !== sourceRevision
        || ![true, false].includes(artifact.disputed)
        || typeof artifact.observedAt !== 'string'
        || new Date(artifact.observedAt).toISOString() !== artifact.observedAt
        || Date.parse(artifact.observedAt) > Date.parse(observedAt)) {
      return 'UNKNOWN';
    }
    return artifact.disputed;
  };
}

export async function runPrReviewThreadSupervisorCli(argv, {
  createGithub = createGitGhPrReviewThreadEffects,
  createExecution = createAgentFactoryExecutionAdapter,
  createAuthority = createFileEd25519AuthorityAdapter,
  synchronize = synchronizePrReviewThreadDuckDb,
  now = () => new Date(),
  writeStdout = (value) => process.stdout.write(value),
} = {}) {
  const args = flags(argv);
  const pullRequest = Number(args['pull-request']);
  if (!Number.isSafeInteger(pullRequest) || pullRequest < 1) {
    throw new UsageError('--pull-request must be a positive integer');
  }
  const directory = resolve(args['state-dir']);
  const execution = createExecution({
    expectedRepository: args.repository,
    worktree: resolve(args.worktree),
    evidenceRoot: resolve(args['evidence-root']),
  });
  const result = await runPrReviewThreadSupervisorTick({
    directory,
    repository: args.repository,
    pullRequest,
    github: createGithub({
      readDisputeEvidence: createDisputeEvidenceReader(args['dispute-evidence']),
    }),
    lanes: createBoundedRepairLaneEffects({ execution }),
    authority: createAuthority({
      publicKey: readFileSync(resolve(args['public-key']), 'utf8'),
      ledgerDir: resolve(args['authority-ledger']),
      now,
    }),
    grant: readJson(args.grant),
    now,
    synchronizeTelemetry: () => synchronize({
      directory,
      telemetryDirectory: directory,
      databasePath: resolve(args.database),
    }),
  });
  writeFileSync(resolve(args['gate-out']), `${JSON.stringify(result.gate, null, 2)}\n`, {
    flag: 'w', encoding: 'utf8',
  });
  writeStdout(`${JSON.stringify({
    schema: result.schema,
    gate: result.gate,
    telemetry: result.telemetry,
  })}\n`);
  return result.gate.blocksMerge ? 3 : 0;
}

const direct = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  runPrReviewThreadSupervisorCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error?.message ?? 'review-thread supervisor failed'}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
