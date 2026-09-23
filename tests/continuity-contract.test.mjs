import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ContinuityError,
  canonicalContinuityJson,
  portableReceiptDigest,
  validatePortableReceipt,
} from '../src/continuity-contract.mjs';

const ROOT = join(import.meta.dirname, '..');
const EXPECTED_FIXTURE_DIGEST = '7222b292a29e519eb081e9ffd08fe9c8d366e857ad2243074e78750a8972128e';

test('the neutral fixture has the cross-language canonical digest', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'contracts', 'fixtures',
    'continuity.successor-transition-receipt.valid.json'), 'utf8'));
  assert.equal(portableReceiptDigest(fixture), EXPECTED_FIXTURE_DIGEST);
  assert.deepEqual(validatePortableReceipt({ ...fixture, receiptDigest: EXPECTED_FIXTURE_DIGEST }),
    { ...fixture, receiptDigest: EXPECTED_FIXTURE_DIGEST });
});

test('canonical JSON is ASCII-key ordered and rejects values outside the portable subset', () => {
  assert.equal(canonicalContinuityJson({ z: 0, a: ['x', { b: true, a: null }] }),
    '{"a":["x",{"a":null,"b":true}],"z":0}');
  for (const value of [1.5, -1, { nonAscii: 'é' }, { nested: undefined }]) {
    assert.throws(() => canonicalContinuityJson(value),
      error => error instanceof ContinuityError && error.code === 'INVALID_CANONICAL_VALUE');
  }
});

test('portable validation is closed and carries no authority effects', () => {
  const fixture = JSON.parse(readFileSync(join(ROOT, 'contracts', 'fixtures',
    'continuity.successor-transition-receipt.valid.json'), 'utf8'));
  fixture.receiptDigest = EXPECTED_FIXTURE_DIGEST;
  assert.throws(() => validatePortableReceipt({ ...fixture, extra: true }),
    error => error.code === 'INVALID_PORTABLE_RECEIPT');
  assert.throws(() => validatePortableReceipt({ ...fixture, authority: { effects: ['merge'] } }),
    error => error.code === 'INVALID_PORTABLE_RECEIPT');
  for (const mutate of [
    receipt => { receipt.successor.actorRef = 7; },
    receipt => { receipt.outputArtifact.mediaType = true; },
    receipt => { receipt.outputArtifact.sha256 = 6; },
  ]) {
    const invalid = structuredClone(fixture);
    mutate(invalid);
    invalid.receiptDigest = portableReceiptDigest(invalid);
    assert.throws(() => validatePortableReceipt(invalid),
      error => error.code === 'INVALID_PORTABLE_RECEIPT');
  }
});
