#!/usr/bin/env node
/**
 * draft-ambiguity-settlement.mjs — dry run: what does one saved marker lookup prove about one
 * EFFECT_AMBIGUOUS Draft operation? (Gaia issue #176.)
 *
 * Usage
 *   node scripts/draft-ambiguity-settlement.mjs --operation <file> --lookup <file> [--json]
 *
 *   --operation  the ambiguous operation as the ledger holds it: operationId, workKey,
 *                generationKey, committedRevision, state and its envelope. The identity is
 *                recomputed from the envelope, so it cannot name another generation's head;
 *   --lookup     a GaiaDraftMarkerLookupV0 record of the provider's search, run after reading the
 *                operation at that revision: the repository identity check, then every pull request
 *                on the head branch in every state, as `gh pr list --json` rows, with when it ran
 *                and whether it completed (docs/hosted-draft-intake.md, "Settling an ambiguous
 *                Draft").
 *
 * Prints the decision (SETTLE_REUSED, SETTLE_ABANDONED or STAY_UNSETTLED), its reason, and the
 * evidence record a settlement would carry. It reads the two files and nothing else: no network,
 * no ledger, no clock. There is no --apply: a settlement is written only by the intake workflow's
 * operator dispatch (hosted-draft-pump.mjs settle, #161), which runs its own search.
 *
 * Exit codes: 0 a decision was made (whichever it is) · 1 refused (the files do not describe one
 * ambiguous operation and a lookup of its own marker, head and repository) · 2 usage error ·
 * 3 fail-closed (a file could not be read or parsed; nothing was decided).
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  AmbiguitySettlementError, decideAmbiguousSettlement,
} from '../src/draft-ambiguity-settlement.mjs';

const USAGE = 'usage: node scripts/draft-ambiguity-settlement.mjs --operation <file> '
  + '--lookup <file> [--json]\n';

const VALUED = new Set(['operation', 'lookup']);
const FLAGS = new Set([...VALUED, 'json']);

class UsageError extends Error {}
class InputUnavailable extends Error {}
const usageError = (message) => { throw new UsageError(message); };

function parse(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) usageError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (name === 'apply') usageError('--apply is not here; a settlement is written by the settle dispatch (#161)');
    if (!FLAGS.has(name)) usageError(`unknown flag: ${token}`);
    if (flags[name] !== undefined) usageError(`${token} given more than once`);
    if (!VALUED.has(name)) { flags[name] = true; continue; }
    const value = argv[index += 1];
    if (value === undefined || value.startsWith('--')) usageError(`${token} needs a value`);
    flags[name] = value;
  }
  for (const required of VALUED) {
    if (flags[required] === undefined) usageError(`--${required} is required`);
  }
  return flags;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    throw new InputUnavailable(label);
  }
}

function render({ decision, reason, evidence }) {
  const { lookup, pullRequest } = evidence;
  return [
    `decision=${decision} reason=${reason}`,
    `operation=${evidence.operationId} revision=${evidence.committedRevision} `
      + `issue=#${evidence.workItem.number}`,
    `lookup=sha256:${lookup.revision} head=${lookup.headRef} state=${lookup.search.state} `
      + `limit=${lookup.search.limit} outcome=${lookup.outcome} candidates=${lookup.candidateCount} `
      + `observedAt=${lookup.observedAt}`,
    pullRequest === null ? 'pullRequest=none'
      : `pullRequest=#${pullRequest.number} state=${pullRequest.state} draft=${pullRequest.isDraft} `
        + `head=${pullRequest.headRevision}`,
    `evidence=sha256:${evidence.revision}`,
    'effect=NONE authority=NONE written=nothing',
  ].join('\n') + '\n';
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') { process.stdout.write(USAGE); return 0; }
  const flags = parse(argv);
  const operation = readJson(flags.operation, 'operation');
  const lookup = readJson(flags.lookup, 'lookup');
  const result = decideAmbiguousSettlement({ operation, lookup });
  process.stdout.write(flags.json ? `${JSON.stringify(result)}\n` : render(result));
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`usage error: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof AmbiguitySettlementError) {
    process.stderr.write(`REFUSED: ${error.code}\n`);
    process.exitCode = 1;
  } else if (error instanceof InputUnavailable) {
    process.stderr.write(`FAILED_CLOSED: ${error.message} file unreadable or not JSON\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write('FAILED_CLOSED: SETTLEMENT_CHECK_FAILED\n');
    process.exitCode = 3;
  }
}
