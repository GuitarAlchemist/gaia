import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import test from 'node:test';

import {
  EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
  PORTFOLIO_DRAIN_LEDGER_RECORD_SCHEMA,
  PortfolioDrainLedgerError,
  appendPortfolioDrainReceipt,
  portfolioDrainLedgerPath,
  portfolioDrainLedgerLockPath,
  readPortfolioDrainLedger,
  tickPortfolioDrain,
} from '../src/portfolio-drain-ledger.mjs';
import {
  PORTFOLIO_DRAIN_MACHINE,
  buildPortfolioDrainReceipt,
} from '../src/portfolio-drain.mjs';
import { CorruptLogError } from '../src/event-log.mjs';

const ROOT = mkdtempSync(join(tmpdir(), 'gaia-portfolio-drain-ledger-test-'));
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function observedPortfolio(workItems) {
  const body = { schema: 'gaia-github-portfolio/1', policyRevision: 'policy-a', workItems };
  return { ...body, revision: sha256(canonicalJson(body)) };
}

const issue = () => ({
  repository: 'GuitarAlchemist/ix', itemKind: 'ISSUE', itemId: 'issue-248', itemNumber: 248,
  title: 'Repair the SAE artifact contract', state: 'READY',
  updatedAt: '2026-08-29T12:00:00.000Z',
});

function claimed(portfolio) {
  return buildPortfolioDrainReceipt({
    portfolioRevision: portfolio.revision,
    item: portfolio.workItems[0],
    previous: null,
    event: 'CLAIMED',
    evidenceRevision: 'b'.repeat(64),
  });
}

function dir(name) { return join(ROOT, name); }

/**
 * Build one durable ledger line exactly as the writer would, so a read-path gate
 * discriminates the mutation under test rather than a merely malformed file.
 *
 * Omitting `revision` re-hashes the mutated body, which is what makes a machine-binding or
 * chain-position mutant survive the record self-hash check and reach the gate it targets.
 */
function ledgerLine({
  receipt, ordinal = 0, previousRevision = null,
  machine = PORTFOLIO_DRAIN_MACHINE, revision,
}) {
  const body = {
    type: 'portfolio-drain.receipt',
    schema: PORTFOLIO_DRAIN_LEDGER_RECORD_SCHEMA,
    ...machine,
    ordinal,
    previousRevision,
    receipt,
  };
  return `${canonicalJson({ ...body, revision: revision ?? sha256(canonicalJson(body)) })}\n`;
}

function writtenLedger(name, line) {
  const directory = dir(name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(portfolioDrainLedgerPath(directory), line, 'utf8');
  return directory;
}

function assertSelfHashed(line) {
  const { revision, ...body } = JSON.parse(line);
  assert.equal(revision, sha256(canonicalJson(body)));
}

function corruptLogRefusal(reason) {
  return (error) => error instanceof CorruptLogError
    && error.code === 'GAIA_LOG_CORRUPT'
    && reason.test(error.message);
}

test.after(() => rmSync(ROOT, { recursive: true, force: true }));

test('reading an empty drain ledger is deterministic and creates nothing', () => {
  const directory = dir('empty');
  const left = readPortfolioDrainLedger({ directory });
  const right = readPortfolioDrainLedger({ directory });

  assert.deepEqual(left, right);
  assert.equal(left.revision, EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION);
  assert.equal(left.count, 0);
  assert.deepEqual(left.receipts, []);
  assert.equal(existsSync(directory), false);
});

test('one CAS append survives restart and stores one complete newline-terminated record', () => {
  const directory = dir('append');
  const portfolio = observedPortfolio([issue()]);
  const receipt = claimed(portfolio);

  const committed = appendPortfolioDrainReceipt({
    directory, portfolio, receipt,
    expectedLedgerRevision: EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
  });
  const restarted = readPortfolioDrainLedger({ directory });

  assert.deepEqual(restarted, committed);
  assert.equal(restarted.count, 1);
  assert.deepEqual(restarted.receipts, [receipt]);
  assert.match(restarted.revision, /^[a-f0-9]{64}$/u);
  const raw = readFileSync(portfolioDrainLedgerPath(directory), 'utf8');
  assert.ok(raw.endsWith('\n'));
  assert.equal(raw.split('\n').length - 1, 1);
});

test('a stale expected ledger revision refuses without writing', () => {
  const directory = dir('stale-cas');
  const portfolio = observedPortfolio([issue()]);
  const receipt = claimed(portfolio);
  const first = appendPortfolioDrainReceipt({
    directory, portfolio, receipt,
    expectedLedgerRevision: EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
  });
  const before = readFileSync(portfolioDrainLedgerPath(directory), 'utf8');

  assert.throws(
    () => appendPortfolioDrainReceipt({
      directory, portfolio, receipt,
      expectedLedgerRevision: EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
    }),
    (error) => error instanceof PortfolioDrainLedgerError && error.code === 'LedgerCasMismatch',
  );
  assert.equal(readFileSync(portfolioDrainLedgerPath(directory), 'utf8'), before);
  assert.equal(readPortfolioDrainLedger({ directory }).revision, first.revision);
});

test('a contended ledger lock fails closed and writes nothing', () => {
  const directory = dir('contended');
  const portfolio = observedPortfolio([issue()]);
  mkdirSync(portfolioDrainLedgerLockPath(directory), { recursive: true });

  assert.throws(
    () => appendPortfolioDrainReceipt({
      directory, portfolio, receipt: claimed(portfolio),
      expectedLedgerRevision: EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
      lockOptions: { timeoutMs: 50 },
    }),
    /refusing to access the ledger without its lock/u,
  );
  assert.equal(existsSync(portfolioDrainLedgerPath(directory)), false);
});

test('semantic transition validation happens before a receipt is persisted', () => {
  const directory = dir('semantic');
  const portfolio = observedPortfolio([issue()]);
  const impossible = buildPortfolioDrainReceipt({
    portfolioRevision: portfolio.revision, item: issue(), previous: null,
    event: 'MERGED', evidenceRevision: 'c'.repeat(64),
  });

  assert.throws(
    () => appendPortfolioDrainReceipt({
      directory, portfolio, receipt: impossible,
      expectedLedgerRevision: EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
    }),
    /cannot follow QUEUED/u,
  );
  assert.equal(existsSync(portfolioDrainLedgerPath(directory)), false);
});

test('receipt accessors and toJSON hooks are refused without execution', () => {
  const directory = dir('hostile-receipt');
  const portfolio = observedPortfolio([issue()]);
  const accessor = { ...claimed(portfolio) };
  let getterCalls = 0;
  Object.defineProperty(accessor, 'evidenceRevision', {
    enumerable: true,
    get() { getterCalls += 1; return 'b'.repeat(64); },
  });
  const serializer = { ...claimed(portfolio) };
  let serializerCalls = 0;
  Object.defineProperty(serializer, 'toJSON', {
    enumerable: false,
    value() { serializerCalls += 1; return {}; },
  });

  for (const receipt of [accessor, serializer]) {
    assert.throws(
      () => appendPortfolioDrainReceipt({
        directory, portfolio, receipt,
        expectedLedgerRevision: EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
      }),
      /closed enumerable data fields/u,
    );
  }
  assert.equal(getterCalls, 0);
  assert.equal(serializerCalls, 0);
  assert.equal(existsSync(portfolioDrainLedgerPath(directory)), false);
});

test('a changed observation cannot advance the durable chain', () => {
  const directory = dir('observation-drift');
  const portfolio = observedPortfolio([issue()]);
  const firstReceipt = claimed(portfolio);
  const first = appendPortfolioDrainReceipt({
    directory, portfolio, receipt: firstReceipt,
    expectedLedgerRevision: EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION,
  });
  const changedIssue = {
    ...issue(), title: 'Repair the SAE artifact contract precisely',
    updatedAt: '2026-08-29T14:00:00.000Z',
  };
  const changedPortfolio = observedPortfolio([changedIssue]);
  const started = buildPortfolioDrainReceipt({
    portfolioRevision: changedPortfolio.revision,
    item: changedIssue,
    previous: firstReceipt,
    event: 'STARTED',
    evidenceRevision: 'c'.repeat(64),
  });
  const before = readFileSync(portfolioDrainLedgerPath(directory), 'utf8');

  assert.throws(
    () => appendPortfolioDrainReceipt({
      directory, portfolio: changedPortfolio, receipt: started,
      expectedLedgerRevision: first.revision,
    }),
    (error) => error instanceof PortfolioDrainLedgerError
      && error.code === 'LedgerObservationDrift',
  );
  assert.equal(readFileSync(portfolioDrainLedgerPath(directory), 'utf8'), before);
});

test('a corrupt or torn ledger fails closed and is never repaired', () => {
  for (const [name, body] of [
    ['corrupt', '{"type":"portfolio-drain.receipt", nope}\n'],
    ['torn', '{"type":"portfolio-drain.receipt"'],
  ]) {
    const directory = dir(name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(portfolioDrainLedgerPath(directory), body, 'utf8');

    assert.throws(() => readPortfolioDrainLedger({ directory }));
    assert.equal(readFileSync(portfolioDrainLedgerPath(directory), 'utf8'), body);
  }
});

test('a hand-written well-formed ledger record is read back unchanged', () => {
  const portfolio = observedPortfolio([issue()]);
  const receipt = claimed(portfolio);
  const line = ledgerLine({ receipt });
  const directory = writtenLedger('read-control', line);

  const ledger = readPortfolioDrainLedger({ directory });

  assert.equal(ledger.count, 1);
  assert.deepEqual(ledger.receipts, [receipt]);
  assert.equal(ledger.revision, JSON.parse(line).revision);
  assert.equal(readFileSync(portfolioDrainLedgerPath(directory), 'utf8'), line);
});

test('a ledger record whose revision does not match its body is refused on read', () => {
  const portfolio = observedPortfolio([issue()]);
  const receipt = claimed(portfolio);
  const honest = JSON.parse(ledgerLine({ receipt }));
  // Swap the evidence the receipt points at and keep the record's original revision.
  const line = `${canonicalJson({
    ...honest, receipt: { ...receipt, evidenceRevision: 'd'.repeat(64) },
  })}\n`;
  const directory = writtenLedger('read-forged-body', line);

  assert.throws(
    () => readPortfolioDrainLedger({ directory }),
    corruptLogRefusal(/record revision does not match its content/u),
  );
  assert.equal(readFileSync(portfolioDrainLedgerPath(directory), 'utf8'), line);
});

test('a rehashed ledger record bound to another machine is refused on read', () => {
  const portfolio = observedPortfolio([issue()]);
  const receipt = claimed(portfolio);

  for (const [name, machine] of [
    ['read-machine-version', { ...PORTFOLIO_DRAIN_MACHINE, machineVersion: 2 }],
    ['read-rules-revision', { ...PORTFOLIO_DRAIN_MACHINE, rulesRevision: 'e'.repeat(64) }],
  ]) {
    const line = ledgerLine({ receipt, machine });
    assertSelfHashed(line);
    const directory = writtenLedger(name, line);

    assert.throws(
      () => readPortfolioDrainLedger({ directory }),
      corruptLogRefusal(/binds an unsupported machine/u),
    );
    assert.equal(readFileSync(portfolioDrainLedgerPath(directory), 'utf8'), line);
  }
});

test('a rehashed ledger record at a broken chain position is refused on read', () => {
  const portfolio = observedPortfolio([issue()]);
  const receipt = claimed(portfolio);

  for (const [name, position] of [
    ['read-ordinal-gap', { ordinal: 1, previousRevision: null }],
    ['read-forged-previous', { ordinal: 0, previousRevision: 'a'.repeat(64) }],
  ]) {
    const line = ledgerLine({ receipt, ...position });
    assertSelfHashed(line);
    const directory = writtenLedger(name, line);

    assert.throws(
      () => readPortfolioDrainLedger({ directory }),
      corruptLogRefusal(/chain is not contiguous/u),
    );
    assert.equal(readFileSync(portfolioDrainLedgerPath(directory), 'utf8'), line);
  }
});

test('tick is a read-only idempotent composition root over the exact ledger head', () => {
  const directory = dir('tick');
  const portfolio = observedPortfolio([issue()]);
  const before = tickPortfolioDrain({ directory, portfolio, holds: [], capacity: 4 });
  const repeated = tickPortfolioDrain({ directory, portfolio, holds: [], capacity: 4 });

  assert.deepEqual(repeated, before);
  assert.equal(before.ledgerRevision, EMPTY_PORTFOLIO_DRAIN_LEDGER_REVISION);
  assert.equal(before.projection.decisions[0].action, 'CLAIM_FACTORY_RUN');
  assert.equal(before.projection.decisions[0].effect, 'NONE');
  assert.equal(existsSync(directory), false);
});
