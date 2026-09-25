// Rank the open issues the Gaia pump could take next. Read-only by construction.
//
// Choosing what is ready is the operator's act of authority (`ready-for-agent`),
// so this module only proposes. It returns the admissible issues, lowest number
// first, and the exact refusals for the rest; it has no port that could label,
// seed or dispatch anything.

import { declaredRelationships } from './github-read-adapter.mjs';

export const PUMP_CANDIDATES_SCHEMA = 'GaiaPumpCandidatesV0';

export const DEFAULT_EXCLUDED_LABELS = Object.freeze([
  'needs-triage', 'blocked', 'ready-for-agent', 'retrospective', 'wontfix', 'duplicate',
]);

const COMPLETION_HEADING = /^#{1,4}\s*(?:[\w-]+\s+)*(?:done when|acceptance(?: criteria)?|completion criteria|definition of done|exit criteria)\b/imu;
const PARENT_CLAIM = /\bparent\b[^:\n]{0,40}:\s*#([1-9]\d*)/giu;
const DRAFT_TITLE = /deliver issue #([1-9]\d*)\b/u;
const SEEDED_BRANCH = /^gaia\/issue-([1-9]\d*)-/u;

function labelNames(issue) {
  return (issue.labels ?? []).map((label) => (typeof label === 'string' ? label : label?.name));
}

/** Issue numbers another open issue names as its parent: epics and Wayfinders. */
export function parentNumbers(issues) {
  const parents = new Set();
  for (const issue of issues) {
    for (const match of String(issue.body ?? '').matchAll(PARENT_CLAIM)) {
      const number = Number(match[1]);
      if (number !== issue.number) parents.add(number);
    }
  }
  return parents;
}

export function draftedNumbers(pullRequests) {
  const drafted = new Set();
  for (const pull of pullRequests) {
    const match = String(pull.title ?? '').match(DRAFT_TITLE);
    if (match) drafted.add(Number(match[1]));
  }
  return drafted;
}

export function seededNumbers(branchNames) {
  const seeded = new Set();
  for (const name of branchNames) {
    const match = String(name).match(SEEDED_BRANCH);
    if (match) seeded.add(Number(match[1]));
  }
  return seeded;
}

/** Every reason this issue is not a candidate; an empty list means it is one. */
export function assessIssue(issue, { repository, excludeLabels, parents, drafted, seeded }) {
  const reasons = [];
  for (const label of labelNames(issue)) {
    if (excludeLabels.includes(label) || String(label).startsWith('blocker:')) {
      reasons.push(`excluded-label:${label}`);
    }
  }
  try {
    const relationships = declaredRelationships(issue.body ?? '', repository);
    if (Array.isArray(relationships.dependencies) && relationships.dependencies.length > 0) {
      reasons.push('declares-dependency');
    }
    if (relationships.duplicateOf !== null && relationships.duplicateOf !== 'UNKNOWN') {
      reasons.push('declares-duplicate');
    }
  } catch {
    reasons.push('malformed-relationships');
  }
  if (parents.has(issue.number)) reasons.push('is-parent');
  if (!COMPLETION_HEADING.test(issue.body ?? '')) reasons.push('no-completion-criteria');
  if (drafted.has(issue.number)) reasons.push('already-drafted');
  if (seeded.has(issue.number)) reasons.push('already-seeded');
  return reasons;
}

export function rankCandidates({
  repository, issues, pullRequests = [], branchNames = [], excludeLabels = [], limit = 3,
}) {
  const context = {
    repository,
    excludeLabels: [...new Set([...DEFAULT_EXCLUDED_LABELS, ...excludeLabels])],
    parents: parentNumbers(issues),
    drafted: draftedNumbers(pullRequests),
    seeded: seededNumbers(branchNames),
  };
  const assessed = issues
    .filter((issue) => !issue.pull_request && !issue.isPullRequest)
    .map((issue) => ({ issue: issue.number, title: issue.title ?? '', reasons: assessIssue(issue, context) }))
    .sort((left, right) => left.issue - right.issue);
  const eligible = assessed.filter((row) => row.reasons.length === 0);
  return Object.freeze({
    schema: PUMP_CANDIDATES_SCHEMA,
    repository,
    candidates: eligible.slice(0, limit).map(({ issue, title }) => ({ issue, title })),
    eligibleCount: eligible.length,
    refused: assessed.filter((row) => row.reasons.length > 0),
  });
}
