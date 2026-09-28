#!/usr/bin/env node
/**
 * check-resume-prompt.mjs — refuse a lane prompt that disagrees with the tree or the artifact set,
 * before the lane is spawned or resumed. The single resume entrypoint (issue #104).
 *
 * Usage
 *   node scripts/check-resume-prompt.mjs --prompt <file> --subject <worktree> --commit <40-hex>
 *       [--base <remote>/<branch> --base-pin <40-hex>] [--upstream <file>]... [--json]
 *
 * The flags are the resume manifest: the structured declaration the prompt is written against.
 *   --subject   the worktree root the lane will work in;
 *   --commit    the full commit (the generation) the prompt says that worktree is at;
 *   --base      the base the prompt pins, with --base-pin the literal commit it pins;
 *   --upstream  every prior-round artifact that may block this prompt (reviews, handoffs).
 *
 * Git reads the subject (HEAD, `status --porcelain`) and resolves the base on its remote with
 * `ls-remote`; the upstream files are read. The prompt must cite the subject path, the full
 * commit and the base pin; the subject must be at that commit and clean; the pin must equal the
 * base now; every upstream artifact naming the commit with a verdict or a completion marker must
 * be cited by file name. Nothing is written, and agreement grants no authority.
 *
 * Exit codes: 0 RESUME_AGREED · 2 usage error · 3 refused or fail-closed (every disagreement is
 * a named refusal; an unobservable world is RESUME_OBSERVATION_UNAVAILABLE, never agreement).
 * There is no exit 1: a prompt that disagrees with its world is not launched, so a refusal here
 * is always fail-closed.
 */

import { resolve } from 'node:path';

import {
  ResumeManifestError, buildResumeManifest, checkResumePrompt,
} from '../src/resume-manifest.mjs';
import { observeResumeWorld, readResumePrompt } from '../src/resume-manifest-git.mjs';

const USAGE = 'usage: node scripts/check-resume-prompt.mjs --prompt <file> --subject <worktree> '
  + '--commit <40-hex>\n'
  + '       [--base <remote>/<branch> --base-pin <40-hex>] [--upstream <file>]... [--json]\n';

const VALUED = new Set(['prompt', 'subject', 'commit', 'base', 'base-pin', 'upstream']);
const REPEATED = new Set(['upstream']);
const FLAGS = new Set([...VALUED, 'json']);

class UsageError extends Error {}
const usageError = (message) => { throw new UsageError(message); };

function parse(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) usageError(`unexpected argument: ${token}`);
    const name = token.slice(2);
    if (!FLAGS.has(name)) usageError(`unknown flag: ${token}`);
    if (!VALUED.has(name)) { flags[name] = true; continue; }
    const value = argv[index += 1];
    if (value === undefined || value.startsWith('--')) usageError(`${token} needs a value`);
    if (REPEATED.has(name)) (flags[name] ??= []).push(value);
    else if (flags[name] !== undefined) usageError(`${token} given more than once`);
    else flags[name] = value;
  }
  for (const required of ['prompt', 'subject', 'commit']) {
    if (flags[required] === undefined) usageError(`--${required} is required`);
  }
  if ((flags.base === undefined) !== (flags['base-pin'] === undefined)) {
    usageError('--base and --base-pin are given together or not at all');
  }
  return flags;
}

function declare(flags) {
  try {
    return buildResumeManifest({
      subjectPath: resolve(flags.subject),
      declaredCommit: flags.commit,
      baseRef: flags.base ?? null,
      basePin: flags['base-pin'] ?? null,
      upstreamArtifacts: (flags.upstream ?? []).map((path) => resolve(path)),
    });
  } catch (error) {
    // A malformed declaration is a wrong command line, not a disagreement with the world.
    if (error instanceof ResumeManifestError) usageError(error.message);
    throw error;
  }
}

function render(report) {
  const { subject, base } = report;
  return [
    `verdict=${report.verdict}`,
    `prompt=sha256:${report.prompt.sha256} chars=${report.prompt.chars}`,
    `subject=${subject.path} declared=${subject.declared} observed=${subject.observed} `
      + `clean=${subject.clean}`,
    ...(base === null ? [] : [`base=${base.ref} pinned=${base.pinned} resolved=${base.resolved}`]),
    ...report.upstream.map((artifact) => `upstream=${artifact.path} `
      + `blocking=${artifact.blocking ? 'yes' : 'no'} cited=${artifact.cited ? 'yes' : 'no'} `
      + `verdict=${artifact.verdict ?? 'none'} marker=${artifact.marker ?? 'none'}`),
    ...report.refusals.map(({ code, ...detail }) => [`refusal=${code}`,
      ...Object.entries(detail).map(([key, value]) => `${key}=${value ?? 'none'}`)].join(' ')),
    `authority=${report.authority}`,
  ].join('\n') + '\n';
}

function main(argv) {
  if (argv.includes('--help')) { process.stdout.write(USAGE); return 0; }
  const flags = parse(argv);
  const manifest = declare(flags);
  const promptText = readResumePrompt(resolve(flags.prompt));
  const report = checkResumePrompt({ promptText, manifest, observation: observeResumeWorld(manifest) });
  process.stdout.write(flags.json ? `${JSON.stringify(report)}\n` : render(report));
  return report.verdict === 'RESUME_AGREED' ? 0 : 3;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (error) {
  if (error instanceof UsageError) {
    process.stderr.write(`usage error: ${error.message}\n${USAGE}`);
    process.exitCode = 2;
  } else if (error instanceof ResumeManifestError) {
    process.stderr.write(`REFUSED: ${error.code}${error.detail === null ? '' : ` ${error.detail}`}\n`);
    process.exitCode = 3;
  } else {
    process.stderr.write('REFUSED: RESUME_CHECK_FAILED\n');
    process.exitCode = 3;
  }
}
