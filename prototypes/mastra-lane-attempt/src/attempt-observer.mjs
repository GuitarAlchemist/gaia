/**
 * One Mastra workflow run, read as one Gaia lane attempt (prototype, not part of the product).
 *
 * Gaia's lane-attempt core (`src/lane-attempt.mjs`, docs/lane-attempt-decisions.md) decides an
 * attempt from three event kinds: HEARTBEAT, MARKER and ABORT. This observer folds the chunks of a
 * Mastra run's `fullStream` into the first two. It imports neither Mastra nor the core: a chunk is
 * plain data, and the caller passes the events it returns to `replayLaneAttempt`.
 *
 * - `workflow-step-start` and `workflow-step-result` of the n-th declared step: HEARTBEAT `L<n>`.
 * - `workflow-finish` with `workflowStatus: 'success'`: MARKER.
 * - A suspension, and a finish with any other status, emit nothing. A paused or failed run is
 *   silent, and the attempt's deadline and heartbeat timeout keep running.
 * - An ABORT is the coordinator's order (`abort(at)`), never something the executor reports.
 *
 * The coordinator stamps every event with its own clock, when it observes the chunk. Mastra's
 * `startedAt` and `endedAt` are the executor's claims and decide nothing.
 *
 * Only sequential workflows are read: a step id the caller did not declare is refused, so a
 * parallel branch or a nested workflow cannot be mistaken for progress on a declared step.
 */

export class AttemptObserverError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'AttemptObserverError';
    this.code = code;
  }
}

const STEP_CHUNKS = new Set(['workflow-step-start', 'workflow-step-result']);

/** An observer for one run whose sequential steps are `stepIds`, in order. */
export function createAttemptObserver(stepIds) {
  if (!Array.isArray(stepIds) || stepIds.length === 0
    || stepIds.some((id) => typeof id !== 'string' || id.length === 0)
    || new Set(stepIds).size !== stepIds.length) {
    throw new AttemptObserverError('InvalidSteps', 'declare the run\'s step ids, once each, in order');
  }
  const steps = new Map(stepIds.map((id, index) => [id, `L${index + 1}`]));
  const events = [];
  const claims = { status: null, suspended: [], ignored: {} };

  return Object.freeze({
    /** Fold one chunk observed at the coordinator's instant `at`; returns the events it added. */
    observe(chunk, at) {
      const added = [];
      if (STEP_CHUNKS.has(chunk?.type)) {
        const step = steps.get(chunk.payload?.id);
        if (step === undefined) throw new AttemptObserverError('UndeclaredStep', String(chunk.payload?.id));
        added.push({ kind: 'HEARTBEAT', at, step });
      } else if (chunk?.type === 'workflow-step-suspended') {
        claims.suspended.push(chunk.payload?.id);
      } else if (chunk?.type === 'workflow-finish') {
        claims.status = chunk.payload?.workflowStatus ?? null;
        if (claims.status === 'success') added.push({ kind: 'MARKER', at });
      } else {
        claims.ignored[chunk?.type] = (claims.ignored[chunk?.type] ?? 0) + 1;
      }
      events.push(...added);
      return added;
    },
    /** Record the coordinator's abort order at `at`. */
    abort(at) {
      events.push({ kind: 'ABORT', at });
    },
    /** The events folded so far, for `replayLaneAttempt`. */
    events() {
      return events.map((event) => ({ ...event }));
    },
    /** What the executor said about itself: claims, not evidence. */
    claims() {
      return { status: claims.status, suspended: [...claims.suspended], ignored: { ...claims.ignored } };
    },
  });
}

/** Read a Mastra stream to its end, stamping each chunk with `clock()`; returns the run result. */
export async function observeStream(stream, observer, clock) {
  for await (const chunk of stream.fullStream) observer.observe(chunk, clock());
  return stream.result;
}
