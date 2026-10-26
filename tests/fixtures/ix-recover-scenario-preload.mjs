import fs from 'node:fs';
import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';

// Deterministic IX process/store fixture. It launches no process or external effect.
const work = process.env.GAIA_SCENARIO_WORK;
const mode = process.env.GAIA_SCENARIO_MODE;
const mkdir = fs.mkdirSync;
const write = fs.writeFileSync;
if (mode === 'directory-race') {
  fs.mkdirSync = (path, options) => {
    if (String(path) === work && !fs.existsSync(work)) {
      mkdir(work);
      write(join(work, 'ix.yaml'), 'existing evidence\n');
    }
    return mkdir(path, options);
  };
}
const states = new Map();
const arg = (args, flag) => args[args.indexOf(flag) + 1];
const attempt = (runId, number) => `att-a-${runId.endsWith('a') ? 1 : 2}-${number}`;
function stage(runId, id) {
  mkdir(join(work, 'runs', runId, 'attempts', id), { recursive: true });
}
function recordEnvironment(kind, env) {
  fs.appendFileSync(join(work, 'env.jsonl'), `${JSON.stringify({ kind, keys: Object.keys(env) })}\n`);
}
childProcess.spawnSync = (_command, args, options) => {
  if (mode === 'directory-race') throw new Error('IX must not be invoked after a lost directory claim');
  recordEnvironment('consume', options.env);
  const runId = arg(args, '--run-id');
  if (arg(args, '--file').endsWith('ix-unaudited.yaml')) {
    return { status: 1, stdout: '', stderr: 'ix: --run-id runs only stages whose skill is audited as pure refused' };
  }
  const binding = args.at(-1);
  let state = states.get(runId);
  if (state?.binding && state.binding !== binding) {
    return { status: 1, stdout: '', stderr: 'ix: conflict: input changed' };
  }
  let outcome;
  if (!state) {
    state = { id: attempt(runId, 0), phase: 'done', binding };
    outcome = 'published';
    stage(runId, state.id);
  } else if (state.phase === 'committed') {
    outcome = 'receipt repaired, replayed';
    state.phase = 'done';
  } else if (state.phase === 'staged') {
    outcome = 'published';
    state = { ...state, id: attempt(runId, 1), phase: 'done' };
    stage(runId, state.id);
  } else outcome = 'replayed';
  states.set(runId, state);
  write(join(work, 'runs', runId, 'receipt.json'), JSON.stringify({ schema: 'ix-recover-receipt/0',
    run_id: runId, attempt_id: state.id }));
  return { status: 0, stdout: JSON.stringify({ stages: { s: { output: { mean: 2.5 } } } }),
    stderr: `run ${runId}: ${outcome} attempt ${state.id}${outcome === 'published' ? '' : '; nothing executed'}\n` };
};
childProcess.spawn = (_command, args, options) => {
  recordEnvironment('interrupt', options.env);
  const runId = arg(args, '--run-id');
  const [point, marker] = options.env.IX_RECOVER_PAUSE.split('|');
  const id = attempt(runId, 0);
  stage(runId, id);
  states.set(runId, { id, phase: point, binding: args.at(-1) });
  const child = new EventEmitter();
  child.pid = 12345;
  child.exitCode = null;
  child.signalCode = null;
  if (mode === 'marker-unreadable') mkdir(marker);
  else write(marker, String(mode === 'marker-mismatch' ? child.pid + 1 : child.pid));
  child.kill = (signal = 'SIGTERM') => {
    const natural = mode === 'kill-false' || mode === 'natural-exit';
    queueMicrotask(() => {
      child.exitCode = natural ? 0 : null;
      child.signalCode = natural ? null : signal;
      child.emit('exit', child.exitCode, child.signalCode);
    });
    return mode !== 'kill-false';
  };
  return child;
};
syncBuiltinESMExports();
