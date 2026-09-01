import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const MODULE_URL = new URL('../src/gh-git-data-adapter.mjs', import.meta.url);
const PUMP_ACTOR = Object.freeze({ actorId: 9173, actorType: 'Integration' });

function ledgerRuleset(overrides = {}) {
  return {
    id: 42,
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: {
      include: ['refs/heads/gaia-ledger/**'], exclude: [],
    } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }, { type: 'update' }],
    bypass_actors: [{ actor_id: PUMP_ACTOR.actorId, actor_type: PUMP_ACTOR.actorType,
      bypass_mode: 'always' }],
    ...overrides,
  };
}

const protectionResponses = (ruleset = ledgerRuleset()) => [[{ id: 42 }], ruleset];

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

function revision(body) {
  return createHash('sha256').update(canonical(body), 'utf8').digest('hex');
}

function scriptedRun(responses, calls) {
  return async (args, input) => {
    calls.push({ args: structuredClone(args), input: structuredClone(input) });
    assert.ok(responses.length > 0, 'adapter made only the expected GitHub calls');
    return structuredClone(responses.shift());
  };
}

test('R2 gh Git Data adapter verifies protection, reads receipts, and appends by CAS', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  assert.equal(typeof createGhGitDataApi, 'function');
  const root = {
    schema: 'GaiaDraftRegistryRootV0', priorCommittedRevision: 'NONE', kind: 'REGISTRY_ROOT',
  };
  const next = {
    schema: 'GaiaDraftRegistryReceiptV0', priorCommittedRevision: revision(root),
    kind: 'RESERVED', workKey: 'a'.repeat(64),
  };
  const rootOid = '1'.repeat(40);
  const nextOid = '2'.repeat(40);
  const calls = [];
  const responses = [
    [{ id: 42 }],
    ledgerRuleset(),
    [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: rootOid } }],
    { sha: rootOid, tree: { sha: '3'.repeat(40) }, parents: [] },
    { truncated: false,
      tree: [{ path: 'receipt.json', mode: '100644', type: 'blob', sha: '4'.repeat(40) }] },
    { encoding: 'base64', content: Buffer.from(canonical({
      body: root, committedRevision: revision(root),
    }), 'utf8').toString('base64') },
    ...protectionResponses(),
    [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: rootOid } }],
    ...protectionResponses(),
    { sha: '5'.repeat(40) },
    ...protectionResponses(),
    { sha: '6'.repeat(40) },
    ...protectionResponses(),
    { sha: nextOid },
    ...protectionResponses(),
    { object: { sha: nextOid } },
  ];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun(responses, calls),
  });

  assert.equal(await api.verifyProtection({
    prefix: 'refs/heads/gaia-ledger/', registryRootOid: rootOid,
  }), true);
  assert.deepEqual(await api.read('refs/heads/gaia-ledger/registry-v0'), {
    state: 'PRESENT',
    records: [{ oid: rootOid, body: root, committedRevision: revision(root) }],
  });
  assert.deepEqual(
    await api.compareAndAppend('refs/heads/gaia-ledger/registry-v0', rootOid, next),
    { kind: 'APPENDED', oid: nextOid, body: next, committedRevision: revision(next) },
  );
  assert.equal(responses.length, 0);
  assert.deepEqual(calls.at(-1).input, { sha: nextOid, force: false });
  const blobWrite = calls.find((call) => call.input?.encoding === 'base64');
  assert.deepEqual(
    JSON.parse(Buffer.from(blobWrite.input.content, 'base64').toString('utf8')),
    { body: next, committedRevision: revision(next) },
  );
});

test('R2 gh Git Data adapter creates an absent work ref without force', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const body = {
    schema: 'GaiaDraftWorkRootV0', priorCommittedRevision: 'NONE',
    kind: 'WORK_ROOT', workKey: 'b'.repeat(64),
  };
  const oid = '7'.repeat(40);
  const calls = [];
  const responses = [
    ...protectionResponses(),
    [],
    ...protectionResponses(),
    { sha: '5'.repeat(40) },
    ...protectionResponses(),
    { sha: '6'.repeat(40) },
    ...protectionResponses(),
    { sha: oid },
    ...protectionResponses(),
    { object: { sha: oid } },
  ];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun(responses, calls),
  });

  assert.deepEqual(
    await api.compareAndAppend(
      `refs/heads/gaia-ledger/draft-operations-v0/${body.workKey}`, 'NONE', body,
    ),
    { kind: 'APPENDED', oid, body, committedRevision: revision(body) },
  );
  assert.deepEqual(calls.at(-1).input, {
    ref: `refs/heads/gaia-ledger/draft-operations-v0/${body.workKey}`, sha: oid,
  });
});

test('R2 gh Git Data adapter refuses a stale head before creating objects', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const current = '8'.repeat(40);
  const calls = [];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun([...protectionResponses(), [{
      ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: current },
    }]], calls),
  });

  assert.deepEqual(await api.compareAndAppend(
    'refs/heads/gaia-ledger/registry-v0', '1'.repeat(40),
    { schema: 'Receipt', priorCommittedRevision: 'a'.repeat(64), kind: 'RESERVED' },
  ), { kind: 'STALE', currentHeadOid: current });
  assert.equal(calls.length, 3, 'protection is read before the authoritative head');
  assert.equal(calls.some((call) => ['POST', 'PATCH'].includes(call.args[3])), false,
    'the stale loser creates no Git object and moves no ref');
});

test('R2 gh Git Data adapter redacts provider diagnostics', async () => {
  const { createGhGitDataApi, GhGitDataError } = await import(MODULE_URL);
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    async run() { throw new Error('token, path, and provider response'); },
  });

  await assert.rejects(
    api.read('refs/heads/gaia-ledger/registry-v0'),
    (error) => error instanceof GhGitDataError
      && error.code === 'GitHubGitDataUnavailable'
      && !error.message.includes('token'),
  );
});

test('R3 gh Git Data adapter reports an absent operation without leaking refs', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const calls = [];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun([[]], calls),
  });

  assert.deepEqual(await api.readByOperation('a'.repeat(64)), { state: 'UNSEEN' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0]).includes('ledgerHeadOid'), false);
});

test('R3 protection is restricted to exactly the configured Gaia pump App actor', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const cases = {
    'a tag-targeting ruleset': ledgerRuleset({ target: 'tag' }),
    'the ledger family is excluded directly': ledgerRuleset({
      conditions: { ref_name: {
        include: ['refs/heads/gaia-ledger/**'], exclude: ['refs/heads/gaia-ledger/**'],
      } },
    }),
    'a broad exclusion can hide ledger refs': ledgerRuleset({
      conditions: { ref_name: {
        include: ['refs/heads/gaia-ledger/**'], exclude: ['refs/heads/**'],
      } },
    }),
    'missing update restriction': ledgerRuleset({
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
    }),
    'missing pump actor': ledgerRuleset({ bypass_actors: [] }),
    'wrong App actor': ledgerRuleset({
      bypass_actors: [{ actor_id: 9999, actor_type: 'Integration', bypass_mode: 'always' }],
    }),
    'broad repository role': ledgerRuleset({
      bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    }),
    'extra broad bypass': ledgerRuleset({
      bypass_actors: [
        { actor_id: PUMP_ACTOR.actorId, actor_type: PUMP_ACTOR.actorType,
          bypass_mode: 'always' },
        { actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' },
      ],
    }),
  };

  for (const [why, ruleset] of Object.entries(cases)) {
    const api = createGhGitDataApi({
      repository: { owner: 'GuitarAlchemist', name: 'gaia' },
      pumpActor: PUMP_ACTOR,
      run: scriptedRun(protectionResponses(ruleset), []),
    });
    assert.equal(await api.verifyProtection({
      prefix: 'refs/heads/gaia-ledger/', registryRootOid: '1'.repeat(40),
    }), false, why);
  }

  const safeExclusion = ledgerRuleset({
    conditions: { ref_name: {
      include: ['refs/heads/gaia-ledger/**'], exclude: ['refs/heads/release/**'],
    } },
  });
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun(protectionResponses(safeExclusion), []),
  });
  assert.equal(await api.verifyProtection({
    prefix: 'refs/heads/gaia-ledger/', registryRootOid: '1'.repeat(40),
  }), true, 'an unrelated branch exclusion does not invalidate ledger protection');
});

test('R5 installation-token ruleset redaction verifies only the current App bypass', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const installationView = ledgerRuleset({ current_user_can_bypass: 'always' });
  delete installationView.bypass_actors;
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun(protectionResponses(installationView), []),
  });

  assert.equal(await api.verifyProtection({
    prefix: 'refs/heads/gaia-ledger/', registryRootOid: '1'.repeat(40),
  }), true, 'GitHub hides bypass_actors from a least-privilege installation token');

  for (const currentUserCanBypass of [undefined, 'never', 'pull_request']) {
    const refusedView = { ...installationView, current_user_can_bypass: currentUserCanBypass };
    const refused = createGhGitDataApi({
      repository: { owner: 'GuitarAlchemist', name: 'gaia' },
      pumpActor: PUMP_ACTOR,
      run: scriptedRun(protectionResponses(refusedView), []),
    });
    assert.equal(await refused.verifyProtection({
      prefix: 'refs/heads/gaia-ledger/', registryRootOid: '1'.repeat(40),
    }), false, `redacted bypass actors require current_user_can_bypass=always, not ${currentUserCanBypass}`);
  }
});

test('R3 compareAndAppend fails closed before any Git write when protection changes', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const calls = [];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun(protectionResponses(ledgerRuleset({ bypass_actors: [] })), calls),
  });

  await assert.rejects(
    api.compareAndAppend('refs/heads/gaia-ledger/registry-v0', '1'.repeat(40), {
      schema: 'Receipt', priorCommittedRevision: 'a'.repeat(64), kind: 'RESERVED',
    }),
    (error) => error?.code === 'LedgerProtectionUnavailable',
  );
  assert.equal(calls.length, 2, 'only the ruleset listing and detail are read');
  assert.equal(calls.some((call) => ['POST', 'PATCH'].includes(call.args[3])), false,
    'no blob, tree, commit, or ref write is attempted');
});

test('R3 protection is re-read before each Git write and stops a partial append', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const head = '1'.repeat(40);
  const calls = [];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun([
      ...protectionResponses(),
      [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: head } }],
      ...protectionResponses(),
      { sha: '2'.repeat(40) },
      ...protectionResponses(ledgerRuleset({ bypass_actors: [] })),
    ], calls),
  });

  await assert.rejects(
    api.compareAndAppend('refs/heads/gaia-ledger/registry-v0', head, {
      schema: 'Receipt', priorCommittedRevision: 'a'.repeat(64), kind: 'RESERVED',
    }),
    (error) => error?.code === 'LedgerProtectionUnavailable',
  );
  assert.deepEqual(calls.filter((call) => call.args[3] === 'POST').map(
    (call) => call.args[1],
  ), ['repos/GuitarAlchemist/gaia/git/blobs'],
  'the already-created blob is inert; no tree, commit, or ref write follows protection loss');
});

test('R3 reads only a one-entry tree whose blob is byte-canonical', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const body = { schema: 'GaiaDraftRegistryRootV0', kind: 'REGISTRY_ROOT',
    priorCommittedRevision: 'NONE' };
  const commitOid = '1'.repeat(40);
  const treeOid = '2'.repeat(40);
  const blobOid = '3'.repeat(40);
  const wrapper = { body, committedRevision: revision(body) };
  const cases = {
    'an extra tree entry': {
      tree: [
        { path: 'receipt.json', mode: '100644', type: 'blob', sha: blobOid },
        { path: 'hidden.txt', mode: '100644', type: 'blob', sha: '4'.repeat(40) },
      ],
      truncated: false,
      bytes: JSON.stringify(wrapper),
    },
    'noncanonical receipt bytes': {
      tree: [{ path: 'receipt.json', mode: '100644', type: 'blob', sha: blobOid }],
      truncated: false,
      bytes: JSON.stringify(wrapper, null, 2),
    },
    'a truncated tree that can hide entries': {
      tree: [{ path: 'receipt.json', mode: '100644', type: 'blob', sha: blobOid }],
      truncated: true,
      bytes: canonical(wrapper),
    },
    'a symlink receipt mode': {
      tree: [{ path: 'receipt.json', mode: '120000', type: 'blob', sha: blobOid }],
      truncated: false,
      bytes: canonical(wrapper),
    },
    'an executable receipt mode': {
      tree: [{ path: 'receipt.json', mode: '100755', type: 'blob', sha: blobOid }],
      truncated: false,
      bytes: canonical(wrapper),
    },
  };

  for (const [why, fixture] of Object.entries(cases)) {
    const api = createGhGitDataApi({
      repository: { owner: 'GuitarAlchemist', name: 'gaia' },
      pumpActor: PUMP_ACTOR,
      run: scriptedRun([
        [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: commitOid } }],
        { sha: commitOid, tree: { sha: treeOid }, parents: [] },
        { truncated: fixture.truncated, tree: fixture.tree },
        { encoding: 'base64', content: Buffer.from(fixture.bytes, 'utf8').toString('base64') },
      ], []),
    });
    await assert.rejects(api.read('refs/heads/gaia-ledger/registry-v0'),
      (error) => error?.code === 'GitDataProtocolViolation', why);
  }
});

test('R3 CONFIRMED carries its work-root OID only as private transport metadata', async () => {
  const { createGhGitDataApi } = await import(MODULE_URL);
  const body = {
    schema: 'GaiaDraftRegistryReceiptV0', priorCommittedRevision: 'a'.repeat(64),
    kind: 'CONFIRMED', workKey: 'b'.repeat(64), generationKey: 'c'.repeat(64),
  };
  const transportMetadata = { workRootOid: '9'.repeat(40) };
  const priorOid = '1'.repeat(40);
  const commitOid = '2'.repeat(40);
  const calls = [];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun([
      ...protectionResponses(),
      [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: priorOid } }],
      ...protectionResponses(),
      { sha: '3'.repeat(40) },
      ...protectionResponses(),
      { sha: '4'.repeat(40) },
      ...protectionResponses(),
      { sha: commitOid },
      ...protectionResponses(),
      { object: { sha: commitOid } },
    ], calls),
  });

  assert.deepEqual(await api.compareAndAppend(
    'refs/heads/gaia-ledger/registry-v0', priorOid, body, transportMetadata,
  ), {
    kind: 'APPENDED', oid: commitOid, body,
    committedRevision: revision(body), transportMetadata,
  });
  const writtenWrapper = JSON.parse(Buffer.from(
    calls.find((call) => call.input?.encoding === 'base64').input.content, 'base64',
  ).toString('utf8'));
  assert.deepEqual(writtenWrapper, {
    body, committedRevision: revision(body), transportMetadata,
  });
  assert.equal(revision(body), createHash('sha256').update(canonical(body), 'utf8').digest('hex'),
    'the private OID never enters the body content revision');

  const reader = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
    pumpActor: PUMP_ACTOR,
    run: scriptedRun([
      [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: commitOid } }],
      { sha: commitOid, tree: { sha: '4'.repeat(40) }, parents: [] },
      { truncated: false, tree: [{
        path: 'receipt.json', mode: '100644', type: 'blob', sha: '3'.repeat(40),
      }] },
      { encoding: 'base64', content: Buffer.from(canonical(writtenWrapper), 'utf8')
        .toString('base64') },
    ], []),
  });
  assert.deepEqual(await reader.read('refs/heads/gaia-ledger/registry-v0'), {
    state: 'PRESENT', records: [{
      oid: commitOid, body, committedRevision: revision(body), transportMetadata,
    }],
  });
});
