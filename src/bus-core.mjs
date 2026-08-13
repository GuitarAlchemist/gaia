/**
 * bus-core.mjs — pure state machine for the gaia-interagent coordination bus.
 *
 * No I/O, no clock, no randomness. Every command carries its own `at` timestamp
 * and every identifier is derived from state counters, so `replay(events)`
 * reproduces state exactly. Everything in this file is a pure function.
 *
 * Authority model, stated once:
 *   - The bus tool surface is exactly: register, send, inbox, ack, heartbeat, handoff.
 *     None of those verbs can approve, merge, push, commit, deploy, read credentials,
 *     or mutate configuration. The capability simply does not exist on the bus.
 *   - Message bodies are stored as `untrusted-text`. Delivered text may become a
 *     prompt in the receiving session, but it carries no authority: it is data.
 *   - Per-message authority is explicit metadata drawn from a fixed allowlist.
 *     Anything outside the allowlist is denied, recorded, and never applied.
 *   - No message can raise any actor's authority, including its own sender's.
 *     `busAuthority` is a frozen constant assigned at registration.
 *
 * Addressing model:
 *   - Every registration mints a stable `ref` (act-NNNN). Refs are the real address.
 *   - Display names are NOT unique. Two sessions may both be called "claude-code";
 *     both are preserved, and addressing that name is rejected as ambiguous with the
 *     candidate refs listed. Names are a convenience, refs are the contract.
 *
 * Delivery semantics:
 *   - `send` succeeding means accepted-for-delivery. It never means read, agreed,
 *     acted upon, or completed. `ack` means received, not approved.
 *   - Any message expecting a reply carries an explicit `replyTo` return address.
 *
 * Cost, stated accurately and not optimistically: `apply` calls `ageActors` on every
 * event, so replaying a log is O(events x actors), not O(events). No projection,
 * index, or cached tail offset is implemented here, and none is claimed.
 */

export const PROTOCOL_VERSION = 'gaia-interagent-bus/1.0';

/** The complete, fixed set of things any actor may do *on the bus*. Not negotiable. */
export const BUS_AUTHORITY = Object.freeze(['send', 'receive', 'ack', 'heartbeat', 'handoff']);

/** Per-message authority hints a sender may legitimately attach. All are read-only/advisory. */
export const GRANTABLE_AUTHORITY = Object.freeze(['read', 'observe', 'suggest', 'draft', 'report']);

/** Explicitly enumerated for the negative control. Requesting any of these is always denied. */
export const NEVER_GRANTABLE = Object.freeze([
  'approve', 'merge', 'push', 'commit', 'deploy',
  'config-write', 'credential-read', 'grant-authority', 'execute', 'admin',
]);

/** The six verbs, in one place, so every surface check has a single source. */
export const BUS_VERBS = Object.freeze(['register', 'send', 'inbox', 'ack', 'heartbeat', 'handoff']);

/** What a successful `send` actually proves. Deliberately verbose to prevent misreading. */
export const DELIVERY_MEANING = 'accepted-for-delivery; not read, not agreed, not completed';

/** An actor that has not been seen within this window is `stale` but still addressable. */
export const STALE_AFTER_MS = 30_000;

/**
 * The largest correlation ordinal this bus will recognise or issue.
 *
 * `cor-NNNN` ids are minted from a counter, and a caller may claim one to join a
 * thread. Claiming an ordinal above 2^53 used to poison that counter: `Number()` on a
 * wider digit string is a float, and `String(1e20 + 1)` is still `1e20`, so the issuer
 * then minted the SAME id forever and merged unrelated threads in silence.
 *
 * Every bound below derives from this one constant, and that is the fix rather than
 * tidiness. An input bound narrower than the recognition bound reintroduces the defect
 * one order of magnitude lower: claiming the widest accepted id makes the issuer emit
 * one digit more, which a narrower recogniser then cannot see, so the counter never
 * advances again.
 */
export const MAX_CORRELATION_ORDINAL = Number.MAX_SAFE_INTEGER;
export const MAX_CORRELATION_DIGITS = String(MAX_CORRELATION_ORDINAL).length;

/** Phrases in message text that look like attempts to command the receiver. Flagged, never obeyed. */
const AUTHORITY_LANGUAGE = [
  /\bapprove\b/i, /\bmerge\b/i, /\bpush\b/i, /\bforce[- ]push\b/i,
  /\bdeploy\b/i, /\bcommit\b/i, /\bcredential/i, /\bsecret/i,
  /\bchange (the )?config/i, /\bupdate (the )?config/i, /\bmutate\b/i,
  /\bgrant\b/i, /\byou (now )?have admin\b/i, /\bignore (the )?(previous|above)\b/i,
];

export const EMPTY_STATE = Object.freeze({
  protocol: PROTOCOL_VERSION,
  actors: {},      // ref -> actor
  nameIndex: {},   // display name -> [ref, ...]  (duplicates preserved)
  messages: {},
  inboxes: {},     // ref -> [messageId, ...]
  handoffs: [],
  authorityDenials: [],
  rejections: [],
  counters: { actor: 0, message: 0, correlation: 0, event: 0 },
  lastEventAt: null,
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const pad = (n) => String(n).padStart(4, '0');
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

/**
 * Own-key discipline for the four identity maps.
 *
 * `actors`, `nameIndex`, `messages` and `inboxes` are plain objects, so `map[key]`
 * answers for `__proto__`, `constructor`, `toString`, `valueOf` and `hasOwnProperty`
 * whether or not anything was ever stored under them. Reading through `own`/`hasOwnKey`
 * is what makes "is this a registered actor?" mean what it says.
 *
 * `setOwn` exists for the WRITE direction, which is a separate hazard: `map[k] = v`
 * invokes the `__proto__` setter and re-parents the map, which is how a committed
 * registration used to vanish on replay. A computed key in an object literal
 * (`{ ...m, [k]: v }`) and object spread both create own properties already, so those
 * are left alone; only real assignments are converted.
 *
 * Deliberately NOT a denylist. An operator may legitimately name a session
 * `constructor`, and after this repair that works.
 */
const hasOwnKey = (map, key) => Object.hasOwn(map, key);
const own = (map, key) => (Object.hasOwn(map, key) ? map[key] : undefined);
const setOwn = (map, key, value) => {
  Object.defineProperty(map, key, { value, writable: true, enumerable: true, configurable: true });
  return map;
};

/**
 * The shape of a ref this bus mints. `pad` grows past `act-9999` to five digits, so
 * `\d{4,}` does not cap the bus at 9,999 actors.
 */
const MINTED_REF = /^act-\d{4,}$/;

/**
 * A display name shaped like a ref. Refs always win address resolution, so an actor
 * registered under such a name would be unreachable by its own name.
 */
const REF_SHAPED_NAME = /^act-\d+$/;

const CORRELATION_NUMERIC = /^cor-(\d+)$/;
const CORRELATION_RECOGNISED = new RegExp(`^cor-(\\d{1,${MAX_CORRELATION_DIGITS}})$`);

/** The ordinal a numeric `cor-` id claims, or null when it claims nothing exactly. */
export function correlationOrdinal(correlationId) {
  const claimed = CORRELATION_RECOGNISED.exec(correlationId ?? '');
  if (!claimed) return null;
  const n = Number(claimed[1]);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * Refuse a caller-supplied `cor-` id the issuer could not have minted and could not
 * count past. Strictly below the ceiling, because the next mint is `ordinal + 1` and
 * that addition must still be exact. A non-numeric thread name claims nothing and is
 * left entirely unconstrained.
 */
export function correlationIdError(value) {
  if (!isNonEmptyString(value)) return null;
  const trimmed = value.trim();
  if (!CORRELATION_NUMERIC.test(trimmed)) return null;
  const ordinal = correlationOrdinal(trimmed);
  if (ordinal !== null && ordinal < MAX_CORRELATION_ORDINAL) return null;
  return `correlationId ${trimmed} is outside the issuer's exact range: numeric cor- ids must be `
    + `below ${MAX_CORRELATION_ORDINAL}, or the issuer cannot count past them without colliding `
    + 'unrelated threads. Use a non-numeric thread name (e.g. cor-t' + trimmed.slice(4) + ') instead.';
}

/**
 * How far ahead of the issuer a caller may claim a numeric ordinal.
 *
 * A caller joining a real thread names an ordinal the issuer has already minted, or
 * one just ahead of it; a million is far past any legitimate margin and still leaves
 * the ordinal astronomically short of the ceiling. Anything beyond the window is not
 * joining a thread — it is moving the issuer, and one `send` moving the issuer to
 * within one of the ceiling is what killed a whole data directory.
 */
export const CORRELATION_CLAIM_SLACK = 1_000_000;

/**
 * Refuse a caller-supplied ordinal the issuer could not plausibly be at.
 *
 * `correlationIdError` bounds the claim against the TYPE ceiling. That is necessary
 * and not sufficient: the high-water rule then ADOPTS whatever the caller named, and
 * the high-water rule is correct — it is what stops the issuer re-minting an id a
 * caller already used — so the bound has to be applied at input validation instead.
 * An id inside the type range but far above the issuer's own position is exactly the
 * shape that exhausts the sequence, and the one shape nothing checked.
 */
export function correlationClaimError(state, value) {
  const typed = correlationIdError(value);
  if (typed) return typed;
  if (!isNonEmptyString(value)) return null;
  const ordinal = correlationOrdinal(value.trim());
  if (ordinal === null) return null; // a non-numeric thread name claims nothing
  const issuer = state?.counters?.correlation ?? 0;
  if (ordinal <= issuer + CORRELATION_CLAIM_SLACK) return null;
  return `correlationId cor-${ordinal} is ${ordinal - issuer} ahead of the issuer (at ${issuer}); `
    + 'accepting it would advance the sequence past the point of no return, and this log is '
    + 'append-only so the issuer could never be wound back. Join a live thread by its own id, '
    + 'or use a non-numeric thread name.';
}

/**
 * The last ordinal from which a full claim window still fits below the ceiling.
 *
 * Derived from the admission window rather than chosen beside it, because health has
 * to be measured on the same basis admission uses or the two disagree. An issuer at
 * or above this floor has less than one window of runway left: a single claim the
 * admission rule would accept can take the sequence to the ceiling.
 */
export const CORRELATION_HEADROOM_FLOOR = MAX_CORRELATION_ORDINAL - CORRELATION_CLAIM_SLACK;

/**
 * How much runway this state's correlation issuer has left, and whether that runway
 * is gone or nearly gone.
 *
 * The quantity that matters is `headroom` — how many ids the auto-issuer can still
 * mint before it must refuse. That is what the counter-overflow defect destroyed, and
 * it is a function of the issuer alone, exactly as admission is.
 *
 * An earlier form of this report measured health against `messages.length` instead.
 * Admission ratchets the issuer and that basis did not, so the second at-window claim
 * on any directory outran it: the bus accepted a send with `ok:true` and then
 * condemned its own log for containing it, permanently, on an append-only file. A
 * health rule that can fail on data the bus itself admitted is not a health rule.
 *
 * `findings` names the messages that carry an ordinal at or above the floor — the
 * fingerprint of a directory a pre-fix build poisoned. It is diagnostic detail; the
 * verdict is `ok`, which is about the issuer. Reporting only: nothing here repairs a
 * committed record, and this report never rewrites the log.
 */
export function correlationHealthReport(state) {
  const messages = Object.values(state.messages ?? {});
  const findings = [];
  for (const m of messages) {
    const ordinal = correlationOrdinal(m.correlationId);
    if (ordinal !== null && ordinal >= CORRELATION_HEADROOM_FLOOR) {
      findings.push({
        messageId: m.messageId, correlationId: m.correlationId, ordinal,
        headroomFloor: CORRELATION_HEADROOM_FLOOR,
      });
    }
  }
  const issuerAt = state.counters?.correlation ?? 0;
  const headroom = Math.max(0, MAX_CORRELATION_ORDINAL - issuerAt);
  const exhausted = issuerAt >= MAX_CORRELATION_ORDINAL;
  const nearExhausted = issuerAt >= CORRELATION_HEADROOM_FLOOR;
  return {
    issuerAt,
    headroom,
    headroomFloor: CORRELATION_HEADROOM_FLOOR,
    exhausted,
    nearExhausted,
    findings,
    ok: !nearExhausted,
  };
}

/** Refuse to auto-issue an id the sequence can no longer advance past. */
function correlationExhaustionError(state, cmd) {
  if (isNonEmptyString(cmd.correlationId)) return null;
  if (state.counters.correlation < MAX_CORRELATION_ORDINAL) return null;
  return `the correlation-id sequence is exhausted at ${MAX_CORRELATION_ORDINAL}: refusing to re-issue `
    + 'an id that has already been used. Supply an explicit non-numeric correlationId.';
}

function toList(value) {
  if (value == null) return [];
  return Array.isArray(value) ? value.filter(isNonEmptyString).map((s) => s.trim()) : [];
}

/**
 * `requestedAuthority` must be an array of strings, or absent. Anything else is
 * refused rather than coerced.
 *
 * This matters because the coercion is silent in the dangerous direction: passing the
 * string "approve" through a list-flattener yields [], so the response would report
 * `denied: []` — reading as "nothing privileged was asked for" when something was.
 * The bus still grants nothing either way, but the audit record would be wrong, and a
 * wrong audit record is worse than a rejected command. Capabilities stay lenient by
 * contrast: they are self-declared and the bus never acts on them.
 */
function validateRequestedAuthority(value) {
  if (value == null) return null;
  if (!Array.isArray(value)) {
    return `requestedAuthority must be an array of strings, got ${typeof value} — refusing rather than silently ignoring it`;
  }
  if (!value.every(isNonEmptyString)) {
    return 'requestedAuthority must contain only non-empty strings — refusing rather than silently dropping entries';
  }
  return null;
}

function flagAuthorityLanguage(text) {
  return AUTHORITY_LANGUAGE.some((re) => re.test(text)) ? ['authority-language-detected'] : [];
}

/**
 * Resolve an address that may be a stable ref or a display name.
 * Duplicate names are an expected condition, not corruption — they resolve to an
 * explicit ambiguity error listing every candidate ref.
 */
export function resolveActor(state, key) {
  if (!isNonEmptyString(key)) return { error: 'address must be a non-empty string' };
  const trimmed = key.trim();
  if (hasOwnKey(state.actors, trimmed)) return { ref: trimmed };

  const refs = own(state.nameIndex, trimmed) ?? [];
  if (refs.length === 1) return { ref: refs[0] };
  if (refs.length === 0) return { error: `unknown actor: ${trimmed}` };
  return {
    error: `ambiguous actor name "${trimmed}" — ${refs.length} actors share it; address by ref: ${refs.join(', ')}`,
    candidates: refs,
  };
}

/**
 * Split a requested authority list into what the bus will record as granted
 * versus what it refuses. Anything not on the allowlist is denied — the
 * NEVER_GRANTABLE list exists to name the refusals precisely, not to define them.
 */
export function classifyAuthority(requested) {
  const granted = [];
  const denied = [];
  for (const item of toList(requested)) {
    if (GRANTABLE_AUTHORITY.includes(item)) granted.push(item);
    else denied.push(item);
  }
  return { granted, denied };
}

function rejection(cmd, reason) {
  return { type: 'command.rejected', at: cmd?.at ?? null, command: cmd?.type ?? 'unknown', reason };
}

function fail(cmd, reason) {
  return { events: [rejection(cmd, reason)], error: reason };
}

// ---------------------------------------------------------------------------
// decide: (state, command) -> events
// ---------------------------------------------------------------------------

/**
 * Translate a command into zero or more events. Pure. Never throws for bad input:
 * invalid commands become `command.rejected` events so the log records the attempt.
 */
export function decide(state, cmd) {
  if (!cmd || !isNonEmptyString(cmd.type)) return fail(cmd, 'command must have a type');
  if (!isNonEmptyString(cmd.at)) return fail(cmd, 'command must carry an `at` timestamp');

  switch (cmd.type) {
    case 'register': return decideRegister(state, cmd);
    case 'send': return decideSend(state, cmd);
    case 'inbox': return decideInbox(state, cmd);
    case 'ack': return decideAck(state, cmd);
    case 'heartbeat': return decideHeartbeat(state, cmd);
    case 'handoff': return decideHandoff(state, cmd);
    default: return fail(cmd, `unknown command: ${cmd.type}`);
  }
}

function decideRegister(state, cmd) {
  if (!isNonEmptyString(cmd.actorId)) return fail(cmd, 'register requires actorId');
  const name = cmd.actorId.trim();

  // Refuse rather than flag. Refs win address resolution, so an actor registered under
  // a ref-shaped name is unaddressable by the very name it registered — the sender
  // silently reaches a different actor and no ambiguity warning fires. Minting an
  // identity the bus cannot deliver to is the defect; flagging it would preserve it.
  if (REF_SHAPED_NAME.test(name)) {
    return fail(cmd, `actorId "${name}" is shaped like a bus ref (act-NNNN); refs are minted by the bus `
      + 'and always win address resolution, so this actor would be unreachable by its own name. '
      + 'Choose a display name that is not act-<digits>.');
  }

  // Re-registering an existing session requires its ref. Without one we mint a new
  // actor, even if the display name collides — that collision is the real world.
  //
  // A supplied ref must both LOOK minted and BE present as an own key. The two
  // conditions overlap today (no inherited key matches act-NNNN), and that redundancy
  // is deliberate: `hasOwnKey` is what keeps this correct if the ref namespace ever
  // widens. It is belt-and-braces, not two independent guards.
  let ref;
  if (isNonEmptyString(cmd.ref)) {
    const candidate = cmd.ref.trim();
    if (!MINTED_REF.test(candidate) || !hasOwnKey(state.actors, candidate)) {
      return fail(cmd, `unknown ref for re-registration: ${cmd.ref}`);
    }
    ref = candidate;
  } else {
    ref = `act-${pad(state.counters.actor + 1)}`;
  }

  const event = {
    type: 'actor.registered',
    at: cmd.at,
    ref,
    name,
    isNew: !hasOwnKey(state.actors, ref),
    kind: isNonEmptyString(cmd.kind) ? cmd.kind.trim() : 'unknown',
    // Self-declared and informational only. The bus does not act on these.
    declaredCapabilities: toList(cmd.capabilities),
    // Fixed by the bus, identical for every actor, unaffected by any message.
    busAuthority: [...BUS_AUTHORITY],
  };
  const shared = (own(state.nameIndex, name) ?? []).filter((r) => r !== ref);
  return {
    events: [event],
    result: {
      ref, name, busAuthority: event.busAuthority,
      nameSharedWith: shared,
      addressing: shared.length > 0 ? `name "${name}" is ambiguous — address this actor as ${ref}` : `addressable as "${name}" or ${ref}`,
    },
  };
}

/** Resolve a set of address fields, returning either refs or the first failure. */
function resolveAll(state, cmd, fields) {
  const refs = {};
  for (const [field, key] of fields) {
    if (!isNonEmptyString(key)) return { error: `${cmd.type} requires ${field}` };
    const resolved = resolveActor(state, key);
    if (resolved.error) return { error: `${field}: ${resolved.error}` };
    refs[field] = resolved.ref;
  }
  return { refs };
}

function buildMessage(state, cmd, { kind, text, from, to, replyTo }) {
  const messageId = `msg-${pad(state.counters.message + 1)}`;
  const correlationId = isNonEmptyString(cmd.correlationId)
    ? cmd.correlationId.trim()
    : `cor-${pad(state.counters.correlation + 1)}`;
  const { granted, denied } = classifyAuthority(cmd.requestedAuthority);
  return {
    messageId,
    correlationId,
    from,
    fromName: state.actors[from].name,
    to,
    toName: state.actors[to].name,
    // Explicit return address. Present on every message so a reply is always routable.
    replyTo,
    replyToName: state.actors[replyTo].name,
    expectsReply: Boolean(cmd.expectsReply),
    kind,
    // Stored verbatim. Plain text, never interpreted, never executed.
    text,
    trust: 'untrusted-text',
    authority: {
      granted,
      denied,
      // The bus applies no authority effect whatsoever. This field is a constant.
      effect: 'none',
      neverGrantable: [...NEVER_GRANTABLE],
    },
    flags: flagAuthorityLanguage(text),
    sentAt: cmd.at,
    delivery: DELIVERY_MEANING,
    deliveredAt: null,
    ackedBy: null,
    ackedAt: null,
  };
}

function denialEvent(cmd, message) {
  return {
    type: 'authority.denied',
    at: cmd.at,
    messageId: message.messageId,
    from: message.from,
    to: message.to,
    requested: message.authority.denied,
    // Recorded so an operator can see the attempt. No state is granted.
    outcome: 'stored-as-untrusted-text; no authority applied',
  };
}

function decideSend(state, cmd) {
  const { refs, error } = resolveAll(state, cmd, [['from', cmd.from], ['to', cmd.to]]);
  if (error) return fail(cmd, error);
  if (!isNonEmptyString(cmd.text)) return fail(cmd, 'send requires non-empty text');
  const authorityShape = validateRequestedAuthority(cmd.requestedAuthority);
  if (authorityShape) return fail(cmd, authorityShape);
  const correlationShape = correlationClaimError(state, cmd.correlationId) ?? correlationExhaustionError(state, cmd);
  if (correlationShape) return fail(cmd, correlationShape);

  let replyTo = refs.from;
  if (isNonEmptyString(cmd.replyTo)) {
    const resolved = resolveActor(state, cmd.replyTo);
    if (resolved.error) return fail(cmd, `replyTo: ${resolved.error}`);
    replyTo = resolved.ref;
  }

  const message = buildMessage(state, cmd, {
    kind: isNonEmptyString(cmd.kind) ? cmd.kind.trim() : 'note',
    text: cmd.text, from: refs.from, to: refs.to, replyTo,
  });
  const events = [{ type: 'message.sent', at: cmd.at, message }];
  if (message.authority.denied.length > 0) events.push(denialEvent(cmd, message));

  return {
    events,
    result: {
      messageId: message.messageId,
      correlationId: message.correlationId,
      route: `${message.from} -> ${message.to}`,
      replyTo: message.replyTo,
      authority: message.authority,
      delivery: DELIVERY_MEANING,
    },
  };
}

function decideInbox(state, cmd) {
  const { refs, error } = resolveAll(state, cmd, [['actorId', cmd.actorId]]);
  if (error) return fail(cmd, error);
  const pending = pendingFor(state, refs.actorId);
  return {
    events: [{ type: 'inbox.polled', at: cmd.at, actorId: refs.actorId, messageIds: pending.map((m) => m.messageId) }],
    result: { actorId: refs.actorId, pending },
  };
}

function decideAck(state, cmd) {
  const { refs, error } = resolveAll(state, cmd, [['actorId', cmd.actorId]]);
  if (error) return fail(cmd, error);
  const message = own(state.messages, cmd.messageId);
  if (!message) return fail(cmd, `unknown messageId: ${cmd.messageId}`);
  if (message.to !== refs.actorId) return fail(cmd, `${refs.actorId} cannot ack a message addressed to ${message.to}`);

  return {
    events: [{
      type: 'message.acked',
      at: cmd.at,
      actorId: refs.actorId,
      messageId: cmd.messageId,
      note: isNonEmptyString(cmd.note) ? cmd.note : null,
    }],
    // Spelled out because "acked" is routinely misread as "approved" or "done".
    result: { messageId: cmd.messageId, ackedBy: refs.actorId, meaning: 'receipt only; not agreement, approval, or completion' },
  };
}

function decideHeartbeat(state, cmd) {
  const { refs, error } = resolveAll(state, cmd, [['actorId', cmd.actorId]]);
  if (error) return fail(cmd, error);
  return {
    events: [{ type: 'actor.heartbeat', at: cmd.at, actorId: refs.actorId, note: isNonEmptyString(cmd.note) ? cmd.note : null }],
    result: { actorId: refs.actorId, at: cmd.at },
  };
}

function decideHandoff(state, cmd) {
  const { refs, error } = resolveAll(state, cmd, [['from', cmd.from], ['to', cmd.to]]);
  if (error) return fail(cmd, error);
  if (!isNonEmptyString(cmd.summary)) return fail(cmd, 'handoff requires a summary');
  const authorityShape = validateRequestedAuthority(cmd.requestedAuthority);
  if (authorityShape) return fail(cmd, authorityShape);
  const correlationShape = correlationClaimError(state, cmd.correlationId) ?? correlationExhaustionError(state, cmd);
  if (correlationShape) return fail(cmd, correlationShape);

  let replyTo = refs.from;
  if (isNonEmptyString(cmd.replyTo)) {
    const resolved = resolveActor(state, cmd.replyTo);
    if (resolved.error) return fail(cmd, `replyTo: ${resolved.error}`);
    replyTo = resolved.ref;
  }

  // A handoff transfers *work*, never authority. It is carried by an ordinary message.
  const message = buildMessage(state, cmd, {
    kind: 'handoff', text: cmd.summary, from: refs.from, to: refs.to, replyTo,
  });
  const events = [
    { type: 'message.sent', at: cmd.at, message },
    {
      type: 'work.handed-off',
      at: cmd.at,
      from: refs.from,
      to: refs.to,
      messageId: message.messageId,
      correlationId: message.correlationId,
      replyTo,
      summary: cmd.summary,
      authorityTransferred: [],
    },
  ];
  if (message.authority.denied.length > 0) events.push(denialEvent(cmd, message));

  return {
    events,
    result: {
      messageId: message.messageId,
      correlationId: message.correlationId,
      replyTo,
      authorityTransferred: [],
      delivery: DELIVERY_MEANING,
    },
  };
}

// ---------------------------------------------------------------------------
// apply: (state, event) -> state
// ---------------------------------------------------------------------------

/**
 * Actor status is a pure function of last-seen and the newest event time.
 *
 * This runs on EVERY event, which is why the per-call replay cost is
 * O(events x actors) rather than O(events). Stated here so the number in the
 * documentation has a line of code to point at.
 */
function ageActors(actors, nowIso) {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) return actors;
  const aged = {};
  for (const [ref, actor] of Object.entries(actors)) {
    const seen = Date.parse(actor.lastSeenAt);
    const stale = !Number.isNaN(seen) && now - seen > STALE_AFTER_MS;
    // define, do not assign: `aged[ref] = …` for ref `__proto__` re-parents this map
    // and drops the entry, which is how a committed registration used to disappear
    // between the log and the replayed state.
    setOwn(aged, ref, { ...actor, status: stale ? 'stale' : 'online' });
  }
  return aged;
}

export function apply(state, event) {
  const base = {
    ...state,
    counters: { ...state.counters, event: state.counters.event + 1 },
    lastEventAt: event.at ?? state.lastEventAt,
  };
  let next = base;

  switch (event.type) {
    case 'actor.registered': {
      // `apply` is NOT gated by `resolveActor`: it consumes whatever the durable log
      // already holds, including records only a pre-fix build could have written. It
      // reports on them (see `integrityReport`); it never repairs them.
      const existing = own(state.actors, event.ref);

      // A re-registration may rename the actor. Drop the ref from whatever name it
      // used to answer to, and drop the key once it empties, so a stale display name
      // can never resolve to an actor that no longer bears it. Without this the bus
      // silently misroutes — and then refuses a genuinely correct address once a real
      // actor takes the freed name. Only one ref is removed, so real twins sharing a
      // name go on sharing it.
      const freedIndex = { ...base.nameIndex };
      if (existing && existing.name !== event.name) {
        const rest = (own(freedIndex, existing.name) ?? []).filter((r) => r !== event.ref);
        if (rest.length === 0) delete freedIndex[existing.name];
        else setOwn(freedIndex, existing.name, rest);
      }

      const priorRefs = own(freedIndex, event.name) ?? [];
      next = {
        ...base,
        actors: {
          ...base.actors,
          [event.ref]: {
            ref: event.ref,
            name: event.name,
            kind: event.kind,
            declaredCapabilities: event.declaredCapabilities,
            busAuthority: event.busAuthority,
            registeredAt: existing?.registeredAt ?? event.at,
            lastSeenAt: event.at,
            status: 'online',
            heartbeats: existing?.heartbeats ?? 0,
          },
        },
        // Duplicate display names are preserved, never overwritten.
        nameIndex: { ...freedIndex, [event.name]: priorRefs.includes(event.ref) ? priorRefs : [...priorRefs, event.ref] },
        inboxes: { ...base.inboxes, [event.ref]: own(base.inboxes, event.ref) ?? [] },
        counters: { ...base.counters, actor: existing ? base.counters.actor : base.counters.actor + 1 },
      };
      break;
    }

    case 'message.sent': {
      const m = event.message;

      // The auto-issuer owns the whole `cor-NNNN` namespace. A caller may still hand
      // in an id from it — that is how a thread is joined — but the counter must then
      // jump past it, or the issuer will later mint the same id for an unrelated
      // thread and merge the two silently. Comparing against only the NEXT auto value
      // handles exactly one offset and misses every other. A high-water mark handles
      // all of them, and leaves a non-numeric thread name (`cor-live-smoke`,
      // `cor-thread`) inert, since it claims nothing in the sequence. An ordinal the
      // issuer could never have emitted claims nothing either: that is what lets a log
      // the defective build already wrote replay to a small exact counter, with no
      // migration and no rewrite of an append-only file.
      const highWater = correlationOrdinal(m.correlationId) ?? 0;

      next = {
        ...base,
        messages: { ...base.messages, [m.messageId]: m },
        inboxes: { ...base.inboxes, [m.to]: [...(own(base.inboxes, m.to) ?? []), m.messageId] },
        counters: {
          ...base.counters,
          message: base.counters.message + 1,
          correlation: Math.max(base.counters.correlation, highWater),
        },
      };
      break;
    }

    case 'authority.denied':
      next = { ...base, authorityDenials: [...base.authorityDenials, event] };
      break;

    case 'inbox.polled': {
      const messages = { ...base.messages };
      for (const id of event.messageIds) {
        const m = own(messages, id);
        if (m && m.deliveredAt === null) setOwn(messages, id, { ...m, deliveredAt: event.at });
      }
      const actor = own(base.actors, event.actorId);
      next = {
        ...base,
        messages,
        actors: actor ? { ...base.actors, [event.actorId]: { ...actor, lastSeenAt: event.at } } : base.actors,
      };
      break;
    }

    case 'message.acked': {
      const m = own(base.messages, event.messageId);
      if (!m) { next = base; break; }
      const actor = own(base.actors, event.actorId);
      next = {
        ...base,
        messages: { ...base.messages, [event.messageId]: { ...m, ackedBy: event.actorId, ackedAt: event.at, ackNote: event.note } },
        actors: actor ? { ...base.actors, [event.actorId]: { ...actor, lastSeenAt: event.at } } : base.actors,
      };
      break;
    }

    case 'actor.heartbeat': {
      const actor = own(base.actors, event.actorId);
      if (!actor) { next = base; break; }
      next = {
        ...base,
        actors: { ...base.actors, [event.actorId]: { ...actor, lastSeenAt: event.at, heartbeats: actor.heartbeats + 1 } },
      };
      break;
    }

    case 'work.handed-off':
      next = {
        ...base,
        handoffs: [...base.handoffs, {
          from: event.from, to: event.to, messageId: event.messageId,
          correlationId: event.correlationId, replyTo: event.replyTo, summary: event.summary,
          authorityTransferred: event.authorityTransferred, at: event.at,
        }],
      };
      break;

    case 'command.rejected':
      next = { ...base, rejections: [...base.rejections, event] };
      break;

    default:
      next = base;
      break;
  }

  return event.at ? { ...next, actors: ageActors(next.actors, event.at) } : next;
}

// ---------------------------------------------------------------------------
// commit / replay / selectors
// ---------------------------------------------------------------------------

/** Run one command against state. Returns the new state plus the events to append. */
export function commit(state, cmd) {
  const { events, result, error } = decide(state, cmd);
  const nextState = events.reduce(apply, state);
  return { state: nextState, events, result: result ?? null, error: error ?? null };
}

/** Rebuild state from an append-only event stream. This is the restart path. */
export function replay(events) {
  return events.reduce(apply, EMPTY_STATE);
}

/** Messages addressed to an actor ref that have not been acked yet. */
export function pendingFor(state, ref) {
  return (own(state.inboxes, ref) ?? [])
    .map((id) => own(state.messages, id))
    .filter((m) => m && m.ackedBy === null);
}

/** Compact, printable view of the whole bus. */
export function snapshot(state) {
  return {
    protocol: state.protocol,
    eventsApplied: state.counters.event,
    lastEventAt: state.lastEventAt,
    actors: Object.values(state.actors).map((a) => ({
      ref: a.ref,
      name: a.name,
      kind: a.kind,
      status: a.status,
      heartbeats: a.heartbeats,
      declaredCapabilities: a.declaredCapabilities,
      busAuthority: a.busAuthority,
      nameSharedWith: (own(state.nameIndex, a.name) ?? []).filter((r) => r !== a.ref),
      pending: pendingFor(state, a.ref).length,
    })),
    messages: Object.values(state.messages).map((m) => ({
      messageId: m.messageId,
      correlationId: m.correlationId,
      route: `${m.from}(${m.fromName}) -> ${m.to}(${m.toName})`,
      replyTo: `${m.replyTo}(${m.replyToName})`,
      expectsReply: m.expectsReply,
      kind: m.kind,
      trust: m.trust,
      delivery: m.delivery,
      authorityGranted: m.authority.granted,
      authorityDenied: m.authority.denied,
      flags: m.flags,
      acked: m.ackedBy !== null,
      text: m.text.length > 96 ? `${m.text.slice(0, 93)}...` : m.text,
    })),
    handoffs: state.handoffs,
    authorityDenials: state.authorityDenials.map((d) => ({
      messageId: d.messageId, from: d.from, to: d.to, requested: d.requested, outcome: d.outcome,
    })),
    rejections: state.rejections.map((r) => ({ command: r.command, reason: r.reason })),
  };
}

/**
 * The invariant the negative control asserts: what the bus grants each actor.
 * Nothing any message contains can change this value.
 */
export function authoritySnapshot(state) {
  return Object.fromEntries(
    Object.values(state.actors).map((a) => [a.ref, [...a.busAuthority].sort()]),
  );
}

/**
 * Is every identity in this replayed state one the bus actually minted?
 *
 * *Replayable* was never the same claim as *internally consistent*, and nothing in the
 * product said so: a log written by a build that accepted `__proto__` as a ref replays
 * deterministically and still reports `ok`. This is the missing predicate. It is a
 * pure internal export consumed by `verify` and by `doctor` — NOT a verb, not a tool,
 * not a CLI flag, and it appears in no `inputSchema` and no `tools/list` response.
 *
 * EVERY surface the replayed state holds an identity on is walked, because a report
 * that walks only some of them quietly certifies the rest. Those surfaces are: actor
 * refs, the three parties on each message, the actor that acked a message, the three
 * parties each handoff names, and inbox owners. `ackedBy` and the handoff parties were
 * the two that were missed, and each is reachable WITHOUT forging anything the other
 * walks can see — the `message.acked` reducer writes `ackedBy` whether or not the actor
 * exists, and `work.handed-off` copies its parties into `state.handoffs` unexamined.
 *
 * Membership is a shape test AND an own-key lookup, never a denylist: an operator may
 * legitimately name a session `constructor`, and a display name is not judged here at
 * all. Only refs are.
 *
 * It reports; it never repairs. Records already on disk stay exactly as committed
 * (`event-log.mjs`: a corrupt or illegitimate log is a condition to report, never one
 * to silently rewrite). The remedy for a flagged directory is a NEW data directory.
 */
export function integrityReport(state) {
  const findings = [];
  const minted = (ref) => typeof ref === 'string' && MINTED_REF.test(ref) && hasOwnKey(state.actors, ref);

  for (const ref of Object.keys(state.actors)) {
    if (!MINTED_REF.test(ref)) {
      findings.push({ finding: 'unminted-actor-ref', subject: ref, detail: `actor ref ${ref} does not match act-NNNN, so this bus never minted it` });
    }
  }
  for (const m of Object.values(state.messages)) {
    for (const field of ['from', 'to', 'replyTo']) {
      if (!minted(m[field])) {
        findings.push({ finding: 'unminted-message-party', subject: m[field], detail: `${m.messageId}.${field} = ${m[field]} is not an actor this bus minted` });
      }
    }
    // An ack names an actor the `message.acked` reducer does not require to exist: it
    // updates `lastSeenAt` only when the actor is present and writes `ackedBy` either
    // way. So a forged ack leaves no trace in `state.actors` at all, and walking the
    // actor map — which is what every check above does — can never see it. `null` is
    // the ordinary unacked state and is not a claim about anyone.
    if (m.ackedBy !== null && !minted(m.ackedBy)) {
      findings.push({ finding: 'unminted-ack-actor', subject: m.ackedBy, detail: `${m.messageId} was acked by ${m.ackedBy}, which is not an actor this bus minted` });
    }
  }
  // `work.handed-off` pushes its three parties into `state.handoffs` verbatim, with no
  // membership test anywhere on the path. A handoff is the one record in this log that
  // asserts a transfer of work between two identities, so an address it carries that
  // the bus never minted is exactly the claim this report exists to refuse — and it is
  // reachable without forging any message party, which is why the walks above missed it.
  for (const [index, h] of state.handoffs.entries()) {
    for (const field of ['from', 'to', 'replyTo']) {
      if (!minted(h[field])) {
        findings.push({ finding: 'unminted-handoff-party', subject: h[field], detail: `handoff ${index} (${h.messageId}).${field} = ${h[field]} is not an actor this bus minted` });
      }
    }
  }
  for (const ref of Object.keys(state.inboxes)) {
    if (!minted(ref)) {
      findings.push({ finding: 'unminted-inbox-owner', subject: ref, detail: `an inbox exists for ${ref}, which is not an actor this bus minted` });
    }
  }
  return { ok: findings.length === 0, findings };
}
