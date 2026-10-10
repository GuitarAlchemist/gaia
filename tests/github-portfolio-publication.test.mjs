import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import { measureAgentFactoryChangeSet } from '../src/factory-agent.mjs';
import { createGitGhCandidatePublicationEffects } from '../src/git-gh-publication-effects.mjs';
import {
  createFileEd25519AuthorityAdapter,
  portfolioGrantPreimage,
} from '../src/github-portfolio-authority.mjs';
import {
  createGitHubCandidatePublicationAdapter,
  GitHubCandidatePublicationError,
} from '../src/github-portfolio-publication.mjs';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const BASE_OID = '1'.repeat(40);
const COMMIT_OID = '2'.repeat(40);

const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
};

const digest = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function publicationIntent(candidate = {}) {
  const body = {
    schema: 'gaia-github-candidate-publish-intent/1',
    effect: 'NONE',
    source: {
      transitionRevision: SHA_A,
      executionReceiptRevision: SHA_B,
      intentRevision: 'c'.repeat(64),
      portfolioRevision: 'd'.repeat(64),
      idempotencyKey: 'e'.repeat(64),
    },
    repository: 'GuitarAlchemist/gaia',
    item: { kind: 'ISSUE', id: 'I_kwDOExample', number: 42 },
    candidate: {
      headOid: candidate.headOid ?? BASE_OID,
      baseOid: candidate.baseOid ?? BASE_OID,
      changeSetIdentity: candidate.changeSetIdentity ?? 'f'.repeat(64),
      observation: 'CALLER_OBSERVED_READ_ONLY_DATA',
    },
    requestedOperations: [
      'COMMIT_CANDIDATE', 'PUSH_CANDIDATE_BRANCH', 'OPEN_PULL_REQUEST',
    ],
  };
  return { ...body, revision: digest(body) };
}

test('publishes one authorized fresh candidate without merge authority', async () => {
  const intent = publicationIntent();
  const calls = [];
  const authority = {
    async consume(request) {
      calls.push(['authorize', request]);
      return {
        status: 'AUTHORIZED',
        grantId: 'grant-publication-42',
        intentRevision: intent.revision,
      };
    },
  };
  const effects = {
    async observe(request) {
      calls.push(['observe', request]);
      return {
        repository: intent.repository,
        headOid: BASE_OID,
        baseOid: BASE_OID,
        changeSetIdentity: intent.candidate.changeSetIdentity,
      };
    },
    async commit(request) {
      calls.push(['commit', request]);
      return { commitOid: COMMIT_OID };
    },
    async push(request) {
      calls.push(['push', request]);
      return { headOid: COMMIT_OID };
    },
    async openPullRequest(request) {
      calls.push(['openPullRequest', request]);
      return {
        number: 17,
        url: 'https://github.com/GuitarAlchemist/gaia/pull/17',
        headOid: COMMIT_OID,
      };
    },
  };
  const adapter = createGitHubCandidatePublicationAdapter({
    expectedRepository: 'GuitarAlchemist/gaia', authority, effects,
  });

  const receipt = await adapter.publish({ intent, grant: { opaque: 'operator-owned' } });

  assert.deepEqual(calls.map(([name]) => name), [
    'observe', 'authorize', 'commit', 'push', 'openPullRequest',
  ]);
  assert.equal(calls[1][1].intent.action, 'PUBLISH_CANDIDATE');
  assert.equal(calls[1][1].intent.intentRevision, intent.revision);
  assert.equal(calls[2][1].expectedHeadOid, BASE_OID);
  assert.equal(calls[3][1].expectedBaseOid, BASE_OID);
  assert.equal(Object.hasOwn(effects, 'merge'), false);
  assert.deepEqual(receipt.pullRequest, {
    number: 17,
    url: 'https://github.com/GuitarAlchemist/gaia/pull/17',
    headOid: COMMIT_OID,
  });
  assert.equal(receipt.schema, 'gaia-github-candidate-publication-receipt/1');
  assert.equal(receipt.status, 'completed');
  assert.equal(receipt.intentRevision, intent.revision);
  assert.match(receipt.idempotencyKey, /^[a-f0-9]{64}$/u);
  assert.match(receipt.revision, /^[a-f0-9]{64}$/u);
});

test('an effect failure is typed and redacted before later publication steps', async () => {
  const intent = publicationIntent();
  const calls = [];
  let failureCode;
  const adapter = createGitHubCandidatePublicationAdapter({
    expectedRepository: intent.repository,
    authority: {
      async consume() {
        return {
          status: 'AUTHORIZED', grantId: 'grant-redacted', intentRevision: intent.revision,
        };
      },
    },
    effects: {
      async observe() {
        return {
          repository: intent.repository,
          headOid: BASE_OID,
          baseOid: BASE_OID,
          changeSetIdentity: intent.candidate.changeSetIdentity,
        };
      },
      async commit() {
        calls.push('commit');
        throw Object.assign(new Error('secret provider diagnostic with credential material'),
          { code: failureCode });
      },
      async push() { calls.push('push'); },
      async openPullRequest() { calls.push('openPullRequest'); },
    },
  });

  await assert.rejects(
    adapter.publish({ intent, grant: { opaque: 'operator-owned' } }),
    (error) => error instanceof GitHubCandidatePublicationError
      && error.code === 'CommitFailed'
      && !error.message.includes('secret provider diagnostic'),
  );
  assert.deepEqual(calls, ['commit']);
  failureCode = 'IndexScopeRefused';
  await assert.rejects(adapter.publish({ intent, grant: { opaque: 'operator-owned' } }),
    error => error.code === 'IndexScopeRefused' && !error.message.includes('secret'));
  assert.deepEqual(calls, ['commit', 'commit']);
});

test('a refused publication grant causes no mutation and leaks no authority diagnostic', async () => {
  const intent = publicationIntent();
  const mutations = [];
  const adapter = createGitHubCandidatePublicationAdapter({
    expectedRepository: intent.repository,
    authority: {
      async consume() { throw new Error('private signing implementation detail'); },
    },
    effects: {
      async observe() {
        return {
          repository: intent.repository,
          headOid: BASE_OID,
          baseOid: BASE_OID,
          changeSetIdentity: intent.candidate.changeSetIdentity,
        };
      },
      async commit() { mutations.push('commit'); },
      async push() { mutations.push('push'); },
      async openPullRequest() { mutations.push('openPullRequest'); },
    },
  });

  await assert.rejects(
    adapter.publish({ intent, grant: { opaque: 'rejected' } }),
    (error) => error instanceof GitHubCandidatePublicationError
      && error.code === 'AuthorityRefused'
      && !error.message.includes('private signing implementation detail'),
  );
  assert.deepEqual(mutations, []);
});

test('a pull-request follow-up never carries an issue-closing instruction', async () => {
  const issueIntent = publicationIntent();
  const body = {
    ...issueIntent,
    item: { kind: 'PULL_REQUEST', id: 'PR_kwDOExample', number: 42 },
  };
  const { revision: _discard, ...unsigned } = body;
  const intent = { ...unsigned, revision: digest(unsigned) };
  let request;
  const adapter = createGitHubCandidatePublicationAdapter({
    expectedRepository: intent.repository,
    authority: {
      async consume() {
        return {
          status: 'AUTHORIZED', grantId: 'grant-pr-follow-up', intentRevision: intent.revision,
        };
      },
    },
    effects: {
      async observe() {
        return {
          repository: intent.repository,
          headOid: BASE_OID,
          baseOid: BASE_OID,
          changeSetIdentity: intent.candidate.changeSetIdentity,
        };
      },
      async commit() { return { commitOid: COMMIT_OID }; },
      async push() { return { headOid: COMMIT_OID }; },
      async openPullRequest(value) {
        request = value;
        return {
          number: 18,
          url: 'https://github.com/GuitarAlchemist/gaia/pull/18',
          headOid: COMMIT_OID,
        };
      },
    },
  });

  await adapter.publish({ intent, grant: { opaque: 'operator-owned' } });

  assert.equal(request.title, 'Follow up pull request #42');
  assert.equal(request.body, 'Follow-up to #42');
  assert.ok(!request.body.includes('Closes'));
});

test('a provider cannot substitute an unrelated pull-request URL in the receipt', async () => {
  const intent = publicationIntent();
  const adapter = createGitHubCandidatePublicationAdapter({
    expectedRepository: intent.repository,
    authority: {
      async consume() {
        return {
          status: 'AUTHORIZED', grantId: 'grant-forged-url', intentRevision: intent.revision,
        };
      },
    },
    effects: {
      async observe() {
        return {
          repository: intent.repository,
          headOid: BASE_OID,
          baseOid: BASE_OID,
          changeSetIdentity: intent.candidate.changeSetIdentity,
        };
      },
      async commit() { return { commitOid: COMMIT_OID }; },
      async push() { return { headOid: COMMIT_OID }; },
      async openPullRequest() {
        return { number: 17, url: 'https://attacker.invalid/pull/17', headOid: COMMIT_OID };
      },
    },
  });

  await assert.rejects(
    adapter.publish({ intent, grant: { opaque: 'operator-owned' } }),
    (error) => error instanceof GitHubCandidatePublicationError
      && error.code === 'EffectResultInvalid',
  );
});

test('the shipped Ed25519 authority spends one exact publication grant once', async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-publication-authority-'));
  try {
    const ledgerDir = join(scratch, 'ledger');
    mkdirSync(ledgerDir);
    const intent = publicationIntent();
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const payload = {
      schema: 'gaia-github-portfolio-grant/1',
      grantId: 'grant-real-publication-authority',
      intentRevision: intent.revision,
      action: 'PUBLISH_CANDIDATE',
      repository: intent.repository,
      itemKind: intent.item.kind,
      itemId: intent.item.id,
      itemNumber: intent.item.number,
      snapshotRevision: intent.source.portfolioRevision,
      expiresAt: '2026-08-29T00:00:00.000Z',
    };
    const grant = {
      ...payload,
      signature: sign(null, portfolioGrantPreimage(payload), privateKey).toString('base64url'),
    };
    const authority = createFileEd25519AuthorityAdapter({
      publicKey,
      ledgerDir,
      now: () => new Date('2026-08-28T12:00:00.000Z'),
    });
    const mutations = [];
    const effects = {
      async observe() {
        return {
          repository: intent.repository,
          headOid: BASE_OID,
          baseOid: BASE_OID,
          changeSetIdentity: intent.candidate.changeSetIdentity,
        };
      },
      async commit() { mutations.push('commit'); return { commitOid: COMMIT_OID }; },
      async push() { mutations.push('push'); return { headOid: COMMIT_OID }; },
      async openPullRequest() {
        mutations.push('openPullRequest');
        return {
          number: 17,
          url: 'https://github.com/GuitarAlchemist/gaia/pull/17',
          headOid: COMMIT_OID,
        };
      },
    };
    const adapter = createGitHubCandidatePublicationAdapter({
      expectedRepository: intent.repository, authority, effects,
    });

    assert.equal((await adapter.publish({ intent, grant })).status, 'completed');
    await assert.rejects(
      adapter.publish({ intent, grant }),
      (error) => error instanceof GitHubCandidatePublicationError
        && error.code === 'AuthorityRefused',
    );
    assert.deepEqual(mutations, ['commit', 'push', 'openPullRequest']);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the Git/gh Adapter commits locally, leases the push, and reuses no arbitrary effect',
  async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-publication-effects-'));
  try {
    const repo = join(scratch, 'repo');
    const worktree = join(scratch, 'worktree');
    mkdirSync(repo);
    const git = (cwd, ...args) => execFileSync('git', args, {
      cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    git(repo, 'init', '--initial-branch=main');
    git(repo, 'config', 'user.name', 'Gaia Test');
    git(repo, 'config', 'user.email', 'gaia@example.invalid');
    writeFileSync(join(repo, 'candidate.txt'), 'before\n', 'utf8');
    git(repo, 'add', 'candidate.txt');
    git(repo, 'commit', '-m', 'fixture');
    git(repo, 'remote', 'add', 'origin', 'https://github.com/GuitarAlchemist/gaia.git');
    git(repo, 'worktree', 'add', '-b', 'candidate', worktree, 'HEAD');
    writeFileSync(join(worktree, 'candidate.txt'), 'after\n', 'utf8');
    const baseOid = git(worktree, 'rev-parse', 'HEAD');
    const changeSetIdentity = measureAgentFactoryChangeSet(worktree, baseOid).identity;
    const intent = publicationIntent({ headOid: baseOid, baseOid, changeSetIdentity });
    const commands = [];
    const realExec = promisify(execFile);
    const run = async (command, args, options) => {
      commands.push([command, [...args]]);
      if (command === 'git' && args[0] === 'ls-remote') {
        if (args.at(-1) === 'refs/heads/main') return { stdout: `${baseOid}\trefs/heads/main\n` };
        return { stdout: '' };
      }
      if (command === 'git' && args[0] === 'push') return { stdout: '' };
      if (command === 'gh' && args[1] === 'list') return { stdout: '[]\n' };
      if (command === 'gh' && args[1] === 'create') {
        return { stdout: 'https://github.com/GuitarAlchemist/gaia/pull/17\n' };
      }
      if (command === 'gh' && args[1] === 'view') {
        const headRefOid = git(worktree, 'rev-parse', 'HEAD');
        return {
          stdout: `${JSON.stringify({
            number: 17,
            url: 'https://github.com/GuitarAlchemist/gaia/pull/17',
            headRefOid,
          })}\n`,
        };
      }
      return realExec(command, args, options);
    };
    const effects = createGitGhCandidatePublicationEffects({
      expectedRepository: intent.repository,
      worktree,
      baseBranch: 'main',
      run,
    });
    const adapter = createGitHubCandidatePublicationAdapter({
      expectedRepository: intent.repository,
      authority: {
        async consume() {
          return {
            status: 'AUTHORIZED', grantId: 'grant-live-adapter', intentRevision: intent.revision,
          };
        },
      },
      effects,
    });

    const receipt = await adapter.publish({ intent, grant: { opaque: 'operator-owned' } });

    assert.equal(receipt.status, 'completed');
    assert.equal(git(worktree, 'status', '--porcelain=v1'), '');
    assert.equal(receipt.commitOid, git(worktree, 'rev-parse', 'HEAD'));
    const push = commands.find(([command, args]) => command === 'git' && args[0] === 'push');
    assert.ok(push[1].includes(`--force-with-lease=refs/heads/${receipt.branch}:`));
    assert.ok(!commands.some(([command, args]) => command === 'gh' && args[1] === 'merge'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  });

function stagingFixture() {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-bounded-staging-'));
  const repo = join(scratch, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, {
    cwd: repo, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Gaia Test');
  git('config', 'user.email', 'gaia@example.invalid');
  writeFileSync(join(repo, 'CONTEXT.md'), 'before\n');
  writeFileSync(join(repo, 'third.txt'), 'third baseline\n');
  git('add', '--', 'CONTEXT.md', 'third.txt');
  git('commit', '-m', 'baseline');
  git('remote', 'add', 'origin', 'https://github.com/GuitarAlchemist/gaia.git');
  const head = git('rev-parse', 'HEAD');
  mkdirSync(join(repo, 'docs', 'adr'), { recursive: true });
  writeFileSync(join(repo, 'CONTEXT.md'), 'after\n');
  writeFileSync(join(repo, 'docs', 'adr', '0005-loop.md'), 'bounded ADR\n');
  writeFileSync(join(repo, '-option[1].txt'), 'literal pathspec fixture\n');
  // A quoted old command is file data, never a command for this adapter to execute or parse.
  writeFileSync(join(repo, 'fix4_adr5.sh'),
    'old="git add CONTEXT.md docs/adr/"\nnew="git add CONTEXT.md docs/adr/0005-loop.md"\n');
  const calls = [];
  const realExec = promisify(execFile);
  const effects = (beforeRun = () => {}) => createGitGhCandidatePublicationEffects({
    expectedRepository: 'GuitarAlchemist/gaia', worktree: repo, baseBranch: 'main',
    run: async (command, args, options) => {
      calls.push([command, [...args]]);
      beforeRun(command, args);
      return realExec(command, args, options);
    },
  });
  const request = () => ({
    repository: 'GuitarAlchemist/gaia', branch: 'gaia/bounded-staging',
    expectedHeadOid: head, changeSetIdentity: measureAgentFactoryChangeSet(repo, head).identity,
    message: 'bounded fixture', idempotencyKey: SHA_A,
  });
  return { scratch, repo, git, head, calls, effects, request };
}

test('publication stages literal exact files, treating old broad command text only as data', async () => {
  for (const interference of ['none', 'third', 'owned', 'headSwap']) {
    const f = stagingFixture();
    try {
      let correctCommit;
      const effects = f.effects((_command, args) => {
        if (interference === 'headSwap' && args[0] === 'write-tree') {
          correctCommit = f.git('commit-tree', f.git('write-tree'), '-p', f.head, '-m', 'correct alternate');
        }
        if (interference === 'headSwap' && args[0] === 'rev-parse' && args[1].endsWith('^')) {
          // HEAD moves after the returned OID was read; only that OID's own parent/tree count.
          f.git('update-ref', 'HEAD', correctCommit);
        }
        if (interference === 'none' || !args.includes('commit')) return;
        if (interference === 'owned' || interference === 'headSwap') {
          writeFileSync(join(f.repo, 'CONTEXT.md'), 'changed after the last reading\n');
          return;
        }
        // Interference after the final reading must never be absorbed by the commit.
        writeFileSync(join(f.repo, 'third.txt'), 'late third-party edit\n');
        f.git('add', '--', 'third.txt');
      });
      const request = f.request();
      if (interference === 'owned' || interference === 'headSwap') {
        const intent = publicationIntent({ headOid: f.head, baseOid: f.head,
          changeSetIdentity: request.changeSetIdentity });
        let laterEffects = 0;
        const adapter = createGitHubCandidatePublicationAdapter({
          expectedRepository: intent.repository,
          authority: { async consume() { return {
            status: 'AUTHORIZED', grantId: 'owned-interference', intentRevision: intent.revision,
          }; } },
          effects: { ...effects,
            async observe() { return { repository: intent.repository, headOid: f.head,
              baseOid: f.head, changeSetIdentity: request.changeSetIdentity }; },
            async push(value) { laterEffects += 1; return { headOid: value.commitOid }; },
            async openPullRequest(value) { laterEffects += 1; return {
              number: 17, url: 'https://github.com/GuitarAlchemist/gaia/pull/17', headOid: value.commitOid,
            }; },
          },
        });
        await assert.rejects(adapter.publish({ intent, grant: { fixture: true } }),
          error => error.code === 'StagingVerificationFailed');
        assert.equal(laterEffects, 0);
        assert.equal(f.git('show', 'HEAD:third.txt'), 'third baseline');
        continue;
      }
      const result = await effects.commit(request);
      const add = f.calls.filter(([command, args]) => command === 'git' && args.includes('add'));
      assert.deepEqual(add, [['git', ['--literal-pathspecs', 'add', '--',
        '-option[1].txt', 'CONTEXT.md', 'docs/adr/0005-loop.md', 'fix4_adr5.sh']]]);
      assert.equal(result.commitOid, f.git('rev-parse', 'HEAD'));
      assert.deepEqual(f.git('diff-tree', '--no-commit-id', '--name-only', '-r', result.commitOid)
        .split('\n'), ['-option[1].txt', 'CONTEXT.md', 'docs/adr/0005-loop.md', 'fix4_adr5.sh']);
      if (interference === 'third') {
        assert.equal(f.git('diff', '--cached', '--name-only'), 'third.txt');
        assert.equal(f.git('show', ':third.txt'), 'late third-party edit');
        assert.equal(f.git('show', 'HEAD:third.txt'), 'third baseline');
      } else assert.equal(f.git('status', '--porcelain=v1'), '');
    } finally { rmSync(f.scratch, { recursive: true, force: true }); }
  }
});

test('publication refuses a pre-existing staged third-party file without changing index or bytes', async () => {
  const f = stagingFixture();
  try {
    writeFileSync(join(f.repo, 'third.txt'), 'third-party edit\n');
    f.git('add', '--', 'third.txt');
    const index = f.git('write-tree');
    const status = f.git('status', '--porcelain=v1');
    await assert.rejects(f.effects().commit(f.request()),
      error => error.code === 'IndexScopeRefused');
    assert.equal(f.git('write-tree'), index);
    assert.equal(f.git('status', '--porcelain=v1'), status);
    assert.equal(f.git('show', ':third.txt'), 'third-party edit');
    assert.equal(f.git('rev-parse', 'HEAD'), f.head);
    assert.ok(!f.calls.some(([, args]) => args.includes('add') || args[0] === 'commit'));
  } finally { rmSync(f.scratch, { recursive: true, force: true }); }
});

test('publication rereads after branch preparation and never stages changed or ambiguously owned state', async () => {
  for (const stageThirdParty of [false, true]) {
    const f = stagingFixture();
    try {
      const request = f.request();
      let indexAfterInterference;
      const effects = f.effects((_command, args) => {
        if (args[0] !== 'switch') return;
        writeFileSync(join(f.repo, 'third.txt'), 'concurrent third-party edit\n');
        if (stageThirdParty) f.git('add', '--', 'third.txt');
        indexAfterInterference = f.git('write-tree');
      });
      await assert.rejects(effects.commit(request), error => error.code === 'CandidateChanged'
        || error.code === 'IndexScopeRefused');
      assert.equal(f.git('write-tree'), indexAfterInterference);
      assert.equal(f.git('rev-parse', 'HEAD'), f.head);
      assert.ok(!f.calls.some(([, args]) => args.includes('add') || args[0] === 'commit'));
      assert.match(f.git('diff', f.head, '--', 'third.txt'), /concurrent third-party edit/);
    } finally { rmSync(f.scratch, { recursive: true, force: true }); }
  }
});

test('expired publication responses and duplicate grants never repeat a first mutation', async () => {
  for (const mode of ['expired', 'duplicate']) {
    const scratch = mkdtempSync(join(tmpdir(), 'gaia-staging-grant-'));
    try {
      const ledgerDir = join(scratch, 'ledger'); mkdirSync(ledgerDir);
      const intent = publicationIntent();
      const { publicKey, privateKey } = generateKeyPairSync('ed25519');
      const payload = {
        schema: 'gaia-github-portfolio-grant/1', grantId: 'bounded-first-action',
        intentRevision: intent.revision, action: 'PUBLISH_CANDIDATE',
        repository: intent.repository, itemKind: intent.item.kind, itemId: intent.item.id,
        itemNumber: intent.item.number, snapshotRevision: intent.source.portfolioRevision,
        expiresAt: '2026-10-10T12:00:01.000Z',
      };
      const grant = { ...payload,
        signature: sign(null, portfolioGrantPreimage(payload), privateKey).toString('base64url') };
      let now = new Date('2026-10-10T12:00:00.000Z');
      const authority = createFileEd25519AuthorityAdapter({ publicKey, ledgerDir, now: () => now });
      const mutations = [];
      const adapter = createGitHubCandidatePublicationAdapter({
        expectedRepository: intent.repository, authority,
        effects: {
          async observe() {
            // A delayed observation is reread before authority consumption, not auto-approved.
            if (mode === 'expired') now = new Date(payload.expiresAt);
            return { repository: intent.repository, headOid: BASE_OID, baseOid: BASE_OID,
              changeSetIdentity: intent.candidate.changeSetIdentity };
          },
          async commit() { mutations.push('commit'); return { commitOid: COMMIT_OID }; },
          async push() { mutations.push('push'); return { headOid: COMMIT_OID }; },
          async openPullRequest() { mutations.push('pr'); return {
            number: 17, url: 'https://github.com/GuitarAlchemist/gaia/pull/17', headOid: COMMIT_OID,
          }; },
        },
      });
      if (mode === 'duplicate') {
        const receipt = await adapter.publish({ intent, grant });
        assert.equal(receipt.commitOid, COMMIT_OID);
      }
      await assert.rejects(adapter.publish({ intent, grant }), error => error.code === 'AuthorityRefused');
      assert.deepEqual(mutations, mode === 'duplicate' ? ['commit', 'push', 'pr'] : []);
    } finally { rmSync(scratch, { recursive: true, force: true }); }
  }
});
