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
 *   - every coordinator class is a predicate over receptivities its own bullet names;
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
const CLASSES = ['conflicting', 'changes-requested', 'unreviewed', 'single-axis', 'dual-approved', 'merge-ready'];

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
const tableCodes = (text) => [...text.matchAll(/^\| `([A-Z_]+)` \|/gmu)].map(([, code]) => code);
const bulletCodes = (text) => [...text.matchAll(/^- `([A-Z_]+)`:/gmu)].map(([, code]) => code);

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

/** The doc's binding rows: `| `CODE` | agents | chart ids | why |`. */
const bindings = (doc) => [...section(doc, 'Bindings')
  .matchAll(/^\| `([A-Z_]+)` \| ([a-z, ]+) \| ([^|]+) \|/gmu)]
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

/** The doc's class rows: `| `class` | receptivities | lane |`. */
const classRows = (doc) => [...section(doc, 'Coordinator classes')
  .matchAll(/^\| `([a-z-]+)` \| ([^|]+) \|/gmu)]
  .map(([, name, predicate]) => ({ name, receptivities: ticked(predicate).filter((id) => id.startsWith('D_')) }));

/** Each class bullet of the coordinator's step 4, keyed by class. */
function classBullets(coordinator) {
  const start = coordinator.indexOf('4. **Classify**');
  const end = coordinator.indexOf('5. **Decide the next lane**');
  assert.ok(start >= 0 && end > start, 'the coordinator classifies in step 4');
  return Object.fromEntries(coordinator.slice(start, end).split(/\n {3}- /u).slice(1)
    .map((bullet) => [bullet.match(/^`([a-z-]+)`/u)?.[1], bullet]));
}

/** Why the doc's class rows do not match the coordinator's classes and the chart. */
function classProblems({ coordinator, doc, template = DRAIN_NET_TEMPLATE }) {
  const bullets = classBullets(coordinator);
  const problems = [];
  const rows = classRows(doc);
  const names = rows.map(({ name }) => name);
  if (names.join() !== CLASSES.join()) problems.push(`classes ${names.join(', ')} are not ${CLASSES.join(', ')}`);
  for (const { name, receptivities } of rows) {
    if (receptivities.length === 0) problems.push(`${name}: names no receptivity`);
    for (const id of receptivities) {
      if (!(id in template.receptivities)) problems.push(`${name}: ${id} is not in the chart`);
      if (!(bullets[name] ?? '').includes(code(id))) problems.push(`${name}: the coordinator's bullet does not name ${id}`);
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

test('every coordinator class is a predicate over receptivities its bullet names', () => {
  assert.deepEqual(classProblems({ coordinator: readAgents().coordinator, doc: read(DOC) }), []);
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
  assert.ok(verification.indexOf('CLOSING_EFFECT_UNNAMED') < verification.indexOf('HEAD_MISMATCH'),
    'the closing effect is checked before the GitHub head facts');
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

  // A class row whose receptivity the coordinator's bullet does not name, or the chart lacks.
  const coordinator = [
    '4. **Classify** with the closed vocabulary:',
    ...CLASSES.map((name) => `   - \`${name}\`: reads \`D_CONFLICTING\`.`),
    '5. **Decide the next lane** per PR:',
  ].join('\n');
  const classDoc = (...extra) => `\n## Coordinator classes\n\n${CLASSES.map((name) => (
    `| \`${name}\` | \`D_CONFLICTING\`${extra.includes(name) ? ' and `D_NOT_DRAFT`' : ''} | lane |`)).join('\n')}\n`;
  assert.deepEqual(classProblems({ coordinator, doc: classDoc() }), []);
  assert.deepEqual(classProblems({ coordinator, doc: classDoc('merge-ready') }), [
    "merge-ready: the coordinator's bullet does not name D_NOT_DRAFT",
  ]);
  assert.deepEqual(classProblems({ coordinator, doc: classDoc().replace('`unreviewed`', '`unseen`') }), [
    `classes ${CLASSES.join(', ').replace('unreviewed', 'unseen')} are not ${CLASSES.join(', ')}`,
    "unseen: the coordinator's bullet does not name D_CONFLICTING",
  ]);
  assert.deepEqual(classProblems({ coordinator, doc: classDoc().replace('| `D_CONFLICTING` | lane |', '| `D_NOPE` | lane |') }), [
    'conflicting: D_NOPE is not in the chart',
    "conflicting: the coordinator's bullet does not name D_NOPE",
  ]);

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
