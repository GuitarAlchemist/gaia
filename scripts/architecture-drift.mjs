#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  ArchitectureDriftRefusal,
  checkArchitectureDrift,
  createFilesystemArchitectureInventory,
} from '../src/architecture-drift.mjs';
import { pluginRoot } from '../src/templates.mjs';

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token !== '--base') throw new ArchitectureDriftRefusal('CLI_ARGUMENT_INVALID');
    const value = argv[index += 1];
    if (value === undefined || value.length === 0) throw new ArchitectureDriftRefusal('CLI_ARGUMENT_INVALID');
    result.base = value;
  }
  return result;
}

function git(root, args) {
  const run = spawnSync('git', ['-c', `safe.directory=${root.replaceAll('\\', '/')}`, ...args], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (run.status !== 0) throw new ArchitectureDriftRefusal('REPOSITORY_READ_FAILED');
  return run.stdout.trim();
}

function impactFromEvent() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return { kind: 'UNDECLARED', evidence: null };
  let body = '';
  try {
    const event = JSON.parse(readFileSync(eventPath, 'utf8'));
    body = typeof event.pull_request?.body === 'string' ? event.pull_request.body : '';
  } catch {
    throw new ArchitectureDriftRefusal('EVENT_PAYLOAD_INVALID');
  }
  const kind = body.match(/^Architecture impact:\s*(updated|none)\s*$/im)?.[1]?.toLowerCase();
  const evidence = body.match(/^Architecture evidence:\s*(.+)\s*$/im)?.[1]?.trim() ?? null;
  if (kind === 'none' && evidence !== null) return { kind: 'NO_IMPACT', evidence };
  if (kind === 'updated') return { kind: 'UPDATED', evidence };
  return { kind: 'UNDECLARED', evidence: null };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = pluginRoot();
  const revision = git(root, ['rev-parse', 'HEAD']);
  const knownRevisions = git(root, ['rev-list', '--all']).split(/\r?\n/).filter(Boolean);
  const configuredBase = args.base ?? process.env.GAIA_ARCHITECTURE_BASE?.trim();
  const base = configuredBase || `${revision}^`;
  const changed = git(root, ['diff', '--name-only', `${base}...${revision}`]);
  const changedPaths = changed === '' ? [] : changed.split(/\r?\n/).map((path) => path.replaceAll('\\', '/'));
  const report = checkArchitectureDrift(createFilesystemArchitectureInventory({
    root,
    revision,
    knownRevisions,
    changedPaths,
    architectureImpact: impactFromEvent(),
  }));
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report.verdict === 'PASS' ? 0 : 1;
}

try {
  process.exit(main());
} catch (error) {
  const code = error instanceof ArchitectureDriftRefusal ? error.code : 'ARCHITECTURE_DRIFT_FAILED';
  process.stderr.write(`${code}\n`);
  process.exit(2);
}
