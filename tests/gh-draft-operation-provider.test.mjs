import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import {
  GhDraftOperationProviderError,
  createGhDraftOperationProvider,
  createGhManagedRoundApi,
} from '../src/gh-draft-operation-provider.mjs';
import {
  createInitialManagedRound,
  createMemoryManagedRoundEvidencePort,
} from '../src/pr-delivery-round-history.mjs';

const OPERATION_MARKER = 'a'.repeat(64);
const HEAD_REVISION = 'b'.repeat(40);
const WORK_KEY = 'd'.repeat(64);
const REPOSITORY = Object.freeze({
  nodeId: 'R_kgDOGaia',
  owner: 'GuitarAlchemist',
  name: 'gaia',
});
const PRESENTATION = Object.freeze({
  owner: 'Gaia hosted Draft pump',
  gate: 'R4_PROVIDER',
  checklist: Object.freeze([
    'Bind the exact issue and generation',
    'Publish provider evidence',
  ]),
  eta: Object.freeze({ minimumMinutes: 60, maximumMinutes: 120 }),
});

function request(overrides = {}) {
  return {
    repository: REPOSITORY,
    baseRef: 'main',
    headRef: 'codex/hosted-draft-pump-r0',
    headRevision: HEAD_REVISION,
    operationMarker: OPERATION_MARKER,
    workItem: { kind: 'ISSUE', number: 60 },
    ...overrides,
  };
}

function exactBody(marker = OPERATION_MARKER) {
  return [
    `<!-- gaia-operation:${marker} -->`,
    'Issue: https://github.com/GuitarAlchemist/gaia/issues/60',
    'Owner: Gaia hosted Draft pump',
    'Gate: R4_PROVIDER',
    'ETA: 60-120 minutes',
    '',
    'Checklist:',
    '- [ ] Bind the exact issue and generation',
    '- [ ] Publish provider evidence',
  ].join('\n');
}

function roundReceipt() {
  const supervisor = `gaia:operation:${OPERATION_MARKER}`;
  const executionOwner = `gaia:lane:${'e'.repeat(64)}:${HEAD_REVISION}`;
  return {
    schema: 'GaiaRoundReceiptV0', kind: 'OPEN', revision: 'f'.repeat(64), ordinal: 0,
    predecessorRoundKey: 'NONE', trigger: 'DRAFT_CREATED', roundBudget: 2,
    responsibility: {
      ownershipRevision: '1'.repeat(64), accountableOwner: 'github:user:gaia-operator',
      supervisor, executionOwner, reportsTo: supervisor,
      reviewOwners: {
        standards: 'github:user:standards-reviewer', spec: 'github:user:spec-reviewer',
      },
      effectOwner: 'github:app:gaia-draft-pump', escalatesTo: 'github:user:gaia-operator',
    },
    command: {
      commandRevision: '2'.repeat(64), commandOwner: supervisor,
      commandPath: [supervisor, executionOwner], generation: HEAD_REVISION,
      capabilities: ['ASSIGN', 'REVOKE', 'STOP', 'RETRY', 'ESCALATE'],
    },
    evidence: {
      designCommit: '3'.repeat(40), redCommit: '4'.repeat(40),
      greenCommit: 'UNKNOWN(NOT_REACHED)', testEvidenceReceipt: 'UNKNOWN(NOT_REACHED)',
      reviewVerdicts: ['CHANGES_REQUESTED'], result: 'IN_PROGRESS',
      nextStep: 'Prove the production Draft composition',
      estimate: {
        range: 'UNKNOWN(INSUFFICIENT_HISTORY)', confidence: 'UNKNOWN(INSUFFICIENT_HISTORY)',
        origin: 'standards-review:issue-51-r2',
      },
      blocker: {
        class: 'REPRODUCED_FAILURE', reason: 'PRODUCTION_COMPOSITION_MISSING',
        owner: 'github:user:gaia-operator', phaseDeadline: '2026-09-01T23:30:00.000Z',
        nextTransition: 'R0_CREATE_PROVEN', escalationAction: 'REQUEST_ARCHITECTURE_REASSESSMENT',
        origin: 'standards-review:issue-51-r2',
      },
      origin: 'standards-review:issue-51-r2',
    },
  };
}

function effectClaim(id = '5'.repeat(64), observedAt = '2026-09-01T22:40:00.000Z') {
  return {
    schema: 'GaiaManagedRoundEffectClaimV0', revision: '6'.repeat(64), claimId: id,
    observedAt, leaseExpiresAt: '2026-09-01T22:45:00.000Z',
  };
}

function managedRound(overrides = {}) {
  return {
    workKey: WORK_KEY, receipt: roundReceipt(), effectActor: 'github:app:gaia-draft-pump',
    effectClaim: effectClaim(), evidencePort: createMemoryManagedRoundEvidencePort(),
    ...overrides,
  };
}

function exactPullRequest(overrides = {}) {
  return {
    number: 61,
    url: 'https://github.com/GuitarAlchemist/gaia/pull/61',
    isDraft: true,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'codex/hosted-draft-pump-r0',
    headRefOid: HEAD_REVISION,
    // `gh pr list/view --json headRepositoryOwner` returns both fields even though the
    // adapter only needs the login for the repository-owner binding.
    headRepositoryOwner: { id: 'O_kgDOBbiypg', login: 'GuitarAlchemist' },
    body: exactBody(),
    ...overrides,
  };
}

function fakeRun(steps) {
  const calls = [];
  const run = async (command, args, options) => {
    calls.push({ command, args: [...args], options: { ...options } });
    const step = steps.shift();
    assert.ok(step, `unexpected command: ${command} ${args.join(' ')}`);
    assert.equal(command, 'gh');
    assert.deepEqual(args, step.args);
    if (step.error) throw step.error;
    return { stdout: step.stdout ?? '', stderr: step.stderr ?? '' };
  };
  return { run, calls };
}

const REPO_VIEW_ARGS = [
  'repo', 'view', 'GuitarAlchemist/gaia', '--json', 'id,nameWithOwner',
];
const PR_LIST_ARGS = [
  'pr', 'list', '--repo', 'GuitarAlchemist/gaia', '--state', 'open',
  '--head', 'codex/hosted-draft-pump-r0', '--limit', '100',
  '--json',
  'number,url,isDraft,state,baseRefName,headRefName,headRefOid,headRepositoryOwner,body',
];
const PR_FIELDS =
  'number,url,isDraft,state,baseRefName,headRefName,headRefOid,headRepositoryOwner,body';
const API_BODY = 'human body';
const API_ETAG = '"resource-v1"';
const API_REPO_ARGS = REPO_VIEW_ARGS;
const API_GET_ARGS = ['api', '-i', 'repos/GuitarAlchemist/gaia/pulls/61'];

function apiPull(body = API_BODY) {
  return { number: 61, state: 'open', draft: true, head: { sha: HEAD_REVISION }, body };
}

function included(etag, body) {
  return `HTTP/2 200 OK\r\netag: ${etag}\r\n\r\n${JSON.stringify(body)}`;
}

async function importMutant(name, mutate) {
  const sourceUrl = new URL('../src/gh-draft-operation-provider.mjs', import.meta.url);
  const dependencyUrl = new URL('../src/pr-delivery-round-history.mjs', import.meta.url).href;
  const original = readFileSync(sourceUrl, 'utf8').replace(
    "'./pr-delivery-round-history.mjs'", JSON.stringify(dependencyUrl),
  );
  const mutated = mutate(original);
  assert.notEqual(mutated, original, `${name} must alter the provider mechanism`);
  const directory = mkdtempSync(join(tmpdir(), `gaia-managed-api-${name}-`));
  const path = join(directory, 'provider.mjs');
  writeFileSync(path, mutated, 'utf8');
  return import(`${pathToFileURL(path).href}?mutant=${name}`);
}

test('lookupExact returns only the open Draft bound to the exact repository, generation, and marker', async () => {
  const fake = fakeRun([
    {
      args: REPO_VIEW_ARGS,
      stdout: JSON.stringify({ id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/gaia' }),
    },
    { args: PR_LIST_ARGS, stdout: JSON.stringify([exactPullRequest()]) },
  ]);
  const provider = createGhDraftOperationProvider({
    expectedRepository: REPOSITORY,
    presentation: PRESENTATION,
    run: fake.run,
  });

  const found = await provider.lookupExact(request());

  assert.deepEqual(found, {
    number: 61,
    url: 'https://github.com/GuitarAlchemist/gaia/pull/61',
    isDraft: true,
    state: 'OPEN',
    operationMarker: OPERATION_MARKER,
    repository: REPOSITORY,
    baseRef: 'main',
    headRef: 'codex/hosted-draft-pump-r0',
    headRevision: HEAD_REVISION,
  });
  assert.equal(fake.calls.length, 2);
});

test('lookupExact rejects an unsealed or differently bound provider request before contacting GitHub', async () => {
  const fake = fakeRun([]);
  const provider = createGhDraftOperationProvider({
    expectedRepository: REPOSITORY,
    presentation: PRESENTATION,
    run: fake.run,
  });

  await assert.rejects(
    provider.lookupExact({ ...request(), unexpectedAuthority: 'WRITE' }),
    (error) => error instanceof GhDraftOperationProviderError
      && error.code === 'InvalidRequest'
      && error.message === 'InvalidRequest',
  );
  await assert.rejects(
    provider.lookupExact(request({
      repository: { ...REPOSITORY, name: 'different-repository' },
    })),
    (error) => error instanceof GhDraftOperationProviderError
      && error.code === 'RequestBindingMismatch',
  );
  assert.equal(fake.calls.length, 0);
});

test('lookupExact fails closed on a conflicting marker, duplicate candidate, or mismatched head OID', async (context) => {
  const cases = [
    {
      name: 'conflicting marker',
      candidates: [exactPullRequest({ body: exactBody('c'.repeat(64)) })],
      code: 'ProviderConflict',
    },
    {
      name: 'duplicate candidates',
      candidates: [exactPullRequest(), exactPullRequest({ number: 62,
        url: 'https://github.com/GuitarAlchemist/gaia/pull/62' })],
      code: 'ProviderAmbiguous',
    },
    {
      name: 'mismatched head OID',
      candidates: [exactPullRequest({ headRefOid: 'c'.repeat(40) })],
      code: 'ProviderConflict',
    },
  ];
  for (const item of cases) {
    await context.test(item.name, async () => {
      const fake = fakeRun([
        { args: REPO_VIEW_ARGS,
          stdout: JSON.stringify({ id: REPOSITORY.nodeId,
            nameWithOwner: 'GuitarAlchemist/gaia' }) },
        { args: PR_LIST_ARGS, stdout: JSON.stringify(item.candidates) },
      ]);
      const provider = createGhDraftOperationProvider({
        expectedRepository: REPOSITORY, presentation: PRESENTATION, run: fake.run,
      });
      await assert.rejects(
        provider.lookupExact(request()),
        (error) => error instanceof GhDraftOperationProviderError
          && error.code === item.code && error.message === item.code,
      );
    });
  }
});

test('real provider creates the Draft through canonical managed R0 composition', async () => {
  const createdUrl = 'https://github.com/GuitarAlchemist/gaia/pull/61';
  const encodedHead = 'codex%2Fhosted-draft-pump-r0';
  const initial = createInitialManagedRound({
    workKey: WORK_KEY, headRevision: HEAD_REVISION, receipt: roundReceipt(),
  });
  const managedBody = `${exactBody()}\n\n${initial.managedSection}`;
  const fake = fakeRun([
    {
      args: REPO_VIEW_ARGS,
      stdout: JSON.stringify({ id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/gaia' }),
    },
    { args: PR_LIST_ARGS, stdout: '[]' },
    {
      args: [
        'api', `repos/GuitarAlchemist/gaia/git/ref/heads/${encodedHead}`,
        '--jq', '.object.sha',
      ],
      stdout: `${HEAD_REVISION}\n`,
    },
    {
      args: [
        'pr', 'create', '--repo', 'GuitarAlchemist/gaia', '--draft', '--base', 'main',
        '--head', 'GuitarAlchemist:codex/hosted-draft-pump-r0',
        '--title', 'draft: deliver issue #60',
        '--body', managedBody,
      ],
      stdout: `${createdUrl}\n`,
    },
    {
      args: [
        'pr', 'view', '61', '--repo', 'GuitarAlchemist/gaia', '--json', PR_FIELDS,
      ],
      stdout: JSON.stringify(exactPullRequest({ body: managedBody })),
    },
  ]);
  const provider = createGhDraftOperationProvider({
    expectedRepository: REPOSITORY, presentation: PRESENTATION,
    managedRound: managedRound(), run: fake.run,
  });

  const created = await provider.createDraft(request());

  assert.deepEqual(created, {
    number: 61,
    url: createdUrl,
    isDraft: true,
    state: 'OPEN',
    operationMarker: OPERATION_MARKER,
    repository: REPOSITORY,
    baseRef: 'main',
    headRef: 'codex/hosted-draft-pump-r0',
    headRevision: HEAD_REVISION,
  });
  assert.equal((managedBody.match(/<!-- gaia-rounds:begin:/gu) ?? []).length, 1);
  assert.equal((managedBody.match(/#### R0/gu) ?? []).length, 1);
  assert.equal(fake.calls.length, 5);
});

test('createDraft refuses a moved remote head and redacts provider failures', async (context) => {
  await context.test('moved head', async () => {
    const fake = fakeRun([
      { args: REPO_VIEW_ARGS,
        stdout: JSON.stringify({ id: REPOSITORY.nodeId,
          nameWithOwner: 'GuitarAlchemist/gaia' }) },
      { args: PR_LIST_ARGS, stdout: '[]' },
      {
        args: [
          'api', 'repos/GuitarAlchemist/gaia/git/ref/heads/codex%2Fhosted-draft-pump-r0',
          '--jq', '.object.sha',
        ],
        stdout: `${'c'.repeat(40)}\n`,
      },
    ]);
    const provider = createGhDraftOperationProvider({
      expectedRepository: REPOSITORY, presentation: PRESENTATION,
      managedRound: managedRound(), run: fake.run,
    });
    await assert.rejects(
      provider.createDraft(request()),
      (error) => error instanceof GhDraftOperationProviderError
        && error.code === 'RequestBindingMismatch',
    );
    assert.equal(fake.calls.length, 3);
  });

  await context.test('redacted command failure', async () => {
    const secret = 'ghp_do-not-leak-this';
    const fake = fakeRun([
      { args: REPO_VIEW_ARGS, error: new Error(`403 Authorization: token ${secret}`) },
    ]);
    const provider = createGhDraftOperationProvider({
      expectedRepository: REPOSITORY, presentation: PRESENTATION, run: fake.run,
    });
    await assert.rejects(
      provider.lookupExact(request()),
      (error) => error instanceof GhDraftOperationProviderError
        && error.code === 'ProviderUnavailable'
        && error.message === 'ProviderUnavailable'
        && !String(error.stack).includes(secret),
    );
  });
});

test('managed body API binds the repository node id before its ETag observation', async () => {
  const fake = fakeRun([
    { args: API_REPO_ARGS,
      stdout: JSON.stringify({ id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/gaia' }) },
    { args: API_GET_ARGS, stdout: included(API_ETAG, apiPull()) },
  ]);
  const api = createGhManagedRoundApi({ expectedRepository: REPOSITORY, run: fake.run });

  assert.deepEqual(await api.observe(61), {
    number: 61, headRevision: HEAD_REVISION, body: API_BODY,
    bodyRevision: 'd97078ab8ce8664588d967df94779d0a8bd17eebb03f2055ebcc5d167d10eafb',
  });
  assert.deepEqual(fake.calls.map((call) => call.args), [API_REPO_ARGS, API_GET_ARGS]);

  const mismatch = fakeRun([{
    args: API_REPO_ARGS,
    stdout: JSON.stringify({ id: 'R_DIFFERENT', nameWithOwner: 'GuitarAlchemist/gaia' }),
  }]);
  const refused = createGhManagedRoundApi({ expectedRepository: REPOSITORY, run: mismatch.run });
  await assert.rejects(
    refused.observe(61),
    (error) => error instanceof GhDraftOperationProviderError
      && error.code === 'RepositoryIdentityMismatch',
  );
  assert.equal(mismatch.calls.length, 1, 'node-id mismatch performs no PR GET or PATCH');
});

test('managed body API PATCHes once with the observed ETag and exact proposed body', async () => {
  const proposedBody = 'human body\n\nmanaged R1';
  const patchArgs = [
    'api', '-i', '-X', 'PATCH', 'repos/GuitarAlchemist/gaia/pulls/61',
    '-H', `If-Match: ${API_ETAG}`, '-f', `body=${proposedBody}`,
  ];
  const fake = fakeRun([
    { args: API_REPO_ARGS,
      stdout: JSON.stringify({ id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/gaia' }) },
    { args: API_GET_ARGS, stdout: included(API_ETAG, apiPull()) },
    { args: API_REPO_ARGS,
      stdout: JSON.stringify({ id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/gaia' }) },
    { args: patchArgs, stdout: included('"resource-v2"', apiPull(proposedBody)) },
  ]);
  const api = createGhManagedRoundApi({ expectedRepository: REPOSITORY, run: fake.run });
  const observed = await api.observe(61);
  const acknowledgement = await api.compareAndSetBody({
    number: 61, expectedHeadRevision: observed.headRevision,
    expectedBodyRevision: observed.bodyRevision, proposedBody,
    proposedBodyRevision: 'f'.repeat(64),
  });

  assert.deepEqual(acknowledgement, { kind: 'ACKNOWLEDGED' });
  assert.equal(fake.calls.filter((call) => call.args.includes('PATCH')).length, 1);
  assert.deepEqual(fake.calls.at(-1).args, patchArgs);
});

test('managed body API redacts repository and PATCH diagnostics', async (context) => {
  const secret = 'ghp_managed-round-secret';
  for (const stage of ['repository', 'patch']) {
    await context.test(stage, async () => {
      const steps = stage === 'repository'
        ? [{ args: API_REPO_ARGS, error: new Error(secret) }]
        : [
          { args: API_REPO_ARGS,
            stdout: JSON.stringify({ id: REPOSITORY.nodeId,
              nameWithOwner: 'GuitarAlchemist/gaia' }) },
          { args: API_GET_ARGS, stdout: included(API_ETAG, apiPull()) },
          { args: API_REPO_ARGS,
            stdout: JSON.stringify({ id: REPOSITORY.nodeId,
              nameWithOwner: 'GuitarAlchemist/gaia' }) },
          { args: [
            'api', '-i', '-X', 'PATCH', 'repos/GuitarAlchemist/gaia/pulls/61',
            '-H', `If-Match: ${API_ETAG}`, '-f', 'body=next',
          ], error: new Error(secret) },
        ];
      const fake = fakeRun(steps);
      const api = createGhManagedRoundApi({ expectedRepository: REPOSITORY, run: fake.run });
      if (stage === 'patch') {
        const observed = await api.observe(61);
        assert.deepEqual(await api.compareAndSetBody({
          number: 61, expectedHeadRevision: observed.headRevision,
          expectedBodyRevision: observed.bodyRevision, proposedBody: 'next',
          proposedBodyRevision: 'f'.repeat(64),
        }), { kind: 'AMBIGUOUS' });
      } else {
        await assert.rejects(api.observe(61), (error) => error.code === 'ProviderUnavailable'
          && error.message === 'ProviderUnavailable' && !String(error.stack).includes(secret));
      }
    });
  }
});

test('managed body API reconciles a lost PATCH response without repeating the effect', async () => {
  let body = API_BODY;
  let patches = 0;
  const calls = [];
  const run = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'repo') {
      return { stdout: JSON.stringify({ id: REPOSITORY.nodeId,
        nameWithOwner: 'GuitarAlchemist/gaia' }) };
    }
    if (args.includes('PATCH')) {
      patches += 1;
      body = 'body after lost response';
      throw new Error('connection reset after GitHub committed');
    }
    return { stdout: included(patches === 0 ? API_ETAG : '"resource-v2"', apiPull(body)) };
  };
  const api = createGhManagedRoundApi({ expectedRepository: REPOSITORY, run });
  const before = await api.observe(61);
  const acknowledgement = await api.compareAndSetBody({
    number: 61, expectedHeadRevision: before.headRevision,
    expectedBodyRevision: before.bodyRevision, proposedBody: 'body after lost response',
    proposedBodyRevision: 'f'.repeat(64),
  });
  const after = await api.observe(61);

  assert.deepEqual(acknowledgement, { kind: 'AMBIGUOUS' });
  assert.equal(after.body, 'body after lost response');
  assert.equal(patches, 1);
  assert.equal(calls.filter((args) => args.includes('PATCH')).length, 1);
});

test('MECHANISM REVERT: removing node-id binding exposes the foreign repository', async () => {
  const mutant = await importMutant('node-id', (source) => source.replaceAll(
    'observed.id !== expected.nodeId || observed.nameWithOwner !== repositoryName',
    'false || observed.nameWithOwner !== repositoryName',
  ));
  const fake = fakeRun([
    { args: API_REPO_ARGS,
      stdout: JSON.stringify({ id: 'R_FOREIGN', nameWithOwner: 'GuitarAlchemist/gaia' }) },
    { args: API_GET_ARGS, stdout: included(API_ETAG, apiPull()) },
  ]);
  const api = mutant.createGhManagedRoundApi({ expectedRepository: REPOSITORY, run: fake.run });
  assert.equal((await api.observe(61)).number, 61,
    'the mutant reaches foreign PR data, while the production public test refuses it');
});

test('MECHANISM REVERT: removing If-Match exposes an unconditional PATCH', async () => {
  const mutant = await importMutant('if-match', (source) => source.replace(
    "'-H', `If-Match: ${cached.etag}`, '-f', `body=${effect.proposedBody}`",
    "'-f', `body=${effect.proposedBody}`",
  ));
  const calls = [];
  const run = async (_command, args) => {
    calls.push([...args]);
    if (args[0] === 'repo') return { stdout: JSON.stringify({
      id: REPOSITORY.nodeId, nameWithOwner: 'GuitarAlchemist/gaia',
    }) };
    return { stdout: included(API_ETAG, apiPull(args.includes('PATCH') ? 'next' : API_BODY)) };
  };
  const api = mutant.createGhManagedRoundApi({ expectedRepository: REPOSITORY, run });
  const observed = await api.observe(61);
  await api.compareAndSetBody({
    number: 61, expectedHeadRevision: observed.headRevision,
    expectedBodyRevision: observed.bodyRevision, proposedBody: 'next',
    proposedBodyRevision: 'f'.repeat(64),
  });
  const patch = calls.find((args) => args.includes('PATCH'));
  assert.ok(patch);
  assert.ok(!patch.some((argument) => String(argument).startsWith('If-Match:')),
    'the mutant demonstrates the unconditional provider write the public contract detects');
});
