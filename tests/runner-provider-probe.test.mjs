/**
 * runner-provider-probe.test.mjs — issue #91 slice R1: the closed runner/provider contracts and
 * the one read-only synthetic-fixture capability probe, and nothing that registers, executes,
 * drains, spends, or writes.
 *
 * Gates P1-P28 of `docs/self-hosted-runner-provider-probe.md`.
 *
 * The operator failure behind this file is that a self-hosted runner is the most authority-dense
 * thing Gaia can own: it sits on a host holding provider sessions, and every convenient shortcut
 * — a probe that trusts the label it was handed, a probe that runs for a generation that already
 * lost, a probe that keeps working while the host drains, a probe that copies an adapter's claim
 * of "I did nothing" instead of refusing its claim of "I did something" — turns a capability
 * question into an unaudited effect. Most of what is asserted here is therefore what the probe
 * refuses to do, and in particular *when* it refuses: the provider adapter is the last thing
 * consulted, and a refused probe must prove the adapter was never called at all.
 *
 * Three design commitments are gated here:
 *
 *  1. Authority, then admission, then reconciliation, then the adapter. Each earlier gate is
 *     shown to decide while a later one would still have said yes (P3-P13).
 *  2. The admission table narrows and never grants. `CODE_WRITE` and `MERGE_APPROVAL` are
 *     representable so they can be refused by the same mechanism for every provider, and
 *     NotebookLM's writer refusal is that mechanism rather than a provider-specific branch (P8-P10).
 *  3. Provider session material is structurally unrepresentable in an observation, not scanned
 *     out of it: every field is a closed token, a bounded identifier, or a bounded integer, and
 *     the shipped fixture adapter writes the authority literals itself so a hostile fixture has
 *     no field to put them in (P19, P20, P27).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PROVIDER_AVAILABILITIES,
  PROVIDER_CAPABILITY_ADMISSION,
  PROVIDER_CAPABILITY_KINDS,
  PROVIDER_OBSERVATION_SOURCES,
  PROVIDER_PROBE_ADAPTER_SCHEMA,
  PROVIDER_PROBE_BLOCKERS,
  PROVIDER_PROBE_FIXTURE_SCHEMA,
  PROVIDER_PROBE_INPUT_SCHEMA,
  PROVIDER_PROBE_MANDATE_SCHEMA,
  PROVIDER_PROBE_OBSERVATION_SCHEMA,
  PROVIDER_PROBE_RECEIPT_FIELDS,
  PROVIDER_PROBE_RECEIPT_SCHEMA,
  PROVIDER_PROBE_REQUEST_SCHEMA,
  PROVIDER_QUOTA_UNITS,
  PROVIDER_REPORTED_BLOCKERS,
  RUNNER_ARCHITECTURES,
  RUNNER_IDENTITY_SCHEMA,
  RUNNER_LEASE_SCHEMA,
  RUNNER_OPERATING_SYSTEMS,
  RUNNER_PROVIDERS,
  RunnerProbeError,
  createSyntheticFixtureProbeAdapter,
  probeProvider,
  providerProbeIdempotencyKey,
  providerProbeMandateDigest,
  requireProviderProbeMandate,
  requireRunnerIdentity,
  requireRunnerLease,
  runnerGenerationKey,
  runnerLabels,
  runnerWorkKey,
} from '../src/runner-provider-probe.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const AT = '2026-09-01T18:04:00.000Z';
const LATER = '2026-09-01T19:04:00.000Z';
const RUNNER_ID = 'gaia-win-runner-01';
const CORPUS = 'synthetic-probe-corpus-1';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-probe-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

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

/** Load a one-expression mutant of the shipped module, so a gate can be shown to be a mechanism. */
async function importMutant(name, mutate) {
  const source = readFileSync(join(ROOT, 'src', 'runner-provider-probe.mjs'), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const rewritten = mutated.replaceAll(
    "from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`,
  );
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, rewritten, 'utf8');
  return import(pathToFileURL(path).href);
}

const identity = (overrides = {}) => ({
  schema: RUNNER_IDENTITY_SCHEMA,
  runnerId: RUNNER_ID,
  os: 'WINDOWS',
  arch: 'X64',
  generation: 7,
  acceptingWork: true,
  providers: ['claude-code', 'notebooklm'],
  capabilities: ['READ_ONLY_REVIEW', 'RESEARCH_CITATION'],
  ...overrides,
});

const WORK_KEY = () => runnerWorkKey(identity());

const mandate = (overrides = {}) => ({
  schema: PROVIDER_PROBE_MANDATE_SCHEMA,
  mandateId: 'probe-0001',
  runnerWorkKey: WORK_KEY(),
  runnerGeneration: 7,
  provider: 'claude-code',
  capability: 'READ_ONLY_REVIEW',
  deadline: LATER,
  budget: { tokens: 4000, contextTokens: 32000, wallClockMs: 60000 },
  declaredMcpServers: [],
  corpus: { corpusId: CORPUS, promptCount: 3, containsRepositorySource: false },
  ...overrides,
});

const lease = (overrides = {}) => ({
  schema: RUNNER_LEASE_SCHEMA,
  leaseId: 'lease-0001',
  holder: 'gaia-runner-supervisor',
  workKey: WORK_KEY(),
  generation: 7,
  provider: 'claude-code',
  capability: 'READ_ONLY_REVIEW',
  target: { kind: 'SYNTHETIC_CORPUS', id: CORPUS, mutable: false },
  expiresAt: LATER,
  ...overrides,
});

const fixture = (overrides = {}) => ({
  schema: PROVIDER_PROBE_FIXTURE_SCHEMA,
  provider: 'claude-code',
  capability: 'READ_ONLY_REVIEW',
  availability: 'AVAILABLE',
  quota: { remaining: 120, limit: 500, unit: 'REQUESTS' },
  usage: { tokens: 512, contextTokens: 2048, wallClockMs: 900 },
  mcpServers: [],
  providerBlockers: [],
  ...overrides,
});

/** A fixture adapter that records every request, so "the adapter was never called" is checkable. */
function countingAdapter(fixtureValue = fixture()) {
  const inner = createSyntheticFixtureProbeAdapter(fixtureValue);
  const calls = [];
  return {
    schema: PROVIDER_PROBE_ADAPTER_SCHEMA,
    observationSource: inner.observationSource,
    calls,
    observe(request) {
      calls.push(request);
      return inner.observe(request);
    },
  };
}

/** One probe input, overriding one part at a time. Shared with the mechanism reverts below. */
const buildInput = (over = {}) => ({
  schema: PROVIDER_PROBE_INPUT_SCHEMA,
  observedAt: over.observedAt ?? AT,
  identity: identity(over.identity),
  mandate: mandate(over.mandate),
  lease: over.lease === null ? null : lease(over.lease),
  priorReceipt: over.priorReceipt ?? null,
  ...over.input,
});

/** Probe with the shipped fixture adapter, overriding one part of the input at a time. */
function probe(over = {}) {
  const adapter = over.adapter ?? countingAdapter(fixture(over.fixture));
  const input = buildInput(over);
  return { receipt: probeProvider(input, adapter), adapter, input };
}

const blockedWith = (code, over = {}) => {
  const { receipt, adapter } = probe(over);
  assert.equal(receipt.outcome, 'BLOCKED', `expected ${code}, got ${canonicalJson(receipt)}`);
  assert.equal(receipt.blocker, code);
  assert.equal(receipt.effect, 'NONE');
  assert.equal(receipt.authority, 'NONE');
  // Every gate this helper serves decides before the adapter, so the property is asserted here
  // rather than remembered at each call site: a refusal that consulted the provider is a call.
  assert.equal(adapter.calls.length, 0, `${code} consulted the provider before refusing`);
  assert.equal(receipt.observationSource, null, 'a blocked receipt publishes no observation');
  return { receipt, adapter };
};

// -------------------------------------------------------------------------------------------
// P1-P2 — closed identity, derived labels, and contracts that refuse rather than repair.
// -------------------------------------------------------------------------------------------

test('P1: the work key is stable across generations; the generation key is not', () => {
  const first = runnerWorkKey(identity({ generation: 7 }));
  const second = runnerWorkKey(identity({ generation: 8 }));
  assert.equal(first, second, 'one host installation keeps one work key for its whole life');
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.notEqual(
    runnerGenerationKey(identity({ generation: 7 })),
    runnerGenerationKey(identity({ generation: 8 })),
    'a re-registration is a new generation, and the generation key says so',
  );
  assert.notEqual(first, runnerWorkKey(identity({ runnerId: 'gaia-win-runner-02' })));
  assert.notEqual(first, runnerWorkKey(identity({ os: 'LINUX' })));
  assert.notEqual(first, runnerWorkKey(identity({ arch: 'ARM64' })));
});

test('P1: registration labels are derived from the identity, never supplied', () => {
  const labels = runnerLabels(identity());
  assert.deepEqual(labels, [
    'arch:x64', 'capability:read-only-review', 'capability:research-citation', 'gaia',
    'generation:7', 'os:windows', 'provider:claude-code', 'provider:notebooklm',
  ], 'the label set is closed, lowercased, deduplicated and sorted');
  assert.ok(Object.isFrozen(labels));
  assert.ok(!runnerLabels(identity({ providers: ['claude-code'] })).includes('provider:notebooklm'),
    'a label cannot claim a provider the identity does not declare');
  assert.throws(() => requireRunnerIdentity({ ...identity(), labels: ['gaia', 'provider:junie'] }),
    RunnerProbeError, 'and a caller cannot supply labels at all');
});

test('P1: an incoherent runner identity is refused rather than repaired', () => {
  for (const bad of [
    { schema: 'gaia-runner-identity/2' }, { runnerId: '' }, { runnerId: 'A' }, { runnerId: 'x' },
    { runnerId: `${'x'.repeat(200)}` }, { os: 'windows' }, { os: 'FREEBSD' }, { arch: 'x64' },
    { generation: -1 }, { generation: 1.5 }, { generation: '7' }, { acceptingWork: 'true' },
    { providers: [] }, { providers: ['claude-code', 'claude-code'] }, { providers: ['gpt'] },
    { providers: ['notebooklm', 'claude-code'] }, { capabilities: [] }, { capabilities: ['ALL'] },
  ]) {
    assert.throws(() => requireRunnerIdentity(identity(bad)), RunnerProbeError,
      `${canonicalJson(bad)} is refused`);
  }
  assert.throws(() => requireRunnerIdentity({ ...identity(), lane: 'ix' }), RunnerProbeError);
  assert.throws(() => requireRunnerIdentity(null), RunnerProbeError);
});

test('P2: the mandate is closed, and carries no repository, credential or prompt body', () => {
  for (const bad of [
    { schema: 'gaia-provider-probe-mandate/2' }, { mandateId: '' }, { runnerWorkKey: 'short' },
    { runnerGeneration: -1 }, { provider: 'openai' }, { capability: 'ANYTHING' },
    { deadline: '2026-09-01' }, { deadline: null },
    { budget: { tokens: 0, contextTokens: 32000, wallClockMs: 60000 } },
    { budget: { tokens: 4000, contextTokens: 32000 } },
    { budget: { tokens: 4000, contextTokens: 32000, wallClockMs: -1 } },
    { declaredMcpServers: ['a', 'a'] }, { declaredMcpServers: [''] }, { declaredMcpServers: 'none' },
    { corpus: { corpusId: CORPUS, promptCount: 3, containsRepositorySource: true } },
    { corpus: { corpusId: CORPUS, promptCount: 0, containsRepositorySource: false } },
    { corpus: { corpusId: '', promptCount: 3, containsRepositorySource: false } },
  ]) {
    assert.throws(() => requireProviderProbeMandate(mandate(bad)), RunnerProbeError,
      `${canonicalJson(bad)} is refused`);
  }
  for (const field of ['repository', 'ref', 'worktree', 'token', 'prompt', 'env']) {
    assert.throws(() => requireProviderProbeMandate({ ...mandate(), [field]: 'x' }),
      RunnerProbeError, `a mandate has nowhere to put ${field}`);
  }
});

test('P2: a declared MCP server shaped like a credential is refused at the mandate', () => {
  for (const name of ['ghp_0123456789abcdef', 'github_pat_abc', 'sk-abcdef', 'AIzaSyABC']) {
    assert.throws(() => requireProviderProbeMandate(mandate({ declaredMcpServers: [name] })),
      RunnerProbeError, `${name} is credential-shaped and is not an MCP server name`);
  }
});

test('P2: the lease is closed and names one immutable target', () => {
  for (const bad of [
    { schema: 'gaia-runner-lease/2' }, { leaseId: '' }, { holder: '' }, { workKey: 'short' },
    { generation: -1 }, { provider: 'openai' }, { capability: 'ANYTHING' },
    { expiresAt: '2026-09-01' }, { target: null },
    { target: { kind: 'BRANCH', id: CORPUS, mutable: false } },
    { target: { kind: 'SYNTHETIC_CORPUS', id: '', mutable: false } },
    { target: { kind: 'SYNTHETIC_CORPUS', id: CORPUS, mutable: 'no' } },
    { target: { kind: 'SYNTHETIC_CORPUS', id: CORPUS } },
  ]) {
    assert.throws(() => requireRunnerLease(lease(bad)), RunnerProbeError,
      `${canonicalJson(bad)} is refused`);
  }
  assert.throws(() => requireRunnerLease({ ...lease(), scope: 'write' }), RunnerProbeError);
});

test('P2: the probe input itself is closed, and a malformed input throws rather than blocks', () => {
  const adapter = countingAdapter();
  for (const bad of [
    { schema: 'gaia-provider-probe-input/2' }, { observedAt: '2026-09-01' }, { observedAt: null },
    { identity: null }, { mandate: null }, { lease: 'lease-0001' }, { priorReceipt: 'x' },
  ]) {
    assert.throws(() => probeProvider({
      schema: PROVIDER_PROBE_INPUT_SCHEMA,
      observedAt: AT,
      identity: identity(),
      mandate: mandate(),
      lease: lease(),
      priorReceipt: null,
      ...bad,
    }, adapter), RunnerProbeError, `${canonicalJson(bad)} is a caller contract violation`);
  }
  assert.throws(() => probeProvider({
    schema: PROVIDER_PROBE_INPUT_SCHEMA,
    observedAt: AT,
    identity: identity(),
    mandate: mandate(),
    lease: lease(),
    priorReceipt: null,
  }, { schema: 'gaia-provider-probe-adapter/2', observe: () => null }), RunnerProbeError,
  'an adapter that does not declare the probe adapter contract is refused before it is called');
  assert.equal(adapter.calls.length, 0, 'and none of those reached the adapter');
});

// -------------------------------------------------------------------------------------------
// P3-P7 — authority. Each refuses before the adapter exists as far as the probe is concerned.
// -------------------------------------------------------------------------------------------

test('P3: a mandate addressed to another runner is a mis-delivery, not work', () => {
  blockedWith('RUNNER_MISDELIVERY', {
    mandate: { runnerWorkKey: runnerWorkKey(identity({ runnerId: 'gaia-win-runner-02' })) },
  });
});

test('P4: a generation that is not the observed one cannot accept work, past or future', () => {
  for (const generation of [6, 0, 8, 99]) {
    const { receipt, adapter } = probe({ mandate: { runnerGeneration: generation } });
    assert.equal(receipt.blocker, 'STALE_GENERATION',
      `generation ${generation} is not generation 7, in either direction`);
    assert.equal(adapter.calls.length, 0);
  }
  assert.equal(probe({ mandate: { runnerGeneration: 7 } }).receipt.outcome, 'CAPABILITY_OBSERVED');
});

test('P5: a draining runner refuses before its lease is even examined', () => {
  const { receipt, adapter } = probe({
    identity: { acceptingWork: false },
    lease: { expiresAt: LATER },
  });
  assert.equal(receipt.blocker, 'RUNNER_DRAINING',
    'drain is not defeated by holding a perfectly valid lease');
  assert.equal(adapter.calls.length, 0);
  assert.equal(probe({ identity: { acceptingWork: false }, lease: null }).receipt.blocker,
    'RUNNER_DRAINING', 'and drain is decided before the absent-lease refusal too');
});

test('P6: the lease must exist, name this exact target, and still be held', () => {
  assert.equal(probe({ lease: null }).receipt.blocker, 'LEASE_ABSENT');
  for (const foreign of [
    { workKey: runnerWorkKey(identity({ runnerId: 'gaia-win-runner-02' })) },
    { generation: 6 }, { provider: 'notebooklm' }, { capability: 'RESEARCH_CITATION' },
    { target: { kind: 'SYNTHETIC_CORPUS', id: 'another-corpus', mutable: false } },
  ]) {
    const { receipt, adapter } = probe({ lease: foreign });
    assert.equal(receipt.blocker, 'LEASE_FOREIGN', `${canonicalJson(foreign)} is another lease`);
    assert.equal(adapter.calls.length, 0);
  }
  assert.equal(probe({ lease: { expiresAt: AT } }).receipt.blocker, 'LEASE_EXPIRED',
    'a lease is not still held at the instant it expires');
});

test('P6: a mutable target is refused outright while there is no single-writer protocol', () => {
  const { receipt, adapter } = probe({
    lease: { target: { kind: 'SYNTHETIC_CORPUS', id: CORPUS, mutable: true } },
  });
  assert.equal(receipt.blocker, 'MUTABLE_TARGET_NOT_ADMITTED');
  assert.equal(adapter.calls.length, 0);
});

test('P7: a mandate is not still valid at the instant it expires', () => {
  blockedWith('MANDATE_EXPIRED', { observedAt: LATER });
  blockedWith('MANDATE_EXPIRED', { observedAt: '2026-09-02T00:00:00.000Z' });
  assert.equal(probe({ observedAt: AT }).receipt.outcome, 'CAPABILITY_OBSERVED');
});

// -------------------------------------------------------------------------------------------
// P8-P10 — admission. One closed table that narrows, and never grants.
// -------------------------------------------------------------------------------------------

test('P8: a provider the runner did not declare is unregistered work', () => {
  const { receipt, adapter } = probe({
    identity: { providers: ['notebooklm'] },
    mandate: { provider: 'claude-code' },
  });
  assert.equal(receipt.blocker, 'PROVIDER_UNREGISTERED');
  assert.equal(adapter.calls.length, 0);
});

test('P8: a capability the runner did not declare is refused before the table is consulted', () => {
  blockedWith('CAPABILITY_NOT_ADMITTED', {
    identity: { capabilities: ['RESEARCH_CITATION'] },
    mandate: { capability: 'READ_ONLY_REVIEW' },
    lease: { capability: 'READ_ONLY_REVIEW' },
  });
});

test('P9: no provider is admitted for writer or merge authority at this revision', () => {
  for (const capability of ['CODE_WRITE', 'MERGE_APPROVAL']) {
    for (const provider of RUNNER_PROVIDERS) {
      assert.ok(!PROVIDER_CAPABILITY_ADMISSION[provider].includes(capability),
        `${provider} must not be admitted for ${capability}`);
    }
    const { receipt, adapter } = probe({
      identity: { capabilities: [capability] },
      mandate: { capability },
      lease: { capability },
    });
    assert.equal(receipt.blocker, 'CAPABILITY_NOT_ADMITTED',
      `${capability} is representable exactly so it can be refused`);
    assert.equal(adapter.calls.length, 0);
  }
});

test('P10: NotebookLM is a cited research adapter and nothing else', () => {
  assert.deepEqual(PROVIDER_CAPABILITY_ADMISSION.notebooklm, ['RESEARCH_CITATION']);
  // The refusal is the shared table, not a NotebookLM branch, and it decides before the adapter.
  blockedWith('CAPABILITY_NOT_ADMITTED', {
    identity: { providers: ['notebooklm'], capabilities: ['READ_ONLY_REVIEW'] },
    mandate: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
    lease: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
    fixture: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
  });
});

test('P10: qwen-local admits nothing until its four security gates pass', () => {
  assert.deepEqual(PROVIDER_CAPABILITY_ADMISSION['qwen-local'], []);
  for (const capability of PROVIDER_CAPABILITY_KINDS) {
    const { receipt, adapter } = probe({
      identity: { providers: ['qwen-local'], capabilities: [capability] },
      mandate: { provider: 'qwen-local', capability },
      lease: { provider: 'qwen-local', capability },
    });
    assert.equal(receipt.blocker, 'CAPABILITY_NOT_ADMITTED');
    assert.equal(adapter.calls.length, 0, 'nothing local is ever launched to find out');
  }
});

// -------------------------------------------------------------------------------------------
// P11-P13 — crash reconciliation, before any retry reaches the provider.
// -------------------------------------------------------------------------------------------

test('P11: an unmodified prior receipt replays byte-identically without consulting the provider', () => {
  const first = probe().receipt;
  const adapter = {
    schema: PROVIDER_PROBE_ADAPTER_SCHEMA,
    observationSource: 'SYNTHETIC_FIXTURE',
    observe() { throw new Error('called'); },
  };
  const replayed = probe({ priorReceipt: first, adapter }).receipt;
  assert.equal(canonicalJson(replayed), canonicalJson(first),
    'a crash between the observation and its persistence does not re-run the provider');
  assert.equal(replayed.revision, first.revision);
});

test('P11: a prior BLOCKED receipt reconciles just as a successful one does', () => {
  const blocked = probe({ fixture: { availability: 'UNAVAILABLE', providerBlockers: ['PROVIDER_TIMEOUT'] } });
  const overBudget = probe({
    fixture: { usage: { tokens: 999999, contextTokens: 2048, wallClockMs: 900 } },
  }).receipt;
  assert.equal(overBudget.blocker, 'BUDGET_EXCEEDED');
  const adapter = {
    schema: PROVIDER_PROBE_ADAPTER_SCHEMA,
    observationSource: 'SYNTHETIC_FIXTURE',
    observe() { throw new Error('called'); },
  };
  assert.equal(
    canonicalJson(probe({ priorReceipt: overBudget, adapter }).receipt),
    canonicalJson(overBudget),
    'a refusal is a receipt too, and replaying it does not become a second attempt',
  );
  assert.equal(blocked.receipt.outcome, 'CAPABILITY_OBSERVED');
});

test('P12: a prior receipt that is not this receipt is a conflict, never a second mint', () => {
  const mine = probe().receipt;
  const foreignKey = { ...mine, idempotencyKey: sha256('elsewhere') };
  const foreignMandate = { ...mine, mandateDigest: sha256('another mandate') };
  const tampered = { ...mine, availability: 'AVAILABLE', quota: { ...mine.quota, remaining: 999 } };
  for (const [name, prior] of [
    ['a foreign idempotency key', foreignKey],
    ['a foreign mandate digest', foreignMandate],
    ['a receipt whose revision no longer matches its own content', tampered],
  ]) {
    const adapter = countingAdapter();
    const { receipt } = probe({ priorReceipt: prior, adapter });
    assert.equal(receipt.blocker, 'RECEIPT_CONFLICT', name);
    assert.equal(adapter.calls.length, 0, 'and the conflict is decided before any retry');
  }
});

test('P12: a prior receipt minted by an older generation cannot be replayed into a newer one', () => {
  const old = probe({
    identity: { generation: 6 }, mandate: { runnerGeneration: 6 }, lease: { generation: 6 },
  }).receipt;
  assert.equal(old.outcome, 'CAPABILITY_OBSERVED');
  assert.equal(probe({ priorReceipt: old }).receipt.blocker, 'RECEIPT_CONFLICT',
    'the idempotency key binds a receipt to the generation that minted it');
});

test('P13: authority is decided before reconciliation, and reconciliation before the provider', () => {
  const mine = probe().receipt;
  const adapter = countingAdapter();
  const { receipt } = probe({
    priorReceipt: mine, adapter, identity: { generation: 8 }, mandate: { runnerGeneration: 7 },
  });
  assert.equal(receipt.blocker, 'STALE_GENERATION',
    'a valid prior receipt does not resurrect a generation that already lost');
  assert.equal(adapter.calls.length, 0);
});

// -------------------------------------------------------------------------------------------
// P14-P21 — the adapter is untrusted input, and its answer is parsed, not believed.
// -------------------------------------------------------------------------------------------

test('P14: an adapter that throws, or answers with a non-observation, fails closed', () => {
  for (const observe of [
    () => { throw new Error('provider exploded'); },
    () => null,
    () => undefined,
    () => 'AVAILABLE',
    () => [],
  ]) {
    const receipt = probeProvider({
      schema: PROVIDER_PROBE_INPUT_SCHEMA,
      observedAt: AT,
      identity: identity(),
      mandate: mandate(),
      lease: lease(),
      priorReceipt: null,
    }, { schema: PROVIDER_PROBE_ADAPTER_SCHEMA, observationSource: 'SYNTHETIC_FIXTURE', observe });
    assert.equal(receipt.blocker, 'PROVIDER_ADAPTER_FAILED');
    assert.equal(receipt.availability, 'UNKNOWN', 'a failed probe knows nothing, it does not guess');
  }
});

/** Answer with an arbitrary observation body, to test what the probe does with a hostile provider. */
function sayingAdapter(overrides, declaredSource = 'SYNTHETIC_FIXTURE') {
  return {
    schema: PROVIDER_PROBE_ADAPTER_SCHEMA,
    observationSource: declaredSource,
    observe(request) {
      return {
        schema: PROVIDER_PROBE_OBSERVATION_SCHEMA,
        mandateDigest: request.mandateDigest,
        provider: request.provider,
        capability: request.capability,
        availability: 'AVAILABLE',
        quota: { remaining: 120, limit: 500, unit: 'REQUESTS' },
        usage: { tokens: 512, contextTokens: 2048, wallClockMs: 900 },
        mcpServers: [],
        providerBlockers: [],
        effect: 'NONE',
        authority: 'NONE',
        sourceExposed: false,
        credentialsRead: false,
        observationSource: declaredSource,
        ...overrides,
      };
    },
  };
}

const saying = (overrides) => probeProvider({
  schema: PROVIDER_PROBE_INPUT_SCHEMA,
  observedAt: AT,
  identity: identity(),
  mandate: mandate(),
  lease: lease(),
  priorReceipt: null,
}, sayingAdapter(overrides));

test('P15: an observation with an unknown field, or a value outside a closed set, is refused', () => {
  for (const bad of [
    { sessionToken: 'ghp_secret' }, { schema: 'gaia-provider-capability-observation/2' },
    { availability: 'PROBABLY' }, { quota: { remaining: 1, limit: 2, unit: 'GOLD' } },
    { quota: { remaining: -1, limit: 2, unit: 'REQUESTS' } },
    { usage: { tokens: -1, contextTokens: 1, wallClockMs: 1 } },
    { usage: { tokens: 1, contextTokens: 1 } },
    { mcpServers: 'none' }, { providerBlockers: ['PROVIDER_ANNOYED'] },
    { availability: null }, { quota: 'plenty' },
  ]) {
    assert.equal(saying(bad).blocker, 'OBSERVATION_INVALID', `${canonicalJson(bad)} is refused`);
  }
});

test('P16: an observation bound to another mandate, provider or capability is not this answer', () => {
  assert.equal(saying({ mandateDigest: sha256('another mandate') }).blocker, 'OBSERVATION_MISBOUND');
  assert.equal(saying({ provider: 'notebooklm' }).blocker, 'OBSERVATION_MISBOUND');
  assert.equal(saying({ capability: 'RESEARCH_CITATION' }).blocker, 'OBSERVATION_MISBOUND');
});

test('P17: an observation that disagrees with itself is refused, not resolved in the provider favour', () => {
  assert.equal(saying({ availability: 'AVAILABLE', providerBlockers: ['PROVIDER_TIMEOUT'] }).blocker,
    'OBSERVATION_INCOHERENT', 'available and blocked at once is not a reading');
  assert.equal(saying({ availability: 'UNAVAILABLE', providerBlockers: [] }).blocker,
    'OBSERVATION_INCOHERENT', 'unavailable for no stated reason is not a reading either');
  assert.equal(saying({ availability: 'UNKNOWN', providerBlockers: [] }).blocker,
    'OBSERVATION_INCOHERENT');
  assert.equal(saying({ availability: 'UNAVAILABLE', providerBlockers: ['PROVIDER_NOT_INSTALLED'] })
    .outcome, 'CAPABILITY_OBSERVED');
});

test('P18: an MCP server the mandate did not declare fails the probe closed', () => {
  assert.equal(saying({ mcpServers: ['filesystem'] }).blocker, 'UNDECLARED_MCP_SERVER');
  const declared = probeProvider({
    schema: PROVIDER_PROBE_INPUT_SCHEMA,
    observedAt: AT,
    identity: identity(),
    mandate: mandate({ declaredMcpServers: ['filesystem'] }),
    lease: lease(),
    priorReceipt: null,
  }, sayingAdapter({ mcpServers: ['filesystem'] }));
  assert.equal(declared.outcome, 'CAPABILITY_OBSERVED', 'an explicitly declared server is allowed');
  assert.deepEqual(declared.mcpServers, ['filesystem']);
});

test('P19: a credential-shaped name in the one free-form field fails closed', () => {
  for (const name of ['ghp_0123456789abcdef', 'sk-abcdef0123', 'xoxb-1-2-3', 'AIzaSyABCDEFG']) {
    assert.equal(saying({ mcpServers: [name] }).blocker, 'CREDENTIAL_MATERIAL_PRESENT',
      `${name} never becomes part of a Gaia receipt`);
  }
});

test('P20: a provider that claims an effect or an authority is refused, not recorded', () => {
  for (const claim of [
    { effect: 'REVIEW_POSTED' }, { authority: 'REPO_WRITE' }, { authority: 'MERGE' },
    { sourceExposed: true }, { credentialsRead: true },
  ]) {
    const receipt = saying(claim);
    assert.equal(receipt.blocker, 'AUTHORITY_WIDENING', canonicalJson(claim));
    assert.equal(receipt.effect, 'NONE');
    assert.equal(receipt.authority, 'NONE');
  }
});

test('P21: usage past any budget dimension is a blocker, never a published capability', () => {
  for (const usage of [
    { tokens: 4001, contextTokens: 2048, wallClockMs: 900 },
    { tokens: 512, contextTokens: 32001, wallClockMs: 900 },
    { tokens: 512, contextTokens: 2048, wallClockMs: 60001 },
  ]) {
    const receipt = saying({ usage });
    assert.equal(receipt.blocker, 'BUDGET_EXCEEDED', canonicalJson(usage));
    assert.equal(receipt.availability, 'UNKNOWN',
      'an over-budget run reports no availability it did not earn');
  }
  assert.equal(saying({ usage: { tokens: 4000, contextTokens: 32000, wallClockMs: 60000 } }).outcome,
    'CAPABILITY_OBSERVED', 'spending exactly the budget is within it');
});

// -------------------------------------------------------------------------------------------
// P22-P28 — the truthful reading, its determinism, and the one shipped probe.
// -------------------------------------------------------------------------------------------

test('P22: a truthful available reading is published with no effect and no authority', () => {
  const { receipt, adapter, input } = probe();
  assert.equal(receipt.schema, PROVIDER_PROBE_RECEIPT_SCHEMA);
  assert.equal(receipt.outcome, 'CAPABILITY_OBSERVED');
  assert.equal(receipt.blocker, null);
  assert.equal(receipt.availability, 'AVAILABLE');
  assert.deepEqual(receipt.quota, { remaining: 120, limit: 500, unit: 'REQUESTS' });
  assert.deepEqual(receipt.usage, { tokens: 512, contextTokens: 2048, wallClockMs: 900 });
  assert.deepEqual(receipt.providerBlockers, []);
  assert.equal(receipt.effect, 'NONE');
  assert.equal(receipt.authority, 'NONE');
  assert.equal(receipt.runnerWorkKey, WORK_KEY());
  assert.equal(receipt.runnerGeneration, 7);
  assert.equal(receipt.observedAt, AT);
  assert.equal(receipt.mandateDigest, providerProbeMandateDigest(input.mandate));
  assert.equal(receipt.idempotencyKey, providerProbeIdempotencyKey({
    workKey: WORK_KEY(), generation: 7, provider: 'claude-code',
    capability: 'READ_ONLY_REVIEW', mandateId: 'probe-0001',
  }));
  assert.equal(adapter.calls.length, 1);
  assert.deepEqual(Object.keys(adapter.calls[0]).sort(), [
    'budget', 'capability', 'corpusId', 'declaredMcpServers', 'mandateDigest', 'promptCount',
    'provider', 'schema',
  ], 'a probe request carries no repository, ref, path, token, prompt body or environment');
  assert.equal(adapter.calls[0].schema, PROVIDER_PROBE_REQUEST_SCHEMA);
});

test('P23: an unavailable provider is an observation, not a Gaia failure', () => {
  const { receipt } = probe({
    fixture: {
      availability: 'UNAVAILABLE', quota: null,
      providerBlockers: ['PROVIDER_NOT_INSTALLED', 'PROVIDER_UNAUTHENTICATED'],
    },
  });
  assert.equal(receipt.outcome, 'CAPABILITY_OBSERVED');
  assert.equal(receipt.blocker, null, 'Gaia blocked nothing; the provider reported its own state');
  assert.equal(receipt.availability, 'UNAVAILABLE');
  assert.deepEqual(receipt.providerBlockers, ['PROVIDER_NOT_INSTALLED', 'PROVIDER_UNAUTHENTICATED'],
    'and the provider blockers are reported in one sorted, closed vocabulary');
  assert.equal(receipt.quota, null, 'a quota nobody read is null, not zero');
});

test('P24: replaying a probe is byte-identical, and the revision is the digest of the receipt', () => {
  const first = probe().receipt;
  for (let i = 0; i < 64; i += 1) {
    const again = probe().receipt;
    assert.equal(canonicalJson(again), canonicalJson(first), 'replay is byte-identical');
  }
  assert.equal(first.revision, sha256(canonicalJson(
    Object.fromEntries(Object.entries(first).filter(([key]) => key !== 'revision')),
  )), 'the revision is the digest of exactly the receipt it is published on');
  assert.ok(Object.isFrozen(first));
});

test('P24: neither key order nor declared-server order changes the receipt', () => {
  const straight = probe({ mandate: { declaredMcpServers: ['alpha', 'beta'] } }).receipt;
  const reversed = probe({ mandate: { declaredMcpServers: ['beta', 'alpha'] } }).receipt;
  assert.equal(reversed.revision, straight.revision,
    'two callers that listed the same declared servers in a different order agree');
  const shuffled = Object.fromEntries(Object.entries(mandate()).reverse());
  assert.equal(providerProbeMandateDigest(shuffled), providerProbeMandateDigest(mandate()));
});

test('P25: the emitted vocabulary is closed on every axis', () => {
  assert.deepEqual([...RUNNER_PROVIDERS], [
    'agy-gemini', 'auggie', 'claude-code', 'junie', 'notebooklm', 'qwen-local',
  ]);
  assert.deepEqual([...PROVIDER_CAPABILITY_KINDS], [
    'CODE_WRITE', 'MERGE_APPROVAL', 'READ_ONLY_REVIEW', 'RESEARCH_CITATION',
  ]);
  assert.deepEqual([...PROVIDER_AVAILABILITIES], ['AVAILABLE', 'UNAVAILABLE', 'UNKNOWN']);
  assert.deepEqual([...RUNNER_OPERATING_SYSTEMS], ['LINUX', 'MACOS', 'WINDOWS']);
  assert.deepEqual([...RUNNER_ARCHITECTURES], ['ARM64', 'X64']);
  assert.deepEqual([...PROVIDER_QUOTA_UNITS], ['REQUESTS', 'SESSIONS', 'TOKENS', 'UNKNOWN']);
  assert.deepEqual([...PROVIDER_REPORTED_BLOCKERS], [
    'PROVIDER_NOT_INSTALLED', 'PROVIDER_QUOTA_EXHAUSTED', 'PROVIDER_SECURITY_GATE_PENDING',
    'PROVIDER_TIMEOUT', 'PROVIDER_UNAUTHENTICATED',
  ]);
  for (const collection of [
    RUNNER_PROVIDERS, PROVIDER_CAPABILITY_KINDS, PROVIDER_PROBE_BLOCKERS,
    PROVIDER_REPORTED_BLOCKERS, PROVIDER_QUOTA_UNITS, PROVIDER_PROBE_RECEIPT_FIELDS,
  ]) {
    assert.ok(Object.isFrozen(collection));
  }
  for (const provider of Object.keys(PROVIDER_CAPABILITY_ADMISSION)) {
    assert.ok(RUNNER_PROVIDERS.includes(provider), `${provider} is a registered provider`);
    for (const capability of PROVIDER_CAPABILITY_ADMISSION[provider]) {
      assert.ok(PROVIDER_CAPABILITY_KINDS.includes(capability));
    }
  }
  assert.deepEqual(Object.keys(PROVIDER_CAPABILITY_ADMISSION).sort(), [...RUNNER_PROVIDERS],
    'every registered provider has a row, so a missing row can never read as permissive');
});

test('P26: every receipt carries exactly the closed receipt field set, on every path', () => {
  const receipts = [
    probe().receipt,
    probe({ lease: null }).receipt,
    probe({ mandate: { runnerGeneration: 6 } }).receipt,
    saying({ effect: 'REVIEW_POSTED' }),
    saying({ usage: { tokens: 999999, contextTokens: 1, wallClockMs: 1 } }),
  ];
  for (const receipt of receipts) {
    assert.deepEqual(Object.keys(receipt).sort(), [...PROVIDER_PROBE_RECEIPT_FIELDS]);
    assert.equal(receipt.effect, 'NONE');
    assert.equal(receipt.authority, 'NONE');
    assert.ok(receipt.blocker === null || PROVIDER_PROBE_BLOCKERS.includes(receipt.blocker));
    assert.ok(['CAPABILITY_OBSERVED', 'BLOCKED'].includes(receipt.outcome));
  }
});

test('P27: the shipped probe is a pure function over a fixture and can reach nothing', () => {
  const source = readFileSync(join(ROOT, 'src', 'runner-provider-probe.mjs'), 'utf8');
  for (const forbidden of [
    /node:child_process/, /node:fs/, /node:net/, /node:https?/, /node:process/, /node:os/,
    /\bspawn\w*\s*\(/, /\bfetch\s*\(/, /\breadFileSync\s*\(/, /\bprocess\.env\b/, /\bDate\.now\b/,
    /\bnew\s+Date\b/, /\brequire\s*\(/,
  ]) {
    assert.ok(!forbidden.test(source),
      `the probe module must not reach ${forbidden}: a capability probe holds no clock, no
       filesystem, no process control, no network and no environment`);
  }
});

test('P28: the fixture adapter refuses a hostile fixture and a question it was not asked', () => {
  for (const bad of [
    { schema: 'gaia-provider-probe-fixture/2' }, { provider: 'openai' }, { capability: 'ALL' },
    { availability: 'PROBABLY' }, { effect: 'REVIEW_POSTED' }, { authority: 'MERGE' },
    { sourceExposed: true }, { credentialsRead: true }, { mandateDigest: sha256('x') },
    { providerBlockers: ['PROVIDER_ANNOYED'] }, { usage: null },
  ]) {
    assert.throws(() => createSyntheticFixtureProbeAdapter(fixture(bad)), RunnerProbeError,
      `${canonicalJson(bad)} is not a fixture this adapter will serve`);
  }
  const adapter = createSyntheticFixtureProbeAdapter(fixture());
  assert.equal(adapter.schema, PROVIDER_PROBE_ADAPTER_SCHEMA);
  const wrongQuestion = probe({
    identity: { providers: ['notebooklm'], capabilities: ['RESEARCH_CITATION'] },
    mandate: { provider: 'notebooklm', capability: 'RESEARCH_CITATION' },
    lease: { provider: 'notebooklm', capability: 'RESEARCH_CITATION' },
    adapter,
  });
  assert.equal(wrongQuestion.receipt.blocker, 'PROVIDER_ADAPTER_FAILED',
    'a probe that answers a question it was not asked is worse than a probe that fails');
});

// -------------------------------------------------------------------------------------------
// P29-P32 — the R1 probe repairs: a bounded name, a module that is text, a named observation
// source, and a refusal bound to proof that the adapter was never reached.
// -------------------------------------------------------------------------------------------

/**
 * Ten identifiers a Gaia receipt must never carry. The first four were reproduced passing both
 * boundaries of the shipped module and being echoed verbatim into a successful, content-addressed
 * receipt; none of them is on any prefix list, which is the point of bounding the representation
 * instead. The rest were already refused by prefix and are kept so either mechanism regressing is
 * visible. All ten are synthetic non-secrets and authenticate nothing.
 */
const CREDENTIAL_SHAPED_NAMES = Object.freeze([
  'glpat-abcdefghijklmnop',
  'hf_abcdefghijklmnopqrst',
  'npm_abcdefghijklmnopqrst',
  'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
  'ghp_0123456789abcdef',
  'sk-abcdef0123',
  'xoxb-1-2-3',
  'AIzaSyABCDEFG',
  // Written in two pieces so this file does not itself trip the repository's own credential
  // scanner. It is the published AWS documentation example and authenticates nothing.
  `AKIA${'IOSFODNN7EXAMPLE'}`,
  'eyJhbGciOiJIUzI1NiJ9',
]);

/** Five names an operator actually writes. The refusals above mean nothing without these. */
const SAFE_MCP_NAMES = Object.freeze([
  'claude-code', 'claude.mcp', 'context7', 'filesystem', 'qwen-local',
]);

test('P29: a credential-shaped MCP identifier has no admitted representation at any boundary', () => {
  for (const name of CREDENTIAL_SHAPED_NAMES) {
    assert.throws(() => requireProviderProbeMandate(mandate({ declaredMcpServers: [name] })),
      RunnerProbeError, `a mandate cannot declare ${name}`);
    assert.throws(() => createSyntheticFixtureProbeAdapter(fixture({ mcpServers: [name] })),
      RunnerProbeError, `a fixture cannot be built to emit ${name}`);
    const receipt = saying({ mcpServers: [name] });
    assert.equal(receipt.blocker, 'CREDENTIAL_MATERIAL_PRESENT',
      `${name} is refused before it is read as a server name`);
    assert.deepEqual(receipt.mcpServers, [], `${name} reaches no receipt field`);
    assert.ok(!canonicalJson(receipt).includes(name),
      `${name} is not echoed anywhere in the receipt, not even inside a blocker`);
  }
});

test('P29: a safe MCP identifier is still admitted, declared, observed and published', () => {
  const declared = [...SAFE_MCP_NAMES].sort();
  for (const name of declared) {
    assert.deepEqual(requireProviderProbeMandate(mandate({ declaredMcpServers: [name] }))
      .declaredMcpServers, [name], `${name} is a name an operator may declare`);
  }
  const receipt = probeProvider({
    schema: PROVIDER_PROBE_INPUT_SCHEMA,
    observedAt: AT,
    identity: identity(),
    mandate: mandate({ declaredMcpServers: declared }),
    lease: lease(),
    priorReceipt: null,
  }, sayingAdapter({ mcpServers: declared }));
  assert.equal(receipt.outcome, 'CAPABILITY_OBSERVED', 'so the refusal above is discriminating');
  assert.deepEqual(receipt.mcpServers, declared, 'and a declared name is still durable evidence');
});

test('P30: the probe module is text, and its digest separator is written as an escape', () => {
  const path = join(ROOT, 'src', 'runner-provider-probe.mjs');
  assert.equal(readFileSync(path).indexOf(0), -1,
    'a raw NUL byte makes every grep -r and rg sweep over src/ skip this file as binary');
  assert.match(readFileSync(path, 'utf8'), /\\0/,
    'and the separator is still there, written as the two-character escape');
  // Pinned at 47c9aff, before the escape was written: a receipt is content-addressed, so these
  // two digests are how "byte-identical at runtime" is checked rather than asserted.
  assert.equal(runnerWorkKey(identity()),
    '1fd090ead9f528fb3d99a5904bb017d0917db672267d3930b6b8f2105710428d');
  assert.equal(providerProbeIdempotencyKey({
    workKey: WORK_KEY(), generation: 7, provider: 'claude-code',
    capability: 'READ_ONLY_REVIEW', mandateId: 'probe-0001',
  }), '8ebc63c363b5b98041340d47b038dc529270d953d20ce18e588a6accaeae463e');
});

test('P31: every published reading names the source it came from', () => {
  assert.deepEqual([...PROVIDER_OBSERVATION_SOURCES], ['LIVE_PROVIDER', 'SYNTHETIC_FIXTURE']);
  assert.ok(PROVIDER_PROBE_RECEIPT_FIELDS.includes('observationSource'));
  const { receipt } = probe();
  assert.equal(receipt.outcome, 'CAPABILITY_OBSERVED');
  assert.equal(receipt.observationSource, 'SYNTHETIC_FIXTURE',
    'a fixture reading is distinguishable at rest from one a later slice takes from a provider');
  assert.equal(createSyntheticFixtureProbeAdapter(fixture()).observationSource, 'SYNTHETIC_FIXTURE',
    'the source is declared by the adapter, so the kernel never has to believe the answer');
  for (const refused of [probe({ lease: null }).receipt, saying({ effect: 'REVIEW_POSTED' })]) {
    assert.equal(refused.observationSource, null, 'a blocked receipt published no observation');
  }
});

/** A well-shaped function that must never run, so an adapter can be malformed but callable. */
function refuseToAnswer() {
  throw new Error('this adapter must never be consulted');
}

test('P31: an unknown or contradictory observation source is refused, never settled', () => {
  assert.throws(() => probeProvider(buildInput(),
    { schema: PROVIDER_PROBE_ADAPTER_SCHEMA, observe: refuseToAnswer }), RunnerProbeError,
  'an adapter that declares no observation source is not an adapter');
  assert.throws(() => probeProvider(buildInput(), {
    schema: PROVIDER_PROBE_ADAPTER_SCHEMA, observationSource: 'HEARSAY', observe: refuseToAnswer,
  }), RunnerProbeError, 'and it cannot declare one outside the closed vocabulary');
  assert.throws(() => createSyntheticFixtureProbeAdapter(fixture({ observationSource: 'LIVE_PROVIDER' })),
    RunnerProbeError, 'the fixture contract has no field to claim a source in');
  assert.equal(saying({ observationSource: 'LIVE_PROVIDER' }).blocker, 'OBSERVATION_MISBOUND',
    'an answer claiming a source its adapter did not declare is misbound, not quietly resolved');
  for (const bad of ['HEARSAY', null, '']) {
    assert.equal(saying({ observationSource: bad }).blocker, 'OBSERVATION_INVALID',
      `${canonicalJson(bad)} is not a registered observation source`);
  }
  const live = probeProvider(buildInput(),
    sayingAdapter({ observationSource: 'LIVE_PROVIDER' }, 'LIVE_PROVIDER'));
  assert.equal(live.outcome, 'CAPABILITY_OBSERVED');
  assert.equal(live.observationSource, 'LIVE_PROVIDER',
    'the discriminator discriminates, which is the only reason to record one');
});

test('P32: every pre-adapter refusal proves the adapter was never called', () => {
  const other = probe({ mandate: { mandateId: 'probe-0002' } }).receipt;
  assert.equal(other.outcome, 'CAPABILITY_OBSERVED');
  const cases = [
    ['RUNNER_MISDELIVERY',
      { mandate: { runnerWorkKey: runnerWorkKey(identity({ runnerId: 'gaia-win-runner-02' })) } }],
    ['STALE_GENERATION', { mandate: { runnerGeneration: 6 } }],
    ['RUNNER_DRAINING', { identity: { acceptingWork: false } }],
    ['MANDATE_EXPIRED', { observedAt: LATER }],
    ['LEASE_ABSENT', { lease: null }],
    ['LEASE_FOREIGN', { lease: { generation: 6 } }],
    ['LEASE_EXPIRED', { lease: { expiresAt: AT } }],
    ['MUTABLE_TARGET_NOT_ADMITTED',
      { lease: { target: { kind: 'SYNTHETIC_CORPUS', id: CORPUS, mutable: true } } }],
    ['PROVIDER_UNREGISTERED',
      { identity: { providers: ['notebooklm'] }, mandate: { provider: 'claude-code' } }],
    ['CAPABILITY_NOT_ADMITTED', {
      identity: { capabilities: ['RESEARCH_CITATION'] },
      mandate: { capability: 'READ_ONLY_REVIEW' },
      lease: { capability: 'READ_ONLY_REVIEW' },
    }],
    ['RECEIPT_CONFLICT', { priorReceipt: other }],
  ];
  assert.equal(new Set(cases.map(([code]) => code)).size, cases.length, 'one case per blocker');
  for (const [code, over] of cases) blockedWith(code, over);
});

// -------------------------------------------------------------------------------------------
// Mechanism reverts — each shows a gate tests the mechanism rather than the fixtures.
// -------------------------------------------------------------------------------------------

test('MR1: accepting a generation that already lost is what lets a stale runner work', async () => {
  const mutant = await importMutant('stale-generation-accepted', (source) => source.replace(
    "if (mandate.runnerGeneration !== identity.generation) return blocked(context, 'STALE_GENERATION');",
    "if (false) return blocked(context, 'STALE_GENERATION');",
  ));
  const input = buildInput({ mandate: { runnerGeneration: 6 } });
  assert.equal(mutant.probeProvider(input, countingAdapter()).outcome, 'CAPABILITY_OBSERVED',
    'the mutant hands a live provider observation to a generation that was replaced');
  assert.equal(probeProvider(input, countingAdapter()).blocker, 'STALE_GENERATION');
});

test('MR2: dropping the drain gate is how a host that said stop keeps taking work', async () => {
  const mutant = await importMutant('drain-gate-removed', (source) => source.replace(
    "if (!identity.acceptingWork) return blocked(context, 'RUNNER_DRAINING');",
    "if (false) return blocked(context, 'RUNNER_DRAINING');",
  ));
  const input = buildInput({ identity: { acceptingWork: false } });
  assert.equal(mutant.probeProvider(input, countingAdapter()).outcome, 'CAPABILITY_OBSERVED',
    'the mutant probes a provider on a runner that is being removed');
  assert.equal(probeProvider(input, countingAdapter()).blocker, 'RUNNER_DRAINING');
});

test('MR3: admitting a mutable target is a single-writer claim this slice cannot make', async () => {
  const mutant = await importMutant('mutable-target-admitted', (source) => source.replace(
    "if (lease.target.mutable) return blocked(context, 'MUTABLE_TARGET_NOT_ADMITTED');",
    "if (false) return blocked(context, 'MUTABLE_TARGET_NOT_ADMITTED');",
  ));
  const input = buildInput({
    lease: { target: { kind: 'SYNTHETIC_CORPUS', id: CORPUS, mutable: true } },
  });
  assert.equal(mutant.probeProvider(input, countingAdapter()).outcome, 'CAPABILITY_OBSERVED',
    'the mutant runs against a target another writer may be changing underneath it');
  assert.equal(probeProvider(input, countingAdapter()).blocker, 'MUTABLE_TARGET_NOT_ADMITTED');
});

test('MR4: dropping the authority gate records no effect for a provider that claims one', async () => {
  const mutant = await importMutant('authority-gate-removed', (source) => source.replace(
    "if (observation.effect !== 'NONE' || observation.authority !== 'NONE'\n"
    + '      || observation.sourceExposed || observation.credentialsRead) {',
    'if (false) {',
  ));
  const claimant = sayingAdapter({ effect: 'REVIEW_POSTED', authority: 'REPO_WRITE' });
  const mutated = mutant.probeProvider(buildInput(), claimant);
  assert.equal(mutated.outcome, 'CAPABILITY_OBSERVED');
  assert.equal(mutated.effect, 'NONE',
    'and the published receipt still says NONE, so the claimed effect leaves no trace at all');
  assert.equal(probeProvider(buildInput(), claimant).blocker, 'AUTHORITY_WIDENING');
});

test('MR5: copying the fixture authority fields gives a hostile fixture a field to fill', async () => {
  const mutant = await importMutant('fixture-copies-authority', (source) => source
    .replace(
      "requireClosedFields(fixture, PROVIDER_PROBE_FIXTURE_FIELDS, 'probe fixture');",
      "if (!isPlainObject(fixture)) refuse('a probe fixture object is required');",
    )
    .replace(
      "        effect: 'NONE',\n"
      + "        authority: 'NONE',\n"
      + '        sourceExposed: false,\n'
      + '        credentialsRead: false,',
      "        effect: fixture.effect ?? 'NONE',\n"
      + "        authority: fixture.authority ?? 'NONE',\n"
      + '        sourceExposed: fixture.sourceExposed ?? false,\n'
      + '        credentialsRead: fixture.credentialsRead ?? false,',
    ));
  const hostile = { ...fixture(), effect: 'REVIEW_POSTED', credentialsRead: true };
  const request = {
    schema: PROVIDER_PROBE_REQUEST_SCHEMA,
    provider: 'claude-code',
    capability: 'READ_ONLY_REVIEW',
    corpusId: CORPUS,
    promptCount: 3,
    budget: { tokens: 4000, contextTokens: 32000, wallClockMs: 60000 },
    declaredMcpServers: [],
    mandateDigest: providerProbeMandateDigest(mandate()),
  };
  const emitted = mutant.createSyntheticFixtureProbeAdapter(hostile).observe(request);
  assert.equal(emitted.effect, 'REVIEW_POSTED', 'the mutant lets the fixture speak for the probe');
  assert.equal(emitted.credentialsRead, true);
  assert.throws(() => createSyntheticFixtureProbeAdapter(hostile), RunnerProbeError,
    'the shipped fixture contract has no such field, so the claim cannot be expressed');
});

test('MR6: dropping receipt-key equality answers this mandate with another one', async () => {
  const mutant = await importMutant('receipt-key-equality-removed', (source) => source.replace(
    'if (prior === null || prior.idempotencyKey !== context.idempotencyKey\n'
    + '        || prior.mandateDigest !== mandateDigest) {',
    'if (prior === null) {',
  ));
  const other = probe({ mandate: { mandateId: 'probe-0002' } }).receipt;
  assert.equal(other.outcome, 'CAPABILITY_OBSERVED');
  const input = buildInput({ priorReceipt: other });
  const mutated = mutant.probeProvider(input, countingAdapter());
  assert.notEqual(mutated.idempotencyKey, providerProbeIdempotencyKey({
    workKey: WORK_KEY(), generation: 7, provider: 'claude-code',
    capability: 'READ_ONLY_REVIEW', mandateId: 'probe-0001',
  }), 'the mutant settles this mandate with a receipt minted for a different one');
  assert.equal(probeProvider(input, countingAdapter()).blocker, 'RECEIPT_CONFLICT');
});

test('MR7: removing the admission table lets a research adapter be probed as a reviewer', async () => {
  const mutant = await importMutant('admission-table-removed', (source) => source.replace(
    'if (!identity.capabilities.includes(mandate.capability)\n'
    + '      || !PROVIDER_CAPABILITY_ADMISSION[mandate.provider].includes(mandate.capability)) {',
    'if (!identity.capabilities.includes(mandate.capability)) {',
  ));
  const over = {
    identity: { providers: ['notebooklm'], capabilities: ['READ_ONLY_REVIEW'] },
    mandate: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
    lease: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
  };
  const adapter = countingAdapter(fixture({ provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' }));
  assert.equal(mutant.probeProvider(buildInput(over), adapter).outcome, 'CAPABILITY_OBSERVED',
    'the mutant admits NotebookLM to a reviewing capability its row never granted');
  assert.equal(probeProvider(buildInput(over), adapter).blocker, 'CAPABILITY_NOT_ADMITTED');
});

test('MR8: dropping the fixed-width instant makes a year-275760 mandate look unexpired', async () => {
  const mutant = await importMutant('expanded-year-instant-admitted', (source) => source.replace(
    "  && value.length === INSTANT_LENGTH && value.endsWith('Z');",
    ';',
  ));
  const far = '+275760-09-13T00:00:00.000Z';
  assert.equal(new Date(far).toISOString(), far, 'this is an exact instant by round-trip');
  assert.ok(far < AT, 'and it sorts before every ordinary instant, which is the whole hazard');
  const input = buildInput({ observedAt: far });
  assert.equal(mutant.probeProvider(input, countingAdapter()).outcome, 'CAPABILITY_OBSERVED',
    'the mutant reads a mandate that expired 273734 years ago as still live');
  assert.throws(() => probeProvider(input, countingAdapter()), RunnerProbeError);
});

test('MR9: bounding a name by charset alone is what publishes a token as a server', async () => {
  const mutant = await importMutant('mcp-label-bound-widened', (source) => source.replace(
    'const MCP_SERVER_LABEL_PATH = /^[a-z][a-z0-9]{0,11}(?:[-._][a-z][a-z0-9]{0,11}){0,3}$/;',
    'const MCP_SERVER_LABEL_PATH = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;',
  ));
  const name = 'glpat-abcdefghijklmnop';
  const mutated = mutant.probeProvider({
    schema: PROVIDER_PROBE_INPUT_SCHEMA,
    observedAt: AT,
    identity: identity(),
    mandate: mandate({ declaredMcpServers: [name] }),
    lease: lease(),
    priorReceipt: null,
  }, sayingAdapter({ mcpServers: [name] }));
  assert.equal(mutated.outcome, 'CAPABILITY_OBSERVED');
  assert.deepEqual(mutated.mcpServers, [name],
    'the mutant echoes a credential-shaped identifier into a durable, content-addressed receipt');
  assert.throws(() => requireProviderProbeMandate(mandate({ declaredMcpServers: [name] })),
    RunnerProbeError, 'the shipped bound leaves it no representation to arrive in');
});

test('MR10: copying the source from the answer launders synthetic evidence as live', async () => {
  const mutant = await importMutant('observation-source-bind-removed', (source) => source
    .replace(
      '      || observation.capability !== mandate.capability\n'
      + '      || observation.observationSource !== observationSource) {',
      '      || observation.capability !== mandate.capability) {',
    )
    .replace(
      '    observationSource,\n    providerBlockers: observation.providerBlockers,',
      '    observationSource: observation.observationSource,\n'
      + '    providerBlockers: observation.providerBlockers,',
    ));
  const claimant = sayingAdapter({ observationSource: 'LIVE_PROVIDER' });
  const mutated = mutant.probeProvider(buildInput(), claimant);
  assert.equal(mutated.outcome, 'CAPABILITY_OBSERVED');
  assert.equal(mutated.observationSource, 'LIVE_PROVIDER',
    'the mutant publishes a synthetic-fixture reading as a live provider reading');
  assert.equal(probeProvider(buildInput(), claimant).blocker, 'OBSERVATION_MISBOUND');
});

test('MR11: the domain separator is load-bearing, which is why it is written as text', async () => {
  const mutant = await importMutant('domain-separator-dropped',
    (source) => source.replaceAll('\\0', ''));
  const key = {
    workKey: WORK_KEY(), generation: 7, provider: 'claude-code',
    capability: 'READ_ONLY_REVIEW', mandateId: 'probe-0001',
  };
  assert.notEqual(mutant.runnerWorkKey(identity()), runnerWorkKey(identity()),
    'losing the separator moves every work key, so a normalization pass that ate a raw NUL byte '
    + 'would silently re-address work that had already been published');
  assert.notEqual(mutant.providerProbeIdempotencyKey(key), providerProbeIdempotencyKey(key),
    'and every idempotency key, which is how one key comes to name two different receipts');
});

test('MR12: consulting the adapter first turns a refusal into a provider call', async () => {
  const mutant = await importMutant('adapter-consulted-first', (source) => source.replace(
    '  // 1-4: authority. Nothing below is reachable by an actor who no longer holds the runner.',
    '  providerAdapter.observe(Object.freeze({ schema: PROVIDER_PROBE_REQUEST_SCHEMA,'
    + ' provider: mandate.provider, capability: mandate.capability,'
    + ' corpusId: mandate.corpus.corpusId, promptCount: mandate.corpus.promptCount,'
    + ' budget: mandate.budget, declaredMcpServers: mandate.declaredMcpServers, mandateDigest }));',
  ));
  const cases = [
    [{ observedAt: LATER }, fixture()],
    [{
      identity: { capabilities: ['RESEARCH_CITATION'] },
      mandate: { capability: 'READ_ONLY_REVIEW' },
      lease: { capability: 'READ_ONLY_REVIEW' },
    }, fixture()],
    [{
      identity: { providers: ['notebooklm'], capabilities: ['READ_ONLY_REVIEW'] },
      mandate: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
      lease: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
    }, fixture({ provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' })],
  ];
  for (const [over, fixtureValue] of cases) {
    const leaky = countingAdapter(fixtureValue);
    assert.equal(mutant.probeProvider(buildInput(over), leaky).outcome, 'BLOCKED');
    assert.equal(leaky.calls.length, 1,
      'the mutant asks the provider the very question it is about to refuse to have asked');
    const shipped = countingAdapter(fixtureValue);
    assert.equal(probeProvider(buildInput(over), shipped).outcome, 'BLOCKED');
    assert.equal(shipped.calls.length, 0);
  }
});
