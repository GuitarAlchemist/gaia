/**
 * wmux-claude-telemetry-bridge.mjs - the thin wrapper that binds one bounded wmux/Claude task
 * to the generic phase sensor.
 *
 * This is deliberately the smallest possible adapter and it holds no mechanism of its own. It
 * opens a run, hands the task a `beat` it may call whenever it is genuinely still alive,
 * closes the run on the task's own closed outcome, and returns. Everything durable happens in
 * `factory-telemetry-phase.mjs`, which is this module's only import.
 *
 * What it must never become is a second control plane, so:
 *
 *   - it launches nothing. The bounded task is supplied by the caller; the bridge never spawns
 *     a process, opens a pane, drives wmux or calls a provider.
 *   - it reads nothing. No screen capture, no prompt, no reasoning trace, no terminal output.
 *     The task reports itself with one closed token and that is the whole channel.
 *   - it infers nothing. A task that neither beats nor returns a readable outcome leaves the
 *     run open, which the control room shows as an expired heartbeat. That is the truth.
 *   - it launders nothing. A thrown infrastructure failure is re-thrown untouched rather than
 *     recorded as a named task blockage, because the task was never actually evaluated.
 *
 * `beat()` is the only reason this wrapper exists rather than four separate CLI calls: a long
 * task can prove its own liveness from inside without the observer inventing it.
 */

import { recordFactoryTelemetryPhase } from './factory-telemetry-phase.mjs';

export const WMUX_CLAUDE_BRIDGE_RECEIPT_SCHEMA = 'gaia-wmux-claude-bridge-receipt/1';

/** The closed outcome vocabulary a wrapped task may report about itself. */
export const WMUX_CLAUDE_TASK_OUTCOMES = Object.freeze(['COMPLETED', 'BLOCKED']);

const TOKEN = /^[A-Z][A-Z0-9_]{0,31}$/u;

export class WmuxClaudeBridgeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WmuxClaudeBridgeError';
    this.code = code;
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/**
 * Read the task's report of itself, or refuse. An unreadable answer is not a blocked run and
 * not a completed one; it is an observation the bridge does not have, so it records neither.
 */
function requireOutcome(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !WMUX_CLAUDE_TASK_OUTCOMES.includes(value.outcome)) {
    throw new WmuxClaudeBridgeError(
      'BridgeOutcomeUnknown',
      `a wrapped task must report exactly one of ${WMUX_CLAUDE_TASK_OUTCOMES.join(', ')}`,
    );
  }
  if (value.outcome === 'COMPLETED') return { outcome: 'COMPLETED', blocker: null };
  if (typeof value.blocker !== 'string' || !TOKEN.test(value.blocker)) {
    throw new WmuxClaudeBridgeError(
      'BridgeOutcomeUnknown', 'a blocked task must name its blocker as a canonical token',
    );
  }
  return { outcome: 'BLOCKED', blocker: value.blocker };
}

/**
 * Observe one bounded wmux/Claude task through the generic phase seam.
 *
 * The task receives `{ beat }` and returns `{ outcome: 'COMPLETED' }` or
 * `{ outcome: 'BLOCKED', blocker: TOKEN }`. It may call `beat()` as often as it is truthfully
 * still working; each call is one real `run.heartbeat` in the durable log and nothing else.
 */
export function observeWmuxClaudeTask({
  telemetryDirectory,
  runId,
  subject,
  gate = 'WMUX_CLAUDE_TASK',
  task,
  evidenceRevision = 'UNKNOWN',
  now = () => new Date(),
  lockOptions,
}) {
  if (typeof task !== 'function') {
    throw new WmuxClaudeBridgeError(
      'BridgeTaskInvalid', 'the wrapped task must be a caller-supplied function',
    );
  }
  const record = (phase, extra = {}) => recordFactoryTelemetryPhase({
    directory: telemetryDirectory, runId, phase, now, lockOptions, ...extra,
  });

  record('start', { subject, evidenceRevision });
  record('heartbeat');
  record('gate-entered', { gate });

  let beats = 0;
  // Only the task may assert its own liveness, and only while it is genuinely running.
  const beat = () => {
    beats += 1;
    return record('heartbeat');
  };
  const reported = requireOutcome(task({ beat }));

  const closed = reported.outcome === 'COMPLETED'
    ? [record('gate-passed', { gate, evidenceRevision }), record('finish', { evidenceRevision })]
    : [
      record('gate-failed', { gate, evidenceRevision }),
      record('block', { blocker: reported.blocker }),
    ];
  const terminal = closed.at(-1);

  return deepFreeze({
    schema: WMUX_CLAUDE_BRIDGE_RECEIPT_SCHEMA,
    runId,
    gate,
    outcome: reported.outcome,
    blocker: reported.blocker,
    beats,
    runState: terminal.runState,
    logRevision: terminal.logRevision,
    settledAt: terminal.observedAt,
    effect: 'LOCAL_TELEMETRY_APPEND',
    authority: 'NONE',
  });
}
