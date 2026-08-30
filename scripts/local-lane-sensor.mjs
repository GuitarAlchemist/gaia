#!/usr/bin/env node
/**
 * local-lane-sensor.mjs — read the local wmux lanes once, and write one bounded observation.
 *
 * This is the process boundary and nothing else. All the meaning lives in
 * `src/local-lane-sensor.mjs` (structured metadata to sealed observation) and
 * `src/local-lane-observation.mjs` (the closed schema and its verifier); this file resolves a
 * binary, runs one command, parses one JSON document and writes one file.
 *
 * Usage
 *   node scripts/local-lane-sensor.mjs --out <path> [--wmux <path>]
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * The argv it can construct is exactly `agent list`, built from a frozen constant rather than
 * assembled from flags, so there is no input that makes this send text to a pane, spawn or kill an
 * agent, read a screen, drive a browser or close a surface. It passes no `--workspace`, so it
 * observes every workspace — which is the whole point, since the operator's reviews were spread
 * across two. `shell: false` is explicit: nothing here is interpreted by a shell.
 *
 * It reads. It writes exactly one file, at a path the operator named. It never retries: a failed
 * read is a typed refusal that leaves the previous observation exactly where it was, because a
 * stale observation the page marks stale is better than a retry loop hidden in a sensor.
 *
 * Exit codes: 0 ok · 1 refused · 2 usage.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { observeLocalLanes } from '../src/local-lane-sensor.mjs';

/** The one invocation this sensor can make. Frozen so no flag can extend it. */
export const WMUX_LANE_ARGV = Object.freeze(['agent', 'list']);

/**
 * Where the wmux CLI actually lives, resolved without a shell.
 *
 * The `wmux` and `wmux.cmd` entries on PATH are shims whose whole body is `node <cli>/wmux.js`.
 * Neither is directly spawnable here: the extensionless one is not executable on Windows, and
 * `spawnSync` refuses a `.cmd` outright unless a shell is involved — which this product does not
 * do, because a shell is a transport primitive its own acceptance check forbids.
 *
 * So the sensor targets the Node entry point the shims target. `WMUX_CLI` is the variable wmux
 * itself injects into every shell it spawns and is therefore the most authoritative answer;
 * the install path beside the shim is the fallback for a session wmux did not start; a bare
 * `wmux` is the last resort, which works where the platform can execute the shim directly.
 */
const DEFAULT_WMUX_PATHS = Object.freeze([
  process.env.WMUX_CLI,
  'C:\\Program Files\\wmux\\resources\\cli\\wmux.js',
].filter(Boolean));

const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const READ_TIMEOUT_MS = 10_000;

export class UsageError extends Error {}
export class SensorRefusalError extends Error {}

const KNOWN_FLAGS = new Set(['out', 'wmux']);

export function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!KNOWN_FLAGS.has(name)) throw new UsageError(`unknown flag: ${token}`);
    const value = argv[index += 1];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    flags[name] = value;
  }
  if (!flags.out) throw new UsageError('missing --out');
  return flags;
}

function resolveWmux(explicit) {
  if (explicit) return resolve(explicit);
  return DEFAULT_WMUX_PATHS.find((candidate) => existsSync(candidate)) ?? 'wmux';
}

/**
 * Run `wmux agent list` once and return its parsed payload.
 *
 * Silence is not an empty result and neither is a non-zero exit: both are refusals, because an
 * observation that quietly reports zero lanes is indistinguishable from the operator failure this
 * sensor exists to fix.
 */
function readAgentsFromWmux(wmuxPath) {
  // A `.mjs` or `.js` target runs under this Node binary, which is what gives the test suite a
  // real process seam without a live wmux.
  const runner = /\.[cm]?js$/u.test(wmuxPath) ? process.execPath : wmuxPath;
  const args = /\.[cm]?js$/u.test(wmuxPath) ? [wmuxPath, ...WMUX_LANE_ARGV] : [...WMUX_LANE_ARGV];
  const result = spawnSync(runner, args, {
    encoding: 'utf8', shell: false, timeout: READ_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES,
  });
  if (result.error) {
    throw new SensorRefusalError(`wmux could not be run at ${wmuxPath}: ${result.error.message}`);
  }
  const out = (result.stdout ?? '').trim();
  if (result.status !== 0) {
    throw new SensorRefusalError(
      `wmux agent list exited ${result.status}: ${(result.stderr ?? out).trim().slice(0, 400)}`,
    );
  }
  if (!out) {
    throw new SensorRefusalError('wmux agent list returned no output; refusing to read silence as zero lanes');
  }
  let payload;
  try {
    payload = JSON.parse(out);
  } catch {
    throw new SensorRefusalError('wmux agent list returned output this sensor cannot parse as structured metadata');
  }
  if (!payload || !Array.isArray(payload.agents)) {
    throw new SensorRefusalError("wmux agent list returned no exact 'agents' array; failing closed");
  }
  return payload.agents;
}

export function runLocalLaneSensorCli(argv, {
  now = () => new Date(),
  readAgents = readAgentsFromWmux,
  writeStdout = (chunk) => process.stdout.write(chunk),
} = {}) {
  const flags = parseArgs(argv);
  const outPath = resolve(flags.out);
  const wmuxPath = resolveWmux(flags.wmux);

  const observation = observeLocalLanes({
    agents: readAgents(wmuxPath),
    observedAt: now().toISOString(),
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
  const running = observation.lanes.filter(({ lifecycle }) => lifecycle === 'RUNNING').length;
  writeStdout(
    `Local wmux lanes observed: ${observation.lanes.length}`
    + ` | running ${running}`
    + ` | workspaces ${new Set(observation.lanes.map(({ workspaceId }) => workspaceId)).size}`
    + ` | observation ${observation.revision}\n`,
  );
  return observation;
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  try {
    runLocalLaneSensorCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exitCode = error instanceof UsageError ? 2 : 1;
  }
}
