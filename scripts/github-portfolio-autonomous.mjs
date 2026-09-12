#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { openAutonomousFactoryStore } from '../src/autonomous-factory-store.mjs';
import { autonomousJobKey } from '../src/autonomous-factory-contract.mjs';
import { runAutonomousFactory, reconcileAutonomousJob } from '../src/autonomous-factory.mjs';
import { collectHostedDraftReceipts, prepareAutonomousWorktree, ensureHostDirectories, realDirectory, runHost } from '../src/autonomous-factory-host.mjs';
import { createGitHubReadAdapter } from '../src/github-read-adapter.mjs';
import { createGitHubDraftAdmissionAdapter } from '../src/github-draft-admission.mjs';
import { createAgentFactoryExecutionAdapter } from '../src/github-portfolio-execution.mjs';
import { createStreamingClaudeAdapters } from '../src/factory-visible-claude.mjs';
import { emitCandidateArtifactChain } from '../src/artifact-chain-files.mjs';

const usage = `usage: github-portfolio-autonomous.mjs
  enable --state EXISTING_DIR --repository OWNER/NAME --max-runs 20
  status|revoke --state DIR
  tick|watch --state DIR --clone TRUSTED_CLONE [--timeout-ms 600000] [--interval-seconds 60]
Local standing authority, one host slot, one candidate per Draft. No per-run prompt.
State must be outside the trusted clone and owned by its operator. Enable is one-time;
revoke prevents future starts. Retain this state directory on restart. No auto-merge.
Watch reads the latest 20 successful main hosted-draft-intake runs. Exceptions are
reported; missing/ambiguous receipts are never blindly rerun. Ctrl+C stops watch.`;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const allowed = {
  enable: ['state', 'repository', 'max-runs'], status: ['state'], revoke: ['state'],
  tick: ['state', 'clone', 'timeout-ms'], watch: ['state', 'clone', 'timeout-ms', 'interval-seconds'],
};
function parse(argv) {
  const command = argv[0];
  if (!Object.hasOwn(allowed, command)) fail('Usage');
  const args = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i].slice(2);
    if (!argv[i].startsWith('--') || !allowed[command].includes(key)
        || Object.hasOwn(args, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) fail('Usage');
    args[key] = argv[i + 1];
  }
  if (!args.state) fail('Usage');
  return { command, args };
}
function integer(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!/^[0-9]+$/.test(value) || !Number.isSafeInteger(n) || n < minimum || n > maximum) fail('Usage');
  return n;
}

/** One bounded tick; injected ports exercise the actual CLI scheduling seam. */
export async function runAutonomousTick({ store, collect, execution, githubRead, admission }) {
  const state = store.status();
  if (state.activeJobKey) return reconcileAutonomousJob({ store, execution, jobKey: state.activeJobKey });
  if (!state.enabled) return { status: 'REFUSED', code: 'PolicyDisabled' };
  if (state.usedRuns >= state.maxRuns) return { status: 'REFUSED', code: 'BudgetExhausted' };
  const { entries, refusals: discoveryRefusals } = await collect();
  const refusals = [...discoveryRefusals];
  for (const entry of entries) {
    const previous = state.jobs.find(job => job.intent.itemNumber === entry.expectation.workItem.number
      && job.intent.draft.number === entry.expectation.number);
    if (previous) continue;
    const result = await runAutonomousFactory({ store, execution, githubRead,
      draftAdmission: admission(entry), repository: state.repository, policyRevision: 'autonomous-factory-v1' });
    if (result.status !== 'REFUSED' && result.status !== 'NO_READY_WORK') return result;
    refusals.push({ runId: entry.runId, code: result.code ?? result.status });
    if (store.status().activeJobKey) return result;
  }
  return { status: entries.length === 0 ? 'NO_INTAKE_RECEIPTS' : 'NO_NEW_CANDIDATE', refusals,
    discovery: { workflow: 'hosted-draft-intake.yml', branch: 'main', successfulRunLimit: 20 } };
}

/**
 * Emit the candidate-stage artifact chain for a terminal receipt, strictly after the store's own
 * terminal transition and from evidence already on disk. Returns null when the tick produced no
 * candidate to describe. It never throws: a sidecar is a description of completed work, so failing
 * to write one must not rerun a finished worker, free the host slot, or change the tick's verdict.
 */
export function emitCandidateSidecar({ result, store, evidenceRoot }) {
  if (result?.schema !== 'gaia-autonomous-factory-receipt/1') return null;
  try {
    const job = store.get(result.jobKey);
    if (!job) return { status: 'FAILED', code: 'UnknownJob' };
    const emitted = emitCandidateArtifactChain({ evidenceDir: join(evidenceRoot, result.idempotencyKey),
      intent: job.intent, status: result.status });
    return { status: emitted.status, subject: emitted.subject, pendingStages: emitted.pendingStages };
  } catch (error) {
    // `typeof` first: an untyped Error carries no code, and testing the pattern against the
    // absent value would report the literal string "undefined" as though it were one.
    return { status: 'FAILED',
      code: typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.code)
        ? error.code : 'ArtifactChainSidecarFailed' };
  }
}

export async function runAutonomousCli(argv, { write = value => process.stdout.write(`${JSON.stringify(value)}\n`) } = {}) {
  if (argv.length === 0 || argv[0] === '--help') { process.stdout.write(`${usage}\n`); return 0; }
  const { command, args } = parse(argv);
  const root = realDirectory(resolve(args.state));
  const path = join(root, 'authority.sqlite');
  if (command !== 'enable' && !existsSync(path)) fail('PolicyMissing');
  let clone;
  if (['tick', 'watch'].includes(command)) {
    if (!args.clone) fail('Usage');
    clone = realDirectory(resolve(args.clone));
    const containment = relative(clone, root);
    if (!containment || !(containment === '..' || containment.startsWith(`..${sep}`) || isAbsolute(containment))) fail('StateInsideClone');
    // Keep topology refusals, then require visibility before opening the authority
    // store: a missing terminal must never consume a job's one execution slot.
    if (!process.stdout.isTTY) fail('ObservabilityRequired');
  }
  const store = openAutonomousFactoryStore({ path });
  try {
    if (command === 'enable') {
      write(store.configure({ repository: args.repository, maxRuns: integer(args['max-runs'], 20, 1, 1000) }));
      return 0;
    }
    if (command === 'status' || command === 'revoke') { write(store[command]()); return 0; }
    const paths = ensureHostDirectories(root);
    const timeoutMs = integer(args['timeout-ms'], 600_000, 1000, 1_800_000);
    const interval = integer(args['interval-seconds'], 60, 10, 3600) * 1000;
    const repository = store.status().repository;
    if (!repository) fail('PolicyMissing');
    // Visible by construction: provider activity is rendered to the terminal running the pump,
    // and an unrenderable run is refused rather than continued invisibly.
    const providers = createStreamingClaudeAdapters();
    const adapters = new Map();
    function adapter(intent, prepare) {
      const key = autonomousJobKey(intent);
      if (!adapters.has(key)) {
        const worktree = prepare ? prepareAutonomousWorktree({ clone, worktreeRoot: paths.worktrees,
          operationMarker: key, ...intent.draft }) : join(paths.worktrees, key);
        adapters.set(key, createAgentFactoryExecutionAdapter({ expectedRepository: repository, worktree,
          evidenceRoot: paths.evidence,
          runWorker: ctx => providers.runWorker(ctx, { timeoutMs }),
          runReviewer: ctx => providers.runReviewer(ctx, { timeoutMs }),
          runRepair: ctx => providers.runRepair(ctx, { timeoutMs }),
        }));
      }
      return adapters.get(key);
    }
    const execution = {
      execute: request => {
        const target = adapter(request.intent, true);
        const worktree = join(paths.worktrees, autonomousJobKey(request.intent));
        if (runHost('git', ['rev-parse', 'HEAD'], { cwd: worktree }).trim() !== request.intent.draft.headRevision) fail('SourceMoved');
        return target.execute(request);
      },
      findReceipt: request => adapter(request.intent, false).findReceipt(request),
    };
    const tick = () => runAutonomousTick({ store, execution, githubRead: createGitHubReadAdapter(),
      collect: () => collectHostedDraftReceipts({ repository, cacheDir: paths.cache }),
      admission: entry => createGitHubDraftAdmissionAdapter({ expectedRepository: repository, receiptText: entry.receiptText }),
    });
    const once = async () => {
      let result;
      try { result = await tick(); }
      catch (error) { return { status: 'REFUSED', code: /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.code) ? error.code : 'HostReadFailed' }; }
      const artifactChain = emitCandidateSidecar({ result, store, evidenceRoot: paths.evidence });
      return artifactChain === null ? result : { ...result, artifactChain };
    };
    if (command === 'tick') {
      const result = await once(); write(result);
      return ['REFUSED', 'RECONCILIATION_REQUIRED'].includes(result.status) ? 1 : 0;
    }
    let stopped = false;
    const abort = new AbortController();
    const stop = () => { stopped = true; abort.abort(); };
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    let previous;
    try {
      while (!stopped) {
        const result = await once();
        const text = JSON.stringify(result);
        if (text !== previous) { write(result); previous = text; }
        if (['PolicyDisabled', 'BudgetExhausted'].includes(result.code) || result.status === 'RECONCILIATION_REQUIRED') return 1;
        try { await delay(interval, undefined, { signal: abort.signal }); } catch { /* Stop between ticks. */ }
      }
    } finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    return 0;
  } finally { store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runAutonomousCli(process.argv.slice(2)).then(code => { process.exitCode = code; }).catch(error => {
    process.stderr.write(`${/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.code) ? error.code : 'AutonomousCliFailed'}\n`);
    process.exitCode = 1;
  });
}
