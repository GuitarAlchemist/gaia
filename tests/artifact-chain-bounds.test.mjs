import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendFileSync, closeSync, existsSync, linkSync, mkdtempSync, openSync, readFileSync,
  readdirSync, renameSync, rmSync, writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildArtifactChain, evaluateArtifactChain } from '../src/artifact-chain.mjs';
import {
  ArtifactChainFileError, ARTIFACT_BYTE_LIMIT, emitCandidateArtifactChain,
  measureArtifactChainFiles, persistArtifactChainManifest, readBoundedDescriptor,
} from '../src/artifact-chain-files.mjs';

const digest = (character) => character.repeat(64);
const revision = (character) => character.repeat(40);
const codes = { unreadable: 'ArtifactUnreadable', tooLarge: 'ArtifactTooLarge' };

function temporary(run) {
  const dir = mkdtempSync(join(tmpdir(), 'gaia-chain-bounds-'));
  try { return run(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function withDescriptor(path, run) {
  const handle = openSync(path, 'r');
  try { return run(handle); } finally { closeSync(handle); }
}

test('the byte ceiling is decided from the descriptor, so a file larger than the limit is refused', () => {
  temporary((dir) => {
    const path = join(dir, 'artifact.json');
    writeFileSync(path, 'z'.repeat(4096));
    withDescriptor(path, (handle) => {
      assert.throws(() => readBoundedDescriptor(handle, 64, codes),
        (error) => error instanceof ArtifactChainFileError && error.code === 'ArtifactTooLarge');
      assert.equal(readBoundedDescriptor(handle, 4096, codes).length, 4096, 'exactly the limit is readable');
    });
  });
});

test('a file that grows after open cannot exceed the ceiling the adapter already promised', () => {
  temporary((dir) => {
    const path = join(dir, 'growing.json');
    writeFileSync(path, 'a'.repeat(256));
    withDescriptor(path, (handle) => {
      // The descriptor is open and the size was legal; the owner appends before the read.
      appendFileSync(path, 'b'.repeat(512));
      assert.throws(() => readBoundedDescriptor(handle, 256, codes), { code: 'ArtifactTooLarge' });
    });
  });
});

test('a directory or a closed descriptor is an unreadable refusal, never a partial read', () => {
  temporary((dir) => {
    const handle = openSync(dir, 'r');
    try { assert.throws(() => readBoundedDescriptor(handle, 64, codes), { code: 'ArtifactUnreadable' }); }
    finally { closeSync(handle); }
    assert.throws(() => readBoundedDescriptor(handle, 64, codes), { code: 'ArtifactUnreadable' });
    assert.throws(() => readBoundedDescriptor(openSync(join(dir, 'x'), 'w'), -1, codes), { code: 'ArtifactUnreadable' });
  });
});

test('replacing the file behind an open descriptor cannot smuggle different bytes past the ceiling', () => {
  temporary((dir) => {
    const path = join(dir, 'replaced.json');
    const other = join(dir, 'bigger.json');
    writeFileSync(path, 'a'.repeat(64));
    writeFileSync(other, 'b'.repeat(4096));
    withDescriptor(path, (handle) => {
      let replaced = true;
      try { renameSync(other, path); } catch { replaced = false; }
      const bytes = readBoundedDescriptor(handle, 64, codes);
      // Either the platform refuses to replace a file that is open, or the descriptor still
      // holds the measured file. Neither outcome may return more than the promised limit.
      assert.ok(bytes.length <= 64, `bounded at ${bytes.length} bytes (replacement ${replaced})`);
    });
  });
});

test('the immutable comparison reads the existing file under the same ceiling', () => {
  temporary((dir) => {
    const path = join(dir, 'manifest.json');
    writeFileSync(path, 'q'.repeat(ARTIFACT_BYTE_LIMIT + 1));
    const manifest = buildArtifactChain({
      descriptor: { subject: 'subject', nodes: [{ id: 'intent', stage: 'INTENT', rootRevision: null,
        producer: 'producer', locator: 'intent.json', claim: null, dependencies: [] }] },
      measured: { intent: digest('a') } });
    assert.throws(() => persistArtifactChainManifest({ path, manifest }), { code: 'ManifestConflict' });
  });
});

test('atomic no-replace publication fails closed without hard links and handles injected races', () => {
  temporary((dir) => {
    const manifest = buildArtifactChain({
      descriptor: { subject: 'subject', nodes: [{ id: 'intent', stage: 'INTENT', rootRevision: null,
        producer: 'producer', locator: 'intent.json', claim: null, dependencies: [] }] },
      measured: { intent: digest('a') } });
    assert.throws(() => persistArtifactChainManifest({ path: join(dir, 'absent', 'manifest.json'), manifest }),
      error => error instanceof ArtifactChainFileError && error.code === 'ManifestWriteFailed'
        && error.message === 'ManifestWriteFailed');
    assert.deepEqual(readdirSync(dir), []);

    for (const code of ['EXDEV', 'EIO']) {
      const path = join(dir, `${code.toLowerCase()}.json`);
      assert.throws(() => persistArtifactChainManifest({ path, manifest }, {
        link: () => { throw Object.assign(new Error('injected link refusal'), { code }); },
      }), error => error instanceof ArtifactChainFileError && error.code === 'ManifestWriteFailed');
      assert.equal(existsSync(path), false, `${code} leaves no visible destination`);
      assert.equal(readdirSync(dir).some(name => name.startsWith(`.${code.toLowerCase()}.json.`)), false,
        `${code} withdraws its complete temporary sibling`);
    }

    const identicalRace = join(dir, 'identical-race.json');
    assert.deepEqual(persistArtifactChainManifest({ path: identicalRace, manifest }, {
      link: (source, destination) => {
        linkSync(source, destination);
        throw Object.assign(new Error('injected lost link acknowledgement'), { code: 'EEXIST' });
      },
    }), { status: 'UNCHANGED' });
    assert.ok(existsSync(identicalRace), 'a concurrent complete identical publication converges');

    const conflictingRace = join(dir, 'conflicting-race.json');
    assert.throws(() => persistArtifactChainManifest({ path: conflictingRace, manifest }, {
      link: (_source, destination) => {
        writeFileSync(destination, 'concurrent different bytes\n', { flag: 'wx' });
        throw Object.assign(new Error('injected concurrent winner'), { code: 'EEXIST' });
      },
    }), error => error instanceof ArtifactChainFileError && error.code === 'ManifestConflict');
    assert.equal(readFileSync(conflictingRace, 'utf8'), 'concurrent different bytes\n');
  });
});

test('immutable publication flushes its namespace boundary and retries an uncertain flush', () => {
  temporary((dir) => {
    const probe = join(dir, 'fsync-probe.cjs');
    const runner = join(dir, 'persist.mjs');
    const log = join(dir, 'fsync.log');
    writeFileSync(probe, [
      "const fs = require('node:fs');",
      "const { syncBuiltinESMExports } = require('node:module');",
      'const original = fs.fsyncSync;',
      'fs.fsyncSync = (fd) => {',
      "  const directory = fs.fstatSync(fd).isDirectory();",
      "  fs.appendFileSync(process.env.GAIA_FSYNC_LOG, directory ? 'D' : 'F');",
      "  if (directory && process.env.GAIA_FAIL_DIRECTORY === '1') {",
      "    throw Object.assign(new Error('injected directory sync failure'), { code: 'EIO' });",
      '  }',
      '  return original(fd);',
      '};',
      'syncBuiltinESMExports();',
    ].join('\n'));
    writeFileSync(runner, [
      `import { buildArtifactChain } from ${JSON.stringify(new URL('../src/artifact-chain.mjs', import.meta.url).href)};`,
      `import { persistArtifactChainManifest } from ${JSON.stringify(new URL('../src/artifact-chain-files.mjs', import.meta.url).href)};`,
      "const manifest = buildArtifactChain({ descriptor: { subject: 'subject', nodes: [",
      "  { id: 'intent', stage: 'INTENT', rootRevision: null, producer: 'producer',",
      "    locator: 'intent.json', claim: null, dependencies: [] }] },",
      "  measured: { intent: 'a'.repeat(64) } });",
      'try {',
      '  const first = persistArtifactChainManifest({ path: process.argv[2], manifest });',
      '  const second = persistArtifactChainManifest({ path: process.argv[2], manifest });',
      '  process.stdout.write(JSON.stringify({ first, second }));',
      '} catch (error) {',
      '  process.stdout.write(JSON.stringify({ code: error.code }));',
      '  process.exitCode = 3;',
      '}',
    ].join('\n'));
    const run = (path, failDirectory = false) => {
      writeFileSync(log, '');
      const required = `--require "${probe.replaceAll('\\', '/')}"`;
      return spawnSync(process.execPath, [runner, path], { encoding: 'utf8', windowsHide: true,
        env: { ...process.env, NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} ${required}`.trim(),
          GAIA_FSYNC_LOG: log, GAIA_FAIL_DIRECTORY: failDirectory ? '1' : '0' } });
    };

    const path = join(dir, 'manifest.json');
    const written = run(path);
    assert.equal(written.status, 0, written.stderr);
    assert.deepEqual(JSON.parse(written.stdout), { first: { status: 'WRITTEN' }, second: { status: 'UNCHANGED' } });
    const marks = readFileSync(log, 'utf8');
    if (process.platform === 'win32') assert.ok(/^F{3,}$/u.test(marks), `file entry flushes recorded: ${marks}`);
    else assert.match(marks, /^F.*D.*D$/u, `file then parent directory flushes recorded: ${marks}`);

    if (process.platform !== 'win32') {
      const uncertain = join(dir, 'uncertain.json');
      const failed = run(uncertain, true);
      assert.equal(failed.status, 3);
      assert.deepEqual(JSON.parse(failed.stdout), { code: 'ManifestWriteFailed' });
      assert.equal(existsSync(uncertain), true,
        'exit-3 publication-boundary refusal may retain a complete destination for re-sync');
      assert.equal(readdirSync(dir).some(name => name.startsWith('.uncertain.json.')), false);
      const retried = run(uncertain);
      assert.equal(retried.status, 0, retried.stderr);
      assert.deepEqual(JSON.parse(retried.stdout),
        { first: { status: 'UNCHANGED' }, second: { status: 'UNCHANGED' } });
      assert.match(readFileSync(log, 'utf8'), /^FDFD$/u,
        'each retry flushes its temporary bytes, removes them, then flushes before UNCHANGED');
    }
  });
});

test('an oversize artifact is still refused through the public measurement seam', () => {
  temporary((dir) => {
    writeFileSync(join(dir, 'huge.json'), 'p'.repeat(ARTIFACT_BYTE_LIMIT + 1));
    assert.throws(() => measureArtifactChainFiles({ root: dir,
      nodes: [{ id: 'intent', locator: 'huge.json' }] }), { code: 'ArtifactTooLarge' });
  });
});

test('a sidecar refusal after the stored intent is written leaves that evidence in place', () => {
  temporary((dir) => {
    const intent = { repository: 'owner/name', itemNumber: 141,
      draft: { number: 145, headRevision: revision('c') } };
    // `receipt.json` is absent, so measurement refuses after `intent.json` is already durable.
    assert.throws(() => emitCandidateArtifactChain({ evidenceDir: dir, intent, status: 'CANDIDATE_READY' }),
      { code: 'ArtifactUnreadable' });
    assert.ok(existsSync(join(dir, 'intent.json')), 'the stored intent persists; a refusal is not a rollback');
    assert.equal(existsSync(join(dir, 'artifact-chain.json')), false, 'no manifest claims a chain that failed');
    // Immutable data stays immutable: a later complete run reuses the identical stored intent.
    writeFileSync(join(dir, 'receipt.json'), '{"status":"CANDIDATE_READY"}');
    const emitted = emitCandidateArtifactChain({ evidenceDir: dir, intent, status: 'CANDIDATE_READY' });
    assert.equal(emitted.storedIntent, 'UNCHANGED');
    assert.equal(emitted.status, 'WRITTEN');
  });
});

test('a node identifier, revision or digest must be a string, not a value a regex coerces into one', () => {
  const node = { id: 'intent', stage: 'INTENT', rootRevision: null, producer: 'producer',
    locator: 'intent.json', claim: null, dependencies: [] };
  const build = (override, measured) => () => buildArtifactChain({
    descriptor: { subject: 'subject', nodes: [{ ...node, ...override }] },
    measured: measured ?? { [override.id ?? 'intent']: digest('a') } });
  assert.throws(build({ id: 1234 }, { 1234: digest('a') }), { code: 'InvalidDescriptor' });
  assert.throws(build({ rootRevision: [revision('b')] }), { code: 'InvalidDescriptor' });
  assert.throws(build({}, { intent: [digest('a')] }), { code: 'InvalidMeasurement' });
  assert.throws(build({ claim: { kind: 1, statement: 'x' } }), { code: 'InvalidDescriptor' });
  assert.throws(build({ dependencies: [{ nodeId: 1234, relation: 'required' }] }), { code: 'InvalidDescriptor' });

  const manifest = buildArtifactChain({ descriptor: { subject: 'subject', nodes: [node] },
    measured: { intent: digest('a') } });
  assert.throws(() => evaluateArtifactChain({ manifest, observed: { intent: [digest('a')] },
    expectation: { subject: 'subject', requiredRootRevisions: [revision('b')] } }), { code: 'InvalidObservation' });
  assert.throws(() => evaluateArtifactChain({ manifest, observed: { intent: digest('a') },
    expectation: { subject: 'subject', requiredRootRevisions: [[revision('b')]] } }), { code: 'InvalidExpectation' });
});

const chainOf = (rootRevision) => buildArtifactChain({ descriptor: { subject: 'subject', nodes: [
  { id: 'intent', stage: 'INTENT', rootRevision: null, producer: 'producer', locator: 'intent.json',
    claim: { kind: 'ACCEPTED_INTENT', statement: 'recorded intent' }, dependencies: [] },
  { id: 'candidate', stage: 'CANDIDATE', rootRevision, producer: 'producer', locator: 'receipt.json',
    claim: { kind: 'CANDIDATE_READY', statement: 'asserted by the receipt' },
    dependencies: [{ nodeId: 'intent', relation: 'required', pinnedDigest: digest('a') }] }] },
measured: { intent: digest('a'), candidate: digest('c') } });

const observed = { intent: digest('a'), candidate: digest('c') };

test('a chain bound to no revision at all cannot declare itself current for the caller revision', () => {
  const report = evaluateArtifactChain({ manifest: chainOf(null), observed,
    expectation: { subject: 'subject', requiredRootRevisions: [revision('9')] } });
  assert.equal(report.rootRevisionBinding, 'UNBOUND');
  assert.equal(report.verdict, 'CHAIN_STALE');
  assert.ok(report.nodes.every((node) => node.freshness === 'FRESH'),
    'every node still resolves; it is the chain that is bound to nothing');
});

test('a chain bound to the caller revision stays fresh, and a different revision stays stale', () => {
  const fresh = evaluateArtifactChain({ manifest: chainOf(revision('9')), observed,
    expectation: { subject: 'subject', requiredRootRevisions: [revision('9')] } });
  assert.equal(fresh.rootRevisionBinding, 'BOUND');
  assert.equal(fresh.verdict, 'CHAIN_FRESH');
  // Advisory semantics are unchanged: a claim is never reported as a result.
  assert.deepEqual(fresh.nodes.map((node) => node.claimStatus),
    ['ASSERTED_NOT_VERIFIED', 'ASSERTED_NOT_VERIFIED']);
  assert.deepEqual(fresh.stages.filter((stage) => stage.status === 'NOT_PROVIDED').map((stage) => stage.stage),
    ['TEST_EVIDENCE', 'INDEPENDENT_REVIEW', 'PUBLICATION_EVIDENCE']);

  const stale = evaluateArtifactChain({ manifest: chainOf(revision('9')), observed,
    expectation: { subject: 'subject', requiredRootRevisions: [revision('8')] } });
  assert.equal(stale.verdict, 'CHAIN_STALE');
  assert.equal(stale.nodes.find((node) => node.id === 'candidate').freshness, 'STALE_ROOT_REVISION');
});

test('the candidate sidecar a real run emits is bound to its input base and stays evaluable', () => {
  temporary((dir) => {
    const intent = { repository: 'owner/name', itemNumber: 141,
      draft: { number: 145, headRevision: revision('c') } };
    writeFileSync(join(dir, 'receipt.json'), '{"status":"CANDIDATE_READY"}');
    const emitted = emitCandidateArtifactChain({ evidenceDir: dir, intent, status: 'CANDIDATE_READY' });
    assert.equal(emitted.status, 'WRITTEN');
    const manifest = JSON.parse(String(
      readFileOf(join(dir, 'artifact-chain.json'))));
    const measured = measureArtifactChainFiles({ root: dir, nodes: manifest.nodes });
    const report = evaluateArtifactChain({ manifest, observed: measured,
      expectation: { subject: emitted.subject, requiredRootRevisions: [revision('c')] } });
    assert.equal(report.rootRevisionBinding, 'BOUND');
    assert.equal(report.verdict, 'CHAIN_FRESH');
  });
});

function readFileOf(path) {
  return withDescriptor(path, (handle) => readBoundedDescriptor(handle, ARTIFACT_BYTE_LIMIT,
    { unreadable: 'ArtifactUnreadable', tooLarge: 'ArtifactTooLarge' }));
}
