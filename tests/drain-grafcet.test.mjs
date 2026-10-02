/**
 * drain-grafcet.test.mjs — the drain chart as documentation the drain agents are bound to (#102).
 *
 * docs/drain-grafcet.md carries a block rendered from DRAIN_NET_TEMPLATE, the pull-request drain
 * that src/drain-petri-net.mjs interprets. This file renders it again and fails when the two
 * differ, so the doc cannot drift from the machine. The doc then binds the three agents under
 * .claude/agents/ to that chart:
 *   - every refusal or blocker an agent can return has one binding row naming the agents that
 *     return it and the chart ids it reads, and a refusal the chart also names reads that
 *     transition's receptivity;
 *   - every refusal of the chart is bound, or listed with the transitions that refuse with it;
 *   - every coordinator class is a predicate over receptivities its own bullet names, the ones
 *     this file's model of the class reads, and the model's classes partition every head;
 *   - every receptivity is read by a binding or a class, or listed as read by no agent, with why.
 * The bindings are prose read lexically: a prompt can name the right id and still be followed
 * wrongly. What they rule out is a refusal, a class or a receptivity that names nothing.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { DRAIN_NET_TEMPLATE, revisionOf } from '../src/drain-petri-net.mjs';
import { parseArtifact } from '../src/drain-petri-net-facts.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOC = 'docs/drain-grafcet.md';
const AGENT_PATHS = {
  coordinator: '.claude/agents/github-drain-coordinator.md',
  reviewer: '.claude/agents/github-drain-reviewer.md',
  publisher: '.claude/agents/github-drain-publisher.md',
};
const BEGIN = '<!-- BEGIN chart: rendered from DRAIN_NET_TEMPLATE by tests/drain-grafcet.test.mjs; '
  + 'edit the template, not this block -->';
const END = '<!-- END chart -->';

const read = (path) => readFileSync(join(ROOT, path), 'utf8');
const readAgents = () => Object.fromEntries(Object.entries(AGENT_PATHS).map(([role, path]) => [role, read(path)]));

/** The body of the `## heading` section of a Markdown text, up to the next `## ` heading. */
function section(text, heading) {
  const marker = `\n## ${heading}\n`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n## /u);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const ticked = (text) => [...text.matchAll(/`([A-Za-z0-9_-]+)`/gu)].map(([, id]) => id);
const tableCodes = (text) => [...text.matchAll(/^\| `([A-Z0-9_]+)` \|/gmu)].map(([, code]) => code);
const bulletCodes = (text) => [...text.matchAll(/^- `([A-Z0-9_]+)`:/gmu)].map(([, code]) => code);

// ---------------------------------------------------------------------------
// the rendering
// ---------------------------------------------------------------------------

const cell = (text) => String(text).replaceAll('|', '\\|').replaceAll('*', '\\*');
const code = (id) => `\`${id}\``;
const arc = (value) => (typeof value === 'string' ? code(value) : `${value.weight} × ${code(value.place)}`);
const arcs = (values = []) => (values.length === 0 ? '—' : values.map(arc).join(', '));
const placeOf = (value) => (typeof value === 'string' ? value : value.place);

/** The Mermaid chart: steps as nodes, transitions between them, resources left to the tables. */
function mermaid(template) {
  const steps = new Set(template.places.map(({ id }) => id));
  const node = ({ id, terminal }) => (terminal ? `  ${id}((("${id}")))` : `  ${id}(["${id}"])`);
  return [
    'flowchart TD',
    ...template.places.map(node),
    ...template.transitions.flatMap((transition) => [
      `  ${transition.id}{{"${transition.id}: ${transition.receptivity}"}}`,
      ...(transition.inputs ?? []).map(placeOf).filter((id) => steps.has(id))
        .map((id) => `  ${id} --> ${transition.id}`),
      ...(transition.outputs ?? []).map(placeOf).filter((id) => steps.has(id))
        .map((id) => `  ${transition.id} --> ${id}`),
      ...(transition.inhibitors ?? []).map(placeOf)
        .map((id) => `  ${id} -. inhibits .-> ${transition.id}`),
    ]),
  ];
}

/** The doc block for one net template: its places, receptivities, transitions and chart. */
function renderChart(template) {
  const places = [
    ...template.shared.map((place) => ({ ...place, kind: 'shared resource' })),
    ...template.places.map((place) => ({ ...place, kind: place.terminal ? 'step, terminal' : 'step' })),
  ];
  return [
    `Net ${code(template.netId)}, template revision ${code(revisionOf(template))}.`,
    '',
    '### Places',
    '',
    '| Place | Kind | Initial / capacity | Meaning |',
    '| --- | --- | --- | --- |',
    ...places.map((place) => (
      `| ${code(place.id)} | ${place.kind} | ${place.initial} / ${place.capacity} | ${cell(place.label)} |`)),
    '',
    '### Receptivities',
    '',
    '| Receptivity | Kind | Fact | Channel |',
    '| --- | --- | --- | --- |',
    ...Object.entries(template.receptivities).map(([id, entry]) => (
      `| ${code(id)} | ${entry.kind} | ${cell(entry.fact)} | ${cell(entry.channel)} |`)),
    '',
    '### Transitions',
    '',
    '| Transition | Consumes | Produces | Inhibited by | Receptivity | Refusal | Priority |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...template.transitions.map((transition) => [
      code(transition.id), arcs(transition.inputs), arcs(transition.outputs), arcs(transition.inhibitors),
      code(transition.receptivity), code(transition.refusal), transition.priority ?? 0,
    ].join(' | ')).map((row) => `| ${row} |`),
    '',
    '### Chart',
    '',
    '```mermaid',
    ...mermaid(template),
    '```',
  ].join('\n');
}

/** The block between the markers, or null when a marker is missing. */
function renderedBlock(doc) {
  const start = doc.indexOf(`${BEGIN}\n`);
  const end = doc.indexOf(`\n${END}`);
  return start < 0 || end < start ? null : doc.slice(start + BEGIN.length + 1, end);
}

// ---------------------------------------------------------------------------
// the bindings
// ---------------------------------------------------------------------------

/** Every id the template declares: places, shared resources, receptivities and transitions. */
const chartIds = (template) => new Set([
  ...template.shared.map(({ id }) => id), ...template.places.map(({ id }) => id),
  ...Object.keys(template.receptivities), ...template.transitions.map(({ id }) => id),
]);

/** The refusal and blocker codes each agent declares, read from the sections that declare them. */
function agentCodes(agents) {
  return {
    coordinator: tableCodes(section(agents.coordinator, 'Named blockers')),
    publisher: [
      ...tableCodes(section(agents.publisher, 'Verification, in this order, each a refusal with its name')),
      ...tableCodes(section(agents.publisher, 'Confirmation after each command, each a refusal with its name')),
    ],
    reviewer: bulletCodes(section(agents.reviewer, 'Preconditions, each a refusal with its name')),
  };
}

/** The doc's binding rows: `| `CODE` | agents | chart ids | subject | why |`. */
const bindings = (doc) => [...section(doc, 'Bindings')
  .matchAll(/^\| `([A-Z0-9_]+)` \| ([a-z, ]+) \| ([^|]+) \|/gmu)]
  .map(([, refusal, agents, chart]) => ({
    refusal, agents: agents.split(',').map((agent) => agent.trim()).sort(), chart: ticked(chart),
  }));

/** Why the doc's bindings do not match the agents and the chart, one line per problem. */
function bindingProblems({ agents, doc, template = DRAIN_NET_TEMPLATE }) {
  const returnedBy = new Map();
  for (const [agent, codes] of Object.entries(agentCodes(agents))) {
    for (const refusal of new Set(codes)) returnedBy.set(refusal, [...(returnedBy.get(refusal) ?? []), agent].sort());
  }
  const ids = chartIds(template);
  const problems = [];
  const bound = new Set();
  for (const row of bindings(doc)) {
    if (bound.has(row.refusal)) problems.push(`${row.refusal}: bound twice`);
    bound.add(row.refusal);
    const agentsOf = returnedBy.get(row.refusal);
    if (!agentsOf) problems.push(`${row.refusal}: no agent returns it`);
    else if (agentsOf.join() !== row.agents.join()) {
      problems.push(`${row.refusal}: returned by ${agentsOf.join(', ')}, bound to ${row.agents.join(', ')}`);
    }
    if (row.chart.length === 0) problems.push(`${row.refusal}: names no chart id`);
    for (const id of row.chart.filter((value) => !ids.has(value))) problems.push(`${row.refusal}: ${id} is not in the chart`);
    for (const transition of template.transitions.filter(({ refusal }) => refusal === row.refusal)) {
      if (!row.chart.includes(transition.receptivity)) {
        problems.push(`${row.refusal}: the chart refuses ${transition.id} with it, so it reads ${transition.receptivity}`);
      }
    }
  }
  for (const [refusal, agentsOf] of returnedBy) {
    if (!bound.has(refusal)) problems.push(`${refusal}: returned by ${agentsOf.join(', ')} and bound to nothing`);
  }
  return problems;
}

/** The doc's rows of chart refusals no agent returns: `| `CODE` | transitions | reading |`. */
const unreturned = (doc) => [...section(doc, 'Chart refusals no agent returns')
  .matchAll(/^\| `([A-Z0-9_]+)` \| ([^|]+) \|/gmu)]
  .map(([, refusal, transitions]) => ({ refusal, transitions: ticked(transitions).sort() }));

/** Why some refusal of the chart is neither bound nor listed, is both, or is listed wrongly. */
function chartRefusalProblems({ doc, template = DRAIN_NET_TEMPLATE }) {
  const refusing = new Map();
  for (const { id, refusal } of template.transitions) refusing.set(refusal, [...(refusing.get(refusal) ?? []), id].sort());
  const bound = new Set(bindings(doc).map(({ refusal }) => refusal));
  const listed = unreturned(doc);
  const problems = [];
  for (const { refusal, transitions } of listed) {
    const chart = refusing.get(refusal);
    if (!chart) problems.push(`${refusal}: listed, and the chart refuses nothing with it`);
    else if (transitions.join() !== chart.join()) {
      problems.push(`${refusal}: lists ${transitions.join(', ')}, the chart refuses ${chart.join(', ')} with it`);
    }
    if (bound.has(refusal)) problems.push(`${refusal}: bound, and listed as returned by no agent`);
  }
  const listedCodes = new Set(listed.map(({ refusal }) => refusal));
  for (const refusal of refusing.keys()) {
    if (!bound.has(refusal) && !listedCodes.has(refusal)) problems.push(`${refusal}: the chart refuses with it, and it is neither bound nor listed`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// the coordinator's classes
// ---------------------------------------------------------------------------

/**
 * The coordinator's classes as predicates over one head. `reconciled` is the reconciliation
 * class of the coordinator's step 3, which holds only while neither axis carries a verdict on the
 * head. Each class names the receptivities it reads and whether it admits or excludes a reconciled
 * head; the doc's rows and the coordinator's bullets must say the same, so the partition checked
 * below is the one they state.
 */
const approved = (head) => head.D_BOTH_APPROVE_AT_HEAD || head.reconciled;
const mergeReady = (head) => approved(head) && head.D_NOT_DRAFT && head.D_MERGEABLE_CLEAN && head.clean && head.green;
const CLASS_MODEL = {
  conflicting: {
    reads: ['D_BOTH_APPROVE_AT_HEAD', 'D_CONFLICTING'],
    reconciled: 'admits',
    holds: (head) => approved(head) && head.D_CONFLICTING,
  },
  'changes-requested': {
    reads: ['D_ANY_REQUEST_CHANGES_AT_HEAD'],
    holds: (head) => head.D_ANY_REQUEST_CHANGES_AT_HEAD,
  },
  unreviewed: {
    reads: ['D_HEAD_PUBLISHED', 'D_SPEC_VERDICT_BOUND', 'D_STANDARDS_VERDICT_BOUND'],
    reconciled: 'excludes',
    holds: (head) => head.D_HEAD_PUBLISHED && !head.D_SPEC_VERDICT_BOUND && !head.D_STANDARDS_VERDICT_BOUND && !head.reconciled,
  },
  'single-axis': {
    reads: ['D_SPEC_VERDICT_BOUND', 'D_STANDARDS_VERDICT_BOUND'],
    holds: (head) => head.D_SPEC_VERDICT_BOUND !== head.D_STANDARDS_VERDICT_BOUND,
  },
  'dual-approved': {
    reads: ['D_BOTH_APPROVE_AT_HEAD'],
    reconciled: 'admits',
    holds: (head) => approved(head) && !head.D_CONFLICTING && !mergeReady(head),
  },
  'merge-ready': {
    reads: ['D_BOTH_APPROVE_AT_HEAD', 'D_NOT_DRAFT', 'D_MERGEABLE_CLEAN'],
    reconciled: 'admits',
    holds: mergeReady,
  },
};
const CLASSES = Object.keys(CLASS_MODEL);

const product = (...lists) => lists.reduce((rows, list) => rows.flatMap((row) => list.map((value) => [...row, value])), [[]]);

/** Every head the coordinator classifies: the verdicts on it, reconciliation, and the PR fields. */
function headStates() {
  const verdicts = [null, 'APPROVE', 'REQUEST_CHANGES'];
  const flags = [false, true];
  return product(verdicts, verdicts, flags, ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'], flags, flags, flags)
    // A verdict on the head itself supersedes the reconciliation class.
    .filter(([spec, standards, reconciled]) => !reconciled || (spec === null && standards === null))
    .map(([spec, standards, reconciled, mergeable, draft, clean, green]) => ({
      spec, standards, reconciled, mergeable, draft, clean, green,
      D_HEAD_PUBLISHED: true,
      D_SPEC_VERDICT_BOUND: spec !== null,
      D_STANDARDS_VERDICT_BOUND: standards !== null,
      D_BOTH_APPROVE_AT_HEAD: spec === 'APPROVE' && standards === 'APPROVE',
      D_ANY_REQUEST_CHANGES_AT_HEAD: spec !== null && standards !== null && [spec, standards].includes('REQUEST_CHANGES'),
      D_CONFLICTING: mergeable === 'CONFLICTING',
      D_MERGEABLE_CLEAN: mergeable === 'MERGEABLE',
      D_NOT_DRAFT: !draft,
    }));
}

/** The heads a model of the classes puts in no class or in more than one. */
const partitionFailures = (model) => headStates()
  .map((head) => ({ head, classes: Object.keys(model).filter((name) => model[name].holds(head)) }))
  .filter(({ classes }) => classes.length !== 1);

/** The doc's class rows: `| `class` | predicate | lane |`. */
const classRows = (doc) => [...section(doc, 'Coordinator classes')
  .matchAll(/^\| `([a-z-]+)` \| ([^|]+) \|/gmu)]
  .map(([, name, predicate]) => ({ name, predicate, receptivities: ticked(predicate).filter((id) => id.startsWith('D_')) }));

/** Each class bullet of the coordinator's step 4, keyed by class. */
function classBullets(coordinator) {
  const start = coordinator.indexOf('4. **Classify**');
  const end = coordinator.indexOf('5. **Decide the next lane**');
  assert.ok(start >= 0 && end > start, 'the coordinator classifies in step 4');
  return Object.fromEntries(coordinator.slice(start, end).split(/\n {3}- /u).slice(1)
    .map((bullet) => [bullet.match(/^`([a-z-]+)`/u)?.[1], bullet]));
}

/** How a predicate's text treats a reconciled head: `not `reconciled`` excludes it, `reconciled` admits it. */
function reconciledIn(text) {
  if (text.includes('not `reconciled`')) return 'excludes';
  return text.includes('`reconciled`') ? 'admits' : 'ignores';
}

/** Why the doc's class rows do not match the coordinator's classes, the model, and the chart. */
function classProblems({ coordinator, doc, template = DRAIN_NET_TEMPLATE }) {
  const bullets = classBullets(coordinator);
  const problems = [];
  const rows = classRows(doc);
  const names = rows.map(({ name }) => name);
  if (names.join() !== CLASSES.join()) problems.push(`classes ${names.join(', ')} are not ${CLASSES.join(', ')}`);
  for (const { name, predicate, receptivities } of rows) {
    if (receptivities.length === 0) problems.push(`${name}: names no receptivity`);
    for (const id of receptivities) {
      if (!(id in template.receptivities)) problems.push(`${name}: ${id} is not in the chart`);
      if (!(bullets[name] ?? '').includes(code(id))) problems.push(`${name}: the coordinator's bullet does not name ${id}`);
    }
    const model = CLASS_MODEL[name];
    if (!model) continue;
    if ([...receptivities].sort().join() !== [...model.reads].sort().join()) {
      problems.push(`${name}: names ${receptivities.join(', ')}, its predicate reads ${model.reads.join(', ')}`);
    }
    const expected = model.reconciled ?? 'ignores';
    for (const [where, text] of [['row', predicate], ["coordinator's bullet", bullets[name] ?? '']]) {
      const says = reconciledIn(text);
      if (says !== expected) problems.push(`${name}: the ${where} ${says} \`reconciled\`, the predicate ${expected} it`);
    }
  }
  return problems;
}

/** The receptivities the doc lists as read by no agent. */
const unread = (doc) => tableCodes(section(doc, 'Receptivities no agent reads'));

/** Why some receptivity is neither read nor listed as unread, or is both. */
function readProblems({ doc, template = DRAIN_NET_TEMPLATE }) {
  const readIds = new Set([
    ...bindings(doc).flatMap(({ chart }) => chart), ...classRows(doc).flatMap(({ receptivities }) => receptivities),
  ]);
  const listed = unread(doc);
  return Object.keys(template.receptivities).flatMap((id) => {
    if (readIds.has(id) && listed.includes(id)) return [`${id}: read, and listed as read by no agent`];
    if (!readIds.has(id) && !listed.includes(id)) return [`${id}: read by no agent and not listed`];
    return [];
  });
}

// ---------------------------------------------------------------------------

test('the chart block in docs/drain-grafcet.md is the rendering of DRAIN_NET_TEMPLATE', () => {
  const block = renderedBlock(read(DOC));
  assert.ok(block !== null, `${DOC} carries the chart between its markers`);
  assert.equal(block, renderChart(DRAIN_NET_TEMPLATE),
    `${DOC} is stale: replace the block between its markers with renderChart(DRAIN_NET_TEMPLATE)`);
});

test('every refusal an agent returns is bound once, to the agents that return it and to chart ids', () => {
  const agents = readAgents();
  const codes = Object.values(agentCodes(agents)).flat();
  // The three sections are read: one known code from each.
  for (const known of ['PUBLICATION_BUSY', 'STILL_DRAFT', 'SUBJECT_DIRTY']) {
    assert.ok(codes.includes(known), `the agents declare ${known}`);
  }
  assert.deepEqual(bindingProblems({ agents, doc: read(DOC) }), []);
});

test('every refusal of the chart is bound to an agent, or listed with the transitions that refuse with it', () => {
  assert.deepEqual(chartRefusalProblems({ doc: read(DOC) }), []);
});

test('every coordinator class is a predicate over receptivities its bullet names', () => {
  assert.deepEqual(classProblems({ coordinator: readAgents().coordinator, doc: read(DOC) }), []);
});

test('the coordinator classes put every head in exactly one class, a reconciled head included', () => {
  const heads = headStates();
  assert.equal(heads.length, 240, 'nine verdict pairs, reconciliation without verdicts, three mergeable values, three flags');
  assert.deepEqual(partitionFailures(CLASS_MODEL), []);
  // The R1 reviews' case: a reconciled head is approved, and when it conflicts again it reconciles.
  const reconciled = heads.filter((head) => head.reconciled);
  assert.ok(reconciled.length > 0 && reconciled.every((head) => !CLASS_MODEL.unreviewed.holds(head)));
  assert.ok(reconciled.filter((head) => head.D_CONFLICTING).every((head) => CLASS_MODEL.conflicting.holds(head)));
});

test('every receptivity is read by an agent, or listed as read by none with its reason', () => {
  assert.deepEqual(readProblems({ doc: read(DOC) }), []);
});

test('the publication order names the closing-keyword effect, or the publisher refuses', () => {
  const { coordinator, publisher } = readAgents();
  const agentsDoc = read('docs/github-drain-agents.md');
  for (const [name, text] of [['coordinator', coordinator], ['publisher', publisher], ['agents doc', agentsDoc]]) {
    assert.match(text, /^autoCloses: /mu, `${name}: the order carries autoCloses`);
    assert.ok(text.includes('closingIssuesReferences'), `${name}: names the GitHub field it mirrors`);
  }
  const row = publisher.split('\n').find((line) => line.startsWith('| `CLOSING_EFFECT_UNNAMED` |'));
  assert.ok(row, 'the publisher refuses an unnamed closing effect');
  assert.match(row, /closingIssuesReferences/u);
  assert.match(row, /autoCloses/u);
  const verification = tableCodes(section(publisher, 'Verification, in this order, each a refusal with its name'));
  // Both are verification checks, so both run before any command; then their order is read.
  assert.ok(verification.includes('CLOSING_EFFECT_UNNAMED') && verification.includes('HEAD_MISMATCH'),
    'the closing effect and the head are checked before any command');
  assert.ok(verification.indexOf('CLOSING_EFFECT_UNNAMED') < verification.indexOf('HEAD_MISMATCH'),
    'the closing effect is checked before the GitHub head facts');
  const rowOf = (refusal) => publisher.split('\n').find((line) => line.startsWith(`| \`${refusal}\` |`)) ?? '';
  assert.match(rowOf('STATE_CHANGED'), /closingIssuesReferences/u, 'the closing references are re-read before the merge');
  assert.match(rowOf('ORDER_INCOMPLETE'), /`closeIssue` names an issue `autoCloses` names/u,
    'an order does not close an issue the merge closes');
  assert.match(publisher, /^mergeCommit: /mu, 'an issue close without a merge names the merge commit');
});

test('the reviewer writes a Family line the breaker reads, and never a placeholder family', () => {
  const { reviewer } = readAgents();
  // The shape's own `## ` lines sit inside its fence, so the fence is read from the heading on.
  const shape = reviewer.slice(reviewer.indexOf('\n## Artifact shape\n')).match(/```\n([\s\S]*?)\n```/u)?.[1];
  assert.ok(shape, 'the reviewer states its artifact shape');
  const head = 'a'.repeat(40);
  const artifact = (family) => shape
    .replace('# PR #N - <round> independent <axis> review', '# PR #7 - R1 independent Spec review')
    .replace('**Verdict: APPROVE | REQUEST_CHANGES**', '**Verdict: REQUEST_CHANGES**')
    .replace('detached at <headSha>', `detached at ${head}`)
    .replace('Family: <family>', family)
    .replace('<MARKER>', 'PR7_R1_SPEC_COMPLETE');
  const parse = (text) => parseArtifact({ name: 'shape.md', bytes: Buffer.from(text) });
  const parsed = parse(artifact('Family: D1'));
  assert.deepEqual(parsed.refusals, [], 'the shape is a review the collector binds');
  assert.equal(parsed.subjectSha, head);
  assert.equal(parsed.family, 'D1', 'the Family line sits in the header block the collector reads');
  assert.equal(parse(artifact('')).family, null, 'an omitted line is no family');
  assert.doesNotMatch(reviewer, /Family: `?(?:none|n\/a|-)`?\s*$/mu, 'the reviewer never writes a placeholder family');
});

const BREAKER_WORDS = /BLOCKED_REDESIGN|breaker|ENG-09|family/iu;
const EXEMPTION_WORDS = /\b(?:except|excepting|unless|other than|but not|save|excluded|excludes|however)\b/iu;
/** A sentence that applies the breaker to every class, approved heads named as included. */
const classFree = (text) => text.includes('whatever the class') && !EXEMPTION_WORDS.test(text);
const allClasses = (text) => classFree(text) && text.includes('`dual-approved` and `merge-ready` included');

/** Where the coordinator and the doc apply the breaker: before every class, never inside one. */
function breakerProblems({ coordinator, doc }) {
  const problems = [];
  const between = (from, to) => {
    const start = coordinator.indexOf(from);
    const end = coordinator.indexOf(to, start);
    return start >= 0 && end > start ? coordinator.slice(start, end) : '';
  };
  const step = between('5. **Decide the next lane**', '\n6. **');
  const firstBullet = step.indexOf('\n   - `');
  // Whitespace is normalized so a wrapped line cannot split a listed exemption.
  const lead = (firstBullet >= 0 ? step.slice(0, firstBullet) : step).replace(/\s+/gu, ' ');
  if (!lead.includes('`BLOCKED_REDESIGN`') || !allClasses(lead)) {
    problems.push('coordinator: the breaker does not come before the classes');
  }
  if (firstBullet < 0) problems.push('coordinator: step 5 has no class bullet');
  else if (BREAKER_WORDS.test(step.slice(firstBullet))) problems.push('coordinator: a class bullet applies the breaker');
  if (BREAKER_WORDS.test(between('4. **Classify**', '5. **Decide the next lane**'))) {
    problems.push('coordinator: a class definition names the breaker');
  }
  const row = coordinator.split('\n').find((line) => line.startsWith('| `BLOCKED_REDESIGN` |')) ?? '';
  if (!classFree(row)) problems.push('coordinator: the BLOCKED_REDESIGN row is not class-free');
  // A class row is read whole after its name cell, so a missing or escaped pipe hides no cell.
  for (const [, name, cells] of section(doc, 'Coordinator classes').matchAll(/^\| `([a-z-]+)` \|(.*)$/gmu)) {
    if (BREAKER_WORDS.test(cells)) problems.push(`doc: class ${name} applies the breaker`);
  }
  const paragraph = section(doc, 'Coordinator classes').split('\n\n').find((text) => text.startsWith('The breaker is not a class.')) ?? '';
  if (!allClasses(paragraph.replace(/\s+/gu, ' '))) problems.push('doc: the breaker paragraph is not class-free');
  return problems;
}

test('the coordinator waits on the breaker before any class, as T_BREAKER_TRIP outranks both joins', () => {
  const byId = Object.fromEntries(DRAIN_NET_TEMPLATE.transitions.map((transition) => [transition.id, transition]));
  const priority = (id) => byId[id].priority ?? 0;
  for (const join of ['T_JOIN_APPROVE', 'T_JOIN_REPAIR']) {
    assert.ok(priority('T_BREAKER_TRIP') > priority(join), `T_BREAKER_TRIP outranks ${join}`);
    assert.ok(byId.T_BREAKER_TRIP.inputs.every((place) => byId[join].inputs.includes(place)),
      `T_BREAKER_TRIP takes the verdict steps ${join} takes`);
  }
  const { coordinator } = readAgents();
  const doc = read(DOC);
  assert.deepEqual(breakerProblems({ coordinator, doc }), []);

  // Negative control: the breaker held inside `changes-requested`, which let a dual-approved head
  // after a repeated family go to publication while the chart trips.
  const insideClass = coordinator
    .replace(/5\. \*\*Decide the next lane\*\* per PR\.[\s\S]*?Otherwise, by class:/u, '5. **Decide the next lane** per PR:')
    .replace('again at the new head;', 'again at the new head; `wait` with `BLOCKED_REDESIGN` when the family repeats;');
  const rowInsideClass = doc.replace('one `REQUEST_CHANGES` | `bounded repair` |',
    'one `REQUEST_CHANGES` | `bounded repair`, or `wait` with `BLOCKED_REDESIGN` when the family repeats |');
  assert.notEqual(insideClass, coordinator);
  assert.notEqual(rowInsideClass, doc);
  assert.deepEqual(breakerProblems({ coordinator: insideClass, doc: rowInsideClass }), [
    'coordinator: the breaker does not come before the classes',
    'coordinator: a class bullet applies the breaker',
    'doc: class changes-requested applies the breaker',
  ]);

  // Negative control: wordings that keep the phrases and still exempt approved heads, or move the
  // breaker into a class definition, a class row, the blocker row or the doc's paragraph.
  const plant = (text, from, to) => {
    assert.ok(text.includes(from), `the plant anchor "${from}" exists`);
    return text.replace(from, to);
  };
  let exempting = plant(coordinator, '`dual-approved` and `merge-ready` included.',
    'except `dual-approved` and `merge-ready`, which go to `publish`.');
  exempting = plant(exempting, 'not `conflicting`, and\n     not `merge-ready`',
    'not `conflicting` (a repeated family does not hold it), and\n     not `merge-ready`');
  exempting = plant(exempting, '(ENG-09), whatever the class of the published head:', '(ENG-09):');
  let exemptingDoc = plant(doc, 'one `REQUEST_CHANGES` | `bounded repair` |',
    'one `REQUEST_CHANGES` | `bounded repair`, or `wait` on the ENG-09 breaker when the family repeats |');
  exemptingDoc = plant(exemptingDoc, 'waits with `BLOCKED_REDESIGN`\nwhatever the class of the published head, `dual-approved` and `merge-ready` included.',
    'waits with `BLOCKED_REDESIGN`\nonly within `changes-requested`, `dual-approved` and `merge-ready` excluded.');
  assert.deepEqual(breakerProblems({ coordinator: exempting, doc: exemptingDoc }), [
    'coordinator: the breaker does not come before the classes',
    'coordinator: a class definition names the breaker',
    'coordinator: the BLOCKED_REDESIGN row is not class-free',
    'doc: class changes-requested applies the breaker',
    'doc: the breaker paragraph is not class-free',
  ]);

  // Negative control: each hardening alone, so dropping one lets its plant pass. An exemption in
  // any case, as a sentence of its own or wrapped across lines; a listed word in any case, in a
  // class row's Predicate cell, after an escaped pipe, or in a row with no closing pipe.
  for (const [where, from, to, problem] of [
    ['coordinator', '`merge-ready` included. A new head',
      '`merge-ready` included. Except `merge-ready`, which goes to `publish`. A new head',
      'coordinator: the breaker does not come before the classes'],
    ['coordinator', '`merge-ready` included. A new head',
      '`merge-ready` included. However, a `merge-ready` head goes to `publish`. A new head',
      'coordinator: the breaker does not come before the classes'],
    ['coordinator', '`merge-ready` included. A new head',
      '`merge-ready` included. Every class waits, but\n   not `merge-ready`. A new head',
      'coordinator: the breaker does not come before the classes'],
    ['doc', 'one `REQUEST_CHANGES` | `bounded repair` |',
      'one `REQUEST_CHANGES` | `bounded repair`, or `wait` on the Breaker |',
      'doc: class changes-requested applies the breaker'],
    ['doc', 'and neither `conflicting` nor `merge-ready` |',
      'and neither `conflicting` nor `merge-ready`, the failure family not repeated |',
      'doc: class dual-approved applies the breaker'],
    ['doc', 'and every check green | `publish` |',
      'and every check green | `publish` \\| `wait` while the failure family repeats |',
      'doc: class merge-ready applies the breaker'],
    ['doc', 'and every check green | `publish` |',
      'and every check green, `BLOCKED_REDESIGN` not holding | `publish`',
      'doc: class merge-ready applies the breaker'],
    ['doc', 'included. A new head\nis not',
      'included. Every class waits, but\n  not `merge-ready`. A new head\nis not',
      'doc: the breaker paragraph is not class-free'],
  ]) {
    const files = { coordinator, doc };
    files[where] = plant(files[where], from, to);
    assert.deepEqual(breakerProblems(files), [problem], `${where}: ${to}`);
  }
  // A step 5 whose class bullets the gate cannot find fails closed.
  const step = coordinator.slice(coordinator.indexOf('5. **Decide the next lane**'), coordinator.indexOf('\n6. **'));
  const starred = coordinator.replace(step, () => step.replaceAll('\n   - `', '\n   * `'));
  assert.notEqual(starred, coordinator);
  assert.deepEqual(breakerProblems({ coordinator: starred, doc }), ['coordinator: step 5 has no class bullet']);
});

test('NEGATIVE CONTROL: each binding gate fires on a planted mismatch', () => {
  // The rendering moves with the template: a renamed refusal changes the block.
  const renamed = {
    ...DRAIN_NET_TEMPLATE,
    transitions: DRAIN_NET_TEMPLATE.transitions.map((transition) => (
      transition.id === 'T_READY' ? { ...transition, refusal: 'STILL_A_DRAFT' } : transition)),
  };
  assert.notEqual(renderChart(renamed), renderChart(DRAIN_NET_TEMPLATE));
  assert.match(renderChart(renamed), /\| `D_NOT_DRAFT` \| `STILL_A_DRAFT` \|/u);
  assert.equal(renderedBlock('no markers'), null);

  const agents = {
    coordinator: '\n## Named blockers\n\n| `PUBLICATION_BUSY` | another PR holds the lock |\n',
    publisher: [
      '', '## Verification, in this order, each a refusal with its name', '',
      '| `ORDER_DIGEST_MISMATCH` | digest |', '| `NOT_MERGEABLE` | mergeable |',
      '', '## Confirmation after each command, each a refusal with its name', '',
      '| `STILL_DRAFT` | after ready |', '',
    ].join('\n'),
    reviewer: '\n## Preconditions, each a refusal with its name\n\n- `SUBJECT_DIRTY`: dirty.\n',
  };
  const doc = (...rows) => `\n## Bindings\n\n| Refusal | Agents | Chart | Why |\n| --- | --- | --- | --- |\n${rows.join('\n')}\n`;
  const rows = {
    busy: '| `PUBLICATION_BUSY` | coordinator | `MERGE_LOCK` | lock |',
    digest: '| `ORDER_DIGEST_MISMATCH` | publisher | `P_MERGEABLE` | order |',
    mergeable: '| `NOT_MERGEABLE` | publisher | `D_MERGEABLE_CLEAN` | T_MERGEABLE |',
    draft: '| `STILL_DRAFT` | publisher | `D_NOT_DRAFT` | T_READY |',
    dirty: '| `SUBJECT_DIRTY` | reviewer | `P_REVIEW_SPEC`, `P_REVIEW_STANDARDS` | clone |',
  };
  assert.deepEqual(bindingProblems({ agents, doc: doc(...Object.values(rows)) }), []);
  assert.deepEqual(bindingProblems({ agents, doc: doc(rows.busy, rows.digest, rows.mergeable, rows.draft) }), [
    'SUBJECT_DIRTY: returned by reviewer and bound to nothing',
  ]);
  assert.deepEqual(bindingProblems({
    agents,
    doc: doc(
      rows.busy, rows.busy, rows.digest, rows.dirty,
      '| `NOT_MERGEABLE` | coordinator | `D_MERGEABLE` | T_MERGEABLE |',
      '| `STILL_DRAFT` | publisher | `D_MERGE_CONFIRMED` | wrong fact |',
      '| `HEAD_WANDERED` | publisher | `D_HEAD_ADVANCED` | nobody returns it |',
      '| `ORDER_INCOMPLETE` | publisher | none | no id |',
    ),
  }), [
    'PUBLICATION_BUSY: bound twice',
    'NOT_MERGEABLE: returned by publisher, bound to coordinator',
    'NOT_MERGEABLE: D_MERGEABLE is not in the chart',
    'NOT_MERGEABLE: the chart refuses T_MERGEABLE with it, so it reads D_MERGEABLE_CLEAN',
    'STILL_DRAFT: the chart refuses T_READY with it, so it reads D_NOT_DRAFT',
    'HEAD_WANDERED: no agent returns it',
    'ORDER_INCOMPLETE: no agent returns it',
    'ORDER_INCOMPLETE: names no chart id',
  ]);

  // A chart refusal neither bound nor listed, listed with the wrong transitions, or bound and listed.
  const realDoc = read(DOC);
  const listedRow = (text) => realDoc.replace('| Refusal | Transitions | Reading |\n| --- | --- | --- |\n',
    `| Refusal | Transitions | Reading |\n| --- | --- | --- |\n${text}\n`);
  assert.deepEqual(chartRefusalProblems({ doc: realDoc, template: renamed }), [
    'STILL_A_DRAFT: the chart refuses with it, and it is neither bound nor listed',
  ]);
  assert.deepEqual(chartRefusalProblems({
    doc: realDoc.replace('`T_DUAL_APPROVED_HEAD_ADVANCED`, `T_MERGEABLE_HEAD_ADVANCED`, `T_READY_HEAD_ADVANCED`', '`T_READY_HEAD_ADVANCED`'),
  }), [
    'HEAD_UNCHANGED: lists T_READY_HEAD_ADVANCED, the chart refuses '
      + 'T_DUAL_APPROVED_HEAD_ADVANCED, T_MERGEABLE_HEAD_ADVANCED, T_READY_HEAD_ADVANCED with it',
  ]);
  assert.deepEqual(chartRefusalProblems({ doc: listedRow('| `STILL_DRAFT` | `T_READY` | x |\n| `HEAD_WANDERED` | `T_MERGE` | x |') }), [
    'STILL_DRAFT: bound, and listed as returned by no agent',
    'HEAD_WANDERED: listed, and the chart refuses nothing with it',
  ]);

  // A class row whose receptivities differ from its bullet, the model, or the chart, or that
  // treats a reconciled head otherwise than the model.
  const phrase = { admits: ' or `reconciled`', excludes: ', not `reconciled`' };
  const predicateOf = (name) => `${CLASS_MODEL[name].reads.map(code).join(', ')}${phrase[CLASS_MODEL[name].reconciled] ?? ''}`;
  const coordinator = [
    '4. **Classify** with the closed vocabulary:',
    ...CLASSES.map((name) => `   - \`${name}\`: ${predicateOf(name)}.`),
    '5. **Decide the next lane** per PR:',
  ].join('\n');
  const classDoc = (rows = {}) => `\n## Coordinator classes\n\n${CLASSES.map((name) => (
    `| \`${name}\` | ${rows[name] ?? predicateOf(name)} | lane |`)).join('\n')}\n`;
  assert.deepEqual(classProblems({ coordinator, doc: classDoc() }), []);
  assert.deepEqual(classProblems({ coordinator, doc: classDoc({ 'merge-ready': `${predicateOf('merge-ready')}, \`D_CONFLICTING\`` }) }), [
    "merge-ready: the coordinator's bullet does not name D_CONFLICTING",
    'merge-ready: names D_BOTH_APPROVE_AT_HEAD, D_NOT_DRAFT, D_MERGEABLE_CLEAN, D_CONFLICTING, '
      + 'its predicate reads D_BOTH_APPROVE_AT_HEAD, D_NOT_DRAFT, D_MERGEABLE_CLEAN',
  ]);
  assert.deepEqual(classProblems({ coordinator, doc: classDoc().replace('`unreviewed`', '`unseen`') }), [
    `classes ${CLASSES.join(', ').replace('unreviewed', 'unseen')} are not ${CLASSES.join(', ')}`,
    "unseen: the coordinator's bullet does not name D_HEAD_PUBLISHED",
    "unseen: the coordinator's bullet does not name D_SPEC_VERDICT_BOUND",
    "unseen: the coordinator's bullet does not name D_STANDARDS_VERDICT_BOUND",
  ]);
  assert.deepEqual(classProblems({ coordinator, doc: classDoc({ conflicting: '`D_NOPE` or `reconciled`' }) }), [
    'conflicting: D_NOPE is not in the chart',
    "conflicting: the coordinator's bullet does not name D_NOPE",
    'conflicting: names D_NOPE, its predicate reads D_BOTH_APPROVE_AT_HEAD, D_CONFLICTING',
  ]);
  // The R1 defect: an `unreviewed` that does not exclude a reconciled head, in the doc or the prompt.
  const unexcluded = CLASS_MODEL.unreviewed.reads.map(code).join(', ');
  assert.deepEqual(classProblems({ coordinator, doc: classDoc({ unreviewed: unexcluded }) }), [
    'unreviewed: the row ignores `reconciled`, the predicate excludes it',
  ]);
  assert.deepEqual(classProblems({ coordinator: coordinator.replace(', not `reconciled`', ''), doc: classDoc() }), [
    "unreviewed: the coordinator's bullet ignores `reconciled`, the predicate excludes it",
  ]);
  assert.deepEqual(classProblems({ coordinator, doc: classDoc({ conflicting: '`D_BOTH_APPROVE_AT_HEAD`, `D_CONFLICTING`' }) }), [
    'conflicting: the row ignores `reconciled`, the predicate admits it',
  ]);
  // The same defect in the model: every reconciled head lands in two classes.
  const overlapping = {
    ...CLASS_MODEL,
    unreviewed: { ...CLASS_MODEL.unreviewed, holds: (head) => !head.D_SPEC_VERDICT_BOUND && !head.D_STANDARDS_VERDICT_BOUND },
  };
  const failures = partitionFailures(overlapping);
  assert.equal(failures.length, headStates().filter((head) => head.reconciled).length);
  assert.ok(failures.every(({ head, classes }) => head.reconciled && classes.length === 2 && classes.includes('unreviewed')));

  // A receptivity read by nothing, and one both read and listed as unread.
  const ids = Object.keys(DRAIN_NET_TEMPLATE.receptivities);
  const readAll = `\n## Bindings\n\n| \`X\` | publisher | ${ids.map(code).join(', ')} | all |\n`;
  const unreadTable = (...listed) => `\n## Receptivities no agent reads\n\n${listed.map((id) => `| ${code(id)} | why |`).join('\n')}\n`;
  const classes = '\n## Coordinator classes\n\n';
  assert.deepEqual(readProblems({ doc: readAll + classes + unreadTable() }), []);
  assert.deepEqual(readProblems({ doc: readAll + classes + unreadTable('D_NOT_DRAFT') }), [
    'D_NOT_DRAFT: read, and listed as read by no agent',
  ]);
  const readMost = readAll.replace(`, ${code('D_OPERATOR_REDESIGN_ORDER')}`, '');
  assert.deepEqual(readProblems({ doc: readMost + classes + unreadTable() }), [
    'D_OPERATOR_REDESIGN_ORDER: read by no agent and not listed',
  ]);
  assert.deepEqual(readProblems({ doc: readMost + classes + unreadTable('D_OPERATOR_REDESIGN_ORDER') }), []);
});
