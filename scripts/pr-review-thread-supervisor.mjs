/** Production PR review-thread reconciliation: one bounded tick or a serialized watch. */

import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync,
} from 'node:fs';
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
import { assertDistinctFiles } from '../src/path-identity.mjs';

class UsageError extends Error {}

export class GrantRegistryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GrantRegistryError';
    this.code = code;
  }
}

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

function splitWatchArgv(argv) {
  const tickArgv = [];
  let watchMs = null;
  for (let index = 0; index < argv.length; index += 2) {
    if (argv[index] === '--watch-ms') {
      watchMs = Number(argv[index + 1]);
    } else {
      tickArgv.push(argv[index], argv[index + 1]);
    }
  }
  if (watchMs !== null && (!Number.isSafeInteger(watchMs) || watchMs < 10_000 || watchMs > 300_000)) {
    throw new UsageError('--watch-ms must be an integer from 10000 through 300000');
  }
  return { tickArgv, watchMs };
}

const delay = (milliseconds, signal) => new Promise((resolvePromise) => {
  if (signal?.aborted) { resolvePromise(); return; }
  let handle;
  const done = () => {
    clearTimeout(handle); signal?.removeEventListener('abort', done); resolvePromise();
  };
  handle = setTimeout(done, milliseconds);
  signal?.addEventListener('abort', done, { once: true });
});

export function createGrantRegistryAcquirer(registry) {
  const grants = Array.isArray(registry) ? registry : [registry];
  return async (intent) => {
    const matches = grants.filter((grant) => grant
      && grant.intentRevision === intent.intentRevision
      && grant.action === intent.action
      && grant.repository === intent.repository
      && grant.itemKind === intent.itemKind
      && grant.itemId === intent.itemId
      && grant.itemNumber === intent.itemNumber
      && grant.snapshotRevision === intent.snapshotRevision);
    if (matches.length !== 1) {
      throw new UsageError('grant registry must contain exactly one grant for the exact effect intent');
    }
    return matches[0];
  };
}

function exactGrant(registry, intent) {
  const grants = Array.isArray(registry) ? registry : [registry];
  if (grants.some((grant) => !grant || typeof grant !== 'object' || Array.isArray(grant)
      || typeof grant.intentRevision !== 'string' || typeof grant.action !== 'string')) {
    throw new GrantRegistryError('GrantRegistryInvalid', 'grant registry contains a malformed grant');
  }
  const revisionMatches = grants.filter((grant) => grant.intentRevision === intent.intentRevision);
  const matches = grants.filter((grant) => grant
    && grant.intentRevision === intent.intentRevision
    && grant.action === intent.action
    && grant.repository === intent.repository
    && grant.itemKind === intent.itemKind
    && grant.itemId === intent.itemId
    && grant.itemNumber === intent.itemNumber
    && grant.snapshotRevision === intent.snapshotRevision);
  if (matches.length > 1) {
    throw new GrantRegistryError('GrantRegistryAmbiguous',
      'grant registry contains more than one grant for the exact effect intent');
  }
  if (revisionMatches.length > 0 && matches.length === 0) {
    throw new GrantRegistryError('GrantIntentMismatch',
      'a grant names this intent revision but mismatches its exact effect fields');
  }
  return matches[0] ?? null;
}

/** Persist the exact late-bound authority request, then re-read the registry on every tick. */
export function createLazyGrantRegistryAcquirer({ registryPath, requestDirectory }) {
  const path = resolve(registryPath);
  const requests = resolve(requestDirectory);
  mkdirSync(requests, { recursive: true });
  return async (intent) => {
    const request = {
      schema: 'gaia-pr-review-thread-grant-request/1',
      intentRevision: intent.intentRevision,
      action: intent.action,
      repository: intent.repository,
      itemKind: intent.itemKind,
      itemId: intent.itemId,
      itemNumber: intent.itemNumber,
      snapshotRevision: intent.snapshotRevision,
    };
    const requestPath = resolve(requests, `${intent.intentRevision}.json`);
    if (!existsSync(requestPath)) {
      let descriptor;
      try {
        descriptor = openSync(requestPath, 'wx', 0o600);
        writeFileSync(descriptor, `${JSON.stringify(request)}\n`, 'utf8');
        fsyncSync(descriptor);
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    }
    let durable;
    try { durable = readJson(requestPath); } catch {
      throw new GrantRegistryError('GrantRequestCorrupt', 'grant request is not closed JSON');
    }
    if (JSON.stringify(durable) !== JSON.stringify(request)) {
      throw new GrantRegistryError('GrantRequestMismatch',
        'durable grant request does not bind the exact effect intent');
    }
    let registry;
    try { registry = readJson(path); } catch {
      throw new GrantRegistryError('GrantRegistryInvalid', 'grant registry is not closed JSON');
    }
    const grant = exactGrant(registry, intent);
    if (grant === null) {
      throw new GrantRegistryError('WaitingAuthority',
        'the exact effect intent is durably waiting for a single-use grant');
    }
    return grant;
  };
}

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
  assertDistinctFiles({
    outputs: [resolve(args['gate-out'])],
    inputs: [
      resolve(args.grant), resolve(args['public-key']), resolve(args.database),
      resolve(args['state-dir']), resolve(args['authority-ledger']), resolve(args['evidence-root']),
      args['dispute-evidence'] ? resolve(args['dispute-evidence']) : null,
    ],
    refuse: (message) => { throw new UsageError(`gate output path identity refused: ${message}`); },
  });
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
    acquireGrant: createLazyGrantRegistryAcquirer({
      registryPath: resolve(args.grant),
      requestDirectory: resolve(directory, 'pr-review-thread-grant-requests'),
    }),
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

/** Sequential automatic invocation. The durable outboxes, not this scheduler, own correctness. */
export async function runPrReviewThreadSupervisorLoop(argv, {
  signal,
  wait = delay,
  runTick,
  consumeGate = async (gate) => {
    if (!gate || gate.schema !== 'gaia-pr-review-thread-merge-gate/1') {
      throw new UsageError('the supervisor published no closed merge gate for control-room consumption');
    }
  },
  ...dependencies
} = {}) {
  const { tickArgv, watchMs } = splitWatchArgv(argv);
  const tick = runTick ?? (async () => {
    const code = await runPrReviewThreadSupervisorCli(tickArgv, dependencies);
    const gatePath = flags(tickArgv)['gate-out'];
    return { code, gate: readJson(gatePath) };
  });
  let lastCode = 0;
  do {
    if (signal?.aborted) break;
    const result = await tick(tickArgv, dependencies);
    const gate = result?.gate ?? result;
    lastCode = Number.isSafeInteger(result?.code) ? result.code : (gate?.blocksMerge ? 3 : 0);
    await consumeGate(gate);
    if (watchMs === null || signal?.aborted) break;
    await wait(watchMs, signal);
  } while (!signal?.aborted);
  return watchMs === null ? lastCode : 0;
}

const direct = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (direct) {
  const controller = new AbortController();
  process.once('SIGINT', () => controller.abort());
  process.once('SIGTERM', () => controller.abort());
  runPrReviewThreadSupervisorLoop(process.argv.slice(2), { signal: controller.signal }).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error?.message ?? 'review-thread supervisor failed'}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  });
}
