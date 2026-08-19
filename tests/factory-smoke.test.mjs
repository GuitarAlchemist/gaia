import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(ROOT, 'scripts', 'factory-smoke.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'gaia-factory-smoke-'));

test.after(() => rmSync(scratch, { recursive: true, force: true }));

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('one command produces a verified three-role artifact workflow', { timeout: 60_000 }, async () => {
  const artifact = join(scratch, 'candidate.txt');
  const dataDir = join(scratch, 'bus');
  const reportPath = join(scratch, 'factory-run.json');
  writeFileSync(artifact, 'candidate bytes\n', 'utf8');

  const result = await run([
    '--data-dir', dataDir,
    '--artifact', artifact,
    '--out', reportPath,
    '--task', 'Verify the candidate artifact',
  ]);

  assert.equal(result.code, 0, result.stderr || result.stdout);
  const printed = JSON.parse(result.stdout);
  const persisted = JSON.parse(readFileSync(reportPath, 'utf8'));
  assert.deepEqual(persisted, printed);
  assert.equal(printed.ok, true);
  assert.equal(printed.command, 'factory-smoke');
  assert.equal(printed.execution, 'coordination-tracer; no code execution');
  assert.equal(printed.artifact.bytes, 16);
  assert.match(printed.artifact.sha256, /^[0-9a-f]{64}$/);
  assert.equal(printed.status, 'completed');
  assert.equal(new Set(Object.values(printed.actors)).size, 3);
  assert.equal(printed.messages.length, 3);
  assert.equal(printed.acknowledgements.length, 3);
  assert.deepEqual(printed.handoff.authorityTransferred, []);
  assert.equal(printed.verification.ok, true);
  assert.equal(printed.verification.evidenceOk, true);
  assert.deepEqual(printed.toolSurface, ['ack', 'handoff', 'heartbeat', 'inbox', 'register', 'send']);

  const logPath = join(dataDir, 'events.jsonl');
  const beforeBytes = readFileSync(logPath);
  const before = beforeBytes.toString('utf8');
  assert.deepEqual(printed.evidenceLog, {
    format: 'gaia-event-log-fixed-point/1',
    pathRole: 'data-dir/events.jsonl',
    bytes: beforeBytes.byteLength,
    events: 15,
    sha256: createHash('sha256').update(beforeBytes).digest('hex'),
  });
  const secondReport = join(scratch, 'second-factory-run.json');
  const repeated = await run([
    '--data-dir', dataDir,
    '--artifact', artifact,
    '--out', secondReport,
  ]);
  assert.equal(repeated.code, 2);
  assert.match(repeated.stderr, /fresh data directory/i);
  assert.equal(readFileSync(logPath, 'utf8'), before, 'a refused rerun appends no events');
  const refusedReceipt = JSON.parse(readFileSync(secondReport, 'utf8'));
  assert.equal(refusedReceipt.status, 'failed');
  assert.equal(refusedReceipt.evidenceLog, null, 'the loser never claims another run\'s evidence');
});

test('the smoke refuses to overwrite an existing report', async () => {
  const artifact = join(scratch, 'refusal-candidate.txt');
  const dataDir = join(scratch, 'refusal-bus');
  const reportPath = join(scratch, 'existing.json');
  writeFileSync(artifact, 'candidate', 'utf8');
  writeFileSync(reportPath, '{"owner":"user"}\n', 'utf8');

  const result = await run(['--data-dir', dataDir, '--artifact', artifact, '--out', reportPath]);

  assert.equal(result.code, 2);
  assert.match(result.stderr, /already exists/i);
  assert.equal(readFileSync(reportPath, 'utf8'), '{"owner":"user"}\n');
});

test('an atomic data-directory claim permits exactly one concurrent run', { timeout: 60_000 }, async () => {
  const artifact = join(scratch, 'concurrent-candidate.txt');
  const dataDir = join(scratch, 'concurrent-bus');
  const reports = [join(scratch, 'concurrent-a.json'), join(scratch, 'concurrent-b.json')];
  writeFileSync(artifact, 'candidate', 'utf8');

  const results = await Promise.all(reports.map((out) => run([
    '--data-dir', dataDir, '--artifact', artifact, '--out', out,
  ])));

  assert.deepEqual(results.map((result) => result.code).sort(), [0, 2]);
  const receipts = reports.map((path) => JSON.parse(readFileSync(path, 'utf8')));
  assert.deepEqual(receipts.map((receipt) => receipt.status).sort(), ['completed', 'failed']);
  assert.equal(receipts.find((receipt) => receipt.status === 'completed').evidenceLog.events, 15);
  assert.equal(readFileSync(join(dataDir, 'events.jsonl'), 'utf8').trim().split('\n').length, 15);
});

test('an unusable report parent fails before any bus evidence is written', async () => {
  const artifact = join(scratch, 'preflight-candidate.txt');
  const dataDir = join(scratch, 'preflight-bus');
  const blockedParent = join(scratch, 'report-parent-is-a-file');
  writeFileSync(artifact, 'candidate', 'utf8');
  writeFileSync(blockedParent, 'user bytes', 'utf8');

  const result = await run([
    '--data-dir', dataDir,
    '--artifact', artifact,
    '--out', join(blockedParent, 'report.json'),
  ]);

  assert.equal(result.code, 1);
  assert.equal(existsSync(dataDir), false, 'no bus directory is claimed before report preflight succeeds');
  assert.equal(readFileSync(blockedParent, 'utf8'), 'user bytes');
});
