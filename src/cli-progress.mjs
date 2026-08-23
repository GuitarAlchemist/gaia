/**
 * Best-effort CLI progress for bounded provider pipelines.
 *
 * The records are intentionally closed and contain no caller or provider text. The
 * time bound is only the maximum time still available to provider invocations; it is
 * not an estimate of wall-clock completion and excludes local validation/persistence.
 */

const SCHEMA = 'gaia-cli-progress/1';
const MAX_PROVIDER_INVOCATIONS = 4;
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES']);
const OUTCOMES = new Set([
  'COMPLETED', 'REJECTED', 'FAILED', 'CANDIDATE_READY', 'CANDIDATE_REJECTED',
  'EXECUTION_FAILED', 'REFUSED', 'UNKNOWN',
]);

function closedValue(value, allowed, fallback) {
  return typeof value === 'string' && allowed.has(value)
    ? value
    : fallback;
}

export function createCliProgress({
  timeoutMs,
  write = (chunk) => process.stderr.write(chunk),
  nowMs = () => Date.now(),
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new TypeError('timeoutMs must be a positive safe integer');
  }

  const safeWrite = typeof write === 'function' ? write : () => {};
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
      const result = safeWrite(`${JSON.stringify(record)}\n`);
      if (result && typeof result.then === 'function') result.catch(() => {});
    } catch {
      // Observability is never an execution or authority dependency.
    }
  };

  return Object.freeze({
    validating: () => emit('validating', 4),
    authorizedExecution: () => emit('authorized_execution', 4),
    workerRunning: () => emit('worker_running', 4),
    workerCompleted: () => emit('worker_completed', 3),
    initialReviewRunning: () => emit('initial_review_running', 3),
    initialReviewVerdict: (verdict) => emit('initial_review_verdict',
      verdict === 'REQUEST_CHANGES' ? 2 : 0,
      { verdict: closedValue(verdict, VERDICTS, 'INVALID') }),
    repairRunning: () => emit('repair_running', 2),
    repairCompleted: () => emit('repair_completed', 1),
    finalReviewRunning: () => emit('final_review_running', 1),
    finalReviewVerdict: (verdict) => emit('final_review_verdict', 0,
      { verdict: closedValue(verdict, VERDICTS, 'INVALID') }),
    terminalOutcome: (outcome) => emit('terminal_outcome', 0,
      { outcome: closedValue(outcome, OUTCOMES, 'UNKNOWN') }),
  });
}

export function instrumentFactoryAdapters({ runWorker, runReviewer, runRepair, progress }) {
  let reviewRound = 0;
  return Object.freeze({
    runWorker: async (...args) => {
      progress.workerRunning();
      const result = await runWorker(...args);
      progress.workerCompleted();
      return result;
    },
    runReviewer: async (...args) => {
      const initial = reviewRound === 0;
      reviewRound += 1;
      if (initial) progress.initialReviewRunning();
      else progress.finalReviewRunning();
      const result = await runReviewer(...args);
      if (initial) progress.initialReviewVerdict(result?.verdict);
      else progress.finalReviewVerdict(result?.verdict);
      return result;
    },
    runRepair: async (...args) => {
      progress.repairRunning();
      const result = await runRepair(...args);
      progress.repairCompleted();
      return result;
    },
  });
}
