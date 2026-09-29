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

test('R1 a matching default branch head is a typed refusal, not a Draft source', async () => {
  const { createHostedDraftCollector, HostedDraftCollectorError } = await api();
  const stable = githubBoundary();
  const collector = createHostedDraftCollector({
    github: {
      ...stable,
      async listHeadRefs() {
        return [{ name: 'main', revision: 'b'.repeat(40) }];
      },
    },
  });

  await assert.rejects(
    collector.collect({
      repository: { owner: 'old-owner', name: 'old-name' },
      workItem: { kind: 'ISSUE', number: 60 },
    }),
    (error) => error instanceof HostedDraftCollectorError
      && error.code === 'DefaultBranchSourceRejected'
      && error.message === 'the repository default branch cannot be a Draft source',
  );
});

test('R1 a unique distinct matching branch remains accepted as a Draft source', async () => {
  const { createHostedDraftCollector } = await api();
  const collector = createHostedDraftCollector({ github: githubBoundary() });

  const envelope = await collector.collect({
    repository: { owner: 'old-owner', name: 'old-name' },
    workItem: { kind: 'ISSUE', number: 60 },
  });

  assert.equal(envelope.generation.headRef, 'codex/hosted-draft-pump-r0');
});

const EVIDENCE_MESSAGE = [
  'feat: begin hosted pump', '',
  'Gaia-Issue: 60',
  'Gaia-Ready-Receipt: 797eabd4b579944ec4634babd5c018815481b0c8bf0170d90cdaf90353f8e494',
].join('\n');

/** `gh api graphql --paginate --slurp`: one object per page of branch tips. */
const headPages = (...pages) => pages.map((nodes) => ({
  data: { repository: { refs: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } } },
}));

const tip = (name, revision, message, typename = 'Commit') => ({
  name, target: { __typename: typename, oid: revision, message },
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
      updated_at: '2026-08-31T19:05:00.000Z', labels: [{ name: 'ready-for-agent' }],
    },
    [[
      {
        node_id: 'LE_old', event: 'labeled', created_at: '2026-08-31T18:00:00.000Z',
        actor: { node_id: 'U_old', login: 'older-actor' }, label: { name: 'ready-for-agent' },
      },
      {
        node_id: 'LE_latest', event: 'labeled', created_at: '2026-08-31T19:00:00.000Z',
        actor: { node_id: 'U_actor', login: 'trusted-actor' }, label: { name: 'ready-for-agent' },
      },
    ]],
    { permission: 'triage' },
    // The tip's message arrives with the listing, so no per-commit read follows it.
    headPages([tip('codex/hosted-draft-pump-r0', 'b'.repeat(40), EVIDENCE_MESSAGE)]),
    { sha: 'c'.repeat(40) },
    {
      node_id: 'R_kgDTest', name: 'gaia', owner: { login: 'GuitarAlchemist' },
      default_branch: 'main',
    },
    { sha: 'a'.repeat(40) },
    headPages([tip('codex/hosted-draft-pump-r0', 'b'.repeat(40), EVIDENCE_MESSAGE)]),
  ];
  const calls = [];
  const run = async (args) => {
    calls.push(args);
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
  assert.ok(!calls.some((args) => args.some((arg) => arg.includes('/git/commits/'))),
    'no commit is read one by one');
});

test('the gh adapter lists every branch tip with its message in one paginated GraphQL query', async () => {
  const { createGhDraftCollectorApi } = await api();
  const repository = { owner: 'GuitarAlchemist', name: 'gaia' };
  const unlisted = 'e'.repeat(40);
  const calls = [];
  const github = createGhDraftCollectorApi({
    async run(args) {
      calls.push(args);
      if (args[1] === 'graphql') {
        return headPages(
          [tip('main', 'a'.repeat(40), 'chore: base'), tip('gaia/issue-60-ready-2', 'b'.repeat(40), EVIDENCE_MESSAGE)],
          [tip('feature/x', 'd'.repeat(40), 'feat: x')],
        );
      }
      assert.equal(args[1], `repos/GuitarAlchemist/gaia/git/commits/${unlisted}`);
      return { message: 'chore: read over REST' };
    },
  });

  assert.deepEqual(await github.listHeadRefs({ repository }), [
    { name: 'main', revision: 'a'.repeat(40) },
    { name: 'gaia/issue-60-ready-2', revision: 'b'.repeat(40) },
    { name: 'feature/x', revision: 'd'.repeat(40) },
  ]);
  assert.equal(calls.length, 1);
  const [query] = calls[0].filter((arg) => arg.startsWith('query='));
  assert.match(query, /refs\(refPrefix: "refs\/heads\/", first: 100, after: \$endCursor\)/u);
  assert.match(query, /pageInfo \{ hasNextPage endCursor \}/u, 'gh --paginate needs the cursor');
  assert.deepEqual(calls[0].slice(0, 4), ['api', 'graphql', '--paginate', '--slurp']);

  assert.deepEqual(await github.readCommit({ repository, revision: 'b'.repeat(40) }),
    { message: EVIDENCE_MESSAGE });
  assert.equal(calls.length, 1, 'a listed tip is answered from the listing');
  assert.deepEqual(await github.readCommit({ repository, revision: unlisted }),
    { message: 'chore: read over REST' });
  assert.equal(calls.length, 2, 'only a revision no listing named reaches GitHub');
  const elsewhere = { owner: 'GuitarAlchemist', name: 'other' };
  await assert.rejects(github.readCommit({ repository: elsewhere, revision: 'b'.repeat(40) }));
  assert.equal(calls.length, 3, 'a listing answers only for its own repository');
});

test('a head listing that is not a page of commit tips refuses the observation', async () => {
  const { createGhDraftCollectorApi, HostedDraftCollectorError } = await api();
  const repository = { owner: 'GuitarAlchemist', name: 'gaia' };
  for (const [label, response] of [
    ['a tip that is not a commit', headPages([tip('v1', 'a'.repeat(40), 'tag', 'Tag')])],
    ['a tip without an object id', headPages([tip('main', 'short', 'chore: base')])],
    ['a tip without a message', headPages([tip('main', 'a'.repeat(40), '')])],
    ['a page without nodes', [{ data: { repository: null } }]],
    ['an unpaged response', { data: { repository: { refs: { nodes: [] } } } }],
  ]) {
    const github = createGhDraftCollectorApi({ async run() { return structuredClone(response); } });
    await assert.rejects(github.listHeadRefs({ repository }),
      (error) => error instanceof HostedDraftCollectorError
        && ['HeadObservationInvalid', 'CommitObservationInvalid'].includes(error.code), label);
  }
});

test('a GitHub rate limit is named, and nothing else of the gh diagnostic leaves the adapter', async () => {
  const { createGhDraftCollectorApi, HostedDraftCollectorError } = await api();
  const { ghFailure } = await import('../src/gh-failure.mjs');
  for (const [stderr, code] of [
    ['gh: API rate limit exceeded for installation ID 4788836. (HTTP 403)', 'GitHubRateLimited'],
    ['gh: You have exceeded a secondary rate limit. Please wait a few minutes. (HTTP 403)',
      'GitHubRateLimited'],
    ['GraphQL: API rate limit already exceeded for installation ID 4788836.', 'GitHubRateLimited'],
    ['gh: Too Many Requests (HTTP 429)', 'GitHubRateLimited'],
    ['gh: Not Found (HTTP 404)', 'GitHubObservationUnavailable'],
    [undefined, 'GitHubObservationUnavailable'],
  ]) {
    const github = createGhDraftCollectorApi({ async run() { throw ghFailure(stderr); } });
    await assert.rejects(
      github.resolveRepository({ owner: 'GuitarAlchemist', name: 'gaia' }),
      (error) => error instanceof HostedDraftCollectorError && error.code === code
        && !/installation|HTTP|4788836/u.test(error.message),
      String(stderr),
    );
  }
});

test('R1 concrete gh timestamps normalize provider precision without widening parsing', async (context) => {
  const { createGhDraftCollectorApi, HostedDraftCollectorError } = await api();
  const issue = (updatedAt) => ({
    node_id: 'I_test60', number: 60, state: 'open', updated_at: updatedAt,
    labels: [{ name: 'ready-for-agent' }],
  });
  const events = (createdAt) => [[{
    node_id: 'LE_latest', event: 'labeled', created_at: createdAt,
    actor: { node_id: 'U_actor', login: 'trusted-actor' },
    label: { name: 'ready-for-agent' },
  }]];

  for (const [field, updatedAt, createdAt] of [
    ['updated_at', '2026-08-31T19:05:00+00:00', '2026-08-31T19:00:00.000Z'],
    ['created_at', '2026-08-31T19:05:00.000Z', '2026-08-31T19:00:00+00:00'],
  ]) {
    await context.test(`parseable non-canonical ${field} is refused`, async () => {
      const responses = [issue(updatedAt), events(createdAt)];
      const github = createGhDraftCollectorApi({
        async run() { return structuredClone(responses.shift()); },
      });
      await assert.rejects(
        github.readIssue({
          repository: { owner: 'GuitarAlchemist', name: 'gaia' }, number: 60,
        }),
        (error) => error instanceof HostedDraftCollectorError
          && error.code === 'IssueObservationInvalid',
      );
    });
  }

  await context.test('GitHub second precision is normalized to the canonical instant', async () => {
    const responses = [
      issue('2026-08-31T19:05:00Z'),
      events('2026-08-31T19:00:00Z'),
    ];
    const github = createGhDraftCollectorApi({
      async run() { return structuredClone(responses.shift()); },
    });
    const observed = await github.readIssue({
      repository: { owner: 'GuitarAlchemist', name: 'gaia' }, number: 60,
    });
    assert.equal(observed.updatedAt, '2026-08-31T19:05:00.000Z');
    assert.equal(observed.labelEvents[0].createdAt, '2026-08-31T19:00:00.000Z');
  });

  await context.test('exact instant is preserved byte for byte', async () => {
    const responses = [
      issue('2026-08-31T19:05:00.000Z'),
      events('2026-08-31T19:00:00.000Z'),
    ];
    const github = createGhDraftCollectorApi({
      async run() { return structuredClone(responses.shift()); },
    });
    const observed = await github.readIssue({
      repository: { owner: 'GuitarAlchemist', name: 'gaia' }, number: 60,
    });
    assert.equal(observed.updatedAt, '2026-08-31T19:05:00.000Z');
    assert.equal(observed.labelEvents[0].createdAt, '2026-08-31T19:00:00.000Z');
  });
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

function manyHeads(count) {
  const stable = githubBoundary();
  const heads = Array.from({ length: count }, (_, index) => ({
    name: index === count - 1 ? 'codex/hosted-draft-pump-r0' : `feature/unrelated-${index}`,
    revision: index === count - 1 ? 'b'.repeat(40) : index.toString(16).padStart(40, 'd'),
  }));
  const counters = { reads: 0, inFlight: 0, maxInFlight: 0, failOnce: null };
  const github = {
    ...stable,
    async listHeadRefs() { return heads.map((head) => ({ ...head })); },
    async readCommit({ revision }) {
      counters.reads += 1;
      counters.inFlight += 1;
      counters.maxInFlight = Math.max(counters.maxInFlight, counters.inFlight);
      await new Promise((resolve) => setTimeout(resolve, 2));
      counters.inFlight -= 1;
      if (counters.failOnce === revision) {
        counters.failOnce = null;
        throw new Error('transient provider failure');
      }
      return revision === 'b'.repeat(40) ? stable.readCommit() : { message: 'chore: unrelated' };
    },
  };
  return { github, counters };
}

test('head commits are read once per intake run, in bounded parallel, and failures are not cached', async () => {
  const { createHostedDraftCollector } = await api();
  const { github, counters } = manyHeads(20);
  const collector = createHostedDraftCollector({ github });

  const first = await collector.collect(SELECTOR);
  const second = await collector.collect(SELECTOR);
  assert.deepEqual(second, first);
  assert.equal(counters.reads, 20, 'each immutable commit is read once across collections');
  assert.ok(counters.maxInFlight > 1 && counters.maxInFlight <= 8, `bounded fan-out (${counters.maxInFlight})`);

  const fresh = manyHeads(20);
  fresh.counters.failOnce = 'b'.repeat(40);
  const retrying = createHostedDraftCollector({ github: fresh.github });
  await assert.rejects(retrying.collect(SELECTOR));
  await retrying.collect(SELECTOR);
  assert.equal(fresh.counters.reads, 21, 'only the failed read is repeated');
});
