import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ArchitectureDriftRefusal,
  checkArchitectureDrift,
  createFilesystemArchitectureInventory,
  createInMemoryArchitectureInventory,
} from '../src/architecture-drift.mjs';

const VERIFIED = '83516746a1f54fecc1b9e261df47f42f431a5642';
const REQUIRED_HEADINGS = [
  'Purpose, scope, and non-goals',
  'System context and organization-neutral boundary',
  'Components and dependency direction',
  'Module and seam map',
  'Work lifecycle: pumps, funnels, and lanes',
  'Authority and state transitions',
  'Durable and rebuildable state',
  'Providers and offline artifacts',
  'Failure, restart, replay, reconciliation, and alerts',
  'Security, tenancy, quotas, and human approvals',
  'Observability, provenance, freshness, ETA, and delivery metrics',
  'Runtime topology and operating modes',
  'Detailed architecture references',
  'Verification',
];

function digest(content) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function architecture(overrides = {}) {
  const headings = overrides.headings ?? REQUIRED_HEADINGS;
  const sections = headings.map((heading) => {
    if (heading === 'Module and seam map') {
      return `## ${heading}\n\n| Module | Interface | Seam | Concrete adapters |\n`
        + '| --- | --- | --- | --- |\n'
        + `| Drift gate | ${overrides.moduleInterface ?? 'check inventory and return a closed report or refusal'} | Repository inventory | Filesystem; in-memory |`;
    }
    if (heading === 'Detailed architecture references') {
      return `## ${heading}\n\n[Subsystem contract](${overrides.link ?? 'docs/subsystem.md'})`;
    }
    if (heading === 'Verification') {
      return `## ${heading}\n\nThe authoritative machine-readable \`Last verified at\` record is \`package.json#gaiaArchitectureVerification\`.`;
    }
    return `## ${heading}\n\nImplemented boundary.`;
  });
  return `# Gaia Architecture\n\nThis is Gaia's authoritative architecture map.\n\n${sections.join('\n\n')}\n`;
}

function verificationPackage(record) {
  return `${JSON.stringify({
    name: 'production-shaped-package',
    private: true,
    gaiaArchitectureVerification: record,
  }, null, 2)}\n`;
}

function snapshot(overrides = {}) {
  const markdown = overrides.architecture ?? architecture();
  const verification = {
    schema: 'gaia-architecture-verification/1',
    commit: VERIFIED,
    date: '2026-09-01',
    contentRevision: digest(markdown),
    ...overrides.verification,
  };
  const files = {
    'ARCHITECTURE.md': markdown,
    'package.json': verificationPackage(verification),
    'docs/subsystem.md': '# Subsystem\n',
    ...overrides.files,
  };
  return {
    schema: 'gaia-architecture-inventory/1',
    revision: '9e006fb3c03a3d097dd70f7f55b37273ec9d30e4',
    architectureRevisions: [{ commit: verification.commit, contentRevision: digest(markdown) }],
    files,
    changedPaths: ['ARCHITECTURE.md'],
    architectureImpact: { kind: 'UPDATED', evidence: 'ARCHITECTURE.md' },
    ...overrides.inventory,
    ...(overrides.architectureRevisions === undefined
      ? {} : { architectureRevisions: overrides.architectureRevisions }),
  };
}

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

function forEachAdapter(input, assertion) {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-contract-'));
  try {
    writeTree(scratch, input.files);
    const adapters = [
      ['in-memory', createInMemoryArchitectureInventory(input)],
      ['filesystem', createFilesystemArchitectureInventory({
        root: scratch,
        revision: input.revision,
        architectureRevisions: input.architectureRevisions,
        changedPaths: input.changedPaths,
        architectureImpact: input.architectureImpact,
      })],
    ];
    for (const [name, adapter] of adapters) assertion(adapter, name);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

test('the public drift seam has the same closed report for filesystem and in-memory inventories', () => {
  const input = snapshot();
  forEachAdapter(input, (adapter, name) => {
    assert.deepEqual(checkArchitectureDrift(adapter), {
      schema: 'gaia-architecture-drift-report/1',
      verdict: 'PASS',
      verifiedCommit: VERIFIED,
      architectureContentRevision: digest(input.files['ARCHITECTURE.md']),
      advisories: [],
      violations: [],
    }, name);
  });
});

test('both adapters deterministically close broken links and missing required sections', () => {
  const cases = [
    [snapshot({ architecture: architecture({ link: 'docs/missing.md' }) }),
      { code: 'BROKEN_INTERNAL_LINK', subject: 'docs/missing.md' }],
    [snapshot({
      architecture: architecture({
        headings: REQUIRED_HEADINGS.filter((heading) => heading !== 'Durable and rebuildable state'),
      }),
    }), { code: 'MISSING_REQUIRED_SECTION', subject: 'Durable and rebuildable state' }],
  ];
  for (const [input, expected] of cases) {
    forEachAdapter(input, (adapter, name) => {
      assert.deepEqual(checkArchitectureDrift(adapter).violations, [expected], name);
    });
  }
});

test('both adapters reject a historical commit that does not contain the reviewed architecture bytes', () => {
  const input = snapshot({
    architectureRevisions: [{ commit: VERIFIED, contentRevision: digest('older architecture bytes\n') }],
  });
  forEachAdapter(input, (adapter, name) => {
    assert.deepEqual(checkArchitectureDrift(adapter).violations,
      [{ code: 'STALE_VERIFIED_COMMIT', subject: VERIFIED }], name);
  });
});

test('both adapters bind the attestation to the exact current ARCHITECTURE.md bytes', () => {
  const before = architecture();
  const after = `${before}\n`;
  const input = snapshot({
    architecture: after,
    verification: { contentRevision: digest(before) },
    architectureRevisions: [{ commit: VERIFIED, contentRevision: digest(before) }],
  });
  forEachAdapter(input, (adapter, name) => {
    assert.deepEqual(checkArchitectureDrift(adapter).violations, [{
      code: 'ARCHITECTURE_CONTENT_REVISION_MISMATCH',
      subject: digest(after),
    }], name);
  });
});

test('both adapters report interface prose tokens as advisory rather than architectural proof', () => {
  for (const leakedInterface of ['check GitHub payload', 'read configPath', 'query DuckDB table', 'return storageLayout']) {
    const input = snapshot({ architecture: architecture({ moduleInterface: leakedInterface }) });
    forEachAdapter(input, (adapter, name) => {
      const report = checkArchitectureDrift(adapter);
      assert.equal(report.verdict, 'PASS', name);
      assert.deepEqual(report.violations, [], name);
      assert.deepEqual(report.advisories,
        [{ code: 'MODULE_INTERFACE_TOKEN_ADVISORY', subject: 'Drift gate' }], name);
    });
  }
});

test('both adapters require architecture impact evidence for sensitive changes', () => {
  const cases = [
    [snapshot({ inventory: {
      changedPaths: ['src/bus-core.mjs'],
      architectureImpact: { kind: 'UNDECLARED', evidence: null },
    } }), 'FAIL'],
    [snapshot({ inventory: {
      changedPaths: ['src/bus-core.mjs', 'ARCHITECTURE.md'],
      architectureImpact: { kind: 'UPDATED', evidence: 'ARCHITECTURE.md' },
    } }), 'PASS'],
    [snapshot({ inventory: {
      changedPaths: ['src/bus-core.mjs'],
      architectureImpact: { kind: 'NO_IMPACT', evidence: 'Spelling only; no boundary changed.' },
    } }), 'PASS'],
  ];
  for (const [input, verdict] of cases) {
    forEachAdapter(input, (adapter, name) => assert.equal(checkArchitectureDrift(adapter).verdict, verdict, name));
  }
});

test('both adapters turn malformed verification input into the same typed refusal', () => {
  const input = snapshot({ files: { 'package.json': '{not-json\n' } });
  forEachAdapter(input, (adapter) => {
    assert.throws(
      () => checkArchitectureDrift(adapter),
      (error) => error instanceof ArchitectureDriftRefusal
        && error.code === 'VERIFICATION_RECORD_INVALID'
        && error.message === 'VERIFICATION_RECORD_INVALID',
    );
  });
});

test('DELETION DEPTH: the public checker is one policy owner used by local and CI gates', () => {
  const cli = readFileSync(new URL('../scripts/architecture-drift.mjs', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(cli, /checkArchitectureDrift/);
  assert.match(packageJson, /"architecture:verify": "node scripts\/architecture-drift\.mjs"/);
  assert.match(workflow, /npm run architecture:verify/);
  assert.doesNotMatch(cli, /MISSING_REQUIRED_SECTION|BROKEN_INTERNAL_LINK|STALE_VERIFIED_COMMIT/);
});

test('MECHANISM REVERT: removing the commit-content witness makes the stale-revision case escape', async () => {
  const input = snapshot({
    architectureRevisions: [{ commit: VERIFIED, contentRevision: digest('older architecture bytes\n') }],
  });
  assert.equal(checkArchitectureDrift(createInMemoryArchitectureInventory(input)).verdict, 'FAIL');

  const source = readFileSync(new URL('../src/architecture-drift.mjs', import.meta.url), 'utf8');
  const marker = 'if (witnessContentRevision !== verification.contentRevision) {';
  const mutant = source.replace(marker, 'if (false && witnessContentRevision !== verification.contentRevision) {');
  assert.notEqual(mutant, source, 'the commit-content witness mutation must be applied');
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-mutant-'));
  try {
    const mutantPath = join(scratch, 'architecture-drift.mjs');
    writeFileSync(mutantPath, mutant, 'utf8');
    const mutatedModule = await import(`${pathToFileURL(mutantPath).href}?mutation=commit-content-witness`);
    const report = mutatedModule.checkArchitectureDrift(
      mutatedModule.createInMemoryArchitectureInventory(input),
    );
    assert.equal(report.verdict, 'PASS');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});
