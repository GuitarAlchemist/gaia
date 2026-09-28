/**
 * check-resume-prompt-cli.test.mjs — the resume entrypoint end to end: real Git, real files, the
 * shipped CLI as a child process. Issue #104.
 *
 * Every case builds its own subject worktree and a bare `origin`, so the observation adapter is
 * exercised against the thing it adapts rather than against a fake. The base case is the one that
 * discriminates: the subject's own remote-tracking ref is left stale while the remote moves, so a
 * resolver that read the local ref would agree where this one refuses.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'check-resume-prompt.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'gaia-resume-cli-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', ...args], {
  cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
}).trim();

function commit(repo, file, content, message) {
  writeFileSync(join(repo, file), content, 'utf8');
  git(repo, 'add', file);
  git(repo, '-c', 'user.name=Gaia Test', '-c', 'user.email=gaia@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message);
  return git(repo, 'rev-parse', 'HEAD');
}

/** A subject worktree whose `origin` is a local bare repository, both at one commit. */
function fixture(name) {
  const dir = join(scratch, name);
  mkdirSync(dir);
  const origin = join(dir, 'origin.git');
  const subject = join(dir, 'subject');
  git(dir, 'init', '-q', '--bare', '--initial-branch=main', origin);
  git(dir, 'init', '-q', '--initial-branch=main', subject);
  const head = commit(subject, 'candidate.txt', 'entry\n', 'entry');
  git(subject, 'remote', 'add', 'origin', origin);
  git(subject, 'push', '-q', 'origin', 'main');
  git(subject, 'fetch', '-q', 'origin');
  return { dir, origin, subject, head };
}

function writePrompt(dir, text) {
  const path = join(dir, 'prompt.txt');
  writeFileSync(path, text, 'utf8');
  return path;
}

const bindingPrompt = ({ subject, head }, extra = '') => [
  'You are the bounded repair writer.',
  `Exclusive worktree: ${subject}`,
  `Required clean entry HEAD: ${head}`,
  extra,
  '',
].join('\n');

function run(...args) {
  const result = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.error, undefined);
  return { code: result.status, out: result.stdout, err: result.stderr };
}

const lines = (out, prefix) => out.split('\n').filter((line) => line.startsWith(prefix));

test('CLI: a prompt that agrees with its worktree exits 0 and writes nothing', () => {
  const world = fixture('agree');
  const prompt = writePrompt(world.dir, bindingPrompt(world));
  const index = readFileSync(join(world.subject, '.git', 'index'));
  const result = run('--prompt', prompt, '--subject', world.subject, '--commit', world.head);
  assert.equal(result.code, 0, result.err);
  assert.deepEqual(lines(result.out, 'verdict='), ['verdict=RESUME_AGREED']);
  assert.deepEqual(lines(result.out, 'subject='),
    [`subject=${world.subject} declared=${world.head} observed=${world.head} clean=true`]);
  assert.deepEqual(lines(result.out, 'authority='), ['authority=NONE']);
  assert.deepEqual(readFileSync(join(world.subject, '.git', 'index')), index,
    'the observation does not even refresh the index');
  assert.equal(git(world.subject, 'status', '--porcelain'), '');
});

test('CLI: a worktree that moved past the declared commit is refused with exit 3', () => {
  const world = fixture('moved');
  const prompt = writePrompt(world.dir, bindingPrompt(world));
  const moved = commit(world.subject, 'candidate.txt', 'moved\n', 'moved');
  const result = run('--prompt', prompt, '--subject', world.subject, '--commit', world.head);
  assert.equal(result.code, 3);
  assert.deepEqual(lines(result.out, 'refusal='), [
    `refusal=RESUME_SUBJECT_COMMIT_MISMATCH declared=${world.head} observed=${moved}`]);
});

test('CLI: an untracked file makes the subject dirty and refuses the prompt', () => {
  const world = fixture('dirty');
  const prompt = writePrompt(world.dir, bindingPrompt(world));
  writeFileSync(join(world.subject, 'stray.txt'), 'left behind\n', 'utf8');
  const result = run('--prompt', prompt, '--subject', world.subject, '--commit', world.head);
  assert.equal(result.code, 3);
  assert.deepEqual(lines(result.out, 'refusal='), ['refusal=RESUME_SUBJECT_DIRTY']);
});

test('CLI: the base pin is compared with the live remote, not the stale local tracking ref', () => {
  const world = fixture('stale-base');
  const pinned = world.head;
  const prompt = writePrompt(world.dir, bindingPrompt(world, `CI base: origin/main at ${pinned}`));
  const agreed = run('--prompt', prompt, '--subject', world.subject, '--commit', world.head,
    '--base', 'origin/main', '--base-pin', pinned);
  assert.equal(agreed.code, 0, agreed.err);

  // Another clone merges to main. The subject never fetches, so its origin/main still says pinned.
  const other = join(world.dir, 'other');
  git(world.dir, 'clone', '-q', world.origin, other);
  const merged = commit(other, 'merged.txt', 'merged\n', 'merged');
  git(other, 'push', '-q', 'origin', 'main');
  assert.equal(git(world.subject, 'rev-parse', 'origin/main'), pinned,
    'a resolver reading the local tracking ref would still agree');

  const result = run('--prompt', prompt, '--subject', world.subject, '--commit', world.head,
    '--base', 'origin/main', '--base-pin', pinned);
  assert.equal(result.code, 3);
  assert.deepEqual(lines(result.out, 'refusal='), [
    `refusal=RESUME_BASE_PIN_STALE ref=origin/main pinned=${pinned} resolved=${merged}`]);
});

test('CLI: an uncited verdict on the entry commit blocks until the prompt cites it', () => {
  const world = fixture('blocking');
  const review = join(world.dir, 'spec-review.md');
  writeFileSync(review, `# Spec review\n\n- Subject reviewed: \`${world.head}\`\n\n`
    + 'REQUEST_CHANGES\n\nSPEC_REVIEW_COMPLETE\n', 'utf8');
  const omitted = writePrompt(world.dir, bindingPrompt(world));
  const refused = run('--prompt', omitted, '--subject', world.subject, '--commit', world.head,
    '--upstream', review);
  assert.equal(refused.code, 3);
  assert.deepEqual(lines(refused.out, 'refusal='), [`refusal=RESUME_BLOCKING_INPUT_OMITTED `
    + `artifact=${review} verdict=REQUEST_CHANGES marker=SPEC_REVIEW_COMPLETE`]);

  const cited = writePrompt(world.dir, bindingPrompt(world, `Blocking input: ${review}`));
  const agreed = run('--prompt', cited, '--subject', world.subject, '--commit', world.head,
    '--upstream', review, '--json');
  assert.equal(agreed.code, 0, agreed.err);
  const report = JSON.parse(agreed.out);
  assert.equal(report.verdict, 'RESUME_AGREED');
  assert.deepEqual(report.upstream, [{ path: review, blocking: true, cited: true,
    verdict: 'REQUEST_CHANGES', marker: 'SPEC_REVIEW_COMPLETE' }]);
});

test('CLI: a malformed command line is a usage error with exit 2', () => {
  const world = fixture('usage');
  const prompt = writePrompt(world.dir, bindingPrompt(world));
  for (const args of [
    ['--prompt', prompt, '--subject', world.subject],
    ['--prompt', prompt, '--subject', world.subject, '--commit', world.head.slice(0, 12)],
    ['--prompt', prompt, '--subject', world.subject, '--commit', world.head, '--base', 'origin/main'],
    ['--prompt', prompt, '--subject', world.subject, '--commit', world.head, '--force'],
    ['--prompt', prompt, '--subject', world.subject, '--commit', world.head, '--commit', world.head],
  ]) {
    const result = run(...args);
    assert.equal(result.code, 2, `${args.join(' ')}\n${result.err}`);
    assert.match(result.err, /^usage error: /u);
  }
});

test('CLI: an unobservable world fails closed with exit 3, never agreement', () => {
  const world = fixture('unobservable');
  const plain = join(world.dir, 'not-a-repository');
  mkdirSync(plain);
  mkdirSync(join(world.subject, 'nested'));
  const cases = [
    [['--subject', plain, '--commit', world.head], 'SUBJECT_NOT_WORKTREE_ROOT'],
    [['--subject', join(world.subject, 'nested'), '--commit', world.head], 'SUBJECT_NOT_WORKTREE_ROOT'],
    [['--subject', join(world.dir, 'missing'), '--commit', world.head], 'SUBJECT_UNREADABLE'],
    [['--subject', world.subject, '--commit', world.head, '--base', 'upstream/main',
      '--base-pin', world.head], 'BASE_REMOTE_UNKNOWN'],
    [['--subject', world.subject, '--commit', world.head, '--base', 'origin/no-such-branch',
      '--base-pin', world.head], 'BASE_UNRESOLVED'],
    [['--subject', world.subject, '--commit', world.head, '--upstream',
      join(world.dir, 'missing.md')], 'UPSTREAM_UNREADABLE'],
  ];
  for (const [args, detail] of cases) {
    const prompt = writePrompt(world.dir, bindingPrompt({ subject: args[1], head: world.head }));
    const result = run('--prompt', prompt, ...args);
    assert.equal(result.code, 3, `${detail}\n${result.err}`);
    assert.equal(result.out, '');
    assert.equal(result.err, `REFUSED: RESUME_OBSERVATION_UNAVAILABLE ${detail}\n`);
  }
  const unreadable = run('--prompt', join(world.dir, 'no-prompt.txt'), '--subject', world.subject,
    '--commit', world.head);
  assert.equal(unreadable.code, 3);
  assert.equal(unreadable.err, 'REFUSED: RESUME_PROMPT_INVALID\n');
});
