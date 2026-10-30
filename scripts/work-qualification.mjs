#!/usr/bin/env node
// Read local versioned observations only. No mutation, network or model adapter.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { qualifyWork } from '../src/work-qualification.mjs';
import { proposeReversibleDecision } from '../src/reversible-decision-shadow.mjs';

export async function main({ argv = process.argv.slice(2), read = file => readFile(file, 'utf8'),
  stdout = process.stdout, stderr = process.stderr } = {}) {
  if (argv.length !== 2 || !['--input', '--decisions'].includes(argv[0]) || !argv[1]) {
    stderr.write('usage: work-qualification.mjs --input QUALIFICATIONS.json | --decisions DECISIONS.json (shadow only)\n');
    return 2;
  }
  try {
    const raw = await read(argv[1]);
    if (typeof raw !== 'string' || Buffer.byteLength(raw) > 262144) throw new Error('InputBound');
    const requests = JSON.parse(raw);
    if (!Array.isArray(requests) || requests.length < 1 || requests.length > 100) throw new Error('InputBound');
    const decisions = argv[0] === '--decisions';
    const results = requests.map(decisions ? proposeReversibleDecision : qualifyWork);
    stdout.write(`${JSON.stringify({ schema: decisions ? 'GaiaReversibleDecisionShadowBatchV0' : 'GaiaWorkQualificationShadowV0', results }, null, 2)}\n`);
    return 0;
  } catch {
    stderr.write('fail-closed: invalid or unreadable qualification snapshot\n');
    return 3;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; });
}
