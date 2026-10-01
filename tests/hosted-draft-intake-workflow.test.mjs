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

test('intake triggers on manual dispatch, issues:labeled, and a bounded schedule only', () => {
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
    "${{ github.event_name != 'issues' && !inputs.one_canary"
    + " && format('{0}/gaia-hosted-draft-pump-observation.json', runner.temp) || '' }}",
    'only a run outside every issue lane may be given a path to publish an ordered reading',
  );

  assert.doesNotMatch(
    workflow,
    /--observation-out/u,
    'the binding cannot be a command-line flag: an empty value parses as a flag missing its value',
  );
});

test('manual recovery dispatch claims no write authority and no GITHUB_TOKEN authority', () => {
  const workflow = intake();
  assert.match(workflow, /^ {2}workflow_dispatch:\s*$/mu);
  assert.match(workflow, /^permissions:\s*$/mu);
  assert.match(workflow, /^ {2}actions: read\s*$/mu);
  assert.match(workflow, /^ {2}contents: read\s*$/mu);

  assert.doesNotMatch(workflow, /actions: write/u);
  assert.doesNotMatch(workflow, /(?:issues|pull-requests|id-token): write/u);
  assert.doesNotMatch(workflow, /secrets\.GITHUB_TOKEN/u);
  assert.doesNotMatch(workflow, /github\.token/u);
});

test('intake reuses the pump identity and carries one data-only managed-round configuration', () => {
  const workflow = intake();
  for (const name of [
    'vars.GAIA_PUMP_APP_ID',
    'secrets.GAIA_PUMP_APP_PRIVATE_KEY',
    'vars.GAIA_PUMP_ACTOR_ID',
    'vars.GAIA_REPOSITORY_NODE_ID',
    'vars.GAIA_MANAGED_ROUND_JSON',
  ]) {
    assert.ok(workflow.includes(name), `intake must reuse ${name}`);
  }

  const secrets = new Set([...workflow.matchAll(/secrets\.([A-Z0-9_]+)/gu)].map(([, n]) => n));
  assert.deepEqual([...secrets], ['GAIA_PUMP_APP_PRIVATE_KEY'], 'no new secret may be introduced');

  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /ref: \$\{\{ github\.workflow_sha \}\}/u);
  assert.doesNotMatch(workflow, /docker/iu);
});

test('a re-admission runs alone on a manual dispatch, a dry run unless applied, its reason through env', () => {
  const workflow = intake();
  for (const input of ['readmit_operation', 'readmit_revision', 'readmit_reason']) {
    assert.match(workflow, new RegExp(`^ {6}${input}:\n(?: {8}.+\n)*? {8}type: string\n {8}default: ''$`, 'mu'));
  }
  assert.match(workflow, /^ {6}readmit_apply:\n(?: {8}.+\n)*? {8}type: boolean\n {8}default: false$/mu);
  assert.match(workflow, /throw 'A re-admission runs alone\.'/u);
  assert.match(workflow,
    /^ {10}GAIA_READMIT_APPLY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.readmit_apply \}\}$/mu,
    'the identity gate sees the apply box, so ticking it alone is refused rather than run as intake');
  assert.match(workflow, /-or \$env:GAIA_READMIT_APPLY -eq 'true'\) \{/u);

  const step = workflow.match(/^ {6}- name: Re-admit one effect-free refusal\n([\s\S]*?)(?=^ {6}- )/mu)?.[1];
  assert.ok(step, 'one re-admission step');
  assert.match(step, /^ {8}if: steps\.identity\.outputs\.readmit == 'true'$/mu);
  assert.match(step, /hosted-draft-pump\.mjs readmit/u);
  const run = step.slice(step.indexOf('run: |'));
  assert.doesNotMatch(run, /\$\{\{/u, 'dispatch inputs reach the CLI through env:, never the script');
  assert.doesNotMatch(step, /GAIA_OBSERVATION_PATH|GAIA_MANAGED_ROUND_JSON|GAIA_NORMAL_POLICY|GAIA_CANARY_POLICY/u);
  assert.match(run, /-cnotin @\('ReadmissionPlanned', 'Readmitted', 'AlreadyReadmitted'\)/u,
    'a refused re-admission fails the run; its receipt is still uploaded');

  assert.match(workflow, /^ {8}if: steps\.identity\.outputs\.readmit != 'true' && steps\.identity\.outputs\.settle != 'true' && \(github\.event_name != 'workflow_dispatch' \|\| !inputs\.prepare_issue\)$/mu,
    'a re-admission run admits nothing');
});

test('a settlement runs alone on a manual dispatch, a dry run unless applied, its reason through env', () => {
  const workflow = intake();
  for (const input of ['settle_operation', 'settle_revision', 'settle_reason']) {
    assert.match(workflow, new RegExp(`^ {6}${input}:\n(?: {8}.+\n)*? {8}type: string\n {8}default: ''$`, 'mu'));
  }
  assert.match(workflow, /^ {6}settle_apply:\n(?: {8}.+\n)*? {8}type: boolean\n {8}default: false$/mu);
  assert.match(workflow, /-or \$target -or \$readmit\) \{\n {14}throw 'A settlement runs alone\.'/u,
    'a settlement runs beside nothing, a re-admission included');
  assert.match(workflow,
    /^ {10}GAIA_SETTLE_APPLY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.settle_apply \}\}$/mu,
    'the identity gate sees the apply box, so ticking it alone is refused rather than run as intake');
  assert.match(workflow, /-or \$env:GAIA_SETTLE_APPLY -eq 'true'\) \{/u);

  const step = workflow.match(/^ {6}- name: Settle one ambiguous Draft operation\n([\s\S]*?)(?=^ {6}- )/mu)?.[1];
  assert.ok(step, 'one settlement step');
  assert.match(step, /^ {8}if: steps\.identity\.outputs\.settle == 'true'$/mu);
  assert.match(step, /hosted-draft-pump\.mjs settle/u);
  assert.match(step, /^ {10}GAIA_REPOSITORY_NODE_ID: \$\{\{ vars\.GAIA_REPOSITORY_NODE_ID \}\}$/mu,
    'the marker search is checked against the configured repository identity');
  const run = step.slice(step.indexOf('run: |'));
  assert.doesNotMatch(run, /\$\{\{/u, 'dispatch inputs reach the CLI through env:, never the script');
  assert.doesNotMatch(step,
    /GAIA_OBSERVATION_PATH|GAIA_MANAGED_ROUND_JSON|GAIA_NORMAL_POLICY|GAIA_CANARY_POLICY|GAIA_READMIT/u);
  assert.match(run, /-cnotin @\('AbandonmentPlanned', 'Abandoned', 'AlreadyAbandoned'\)/u,
    'a settlement that was not made fails the run; its receipt is still uploaded');

  // A settlement waits out the executor's credential, not its process: the step that runs the CLI,
  // in either workflow, holds the installation token its attempt minted and never the App key that
  // could mint another.
  for (const [name, text] of [['intake', workflow], ['effect', readOrNull(EFFECT_URL)]]) {
    const cliSteps = text.split(/^ {6}- (?=name:|uses:)/mu).slice(1)
      .filter((each) => each.includes('scripts/hosted-draft-pump.mjs'));
    assert.ok(cliSteps.length > 0, `${name}: the CLI runs in a step`);
    for (const each of cliSteps) {
      assert.doesNotMatch(each, /PRIVATE_KEY|private-key/u, `${name}: no App key beside the CLI`);
      assert.match(each, /GH_TOKEN: \$\{\{ steps\.pump-token\.outputs\.token \}\}/u, name);
    }
  }

  // GitHub accepts at most 25 dispatch inputs; the operator paths must leave room below it.
  const inputs = workflow.slice(workflow.indexOf('    inputs:\n'), workflow.indexOf('  issues:\n'));
  assert.ok(inputs.match(/^ {6}[a-z_]+:$/gmu).length <= 25, 'within the workflow_dispatch input limit');
});
