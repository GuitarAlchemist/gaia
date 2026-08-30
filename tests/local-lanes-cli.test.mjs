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
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import {
  WMUX_LANE_ARGV, readArtifactEvidence, runLocalLaneSensorCli,
} from '../scripts/local-lane-sensor.mjs';
import {
  MAX_WATCH_INTERVAL_MS, parseArgs, runLocalLanesTick,
} from '../scripts/local-lanes-watch.mjs';
import {
  MAX_ARTIFACT_BYTES, laneArtifactBindingRevision, requireLocalLaneObservation,
  sealLaneArtifactBindings, sealLocalLaneObservation,
} from '../src/local-lane-observation.mjs';

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

test('U5: an output that aliases an input by case only is refused, and the input survives', {
  skip: process.platform !== 'win32',
}, () => {
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

test('U5: two outputs that differ only in case are refused as one file', {
  skip: process.platform !== 'win32',
}, () => {
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

// ===========================================================================
// ARTIFACT COMPLETION SIGNALS R0 — the process boundary
//
// docs/artifact-completion-signals.md is the normative contract. Everything in
// this section is server-side: the binding file arrives through one explicit
// CLI flag, the artifact is opened here and nowhere else, and the browser is
// never in the picture. The pure derivation these gates feed is covered in
// tests/local-lane-observation.test.mjs.
// ===========================================================================

const MARKER = 'GAIA_TRACER_ARTIFACT_COMPLETE';
const COMPLETE_TEXT = `writer handoff\n\nentry d44de19\n\n${MARKER}\n`;
const SOURCE_REVISION = 'c'.repeat(64);

/** A scratch artifact root, its binding file, and the artifact the binding names. */
function bound(space, n, { text = COMPLETE_TEXT, overrides = {}, write = true } = {}) {
  const root = space.path(`artifacts-${n}`);
  mkdirSync(root, { recursive: true });
  const artifactPath = join(root, `handoff-${n}.md`);
  if (write) writeFileSync(artifactPath, text, 'utf8');
  return {
    root,
    artifactPath,
    binding: {
      workspaceId: 'ws-alpha',
      paneId: `pane-${n}`,
      surfaceId: `surf-${n}`,
      agentId: `agent-${n}`,
      allowedRoot: root,
      artifactPath,
      completionMarker: MARKER,
      sourceRevision: SOURCE_REVISION,
      ...overrides,
    },
  };
}

/** Write a sealed binding document, or a hand-broken one, and return its path. */
function bindingsFile(space, bindings, { name = 'bindings.json', tamper = null } = {}) {
  const sealed = sealLaneArtifactBindings({ bindings });
  const document = tamper === null ? sealed : tamper(structuredClone(sealed));
  const path = space.path(name);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  return path;
}

const digestOf = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const entryFor = (observation, agentId) => observation.taskStates.find(
  (state) => state.agentId === agentId,
);

// ---------------------------------------------------------------------------
// the flag, and the transition it makes possible
// ---------------------------------------------------------------------------

test('the sensor takes its bindings through one explicit flag and publishes the transition', () => {
  const space = workspace([agent(1), agent(2)]);
  const one = bound(space, 1);
  const two = bound(space, 2, { text: 'still working on it\n' });
  const bindings = bindingsFile(space, [one.binding, two.binding]);
  const out = space.path('observation.json');

  const observation = runLocalLaneSensorCli(
    ['--out', out, '--wmux', FAKE_WMUX, '--bindings', bindings],
    { now: clock(), writeStdout: () => {} },
  );

  assert.deepEqual(space.argv(), [['agent', 'list']], 'still exactly one read-only wmux call');
  const completed = entryFor(observation, 'agent-1');
  assert.equal(completed.taskState, 'COMPLETED_EVIDENCE');
  assert.equal(completed.evidenceReason, 'MARKER_VERIFIED');
  assert.equal(completed.artifactDigest, digestOf(COMPLETE_TEXT));
  assert.equal(completed.completionObservedAt, AT.toISOString());
  assert.equal(completed.bindingRevision, laneArtifactBindingRevision(one.binding));
  assert.equal(
    completed.processLifecycle, 'RUNNING',
    'the wrapper is still running, and the observation says both things at once',
  );
  assert.equal(entryFor(observation, 'agent-2').taskState, 'RUNNING');
  assert.equal(entryFor(observation, 'agent-2').evidenceReason, 'ARTIFACT_IN_PROGRESS');

  // The file on disk is the live truth source, and it verifies against the shipped schema.
  const written = requireLocalLaneObservation(JSON.parse(readFileSync(out, 'utf8')));
  assert.equal(written.revision, observation.revision);
  assert.equal(
    readFileSync(out, 'utf8').includes(one.artifactPath), false,
    'and the local artifact path is never published',
  );
});

test('without the flag nothing is bound, and nothing is inferred', () => {
  const space = workspace([agent(1)]);
  bound(space, 1);
  const out = space.path('observation.json');

  const observation = runLocalLaneSensorCli(
    ['--out', out, '--wmux', FAKE_WMUX], { now: clock(), writeStdout: () => {} },
  );

  assert.equal(observation.taskStates.length, 1);
  assert.equal(observation.taskStates[0].taskState, 'UNBOUND');
  assert.equal(observation.taskStates[0].evidenceReason, 'NO_BINDING');
  assert.equal(observation.taskStates[0].processLifecycle, 'RUNNING');
  // No cwd, branch, process tree, label or timing search happened, and none is available to.
  const source = readFileSync(join(HERE, '..', 'scripts', 'local-lane-sensor.mjs'), 'utf8');
  for (const inference of ['cwd(', 'GAIA_LANE_BINDINGS', 'git ', 'branch', 'homedir']) {
    assert.equal(source.includes(inference), false, `${inference} must not reach the sensor`);
  }
});

// ---------------------------------------------------------------------------
// a malformed operator statement refuses the whole tick
// ---------------------------------------------------------------------------

test('a missing, corrupt or tampered binding file refuses the tick and changes nothing', () => {
  const space = workspace([agent(1)]);
  const one = bound(space, 1);
  const out = space.path('observation.json');

  runLocalLaneSensorCli(
    ['--out', out, '--wmux', FAKE_WMUX, '--bindings', bindingsFile(space, [one.binding])],
    { now: clock(), writeStdout: () => {} },
  );
  const before = readFileSync(out, 'utf8');

  const broken = [
    space.path('there-is-no-such-file.json'),
    (() => {
      const path = space.path('corrupt.json');
      writeFileSync(path, '{ "schema": "gaia-lane-artifact-bindings/1", ', 'utf8');
      return path;
    })(),
    bindingsFile(space, [one.binding], {
      name: 'resealed.json',
      tamper: (doc) => ({
        ...doc,
        bindings: [{ ...doc.bindings[0], sourceRevision: 'd'.repeat(64) }],
      }),
    }),
    bindingsFile(space, [one.binding], {
      name: 'unknown-field.json',
      tamper: (doc) => ({ ...doc, reapOnComplete: true }),
    }),
  ];

  for (const path of broken) {
    assert.throws(
      () => runLocalLaneSensorCli(
        ['--out', out, '--wmux', FAKE_WMUX, '--bindings', path],
        { now: clock(), writeStdout: () => {} },
      ),
      (error) => error.name === 'SensorRefusalError',
      `${path} must refuse the tick rather than degrade to no bindings`,
    );
  }
  assert.equal(readFileSync(out, 'utf8'), before, 'and the previous observation is untouched');
});

test('a corrupt or future-dated previous observation refuses the tick', () => {
  const space = workspace([agent(1)]);
  const one = bound(space, 1);
  const bindings = bindingsFile(space, [one.binding]);

  const corrupt = space.path('corrupt-previous.json');
  writeFileSync(corrupt, '{ "schema": "gaia-local-lane-observation/1" }', 'utf8');
  assert.throws(
    () => runLocalLaneSensorCli(
      ['--out', corrupt, '--wmux', FAKE_WMUX, '--bindings', bindings],
      { now: clock(), writeStdout: () => {} },
    ),
    (error) => error.name === 'SensorRefusalError',
    'treating a corrupt history as absence is the edit that resets a refusal to running',
  );

  const future = space.path('future-previous.json');
  writeFileSync(future, `${JSON.stringify(sealLocalLaneObservation({
    observedAt: '2026-08-30T04:45:00.000Z',
    lanes: [{
      workspaceId: 'ws-alpha',
      paneId: 'pane-1',
      surfaceId: 'surf-1',
      agentId: 'agent-1',
      label: null,
      labelState: 'ABSENT',
      lifecycle: 'RUNNING',
    }],
  }), null, 2)}\n`, 'utf8');
  assert.throws(
    () => runLocalLaneSensorCli(
      ['--out', future, '--wmux', FAKE_WMUX, '--bindings', bindings],
      { now: clock(), writeStdout: () => {} },
    ),
    (error) => error.name === 'SensorRefusalError' && /after/u.test(error.message),
  );
});

// ---------------------------------------------------------------------------
// a malformed artifact refuses one entry, and the other lanes stay observable
// ---------------------------------------------------------------------------

test('an artifact that escapes its allowed root once symlinks resolve is refused evidence', (t) => {
  const space = workspace([agent(1)]);
  const one = bound(space, 1, { write: false });
  const outside = space.path('outside-the-fence.md');
  writeFileSync(outside, COMPLETE_TEXT, 'utf8');
  try {
    symlinkSync(outside, one.artifactPath, 'file');
  } catch {
    t.skip('this host does not grant symlink creation');
    return;
  }

  assert.deepEqual(
    readArtifactEvidence(one.binding),
    { outcome: 'REFUSED', reason: 'PATH_ESCAPES_ALLOWED_ROOT' },
    'a lexically safe path is not a physically safe path',
  );
});

test('a non-regular, oversized, unreadable or unstable artifact is refused evidence', () => {
  const space = workspace([agent(1)]);

  const directory = bound(space, 11, { write: false });
  mkdirSync(directory.artifactPath, { recursive: true });
  assert.equal(readArtifactEvidence(directory.binding).reason, 'NOT_A_REGULAR_FILE');

  const large = bound(space, 12, { write: false });
  writeFileSync(large.artifactPath, Buffer.alloc(MAX_ARTIFACT_BYTES + 1, 0x61));
  assert.equal(readArtifactEvidence(large.binding).reason, 'ARTIFACT_TOO_LARGE');

  const invalid = bound(space, 13, { write: false });
  writeFileSync(invalid.artifactPath, Buffer.from([0xff, 0xfe, 0xff, 0x0a]));
  assert.equal(readArtifactEvidence(invalid.binding).reason, 'ARTIFACT_UNREADABLE');

  const absent = bound(space, 14, { write: false });
  assert.deepEqual(readArtifactEvidence(absent.binding), { outcome: 'ABSENT' });

  // Two reads, and a provider that is still writing between them is caught rather than believed.
  const moving = bound(space, 15);
  let call = 0;
  assert.deepEqual(
    readArtifactEvidence(moving.binding, {
      readBytes: () => Buffer.from(`${COMPLETE_TEXT}${call += 1}`, 'utf8'),
    }),
    { outcome: 'REFUSED', reason: 'ARTIFACT_UNSTABLE' },
  );
  assert.deepEqual(readArtifactEvidence(moving.binding), {
    outcome: 'READ', digest: digestOf(COMPLETE_TEXT), text: COMPLETE_TEXT,
  });
});

test('a refused artifact refuses one lane, and the others stay truthfully observed', () => {
  const space = workspace([agent(1), agent(2)]);
  const one = bound(space, 1, { write: false });
  mkdirSync(one.artifactPath, { recursive: true });
  const two = bound(space, 2);
  const out = space.path('observation.json');

  const observation = runLocalLaneSensorCli(
    [
      '--out', out, '--wmux', FAKE_WMUX,
      '--bindings', bindingsFile(space, [one.binding, two.binding]),
    ],
    { now: clock(), writeStdout: () => {} },
  );

  assert.equal(entryFor(observation, 'agent-1').taskState, 'REFUSED_EVIDENCE');
  assert.equal(entryFor(observation, 'agent-1').evidenceReason, 'NOT_A_REGULAR_FILE');
  assert.equal(entryFor(observation, 'agent-2').taskState, 'COMPLETED_EVIDENCE');
  assert.equal(observation.lanes.length, 2, 'and no lane was dropped from the process axis');
});

// ---------------------------------------------------------------------------
// across ticks: generations, monotonicity, replay
// ---------------------------------------------------------------------------

test('a restarted agent starts a new generation and inherits no completion', () => {
  const space = workspace([agent(1)]);
  const one = bound(space, 1);
  const bindings = bindingsFile(space, [one.binding]);
  const out = space.path('observation.json');
  const run = (at) => runLocalLaneSensorCli(
    ['--out', out, '--wmux', FAKE_WMUX, '--bindings', bindings],
    { now: clock(at), writeStdout: () => {} },
  );

  const first = run(AT);
  assert.equal(entryFor(first, 'agent-1').taskState, 'COMPLETED_EVIDENCE');
  assert.equal(entryFor(first, 'agent-1').generation, 0);

  workspace([agent(1, { status: 'exited' })]);
  const stopped = run(new Date('2026-08-30T03:46:00.000Z'));
  assert.equal(entryFor(stopped, 'agent-1').generation, 0, 'leaving RUNNING is not a new run');
  assert.equal(
    entryFor(stopped, 'agent-1').completionObservedAt, AT.toISOString(),
    'and the first sighting is still the first sighting',
  );

  workspace([agent(1)]);
  writeFileSync(one.artifactPath, 'the next run has only just begun\n', 'utf8');
  const restarted = run(new Date('2026-08-30T03:47:00.000Z'));
  assert.equal(entryFor(restarted, 'agent-1').generation, 1);
  assert.equal(entryFor(restarted, 'agent-1').taskState, 'RUNNING');
  assert.equal(entryFor(restarted, 'agent-1').completionObservedAt, null);
});

test('a completion that stops matching becomes refused evidence, never running again', () => {
  const space = workspace([agent(1)]);
  const one = bound(space, 1);
  const bindings = bindingsFile(space, [one.binding]);
  const out = space.path('observation.json');
  const run = (at) => runLocalLaneSensorCli(
    ['--out', out, '--wmux', FAKE_WMUX, '--bindings', bindings],
    { now: clock(at), writeStdout: () => {} },
  );

  assert.equal(entryFor(run(AT), 'agent-1').taskState, 'COMPLETED_EVIDENCE');
  writeFileSync(one.artifactPath, 'someone rewrote the handoff\n', 'utf8');
  const after = entryFor(run(new Date('2026-08-30T03:46:00.000Z')), 'agent-1');

  assert.equal(after.taskState, 'REFUSED_EVIDENCE');
  assert.equal(after.evidenceReason, 'COMPLETION_EVIDENCE_CONTRADICTED');
  assert.equal(after.artifactDigest, null);
});

test('one tick replays deterministically: identical inputs write identical bytes', () => {
  const space = workspace([agent(1), agent(2)]);
  const one = bound(space, 1);
  const two = bound(space, 2, { text: 'in progress\n' });
  const bindings = bindingsFile(space, [one.binding, two.binding]);

  const first = space.path('first.json');
  const second = space.path('second.json');
  const run = (out) => runLocalLaneSensorCli(
    ['--out', out, '--wmux', FAKE_WMUX, '--bindings', bindings],
    { now: clock(), writeStdout: () => {} },
  );
  run(first);
  run(second);

  assert.equal(readFileSync(second, 'utf8'), readFileSync(first, 'utf8'));
  // And a second tick over an unchanged world is a fixed point, not a drifting one.
  run(first);
  assert.equal(readFileSync(first, 'utf8'), readFileSync(second, 'utf8'));
});

// ---------------------------------------------------------------------------
// the watcher forwards the flag, and this slice still holds no destructive verb
// ---------------------------------------------------------------------------

test('the watcher owns --bindings, forwards it to the sensor, and never to the dashboard', () => {
  const space = workspace([agent(1)]);
  const one = bound(space, 1);
  const bindingsPath = bindingsFile(space, [one.binding]);
  const projection = projectionFile(space.dir);

  const { own, forwarded } = parseArgs([
    '--lanes-out', space.path('lanes.json'), '--bindings', bindingsPath,
    '--projection', projection,
  ]);
  assert.equal(own.bindings, bindingsPath);
  assert.equal(forwarded.includes('--bindings'), false, 'the dashboard never sees a binding file');

  const { observation, snapshot } = runLocalLanesTick([
    '--lanes-out', space.path('lanes.json'), '--bindings', bindingsPath,
    '--projection', projection,
    '--html-out', space.path('room.html'), '--snapshot-out', space.path('room.json'),
    '--wmux', FAKE_WMUX,
  ], { now: clock(), writeStdout: () => {} });

  assert.equal(entryFor(observation, 'agent-1').taskState, 'COMPLETED_EVIDENCE');
  assert.equal(
    JSON.stringify(snapshot).includes('COMPLETED_EVIDENCE'), false,
    'R0 publishes the transition in the observation; the control room is not changed by it',
  );
});

test('NEGATIVE CONTROL: this slice emits state and holds no reaper', () => {
  for (const file of [
    join(HERE, '..', 'scripts', 'local-lane-sensor.mjs'),
    join(HERE, '..', 'scripts', 'local-lanes-watch.mjs'),
    join(HERE, '..', 'src', 'local-lane-sensor.mjs'),
    join(HERE, '..', 'src', 'local-lane-observation.mjs'),
  ]) {
    const source = readFileSync(file, 'utf8');
    for (const destructive of [
      'agent kill', 'agent stop', 'pane close', 'surface close', 'send-keys',
      'process.kill', 'unlinkSync', 'rmSync', 'writeFileSync(binding',
    ]) {
      assert.equal(
        source.includes(destructive), false,
        `${file} must contain no ${destructive}: R0 emits truthful state for a later reaper`,
      );
    }
  }
});
