import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const INVENTORY_SCHEMA = 'gaia-architecture-inventory/1';
const ADAPTER_SCHEMA = 'gaia-architecture-inventory-adapter/1';
const REPORT_SCHEMA = 'gaia-architecture-drift-report/1';
const VERIFICATION_SCHEMA = 'gaia-architecture-verification/1';

const REQUIRED_SECTIONS = Object.freeze([
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
]);

const INVENTORY_FIELDS = Object.freeze([
  'architectureImpact', 'architectureRevisions', 'changedPaths', 'files', 'revision', 'schema',
]);
const IMPACT_FIELDS = Object.freeze(['evidence', 'kind']);
const ARCHITECTURE_REVISION_FIELDS = Object.freeze(['commit', 'contentRevision']);
const VERIFICATION_FIELDS = Object.freeze(['commit', 'contentRevision', 'date', 'schema']);
const IMPACT_KINDS = new Set(['UPDATED', 'NO_IMPACT', 'UNDECLARED']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const FORBIDDEN_INTERFACE_TOKENS = new Set([
  'config',
  'configuration',
  'duckdb',
  'error',
  'filesystem',
  'git',
  'github',
  'jsonl',
  'oid',
  'path',
  'payload',
  'provider',
  'ref',
  'retry',
  'sha',
  'sha1',
  'sha256',
  'storage',
  'transport',
]);
const FORBIDDEN_INTERFACE_TOKEN_PAIRS = new Set([
  'commit:digest',
  'commit:hash',
  'commit:id',
  'commit:identifier',
  'duck:db',
  'object:id',
  'object:identifier',
]);
const COMMIT = /^[0-9a-f]{40}$/;
const CONTENT_REVISION = /^sha256:[0-9a-f]{64}$/;

export class ArchitectureDriftRefusal extends Error {
  constructor(code) {
    super(code);
    this.name = 'ArchitectureDriftRefusal';
    this.code = code;
  }
}

function refuse(code) {
  throw new ArchitectureDriftRefusal(code);
}

function ownSortedKeys(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) refuse('INVENTORY_SHAPE_INVALID');
  return Object.keys(value).sort();
}

function assertFields(value, fields, code = 'INVENTORY_FIELD_SET_INVALID') {
  if (JSON.stringify(ownSortedKeys(value)) !== JSON.stringify([...fields].sort())) refuse(code);
}

function ordinal(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function contentRevision(content) {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function normalizePath(path) {
  if (typeof path !== 'string' || path.length === 0 || path.includes('\\') || path.startsWith('/')) {
    refuse('INVENTORY_PATH_INVALID');
  }
  const parts = path.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) refuse('INVENTORY_PATH_INVALID');
  return path;
}

function normalizeInventory(input) {
  assertFields(input, INVENTORY_FIELDS);
  if (input.schema !== INVENTORY_SCHEMA) refuse('INVENTORY_SCHEMA_UNSUPPORTED');
  if (typeof input.revision !== 'string' || !COMMIT.test(input.revision)) {
    refuse('INVENTORY_REVISION_INVALID');
  }
  if (!Array.isArray(input.architectureRevisions)) {
    refuse('INVENTORY_ARCHITECTURE_REVISIONS_INVALID');
  }
  const architectureRevisions = input.architectureRevisions.map((entry) => {
    try {
      assertFields(entry, ARCHITECTURE_REVISION_FIELDS, 'INVENTORY_ARCHITECTURE_REVISIONS_INVALID');
    } catch {
      refuse('INVENTORY_ARCHITECTURE_REVISIONS_INVALID');
    }
    if (typeof entry.commit !== 'string' || !COMMIT.test(entry.commit)
      || typeof entry.contentRevision !== 'string' || !CONTENT_REVISION.test(entry.contentRevision)) {
      refuse('INVENTORY_ARCHITECTURE_REVISIONS_INVALID');
    }
    return Object.freeze({ ...entry });
  }).sort((a, b) => ordinal(a.commit, b.commit));
  if (new Set(architectureRevisions.map((entry) => entry.commit)).size !== architectureRevisions.length) {
    refuse('INVENTORY_ARCHITECTURE_REVISIONS_INVALID');
  }
  if (!Array.isArray(input.changedPaths)) refuse('INVENTORY_CHANGES_INVALID');
  assertFields(input.architectureImpact, IMPACT_FIELDS, 'INVENTORY_IMPACT_INVALID');
  if (!IMPACT_KINDS.has(input.architectureImpact.kind)) refuse('INVENTORY_IMPACT_INVALID');
  if (input.architectureImpact.evidence !== null
    && (typeof input.architectureImpact.evidence !== 'string' || input.architectureImpact.evidence.trim().length === 0)) {
    refuse('INVENTORY_IMPACT_INVALID');
  }
  if (input.architectureImpact.kind === 'NO_IMPACT' && input.architectureImpact.evidence === null) {
    refuse('INVENTORY_IMPACT_INVALID');
  }

  const files = {};
  for (const path of ownSortedKeys(input.files)) {
    normalizePath(path);
    if (typeof input.files[path] !== 'string') refuse('INVENTORY_FILE_INVALID');
    files[path] = input.files[path];
  }
  const changedPaths = [...new Set(input.changedPaths.map(normalizePath))].sort(ordinal);
  return Object.freeze({
    schema: INVENTORY_SCHEMA,
    revision: input.revision,
    architectureRevisions: Object.freeze(architectureRevisions),
    files: Object.freeze(files),
    changedPaths: Object.freeze(changedPaths),
    architectureImpact: Object.freeze({ ...input.architectureImpact }),
  });
}

function adapter(read) {
  return Object.freeze({ schema: ADAPTER_SCHEMA, read });
}

export function createInMemoryArchitectureInventory(snapshot) {
  return adapter(() => snapshot);
}

function readTree(root) {
  const absoluteRoot = resolve(root);
  const files = {};
  function walk(directory) {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => ordinal(a.name, b.name));
    for (const entry of entries) {
      if (entry.isDirectory() && EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const absolute = resolve(directory, entry.name);
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) refuse('INVENTORY_ENTRY_UNSUPPORTED');
      if (stat.isDirectory()) walk(absolute);
      else {
        const path = relative(absoluteRoot, absolute).split(sep).join('/');
        files[path] = readFileSync(absolute, 'utf8');
      }
    }
  }
  walk(absoluteRoot);
  return files;
}

export function createFilesystemArchitectureInventory(options) {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) refuse('ADAPTER_OPTIONS_INVALID');
  const fields = ['architectureImpact', 'architectureRevisions', 'changedPaths', 'revision', 'root'];
  if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(fields.sort())) refuse('ADAPTER_OPTIONS_INVALID');
  return adapter(() => ({
    schema: INVENTORY_SCHEMA,
    revision: options.revision,
    architectureRevisions: options.architectureRevisions,
    files: readTree(options.root),
    changedPaths: options.changedPaths,
    architectureImpact: options.architectureImpact,
  }));
}

function violation(code, subject) {
  return Object.freeze({ code, subject });
}

function verificationRecord(files) {
  let packageJson;
  try {
    packageJson = JSON.parse(files['package.json']);
  } catch {
    refuse('VERIFICATION_RECORD_INVALID');
  }
  const record = packageJson?.gaiaArchitectureVerification;
  try {
    assertFields(record, VERIFICATION_FIELDS, 'VERIFICATION_RECORD_INVALID');
  } catch {
    refuse('VERIFICATION_RECORD_INVALID');
  }
  if (record.schema !== VERIFICATION_SCHEMA
    || typeof record.commit !== 'string' || !COMMIT.test(record.commit)
    || typeof record.contentRevision !== 'string' || !CONTENT_REVISION.test(record.contentRevision)
    || typeof record.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.date)) {
    refuse('VERIFICATION_RECORD_INVALID');
  }
  return Object.freeze({ ...record });
}

function internalLinkTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)) {
    let target = match[1].trim();
    if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1);
    target = target.split(/\s+['"]/)[0].split('#')[0];
    if (target === '' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) continue;
    try {
      targets.push(decodeURIComponent(target).replace(/^\.\//, ''));
    } catch {
      targets.push(target);
    }
  }
  return targets.sort(ordinal);
}

function interfaceRows(markdown) {
  const start = markdown.indexOf('## Module and seam map');
  if (start < 0) return [];
  const next = markdown.indexOf('\n## ', start + 3);
  const section = markdown.slice(start, next < 0 ? undefined : next);
  const rows = section.split(/\r?\n/).filter((line) => /^\|.*\|\s*$/.test(line));
  if (rows.length < 3) return [];
  return rows.slice(2).map((line) => line.split('|').slice(1, -1).map((cell) => cell.trim()));
}

function declaredInterfaceFragments(cell) {
  return [...cell.matchAll(/`([^`\r\n]+)`/g)].map((match) => match[1]);
}

function interfaceTokens(fragment) {
  return fragment
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter((token) => token.length > 0)
    .map((token) => token.toLowerCase());
}

function declaredInterfaceLeaks(fragment) {
  const tokens = interfaceTokens(fragment);
  if (tokens.some((token) => FORBIDDEN_INTERFACE_TOKENS.has(token))) return true;
  return tokens.some((token, index) => FORBIDDEN_INTERFACE_TOKEN_PAIRS.has(
    `${token}:${tokens[index + 1] ?? ''}`,
  ));
}

function architectureSensitive(path) {
  return path === 'package.json'
    || path === '.mcp.json'
    || path.startsWith('.codex-plugin/')
    || path.startsWith('.github/workflows/')
    || path.startsWith('src/')
    || path.startsWith('scripts/');
}

export function checkArchitectureDrift(inventoryAdapter) {
  if (inventoryAdapter === null || typeof inventoryAdapter !== 'object'
    || inventoryAdapter.schema !== ADAPTER_SCHEMA || typeof inventoryAdapter.read !== 'function'
    || JSON.stringify(Object.keys(inventoryAdapter).sort()) !== JSON.stringify(['read', 'schema'])) {
    refuse('ADAPTER_CONTRACT_INVALID');
  }
  let inventory;
  try {
    inventory = normalizeInventory(inventoryAdapter.read());
  } catch (error) {
    if (error instanceof ArchitectureDriftRefusal) throw error;
    refuse('ADAPTER_READ_FAILED');
  }
  const markdown = inventory.files['ARCHITECTURE.md'];
  if (typeof markdown !== 'string') refuse('ARCHITECTURE_DOCUMENT_MISSING');
  const verification = verificationRecord(inventory.files);
  const actualContentRevision = contentRevision(markdown);

  const violations = [];
  const advisories = [];
  for (const heading of REQUIRED_SECTIONS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^## ${escaped}$`, 'm').test(markdown)) {
      violations.push(violation('MISSING_REQUIRED_SECTION', heading));
    }
  }

  for (const target of internalLinkTargets(markdown)) {
    if (!(target in inventory.files)) violations.push(violation('BROKEN_INTERNAL_LINK', target));
  }

  if (actualContentRevision !== verification.contentRevision) {
    violations.push(violation('ARCHITECTURE_CONTENT_REVISION_MISMATCH', actualContentRevision));
  }
  const witnessContentRevision = inventory.architectureRevisions
    .find((entry) => entry.commit === verification.commit)?.contentRevision ?? null;
  if (witnessContentRevision !== verification.contentRevision) {
    violations.push(violation('STALE_VERIFIED_COMMIT', verification.commit));
  }

  for (const row of interfaceRows(markdown)) {
    if (row.length >= 2 && declaredInterfaceFragments(row[1]).some(declaredInterfaceLeaks)) {
      violations.push(violation('MODULE_INTERFACE_LEAK', row[0] || 'UNNAMED'));
    }
  }

  const sensitive = inventory.changedPaths.filter(architectureSensitive);
  const architectureUpdated = inventory.changedPaths.includes('ARCHITECTURE.md');
  const noImpact = inventory.architectureImpact.kind === 'NO_IMPACT'
    && inventory.architectureImpact.evidence !== null;
  if (sensitive.length > 0 && !architectureUpdated && !noImpact) {
    for (const path of sensitive) violations.push(violation('ARCHITECTURE_IMPACT_UNDECLARED', path));
  }

  const unique = new Map(violations.map((item) => [`${item.code}\0${item.subject}`, item]));
  const ordered = [...unique.values()].sort((a, b) => ordinal(a.code, b.code) || ordinal(a.subject, b.subject));
  const uniqueAdvisories = new Map(advisories.map((item) => [`${item.code}\0${item.subject}`, item]));
  const orderedAdvisories = [...uniqueAdvisories.values()]
    .sort((a, b) => ordinal(a.code, b.code) || ordinal(a.subject, b.subject));
  return Object.freeze({
    schema: REPORT_SCHEMA,
    verdict: ordered.length === 0 ? 'PASS' : 'FAIL',
    verifiedCommit: verification.commit,
    architectureContentRevision: actualContentRevision,
    advisories: Object.freeze(orderedAdvisories),
    violations: Object.freeze(ordered),
  });
}
