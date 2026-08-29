#!/usr/bin/env node

import { readFileSync } from 'node:fs';

import {
  auditPlanClaim,
  encodeContradictionRepair,
  encodePlanContradictionAudit,
  proposeContradictionRepair,
} from '../src/plan-contradiction-audit.mjs';

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 2;
}

const [mode, flag, inputPath, ...rest] = process.argv.slice(2);
if (!['audit', 'propose'].includes(mode) || flag !== '--input' || !inputPath || rest.length > 0) {
  fail('Usage: plan-contradiction-audit <audit|propose> --input <immutable-json-file>');
} else {
  try {
    const input = JSON.parse(readFileSync(inputPath, 'utf8'));
    const result = mode === 'audit'
      ? encodePlanContradictionAudit(auditPlanClaim(input))
      : encodeContradictionRepair(proposeContradictionRepair(input));
    process.stdout.write(`${result}\n`);
  } catch (error) {
    fail(`${error.name ?? 'Error'}: ${error.message}`);
  }
}
