/**
 * resume-manifest.test.mjs — the lane resume check (W1), driven from its refusals.
 *
 * The module exists for one reason: a resumed lane prompt must not run over a tree or an
 * artifact set it was not written against. These gates are written against the ways such
 * a seam is usually wrong, not against its happy path:
 *
 *   - the manifest is resealed with a different claim and the old digest still passes;
 *   - a moved tree or an extended artifact set is quietly accepted as "close enough";
 *   - an unknown key rides through instead of being refused;
 *   - the artifact set compares as a bag, so reordering or duplication hides a change;
 *   - an escaping or git-control artifact path is admitted into the record;
 *   - prompt text leaks into the manifest body instead of being bound by digest only.
 *
 * Everything here is pure and in memory: no filesystem, no clock, no process.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  buildLaneResumeManifest, requireLaneResumeManifest, checkLaneResumeAgreement,
  LANE_RESUME_MANIFEST_SCHEMA, MAX_RESUME_PROMPT_CHARS, MAX_RESUME_ARTIFACTS,
  ResumeManifestError,
} from '../src/resume-manifest.mjs';

const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

const PROMPT = 'You are the bounded Gaia worker.\nTask: resolve issue 104 inside this worktree.';
const TREE = Object.freeze({
  head: 'a'.repeat(40),
  workspaceIdentity: 'b'.repeat(64),
});
const ARTIFACTS = Object.freeze([
  Object.freeze({ path: 'docs/resume-manifest.md', sha256: '1'.repeat(64) }),
  Object.freeze({ path: 'src/resume-manifest.mjs', sha256: '2'.repeat(64) }),
]);

const build = (overrides = {}) => buildLaneResumeManifest({
  laneId: 'lane-104', prompt: PROMPT, tree: TREE, artifacts: ARTIFACTS, ...overrides,
});

const observation = (overrides = {}) => ({
  manifest: build(), prompt: PROMPT, tree: TREE, artifacts: ARTIFACTS, ...overrides,
});

const refusal = (code, fn) => {
  assert.throws(fn, (error) => error instanceof ResumeManifestError && error.code === code,
    `expected refusal ${code}`);
};

test('build, verify and agree round-trip; outputs are deeply frozen', () => {
  const manifest = build();
  assert.equal(manifest.schema, LANE_RESUME_MANIFEST_SCHEMA);
  assert.equal(manifest.promptSha256, sha256(PROMPT));
  assert.equal(manifest.promptChars, PROMPT.length);
  assert.equal(requireLaneResumeManifest(manifest), manifest);
  const agreement = checkLaneResumeAgreement(observation({ manifest }));
  assert.deepEqual(agreement, {
    agreement: 'RESUME_AGREED',
    schema: LANE_RESUME_MANIFEST_SCHEMA,
    laneId: 'lane-104',
    manifestDigest: manifest.manifestDigest,
  });
  assert.ok(Object.isFrozen(manifest) && Object.isFrozen(manifest.tree)
    && Object.isFrozen(manifest.artifacts) && Object.isFrozen(manifest.artifacts[0]));
  assert.ok(Object.isFrozen(agreement));
});

test('building is deterministic: same inputs, byte-identical manifest digest', () => {
  assert.equal(build().manifestDigest, build().manifestDigest);
});

test('the manifest never carries the prompt text, only its digest and length', () => {
  const marker = 'UNIQUE-PROMPT-MARKER-49d1';
  const manifest = buildLaneResumeManifest({
    laneId: 'lane-104', prompt: `${PROMPT} ${marker}`, tree: TREE, artifacts: ARTIFACTS,
  });
  assert.ok(!JSON.stringify(manifest).includes(marker));
});

test('a prompt the manifest does not bind is refused as unbound', () => {
  refusal('RESUME_PROMPT_UNBOUND', () => checkLaneResumeAgreement(
    observation({ prompt: `${PROMPT} widened` }),
  ));
});

test('a bound prompt over a moved tree is refused: head', () => {
  refusal('RESUME_TREE_DISAGREEMENT', () => checkLaneResumeAgreement(
    observation({ tree: { ...TREE, head: 'c'.repeat(40) } }),
  ));
});

test('a bound prompt over a moved tree is refused: workspace identity', () => {
  refusal('RESUME_TREE_DISAGREEMENT', () => checkLaneResumeAgreement(
    observation({ tree: { ...TREE, workspaceIdentity: 'c'.repeat(64) } }),
  ));
});

test('a bound prompt over a different artifact set is refused', () => {
  const changed = [{ ...ARTIFACTS[0], sha256: '3'.repeat(64) }, ARTIFACTS[1]];
  refusal('RESUME_ARTIFACT_SET_DISAGREEMENT', () => checkLaneResumeAgreement(
    observation({ artifacts: changed }),
  ));
  refusal('RESUME_ARTIFACT_SET_DISAGREEMENT', () => checkLaneResumeAgreement(
    observation({ artifacts: [ARTIFACTS[0]] }),
  ));
  refusal('RESUME_ARTIFACT_SET_DISAGREEMENT', () => checkLaneResumeAgreement(
    // Appended in canonical order: an out-of-order set is a malformed observation, not a disagreement.
    observation({ artifacts: [...ARTIFACTS, { path: 'tests/extra.mjs', sha256: '4'.repeat(64) }] }),
  ));
});

test('an empty recorded artifact set agrees only with an empty observed set', () => {
  const manifest = build({ artifacts: [] });
  const agreement = checkLaneResumeAgreement(observation({ manifest, artifacts: [] }));
  assert.equal(agreement.agreement, 'RESUME_AGREED');
  refusal('RESUME_ARTIFACT_SET_DISAGREEMENT', () => checkLaneResumeAgreement(
    observation({ manifest, artifacts: [ARTIFACTS[0]] }),
  ));
});

test('a resealed manifest with a different claim fails the digest, field by field', () => {
  const manifest = build();
  for (const mutation of [
    { laneId: 'lane-999' },
    { promptSha256: sha256('another prompt') },
    { promptChars: PROMPT.length + 1 },
    { tree: { head: 'c'.repeat(40), workspaceIdentity: TREE.workspaceIdentity } },
    { artifacts: [ARTIFACTS[0]] },
    { manifestDigest: 'f'.repeat(64) },
    { manifestDigest: undefined },
  ]) {
    refusal('RESUME_MANIFEST_DIGEST_MISMATCH', () => requireLaneResumeManifest(
      { ...manifest, ...mutation },
    ));
  }
});

test('an unknown manifest key is refused, never ignored', () => {
  refusal('RESUME_MANIFEST_INVALID', () => requireLaneResumeManifest(
    { ...build(), extra: true },
  ));
  refusal('RESUME_MANIFEST_INVALID', () => requireLaneResumeManifest(
    { ...build(), tree: { ...TREE, extra: true } },
  ));
});

test('malformed manifests are refused by shape before any digest is consulted', () => {
  for (const manifest of [
    null, [], 'manifest',
    { ...build(), schema: 'gaia-lane-resume-manifest/2' },
    { ...build(), laneId: 'lane with spaces' },
    { ...build(), promptSha256: 'ABC'.repeat(21) + 'A' },
    { ...build(), promptChars: 0 },
    { ...build(), promptChars: MAX_RESUME_PROMPT_CHARS + 1 },
    { ...build(), tree: { head: 'short', workspaceIdentity: TREE.workspaceIdentity } },
  ]) {
    refusal('RESUME_MANIFEST_INVALID', () => requireLaneResumeManifest(manifest));
  }
});

test('the artifact set is canonical: reordering and duplication are refusals', () => {
  refusal('RESUME_MANIFEST_INVALID', () => build({
    artifacts: [ARTIFACTS[1], ARTIFACTS[0]],
  }));
  refusal('RESUME_MANIFEST_INVALID', () => build({
    artifacts: [ARTIFACTS[0], ARTIFACTS[0]],
  }));
});

test('escaping, absolute, git-control and malformed artifact paths are refused', () => {
  for (const path of [
    '../outside.txt', '/absolute.txt', 'a//b.txt', './relative.txt', 'a/../b.txt',
    'C:/windows.txt', 'a\\b.txt', '.git', '.GIT/config', '.git/hooks/pre-commit',
    'nul\u0000byte', '', 'x'.repeat(513),
  ]) {
    refusal('RESUME_MANIFEST_INVALID', () => build({
      artifacts: [{ path, sha256: '1'.repeat(64) }],
    }));
  }
});

test('artifact entries carry exactly path and sha256, with lowercase 64-hex digests', () => {
  refusal('RESUME_MANIFEST_INVALID', () => build({
    artifacts: [{ path: 'a.txt', sha256: '1'.repeat(64), bytes: 3 }],
  }));
  refusal('RESUME_MANIFEST_INVALID', () => build({
    artifacts: [{ path: 'a.txt', sha256: 'G'.repeat(64) }],
  }));
});

test('build bounds: prompt length and artifact count fail closed', () => {
  refusal('RESUME_MANIFEST_INVALID', () => build({ prompt: '' }));
  refusal('RESUME_MANIFEST_INVALID', () => build({
    prompt: 'x'.repeat(MAX_RESUME_PROMPT_CHARS + 1),
  }));
  assert.equal(build({ prompt: 'x'.repeat(MAX_RESUME_PROMPT_CHARS) }).promptChars,
    MAX_RESUME_PROMPT_CHARS);
  const many = Array.from({ length: MAX_RESUME_ARTIFACTS + 1 }, (_, index) => ({
    path: `artifact-${String(index).padStart(4, '0')}.txt`, sha256: '1'.repeat(64),
  }));
  refusal('RESUME_MANIFEST_INVALID', () => build({ artifacts: many }));
});

test('a malformed observation is its own refusal, never a disagreement verdict', () => {
  refusal('RESUME_OBSERVATION_INVALID', () => checkLaneResumeAgreement(
    observation({ prompt: 42 }),
  ));
  refusal('RESUME_OBSERVATION_INVALID', () => checkLaneResumeAgreement(
    observation({ tree: { head: TREE.head } }),
  ));
  refusal('RESUME_OBSERVATION_INVALID', () => checkLaneResumeAgreement(
    observation({ artifacts: [{ path: '../escape.txt', sha256: '1'.repeat(64) }] }),
  ));
});

test('the record is checked before the observation, and the prompt before the tree', () => {
  // A tampered manifest refuses even when the observation is also wrong.
  refusal('RESUME_MANIFEST_DIGEST_MISMATCH', () => checkLaneResumeAgreement(
    observation({ manifest: { ...build(), laneId: 'lane-999' }, prompt: 42 }),
  ));
  // An unbound prompt refuses before any tree comparison is reported.
  refusal('RESUME_PROMPT_UNBOUND', () => checkLaneResumeAgreement(
    observation({ prompt: `${PROMPT} widened`, tree: { ...TREE, head: 'c'.repeat(40) } }),
  ));
});
