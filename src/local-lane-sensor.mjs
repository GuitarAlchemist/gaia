/**
 * local-lane-sensor.mjs — structured wmux agent metadata to one sealed local lane observation.
 *
 * This is the whole sensor, and it is a pure function. It holds no clock, opens no file, spawns
 * no process, calls no provider and mutates nothing; the process boundary that actually invokes
 * `wmux agent list` lives in `scripts/local-lane-sensor.mjs` and hands its parsed output here.
 *
 * WHAT IT READS, AND WHY A SEVENTH FIELD IS UNREACHABLE
 * ----------------------------------------------------
 * Six fields, by name, one at a time. A live `wmux agent list` record also carries `cmd` — a full
 * command line with local absolute paths — plus `pid`, `spawnTime` and `exitCode`, and a future
 * wmux could add a screen, a prompt or a transcript. None of them can reach an observation,
 * because this function never spreads a record and never iterates its keys: it names what it
 * wants and builds a new object. A negative control proves the property rather than asserting it,
 * but the property is a construction either way.
 *
 * `spawnTime` is available and stays unread on purpose. The moment a lane elapsed time is
 * published, something will divide it by something, and R0 measures liveness only.
 *
 * WHAT IT REFUSES, AND WHAT IT WITHHOLDS
 * --------------------------------------
 * A malformed identity refuses the whole observation, because an identity is the address an
 * operator uses to find the pane and a wrong one is worse than none. A label is a name rather
 * than an address, so an unreadable one is withheld under its own `labelState` and its lane is
 * still reported — dropping the lane would under-report exactly the lanes the operator is hunting
 * for, and rewriting the label would rename someone's work.
 *
 * A status outside the exact map is `UNKNOWN`, never live. There is no prefix match, no case
 * folding and no fuzzy match, so `Running`, `running-ish` and a status invented three wmux
 * releases from now all fail the same closed way.
 */

import {
  LOCAL_LANE_LIFECYCLES, LOCAL_LANE_LABEL_STATES, UNKNOWN_IDENTITY,
  isSafeLaneIdentity, isSafeLaneLabel, laneOrderKey, sealLocalLaneObservation,
} from './local-lane-observation.mjs';

/** The exact metadata fields this sensor reads. It reads these and cannot reach a seventh. */
export const WMUX_LANE_METADATA_FIELDS = Object.freeze([
  'workspaceId', 'paneId', 'surfaceId', 'agentId', 'label', 'status',
]);

/** Exact-equality status map. Null-prototype, so `constructor` is not a wmux status. */
export const WMUX_STATUS_LIFECYCLE = Object.freeze(Object.assign(Object.create(null), {
  running: 'RUNNING',
  exited: 'EXITED',
}));

export class LocalLaneSensorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LocalLaneSensorError';
    this.code = code;
  }
}

/**
 * Absent is `UNKNOWN`; present and readable is verbatim; present and malformed is a refusal.
 *
 * The middle case is the one worth stating: a bounded identity that wmux actually emits passes
 * through untouched, so the value an operator reads on the page is the value they can paste into
 * `wmux agent status`.
 */
function identity(record, field) {
  const value = record[field];
  if (value === undefined || value === null) return UNKNOWN_IDENTITY;
  if (!isSafeLaneIdentity(value)) {
    throw new LocalLaneSensorError(
      'LaneIdentityUnreadable',
      `a wmux ${field} of ${JSON.stringify(value)} is not a bounded identity;`
      + ' refusing the observation rather than publishing an address that does not resolve',
    );
  }
  return value;
}

/**
 * Three closed answers about a name, never a fourth and never a silent drop.
 *
 * The unsafe branch is the security-relevant one: a label may be chosen by whoever spawned the
 * pane, so it is the one field an observed process can influence. It is withheld rather than
 * cleaned, because cleaning would publish a transformation of attacker-shaped input instead of
 * refusing to publish it.
 */
function name(record) {
  const value = record.label;
  if (value === undefined || value === null) return { label: null, labelState: 'ABSENT' };
  if (typeof value !== 'string') {
    throw new LocalLaneSensorError(
      'LaneLabelUnreadable', 'a wmux label must be a string or absent',
    );
  }
  return isSafeLaneLabel(value)
    ? { label: value, labelState: 'OBSERVED' }
    : { label: null, labelState: 'WITHHELD_UNSAFE' };
}

/** Exact equality only. Everything else is `UNKNOWN`, which is never live. */
function lifecycle(record) {
  const status = record.status;
  const mapped = typeof status === 'string' ? WMUX_STATUS_LIFECYCLE[status] : undefined;
  return mapped === undefined ? 'UNKNOWN' : mapped;
}

/**
 * Observe every lane in one already-parsed `wmux agent list` payload.
 *
 * `agents` is the structured array the CLI emits. Silence is not an empty result: anything that
 * is not an exact array of objects is a refusal, because an observation that quietly reports zero
 * lanes is indistinguishable from the operator failure this sensor exists to fix.
 */
export function observeLocalLanes({ agents, observedAt } = {}) {
  if (!Array.isArray(agents)) {
    throw new LocalLaneSensorError(
      'AgentsUnreadable',
      "structured wmux agent metadata is required: an exact 'agents' array, never terminal text",
    );
  }
  const lanes = agents.map((record) => {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      throw new LocalLaneSensorError(
        'AgentsUnreadable', 'each wmux agent record must be a structured object',
      );
    }
    // Six named reads. Nothing here spreads the record or walks its keys, so `cmd`, `pid`,
    // `spawnTime`, a screen, a prompt or a transcript cannot travel with the lane.
    return {
      workspaceId: identity(record, 'workspaceId'),
      paneId: identity(record, 'paneId'),
      surfaceId: identity(record, 'surfaceId'),
      agentId: identity(record, 'agentId'),
      ...name(record),
      lifecycle: lifecycle(record),
    };
  });

  const seen = new Set();
  for (const lane of lanes) {
    const key = laneOrderKey(lane);
    if (seen.has(key)) {
      throw new LocalLaneSensorError(
        'DuplicateLaneIdentity',
        `wmux reported the lane ${key} twice; refusing rather than counting one lane as two`,
      );
    }
    seen.add(key);
  }
  return sealLocalLaneObservation({ observedAt, lanes });
}

/** Re-exported so a reader of this module sees the vocabularies it maps onto, in one place. */
export { LOCAL_LANE_LIFECYCLES, LOCAL_LANE_LABEL_STATES };
