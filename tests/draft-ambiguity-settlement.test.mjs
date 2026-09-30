/**
 * Lookup-only settlement decision for one EFFECT_AMBIGUOUS Draft operation (Gaia issue #176).
 *
 * The fixtures under tests/fixtures/draft-ambiguity-settlement/ are the three cases the issue
 * names: found, provably absent, ambiguous. Every other case is one field changed from them.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  AmbiguitySettlementError, SETTLEMENT_DECISIONS, decideAmbiguousSettlement,
} from '../src/draft-ambiguity-settlement.mjs';
import { createGhDraftOperationProvider } from '../src/gh-draft-operation-provider.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = join(ROOT, 'tests', 'fixtures', 'draft-ambiguity-settlement');
const CLI = join(ROOT, 'scripts', 'draft-ambiguity-settlement.mjs');
const fixture = (name) => JSON.parse(readFileSync(join(FIXTURES, name), 'utf8'));
const OPERATION = fixture('operation.json');
const FOUND = fixture('lookup-found.json');
const ABSENT = fixture('lookup-absent.json');
const AMBIGUOUS = fixture('lookup-ambiguous.json');
const [DRAFT] = FOUND.candidates;

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
const sha256 = (value) => createHash('sha256').update(canonical(value), 'utf8').digest('hex');

const decide = (lookup, operation = OPERATION) => decideAmbiguousSettlement({
  operation: structuredClone(operation), lookup: structuredClone(lookup),
});
const withCandidates = (candidates, overrides = {}) => ({ ...ABSENT, candidates, ...overrides });
const row = (overrides = {}) => ({ ...structuredClone(DRAFT), ...overrides });
const refusedAs = (code) => (error) => error instanceof AmbiguitySettlementError
  && error.code === code && error.message === code;

test('the three fixtures decide found, provably absent and ambiguous', () => {
  const found = decide(FOUND);
  assert.equal(found.decision, 'SETTLE_REUSED');
  assert.equal(found.reason, 'MarkedDraftFound');
  assert.deepEqual(found.evidence.pullRequest, {
    number: DRAFT.number, url: DRAFT.url, state: 'OPEN', isDraft: true,
    headRevision: DRAFT.headRefOid,
  });

  const absent = decide(ABSENT);
  assert.equal(absent.decision, 'SETTLE_ABANDONED');
  assert.equal(absent.reason, 'MarkerProvablyAbsent');
  assert.equal(absent.evidence.pullRequest, null);
  assert.deepEqual(absent.evidence.lookup, {
    revision: sha256(ABSENT), repository: ABSENT.repository, headRef: ABSENT.headRef,
    search: { state: 'all', limit: 100 }, observedAt: ABSENT.observedAt,
    outcome: 'COMPLETE', candidateCount: 0,
  }, 'the search bounds are recorded with the lookup it came from');

  const ambiguous = decide(AMBIGUOUS);
  assert.equal(ambiguous.decision, 'STAY_UNSETTLED');
  assert.equal(ambiguous.reason, 'SeveralPullRequestsOnHead');

  for (const result of [found, absent, ambiguous]) {
    assert.ok(SETTLEMENT_DECISIONS.includes(result.decision));
    const { revision, ...record } = result.evidence;
    assert.equal(revision, sha256(record), 'the evidence names its own content');
    assert.equal(record.schema, 'GaiaDraftAmbiguitySettlementV0');
    assert.equal(record.operationId, OPERATION.operationId);
    assert.equal(record.committedRevision, OPERATION.committedRevision,
      'bound to the ambiguous revision it was decided at');
    assert.deepEqual([record.effect, record.authority], ['NONE', 'NONE']);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.evidence.lookup.search));
  }
  assert.deepEqual(decide(ABSENT), absent, 'replayable: the same files decide the same');
  assert.notEqual(decide({ ...ABSENT, observedAt: '2026-10-01T00:00:00Z' }).evidence.revision,
    absent.evidence.revision, 'a later lookup is other evidence');
});

test('a truncated, partial or errored lookup never settles as abandoned', () => {
  const cases = [
    [withCandidates([], { outcome: 'PARTIAL' }), 'LookupPartial'],
    [withCandidates([], { outcome: 'ERRORED' }), 'LookupErrored'],
    [withCandidates([row()], { outcome: 'PARTIAL' }), 'LookupPartial'],
    // A page as long as its limit may have left the marked Draft, or a second one, behind.
    [withCandidates([row()], { search: { state: 'all', limit: 1 } }), 'LookupTruncated'],
    [withCandidates(AMBIGUOUS.candidates, { search: { state: 'all', limit: 2 } }), 'LookupTruncated'],
  ];
  for (const [lookup, reason] of cases) {
    const result = decide(lookup);
    assert.deepEqual([result.decision, result.reason], ['STAY_UNSETTLED', reason], reason);
  }
  assert.equal(decide(withCandidates([], { search: { state: 'all', limit: 1 } })).decision,
    'SETTLE_ABANDONED', 'an empty page is complete whatever its limit');
});

test('a marked pull request settles as reused only where reconcileDraft would adopt it', async () => {
  const other = 'e'.repeat(40);
  const cases = [
    ['open Draft on the request', row(), 'SETTLE_REUSED', 'MarkedDraftFound'],
    ['merged', row({ isDraft: false, state: 'MERGED' }), 'STAY_UNSETTLED', 'MarkedPullRequestNotAdoptable'],
    ['closed', row({ state: 'CLOSED' }), 'STAY_UNSETTLED', 'MarkedPullRequestNotAdoptable'],
    ['ready for review', row({ isDraft: false }), 'STAY_UNSETTLED', 'MarkedPullRequestNotAdoptable'],
    ['head moved', row({ headRefOid: other }), 'STAY_UNSETTLED', 'MarkedPullRequestNotAdoptable'],
    ['other base', row({ baseRefName: 'release' }), 'STAY_UNSETTLED', 'MarkedPullRequestNotAdoptable'],
    ['fork owner', row({ headRepositoryOwner: { id: 'U_x', login: 'someone' } }),
      'STAY_UNSETTLED', 'MarkedPullRequestNotAdoptable'],
    ['url in another repository', row({ url: `https://github.com/someone/gaia/pull/${DRAFT.number}` }),
      'STAY_UNSETTLED', 'MarkedPullRequestNotAdoptable'],
    ['marker absent', row({ body: 'A hand-made pull request.' }), 'STAY_UNSETTLED', 'UnmarkedPullRequestOnHead'],
    ['marker twice', row({ body: `${DRAFT.body}\n${DRAFT.body.split('\n')[0]}` }),
      'STAY_UNSETTLED', 'UnmarkedPullRequestOnHead'],
    ['marker inside a line', row({ body: `quoted ${DRAFT.body}` }), 'STAY_UNSETTLED', 'UnmarkedPullRequestOnHead'],
  ];
  for (const [name, candidate, decision, reason] of cases) {
    const result = decide(withCandidates([candidate]));
    assert.deepEqual([result.decision, result.reason], [decision, reason], name);
    assert.equal(result.evidence.pullRequest.number, candidate.number, `${name}: the PR is evidence`);
  }

  // Agreement with the provider reconcileDraft looks up through: it adopts exactly what we call
  // SETTLE_REUSED, and every row set we leave unsettled is one it cannot adopt either.
  const listed = [];
  const seen = { adopted: 0, absent: 0, refused: 0 };
  for (const candidates of [...cases.map(([, candidate]) => [candidate]), AMBIGUOUS.candidates, []]) {
    const provider = createGhDraftOperationProvider({
      expectedRepository: OPERATION.request.repository,
      presentation: {
        owner: 'Gaia hosted Draft pump', gate: 'DELIVERY', checklist: ['One exact Draft'],
        eta: { minimumMinutes: 60, maximumMinutes: 120 },
      },
      run: async (_command, args) => {
        if (args[0] === 'repo') {
          return { stdout: JSON.stringify({ id: OPERATION.request.repository.nodeId,
            nameWithOwner: 'GuitarAlchemist/gaia' }) };
        }
        if (args[0] === 'pr' && args[1] === 'list') {
          listed.push(args);
          return { stdout: JSON.stringify(candidates) };
        }
        throw new Error(`no merge evidence in this test: ${args.join(' ')}`);
      },
    });
    const adopted = await provider.lookupExact(OPERATION.request).then((draft) => draft, () => undefined);
    const { decision, evidence } = decide(withCandidates(candidates));
    if (adopted === undefined) {
      seen.refused += 1;
      assert.equal(decision, 'STAY_UNSETTLED', `${candidates.length} rows`);
    } else if (adopted === null) {
      seen.absent += 1;
      assert.equal(decision, 'SETTLE_ABANDONED');
    } else {
      seen.adopted += 1;
      assert.equal(decision, 'SETTLE_REUSED');
      assert.equal(adopted.number, evidence.pullRequest.number);
    }
  }
  assert.deepEqual(seen, { adopted: 1, absent: 1, refused: cases.length });
  // The saved lookup is the provider's own search: all states, this head, these fields.
  assert.deepEqual(listed[0], [
    'pr', 'list', '--repo', 'GuitarAlchemist/gaia', '--state', 'all',
    '--head', OPERATION.request.headRef, '--limit', String(ABSENT.search.limit), '--json',
    Object.keys(DRAFT).join(','),
  ]);
});

test('a non-ambiguous operation, a mismatched marker or a mismatched scope is refused by name', () => {
  for (const state of ['ENQUEUED', 'EFFECT_STARTED', 'CREATED', 'REUSED']) {
    assert.throws(() => decide(ABSENT, { ...OPERATION, state }), refusedAs('OperationNotAmbiguous'), state);
  }
  assert.throws(() => decide({ ...ABSENT, marker: 'f'.repeat(64) }), refusedAs('LookupMarkerMismatch'));
  assert.throws(() => decide({ ...ABSENT, headRef: 'gaia/issue-4242-ready-2' }),
    refusedAs('LookupScopeMismatch'));
  assert.throws(() => decide({ ...ABSENT, repository: { ...ABSENT.repository, name: 'other' } }),
    refusedAs('LookupScopeMismatch'));
  assert.throws(() => decide({ ...ABSENT, repository: { ...ABSENT.repository, nodeId: 'R_other' } }),
    refusedAs('LookupScopeMismatch'));

  const request = OPERATION.request;
  for (const [name, operation] of [
    ['marker not the operation id', { ...OPERATION, request: { ...request, operationMarker: 'f'.repeat(64) } }],
    ['short revision', { ...OPERATION, committedRevision: 'abc' }],
    ['extra key', { ...OPERATION, note: 'x' }],
    ['pull request as work item', { ...OPERATION, request: { ...request, workItem: { kind: 'PR', number: 1 } } }],
    ['head with ..', { ...OPERATION, request: { ...request, headRef: 'a..b' } }],
  ]) assert.throws(() => decide(ABSENT, operation), refusedAs('InvalidOperation'), name);

  for (const [name, lookup] of [
    ['other schema', { ...ABSENT, schema: 'GaiaDraftMarkerLookupV1' }],
    ['open-only search', { ...ABSENT, search: { state: 'open', limit: 100 } }],
    ['limit 0', { ...ABSENT, search: { state: 'all', limit: 0 } }],
    ['unknown outcome', { ...ABSENT, outcome: 'DONE' }],
    ['non-canonical instant', { ...ABSENT, observedAt: '2026-09-30T23:00:00.000Z' }],
    ['impossible instant', { ...ABSENT, observedAt: '2026-02-30T23:00:00Z' }],
    ['errored with rows', withCandidates([row()], { outcome: 'ERRORED' })],
    ['row on another head', withCandidates([row({ headRefName: 'main' })])],
    ['row missing its body', withCandidates([(({ body, ...rest }) => rest)(row())])],
    ['row with unknown state', withCandidates([row({ state: 'DRAFT' })])],
    ['extra key', { ...ABSENT, note: 'x' }],
  ]) assert.throws(() => decide(lookup), refusedAs('InvalidLookup'), name);

  assert.throws(() => decideAmbiguousSettlement({ operation: OPERATION }), refusedAs('InvalidSettlementInput'));
  assert.throws(() => decideAmbiguousSettlement({ operation: OPERATION, lookup: ABSENT, apply: true }),
    refusedAs('InvalidSettlementInput'));
});

test('the settlement module reads no network, no clock and no process', () => {
  const source = readFileSync(join(ROOT, 'src', 'draft-ambiguity-settlement.mjs'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  const specifiers = [...code.matchAll(/^import\s+(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(specifiers, ['node:crypto']);
  for (const [name, pattern] of [
    ['dynamic import', /\bimport\s*\(/u], ['Date.now', /\bDate\.now\b/u],
    ['a clock read', /new Date\(\s*\)/u], ['fetch', /\bfetch\s*\(/u], ['gh', /['"`]gh['"`]/u],
    ['child_process', /child_process/u], ['process', /\bprocess\./u], ['randomness', /\brandom/iu],
  ]) assert.doesNotMatch(code, pattern, name);

  const cli = readFileSync(CLI, 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
  const cliImports = [...cli.matchAll(/^import\s+(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(cliImports, ['node:fs', 'node:path', '../src/draft-ambiguity-settlement.mjs'],
    'the dry run reads two files and nothing else');
});

function runCli(args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { cwd: ROOT }, (error, stdout, stderr) => {
      resolve({ code: error?.code ?? 0, stdout, stderr });
    });
  });
}

test('the dry-run CLI prints the decision, and refuses --apply', async () => {
  const operation = join(FIXTURES, 'operation.json');
  const absent = await runCli(['--operation', operation, '--lookup', join(FIXTURES, 'lookup-absent.json')]);
  assert.equal(absent.code, 0);
  const expected = decide(ABSENT);
  assert.match(absent.stdout, /^decision=SETTLE_ABANDONED reason=MarkerProvablyAbsent$/mu);
  assert.match(absent.stdout, new RegExp(`^evidence=sha256:${expected.evidence.revision}$`, 'mu'));
  assert.match(absent.stdout, /^effect=NONE authority=NONE written=nothing$/mu);

  const json = await runCli(['--operation', operation, '--lookup', join(FIXTURES, 'lookup-found.json'), '--json']);
  assert.equal(json.code, 0);
  assert.deepEqual(JSON.parse(json.stdout), JSON.parse(JSON.stringify(decide(FOUND))));
  const unsettled = await runCli(['--operation', operation, '--lookup', join(FIXTURES, 'lookup-ambiguous.json')]);
  assert.equal(unsettled.code, 0, 'staying unsettled is a decision, not a failure');

  const scratch = mkdtempSync(join(tmpdir(), 'gaia-settlement-'));
  const created = join(scratch, 'created.json');
  writeFileSync(created, JSON.stringify({ ...OPERATION, state: 'CREATED' }));
  const garbled = join(scratch, 'garbled.json');
  writeFileSync(garbled, '{ not json');
  for (const [args, code, stderr] of [
    [['--operation', operation, '--lookup', join(FIXTURES, 'lookup-absent.json'), '--apply'], 2, /#161/u],
    [['--operation', operation], 2, /--lookup is required/u],
    [['--operation', operation, '--operation', operation, '--lookup', garbled], 2, /more than once/u],
    [['--operation', created, '--lookup', join(FIXTURES, 'lookup-absent.json')], 1, /REFUSED: OperationNotAmbiguous/u],
    [['--operation', operation, '--lookup', garbled], 3, /FAILED_CLOSED: lookup/u],
    [['--operation', join(scratch, 'missing.json'), '--lookup', garbled], 3, /FAILED_CLOSED: operation/u],
  ]) {
    const result = await runCli(args);
    assert.equal(result.code, code, args.join(' '));
    assert.match(result.stderr, stderr, args.join(' '));
    assert.equal(result.stdout, '', `${args.join(' ')}: no decision printed`);
  }
});
