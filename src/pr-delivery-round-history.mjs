import { createHash } from 'node:crypto';

const SHA256 = /^[a-f0-9]{64}$/u;
const GIT_OID = /^[a-f0-9]{40}$/u;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const BLOCKER_CLASSES = new Set([
  'NONE', 'CI', 'REVIEW', 'TEST', 'REPRODUCED_FAILURE', 'DEPENDENCY', 'AUTHORITY', 'UNKNOWN',
]);
const EVIDENCE_TRIGGERS = new Set(['REPRODUCED_BLOCKER', 'REVIEW_RECEIPT', 'CI_RECEIPT', 'TEST_RECEIPT']);
const MAX_ATTEMPTS = 5;
const GITHUB_OWNER = /^github:(?:user|team):[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const GITHUB_EFFECT_OWNER = /^github:(?:user|app):[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u;
const SUPERVISOR = /^gaia:operation:[a-f0-9]{64}$/u;
const EXECUTION_OWNER = /^gaia:lane:[a-f0-9]{64}:[a-f0-9]{40}$/u;
const COMMAND_CAPABILITIES = Object.freeze(['ASSIGN', 'REVOKE', 'STOP', 'RETRY', 'ESCALATE']);

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

function responsibility(value) {
  const code = 'ResponsibilityMalformed';
  try {
    keys(value, [
      'ownershipRevision', 'accountableOwner', 'supervisor', 'executionOwner', 'reportsTo',
      'reviewOwners', 'effectOwner', 'escalatesTo',
    ], code);
    keys(value.reviewOwners, ['standards', 'spec'], code);
  } catch (error) {
    if (error instanceof DeliveryRoundError) fail(code);
    throw error;
  }
  if (Array.isArray(value.effectOwner)) fail('DuplicateEffectAuthority');
  if (!GITHUB_OWNER.test(value.accountableOwner) || !SUPERVISOR.test(value.supervisor)
    || !EXECUTION_OWNER.test(value.executionOwner)
    || !GITHUB_OWNER.test(value.escalatesTo)) fail(code);
  if (value.reportsTo !== value.supervisor && value.reportsTo !== value.accountableOwner) {
    fail('UnresolvableReportsTo');
  }
  const standards = value.reviewOwners.standards;
  const spec = value.reviewOwners.spec;
  if (!GITHUB_OWNER.test(standards) || !GITHUB_OWNER.test(spec) || standards === spec
    || standards === value.effectOwner || spec === value.effectOwner
    || standards === value.executionOwner || spec === value.executionOwner) {
    fail('ReviewOwnerConflict');
  }
  if (value.effectOwner !== 'NONE' && !GITHUB_EFFECT_OWNER.test(value.effectOwner)) {
    fail('DuplicateEffectAuthority');
  }
  return Object.freeze({
    ownershipRevision: sha256(value.ownershipRevision, code),
    accountableOwner: value.accountableOwner,
    supervisor: value.supervisor,
    executionOwner: value.executionOwner,
    reportsTo: value.reportsTo,
    reviewOwners: Object.freeze({ standards, spec }),
    effectOwner: value.effectOwner,
    escalatesTo: value.escalatesTo,
  });
}

function command(value, assignment, expectedGeneration) {
  const code = 'CommandMalformed';
  try {
    keys(value, [
      'commandRevision', 'commandOwner', 'commandPath', 'generation', 'capabilities',
    ], code);
  } catch (error) {
    if (error instanceof DeliveryRoundError) fail(code);
    throw error;
  }
  if (Array.isArray(value.commandOwner)) fail('DualCommandOwner');
  if (value.commandOwner !== assignment.supervisor
    && value.commandOwner !== assignment.accountableOwner) fail('UnresolvableCommandOwner');
  if (!Array.isArray(value.commandPath) || value.commandPath.length !== 2) {
    fail('DualCommandOwner');
  }
  if (value.commandPath[0] === value.commandPath[1]) fail('CommandCycle');
  if (value.commandPath[0] !== value.commandOwner) fail('DualCommandOwner');
  if (value.commandPath[1] !== assignment.executionOwner) fail('OrphanExecutionOwner');
  if (value.generation !== expectedGeneration) fail('StaleCommandGeneration');
  if (!Array.isArray(value.capabilities)
    || value.capabilities.length !== COMMAND_CAPABILITIES.length
    || value.capabilities.some((item, index) => item !== COMMAND_CAPABILITIES[index])) {
    fail(code);
  }
  return Object.freeze({
    commandRevision: sha256(value.commandRevision, code),
    commandOwner: value.commandOwner,
    commandPath: Object.freeze([...value.commandPath]),
    generation: value.generation,
    capabilities: COMMAND_CAPABILITIES,
  });
}

function openReceipt(value, headRevision) {
  keys(value, [
    'schema', 'kind', 'revision', 'ordinal', 'predecessorRoundKey', 'trigger', 'roundBudget',
    'responsibility', 'command', 'evidence',
  ]);
  if (value.schema !== 'GaiaRoundReceiptV0' || value.kind !== 'OPEN' || value.ordinal !== 0
    || value.predecessorRoundKey !== 'NONE' || value.trigger !== 'DRAFT_CREATED'
    || !Number.isSafeInteger(value.roundBudget) || value.roundBudget < 1 || value.roundBudget > 8) {
    fail('InvalidReceipt');
  }
  const assignment = responsibility(value.responsibility);
  return Object.freeze({
    ...value, revision: sha256(value.revision), responsibility: assignment,
    command: command(value.command, assignment, headRevision), evidence: evidence(value.evidence),
  });
}

function advanceReceipt(value, headRevision) {
  if (value?.schema !== 'GaiaRoundReceiptV0' || value?.kind !== 'ADVANCE') fail('InvalidReceipt');
  keys(value, [
    'schema', 'kind', 'revision', 'ordinal', 'predecessorRoundKey', 'trigger',
    'responsibility', 'command', 'evidence',
  ]);
  if (value.ordinal !== 1 || typeof value.predecessorRoundKey !== 'string'
    || !SHA256.test(value.predecessorRoundKey)) fail('InvalidReceipt');
  if (!SHA256.test(value.revision)) {
    return Object.freeze({ kind: 'REFUSED', code: 'MissingBlockerReceipt' });
  }
  if (!EVIDENCE_TRIGGERS.has(value.trigger)) {
    return Object.freeze({ kind: 'REFUSED', code: 'NonEvidenceEvent' });
  }
  const assignment = responsibility(value.responsibility);
  return Object.freeze({
    ...value, responsibility: assignment,
    command: command(value.command, assignment, headRevision), evidence: evidence(value.evidence),
  });
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
    `- Ownership revision: \`${round.responsibility.ownershipRevision}\``,
    `- Accountable owner: \`${round.responsibility.accountableOwner}\``,
    `- Supervisor: \`${round.responsibility.supervisor}\``,
    `- Execution owner: \`${round.responsibility.executionOwner}\``,
    `- Reports to: \`${round.responsibility.reportsTo}\``,
    `- Standards review owner: \`${round.responsibility.reviewOwners.standards}\``,
    `- Spec review owner: \`${round.responsibility.reviewOwners.spec}\``,
    `- Effect owner: \`${round.responsibility.effectOwner}\``,
    `- Escalates to: \`${round.responsibility.escalatesTo}\``,
    `- Command revision: \`${round.command.commandRevision}\``,
    `- Command owner: \`${round.command.commandOwner}\``,
    `- Command path: \`${round.command.commandPath.join(' -> ')}\``,
    `- Command generation: \`${round.command.generation}\``,
    `- Command capabilities: \`${round.command.capabilities.join(',')}\``,
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
    `- Blocker owner: ${round.evidence.blocker.owner}`,
    `- Phase deadline (intervention boundary): ${round.evidence.blocker.phaseDeadline}`,
    `- Next transition: \`${round.evidence.blocker.nextTransition}\``,
    `- Escalation action: \`${round.evidence.blocker.escalationAction}\``,
    `- Blocker origin: ${round.evidence.blocker.origin}`,
    `- Origin: ${round.evidence.origin}`,
  );
  const payload = lines.join('\n');
  return `${payload}\n- Round content revision: \`${revision(payload)}\``;
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
    responsibility: receipt.responsibility,
    command: receipt.command,
    evidence: receipt.evidence,
  });
}

export function createInitialManagedRound(input) {
  keys(input, ['workKey', 'headRevision', 'receipt'], 'InvalidInput');
  const workKey = sha256(input.workKey, 'InvalidInput');
  if (!GIT_OID.test(input.headRevision)) fail('InvalidInput');
  const receipt = openReceipt(input.receipt, input.headRevision);
  const lineage = lineageKey(workKey);
  const round = initialRound(workKey, receipt);
  return Object.freeze({
    kind: 'INITIAL', lineageKey: lineage, roundKey: round.roundKey,
    receiptRevision: receipt.revision,
    effectOwner: receipt.responsibility.effectOwner,
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

function parseManaged(body, workKey, headRevision) {
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
      const roundLines = block.split('\n').filter((line) => !line.startsWith('<!-- gaia-rounds:end:'));
      const revisionLines = roundLines.filter((line) => line.startsWith('- Round content revision: '));
      if (revisionLines.length !== 1) fail('ManagedSectionConflict');
      const recordedContentRevision = revisionLines[0].slice('- Round content revision: `'.length, -1);
      const contentPayload = roundLines.filter(
        (line) => !line.startsWith('- Round content revision: '),
      ).join('\n');
      if (!SHA256.test(recordedContentRevision)
        || revision(contentPayload) !== recordedContentRevision) fail('ManagedSectionConflict');
      const heading = /^#### R(\d+)$/mu.exec(block);
      if (!heading || Number(heading[1]) !== index) fail('ManagedSectionMalformed');
      const blocker = parseField(block, 'Blocker');
      const match = /^(NONE|CI|REVIEW|TEST|REPRODUCED_FAILURE|DEPENDENCY|AUTHORITY|UNKNOWN)(?:\(([^)]+)\))?$/u.exec(blocker);
      if (!match) fail('ManagedSectionMalformed');
      const assignment = responsibility({
        ownershipRevision: parseField(block, 'Ownership revision'),
        accountableOwner: parseField(block, 'Accountable owner'),
        supervisor: parseField(block, 'Supervisor'),
        executionOwner: parseField(block, 'Execution owner'),
        reportsTo: parseField(block, 'Reports to'),
        reviewOwners: {
          standards: parseField(block, 'Standards review owner'),
          spec: parseField(block, 'Spec review owner'),
        },
        effectOwner: parseField(block, 'Effect owner'),
        escalatesTo: parseField(block, 'Escalates to'),
      });
      const commandContract = command({
        commandRevision: parseField(block, 'Command revision'),
        commandOwner: parseField(block, 'Command owner'),
        commandPath: parseField(block, 'Command path').split(' -> '),
        generation: parseField(block, 'Command generation'),
        capabilities: parseField(block, 'Command capabilities').split(','),
      }, assignment, headRevision);
      return Object.freeze({
        ordinal: index,
        roundKey: sha256(parseField(block, 'Round key'), 'ManagedSectionMalformed'),
        receiptRevision: sha256(parseField(block, 'Receipt revision'), 'ManagedSectionMalformed'),
        advanceKey: index === 0 ? null : sha256(parseField(block, 'Advance key'), 'ManagedSectionMalformed'),
        roundBudget: index === 0 ? Number(parseField(block, 'Round budget')) : null,
        responsibility: assignment,
        command: commandContract,
        blocker: Object.freeze({
          class: match[1], reason: match[2] ?? 'NONE',
          owner: parseField(block, 'Blocker owner'),
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
      owner: current.responsibility.escalatesTo, action: current.blocker.escalationAction,
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
  const parsed = parseManaged(observed.body, workKey, observed.headRevision);
  if (parsed.error) return refusal(parsed.error);
  if (input.receipt?.schema === 'GaiaRoundDeadlineReceiptV0') {
    return deadlinePlan(workKey, parsed, input.receipt);
  }
  let receipt;
  try { receipt = advanceReceipt(input.receipt, observed.headRevision); } catch (error) {
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
  const priorResponsibility = { ...current.responsibility };
  delete priorResponsibility.ownershipRevision;
  const nextResponsibility = { ...receipt.responsibility };
  delete nextResponsibility.ownershipRevision;
  if (canonical(priorResponsibility) !== canonical(nextResponsibility)
    && current.responsibility.ownershipRevision === receipt.responsibility.ownershipRevision) {
    return refusal('OwnershipRevisionRequired');
  }
  const priorCommand = { ...current.command };
  delete priorCommand.commandRevision;
  const nextCommand = { ...receipt.command };
  delete nextCommand.commandRevision;
  if (canonical(priorCommand) !== canonical(nextCommand)
    && current.command.commandRevision === receipt.command.commandRevision) {
    return refusal('CommandRevisionRequired');
  }
  const round = Object.freeze({
    ordinal: 1,
    roundKey: keyForRound(lineage, 1),
    receiptRevision: receipt.revision,
    trigger: receipt.trigger,
    advanceKey,
    responsibility: receipt.responsibility,
    command: receipt.command,
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
    receiptRevision: receipt.revision,
    effectOwner: receipt.responsibility.effectOwner,
    expected: Object.freeze({
      number: observed.number, headRevision: observed.headRevision,
      bodyRevision: observed.bodyRevision,
    }),
    proposedBody,
    proposedBodyRevision: revision(proposedBody),
  });
}

function ownedClone(value, code = 'AdapterProtocolViolation') {
  try {
    const cloned = JSON.parse(canonical(value));
    if (cloned === null || typeof cloned !== 'object' || Array.isArray(cloned)) fail(code);
    return cloned;
  } catch (error) {
    if (error instanceof DeliveryRoundError) throw error;
    fail(code);
  }
}

function adapterPort(value, create = false) {
  if (value === null || typeof value !== 'object'
    || typeof value.observe !== 'function' || typeof value.compareAndSet !== 'function'
    || (create && (typeof value.createDraft !== 'function'
      || typeof value.observeByOperation !== 'function'))) fail('InvalidAdapter');
  return value;
}

function evidencePort(value) {
  if (value === null || typeof value !== 'object'
    || typeof value.read !== 'function' || typeof value.compareAndAppend !== 'function'
    || typeof value.leaseState !== 'function') {
    fail('InvalidEvidencePort');
  }
  return value;
}

function validateEvidenceRecord(value) {
  const code = 'EvidenceProtocolViolation';
  try {
    if (value?.kind === 'INTENT') {
      keys(value, [
        'schema', 'kind', 'workKey', 'operationId', 'idempotencyKey', 'transition', 'attempt',
        'expectedHeadRevision', 'expectedBodyRevision', 'proposedBodyRevision', 'effectOwner',
        'receiptRevision',
      ], code);
      if (value.schema !== 'GaiaManagedRoundEvidenceV0' || !SHA256.test(value.workKey)
        || !SHA256.test(value.operationId) || value.idempotencyKey !== value.operationId
        || !['CREATE_R0', 'ADVANCE_R1'].includes(value.transition)
        || !Number.isSafeInteger(value.attempt) || value.attempt < 1 || value.attempt > MAX_ATTEMPTS
        || !GIT_OID.test(value.expectedHeadRevision) || !SHA256.test(value.expectedBodyRevision)
        || !SHA256.test(value.proposedBodyRevision) || !GITHUB_EFFECT_OWNER.test(value.effectOwner)
        || !SHA256.test(value.receiptRevision)) fail(code);
      return Object.freeze(ownedClone(value, code));
    }
    if (value?.kind === 'CLAIM') {
      keys(value, [
        'schema', 'kind', 'workKey', 'operationId', 'idempotencyKey', 'intentRevision',
        'claimId', 'claimReceiptRevision', 'observedAt', 'leaseExpiresAt',
        'predecessorClaimRevision',
      ], code);
      if (value.schema !== 'GaiaManagedRoundEvidenceV0' || !SHA256.test(value.workKey)
        || !SHA256.test(value.operationId) || value.idempotencyKey !== value.operationId
        || !SHA256.test(value.intentRevision) || !SHA256.test(value.claimId)
        || !SHA256.test(value.claimReceiptRevision)
        || !ISO_INSTANT.test(value.observedAt) || !ISO_INSTANT.test(value.leaseExpiresAt)
        || (value.predecessorClaimRevision !== 'NONE'
          && !SHA256.test(value.predecessorClaimRevision))) fail(code);
      const duration = Date.parse(value.leaseExpiresAt) - Date.parse(value.observedAt);
      if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 10 * 60 * 1000) fail(code);
      return Object.freeze(ownedClone(value, code));
    }
    if (value?.kind === 'APPLIED') {
      keys(value, [
        'schema', 'kind', 'workKey', 'operationId', 'idempotencyKey', 'intentRevision',
        'claimRevision', 'providerReceipt', 'result',
      ], code);
      keys(value.providerReceipt, [
        'schema', 'operationId', 'number', 'headRevision', 'bodyRevision',
      ], code);
      keys(value.result, [
        'kind', 'operationId', 'idempotencyKey', 'attempts', 'observed',
      ], code);
      const observed = validateObservation(value.result.observed);
      if (value.schema !== 'GaiaManagedRoundEvidenceV0' || !SHA256.test(value.workKey)
        || !SHA256.test(value.operationId) || value.idempotencyKey !== value.operationId
        || !SHA256.test(value.intentRevision)
        || (value.claimRevision !== 'NONE' && !SHA256.test(value.claimRevision))
        || value.providerReceipt.schema !== 'GaiaGitHubRoundEffectReceiptV0'
        || value.providerReceipt.operationId !== value.operationId
        || value.result.kind !== 'APPLIED' || value.result.operationId !== value.operationId
        || value.result.idempotencyKey !== value.operationId
        || !Number.isSafeInteger(value.result.attempts) || value.result.attempts < 1
        || value.result.attempts > MAX_ATTEMPTS || observed.error
        || value.providerReceipt.number !== observed.number
        || value.providerReceipt.headRevision !== observed.headRevision
        || value.providerReceipt.bodyRevision !== observed.bodyRevision) fail(code);
      return Object.freeze(ownedClone(value, code));
    }
  } catch (error) {
    if (error instanceof DeliveryRoundError) fail(code);
    throw error;
  }
  fail(code);
}

function validateEvidenceSnapshot(value) {
  if (value?.state === 'UNSEEN') return Object.freeze({ state: 'UNSEEN', version: 'NONE', records: [] });
  if (value?.state !== 'PRESENT' || typeof value.version !== 'string'
    || !Array.isArray(value.records) || value.records.length === 0) fail('EvidenceProtocolViolation');
  const records = value.records.map(validateEvidenceRecord);
  const operations = new Map();
  for (const record of records) {
    const prior = operations.get(record.operationId) ?? [];
    if (record.kind === 'INTENT') {
      if (prior.some((candidate) => candidate.kind === 'APPLIED')) fail('EvidenceProtocolViolation');
      const lastAttempt = prior.findLast((candidate) => candidate.kind === 'INTENT')?.attempt ?? 0;
      if (record.attempt <= lastAttempt) fail('EvidenceProtocolViolation');
    } else if (record.kind === 'CLAIM') {
      const intent = prior.findLast((candidate) => candidate.kind === 'INTENT');
      const previousClaim = prior.findLast((candidate) => candidate.kind === 'CLAIM');
      if (!intent || record.intentRevision !== recordRevision(intent)
        || prior.some((candidate) => candidate.kind === 'APPLIED')
        || record.predecessorClaimRevision !== (previousClaim
          ? recordRevision(previousClaim) : 'NONE')
        ) {
        fail('EvidenceProtocolViolation');
      }
    } else {
      const intent = prior.findLast((candidate) => candidate.kind === 'INTENT');
      const claim = prior.findLast((candidate) => candidate.kind === 'CLAIM');
      if (!intent || record.intentRevision !== recordRevision(intent)
        || prior.some((candidate) => candidate.kind === 'APPLIED')
        || (intent.transition === 'CREATE_R0' && !claim)
        || record.claimRevision !== (intent.transition === 'CREATE_R0'
          ? recordRevision(claim) : 'NONE')) fail('EvidenceProtocolViolation');
    }
    prior.push(record);
    operations.set(record.operationId, prior);
  }
  return Object.freeze({
    state: 'PRESENT', version: value.version,
    records: Object.freeze(records),
  });
}

function recordRevision(record) {
  return revision(record);
}

function terminalFor(snapshot, operationId) {
  return snapshot.records.findLast(
    (record) => record.kind === 'APPLIED' && record.operationId === operationId,
  ) ?? null;
}

function intentFor(snapshot, operationId) {
  return snapshot.records.findLast(
    (record) => record.kind === 'INTENT' && record.operationId === operationId,
  ) ?? null;
}

function claimFor(snapshot, operationId) {
  return snapshot.records.findLast(
    (record) => record.kind === 'CLAIM' && record.operationId === operationId,
  ) ?? null;
}

async function readEvidence(port, workKey) {
  return validateEvidenceSnapshot(await port.read(workKey));
}

async function persistIntent(port, intent) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const before = await readEvidence(port, intent.workKey);
    const terminal = terminalFor(before, intent.operationId);
    if (terminal) return { terminal };
    const existingIntent = intentFor(before, intent.operationId);
    if (existingIntent && canonical(existingIntent) === canonical(intent)) {
      return { intent: existingIntent, intentRevision: recordRevision(existingIntent), created: false };
    }
    const latest = before.records.at(-1);
    if (latest?.kind === 'INTENT' && latest.operationId !== intent.operationId) {
      return { refusal: refusal('EvidenceLineageConflict') };
    }
    if (latest?.kind === 'INTENT' && latest.operationId === intent.operationId
      && canonical(latest) === canonical(intent)) {
      return { intent: latest, intentRevision: recordRevision(latest) };
    }
    if (latest?.kind === 'INTENT' && latest.operationId === intent.operationId
      && (!Number.isSafeInteger(latest.attempt) || latest.attempt >= intent.attempt)) {
      return { refusal: refusal('EvidenceIntentConflict') };
    }
    let acknowledgement;
    try {
      acknowledgement = await port.compareAndAppend(intent.workKey, before.version, intent);
    } catch {
      acknowledgement = { kind: 'AMBIGUOUS' };
    }
    if (!['APPENDED', 'STALE', 'AMBIGUOUS'].includes(acknowledgement?.kind)) {
      fail('EvidenceProtocolViolation');
    }
    const after = await readEvidence(port, intent.workKey);
    const stored = after.records.findLast(
      (record) => record.kind === 'INTENT'
        && record.operationId === intent.operationId
        && canonical(record) === canonical(intent),
    );
    if (stored) return {
      intent: stored,
      intentRevision: recordRevision(stored),
      created: acknowledgement.kind === 'APPENDED',
    };
    const competing = after.records.at(-1);
    if (competing?.kind === 'INTENT' && competing.operationId !== intent.operationId) {
      return { refusal: refusal('EvidenceLineageConflict') };
    }
  }
  return { refusal: Object.freeze({
    kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS,
  }) };
}

function providerReceipt(operationId, observed) {
  const valid = validateObservation(observed);
  if (valid.error) fail('AdapterProtocolViolation');
  return Object.freeze({
    schema: 'GaiaGitHubRoundEffectReceiptV0', operationId,
    number: valid.number, headRevision: valid.headRevision, bodyRevision: valid.bodyRevision,
  });
}

function appliedRecord(intent, intentRevision, claimRevision, attempts, observed) {
  const result = Object.freeze({
    kind: 'APPLIED', operationId: intent.operationId, idempotencyKey: intent.idempotencyKey,
    attempts, observed: Object.freeze(ownedClone(observed)),
  });
  return Object.freeze({
    schema: 'GaiaManagedRoundEvidenceV0', kind: 'APPLIED', workKey: intent.workKey,
    operationId: intent.operationId, idempotencyKey: intent.idempotencyKey,
    intentRevision, claimRevision,
    providerReceipt: providerReceipt(intent.operationId, observed), result,
  });
}

async function persistApplied(port, record) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const before = await readEvidence(port, record.workKey);
    const existing = terminalFor(before, record.operationId);
    if (existing) {
      if (canonical(existing) !== canonical(record)) fail('EvidenceTerminalConflict');
      return Object.freeze(ownedClone(existing.result));
    }
    const latestIntent = intentFor(before, record.operationId);
    if (!latestIntent || recordRevision(latestIntent) !== record.intentRevision) {
      return Object.freeze({
        kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS,
      });
    }
    let acknowledgement;
    try {
      acknowledgement = await port.compareAndAppend(record.workKey, before.version, record);
    } catch {
      acknowledgement = { kind: 'AMBIGUOUS' };
    }
    if (!['APPENDED', 'STALE', 'AMBIGUOUS'].includes(acknowledgement?.kind)) {
      fail('EvidenceProtocolViolation');
    }
    const after = await readEvidence(port, record.workKey);
    const stored = terminalFor(after, record.operationId);
    if (stored) {
      if (canonical(stored) !== canonical(record)) fail('EvidenceTerminalConflict');
      return Object.freeze(ownedClone(stored.result));
    }
  }
  return Object.freeze({
    kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS,
  });
}

function makeIntent({ workKey, operationId, transition, attempt, expectedHeadRevision,
  expectedBodyRevision, proposedBodyRevision, effectOwner, receiptRevision }) {
  return Object.freeze({
    schema: 'GaiaManagedRoundEvidenceV0', kind: 'INTENT', workKey, operationId,
    idempotencyKey: operationId, transition, attempt, expectedHeadRevision,
    expectedBodyRevision, proposedBodyRevision, effectOwner, receiptRevision,
  });
}

function effectClaim(value) {
  const code = 'InvalidEffectClaim';
  try {
    keys(value, [
      'schema', 'revision', 'claimId', 'observedAt', 'leaseExpiresAt',
    ], code);
  } catch (error) {
    if (error instanceof DeliveryRoundError) fail(code);
    throw error;
  }
  if (value.schema !== 'GaiaManagedRoundEffectClaimV0' || !SHA256.test(value.revision)
    || !SHA256.test(value.claimId) || !ISO_INSTANT.test(value.observedAt)
    || !ISO_INSTANT.test(value.leaseExpiresAt)) fail(code);
  const duration = Date.parse(value.leaseExpiresAt) - Date.parse(value.observedAt);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 10 * 60 * 1000) fail(code);
  return Object.freeze(ownedClone(value, code));
}

function makeClaim(intent, intentRevision, receipt, predecessorClaimRevision) {
  return Object.freeze({
    schema: 'GaiaManagedRoundEvidenceV0', kind: 'CLAIM', workKey: intent.workKey,
    operationId: intent.operationId, idempotencyKey: intent.idempotencyKey, intentRevision,
    claimId: receipt.claimId, claimReceiptRevision: receipt.revision,
    observedAt: receipt.observedAt, leaseExpiresAt: receipt.leaseExpiresAt,
    predecessorClaimRevision,
  });
}

async function persistClaim(port, adapter, intent, intentRevision, receipt) {
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const before = await readEvidence(port, intent.workKey);
    const terminal = terminalFor(before, intent.operationId);
    if (terminal) return { terminal };
    const durableIntent = intentFor(before, intent.operationId);
    if (!durableIntent || recordRevision(durableIntent) !== intentRevision) {
      return { refusal: refusal('EvidenceIntentConflict') };
    }
    const prior = claimFor(before, intent.operationId);
    if (prior) {
      const leaseState = await port.leaseState(intent.workKey, ownedClone(prior));
      if (!['ACTIVE', 'EXPIRED', 'UNKNOWN'].includes(leaseState)) {
        fail('EvidenceProtocolViolation');
      }
      if (leaseState === 'ACTIVE') return { refusal: refusal('EffectClaimHeld') };
      if (leaseState === 'UNKNOWN') return { refusal: refusal('LeaseExpiryUnproven') };
      const absence = typeof adapter.proveCreateAbsent === 'function'
        ? await adapter.proveCreateAbsent(intent.operationId) : 'UNKNOWN';
      if (!['PROVEN_ABSENT', 'UNKNOWN'].includes(absence)) fail('AdapterProtocolViolation');
      if (absence !== 'PROVEN_ABSENT') return { refusal: Object.freeze({
        kind: 'BLOCKED', code: 'CREATE_OUTCOME_AMBIGUOUS', attempts: MAX_ATTEMPTS,
      }) };
    }
    const claim = makeClaim(
      intent, intentRevision, receipt, prior ? recordRevision(prior) : 'NONE',
    );
    let acknowledgement;
    try {
      acknowledgement = await port.compareAndAppend(intent.workKey, before.version, claim);
    } catch {
      acknowledgement = { kind: 'AMBIGUOUS' };
    }
    if (!['APPENDED', 'STALE', 'AMBIGUOUS'].includes(acknowledgement?.kind)) {
      fail('EvidenceProtocolViolation');
    }
    const after = await readEvidence(port, intent.workKey);
    const stored = claimFor(after, intent.operationId);
    if (stored && canonical(stored) === canonical(claim)
      && acknowledgement.kind !== 'STALE') {
      return { claim: stored, claimRevision: recordRevision(stored) };
    }
    if (terminalFor(after, intent.operationId)) {
      return { terminal: terminalFor(after, intent.operationId) };
    }
    if (claimFor(after, intent.operationId)) return { refusal: refusal('EffectClaimHeld') };
  }
  return { refusal: Object.freeze({
    kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS,
  }) };
}

export function createMemoryManagedRoundEvidencePort({ authoritativeNow } = {}) {
  if (authoritativeNow !== undefined && typeof authoritativeNow !== 'function') {
    fail('InvalidEvidencePort');
  }
  const ledgers = new Map();
  const calls = [];
  return Object.freeze({
    calls,
    async leaseState(workKey, claim) {
      calls.push({ method: 'leaseState', workKey, claim: ownedClone(claim) });
      if (authoritativeNow === undefined) return 'UNKNOWN';
      const now = authoritativeNow();
      if (typeof now !== 'string' || !ISO_INSTANT.test(now)) fail('EvidenceProtocolViolation');
      return Date.parse(now) < Date.parse(claim.leaseExpiresAt) ? 'ACTIVE' : 'EXPIRED';
    },
    async read(workKey) {
      calls.push({ method: 'read', workKey });
      const records = ledgers.get(workKey) ?? [];
      if (records.length === 0) return { state: 'UNSEEN' };
      return {
        state: 'PRESENT', version: revision(records),
        records: records.map((record) => ownedClone(record)),
      };
    },
    async compareAndAppend(workKey, expectedVersion, record) {
      calls.push({ method: 'compareAndAppend', workKey, expectedVersion, record: ownedClone(record) });
      const records = ledgers.get(workKey) ?? [];
      const current = records.length === 0 ? 'NONE' : revision(records);
      if (current !== expectedVersion) return { kind: 'STALE', currentVersion: current };
      records.push(ownedClone(record));
      ledgers.set(workKey, records);
      return { kind: 'APPENDED', version: revision(records) };
    },
  });
}

export function createGitHubManagedRoundEvidencePort({ gitData } = {}) {
  if (gitData === null || typeof gitData !== 'object'
    || typeof gitData.read !== 'function' || typeof gitData.compareAndAppend !== 'function') {
    fail('InvalidEvidencePort');
  }
  const ref = (workKey) => `refs/heads/gaia-ledger/managed-rounds-v0/${sha256(workKey, 'InvalidWorkKey')}`;
  return Object.freeze({
    async leaseState() { return 'UNKNOWN'; },
    async read(workKey) {
      const observed = await gitData.read(ref(workKey));
      if (observed?.state === 'UNSEEN') return { state: 'UNSEEN' };
      if (observed?.state !== 'PRESENT' || !Array.isArray(observed.records)
        || observed.records.length === 0) fail('EvidenceProtocolViolation');
      return {
        state: 'PRESENT', version: observed.records.at(-1)?.oid,
        records: observed.records.map((record) => ownedClone(record.body, 'EvidenceProtocolViolation')),
      };
    },
    async compareAndAppend(workKey, expectedVersion, record) {
      const result = await gitData.compareAndAppend(ref(workKey), expectedVersion, record);
      if (result?.kind === 'STALE') return { kind: 'STALE', currentVersion: result.currentHeadOid };
      if (result?.kind !== 'APPENDED') fail('EvidenceProtocolViolation');
      return { kind: 'APPENDED', version: result.oid };
    },
  });
}

export function createMemoryManagedRoundAdapter({ observations = [] } = {}) {
  if (!Array.isArray(observations)) fail('InvalidAdapter');
  const drafts = new Map();
  const operations = new Map();
  const calls = [];
  for (const item of observations) {
    const observed = validateObservation(item);
    if (observed.error) fail('InvalidAdapter');
    drafts.set(item.number, ownedClone(item));
  }
  let nextNumber = Math.max(68, ...drafts.keys()) + 1;
  return Object.freeze({
    calls,
    async observe(number) {
      calls.push({ method: 'observe', number });
      return drafts.has(number) ? ownedClone(drafts.get(number)) : null;
    },
    async observeByOperation(operationId) {
      calls.push({ method: 'observeByOperation', operationId });
      const number = operations.get(operationId);
      return number === undefined ? null : ownedClone(drafts.get(number));
    },
    async proveCreateAbsent(operationId) {
      calls.push({ method: 'proveCreateAbsent', operationId });
      return operations.has(operationId) ? 'UNKNOWN' : 'PROVEN_ABSENT';
    },
    async createDraft(effect) {
      calls.push({ method: 'createDraft', effect: ownedClone(effect) });
      const existing = operations.get(effect.operationId);
      if (existing !== undefined) return { kind: 'ACKNOWLEDGED', number: existing };
      const number = nextNumber;
      nextNumber += 1;
      const observed = {
        number, headRevision: effect.expectedHeadRevision,
        body: effect.proposedBody, bodyRevision: revision(effect.proposedBody),
      };
      drafts.set(number, observed);
      operations.set(effect.operationId, number);
      return { kind: 'ACKNOWLEDGED', number };
    },
    async compareAndSet(effect) {
      calls.push({ method: 'compareAndSet', effect: ownedClone(effect) });
      const current = drafts.get(effect.number);
      if (current?.headRevision !== effect.expectedHeadRevision
        || current?.bodyRevision !== effect.expectedBodyRevision) return { kind: 'STALE' };
      drafts.set(effect.number, {
        number: effect.number, headRevision: effect.expectedHeadRevision,
        body: effect.proposedBody, bodyRevision: effect.proposedBodyRevision,
      });
      operations.set(effect.operationId, effect.number);
      return { kind: 'ACKNOWLEDGED' };
    },
  });
}

export function createGitHubManagedRoundAdapter({ api } = {}) {
  if (api === null || typeof api !== 'object' || typeof api.createDraft !== 'function'
    || typeof api.observe !== 'function' || typeof api.observeByOperation !== 'function') {
    fail('InvalidAdapter');
  }
  if (typeof api.compareAndSetBody !== 'function') fail('AtomicCasUnavailable');
  return Object.freeze({
    createDraft: (effect) => api.createDraft(effect),
    observe: (number) => api.observe(number),
    observeByOperation: (operationId) => api.observeByOperation(operationId),
    proveCreateAbsent: (operationId) => (typeof api.proveCreateAbsent === 'function'
      ? api.proveCreateAbsent(operationId) : 'UNKNOWN'),
    compareAndSet: (effect) => api.compareAndSetBody(effect),
  });
}

function exactPostcondition(observed, expectedHeadRevision, proposedBodyRevision, proposedBody) {
  return observed?.headRevision === expectedHeadRevision
    && observed?.bodyRevision === proposedBodyRevision && observed?.body === proposedBody;
}

async function reconcileExisting(port, operationId, observed) {
  const snapshot = await readEvidence(port, observed.workKey);
  const terminal = terminalFor(snapshot, operationId);
  if (terminal) return Object.freeze(ownedClone(terminal.result));
  const intent = intentFor(snapshot, operationId);
  if (!intent || !exactPostcondition(
    observed.observation, intent.expectedHeadRevision, intent.proposedBodyRevision,
    observed.observation.body,
  )) return null;
  const record = appliedRecord(
    intent, recordRevision(intent), 'NONE', intent.attempt, observed.observation,
  );
  return persistApplied(port, record);
}

// Validate configuration without constructing a runtime, recording intent, or calling a provider.
// Exact request/head binding and durable effect authorization still run at execution time.
export function validateManagedDraftConfiguration(input) {
  keys(input, ['receipt', 'effectActor', 'effectClaim'], 'InvalidInput');
  effectClaim(input.effectClaim);
  const headRevision = input.receipt?.command?.generation;
  if (typeof headRevision !== 'string' || !GIT_OID.test(headRevision)) fail('InvalidReceipt');
  const receipt = openReceipt(input.receipt, headRevision);
  if (receipt.responsibility.effectOwner === 'NONE') fail('EffectAuthorityAbsent');
  if (input.effectActor !== receipt.responsibility.effectOwner) fail('EffectOwnerMismatch');
}

export async function executeManagedDraftCreation(input) {
  keys(input, [
    'workKey', 'headRevision', 'baseBody', 'receipt', 'effectActor', 'effectClaim',
    'adapter', 'evidencePort',
  ], 'InvalidInput');
  if (typeof input.baseBody !== 'string' || typeof input.effectActor !== 'string') fail('InvalidInput');
  const workKey = sha256(input.workKey, 'InvalidInput');
  const adapter = adapterPort(input.adapter, true);
  const durable = evidencePort(input.evidencePort);
  const claimReceipt = effectClaim(input.effectClaim);
  const initial = createInitialManagedRound({
    workKey, headRevision: input.headRevision, receipt: input.receipt,
  });
  if (/<!-- gaia-rounds:(?:begin|end):/u.test(input.baseBody)) {
    return refusal('ManagedSectionConflict');
  }
  if (initial.effectOwner === 'NONE') return refusal('EffectAuthorityAbsent');
  if (input.effectActor !== initial.effectOwner) return refusal('EffectOwnerMismatch');
  const proposedBody = input.baseBody.length === 0
    ? initial.managedSection : `${input.baseBody}\n\n${initial.managedSection}`;
  const proposedBodyRevision = revision(proposedBody);
  const intent = makeIntent({
    workKey, operationId: initial.roundKey, transition: 'CREATE_R0', attempt: 1,
    expectedHeadRevision: input.headRevision, expectedBodyRevision: revision(input.baseBody),
    proposedBodyRevision, effectOwner: initial.effectOwner,
    receiptRevision: initial.receiptRevision,
  });
  const persisted = await persistIntent(durable, intent);
  if (persisted.terminal) return Object.freeze(ownedClone(persisted.terminal.result));
  if (persisted.refusal) return persisted.refusal;
  let observed = await adapter.observeByOperation(initial.roundKey);
  let appliedClaimRevision;
  if (!exactPostcondition(observed, input.headRevision, proposedBodyRevision, proposedBody)) {
    const claimed = await persistClaim(
      durable, adapter, intent, persisted.intentRevision, claimReceipt,
    );
    if (claimed.terminal) return Object.freeze(ownedClone(claimed.terminal.result));
    if (claimed.refusal) return claimed.refusal;
    appliedClaimRevision = claimed.claimRevision;
    const effect = Object.freeze({
      operationId: initial.roundKey, idempotencyKey: initial.roundKey, workKey,
      expectedHeadRevision: input.headRevision, expectedBodyRevision: revision(input.baseBody),
      proposedBody, proposedBodyRevision, effectOwner: initial.effectOwner,
      effectActor: input.effectActor,
    });
    const acknowledgement = await adapter.createDraft(effect);
    if (!['ACKNOWLEDGED', 'AMBIGUOUS'].includes(acknowledgement?.kind)) {
      fail('AdapterProtocolViolation');
    }
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      observed = await adapter.observeByOperation(initial.roundKey);
      if (!observed && Number.isSafeInteger(acknowledgement.number)) {
        observed = await adapter.observe(acknowledgement.number);
      }
      if (exactPostcondition(observed, input.headRevision, proposedBodyRevision, proposedBody)) break;
    }
  } else {
    const priorClaim = claimFor(await readEvidence(durable, workKey), initial.roundKey);
    if (!priorClaim) return Object.freeze({
      kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS, observed,
    });
    appliedClaimRevision = recordRevision(priorClaim);
  }
  if (!exactPostcondition(observed, input.headRevision, proposedBodyRevision, proposedBody)) {
    return Object.freeze({
      kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS, observed,
    });
  }
  return persistApplied(durable, appliedRecord(
    intent, persisted.intentRevision, appliedClaimRevision, 1, observed,
  ));
}

export async function executeManagedRoundUpdate(input) {
  keys(input, [
    'workKey', 'number', 'receipt', 'effectActor', 'adapter', 'evidencePort',
  ], 'InvalidInput');
  if (!Number.isSafeInteger(input.number) || input.number <= 0) fail('InvalidInput');
  if (typeof input.effectActor !== 'string') fail('InvalidInput');
  const workKey = sha256(input.workKey, 'InvalidInput');
  const adapter = adapterPort(input.adapter);
  const durable = evidencePort(input.evidencePort);
  let observed;
  let mismatch = null;
  let pendingEffect = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    observed = await adapter.observe(input.number);
    if (pendingEffect !== null) {
      if (exactPostcondition(
        observed,
        pendingEffect.plan.expected.headRevision,
        pendingEffect.plan.proposedBodyRevision,
        pendingEffect.plan.proposedBody,
      )) {
        return persistApplied(durable, appliedRecord(
          pendingEffect.intent, pendingEffect.intentRevision, 'NONE', attempt, observed,
        ));
      }
      mismatch = Object.freeze({
        expectedHeadRevision: pendingEffect.plan.expected.headRevision,
        expectedBodyRevision: pendingEffect.plan.proposedBodyRevision,
        observedHeadRevision: observed?.headRevision ?? 'UNKNOWN(MISSING)',
        observedBodyRevision: observed?.bodyRevision ?? 'UNKNOWN(MISSING)',
        acknowledgement: pendingEffect.acknowledgement,
      });
      continue;
    }
    const plan = planManagedRoundUpdate({ workKey, observation: observed, receipt: input.receipt });
    if (plan.kind === 'ALREADY_APPLIED') {
      const reconciled = await reconcileExisting(durable, plan.idempotencyKey, {
        workKey, observation: observed,
      });
      return reconciled ?? Object.freeze({
        kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS, observed,
      });
    }
    if (plan.kind !== 'PROPOSED') return plan;
    if (plan.effectOwner === 'NONE') return refusal('EffectAuthorityAbsent');
    if (input.effectActor !== plan.effectOwner) return refusal('EffectOwnerMismatch');
    const intent = makeIntent({
      workKey, operationId: plan.operationId, transition: 'ADVANCE_R1', attempt,
      expectedHeadRevision: plan.expected.headRevision,
      expectedBodyRevision: plan.expected.bodyRevision,
      proposedBodyRevision: plan.proposedBodyRevision, effectOwner: plan.effectOwner,
      receiptRevision: plan.receiptRevision,
    });
    const persisted = await persistIntent(durable, intent);
    if (persisted.terminal) return Object.freeze(ownedClone(persisted.terminal.result));
    if (persisted.refusal) return persisted.refusal;
    if (!persisted.created) {
      pendingEffect = Object.freeze({
        plan, intent, intentRevision: persisted.intentRevision, acknowledgement: 'AMBIGUOUS',
      });
      mismatch = Object.freeze({
        expectedHeadRevision: plan.expected.headRevision,
        expectedBodyRevision: plan.proposedBodyRevision,
        observedHeadRevision: observed?.headRevision ?? 'UNKNOWN(MISSING)',
        observedBodyRevision: observed?.bodyRevision ?? 'UNKNOWN(MISSING)',
        acknowledgement: 'AMBIGUOUS',
      });
      continue;
    }
    const effect = Object.freeze({
      operationId: plan.operationId, idempotencyKey: plan.idempotencyKey,
      number: plan.expected.number, expectedHeadRevision: plan.expected.headRevision,
      expectedBodyRevision: plan.expected.bodyRevision, proposedBody: plan.proposedBody,
      proposedBodyRevision: plan.proposedBodyRevision, effectOwner: plan.effectOwner,
      effectActor: input.effectActor,
    });
    const acknowledgement = await adapter.compareAndSet(effect);
    if (!['ACKNOWLEDGED', 'AMBIGUOUS', 'STALE'].includes(acknowledgement?.kind)) {
      fail('AdapterProtocolViolation');
    }
    observed = await adapter.observe(input.number);
    if (exactPostcondition(
      observed, plan.expected.headRevision, plan.proposedBodyRevision, plan.proposedBody,
    )) {
      return persistApplied(durable, appliedRecord(
        intent, persisted.intentRevision, 'NONE', attempt, observed,
      ));
    }
    mismatch = Object.freeze({
      expectedHeadRevision: plan.expected.headRevision,
      expectedBodyRevision: plan.proposedBodyRevision,
      observedHeadRevision: observed?.headRevision ?? 'UNKNOWN(MISSING)',
      observedBodyRevision: observed?.bodyRevision ?? 'UNKNOWN(MISSING)',
      acknowledgement: acknowledgement.kind,
    });
    if (acknowledgement.kind !== 'STALE') {
      pendingEffect = Object.freeze({
        plan, intent, intentRevision: persisted.intentRevision,
        acknowledgement: acknowledgement.kind,
      });
    }
  }
  return Object.freeze({
    kind: 'BLOCKED', code: 'POSTCONDITION_UNPROVEN', attempts: MAX_ATTEMPTS,
    observed, mismatch,
  });
}
