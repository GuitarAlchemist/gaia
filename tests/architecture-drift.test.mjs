import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  ArchitectureDriftRefusal,
  checkArchitectureDrift,
  createFilesystemArchitectureInventory,
  createInMemoryArchitectureInventory,
} from '../src/architecture-drift.mjs';

const VERIFIED = '9ffc54e5fb70bed6bf2a1f934f5cc846bc68eb3b';
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

function architecture(overrides = {}) {
  const headings = overrides.headings ?? REQUIRED_HEADINGS;
  const sections = headings.map((heading) => {
    if (heading === 'Module and seam map') {
      return `## ${heading}\n\n| Module | Interface | Seam | Concrete adapters |\n`
        + '| --- | --- | --- | --- |\n'
        + `| Drift gate | ${overrides.moduleInterface ?? 'check inventory and return a closed report or refusal'} | Repository inventory | Filesystem; in-memory |`;
    }
    if (heading === 'Detailed architecture references') {
      return `## ${heading}\n\n[Subsystem contract](docs/subsystem.md)`;
    }
    if (heading === 'Verification') {
      return `## ${heading}\n\nLast verified at commit \`${overrides.verified ?? VERIFIED}\` on 2026-09-01.`;
    }
    return `## ${heading}\n\nImplemented boundary.`;
  });
  return `# Gaia Architecture\n\nThis is Gaia's authoritative architecture map.\n\n${sections.join('\n\n')}\n`;
}

function snapshot(overrides = {}) {
  return {
    schema: 'gaia-architecture-inventory/1',
    revision: VERIFIED,
    knownRevisions: [VERIFIED],
    files: {
      'ARCHITECTURE.md': architecture(),
      'docs/subsystem.md': '# Subsystem\n',
    },
    changedPaths: ['ARCHITECTURE.md'],
    architectureImpact: { kind: 'UPDATED', evidence: 'ARCHITECTURE.md' },
    ...overrides,
  };
}

function writeTree(root, files) {
  for (const [path, content] of Object.entries(files)) {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content, 'utf8');
  }
}

test('the public drift seam has the same contract for filesystem and in-memory inventories', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-contract-'));
  try {
    const input = snapshot();
    writeTree(scratch, input.files);
    const adapters = [
      createInMemoryArchitectureInventory(input),
      createFilesystemArchitectureInventory({
        root: scratch,
        revision: input.revision,
        knownRevisions: input.knownRevisions,
        changedPaths: input.changedPaths,
        architectureImpact: input.architectureImpact,
      }),
    ];
    for (const adapter of adapters) {
      assert.deepEqual(checkArchitectureDrift(adapter), {
        schema: 'gaia-architecture-drift-report/1',
        verdict: 'PASS',
        verifiedCommit: VERIFIED,
        violations: [],
      });
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('link results are deterministic when the inventory order changes', () => {
  const first = checkArchitectureDrift(createInMemoryArchitectureInventory(snapshot()));
  const reversedFiles = Object.fromEntries(Object.entries(snapshot().files).reverse());
  const second = checkArchitectureDrift(createInMemoryArchitectureInventory(snapshot({ files: reversedFiles })));
  assert.deepEqual(second, first);
});

test('a broken internal architecture link changes PASS to a closed failure', () => {
  const baseline = checkArchitectureDrift(createInMemoryArchitectureInventory(snapshot()));
  const files = { ...snapshot().files, 'ARCHITECTURE.md': architecture().replace('docs/subsystem.md', 'docs/missing.md') };
  const mutated = checkArchitectureDrift(createInMemoryArchitectureInventory(snapshot({ files })));
  assert.equal(baseline.verdict, 'PASS');
  assert.deepEqual(mutated.violations, [{ code: 'BROKEN_INTERNAL_LINK', subject: 'docs/missing.md' }]);
});

test('removing a required section changes PASS to a closed failure', () => {
  const headings = REQUIRED_HEADINGS.filter((heading) => heading !== 'Durable and rebuildable state');
  const files = { ...snapshot().files, 'ARCHITECTURE.md': architecture({ headings }) };
  const report = checkArchitectureDrift(createInMemoryArchitectureInventory(snapshot({ files })));
  assert.deepEqual(report.violations, [{ code: 'MISSING_REQUIRED_SECTION', subject: 'Durable and rebuildable state' }]);
});

test('an unresolvable verification commit is stale', () => {
  const report = checkArchitectureDrift(createInMemoryArchitectureInventory(snapshot({ knownRevisions: [] })));
  assert.deepEqual(report.violations, [{ code: 'STALE_VERIFIED_COMMIT', subject: VERIFIED }]);
});

test('provider, configuration, and storage details cannot leak through a declared module interface', () => {
  for (const leakedInterface of ['check GitHub payload', 'read configPath', 'query DuckDB table', 'return storageLayout']) {
    const files = { ...snapshot().files, 'ARCHITECTURE.md': architecture({ moduleInterface: leakedInterface }) };
    const report = checkArchitectureDrift(createInMemoryArchitectureInventory(snapshot({ files })));
    assert.deepEqual(report.violations, [{ code: 'MODULE_INTERFACE_LEAK', subject: 'Drift gate' }]);
  }
});

test('architecture-sensitive changes require an update or an evidenced no-impact declaration', () => {
  const undecided = snapshot({
    changedPaths: ['src/bus-core.mjs'],
    architectureImpact: { kind: 'UNDECLARED', evidence: null },
  });
  const updated = snapshot({ ...undecided, changedPaths: ['src/bus-core.mjs', 'ARCHITECTURE.md'] });
  const noImpact = snapshot({
    ...undecided,
    architectureImpact: { kind: 'NO_IMPACT', evidence: 'Pure spelling correction; no boundary changed.' },
  });
  assert.deepEqual(checkArchitectureDrift(createInMemoryArchitectureInventory(undecided)).violations,
    [{ code: 'ARCHITECTURE_IMPACT_UNDECLARED', subject: 'src/bus-core.mjs' }]);
  assert.equal(checkArchitectureDrift(createInMemoryArchitectureInventory(updated)).verdict, 'PASS');
  assert.equal(checkArchitectureDrift(createInMemoryArchitectureInventory(noImpact)).verdict, 'PASS');
});

test('an inventory outside the closed adapter contract returns a typed refusal', () => {
  const malformed = snapshot({ providerPayload: { token: 'not-observed' } });
  assert.throws(
    () => checkArchitectureDrift(createInMemoryArchitectureInventory(malformed)),
    (error) => error instanceof ArchitectureDriftRefusal
      && error.code === 'INVENTORY_FIELD_SET_INVALID'
      && error.message === 'INVENTORY_FIELD_SET_INVALID',
  );
});
