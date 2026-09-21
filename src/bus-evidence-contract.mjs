const CURSOR_KEYS = [
  'byteOffset',
  'finalEventIdentity',
  'instanceId',
  'prefixSha256',
  'recordCount',
  'schema',
];

export const BUS_EVIDENCE_CURSOR_SCHEMA = 'gaia.bus-evidence-cursor/1';

const SHA256 = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/** Pure boundary-neutral validation for the one durable bus cursor contract. */
export function isBusEvidenceCursor(cursor) {
  const valid = cursor
    && typeof cursor === 'object'
    && !Array.isArray(cursor)
    && Object.keys(cursor).sort().join(',') === CURSOR_KEYS.join(',')
    && cursor.schema === BUS_EVIDENCE_CURSOR_SCHEMA
    && typeof cursor.instanceId === 'string'
    && UUID.test(cursor.instanceId)
    && Number.isSafeInteger(cursor.recordCount)
    && cursor.recordCount >= 0
    && Number.isSafeInteger(cursor.byteOffset)
    && cursor.byteOffset >= 0
    && SHA256.test(cursor.prefixSha256)
    && (cursor.finalEventIdentity === null || SHA256.test(cursor.finalEventIdentity));
  return Boolean(valid) && (cursor.recordCount === 0) === (cursor.finalEventIdentity === null);
}
