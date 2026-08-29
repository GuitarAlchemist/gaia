/**
 * Best-effort CLI progress for bounded provider pipelines.
 *
 * The records are intentionally closed and contain no caller or provider text. The
 * time bound is only the maximum time still available to provider invocations; it is
 * not an estimate of wall-clock completion and excludes local validation/persistence.
 */

const SCHEMA = 'gaia-cli-progress/1';
const MAX_PROVIDER_INVOCATIONS = 4;
const PROGRESS_FORMATS = new Set(['human', 'jsonl']);
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES']);
const OUTCOMES = new Set([
  'COMPLETED', 'REJECTED', 'FAILED', 'CANDIDATE_READY', 'CANDIDATE_REJECTED',
  'EXECUTION_FAILED', 'REFUSED', 'UNKNOWN',
]);
const HUMAN_STAGES = Object.freeze({
  validating: 'Validating run',
  execution_starting: 'Starting execution',
  authorized_execution: 'Authorized execution starting',
  worker_running: 'Worker running',
  worker_completed: 'Worker completed',
  initial_review_running: 'Initial review running',
  initial_review_verdict: 'Initial review verdict',
  repair_running: 'Repair running',
  repair_completed: 'Repair completed',
  final_review_running: 'Final review running',
  final_review_verdict: 'Final review verdict',
  terminal_outcome: 'Run finished',
});
const DEFAULT_SCHEDULER = Object.freeze({
  start(callback, intervalMs) {
    const handle = setInterval(callback, intervalMs);
    handle.unref();
    return handle;
  },
  stop(handle) {
    clearInterval(handle);
  },
});

function closedValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value)
    ? value
    : fallback;
}

function duration(milliseconds, round = Math.floor) {
  const totalSeconds = Math.max(0, round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0 || parts.length === 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function render(record, format) {
  if (format === 'jsonl') return `${JSON.stringify(record)}\n`;
  const detail = record.verdict ?? record.outcome;
  const state = `${HUMAN_STAGES[record.stage]}${detail ? `: ${detail}` : ''}`
    + `${record.heartbeat ? ' (still running)' : ''}`;
  return `Gaia: ${state} | elapsed ${duration(record.elapsedMs)}`
    + ` | provider-time upper bound remaining `
    + `${duration(record.remainingProviderTimeUpperBoundMs, Math.ceil)} (not an ETA)\n`;
}

export function createCliProgress({
  timeoutMs,
  format = 'human',
  write = (chunk) => process.stderr.write(chunk),
  nowMs = () => Date.now(),
  scheduler = DEFAULT_SCHEDULER,
  heartbeatIntervalMs = 10_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }
  if (!PROGRESS_FORMATS.has(format)) {
    throw new TypeError('format must be human or jsonl');
  }
  if (!Number.isSafeInteger(heartbeatIntervalMs)
      || heartbeatIntervalMs < 1 || heartbeatIntervalMs > 15_000) {
    throw new TypeError('heartbeatIntervalMs must be an integer from 1 through 15000');
  }

  const safeWrite = typeof write === 'function' ? write : () => {};
  const safeScheduler = scheduler && typeof scheduler.start === 'function'
    && typeof scheduler.stop === 'function' ? scheduler : null;
  const readClock = () => {
    try {
      const value = nowMs();
      return Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };
  const startedAt = readClock();
  let lastElapsedMs = 0;
  let lastRemainingInvocations = MAX_PROVIDER_INVOCATIONS;
  let heartbeat = null;
  let heartbeatGeneration = null;

  const emit = (stage, remainingInvocations, detail = {}) => {
    const observed = readClock();
    const elapsed = startedAt === null || observed === null
      ? lastElapsedMs
      : Math.max(0, Math.floor(observed - startedAt));
    lastElapsedMs = Math.max(lastElapsedMs, elapsed);
    lastRemainingInvocations = Math.min(lastRemainingInvocations, remainingInvocations);
    const record = {
      schema: SCHEMA,
      stage,
      elapsedMs: lastElapsedMs,
      remainingProviderInvocations: lastRemainingInvocations,
      remainingProviderTimeUpperBoundMs: lastRemainingInvocations * timeoutMs,
      ...detail,
    };
    try {
      const result = safeWrite(render(record, format));
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      // Observability is never an execution or authority dependency.
    }
  };

  const stopHeartbeat = () => {
    heartbeatGeneration = null;
    if (heartbeat === null) return;
    const handle = heartbeat;
    heartbeat = null;
    try {
      safeScheduler?.stop(handle);
    } catch {
      // The execution path never depends on timer cleanup diagnostics.
    }
  };
  const startHeartbeat = (stage, remainingInvocations, detail = {}) => {
    stopHeartbeat();
    if (safeScheduler === null) return;
    const generation = {};
    heartbeatGeneration = generation;
    try {
      heartbeat = safeScheduler.start(() => {
        if (heartbeatGeneration !== generation) return;
        emit(stage, remainingInvocations, { ...detail, heartbeat: true });
      }, heartbeatIntervalMs);
      if (heartbeat && typeof heartbeat.unref === 'function') heartbeat.unref();
    } catch {
      const handle = heartbeat;
      heartbeat = null;
      if (heartbeatGeneration === generation) heartbeatGeneration = null;
      if (handle !== null) {
        try {
          safeScheduler.stop(handle);
        } catch {
          // The generation guard makes a retained callback inert.
        }
      }
    }
  };
  const running = (stage, remainingInvocations) => {
    emit(stage, remainingInvocations);
    startHeartbeat(stage, remainingInvocations);
  };
  const completed = (stage, remainingInvocations) => {
    stopHeartbeat();
    emit(stage, remainingInvocations);
  };

  return Object.freeze({
    validating: () => emit('validating', 4),
    executionStarting: () => emit('execution_starting', 4),
    authorizedExecution: () => emit('authorized_execution', 4),
    workerRunning: () => running('worker_running', 4),
    workerCompleted: () => completed('worker_completed', 3),
    initialReviewRunning: () => running('initial_review_running', 3),
    initialReviewVerdict: (verdict) => {
      stopHeartbeat();
      emit('initial_review_verdict', verdict === 'REQUEST_CHANGES' ? 2 : 0,
        { verdict: closedValue(verdict, VERDICTS, 'INVALID') });
    },
    repairRunning: () => running('repair_running', 2),
    repairCompleted: () => completed('repair_completed', 1),
    finalReviewRunning: () => running('final_review_running', 1),
    finalReviewVerdict: (verdict) => {
      stopHeartbeat();
      emit('final_review_verdict', 0,
        { verdict: closedValue(verdict, VERDICTS, 'INVALID') });
    },
    providerStopped: stopHeartbeat,
    terminalOutcome: (outcome) => {
      stopHeartbeat();
      emit('terminal_outcome', 0,
        { outcome: closedValue(outcome, OUTCOMES, 'UNKNOWN') });
    },
  });
}

export function instrumentFactoryAdapters({ runWorker, runReviewer, runRepair, progress }) {
  let reviewRound = 0;
  const adapters = {
    runWorker: async (...args) => {
      progress.workerRunning();
      let result;
      try {
        result = await runWorker(...args);
      } catch (error) {
        progress.providerStopped();
        throw error;
      }
      progress.workerCompleted();
      return result;
    },
    runReviewer: async (...args) => {
      const initial = reviewRound === 0;
      reviewRound += 1;
      if (initial) progress.initialReviewRunning();
      else progress.finalReviewRunning();
      let result;
      try {
        result = await runReviewer(...args);
      } catch (error) {
        progress.providerStopped();
        throw error;
      }
      if (initial) progress.initialReviewVerdict(result?.verdict);
      else progress.finalReviewVerdict(result?.verdict);
      return result;
    },
  };
  if (typeof runRepair === 'function') {
    adapters.runRepair = async (...args) => {
      progress.repairRunning();
      let result;
      try {
        result = await runRepair(...args);
      } catch (error) {
        progress.providerStopped();
        throw error;
      }
      progress.repairCompleted();
      return result;
    };
  }
  return Object.freeze(adapters);
}
