/**
 * Lookup-only settlement decision for one EFFECT_AMBIGUOUS Draft operation (Gaia issue #176).
 *
 * The fixtures under tests/fixtures/draft-ambiguity-settlement/ are the three cases the issue
 * names: found, provably absent, ambiguous. The operation fixture is the envelope module's own
 * ambiguous record, which a test below reproduces. Every other case is one field changed.
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
  validateAbandonmentEvidence,
} from '../src/draft-ambiguity-settlement.mjs';
import {
  createMemoryDraftOperationPorts, createMemoryDraftOperationStore, enqueueDraft, reconcileDraft,
} from '../src/draft-operation-envelope.mjs';
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
const { envelope: ENVELOPE } = OPERATION;

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
const page = (marked) => Array.from({ length: 100 }, (_, index) => (index === 0 && marked ? row()
  : row({ number: 5000 + index, body: 'A hand-made pull request.' })));
const withEnvelope = (change) => {
  const operation = structuredClone(OPERATION);
  change(operation.envelope);
  return operation;
};
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
    revision: sha256(ABSENT), repositoryCheck: ABSENT.repositoryCheck, headRef: ABSENT.headRef,
    search: { state: 'all', limit: 100 }, observedAt: ABSENT.observedAt,
    outcome: 'COMPLETE', candidateCount: 0,
  }, 'the search bounds are recorded with the lookup they came from');

  const ambiguous = decide(AMBIGUOUS);
  assert.equal(ambiguous.decision, 'STAY_UNSETTLED');
  assert.equal(ambiguous.reason, 'SeveralPullRequestsOnHead');

  for (const result of [found, absent, ambiguous]) {
    assert.ok(SETTLEMENT_DECISIONS.includes(result.decision));
    const { revision, ...record } = result.evidence;
    assert.equal(revision, sha256(record), 'the evidence names its own content');
    assert.equal(record.schema, 'GaiaDraftAmbiguitySettlementV0');
    assert.deepEqual([record.operationId, record.workKey, record.generationKey],
      [OPERATION.operationId, OPERATION.workKey, OPERATION.generationKey]);
    assert.equal(record.committedRevision, OPERATION.committedRevision,
      'bound to the ambiguous revision it was decided at');
    assert.deepEqual(record.generation, ENVELOPE.generation, 'rechecks need nothing but the evidence');
    assert.deepEqual([record.effect, record.authority], ['NONE', 'NONE']);
    assert.ok(Object.isFrozen(result) && Object.isFrozen(result.evidence.lookup.search));
  }
  assert.deepEqual(decide(ABSENT), absent, 'replayable: the same files decide the same');
  assert.notEqual(decide({ ...ABSENT, observedAt: '2026-10-01T00:00:00Z' }).evidence.revision,
    absent.evidence.revision, 'a later lookup is other evidence');
});

test('the operation is the envelope module\'s own record, and its identity follows its envelope', async () => {
  // Reproduce the fixture: enqueue, then a reconcile whose create response is lost.
  const store = createMemoryDraftOperationStore();
  const ports = createMemoryDraftOperationPorts({
    collector: { async collect() { return structuredClone(ENVELOPE); } },
    provider: {
      async lookupExact() { return null; },
      async createDraft() { throw new Error('response lost'); },
    },
    admission: { async reserveEffect() { return 'AVAILABLE'; } },
    executorEpoch: { runId: 176, runAttempt: 1 },
    telemetry: { async append() {} },
    store,
    async pause() {},
  });
  const selector = {
    repository: { owner: ENVELOPE.repository.owner, name: ENVELOPE.repository.name },
    workItem: ENVELOPE.workItem,
  };
  const accepted = await enqueueDraft(selector, 'NONE', ports);
  const pending = await reconcileDraft(accepted.operationId, accepted.committedRevision, ports);
  assert.deepEqual([pending.kind, pending.state], ['Pending', 'EFFECT_AMBIGUOUS']);
  const snapshot = await store.inspectByOperation(accepted.operationId);
  assert.deepEqual(JSON.parse(JSON.stringify({
    operationId: snapshot.identity.operationId, workKey: snapshot.identity.workKey,
    generationKey: snapshot.identity.generationKey, committedRevision: snapshot.committedRevision,
    state: snapshot.state, envelope: snapshot.envelope,
  })), OPERATION, 'the fixture is what the ledger holds');

  // Every field the identity is derived from is bound: an operation id cannot be paired with
  // another generation's head, and a successor's head cannot borrow a predecessor's id.
  for (const [name, change] of [
    ['head', (envelope) => { envelope.generation.headRef = 'never/used'; }],
    ['head revision', (envelope) => { envelope.generation.headRevision = 'e'.repeat(40); }],
    ['base', (envelope) => { envelope.generation.baseRef = 'release'; }],
    ['policy', (envelope) => { envelope.generation.policyRevision = 'e'.repeat(40); }],
    ['repository node', (envelope) => { envelope.repository.nodeId = 'R_other'; }],
    ['work item', (envelope) => { envelope.workItem.number = 4243; }],
    ['ready receipt', (envelope) => { envelope.readyItem.queueReceiptRevision = 'e'.repeat(64); }],
    ['occurrence', (envelope) => { envelope.readyItem.occurrence = 2; }],
    ['observed source', (envelope) => { envelope.observedSourceRevision = 'e'.repeat(64); }],
    ['ready item id', (envelope) => { envelope.readyItem.id = 'e'.repeat(64); }],
  ]) {
    const operation = withEnvelope(change);
    const lookup = { ...ABSENT, headRef: operation.envelope.generation.headRef,
      repository: operation.envelope.repository };
    assert.throws(() => decide(lookup, operation), refusedAs('OperationIdentityMismatch'), name);
  }
  for (const key of ['operationId', 'workKey', 'generationKey']) {
    assert.throws(() => decide(ABSENT, { ...OPERATION, [key]: 'e'.repeat(64) }),
      refusedAs('OperationIdentityMismatch'), key);
  }
});

test('a truncated, partial, errored or stale lookup never settles as abandoned', () => {
  const cases = [
    [withCandidates([], { outcome: 'PARTIAL' }), 'LookupPartial'],
    [withCandidates([], { outcome: 'ERRORED' }), 'LookupErrored'],
    [withCandidates([], { outcome: 'ERRORED', repositoryCheck: null }), 'LookupErrored'],
    [withCandidates([row()], { outcome: 'PARTIAL' }), 'LookupPartial'],
    // A page as long as the provider's limit may have left the marked Draft, or a second, behind.
    [withCandidates(page(true)), 'LookupTruncated'],
    [withCandidates(page(false)), 'LookupTruncated'],
  ];
  for (const [lookup, reason] of cases) {
    const result = decide(lookup);
    assert.deepEqual([result.decision, result.reason], ['STAY_UNSETTLED', reason], reason);
  }
  assert.equal(decide(withCandidates(page(false).slice(1))).reason, 'SeveralPullRequestsOnHead',
    '99 rows are a complete page');
  // A search from before the operation was read at this revision says nothing about its create.
  assert.throws(() => decide({ ...ABSENT, committedRevision: 'e'.repeat(64) }),
    refusedAs('LookupRevisionMismatch'));
});

test('a marked pull request settles as reused only where reconcileDraft would adopt it', async () => {
  const other = 'e'.repeat(40);
  const cases = [
    ['open Draft on the generation', row(), 'SETTLE_REUSED', 'MarkedDraftFound'],
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

  // Against the provider reconcileDraft looks up through, with no merge evidence available (the
  // stub fails its merge reads): it adopts exactly the SETTLE_REUSED rows and finds nothing exactly
  // where we abandon. With merge evidence it may also adopt a merged Draft, which stays unsettled
  // here: SETTLE_REUSED is a subset of its adoptions, never more.
  const { generation, repository } = ENVELOPE;
  const request = {
    repository, baseRef: generation.baseRef, headRef: generation.headRef,
    headRevision: generation.headRevision, operationMarker: OPERATION.operationId,
    workItem: ENVELOPE.workItem,
  };
  const listed = [];
  const seen = { adopted: 0, absent: 0, refused: 0 };
  for (const candidates of [...cases.map(([, candidate]) => [candidate]), AMBIGUOUS.candidates, []]) {
    const provider = createGhDraftOperationProvider({
      expectedRepository: repository,
      presentation: {
        owner: 'Gaia hosted Draft pump', gate: 'DELIVERY', checklist: ['One exact Draft'],
        eta: { minimumMinutes: 60, maximumMinutes: 120 },
      },
      run: async (_command, args) => {
        if (args[0] === 'repo') {
          return { stdout: JSON.stringify(ABSENT.repositoryCheck) };
        }
        if (args[0] === 'pr' && args[1] === 'list') {
          listed.push(args);
          return { stdout: JSON.stringify(candidates) };
        }
        throw new Error(`no merge evidence in this test: ${args.join(' ')}`);
      },
    });
    const adopted = await provider.lookupExact(request).then((draft) => draft, () => undefined);
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
  // The lookup records the provider's search: all states, this head, this limit, these fields.
  assert.deepEqual(listed[0], [
    'pr', 'list', '--repo', 'GuitarAlchemist/gaia', '--state', 'all',
    '--head', generation.headRef, '--limit', String(ABSENT.search.limit), '--json',
    Object.keys(DRAFT).join(','),
  ]);
});

test('a non-ambiguous operation, a mismatched marker, scope or revision is refused by name', () => {
  for (const state of ['ENQUEUED', 'EFFECT_STARTED', 'CREATED', 'REUSED']) {
    assert.throws(() => decide(ABSENT, { ...OPERATION, state }), refusedAs('OperationNotAmbiguous'), state);
  }
  assert.throws(() => decide({ ...ABSENT, marker: 'f'.repeat(64) }), refusedAs('LookupMarkerMismatch'));
  for (const [name, lookup] of [
    ['other head', { ...ABSENT, headRef: 'gaia/issue-4242-ready-2' }],
    ['other repository', { ...ABSENT, repository: { ...ABSENT.repository, name: 'other' } }],
    ['other node', { ...ABSENT, repository: { ...ABSENT.repository, nodeId: 'R_other' } }],
    ['identity check saw another node', { ...ABSENT, repositoryCheck: { ...ABSENT.repositoryCheck, id: 'R_other' } }],
    ['identity check saw another name', { ...ABSENT,
      repositoryCheck: { ...ABSENT.repositoryCheck, nameWithOwner: 'someone/gaia' } }],
  ]) assert.throws(() => decide(lookup), refusedAs('LookupScopeMismatch'), name);

  for (const [name, operation] of [
    ['short revision', { ...OPERATION, committedRevision: 'abc' }],
    ['extra key', { ...OPERATION, note: 'x' }],
    ['pull request as work item', withEnvelope((envelope) => { envelope.workItem.kind = 'PR'; })],
    ['head with ..', withEnvelope((envelope) => { envelope.generation.headRef = 'a..b'; })],
    ['other effect', withEnvelope((envelope) => { envelope.requestedEffect = 'MERGE'; })],
  ]) assert.throws(() => decide(ABSENT, operation), refusedAs('InvalidOperation'), name);

  for (const [name, lookup] of [
    ['other schema', { ...ABSENT, schema: 'GaiaDraftMarkerLookupV1' }],
    ['open-only search', { ...ABSENT, search: { state: 'open', limit: 100 } }],
    ['a search other than the provider\'s', { ...ABSENT, search: { state: 'all', limit: 1000 } }],
    ['more rows than the limit', withCandidates([...page(false), row({ number: 9999, body: 'x' })])],
    ['unknown outcome', { ...ABSENT, outcome: 'DONE' }],
    ['completed without the identity check', { ...ABSENT, repositoryCheck: null }],
    ['non-canonical instant', { ...ABSENT, observedAt: '2026-09-30T23:00:00.000Z' }],
    ['impossible instant', { ...ABSENT, observedAt: '2026-02-30T23:00:00Z' }],
    ['errored with rows', withCandidates([row()], { outcome: 'ERRORED' })],
    ['row on another head', withCandidates([row({ headRefName: 'main' })])],
    ['row missing its body', withCandidates([(({ body, ...rest }) => rest)(row())])],
    ['row with unknown state', withCandidates([row({ state: 'DRAFT' })])],
    ['no revision', (({ committedRevision, ...rest }) => rest)(ABSENT)],
    ['extra key', { ...ABSENT, note: 'x' }],
  ]) assert.throws(() => decide(lookup), refusedAs('InvalidLookup'), name);

  assert.throws(() => decideAmbiguousSettlement({ operation: OPERATION }), refusedAs('InvalidSettlementInput'));
  assert.throws(() => decideAmbiguousSettlement({ operation: OPERATION, lookup: ABSENT, apply: true }),
    refusedAs('InvalidSettlementInput'));
});

test('hand-built inputs cannot hide rows or change what is hashed', () => {
  // No structuredClone here: these reach the module exactly as an in-process caller builds them.
  const direct = (lookup, operation = structuredClone(OPERATION)) => decideAmbiguousSettlement({ operation, lookup });
  const found = () => structuredClone(FOUND);

  const ownMap = found();
  ownMap.candidates.map = () => [];
  const foreignPrototype = found();
  Object.setPrototypeOf(foreignPrototype.candidates, { map: () => [] });
  const sparse = found();
  sparse.candidates.length = 2;
  const indexGetter = found();
  Object.defineProperty(indexGetter.candidates, '0', { get: () => row(), enumerable: true });
  const fieldGetter = found();
  Object.defineProperty(fieldGetter, 'outcome', { get: () => 'COMPLETE', enumerable: true });
  const rowGetter = found();
  Object.defineProperty(rowGetter.candidates[0], 'body', { get: () => DRAFT.body, enumerable: true });
  for (const [name, lookup] of [
    ['own map', ownMap], ['foreign prototype', foreignPrototype], ['hole', sparse],
    ['index getter', indexGetter], ['field getter', fieldGetter], ['row getter', rowGetter],
  ]) assert.throws(() => direct(lookup), refusedAs('InvalidLookup'), name);

  class Record {}
  const instance = Object.assign(new Record(), structuredClone(OPERATION));
  assert.throws(() => direct(found(), instance), refusedAs('InvalidOperation'));

  // Null-prototype records, as the ledger's closed objects are, decide like their JSON.
  const bare = (value) => (value === null || typeof value !== 'object' || Array.isArray(value)
    ? (Array.isArray(value) ? value.map(bare) : value)
    : Object.assign(Object.create(null), Object.fromEntries(Object.entries(value).map(([k, v]) => [k, bare(v)]))));
  assert.deepEqual(direct(bare(found()), bare(structuredClone(OPERATION))), decide(FOUND));
});

test('an abandonment is read back only as the evidence its operation fixes', () => {
  const read = (evidence, operation = OPERATION) => validateAbandonmentEvidence({
    operation: structuredClone(operation), evidence,
  });
  const { evidence } = decide(ABSENT);
  assert.deepEqual(read(structuredClone(evidence)), evidence);
  assert.ok(Object.isFrozen(read(structuredClone(evidence)).lookup.repositoryCheck));
  const bare = (value) => (value === null || typeof value !== 'object' ? value
    : Object.assign(Object.create(null), Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, bare(child)]))));
  assert.deepEqual(read(bare(structuredClone(evidence))), evidence, 'as the ledger stores it');

  // Each change is re-hashed, so what refuses it is the rule and not the digest.
  const changed = (change) => {
    const copy = structuredClone(evidence);
    change(copy);
    const { revision, ...record } = copy;
    return { ...copy, revision: revision === evidence.revision ? sha256(record) : revision };
  };
  const refusals = {
    'the found decision': structuredClone(decide(FOUND).evidence),
    'an ambiguous decision': structuredClone(decide(AMBIGUOUS).evidence),
    'a pull request': changed((copy) => { copy.pullRequest = { number: 1 }; }),
    'a row counted': changed((copy) => { copy.lookup.candidateCount = 1; }),
    'an incomplete search': changed((copy) => { copy.lookup.outcome = 'PARTIAL'; }),
    'no identity check': changed((copy) => { copy.lookup.repositoryCheck = null; }),
    'a wider search': changed((copy) => { copy.lookup.search.limit = 1000; }),
    'another head': changed((copy) => { copy.lookup.headRef = 'elsewhere'; }),
    'another revision': changed((copy) => { copy.committedRevision = 'f'.repeat(64); }),
    'another generation': changed((copy) => { copy.generation.headRevision = '9'.repeat(40); }),
    'another repository': changed((copy) => { copy.repository.nodeId = 'R_elsewhere'; }),
    'an effect': changed((copy) => { copy.effect = 'CREATE_DRAFT'; }),
    'authority': changed((copy) => { copy.authority = 'MERGE'; }),
    'an extra field': changed((copy) => { copy.note = 'trust me'; }),
    'a malformed instant': changed((copy) => { copy.lookup.observedAt = '2026-09-30'; }),
    'a stale digest': { ...structuredClone(evidence), reason: 'MarkerProvablyAbsent ' },
    'a wrong digest': { ...structuredClone(evidence), revision: 'f'.repeat(64) },
    'an accessor': Object.defineProperty(structuredClone(evidence), 'effect', {
      enumerable: true, get: () => 'NONE',
    }),
    'an array': [structuredClone(evidence)],
    'nothing': null,
  };
  for (const [name, stored] of Object.entries(refusals)) {
    assert.throws(() => read(stored), refusedAs('InvalidSettlementEvidence'), name);
  }
  // Written for this operation at another revision, it is not this operation's abandonment.
  assert.throws(() => read(structuredClone(evidence),
    { ...OPERATION, committedRevision: 'f'.repeat(64) }), refusedAs('InvalidSettlementEvidence'));
  assert.throws(() => read(structuredClone(evidence), { ...OPERATION, state: 'EFFECT_STARTED' }),
    refusedAs('OperationNotAmbiguous'));
  assert.throws(() => validateAbandonmentEvidence({ evidence }), refusedAs('InvalidSettlementInput'));
});

test('the settlement module reads no network, no clock and no process', () => {
  const source = readFileSync(join(ROOT, 'src', 'draft-ambiguity-settlement.mjs'), 'utf8');
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\/\/.*$/gmu, '');
  const specifiers = [...code.matchAll(/^import\s+(?:[^;'"]*?\s+from\s+)?['"]([^'"]+)['"]/gmu)]
    .map((match) => match[1]);
  assert.deepEqual(specifiers, ['node:crypto']);
  for (const [name, pattern] of [
    ['dynamic import', /\bimport\s*\(/u], ['re-export', /^export\s[^\n]*\bfrom\b/mu],
    ['require', /\brequire\s*\(|createRequire/u], ['Date.now', /\bDate\.now\b/u],
    ['a clock read', /\bDate\s*\(\s*\)/u], ['fetch', /\bfetch\s*\(/u], ['gh', /['"`]gh['"`]/u],
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
