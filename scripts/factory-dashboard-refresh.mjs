import { randomUUID } from 'node:crypto';
import {
  mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createPortfolioFactory } from '../src/github-portfolio.mjs';
import { createGitHubReadAdapter } from '../src/github-read-adapter.mjs';
import { runFactoryDashboardCli } from './factory-dashboard.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new UsageError('expected paired --name value arguments');
    }
    const key = name.slice(2);
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
  for (const name of ['receipts', 'holds', 'progress', 'history', 'capacity', 'language']) {
    if (flags[name] !== undefined) result.push(`--${name}`, flags[name]);
  }
  return result;
}

/** Survey GitHub once and publish one complete control-room view. */
export async function runFactoryDashboardRefreshCli(argv, {
  now = () => new Date(),
  surveyPortfolio = defaultSurveyPortfolio,
  writeStdout = (chunk) => process.stdout.write(chunk),
} = {}) {
  const flags = parseArgs(argv);
  const portfolioPath = resolve(flags['portfolio-out']);
  const snapshotPath = resolve(flags['snapshot-out']);
  const htmlPath = resolve(flags['html-out']);
  if (new Set([portfolioPath, snapshotPath, htmlPath]).size !== 3) {
    throw new UsageError('portfolio, snapshot, and HTML outputs must differ');
  }

  const portfolio = await surveyPortfolio({
    organization: flags.organization,
    policyRevision: flags['policy-revision'],
  });
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

function delay(milliseconds) {
  return new Promise((resolvePromise) => { setTimeout(resolvePromise, milliseconds); });
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
    try {
      await runFactoryDashboardRefreshCli(argv, refreshDependencies);
    } catch (error) {
      if (interval === null) throw error;
      writeError(error);
    }
    if (interval !== null && !signal?.aborted) await wait(interval);
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
