/**
 * factory-telemetry-phase.mjs - record exactly one lifecycle phase of one run, then exit.
 *
 * This is the operator-facing half of the phase sensor. Because the process returns between
 * phases, the run stays open in the durable log, so a separately invoked
 * `scripts/factory-dashboard.mjs` genuinely observes it moving, watches its heartbeat expire,
 * and later sees it settle. Nothing here starts a worker, calls a provider, drives wmux or
 * holds authority: it appends one fact the caller asserts already happened, or it refuses.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { factoryTelemetryLogPath } from '../src/factory-telemetry-log.mjs';
import {
  FACTORY_TELEMETRY_PHASES,
  recordFactoryTelemetryPhase,
} from '../src/factory-telemetry-phase.mjs';

export const TELEMETRY_PHASE_REPORT_SCHEMA = 'gaia-telemetry-phase-report/1';

class UsageError extends Error {}

const SUBJECT_OPTIONS = Object.freeze([
  'repository', 'item', 'item-number', 'lane', 'agent', 'item-revision',
]);

const ALLOWED_OPTIONS = new Set([
  'telemetry-dir', 'run-id', 'phase', 'gate', 'blocker', 'evidence-revision', 'out',
  ...SUBJECT_OPTIONS,
]);

const GATE_PHASES = new Set(['gate-entered', 'gate-passed', 'gate-failed']);

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
  for (const required of ['telemetry-dir', 'run-id', 'phase']) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  if (!Object.hasOwn(FACTORY_TELEMETRY_PHASES, flags.phase)) {
    throw new UsageError(
      `unsupported phase ${flags.phase}; expected one of `
      + `${Object.keys(FACTORY_TELEMETRY_PHASES).join(', ')}`,
    );
  }
  return flags;
}

/** The subject is bound exactly once, at start, so a later phase cannot rebind the run. */
function subjectOf(flags) {
  const supplied = SUBJECT_OPTIONS.filter((option) => flags[option] !== undefined);
  if (flags.phase !== 'start') {
    if (supplied.length > 0) {
      throw new UsageError(
        `only --phase start may bind the observed subject; drop --${supplied[0]}`,
      );
    }
    return null;
  }
  for (const required of ['repository', 'item', 'item-number', 'lane', 'agent']) {
    if (flags[required] === undefined) {
      throw new UsageError(`--phase start requires --${required}`);
    }
  }
  const itemNumber = Number(flags['item-number']);
  if (!Number.isSafeInteger(itemNumber) || itemNumber < 1) {
    throw new UsageError('--item-number must be a positive integer');
  }
  return {
    repository: flags.repository,
    itemId: flags.item,
    itemNumber,
    lane: flags.lane,
    agent: flags.agent,
    itemRevision: flags['item-revision'] ?? 'UNKNOWN',
  };
}

export function runFactoryTelemetryPhaseCli(argv, {
  now = () => new Date(),
  writeStdout = (chunk) => process.stdout.write(chunk),
} = {}) {
  const flags = parseArgs(argv);
  const telemetryDirectory = resolve(flags['telemetry-dir']);
  const subject = subjectOf(flags);

  if (GATE_PHASES.has(flags.phase) === (flags.gate === undefined)) {
    throw new UsageError(GATE_PHASES.has(flags.phase)
      ? `--phase ${flags.phase} requires --gate`
      : `--phase ${flags.phase} must not carry --gate`);
  }
  if ((flags.phase === 'block') === (flags.blocker === undefined)) {
    throw new UsageError(flags.phase === 'block'
      ? '--phase block requires --blocker'
      : `--phase ${flags.phase} must not carry --blocker`);
  }
  const outPath = flags.out === undefined ? null : resolve(flags.out);
  if (outPath !== null && outPath === factoryTelemetryLogPath(telemetryDirectory)) {
    throw new UsageError('--out must not overwrite a durable evidence log');
  }

  const receipt = recordFactoryTelemetryPhase({
    directory: telemetryDirectory,
    runId: flags['run-id'],
    phase: flags.phase,
    subject,
    gate: flags.gate ?? null,
    blocker: flags.blocker ?? null,
    ...(flags['evidence-revision'] === undefined
      ? {} : { evidenceRevision: flags['evidence-revision'] }),
    now,
  });

  const report = { schema: TELEMETRY_PHASE_REPORT_SCHEMA, receipt };
  if (outPath !== null) writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeStdout(`Gaia telemetry phase: ${receipt.phase} | run ${receipt.runId}`
    + ` | ${receipt.event} #${receipt.sequence} at ${receipt.observedAt}`
    + ` | state ${receipt.runState}${receipt.duplicate ? ' | already recorded' : ''}\n`);
  return report;
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  try {
    runFactoryTelemetryPhaseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
