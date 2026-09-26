import { createHash } from 'node:crypto';

/**
 * Lane resume manifest (W1) — the bound record a suspending lane leaves behind, and the
 * check a resume must pass before the lane prompt is handed to a provider again.
 *
 * A suspended lane holds three things that must still agree when it resumes: the exact
 * prompt it was launched with, the worktree state that prompt was written against, and
 * the set of artifacts the lane had already produced. Today nothing binds them: a resume
 * can replay yesterday's prompt over a moved tree, or over an artifact set another lane
 * has since extended, and the provider will happily continue the wrong work.
 *
 * The manifest binds the prompt by digest to one tree observation and one artifact set,
 * and seals the whole body under `manifestDigest`. `checkLaneResumeAgreement` is total:
 * it refuses a malformed or tampered manifest, refuses a prompt the manifest does not
 * bind, and refuses a bound prompt whose recorded tree or artifact set disagrees with
 * what the caller observes now. Disagreement is always a typed refusal, never a repair.
 *
 * The manifest never stores the prompt text — only its digest and length — so untrusted
 * task text has nowhere to live in the document. The manifest is unauthenticated local
 * evidence: anyone who can write the file can reseal any claim into it, so agreement is
 * a consistency statement between one record and one fresh observation, not authority,
 * not approval, and not proof the recorded artifacts were ever correct.
 *
 * Pure: no filesystem, no clock, no process. The caller supplies every observation.
 */

export const LANE_RESUME_MANIFEST_SCHEMA = 'gaia-lane-resume-manifest/1';
export const MAX_RESUME_PROMPT_CHARS = 16_000;
export const MAX_RESUME_ARTIFACTS = 256;

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/u;
const HEAD = /^[0-9a-f]{40}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export class ResumeManifestError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ResumeManifestError';
    this.code = code;
  }
}

const refuse = (code) => { throw new ResumeManifestError(code); };
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const deepFreeze = (value) => {
  if (value && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
};

function requireExactKeys(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join('\0') !== [...keys].sort().join('\0')) {
    refuse(code);
  }
}

function requirePrompt(prompt, code) {
  if (typeof prompt !== 'string' || prompt.length < 1 || prompt.length > MAX_RESUME_PROMPT_CHARS) {
    refuse(code);
  }
}

function requireTree(tree, code) {
  requireExactKeys(tree, ['head', 'workspaceIdentity'], code);
  if (typeof tree.head !== 'string' || !HEAD.test(tree.head)) refuse(code);
  if (typeof tree.workspaceIdentity !== 'string' || !DIGEST.test(tree.workspaceIdentity)) {
    refuse(code);
  }
}

function requireArtifactPath(path, code) {
  if (typeof path !== 'string' || path.length < 1 || path.length > 512) refuse(code);
  if (path.includes('\\') || path.includes(':') || /[\u0000-\u001f\u007f]/u.test(path)
      || path.startsWith('/')
      || path.split('/').some((part) => part === '' || part === '.' || part === '..')
      || path.toLowerCase() === '.git' || path.toLowerCase().startsWith('.git/')) {
    refuse(code);
  }
}

function requireArtifacts(artifacts, code) {
  if (!Array.isArray(artifacts) || artifacts.length > MAX_RESUME_ARTIFACTS) refuse(code);
  let previous = null;
  for (const artifact of artifacts) {
    requireExactKeys(artifact, ['path', 'sha256'], code);
    requireArtifactPath(artifact.path, code);
    if (typeof artifact.sha256 !== 'string' || !DIGEST.test(artifact.sha256)) refuse(code);
    // Strict ordinal ascent makes the set canonical and a duplicate path a refusal.
    if (previous !== null && !(artifact.path > previous)) refuse(code);
    previous = artifact.path;
  }
}

// Every field is a validated safe string or integer built in one fixed key order, so
// this encoding is canonical without a general canonical-JSON dependency.
const canonicalBody = (manifest) => JSON.stringify({
  schema: manifest.schema,
  laneId: manifest.laneId,
  promptSha256: manifest.promptSha256,
  promptChars: manifest.promptChars,
  tree: { head: manifest.tree.head, workspaceIdentity: manifest.tree.workspaceIdentity },
  artifacts: manifest.artifacts.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
});

/**
 * Bind one lane prompt to one tree observation and one artifact set, sealed by digest.
 * The prompt itself is hashed and counted, never stored.
 */
export function buildLaneResumeManifest({ laneId, prompt, tree, artifacts } = {}) {
  if (typeof laneId !== 'string' || !SAFE_ID.test(laneId)) refuse('RESUME_MANIFEST_INVALID');
  requirePrompt(prompt, 'RESUME_MANIFEST_INVALID');
  requireTree(tree, 'RESUME_MANIFEST_INVALID');
  requireArtifacts(artifacts, 'RESUME_MANIFEST_INVALID');
  const body = {
    schema: LANE_RESUME_MANIFEST_SCHEMA,
    laneId,
    promptSha256: sha256(prompt),
    promptChars: prompt.length,
    tree: { head: tree.head, workspaceIdentity: tree.workspaceIdentity },
    artifacts: artifacts.map(({ path, sha256: digest }) => ({ path, sha256: digest })),
  };
  return deepFreeze({ ...body, manifestDigest: sha256(canonicalBody(body)) });
}

/** Total verifier: exact keys, closed vocabularies, and the seal. Refuses, never repairs. */
export function requireLaneResumeManifest(manifest) {
  requireExactKeys(manifest, ['schema', 'laneId', 'promptSha256', 'promptChars', 'tree',
    'artifacts', 'manifestDigest'], 'RESUME_MANIFEST_INVALID');
  if (manifest.schema !== LANE_RESUME_MANIFEST_SCHEMA) refuse('RESUME_MANIFEST_INVALID');
  if (typeof manifest.laneId !== 'string' || !SAFE_ID.test(manifest.laneId)) {
    refuse('RESUME_MANIFEST_INVALID');
  }
  if (typeof manifest.promptSha256 !== 'string' || !DIGEST.test(manifest.promptSha256)) {
    refuse('RESUME_MANIFEST_INVALID');
  }
  if (!Number.isSafeInteger(manifest.promptChars) || manifest.promptChars < 1
      || manifest.promptChars > MAX_RESUME_PROMPT_CHARS) {
    refuse('RESUME_MANIFEST_INVALID');
  }
  requireTree(manifest.tree, 'RESUME_MANIFEST_INVALID');
  requireArtifacts(manifest.artifacts, 'RESUME_MANIFEST_INVALID');
  if (typeof manifest.manifestDigest !== 'string'
      || manifest.manifestDigest !== sha256(canonicalBody(manifest))) {
    refuse('RESUME_MANIFEST_DIGEST_MISMATCH');
  }
  return manifest;
}

/**
 * The resume check. Refuses a lane prompt the manifest does not bind, and refuses a
 * bound prompt whose recorded tree or artifact set disagrees with what the caller
 * observes now. Agreement is consistency between record and observation, not authority.
 *
 * Refusal codes, in the order they are decided:
 *   RESUME_MANIFEST_INVALID / RESUME_MANIFEST_DIGEST_MISMATCH — the record itself;
 *   RESUME_OBSERVATION_INVALID — the caller's own observation is malformed;
 *   RESUME_PROMPT_UNBOUND — this prompt is not the one the manifest binds;
 *   RESUME_TREE_DISAGREEMENT — the prompt was written against a different tree;
 *   RESUME_ARTIFACT_SET_DISAGREEMENT — the prompt was written against a different
 *     artifact set.
 */
export function checkLaneResumeAgreement({ manifest, prompt, tree, artifacts } = {}) {
  requireLaneResumeManifest(manifest);
  requirePrompt(prompt, 'RESUME_OBSERVATION_INVALID');
  requireTree(tree, 'RESUME_OBSERVATION_INVALID');
  requireArtifacts(artifacts, 'RESUME_OBSERVATION_INVALID');
  if (sha256(prompt) !== manifest.promptSha256 || prompt.length !== manifest.promptChars) {
    refuse('RESUME_PROMPT_UNBOUND');
  }
  if (tree.head !== manifest.tree.head
      || tree.workspaceIdentity !== manifest.tree.workspaceIdentity) {
    refuse('RESUME_TREE_DISAGREEMENT');
  }
  if (artifacts.length !== manifest.artifacts.length
      || artifacts.some((artifact, index) => artifact.path !== manifest.artifacts[index].path
        || artifact.sha256 !== manifest.artifacts[index].sha256)) {
    refuse('RESUME_ARTIFACT_SET_DISAGREEMENT');
  }
  return deepFreeze({
    agreement: 'RESUME_AGREED',
    schema: LANE_RESUME_MANIFEST_SCHEMA,
    laneId: manifest.laneId,
    manifestDigest: manifest.manifestDigest,
  });
}
