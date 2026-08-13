#!/usr/bin/env node
/**
 * wmux-lanes.mjs — correlate visible wmux Claude lanes with bus actors.
 *
 * This is an ADAPTER. It does not implement terminal control: every wmux operation is
 * delegated to the existing peer-sessions-wmux helper (`wmux_peer.py`), which owns
 * spawn/send/screen/stop/reap and their fail-closed rules. Nothing here re-derives
 * surface state from wmux directly, and nothing here duplicates that logic.
 *
 * What this adapter adds, and only this:
 *   - a durable bus identity per visible lane, correlated to its surfaceId/agentId;
 *   - the supported live-lane limit (4 by default; see src/lanes.mjs);
 *   - artifact-handoff consumption recorded as an ordinary `ack`;
 *   - a stale/exited sweep recorded as an ordinary `send`.
 *
 * It never kills a process. It never passes `--yes` to the peer tool, so no surface
 * is ever closed by this script — `reap-preview` shows the peer tool's own dry run
 * and stops there. Reaping stays a deliberate human step in the peer tool.
 *
 * Usage
 *   node scripts/wmux-lanes.mjs list          [--workspace W]
 *   node scripts/wmux-lanes.mjs register      [--workspace W] [--max-lanes N]
 *                                             [--experimental-lanes] [--apply]
 *   node scripts/wmux-lanes.mjs post          --surface S --text T [--from ref] [--apply]
 *   node scripts/wmux-lanes.mjs consume       --surface S --artifact PATH [--apply]
 *   node scripts/wmux-lanes.mjs sweep         [--workspace W] [--apply]
 *   node scripts/wmux-lanes.mjs reap-preview  [--workspace W]
 *
 * Every mutating command is DRY RUN by default; `--apply` performs it.
 *
 * Peer tool location: $GAIA_INTERAGENT_WMUX_PEER, else
 *   %USERPROFILE%/.codex/skills/peer-sessions-wmux/scripts/wmux_peer.py
 * A `.py` peer runs under `python`; a `.mjs`/`.js` peer runs under this Node binary,
 * which is what the test suite uses to get a real process seam without wmux.
 *
 * Exit codes: 0 ok · 1 refused (lane limit, unknown surface) · 2 usage · 3 fail-closed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

import { withBusClient } from '../src/mcp-client.mjs';
import { replay, snapshot } from '../src/bus-core.mjs';
import { dataDir, readEventsConsistent, CorruptLogError, LockTimeoutError } from '../src/event-log.mjs';
import { resolveLaneLimit, admitLane, LaneLimitError } from '../src/lanes.mjs';

const LANE_KIND = 'wmux-lane';
const SURFACE_CAP = 'wmux:surface=';
const AGENT_CAP = 'wmux:agent=';
const WORKSPACE_CAP = 'wmux:workspace=';
/** Artifact bodies are quoted into a bus message; keep them small and bounded. */
const MAX_ARTIFACT_BYTES = 64 * 1024;

class UsageError extends Error {}
class RefusalError extends Error {}

function peerToolPath() {
  const explicit = process.env.GAIA_INTERAGENT_WMUX_PEER;
  if (explicit) return resolve(explicit);
  return join(homedir(), '.codex', 'skills', 'peer-sessions-wmux', 'scripts', 'wmux_peer.py');
}

/**
 * Run the peer tool and parse its JSON. Fails closed: a non-zero exit, empty output,
 * or unparseable output is an error, never an empty result.
 *
 * `--yes` is rejected here rather than merely never passed, so a future edit cannot
 * quietly give this adapter the power to close surfaces.
 */
function peer(...args) {
  if (args.includes('--yes')) {
    throw new RefusalError('this adapter never passes --yes to the peer tool; reaping stays a deliberate human step');
  }
  const tool = peerToolPath();
  if (!existsSync(tool)) {
    throw new RefusalError(`peer-sessions-wmux helper not found at ${tool}. Set GAIA_INTERAGENT_WMUX_PEER to its path.`);
  }
  const runner = tool.endsWith('.py') ? 'python' : process.execPath;
  const res = spawnSync(runner, [tool, ...args], { encoding: 'utf8' });
  if (res.error) throw new RefusalError(`peer tool failed to start: ${res.error.message}`);
  const out = (res.stdout ?? '').trim();
  if (res.status !== 0) throw new RefusalError(`peer tool exited ${res.status}: ${(res.stderr ?? out).trim().slice(0, 400)}`);
  if (!out) throw new RefusalError('peer tool returned no output; refusing to treat silence as an empty result');
  try {
    return JSON.parse(out);
  } catch {
    throw new RefusalError(`peer tool returned non-JSON output: ${out.slice(0, 200)}`);
  }
}

function peerAgents(workspace) {
  const args = ['list'];
  if (workspace) args.push('--workspace', workspace);
  const payload = peer(...args);
  if (!payload || !Array.isArray(payload.agents)) {
    throw new RefusalError("peer tool returned no exact 'agents' array; failing closed");
  }
  return payload.agents;
}

const capValue = (caps, prefix) => (caps ?? []).find((c) => c.startsWith(prefix))?.slice(prefix.length) ?? null;

/** Bus actors that represent wmux lanes, keyed by surfaceId. */
function laneActors() {
  const state = replay(readEventsConsistent());
  const bySurface = new Map();
  for (const actor of Object.values(state.actors)) {
    if (actor.kind !== LANE_KIND) continue;
    const surface = capValue(actor.declaredCapabilities, SURFACE_CAP);
    if (surface) bySurface.set(surface, actor);
  }
  return { state, bySurface };
}

function parse(argv) {
  const [command, ...rest] = argv;
  const flags = {};
  const BOOL = new Set(['apply', 'experimental-lanes', 'pretty']);
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new UsageError(`unexpected argument: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (BOOL.has(body)) { flags[body] = true; continue; }
    const value = rest[i + 1];
    if (value === undefined) throw new UsageError(`--${body} requires a value`);
    flags[body] = value;
    i += 1;
  }
  return { command, flags };
}

const emit = (payload, flags) => process.stdout.write(JSON.stringify(payload, null, flags.pretty ? 2 : 0) + '\n');

// ---------------------------------------------------------------------------

function cmdList(flags) {
  const agents = peerAgents(flags.workspace);
  const { bySurface } = laneActors();
  const rows = agents.map((a) => ({
    agentId: a.agentId ?? null,
    surfaceId: a.surfaceId ?? null,
    label: a.label ?? null,
    status: a.status ?? null,
    workspaceId: a.workspaceId ?? null,
    busRef: bySurface.get(a.surfaceId)?.ref ?? null,
    busStatus: bySurface.get(a.surfaceId)?.status ?? null,
  }));
  const running = rows.filter((r) => r.status === 'running');
  emit({
    ok: true, command: 'list', peerTool: peerToolPath(),
    lanes: rows, running: running.length, correlated: rows.filter((r) => r.busRef).length,
  }, flags);
  return 0;
}

async function cmdRegister(flags) {
  const { limit, experimental, note } = resolveLaneLimit({
    requested: flags['max-lanes'] === undefined ? null : Number(flags['max-lanes']),
    experimental: Boolean(flags['experimental-lanes']),
  });

  const agents = peerAgents(flags.workspace).filter((a) => a.status === 'running');
  const { bySurface } = laneActors();

  // Count LIVE lanes, which is what the limit is documented to bound: registered lane
  // actors whose surface the peer tool currently reports as running.
  //
  // This used to count lane actors whose BUS status was 'online'. `status` is derived
  // from STALE_AFTER_MS against the newest event in the log, and nothing in this
  // product heartbeats a lane actor — so a registered, running lane stopped counting
  // 30s after its last bus activity, and lanes 5 through 8 could then register on the
  // default path with no --max-lanes and no --experimental-lanes. Lanes that are
  // thinking rather than calling the bus are exactly the lanes that go quiet.
  //
  // The set is intersected with the running surfaces rather than being the count of
  // every registered lane actor: the log is append-only, so counting registrations
  // would turn the cap into a permanent ceiling that a retired lane never frees.
  const runningSurfaces = new Set(agents.map((a) => a.surfaceId).filter(Boolean));
  const already = [...bySurface.keys()].filter((surface) => runningSurfaces.has(surface)).length;

  const plan = [];
  let live = already;
  for (const agent of agents) {
    if (!agent.surfaceId) continue;
    if (bySurface.has(agent.surfaceId)) {
      plan.push({ surfaceId: agent.surfaceId, action: 'already-registered', ref: bySurface.get(agent.surfaceId).ref });
      continue;
    }
    admitLane({ live, limit }); // throws LaneLimitError past the limit
    live += 1;
    plan.push({
      surfaceId: agent.surfaceId,
      action: 'register',
      actorId: agent.label ? `claude:${agent.label}` : `claude:${agent.surfaceId}`,
      capabilities: [
        `${WORKSPACE_CAP}${agent.workspaceId ?? 'unknown'}`,
        `${SURFACE_CAP}${agent.surfaceId}`,
        `${AGENT_CAP}${agent.agentId ?? 'unknown'}`,
      ],
    });
  }

  const base = {
    command: 'register', mode: flags.apply ? 'apply' : 'dry-run',
    laneLimit: limit, experimentalLaneLimit: experimental, laneEvidence: note,
    liveBefore: already, plan,
  };
  if (!flags.apply) { emit({ ok: true, ...base, required: '--apply' }, flags); return 0; }

  const registered = await withBusClient(dataDir(), async (client) => {
    const out = [];
    for (const step of plan.filter((p) => p.action === 'register')) {
      const res = await client.call('register', { actorId: step.actorId, kind: LANE_KIND, capabilities: step.capabilities });
      if (res.failClosed) throw Object.assign(new Error(res.error), { failClosed: true });
      out.push({ surfaceId: step.surfaceId, ok: res.ok, ref: res.result?.ref ?? null, error: res.error ?? null });
    }
    return out;
  });
  emit({ ok: registered.every((r) => r.ok), ...base, registered }, flags);
  return registered.every((r) => r.ok) ? 0 : 1;
}

async function cmdPost(flags) {
  if (!flags.surface) throw new UsageError('post requires --surface');
  if (!flags.text) throw new UsageError('post requires --text');
  const { bySurface } = laneActors();
  const lane = bySurface.get(flags.surface);
  if (!lane) throw new RefusalError(`surface ${flags.surface} has no registered lane actor; run \`register --apply\` first`);
  const from = flags.from ?? 'gaia';

  const base = {
    command: 'post', mode: flags.apply ? 'apply' : 'dry-run',
    surfaceId: flags.surface, to: lane.ref, from,
    durableSend: true, terminalDelivery: Boolean(flags.apply),
    note: 'The durable bus record is the contract. Terminal submission is delivery evidence only — '
      + 'never acceptance, never completion.',
  };
  if (!flags.apply) { emit({ ok: true, ...base, required: '--apply' }, flags); return 0; }

  const sent = await withBusClient(dataDir(), async (client) => client.call('send', {
    from, to: lane.ref, text: flags.text, kind: 'lane-brief',
    correlationId: flags.correlationId, replyTo: from, expectsReply: true,
  }));
  if (sent.failClosed) { emit({ ok: false, ...base, error: sent.error, failClosed: true }, flags); return 3; }
  if (!sent.ok) { emit({ ok: false, ...base, error: sent.error }, flags); return 1; }

  // Visible delivery is delegated; this adapter does not drive the terminal itself.
  const delivery = peer('send', '--surface', flags.surface, '--message', flags.text, '--expect-progress-seconds', '10');
  emit({ ok: true, ...base, message: sent.result, delivery }, flags);
  return 0;
}

async function cmdConsume(flags) {
  if (!flags.surface) throw new UsageError('consume requires --surface');
  if (!flags.artifact) throw new UsageError('consume requires --artifact');
  const artifact = resolve(flags.artifact);
  if (!existsSync(artifact)) throw new RefusalError(`artifact does not exist: ${artifact}`);
  const size = statSync(artifact).size;
  if (size > MAX_ARTIFACT_BYTES) throw new RefusalError(`artifact is ${size} bytes, over the ${MAX_ARTIFACT_BYTES}-byte cap`);
  // Read-only. The artifact is evidence to summarise; it is never executed and its
  // content grants no authority, exactly like any other inbound text.
  const body = readFileSync(artifact, 'utf8');

  const { state, bySurface } = laneActors();
  const lane = bySurface.get(flags.surface);
  if (!lane) throw new RefusalError(`surface ${flags.surface} has no registered lane actor`);

  const snap = snapshot(state);
  const pending = snap.messages.filter((m) => !m.acked && m.route.startsWith(`${lane.ref}(`) && m.kind === 'handoff');
  const coordinatorRef = pending.length ? pending[0].route.split(' -> ')[1].split('(')[0] : null;

  const base = {
    command: 'consume', mode: flags.apply ? 'apply' : 'dry-run',
    surfaceId: flags.surface, laneRef: lane.ref,
    artifact, artifactBytes: size, artifactTrust: 'untrusted-text',
    pendingHandoffs: pending.map((m) => m.messageId),
    excerpt: body.slice(0, 400),
    note: 'Consuming an artifact is an acknowledgement of receipt. It is not verification, '
      + 'approval, or acceptance of the work it describes.',
  };
  if (!flags.apply) { emit({ ok: true, ...base, required: '--apply' }, flags); return 0; }
  if (!pending.length) { emit({ ok: true, ...base, acked: [] }, flags); return 0; }

  const acked = await withBusClient(dataDir(), async (client) => {
    const out = [];
    for (const m of pending) {
      const res = await client.call('ack', { actorId: coordinatorRef, messageId: m.messageId, note: `artifact consumed: ${artifact}` });
      out.push({ messageId: m.messageId, ok: res.ok, error: res.error ?? null });
    }
    return out;
  });
  emit({ ok: acked.every((a) => a.ok), ...base, acked }, flags);
  return acked.every((a) => a.ok) ? 0 : 1;
}

async function cmdSweep(flags) {
  const agents = peerAgents(flags.workspace);
  const newest = new Map();
  for (const a of agents) {
    if (!a.surfaceId) continue;
    const prev = newest.get(a.surfaceId);
    if (!prev || Number(a.spawnTime ?? 0) > Number(prev.spawnTime ?? 0)) newest.set(a.surfaceId, a);
  }

  const { bySurface } = laneActors();
  const findings = [];
  for (const [surface, actor] of bySurface) {
    const agent = newest.get(surface);
    const agentStatus = agent?.status ?? 'unmapped';
    findings.push({
      surfaceId: surface, ref: actor.ref, name: actor.name,
      agentStatus, busStatus: actor.status,
      classification: agentStatus === 'exited' ? 'exited'
        : agentStatus === 'unmapped' ? 'unmapped-surface'
          : actor.status === 'stale' ? 'stale' : 'live',
    });
  }

  const toMark = findings.filter((f) => f.classification === 'exited' || f.classification === 'stale');
  const base = {
    command: 'sweep', mode: flags.apply ? 'apply' : 'dry-run',
    findings,
    live: findings.filter((f) => f.classification === 'live').length,
    wouldMark: toMark.map((f) => f.ref),
    killsNothing: true,
    note: 'Marking is one ordinary bus `send` per lane, recorded durably. No process is signalled, '
      + 'no surface is closed, and no unrelated process is touched. Closing an exited surface is a '
      + 'separate, deliberate step in the peer tool.',
  };
  if (!flags.apply) { emit({ ok: true, ...base, required: '--apply' }, flags); return 0; }
  if (!toMark.length) { emit({ ok: true, ...base, marked: [] }, flags); return 0; }

  const coordinator = flags.from ?? 'gaia';
  const marked = await withBusClient(dataDir(), async (client) => {
    const out = [];
    for (const f of toMark) {
      const res = await client.call('send', {
        from: coordinator, to: coordinator, kind: `lane-${f.classification}`,
        text: `lane ${f.ref} (${f.name}) on surface ${f.surfaceId} is ${f.classification}; agent status ${f.agentStatus}`,
      });
      out.push({ ref: f.ref, ok: res.ok, error: res.error ?? null, messageId: res.result?.messageId ?? null });
    }
    return out;
  });
  emit({ ok: marked.every((m) => m.ok), ...base, marked }, flags);
  return marked.every((m) => m.ok) ? 0 : 1;
}

function cmdReapPreview(flags) {
  const args = ['reap'];
  if (flags.workspace) args.push('--workspace', flags.workspace);
  const report = peer(...args); // no --yes, ever: this is the peer tool's own dry run
  emit({
    ok: true, command: 'reap-preview', closedNothing: true,
    note: 'This is the peer tool\'s dry run, unmodified. This adapter cannot close a surface: '
      + 'it refuses to pass --yes. Run the peer tool yourself when you have inspected the candidates.',
    peer: report,
  }, flags);
  return 0;
}

// ---------------------------------------------------------------------------

async function main() {
  const { command, flags } = parse(process.argv.slice(2));
  if (!command || command === 'help' || command === '--help') {
    const src = readFileSync(new URL(import.meta.url), 'utf8');
    process.stdout.write(src.slice(src.indexOf('/**'), src.indexOf('*/') + 2).replace(/^\s*\/?\*+ ?/gm, '').trimEnd() + '\n');
    return 0;
  }
  if (flags['data-dir']) process.env.GAIA_INTERAGENT_DATA_DIR = flags['data-dir'];

  switch (command) {
    case 'list': return cmdList(flags);
    case 'register': return cmdRegister(flags);
    case 'post': return cmdPost(flags);
    case 'consume': return cmdConsume(flags);
    case 'sweep': return cmdSweep(flags);
    case 'reap-preview': return cmdReapPreview(flags);
    default: throw new UsageError(`unknown command: ${command}`);
  }
}

try {
  process.exit(await main());
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`usage error: ${err.message}\n`);
    process.exit(2);
  }
  if (err instanceof CorruptLogError || err instanceof LockTimeoutError || err.failClosed) {
    process.stderr.write(`FAIL-CLOSED ${err.name ?? ''}: ${err.message}\n`);
    process.exit(3);
  }
  if (err instanceof LaneLimitError || err instanceof RefusalError) {
    process.stderr.write(`REFUSED ${err.message}\n`);
    process.exit(1);
  }
  process.stderr.write(`${err.name}: ${err.message}\n`);
  process.exit(1);
}
