/**
 * gh-test-observation-source.mjs — the injected, read-only input adapter for
 * `gaia-test-observation/1`: one GitHub comment in, one `gaia-test-comment-reading/1` out.
 *
 * WHY THE ADAPTER IS THIS SMALL
 * -----------------------------
 * Everything that decides anything lives in `src/test-observation-intake.mjs`, which imports
 * nothing but a digest function. This file is the only place in the feature that knows GitHub
 * exists, and its whole job is to turn one CLI response into the reading shape that module already
 * verifies. Swap it for a fixture and no observation changes meaning; that is what makes the core
 * free of any dependency on the repository the comment happens to live in.
 *
 * WHAT IT CANNOT DO
 * -----------------
 * The published surface is one verb. There is no create, no update, no reply and no close, and the
 * invocation it builds is a plain read of one comment resource with no request body and no verb
 * override — the CLI's own default. `run` is injected so a test can watch every argument that is
 * ever passed, and the suite asserts that the shipped source cannot even spell a mutating flag.
 *
 * WHAT IT REFUSES TO GUESS
 * ------------------------
 * A comment that is not found may have been deleted, or may be in a repository this credential
 * cannot see. Those are indistinguishable from a single not-found response, so the reading says
 * `UNAVAILABLE` and never `DELETED`. A forbidden read and a read that never reached GitHub say the
 * same `UNAVAILABLE` for the same reason, through one closed classification that keeps none of the
 * failure's text — a CLI error message carries the command line, and a command line carries the
 * token. A cancelled read and a defect in this repository are raised instead, because neither is
 * evidence about the source. A malformed response is handed on as a readable-but-empty
 * body, so the pure normalizer classifies it exactly as it classifies every other unusable source,
 * rather than this adapter inventing a verdict of its own.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TEST_COMMENT_READING_SCHEMA, requireTestCommentReading } from './test-observation-intake.mjs';

const execFileAsync = promisify(execFile);

export const TEST_OBSERVATION_SOURCE_SCHEMA = 'gaia-test-observation-source/1';

const SOURCE_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;

/** The default read. No verb override, no request body: the CLI's own default is the read. */
async function runGh(args, { signal } = {}) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    signal,
    windowsHide: true,
  });
  try {
    return JSON.parse(stdout);
  } catch {
    // A response this seam cannot parse is unusable provider output, not a defect in this
    // repository, so it must not be classified as one. The original failure is dropped rather than
    // wrapped: it carries the unparsed response, and that is exactly what may not travel.
    throw Object.assign(new Error('the source returned an unreadable response'), {
      code: 'UNREADABLE_RESPONSE',
    });
  }
}

/**
 * The closed set of answers this seam has about a failed read.
 *
 * `RAISE` is one of them on purpose. A read that failed because the caller aborted it, or because
 * this repository has a defect, is not evidence about the source, and reporting either as "the
 * comment is unavailable" would be a false statement about GitHub made from a local fact.
 */
export const TEST_OBSERVATION_READ_FAILURES = Object.freeze([
  'NOT_FOUND', 'FORBIDDEN', 'UNREACHABLE', 'RAISE',
]);

/**
 * Classify one failed read into that closed set, from the error's own structured fields and a
 * bounded status match — never by keeping the text.
 *
 * Nothing of the error travels onward. A CLI failure message routinely carries the invoked command
 * line, and a command line routinely carries a token; a classification is three or four capital
 * letters and can carry neither.
 *
 * `NOT_FOUND` and `FORBIDDEN` are kept apart here even though both currently read as `UNAVAILABLE`,
 * because they are different facts: one says the comment is not there for anyone, the other says
 * this credential may not see it. Collapsing them at the point of classification would make the
 * distinction unrecoverable for the later slice that needs it.
 */
export function classifyTestObservationReadFailure(error) {
  // Cancellation first: an aborted read must not be answered on the strength of what it aborted.
  if (error?.name === 'AbortError' || error?.code === 'ABORT_ERR') return 'RAISE';
  if (error instanceof TypeError || error instanceof RangeError
    || error instanceof ReferenceError || error instanceof SyntaxError) {
    return 'RAISE';
  }
  const status = Number.isSafeInteger(error?.status) ? error.status : httpStatus(error);
  if (status === 404 || error?.code === 'NOT_FOUND') return 'NOT_FOUND';
  if (status === 401 || status === 403) return 'FORBIDDEN';
  // Everything left is a read that did not reach an answer: the tool is missing, the process
  // failed, the network did not resolve. The source is unreachable, which is all this can say.
  return 'UNREACHABLE';
}

/**
 * The one bounded look at an error's text, and the only one: a status code in the shape the CLI
 * prints. The match is anchored to that shape and the matched digits are all that is kept.
 */
function httpStatus(error) {
  const match = typeof error?.message === 'string'
    ? error.message.match(/\(HTTP (\d{3})\)/u)
    : null;
  return match === null ? null : Number(match[1]);
}

function commentPath({ repository, commentId }) {
  return `repos/${repository}/issues/comments/${commentId}`;
}

function sourceLink({ repository, issueNumber, commentId }) {
  return `https://github.com/${repository}/issues/${issueNumber}#issuecomment-${commentId}`;
}

/**
 * Build the read-only source. `run` is the only seam; injecting it is how a test proves that a
 * read is all that ever happens.
 */
export function createGitHubTestObservationSource({ run = runGh } = {}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');

  return Object.freeze({
    schema: TEST_OBSERVATION_SOURCE_SCHEMA,

    async read({ repository, issueNumber, commentId, observedAt, signal }) {
      if (typeof repository !== 'string' || !SOURCE_REPOSITORY.test(repository)) {
        throw new TypeError('repository must be owner/name');
      }
      if (!Number.isSafeInteger(issueNumber) || issueNumber < 1) {
        throw new TypeError('issueNumber must be a positive integer');
      }
      if (!Number.isSafeInteger(commentId) || commentId < 1) {
        throw new TypeError('commentId must be a positive integer');
      }

      const identity = { repository, issueNumber, commentId };
      const base = {
        schema: TEST_COMMENT_READING_SCHEMA,
        provenance: 'LIVE',
        ...identity,
        sourceUrl: sourceLink(identity),
        observedAt,
      };

      let payload;
      try {
        payload = await run(['api', commentPath(identity)], { signal });
      } catch (error) {
        if (classifyTestObservationReadFailure(error) === 'RAISE') throw error;
        // Not found, not permitted, or not reached. All three mean the same thing to a reader of
        // this reading — the source could not be read — and none of them is a deletion this seam
        // can prove. The classification stays here; the error itself goes no further.
        return requireTestCommentReading({
          ...base, availability: 'UNAVAILABLE', body: null, createdAt: null, updatedAt: null,
        });
      }

      const usable = payload !== null && typeof payload === 'object' && !Array.isArray(payload);
      return requireTestCommentReading({
        ...base,
        availability: 'AVAILABLE',
        // A response that does not carry the fields is handed on empty rather than repaired: the
        // pure normalizer already owns what an unusable source means.
        body: usable && typeof payload.body === 'string' ? payload.body : null,
        createdAt: usable && typeof payload.created_at === 'string' ? payload.created_at : null,
        updatedAt: usable && typeof payload.updated_at === 'string' ? payload.updated_at : null,
        sourceUrl: usable && typeof payload.html_url === 'string' ? payload.html_url : base.sourceUrl,
      });
    },
  });
}
