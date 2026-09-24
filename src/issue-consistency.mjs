// Issue consistency audit.
//
// The point of this module is that it reads the *same* relationship parser the
// portfolio pump reads (`declaredRelationships`), so the linter cannot drift
// away from the contract it is linting. Every other rule is policy, and policy
// is data — see `DEFAULT_POLICY` and `.github/issue-policy.json`.

import { declaredRelationships } from './github-read-adapter.mjs';

export const ISSUE_CONSISTENCY_SCHEMA = 'gaia-issue-consistency/1';

// Severity is "what does this cost", not "how loud is it".
//   blocks  — a machine that reads issues sees the wrong thing
//   drift   — humans and machines disagree, or a signal stopped carrying information
//   hygiene — only readers and history queries are affected
export const SEVERITIES = ['blocks', 'drift', 'hygiene'];

export const DEFAULT_POLICY = {
  // Title prefix vocabulary: `type: summary`.
  titleTypes: ['feat', 'fix', 'docs', 'test', 'spike', 'ops', 'adr', 'chore', 'refactor'],
  // Labels the consuming code actually branches on, and the state each produces.
  machineStatusLabels: {
    'ready-for-agent': 'READY',
    'ready-for-human': 'AWAITING_HUMAN',
  },
  // Labels that look like status to a human but no code reads.
  advisoryStatusLabels: [
    'needs-triage', 'blocked', 'blocker:capacity', 'validation-failed', 'priority:critical',
  ],
  // Status labels that must not survive closing the issue.
  workflowLabels: [
    'ready-for-agent', 'ready-for-human', 'needs-triage', 'blocked', 'blocker:capacity',
    'validation-failed',
  ],
  // Status combinations that cannot both be true.
  exclusiveStatusLabels: [
    ['ready-for-agent', 'blocked'],
    ['ready-for-agent', 'needs-triage'],
    ['ready-for-agent', 'validation-failed'],
  ],
  // Title prefix -> the type label that must accompany it.
  typeLabels: { feat: 'enhancement', fix: 'bug' },
  // Labels that are neither status nor type, and are allowed to appear freely.
  freeLabels: ['retrospective', 'documentation', 'question'],
  // The one spelling of the completion criterion, and the spellings to migrate.
  completionHeading: 'Done when',
  completionAliases: [
    'Acceptance criteria', 'Acceptance', 'Tracer-bullet acceptance criteria', 'Evidence',
    'Verification', 'Success criteria', 'Success evidence', 'Success metrics', 'R0 acceptance',
  ],
  requiredHeadings: ['Why'],
  // Prose that asserts a *blocking* relationship, and the trailer it becomes.
  // Only these are ever auto-proposed, because only these mean "do not start yet".
  blockingProse: {
    'depends on': 'Depends-On',
    'depends-on': 'Depends-On',
    'blocked by': 'Blocked-By',
    'blocked-by': 'Blocked-By',
    'blocks on': 'Blocked-By',
    'duplicate of': 'Duplicate-Of',
    'duplicate-of': 'Duplicate-Of',
    duplicates: 'Duplicate-Of',
  },
  // Prose that asserts containment, not blocking. A child of an epic is not
  // waiting on the epic — usually the reverse. These are reported and NEVER
  // converted: `dependencies` is what makes the pump say BLOCKED_DEPENDENCY, so
  // auto-promoting a parent link would block every child of every epic.
  hierarchyProse: ['parent', 'parents', 'part of', 'epic', 'child of', 'belongs to'],
  groomingMarker: 'gaia-grooming',
  groomingFields: [],
  // A signal present on this share of open issues has stopped discriminating.
  degenerateShare: 0.85,
  // A body longer than this is a program, not an issue.
  maxBodyBytes: 12000,
};

const TRAILER_KINDS = ['Depends-On', 'Blocked-By', 'Duplicate-Of'];
const HEADING = /^#{2,4}[ \t]+(.+?)[ \t]*$/gmu;
const REFERENCE = /(?<![\w/])#([1-9]\d*)\b/gu;
const PROSE_LINE = /^[ \t>*-]*\**([A-Za-z][A-Za-z -]{2,20}?)\**[ \t]*:[ \t]*(.+)$/u;

function normalizeLabels(issue) {
  return (issue.labels ?? []).map((label) => (
    typeof label === 'string' ? label : String(label?.name ?? '')
  )).filter(Boolean);
}

function titlePrefix(title) {
  const match = /^([a-z][a-z0-9]*):/u.exec(String(title ?? ''));
  return match ? match[1] : null;
}

function headingsOf(body) {
  const found = [];
  HEADING.lastIndex = 0;
  for (const match of String(body ?? '').matchAll(HEADING)) found.push(match[1].trim());
  return found;
}

// The grooming block is machine-written narrative. It mentions related issues,
// but it is not where a human declares a relationship, so relationship rules
// read the human half of the body only.
export function splitGrooming(body, marker) {
  const text = String(body ?? '');
  const start = text.indexOf(`<!-- ${marker}:start -->`);
  const end = text.indexOf(`<!-- ${marker}:end -->`);
  if (start < 0) return { authored: text, grooming: null, malformed: end >= 0 ? 'end-without-start' : null };
  if (end < start) return { authored: text.slice(0, start), grooming: text.slice(start), malformed: 'start-without-end' };
  const duplicated = text.indexOf(`<!-- ${marker}:start -->`, end) >= 0;
  return {
    authored: `${text.slice(0, start)}${text.slice(end)}`,
    grooming: text.slice(start, end),
    malformed: duplicated ? 'duplicate-block' : null,
  };
}

function referencedNumbers(text) {
  const numbers = new Set();
  REFERENCE.lastIndex = 0;
  for (const match of String(text ?? '').matchAll(REFERENCE)) numbers.add(Number(match[1]));
  return numbers;
}

// Prose that means "this issue relates to that one" but that the parser cannot
// see. `kind` is null for hierarchy claims: they are reported, never converted.
function proseRelationshipLines(authored, policy) {
  const claims = [];
  for (const rawLine of authored.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = PROSE_LINE.exec(line);
    if (!match) continue;
    const key = match[1].trim().toLowerCase();
    const blocking = policy.blockingProse[key];
    const hierarchy = policy.hierarchyProse.includes(key);
    if (!blocking && !hierarchy) continue;
    // Already a valid trailer? Then it is not prose.
    if (TRAILER_KINDS.some((t) => line.toLowerCase().startsWith(`${t.toLowerCase()}:`))) continue;
    // Only the first clause belongs to this keyword. "Parent: #84. Related: #73"
    // declares one parent, and #73 is a different, unnamed kind of relation.
    const clause = match[2].split(/(?<=[.;])\s+/u)[0];
    const numbers = [...referencedNumbers(clause)];
    if (numbers.length === 0) continue;
    claims.push({ kind: blocking ?? null, keyword: key, line, numbers });
  }
  return claims;
}

function groomingTimestamp(grooming) {
  const match = /(\d{4}-\d{2}-\d{2}T[\d:]{8}(?:\.\d+)?Z)/u.exec(grooming ?? '');
  return match ? match[1] : null;
}

function groomingFieldNames(grooming) {
  return [...String(grooming ?? '').matchAll(/\*\*(.+?):\*\*/gu)].map((m) => m[1].trim());
}

// `proposal` is machine-applicable and planRepairs will act on it.
// `suggestion` is for a human to weigh: lines that would fix the finding, which
// the tool declines to write because doing so would assert something it cannot
// verify. Nothing reads `suggestion` except the report.
function finding(rule, severity, issue, summary, evidence, proposal, suggestion) {
  return {
    rule,
    severity,
    issue: issue?.number ?? null,
    title: issue?.title ?? null,
    summary,
    evidence,
    ...(proposal ? { proposal } : {}),
    ...(suggestion ? { suggestion } : {}),
  };
}

/**
 * Audit a set of issues against a consistency policy.
 *
 * @param {object} input
 * @param {string} input.repository        `owner/name`, used to qualify trailers.
 * @param {Array}  input.issues            gh-shaped issues: number, title, state, body, labels…
 * @param {object} [input.policy]
 * @param {Set|Array} [input.knownNumbers] every issue AND pull request number that exists,
 *                                         so unresolved references are not guessed at.
 * @returns {{schema: string, findings: Array, counts: object}}
 */
export function auditIssues({ repository, issues, policy: overrides, knownNumbers } = {}) {
  if (typeof repository !== 'string' || !repository.includes('/')) {
    throw new TypeError('repository must be "owner/name"');
  }
  if (!Array.isArray(issues)) throw new TypeError('issues must be an array');
  const policy = { ...DEFAULT_POLICY, ...(overrides ?? {}) };
  const known = knownNumbers ? new Set([...knownNumbers].map(Number)) : null;
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const findings = [];
  const openIssues = issues.filter((issue) => String(issue.state).toUpperCase() === 'OPEN');
  const labelUse = new Map();
  const groomingPriorities = new Map();

  for (const issue of issues) {
    const open = String(issue.state).toUpperCase() === 'OPEN';
    const labels = normalizeLabels(issue);
    const body = String(issue.body ?? '');
    const { authored, grooming, malformed } = splitGrooming(body, policy.groomingMarker);
    // The adapter throws on a relationship block it cannot reconcile — NONE on
    // Blocked-By, or NONE beside a concrete reference. That is a real defect in
    // the issue, not a crash: the pump would fail reading it, so report it and
    // carry on with no declared relationships.
    let relationships = { dependencies: 'UNKNOWN', duplicateOf: 'UNKNOWN' };
    try {
      relationships = declaredRelationships(body, repository);
    } catch (error) {
      findings.push(finding(
        'malformed-relationship', 'blocks', issue,
        `the relationship block does not parse: ${error.message}`,
        body.split(/\r?\n/u).filter((line) => /^\s*(Depends-On|Blocked-By|Duplicate-Of):/iu.test(line)),
      ));
    }
    // `dependencies: []` and `duplicateOf: null` are known-empty, distinct from
    // UNKNOWN. Both mean the author positively asserted "there are none".
    const dependenciesKnown = relationships.dependencies !== 'UNKNOWN';
    const duplicateKnown = relationships.duplicateOf !== 'UNKNOWN';
    const declared = dependenciesKnown ? relationships.dependencies : [];
    const declaredNumbers = new Set(declared.map((ref) => Number(ref.split('#')[1])));
    if (duplicateKnown && relationships.duplicateOf) {
      declaredNumbers.add(Number(relationships.duplicateOf.split('#')[1]));
    }
    if (open) for (const label of labels) labelUse.set(label, (labelUse.get(label) ?? 0) + 1);

    // --- relationships (blocks) -------------------------------------------
    const prose = proseRelationshipLines(authored, policy);
    const claimed = prose
      .flatMap(({ kind, keyword, numbers, line }) => numbers
        .filter((number) => !declaredNumbers.has(number))
        .map((number) => ({ kind, keyword, number, line })));
    const missing = claimed.filter((entry) => entry.kind !== null);
    const hierarchy = claimed.filter((entry) => entry.kind === null);
    if (missing.length > 0) {
      findings.push(finding(
        'prose-relationship', 'blocks', issue,
        `${missing.length} blocking relationship(s) stated in prose that the parser cannot read`,
        [...new Set(missing.map(({ line }) => line))],
        {
          kind: 'append-lines',
          number: issue.number,
          lines: missing.map(({ kind, number }) => `${kind}: ${repository}#${number}`),
        },
      ));
    }
    if (hierarchy.length > 0) {
      // Deliberately proposal-free. Promoting a parent link to Depends-On would
      // put every child of an epic into BLOCKED_DEPENDENCY, which is false and
      // would stop admission rather than repair it. A human decides this one.
      findings.push(finding(
        'undeclared-hierarchy', 'drift', issue,
        `states ${[...new Set(hierarchy.map((entry) => entry.keyword))].join('/')} in prose; `
          + 'the pump has no non-blocking relationship to record it as',
        [
          ...new Set(hierarchy.map(({ line }) => line)),
          'not auto-converted: a parent is containment, not a blocking dependency',
        ],
      ));
    }
    const undeclared = [...referencedNumbers(authored)]
      .filter((number) => number !== issue.number && !declaredNumbers.has(number))
      .filter((number) => !claimed.some((entry) => entry.number === number));
    if (open && undeclared.length > 0) {
      findings.push(finding(
        'undeclared-reference', 'drift', issue,
        `mentions #${undeclared.join(', #')} with no Depends-On/Blocked-By/Duplicate-Of trailer`,
        [`the pump reads dependencies as UNKNOWN, so this issue cannot reach BLOCKED_DEPENDENCY`],
      ));
    }
    if (known) {
      const unresolved = [...referencedNumbers(authored)].filter((number) => !known.has(number));
      if (unresolved.length > 0) {
        findings.push(finding(
          'unresolved-reference', 'blocks', issue,
          `references #${unresolved.join(', #')}, which exist neither as issue nor pull request`,
          unresolved.map((number) => `#${number}`),
        ));
      }
    }
    for (const number of declaredNumbers) {
      const target = byNumber.get(number);
      if (open && target && String(target.state).toUpperCase() === 'CLOSED') {
        findings.push(finding(
          'satisfied-dependency', 'drift', issue,
          `declares a dependency on #${number}, which is closed`,
          [`#${number} ${target.title}`],
          { kind: 'remove-lines', number: issue.number, match: `#${number}` },
        ));
      }
    }

    // --- labels ------------------------------------------------------------
    const machine = labels.filter((label) => Object.hasOwn(policy.machineStatusLabels, label));
    const advisory = labels.filter((label) => policy.advisoryStatusLabels.includes(label));
    const typeLabels = Object.values(policy.typeLabels);
    const unknown = labels.filter((label) => (
      !Object.hasOwn(policy.machineStatusLabels, label)
      && !policy.advisoryStatusLabels.includes(label)
      && !typeLabels.includes(label)
      && !policy.freeLabels.includes(label)
    ));
    if (unknown.length > 0) {
      findings.push(finding(
        'unknown-label', 'drift', issue,
        `label(s) outside the policy vocabulary: ${unknown.join(', ')}`,
        unknown,
      ));
    }
    if (open && advisory.length > 0 && machine.length === 0) {
      findings.push(finding(
        'invisible-status', 'drift', issue,
        `status is expressed only by ${advisory.join(', ')}, which no code reads`,
        [`classifyIssue() branches on ${Object.keys(policy.machineStatusLabels).join(', ')} only`],
      ));
    }
    // The admission rule. An issue labelled ready-for-agent whose evidence is
    // UNKNOWN can never reach READY: classifyIssue sends it to
    // READY_WITH_UNKNOWN instead, every time, no matter how clean the rest of
    // its metadata is. The fix is for the author to positively assert the
    // absence — `Depends-On: NONE` and `Duplicate-Of: NONE`.
    //
    // Deliberately a `suggestion`, not a `proposal`: planRepairs only reads
    // proposals, so `repair --apply` can never write these. Asserting "this
    // issue has no blocking dependency" is a claim about the world that no
    // parser can verify from the text, and a tool that asserts it on an
    // author's behalf is guessing. Same reasoning as the hierarchy guardrail.
    if (open && machine.length > 0 && (!dependenciesKnown || !duplicateKnown)) {
      const needed = [
        ...(dependenciesKnown ? [] : ['Depends-On: NONE']),
        ...(duplicateKnown ? [] : ['Duplicate-Of: NONE']),
      ];
      const blockingProse = claimed.some((entry) => entry.kind !== null);
      findings.push(finding(
        'unreachable-ready', 'blocks', issue,
        `labelled ${machine.join(', ')} but evidence is UNKNOWN, so it can only reach `
          + 'READY_WITH_UNKNOWN, never READY',
        blockingProse
          ? [...needed, 'NOT safe to assert yet: this issue states a blocking relationship in prose']
          : [...needed, 'add these two lines only if both assertions are actually true'],
        undefined,
        blockingProse ? undefined : needed,
      ));
    }

    for (const [a, b] of policy.exclusiveStatusLabels) {
      if (labels.includes(a) && labels.includes(b)) {
        findings.push(finding(
          'contradictory-status', 'blocks', issue,
          `carries both ${a} and ${b}`,
          labels,
        ));
      }
    }
    if (!open) {
      const stale = labels.filter((label) => policy.workflowLabels.includes(label));
      if (stale.length > 0) {
        findings.push(finding(
          'stale-workflow-label', 'hygiene', issue,
          `closed but still labelled ${stale.join(', ')}`,
          stale,
          { kind: 'remove-labels', number: issue.number, labels: stale },
        ));
      }
    }
    if (open && labels.length === 0) {
      findings.push(finding('unlabelled', 'hygiene', issue, 'open issue carries no labels', []));
    }

    // --- title and type ----------------------------------------------------
    const prefix = titlePrefix(issue.title);
    if (!prefix || !policy.titleTypes.includes(prefix)) {
      findings.push(finding(
        'unconventional-title', 'hygiene', issue,
        prefix
          ? `title type "${prefix}" is not in the policy vocabulary`
          : 'title has no `type:` prefix',
        [String(issue.title ?? '')],
      ));
    } else if (Object.hasOwn(policy.typeLabels, prefix)) {
      const expected = policy.typeLabels[prefix];
      if (!labels.includes(expected)) {
        findings.push(finding(
          'type-label-mismatch', 'hygiene', issue,
          `titled ${prefix}: but not labelled ${expected}`,
          labels,
          { kind: 'add-labels', number: issue.number, labels: [expected] },
        ));
      }
    }

    // --- body shape --------------------------------------------------------
    const headings = headingsOf(authored);
    const completion = headings.filter((heading) => (
      heading === policy.completionHeading || policy.completionAliases.includes(heading)
    ));
    if (completion.length === 0) {
      findings.push(finding(
        'missing-completion-criteria', 'drift', issue,
        'no heading states when this is done',
        headings,
      ));
    } else if (!completion.includes(policy.completionHeading)) {
      findings.push(finding(
        'noncanonical-completion-heading', 'hygiene', issue,
        `completion criterion is spelled "${completion[0]}", policy says "${policy.completionHeading}"`,
        completion,
      ));
    }
    for (const required of policy.requiredHeadings) {
      if (!headings.includes(required)) {
        findings.push(finding(
          'missing-section', 'hygiene', issue,
          `no "${required}" section`,
          headings,
        ));
      }
    }
    if (open && body.length > policy.maxBodyBytes) {
      findings.push(finding(
        'oversized-body', 'hygiene', issue,
        `${body.length} characters; over ${policy.maxBodyBytes} an issue is a program, not a slice`,
        [],
      ));
    }

    // --- grooming block ----------------------------------------------------
    if (malformed) {
      findings.push(finding(
        'malformed-grooming', 'drift', issue,
        `grooming block is ${malformed}`,
        [],
      ));
    }
    if (grooming) {
      const fields = groomingFieldNames(grooming);
      const expected = policy.groomingFields ?? [];
      const absent = expected.filter((field) => !fields.includes(field));
      if (absent.length > 0) {
        findings.push(finding(
          'incomplete-grooming', 'drift', issue,
          `grooming block is missing ${absent.join(', ')}`,
          fields,
        ));
      }
      const stamped = groomingTimestamp(grooming);
      if (stamped && issue.updatedAt) {
        const drift = Date.parse(issue.updatedAt) - Date.parse(stamped);
        if (Number.isFinite(drift) && drift > 24 * 60 * 60 * 1000) {
          findings.push(finding(
            'stale-grooming', 'drift', issue,
            `body edited ${Math.floor(drift / 86400000)}d after the grooming stamp ${stamped}`,
            [stamped, String(issue.updatedAt)],
          ));
        }
      }
      const priority = /\b(P[0-9])\b/u.exec(grooming);
      if (priority) {
        groomingPriorities.set(priority[1], (groomingPriorities.get(priority[1]) ?? 0) + 1);
      }
    } else if (open && (policy.groomingFields ?? []).length > 0) {
      // Only a repository that declares a grooming schema can be missing one.
      findings.push(finding('ungroomed', 'hygiene', issue, 'open issue has no grooming block', []));
    }
  }

  // --- corpus-level: signals that stopped discriminating --------------------
  if (openIssues.length >= 8) {
    for (const [label, count] of labelUse) {
      if (count / openIssues.length >= policy.degenerateShare) {
        findings.push(finding(
          'degenerate-signal', 'drift', null,
          `"${label}" is on ${count} of ${openIssues.length} open issues and no longer discriminates`,
          [`${Math.round((count / openIssues.length) * 100)}% coverage`],
        ));
      }
    }
  }
  const groomedTotal = [...groomingPriorities.values()].reduce((sum, n) => sum + n, 0);
  if (groomedTotal >= 8 && groomingPriorities.size === 1) {
    const [[only, count]] = [...groomingPriorities];
    findings.push(finding(
      'degenerate-signal', 'drift', null,
      `every groomed issue is priority ${only} (${count}/${count}); the field carries no information`,
      [only],
    ));
  }

  findings.sort((a, b) => (
    SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)
    || (a.issue ?? 0) - (b.issue ?? 0)
    || a.rule.localeCompare(b.rule)
  ));

  const counts = { blocks: 0, drift: 0, hygiene: 0 };
  for (const item of findings) counts[item.severity] += 1;

  return {
    schema: ISSUE_CONSISTENCY_SCHEMA,
    repository,
    issuesAudited: issues.length,
    openIssues: openIssues.length,
    counts,
    findings,
  };
}

/**
 * Turn findings into the exact edits that fix them, grouped per issue.
 * Body edits are additive: nothing an author wrote is rewritten or removed.
 */
export function planRepairs(report) {
  const perIssue = new Map();
  for (const item of report.findings) {
    const proposal = item.proposal;
    if (!proposal) continue;
    const entry = perIssue.get(proposal.number)
      ?? { number: proposal.number, appendLines: [], addLabels: [], removeLabels: [] };
    if (proposal.kind === 'append-lines') entry.appendLines.push(...proposal.lines);
    if (proposal.kind === 'add-labels') entry.addLabels.push(...proposal.labels);
    if (proposal.kind === 'remove-labels') entry.removeLabels.push(...proposal.labels);
    perIssue.set(proposal.number, entry);
  }
  return [...perIssue.values()]
    .map((entry) => ({
      ...entry,
      appendLines: [...new Set(entry.appendLines)],
      addLabels: [...new Set(entry.addLabels)],
      removeLabels: [...new Set(entry.removeLabels)],
    }))
    .sort((a, b) => a.number - b.number);
}

export const ISSUE_REPAIR_SCHEMA = 'gaia-issue-repair/1';

const sameSet = (a, b) => a.length === b.length && a.every((value) => b.includes(value));

/**
 * Apply a repair plan one issue at a time, with the safeguards a live label
 * batch needs:
 *
 *   1. Re-read each issue immediately before writing it, and reconcile the
 *      planned edit against what is there NOW — not against the survey.
 *   2. Skip, with a stated reason, when the issue drifted in a way that makes
 *      the repair wrong (reopened, retitled, body edited, label already gone).
 *   3. Read every mutation back and verify the labels actually landed.
 *   4. On an ambiguous result — a write that errored but may have applied —
 *      record it and STOP touching that issue. Never blindly replay.
 *
 * `readIssue(number)` and `editIssue(number, args)` are injected so this is
 * testable without a network or a repository.
 */
export async function executeRepairs({
  repairs, repository, surveyed = new Map(), readIssue, editIssue,
  apply = false, clock = () => new Date().toISOString(),
} = {}) {
  if (!Array.isArray(repairs)) throw new TypeError('repairs must be an array');
  if (typeof readIssue !== 'function') throw new TypeError('readIssue must be a function');
  if (apply && typeof editIssue !== 'function') throw new TypeError('editIssue must be a function');

  const startedAt = clock();
  const entries = [];

  for (const repair of repairs) {
    const planned = {
      addLabels: [...repair.addLabels], removeLabels: [...repair.removeLabels],
      appendLines: [...repair.appendLines],
    };
    let before;
    try {
      before = await readIssue(repair.number);
    } catch (error) {
      entries.push({
        number: repair.number, status: 'skipped', reason: `pre-read failed: ${error.message}`,
        planned, applied: null, before: null, after: null,
      });
      continue;
    }
    const beforeLabels = normalizeLabels(before);
    const wasSurveyed = surveyed.get(repair.number);
    const drift = [];
    if (wasSurveyed) {
      if (String(wasSurveyed.state).toUpperCase() !== String(before.state).toUpperCase()) {
        drift.push(`state ${wasSurveyed.state} -> ${before.state}`);
      }
      if (wasSurveyed.title !== before.title) drift.push('title changed');
      if (planned.appendLines.length > 0 && wasSurveyed.body !== before.body) {
        drift.push('body changed since the audit');
      }
    }
    // Reconcile against the issue as it is now: only remove labels still
    // present, only add labels still absent. A label someone already fixed is
    // not an error and not a write.
    const removeLabels = planned.removeLabels.filter((label) => beforeLabels.includes(label));
    const addLabels = planned.addLabels.filter((label) => !beforeLabels.includes(label));
    const appendLines = drift.includes('body changed since the audit') ? [] : planned.appendLines;

    if (drift.some((item) => item.startsWith('state ') || item === 'title changed')) {
      entries.push({
        number: repair.number, status: 'skipped', reason: drift.join('; '),
        planned, applied: null,
        before: { state: before.state, title: before.title, labels: beforeLabels }, after: null,
      });
      continue;
    }
    if (removeLabels.length === 0 && addLabels.length === 0 && appendLines.length === 0) {
      entries.push({
        number: repair.number, status: 'skipped', reason: 'already in the intended state',
        planned, applied: null,
        before: { state: before.state, title: before.title, labels: beforeLabels }, after: null,
      });
      continue;
    }

    const applied = { addLabels, removeLabels, appendLines };
    if (!apply) {
      entries.push({
        number: repair.number, status: 'planned', reason: null, planned, applied,
        before: { state: before.state, title: before.title, labels: beforeLabels }, after: null,
      });
      continue;
    }

    let writeError = null;
    try {
      await editIssue(repair.number, { addLabels, removeLabels, appendLines, before });
    } catch (error) {
      writeError = error.message;
    }

    // Read back whether the write errored or not: an error is not proof that
    // nothing happened, and success is not proof that it landed.
    let after;
    try {
      after = await readIssue(repair.number);
    } catch (error) {
      entries.push({
        number: repair.number, status: 'ambiguous',
        reason: `write ${writeError ? `errored (${writeError})` : 'reported success'} `
          + `and the read-back failed (${error.message}); not retried`,
        planned, applied,
        before: { state: before.state, title: before.title, labels: beforeLabels }, after: null,
      });
      continue;
    }
    const afterLabels = normalizeLabels(after);
    const expected = [
      ...beforeLabels.filter((label) => !removeLabels.includes(label)),
      ...addLabels,
    ];
    const landed = sameSet(expected, afterLabels);
    const record = {
      number: repair.number,
      status: landed ? 'applied' : 'ambiguous',
      reason: landed
        ? (writeError ? `write errored (${writeError}) but the change is present` : null)
        : `expected [${expected.sort().join(', ')}], read back [${afterLabels.slice().sort().join(', ')}]; not retried`,
      planned,
      applied,
      before: { state: before.state, title: before.title, labels: beforeLabels },
      after: { state: after.state, title: after.title, labels: afterLabels },
    };
    entries.push(record);
  }

  const counts = { applied: 0, planned: 0, skipped: 0, ambiguous: 0 };
  for (const entry of entries) counts[entry.status] += 1;

  return {
    schema: ISSUE_REPAIR_SCHEMA,
    repository,
    mode: apply ? 'apply' : 'dry-run',
    startedAt,
    finishedAt: clock(),
    counts,
    entries,
  };
}

/** Append trailer lines to a body without disturbing the grooming block. */
export function applyTrailers(body, lines, marker = DEFAULT_POLICY.groomingMarker) {
  if (lines.length === 0) return body;
  const text = String(body ?? '');
  const start = text.indexOf(`<!-- ${marker}:start -->`);
  const block = `${lines.join('\n')}\n`;
  if (start < 0) return `${text.replace(/\s*$/u, '')}\n\n${block}`;
  const head = text.slice(0, start).replace(/\s*$/u, '');
  return `${head}\n\n${block}\n${text.slice(start)}`;
}
