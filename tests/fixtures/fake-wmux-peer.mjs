#!/usr/bin/env node
/**
 * fake-wmux-peer.mjs — a stand-in for peer-sessions-wmux/scripts/wmux_peer.py.
 *
 * The wmux adapter shells out to the real peer tool, so testing it needs a real
 * process seam, not a mock. This fixture speaks the same argv and the same JSON
 * shapes, reading its canned state from $GAIA_FAKE_WMUX_STATE.
 *
 * It exists so the adapter tests never touch a live wmux, never spawn an agent, and
 * never close a surface.
 */

import { readFileSync } from 'node:fs';

const state = JSON.parse(readFileSync(process.env.GAIA_FAKE_WMUX_STATE, 'utf8'));
const [command, ...rest] = process.argv.slice(2);

if (rest.includes('--yes')) {
  process.stderr.write('fake peer: --yes was passed; the adapter must never do this\n');
  process.exit(9);
}

const out = (payload) => process.stdout.write(JSON.stringify(payload, null, 2) + '\n');

switch (command) {
  case 'list': {
    const agents = state.agents ?? [];
    out({ agents, count: agents.length });
    break;
  }
  case 'send': {
    const surface = rest[rest.indexOf('--surface') + 1];
    out({
      deliveryState: 'terminal-submitted',
      visibleChange: true,
      surfaceId: surface,
      warning: 'Submission is not acceptance or completion.',
    });
    break;
  }
  case 'reap': {
    out(state.reap ?? {
      command: 'reap', mode: 'dry-run', failClosed: false,
      candidates: [], closed: [], skipped: [], failures: [], note: 'Dry run closed nothing.',
    });
    break;
  }
  default:
    process.stderr.write(`fake peer: unsupported command ${command}\n`);
    process.exit(2);
}
