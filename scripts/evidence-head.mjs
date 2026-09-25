#!/usr/bin/env node
// Seed the evidence head the hosted Draft collector requires for one ready issue.
//
//   node scripts/evidence-head.mjs seed --repository OWNER/NAME --issue N [--apply]
//
// Dry run by default. The issue must already carry `ready-for-agent`, applied by
// an actor with triage or stronger; this tool never applies that label.

import { createGhDraftCollectorApi } from '../src/hosted-draft-collector.mjs';
import { createGhEvidenceHeadWriter, seedEvidenceHead } from '../src/evidence-head-seeder.mjs';

const USAGE = `usage: evidence-head.mjs seed --repository OWNER/NAME --issue N [--apply]

Creates branch gaia/issue-N-ready-K whose single empty commit carries the Gaia-Issue and
Gaia-Ready-Receipt trailers of the issue's latest ready-for-agent label event.

exit codes: 0 planned/present/created · 1 refused, failed or ambiguous · 2 usage · 3 fail-closed`;

class UsageError extends Error {}

function parseArgs(argv) {
  const result = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new UsageError(`expected --name, received ${flag}`);
    const name = flag.slice(2);
    if (Object.hasOwn(result, name)) throw new UsageError(`duplicate option: ${flag}`);
    if (name === 'apply' || name === 'help') {
      result[name] = true;
      continue;
    }
    if (index + 1 >= argv.length) throw new UsageError(`--${name} requires a value`);
    result[name] = argv[index + 1];
    index += 1;
  }
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command || args.command === '--help') {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args.command !== 'seed') throw new UsageError(`unknown command "${args.command}"\n${USAGE}`);
  const [owner, name, extra] = String(args.repository ?? '').split('/');
  if (!owner || !name || extra !== undefined) throw new UsageError(`--repository OWNER/NAME is required\n${USAGE}`);
  const number = Number(args.issue);
  if (!Number.isSafeInteger(number) || number <= 0) throw new UsageError(`--issue N is required\n${USAGE}`);

  const result = await seedEvidenceHead({
    github: createGhDraftCollectorApi(),
    writer: args.apply ? createGhEvidenceHeadWriter() : null,
    selector: { repository: { owner, name }, workItem: { kind: 'ISSUE', number } },
    apply: Boolean(args.apply),
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!['PLANNED', 'PRESENT', 'CREATED'].includes(result.status)) process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof UsageError) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`fail-closed: ${error.code ?? error.name}: ${error.message}\n`);
  process.exitCode = 3;
});
