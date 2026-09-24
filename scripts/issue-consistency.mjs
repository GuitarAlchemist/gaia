#!/usr/bin/env node
// Detect and repair GitHub issue inconsistencies.
//
//   node scripts/issue-consistency.mjs audit  --repository OWNER/NAME [options]
//   node scripts/issue-consistency.mjs repair --repository OWNER/NAME [--apply]
//
// Deterministic: no model, no network beyond `gh`. Any agent — Claude, Codex,
// auggie, agy — runs the same command and gets the same findings, so the audit
// is evidence rather than opinion. Repairs are dry-run until `--apply`.

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_POLICY, SEVERITIES, applyTrailers, auditIssues, executeRepairs, planRepairs,
} from '../src/issue-consistency.mjs';

const execFileAsync = promisify(execFile);

const USAGE = `usage:
  issue-consistency.mjs audit  --repository OWNER/NAME [--state open|all] [--policy FILE]
                               [--input FILE] [--format text|json] [--fail-on blocks|drift|hygiene|none]
  issue-consistency.mjs repair --repository OWNER/NAME [--policy FILE] [--apply] [--out FILE]

repair re-reads every issue immediately before writing it, skips when it drifted, reads each
mutation back, and never replays an ambiguous write. --out captures before/after evidence.

exit codes: 0 clean · 1 findings at or above --fail-on · 2 usage · 3 could not read, nothing asserted`;

class UsageError extends Error {}
class ReadError extends Error {}

const BOOLEAN_FLAGS = new Set(['apply', 'help']);

function parseArgs(argv) {
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new UsageError(`expected --name, received ${flag}`);
    const name = flag.slice(2);
    if (Object.hasOwn(result, name)) throw new UsageError(`duplicate option: ${flag}`);
    if (BOOLEAN_FLAGS.has(name)) {
      result[name] = true;
      continue;
    }
    if (index + 1 >= argv.length) throw new UsageError(`--${name} requires a value`);
    result[name] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function gh(args) {
  try {
    const { stdout } = await execFileAsync('gh', args, {
      encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (error.code === 'ENOENT') throw new ReadError('the gh CLI is not on PATH');
    throw new ReadError(`gh ${args.slice(0, 2).join(' ')} failed: ${String(error.stderr || error.message).trim()}`);
  }
}

async function readIssues(repository, state) {
  const stdout = await gh([
    'issue', 'list', '--repo', repository, '--state', state, '--limit', '1000',
    '--json', 'number,title,state,body,labels,updatedAt,createdAt',
  ]);
  const parsed = JSON.parse(stdout || '[]');
  if (!Array.isArray(parsed)) throw new ReadError('gh issue list did not return an array');
  return parsed;
}

// Pull request numbers share the issue number space. Without them, every
// reference to a PR would be reported as unresolved — a false finding.
async function readKnownNumbers(repository, issues) {
  const known = new Set(issues.map((issue) => issue.number));
  const stdout = await gh([
    'pr', 'list', '--repo', repository, '--state', 'all', '--limit', '1000', '--json', 'number',
  ]);
  for (const row of JSON.parse(stdout || '[]')) known.add(row.number);
  return known;
}

function loadPolicy(path) {
  if (!path) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new UsageError(`could not read policy ${path}: ${error.message}`);
  }
}

const SEVERITY_MARK = { blocks: '!!', drift: ' ~', hygiene: ' ·' };

function renderText(report) {
  const lines = [];
  lines.push(`${report.repository} — ${report.issuesAudited} issues (${report.openIssues} open)`);
  lines.push(`${report.counts.blocks} blocks · ${report.counts.drift} drift · ${report.counts.hygiene} hygiene`);
  for (const severity of SEVERITIES) {
    const group = report.findings.filter((item) => item.severity === severity);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`${severity.toUpperCase()} (${group.length})`);
    for (const item of group) {
      const where = item.issue === null ? 'corpus' : `#${item.issue}`;
      lines.push(`  ${SEVERITY_MARK[severity]} ${where.padEnd(7)} ${item.rule}: ${item.summary}`);
      for (const line of item.evidence.slice(0, 3)) lines.push(`               | ${line}`);
      if (item.proposal?.kind === 'append-lines') {
        for (const line of item.proposal.lines) lines.push(`               + ${line}`);
      }
      // Marked `?` not `+`: the tool will not write these, a person decides.
      for (const line of item.suggestion ?? []) lines.push(`               ? ${line}`);
    }
  }
  const repairs = planRepairs(report);
  if (repairs.length > 0) {
    lines.push('');
    lines.push(`${repairs.length} issue(s) have a mechanical repair — see \`repair\`.`);
  }
  return `${lines.join('\n')}\n`;
}

function renderRepairs(repairs, repository, apply) {
  const lines = [`${repairs.length} issue(s) with mechanical repairs on ${repository}`];
  lines.push(apply ? 'applying:' : 'dry run — pass --apply to perform these:');
  for (const entry of repairs) {
    if (entry.appendLines.length > 0) {
      lines.push(`  #${entry.number} append to body:`);
      for (const line of entry.appendLines) lines.push(`      ${line}`);
    }
    for (const label of entry.addLabels) lines.push(`  #${entry.number} add label ${label}`);
    for (const label of entry.removeLabels) lines.push(`  #${entry.number} remove label ${label}`);
  }
  return `${lines.join('\n')}\n`;
}

async function runRepairs(repairs, repository, issues, policy, apply) {
  const scratch = mkdtempSync(join(tmpdir(), 'issue-consistency-'));
  const marker = (policy ?? DEFAULT_POLICY).groomingMarker ?? DEFAULT_POLICY.groomingMarker;
  try {
    return await executeRepairs({
      repairs,
      repository,
      apply,
      surveyed: new Map(issues.map((issue) => [issue.number, issue])),
      // Re-read from GitHub, not from the survey: this is the safeguard.
      readIssue: async (number) => JSON.parse(await gh([
        'issue', 'view', String(number), '--repo', repository,
        '--json', 'number,title,state,body,labels,updatedAt',
      ])),
      editIssue: async (number, { addLabels, removeLabels, appendLines, before }) => {
        const args = ['issue', 'edit', String(number), '--repo', repository];
        for (const label of addLabels) args.push('--add-label', label);
        for (const label of removeLabels) args.push('--remove-label', label);
        if (appendLines.length > 0) {
          const bodyPath = join(scratch, `${number}.md`);
          writeFileSync(bodyPath, applyTrailers(before.body, appendLines, marker), 'utf8');
          args.push('--body-file', bodyPath);
        }
        await gh(args);
      },
    });
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function renderResult(result) {
  const lines = [`${result.mode} on ${result.repository}`];
  for (const entry of result.entries) {
    const change = [
      ...(entry.applied?.addLabels ?? []).map((label) => `+${label}`),
      ...(entry.applied?.removeLabels ?? []).map((label) => `-${label}`),
      ...((entry.applied?.appendLines ?? []).length > 0 ? ['+body trailers'] : []),
    ].join(' ');
    lines.push(`  ${entry.status.padEnd(9)} #${String(entry.number).padEnd(4)} ${change}`
      + (entry.reason ? `  (${entry.reason})` : ''));
  }
  const { applied, planned, skipped, ambiguous } = result.counts;
  lines.push(`applied ${applied} · planned ${planned} · skipped ${skipped} · ambiguous ${ambiguous}`);
  if (ambiguous > 0) lines.push('ambiguous entries were NOT retried; reconcile them by hand');
  return `${lines.join('\n')}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.command === '--help' || !args.command) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (!['audit', 'repair'].includes(args.command)) {
    throw new UsageError(`unknown command "${args.command}"\n${USAGE}`);
  }
  if (!args.repository || !args.repository.includes('/')) {
    throw new UsageError(`--repository OWNER/NAME is required\n${USAGE}`);
  }

  const policy = loadPolicy(args.policy);
  const state = args.state ?? (args.command === 'repair' ? 'all' : 'all');
  if (!['open', 'all', 'closed'].includes(state)) throw new UsageError('--state must be open, closed or all');

  let issues;
  let knownNumbers;
  if (args.input) {
    const parsed = JSON.parse(readFileSync(args.input, 'utf8'));
    issues = Array.isArray(parsed) ? parsed : parsed.issues;
    if (!Array.isArray(issues)) throw new UsageError(`${args.input} holds no issue array`);
  } else {
    issues = await readIssues(args.repository, state);
    knownNumbers = await readKnownNumbers(args.repository, issues);
  }

  const report = auditIssues({ repository: args.repository, issues, policy, knownNumbers });

  if (args.command === 'repair') {
    const repairs = planRepairs(report);
    process.stdout.write(renderRepairs(repairs, args.repository, Boolean(args.apply)));
    if (args.input) throw new UsageError('repair reads live GitHub; --input is audit-only');
    const result = await runRepairs(repairs, args.repository, issues, policy, Boolean(args.apply));
    process.stdout.write(renderResult(result));
    if (args.out) {
      mkdirSync(dirname(args.out), { recursive: true });
      writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
      process.stdout.write(`evidence written to ${args.out}\n`);
    }
    if (result.counts.ambiguous > 0) process.exitCode = 1;
    return;
  }

  process.stdout.write(args.format === 'json'
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderText(report));

  const failOn = args['fail-on'] ?? 'blocks';
  if (failOn === 'none') return;
  if (!SEVERITIES.includes(failOn)) throw new UsageError('--fail-on must be blocks, drift, hygiene or none');
  const threshold = SEVERITIES.indexOf(failOn);
  const failing = SEVERITIES.slice(0, threshold + 1)
    .reduce((sum, severity) => sum + report.counts[severity], 0);
  if (failing > 0) process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  if (error instanceof ReadError) {
    process.stderr.write(`fail-closed: ${error.message}\nnothing was audited and nothing was written\n`);
    process.exitCode = 3;
    return;
  }
  process.stderr.write(`${error.name}: ${error.message}\n`);
  process.exitCode = 3;
});
