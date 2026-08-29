import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import {
  TELEMETRY_STEP_REPORT_SCHEMA,
  runFactoryTelemetryStepCli,
} from '../scripts/factory-telemetry-step.mjs';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-telemetry-step-cli-'));
test.after(() => rmSync(scratch, { recursive: true, force: true }));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function portfolioFile(directory, workItems) {
  const body = { schema: 'gaia-github-portfolio/1', policyRevision: 'policy-r0', workItems };
  const portfolio = {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
  const path = join(directory, 'portfolio.json');
  writeFileSync(path, `${JSON.stringify(portfolio, null, 2)}\n`, 'utf8');
  return path;
}

const WORK_ITEM = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemKind: 'ISSUE',
  itemId: 'issue-27',
  itemNumber: 27,
  title: 'Add the passive factory telemetry spine',
  state: 'READY',
  updatedAt: '2026-08-29T12:00:00.000Z',
});

let scratchCounter = 0;
function workspace() {
  scratchCounter += 1;
  const base = join(scratch, `run-${scratchCounter}`);
  return {
    base,
    ledgerDirectory: join(base, 'ledger'),
    telemetryDirectory: join(base, 'telemetry'),
  };
}

function clock(startedAt = '2026-08-29T18:00:00.000Z', stepMs = 1_000) {
  let tick = -1;
  return () => {
    tick += 1;
    return new Date(Date.parse(startedAt) + (tick * stepMs));
  };
}

test('one real local run moves, then expires, then settles in the control room', () => {
  const { base, ledgerDirectory, telemetryDirectory } = workspace();
  const portfolioPath = portfolioFile(scratch, [WORK_ITEM]);
  const outPath = join(scratch, 'telemetry-step.json');
  const lines = [];

  const report = runFactoryTelemetryStepCli([
    '--portfolio', portfolioPath,
    '--ledger-dir', ledgerDirectory,
    '--telemetry-dir', telemetryDirectory,
    '--item', 'issue-27',
    '--event', 'CLAIMED',
    '--lane', 'LANE_A',
    '--agent', 'CLAUDE_WORKER',
    '--run-id', 'run-27-tracer',
    '--out', outPath,
  ], { now: clock(), writeStdout: (chunk) => lines.push(chunk) });

  assert.equal(report.schema, TELEMETRY_STEP_REPORT_SCHEMA);
  assert.equal(report.step.outcome, 'TRANSITION_RECORDED');
  assert.equal(report.step.authority, 'NONE');
  assert.deepEqual(report.observations.map(({ phase }) => phase), [
    'HEARTBEAT_FRESH', 'HEARTBEAT_EXPIRED', 'RUN_SETTLED',
  ]);

  const [fresh, expired, settled] = report.observations;
  assert.equal(fresh.headline.state, 'ACTIVE');
  assert.equal(fresh.showSpinner, true);
  assert.equal(fresh.items[0].telemetry.runId, 'run-27-tracer');
  assert.equal(fresh.items[0].telemetry.heartbeatFresh, true);

  assert.equal(expired.headline.state, 'STALE');
  assert.equal(expired.showSpinner, false);
  assert.equal(expired.nextAction.kind, 'CHECK_STALE_RUN');
  assert.equal(expired.items[0].telemetry.heartbeatFresh, false);
  assert.ok(expired.blockers.some(({ state }) => state === 'TELEMETRY_HEARTBEAT_EXPIRED'));

  assert.equal(settled.headline.state, 'PAUSED');
  assert.equal(settled.showSpinner, false);
  assert.equal(settled.items[0].drainState, 'CLAIMED');
  assert.equal(settled.items[0].telemetry.runState, 'COMPLETED');
  assert.equal(settled.items[0].activity.state, 'IDLE');

  assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')), report);
  assert.match(lines.join(''), /TRANSITION_RECORDED \| QUEUED -> CLAIMED/u);
  assert.equal(base.length > 0, true);
});

test('the dashboard CLI projects the same durable spine into its shareable artifacts', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace();
  const portfolioPath = portfolioFile(scratch, [WORK_ITEM]);
  runFactoryTelemetryStepCli([
    '--portfolio', portfolioPath,
    '--ledger-dir', ledgerDirectory,
    '--telemetry-dir', telemetryDirectory,
    '--item', 'issue-27',
    '--event', 'CLAIMED',
    '--lane', 'LANE_A',
    '--agent', 'CLAUDE_WORKER',
    '--run-id', 'run-27-dashboard',
    '--out', join(scratch, 'dashboard-step.json'),
  ], { now: clock(), writeStdout: () => {} });

  const htmlPath = join(scratch, 'telemetry-control-room.html');
  const snapshotPath = join(scratch, 'telemetry-control-room.json');
  const snapshot = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--telemetry', telemetryDirectory,
    '--snapshot-out', snapshotPath,
    '--html-out', htmlPath,
  ], { now: () => new Date('2026-08-29T18:00:04.500Z'), writeStdout: () => {} });

  assert.equal(snapshot.telemetry.observedRuns, 1);
  assert.equal(snapshot.telemetry.projectionRevision.length, 64);
  assert.equal(snapshot.items[0].telemetry.runId, 'run-27-dashboard');
  assert.equal(snapshot.items[0].telemetry.runState, 'COMPLETED');
  assert.equal(snapshot.headline.state, 'PAUSED');
  const html = readFileSync(htmlPath, 'utf8');
  assert.match(html, /run-27-dashboard/u);
  assert.match(html, /Evidence age/u);
  assert.doesNotMatch(html, /class="heartbeat-pulse"/u);
});

test('NEGATIVE CONTROL: the dashboard refuses a spine recorded after the rendered instant', () => {
  const { ledgerDirectory, telemetryDirectory } = workspace();
  const portfolioPath = portfolioFile(scratch, [WORK_ITEM]);
  runFactoryTelemetryStepCli([
    '--portfolio', portfolioPath,
    '--ledger-dir', ledgerDirectory,
    '--telemetry-dir', telemetryDirectory,
    '--item', 'issue-27',
    '--event', 'CLAIMED',
    '--run-id', 'run-27-future',
    '--out', join(scratch, 'future-step.json'),
  ], { now: clock('2026-08-29T19:00:00.000Z'), writeStdout: () => {} });

  assert.throws(
    () => runFactoryDashboardCli([
      '--portfolio', portfolioPath,
      '--telemetry', telemetryDirectory,
      '--snapshot-out', join(scratch, 'future-control-room.json'),
      '--html-out', join(scratch, 'future-control-room.html'),
    ], { now: () => new Date('2026-08-29T18:30:00.000Z'), writeStdout: () => {} }),
    (error) => error?.code === 'TelemetryTimestampFuture',
  );
});

test('the step CLI refuses to alias its evidence logs or its report', () => {
  const { ledgerDirectory } = workspace();
  const portfolioPath = portfolioFile(scratch, [WORK_ITEM]);

  assert.throws(() => runFactoryTelemetryStepCli([
    '--portfolio', portfolioPath,
    '--ledger-dir', ledgerDirectory,
    '--telemetry-dir', ledgerDirectory,
    '--item', 'issue-27',
    '--event', 'CLAIMED',
    '--out', join(scratch, 'aliased.json'),
  ], { writeStdout: () => {} }), /must differ/u);

  assert.throws(() => runFactoryTelemetryStepCli([
    '--portfolio', portfolioPath,
    '--ledger-dir', ledgerDirectory,
    '--telemetry-dir', join(ledgerDirectory, 'spine'),
    '--item', 'issue-27',
    '--event', 'CLAIMED',
    '--out', join(ledgerDirectory, 'portfolio-drain.jsonl'),
  ], { writeStdout: () => {} }), /durable evidence log/u);

  assert.throws(() => runFactoryTelemetryStepCli([
    '--portfolio', portfolioPath,
    '--ledger-dir', ledgerDirectory,
    '--telemetry-dir', join(ledgerDirectory, 'spine'),
    '--item', 'issue-27',
    '--event', 'CLAIMED',
    '--out', join(scratch, 'ok.json'),
    '--unknown', 'value',
  ], { writeStdout: () => {} }), /unknown option/u);
});
