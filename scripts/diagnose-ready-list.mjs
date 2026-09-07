// Temporary read-only live probe; not a new pump runtime or an admission attempt.
import { execFileSync } from 'node:child_process';
import { createGhDraftCollectorApi } from '../src/hosted-draft-collector.mjs';

function read(path) {
  try {
    return { ok: true, value: JSON.parse(execFileSync('gh', ['api', path], {
      encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })) };
  } catch { return { ok: false }; }
}
const raw = read('repos/GuitarAlchemist/gaia/issues?state=open&labels=ready-for-agent&per_page=100');
const issue = read('repos/GuitarAlchemist/gaia/issues/127');
const listed = await createGhDraftCollectorApi().listReadyIssues({
  repository: { owner: 'GuitarAlchemist', name: 'gaia' },
});
console.log(JSON.stringify({
  probe: 'ready-list-127', effect: 'NONE', observedAt: new Date().toISOString(),
  rawOk: raw.ok,
  rawItems: Array.isArray(raw.value) ? raw.value.map(row => ({
    number: row.number, state: row.state, hasPullRequest: Object.hasOwn(row, 'pull_request'),
    pullRequestNull: row.pull_request === null,
  })) : null,
  issue127: issue.ok ? { number: issue.value.number, state: issue.value.state,
    labels: issue.value.labels?.map(label => label.name) } : { readable: false },
  collected: listed,
}));
if (!listed.some(row => row.number === 127)) process.exitCode = 1;
