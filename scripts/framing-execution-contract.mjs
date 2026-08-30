#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import { canonicalJson } from '../src/epistemic-research.mjs';
import {
  encodeExecutionContract,
  frameExecutionRequest,
} from '../src/framing-execution-contract.mjs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

const [flag, inputPath, ...rest] = process.argv.slice(2);
if (flag !== '--input' || !inputPath || rest.length > 0) {
  fail('Usage: framing-execution-contract --input <immutable-json-file>');
} else {
  try {
    const result = frameExecutionRequest(JSON.parse(readFileSync(inputPath, 'utf8')));
    const encoded = result.status === 'FRAMED'
      ? encodeExecutionContract(result)
      : canonicalJson(result);
    process.stdout.write(`${encoded}\n`);
  } catch (error) {
    fail(`${error.name ?? 'Error'}: ${error.message}`);
  }
}
