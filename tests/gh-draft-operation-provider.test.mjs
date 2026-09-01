import assert from 'node:assert/strict';
import test from 'node:test';

import {
  GhDraftOperationProviderError,
  createGhDraftOperationProvider,
} from '../src/gh-draft-operation-provider.mjs';

const OPERATION_MARKER = 'a'.repeat(64);
const HEAD_REVISION = 'b'.repeat(40);
const REPOSITORY = Object.freeze({
  nodeId: 'R_kgDOGaia',
  owner: 'GuitarAlchemist',
  name: 'gaia',
});
const PRESENTATION = Object.freeze({
  title: 'feat: deliver issue 60',
  issueUrl: 'https://github.com/GuitarAlchemist/gaia/issues/60',
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

function exactPullRequest(overrides = {}) {
  return {
    number: 61,
    url: 'https://github.com/GuitarAlchemist/gaia/pull/61',
    isDraft: true,
    state: 'OPEN',
    baseRefName: 'main',
    headRefName: 'codex/hosted-draft-pump-r0',
    headRefOid: HEAD_REVISION,
    headRepositoryOwner: { login: 'GuitarAlchemist' },
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
  '--head', 'GuitarAlchemist:codex/hosted-draft-pump-r0', '--limit', '100',
  '--json',
  'number,url,isDraft,state,baseRefName,headRefName,headRefOid,headRepositoryOwner,body',
];

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
