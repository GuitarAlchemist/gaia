/**
 * control-room-engineering-flow.test.mjs — the flow block as a published, re-derived, rendered
 * section of the control room.
 *
 * Gates C1-C11 and the two mechanism reverts MR1/MR2 of `docs/engineering-flow-throughput.md`.
 *
 * The operator failure behind this file is that a control room could say "six panes are alive" and
 * "nothing tracked is claimed" and could not say whether the engineering queue moved. The danger
 * in fixing that is re-conflating the two, so most of what is asserted here is what the flow
 * section still refuses to touch: the headline, the spinner, the next action and the obstruction.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runFactoryDashboardCli } from '../scripts/factory-dashboard.mjs';
import {
  ControlRoomError, buildControlRoomSnapshot, renderControlRoomHtml, requireControlRoomSnapshot,
} from '../src/control-room.mjs';
import { sealEngineeringFlow } from '../src/engineering-flow.mjs';
import { sealLocalLaneObservation } from '../src/local-lane-observation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const SHA = 'a'.repeat(64);
const SOURCE_SHA = '9df446ffa6b5ea2fc06d51eb29a5dbbe1bcc8732a73b45854bd57db6510183a9';
const AT = '2026-08-30T18:10:00.000Z';
const WINDOW_START = '2026-08-16T18:10:00.000Z';
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const scratch = mkdtempSync(join(tmpdir(), 'gaia-flow-'));
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

/** Reseal a tampered snapshot, so the digest can never stand in for the re-derivation gate. */
const reseal = (body) => {
  const { revision, ...rest } = body;
  return { ...rest, revision: createHash('sha256').update(canonicalJson(rest)).digest('hex') };
};

/** Load a one-expression mutant of a shipped module, so a gate can be shown to be a mechanism. */
async function importMutant(file, name, mutate) {
  const source = readFileSync(join(ROOT, 'src', file), 'utf8');
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

const at = (msBefore) => new Date(Date.parse(AT) - msBefore).toISOString();

const event = (overrides = {}) => ({
  eventId: 'i-close-a',
  occurredAt: at(20 * 60_000),
  family: 'ISSUE',
  outcome: 'CLOSED',
  repository: 'GuitarAlchemist/gaia',
  workItemId: 'issue-17',
  startedAt: null,
  sourceKind: 'GITHUB_EVENT',
  sourceRevision: SOURCE_SHA,
  ...overrides,
});

const HISTORY = [
  event({ eventId: 'i-open-a', occurredAt: at(29 * 60_000), outcome: 'OPENED', workItemId: 'issue-1' }),
  event({ eventId: 'i-close-a', occurredAt: at(20 * 60_000), outcome: 'CLOSED', workItemId: 'issue-2' }),
  event({ eventId: 'i-close-b', occurredAt: at(8 * HOUR_MS), outcome: 'CLOSED', workItemId: 'issue-3' }),
];

const flow = (events = HISTORY, overrides = {}) => sealEngineeringFlow({
  observedAt: AT, windowStartedAt: WINDOW_START, sequence: 41, events, ...overrides,
});

/** An artifact complete for two hours only: the hour is measured, the day and week are not. */
const partialFlow = () => sealEngineeringFlow({
  observedAt: AT,
  windowStartedAt: at(2 * HOUR_MS),
  sequence: 7,
  events: [event({ eventId: 'i-close', occurredAt: at(30 * 60_000) })],
});

const snapshotWith = (engineeringFlow, extra = {}) => buildControlRoomSnapshot({
  drainProjection: projection(),
  observedAt: AT,
  engineeringFlow,
  ...extra,
});

const render = (snapshot, options = {}) => renderControlRoomHtml(snapshot, options);

const styleOf = (html) => html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
const baseCss = (html) => {
  const style = styleOf(html);
  return style.slice(0, style.indexOf('@media'));
};
const mediaCss = (html, min) => {
  const style = styleOf(html);
  const start = style.indexOf(`@media (min-width: ${min}px) {`);
  assert.notEqual(start, -1, `there is a ${min}px breakpoint`);
  const end = style.indexOf('\n    }', start);
  assert.notEqual(end, -1, `the ${min}px breakpoint closes`);
  return style.slice(start, end);
};

/** The rendered flow section on its own, so a gate cannot accidentally pass on other markup. */
function flowSection(html) {
  const start = html.indexOf('<section class="section-panel engineering-flow"');
  assert.notEqual(start, -1, 'the flow section is rendered');
  const end = html.indexOf('</section>', start);
  assert.notEqual(end, -1, 'the flow section closes');
  return html.slice(start, end + '</section>'.length);
}

const cellOf = (html, family, window) => {
  const section = flowSection(html);
  const marker = `data-family="${family}" data-window="${window}"`;
  const start = section.indexOf(marker);
  assert.notEqual(start, -1, `the ${family}/${window} cell is rendered`);
  const open = section.lastIndexOf('<li', start);
  const end = section.indexOf('</li>', start);
  return section.slice(open, end);
};

/**
 * The count reading of one cell, on its own.
 *
 * Scoped deliberately. A MEASURED cell legitimately contains an UNKNOWN cycle-time sub-cell — a
 * window can have been fully observed and still hold too few comparable durations — so asserting
 * "the word UNKNOWN appears nowhere in a measured cell" would be asserting the wrong thing. What
 * must never be confusable is the COUNT, and that is exactly this span.
 */
const readingOf = (cell) => {
  const match = /<span class="flow-reading">(.*?)<\/span>/su.exec(cell);
  assert.notEqual(match, null, 'the cell states its reading in words');
  return match[1];
};

/** The cell's own opening tag, so a sub-cell's reason cannot be mistaken for the cell's. */
const openTagOf = (cell) => cell.slice(0, cell.indexOf('>') + 1);

const totalOf = (cell) => {
  const match = /<strong class="flow-total">(.*?)<\/strong>/su.exec(cell);
  assert.notEqual(match, null, 'the cell states its total');
  return match[1];
};

// ---------------------------------------------------------------------------------------------
// C1 — an absent artifact moves nothing; a present null is refused.
// ---------------------------------------------------------------------------------------------

test('C1: with no artifact the key is omitted entirely and the snapshot revision does not move', () => {
  const without = snapshotWith(null);
  const omitted = buildControlRoomSnapshot({ drainProjection: projection(), observedAt: AT });

  assert.equal(Object.hasOwn(without, 'engineeringFlow'), false, 'the key is absent, not null');
  assert.equal(without.revision, omitted.revision, 'passing null is the same as not passing it');

  // Removing the feature leaves a document with no residue of it at all.
  const html = render(without);
  assert.equal(html.includes('engineering-flow'), false);
  assert.equal(html.includes('flow-family-list'), false);
  assert.equal(html.includes('GAIA_ENGINEERING_FLOW'), false);
});

test('C1: a published block spelled as null is refused rather than read as absence', () => {
  const tampered = reseal({ ...snapshotWith(null), engineeringFlow: null });
  assert.throws(
    () => requireControlRoomSnapshot(tampered),
    (error) => error instanceof ControlRoomError,
    'a present null is refused',
  );
});

test('C1: a present artifact publishes the block and re-verifies unchanged', () => {
  const snapshot = snapshotWith(flow());
  assert.equal(snapshot.engineeringFlow.source, 'GAIA_ENGINEERING_FLOW');
  assert.equal(snapshot.engineeringFlow.binding, 'NONE');
  assert.equal(snapshot.engineeringFlow.sequence, 41);
  assert.equal(snapshot.engineeringFlow.eventCount, 3);
  assert.equal(snapshot.engineeringFlow.artifactRevision, flow().revision);
  assert.deepEqual(requireControlRoomSnapshot(snapshot), snapshot);
});

test('C1: an artifact dated after the snapshot instant is refused, never aged to zero', () => {
  const future = sealEngineeringFlow({
    observedAt: at(-1000), windowStartedAt: WINDOW_START, sequence: 41, events: [],
  });
  assert.throws(
    () => snapshotWith(future),
    (error) => error instanceof ControlRoomError && error.code === 'IncoherentEvidence',
    'future flow evidence is refused',
  );
});

test('C1: an unverifiable artifact is a typed control-room refusal, not a raw throw', () => {
  for (const candidate of [
    { schema: 'gaia-engineering-flow/1' },
    { ...flow(), revision: 'b'.repeat(64) },
    { ...flow(), authority: 'ADMIN' },
    42,
    'artifact',
  ]) {
    assert.throws(
      () => snapshotWith(candidate),
      (error) => error instanceof ControlRoomError,
      `${JSON.stringify(candidate)?.slice(0, 40)} is a typed refusal`,
    );
  }
});

test('C1: the publisher refuses a source snapshot that went backwards', () => {
  const prior = { observedAt: AT, sequence: 41 };
  assert.throws(
    () => snapshotWith(flow(HISTORY, { sequence: 40 }), { priorEngineeringFlow: prior }),
    (error) => error instanceof ControlRoomError,
    'a lower sequence is refused',
  );
  assert.equal(
    snapshotWith(flow(), { priorEngineeringFlow: prior }).engineeringFlow.sequence, 41,
  );
});

// ---------------------------------------------------------------------------------------------
// C2 — the block never touches the headline, spinner, next action or obstruction.
// ---------------------------------------------------------------------------------------------

test('C2: two snapshots differing only in their flow artifact agree on every liveness field', () => {
  const busy = snapshotWith(flow([
    ...HISTORY,
    event({
      eventId: 'pr-merged', occurredAt: at(5 * 60_000), family: 'PULL_REQUEST', outcome: 'MERGED',
      workItemId: 'pr-1',
    }),
  ]));
  const quiet = snapshotWith(flow([]));
  const none = snapshotWith(null);

  for (const field of ['headline', 'showSpinner', 'nextAction', 'obstruction']) {
    assert.equal(
      canonicalJson(busy[field]), canonicalJson(quiet[field]),
      `${field} is byte-identical across a busy and an empty flow artifact`,
    );
    assert.equal(
      canonicalJson(busy[field]), canonicalJson(none[field]),
      `${field} is byte-identical with and without a flow artifact`,
    );
  }
  // The counts an operator reads as liveness are untouched too.
  for (const field of ['activeCount', 'staleCount', 'blockedCount', 'pace', 'eta']) {
    assert.equal(canonicalJson(busy[field]), canonicalJson(none[field]), `${field} is untouched`);
  }
});

test('C2: a busy flow artifact cannot make a paused control room look active', () => {
  const snapshot = snapshotWith(flow());
  assert.equal(snapshot.headline.state, 'PAUSED');
  assert.equal(snapshot.showSpinner, false);
  assert.equal(snapshot.nextAction.kind, 'NONE');
});

test('C2: throughput and process liveness stay separate readings on the same page', () => {
  // A live local lane and an empty flow artifact: the page says a process is alive AND that the
  // tracked queue produced nothing. Both are true, and neither is derived from the other.
  const lanes = sealLocalLaneObservation({
    observedAt: AT,
    lanes: [{
      workspaceId: 'ws-1', paneId: 'pane-1', surfaceId: 'surf-1', agentId: 'agent-1',
      label: 'Reviewer 1', labelState: 'OBSERVED', lifecycle: 'RUNNING',
    }],
  });
  const snapshot = snapshotWith(flow([]), { localLanes: lanes });
  assert.equal(snapshot.headline.state, 'ACTIVE', 'the lane makes the headline active');
  assert.equal(snapshot.engineeringFlow.families[0].windows[0].total, 0, 'and the queue is at 0');

  const html = render(snapshot);
  // The flow section never claims the lane, and the lane section never claims a count.
  assert.equal(flowSection(html).includes('wmux'), false);
  assert.equal(flowSection(html).includes('lane-pulse'), false);
});

// ---------------------------------------------------------------------------------------------
// C3 — the render seam re-derives the whole block.
// ---------------------------------------------------------------------------------------------

test('C3: a resealed count its own events do not derive is refused', () => {
  // A partially complete artifact on purpose, so both directions of forgery are available: a
  // MEASURED cell to inflate, and an UNKNOWN cell to claim was measured.
  const snapshot = snapshotWith(partialFlow());
  const inflate = (mutate) => {
    const block = structuredClone(snapshot.engineeringFlow);
    mutate(block);
    return reseal({ ...structuredClone(snapshot), engineeringFlow: block });
  };

  const refusals = [
    ['an inflated total', (block) => { block.families[0].windows[0].total = 99; }],
    ['an inflated rate', (block) => { block.families[0].windows[0].ratePerHour = 99; }],
    // The dangerous direction: an unobserved window resealed as a measured one.
    ['an unknown window claimed as measured', (block) => {
      block.families[0].windows[1].state = 'MEASURED';
      block.families[0].windows[1].reasonCode = null;
      block.families[0].windows[1].total = 0;
    }],
    ['a measured window claimed as unknown', (block) => {
      block.families[0].windows[0].state = 'UNKNOWN';
    }],
    ['a forged outcome count', (block) => { block.families[0].windows[0].outcomes.CLOSED = 42; }],
    ['a forged net', (block) => { block.families[0].windows[0].queue.net = 12; }],
    ['a forged median', (block) => {
      block.families[0].windows[0].cycleTime.medianMs = 1000;
      block.families[0].windows[0].cycleTime.state = 'MEASURED';
    }],
    ['a forged event count', (block) => { block.eventCount = 99; }],
    ['a forged age', (block) => { block.observationAgeMs = 0 - 1; }],
    ['a forged freshness state', (block) => { block.state = 'FRESH'; block.observedAt = at(DAY_MS); }],
    ['a dropped event', (block) => { block.events = block.events.slice(1); }],
    ['an added event', (block) => {
      block.events = [...block.events, event({ eventId: 'z-forged', occurredAt: at(60_000) })];
    }],
    ['a forged artifact revision', (block) => { block.artifactRevision = 'c'.repeat(64); }],
    ['a forged sequence', (block) => { block.sequence = 99; }],
    ['an invented binding', (block) => { block.binding = 'GuitarAlchemist/gaia'; }],
    ['a forged source', (block) => { block.source = 'LOCAL_WMUX'; }],
  ];
  for (const [why, mutate] of refusals) {
    assert.throws(
      () => requireControlRoomSnapshot(inflate(mutate)),
      (error) => error instanceof ControlRoomError,
      `${why} is refused`,
    );
  }
});

test('C3: an event smuggled into the published block is refused by the artifact verifier', () => {
  const snapshot = snapshotWith(flow());
  const block = structuredClone(snapshot.engineeringFlow);
  // A lifecycle field the closed schema has no name for, carried on the block's own evidence.
  block.events = block.events.map((entry) => ({ ...entry, updatedAt: AT }));
  assert.throws(
    () => requireControlRoomSnapshot(reseal({ ...structuredClone(snapshot), engineeringFlow: block })),
    (error) => error instanceof ControlRoomError,
    'the block cannot carry a field the artifact schema refuses',
  );
});

test('C3: the renderer refuses a snapshot the verifier refuses', () => {
  const snapshot = snapshotWith(flow());
  const block = structuredClone(snapshot.engineeringFlow);
  block.families[0].windows[0].total = 99;
  assert.throws(
    () => render(reseal({ ...structuredClone(snapshot), engineeringFlow: block })),
    (error) => error instanceof ControlRoomError,
    'a display is refused, never repaired',
  );
});

// ---------------------------------------------------------------------------------------------
// C4 — 0 and UNKNOWN are different words, symbols and data-state values.
// ---------------------------------------------------------------------------------------------

test('C4: a measured zero and an unknown window never share a rendering', () => {
  const html = render(snapshotWith(partialFlow()));

  const measured = cellOf(html, 'PULL_REQUEST', 'PT1H');
  assert.match(openTagOf(measured), /data-state="MEASURED"/u);
  assert.equal(
    openTagOf(measured).includes('data-reason'), false,
    'a measured cell names no missing evidence of its own',
  );
  assert.match(readingOf(measured), /0 observed in a complete window/u);
  assert.equal(readingOf(measured).includes('Unknown'), false, 'a measured zero never says unknown');
  assert.match(totalOf(measured), /<span class="semantic-symbol" aria-hidden="true">●<\/span>0$/u);

  const unknown = cellOf(html, 'PULL_REQUEST', 'P1D');
  assert.match(openTagOf(unknown), /data-state="UNKNOWN" data-reason="WINDOW_INCOMPLETE"/u);
  assert.match(readingOf(unknown), /Unknown/u);
  assert.equal(
    readingOf(unknown).includes('observed in a complete window'), false,
    'an unknown cell never claims a complete window',
  );
  assert.match(totalOf(unknown), /<span class="semantic-symbol" aria-hidden="true">○<\/span>/u);
  // The one defect this whole section exists to prevent: no digit stands where a count would be.
  assert.doesNotMatch(totalOf(unknown), /\d/u, 'an unknown window never renders a number');
  assert.equal(unknown.includes('●'), false, 'and never borrows the measured symbol');

  // The three carriers are all different, so no operator, screen reader or test can conflate them.
  assert.notEqual(readingOf(measured), readingOf(unknown));
  assert.notEqual(totalOf(measured), totalOf(unknown));
});

test('C4: every unknown reason names what is missing, in its own words', () => {
  const durations = [1, 2, 3, 4].map((minutes, index) => event({
    eventId: `close-${index}`,
    occurredAt: at((index + 1) * HOUR_MS),
    workItemId: `issue-${index}`,
    startedAt: new Date(Date.parse(at((index + 1) * HOUR_MS)) - minutes * 60_000).toISOString(),
  }));
  const html = render(snapshotWith(flow(durations)));

  const day = cellOf(html, 'ISSUE', 'P1D');
  assert.match(day, /data-reason="NOT_ENOUGH_COMPARABLE_DURATIONS"/u);
  assert.match(day, /fewer than 5 comparable closing durations/u);

  const runs = cellOf(html, 'FACTORY_RUN', 'P1D');
  assert.match(runs, /data-reason="NO_OBSERVED_INFLOW"/u);
  assert.match(runs, /no observed inflow/u);
});

test('C4: the section says what it measured and what it refuses to be read as', () => {
  const html = flowSection(render(snapshotWith(flow())));
  assert.match(html, /Engineering flow throughput/u);
  // The caveat that keeps this section from being read as liveness.
  assert.match(html, /heartbeat|liveness/iu);
  assert.match(html, /binding=NONE · effect=NONE · authority=NONE/u);
  assert.match(html, new RegExp(flow().revision, 'u'), 'the evidence names itself');
});

test('C4: a stale reading says how stale it is without changing a single count', () => {
  const fresh = snapshotWith(flow());
  const stale = buildControlRoomSnapshot({
    drainProjection: projection(),
    observedAt: new Date(Date.parse(AT) + 600_000).toISOString(),
    engineeringFlow: flow(),
  });
  assert.equal(fresh.engineeringFlow.state, 'FRESH');
  assert.equal(stale.engineeringFlow.state, 'STALE');
  assert.equal(
    canonicalJson(fresh.engineeringFlow.families), canonicalJson(stale.engineeringFlow.families),
    'staleness is about the reading, never about the counts',
  );
  assert.match(flowSection(render(stale)), /Stale reading/u);
});

// ---------------------------------------------------------------------------------------------
// C5 — the section animates nothing.
// ---------------------------------------------------------------------------------------------

test('C5: nothing in the flow section animates, with or without a pulse elsewhere', () => {
  const quiet = render(snapshotWith(flow()));
  assert.equal(quiet.includes('@keyframes'), false, 'a paused page emits no keyframe at all');

  const lanes = sealLocalLaneObservation({
    observedAt: AT,
    lanes: [{
      workspaceId: 'ws-1', paneId: 'pane-1', surfaceId: 'surf-1', agentId: 'agent-1',
      label: 'Reviewer 1', labelState: 'OBSERVED', lifecycle: 'RUNNING',
    }],
  });
  const pulsing = render(snapshotWith(flow(), { localLanes: lanes }));
  const style = styleOf(pulsing);
  assert.equal(style.split('@keyframes').length - 1, 1, 'exactly one keyframe block, as before');
  // Every animated class is named in the reduced-motion guard, and none of them is a flow class.
  // Deduplicated: each animated class is named twice, once to animate and once in the
  // reduced-motion guard, and a class missing from the guard would show up as a lone entry.
  const animated = [...style.matchAll(/\.([a-z-]+)\s*\{\s*animation:/gu)].map(([, name]) => name);
  assert.deepEqual([...new Set(animated)].sort(), ['heartbeat-pulse', 'lane-pulse']);
  for (const name of new Set(animated)) {
    assert.equal(
      animated.filter((entry) => entry === name).length, 2,
      `${name} is both animated and named in the reduced-motion guard`,
    );
  }
  assert.equal(flowSection(pulsing).includes('animation'), false);
  assert.equal(flowSection(pulsing).includes('role="status"'), false, 'no live region either');
  assert.equal(flowSection(pulsing).includes('aria-live'), false);
});

// ---------------------------------------------------------------------------------------------
// C6 — French is complete and leaks no English.
// ---------------------------------------------------------------------------------------------

test('C6: the French document translates the whole section and leaks no English copy', () => {
  const fr = flowSection(render(snapshotWith(partialFlow()), { language: 'fr' }));

  for (const french of [
    'Débit du flux d’ingénierie', 'Dernière heure', 'Dernières 24 heures', 'Derniers 7 jours',
    'Issues', 'Pull requests', 'Commits', 'Exécutions de factory', 'Revues de preuve',
    'Inconnu', 'observé sur une fenêtre complète', 'Lecture fraîche',
  ]) {
    assert.ok(fr.includes(french), `the French section says ${JSON.stringify(french)}`);
  }
  for (const english of [
    'Engineering flow throughput', 'Last hour', 'Last 24 hours', 'Last 7 days',
    'Factory runs', 'Evidence reviews', 'Unknown', 'observed in a complete window',
    'Fresh reading', 'Stale reading', 'Cycle time median', 'Queue change',
  ]) {
    assert.equal(fr.includes(english), false, `the French section must not leak ${english}`);
  }
});

test('C6: English and French agree about every state, count and reason', () => {
  const snapshot = snapshotWith(partialFlow());
  const en = flowSection(render(snapshot));
  const fr = flowSection(render(snapshot, { language: 'fr' }));
  const machineReadable = (html) => [...html.matchAll(
    /data-(family|window|state|reason)="([A-Z_]+)"/gu,
  )].map(([match]) => match);
  assert.deepEqual(machineReadable(fr), machineReadable(en), 'the two languages agree exactly');

  // The words differ by design; the digits must not. `Unknown` and `Inconnu` both reduce to no
  // digits at all, which is itself the property worth holding: neither language invents a count.
  const digits = (html) => [...html.matchAll(/<strong class="flow-total">(.*?)<\/strong>/gsu)]
    .map(([, value]) => value.replaceAll(/\D/gu, ''));
  assert.deepEqual(digits(fr), digits(en), 'no number is translated into a different number');
  assert.ok(digits(en).some((value) => value === ''), 'and the unknown cells carry no digit');
});

// ---------------------------------------------------------------------------------------------
// C7 — responsive: one phone column, and a desktop that uses the width it has.
// ---------------------------------------------------------------------------------------------

test('C7: the phone layout is one column and nothing is wider than a 320px viewport', () => {
  const html = render(snapshotWith(flow()));
  const base = baseCss(html);
  assert.match(base, /\.flow-family-list \{[^}]*display: grid;/u);
  assert.match(base, /\.flow-window-list \{[^}]*display: grid;/u);
  // No column rule at all in the base layer: one column is the default, not a declared one.
  assert.doesNotMatch(
    base.slice(base.indexOf('.flow-family-list')),
    /\.flow-(family|window)-list \{[^}]*grid-template-columns/u,
    'the base layer declares no columns',
  );
  // Nothing in the section can force a horizontal scroll.
  assert.equal(flowSection(html).includes('white-space: nowrap'), false);
  assert.match(base, /main :where\(section, article, div, p, ol, li, span\) \{ min-width: 0; \}/u);
});

test('C7: the matrix becomes three window columns at 768, and the family list widens after', () => {
  const html = render(snapshotWith(flow()));
  assert.match(
    mediaCss(html, 768),
    /\.flow-window-list \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/u,
    'the three windows are the natural shape of the matrix',
  );
  assert.doesNotMatch(mediaCss(html, 768), /\.flow-family-list \{ grid-template-columns/u);
  assert.match(
    mediaCss(html, 1024),
    /\.flow-family-list \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\); \}/u,
  );
  assert.match(
    mediaCss(html, 1440),
    /\.flow-family-list \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/u,
    'a desktop uses the width it has rather than leaving a narrow strip',
  );
});

// ---------------------------------------------------------------------------------------------
// C8 — accessibility: a word and a symbol, symbols hidden, the section named.
// ---------------------------------------------------------------------------------------------

test('C8: every state carries a word and a symbol, and colour is never the only carrier', () => {
  const section = flowSection(render(snapshotWith(partialFlow())));

  // Every decorative symbol is hidden from assistive technology.
  const symbols = [...section.matchAll(/<span class="semantic-symbol"([^>]*)>/gu)];
  assert.ok(symbols.length > 0, 'the section uses symbols');
  for (const [, attributes] of symbols) {
    assert.match(attributes, /aria-hidden="true"/u, 'every symbol is aria-hidden');
  }
  // Every cell carries a machine state, a symbol and a word, not a colour alone.
  const cells = [...section.matchAll(/<li class="flow-window"[^>]*data-state="([A-Z]+)"/gu)];
  assert.equal(cells.length, 15, 'five families times three windows');
  for (const [, state] of cells) {
    assert.ok(['MEASURED', 'UNKNOWN'].includes(state));
  }
  for (const family of ['ISSUE', 'PULL_REQUEST', 'COMMIT', 'FACTORY_RUN', 'EVIDENCE_REVIEW']) {
    for (const window of ['PT1H', 'P1D', 'P7D']) {
      const cell = cellOf(render(snapshotWith(partialFlow())), family, window);
      assert.match(cell, /class="semantic-symbol"/u, `${family}/${window} has a symbol`);
      assert.match(cell, /class="flow-reading"/u, `${family}/${window} has a word`);
    }
  }
});

test('C8: the section names itself and its families are headed, not merely coloured', () => {
  const html = render(snapshotWith(flow()));
  assert.match(flowSection(html), /aria-label="Engineering flow throughput"/u);
  assert.match(flowSection(html), /<h2>Engineering flow throughput<\/h2>/u);
  for (const label of ['Issues', 'Pull requests', 'Commits', 'Factory runs', 'Evidence reviews']) {
    assert.match(flowSection(html), new RegExp(`<h3>${label}</h3>`, 'u'), `${label} is headed`);
  }
});

test('C8: the section sits between the local lanes and the verifiable progress', () => {
  const lanes = sealLocalLaneObservation({
    observedAt: AT,
    lanes: [{
      workspaceId: 'ws-1', paneId: 'pane-1', surfaceId: 'surf-1', agentId: 'agent-1',
      label: 'Reviewer 1', labelState: 'OBSERVED', lifecycle: 'RUNNING',
    }],
  });
  const html = render(snapshotWith(flow(), { localLanes: lanes }));
  const laneAt = html.indexOf('<section class="section-panel local-lanes"');
  const flowAt = html.indexOf('<section class="section-panel engineering-flow"');
  const progressAt = html.indexOf('Verifiable progress');
  assert.ok(laneAt !== -1 && flowAt !== -1 && progressAt !== -1);
  assert.ok(laneAt < flowAt, 'after the lanes');
  assert.ok(flowAt < progressAt, 'before the verifiable progress');
});

// ---------------------------------------------------------------------------------------------
// C9 — the document issues no network request.
// ---------------------------------------------------------------------------------------------

test('C9: the rendered document fetches nothing and embeds no remote resource', () => {
  const html = render(snapshotWith(flow()));
  for (const forbidden of [
    'fetch(', 'XMLHttpRequest', 'EventSource', 'navigator.sendBeacon', 'import(',
    '<img', '<iframe', '<link', '<script src', '@import', 'url(', 'http://', 'https://',
  ]) {
    assert.equal(html.includes(forbidden), false, `the document contains no ${forbidden}`);
  }
  // The only client-side script ages what is already displayed.
  const script = html.slice(html.lastIndexOf('<script>'), html.lastIndexOf('</script>'));
  assert.equal(script.includes('flow'), false, 'the flow section gains no client-side behaviour');
});

// ---------------------------------------------------------------------------------------------
// C10 / C11 — CLI plumbing and deterministic replay.
// ---------------------------------------------------------------------------------------------

function cliFixture(name, events = HISTORY, overrides = {}) {
  const dir = join(scratch, name);
  mkdirSync(dir, { recursive: true });
  const paths = {
    projection: join(dir, 'projection.json'),
    engineeringFlow: join(dir, 'flow.json'),
    html: join(dir, 'control-room.html'),
    snapshot: join(dir, 'control-room.json'),
  };
  writeFileSync(paths.projection, `${JSON.stringify(projection())}\n`, 'utf8');
  writeFileSync(paths.engineeringFlow, `${JSON.stringify(sealEngineeringFlow({
    observedAt: AT, windowStartedAt: WINDOW_START, sequence: 41, events, ...overrides,
  }), null, 2)}\n`, 'utf8');
  const changedAt = new Date('2026-08-30T18:00:00.000Z');
  utimesSync(paths.projection, changedAt, changedAt);
  utimesSync(paths.engineeringFlow, changedAt, changedAt);
  return paths;
}

const cliArgv = (paths) => [
  '--projection', paths.projection,
  '--engineering-flow', paths.engineeringFlow,
  '--html-out', paths.html,
  '--snapshot-out', paths.snapshot,
];

test('C10: the --engineering-flow flag plumbs one sealed artifact through to the page', () => {
  const paths = cliFixture('cli-happy');
  const snapshot = runFactoryDashboardCli(cliArgv(paths), {
    now: () => new Date(AT),
    writeStdout: () => {},
  });

  assert.equal(snapshot.engineeringFlow.eventCount, 3);
  assert.equal(snapshot.engineeringFlow.sequence, 41);
  const hour = snapshot.engineeringFlow.families[0].windows[0];
  assert.equal(hour.state, 'MEASURED');
  assert.equal(hour.total, 2);
  assert.deepEqual(hour.queue, {
    state: 'MEASURED', reasonCode: null, inflow: 1, outflow: 1, net: 0,
  });

  // The published bytes verify, and the page renders the same evidence.
  const published = requireControlRoomSnapshot(JSON.parse(readFileSync(paths.snapshot, 'utf8')));
  assert.equal(published.revision, snapshot.revision);
  assert.match(flowSection(readFileSync(paths.html, 'utf8')), /Engineering flow throughput/u);
});

test('C10: without the flag the feature is absent and leaves no residue', () => {
  const paths = cliFixture('cli-absent');
  const snapshot = runFactoryDashboardCli([
    '--projection', paths.projection,
    '--html-out', paths.html,
    '--snapshot-out', paths.snapshot,
  ], { now: () => new Date(AT), writeStdout: () => {} });

  assert.equal(Object.hasOwn(snapshot, 'engineeringFlow'), false);
  assert.equal(readFileSync(paths.html, 'utf8').includes('engineering-flow'), false);
});

test('C10: the CLI refuses an unreadable artifact rather than publishing without it', () => {
  const paths = cliFixture('cli-unreadable');
  writeFileSync(paths.engineeringFlow, 'not json at all', 'utf8');
  assert.throws(
    () => runFactoryDashboardCli(cliArgv(paths), { now: () => new Date(AT), writeStdout: () => {} }),
    /engineering flow must be readable JSON/u,
  );

  writeFileSync(paths.engineeringFlow, `${JSON.stringify({ schema: 'nope' })}\n`, 'utf8');
  assert.throws(
    () => runFactoryDashboardCli(cliArgv(paths), { now: () => new Date(AT), writeStdout: () => {} }),
    (error) => error instanceof ControlRoomError,
    'an artifact that is not a Gaia engineering flow is refused',
  );
});

test('C10: the CLI refuses an artifact path that aliases an output', () => {
  const paths = cliFixture('cli-alias');
  assert.throws(
    () => runFactoryDashboardCli([
      '--projection', paths.projection,
      '--engineering-flow', paths.engineeringFlow,
      '--html-out', paths.html,
      '--snapshot-out', paths.engineeringFlow,
    ], { now: () => new Date(AT), writeStdout: () => {} }),
    /aliases an input evidence path/u,
    'the artifact cannot be overwritten by an output',
  );
});

test('C10: the publisher carries the prior observation forward and refuses a backwards snapshot', () => {
  const paths = cliFixture('cli-monotonic');
  runFactoryDashboardCli(cliArgv(paths), { now: () => new Date(AT), writeStdout: () => {} });

  // A producer that went backwards is refused against the snapshot this publisher wrote last.
  writeFileSync(paths.engineeringFlow, `${JSON.stringify(sealEngineeringFlow({
    observedAt: AT, windowStartedAt: WINDOW_START, sequence: 40, events: HISTORY,
  }), null, 2)}\n`, 'utf8');
  assert.throws(
    () => runFactoryDashboardCli(cliArgv(paths), { now: () => new Date(AT), writeStdout: () => {} }),
    (error) => error instanceof ControlRoomError,
    'a backwards sequence is refused',
  );

  // Forward is ordinary.
  writeFileSync(paths.engineeringFlow, `${JSON.stringify(sealEngineeringFlow({
    observedAt: AT, windowStartedAt: WINDOW_START, sequence: 42, events: HISTORY,
  }), null, 2)}\n`, 'utf8');
  assert.equal(runFactoryDashboardCli(cliArgv(paths), {
    now: () => new Date(AT), writeStdout: () => {},
  }).engineeringFlow.sequence, 42);
});

test('C11: replaying the same evidence through the CLI produces byte-identical artifacts', () => {
  const paths = cliFixture('cli-replay');
  const options = { now: () => new Date(AT), writeStdout: () => {} };

  runFactoryDashboardCli(cliArgv(paths), options);
  const firstHtml = readFileSync(paths.html, 'utf8');
  const firstSnapshot = readFileSync(paths.snapshot, 'utf8');

  runFactoryDashboardCli(cliArgv(paths), options);
  assert.equal(readFileSync(paths.html, 'utf8'), firstHtml);
  assert.equal(readFileSync(paths.snapshot, 'utf8'), firstSnapshot);
});

// ---------------------------------------------------------------------------------------------
// MR1 / MR2 — the two mechanisms, shown to be mechanisms rather than outcomes.
// ---------------------------------------------------------------------------------------------

test('MR1: the closed event field list is what keeps an inferred lifecycle field out', async () => {
  const mutant = await importMutant(
    'engineering-flow.mjs',
    'flow-open-fields',
    (source) => source.replace(
      "'startedAt', 'sourceKind', 'sourceRevision',",
      "'startedAt', 'sourceKind', 'sourceRevision', 'updatedAt',",
    ),
  );

  const withUpdatedAt = [{ ...event(), updatedAt: '2026-08-30T18:09:00.000Z' }];
  const artifact = {
    schema: 'gaia-engineering-flow/1',
    effect: 'NONE',
    authority: 'NONE',
    observedAt: AT,
    windowStartedAt: WINDOW_START,
    sequence: 41,
    events: withUpdatedAt,
    revision: mutant.engineeringFlowRevision({
      observedAt: AT, windowStartedAt: WINDOW_START, sequence: 41, events: withUpdatedAt,
    }),
  };

  // Widening the list is exactly what lets the field in — the mutant accepts it.
  assert.equal(
    mutant.requireEngineeringFlowArtifact(artifact).events[0].updatedAt,
    '2026-08-30T18:09:00.000Z',
    'the mutant admits an updatedAt-shaped lifecycle field',
  );

  // The shipped module refuses the identical bytes.
  assert.throws(
    () => snapshotWith(artifact),
    (error) => error instanceof ControlRoomError,
    'the shipped closed field list refuses it',
  );
});

test('MR2: the completeness rule is what keeps unknown evidence from printing as 0', async () => {
  const mutant = await importMutant(
    'engineering-flow.mjs',
    'flow-always-complete',
    (source) => source.replace(
      'Date.parse(windowStartedAt) <= Date.parse(observedAt) - windowMs',
      'Date.parse(windowStartedAt) <= Date.parse(observedAt) - windowMs || true',
    ),
  );

  const artifact = partialFlow();

  // The mutant calls a window it never observed "complete", and prints the most reassuring
  // reading available for evidence nobody has: zero.
  const mutantBlock = mutant.summarizeEngineeringFlow({ artifact, observedAt: AT });
  const mutantWeek = mutantBlock.families[0].windows[2];
  assert.equal(mutantWeek.state, 'MEASURED');
  assert.equal(mutantWeek.total, 1);
  const mutantRuns = mutantBlock.families[3].windows[2];
  assert.equal(mutantRuns.state, 'MEASURED');
  assert.equal(mutantRuns.total, 0, 'the mutant prints 0 for a window it did not observe');

  // The shipped module says UNKNOWN, and says why.
  const week = snapshotWith(artifact).engineeringFlow.families[3].windows[2];
  assert.equal(week.state, 'UNKNOWN');
  assert.equal(week.reasonCode, 'WINDOW_INCOMPLETE');
  assert.equal(week.total, null);
});
