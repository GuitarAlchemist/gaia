/**
 * lanes.mjs — the supported live-lane policy, in one place.
 *
 * The number here is an evidence claim, not a preference. What has actually been
 * measured is documented in docs/scale-and-lanes.md; the short version:
 *
 *   4  SUPPORTED DEFAULT. Four concurrent client+server pairs against one log,
 *      re-verified as part of this product's acceptance run.
 *   6  NEXT VALIDATION TARGET. Not validated with real Claude/Codex lanes.
 *   8  UNPROVEN with real clients. The 8- and 16-writer probes that exist were run
 *      with identical Node workers, which prove id uniqueness, JSONL integrity and
 *      deterministic replay under contention. They prove nothing about throughput,
 *      heterogeneity, or a log of 10^4-10^5 events, and per-call cost is still
 *      O(events x actors) under one global lock on a log that never compacts.
 *
 * So: >4 is refused unless the caller passes the experimental flag, and even then it
 * is capped at 8 and reported as experimental. Passing the flag changes nothing about
 * what has been proven; it only records that the operator accepted an unproven limit.
 */

export const DEFAULT_MAX_LIVE_LANES = 4;
export const NEXT_VALIDATION_TARGET_LANES = 6;
export const UNPROVEN_LANES = 8;
export const EXPERIMENTAL_CEILING_LANES = 8;

export const LANE_EVIDENCE = Object.freeze({
  4: 'supported: validated in this product\'s acceptance run',
  6: 'next validation target: NOT validated with real Claude/Codex lanes',
  8: 'unproven with real clients: only identical Node workers have been measured',
});

export class LaneLimitError extends Error {
  constructor(message) { super(message); this.name = 'LaneLimitError'; this.code = 'GAIA_LANE_LIMIT'; }
}

/**
 * Decide the effective lane limit for a run.
 *
 * Returns `{ limit, experimental, note }` or throws LaneLimitError. Throwing is the
 * point: a caller that asks for 8 lanes without the flag must not silently get 4 and
 * believe it got 8.
 */
export function resolveLaneLimit({ requested = null, experimental = false } = {}) {
  if (requested === null || requested === undefined) {
    return { limit: DEFAULT_MAX_LIVE_LANES, experimental: false, note: LANE_EVIDENCE[4] };
  }

  const n = Number(requested);
  if (!Number.isInteger(n) || n < 1) {
    throw new LaneLimitError(`lane limit must be a positive integer, got ${JSON.stringify(requested)}`);
  }
  if (n <= DEFAULT_MAX_LIVE_LANES) {
    return { limit: n, experimental: false, note: LANE_EVIDENCE[4] };
  }
  if (!experimental) {
    throw new LaneLimitError(
      `refusing ${n} live lanes: the supported default maximum is ${DEFAULT_MAX_LIVE_LANES} per workspace. ` +
      `${NEXT_VALIDATION_TARGET_LANES} is the next validation target and ${UNPROVEN_LANES} is unproven with real ` +
      'Claude/Codex lanes (only identical Node workers have been measured). ' +
      'Pass --experimental-lanes to accept an unproven limit; it changes no evidence.',
    );
  }
  if (n > EXPERIMENTAL_CEILING_LANES) {
    throw new LaneLimitError(
      `refusing ${n} live lanes even with --experimental-lanes: nothing above ${EXPERIMENTAL_CEILING_LANES} ` +
      'has been measured at all, with any client. Raise this only with real-client evidence.',
    );
  }
  return {
    limit: n,
    experimental: true,
    note: LANE_EVIDENCE[n] ?? `experimental: ${n} lanes has no real-client evidence`,
  };
}

/**
 * Admission check for a lane that is about to be registered.
 * `live` is the count of lanes already registered and running.
 */
export function admitLane({ live, limit }) {
  if (live >= limit) {
    throw new LaneLimitError(
      `refusing to register lane ${live + 1}: ${live} live lanes already at the limit of ${limit}. ` +
      'Retire a lane, or raise the limit deliberately with --max-lanes/--experimental-lanes.',
    );
  }
  return { admitted: true, position: live + 1, limit };
}
