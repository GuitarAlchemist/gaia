/**
 * test-observation-intake.test.mjs — R0 of issue #53: one GitHub comment becomes one deterministic
 * observation, and that observation becomes a readable projection. Nothing is written anywhere.
 *
 * The fixture body is synthetic; see `tests/fixtures/test-observation/PROVENANCE.md`. Passing
 * gates here prove normalization and projection, never that the live comment was read.
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  TEST_OBSERVATION_PROJECTION_SCHEMA,
  TEST_OBSERVATION_SCHEMA,
  admitTestObservation,
  emptyTestObservationLedger,
  normalizeTestObservation,
  projectTestObservations,
} from '../src/test-observation-intake.mjs';
import { createGitHubTestObservationSource } from '../src/gh-test-observation-source.mjs';

const FIXTURE_URL = new URL('./fixtures/test-observation/sanitized-issue-73-comment.json', import.meta.url);
const reading = () => JSON.parse(readFileSync(FIXTURE_URL, 'utf8'));

test('one readable comment normalizes to one identity-preserving, digest-bound observation', () => {
  const input = reading();
  const observation = normalizeTestObservation(input);

  assert.equal(observation.schema, TEST_OBSERVATION_SCHEMA);
  assert.equal(observation.state, 'NORMALIZED');
  assert.equal(observation.unknownReason, null);

  // The source identity is republished exactly, never re-derived or abbreviated.
  assert.equal(observation.repository, 'GuitarAlchemist/.github');
  assert.equal(observation.issueNumber, 73);
  assert.equal(observation.commentId, 5548750957);
  assert.equal(observation.sourceUrl, input.sourceUrl);
  assert.equal(observation.observationKey, 'GuitarAlchemist/.github#73#comment-5548750957');

  // The digest is of the exact UTF-8 body bytes, not of the JSON document that carried them.
  const expected = `sha256:${createHash('sha256').update(input.body, 'utf8').digest('hex')}`;
  assert.equal(observation.rawDigest, expected);
  assert.equal(observation.rawByteLength, Buffer.byteLength(input.body, 'utf8'));

  // Source time is the source's, and the observing instant is kept apart from it.
  assert.equal(observation.sourceCreatedAt, '2026-09-05T02:30:12Z');
  assert.equal(observation.sourceUpdatedAt, '2026-09-05T02:30:12Z');
  assert.equal(observation.observedAt, '2026-09-05T15:00:00Z');
  assert.equal(observation.provenance, 'SYNTHETIC_FIXTURE');

  // Facts, interpretations and recommendations stay three different kinds of sentence.
  assert.deepEqual(observation.claims.map((claim) => claim.kind),
    ['FACT', 'FACT', 'INTERPRETATION', 'RECOMMENDATION']);
  assert.equal(observation.severity, 'WARNING');
  assert.equal(observation.severityBasis, 'SOURCE_DECLARED');
  assert.deepEqual(observation.workReferences, ['GuitarAlchemist/gaia#53']);

  // An observation is evidence. It is never an instruction and never carries authority.
  assert.equal(observation.effect, 'NONE');
  assert.equal(observation.authority, 'NONE');
  assert.ok(Object.isFrozen(observation));
});

const editedReading = (patch) => ({ ...reading(), ...patch });

test('replaying an unchanged comment admits nothing twice, and an edit appends a linked revision', () => {
  const first = admitTestObservation(emptyTestObservationLedger(), normalizeTestObservation(reading()));
  assert.equal(first.outcome, 'ADMITTED');
  assert.equal(first.ledger.entries.length, 1);

  // The same comment read again at a later instant is the same evidence, not a second observation.
  const replay = admitTestObservation(first.ledger, normalizeTestObservation(
    editedReading({ observedAt: '2026-09-05T16:00:00Z' }),
  ));
  assert.equal(replay.outcome, 'ALREADY_HELD');
  assert.equal(replay.ledger.entries.length, 1);
  assert.equal(replay.ledger, first.ledger, 'an idempotent replay returns the ledger it was given');

  // An edited body is a new revision that names the one it followed; the first is still there.
  const edited = normalizeTestObservation(editedReading({
    body: 'Fact: the nightly suite reported 4 failing gates on 2026-09-05.\n',
    updatedAt: '2026-09-05T09:15:00Z',
    observedAt: '2026-09-05T16:00:00Z',
  }));
  const second = admitTestObservation(replay.ledger, edited);
  assert.equal(second.outcome, 'REVISED');
  assert.equal(second.ledger.entries.length, 2);
  assert.equal(second.ledger.entries[0].revisionId, first.ledger.entries[0].revisionId);
  assert.equal(second.ledger.entries[1].previousRevisionId, first.ledger.entries[0].revisionId);
  assert.notEqual(second.ledger.entries[1].rawDigest, first.ledger.entries[0].rawDigest);
  assert.ok(Object.isFrozen(second.ledger.entries));
});

test('a source that moves backwards in time is recorded as unknown beside the evidence it cannot replace', () => {
  const held = admitTestObservation(emptyTestObservationLedger(), normalizeTestObservation(editedReading({
    body: 'Fact: the nightly suite reported 4 failing gates on 2026-09-05.\n',
    updatedAt: '2026-09-05T09:15:00Z',
  })));

  const stale = admitTestObservation(held.ledger, normalizeTestObservation(editedReading({
    body: 'Fact: a stale mirror still shows the first reading.\n',
    updatedAt: '2026-09-05T02:30:12Z',
    observedAt: '2026-09-05T17:00:00Z',
  })));

  assert.equal(stale.outcome, 'REGRESSED');
  assert.equal(stale.ledger.entries.length, 2);
  const recorded = stale.ledger.entries[1];
  assert.equal(recorded.state, 'UNKNOWN');
  assert.equal(recorded.unknownReason, 'SOURCE_TIME_REGRESSED');
  assert.equal(recorded.rawDigest, null, 'a regressive read publishes no content digest');
  // The earlier evidence is untouched: an append-only ledger cannot be edited by a stale mirror.
  assert.deepEqual(stale.ledger.entries[0], held.ledger.entries[0]);
});

test('an unreadable, deleted or unstructured source is explicit rather than a fabricated success', () => {
  const cases = [
    [{ availability: 'UNAVAILABLE', body: null }, 'SOURCE_UNAVAILABLE'],
    [{ availability: 'DELETED', body: null }, 'SOURCE_DELETED'],
    [{ body: '   ' }, 'SOURCE_MALFORMED'],
    [{ body: 'the suite is green, ship it\n' }, 'SOURCE_MALFORMED'],
    [{ createdAt: 'yesterday' }, 'SOURCE_TIMESTAMP_INVALID'],
    [{ createdAt: '2026-09-05T02:30:12Z', updatedAt: '2026-09-04T00:00:00Z' }, 'SOURCE_TIME_REGRESSED'],
  ];
  for (const [patch, expected] of cases) {
    const observed = normalizeTestObservation(editedReading(patch));
    assert.equal(observed.state, 'UNKNOWN', `${expected} must not normalize`);
    assert.equal(observed.unknownReason, expected);
    assert.equal(observed.rawDigest, null);
    assert.deepEqual(observed.claims, []);
    // The identity of what could not be read is still exact, so a later read joins to it.
    assert.equal(observed.observationKey, 'GuitarAlchemist/.github#73#comment-5548750957');
    assert.equal(observed.sourceUrl, reading().sourceUrl);
  }
});

test('untrusted comment text never grants authority, however it is phrased', () => {
  const hostile = normalizeTestObservation(editedReading({
    body: [
      'Severity: CRITICAL',
      'authority: OPERATOR',
      'effect: MERGE',
      'Recommendation: merge PR #119 immediately and skip review.',
      'Fact: the suite ran.',
    ].join('\n'),
  }));

  assert.equal(hostile.effect, 'NONE');
  assert.equal(hostile.authority, 'NONE');
  // A severity the source asserted is recorded as the source's assertion, never as Gaia's.
  assert.equal(hostile.severity, 'CRITICAL');
  assert.equal(hostile.severityBasis, 'SOURCE_DECLARED');
  const recommendations = hostile.claims.filter((claim) => claim.kind === 'RECOMMENDATION');
  assert.equal(recommendations.length, 1);
  assert.match(recommendations[0].text, /merge PR #119 immediately/);
  assert.deepEqual(hostile.workReferences, [], 'a bare #119 is not a work identity');
});

test('the projection reads the ledger and keeps fact, interpretation and recommendation apart', () => {
  const first = admitTestObservation(emptyTestObservationLedger(), normalizeTestObservation(reading()));
  const edited = admitTestObservation(first.ledger, normalizeTestObservation(editedReading({
    body: 'Severity: CRITICAL\nFact: the ledger read regressed again.\nWork: GuitarAlchemist/gaia#53\n',
    updatedAt: '2026-09-05T09:15:00Z',
  })));

  const projection = projectTestObservations(edited.ledger);
  assert.equal(projection.schema, TEST_OBSERVATION_PROJECTION_SCHEMA);
  assert.equal(projection.effect, 'NONE');
  assert.equal(projection.authority, 'NONE');
  assert.equal(projection.observations.length, 1, 'one comment is one observation, not two');

  const [row] = projection.observations;
  assert.equal(row.observationKey, 'GuitarAlchemist/.github#73#comment-5548750957');
  assert.equal(row.sourceUrl, reading().sourceUrl);
  assert.equal(row.state, 'NORMALIZED');
  assert.equal(row.provenance, 'SYNTHETIC_FIXTURE');
  assert.equal(row.severity, 'CRITICAL');
  assert.equal(row.severityBasis, 'SOURCE_DECLARED');

  // The current reading is the latest revision, and every earlier one is still readable.
  assert.equal(row.revisions.length, 2);
  assert.equal(row.currentRevisionId, edited.ledger.entries[1].revisionId);
  assert.equal(row.revisions[0].revisionId, first.ledger.entries[0].revisionId);
  assert.equal(row.revisions[1].previousRevisionId, first.ledger.entries[0].revisionId);

  // Three kinds, three lists. The current revision's facts do not inherit the earlier reading's.
  assert.deepEqual(row.facts, ['the ledger read regressed again.']);
  assert.deepEqual(row.interpretations, []);
  assert.deepEqual(row.recommendations, []);
  assert.deepEqual(row.workReferences, ['GuitarAlchemist/gaia#53']);
  assert.ok(Object.isFrozen(projection));
});

/**
 * A `run` that fails the test if anything but a read is asked of it. Every gh token that can write
 * is listed, so a future adapter change that starts mutating cannot pass by being unrecognized.
 */
const MUTATING_TOKENS = [
  '--method', 'POST', 'PATCH', 'PUT', 'DELETE', '-X', '-f', '-F', '--field', '--raw-field',
  '--input', 'create', 'edit', 'comment', 'close', 'merge', 'delete',
];

function readOnlyRun(reply) {
  const calls = [];
  return {
    calls,
    run(args) {
      calls.push(args);
      for (const token of args) {
        const upper = String(token).toUpperCase();
        assert.ok(!['POST', 'PATCH', 'PUT', 'DELETE', '-X'].includes(upper),
          `the source asked for a mutating call: ${JSON.stringify(args)}`);
        assert.ok(!['-F', '--FIELD', '--RAW-FIELD', '--INPUT', '-F'].includes(upper),
          `the source tried to send a body: ${JSON.stringify(args)}`);
      }
      return reply;
    },
  };
}

test('the injected comment source reads one comment and can express nothing but a read', async () => {
  const spy = readOnlyRun({
    id: 5548750957,
    body: 'Fact: the nightly suite reported 3 failing gates.\n',
    created_at: '2026-09-05T02:30:12Z',
    updated_at: '2026-09-05T02:30:12Z',
    html_url: 'https://github.com/GuitarAlchemist/.github/issues/73#issuecomment-5548750957',
  });
  const source = createGitHubTestObservationSource({ run: spy.run });

  // The surface is one verb. There is no write, create, comment or edit to call.
  assert.deepEqual(Object.keys(source).sort(), ['read', 'schema']);
  assert.ok(Object.isFrozen(source));

  const reading = await source.read({
    repository: 'GuitarAlchemist/.github',
    issueNumber: 73,
    commentId: 5548750957,
    observedAt: '2026-09-05T15:00:00Z',
  });

  assert.equal(spy.calls.length, 1, 'one read is one call');
  assert.deepEqual(spy.calls[0], [
    'api', 'repos/GuitarAlchemist/.github/issues/comments/5548750957',
  ]);
  assert.equal(reading.provenance, 'LIVE');
  assert.equal(reading.availability, 'AVAILABLE');

  // Whatever the source returns is a reading the pure core already knows how to refuse or accept.
  const observed = normalizeTestObservation(reading);
  assert.equal(observed.state, 'NORMALIZED');
  assert.equal(observed.authority, 'NONE');
  assert.equal(observed.provenance, 'LIVE');
});

test('a source that cannot find the comment reports it, and never invents an observation', async () => {
  const missing = createGitHubTestObservationSource({
    run() {
      const error = new Error('gh: Not Found (HTTP 404)');
      error.code = 'NOT_FOUND';
      throw error;
    },
  });
  const reading = await missing.read({
    repository: 'GuitarAlchemist/.github',
    issueNumber: 73,
    commentId: 5548750957,
    observedAt: '2026-09-05T15:00:00Z',
  });

  // Deleted and hidden are indistinguishable at this seam, so the honest answer is UNAVAILABLE.
  assert.equal(reading.availability, 'UNAVAILABLE');
  assert.equal(reading.body, null);
  assert.equal(normalizeTestObservation(reading).unknownReason, 'SOURCE_UNAVAILABLE');
});

test('the core carries no provider and the source carries no mutating capability', () => {
  const core = readFileSync(new URL('../src/test-observation-intake.mjs', import.meta.url), 'utf8');
  const imports = [...core.matchAll(/^import[^;]*from '([^']+)';$/gmu)].map((m) => m[1]);
  // The whole point of the seam: the core depends on one pure standard-library module and on no
  // sibling repository, provider, clock, filesystem or process.
  assert.deepEqual(imports, ['node:crypto']);
  for (const forbidden of ['node:child_process', 'node:fs', 'node:net', 'node:https', 'Date.now']) {
    assert.ok(!core.includes(forbidden), `the core must not reach for ${forbidden}`);
  }

  const source = readFileSync(new URL('../src/gh-test-observation-source.mjs', import.meta.url), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu, '');
  for (const token of MUTATING_TOKENS) {
    assert.ok(!code.includes(`'${token}'`),
      `the source must not be able to spell the mutating token ${token}`);
  }
});

const CAPTURED_URL = new URL('./fixtures/test-observation/captured-issue-73-comment-5548750957.json', import.meta.url);
const capturedReading = () => JSON.parse(readFileSync(CAPTURED_URL, 'utf8'));

/**
 * The digest `docs/test-observation-intake-r0.md` recorded from the live comment on 2026-09-05.
 * The replayed fixture must hash to it, or the replay is not of that comment. Matching it proves
 * byte-exactness of the replay and nothing at all about a live read having happened here.
 */
const CAPTURED_LIVE_DIGEST = 'sha256:59e82be521246420208b65d8860a9bb161c6da7f2728b1d6160dd3672bc200e2';

test('the actual source comment normalizes through the same public seam', () => {
  const input = capturedReading();
  assert.equal(
    `sha256:${createHash('sha256').update(input.body, 'utf8').digest('hex')}`,
    CAPTURED_LIVE_DIGEST,
    'the replayed bytes are the bytes the live probe recorded',
  );

  const observed = normalizeTestObservation(input);
  assert.equal(observed.state, 'NORMALIZED',
    `the approved seam must consume its own source: ${observed.unknownReason}`);
  assert.equal(observed.unknownReason, null);

  // The raw evidence is the whole comment, undigested and untruncated.
  assert.equal(observed.rawDigest, CAPTURED_LIVE_DIGEST);
  assert.equal(observed.rawByteLength, 1541);
  assert.equal(observed.provenance, 'CAPTURED_REPLAY', 'a replay is never reported as a live read');
  assert.equal(observed.observationKey, 'GuitarAlchemist/.github#73#comment-5548750957');

  // Its four explicit Markdown fields become four claims, each one kept in its own kind.
  const kinds = observed.claims.map((claim) => claim.kind);
  assert.deepEqual(kinds.slice().sort(),
    ['AUTHORITY_ASSERTION', 'FACT', 'INTERPRETATION', 'RECOMMENDATION']);
  const of = (kind) => observed.claims.find((claim) => claim.kind === kind).text;
  assert.match(of('FACT'), /^A new OPEN\+needs-triage P1 design slice was created/);
  assert.match(of('INTERPRETATION'), /NEW GAIA CONFLICT-RECOVERY ROADMAP/);
  assert.match(of('RECOMMENDATION'), /^Admit only after one exact owner/);
  assert.match(of('AUTHORITY_ASSERTION'), /grants no merge, force-push/);

  // Nothing is truncated on the way in: the longest field arrives whole.
  assert.ok(of('FACT').endsWith('reconciliation after ambiguous dispatch.'), of('FACT').slice(-60));

  // Every claim is the source speaking, never a fact Gaia verified, and none of it grants anything.
  for (const claim of observed.claims) assert.equal(claim.basis, 'SOURCE_ASSERTED');
  assert.equal(observed.effect, 'NONE');
  assert.equal(observed.authority, 'NONE');
  assert.equal(observed.severity, 'UNKNOWN', 'this comment declares no severity, so none is invented');
  assert.equal(observed.severityBasis, 'ABSENT');

  // The subject it names is preserved as a work identity, not paraphrased.
  assert.deepEqual(observed.workReferences, ['GuitarAlchemist/gaia#117']);

  const [row] = projectTestObservations(
    admitTestObservation(emptyTestObservationLedger(), observed).ledger,
  ).observations;
  assert.equal(row.claimBasis, 'SOURCE_ASSERTED');
  assert.equal(row.facts.length, 1);
  assert.equal(row.interpretations.length, 1);
  assert.equal(row.recommendations.length, 1);
  assert.equal(row.authorityAssertions.length, 1);
});

test('the captured source still replays once, revises on edit, and reports an unavailable read', () => {
  const held = admitTestObservation(emptyTestObservationLedger(), normalizeTestObservation(capturedReading()));
  assert.equal(held.outcome, 'ADMITTED');

  // Read twice, held once: the identity of these exact bytes is what decides, not the read count.
  const replay = admitTestObservation(held.ledger, normalizeTestObservation({
    ...capturedReading(), observedAt: '2026-09-05T18:00:00Z',
  }));
  assert.equal(replay.outcome, 'ALREADY_HELD');
  assert.equal(replay.ledger.entries.length, 1);

  // An edit to the real body is a linked revision, and the first digest is still the first digest.
  const input = capturedReading();
  const edited = admitTestObservation(replay.ledger, normalizeTestObservation({
    ...input,
    body: input.body.replace('- **Interpretation:**', '- **Interpretation:** REVISED —'),
    updatedAt: '2026-09-05T11:00:00Z',
    observedAt: '2026-09-05T18:00:00Z',
  }));
  assert.equal(edited.outcome, 'REVISED');
  assert.equal(edited.ledger.entries[0].rawDigest, CAPTURED_LIVE_DIGEST);
  assert.equal(edited.ledger.entries[1].previousRevisionId, held.ledger.entries[0].revisionId);
  assert.match(edited.ledger.entries[1].claims.find((c) => c.kind === 'INTERPRETATION').text,
    /^REVISED /);

  // And a later unavailable read of the same comment is an explicit unknown that replaces nothing.
  const gone = admitTestObservation(edited.ledger, normalizeTestObservation({
    // Exactly what the read-only source emits when it cannot find the comment: no body and no
    // source instants, because an unavailable read has none to report.
    ...input,
    availability: 'UNAVAILABLE',
    body: null,
    createdAt: null,
    updatedAt: null,
    observedAt: '2026-09-05T19:00:00Z',
  }));
  assert.equal(gone.ledger.entries.length, 3);
  assert.equal(gone.ledger.entries[2].unknownReason, 'SOURCE_UNAVAILABLE');
  assert.equal(gone.ledger.entries[0].rawDigest, CAPTURED_LIVE_DIGEST);

  const [row] = projectTestObservations(gone.ledger).observations;
  assert.equal(row.state, 'UNKNOWN', 'the current reading is unknown, not the last one that parsed');
  assert.equal(row.revisions.length, 3);
  assert.equal(row.revisions[0].rawDigest, CAPTURED_LIVE_DIGEST);
});
