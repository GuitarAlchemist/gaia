/**
 * Production GitHub Adapter for the PR review-thread pump.
 *
 * All provider prose is consumed at this boundary. The collector emits the closed observation
 * accepted by `pr-review-thread.mjs`; the effect methods address one exact GitHub node id and have
 * no merge, approval, push, draft-promotion, repository-config, or pull-request-close operation.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

import { PR_REVIEW_THREAD_OBSERVATION_SCHEMA } from './pr-review-thread.mjs';

const execFileAsync = promisify(execFile);
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const NODE_ID = /^[A-Za-z0-9_-]{1,255}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REVIEW_STATES = new Set(['PENDING', 'COMMENTED', 'APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);
const REPAIR_MARKER = /(?:^|\n)gaia-repair-thread: ([a-f0-9]{64})(?:\n|$)/u;

export const PR_REVIEW_CHECKLIST_MARKER_PREFIX = 'gaia-claim-checklist: ';

const REVIEW_THREADS_QUERY = `query GaiaReviewThreads($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){
    pullRequest(number:$number){
      id number baseRefName headRefOid
      reviewThreads(first:100,after:$cursor){
        pageInfo{hasNextPage endCursor}
        nodes{id path line isResolved isOutdated comments(first:100){totalCount pageInfo{hasNextPage endCursor} nodes{
          id body review{id state submittedAt commit{oid}}
        }}}
      }
    }
  }
}`;

const RESOLVE_MUTATION = `mutation GaiaResolveReviewThread($threadId:ID!){
  resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}
}`;

const REPLY_MUTATION = `mutation GaiaReplyReviewThread($threadId:ID!,$body:String!){
  addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){
    comment{id url body}
  }
}`;

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(canonicalJson(value)).digest('hex');

function fail(message) {
  throw new TypeError(message);
}

function repository(value) {
  if (typeof value !== 'string' || !REPOSITORY.test(value)) fail('repository must be owner/name');
  return value;
}

function positiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value < 1) fail(`${field} must be a positive integer`);
  return value;
}

function nodeId(value, field) {
  if (typeof value !== 'string' || !NODE_ID.test(value)) fail(`${field} must be a GitHub node id`);
  return value;
}

function instant(value, field) {
  if (typeof value !== 'string' || !INSTANT.test(value) || new Date(value).toISOString() !== value) {
    fail(`${field} must be an exact instant`);
  }
  return value;
}

function splitRepository(value) {
  const canonical = repository(value);
  const [owner, name] = canonical.split('/');
  return { owner, name };
}

async function defaultRun(args, { signal } = {}) {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, signal, windowsHide: true,
  });
  const text = stdout.trim();
  return text.length === 0 ? null : JSON.parse(text);
}

function graphqlArgs(query, variables) {
  const args = ['api', 'graphql', '-f', `query=${query}`];
  for (const [name, value] of Object.entries(variables)) {
    if (value === null) continue;
    args.push(typeof value === 'number' ? '-F' : '-f', `${name}=${value}`);
  }
  return args;
}

function requireRun(value) {
  if (!value || typeof value !== 'object'
      || typeof value.runId !== 'string' || !/^[a-z0-9][a-z0-9-]{2,63}$/u.test(value.runId)
      || !Number.isSafeInteger(value.laneGeneration) || value.laneGeneration < 1) {
    fail('run must bind a canonical runId and positive laneGeneration');
  }
  return { runId: value.runId, laneGeneration: value.laneGeneration };
}

function normalizeThread({ repository: repo, pullRequest, thread, disputed, observedAt, run }) {
  if (!thread || !Array.isArray(thread.comments?.nodes) || thread.comments.nodes.length === 0) {
    fail('GitHub review thread omitted its comments');
  }
  const comments = thread.comments.nodes.map((comment) => ({
    id: nodeId(comment.id, 'comment.id'),
    body: typeof comment.body === 'string' ? comment.body : fail('comment.body must be text'),
  }));
  const review = thread.comments.nodes[0].review;
  if (!review || !REVIEW_STATES.has(review.state)) fail('GitHub review state is unsupported');
  const reviewedHeadOid = review.commit?.oid;
  if (typeof reviewedHeadOid !== 'string' || !/^[a-f0-9]{40}$/u.test(reviewedHeadOid)) {
    fail('GitHub review omitted its reviewed commit');
  }
  const currentHeadOid = pullRequest.headRefOid;
  if (typeof currentHeadOid !== 'string' || !/^[a-f0-9]{40}$/u.test(currentHeadOid)) {
    fail('GitHub pull request omitted its head commit');
  }
  const facts = {
    repository: repo,
    pullRequest: pullRequest.number,
    currentHeadOid,
    review: { id: review.id, state: review.state, submittedAt: review.submittedAt, reviewedHeadOid },
    reviewThread: {
      id: thread.id, path: thread.path, line: thread.line, isResolved: thread.isResolved,
      isOutdated: thread.isOutdated, disputed, comments,
    },
  };
  return {
    schema: PR_REVIEW_THREAD_OBSERVATION_SCHEMA,
    observedAt,
    repository: repo,
    pullRequest: { number: positiveInteger(pullRequest.number, 'pullRequest.number'), baseBranch: pullRequest.baseRefName },
    review: {
      id: nodeId(review.id, 'review.id'), state: review.state,
      submittedAt: instant(review.submittedAt, 'review.submittedAt'), reviewedHeadOid,
    },
    reviewThread: {
      id: nodeId(thread.id, 'reviewThread.id'), path: thread.path,
      line: positiveInteger(thread.line, 'reviewThread.line'),
      isResolved: thread.isResolved === true, isOutdated: thread.isOutdated === true,
      disputed, comments,
    },
    currentHeadOid,
    applicability: { anchorDigestAtReview: 'UNKNOWN', anchorDigestAtCurrentHead: 'UNKNOWN' },
    repair: null,
    checks: null,
    run,
    sourceRevision: sha256(facts),
  };
}

function responsePullRequest(response) {
  const pullRequest = response?.data?.repository?.pullRequest;
  if (!pullRequest || !Array.isArray(pullRequest.reviewThreads?.nodes)
      || typeof pullRequest.reviewThreads?.pageInfo?.hasNextPage !== 'boolean') {
    fail('GitHub returned no closed review-thread page');
  }
  return pullRequest;
}

function markerOf(body) {
  return REPAIR_MARKER.exec(String(body ?? ''))?.[1] ?? null;
}

/** Create the only production GitHub port this feature uses. */
export function createGitGhPrReviewThreadEffects({
  run = defaultRun,
  readDisputeEvidence = async () => 'UNKNOWN',
} = {}) {
  if (typeof run !== 'function') fail('run must be a function');
  if (typeof readDisputeEvidence !== 'function') fail('readDisputeEvidence must be a function');
  const invoke = (args, options) => run(args, options);

  const collectReviewThreads = async ({
    repository: requested, pullRequest: number, observedAt, run: runBinding, signal,
  }) => {
    const repo = repository(requested);
    positiveInteger(number, 'pullRequest');
    instant(observedAt, 'observedAt');
    const boundedRun = requireRun(runBinding);
    const { owner, name } = splitRepository(repo);
    const nodes = [];
    let cursor = null;
    let pullRequest = null;
    for (let page = 0; page < 100; page += 1) {
      const response = await invoke(graphqlArgs(REVIEW_THREADS_QUERY, {
        owner, name, number, cursor,
      }), { signal });
      const current = responsePullRequest(response);
      pullRequest ??= current;
      if (current.number !== pullRequest.number || current.headRefOid !== pullRequest.headRefOid) {
        fail('GitHub changed pull-request identity during pagination');
      }
      nodes.push(...current.reviewThreads.nodes);
      const { hasNextPage, endCursor } = current.reviewThreads.pageInfo;
      if (!hasNextPage) {
        const commentsComplete = nodes.every((thread) => (
          thread.comments?.pageInfo?.hasNextPage === false
          && thread.comments?.totalCount === thread.comments?.nodes?.length
        ));
        if (!commentsComplete) {
          return Object.freeze({
            schema: 'gaia-pr-review-thread-collection/1', repository: repo,
            pullRequest: number, observedAt, complete: false,
            sourceRevision: sha256(nodes.map(({ id, comments }) => ({
              id, totalCount: comments?.totalCount ?? 'UNKNOWN',
              visibleCount: comments?.nodes?.length ?? 0,
            }))),
            observations: Object.freeze([]),
          });
        }
        const observations = [];
        for (const thread of nodes) {
          const disputeSourceRevision = sha256({
            repository: repo, pullRequest: number, currentHeadOid: pullRequest.headRefOid,
            reviewThreadId: thread.id, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
            comments: thread.comments.nodes.map(({ id, body, review }) => ({
              id, body, reviewId: review?.id, reviewState: review?.state,
              reviewedHeadOid: review?.commit?.oid,
            })),
          });
          const disputed = await readDisputeEvidence({
            repository: repo, pullRequest: number, reviewThreadId: thread.id, observedAt,
            sourceRevision: disputeSourceRevision,
          });
          if (![true, false, 'UNKNOWN'].includes(disputed)) fail('dispute evidence is not closed');
          observations.push(normalizeThread({
            repository: repo, pullRequest, thread, disputed, observedAt, run: boundedRun,
          }));
        }
        return Object.freeze({
          schema: 'gaia-pr-review-thread-collection/1', repository: repo,
          pullRequest: number, observedAt, complete: true,
          sourceRevision: sha256(observations.map(({ sourceRevision }) => sourceRevision)),
          observations: Object.freeze(observations),
        });
      }
      if (typeof endCursor !== 'string' || endCursor.length === 0) fail('GitHub pagination cursor is absent');
      cursor = endCursor;
    }
    return Object.freeze({
      schema: 'gaia-pr-review-thread-collection/1', repository: repo,
      pullRequest: number, observedAt, complete: false,
      sourceRevision: sha256(nodes.map(({ id }) => id)), observations: Object.freeze([]),
    });
  };

  return Object.freeze({
    collectReviewThreads,

    async readRepairEvidence({ observation, laneReceipt, requiredContexts = [], signal }) {
      const repo = repository(observation.repository);
      const reviewed = observation.review.reviewedHeadOid;
      const current = observation.currentHeadOid;
      if (!laneReceipt || laneReceipt.status !== 'completed') return observation;
      const compare = await invoke([
        'api', `repos/${repo}/compare/${reviewed}...${current}`,
      ], { signal });
      const readAnchor = async (oid) => invoke([
        'api', `repos/${repo}/contents/${observation.reviewThread.path}`, '-f', `ref=${oid}`,
      ], { signal });
      const [atReview, atCurrent, checksResponse] = await Promise.all([
        readAnchor(reviewed), readAnchor(current),
        invoke(['api', `repos/${repo}/commits/${current}/check-runs`], { signal }),
      ]);
      const digest = (content) => {
        if (content?.encoding !== 'base64' || typeof content.content !== 'string') return 'UNKNOWN';
        return createHash('sha256').update(Buffer.from(content.content.replaceAll('\n', ''), 'base64')).digest('hex');
      };
      const checkRuns = Array.isArray(checksResponse?.check_runs) ? checksResponse.check_runs : [];
      const contexts = requiredContexts.length > 0
        ? [...requiredContexts] : checkRuns.map(({ name }) => name).filter((name) => typeof name === 'string');
      const conclusion = (value) => {
        const token = String(value ?? 'UNKNOWN').toUpperCase();
        if (['SUCCESS', 'FAILURE', 'CANCELLED', 'TIMED_OUT', 'SKIPPED', 'NEUTRAL'].includes(token)) return token;
        return token === 'IN_PROGRESS' || token === 'QUEUED' || token === 'PENDING'
          ? 'UNKNOWN' : 'FAILURE';
      };
      return {
        ...observation,
        applicability: {
          anchorDigestAtReview: digest(atReview),
          anchorDigestAtCurrentHead: digest(atCurrent),
        },
        repair: {
          headOid: current,
          descendsFromReviewedHead: ['ahead', 'identical'].includes(compare?.status),
          touchesAnchorPath: Array.isArray(compare?.files)
            && compare.files.some(({ filename }) => filename === observation.reviewThread.path),
          commitsAheadOfReviewedHead: Number.isSafeInteger(compare?.ahead_by) ? compare.ahead_by : 0,
          addressedCommentIds: laneReceipt.addressedCommentIds ?? [],
        },
        checks: contexts.length === 0 ? null : {
          headOid: current,
          requiredContexts: contexts,
          conclusions: contexts.map((context) => ({
            context,
            conclusion: conclusion(checkRuns.find(({ name }) => name === context)?.conclusion
              ?? checkRuns.find(({ name }) => name === context)?.status),
          })),
        },
      };
    },

    async readReviewThread({ repository: repo, pullRequest, reviewThreadId }) {
      const collection = await collectReviewThreads({
        repository: repo, pullRequest, reviewThreadId,
        observedAt: new Date().toISOString(), run: { runId: `reconcile-${pullRequest}`, laneGeneration: 1 },
      });
      const found = collection.observations.find(({ reviewThread }) => reviewThread.id === reviewThreadId);
      if (!found) fail('GitHub no longer reports the exact review thread');
      return {
        isResolved: found.reviewThread.isResolved,
        comments: found.reviewThread.comments.map((comment) => ({
          id: comment.id,
          url: `https://github.com/${repo}/pull/${pullRequest}#discussion_${comment.id}`,
          marker: markerOf(comment.body),
        })),
      };
    },

    async postReviewThreadComment({ reviewThreadId, threadIdentity, body }) {
      nodeId(reviewThreadId, 'reviewThreadId');
      if (!SHA256.test(threadIdentity) || !String(body).includes(threadIdentity)) {
        fail('review reply must bind the exact thread identity');
      }
      const response = await invoke(graphqlArgs(REPLY_MUTATION, { threadId: reviewThreadId, body }));
      const comment = response?.data?.addPullRequestReviewThreadReply?.comment;
      if (!comment || markerOf(comment.body) !== threadIdentity) fail('GitHub reply did not bind the claim');
      return { id: comment.id, url: comment.url, marker: threadIdentity };
    },

    async resolveReviewThread({ reviewThreadId, threadIdentity, idempotencyKey }) {
      nodeId(reviewThreadId, 'reviewThreadId');
      if (!SHA256.test(threadIdentity) || !SHA256.test(idempotencyKey)) fail('resolution identity is invalid');
      const response = await invoke(graphqlArgs(RESOLVE_MUTATION, { threadId: reviewThreadId }));
      const thread = response?.data?.resolveReviewThread?.thread;
      if (thread?.id !== reviewThreadId || thread?.isResolved !== true) fail('GitHub resolved another or no thread');
      return { isResolved: true };
    },

    async findChecklist({ repository: repo, pullRequest, marker }) {
      repository(repo); positiveInteger(pullRequest, 'pullRequest');
      const rows = await invoke(['api', `repos/${repo}/issues/${pullRequest}/comments`, '--paginate']);
      if (!Array.isArray(rows)) fail('GitHub issue comments response is not an array');
      const matches = rows.filter(({ body }) => String(body ?? '').includes(marker));
      if (matches.length > 1) fail('more than one checklist carries this claim marker');
      return matches.length === 0 ? null : {
        id: matches[0].id, url: matches[0].html_url, body: matches[0].body,
      };
    },

    async createChecklist({ repository: repo, pullRequest, marker, body }) {
      repository(repo); positiveInteger(pullRequest, 'pullRequest');
      if (!String(body).includes(marker)) fail('checklist body must carry its marker');
      const row = await invoke([
        'api', `repos/${repo}/issues/${pullRequest}/comments`, '--method', 'POST', '-f', `body=${body}`,
      ]);
      return { id: row.id, url: row.html_url };
    },

    async updateChecklist({ repository: repo, commentId, marker, body }) {
      repository(repo);
      if ((!Number.isSafeInteger(commentId) && typeof commentId !== 'string')
          || !String(body).includes(marker)) fail('checklist update identity is invalid');
      const row = await invoke([
        'api', `repos/${repo}/issues/comments/${commentId}`, '--method', 'PATCH', '-f', `body=${body}`,
      ]);
      return { id: row.id, url: row.html_url };
    },
  });
}
