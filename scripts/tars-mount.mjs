#!/usr/bin/env node
/**
 * tars-mount.mjs — generate a TARS runtime MCP mount. Zero TARS repo changes.
 *
 * The ecosystem adapter analysis places TARS at ADAPTER_ONLY: it is the only sibling
 * repo that is already an MCP client/host, so it can mount this bus at runtime via
 * its own `configure_mcp_server` tool with no code, no build, and no commit.
 *
 * This script therefore emits two artifacts into a directory YOU name:
 *   tars-configure_mcp_server.json  — arguments to paste into TARS's runtime tool
 *   tars-local-mcp_config.json      — a LOCAL, uncommitted config fragment
 *
 * It does not read, write, or even look at any TARS checkout. In particular it never
 * touches tars/v2/src/Tars.Interface.Ui/mcp_config.json, which is tracked and shared
 * with CI: putting an absolute machine path there breaks every other machine.
 *
 * Usage
 *   node scripts/tars-mount.mjs --out <dir> [--write] [--data-dir <dir>]
 *
 * Dry run by default. Exit codes: 0 ok · 2 usage error or refused output directory.
 */

import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { dataDir } from '../src/event-log.mjs';
import { renderTarsMount, assertWritableOutDir, bundledServerPath, ProtectedPathError, MCP_SERVER_KEY } from '../src/templates.mjs';
import { assertIntegrationAllowed, EcosystemRefusal } from '../src/ecosystem.mjs';

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

async function main() {
  const flags = parse(process.argv.slice(2));
  // Refuses outright for hari (REJECT) and ix (DEFER); TARS and GA are ADAPTER_ONLY.
  const verdict = assertIntegrationAllowed(flags.repo ?? 'tars');
  if (!flags.out) throw new Error('--out <dir> is required.');
  if (flags['data-dir']) process.env.GAIA_INTERAGENT_DATA_DIR = flags['data-dir'];

  const outDir = assertWritableOutDir(flags.out);
  const files = renderTarsMount({ serverPath: bundledServerPath(), dataDir: dataDir(), serverKey: MCP_SERVER_KEY });

  const report = {
    ok: true,
    command: 'tars-mount',
    verdict,
    mode: flags.write ? 'write' : 'dry-run',
    outDir,
    files: Object.keys(files),
    tarsRepoTouched: false,
    warning: 'Runtime mount only. Do NOT commit this into tars/v2/src/Tars.Interface.Ui/mcp_config.json — '
      + 'that file is tracked and the path below is specific to this machine. '
      + 'Reverse by calling configure_mcp_server again with the entry removed.',
    reversal: 'configure_mcp_server with the gaia-interagent entry removed, or delete the local fragment.',
  };

  if (!flags.write) {
    report.required = '--write';
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    for (const [name, body] of Object.entries(files)) {
      process.stdout.write(`\n--- ${name} ---\n${body}`);
    }
    return 0;
  }

  mkdirSync(outDir, { recursive: true });
  const wrote = [];
  for (const [name, body] of Object.entries(files)) {
    const target = join(outDir, name);
    if (existsSync(target) && !flags.force) throw new Error(`${target} already exists. Pass --force to overwrite it.`);
    writeFileSync(target, body, 'utf8');
    wrote.push(target);
  }
  report.wrote = wrote;
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

try {
  process.exit(await main());
} catch (err) {
  const refused = err instanceof ProtectedPathError || err instanceof EcosystemRefusal;
  process.stderr.write(`${refused ? 'REFUSED' : 'usage error'}: ${err.message}\n`);
  process.exit(2);
}
