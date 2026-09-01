import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

const MODULE_URL = new URL('../src/gh-git-data-adapter.mjs', import.meta.url);

function revision(body) {
  const canonical = JSON.stringify(body, Object.keys(body).sort());
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
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
    { id: 42, enforcement: 'active',
      conditions: { ref_name: { include: ['refs/heads/gaia-ledger/**'] } },
      rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }] },
    [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: rootOid } }],
    { sha: rootOid, tree: { sha: '3'.repeat(40) }, parents: [] },
    { tree: [{ path: 'receipt.json', type: 'blob', sha: '4'.repeat(40) }] },
    { encoding: 'base64', content: Buffer.from(JSON.stringify({
      body: root, committedRevision: revision(root),
    }), 'utf8').toString('base64') },
    [{ ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: rootOid } }],
    { sha: '5'.repeat(40) },
    { sha: '6'.repeat(40) },
    { sha: nextOid },
    { object: { sha: nextOid } },
  ];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
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
    [],
    { sha: '5'.repeat(40) },
    { sha: '6'.repeat(40) },
    { sha: oid },
    { object: { sha: oid } },
  ];
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
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
    run: scriptedRun([[{
      ref: 'refs/heads/gaia-ledger/registry-v0', object: { sha: current },
    }]], calls),
  });

  assert.deepEqual(await api.compareAndAppend(
    'refs/heads/gaia-ledger/registry-v0', '1'.repeat(40),
    { schema: 'Receipt', priorCommittedRevision: 'a'.repeat(64), kind: 'RESERVED' },
  ), { kind: 'STALE', currentHeadOid: current });
  assert.equal(calls.length, 1);
});

test('R2 gh Git Data adapter redacts provider diagnostics', async () => {
  const { createGhGitDataApi, GhGitDataError } = await import(MODULE_URL);
  const api = createGhGitDataApi({
    repository: { owner: 'GuitarAlchemist', name: 'gaia' },
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
    run: scriptedRun([[]], calls),
  });

  assert.deepEqual(await api.readByOperation('a'.repeat(64)), { state: 'UNSEEN' });
  assert.equal(calls.length, 1);
  assert.equal(JSON.stringify(calls[0]).includes('ledgerHeadOid'), false);
});
