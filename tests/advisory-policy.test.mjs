import assert from 'node:assert/strict';
import test from 'node:test';

import {
  advisoryAuthority,
  ADVISORY_AUTHORITY,
  ADVISORY_HARD_LIMITS,
  ADVISORY_WORK_SHAPE,
  isAdvisoryAuthority,
} from '../src/advisory-policy.mjs';

test('central advisory policy is exact, deeply immutable, and shared by reference', () => {
  assert.strictEqual(advisoryAuthority(), ADVISORY_AUTHORITY);
  assert.equal(Object.isFrozen(ADVISORY_AUTHORITY), true);
  assert.equal(Object.isFrozen(ADVISORY_AUTHORITY.requestedAuthority), true);
  assert.equal(Object.isFrozen(ADVISORY_HARD_LIMITS), true);
  assert.equal(Object.isFrozen(ADVISORY_WORK_SHAPE), true);
  assert.deepEqual(ADVISORY_WORK_SHAPE, {
    maxDepth: 0,
    maxConcurrency: 1,
    fanoutAuthorized: false,
  });
  assert.equal(isAdvisoryAuthority(ADVISORY_AUTHORITY), true);
  assert.equal(isAdvisoryAuthority({ ...ADVISORY_AUTHORITY, extra: true }), false);
  assert.equal(isAdvisoryAuthority({ ...ADVISORY_AUTHORITY, executionAuthorized: true }), false);
});
