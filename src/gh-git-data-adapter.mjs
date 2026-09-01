import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const GIT_OID = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const LEDGER_PREFIX = 'refs/heads/gaia-ledger/';
const REGISTRY_REF = `${LEDGER_PREFIX}registry-v0`;
const RECEIPT_PATH = 'receipt.json';

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

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key])}`,
  ).join(',')}}`;
}

const contentRevision = (body) => createHash('sha256')
  .update(canonical(body), 'utf8').digest('hex');

function ownData(value, code = 'GitDataProtocolViolation') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype) fail(code);
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
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error('GitHub Git Data request failed'));
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
  return ruleset.target === 'branch'
    && Array.isArray(includes)
    && includes.includes('refs/heads/gaia-ledger/**')
    && !exclusionMayMatchLedger(excludes)
    && types.has('deletion')
    && types.has('non_fast_forward')
    && types.has('update')
    && Array.isArray(actors)
    && actors.length === 1
    && actors[0]?.actor_id === pumpActor.actorId
    && actors[0]?.actor_type === pumpActor.actorType
    && actors[0]?.bypass_mode === 'always';
}

function receiptTransportMetadata(body, value, registryRecord, code = 'InvalidTransportMetadata') {
  if (body.kind !== 'CONFIRMED') {
    if (value !== undefined) fail(code);
    return undefined;
  }
  if (!registryRecord) fail(code);
  ownData(value, code);
  const keys = Object.keys(value);
  if (keys.length !== 1 || keys[0] !== 'workRootOid') fail(code);
  return { workRootOid: oid(value.workRootOid, code) };
}

export function createGhGitDataApi({ repository, pumpActor: pumpActorInput, run = runGh }) {
  ownData(repository, 'InvalidRepository');
  const canonicalRepository = Object.freeze({
    owner: segment(repository.owner), name: segment(repository.name),
  });
  const pumpActor = configuredPumpActor(pumpActorInput);
  if (typeof run !== 'function') fail('InvalidGitDataAdapter');
  const repo = repositoryPath(canonicalRepository);
  const call = async (method, path, input) => {
    const args = ['api', `repos/${repo}/${path}`, '--method', method];
    if (input !== undefined) args.push('--input', '-');
    try {
      return await run(args, input);
    } catch {
      fail('GitHubGitDataUnavailable');
    }
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
    const commit = ownData(await call('GET', `git/commits/${oid(commitOid)}`));
    if (commit.sha !== commitOid || !Array.isArray(commit.parents)
        || commit.parents.length > 1) fail('GitDataProtocolViolation');
    const treeOid = oid(commit.tree?.sha);
    const tree = ownData(await call('GET', `git/trees/${treeOid}`));
    if (tree.truncated !== false || !Array.isArray(tree.tree) || tree.tree.length !== 1
        || tree.tree[0]?.path !== RECEIPT_PATH || tree.tree[0]?.mode !== '100644'
        || tree.tree[0]?.type !== 'blob') {
      fail('GitDataProtocolViolation');
    }
    const blob = ownData(await call('GET', `git/blobs/${oid(tree.tree[0].sha)}`));
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
      const { record, parent } = await readRecord(cursor, ref);
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
        const current = await currentHead(ref);
        if (current !== expectedHeadOid) return { kind: 'STALE', currentHeadOid: current };
        throw error;
      }
      return {
        kind: 'APPENDED', oid: commitOid, body,
        committedRevision: contentRevision(body),
        ...(transportMetadata === undefined ? {} : { transportMetadata }),
      };
    },
  });
}
