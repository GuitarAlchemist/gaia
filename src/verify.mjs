/**
 * verify.mjs — the product's own acceptance checks, runnable by a user.
 *
 * `gaia-interagent verify` is read-only. It spawns the bundled server, reads files,
 * and computes; it writes nothing to any log, never to the evidence it inspects, and
 * never to any client configuration.
 *
 * The evidence checks carry a NEGATIVE CONTROL. A verifier that says "yes" to every
 * log it is shown proves nothing about the log it was pointed at, so every run also
 * feeds the same checks three logs that MUST fail: a synthetic single-actor log, a
 * tampered copy with a handoff carrying authority, and a tampered copy with a widened
 * `busAuthority`. All are built in memory. None touches the file on disk.
 *
 * WHAT THIS PROVES, AND WHAT IT DOES NOT
 * -------------------------------------
 * These checks attest the SHAPE of an event log: that it replays, that its addresses
 * are refs this bus minted, that its correlation ids are inside the issuer's exact
 * range, that a multi-party correlated exchange with an ack and a handoff is present,
 * and that the authority invariants are intact. They attest NOTHING about PROVENANCE.
 * Nothing in the event schema binds a record to a producing process, so a log
 * generated entirely by this product's own CLI — with no Claude and no Codex process
 * anywhere — satisfies every check here. `evidenceOk: true` is therefore evidence that
 * a log is well-formed and untampered. It is NOT, and must never be read as, proof
 * that two real clients exchanged messages on this bus.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  replay, snapshot, integrityReport, correlationOrdinal, correlationHealthReport,
  BUS_VERBS, NEVER_GRANTABLE, BUS_AUTHORITY,
} from './bus-core.mjs';
import { readEventFile, readEventsConsistent, parseEventLog } from './event-log.mjs';
import { withBusClient } from './mcp-client.mjs';
import { renderCodexConfig, renderClaudeMcpConfig, bundledServerPath, pluginRoot } from './templates.mjs';
import { safeStartupTimeoutSec, startupTimeoutIsSafe, ECOSYSTEM_VERDICTS } from './ecosystem.mjs';
import { DEFAULT_MAX_LIVE_LANES, resolveLaneLimit, LaneLimitError } from './lanes.mjs';

const here = dirname(fileURLToPath(import.meta.url));

/** Source trees scanned for forbidden transport primitives. */
const SCANNED_DIRS = ['src', 'scripts'];

/**
 * Primitives that would mean this is no longer a stdio-only, local product.
 * `spawn` is deliberately absent: spawning the bundled stdio server IS the transport.
 */
const FORBIDDEN_TRANSPORT = [
  { pattern: /\bcreateServer\s*\(/, why: 'network listener' },
  { pattern: /\bnode:(net|http|https|dgram|tls)\b/, why: 'network module import' },
  { pattern: /\bnew\s+WebSocket\b/, why: 'websocket client' },
  { pattern: /\bshell\s*:\s*true\b/, why: 'shell-command transport' },
  { pattern: /\bexecSync\s*\(/, why: 'shell-command transport' },
];

function sourceFiles(root) {
  const found = [];
  for (const dir of SCANNED_DIRS) {
    const full = join(root, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)) {
      if (name.endsWith('.mjs')) found.push(join(full, name));
    }
  }
  return found;
}

const check = (name, ok, detail) => ({ name, ok: Boolean(ok), detail });

// ---------------------------------------------------------------------------
// evidence
// ---------------------------------------------------------------------------

/**
 * Every evidence check's name, spelled once, in one place.
 *
 * A check and the gate that reads it cannot drift apart under a rename this way — the
 * previous rename of one of these was already visible in the emitted payload, and a
 * gate matching a stale string would fail open in silence.
 */
export const CORRELATION_HEALTH_CHECK = 'the correlation issuer still has room to mint';
export const IDENTITY_INTEGRITY_CHECK = 'every address in the log belongs to an actor this bus minted';
const REPLAYABLE_CHECK = 'replayable';
const DETERMINISTIC_CHECK = 'deterministic replay';
const HANDOFF_AUTHORITY_CHECK = 'no handoff transferred authority';
const GRANTED_PRIVILEGE_CHECK = 'no message was granted a privileged authority';
const UNTRUSTED_BODY_CHECK = 'every body is labelled untrusted-text';
const CORRELATION_RANGE_CHECK = 'every correlation id is inside the issuer range';
const FROZEN_AUTHORITY_CHECK = 'every actor.registered carries the frozen busAuthority';
const THREE_ACTORS_CHECK = 'at least three actors';
const ACTOR_KINDS_CHECK = 'more than one actor kind';
const WIDE_THREAD_CHECK = 'a correlated thread of three or more messages';
const ACK_PRESENT_CHECK = 'at least one acknowledgement';
const HANDOFF_PRESENT_CHECK = 'at least one handoff';

/**
 * The two classes of evidence check, and the one test that decides membership:
 * *is this check legitimately false on a correct, empty workspace?*
 *
 * "Is this log a genuine multi-party exchange" is. A fresh bus is not one, and gating
 * on it would report a correct empty bus as a product failure and train an operator to
 * ignore the command. Those five checks are EVIDENCE RICHNESS, and they are advisory
 * unless the caller claims a log *is* evidence.
 *
 * Nothing else is. "Does this log replay", "does it replay to the same state twice",
 * "did a handoff transfer authority", "was a never-grantable privilege granted", "is
 * every body still labelled untrusted-text", "does every address belong to an actor
 * this bus minted", "is every correlation id inside the issuer range", "can this
 * directory still mint one", and "does every registration carry the frozen
 * busAuthority" are all vacuously or genuinely TRUE on a fresh workspace, and a log
 * that fails any of them carries a defect on every run. Those are AUTHORITY AND
 * INTEGRITY checks and they gate always.
 *
 * That distinction is the whole of this fix. Before it, the gating class held two names
 * and everything else — including every authority invariant this product exists to
 * assert — was bucketed as "evidence richness" and shipped advisory. A default `verify`
 * therefore exited 0 with `ok: true` on a log whose own red check said a handoff had
 * transferred `approve`, or that a registration claimed an authority the frozen constant
 * does not contain. This product argues in its own `proves` string that a CI reader keys
 * on the emitted field and never opens the README; that reader keys on `ok`.
 *
 * The gate is computed by EXCLUSION from the richness list, not by membership of the
 * authority list, so the failure polarity is right: a check added or renamed later gates
 * by default rather than silently joining the advisory bucket. `AUTHORITY_INTEGRITY_CHECKS`
 * is the published enumeration of what that leaves gating, and a test partitions a real
 * report against both lists so the enumeration cannot drift away from the behaviour.
 */
export const EVIDENCE_RICHNESS_CHECKS = Object.freeze([
  THREE_ACTORS_CHECK, ACTOR_KINDS_CHECK, WIDE_THREAD_CHECK, ACK_PRESENT_CHECK, HANDOFF_PRESENT_CHECK,
]);

export const AUTHORITY_INTEGRITY_CHECKS = Object.freeze([
  REPLAYABLE_CHECK, DETERMINISTIC_CHECK, HANDOFF_AUTHORITY_CHECK, GRANTED_PRIVILEGE_CHECK,
  UNTRUSTED_BODY_CHECK, IDENTITY_INTEGRITY_CHECK, CORRELATION_RANGE_CHECK,
  CORRELATION_HEALTH_CHECK, FROZEN_AUTHORITY_CHECK,
]);

/**
 * The two checks whose ABSENCE from a report is itself a failure.
 *
 * These were promoted first, and each names a condition `doctor` also gates on
 * (`scripts/gaia-interagent.mjs`). Selecting a check by name fails OPEN if the name ever
 * drifts, and a gate that silently gates on nothing is worse than no gate — so for these
 * two the lookup is by name and a miss is a red check rather than a skipped one. The
 * rest of the authority class gates by exclusion and needs no such lookup: a name that
 * drifts is still not in the richness list, so it still gates.
 */
export const ALWAYS_GATING_CHECKS = Object.freeze([CORRELATION_HEALTH_CHECK, IDENTITY_INTEGRITY_CHECK]);

/**
 * Does this event log show a genuine multi-party, correlated exchange with the
 * authority invariant intact? Pure: takes events, returns a report.
 */
export function evidenceReport(events) {
  let state;
  try {
    state = replay(events);
  } catch (err) {
    return { ok: false, checks: [check('replayable', false, `${err.name}: ${err.message}`)] };
  }

  const actors = Object.values(state.actors);
  const kinds = new Set(actors.map((a) => a.kind));
  const messages = Object.values(state.messages);

  const byCorrelation = new Map();
  for (const m of messages) byCorrelation.set(m.correlationId, (byCorrelation.get(m.correlationId) ?? 0) + 1);
  const widestThread = [...byCorrelation.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];

  const acked = messages.filter((m) => m.ackedBy !== null);
  const badHandoff = state.handoffs.find((h) => !Array.isArray(h.authorityTransferred) || h.authorityTransferred.length > 0);
  const grantedPrivilege = messages.find((m) => (m.authority?.granted ?? []).some((g) => NEVER_GRANTABLE.includes(g)));
  const untrusted = messages.every((m) => m.trust === 'untrusted-text');

  // Provenance-of-identity, not provenance-of-producer: every address in the log must
  // be a ref this bus minted. A log carrying `from: "constructor"` used to score 10/10
  // here and pass both controls.
  const integrity = integrityReport(state);

  // The correlation grammar. A numeric `cor-` id the issuer could not have emitted is
  // the fingerprint of the counter-overflow defect, and the thread it produces is
  // exactly what the "three or more messages" check below would otherwise certify.
  const overflowCorrelation = messages.find((m) => /^cor-\d+$/.test(m.correlationId)
    && correlationOrdinal(m.correlationId) === null);

  // Inside the type range is not the same claim as having runway left. An issuer
  // within one claim window of the ceiling is dead or one accepted claim from it:
  // every later send/handoff that omits `correlationId` is then refused, forever, for
  // that directory. Such a log replays perfectly and passes every other check here,
  // which is why it used to be certified. Measured on the issuer, the same quantity
  // admission bounds — a log built only from claims this bus accepted never trips it.
  const health = correlationHealthReport(state);

  // Read from the RAW events, never from replayed state: a later clean re-registration
  // of the same ref would otherwise launder an earlier forged record out of existence.
  const expectedAuthority = JSON.stringify([...BUS_AUTHORITY].sort());
  const registrations = events.filter((e) => e && e.type === 'actor.registered');
  const forgedAuthority = registrations.find((e) => !Array.isArray(e.busAuthority)
    || JSON.stringify([...e.busAuthority].sort()) !== expectedAuthority);

  const checks = [
    check(REPLAYABLE_CHECK, true, `${events.length} events`),
    check(DETERMINISTIC_CHECK, JSON.stringify(snapshot(replay(events))) === JSON.stringify(snapshot(state)),
      'replay(events) == replay(events)'),
    check(THREE_ACTORS_CHECK, actors.length >= 3, `${actors.length} actors`),
    check(ACTOR_KINDS_CHECK, kinds.size >= 2, `kinds: ${[...kinds].join(', ') || 'none'}`),
    check(WIDE_THREAD_CHECK, widestThread[1] >= 3,
      `widest thread ${widestThread[0] ?? 'none'} has ${widestThread[1]} messages`),
    check(ACK_PRESENT_CHECK, acked.length >= 1, `${acked.length} acked`),
    check(HANDOFF_PRESENT_CHECK, state.handoffs.length >= 1, `${state.handoffs.length} handoffs`),
    check(HANDOFF_AUTHORITY_CHECK, !badHandoff,
      badHandoff ? `handoff ${badHandoff.messageId} transferred ${JSON.stringify(badHandoff.authorityTransferred)}` : 'authorityTransferred is [] on every handoff'),
    check(GRANTED_PRIVILEGE_CHECK, !grantedPrivilege,
      grantedPrivilege ? `${grantedPrivilege.messageId} granted ${JSON.stringify(grantedPrivilege.authority.granted)}` : 'grants stay inside the allowlist'),
    check(UNTRUSTED_BODY_CHECK, untrusted, `${messages.length} messages`),
    check(IDENTITY_INTEGRITY_CHECK, integrity.ok,
      integrity.ok ? `${Object.keys(state.actors).length} actors, all minted`
        : integrity.findings.map((f) => `${f.finding}: ${f.subject}`).join('; ')),
    check(CORRELATION_RANGE_CHECK, !overflowCorrelation,
      overflowCorrelation
        ? `${overflowCorrelation.messageId} claims ${overflowCorrelation.correlationId}, which the issuer cannot count past`
        : `${byCorrelation.size} threads, all within range`),
    check(CORRELATION_HEALTH_CHECK, health.ok,
      health.findings.length > 0
        ? `${health.findings[0].messageId} claims ${health.findings[0].correlationId}, leaving this log's `
          + `issuer at ${health.issuerAt} with ${health.headroom} of its sequence left`
        : health.exhausted
          ? `the issuer is exhausted at ${health.issuerAt}: no further correlation id can be auto-issued`
          : health.nearExhausted
            ? `the issuer is at ${health.issuerAt} with only ${health.headroom} ids left, inside the last claim window`
            : `the issuer is at ${health.issuerAt} with ${health.headroom} ids of runway left`),
    check(FROZEN_AUTHORITY_CHECK, !forgedAuthority,
      forgedAuthority
        ? `${forgedAuthority.ref} claims ${JSON.stringify(forgedAuthority.busAuthority)} instead of ${expectedAuthority}`
        : `${registrations.length} registrations, all ${expectedAuthority}`),
  ];

  return { ok: checks.every((c) => c.ok), checks };
}

/** A synthetic log that must NOT pass: one actor, no thread, no handoff. */
export function syntheticNegativeLog() {
  return [
    {
      type: 'actor.registered', at: '2026-01-01T00:00:00.000Z', ref: 'act-0001', name: 'solo',
      isNew: true, kind: 'worker', declaredCapabilities: [], busAuthority: ['send', 'receive', 'ack', 'heartbeat', 'handoff'],
    },
    { type: 'actor.heartbeat', at: '2026-01-01T00:00:01.000Z', actorId: 'act-0001', note: null },
  ];
}

/**
 * A tampered copy of a real log: the authority invariant is broken in memory only.
 * The caller's file is never opened for writing.
 */
export function tamperedCopy(events) {
  return events.map((e) => {
    if (e.type === 'work.handed-off') return { ...e, authorityTransferred: ['approve'] };
    return e;
  });
}

/**
 * A tampered copy that widens the bus authority every registration carries.
 *
 * The live bus can never write this — `busAuthority: [...BUS_AUTHORITY]` is a frozen
 * constant at registration — so this is an evidence-integrity control, not a live
 * escalation. Detecting tampering in a log you did not produce is the entire job of
 * the evidence gate, and this is the field it advertises as its invariant.
 */
export function busAuthorityTamperedCopy(events) {
  return events.map((e) => (e && e.type === 'actor.registered'
    ? { ...e, busAuthority: [...(e.busAuthority ?? []), 'approve', 'admin', 'deploy'] }
    : e));
}

/**
 * Run the evidence checks plus all three negative controls.
 * `ok` is true only when the real log passes AND every control fails.
 */
export function evidenceWithNegativeControls(events) {
  const positive = evidenceReport(events);
  const synthetic = evidenceReport(syntheticNegativeLog());
  const hasHandoff = events.some((e) => e.type === 'work.handed-off');
  const tampered = hasHandoff ? evidenceReport(tamperedCopy(events)) : null;
  const hasRegistration = events.some((e) => e && e.type === 'actor.registered');
  const authorityTampered = hasRegistration ? evidenceReport(busAuthorityTamperedCopy(events)) : null;

  const controls = [
    check('negative control: a synthetic single-actor log is rejected', synthetic.ok === false,
      synthetic.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || 'UNEXPECTEDLY PASSED'),
  ];
  if (authorityTampered) {
    controls.push(check('negative control: a widened busAuthority is rejected', authorityTampered.ok === false,
      authorityTampered.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || 'UNEXPECTEDLY PASSED'));
  } else {
    controls.push(check('negative control: busAuthority control not applicable', true,
      'the inspected log contains no registration to tamper with'));
  }
  if (tampered) {
    controls.push(check('negative control: a tampered handoff is rejected', tampered.ok === false,
      tampered.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || 'UNEXPECTEDLY PASSED'));
  } else {
    controls.push(check('negative control: tampered-handoff control not applicable', true,
      'the inspected log contains no handoff to tamper with'));
  }

  return {
    ok: positive.ok && controls.every((c) => c.ok),
    // Carried in the payload, not only in the docs, because `evidenceOk` is the exact
    // value that gets over-read — and a CI reader keying on it never opens the README.
    proves: 'SHAPE ONLY. These checks attest that the log replays, that its addresses are refs this bus '
      + 'minted, that its correlation ids are inside the issuer range and that the issuer still has '
      + 'runway to mint, that a multi-party correlated '
      + 'exchange with an ack and a handoff is present, and that the authority invariants are intact. '
      + 'They do NOT attest provenance: nothing in the event schema binds a record to a producing '
      + 'process, so a log this product generated by itself satisfies every check. evidenceOk:true is '
      + 'never proof that a real Claude and a real Codex client exchanged messages on this bus.',
    positive,
    controls,
  };
}

// ---------------------------------------------------------------------------
// product checks
// ---------------------------------------------------------------------------

/** Static: the shipped sources open no listener and use no shell transport. */
export function transportChecks(root = pluginRoot()) {
  const hits = [];
  for (const file of sourceFiles(root)) {
    const text = readFileSync(file, 'utf8');
    for (const { pattern, why } of FORBIDDEN_TRANSPORT) {
      if (pattern.test(text)) hits.push(`${file}: ${why}`);
    }
  }
  return check('no network listener, no shell-command transport in shipped sources', hits.length === 0,
    hits.length ? hits.join('; ') : `${sourceFiles(root).length} source files scanned`);
}

/**
 * Static: the distributed templates leak no absolute developer path.
 * Rendering with placeholder inputs must produce output containing neither a Windows
 * drive-letter path nor a POSIX home path that the plugin did not receive as input.
 */
export function templateChecks() {
  const rendered = [
    renderCodexConfig({ serverPath: '<SERVER>', dataDir: '<DATA>' }),
    renderClaudeMcpConfig({ serverPath: '<SERVER>', dataDir: '<DATA>' }),
  ].join('\n');
  const absolute = rendered.match(/[A-Za-z]:\\[^\s'"]+|\/(?:home|Users)\/[^\s'"]+/g) ?? [];
  return check('generated-config templates contain no absolute developer path', absolute.length === 0,
    absolute.length ? absolute.join('; ') : 'placeholders only');
}

/** Static: the plugin manifest is present, self-consistent, and names the bundled server. */
export function manifestChecks(root = pluginRoot()) {
  const checks = [];
  const manifestPath = join(root, '.codex-plugin', 'plugin.json');
  const mcpPath = join(root, '.mcp.json');

  if (!existsSync(manifestPath)) return [check('plugin manifest present', false, manifestPath)];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  checks.push(check('plugin manifest parses', true, manifestPath));
  checks.push(check('manifest name matches directory', manifest.name === 'gaia-interagent', manifest.name));
  checks.push(check('manifest declares ./.mcp.json', manifest.mcpServers === './.mcp.json', String(manifest.mcpServers)));
  checks.push(check('.mcp.json present', existsSync(mcpPath), mcpPath));

  if (existsSync(mcpPath)) {
    const mcp = JSON.parse(readFileSync(mcpPath, 'utf8'));
    const entry = mcp.mcpServers?.['gaia-interagent'];
    checks.push(check('.mcp.json declares the gaia-interagent stdio server', Boolean(entry), JSON.stringify(entry ?? null)));
    const argsText = JSON.stringify(entry?.args ?? []);
    checks.push(check('.mcp.json points at the bundled server', argsText.includes('mcp-server.mjs'), argsText));
    checks.push(check('.mcp.json has no absolute developer path',
      !/[A-Za-z]:\\\\|\/Users\/|\/home\//.test(argsText + JSON.stringify(entry?.env ?? {})), argsText));
  }
  return checks;
}

/** Live: the bundled server exposes exactly six non-privileged verbs. */
export async function surfaceChecks(dataDir) {
  return withBusClient(dataDir, async (client) => {
    const { tools } = await client.request('tools/list', {});
    const names = tools.map((t) => t.name).sort();
    const expected = [...BUS_VERBS].sort();
    const privileged = names.filter((n) => NEVER_GRANTABLE.some((p) => n.toLowerCase().includes(p)));
    return [
      check('the bundled server exposes exactly the six bus verbs',
        JSON.stringify(names) === JSON.stringify(expected), names.join(', ')),
      check('no privileged verb is exposed', privileged.length === 0, privileged.join(', ') || 'none'),
    ];
  });
}

/** Policy: the lane default is 4 and >4 is refused without the experimental flag. */
export function laneChecks() {
  const dflt = resolveLaneLimit({});
  let refused = false;
  let refusal = '';
  try {
    resolveLaneLimit({ requested: 6 });
  } catch (err) {
    refused = err instanceof LaneLimitError;
    refusal = err.message;
  }
  const experimental = resolveLaneLimit({ requested: 6, experimental: true });
  return [
    check('default live-lane maximum is 4', dflt.limit === DEFAULT_MAX_LIVE_LANES, String(dflt.limit)),
    check('a request for 6 lanes is refused by default', refused, refusal.slice(0, 120)),
    check('6 lanes is allowed only as explicitly experimental', experimental.experimental === true, experimental.note),
  ];
}

/** Policy: the generated Codex startup timeout leaves a margin over the lock wait. */
export function startupTimeoutChecks(lockTimeoutMs) {
  const startup = safeStartupTimeoutSec(lockTimeoutMs);
  const lockSec = Math.ceil(lockTimeoutMs / 1000);
  return [
    check('generated startup_timeout_sec never equals the lock timeout', startup !== lockSec,
      `startup ${startup}s vs lock ${lockSec}s`),
    check('generated startup_timeout_sec leaves the documented margin', startupTimeoutIsSafe(startup, lockTimeoutMs),
      `${startup}s >= ${lockSec}s + 5s`),
  ];
}

/** Policy: the shipped ecosystem verdicts match the adapter analysis. */
export function ecosystemChecks() {
  return [
    check('GA is ADAPTER_ONLY', ECOSYSTEM_VERDICTS.ga === 'ADAPTER_ONLY', ECOSYSTEM_VERDICTS.ga),
    check('Hari is REJECTed', ECOSYSTEM_VERDICTS.hari === 'REJECT', ECOSYSTEM_VERDICTS.hari),
    check('TARS is ADAPTER_ONLY', ECOSYSTEM_VERDICTS.tars === 'ADAPTER_ONLY', ECOSYSTEM_VERDICTS.tars),
    check('IX is DEFERred', ECOSYSTEM_VERDICTS.ix === 'DEFER', ECOSYSTEM_VERDICTS.ix),
  ];
}

// ---------------------------------------------------------------------------

/**
 * The whole verification, as one read-only report.
 *
 * `evidencePath`, when given, is read with a read-only file read and is never
 * written, locked, copied, or adopted as this bus's log.
 */
export async function runVerification({ dataDir, evidencePath = null, requireEvidence = null, lockTimeoutMs, root = pluginRoot() } = {}) {
  // Pointing verify at a specific log is a claim that the log IS evidence, so the
  // richness checks then gate the result too. Verifying a fresh workspace is not: an
  // empty bus is a correct empty bus, and reporting it as a product failure would
  // train an operator to ignore this command. This flag moves ONLY the richness class;
  // the authority and integrity checks gate in both regimes, and so do the negative
  // controls — a verifier that cannot fail proves nothing.
  const gateOnEvidence = requireEvidence ?? Boolean(evidencePath);
  const sections = [];

  sections.push({ section: 'manifest', checks: manifestChecks(root) });
  sections.push({ section: 'transport', checks: [transportChecks(root)] });
  sections.push({ section: 'templates', checks: [templateChecks()] });
  sections.push({ section: 'lanes', checks: laneChecks() });
  sections.push({ section: 'startup-timeout', checks: startupTimeoutChecks(lockTimeoutMs) });
  sections.push({ section: 'ecosystem', checks: ecosystemChecks() });

  try {
    sections.push({ section: 'tool-surface', checks: await surfaceChecks(dataDir) });
  } catch (err) {
    sections.push({ section: 'tool-surface', checks: [check('the bundled server answered tools/list', false, `${err.name}: ${err.message}`)] });
  }

  let evidence = null;
  let evidenceOk = null;
  let gatingChecks = sections.flatMap((s) => s.checks);

  try {
    const events = evidencePath ? readEventFile(resolve(evidencePath)) : readEventsConsistent();
    const withControls = evidenceWithNegativeControls(events);
    evidence = {
      source: evidencePath ? resolve(evidencePath) : 'this workspace data directory',
      events: events.length,
      gatesResult: gateOnEvidence,
      ...withControls,
    };
    evidenceOk = withControls.positive.ok;
    sections.push({
      section: 'evidence',
      gatesResult: gateOnEvidence,
      checks: [...withControls.positive.checks, ...withControls.controls],
    });
    // Controls always gate. Evidence RICHNESS gates only when the caller claimed the log
    // is evidence. Everything else — the authority and integrity class — gates on every
    // run, claimed evidence or not. The membership test is spelled out where the two
    // classes are declared: is this check legitimately false on a correct, empty
    // workspace? Richness is; a dead correlation issuer, a forged address, a handoff
    // that transferred authority and a registration claiming an authority the frozen
    // constant does not contain are not.
    //
    // Computed by EXCLUSION from the richness list rather than by membership of the
    // authority list, so a check added or renamed later gates by default instead of
    // silently becoming advisory. The polarity matters: an over-gate reports a correct
    // empty workspace as a failure and is caught the first time anyone runs `verify` on
    // one, while an under-gate is exactly the silence this fix removes.
    //
    // `ALWAYS_GATING_CHECKS` is kept on top of that as a by-name lookup, because for
    // those two the ABSENCE of the check is itself a defect: selecting by name fails
    // OPEN if the name drifts, and a gate that silently gates on nothing is worse than
    // no gate. Absence is reachable without a rename — a log that parses but does not
    // replay yields the `replayable` check alone. (A log that cannot be READ at all
    // never reaches here: that is the `evidence log readable` check below, which has
    // always gated, and which is why `verify` exits 1 where `doctor` exits 3 on a
    // corrupt log. That difference predates this change and is not touched by it.)
    const alwaysGating = ALWAYS_GATING_CHECKS.map((name) => withControls.positive.checks.find((c) => c.name === name)
      ?? check(name, false, `the evidence report carries no "${name}" check, so this directory could not be `
        + 'read at all on that question; failing closed rather than gating on an empty set'));
    const authorityAndIntegrity = withControls.positive.checks.filter((c) => !EVIDENCE_RICHNESS_CHECKS.includes(c.name));
    gatingChecks = [...gatingChecks, ...withControls.controls,
      ...(gateOnEvidence ? withControls.positive.checks : [...authorityAndIntegrity, ...alwaysGating])];
  } catch (err) {
    const readable = check('evidence log readable', false, `${err.name}: ${err.message}`);
    sections.push({ section: 'evidence', gatesResult: gateOnEvidence, checks: [readable] });
    gatingChecks = [...gatingChecks, readable];
  }

  const allChecks = sections.flatMap((s) => s.checks);
  return {
    ok: gatingChecks.every((c) => c.ok),
    evidenceOk,
    evidenceGatesResult: gateOnEvidence,
    passed: allChecks.filter((c) => c.ok).length,
    failed: allChecks.filter((c) => !c.ok).length,
    sections,
    evidence,
    readOnly: true,
  };
}

/** Exported for tests that want to build a log without touching disk. */
export { parseEventLog, here as VERIFY_MODULE_DIR };
