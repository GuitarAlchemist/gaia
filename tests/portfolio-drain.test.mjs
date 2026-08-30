import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  PORTFOLIO_DRAIN_MACHINE,
  PortfolioDrainError,
  buildPortfolioDrainReceipt,
  reconcilePortfolioDrain,
} from '../src/portfolio-drain.mjs';

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function portfolio(workItems, policyRevision = 'policy-a') {
  const body = {
    schema: 'gaia-github-portfolio/1',
    policyRevision,
    workItems,
  };
  return {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

const issue = (overrides = {}) => ({
  repository: 'GuitarAlchemist/ix',
  itemKind: 'ISSUE',
  itemId: 'issue-248',
  itemNumber: 248,
  title: 'Repair the SAE artifact contract',
  state: 'READY',
  updatedAt: '2026-08-29T12:00:00.000Z',
  ...overrides,
});

const pullRequest = (overrides = {}) => ({
  repository: 'GuitarAlchemist/ix',
  itemKind: 'PULL_REQUEST',
  itemId: 'pr-291',
  itemNumber: 291,
  title: 'Verify cached embedding model artifacts',
  state: 'READY',
  updatedAt: '2026-08-29T13:00:00.000Z',
  ...overrides,
});

const baseRevision = () => portfolio([issue()]).revision;

function rehashReceipt(receipt) {
  const { revision: _revision, ...body } = receipt;
  return {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
}

test('the machine definition is immutable and content-addresses its exact rules version', () => {
  assert.deepEqual(Object.keys(PORTFOLIO_DRAIN_MACHINE).sort(), [
    'machineId', 'machineVersion', 'rulesRevision',
  ]);
  assert.equal(PORTFOLIO_DRAIN_MACHINE.machineId, 'gaia.portfolio-drain');
  assert.equal(PORTFOLIO_DRAIN_MACHINE.machineVersion, 1);
  assert.match(PORTFOLIO_DRAIN_MACHINE.rulesRevision, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(PORTFOLIO_DRAIN_MACHINE), true);
});

test('the drain projection is deterministic and proposes at most one factory claim per repo', () => {
  const gaIssue = issue({
    repository: 'GuitarAlchemist/ga', itemId: 'issue-ga-1', itemNumber: 1,
  });
  const input = [pullRequest(), issue(), gaIssue];

  const observed = portfolio(input);
  const left = reconcilePortfolioDrain({ portfolio: observed, receipts: [], capacity: 4 });
  const right = reconcilePortfolioDrain({ portfolio: observed, receipts: [], capacity: 4 });

  assert.deepEqual(left, right);
  assert.equal(left.schema, 'gaia-portfolio-drain-projection/1');
  assert.deepEqual(left.decisions.map(({ action, repository, itemId }) => (
    { action, repository, itemId }
  )), [
    { action: 'CLAIM_FACTORY_RUN', repository: 'GuitarAlchemist/ga', itemId: 'issue-ga-1' },
    { action: 'CLAIM_FACTORY_RUN', repository: 'GuitarAlchemist/ix', itemId: 'issue-248' },
  ]);
  assert.equal(left.items.find(({ itemId }) => itemId === 'pr-291').drainState,
    'AWAITING_MERGE_AUTHORITY');
  assert.match(left.revision, /^[a-f0-9]{64}$/u);
});

test('tampering with a pinned portfolio is refused before the pump decides', () => {
  const observed = portfolio([issue()]);
  const tampered = structuredClone(observed);
  tampered.workItems[0].state = 'READY_WITH_UNKNOWN';

  assert.throws(
    () => reconcilePortfolioDrain({ portfolio: tampered, receipts: [] }),
    (error) => error instanceof PortfolioDrainError && error.code === 'PortfolioMismatch',
  );
});

test('source blockers remain named states and never enter the pump', () => {
  const cases = [
    ['READY_WITH_UNKNOWN', 'BLOCKED_UNKNOWN'],
    ['BLOCKED_DEPENDENCY', 'BLOCKED_DEPENDENCY'],
    ['AWAITING_HUMAN', 'BLOCKED_HUMAN'],
    ['DRAFT', 'BLOCKED_DRAFT'],
    ['CHECKS_UNKNOWN', 'BLOCKED_EVIDENCE'],
    ['REVIEW_UNKNOWN', 'BLOCKED_EVIDENCE'],
    ['CHECKS_AND_REVIEW_UNKNOWN', 'BLOCKED_EVIDENCE'],
    ['BLOCKED_REVIEW', 'BLOCKED_REVIEW'],
    ['DUPLICATE', 'TERMINAL_DUPLICATE'],
    ['ARCHIVED', 'TERMINAL_ARCHIVED'],
  ];
  const blocked = cases.map(([state], index) => issue({
    repository: `GuitarAlchemist/repo-${index}`,
    itemId: `issue-${index}`,
    itemNumber: index + 1,
    state,
  }));

  const projection = reconcilePortfolioDrain({ portfolio: portfolio(blocked), receipts: [] });

  assert.equal(projection.decisions.length, 0);
  for (const [state, expected] of cases) {
    assert.equal(projection.items.find(({ sourceState }) => sourceState === state).drainState,
      expected);
  }
});

test('a receipt chain advances one item while preserving the one-use authority failure', () => {
  const first = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(),
    item: issue(),
    previous: null,
    event: 'CLAIMED',
    evidenceRevision: 'b'.repeat(64),
  });
  const second = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(),
    item: issue(),
    previous: first,
    event: 'STARTED',
    evidenceRevision: 'c'.repeat(64),
  });
  const failed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(),
    item: issue(),
    previous: second,
    event: 'EXECUTION_FAILED',
    evidenceRevision: 'd'.repeat(64),
  });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([issue()]), receipts: [second, failed, first],
  });

  assert.equal(projection.items[0].drainState, 'FAILED_AUTHORITY_CONSUMED');
  assert.equal(projection.decisions.length, 0);
  assert.equal(Object.isFrozen(failed), true);
  assert.equal(failed.machineId, PORTFOLIO_DRAIN_MACHINE.machineId);
  assert.equal(failed.machineVersion, PORTFOLIO_DRAIN_MACHINE.machineVersion);
  assert.equal(failed.rulesRevision, PORTFOLIO_DRAIN_MACHINE.rulesRevision);
  assert.deepEqual(projection.machine, PORTFOLIO_DRAIN_MACHINE);
});

test('a receipt cannot be replayed under a different machine or rule revision', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const changedVersion = rehashReceipt({ ...claimed, machineVersion: 2 });
  const changedRules = rehashReceipt({ ...claimed, rulesRevision: 'a'.repeat(64) });

  for (const receipt of [changedVersion, changedRules]) {
    assert.throws(
      () => reconcilePortfolioDrain({ portfolio: portfolio([issue()]), receipts: [receipt] }),
      (error) => error instanceof PortfolioDrainError && error.code === 'MachineUnsupported',
    );
  }
});

test('a candidate receipt moves the pump to publication preparation without granting publication', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const started = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: claimed,
    event: 'STARTED', evidenceRevision: 'c'.repeat(64),
  });
  const ready = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: started,
    event: 'CANDIDATE_READY', evidenceRevision: 'd'.repeat(64),
  });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([issue()]), receipts: [claimed, started, ready],
  });

  assert.equal(projection.items[0].drainState, 'CANDIDATE_READY');
  assert.deepEqual(projection.decisions.map(({ action, effect, requiredAuthority }) => ({
    action, effect, requiredAuthority,
  })), [{
    action: 'PREPARE_PUBLICATION_INTENT', effect: 'NONE', requiredAuthority: 'NONE',
  }]);
});

test('a broken, duplicated, foreign or impossible receipt chain fails closed', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const started = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: claimed,
    event: 'STARTED', evidenceRevision: 'c'.repeat(64),
  });

  const cases = [
    [
      'duplicate', [claimed, claimed], 'ReceiptDuplicate',
    ],
    [
      'missing predecessor', [started], 'ReceiptChainBroken',
    ],
    [
      'impossible transition', [claimed, buildPortfolioDrainReceipt({
        portfolioRevision: baseRevision(), item: issue(), previous: claimed,
        event: 'MERGED', evidenceRevision: 'e'.repeat(64),
      })], 'TransitionInvalid',
    ],
  ];

  for (const [label, receipts, code] of cases) {
    assert.throws(
      () => reconcilePortfolioDrain({ portfolio: portfolio([issue()]), receipts }),
      (error) => error instanceof PortfolioDrainError && error.code === code,
      label,
    );
  }
});

test('a content-valid receipt that changes the bound item identity is refused', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const forgedObservation = { ...claimed, repository: 'GuitarAlchemist/ga' };
  const forged = rehashReceipt({
    ...forgedObservation,
    itemRevision: createHash('sha256').update(canonicalJson({
      repository: forgedObservation.repository,
      itemKind: forgedObservation.itemKind,
      itemId: forgedObservation.itemId,
      itemNumber: forgedObservation.itemNumber,
      title: forgedObservation.sourceTitle,
      state: forgedObservation.sourceState,
      updatedAt: forgedObservation.sourceUpdatedAt,
    })).digest('hex'),
  });

  assert.throws(
    () => reconcilePortfolioDrain({ portfolio: portfolio([issue()]), receipts: [forged] }),
    (error) => error instanceof PortfolioDrainError && error.code === 'ReceiptItemMismatch',
  );
});

test('persisted evidence identities and builder predecessors are independently validated', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const invalidEvidence = rehashReceipt({ ...claimed, evidenceRevision: 'not-a-digest' });
  const invalidPrevious = rehashReceipt({ ...claimed, evidenceRevision: 'also-invalid' });

  assert.throws(
    () => reconcilePortfolioDrain({
      portfolio: portfolio([issue()]), receipts: [invalidEvidence],
    }),
    (error) => error instanceof PortfolioDrainError && error.code === 'InvalidRequest',
  );
  assert.throws(
    () => buildPortfolioDrainReceipt({
      portfolioRevision: baseRevision(), item: issue(), previous: invalidPrevious,
      event: 'STARTED', evidenceRevision: 'c'.repeat(64),
    }),
    (error) => error instanceof PortfolioDrainError && error.code === 'InvalidRequest',
  );
});

test('unrelated portfolio revision changes do not erase an item receipt chain', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const started = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: claimed,
    event: 'STARTED', evidenceRevision: 'c'.repeat(64),
  });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([issue()], 'policy-f'), receipts: [started, claimed],
  });

  assert.equal(projection.items[0].drainState, 'RUNNING');
  assert.equal(projection.items[0].observedPortfolioRevision, baseRevision());
  assert.equal(projection.portfolioRevision, portfolio([issue()], 'policy-f').revision);
});

test('an item changed after a claim requires reconciliation rather than another lane', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const changed = issue({
    title: 'Repair the SAE artifact contract precisely',
    updatedAt: '2026-08-29T14:00:00.000Z',
  });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([changed], 'policy-f'), receipts: [claimed],
  });

  assert.equal(projection.items[0].drainState, 'RECONCILE_REQUIRED');
  assert.equal(projection.decisions.length, 0);
});

test('a changed terminal item is reconciled instead of trusting stale terminal evidence', () => {
  const events = ['CLAIMED', 'STARTED', 'CANDIDATE_READY', 'PUBLISHED', 'MERGED'];
  const receipts = [];
  for (const [index, event] of events.entries()) {
    receipts.push(buildPortfolioDrainReceipt({
      portfolioRevision: baseRevision(),
      item: issue(),
      previous: receipts.at(-1) ?? null,
      event,
      evidenceRevision: String(index + 1).repeat(64),
    }));
  }
  const changed = issue({ updatedAt: '2026-08-29T15:00:00.000Z' });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([changed]), receipts,
  });

  assert.equal(projection.items[0].drainState, 'RECONCILE_REQUIRED');
  assert.equal(projection.decisions.length, 0);
});

test('an item absent from the open-only snapshot is retained as unknown, not declared closed', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([], 'policy-f'), receipts: [claimed],
  });

  assert.equal(projection.items[0].itemId, 'issue-248');
  assert.equal(projection.items[0].sourceState, 'MISSING_FROM_OPEN_SNAPSHOT');
  assert.equal(projection.items[0].drainState, 'RECONCILE_REQUIRED');
  assert.equal(projection.decisions.length, 0);
});

test('the pump accounts for occupied lanes before proposing more work', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const other = issue({
    repository: 'GuitarAlchemist/ga', itemId: 'issue-ga-2', itemNumber: 2,
  });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([issue(), other]), receipts: [claimed], capacity: 1,
  });

  assert.equal(projection.counts.occupied, 1);
  assert.equal(projection.counts.available, 0);
  assert.equal(projection.decisions.length, 0);
});

test('an active repo excludes a second item from that repo even when global capacity remains', () => {
  const claimed = buildPortfolioDrainReceipt({
    portfolioRevision: baseRevision(), item: issue(), previous: null,
    event: 'CLAIMED', evidenceRevision: 'b'.repeat(64),
  });
  const secondIx = issue({ itemId: 'issue-244', itemNumber: 244 });
  const gaIssue = issue({
    repository: 'GuitarAlchemist/ga', itemId: 'issue-ga-2', itemNumber: 2,
  });

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([issue(), secondIx, gaIssue]), receipts: [claimed], capacity: 4,
  });

  assert.deepEqual(projection.decisions.map(({ itemId }) => itemId), ['issue-ga-2']);
});

test('an evidence-bound portfolio hold blocks but can never promote work', () => {
  const ready = issue();
  const human = issue({
    repository: 'GuitarAlchemist/ga', itemId: 'issue-ga-3', itemNumber: 3,
    state: 'AWAITING_HUMAN',
  });
  const hold = {
    itemId: ready.itemId,
    reason: 'READY_BUT_PORTFOLIO_BLOCKED',
    evidenceRevision: 'e'.repeat(64),
  };

  const projection = reconcilePortfolioDrain({
    portfolio: portfolio([ready, human]), receipts: [], holds: [hold],
  });

  const held = projection.items.find(({ itemId }) => itemId === ready.itemId);
  assert.equal(held.drainState, 'BLOCKED_POLICY');
  assert.deepEqual(held.hold, hold);
  assert.equal(projection.items.find(({ itemId }) => itemId === human.itemId).drainState,
    'BLOCKED_HUMAN');
  assert.equal(projection.decisions.length, 0);
});

test('duplicate, malformed and unknown portfolio holds fail closed', () => {
  const hold = {
    itemId: 'issue-248', reason: 'READY_BUT_PORTFOLIO_BLOCKED',
    evidenceRevision: 'e'.repeat(64),
  };
  const cases = [
    [[hold, hold], 'HoldDuplicate'],
    [[{ ...hold, reason: 'free prose is not a code' }], 'HoldInvalid'],
    [[{ ...hold, itemId: 'issue-missing' }], 'HoldItemUnknown'],
  ];
  for (const [holds, code] of cases) {
    assert.throws(
      () => reconcilePortfolioDrain({ portfolio: portfolio([issue()]), receipts: [], holds }),
      (error) => error instanceof PortfolioDrainError && error.code === code,
    );
  }
});
