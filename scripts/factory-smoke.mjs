#!/usr/bin/env node
/**
 * factory-smoke.mjs — one-command, evidence-producing coordination tracer.
 *
 * This deliberately executes no code and launches no model. It proves the Gaia
 * control-plane path around a caller-supplied artifact using only the six bus verbs:
 * coordinator -> builder -> reviewer -> coordinator, with inbox reads, receipts,
 * a handoff that transfers no authority, and the shipped evidence verifier.
 */

import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, statSync, writeFileSync,
} from 'node:fs';
import {
  dirname, isAbsolute, join, relative, resolve,
} from 'node:path';

import { BUS_VERBS } from '../src/bus-core.mjs';
import { parseEventLog } from '../src/event-log.mjs';
import { withBusClient } from '../src/mcp-client.mjs';
import { runVerification } from '../src/verify.mjs';

class UsageError extends Error {}

function parseArgs(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) {
      throw new UsageError('expected --data-dir <path> --artifact <path> --out <path> [--task <text>]');
    }
    flags[name.slice(2)] = value;
  }
  for (const required of ['data-dir', 'artifact', 'out']) {
    if (!flags[required]) throw new UsageError(`missing --${required}`);
  }
  return flags;
}

function must(response, label) {
  if (!response?.ok) {
    const error = response?.error ?? `${label} failed without a structured error`;
    const failure = new Error(`${label}: ${error}`);
    failure.failClosed = Boolean(response?.failClosed);
    throw failure;
  }
  return response.result;
}

const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

function inside(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function evidenceIdentity(dataDir) {
  const path = join(dataDir, 'events.jsonl');
  const bytes = readFileSync(path);
  return {
    format: 'gaia-event-log-fixed-point/1',
    pathRole: 'data-dir/events.jsonl',
    bytes: bytes.byteLength,
    events: parseEventLog(bytes.toString('utf8'), { source: path }).length,
    sha256: digest(bytes),
  };
}

const serialize = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function main(argv) {
  const flags = parseArgs(argv);
  const dataDir = resolve(flags['data-dir']);
  const artifactPath = resolve(flags.artifact);
  const reportPath = resolve(flags.out);
  const task = flags.task ?? 'Review the supplied artifact';

  if (existsSync(reportPath)) throw new UsageError(`report already exists: ${reportPath}`);
  if (inside(dataDir, reportPath)) {
    throw new UsageError('the report must be outside the bus data directory');
  }
  if (!existsSync(artifactPath) || !statSync(artifactPath).isFile()) {
    throw new UsageError(`artifact is not a regular file: ${artifactPath}`);
  }

  const artifactBytes = readFileSync(artifactPath);
  const artifact = {
    path: artifactPath,
    bytes: artifactBytes.byteLength,
    sha256: digest(artifactBytes),
  };

  // Reserve the receipt before the first bus write. Any later failure can therefore
  // leave a structured terminal record instead of stranding an unexplained log.
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, serialize({
    ok: false,
    status: 'running',
    command: 'factory-smoke',
    execution: 'coordination-tracer; no code execution',
    dataDir,
    artifact,
    task,
  }), { encoding: 'utf8', flag: 'wx' });

  let ownsDataDir = false;
  try {
    // The directory itself is the run claim. mkdir without `recursive` is atomic, so
    // two commands cannot both pass a check-then-act window and verify a mixed log.
    mkdirSync(dirname(dataDir), { recursive: true });
    try {
      mkdirSync(dataDir);
      ownsDataDir = true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        throw new UsageError(`factory smoke requires a fresh data directory: ${dataDir}`);
      }
      throw error;
    }

    const exchange = await withBusClient(dataDir, async (client) => {
    const coordinator = must(await client.call('register', {
      actorId: 'factory-coordinator', kind: 'coordinator', capabilities: ['observe', 'report'],
    }), 'register coordinator');
    const builder = must(await client.call('register', {
      actorId: 'factory-builder', kind: 'worker', capabilities: ['read', 'draft', 'report'],
    }), 'register builder');
    const reviewer = must(await client.call('register', {
      actorId: 'factory-reviewer', kind: 'reviewer', capabilities: ['read', 'observe', 'report'],
    }), 'register reviewer');

    const taskMessage = must(await client.call('send', {
      from: coordinator.ref,
      to: builder.ref,
      text: JSON.stringify({ task, artifact }),
      kind: 'factory-task',
      expectsReply: true,
      requestedAuthority: ['read', 'report'],
    }), 'send task');
    must(await client.call('inbox', { actorId: builder.ref }), 'read builder inbox');
    const taskAck = must(await client.call('ack', {
      actorId: builder.ref, messageId: taskMessage.messageId, note: 'task received',
    }), 'ack task');

    const candidateMessage = must(await client.call('send', {
      from: builder.ref,
      to: coordinator.ref,
      text: JSON.stringify({ artifact, status: 'candidate-ready' }),
      kind: 'artifact-candidate',
      correlationId: taskMessage.correlationId,
      requestedAuthority: ['report'],
    }), 'send candidate');
    must(await client.call('inbox', { actorId: coordinator.ref }), 'read coordinator inbox');
    const candidateAck = must(await client.call('ack', {
      actorId: coordinator.ref, messageId: candidateMessage.messageId, note: 'candidate recorded',
    }), 'ack candidate');

    const handoff = must(await client.call('handoff', {
      from: builder.ref,
      to: reviewer.ref,
      summary: JSON.stringify({ artifact, review: 'independent artifact review requested' }),
      correlationId: taskMessage.correlationId,
      replyTo: coordinator.ref,
      requestedAuthority: ['read', 'report'],
    }), 'handoff to reviewer');

    const verdictMessage = must(await client.call('send', {
      from: reviewer.ref,
      to: coordinator.ref,
      text: JSON.stringify({ artifact, verdict: 'SMOKE_ACCEPT', scope: 'coordination path only' }),
      kind: 'review-verdict',
      correlationId: taskMessage.correlationId,
      requestedAuthority: ['report'],
    }), 'send verdict');
    must(await client.call('inbox', { actorId: coordinator.ref }), 'read verdict inbox');
    const verdictAck = must(await client.call('ack', {
      actorId: coordinator.ref, messageId: verdictMessage.messageId, note: 'verdict recorded',
    }), 'ack verdict');

    must(await client.call('heartbeat', {
      actorId: coordinator.ref, note: 'factory smoke complete',
    }), 'heartbeat coordinator');

    return {
      actors: {
        coordinator: coordinator.ref,
        builder: builder.ref,
        reviewer: reviewer.ref,
      },
      messages: [taskMessage.messageId, candidateMessage.messageId, verdictMessage.messageId],
      acknowledgements: [taskAck, candidateAck, verdictAck],
      handoff,
      correlationId: taskMessage.correlationId,
    };
    });

    const evidenceBefore = evidenceIdentity(dataDir);
    const verification = await runVerification({
      dataDir,
      evidencePath: join(dataDir, 'events.jsonl'),
      requireEvidence: true,
    });
    const evidenceLog = evidenceIdentity(dataDir);
    if (evidenceBefore.sha256 !== evidenceLog.sha256
      || evidenceBefore.bytes !== evidenceLog.bytes
      || evidenceBefore.events !== evidenceLog.events) {
      throw new Error('the evidence log changed while it was being verified');
    }
    if (!verification.ok || !verification.evidenceOk) {
      throw new Error('the factory exchange did not satisfy Gaia evidence gates');
    }

    const report = {
      ok: true,
      status: 'completed',
      command: 'factory-smoke',
      execution: 'coordination-tracer; no code execution',
      dataDir,
      artifact,
      task,
      ...exchange,
      evidenceLog,
      verification: {
        ok: verification.ok,
        evidenceOk: verification.evidenceOk,
        evidenceGatesResult: verification.evidenceGatesResult,
      },
      toolSurface: [...BUS_VERBS].sort(),
    };

    const completed = serialize(report);
    writeFileSync(reportPath, completed, 'utf8');
    process.stdout.write(completed);
  } catch (error) {
    const failed = {
      ok: false,
      status: 'failed',
      command: 'factory-smoke',
      execution: 'coordination-tracer; no code execution',
      dataDir,
      artifact,
      task,
      evidenceLog: ownsDataDir && existsSync(join(dataDir, 'events.jsonl'))
        ? evidenceIdentity(dataDir)
        : null,
      error: {
        name: error.name,
        message: error.message,
        failClosed: Boolean(error.failClosed),
      },
    };
    writeFileSync(reportPath, serialize(failed), 'utf8');
    error.reportPath = reportPath;
    throw error;
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  const receipt = error.reportPath ? `; failure receipt: ${error.reportPath}` : '';
  process.stderr.write(`${error.name}: ${error.message}${receipt}\n`);
  process.exitCode = error instanceof UsageError ? 2 : error.failClosed ? 3 : 1;
}
