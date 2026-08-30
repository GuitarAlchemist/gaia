#!/usr/bin/env node
/**
 * fake-wmux-cli.mjs — a stand-in for the real `wmux` binary, for the local lane sensor.
 *
 * The sensor shells out to wmux, so testing it needs a real process seam rather than a mock. This
 * fixture speaks the same argv and the same JSON shape, reading its canned payload from
 * $GAIA_FAKE_WMUX_STATE and appending every argv it is invoked with to $GAIA_FAKE_WMUX_ARGV.
 *
 * It is also the negative control. It emits `cmd`, a prompt, stdout, a screen fragment and a
 * reasoning trace, each with a unique marker, so a test can assert that none of them reaches the
 * observation, the snapshot or the HTML. And it EXITS NON-ZERO for every verb but `agent list`,
 * so a sensor that ever learned to send, spawn, kill, read a screen or drive a browser fails here
 * rather than in production.
 */

import { appendFileSync, readFileSync } from 'node:fs';

const argv = process.argv.slice(2);

if (process.env.GAIA_FAKE_WMUX_ARGV) {
  appendFileSync(process.env.GAIA_FAKE_WMUX_ARGV, `${JSON.stringify(argv)}\n`, 'utf8');
}

const FORBIDDEN = new Set([
  'send', 'send-key', 'read-screen', 'browser', 'spawn', 'kill', 'close-surface', 'close-pane',
  'focus-surface', 'trigger-flash', 'eval', 'type', 'click', 'screenshot', 'notify',
]);

if (FORBIDDEN.has(argv[0]) || FORBIDDEN.has(argv[1])) {
  process.stderr.write(`fake wmux: the lane sensor must never invoke ${argv.join(' ')}\n`);
  process.exit(9);
}
if (argv[0] !== 'agent' || argv[1] !== 'list') {
  process.stderr.write(`fake wmux: unsupported invocation ${argv.join(' ')}\n`);
  process.exit(2);
}
if (argv.includes('--workspace')) {
  process.stderr.write('fake wmux: the lane sensor must observe every workspace\n');
  process.exit(9);
}

const state = JSON.parse(readFileSync(process.env.GAIA_FAKE_WMUX_STATE, 'utf8'));
if (state.emitGarbage) {
  process.stdout.write('not json at all\n');
  process.exit(0);
}
if (state.emitSilence) process.exit(0);

process.stdout.write(`${JSON.stringify({ agents: state.agents ?? [] }, null, 2)}\n`);
