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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  DESIRED_MERGE_QUEUE_RULE,
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
  requireMergeQueueRemediationIntent,
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
    // A transport that rejects rather than answering, which is a different fact from any status.
    if (answer.throws) throw new Error('transport failure');
    return answer;
  };
  return { read, calls };
}

const RULESETS_PATH = `repos/${REPOSITORY}/rulesets`;
const PROTECTION_PATH = `repos/${REPOSITORY}/branches/${DEFAULT_BRANCH}/protection`;
const detailPath = (rulesetId) => `repos/${REPOSITORY}/rulesets/${rulesetId}`;
const UNPROTECTED = { status: 404, body: { message: 'Branch not protected' } };

/**
 * One repository ruleset exactly as `GET /repos/{owner}/{repo}/rulesets/{id}` returns it.
 *
 * The rules and the ref conditions live here and only here. Every fixture that put them in the
 * listing was describing an endpoint GitHub does not serve.
 */
const rulesetDetail = ({
  id = 4110,
  name = 'gaia-merge-queue',
  enforcement = 'active',
  sourceType = 'Repository',
  include = ['~DEFAULT_BRANCH'],
  exclude = [],
  rules = [{ type: 'merge_queue' }],
} = {}) => ({
  id,
  name,
  target: 'branch',
  source_type: sourceType,
  source: REPOSITORY,
  enforcement,
  node_id: `RRS_lACkUmVwb${id}`,
  conditions: { ref_name: { include, exclude } },
  rules,
});

/**
 * The same ruleset exactly as `GET /repos/{owner}/{repo}/rulesets` returns it: identity, target,
 * source and enforcement, with no `rules` array and no `conditions` object anywhere in it.
 */
const listedRuleset = (detail) => {
  const { conditions, rules, ...listed } = detail;
  return listed;
};

/**
 * A realistic two-endpoint transport: one listing that carries no rules, and one detail read per
 * listed ruleset. `detailAnswers` replaces a detail answer by ruleset id, so a test can say
 * exactly how one detail read fell short without touching the listing.
 */
function rulesetsTransport(details, {
  detailAnswers = {}, complete = true, protection = UNPROTECTED, listing = null,
} = {}) {
  const answers = {
    [RULESETS_PATH]: { status: 200, complete, body: listing ?? details.map(listedRuleset) },
    [PROTECTION_PATH]: protection,
  };
  for (const detail of details) answers[detailPath(detail.id)] = { status: 200, body: detail };
  for (const [id, answer] of Object.entries(detailAnswers)) answers[detailPath(id)] = answer;
  return transport(answers);
}

/** The probe, always over the same repository, so no test spells the identity twice. */
const probe = (read) => probeMergeQueueCapability({
  repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
  read, observedAt: OBSERVED_AT,
});

const decideProbed = (artifact) => decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT });

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
  const { read } = rulesetsTransport([rulesetDetail({
    rules: [{ type: 'merge_queue' }, { type: 'file_path_restriction' }],
  })]);
  const artifact = await probe(read);
  assert.deepEqual(artifact.observation.unknownRuleTypes, ['file_path_restriction']);
  assert.equal(decideProbed(artifact), 'UNKNOWN');
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
  const { read } = rulesetsTransport([rulesetDetail({
    name: 'protect main — see https://example.invalid/policy',
  })]);
  const artifact = await probe(read);
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
    'MISCONFIGURED by two competing carriers': {
      rulesets: [ruleset(), ruleset({ rulesetId: '4111', name: 'other' })],
    },
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
    'CAPABILITY_NOT_REMEDIABLE', 'DESTRUCTIVE_REPLACEMENT', 'INSUFFICIENT_AUTHORITY',
    'PRECONDITION_CHANGED', 'UNKNOWN_RULE_PRESENT',
  ], 'there is no separate ambiguity refusal, because a competing carrier is already MISCONFIGURED');
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

test('M15a: a write that loses a preserved ruleset refuses as DESTRUCTIVE_REPLACEMENT', async () => {
  const existing = [ruleset({ rulesetId: '10', name: 'checks', mergeQueueRule: null })];
  const intent = acceptedIntent({ rulesets: existing });
  assert.deepEqual(intent.preserved.rulesetIds, ['10']);

  let read = 0;
  const writes = [];
  const outcome = await executeMergeQueueRemediation({
    intent,
    // The precondition read sees the existing ruleset; the read after the write does not, which
    // is a provider that replaced rather than added.
    readRulesets: async () => (read++ === 0 ? existing.map((entry) => ({ ...entry })) : [
      ruleset({ rulesetId: '4200', name: intent.stamp }),
    ]),
    applyRuleset: async (payload) => {
      writes.push(payload);
      return { applied: true };
    },
  });
  assert.equal(writes.length, 1, 'the one write happened and was not repeated');
  assert.equal(outcome.receipt.verdict, 'AMBIGUOUS',
    'a configuration that lost a rule is not a successful remediation, even though the rule landed');
  assert.equal(outcome.refusal.reasonCode, 'DESTRUCTIVE_REPLACEMENT');
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
  const start = source.indexOf('export function reconcileMergeQueueRemediation');
  const reconciler = source.slice(start, source.indexOf('\nexport ', start + 1));
  assert.ok(reconciler.includes('function reconcileMergeQueueRemediation'), 'the slice found it');
  assert.equal(reconciler.includes('applyRuleset'), false,
    'the reconciler is a pure read and cannot reach the effect at all');
});

// ---------------------------------------------------------------------------------------------
// M23-M25 and MRM1-MRM3 — the R1 repairs. Each one is a place where this module answered a
// question it had not asked: whether the rule it created actually landed, whether a governing
// ruleset it cannot model is the same thing as no ruleset, and whether the one object that can
// reach a write is the one the planner sealed.
// ---------------------------------------------------------------------------------------------

const mutantScratch = mkdtempSync(join(tmpdir(), 'gaia-mqm-'));
test.after(() => rmSync(mutantScratch, {
  recursive: true, force: true, maxRetries: 12, retryDelay: 25,
}));

/** Load a one-expression mutant of the shipped module, so a gate can be shown to be a mechanism. */
async function importMutant(name, mutate) {
  const source = readFileSync(join(ROOT, 'src', 'merge-queue-capability.mjs'), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const rewritten = mutated.replaceAll(
    "from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`,
  );
  const path = join(mutantScratch, `${name}.mjs`);
  writeFileSync(path, rewritten, 'utf8');
  return import(pathToFileURL(path).href);
}

/** A provider that accepts the write and lands exactly what the case under test says it landed. */
function providerLanding(landed) {
  const writes = [];
  let reads = 0;
  return {
    writes,
    readRulesets: async () => (reads++ === 0 ? [] : landed.map((entry) => ({ ...entry }))),
    applyRuleset: async (payload) => {
      writes.push(payload);
      return { applied: true };
    },
  };
}

/** One organization ruleset that genuinely provides a merge queue for the default branch. */
const governingRuleset = (sourceType) => ({
  id: 99,
  name: 'org-wide',
  enforcement: 'active',
  ...(sourceType === null ? {} : { source_type: sourceType }),
  conditions: { ref_name: { include: ['~ALL'], exclude: [] } },
  rules: [{ type: 'merge_queue' }],
});

const governingTransport = (sourceType) => transport({
  [RULESETS_PATH]: { status: 200, complete: true, body: [governingRuleset(sourceType)] },
  [PROTECTION_PATH]: { status: 404, body: { message: 'Branch not protected' } },
});

test('M23: a write that landed no merge queue rule seals AMBIGUOUS, never APPLIED', async () => {
  const intent = acceptedIntent();
  const landed = [ruleset({ rulesetId: '4200', name: intent.stamp, mergeQueueRule: null })];
  const provider = providerLanding(landed);
  const outcome = await executeMergeQueueRemediation({ intent, ...provider });

  assert.equal(provider.writes.length, 1, 'the one write happened and was not repeated');
  assert.equal(outcome.receipt.verdict, 'AMBIGUOUS',
    'a provider response that did not throw is not proof that the capability now exists');
  assert.equal(
    reconcileMergeQueueRemediation({ intent, rulesets: landed }).verdict,
    outcome.receipt.verdict,
    'the executor and the reconciler cannot give one read two opposite terminal answers',
  );
});

test('M23: a write that landed nothing at all is AMBIGUOUS, not APPLIED and not NOT_APPLIED', async () => {
  const intent = acceptedIntent();
  const provider = providerLanding([]);
  const outcome = await executeMergeQueueRemediation({ intent, ...provider });
  assert.equal(provider.writes.length, 1);
  assert.equal(outcome.receipt.verdict, 'AMBIGUOUS',
    'a write left this process and the configuration cannot account for it, which is not "nothing happened"');
});

test('M23: a stamped ruleset that came back evaluate-only after the write is AMBIGUOUS', async () => {
  const intent = acceptedIntent();
  const provider = providerLanding([
    ruleset({ rulesetId: '4200', name: intent.stamp, enforcement: 'evaluate' }),
  ]);
  const outcome = await executeMergeQueueRemediation({ intent, ...provider });
  assert.equal(outcome.receipt.verdict, 'AMBIGUOUS',
    'a queue that gates nothing is the original defect wearing a receipt that says it is fixed');
});

test('MRM1: reverting the post-write reconciliation restores the false APPLIED receipt', async () => {
  const mutant = await importMutant('mq-assume-applied', (source) => source.replace(
    'settledVerdict(landed.verdict)',
    "'APPLIED'",
  ));
  const intent = acceptedIntent();
  const provider = providerLanding([
    ruleset({ rulesetId: '4200', name: intent.stamp, mergeQueueRule: null }),
  ]);
  const outcome = await mutant.executeMergeQueueRemediation({ intent, ...provider });
  assert.equal(outcome.receipt.verdict, 'APPLIED',
    'the mutant seals completion for a merge queue that does not exist, which is the defect');
});

test('M24: a governing ruleset this module cannot model decides UNKNOWN, never a false ABSENT', async () => {
  for (const sourceType of ['Organization', 'Enterprise', null]) {
    const { read } = governingTransport(sourceType);
    const artifact = await probeMergeQueueCapability({
      repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
      read, observedAt: OBSERVED_AT,
    });
    assert.deepEqual(artifact.observation.rulesets, [],
      `a ${sourceType ?? 'sourceless'} ruleset is still not a repository ruleset to reconcile against`);
    assert.deepEqual(artifact.observation.unknownRuleTypes, ['unmodelled_governing_ruleset'],
      'but the discard is recorded, because "I cannot administer it" is not "it does not exist"');
    assert.equal(decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }), 'UNKNOWN',
      'a repository whose merge queue genuinely works must never be reported as having none');
  }
});

test('M24: the doomed remediation is refused for a capability governed elsewhere', async () => {
  const { read } = governingTransport('Organization');
  const artifact = await probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });
  const outcome = plan(artifact);
  assert.equal(outcome.accepted, false,
    'a second carrier beside a working org queue is the MISCONFIGURED state this design refuses');
  assert.equal(outcome.refusal.reasonCode, 'CAPABILITY_NOT_REMEDIABLE');
});

test('M24: the contract decides the governing-ruleset case rather than leaving it to a test', () => {
  const document = readFileSync(join(ROOT, 'docs', 'merge-queue-capability.md'), 'utf8');
  assert.match(document, /unmodelled_governing_ruleset/u,
    'a behaviour asserted by a test and decided by no contract is a behaviour nobody agreed to');
  assert.match(document, /organization/iu);
});

test('MRM2: reverting the recorded discard restores the false ABSENT', async () => {
  const mutant = await importMutant('mq-silent-discard', (source) => source.replace(
    "      unknown.add('unmodelled_governing_ruleset');\n", '',
  ));
  const { read } = governingTransport('Organization');
  const artifact = await mutant.probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });
  assert.deepEqual(artifact.observation.unknownRuleTypes, []);
  assert.equal(mutant.decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }), 'ABSENT',
    'the mutant asserts absence about a repository whose merge queue works, which is the defect');
});

test('M25: the sealed intent is verified, and its own seal is derived rather than believed', () => {
  const intent = acceptedIntent();
  assert.equal(requireMergeQueueRemediationIntent(intent), intent,
    'an honest intent is returned as it is, never repaired');

  const { expectedRulesetDigest, ...missingField } = intent;
  const refused = {
    'a forged addition': { ...intent, additions: [{ type: 'deletion' }] },
    'an extra rule beside the desired one': {
      ...intent, additions: [{ ...DESIRED_MERGE_QUEUE_RULE }, { type: 'deletion' }],
    },
    'an unsorted preservation promise': { ...intent, preserved: { rulesetIds: ['11', '10'] } },
    'a preservation promise naming prose': {
      ...intent, preserved: { rulesetIds: ['the checks ruleset'] },
    },
    'a preservation promise carrying a second key': {
      ...intent, preserved: { rulesetIds: [], note: 'best effort' },
    },
    'a moved target': { ...intent, defaultBranch: 'release' },
    'a stamp that names another identity': { ...intent, stamp: 'gaia-mq-0000000000000000' },
    'an unknown field': { ...intent, urgency: 'high' },
    'a missing field': missingField,
  };
  for (const [name, forged] of Object.entries(refused)) {
    assert.throws(() => requireMergeQueueRemediationIntent(forged),
      (error) => error instanceof MergeQueueCapabilityError
        && error.code === 'InvalidMergeQueueRemediationIntent',
      `${name} must be refused rather than written`);
    // Resealing does not help: the identity, the stamp and the desired rule are all re-derived,
    // so sixty-four hex characters of the wrong intent is still the wrong intent.
    const { revision, ...body } = forged;
    assert.throws(
      () => requireMergeQueueRemediationIntent({ ...body, revision: sha256(canonicalJson(body)) }),
      (error) => error instanceof MergeQueueCapabilityError,
      `${name} must still be refused after a correct reseal`,
    );
  }
});

test('M25: a forged intent reaches no write at all', async () => {
  const intent = acceptedIntent({
    rulesets: [ruleset({ rulesetId: '10', name: 'checks', mergeQueueRule: null })],
  });
  const writes = [];
  await assert.rejects(
    () => executeMergeQueueRemediation({
      intent: { ...intent, additions: [{ type: 'deletion' }] },
      readRulesets: async () => [],
      applyRuleset: async (payload) => {
        writes.push(payload);
        return { applied: true };
      },
    }),
    (error) => error instanceof MergeQueueCapabilityError
      && error.code === 'InvalidMergeQueueRemediationIntent',
  );
  assert.equal(writes.length, 0, 'the one object that can reach a write is verified at its mouth');
});

test('M25: the write payload carries the desired rule constant, not whatever the intent held', async () => {
  const intent = acceptedIntent();
  const provider = providerLanding([ruleset({ rulesetId: '4200', name: intent.stamp })]);
  await executeMergeQueueRemediation({ intent, ...provider });
  assert.deepEqual(provider.writes[0].rules, [{ ...DESIRED_MERGE_QUEUE_RULE }],
    '"the merge queue Gaia asks for" is a constant, not an argument');
});

test('MRM3: reverting the intent boundary lets a forged rule reach the provider', async () => {
  const mutant = await importMutant('mq-unverified-intent', (source) => source
    .replace('const verified = requireMergeQueueRemediationIntent(intent);', 'const verified = intent;')
    .replace(
      'rules: [{ ...DESIRED_MERGE_QUEUE_RULE }],',
      'rules: intent.additions.map((rule) => ({ ...rule })),',
    ));
  const intent = acceptedIntent();
  const writes = [];
  await mutant.executeMergeQueueRemediation({
    intent: { ...intent, additions: [{ type: 'deletion' }] },
    readRulesets: async () => [],
    applyRuleset: async (payload) => {
      writes.push(payload);
      return { applied: true };
    },
  });
  assert.deepEqual(writes[0].rules, [{ type: 'deletion' }],
    'the mutant writes whatever a mutated intent happened to carry, which is the defect');
});

// ---------------------------------------------------------------------------------------------
// M26 — the listing carries no rules, so the listing cannot decide the capability.
//
// `GET /repos/{owner}/{repo}/rulesets` returns each ruleset's identity, target, source and
// enforcement. It returns no `rules` array and no `conditions` object. A probe that parses that
// response for a `merge_queue` rule finds none in *every* repository — including one whose merge
// queue is configured, active and governing the default branch — and rule 5 then reads a working
// queue as `ABSENT`. That is the exact false absence this module exists to refuse, arriving
// through the shape of the response rather than through its status.
// ---------------------------------------------------------------------------------------------

test('M26: a configured merge queue is AVAILABLE, read from the detail endpoint that carries it', async () => {
  const detail = rulesetDetail();
  const { read, calls } = rulesetsTransport([detail]);
  const artifact = await probe(read);

  assert.equal(
    JSON.stringify(listedRuleset(detail)).includes('merge_queue'), false,
    'the listing this fixture serves carries no rules at all, exactly as GitHub’s does',
  );
  assert.deepEqual(calls, [RULESETS_PATH, PROTECTION_PATH, detailPath(4110)],
    'one detail read per listed repository ruleset, at a path derived from the listed id alone');
  assert.deepEqual(artifact.observation.rulesets, [{
    rulesetId: '4110',
    name: 'gaia-merge-queue',
    enforcement: 'active',
    targetsDefaultBranch: true,
    mergeQueueRule: { enabled: true },
  }]);
  assert.deepEqual(artifact.observation.unknownRuleTypes, []);
  assert.equal(decideProbed(artifact), 'AVAILABLE',
    'a repository whose merge queue is configured must never be reported as having none');
});

test('M26: NEGATIVE CONTROL — a detail that genuinely carries no merge queue rule is still ABSENT', async () => {
  const { read } = rulesetsTransport([rulesetDetail({ rules: [] })]);
  const artifact = await probe(read);

  assert.equal(artifact.observation.rulesetsRead, 'OK');
  assert.deepEqual(artifact.observation.unknownRuleTypes, []);
  assert.equal(decideProbed(artifact), 'ABSENT',
    'reading the detail must establish absence honestly, not replace every answer with UNKNOWN');

  const empty = await probe(rulesetsTransport([]).read);
  assert.equal(decideProbed(empty), 'ABSENT',
    'and a repository with no rulesets at all still needs no detail read to decide ABSENT');
});

test('M26: no detail read that fell short can decide ABSENT', async () => {
  const cases = [
    ['a transport that rejected', { throws: true }, 'FAILED', 'UNKNOWN'],
    ['a permission 403', { status: 403, body: { message: 'Resource not accessible' } },
      'FORBIDDEN', 'PERMISSION_DENIED'],
    ['a rate-limited 403',
      { status: 403, rateLimited: true, body: { message: 'API rate limit exceeded' } },
      'RATE_LIMITED', 'UNKNOWN'],
    ['a 404', { status: 404, body: { message: 'Not Found' } }, 'NOT_FOUND', 'UNKNOWN'],
    ['a 500', { status: 500, body: { message: 'Server Error' } }, 'FAILED', 'UNKNOWN'],
  ];
  for (const [why, answer, expectedRead, expectedState] of cases) {
    const { read } = rulesetsTransport([rulesetDetail()], { detailAnswers: { 4110: answer } });
    const artifact = await probe(read);

    assert.equal(artifact.observation.rulesetsRead, expectedRead, why);
    assert.deepEqual(artifact.observation.rulesets, [],
      `${why}: a read that did not succeed carries no rulesets`);
    assert.equal(artifact.observation.rulesetDigest, null, why);
    assert.equal(artifact.observation.rulesetsComplete, false,
      `${why}: an exhausted listing whose details are unread is not a complete observation`);
    assert.equal(decideProbed(artifact), expectedState,
      `${why} is an evidence gap, and an evidence gap is never an absence`);
  }
});

test('M26: a partial detail read — one ruleset answered, one not — decides UNKNOWN', async () => {
  const { read } = rulesetsTransport(
    [rulesetDetail({ id: 11, name: 'checks', rules: [] }), rulesetDetail({ id: 4110 })],
    { detailAnswers: { 4110: { status: 500, body: { message: 'Server Error' } } } },
  );
  const artifact = await probe(read);

  assert.equal(artifact.observation.rulesetsRead, 'FAILED');
  assert.deepEqual(artifact.observation.rulesets, [],
    'the ruleset that did answer is not evidence about the one that did not');
  assert.equal(decideProbed(artifact), 'UNKNOWN',
    'a partially read configuration cannot say the merge queue is missing from all of it');
});

test('M26: a malformed, ambiguous or incomplete detail body decides UNKNOWN', async () => {
  const { rules, ...ruleless } = rulesetDetail();
  const { conditions, ...conditionless } = rulesetDetail();
  const malformed = {
    'a body that is not an object at all': [],
    'a body naming another ruleset': rulesetDetail({ id: 9999 }),
    'a body carrying no rules array': ruleless,
    'a body whose rules are not an array': { ...rulesetDetail(), rules: { type: 'merge_queue' } },
    'a body carrying no ref condition': conditionless,
    'a body whose ref condition is not a pair of arrays':
      { ...rulesetDetail(), conditions: { ref_name: { include: '~ALL' } } },
    'a body whose source moved off this repository':
      rulesetDetail({ sourceType: 'Organization' }),
  };
  for (const [why, body] of Object.entries(malformed)) {
    const { read } = rulesetsTransport([rulesetDetail()], {
      detailAnswers: { 4110: { status: 200, body } },
    });
    const artifact = await probe(read);

    assert.equal(artifact.observation.rulesetsRead, 'OK',
      `${why}: the transport succeeded, so the read outcome is honest about that`);
    assert.deepEqual(artifact.observation.rulesets, [],
      `${why}: a detail this module cannot model is never sealed as a modelled ruleset`);
    assert.deepEqual(artifact.observation.unknownRuleTypes, ['unreadable_ruleset_detail'],
      `${why}: the discard is recorded rather than dropped`);
    assert.equal(decideProbed(artifact), 'UNKNOWN',
      `${why} is a shape this version cannot read, which is an evidence gap and never an absence`);
  }
});

test('M26: a listed ruleset with no usable identity is never addressed and never decides ABSENT', async () => {
  for (const id of [null, 0, -4110, 1.5, 'main/../../secrets', '4110?x=1', {}]) {
    const listing = [{ ...listedRuleset(rulesetDetail()), id }];
    const { read, calls } = rulesetsTransport([], { listing });
    const artifact = await probe(read);

    assert.deepEqual(calls, [RULESETS_PATH, PROTECTION_PATH],
      `an id of ${JSON.stringify(id)} is not a path this probe will construct`);
    assert.deepEqual(artifact.observation.rulesets, []);
    assert.deepEqual(artifact.observation.unknownRuleTypes, ['unreadable_ruleset_detail']);
    assert.equal(decideProbed(artifact), 'UNKNOWN',
      'a ruleset that exists and cannot be read is not a ruleset that does not exist');
  }
});

test('M26: a ruleset governed elsewhere costs no detail read, and still decides UNKNOWN', async () => {
  const { read, calls } = rulesetsTransport([], {
    listing: [listedRuleset(rulesetDetail({ id: 99, name: 'org-wide', sourceType: 'Organization' }))],
  });
  const artifact = await probe(read);

  assert.deepEqual(calls, [RULESETS_PATH, PROTECTION_PATH],
    'a ruleset this repository cannot administer is discarded before a request is spent on it');
  assert.deepEqual(artifact.observation.unknownRuleTypes, ['unmodelled_governing_ruleset']);
  assert.equal(decideProbed(artifact), 'UNKNOWN');
});

test('M26: the detail reads are bounded, ordered and deterministic', async () => {
  const details = [
    rulesetDetail({ id: 4110, name: 'gaia-merge-queue' }),
    rulesetDetail({ id: 11, name: 'checks', rules: [] }),
  ];
  const first = rulesetsTransport(details);
  const second = rulesetsTransport(details);
  const left = await probe(first.read);
  const right = await probe(second.read);

  assert.deepEqual(first.calls, [RULESETS_PATH, PROTECTION_PATH, detailPath(4110), detailPath(11)],
    'listing order, one read each, and no read for anything that was not listed');
  assert.deepEqual(first.calls, second.calls, 'the read path is the same on every replay');
  assert.equal(left.revision, right.revision, 'and so is the sealed revision');
  assert.equal(
    left.observation.rulesetDigest, right.observation.rulesetDigest,
    'and so is the compare-and-swap digest the remediation plan is built against',
  );

  // 64 is the artifact bound. A listing beyond it cannot be sealed, so spending one network read
  // per unsealable entry is not boundedness.
  const oversized = Array.from({ length: 65 }, (unused, index) => rulesetDetail({
    id: index + 1, name: `ruleset-${index + 1}`,
  }));
  const bounded = rulesetsTransport(oversized);
  await assert.rejects(() => probe(bounded.read), MergeQueueCapabilityError);
  assert.deepEqual(bounded.calls, [RULESETS_PATH, PROTECTION_PATH],
    'the bound is applied before the first detail read, not after sixty-five of them');
});

test('M26: the contract decides the detail read rather than leaving it to a test', () => {
  const document = readFileSync(join(ROOT, 'docs', 'merge-queue-capability.md'), 'utf8');
  assert.match(document, /rulesets\/\{ruleset_id\}/u,
    'a behaviour asserted by a test and decided by no contract is a behaviour nobody agreed to');
  assert.match(document, /unreadable_ruleset_detail/u);
});

test('MRM4: reverting the detail read restores the false ABSENT', async () => {
  const mutant = await importMutant('mq-listing-only', (source) => source.replace(
    '    ? await readRulesetDetails(read, repository, rulesets.answer.body)',
    "    ? { outcome: 'OK', entries: rulesets.answer.body, unreadable: false }",
  ));
  const { read } = rulesetsTransport([rulesetDetail()]);
  const artifact = await mutant.probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });

  assert.equal(
    mutant.decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }), 'ABSENT',
    'the mutant asserts absence about a repository whose merge queue is active, which is the defect',
  );
});

test('MRM5: reverting the fail-closed detail outcome restores the false ABSENT', async () => {
  const mutant = await importMutant('mq-detail-optimism', (source) => source.replace(
    '      outcome = worseReadOutcome(outcome, detail.outcome);\n      continue;\n',
    '      continue;\n',
  ));
  const { read } = rulesetsTransport([rulesetDetail()], {
    detailAnswers: { 4110: { status: 403, body: { message: 'Resource not accessible' } } },
  });
  const artifact = await mutant.probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });

  assert.equal(
    mutant.decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }), 'ABSENT',
    'the mutant turns "I was not allowed to read it" into "it is not there", which is the defect',
  );
});

test('MRM6: reverting the recorded unreadable detail restores the false ABSENT', async () => {
  const mutant = await importMutant('mq-detail-silent-discard', (source) => source.replace(
    "  if (unreadableDetail) unknown.add('unreadable_ruleset_detail');\n", '',
  ));
  const { rules, ...ruleless } = rulesetDetail();
  const { read } = rulesetsTransport([rulesetDetail()], {
    detailAnswers: { 4110: { status: 200, body: ruleless } },
  });
  const artifact = await mutant.probeMergeQueueCapability({
    repository: REPOSITORY, repositoryId: REPOSITORY_ID, defaultBranch: DEFAULT_BRANCH,
    read, observedAt: OBSERVED_AT,
  });

  assert.equal(
    mutant.decideMergeQueueCapability({ artifact, observedAt: OBSERVED_AT }), 'ABSENT',
    'the mutant drops a detail it could not read and calls the silence an absence',
  );
});
