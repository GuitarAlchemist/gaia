import { randomUUID } from 'node:crypto';
import {
  mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPortfolioFactory } from '../src/github-portfolio.mjs';
import { createGitHubReadAdapter } from '../src/github-read-adapter.mjs';
import { runFactoryDashboardCli } from './factory-dashboard.mjs';

class UsageError extends Error {}

const ALLOWED_OPTIONS = new Set([
  'organization', 'policy-revision', 'portfolio-out', 'snapshot-out', 'html-out',
  'receipts', 'holds', 'progress', 'history', 'telemetry', 'capacity', 'language',
  'watch-ms',
]);
const CASE_INSENSITIVE_PATHS = process.platform === 'win32' || process.platform === 'darwin';
const MAX_PATH_DEPTH = 256;

function pathIdentity(path) {
  const supplied = resolve(path);
  let cursor = supplied;
  const tail = [];
  for (let depth = 0; depth < MAX_PATH_DEPTH; depth += 1) {
    try {
      const physical = statSync(cursor, { bigint: true });
      const suffix = tail.reverse().join('/');
      const canonicalSuffix = CASE_INSENSITIVE_PATHS ? suffix.toLowerCase() : suffix;
      return `${physical.dev}:${physical.ino}:${canonicalSuffix}`;
    } catch {
      const parent = dirname(cursor);
      if (parent === cursor) break;
      tail.push(basename(cursor));
      cursor = parent;
    }
  }
  return CASE_INSENSITIVE_PATHS ? supplied.toLowerCase() : supplied;
}

function abortReason(signal) {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error('operation aborted');
  error.name = 'AbortError';
  return error;
}

function abortable(operation, signal) {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolvePromise, rejectPromise) => {
    const abort = () => { rejectPromise(abortReason(signal)); };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(operation).then(resolvePromise, rejectPromise).finally(() => {
      signal.removeEventListener('abort', abort);
    });
  });
}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new UsageError('expected paired --name value arguments');
    }
    const key = name.slice(2);
    if (!ALLOWED_OPTIONS.has(key)) throw new UsageError(`unknown option: ${name}`);
    if (Object.hasOwn(flags, key)) throw new UsageError(`duplicate option: ${name}`);
    flags[key] = value;
  }
  for (const required of [
    'organization', 'policy-revision', 'portfolio-out', 'snapshot-out', 'html-out',
  ]) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  if (flags['watch-ms'] !== undefined) {
    const interval = Number(flags['watch-ms']);
    if (!Number.isSafeInteger(interval) || interval < 10_000 || interval > 300_000) {
      throw new UsageError('--watch-ms must be an integer from 10000 through 300000');
    }
  }
  return flags;
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function atomicReplace(path, contents) {
  const target = resolve(path);
  const temporary = join(dirname(target), `.${basename(target)}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, target);
  } finally {
    rmSync(temporary, { force: true });
  }
}

async function defaultSurveyPortfolio(request) {
  return createPortfolioFactory({ githubRead: createGitHubReadAdapter() }).survey(request);
}

function dashboardArgs(flags, portfolioPath, snapshotPath, htmlPath) {
  const result = [
    '--portfolio', portfolioPath,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ];
  for (const name of [
    'receipts', 'holds', 'progress', 'history', 'telemetry', 'capacity', 'language',
  ]) {
    if (flags[name] !== undefined) result.push(`--${name}`, flags[name]);
  }
  return result;
}

function assertPathConstraints(flags, outputPaths) {
  const outputIdentities = outputPaths.map(pathIdentity);
  if (new Set(outputIdentities).size !== outputPaths.length) {
    throw new UsageError('portfolio, snapshot, and HTML outputs must differ');
  }
  const inputIdentities = ['receipts', 'holds', 'progress', 'history', 'telemetry']
    .filter((name) => flags[name] !== undefined)
    .map((name) => pathIdentity(flags[name]));
  if (outputIdentities.some((identity) => inputIdentities.includes(identity))) {
    throw new UsageError('an output path aliases an input evidence path');
  }
  return JSON.stringify({ inputIdentities, outputIdentities });
}

/** Survey GitHub once and publish one complete control-room view. */
export async function runFactoryDashboardRefreshCli(argv, {
  now = () => new Date(),
  signal,
  surveyPortfolio = defaultSurveyPortfolio,
  writeStdout = (chunk) => process.stdout.write(chunk),
} = {}) {
  const flags = parseArgs(argv);
  const portfolioPath = resolve(flags['portfolio-out']);
  const snapshotPath = resolve(flags['snapshot-out']);
  const htmlPath = resolve(flags['html-out']);
  const outputPaths = [portfolioPath, snapshotPath, htmlPath];
  const openingPathIdentities = assertPathConstraints(flags, outputPaths);

  if (signal?.aborted) throw abortReason(signal);
  const request = {
    organization: flags.organization,
    policyRevision: flags['policy-revision'],
    ...(signal === undefined ? {} : { signal }),
  };
  const portfolio = await abortable(surveyPortfolio(request), signal);
  if (signal?.aborted) throw abortReason(signal);
  const staging = mkdtempSync(join(tmpdir(), 'gaia-control-room-refresh-'));
  try {
    const stagedPortfolio = join(staging, 'portfolio.json');
    const stagedSnapshot = join(staging, 'control-room.json');
    const stagedHtml = join(staging, 'control-room.html');
    writeFileSync(stagedPortfolio, serialize(portfolio), { encoding: 'utf8', flag: 'wx' });
    const snapshot = runFactoryDashboardCli(
      dashboardArgs(flags, stagedPortfolio, stagedSnapshot, stagedHtml),
      { now, writeStdout: () => {} },
    );
    const publicationPathIdentities = assertPathConstraints(flags, outputPaths);
    if (publicationPathIdentities !== openingPathIdentities) {
      throw new UsageError('path identities changed before publication');
    }
    if (signal?.aborted) throw abortReason(signal);

    // Publish the self-contained HTML last. A failed tick therefore never exposes a partial
    // HTML document, and the next tick repairs any evidence file that could not be replaced.
    atomicReplace(portfolioPath, readFileSync(stagedPortfolio, 'utf8'));
    atomicReplace(snapshotPath, readFileSync(stagedSnapshot, 'utf8'));
    atomicReplace(htmlPath, readFileSync(stagedHtml, 'utf8'));
    writeStdout(`Gaia control room refreshed: ${snapshot.headline.state}`
      + ` | next ${snapshot.nextAction.kind} | source ${snapshot.sourceRevision}\n`);
    return snapshot;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function delay(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolvePromise) => {
    let handle;
    const finish = () => {
      clearTimeout(handle);
      signal?.removeEventListener('abort', finish);
      resolvePromise();
    };
    handle = setTimeout(finish, milliseconds);
    signal?.addEventListener('abort', finish, { once: true });
  });
}

/** Run sequential refresh ticks. A failed watch tick is observable and retried. */
export async function runFactoryDashboardRefreshLoop(argv, {
  signal,
  wait = delay,
  writeError = (error) => process.stderr.write(
    `Gaia control room refresh failed: ${error.name}: ${error.message}\n`,
  ),
  ...refreshDependencies
} = {}) {
  const flags = parseArgs(argv);
  const interval = flags['watch-ms'] === undefined ? null : Number(flags['watch-ms']);

  do {
    if (signal?.aborted) break;
    try {
      await runFactoryDashboardRefreshCli(argv, { ...refreshDependencies, signal });
    } catch (error) {
      if (signal?.aborted && error?.name === 'AbortError') break;
      if (interval === null) throw error;
      writeError(error);
    }
    if (interval !== null && !signal?.aborted) await wait(interval, signal);
  } while (interval !== null && !signal?.aborted);
}

async function main(argv) {
  const controller = new AbortController();
  process.once('SIGINT', () => { controller.abort(); });
  process.once('SIGTERM', () => { controller.abort(); });
  try {
    await runFactoryDashboardRefreshLoop(argv, { signal: controller.signal });
  } catch (error) {
    process.stderr.write(`Gaia control room refresh failed: ${error.name}: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) await main(process.argv.slice(2));
