/**
 * gh-failure.mjs — the one fact a failed `gh` call may carry out of its adapter.
 *
 * `gh api` writes GitHub's refusal to stderr. That text can hold URLs, request ids and payloads, so
 * no adapter keeps it. What survives is whether GitHub refused for a rate limit, primary or
 * secondary: that failure clears by waiting for the window to reset, where every other one needs a
 * person. Without it an exhausted App quota reads as an outage and the operator retries into it.
 */

// Primary limits say "API rate limit exceeded", secondary ones "exceeded a secondary rate limit";
// both arrive as HTTP 403, and a secondary limit may also arrive as a bare HTTP 429.
const RATE_LIMITED = /\brate limit\b|\(HTTP 429\)/iu;

/** A redacted failure for a `gh` call that exited non-zero, from the stderr it wrote. */
export function ghFailure(stderr) {
  const failure = new Error('GitHub request failed');
  failure.rateLimited = typeof stderr === 'string' && RATE_LIMITED.test(stderr);
  return failure;
}

export function isRateLimited(error) {
  return error?.rateLimited === true;
}
