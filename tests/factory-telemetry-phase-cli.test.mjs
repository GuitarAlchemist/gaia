import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  TELEMETRY_PHASE_REPORT_SCHEMA,
  runFactoryTelemetryPhaseCli,
} from '../scripts/factory-telemetry-phase.mjs';
import {
  factoryTelemetryLogPath,
  readFactoryTelemetryLog,
} from '../src/factory-telemetry-log.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'gaia-telemetry-phase-cli-'));
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

const WORK_ITEM = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemKind: 'ISSUE',
  itemId: 'issue-27',
  itemNumber: 27,
  title: 'Add the passive factory telemetry spine',
  state: 'READY',
  updatedAt: '2026-08-29T12:00:00.000Z',
});

let counter = 0;
function workspace() {
  counter += 1;
  const base = join(scratch, `case-${counter}`);
  mkdirSync(base, { recursive: true });
  const body = {
    schema: 'gaia-github-portfolio/1', policyRevision: 'policy-r0', workItems: [WORK_ITEM],
  };
  const portfolio = {
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
  const portfolioPath = join(base, 'portfolio.json');
  writeFileSync(portfolioPath, `${JSON.stringify(portfolio, null, 2)}\n`, 'utf8');
  return { base, portfolioPath, telemetryDirectory: join(base, 'telemetry') };
}

const SUBJECT_FLAGS = Object.freeze([
  '--repository', 'GuitarAlchemist/gaia',
  '--item', 'issue-27',
  '--item-number', '27',
  '--lane', 'LANE_A',
  '--agent', 'CLAUDE_WORKER',
]);

const at = (instant) => () => new Date(instant);

test('every phase is one separate process, and the dashboard is another that sees the run live', () => {
  const { base, portfolioPath, telemetryDirectory } = workspace();
  const runId = 'run-27-cross-process';
  const phase = (...argv) => execFileSync(
    process.execPath, [join(root, 'scripts', 'factory-telemetry-phase.mjs'),
      '--telemetry-dir', telemetryDirectory, '--run-id', runId, ...argv],
    { cwd: root, encoding: 'utf8' },
  );
  const dashboard = (label) => {
    const snapshotPath = join(base, `control-room-${label}.json`);
    const htmlPath = join(base, `control-room-${label}.html`);
    execFileSync(process.execPath, [join(root, 'scripts', 'factory-dashboard.mjs'),
      '--portfolio', portfolioPath, '--telemetry', telemetryDirectory,
      '--snapshot-out', snapshotPath, '--html-out', htmlPath], { cwd: root, encoding: 'utf8' });
    return {
      snapshot: JSON.parse(readFileSync(snapshotPath, 'utf8')),
      html: readFileSync(htmlPath, 'utf8'),
    };
  };

  const startOutput = phase('--phase', 'start', ...SUBJECT_FLAGS);
  assert.match(startOutput, /Gaia telemetry phase: start \| run run-27-cross-process/u);
  assert.match(startOutput, /run\.started/u);
  phase('--phase', 'heartbeat');
  phase('--phase', 'gate-entered', '--gate', 'CLAIMED');

  // A different process, reading only the on-disk log, catches the run while it is open.
  const active = dashboard('active');
  assert.equal(active.snapshot.headline.state, 'ACTIVE');
  assert.equal(active.snapshot.showSpinner, true);
  assert.equal(active.snapshot.items[0].telemetry.runId, runId);
  assert.equal(active.snapshot.items[0].telemetry.runState, 'IN_GATE');
  assert.equal(active.snapshot.items[0].activity.state, 'ACTIVE');
  assert.equal(active.snapshot.items[0].activity.stage, 'CLAIMED');
  assert.match(active.html, /class="heartbeat-pulse"/u);

  phase('--phase', 'gate-passed', '--gate', 'CLAIMED');
  phase('--phase', 'finish');

  const settled = dashboard('settled');
  assert.equal(settled.snapshot.headline.state, 'PAUSED');
  assert.equal(settled.snapshot.showSpinner, false);
  assert.equal(settled.snapshot.items[0].telemetry.runState, 'COMPLETED');
  assert.doesNotMatch(settled.html, /class="heartbeat-pulse"/u);

  const { events } = readFactoryTelemetryLog({ directory: telemetryDirectory });
  assert.deepEqual(events.map(({ event }) => event), [
    'run.started', 'run.heartbeat', 'gate.entered', 'gate.passed', 'run.completed',
  ]);
});

test('the phase CLI writes one report and binds the subject exactly once', () => {
  const { base, telemetryDirectory } = workspace();
  const outPath = join(base, 'phase.json');
  const lines = [];
  const report = runFactoryTelemetryPhaseCli([
    '--telemetry-dir', telemetryDirectory,
    '--run-id', 'run-27-cli-report',
    '--phase', 'start',
    ...SUBJECT_FLAGS,
    '--out', outPath,
  ], { now: at('2026-08-29T18:00:00.000Z'), writeStdout: (chunk) => lines.push(chunk) });

  assert.equal(report.schema, TELEMETRY_PHASE_REPORT_SCHEMA);
  assert.equal(report.receipt.event, 'run.started');
  assert.equal(report.receipt.authority, 'NONE');
  assert.deepEqual(JSON.parse(readFileSync(outPath, 'utf8')), report);
  assert.match(lines.join(''), /state RUNNING/u);

  const beat = runFactoryTelemetryPhaseCli([
    '--telemetry-dir', telemetryDirectory,
    '--run-id', 'run-27-cli-report',
    '--phase', 'heartbeat',
  ], { now: at('2026-08-29T18:00:01.000Z'), writeStdout: () => {} });
  assert.equal(beat.receipt.sequence, 1);
  assert.equal(beat.receipt.runState, 'RUNNING');
});

test('the phase CLI refuses a malformed invocation and writes nothing', () => {
  const { base, telemetryDirectory } = workspace();
  const count = () => readFactoryTelemetryLog({ directory: telemetryDirectory }).count;
  const refuses = (argv, pattern) => {
    const before = count();
    assert.throws(() => runFactoryTelemetryPhaseCli(
      ['--telemetry-dir', telemetryDirectory, '--run-id', 'run-27-cli-refusals', ...argv],
      { now: at('2026-08-29T18:00:00.000Z'), writeStdout: () => {} },
    ), pattern);
    assert.equal(count(), before);
  };

  refuses(['--phase', 'resume', ...SUBJECT_FLAGS], /unsupported phase/u);
  refuses(['--phase', 'start'], /--phase start requires/u);
  refuses(['--phase', 'gate-entered'], /requires --gate/u);
  refuses(['--phase', 'block'], /requires --blocker/u);
  refuses(['--phase', 'start', ...SUBJECT_FLAGS, '--gate', 'CLAIMED'], /must not carry --gate/u);
  refuses(['--phase', 'start', ...SUBJECT_FLAGS, '--unknown', 'x'], /unknown option/u);
  refuses(['--phase', 'heartbeat', '--item', 'issue-27'], /only --phase start may bind/u);
  refuses(
    ['--phase', 'start', ...SUBJECT_FLAGS, '--out', factoryTelemetryLogPath(telemetryDirectory)],
    /durable evidence log/u,
  );
  refuses(['--phase', 'start', ...SUBJECT_FLAGS, '--item-number', 'twenty'], /--item-number/u);

  assert.throws(() => runFactoryTelemetryPhaseCli([
    '--telemetry-dir', telemetryDirectory, '--run-id', 'run-27-cli-refusals',
    '--phase', 'heartbeat',
  ], { writeStdout: () => {} }), (error) => error?.code === 'PhaseRunUnstarted');
  assert.equal(base.length > 0, true);
});
