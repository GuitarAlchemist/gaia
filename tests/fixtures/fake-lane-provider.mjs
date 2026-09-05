/**
 * fake-lane-provider.mjs — a deterministic lane provider behind the bootstrap port.
 *
 * This fixture is the whole reason the R0 contract suite needs no wmux, no Claude, no Codex, no
 * Docker and no live terminal at all. It is a small world of panes, surfaces and agents with
 * counter-derived identities, an explicit clock, and a journal of every operation the module
 * asked for — so a test can assert ORDER (topology before any spawn) as directly as it asserts
 * outcomes.
 *
 * Two properties are load-bearing and deliberately hostile to the module under test:
 *
 * 1. The world always contains one unrelated workspace, `Music`, with a live pane, surface and
 *    agent that carry no operation marker. Every mutating operation refuses a target it did not
 *    create for a generation, by throwing `FIXTURE_FORBIDDEN_TARGET`. A compensation path that
 *    enumerates a workspace instead of iterating its own recorded plan therefore fails loudly
 *    rather than quietly deleting somebody else's work.
 * 2. Faults are named, one per reproduced failure in issue #93, and are injected structurally.
 *    None of them is a string a caller could parse: there is no screen, no prompt, no banner and
 *    no command line in this fixture, so a module that tried to scrape one would find nothing.
 */

export class FakeLaneProviderError extends Error {
  constructor(code) {
    super(code);
    this.name = 'FakeLaneProviderError';
    this.code = code;
  }
}

const DEFAULT_CAPABILITIES = Object.freeze([
  'CLOSE_PANE', 'OBSERVE', 'OPERATION_MARKER', 'REAP', 'SPAWN', 'STOP', 'TOPOLOGY',
]);

/**
 * The identity of the unrelated workspace nothing in this suite may touch.
 * Named `Music` because that is the workspace issue #93 names as out of bounds.
 */
export const FOREIGN_WORKSPACE = Object.freeze({
  workspaceId: 'Music',
  paneId: 'pane-music',
  surfaceId: 'surface-music',
  agentId: 'agent-music',
});

export function createFakeLaneProvider(options = {}) {
  const {
    workspaceId = 'ws-bootstrap',
    providerId = 'fake-lane-provider',
    capability = {},
    faults = {},
    clock = () => '2026-09-01T12:00:00.000Z',
  } = options;

  let paneCounter = 0;
  let surfaceCounter = 0;
  let agentCounter = 0;
  let layoutCounter = 0;

  const panes = new Map();
  const agents = new Map();
  const journal = [];

  panes.set(FOREIGN_WORKSPACE.paneId, {
    paneId: FOREIGN_WORKSPACE.paneId,
    workspaceId: FOREIGN_WORKSPACE.workspaceId,
    operationMarker: null,
    surfaceIds: [FOREIGN_WORKSPACE.surfaceId],
  });
  agents.set(FOREIGN_WORKSPACE.agentId, {
    agentId: FOREIGN_WORKSPACE.agentId,
    paneId: FOREIGN_WORKSPACE.paneId,
    surfaceId: FOREIGN_WORKSPACE.surfaceId,
    operationMarker: null,
    lifecycle: 'RUNNING',
    startedAt: '2026-09-01T11:00:00.000Z',
    processIdentity: { pid: 111 },
    reportingParent: 'OPERATOR',
    evidenceMarker: null,
  });

  const layoutRevision = () => `layout-${layoutCounter}`;

  /** A named fault applies to one lane, or to every lane when it names `ALL`. */
  const hit = (fault, laneId) => fault !== undefined && (fault === laneId || fault === 'ALL');

  const own = (id, map) => {
    const found = map.get(id);
    if (!found || found.operationMarker === null) {
      throw new FakeLaneProviderError('FIXTURE_FORBIDDEN_TARGET');
    }
    return found;
  };

  const describedCapability = () => Object.freeze({
    schema: 'gaia-lane-provider-capability/1',
    providerId,
    capabilities: Object.freeze([...(capability.capabilities ?? DEFAULT_CAPABILITIES)]),
    authenticationMode: capability.authenticationMode ?? 'AMBIENT_SESSION',
    costObservation: Object.freeze({
      basis: capability.costObservation?.basis ?? 'UNOBSERVED',
      remainingUnits: capability.costObservation?.remainingUnits ?? null,
    }),
    evidenceContract: Object.freeze({
      kind: capability.evidenceContract?.kind ?? 'STRUCTURED_PROCESS_IDENTITY',
      startupDeadlineMs: capability.evidenceContract?.startupDeadlineMs ?? 60_000,
    }),
    limits: Object.freeze({ maxLanes: capability.limits?.maxLanes ?? 4 }),
  });

  const provider = {
    async describe() {
      journal.push({ op: 'describe' });
      return describedCapability();
    },

    async createTopology(request) {
      journal.push({ op: 'createTopology', ...request });
      if (faults.topologyThrows) throw new FakeLaneProviderError('FIXTURE_TOPOLOGY_FAILED');
      const count = faults.topologyPaneCount ?? request.laneCount;
      layoutCounter += 1;
      const paneIds = [];
      for (let index = 0; index < count; index += 1) {
        paneCounter += 1;
        const paneId = `pane-${paneCounter}`;
        panes.set(paneId, {
          paneId,
          workspaceId: request.workspaceId,
          operationMarker: request.operationMarker,
          surfaceIds: [],
        });
        paneIds.push(paneId);
      }
      return { paneIds, layoutRevision: layoutRevision() };
    },

    async spawn(request) {
      journal.push({ op: 'spawn', ...request });
      if (hit(faults.spawnThrowsOnLane, request.laneId)) {
        throw new FakeLaneProviderError('FIXTURE_SPAWN_FAILED');
      }
      const pane = panes.get(request.paneId);
      if (!pane) throw new FakeLaneProviderError('FIXTURE_UNKNOWN_PANE');
      agentCounter += 1;
      surfaceCounter += 1;
      const agentId = `agent-${agentCounter}`;
      const surfaceId = `surface-${surfaceCounter}`;
      pane.surfaceIds.push(surfaceId);
      if (hit(faults.stackSurfaceOnLane, request.laneId)) {
        surfaceCounter += 1;
        pane.surfaceIds.push(`surface-${surfaceCounter}`);
      }
      agents.set(agentId, {
        agentId,
        paneId: request.paneId,
        surfaceId,
        operationMarker: request.operationMarker,
        lifecycle: hit(faults.exitLane, request.laneId) ? 'EXITED' : 'RUNNING',
        startedAt: faults.startedAtByLane?.[request.laneId] ?? clock(),
        processIdentity: hit(faults.omitProcessIdentityOnLane, request.laneId)
          ? null
          : { pid: 4000 + agentCounter },
        reportingParent: hit(faults.omitReportingParentOnLane, request.laneId)
          ? null
          : request.supervisor,
        evidenceMarker: hit(faults.omitEvidenceMarkerOnLane, request.laneId)
          ? null
          : request.artifactMarker,
      });
      if (hit(faults.deletePaneOnLane, request.laneId)) panes.delete(request.paneId);
      if (hit(faults.expandGridOnLane, request.laneId)) layoutCounter += 1;
      return hit(faults.spawnReturnsPaneIdOnLane, request.laneId)
        ? { agentId, surfaceId, paneId: 'pane-elsewhere' }
        : { agentId, surfaceId, paneId: request.paneId };
    },

    async snapshot(request) {
      journal.push({ op: 'snapshot', ...request });
      if (faults.snapshotThrows) throw new FakeLaneProviderError('FIXTURE_SNAPSHOT_FAILED');
      return {
        workspaceId: request.workspaceId,
        layoutRevision: layoutRevision(),
        panes: [...panes.values()].map((pane) => ({
          paneId: pane.paneId,
          workspaceId: pane.workspaceId,
          operationMarker: pane.operationMarker,
          surfaceIds: [...pane.surfaceIds],
        })),
        agents: [...agents.values()].map((agent) => ({ ...agent })),
      };
    },

    async stopAgent(request) {
      journal.push({ op: 'stopAgent', ...request });
      own(request.agentId, agents).lifecycle = 'EXITED';
      return { stopped: true };
    },

    async reapSurface(request) {
      journal.push({ op: 'reapSurface', ...request });
      const agent = [...agents.values()]
        .find((candidate) => candidate.surfaceId === request.surfaceId);
      const pane = [...panes.values()]
        .find((candidate) => candidate.surfaceIds.includes(request.surfaceId));
      const owned = (agent !== undefined && agent.operationMarker !== null)
        || (pane !== undefined && pane.operationMarker !== null);
      if (!owned) throw new FakeLaneProviderError('FIXTURE_FORBIDDEN_TARGET');
      if (agent) agents.delete(agent.agentId);
      if (pane) pane.surfaceIds = pane.surfaceIds.filter((id) => id !== request.surfaceId);
      return { reaped: true };
    },

    async closePane(request) {
      journal.push({ op: 'closePane', ...request });
      const pane = own(request.paneId, panes);
      if (pane.surfaceIds.length > 0) throw new FakeLaneProviderError('FIXTURE_PANE_NOT_EMPTY');
      panes.delete(request.paneId);
      return { closed: true };
    },
  };

  return {
    provider,
    workspaceId,
    journal,
    operations: () => journal.map((entry) => entry.op),
    mutations: () => journal
      .map((entry) => entry.op)
      .filter((op) => op !== 'describe' && op !== 'snapshot'),
    panes: () => [...panes.values()].map((pane) => ({ ...pane, surfaceIds: [...pane.surfaceIds] })),
    agents: () => [...agents.values()].map((agent) => ({ ...agent })),
    livePaneCount: () => panes.size,
    liveAgentCount: () => [...agents.values()].filter((a) => a.lifecycle === 'RUNNING').length,
    /** Expand the grid underneath a launch, exactly as the 2026-09-02 failure did. */
    expandGrid: () => { layoutCounter += 1; },
  };
}
