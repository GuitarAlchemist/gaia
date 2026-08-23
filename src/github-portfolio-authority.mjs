import { createHash, verify } from 'node:crypto';
import { lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class PortfolioAuthorityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'PortfolioAuthorityError';
    this.code = code;
  }
}

const PAYLOAD_KEYS = [
  'action', 'expiresAt', 'grantId', 'intentRevision', 'itemId', 'itemKind',
  'itemNumber', 'repository', 'schema', 'snapshotRevision',
];
const GRANT_KEYS = [...PAYLOAD_KEYS, 'signature'].sort();

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function exactObject(value, keys, label) {
  const ownKeys = value && typeof value === 'object' ? Reflect.ownKeys(value) : [];
  const descriptors = value && typeof value === 'object'
    ? Object.getOwnPropertyDescriptors(value)
    : {};
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
      || ownKeys.some((key) => typeof key !== 'string')
      || JSON.stringify([...ownKeys].sort()) !== JSON.stringify([...keys].sort())
      || ownKeys.some((key) => !descriptors[key]?.enumerable
        || !Object.hasOwn(descriptors[key], 'value'))) {
    throw new PortfolioAuthorityError('GrantInvalid', `${label} must contain exactly its schema fields`);
  }
}

function text(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new PortfolioAuthorityError('GrantInvalid', `${field} must be canonical text`);
  }
  return value;
}

function digest(value, field) {
  const result = text(value, field);
  if (!/^[a-f0-9]{64}$/u.test(result)) {
    throw new PortfolioAuthorityError('GrantInvalid', `${field} must be a lowercase SHA-256`);
  }
  return result;
}

function normalizePayload(payload) {
  exactObject(payload, PAYLOAD_KEYS, 'grant payload');
  if (payload.schema !== 'gaia-github-portfolio-grant/1') {
    throw new PortfolioAuthorityError('GrantInvalid', 'unsupported grant schema');
  }
  if (!Number.isSafeInteger(payload.itemNumber) || payload.itemNumber < 1) {
    throw new PortfolioAuthorityError('GrantInvalid', 'itemNumber must be a positive integer');
  }
  const expiresAt = text(payload.expiresAt, 'expiresAt');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(expiresAt)
      || Number.isNaN(Date.parse(expiresAt))
      || new Date(expiresAt).toISOString() !== expiresAt) {
    throw new PortfolioAuthorityError('GrantInvalid', 'expiresAt must be canonical UTC milliseconds');
  }
  return {
    schema: payload.schema,
    grantId: text(payload.grantId, 'grantId'),
    intentRevision: digest(payload.intentRevision, 'intentRevision'),
    action: text(payload.action, 'action'),
    repository: text(payload.repository, 'repository'),
    itemKind: text(payload.itemKind, 'itemKind'),
    itemId: text(payload.itemId, 'itemId'),
    itemNumber: payload.itemNumber,
    snapshotRevision: digest(payload.snapshotRevision, 'snapshotRevision'),
    expiresAt,
  };
}

export function portfolioGrantPreimage(payload) {
  return Buffer.from(JSON.stringify(normalizePayload(payload)), 'utf8');
}

export function createFileEd25519AuthorityAdapter({ publicKey, ledgerDir, now = () => new Date() }) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  const metadata = lstatSync(ledgerDir);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PortfolioAuthorityError('GrantLedger', 'ledgerDir must be a real existing directory');
  }
  const physicalLedger = realpathSync.native(ledgerDir);

  return Object.freeze({
    async consume({ grant, intent }) {
      exactObject(grant, GRANT_KEYS, 'grant');
      const { signature, ...payloadInput } = grant;
      const payload = normalizePayload(payloadInput);
      if (typeof signature !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(signature)) {
        throw new PortfolioAuthorityError('GrantInvalid', 'signature must be base64url');
      }
      const intentFields = [
        'intentRevision', 'action', 'repository', 'itemKind', 'itemId', 'itemNumber',
        'snapshotRevision',
      ];
      if (!intent || intentFields.some((field) => payload[field] !== intent[field])) {
        throw new PortfolioAuthorityError('GrantScopeMismatch', 'grant does not match the exact intent');
      }
      const observedNow = now();
      if (!(observedNow instanceof Date) || Number.isNaN(observedNow.valueOf())) {
        throw new PortfolioAuthorityError('GrantClock', 'authority clock returned an invalid date');
      }
      if (Date.parse(payload.expiresAt) <= observedNow.valueOf()) {
        throw new PortfolioAuthorityError('GrantExpired', 'grant has expired');
      }
      let valid = false;
      try {
        valid = verify(
          null,
          portfolioGrantPreimage(payload),
          publicKey,
          Buffer.from(signature, 'base64url'),
        );
      } catch {
        throw new PortfolioAuthorityError('GrantInvalid', 'grant signature could not be verified');
      }
      if (!valid) throw new PortfolioAuthorityError('GrantInvalid', 'grant signature is invalid');

      const claim = {
        schema: 'gaia-github-portfolio-grant-consumption/1',
        grantId: payload.grantId,
        intentRevision: payload.intentRevision,
        signatureSha256: sha256(Buffer.from(signature, 'base64url')),
      };
      const claimPath = join(physicalLedger, `${sha256(payload.grantId)}.json`);
      try {
        writeFileSync(claimPath, `${JSON.stringify(claim)}\n`, {
          encoding: 'utf8', flag: 'wx', mode: 0o600,
        });
      } catch (error) {
        if (error?.code === 'EEXIST') {
          throw new PortfolioAuthorityError('GrantConsumed', 'grant was already consumed');
        }
        throw new PortfolioAuthorityError('GrantLedger', `grant claim failed: ${error?.code ?? 'unknown'}`);
      }
      return {
        status: 'AUTHORIZED',
        grantId: payload.grantId,
        intentRevision: payload.intentRevision,
      };
    },
  });
}
