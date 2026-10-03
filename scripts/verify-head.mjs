#!/usr/bin/env node
/**
 * verify-head.mjs — run the factory's own verification on the committed HEAD and leave a receipt.
 *
 * Usage
 *   node scripts/verify-head.mjs --base <40-hex> --evidence-dir <new dir> --out <new receipt.json>
 *        [--worktree <path>]
 *
 * The worktree (default: the current directory) must be clean, and the base an ancestor of HEAD.
 * The run is the autonomous factory's: the Node pinned in `.node-version` or a refusal, then
 * `node --test --test-reporter=spec`, bounded, with its output kept as content-addressed evidence
 * in the evidence directory, which must not exist yet. See src/head-verification.mjs for what
 * the receipt is and is not; it is evidence of one run, never a permission.
 *
 * Exit codes: 0 the run passed · 1 the run did not pass (its receipt is still written) ·
 * 2 refused or usage error (no receipt). A receipt or an evidence file is never overwritten.
 */

import { existsSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { FactoryAgentError, verifyCommittedHead } from '../src/factory-agent.mjs';
import { HeadVerificationError, sealHeadVerification } from '../src/head-verification.mjs';

const KNOWN_FLAGS = new Set(['base', 'evidence-dir', 'out', 'worktree']);
const REQUIRED_FLAGS = ['base', 'evidence-dir', 'out'];

export class UsageError extends Error {}

class Refusal extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function parseArgs(argv) {
  const flags = Object.create(null);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) throw new UsageError(`unknown flag: ${token}`);
    const value = argv[index += 1];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  for (const name of REQUIRED_FLAGS) {
    if (!flags[name]) throw new UsageError(`missing --${name}`);
  }
  return flags;
}

function summary(receipt) {
  const { verification } = receipt;
  const counts = verification.counts === null
    ? 'counts unreadable'
    : `tests ${verification.counts.tests} | pass ${verification.counts.pass} | fail ${verification.counts.fail}`;
  return [
    `Head verification: ${verification.passed ? 'PASS' : 'FAIL'}`,
    `head ${receipt.headSha.slice(0, 12)}`,
    `base ${receipt.baseSha.slice(0, 12)}`,
    `node ${verification.runtime.version} (pinned ${verification.runtime.pinned ?? 'none'})`,
    `${verification.termination}${verification.exitCode === null ? '' : ` ${verification.exitCode}`}`,
    counts,
    `receipt ${receipt.revision}`,
  ].join(' | ');
}

export async function runVerifyHeadCli(argv, {
  stdout = process.stdout, stderr = process.stderr, cwd = process.cwd(), verify = verifyCommittedHead,
} = {}) {
  try {
    const flags = parseArgs(argv);
    const out = resolve(cwd, flags.out);
    if (existsSync(out)) throw new Refusal('ReceiptExists', `a receipt already exists at ${out}`);
    const receipt = sealHeadVerification(await verify({
      worktree: resolve(cwd, flags.worktree ?? '.'),
      baseHead: flags.base,
      evidenceDir: resolve(cwd, flags['evidence-dir']),
    }));
    try {
      writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    } catch (error) {
      throw new Refusal('ReceiptExists', `cannot create the receipt at ${out}: ${error.code}`);
    }
    stdout.write(`${summary(receipt)}\n`);
    return receipt.verification.passed ? 0 : 1;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\nusage: verify-head --base <40-hex> --evidence-dir <new dir> --out <new file> [--worktree <path>]\n`);
      return 2;
    }
    if (error instanceof Refusal || error instanceof FactoryAgentError || error instanceof HeadVerificationError) {
      stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) {
  runVerifyHeadCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  }, (error) => {
    process.stderr.write(`HeadVerificationFailed: ${error?.message ?? error}\n`);
    process.exitCode = 2;
  });
}
