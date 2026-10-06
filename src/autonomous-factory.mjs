import { createHash } from 'node:crypto';
import { createPortfolioFactory } from './github-portfolio.mjs';
import { buildGitHubCandidatePublishIntent } from './github-portfolio-publish.mjs';
import { autonomousJobKey, autonomousPublicationOperationId, validateAutonomousReceipt } from './autonomous-factory-contract.mjs';

const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? `[${value.map(canonical).join(',')}]`
    : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  : JSON.stringify(value);
const digest = value => createHash('sha256').update(canonical(value)).digest('hex');
// `typeof` first: RegExp.test coerces its argument, so an absent code would read as the
// token "undefined" and a coercible non-string could smuggle a spoofed token, either way
// displacing the caller's named fallback diagnostic.
export const diagnosticCode = (error, fallback) =>
  typeof error?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.code) ? error.code : fallback;
const refuse = code => ({ schema: 'gaia-autonomous-factory-result/1', status: 'REFUSED', code });
const uncertain = jobKey => ({ schema: 'gaia-autonomous-factory-result/1', status: 'RECONCILIATION_REQUIRED', jobKey });

function terminal(job, factory) {
  const receipt = { schema: 'gaia-autonomous-factory-receipt/1',
    status: factory?.status === 'no-change' ? 'NO_CANDIDATE'
      : factory?.status === 'completed' ? 'CANDIDATE_READY' : 'CANDIDATE_REJECTED',
    jobKey: job.jobKey, intentRevision: job.intent.intentRevision,
    idempotencyKey: job.idempotencyKey, factory };
  return JSON.parse(validateAutonomousReceipt(receipt, job, { requireVerification: true }));
}

// Reconciliation reads the original operation, even when current readiness has changed.
// A missing/corrupt receipt never releases the occupied host slot or relaunches a worker.
export async function reconcileAutonomousJob({ store, execution, jobKey }) {
  const job = store.get(jobKey);
  if (!job) return refuse('UnknownJob');
  if (job.state === 'COMPLETED') return job.receipt;
  try {
    const factory = await execution.findReceipt({ intent: job.intent, idempotencyKey: job.idempotencyKey });
    if (!factory) return uncertain(jobKey);
    const receipt = terminal(job, factory);
    store.finish({ jobKey, receipt });
    return store.get(jobKey).receipt;
  } catch { return uncertain(jobKey); }
}

// A closed issue/Draft pair narrows an explicit operator action; it is NOT proof
// that the missing execution succeeded or that a provider is no longer running.
export async function retireClosedAutonomousJob({ store, jobKey, expectedIntentRevision, readDisposition, apply = false }) {
  const job = store.get(jobKey);
  if (!job) return refuse('UnknownJob');
  if (job.intent.intentRevision !== expectedIntentRevision) return refuse('IntentChanged');
  if (typeof apply !== 'boolean') return refuse('InvalidApply');
  if (job.state === 'COMPLETED') return job.receipt;
  try {
    const observation = await readDisposition(job.intent);
    const receipt = { schema: 'gaia-autonomous-retirement/1', status: 'ABANDONED',
      jobKey: job.jobKey, intentRevision: expectedIntentRevision,
      idempotencyKey: job.idempotencyKey, observation };
    const bound = JSON.parse(validateAutonomousReceipt(receipt, job));
    if (!apply) return { status: 'RETIREMENT_PREVIEW', receipt: bound };
    return store.retireClosed({ jobKey: job.jobKey, expectedIntentRevision, observation });
  } catch (error) { return refuse(diagnosticCode(error, 'DispositionUnavailable')); }
}

/** Separate standing-authority composition; the interactive operator is unchanged. */
export async function runAutonomousFactory({
  store, githubRead, draftAdmission, execution, repository, policyRevision,
}) {
  if (typeof draftAdmission?.target !== 'function' || typeof draftAdmission?.read !== 'function') {
    return refuse('DraftAdmissionRequired');
  }
  let jobKey;
  let started = false;
  try {
    const factory = createPortfolioFactory({ githubRead, draftAdmission, factoryExecution: execution,
      authority: { consume: async ({ grant, intent }) => {
        if (grant.grantId !== jobKey || intent.intentRevision !== preview.intent.intentRevision) {
          throw Object.assign(new Error('Fresh intent changed'), { code: 'IntentChanged' });
        }
        const authorization = store.start({ jobKey, intent,
          idempotencyKey: digest({ grantId: jobKey, intentRevision: intent.intentRevision }) });
        started = true;
        return authorization;
      } },
    });
    const portfolio = await factory.survey({ organization: repository.split('/')[0], policyRevision });
    const preview = await factory.advance({ portfolio });
    if (preview.status !== 'AWAITING_AUTHORITY') return preview;
    if (typeof preview.intent.repository !== 'string'
        || preview.intent.repository.toLowerCase() !== repository.toLowerCase()) {
      return refuse('RepositoryScopeMismatch');
    }
    jobKey = autonomousJobKey(preview.intent);
    const existing = store.get(jobKey);
    if (existing) return reconcileAutonomousJob({ store, execution, jobKey });
    const transition = await factory.advance({ portfolio, grant: { grantId: jobKey } });
    if (!started) return transition;
    if (!['CANDIDATE_READY', 'CANDIDATE_REJECTED', 'NO_CANDIDATE'].includes(transition.status)) return uncertain(jobKey);
    const receipt = terminal(store.get(jobKey), transition.execution.receipt);
    store.finish({ jobKey, receipt });
    return store.get(jobKey).receipt;
  } catch (error) {
    return started ? uncertain(jobKey) : refuse(diagnosticCode(error, 'AutonomousRunFailed'));
  }
}

const publicationResult = (jobKey, status, code) => ({ schema: 'gaia-autonomous-publication-result/1', status, jobKey, code });

// The stored terminal job, projected into the transition schema the publication intent consumes.
// Autonomous transitions are never persisted; the source named here is the repository decision
// snapshot that the intent and its authority bind, not the organization portfolio.
function candidateTransition(job) {
  const factory = job.receipt.factory;
  const body = { schema: 'gaia-github-portfolio-transition/1', status: 'CANDIDATE_READY',
    fromRevision: job.intent.snapshotRevision, intent: job.intent,
    authority: { grantId: job.jobKey, intentRevision: job.intent.intentRevision },
    execution: { idempotencyKey: job.idempotencyKey, receiptRevision: digest(factory), receipt: factory } };
  return { ...body, revision: digest(body) };
}

const closed = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
function draftObservation(value) {
  if (!closed(value, ['pullRequest', 'git'])
    || !closed(value.pullRequest, ['number', 'isDraft', 'state', 'headRef', 'headRepository'])
    || !closed(value.git, ['repository', 'headOid', 'baseOid', 'changeSetIdentity'])
    || typeof value.pullRequest.headRepository !== 'string') {
    throw Object.assign(new Error('PublicationObservationInvalid'), { code: 'PublicationObservationInvalid' });
  }
  return value;
}

/**
 * Publish one ready candidate to its own Draft's branch (#236): a deterministic commit whose one
 * parent is the admitted Draft head, then a leased fast-forward push of that head ref. Every
 * refusal precedes the first effect; the store's publication row is the authority point and the
 * operation identity under which a retry recognises an earlier push instead of repeating it.
 * `effects` is closed: observe, commit and push. Nothing here can mark ready, merge or close.
 */
export async function publishAutonomousCandidate({ store, jobKey, effects }) {
  const job = store.get(jobKey);
  const refused = code => publicationResult(job?.jobKey ?? jobKey, 'REFUSED', code);
  if (!job || job.state !== 'COMPLETED' || job.receipt?.status !== 'CANDIDATE_READY') return refused('CandidateNotReady');
  if (job.receipt.factory.verification?.passed !== true) return refused('CandidateUnverified');
  const pending = store.publication(job.jobKey);
  if (pending?.state === 'COMPLETED') return pending.receipt;
  // Once its operation is recorded, a publication that stops is unsettled, not refused.
  const uncertain = code => publicationResult(job.jobKey, 'RECONCILIATION_REQUIRED', code);
  const stop = pending ? uncertain : refused;
  const { draft, repository } = job.intent;
  let observed;
  try { observed = draftObservation(await effects.observe()); }
  catch (error) { return stop(diagnosticCode(error, 'PublicationObservationFailed')); }
  const { pullRequest, git } = observed;
  if (pullRequest.number !== draft.number || pullRequest.headRef !== draft.headRef
    || pullRequest.headRepository.toLowerCase() !== repository.toLowerCase()) return stop('DraftBranchMismatch');
  const openDraft = pullRequest.state === 'OPEN' && pullRequest.isDraft === true;
  let intent = pending?.intent;
  if (!intent) {
    if (!openDraft) return refused('DraftNotDraft');
    try { intent = buildGitHubCandidatePublishIntent({ transition: candidateTransition(job), gitObservation: git }); }
    catch (error) {
      const code = diagnosticCode(error, 'PublicationIntentInvalid');
      return refused(code === 'CandidateStale' && git.baseOid !== draft.headRevision ? 'DraftHeadMoved' : code);
    }
    try { store.beginPublication({ jobKey: job.jobKey, intent }); }
    catch (error) { return refused(diagnosticCode(error, 'PublicationRefused')); }
  }
  if (git.repository !== repository) return uncertain('RepositoryIdentityMismatch');
  if (git.headOid !== draft.headRevision) return uncertain('CandidateStale');
  if (git.changeSetIdentity !== intent.candidate.changeSetIdentity) return uncertain('CandidateChanged');
  const operationId = autonomousPublicationOperationId(job, intent.revision);
  let commitOid;
  try {
    ({ commitOid } = await effects.commit({ operationId, parentOid: draft.headRevision,
      changeSetIdentity: intent.candidate.changeSetIdentity,
      message: `chore: resolve issue #${job.intent.itemNumber}\n\nGaia-Publication-Operation: ${operationId}\n` }));
  } catch (error) { return uncertain(diagnosticCode(error, 'PublicationCommitFailed')); }
  if (typeof commitOid !== 'string' || !/^[a-f0-9]{40}$/u.test(commitOid)) return uncertain('PublicationCommitInvalid');
  // The same operation always yields the same commit, so a Draft head already equal to it is
  // this operation's earlier push whose acknowledgement was lost: record it, push nothing.
  if (git.baseOid !== commitOid) {
    if (git.baseOid !== draft.headRevision) return uncertain('DraftHeadMoved');
    if (pending) {
      if (!openDraft) return uncertain('DraftNotDraft');
      try { store.beginPublication({ jobKey: job.jobKey, intent }); }
      catch (error) { return uncertain(diagnosticCode(error, 'PublicationRefused')); }
    }
    try {
      const pushed = await effects.push({ headRef: draft.headRef, commitOid, expectedOid: draft.headRevision });
      if (pushed?.headOid !== commitOid) return uncertain('PublicationPushUncertain');
    } catch (error) { return uncertain(diagnosticCode(error, 'PublicationPushUncertain')); }
  }
  try {
    return store.finishPublication({ jobKey: job.jobKey, receipt: {
      schema: 'gaia-autonomous-publication-receipt/1', status: 'PUBLISHED', jobKey: job.jobKey,
      operationId, intentRevision: intent.revision, repository,
      draft: { number: draft.number, headRef: draft.headRef, previousHeadOid: draft.headRevision },
      commitOid, changeSetIdentity: intent.candidate.changeSetIdentity } });
  } catch (error) { return uncertain(diagnosticCode(error, 'PublicationRecordFailed')); }
}

/** Visit every completed ready job without a completed publication; one outcome per job. */
export async function publishReadyCandidates({ store, publication }) {
  const { jobs, publications } = store.status();
  const outcomes = [];
  for (const job of jobs) {
    if (job.state !== 'COMPLETED' || job.receipt?.status !== 'CANDIDATE_READY'
      || publications.some(item => item.jobKey === job.jobKey && item.state === 'COMPLETED')) continue;
    let effects;
    try { effects = publication(job); }
    catch (error) { outcomes.push(publicationResult(job.jobKey, 'REFUSED', diagnosticCode(error, 'PublicationUnavailable'))); continue; }
    outcomes.push(await publishAutonomousCandidate({ store, jobKey: job.jobKey, effects }));
  }
  return outcomes;
}
