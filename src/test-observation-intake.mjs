/**
 * test-observation-intake.mjs — `gaia-test-observation/1`, R0 of issue #53: the one pure conversion
 * from a comment somebody wrote into an observation Gaia can replay, and the one read-only
 * projection of what has been observed.
 *
 * WHAT THIS MODULE IS NOT
 * -----------------------
 * It is not a GitHub client. It opens nothing, spawns nothing, holds no clock and carries no
 * credential; the only import is `node:crypto` for the digests, which is pure. The comment arrives
 * as an already-verified reading produced by an injected read-only source, so the core has no
 * dependency on the sibling repository the comment happens to live in — swapping the source for a
 * fixture changes nothing about what an observation means.
 *
 * THE FOUR RULES
 * --------------
 * 1. **The source's identity and bytes survive.** Repository, issue number, comment id, link, the
 *    two source instants and a digest of the exact UTF-8 body are republished as read, never
 *    re-derived, re-encoded or summarized. The digest is of the body string, not of the document
 *    that transported it, because those are two different byte sequences.
 * 2. **Evidence is appended, never overwritten.** An edited comment is a new revision linked to
 *    the one it followed. A replay of a revision already held changes nothing at all. Nothing in
 *    this module can shorten, rewrite or drop a revision that was admitted.
 * 3. **An absent, deleted, malformed or backwards-moving source is said out loud.** Every one of
 *    those produces an `UNKNOWN` observation carrying the reason, positioned in the same ledger
 *    beside the evidence it could not replace. None of them is allowed to look like a success, and
 *    none of them erases what was already known.
 * 4. **Untrusted text grants no authority.** A comment is data. `effect` and `authority` are the
 *    constants `NONE` on every observation this module can produce, whatever the body asks for. A
 *    severity a comment declares is recorded as *declared by the source* — `severityBasis` is a
 *    separate field precisely so a reader never has to infer whether Gaia agreed.
 *
 * Facts, interpretations, recommendations and the source's own statement of its authority boundary
 * are kept as separate kinds because collapsing them is how an operator ends up acting on somebody's
 * guess. The classification is structural: it comes from the source's own explicit field label —
 * either a bare `Label:` or the Markdown list item `- **Label:**` that renders as one — and a line
 * with no recognized label is not silently promoted into a kind. Nothing is classified by meaning,
 * and every claim carries `basis: SOURCE_ASSERTED`, because what this module verified is who said
 * it and which bytes said it, never whether it is true.
 */

import { createHash } from 'node:crypto';

export const TEST_COMMENT_READING_SCHEMA = 'gaia-test-comment-reading/1';
export const TEST_OBSERVATION_SCHEMA = 'gaia-test-observation/1';

/**
 * Where the bytes came from. A fixture is never allowed to be mistaken for a live read.
 *
 * `CAPTURED_REPLAY` is a third answer rather than a shade of the other two: bytes that really were
 * read from the source once and are being replayed offline are neither invented nor live, and a
 * reader deciding how much to trust an observation needs to be told which of the three it holds.
 */
export const TEST_OBSERVATION_PROVENANCES = Object.freeze([
  'LIVE', 'CAPTURED_REPLAY', 'SYNTHETIC_FIXTURE',
]);

/** What the source adapter found. Three answers, and no fourth that means "probably fine". */
export const TEST_COMMENT_AVAILABILITIES = Object.freeze(['AVAILABLE', 'DELETED', 'UNAVAILABLE']);

/** Two states: it normalized, or it did not and says why. */
export const TEST_OBSERVATION_STATES = Object.freeze(['NORMALIZED', 'UNKNOWN']);

/** Every way an observation can fail to carry content. Closed, and each one names one cause. */
export const TEST_OBSERVATION_UNKNOWN_REASONS = Object.freeze([
  'SOURCE_UNAVAILABLE',
  'SOURCE_DELETED',
  'SOURCE_MALFORMED',
  'SOURCE_TIMESTAMP_INVALID',
  'SOURCE_TIME_REGRESSED',
]);

/**
 * The kinds of sentence, kept apart so none of them has to be inferred by a reader.
 *
 * `AUTHORITY_ASSERTION` is what the observed source says about its own limits. It is a fourth kind
 * and not a recommendation because the two read differently to an operator: "no merge authority was
 * granted" is a boundary being reported, not an action being proposed. Recording it changes nothing
 * about what anything is allowed to do — `authority` is the constant `NONE` either way, and a
 * comment asserting a wider boundary would simply be a comment asserting it.
 */
export const TEST_OBSERVATION_CLAIM_KINDS = Object.freeze([
  'FACT', 'INTERPRETATION', 'RECOMMENDATION', 'AUTHORITY_ASSERTION',
]);

/**
 * Every claim in an observation is the source speaking. Publishing that as a field, rather than
 * leaving it implied by the word "observation", is what keeps a `FACT` claim from being read as a
 * fact Gaia verified: this module verified who said it and what bytes said it, and nothing else.
 */
export const TEST_OBSERVATION_CLAIM_BASIS = 'SOURCE_ASSERTED';

/** Severity is a closed vocabulary; `UNKNOWN` is what an unstated severity is. */
export const TEST_OBSERVATION_SEVERITIES = Object.freeze([
  'INFO', 'WARNING', 'CRITICAL', 'UNKNOWN',
]);

/** Whether the severity was asserted by the source or simply absent. Never "agreed by Gaia". */
export const TEST_OBSERVATION_SEVERITY_BASES = Object.freeze(['SOURCE_DECLARED', 'ABSENT']);

export const TEST_COMMENT_READING_FIELDS = Object.freeze([
  'schema', 'provenance', 'availability', 'repository', 'issueNumber', 'commentId',
  'sourceUrl', 'body', 'createdAt', 'updatedAt', 'observedAt',
]);

export const TEST_OBSERVATION_FIELDS = Object.freeze([
  'schema', 'effect', 'authority', 'observationKey', 'revisionId', 'previousRevisionId',
  'state', 'unknownReason', 'provenance', 'repository', 'issueNumber', 'commentId', 'sourceUrl',
  'rawDigest', 'rawByteLength', 'sourceCreatedAt', 'sourceUpdatedAt', 'observedAt',
  'severity', 'severityBasis', 'claims', 'workReferences',
]);

/** A comment body larger than this is refused rather than parsed. Real ones are kilobytes. */
export const MAX_TEST_COMMENT_BYTES = 64 * 1024;

/** Bounds on what one comment may contribute, so one source cannot flood a projection. */
export const MAX_TEST_OBSERVATION_CLAIMS = 64;
export const MAX_TEST_OBSERVATION_WORK_REFERENCES = 32;
/**
 * Long enough for the fields real automated observations actually carry — the source comment this
 * slice was built for has a 456-character observation field — and short enough that one comment
 * cannot fill a projection. A claim past the bound is refused, never shortened: a truncated claim
 * is a claim the source did not make.
 */
export const MAX_TEST_CLAIM_LENGTH = 2_000;

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u;
const SOURCE_REPOSITORY = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u;
const WORK_REFERENCE = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+#[1-9]\d*$/u;

/**
 * The claim labels, singular and exact. A body that wants to be read as a fact must carry one of
 * these labels; nothing is promoted into a kind by resembling one, and no text is classified by
 * meaning. Null-prototype, so `constructor` is not a claim kind.
 *
 * `observation`, `recommended next action` and `authority boundary` are the labels the automated
 * observations this slice consumes actually write. They are listed because those documents declare
 * their own structure, not because a reader guessed what the paragraphs were about.
 */
const CLAIM_LABELS = Object.freeze(Object.assign(Object.create(null), {
  'fact': 'FACT',
  'observation': 'FACT',
  'interpretation': 'INTERPRETATION',
  'recommendation': 'RECOMMENDATION',
  'recommended next action': 'RECOMMENDATION',
  'authority boundary': 'AUTHORITY_ASSERTION',
}));

/**
 * The subject line of an automated observation names its work in prose: `owner/name issue #117`.
 * Reading it is a structural match on that exact form, so a sentence that merely mentions a
 * repository never becomes a reference, and `#117` alone never becomes one either.
 */
const SUBJECT_WORK_REFERENCE = /^([A-Za-z0-9._-]+\/[A-Za-z0-9._-]+) issue #([1-9]\d*)(?![0-9])/u;

export class TestObservationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TestObservationError';
  }
}

function refuse(message) {
  throw new TestObservationError(message);
}

const ordinal = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const isDigest = (value) => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/u.test(value);

const isInstant = (value) => typeof value === 'string' && INSTANT.test(value)
  && Number.isFinite(Date.parse(value));

function digestOf(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * The total verifier of what an input source may hand in.
 *
 * It is exported because the source adapter and this normalizer must agree on exactly one
 * definition of a reading, and neither of them gets to hold that definition privately.
 */
export function requireTestCommentReading(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse('a comment reading must be an object');
  }
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify([...TEST_COMMENT_READING_FIELDS].sort())) {
    refuse('a comment reading carries exactly its declared fields');
  }
  if (value.schema !== TEST_COMMENT_READING_SCHEMA) refuse('unsupported comment reading schema');
  if (!TEST_OBSERVATION_PROVENANCES.includes(value.provenance)) {
    refuse('unknown reading provenance');
  }
  if (!TEST_COMMENT_AVAILABILITIES.includes(value.availability)) {
    refuse('unknown reading availability');
  }
  if (typeof value.repository !== 'string' || !SOURCE_REPOSITORY.test(value.repository)) {
    refuse('a reading names one owner/name source repository');
  }
  if (!Number.isSafeInteger(value.issueNumber) || value.issueNumber < 1) {
    refuse('invalid issue number');
  }
  if (!Number.isSafeInteger(value.commentId) || value.commentId < 1) {
    refuse('invalid comment identity');
  }
  if (typeof value.sourceUrl !== 'string' || !value.sourceUrl.startsWith('https://')) {
    refuse('a reading carries one https source link');
  }
  if (!isInstant(value.observedAt)) refuse('a reading carries the instant it was observed');
  if (value.body !== null && typeof value.body !== 'string') refuse('a body is text or absent');
  return Object.freeze({ ...value });
}

/**
 * Read the kinds of sentence out of a body, and only where the source said which is which.
 *
 * Bounded on every axis: claim count, claim length and reference count. The body is never
 * rewritten — the digest is what preserves it — so the trimming here affects the projection's
 * rendering only, and the evidence stays exact.
 */
function readClaims(body) {
  const claims = [];
  const references = [];
  let severity = 'UNKNOWN';
  let severityBasis = 'ABSENT';
  for (const line of body.split(/\r?\n/u)) {
    const field = readLabelledField(line);
    if (field === null) continue;
    const { label, text } = field;
    const kind = CLAIM_LABELS[label];
    if (kind !== undefined) {
      if (claims.length >= MAX_TEST_OBSERVATION_CLAIMS) refuse('too many claims in one comment');
      if (text.length > MAX_TEST_CLAIM_LENGTH) refuse('a single claim is too long to project');
      claims.push(Object.freeze({ kind, text, basis: TEST_OBSERVATION_CLAIM_BASIS }));
      continue;
    }
    if (label === 'severity') {
      const declared = text.toUpperCase();
      // A severity the source spelled wrong is an unstated severity, not an escalation.
      if (TEST_OBSERVATION_SEVERITIES.includes(declared) && declared !== 'UNKNOWN') {
        severity = declared;
        severityBasis = 'SOURCE_DECLARED';
      }
      continue;
    }
    for (const reference of readWorkReferences(label, text)) {
      if (references.length >= MAX_TEST_OBSERVATION_WORK_REFERENCES) {
        refuse('too many work references');
      }
      references.push(reference);
    }
  }
  return {
    claims: Object.freeze(claims),
    severity,
    severityBasis,
    workReferences: Object.freeze([...new Set(references)].sort(ordinal)),
  };
}

/**
 * One labelled line, in either of the two forms an observing writer actually emits: a bare
 * `Label: value`, or the Markdown list item `- **Label:** value` that renders as one.
 *
 * The two are the same structure with different decoration, so they are read by one function and
 * the decoration is removed rather than interpreted. Everything else in a body — headings, prose,
 * blank lines — is passed over untouched; the digest above is what preserves it.
 */
function readLabelledField(line) {
  // Two forms, read separately because their colon sits in different places: a bold label carries
  // its own colon inside the emphasis (`**Observed at:**`) and needs none after it, while a bare
  // label is defined by the colon that follows it.
  const emphasised = line.match(/^\s*(?:[-*]\s+)?\*\*\s*([^*:]{1,60}?)\s*:?\s*\*\*\s*:?\s*(.+?)\s*$/u);
  const match = emphasised
    ?? line.match(/^\s*(?:[-*]\s+)?([A-Za-z][A-Za-z /]{0,59}?)\s*:\s*(.+?)\s*$/u);
  if (match === null) return null;
  const raw = match[1];
  if (raw === undefined) return null;
  // One canonical spelling of a label: case-folded and internally single-spaced. Nothing else about
  // the line is normalized, and the value is never rewritten.
  return { label: raw.trim().toLowerCase().replace(/\s+/gu, ' '), text: match[2] };
}

/**
 * Work identities, read only where a source declares one and only in a declared form.
 *
 * Two forms, both exact: the `Work:` line this module has always read, and the leading
 * `owner/name issue #N` of an automated observation's subject line. A bare `#119` in free text is
 * deliberately not a work identity — it names nothing without a repository, and guessing which
 * repository was meant is how an observation about one project ends up filed against another.
 */
function readWorkReferences(label, text) {
  if (label === 'work' && WORK_REFERENCE.test(text)) return [text];
  if (label === 'repository / subject') {
    const match = text.match(SUBJECT_WORK_REFERENCE);
    if (match !== null) return [`${match[1]}#${match[2]}`];
  }
  return [];
}

/**
 * The revision identity: a content address over exactly what makes one revision different from
 * another. Two readings of an unchanged comment collapse to one revision; an edit does not.
 *
 * `previousRevisionId` is deliberately excluded, so replaying the same revision behind a different
 * history cannot mint a second identity for the same evidence.
 */
export function testObservationRevisionId(parts) {
  return digestOf(JSON.stringify([
    TEST_OBSERVATION_SCHEMA,
    parts.observationKey,
    parts.state,
    parts.unknownReason ?? null,
    parts.rawDigest ?? null,
    parts.sourceUpdatedAt ?? null,
    parts.sourceCreatedAt ?? null,
    parts.rawByteLength,
    parts.sourceUrl,
    parts.provenance,
    parts.severity,
    parts.severityBasis,
    parts.claims.map(({ kind, basis, text }) => [kind, basis, text]),
    parts.workReferences,
  ]));
}

/** The stable identity of one commented-on piece of evidence, across every revision of it. */
export function testObservationKey({ repository, issueNumber, commentId }) {
  return `${repository}#${issueNumber}#comment-${commentId}`;
}

function observation(reading, observationKey, fields) {
  const value = {
    schema: TEST_OBSERVATION_SCHEMA,
    // Constants, not inputs. No comment can raise them and no caller can pass them in.
    effect: 'NONE',
    authority: 'NONE',
    observationKey,
    previousRevisionId: null,
    provenance: reading.provenance,
    repository: reading.repository,
    issueNumber: reading.issueNumber,
    commentId: reading.commentId,
    sourceUrl: reading.sourceUrl,
    observedAt: reading.observedAt,
    ...fields,
  };
  return Object.freeze({ ...value, revisionId: testObservationRevisionId(value) });
}

function unknownObservation(reading, observationKey, unknownReason) {
  return observation(reading, observationKey, {
    state: 'UNKNOWN',
    unknownReason,
    rawDigest: null,
    rawByteLength: 0,
    sourceCreatedAt: isInstant(reading.createdAt) ? reading.createdAt : null,
    sourceUpdatedAt: isInstant(reading.updatedAt) ? reading.updatedAt : null,
    severity: 'UNKNOWN',
    severityBasis: 'ABSENT',
    claims: Object.freeze([]),
    workReferences: Object.freeze([]),
  });
}

/**
 * One reading becomes one observation. Total: it either returns an observation or refuses the
 * reading's shape, and it never returns something that looks normalized when it is not.
 */
export function normalizeTestObservation(input) {
  const reading = requireTestCommentReading(input);
  const observationKey = testObservationKey(reading);

  if (reading.availability === 'DELETED') {
    return unknownObservation(reading, observationKey, 'SOURCE_DELETED');
  }
  if (reading.availability === 'UNAVAILABLE') {
    return unknownObservation(reading, observationKey, 'SOURCE_UNAVAILABLE');
  }
  if (typeof reading.body !== 'string' || reading.body.trim().length === 0
    || Buffer.byteLength(reading.body, 'utf8') > MAX_TEST_COMMENT_BYTES) {
    return unknownObservation(reading, observationKey, 'SOURCE_MALFORMED');
  }
  if (!isInstant(reading.createdAt) || !isInstant(reading.updatedAt)) {
    return unknownObservation(reading, observationKey, 'SOURCE_TIMESTAMP_INVALID');
  }
  if (Date.parse(reading.updatedAt) < Date.parse(reading.createdAt)) {
    // The source contradicts itself before any history is consulted: an edit that precedes the
    // comment it edits is not a timeline Gaia can place.
    return unknownObservation(reading, observationKey, 'SOURCE_TIME_REGRESSED');
  }

  const read = readClaims(reading.body);
  if (read.claims.length === 0) {
    // Nothing in the body said which sentences are facts. Guessing is the one thing this module
    // exists not to do, so the evidence is kept and the content is UNKNOWN.
    return unknownObservation(reading, observationKey, 'SOURCE_MALFORMED');
  }
  return observation(reading, observationKey, {
    state: 'NORMALIZED',
    unknownReason: null,
    rawDigest: digestOf(reading.body),
    rawByteLength: Buffer.byteLength(reading.body, 'utf8'),
    sourceCreatedAt: reading.createdAt,
    sourceUpdatedAt: reading.updatedAt,
    severity: read.severity,
    severityBasis: read.severityBasis,
    claims: read.claims,
    workReferences: read.workReferences,
  });
}

// ---------------------------------------------------------------------------
// The append-only ledger: the only structure that decides duplicate from revision
// ---------------------------------------------------------------------------

export const TEST_OBSERVATION_LEDGER_SCHEMA = 'gaia-test-observation-ledger/1';
export const TEST_OBSERVATION_ADMISSION_SCHEMA = 'gaia-test-observation-admission/1';

/**
 * Four outcomes, and each names one thing that happened to the evidence.
 *
 * `ALREADY_HELD` is not a failure and `REGRESSED` is not a success. Both are separated from
 * `ADMITTED` because an operator reading a projection has to be able to tell a first sighting from
 * a replay from a source that went backwards, and a single boolean cannot say that.
 */
export const TEST_OBSERVATION_ADMISSION_OUTCOMES = Object.freeze([
  'ADMITTED', 'ALREADY_HELD', 'REVISED', 'REGRESSED',
]);

/** A ledger holds one comment's whole observed history; this bounds one process's memory. */
export const MAX_TEST_OBSERVATION_ENTRIES = 512;

export function emptyTestObservationLedger() {
  return Object.freeze({
    schema: TEST_OBSERVATION_LEDGER_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    entries: Object.freeze([]),
  });
}

function requireLedger(value) {
  if (value === null || typeof value !== 'object' || value.schema !== TEST_OBSERVATION_LEDGER_SCHEMA
    || !Array.isArray(value.entries)) {
    refuse('an admission needs one observation ledger');
  }
  return value;
}

function admission(outcome, ledger) {
  return Object.freeze({ schema: TEST_OBSERVATION_ADMISSION_SCHEMA, outcome, ledger });
}

function appended(ledger, entry) {
  if (ledger.entries.length >= MAX_TEST_OBSERVATION_ENTRIES) refuse('the observation ledger is full');
  const held = Object.freeze({
    ...entry,
    claims: Object.freeze(entry.claims.map((claim) => Object.freeze({ ...claim }))),
    workReferences: Object.freeze([...entry.workReferences]),
  });
  return Object.freeze({ ...ledger, entries: Object.freeze([...ledger.entries, held]) });
}

/**
 * Admit one observation into the ledger. Pure, append-only, and total.
 *
 * The decision order is the contract. The current placed revision is answered before any timestamp is
 * compared, so re-reading an unchanged comment can never be mistaken for a source that went
 * backwards; and a backwards source is recorded rather than admitted, so a stale mirror cannot
 * overwrite the newer evidence it disagrees with. Nothing here can remove or edit an entry.
 */
/**
 * The total verifier of an observation, applied before anything is admitted.
 *
 * A ledger that accepts any object carrying the right `schema` accepts an object that says
 * `effect: WRITE` and `authority: MERGE`, stores it verbatim, and hands it to a projection an
 * operator reads as Gaia's own evidence. Trusting the producer is not available here: the whole
 * point of the ledger is that it holds what it can check.
 *
 * It checks against the same published field list and vocabularies the normalizer builds from, so
 * there is exactly one definition of an observation and no second one to drift.
 */
export function requireTestObservation(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    refuse('only a normalized observation can be admitted');
  }
  if (JSON.stringify(Object.keys(value).sort())
    !== JSON.stringify([...TEST_OBSERVATION_FIELDS].sort())) {
    refuse('an observation carries exactly its declared fields');
  }
  if (value.schema !== TEST_OBSERVATION_SCHEMA) refuse('unsupported observation schema');
  // Constants, not fields a producer may choose. An observation is evidence; nothing about holding
  // one lets anything act, and a document claiming otherwise is refused rather than stored.
  if (value.effect !== 'NONE' || value.authority !== 'NONE') {
    refuse('an observation carries no effect and no authority');
  }
  if (!TEST_OBSERVATION_STATES.includes(value.state)) refuse('unknown observation state');
  if (value.state === 'NORMALIZED'
    ? value.unknownReason !== null
    : !TEST_OBSERVATION_UNKNOWN_REASONS.includes(value.unknownReason)) {
    refuse('an observation state and its reason must agree');
  }
  if (!TEST_OBSERVATION_PROVENANCES.includes(value.provenance)) refuse('unknown provenance');
  if (!TEST_OBSERVATION_SEVERITIES.includes(value.severity)
    || !TEST_OBSERVATION_SEVERITY_BASES.includes(value.severityBasis)) {
    refuse('unknown severity');
  }
  if (typeof value.repository !== 'string' || !SOURCE_REPOSITORY.test(value.repository)
    || !Number.isSafeInteger(value.issueNumber) || value.issueNumber < 1
    || !Number.isSafeInteger(value.commentId) || value.commentId < 1
    || typeof value.sourceUrl !== 'string' || !value.sourceUrl.startsWith('https://')
    || value.observationKey !== testObservationKey(value)) {
    refuse('an observation carries one exact source identity');
  }
  if (!isDigest(value.revisionId)
    || (value.previousRevisionId !== null && !isDigest(value.previousRevisionId))) {
    refuse('an observation carries content-addressed revision identity');
  }
  if (value.rawDigest !== null && !isDigest(value.rawDigest)) refuse('invalid raw source digest');
  if (!Number.isSafeInteger(value.rawByteLength) || value.rawByteLength < 0
    || (value.rawDigest === null) !== (value.rawByteLength === 0)) {
    refuse('a raw digest and a raw length are present together or not at all');
  }
  for (const instant of [value.sourceCreatedAt, value.sourceUpdatedAt]) {
    if (instant !== null && !isInstant(instant)) refuse('invalid source instant');
  }
  if (!isInstant(value.observedAt)) refuse('an observation carries the instant it was observed');
  if (!Array.isArray(value.claims) || value.claims.length > MAX_TEST_OBSERVATION_CLAIMS) {
    refuse('invalid claims');
  }
  for (const claim of value.claims) {
    if (claim === null || typeof claim !== 'object'
      || JSON.stringify(Object.keys(claim).sort()) !== JSON.stringify(['basis', 'kind', 'text'])
      || !TEST_OBSERVATION_CLAIM_KINDS.includes(claim.kind)
      || claim.basis !== TEST_OBSERVATION_CLAIM_BASIS
      || typeof claim.text !== 'string' || claim.text.length === 0
      || claim.text.length > MAX_TEST_CLAIM_LENGTH) {
      refuse('every claim is one bounded sentence asserted by the source');
    }
  }
  if (!Array.isArray(value.workReferences)
    || value.workReferences.length > MAX_TEST_OBSERVATION_WORK_REFERENCES
    || value.workReferences.some((reference) => typeof reference !== 'string'
      || !WORK_REFERENCE.test(reference))) {
    refuse('every work reference names one repository and one number');
  }
  if (value.state === 'UNKNOWN'
    && (value.rawDigest !== null || value.claims.length > 0 || value.workReferences.length > 0)) {
    refuse('an unknown observation publishes no content');
  }
  if (value.revisionId !== testObservationRevisionId(value)) {
    refuse('revision identity does not match observation content');
  }
  return value;
}

export function admitTestObservation(ledgerInput, observationInput) {
  const ledger = requireLedger(ledgerInput);
  const candidate = requireTestObservation(observationInput);

  const history = ledger.entries.filter((entry) => entry.observationKey === candidate.observationKey);
  const held = new Set(history.map((entry) => entry.revisionId));
  const current = history.findLast((entry) => entry.unknownReason !== 'SOURCE_TIME_REGRESSED');
  if (current?.revisionId === candidate.revisionId) {
    // Only the current state deduplicates a reading. Historical content can become current again
    // after an availability gap; that recovery must be recorded, not hidden as an old duplicate.
    return admission('ALREADY_HELD', ledger);
  }
  const latest = history.at(-1) ?? null;
  if (latest === null) {
    return admission('ADMITTED', appended(ledger, Object.freeze({ ...candidate, previousRevisionId: null })));
  }

  const frontier = sourceFrontier(history);
  if (frontier !== null && candidate.sourceUpdatedAt !== null
    && Date.parse(candidate.sourceUpdatedAt) < Date.parse(frontier.sourceUpdatedAt)) {
    const regressive = regressionEntry(candidate, frontier);
    // A stale read that has already been recorded as stale decides nothing a second time. Without
    // this the same mirror could be replayed forever, each replay appending another entry.
    if (held.has(regressive.revisionId)) return admission('ALREADY_HELD', ledger);
    return admission('REGRESSED', appended(ledger, regressive));
  }
  const revision = Object.freeze({ ...candidate, previousRevisionId: latest.revisionId });
  return admission('REVISED', appended(ledger, revision));
}

/**
 * The newest source instant this ledger has actually placed in the timeline — the frontier a later
 * reading has to beat to be believed.
 *
 * Derived from placed evidence only, never from the last entry appended. That distinction is the
 * whole point: a regression diagnostic records that a stale mirror was seen, and if it were allowed
 * to become the baseline, replaying that same mirror once more would compare it against itself,
 * find no regression, and publish the old content as current. Readings with no source instant —
 * an unavailable or deleted source — cannot move a frontier they carry no evidence about.
 */
function sourceFrontier(history) {
  let frontier = null;
  for (const entry of history) {
    if (entry.unknownReason === 'SOURCE_TIME_REGRESSED' || entry.sourceUpdatedAt === null) continue;
    if (frontier === null || Date.parse(entry.sourceUpdatedAt) > Date.parse(frontier.sourceUpdatedAt)) {
      frontier = entry;
    }
  }
  return frontier;
}

/**
 * The diagnostic an out-of-order read leaves behind: it says a stale source was seen, and it says
 * nothing else. The content is dropped rather than republished, because a digest here would read as
 * a competing version of the truth, and it is linked to the frontier it failed to beat.
 */
function regressionEntry(candidate, frontier) {
  const parts = {
    observationKey: candidate.observationKey,
    state: 'UNKNOWN',
    unknownReason: 'SOURCE_TIME_REGRESSED',
    rawDigest: null,
    sourceUpdatedAt: candidate.sourceUpdatedAt,
  };
  const diagnostic = {
    ...candidate,
    ...parts,
    rawByteLength: 0,
    severity: 'UNKNOWN',
    severityBasis: 'ABSENT',
    claims: Object.freeze([]),
    workReferences: Object.freeze([]),
    previousRevisionId: frontier.revisionId,
  };
  return Object.freeze({ ...diagnostic, revisionId: testObservationRevisionId(diagnostic) });
}

// ---------------------------------------------------------------------------
// The read model: what an operator is allowed to see, and nothing that acts
// ---------------------------------------------------------------------------

export const TEST_OBSERVATION_PROJECTION_SCHEMA = 'gaia-test-observation-projection/1';

export const TEST_OBSERVATION_PROJECTION_ROW_FIELDS = Object.freeze([
  'observationKey', 'repository', 'issueNumber', 'commentId', 'sourceUrl', 'provenance',
  'state', 'unknownReason', 'severity', 'severityBasis', 'rawDigest',
  'sourceCreatedAt', 'sourceUpdatedAt', 'observedAt',
  'currentRevisionId', 'revisions', 'claimBasis', 'facts', 'interpretations', 'recommendations',
  'authorityAssertions', 'workReferences',
]);

function claimTexts(observation, kind) {
  return Object.freeze(observation.claims
    .filter((claim) => claim.kind === kind)
    .map((claim) => claim.text));
}

/**
 * Project the ledger into the one read model a caller may display. Pure, and effect-free by
 * construction: it returns strings, and it never returns a function, a source, or a way back to
 * one. A reader of this projection cannot reach the input source it describes.
 *
 * The current reading is the latest revision only — an operator looking at a comment is looking at
 * what it says now — and the full revision list travels beside it so that "now" never silently
 * replaces what was previously observed. An `UNKNOWN` current revision is reported as unknown; the
 * projection does not fall back to the last revision that happened to parse, because presenting
 * superseded content as current is exactly the fabricated success this slice exists to prevent.
 */
export function projectTestObservations(ledgerInput) {
  const ledger = requireLedger(ledgerInput);
  const byKey = new Map();
  for (const entry of ledger.entries) {
    if (!byKey.has(entry.observationKey)) byKey.set(entry.observationKey, []);
    byKey.get(entry.observationKey).push(entry);
  }
  const observations = [...byKey.entries()]
    .sort(([a], [b]) => ordinal(a, b))
    .map(([observationKey, history]) => {
      // The current reading is the newest one that was actually placed in the timeline. A stale
      // mirror is recorded in `revisions` and is visible there, but it is not what an operator is
      // shown: it carries no content, and letting it become the current row would turn somebody
      // else's replay into an apparent loss of everything already known. An unavailable or deleted
      // source is different — that is fresh information about the source — so it does become
      // current, exactly as it did before.
      const placed = history.filter((entry) => entry.unknownReason !== 'SOURCE_TIME_REGRESSED');
      const current = placed.at(-1) ?? history.at(-1);
      return Object.freeze({
        observationKey,
        repository: current.repository,
        issueNumber: current.issueNumber,
        commentId: current.commentId,
        sourceUrl: current.sourceUrl,
        provenance: current.provenance,
        state: current.state,
        unknownReason: current.unknownReason,
        severity: current.severity,
        severityBasis: current.severityBasis,
        rawDigest: current.rawDigest,
        sourceCreatedAt: current.sourceCreatedAt,
        sourceUpdatedAt: current.sourceUpdatedAt,
        observedAt: current.observedAt,
        currentRevisionId: current.revisionId,
        revisions: Object.freeze(history.map((entry) => Object.freeze({
          revisionId: entry.revisionId,
          previousRevisionId: entry.previousRevisionId,
          state: entry.state,
          unknownReason: entry.unknownReason,
          rawDigest: entry.rawDigest,
          rawByteLength: entry.rawByteLength,
          sourceUpdatedAt: entry.sourceUpdatedAt,
          observedAt: entry.observedAt,
        }))),
        // Named on every row rather than explained in a caption: everything in the four lists
        // below is what the source said, and a reader must never have to assume otherwise.
        claimBasis: TEST_OBSERVATION_CLAIM_BASIS,
        facts: claimTexts(current, 'FACT'),
        interpretations: claimTexts(current, 'INTERPRETATION'),
        recommendations: claimTexts(current, 'RECOMMENDATION'),
        authorityAssertions: claimTexts(current, 'AUTHORITY_ASSERTION'),
        workReferences: current.workReferences,
      });
    });
  return Object.freeze({
    schema: TEST_OBSERVATION_PROJECTION_SCHEMA,
    effect: 'NONE',
    authority: 'NONE',
    observations: Object.freeze(observations),
  });
}
