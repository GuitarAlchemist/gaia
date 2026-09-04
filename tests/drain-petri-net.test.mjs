/**
 * R0 contract for the drain Petri-net interpreter and its fact collector.
 *
 * Every input is a deterministic fixture: a synthetic bus log and a directory of artifacts whose
 * lane-complete digests match their bytes. The tests bind the evolution rules, the AND-join on
 * the head, the Subject-line binding (B1 of PR #97), the merge-lock resource place (B35), replay
 * determinism under shuffled input, the bounded reachability check, and the leak controls.
 * Mechanism-revert controls are mutant nets or mutant binders built here, shown to pass what the
 * shipped mechanism refuses.
 */

import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { BUS_VERBS } from '../src/bus-core.mjs';
import {
  DEFAULT_PROVIDER_CAPACITY, DRAIN_NET_ID, DRAIN_NET_TEMPLATE, DrainPetriNetError, LANE_NET_ID, LANE_NET_TEMPLATE,
  MAX_EVOLUTION_ITERATIONS, buildNet, canonicalJson, checkReachability, enabledTransitions, fire, initialMarking,
  instantiate, isProperCompletion, markingRevision, replay, step,
} from '../src/drain-petri-net.mjs';
import {
  DrainFactsError, PR_OBSERVATION_GRAMMAR, bindAxis, collectDrainFacts as collectDrainFactsRaw, parseArtifact,
  parseClosedTokens,
} from '../src/drain-petri-net-facts.mjs';
import {
  DRAIN_PETRI_DUCKDB_QUERIES, DRAIN_PETRI_DUCKDB_SCHEMA, DRAIN_PETRI_DUCKDB_STATEMENTS, DRAIN_PETRI_DUCKDB_TABLES,
  DrainPetriDuckDbError, openDrainPetriNetDuckDbClient, queryDrainPetriNetDuckDb,
  synchronizeDrainPetriNetDuckDb,
} from '../src/duckdb-drain-petri-net.mjs';
import { runDrainPetriNetCli } from '../scripts/drain-petri-net.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(here, 'fixtures', 'drain-petri-net');
const H1 = '1111111111111111111111111111111111111111';
const H2 = '2222222222222222222222222222222222222222';
const H3 = '3333333333333333333333333333333333333333';
const K1 = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

/** The exact caller-authorized actor whose `pr-observation` a fold reads. */
const registerCoordinator = (at = '2026-09-04T05:59:00.000Z', ref = 'act-0001') => (
  { type: 'actor.registered', at, ref, kind: 'coordinator', isNew: true }
);

const loadRecords = () => readFileSync(join(FIXTURE, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
const loadArtifacts = () => readdirSync(join(FIXTURE, 'artifacts')).map((name) => ({ name, bytes: readFileSync(join(FIXTURE, 'artifacts', name)) }));
const artifactText = (name) => readFileSync(join(FIXTURE, 'artifacts', name), 'utf8');
const bytes = (text) => Buffer.from(text, 'utf8');
const collectDrainFacts = (input) => collectDrainFactsRaw({ observationSource: 'act-0001', ...input });
const fixtureCliArgs = () => [
  '--events', join(FIXTURE, 'events.jsonl'), '--artifacts', join(FIXTURE, 'artifacts'),
  '--observation-source', 'act-0001',
];

const refusal = (code, fn) => assert.throws(fn, (error) => error instanceof DrainPetriNetError && error.code === code, code);

const drainFor = (keys, options) => instantiate(DRAIN_NET_TEMPLATE, keys, options);
const active = (marking) => Object.keys(marking).filter((id) => marking[id] > 0).sort();

/** A marking of one drain instance sitting in the named places, resources untouched. */
const markingAt = (net, instance, places, overrides = {}) => {
  const marking = { ...initialMarking(net) };
  marking[`pr#${instance}/P_DRAFT_HEAD`] = 0;
  for (const place of places) marking[`pr#${instance}/${place}`] = 1;
  return { ...marking, ...overrides };
};

// ---------------------------------------------------------------------------
// the nets as data
// ---------------------------------------------------------------------------

test('both nets build from their templates, sorted and content-addressed', () => {
  const drain = drainFor(['97']);
  assert.equal(drain.netId, DRAIN_NET_ID);
  assert.match(drain.netRevision, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(drain.places.map(({ id }) => id), [...drain.places.map(({ id }) => id)].sort());
  assert.equal(drainFor(['95', '97']).netRevision, drainFor(['97', '95', '97']).netRevision, 'instance order does not change the net');
  assert.notEqual(drainFor(['97']).netRevision, drainFor(['97'], { capacity: 2 }).netRevision, 'capacity is part of the net');
  const lane = instantiate(LANE_NET_TEMPLATE, ['act-0002']);
  assert.equal(lane.netId, LANE_NET_ID);
  assert.equal(lane.placeIndex.LANE_SLOTS.initial, DEFAULT_PROVIDER_CAPACITY);
  for (const net of [drain, lane]) {
    for (const transition of net.transitions) {
      assert.ok(net.receptivityIndex[transition.receptivity], `${transition.id} names a declared receptivity`);
      assert.match(transition.refusal, /^[A-Z][A-Z0-9_]*$/u, `${transition.id} names a refusal`);
    }
    for (const entry of net.receptivities) {
      assert.ok(entry.fact.length > 0 && entry.channel.length > 0, `${entry.id} names its fact and its channel`);
    }
    assert.ok(Object.isFrozen(net) && Object.isFrozen(net.transitions[0]), 'the net is frozen');
  }
});

test('a net definition is validated and refused by name', () => {
  const base = { netId: 'x', places: [{ id: 'A', initial: 1 }, { id: 'B' }], receptivities: { r: { fact: 'f', channel: 'c' } }, transitions: [] };
  buildNet(base);
  refusal('NetInvalid', () => buildNet({ ...base, transitions: [{ id: 'T', receptivity: 'missing', refusal: 'R', inputs: ['A'] }] }));
  refusal('NetInvalid', () => buildNet({ ...base, transitions: [{ id: 'T', receptivity: 'r', refusal: 'R', inputs: ['Z'] }] }));
  refusal('NetInvalid', () => buildNet({ ...base, transitions: [{ id: 'T', receptivity: 'r', refusal: 'lower', inputs: ['A'] }] }));
  refusal('NetInvalid', () => buildNet({ ...base, transitions: [{ id: 'T', receptivity: 'r', refusal: 'R', inputs: [] }] }));
  refusal('NetInvalid', () => buildNet({ ...base, places: [{ id: 'A', initial: 2, capacity: 1 }] }));
  refusal('NetInvalid', () => buildNet({ ...base, places: [{ id: 'A' }, { id: 'A' }] }));
  refusal('NetInvalid', () => buildNet({ ...base, transitions: [{ id: 'T', receptivity: 'r', refusal: 'R', inputs: [{ place: 'A', weight: 0 }] }] }));
  refusal('NetInvalid', () => instantiate(DRAIN_NET_TEMPLATE, ['bad key']));
  refusal('MarkingInvalid', () => enabledTransitions(buildNet(base), { A: 5 }));
  refusal('MarkingInvalid', () => enabledTransitions(buildNet(base), { Q: 1 }));
});

// ---------------------------------------------------------------------------
// evolution rules
// ---------------------------------------------------------------------------

test('rule 1: the initial situation marks the draft head and the full resources', () => {
  const net = drainFor(['97']);
  const marking = initialMarking(net);
  assert.deepEqual(active(marking), ['MERGE_LOCK', 'PROVIDER_CAPACITY', 'pr#97/P_DRAFT_HEAD']);
  assert.equal(marking.PROVIDER_CAPACITY, DEFAULT_PROVIDER_CAPACITY);
  assert.equal(markingRevision(marking), markingRevision({ ...marking }), 'the revision is content-addressed');
});

test('rule 2: a transition needs its tokens, no inhibitor, and a true receptivity; UNKNOWN never fires', () => {
  const net = drainFor(['97']);
  const marking = initialMarking(net);
  const unknown = enabledTransitions(net, marking, {});
  assert.deepEqual(unknown.enabled, []);
  assert.deepEqual(unknown.blocked, [{
    transition: 'pr#97/T_FORK_REVIEWS', receptivity: 'pr#97/D_HEAD_PUBLISHED', refusal: 'HEAD_UNOBSERVED',
    reason: 'RECEPTIVITY_UNKNOWN', places: [],
  }]);
  assert.equal(enabledTransitions(net, marking, { 'pr#97/D_HEAD_PUBLISHED': 'UNKNOWN' }).enabled.length, 0);
  assert.equal(enabledTransitions(net, marking, { 'pr#97/D_HEAD_PUBLISHED': 'yes' }).enabled.length, 0, 'a non-Boolean is UNKNOWN');
  assert.equal(enabledTransitions(net, marking, { 'pr#97/D_HEAD_PUBLISHED': false }).blocked[0].reason, 'RECEPTIVITY_FALSE');
  assert.deepEqual(enabledTransitions(net, marking, { 'pr#97/D_HEAD_PUBLISHED': true }).enabled, ['pr#97/T_FORK_REVIEWS']);
  assert.deepEqual(
    enabledTransitions(net, marking, { 'pr#97/D_HEAD_PUBLISHED': { value: true, evidence: { head: H1 } } }).enabled,
    ['pr#97/T_FORK_REVIEWS'], 'a fact may carry its evidence',
  );
  // Inhibitor: the breaker place holds the fork.
  const blocked = markingAt(net, '97', ['P_DRAFT_HEAD', 'P_BLOCKED_REDESIGN']);
  const held = enabledTransitions(net, blocked, { 'pr#97/D_HEAD_PUBLISHED': true });
  assert.deepEqual(held.enabled, []);
  assert.equal(held.blocked.find(({ transition }) => transition === 'pr#97/T_FORK_REVIEWS').reason, 'INHIBITED');
  // Resource: two review lanes need two capacity tokens.
  const starved = enabledTransitions(net, { ...marking, PROVIDER_CAPACITY: 1 }, { 'pr#97/D_HEAD_PUBLISHED': true });
  assert.deepEqual(starved.enabled, []);
  assert.deepEqual(starved.blocked[0].reason, 'RESOURCE_UNAVAILABLE');
  assert.deepEqual(starved.blocked[0].places, ['PROVIDER_CAPACITY']);
  refusal('RECEPTIVITY_UNKNOWN', () => fire(net, marking, 'pr#97/T_FORK_REVIEWS', {}));
  refusal('TransitionUnknown', () => fire(net, marking, 'pr#97/T_NOPE', {}));
});

test('rule 3: firing removes the input weights and adds the output weights', () => {
  const net = drainFor(['97']);
  const next = fire(net, initialMarking(net), 'pr#97/T_FORK_REVIEWS', { 'pr#97/D_HEAD_PUBLISHED': true });
  assert.deepEqual(active(next), ['MERGE_LOCK', 'PROVIDER_CAPACITY', 'pr#97/P_REVIEW_SPEC', 'pr#97/P_REVIEW_STANDARDS']);
  assert.equal(next.PROVIDER_CAPACITY, DEFAULT_PROVIDER_CAPACITY - 2, 'two lanes consumed two capacity tokens');
  assert.ok(Object.isFrozen(next));
});

test('rule 4: every enabled transition fires in one step, in priority order, unless the tokens were taken', () => {
  const net = drainFor(['92', '97']);
  const facts = { 'pr#92/D_HEAD_PUBLISHED': true, 'pr#97/D_HEAD_PUBLISHED': true };
  const both = step(net, initialMarking(net), facts);
  assert.deepEqual(both.fired, ['pr#92/T_FORK_REVIEWS', 'pr#97/T_FORK_REVIEWS'], 'two instances fork in one step');
  assert.equal(both.marking.PROVIDER_CAPACITY, 0);
  const contended = step(net, { ...initialMarking(net), PROVIDER_CAPACITY: 2 }, facts);
  assert.deepEqual(contended.fired, ['pr#92/T_FORK_REVIEWS'], 'the earlier id takes the last two tokens');
  assert.deepEqual(contended.blocked.map(({ transition, reason }) => [transition, reason]),
    [['pr#97/T_FORK_REVIEWS', 'RESOURCE_UNAVAILABLE']]);
  // Priority: the breaker outranks the repair join on the same verdict tokens.
  const verdicts = markingAt(net, '92', ['P_SPEC_VERDICT', 'P_STANDARDS_VERDICT'], { 'pr#97/P_DRAFT_HEAD': 0 });
  const trip = step(net, verdicts, { 'pr#92/D_FAILURE_FAMILY_REPEATED': true, 'pr#92/D_ANY_REQUEST_CHANGES_AT_HEAD': true });
  assert.deepEqual(trip.fired, ['pr#92/T_BREAKER_TRIP']);
  assert.equal(trip.marking['pr#92/P_BLOCKED_REDESIGN'], 1);
  assert.equal(trip.marking['pr#92/P_REPAIR'], 0);
});

test('rule 5: a place emptied and refilled in one step keeps its token', () => {
  const net = buildNet({
    netId: 'ring',
    places: [{ id: 'A', initial: 1 }, { id: 'B', initial: 1 }],
    receptivities: { go: { kind: 'CONSTANT', fact: 'always', channel: 'none' } },
    transitions: [
      { id: 'ab', receptivity: 'go', refusal: 'NEVER', inputs: ['A'], outputs: ['B'] },
      { id: 'ba', receptivity: 'go', refusal: 'NEVER', inputs: ['B'], outputs: ['A'] },
    ],
  });
  const result = step(net, initialMarking(net), {});
  assert.deepEqual(result.fired, ['ab', 'ba']);
  assert.deepEqual(result.marking, { A: 1, B: 1 }, 'both places keep their token; no capacity is exceeded');
  refusal('EvolutionUnstable', () => replay(net, [{ at: null }]));
  assert.equal(MAX_EVOLUTION_ITERATIONS, 64);
});

test('an event evolves to a stable situation: the second verdict fires the join in the same event', () => {
  const net = drainFor(['97']);
  const run = replay(net, [
    { at: '2026-09-04T06:00:00.000Z', level: { 'pr#97/D_HEAD_PUBLISHED': true } },
    { at: '2026-09-04T06:01:00.000Z', level: { 'pr#97/D_STANDARDS_VERDICT_BOUND': true } },
    { at: '2026-09-04T06:02:00.000Z', level: { 'pr#97/D_SPEC_VERDICT_BOUND': true, 'pr#97/D_BOTH_APPROVE_AT_HEAD': true, 'pr#97/D_MERGEABLE_CLEAN': true } },
  ]);
  assert.deepEqual(run.history.map(({ fired }) => fired), [
    ['pr#97/T_FORK_REVIEWS'],
    ['pr#97/T_STANDARDS_VERDICT'],
    ['pr#97/T_SPEC_VERDICT', 'pr#97/T_JOIN_APPROVE', 'pr#97/T_MERGEABLE'],
  ]);
  assert.deepEqual(active(run.marking), ['PROVIDER_CAPACITY', 'pr#97/P_MERGEABLE']);
  assert.equal(run.marking.MERGE_LOCK, 0, 'the lock is held from mergeable to merged');
  // Edge facts are one-shot: replaying the same edge twice does not fire twice.
  const lane = instantiate(LANE_NET_TEMPLATE, ['act-0002']);
  const edges = replay(lane, [
    { at: null, edge: { 'lane#act-0002/L_ATTEMPT_STARTED': true } },
    { at: null, edge: {} },
  ]);
  assert.deepEqual(edges.history.map(({ fired }) => fired), [['lane#act-0002/T_START_ATTEMPT'], []]);
  refusal('FactEventInvalid', () => replay(lane, [{ at: null, level: { 'lane#act-0002/L_ATTEMPT_STARTED': true } }]));
  refusal('FactEventInvalid', () => replay(lane, [{ at: null, edge: { 'lane#act-0002/NOPE': true } }]));
  refusal('FactEventInvalid', () => replay(lane, [{ at: 5 }]));
});

// ---------------------------------------------------------------------------
// the AND-join on the head, and B1
// ---------------------------------------------------------------------------

test('the AND-join refuses a merge when only one axis holds an APPROVE bound to the head', () => {
  const net = drainFor(['95']);
  const oneAxis = markingAt(net, '95', ['P_REVIEW_SPEC', 'P_STANDARDS_VERDICT'], { PROVIDER_CAPACITY: DEFAULT_PROVIDER_CAPACITY - 1 });
  const facts = {
    'pr#95/D_HEAD_PUBLISHED': true,
    'pr#95/D_STANDARDS_VERDICT_BOUND': true,
    'pr#95/D_SPEC_VERDICT_BOUND': false,
    'pr#95/D_BOTH_APPROVE_AT_HEAD': false,
    'pr#95/D_MERGEABLE_CLEAN': true,
    'pr#95/D_NOT_DRAFT': true,
    'pr#95/D_MERGE_CONFIRMED': true,
  };
  const result = step(net, oneAxis, facts);
  assert.deepEqual(result.fired, []);
  assert.equal(result.marking['pr#95/P_DUAL_APPROVED'], 0);
  assert.equal(result.marking['pr#95/P_MERGED'], 0);
  assert.deepEqual(result.blocked.map(({ transition, reason, refusal: name }) => [transition, reason, name]),
    [['pr#95/T_SPEC_VERDICT', 'RECEPTIVITY_FALSE', 'SPEC_VERDICT_NOT_BOUND']]);
  // Even with both verdict tokens present, a single APPROVE does not satisfy the join predicate.
  const bothTokens = markingAt(net, '95', ['P_SPEC_VERDICT', 'P_STANDARDS_VERDICT']);
  const join = enabledTransitions(net, bothTokens, { ...facts, 'pr#95/D_ANY_REQUEST_CHANGES_AT_HEAD': false, 'pr#95/D_FAILURE_FAMILY_REPEATED': false });
  assert.deepEqual(join.enabled, []);
  assert.equal(join.blocked.find(({ transition }) => transition === 'pr#95/T_JOIN_APPROVE').refusal, 'DUAL_APPROVAL_MISSING');

  // Mechanism-revert control: a join that reads one axis fires on the same facts.
  const mutant = buildNet({
    ...DRAIN_NET_TEMPLATE,
    places: [...DRAIN_NET_TEMPLATE.shared, ...DRAIN_NET_TEMPLATE.places],
    transitions: DRAIN_NET_TEMPLATE.transitions.map((transition) => (transition.id === 'T_JOIN_APPROVE'
      ? { ...transition, receptivity: 'D_STANDARDS_VERDICT_BOUND', inputs: ['P_STANDARDS_VERDICT'] }
      : transition)),
  });
  const mutantMarking = { ...initialMarking(mutant), P_DRAFT_HEAD: 0, P_REVIEW_SPEC: 1, P_STANDARDS_VERDICT: 1 };
  const mutantFacts = Object.fromEntries(Object.entries(facts).map(([id, value]) => [id.slice('pr#95/'.length), value]));
  assert.ok(step(mutant, mutantMarking, mutantFacts).fired.includes('T_JOIN_APPROVE'), 'the single-axis mutant merges on one APPROVE');
});

test('a verdict whose Subject line names another SHA does not place a token (B1 of PR #97)', () => {
  const artifacts = loadArtifacts().map(parseArtifact);
  const spec = artifacts.find(({ name }) => name === 'pr95-r0-spec-review.md');
  assert.equal(spec.subjectSha, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
  assert.ok(artifactText('pr95-r0-spec-review.md').includes(K1), 'the prose names the published head');
  const bound = bindAxis(artifacts, { pullRequest: '95', axis: 'SPEC', head: K1 });
  assert.equal(bound.value, false);
  assert.deepEqual(bound.evidence.unbound, [{ name: 'pr95-r0-spec-review.md', reasons: ['SHA_NOT_BOUND'] }]);
  assert.equal(bindAxis(artifacts, { pullRequest: '95', axis: 'STANDARDS', head: K1 }).verdict, 'APPROVE');
  // The R1 artifacts of #97 name the entry H1 in prose and bind only to H2.
  assert.equal(bindAxis(artifacts, { pullRequest: '97', axis: 'SPEC', head: H1 }).evidence.unbound[0]?.reasons[0], 'SHA_NOT_BOUND');
  assert.equal(bindAxis(artifacts, { pullRequest: '97', axis: 'SPEC', head: H2 }).verdict, 'APPROVE');
  assert.equal(bindAxis(artifacts, { pullRequest: '97', axis: 'SPEC', head: H3 }).value, false);

  // Through the whole fold: #95 sits in the Spec review place with the Standards verdict bound.
  const facts = collectDrainFacts({ records: loadRecords(), artifacts: loadArtifacts() });
  const net = drainFor(facts.pullRequests);
  const run = replay(net, facts.drainEvents);
  assert.equal(run.marking['pr#95/P_REVIEW_SPEC'], 1);
  assert.equal(run.marking['pr#95/P_STANDARDS_VERDICT'], 1);
  assert.equal(run.marking['pr#95/P_DUAL_APPROVED'], 0);
  const waiting = run.history.at(-1).blocked.find(({ transition }) => transition === 'pr#95/T_SPEC_VERDICT');
  assert.deepEqual([waiting.reason, waiting.refusal], ['RECEPTIVITY_FALSE', 'SPEC_VERDICT_NOT_BOUND']);
  assert.deepEqual(run.facts['pr#95/D_SPEC_VERDICT_BOUND'].evidence.unbound, [{ name: 'pr95-r0-spec-review.md', reasons: ['SHA_NOT_BOUND'] }]);

  // Mechanism-revert control: binding by containment accepts the same artifact.
  const containment = artifacts.filter((artifact) => artifact.kind === 'REVIEW' && artifact.pullRequest === '95' && artifact.axis === 'SPEC')
    .filter(({ name }) => artifactText(name).includes(K1));
  assert.equal(containment.length, 1, 'the containment mutant binds the B1 artifact');
});

test('artifact parsing reads only the fixed lines and names every refusal', () => {
  const good = parseArtifact({ name: 'a.md', bytes: bytes(artifactText('pr97-r0-spec-review.md')) });
  assert.deepEqual(
    [good.kind, good.pullRequest, good.axis, good.verdict, good.subjectSha, good.family, good.marker, good.refusals],
    ['REVIEW', '97', 'SPEC', 'REQUEST_CHANGES', H1, 'verdict-binding', 'PR97_R0_SPEC_COMPLETE', []],
  );
  assert.match(good.sha256, /^[a-f0-9]{64}$/u);
  const other = parseArtifact({ name: 'h.md', bytes: bytes('# handoff\n\nDONE_COMPLETE\n') });
  assert.deepEqual([other.kind, other.marker, other.refusals], ['OTHER', 'DONE_COMPLETE', ['NOT_A_REVIEW']]);
  const twoVerdicts = parseArtifact({ name: 't.md', bytes: bytes('# PR #5 - R0 independent Spec review\n\n**Verdict: APPROVE**\n**Verdict: REQUEST_CHANGES**\n\nSubject: x, detached at\n`' + H1 + '`\n\nX_COMPLETE\n') });
  assert.deepEqual(twoVerdicts.refusals, ['VERDICT_AMBIGUOUS']);
  const bare = parseArtifact({ name: 'b.md', bytes: bytes('# PR #5 - R0 review\n\nprose naming detached at ' + H1 + '\n\nnot a marker\n') });
  assert.deepEqual(bare.refusals, ['AXIS_MISSING', 'SUBJECT_NOT_STATED', 'VERDICT_MISSING', 'MARKER_MISSING']);
  const bothAxes = parseArtifact({ name: 'c.md', bytes: bytes('# PR #5 - Spec and Standards review\n\n**Verdict: APPROVE**\n\nSubject: y, detached at ' + H1 + '\n\nX_COMPLETE\n') });
  assert.equal(bothAxes.refusals[0], 'AXIS_AMBIGUOUS');
  // The Subject header stops at the first blank line: a SHA below it binds nothing.
  const late = parseArtifact({ name: 'd.md', bytes: bytes('# PR #5 - R0 independent Spec review\n\n**Verdict: APPROVE**\n\nSubject: z\n\ndetached at ' + H1 + '\n\nX_COMPLETE\n') });
  assert.equal(late.subjectSha, null);
  assert.deepEqual(late.refusals, ['SUBJECT_NOT_STATED']);
  // A marker quoted in prose is not a marker unless it is the last non-empty line.
  const partial = parseArtifact({ name: 'p.md', bytes: bytes(artifactText('gaia-partial-handoff.md')) });
  assert.equal(partial.marker, null);
  assert.equal(partial.lastNonEmptyLine, 'Still writing.');
  // CRLF bytes parse to the same fields (the digest differs, as it must).
  const crlf = parseArtifact({ name: 'a.md', bytes: bytes(artifactText('pr97-r0-spec-review.md').replaceAll('\n', '\r\n')) });
  assert.equal(crlf.subjectSha, good.subjectSha);
  assert.notEqual(crlf.sha256, good.sha256);
  assert.throws(() => parseArtifact({ name: 'x', bytes: 'text' }), (error) => error instanceof DrainFactsError && error.code === 'ArtifactBytesInvalid');
  // Two bound artifacts with different verdicts bind nothing.
  const conflict = [
    parseArtifact({ name: 'one.md', bytes: bytes(artifactText('pr97-r1-spec-review.md')) }),
    parseArtifact({ name: 'two.md', bytes: bytes(artifactText('pr97-r1-spec-review.md').replace('**Verdict: APPROVE**', '**Verdict: REQUEST_CHANGES**')) }),
  ];
  assert.equal(bindAxis(conflict, { pullRequest: '97', axis: 'SPEC', head: H2 }).evidence.reason, 'VERDICT_CONFLICT');
});

// ---------------------------------------------------------------------------
// resources: the merge lock and provider capacity
// ---------------------------------------------------------------------------

test('the merge-lock resource place serialises reconciliations (B35)', () => {
  const net = drainFor(['92', '97']);
  const marking = {
    ...initialMarking(net),
    'pr#92/P_DRAFT_HEAD': 0, 'pr#92/P_DUAL_APPROVED': 1,
    'pr#97/P_DRAFT_HEAD': 0, 'pr#97/P_DUAL_APPROVED': 1,
  };
  const facts = { 'pr#92/D_CONFLICTING': true, 'pr#97/D_CONFLICTING': true };
  const first = step(net, marking, facts);
  assert.deepEqual(first.fired, ['pr#92/T_RECONCILE_START'], 'one reconciliation takes the lock');
  assert.equal(first.marking.MERGE_LOCK, 0);
  const held = first.blocked.find(({ transition }) => transition === 'pr#97/T_RECONCILE_START');
  assert.deepEqual([held.reason, held.places], ['RESOURCE_UNAVAILABLE', ['MERGE_LOCK']]);
  // The lock stays held through mergeable and ready; it returns on the merge.
  const reconciled = step(net, first.marking, { ...facts, 'pr#92/D_RECONCILIATION_CLASSIFIED': true });
  assert.deepEqual(reconciled.fired, ['pr#92/T_RECONCILED']);
  assert.equal(reconciled.marking.MERGE_LOCK, 0);
  const ready = step(net, reconciled.marking, { 'pr#92/D_NOT_DRAFT': true, 'pr#97/D_CONFLICTING': true });
  assert.deepEqual(ready.fired, ['pr#92/T_READY']);
  const merged = step(net, ready.marking, { 'pr#92/D_MERGE_CONFIRMED': true, 'pr#97/D_CONFLICTING': true });
  assert.deepEqual(merged.fired, ['pr#92/T_MERGE', 'pr#97/T_RECONCILE_START'], 'the merge releases the lock and the next reconciliation starts');
  assert.equal(merged.marking.MERGE_LOCK, 0);
  // A rejected reconciliation returns the lock and the head goes back to review.
  const rejected = step(net, merged.marking, { 'pr#97/D_RECONCILIATION_UNCLASSIFIED': true });
  assert.deepEqual(rejected.fired, ['pr#97/T_RECONCILE_REJECTED']);
  assert.equal(rejected.marking.MERGE_LOCK, 1);
  assert.equal(rejected.marking['pr#97/P_DRAFT_HEAD'], 1);
  // A mergeable or ready pull request re-conflicted by another merge enters reconciliation holding its lock.
  const reconflicted = step(net, { ...initialMarking(net), 'pr#92/P_DRAFT_HEAD': 0, 'pr#92/P_READY': 1, 'pr#97/P_DRAFT_HEAD': 0, MERGE_LOCK: 0 }, { 'pr#92/D_CONFLICTING': true });
  assert.deepEqual(reconflicted.fired, ['pr#92/T_READY_RECONFLICTED']);

  // Mechanism-revert control: without the lock arc both reconciliations start together.
  const mutant = buildNet({
    ...DRAIN_NET_TEMPLATE,
    netId: 'mutant',
    places: [...DRAIN_NET_TEMPLATE.shared, ...['92', '97'].flatMap((key) => DRAIN_NET_TEMPLATE.places.map((place) => ({ ...place, id: `pr#${key}/${place.id}` })))],
    receptivities: Object.fromEntries(['92', '97'].flatMap((key) => Object.entries(DRAIN_NET_TEMPLATE.receptivities).map(([id, entry]) => [`pr#${key}/${id}`, entry]))),
    transitions: ['92', '97'].flatMap((key) => DRAIN_NET_TEMPLATE.transitions.map((transition) => {
      const localId = (id) => (DRAIN_NET_TEMPLATE.shared.some((place) => place.id === id) ? id : `pr#${key}/${id}`);
      const local = (arc) => (typeof arc === 'string' ? localId(arc) : { ...arc, place: localId(arc.place) });
      return {
        ...transition,
        id: `pr#${key}/${transition.id}`,
        receptivity: `pr#${key}/${transition.receptivity}`,
        inputs: transition.inputs.map(local).filter((arc) => !(transition.id === 'T_RECONCILE_START' && arc === 'MERGE_LOCK')),
        outputs: transition.outputs.map(local),
        inhibitors: (transition.inhibitors ?? []).map(local),
      };
    })),
  });
  const mutantMarking = { ...marking };
  assert.deepEqual(step(mutant, mutantMarking, facts).fired, ['pr#92/T_RECONCILE_START', 'pr#97/T_RECONCILE_START'], 'the lock-less mutant reconciles both at once');
});

test('provider capacity is a multi-token resource place that lanes take and return', () => {
  const net = drainFor(['92', '95', '97'], { capacity: 4 });
  const facts = { 'pr#92/D_HEAD_PUBLISHED': true, 'pr#95/D_HEAD_PUBLISHED': true, 'pr#97/D_HEAD_PUBLISHED': true };
  const forked = step(net, initialMarking(net), facts);
  assert.deepEqual(forked.fired, ['pr#92/T_FORK_REVIEWS', 'pr#95/T_FORK_REVIEWS']);
  assert.equal(forked.marking.PROVIDER_CAPACITY, 0);
  assert.deepEqual(forked.blocked.map(({ transition, reason }) => [transition, reason]), [['pr#97/T_FORK_REVIEWS', 'RESOURCE_UNAVAILABLE']]);
  const returned = step(net, forked.marking, { ...facts, 'pr#92/D_SPEC_VERDICT_BOUND': true, 'pr#92/D_STANDARDS_VERDICT_BOUND': true });
  assert.deepEqual(returned.fired, ['pr#92/T_SPEC_VERDICT', 'pr#92/T_STANDARDS_VERDICT', 'pr#97/T_FORK_REVIEWS'], 'returned tokens let the third fork fire in the same event');
  assert.equal(returned.marking.PROVIDER_CAPACITY, 0);
});

// ---------------------------------------------------------------------------
// replay determinism
// ---------------------------------------------------------------------------

test('replay is deterministic across shuffled input orders and yields the same revisions', () => {
  const records = loadRecords();
  const artifacts = loadArtifacts();
  const reference = collectDrainFacts({ records, artifacts });
  const drain = drainFor(reference.pullRequests);
  const lane = instantiate(LANE_NET_TEMPLATE, reference.lanes);
  const referenceDrain = replay(drain, reference.drainEvents);
  const referenceLane = replay(lane, reference.laneEvents);
  assert.deepEqual(active(referenceDrain.marking), ['PROVIDER_CAPACITY', 'pr#92/P_BLOCKED_REDESIGN', 'pr#95/P_REVIEW_SPEC', 'pr#95/P_STANDARDS_VERDICT', 'pr#97/P_RECONCILE']);
  assert.equal(referenceDrain.marking.PROVIDER_CAPACITY, 2,
    'the stuck Spec review of #95 and incomplete reconciliation of #97 each hold one lane');
  assert.equal(referenceDrain.marking.MERGE_LOCK, 0, 'the incomplete reconciliation still holds the lock');
  let seed = 41;
  const random = () => { seed = (seed * 48271) % 2147483647; return seed / 2147483647; };
  const shuffle = (list) => [...list].sort(() => random() - 0.5);
  for (const variant of [shuffle(records), [...records].reverse(), shuffle(shuffle(records)), [...records, ...records.slice(0, 5)]]) {
    const facts = collectDrainFacts({ records: variant, artifacts: shuffle(artifacts) });
    assert.equal(facts.inputsRevision, reference.inputsRevision === facts.inputsRevision ? reference.inputsRevision : facts.inputsRevision);
    const drainRun = replay(drainFor(facts.pullRequests), facts.drainEvents);
    const laneRun = replay(instantiate(LANE_NET_TEMPLATE, facts.lanes), facts.laneEvents);
    assert.equal(drainRun.markingRevision, referenceDrain.markingRevision, 'drain marking revision');
    assert.equal(laneRun.markingRevision, referenceLane.markingRevision, 'lane marking revision');
    assert.equal(canonicalJson(drainRun.history.map(({ fired, at }) => [at, fired])), canonicalJson(referenceDrain.history.map(({ fired, at }) => [at, fired])));
  }
  assert.equal(collectDrainFacts({ records: shuffle(records), artifacts }).inputsRevision, reference.inputsRevision, 'a shuffled log has the same inputs revision');
  assert.notEqual(collectDrainFacts({ records: records.slice(0, -1), artifacts }).inputsRevision, reference.inputsRevision);
});

test('the fold reads the fleet channels: lifecycle notes, lane sends, pr-observation tokens, and digests', () => {
  const facts = collectDrainFacts({ records: loadRecords(), artifacts: loadArtifacts() });
  assert.deepEqual(facts.pullRequests, ['92', '95', '97']);
  assert.equal(facts.lanes.length, 13);
  assert.deepEqual(facts.refused, [
    { ordinal: 22, source: 'message.sent#22', reason: 'RECONCILIATION_EVIDENCE_INCOMPLETE', key: H3 },
    { ordinal: 65, source: 'message.sent#65', reason: 'OBSERVATION_KEY_UNKNOWN', key: 'color' },
  ]);
  const lane = instantiate(LANE_NET_TEMPLATE, facts.lanes);
  const run = replay(lane, facts.laneEvents);
  const place = (ref) => active(run.marking).filter((id) => id.startsWith(`lane#${ref}/`)).map((id) => id.slice(id.indexOf('/') + 1));
  assert.deepEqual(place('act-0002'), ['L_MARKER_VERIFIED'], 'API error, resume, clean exit, complete, verified');
  assert.deepEqual(run.history.filter(({ fired }) => fired.some((id) => id.startsWith('lane#act-0002/'))).map(({ fired }) => fired.map((id) => id.slice(id.indexOf('/') + 1))),
    [['T_START_ATTEMPT'], ['T_EXIT_ERROR'], ['T_RESUME_AFTER_ERROR'], ['T_EXIT_CLEAN'], ['T_COMPLETE', 'T_MARKER_VERIFIED']]);
  assert.deepEqual(place('act-0008'), ['L_EXHAUSTED']);
  assert.deepEqual(place('act-0009'), ['L_ABORTED']);
  assert.deepEqual(place('act-0014'), ['L_COMPLETED'], 'the partial handoff completed but its marker is not its last line');
  const partial = run.history.at(-1).blocked.find(({ transition }) => transition === 'lane#act-0014/T_MARKER_VERIFIED');
  assert.deepEqual([partial.reason, partial.refusal], ['RECEPTIVITY_FALSE', 'MARKER_UNVERIFIED']);
  assert.equal(run.facts['lane#act-0014/L_MARKER_DIGEST_EQUAL'].evidence.reason, 'MARKER_NOT_LAST_LINE');
  assert.equal(run.marking.LANE_SLOTS, 4, 'every terminal lane returned its slot');
  // A lane-complete whose artifact is not in the directory is unverifiable, not false.
  const missing = collectDrainFacts({ records: loadRecords(), artifacts: loadArtifacts().filter(({ name }) => name !== 'pr97-r0-spec-review.md') });
  assert.equal(replay(instantiate(LANE_NET_TEMPLATE, missing.lanes), missing.laneEvents).facts['lane#act-0002/L_MARKER_DIGEST_EQUAL'].value, 'UNKNOWN');
  // A digest that does not match the file is false.
  const tampered = loadArtifacts().map((artifact) => (artifact.name === 'pr97-r0-spec-review.md' ? { ...artifact, bytes: bytes(`${artifactText(artifact.name)}\n`) } : artifact));
  const mismatch = collectDrainFacts({ records: loadRecords(), artifacts: tampered });
  assert.equal(replay(instantiate(LANE_NET_TEMPLATE, mismatch.lanes), mismatch.laneEvents).facts['lane#act-0002/L_MARKER_DIGEST_EQUAL'].evidence.reason, 'DIGEST_MISMATCH');
  // Observation grammar: closed keys, closed values, required keys.
  assert.deepEqual(Object.keys(PR_OBSERVATION_GRAMMAR).sort(), ['checks', 'draft', 'head', 'issue', 'issueState', 'mergeCommit', 'mergeable', 'pr', 'reconciliation', 'state']);
  assert.deepEqual(parseClosedTokens('a=1;b=2'), { tokens: { a: '1', b: '2' } });
  assert.equal(parseClosedTokens('a=1;a=2').error, 'KEY_REPEATED');
  assert.equal(parseClosedTokens('a').error, 'PAIR_MALFORMED');
  const observe = (text, at = '2026-09-04T07:00:00.000Z') => ({ type: 'message.sent', at, message: { from: 'act-0001', kind: 'pr-observation', text } });
  // All three share one `at`; the fold breaks the tie by canonical content (never input position),
  // the same rule the shuffle-determinism test above relies on, so this is that rule's own order.
  const bad = collectDrainFacts({
    records: [registerCoordinator(), observe('pr=97;head=short'), observe('head=' + H1), observe('pr=97;head=' + H1 + ';state=MAYBE')],
    artifacts: [],
  });
  assert.deepEqual(bad.refused.map(({ reason, key }) => [reason, key]), [['OBSERVATION_KEY_MISSING', 'pr'], ['OBSERVATION_VALUE_INVALID', 'state'], ['OBSERVATION_VALUE_INVALID', 'head']]);
  assert.deepEqual(bad.pullRequests, []);
  assert.throws(() => collectDrainFacts({ records: [{ type: 'x', at: 'yesterday' }], artifacts: [] }), (error) => error.code === 'RecordsInvalid');
  assert.throws(() => collectDrainFacts({ records: [], artifacts: [{ name: 'a', bytes: bytes('x') }, { name: 'a', bytes: bytes('y') }] }), (error) => error.code === 'ArtifactsInvalid');
});

test('an unobserved fact is UNKNOWN and holds the chart; an observed false fact names its refusal', () => {
  const observe = (text, at) => ({ type: 'message.sent', at, message: { from: 'act-0001', kind: 'pr-observation', text } });
  // Scoped to pr97's own artifacts: the net below is built for pr97 alone, and the fixture's pr92
  // and pr95 review artifacts would otherwise still surface at the terminal snapshot and name a
  // receptivity this narrower net never declared.
  const pr97Artifacts = loadArtifacts().filter(({ name }) => !name.startsWith('pr92') && !name.startsWith('pr95'));
  const facts = collectDrainFacts({
    records: [registerCoordinator(), observe(`pr=97;head=${H2}`, '2026-09-04T07:00:00.000Z')], artifacts: pr97Artifacts,
  });
  const net = drainFor(['97']);
  const run = replay(net, facts.drainEvents);
  assert.deepEqual(active(run.marking), ['MERGE_LOCK', 'PROVIDER_CAPACITY', 'pr#97/P_DUAL_APPROVED'], 'the R1 artifacts bind at the snapshot');
  const waiting = Object.fromEntries(run.history.at(-1).blocked.map(({ transition, reason }) => [transition, reason]));
  assert.deepEqual(waiting, {
    'pr#97/T_DUAL_APPROVED_HEAD_ADVANCED': 'RECEPTIVITY_UNKNOWN',
    'pr#97/T_MERGEABLE': 'RECEPTIVITY_UNKNOWN',
    'pr#97/T_RECONCILE_START': 'RECEPTIVITY_UNKNOWN',
  });
  const observed = collectDrainFacts({
    records: [registerCoordinator(), observe(`pr=97;head=${H2};mergeable=UNKNOWN`, '2026-09-04T07:00:00.000Z')], artifacts: pr97Artifacts,
  });
  const second = replay(net, observed.drainEvents);
  assert.deepEqual(second.history.at(-1).blocked.map(({ transition, reason, refusal: name }) => [transition, reason, name]),
    [
      ['pr#97/T_DUAL_APPROVED_HEAD_ADVANCED', 'RECEPTIVITY_UNKNOWN', 'HEAD_UNCHANGED'],
      ['pr#97/T_MERGEABLE', 'RECEPTIVITY_FALSE', 'NOT_MERGEABLE'],
      ['pr#97/T_RECONCILE_START', 'RECEPTIVITY_FALSE', 'NOT_CONFLICTING'],
    ]);
  // The breaker never lifts without a class-D order, which R0 has no channel for.
  const tripped = collectDrainFacts({ records: loadRecords(), artifacts: loadArtifacts() });
  const drain = replay(drainFor(tripped.pullRequests), tripped.drainEvents);
  const breaker = drain.history.at(-1).blocked.find(({ transition }) => transition === 'pr#92/T_REDESIGN_RESUMED');
  assert.deepEqual([breaker.reason, breaker.refusal], ['RECEPTIVITY_UNKNOWN', 'REDESIGN_ORDER_ABSENT']);
  assert.deepEqual(drain.facts['pr#92/D_FAILURE_FAMILY_REPEATED'], { value: true, evidence: { families: ['receipt-boundary'] } });
});

// ---------------------------------------------------------------------------
// adversarial: forged and stale pr-observations must not move durable work
// ---------------------------------------------------------------------------

test('a pr-observation is folded only from the exact caller-authorized source (forged observation)', () => {
  const observe = (from, text, at) => ({ type: 'message.sent', at, message: { from, kind: 'pr-observation', text } });
  const registerLane = (ref, at) => ({ type: 'actor.registered', at, ref, kind: 'lane', isNew: true });
  const at = '2026-09-04T06:00:00.000Z';
  assert.throws(
    () => collectDrainFactsRaw({ records: [], artifacts: [] }),
    (error) => error instanceof DrainFactsError && error.code === 'ObservationSourceInvalid',
  );
  assert.throws(
    () => collectDrainFactsRaw({
      observationSource: 'act-9999',
      records: [observe('act-9999', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at)],
      artifacts: [],
    }),
    (error) => error instanceof DrainFactsError && error.code === 'ObservationSourceUnregistered',
    'a syntactically valid caller claim is not proof that the bus minted the source',
  );
  const registeredAt = '2026-09-04T06:01:00.000Z';
  assert.throws(
    () => collectDrainFactsRaw({
      observationSource: 'act-9996',
      records: [
        observe('act-9996', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
        registerCoordinator(registeredAt, 'act-9996'),
      ],
      artifacts: [],
    }),
    (error) => error instanceof DrainFactsError && error.code === 'ObservationSourceUnregistered',
    'a future registration cannot authorize an earlier observation retroactively',
  );
  assert.throws(
    () => collectDrainFactsRaw({
      observationSource: 'act-9997',
      records: [
        observe('act-9997', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
        { type: 'actor.registered', ref: 'act-9997', kind: 'coordinator', isNew: true },
      ],
      artifacts: [],
    }),
    (error) => error instanceof DrainFactsError && error.code === 'ObservationSourceUnregistered',
    'an untimestamped registration cannot sort ahead and authorize a timestamped observation',
  );
  // A lane, an unregistered ref, and a second actor self-declaring the coordinator kind may not
  // source a pr-observation. Actor kind is descriptive bus data, never authorization.
  const forged = collectDrainFacts({
    observationSource: 'act-0001',
    records: [
      registerCoordinator(at, 'act-0001'),
      registerLane('act-0002', at),
      registerCoordinator(at, 'act-0003'),
      observe('act-0002', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
      observe('act-0099', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
      observe('act-0003', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
    ],
    artifacts: [],
  });
  assert.deepEqual(forged.pullRequests, [], 'the forged observations never open a pull-request instance');
  assert.deepEqual(forged.refused.map(({ reason, key }) => [reason, key]), [
    ['OBSERVATION_SOURCE_UNAUTHORIZED', 'act-0002'],
    ['OBSERVATION_SOURCE_UNAUTHORIZED', 'act-0003'],
    ['OBSERVATION_SOURCE_UNAUTHORIZED', 'act-0099'],
  ]);

  // Mechanism-revert control: the identical text from the authorized ref is accepted even though
  // its self-declared kind is deliberately unrelated.
  const genuine = collectDrainFacts({
    observationSource: 'act-0001',
    records: [
      { type: 'actor.registered', at, ref: 'act-0001', kind: 'untrusted-description', isNew: true },
      observe('act-0001', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
    ],
    artifacts: [],
  });
  assert.deepEqual(genuine.pullRequests, ['41']);
  assert.deepEqual(genuine.refused, []);

  // Mechanism-revert control: moving only the registration before the otherwise identical
  // observation makes the source causally registered and therefore admissible.
  const causal = collectDrainFactsRaw({
    observationSource: 'act-9996',
    records: [
      registerCoordinator('2026-09-04T05:59:00.000Z', 'act-9996'),
      observe('act-9996', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
    ],
    artifacts: [],
  });
  assert.deepEqual(causal.pullRequests, ['41']);
  assert.deepEqual(causal.refused, []);

  // Mechanism-revert mutation: adding the honest prior timestamp to the same registration is the
  // only change needed to make the observation admissible.
  const timestamped = collectDrainFactsRaw({
    observationSource: 'act-9997',
    records: [
      observe('act-9997', `pr=41;head=${H1};draft=true;mergeable=MERGEABLE`, at),
      { type: 'actor.registered', at: '2026-09-04T05:59:00.000Z', ref: 'act-9997', kind: 'coordinator', isNew: true },
    ],
    artifacts: [],
  });
  assert.deepEqual(timestamped.pullRequests, ['41']);
  assert.deepEqual(timestamped.refused, []);
});

test('head advancement preempts downstream merge readiness until a reconciliation transition fires', () => {
  const net = drainFor(['41']);
  const headAdvanced = {
    'pr#41/D_HEAD_ADVANCED': { value: true, evidence: { from: H1, to: H2 } },
    'pr#41/D_MERGEABLE_CLEAN': { value: true, evidence: { head: H2 } },
    'pr#41/D_NOT_DRAFT': { value: true, evidence: { head: H2 } },
    'pr#41/D_MERGE_CONFIRMED': { value: true, evidence: { head: H2, mergeCommit: K1 } },
  };

  const fromDualApproved = step(net, markingAt(net, '41', ['P_DUAL_APPROVED']), headAdvanced);
  assert.deepEqual(fromDualApproved.fired, ['pr#41/T_DUAL_APPROVED_HEAD_ADVANCED']);
  assert.deepEqual(active(fromDualApproved.marking), ['PROVIDER_CAPACITY', 'pr#41/P_RECONCILE'],
    'the changed head invalidates old-head approval before mergeable can win');

  const fromReady = step(net, markingAt(net, '41', ['P_READY'], { MERGE_LOCK: 0 }), headAdvanced);
  assert.deepEqual(fromReady.fired, ['pr#41/T_READY_HEAD_ADVANCED']);
  assert.deepEqual(active(fromReady.marking), ['PROVIDER_CAPACITY', 'pr#41/P_RECONCILE'],
    'the changed head invalidates ready before merge confirmation can win');

  // Honest positive controls: only the explicit reconciliation transition releases either
  // preempted marking back to mergeable, restoring provider capacity but retaining the lock.
  for (const preempted of [fromDualApproved.marking, fromReady.marking]) {
    const reconciled = step(net, preempted, {
      'pr#41/D_RECONCILIATION_CLASSIFIED': { value: true, evidence: { head: H2 } },
    });
    assert.deepEqual(reconciled.fired, ['pr#41/T_RECONCILED']);
    assert.deepEqual(active(reconciled.marking), ['PROVIDER_CAPACITY', 'pr#41/P_MERGEABLE']);
  }
});

test('reconciliation=CLASSIFIED binds only alongside an actual revision change (forged or stale reconciliation)', () => {
  const observe = (text, at) => ({ type: 'message.sent', at, message: { from: 'act-0001', kind: 'pr-observation', text } });
  const t0 = '2026-09-04T06:00:00.000Z';
  const t1 = '2026-09-04T06:01:00.000Z';

  // The same head named twice, the second time asserting CLASSIFIED: no revision moved behind it.
  const forged = collectDrainFacts({
    records: [
      registerCoordinator(t0),
      observe(`pr=41;head=${H1};draft=true;mergeable=CONFLICTING`, t0),
      observe(`pr=41;head=${H1};draft=true;mergeable=MERGEABLE;reconciliation=CLASSIFIED`, t1),
    ],
    artifacts: [],
  });
  assert.deepEqual(forged.refused.map(({ reason }) => reason), ['RECONCILIATION_WITHOUT_REVISION_CHANGE']);
  assert.equal(forged.drainEvents.at(-1).edge['pr#41/D_RECONCILIATION_CLASSIFIED'], undefined,
    'the bare assertion manufactures no fact');
  const net = drainFor(['41']);
  const stuck = replay(net, forged.drainEvents);
  assert.equal(stuck.marking['pr#41/P_MERGEABLE'], 0, 'the forged classification never releases anything');

  // A CLASSIFIED claiming the very first observation (no prior head at all) is equally bare.
  const bareFirst = collectDrainFacts({
    records: [registerCoordinator(t0), observe(`pr=41;head=${H1};reconciliation=CLASSIFIED`, t0)],
    artifacts: [],
  });
  assert.deepEqual(bareFirst.refused.map(({ reason }) => reason), ['RECONCILIATION_WITHOUT_REVISION_CHANGE']);

  // Mechanism-revert control: a genuine head change plus exact-head dual APPROVE artifacts and
  // checks=ALL_PASS is accepted. The lane-complete sends make the review bytes visible before the
  // classification observation; a directory snapshot alone has no instant and cannot backdate it.
  const review = (axis) => parseArtifact({
    name: `pr41-r1-${axis.toLowerCase()}-review.md`,
    bytes: bytes(`# PR #41 ${axis} review\nSubject: detached at ${H2}\n\n**Verdict: APPROVE**\nPR41_R1_${axis}_COMPLETE\n`),
  });
  const spec = review('SPEC');
  const standards = review('STANDARDS');
  const complete = (from, artifact, at) => ({
    type: 'message.sent', at, message: {
      from, kind: 'lane-complete',
      text: `${artifact.name};sha256=${artifact.sha256};marker=${artifact.marker}`,
    },
  });
  const genuine = collectDrainFacts({
    records: [
      registerCoordinator(t0),
      observe(`pr=41;head=${H1};draft=true;mergeable=CONFLICTING`, t0),
      { type: 'actor.registered', at: '2026-09-04T06:00:10.000Z', ref: 'act-0002', kind: 'lane' },
      { type: 'actor.registered', at: '2026-09-04T06:00:20.000Z', ref: 'act-0003', kind: 'lane' },
      complete('act-0002', spec, '2026-09-04T06:00:30.000Z'),
      complete('act-0003', standards, '2026-09-04T06:00:40.000Z'),
      observe(`pr=41;head=${H2};draft=true;mergeable=MERGEABLE;checks=ALL_PASS;reconciliation=CLASSIFIED`, t1),
    ],
    artifacts: [
      { name: spec.name, bytes: bytes(`# PR #41 SPEC review\nSubject: detached at ${H2}\n\n**Verdict: APPROVE**\nPR41_R1_SPEC_COMPLETE\n`) },
      { name: standards.name, bytes: bytes(`# PR #41 STANDARDS review\nSubject: detached at ${H2}\n\n**Verdict: APPROVE**\nPR41_R1_STANDARDS_COMPLETE\n`) },
    ],
  });
  assert.deepEqual(genuine.refused, []);
  const classified = genuine.drainEvents.find((event) => event.edge['pr#41/D_RECONCILIATION_CLASSIFIED'] !== undefined);
  assert.equal(classified.edge['pr#41/D_RECONCILIATION_CLASSIFIED'].value, true);
});

test('a changed head cannot complete without an actual reconciliation transition plus exact-head reviews and checks', () => {
  // Exact R1 blocker reproduction: remove the conflicting observation that entered P_RECONCILE,
  // while leaving the later changed-head CLASSIFIED claim in the durable fixture.
  const records = loadRecords().filter((record) => record.message?.messageId !== 'msg-0007');
  const facts = collectDrainFacts({ records, artifacts: loadArtifacts() });
  const run = replay(drainFor(facts.pullRequests), facts.drainEvents);
  const firings = run.history.flatMap(({ fired }) => fired);

  assert.equal(run.marking['pr#97/P_ISSUE_RECONCILED'], 0,
    'head drift cannot ride the prior head approval through merge and issue reconciliation');
  assert.ok(firings.includes('pr#97/T_MERGEABLE_HEAD_ADVANCED'),
    'the changed downstream head must first enter the reconciliation place');
  assert.ok(!firings.includes('pr#97/T_RECONCILED'),
    'CLASSIFIED without exact-head reviews and ALL_PASS checks does not complete reconciliation');

  // Mechanism-revert control: at the same changed head, the current fixture has neither reviews
  // bound to H3 nor checks=ALL_PASS, so accepting its bare label is the exact unsafe mutation.
  const classified = facts.drainEvents.find(({ edge }) => edge['pr#97/D_RECONCILIATION_CLASSIFIED']);
  assert.equal(classified, undefined);
  assert.ok(facts.refused.some(({ reason }) => reason === 'RECONCILIATION_EVIDENCE_INCOMPLETE'));

  // Honest positive control: once the net has entered P_RECONCILE, both exact-H3 APPROVE bytes
  // are visible and the changed-head observation also reports ALL_PASS, T_RECONCILED fires.
  const artifactBytes = (axis) => bytes(
    `# PR #97 ${axis} review\nSubject: detached at ${H3}\n\n**Verdict: APPROVE**\nPR97_R2_${axis}_COMPLETE\n`,
  );
  const extraArtifacts = ['SPEC', 'STANDARDS'].map((axis) => ({
    name: `pr97-r2-${axis.toLowerCase()}-review.md`, bytes: artifactBytes(axis),
  }));
  const parsed = extraArtifacts.map(parseArtifact);
  const beforeClassification = loadRecords()
    .filter(({ at }) => at <= '2026-09-04T06:11:30.000Z')
    .map((record) => record.message?.messageId === 'msg-0008'
      ? { ...record, message: { ...record.message, text: `${record.message.text};checks=ALL_PASS` } }
      : record);
  const complete = (from, artifact, at) => ({
    type: 'message.sent', at, message: {
      from, kind: 'lane-complete',
      text: `${artifact.name};sha256=${artifact.sha256};marker=${artifact.marker}`,
    },
  });
  beforeClassification.push(
    { type: 'actor.registered', at: '2026-09-04T06:11:05.000Z', ref: 'act-0020', kind: 'lane' },
    { type: 'actor.registered', at: '2026-09-04T06:11:10.000Z', ref: 'act-0021', kind: 'lane' },
    complete('act-0020', parsed[0], '2026-09-04T06:11:15.000Z'),
    complete('act-0021', parsed[1], '2026-09-04T06:11:20.000Z'),
  );
  const proven = collectDrainFacts({
    records: beforeClassification,
    artifacts: [...loadArtifacts(), ...extraArtifacts],
  });
  const provenRun = replay(drainFor(proven.pullRequests), proven.drainEvents);
  assert.ok(provenRun.history.flatMap(({ fired }) => fired).includes('pr#97/T_RECONCILED'));
  assert.equal(provenRun.marking['pr#97/P_MERGEABLE'], 1);
});

test('an approval bound to one head does not authorize mergeable, ready or merged at a silently later head (adversarial head change)', () => {
  const reviewArtifacts = loadArtifacts().filter(({ name }) => name.startsWith('pr97-r1'));
  const parsed = reviewArtifacts.map(parseArtifact);
  const specArtifact = parsed.find(({ axis }) => axis === 'SPEC');
  const standardsArtifact = parsed.find(({ axis }) => axis === 'STANDARDS');
  const observe = (text, at) => ({ type: 'message.sent', at, message: { from: 'act-0001', kind: 'pr-observation', text } });
  const laneComplete = (from, artifact, at) => ({
    type: 'message.sent', at, message: { from, kind: 'lane-complete', text: `${artifact.name};sha256=${artifact.sha256};marker=${artifact.marker}` },
  });
  const t = (m) => `2026-09-04T06:0${m}:00.000Z`;
  const upToApprovalRecords = [
    registerCoordinator(t(0)),
    { type: 'actor.registered', at: t(0), ref: 'act-0002', kind: 'lane', isNew: true },
    { type: 'actor.registered', at: t(0), ref: 'act-0003', kind: 'lane', isNew: true },
    observe(`pr=97;head=${H1};draft=true;mergeable=MERGEABLE`, t(1)),
    observe(`pr=97;head=${H2};draft=true;mergeable=MERGEABLE`, t(2)),
    laneComplete('act-0002', specArtifact, t(3)),
    laneComplete('act-0003', standardsArtifact, t(4)),
  ];
  const net = drainFor(['97']);
  const approved = collectDrainFacts({ records: upToApprovalRecords, artifacts: reviewArtifacts });
  const approvedRun = replay(net, approved.drainEvents);
  assert.equal(approvedRun.marking['pr#97/P_MERGEABLE'], 1, 'dual approval and a clean head at that same head reach mergeable');
  assert.equal(approvedRun.facts['pr#97/D_MERGEABLE_CLEAN'].evidence.approvedHead, H2);

  // The adversary: the head silently moves to an unreviewed H3 while still reporting clean and ready.
  const adversarial = collectDrainFacts({
    records: [...upToApprovalRecords, observe(`pr=97;head=${H3};draft=false;mergeable=MERGEABLE;checks=ALL_PASS`, t(5))],
    artifacts: reviewArtifacts,
  });
  const run = replay(net, adversarial.drainEvents);
  assert.equal(run.marking['pr#97/P_READY'], 0, 'readiness never fires for a head the chart never approved');
  assert.equal(run.marking['pr#97/P_RECONCILE'], 1, 'the changed head is isolated in reconciliation');
  assert.equal(run.facts['pr#97/D_NOT_DRAFT'].value, false);
  assert.equal(run.facts['pr#97/D_NOT_DRAFT'].evidence.approvedHead, H2, 'the approval stays pinned to the reviewed head');
  const waitingReconcile = run.history.at(-1).blocked.find(({ transition }) => transition === 'pr#97/T_RECONCILED');
  assert.deepEqual([waitingReconcile.reason, waitingReconcile.refusal],
    ['RECEPTIVITY_UNKNOWN', 'RECONCILIATION_UNCLASSIFIED']);

  // Mechanism-revert control: the same later observation, still at the approved head H2, does ready it.
  const legitimate = collectDrainFacts({
    records: [...upToApprovalRecords, observe(`pr=97;head=${H2};draft=false;mergeable=MERGEABLE;checks=ALL_PASS`, t(5))],
    artifacts: reviewArtifacts,
  });
  assert.equal(replay(net, legitimate.drainEvents).marking['pr#97/P_READY'], 1);
});

test('readiness and merge confirmation hold only once checks read ALL_PASS (checks evidence is never parsed and ignored)', () => {
  const reviewArtifacts = loadArtifacts().filter(({ name }) => name.startsWith('pr97-r1'));
  const parsed = reviewArtifacts.map(parseArtifact);
  const specArtifact = parsed.find(({ axis }) => axis === 'SPEC');
  const standardsArtifact = parsed.find(({ axis }) => axis === 'STANDARDS');
  const observe = (text, at) => ({ type: 'message.sent', at, message: { from: 'act-0001', kind: 'pr-observation', text } });
  const laneComplete = (from, artifact, at) => ({
    type: 'message.sent', at, message: { from, kind: 'lane-complete', text: `${artifact.name};sha256=${artifact.sha256};marker=${artifact.marker}` },
  });
  const t = (m) => `2026-09-04T06:0${m}:00.000Z`;
  const base = [
    registerCoordinator(t(0)),
    { type: 'actor.registered', at: t(0), ref: 'act-0002', kind: 'lane', isNew: true },
    { type: 'actor.registered', at: t(0), ref: 'act-0003', kind: 'lane', isNew: true },
    observe(`pr=97;head=${H1};draft=true;mergeable=MERGEABLE`, t(1)),
    observe(`pr=97;head=${H2};draft=true;mergeable=MERGEABLE`, t(2)),
    laneComplete('act-0002', specArtifact, t(3)),
    laneComplete('act-0003', standardsArtifact, t(4)),
  ];
  const net = drainFor(['97']);
  const pending = collectDrainFacts({
    records: [...base, observe(`pr=97;head=${H2};draft=false;mergeable=MERGEABLE;checks=PENDING`, t(5))],
    artifacts: reviewArtifacts,
  });
  const pendingRun = replay(net, pending.drainEvents);
  assert.equal(pendingRun.marking['pr#97/P_READY'], 0, 'checks pending never counts as ready');
  assert.equal(pendingRun.facts['pr#97/D_NOT_DRAFT'].value, false);
  assert.equal(pendingRun.facts['pr#97/D_NOT_DRAFT'].evidence.checks, 'PENDING');

  const ready = collectDrainFacts({
    records: [...base,
      observe(`pr=97;head=${H2};draft=false;mergeable=MERGEABLE;checks=ALL_PASS`, t(5)),
      observe(`pr=97;head=${H2};draft=false;state=MERGED;mergeCommit=${H3};checks=FAILING;issue=none`, t(6))],
    artifacts: reviewArtifacts,
  });
  const readyRun = replay(net, ready.drainEvents);
  assert.equal(readyRun.marking['pr#97/P_READY'], 1, 'a genuine ALL_PASS still readies it');
  assert.equal(readyRun.marking['pr#97/P_MERGED'], 0, 'a later FAILING checks value blocks the merge confirmation, never ignored');
  const waitingMerge = readyRun.history.at(-1).blocked.find(({ transition }) => transition === 'pr#97/T_MERGE');
  assert.deepEqual([waitingMerge.reason, waitingMerge.refusal], ['RECEPTIVITY_FALSE', 'MERGE_UNCONFIRMED']);
});

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

test('explicit reachability on the bounded nets finds no deadlock and no dead transition, and states its bound', () => {
  const one = checkReachability(drainFor(['97']));
  assert.deepEqual([one.states, one.deadlocks.length, one.deadTransitions, one.sound, one.bounded], [13, 0, [], true, true]);
  assert.deepEqual(one.bound, { maxStates: 20_000, placeCapacity: DEFAULT_PROVIDER_CAPACITY });
  const two = checkReachability(drainFor(['92', '97']));
  assert.deepEqual([two.states, two.deadlocks.length, two.deadTransitions], [160, 0, []]);
  const three = checkReachability(drainFor(['92', '95', '97']));
  assert.deepEqual([three.states, three.sound], [1887, true]);
  const lanes = checkReachability(instantiate(LANE_NET_TEMPLATE, ['act-0002', 'act-0003']));
  assert.deepEqual([lanes.states, lanes.sound], [64, true]);
  assert.ok(isProperCompletion(drainFor(['97']), { ...initialMarking(drainFor(['97'])), 'pr#97/P_DRAFT_HEAD': 0, 'pr#97/P_ISSUE_RECONCILED': 1 }));
  assert.ok(!isProperCompletion(drainFor(['97']), { ...initialMarking(drainFor(['97'])), 'pr#97/P_DRAFT_HEAD': 0, 'pr#97/P_ISSUE_RECONCILED': 1, MERGE_LOCK: 0 }), 'a held lock is not a completion');
  // Negative controls: a starved net and a net with a trap are reported, not smoothed over.
  const starved = checkReachability(drainFor(['97'], { capacity: 1 }));
  assert.deepEqual([starved.states, starved.deadlocks.length, starved.sound], [1, 1, false]);
  assert.equal(starved.deadTransitions.length, 20);
  const trap = buildNet({
    netId: 'trap',
    places: [{ id: 'A', initial: 1 }, { id: 'B' }, { id: 'C', terminal: true }],
    receptivities: { go: { kind: 'CONSTANT', fact: 'always', channel: 'none' } },
    transitions: [
      { id: 'ab', receptivity: 'go', refusal: 'NEVER', inputs: ['A'], outputs: ['B'] },
      { id: 'ac', receptivity: 'go', refusal: 'NEVER', inputs: ['A'], outputs: ['C'] },
      { id: 'never', receptivity: 'go', refusal: 'NEVER', inputs: ['A', 'B'], outputs: ['C'] },
    ],
  });
  const trapped = checkReachability(trap);
  assert.deepEqual(trapped.deadlocks, [{ A: 0, B: 1, C: 0 }]);
  assert.deepEqual(trapped.deadTransitions, ['never']);
  assert.equal(trapped.sound, false);
  const erasing = buildNet({
    netId: 'erasing',
    places: [{ id: 'A', initial: 1 }],
    receptivities: { go: { kind: 'CONSTANT', fact: 'always', channel: 'none' } },
    transitions: [{ id: 'erase', receptivity: 'go', refusal: 'NEVER', inputs: ['A'], outputs: [] }],
  });
  const erased = checkReachability(erasing);
  assert.deepEqual(erased.deadlocks, [{ A: 0 }]);
  assert.equal(erased.sound, false, 'A→∅ cannot erase a coordination obligation and call it completion');
  // Mechanism-revert control: moving that obligation to an explicit terminal place is sound.
  const delivered = buildNet({
    netId: 'delivered',
    places: [{ id: 'A', initial: 1 }, { id: 'DONE', terminal: true }],
    receptivities: { go: { kind: 'CONSTANT', fact: 'always', channel: 'none' } },
    transitions: [{ id: 'deliver', receptivity: 'go', refusal: 'NEVER', inputs: ['A'], outputs: ['DONE'] }],
  });
  assert.equal(checkReachability(delivered).sound, true);
  refusal('ReachabilityBoundExceeded', () => checkReachability(drainFor(['92', '95', '97']), { maxStates: 100 }));
  refusal('ReachabilityBoundInvalid', () => checkReachability(trap, { maxStates: 0 }));
});

// ---------------------------------------------------------------------------
// the read-only runner
// ---------------------------------------------------------------------------

test('the runner replays and reports the shipped fixture at default settings; a bounded reachability refusal is reported, never fatal', async () => {
  let stdout = '';
  const result = await runDrainPetriNetCli(
    fixtureCliArgs(),
    { writeStdout: (chunk) => { stdout += chunk; }, writeStderr: () => {} },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(stdout).schema, result.report.schema, 'the printed report is the returned report');
  const [drainSummary, laneSummary] = result.report.nets;
  assert.equal(drainSummary.netId, DRAIN_NET_ID);
  assert.equal(laneSummary.netId, LANE_NET_ID);
  assert.ok(drainSummary.steps > 0 && laneSummary.steps > 0, 'both nets actually replayed');
  assert.equal(drainSummary.reachability.sound, true, 'three concurrent pull requests stay within the default bound');
  assert.equal(drainSummary.reachability.refused, undefined);
  // Thirteen concurrent lane instances exceed the default 20,000-state bound; that is this net's
  // own named, bounded refusal and does not touch the drain net's replay or reachability above.
  assert.equal(laneSummary.reachability.refused, true);
  assert.equal(laneSummary.reachability.code, 'ReachabilityBoundExceeded');
  assert.equal(result.report.effect, 'NONE');
  assert.equal(result.report.authority, 'NONE');
});

test('the runner refuses unreadable input (exit 3) and bad usage (exit 2) by name, and never writes outside --database', async () => {
  const missingEvents = await runDrainPetriNetCli(
    ['--events', join(FIXTURE, 'does-not-exist.jsonl'), '--artifacts', join(FIXTURE, 'artifacts'),
      '--observation-source', 'act-0001'],
    { writeStdout: () => {}, writeStderr: () => {} },
  );
  assert.equal(missingEvents.exitCode, 3);
  const missingArtifacts = await runDrainPetriNetCli(
    ['--events', join(FIXTURE, 'events.jsonl'), '--artifacts', join(FIXTURE, 'not-a-directory'),
      '--observation-source', 'act-0001'],
    { writeStdout: () => {}, writeStderr: () => {} },
  );
  assert.equal(missingArtifacts.exitCode, 3);
  const usage = await runDrainPetriNetCli(
    ['--events', join(FIXTURE, 'events.jsonl'), '--artifacts', join(FIXTURE, 'artifacts')],
    { writeStdout: () => {}, writeStderr: () => {} },
  );
  assert.equal(usage.exitCode, 2);
  const unknownFlag = await runDrainPetriNetCli(
    [...fixtureCliArgs(), '--capacity', '2'],
    { writeStdout: () => {}, writeStderr: () => {} },
  );
  assert.equal(unknownFlag.exitCode, 2,
    'the runner exposes only --events, --artifacts, --observation-source and --database');
});

// ---------------------------------------------------------------------------
// the analytical DuckDB projection
// ---------------------------------------------------------------------------

function fakeDuckDbClient() {
  const calls = [];
  const rowsByStatement = new Map();
  return {
    calls,
    setRows(sql, rows) { rowsByStatement.set(sql, rows); },
    async run(sql, params = []) { calls.push({ sql, params }); },
    async rows(sql, params = []) { calls.push({ sql, params }); return rowsByStatement.get(sql) ?? []; },
    close() { calls.push({ sql: 'CLOSE', params: [] }); },
    clientVersion: '0.0.0-fake',
    libraryVersion: '0.0.0-fake',
  };
}

test('synchronizeDrainPetriNetDuckDb rebuilds through an injected fake seam, deterministically and equivalently', async () => {
  const drain = drainFor(['97']);
  const lane = instantiate(LANE_NET_TEMPLATE, ['act-0002']);
  const drainRun = replay(drain, [{ at: '2026-09-04T06:00:00.000Z', level: { 'pr#97/D_HEAD_PUBLISHED': true } }]);
  const laneRun = replay(lane, [{ at: '2026-09-04T06:00:00.000Z', edge: { 'lane#act-0002/L_ATTEMPT_STARTED': true } }]);
  const nets = [{ net: drain, replay: drainRun }, { net: lane, replay: laneRun }];

  const first = fakeDuckDbClient();
  const receiptOne = await synchronizeDrainPetriNetDuckDb({ nets, databasePath: 'ignored.duckdb', openClient: async () => first });
  assert.equal(receiptOne.schema, DRAIN_PETRI_DUCKDB_SCHEMA);
  assert.equal(receiptOne.effect, 'ANALYTICAL_PROJECTION_REBUILT');
  assert.equal(receiptOne.authority, 'NONE');
  assert.deepEqual(Object.keys(receiptOne.rowCounts).sort(), [...DRAIN_PETRI_DUCKDB_TABLES].sort());
  assert.equal(receiptOne.rowCounts.steps, 2, 'one step per net');
  assert.ok(receiptOne.rowCounts.places > 0 && receiptOne.rowCounts.transitions > 0 && receiptOne.rowCounts.arcs > 0);
  assert.equal(receiptOne.rowCounts.projection, 1);
  const sqls = first.calls.map(({ sql }) => sql);
  assert.ok(sqls.includes(DRAIN_PETRI_DUCKDB_STATEMENTS.begin) && sqls.includes(DRAIN_PETRI_DUCKDB_STATEMENTS.commit));
  assert.ok(sqls.indexOf(DRAIN_PETRI_DUCKDB_STATEMENTS.deletePlaces) < sqls.indexOf(DRAIN_PETRI_DUCKDB_STATEMENTS.insertPlace),
    'delete precedes insert inside the transaction');
  assert.ok(sqls.indexOf(DRAIN_PETRI_DUCKDB_STATEMENTS.begin) < sqls.indexOf(DRAIN_PETRI_DUCKDB_STATEMENTS.deletePlaces));
  assert.ok(sqls.lastIndexOf(DRAIN_PETRI_DUCKDB_STATEMENTS.insertProjection) < sqls.lastIndexOf(DRAIN_PETRI_DUCKDB_STATEMENTS.commit));

  // Rebuild equivalence: a fresh (deleted-and-rebuilt) store synchronized from the same replay
  // produces the same receipt shape, the same row counts and the same revisions.
  const second = fakeDuckDbClient();
  const receiptTwo = await synchronizeDrainPetriNetDuckDb({ nets, databasePath: 'ignored.duckdb', openClient: async () => second });
  assert.deepEqual(receiptTwo.rowCounts, receiptOne.rowCounts);
  assert.equal(receiptTwo.netRevision, receiptOne.netRevision);
  assert.equal(receiptTwo.markingRevision, receiptOne.markingRevision);

  await assert.rejects(
    synchronizeDrainPetriNetDuckDb({ nets: [], databasePath: 'ignored.duckdb', openClient: async () => fakeDuckDbClient() }),
    (error) => error instanceof DrainPetriDuckDbError && error.code === 'InvalidNet',
  );

  // The store holds no decision surface: no UPDATE/MERGE, and no authority-bound column.
  const statements = Object.values(DRAIN_PETRI_DUCKDB_STATEMENTS).join('\n');
  assert.ok(!/\bUPDATE\b|\bMERGE\b/u.test(statements));
});

test('queryDrainPetriNetDuckDb reads a named statement through the injected client and coerces bigint rows', async () => {
  const client = fakeDuckDbClient();
  client.setRows(DRAIN_PETRI_DUCKDB_QUERIES.throughput, [{ net_id: 'x', transition: 'T_MERGE', day: '2026-09-04', firings: 3n }]);
  const rows = await queryDrainPetriNetDuckDb({ databasePath: 'ignored.duckdb', query: 'throughput', openClient: async () => client });
  assert.deepEqual(rows, [{ net_id: 'x', transition: 'T_MERGE', day: '2026-09-04', firings: 3 }]);
  assert.ok(client.calls.some(({ sql }) => sql === DRAIN_PETRI_DUCKDB_QUERIES.throughput));
  await assert.rejects(
    queryDrainPetriNetDuckDb({ databasePath: 'ignored.duckdb', query: 'nope', openClient: async () => client }),
    (error) => error instanceof DrainPetriDuckDbError && error.code === 'QueryUnknown',
  );
});

test('the optional DuckDB client has a deterministic named-absence contract', async () => {
  let loadAttempts = 0;
  await assert.rejects(
    openDrainPetriNetDuckDbClient('ignored.duckdb', {
      loadApi: async () => { loadAttempts += 1; throw new Error('deterministic module absence'); },
    }),
    (error) => error instanceof DrainPetriDuckDbError && error.code === 'DuckDbClientAbsent',
  );
  assert.equal(loadAttempts, 1, 'the named refusal was exercised through the real loader seam');
});

// ---------------------------------------------------------------------------
// leak controls
// ---------------------------------------------------------------------------

test('the core and the collector import no clock, filesystem, provider, bus, or store', () => {
  assert.deepEqual([...BUS_VERBS], ['register', 'send', 'inbox', 'ack', 'heartbeat', 'handoff']);
  const core = readFileSync(join(here, '..', 'src', 'drain-petri-net.mjs'), 'utf8');
  const collector = readFileSync(join(here, '..', 'src', 'drain-petri-net-facts.mjs'), 'utf8');
  const adapter = readFileSync(join(here, '..', 'src', 'duckdb-drain-petri-net.mjs'), 'utf8');
  const runner = readFileSync(join(here, '..', 'scripts', 'drain-petri-net.mjs'), 'utf8');
  assert.deepEqual([...core.matchAll(/^import .* from '([^']+)';$/gmu)].map(([, module]) => module), ['node:crypto']);
  assert.deepEqual([...collector.matchAll(/^import .* from '([^']+)';$/gmu)].map(([, module]) => module), ['node:crypto', './drain-petri-net.mjs']);
  for (const [name, source] of [['core', core], ['collector', collector], ['adapter', adapter], ['runner', runner]]) {
    assert.ok(!/node:(?:child_process|net|http|https|dgram|tls)/u.test(source), `${name}: no transport`);
    assert.ok(!/\bfetch\s*\(/u.test(source), `${name}: no network call`);
    assert.ok(!/\bexecFileSync\b|\bspawnSync\b|\bexecSync\b|\bspawn\s*\(/u.test(source), `${name}: never spawns`);
    assert.ok(!/\bDate\.now\b|\bnew Date\s*\(\s*\)/u.test(source), `${name}: the evidence supplies every instant`);
    assert.ok(!/\bgh\s+(?:pr|api|issue)\b/u.test(source), `${name}: no provider command`);
    assert.ok(!/process\.env\b/u.test(source), `${name}: no environment read`);
    assert.ok(!/wmux/u.test(source), `${name}: no wmux path`);
  }
  assert.ok(!/duckdb/iu.test(core) && !/duckdb/iu.test(collector), 'the fold never speaks to the analytical store');
  assert.ok(!/writeFileSync|appendFileSync|mkdirSync|rmSync/u.test(runner), 'the runner writes nothing but the store');
  for (const file of [core, collector, adapter, runner]) assert.ok(!file.includes('\r'), 'zero CR bytes');
});
