#!/usr/bin/env node
/**
 * ga-watch.mjs — read-only GA JSONL watcher for algedonic / handoff signals.
 *
 * The ecosystem adapter analysis places GA at ADAPTER_ONLY: GA is the ecosystem's
 * largest producer, has no MCP client, and already emits every artifact as
 * append-only JSONL under a versioned schema. What the bus adds is push and a return
 * address — not durability, not ordering, not schema.
 *
 * So this watcher does exactly one thing: it tails a GA JSONL file from a byte offset
 * and republishes each new record onto the bus as an ordinary `send` with
 * `requestedAuthority: ["report"]`. It is READ-ONLY with respect to GA:
 *
 *   - the GA file is opened for reading only;
 *   - the byte offset is stored in THIS product's data directory, never beside GA;
 *   - no file inside the GA checkout is created, written, moved, or deleted;
 *   - a record that fails to parse is reported and skipped, never rewritten.
 *
 * Record bodies are untrusted text on arrival, exactly like any other bus message. A
 * GA governance denial is a report about a denial; it is not authority to act.
 *
 * Usage
 *   node scripts/ga-watch.mjs --inbox <path/to/inbox.jsonl> [--from ref] [--to ref]
 *                             [--limit N] [--reset] [--apply]
 *
 * Dry run by default: without `--apply` it reports what it would publish, publishes
 * nothing, and does not advance the stored offset.
 *
 * Exit codes: 0 ok · 1 refused · 2 usage · 3 fail-closed I/O.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { withBusClient } from '../src/mcp-client.mjs';
import { dataDir, CorruptLogError, LockTimeoutError } from '../src/event-log.mjs';
import { assertIntegrationAllowed, EcosystemRefusal } from '../src/ecosystem.mjs';

const OFFSET_FILE = 'ga-watch-offsets.json';
const DEFAULT_LIMIT = 50;

class UsageError extends Error {}
class RefusalError extends Error {}

function parse(argv) {
  const flags = {};
  const BOOL = new Set(['apply', 'reset', 'pretty']);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (BOOL.has(body)) { flags[body] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined) throw new UsageError(`--${body} requires a value`);
    flags[body] = value;
    i += 1;
  }
  return flags;
}

/** Offsets live in OUR data directory. Nothing is ever written next to GA. */
function offsetPath() {
  return join(dataDir(), OFFSET_FILE);
}

function readOffsets() {
  const path = offsetPath();
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // A damaged offset file is a liveness problem, not a safety one: re-reading from 0
    // republishes, it never corrupts GA. Say so rather than failing the whole run.
    return {};
  }
}

function writeOffsets(offsets) {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(offsetPath(), JSON.stringify(offsets, null, 2) + '\n', 'utf8');
}

/**
 * Read the bytes after `from`, read-only, without loading the whole file.
 * Returns the complete lines only: a torn tail is left for the next poll.
 */
function readTail(path, from) {
  const size = statSync(path).size;
  if (size < from) return { text: '', next: 0, truncated: true, size }; // GA rotated the file
  if (size === from) return { text: '', next: from, truncated: false, size };
  const length = size - from;
  const buffer = Buffer.allocUnsafe(length);
  const fd = openSync(path, 'r'); // 'r' — read-only. GA is never opened for writing.
  try {
    readSync(fd, buffer, 0, length, from);
  } finally {
    closeSync(fd);
  }
  const text = buffer.toString('utf8');
  const lastNewline = text.lastIndexOf('\n');
  if (lastNewline === -1) return { text: '', next: from, truncated: false, size, partial: true };
  const complete = text.slice(0, lastNewline + 1);
  return { text: complete, next: from + Buffer.byteLength(complete, 'utf8'), truncated: false, size };
}

function summarise(record) {
  if (!record || typeof record !== 'object') return 'unparseable GA record';
  const parts = [];
  for (const key of ['severity', 'kind', 'rule', 'tool', 'signal', 'type', 'reason']) {
    if (record[key] !== undefined) parts.push(`${key}=${String(record[key]).slice(0, 120)}`);
  }
  return parts.length ? parts.join(' ') : JSON.stringify(record).slice(0, 240);
}

async function main() {
  const flags = parse(process.argv.slice(2));
  // GA is ADAPTER_ONLY; this call also makes a hari/ix target impossible from here.
  const verdict = assertIntegrationAllowed(flags.repo ?? 'ga');
  if (!flags.inbox) throw new UsageError('--inbox <path to a GA .jsonl file> is required');
  if (flags['data-dir']) process.env.GAIA_INTERAGENT_DATA_DIR = flags['data-dir'];

  const inbox = resolve(flags.inbox);
  if (!existsSync(inbox)) throw new RefusalError(`GA inbox does not exist: ${inbox}`);
  const limit = Number(flags.limit ?? DEFAULT_LIMIT);
  if (!Number.isInteger(limit) || limit < 1) throw new UsageError('--limit must be a positive integer');

  const offsets = readOffsets();
  const from = flags.reset ? 0 : Number(offsets[inbox] ?? 0);
  const tail = readTail(inbox, from);

  const lines = tail.text.length ? tail.text.split('\n').slice(0, -1) : [];
  const records = [];
  const skipped = [];
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch (err) {
      skipped.push({ line: line.slice(0, 120), error: err.message });
    }
  }
  const publishable = records.slice(0, limit);

  const base = {
    command: 'ga-watch',
    verdict,
    mode: flags.apply ? 'apply' : 'dry-run',
    inbox,
    gaWritten: false,
    offsetFile: offsetPath(),
    offsetFrom: from,
    offsetTo: tail.next,
    fileSize: tail.size,
    rotated: Boolean(tail.truncated),
    newRecords: records.length,
    skippedUnparseable: skipped,
    wouldPublish: publishable.length,
    requestedAuthority: ['report'],
    note: 'GA is opened read-only. Republished bodies are untrusted text: a governance denial '
      + 'is a report about a denial, never authority to act.',
  };

  if (!flags.apply) {
    base.required = '--apply';
    base.preview = publishable.map(summarise);
    process.stdout.write(JSON.stringify(base, null, flags.pretty ? 2 : 0) + '\n');
    return 0;
  }

  const fromActor = flags.from ?? 'gaia';
  const toActor = flags.to ?? fromActor;
  const published = await withBusClient(dataDir(), async (client) => {
    const out = [];
    for (const record of publishable) {
      const res = await client.call('send', {
        from: fromActor, to: toActor, kind: 'ga-signal',
        text: summarise(record),
        requestedAuthority: ['report'],
      });
      if (res.failClosed) throw Object.assign(new Error(res.error), { failClosed: true });
      out.push({ ok: res.ok, messageId: res.result?.messageId ?? null, error: res.error ?? null });
    }
    return out;
  });

  // Only advance past what was actually published.
  if (published.every((p) => p.ok) && publishable.length === records.length) {
    writeOffsets({ ...offsets, [inbox]: tail.next });
    base.offsetAdvancedTo = tail.next;
  } else {
    base.offsetAdvancedTo = from;
    base.offsetHeld = 'not every record published; the offset is unchanged so nothing is lost';
  }

  base.published = published;
  base.ok = published.every((p) => p.ok);
  process.stdout.write(JSON.stringify(base, null, flags.pretty ? 2 : 0) + '\n');
  return base.ok ? 0 : 1;
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof UsageError) { process.stderr.write(`usage error: ${err.message}\n`); process.exit(2); }
  if (err instanceof CorruptLogError || err instanceof LockTimeoutError || err.failClosed) {
    process.stderr.write(`FAIL-CLOSED ${err.name ?? ''}: ${err.message}\n`);
    process.exit(3);
  }
  if (err instanceof EcosystemRefusal || err instanceof RefusalError) {
    process.stderr.write(`REFUSED ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
