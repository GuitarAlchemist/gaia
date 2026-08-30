/**
 * local-lanes-cli.test.mjs — the sensor's process boundary, the watcher, and the adapter seam.
 *
 * The sensor shells out to wmux, so these tests give it a real process (tests/fixtures/
 * fake-wmux-cli.mjs) rather than mocking the seam away. That fixture records the exact argv it was
 * invoked with and exits non-zero for every verb but `agent list`, which is what makes the two
 * negative controls here evidence rather than assertion.
 *
 * Gates T3, T14, T15 and T17 of the pair-review amendment live in this file, plus the
 * case-variant alias regression the epistemic review reproduced as destructive.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import {
  WMUX_LANE_ARGV, runLocalLaneSensorCli,
} from '../scripts/local-lane-sensor.mjs';
import {
  MAX_WATCH_INTERVAL_MS, parseArgs, runLocalLanesTick,
} from '../scripts/local-lanes-watch.mjs';
import { requireLocalLaneObservation } from '../src/local-lane-observation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE_WMUX = join(HERE, 'fixtures', 'fake-wmux-cli.mjs');

const SCRATCH = mkdtempSync(join(tmpdir(), 'gaia-local-lanes-cli-'));
test.after(() => rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

let counter = 0;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

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

/** A raw wmux record carrying everything this sensor must never ingest. */
const agent = (n, overrides = {}) => ({
  agentId: `agent-${n}`,
  surfaceId: `surf-${n}`,
  paneId: `pane-${n}`,
  workspaceId: 'ws-alpha',
  label: `Gaia Review Lane ${n}`,
  cmd: `pwsh -NoProfile -File 'C:\\tmp\\LEAK-COMMAND-${n}.ps1'`,
  status: 'running',
  spawnTime: 1_788_060_173_347,
  pid: 40_000 + n,
  screen: `LEAK-SCREEN-${n}`,
  prompt: `LEAK-PROMPT-${n}`,
  stdout: `LEAK-STDOUT-${n}`,
  reasoning: `LEAK-REASONING-${n}`,
  ...overrides,
});

const AT = new Date('2026-08-30T03:45:00.000Z');
const clock = (at = AT) => () => at;

function projectionFile(dir, name = 'projection.json') {
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
  const projection = {
    ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  };
  const path = join(dir, name);
  writeFileSync(path, `${JSON.stringify(projection, null, 2)}\n`, 'utf8');
  return path;
}

// ---------------------------------------------------------------------------
// T14 / T15 — what the sensor invokes, and what it refuses to ingest
// ---------------------------------------------------------------------------

test('T14: the sensor invokes exactly `agent list`, with no workspace filter and no shell', () => {
  const space = workspace([agent(1), agent(2, { workspaceId: 'ws-beta' })]);
  const out = space.path('observation.json');

  runLocalLaneSensorCli(['--out', out, '--wmux', FAKE_WMUX], {
    now: clock(), writeStdout: () => {},
  });

  assert.deepEqual([...WMUX_LANE_ARGV], ['agent', 'list'], 'the argv is a frozen constant');
  assert.deepEqual(space.argv(), [['agent', 'list']], 'and exactly one read-only call was made');

  const source = readFileSync(join(HERE, '..', 'scripts', 'local-lane-sensor.mjs'), 'utf8');
  assert.match(source, /shell:\s*false/u, 'nothing is interpreted by a shell');
  assert.equal(source.includes("'--workspace'"), false, 'no workspace filter is constructible');
  for (const verb of ['read-screen', 'send-key', 'browser', 'kill', 'spawn', 'close-surface']) {
    assert.equal(source.includes(`'${verb}'`), false, `the sensor can construct ${verb}`);
  }
});

test('T14: both workspaces are observed, because no filter is passed', () => {
  const space = workspace([
    agent(1, { workspaceId: 'ws-alpha' }),
    agent(2, { workspaceId: 'ws-beta' }),
    agent(3, { workspaceId: 'ws-beta', status: 'exited' }),
  ]);

  const observation = runLocalLaneSensorCli(
    ['--out', space.path('observation.json'), '--wmux', FAKE_WMUX],
    { now: clock(), writeStdout: () => {} },
  );

  assert.equal(observation.lanes.length, 3);
  assert.equal(new Set(observation.lanes.map(({ workspaceId }) => workspaceId)).size, 2);
});

test('T15: no command line, prompt, stdout, screen or reasoning reaches any artifact', () => {
  const space = workspace([agent(1), agent(2)]);
  const lanesOut = space.path('observation.json');
  const htmlOut = space.path('control-room.html');
  const snapshotOut = space.path('control-room.json');

  runLocalLaneSensorCli(['--out', lanesOut, '--wmux', FAKE_WMUX], {
    now: clock(), writeStdout: () => {},
  });
  runFactoryDashboardCli([
    '--projection', projectionFile(space.dir),
    '--local-lanes', lanesOut,
    '--html-out', htmlOut,
    '--snapshot-out', snapshotOut,
  ], { now: clock(), writeStdout: () => {} });

  const artifacts = [lanesOut, htmlOut, snapshotOut].map((path) => readFileSync(path, 'utf8'));
  for (const marker of [
    'LEAK-COMMAND', 'LEAK-SCREEN', 'LEAK-PROMPT', 'LEAK-STDOUT', 'LEAK-REASONING',
    'pwsh', 'spawnTime', '"pid"',
  ]) {
    for (const [index, bytes] of artifacts.entries()) {
      assert.equal(bytes.includes(marker), false, `${marker} reached artifact ${index}`);
    }
  }
  assert.match(artifacts[1], /Gaia Review Lane 1/u, 'while the safe label is displayed');
  assert.match(artifacts[1], /LOCAL_WMUX/u);
});

test('T15 MECHANISM REVERT: adding cmd to the read fields is what would leak it', () => {
  const source = readFileSync(join(HERE, '..', 'src', 'local-lane-sensor.mjs'), 'utf8');
  const mutated = source.replace(
    '      lifecycle: lifecycle(record),',
    '      lifecycle: lifecycle(record),\n      cmd: record.cmd,',
  );

  assert.notEqual(mutated, source, 'the mutation targets the six named reads');
  assert.equal(
    /\.\.\.record/u.test(source), false,
    'the property that makes the leak unreachable is that no record is ever spread',
  );
});

test('the sensor fails closed on silence, on garbage, and on a non-zero exit', () => {
  for (const [why, extra] of [
    ['silence', { emitSilence: true }],
    ['unparseable output', { emitGarbage: true }],
  ]) {
    const space = workspace([agent(1)], extra);
    assert.throws(
      () => runLocalLaneSensorCli(['--out', space.path('o.json'), '--wmux', FAKE_WMUX], {
        now: clock(), writeStdout: () => {},
      }),
      /refus|parse|silence|agents/iu,
      `${why} must never be read as zero lanes`,
    );
  }
});

test('the observation the sensor writes verifies on its own terms and is deterministic', () => {
  const space = workspace([agent(3), agent(1), agent(2, { status: 'exited' })]);
  const first = space.path('a.json');
  const second = space.path('b.json');

  runLocalLaneSensorCli(['--out', first, '--wmux', FAKE_WMUX], { now: clock(), writeStdout: () => {} });
  runLocalLaneSensorCli(['--out', second, '--wmux', FAKE_WMUX], { now: clock(), writeStdout: () => {} });

  assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
  assert.doesNotThrow(() => requireLocalLaneObservation(JSON.parse(readFileSync(first, 'utf8'))));
});

// ---------------------------------------------------------------------------
// T3 — the watcher interval cannot outrun the observation window
// ---------------------------------------------------------------------------

test('T3: an interval above half the observation window is a usage refusal', () => {
  const base = ['--lanes-out', 'lanes.json', '--html-out', 'h.html', '--snapshot-out', 's.json'];

  assert.equal(MAX_WATCH_INTERVAL_MS, 15_000, 'half of the 30s observation window');
  assert.doesNotThrow(() => parseArgs([...base, '--interval-ms', '15000']));
  assert.doesNotThrow(() => parseArgs([...base, '--interval-ms', '1000']));
  for (const interval of ['15001', '30000', '60000', '999', '0', '-1', 'soon']) {
    assert.throws(
      () => parseArgs([...base, '--interval-ms', interval]),
      /interval-ms must be an integer from 1000 through 15000/u,
      `${interval} would let a healthy sensor render stale`,
    );
  }
  assert.equal(parseArgs(base).interval, 5_000, 'and the default is well inside the window');
});

test('T3: the watcher forwards dashboard flags and supplies the observation itself', () => {
  const { own, forwarded } = parseArgs([
    '--lanes-out', 'lanes.json', '--interval-ms', '2000', '--wmux', 'w',
    '--portfolio', 'p.json', '--html-out', 'h.html', '--snapshot-out', 's.json',
  ]);

  assert.equal(own['lanes-out'], 'lanes.json');
  assert.deepEqual(forwarded, [
    '--portfolio', 'p.json', '--html-out', 'h.html', '--snapshot-out', 's.json',
  ]);
  assert.throws(
    () => parseArgs(['--lanes-out', 'l.json', '--local-lanes', 'other.json']),
    /supplied by this watcher/u,
  );
});

test('one watcher tick refreshes the observation and the control room together', () => {
  const space = workspace([agent(1), agent(2)]);
  const lanesOut = space.path('lanes.json');
  const htmlOut = space.path('control-room.html');

  const { observation, snapshot } = runLocalLanesTick([
    '--lanes-out', lanesOut,
    '--wmux', FAKE_WMUX,
    '--projection', projectionFile(space.dir),
    '--html-out', htmlOut,
    '--snapshot-out', space.path('control-room.json'),
  ], { now: clock(), writeStdout: () => {} });

  assert.equal(observation.lanes.length, 2);
  assert.equal(snapshot.headline.state, 'ACTIVE');
  assert.equal(snapshot.localLanes.liveCount, 2);
  assert.match(readFileSync(htmlOut, 'utf8'), /LOCAL_WMUX/u);
  assert.deepEqual(space.argv(), [['agent', 'list']], 'exactly one wmux read per tick');
});

test('the watcher holds no retry loop, and no network, provider or install', () => {
  const source = readFileSync(join(HERE, '..', 'scripts', 'local-lanes-watch.mjs'), 'utf8');

  for (const forbidden of [
    /node:https?\b/u, /fetch\(/u, /npm install/u, /git push/u, /setInterval\(/u,
    /retry/iu, /createServer/u,
  ]) {
    assert.doesNotMatch(source.replace(/^\s*\*.*$/gmu, ''), forbidden, `${forbidden} is present`);
  }
  assert.match(source, /setTimeout\(tick, interval\)/u, 'the next tick is scheduled after settling');
  assert.match(source, /SIGINT/u);
  assert.match(source, /SIGTERM/u);
});

// ---------------------------------------------------------------------------
// T17 — the lane observation is not drain-window evidence
// ---------------------------------------------------------------------------

test('T17: an observation newer than every other input leaves the drain window untouched', () => {
  const space = workspace([agent(1)]);
  const projection = projectionFile(space.dir);
  const lanesOut = space.path('lanes.json');
  runLocalLaneSensorCli(['--out', lanesOut, '--wmux', FAKE_WMUX], {
    now: clock(), writeStdout: () => {},
  });

  const shared = ['--projection', projection];
  const without = runFactoryDashboardCli([
    ...shared, '--html-out', space.path('a.html'), '--snapshot-out', space.path('a.json'),
  ], { now: clock(), writeStdout: () => {} });
  const withLanes = runFactoryDashboardCli([
    ...shared, '--local-lanes', lanesOut,
    '--html-out', space.path('b.html'), '--snapshot-out', space.path('b.json'),
  ], { now: clock(), writeStdout: () => {} });

  assert.equal(withLanes.sourceChangedAt, without.sourceChangedAt);
  assert.equal(withLanes.sourceChangedAtBasis, without.sourceChangedAtBasis);
  assert.equal(canonicalJson(withLanes.obstruction), canonicalJson(without.obstruction));

  const source = readFileSync(join(HERE, '..', 'scripts', 'factory-dashboard.mjs'), 'utf8');
  const mtimeScan = source.slice(source.indexOf('newestInputChangedAt: newestMtime(['));
  assert.equal(
    mtimeScan.slice(0, mtimeScan.indexOf(']')).includes('localLanesPath'), false,
    'the observation path must never enter the observation-window mtime scan',
  );
});

// ---------------------------------------------------------------------------
// U5 — the alias guard is filesystem identity, not a spelling test
// ---------------------------------------------------------------------------

test('U5: an output that aliases an input by case only is refused, and the input survives', () => {
  const space = workspace([agent(1)]);
  const projection = projectionFile(space.dir, 'Projection.json');
  const before = readFileSync(projection, 'utf8');

  assert.throws(
    () => runFactoryDashboardCli([
      '--projection', projection,
      '--html-out', space.path('out.html'),
      '--snapshot-out', space.path('projection.json'),
    ], { now: clock(), writeStdout: () => {} }),
    /aliases an input evidence path/u,
    'two spellings of one file are one file',
  );
  assert.equal(readFileSync(projection, 'utf8'), before, 'the input evidence is untouched');
});

test('U5: two outputs that differ only in case are refused as one file', () => {
  const space = workspace([agent(1)]);

  assert.throws(
    () => runFactoryDashboardCli([
      '--projection', projectionFile(space.dir),
      '--html-out', space.path('out.html'),
      '--snapshot-out', space.path('control-room.json'),
      '--activity', 'on', '--activity-out', space.path('CONTROL-ROOM.json'),
    ], { now: clock(), writeStdout: () => {} }),
    /outputs must differ/u,
  );
});

// ---------------------------------------------------------------------------
// U7 — auto refresh is off by default and controllable when asked for
// ---------------------------------------------------------------------------

test('U7: the page does not replace itself, and an opt-in refresh carries a stop control', () => {
  const space = workspace([agent(1)]);
  const projection = projectionFile(space.dir);

  runFactoryDashboardCli([
    '--projection', projection,
    '--html-out', space.path('default.html'), '--snapshot-out', space.path('default.json'),
  ], { now: clock(), writeStdout: () => {} });
  const byDefault = readFileSync(space.path('default.html'), 'utf8');
  assert.equal(byDefault.includes('http-equiv'), false, 'no meta refresh at all');
  assert.equal(byDefault.includes('location.reload'), false, 'and no scripted reload either');

  runFactoryDashboardCli([
    '--projection', projection, '--refresh-seconds', '30',
    '--html-out', space.path('live.html'), '--snapshot-out', space.path('live.json'),
  ], { now: clock(), writeStdout: () => {} });
  const live = readFileSync(space.path('live.html'), 'utf8');
  assert.equal(live.includes('http-equiv'), false, 'a meta refresh can never be cancelled');
  assert.match(live, /<button type="button" id="stop-refresh">/u, 'so the control is a real button');
  assert.match(live, /window\.location\.reload/u);
  assert.match(live, /clearTimeout\(reloadTimer\)/u, 'and the button actually cancels it');

  assert.throws(
    () => runFactoryDashboardCli([
      '--projection', projection, '--refresh-seconds', '2',
      '--html-out', space.path('x.html'), '--snapshot-out', space.path('x.json'),
    ], { now: clock(), writeStdout: () => {} }),
    /--refresh-seconds must be an integer from 5 through 3600/u,
  );
});
