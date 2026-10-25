import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

// Gaia's consumer of IX's provisional recovery store (`ix pipeline run --run-id`, IX PR #389).
// IX owns the store and verifies it; Gaia keeps the run and attempt identity IX reports and
// consumes a result only from a run IX ended with exit 0.

export class IxRecoverError extends Error {
  constructor(code, message, ixExit = null) {
    super(message);
    this.name = 'IxRecoverError';
    this.code = code;
    this.ixExit = ixExit;
  }
}

// ix-recover's own rule for a run id (check_segment in crates/ix-recover/src/lib.rs).
const RUN_ID = /^[A-Za-z0-9._-]{1,128}$/u;
const DEVICE = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)$/u;
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ATTEMPT_ID = /^att-[0-9a-f]+-\d+-\d+$/u;
const OUTCOMES = new Map([
  ['published', 'published'],
  ['replayed', 'replayed'],
  ['receipt repaired, replayed', 'repaired'],
]);
// What IX printed when it refused, in the order the store decides (README of ix-recover).
const REFUSALS = [
  [/: conflict: /u, 'RUN_CONFLICT'],
  [/: --run-id runs only stages whose skill is audited as pure /u, 'STAGE_REFUSED'],
  [/: unknown: /u, 'RUN_HELD'],
  [/: corrupt: /u, 'RUN_CORRUPT'],
];

export function runIxRecoverInvocation(invocation) {
  const result = spawnSync(invocation.command, invocation.args, {
    cwd: invocation.cwd,
    env: invocation.env,
    encoding: 'utf8',
    windowsHide: true,
    shell: false,
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error) {
    throw new IxRecoverError('IX_EXECUTION_FAILED', 'IX could not start');
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

export function runRecoverableStats({
  executable, governanceDir, specFile, runId, runsDir, params = {},
}, {
  env = process.env,
  runInvocation = runIxRecoverInvocation,
} = {}) {
  validateRequest({ executable, governanceDir, specFile, runId, runsDir, params });
  const invocationEnv = { ...env, IX_GOVERNANCE_DIR: governanceDir };
  for (const key of [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    // A debug IX stops at a publish point when this is set: only a kill test sets it.
    'IX_RECOVER_PAUSE',
  ]) delete invocationEnv[key];
  const args = [
    '--format', 'json', 'pipeline', 'run', '--file', specFile, '--run-id', runId, '--runs-dir', runsDir,
  ];
  for (const [name, value] of Object.entries(params)) args.push('--param', `${name}=${JSON.stringify(value)}`);
  const execution = runInvocation({ command: executable, args, env: invocationEnv, cwd: dirname(specFile) });
  if (execution.status !== 0) throw refusal(execution);
  const { outcome, attemptId } = announcement(execution.stderr, runId);
  verifyReceipt(runsDir, runId, attemptId);
  let summary;
  try {
    summary = JSON.parse(execution.stdout);
  } catch {
    throw new IxRecoverError('IX_PROTOCOL_INVALID', 'IX output was not valid JSON', 0);
  }
  if (typeof summary?.stages !== 'object' || summary.stages === null) {
    throw new IxRecoverError('IX_PROTOCOL_INVALID', 'IX output has no stages', 0);
  }
  return { runId, attemptId, outcome, summary };
}

function validateRequest({ executable, governanceDir, specFile, runId, runsDir, params }) {
  const invalid = (why) => new IxRecoverError('REQUEST_INVALID', `IX recovery request is invalid: ${why}`);
  for (const [name, value] of Object.entries({ executable, governanceDir })) {
    if (typeof value !== 'string' || value.length === 0) throw invalid(`${name} is required`);
  }
  for (const [name, value] of Object.entries({ specFile, runsDir })) {
    if (typeof value !== 'string' || !isAbsolute(value)) throw invalid(`${name} must be an absolute path`);
  }
  if (typeof runId !== 'string' || !RUN_ID.test(runId) || runId.endsWith('.')
      || DEVICE.test(runId.split('.')[0].toUpperCase())) {
    throw invalid('runId must be 1 to 128 of A-Z a-z 0-9 . _ -, not end with a dot, not name a device');
  }
  if (typeof params !== 'object' || params === null || Array.isArray(params)
      || !Object.keys(params).every((name) => PARAM_NAME.test(name))) {
    throw invalid('params must map identifier names to JSON values');
  }
}

function refusal(execution) {
  const stderr = execution.stderr ?? '';
  const line = stderr.split(/\r?\n/u).find((text) => text.length > 0) ?? '';
  const code = REFUSALS.find(([pattern]) => pattern.test(stderr))?.[1] ?? 'IX_FAILED';
  return new IxRecoverError(code, `IX refused with exit ${execution.status}: ${line.slice(0, 300)}`, execution.status);
}

function announcement(stderr, runId) {
  const lines = (stderr ?? '').split(/\r?\n/u).filter((line) => line.startsWith(`run ${runId}: `));
  const matches = lines
    .map((line) => /^run (\S+): (published|replayed|receipt repaired, replayed) attempt (\S+?)(; nothing executed)?$/u
      .exec(line))
    .filter(Boolean);
  if (lines.length !== 1 || matches.length !== 1 || matches[0][1] !== runId || !ATTEMPT_ID.test(matches[0][3])
      || (matches[0][2] === 'published') !== (matches[0][4] === undefined)) {
    throw new IxRecoverError('IX_PROTOCOL_INVALID', 'IX did not announce exactly one attempt for this run', 0);
  }
  return { outcome: OUTCOMES.get(matches[0][2]), attemptId: matches[0][3] };
}

function verifyReceipt(runsDir, runId, attemptId) {
  let receipt;
  try {
    receipt = JSON.parse(readFileSync(join(runsDir, runId, 'receipt.json'), 'utf8'));
  } catch {
    throw new IxRecoverError('IX_PROTOCOL_INVALID', 'IX left no readable receipt for this run', 0);
  }
  if (receipt?.schema !== 'ix-recover-receipt/0' || receipt.run_id !== runId || receipt.attempt_id !== attemptId) {
    throw new IxRecoverError('IX_PROTOCOL_INVALID', 'the receipt does not name the attempt IX announced', 0);
  }
}
