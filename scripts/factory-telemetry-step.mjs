/**
 * factory-telemetry-step.mjs - run one real, bounded, instrumented drain transition and
 * publish what the control room truthfully saw at three explicit instants.
 *
 * The three observations are the whole point of the tracer bullet: while the heartbeat is
 * inside its freshness window the run visibly moves; one millisecond past that window the
 * same evidence becomes a named blockage; once the run settles it stops animating for good.
 * Nothing here calls a provider, launches a worker, publishes anything or holds authority.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildControlRoomSnapshot } from '../src/control-room.mjs';
import { runInstrumentedDrainTransition } from '../src/factory-drain-telemetry.mjs';
import {
  factoryTelemetryLogPath,
  readFactoryTelemetryLog,
} from '../src/factory-telemetry-log.mjs';
import { replayFactoryTelemetry } from '../src/factory-telemetry.mjs';
import {
  portfolioDrainLedgerPath,
  tickPortfolioDrain,
} from '../src/portfolio-drain-ledger.mjs';

export const TELEMETRY_STEP_REPORT_SCHEMA = 'gaia-telemetry-step-report/1';

class UsageError extends Error {}

const ALLOWED_OPTIONS = new Set([
  'portfolio', 'ledger-dir', 'telemetry-dir', 'item', 'event', 'out',
  'lane', 'agent', 'run-id', 'capacity',
]);

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
  for (const required of ['portfolio', 'ledger-dir', 'telemetry-dir', 'item', 'event', 'out']) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  if (flags.capacity !== undefined) {
    const capacity = Number(flags.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) {
      throw new UsageError('--capacity must be an integer from 1 through 4');
    }
  }
  return flags;
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new UsageError(`${label} must be readable JSON`);
  }
}

/** Keep only what an operator can act on, so the report stays evidence and not a data dump. */
function observation(phase, snapshot) {
  return {
    phase,
    observedAt: snapshot.observedAt,
    headline: snapshot.headline,
    showSpinner: snapshot.showSpinner,
    nextAction: snapshot.nextAction,
    blockers: snapshot.blockers,
    telemetry: snapshot.telemetry,
    items: snapshot.items.map(({ itemId, drainState, activity, telemetry }) => ({
      itemId, drainState, activity, telemetry,
    })),
    snapshotRevision: snapshot.revision,
  };
}

export function runFactoryTelemetryStepCli(argv, {
  now = () => new Date(),
  writeStdout = (chunk) => process.stdout.write(chunk),
} = {}) {
  const flags = parseArgs(argv);
  const ledgerDirectory = resolve(flags['ledger-dir']);
  const telemetryDirectory = resolve(flags['telemetry-dir']);
  const outPath = resolve(flags.out);
  if (ledgerDirectory === telemetryDirectory) {
    throw new UsageError('--ledger-dir and --telemetry-dir must differ');
  }
  if ([
    portfolioDrainLedgerPath(ledgerDirectory), factoryTelemetryLogPath(telemetryDirectory),
  ].includes(outPath)) {
    throw new UsageError('--out must not overwrite a durable evidence log');
  }
  const portfolio = readJson(resolve(flags.portfolio), 'portfolio');
  const capacity = flags.capacity === undefined ? 4 : Number(flags.capacity);

  const before = tickPortfolioDrain({ directory: ledgerDirectory, portfolio, capacity });
  const observations = [];
  const step = runInstrumentedDrainTransition({
    ledgerDirectory,
    telemetryDirectory,
    portfolio,
    capacity,
    itemId: flags.item,
    event: flags.event,
    ...(flags.lane === undefined ? {} : { lane: flags.lane }),
    ...(flags.agent === undefined ? {} : { agent: flags.agent }),
    ...(flags['run-id'] === undefined ? {} : { runId: flags['run-id'] }),
    now,
    observe: ({ event, log }) => {
      if (event.event !== 'run.heartbeat') return;
      const telemetryProjection = replayFactoryTelemetry({ events: log.events });
      const beatMs = Date.parse(event.observedAt);
      const fresh = buildControlRoomSnapshot({
        drainProjection: before.projection,
        observedAt: new Date(beatMs).toISOString(),
        telemetryProjection,
      });
      observations.push(observation('HEARTBEAT_FRESH', fresh));
      observations.push(observation('HEARTBEAT_EXPIRED', buildControlRoomSnapshot({
        drainProjection: before.projection,
        observedAt: new Date(beatMs + fresh.telemetry.freshnessWindowMs + 1).toISOString(),
        telemetryProjection,
      })));
    },
  });

  const after = tickPortfolioDrain({ directory: ledgerDirectory, portfolio, capacity });
  const { events } = readFactoryTelemetryLog({ directory: telemetryDirectory });
  const settledAt = events.at(-1).observedAt;
  observations.push(observation('RUN_SETTLED', buildControlRoomSnapshot({
    drainProjection: after.projection,
    observedAt: settledAt,
    telemetryProjection: replayFactoryTelemetry({ events, notAfter: settledAt }),
  })));

  const report = {
    schema: TELEMETRY_STEP_REPORT_SCHEMA,
    step,
    observations,
  };
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  writeStdout(`Gaia telemetry step: ${step.outcome} | ${step.drainStateBefore}`
    + ` -> ${step.drainStateAfter} | run ${step.runId}\n`
    + `${observations.map(({ phase, headline, showSpinner }) => (
      `  ${phase}: ${headline.state} | spinner ${showSpinner}`
    )).join('\n')}\n`);
  return report;
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  try {
    runFactoryTelemetryStepCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
