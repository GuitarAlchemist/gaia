#!/usr/bin/env node
/**
 * github-portfolio-operator.mjs — the terminal end of the operator seam.
 *
 * This script is deliberately thin. It parses a bounded argument list, proves there is a
 * person at a terminal, names which streams the terminal is, composes the existing read,
 * authority, and execution adapters, and hands everything to
 * src/github-portfolio-operator.mjs. Every decision that matters — what may be
 * authorized, what must be confirmed, how a reader answers Ctrl-C, what is written down,
 * and what the process exits with — lives in that module, so all of it is testable
 * without a terminal and none of it can be worked around by driving the process
 * differently. What is left here is argument shape and stream binding.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  initOperatorKeypair,
  readConfirmationFromTerminal,
  readSecretForPlatform,
  runOperatorFactory,
  summarizeOperatorReceipt,
} from '../src/github-portfolio-operator.mjs';
import { createFileEd25519AuthorityAdapter } from '../src/github-portfolio-authority.mjs';
import { createAgentFactoryExecutionAdapter } from '../src/github-portfolio-execution.mjs';
import { createGitHubReadAdapter } from '../src/github-read-adapter.mjs';
import {
  runClaudeRepair,
  runClaudeWorker,
  runCodexReviewer,
} from '../src/factory-agent.mjs';
import { createCliProgress, instrumentFactoryAdapters } from '../src/cli-progress.mjs';

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

const USAGE = `usage:
  github-portfolio-operator.mjs init --private-key NEW_FILE --public-key NEW_FILE

  github-portfolio-operator.mjs run --portfolio FILE --repository OWNER/NAME
      --private-key FILE --public-key FILE --ledger DIR --worktree DIR
      --evidence-root DIR --out NEW_FILE [--ttl-seconds 120] [--timeout-ms 600000]

Both commands require an interactive session. Windows reads the passphrase from a masked
OS dialog; other platforms use the terminal. Run reads its confirmation from the
terminal. There is no option, environment variable, or file that supplies either.`;

// The option list is closed. An option this command does not know is refused rather than
// ignored, which is what keeps `--passphrase` from being a thing someone can try.
const OPTIONS = {
  init: ['private-key', 'public-key'],
  run: [
    'portfolio', 'repository', 'private-key', 'public-key', 'ledger', 'worktree',
    'evidence-root', 'out', 'ttl-seconds', 'timeout-ms',
  ],
};

function parseArgs(argv, allowed) {
  const result = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new UsageError(`expected --name value, received ${flag}`);
    const name = flag.slice(2);
    if (!allowed.includes(name)) throw new UsageError(`unknown option: --${name}`);
    if (index + 1 >= argv.length) throw new UsageError(`option --${name} expects a value`);
    if (Object.hasOwn(result, name)) throw new UsageError(`duplicate option: --${name}`);
    result[name] = argv[index + 1];
    index += 1;
  }
  return result;
}

function required(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || value.trim() === '') {
    throw new UsageError(`missing --${name}`);
  }
  return value;
}

function boundedInteger(value, name, minimum, maximum) {
  if (!/^[0-9]+$/u.test(value)) {
    throw new UsageError(`--${name} must be a whole number`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new UsageError(`--${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

// The one precondition this script exists to enforce. A pipe is not a person, and an
// agent driving this process has a pipe.
function assertInteractive(isInteractive = () => process.stdin.isTTY) {
  if (!isInteractive()) {
    throw new UsageError(
      'this command requires an interactive terminal for operator presence and confirmation, and stdin is not one',
    );
  }
}

// The one thing about the interaction this script still owns: which platform and streams
// it binds. On Windows the secret reader opens a masked OS dialog. Elsewhere prompts and
// secrets use stderr, so stdout carries only the command's result. What the readers do —
// including how they answer cancellation — is the module's, and is gated there.
const readPassphrase = ({ prompt }) => readSecretForPlatform({
  prompt, input: process.stdin, output: process.stderr,
});

const confirmAtTerminal = ({ prompt }) => readConfirmationFromTerminal({
  prompt, input: process.stdin, output: process.stderr,
});

export async function runPortfolioOperatorCli(argv, {
  initKeypair = initOperatorKeypair,
  runOperator = runOperatorFactory,
  summarize = summarizeOperatorReceipt,
  createAuthority = createFileEd25519AuthorityAdapter,
  createExecution = createAgentFactoryExecutionAdapter,
  createGithubRead = createGitHubReadAdapter,
  runWorker = runClaudeWorker,
  runReviewer = runCodexReviewer,
  runRepair = runClaudeRepair,
  readPassphraseFn = readPassphrase,
  confirmFn = confirmAtTerminal,
  isInteractive = () => process.stdin.isTTY,
  writeStdout = (chunk) => process.stdout.write(chunk),
  writeProgress = (chunk) => process.stderr.write(chunk),
  nowMs = () => Date.now(),
} = {}) {
  const command = argv[0];
  if (command !== 'init' && command !== 'run') throw new UsageError(USAGE);
  const args = parseArgs(argv.slice(1), OPTIONS[command]);

  if (command === 'init') {
    const privateKeyPath = required(args, 'private-key');
    const publicKeyPath = required(args, 'public-key');
    assertInteractive(isInteractive);
    const summary = await initKeypair({
      privateKeyPath, publicKeyPath, readPassphrase: readPassphraseFn,
    });
    writeStdout(`operator key minted\n  private ${summary.privateKeyPath}\n`
      + `  public  ${summary.publicKeyPath}\n`);
    return 0;
  }

  const portfolioPath = required(args, 'portfolio');
  const repository = required(args, 'repository');
  const privateKeyPath = required(args, 'private-key');
  const publicKeyPath = required(args, 'public-key');
  const ledgerDir = required(args, 'ledger');
  const worktree = required(args, 'worktree');
  const evidenceRoot = required(args, 'evidence-root');
  const outPath = required(args, 'out');
  // The numeric bound is checked here, ahead of the terminal precondition below, so a
  // value outside it is refused for being outside it and says so. A gate that could only
  // observe the refusal that comes next could not tell the two apart.
  const ttlSeconds = args['ttl-seconds'] === undefined
    ? 120
    : boundedInteger(args['ttl-seconds'], 'ttl-seconds', 1, 900);
  const timeoutMs = args['timeout-ms'] === undefined
    ? 10 * 60_000
    : boundedInteger(args['timeout-ms'], 'timeout-ms', 1_000, 30 * 60_000);
  assertInteractive(isInteractive);
  const progress = createCliProgress({ timeoutMs, write: writeProgress, nowMs });
  progress.validating();

  let receipt;
  try {
    const adapters = instrumentFactoryAdapters({
      runWorker: (context) => runWorker(context, { timeoutMs }),
      runReviewer: (context) => runReviewer(context, { timeoutMs }),
      runRepair: (context) => runRepair(context, { timeoutMs }),
      progress,
    });
    const baseExecution = createExecution({
      expectedRepository: repository, worktree, evidenceRoot,
      ...adapters,
    });
    const execution = Object.freeze({
      execute: async (request) => {
        progress.authorizedExecution();
        return baseExecution.execute(request);
      },
    });

    receipt = await runOperator({
      portfolioPath,
      repository,
      privateKeyPath,
      outPath,
      githubRead: createGithubRead(),
      authority: createAuthority({
        publicKey: readFileSync(publicKeyPath, 'utf8'), ledgerDir,
      }),
      execution,
      readPassphrase: readPassphraseFn,
      confirm: confirmFn,
      ttlSeconds,
    });
  } catch (error) {
    progress.terminalOutcome('FAILED');
    throw error;
  }

  // Every terminal outcome of `runOperatorFactory` — returned or refused — has a receipt
  // behind it by now, and one place decides what to say about it and what to exit with.
  const summary = summarize(receipt, outPath);
  writeStdout(summary.text);
  progress.terminalOutcome(receipt.status === 'AUTHORIZED'
    ? receipt.transition?.status ?? 'UNKNOWN'
    : receipt.status === 'REFUSED' ? 'REFUSED' : 'UNKNOWN');
  return summary.exitCode;
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  runPortfolioOperatorCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(
      `${error?.name ?? 'Error'}: ${error?.code ? `${error.code}: ` : ''}${error?.message ?? 'failed'}\n`,
    );
    // A throw means the command never got as far as owning a receipt, so it is reported as
    // a usage failure rather than as an outcome.
    process.exitCode = 2;
  });
}
