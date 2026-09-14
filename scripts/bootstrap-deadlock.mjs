#!/usr/bin/env node
/**
 * bootstrap-deadlock.mjs — analyse issue #80's hosted Draft pump bootstrap nets with IX and print
 * the analyses and readings as one JSON document.
 *
 * Usage
 *   node scripts/bootstrap-deadlock.mjs --extension <ix.duckdb_extension> [--max-states <n>]
 *
 * The printed document is exactly what tests/fixtures/bootstrap-deadlock/hosted-draft-pump.json
 * records, so re-recording after a net changes is this command redirected to that file. READ-ONLY:
 * it opens an in-memory store, loads the named extension, and writes nothing but stdout.
 *
 * Exit codes: 0 ok · 2 refusal (usage error, absent optional client, extension without the
 * function, a net IX refuses).
 */

import { pathToFileURL } from 'node:url';

import {
  BootstrapDeadlockError, HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS, netRevision, readBootstrapAnalysis,
} from '../src/bootstrap-deadlock.mjs';
import { IX_PETRI_FUNCTION, IxPetriDuckDbError, analyzeNetsWithIxPetri } from '../src/duckdb-ix-petri.mjs';

export const BOOTSTRAP_DEADLOCK_RUN_SCHEMA = 'gaia-bootstrap-deadlock-analysis/1';
export const DEFAULT_MAX_STATES = 10_000;

const USAGE = 'usage: node scripts/bootstrap-deadlock.mjs --extension <file> [--max-states <n>]';

/** One analysis document for every declared net, in declaration order. */
export async function runBootstrapDeadlock({ extensionFile, maxStates = DEFAULT_MAX_STATES }, adapterOptions) {
  const keys = Object.keys(HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS);
  const nets = keys.map((key) => HOSTED_DRAFT_PUMP_BOOTSTRAP_NETS[key]);
  const { analyses } = await analyzeNetsWithIxPetri({ nets, maxStates, extensionFile }, adapterOptions);
  return {
    schema: BOOTSTRAP_DEADLOCK_RUN_SCHEMA,
    function: IX_PETRI_FUNCTION,
    maxStates,
    nets: keys.map((key, index) => ({
      key,
      netRevision: netRevision(nets[index]),
      analysis: analyses[index].analysis,
      reading: readBootstrapAnalysis(nets[index], analyses[index].analysis),
    })),
  };
}

function parseArgs(argv) {
  const options = { extensionFile: null, maxStates: DEFAULT_MAX_STATES };
  for (let index = 0; index < argv.length; index += 2) {
    const [token, value] = [argv[index], argv[index + 1]];
    if (value === undefined || value.startsWith('--')) return null;
    if (token === '--extension') options.extensionFile = value;
    else if (token === '--max-states' && /^[1-9]\d*$/u.test(value)) options.maxStates = Number(value);
    else return null;
  }
  return options.extensionFile === null ? null : options;
}

async function main(argv) {
  const options = parseArgs(argv);
  if (options === null) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  try {
    process.stdout.write(`${JSON.stringify(await runBootstrapDeadlock(options), null, 2)}\n`);
    return 0;
  } catch (error) {
    if (error instanceof IxPetriDuckDbError || error instanceof BootstrapDeadlockError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
      return 2;
    }
    throw error;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main(process.argv.slice(2));
}
