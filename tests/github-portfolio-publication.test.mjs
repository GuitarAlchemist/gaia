import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
import { withEnvironment } from './helpers/ambient-git.mjs';

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

// The Git subcommand, after any leading `-c name=value` pins.
const subcommand = (args) => { let at = 0; while (args[at] === '-c') at += 2; return args[at]; };

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
        throw new Error('secret provider diagnostic with credential material');
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
      if (command === 'git' && subcommand(args) === 'ls-remote') {
        if (args.at(-1) === 'refs/heads/main') return { stdout: `${baseOid}\trefs/heads/main\n` };
        return { stdout: '' };
      }
      if (command === 'git' && subcommand(args) === 'push') return { stdout: '' };
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
    // The port is closed at four methods: no merge, no ruleset, no other effect.
    assert.deepEqual(Object.keys(effects).sort(), ['commit', 'observe', 'openPullRequest', 'push']);
    assert.ok(Object.isFrozen(effects));
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
    const push = commands.find(([command, args]) => command === 'git'
      && subcommand(args) === 'push');
    assert.ok(push[1].includes(`--force-with-lease=refs/heads/${receipt.branch}:`));
    assert.ok(!commands.some(([command, args]) => command === 'gh' && args[1] === 'merge'));
    for (const [, args] of commands.filter(([command]) => command === 'gh')) {
      assert.equal(args[args.indexOf('--repo') + 1], 'github.com/GuitarAlchemist/gaia',
        `gh names its host: ${args.join(' ')}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  });

// One candidate that changes a file, adds one and deletes one, whose origin is a real remote, the
// bound repository's bare stand-in, and beside it one route outside the repository, set through
// the environment or a global Git file, with the repositories and hooks that route would steer the
// publication to. Hooks name the side they run on, and the pre-commit hook also stages a file
// nobody reviewed. Three routes set nothing: the test's runner changes the worktree after the
// review measured the candidate.
function ambientPublication(scratch, route) {
  const fwd = (path) => path.replaceAll('\\', '/');
  const env = { ...process.env };
  const git = (cwd, ...args) => execFileSync('git', args, {
    cwd, env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  const [policy, elsewhere, third] = ['policy.git', 'elsewhere.git', 'third.git']
    .map((name) => join(scratch, name));
  const [repo, worktree, other, hooks, markers] = ['repo', 'worktree', 'other', 'hooks', 'markers']
    .map((name) => join(scratch, name));
  for (const bare of [policy, elsewhere, third]) {
    git(scratch, 'init', '--bare', '--initial-branch=main', bare);
  }
  mkdirSync(repo);
  git(repo, 'init', '--initial-branch=main');
  git(repo, 'config', 'user.name', 'Gaia Test');
  git(repo, 'config', 'user.email', 'gaia@example.invalid');
  writeFileSync(join(repo, 'candidate.txt'), 'before\n', 'utf8');
  writeFileSync(join(repo, 'gone.txt'), 'gone\n', 'utf8');
  git(repo, 'add', 'candidate.txt', 'gone.txt');
  git(repo, 'commit', '-m', 'fixture');
  git(repo, 'tag', '-a', 'follow-me', '-m', 'an annotated tag on the base');
  git(repo, 'remote', 'add', 'origin', fwd(policy));
  git(repo, 'push', '--quiet', 'origin', 'refs/heads/main');
  git(repo, 'push', '--quiet', fwd(elsewhere), 'refs/heads/main');
  git(repo, 'worktree', 'add', '-b', 'candidate', worktree, 'HEAD');
  writeFileSync(join(worktree, 'candidate.txt'), 'after\n', 'utf8');
  writeFileSync(join(worktree, 'added.txt'), 'added\n', 'utf8');
  rmSync(join(worktree, 'gone.txt'));
  mkdirSync(other);
  git(other, 'init', '--initial-branch=main');
  git(other, 'remote', 'add', 'origin', fwd(third));
  mkdirSync(hooks);
  mkdirSync(markers);
  // Not post-index-change: the factory's own `git status` may run it, unpinned (#256).
  for (const name of ['pre-push', 'reference-transaction', 'pre-commit', 'commit-msg',
    'post-commit', 'post-checkout']) {
    const stage = name === 'pre-commit'
      ? 'echo unreviewed > unreviewed.txt && git add unreviewed.txt\n' : '';
    writeFileSync(join(hooks, name),
      `#!/bin/sh\necho ran > "${fwd(markers)}/${name}@$(basename "$(pwd)")"\n${stage}`,
      { mode: 0o755 });
  }
  const globalFile = (text) => {
    writeFileSync(join(scratch, 'global.gitconfig'), text, 'utf8');
    return join(scratch, 'global.gitconfig');
  };
  const overrides = {
    'clean': () => ({}),
    'GIT_DIR': () => ({ GIT_DIR: join(other, '.git') }),
    'pushurl through GIT_CONFIG_COUNT': () => ({ GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GIT_CONFIG_VALUE_0: fwd(elsewhere) }),
    'pushurl through GIT_CONFIG_PARAMETERS': () => ({
      GIT_CONFIG_PARAMETERS: `'remote.origin.pushurl'='${fwd(elsewhere)}'` }),
    'a second pushurl': () => ({ GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'remote.origin.pushurl', GIT_CONFIG_VALUE_0: fwd(policy),
      GIT_CONFIG_KEY_1: 'remote.origin.pushurl', GIT_CONFIG_VALUE_1: fwd(elsewhere) }),
    'pushInsteadOf': () => ({ GIT_CONFIG_GLOBAL: globalFile(
      `[url "${fwd(elsewhere)}"]\n\tpushInsteadOf = ${fwd(policy)}\n`) }),
    'hooksPath': () => ({ GIT_CONFIG_GLOBAL: globalFile(`[core]\n\thooksPath = ${fwd(hooks)}\n`) }),
    'followTags': () => ({ GIT_CONFIG_GLOBAL: globalFile('[push]\n\tfollowTags = true\n') }),
    'excludesFile': () => {
      writeFileSync(join(scratch, 'excludes'), 'added.txt\n', 'utf8');
      return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.excludesFile',
        GIT_CONFIG_VALUE_0: fwd(join(scratch, 'excludes')) };
    },
    'clean filter': () => {
      const attributes = join(scratch, 'attributes');
      writeFileSync(attributes, 'candidate.txt filter=rewrite\n', 'utf8');
      return { GIT_CONFIG_GLOBAL: globalFile(`[core]\n\tattributesFile = ${fwd(attributes)}\n`
        + '[filter "rewrite"]\n\tclean = sed s/after/rewritten/\n') };
    },
    // A monitor hook that names no path. It leaves a marker only when it runs with core.hooksPath
    // on the command line, as the publishing side's Git calls carry it.
    'fsmonitor': () => {
      const hook = join(scratch, 'fsmonitor-hook');
      writeFileSync(hook, '#!/bin/sh\ncase "$GIT_CONFIG_PARAMETERS" in *[Hh]ooks[Pp]ath*)\n'
        + `  echo ran > "${fwd(markers)}/fsmonitor@publishing" ;;\nesac\nprintf 'gaia-token\\0'\n`,
      { mode: 0o755 });
      return { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.fsmonitor',
        GIT_CONFIG_VALUE_0: fwd(hook) };
    },
    // No setting: the test's runner changes the worktree after the review measured the candidate.
    'a file after the review': () => ({}),
    'a deleted file returns after the review': () => ({}),
    'a reviewed file goes after the review': () => ({}),
  }[route]();
  return { git, fwd, policy, elsewhere, third, worktree, markers, overrides };
}

test('the host Git environment can neither redirect nor widen the Git/gh Adapter publication',
  async () => {
  const refused = new Set(['pushurl through GIT_CONFIG_COUNT',
    'pushurl through GIT_CONFIG_PARAMETERS', 'a second pushurl', 'pushInsteadOf']);
  const unfaithful = new Set(['excludesFile', 'clean filter', 'a file after the review',
    'a deleted file returns after the review', 'a reviewed file goes after the review']);
  const routes = ['clean', 'GIT_DIR', ...refused, 'hooksPath', 'fsmonitor', 'followTags',
    ...unfaithful];
  const observed = {};
  const expected = {};
  for (const route of routes) {
    const scratch = mkdtempSync(join(tmpdir(), 'gaia-publication-ambient-'));
    try {
      const {
        git, fwd, policy, elsewhere, third, worktree, markers, overrides,
      } = ambientPublication(scratch, route);
      const baseOid = git(worktree, 'rev-parse', 'HEAD');
      // The review measured the candidate on the same host, under the same environment.
      const changeSetIdentity = await withEnvironment(overrides,
        () => measureAgentFactoryChangeSet(worktree, baseOid).identity);
      const intent = publicationIntent({ headOid: baseOid, baseOid, changeSetIdentity });
      const branch = `refs/heads/gaia/issue-42-${intent.revision.slice(0, 12)}`;
      const commands = [];
      const realExec = promisify(execFile);
      // The worktree changes after the commit step measured the candidate and before `git add`,
      // as any process writing in the worktree between the two could.
      const lateChange = {
        'a file after the review': () => writeFileSync(join(worktree, 'late.txt'), 'late\n', 'utf8'),
        'a deleted file returns after the review': () => writeFileSync(join(worktree, 'gone.txt'),
          'unreviewed\n', 'utf8'),
        'a reviewed file goes after the review': () => rmSync(join(worktree, 'candidate.txt')),
      }[route];
      // Real Git with origin reported in the bound repository's GitHub form, and a fake `gh`
      // answering from the bound repository's state. Nothing reaches a network.
      const run = async (command, args, options) => {
        commands.push([command, [...args]]);
        if (lateChange && command === 'git' && subcommand(args) === 'add') lateChange();
        if (command === 'gh') {
          if (args[1] === 'list') return { stdout: '[]\n' };
          const url = 'https://github.com/GuitarAlchemist/gaia/pull/17';
          if (args[1] === 'create') return { stdout: `${url}\n` };
          const headRefOid = git(policy, 'for-each-ref', '--format=%(objectname)', branch);
          return { stdout: `${JSON.stringify({ number: 17, url, headRefOid })}\n` };
        }
        const result = await realExec(command, args, options);
        const github = 'https://github.com/GuitarAlchemist/gaia.git';
        return subcommand(args) === 'remote'
          ? { stdout: result.stdout.replaceAll(fwd(policy), github) } : result;
      };
      const effects = createGitGhCandidatePublicationEffects({
        expectedRepository: intent.repository, worktree, baseBranch: 'main', run,
      });
      const causes = [];
      const recorded = Object.fromEntries(Object.entries(effects).map(([name, effect]) => [name,
        async (request) => {
          try {
            return await effect(request);
          } catch (error) {
            causes.push(error.code);
            throw error;
          }
        }]));
      const adapter = createGitHubCandidatePublicationAdapter({
        expectedRepository: intent.repository,
        authority: {
          async consume() {
            return {
              status: 'AUTHORIZED', grantId: 'grant-ambient', intentRevision: intent.revision,
            };
          },
        },
        effects: recorded,
      });
      let status;
      try {
        status = (await withEnvironment(overrides,
          () => adapter.publish({ intent, grant: { opaque: 'operator-owned' } }))).status;
      } catch (error) {
        status = error.code;
      }
      const head = git(worktree, 'rev-parse', 'HEAD');
      const at = (oid) => (oid === baseOid ? 'base' : oid === head ? 'candidate commit' : 'other');
      const refs = (dir) => git(dir, 'for-each-ref', '--format=%(refname) %(objectname)')
        .split('\n').filter(Boolean)
        .map((row) => { const [name, oid] = row.split(' '); return `${name} ${at(oid)}`; });
      observed[route] = {
        status, cause: causes[0] ?? null,
        policyRefs: refs(policy), elsewhereRefs: refs(elsewhere), thirdRefs: refs(third),
        committed: git(worktree, 'diff', '--name-only', baseOid, head).split('\n').filter(Boolean),
        publishingHooks: readdirSync(markers).filter((marker) => !marker.endsWith('.git')),
        pushes: commands.filter(([command, args]) => command === 'git'
          && subcommand(args) === 'push').length,
      };
      const untouched = {
        elsewhereRefs: ['refs/heads/main base'], thirdRefs: [], publishingHooks: [],
      };
      const unpublished = { policyRefs: ['refs/heads/main base'], ...untouched, pushes: 0 };
      if (refused.has(route)) {
        expected[route] = { status: 'ObservationFailed', cause: 'RepositoryIdentityMismatch',
          ...unpublished, committed: [] };
      } else if (unfaithful.has(route)) {
        // The local commit misses a reviewed file, holds other bytes, holds a path nobody reviewed
        // or gives a reviewed path another state: nothing leaves the clone.
        expected[route] = { status: 'CommitFailed', cause: 'PublishedTreeMismatch', ...unpublished,
          committed: {
            'excludesFile': ['candidate.txt', 'gone.txt'],
            'clean filter': ['added.txt', 'candidate.txt', 'gone.txt'],
            'a file after the review': ['added.txt', 'candidate.txt', 'gone.txt', 'late.txt'],
            'a deleted file returns after the review': ['added.txt', 'candidate.txt', 'gone.txt'],
            'a reviewed file goes after the review': ['added.txt', 'candidate.txt', 'gone.txt'],
          }[route] };
      } else {
        expected[route] = { status: 'completed', cause: null,
          policyRefs: [`${branch} candidate commit`, 'refs/heads/main base'], ...untouched,
          committed: ['added.txt', 'candidate.txt', 'gone.txt'], pushes: 1 };
      }
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
  assert.deepEqual(observed, expected);
  });
