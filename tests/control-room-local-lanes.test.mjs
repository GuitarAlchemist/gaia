/**
 * control-room-local-lanes.test.mjs — local wmux lanes as an additional sensor source.
 *
 * The operator failure this covers is a control room reading `PAUSED` while four real
 * Claude/wmux reviews were visibly running. The fix must make the headline truthful without
 * inventing the portfolio binding a local lane genuinely does not have, so most of what is
 * asserted here is what the page still refuses to say.
 *
 * Gates T1-T7 and T16-T19 of the pair-review amendment live in this file, each with the
 * mechanism-revert mutation the pair named beside it.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { summarizeControlRoomActivity } from '../src/control-room-activity.mjs';
import {
  ControlRoomError, buildControlRoomSnapshot, renderControlRoomHtml,
} from '../src/control-room.mjs';
import { sealLocalLaneObservation } from '../src/local-lane-observation.mjs';

const SHA = 'a'.repeat(64);
const AT = '2026-08-30T03:45:00.000Z';
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const ENTRY_COMMIT = '7cbb02670929b8ea8a4c14a55a86245c650a2d24';

const scratch = mkdtempSync(join(tmpdir(), 'gaia-local-lanes-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const reseal = (body) => {
  const { revision, ...rest } = body;
  return { ...rest, revision: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
};

/** Load a one-expression mutant of the shipped module, so a gate can be shown to be a mechanism. */
async function importMutant(name, mutate) {
  const source = readFileSync(join(ROOT, 'src', 'control-room.mjs'), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const rewritten = mutated.replaceAll(
    "from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`,
  );
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, rewritten, 'utf8');
  return import(pathToFileURL(path).href);
}

function projection(items = [], decisions = []) {
  const body = {
    schema: 'gaia-portfolio-drain-projection/1',
    portfolioRevision: SHA,
    effect: 'NONE',
    authority: 'NONE',
    capacity: 4,
    counts: { occupied: 0, available: 4 },
    items,
    decisions,
  };
  return { ...body, revision: createHash('sha256').update(canonicalJson(body)).digest('hex') };
}

const item = (overrides = {}) => ({
  repository: 'GuitarAlchemist/gaia',
  itemKind: 'ISSUE',
  itemId: 'issue-17',
  itemNumber: 17,
  title: 'Integrate the factory control room',
  sourceState: 'READY',
  observedPortfolioRevision: SHA,
  drainState: 'QUEUED',
  hold: null,
  ...overrides,
});

const lane = (n, overrides = {}) => ({
  workspaceId: `ws-${n}`,
  paneId: `pane-${n}`,
  surfaceId: `surf-${n}`,
  agentId: `agent-${n}`,
  label: `Gaia Dashboard UX R0 — Reviewer ${n}`,
  labelState: 'OBSERVED',
  lifecycle: 'RUNNING',
  ...overrides,
});

const observation = (lanes, observedAt = AT) => sealLocalLaneObservation({ observedAt, lanes });

const snapshotWith = (localLanes, extra = {}) => buildControlRoomSnapshot({
  drainProjection: projection(),
  observedAt: AT,
  localLanes,
  ...extra,
});

/** The rendered local-lanes section on its own, so a portfolio word cannot leak into the check. */
function localSection(html) {
  const start = html.indexOf('<section class="section-panel local-lanes"');
  assert.notEqual(start, -1, 'the local wmux lanes section is rendered');
  const end = html.indexOf('</section>', start);
  return html.slice(start, end + '</section>'.length);
}

function stylesheetOf(html) {
  const match = html.match(/<style>([\s\S]*?)<\/style>/u);
  assert.notEqual(match, null, 'the document carries exactly one inline stylesheet');
  return match[1];
}

/** Split a flat stylesheet into its `@media` blocks and everything outside them. */
function cssLayers(css) {
  const blocks = [];
  let base = '';
  let cursor = 0;
  const marker = /@media\s+([^{]+)\{/gu;
  let match = marker.exec(css);
  while (match !== null) {
    base += css.slice(cursor, match.index);
    let depth = 1;
    let index = marker.lastIndex;
    while (depth > 0 && index < css.length) {
      if (css[index] === '{') depth += 1;
      if (css[index] === '}') depth -= 1;
      index += 1;
    }
    blocks.push({ query: match[1].trim(), body: css.slice(marker.lastIndex, index - 1) });
    cursor = index;
    marker.lastIndex = index;
    match = marker.exec(css);
  }
  return { base: base + css.slice(cursor), blocks };
}

function declarationsFor(cssText, selector) {
  const found = [];
  const rule = /([^{}]+)\{([^{}]*)\}/gu;
  let match = rule.exec(cssText);
  while (match !== null) {
    if (match[1].split(',').map((one) => one.trim()).includes(selector)) found.push(match[2]);
    match = rule.exec(cssText);
  }
  return found;
}

const columnsFor = (cssText, selector) => declarationsFor(cssText, selector)
  .flatMap((body) => [...body.matchAll(/grid-template-columns:\s*([^;]+);/gu)])
  .map(([, value]) => {
    const repeated = value.trim().match(/^repeat\(\s*(\d+)\s*,/u);
    return repeated ? Number(repeated[1]) : value.trim().split(/\s+(?![^(]*\))/u).length;
  });

// ---------------------------------------------------------------------------
// T1 — an absent observation moves no published revision
// ---------------------------------------------------------------------------

test('T1: a snapshot with no local lanes keeps the revision it had at the entry commit', async () => {
  const entrySource = execFileSync(
    'git', ['show', `${ENTRY_COMMIT}:src/control-room.mjs`],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  );
  const entryPath = join(scratch, 'entry-control-room.mjs');
  writeFileSync(entryPath, entrySource.replaceAll(
    "from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`,
  ), 'utf8');
  const entry = await import(pathToFileURL(entryPath).href);

  const fixtures = [
    { drainProjection: projection(), observedAt: AT },
    { drainProjection: projection([item()]), observedAt: AT },
    {
      drainProjection: projection([item({ drainState: 'RUNNING' }), item({
        itemId: 'issue-18', itemNumber: 18, drainState: 'BLOCKED_EVIDENCE',
        sourceState: 'EVIDENCE_UNKNOWN',
      })]),
      observedAt: AT,
    },
  ];

  for (const fixture of fixtures) {
    const before = entry.buildControlRoomSnapshot(fixture);
    const after = buildControlRoomSnapshot(fixture);
    assert.equal(
      after.revision, before.revision,
      'adding a sensor must not move a published revision for evidence that did not change',
    );
    assert.equal(canonicalJson(after), canonicalJson(before));
    assert.equal(Object.hasOwn(after, 'localLanes'), false, 'the key is omitted, never null');
  }
});

test('T1 MECHANISM REVERT: publishing the key as null is what would move every revision', async () => {
  const mutant = await importMutant('always-null-local-lanes', (source) => source.replace(
    '...(localLaneBlock === null ? {} : { localLanes: localLaneBlock }),',
    'localLanes: localLaneBlock,',
  ));
  const fixture = { drainProjection: projection([item()]), observedAt: AT };

  assert.notEqual(
    mutant.buildControlRoomSnapshot(fixture).revision,
    buildControlRoomSnapshot(fixture).revision,
    'the omission is what preserves the digest, so reverting it must move the digest',
  );
});

test('a present but null local lane block is refused rather than read as absence', () => {
  const snapshot = buildControlRoomSnapshot({ drainProjection: projection(), observedAt: AT });

  assert.throws(
    () => renderControlRoomHtml(reseal({ ...snapshot, localLanes: null })),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot',
  );
});

// ---------------------------------------------------------------------------
// T4 / T5 — the operator failure this exists to fix
// ---------------------------------------------------------------------------

test('T4: a fresh observation with running lanes makes the headline ACTIVE with a real pulse', () => {
  const snapshot = snapshotWith(observation([lane(1), lane(2), lane(3), lane(4)]));

  assert.equal(snapshot.headline.state, 'ACTIVE');
  assert.equal(snapshot.showSpinner, true);
  assert.equal(snapshot.localLanes.state, 'FRESH');
  assert.equal(snapshot.localLanes.liveCount, 4);
  assert.equal(snapshot.localLanes.showPulse, true);
  assert.equal(snapshot.localLanes.observationAgeMs, 0);
  assert.match(snapshot.headline.detail, /4 local wmux lanes are running/u);
  assert.match(snapshot.headline.detail, /no tracked portfolio binding/u);
  assert.equal(snapshot.activeCount, 0, 'and no portfolio run was invented to carry them');
  assert.equal(snapshot.nextAction.kind, 'OBSERVE_LOCAL_LANE');

  const html = renderControlRoomHtml(snapshot);
  assert.match(html, /class="lane-pulse"/u);
  assert.match(localSection(html), /role="status"/u);
});

test('T4 MECHANISM REVERT: the liveness term is what makes the headline ACTIVE', async () => {
  const mutant = await importMutant('no-live-count-term', (source) => source.replace(
    "  if (activeCount > 0 || localLiveCount > 0) return 'ACTIVE';",
    "  if (activeCount > 0) return 'ACTIVE';",
  ));

  assert.equal(
    mutant.buildControlRoomSnapshot({
      drainProjection: projection(), observedAt: AT, localLanes: observation([lane(1)]),
    }).headline.state,
    'PAUSED',
    'without the term the operator failure returns, which is what the term is for',
  );
});

test('T5: a paused drain observed beside exited lanes stays PAUSED and never animates', () => {
  const snapshot = snapshotWith(observation([
    lane(1, { lifecycle: 'EXITED' }),
    lane(2, { lifecycle: 'EXITED' }),
    lane(3, { lifecycle: 'UNKNOWN' }),
  ]));

  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.localLanes.state, 'FRESH', 'the observation itself is fresh');
  assert.equal(snapshot.localLanes.runningCount, 0);
  assert.equal(snapshot.localLanes.liveCount, 0);
  assert.equal(snapshot.localLanes.showPulse, false);
  assert.equal(snapshot.nextAction.kind, 'NONE');

  const html = renderControlRoomHtml(snapshot);
  assert.doesNotMatch(html, /@keyframes/u, 'nothing animates at all');
  assert.doesNotMatch(html, /class="lane-pulse"/u);
  assert.match(localSection(html), /Exited/u, 'and the exited lanes are still listed');
});

test('T5 MECHANISM REVERT: mapping exited to running is what would falsely animate', async () => {
  const mutant = await importMutant('exited-is-live', (source) => source.replace(
    "    live: state === 'FRESH' && lane.lifecycle === LOCAL_LANE_LIVE_LIFECYCLE,",
    "    live: state === 'FRESH',",
  ));

  assert.equal(
    mutant.buildControlRoomSnapshot({
      drainProjection: projection(),
      observedAt: AT,
      localLanes: observation([lane(1, { lifecycle: 'EXITED' })]),
    }).headline.state,
    'ACTIVE',
    'so the lifecycle test is what keeps an exited pane out of the headline',
  );
});

// ---------------------------------------------------------------------------
// T2 — the freshness boundary
// ---------------------------------------------------------------------------

test('T2: the observation window is inclusive at its boundary and stale one millisecond later', () => {
  const at = Date.parse(AT);
  const exactly = snapshotWith(observation([lane(1)], new Date(at - 30_000).toISOString()));
  const past = snapshotWith(observation([lane(1)], new Date(at - 30_001).toISOString()));

  assert.equal(exactly.localLanes.observationAgeMs, 30_000);
  assert.equal(exactly.localLanes.state, 'FRESH');
  assert.equal(exactly.localLanes.showPulse, true);
  assert.equal(exactly.headline.state, 'ACTIVE');

  assert.equal(past.localLanes.observationAgeMs, 30_001);
  assert.equal(past.localLanes.state, 'STALE');
  assert.equal(past.localLanes.showPulse, false);
  assert.equal(past.headline.state, 'PAUSED');
  assert.doesNotMatch(renderControlRoomHtml(past), /@keyframes/u);
});

test('T2 MECHANISM REVERT: both directions of the boundary comparison must fail', async () => {
  const at = Date.parse(AT);
  const boundary = observation([lane(1)], new Date(at - 30_000).toISOString());
  const inside = observation([lane(1)], new Date(at - 29_999).toISOString());

  const strict = await importMutant('boundary-strict', (source) => source.replace(
    "observationAgeMs <= LOCAL_LANE_OBSERVATION_FRESH_MS ? 'FRESH' : 'STALE'",
    "observationAgeMs < LOCAL_LANE_OBSERVATION_FRESH_MS ? 'FRESH' : 'STALE'",
  ));
  assert.equal(
    strict.buildControlRoomSnapshot({
      drainProjection: projection(), observedAt: AT, localLanes: boundary,
    }).localLanes.state,
    'STALE',
    'a strict comparison loses the boundary instant',
  );

  const inverted = await importMutant('boundary-inverted', (source) => source.replace(
    "observationAgeMs <= LOCAL_LANE_OBSERVATION_FRESH_MS ? 'FRESH' : 'STALE'",
    "observationAgeMs >= LOCAL_LANE_OBSERVATION_FRESH_MS ? 'FRESH' : 'STALE'",
  ));
  assert.equal(
    inverted.buildControlRoomSnapshot({
      drainProjection: projection(), observedAt: AT, localLanes: inside,
    }).localLanes.state,
    'STALE',
    'an inverted comparison calls a one-second-old reading stale',
  );
});

test('STALE: an observation past the window is explicit, never animated', () => {
  const snapshot = snapshotWith(observation([lane(1), lane(2)], '2026-08-30T03:44:00.000Z'));

  assert.equal(snapshot.localLanes.state, 'STALE');
  assert.equal(snapshot.localLanes.observationAgeMs, 60_000);
  assert.equal(snapshot.localLanes.runningCount, 2, 'the lanes still say what they said');
  assert.equal(snapshot.localLanes.liveCount, 0, 'but stale evidence proves no lane is alive');
  assert.equal(snapshot.showSpinner, false);

  const html = renderControlRoomHtml(snapshot);
  assert.doesNotMatch(html, /@keyframes/u);
  assert.doesNotMatch(html, /class="lane-pulse"/u);
  assert.match(html, /<section class="section-panel local-lanes"[^>]*\n?\s*data-state="STALE"/u);
  assert.match(localSection(html), /Stale observation/u);
  assert.match(localSection(html), /1m/u, 'and its measured age is stated');
});

test('MISSING: no observation renders exactly as before and animates nothing', () => {
  const without = buildControlRoomSnapshot({ drainProjection: projection(), observedAt: AT });

  assert.equal(Object.hasOwn(without, 'localLanes'), false);
  assert.equal(without.headline.state, 'PAUSED');
  assert.equal(without.showSpinner, false);
  const html = renderControlRoomHtml(without);
  assert.equal(html.includes('local-lanes'), false, 'no empty section is rendered');
  assert.doesNotMatch(html, /@keyframes/u);
});

// ---------------------------------------------------------------------------
// T12 and the refusals
// ---------------------------------------------------------------------------

test('T12: an observation dated after the instant it was observed is a typed refusal', () => {
  assert.throws(
    () => snapshotWith(observation([lane(1)], '2026-08-30T03:45:00.001Z')),
    (error) => error instanceof ControlRoomError && error.code === 'IncoherentEvidence',
    'evidence from the future is refused, never clamped to a reassuring zero age',
  );
});

test('T12 MECHANISM REVERT: clamping instead of refusing produces the reassuring zero age', async () => {
  const mutant = await importMutant('clamp-future-lane', (source) => source.replace(
    '  if (observationMs > observedAtMs) {',
    '  if (false) {',
  ));

  const snapshot = mutant.buildControlRoomSnapshot({
    drainProjection: projection(),
    observedAt: AT,
    localLanes: observation([lane(1)], '2999-12-31T00:00:00.000Z'),
  });
  assert.equal(
    snapshot.localLanes.observationAgeMs < 0, true,
    'a clamped future observation renders an age nobody measured',
  );
});

test('CORRUPT: a tampered or extra-field observation is refused at the control-room seam', () => {
  const good = observation([lane(1)]);

  assert.throws(
    () => snapshotWith({ ...good, lanes: [{ ...good.lanes[0], lifecycle: 'EXITED' }] }),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidLocalLanes',
    'an edit that does not match the digest is refused',
  );
  assert.throws(
    () => snapshotWith(reseal({ ...good, cmd: 'pwsh -File secret.ps1' })),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidLocalLanes',
    'an extra field is refused even when the digest was recomputed over it',
  );
  assert.throws(
    () => snapshotWith(reseal({ ...good, schema: 'gaia-local-lane-observation/2' })),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidLocalLanes',
  );
  assert.throws(
    () => snapshotWith('{"lanes":[]}'),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidLocalLanes',
  );
});

// ---------------------------------------------------------------------------
// T6 — the verify seam re-derives rather than believes
// ---------------------------------------------------------------------------

test('T6: a resealed snapshot cannot inflate liveCount, showPulse or the headline', () => {
  const stale = snapshotWith(observation([lane(1)], '2026-08-30T03:44:00.000Z'));

  const forgeries = {
    'an inflated live count and pulse': {
      showSpinner: true,
      localLanes: {
        ...stale.localLanes,
        state: 'FRESH',
        showPulse: true,
        liveCount: 1,
        lanes: [{ ...stale.localLanes.lanes[0], live: true }],
      },
    },
    'a stretched observation age': {
      localLanes: { ...stale.localLanes, observationAgeMs: 999_999 },
    },
    'a forged headline': {
      headline: { state: 'ACTIVE', label: 'Active', detail: '4 lanes are running.' },
    },
    'a forged active count': { activeCount: 3 },
  };

  for (const [why, patch] of Object.entries(forgeries)) {
    assert.throws(
      () => renderControlRoomHtml(reseal({ ...stale, ...patch })),
      (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot',
      `${why} must be refused by re-derivation, not believed`,
    );
  }
});

test('T6 MECHANISM REVERT: trusting the published block is what would render the forgery', async () => {
  const stale = snapshotWith(observation([lane(1)], '2026-08-30T03:44:00.000Z'));
  const forged = reseal({
    ...stale,
    showSpinner: true,
    localLanes: {
      ...stale.localLanes,
      state: 'FRESH',
      showPulse: true,
      liveCount: 1,
      lanes: [{ ...stale.localLanes.lanes[0], live: true }],
    },
    headline: { state: 'ACTIVE', label: 'Active', detail: 'forged' },
    activeCount: 0,
  });

  const mutant = await importMutant('trust-published-block', (source) => source
    .replace('  requireDerivedCounts(value, localLanes);\n', '')
    .replace(
      "    refuse('the snapshot local lane block is not what its own lanes and instants derive');",
      '    void expected;',
    ));

  assert.doesNotThrow(
    () => mutant.renderControlRoomHtml(forged),
    'without re-derivation the forgery renders, which is why re-derivation is the mechanism',
  );
});

// ---------------------------------------------------------------------------
// T16 — no portfolio binding
// ---------------------------------------------------------------------------

test('T16: a local lane invents no repository, issue, pull request, percentage, pace or ETA', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: AT,
    localLanes: observation([lane(1)]),
  });

  assert.equal(snapshot.localLanes.binding, 'NONE');
  assert.deepEqual(Object.keys(snapshot.localLanes.lanes[0]).sort(), [
    'agentId', 'label', 'labelState', 'lifecycle', 'live', 'paneId', 'surfaceId', 'workspaceId',
  ]);
  // Keys, not a substring scan: `workspaceId` contains "pace", and a scan that cannot tell those
  // apart is a gate that fires on its own vocabulary.
  const keys = new Set();
  const values = [];
  (function walk(node) {
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (!node || typeof node !== 'object') { if (typeof node === 'string') values.push(node); return; }
    for (const [key, value] of Object.entries(node)) { keys.add(key.toLowerCase()); walk(value); }
  }(snapshot.localLanes));
  for (const forbidden of [
    'repository', 'itemnumber', 'itemkind', 'itemid', 'issue', 'pullrequest', 'percentage',
    'progress', 'pace', 'eta', 'drainstate', 'sourcestate', 'hold',
  ]) {
    assert.equal(keys.has(forbidden), false, `the lane block carries a ${forbidden} field`);
  }
  assert.equal(
    values.some((value) => value.includes('GuitarAlchemist')), false,
    'and no lane value carries a repository identity',
  );
  assert.equal(snapshot.totalItems, 1, 'the portfolio still has exactly its own items');
  assert.equal(snapshot.blockedCount, 0, 'a lane is not a backlog entry');
  assert.equal(snapshot.pace.sampleSize, 0, 'nor a pace sample');
  assert.equal(snapshot.eta.state, 'UNKNOWN');
  assert.equal(snapshot.portfolioCompletion.percentage, null);

  const section = localSection(renderControlRoomHtml(snapshot));
  assert.equal(section.includes('GuitarAlchemist/gaia'), false, 'no repository value is shown');
  assert.doesNotMatch(section, /<progress/u, 'no completion meter is rendered for a lane');
  assert.doesNotMatch(section, /\d+\s*%/u, 'no percentage is shown');
  assert.doesNotMatch(section, /#\d/u, 'no issue or pull request number is shown');
});

test('T16 MECHANISM REVERT: copying one portfolio field onto a lane must break the gate', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: AT,
    localLanes: observation([lane(1)]),
  });
  const poisoned = { ...snapshot.localLanes.lanes[0], repository: 'GuitarAlchemist/gaia' };

  assert.equal(
    canonicalJson([poisoned]).includes('repository'), true,
    'the scan that would catch it is a scan of the published block, so it does catch it',
  );
  assert.throws(
    () => renderControlRoomHtml(reseal({
      ...snapshot,
      localLanes: { ...snapshot.localLanes, lanes: [poisoned] },
    })),
    (error) => error instanceof ControlRoomError && error.code === 'InvalidSnapshot',
    'and the verify seam refuses the lane outright',
  );
});

test('local lanes are rendered separately from GitHub portfolio work and labelled LOCAL_WMUX', () => {
  const snapshot = buildControlRoomSnapshot({
    drainProjection: projection([item()]),
    observedAt: AT,
    localLanes: observation([lane(1)]),
  });
  const html = renderControlRoomHtml(snapshot);

  assert.match(html, /<section class="section-panel local-lanes" data-source="LOCAL_WMUX"/u);
  assert.match(localSection(html), /LOCAL_WMUX/u);
  assert.equal(
    html.indexOf('class="section-panel local-lanes"') < html.indexOf('class="work-list"'), true,
    'the lanes come before the portfolio progress rather than inside it',
  );
  assert.match(html, /GuitarAlchemist\/gaia/u, 'and the portfolio section is still rendered');
});

// ---------------------------------------------------------------------------
// T7 — the activity summary is inert under local lanes
// ---------------------------------------------------------------------------

test('T7: two snapshots differing only in local lanes summarize byte-identically', () => {
  const drain = projection([item({ drainState: 'RUNNING' })]);
  const without = summarizeControlRoomActivity({
    snapshot: buildControlRoomSnapshot({ drainProjection: drain, observedAt: AT }),
  });
  const with_ = summarizeControlRoomActivity({
    snapshot: buildControlRoomSnapshot({
      drainProjection: drain, observedAt: AT, localLanes: observation([lane(1), lane(2)]),
    }),
  });

  assert.equal(with_.contentRevision, without.contentRevision);
  assert.equal(canonicalJson(with_.items), canonicalJson(without.items));
  assert.equal(
    canonicalJson(with_).includes('LOCAL_WMUX'), false,
    'no local lane token reaches the sentences at all',
  );
});

// ---------------------------------------------------------------------------
// what the operator reads
// ---------------------------------------------------------------------------

test('each lane is one concise bullet: label, lifecycle, workspace and pane, and its age', () => {
  const html = renderControlRoomHtml(snapshotWith(observation(
    [lane(1), lane(2, { lifecycle: 'EXITED' })], '2026-08-30T03:44:55.000Z',
  )));
  const section = localSection(html);

  assert.match(section, /Gaia Dashboard UX R0 — Reviewer 1/u);
  assert.match(section, /Running/u);
  assert.match(section, /Exited/u);
  assert.match(section, /ws-1/u);
  assert.match(section, /pane-1/u);
  assert.match(section, /5s/u, 'the observation age is stated');
  assert.match(section, /data-surface-id="surf-1"/u, 'and the full identity is still carried');
  assert.match(section, /data-agent-id="agent-1"/u);

  const bullets = [...section.matchAll(/<li class="local-lane"/gu)];
  assert.equal(bullets.length, 2, 'one bullet per lane, and no second list');
});

test('the pulse is process liveness in words, ages against the sensor, and is never a heartbeat', () => {
  const html = renderControlRoomHtml(snapshotWith(observation([lane(1)])));
  const section = localSection(html);

  assert.match(section, /Process alive/u, 'the pulse says what it means in words');
  assert.match(section, /Process liveness only/u);
  assert.match(section, /data-observed-at="2026-08-30T03:45:00\.000Z"/u);
  assert.equal(
    section.includes('data-heartbeat-at'), false,
    'a sensor poll is not a heartbeat and must not be aged as one',
  );
  assert.doesNotMatch(section, /<progress/u, 'and no meter is rendered for a lane');
});

test('a withheld or absent label is named as such and never rendered as a name', () => {
  const section = localSection(renderControlRoomHtml(snapshotWith(observation([
    lane(1, { label: null, labelState: 'WITHHELD_UNSAFE' }),
    lane(2, { label: null, labelState: 'ABSENT' }),
  ]))));

  assert.match(section, /Label withheld as unsafe/u);
  assert.match(section, /No label observed/u);
  assert.match(section, /data-label-state="WITHHELD_UNSAFE"/u);
  assert.match(section, /data-label-state="ABSENT"/u);
  assert.match(section, /<li class="local-lane"[\s\S]*?<li class="local-lane"/u, 'both are shown');
});

test('no command line, prompt or screen text can reach the rendered page', () => {
  const html = renderControlRoomHtml(snapshotWith(observation([lane(1)])));

  for (const forbidden of [/pwsh/iu, /--cmd/u, /prompt/iu, /stdout/iu, /read-screen/u]) {
    assert.doesNotMatch(html, forbidden);
  }
});

test('a label with HTML-significant characters is escaped, never rendered as markup', () => {
  const html = renderControlRoomHtml(snapshotWith(observation([
    lane(1, { label: 'Gaia R&D — Steph’s lane' }),
  ])));
  const section = localSection(html);

  assert.match(section, /Gaia R&amp;D — Steph’s lane/u);
  assert.equal(section.includes('R&D'), false, 'the raw ampersand never reaches the page');
  assert.equal(html.includes('<script>alert'), false);
});

test('B5: an observed pane count past the supported lane ceiling is reported, not normalised', () => {
  const many = [1, 2, 3, 4, 5].map((n) => lane(n, { workspaceId: 'ws-one' }));
  const snapshot = snapshotWith(observation(many));

  assert.equal(snapshot.localLanes.liveCount, 5);
  assert.equal(snapshot.localLanes.supportedLaneLimit, 4);
  assert.equal(snapshot.localLanes.overSupportedLaneLimit, true);
  assert.match(localSection(renderControlRoomHtml(snapshot)), /Reported, not enforced/u);

  const within = snapshotWith(observation(many.slice(0, 4)));
  assert.equal(within.localLanes.overSupportedLaneLimit, false);
  assert.equal(within.localLanes.laneCount, 4, 'and nothing is dropped either way');
});

test('the published snapshot and document are deterministic for identical evidence', () => {
  const inputs = () => ({
    drainProjection: projection([item()]),
    observedAt: AT,
    localLanes: observation([lane(2), lane(1)]),
  });

  const once = buildControlRoomSnapshot(inputs());
  const twice = buildControlRoomSnapshot(inputs());

  assert.equal(once.revision, twice.revision);
  assert.equal(canonicalJson(once), canonicalJson(twice));
  assert.equal(renderControlRoomHtml(once), renderControlRoomHtml(twice));
});

// ---------------------------------------------------------------------------
// T18 / T19 — layout, semantics and language
// ---------------------------------------------------------------------------

test('T19: the French document translates the whole section and leaks no English copy', () => {
  const snapshot = snapshotWith(observation([
    lane(1), lane(2, { lifecycle: 'EXITED' }), lane(3, { label: null, labelState: 'ABSENT' }),
  ], '2026-08-30T03:44:00.000Z'));
  const section = localSection(renderControlRoomHtml(snapshot, { language: 'fr' }));

  assert.match(section, /Lanes wmux locales/u);
  assert.match(section, /En cours/u);
  assert.match(section, /Terminé/u);
  assert.match(section, /Aucun libellé observé/u);
  assert.match(section, /Vivacité de processus uniquement/u);
  assert.match(section, /Observation périmée/u);
  for (const english of [
    'Local wmux lanes', 'Process liveness only', 'Process alive', 'Running', 'Exited',
    'No label observed', 'Label withheld as unsafe', 'Stale observation', 'Fresh observation',
    'observation age', 'The sensor last reported',
  ]) {
    assert.equal(section.includes(english), false, `the French section leaks "${english}"`);
  }
});

test('T18: the lane list is one phone column and uses the width a desktop has', () => {
  const { base, blocks } = cssLayers(stylesheetOf(
    renderControlRoomHtml(snapshotWith(observation([lane(1), lane(2), lane(3), lane(4)]))),
  ));

  assert.deepEqual(
    columnsFor(base, '.local-lane-list').filter((count) => count > 1), [],
    'a phone would scroll sideways if the base rule were multi-column',
  );
  const fixed = [...declarationsFor(base, '.local-lane-list').join(';')
    .matchAll(/(?:min-)?width:\s*(\d+)px/gu)].map(([, px]) => Number(px));
  assert.deepEqual(fixed.filter((px) => px > 320), [], 'no rule is wider than the narrow viewport');

  for (const [query, minimum] of [['768px', 2], ['1024px', 3], ['1440px', 4]]) {
    const layer = blocks.find(({ query: q }) => q.includes(`min-width: ${query}`));
    assert.notEqual(layer, undefined, `a ${query} breakpoint exists`);
    assert.equal(
      Math.max(0, ...columnsFor(layer.body, '.local-lane-list')) >= minimum, true,
      `${query} must use the width it has instead of leaving a narrow strip`,
    );
  }
});

test('T18: exactly one keyframe block, and reduced motion names every animated class', () => {
  const html = renderControlRoomHtml(snapshotWith(observation([lane(1)])));
  const { blocks } = cssLayers(stylesheetOf(html));

  assert.equal([...stylesheetOf(html).matchAll(/@keyframes/gu)].length, 1);
  const reduced = blocks.find(({ query }) => query.includes('prefers-reduced-motion: reduce'));
  assert.notEqual(reduced, undefined);
  assert.match(reduced.body, /\.lane-pulse\s*\{[^}]*animation:\s*none/u);
  assert.match(reduced.body, /\.heartbeat-pulse\s*\{[^}]*animation:\s*none/u);

  const animated = new Set([...stylesheetOf(html).matchAll(
    /([.\w-]+)\s*\{[^}]*animation:\s*heartbeat/gu,
  )].map(([, selector]) => selector.trim()));
  for (const selector of animated) {
    assert.equal(
      declarationsFor(reduced.body, selector).some((body) => /animation:\s*none/u.test(body)), true,
      `${selector} animates and is not switched off under reduced motion`,
    );
  }
});

test('T18: lane status carries a word and a symbol, and the symbol is hidden from assistive tech', () => {
  const section = localSection(renderControlRoomHtml(snapshotWith(observation([
    lane(1), lane(2, { lifecycle: 'EXITED' }), lane(3, { lifecycle: 'UNKNOWN' }),
  ]))));

  for (const [lifecycle, word] of [
    ['RUNNING', 'Running'], ['EXITED', 'Exited'], ['UNKNOWN', 'Unknown'],
  ]) {
    assert.match(section, new RegExp(`data-lifecycle="${lifecycle}"`, 'u'));
    assert.match(section, new RegExp(word, 'u'), `${lifecycle} is a word, not only a colour`);
  }
  for (const symbol of [...section.matchAll(/<span class="semantic-symbol"([^>]*)>/gu)]) {
    assert.match(symbol[1], /aria-hidden="true"/u);
  }
  assert.match(section, /aria-label="[^"]+"/u, 'the section names itself for assistive tech');
});

// ---------------------------------------------------------------------------
// the rest of the control room is unchanged in authority
// ---------------------------------------------------------------------------

test('local lanes change nothing about portfolio authority, obstruction or the telemetry spine', () => {
  const drain = projection([item({ drainState: 'BLOCKED_EVIDENCE', sourceState: 'EVIDENCE_UNKNOWN' })]);
  const bare = buildControlRoomSnapshot({ drainProjection: drain, observedAt: AT });
  const withLanes = buildControlRoomSnapshot({
    drainProjection: drain, observedAt: AT, localLanes: observation([lane(1)]),
  });

  for (const field of [
    'items', 'blockers', 'blockedCount', 'capacity', 'obstruction', 'telemetry', 'pace', 'eta',
    'knowledgeCoverage', 'portfolioCompletion', 'activeCount', 'staleCount', 'totalItems',
    'sourceRevision', 'sourceChangedAt', 'sourceChangedAtBasis',
  ]) {
    assert.equal(
      canonicalJson(withLanes[field]), canonicalJson(bare[field]),
      `${field} moved because a local lane was observed`,
    );
  }
  assert.equal(withLanes.effect, 'NONE');
  assert.equal(withLanes.authority, 'NONE');
  assert.equal(withLanes.localLanes.source, 'LOCAL_WMUX');
});
