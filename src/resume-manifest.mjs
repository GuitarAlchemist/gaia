import { createHash } from 'node:crypto';

/**
 * Resume-prompt check (W1, issue #104) — refuse a lane prompt that disagrees with the tree or
 * the artifact set it is about to be run against.
 *
 * Three of three resume defects observed in the fleet were disagreements between what a prompt
 * said and what the world was: a subject path at one commit declared as another (Y1), a base pin
 * one merge stale (Y2), and a repair prompt that cited one of two blocking reviews (B16/B19).
 * None was a context-budget failure. A resume manifest is the structured declaration a prompt is
 * written against — subject worktree, subject generation (the full commit), optional base pin and
 * the upstream artifacts that may block it — and `checkResumePrompt` compares that declaration
 * with one fresh observation of the world and with the prompt text the lane will actually read.
 *
 * Confidence never comes from repetition. The retired `SubjectNamedTwice` heuristic counted how
 * often the prompt named its subject; a prompt that names the wrong subject twice passes that
 * count. Here the declared generation is compared with the observed HEAD, so repeating text
 * cannot make a bad subject valid, and naming the right subject once is enough. The prompt is
 * only required to carry each declared binding, because the lane acts on the text.
 *
 * Pure: no filesystem, no clock, no process, no environment. It imports only `node:crypto`. The
 * observation is collected at the edge (`src/resume-manifest-git.mjs`). Agreement is a statement
 * about one prompt, one declaration and one observation at one instant; it grants no authority,
 * approves nothing, and says nothing about whether the recorded artifacts were right.
 */

export const RESUME_MANIFEST_SCHEMA = 'gaia-resume-manifest/1';
export const RESUME_VERDICT_SCHEMA = 'gaia-resume-verdict/1';
export const MAX_RESUME_PROMPT_CHARS = 32_768;
export const MAX_UPSTREAM_ARTIFACTS = 64;
export const MAX_UPSTREAM_ARTIFACT_CHARS = 1_048_576;

/** The closed refusal vocabulary, in the order the check decides and reports it. */
export const RESUME_REFUSAL_CODES = Object.freeze([
  'RESUME_BINDING_NOT_CITED',
  'RESUME_SUBJECT_COMMIT_MISMATCH',
  'RESUME_SUBJECT_DIRTY',
  'RESUME_BASE_PIN_STALE',
  'RESUME_BLOCKING_INPUT_OMITTED',
]);

const COMMIT = /^[0-9a-f]{40}$/u;
const REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/u;
const MARKER = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*_COMPLETE$/u;
const VERDICTS = new Set(['APPROVE', 'REQUEST_CHANGES']);

/** Thrown for input the check cannot judge: malformed declaration, prompt or observation. */
export class ResumeManifestError extends Error {
  constructor(code, detail = null) {
    super(detail === null ? code : `${code} (${detail})`);
    this.name = 'ResumeManifestError';
    this.code = code;
    this.detail = detail;
  }
}

const refuse = (code, detail = null) => { throw new ResumeManifestError(code, detail); };
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

function requireExactKeys(value, keys, code, detail) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    refuse(code, detail);
  }
}

/** An absolute drive or POSIX path with no empty, `.` or `..` segment and no control character. */
function requireAbsolutePath(value, code, detail) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 1024
      || /[\u0000-\u001f\u007f]/u.test(value)) {
    refuse(code, detail);
  }
  const drive = /^[A-Za-z]:[\\/]/u.test(value);
  if (!drive && !value.startsWith('/')) refuse(code, detail);
  const segments = value.slice(drive ? 3 : 1).split(/[\\/]/u);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    refuse(code, detail);
  }
}

function requireCommit(value, code, detail) {
  if (typeof value !== 'string' || !COMMIT.test(value)) refuse(code, detail);
}

/** `<remote>/<branch>`: the base a lane is pinned against, resolved live at check time. */
function requireBaseRef(value, code, detail) {
  if (typeof value !== 'string') refuse(code, detail);
  const slash = value.indexOf('/');
  const remote = value.slice(0, slash);
  const branch = value.slice(slash + 1);
  if (slash < 1 || !REMOTE.test(remote) || !BRANCH.test(branch) || branch.includes('..')
      || branch.includes('//') || branch.endsWith('/') || branch.endsWith('.lock')) {
    refuse(code, detail);
  }
}

const fileName = (path) => path.split(/[\\/]/u).at(-1);
const pathKey = (path) => path.replaceAll('\\', '/').toLowerCase();

function requireUpstream(upstream, code) {
  if (!Array.isArray(upstream) || upstream.length > MAX_UPSTREAM_ARTIFACTS) refuse(code, 'upstream');
  const paths = new Set();
  const names = new Set();
  for (const path of upstream) {
    requireAbsolutePath(path, code, 'upstream');
    // The prompt cites an artifact by its file name, so two artifacts sharing one would make a
    // single citation count for both.
    if (paths.has(pathKey(path)) || names.has(fileName(path).toLowerCase())) refuse(code, 'upstream');
    paths.add(pathKey(path));
    names.add(fileName(path).toLowerCase());
  }
}

/**
 * Build the declaration a prompt is written against. The base is optional as a pair: a prompt
 * that pins no base declares none. Refuses, never repairs: a short commit is not expanded.
 */
export function buildResumeManifest({
  subjectPath, declaredCommit, baseRef = null, basePin = null, upstreamArtifacts = [],
} = {}) {
  requireAbsolutePath(subjectPath, 'RESUME_MANIFEST_INVALID', 'subject.path');
  requireCommit(declaredCommit, 'RESUME_MANIFEST_INVALID', 'subject.commit');
  if ((baseRef === null) !== (basePin === null)) refuse('RESUME_MANIFEST_INVALID', 'base');
  if (baseRef !== null) {
    requireBaseRef(baseRef, 'RESUME_MANIFEST_INVALID', 'base.ref');
    requireCommit(basePin, 'RESUME_MANIFEST_INVALID', 'base.pin');
  }
  requireUpstream(upstreamArtifacts, 'RESUME_MANIFEST_INVALID');
  return deepFreeze({
    schema: RESUME_MANIFEST_SCHEMA,
    subject: { path: subjectPath, commit: declaredCommit },
    base: baseRef === null ? null : { ref: baseRef, pin: basePin },
    upstream: [...upstreamArtifacts],
  });
}

/** Total verifier for a declaration: exact keys, closed value patterns. */
export function requireResumeManifest(manifest) {
  requireExactKeys(manifest, ['schema', 'subject', 'base', 'upstream'], 'RESUME_MANIFEST_INVALID',
    'shape');
  if (manifest.schema !== RESUME_MANIFEST_SCHEMA) refuse('RESUME_MANIFEST_INVALID', 'schema');
  requireExactKeys(manifest.subject, ['path', 'commit'], 'RESUME_MANIFEST_INVALID', 'subject');
  requireAbsolutePath(manifest.subject.path, 'RESUME_MANIFEST_INVALID', 'subject.path');
  requireCommit(manifest.subject.commit, 'RESUME_MANIFEST_INVALID', 'subject.commit');
  if (manifest.base !== null) {
    requireExactKeys(manifest.base, ['ref', 'pin'], 'RESUME_MANIFEST_INVALID', 'base');
    requireBaseRef(manifest.base.ref, 'RESUME_MANIFEST_INVALID', 'base.ref');
    requireCommit(manifest.base.pin, 'RESUME_MANIFEST_INVALID', 'base.pin');
  }
  requireUpstream(manifest.upstream, 'RESUME_MANIFEST_INVALID');
  return manifest;
}

/** The observation must be OF this declaration: same subject, same base ref, same artifacts. */
function requireObservation(observation, manifest) {
  const code = 'RESUME_OBSERVATION_INVALID';
  requireExactKeys(observation, ['subject', 'base', 'upstream'], code, 'shape');
  requireExactKeys(observation.subject, ['path', 'head', 'clean'], code, 'subject');
  if (observation.subject.path !== manifest.subject.path) refuse(code, 'subject.path');
  requireCommit(observation.subject.head, code, 'subject.head');
  if (typeof observation.subject.clean !== 'boolean') refuse(code, 'subject.clean');
  if (manifest.base === null) {
    if (observation.base !== null) refuse(code, 'base');
  } else {
    requireExactKeys(observation.base, ['ref', 'head'], code, 'base');
    if (observation.base.ref !== manifest.base.ref) refuse(code, 'base.ref');
    requireCommit(observation.base.head, code, 'base.head');
  }
  if (!Array.isArray(observation.upstream)
      || observation.upstream.length !== manifest.upstream.length) {
    refuse(code, 'upstream');
  }
  observation.upstream.forEach((artifact, index) => {
    requireExactKeys(artifact, ['path', 'text'], code, 'upstream');
    if (artifact.path !== manifest.upstream[index] || typeof artifact.text !== 'string'
        || artifact.text.length > MAX_UPSTREAM_ARTIFACT_CHARS) {
      refuse(code, 'upstream');
    }
  });
}

// Citation predicates. A path or file name must stand as its own token: not the prefix of a
// longer name (`gaia-104` inside `gaia-104-repair`), though a sentence may end right after it.
const NAME_BEFORE = '(?<![A-Za-z0-9._-])';
const NAME_AFTER = '(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])';

function citesPath(text, path) {
  const segments = path.split(/[\\/]/u).filter(Boolean).map(escapeRegExp);
  const lead = path.startsWith('/') ? '[\\\\/]' : '';
  return new RegExp(`${NAME_BEFORE}${lead}${segments.join('[\\\\/]+')}${NAME_AFTER}`, 'iu')
    .test(text);
}

const citesFileName = (text, path) => new RegExp(
  `${NAME_BEFORE}${escapeRegExp(fileName(path))}${NAME_AFTER}`, 'iu').test(text);

const citesCommit = (text, commit) => new RegExp(
  `(?<![0-9A-Za-z])${commit}(?![0-9A-Za-z])`, 'iu').test(text);

/** Any standalone hex run of 7 to 40 characters that abbreviates the commit names it. */
function namesCommit(text, commit) {
  for (const [run] of text.matchAll(/(?<![0-9A-Za-z])[0-9A-Fa-f]{7,40}(?![0-9A-Za-z])/gu)) {
    if (commit.startsWith(run.toLowerCase())) return true;
  }
  return false;
}

// A verdict or marker line is short. Longer lines are never inspected, which also keeps the
// line-anchored patterns below linear on a bounded artifact.
const SHORT_LINE = 200;
const undecorate = (line) => line.replace(/^[\s#>*_`]+|[\s*_`]+$/gu, '');

/** The last line that is nothing but a verdict token, ignoring Markdown emphasis. */
function verdictOf(text) {
  let verdict = null;
  for (const raw of text.split(/\r?\n/u)) {
    if (raw.length > SHORT_LINE) continue;
    const line = undecorate(undecorate(raw).replace(/^verdict\s*:\s*/iu, ''));
    if (VERDICTS.has(line)) verdict = line;
  }
  return verdict;
}

/** A completion marker is the last non-empty line, in the fleet's `<NAME>_COMPLETE` form. */
function markerOf(text) {
  const lines = text.split(/\r?\n/u);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (lines[index].length > SHORT_LINE) return null;
    const line = undecorate(lines[index]);
    if (line !== '') return MARKER.test(line) ? line : null;
  }
  return null;
}

/**
 * The resume check. Decides every rule and reports every refusal, in `RESUME_REFUSAL_CODES`
 * order, rather than stopping at the first: an operator fixing a prompt needs the whole list.
 * Malformed input is not a disagreement and throws `ResumeManifestError` instead.
 */
export function checkResumePrompt({ promptText, manifest, observation } = {}) {
  requireResumeManifest(manifest);
  if (typeof promptText !== 'string' || promptText.length < 1
      || promptText.length > MAX_RESUME_PROMPT_CHARS) {
    refuse('RESUME_PROMPT_INVALID');
  }
  requireObservation(observation, manifest);

  const refusals = [];
  // The lane acts on the text and the check acts on the declaration, so the text must carry
  // every declared binding. Presence, never a count.
  if (!citesPath(promptText, manifest.subject.path)) {
    refusals.push({ code: 'RESUME_BINDING_NOT_CITED', binding: 'SUBJECT_PATH' });
  }
  if (!citesCommit(promptText, manifest.subject.commit)) {
    refusals.push({ code: 'RESUME_BINDING_NOT_CITED', binding: 'SUBJECT_COMMIT' });
  }
  if (manifest.base !== null && !citesCommit(promptText, manifest.base.pin)) {
    refusals.push({ code: 'RESUME_BINDING_NOT_CITED', binding: 'BASE_PIN' });
  }
  if (observation.subject.head !== manifest.subject.commit) {
    refusals.push({ code: 'RESUME_SUBJECT_COMMIT_MISMATCH',
      declared: manifest.subject.commit, observed: observation.subject.head });
  }
  if (!observation.subject.clean) refusals.push({ code: 'RESUME_SUBJECT_DIRTY' });
  if (manifest.base !== null && observation.base.head !== manifest.base.pin) {
    refusals.push({ code: 'RESUME_BASE_PIN_STALE', ref: manifest.base.ref,
      pinned: manifest.base.pin, resolved: observation.base.head });
  }
  // A declared upstream artifact blocks this prompt when it names the generation the lane starts
  // from, and every such artifact must be cited. The verdict and the completion marker are
  // reported, never required: reviews write their verdicts in more shapes than any parser here
  // recognises (`REQUEST_CHANGES (this slice only)`, `REQUEST_CHANGES — because…`, `_DONE`
  // markers), and an unrecognised shape must not turn an omitted blocker back into agreement.
  const upstream = observation.upstream.map(({ path, text }) => {
    const verdict = verdictOf(text);
    const marker = markerOf(text);
    return {
      path,
      blocking: namesCommit(text, manifest.subject.commit),
      cited: citesFileName(promptText, path),
      verdict,
      marker,
    };
  });
  for (const artifact of upstream) {
    if (artifact.blocking && !artifact.cited) {
      refusals.push({ code: 'RESUME_BLOCKING_INPUT_OMITTED', artifact: artifact.path,
        verdict: artifact.verdict, marker: artifact.marker });
    }
  }

  return deepFreeze({
    schema: RESUME_VERDICT_SCHEMA,
    verdict: refusals.length === 0 ? 'RESUME_AGREED' : 'RESUME_REFUSED',
    authority: 'NONE',
    prompt: { sha256: sha256(promptText), chars: promptText.length },
    subject: { path: manifest.subject.path, declared: manifest.subject.commit,
      observed: observation.subject.head, clean: observation.subject.clean },
    base: manifest.base === null ? null : { ref: manifest.base.ref, pinned: manifest.base.pin,
      resolved: observation.base.head },
    upstream,
    refusals,
  });
}
