import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { BUS_VERBS } from '../src/bus-core.mjs';
import {
  ENGINEERING_PUMP_OBSERVATION_SCHEMA,
  projectEngineeringPumpChecklist,
  projectEngineeringPumpTransitions,
  runEngineeringPumpSupervisorTick,
  sealEngineeringPumpObservation,
} from '../src/engineering-pump-supervisor.mjs';
import { synchronizeEngineeringPumpDuckDb } from '../src/duckdb-engineering-pump-supervisor.mjs';
import { readFirstEvidenceLedger } from '../src/first-evidence-draft-pr-delivery.mjs';
import { FIRST_EVIDENCE_OBSERVATION_SCHEMA } from '../src/first-evidence-draft-pr.mjs';
import { readPortfolioDrainLedger } from '../src/portfolio-drain-ledger.mjs';

const AT = '2026-08-31T18:00:00.000Z';
const LATER = '2026-08-31T18:03:00.000Z';
const POLICY = 'a'.repeat(64);
const SOURCE = 'b'.repeat(64);
const SUBJECT = 'c'.repeat(64);
const OWNER_A = '1'.repeat(32);
const OWNER_B = '2'.repeat(32);
const BASE = '0'.repeat(40);

const scratch = () => mkdtempSync(join(tmpdir(), 'gaia-engineering-pump-r0-'));
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};
const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function portfolio(items) {
  const body = { schema: 'gaia-github-portfolio/1', policyRevision: 'policy-a', workItems: items };
  return { ...body, revision: sha256(body) };
}

function item(number, overrides = {}) {
  return {
    repository: 'GuitarAlchemist/gaia', itemKind: 'ISSUE', itemId: `issue-${number}`,
    itemNumber: number, title: `Deliver pump slice ${number}`, state: 'READY', updatedAt: AT,
    ...overrides,
  };
}

function draftObservation(number, subjectRevision = SUBJECT, overrides = {}) {
  const head = String(number).padStart(40, '0');
  return {
    schema: FIRST_EVIDENCE_OBSERVATION_SCHEMA,
    observedAt: AT,
    repository: 'GuitarAlchemist/gaia',
    task: { kind: 'ISSUE', number },
    baseBranch: 'main', baseOid: BASE, headBranch: 'codex/shared-pump-branch',
    headBranchGeneration: 1,
    run: { runId: `pump-${number}`, laneGeneration: 1 },
    sourceRevision: subjectRevision,
    claim: 'CLAIMED',
    evidence: {
      headOid: head, baseOid: BASE, committedAt: AT,
      durability: 'COMMITTED', commitsAheadOfBase: 1,
    },
    drafts: [],
    ...overrides,
  };
}

function observation({ items = [item(40)], subjects, capacity, ...overrides } = {}) {
  return sealEngineeringPumpObservation({
    schema: ENGINEERING_PUMP_OBSERVATION_SCHEMA,
    observedAt: AT,
    repository: 'GuitarAlchemist/gaia',
    policyRevision: POLICY,
    sourceRevision: SOURCE,
    capacity: capacity ?? { writerSlots: 1, providerSlots: 1, ciSlots: 1 },
    portfolio: portfolio(items),
    subjects: subjects ?? items.map(({ itemId, itemNumber }) => ({
      readyItemId: itemId,
      subjectRevision: SUBJECT,
      draftObservation: draftObservation(itemNumber),
    })),
    ...overrides,
  });
}

const draft = (operationIdentity, number = 45) => ({
  number, url: `https://github.com/GuitarAlchemist/gaia/pull/${number}`,
  headOid: '0000000000000000000000000000000000000040', baseBranch: 'main',
  state: 'OPEN', isDraft: true, operationIdentity,
});

function effects({ found = async () => [], open } = {}) {
  const calls = [];
  return {
    calls,
    async findDraftPullRequest(request) {
      calls.push(['findDraftPullRequest', request]);
      return found(request);
    },
    async openDraftPullRequest(request) {
      calls.push(['openDraftPullRequest', request]);
      return (open ?? (async (value) => draft(value.operationIdentity)))(request);
    },
  };
}

function authority(result = { status: 'AUTHORIZED', grantId: 'grant-r0' }) {
  const calls = [];
  return {
    calls,
    async consume(request) {
      calls.push(request);
      if (result instanceof Error) throw result;
      return result;
    },
  };
}

async function tick(directory, supplied = {}) {
  return runEngineeringPumpSupervisorTick({
    directory,
    observation: supplied.observation ?? observation(),
    grant: supplied.grant ?? { grantId: 'grant-r0' },
    authority: supplied.authority ?? authority(),
    effects: supplied.effects ?? effects(),
    owner: supplied.owner ?? OWNER_A,
    now: () => new Date(supplied.now ?? AT),
    leaseMs: supplied.leaseMs ?? 120_000,
  });
}

test('R0 public seam: one drain claim delegates START_DRAFT to the existing delivery machine', async () => {
  const directory = scratch();
  const result = await tick(directory);
  assert.equal(result.gate.state, 'READY');
  assert.equal(result.gate.nextAction.kind, 'START_DRAFT');
  assert.equal(result.gate.nextAction.readyItemId, 'issue-40');
  assert.equal(result.delivery.outcome, 'CREATED');
  assert.deepEqual(readPortfolioDrainLedger({ directory }).receipts.map((x) => x.event), ['CLAIMED']);
  assert.deepEqual(readFirstEvidenceLedger({ directory }).transitions.map((x) => x.transition),
    ['INTENT', 'CREATED']);
  assert.equal(result.checklist.origin, 'GAIA PUMP');
  assert.equal(result.checklist.currentGate, 'DRAFT_OPEN');
});

test('R0 simultaneous refill has one durable target/capacity reservation and one effect', async () => {
  const directory = scratch();
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let reached;
  const firstReached = new Promise((resolve) => { reached = resolve; });
  let opens = 0;
  const firstAuthority = authority();
  firstAuthority.consume = async (request) => {
    firstAuthority.calls.push(request); reached(); await blocked;
    return { status: 'AUTHORIZED', grantId: 'grant-r0' };
  };
  const first = tick(directory, {
    authority: firstAuthority,
    effects: effects({ open: async (intent) => { opens += 1; return draft(intent.operationIdentity); } }),
  });
  await firstReached;
  await assert.rejects(tick(directory, { owner: OWNER_B }),
    (error) => error.code === 'DeliveryInFlight');
  release();
  await first;
  assert.equal(opens, 1);
  assert.deepEqual(readPortfolioDrainLedger({ directory }).receipts.map((x) => x.itemId), ['issue-40']);
});

test('R0 capacity=1 never reserves a second item on the same repository and branch', async () => {
  const directory = scratch();
  const observed = observation({ items: [item(40), item(41)] });
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  let reached;
  const firstReached = new Promise((resolve) => { reached = resolve; });
  const slowAuthority = authority();
  slowAuthority.consume = async (request) => {
    slowAuthority.calls.push(request); reached(); await blocked;
    return { status: 'AUTHORIZED', grantId: 'grant-r0' };
  };
  const first = tick(directory, { observation: observed, authority: slowAuthority });
  await firstReached;
  await assert.rejects(tick(directory, { observation: observed, owner: OWNER_B }),
    (error) => error.code === 'DeliveryInFlight');
  release(); await first;
  const claims = readPortfolioDrainLedger({ directory }).receipts;
  assert.equal(claims.length, 1);
  assert.equal(claims[0].itemId, 'issue-40');
});

test('R0 duplicate, delayed and replayed observations converge through the existing receipt', async () => {
  const directory = scratch();
  const port = effects();
  const first = await tick(directory, { effects: port });
  const replay = await tick(directory, { effects: port, owner: OWNER_B });
  assert.equal(replay.delivery.operationIdentity, first.delivery.operationIdentity);
  assert.equal(replay.delivery.outcome, 'REUSED');
  assert.equal(port.calls.filter(([name]) => name === 'openDraftPullRequest').length, 1);
});

test('R0 lost GitHub response is reconciled by stable provider marker before retry', async () => {
  const directory = scratch();
  let remote = null;
  let opens = 0;
  const lost = effects({ open: async (intent) => {
    opens += 1; remote = draft(intent.operationIdentity); throw new Error('response lost');
  } });
  await assert.rejects(tick(directory, { effects: lost }), (error) => error.code === 'EffectFailed');
  const recovery = effects({
    found: async () => [remote],
    open: async () => { opens += 1; throw new Error('blind retry'); },
  });
  const adopted = await tick(directory, { effects: recovery, owner: OWNER_B, now: LATER });
  assert.equal(adopted.delivery.outcome, 'REUSED');
  assert.equal(opens, 1);
  assert.deepEqual(recovery.calls.map(([name]) => name), ['findDraftPullRequest']);
});

test('R0 restart after grant consumption fails closed without a duplicate effect', async () => {
  const directory = scratch();
  let consumed = 0;
  const consuming = authority();
  consuming.consume = async (request) => {
    consuming.calls.push(request); consumed += 1;
    return { status: 'AUTHORIZED', grantId: 'grant-r0' };
  };
  await assert.rejects(tick(directory, {
    authority: consuming,
    effects: effects({ open: async () => { throw new Error('crash after consume'); } }),
  }), (error) => error.code === 'EffectFailed');
  const used = authority(Object.assign(new Error('grant consumed'), { code: 'GrantConsumed' }));
  const retryPort = effects({ found: async () => [] });
  await assert.rejects(tick(directory, {
    authority: used, effects: retryPort, owner: OWNER_B, now: LATER,
  }), (error) => error.code === 'AuthorityRefused');
  assert.equal(consumed, 1);
  assert.equal(retryPort.calls.filter(([name]) => name === 'openDraftPullRequest').length, 0);
});

test('R0 stale, future, corrupt and mismatched observations refuse before durable claims', async () => {
  const valid = observation();
  for (const [label, supplied, code] of [
    ['stale', observation({ observedAt: '2026-08-31T17:00:00.000Z' }), 'ObservationStale'],
    ['future', observation({ observedAt: '2026-08-31T18:01:00.000Z' }), 'ObservationFromFuture'],
    ['corrupt', { ...valid, sourceRevision: 'd'.repeat(64) }, 'ObservationRevisionMismatch'],
    ['mismatch', observation({ subjects: [{
      readyItemId: 'issue-99', subjectRevision: SUBJECT, draftObservation: draftObservation(40),
    }] }), 'ObservationSubjectMismatch'],
  ]) {
    const directory = scratch();
    await assert.rejects(tick(directory, { observation: supplied }),
      (error) => error.code === code, label);
    assert.equal(readPortfolioDrainLedger({ directory }).count, 0, label);
    assert.equal(readFirstEvidenceLedger({ directory }).count, 0, label);
  }
});

test('R0 stale, mismatched and consumed grants are refused by the existing authority seam', async () => {
  for (const code of ['GrantExpired', 'GrantScopeMismatch', 'GrantConsumed']) {
    const directory = scratch();
    const rejected = authority(Object.assign(new Error(code), { code }));
    await assert.rejects(tick(directory, { authority: rejected }),
      (error) => error.code === 'AuthorityRefused');
    assert.equal(rejected.calls[0].intent.action, 'OPEN_DRAFT_PULL_REQUEST');
    assert.equal(readFirstEvidenceLedger({ directory }).transitions.at(-1).transition, 'REFUSED');
  }
});

test('R0 provider and CI saturation are explicit effect-free gates', async () => {
  for (const [capacity, state] of [
    [{ writerSlots: 1, providerSlots: 0, ciSlots: 1 }, 'PROVIDER_SATURATED'],
    [{ writerSlots: 1, providerSlots: 1, ciSlots: 0 }, 'CI_SATURATED'],
    [{ writerSlots: 0, providerSlots: 1, ciSlots: 1 }, 'CAPACITY_FULL'],
  ]) {
    const directory = scratch();
    const result = await tick(directory, { observation: observation({ capacity }) });
    assert.equal(result.gate.state, state);
    assert.equal(result.gate.nextAction.kind, 'NONE');
    assert.equal(readPortfolioDrainLedger({ directory }).count, 0);
  }
});

test('R0 EXPECTED_NONE is healthy idle', async () => {
  const result = await tick(scratch(), { observation: observation({ items: [] }) });
  assert.equal(result.gate.state, 'EXPECTED_NONE');
  assert.equal(result.gate.nextAction.kind, 'NONE');
  assert.equal(result.delivery, null);
});

test('R0 checklist is bounded, self-sufficient, and has one managed status comment', async () => {
  const directory = scratch();
  await tick(directory);
  const projected = projectEngineeringPumpChecklist({ directory });
  assert.deepEqual(Object.keys(projected.issueBody), [
    'outcome', 'owner', 'reportsTo', 'scope', 'exclusions', 'plan', 'deliverables',
    'doneWhen', 'authorityBoundary', 'evidenceLinks',
  ]);
  assert.match(projected.statusComment, /<!-- gaia:pump-status:/u);
  assert.match(projected.statusComment, /Origin: GAIA PUMP/u);
  assert.equal((projected.statusComment.match(/^Next:/gmu) ?? []).length, 1);
  assert.match(projected.statusComment, /ETA: UNKNOWN \(low confidence\)/u);
  assert.match(projected.statusComment, /- \[x\] Observe/u);
  assert.ok(projected.statusComment.length <= 1200);
  assert.equal(projected.revision, projectEngineeringPumpChecklist({ directory }).revision);
});

test('R0 deterministic replay and DuckDB derive only from the two existing ledgers', async () => {
  const directory = scratch();
  await tick(directory);
  const first = projectEngineeringPumpTransitions({ directory });
  assert.deepEqual(projectEngineeringPumpTransitions({ directory }), first);
  assert.deepEqual(Object.keys(first.sourceRevisions).sort(), ['draftDelivery', 'portfolioDrain']);
  const calls = [];
  const openClient = async () => ({
    run: async (sql, params = []) => { calls.push([sql, params]); }, close() {},
  });
  const left = await synchronizeEngineeringPumpDuckDb({
    directory, databasePath: join(directory, 'pump.duckdb'), openClient,
  });
  const bytes = JSON.stringify(calls); calls.length = 0;
  const right = await synchronizeEngineeringPumpDuckDb({
    directory, databasePath: join(directory, 'pump.duckdb'), openClient,
  });
  assert.deepEqual(right, left);
  assert.equal(JSON.stringify(calls), bytes);
  assert.equal(left.authority, 'NONE');
});

test('R0 MECHANISM REVERT: existing machines own reservation, intent and reconciliation', () => {
  const source = readFileSync(new URL('../src/engineering-pump-supervisor.mjs', import.meta.url), 'utf8');
  assert.match(source, /deliverFirstEvidenceDraftPr/u);
  assert.match(source, /appendPortfolioDrainReceipt/u);
  for (const forbidden of [
    'engineering-pump.jsonl', 'ENGINEERING_PUMP_LEDGER', 'openDraftPullRequest({',
  ]) assert.equal(source.includes(forbidden), false, forbidden);
});

test('R0 preserves the six unprivileged bus verbs', () => {
  assert.deepEqual([...BUS_VERBS], [
    'register', 'send', 'inbox', 'ack', 'heartbeat', 'handoff',
  ]);
});
