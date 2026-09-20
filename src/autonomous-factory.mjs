import { createHash } from 'node:crypto';
import { createPortfolioFactory } from './github-portfolio.mjs';
import { autonomousJobKey, validateAutonomousReceipt } from './autonomous-factory-contract.mjs';

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
    status: factory?.status === 'completed' ? 'CANDIDATE_READY' : 'CANDIDATE_REJECTED',
    jobKey: job.jobKey, intentRevision: job.intent.intentRevision,
    idempotencyKey: job.idempotencyKey, factory };
  return JSON.parse(validateAutonomousReceipt(receipt, job));
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
    if (!['CANDIDATE_READY', 'CANDIDATE_REJECTED'].includes(transition.status)) return uncertain(jobKey);
    const receipt = terminal(store.get(jobKey), transition.execution.receipt);
    store.finish({ jobKey, receipt });
    return store.get(jobKey).receipt;
  } catch (error) {
    return started ? uncertain(jobKey) : refuse(diagnosticCode(error, 'AutonomousRunFailed'));
  }
}
