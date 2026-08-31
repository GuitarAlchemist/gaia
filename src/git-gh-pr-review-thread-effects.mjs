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
const DISPUTE_MARKER = /(?:^|\n)gaia-dispute-evidence: (\{[^\n]+\})(?:\n|$)/gu;

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

const REVIEW_THREAD_COMMENTS_QUERY = `query GaiaReviewThreadComments($owner:String!,$name:String!,$number:Int!,$threadId:ID!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid}}
  node(id:$threadId){... on PullRequestReviewThread{
    id comments(first:100,after:$cursor){
      totalCount pageInfo{hasNextPage endCursor}
      nodes{id body review{id state submittedAt commit{oid}}}
    }
  }}
}`;

const REVIEW_THREAD_HEAD_QUERY = `query GaiaReviewThreadHead($owner:String!,$name:String!,$number:Int!){
  repository(owner:$owner,name:$name){pullRequest(number:$number){number headRefOid}}
}`;

const DISPUTE_WINDOW_QUERY = `query GaiaReviewThreadDisputes($owner:String!,$name:String!,$number:Int!,$cursor:String){
  repository(owner:$owner,name:$name){pullRequest(number:$number){
    comments(first:100,after:$cursor){
      totalCount pageInfo{hasNextPage endCursor} nodes{id body updatedAt}
    }
  }}
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

export class GitGhPrReviewThreadError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GitGhPrReviewThreadError';
    this.code = code;
  }
}

const typedFail = (code, message) => { throw new GitGhPrReviewThreadError(code, message); };

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
  const review = thread.originatingReview ?? thread.comments.nodes[0].review;
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

function disputeRevision({ repo, number, currentHeadOid, thread }) {
  return sha256({
    repository: repo, pullRequest: number, currentHeadOid,
    reviewThreadId: thread.id, isResolved: thread.isResolved, isOutdated: thread.isOutdated,
    comments: thread.comments.nodes.map(({ id, body, review }) => ({
      id, body, reviewId: review?.id, reviewState: review?.state,
      reviewedHeadOid: review?.commit?.oid,
    })),
  });
}

function parseDisputeWindow(comments, threads) {
  const known = new Map(threads.map((thread) => [thread.id, {
    sourceRevision: thread.sourceRevision, statuses: [], corrupt: false,
  }]));
  let globallyCorrupt = false;
  for (const comment of comments) {
    const body = typeof comment?.body === 'string' ? comment.body : '';
    const markerLines = body.split(/\r?\n/u)
      .filter((line) => line.startsWith('gaia-dispute-evidence: '));
    const matches = [...body.matchAll(DISPUTE_MARKER)];
    if (markerLines.length !== matches.length) globallyCorrupt = true;
    for (const match of matches) {
      let artifact;
      try { artifact = JSON.parse(match[1]); } catch { artifact = null; }
      const target = artifact && known.get(artifact.reviewThreadId);
      if (!artifact) { globallyCorrupt = true; continue; }
      if (!target) continue;
      const keys = artifact && typeof artifact === 'object' ? Object.keys(artifact).sort() : [];
      if (!artifact
          || JSON.stringify(keys) !== JSON.stringify([
            'reviewThreadId', 'schema', 'sourceRevision', 'status',
          ])
          || artifact.schema !== 'gaia-pr-review-thread-dispute-provider/1'
          || artifact.sourceRevision !== target.sourceRevision
          || !['NONE', 'OPEN'].includes(artifact.status)) {
        target.corrupt = true;
      } else {
        target.statuses.push(artifact.status);
      }
    }
  }
  return new Map([...known].map(([id, evidence]) => {
    if (globallyCorrupt) return [id, 'UNKNOWN'];
    const distinct = [...new Set(evidence.statuses)];
    if (evidence.corrupt || distinct.length > 1) return [id, 'UNKNOWN'];
    return [id, distinct[0] === 'OPEN']; // a complete window with no marker proves no open dispute
  }));
}

/** Create the only production GitHub port this feature uses. */
export function createGitGhPrReviewThreadEffects({
  run = defaultRun,
  readDisputeEvidence = null,
} = {}) {
  if (typeof run !== 'function') fail('run must be a function');
  if (readDisputeEvidence !== null && typeof readDisputeEvidence !== 'function') {
    fail('readDisputeEvidence must be a function or null');
  }
  const invoke = (args, options) => run(args, options);

  const collectReviewThreads = async ({
    repository: requested, pullRequest: number, observedAt, run: runBinding, signal,
  }) => {
    const repo = repository(requested);
    positiveInteger(number, 'pullRequest');
    instant(observedAt, 'observedAt');
    const boundedRun = requireRun(runBinding);
    const completeThreadComments = async (thread, initialPullRequest) => {
      const first = thread.comments;
      if (!first || !Array.isArray(first.nodes)
          || typeof first.pageInfo?.hasNextPage !== 'boolean'
          || !Number.isSafeInteger(first.totalCount) || first.totalCount < first.nodes.length) {
        typedFail('NestedPaginationInvalid', 'GitHub returned no closed nested comment page');
      }
      const originatingReview = first.nodes[0]?.review;
      const byId = new Map();
      const add = (row) => {
        const id = nodeId(row?.id, 'comment.id');
        const prior = byId.get(id);
        if (prior !== undefined && canonicalJson(prior) !== canonicalJson(row)) {
          typedFail('NestedPaginationConflict', 'duplicate comment id changed across nested pages');
        }
        byId.set(id, row);
      };
      first.nodes.forEach(add);
      let pageInfo = first.pageInfo;
      let cursor = pageInfo.endCursor;
      for (let page = 0; pageInfo.hasNextPage && page < 100; page += 1) {
        if (typeof cursor !== 'string' || cursor.length === 0) {
          typedFail('NestedPaginationCursorMissing', 'nested comment pagination cursor is absent');
        }
        let response;
        try {
          response = await invoke(graphqlArgs(REVIEW_THREAD_COMMENTS_QUERY, {
            owner, name, number, threadId: thread.id, cursor,
          }), { signal });
        } catch {
          typedFail('NestedPaginationFailed', 'GitHub nested comment pagination failed');
        }
        const node = response?.data?.node;
        const pagePullRequest = response?.data?.repository?.pullRequest;
        const comments = node?.comments;
        if (pagePullRequest?.number !== initialPullRequest.number
            || pagePullRequest?.headRefOid !== initialPullRequest.headRefOid
            || node?.id !== thread.id || !comments || !Array.isArray(comments.nodes)
            || comments.totalCount !== first.totalCount
            || typeof comments.pageInfo?.hasNextPage !== 'boolean') {
          typedFail('NestedPaginationIdentityMismatch', 'nested page changed thread or count identity');
        }
        comments.nodes.forEach(add);
        pageInfo = comments.pageInfo;
        cursor = pageInfo.endCursor;
      }
      if (pageInfo.hasNextPage || byId.size !== first.totalCount) {
        typedFail('NestedPaginationIncomplete', 'nested comment window did not reach its exact count');
      }
      return {
        ...thread,
        originatingReview,
        comments: {
          totalCount: first.totalCount,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [...byId.values()],
        },
      };
    };
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
        const completedNodes = [];
        for (const thread of nodes) {
          completedNodes.push(await completeThreadComments(thread, pullRequest));
        }
        nodes.splice(0, nodes.length, ...completedNodes);
        const disputeThreads = nodes.map((thread) => ({
          id: thread.id,
          sourceRevision: disputeRevision({
            repo, number, currentHeadOid: pullRequest.headRefOid, thread,
          }),
        }));
        const disputeComments = [];
        let disputeCursor = null;
        let disputeComplete = false;
        for (let disputePage = 0; disputePage < 100; disputePage += 1) {
          const disputeResponse = await invoke(graphqlArgs(DISPUTE_WINDOW_QUERY, {
            owner, name, number, cursor: disputeCursor,
          }), { signal });
          const comments = disputeResponse?.data?.repository?.pullRequest?.comments;
          if (!comments || !Array.isArray(comments.nodes)
              || typeof comments.pageInfo?.hasNextPage !== 'boolean') break;
          disputeComments.push(...comments.nodes);
          if (!comments.pageInfo.hasNextPage) {
            disputeComplete = comments.totalCount === disputeComments.length;
            break;
          }
          if (typeof comments.pageInfo.endCursor !== 'string'
              || comments.pageInfo.endCursor.length === 0) break;
          disputeCursor = comments.pageInfo.endCursor;
        }
        const providerDisputes = disputeComplete
          ? parseDisputeWindow(disputeComments, disputeThreads)
          : new Map(disputeThreads.map(({ id }) => [id, 'UNKNOWN']));
        const freshResponse = await invoke(graphqlArgs(REVIEW_THREAD_HEAD_QUERY, {
          owner, name, number,
        }), { signal });
        const freshPullRequest = freshResponse?.data?.repository?.pullRequest;
        if (freshPullRequest?.number !== pullRequest.number
            || freshPullRequest?.headRefOid !== pullRequest.headRefOid) {
          typedFail('CollectionHeadChanged', 'pull-request head changed during review-thread collection');
        }
        const observations = [];
        for (const thread of nodes) {
          const disputeSourceRevision = disputeRevision({
            repo, number, currentHeadOid: pullRequest.headRefOid, thread,
          });
          let disputed = providerDisputes.get(thread.id) ?? 'UNKNOWN';
          if (readDisputeEvidence !== null) {
            const external = await readDisputeEvidence({
              repository: repo, pullRequest: number, reviewThreadId: thread.id, observedAt,
              sourceRevision: disputeSourceRevision,
            });
            if ([true, false].includes(external)) disputed = external;
          }
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
      if (!laneReceipt || laneReceipt.status !== 'completed') return observation;
      const freshPullRequest = await invoke([
        'api', `repos/${repo}/pulls/${observation.pullRequest.number}`,
      ], { signal });
      const current = freshPullRequest?.head?.sha;
      const baseBranch = freshPullRequest?.base?.ref;
      if (typeof current !== 'string' || !/^[a-f0-9]{40}$/u.test(current)
          || typeof baseBranch !== 'string' || baseBranch.length === 0) {
        fail('GitHub did not return an exact fresh pull-request head and base branch');
      }
      const compare = await invoke([
        'api', `repos/${repo}/compare/${reviewed}...${current}`,
      ], { signal });
      const readAnchor = async (oid) => invoke([
        'api', `repos/${repo}/contents/${observation.reviewThread.path}`, '-f', `ref=${oid}`,
      ], { signal });
      const [atReview, atCurrent, checksResponse, protection, rulesets] = await Promise.all([
        readAnchor(reviewed), readAnchor(current),
        invoke(['api', `repos/${repo}/commits/${current}/check-runs`], { signal }),
        invoke(['api', `repos/${repo}/branches/${encodeURIComponent(baseBranch)}/protection`], { signal })
          .catch(() => null),
        invoke(['api', `repos/${repo}/rulesets?includes_parents=true`], { signal }).catch(() => null),
      ]);
      const digest = (content) => {
        if (content?.encoding !== 'base64' || typeof content.content !== 'string') return 'UNKNOWN';
        return createHash('sha256').update(Buffer.from(content.content.replaceAll('\n', ''), 'base64')).digest('hex');
      };
      const checkRuns = Array.isArray(checksResponse?.check_runs) ? checksResponse.check_runs : [];
      const protectedContexts = protection?.required_status_checks?.contexts;
      const rulesetDetails = Array.isArray(rulesets) ? await Promise.all(rulesets
        .filter(({ enforcement }) => enforcement === undefined || enforcement === 'active')
        .map(({ id, rules }) => Array.isArray(rules) ? { rules } : invoke([
          'api', `repos/${repo}/rulesets/${id}`,
        ], { signal }).catch(() => null))) : [];
      const rulesetContexts = rulesetDetails.flatMap((detail) => (detail?.rules ?? []))
        .filter(({ type }) => type === 'required_status_checks')
        .flatMap(({ parameters }) => parameters?.required_status_checks ?? [])
        .map(({ context }) => context).filter((context) => typeof context === 'string');
      const measuredContexts = [
        ...(Array.isArray(protectedContexts) ? protectedContexts : []), ...rulesetContexts,
      ];
      const contexts = [...new Set(requiredContexts.length > 0
        ? requiredContexts : measuredContexts)].sort();
      const confirmedPullRequest = await invoke([
        'api', `repos/${repo}/pulls/${observation.pullRequest.number}`,
      ], { signal });
      if (confirmedPullRequest?.head?.sha !== current) {
        fail('GitHub pull-request head moved during repair evidence measurement');
      }
      const conclusion = (value) => {
        if (value === null || value === undefined) return 'UNKNOWN';
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
