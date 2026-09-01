import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const INVENTORY_SCHEMA = 'gaia-architecture-inventory/1';
const ADAPTER_SCHEMA = 'gaia-architecture-inventory-adapter/1';
const REPORT_SCHEMA = 'gaia-architecture-drift-report/1';

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
  'architectureImpact', 'changedPaths', 'files', 'knownRevisions', 'revision', 'schema',
]);
const IMPACT_FIELDS = Object.freeze(['evidence', 'kind']);
const IMPACT_KINDS = new Set(['UPDATED', 'NO_IMPACT', 'UNDECLARED']);
const EXCLUDED_DIRECTORIES = new Set(['.git', 'node_modules']);
const INTERFACE_LEAK = /github|duckdb|jsonl|config|storage|provider|payload|transport|retry|(?:^|[^a-z])path/i;

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
  if (typeof input.revision !== 'string' || !/^[0-9a-f]{40}$/.test(input.revision)) {
    refuse('INVENTORY_REVISION_INVALID');
  }
  if (!Array.isArray(input.knownRevisions)
    || input.knownRevisions.some((revision) => typeof revision !== 'string' || !/^[0-9a-f]{40}$/.test(revision))) {
    refuse('INVENTORY_REVISION_INVALID');
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
  const knownRevisions = [...new Set(input.knownRevisions)].sort(ordinal);
  return Object.freeze({
    schema: INVENTORY_SCHEMA,
    revision: input.revision,
    knownRevisions: Object.freeze(knownRevisions),
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
  const fields = ['architectureImpact', 'changedPaths', 'knownRevisions', 'revision', 'root'];
  if (JSON.stringify(Object.keys(options).sort()) !== JSON.stringify(fields.sort())) refuse('ADAPTER_OPTIONS_INVALID');
  return adapter(() => ({
    schema: INVENTORY_SCHEMA,
    revision: options.revision,
    knownRevisions: options.knownRevisions,
    files: readTree(options.root),
    changedPaths: options.changedPaths,
    architectureImpact: options.architectureImpact,
  }));
}

function violation(code, subject) {
  return Object.freeze({ code, subject });
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

  const violations = [];
  for (const heading of REQUIRED_SECTIONS) {
    const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`^## ${escaped}$`, 'm').test(markdown)) {
      violations.push(violation('MISSING_REQUIRED_SECTION', heading));
    }
  }

  for (const target of internalLinkTargets(markdown)) {
    if (!(target in inventory.files)) violations.push(violation('BROKEN_INTERNAL_LINK', target));
  }

  const verificationMatches = [...markdown.matchAll(/Last verified at commit `([0-9a-f]{40})` on \d{4}-\d{2}-\d{2}\./g)];
  const verifiedCommit = verificationMatches.length === 1 ? verificationMatches[0][1] : null;
  if (verifiedCommit === null || !inventory.knownRevisions.includes(verifiedCommit)) {
    violations.push(violation('STALE_VERIFIED_COMMIT', verifiedCommit ?? 'MISSING'));
  }

  for (const row of interfaceRows(markdown)) {
    if (row.length >= 2 && INTERFACE_LEAK.test(row[1])) {
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
  return Object.freeze({
    schema: REPORT_SCHEMA,
    verdict: ordered.length === 0 ? 'PASS' : 'FAIL',
    verifiedCommit,
    violations: Object.freeze(ordered),
  });
}
