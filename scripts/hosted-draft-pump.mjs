#!/usr/bin/env node

import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  createDraftOperationPorts,
  createGitDataDraftOperationStore,
  enqueueDraft,
  listUnsettledDrafts,
  reconcileDraft,
} from '../src/draft-operation-envelope.mjs';
import { createGhDraftOperationProvider } from '../src/gh-draft-operation-provider.mjs';
import { createGhGitDataApi } from '../src/gh-git-data-adapter.mjs';
import {
  createGhDraftCollectorApi,
  createHostedDraftCollector,
} from '../src/hosted-draft-collector.mjs';
import { createGitHubActionsDraftAdmission } from '../src/github-actions-draft-admission.mjs';
import { runHostedDraftIntake } from '../src/hosted-draft-pump.mjs';

const execFileAsync = promisify(execFile);
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const REPOSITORY = /^([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)$/u;
const COMMANDS = new Set(['enqueue', 'reconcile', 'list-unsettled', 'intake']);
// Sealed per command. Never a flag and never environment-derived: a caller that could name its
// own workflow here would mint effect authority for a run it controls.
const ADMISSION_WORKFLOW_PATH = Object.freeze({
  reconcile: '.github/workflows/hosted-draft-pump-effect.yml',
  intake: '.github/workflows/hosted-draft-intake.yml',
});
const INTAKE_PROBE_LIMIT = 5;
const INTAKE_PRESENTATION = Object.freeze({
  owner: 'Gaia hosted Draft pump',
  gate: 'DELIVERY',
  checklist: Object.freeze([
    'Create or reuse one exact Draft pull request',
    'Persist one terminal receipt',
  ]),
  eta: Object.freeze({ minimumMinutes: 60, maximumMinutes: 120 }),
});
const COMMON_FLAGS = new Set([
  'repository', 'pump-actor-id', 'ledger-root-oid', 'ledger-root-revision',
]);
const COMMAND_FLAGS = Object.freeze({
  enqueue: new Set([...COMMON_FLAGS, 'issue']),
  reconcile: new Set([
    ...COMMON_FLAGS, 'operation-id', 'work-key', 'expected-revision', 'repository-node-id',
    'owner', 'gate', 'check', 'eta-minutes',
  ]),
  'list-unsettled': COMMON_FLAGS,
  intake: new Set([
    ...COMMON_FLAGS, 'issue', 'repository-node-id', 'owner', 'gate', 'check', 'eta-minutes',
  ]),
});

export class HostedDraftPumpCliError extends Error {
  constructor(code) {
    super(code);
    this.name = 'HostedDraftPumpCliError';
    this.code = code;
  }
}

function fail(code = 'InvalidArguments') {
  throw new HostedDraftPumpCliError(code);
}

function parseFlags(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || !COMMANDS.has(argv[0])) fail();
  const command = argv[0];
  const allowed = COMMAND_FLAGS[command];
  const flags = new Map();
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (typeof name !== 'string' || !name.startsWith('--') || value === undefined) fail();
    const key = name.slice(2);
    if (!allowed.has(key) || key.length === 0 || (flags.has(key) && key !== 'check')) fail();
    if (key === 'check') flags.set(key, [...(flags.get(key) ?? []), value]);
    else flags.set(key, value);
  }
  return { command, flags };
}

function envValue(env, name) {
  const descriptor = env !== null && typeof env === 'object'
    ? Object.getOwnPropertyDescriptor(env, name) : null;
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}

function configuredText(value, maximum = 512) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) fail();
  return value;
}

function flagOrEnv(flags, flag, env, name) {
  return configuredText(flags.get(flag) ?? envValue(env, name));
}

function optionalFlagOrEnv(flags, flag, env, name) {
  const value = flags.get(flag) ?? envValue(env, name);
  return value === undefined ? undefined : configuredText(value);
}

function positiveInteger(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/u.test(value)) fail();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail();
  return parsed;
}

function sha256(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail();
  return value;
}

function oid(value) {
  if (typeof value !== 'string' || !GIT_OID.test(value)) fail();
  return value;
}

function parseRepository(value) {
  const match = REPOSITORY.exec(configuredText(value));
  if (match === null) fail();
  return Object.freeze({ owner: match[1], name: match[2] });
}

function checklist(flags, env) {
  const supplied = flags.get('check');
  if (supplied !== undefined) return Object.freeze(supplied.map((item) => configuredText(item, 160)));
  const encoded = flagOrEnv(flags, 'check', env, 'GAIA_CHECKLIST_JSON');
  let parsed;
  try {
    parsed = JSON.parse(encoded);
  } catch {
    fail();
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > 8) fail();
  return Object.freeze(parsed.map((item) => configuredText(item, 160)));
}

function eta(value) {
  const match = /^(\d+):(\d+)$/u.exec(value);
  if (match === null) fail();
  const minimumMinutes = positiveInteger(match[1]);
  const maximumMinutes = positiveInteger(match[2]);
  if (maximumMinutes < minimumMinutes) fail();
  return Object.freeze({ minimumMinutes, maximumMinutes });
}

function parseConfiguration(argv, env) {
  const { command, flags } = parseFlags(argv);
  const repository = parseRepository(flagOrEnv(flags, 'repository', env, 'GAIA_REPOSITORY'));
  const configuration = {
    command,
    repository,
    pumpActorId: positiveInteger(flagOrEnv(
      flags, 'pump-actor-id', env, 'GAIA_PUMP_ACTOR_ID',
    )),
    ledgerRootOid: oid(flagOrEnv(flags, 'ledger-root-oid', env, 'GAIA_LEDGER_ROOT_OID')),
    ledgerRootRevision: sha256(flagOrEnv(
      flags, 'ledger-root-revision', env, 'GAIA_LEDGER_ROOT_REVISION',
    )),
    environment: env,
  };
  if (command === 'enqueue') {
    configuration.issue = positiveInteger(flagOrEnv(flags, 'issue', env, 'GAIA_ISSUE_NUMBER'));
  }
  if (command === 'reconcile') {
    configuration.operationId = sha256(flagOrEnv(
      flags, 'operation-id', env, 'GAIA_OPERATION_ID',
    ));
    configuration.workKey = sha256(flagOrEnv(flags, 'work-key', env, 'GAIA_WORK_KEY'));
    configuration.expectedRevision = sha256(flagOrEnv(
      flags, 'expected-revision', env, 'GAIA_EXPECTED_REVISION',
    ));
    configuration.repositoryNodeId = configuredText(flagOrEnv(
      flags, 'repository-node-id', env, 'GAIA_REPOSITORY_NODE_ID',
    ));
    configuration.presentation = {
      owner: flagOrEnv(flags, 'owner', env, 'GAIA_DRAFT_OWNER'),
      gate: flagOrEnv(flags, 'gate', env, 'GAIA_DRAFT_GATE'),
      checklist: checklist(flags, env),
      eta: eta(flagOrEnv(flags, 'eta-minutes', env, 'GAIA_ETA_MINUTES')),
    };
  }
  if (command === 'intake') {
    const issue = optionalFlagOrEnv(flags, 'issue', env, 'GAIA_ISSUE_NUMBER');
    if (issue !== undefined) configuration.issue = positiveInteger(issue);
    configuration.repositoryNodeId = configuredText(flagOrEnv(
      flags, 'repository-node-id', env, 'GAIA_REPOSITORY_NODE_ID',
    ));
    const suppliedEta = optionalFlagOrEnv(flags, 'eta-minutes', env, 'GAIA_ETA_MINUTES');
    const suppliedChecklist = flags.get('check') !== undefined
      || envValue(env, 'GAIA_CHECKLIST_JSON') !== undefined;
    configuration.presentation = {
      owner: optionalFlagOrEnv(flags, 'owner', env, 'GAIA_DRAFT_OWNER')
        ?? INTAKE_PRESENTATION.owner,
      gate: optionalFlagOrEnv(flags, 'gate', env, 'GAIA_DRAFT_GATE') ?? INTAKE_PRESENTATION.gate,
      checklist: suppliedChecklist ? checklist(flags, env) : INTAKE_PRESENTATION.checklist,
      eta: suppliedEta === undefined ? INTAKE_PRESENTATION.eta : eta(suppliedEta),
    };
  }
  return Object.freeze(configuration);
}

function admissionWorkflowPath(command) {
  if (typeof command !== 'string' || !Object.hasOwn(ADMISSION_WORKFLOW_PATH, command)) fail();
  return ADMISSION_WORKFLOW_PATH[command];
}

function createTelemetry() {
  const events = [];
  return Object.freeze({
    events,
    async append(event) {
      events.push(structuredClone(event));
    },
  });
}

async function readWorkflowAdmission(configuration, { repository, runId, runAttempt }) {
  const { stdout } = await execFileAsync('gh', [
    'api', `repos/${repository}/actions/runs/${runId}/attempts/${runAttempt}`,
  ], { encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true });
  const observed = JSON.parse(stdout);
  return {
    repository: { full_name: observed.repository?.full_name },
    id: observed.id,
    run_attempt: observed.run_attempt,
    status: observed.status,
    path: observed.path,
    head_sha: observed.head_sha,
  };
}

const DEFAULT_DEPENDENCIES = Object.freeze({
  createGhGitDataApi,
  createGitDataDraftOperationStore,
  createGhDraftCollectorApi,
  createHostedDraftCollector,
  createGhDraftOperationProvider,
  createGitHubActionsDraftAdmission,
  createDraftOperationPorts,
  enqueueDraft,
  reconcileDraft,
  listUnsettledDrafts,
  readWorkflowAdmission,
});

export function createHostedDraftPumpRuntime(
  configuration,
  telemetry,
  dependencies = DEFAULT_DEPENDENCIES,
) {
  const gitData = dependencies.createGhGitDataApi({
    repository: configuration.repository,
    pumpActor: { actorId: configuration.pumpActorId, actorType: 'Integration' },
  });
  const store = dependencies.createGitDataDraftOperationStore({
    gitData,
    config: {
      ledgerRegistryRootOid: configuration.ledgerRootOid,
      ledgerRegistryRootRevision: configuration.ledgerRootRevision,
    },
  });
  const github = dependencies.createGhDraftCollectorApi();
  const collector = dependencies.createHostedDraftCollector({ github });
  const inertProvider = Object.freeze({
    async lookupExact() { return null; },
    async createDraft() { throw new HostedDraftPumpCliError('OperationFailed'); },
  });
  const inertAdmission = Object.freeze({ async reserveEffect() { return 'ZERO'; } });
  const enqueuePorts = dependencies.createDraftOperationPorts({
    collector,
    provider: inertProvider,
    admission: inertAdmission,
    executorEpoch: { runId: 1, runAttempt: 1 },
    telemetry,
    store,
  });
  return Object.freeze({
    async enqueue(selector) {
      return dependencies.enqueueDraft(selector, 'NONE', enqueuePorts);
    },
    async reconcile({ operationId, workKey, expectedRevision }) {
      const snapshot = await store.inspectByOperation(operationId);
      if (snapshot?.identity?.workKey !== workKey
        || snapshot?.envelope?.workItem?.kind !== 'ISSUE'
        || !Number.isSafeInteger(snapshot.envelope.workItem.number)
        || snapshot.envelope.workItem.number <= 0) {
        fail('OperationBindingMismatch');
      }
      const expectedRepository = Object.freeze({
        nodeId: configuration.repositoryNodeId,
        owner: configuration.repository.owner,
        name: configuration.repository.name,
      });
      const provider = dependencies.createGhDraftOperationProvider({
        expectedRepository,
        presentation: configuration.presentation,
      });
      const admission = dependencies.createGitHubActionsDraftAdmission({
        expectedRepository: `${configuration.repository.owner}/${configuration.repository.name}`,
        expectedWorkKey: workKey,
        expectedWorkflowPath: admissionWorkflowPath(configuration.command),
        environment: configuration.environment,
        readWorkflowAdmission: (identity) => dependencies.readWorkflowAdmission(
          configuration, identity,
        ),
      });
      const operationPorts = dependencies.createDraftOperationPorts({
        collector,
        provider,
        admission,
        executorEpoch: admission.executorEpoch,
        telemetry,
        store,
      });
      return dependencies.reconcileDraft(operationId, expectedRevision, operationPorts);
    },
    async listUnsettled() {
      return dependencies.listUnsettledDrafts({ store });
    },
    async listReadyIssues() {
      return github.listReadyIssues({ repository: configuration.repository });
    },
  });
}

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    fail('OperationFailed');
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

export async function main({
  argv = process.argv.slice(2),
  env = process.env,
  stdout = process.stdout,
  stderr = process.stderr,
  runtimeFactory = createHostedDraftPumpRuntime,
} = {}) {
  let configuration;
  try {
    configuration = parseConfiguration(argv, env);
  } catch {
    writeJson(stderr, { schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'InvalidArguments' });
    return 2;
  }
  try {
    const telemetry = createTelemetry();
    const runtime = await runtimeFactory(configuration, telemetry);
    let receipt;
    if (configuration.command === 'enqueue') {
      const result = cloneJson(await runtime.enqueue({
        repository: configuration.repository,
        workItem: { kind: 'ISSUE', number: configuration.issue },
      }));
      receipt = {
        schema: 'GaiaHostedDraftPumpCliReceiptV0', command: 'enqueue',
        operationId: result.operationId ?? null,
        workKey: result.workKey ?? null,
        committedRevision: result.committedRevision ?? result.currentCommittedRevision ?? null,
        result,
        telemetry: cloneJson(telemetry.events),
      };
    } else if (configuration.command === 'reconcile') {
      const result = cloneJson(await runtime.reconcile({
        operationId: configuration.operationId,
        workKey: configuration.workKey,
        expectedRevision: configuration.expectedRevision,
      }));
      receipt = {
        schema: 'GaiaHostedDraftPumpCliReceiptV0', command: 'reconcile',
        operationId: configuration.operationId, workKey: configuration.workKey,
        committedRevision: result.committedRevision ?? result.currentCommittedRevision ?? null,
        result,
        telemetry: cloneJson(telemetry.events),
      };
    } else if (configuration.command === 'intake') {
      const intake = cloneJson(await runHostedDraftIntake({
        repository: configuration.repository,
        candidates: configuration.issue === undefined ? null : [configuration.issue],
        limit: INTAKE_PROBE_LIMIT,
      }, {
        ledgerPorts: { runtime },
        operationPortsFor(record) { return { workKey: record.workKey }; },
        operationPortsForSelector() { return { workKey: null }; },
        async listUnsettledDrafts() { return runtime.listUnsettled(); },
        async listReadyIssues(request) { return runtime.listReadyIssues(request); },
        async enqueueDraft(canonicalSelector) { return runtime.enqueue(canonicalSelector); },
        async reconcileDraft(operationId, expectedRevision, ports) {
          return runtime.reconcile({ operationId, workKey: ports.workKey, expectedRevision });
        },
      }));
      receipt = {
        schema: 'GaiaHostedDraftPumpCliReceiptV0', command: 'intake',
        trigger: configuration.issue === undefined ? 'SCHEDULE' : 'ISSUES_LABELED',
        phase: intake.phase,
        operationId: intake.operationId,
        workKey: intake.workKey,
        committedRevision: intake.committedRevision,
        result: intake.result,
        skipped: intake.skipped,
        telemetry: cloneJson(telemetry.events),
      };
    } else {
      receipt = {
        schema: 'GaiaHostedDraftPumpCliReceiptV0', command: 'list-unsettled',
        operations: cloneJson(await runtime.listUnsettled()),
        telemetry: cloneJson(telemetry.events),
      };
    }
    writeJson(stdout, receipt);
    return 0;
  } catch {
    writeJson(stderr, { schema: 'GaiaHostedDraftPumpCliErrorV0', error: 'OperationFailed' });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
