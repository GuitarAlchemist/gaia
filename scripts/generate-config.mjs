#!/usr/bin/env node
/**
 * generate-config.mjs — write a client MCP configuration into a directory YOU name.
 *
 * Usage
 *   node scripts/generate-config.mjs --client codex  --out <dir> [--write] [--data-dir <dir>]
 *   node scripts/generate-config.mjs --client claude --out <dir> [--write] [--data-dir <dir>]
 *
 * Safety, in order of importance:
 *   1. `--out` is REQUIRED. There is no default output location, so there is no
 *      accident that lands in a global config file.
 *   2. Any `--out` inside ~/.codex, ~/.claude, ~/.claude.json or ~/.agents is refused,
 *      and so is the home directory ITSELF, by exact match: a client launched from
 *      $HOME auto-loads a .mcp.json found there, so writing one into $HOME installs an
 *      auto-loading MCP configuration user-wide. A subdirectory of $HOME is allowed —
 *      an exact match rather than a prefix ban, because tmpdir() lives under $HOME on
 *      Windows. The refusal runs before the --force/overwrite decision, so --force
 *      cannot reach a protected path.
 *      Identity is decided by the filesystem, not by the spelling: the 8.3 alias, the
 *      \\?\ and \\.\ namespaces, an admin-share UNC path for the same volume, and a
 *      junction all name the same directory as the root they point at, and all are
 *      refused. A directory that is NOT one of those roots stays writable however
 *      unusually it is spelled — see src/templates.mjs.
 *      This product never edits user-global client configuration, ever, and does not
 *      offer a flag that would.
 *   3. Dry run by default: without `--write` it prints the rendered file and creates
 *      nothing.
 *   4. `--out` inside the installed plugin is refused: generated config is user data.
 *
 * Codex output: <out>/config.toml — load with CODEX_HOME=<out>, or copy to a trusted
 * project's .codex/config.toml. Its `startup_timeout_sec` is deliberately larger than
 * the bus lock timeout; see src/ecosystem.mjs for why equality is a bug.
 *
 * Claude output: <out>/.mcp.json — load with
 *   claude --strict-mcp-config --mcp-config <out>/.mcp.json
 * which makes that file the only MCP source for the session and writes nothing global.
 *
 * Exit codes: 0 ok · 2 usage error or refused output directory.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { dataDir, LOCK_TIMEOUT_MS } from '../src/event-log.mjs';
import {
  renderCodexConfig, renderClaudeMcpConfig, assertWritableOutDir,
  bundledServerPath, ProtectedPathError, MCP_SERVER_KEY,
} from '../src/templates.mjs';

function parse(argv) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`unexpected argument: ${token}`);
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) { flags[body.slice(0, eq)] = body.slice(eq + 1); continue; }
    if (body === 'write' || body === 'force') { flags[body] = true; continue; }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${body} requires a value`);
    flags[body] = value;
    i += 1;
  }
  return flags;
}

const CLIENTS = {
  codex: { file: 'config.toml', render: renderCodexConfig },
  claude: { file: '.mcp.json', render: renderClaudeMcpConfig },
};

async function main() {
  const flags = parse(process.argv.slice(2));
  const client = flags.client;
  // Own-key test. `client in CLIENTS` walks the prototype chain, so `--client
  // constructor` skipped this allowlist entirely and destructured `{file, render}`
  // off a function — surfacing a node:path internal error instead of naming the two
  // clients that exist.
  if (!client || !Object.hasOwn(CLIENTS, client)) {
    throw new Error(`--client must be one of: ${Object.keys(CLIENTS).join(', ')}`);
  }
  if (!flags.out) {
    throw new Error('--out <dir> is required. This product never writes to a default or global config location.');
  }
  if (flags['data-dir']) process.env.GAIA_INTERAGENT_DATA_DIR = flags['data-dir'];

  const outDir = assertWritableOutDir(flags.out);
  const { file, render } = CLIENTS[client];
  const target = join(outDir, file);
  const content = render({
    serverPath: bundledServerPath(),
    dataDir: dataDir(),
    serverKey: MCP_SERVER_KEY,
    lockTimeoutMs: LOCK_TIMEOUT_MS,
  });

  if (!flags.write) {
    process.stdout.write(JSON.stringify({
      ok: true, command: 'generate-config', client, mode: 'dry-run', required: '--write',
      wouldWrite: target, bytes: Buffer.byteLength(content, 'utf8'),
      serverPath: bundledServerPath(), dataDir: dataDir(),
      globalConfigTouched: false,
    }) + '\n');
    process.stdout.write(content);
    return 0;
  }

  if (existsSync(target) && !flags.force) {
    throw new Error(`${target} already exists. Pass --force to overwrite it.`);
  }
  mkdirSync(outDir, { recursive: true });
  writeFileSync(target, content, 'utf8');
  process.stdout.write(JSON.stringify({
    ok: true, command: 'generate-config', client, mode: 'write', wrote: target,
    bytes: Buffer.byteLength(content, 'utf8'),
    serverPath: bundledServerPath(), dataDir: dataDir(),
    globalConfigTouched: false,
    load: client === 'codex'
      ? `CODEX_HOME=${outDir} codex mcp list`
      : `claude --strict-mcp-config --mcp-config ${target}`,
  }) + '\n');
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  const refused = err instanceof ProtectedPathError;
  process.stderr.write(`${refused ? 'REFUSED' : 'usage error'}: ${err.message}\n`);
  process.exit(2);
}
