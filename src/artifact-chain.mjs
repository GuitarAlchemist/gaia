/**
 * artifact-chain.mjs — does the earlier evidence still apply to the revision in front of me?
 *
 * WHAT THIS IS FOR
 * ----------------
 * Gaia already produces the artifacts of a delivery: an accepted intent, a candidate receipt,
 * test output, an independent review, a publication receipt. Doctrine already says a changed
 * *required* input invalidates downstream freshness while advisory and reference inputs do not.
 * Nothing machine-checked that. This module does, and nothing else.
 *
 * THE SEAM
 * --------
 *   buildArtifactChain({ descriptor, measured }) -> manifest
 *   evaluateArtifactChain({ manifest, observed, expectation }) -> report
 *
 * `measured` and `observed` are digests someone else measured; this module reads no file, opens
 * no socket, and reads no clock. `src/artifact-chain-files.mjs` is the only part that touches a
 * filesystem, which is why a caller can replay an evaluation from bytes alone.
 *
 * THE CALLER SUPPLIES THE EXPECTATION, ALWAYS
 * -------------------------------------------
 * `evaluateArtifactChain` cannot be called without the subject and the set of root revisions the
 * caller considers current. A manifest therefore never supplies its own standard of currency: a
 * self-consistent chain from three weeks ago cannot bless itself, because its own bytes are not
 * consulted for the question "is this the thing I am asking about?". A chain whose every node is
 * bound to no revision would escape that question entirely, so it is reported UNBOUND and is
 * never CHAIN_FRESH, however well its own digests resolve.
 *
 * FRESH IS NOT VERIFIED
 * ---------------------
 * `CHAIN_FRESH` says every recorded digest still resolves and every required edge still pins what
 * it pinned. It does NOT say tests passed, a reviewer approved, or a publication happened. A
 * manifest is unauthenticated text; anyone who can write the file can write any claim into it. So
 * a node's `claim` is reported as `ASSERTED_NOT_VERIFIED` and never as a result, and a stage with
 * no node is reported `NOT_PROVIDED` — never `PASSED`, never `FRESH`, never quietly omitted.
 *
 * NO CLOCK
 * --------
 * Freshness is digest resolution, as in `src/lineage-receipt.mjs`. Stale means refuse and
 * re-derive, never use anyway. A stale chain revokes no past acceptance and grants no authority;
 * it says only that the old evidence no longer describes the current revision.
 *
 * WHAT IT REFUSES
 * ---------------
 * Refusals are typed and fail closed: a refusal message is exactly its code. Malformed, cyclic,
 * duplicate, escaping, unknown-predecessor, stage-skipping, and unobserved input is refused rather
 * than repaired into something reassuring. The canonical encoder is the one already shipped in
 * `autonomous-factory-contract.mjs`, so this module introduces no second digest recipe.
 */

import { createHash } from 'node:crypto';

import { canonicalAutonomousJson } from './autonomous-factory-contract.mjs';

export const ARTIFACT_CHAIN_SCHEMA = 'gaia-artifact-chain/1';
export const ARTIFACT_CHAIN_REPORT_SCHEMA = 'gaia-artifact-chain-report/1';

/** The only stage order there is. A dependency may only point at a strictly earlier stage. */
export const ARTIFACT_CHAIN_STAGES = Object.freeze([
  'INTENT', 'CANDIDATE', 'TEST_EVIDENCE', 'INDEPENDENT_REVIEW', 'PUBLICATION_EVIDENCE',
]);
export const ARTIFACT_CHAIN_RELATIONS = Object.freeze(['required', 'advisory', 'reference']);

const MAX_NODES = 64;
const MAX_DEPENDENCIES = 32;
const DESCRIPTOR_KEYS = ['nodes', 'subject'];
const MANIFEST_KEYS = ['nodes', 'pendingStages', 'schema', 'subject'];
const DESCRIPTOR_NODE_KEYS = ['claim', 'dependencies', 'id', 'locator', 'producer', 'rootRevision', 'stage'];
const MANIFEST_NODE_KEYS = [...DESCRIPTOR_NODE_KEYS, 'contentDigest'].sort();
const CLAIM_KEYS = ['kind', 'statement'];
const DEPENDENCY_KEYS = ['nodeId', 'pinnedDigest', 'relation'];
const EXPECTATION_KEYS = ['requiredRootRevisions', 'subject'];

const DIGEST = /^[a-f0-9]{64}$/u;
const GIT_REVISION = /^[a-f0-9]{40}$/u;
const NODE_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const CLAIM_KIND = /^[A-Z][A-Z0-9_]{0,63}$/u;
const LOCATOR_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export class ArtifactChainError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ArtifactChainError';
    this.code = code;
  }
}

const fail = code => { throw new ArtifactChainError(code); };

/**
 * A pattern check that is not also a coercion. `RegExp.prototype.test` stringifies its argument,
 * so `NODE_ID.test(1234)` and `GIT_REVISION.test(['<40 hex>'])` both answer true and let a number
 * or a one-element array into a field the whole module then treats as a string — and a value that
 * is not a string can never equal the string it was compared against. Shape is checked first.
 */
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
const stageIndex = stage => ARTIFACT_CHAIN_STAGES.indexOf(stage);

/**
 * Canonical UTF-8 JSON, from the encoder already shipped for autonomous job evidence: sorted
 * keys, rejected getters and foreign prototypes, bounded depth and size. Reused rather than
 * reinvented so there is exactly one canonical form in this tree.
 */
export function canonicalArtifactChainJson(value, code = 'InvalidDocument') {
  try {
    return canonicalAutonomousJson(value, code);
  } catch {
    return fail(code);
  }
}

export function artifactChainDocumentDigest(value) {
  return createHash('sha256').update(canonicalArtifactChainJson(value), 'utf8').digest('hex');
}

const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max
  && value.trim() === value && !/[\p{Cc}\p{Zl}\p{Zp}]/u.test(value);

function exact(value, keys, code) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail(code);
}

/**
 * A locator is a relative path *inside* the manifest's root, expressed in one spelling. `..`,
 * an absolute form, a drive letter, a backslash, an empty segment, and `.` are all refused here,
 * in the pure module, so a descriptor cannot reach the file adapter with an escaping path.
 */
function isLocator(value) {
  if (!text(value, 1024) || value.includes('\\') || value.includes('\0')) return false;
  const segments = value.split('/');
  return segments.length <= 32 && segments.every(segment => LOCATOR_SEGMENT.test(segment)
    && segment !== '.' && segment !== '..');
}

/** Field-level shape of every node. `pinned` selects the manifest form, which carries digests. */
function checkNodeFields(nodes, code, { pinned }) {
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) fail(code);
  for (const node of nodes) {
    exact(node, pinned ? MANIFEST_NODE_KEYS : DESCRIPTOR_NODE_KEYS, code);
    if (!matches(NODE_ID, node.id) || !ARTIFACT_CHAIN_STAGES.includes(node.stage)
      || (node.rootRevision !== null && !matches(GIT_REVISION, node.rootRevision))
      || !text(node.producer, 256) || !isLocator(node.locator)) fail(code);
    if (pinned && !matches(DIGEST, node.contentDigest)) fail(code);
    if (node.claim !== null) {
      exact(node.claim, CLAIM_KEYS, code);
      if (!matches(CLAIM_KIND, node.claim.kind) || !text(node.claim.statement, 1024)) fail(code);
    }
    if (!Array.isArray(node.dependencies) || node.dependencies.length > MAX_DEPENDENCIES) fail(code);
    for (const dependency of node.dependencies) {
      exact(dependency, DEPENDENCY_KEYS, code);
      if (!matches(NODE_ID, dependency.nodeId)
        || !ARTIFACT_CHAIN_RELATIONS.includes(dependency.relation)
        || !matches(DIGEST, dependency.pinnedDigest)) fail(code);
    }
  }
}

/**
 * The rules that make a chain a chain. Every refusal here is structural, so both the build path
 * and the read path produce the same code for the same defect.
 */
function checkStructure(nodes) {
  const byId = new Map();
  for (const node of nodes) {
    if (byId.has(node.id)) fail('DuplicateNodeId');
    byId.set(node.id, node);
  }
  for (const node of nodes) {
    const seen = new Set();
    for (const dependency of node.dependencies) {
      if (seen.has(dependency.nodeId)) fail('DuplicateDependency');
      seen.add(dependency.nodeId);
      if (!byId.has(dependency.nodeId)) fail('UnknownDependency');
    }
    // An accepted intent is a root. Giving it a predecessor is how a cycle would be spelled.
    if (node.stage === 'INTENT') {
      if (node.dependencies.length > 0) fail('UnexpectedDependency');
      continue;
    }
    // Strictly earlier stages only: a self edge, a same-stage edge, and a forward edge are all
    // refused, which is what makes a cyclic input impossible rather than merely unlikely.
    for (const dependency of node.dependencies) {
      if (stageIndex(byId.get(dependency.nodeId).stage) >= stageIndex(node.stage)) {
        fail('InvalidDependencyOrder');
      }
    }
    // A publication node cannot exist without the review stage it claims to follow.
    const previous = ARTIFACT_CHAIN_STAGES[stageIndex(node.stage) - 1];
    if (!node.dependencies.some(dependency => dependency.relation === 'required'
      && byId.get(dependency.nodeId).stage === previous)) fail('MissingPredecessorStage');
  }
  return byId;
}

const pendingStagesOf = nodes => ARTIFACT_CHAIN_STAGES
  .filter(stage => !nodes.some(node => node.stage === stage));

const nodeOrder = (a, b) => stageIndex(a.stage) - stageIndex(b.stage)
  || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

function freeze(value) {
  if (value && typeof value === 'object') Object.values(value).forEach(freeze);
  return Object.freeze(value);
}

/**
 * Build a manifest from a descriptor and the digests an adapter measured for it.
 *
 * The descriptor never carries a node's own digest: `contentDigest` comes from `measured`.
 * Every dependency does carry the digest its producer recorded when the dependent was produced.
 * That historical pin is preserved exactly; deriving it from the predecessor's current
 * measurement would silently rebind old downstream evidence to newer inputs.
 */
export function validateArtifactChainDescriptor(descriptor) {
  const input = JSON.parse(canonicalArtifactChainJson(descriptor, 'InvalidDescriptor'));
  exact(input, DESCRIPTOR_KEYS, 'InvalidDescriptor');
  if (!text(input.subject, 512)) fail('InvalidDescriptor');
  checkNodeFields(input.nodes, 'InvalidDescriptor', { pinned: false });
  // The complete domain shape precedes every filesystem read: a late malformed node, duplicate,
  // unknown edge, or invalid stage relationship cannot amplify I/O through earlier locators.
  checkStructure(input.nodes);
  return freeze(input);
}

export function buildArtifactChain({ descriptor, measured }) {
  const input = validateArtifactChainDescriptor(descriptor);
  const digests = JSON.parse(canonicalArtifactChainJson(measured, 'InvalidMeasurement'));
  exact(digests, input.nodes.map(node => node.id), 'InvalidMeasurement');
  if (Object.values(digests).some(value => !matches(DIGEST, value))) fail('InvalidMeasurement');

  const nodes = input.nodes.map(node => ({
    ...node,
    contentDigest: digests[node.id],
    dependencies: [...node.dependencies]
      .sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
      .map(dependency => ({ ...dependency })),
  }));
  // Pins are producer evidence, not current measurements. Field and structural checks refuse a
  // missing, malformed, or unknown predecessor rather than manufacturing a current binding.
  checkNodeFields(nodes, 'UnknownDependency', { pinned: true });
  nodes.sort(nodeOrder);
  checkStructure(nodes);

  return freeze({
    schema: ARTIFACT_CHAIN_SCHEMA,
    subject: input.subject,
    nodes,
    pendingStages: pendingStagesOf(nodes),
  });
}

/**
 * Read a manifest that someone else wrote. Node order and `pendingStages` are part of the
 * canonical form, so a reordered or re-labelled document is a refusal rather than an accepted
 * variant — which is what keeps replay byte-identical.
 */
export function validateArtifactChain(manifest) {
  const document = JSON.parse(canonicalArtifactChainJson(manifest, 'InvalidManifest'));
  exact(document, MANIFEST_KEYS, 'InvalidManifest');
  if (document.schema !== ARTIFACT_CHAIN_SCHEMA || !text(document.subject, 512)) fail('InvalidManifest');
  checkNodeFields(document.nodes, 'InvalidManifest', { pinned: true });
  checkStructure(document.nodes);
  const ordered = [...document.nodes].sort(nodeOrder);
  if (JSON.stringify(document.nodes.map(node => node.id))
    !== JSON.stringify(ordered.map(node => node.id))) fail('InvalidManifest');
  for (const node of document.nodes) {
    const sorted = [...node.dependencies].map(dependency => dependency.nodeId).sort();
    if (JSON.stringify(node.dependencies.map(dependency => dependency.nodeId))
      !== JSON.stringify(sorted)) fail('InvalidManifest');
  }
  if (JSON.stringify(document.pendingStages)
    !== JSON.stringify(pendingStagesOf(document.nodes))) fail('InvalidManifest');
  return freeze(document);
}

function checkExpectation(expectation) {
  const wanted = JSON.parse(canonicalArtifactChainJson(expectation, 'InvalidExpectation'));
  exact(wanted, EXPECTATION_KEYS, 'InvalidExpectation');
  if (!text(wanted.subject, 512) || !Array.isArray(wanted.requiredRootRevisions)
    || wanted.requiredRootRevisions.length === 0 || wanted.requiredRootRevisions.length > MAX_NODES
    || wanted.requiredRootRevisions.some(value => !matches(GIT_REVISION, value))
    || new Set(wanted.requiredRootRevisions).size !== wanted.requiredRootRevisions.length) {
    fail('InvalidExpectation');
  }
  return wanted;
}

/**
 * Evaluate a manifest against measured bytes and the caller's own expectation.
 *
 * The observation must cover exactly the manifest's nodes: a node nobody measured fails closed
 * rather than defaulting to fresh. Nothing here is a cross-process atomicity claim — it is one
 * local reading of local bytes, and a file may change immediately afterwards.
 */
export function evaluateArtifactChain({ manifest, observed, expectation }) {
  const document = validateArtifactChain(manifest);
  const wanted = checkExpectation(expectation);
  if (document.subject !== wanted.subject) fail('SubjectMismatch');

  const measured = JSON.parse(canonicalArtifactChainJson(observed, 'InvalidObservation'));
  exact(measured, document.nodes.map(node => node.id), 'InvalidObservation');
  if (Object.values(measured).some(value => !matches(DIGEST, value))) fail('InvalidObservation');

  const current = new Set(wanted.requiredRootRevisions);
  const byId = new Map(document.nodes.map(node => [node.id, node]));
  const freshness = new Map();
  const nodes = document.nodes.map(node => {
    const required = node.dependencies.filter(dependency => dependency.relation === 'required');
    const changedAdvisoryInputs = node.dependencies
      .filter(dependency => dependency.relation !== 'required'
        && (byId.get(dependency.nodeId).contentDigest !== dependency.pinnedDigest
          || freshness.get(dependency.nodeId) !== 'FRESH'))
      .map(dependency => dependency.nodeId)
      .sort();
    const verdict = measured[node.id] !== node.contentDigest ? 'CONTENT_CHANGED'
      : node.rootRevision !== null && !current.has(node.rootRevision) ? 'STALE_ROOT_REVISION'
        : required.some(dependency => byId.get(dependency.nodeId).contentDigest !== dependency.pinnedDigest)
          ? 'PIN_MISMATCH'
          : required.some(dependency => freshness.get(dependency.nodeId) !== 'FRESH')
            ? 'STALE_REQUIRED_INPUT' : 'FRESH';
    freshness.set(node.id, verdict);
    return { id: node.id, stage: node.stage, freshness: verdict, changedAdvisoryInputs,
      // A claim is what an unauthenticated document asserts. It is never a result.
      claimStatus: node.claim === null ? 'NO_CLAIM' : 'ASSERTED_NOT_VERIFIED' };
  });

  // A node with a null root revision is bound to no revision at all, which is correct for an
  // accepted intent but says nothing about currency. A chain in which *every* node is like that
  // never consults the caller's expectation, so it would answer CHAIN_FRESH for any revision on
  // earth — the self-blessing this module exists to refuse. Nothing binds it, so it is not fresh.
  const rootRevisionBinding = document.nodes.some(node => node.rootRevision !== null
    && current.has(node.rootRevision)) ? 'BOUND' : 'UNBOUND';

  return freeze({
    schema: ARTIFACT_CHAIN_REPORT_SCHEMA,
    subject: document.subject,
    expectedRootRevisions: [...wanted.requiredRootRevisions].sort(),
    rootRevisionBinding,
    verdict: rootRevisionBinding === 'BOUND' && nodes.every(node => node.freshness === 'FRESH')
      ? 'CHAIN_FRESH' : 'CHAIN_STALE',
    nodes,
    // Absence stays absence: a stage with no node is NOT_PROVIDED, in stage order, always listed.
    stages: ARTIFACT_CHAIN_STAGES.map(stage => {
      const nodeIds = document.nodes.filter(node => node.stage === stage).map(node => node.id);
      return { stage, status: nodeIds.length === 0 ? 'NOT_PROVIDED' : 'PRESENT', nodeIds };
    }),
    pendingStages: document.pendingStages,
  });
}
