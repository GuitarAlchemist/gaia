#!/usr/bin/env node
// Propose the next issues for the Gaia pump. Read-only: it never labels, seeds or dispatches.
//
//   node scripts/pump-candidates.mjs --repository OWNER/NAME [--limit 3] [--format text|json]

import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { rankCandidates } from '../src/pump-candidates.mjs';

const execFileAsync = promisify(execFile);
const USAGE = `usage: pump-candidates.mjs --repository OWNER/NAME [--limit 3] [--format text|json] [--exclude-label L]

Lists open issues the pump could take next: no excluded label (needs-triage, needs-info,
ready-for-human, blocked, ...), a readable native blocker count of zero, no declared dependency
or duplicate, not a parent of another issue, a "Done when" or acceptance
section, and never drafted or seeded before. Nothing is written; labelling stays yours.

exit codes: 0 ok · 2 usage · 3 could not read`;

class UsageError extends Error {}

function parseArgs(argv) {
  const result = { 'exclude-label': [] };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new UsageError(`expected --name, received ${flag}`);
    const name = flag.slice(2);
    if (name === 'help') {
      result.help = true;
      continue;
    }
    if (index + 1 >= argv.length) throw new UsageError(`--${name} requires a value`);
    if (name === 'exclude-label') result[name].push(argv[index + 1]);
    else if (Object.hasOwn(result, name)) throw new UsageError(`duplicate option: ${flag}`);
    else result[name] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function gh(args) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
  const output = stdout.trim();
  return output.length === 0 ? null : JSON.parse(output);
}

function renderText(result) {
  const lines = [
    `${result.repository}: ${result.eligibleCount} eligible, ${result.refused.length} refused`,
  ];
  if (result.candidates.length === 0) {
    lines.push('no candidate — groom issues (remove needs-triage, add "Done when") to create some');
  } else {
    lines.push('');
    for (const { issue, title } of result.candidates) lines.push(`  #${issue}  ${title}`);
    lines.push('', 'to queue them:');
    for (const { issue } of result.candidates) lines.push(`  bash C:/Gaia/pump-once.sh ${issue}`);
  }
  const tally = new Map();
  for (const row of result.refused) {
    for (const reason of row.reasons) {
      tally.set(reason, (tally.get(reason) ?? 0) + 1);
    }
  }
  lines.push('', 'refusal reasons:');
  for (const [reason, count] of [...tally].sort((left, right) => right[1] - left[1])) {
    lines.push(`  ${String(count).padStart(3)}  ${reason}`);
  }
  return `${lines.join('\n')}\n`;
}

export async function main({
  argv = process.argv.slice(2), read = gh, stdout = process.stdout, stderr = process.stderr,
} = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    stdout.write(`${USAGE}\n`);
    return 0;
  }
  const repository = args.repository;
  if (!repository || !/^[\w.-]+\/[\w.-]+$/u.test(repository)) {
    throw new UsageError(`--repository OWNER/NAME is required\n${USAGE}`);
  }
  const limit = Number(args.limit ?? 3);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new UsageError('--limit must be 1..20');
  if (args.format && !['text', 'json'].includes(args.format)) throw new UsageError('--format must be text or json');

  let issues;
  let pullRequests;
  let branchRows;
  try {
    [issues, pullRequests, branchRows] = await Promise.all([
      // gh issue list's selected fields omit native dependencies. Keep the REST summary
      // through every page so a missing body trailer cannot conceal an open blocker.
      read(['api', `repos/${repository}/issues?state=open&per_page=100`, '--paginate', '--slurp']),
      read(['pr', 'list', '--repo', repository, '--state', 'all', '--limit', '1000',
        '--search', 'deliver issue in:title', '--json', 'number,title']),
      read(['api', `repos/${repository}/git/matching-refs/heads/gaia/issue-`, '--paginate', '--slurp']),
    ]);
  } catch (error) {
    stderr.write(`fail-closed: could not read ${repository}: ${String(error.stderr || error.message).trim()}\n`);
    return 3;
  }
  const result = rankCandidates({
    repository,
    issues: (issues ?? []).flat(),
    pullRequests: pullRequests ?? [],
    branchNames: (branchRows ?? []).flat().map((row) => String(row.ref).replace(/^refs\/heads\//u, '')),
    excludeLabels: args['exclude-label'],
    limit,
  });
  stdout.write(args.format === 'json' ? `${JSON.stringify(result, null, 2)}\n` : renderText(result));
  return 0;
}

const directExecution = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (directExecution) main().then((code) => { process.exitCode = code; }).catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`fail-closed: ${error.name}: ${error.message}\n`);
  process.exitCode = 3;
});
