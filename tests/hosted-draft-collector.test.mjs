import assert from 'node:assert/strict';
import test from 'node:test';

const MODULE_URL = new URL('../src/hosted-draft-collector.mjs', import.meta.url);

const moduleResult = import(MODULE_URL).catch((loadError) => ({ loadError }));

async function api() {
  const loaded = await moduleResult;
  if (loaded.loadError) {
    assert.fail(`hosted collector module is absent (${loaded.loadError.code})`);
  }
  assert.equal(typeof loaded.createHostedDraftCollector, 'function');
  return loaded;
}

function githubBoundary() {
  return Object.freeze({
    async resolveRepository() {
      return {
        nodeId: 'R_kgDTest', owner: 'GuitarAlchemist', name: 'gaia',
        defaultBranch: 'main', defaultBranchRevision: 'a'.repeat(40),
      };
    },
    async readIssue() {
      return {
        nodeId: 'I_test60', number: 60, state: 'OPEN',
        updatedAt: '2026-08-31T19:05:00.000Z', labels: ['ready-for-agent'],
        labelEvents: [
          {
            nodeId: 'LE_old', label: 'ready-for-agent',
            createdAt: '2026-08-31T18:00:00.000Z',
            actor: { nodeId: 'U_old', login: 'older-actor' },
          },
          {
            nodeId: 'LE_latest', label: 'ready-for-agent',
            createdAt: '2026-08-31T19:00:00.000Z',
            actor: { nodeId: 'U_actor', login: 'trusted-actor' },
          },
        ],
      };
    },
    async readPermission() { return 'TRIAGE'; },
    async listHeadRefs() {
      return [
        {
          name: 'codex/hosted-draft-pump-r0',
          revision: 'b'.repeat(40),
        },
      ];
    },
    async readCommit() {
      return {
        message: [
          'feat: begin hosted pump', '',
          'Gaia-Issue: 60',
          'Gaia-Ready-Receipt: 797eabd4b579944ec4634babd5c018815481b0c8bf0170d90cdaf90353f8e494',
        ].join('\n'),
      };
    },
    async readPolicy() { return { revision: 'c'.repeat(40) }; },
  });
}

function assertDeepFrozen(value) {
  if (value === null || typeof value !== 'object') return;
  assert.ok(Object.isFrozen(value));
  for (const child of Object.values(value)) assertDeepFrozen(child);
}

const SELECTOR = Object.freeze({
  repository: Object.freeze({ owner: 'old-owner', name: 'old-name' }),
  workItem: Object.freeze({ kind: 'ISSUE', number: 60 }),
});

test('R1 real enqueue seam accepts the sealed selector and reaches hosted observations', async () => {
  const { createHostedDraftCollector } = await api();
  const stable = githubBoundary();
  let repositoryReads = 0;
  let headReads = 0;
  const collector = createHostedDraftCollector({
    github: {
      ...stable,
      async resolveRepository() {
        repositoryReads += 1;
        return stable.resolveRepository();
      },
      async listHeadRefs() {
        headReads += 1;
        return stable.listHeadRefs();
      },
    },
  });
  const { createMemoryDraftOperationStore, enqueueDraft } = await import(
    '../src/draft-operation-envelope.mjs'
  );
  const ports = {
    collector,
    store: createMemoryDraftOperationStore(),
    telemetry: { async append() {} },
  };

  const result = await enqueueDraft(SELECTOR, 'NONE', ports);

  assert.equal(result.kind, 'Enqueued');
  assert.match(result.committedRevision, /^[a-f0-9]{64}$/u);
  assert.equal(repositoryReads, 2, 'the real collector observed and bounded the sealed selector');
  assert.equal(headReads, 2, 'stable initial and read-back head revisions permit ENQUEUED');
});

test('R1 moved base read-back is a typed refusal before ENQUEUED', async () => {
  const { createHostedDraftCollector, HostedDraftCollectorError } = await api();
  const stable = githubBoundary();
  let repositoryReads = 0;
  const collector = createHostedDraftCollector({
    github: {
      ...stable,
      async resolveRepository() {
        repositoryReads += 1;
        const observed = await stable.resolveRepository();
        return repositoryReads === 1
          ? observed
          : { ...observed, defaultBranchRevision: 'd'.repeat(40) };
      },
    },
  });
  const { createMemoryDraftOperationStore, enqueueDraft } = await import(
    '../src/draft-operation-envelope.mjs'
  );
  const store = createMemoryDraftOperationStore();

  await assert.rejects(
    enqueueDraft(SELECTOR, 'NONE', {
      collector, store, telemetry: { async append() {} },
    }),
    (error) => error instanceof HostedDraftCollectorError
      && error.code === 'SourceRevisionMoved'
      && error.message === 'source revisions moved during collection',
  );
  assert.equal(repositoryReads, 2, 'base is read once for observation and once as a bound');
  assert.deepEqual(
    await store.readHead('422cc18399e518789008735065aab635516df14956ba0e53e45697de56760ccc'),
    { state: 'UNSEEN' },
    'moved evidence cannot create WORK_ROOT or ENQUEUED',
  );
});

test('R1 moved head read-back is a typed refusal before ENQUEUED', async () => {
  const { createHostedDraftCollector, HostedDraftCollectorError } = await api();
  const stable = githubBoundary();
  let headReads = 0;
  const collector = createHostedDraftCollector({
    github: {
      ...stable,
      async listHeadRefs() {
        headReads += 1;
        const observed = await stable.listHeadRefs();
        return headReads === 1
          ? observed
          : observed.map((head) => ({ ...head, revision: 'd'.repeat(40) }));
      },
    },
  });
  const { createMemoryDraftOperationStore, enqueueDraft } = await import(
    '../src/draft-operation-envelope.mjs'
  );
  const store = createMemoryDraftOperationStore();

  await assert.rejects(
    enqueueDraft(SELECTOR, 'NONE', {
      collector, store, telemetry: { async append() {} },
    }),
    (error) => error instanceof HostedDraftCollectorError
      && error.code === 'SourceRevisionMoved'
      && error.message === 'source revisions moved during collection',
  );
  assert.equal(headReads, 2, 'head is read once for observation and once as a bound');
  assert.deepEqual(
    await store.readHead('422cc18399e518789008735065aab635516df14956ba0e53e45697de56760ccc'),
    { state: 'UNSEEN' },
    'moved evidence cannot create WORK_ROOT or ENQUEUED',
  );
});

test('R1 hosted GitHub facts become one canonical Operation Envelope', async () => {
  const { createHostedDraftCollector } = await api();
  const collector = createHostedDraftCollector({ github: githubBoundary() });

  const envelope = await collector.collect({
    repository: { owner: 'old-owner', name: 'old-name' },
    workItem: { kind: 'ISSUE', number: 60 },
  });

  assert.deepEqual(envelope, {
    schema: 'GaiaDraftOperationEnvelopeV0',
    repository: { nodeId: 'R_kgDTest', owner: 'GuitarAlchemist', name: 'gaia' },
    workItem: { kind: 'ISSUE', number: 60 },
    readyItem: {
      schema: 'GaiaReadyItemIdentityV0',
      queueReceiptRevision: '797eabd4b579944ec4634babd5c018815481b0c8bf0170d90cdaf90353f8e494',
      occurrence: 2,
      id: '1f9efd37f156b4ab51a50f885414f851095aafab1ac3c2a2b8b8ffc271efd69e',
    },
    observedSourceRevision: '6f96d47cb094c4348e273301b5981ee6f1b27eaa232d60f4953b0b75f06dc5eb',
    generation: {
      baseRef: 'main',
      headRef: 'codex/hosted-draft-pump-r0',
      headRevision: 'b'.repeat(40),
      policyRevision: 'c'.repeat(40),
    },
    requestedEffect: 'CREATE_DRAFT',
  });
  assertDeepFrozen(envelope);
});

test('R1 concrete gh observations feed the same collector seam', async () => {
  const { createGhDraftCollectorApi, createHostedDraftCollector } = await api();
  assert.equal(typeof createGhDraftCollectorApi, 'function');
  const responses = [
    {
      node_id: 'R_kgDTest', name: 'gaia', owner: { login: 'GuitarAlchemist' },
      default_branch: 'main',
    },
    { sha: 'a'.repeat(40) },
    {
      node_id: 'I_test60', number: 60, state: 'open',
      updated_at: '2026-08-31T19:05:00Z', labels: [{ name: 'ready-for-agent' }],
    },
    [[
      {
        node_id: 'LE_old', event: 'labeled', created_at: '2026-08-31T18:00:00Z',
        actor: { node_id: 'U_old', login: 'older-actor' }, label: { name: 'ready-for-agent' },
      },
      {
        node_id: 'LE_latest', event: 'labeled', created_at: '2026-08-31T19:00:00Z',
        actor: { node_id: 'U_actor', login: 'trusted-actor' }, label: { name: 'ready-for-agent' },
      },
    ]],
    { permission: 'triage' },
    [[{ ref: 'refs/heads/codex/hosted-draft-pump-r0', object: { sha: 'b'.repeat(40) } }]],
    {
      message: [
        'feat: begin hosted pump', '',
        'Gaia-Issue: 60',
        'Gaia-Ready-Receipt: 797eabd4b579944ec4634babd5c018815481b0c8bf0170d90cdaf90353f8e494',
      ].join('\n'),
    },
    { sha: 'c'.repeat(40) },
    {
      node_id: 'R_kgDTest', name: 'gaia', owner: { login: 'GuitarAlchemist' },
      default_branch: 'main',
    },
    { sha: 'a'.repeat(40) },
    [[{ ref: 'refs/heads/codex/hosted-draft-pump-r0', object: { sha: 'b'.repeat(40) } }]],
  ];
  const run = async () => {
    assert.ok(responses.length > 0, 'gh adapter made only the bounded expected reads');
    return structuredClone(responses.shift());
  };
  const collector = createHostedDraftCollector({ github: createGhDraftCollectorApi({ run }) });

  const envelope = await collector.collect({
    repository: { owner: 'old-owner', name: 'old-name' },
    workItem: { kind: 'ISSUE', number: 60 },
  });

  assert.equal(envelope.repository.nodeId, 'R_kgDTest');
  assert.equal(envelope.readyItem.id,
    '1f9efd37f156b4ab51a50f885414f851095aafab1ac3c2a2b8b8ffc271efd69e');
  assert.equal(envelope.generation.headRevision, 'b'.repeat(40));
  assert.equal(responses.length, 0);
});

test('R1 provider failures are typed and redact gh diagnostics', async () => {
  const { createGhDraftCollectorApi, HostedDraftCollectorError } = await api();
  const github = createGhDraftCollectorApi({
    async run() { throw new Error('secret path and provider payload'); },
  });

  await assert.rejects(
    github.resolveRepository({ owner: 'GuitarAlchemist', name: 'gaia' }),
    (error) => error instanceof HostedDraftCollectorError
      && error.code === 'GitHubObservationUnavailable'
      && !error.message.includes('secret'),
  );
});
