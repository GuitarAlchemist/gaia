#!/usr/bin/env node
/**
 * drain-petri-net.mjs — read the durable evidence, fold it through the two nets, and print the
 * marking, the enabled and blocked transitions with their receptivity ids and named refusals, the
 * bounded reachability check, and, when a database is named, the projection receipt.
 *
 * Usage
 *   node scripts/drain-petri-net.mjs --events <events.jsonl> --artifacts <dir>
 *     --observation-source <actor-ref> [--database <file.duckdb>]
 *
 * READ-ONLY. The bus log is read once and never locked, written, or adopted; the artifact
 * directory is read once, non-recursively, and only the title, Subject header, verdict line,
 * Family line and last line of each file are interpreted. The only write this command ever
 * performs is the rebuild of `--database`, and only when that flag is given. It spawns nothing,
 * opens no socket, and runs no provider command.
 *
 * Replay is never held hostage by reachability: the two are independent deliverables. When the
 * instantiated net's explicit reachability exceeds its bound (`ReachabilityBoundExceeded` — an
 * expected outcome once enough concurrent instances are live), that net's `reachability` field
 * names the bounded refusal by itself; the marking, the firings, and the enabled/blocked
 * transitions for every net still print and the run still exits 0.
 *
 * Exit codes: 0 ok · 2 refusal (usage error, absent optional client, invalid evidence shape) ·
 * 3 input unreadable (missing file or directory, torn or corrupt log).
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parseEventLog, CorruptLogError } from '../src/event-log.mjs';
import {
  DRAIN_NET_TEMPLATE, LANE_NET_TEMPLATE, DrainPetriNetError, checkReachability, enabledTransitions,
  instantiate, replay,
} from '../src/drain-petri-net.mjs';
import { DrainFactsError, collectDrainFacts } from '../src/drain-petri-net-facts.mjs';
import {
  DrainPetriDuckDbError, queryDrainPetriNetDuckDb, synchronizeDrainPetriNetDuckDb,
} from '../src/duckdb-drain-petri-net.mjs';

export const DRAIN_PETRI_RUN_SCHEMA = 'gaia-drain-petri-net-run/1';
export const ANALYTICAL_QUERIES = Object.freeze([
  'currentPlacePerInstance', 'timeInPlace', 'blockedByReceptivity', 'resourceContention', 'throughput',
]);

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
  }
}

export class InputUnreadableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputUnreadableError';
  }
}

const USAGE = 'usage: node scripts/drain-petri-net.mjs --events <events.jsonl> --artifacts <dir>'
  + ' --observation-source <actor-ref> [--database <file>]';

function parseArgs(argv) {
  const options = { events: null, artifacts: null, observationSource: null, database: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    const need = () => {
      if (value === undefined || value.startsWith('--')) throw new UsageError(`${token} needs a value`);
      index += 1;
      return value;
    };
    if (token === '--events') options.events = need();
    else if (token === '--artifacts') options.artifacts = need();
    else if (token === '--observation-source') options.observationSource = need();
    else if (token === '--database') options.database = need();
    else throw new UsageError(`unknown argument ${token}`);
  }
  if (options.events === null || options.artifacts === null || options.observationSource === null) {
    throw new UsageError(USAGE);
  }
  return options;
}

function readInputs({ events, artifacts }) {
  const eventsPath = resolve(events);
  let text;
  try {
    text = readFileSync(eventsPath, 'utf8');
  } catch (error) {
    throw new InputUnreadableError(`events log unreadable: ${error.code ?? error.message}`);
  }
  let records;
  try {
    records = parseEventLog(text, { source: eventsPath });
  } catch (error) {
    if (error instanceof CorruptLogError) throw new InputUnreadableError(`events log corrupt: ${error.message}`);
    throw error;
  }
  const artifactsPath = resolve(artifacts);
  let names;
  try {
    names = readdirSync(artifactsPath).filter((name) => statSync(join(artifactsPath, name)).isFile()).sort();
  } catch (error) {
    throw new InputUnreadableError(`artifact directory unreadable: ${error.code ?? error.message}`);
  }
  const files = names.map((name) => {
    try {
      return { name, bytes: readFileSync(join(artifactsPath, name)) };
    } catch (error) {
      throw new InputUnreadableError(`artifact ${name} unreadable: ${error.code ?? error.message}`);
    }
  });
  return { eventsPath, artifactsPath, records, files };
}

const nonZero = (marking) => Object.fromEntries(Object.entries(marking).filter(([, tokens]) => tokens > 0));

/**
 * Reachability is a separate deliverable from replay: an instantiated net whose reachable state
 * space exceeds the default bound (expected once enough instances are concurrently live) is
 * reported as its own named, bounded refusal, never thrown, so the marking and firings this
 * function's caller already computed from replay stay reportable regardless.
 */
function reachabilityReport(net) {
  try {
    const reachability = checkReachability(net);
    return {
      states: reachability.states,
      bound: reachability.bound,
      deadlocks: reachability.deadlocks.length,
      deadTransitions: reachability.deadTransitions,
      sound: reachability.sound,
    };
  } catch (error) {
    if (error instanceof DrainPetriNetError && error.code === 'ReachabilityBoundExceeded') {
      return { refused: true, code: error.code, message: error.message, bound: error.detail ?? null };
    }
    throw error;
  }
}

function summarizeNet(net, run) {
  const current = enabledTransitions(net, run.marking, run.facts);
  return {
    netId: net.netId,
    netRevision: net.netRevision,
    instances: [...new Set(net.places.map((place) => place.id).filter((id) => id.includes('/')).map((id) => id.slice(0, id.indexOf('/'))))].sort(),
    places: net.places.length,
    transitions: net.transitions.length,
    steps: run.history.length,
    firings: run.history.flatMap((entry) => entry.fired.map((transition) => ({ ordinal: entry.ordinal, at: entry.at, transition }))),
    marking: nonZero(run.marking),
    markingRevision: run.markingRevision,
    enabled: current.enabled,
    blocked: current.blocked,
    reachability: reachabilityReport(net),
  };
}

/** Run the CLI over one argument vector; returns the report and the exit code, printing both. */
export async function runDrainPetriNetCli(argv, {
  writeStdout = (chunk) => process.stdout.write(chunk),
  writeStderr = (chunk) => process.stderr.write(chunk),
} = {}) {
  let report = null;
  try {
    const options = parseArgs(argv);
    const inputs = readInputs(options);
    const facts = collectDrainFacts({
      records: inputs.records,
      artifacts: inputs.files,
      observationSource: options.observationSource,
    });
    const drainNet = instantiate(DRAIN_NET_TEMPLATE, facts.pullRequests);
    const laneNet = instantiate(LANE_NET_TEMPLATE, facts.lanes);
    const drainRun = replay(drainNet, facts.drainEvents);
    const laneRun = replay(laneNet, facts.laneEvents);
    report = {
      schema: DRAIN_PETRI_RUN_SCHEMA,
      inputs: {
        events: inputs.eventsPath,
        records: inputs.records.length,
        artifacts: inputs.artifactsPath,
        artifactCount: inputs.files.length,
        observationSource: options.observationSource,
        inputsRevision: facts.inputsRevision,
      },
      refused: facts.refused,
      artifacts: facts.artifacts.map(({ name, sha256, kind, pullRequest, axis, verdict, subjectSha, marker, family, refusals }) => ({
        name, sha256, kind, pullRequest: pullRequest ?? null, axis: axis ?? null, verdict: verdict ?? null,
        subjectSha: subjectSha ?? null, marker, family: family ?? null, refusals,
      })),
      nets: [summarizeNet(drainNet, drainRun), summarizeNet(laneNet, laneRun)],
      receipt: null,
      analytics: null,
      effect: 'NONE',
      authority: 'NONE',
    };
    if (options.database !== null) {
      report.receipt = await synchronizeDrainPetriNetDuckDb({
        nets: [{ net: drainNet, replay: drainRun }, { net: laneNet, replay: laneRun }],
        databasePath: options.database,
      });
      report.analytics = {};
      for (const query of ANALYTICAL_QUERIES) {
        report.analytics[query] = await queryDrainPetriNetDuckDb({ databasePath: options.database, query });
      }
      report.effect = 'ANALYTICAL_PROJECTION_REBUILT';
    }
    writeStdout(`${JSON.stringify(report, null, 2)}\n`);
    return { exitCode: 0, report };
  } catch (error) {
    if (error instanceof InputUnreadableError) {
      writeStderr(`REFUSED: INPUT_UNREADABLE ${error.message}\n`);
      return { exitCode: 3, report: null };
    }
    if (error instanceof UsageError) {
      writeStderr(`REFUSED: USAGE ${error.message}\n`);
      return { exitCode: 2, report: null };
    }
    if (error instanceof DrainPetriDuckDbError || error instanceof DrainPetriNetError || error instanceof DrainFactsError) {
      writeStderr(`REFUSED: ${error.code} ${error.message}\n`);
      return { exitCode: 2, report: null };
    }
    throw error;
  }
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  runDrainPetriNetCli(process.argv.slice(2)).then(({ exitCode }) => {
    process.exitCode = exitCode;
  }, (error) => {
    process.stderr.write(`${error?.stack ?? error}\n`);
    process.exitCode = 1;
  });
}
