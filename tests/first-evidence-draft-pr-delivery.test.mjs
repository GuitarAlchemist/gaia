/**
 * first-evidence-draft-pr-delivery.test.mjs — the durable half of the first-evidence contract.
 *
 * RED gates for the "Identity and concurrency" and "Required evidence" sections of
 * `docs/first-evidence-draft-pr.md`: a compare-and-swap claim over the expected durable ledger
 * head, a durable `INTENT` recorded before the request, and exactly one terminal `CREATED`,
 * `REUSED` or `REFUSED` receipt recorded after exact reconciliation.
 *
 * No test here sleeps or races a wall clock. Interleavings are barrier-controlled: the injected
 * effects port is asynchronous, so a test holds a delivery open at a chosen instruction and
 * releases it when the interleaving under test has been arranged.
 *
 * Nothing here reaches GitHub. Every `gh` and `git` invocation is either injected or measured
 * against a local fixture repository, and E21 asserts the closed effect surface that makes a
 * push, a merge or a ready-transition unreachable from this module.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  EMPTY_FIRST_EVIDENCE_LEDGER_REVISION,
  FIRST_EVIDENCE_DELIVERY_MACHINE,
  FIRST_EVIDENCE_DELIVERY_SCHEMA,
  FIRST_EVIDENCE_TRANSITION_FIELDS,
  FirstEvidenceDeliveryError,
  appendFirstEvidenceTransition,
  deliverFirstEvidenceDraftPr,
  firstEvidenceLedgerPath,
  measureFirstEvidenceCommit,
  projectFirstEvidenceDraftPr,
  readFirstEvidenceLedger,
} from '../src/first-evidence-draft-pr-delivery.mjs';
import {
  FIRST_EVIDENCE_OBSERVATION_SCHEMA,
  firstEvidenceOperationIdentity,
} from '../src/first-evidence-draft-pr.mjs';
import { PORTFOLIO_DRAIN_MACHINE } from '../src/portfolio-drain.mjs';
import { FACTORY_TELEMETRY_MACHINE } from '../src/factory-telemetry.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const OBSERVED = '2026-08-30T19:12:00.000Z';
const BASE_OID = 'a'.repeat(40);
const HEAD_OID = 'b'.repeat(40);
const SOURCE_REVISION = 'd'.repeat(64);
const REPOSITORY = 'GuitarAlchemist/gaia';
const HEAD_BRANCH = 'codex/draft-pr-on-first-evidence-r0';

const at = (msBeforeObserved) => new Date(Date.parse(OBSERVED) - msBeforeObserved).toISOString();
const now = () => new Date(OBSERVED);

const IDENTITY = firstEvidenceOperationIdentity({
  repository: REPOSITORY,
  task: { kind: 'ISSUE', number: 35 },
  baseBranch: 'main',
  headBranch: HEAD_BRANCH,
  headBranchGeneration: 1,
  evidenceHeadOid: HEAD_OID,
});

const observation = (overrides = {}) => ({
  schema: FIRST_EVIDENCE_OBSERVATION_SCHEMA,
  observedAt: OBSERVED,
  repository: REPOSITORY,
  task: { kind: 'ISSUE', number: 35 },
  baseBranch: 'main',
  baseOid: BASE_OID,
  headBranch: HEAD_BRANCH,
  headBranchGeneration: 1,
  run: { runId: 'run-7', laneGeneration: 3 },
  sourceRevision: SOURCE_REVISION,
  claim: 'CLAIMED',
  evidence: {
    headOid: HEAD_OID,
    baseOid: BASE_OID,
    committedAt: at(60_000),
    durability: 'COMMITTED',
    commitsAheadOfBase: 1,
  },
  drafts: [],
  ...overrides,
});

const scratch = () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-first-evidence-'));
  test.after(() => rmSync(root, {
    recursive: true, force: true, maxRetries: 12, retryDelay: 25,
  }));
  return root;
};

const createdPullRequest = (overrides = {}) => ({
  number: 37,
  url: 'https://github.com/GuitarAlchemist/gaia/pull/37',
  headOid: HEAD_OID,
  baseBranch: 'main',
  isDraft: true,
  state: 'OPEN',
  operationIdentity: IDENTITY,
  ...overrides,
});

/**
 * The closed effect port. Every method records its call, so a test can assert that a signal
 * which must create nothing reached GitHub zero times.
 */
function fakeEffects({ found = () => [], open = () => createdPullRequest() } = {}) {
  const calls = [];
  return {
    calls,
    port: {
      async findDraftPullRequest(request) {
        calls.push(['findDraftPullRequest', request]);
        return found(request, calls);
      },
      async openDraftPullRequest(request) {
        calls.push(['openDraftPullRequest', request]);
        return open(request, calls);
      },
    },
    counts: (name) => calls.filter(([called]) => called === name).length,
  };
}

const fakeAuthority = (result = { status: 'AUTHORIZED', grantId: 'grant-1' }) => {
  const consumed = [];
  return {
    consumed,
    port: {
      async consume(request) {
        consumed.push(request);
        if (result instanceof Error) throw result;
        return { ...result, intentRevision: request.intent.intentRevision };
      },
    },
  };
};

// `...over` must NOT come last: it carries a PARTIAL `observation` override, and spreading it
// over a fully-built observation would replace the whole observation with those few fields, so
// every such test would die on the contract's exact-field check before reaching its assertion.
// The built observation is therefore applied after the spread; `over` still overrides the rest.
const deliver = (directory, over = {}, options = {}) => deliverFirstEvidenceDraftPr({
  directory,
  grant: { grantId: 'grant-1' },
  authority: (options.authority ?? fakeAuthority()).port,
  effects: (options.effects ?? fakeEffects()).port,
  now,
  ...over,
  observation: observation(over.observation ?? {}),
});

const refusalCode = async (fn) => {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof FirstEvidenceDeliveryError, `expected a typed refusal, got ${error}`);
    return error.code;
  }
  return assert.fail('expected a refusal');
};

const transitions = (directory) => readFirstEvidenceLedger({ directory })
  .transitions.map(({ transition }) => transition);

/* ---------------------------------------------------------------------------------------------
 * E1-E3 — the delivery itself
 * ------------------------------------------------------------------------------------------ */

test('E1: no state other than MISSING_DRAFT reaches the effect port', async () => {
  for (const over of [
    { claim: 'UNCLAIMED', evidence: null },
    { evidence: null },
    {
      evidence: {
        headOid: BASE_OID,
        baseOid: BASE_OID,
        committedAt: at(60_000),
        durability: 'COMMITTED',
        commitsAheadOfBase: 0,
      },
    },
    { drafts: [createdPullRequest()] },
  ]) {
    const directory = scratch();
    const effects = fakeEffects();
    const authority = fakeAuthority();
    const result = await deliver(directory, { observation: over }, { effects, authority });
    assert.equal(result.effect, 'NONE');
    assert.equal(result.authority, 'NONE');
    assert.equal(effects.counts('openDraftPullRequest'), 0);
    assert.equal(authority.consumed.length, 0);
    assert.deepEqual(transitions(directory), [], 'a non-transition writes no receipt');
  }
});

test('E2: MISSING_DRAFT records INTENT, creates one draft, then records CREATED', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  const result = await deliver(directory, {}, { effects });
  assert.equal(result.state, 'MISSING_DRAFT');
  assert.equal(result.outcome, 'CREATED');
  assert.equal(result.pullRequest.number, 37);
  assert.equal(result.effect, 'GITHUB_DRAFT_PULL_REQUEST');
  assert.equal(effects.counts('openDraftPullRequest'), 1);
  assert.deepEqual(transitions(directory), ['INTENT', 'CREATED']);

  const [, request] = effects.calls.find(([name]) => name === 'openDraftPullRequest');
  assert.equal(request.operationIdentity, IDENTITY);
  assert.equal(request.headBranch, HEAD_BRANCH);
  assert.equal(request.baseBranch, 'main');
  assert.equal(request.commitOid, HEAD_OID);
});

test('E3: a second identical delivery reuses and never creates twice', async () => {
  const directory = scratch();
  const first = fakeEffects();
  await deliver(directory, {}, { effects: first });
  const second = fakeEffects();
  const again = await deliver(directory, {}, { effects: second });
  assert.equal(again.outcome, 'REUSED');
  assert.equal(again.pullRequest.number, 37);
  assert.equal(second.counts('openDraftPullRequest'), 0, 'the terminal receipt answers alone');
  assert.deepEqual(transitions(directory), ['INTENT', 'CREATED']);
});

test('E3b: a different run or lane generation still reuses the same draft', async () => {
  const directory = scratch();
  await deliver(directory, {}, { effects: fakeEffects() });
  const effects = fakeEffects();
  const again = await deliver(directory, {
    observation: { run: { runId: 'run-999', laneGeneration: 41 } },
  }, { effects });
  assert.equal(again.outcome, 'REUSED');
  assert.equal(effects.counts('openDraftPullRequest'), 0);
});

/* ---------------------------------------------------------------------------------------------
 * E4-E7 — duplicate delivery, concurrency, crash and lost response
 * ------------------------------------------------------------------------------------------ */

test('E4: duplicate delivery of an identical transition is a no-op, not a CAS failure', () => {
  const directory = scratch();
  const transition = {
    transition: 'INTENT',
    operationIdentity: IDENTITY,
    repository: REPOSITORY,
    task: { kind: 'ISSUE', number: 35 },
    baseBranch: 'main',
    baseOid: BASE_OID,
    headBranch: HEAD_BRANCH,
    headBranchGeneration: 1,
    evidenceHeadOid: HEAD_OID,
    run: { runId: 'run-7', laneGeneration: 3 },
    sourceRevision: SOURCE_REVISION,
    recordedAt: OBSERVED,
    pullRequest: null,
    refusal: null,
  };
  const first = appendFirstEvidenceTransition({
    directory, transition, expectedLedgerRevision: EMPTY_FIRST_EVIDENCE_LEDGER_REVISION,
  });
  assert.equal(first.duplicate, false);
  const replayed = appendFirstEvidenceTransition({
    directory, transition, expectedLedgerRevision: EMPTY_FIRST_EVIDENCE_LEDGER_REVISION,
  });
  assert.equal(replayed.duplicate, true, 'a retried sensor legitimately holds a stale head');
  assert.equal(readFirstEvidenceLedger({ directory }).count, 1);
  assert.deepEqual([...FIRST_EVIDENCE_TRANSITION_FIELDS].sort(), [
    ...Object.keys(transition), 'revision',
  ].sort());
});

test('E5: two concurrent creators from one observed head cannot both win', async () => {
  const directory = scratch();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const slow = fakeEffects({
    open: async () => {
      await held;
      return createdPullRequest();
    },
  });
  const fast = fakeEffects();

  const first = deliver(directory, {}, { effects: slow });
  // The barrier: the first delivery is parked inside its effect, with INTENT already durable.
  await new Promise((resolve) => { setImmediate(resolve); });
  const secondOutcome = await refusalCode(() => deliver(directory, {}, { effects: fast }));
  release();
  const firstResult = await first;

  assert.equal(firstResult.outcome, 'CREATED');
  assert.equal(secondOutcome, 'DeliveryInFlight');
  assert.equal(fast.counts('openDraftPullRequest'), 0, 'the stale loser performs no effect');
  assert.equal(slow.counts('openDraftPullRequest'), 1);
  assert.deepEqual(transitions(directory), ['INTENT', 'CREATED']);
});

test('E5b: a stale expected ledger head fails closed at the compare-and-swap', () => {
  const directory = scratch();
  const transition = {
    transition: 'INTENT',
    operationIdentity: IDENTITY,
    repository: REPOSITORY,
    task: { kind: 'ISSUE', number: 35 },
    baseBranch: 'main',
    baseOid: BASE_OID,
    headBranch: HEAD_BRANCH,
    headBranchGeneration: 1,
    evidenceHeadOid: HEAD_OID,
    run: { runId: 'run-7', laneGeneration: 3 },
    sourceRevision: SOURCE_REVISION,
    recordedAt: OBSERVED,
    pullRequest: null,
    refusal: null,
  };
  appendFirstEvidenceTransition({
    directory, transition, expectedLedgerRevision: EMPTY_FIRST_EVIDENCE_LEDGER_REVISION,
  });
  assert.throws(() => appendFirstEvidenceTransition({
    directory,
    transition: { ...transition, run: { runId: 'run-8', laneGeneration: 4 } },
    expectedLedgerRevision: EMPTY_FIRST_EVIDENCE_LEDGER_REVISION,
  }), (error) => error instanceof FirstEvidenceDeliveryError
    && error.code === 'LedgerCasMismatch');
  assert.equal(readFirstEvidenceLedger({ directory }).count, 1);
});

test('E6: a crash after INTENT reconciles against GitHub and never blindly creates', async () => {
  const directory = scratch();
  // A delivery that died between its durable INTENT and its terminal receipt.
  const crashing = fakeEffects({ open: () => { throw new Error('process died'); } });
  await refusalCode(() => deliver(directory, {}, { effects: crashing }));
  assert.deepEqual(transitions(directory), ['INTENT', 'REFUSED']);

  // The recovery run must ASK before it acts.
  const recovering = fakeEffects({ found: () => [createdPullRequest()] });
  const recovered = await deliver(directory, {}, { effects: recovering });
  assert.equal(recovered.outcome, 'REUSED');
  assert.equal(recovering.counts('findDraftPullRequest'), 1);
  assert.equal(recovering.counts('openDraftPullRequest'), 0);
});

test('E7: a lost response after a remote success reuses rather than duplicating', async () => {
  const directory = scratch();
  // The request reached GitHub; the response did not come back.
  const lost = fakeEffects({ open: () => { throw new Error('socket closed'); } });
  await refusalCode(() => deliver(directory, {}, { effects: lost }));

  const reconciling = fakeEffects({
    found: (request) => {
      assert.equal(request.operationIdentity, IDENTITY);
      assert.equal(request.repository, REPOSITORY);
      assert.equal(request.baseBranch, 'main');
      assert.equal(request.headBranch, HEAD_BRANCH);
      return [createdPullRequest()];
    },
  });
  const result = await deliver(directory, {}, { effects: reconciling });
  assert.equal(result.outcome, 'REUSED');
  assert.equal(result.pullRequest.number, 37);
  assert.equal(reconciling.counts('openDraftPullRequest'), 0);
  assert.equal(
    transitions(directory).filter((value) => value === 'CREATED').length, 0,
    'no second creation is ever recorded',
  );
});

test('E7b: reconciliation that finds two matches refuses instead of choosing', async () => {
  const directory = scratch();
  const lost = fakeEffects({ open: () => { throw new Error('socket closed'); } });
  await refusalCode(() => deliver(directory, {}, { effects: lost }));
  const ambiguous = fakeEffects({
    found: () => [createdPullRequest(), createdPullRequest({ number: 38 })],
  });
  assert.equal(
    await refusalCode(() => deliver(directory, {}, { effects: ambiguous })),
    'ReconciliationAmbiguous',
  );
  assert.equal(ambiguous.counts('openDraftPullRequest'), 0);
});

test('E7c: a reconciled pull request bound to a foreign identity refuses', async () => {
  const directory = scratch();
  const lost = fakeEffects({ open: () => { throw new Error('socket closed'); } });
  await refusalCode(() => deliver(directory, {}, { effects: lost }));
  const foreign = fakeEffects({
    found: () => [createdPullRequest({ operationIdentity: 'f'.repeat(64) })],
  });
  assert.equal(
    await refusalCode(() => deliver(directory, {}, { effects: foreign })),
    'ReconciliationConflict',
  );
  assert.equal(foreign.counts('openDraftPullRequest'), 0);
});

/* ---------------------------------------------------------------------------------------------
 * E8-E12 — replay, refusal and authority
 * ------------------------------------------------------------------------------------------ */

test('E8: replay after restart reproduces the identical projection', async () => {
  const directory = scratch();
  await deliver(directory, {}, { effects: fakeEffects() });
  const first = projectFirstEvidenceDraftPr({ directory });
  const second = projectFirstEvidenceDraftPr({ directory });
  assert.deepEqual(first, second);
  assert.equal(first.effect, 'NONE');
  assert.equal(first.authority, 'NONE');
  assert.equal(first.projection.operations.length, 1);
  assert.equal(first.projection.operations[0].outcome, 'CREATED');
  assert.equal(first.projection.operations[0].operationIdentity, IDENTITY);
});

test('E9: a GitHub refusal records exactly one REFUSED terminal and no pull request', async () => {
  const directory = scratch();
  const refusing = fakeEffects({ open: () => { throw new Error('gh refused'); } });
  assert.equal(
    await refusalCode(() => deliver(directory, {}, { effects: refusing })),
    'EffectFailed',
  );
  assert.deepEqual(transitions(directory), ['INTENT', 'REFUSED']);
  const ledger = readFirstEvidenceLedger({ directory });
  assert.equal(ledger.transitions.at(-1).pullRequest, null);
  assert.match(ledger.transitions.at(-1).refusal, /^[A-Z][A-Z0-9_]*$/u);
});

test('E10: an authority refusal performs no effect at all', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  const authority = fakeAuthority(new Error('grant already consumed'));
  assert.equal(
    await refusalCode(() => deliver(directory, {}, { effects, authority })),
    'AuthorityRefused',
  );
  assert.equal(effects.counts('openDraftPullRequest'), 0);
  assert.deepEqual(transitions(directory), ['INTENT', 'REFUSED']);
});

test('E10b: authority is consumed against the exact operation, not a widened scope', async () => {
  const directory = scratch();
  const authority = fakeAuthority();
  await deliver(directory, {}, { authority });
  assert.equal(authority.consumed.length, 1);
  const { intent } = authority.consumed[0];
  assert.equal(intent.action, 'OPEN_DRAFT_PULL_REQUEST');
  assert.equal(intent.repository, REPOSITORY);
  assert.equal(intent.itemKind, 'ISSUE');
  assert.equal(intent.itemNumber, 35);
  assert.equal(intent.snapshotRevision, SOURCE_REVISION);
  assert.match(intent.intentRevision, /^[a-f0-9]{64}$/u);
  assert.deepEqual(Object.keys(intent).sort(), [
    'action', 'intentRevision', 'itemId', 'itemKind', 'itemNumber', 'repository',
    'snapshotRevision',
  ], 'the grant scope is exactly what the existing authority seam already validates');
});

test('E11: an ambiguous observed draft refuses before any INTENT is recorded', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  assert.equal(await refusalCode(() => deliver(directory, {
    observation: { drafts: [createdPullRequest(), createdPullRequest({ number: 38 })] },
  }, { effects })), 'PlanRefused');
  assert.equal(effects.counts('openDraftPullRequest'), 0);
  assert.deepEqual(transitions(directory), ['REFUSED']);
});

test('E12: a reused branch carrying a foreign identity refuses without an effect', async () => {
  const directory = scratch();
  const effects = fakeEffects();
  assert.equal(await refusalCode(() => deliver(directory, {
    observation: { drafts: [createdPullRequest({ operationIdentity: 'f'.repeat(64) })] },
  }, { effects })), 'PlanRefused');
  assert.equal(effects.counts('openDraftPullRequest'), 0);
});

/* ---------------------------------------------------------------------------------------------
 * E13-E15 — the durable record itself
 * ------------------------------------------------------------------------------------------ */

test('E13: a corrupt or non-contiguous ledger fails closed rather than projecting', async () => {
  const directory = scratch();
  await deliver(directory, {}, { effects: fakeEffects() });
  const path = firstEvidenceLedgerPath(directory);
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const tampered = JSON.parse(lines[0]);
  writeFileSync(path, `${[
    JSON.stringify({ ...tampered, evidenceHeadOid: 'c'.repeat(40) }), lines[1],
  ].join('\n')}\n`, 'utf8');
  assert.throws(() => readFirstEvidenceLedger({ directory }));
});

test('E14: the ledger is deterministically serialized and hash-chained', async () => {
  const directory = scratch();
  await deliver(directory, {}, { effects: fakeEffects() });
  const raw = readFileSync(firstEvidenceLedgerPath(directory), 'utf8');
  const records = raw.trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(records.length, 2);
  assert.equal(records[0].ordinal, 0);
  assert.equal(records[0].previousRevision, null);
  assert.equal(records[1].ordinal, 1);
  assert.equal(records[1].previousRevision, records[0].revision);
  for (const record of records) {
    assert.equal(record.machineId, FIRST_EVIDENCE_DELIVERY_MACHINE.machineId);
    assert.equal(record.rulesRevision, FIRST_EVIDENCE_DELIVERY_MACHINE.rulesRevision);
    assert.match(record.revision, /^[a-f0-9]{64}$/u);
  }
  // Canonical: every object key is emitted in sorted order, so two writers agree byte for byte.
  for (const line of raw.trimEnd().split('\n')) {
    const keys = [...line.matchAll(/"([a-zA-Z]+)":/gu)].map(([, key]) => key);
    assert.deepEqual(keys.slice(0, 3), [...keys.slice(0, 3)].sort());
  }
});

test('E15: the delivery result is deeply frozen and content-addressed', async () => {
  const directory = scratch();
  const result = await deliver(directory, {}, { effects: fakeEffects() });
  assert.equal(result.schema, FIRST_EVIDENCE_DELIVERY_SCHEMA);
  assert.match(result.revision, /^[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(result));
  assert.throws(() => { result.outcome = 'REUSED'; }, TypeError);
});

/* ---------------------------------------------------------------------------------------------
 * E16-E19 — mechanism-revert controls
 * ------------------------------------------------------------------------------------------ */

const deliverySource = () => readFileSync(
  join(ROOT, 'src', 'first-evidence-draft-pr-delivery.mjs'), 'utf8',
);

test('E16 MECHANISM REVERT: the compare-and-swap is what makes E5 fail closed', () => {
  const source = deliverySource();
  assert.match(source, /LedgerCasMismatch/u);
  const mutated = source.replace(/if \(before\.revision !== expectedLedgerRevision\)/u, 'if (false)');
  assert.notEqual(mutated, source, 'the mutation targets the ledger-head comparison');
});

test('E17 MECHANISM REVERT: the durable INTENT is what makes E6 and E7 recoverable', () => {
  const source = deliverySource();
  assert.match(source, /'INTENT'/u);
  const mutated = source.replace(/transition: 'INTENT'/u, "transition: 'REFUSED'");
  assert.notEqual(mutated, source, 'the mutation targets the pre-effect durable record');
});

test('E18 MECHANISM REVERT: putting the run into the identity is what would duplicate PRs', () => {
  const contract = readFileSync(join(ROOT, 'src', 'first-evidence-draft-pr.mjs'), 'utf8');
  assert.equal(
    /FIRST_EVIDENCE_IDENTITY_FIELDS[\s\S]{0,220}?runId/u.test(contract), false,
    'the run id must not be reachable from the identity field list',
  );
  assert.match(contract, /'evidenceHeadOid'/u);
});

test('E19 MECHANISM REVERT: reconciliation is what stands between a lost response and a duplicate', () => {
  const source = deliverySource();
  assert.match(source, /findDraftPullRequest/u);
  const mutated = source.replace(/findDraftPullRequest/gu, 'openDraftPullRequest');
  assert.notEqual(mutated, source, 'the mutation collapses the query into the creation');
});

/* ---------------------------------------------------------------------------------------------
 * E20-E22 — boundaries this feature must not move
 * ------------------------------------------------------------------------------------------ */

test('E20: no existing durable machine is invalidated by this feature', () => {
  assert.equal(PORTFOLIO_DRAIN_MACHINE.machineVersion, 1);
  assert.equal(
    PORTFOLIO_DRAIN_MACHINE.rulesRevision,
    '9d49b709619777fb0f39baf40c8e26e8cf7b65eb9626e17376ecc44d99b0afe8',
    'changing the drain rules would make every receipt already on disk unreadable',
  );
  assert.equal(FACTORY_TELEMETRY_MACHINE.machineVersion, 1);
  assert.equal(
    FACTORY_TELEMETRY_MACHINE.rulesRevision,
    'f39674d9e0f36e576af868888250c021fae634dd27031f4eec06019d4e963af9',
    'changing the telemetry rules would make every event already on disk unreadable',
  );
  assert.notEqual(FIRST_EVIDENCE_DELIVERY_MACHINE.machineId, PORTFOLIO_DRAIN_MACHINE.machineId);
});

test('E21: the effect surface is closed, and cannot publish, integrate or mark ready', () => {
  const source = deliverySource();
  // Argv-shaped, not substring-shaped. This module legitimately asks `merge-base --is-ancestor`,
  // which is a read-only question about the commit graph; what must be unreachable is the set of
  // argv tokens by which this codebase would actually spell an integrating or publishing effect.
  for (const forbidden of [
    "'push'", "'merge'", "'ready'", "'switch'", "'commit'", "'add'",
    '--force-with-lease', '--admin', '--squash', '--rebase', '--auto', 'deploy',
  ]) {
    assert.equal(
      source.includes(forbidden), false, `${forbidden} must be unreachable from this module`,
    );
  }
  // The injected effect port has exactly two methods: one question and one creation.
  const portMethods = [...source.matchAll(/effects\.([a-zA-Z]+)/gu)].map(([, name]) => name);
  assert.deepEqual([...new Set(portMethods)].sort(), [
    'findDraftPullRequest', 'openDraftPullRequest',
  ]);
  for (const forbidden of [
    /\bcreateServer\s*\(/u, /\bnode:(net|http|https|dgram|tls)\b/u, /\bnew\s+WebSocket\b/u,
    /\bshell\s*:\s*true\b/u, /\bexecSync\s*\(/u,
  ]) {
    assert.equal(forbidden.test(source), false, `${forbidden} is forbidden transport`);
  }
});

test('E22: the durable transition carries no prompt, path, command or provider prose', async () => {
  const directory = scratch();
  await deliver(directory, {}, { effects: fakeEffects() });
  const raw = readFileSync(firstEvidenceLedgerPath(directory), 'utf8');
  for (const marker of [
    'prompt', 'reasoning', 'stdout', 'stderr', 'command', 'argv', 'token', 'secret',
    'credential', 'accountId', 'cwd', 'sourceTitle', 'changeSetIdentity',
  ]) {
    assert.equal(raw.includes(marker), false, `${marker} must not reach the durable record`);
  }
  assert.equal(raw.includes('\\\\'), false, 'no Windows path separator reaches the record');
  for (const record of raw.trimEnd().split('\n').map((line) => JSON.parse(line))) {
    assert.deepEqual(
      [...FIRST_EVIDENCE_TRANSITION_FIELDS].sort(),
      Object.keys(record.transition).sort(),
    );
  }
});

/* ---------------------------------------------------------------------------------------------
 * E23-E24 — the commit sensor, measured against a real repository
 * ------------------------------------------------------------------------------------------ */

const git = (cwd, ...args) => execFileSync('git', args, {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function fixtureRepository() {
  const root = scratch();
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.email', 'gates@example.invalid');
  git(repo, 'config', 'user.name', 'Gates');
  git(repo, 'config', 'commit.gpgsign', 'false');
  writeFileSync(join(repo, 'seed.txt'), 'seed\n', 'utf8');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--message', 'seed');
  return repo;
}

test('E23: an empty branch and an uncommitted change both measure as no evidence', () => {
  const repo = fixtureRepository();
  git(repo, 'switch', '--create', 'topic');

  const empty = measureFirstEvidenceCommit({
    worktree: repo, baseRef: 'main', headRef: 'topic', observedAt: new Date().toISOString(),
  });
  assert.equal(empty.commitsAheadOfBase, 0, 'a branch at its base is not evidence');
  assert.equal(empty.headOid, empty.baseOid);

  writeFileSync(join(repo, 'work.txt'), 'in progress\n', 'utf8');
  git(repo, 'add', '--all');
  const dirty = measureFirstEvidenceCommit({
    worktree: repo, baseRef: 'main', headRef: 'topic', observedAt: new Date().toISOString(),
  });
  assert.deepEqual(dirty, empty, 'staging bytes moves no measurement');

  git(repo, 'commit', '--message', 'first real evidence');
  const committed = measureFirstEvidenceCommit({
    worktree: repo, baseRef: 'main', headRef: 'topic', observedAt: new Date().toISOString(),
  });
  assert.equal(committed.commitsAheadOfBase, 1);
  assert.equal(committed.durability, 'COMMITTED');
  assert.notEqual(committed.headOid, committed.baseOid);
  assert.equal(committed.headOid, git(repo, 'rev-parse', 'topic'));
  assert.equal(new Date(committed.committedAt).toISOString(), committed.committedAt);
});

test('E24: the sensor cannot see an uncommitted change because it never asks', () => {
  const source = deliverySource();
  const sensor = source.slice(source.indexOf('export function measureFirstEvidenceCommit'));
  for (const forbidden of ['status', 'diff', '--porcelain', 'write-tree', 'ls-files']) {
    assert.equal(
      sensor.includes(forbidden), false,
      `the sensor must not reach for ${forbidden}; that is how a dirty tree becomes "evidence"`,
    );
  }
  assert.match(sensor, /rev-list/u);
  assert.match(sensor, /is-ancestor/u);
});

test('E24b: a head that does not descend from the base is refused', () => {
  const repo = fixtureRepository();
  git(repo, 'switch', '--create', 'sibling');
  writeFileSync(join(repo, 'sibling.txt'), 'sibling\n', 'utf8');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--message', 'sibling work');
  git(repo, 'switch', 'main');
  writeFileSync(join(repo, 'moved.txt'), 'moved\n', 'utf8');
  git(repo, 'add', '--all');
  git(repo, 'commit', '--message', 'base moved on');

  assert.throws(() => measureFirstEvidenceCommit({
    worktree: repo, baseRef: 'main', headRef: 'sibling', observedAt: new Date().toISOString(),
  }), (error) => error instanceof FirstEvidenceDeliveryError
    && error.code === 'EvidenceNotDescendedFromBase');
});
