import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(
  new URL('../.github/workflows/hosted-draft-pump-effect.yml', import.meta.url),
  'utf8',
);

const INPUTS = [
  'issue-number',
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

test('the effect executor exposes only closed manual and reusable workflow inputs', () => {
  assert.match(workflow, /^on:\s*$/mu);
  assert.match(workflow, /^  workflow_dispatch:\s*$/mu);
  assert.match(workflow, /^  workflow_call:\s*$/mu);
  assert.doesNotMatch(workflow, /^  (?:schedule|push|pull_request|issues|repository_dispatch):/mu);

  for (const input of INPUTS) {
    assert.equal(
      occurrences(workflow, `        ${input}:`),
      2,
      `${input} must be declared once for dispatch and once for workflow_call`,
    );
  }
  assert.equal(occurrences(workflow, '        concurrency-group:'), 0);
  assert.equal(occurrences(workflow, '        pump-actor-id:'), 0);
});

test('one work key owns the exact non-cancelling Actions concurrency group', () => {
  assert.match(
    workflow,
    new RegExp(`^concurrency:\\r?\\n  group: ${GROUP_EXPRESSION.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\r?\\n  cancel-in-progress: false$`, 'mu'),
  );
  assert.equal(
    occurrences(workflow, GROUP_EXPRESSION),
    2,
    'the concurrency group and trusted adapter environment must use one expression',
  );
  assert.match(
    workflow,
    /^\s+GAIA_VERIFIED_CONCURRENCY_GROUP: \$\{\{ format\('gaia-draft-\{0\}', inputs\['work-key'\]\) \}\}$/mu,
  );
});

test('the job uses only the required GitHub permissions and a dedicated pump App token', () => {
  assert.match(
    workflow,
    /^permissions:\r?\n  actions: read\r?\n  contents: write\r?\n  pull-requests: write$/mu,
  );
  assert.match(workflow, /uses: actions\/create-github-app-token@v\d+/u);
  assert.match(workflow, /app-id: \$\{\{ vars\.GAIA_PUMP_APP_ID \}\}/u);
  assert.match(workflow, /private-key: \$\{\{ secrets\.GAIA_PUMP_APP_PRIVATE_KEY \}\}/u);
  assert.match(workflow, /GAIA_PUMP_ACTOR_ID: \$\{\{ vars\.GAIA_PUMP_ACTOR_ID \}\}/u);
  assert.match(workflow, /GAIA_REPOSITORY_NODE_ID: \$\{\{ vars\.GAIA_REPOSITORY_NODE_ID \}\}/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.pump-token\.outputs\.token \}\}/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.doesNotMatch(workflow, /(?:secrets\.GITHUB_TOKEN|github\.token)/u);
});

test('the executor reconciles once and uploads its closed receipt', () => {
  assert.match(workflow, /node scripts\/hosted-draft-pump\.mjs reconcile/u);
  for (const argument of [
    '--issue-number',
    '--work-key',
    '--operation-id',
    '--committed-revision',
    '--ledger-root-oid',
    '--ledger-root-revision',
    '--receipt-path',
  ]) {
    assert.equal(occurrences(workflow, argument), 1, `${argument} must be supplied exactly once`);
  }
  assert.match(workflow, /uses: actions\/upload-artifact@v\d+/u);
  assert.match(workflow, /name: gaia-hosted-draft-pump-receipt/u);
  assert.match(workflow, /path: \$\{\{ runner\.temp \}\}\/gaia-hosted-draft-pump-receipt\.json/u);
  assert.match(workflow, /if-no-files-found: error/u);
  assert.doesNotMatch(workflow, /docker/iu);
});
