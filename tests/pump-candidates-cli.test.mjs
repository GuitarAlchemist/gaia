import assert from 'node:assert/strict';
import test from 'node:test';

import { main } from '../scripts/pump-candidates.mjs';

const repository = 'test-org/test-repo';
const body = '## Done when\n- the bounded work is complete\n';
const issue = (number, blockedBy = 0) => ({
  number, title: `issue ${number}`, body, labels: [],
  issue_dependencies_summary: { blocked_by: blockedBy },
});
function sink() {
  let text = '';
  return { write(chunk) { text += chunk; }, text: () => text };
}

test('candidate CLI carries native dependency evidence from every REST issue page', async () => {
  const calls = [];
  const stdout = sink();
  const stderr = sink();
  const read = async (args) => {
    calls.push(args);
    if (args[0] === 'api' && args[1].includes('/issues?')) {
      return [[issue(1, 1)], [issue(2), { ...issue(3), body: `${body}\nParent: #2\n`, pull_request: {} }]];
    }
    if (args[0] === 'pr') return [];
    if (args[0] === 'api' && args[1].includes('/git/')) return [[]];
    assert.fail(`unexpected read: ${JSON.stringify(args)}`);
  };
  const code = await main({
    argv: ['--repository', repository, '--format', 'json'], read, stdout, stderr,
  });
  assert.equal(code, 0, stderr.text());
  assert.deepEqual(calls[0], [
    'api', `repos/${repository}/issues?state=open&per_page=100`, '--paginate', '--slurp',
  ]);
  const result = JSON.parse(stdout.text());
  assert.deepEqual(result.candidates.map((row) => row.issue), [2]);
  assert.deepEqual(result.refused.map(({ issue: number, reasons }) => [number, reasons]), [
    [1, ['native-dependency']],
  ]);
});

test('candidate CLI refuses a missing native summary instead of printing a queue suggestion', async () => {
  const stdout = sink();
  const stderr = sink();
  const read = async (args) => args[1]?.includes('/issues?')
    ? [[{ number: 1, title: 'unobserved', body, labels: [] }]] : [];
  assert.equal(await main({ argv: ['--repository', repository], read, stdout, stderr }), 0);
  assert.match(stdout.text(), /native-dependencies-unreadable/u);
  assert.doesNotMatch(stdout.text(), /pump-once/u);
});

test('candidate CLI publishes no partial recommendations if an issue read fails', async () => {
  const stdout = sink();
  const stderr = sink();
  const read = async (args) => {
    if (args[1]?.includes('/issues?')) throw new Error('fixture read unavailable');
    return [];
  };
  assert.equal(await main({ argv: ['--repository', repository], read, stdout, stderr }), 3);
  assert.equal(stdout.text(), '');
  assert.match(stderr.text(), /fail-closed: could not read test-org\/test-repo/u);
});
