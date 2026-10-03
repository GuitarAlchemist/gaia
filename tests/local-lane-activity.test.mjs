/**
 * local-lane-activity.test.mjs — the third lane axis: what `wmux agent-state` claims each running
 * agent is doing, restated and never extended. docs/lane-activity-signals.md is the contract.
 *
 * The process-boundary tests give the sensor a real process (tests/fixtures/fake-wmux-cli.mjs),
 * which records every argv and exits non-zero for every verb but the two read-only ones, so the
 * "exactly one more call" gates are evidence rather than assertion.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  UsageError, WMUX_ACTIVITY_ARGV, parseArgs, runLocalLaneSensorCli,
} from '../scripts/local-lane-sensor.mjs';
import { parseArgs as parseWatchArgs, runLocalLanesTick } from '../scripts/local-lanes-watch.mjs';
import {
  LANE_ACTIVITIES, LANE_ACTIVITY_REASONS, localLaneObservationRevision,
  requireLocalLaneObservation, sealLocalLaneObservation,
} from '../src/local-lane-observation.mjs';
import {
  WMUX_ACTIVITY_FIELDS, deriveLaneActivityStates, observeLocalLanes,
} from '../src/local-lane-sensor.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FAKE_WMUX = join(HERE, 'fixtures', 'fake-wmux-cli.mjs');
const AT = '2026-10-02T21:30:00.000Z';
const clock = () => () => new Date(AT);

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-lane-activity-'));
test.after(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

/** A raw `wmux agent list` record. */
const agent = (n, overrides = {}) => ({
  agentId: `agent-${n}`,
  surfaceId: `surf-${n}`,
  paneId: `pane-${n}`,
  workspaceId: 'ws-alpha',
  label: `Gaia Lane ${n}`,
  status: 'running',
  ...overrides,
});

/** A raw `wmux agent-state` record carrying every field wmux 2.13 emits, each one a leak marker. */
const claim = (n, state, overrides = {}) => ({
  surfaceId: `surf-${n}`,
  state,
  blockedReason: `LEAK-BLOCKED-REASON-${n}`,
  choices: [{ id: 'yes', label: `LEAK-CHOICE-${n}`, key: '1' }],
  answeredAt: 1_790_977_000_001,
  sessionId: `LEAK-SESSION-${n}`,
  runDepth: 1,
  metadata: { model: `LEAK-METADATA-${n}` },
  updatedAt: 1_790_977_000_002,
  blockedSince: 1_790_977_000_003,
  agent: null,
  agentSource: null,
  ...overrides,
});

const observe = (agents, agentStates) => observeLocalLanes({ agents, observedAt: AT, agentStates });
const activityOf = (observation, n) => observation.activityStates
  .find(({ surfaceId }) => surfaceId === `surf-${n}`);

let counter = 0;

/** One scratch workspace with a canned wmux payload and an argv recorder. */
function workspace(agents, extra = {}) {
  const dir = join(SCRATCH, `w${counter += 1}`);
  mkdirSync(dir, { recursive: true });
  const statePath = join(dir, 'wmux-state.json');
  const argvPath = join(dir, 'wmux-argv.jsonl');
  writeFileSync(statePath, JSON.stringify({ agents, ...extra }), 'utf8');
  writeFileSync(argvPath, '', 'utf8');
  process.env.GAIA_FAKE_WMUX_STATE = statePath;
  process.env.GAIA_FAKE_WMUX_ARGV = argvPath;
  return {
    dir,
    argv: () => readFileSync(argvPath, 'utf8').split('\n').filter(Boolean).map(JSON.parse),
    path: (name) => join(dir, name),
  };
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** An empty, sealed portfolio projection, so a watcher tick has a control room to publish. */
function projectionFile(dir) {
  const body = {
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: 'a'.repeat(64),
    effect: 'NONE',
    authority: 'NONE',
    capacity: 4,
    counts: { occupied: 0, available: 4 },
    items: [],
    decisions: [],
  };
  const path = join(dir, 'projection.json');
  writeFileSync(path, `${JSON.stringify({
    ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  }, null, 2)}\n`, 'utf8');
  return path;
}

function sense(space, extraArgs = []) {
  const lines = [];
  const observation = runLocalLaneSensorCli(
    ['--out', space.path('lanes.json'), '--wmux', FAKE_WMUX, ...extraArgs],
    { now: clock(), writeStdout: (chunk) => lines.push(chunk) },
  );
  return {
    observation,
    stdout: lines.join(''),
    file: JSON.parse(readFileSync(space.path('lanes.json'), 'utf8')),
  };
}

// ---------------------------------------------------------------------------
// the pure derivation
// ---------------------------------------------------------------------------

test('each running lane restates its wmux claim through the exact map', () => {
  const observation = observe(
    [agent(1), agent(2), agent(3)],
    [claim(1, 'working'), claim(2, 'idle'), claim(3, 'blocked')],
  );

  assert.deepEqual(
    observation.activityStates.map(({ activity, activityReason }) => [activity, activityReason]),
    [['WORKING', 'WMUX_WORKING'], ['IDLE', 'WMUX_IDLE'], ['NEEDS_OPERATOR', 'WMUX_BLOCKED']],
  );
  assert.deepEqual([...LANE_ACTIVITIES], ['WORKING', 'IDLE', 'NEEDS_OPERATOR', 'UNKNOWN']);
});

test('every way of not knowing is UNKNOWN under its own reason, and none of them is IDLE', () => {
  const observation = observe(
    [
      agent(1),
      agent(2),
      agent(3),
      agent(4),
      agent(5),
      agent(6),
      agent(7, { status: 'exited' }),
      agent(8, { surfaceId: undefined }),
      agent(9),
    ],
    [
      // 1 has no record at all.
      claim(2, 'Working'),
      claim(3, 'blocked-ish'),
      claim(4, null),
      claim(5, undefined),
      claim(6, 'idle'),
      claim(6, 'idle'),
      claim(7, 'working'),
      { surfaceId: 'UNKNOWN', state: 'idle' },
      claim(9, 'idle', { surfaceId: 42 }),
    ],
  );
  const reasonOf = (n, surfaceId = `surf-${n}`) => observation.activityStates
    .find((entry) => entry.surfaceId === surfaceId && entry.agentId === `agent-${n}`);

  assert.equal(reasonOf(1).activityReason, 'NO_CLAIM');
  assert.equal(reasonOf(2).activityReason, 'UNRECOGNISED_CLAIM', 'no case folding');
  assert.equal(reasonOf(3).activityReason, 'UNRECOGNISED_CLAIM', 'no prefix match');
  assert.equal(reasonOf(4).activityReason, 'UNRECOGNISED_CLAIM');
  assert.equal(reasonOf(5).activityReason, 'UNRECOGNISED_CLAIM');
  assert.equal(
    reasonOf(6).activityReason, 'CONFLICTING_CLAIMS',
    'two records for one surface are no single claim, even when they agree',
  );
  assert.equal(
    reasonOf(7).activityReason, 'PROCESS_NOT_RUNNING',
    'an exited process waits for nobody, whatever wmux last said about it',
  );
  assert.equal(
    reasonOf(8, 'UNKNOWN').activityReason, 'SURFACE_UNKNOWN',
    'the identity sentinel matches no claim, including one spelled UNKNOWN',
  );
  assert.equal(reasonOf(9).activityReason, 'NO_CLAIM', 'a non-string surface matches nothing');
  for (const entry of observation.activityStates) {
    assert.equal(entry.activity, 'UNKNOWN', `${entry.surfaceId} is UNKNOWN, never IDLE`);
  }
});

test('a claim for a surface no lane reported creates no lane and no entry', () => {
  const observation = observe([agent(1)], [claim(1, 'idle'), claim(99, 'blocked')]);

  assert.equal(observation.lanes.length, 1);
  assert.equal(observation.activityStates.length, 1);
  assert.equal(JSON.stringify(observation).includes('surf-99'), false);
  assert.equal(observe([], [claim(1, 'blocked')]).activityStates.length, 0, 'nor resurrects one');
});

test('NEGATIVE CONTROL: only surfaceId and state are read, by name', () => {
  // A record whose every other field throws when touched: the property is a construction, so a
  // derivation that spread the record, walked its keys or read one more field fails here.
  const trapped = { surfaceId: 'surf-1', state: 'blocked' };
  for (const field of Object.keys(claim(1, 'blocked'))) {
    if (WMUX_ACTIVITY_FIELDS.includes(field)) continue;
    Object.defineProperty(trapped, field, {
      enumerable: true,
      get() { throw new Error(`the sensor read ${field}`); },
    });
  }
  const derived = deriveLaneActivityStates({
    lanes: observe([agent(1)], null).lanes, agentStates: [trapped],
  });
  assert.equal(derived[0].activity, 'NEEDS_OPERATOR');

  const observation = observe([agent(1), agent(2)], [claim(1, 'blocked'), claim(2, 'working')]);
  const bytes = JSON.stringify(observation);
  assert.equal(bytes.includes('LEAK'), false, 'no reason, choice, session or metadata leaks');
  for (const instant of ['1790977000001', '1790977000002', '1790977000003']) {
    assert.equal(bytes.includes(instant), false, 'and no instant that could become an age');
  }
  assert.deepEqual([...WMUX_ACTIVITY_FIELDS], ['surfaceId', 'state']);
});

test('the same inputs give byte-identical output, whatever order wmux reported them in', () => {
  const agents = [agent(1), agent(2), agent(3)];
  const states = [claim(1, 'working'), claim(2, 'blocked'), claim(3, 'idle')];

  assert.equal(
    JSON.stringify(observe(agents, states)),
    JSON.stringify(observe([...agents].reverse(), [...states].reverse())),
  );
});

test('a structurally invalid record is a boundary defect, so it throws instead of degrading', () => {
  const lanes = observe([agent(1)], null).lanes;
  for (const agentStates of [undefined, null, {}, 'states']) {
    assert.throws(() => deriveLaneActivityStates({ lanes, agentStates }), /exact array/u);
  }
  for (const record of [null, 'surf-1', ['surf-1', 'idle']]) {
    assert.throws(
      () => deriveLaneActivityStates({ lanes, agentStates: [record] }), /structured object/u,
    );
  }
});

test('without agent states the observation is the same document it has always been', () => {
  const agents = [agent(1), agent(2, { status: 'exited' })];
  const without = observeLocalLanes({ agents, observedAt: AT });

  assert.equal(Object.hasOwn(without, 'activityStates'), false, 'absent means not observed');
  assert.equal(
    JSON.stringify(without),
    JSON.stringify(sealLocalLaneObservation({
      observedAt: AT, lanes: without.lanes, taskStates: without.taskStates,
    })),
  );
});

test('the revision recipe is not widened, so the control room still re-derives it', () => {
  const observation = observe([agent(1), agent(2)], [claim(1, 'blocked'), claim(2, 'idle')]);

  assert.equal(
    observation.revision,
    localLaneObservationRevision({ observedAt: AT, lanes: observation.lanes }),
  );
  assert.equal(observation.revision, observe([agent(1), agent(2)], null).revision);
});

// ---------------------------------------------------------------------------
// the verifier: a resealed observation can neither invent a waiting pane nor hide one
// ---------------------------------------------------------------------------

test('the verifier refuses every axis the derivation could not have produced', () => {
  const valid = JSON.parse(JSON.stringify(observe(
    [agent(1), agent(2), agent(3, { status: 'exited' })],
    [claim(1, 'blocked'), claim(2, 'idle'), claim(3, 'working')],
  )));
  requireLocalLaneObservation(structuredClone(valid));

  const mutate = (edit) => {
    const copy = structuredClone(valid);
    edit(copy);
    return copy;
  };
  const cases = [
    [(o) => { o.activityStates = null; }, /never publishes null/u],
    [(o) => { o.activityStates[0].note = 'x'; }, /unknown field "note"/u],
    [(o) => { o.activityStates[0].activity = 'BLOCKED'; }, /activity must be one of/u],
    [(o) => { o.activityStates[0].activity = 'IDLE'; }, /does not name the activity/u],
    [(o) => { o.activityStates[0].activityReason = 'constructor'; }, /does not name the activity/u],
    [(o) => { o.activityStates[0].processLifecycle = 'EXITED'; }, /lifecycle its own lane reported/u],
    [(o) => { o.activityStates[0].paneId = 'pane-9'; }, /never one wmux did not report/u],
    [(o) => { o.activityStates[0].surfaceId = 'surf-9'; }, /never one wmux did not report/u],
    [(o) => { o.activityStates.pop(); }, /exactly one entry per observed lane/u],
    [(o) => { o.activityStates.push(structuredClone(o.activityStates[0])); }, /exactly one entry/u],
    [(o) => { o.activityStates.reverse(); }, /strictly ascending/u],
    [
      (o) => { o.activityStates[1] = structuredClone(o.activityStates[0]); },
      /strictly ascending/u,
    ],
    [
      (o) => Object.assign(o.activityStates[2], { activity: 'IDLE', activityReason: 'WMUX_IDLE' }),
      /PROCESS_NOT_RUNNING exactly when/u,
    ],
    [
      (o) => Object.assign(o.activityStates[0], {
        activity: 'UNKNOWN', activityReason: 'PROCESS_NOT_RUNNING',
      }),
      /PROCESS_NOT_RUNNING exactly when/u,
    ],
    [
      (o) => Object.assign(o.activityStates[0], {
        activity: 'UNKNOWN', activityReason: 'SURFACE_UNKNOWN',
      }),
      /SURFACE_UNKNOWN exactly when/u,
    ],
  ];
  for (const [edit, refusal] of cases) {
    assert.throws(() => requireLocalLaneObservation(mutate(edit)), refusal, String(edit));
  }
});

test('every reason names exactly one activity, and nothing inherited is a reason', () => {
  for (const [reason, activity] of Object.entries(LANE_ACTIVITY_REASONS)) {
    assert.ok(LANE_ACTIVITIES.includes(activity), `${reason} names ${activity}`);
  }
  assert.equal(Object.getPrototypeOf(LANE_ACTIVITY_REASONS), null);
  assert.equal(LANE_ACTIVITY_REASONS.toString, undefined);
});

// ---------------------------------------------------------------------------
// the process boundary
// ---------------------------------------------------------------------------

test('without --activity the sensor makes exactly one wmux call and publishes no axis', () => {
  const space = workspace([agent(1)], { agentStates: [claim(1, 'blocked')] });
  const { file, stdout } = sense(space);

  assert.deepEqual(space.argv(), [['agent', 'list']], 'the second call is opt-in');
  assert.equal(Object.hasOwn(file, 'activityStates'), false);
  assert.equal(stdout.includes('activity'), false, 'and the summary line is unchanged');
});

test('--activity agent-state makes exactly one more read-only call and publishes the axis', () => {
  const space = workspace(
    [agent(1), agent(2), agent(3)],
    { agentStates: [claim(1, 'blocked'), claim(2, 'working'), claim(4, 'idle')] },
  );
  const { file, stdout } = sense(space, ['--activity', 'agent-state']);

  assert.deepEqual([...WMUX_ACTIVITY_ARGV], ['agent-state'], 'the argv is a frozen constant');
  assert.deepEqual(
    space.argv(), [['agent', 'list'], ['agent-state']],
    'the lane read, then the claim read, with no surface filter',
  );
  const verified = requireLocalLaneObservation(file);
  assert.equal(activityOf(verified, 1).activity, 'NEEDS_OPERATOR');
  assert.equal(activityOf(verified, 2).activity, 'WORKING');
  assert.equal(activityOf(verified, 3).activityReason, 'NO_CLAIM');
  assert.match(stdout, / \| needs operator 1 \| working 1 \| idle 0 \| activity unknown 1 \| /u);
  assert.equal(readFileSync(space.path('lanes.json'), 'utf8').includes('LEAK'), false);
});

test('--activity takes exactly one value, and that value names the only call it can make', () => {
  assert.equal(parseArgs(['--out', 'o.json', '--activity', 'agent-state']).activity, 'agent-state');
  for (const value of ['report-agent', 'agent-state --surface s', 'agent list', '', 'on']) {
    assert.throws(
      () => parseArgs(['--out', 'o.json', '--activity', value]),
      (error) => error instanceof UsageError,
      `--activity ${JSON.stringify(value)} is a usage error`,
    );
  }
});

test('a failed agent-state read omits the axis, names why, and still writes the lanes', () => {
  for (const failure of ['exit', 'garbage', 'silence', 'shape']) {
    const space = workspace([agent(1), agent(2)], { agentStateFailure: failure });
    const { file, stdout } = sense(space, ['--activity', 'agent-state']);

    assert.equal(requireLocalLaneObservation(file).lanes.length, 2, `${failure}: lanes written`);
    assert.equal(Object.hasOwn(file, 'activityStates'), false, `${failure}: axis omitted`);
    assert.match(stdout, / \| activity not observed: wmux agent-state /u, failure);
    assert.match(stdout, / \| running 2 \| /u, `${failure}: liveness still truthful`);
  }
});

test('the watcher owns --activity and hands it to the sensor, never to the dashboard', () => {
  const { own, forwarded } = parseWatchArgs([
    '--lanes-out', 'l.json', '--activity', 'agent-state', '--projection', 'p.json',
  ]);
  assert.equal(own.activity, 'agent-state');
  assert.equal(forwarded.includes('--activity'), false);

  const space = workspace([agent(1)], { agentStates: [claim(1, 'blocked')] });
  const { observation, snapshot } = runLocalLanesTick([
    '--lanes-out', space.path('lanes.json'),
    '--activity', 'agent-state',
    '--wmux', FAKE_WMUX,
    '--projection', projectionFile(space.dir),
    '--html-out', space.path('control-room.html'),
    '--snapshot-out', space.path('control-room.json'),
  ], { now: clock(), writeStdout: () => {} });

  assert.equal(activityOf(observation, 1).activity, 'NEEDS_OPERATOR');
  assert.deepEqual(space.argv(), [['agent', 'list'], ['agent-state']]);
  assert.equal(JSON.stringify(snapshot).includes('NEEDS_OPERATOR'), false);
  assert.equal(readFileSync(space.path('control-room.html'), 'utf8').includes('NEEDS_OPERATOR'), false);
});

// ---------------------------------------------------------------------------
// display only: nothing may decide on this axis
// ---------------------------------------------------------------------------

test('NEGATIVE CONTROL: no module but the schema and the sensor names an activity', () => {
  const allowed = new Set(['local-lane-observation.mjs', 'local-lane-sensor.mjs']);
  for (const name of readdirSync(join(ROOT, 'src'))) {
    if (!name.endsWith('.mjs') || allowed.has(name)) continue;
    const source = readFileSync(join(ROOT, 'src', name), 'utf8');
    for (const token of ['activityStates', 'NEEDS_OPERATOR', 'WMUX_BLOCKED']) {
      assert.equal(
        source.includes(token), false,
        `src/${name} names ${token}: this axis is display evidence and decides nothing`,
      );
    }
  }
  const sensor = readFileSync(join(ROOT, 'scripts', 'local-lane-sensor.mjs'), 'utf8');
  for (const verb of ['report-agent', 'answer-agent', 'release-agent']) {
    assert.equal(sensor.includes(`'${verb}'`), false, `the sensor can construct ${verb}`);
  }
});
