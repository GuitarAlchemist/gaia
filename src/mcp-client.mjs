#!/usr/bin/env node
/**
 * mcp-client.mjs — minimal MCP stdio client, plus a standalone handshake check.
 *
 * As a module it gives the CLIs a real client (spawn, initialize, tools/list,
 * tools/call). As a script it performs a complete, real MCP exchange against
 * mcp-server.mjs and exits 0 on success — the independent protocol gate.
 *
 * Run standalone:  node src/mcp-client.mjs
 */

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
export const SERVER = join(here, 'mcp-server.mjs');

/** Identity this product presents to its own server. */
export const CLIENT_INFO = { name: 'gaia-interagent-cli', version: '1.0.0' };
export const MCP_PROTOCOL_VERSION = '2025-06-18';

export class McpStdioClient {
  #child;
  #pending = new Map();
  #nextId = 1;
  #stderr = [];
  #exited = null;

  constructor({ dataDir, showStderr = false } = {}) {
    this.dataDir = dataDir;
    this.showStderr = showStderr;
  }

  /**
   * The one Error describing a dead server, tagged so a caller can distinguish a
   * fail-closed I/O condition (nothing was written; escalate) from a bus refusal
   * (retry with a better address). Matching the server's own stderr is the only
   * channel that survives the process boundary; both ends of that coupling ship in
   * this plugin, and the server writes those two names itself.
   */
  #exitError(suffix = '') {
    const { code, reason, failClosed } = this.#exited;
    const err = new Error(`server exited with code ${code}${suffix}${reason ? `: ${reason}` : ''}`);
    err.serverExitCode = code;
    err.failClosed = failClosed;
    return err;
  }

  async start() {
    this.#child = spawn(process.execPath, [SERVER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...(this.dataDir ? { GAIA_INTERAGENT_DATA_DIR: this.dataDir } : {}) },
    });

    createInterface({ input: this.#child.stdout, crlfDelay: Infinity }).on('line', (line) => {
      if (!line.trim()) return;
      const msg = JSON.parse(line);
      const waiter = this.#pending.get(msg.id);
      if (!waiter) return;
      this.#pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    });

    createInterface({ input: this.#child.stderr, crlfDelay: Infinity }).on('line', (line) => {
      this.#stderr.push(line);
      if (this.showStderr) process.stderr.write(`${line}\n`);
    });

    // A server that fails closed (corrupt log, lock contention) exits at startup.
    // Reject anything in flight immediately rather than making the caller wait out
    // the request timeout, and carry the server's own reason across the boundary.
    this.#child.on('close', (code) => {
      const reason = this.#stderr.filter((l) => /FATAL|Error/i.test(l)).slice(-1)[0] ?? this.#stderr.slice(-1)[0] ?? '';
      // Classify once, here, at the boundary that destroys the information. A
      // LockTimeoutError or a CorruptLogError raised inside the server is an ordinary
      // `Error` by the time it reaches this process, so "the bus could not tell"
      // becomes indistinguishable from "the bus said no" unless it is captured now.
      this.#exited = { code, reason, failClosed: /LockTimeoutError|CorruptLogError|UnreplayableLogError/.test(reason) };
      for (const [id, waiter] of this.#pending) {
        this.#pending.delete(id);
        waiter.reject(this.#exitError(' before responding'));
      }
    });

    // Wait for the server banner so we know it is actually listening on stdio.
    await new Promise((resolve) => setTimeout(resolve, 120));
    return this;
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      if (this.#exited) {
        reject(this.#exitError(''));
        return;
      }
      this.#pending.set(id, { resolve, reject });
      this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`timeout waiting for ${method}`));
      }, 10_000);
    });
  }

  notify(method, params) {
    this.#child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** tools/call that unwraps structuredContent and surfaces bus-level errors. */
  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args });
    const payload = res.structuredContent ?? JSON.parse(res.content[0].text);
    return { ...payload, isError: res.isError };
  }

  get stderrLines() { return [...this.#stderr]; }

  async close() {
    if (this.#exited) return;
    this.#child.stdin.end();
    await new Promise((resolve) => this.#child.once('close', resolve));
  }
}

/**
 * Start a client, complete the MCP handshake, run `fn`, and always close.
 *
 * Both shipped CLIs go through here, so there is exactly one place that speaks the
 * handshake and exactly one transport. There is no side door onto the bus.
 */
export async function withBusClient(dataDir, fn) {
  const client = await new McpStdioClient({ dataDir }).start();
  try {
    await client.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });
    client.notify('notifications/initialized', {});
    return await fn(client);
  } finally {
    await client.close();
  }
}

/** Full MCP handshake: initialize -> initialized -> tools/list -> tools/call. */
export async function handshakeCheck({ verbose = true } = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'gaia-interagent-handshake-'));

  const client = await new McpStdioClient({ dataDir }).start();
  const say = (...a) => { if (verbose) console.log(...a); };
  const failures = [];
  const expect = (cond, label) => { if (!cond) failures.push(label); say(`  ${cond ? 'PASS' : 'FAIL'}  ${label}`); };

  try {
    say('MCP stdio exchange against src/mcp-server.mjs');

    const init = await client.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'gaia-interagent-handshake-check', version: '1.0.0' },
    });
    expect(typeof init.protocolVersion === 'string', `initialize -> protocolVersion ${init.protocolVersion}`);
    expect(init.serverInfo?.name === 'gaia-interagent-bus', `initialize -> serverInfo.name ${init.serverInfo?.name}`);

    client.notify('notifications/initialized', {});

    const { tools } = await client.request('tools/list', {});
    const names = tools.map((t) => t.name).sort();
    expect(
      JSON.stringify(names) === JSON.stringify(['ack', 'handoff', 'heartbeat', 'inbox', 'register', 'send']),
      `tools/list -> exactly [${names.join(', ')}]`,
    );

    const reg = await client.call('register', { actorId: 'handshake-probe', kind: 'probe', capabilities: ['observe'] });
    expect(reg.ok === true, `tools/call register -> ok (ref ${reg.result?.ref})`);

    const beat = await client.call('heartbeat', { actorId: reg.result.ref, note: 'protocol check' });
    expect(beat.ok === true, 'tools/call heartbeat -> ok');
    expect(beat.state.actors.some((a) => a.name === 'handshake-probe' && a.ref === reg.result.ref), 'tools/call returns full bus state');

    const pong = await client.request('ping', {});
    expect(typeof pong === 'object', 'ping -> {}');

    const bad = await client.request('no/such/method', {}).then(() => null, (e) => e);
    expect(bad instanceof Error && /-32601/.test(bad.message), 'unknown method -> JSON-RPC -32601');
  } finally {
    await client.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 });
  }

  say(failures.length === 0 ? 'MCP exchange OK\n' : `MCP exchange FAILED: ${failures.join('; ')}\n`);
  return failures;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const failures = await handshakeCheck({ verbose: true });
  process.exit(failures.length === 0 ? 0 : 1);
}
