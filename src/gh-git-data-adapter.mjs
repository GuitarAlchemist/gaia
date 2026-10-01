import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { ghFailure, isRateLimited } from './gh-failure.mjs';

const GIT_OID = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEDGER_PREFIX = 'refs/heads/gaia-ledger/';
const REGISTRY_REF = `${LEDGER_PREFIX}registry-v0`;
const RECEIPT_PATH = 'receipt.json';

// Up to this many ancestors of one ledger commit, each with its tree and receipt blob, arrive in
// one GraphQL query instead of three REST reads per record. GraphQL has its own hourly quota.
const HISTORY_PAGE = 100;
const LEDGER_HISTORY_QUERY = `query($owner: String!, $name: String!, $oid: GitObjectID!) {
  repository(owner: $owner, name: $name) {
    object(oid: $oid) {
      ... on Commit {
        history(first: ${HISTORY_PAGE}) {
          nodes {
            oid
            parents(first: 2) { totalCount nodes { oid } }
            tree {
              oid
              entries {
                name mode type oid
                object { __typename ... on Blob { oid isBinary isTruncated text } }
              }
            }
          }
        }
      }
    }
  }
}`;

export class GhGitDataError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'GhGitDataError';
    this.code = code;
  }
}

function fail(code) {
  throw new GhGitDataError(code);
}

function delay(milliseconds) {
  return new Promise((resolve) => { setTimeout(resolve, milliseconds); });
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

const contentRevision = (body) => createHash('sha256')
  .update(canonical(body), 'utf8').digest('hex');

function ownData(value, code = 'GitDataProtocolViolation', allowNullPrototype = false) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || (Object.getPrototypeOf(value) !== Object.prototype
        && !(allowNullPrototype && Object.getPrototypeOf(value) === null))) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some((key) => typeof key !== 'string'
      || !descriptors[key]?.enumerable || !Object.hasOwn(descriptors[key], 'value'))) fail(code);
  return value;
}

function segment(value, code = 'InvalidRepository') {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+$/u.test(value)) fail(code);
  return value;
}

function oid(value, code = 'GitDataProtocolViolation') {
  if (typeof value !== 'string' || !GIT_OID.test(value)) fail(code);
  return value;
}

const isOid = (value) => typeof value === 'string' && GIT_OID.test(value);

// Git's object id for a body of this type: what a translated tree or blob must hash back to.
const gitObjectId = (type, bytes) => createHash('sha1')
  .update(`${type} ${bytes.length}\0`, 'utf8').update(bytes).digest('hex');

// Git orders tree entries by name, comparing a directory as if its name ended in '/'.
const treeOrder = (entry) => Buffer.from(entry.mode === 0o40000 ? `${entry.name}/` : entry.name, 'utf8');

// An entry's type is not part of the tree's bytes, so it must follow from the mode, which is.
const typeOfMode = (mode) => (mode === 0o40000 ? 'tree' : mode === 0o160000 ? 'commit' : 'blob');

// The REST objects one GraphQL history node stands for, keyed by their REST path. A tree or blob
// is returned only when its translated bytes hash back to the object id Git stored, so nothing the
// transport altered is ever seeded: gh rewrites control characters in the JSON it prints, and a
// GraphQL tree listing carries no truncation flag. Whatever does not verify is left for a REST
// read. A commit cannot be rehashed without its raw header; its tree and parents are taken as
// given, exactly as the REST path takes them. Nothing here validates a receipt: readRecord does.
function historyObjects(node) {
  const parents = node?.parents;
  const tree = node?.tree;
  if (!isOid(node?.oid) || !Array.isArray(parents?.nodes)
      || parents.totalCount !== parents.nodes.length
      || !parents.nodes.every((parent) => isOid(parent?.oid))
      || !isOid(tree?.oid) || !Array.isArray(tree.entries)) return [];
  const objects = [[`git/commits/${node.oid}`, {
    sha: node.oid, tree: { sha: tree.oid }, parents: parents.nodes.map(({ oid: sha }) => ({ sha })),
  }]];
  for (const entry of tree.entries) {
    const sha = entry?.oid;
    const object = entry?.object;
    if (object?.__typename !== 'Blob' || object.oid !== sha || !isOid(sha)
        || object.isBinary !== false || object.isTruncated !== false
        || typeof object.text !== 'string') continue;
    const bytes = Buffer.from(object.text, 'utf8');
    if (gitObjectId('blob', bytes) !== sha) continue;
    objects.push([`git/blobs/${sha}`, { encoding: 'base64', content: bytes.toString('base64') }]);
  }
  if (!tree.entries.every((entry) => typeof entry?.name === 'string'
      && Number.isSafeInteger(entry.mode) && entry.mode >= 0
      && entry.type === typeOfMode(entry.mode) && isOid(entry.oid))) return objects;
  const entries = [...tree.entries].sort((a, b) => Buffer.compare(treeOrder(a), treeOrder(b)));
  const treeBytes = Buffer.concat(entries.flatMap((entry) => [
    Buffer.from(`${entry.mode.toString(8)} ${entry.name}\0`, 'utf8'), Buffer.from(entry.oid, 'hex'),
  ]));
  if (gitObjectId('tree', treeBytes) !== tree.oid) return objects;
  // A tree that hashes back is complete. REST gives each mode as a six-digit octal string.
  objects.push([`git/trees/${tree.oid}`, {
    truncated: false,
    tree: entries.map((entry) => ({
      path: entry.name, mode: entry.mode.toString(8).padStart(6, '0'), type: entry.type, sha: entry.oid,
    })),
  }]);
  return objects;
}

function ledgerRef(value) {
  if (typeof value !== 'string' || !value.startsWith(LEDGER_PREFIX)
      || !/^refs\/heads\/gaia-ledger\/[A-Za-z0-9._/-]+$/u.test(value)
      || value.includes('..') || value.endsWith('/') || value.includes('//')) {
    fail('InvalidLedgerRef');
  }
  return value;
}

function encodedRefPath(ref) {
  return ref.replace(/^refs\//u, '').split('/').map(encodeURIComponent).join('/');
}

function repositoryPath(repository) {
  return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

function cloneJson(value, code = 'InvalidLedgerBody') {
  try {
    const serialized = canonical(value);
    if (serialized === undefined) fail(code);
    const cloned = JSON.parse(serialized);
    ownData(cloned, code);
    return cloned;
  } catch (error) {
    if (error instanceof GhGitDataError) throw error;
    fail(code);
  }
}

async function runGh(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const stdout = [];
    // Only the head of stderr is kept, and only long enough to classify the failure.
    let stderr = '';
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(ghFailure(stderr));
        return;
      }
      try {
        const text = Buffer.concat(stdout).toString('utf8').trim();
        resolve(text.length === 0 ? null : JSON.parse(text));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
  });
}

function requireRulesets(value) {
  if (!Array.isArray(value)) fail('GitDataProtocolViolation');
  return value;
}

function configuredPumpActor(value) {
  ownData(value, 'InvalidPumpActor');
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'actorId' || keys[1] !== 'actorType'
      || !Number.isSafeInteger(value.actorId) || value.actorId <= 0
      || value.actorType !== 'Integration') fail('InvalidPumpActor');
  return Object.freeze({ actorId: value.actorId, actorType: value.actorType });
}

function exclusionMayMatchLedger(excludes) {
  if (!Array.isArray(excludes)) return true;
  const ledgerStem = `${LEDGER_PREFIX}`;
  return excludes.some((pattern) => {
    if (typeof pattern !== 'string' || pattern === '~ALL') return true;
    const wildcard = pattern.search(/[?*[{]/u);
    if (wildcard === -1) return pattern.startsWith(ledgerStem);
    const staticPrefix = pattern.slice(0, wildcard);
    return ledgerStem.startsWith(staticPrefix) || staticPrefix.startsWith(ledgerStem);
  });
}

function protectedLedgerRuleset(ruleset, pumpActor) {
  if (ruleset === null || typeof ruleset !== 'object' || ruleset.enforcement !== 'active') return false;
  const includes = ruleset.conditions?.ref_name?.include;
  const excludes = ruleset.conditions?.ref_name?.exclude;
  const types = Array.isArray(ruleset.rules)
    ? new Set(ruleset.rules.map((rule) => rule?.type)) : new Set();
  const actors = ruleset.bypass_actors;
  const exactConfiguredActor = Array.isArray(actors)
    && actors.length === 1
    && actors[0]?.actor_id === pumpActor.actorId
    && actors[0]?.actor_type === pumpActor.actorType
    && actors[0]?.bypass_mode === 'always';
  const currentAppBypassWhenRedacted = actors === undefined
    && ruleset.current_user_can_bypass === 'always';
  return ruleset.target === 'branch'
    && Array.isArray(includes)
    && includes.includes('refs/heads/gaia-ledger/**')
    && !exclusionMayMatchLedger(excludes)
    && types.has('deletion')
    && types.has('non_fast_forward')
    && types.has('update')
    && types.has('creation')
    && (exactConfiguredActor || currentAppBypassWhenRedacted);
}

function receiptTransportMetadata(body, value, registryRecord, code = 'InvalidTransportMetadata') {
  if (body.kind !== 'CONFIRMED') {
    if (value !== undefined) fail(code);
    return undefined;
  }
  if (!registryRecord) fail(code);
  ownData(value, code, true);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'workRootOid') fail(code);
  return { workRootOid: oid(value.workRootOid, code) };
}

export function createGhGitDataApi({
  repository, pumpActor: pumpActorInput, run = runGh, immutableObjectCacheLimit = 4096,
  immutableReadAttempts = 3, immutableReadBackoffMs = 1000, sleep = delay, historyPrefetch = false,
}) {
  ownData(repository, 'InvalidRepository');
  const canonicalRepository = Object.freeze({
    owner: segment(repository.owner), name: segment(repository.name),
  });
  const pumpActor = configuredPumpActor(pumpActorInput);
  if (typeof run !== 'function') fail('InvalidGitDataAdapter');
  if (!Number.isSafeInteger(immutableObjectCacheLimit) || immutableObjectCacheLimit <= 0) {
    fail('InvalidGitDataAdapter');
  }
  if (!Number.isSafeInteger(immutableReadAttempts) || immutableReadAttempts < 1
      || immutableReadAttempts > 5 || !Number.isSafeInteger(immutableReadBackoffMs)
      || immutableReadBackoffMs < 0 || typeof sleep !== 'function'
      || typeof historyPrefetch !== 'boolean') {
    fail('InvalidGitDataAdapter');
  }
  const repo = repositoryPath(canonicalRepository);
  // Git objects are immutable by OID. Refs, rulesets, and writes deliberately remain uncached.
  // Resident promises share concurrent reads. At capacity, eviction can cause a duplicate GET.
  // The bound must exceed one run's distinct ledger objects: every listing re-walks the registry
  // chain once per work key, and a bound below the working set (it was 256 for about 370 objects)
  // evicts the registry before its next walk and multiplies the GETs past the admission window.
  // Rejected or parser-invalid reads are evicted by readRef.
  const immutableObjectCache = new Map();
  const IMMUTABLE_OBJECT_CACHE_LIMIT = immutableObjectCacheLimit;
  const immutableObjectPath = /^git\/(?:commits|trees|blobs)\/[a-f0-9]{40}$/u;
  const call = async (method, path, input) => {
    const args = ['api', `repos/${repo}/${path}`, '--method', method];
    if (input !== undefined) args.push('--input', '-');
    try {
      return await run(args, input);
    } catch (error) {
      fail(isRateLimited(error) ? 'GitHubRateLimited' : 'GitHubGitDataUnavailable');
    }
  };

  // A GET by OID is content-addressed: repeating it cannot observe a different object, so a
  // transient transport failure is retried a bounded number of times rather than failing a whole
  // ledger listing. Ref reads, rulesets, and every write stay single-shot; a write is never
  // repeated blind. A rate limit is not retried: it lasts until the window resets, far beyond
  // any backoff here, and each retry spends the quota it is waiting for.
  const readImmutable = async (path) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await call('GET', path);
      } catch (error) {
        if (attempt >= immutableReadAttempts || error.code === 'GitHubRateLimited') throw error;
        await sleep(immutableReadBackoffMs * attempt);
      }
    }
  };

  const immutableObject = async (path) => {
    if (!immutableObjectPath.test(path)) fail('GitDataProtocolViolation');
    const existing = immutableObjectCache.get(path);
    if (existing !== undefined) return structuredClone(await existing);
    const pending = readImmutable(path).then((value) => structuredClone(value));
    if (immutableObjectCache.size >= IMMUTABLE_OBJECT_CACHE_LIMIT) {
      immutableObjectCache.delete(immutableObjectCache.keys().next().value);
    }
    immutableObjectCache.set(path, pending);
    try {
      return structuredClone(await pending);
    } catch (error) {
      if (immutableObjectCache.get(path) === pending) immutableObjectCache.delete(path);
      throw error;
    }
  };

  // A REST walk costs three reads per record, and every intake walks every ledger ref, so the
  // listing alone spent a tenth of the App's hourly REST quota. With the prefetch on, a walk that
  // reaches a commit it has not seen first asks GraphQL for that commit's ancestors and seeds the
  // object cache with them. Heads are still read over REST on every read, and every record still
  // passes readRecord. Once GraphQL fails, or answers without the commit asked for, REST does
  // every remaining read for this adapter instead of asking again at each step. Concurrent walks
  // that reach the same commit share one query, as they share one REST read.
  let prefetchAvailable = historyPrefetch;
  const prefetches = new Map();
  const seedImmutable = (path, value) => {
    if (immutableObjectCache.has(path)) return;
    if (immutableObjectCache.size >= IMMUTABLE_OBJECT_CACHE_LIMIT) {
      immutableObjectCache.delete(immutableObjectCache.keys().next().value);
    }
    immutableObjectCache.set(path, Promise.resolve(value));
  };
  const fetchHistory = async (commitOid) => {
    let response;
    try {
      response = await run(['api', 'graphql',
        '-f', `owner=${canonicalRepository.owner}`, '-f', `name=${canonicalRepository.name}`,
        '-f', `oid=${commitOid}`, '-f', `query=${LEDGER_HISTORY_QUERY}`]);
    } catch {
      prefetchAvailable = false;
      return;
    }
    const nodes = response?.data?.repository?.object?.history?.nodes;
    if (!Array.isArray(nodes)) {
      prefetchAvailable = false;
      return;
    }
    for (const node of nodes) {
      for (const [path, value] of historyObjects(node)) seedImmutable(path, value);
    }
    if (!immutableObjectCache.has(`git/commits/${commitOid}`)) prefetchAvailable = false;
  };
  const prefetchHistory = (commitOid) => {
    let pending = prefetches.get(commitOid);
    if (pending === undefined) {
      pending = fetchHistory(commitOid).finally(() => prefetches.delete(commitOid));
      prefetches.set(commitOid, pending);
    }
    return pending;
  };

  async function currentHead(ref) {
    const path = encodedRefPath(ledgerRef(ref));
    const rows = await call('GET', `git/matching-refs/${path}`);
    if (!Array.isArray(rows)) fail('GitDataProtocolViolation');
    const exact = rows.filter((row) => row?.ref === ref);
    if (exact.length === 0) return 'NONE';
    if (exact.length !== 1) fail('GitDataProtocolViolation');
    return oid(exact[0]?.object?.sha);
  }

  async function protectionAvailable() {
    const summaries = requireRulesets(await call('GET', 'rulesets?includes_parents=false'));
    const rulesets = [];
    for (const summary of summaries) {
      if (!Number.isSafeInteger(summary?.id) || summary.id <= 0) {
        fail('GitDataProtocolViolation');
      }
      rulesets.push(await call('GET', `rulesets/${summary.id}?includes_parents=false`));
    }
    return rulesets.some((ruleset) => protectedLedgerRuleset(ruleset, pumpActor));
  }

  async function requireProtection() {
    if (!await protectionAvailable()) fail('LedgerProtectionUnavailable');
  }

  async function readRecord(commitOid, ref) {
    const commit = ownData(await immutableObject(`git/commits/${oid(commitOid)}`));
    if (commit.sha !== commitOid || !Array.isArray(commit.parents)
        || commit.parents.length > 1) fail('GitDataProtocolViolation');
    const treeOid = oid(commit.tree?.sha);
    const tree = ownData(await immutableObject(`git/trees/${treeOid}`));
    if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length !== 1
        || tree.tree[0]?.path !== RECEIPT_PATH || tree.tree[0]?.mode !== '100644'
        || tree.tree[0]?.type !== 'blob') {
      fail('GitDataProtocolViolation');
    }
    const blob = ownData(await immutableObject(`git/blobs/${oid(tree.tree[0].sha)}`));
    if (blob.encoding !== 'base64' || typeof blob.content !== 'string') {
      fail('GitDataProtocolViolation');
    }
    let receipt;
    try {
      const bytes = Buffer.from(blob.content.replace(/\s/gu, ''), 'base64').toString('utf8');
      receipt = JSON.parse(bytes);
      ownData(receipt);
      const keys = Object.keys(receipt).sort();
      if ((keys.length !== 2 && keys.length !== 3)
          || keys[0] !== 'body' || keys[1] !== 'committedRevision'
          || (keys.length === 3 && keys[2] !== 'transportMetadata')) {
        fail('GitDataProtocolViolation');
      }
      ownData(receipt.body);
      const transportMetadata = receiptTransportMetadata(
        receipt.body, receipt.transportMetadata, ref === REGISTRY_REF, 'GitDataProtocolViolation',
      );
      if ((transportMetadata === undefined) !== (keys.length === 2)) {
        fail('GitDataProtocolViolation');
      }
      if (typeof receipt.committedRevision !== 'string'
        || !SHA256.test(receipt.committedRevision)
        || receipt.committedRevision !== contentRevision(receipt.body)) {
        fail('GitDataProtocolViolation');
      }
      if (bytes !== canonical(receipt)) fail('GitDataProtocolViolation');
    } catch (error) {
      if (error instanceof GhGitDataError) throw error;
      fail('GitDataProtocolViolation');
    }
    const parents = commit.parents.map((parent) => oid(parent?.sha));
    return {
      record: {
        oid: commitOid, body: receipt.body,
        committedRevision: receipt.committedRevision,
        ...(receipt.transportMetadata === undefined
          ? {} : { transportMetadata: receipt.transportMetadata }),
      },
      parent: parents[0] ?? 'NONE',
    };
  }

  async function appendObjects(expectedHeadOid, body, transportMetadata) {
    const wrapper = {
      body, committedRevision: contentRevision(body),
      ...(transportMetadata === undefined ? {} : { transportMetadata }),
    };
    const content = Buffer.from(canonical(wrapper), 'utf8').toString('base64');
    await requireProtection();
    const blob = ownData(await call('POST', 'git/blobs', { content, encoding: 'base64' }));
    await requireProtection();
    const tree = ownData(await call('POST', 'git/trees', {
      tree: [{ path: RECEIPT_PATH, mode: '100644', type: 'blob', sha: oid(blob.sha) }],
    }));
    await requireProtection();
    const commit = ownData(await call('POST', 'git/commits', {
      message: `gaia-ledger: ${body.kind ?? 'receipt'}`,
      tree: oid(tree.sha),
      parents: expectedHeadOid === 'NONE' ? [] : [oid(expectedHeadOid, 'InvalidExpectedHead')],
    }));
    return oid(commit.sha);
  }

  async function readRef(refInput) {
    const ref = ledgerRef(refInput);
    let cursor = await currentHead(ref);
    if (cursor === 'NONE') return { state: 'UNSEEN' };
    const records = [];
    const visited = new Set();
    while (cursor !== 'NONE') {
      if (visited.has(cursor)) fail('GitDataProtocolViolation');
      visited.add(cursor);
      if (prefetchAvailable && !immutableObjectCache.has(`git/commits/${cursor}`)) {
        await prefetchHistory(cursor);
      }
      let read;
      try {
        read = await readRecord(cursor, ref);
      } catch (error) {
        // A syntactically valid Git response can still fail receipt validation. Do not retain
        // that parser-invalid object forever; the next attempt must be able to retry it.
        immutableObjectCache.clear();
        throw error;
      }
      const { record, parent } = read;
      records.push(record);
      cursor = parent;
    }
    records.reverse();
    return { state: 'PRESENT', records };
  }

  return Object.freeze({
    async verifyProtection({ prefix, registryRootOid }) {
      if (prefix !== LEDGER_PREFIX) fail('InvalidProtectionRequest');
      oid(registryRootOid, 'InvalidProtectionRequest');
      return protectionAvailable();
    },

    async read(refInput) {
      return readRef(refInput);
    },

    async readByOperation(operationId) {
      if (typeof operationId !== 'string' || !SHA256.test(operationId)) {
        fail('InvalidOperationId');
      }
      const prefix = 'refs/heads/gaia-ledger/draft-operations-v0/';
      const path = encodedRefPath(prefix);
      const rows = await call('GET', `git/matching-refs/${path}`);
      if (!Array.isArray(rows)) fail('GitDataProtocolViolation');
      const matches = [];
      for (const row of rows) {
        if (typeof row?.ref !== 'string' || !row.ref.startsWith(prefix)) continue;
        const snapshot = await readRef(row.ref);
        if (snapshot.state === 'PRESENT'
          && snapshot.records.some((record) => record.body?.operationId === operationId)) {
          matches.push(snapshot);
        }
      }
      if (matches.length === 0) return { state: 'UNSEEN' };
      if (matches.length !== 1) fail('GitDataProtocolViolation');
      return matches[0];
    },

    async compareAndAppend(refInput, expectedHeadInput, bodyInput, transportMetadataInput) {
      const ref = ledgerRef(refInput);
      const expectedHeadOid = expectedHeadInput === 'NONE'
        ? 'NONE' : oid(expectedHeadInput, 'InvalidExpectedHead');
      const body = cloneJson(bodyInput);
      const transportMetadata = receiptTransportMetadata(
        body, transportMetadataInput, ref === REGISTRY_REF,
      );
      await requireProtection();
      const observed = await currentHead(ref);
      if (observed !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: observed };
      const commitOid = await appendObjects(expectedHeadOid, body, transportMetadata);
      try {
        await requireProtection();
        if (expectedHeadOid === 'NONE') {
          await call('POST', 'git/refs', { ref, sha: commitOid });
        } else {
          await call('PATCH', `git/refs/${encodedRefPath(ref)}`, { sha: commitOid, force: false });
        }
      } catch (error) {
        if (!(error instanceof GhGitDataError)) throw error;
        // The ref update can land and still lose its acknowledgement. Only the head being
        // this exact new commit proves that; then the append happened and is reported as
        // such. A foreign head is a real loss, and an unchanged head proves nothing, so
        // both keep their previous outcome. Nothing is rewritten or retried here.
        const current = await currentHead(ref);
        if (current !== commitOid) {
          if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
          throw error;
        }
      }
      return {
        kind: 'APPENDED', oid: commitOid, body,
        committedRevision: contentRevision(body),
        ...(transportMetadata === undefined ? {} : { transportMetadata }),
      };
    },
  });
}
