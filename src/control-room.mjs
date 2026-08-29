/**
 * Pure read model for Gaia's operator-facing control room.
 *
 * The input is an already reconciled portfolio-drain projection. This module grants no
 * authority, performs no I/O, and never turns an open-ended portfolio into a fabricated
 * project-completion percentage.
 */

import { createHash } from 'node:crypto';

export const CONTROL_ROOM_SCHEMA = 'gaia-control-room/1';

const HEARTBEAT_FRESH_MS = 30_000;
const RUNNING_STAGES = new Set([
  'worker_running', 'initial_review_running', 'repair_running', 'final_review_running',
]);
const LIFECYCLE_PROGRESS = Object.freeze({
  QUEUED: [0, 'Claim a bounded factory run'],
  CLAIMED: [1, 'Start the authorized factory run'],
  RUNNING: [2, 'Build and independently review the candidate'],
  CANDIDATE_READY: [3, 'Publish the reviewed candidate'],
  AWAITING_MERGE_AUTHORITY: [4, 'Obtain explicit merge authority'],
  PUBLISHED: [4, 'Merge or close the published pull request'],
  TERMINAL_MERGED: [5, 'Complete'],
  TERMINAL_CLOSED: [5, 'Complete'],
});
const BLOCKED_STATES = new Set([
  'BLOCKED_DEPENDENCY', 'BLOCKED_DRAFT', 'BLOCKED_EVIDENCE', 'BLOCKED_HUMAN',
  'BLOCKED_POLICY', 'BLOCKED_REVIEW', 'BLOCKED_TRIAGE', 'BLOCKED_UNKNOWN',
  'FAILED_AUTHORITY_CONSUMED', 'RECONCILE_REQUIRED',
]);
const PARTIAL_KNOWLEDGE_STATES = new Set([
  'READY_WITH_UNKNOWN', 'CHECKS_UNKNOWN', 'REVIEW_UNKNOWN',
  'CHECKS_AND_REVIEW_UNKNOWN',
]);
const KNOWN_KNOWLEDGE_STATES = new Set([
  'READY', 'BLOCKED_DEPENDENCY', 'AWAITING_HUMAN', 'DRAFT', 'BLOCKED_REVIEW',
  'DUPLICATE', 'ARCHIVED', 'NEEDS_TRIAGE',
]);
const UNOBSERVED_KNOWLEDGE_STATES = new Set([
  'EVIDENCE_UNKNOWN', 'MISSING_FROM_OPEN_SNAPSHOT',
]);

export class ControlRoomError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ControlRoomError';
    this.code = code;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requireProjection(value) {
  if (!value || value.schema !== 'gaia-portfolio-drain-projection/1'
      || value.effect !== 'NONE' || value.authority !== 'NONE'
      || !Array.isArray(value.items) || !Array.isArray(value.decisions)) {
    throw new ControlRoomError(
      'InvalidProjection', 'an authority-free Gaia portfolio-drain projection is required',
    );
  }
  const { revision, ...body } = value;
  const expectedRevision = createHash('sha256').update(canonicalJson(body)).digest('hex');
  if (typeof revision !== 'string' || revision !== expectedRevision) {
    throw new ControlRoomError(
      'InvalidProjection', 'the portfolio-drain projection revision does not match its content',
    );
  }
  return value;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value)) deepFreeze(nested);
  return Object.freeze(value);
}

function requireTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    throw new ControlRoomError('InvalidObservation', 'observedAt must be an ISO timestamp');
  }
  return value;
}

function latestProgressByItem(observations) {
  if (!Array.isArray(observations)) {
    throw new ControlRoomError('InvalidObservation', 'progressObservations must be an array');
  }
  const latest = new Map();
  for (const observation of observations) {
    if (!observation || typeof observation.itemId !== 'string'
        || typeof observation.capturedAt !== 'string'
        || !Number.isFinite(Date.parse(observation.capturedAt))
        || observation.record?.schema !== 'gaia-cli-progress/1') {
      throw new ControlRoomError('InvalidObservation', 'progress observation shape is invalid');
    }
    const previous = latest.get(observation.itemId);
    const previousAt = previous ? Date.parse(previous.capturedAt) : Number.NEGATIVE_INFINITY;
    const currentAt = Date.parse(observation.capturedAt);
    if (previous && previousAt === currentAt
        && canonicalJson(previous.record) !== canonicalJson(observation.record)) {
      throw new ControlRoomError(
        'InvalidObservation', 'conflicting progress observations share one item and timestamp',
      );
    }
    if (!previous || previousAt < currentAt) {
      latest.set(observation.itemId, observation);
    }
  }
  return latest;
}

function itemProgress(drainState) {
  const value = LIFECYCLE_PROGRESS[drainState];
  if (!value) {
    return {
      completedGates: null,
      totalGates: 5,
      percentage: null,
      currentGate: 'Resolve the named blocker before measuring progress',
    };
  }
  return {
    completedGates: value[0],
    totalGates: 5,
    percentage: value[0] * 20,
    currentGate: value[1],
  };
}

function itemActivity(item, observation, observedAtMs) {
  if (!['CLAIMED', 'RUNNING'].includes(item.drainState)) {
    return {
      state: 'IDLE', stage: null, elapsedMs: null, lastHeartbeatAt: null, showPulse: false,
    };
  }
  const stage = observation?.record?.stage ?? null;
  const capturedAtMs = observation ? Date.parse(observation.capturedAt) : Number.NaN;
  const fresh = Number.isFinite(capturedAtMs)
    && observedAtMs >= capturedAtMs
    && observedAtMs - capturedAtMs <= HEARTBEAT_FRESH_MS;
  const running = fresh && observation.record.heartbeat === true && RUNNING_STAGES.has(stage);
  return {
    state: running ? 'ACTIVE' : 'STALE',
    stage,
    elapsedMs: Number.isSafeInteger(observation?.record?.elapsedMs)
      ? observation.record.elapsedMs : null,
    lastHeartbeatAt: observation?.record?.heartbeat === true ? observation.capturedAt : null,
    showPulse: running && observation.record.heartbeat === true,
  };
}

function formatDuration(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes === 0) return `${remainingSeconds}s`;
  return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function measurePace(completedRuns) {
  if (!Array.isArray(completedRuns)) {
    throw new ControlRoomError('InvalidHistory', 'completedRuns must be an array');
  }
  for (const run of completedRuns) {
    if (!run || typeof run.workflow !== 'string' || typeof run.outcome !== 'string'
        || !Number.isSafeInteger(run.elapsedMs) || run.elapsedMs < 1) {
      throw new ControlRoomError('InvalidHistory', 'completed run shape is invalid');
    }
  }
  const durations = completedRuns
    .filter(({ workflow, outcome }) => (
      workflow === 'portfolio-factory-run' && outcome === 'COMPLETED'
    ))
    .map(({ elapsedMs }) => elapsedMs)
    .sort((left, right) => left - right);
  if (durations.length < 5) {
    return {
      pace: {
        state: 'UNKNOWN',
        sampleSize: durations.length,
        medianCycleMs: null,
        label: 'Unknown pace: fewer than 5 comparable completed runs.',
      },
      durations,
    };
  }
  const medianCycleMs = durations[Math.floor(durations.length / 2)];
  return {
    pace: {
      state: 'MEASURED',
      sampleSize: durations.length,
      medianCycleMs,
      label: `Historical median: ${formatDuration(medianCycleMs)} per comparable completed run.`,
    },
    durations,
  };
}

function forecastEta({ activeItems, pace, durations }) {
  if (activeItems.length === 0) return null;
  if (activeItems.length > 1) {
    return { state: 'UNKNOWN', label: 'Unknown', reason: 'More than one run is active.' };
  }
  if (pace.state !== 'MEASURED') {
    return {
      state: 'UNKNOWN', label: 'Unknown', reason: 'Insufficient comparable history.',
    };
  }
  const elapsedMs = activeItems[0].activity.elapsedMs;
  if (!Number.isSafeInteger(elapsedMs)) {
    return { state: 'UNKNOWN', label: 'Unknown', reason: 'Elapsed time is unavailable.' };
  }
  const lowerTotal = durations[Math.floor((durations.length - 1) * 0.25)];
  const upperTotal = durations[Math.ceil((durations.length - 1) * 0.75)];
  const remainingRangeMs = [
    Math.max(0, lowerTotal - elapsedMs),
    Math.max(0, upperTotal - elapsedMs),
  ];
  return {
    state: 'FORECAST',
    label: `Between ${formatDuration(remainingRangeMs[0])} and ${formatDuration(remainingRangeMs[1])}`,
    remainingRangeMs,
    sampleSize: pace.sampleSize,
    method: 'historical-interquartile-range',
  };
}

function blockerSummary(items) {
  const counts = new Map();
  for (const { drainState } of items) {
    if (BLOCKED_STATES.has(drainState)) {
      counts.set(drainState, (counts.get(drainState) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([state, count]) => ({ state, count }))
    .sort((left, right) => right.count - left.count || left.state.localeCompare(right.state));
}

function knowledgeState(sourceState) {
  if (KNOWN_KNOWLEDGE_STATES.has(sourceState)) return 'KNOWN';
  if (PARTIAL_KNOWLEDGE_STATES.has(sourceState)) return 'PARTIAL';
  if (UNOBSERVED_KNOWLEDGE_STATES.has(sourceState)) return 'UNOBSERVED';
  return 'UNOBSERVED';
}

function measureKnowledgeCoverage(items) {
  const coverage = { known: 0, partial: 0, unobserved: 0 };
  for (const item of items) {
    coverage[item.knowledgeState.toLowerCase()] += 1;
  }
  const total = items.length;
  const knownPercentage = total === 0 ? null : Math.round((coverage.known / total) * 100);
  const frontierCount = coverage.partial + coverage.unobserved;
  return {
    ...coverage,
    total,
    knownPercentage,
    label: total === 0
      ? 'No portfolio items are available to classify.'
      : `${knownPercentage}% currently classified from sufficient evidence (${coverage.known}/${total}).`,
    caveat: 'Evidence coverage only — not completion, correctness or model confidence.',
    frontier: {
      kind: 'RECONNOITER_UNKNOWN_EVIDENCE',
      count: frontierCount,
      label: `Investigate ${frontierCount} partially observed or unobserved items.`,
    },
  };
}

function blockerAction(blocker) {
  const labels = {
    BLOCKED_EVIDENCE: `${blocker.count} items need missing evidence before Gaia can schedule them.`,
    BLOCKED_HUMAN: `${blocker.count} items need a human decision.`,
    BLOCKED_DRAFT: `${blocker.count} draft pull requests need to become reviewable.`,
    BLOCKED_UNKNOWN: `${blocker.count} items need their unknown state investigated.`,
  };
  return {
    kind: `TRIAGE_${blocker.state}`,
    itemId: null,
    label: labels[blocker.state]
      ?? `${blocker.count} items require ${blocker.state.toLowerCase().replaceAll('_', ' ')} resolution.`,
  };
}

function nextActionFor(items, decisions, blockers) {
  const stale = items.find(({ activity }) => activity.state === 'STALE');
  if (stale) {
    return {
      kind: 'CHECK_STALE_RUN',
      itemId: stale.itemId,
      label: 'Check the run: its last heartbeat is stale.',
    };
  }
  const active = items.find(({ activity }) => activity.state === 'ACTIVE');
  if (active) {
    return {
      kind: 'OBSERVE_ACTIVE_RUN',
      itemId: active.itemId,
      label: 'Wait for the worker result, then run the independent review.',
    };
  }
  const decision = decisions[0];
  if (decision) {
    return {
      kind: decision.action,
      itemId: decision.itemId,
      label: decision.action === 'CLAIM_FACTORY_RUN'
        ? 'Authorize and claim the next bounded factory run.'
        : 'Prepare the authority-free publication intent.',
    };
  }
  if (blockers.length > 0) return blockerAction(blockers[0]);
  return { kind: 'NONE', itemId: null, label: 'No executable next action is available.' };
}

export function buildControlRoomSnapshot({
  drainProjection, observedAt, sourceChangedAt = observedAt,
  progressObservations = [], completedRuns = [],
}) {
  const projection = requireProjection(drainProjection);
  const at = requireTimestamp(observedAt);
  const changedAt = requireTimestamp(sourceChangedAt);
  const observedAtMs = Date.parse(at);
  const latest = latestProgressByItem(progressObservations);
  const items = structuredClone(projection.items).map((item) => ({
    ...item,
    knowledgeState: knowledgeState(item.sourceState),
    progress: itemProgress(item.drainState),
    activity: itemActivity(item, latest.get(item.itemId), observedAtMs),
  }));
  const activeCount = items.filter(({ activity }) => activity.state === 'ACTIVE').length;
  const staleCount = items.filter(({ activity }) => activity.state === 'STALE').length;
  const blockers = blockerSummary(items);
  const blockedCount = blockers.reduce((total, blocker) => total + blocker.count, 0);
  const state = activeCount > 0 ? 'ACTIVE' : staleCount > 0 ? 'STALE' : 'PAUSED';
  const measured = measurePace(completedRuns);
  const activeItems = items.filter(({ activity }) => activity.state === 'ACTIVE');
  const forecast = forecastEta({ activeItems, ...measured });

  const body = {
    schema: CONTROL_ROOM_SCHEMA,
    observedAt: at,
    sourceChangedAt: changedAt,
    sourceRevision: projection.revision,
    effect: 'NONE',
    authority: 'NONE',
    headline: state === 'PAUSED'
      ? {
        state: 'PAUSED',
        label: 'Paused',
        detail: 'No tracked factory run is moving right now.',
      }
      : state === 'ACTIVE' ? {
        state: 'ACTIVE',
        label: 'Active',
        detail: `${activeCount} Gaia ${activeCount === 1 ? 'run is' : 'runs are'} moving.`,
      } : {
        state: 'STALE',
        label: 'Needs attention',
        detail: `${staleCount} recorded ${staleCount === 1 ? 'run has' : 'runs have'} no fresh heartbeat.`,
      },
    activeCount,
    staleCount,
    blockedCount,
    totalItems: items.length,
    capacity: { ...projection.counts },
    blockers,
    showSpinner: items.some(({ activity }) => activity.showPulse),
    pace: measured.pace,
    eta: forecast ?? (activeCount === 0
      ? {
        state: 'UNKNOWN',
        label: 'Unknown',
        reason: staleCount > 0
          ? 'The heartbeat is stale; no reliable ETA exists.'
          : 'There is no active run to estimate.',
      }
      : {
        state: 'UNKNOWN',
        label: 'Unknown',
        reason: 'Insufficient comparable history.',
      }),
    portfolioCompletion: {
      percentage: null,
      reason: 'The portfolio is an open queue; it has no truthful global completion percentage.',
    },
    knowledgeCoverage: measureKnowledgeCoverage(items),
    nextAction: nextActionFor(items, projection.decisions, blockers),
    items,
  };
  return deepFreeze({
    ...body,
    revision: createHash('sha256').update(canonicalJson(body)).digest('hex'),
  });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

const RENDER_COPY = Object.freeze({
  en: Object.freeze({
    title: 'Gaia — real status', now: 'Now', next: 'Next action', progress: 'Verifiable progress',
    paceEta: 'Pace and ETA', evidence: 'Evidence', snapshot: 'Snapshot', source: 'Source projection',
    checked: 'Checked', changed: 'source changed', age: 'age', moving: 'Moving', stale: 'Stale',
    blocked: 'Blocked', slots: 'Free slots', currentGate: 'Current gate', noHeartbeat: 'No active heartbeat',
    staleHeartbeat: 'Stale heartbeat', realHeartbeat: 'Real heartbeat received', notMeasurable: 'Not measurable while blocked',
    pace: 'Pace', eta: 'ETA', blockerMix: 'Why work is blocked', topWork: 'Highest-priority work',
    fog: 'Fog of war', known: 'Known', partial: 'Partial', unobserved: 'Unobserved',
    frontier: 'Reconnaissance frontier',
    more: 'more items remain in the content-addressed snapshot', noItems: 'No work items in this snapshot.',
    items: 'items', noBlockers: 'No blockers recorded.',
    readOnly: 'Read-only dashboard: effect=NONE and authority=NONE.', technical: 'Technical identities',
    state: { ACTIVE: 'Active', STALE: 'Needs attention', PAUSED: 'Paused' },
  }),
  fr: Object.freeze({
    title: 'Gaia — état réel', now: 'Maintenant', next: 'Prochaine action', progress: 'Avancement vérifiable',
    paceEta: 'Rythme et ETA', evidence: 'Preuve', snapshot: 'Snapshot', source: 'Projection source',
    checked: 'Vérifié', changed: 'source modifiée', age: 'âge', moving: 'En cours', stale: 'Périmé',
    blocked: 'Bloqué', slots: 'Lanes libres', currentGate: 'Gate actuelle', noHeartbeat: 'Aucun heartbeat actif',
    staleHeartbeat: 'Heartbeat périmé', realHeartbeat: 'Heartbeat réel reçu', notMeasurable: 'Non mesurable tant que bloqué',
    pace: 'Rythme', eta: 'ETA', blockerMix: 'Pourquoi le travail est bloqué', topWork: 'Travail prioritaire',
    fog: 'Brouillard de connaissance', known: 'Connu', partial: 'Partiel', unobserved: 'Non observé',
    frontier: 'Frontière de reconnaissance',
    more: 'autres éléments restent dans le snapshot content-addressed', noItems: 'Aucun élément dans ce snapshot.',
    items: 'éléments', noBlockers: 'Aucun blocage enregistré.',
    readOnly: 'Dashboard read-only : effect=NONE et authority=NONE.', technical: 'Identités techniques',
    state: { ACTIVE: 'En cours', STALE: 'À vérifier', PAUSED: 'En pause' },
  }),
});

function localizedHeadline(snapshot, language) {
  if (language === 'en') return snapshot.headline;
  const details = {
    PAUSED: 'Aucune exécution suivie de la factory ne progresse actuellement.',
    ACTIVE: `${snapshot.activeCount} exécution${snapshot.activeCount === 1 ? '' : 's'} Gaia en cours.`,
    STALE: `${snapshot.staleCount} exécution${snapshot.staleCount === 1 ? '' : 's'} sans heartbeat récent.`,
  };
  return {
    state: snapshot.headline.state,
    label: RENDER_COPY.fr.state[snapshot.headline.state],
    detail: details[snapshot.headline.state],
  };
}

function localizedNextAction(snapshot, language) {
  if (language === 'en') return snapshot.nextAction.label;
  const blockerCount = snapshot.blockers.find(
    ({ state }) => `TRIAGE_${state}` === snapshot.nextAction.kind,
  )?.count ?? 0;
  const labels = {
    CHECK_STALE_RUN: 'Vérifier l’exécution : son dernier heartbeat est périmé.',
    OBSERVE_ACTIVE_RUN: 'Attendre le résultat du worker, puis lancer la review indépendante.',
    CLAIM_FACTORY_RUN: 'Autoriser et réclamer la prochaine exécution bornée de la factory.',
    PREPARE_PUBLICATION_INTENT: 'Préparer l’intention de publication sans autorité.',
    TRIAGE_BLOCKED_EVIDENCE: `${blockerCount} éléments nécessitent des preuves manquantes avant leur planification.`,
    TRIAGE_BLOCKED_HUMAN: `${blockerCount} éléments nécessitent une décision humaine.`,
    NONE: 'Aucune prochaine action exécutable n’est disponible.',
  };
  return labels[snapshot.nextAction.kind]
    ?? `${blockerCount} éléments nécessitent la résolution du blocage indiqué.`;
}

function localizedGate(item, language) {
  if (language === 'en') return item.progress.currentGate;
  return {
    QUEUED: 'Réclamer une exécution bornée de la factory',
    CLAIMED: 'Démarrer l’exécution autorisée de la factory',
    RUNNING: 'Construire puis faire relire indépendamment le candidat',
    CANDIDATE_READY: 'Publier le candidat relu',
    AWAITING_MERGE_AUTHORITY: 'Obtenir une autorisation explicite de fusion',
    PUBLISHED: 'Fusionner ou fermer la pull request publiée',
    TERMINAL_MERGED: 'Terminé',
    TERMINAL_CLOSED: 'Terminé',
  }[item.drainState] ?? 'Résoudre le blocage nommé avant de mesurer l’avancement';
}

function localizedPace(snapshot, language) {
  if (language === 'en') return snapshot.pace.label;
  return snapshot.pace.state === 'MEASURED'
    ? `Médiane historique : ${formatDuration(snapshot.pace.medianCycleMs)} par exécution comparable terminée.`
    : `Rythme inconnu : ${snapshot.pace.sampleSize}/5 exécutions comparables terminées.`;
}

function localizedEta(snapshot, language) {
  if (language === 'en') return etaExplanation(snapshot);
  if (snapshot.eta.state === 'FORECAST') {
    return `Entre ${formatDuration(snapshot.eta.remainingRangeMs[0])} et ${formatDuration(snapshot.eta.remainingRangeMs[1])}`
      + ` · ${snapshot.eta.sampleSize} exécutions comparables · intervalle interquartile`;
  }
  const reasons = {
    'Insufficient comparable history.': 'Historique comparable insuffisant.',
    'Elapsed time is unavailable.': 'Temps écoulé indisponible.',
    'More than one run is active.': 'Plusieurs exécutions sont actives.',
    'The heartbeat is stale; no reliable ETA exists.': 'Le heartbeat est périmé ; aucune ETA fiable.',
    'There is no active run to estimate.': 'Aucune exécution active à estimer.',
  };
  return `Inconnue · ${reasons[snapshot.eta.reason] ?? 'Preuve insuffisante.'}`;
}

function renderProgress(item, copy, language) {
  const { progress, activity } = item;
  const severity = activity.showPulse ? 'healthy'
    : activity.state === 'STALE' ? 'warning'
      : BLOCKED_STATES.has(item.drainState) ? 'blocked' : 'neutral';
  const heartbeat = activity.showPulse
    ? `<span class="heartbeat-pulse" data-heartbeat-at="${escapeHtml(activity.lastHeartbeatAt)}"`
      + ` role="status">${copy.realHeartbeat}</span>`
    : activity.state === 'STALE'
      ? `<span class="signal stale" role="status">${copy.staleHeartbeat}</span>`
      : `<span class="signal">${copy.noHeartbeat}</span>`;
  const meter = progress.percentage === null
    ? `<span class="not-measurable">${copy.notMeasurable}</span>`
    : `<progress max="100" value="${progress.percentage}">${progress.percentage}%</progress>`
      + `<strong>${progress.percentage}%</strong>`;
  return `<article class="work-item" data-severity="${severity}">
    <div class="item-heading">
      <div><span class="repo">${escapeHtml(item.repository)}</span>
        <h3>${escapeHtml(item.title)}</h3></div>
      ${heartbeat}
    </div>
    <div class="meter">${meter}</div>
    <p><strong>${copy.currentGate}:</strong> ${escapeHtml(localizedGate(item, language))}</p>
    <p class="evidence-line"><code>${escapeHtml(item.drainState)}</code> · ${escapeHtml(item.itemKind)} #${item.itemNumber}</p>
  </article>`;
}

function etaExplanation(snapshot) {
  if (snapshot.eta.state === 'FORECAST') {
    return `${snapshot.eta.label} · ${snapshot.eta.sampleSize} comparable runs · interquartile range`;
  }
  return `${snapshot.eta.label} · ${snapshot.eta.reason}`;
}

function headlinePresentation(state) {
  return {
    ACTIVE: { severity: 'healthy', symbol: '●' },
    STALE: { severity: 'warning', symbol: '▲' },
    PAUSED: { severity: 'neutral', symbol: '○' },
  }[state];
}

/** Render one dependency-free, shareable operator artifact. */
export function renderControlRoomHtml(snapshot, { language = 'en' } = {}) {
  if (!snapshot || snapshot.schema !== CONTROL_ROOM_SCHEMA) {
    throw new ControlRoomError('InvalidSnapshot', 'a Gaia control-room snapshot is required');
  }
  const copy = RENDER_COPY[language];
  if (!copy) throw new ControlRoomError('InvalidLanguage', 'language must be en or fr');
  const prioritized = [...snapshot.items].sort((left, right) => {
    const rank = { ACTIVE: 0, STALE: 1, IDLE: 2 };
    return rank[left.activity.state] - rank[right.activity.state]
      || (right.progress.percentage ?? -1) - (left.progress.percentage ?? -1)
      || left.repository.localeCompare(right.repository)
      || left.itemNumber - right.itemNumber;
  });
  const visible = prioritized.slice(0, 3);
  const items = visible.length > 0
    ? visible.map((item) => renderProgress(item, copy, language)).join('\n')
    : `<p class="empty">${copy.noItems}</p>`;
  const remaining = Math.max(0, snapshot.items.length - visible.length);
  const blockers = snapshot.blockers.length > 0
    ? `<div class="blocker-list">${snapshot.blockers.slice(0, 5).map(({ state, count }) => (
      `<div data-severity="blocked"><span><span class="semantic-symbol" aria-hidden="true">■</span><code>${escapeHtml(state)}</code></span><strong>${count}</strong></div>`
    )).join('')}</div>`
    : `<p class="empty">${copy.noBlockers}</p>`;
  const coverage = snapshot.knowledgeCoverage;
  const coverageLabel = language === 'fr'
    ? coverage.total === 0
      ? 'Aucun élément du portfolio à classifier.'
      : `${coverage.knownPercentage}% actuellement classifié avec des preuves suffisantes (${coverage.known}/${coverage.total}).`
    : coverage.label;
  const coverageCaveat = language === 'fr'
    ? 'Couverture des preuves uniquement — ni avancement, ni exactitude, ni confiance du modèle.'
    : coverage.caveat;
  const frontierLabel = language === 'fr'
    ? `Examiner ${coverage.frontier.count} éléments partiellement observés ou non observés.`
    : coverage.frontier.label;
  const denominator = Math.max(coverage.total, 1);
  const knownWidth = (coverage.known / denominator) * 100;
  const partialWidth = (coverage.partial / denominator) * 100;
  const unobservedWidth = (coverage.unobserved / denominator) * 100;
  const pulseCss = snapshot.showSpinner
    ? `
      @keyframes heartbeat { 50% { outline-color: transparent; } }
      .heartbeat-pulse { animation: heartbeat 1.2s step-end infinite; }
      @media (prefers-reduced-motion: reduce) { .heartbeat-pulse { animation: none; } }`
    : '';
  const headline = headlinePresentation(snapshot.headline.state);
  const localizedHeadlineValue = localizedHeadline(snapshot, language);
  const nextSeverity = snapshot.nextAction.kind === 'NONE' ? 'neutral'
    : snapshot.nextAction.kind === 'OBSERVE_ACTIVE_RUN' ? 'healthy' : 'warning';
  return `<!doctype html>
<html lang="${language}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>${copy.title}</title>
  <style>
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; --bg: #07101c; --panel: #0d1928; --panel-2: #101f31; --line: #253750; --muted: #8fa3bd; --text: #f3f7fc; --green: #54dc91; --amber: #ffbd59; --red: #ff6b78; --blue: #6ea8fe; }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); }
    main { max-width: 1180px; margin: 0 auto; padding: 30px; }
    header { align-items: end; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; margin-bottom: 22px; padding-bottom: 18px; }
    section { margin-bottom: 18px; }
    h1 { font-size: 25px; letter-spacing: -.02em; margin: 0 0 6px; }
    h2 { color: var(--muted); font-size: 12px; letter-spacing: .11em; margin: 0 0 10px; text-transform: uppercase; }
    h3 { font-size: 16px; line-height: 1.35; margin: 4px 0 0; }
    p { line-height: 1.45; }
    .as-of, .evidence-line, .repo { color: var(--muted); font-size: 12px; }
    .status-chip { border: 1px solid var(--line); font-size: 12px; font-weight: 750; padding: 8px 11px; text-transform: uppercase; }
    [data-severity="healthy"] { --semantic: var(--green); }
    [data-severity="warning"] { --semantic: var(--amber); }
    [data-severity="blocked"] { --semantic: var(--red); }
    [data-severity="neutral"] { --semantic: #c8d2df; }
    .semantic-symbol { color: var(--semantic); font-weight: 900; margin-right: 5px; }
    .status-chip { border-color: var(--semantic); color: var(--semantic); }
    .hero { display: grid; gap: 14px; grid-template-columns: minmax(0, 1.1fr) minmax(0, .9fr); }
    .now, .next { background: var(--panel); border: 1px solid var(--line); min-height: 150px; padding: 20px; }
    .next { border-left: 4px solid var(--semantic, var(--blue)); }
    .next code { display: block; margin-bottom: 12px; }
    .state { font-size: 32px; font-weight: 800; letter-spacing: -.03em; }
    .state.ACTIVE { color: var(--green); } .state.STALE { color: var(--amber); } .state.PAUSED { color: #c8d2df; }
    .metrics { display: grid; gap: 10px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .metric { background: var(--panel-2); border: 1px solid var(--line); border-top: 2px solid var(--semantic, var(--line)); padding: 14px; }
    .metric span { color: var(--muted); display: block; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; }
    .metric strong { display: block; font-size: 27px; margin-top: 5px; }
    .section-panel { background: var(--panel); border: 1px solid var(--line); padding: 18px; }
    .section-heading { align-items: baseline; display: flex; justify-content: space-between; }
    .work-list { display: grid; gap: 10px; grid-template-columns: repeat(3, minmax(0, 1fr)); }
    .work-item { background: var(--panel-2); border: 1px solid var(--line); border-left: 3px solid var(--semantic, var(--line)); padding: 15px; }
    .item-heading { align-items: start; display: flex; gap: 12px; justify-content: space-between; }
    .heartbeat-pulse, .signal { border: 1px solid var(--green); color: var(--green); font-size: 10px; outline: 2px solid var(--green); outline-offset: 2px; padding: 4px 6px; white-space: nowrap; }
    .signal { border-color: #40516a; color: var(--muted); outline: 0; } .signal.stale { border-color: var(--amber); color: var(--amber); }
    .meter { align-items: center; display: grid; gap: 12px; grid-template-columns: minmax(120px, 1fr) auto; margin-top: 16px; }
    progress { accent-color: var(--green); height: 10px; width: 100%; } .not-measurable { color: var(--amber); }
    .lower-grid { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .fog-grid { display: grid; gap: 16px; grid-template-columns: minmax(220px, .8fr) minmax(0, 1.2fr); }
    .fog-meter { background: #050a12; border: 1px solid var(--line); display: flex; height: 18px; overflow: hidden; }
    .fog-meter span { display: block; min-width: 0; }
    .fog-known { background: var(--green); } .fog-partial { background: var(--amber); } .fog-unobserved { background: #35435a; }
    .fog-counts { display: grid; gap: 8px; grid-template-columns: repeat(3, minmax(0, 1fr)); margin-top: 12px; }
    .fog-counts div { background: var(--panel-2); border: 1px solid var(--line); padding: 10px; }
    .fog-counts span { color: var(--muted); display: block; font-size: 11px; text-transform: uppercase; }
    .fog-counts strong { display: block; font-size: 22px; margin-top: 3px; }
    .fog-frontier { border-left: 3px solid var(--amber); margin: 0; padding-left: 14px; }
    .facts { display: grid; gap: 10px; }
    .fact { background: var(--panel-2); border-left: 3px solid var(--blue); padding: 13px; }
    .fact strong { display: block; font-size: 17px; line-height: 1.35; margin-top: 4px; }
    .blocker-list { display: grid; gap: 8px; }
    .blocker-list div { align-items: center; border-bottom: 1px solid var(--line); display: flex; justify-content: space-between; padding: 8px 0; }
    .blocker-list strong { font-size: 20px; }
    .evidence { align-items: start; display: grid; gap: 14px; grid-template-columns: 1fr 1fr; }
    code { color: #bdd2f2; overflow-wrap: anywhere; } .empty { color: var(--muted); }
    @media (max-width: 850px) { .hero, .lower-grid, .evidence, .fog-grid { grid-template-columns: 1fr; } .work-list { grid-template-columns: 1fr; } }
    @media (max-width: 600px) { .metrics { grid-template-columns: repeat(2, 1fr); } main { padding: 16px; } header { align-items: start; gap: 12px; } }
    ${pulseCss}
  </style>
</head>
<body data-snapshot-at="${escapeHtml(snapshot.observedAt)}">
<main>
  <header>
    <div><h1>${copy.title}</h1>
    <div class="as-of">${copy.checked} <time>${escapeHtml(snapshot.observedAt)}</time> · ${copy.changed} <time>${escapeHtml(snapshot.sourceChangedAt)}</time> · ${copy.age} <span id="snapshot-age">…</span></div></div>
    <div class="status-chip" data-severity="${headline.severity}"><span class="semantic-symbol" aria-hidden="true">${headline.symbol}</span>${copy.state[snapshot.headline.state]}</div>
  </header>
  <section class="hero">
    <div class="now">
      <h2>${copy.now}</h2>
      <div class="state ${escapeHtml(snapshot.headline.state)}">${escapeHtml(localizedHeadlineValue.label)}</div>
      <p>${escapeHtml(localizedHeadlineValue.detail)}</p>
    </div>
    <div class="next" data-severity="${nextSeverity}">
      <h2>${copy.next}</h2>
      <code>${escapeHtml(snapshot.nextAction.kind)}</code>
      <div>${escapeHtml(localizedNextAction(snapshot, language))}</div>
    </div>
  </section>
  <section class="metrics" aria-label="Portfolio facts">
    <div class="metric" data-severity="healthy"><span><span class="semantic-symbol" aria-hidden="true">●</span>${copy.moving}</span><strong>${snapshot.activeCount}</strong></div>
    <div class="metric" data-severity="warning"><span><span class="semantic-symbol" aria-hidden="true">▲</span>${copy.stale}</span><strong>${snapshot.staleCount}</strong></div>
    <div class="metric" data-severity="blocked"><span><span class="semantic-symbol" aria-hidden="true">■</span>${copy.blocked}</span><strong>${snapshot.blockedCount}</strong></div>
    <div class="metric" data-severity="neutral"><span><span class="semantic-symbol" aria-hidden="true">○</span>${copy.slots}</span><strong>${snapshot.capacity.available}/${snapshot.capacity.occupied + snapshot.capacity.available}</strong></div>
  </section>
  <section class="section-panel">
    <h2>${copy.fog}</h2>
    <div class="fog-grid">
      <div>
        <h3>${escapeHtml(coverageLabel)}</h3>
        <div class="fog-meter" role="img" aria-label="${escapeHtml(`${copy.known} ${coverage.known}, ${copy.partial} ${coverage.partial}, ${copy.unobserved} ${coverage.unobserved}`)}">
          <span class="fog-known" style="width:${knownWidth}%"></span>
          <span class="fog-partial" style="width:${partialWidth}%"></span>
          <span class="fog-unobserved" style="width:${unobservedWidth}%"></span>
        </div>
        <div class="fog-counts">
          <div><span>● ${copy.known}</span><strong>${coverage.known}</strong></div>
          <div><span>▲ ${copy.partial}</span><strong>${coverage.partial}</strong></div>
          <div><span>○ ${copy.unobserved}</span><strong>${coverage.unobserved}</strong></div>
        </div>
      </div>
      <div>
        <p class="fog-frontier"><strong>${copy.frontier}</strong><br>${escapeHtml(frontierLabel)}</p>
        <p class="evidence-line">${escapeHtml(coverageCaveat)}</p>
      </div>
    </div>
  </section>
  <section class="section-panel">
    <div class="section-heading"><h2>${copy.progress}</h2><span class="as-of">${snapshot.totalItems} ${copy.items}</span></div>
    <h3>${copy.topWork}</h3>
    <div class="work-list">${items}</div>
    ${remaining > 0 ? `<p class="evidence-line">+ ${remaining} ${copy.more}.</p>` : ''}
    <p class="evidence-line">${language === 'fr'
    ? 'Le portfolio est une file ouverte ; il n’a pas de pourcentage global d’achèvement fiable.'
    : escapeHtml(snapshot.portfolioCompletion.reason)}</p>
  </section>
  <section class="lower-grid">
    <div class="section-panel">
      <h2>${copy.paceEta}</h2>
      <div class="facts">
        <div class="fact">${copy.pace}<strong>${escapeHtml(localizedPace(snapshot, language))}</strong></div>
        <div class="fact">${copy.eta}<strong>${escapeHtml(localizedEta(snapshot, language))}</strong></div>
      </div>
    </div>
    <div class="section-panel"><h2>${copy.blockerMix}</h2>${blockers}</div>
  </section>
  <section class="section-panel">
    <h2>${copy.evidence}</h2>
    <div class="evidence"><p>${copy.snapshot}<br><code>${escapeHtml(snapshot.revision)}</code></p>
      <p>${copy.source}<br><code>${escapeHtml(snapshot.sourceRevision)}</code></p></div>
    <p class="evidence-line">${copy.readOnly}</p>
  </section>
</main>
<script>
  const freshnessMs = ${HEARTBEAT_FRESH_MS};
  function refreshAges() {
    const now = Date.now();
    const snapshotAt = Date.parse(document.body.dataset.snapshotAt);
    const age = Math.max(0, Math.floor((now - snapshotAt) / 1000));
    document.getElementById('snapshot-age').textContent = age + 's';
    for (const pulse of document.querySelectorAll('.heartbeat-pulse')) {
      if (now - Date.parse(pulse.dataset.heartbeatAt) > freshnessMs) {
        pulse.className = 'signal stale';
        pulse.textContent = ${JSON.stringify(copy.staleHeartbeat)};
      }
    }
  }
  refreshAges();
  setInterval(refreshAges, 1000);
</script>
</body>
</html>`;
}
