/**
 * drain-petri-net-facts.mjs — the collector that turns durable evidence into receptivity facts.
 *
 * Two channels, both read as bytes and never as prose:
 *   - the bus log records (`actor.registered`, `actor.heartbeat`, `message.sent`), whose closed
 *     `key=value` texts the launcher and the coordinator write (W5/W7 lifecycle sends, and the
 *     `pr-observation` message kind that records what the provider adapter observed);
 *   - the fleet artifacts, of which only the title line, the `Subject:` header block, the
 *     `**Verdict:**` line, the `Family:` line and the last non-empty line are read.
 *
 * A verdict binds to a head only when the artifact's Subject header states `detached at <sha>`
 * for the current head (B1 of PR #97: containment binds nothing). A fact the channels cannot
 * establish is `UNKNOWN`, never `false` and never a guess. Nothing here touches a filesystem, a
 * clock, a provider, or the bus; the runner reads the files and hands their bytes in.
 *
 * A `pr-observation` message is closed-grammar text, but text alone is not authority (the bus
 * itself stores every body as `untrusted-text`): only a message sent by the exact actor ref named
 * by the caller as `observationSource` is folded. An actor's self-declared kind is descriptive and
 * grants nothing. A `reconciliation=CLASSIFIED` claim binds only when it names a changed head,
 * checks read `ALL_PASS`, and both review axes approve artifacts bound to that exact head. A bare
 * assertion is refused, never fired. Once both axes approve at a head, that head is
 * remembered as the pull request's `approvedHead`; `mergeable`, `draft` and `state` observations
 * name the merge-adjacent facts (`D_MERGEABLE_CLEAN`, `D_NOT_DRAFT`, `D_MERGE_CONFIRMED`) only
 * when they are reported at that same head, so a head that moves after approval without a fresh
 * dual approval and a completed reconciliation transition cannot ride an old approval to a merge.
 * `checks` is likewise not decoration: readiness and merge confirmation hold only when it reads
 * `ALL_PASS`, and are `UNKNOWN` — never guessed true — while it is unreported.
 */

import { createHash } from 'node:crypto';

import { DRAIN_NET_TEMPLATE, LANE_NET_TEMPLATE, canonicalJson, revisionOf } from './drain-petri-net.mjs';

export const DRAIN_FACTS_SCHEMA = 'gaia-drain-petri-net-facts/1';
export const PR_OBSERVATION_KIND = 'pr-observation';
export const LANE_MESSAGE_KINDS = Object.freeze(['lane-complete', 'lane-exhausted', 'lane-aborted']);

const GIT_OID = /^[0-9a-f]{40}$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;
const MARKER = /^[A-Z0-9_]+_COMPLETE$/u;
const TITLE = /^#\s+PR\s+#(\d+)\b(.*)$/u;
const VERDICT_LINE = /^\*\*Verdict:\s*(APPROVE|REQUEST_CHANGES)\*\*$/u;
const DETACHED_AT = /detached at\s*`?([0-9a-f]{40})`?/u;
const FAMILY_LINE = /^Family:\s*`?([A-Za-z0-9_.-]+)`?\s*$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;

/** The closed `pr-observation` grammar: every value is a token the coordinator copied from a field. */
export const PR_OBSERVATION_GRAMMAR = Object.freeze({
  pr: /^[1-9]\d{0,6}$/u,
  head: GIT_OID,
  mergeable: /^(?:MERGEABLE|CONFLICTING|UNKNOWN)$/u,
  draft: /^(?:true|false)$/u,
  state: /^(?:OPEN|MERGED|CLOSED)$/u,
  mergeCommit: GIT_OID,
  checks: /^(?:ALL_PASS|PENDING|FAILING)$/u,
  reconciliation: /^(?:CLASSIFIED|UNCLASSIFIED)$/u,
  issue: /^(?:none|[1-9]\d{0,6})$/u,
  issueState: /^(?:OPEN|CLOSED)$/u,
});
const OBSERVATION_REQUIRED = Object.freeze(['pr', 'head']);

export class DrainFactsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrainFactsError';
    this.code = code;
  }
}

const fail = (code, message) => { throw new DrainFactsError(code, message); };

const sha256Of = (bytes) => createHash('sha256').update(bytes).digest('hex');

const basenameOf = (path) => {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
};

/** `key=value(;key=value)*` into a map; a repeated key or a malformed pair is a refusal. */
export function parseClosedTokens(text) {
  if (typeof text !== 'string' || text.length === 0) return { error: 'TEXT_EMPTY' };
  const map = {};
  for (const pair of text.split(';')) {
    const index = pair.indexOf('=');
    if (index <= 0) return { error: 'PAIR_MALFORMED', pair };
    const key = pair.slice(0, index);
    if (Object.hasOwn(map, key)) return { error: 'KEY_REPEATED', key };
    map[key] = pair.slice(index + 1);
  }
  return { tokens: map };
}

// ---------------------------------------------------------------------------
// artifacts
// ---------------------------------------------------------------------------

/**
 * Read the binding fields of one artifact. Only fixed lines are read: the `# PR #N` title, the
 * `Subject:` header block (the Subject line and the lines it opens, up to the first blank line),
 * exactly one `**Verdict: ...**` line, an optional `Family:` line in that header, and the last
 * non-empty line as the marker. Everything else in the artifact is prose and binds nothing.
 */
export function parseArtifact({ name, bytes }) {
  if (typeof name !== 'string' || name.length === 0) fail('ArtifactNameInvalid', 'an artifact needs a name');
  if (!(bytes instanceof Uint8Array)) fail('ArtifactBytesInvalid', `${name}: bytes must be a byte array`);
  const text = Buffer.from(bytes).toString('utf8');
  const lines = text.split(/\r?\n/u);
  const nonEmpty = lines.filter((line) => line.trim().length > 0);
  const lastNonEmptyLine = nonEmpty.length > 0 ? nonEmpty.at(-1).trim() : null;
  const marker = lastNonEmptyLine !== null && MARKER.test(lastNonEmptyLine) ? lastNonEmptyLine : null;
  const title = lines.find((line) => TITLE.test(line)) ?? null;
  const summary = { name, sha256: sha256Of(bytes), lastNonEmptyLine, marker };
  if (title === null) return Object.freeze({ ...summary, kind: 'OTHER', refusals: Object.freeze(['NOT_A_REVIEW']) });

  const [, number, rest] = title.match(TITLE);
  const namesSpec = /\bSpec\b/iu.test(rest);
  const namesStandards = /\bStandards\b/iu.test(rest);
  const axis = namesSpec && !namesStandards ? 'SPEC' : namesStandards && !namesSpec ? 'STANDARDS' : null;

  const subjectIndex = lines.findIndex((line) => /^Subject:/u.test(line));
  let subjectSha = null;
  let family = null;
  if (subjectIndex >= 0) {
    const header = [];
    for (let index = subjectIndex; index < lines.length && lines[index].trim().length > 0; index += 1) {
      header.push(lines[index]);
    }
    subjectSha = header.join(' ').match(DETACHED_AT)?.[1] ?? null;
    family = header.map((line) => line.match(FAMILY_LINE)?.[1] ?? null).find((value) => value !== null) ?? null;
  }
  const verdicts = lines.map((line) => line.trim().match(VERDICT_LINE)?.[1] ?? null).filter((value) => value !== null);
  const verdict = verdicts.length === 1 ? verdicts[0] : null;

  const refusals = [];
  if (axis === null) refusals.push(namesSpec && namesStandards ? 'AXIS_AMBIGUOUS' : 'AXIS_MISSING');
  if (subjectSha === null) refusals.push('SUBJECT_NOT_STATED');
  if (verdicts.length === 0) refusals.push('VERDICT_MISSING');
  if (verdicts.length > 1) refusals.push('VERDICT_AMBIGUOUS');
  if (marker === null) refusals.push('MARKER_MISSING');
  return Object.freeze({
    ...summary,
    kind: 'REVIEW',
    pullRequest: number,
    axis,
    subjectSha,
    verdict,
    family,
    refusals: Object.freeze(refusals),
  });
}

/**
 * Which artifacts of one axis bind to `head`. An artifact binds when it is a review of this pull
 * request on this axis whose Subject header states `detached at <head>`, with one verdict line
 * and a marker. Two bound artifacts with different verdicts are a conflict and bind nothing.
 */
export function bindAxis(artifacts, { pullRequest, axis, head }) {
  const candidates = artifacts.filter((artifact) => artifact.kind === 'REVIEW'
    && artifact.pullRequest === pullRequest && (artifact.axis === axis || artifact.axis === null));
  const bound = [];
  const unbound = [];
  for (const artifact of candidates) {
    const reasons = artifact.refusals.filter((reason) => reason !== 'SUBJECT_NOT_STATED');
    if (artifact.subjectSha === null || artifact.subjectSha !== head) reasons.push('SHA_NOT_BOUND');
    if (reasons.length === 0) bound.push(artifact);
    else unbound.push({ name: artifact.name, reasons: Object.freeze([...new Set(reasons)].sort()) });
  }
  const verdicts = [...new Set(bound.map((artifact) => artifact.verdict))];
  if (candidates.length === 0) return { value: false, verdict: null, evidence: { reason: 'NO_ARTIFACT', bound: [], unbound: [] } };
  if (bound.length === 0) return { value: false, verdict: null, evidence: { reason: 'NOT_BOUND', bound: [], unbound } };
  if (verdicts.length > 1) {
    return { value: false, verdict: null, evidence: { reason: 'VERDICT_CONFLICT', bound: bound.map(({ name }) => name), unbound } };
  }
  return {
    value: true,
    verdict: verdicts[0],
    evidence: { reason: null, bound: bound.map(({ name }) => name).sort(), unbound },
  };
}

function familyRepeated(artifacts, pullRequest) {
  const rejected = artifacts.filter((artifact) => artifact.kind === 'REVIEW' && artifact.pullRequest === pullRequest
    && artifact.verdict === 'REQUEST_CHANGES' && artifact.family !== null && artifact.subjectSha !== null);
  const byFamily = new Map();
  for (const artifact of rejected) {
    const heads = byFamily.get(artifact.family) ?? new Set();
    heads.add(artifact.subjectSha);
    byFamily.set(artifact.family, heads);
  }
  const repeated = [...byFamily.entries()].filter(([, heads]) => heads.size >= 2).map(([family]) => family).sort();
  return { value: repeated.length > 0, evidence: { families: repeated } };
}

// ---------------------------------------------------------------------------
// bus records
// ---------------------------------------------------------------------------

function observationOf(message) {
  const parsed = parseClosedTokens(message.text);
  if (parsed.error) return { error: parsed.error };
  const tokens = parsed.tokens;
  for (const key of Object.keys(tokens)) {
    const grammar = PR_OBSERVATION_GRAMMAR[key];
    if (!grammar) return { error: 'OBSERVATION_KEY_UNKNOWN', key };
    if (!grammar.test(tokens[key])) return { error: 'OBSERVATION_VALUE_INVALID', key };
  }
  for (const key of OBSERVATION_REQUIRED) {
    if (!Object.hasOwn(tokens, key)) return { error: 'OBSERVATION_KEY_MISSING', key };
  }
  return { observation: tokens };
}

function laneCompletionOf(text) {
  if (typeof text !== 'string') return null;
  const cut = text.indexOf(';sha256=');
  if (cut <= 0) return null;
  const parsed = parseClosedTokens(text.slice(cut + 1));
  if (parsed.error || !SHA256_HEX.test(parsed.tokens.sha256 ?? '')) return null;
  return {
    artifact: basenameOf(text.slice(0, cut)),
    sha256: parsed.tokens.sha256,
    marker: typeof parsed.tokens.marker === 'string' && MARKER.test(parsed.tokens.marker) ? parsed.tokens.marker : null,
  };
}

const compareRecords = (left, right) => {
  const at = (record) => (typeof record.at === 'string' ? record.at : '');
  if (at(left) !== at(right)) return at(left) < at(right) ? -1 : 1;
  return 0;
};

// ---------------------------------------------------------------------------
// the collector
// ---------------------------------------------------------------------------

const unknown = () => ({ value: 'UNKNOWN', evidence: null });
const known = (value, evidence = null) => ({ value, evidence });

function drainLevelFacts(prefix, state, artifacts) {
  const head = state.head;
  const observation = state.observation ?? {};
  const spec = head === null ? { value: false, verdict: null, evidence: { reason: 'HEAD_UNOBSERVED' } }
    : bindAxis(artifacts, { pullRequest: state.pullRequest, axis: 'SPEC', head });
  const standards = head === null ? { value: false, verdict: null, evidence: { reason: 'HEAD_UNOBSERVED' } }
    : bindAxis(artifacts, { pullRequest: state.pullRequest, axis: 'STANDARDS', head });
  const bothBound = spec.value && standards.value;
  const bothApprove = bothBound && spec.verdict === 'APPROVE' && standards.verdict === 'APPROVE';
  // Remember the head that actually earned dual approval. `D_RECONCILIATION_CLASSIFIED` (folded
  // where the revision-change it requires is visible) advances this same checkpoint when a
  // reconciliation legitimately re-clears a new head; nothing else moves it. Any later observation
  // naming a different head is, by construction, unreviewed at that head.
  if (bothApprove && head !== null) state.approvedHead = head;
  const approvedAtHead = head !== null && state.approvedHead === head;
  const family = familyRepeated(artifacts, state.pullRequest);
  const token = (key) => observation[key];
  const checksAllPass = token('checks') === 'ALL_PASS';
  const facts = {
    D_HEAD_PUBLISHED: head === null ? unknown() : known(true, { head, observedAt: state.observedAt, from: state.from }),
    D_SPEC_VERDICT_BOUND: known(spec.value, { ...spec.evidence, verdict: spec.verdict, head }),
    D_STANDARDS_VERDICT_BOUND: known(standards.value, { ...standards.evidence, verdict: standards.verdict, head }),
    D_BOTH_APPROVE_AT_HEAD: known(bothApprove, {
      spec: spec.verdict, standards: standards.verdict, head, bothBound,
    }),
    D_ANY_REQUEST_CHANGES_AT_HEAD: known(bothBound && (spec.verdict === 'REQUEST_CHANGES' || standards.verdict === 'REQUEST_CHANGES'), {
      spec: spec.verdict, standards: standards.verdict, head, bothBound,
    }),
    D_FAILURE_FAMILY_REPEATED: known(family.value, family.evidence),
    D_MERGEABLE_CLEAN: token('mergeable') === undefined ? unknown()
      : known(approvedAtHead && token('mergeable') === 'MERGEABLE', { mergeable: token('mergeable'), head, approvedHead: state.approvedHead }),
    D_CONFLICTING: token('mergeable') === undefined ? unknown() : known(token('mergeable') === 'CONFLICTING', { mergeable: token('mergeable'), head }),
    D_NOT_DRAFT: token('draft') === undefined ? unknown()
      : token('checks') === undefined ? unknown()
        : known(approvedAtHead && token('draft') === 'false' && checksAllPass, {
          draft: token('draft'), checks: token('checks'), head, approvedHead: state.approvedHead,
        }),
    D_MERGE_CONFIRMED: token('state') === undefined ? unknown()
      : token('checks') === undefined ? unknown()
        : known(approvedAtHead && token('state') === 'MERGED' && token('mergeCommit') !== undefined && checksAllPass, {
          state: token('state'), mergeCommit: token('mergeCommit') ?? null, checks: token('checks'), head, approvedHead: state.approvedHead,
        }),
    D_ISSUE_RECONCILED: token('issue') === undefined ? unknown()
      : token('issue') === 'none' ? known(true, { issue: 'none' })
        : token('issueState') === undefined ? unknown()
          : known(token('issueState') === 'CLOSED', { issue: token('issue'), issueState: token('issueState') }),
  };
  return Object.fromEntries(Object.entries(facts).map(([id, fact]) => [`${prefix}/${id}`, fact]));
}

function markerFact(prefix, completion, artifacts) {
  const artifact = artifacts.find((entry) => entry.name === completion.artifact) ?? null;
  if (artifact === null) {
    return { [`${prefix}/L_MARKER_DIGEST_EQUAL`]: unknown() };
  }
  const digestEqual = artifact.sha256 === completion.sha256;
  const markerLast = completion.marker !== null && artifact.lastNonEmptyLine === completion.marker;
  const reason = !digestEqual ? 'DIGEST_MISMATCH' : !markerLast ? 'MARKER_NOT_LAST_LINE' : null;
  return {
    [`${prefix}/L_MARKER_DIGEST_EQUAL`]: known(reason === null, {
      artifact: artifact.name, sentDigest: completion.sha256, fileDigest: artifact.sha256, marker: completion.marker, reason,
    }),
  };
}

/**
 * Collect the fact events of both nets from bus records and artifact bytes.
 *
 * Records are folded by instant, preserving durable append order when instants tie. Artifact facts
 * are level facts recomputed for a pull request whenever its head or its visible artifacts change;
 * an artifact becomes visible at the first `lane-complete` message whose digest equals its bytes,
 * and every remaining artifact becomes visible at one terminal snapshot event (the artifact
 * directory carries no instants of its own).
 */
export function collectDrainFacts({ records, artifacts, observationSource }) {
  if (!Array.isArray(records)) fail('RecordsInvalid', 'records must be a list');
  if (!Array.isArray(artifacts)) fail('ArtifactsInvalid', 'artifacts must be a list');
  if (typeof observationSource !== 'string' || !/^act-\d{4,}$/u.test(observationSource)) {
    fail('ObservationSourceInvalid', 'observationSource must name one exact minted actor ref');
  }
  for (const record of records) {
    if (!record || typeof record !== 'object' || typeof record.type !== 'string') {
      fail('RecordsInvalid', 'every record must carry a type');
    }
    if (record.at !== undefined && (typeof record.at !== 'string' || !INSTANT.test(record.at))) {
      fail('RecordsInvalid', `record at ${JSON.stringify(record.at)} is not an instant`);
    }
  }
  const parsedArtifacts = artifacts.map(parseArtifact).sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const names = new Set();
  for (const artifact of parsedArtifacts) {
    if (names.has(artifact.name)) fail('ArtifactsInvalid', `artifact ${artifact.name} is listed twice`);
    names.add(artifact.name);
  }
  // ECMAScript sorting is stable, so records sharing one instant keep their append order. Exact
  // re-delivery remains idempotent even when another same-instant record separates the copies.
  const sorted = [...records].sort(compareRecords);
  const seen = new Set();
  const ordered = sorted.filter((record) => {
    const key = canonicalJson(record);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const registeredActors = new Set();
  const lanes = new Map();
  const pulls = new Map();
  const refused = [];
  const drainEvents = [];
  const laneEvents = [];
  const visible = new Set();
  const prPrefix = (key) => `${DRAIN_NET_TEMPLATE.instancePrefix}${key}`;
  const lanePrefix = (key) => `${LANE_NET_TEMPLATE.instancePrefix}${key}`;
  const visibleArtifacts = () => parsedArtifacts.filter((artifact) => visible.has(artifact.name));
  const pullState = (number) => {
    if (!pulls.has(number)) {
      pulls.set(number, {
        pullRequest: number, head: null, observation: null, observedAt: null, from: null, approvedHead: null,
      });
    }
    return pulls.get(number);
  };
  const emitDrain = (number, at, source, edge = {}) => {
    drainEvents.push({
      at, source, level: drainLevelFacts(prPrefix(number), pullState(number), visibleArtifacts()), edge,
    });
  };

  ordered.forEach((record, ordinal) => {
    const at = typeof record.at === 'string' ? record.at : null;
    const source = `${record.type}#${ordinal}`;
    if (record.type === 'actor.registered' && typeof record.ref === 'string') {
      // Registration is authority evidence only when it carries a causal instant. Missing `at`
      // sorts as the empty string, so accepting it here would let a physically later record grant
      // authority retroactively to an earlier timestamped observation.
      if (at !== null) registeredActors.add(record.ref);
      if (record.kind === 'lane') {
        lanes.set(record.ref, {
          ref: record.ref, name: typeof record.name === 'string' ? record.name : null, registeredAt: at,
        });
      }
      return;
    }
    if (record.type === 'actor.heartbeat' && lanes.has(record.actorId)) {
      const parsed = parseClosedTokens(record.note);
      if (parsed.error) { refused.push({ ordinal, source, reason: `HEARTBEAT_${parsed.error}` }); return; }
      const prefix = lanePrefix(record.actorId);
      const edge = {};
      if (parsed.tokens.phase === 'start') edge[`${prefix}/L_ATTEMPT_STARTED`] = known(true, { attempt: parsed.tokens.attempt ?? null });
      if (Object.hasOwn(parsed.tokens, 'exit')) {
        const code = Number.parseInt(parsed.tokens.exit, 10);
        if (!Number.isSafeInteger(code) || String(code) !== parsed.tokens.exit) {
          refused.push({ ordinal, source, reason: 'HEARTBEAT_EXIT_INVALID' });
          return;
        }
        const id = code === 0 ? 'L_EXIT_ZERO' : 'L_EXIT_NONZERO';
        edge[`${prefix}/${id}`] = known(true, { attempt: parsed.tokens.attempt ?? null, exit: code });
      }
      if (Object.keys(edge).length > 0) laneEvents.push({ at, source, level: {}, edge });
      return;
    }
    if (record.type !== 'message.sent' || !record.message || typeof record.message !== 'object') return;
    const message = record.message;
    if (LANE_MESSAGE_KINDS.includes(message.kind) && lanes.has(message.from)) {
      const prefix = lanePrefix(message.from);
      const id = { 'lane-complete': 'L_LANE_COMPLETE_SENT', 'lane-exhausted': 'L_LANE_EXHAUSTED_SENT', 'lane-aborted': 'L_LANE_ABORTED_SENT' }[message.kind];
      const level = {};
      let completion = null;
      if (message.kind === 'lane-complete') {
        completion = laneCompletionOf(message.text);
        if (completion === null) { refused.push({ ordinal, source, reason: 'LANE_COMPLETE_TEXT_INVALID' }); return; }
        const artifact = parsedArtifacts.find((entry) => entry.name === completion.artifact && entry.sha256 === completion.sha256);
        Object.assign(level, markerFact(prefix, completion, parsedArtifacts));
        if (artifact && !visible.has(artifact.name)) {
          visible.add(artifact.name);
          if (artifact.kind === 'REVIEW') emitDrain(artifact.pullRequest, at, source);
        }
      }
      laneEvents.push({
        at, source, level, edge: { [`${prefix}/${id}`]: known(true, { messageId: message.messageId ?? null, artifact: completion?.artifact ?? null }) },
      });
      return;
    }
    if (message.kind === PR_OBSERVATION_KIND) {
      // The caller names the one exact observer ref. Bus actor kind is self-declared descriptive
      // data, so it is never consulted as authority (B1's sibling: containment binds nothing).
      if (message.from !== observationSource) {
        refused.push({ ordinal, source, reason: 'OBSERVATION_SOURCE_UNAUTHORIZED', key: message.from ?? null });
        return;
      }
      if (!registeredActors.has(observationSource)) {
        fail('ObservationSourceUnregistered',
          'observationSource must have an earlier actor.registered record in the ordered log');
      }
      const result = observationOf(message);
      if (result.error) { refused.push({ ordinal, source, reason: result.error, key: result.key ?? null }); return; }
      const observation = result.observation;
      const state = pullState(observation.pr);
      const previousHead = state.head;
      const revisionAdvanced = previousHead !== null && previousHead !== observation.head;
      state.head = observation.head;
      state.observation = observation;
      state.observedAt = at;
      state.from = message.from ?? null;
      const prefix = prPrefix(observation.pr);
      const edge = {};
      // Every head move is an edge. Downstream places consume it into P_RECONCILE, so a caller
      // cannot bypass the reconciliation transition merely by attaching CLASSIFIED to the move.
      if (revisionAdvanced) {
        edge[`${prefix}/D_HEAD_ADVANCED`] = known(true, { from: previousHead, to: observation.head });
      }
      // Classification is evidence-complete only at a genuinely changed head, with both fresh
      // review artifacts bound to that exact head and checks observed ALL_PASS. The Petri marking,
      // not this collector, decides whether the corresponding reconciliation transition can fire.
      if (observation.reconciliation === 'CLASSIFIED') {
        const artifactsAtHead = visibleArtifacts();
        const spec = bindAxis(artifactsAtHead, { pullRequest: observation.pr, axis: 'SPEC', head: observation.head });
        const standards = bindAxis(artifactsAtHead, { pullRequest: observation.pr, axis: 'STANDARDS', head: observation.head });
        const reviewsApprove = spec.value && spec.verdict === 'APPROVE'
          && standards.value && standards.verdict === 'APPROVE';
        if (!revisionAdvanced) {
          refused.push({ ordinal, source, reason: 'RECONCILIATION_WITHOUT_REVISION_CHANGE', key: observation.head });
        } else if (!reviewsApprove || observation.checks !== 'ALL_PASS') {
          refused.push({ ordinal, source, reason: 'RECONCILIATION_EVIDENCE_INCOMPLETE', key: observation.head });
        } else {
          edge[`${prefix}/D_RECONCILIATION_CLASSIFIED`] = known(true, {
            head: observation.head,
            from: previousHead,
            checks: observation.checks,
            spec: spec.evidence,
            standards: standards.evidence,
          });
        }
      }
      if (observation.reconciliation === 'UNCLASSIFIED') edge[`${prefix}/D_RECONCILIATION_UNCLASSIFIED`] = known(true, { head: observation.head });
      emitDrain(observation.pr, at, source, edge);
    }
  });

  // Terminal snapshot: every artifact not proven by a lane-complete message becomes visible now.
  for (const artifact of parsedArtifacts) {
    if (artifact.kind === 'REVIEW' && artifact.pullRequest !== undefined) pullState(artifact.pullRequest);
    visible.add(artifact.name);
  }
  const lastAt = ordered.length > 0 ? (ordered.at(-1).at ?? null) : null;
  for (const number of [...pulls.keys()].sort()) emitDrain(number, lastAt, 'artifact-snapshot');

  return Object.freeze({
    schema: DRAIN_FACTS_SCHEMA,
    pullRequests: Object.freeze([...pulls.keys()].sort()),
    lanes: Object.freeze([...lanes.keys()].sort()),
    laneRegistry: Object.freeze([...lanes.values()].sort((left, right) => (left.ref < right.ref ? -1 : 1))),
    artifacts: Object.freeze(parsedArtifacts),
    drainEvents: Object.freeze(drainEvents),
    laneEvents: Object.freeze(laneEvents),
    refused: Object.freeze(refused),
    inputsRevision: revisionOf({
      observationSource,
      records: ordered.map((record) => canonicalJson(record)),
      artifacts: parsedArtifacts.map(({ name, sha256 }) => ({ name, sha256 })),
    }),
  });
}
