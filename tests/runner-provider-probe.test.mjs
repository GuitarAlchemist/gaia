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
    calls,
    observe(request) {
      calls.push(request);
      return inner.observe(request);
    },
  };
}

/** Probe with the shipped fixture adapter, overriding one part of the input at a time. */
function probe(over = {}) {
  const adapter = over.adapter ?? countingAdapter(fixture(over.fixture));
  const input = {
    schema: PROVIDER_PROBE_INPUT_SCHEMA,
    observedAt: over.observedAt ?? AT,
    identity: identity(over.identity),
    mandate: mandate(over.mandate),
    lease: over.lease === null ? null : lease(over.lease),
    priorReceipt: over.priorReceipt ?? null,
    ...over.input,
  };
  return { receipt: probeProvider(input, adapter), adapter, input };
}

const blockedWith = (code, over = {}) => {
  const { receipt, adapter } = probe(over);
  assert.equal(receipt.outcome, 'BLOCKED', `expected ${code}, got ${canonicalJson(receipt)}`);
  assert.equal(receipt.blocker, code);
  assert.equal(receipt.effect, 'NONE');
  assert.equal(receipt.authority, 'NONE');
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
  const { adapter } = blockedWith('RUNNER_MISDELIVERY', {
    mandate: { runnerWorkKey: runnerWorkKey(identity({ runnerId: 'gaia-win-runner-02' })) },
  });
  assert.equal(adapter.calls.length, 0, 'the provider was never consulted');
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
  assert.equal(probe({ observedAt: LATER }).receipt.blocker, 'MANDATE_EXPIRED');
  assert.equal(probe({ observedAt: '2026-09-02T00:00:00.000Z' }).receipt.blocker, 'MANDATE_EXPIRED');
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
  assert.equal(probe({
    identity: { capabilities: ['RESEARCH_CITATION'] },
    mandate: { capability: 'READ_ONLY_REVIEW' },
    lease: { capability: 'READ_ONLY_REVIEW' },
  }).receipt.blocker, 'CAPABILITY_NOT_ADMITTED');
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
  const { receipt } = probe({
    identity: { providers: ['notebooklm'], capabilities: ['READ_ONLY_REVIEW'] },
    mandate: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
    lease: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
    fixture: { provider: 'notebooklm', capability: 'READ_ONLY_REVIEW' },
  });
  assert.equal(receipt.blocker, 'CAPABILITY_NOT_ADMITTED',
    'the refusal is the shared table, not a NotebookLM branch');
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
  const adapter = { schema: PROVIDER_PROBE_ADAPTER_SCHEMA, observe() { throw new Error('called'); } };
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
  const adapter = { schema: PROVIDER_PROBE_ADAPTER_SCHEMA, observe() { throw new Error('called'); } };
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
    }, { schema: PROVIDER_PROBE_ADAPTER_SCHEMA, observe });
    assert.equal(receipt.blocker, 'PROVIDER_ADAPTER_FAILED');
    assert.equal(receipt.availability, 'UNKNOWN', 'a failed probe knows nothing, it does not guess');
  }
});

/** Answer with an arbitrary observation body, to test what the probe does with a hostile provider. */
function sayingAdapter(overrides) {
  return {
    schema: PROVIDER_PROBE_ADAPTER_SCHEMA,
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
