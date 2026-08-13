/**
 * ecosystem.mjs — the adapter verdicts, and the Codex startup-timeout margin.
 *
 * The verdicts are not this product's opinion; they are the conclusions of the
 * read-only ecosystem adapter analysis (2026-08-09), reproduced here so a shipped
 * script can refuse to do something the analysis already rejected, rather than
 * relying on a human to remember a document.
 *
 *   GA    ADAPTER_ONLY  read-only JSONL tailer, outside the GA repo. GA has no MCP
 *                       client and every artifact is already on disk under a
 *                       versioned schema. Never write GA.
 *   Hari  REJECT        Hari deleted its MCP crate from `main` and already ships a
 *                       documented stdio-JSONL streaming protocol with a reference
 *                       client. A second stdio protocol contradicts a decision the
 *                       repo already made. No integration ships here.
 *   TARS  ADAPTER_ONLY  the only repo that is already an MCP client/host; it can
 *                       mount this bus at runtime with zero repo code. Its tracked
 *                       mcp_config.json must NOT gain an absolute machine path.
 *   IX    DEFER         IX has a written no-runtime-coupling policy and already
 *                       implements this architecture internally, more rigorously.
 *                       Revisit only on the analysis's two trigger conditions.
 *
 * No repository is a `SendMessage` peer under any configuration: it addresses Claude
 * Code sessions, on macOS/Linux, in plain text. That stays at the adapter edge.
 */

import { LOCK_TIMEOUT_MS } from './event-log.mjs';

export const ECOSYSTEM_VERDICTS = Object.freeze({
  ga: 'ADAPTER_ONLY',
  hari: 'REJECT',
  tars: 'ADAPTER_ONLY',
  ix: 'DEFER',
});

export const ECOSYSTEM_REASONS = Object.freeze({
  ga: 'GA is a producer with no MCP client; the shipped adapter tails its JSONL read-only and never writes GA.',
  hari: 'Hari removed its MCP crate from main and already ships its own stdio-JSONL protocol with a reference client. Rejected: no integration ships in this plugin.',
  tars: 'TARS already mounts MCP servers at runtime via configure_mcp_server. Generate a local, uncommitted mount; never edit the tracked mcp_config.json.',
  ix: 'IX states "not runtime coupling" as policy and already implements append-only-log-as-source-of-truth with deterministic replay. Deferred pending write-serialisation + actor identity AND an explicit owner decision.',
});

/** Read a table by OWN key only. Returns undefined for every inherited key. */
const own = (table, key) => (Object.hasOwn(table, key) ? table[key] : undefined);

export class EcosystemRefusal extends Error {
  constructor(message) { super(message); this.name = 'EcosystemRefusal'; this.code = 'GAIA_ECOSYSTEM_REFUSED'; }
}

/**
 * Gate any ecosystem integration attempt against the analysis.
 * Returns the verdict for ADAPTER_ONLY targets; throws for REJECT and DEFER.
 */
export function assertIntegrationAllowed(repo) {
  const key = String(repo ?? '').trim().toLowerCase();
  // Own-key reads, for the same reason the four bus identity maps use them: an
  // inherited object key is not an identity. `ECOSYSTEM_VERDICTS['__proto__']` and
  // `['constructor']` are truthy on any plain object, so a bare read let the two
  // spellings that survive lowercasing past a gate that is documented as enforced
  // rather than merely written down — and `constructor` then serialised to a report
  // with the `verdict` and `reason` keys missing, because JSON.stringify drops
  // functions. `toString`/`valueOf`/`hasOwnProperty` were refused only incidentally,
  // by lowercasing; that was an accident, not a guard.
  const verdict = own(ECOSYSTEM_VERDICTS, key);
  if (!verdict) {
    throw new EcosystemRefusal(`unknown ecosystem target: ${repo}. Known: ${Object.keys(ECOSYSTEM_VERDICTS).join(', ')}`);
  }
  if (verdict === 'REJECT' || verdict === 'DEFER') {
    throw new EcosystemRefusal(`${key}: ${verdict} — ${own(ECOSYSTEM_REASONS, key)}`);
  }
  return { repo: key, verdict, reason: own(ECOSYSTEM_REASONS, key) };
}

// ---------------------------------------------------------------------------
// Codex startup timeout margin
// ---------------------------------------------------------------------------

/**
 * Codex's `startup_timeout_sec` must never equal the bus lock timeout.
 *
 * The server takes the log lock during startup replay. If a peer holds that lock,
 * the server legitimately waits up to LOCK_TIMEOUT_MS before failing closed with
 * exit 3. With `startup_timeout_sec` set to the same number of seconds, Codex kills
 * the server at exactly the moment it is doing the correct thing, and the operator
 * sees an ambiguous startup failure instead of the documented fail-closed code.
 *
 * The margin is: one full lock wait, doubled, plus a fixed allowance.
 *   - doubling covers the wait plus the replay and fsync that follow it;
 *   - the fixed 5s covers Windows process spawn and antivirus interception, which
 *     are the observed sources of multi-second startup latency on this host.
 * At the 10s default that is 25s, comfortably distinct from 10.
 */
export const STARTUP_TIMEOUT_MULTIPLIER = 2;
export const STARTUP_TIMEOUT_FIXED_MARGIN_SEC = 5;

export function safeStartupTimeoutSec(lockTimeoutMs = LOCK_TIMEOUT_MS) {
  const lockSec = Math.max(1, Math.ceil(Number(lockTimeoutMs) / 1000));
  return lockSec * STARTUP_TIMEOUT_MULTIPLIER + STARTUP_TIMEOUT_FIXED_MARGIN_SEC;
}

/** True when a proposed startup timeout leaves a real margin over the lock wait. */
export function startupTimeoutIsSafe(startupSec, lockTimeoutMs = LOCK_TIMEOUT_MS) {
  const lockSec = Math.max(1, Math.ceil(Number(lockTimeoutMs) / 1000));
  return Number(startupSec) >= lockSec + STARTUP_TIMEOUT_FIXED_MARGIN_SEC;
}
