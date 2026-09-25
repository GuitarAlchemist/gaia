// Open the evidence head that the hosted Draft collector requires.
//
// The collector admits an issue only when exactly one branch tip carries
// `Gaia-Issue: N` and `Gaia-Ready-Receipt: <queueReceiptRevision>`. That
// revision is derived from the ready-label event itself, so the branch can only
// exist after a human labels the issue. Nothing produced it, so a ready issue
// with no hand-made branch refused as HeadIdentityAmbiguous with zero heads.
//
// This seeder closes that gap and nothing more. It never labels, approves,
// merges or opens a Draft: the label stays the human's authority, the seeded
// commit changes no file, and intake decides admission exactly as before.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  HostedDraftCollectorError,
  evidenceTrailerLines,
  findEvidenceHeads,
  observeReadyReceipt,
} from './hosted-draft-collector.mjs';

export const EVIDENCE_HEAD_SCHEMA = 'GaiaEvidenceHeadSeedV0';

const GIT_OID = /^[a-f0-9]{40}$/u;
const READ_METHODS = Object.freeze([
  'resolveRepository', 'readIssue', 'readPermission', 'listHeadRefs', 'readCommit',
]);
const WRITE_METHODS = Object.freeze(['readCommitTree', 'createCommit', 'createRef']);
const execFileAsync = promisify(execFile);

export class EvidenceHeadSeedError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'EvidenceHeadSeedError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new EvidenceHeadSeedError(code, message);
}

function requirePort(port, methods, code) {
  if (port === null || typeof port !== 'object'
      || methods.some((method) => typeof port[method] !== 'function')) fail(code);
  return port;
}

function oid(value, code) {
  if (typeof value !== 'string' || !GIT_OID.test(value)) fail(code);
  return value;
}

/** One branch per ready occurrence, so a relabel never collides with an earlier seed. */
export function evidenceBranchName(issueNumber, occurrence) {
  return `gaia/issue-${issueNumber}-ready-${occurrence}`;
}

export function evidenceCommitMessage(issueNumber, queueReceiptRevision) {
  return [
    `chore: open evidence head for issue #${issueNumber}`,
    '',
    'Seeded by scripts/evidence-head.mjs so the hosted Draft collector finds',
    'exactly one source for this ready receipt. It changes no file; the',
    'factory candidate lands on top of it.',
    '',
    ...evidenceTrailerLines(issueNumber, queueReceiptRevision),
  ].join('\n');
}

/**
 * Plan, or with `apply`, create the evidence head for one ready issue.
 *
 * Statuses: PLANNED (dry run), PRESENT (exactly one head already matches; nothing written),
 * CREATED (written and read back), REFUSED (a precondition fails; nothing written),
 * FAILED (the ref was not created; at most an unreferenced commit object exists), and
 * AMBIGUOUS (read-back disagrees with the write; never retried automatically).
 */
export async function seedEvidenceHead({ github, writer = null, selector, apply = false }) {
  requirePort(github, READ_METHODS, 'InvalidSeederPorts');
  if (apply) requirePort(writer, WRITE_METHODS, 'InvalidSeederPorts');

  let observed;
  try {
    observed = await observeReadyReceipt(github, selector);
  } catch (error) {
    if (error instanceof HostedDraftCollectorError && error.code !== 'GitHubObservationUnavailable') {
      return Object.freeze({ schema: EVIDENCE_HEAD_SCHEMA, status: 'REFUSED', reason: error.code });
    }
    throw error;
  }
  const { repository, issue, queueReceiptRevision } = observed;
  const number = observed.selector.workItem.number;
  const branch = evidenceBranchName(number, issue.occurrence);
  const summary = {
    schema: EVIDENCE_HEAD_SCHEMA,
    repository: `${repository.owner}/${repository.name}`,
    issue: number,
    occurrence: issue.occurrence,
    queueReceiptRevision,
    branch,
    baseRevision: repository.defaultBranchRevision,
  };
  const result = (fields) => Object.freeze({ ...summary, ...fields });

  const existing = await findEvidenceHeads(github, repository, number, queueReceiptRevision);
  if (existing.some((head) => head.name === repository.defaultBranch)) {
    return result({ status: 'REFUSED', reason: 'DefaultBranchSourceRejected' });
  }
  if (existing.length > 1) {
    return result({
      status: 'REFUSED', reason: 'HeadIdentityAmbiguous', heads: existing.map((head) => head.name),
    });
  }
  if (existing.length === 1) {
    return result({ status: 'PRESENT', branch: existing[0].name, headRevision: existing[0].revision });
  }
  const refs = await github.listHeadRefs({ repository });
  if (Array.isArray(refs) && refs.some((row) => row?.name === branch)) {
    return result({ status: 'REFUSED', reason: 'BranchNameTaken' });
  }

  const message = evidenceCommitMessage(number, queueReceiptRevision);
  if (!apply) return result({ status: 'PLANNED', message });

  const tree = oid(await writer.readCommitTree({
    repository, revision: repository.defaultBranchRevision,
  }), 'TreeObservationInvalid');
  const commit = oid(await writer.createCommit({
    repository, tree, parents: [repository.defaultBranchRevision], message,
  }), 'CommitCreationInvalid');
  let refError = null;
  try {
    await writer.createRef({ repository, name: branch, revision: commit });
  } catch (error) {
    refError = error;
  }

  // The read-back, not the write's response, decides the outcome. Once a write was attempted, an
  // unreadable GitHub is AMBIGUOUS, never fail-closed: the ref may exist, so "nothing was written"
  // would be false. Rerunning is safe; it reports PRESENT when the ref landed.
  let after;
  try {
    after = await findEvidenceHeads(github, repository, number, queueReceiptRevision);
  } catch {
    return result({ status: 'AMBIGUOUS', reason: 'ReadBackUnavailable', commitRevision: commit });
  }
  if (after.length === 1 && after[0].name === branch && after[0].revision === commit) {
    return result({ status: 'CREATED', headRevision: commit });
  }
  if (after.length === 0 && refError !== null) {
    return result({ status: 'FAILED', reason: 'RefNotCreated', commitRevision: commit });
  }
  return result({
    status: 'AMBIGUOUS', reason: 'ReadBackMismatch', commitRevision: commit,
    heads: after.map((head) => head.name),
  });
}

async function runGh(args) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
  });
  const output = stdout.trim();
  return output.length === 0 ? null : JSON.parse(output);
}

function repositoryPath(repository) {
  return `${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
}

/** The three Git Data writes, through `gh api`. Reads stay on the collector's own adapter. */
export function createGhEvidenceHeadWriter({ run = runGh } = {}) {
  if (typeof run !== 'function') fail('InvalidGhAdapter');
  return Object.freeze({
    async readCommitTree({ repository, revision }) {
      const raw = await run([
        'api', `repos/${repositoryPath(repository)}/git/commits/${oid(revision, 'InvalidRevision')}`,
      ]);
      return raw?.tree?.sha;
    },
    async createCommit({ repository, tree, parents, message }) {
      const raw = await run([
        'api', '-X', 'POST', `repos/${repositoryPath(repository)}/git/commits`,
        '-f', `message=${message}`, '-f', `tree=${oid(tree, 'InvalidRevision')}`,
        ...parents.flatMap((parent) => ['-f', `parents[]=${oid(parent, 'InvalidRevision')}`]),
      ]);
      return raw?.sha;
    },
    async createRef({ repository, name, revision }) {
      await run([
        'api', '-X', 'POST', `repos/${repositoryPath(repository)}/git/refs`,
        '-f', `ref=refs/heads/${name}`, '-f', `sha=${oid(revision, 'InvalidRevision')}`,
      ]);
    },
  });
}
