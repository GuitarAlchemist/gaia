/**
 * duckdb-drain-petri-net.mjs — the rebuildable analytical projection of the net marking history.
 *
 * WHAT THIS IS FOR
 * ----------------
 * `drain-petri-net.mjs` folds the durable evidence into the marking in process; that fold is the
 * authority. This Adapter loads the nets and the replayed history into the optional
 * `@duckdb/node-api` port the other Gaia projections use, so the coordinator can ask analytical
 * questions in SQL: which place each pull request sits in, how long tokens waited where, which
 * receptivity holds each blocked transition, where resource places contend, and how many merges
 * and verified markers landed per day. The store is deleted and rebuilt inside one transaction on
 * every synchronization, so a lost file and a reordered input both converge on the same rows.
 *
 * WHAT THE STORE NEVER DOES
 * -------------------------
 * It never decides a transition. No receptivity reads it, no firing is computed in SQL, nothing
 * here writes anything but its own tables, and the pure fold does not import it. It is not a
 * token registry: a row here is a projection of a marking the core already derived from the log.
 *
 * WHAT AN ABSENT CLIENT MEANS
 * ---------------------------
 * The client is an optional dependency. Its absence is the named refusal `DuckDbClientAbsent`,
 * never an empty result.
 */

import { createRequire } from 'node:module';
import { resolve } from 'node:path';

import { instanceOf, localIdOf, revisionOf } from './drain-petri-net.mjs';

export const DRAIN_PETRI_DUCKDB_CLIENT = '@duckdb/node-api';
export const DRAIN_PETRI_DUCKDB_SCHEMA = 'gaia-drain-petri-net-projection/1';
export const DRAIN_PETRI_DUCKDB_TABLES = Object.freeze([
  'places', 'transitions', 'arcs', 'steps', 'marking_history', 'firings', 'blocked_transitions', 'projection',
]);

export const DRAIN_PETRI_DUCKDB_STATEMENTS = Object.freeze({
  createPlaces: 'CREATE TABLE IF NOT EXISTS places ('
    + ' net_id VARCHAR NOT NULL, place_id VARCHAR NOT NULL, instance VARCHAR, local_id VARCHAR NOT NULL,'
    + ' kind VARCHAR NOT NULL, capacity INTEGER NOT NULL, initial_tokens INTEGER NOT NULL,'
    + ' terminal BOOLEAN NOT NULL, label VARCHAR NOT NULL)',
  createTransitions: 'CREATE TABLE IF NOT EXISTS transitions ('
    + ' net_id VARCHAR NOT NULL, transition_id VARCHAR NOT NULL, instance VARCHAR, local_id VARCHAR NOT NULL,'
    + ' receptivity_id VARCHAR NOT NULL, refusal VARCHAR NOT NULL, priority INTEGER NOT NULL, label VARCHAR NOT NULL)',
  createArcs: 'CREATE TABLE IF NOT EXISTS arcs ('
    + ' net_id VARCHAR NOT NULL, from_id VARCHAR NOT NULL, to_id VARCHAR NOT NULL, kind VARCHAR NOT NULL,'
    + ' weight INTEGER NOT NULL)',
  createSteps: 'CREATE TABLE IF NOT EXISTS steps ('
    + ' net_id VARCHAR NOT NULL, ordinal INTEGER NOT NULL, at VARCHAR, source VARCHAR,'
    + ' marking_revision VARCHAR NOT NULL, fired_count INTEGER NOT NULL)',
  createMarkingHistory: 'CREATE TABLE IF NOT EXISTS marking_history ('
    + ' net_id VARCHAR NOT NULL, ordinal INTEGER NOT NULL, at VARCHAR, place_id VARCHAR NOT NULL,'
    + ' instance VARCHAR, local_id VARCHAR NOT NULL, tokens INTEGER NOT NULL)',
  createFirings: 'CREATE TABLE IF NOT EXISTS firings ('
    + ' net_id VARCHAR NOT NULL, ordinal INTEGER NOT NULL, at VARCHAR, fire_order INTEGER NOT NULL,'
    + ' transition_id VARCHAR NOT NULL, instance VARCHAR, local_id VARCHAR NOT NULL, receptivity_id VARCHAR NOT NULL)',
  createBlocked: 'CREATE TABLE IF NOT EXISTS blocked_transitions ('
    + ' net_id VARCHAR NOT NULL, ordinal INTEGER NOT NULL, at VARCHAR, transition_id VARCHAR NOT NULL,'
    + ' instance VARCHAR, local_id VARCHAR NOT NULL, receptivity_id VARCHAR NOT NULL, refusal VARCHAR NOT NULL,'
    + ' reason VARCHAR NOT NULL, places VARCHAR NOT NULL)',
  createProjection: 'CREATE TABLE IF NOT EXISTS projection ('
    + ' projection_schema VARCHAR NOT NULL, net_revision VARCHAR NOT NULL, marking_revision VARCHAR NOT NULL,'
    + ' client_version VARCHAR, library_version VARCHAR)',
  begin: 'BEGIN TRANSACTION',
  deletePlaces: 'DELETE FROM places',
  deleteTransitions: 'DELETE FROM transitions',
  deleteArcs: 'DELETE FROM arcs',
  deleteSteps: 'DELETE FROM steps',
  deleteMarkingHistory: 'DELETE FROM marking_history',
  deleteFirings: 'DELETE FROM firings',
  deleteBlocked: 'DELETE FROM blocked_transitions',
  deleteProjection: 'DELETE FROM projection',
  insertPlace: 'INSERT INTO places (net_id, place_id, instance, local_id, kind, capacity, initial_tokens, terminal, label)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertTransition: 'INSERT INTO transitions (net_id, transition_id, instance, local_id, receptivity_id, refusal, priority, label)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  insertArc: 'INSERT INTO arcs (net_id, from_id, to_id, kind, weight) VALUES (?, ?, ?, ?, ?)',
  insertStep: 'INSERT INTO steps (net_id, ordinal, at, source, marking_revision, fired_count) VALUES (?, ?, ?, ?, ?, ?)',
  insertMarking: 'INSERT INTO marking_history (net_id, ordinal, at, place_id, instance, local_id, tokens)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?)',
  insertFiring: 'INSERT INTO firings (net_id, ordinal, at, fire_order, transition_id, instance, local_id, receptivity_id)'
    + ' VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  insertBlocked: 'INSERT INTO blocked_transitions (net_id, ordinal, at, transition_id, instance, local_id,'
    + ' receptivity_id, refusal, reason, places) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  insertProjection: 'INSERT INTO projection (projection_schema, net_revision, marking_revision, client_version,'
    + ' library_version) VALUES (?, ?, ?, ?, ?)',
  commit: 'COMMIT',
});

/**
 * The analytical questions, as reviewable SQL constants. Each reads the store only; none fires.
 * Instants are stored as text and cast at read time, exactly as the delivery-metrics seam does.
 */
export const DRAIN_PETRI_DUCKDB_QUERIES = Object.freeze({
  // The place each instance (pull request or lane) occupies at the latest step of its net.
  currentPlacePerInstance: 'WITH latest AS (SELECT net_id, max(ordinal) AS ordinal FROM steps GROUP BY net_id)'
    + ' SELECT m.net_id, m.instance, m.local_id AS place, m.tokens, m.at'
    + ' FROM marking_history m JOIN latest USING (net_id, ordinal)'
    + ' WHERE m.instance IS NOT NULL AND m.tokens > 0'
    + ' ORDER BY m.net_id, m.instance, m.local_id',
  // Closed occupancy per (instance, place), plus the instant the current open occupancy began.
  timeInPlace: 'WITH stepped AS (SELECT net_id, ordinal, at,'
    + ' lead(at) OVER (PARTITION BY net_id ORDER BY ordinal) AS next_at FROM steps),'
    + ' occupancy AS (SELECT m.net_id, m.instance, m.local_id, m.ordinal, s.at, s.next_at'
    + ' FROM marking_history m JOIN stepped s USING (net_id, ordinal) WHERE m.tokens > 0)'
    + ' SELECT net_id, instance, local_id AS place,'
    + ' CAST(sum(CASE WHEN at IS NOT NULL AND next_at IS NOT NULL'
    + ' THEN epoch_ms(CAST(next_at AS TIMESTAMP)) - epoch_ms(CAST(at AS TIMESTAMP)) END) AS BIGINT) AS occupied_ms,'
    + ' min(CASE WHEN next_at IS NULL THEN at END) AS open_since,'
    + ' count(*) AS steps_occupied'
    + ' FROM occupancy GROUP BY net_id, instance, local_id ORDER BY net_id, instance, local_id',
  // At the latest step of each net, which receptivity (and refusal) holds which transitions.
  blockedByReceptivity: 'WITH latest AS (SELECT net_id, max(ordinal) AS ordinal FROM steps GROUP BY net_id)'
    + ' SELECT b.net_id, b.receptivity_id, b.refusal, b.reason, count(*) AS transitions,'
    + ' string_agg(b.transition_id, \',\' ORDER BY b.transition_id) AS transition_ids'
    + ' FROM blocked_transitions b JOIN latest USING (net_id, ordinal)'
    + ' GROUP BY b.net_id, b.receptivity_id, b.refusal, b.reason'
    + ' ORDER BY b.net_id, b.receptivity_id, b.refusal, b.reason',
  // Every step at which a transition waited for a resource place, per resource.
  resourceContention: 'SELECT net_id, places AS resource, count(DISTINCT ordinal) AS contended_steps,'
    + ' count(*) AS blocked_rows, string_agg(DISTINCT transition_id, \',\' ORDER BY transition_id) AS transition_ids'
    + ' FROM blocked_transitions WHERE reason = \'RESOURCE_UNAVAILABLE\''
    + ' GROUP BY net_id, places ORDER BY net_id, places',
  // Terminal firings per net, transition and day: merges, issue reconciliations, verified markers.
  throughput: 'SELECT net_id, local_id AS transition,'
    + ' CAST(date_trunc(\'day\', CAST(at AS TIMESTAMP)) AS DATE) AS day, count(*) AS firings'
    + ' FROM firings WHERE local_id IN (\'T_MERGE\', \'T_ISSUE_RECONCILED\', \'T_MARKER_VERIFIED\') AND at IS NOT NULL'
    + ' GROUP BY net_id, local_id, day ORDER BY net_id, local_id, day',
  // Bounded paths from one place to one transition over the arc table (plain SQL, no extension).
  pathsToTransition: 'WITH RECURSIVE walk(net_id, node, path, depth) AS ('
    + ' SELECT net_id, from_id, from_id, 0 FROM arcs WHERE net_id = ? AND from_id = ?'
    + ' UNION ALL'
    + ' SELECT a.net_id, a.to_id, w.path || \' -> \' || a.to_id, w.depth + 1'
    + ' FROM walk w JOIN arcs a ON a.net_id = w.net_id AND a.from_id = w.node'
    + ' WHERE a.kind <> \'INHIBITOR\' AND w.depth < ? AND position(a.to_id IN w.path) = 0)'
    + ' SELECT DISTINCT path, depth FROM walk WHERE node = ? ORDER BY depth, path',
});

export class DrainPetriDuckDbError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DrainPetriDuckDbError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new DrainPetriDuckDbError(code, message);
}

function databasePathOf(value) {
  if (typeof value !== 'string' || value.trim() !== value || value.length === 0) {
    fail('DatabasePathInvalid', 'databasePath must be explicit');
  }
  return resolve(value);
}

function clientPackageVersion() {
  try {
    return createRequire(import.meta.url)(`${DRAIN_PETRI_DUCKDB_CLIENT}/package.json`).version ?? null;
  } catch {
    return null;
  }
}

/** Open the optional analytical client. Absence is named, never degraded into an empty result. */
export async function openDrainPetriNetDuckDbClient(path, {
  readOnly = false,
  loadApi = () => import(DRAIN_PETRI_DUCKDB_CLIENT),
} = {}) {
  if (typeof loadApi !== 'function') fail('InvalidAdapter', 'loadApi must be a function');
  let api;
  try {
    api = await loadApi();
  } catch {
    fail('DuckDbClientAbsent', `optional ${DRAIN_PETRI_DUCKDB_CLIENT} is unavailable`);
  }
  const instance = await api.DuckDBInstance.create(
    databasePathOf(path), readOnly ? { access_mode: 'READ_ONLY' } : {},
  );
  const connection = await instance.connect();
  return {
    clientVersion: clientPackageVersion(),
    libraryVersion: typeof api.version === 'function' ? String(api.version()) : null,
    async run(sql, params = []) {
      if (params.length === 0) await connection.run(sql);
      else await connection.run(sql, params);
    },
    async rows(sql, params = []) {
      const reader = params.length === 0
        ? await connection.runAndReadAll(sql)
        : await connection.runAndReadAll(sql, params);
      return reader.getRowObjects();
    },
    close() {
      connection.closeSync();
      instance.closeSync();
    },
  };
}

function assertReplayedNet(entry, index) {
  const net = entry?.net;
  const run = entry?.replay;
  if (!net || typeof net !== 'object' || !Array.isArray(net.places) || !Array.isArray(net.arcs)
      || typeof net.netRevision !== 'string') {
    fail('InvalidNet', `nets[${index}].net must be a net built by buildNet`);
  }
  if (!run || typeof run !== 'object' || !Array.isArray(run.history) || run.netRevision !== net.netRevision
      || typeof run.markingRevision !== 'string') {
    fail('InvalidReplay', `nets[${index}].replay must be the replay of nets[${index}].net`);
  }
}

/**
 * Rebuild the store from the nets and their replayed histories inside one transaction and return
 * the receipt: schema, the net revision (over every net's revision, sorted), the marking revision
 * (over every net's final marking revision, sorted), the row counts, and the client version when
 * the client reports it. The store is disposable: a deleted file rebuilds to the same rows.
 */
export async function synchronizeDrainPetriNetDuckDb({
  nets, databasePath, openClient = openDrainPetriNetDuckDbClient,
} = {}) {
  if (!Array.isArray(nets) || nets.length === 0) fail('InvalidNet', 'nets must list at least one replayed net');
  nets.forEach(assertReplayedNet);
  const ids = nets.map(({ net }) => net.netId);
  if (new Set(ids).size !== ids.length) fail('InvalidNet', 'each net may be projected once');
  if (typeof openClient !== 'function') fail('InvalidAdapter', 'openClient must be a function');
  const path = databasePathOf(databasePath);
  const s = DRAIN_PETRI_DUCKDB_STATEMENTS;
  const ordered = [...nets].sort((left, right) => (left.net.netId < right.net.netId ? -1 : 1));
  const netRevision = revisionOf(Object.fromEntries(ordered.map(({ net }) => [net.netId, net.netRevision])));
  const markingRevision = revisionOf(Object.fromEntries(ordered.map(({ net, replay }) => [net.netId, replay.markingRevision])));
  const rowCounts = Object.fromEntries(DRAIN_PETRI_DUCKDB_TABLES.map((table) => [table, 0]));

  const client = await openClient(path, { readOnly: false });
  try {
    for (const statement of ['createPlaces', 'createTransitions', 'createArcs', 'createSteps',
      'createMarkingHistory', 'createFirings', 'createBlocked', 'createProjection']) {
      await client.run(s[statement]);
    }
    await client.run(s.begin);
    for (const statement of ['deletePlaces', 'deleteTransitions', 'deleteArcs', 'deleteSteps',
      'deleteMarkingHistory', 'deleteFirings', 'deleteBlocked', 'deleteProjection']) {
      await client.run(s[statement]);
    }
    for (const { net, replay } of ordered) {
      for (const place of net.places) {
        await client.run(s.insertPlace, [net.netId, place.id, instanceOf(place.id), localIdOf(place.id), place.kind,
          place.capacity, place.initial, place.terminal, place.label]);
        rowCounts.places += 1;
      }
      for (const transition of net.transitions) {
        await client.run(s.insertTransition, [net.netId, transition.id, instanceOf(transition.id), localIdOf(transition.id),
          transition.receptivity, transition.refusal, transition.priority, transition.label]);
        rowCounts.transitions += 1;
      }
      for (const arc of net.arcs) {
        await client.run(s.insertArc, [net.netId, arc.from, arc.to, arc.kind, arc.weight]);
        rowCounts.arcs += 1;
      }
      for (const entry of replay.history) {
        await client.run(s.insertStep, [net.netId, entry.ordinal, entry.at, entry.source, entry.markingRevision, entry.fired.length]);
        rowCounts.steps += 1;
        for (const place of net.places) {
          const tokens = entry.marking[place.id];
          if (tokens > 0) {
            await client.run(s.insertMarking, [net.netId, entry.ordinal, entry.at, place.id, instanceOf(place.id),
              localIdOf(place.id), tokens]);
            rowCounts.marking_history += 1;
          }
        }
        for (const [order, transitionId] of entry.fired.entries()) {
          await client.run(s.insertFiring, [net.netId, entry.ordinal, entry.at, order, transitionId, instanceOf(transitionId),
            localIdOf(transitionId), net.transitionIndex[transitionId].receptivity]);
          rowCounts.firings += 1;
        }
        for (const blocked of entry.blocked) {
          await client.run(s.insertBlocked, [net.netId, entry.ordinal, entry.at, blocked.transition, instanceOf(blocked.transition),
            localIdOf(blocked.transition), blocked.receptivity, blocked.refusal, blocked.reason, blocked.places.join(',')]);
          rowCounts.blocked_transitions += 1;
        }
      }
    }
    await client.run(s.insertProjection, [DRAIN_PETRI_DUCKDB_SCHEMA, netRevision, markingRevision,
      client.clientVersion ?? null, client.libraryVersion ?? null]);
    rowCounts.projection += 1;
    await client.run(s.commit);
  } finally {
    client.close();
  }
  return Object.freeze({
    schema: DRAIN_PETRI_DUCKDB_SCHEMA,
    databasePath: path,
    netRevision,
    markingRevision,
    nets: Object.freeze(ordered.map(({ net, replay }) => Object.freeze({
      netId: net.netId, netRevision: net.netRevision, markingRevision: replay.markingRevision, steps: replay.history.length,
    }))),
    rowCounts: Object.freeze(rowCounts),
    clientVersion: client.clientVersion ?? null,
    libraryVersion: client.libraryVersion ?? null,
    effect: 'ANALYTICAL_PROJECTION_REBUILT',
    authority: 'NONE',
  });
}

/** Read one named analytical query from an existing store, read-only. */
export async function queryDrainPetriNetDuckDb({
  databasePath, query, params = [], openClient = openDrainPetriNetDuckDbClient,
} = {}) {
  const sql = DRAIN_PETRI_DUCKDB_QUERIES[query];
  if (typeof sql !== 'string') fail('QueryUnknown', `${query} is not a named analytical query`);
  if (!Array.isArray(params)) fail('QueryParamsInvalid', 'params must be a list');
  if (typeof openClient !== 'function') fail('InvalidAdapter', 'openClient must be a function');
  const client = await openClient(databasePathOf(databasePath), { readOnly: true });
  try {
    const rows = await client.rows(sql, params);
    return Object.freeze(rows.map((row) => Object.freeze(Object.fromEntries(
      Object.entries(row).map(([key, value]) => [key, typeof value === 'bigint' ? Number(value) : value]),
    ))));
  } finally {
    client.close();
  }
}
