import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PortfolioFactoryError,
  createPortfolioFactory,
} from '../src/github-portfolio.mjs';
import { createGitHubReadAdapter } from '../src/github-read-adapter.mjs';

const completeSnapshot = (repositories) => ({
  schema: 'gaia-github-read-snapshot/1',
  organization: 'GuitarAlchemist',
  scope: 'all-repositories-visible-to-adapter',
  complete: true,
  repositories,
});

function searchMetadata(args, { issues = 0, pullRequests = 0, incomplete = false } = {}) {
  if (args[0] !== 'api' || !String(args[1]).startsWith('search/issues?')) return null;
  return {
    total_count: String(args[1]).includes('is%3Aissue') ? issues : pullRequests,
    incomplete_results: incomplete,
  };
}

const ga = {
  id: 'repo-ga',
  nameWithOwner: 'GuitarAlchemist/ga',
  archived: false,
  defaultBranchOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  issues: [{
    id: 'issue-ga-1', number: 1, title: 'Repair the canonical chatbot',
    updatedAt: '2026-08-20T12:00:00.000Z', labels: ['ready-for-agent'],
    dependencies: [], duplicateOf: null,
  }],
  pullRequests: [],
};

const ix = {
  id: 'repo-ix',
  nameWithOwner: 'GuitarAlchemist/ix',
  archived: false,
  defaultBranchOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  issues: [],
  pullRequests: [{
    id: 'pr-ix-2', number: 2, title: 'Add deterministic ranking',
    updatedAt: '2026-08-20T11:00:00.000Z', isDraft: false,
    headOid: 'cccccccccccccccccccccccccccccccccccccccc',
    baseOid: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    labels: [],
    checks: 'UNKNOWN', review: 'UNKNOWN', dependencies: [], duplicateOf: null,
  }],
};

test('survey is deterministic across adapter ordering and performs no write', async () => {
  let writes = 0;
  const first = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([ga, ix]) },
    githubEffects: { write: async () => { writes += 1; } },
  });
  const second = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([ix, ga]) },
    githubEffects: { write: async () => { writes += 1; } },
  });

  const request = {
    organization: 'GuitarAlchemist',
    policyRevision: 'sha256:portfolio-policy-v1',
  };
  const left = await first.survey(request);
  const right = await second.survey(request);

  assert.deepEqual(left, right);
  assert.equal(left.schema, 'gaia-github-portfolio/1');
  assert.equal(left.complete, true);
  assert.deepEqual(left.counts, { repositories: 2, issues: 1, pullRequests: 1 });
  assert.match(left.revision, /^[a-f0-9]{64}$/);
  assert.equal(writes, 0);
});

test('survey refuses a partial adapter snapshot instead of ranking missing work', async () => {
  const factory = createPortfolioFactory({
    githubRead: { read: async () => ({ ...completeSnapshot([ga]), complete: false }) },
  });

  await assert.rejects(factory.survey({
    organization: 'GuitarAlchemist',
    policyRevision: 'sha256:portfolio-policy-v1',
  }), (error) => error instanceof PortfolioFactoryError
    && error.code === 'PortfolioIncomplete');
});

test('survey classifies conservatively and schedules at most one item per repository', async () => {
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([
      {
        ...ga,
        issues: [
          ga.issues[0],
          {
            ...ga.issues[0], id: 'issue-ga-2', number: 2,
            title: 'Human architecture decision', labels: ['ready-for-human'],
          },
        ],
      },
      ix,
    ]) },
  });

  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist',
    policyRevision: 'sha256:portfolio-policy-v1',
  });

  assert.deepEqual(portfolio.schedule.map(({ repository, itemId }) => ({ repository, itemId })), [
    { repository: 'GuitarAlchemist/ga', itemId: 'issue-ga-1' },
  ]);
  assert.equal(portfolio.workItems.find(({ itemId }) => itemId === 'issue-ga-2').state,
    'AWAITING_HUMAN');
  assert.equal(portfolio.workItems.find(({ itemId }) => itemId === 'pr-ix-2').state,
    'CHECKS_AND_REVIEW_UNKNOWN');
});

test('advance emits one exact authority-bound intent and performs no effect', async () => {
  let writes = 0;
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([ga, ix]) },
    githubEffects: { write: async () => { writes += 1; } },
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist',
    policyRevision: 'sha256:portfolio-policy-v1',
  });

  const receipt = await factory.advance({ portfolio });

  assert.equal(receipt.schema, 'gaia-github-portfolio-transition/1');
  assert.equal(receipt.status, 'AWAITING_AUTHORITY');
  assert.equal(receipt.fromRevision, portfolio.revision);
  const { intentRevision, ...intent } = receipt.intent;
  assert.deepEqual(intent, {
    action: 'RUN_FACTORY_AGENT',
    repository: 'GuitarAlchemist/ga',
    itemKind: 'ISSUE',
    itemId: 'issue-ga-1',
    itemNumber: 1,
    task: 'Resolve GuitarAlchemist/ga#1: Repair the canonical chatbot',
    evidenceState: 'READY',
    snapshotRevision: portfolio.revision,
    requiredAuthority: 'FACTORY_RUN',
  });
  assert.match(intentRevision, /^[a-f0-9]{64}$/u);
  assert.equal(writes, 0);
});

test('advance executes one factory run only after an exact grant is consumed', async () => {
  let consumed = 0;
  let executed = 0;
  const authority = {
    consume: async ({ grant, intent }) => {
      consumed += 1;
      if (grant.grantId === 'grant-wrong-intent') {
        return {
          status: 'AUTHORIZED', grantId: grant.grantId, intentRevision: 'f'.repeat(64),
        };
      }
      assert.deepEqual(grant, {
        schema: 'gaia-github-portfolio-grant/1',
        grantId: 'grant-001',
        intentRevision: intent.intentRevision,
      });
      return {
        status: 'AUTHORIZED', grantId: grant.grantId, intentRevision: intent.intentRevision,
      };
    },
  };
  const factoryExecution = {
    execute: async ({ intent, idempotencyKey }) => {
      executed += 1;
      assert.match(idempotencyKey, /^[a-f0-9]{64}$/u);
      return {
        schema: 'gaia-agent-factory-receipt/1', status: 'completed', task: intent.task,
      };
    },
  };
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([ga]) },
    authority,
    factoryExecution,
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });
  const awaiting = await factory.advance({ portfolio });
  await assert.rejects(factory.advance({
    portfolio,
    grant: {
      schema: 'gaia-github-portfolio-grant/1',
      grantId: 'grant-wrong-intent',
      intentRevision: awaiting.intent.intentRevision,
    },
  }), (error) => error instanceof PortfolioFactoryError && error.code === 'GrantInvalid');
  assert.equal(executed, 0);
  const completed = await factory.advance({
    portfolio,
    grant: {
      schema: 'gaia-github-portfolio-grant/1',
      grantId: 'grant-001',
      intentRevision: awaiting.intent.intentRevision,
    },
  });

  assert.equal(completed.status, 'CANDIDATE_READY');
  assert.equal(completed.authority.grantId, 'grant-001');
  assert.equal(completed.authority.intentRevision, awaiting.intent.intentRevision);
  assert.match(completed.execution.idempotencyKey, /^[a-f0-9]{64}$/u);
  assert.match(completed.execution.receiptRevision, /^[a-f0-9]{64}$/u);
  assert.equal(completed.execution.receipt.status, 'completed');
  assert.equal(consumed, 2);
  assert.equal(executed, 1);
});

test('advance returns a redacted failure receipt after a consumed grant', async () => {
  const authority = {
    consume: async ({ grant, intent }) => ({
      status: 'AUTHORIZED', grantId: grant.grantId, intentRevision: intent.intentRevision,
    }),
  };
  let failureMode = 'throw';
  let getterEvaluated = false;
  const factoryExecution = {
    execute: async () => {
      if (failureMode === 'protocol') {
        return { schema: 'wrong-receipt/1', status: 'completed', task: 'wrong task' };
      }
      if (failureMode === 'getter') {
        const error = {};
        Object.defineProperty(error, 'name', {
          get() {
            getterEvaluated = true;
            return 'SensitiveError';
          },
        });
        throw error;
      }
      const error = new Error('sensitive provider output');
      error.code = 'AgentFailed';
      throw error;
    },
  };
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([ga]) }, authority, factoryExecution,
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });
  const awaiting = await factory.advance({ portfolio });
  const failed = await factory.advance({
    portfolio,
    grant: {
      schema: 'gaia-github-portfolio-grant/1',
      grantId: 'grant-failure',
      intentRevision: awaiting.intent.intentRevision,
    },
  });

  assert.equal(failed.status, 'EXECUTION_FAILED');
  assert.deepEqual(failed.execution.error, { name: 'Error', code: 'AgentFailed' });
  assert.equal(JSON.stringify(failed).includes('sensitive provider output'), false);
  assert.equal(failed.authority.grantId, 'grant-failure');
  assert.match(failed.revision, /^[a-f0-9]{64}$/u);

  failureMode = 'protocol';
  const protocolFailed = await factory.advance({
    portfolio,
    grant: {
      schema: 'gaia-github-portfolio-grant/1',
      grantId: 'grant-protocol',
      intentRevision: awaiting.intent.intentRevision,
    },
  });
  assert.equal(protocolFailed.status, 'EXECUTION_FAILED');
  assert.deepEqual(protocolFailed.execution.error, {
    name: 'PortfolioFactoryError', code: 'ExecutionProtocol',
  });
  assert.equal(JSON.stringify(protocolFailed).includes('wrong-receipt'), false);

  failureMode = 'getter';
  const getterFailed = await factory.advance({
    portfolio,
    grant: {
      schema: 'gaia-github-portfolio-grant/1',
      grantId: 'grant-getter',
      intentRevision: awaiting.intent.intentRevision,
    },
  });
  assert.equal(getterEvaluated, false);
  assert.deepEqual(getterFailed.execution.error, {
    name: 'Error', code: 'ExecutionFailed',
  });
});

test('advance refuses a portfolio whose content no longer matches its revision', async () => {
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([ga]) },
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist',
    policyRevision: 'sha256:portfolio-policy-v1',
  });

  await assert.rejects(factory.advance({
    portfolio: { ...portfolio, policyRevision: 'sha256:tampered' },
  }), (error) => error instanceof PortfolioFactoryError && error.code === 'SnapshotMismatch');
});

test('the gh adapter ingests a complete portfolio without inventing dependency evidence', async () => {
  const calls = [];
  const run = async (args) => {
    calls.push(args);
    const metadata = searchMetadata(args, { issues: 1 });
    if (metadata) return metadata;
    if (args[0] === 'repo') return [{
      id: 'repo-ga', nameWithOwner: 'GuitarAlchemist/ga', isArchived: false,
      defaultBranchRef: { name: 'main' },
    }];
    if (args[1] === 'issues') return [{
      id: 'issue-ga-1', number: 1, title: 'Repair the canonical chatbot',
      updatedAt: '2026-08-20T12:00:00Z', body: '',
      labels: [{ name: 'ready-for-agent' }],
      repository: { nameWithOwner: 'GuitarAlchemist/ga' },
    }];
    if (args[1] === 'prs') return [];
    if (args[0] === 'api') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const factory = createPortfolioFactory({
    githubRead: createGitHubReadAdapter({ run, resultLimit: 10 }),
  });

  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist',
    policyRevision: 'sha256:portfolio-policy-v1',
  });

  assert.deepEqual(portfolio.counts, { repositories: 1, issues: 1, pullRequests: 0 });
  assert.equal(portfolio.workItems[0].state, 'READY_WITH_UNKNOWN');
  assert.equal(portfolio.schedule[0].reason, 'READY_WITH_EXPLICIT_UNKNOWNS');
  assert.equal(calls.every(([command, subcommand]) => command === 'repo'
    || command === 'search' || (command === 'api'
      && (subcommand.startsWith('repos/') || subcommand.startsWith('search/issues?')))), true);
});

test('the gh adapter marks a result capped at its query limit as incomplete', async () => {
  const run = async (args) => {
    const metadata = searchMetadata(args);
    if (metadata) return metadata;
    if (args[0] === 'repo') return [{
      id: 'repo-ga', nameWithOwner: 'GuitarAlchemist/ga', isArchived: false,
      defaultBranchRef: { name: 'main' },
    }];
    if (args[0] === 'search') return [];
    if (args[0] === 'api') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const factory = createPortfolioFactory({
    githubRead: createGitHubReadAdapter({ run, resultLimit: 1 }),
  });

  await assert.rejects(factory.survey({
    organization: 'GuitarAlchemist',
    policyRevision: 'sha256:portfolio-policy-v1',
  }), (error) => error instanceof PortfolioFactoryError
    && error.code === 'PortfolioIncomplete');
});

test('survey canonicalizes nested label and dependency ordering', async () => {
  const issue = {
    ...ga.issues[0],
    labels: ['ready-for-agent', 'bug'],
    dependencies: ['GuitarAlchemist/ix#7', 'GuitarAlchemist/ga#3'],
  };
  const reversed = {
    ...issue,
    labels: [...issue.labels].reverse(),
    dependencies: [...issue.dependencies].reverse(),
  };
  const first = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([{ ...ga, issues: [issue] }]) },
  });
  const second = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([{ ...ga, issues: [reversed] }]) },
  });
  const request = {
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  };

  assert.deepEqual(await first.survey(request), await second.survey(request));
});

test('survey refuses malformed complete snapshots instead of defaulting missing arrays', async () => {
  const malformed = [
    { schema: 'gaia-github-read-snapshot/1', organization: 'GuitarAlchemist',
      scope: 'all-repositories-visible-to-adapter', complete: true },
    completeSnapshot([{ ...ga, issues: undefined }]),
  ];
  for (const snapshot of malformed) {
    const factory = createPortfolioFactory({ githubRead: { read: async () => snapshot } });
    await assert.rejects(factory.survey({
      organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
    }), (error) => error instanceof PortfolioFactoryError && error.code === 'InvalidSnapshot');
  }
});

test('survey refuses missing nested evidence instead of inventing negative facts', async () => {
  const malformedRepositories = [
    { ...ga, archived: undefined },
    { ...ga, issues: [{ ...ga.issues[0], labels: undefined }] },
    { ...ga, issues: [{ ...ga.issues[0], dependencies: undefined }] },
    { ...ga, issues: [{ ...ga.issues[0], duplicateOf: undefined }] },
    { ...ix, pullRequests: [{ ...ix.pullRequests[0], isDraft: undefined }] },
    { ...ix, pullRequests: [{ ...ix.pullRequests[0], dependencies: undefined }] },
    { ...ix, pullRequests: [{ ...ix.pullRequests[0], duplicateOf: undefined }] },
  ];
  for (const repository of malformedRepositories) {
    const factory = createPortfolioFactory({
      githubRead: { read: async () => completeSnapshot([repository]) },
    });
    await assert.rejects(factory.survey({
      organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
    }), (error) => error instanceof PortfolioFactoryError && error.code === 'InvalidSnapshot');
  }
});

test('the gh adapter refuses a query limit above the GitHub Search completeness bound', () => {
  assert.throws(() => createGitHubReadAdapter({ resultLimit: 1001 }),
    /resultLimit must be between 1 and 1000/u);
});

test('the gh adapter blocks exact declared dependencies from issue bodies', async () => {
  const run = async (args) => {
    const metadata = searchMetadata(args, { issues: 1 });
    if (metadata) return metadata;
    if (args[0] === 'repo') return [{
      id: 'repo-ga', nameWithOwner: 'GuitarAlchemist/ga', isArchived: false,
      defaultBranchRef: { name: 'main' },
    }];
    if (args[1] === 'issues') return [{
      id: 'issue-ga-1', number: 1, title: 'Repair the canonical chatbot',
      updatedAt: '2026-08-20T12:00:00Z', body: 'Depends-On: GuitarAlchemist/ix#7',
      labels: [{ name: 'ready-for-agent' }],
      repository: { nameWithOwner: 'GuitarAlchemist/ga' },
    }];
    if (args[1] === 'prs') return [];
    if (args[0] === 'api') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const factory = createPortfolioFactory({
    githubRead: createGitHubReadAdapter({ run, resultLimit: 10 }),
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });

  assert.equal(portfolio.workItems[0].state, 'BLOCKED_DEPENDENCY');
  assert.deepEqual(portfolio.repositories[0].issues[0].dependencies,
    ['GuitarAlchemist/ix#7']);
  assert.equal(portfolio.schedule.length, 0);
});

test('the gh adapter treats repeated identical duplicate declarations as one fact', async () => {
  const run = async (args) => {
    const metadata = searchMetadata(args, { issues: 1 });
    if (metadata) return metadata;
    if (args[0] === 'repo') return [{
      id: 'repo-ga', nameWithOwner: 'GuitarAlchemist/ga', isArchived: false,
      defaultBranchRef: { name: 'main' },
    }];
    if (args[1] === 'issues') return [{
      id: 'issue-ga-1', number: 1, title: 'Repeated duplicate declaration',
      updatedAt: '2026-08-20T12:00:00Z',
      body: 'Duplicate-Of: GuitarAlchemist/ga#2\nDuplicate-Of: GuitarAlchemist/ga#2',
      labels: [{ name: 'ready-for-agent' }],
      repository: { nameWithOwner: 'GuitarAlchemist/ga' },
    }];
    if (args[1] === 'prs') return [];
    if (args[0] === 'api') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const factory = createPortfolioFactory({
    githubRead: createGitHubReadAdapter({ run, resultLimit: 10 }),
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });

  assert.equal(portfolio.workItems[0].state, 'DUPLICATE');
  assert.equal(portfolio.repositories[0].issues[0].dependencies, 'UNKNOWN');
  assert.equal(portfolio.repositories[0].issues[0].duplicateOf, 'GuitarAlchemist/ga#2');
});

test('the gh adapter refuses a Search response marked incomplete below the row cap', async () => {
  const run = async (args) => {
    const metadata = searchMetadata(args, { issues: 1, incomplete: true });
    if (metadata) return metadata;
    if (args[0] === 'repo') return [{
      id: 'repo-ga', nameWithOwner: 'GuitarAlchemist/ga', isArchived: false,
      defaultBranchRef: { name: 'main' },
    }];
    if (args[1] === 'issues') return [{
      id: 'issue-ga-1', number: 1, title: 'Partial search response',
      updatedAt: '2026-08-20T12:00:00Z', body: '', labels: [],
      repository: { nameWithOwner: 'GuitarAlchemist/ga' },
    }];
    if (args[1] === 'prs') return [];
    if (args[0] === 'api') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  const factory = createPortfolioFactory({
    githubRead: createGitHubReadAdapter({ run, resultLimit: 10 }),
  });

  await assert.rejects(factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  }), (error) => error instanceof PortfolioFactoryError
    && error.code === 'PortfolioIncomplete');
});

test('the gh adapter refuses omitted or malformed label evidence', async () => {
  for (const labels of [undefined, [{ name: 'ready-for-agent' }, {}]]) {
    const run = async (args) => {
      const metadata = searchMetadata(args, { issues: 1 });
      if (metadata) return metadata;
      if (args[0] === 'repo') return [{
        id: 'repo-ga', nameWithOwner: 'GuitarAlchemist/ga', isArchived: false,
        defaultBranchRef: { name: 'main' },
      }];
      if (args[1] === 'issues') return [{
        id: 'issue-ga-1', number: 1, title: 'Invalid labels',
        updatedAt: '2026-08-20T12:00:00Z', body: '', labels,
        repository: { nameWithOwner: 'GuitarAlchemist/ga' },
      }];
      if (args[1] === 'prs') return [];
      if (args[0] === 'api') return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      throw new Error(`unexpected gh call: ${args.join(' ')}`);
    };
    const factory = createPortfolioFactory({
      githubRead: createGitHubReadAdapter({ run, resultLimit: 10 }),
    });

    await assert.rejects(factory.survey({
      organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
    }), /gh item labels|every gh item label/u);
  }
});

test('survey keeps a human-gated pull request out of the schedule', async () => {
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([{
      ...ix,
      pullRequests: [{
        ...ix.pullRequests[0], labels: ['ready-for-human'], checks: 'PASS', review: 'APPROVE',
      }],
    }]) },
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });

  assert.equal(portfolio.workItems[0].state, 'AWAITING_HUMAN');
  assert.equal(portfolio.schedule.length, 0);
});

test('advance refuses when a fresh GitHub observation changes the portfolio revision', async () => {
  let current = completeSnapshot([ga]);
  let reads = 0;
  const factory = createPortfolioFactory({ githubRead: { read: async () => {
    reads += 1;
    return current;
  } } });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });
  current = completeSnapshot([{ ...ga, defaultBranchOid: 'dddddddddddddddddddddddddddddddddddddddd' }]);

  await assert.rejects(factory.advance({ portfolio }),
    (error) => error instanceof PortfolioFactoryError && error.code === 'SnapshotStale');
  assert.equal(reads, 2);
});

test('survey refuses duplicate repository or item identities', async () => {
  const duplicateRepository = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([ga, ga]) },
  });
  const duplicateItem = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([
      ga, { ...ix, pullRequests: [{ ...ix.pullRequests[0], id: 'issue-ga-1' }] },
    ]) },
  });
  const request = {
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  };

  await assert.rejects(duplicateRepository.survey(request),
    (error) => error instanceof PortfolioFactoryError && error.code === 'DuplicateIdentity');
  await assert.rejects(duplicateItem.survey(request),
    (error) => error instanceof PortfolioFactoryError && error.code === 'DuplicateIdentity');
});

test('survey rejects timestamps without an explicit timezone', async () => {
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([{
      ...ga, issues: [{ ...ga.issues[0], updatedAt: '2026-08-20T12:00:00' }],
    }]) },
  });

  await assert.rejects(factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  }), (error) => error instanceof PortfolioFactoryError && error.code === 'InvalidSnapshot');
});

test('survey preserves separate unknown-check and unknown-review states', async () => {
  const factory = createPortfolioFactory({
    githubRead: { read: async () => completeSnapshot([{
      ...ix,
      pullRequests: [
        { ...ix.pullRequests[0], id: 'pr-checks', checks: 'UNKNOWN', review: 'APPROVE' },
        { ...ix.pullRequests[0], id: 'pr-review', checks: 'PASS', review: 'UNKNOWN' },
      ],
    }]) },
  });
  const portfolio = await factory.survey({
    organization: 'GuitarAlchemist', policyRevision: 'sha256:portfolio-policy-v1',
  });
  const states = Object.fromEntries(portfolio.workItems.map(({ itemId, state }) => [itemId, state]));

  assert.equal(states['pr-checks'], 'CHECKS_UNKNOWN');
  assert.equal(states['pr-review'], 'REVIEW_UNKNOWN');
});
