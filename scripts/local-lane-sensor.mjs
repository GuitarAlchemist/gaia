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
 *   node scripts/local-lane-sensor.mjs --out <path> [--wmux <path>] [--bindings <path>]
 *
 * WHAT IT WILL NOT DO
 * -------------------
 * The argv it can construct is exactly `agent list`, built from a frozen constant rather than
 * assembled from flags, so there is no input that makes this send text to a pane, spawn or end an
 * agent, read a screen, drive a browser or shut a surface. It passes no `--workspace`, so it
 * observes every workspace — which is the whole point, since the operator's reviews were spread
 * across two. `shell: false` is explicit: nothing here is interpreted by a shell.
 *
 * It reads. It writes exactly one file, at a path the operator named. It never retries: a failed
 * read is a typed refusal that leaves the previous observation exactly where it was, because a
 * stale observation the page marks stale is better than a retry loop hidden in a sensor.
 *
 * THE ARTIFACT COMPLETION AXIS
 * ----------------------------
 * `--bindings` is the ONE way an artifact binding reaches this sensor. There is no environment
 * variable, no discovered default location and no implicit search, and nothing here consults a
 * working directory, a source-control ref, a process tree, a pane label, a prompt or a timing to
 * guess one. An operator who did not pass the flag gets UNBOUND on every lane, which is true.
 *
 * Three reads join the wmux read, in this order, and every one of them fails closed:
 *
 *   1. the previous observation at `--out`, so a generation can be reasoned about across ticks. A
 *      corrupt one refuses the tick rather than reading as absence, because reading it as absence
 *      is precisely the edit that would reset a refusal back to running;
 *   2. the binding document, verified in full including its re-derived revision. A corrupt one
 *      refuses the tick rather than degrading to "no bindings", which is a downgrade an attacker
 *      could cause by writing one bad byte;
 *   3. each bound artifact, twice, beneath a fence that is re-checked after symlinks resolve.
 *
 * docs/artifact-completion-signals.md is the normative contract for all three.
 *
 * Exit codes: 0 ok · 1 refused · 2 usage.
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  MAX_ARTIFACT_BYTES, isBoundArtifactPath, laneOrderKey,
  requireLaneArtifactBindings, requireLocalLaneObservation,
} from '../src/local-lane-observation.mjs';
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

const KNOWN_FLAGS = new Set(['out', 'wmux', 'bindings']);

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

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * One bound artifact to one closed evidence outcome. This is the only place a file is opened.
 *
 * The lexical fence lives in the schema module and has already passed by the time a binding gets
 * here; what this adds is the PHYSICAL fence that a lexical rule cannot enforce. A path that is
 * safely spelled can still be a symlink out of the root, so both ends are resolved and the
 * containment is re-checked against what the filesystem actually points at.
 *
 * Then it reads twice. A provider writing its handoff while the sensor observes it would
 * otherwise be read as a finished document that happens to end mid-marker, and two digests that
 * disagree is the cheapest possible proof that the bytes were moving.
 */
export function readArtifactEvidence(binding, { readBytes = readFileSync } = {}) {
  const refused = (reason) => ({ outcome: 'REFUSED', reason });
  let link;
  try {
    link = lstatSync(binding.artifactPath);
  } catch (error) {
    return error.code === 'ENOENT' ? { outcome: 'ABSENT' } : refused('ARTIFACT_UNREADABLE');
  }
  if (!link.isFile() && !link.isSymbolicLink()) return refused('NOT_A_REGULAR_FILE');

  let realRoot;
  let realArtifact;
  try {
    realRoot = realpathSync(binding.allowedRoot);
    realArtifact = realpathSync(binding.artifactPath);
  } catch (error) {
    return error.code === 'ENOENT' ? refused('PATH_ESCAPES_ALLOWED_ROOT') : refused('ARTIFACT_UNREADABLE');
  }
  if (!isBoundArtifactPath({ allowedRoot: realRoot, artifactPath: realArtifact })) {
    return refused('PATH_ESCAPES_ALLOWED_ROOT');
  }

  let target;
  try {
    target = statSync(realArtifact);
  } catch {
    return refused('ARTIFACT_UNREADABLE');
  }
  if (!target.isFile()) return refused('NOT_A_REGULAR_FILE');
  if (target.size > MAX_ARTIFACT_BYTES) return refused('ARTIFACT_TOO_LARGE');

  let first;
  let second;
  try {
    first = readBytes(realArtifact);
    second = readBytes(realArtifact);
  } catch {
    return refused('ARTIFACT_UNREADABLE');
  }
  if (first.length > MAX_ARTIFACT_BYTES || second.length > MAX_ARTIFACT_BYTES) {
    return refused('ARTIFACT_TOO_LARGE');
  }
  const digest = sha256(first);
  if (sha256(second) !== digest) return refused('ARTIFACT_UNSTABLE');

  // Fatal decoding, so bytes that are not text are refused rather than replaced with U+FFFD and
  // then searched for a marker they could never have contained.
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(first);
  } catch {
    return refused('ARTIFACT_UNREADABLE');
  }
  return { outcome: 'READ', digest, text };
}

/** Every bound artifact, keyed with the product one lane order key rather than a second one. */
function readAllArtifactEvidence(bindings, options) {
  return new Map(bindings.map(
    (binding) => [laneOrderKey(binding), readArtifactEvidence(binding, options)],
  ));
}

/** The operator's statement, verified in full, or a refusal. It never degrades to no bindings. */
function readLaneArtifactBindings(bindingsPath) {
  let raw;
  try {
    raw = readFileSync(bindingsPath, 'utf8');
  } catch (error) {
    throw new SensorRefusalError(
      `the lane artifact binding file at ${bindingsPath} could not be read`
      + ` (${error.code ?? error.message}); refusing rather than observing nothing`,
    );
  }
  let document;
  try {
    document = JSON.parse(raw);
  } catch {
    throw new SensorRefusalError(
      `the lane artifact binding file at ${bindingsPath} is not parseable JSON; failing closed`,
    );
  }
  try {
    return requireLaneArtifactBindings(document).bindings;
  } catch (error) {
    throw new SensorRefusalError(
      `the lane artifact binding file at ${bindingsPath} is not a Gaia binding document:`
      + ` ${error.message}`,
    );
  }
}

/**
 * The previous tick's task states, which is what makes a transition monotonic across ticks.
 *
 * A missing file is genuinely absence and starts every generation at zero. A corrupt one is not:
 * treating it as absence is the single edit that would reset a sticky refusal back to running,
 * so it refuses the tick and leaves the file exactly where it is.
 */
function readPreviousTaskStates(outPath, observedAt) {
  let raw;
  try {
    raw = readFileSync(outPath, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new SensorRefusalError(
      `the previous observation at ${outPath} could not be read (${error.code ?? error.message})`,
    );
  }
  let previous;
  try {
    previous = requireLocalLaneObservation(JSON.parse(raw));
  } catch (error) {
    throw new SensorRefusalError(
      `the previous observation at ${outPath} is not a Gaia local lane observation:`
      + ` ${error.message}; refusing rather than reading a corrupt history as absence`,
    );
  }
  if (Date.parse(previous.observedAt) > Date.parse(observedAt)) {
    throw new SensorRefusalError(
      `the previous observation at ${outPath} is dated ${previous.observedAt}, after the instant`
      + ` it is being read at, ${observedAt}; a clock or a sensor timestamp is wrong`,
    );
  }
  return previous.taskStates ?? [];
}

export function runLocalLaneSensorCli(argv, {
  now = () => new Date(),
  readAgents = readAgentsFromWmux,
  readBytes,
  writeStdout = (chunk) => process.stdout.write(chunk),
} = {}) {
  const flags = parseArgs(argv);
  const outPath = resolve(flags.out);
  const wmuxPath = resolveWmux(flags.wmux);
  const observedAt = now().toISOString();

  const previousTaskStates = readPreviousTaskStates(outPath, observedAt);
  const bindings = flags.bindings === undefined
    ? [] : readLaneArtifactBindings(resolve(flags.bindings));
  const agents = readAgents(wmuxPath);
  const artifactEvidence = readAllArtifactEvidence(
    bindings, readBytes === undefined ? {} : { readBytes },
  );

  const observation = observeLocalLanes({
    agents, observedAt, bindings, artifactEvidence, previousTaskStates,
  });

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(observation, null, 2)}\n`, 'utf8');
  const running = observation.lanes.filter(({ lifecycle }) => lifecycle === 'RUNNING').length;
  const tally = (state) => observation.taskStates.filter((entry) => entry.taskState === state).length;
  writeStdout(
    `Local wmux lanes observed: ${observation.lanes.length}`
    + ` | running ${running}`
    + ` | workspaces ${new Set(observation.lanes.map(({ workspaceId }) => workspaceId)).size}`
    + ` | bound ${bindings.length}`
    + ` | marker evidence ${tally('COMPLETED_EVIDENCE')}`
    + ` | evidence refused ${tally('REFUSED_EVIDENCE')}`
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
