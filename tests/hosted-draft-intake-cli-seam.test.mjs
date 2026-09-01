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
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
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
    ['github.event.issue.number', event === 'issues' ? String(LABELLED_ISSUE) : ''],
    ['steps.pump-token.outputs.token', 'ghs_fixture_installation_token'],
    ['vars.GAIA_PUMP_ACTOR_ID', '1234'],
    ['vars.GAIA_REPOSITORY_NODE_ID', 'R_kgDOGaia'],
    ['vars.GAIA_PUMP_APP_ID', '424242'],
    ['secrets.GAIA_PUMP_APP_PRIVATE_KEY', 'fixture-private-key'],
    ['steps.policy.outputs.oid', ROOT_OID],
    ['steps.policy.outputs.revision', ROOT_REVISION],
    ['runner.temp', temp],
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
  return value.replace(/\$\{\{\s*([^}]+?)\s*\}\}/gu, (whole, expression) => {
    assert.ok(
      table.has(expression),
      `the seam gate does not model ${whole}; model it rather than letting it reach the CLI unchecked`,
    );
    return table.get(expression);
  });
}

/** The lines of the one step that invokes the pump CLI, found by its invocation, not its name. */
function intakeStepLines(workflow) {
  const lines = workflow.split(/\r?\n/u);
  const starts = lines.reduce((found, line, index) => (
    /^ {6}- (?:name|uses|run|shell):/u.test(line) ? [...found, index] : found
  ), []);
  for (let at = 0; at < starts.length; at += 1) {
    const end = at + 1 < starts.length ? starts[at + 1] : lines.length;
    const block = lines.slice(starts[at], end);
    if (block.some((line) => line.includes(SCRIPT_PATH))) return block;
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
  const block = intakeStepLines(workflow);
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

test('every event path asks the CLI for the observation the Control Room reads', async () => {
  for (const event of ['schedule', 'issues']) {
    const { argv, exitCode, output } = await drive(workflowText(), event);
    assert.ok(argv.includes('--observation-out'), `${event} must request an observation`);
    assert.ok(argv.includes('--run-id'), `${event} must carry the run identity that sequences it`);
    assert.equal(exitCode, 0);

    const path = argv[argv.indexOf('--observation-out') + 1];
    assert.ok(existsSync(path), `${event} must write the observation the workflow uploads`);
    const artifact = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(requireHostedDraftPumpObservation(artifact).revision, artifact.revision);
    assert.deepEqual(output.json().observation, {
      state: 'PRODUCED', revision: artifact.revision,
    });
  }
});

test('the workflow uploads exactly the observation path it told the CLI to write', () => {
  const workflow = workflowText();
  const temp = mkdtempSync(join(tmpdir(), 'gaia-intake-seam-'));
  const { argv } = invocation(workflow, 'schedule', temp);
  const written = argv[argv.indexOf('--observation-out') + 1];
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
  const mutated = workflowText().replace(
    '--ledger-root-oid $env:GAIA_LEDGER_ROOT_OID', '--ledger-root-oid',
  );
  assert.notEqual(mutated, workflowText(), 'the mutation must actually drop a flag value');

  const { exitCode, errors } = await drive(mutated, 'schedule');
  assert.equal(exitCode, 2);
  assert.deepEqual(errors.json(), {
    schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'InvalidArguments',
  });
});

test('revert control: dropping the observation flag leaves the Control Room with nothing to read', async () => {
  // Both the flag and its env binding go: either alone still reaches the CLI, because the CLI
  // reads GAIA_OBSERVATION_PATH from the environment when the flag is absent.
  const mutated = withoutLines(
    workflowText(), (line) => line.includes('GAIA_OBSERVATION_PATH'),
  );
  assert.notEqual(mutated, workflowText(), 'the mutation must actually drop the flag');

  const { argv, exitCode, output } = await drive(mutated, 'schedule');
  assert.equal(exitCode, 0);
  assert.ok(!argv.includes('--observation-out'));
  assert.ok(!Object.hasOwn(output.json(), 'observation'));
});
