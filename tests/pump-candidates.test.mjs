import assert from 'node:assert/strict';
import test from 'node:test';

import * as candidates from '../src/pump-candidates.mjs';

const { rankCandidates, parentNumbers } = candidates;
const REPOSITORY = 'GuitarAlchemist/gaia';
const DONE = '## Why\nbecause\n\n## Done when\n- it works\n';

function issue(number, { labels = [], body = DONE, title = `issue ${number}` } = {}) {
  return { number, title, body, labels: labels.map((name) => ({ name })) };
}

test('a groomed issue with completion criteria is a candidate, lowest number first', () => {
  const result = rankCandidates({
    repository: REPOSITORY, issues: [issue(12), issue(7), issue(30)], limit: 2,
  });
  assert.deepEqual(result.candidates.map((row) => row.issue), [7, 12]);
  assert.equal(result.eligibleCount, 3);
});

test('triage, blocked, in-flight and blocker labels refuse with the label named', () => {
  const result = rankCandidates({
    repository: REPOSITORY,
    issues: [
      issue(1, { labels: ['needs-triage'] }),
      issue(2, { labels: ['blocked'] }),
      issue(3, { labels: ['ready-for-agent'] }),
      issue(4, { labels: ['blocker:capacity'] }),
      issue(5, { labels: ['team-only'] }),
    ],
    excludeLabels: ['team-only'],
  });
  assert.equal(result.eligibleCount, 0);
  assert.deepEqual(result.refused.map((row) => row.reasons[0]), [
    'excluded-label:needs-triage', 'excluded-label:blocked', 'excluded-label:ready-for-agent',
    'excluded-label:blocker:capacity', 'excluded-label:team-only',
  ]);
});

test('a declared dependency or duplicate refuses; asserted NONE does not', () => {
  const result = rankCandidates({
    repository: REPOSITORY,
    issues: [
      issue(1, { body: `${DONE}\nDepends-On: #9\n` }),
      issue(2, { body: `${DONE}\nDuplicate-Of: #9\n` }),
      issue(3, { body: `${DONE}\nDepends-On: NONE\nDuplicate-Of: NONE\n` }),
      issue(4, { body: `${DONE}\nBlocked-By: NONE\n` }),
    ],
  });
  const reasons = Object.fromEntries(result.refused.map((row) => [row.issue, row.reasons]));
  assert.deepEqual(reasons[1], ['declares-dependency']);
  assert.deepEqual(reasons[2], ['declares-duplicate']);
  assert.deepEqual(reasons[4], ['malformed-relationships']);
  assert.deepEqual(result.candidates.map((row) => row.issue), [3]);
});

test('an issue another issue names as its parent is never proposed', () => {
  const issues = [
    issue(74, { title: 'epic' }),
    issue(91, { body: `${DONE}\nParent capability: #74\n` }),
    issue(92, { body: `${DONE}\nParent: #74. Related: #73\n` }),
  ];
  assert.deepEqual([...parentNumbers(issues)], [74]);
  const result = rankCandidates({ repository: REPOSITORY, issues });
  assert.deepEqual(result.refused.find((row) => row.issue === 74).reasons, ['is-parent']);
  assert.deepEqual(result.candidates.map((row) => row.issue), [91, 92]);
});

test('completion criteria are recognised in the headings the corpus uses', () => {
  const headings = [
    '## Done when', '### Acceptance criteria', '## Tracer-bullet acceptance criteria',
    '## Acceptance', '## Definition of done', '## Exit criteria',
  ];
  const issues = headings.map((heading, index) => issue(index + 1, { body: `${heading}\n- x\n` }));
  issues.push(issue(99, { body: '## What\nno criteria here\n' }));
  const result = rankCandidates({ repository: REPOSITORY, issues, limit: 20 });
  assert.equal(result.eligibleCount, headings.length);
  assert.deepEqual(result.refused.map((row) => [row.issue, row.reasons]), [[99, ['no-completion-criteria']]]);
});

test('an issue already drafted or seeded is not proposed again', () => {
  const result = rankCandidates({
    repository: REPOSITORY,
    issues: [issue(148), issue(108), issue(5)],
    pullRequests: [{ number: 149, title: 'draft: deliver issue #148' }],
    branchNames: ['gaia/issue-108-ready-1', 'main', 'gaia/issue-130-evidence'],
  });
  const reasons = Object.fromEntries(result.refused.map((row) => [row.issue, row.reasons]));
  assert.deepEqual(reasons[148], ['already-drafted']);
  assert.deepEqual(reasons[108], ['already-seeded']);
  assert.deepEqual(result.candidates.map((row) => row.issue), [5]);
});

test('pull requests in the issue list are ignored', () => {
  const result = rankCandidates({
    repository: REPOSITORY, issues: [{ ...issue(3), pull_request: {} }, issue(4)],
  });
  assert.deepEqual(result.candidates.map((row) => row.issue), [4]);
  assert.equal(result.refused.length, 0);
});

test('the ranker only proposes: its module exports no effect', () => {
  const exported = Object.keys(candidates).sort();
  assert.deepEqual(exported, [
    'DEFAULT_EXCLUDED_LABELS', 'PUMP_CANDIDATES_SCHEMA', 'assessIssue', 'draftedNumbers',
    'parentNumbers', 'rankCandidates', 'seededNumbers',
  ]);
  assert.ok(Object.isFrozen(rankCandidates({ repository: REPOSITORY, issues: [] })));
});
