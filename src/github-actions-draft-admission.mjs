const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_SHA = /^[a-f0-9]{40}$/u;
const POSITIVE_INTEGER = /^[1-9]\d*$/u;
const WORKFLOW_PATH = /^\.github\/workflows\/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$/u;

export class GitHubActionsDraftAdmissionError extends Error {
  constructor(code) {
    super('invalid GitHub Actions draft admission configuration');
    this.name = 'GitHubActionsDraftAdmissionError';
    this.code = code;
  }
}

function invalidConfiguration() {
  throw new GitHubActionsDraftAdmissionError('InvalidConfiguration');
}

function canonicalText(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value;
}

function configuredRepository(value) {
  if (!canonicalText(value) || !REPOSITORY.test(value)) invalidConfiguration();
  return value;
}

function configuredWorkKey(value) {
  if (typeof value !== 'string' || !SHA256.test(value)) invalidConfiguration();
  return value;
}

function configuredWorkflowPath(value) {
  if (!canonicalText(value) || !WORKFLOW_PATH.test(value)) invalidConfiguration();
  return value;
}

function configuredWorkflowSha(value) {
  if (typeof value !== 'string' || !GIT_SHA.test(value)) invalidConfiguration();
  return value;
}

function positiveInteger(value) {
  if (typeof value !== 'string' || !POSITIVE_INTEGER.test(value)) invalidConfiguration();
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) invalidConfiguration();
  return parsed;
}

function record(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function ownData(value, key) {
  if (!record(value)) return { ok: false };
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { ok: false };
  return { ok: true, value: descriptor.value };
}

function environmentData(value, key) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false };
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return { ok: false };
  return { ok: true, value: descriptor.value };
}

function exactDataKeys(value, expected) {
  if (!record(value)) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string') || keys.length !== expected.length) return false;
  const sorted = [...keys].sort();
  const wanted = [...expected].sort();
  return sorted.every((key, index) => key === wanted[index]
    && ownData(value, key).ok);
}

function sameEpoch(value, expected) {
  if (!exactDataKeys(value, ['runId', 'runAttempt'])) return false;
  return ownData(value, 'runId').value === expected.runId
    && ownData(value, 'runAttempt').value === expected.runAttempt;
}

function exactClaim(value, expectedWorkKey, expectedEpoch) {
  if (!exactDataKeys(
    value, ['workKey', 'operationId', 'executorEpoch', 'claimedRevision'],
  )) return false;
  const workKey = ownData(value, 'workKey').value;
  const operationId = ownData(value, 'operationId').value;
  const claimedRevision = ownData(value, 'claimedRevision').value;
  return workKey === expectedWorkKey
    && typeof operationId === 'string' && SHA256.test(operationId)
    && typeof claimedRevision === 'string' && SHA256.test(claimedRevision)
    && sameEpoch(ownData(value, 'executorEpoch').value, expectedEpoch);
}

function exactObservation(value, expectedRepository, expectedEpoch, expectedPath, expectedSha) {
  if (!record(value)) return false;
  const repository = ownData(value, 'repository');
  const id = ownData(value, 'id');
  const attempt = ownData(value, 'run_attempt');
  const status = ownData(value, 'status');
  const path = ownData(value, 'path');
  const headSha = ownData(value, 'head_sha');
  if (!repository.ok || !id.ok || !attempt.ok || !status.ok || !path.ok || !headSha.ok) {
    return false;
  }
  const fullName = ownData(repository.value, 'full_name');
  return fullName.ok && fullName.value === expectedRepository
    && id.value === expectedEpoch.runId
    && attempt.value === expectedEpoch.runAttempt
    && status.value === 'in_progress'
    && path.value === expectedPath
    && headSha.value === expectedSha;
}

/**
 * Bind the existing reserveEffect seam to one GitHub Actions run attempt.
 *
 * GitHub's workflow-run REST representation does not expose the concurrency group. The exact
 * group is therefore a structural invariant of the sealed workflow, while this adapter verifies
 * only the official run identity and status. It never fabricates observed group provenance.
 */
export function createGitHubActionsDraftAdmission({
  expectedRepository,
  expectedWorkKey,
  expectedWorkflowPath,
  environment = process.env,
  readWorkflowAdmission,
}) {
  const repository = configuredRepository(expectedRepository);
  const workKey = configuredWorkKey(expectedWorkKey);
  const workflowPath = configuredWorkflowPath(expectedWorkflowPath);
  const workflowSha = configuredWorkflowSha(
    environmentData(environment, 'GITHUB_WORKFLOW_SHA').value,
  );
  const workflowRef = environmentData(environment, 'GITHUB_WORKFLOW_REF').value;
  if (environmentData(environment, 'GITHUB_REPOSITORY').value !== repository
    || !canonicalText(workflowRef)
    || !workflowRef.startsWith(`${repository}/${workflowPath}@`)
    || typeof readWorkflowAdmission !== 'function') {
    invalidConfiguration();
  }
  const runId = positiveInteger(environmentData(environment, 'GITHUB_RUN_ID').value);
  const runAttempt = positiveInteger(
    environmentData(environment, 'GITHUB_RUN_ATTEMPT').value,
  );
  const executorEpoch = Object.freeze({ runId, runAttempt });

  return Object.freeze({
    executorEpoch,
    async reserveEffect(context) {
      if (!exactClaim(context, workKey, executorEpoch)) return 'ZERO';
      try {
        const observed = await readWorkflowAdmission(Object.freeze({
          repository,
          runId,
          runAttempt,
          workflowPath,
          workflowSha,
        }));
        return exactObservation(
          observed, repository, executorEpoch, workflowPath, workflowSha,
        ) ? 'AVAILABLE' : 'ZERO';
      } catch {
        return 'ZERO';
      }
    },
  });
}
