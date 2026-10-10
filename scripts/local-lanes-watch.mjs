#!/usr/bin/env node
/**
 * local-lanes-watch.mjs — one command that refreshes the lane observation and the control room.
 *
 * Usage
 *   node scripts/local-lanes-watch.mjs --lanes-out <observation.json> \
 *        --portfolio <p.json> --html-out <h.html> --snapshot-out <s.json> \
 *        [--interval-ms 5000] [--wmux <path>] [...any factory-dashboard flag]
 *
 * WHY THIS HOLDS NO MECHANISM
 * ---------------------------
 * An independent pair recommended deleting this script: the repository already owns two watch
 * loops, and a third that spawns a subprocess on a timer is new orchestration and new cancellation
 * semantics for no new truth. That concern is accepted; the conclusion is not, because a
 * one-command local watcher is an acceptance criterion of the operator brief this slice answers.
 * So the concern constrains the script instead:
 *
 *   - **No mechanism of its own.** One tick calls `runLocalLaneSensorCli` and then
 *     `runFactoryDashboardCli`, in this process. The only subprocesses anywhere are the wmux
 *     reads the sensor already makes: `wmux agent list`, and `wmux agent-state` under `--activity`.
 *   - **Non-overlapping.** The next tick is scheduled after the current one settles, so a slow
 *     tick delays the next rather than racing it.
 *   - **No retry.** A failed tick prints its typed error, leaves the previous artifacts exactly
 *     where they are, and waits for the next interval. That includes an input the control room
 *     cannot read yet, absent or half-written, which it reports as its UsageError. An argument
 *     error is the same on every tick, so the watcher's, the sensor's and the control room's
 *     arguments are parsed once before the first tick, and an error there stops the watcher with
 *     exit 2. A retry loop around a subprocess is the thing this product rules out elsewhere by
 *     name.
 *   - **Bounded and stoppable.** The interval is explicit, capped at half the observation
 *     freshness window so no legal configuration can render permanently stale, and SIGINT or
 *     SIGTERM ends it.
 *
 * No network, no provider, no install, no push, no publish, no global configuration change.
 *
 * Exit codes: 0 ok · 1 refused · 2 usage.
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { LOCAL_LANE_OBSERVATION_FRESH_MS } from '../src/local-lane-observation.mjs';
import { parseArgs as parseDashboardArgs, runFactoryDashboardCli } from './factory-dashboard.mjs';
import { parseArgs as parseSensorArgs, runLocalLaneSensorCli } from './local-lane-sensor.mjs';

/**
 * At most half the window the control room ages the observation against.
 *
 * At a longer interval the observation is older than the window for part of every cycle, and the
 * page shows stale lanes with no pulse while panes are visibly running — a softer restatement of
 * the exact operator complaint this slice exists to fix. The bound makes that unreachable rather
 * than merely discouraged.
 */
export const MAX_WATCH_INTERVAL_MS = LOCAL_LANE_OBSERVATION_FRESH_MS / 2;
export const MIN_WATCH_INTERVAL_MS = 1_000;
export const DEFAULT_WATCH_INTERVAL_MS = 5_000;

/**
 * Consumed here; everything else is forwarded to the dashboard adapter untouched.
 *
 * `--bindings` is owned rather than forwarded on purpose. An artifact binding names a local path,
 * an allowed root and a completion marker, and every one of those belongs to the server-side
 * sensor. The dashboard adapter renders a page a browser reads: handing it a binding file would
 * be the first step towards a page that opens local files, which docs/artifact-completion-signals.md
 * rules out by name.
 *
 * `--activity` is owned for a simpler reason: it names a wmux read, and only the sensor reads wmux.
 */
const OWN_FLAGS = new Set(['lanes-out', 'interval-ms', 'wmux', 'bindings', 'activity']);

export class UsageError extends Error { name = 'UsageError'; }

export function parseArgs(argv) {
  const own = {};
  const forwarded = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    const value = argv[index += 1];
    if (value === undefined) throw new UsageError(`--${name} needs a value`);
    if (OWN_FLAGS.has(name)) own[name] = value;
    else forwarded.push(token, value);
  }
  if (!own['lanes-out']) throw new UsageError('missing --lanes-out');
  if (forwarded.includes('--local-lanes')) {
    throw new UsageError('--local-lanes is supplied by this watcher; pass --lanes-out instead');
  }
  const interval = own['interval-ms'] === undefined
    ? DEFAULT_WATCH_INTERVAL_MS : Number(own['interval-ms']);
  if (!Number.isSafeInteger(interval)
      || interval < MIN_WATCH_INTERVAL_MS || interval > MAX_WATCH_INTERVAL_MS) {
    throw new UsageError(
      `--interval-ms must be an integer from ${MIN_WATCH_INTERVAL_MS} through`
      + ` ${MAX_WATCH_INTERVAL_MS}, which is half the ${LOCAL_LANE_OBSERVATION_FRESH_MS}ms`
      + ' observation window: a longer interval would render lanes stale that are running',
    );
  }
  return { own, forwarded, interval };
}

/** The argv a tick hands the sensor and the control room. */
function stepArgv({ own, forwarded }) {
  const lanesOut = resolve(own['lanes-out']);
  return {
    sensor: [
      '--out', lanesOut,
      ...(own.bindings ? ['--bindings', own.bindings] : []),
      ...(own.activity ? ['--activity', own.activity] : []),
      ...(own.wmux ? ['--wmux', own.wmux] : []),
    ],
    dashboard: [...forwarded, '--local-lanes', lanesOut],
  };
}

/** The watcher's, the sensor's and the control room's argument errors, all raised here, before a tick. */
function parseAllArgs(argv) {
  const parsed = parseArgs(argv);
  const { sensor, dashboard } = stepArgv(parsed);
  parseSensorArgs(sensor);
  parseDashboardArgs(dashboard);
  return parsed;
}

/** One tick: refresh the observation, then republish the control room over it. */
export function runLocalLanesTick(argv, options = {}) {
  const { sensor, dashboard } = stepArgv(parseArgs(argv));
  const observation = runLocalLaneSensorCli(sensor, options);
  const snapshot = runFactoryDashboardCli(dashboard, options);
  return { observation, snapshot };
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  const argv = process.argv.slice(2);
  let interval;
  try {
    ({ interval } = parseAllArgs(argv));
  } catch (error) {
    process.stderr.write(`${error.name}: ${error.message}\n`);
    process.exit(2);
  }

  let timer = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (timer !== null) clearTimeout(timer);
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);

  // Scheduled after the tick settles, never on a fixed interval, so a slow tick delays the next
  // one instead of overlapping it. The arguments passed above, so a failure here comes from an
  // input that can change by the next tick: it is reported and waited out, never run again early.
  const tick = () => {
    try {
      runLocalLanesTick(argv);
    } catch (error) {
      process.stderr.write(`${error.name}: ${error.message}\n`);
      process.exitCode = 1;
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  tick();
}
