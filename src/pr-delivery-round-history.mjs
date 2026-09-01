import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BLOCKER_CLASSES = new Set([
  'NONE', 'CI', 'REVIEW', 'TEST', 'REPRODUCED_FAILURE', 'DEPENDENCY', 'AUTHORITY', 'UNKNOWN',
]);
const EVIDENCE_TRIGGERS = new Set(['REPRODUCED_BLOCKER', 'REVIEW_RECEIPT', 'CI_RECEIPT', 'TEST_RECEIPT']);
const MAX_ATTEMPTS = 5;

export class DeliveryRoundError extends Error {
  constructor(code) {
    super(code);
    this.name = 'DeliveryRoundError';
    this.code = code;
  }
}

function fail(code) {
  throw new DeliveryRoundError(code);
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

function revision(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonical(value), 'utf8')
    .digest('hex');
}

function keys(value, expected, code = 'InvalidReceipt') {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(code);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const actual = Reflect.ownKeys(value);
  if (actual.some((key) => typeof key !== 'string')) fail(code);
  const sorted = actual.toSorted();
  const wanted = [...expected].toSorted();
  if (sorted.length !== wanted.length || sorted.some((key, index) => key !== wanted[index])) fail(code);
}

function lineText(value, code = 'InvalidReceipt', maximum = 240) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum
    || value.trim() !== value || /[\u0000-\u001f\u007f`]/u.test(value)) fail(code);
  return value;
}

function sha256(value, code = 'InvalidReceipt') {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(code);
  return value;
}

function gitOidOrUnknown(value) {
  if ((typeof value === 'string' && GIT_OID.test(value)) || unknown(value)) return value;
  fail('InvalidReceipt');
}

function unknown(value) {
  return typeof value === 'string' && /^UNKNOWN\([A-Z0-9_:-]+\)$/u.test(value);
}

function evidence(value) {
  keys(value, [
    'designCommit', 'redCommit', 'greenCommit', 'testEvidenceReceipt', 'reviewVerdicts',
    'result', 'nextStep', 'estimate', 'blocker', 'origin',
  ]);
  keys(value.estimate, ['range', 'confidence', 'origin']);
  keys(value.blocker, [
    'class', 'reason', 'owner', 'phaseDeadline', 'nextTransition', 'escalationAction', 'origin',
  ]);
  if (!BLOCKER_CLASSES.has(value.blocker.class)) fail('InvalidReceipt');
  if (!ISO_INSTANT.test(value.blocker.phaseDeadline)
    || Number.isNaN(Date.parse(value.blocker.phaseDeadline))) fail('InvalidReceipt');
  if (!Array.isArray(value.reviewVerdicts) || value.reviewVerdicts.length === 0
    || value.reviewVerdicts.length > 4) fail('InvalidReceipt');
  const testEvidenceReceipt = value.testEvidenceReceipt;
  if (!(typeof testEvidenceReceipt === 'string'
    && (SHA256.test(testEvidenceReceipt) || unknown(testEvidenceReceipt)))) fail('InvalidReceipt');
  return Object.freeze({
    designCommit: gitOidOrUnknown(value.designCommit),
    redCommit: gitOidOrUnknown(value.redCommit),
    greenCommit: gitOidOrUnknown(value.greenCommit),
    testEvidenceReceipt,
    reviewVerdicts: Object.freeze(value.reviewVerdicts.map((item) => lineText(item))),
    result: lineText(value.result),
    nextStep: lineText(value.nextStep),
    estimate: Object.freeze({
      range: lineText(value.estimate.range),
      confidence: lineText(value.estimate.confidence),
      origin: lineText(value.estimate.origin),
    }),
    blocker: Object.freeze({
      class: value.blocker.class,
      reason: lineText(value.blocker.reason),
      owner: lineText(value.blocker.owner),
      phaseDeadline: value.blocker.phaseDeadline,
      nextTransition: lineText(value.blocker.nextTransition),
      escalationAction: lineText(value.blocker.escalationAction),
      origin: lineText(value.blocker.origin),
    }),
    origin: lineText(value.origin),
  });
}

function openReceipt(value) {
  keys(value, [
    'schema', 'kind', 'revision', 'ordinal', 'predecessorRoundKey', 'trigger', 'roundBudget',
    'evidence',
  ]);
  if (value.schema !== 'GaiaRoundReceiptV0' || value.kind !== 'OPEN' || value.ordinal !== 0
    || value.predecessorRoundKey !== 'NONE' || value.trigger !== 'DRAFT_CREATED'
    || !Number.isSafeInteger(value.roundBudget) || value.roundBudget < 1 || value.roundBudget > 8) {
    fail('InvalidReceipt');
  }
  return Object.freeze({ ...value, revision: sha256(value.revision), evidence: evidence(value.evidence) });
}

function advanceReceipt(value) {
  if (value?.schema !== 'GaiaRoundReceiptV0' || value?.kind !== 'ADVANCE') fail('InvalidReceipt');
  keys(value, [
    'schema', 'kind', 'revision', 'ordinal', 'predecessorRoundKey', 'trigger', 'evidence',
  ]);
  if (value.ordinal !== 1 || typeof value.predecessorRoundKey !== 'string'
    || !SHA256.test(value.predecessorRoundKey)) fail('InvalidReceipt');
  if (!SHA256.test(value.revision)) {
    return Object.freeze({ kind: 'REFUSED', code: 'MissingBlockerReceipt' });
  }
  if (!EVIDENCE_TRIGGERS.has(value.trigger)) {
    return Object.freeze({ kind: 'REFUSED', code: 'NonEvidenceEvent' });
  }
  return Object.freeze({ ...value, evidence: evidence(value.evidence) });
}

function lineageKey(workKey) {
  return revision({ schema: 'GaiaRoundLineageKeyV0', workKey });
}

function keyForRound(lineage, ordinal) {
  return revision({ schema: 'GaiaRoundKeyV0', roundLineageKey: lineage, ordinal });
}

function keyForAdvance(predecessorRoundKey, blockerReceiptRevision) {
  return revision({
    schema: 'GaiaRoundAdvanceKeyV0', predecessorRoundKey, blockerReceiptRevision,
  });
}

function marker(workKey, edge) {
  return `<!-- gaia-rounds:${edge}:${workKey} -->`;
}

function blockerLabel(blocker) {
  return blocker.class === 'NONE' ? 'NONE' : `${blocker.class}(${blocker.reason})`;
}

function renderRound(round) {
  const lines = [
    `#### R${round.ordinal}`,
    `- Round key: \`${round.roundKey}\``,
    `- Receipt revision: \`${round.receiptRevision}\``,
    `- Trigger: \`${round.trigger}\``,
  ];
  if (round.ordinal === 0) lines.push(`- Round budget: ${round.roundBudget}`);
  else lines.push(`- Advance key: \`${round.advanceKey}\``);
  lines.push(
    `- Design commit: \`${round.evidence.designCommit}\``,
    `- RED commit: \`${round.evidence.redCommit}\``,
    `- GREEN commit: \`${round.evidence.greenCommit}\``,
    `- Test evidence: \`${round.evidence.testEvidenceReceipt}\``,
    `- Review verdicts: ${round.evidence.reviewVerdicts.map((item) => `\`${item}\``).join(', ')}`,
    `- Result: \`${round.evidence.result}\``,
    `- Next step: ${round.evidence.nextStep}`,
    `- Estimate range: \`${round.evidence.estimate.range}\``,
    `- Estimate confidence: \`${round.evidence.estimate.confidence}\``,
    `- Estimate origin: ${round.evidence.estimate.origin}`,
    `- Blocker: \`${blockerLabel(round.evidence.blocker)}\``,
    `- Accountable owner: ${round.evidence.blocker.owner}`,
    `- Phase deadline (intervention boundary): ${round.evidence.blocker.phaseDeadline}`,
    `- Next transition: \`${round.evidence.blocker.nextTransition}\``,
    `- Escalation action: \`${round.evidence.blocker.escalationAction}\``,
    `- Blocker origin: ${round.evidence.blocker.origin}`,
    `- Origin: ${round.evidence.origin}`,
  );
  return lines.join('\n');
}

function renderSection(workKey, rounds) {
  return [
    marker(workKey, 'begin'),
    '### Delivery rounds',
    '',
    rounds.map(renderRound).join('\n\n'),
    marker(workKey, 'end'),
  ].join('\n');
}

function initialRound(workKey, receipt) {
  const lineage = lineageKey(workKey);
  return Object.freeze({
    ordinal: 0,
    roundKey: keyForRound(lineage, 0),
    receiptRevision: receipt.revision,
    trigger: receipt.trigger,
    roundBudget: receipt.roundBudget,
    evidence: receipt.evidence,
  });
}

export function createInitialManagedRound(input) {
  keys(input, ['workKey', 'receipt'], 'InvalidInput');
  const workKey = sha256(input.workKey, 'InvalidInput');
  const receipt = openReceipt(input.receipt);
  const lineage = lineageKey(workKey);
  const round = initialRound(workKey, receipt);
  return Object.freeze({
    kind: 'INITIAL', lineageKey: lineage, roundKey: round.roundKey,
    managedSection: renderSection(workKey, [round]),
  });
}

function occurrences(body, value) {
  let count = 0;
  let offset = 0;
  while ((offset = body.indexOf(value, offset)) !== -1) {
    count += 1;
    offset += value.length;
  }
  return count;
}

function parseField(block, label) {
  const prefix = `- ${label}: `;
  const line = block.split('\n').find((candidate) => candidate.startsWith(prefix));
  if (!line) fail('ManagedSectionMalformed');
  const value = line.slice(prefix.length);
  return value.startsWith('`') && value.endsWith('`') ? value.slice(1, -1) : value;
}

function parseManaged(body, workKey) {
  if (typeof body !== 'string') return { error: 'ManagedSectionMalformed' };
  const begin = marker(workKey, 'begin');
  const end = marker(workKey, 'end');
  const anyMarker = /<!-- gaia-rounds:(?:begin|end):[a-f0-9]{64} -->/gu;
  const found = [...body.matchAll(anyMarker)];
  if (occurrences(body, begin) !== 1 || occurrences(body, end) !== 1 || found.length !== 2) {
    return { error: 'ManagedSectionMalformed' };
  }
  const start = body.indexOf(begin);
  const finish = body.indexOf(end, start + begin.length);
  if (finish < start) return { error: 'ManagedSectionMalformed' };
  const fencesBefore = body.slice(0, start).match(/^```/gmu)?.length ?? 0;
  if (fencesBefore % 2 === 1) return { error: 'ManagedSectionMalformed' };
  const sectionEnd = finish + end.length;
  const section = body.slice(start, sectionEnd);
  const blocks = section.split(/\n\n(?=#### R\d+$)/mu).slice(1);
  if (blocks.length < 1 || blocks.length > 2) return { error: 'ManagedSectionMalformed' };
  try {
    const rounds = blocks.map((block, index) => {
      const heading = /^#### R(\d+)$/mu.exec(block);
      if (!heading || Number(heading[1]) !== index) fail('ManagedSectionMalformed');
      const blocker = parseField(block, 'Blocker');
      const match = /^(NONE|CI|REVIEW|TEST|REPRODUCED_FAILURE|DEPENDENCY|AUTHORITY|UNKNOWN)(?:\(([^)]+)\))?$/u.exec(blocker);
      if (!match) fail('ManagedSectionMalformed');
      return Object.freeze({
        ordinal: index,
        roundKey: sha256(parseField(block, 'Round key'), 'ManagedSectionMalformed'),
        receiptRevision: sha256(parseField(block, 'Receipt revision'), 'ManagedSectionMalformed'),
        advanceKey: index === 0 ? null : sha256(parseField(block, 'Advance key'), 'ManagedSectionMalformed'),
        roundBudget: index === 0 ? Number(parseField(block, 'Round budget')) : null,
        blocker: Object.freeze({
          class: match[1], reason: match[2] ?? 'NONE',
          owner: parseField(block, 'Accountable owner'),
          phaseDeadline: parseField(block, 'Phase deadline (intervention boundary)'),
          nextTransition: parseField(block, 'Next transition'),
          escalationAction: parseField(block, 'Escalation action'),
          origin: parseField(block, 'Blocker origin'),
        }),
      });
    });
    if (!Number.isSafeInteger(rounds[0].roundBudget) || rounds[0].roundBudget < 1) {
      return { error: 'ManagedSectionMalformed' };
    }
    return Object.freeze({ start, sectionEnd, section, rounds: Object.freeze(rounds) });
  } catch (error) {
    if (error instanceof DeliveryRoundError) return { error: error.code };
    throw error;
  }
}

function refusal(code, extra = {}) {
  return Object.freeze({ kind: 'REFUSED', code, ...extra });
}

function validateObservation(value) {
  try {
    keys(value, ['number', 'headRevision', 'body', 'bodyRevision'], 'InvalidObservation');
    if (!Number.isSafeInteger(value.number) || value.number <= 0 || !GIT_OID.test(value.headRevision)
      || typeof value.body !== 'string' || !SHA256.test(value.bodyRevision)) fail('InvalidObservation');
  } catch (error) {
    if (error instanceof DeliveryRoundError) return { error: error.code };
    throw error;
  }
  if (revision(value.body) !== value.bodyRevision) return { error: 'StaleBody' };
  return value;
}

function deadlinePlan(workKey, parsed, receipt) {
  try {
    keys(receipt, ['schema', 'revision', 'observedAt']);
    if (receipt.schema !== 'GaiaRoundDeadlineReceiptV0' || !SHA256.test(receipt.revision)
      || !ISO_INSTANT.test(receipt.observedAt)) fail('InvalidReceipt');
  } catch (error) {
    if (error instanceof DeliveryRoundError) return refusal(error.code);
    throw error;
  }
  const current = parsed.rounds.at(-1);
  if (Date.parse(receipt.observedAt) < Date.parse(current.blocker.phaseDeadline)) {
    return refusal('DeadlineNotReached');
  }
  return Object.freeze({
    kind: 'ESCALATE',
    intent: Object.freeze({
      schema: 'GaiaRoundEscalationIntentV0', workKey, roundKey: current.roundKey,
      owner: current.blocker.owner, action: current.blocker.escalationAction,
      deadline: current.blocker.phaseDeadline, observedAt: receipt.observedAt,
      origin: current.blocker.origin, authority: 'NONE',
    }),
  });
}

export function planManagedRoundUpdate(input) {
  try {
    keys(input, ['workKey', 'observation', 'receipt'], 'InvalidInput');
  } catch (error) {
    if (error instanceof DeliveryRoundError) return refusal(error.code);
    throw error;
  }
  let workKey;
  try { workKey = sha256(input.workKey, 'InvalidInput'); } catch (error) {
    return refusal(error.code);
  }
  const observed = validateObservation(input.observation);
  if (observed.error) return refusal(observed.error);
  const parsed = parseManaged(observed.body, workKey);
  if (parsed.error) return refusal(parsed.error);
  if (input.receipt?.schema === 'GaiaRoundDeadlineReceiptV0') {
    return deadlinePlan(workKey, parsed, input.receipt);
  }
  let receipt;
  try { receipt = advanceReceipt(input.receipt); } catch (error) {
    return refusal(error instanceof DeliveryRoundError ? error.code : 'InvalidReceipt');
  }
  if (receipt.kind === 'REFUSED') return receipt;
  const current = parsed.rounds.at(-1);
  const lineage = lineageKey(workKey);
  const expectedR0 = keyForRound(lineage, 0);
  if (parsed.rounds[0].roundKey !== expectedR0) return refusal('ManagedSectionConflict');
  const advanceKey = keyForAdvance(receipt.predecessorRoundKey, receipt.revision);
  if (parsed.rounds.length === 2) {
    if (current.advanceKey === advanceKey) {
      return Object.freeze({ kind: 'ALREADY_APPLIED', idempotencyKey: advanceKey,
        roundKey: current.roundKey });
    }
    return refusal('RoundLineageConflict');
  }
  if (receipt.predecessorRoundKey !== current.roundKey) return refusal('RoundLineageConflict');
  if (parsed.rounds[0].roundBudget <= 1) return refusal('BUDGET_EXHAUSTED');
  const round = Object.freeze({
    ordinal: 1,
    roundKey: keyForRound(lineage, 1),
    receiptRevision: receipt.revision,
    trigger: receipt.trigger,
    advanceKey,
    evidence: receipt.evidence,
  });
  const proposedSection = `${parsed.section.slice(0, -marker(workKey, 'end').length).trimEnd()}\n\n${renderRound(round)}\n${marker(workKey, 'end')}`;
  const proposedBody = observed.body.slice(0, parsed.start) + proposedSection
    + observed.body.slice(parsed.sectionEnd);
  return Object.freeze({
    kind: 'PROPOSED',
    operationId: advanceKey,
    idempotencyKey: advanceKey,
    advanceKey,
    roundKey: round.roundKey,
    expected: Object.freeze({
      number: observed.number, headRevision: observed.headRevision,
      bodyRevision: observed.bodyRevision,
    }),
    proposedBody,
    proposedBodyRevision: revision(proposedBody),
  });
}

function adapterPort(value) {
  if (value === null || typeof value !== 'object'
    || typeof value.observe !== 'function' || typeof value.compareAndSet !== 'function') {
    fail('InvalidAdapter');
  }
  return value;
}

export async function executeManagedRoundUpdate(input) {
  keys(input, ['workKey', 'number', 'receipt', 'adapter'], 'InvalidInput');
  if (!Number.isSafeInteger(input.number) || input.number <= 0) fail('InvalidInput');
  const adapter = adapterPort(input.adapter);
  let observed;
  let mismatch = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    observed = await adapter.observe(input.number);
    const plan = planManagedRoundUpdate({
      workKey: input.workKey, observation: observed, receipt: input.receipt,
    });
    if (plan.kind !== 'PROPOSED') return plan;
    const effect = Object.freeze({
      operationId: plan.operationId,
      idempotencyKey: plan.idempotencyKey,
      number: plan.expected.number,
      expectedHeadRevision: plan.expected.headRevision,
      expectedBodyRevision: plan.expected.bodyRevision,
      proposedBody: plan.proposedBody,
      proposedBodyRevision: plan.proposedBodyRevision,
    });
    const acknowledgement = await adapter.compareAndSet(effect);
    if (acknowledgement?.kind !== 'ACKNOWLEDGED'
      && acknowledgement?.kind !== 'AMBIGUOUS' && acknowledgement?.kind !== 'STALE') {
      fail('AdapterProtocolViolation');
    }
    observed = await adapter.observe(input.number);
    if (observed?.headRevision === plan.expected.headRevision
      && observed?.bodyRevision === plan.proposedBodyRevision
      && observed?.body === plan.proposedBody) {
      return Object.freeze({
        kind: 'APPLIED', operationId: plan.operationId,
        idempotencyKey: plan.idempotencyKey, attempts: attempt, observed,
      });
    }
    mismatch = Object.freeze({
      expectedHeadRevision: plan.expected.headRevision,
      expectedBodyRevision: plan.proposedBodyRevision,
      observedHeadRevision: observed?.headRevision ?? 'UNKNOWN(MISSING)',
      observedBodyRevision: observed?.bodyRevision ?? 'UNKNOWN(MISSING)',
      acknowledgement: acknowledgement.kind,
    });
  }
  return Object.freeze({
    kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS,
    observed, mismatch,
  });
}

