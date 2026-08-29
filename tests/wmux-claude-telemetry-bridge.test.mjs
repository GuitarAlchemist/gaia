import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import { readFactoryTelemetryLog } from '../src/factory-telemetry-log.mjs';
import { FACTORY_TELEMETRY_EVENTS } from '../src/factory-telemetry.mjs';
import {
  WMUX_CLAUDE_BRIDGE_RECEIPT_SCHEMA,
  observeWmuxClaudeTask,
} from '../src/wmux-claude-telemetry-bridge.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'gaia-wmux-claude-bridge-'));
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

const SUBJECT = Object.freeze({
  repository: 'GuitarAlchemist/gaia',
  itemId: 'issue-27',
  itemNumber: 27,
  lane: 'WMUX_LANE_A',
  agent: 'CLAUDE_CODE',
  itemRevision: 'UNKNOWN',
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

/** One second per observation, so every instant in a run is distinct and increasing. */
function clock(startedAt = '2026-08-29T18:00:00.000Z') {
  let tick = -1;
  return () => {
    tick += 1;
    return new Date(Date.parse(startedAt) + (tick * 1_000));
  };
}

function render({ base, portfolioPath, telemetryDirectory }, label, observedAt) {
  const htmlPath = join(base, `control-room-${label}.html`);
  const snapshot = runFactoryDashboardCli([
    '--portfolio', portfolioPath,
    '--telemetry', telemetryDirectory,
    '--snapshot-out', join(base, `control-room-${label}.json`),
    '--html-out', htmlPath,
  ], { now: () => new Date(observedAt), writeStdout: () => {} });
  return { snapshot, html: readFileSync(htmlPath, 'utf8') };
}

test('the bridge wraps one bounded task and the control room sees it live while it runs', () => {
  const space = workspace();
  const observed = [];

  const receipt = observeWmuxClaudeTask({
    telemetryDirectory: space.telemetryDirectory,
    runId: 'run-27-wmux-claude',
    subject: SUBJECT,
    gate: 'WMUX_CLAUDE_TASK',
    now: clock(),
    // A deterministic offline stand-in for one real bounded wmux/Claude task. The bridge
    // never launches it, reads its screen or inspects its prompt: it only receives beats
    // the task itself chooses to emit, and one closed outcome.
    task: ({ beat }) => {
      for (const step of [1, 2]) {
        const pulse = beat();
        observed.push(render(space, `beat-${step}`, pulse.observedAt).snapshot);
      }
      return { outcome: 'COMPLETED' };
    },
  });

  assert.equal(receipt.schema, WMUX_CLAUDE_BRIDGE_RECEIPT_SCHEMA);
  assert.equal(receipt.outcome, 'COMPLETED');
  assert.equal(receipt.blocker, null);
  assert.equal(receipt.beats, 2);
  assert.equal(receipt.runState, 'COMPLETED');
  assert.equal(receipt.authority, 'NONE');
  assert.equal(receipt.effect, 'LOCAL_TELEMETRY_APPEND');

  // While the task was running, an ordinary dashboard read showed a moving run.
  for (const snapshot of observed) {
    assert.equal(snapshot.headline.state, 'ACTIVE');
    assert.equal(snapshot.showSpinner, true);
    assert.equal(snapshot.items[0].activity.stage, 'WMUX_CLAUDE_TASK');
    assert.equal(snapshot.items[0].telemetry.lane, 'WMUX_LANE_A');
    assert.equal(snapshot.items[0].telemetry.agent, 'CLAUDE_CODE');
  }

  const { events } = readFactoryTelemetryLog({ directory: space.telemetryDirectory });
  assert.deepEqual(events.map(({ event }) => event), [
    'run.started', 'run.heartbeat', 'gate.entered', 'run.heartbeat', 'run.heartbeat',
    'gate.passed', 'run.completed',
  ]);
  assert.equal(events.every(({ event }) => FACTORY_TELEMETRY_EVENTS.includes(event)), true);
});

test('a task that reports itself blocked becomes a named blockage, never motion', () => {
  const space = workspace();
  const receipt = observeWmuxClaudeTask({
    telemetryDirectory: space.telemetryDirectory,
    runId: 'run-27-wmux-blocked',
    subject: SUBJECT,
    now: clock(),
    task: () => ({ outcome: 'BLOCKED', blocker: 'NEEDS_HUMAN_DECISION' }),
  });

  assert.equal(receipt.outcome, 'BLOCKED');
  assert.equal(receipt.blocker, 'NEEDS_HUMAN_DECISION');
  assert.equal(receipt.runState, 'BLOCKED');

  const { snapshot, html } = render(space, 'blocked', '2026-08-29T18:00:10.000Z');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.items[0].activity.state, 'IDLE');
  assert.equal(snapshot.items[0].telemetry.blocker, 'NEEDS_HUMAN_DECISION');
  assert.ok(snapshot.blockers.some(
    ({ state }) => state === 'TELEMETRY_NEEDS_HUMAN_DECISION',
  ));
  assert.doesNotMatch(html, /class="heartbeat-pulse"/u);

  const { events } = readFactoryTelemetryLog({ directory: space.telemetryDirectory });
  assert.deepEqual(events.map(({ event }) => event), [
    'run.started', 'run.heartbeat', 'gate.entered', 'gate.failed', 'run.blocked',
  ]);
});

test('NEGATIVE CONTROL: an infrastructure failure is re-thrown, never laundered into a blocked run', () => {
  const space = workspace();
  const failure = new Error('the wmux pane went away');
  failure.name = 'InfrastructureError';

  assert.throws(() => observeWmuxClaudeTask({
    telemetryDirectory: space.telemetryDirectory,
    runId: 'run-27-wmux-infra',
    subject: SUBJECT,
    now: clock(),
    task: () => { throw failure; },
  }), (error) => error === failure);

  const { events } = readFactoryTelemetryLog({ directory: space.telemetryDirectory });
  assert.deepEqual(events.map(({ event }) => event), [
    'run.started', 'run.heartbeat', 'gate.entered',
  ]);
  // The run stays open and truthfully expires as unknown rather than as a named task refusal.
  const { snapshot } = render(space, 'infra', '2026-08-29T18:01:00.000Z');
  assert.equal(snapshot.items[0].activity.state, 'STALE');
  assert.ok(snapshot.blockers.some(({ state }) => state === 'TELEMETRY_HEARTBEAT_EXPIRED'));
  assert.equal(snapshot.items[0].telemetry.blocker, null);
});

test('NEGATIVE CONTROL: an unreadable task outcome fails closed and records no terminal event', () => {
  const space = workspace();
  assert.throws(() => observeWmuxClaudeTask({
    telemetryDirectory: space.telemetryDirectory,
    runId: 'run-27-wmux-outcome',
    subject: SUBJECT,
    now: clock(),
    task: () => ({ outcome: 'PROBABLY_FINE', notes: 'the pane looked busy' }),
  }), (error) => error?.code === 'BridgeOutcomeUnknown');

  assert.deepEqual(
    readFactoryTelemetryLog({ directory: space.telemetryDirectory })
      .events.map(({ event }) => event),
    ['run.started', 'run.heartbeat', 'gate.entered'],
  );

  // An unknown outcome that happens to carry a well-formed blocker is the dangerous case:
  // read loosely it would become a named, actionable blockage the task never reported.
  for (const outcome of [
    { outcome: 'MAYBE', blocker: 'NEEDS_HUMAN_DECISION' },
    { outcome: 'BLOCKED' },
    { outcome: 'BLOCKED', blocker: 'not a token' },
    null,
    ['COMPLETED'],
  ]) {
    const space = workspace();
    assert.throws(() => observeWmuxClaudeTask({
      telemetryDirectory: space.telemetryDirectory,
      runId: 'run-27-wmux-loose',
      subject: SUBJECT,
      now: clock(),
      task: () => outcome,
    }), (error) => error?.code === 'BridgeOutcomeUnknown', JSON.stringify(outcome));
    assert.deepEqual(
      readFactoryTelemetryLog({ directory: space.telemetryDirectory })
        .events.map(({ event }) => event),
      ['run.started', 'run.heartbeat', 'gate.entered'],
    );
  }

  assert.throws(() => observeWmuxClaudeTask({
    telemetryDirectory: workspace().telemetryDirectory,
    runId: 'run-27-wmux-nontask',
    subject: SUBJECT,
    task: 'wmux browser open https://example.com',
  }), (error) => error?.code === 'BridgeTaskInvalid');
});

test('NEGATIVE CONTROL: the bridge contains no process control, provider call or screen reader', () => {
  const source = readFileSync(join(root, 'src', 'wmux-claude-telemetry-bridge.mjs'), 'utf8');
  // Scan the executable source, not the prose that promises its absence.
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/^\s*\/\/.*$/gmu, '');
  assert.equal(code.includes('observeWmuxClaudeTask'), true, 'the scan must reach real code');
  for (const forbidden of [
    'child_process', 'spawn', 'execFile', 'execSync', 'fetch(', 'http', 'wmux ',
    'stdout', 'stderr', 'prompt', 'screenshot', 'readFile', 'process.',
  ]) {
    assert.equal(
      code.includes(forbidden), false, `the bridge must not reference ${forbidden}`,
    );
  }
  // Its only durable reach is the generic phase seam.
  assert.deepEqual(
    [...code.matchAll(/^import [\s\S]*?from '([^']+)';$/gmu)].map(([, from]) => from),
    ['./factory-telemetry-phase.mjs'],
  );
});
