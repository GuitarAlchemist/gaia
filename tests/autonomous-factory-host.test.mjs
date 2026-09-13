import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectHostedDraftReceipts, prepareAutonomousWorktree } from '../src/autonomous-factory-host.mjs';

test('discovery only downloads successful trusted workflow runs into private per-run cache', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-discovery-'));
  const calls = [];
  try {
    const run = (file, args) => {
      calls.push([file, args]);
      if (args[1] === 'list') return JSON.stringify([{ databaseId: 123, event: 'schedule', headSha: 'a'.repeat(40) }]);
      if (args[1] === 'download') {
        writeFileSync(join(args[args.indexOf('--dir') + 1], 'gaia-hosted-draft-intake-receipt.json'), '{"diagnostic":"not a valid receipt"}');
        return '';
      }
      throw new Error('unexpected command');
    };
    assert.equal(collectHostedDraftReceipts({ repository: 'Example/app', cacheDir: root, run }).entries.length, 0);
    assert.equal(collectHostedDraftReceipts({ repository: 'Example/app', cacheDir: root, run }).entries.length, 0);
    assert.equal(calls.filter(([, args]) => args[1] === 'download').length, 1);
    const list = calls[0][1];
    assert.ok(list.includes('hosted-draft-intake.yml'));
    assert.ok(list.includes('success'));
    assert.ok(list.includes('main'));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('untrusted run identifiers and pull-request workflow events never reach download', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-runs-'));
  try {
    let downloads = 0;
    const run = (_file, args) => {
      if (args[1] === 'list') return JSON.stringify([
        { databaseId: '../escape', event: 'schedule', headSha: 'a'.repeat(40) },
        { databaseId: 1, event: 'pull_request', headSha: 'a'.repeat(40) },
      ]);
      downloads++; return '';
    };
    assert.equal(collectHostedDraftReceipts({ repository: 'Example/app', cacheDir: root, run }).entries.length, 0);
    assert.equal(downloads, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('worktree preparation rejects untrusted ref syntax before Git and refuses moved head', () => {
  const root = mkdtempSync(join(tmpdir(), 'gaia-auto-worktrees-'));
  try {
    const input = { clone: root, worktreeRoot: root, operationMarker: 'a'.repeat(64), headRevision: 'b'.repeat(40), headRef: '--upload-pack=evil' };
    let calls = 0;
    assert.throws(() => prepareAutonomousWorktree({ ...input, run: () => { calls++; } }), /InvalidHeadRef/);
    assert.equal(calls, 0);
    assert.throws(() => prepareAutonomousWorktree({ ...input, headRef: 'codex/fix', run: (_file, args) => {
      calls++;
      if (args.includes('rev-parse')) return 'c'.repeat(40);
      return '';
    } }), /SourceMoved/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
