import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostedDraftCollector } from '../src/hosted-draft-collector.mjs';
import {
  createGhEvidenceHeadWriter,
  evidenceBranchName,
  evidenceCommitMessage,
  seedEvidenceHead,
} from '../src/evidence-head-seeder.mjs';

// The same label event as tests/hosted-draft-collector.test.mjs, whose collector fixture already
// pins the receipt below. Matching it proves the seeder derives the collector's own revision.
const RECEIPT = '797eabd4b579944ec4634babd5c018815481b0c8bf0170d90cdaf90353f8e494';
const BASE = 'a'.repeat(40);
const TREE = 'd'.repeat(40);
const SELECTOR = Object.freeze({
  repository: Object.freeze({ owner: 'GuitarAlchemist', name: 'gaia' }),
  workItem: Object.freeze({ kind: 'ISSUE', number: 60 }),
});

function fakeGitHub({ permission = 'TRIAGE', labels = ['ready-for-agent'], state = 'OPEN' } = {}) {
  const refs = new Map([['main', BASE]]);
  const commits = new Map([[BASE, 'chore: base']]);
  let counter = 0;
  const writes = [];
  const github = {
    async resolveRepository() {
      return {
        nodeId: 'R_kgDTest', owner: 'GuitarAlchemist', name: 'gaia',
        defaultBranch: 'main', defaultBranchRevision: refs.get('main'),
      };
    },
    async readIssue() {
      return {
        nodeId: 'I_test60', number: 60, state,
        updatedAt: '2026-08-31T19:05:00.000Z', labels,
        labelEvents: [
          {
            nodeId: 'LE_old', label: 'ready-for-agent', createdAt: '2026-08-31T18:00:00.000Z',
            actor: { nodeId: 'U_old', login: 'older-actor' },
          },
          {
            nodeId: 'LE_latest', label: 'ready-for-agent', createdAt: '2026-08-31T19:00:00.000Z',
            actor: { nodeId: 'U_actor', login: 'trusted-actor' },
          },
        ],
      };
    },
    async readPermission() { return permission; },
    async listHeadRefs() {
      return [...refs].map(([name, revision]) => ({ name, revision }));
    },
    async readCommit({ revision }) { return { message: commits.get(revision) ?? '' }; },
    async readPolicy() { return { revision: 'c'.repeat(40) }; },
  };
  const writer = {
    async readCommitTree({ revision }) {
      writes.push(['readCommitTree', revision]);
      return TREE;
    },
    async createCommit({ tree, parents, message }) {
      counter += 1;
      const sha = counter.toString(16).padStart(40, 'e');
      writes.push(['createCommit', tree, parents]);
      commits.set(sha, message);
      return sha;
    },
    async createRef({ name, revision }) {
      writes.push(['createRef', name, revision]);
      if (refs.has(name)) throw new Error('Reference already exists');
      refs.set(name, revision);
    },
  };
  return { github, writer, refs, commits, writes };
}

test('a seeded evidence head is the unique source the real collector admits', async () => {
  const world = fakeGitHub();
  const seeded = await seedEvidenceHead({ ...world, selector: SELECTOR, apply: true });
  assert.equal(seeded.status, 'CREATED');
  assert.equal(seeded.queueReceiptRevision, RECEIPT);
  assert.equal(seeded.branch, 'gaia/issue-60-ready-2');
  const envelope = await createHostedDraftCollector({ github: world.github }).collect(SELECTOR);
  assert.equal(envelope.generation.headRef, 'gaia/issue-60-ready-2');
  assert.equal(envelope.generation.headRevision, seeded.headRevision);
  assert.equal(envelope.readyItem.queueReceiptRevision, RECEIPT);
});

test('the seeded commit changes no file: it reuses the base tree and parents the base', async () => {
  const world = fakeGitHub();
  await seedEvidenceHead({ ...world, selector: SELECTOR, apply: true });
  assert.deepEqual(world.writes[0], ['readCommitTree', BASE]);
  assert.deepEqual(world.writes[1], ['createCommit', TREE, [BASE]]);
});

test('the dry run plans the branch and message and writes nothing', async () => {
  const world = fakeGitHub();
  const planned = await seedEvidenceHead({ github: world.github, selector: SELECTOR });
  assert.equal(planned.status, 'PLANNED');
  assert.equal(planned.message, evidenceCommitMessage(60, RECEIPT));
  assert.deepEqual(world.writes, []);
  assert.deepEqual([...world.refs.keys()], ['main']);
});

test('seeding is idempotent: a second run reports the existing head and writes nothing', async () => {
  const world = fakeGitHub();
  const first = await seedEvidenceHead({ ...world, selector: SELECTOR, apply: true });
  const writes = world.writes.length;
  const second = await seedEvidenceHead({ ...world, selector: SELECTOR, apply: true });
  assert.equal(second.status, 'PRESENT');
  assert.equal(second.headRevision, first.headRevision);
  assert.equal(world.writes.length, writes);
});

test('two heads for one receipt refuse without writing, as the collector would', async () => {
  const world = fakeGitHub();
  const message = evidenceCommitMessage(60, RECEIPT);
  world.commits.set('1'.repeat(40), message);
  world.commits.set('2'.repeat(40), message);
  world.refs.set('codex/one', '1'.repeat(40));
  world.refs.set('codex/two', '2'.repeat(40));
  const refused = await seedEvidenceHead({ ...world, selector: SELECTOR, apply: true });
  assert.equal(refused.status, 'REFUSED');
  assert.equal(refused.reason, 'HeadIdentityAmbiguous');
  assert.deepEqual(world.writes, []);
});

test('the seeder never labels: an unlabelled, closed or untrusted issue refuses', async () => {
  for (const [options, reason] of [
    [{ labels: [] }, 'IssueNotReady'],
    [{ state: 'CLOSED' }, 'IssueObservationInvalid'],
    [{ permission: 'READ' }, 'ReadyActorUnauthorized'],
  ]) {
    const world = fakeGitHub(options);
    const refused = await seedEvidenceHead({ ...world, selector: SELECTOR, apply: true });
    assert.equal(refused.status, 'REFUSED', reason);
    assert.equal(refused.reason, reason);
    assert.deepEqual(world.writes, []);
  }
});

test('a branch name already taken by another commit refuses before any write', async () => {
  const world = fakeGitHub();
  world.commits.set('3'.repeat(40), 'unrelated');
  world.refs.set(evidenceBranchName(60, 2), '3'.repeat(40));
  const refused = await seedEvidenceHead({ ...world, selector: SELECTOR, apply: true });
  assert.equal(refused.reason, 'BranchNameTaken');
  assert.deepEqual(world.writes, []);
});

test('the read-back decides: a failed ref write is FAILED, a divergent one AMBIGUOUS', async () => {
  const failing = fakeGitHub();
  failing.writer.createRef = async () => { throw new Error('network'); };
  const failed = await seedEvidenceHead({ ...failing, selector: SELECTOR, apply: true });
  assert.equal(failed.status, 'FAILED');

  const racing = fakeGitHub();
  const create = racing.writer.createRef;
  racing.writer.createRef = async (request) => {
    await create(request);
    const message = evidenceCommitMessage(60, RECEIPT);
    racing.commits.set('4'.repeat(40), message);
    racing.refs.set('codex/concurrent', '4'.repeat(40));
  };
  const ambiguous = await seedEvidenceHead({ ...racing, selector: SELECTOR, apply: true });
  assert.equal(ambiguous.status, 'AMBIGUOUS');
});

test('the gh writer issues the three Git Data calls with the exact trailers', async () => {
  const calls = [];
  const writer = createGhEvidenceHeadWriter({
    async run(args) {
      calls.push(args);
      return args.includes('POST') ? { sha: 'f'.repeat(40) } : { tree: { sha: TREE } };
    },
  });
  const repository = { owner: 'GuitarAlchemist', name: 'gaia' };
  assert.equal(await writer.readCommitTree({ repository, revision: BASE }), TREE);
  await writer.createCommit({
    repository, tree: TREE, parents: [BASE], message: evidenceCommitMessage(60, RECEIPT),
  });
  await writer.createRef({ repository, name: 'gaia/issue-60-ready-2', revision: 'f'.repeat(40) });
  assert.ok(calls[1].includes(`message=${evidenceCommitMessage(60, RECEIPT)}`));
  assert.ok(calls[1].includes(`parents[]=${BASE}`));
  assert.ok(calls[2].includes('ref=refs/heads/gaia/issue-60-ready-2'));
});
