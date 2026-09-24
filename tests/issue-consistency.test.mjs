import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ISSUE_CONSISTENCY_SCHEMA,
  ISSUE_REPAIR_SCHEMA,
  applyTrailers,
  auditIssues,
  executeRepairs,
  planRepairs,
  splitGrooming,
} from '../src/issue-consistency.mjs';

const REPO = 'GuitarAlchemist/gaia';

const issue = (over = {}) => ({
  number: 1,
  title: 'feat: one bounded slice',
  state: 'OPEN',
  // A ready-for-agent issue is only admissible on main when it positively
  // asserts the absence of blockers, so the clean fixture carries both.
  body: '## Why\n\nBecause.\n\nDepends-On: NONE\nDuplicate-Of: NONE\n\n## Done when\n\nIt is.\n',
  labels: [{ name: 'ready-for-agent' }, { name: 'enhancement' }],
  updatedAt: '2026-09-05T00:00:00Z',
  ...over,
});

const audit = (issues, extra = {}) => auditIssues({ repository: REPO, issues, ...extra });
const rules = (report) => report.findings.map((f) => f.rule);
const only = (report, rule) => report.findings.filter((f) => f.rule === rule);

test('a clean issue produces no findings', () => {
  const report = audit([issue()]);
  assert.equal(report.schema, ISSUE_CONSISTENCY_SCHEMA);
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.counts, { blocks: 0, drift: 0, hygiene: 0 });
});

test('repository must be owner/name', () => {
  assert.throws(() => auditIssues({ repository: 'gaia', issues: [] }), TypeError);
  assert.throws(() => auditIssues({ repository: REPO, issues: 'no' }), TypeError);
});

test('blocking prose is reported with the exact trailer that fixes it', () => {
  const report = audit([issue({ body: '## Why\n\nBlocked by: #40\n\n## Done when\n\nIt is.\n' })]);
  const [found] = only(report, 'prose-relationship');
  assert.equal(found.severity, 'blocks');
  assert.deepEqual(found.proposal.lines, [`Blocked-By: ${REPO}#40`]);
});

// The guardrail. `dependencies` is what makes classifyIssue say BLOCKED_DEPENDENCY,
// so converting a parent link would block every child of every epic.
test('a Parent line is never converted into a blocking dependency', () => {
  const report = audit([issue({ body: '## Why\n\nParent: #40\n\n## Done when\n\nIt is.\n' })]);
  assert.deepEqual(only(report, 'prose-relationship'), []);
  const [found] = only(report, 'undeclared-hierarchy');
  assert.equal(found.severity, 'drift');
  assert.equal(found.proposal, undefined);
  assert.deepEqual(planRepairs(report), []);
});

test('a keyword claims only its own clause', () => {
  const body = '## Why\n\nDepends on: #84. Related: #73, #75.\n\n## Done when\n\nIt is.\n';
  const report = audit([issue({ body })]);
  const [found] = only(report, 'prose-relationship');
  assert.deepEqual(found.proposal.lines, [`Depends-On: ${REPO}#84`]);
  // #73 and #75 are still unlinked, but their kind is unknown, so they are drift.
  assert.deepEqual(only(report, 'undeclared-reference')[0].summary,
    'mentions #73, #75 with no Depends-On/Blocked-By/Duplicate-Of trailer');
});

test('an existing trailer satisfies the same reference', () => {
  const body = `## Why\n\nDepends on: #40\n\nDepends-On: ${REPO}#40\n\n## Done when\n\nIt is.\n`;
  assert.deepEqual(only(audit([issue({ body })]), 'prose-relationship'), []);
});

test('the grooming block is not a place relationships are declared', () => {
  const body = '## Why\n\nBecause.\n\n## Done when\n\nIt is.\n'
    + '<!-- gaia-grooming:start -->\n- **Relations:** #77 scope; #72 skills\n<!-- gaia-grooming:end -->\n';
  const report = audit([issue({ body })]);
  assert.deepEqual(only(report, 'undeclared-reference'), []);
  assert.deepEqual(only(report, 'prose-relationship'), []);
});

test('splitGrooming reports a block that never closes', () => {
  const { malformed } = splitGrooming('body\n<!-- gaia-grooming:start -->\nx\n', 'gaia-grooming');
  assert.equal(malformed, 'start-without-end');
});

test('references to numbers that do not exist are blocking', () => {
  const body = '## Why\n\nSee #999.\n\n## Done when\n\nIt is.\n';
  const report = audit([issue({ body })], { knownNumbers: [1, 2, 3] });
  assert.equal(only(report, 'unresolved-reference')[0].severity, 'blocks');
});

test('a pull request number is a known number, not a dangling reference', () => {
  const body = '## Why\n\nMerged in #126.\n\n## Done when\n\nIt is.\n';
  const report = audit([issue({ body })], { knownNumbers: [1, 126] });
  assert.deepEqual(only(report, 'unresolved-reference'), []);
});

test('a declared dependency on a closed issue is drift, not a block', () => {
  const body = `## Why\n\nx\n\nDepends-On: ${REPO}#2\n\n## Done when\n\nIt is.\n`;
  const report = audit([
    issue({ body }),
    issue({ number: 2, state: 'CLOSED', title: 'feat: done', labels: [{ name: 'enhancement' }] }),
  ]);
  assert.equal(only(report, 'satisfied-dependency')[0].severity, 'drift');
});

test('status a human can see and code cannot is drift', () => {
  const report = audit([issue({ labels: [{ name: 'blocked' }, { name: 'enhancement' }] })]);
  assert.equal(only(report, 'invisible-status').length, 1);
});

test('contradictory status labels block', () => {
  const labels = [{ name: 'ready-for-agent' }, { name: 'blocked' }, { name: 'enhancement' }];
  const report = audit([issue({ labels })]);
  assert.equal(only(report, 'contradictory-status')[0].severity, 'blocks');
});

test('closed issues must not keep workflow labels, and the repair removes them', () => {
  const closed = issue({ state: 'CLOSED', labels: [{ name: 'ready-for-agent' }, { name: 'enhancement' }] });
  const report = audit([closed]);
  const [found] = only(report, 'stale-workflow-label');
  assert.deepEqual(found.proposal, { kind: 'remove-labels', number: 1, labels: ['ready-for-agent'] });
});

test('title type and type label must agree', () => {
  const report = audit([issue({ title: 'fix: a defect', labels: [{ name: 'ready-for-agent' }] })]);
  assert.deepEqual(only(report, 'type-label-mismatch')[0].proposal.labels, ['bug']);
});

test('an unknown title type is reported', () => {
  assert.ok(rules(audit([issue({ title: 'Pump: admit work' })])).includes('unconventional-title'));
  assert.ok(rules(audit([issue({ title: 'no prefix at all' })])).includes('unconventional-title'));
});

test('completion criteria: absent is drift, misspelled is hygiene', () => {
  const absent = audit([issue({ body: '## Why\n\nBecause.\n' })]);
  assert.equal(only(absent, 'missing-completion-criteria')[0].severity, 'drift');
  const alias = audit([issue({ body: '## Why\n\nx\n\n## Acceptance criteria\n\ny\n' })]);
  assert.equal(only(alias, 'noncanonical-completion-heading')[0].severity, 'hygiene');
});

test('a label on nearly every open issue has stopped discriminating', () => {
  const issues = [...Array(10).keys()].map((index) => issue({
    number: index + 1,
    labels: [{ name: 'needs-triage' }, { name: 'enhancement' }],
  }));
  const [found] = only(audit(issues), 'degenerate-signal');
  assert.match(found.summary, /needs-triage.*10 of 10/u);
  assert.equal(found.issue, null);
});

test('a constant grooming priority carries no information', () => {
  const groomed = (number) => issue({
    number,
    body: '## Why\n\nx\n\n## Done when\n\ny\n'
      + '<!-- gaia-grooming:start -->\n- **Assessment / priority:** READY - P1.\n<!-- gaia-grooming:end -->\n',
  });
  const issues = [...Array(9).keys()].map((index) => groomed(index + 1));
  assert.ok(only(audit(issues), 'degenerate-signal').some((f) => /priority P1/u.test(f.summary)));
});

test('a body edited long after grooming is stale', () => {
  const body = '## Why\n\nx\n\n## Done when\n\ny\n'
    + '<!-- gaia-grooming:start -->\n_Codex grooming 2026-09-05T02:19:52Z._\n<!-- gaia-grooming:end -->\n';
  const report = audit([issue({ body, updatedAt: '2026-09-07T02:19:52Z' })]);
  assert.equal(only(report, 'stale-grooming').length, 1);
});

test('planRepairs groups per issue and never rewrites authored prose', () => {
  const report = audit([
    issue({ number: 5, title: 'fix: x', body: '## Why\n\nBlocked by: #40\n\n## Done when\n\ny\n', labels: [] }),
    issue({ number: 6, state: 'CLOSED', labels: [{ name: 'blocked' }, { name: 'enhancement' }] }),
  ]);
  const repairs = planRepairs(report);
  assert.deepEqual(repairs.map((r) => r.number), [5, 6]);
  assert.deepEqual(repairs[0].appendLines, [`Blocked-By: ${REPO}#40`]);
  assert.deepEqual(repairs[0].addLabels, ['bug']);
  assert.deepEqual(repairs[1].removeLabels, ['blocked']);
  // The satisfied-dependency proposal is a body deletion; it is never planned.
  assert.ok(repairs.every((entry) => !Object.hasOwn(entry, 'removeLines')));
});

test('applyTrailers inserts above the grooming block and leaves it intact', () => {
  const body = 'authored text\n\n<!-- gaia-grooming:start -->\nblock\n<!-- gaia-grooming:end -->\n';
  const next = applyTrailers(body, [`Depends-On: ${REPO}#40`]);
  assert.match(next, /authored text\n\nDepends-On: GuitarAlchemist\/gaia#40\n/u);
  assert.ok(next.indexOf('Depends-On') < next.indexOf('gaia-grooming:start'));
  assert.ok(next.includes('<!-- gaia-grooming:end -->'));
});

test('applyTrailers appends when there is no grooming block, and is a no-op for no lines', () => {
  assert.equal(applyTrailers('text\n', []), 'text\n');
  assert.equal(applyTrailers('text\n', ['Blocked-By: #2']), 'text\n\nBlocked-By: #2\n');
});

test('the appended trailer is one the pump actually reads back', () => {
  const body = applyTrailers('## Why\n\nParent: #40\n\n## Done when\n\ny\n', [`Depends-On: ${REPO}#40`]);
  const report = audit([issue({ body })]);
  assert.deepEqual(only(report, 'prose-relationship'), []);
});

// --- executeRepairs: the safeguards a live label batch needs -----------------

const repairOf = (over = {}) => ({
  number: 7, appendLines: [], addLabels: [], removeLabels: [], ...over,
});

const stubHost = (states) => {
  const reads = [];
  const writes = [];
  let cursor = 0;
  return {
    reads,
    writes,
    readIssue: async () => {
      const state = states[Math.min(cursor, states.length - 1)];
      cursor += 1;
      reads.push(state);
      if (state instanceof Error) throw state;
      return state;
    },
    editIssue: async (number, args) => {
      writes.push({ number, ...args });
      if (args.throws) throw args.throws;
    },
  };
};

const live = (labels, over = {}) => ({
  number: 7, title: 'feat: x', state: 'OPEN', body: 'b', labels: labels.map((name) => ({ name })), ...over,
});

test('a repair re-reads the issue before writing and reads the mutation back', async () => {
  const host = stubHost([live(['ready-for-agent']), live([])]);
  const result = await executeRepairs({
    repairs: [repairOf({ removeLabels: ['ready-for-agent'] })],
    repository: REPO, apply: true, ...host,
  });
  assert.equal(result.counts.applied, 1);
  assert.equal(host.reads.length, 2, 'one pre-read and one read-back');
  assert.deepEqual(result.entries[0].before.labels, ['ready-for-agent']);
  assert.deepEqual(result.entries[0].after.labels, []);
});

test('an issue that changed state since the audit is skipped, not written', async () => {
  const host = stubHost([live(['ready-for-agent'], { state: 'OPEN' })]);
  const result = await executeRepairs({
    repairs: [repairOf({ removeLabels: ['ready-for-agent'] })],
    repository: REPO, apply: true,
    surveyed: new Map([[7, { number: 7, title: 'feat: x', state: 'CLOSED', body: 'b' }]]),
    ...host,
  });
  assert.equal(result.counts.skipped, 1);
  assert.match(result.entries[0].reason, /state CLOSED -> OPEN/u);
  assert.equal(host.writes.length, 0);
});

test('a label someone already fixed is reconciled away, not written again', async () => {
  const host = stubHost([live(['enhancement'])]);
  const result = await executeRepairs({
    repairs: [repairOf({ addLabels: ['enhancement'], removeLabels: ['blocked'] })],
    repository: REPO, apply: true, ...host,
  });
  assert.equal(result.counts.skipped, 1);
  assert.equal(result.entries[0].reason, 'already in the intended state');
  assert.equal(host.writes.length, 0);
});

test('a read-back that disagrees is ambiguous and is never retried', async () => {
  const host = stubHost([live(['ready-for-agent']), live(['ready-for-agent'])]);
  const result = await executeRepairs({
    repairs: [repairOf({ removeLabels: ['ready-for-agent'] })],
    repository: REPO, apply: true, ...host,
  });
  assert.equal(result.counts.ambiguous, 1);
  assert.match(result.entries[0].reason, /not retried/u);
  assert.equal(host.writes.length, 1, 'exactly one write attempt, no replay');
});

test('a write that errors but landed is recorded as applied, with the error kept', async () => {
  const host = stubHost([live(['blocked']), live([])]);
  host.editIssue = async () => { throw new Error('502 from GitHub'); };
  const result = await executeRepairs({
    repairs: [repairOf({ removeLabels: ['blocked'] })],
    repository: REPO, apply: true, ...host,
  });
  assert.equal(result.counts.applied, 1);
  assert.match(result.entries[0].reason, /write errored \(502 from GitHub\) but the change is present/u);
});

test('a failed pre-read skips that issue and does not stop the batch', async () => {
  let call = 0;
  const result = await executeRepairs({
    repairs: [repairOf({ number: 1, removeLabels: ['blocked'] }), repairOf({ number: 2, removeLabels: ['blocked'] })],
    repository: REPO, apply: true,
    readIssue: async (number) => {
      call += 1;
      if (number === 1) throw new Error('not found');
      return live(['blocked'], { number: 2, labels: call > 2 ? [] : [{ name: 'blocked' }] });
    },
    editIssue: async () => {},
  });
  assert.equal(result.counts.skipped, 1);
  assert.equal(result.counts.applied, 1);
  assert.match(result.entries[0].reason, /pre-read failed/u);
});

test('a dry run reads but never writes', async () => {
  const host = stubHost([live(['ready-for-agent'])]);
  const result = await executeRepairs({
    repairs: [repairOf({ removeLabels: ['ready-for-agent'] })],
    repository: REPO, apply: false, ...host,
  });
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.counts.planned, 1);
  assert.equal(host.writes.length, 0);
});

test('the result carries the schema and before/after evidence for every entry', async () => {
  const host = stubHost([live(['blocked']), live([])]);
  const result = await executeRepairs({
    repairs: [repairOf({ removeLabels: ['blocked'] })],
    repository: REPO, apply: true, ...host,
  });
  assert.equal(result.schema, ISSUE_REPAIR_SCHEMA);
  assert.equal(result.repository, REPO);
  assert.ok(result.startedAt && result.finishedAt);
  for (const entry of result.entries) {
    assert.ok(Object.hasOwn(entry, 'before') && Object.hasOwn(entry, 'after'));
    assert.ok(Object.hasOwn(entry, 'planned') && Object.hasOwn(entry, 'applied'));
  }
});

// --- main's NONE sentinel: the admission path ------------------------------

const noSentinels = '## Why\n\nx\n\n## Done when\n\ny\n';
test('a ready-for-agent issue with UNKNOWN evidence can never reach READY', () => {
  const report = audit([issue({ body: noSentinels })]);
  const [found] = only(report, 'unreachable-ready');
  assert.equal(found.severity, 'blocks');
  assert.match(found.summary, /never READY/u);
  // Suggested, never applied: asserting "no dependencies" is a claim about the
  // world, so planRepairs must not pick it up.
  assert.deepEqual(found.suggestion, ['Depends-On: NONE', 'Duplicate-Of: NONE']);
  assert.equal(found.proposal, undefined);
  assert.deepEqual(planRepairs(report), []);
});

test('both sentinels present clears the admission finding', () => {
  const body = '## Why\n\nx\n\nDepends-On: NONE\nDuplicate-Of: NONE\n\n## Done when\n\ny\n';
  assert.deepEqual(only(audit([issue({ body })]), 'unreachable-ready'), []);
});

test('one sentinel is not enough, and only the missing one is suggested', () => {
  const body = '## Why\n\nx\n\nDepends-On: NONE\n\n## Done when\n\ny\n';
  const [found] = only(audit([issue({ body })]), 'unreachable-ready');
  assert.deepEqual(found.suggestion, ['Duplicate-Of: NONE']);
});

test('an issue with a real dependency is admissible without the depends sentinel', () => {
  const body = `## Why\n\nx\n\nDepends-On: ${REPO}#2\nDuplicate-Of: NONE\n\n## Done when\n\ny\n`;
  assert.deepEqual(only(audit([issue({ body })]), 'unreachable-ready'), []);
});

test('an issue claiming a blocker in prose is never told to assert NONE', () => {
  const body = '## Why\n\nBlocked by: #40\n\n## Done when\n\ny\n';
  const [found] = only(audit([issue({ body })]), 'unreachable-ready');
  assert.equal(found.suggestion, undefined);
  assert.match(found.evidence.join(' '), /NOT safe to assert yet/u);
});

test('an unlabelled issue is not nagged about admission it is not seeking', () => {
  assert.deepEqual(only(audit([issue({ labels: [{ name: 'enhancement' }] })]), 'unreachable-ready'), []);
});

test('a relationship block the adapter rejects is reported, not thrown', () => {
  const body = '## Why\n\nx\n\nBlocked-By: NONE\n\n## Done when\n\ny\n';
  let report;
  assert.doesNotThrow(() => { report = audit([issue({ body })]); });
  const [found] = only(report, 'malformed-relationship');
  assert.equal(found.severity, 'blocks');
  assert.match(found.summary, /NONE is supported only for Depends-On and Duplicate-Of/u);
});

test('NONE beside a concrete reference is reported as malformed', () => {
  const body = `## Why\n\nx\n\nDepends-On: NONE\nDepends-On: ${REPO}#2\n\n## Done when\n\ny\n`;
  const report = audit([issue({ body })]);
  assert.match(only(report, 'malformed-relationship')[0].summary, /cannot be combined/u);
});
