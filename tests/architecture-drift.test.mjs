import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  ArchitectureDriftRefusal,
  checkArchitectureDrift,
  createFilesystemArchitectureInventory,
  createInMemoryArchitectureInventory,
} from '../src/architecture-drift.mjs';

const VERIFIED = '83516746a1f54fecc1b9e261df47f42f431a5642';
// A well-formed commit identifier that no fixture history contains: the shape a squash merge
// leaves behind when the record names a commit of the merged head branch.
const ORPHANED = 'b37b37b37b37b37b37b37b37b37b37b37b37b37b';
const MALFORMED_COMMITS = [
  '65c48b4d',
  '83516746A1F54FECC1B9E261DF47F42F431A5642',
  '83516746a1f54fecc1b9e261df47f42f431a564',
  '83516746a1f54fecc1b9e261df47f42f431a56420',
  'g3516746a1f54fecc1b9e261df47f42f431a5642',
  '',
];
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
        + `| Drift gate | \`${overrides.moduleInterface ?? 'check(inventory) -> report or refusal'}\` | Repository inventory | Filesystem; in-memory |`;
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
    schema: 'gaia-architecture-inventory/2',
    revision: '9e006fb3c03a3d097dd70f7f55b37273ec9d30e4',
    files,
    changedPaths: ['ARCHITECTURE.md'],
    architectureImpact: { kind: 'UPDATED', evidence: 'ARCHITECTURE.md' },
    ...overrides.inventory,
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
        changedPaths: input.changedPaths,
        architectureImpact: input.architectureImpact,
      })],
    ];
    for (const [name, adapter] of adapters) assertion(adapter, name);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

const CLI_PRODUCT_PATHS = [
  'scripts/architecture-drift.mjs',
  'src/architecture-drift.mjs',
  'src/templates.mjs',
  'src/event-log.mjs',
  'src/ecosystem.mjs',
];

function run(root, command, args, env = {}) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, ...env },
  });
}

function git(root, args) {
  const result = run(root, 'git', args);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function copyCliProduct(root, { checker = true, checkerSource = null, scriptSource = null } = {}) {
  for (const path of CLI_PRODUCT_PATHS) {
    if (!checker && path === 'src/architecture-drift.mjs') continue;
    let content = readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    if (path === 'scripts/architecture-drift.mjs' && scriptSource !== null) content = scriptSource;
    if (path === 'src/architecture-drift.mjs' && checkerSource !== null) content = checkerSource;
    writeTree(root, { [path]: content });
  }
}

// Two-commit recipe: the reviewed ARCHITECTURE.md bytes land first, then a record that names
// that commit. `recordCommit` and `attestedArchitecture` let a test shape the record alone.
function createCliGitFixture({
  checker = true,
  scriptSource = null,
  recordCommit = null,
  attestedArchitecture = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gaia-architecture-cli-'));
  copyCliProduct(root, { checker, scriptSource });
  writeTree(root, {
    'ARCHITECTURE.md': architecture(),
    'docs/subsystem.md': '# Subsystem\n',
    'package.json': '{"name":"architecture-cli-fixture","private":true}\n',
  });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Gaia Architecture Test']);
  git(root, ['config', 'user.email', 'architecture-test@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture: older architecture']);
  const olderCommit = git(root, ['rev-parse', 'HEAD']);

  const currentArchitecture = architecture().replace(
    "This is Gaia's authoritative architecture map.",
    "This is Gaia's authoritative architecture map. Reviewed current bytes.",
  );
  writeTree(root, { 'ARCHITECTURE.md': currentArchitecture });
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture: current architecture']);
  const reviewedCommit = git(root, ['rev-parse', 'HEAD']);

  writeTree(root, {
    'package.json': verificationPackage({
      schema: 'gaia-architecture-verification/1',
      commit: recordCommit ?? reviewedCommit,
      date: '2026-09-01',
      contentRevision: digest(attestedArchitecture ?? currentArchitecture),
    }),
  });
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture: attest current architecture']);
  git(root, ['branch', 'base-fixture', reviewedCommit]);
  return { root, olderCommit, reviewedCommit, currentArchitecture };
}

function createPolicyCliFixture({
  witnessArchitecture = architecture(),
  currentArchitecture = witnessArchitecture,
  attestedArchitecture = currentArchitecture,
  changedFiles = { 'README.md': '# Current fixture\n' },
  eventBody = 'Architecture impact: none\nArchitecture evidence: Test-only fixture.',
  checkerSource = null,
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'gaia-architecture-policy-cli-'));
  copyCliProduct(root, { checkerSource });
  writeTree(root, {
    'ARCHITECTURE.md': witnessArchitecture,
    'docs/subsystem.md': '# Subsystem\n',
    'package.json': '{"name":"architecture-policy-fixture","private":true}\n',
  });
  git(root, ['init', '--quiet']);
  git(root, ['config', 'user.name', 'Gaia Architecture Test']);
  git(root, ['config', 'user.email', 'architecture-test@example.invalid']);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture: architecture witness']);
  const reviewedCommit = git(root, ['rev-parse', 'HEAD']);

  writeTree(root, {
    'ARCHITECTURE.md': currentArchitecture,
    'package.json': verificationPackage({
      schema: 'gaia-architecture-verification/1',
      commit: reviewedCommit,
      date: '2026-09-01',
      contentRevision: digest(attestedArchitecture),
    }),
  });
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture: attest architecture']);
  const baseCommit = git(root, ['rev-parse', 'HEAD']);

  writeTree(root, changedFiles);
  git(root, ['add', '.']);
  git(root, ['commit', '--quiet', '-m', 'fixture: proposed change']);
  const eventPath = join(root, '.git', 'event.json');
  writeFileSync(eventPath, JSON.stringify(eventBody === null ? {} : {
    pull_request: { body: eventBody },
  }), 'utf8');
  return { root, reviewedCommit, baseCommit, eventPath };
}

function runCli(root, args, env = {}) {
  return run(root, process.execPath, ['scripts/architecture-drift.mjs', ...args], env);
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

test('both adapters pass a record whose commit no history contains when its content revision matches', () => {
  const input = snapshot({ verification: { commit: ORPHANED } });
  forEachAdapter(input, (adapter, name) => {
    const report = checkArchitectureDrift(adapter);
    assert.equal(report.verdict, 'PASS', name);
    assert.equal(report.verifiedCommit, ORPHANED, name);
    assert.deepEqual(report.violations, [], name);
  });
});

test('both adapters refuse a malformed record commit before producing a report', () => {
  for (const commit of MALFORMED_COMMITS) {
    const input = snapshot({ verification: { commit } });
    forEachAdapter(input, (adapter, name) => {
      assert.throws(
        () => checkArchitectureDrift(adapter),
        (error) => error instanceof ArchitectureDriftRefusal && error.code === 'VERIFICATION_RECORD_INVALID',
        `${name}: ${JSON.stringify(commit)}`,
      );
    });
  }
});

test('both adapters bind the attestation to the exact current ARCHITECTURE.md bytes', () => {
  const before = architecture();
  const after = `${before}\n`;
  const input = snapshot({
    architecture: after,
    verification: { contentRevision: digest(before) },
  });
  forEachAdapter(input, (adapter, name) => {
    assert.deepEqual(checkArchitectureDrift(adapter).violations, [{
      code: 'ARCHITECTURE_CONTENT_REVISION_MISMATCH',
      subject: digest(after),
    }], name);
  });
});

test('both adapters structurally reject adapter and object-identifier terms in a declared interface', () => {
  for (const leakedInterface of [
    'check(githubPayload)',
    'read(configPath)',
    'query(duckdbTable)',
    'return(storageLayout)',
    'retry(providerError)',
    'checkArchitectureDrift(commitSha)',
    'checkArchitectureDrift(commitSHA)',
    'checkArchitectureDrift(commit_sha)',
    'read(commitHash)',
    'read(objectIdentifier)',
    'read(object_id)',
    'read(gitObjectId)',
    'checkArchitectureDrift(commitShas)',
    'read(objectIds)',
    'read(objectIdentifiers)',
    'read(commitHashes)',
    'read(objectOids)',
    'checkArchitectureDrift(commitSHAs)',
    'read(objectIDs)',
    'read(objectOIDs)',
    'checkArchitectureDrift(commit_SHAs)',
    'read(object_IDs)',
    'read(object_OIDs)',
    'query(duckDBs)',
    'retries(intent) -> result',
  ]) {
    const input = snapshot({ architecture: architecture({ moduleInterface: leakedInterface }) });
    forEachAdapter(input, (adapter, name) => {
      const report = checkArchitectureDrift(adapter);
      assert.equal(report.verdict, 'FAIL', `${name}: ${leakedInterface}`);
      assert.deepEqual(report.violations,
        [{ code: 'MODULE_INTERFACE_LEAK', subject: 'Drift gate' }], name);
      assert.deepEqual(report.advisories, [], name);
    });
  }
});

test('both adapters preserve domain identifiers that only contain forbidden character sequences', () => {
  for (const domainInterface of [
    'configure(intent) -> result',
    'retryable(intent) -> result',
    'commit(expected revision, events) -> receipt',
    'resolve(referencePoint) -> result',
    'classify(objectIdentity) -> reading',
    'compare(commits) -> result',
    'read(objects) -> result',
    'classify(objectives) -> reading',
    'compare(commitShares) -> result',
    'classify(objectIdeals) -> reading',
    'read(entries) -> result',
    'cluster(DBSCANPoints) -> result',
  ]) {
    const input = snapshot({ architecture: architecture({ moduleInterface: domainInterface }) });
    forEachAdapter(input, (adapter, name) => {
      assert.equal(checkArchitectureDrift(adapter).verdict, 'PASS', `${name}: ${domainInterface}`);
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

test('the public CLI rejects an option-shaped base before Git can create an output file', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-base-'));
  try {
    const productRoot = fileURLToPath(new URL('..', import.meta.url));
    const outputPrefix = join(scratch, 'git-output-').replaceAll('\\', '/');
    const result = runCli(productRoot, ['--base', `--output=${outputPrefix}`]);
    assert.equal(result.status, 2);
    assert.equal(result.stderr, 'CLI_BASE_INVALID\n');
    assert.deepEqual(readdirSync(scratch), []);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('the public CLI derives changed paths from Git for commit and canonical-ref bases', () => {
  const fixture = createCliGitFixture();
  try {
    const updated = runCli(fixture.root, ['--base', fixture.olderCommit]);
    assert.equal(updated.status, 0, updated.stderr || updated.stdout);
    assert.deepEqual(JSON.parse(updated.stdout).violations, []);
    for (const base of [fixture.reviewedCommit, 'refs/heads/base-fixture']) {
      const result = runCli(fixture.root, ['--base', base]);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout).violations,
        [{ code: 'ARCHITECTURE_IMPACT_UNDECLARED', subject: 'package.json' }], base);
    }
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('B37: the public CLI passes a record whose commit is unresolvable when the content revision matches', () => {
  const fixture = createCliGitFixture({ recordCommit: ORPHANED });
  try {
    assert.notEqual(
      run(fixture.root, 'git', ['cat-file', '-e', '--end-of-options', `${ORPHANED}^{commit}`]).status,
      0,
      'the recorded commit must be absent from the fixture history',
    );
    const result = runCli(fixture.root, ['--base', fixture.olderCommit]);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stderr, '');
    assert.deepEqual(JSON.parse(result.stdout), {
      schema: 'gaia-architecture-drift-report/1',
      verdict: 'PASS',
      verifiedCommit: ORPHANED,
      architectureContentRevision: digest(fixture.currentArchitecture),
      advisories: [],
      violations: [],
    });
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('MECHANISM REVERT: requiring the recorded commit to resolve breaks the gate in a clone without that ref', () => {
  const source = readFileSync(new URL('../scripts/architecture-drift.mjs', import.meta.url), 'utf8');
  const marker = "const revision = git(root, ['rev-parse', 'HEAD']);";
  const resolvability = "git(root, ['cat-file', '-e', '--end-of-options', "
    + "JSON.parse(readFileSync(`${root}/package.json`, 'utf8')).gaiaArchitectureVerification.commit]);";
  const mutant = source.replace(marker, `${marker}\n  ${resolvability}`);
  assert.notEqual(mutant, source, 'the commit-resolvability mutation must be applied');
  const fixture = createCliGitFixture({ recordCommit: ORPHANED, scriptSource: mutant });
  try {
    const result = runCli(fixture.root, ['--base', fixture.olderCommit]);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, 'REPOSITORY_READ_FAILED\n');
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the public CLI fails a record whose content revision does not match the ARCHITECTURE.md bytes at HEAD', () => {
  const fixture = createCliGitFixture({ attestedArchitecture: architecture() });
  try {
    const result = runCli(fixture.root, ['--base', fixture.olderCommit]);
    assert.equal(result.status, 1, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.verdict, 'FAIL');
    assert.deepEqual(report.violations, [{
      code: 'ARCHITECTURE_CONTENT_REVISION_MISMATCH',
      subject: digest(fixture.currentArchitecture),
    }]);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the public CLI refuses a malformed record commit without producing a report', () => {
  for (const commit of ['65c48b4d', '83516746A1F54FECC1B9E261DF47F42F431A5642']) {
    const fixture = createCliGitFixture({ recordCommit: commit });
    try {
      const result = runCli(fixture.root, ['--base', fixture.olderCommit]);
      assert.equal(result.status, 2, commit);
      assert.equal(result.stdout, '', commit);
      assert.equal(result.stderr, 'VERIFICATION_RECORD_INVALID\n', commit);
    } finally {
      rmSync(fixture.root, { recursive: true, force: true });
    }
  }
});

test('a production push event does not run the pull-request-only architecture impact gate', () => {
  const fixture = createPolicyCliFixture({
    changedFiles: { 'src/push-sensitive.mjs': 'export const changed = true;\n' },
    eventBody: null,
  });
  try {
    const result = runCli(fixture.root, ['--base', fixture.baseCommit], {
      GITHUB_EVENT_NAME: 'push',
      GITHUB_EVENT_PATH: fixture.eventPath,
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(result.stdout, '');

    const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
    const architectureJob = workflow.match(/^  architecture:\r?\n([\s\S]*?)(?=^  supported:)/m)?.[0] ?? '';
    assert.match(architectureJob, /^    if: github\.event_name == 'pull_request'$/m);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('DELETION DEPTH: removing the checker makes the public CLI refuse without a report', () => {
  const fixture = createCliGitFixture({ checker: false });
  try {
    const before = git(fixture.root, ['status', '--short']);
    const result = runCli(fixture.root, ['--base', fixture.reviewedCommit]);
    assert.notEqual(result.status, 0);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /ERR_MODULE_NOT_FOUND|Cannot find module/);
    assert.match(result.stderr, /architecture-drift\.mjs/);
    assert.equal(git(fixture.root, ['status', '--short']), before);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('DELETION DEPTH: a shallow replacement lets every hidden policy escape at the public caller', () => {
  const shallowChecker = `export class ArchitectureDriftRefusal extends Error {
  constructor(code) { super(code); this.code = code; }
}
export function createFilesystemArchitectureInventory(options) { return options; }
export function checkArchitectureDrift() {
  return { schema: 'gaia-architecture-drift-report/1', verdict: 'PASS',
    verifiedCommit: null, architectureContentRevision: null, advisories: [], violations: [] };
}
`;
  const missingSection = architecture({
    headings: REQUIRED_HEADINGS.filter((heading) => heading !== 'Durable and rebuildable state'),
  });
  const leakedInterface = architecture({ moduleInterface: 'check(githubPayload)' });
  const cases = [
    {
      name: 'broken link',
      witnessArchitecture: architecture({ link: 'docs/missing.md' }),
      expectedCode: 'BROKEN_INTERNAL_LINK',
    },
    {
      name: 'missing section',
      witnessArchitecture: missingSection,
      expectedCode: 'MISSING_REQUIRED_SECTION',
    },
    {
      name: 'stale revision',
      witnessArchitecture: architecture(),
      currentArchitecture: architecture().replace('Implemented boundary.', 'Changed boundary.'),
      attestedArchitecture: architecture(),
      expectedCode: 'ARCHITECTURE_CONTENT_REVISION_MISMATCH',
    },
    {
      name: 'interface leak',
      witnessArchitecture: leakedInterface,
      expectedCode: 'MODULE_INTERFACE_LEAK',
    },
    {
      name: 'undeclared impact',
      changedFiles: { 'src/undeclared-sensitive.mjs': 'export const changed = true;\n' },
      eventBody: '',
      expectedCode: 'ARCHITECTURE_IMPACT_UNDECLARED',
    },
  ];

  for (const policyCase of cases) {
    const production = createPolicyCliFixture(policyCase);
    const shallow = createPolicyCliFixture({ ...policyCase, checkerSource: shallowChecker });
    try {
      const productionResult = runCli(production.root, ['--base', production.baseCommit], {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: production.eventPath,
      });
      assert.equal(productionResult.status, 1, `${policyCase.name}: ${productionResult.stderr}`);
      assert.ok(JSON.parse(productionResult.stdout).violations
        .some(({ code }) => code === policyCase.expectedCode), policyCase.name);

      const shallowResult = runCli(shallow.root, ['--base', shallow.baseCommit], {
        GITHUB_EVENT_NAME: 'pull_request',
        GITHUB_EVENT_PATH: shallow.eventPath,
      });
      assert.equal(shallowResult.status, 0, `${policyCase.name}: ${shallowResult.stderr}`);
      assert.equal(JSON.parse(shallowResult.stdout).verdict, 'PASS', policyCase.name);
    } finally {
      rmSync(production.root, { recursive: true, force: true });
      rmSync(shallow.root, { recursive: true, force: true });
    }
  }
});

test('MECHANISM REVERT: removing the content-revision binding lets an un-attested ARCHITECTURE.md pass', async () => {
  const before = architecture();
  const input = snapshot({ architecture: `${before}\n`, verification: { contentRevision: digest(before) } });
  assert.equal(checkArchitectureDrift(createInMemoryArchitectureInventory(input)).verdict, 'FAIL');

  const source = readFileSync(new URL('../src/architecture-drift.mjs', import.meta.url), 'utf8');
  const marker = 'if (actualContentRevision !== verification.contentRevision) {';
  const mutant = source.replace(marker, 'if (false && actualContentRevision !== verification.contentRevision) {');
  assert.notEqual(mutant, source, 'the content-revision binding mutation must be applied');
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-mutant-'));
  try {
    const mutantPath = join(scratch, 'architecture-drift.mjs');
    writeFileSync(mutantPath, mutant, 'utf8');
    const mutatedModule = await import(`${pathToFileURL(mutantPath).href}?mutation=content-revision-binding`);
    const report = mutatedModule.checkArchitectureDrift(
      mutatedModule.createInMemoryArchitectureInventory(input),
    );
    assert.equal(report.verdict, 'PASS');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('MECHANISM REVERT: removing the commit-shape check lets a malformed record commit produce a report', async () => {
  const input = snapshot({ verification: { commit: '65c48b4d' } });
  assert.throws(
    () => checkArchitectureDrift(createInMemoryArchitectureInventory(input)),
    (error) => error instanceof ArchitectureDriftRefusal && error.code === 'VERIFICATION_RECORD_INVALID',
  );

  const source = readFileSync(new URL('../src/architecture-drift.mjs', import.meta.url), 'utf8');
  const marker = "    || typeof record.commit !== 'string' || !COMMIT.test(record.commit)\n";
  const mutant = source.replace(marker, '');
  assert.notEqual(mutant, source, 'the commit-shape mutation must be applied');
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-commit-shape-mutant-'));
  try {
    const mutantPath = join(scratch, 'architecture-drift.mjs');
    writeFileSync(mutantPath, mutant, 'utf8');
    const mutatedModule = await import(`${pathToFileURL(mutantPath).href}?mutation=commit-shape`);
    const report = mutatedModule.checkArchitectureDrift(
      mutatedModule.createInMemoryArchitectureInventory(input),
    );
    assert.equal(report.verdict, 'PASS');
    assert.equal(report.verifiedCommit, '65c48b4d');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

test('MECHANISM REVERT: removing token policy or plural canonicalization restores interface leaks', async () => {
  const input = snapshot({
    architecture: architecture({ moduleInterface: 'checkArchitectureDrift(commitSha)' }),
  });
  assert.deepEqual(
    checkArchitectureDrift(createInMemoryArchitectureInventory(input)).violations,
    [{ code: 'MODULE_INTERFACE_LEAK', subject: 'Drift gate' }],
  );

  const source = readFileSync(new URL('../src/architecture-drift.mjs', import.meta.url), 'utf8');
  const mutant = source.replace("  'sha',\n", '');
  assert.notEqual(mutant, source, 'the closed SHA-token mutation must be applied');
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-interface-mutant-'));
  try {
    const mutantPath = join(scratch, 'architecture-drift.mjs');
    writeFileSync(mutantPath, mutant, 'utf8');
    const mutatedModule = await import(`${pathToFileURL(mutantPath).href}?mutation=interface-sha-token`);
    const report = mutatedModule.checkArchitectureDrift(
      mutatedModule.createInMemoryArchitectureInventory(input),
    );
    assert.equal(report.verdict, 'PASS');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  const leakedInterfaces = [
    'checkArchitectureDrift(commitShas)',
    'read(objectIds)',
    'read(objectIdentifiers)',
    'read(commitHashes)',
    'read(objectOids)',
    'checkArchitectureDrift(commitSHAs)',
    'read(objectIDs)',
    'read(objectOIDs)',
    'checkArchitectureDrift(commit_SHAs)',
    'read(object_IDs)',
    'read(object_OIDs)',
    'query(duckDBs)',
    'retries(intent) -> result',
  ];
  for (const moduleInterface of leakedInterfaces) {
    const input = snapshot({ architecture: architecture({ moduleInterface }) });
    assert.deepEqual(
      checkArchitectureDrift(createInMemoryArchitectureInventory(input)).violations,
      [{ code: 'MODULE_INTERFACE_LEAK', subject: 'Drift gate' }],
      moduleInterface,
    );
  }

  const pluralSource = readFileSync(new URL('../src/architecture-drift.mjs', import.meta.url), 'utf8');
  const canonicalization = "canonical.push(FORBIDDEN_INTERFACE_TOKEN_FORMS.get(tokens.slice(start, end).join('')));";
  const pluralMutant = pluralSource.replace(
    canonicalization,
    "canonical.push(tokens.slice(start, end).join(''));",
  );
  assert.notEqual(pluralMutant, pluralSource, 'the plural token canonicalization mutation must be applied');
  const pluralScratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-plural-interface-mutant-'));
  try {
    const mutantPath = join(pluralScratch, 'architecture-drift.mjs');
    writeFileSync(mutantPath, pluralMutant, 'utf8');
    const mutatedModule = await import(`${pathToFileURL(mutantPath).href}?mutation=plural-token-canonicalization`);
    for (const moduleInterface of leakedInterfaces) {
      const input = snapshot({ architecture: architecture({ moduleInterface }) });
      const report = mutatedModule.checkArchitectureDrift(
        mutatedModule.createInMemoryArchitectureInventory(input),
      );
      assert.equal(report.verdict, 'PASS', moduleInterface);
    }
  } finally {
    rmSync(pluralScratch, { recursive: true, force: true });
  }
});

test('MECHANISM REVERT: removing base validation and option termination restores the Git write', () => {
  const source = readFileSync(new URL('../scripts/architecture-drift.mjs', import.meta.url), 'utf8');
  const validation = "if (!isClosedBase(value)) throw new ArchitectureDriftRefusal('CLI_BASE_INVALID');";
  let mutant = source.replace(
    validation,
    "if (false && !isClosedBase(value)) throw new ArchitectureDriftRefusal('CLI_BASE_INVALID');",
  );
  assert.notEqual(mutant, source, 'the closed base validation mutation must be applied');
  const terminated = "'diff', '--name-only', '--end-of-options',";
  const unterminated = "'diff', '--name-only',";
  const withoutTerminator = mutant.replace(terminated, unterminated);
  assert.notEqual(withoutTerminator, mutant, 'the Git option termination mutation must be applied');
  mutant = withoutTerminator;

  const fixture = createCliGitFixture({ scriptSource: mutant });
  const scratch = mkdtempSync(join(tmpdir(), 'gaia-architecture-base-mutant-'));
  try {
    const outputPrefix = join(scratch, 'git-output-').replaceAll('\\', '/');
    runCli(fixture.root, ['--base', `--output=${outputPrefix}`]);
    assert.ok(readdirSync(scratch).some((name) => name.startsWith('git-output-')));
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
});
