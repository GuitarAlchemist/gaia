import { MANAGED_CREATE } from './helpers/managed-draft-config.mjs';
/**
 * The workflow-to-CLI seam.
 *
 * Every other intake gate asserts what the workflow *declares* — triggers, concurrency,
 * permissions, identity. None asserted what it *invokes*, so the one line that tells the CLI which
 * issue was labelled could be deleted with the whole suite staying green, and a `schedule` event —
 * which interpolates that expression to the empty string — had no proven path into the command at
 * all.
 *
 * This file reconstructs the exact environment and argv the runner hands
 * `scripts/hosted-draft-pump.mjs`, from the workflow text itself rather than from a copy of it,
 * and drives the real `main()` with a stub runtime. A flag that is renamed, dropped, left without
 * a value, or bound to an expression nobody modelled fails here rather than at 04:17 UTC.
 */

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { main } from '../scripts/hosted-draft-pump.mjs';
import { requireHostedDraftPumpObservation } from '../src/hosted-draft-pump-observation.mjs';

const INTAKE_URL = new URL('../.github/workflows/hosted-draft-intake.yml', import.meta.url);
const SCRIPT_PATH = 'scripts/hosted-draft-pump.mjs';
const OPERATION_ID = 'a'.repeat(64);
const WORK_KEY = 'b'.repeat(64);
const COMMITTED = 'c'.repeat(64);
const ROOT_OID = 'd'.repeat(40);
const ROOT_REVISION = 'e'.repeat(64);
const GENERATION_KEY = 'f'.repeat(64);
const LABELLED_ISSUE = 70;
const TARGETED_ISSUE = 128;
const FOREIGN_ISSUE = 127;
const FOREIGN_OPERATION = '7'.repeat(64);
const FOREIGN_WORK_KEY = '8'.repeat(64);
const FOREIGN_REVISION = '6'.repeat(64);
const MANAGED_ROUND_JSON = JSON.stringify({
  create: MANAGED_CREATE,
  advance: null,
});

function workflowText() {
  return readFileSync(INTAKE_URL, 'utf8');
}

/**
 * The expressions this seam knows how to resolve, and the two readings of the one that differs.
 *
 * `github.event.issue.number` is the whole point: Actions interpolates a null event field to the
 * empty string, so the `schedule` reading is `''` and not an absent variable. An expression that
 * is not listed here fails the gate, because an unmodelled binding is exactly how this seam went
 * unasserted the first time.
 */
function expressions(event, temp) {
  return new Map([
    ['inputs.prepare_issue', event === 'prepare' ? String(LABELLED_ISSUE) : ''],
    ['github.event.issue.number', event.endsWith('issues') ? String(LABELLED_ISSUE) : ''],
    // The issue identity binding, in its three readings. A manual run publishes a validated
    // selection or the empty string; only when it is empty does the labelled issue show through.
    [
      'steps.identity.outputs.target_issue || github.event.issue.number',
      event === 'normal-targeted' ? String(TARGETED_ISSUE)
        : event.endsWith('issues') ? String(LABELLED_ISSUE) : '',
    ],
    ['steps.pump-token.outputs.token', 'ghs_fixture_installation_token'],
    ['vars.GAIA_PUMP_ACTOR_ID', '1234'],
    ['vars.GAIA_REPOSITORY_NODE_ID', 'R_kgDOGaia'],
    ['vars.GAIA_MANAGED_ROUND_JSON', MANAGED_ROUND_JSON],
    ["github.event_name == 'workflow_dispatch' && inputs.one_canary && '.github/gaia/canary-policy.json' || ''",
      event === 'canary' ? '.github/gaia/canary-policy.json' : ''],
    ["steps.identity.outputs.normal_policy == 'true' && '.github/gaia/normal-policy.json' || ''",
      event.startsWith('normal-') ? '.github/gaia/normal-policy.json' : ''],
    ['vars.GAIA_PUMP_APP_ID', '424242'],
    ['secrets.GAIA_PUMP_APP_PRIVATE_KEY', 'fixture-private-key'],
    ['steps.policy.outputs.oid', ROOT_OID],
    ['steps.policy.outputs.revision', ROOT_REVISION],
    ['runner.temp', temp],
    // The observation binding, in both of its readings. An issue lane resolves it to the empty
    // string, which the CLI reads as an absent value, so no ordered reading is published from a
    // lane that cannot be ordered against the others.
    [
      "github.event_name != 'issues' && !inputs.one_canary"
      + " && format('{0}/gaia-hosted-draft-pump-observation.json', runner.temp) || ''",
      event.endsWith('issues') || event === 'canary' ? '' : `${temp}/gaia-hosted-draft-pump-observation.json`,
    ],
    ['github.run_id', '9001'],
    ['github.run_attempt', '1'],
    ['github.repository', 'GuitarAlchemist/gaia'],
    ['github.repository_owner', 'GuitarAlchemist'],
    ['github.event.repository.name', 'gaia'],
    ['github.workflow_sha', '1'.repeat(40)],
  ]);
}

/** Set by the runner on every step, never declared in the step's own `env:` block. */
function runnerEnvironment() {
  return {
    GITHUB_REPOSITORY: 'GuitarAlchemist/gaia',
    GITHUB_RUN_ID: '9001',
    GITHUB_RUN_ATTEMPT: '1',
  };
}

function resolveExpressions(value, table) {
  // `.+?` rather than `[^}]+?`: a modelled expression may call `format`, whose placeholders carry
  // their own single braces. The lazy match still stops at the first `}}`, which closes it.
  return value.replace(/\$\{\{\s*(.+?)\s*\}\}/gu, (whole, expression) => {
    assert.ok(
      table.has(expression),
      `the seam gate does not model ${whole}; model it rather than letting it reach the CLI unchecked`,
    );
    return table.get(expression);
  });
}

/** The lines of the one step that invokes the pump CLI, found by its invocation, not its name. */
function intakeStepLines(workflow, command = 'intake') {
  const lines = workflow.split(/\r?\n/u);
  const starts = lines.reduce((found, line, index) => (
    /^ {6}- (?:name|uses|run|shell):/u.test(line) ? [...found, index] : found
  ), []);
  for (let at = 0; at < starts.length; at += 1) {
    const end = at + 1 < starts.length ? starts[at + 1] : lines.length;
    const block = lines.slice(starts[at], end);
    if (block.some((line) => line.includes(`${SCRIPT_PATH} ${command}`))) return block;
  }
  return assert.fail(`no intake step invokes ${SCRIPT_PATH}`);
}

function stepEnvironment(block, table) {
  const at = block.findIndex((line) => /^ {8}env:\s*$/u.test(line));
  assert.notEqual(at, -1, 'the intake step must bind its inputs through env:, never through run:');
  const environment = {};
  for (const line of block.slice(at + 1)) {
    if (/^\s*$/u.test(line)) continue;
    const entry = /^ {10}([A-Za-z_][A-Za-z0-9_]*): (.*)$/u.exec(line);
    if (entry === null) break;
    environment[entry[1]] = resolveExpressions(entry[2].trim(), table);
  }
  assert.ok(Object.keys(environment).length > 0, 'the intake step must bind at least one input');
  return environment;
}

/** The `run:` body, with pwsh backtick continuations joined into logical lines. */
function runCommands(block) {
  const at = block.findIndex((line) => /^ {8}run: \|\s*$/u.test(line));
  assert.notEqual(at, -1, 'the intake step must carry a literal run: block');
  const body = [];
  for (const line of block.slice(at + 1)) {
    if (/^\s*$/u.test(line)) continue;
    if (!/^ {10}/u.test(line)) break;
    body.push(line.trim());
  }
  const commands = [];
  let pending = '';
  for (const line of body) {
    if (line.endsWith('`')) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    commands.push(`${pending}${line}`.trim());
    pending = '';
  }
  assert.equal(pending, '', 'a trailing backtick continuation must not run off the run: block');
  return commands;
}

/** The exact argv the runner would hand the CLI, with `$env:` reads resolved against `env`. */
function invocation(workflow, event, temp) {
  const table = expressions(event, temp);
  const block = intakeStepLines(workflow, event === 'prepare' ? 'enqueue' : 'intake');
  const environment = { ...runnerEnvironment(), ...stepEnvironment(block, table) };
  const command = runCommands(block).find((line) => line.includes(SCRIPT_PATH));
  assert.ok(command, `the run: block must invoke ${SCRIPT_PATH}`);

  const tokens = command.split(/\s+/u);
  const redirect = tokens.findIndex((piece) => /^\d?[<>]/u.test(piece));
  const invoked = redirect === -1 ? tokens : tokens.slice(0, redirect);
  assert.deepEqual(invoked.slice(0, 3), ['&', 'node', SCRIPT_PATH],
    'the intake step must invoke the pump CLI directly, with no shell indirection');

  const argv = invoked.slice(3).map((piece) => {
    const read = /^\$env:([A-Za-z_][A-Za-z0-9_]*)$/u.exec(piece);
    if (read === null) return piece;
    assert.ok(
      Object.hasOwn(environment, read[1]),
      `${piece} is read by the run: body but bound by neither the step nor the runner`,
    );
    return environment[read[1]];
  });
  return { argv, environment };
}

/** Remove whole lines from the workflow, so a revert control mutates it the way an editor would. */
function withoutLines(workflow, drop) {
  return workflow.split(/\r?\n/u).filter((line) => !drop(line)).join('\n');
}

function sink() {
  let value = '';
  return {
    stream: { write(chunk) { value += String(chunk); } },
    text() { return value; },
    json() { return JSON.parse(value.trim()); },
  };
}

function stubRuntime(seen) {
  return (configuration) => {
    seen.push(configuration);
    return Object.freeze({
      async listUnsettled() { return []; },
      async enqueue() {
        return {
          kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
          generationKey: GENERATION_KEY, committedRevision: COMMITTED,
        };
      },
      async reconcile() {
        return {
          kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
          operationId: OPERATION_ID, workKey: WORK_KEY, generationKey: GENERATION_KEY,
          observedSourceRevision: '9'.repeat(64), pullRequest: null, refusal: null,
          committedRevision: COMMITTED,
        };
      },
      async listReadyIssues() { return [{ number: LABELLED_ISSUE }]; },
    });
  };
}

async function drive(workflow, event) {
  const temp = mkdtempSync(join(tmpdir(), 'gaia-intake-seam-'));
  const { argv, environment } = invocation(workflow, event, temp);
  const output = sink();
  const errors = sink();
  const seen = [];
  const exitCode = await main({
    argv, env: environment, stdout: output.stream, stderr: errors.stream,
    runtimeFactory: stubRuntime(seen),
  });
  return { argv, environment, exitCode, output, errors, configuration: seen[0], temp };
}

// Positive control: the reconstruction resolves against the shipped workflow before any behaviour
// is asserted, so a failure below is the seam and not a broken parser.
test('positive control: the shipped intake workflow yields one well-formed CLI invocation', () => {
  const temp = mkdtempSync(join(tmpdir(), 'gaia-intake-seam-'));
  const { argv, environment } = invocation(workflowText(), 'schedule', temp);
  assert.equal(argv[0], 'intake');
  assert.ok(argv.length >= 3 && argv.length % 2 === 1, 'the CLI takes a command plus flag pairs');
  assert.equal(environment.GITHUB_REPOSITORY, 'GuitarAlchemist/gaia');
});

test('explicit canary dispatch selects only the fixed policy and refuses its absence before runtime', async () => {
  const workflow = workflowText();
  assert.match(workflow, /one_canary:\s*\n\s+description:.*\n\s+type: boolean\s*\n\s+default: false/u);
  const temp = mkdtempSync(join(tmpdir(), 'gaia-intake-canary-seam-'));
  const { argv, environment } = invocation(workflow, 'canary', temp);
  assert.equal(environment.GAIA_CANARY_POLICY, '.github/gaia/canary-policy.json');
  assert.equal(environment.GAIA_OBSERVATION_PATH, '');
  // Keep missing-policy refusal testable even when an explicitly admitted policy is installed.
  environment.GAIA_CANARY_POLICY = join(temp, 'absent-policy.json');
  assert.equal(existsSync(environment.GAIA_CANARY_POLICY), false);
  const errors = sink(); let entered = false;
  const code = await main({ argv, env: environment, stdout: sink().stream, stderr: errors.stream,
    runtimeFactory: () => { entered = true; throw Error('must not enter runtime'); } });
  assert.notEqual(code, 0);
  assert.equal(entered, false);
});

test('preparation dispatch enqueues the exact issue without managed data or reconciliation', async () => {
  const workflow = workflowText();
  const { argv, environment } = invocation(workflow, 'prepare', tmpdir());
  assert.equal(argv[0], 'enqueue');
  assert.equal(environment.GAIA_ISSUE_NUMBER, String(LABELLED_ISSUE));
  assert.equal(environment.GAIA_MANAGED_ROUND_JSON, undefined);
  assert.equal(environment.GAIA_CANARY_POLICY, undefined);
  const output = sink(); const errors = sink(); let enqueued = 0;
  const code = await main({ argv, env: environment, stdout: output.stream, stderr: errors.stream,
    runtimeFactory: configuration => {
      assert.equal(configuration.command, 'enqueue');
      return {
        async enqueue(selector) {
          assert.equal(selector.workItem.number, LABELLED_ISSUE); enqueued += 1;
          return { kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
            committedRevision: COMMITTED };
        },
        async reconcile() { assert.fail('preparation must not reconcile'); },
      };
    } });
  assert.equal(code, 0); assert.equal(enqueued, 1);
  assert.equal(output.json().command, 'enqueue');
  const bad = [...argv]; bad[bad.indexOf('--issue') + 1] = '0';
  assert.equal(await main({ argv: bad, env: environment, stdout: sink().stream,
    stderr: sink().stream, runtimeFactory: () => assert.fail('invalid input entered runtime') }), 2);
  assert.match(workflow, /if: github.event_name != 'workflow_dispatch' \|\| !inputs.prepare_issue/u);
  assert.match(workflow, /GAIA_ONE_CANARY -eq 'true'.*GAIA_PREPARE_ISSUE/u);
});

test('normal workflow selection reaches the CLI and a missing policy cannot fall back to legacy claims', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'gaia-normal-workflow-seam-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  for (const event of ['normal-dispatch', 'normal-schedule', 'normal-issues']) {
    const { argv, environment } = invocation(workflowText(), event, temp);
    assert.equal(environment.GAIA_NORMAL_POLICY, '.github/gaia/normal-policy.json');
    assert.equal(environment.GAIA_CANARY_POLICY, '');
    assert.equal(environment.GAIA_OBSERVATION_PATH === '', event === 'normal-issues');
    // Keep refusal deterministic even after a real canonical policy is installed.
    environment.GAIA_NORMAL_POLICY = join(temp, 'missing.json');
    const errors = sink(); let entered = false;
    const code = await main({ argv, env: environment, stdout: sink().stream, stderr: errors.stream,
      runtimeFactory: () => { entered = true; } });
    assert.equal(code, 2);
    assert.equal(entered, false);
    assert.equal(errors.json().error, 'NormalPolicyUnavailable');
  }
});

test('normal workflow configuration uses policy instead of the stale blob; removing the binding fails', async t => {
  const temp = mkdtempSync(join(tmpdir(), 'gaia-normal-workflow-policy-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const policy = {
    schema: 'GaiaNormalAdmissionPolicyV0', version: 1,
    repository: { nodeId: 'R_kgDOGaia', owner: 'GuitarAlchemist', name: 'gaia' },
    effectActorId: 1234, allowedEffect: 'CREATE_DRAFT', roundBudget: 1,
    validFrom: '2026-09-05T21:00:00.000Z', validUntil: '2026-09-05T22:00:00.000Z',
    accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
    reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
  };
  const path = join(temp, 'policy.json');
  writeFileSync(path, JSON.stringify(policy));
  for (const removed of [false, true]) {
    const workflow = removed ? withoutLines(workflowText(), line => line.includes('GAIA_NORMAL_POLICY:')) : workflowText();
    const { argv, environment } = invocation(workflow, 'normal-schedule', temp);
    if (!removed) {
      assert.equal(environment.GAIA_NORMAL_POLICY, '.github/gaia/normal-policy.json');
      environment.GAIA_NORMAL_POLICY = path;
    }
    environment.GAIA_MANAGED_ROUND_JSON = JSON.stringify({ create: { receipt: {}, effectClaim: {} } });
    const errors = sink(); let configuration;
    const code = await main({ argv, env: environment, stdout: sink().stream, stderr: errors.stream,
      runtimeFactory: config => {
        configuration = config;
        return { async listUnsettled() { return []; }, async listReadyIssues() { return []; } };
      } });
    if (removed) {
      assert.equal(code, 2);
      assert.equal(configuration, undefined);
    } else {
      assert.equal(code, 0, errors.text());
      assert.deepEqual(configuration.normalPolicy, policy);
      assert.deepEqual(configuration.managedRound, { advance: null });
    }
  }
  // This proves parser wiring only. Runtime expiry and provider effects are covered separately.
});

test('a targeted manual normal run acts on its own issue and never on a foreign unsettled one', async (t) => {
  const temp = mkdtempSync(join(tmpdir(), 'gaia-normal-targeted-seam-'));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const from = new Date(Date.now() - 60_000);
  const path = join(temp, 'policy.json');
  writeFileSync(path, JSON.stringify({
    schema: 'GaiaNormalAdmissionPolicyV0', version: 1,
    repository: { nodeId: 'R_kgDOGaia', owner: 'GuitarAlchemist', name: 'gaia' },
    effectActorId: 1234, allowedEffect: 'CREATE_DRAFT', roundBudget: 1,
    validFrom: from.toISOString(), validUntil: new Date(from.getTime() + 900_000).toISOString(),
    accountableOwner: 'github:user:test-owner', effectOwner: 'github:app:test-pump',
    reviewOwners: { standards: 'github:user:test-standards', spec: 'github:user:test-spec' },
  }));

  const { argv, environment } = invocation(workflowText(), 'normal-targeted', temp);
  assert.equal(environment.GAIA_ISSUE_NUMBER, String(TARGETED_ISSUE));
  assert.equal(environment.GAIA_NORMAL_POLICY, '.github/gaia/normal-policy.json');
  environment.GAIA_NORMAL_POLICY = path;

  // An unrelated operation is durably unsettled and quarantined. Repository-wide intake would
  // resume it first; a selected run must leave it exactly where it is, counted but untouched.
  const touched = [];
  const output = sink(); const errors = sink();
  const code = await main({
    argv, env: environment, stdout: output.stream, stderr: errors.stream,
    runtimeFactory: (configuration) => {
      assert.equal(configuration.issue, TARGETED_ISSUE, 'the selector must reach the CLI intact');
      return Object.freeze({
        async listUnsettled() {
          return [{
            operationId: FOREIGN_OPERATION, workKey: FOREIGN_WORK_KEY,
            committedRevision: FOREIGN_REVISION,
            selector: {
              repository: { owner: 'GuitarAlchemist', name: 'gaia' },
              workItem: { kind: 'ISSUE', number: FOREIGN_ISSUE },
            },
          }];
        },
        async listReadyIssues() {
          return assert.fail('an explicitly selected run must not consult the ready funnel');
        },
        async enqueue(selector) {
          touched.push(['enqueue', selector.workItem.number]);
          return {
            kind: 'Enqueued', operationId: OPERATION_ID, workKey: WORK_KEY,
            generationKey: GENERATION_KEY, committedRevision: COMMITTED,
          };
        },
        async reconcile(request) {
          touched.push(['reconcile', request.operationId]);
          return {
            kind: 'Terminal', outcome: 'CREATED', effect: 'CREATE_DRAFT',
            operationId: request.operationId, workKey: WORK_KEY, generationKey: GENERATION_KEY,
            observedSourceRevision: '9'.repeat(64), pullRequest: null, refusal: null,
            committedRevision: COMMITTED,
          };
        },
      });
    },
  });

  assert.equal(code, 0, errors.text());
  const receipt = output.json();
  assert.equal(receipt.phase, 'ADMIT');
  assert.deepEqual(receipt.workItem, { kind: 'ISSUE', number: TARGETED_ISSUE });
  assert.deepEqual(touched, [['enqueue', TARGETED_ISSUE], ['reconcile', OPERATION_ID]]);
  for (const [verb, subject] of touched) {
    assert.notEqual(subject, FOREIGN_ISSUE, `${verb} must never name the foreign issue`);
    assert.notEqual(subject, FOREIGN_OPERATION, `${verb} must never name the foreign operation`);
  }
  assert.ok(
    receipt.unsettledCount >= 1,
    'the foreign operation stays counted as unsettled: untouched is not resolved',
  );
});

test('a scheduled recovery tick reaches the CLI and is admitted as a schedule, not refused', async () => {
  const { exitCode, errors, output, configuration } = await drive(workflowText(), 'schedule');

  assert.equal(errors.text(), '', 'a scheduled tick must not die at argument parsing');
  assert.equal(exitCode, 0);
  assert.equal(configuration.command, 'intake');
  assert.equal(
    configuration.issue, undefined,
    'an empty GAIA_ISSUE_NUMBER is absent on a schedule event, never a malformed argument',
  );
  assert.equal(output.json().trigger, 'SCHEDULE');
  assert.deepEqual(configuration.managedRound, JSON.parse(MANAGED_ROUND_JSON));
});

test('a labelled issue reaches the CLI carrying exactly that issue identity', async () => {
  const { exitCode, errors, output, configuration } = await drive(workflowText(), 'issues');

  assert.equal(errors.text(), '');
  assert.equal(exitCode, 0);
  assert.equal(configuration.issue, LABELLED_ISSUE);
  assert.equal(output.json().trigger, 'ISSUES_LABELED');
});

test('both event paths carry the same repository, ledger root and pump identity', async () => {
  for (const event of ['schedule', 'issues']) {
    const { configuration } = await drive(workflowText(), event);
    assert.deepEqual(configuration.repository, { owner: 'GuitarAlchemist', name: 'gaia' });
    assert.equal(configuration.ledgerRootOid, ROOT_OID);
    assert.equal(configuration.ledgerRootRevision, ROOT_REVISION);
    assert.equal(configuration.pumpActorId, 1234);
    assert.equal(configuration.repositoryNodeId, 'R_kgDOGaia');
  }
});

test('only the serialized recovery lane publishes the ordered observation', async () => {
  const recovery = await drive(workflowText(), 'schedule');
  assert.equal(recovery.exitCode, 0);
  const path = recovery.environment.GAIA_OBSERVATION_PATH;
  assert.ok(path, 'the recovery lane must be given a path to publish an ordered reading');
  assert.ok(
    recovery.argv.includes('--run-id'),
    'the recovery lane must carry the run identity that sequences its reading',
  );
  assert.ok(existsSync(path), 'the recovery lane must write the observation the workflow uploads');
  const artifact = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(requireHostedDraftPumpObservation(artifact).revision, artifact.revision);
  assert.deepEqual(recovery.output.json().observation, {
    state: 'PRODUCED', revision: artifact.revision,
  });

  // An issue lane still runs, still acts, and still emits its receipt. What it does not do is
  // claim a place in an order it is not in: its run id is executed in order only against its own
  // issue group, so a reading from it can arrive with a lower `sequence` than the one already
  // published and be refused as `IncoherentHostedDraftPump` on healthy forward progress.
  const lane = await drive(workflowText(), 'issues');
  assert.equal(lane.exitCode, 0, 'an issue lane still reaches the CLI and still acts');
  assert.equal(lane.output.json().trigger, 'ISSUES_LABELED');
  assert.equal(
    lane.environment.GAIA_OBSERVATION_PATH, '',
    'an issue lane must be given no observation path',
  );
  assert.ok(
    !lane.argv.includes('--observation-out'),
    'the binding cannot be a flag: an empty value parses as a flag missing its value',
  );
  assert.ok(
    !Object.hasOwn(lane.output.json(), 'observation'),
    'a lane that publishes no ordered reading must not report one',
  );
});

test('the workflow uploads exactly the observation path it told the CLI to write', () => {
  const workflow = workflowText();
  const temp = mkdtempSync(join(tmpdir(), 'gaia-intake-seam-'));
  const { environment } = invocation(workflow, 'schedule', temp);
  const written = environment.GAIA_OBSERVATION_PATH;
  const declared = resolveExpressions(
    /path: (\$\{\{ runner\.temp \}\}\S*observation\S*)\s*$/mu.exec(workflow)?.[1] ?? '',
    expressions('schedule', temp),
  );
  assert.equal(declared, written, 'an uploaded artifact nobody wrote is not evidence');
});

// ---------------------------------------------------------------------------
// revert controls: the gate must stop holding when the mechanism is removed
// ---------------------------------------------------------------------------

test('revert control: deleting the issue-number binding loses the labelled issue identity', async () => {
  const mutated = withoutLines(
    workflowText(), (line) => /^ {10}GAIA_ISSUE_NUMBER:/u.test(line),
  );
  assert.notEqual(mutated, workflowText(), 'the mutation must actually remove a line');

  const { exitCode, configuration } = await drive(mutated, 'issues');
  assert.equal(exitCode, 0);
  assert.notEqual(
    configuration.issue, LABELLED_ISSUE,
    'without the binding the labelled issue cannot reach the CLI; the gate above must fail',
  );
});

test('revert control: a flag left without its value refuses the whole invocation', async () => {
  const mutated = workflowText().replaceAll(
    '--ledger-root-oid $env:GAIA_LEDGER_ROOT_OID', '--ledger-root-oid',
  );
  assert.notEqual(mutated, workflowText(), 'the mutation must actually drop a flag value');

  const { exitCode, errors } = await drive(mutated, 'schedule');
  assert.equal(exitCode, 2);
  assert.deepEqual(errors.json(), {
    schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'InvalidArguments',
  });
});

test('revert control: dropping the observation binding leaves the Control Room with nothing to read', async () => {
  const mutated = withoutLines(
    workflowText(), (line) => line.includes('GAIA_OBSERVATION_PATH'),
  );
  assert.notEqual(mutated, workflowText(), 'the mutation must actually drop the binding');

  const { environment, exitCode, output } = await drive(mutated, 'schedule');
  assert.equal(exitCode, 0);
  assert.ok(!Object.hasOwn(environment, 'GAIA_OBSERVATION_PATH'));
  assert.ok(!Object.hasOwn(output.json(), 'observation'));
});

test('revert control: dropping managed-round intake data refuses both real event paths', async () => {
  const reverted = withoutLines(
    workflowText(), (line) => line.includes('GAIA_MANAGED_ROUND_JSON:'),
  );
  for (const event of ['schedule', 'issues']) {
    const driven = await drive(reverted, event);
    assert.equal(driven.exitCode, 2);
    assert.equal(driven.output.text(), '');
    assert.deepEqual(driven.errors.json(), {
      schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'InvalidArguments',
    });
  }
});

test('revert control: an unconditional observation path re-arms the cross-lane refusal', async () => {
  const mutated = workflowText().replace(
    /^ {10}GAIA_OBSERVATION_PATH: .*$/mu,
    '          GAIA_OBSERVATION_PATH: ${{ runner.temp }}/gaia-hosted-draft-pump-observation.json',
  );
  assert.notEqual(mutated, workflowText(), 'the mutation must actually widen the binding');

  const lane = await drive(mutated, 'issues');
  assert.equal(lane.exitCode, 0);
  const artifact = JSON.parse(readFileSync(lane.environment.GAIA_OBSERVATION_PATH, 'utf8'));
  assert.equal(artifact.sequence, 9001, 'the widened binding lets an issue lane publish a sequence');

  // The reading a sibling lane would then have to be ordered against: a run that queued later,
  // finished sooner, and published a higher run id. `observedAt` still moves forward, so only the
  // run-id guard fires — the refusal is the removed ordering assumption and nothing else.
  assert.throws(
    () => requireHostedDraftPumpObservation(artifact, {
      priorObservation: { observedAt: '2026-01-01T00:00:00.000Z', sequence: artifact.sequence + 1 },
    }),
    (error) => error.code === 'IncoherentHostedDraftPump',
    'without the exclusion a healthy lane reading is refused; the gate above must fail',
  );
});
