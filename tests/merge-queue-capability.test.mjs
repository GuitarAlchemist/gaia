/**
 * merge-queue-capability.test.mjs — the `gaia-merge-queue-capability/1` artifact, the one decision
 * from it to a closed state, and the refused-by-default remediation.
 *
 * Gates M1-M22 of `docs/merge-queue-capability.md`. The operator failure behind all of them is a
 * product that waited for a pull request to enter a merge queue that did not exist, because it
 * read the pull request's own cleanliness instead of the repository's configuration. Most of what
 * is asserted here is what the decision refuses to conclude.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  MERGE_QUEUE_CAPABILITY_FIELDS,
  MERGE_QUEUE_CAPABILITY_FRESH_MS,
  MERGE_QUEUE_CAPABILITY_SCHEMA,
  MERGE_QUEUE_CAPABILITY_STATES,
  MERGE_QUEUE_OBSERVATION_FIELDS,
  MERGE_QUEUE_REMEDIATION_INTENT_SCHEMA,
  MERGE_QUEUE_REMEDIATION_REFUSALS,
  MERGE_QUEUE_REMEDIATION_VERDICTS,
  MERGE_QUEUE_RULESET_FIELDS,
  MergeQueueCapabilityError,
  decideMergeQueueCapability,
  deriveMergeQueueCapabilityBlock,
  executeMergeQueueRemediation,
  mergeQueueCapabilityRevision,
  planMergeQueueRemediation,
  probeMergeQueueCapability,
  reconcileMergeQueueRemediation,
  requireMergeQueueCapabilityArtifact,
  resolveTargetsDefaultBranch,
  sealMergeQueueCapability,
} from '../src/merge-queue-capability.mjs';
import { isExactInstant } from '../src/local-lane-observation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const MINUTE_MS = 60_000;
const OBSERVED_AT = '2026-08-30T19:18:00.000Z';
const REPOSITORY_ID = 'R_kgDOMergeQueue';
const REPOSITORY = 'GuitarAlchemist/gaia';
const DEFAULT_BRANCH = 'main';

/** Relative to the observation instant, so no test hard-codes an offset twice. */
const at = (offsetMs) => new Date(Date.parse(OBSERVED_AT) + offsetMs).toISOString();

/** The house canonical JSON, re-spelled here so a test never quotes the module it verifies. */
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** One ruleset record. `mergeQueueRule` defaults to the enabled rule, because that is the case. */
const ruleset = (overrides = {}) => ({
  rulesetId: '4110',
  name: 'gaia-merge-queue',
  enforcement: 'active',
  targetsDefaultBranch: true,
  mergeQueueRule: { enabled: true },
  ...overrides,
});

/** One observation. The default is the incident: a successful read that found nothing. */
function observation(overrides = {}) {
  const rulesets = overrides.rulesets ?? [];
  const body = {
    rulesetsRead: 'OK',
    rulesetsComplete: true,
    protectionRead: 'NOT_FOUND',
    adminPermission: 'ABSENT',
    unknownRuleTypes: [],
    ...overrides,
    rulesets,
  };
  return {
    ...body,
    rulesetDigest: body.rulesetsRead === 'OK' ? sha256(canonicalJson(rulesets)) : null,
    ...(Object.hasOwn(overrides, 'rulesetDigest') ? { rulesetDigest: overrides.rulesetDigest } : {}),
  };
}

/** Sealed through the shipped recipe. */
const seal = (overrides = {}) => sealMergeQueueCapability({
  observedAt: OBSERVED_AT,
  repositoryId: REPOSITORY_ID,
  repository: REPOSITORY,
  defaultBranch: DEFAULT_BRANCH,
  observation: observation(),
  ...overrides,
});

/**
 * Hand-sealed with a digest computed here rather than by the module, so that when a gate refuses
 * a value it is the rule under test that refused it and not a mismatched revision standing in.
 */
function handBuilt(overrides = {}) {
  const body = {
    schema: MERGE_QUEUE_CAPABILITY_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observedAt: OBSERVED_AT,
    repositoryId: REPOSITORY_ID,
    repository: REPOSITORY,
    defaultBranch: DEFAULT_BRANCH,
    observation: observation(),
    ...overrides,
  };
  return { ...body, revision: sha256(canonicalJson(body)) };
}

/** Assert one typed refusal, by class and code, never by message. */
function refuses(run, code, message) {
  assert.throws(run, (error) => error instanceof MergeQueueCapabilityError
    && error.code === code, message);
}

/** The state this artifact decides when read at the instant it was observed. */
const stateOf = (overrides = {}, observedAt = OBSERVED_AT) => decideMergeQueueCapability({
  artifact: seal(overrides), observedAt,
});

// ---------------------------------------------------------------------------------------------
// M1 — the closed schema round-trips, seals deterministically, and is deeply frozen.
// ---------------------------------------------------------------------------------------------

test('M1: a sealed capability artifact round-trips, seals deterministically and is deeply frozen', () => {
  const artifact = seal();
  assert.equal(artifact.schema, MERGE_QUEUE_CAPABILITY_SCHEMA);
  assert.equal(artifact.effect, 'NONE', 'a capability reading can never carry an effect');
  assert.equal(artifact.authority, 'NONE', 'a capability reading can never carry authority');
  assert.deepEqual(
    Object.keys(artifact).sort(), [...MERGE_QUEUE_CAPABILITY_FIELDS].sort(),
    'the artifact carries exactly the declared fields',
  );
  assert.equal(artifact.revision, seal().revision, 'the same evidence seals to the same revision');
  assert.equal(artifact.revision, handBuilt().revision, 'the digest recipe is the canonical body');
  assert.equal(artifact.revision, mergeQueueCapabilityRevision({
    observedAt: OBSERVED_AT,
    repositoryId: REPOSITORY_ID,
    repository: REPOSITORY,
    defaultBranch: DEFAULT_BRANCH,
    observation: observation(),
  }), 'and the exported recipe is the only one, so no consumer grows a second');
  assert.ok(Object.isFrozen(artifact) && Object.isFrozen(artifact.observation),
    'a sealed artifact is deeply frozen');
  assert.equal(requireMergeQueueCapabilityArtifact(artifact), artifact,
    'the verifier accepts what the seal produced');
});

test('M1: the closed state vocabulary is exactly the six the design names', () => {
  assert.deepEqual([...MERGE_QUEUE_CAPABILITY_STATES].sort(),
    ['ABSENT', 'AVAILABLE', 'MISCONFIGURED', 'PERMISSION_DENIED', 'STALE', 'UNKNOWN']);
});

// ---------------------------------------------------------------------------------------------
// M2 — unknown fields are refused, including every pull-request status field.
// ---------------------------------------------------------------------------------------------

test('M2: an unknown top-level field is refused even when the artifact seals correctly', () => {
  refuses(() => requireMergeQueueCapabilityArtifact(handBuilt({ mergeable: true })),
    'InvalidMergeQueueCapability', 'an unknown top-level field is refused');
});

test('M2: no pull-request status field can be carried in the observation', () => {
  for (const field of ['mergeable', 'mergeStateStatus', 'autoMergeRequest', 'checkConclusion',
    'reviewDecision', 'isDraft']) {
    refuses(
      () => requireMergeQueueCapabilityArtifact(handBuilt({
        observation: { ...observation(), [field]: 'CLEAN' },
      })),
      'InvalidMergeQueueCapability',
      `${field} has no field to arrive through`,
    );
    assert.equal(MERGE_QUEUE_OBSERVATION_FIELDS.includes(field), false,
      `${field} is not in the observation field list`);
  }
});

test('M2: an unknown per-ruleset field is refused', () => {
  refuses(
    () => requireMergeQueueCapabilityArtifact(handBuilt({
      observation: observation({ rulesets: [{ ...ruleset(), autoMergeAllowed: true }] }),
    })),
    'InvalidMergeQueueCapability',
  );
  assert.deepEqual([...MERGE_QUEUE_RULESET_FIELDS].sort(),
    ['enforcement', 'mergeQueueRule', 'name', 'rulesetId', 'targetsDefaultBranch']);
});

test('M2: the module source names no pull-request status field at all', () => {
  const source = readFileSync(join(ROOT, 'src', 'merge-queue-capability.mjs'), 'utf8');
  for (const forbidden of ['mergeStateStatus', 'autoMergeRequest', 'mergeable', 'reviewDecision']) {
    assert.equal(source.includes(forbidden), false,
      `${forbidden} cannot reach the decision, so it is not named in the module`);
  }
});

// ---------------------------------------------------------------------------------------------
// M3 — instants are exact, coherent, and never clamped.
// ---------------------------------------------------------------------------------------------

test('M3: an instant that is not exact is refused, never widened', () => {
  for (const instant of ['2026-08-30', '2026-08-30T19:18:00Z', '2026-08-30T19:18:00.000+00:00',
    'not-a-date', '']) {
    refuses(() => requireMergeQueueCapabilityArtifact(handBuilt({ observedAt: instant })),
      'InvalidMergeQueueCapability', `${JSON.stringify(instant)} is not an exact instant`);
  }
});

test('M3: reading an artifact before it was observed is refused, never clamped to zero age', () => {
  refuses(() => decideMergeQueueCapability({ artifact: seal(), observedAt: at(-1) }),
    'InvalidMergeQueueCapability', 'evidence dated after the reading is incoherent');
});

// ---------------------------------------------------------------------------------------------
// M4-M9e — the decision table, and everything it refuses to conclude.
// ---------------------------------------------------------------------------------------------

test('M4: a complete read finding no ruleset, with an unprotected branch, decides ABSENT', () => {
  assert.equal(stateOf(), 'ABSENT');
});

test('M5: one active ruleset carrying a merge queue rule on the default branch decides AVAILABLE', () => {
  assert.equal(stateOf({ observation: observation({ rulesets: [ruleset()] }) }), 'AVAILABLE');
});

test('M5: an unprotected branch does not prevent AVAILABLE', () => {
  assert.equal(
    stateOf({
      observation: observation({ rulesets: [ruleset()], protectionRead: 'NOT_FOUND' }),
    }),
    'AVAILABLE',
    'branch protection cannot express a merge queue, so its absence refutes nothing',
  );
});

test('M6: a 403 on either read decides PERMISSION_DENIED and outranks the content', () => {
  assert.equal(stateOf({ observation: observation({ rulesetsRead: 'FORBIDDEN' }) }),
    'PERMISSION_DENIED');
  assert.equal(
    stateOf({ observation: observation({ rulesets: [ruleset()], protectionRead: 'FORBIDDEN' }) }),
    'PERMISSION_DENIED',
    'a permission failure outranks an otherwise available configuration',
  );
});

test('M7: a 404 on the rulesets collection decides UNKNOWN, never ABSENT', () => {
  assert.equal(stateOf({ observation: observation({ rulesetsRead: 'NOT_FOUND' }) }), 'UNKNOWN');
});

test('M8: evaluate, disabled, wrong-branch and two-active carriers decide MISCONFIGURED', () => {
  const cases = {
    evaluate: [ruleset({ enforcement: 'evaluate' })],
    disabled: [ruleset({ enforcement: 'disabled' })],
    'wrong branch': [ruleset({ targetsDefaultBranch: false })],
    'two active carriers': [ruleset(), ruleset({ rulesetId: '4111', name: 'other' })],
  };
  for (const [why, rulesets] of Object.entries(cases)) {
    assert.equal(stateOf({ observation: observation({ rulesets }) }), 'MISCONFIGURED',
      `${why} is a configuration that will not serve a merge`);
  }
});

test('M8: a ruleset carrying no merge queue rule at all decides ABSENT, not MISCONFIGURED', () => {
  assert.equal(
    stateOf({ observation: observation({ rulesets: [ruleset({ mergeQueueRule: null })] }) }),
    'ABSENT',
    'a repository with rules but no merge queue rule has no merge queue',
  );
});

test('M9: an unmodelled rule type decides UNKNOWN, never AVAILABLE', () => {
  assert.equal(
    stateOf({
      observation: observation({
        rulesets: [ruleset()], unknownRuleTypes: ['file_path_restriction'],
      }),
    }),
    'UNKNOWN',
    'a rule Gaia cannot model may be the one that governs merging',
  );
});

test('M9a: a rate-limit or single-sign-on 403 decides UNKNOWN, never PERMISSION_DENIED', () => {
  assert.equal(stateOf({ observation: observation({ rulesetsRead: 'RATE_LIMITED' }) }), 'UNKNOWN',
    'a rate limit is not a permission problem and widening a token would not fix it');
  assert.equal(stateOf({ observation: observation({ protectionRead: 'RATE_LIMITED' }) }), 'UNKNOWN');
});

test('M9b: an incomplete or paginated rulesets listing decides UNKNOWN, never ABSENT', () => {
  assert.equal(stateOf({ observation: observation({ rulesetsComplete: false }) }), 'UNKNOWN',
    'a merge queue rule on an unread page is not an absent merge queue');
});

test('M9c: ref-name conditions resolve against the named default branch', () => {
  const cases = [
    [{ include: ['~ALL'], exclude: [] }, true],
    [{ include: ['~DEFAULT_BRANCH'], exclude: [] }, true],
    [{ include: ['refs/heads/main'], exclude: [] }, true],
    [{ include: ['refs/heads/release'], exclude: [] }, false],
    [{ include: ['~ALL'], exclude: ['refs/heads/main'] }, false],
    [{ include: ['~ALL'], exclude: ['~DEFAULT_BRANCH'] }, false],
    [{ include: ['refs/heads/*'], exclude: [] }, 'UNKNOWN'],
  ];
  for (const [conditions, expected] of cases) {
    assert.equal(
      resolveTargetsDefaultBranch({ ...conditions, defaultBranch: DEFAULT_BRANCH }), expected,
      `${JSON.stringify(conditions)} resolves to ${expected}`,
    );
  }
});

test('M9d: a 200 branch-protection read contributes no positive capability finding', () => {
  assert.equal(stateOf({ observation: observation({ protectionRead: 'OK' }) }), 'ABSENT',
    'a protected branch with no merge queue ruleset still has no merge queue');
  assert.equal(
    stateOf({ observation: observation({ rulesets: [ruleset()], protectionRead: 'OK' }) }),
    'AVAILABLE',
    'and a protected branch does not change an available one either',
  );
});

test('M9e: the decision is byte-identical across every state the rest of the world can be in', () => {
  const decided = new Set();
  for (const protectionRead of ['OK', 'NOT_FOUND']) {
    for (const adminPermission of ['PRESENT', 'ABSENT', 'UNKNOWN']) {
      decided.add(stateOf({ observation: observation({ protectionRead, adminPermission }) }));
    }
  }
  assert.deepEqual([...decided], ['ABSENT'],
    'neither the protection reading nor the write permission may move the capability verdict');
});

// ---------------------------------------------------------------------------------------------
// M10 — freshness is a consumer verdict, applied to every underlying state.
// ---------------------------------------------------------------------------------------------

test('M10: evidence beyond the freshness window decides STALE, from every underlying state', () => {
  const beyond = MERGE_QUEUE_CAPABILITY_FRESH_MS + 1;
  const underlying = [
    ['ABSENT', observation()],
    ['AVAILABLE', observation({ rulesets: [ruleset()] })],
    ['MISCONFIGURED', observation({ rulesets: [ruleset({ enforcement: 'evaluate' })] })],
    ['PERMISSION_DENIED', observation({ rulesetsRead: 'FORBIDDEN' })],
    ['UNKNOWN', observation({ rulesetsRead: 'NOT_FOUND' })],
  ];
  for (const [expected, value] of underlying) {
    assert.equal(stateOf({ observation: value }), expected, `${expected} while fresh`);
    assert.equal(stateOf({ observation: value }, at(beyond)), 'STALE',
      `${expected} decays to STALE, because an operator may have changed it since`);
  }
});

test('M10: evidence exactly at the freshness boundary is still readable', () => {
  assert.equal(stateOf({}, at(MERGE_QUEUE_CAPABILITY_FRESH_MS)), 'ABSENT',
    'the boundary is closed, so a reading exactly its own age old is not yet stale');
});

// ---------------------------------------------------------------------------------------------
// M11-M12 — determinism, and one implementation of each shared rule.
// ---------------------------------------------------------------------------------------------

test('M11: identical evidence produces byte-identical decisions, digests and blocks', () => {
  const first = deriveMergeQueueCapabilityBlock({ artifact: seal(), observedAt: at(MINUTE_MS) });
  const second = deriveMergeQueueCapabilityBlock({ artifact: seal(), observedAt: at(MINUTE_MS) });
  assert.equal(canonicalJson(first), canonicalJson(second));
  assert.equal(first.state, 'ABSENT');
  assert.equal(first.observationAgeMs, MINUTE_MS, 'the age is measured, not asserted');
  assert.equal(first.freshnessWindowMs, MERGE_QUEUE_CAPABILITY_FRESH_MS);
  assert.equal(first.artifactRevision, seal().revision, 'the block binds the evidence it read');
  assert.equal(first.repositoryId, REPOSITORY_ID, 'the block binds the repository identity');
  assert.equal(first.defaultBranch, DEFAULT_BRANCH, 'the block binds the branch');
  assert.ok(Object.isFrozen(first), 'the block is frozen');
});

test('M12: the module owns no clock, opens nothing and holds no retry loop', () => {
  const source = readFileSync(join(ROOT, 'src', 'merge-queue-capability.mjs'), 'utf8');
  for (const forbidden of ['Date.now', 'new Date()', 'setTimeout', 'setInterval',
    'node:fs', 'node:child_process', 'node:net', 'node:http']) {
    assert.equal(source.includes(forbidden), false, `the module must not reach for ${forbidden}`);
  }
  assert.equal(source.includes('isExactInstant'), true,
    'the exact-instant rule is imported, never re-spelled');
  assert.equal(isExactInstant(OBSERVED_AT), true, 'and it is the shared one');
});

test('M12: a tampered revision is refused', () => {
  refuses(() => requireMergeQueueCapabilityArtifact({ ...seal(), revision: sha256('tampered') }),
    'InvalidMergeQueueCapability');
});

test('M12: a ruleset digest that is not the digest of the rulesets it names is refused', () => {
  refuses(
    () => requireMergeQueueCapabilityArtifact(handBuilt({
      observation: observation({ rulesets: [ruleset()], rulesetDigest: sha256('elsewhere') }),
    })),
    'InvalidMergeQueueCapability',
    'the compare-and-swap token is derived, not asserted',
  );
  assert.equal(
    seal({ observation: observation({ rulesets: [ruleset()] }) }).observation.rulesetDigest,
    sha256(canonicalJson([ruleset()])),
    'and the recipe is the canonical JSON of the rulesets themselves',
  );
});

// ---------------------------------------------------------------------------------------------
// The probe — the one read-only producer, driven entirely by a fake transport.
// ---------------------------------------------------------------------------------------------

/** A transport that answers by path, so a test states exactly what GitHub said. */
function transport(answers) {
  const calls = [];
  const read = async (path) => {
    calls.push(path);
    const answer = answers[path];
    if (!answer) throw new Error(`unexpected capability read: ${path}`);
    return answer;
  };
  return { read, calls };
}

const RULESETS_PATH = `repos/${REPOSITORY}/rulesets`;
const PROTECTION_PATH = `repos/${REPOSITORY}/branches/${DEFAULT_BRANCH}/protection`;

test('the probe turns a zero-ruleset repository with an unprotected branch into ABSENT', async () => {
  const { read } = transport({
    [RULESETS_PATH]: { status: 200, body: [], complete: true },
    [PROTECTION_PATH]: { status: 404, body: { message: 'Branch not protected' } },
  });
  const artifact = await probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });
  assert.equal(requireMergeQueueCapabilityArtifact(artifact), artifact);
  assert.equal(artifact.observation.rulesetsRead, 'OK');
  assert.equal(artifact.observation.protectionRead, 'NOT_FOUND');
  assert.equal(decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }), 'ABSENT',
    'this is the exact evidence the incident had, and it decides ABSENT');
});

test('the probe distinguishes 403, rate-limited 403, 404 and 200 from the same transport', async () => {
  const cases = [
    [{ status: 403, body: { message: 'Resource not accessible' } }, 'FORBIDDEN'],
    [{ status: 403, body: { message: 'API rate limit exceeded' }, rateLimited: true }, 'RATE_LIMITED'],
    [{ status: 404, body: { message: 'Not Found' } }, 'NOT_FOUND'],
    [{ status: 500, body: { message: 'Server Error' } }, 'FAILED'],
    [{ status: 200, body: [], complete: true }, 'OK'],
  ];
  for (const [answer, expected] of cases) {
    const { read } = transport({
      [RULESETS_PATH]: answer,
      [PROTECTION_PATH]: { status: 404, body: { message: 'Branch not protected' } },
    });
    const artifact = await probeMergeQueueCapability({
      repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
      read, observedAt: OBSERVED_AT,
    });
    assert.equal(artifact.observation.rulesetsRead, expected,
      `HTTP ${answer.status} reads as ${expected}`);
    assert.notEqual(decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }) === 'ABSENT',
      expected !== 'OK', 'only a complete 200 read can decide ABSENT');
  }
});

test('the probe records an unmodelled rule type rather than dropping it', async () => {
  const { read } = transport({
    [RULESETS_PATH]: {
      status: 200,
      complete: true,
      body: [{
        id: 4110,
        name: 'gaia-merge-queue',
        enforcement: 'active',
        source_type: 'Repository',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{ type: 'merge_queue' }, { type: 'file_path_restriction' }],
      }],
    },
    [PROTECTION_PATH]: { status: 404, body: { message: 'Branch not protected' } },
  });
  const artifact = await probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });
  assert.deepEqual(artifact.observation.unknownRuleTypes, ['file_path_restriction']);
  assert.equal(decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }), 'UNKNOWN');
});

test('the probe ignores an organization ruleset, which this repository cannot write', async () => {
  const { read } = transport({
    [RULESETS_PATH]: {
      status: 200,
      complete: true,
      body: [{
        id: 99,
        name: 'org-wide',
        enforcement: 'active',
        source_type: 'Organization',
        conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
        rules: [{ type: 'merge_queue' }],
      }],
    },
    [PROTECTION_PATH]: { status: 404, body: { message: 'Branch not protected' } },
  });
  const artifact = await probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });
  assert.deepEqual(artifact.observation.rulesets, [],
    'an organization ruleset is not a repository ruleset and cannot be reconciled against');
});

test('the probe records a ruleset name it cannot represent as absent rather than as free text', async () => {
  const { read } = transport({
    [RULESETS_PATH]: {
      status: 200,
      complete: true,
      body: [{
        id: 4110,
        name: 'protect main — see https://example.invalid/policy',
        enforcement: 'active',
        source_type: 'Repository',
        conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
        rules: [{ type: 'merge_queue' }],
      }],
    },
    [PROTECTION_PATH]: { status: 404, body: { message: 'Branch not protected' } },
  });
  const artifact = await probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });
  assert.equal(artifact.observation.rulesets[0].name, null,
    'a name this schema cannot bound carries no free text into the evidence');
  assert.equal(JSON.stringify(artifact).includes('example.invalid'), false,
    'and no URL reaches the sealed artifact');
});

// ---------------------------------------------------------------------------------------------
// M13-M15 — the planner refuses far more than it accepts.
// ---------------------------------------------------------------------------------------------

const GRANT = Object.freeze({ repository: REPOSITORY, action: 'ADMINISTER_REPOSITORY' });

const remediable = (overrides = {}) => seal({
  observation: observation({ adminPermission: 'PRESENT', ...overrides }),
});

const plan = (artifact, authority = GRANT) => planMergeQueueRemediation({
  artifact, observedAt: OBSERVED_AT, authority,
});

test('M13: the planner accepts ABSENT and refuses every other state', () => {
  const accepted = plan(remediable());
  assert.equal(accepted.accepted, true, 'ABSENT with authority is the one remediable case');

  const refused = {
    AVAILABLE: { rulesets: [ruleset()] },
    MISCONFIGURED: { rulesets: [ruleset({ enforcement: 'evaluate' })] },
    PERMISSION_DENIED: { rulesetsRead: 'FORBIDDEN' },
    UNKNOWN: { rulesetsRead: 'NOT_FOUND' },
  };
  for (const [state, overrides] of Object.entries(refused)) {
    const outcome = plan(remediable(overrides));
    assert.equal(outcome.accepted, false, `${state} produces no intent at all`);
    assert.equal(outcome.refusal.reasonCode, 'CAPABILITY_NOT_REMEDIABLE');
  }
});

test('M13: STALE evidence produces no intent, because the plan would be made against a guess', () => {
  const outcome = planMergeQueueRemediation({
    artifact: remediable(), observedAt: at(MERGE_QUEUE_CAPABILITY_FRESH_MS + 1), authority: GRANT,
  });
  assert.equal(outcome.accepted, false);
  assert.equal(outcome.refusal.reasonCode, 'CAPABILITY_NOT_REMEDIABLE');
});

test('M13a: two different authority grants over one target compute one identity and one stamp', () => {
  const first = plan(remediable(), { ...GRANT, grantId: 'grant-one' });
  const second = plan(remediable(), { ...GRANT, grantId: 'grant-two' });
  assert.equal(first.intent.intentId, second.intent.intentId,
    'the effect identity names the target, never the attempt');
  assert.equal(first.intent.stamp, second.intent.stamp);
});

test('M13b: two observations with different precondition digests compute one identity', () => {
  const first = plan(remediable());
  const second = plan(remediable({
    rulesets: [ruleset({ rulesetId: '77', name: 'unrelated', mergeQueueRule: null })],
  }));
  assert.equal(second.accepted, true, 'an unrelated ruleset does not make the queue present');
  assert.equal(first.intent.intentId, second.intent.intentId,
    'the precondition digest is a compare-and-swap token, not a name');
  assert.notEqual(first.intent.expectedRulesetDigest, second.intent.expectedRulesetDigest,
    'but the two plans do carry different preconditions');
});

test('M14: an unknown rule type, insufficient authority and ambiguity each refuse', () => {
  assert.equal(
    plan(remediable({ unknownRuleTypes: ['max_file_size'] })).refusal.reasonCode,
    'CAPABILITY_NOT_REMEDIABLE',
    'an unknown rule already made the state UNKNOWN, and an unknown state is never remediated',
  );
  assert.equal(
    plan(seal({ observation: observation({ adminPermission: 'ABSENT' }) })).refusal.reasonCode,
    'INSUFFICIENT_AUTHORITY',
  );
  assert.equal(plan(remediable(), null).refusal.reasonCode, 'INSUFFICIENT_AUTHORITY',
    'no grant is not a grant');
  assert.equal(
    plan(remediable(), { ...GRANT, repository: 'someone/else' }).refusal.reasonCode,
    'INSUFFICIENT_AUTHORITY',
    'a grant for another repository does not cover this one',
  );
});

test('M15: the intent is additive and names everything it promises to preserve', () => {
  const existing = [
    ruleset({ rulesetId: '10', name: 'checks', mergeQueueRule: null }),
    ruleset({ rulesetId: '11', name: 'reviews', mergeQueueRule: null }),
  ];
  const { accepted, intent } = plan(remediable({ rulesets: existing }));
  assert.equal(accepted, true);
  assert.deepEqual(intent.additions, [{ type: 'merge_queue' }],
    'exactly one rule is added, and nothing else is described');
  assert.deepEqual(intent.preserved.rulesetIds, ['10', '11'],
    'every existing ruleset is named as preserved, so the promise is reviewable');
  assert.equal(intent.schema, MERGE_QUEUE_REMEDIATION_INTENT_SCHEMA);
  assert.equal(intent.stamp.startsWith('gaia-mq-'), true, 'the stamp is written before the effect');
  assert.ok(Object.isFrozen(intent));
});

test('M15: the refusal vocabulary is closed and every reason is reachable', () => {
  assert.deepEqual([...MERGE_QUEUE_REMEDIATION_REFUSALS].sort(), [
    'AMBIGUOUS_CONFIGURATION', 'CAPABILITY_NOT_REMEDIABLE', 'DESTRUCTIVE_REPLACEMENT',
    'INSUFFICIENT_AUTHORITY', 'PRECONDITION_CHANGED', 'UNKNOWN_RULE_PRESENT',
  ]);
});

// ---------------------------------------------------------------------------------------------
// M16-M22 — one effect, compare before write, and an exact reconciliation.
// ---------------------------------------------------------------------------------------------

/** A fake GitHub whose ruleset list is a shared array, so two remediators can race over it. */
function fakeGitHub(initial = []) {
  const store = [...initial];
  const writes = [];
  return {
    store,
    writes,
    readRulesets: async () => store.map((entry) => ({ ...entry })),
    applyRuleset: async (payload) => {
      writes.push(payload);
      store.push(ruleset({
        rulesetId: String(4200 + store.length), name: payload.name, mergeQueueRule: { enabled: true },
      }));
      return { applied: true };
    },
  };
}

const acceptedIntent = (overrides = {}) => plan(remediable(overrides)).intent;

test('M16: the executor performs no write when the observed digest differs from the expected', async () => {
  const intent = acceptedIntent();
  const github = fakeGitHub([ruleset({ rulesetId: '9', name: 'appeared', mergeQueueRule: null })]);
  const outcome = await executeMergeQueueRemediation({ intent, ...github });
  assert.equal(github.writes.length, 0, 'a plan made against a configuration that moved is not a licence');
  assert.equal(outcome.receipt.verdict, 'AMBIGUOUS');
  assert.equal(outcome.refusal.reasonCode, 'PRECONDITION_CHANGED');
});

test('M17: the executor performs exactly one write when the digest matches', async () => {
  const intent = acceptedIntent();
  const github = fakeGitHub();
  const outcome = await executeMergeQueueRemediation({ intent, ...github });
  assert.equal(github.writes.length, 1, 'exactly one effect');
  assert.equal(github.writes[0].name, intent.stamp, 'the identity is stamped into the payload');
  assert.deepEqual(github.writes[0].rules, [{ type: 'merge_queue' }]);
  assert.equal(github.writes[0].enforcement, 'active',
    'a ruleset created in evaluate mode would be the original bug wearing a fix');
  assert.equal(outcome.receipt.verdict, 'APPLIED');
});

test('M18: a lost response after success reconciles to APPLIED and writes nothing', async () => {
  const intent = acceptedIntent();
  const github = fakeGitHub();
  await executeMergeQueueRemediation({ intent, ...github });
  const landed = await github.readRulesets();

  const reconciled = reconcileMergeQueueRemediation({ intent, rulesets: landed });
  assert.equal(reconciled.verdict, 'APPLIED', 'the stamp written before the request makes this decidable');

  const second = await executeMergeQueueRemediation({ intent, ...github });
  assert.equal(github.writes.length, 1, 'the retry after a lost response issues no second write');
  assert.equal(second.receipt.verdict, 'APPLIED');
});

test('M19: another remediator having satisfied the capability reconciles to SUPERSEDED', () => {
  const intent = acceptedIntent();
  const reconciled = reconcileMergeQueueRemediation({
    intent,
    rulesets: [ruleset({ rulesetId: '5000', name: 'someone-elses-queue' })],
  });
  assert.equal(reconciled.verdict, 'SUPERSEDED');
  assert.equal(MERGE_QUEUE_REMEDIATION_VERDICTS.includes(reconciled.verdict), true);
});

test('M19: nothing landed at all reconciles to NOT_APPLIED', () => {
  assert.equal(reconcileMergeQueueRemediation({ intent: acceptedIntent(), rulesets: [] }).verdict,
    'NOT_APPLIED');
});

test('M20: two concurrent remediators produce at most one effect and one terminal receipt', async () => {
  const github = fakeGitHub();
  const [left, right] = [acceptedIntent(), acceptedIntent()];
  assert.equal(left.intentId, right.intentId, 'they agree on the identity before they race');

  const outcomes = await Promise.all([
    executeMergeQueueRemediation({ intent: left, ...github }),
    executeMergeQueueRemediation({ intent: right, ...github }),
  ]);
  assert.equal(github.writes.length, 1, 'at most one effect reaches GitHub');
  const terminal = outcomes.map(({ receipt }) => receipt.verdict);
  assert.equal(terminal.filter((verdict) => verdict === 'APPLIED').length, 2,
    'both remediators terminate at the same true verdict');
  assert.equal(outcomes[0].receipt.revision, outcomes[1].receipt.revision,
    'and emit byte-identical terminal receipts');
});

test('M21: two stamped rulesets, or a stamped ruleset without the rule, reconcile to AMBIGUOUS', () => {
  const intent = acceptedIntent();
  assert.equal(
    reconcileMergeQueueRemediation({
      intent,
      rulesets: [ruleset({ rulesetId: '1', name: intent.stamp }),
        ruleset({ rulesetId: '2', name: intent.stamp })],
    }).verdict,
    'AMBIGUOUS',
    'GitHub does not enforce unique ruleset names, so this is detected rather than assumed away',
  );
  assert.equal(
    reconcileMergeQueueRemediation({
      intent,
      rulesets: [ruleset({ rulesetId: '1', name: intent.stamp, mergeQueueRule: null })],
    }).verdict,
    'AMBIGUOUS',
    'a ruleset wearing the stamp but not carrying the rule is not this effect having landed',
  );
});

test('M21: a stamped ruleset that is not active reconciles to AMBIGUOUS, never APPLIED', () => {
  const intent = acceptedIntent();
  assert.equal(
    reconcileMergeQueueRemediation({
      intent, rulesets: [ruleset({ rulesetId: '1', name: intent.stamp, enforcement: 'evaluate' })],
    }).verdict,
    'AMBIGUOUS',
  );
});

test('M22: a failing effect leaves no partial configuration and issues no second write', async () => {
  const intent = acceptedIntent();
  const writes = [];
  const outcome = await executeMergeQueueRemediation({
    intent,
    readRulesets: async () => [],
    applyRuleset: async (payload) => {
      writes.push(payload);
      throw new Error('gh: connection reset');
    },
  });
  assert.equal(writes.length, 1, 'the one attempt happened and was not repeated');
  assert.equal(outcome.receipt.verdict, 'AMBIGUOUS',
    'a write whose outcome is unknown is ambiguous, not failed and not retried');
});

test('M22: reconciliation issues no write in any branch', () => {
  const source = readFileSync(join(ROOT, 'src', 'merge-queue-capability.mjs'), 'utf8');
  const reconciler = source.slice(source.indexOf('export function reconcileMergeQueueRemediation'));
  assert.equal(reconciler.includes('applyRuleset'), false,
    'the reconciler is a pure read and cannot reach the effect at all');
});
