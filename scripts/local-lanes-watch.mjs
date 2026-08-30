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
 *     `runFactoryDashboardCli`, in this process. The only subprocess anywhere is the single
 *     `wmux agent list` the sensor already makes.
 *   - **Non-overlapping.** The next tick is scheduled after the current one settles, so a slow
 *     tick delays the next rather than racing it.
 *   - **No retry.** A failed tick prints its typed error, leaves the previous artifacts exactly
 *     where they are, and waits for the next interval. A retry loop around a subprocess is the
 *     thing this product rules out elsewhere by name.
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
import { runFactoryDashboardCli } from './factory-dashboard.mjs';
import { runLocalLaneSensorCli } from './local-lane-sensor.mjs';

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

/** Consumed here; everything else is forwarded to the dashboard adapter untouched. */
const OWN_FLAGS = new Set(['lanes-out', 'interval-ms', 'wmux']);

export class UsageError extends Error {}

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

/** One tick: refresh the observation, then republish the control room over it. */
export function runLocalLanesTick(argv, options = {}) {
  const { own, forwarded } = parseArgs(argv);
  const lanesOut = resolve(own['lanes-out']);
  const observation = runLocalLaneSensorCli(
    ['--out', lanesOut, ...(own.wmux ? ['--wmux', own.wmux] : [])],
    options,
  );
  const snapshot = runFactoryDashboardCli([...forwarded, '--local-lanes', lanesOut], options);
  return { observation, snapshot };
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) {
  const argv = process.argv.slice(2);
  let interval;
  try {
    ({ interval } = parseArgs(argv));
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
  // one instead of overlapping it. A failure is reported and waited out; it is never retried.
  const tick = () => {
    try {
      runLocalLanesTick(argv);
    } catch (error) {
      process.stderr.write(`${error.name}: ${error.message}\n`);
      process.exitCode = error instanceof UsageError ? 2 : 1;
      if (error instanceof UsageError) { stop(); return; }
    }
    if (!stopped) timer = setTimeout(tick, interval);
  };
  tick();
}
