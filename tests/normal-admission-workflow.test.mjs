/**
 * PR125: the opt-in normal admission connection through `.github/workflows/hosted-draft-intake.yml`.
 *
 * The identity-check step's `run: |` body is extracted verbatim from the shipped workflow and
 * executed under real `pwsh`, with the GitHub-expression-resolved env values it would actually
 * receive supplied directly. That exercises the true gating logic (conflict refusal, which
 * credentials are required, and the published `normal_policy` selection) rather than a copy of it.
 * Static regex assertions cover what only exists as a workflow expression (event/vars scoping,
 * literal path selection) and the byte-for-byte preservation of expressions this change must not
 * touch (canary selection, observation ordering).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { validateNormalAdmissionPolicy } from '../src/normal-admission-policy.mjs';

const INTAKE_URL = new URL('../.github/workflows/hosted-draft-intake.yml', import.meta.url);

function workflowText() {
  return readFileSync(INTAKE_URL, 'utf8');
}

/** The lines of one named step, found by its `- name:` line, up to the next 6-space step start. */
function stepBlock(workflow, stepName) {
  const lines = workflow.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.trim() === `- name: ${stepName}`);
  assert.notEqual(start, -1, `step "${stepName}" must exist`);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^ {6}- /u.test(lines[index])) { end = index; break; }
  }
  return lines.slice(start, end);
}

/** The literal `run: |` body of a step, dedented by the block's own indentation. */
function runBody(block) {
  const at = block.findIndex((line) => /^ {8}run: \|\s*$/u.test(line));
  assert.notEqual(at, -1, 'the step must carry a literal run: block');
  const body = [];
  for (const line of block.slice(at + 1)) {
    if (/^\s*$/u.test(line)) { body.push(''); continue; }
    if (!/^ {10}/u.test(line)) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

const PWSH = { skip: process.platform !== 'win32' && 'the identity gate is a pwsh script' };

/** Runs a pwsh script body with exactly the given env (plus what pwsh itself needs), and reads
 * back whatever it appended to GITHUB_OUTPUT. */
function runIdentityScript(scriptBody, env) {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-normal-admission-'));
  try {
    const scriptPath = join(scratch, 'identity.ps1');
    const outputPath = join(scratch, 'output.txt');
    writeFileSync(scriptPath, scriptBody, 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
      encoding: 'utf8',
      timeout: 30000,
      env: { ...process.env,
        GAIA_PUMP_APP_ID: '', GAIA_PUMP_APP_PRIVATE_KEY: '', GAIA_PUMP_ACTOR_ID: '',
        GAIA_REPOSITORY_NODE_ID: '', GAIA_MANAGED_ROUND_JSON: '', GAIA_ONE_CANARY: '',
        GAIA_PREPARE_ISSUE: '', GAIA_NORMAL_POLICY_DISPATCH: '', GAIA_NORMAL_POLICY_VAR: '',
        GAIA_TARGET_ISSUE: '',
        GITHUB_OUTPUT: outputPath, ...env },
    });
    let outputs = {};
    try {
      outputs = Object.fromEntries(
        readFileSync(outputPath, 'utf8').split(/\r?\n/u).filter(Boolean)
          .map((line) => line.split('=')),
      );
    } catch { /* no output file: treated as no outputs below */ }
    return { status: result.status, stderr: result.stderr, outputs };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const REQUIRED_IDENTITY = Object.freeze({
  GAIA_PUMP_APP_ID: '424242',
  GAIA_PUMP_APP_PRIVATE_KEY: 'fixture-private-key',
  GAIA_PUMP_ACTOR_ID: '1234',
  GAIA_REPOSITORY_NODE_ID: 'R_kgDOGaia',
});

function identityScript() {
  return runBody(stepBlock(workflowText(), 'Require the dedicated pump identity'));
}

// Positive control: the real step's body is found, extracted, and runs to completion with every
// credential present and nothing selected. A failure below is the mechanism, not a broken fixture.
test('positive control: the identity step body is extracted and runs clean on the legacy path', PWSH, () => {
  const { status, stderr, outputs } = runIdentityScript(identityScript(), {
    ...REQUIRED_IDENTITY,
    GAIA_MANAGED_ROUND_JSON: '{"fixture":true}',
  });
  assert.equal(status, 0, stderr);
  assert.equal(outputs.normal_policy, 'false');
});

test('legacy effect intake still requires GAIA_MANAGED_ROUND_JSON', PWSH, () => {
  const { status } = runIdentityScript(identityScript(), { ...REQUIRED_IDENTITY });
  assert.notEqual(status, 0, 'the legacy path must fail closed without managed-round data');
});

test('an explicit workflow_dispatch normal selection is admitted without managed-round data', PWSH, () => {
  const { status, stderr, outputs } = runIdentityScript(identityScript(), {
    ...REQUIRED_IDENTITY,
    GAIA_NORMAL_POLICY_DISPATCH: 'true',
  });
  assert.equal(status, 0, stderr);
  assert.equal(outputs.normal_policy, 'true');
});

test('a scheduled/labeled run selects normal only through the vars-gated flag, also without managed-round data', PWSH, () => {
  const { status, stderr, outputs } = runIdentityScript(identityScript(), {
    ...REQUIRED_IDENTITY,
    GAIA_NORMAL_POLICY_VAR: 'true',
  });
  assert.equal(status, 0, stderr);
  assert.equal(outputs.normal_policy, 'true');
});

test('normal_policy is not selected when the dispatch input is simply absent (default false)', PWSH, () => {
  const { status, stderr, outputs } = runIdentityScript(identityScript(), {
    ...REQUIRED_IDENTITY,
    GAIA_MANAGED_ROUND_JSON: '{"fixture":true}',
    GAIA_NORMAL_POLICY_DISPATCH: 'false',
    GAIA_NORMAL_POLICY_VAR: 'false',
  });
  assert.equal(status, 0, stderr);
  assert.equal(outputs.normal_policy, 'false');
});

test('explicit one_canary and normal_policy dispatch together are refused before any credential check', PWSH, () => {
  const { status } = runIdentityScript(identityScript(), {
    ...REQUIRED_IDENTITY,
    GAIA_ONE_CANARY: 'true',
    GAIA_NORMAL_POLICY_DISPATCH: 'true',
  });
  assert.notEqual(status, 0, 'canary and normal must not silently combine');
});

test('prepare_issue and normal admission together are refused, keeping preparation unambiguous', PWSH, () => {
  const { status } = runIdentityScript(identityScript(), {
    ...REQUIRED_IDENTITY,
    GAIA_PREPARE_ISSUE: '5',
    GAIA_NORMAL_POLICY_DISPATCH: 'true',
  });
  assert.notEqual(status, 0, 'preparation must stay effect-free and unambiguous');
});

test('normal selection does not relax any of the four core identity credentials', PWSH, () => {
  for (const missing of Object.keys(REQUIRED_IDENTITY)) {
    const env = { ...REQUIRED_IDENTITY, GAIA_NORMAL_POLICY_DISPATCH: 'true' };
    delete env[missing];
    const { status } = runIdentityScript(identityScript(), env);
    assert.notEqual(status, 0, `${missing} must still be required when normal admission is selected`);
  }
});

// Revert control: with the publication line removed, the script still exits clean (nothing else
// depends on it), but the downstream `steps.identity.outputs.normal_policy` read the workflow relies
// on would see nothing at all — proving the emission line, not just the boolean it computes, is load
// bearing for every step after this one.
test('revert control: removing the GITHUB_OUTPUT publication silently loses the selection downstream', PWSH, () => {
  const withoutPublication = identityScript().replace(
    /^"normal_policy=.*$/mu, '',
  );
  assert.notEqual(withoutPublication, identityScript(), 'the mutation must actually remove the line');
  const { status, stderr, outputs } = runIdentityScript(withoutPublication, {
    ...REQUIRED_IDENTITY,
    GAIA_NORMAL_POLICY_DISPATCH: 'true',
  });
  assert.equal(status, 0, stderr);
  assert.equal(
    outputs.normal_policy, undefined,
    'without the emission, a downstream `steps.identity.outputs.normal_policy` read resolves to nothing',
  );
});

test('the manual normal_policy input is declared boolean, opt-in, off by default', () => {
  const workflow = workflowText();
  assert.match(
    workflow,
    /normal_policy:\s*\n\s+description:.*\n\s+type: boolean\s*\n\s+default: false/u,
  );
});

test('the identity step publishes its selection through an id every later step can bind to', () => {
  const block = stepBlock(workflowText(), 'Require the dedicated pump identity');
  assert.ok(
    block.some((line) => /^ {8}id: identity\s*$/u.test(line)),
    'the identity step must carry a stable id',
  );
});

test('normal selection is scoped by event exactly, never by simple truthiness', () => {
  const workflow = workflowText();
  assert.match(
    workflow,
    /GAIA_NORMAL_POLICY_DISPATCH: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.normal_policy \}\}/u,
  );
  assert.match(
    workflow,
    /GAIA_NORMAL_POLICY_VAR: \$\{\{ github\.event_name != 'workflow_dispatch' && vars\.GAIA_NORMAL_POLICY_ENABLED == 'true' \}\}/u,
  );
});

test('the bound normal policy path is the one sealed literal, never a caller-supplied value', () => {
  const workflow = workflowText();
  assert.match(
    workflow,
    /GAIA_NORMAL_POLICY: \$\{\{ steps\.identity\.outputs\.normal_policy == 'true' && '\.github\/gaia\/normal-policy\.json' \|\| '' \}\}/u,
  );
  assert.doesNotMatch(
    workflow,
    /normal[-_]policy[-_]?path/iu,
    'no input or variable may name an arbitrary policy path',
  );
});

test('canary selection and observation ordering are byte-for-byte unchanged by this change', () => {
  const workflow = workflowText();
  assert.match(
    workflow,
    /GAIA_CANARY_POLICY: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.one_canary && '\.github\/gaia\/canary-policy\.json' \|\| '' \}\}/u,
  );
  assert.match(
    workflow,
    /GAIA_OBSERVATION_PATH: \$\{\{ github\.event_name != 'issues' && !inputs\.one_canary && format\('\{0\}\/gaia-hosted-draft-pump-observation\.json', runner\.temp\) \|\| '' \}\}/u,
  );
});

test('GAIA_MANAGED_ROUND_JSON remains bound exactly once in the resume/admit step', () => {
  const block = stepBlock(workflowText(), 'Resume or admit exactly one Draft operation');
  const bindings = block.filter((line) => /^ {10}GAIA_MANAGED_ROUND_JSON: /u.test(line));
  assert.equal(bindings.length, 1);
  assert.match(bindings[0], /\$\{\{ vars\.GAIA_MANAGED_ROUND_JSON \}\}/u);
});

/**
 * The committed `.github/gaia/normal-policy.json` pins identity, not time: a static
 * validFrom/validUntil could not outlive the gap between scheduled runs (max 1h window,
 * every-6h cron). This exercises the real "Freshen the normal-admission policy window"
 * step body under pwsh against a copy of a stale policy file, the same mechanism the
 * PWSH tests above use for the identity step.
 */
function windowScript() {
  return runBody(stepBlock(workflowText(), 'Freshen the normal-admission policy window'));
}

function runWindowScript(policy) {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-normal-window-'));
  try {
    mkdirSync(join(scratch, '.github', 'gaia'), { recursive: true });
    const policyPath = join(scratch, '.github', 'gaia', 'normal-policy.json');
    writeFileSync(policyPath, JSON.stringify(policy));
    const scriptPath = join(scratch, 'freshen.ps1');
    writeFileSync(scriptPath, windowScript(), 'utf8');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', scriptPath], {
      cwd: scratch, encoding: 'utf8', timeout: 30000,
    });
    return {
      status: result.status, stderr: result.stderr,
      policy: JSON.parse(readFileSync(policyPath, 'utf8')),
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const STALE_NORMAL_POLICY = Object.freeze({
  schema: 'GaiaNormalAdmissionPolicyV0', version: 1,
  repository: { nodeId: 'R_test', owner: 'test-org', name: 'test-repo' },
  effectActorId: 123,
  validFrom: '2020-01-01T00:00:00.000Z', validUntil: '2020-01-01T01:00:00.000Z',
  accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
  reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
  allowedEffect: 'CREATE_DRAFT', roundBudget: 1,
});

test('the window step re-anchors validFrom/validUntil to the run instant, leaving identity untouched', PWSH, () => {
  const before = Date.now();
  const { status, stderr, policy } = runWindowScript(STALE_NORMAL_POLICY);
  const after = Date.now();
  assert.equal(status, 0, stderr);
  const from = Date.parse(policy.validFrom);
  const until = Date.parse(policy.validUntil);
  assert.ok(from >= before - 5000 && from <= after + 5000,
    `validFrom must be re-anchored to the run instant, got ${policy.validFrom}`);
  assert.equal(until - from, 15 * 60 * 1000, 'the refreshed window must stay a fixed, bounded size');
  assert.doesNotThrow(() => validateNormalAdmissionPolicy(policy));
  const { validFrom: _sf, validUntil: _su, ...identityBefore } = STALE_NORMAL_POLICY;
  const { validFrom: _rf, validUntil: _ru, ...identityAfter } = policy;
  assert.deepEqual(identityAfter, identityBefore, 'only the window may change, never identity');
});

test('a policy already valid for the next 15 minutes is still fully replaced, never merely extended', PWSH, () => {
  const from = new Date(Date.now() - 60_000);
  const until = new Date(from.getTime() + 5 * 60_000);
  const almostFresh = { ...STALE_NORMAL_POLICY,
    validFrom: from.toISOString(), validUntil: until.toISOString() };
  const { status, stderr, policy } = runWindowScript(almostFresh);
  assert.equal(status, 0, stderr);
  assert.notEqual(policy.validFrom, almostFresh.validFrom);
  assert.notEqual(policy.validUntil, almostFresh.validUntil);
});

test('the freshen step only runs when normal admission is selected', () => {
  const block = stepBlock(workflowText(), 'Freshen the normal-admission policy window');
  assert.ok(
    block.some((line) => /^ {8}if: steps\.identity\.outputs\.normal_policy == 'true'\s*$/u.test(line)),
    'an unselected run must not touch the checked-out policy file at all',
  );
});

/**
 * The manual issue selector.
 *
 * The CLI and the intake application already accept explicit candidates; the manual workflow had no
 * way to name one, so the only manual normal-policy run available was repository-wide. The selector
 * added here is adapter-level scheduling data — it narrows which issue a run may act on and grants
 * no authority — and it is validated in the identity step, which runs before the App token is minted
 * and before any step reads or writes the ledger.
 */

const TARGETED_ISSUE = '128';

test('the manual target_issue input is declared an optional string, empty by default', () => {
  const workflow = workflowText();
  assert.match(
    workflow,
    /target_issue:\s*\n\s+description:.*\n\s+type: string\s*\n\s+default: ''/u,
    'the selector must be an optional free-text input, absent unless an operator types one',
  );
  assert.match(
    workflow,
    /GAIA_TARGET_ISSUE: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.target_issue \|\| '' \}\}/u,
    'a non-dispatch event carries no selector at all',
  );
});

test('a manual normal-policy run may select exactly one issue, published for the later steps', PWSH, () => {
  const { status, stderr, outputs } = runIdentityScript(identityScript(), {
    ...REQUIRED_IDENTITY,
    GAIA_NORMAL_POLICY_DISPATCH: 'true',
    GAIA_TARGET_ISSUE: TARGETED_ISSUE,
  });
  assert.equal(status, 0, stderr);
  assert.equal(outputs.normal_policy, 'true');
  assert.equal(outputs.target_issue, TARGETED_ISSUE);
});

test('an untargeted manual normal run still publishes an empty selection, unchanged', PWSH, () => {
  for (const env of [
    { GAIA_NORMAL_POLICY_DISPATCH: 'true' },
    { GAIA_NORMAL_POLICY_VAR: 'true' },
    { GAIA_MANAGED_ROUND_JSON: '{"fixture":true}' },
  ]) {
    const { status, stderr, outputs } = runIdentityScript(identityScript(), {
      ...REQUIRED_IDENTITY, ...env,
    });
    assert.equal(status, 0, stderr);
    assert.equal(
      outputs.target_issue ?? '', '',
      'a run nobody targeted must select no issue, leaving the existing funnel in charge',
    );
  }
});

test('a malformed issue selector is refused before any token, policy or ledger work', PWSH, () => {
  // Everything here either is not a positive decimal integer, is not safe as a JavaScript number,
  // or carries the whitespace/newline shapes that would let a selector forge a second GITHUB_OUTPUT
  // line. The CLI refuses each of them too; this gate is about refusing them one step earlier.
  const malformed = [
    '0', '-1', '+1', '12.5', '1e3', '0x80', '007', 'abc', '12abc', '#128',
    ' 128', '128 ', '128\n', '128\ntarget_issue=127', '128,129', '9007199254740992',
    '99999999999999999999', '$(127)', '128;127', '--issue 128',
  ];
  for (const target of malformed) {
    const { status, outputs } = runIdentityScript(identityScript(), {
      ...REQUIRED_IDENTITY,
      GAIA_NORMAL_POLICY_DISPATCH: 'true',
      GAIA_TARGET_ISSUE: target,
    });
    assert.notEqual(status, 0, `${JSON.stringify(target)} must not be accepted as an issue number`);
    assert.equal(
      outputs.target_issue, undefined,
      `${JSON.stringify(target)} must publish no selection for a later step to read`,
    );
  }
});

test('an issue selector outside a manual normal-policy selection is refused', PWSH, () => {
  const incompatible = [
    // Canary pins its own issue through the sealed policy; a second selector is ambiguous.
    { GAIA_ONE_CANARY: 'true' },
    // Preparation already names its issue through prepare_issue.
    { GAIA_PREPARE_ISSUE: '5' },
    // The legacy managed-round path is not the scoped normal run this selector was added for.
    { GAIA_MANAGED_ROUND_JSON: '{"fixture":true}' },
    // A vars-gated selection is not a manual run, and a selector cannot arrive without one.
    { GAIA_NORMAL_POLICY_VAR: 'true' },
  ];
  for (const env of incompatible) {
    const { status, outputs } = runIdentityScript(identityScript(), {
      ...REQUIRED_IDENTITY, ...env, GAIA_TARGET_ISSUE: TARGETED_ISSUE,
    });
    assert.notEqual(status, 0, `${JSON.stringify(env)} must not combine with an issue selector`);
    assert.equal(outputs.target_issue, undefined);
  }
});

test('the selector is validated before the pump token exists and before any ledger step', () => {
  const lines = workflowText().split(/\r?\n/u);
  const at = (predicate) => lines.findIndex(predicate);
  const identity = at((line) => line.trim() === '- name: Require the dedicated pump identity');
  const token = at((line) => line.includes('actions/create-github-app-token'));
  const checkout = at((line) => line.includes('actions/checkout'));
  const cli = at((line) => line.includes('scripts/hosted-draft-pump.mjs'));
  assert.ok(identity >= 0 && token > identity, 'no token may be minted before the identity gate');
  assert.ok(checkout > identity && cli > identity, 'no ledger work may precede the identity gate');

  const block = stepBlock(workflowText(), 'Require the dedicated pump identity');
  assert.ok(
    block.some((line) => line.includes('GAIA_TARGET_ISSUE')),
    'the selector must be read by the gate that runs first, not by the step that acts',
  );
});

test('the selector reaches the CLI through the environment, never through shell interpolation', () => {
  const workflow = workflowText();
  assert.match(
    workflow,
    /^ {10}GAIA_ISSUE_NUMBER: \$\{\{ steps\.identity\.outputs\.target_issue \|\| github\.event\.issue\.number \}\}$/mu,
    'the validated selection, then the labelled issue: an empty output falls through to the lane',
  );
  const runBodies = [...workflow.matchAll(/^ {10}(?:&|\$| {2}).*$/gmu)].map(([line]) => line);
  for (const line of runBodies) {
    assert.doesNotMatch(
      line, /\$\{\{/u,
      `no run: line may interpolate an expression into the shell: ${line.trim()}`,
    );
  }
  assert.doesNotMatch(
    workflow, /--issue \$\{\{/u,
    'a selector spliced into the command line is a shell injection seam, not an argument',
  );
});
