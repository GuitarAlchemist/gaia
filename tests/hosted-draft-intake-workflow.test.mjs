import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const INTAKE_URL = new URL('../.github/workflows/hosted-draft-intake.yml', import.meta.url);
const EFFECT_URL = new URL('../.github/workflows/hosted-draft-pump-effect.yml', import.meta.url);

function readOrNull(url) {
  try {
    return readFileSync(url, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

// Positive control: the same reader resolves the sealed effect workflow, which is present at this
// base. A null intake workflow below is therefore a missing file, not a broken fixture path.
test('positive control: the sealed effect workflow is readable and per-work-key scoped', () => {
  const effect = readOrNull(EFFECT_URL);
  assert.ok(effect, 'the sealed effect workflow must exist at this base');
  assert.match(effect, /^  workflow_dispatch:\s*$/mu);
  assert.match(effect, /gaia-draft-\{0\}/u);
});

function intake() {
  const workflow = readOrNull(INTAKE_URL);
  assert.ok(workflow, '.github/workflows/hosted-draft-intake.yml must exist');
  return workflow;
}

test('intake triggers on issues:labeled and a bounded schedule only', () => {
  const workflow = intake();
  assert.match(workflow, /^on:\s*$/mu);
  assert.match(workflow, /^ {2}issues:\s*$/mu);
  assert.match(workflow, /^ {4}types:\s*\[\s*labeled\s*\]\s*$/mu);
  assert.match(workflow, /^ {2}schedule:\s*$/mu);
  assert.match(workflow, /^ {4}- cron: /mu);

  const crons = [...workflow.matchAll(/^ {4}- cron: /gmu)];
  assert.equal(crons.length, 1, 'the recovery schedule must be bounded to one cron entry');

  assert.doesNotMatch(workflow, /^ {2}(?:push|pull_request|repository_dispatch|workflow_call):/mu);
});

test('only the ready-for-agent label qualifies an issues-triggered run', () => {
  const workflow = intake();
  assert.match(workflow, /ready-for-agent/u);
  assert.match(
    workflow,
    /if:.*github\.event_name != 'issues'.*github\.event\.label\.name == 'ready-for-agent'/su,
  );
});

test('intake partitions labeled issues while scheduled recovery stays serialized', () => {
  const workflow = intake();
  assert.match(workflow, /^concurrency:\s*$/mu);
  assert.match(
    workflow,
    /^ {2}group: \$\{\{ github\.event_name == 'issues' && format\('gaia-draft-intake-issue-\{0\}', github\.event\.issue\.number\) \|\| 'gaia-draft-intake-recovery' \}\}\s*$/mu,
  );
  assert.match(workflow, /^ {2}cancel-in-progress: false\s*$/mu);

  assert.doesNotMatch(
    workflow,
    /^ {2}group: gaia-draft-intake\s*$/mu,
    'unrelated issue runs must not share the old repository-wide group',
  );

  const group = workflow.match(/^ {2}group: (.+)$/mu)?.[1];
  assert.ok(group, 'one concurrency group is required');
  assert.equal(
    [...group.matchAll(/github\.event\.issue\.number/gu)].length,
    1,
    'the issue number is scheduling data exactly once, never effect authority',
  );
  assert.equal(
    [...group.matchAll(/gaia-draft-intake-recovery/gu)].length,
    1,
    'every non-issue trigger converges on one recovery group',
  );
});

test('the ordered pump observation is bound to the serialized recovery lane only', () => {
  const workflow = intake();
  const binding = workflow.match(/^ {10}GAIA_OBSERVATION_PATH: (.+)$/mu)?.[1];
  assert.ok(binding, 'the intake step must bind the observation path through env:');

  // `sequence` is the Actions run id, and run ids are executed in order only within one
  // concurrency group. Since the group above partitions labeled runs per issue, two lanes can
  // finish out of run-id order, and `requireMonotonic` then refuses the later lane's reading as
  // `IncoherentHostedDraftPump` while the pump is making real forward progress. The ordered
  // reading therefore keeps one writer: the single non-cancelling recovery group.
  //
  // The truthy branch is first on purpose. Actions collapses `A && '' || B` to `B` because an
  // empty string is falsy, so an inverted binding would hand every run a path and re-arm exactly
  // the refusal this excludes.
  assert.equal(
    binding,
    "${{ github.event_name != 'issues'"
    + " && format('{0}/gaia-hosted-draft-pump-observation.json', runner.temp) || '' }}",
    'only a run outside every issue lane may be given a path to publish an ordered reading',
  );

  assert.doesNotMatch(
    workflow,
    /--observation-out/u,
    'the binding cannot be a command-line flag: an empty value parses as a flag missing its value',
  );
});

test('intake claims no dispatch authority and no GITHUB_TOKEN authority', () => {
  const workflow = intake();
  assert.match(workflow, /^permissions:\s*$/mu);
  assert.match(workflow, /^ {2}actions: read\s*$/mu);
  assert.match(workflow, /^ {2}contents: read\s*$/mu);

  assert.doesNotMatch(workflow, /actions: write/u);
  assert.doesNotMatch(workflow, /(?:issues|pull-requests|id-token): write/u);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/u);
  assert.doesNotMatch(workflow, /github\.token/u);
  assert.doesNotMatch(workflow, /workflow_dispatch/u);
});

test('intake reuses the existing pump identity and adds no new secret or configuration', () => {
  const workflow = intake();
  for (const name of [
    'vars.GAIA_PUMP_APP_ID',
    'secrets.GAIA_PUMP_APP_PRIVATE_KEY',
    'vars.GAIA_PUMP_ACTOR_ID',
    'vars.GAIA_REPOSITORY_NODE_ID',
  ]) {
    assert.ok(workflow.includes(name), `intake must reuse ${name}`);
  }

  const secrets = new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map(([, n]) => n));
  assert.deepEqual([...secrets], ['GAIA_PUMP_APP_PRIVATE_KEY'], 'no new secret may be introduced');

  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.doesNotMatch(workflow, /docker/iu);
});
