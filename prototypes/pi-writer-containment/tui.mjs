// THROWAWAY PROTOTYPE — run with: npm run prototype:pi-writer

import { createInterface } from 'node:readline';
import { initialState, transition } from './logic.mjs';

const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';
let state = initialState();

function render() {
  console.clear();
  process.stdout.write(`${bold}Pi writer containment prototype${reset}\n`);
  process.stdout.write(`${dim}Question: does exact allowlisting plus measurement fail closed?${reset}\n\n`);
  process.stdout.write(`${bold}allowedPaths${reset}: ${JSON.stringify(state.allowedPaths)}\n`);
  process.stdout.write(`${bold}observedChanges${reset}: ${JSON.stringify(state.observedChanges)}\n`);
  process.stdout.write(`${bold}status${reset}: ${state.status}\n`);
  process.stdout.write(`${bold}reason${reset}: ${state.reason ?? 'none'}\n\n`);
  process.stdout.write(`${bold}[a]${reset} allowed file  ${bold}[o]${reset} outside file  `);
  process.stdout.write(`${bold}[t]${reset} unsafe type  ${bold}[v]${reset} validate  `);
  process.stdout.write(`${bold}[r]${reset} reset  ${bold}[q]${reset} quit\n`);
}

const actions = {
  a: { type: 'observe', change: { path: 'src/allowed.mjs', kind: 'file' } },
  o: { type: 'observe', change: { path: 'README.md', kind: 'file' } },
  t: { type: 'observe', change: { path: 'src/allowed.mjs', kind: 'symlink' } },
  v: { type: 'validate' },
  r: { type: 'reset' },
};

const input = createInterface({ input: process.stdin, terminal: process.stdin.isTTY });
render();
input.on('line', (line) => {
  const key = line.trim().toLowerCase();
  if (key === 'q') {
    input.close();
    return;
  }
  if (actions[key]) state = transition(state, actions[key]);
  render();
});
