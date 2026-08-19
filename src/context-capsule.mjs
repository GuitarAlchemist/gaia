/**
 * context-capsule.mjs — exact, read-only projection of one pinned fact revision.
 *
 * The trusted host binds one exact capsule manifest through
 * `openContextCapsule`. The model-facing interface is only `get(factId)`.
 * Nothing here discovers a revision, decides what is current, writes a receipt,
 * sends a bus message, invokes a model, reads the environment, or grants authority.
 */

import { createHash } from 'node:crypto';

export const CAPSULE_MANIFEST_SCHEMA = 'gaia-context-capsule-manifest/1';
export const CAPSULE_FACT_SCHEMA = 'gaia-context-fact/1';
export const CAPSULE_RESPONSE_SCHEMA = 'gaia-context-capsule-response/1';
export const CAPSULE_RECEIPT_SCHEMA = 'gaia-context-capsule-receipt/1';
export const CAPSULE_ERROR_SCHEMA = 'gaia-context-capsule-error/1';
export const CAPSULE_SELECTION_POLICY = 'exact-pinned-revision/1';
export const MAX_CAPSULE_MANIFEST_BYTES = 1024 * 1024;
export const MAX_CAPSULE_FACT_BYTES = 64 * 1024;

const HEX_64 = /^[0-9a-f]{64}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const IMMUTABLE_REVISION = /^(0|[1-9][0-9]{0,15})$/;

export class ContextCapsuleError extends Error {
  constructor(code) {
    super(code);
    this.name = 'ContextCapsuleError';
    this.code = code;
    this.failClosed = true;
    this.authorityEffect = 'none';
  }
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function canonicalValue(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  }
  throw new TypeError('value is outside the canonical JSON domain');
}

function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function digestJson(value) {
  return Object.freeze({ algorithm: 'sha256', digest: sha256(Buffer.from(canonicalJson(value), 'utf8')) });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function refusal(code) {
  return deepFreeze({
    ok: false,
    error: {
      schema: CAPSULE_ERROR_SCHEMA,
      code,
      failClosed: true,
      authorityEffect: 'none',
    },
  });
}

function assertExactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new TypeError(`${label} has an unsupported shape`);
  }
}

function assertRevision(value, label, code = 'CAPSULE_INVALID_INPUT') {
  try {
    assertExactKeys(value, ['artifactId', 'revision', 'algorithm', 'digest'], label);
  } catch {
    throw new ContextCapsuleError(code);
  }
  if (!SAFE_ID.test(value.artifactId) || !IMMUTABLE_REVISION.test(value.revision)
      || value.algorithm !== 'sha256' || !HEX_64.test(value.digest)) {
    throw new ContextCapsuleError(code);
  }
}

async function readExact(adapter, revision, maxBytes) {
  let raw;
  try {
    raw = await adapter.readRevision(revision);
  } catch {
    throw new ContextCapsuleError('CAPSULE_READ_FAILED');
  }
  if (!(raw instanceof Uint8Array)) throw new ContextCapsuleError('CAPSULE_READ_FAILED');
  const bytes = Buffer.from(raw);
  if (bytes.length > maxBytes) throw new ContextCapsuleError('CAPSULE_LIMIT_EXCEEDED');
  if (sha256(bytes) !== revision.digest) throw new ContextCapsuleError('CAPSULE_DIGEST_MISMATCH');
  return bytes;
}

function parseJson(bytes, label) {
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    value = JSON.parse(text);
  } catch {
    throw new TypeError(`${label} is not strict UTF-8 JSON`);
  }
  if (canonicalJson(value) !== text) throw new ContextCapsuleError('CAPSULE_NON_CANONICAL_JSON');
  return value;
}

function validateManifest(value) {
  try {
    assertExactKeys(value, ['schema', 'capsuleId', 'selectionPolicy', 'facts'], 'manifest');
  } catch {
    throw new ContextCapsuleError('CAPSULE_INVALID_MANIFEST');
  }
  if (value.schema !== CAPSULE_MANIFEST_SCHEMA) throw new ContextCapsuleError('CAPSULE_UNSUPPORTED_SCHEMA');
  if (!SAFE_ID.test(value.capsuleId)) throw new ContextCapsuleError('CAPSULE_INVALID_MANIFEST');
  if (value.selectionPolicy !== CAPSULE_SELECTION_POLICY || !Array.isArray(value.facts)) {
    throw new ContextCapsuleError('CAPSULE_INVALID_MANIFEST');
  }
  const seen = new Set();
  for (const fact of value.facts) {
    try {
      assertExactKeys(fact, ['factId', 'source'], 'manifest fact');
    } catch {
      throw new ContextCapsuleError('CAPSULE_INVALID_MANIFEST');
    }
    if (!SAFE_ID.test(fact.factId) || seen.has(fact.factId)) {
      throw new ContextCapsuleError('CAPSULE_INVALID_MANIFEST');
    }
    assertRevision(fact.source, 'manifest fact source', 'CAPSULE_INVALID_MANIFEST');
    seen.add(fact.factId);
  }
  return deepFreeze(value);
}

function validateFact(value, factId, source) {
  try {
    assertExactKeys(value, ['schema', 'factId', 'value', 'exposure', 'trust', 'authorityEffect'], 'fact');
  } catch {
    throw new ContextCapsuleError('CAPSULE_UNSAFE_RECORD');
  }
  if (value.schema !== CAPSULE_FACT_SCHEMA) {
    throw new ContextCapsuleError('CAPSULE_UNSUPPORTED_SCHEMA');
  }
  if (value.factId !== factId) throw new ContextCapsuleError('CAPSULE_SOURCE_MISMATCH');
  if (typeof value.value !== 'string') throw new ContextCapsuleError('CAPSULE_UNSAFE_RECORD');
  if (value.exposure !== 'model-context' || value.trust !== 'untrusted-data' || value.authorityEffect !== 'none') {
    throw new ContextCapsuleError('CAPSULE_UNSAFE_RECORD');
  }
  return deepFreeze({
    schema: CAPSULE_RESPONSE_SCHEMA,
    factId,
    value: value.value,
    trust: 'untrusted-data',
    authorityEffect: 'none',
    source,
  });
}

/**
 * Bind one exact manifest revision to one read-only revision Adapter.
 *
 * @param {{artifactId:string,revision:string,algorithm:'sha256',digest:string}} manifestRevision
 * @param {{readRevision(ref:object):Promise<Uint8Array>}} revisionAdapter
 */
export async function openContextCapsule(manifestRevision, revisionAdapter) {
  assertRevision(manifestRevision, 'manifest revision');
  if (!revisionAdapter || typeof revisionAdapter.readRevision !== 'function') {
    throw new TypeError('revision adapter must expose readRevision(ref)');
  }
  const boundManifestRevision = deepFreeze({ ...manifestRevision });
  const manifestBytes = await readExact(
    revisionAdapter, boundManifestRevision, MAX_CAPSULE_MANIFEST_BYTES,
  );
  let manifest;
  try {
    manifest = validateManifest(parseJson(manifestBytes, 'manifest'));
  } catch (error) {
    if (error instanceof ContextCapsuleError) throw error;
    throw new ContextCapsuleError('CAPSULE_INVALID_MANIFEST');
  }

  const get = async (factId) => {
    if (typeof factId !== 'string' || !SAFE_ID.test(factId)) return refusal('CAPSULE_INVALID_INPUT');
    const entry = manifest.facts.find((candidate) => candidate.factId === factId);
    if (!entry) return refusal('CAPSULE_FACT_NOT_PINNED');
    try {
      const factBytes = await readExact(
        revisionAdapter, entry.source, MAX_CAPSULE_FACT_BYTES,
      );
      const response = validateFact(parseJson(factBytes, 'fact'), factId, entry.source);
      const receiptBody = {
        schema: CAPSULE_RECEIPT_SCHEMA,
        operation: 'get',
        requestRevision: digestJson({ operation: 'get', factId }),
        capsuleRevision: boundManifestRevision,
        sourceRevision: entry.source,
        responseRevision: digestJson(response),
        selectionPolicy: CAPSULE_SELECTION_POLICY,
        readOnly: true,
        trust: 'untrusted-data',
        authorityEffect: 'none',
      };
      const receipt = deepFreeze({ ...receiptBody, receiptRevision: digestJson(receiptBody) });
      return deepFreeze({
        ok: true,
        response,
        receipt,
        receiptCanonicalJson: canonicalJson(receipt),
      });
    } catch (error) {
      if (error instanceof ContextCapsuleError) return refusal(error.code);
      return refusal('CAPSULE_UNSAFE_RECORD');
    }
  };

  return deepFreeze({ get });
}
