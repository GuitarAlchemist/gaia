/**
 * Canonical cross-module invariants for artifacts that may advise but never act.
 *
 * Domain modules own their own validation rules. This module owns only the
 * invariants and hard ceilings that an adapter is not allowed to reinterpret.
 */

import { canonicalJson } from './epistemic-research.mjs';

const AUTHORITY_KEYS = [
  'effect', 'executionAuthorized', 'mode', 'requestedAuthority',
  'sourceMutationAuthorized',
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
}

export const ADVISORY_HARD_LIMITS = deepFreeze({
  maxDurationMs: 86_400_000,
  maxExpiryMs: 604_800_000,
  maxHumanAttentionMinutes: 240,
  maxIncrementalPaidUsd: 0,
  maxInputArtifacts: 1_024,
  maxTokens: 1_000_000,
});

export const ADVISORY_AUTHORITY = deepFreeze({
  mode: 'advisory',
  effect: 'NONE',
  sourceMutationAuthorized: false,
  executionAuthorized: false,
  requestedAuthority: [],
});

export const ADVISORY_WORK_SHAPE = deepFreeze({
  maxDepth: 0,
  maxConcurrency: 1,
  fanoutAuthorized: false,
});

export function advisoryAuthority() {
  return ADVISORY_AUTHORITY;
}

export function isAdvisoryAuthority(value) {
  return Boolean(value)
    && typeof value === 'object'
    && canonicalJson(Object.keys(value).sort()) === canonicalJson([...AUTHORITY_KEYS].sort())
    && canonicalJson(value) === canonicalJson(ADVISORY_AUTHORITY);
}

export { deepFreeze };
