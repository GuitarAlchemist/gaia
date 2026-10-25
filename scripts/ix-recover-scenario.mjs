#!/usr/bin/env node
// The first Gaia consumer of IX's recovery store, end to end against a real IX binary.
//
//   node scripts/ix-recover-scenario.mjs --ix <ix executable> --governance <dir> --work <new dir>
//
// --ix must be a debug build of `ix` (IX PR #389 or later): the stop step pauses it with
// IX_RECOVER_PAUSE, which release builds ignore. --governance is IX's governance/demerzel.
// --work must not exist; everything is written under it, the journal included.
//
// Exit codes: 0 every expectation held · 1 one failed · 2 usage.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';

import { IxRecoverError, runRecoverableStats } from '../src/ix-recover-consumer.mjs';

const STATS_SPEC = `version: "1"
params:
  nums: null
stages:
  s:
    skill: stats
    args:
      data: { param: nums }
`;
const UNAUDITED_SPEC = `version: "1"
stages:
  s:
    skill: stats
    args:
      data: [1.0, 2.0]
  q:
    skill: federation.discover
    args:
      domain: "math"
`;

const { values } = parseArgs({ options: { ix: { type: 'string' }, governance: { type: 'string' }, work: { type: 'string' } } });
if (!values.ix || !values.governance || !values.work || existsSync(values.work)) {
  console.error('usage: ix-recover-scenario.mjs --ix <exe> --governance <dir> --work <new dir>');
  process.exit(2);
}
const ix = resolve(values.ix);
const governanceDir = resolve(values.governance);
const work = resolve(values.work);
const runsDir = join(work, 'runs');
const statsSpec = join(work, 'ix.yaml');
const unauditedSpec = join(work, 'ix-unaudited.yaml');
const journal = join(work, 'journal.jsonl');
mkdirSync(work, { recursive: true });
writeFileSync(statsSpec, STATS_SPEC);
writeFileSync(unauditedSpec, UNAUDITED_SPEC);

const checks = [];
const log = (entry) => appendFileSync(journal, `${JSON.stringify({ t: new Date().toISOString(), ...entry })}\n`);
function expect(name, ok, detail = {}) {
  checks.push({ name, ok });
  log({ check: name, ok, ...detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
}
const attempts = (runId) => (existsSync(join(runsDir, runId, 'attempts'))
  ? readdirSync(join(runsDir, runId, 'attempts')).sort() : []);

// Gaia's call: the consumer, plus a bounded retry while the OS releases a killed owner's lock.
function consume(step, runId, params, specFile = statsSpec) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      const result = runRecoverableStats({ executable: ix, governanceDir, specFile, runId, runsDir, params });
      log({ step, runId, attemptId: result.attemptId, outcome: result.outcome, stats: result.summary.stages.s?.output });
      return result;
    } catch (error) {
      if (!(error instanceof IxRecoverError)) throw error;
      log({ step, runId, refused: error.code, ixExit: error.ixExit, reason: error.message });
      if (error.code !== 'RUN_HELD' || Date.now() > deadline) return error;
    }
  }
}

// The interruption: IX started as Gaia would start it, stopped at a publish point, then killed.
async function interrupt(step, runId, params, point) {
  const marker = join(work, `${runId}.${point}.reached`);
  const env = { ...process.env, IX_GOVERNANCE_DIR: governanceDir, IX_RECOVER_PAUSE: `${point}|${marker}|60` };
  for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) delete env[key];
  const child = spawn(ix, [
    '--format', 'json', 'pipeline', 'run', '--file', statsSpec, '--run-id', runId, '--runs-dir', runsDir,
    ...Object.entries(params).flatMap(([name, value]) => ['--param', `${name}=${JSON.stringify(value)}`]),
  ], {
    cwd: work,
    env,
    stdio: 'ignore',
    windowsHide: true,
  });
  const exited = new Promise((done) => child.on('exit', (code, signal) => done({ code, signal })));
  const deadline = Date.now() + 60_000;
  while (!existsSync(marker)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill();
      log({ step, runId, stop: 'never reached', point, ixExit: child.exitCode });
      return false;
    }
    await new Promise((wait) => setTimeout(wait, 50));
  }
  child.kill();
  const { code, signal } = await exited;
  log({ step, runId, stop: 'killed', point, pid: Number(readFileSync(marker, 'utf8')), ixExit: code, signal });
  return true;
}

const first = consume('A1 first run', 'gaia-stats-a', { nums: [1, 2, 3, 4] });
expect('A1 a first run publishes one attempt', first.outcome === 'published' && attempts('gaia-stats-a').length === 1,
  { attemptId: first.attemptId });
const again = consume('A2 same run again', 'gaia-stats-a', { nums: [1, 2, 3, 4] });
expect('A2 the same run replays that attempt and its result',
  again.outcome === 'replayed' && again.attemptId === first.attemptId
    && isDeepStrictEqual(again.summary, first.summary) && attempts('gaia-stats-a').length === 1);

const conflict = consume('B1 same run id, other input', 'gaia-stats-a', { nums: [9, 9, 9] });
expect('B1 another input under a recorded run id is refused and nothing runs',
  conflict.code === 'RUN_CONFLICT' && attempts('gaia-stats-a').length === 1);
const unaudited = consume('B2 a stage not audited as pure', 'gaia-stats-x', {}, unauditedSpec);
expect('B2 a spec with an unaudited stage is refused before the store',
  unaudited.code === 'STAGE_REFUSED' && !existsSync(join(runsDir, 'gaia-stats-x')));

const afterCommit = await interrupt('C1 stop after the commit', 'gaia-stats-b', { nums: [2, 4, 6] }, 'committed');
const committed = attempts('gaia-stats-b');
const repaired = consume('C1 resume', 'gaia-stats-b', { nums: [2, 4, 6] });
expect('C1 a run stopped after its commit resumes from it without running again',
  afterCommit && repaired.outcome === 'repaired' && committed.length === 1
    && repaired.attemptId === committed[0] && isDeepStrictEqual(attempts('gaia-stats-b'), committed));
const beforeCommit = await interrupt('C2 stop before the commit', 'gaia-stats-c', { nums: [5, 10] }, 'staged');
const residue = attempts('gaia-stats-c');
const fresh = consume('C2 resume', 'gaia-stats-c', { nums: [5, 10] });
expect('C2 a run stopped before its commit runs once more under a new attempt',
  beforeCommit && fresh.outcome === 'published' && residue.length === 1 && fresh.attemptId !== residue[0]
    && attempts('gaia-stats-c').length === 2);
const replayAfter = consume('C2 replay', 'gaia-stats-c', { nums: [5, 10] });
expect('C2 the resumed run then replays its own attempt',
  replayAfter.outcome === 'replayed' && replayAfter.attemptId === fresh.attemptId);

const failed = checks.filter((check) => !check.ok).length;
console.log(`${checks.length - failed}/${checks.length} expectations held; journal: ${journal}`);
process.exit(failed === 0 ? 0 : 1);
