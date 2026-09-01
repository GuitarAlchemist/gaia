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
