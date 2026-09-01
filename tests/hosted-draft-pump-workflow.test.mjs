import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { main } from '../scripts/hosted-draft-pump.mjs';

const workflow = readFileSync(
  new URL('../.github/workflows/hosted-draft-pump-effect.yml', import.meta.url),
  'utf8',
);

const INPUTS = [
  'work-key',
  'operation-id',
  'committed-revision',
  'ledger-root-oid',
  'ledger-root-revision',
];
const GROUP_EXPRESSION = "${{ format('gaia-draft-{0}', inputs['work-key']) }}";

function occurrences(text, fragment) {
  return text.split(fragment).length - 1;
}

function flagOccurrences(text, flag) {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return [...text.matchAll(new RegExp(`${escaped}(?=\\s)`, 'gu'))].length;
}

test('the effect executor exposes only closed manual workflow inputs', () => {
  assert.match(workflow, /^on:\s*$/mu);
  assert.match(workflow, /^  workflow_dispatch:\s*$/mu);
  assert.doesNotMatch(workflow, /^  workflow_call:\s*$/mu);
  assert.doesNotMatch(workflow, /^  (?:schedule|push|pull_request|issues|repository_dispatch):/mu);

  for (const input of INPUTS) {
    assert.equal(
      occurrences(workflow, `      ${input}:`),
      1,
      `${input} must be declared once for dispatch`,
    );
  }
  assert.equal(occurrences(workflow, '      concurrency-group:'), 0);
  assert.equal(occurrences(workflow, '      pump-actor-id:'), 0);
});

test('one work key owns the exact non-cancelling Actions concurrency group', () => {
  assert.match(
    workflow,
    new RegExp(`^concurrency:\\r?\\n  group: ${GROUP_EXPRESSION.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\r?\\n  cancel-in-progress: false$`, 'mu'),
  );
  assert.equal(
    occurrences(workflow, GROUP_EXPRESSION),
    1,
    'the workflow declaration is the only concurrency-group authority',
  );
  assert.doesNotMatch(workflow, /GAIA_VERIFIED_CONCURRENCY_GROUP/u);
});

test('the job uses only the required GitHub permissions and a dedicated pump App token', () => {
  assert.match(
    workflow,
    /^permissions:\r?\n  actions: read\r?\n  contents: read$/mu,
  );
  assert.match(workflow, /uses: actions\/create-github-app-token@v\d+/u);
  assert.match(workflow, /app-id: \$\{\{ vars\.GAIA_PUMP_APP_ID \}\}/u);
  assert.match(workflow, /private-key: \$\{\{ secrets\.GAIA_PUMP_APP_PRIVATE_KEY \}\}/u);
  assert.match(workflow, /GAIA_PUMP_ACTOR_ID: \$\{\{ vars\.GAIA_PUMP_ACTOR_ID \}\}/u);
  assert.match(workflow, /GAIA_REPOSITORY_NODE_ID: \$\{\{ vars\.GAIA_REPOSITORY_NODE_ID \}\}/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.pump-token\.outputs\.token \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.doesNotMatch(workflow, /(?:secrets\.GITHUB_TOKEN|github\.token)/u);
});

test('the executor reconciles once and uploads its closed receipt', () => {
  assert.match(workflow, /node scripts\/hosted-draft-pump\.mjs reconcile/u);
  for (const argument of [
    '--repository',
    '--pump-actor-id',
    '--repository-node-id',
    '--work-key',
    '--operation-id',
    '--expected-revision',
    '--ledger-root-oid',
    '--ledger-root-revision',
  ]) {
    assert.equal(flagOccurrences(workflow, argument), 1,
      `${argument} must be supplied exactly once`);
  }
  assert.doesNotMatch(workflow, /--(?:issue-number|committed-revision|receipt-path)/u);
  assert.doesNotMatch(workflow, /issue-number|GAIA_DRAFT_TITLE|GAIA_ISSUE_URL/u);
  assert.match(workflow, /GAIA_DRAFT_OWNER: Gaia hosted Draft pump/u);
  assert.match(workflow, /GAIA_DRAFT_GATE: DELIVERY/u);
  assert.match(workflow, /GAIA_CHECKLIST_JSON: '\["Create or reuse one exact Draft pull request","Persist one terminal receipt"\]'/u);
  assert.match(workflow, /GAIA_ETA_MINUTES: '60:120'/u);
  assert.match(workflow, /1> \$env:GAIA_RECEIPT_PATH 2> \$env:GAIA_ERROR_PATH/u);
  assert.match(workflow, /Move-Item -LiteralPath \$env:GAIA_ERROR_PATH -Destination \$env:GAIA_RECEIPT_PATH -Force/u);
  assert.match(workflow, /uses: actions\/upload-artifact@v\d+/u);
  assert.match(workflow, /name: gaia-hosted-draft-pump-receipt/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/gaia-hosted-draft-pump-receipt\.json/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.doesNotMatch(workflow, /docker/iu);
});

test('the workflow argv and deterministic environment satisfy the real CLI parser', async () => {
  const sha = (letter) => letter.repeat(64);
  const rootOid = 'd'.repeat(40);
  const argv = [
    'reconcile',
    '--repository', 'GuitarAlchemist/gaia',
    '--pump-actor-id', '1234',
    '--repository-node-id', 'R_kgDOGaia',
    '--work-key', sha('a'),
    '--operation-id', sha('b'),
    '--expected-revision', sha('c'),
    '--ledger-root-oid', rootOid,
    '--ledger-root-revision', sha('e'),
  ];
  const environment = {
    GITHUB_REPOSITORY: 'GuitarAlchemist/gaia',
    GITHUB_RUN_ID: '9001',
    GITHUB_RUN_ATTEMPT: '2',
    GAIA_DRAFT_OWNER: 'Gaia hosted Draft pump',
    GAIA_DRAFT_GATE: 'DELIVERY',
    GAIA_CHECKLIST_JSON:
      '["Create or reuse one exact Draft pull request","Persist one terminal receipt"]',
    GAIA_ETA_MINUTES: '60:120',
  };
  let parsed;
  let output = '';
  const exitCode = await main({
    argv,
    env: environment,
    stdout: { write(chunk) { output += String(chunk); } },
    stderr: { write() {} },
    runtimeFactory(configuration) {
      parsed = configuration;
      return Object.freeze({
        async enqueue() { assert.fail('the effect workflow cannot enqueue'); },
        async listUnsettled() { assert.fail('the effect workflow cannot select'); },
        async reconcile() {
          return {
            kind: 'Terminal', outcome: 'REUSED', effect: 'NONE',
            operationId: sha('b'), committedRevision: sha('f'),
          };
        },
      });
    },
  });

  assert.equal(exitCode, 0, output);
  assert.equal(parsed.expectedRevision, sha('c'));
  assert.deepEqual(parsed.presentation, {
    owner: 'Gaia hosted Draft pump',
    gate: 'DELIVERY',
    checklist: [
      'Create or reuse one exact Draft pull request',
      'Persist one terminal receipt',
    ],
    eta: { minimumMinutes: 60, maximumMinutes: 120 },
  });
});
