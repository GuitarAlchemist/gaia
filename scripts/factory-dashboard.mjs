import {
  existsSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  CONTROL_ROOM_SCHEMA, buildControlRoomSnapshot, renderControlRoomHtml,
} from '../src/control-room.mjs';
import {
  factoryTelemetryLogPath, projectFactoryTelemetryLog,
} from '../src/factory-telemetry-log.mjs';
import { reconcilePortfolioDrain } from '../src/portfolio-drain.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new UsageError('expected paired --name value arguments');
    }
    flags[name.slice(2)] = value;
  }
  for (const required of ['html-out', 'snapshot-out']) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  if (Boolean(flags.projection) === Boolean(flags.portfolio)) {
    throw new UsageError('supply exactly one of --projection or --portfolio');
  }
  if (flags.capacity !== undefined) {
    const capacity = Number(flags.capacity);
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 4) {
      throw new UsageError('--capacity must be an integer from 1 through 4');
    }
  }
  if (flags['watch-ms'] !== undefined) {
    const interval = Number(flags['watch-ms']);
    if (!Number.isSafeInteger(interval) || interval < 1_000 || interval > 60_000) {
      throw new UsageError('--watch-ms must be an integer from 1000 through 60000');
    }
  }
  if (flags.language !== undefined && !['en', 'fr'].includes(flags.language)) {
    throw new UsageError('--language must be en or fr');
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

function readProgress(path, projection) {
  if (!path) return [];
  let records;
  try {
    records = readFileSync(path, 'utf8').split(/\r?\n/u).filter(Boolean).map(JSON.parse);
  } catch {
    throw new UsageError('progress must be readable JSON Lines');
  }
  const capturedAt = statSync(path).mtime.toISOString();
  const rawRecords = records.filter(({ schema } = {}) => schema !== 'gaia-control-room-progress-observation/1');
  if (rawRecords.length > 0 && records.length > 1) {
    throw new UsageError(
      'multiple raw progress records are ambiguous; use explicit progress observation envelopes',
    );
  }
  const active = projection.items.filter(
    ({ drainState }) => drainState === 'CLAIMED' || drainState === 'RUNNING',
  );
  return records.map((value) => {
    if (value?.schema === 'gaia-control-room-progress-observation/1') {
      return { itemId: value.itemId, capturedAt: value.capturedAt, record: value.record };
    }
    if (active.length !== 1) {
      throw new UsageError(
        'raw gaia-cli-progress/1 is ambiguous unless exactly one drain item is active',
      );
    }
    return { itemId: active[0].itemId, capturedAt, record: value };
  });
}

function newestMtime(paths) {
  return new Date(Math.max(...paths.filter(Boolean).map((path) => statSync(path).mtimeMs)))
    .toISOString();
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * The instant from which a publisher can show it had already observed this exact projection
 * revision, read out of the control-room snapshot it published to `snapshotPath` last time.
 *
 * The carrier is the published artifact and nothing else — no private state store — so an
 * ordinary process restart, or the next tick of a watch loop, resumes the window from bytes an
 * operator and every downstream consumer can read too. A snapshot that is missing, unreadable,
 * not a control-room body, or pinned to a different projection revision is "no prior
 * observation", and the window restarts. That direction only ever delays a stall, never invents
 * one.
 */
export function firstObservationOf(snapshotPath, projectionRevision) {
  let published;
  try {
    published = JSON.parse(readFileSync(snapshotPath, 'utf8'));
  } catch {
    return null;
  }
  if (published?.schema !== CONTROL_ROOM_SCHEMA
      || published.sourceRevision !== projectionRevision
      || typeof published.sourceChangedAt !== 'string') {
    return null;
  }
  return published.sourceChangedAt;
}

/**
 * Where the observation window starts, for the file-fed path.
 *
 * The window is the interval over which this publisher has continuously observed this exact
 * content-addressed projection revision — a measured lower bound on the age of the evidence,
 * never a claim about when the upstream world changed. Its own previous publication is the
 * strongest such evidence, so it wins: a byte-identical rewrite of an input moves the mtime but
 * changes no evidence, and the window must not restart for it.
 *
 * Failing that, the newest input mtime is used, but only where it is usable evidence of *earlier*
 * observation. An mtime after the observation instant shows nothing about how long this revision
 * has been in force, so it is discarded rather than asserted: this publisher reports that it has
 * observed this revision for zero measured duration so far, and the next invocation over an
 * unchanged revision grows the window from here. Note this is a decision about what evidence the
 * adapter *has*, taken before any measurement; `buildControlRoomSnapshot` still refuses outright
 * any caller that hands it evidence dated after the instant it was observed.
 *
 * An adapter that writes its own inputs on every tick, such as the GitHub refresh, cannot use an
 * mtime for this at all and supplies its own resolver.
 */
const fileFedSourceChangedAt = ({ firstObservation, observedAt, newestInputChangedAt }) => {
  if (firstObservation !== null) return firstObservation;
  return Date.parse(newestInputChangedAt) > Date.parse(observedAt)
    ? observedAt : newestInputChangedAt;
};

export function runFactoryDashboardCli(argv, {
  now = () => new Date(),
  resolveSourceChangedAt = fileFedSourceChangedAt,
  writeStdout = (chunk) => process.stdout.write(chunk),
} = {}) {
  const flags = parseArgs(argv);
  const projectionPath = flags.projection ? resolve(flags.projection) : null;
  const portfolioPath = flags.portfolio ? resolve(flags.portfolio) : null;
  const receiptsPath = flags.receipts ? resolve(flags.receipts) : null;
  const holdsPath = flags.holds ? resolve(flags.holds) : null;
  const dependenciesPath = flags.dependencies ? resolve(flags.dependencies) : null;
  const progressPath = flags.progress ? resolve(flags.progress) : null;
  const historyPath = flags.history ? resolve(flags.history) : null;
  const telemetryPath = flags.telemetry ? resolve(flags.telemetry) : null;
  const htmlPath = resolve(flags['html-out']);
  const snapshotPath = resolve(flags['snapshot-out']);
  if (htmlPath === snapshotPath) throw new UsageError('HTML and snapshot outputs must differ');

  const projection = projectionPath
    ? readJson(projectionPath, 'projection')
    : reconcilePortfolioDrain({
      portfolio: readJson(portfolioPath, 'portfolio'),
      receipts: receiptsPath ? readJson(receiptsPath, 'receipts') : [],
      holds: holdsPath ? readJson(holdsPath, 'holds') : [],
      capacity: flags.capacity === undefined ? 4 : Number(flags.capacity),
    });
  const progressObservations = readProgress(progressPath, projection);
  const completedRuns = historyPath ? readJson(historyPath, 'history') : [];
  const observedAt = now().toISOString();
  // The spine is replayed at this exact instant, so a fact recorded after it fails closed
  // instead of quietly animating a dashboard that has already been rendered.
  const telemetryLogPath = telemetryPath === null
    || !existsSync(factoryTelemetryLogPath(telemetryPath))
    ? null
    : factoryTelemetryLogPath(telemetryPath);
  const telemetryProjection = telemetryPath === null
    ? null
    : projectFactoryTelemetryLog({ directory: telemetryPath, notAfter: observedAt }).projection;
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection,
    progressObservations,
    completedRuns,
    telemetryProjection,
    // Declared edges only. This adapter reads a file of explicit dependency evidence; it
    // never derives an edge from an issue title, body, label or model output.
    dependencies: dependenciesPath === null
      ? null
      : readJson(dependenciesPath, 'dependencies'),
    observedAt,
    sourceChangedAt: resolveSourceChangedAt({
      projectionRevision: projection.revision,
      firstObservation: firstObservationOf(snapshotPath, projection.revision),
      observedAt,
      newestInputChangedAt: newestMtime([
        projectionPath, portfolioPath, receiptsPath, holdsPath, progressPath, historyPath,
        telemetryLogPath, dependenciesPath,
      ]),
    }),
  });
  writeFileSync(snapshotPath, serialize(snapshot), 'utf8');
  writeFileSync(htmlPath, renderControlRoomHtml(snapshot, {
    language: flags.language ?? 'en',
  }), 'utf8');
  writeStdout(`Gaia dashboard checked: ${snapshot.headline.state}`
    + ` | obstruction ${snapshot.obstruction.state}`
    + ` | next ${snapshot.nextAction.kind} | source ${snapshot.sourceRevision}\n`);
  return snapshot;
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  const argv = process.argv.slice(2);
  const tick = () => {
    try {
      runFactoryDashboardCli(argv);
    } catch (error) {
      process.stderr.write(`${error.name}: ${error.message}\n`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
    }
  };
  tick();
  const watchIndex = argv.indexOf('--watch-ms');
  if (watchIndex !== -1 && process.exitCode === undefined) {
    const handle = setInterval(tick, Number(argv[watchIndex + 1]));
    process.once('SIGINT', () => { clearInterval(handle); });
    process.once('SIGTERM', () => { clearInterval(handle); });
  }
}
