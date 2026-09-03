/**
 * github-drain-agents.test.mjs - the GitHub drain agent team, bound.
 *
 * The three subagent definitions under .claude/agents/ are edge adapters: prompts, not code.
 * What can be bound is bound here: existence, frontmatter validity against the document that
 * declares the roles, the write-authority split, the matched-head merge form, the refusal
 * vocabulary, the six-verb bus invariant, and LF-only bytes. Everything the prompts encode is
 * cited to fleet evidence in docs/github-drain-agents.md; that document is the declaration these
 * gates compare the agents against.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUS_VERBS } from '../src/bus-core.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AGENTS_DIR = join(ROOT, '.claude', 'agents');
const DOC_PATH = join(ROOT, 'docs', 'github-drain-agents.md');
const AGENTS = ['github-drain-coordinator', 'github-drain-reviewer', 'github-drain-publisher'];
const WRITERS = ['github-drain-publisher'];

const agentPath = (name) => join(AGENTS_DIR, `${name}.md`);
const readAgent = (name) => readFileSync(agentPath(name), 'utf8');
const readDoc = () => readFileSync(DOC_PATH, 'utf8');

/** Parse the frontmatter block: `key: value` lines between the first two `---` lines. */
function frontmatter(text) {
  const lines = text.split('\n');
  assert.equal(lines[0], '---', 'frontmatter opens on line 1');
  const end = lines.indexOf('---', 1);
  assert.ok(end > 1, 'frontmatter closes');
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([a-z]+):\s*(.*)$/);
    assert.ok(m, `frontmatter line is key: value - ${JSON.stringify(line)}`);
    fields[m[1]] = m[2].trim();
  }
  return { fields, body: lines.slice(end + 1).join('\n') };
}

const splitTools = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

/** The doc's `| \`agent\` | tools | model |` rows. */
function docRoles() {
  const roles = {};
  for (const m of readDoc().matchAll(/^\| `(github-drain-[a-z]+)` \| ([^|]+) \| ([^|]+) \|$/gm)) {
    roles[m[1]] = { tools: splitTools(m[2]), model: m[3].trim() };
  }
  return roles;
}

function docToolUniverse() {
  const m = readDoc().match(/^Declared tool universe: (.+)\.$/m);
  assert.ok(m, 'the doc declares the tool universe');
  return [...m[1].matchAll(/`([A-Za-z]+)`/g)].map((x) => x[1]);
}

function section(text, heading) {
  const marker = `\n## ${heading}\n`;
  const start = text.indexOf(marker);
  assert.ok(start >= 0, `section "${heading}" exists`);
  const rest = text.slice(start + marker.length);
  const next = rest.search(/\n## /);
  return next >= 0 ? rest.slice(0, next) : rest;
}

const codesInTable = (text) => [...text.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);

/** Lines of a text that match a command pattern. */
function commandLines(text, re) {
  return text.split('\n').filter((line) => re.test(line));
}

// ---------------------------------------------------------------------------

test('the three drain agents ship under .claude/agents and nothing else claims the prefix', () => {
  for (const name of AGENTS) assert.ok(existsSync(agentPath(name)), `${name}.md ships`);
  const claimed = readdirSync(AGENTS_DIR).filter((f) => f.startsWith('github-drain-'));
  assert.deepEqual(claimed.sort(), AGENTS.map((n) => `${n}.md`).sort());
  assert.ok(existsSync(DOC_PATH), 'docs/github-drain-agents.md ships');
});

test('each agent has frontmatter with name equal to its filename, a description, tools, and a model', () => {
  for (const name of AGENTS) {
    const { fields, body } = frontmatter(readAgent(name));
    assert.deepEqual(Object.keys(fields).sort(), ['description', 'model', 'name', 'tools'], `${name}: exactly the four fields`);
    assert.equal(fields.name, name, `${name}: name matches filename`);
    assert.ok(fields.description.length >= 80, `${name}: description is a real routing description`);
    assert.ok(splitTools(fields.tools).length >= 1, `${name}: tools listed`);
    assert.match(fields.model, /^[a-z0-9-]+$/, `${name}: model named`);
    assert.ok(body.trim().length > 500, `${name}: system prompt present`);
  }
});

test('each agent tools list is within the declared universe and equals the row the doc declares', () => {
  const universe = docToolUniverse();
  const roles = docRoles();
  assert.deepEqual(Object.keys(roles).sort(), [...AGENTS].sort(), 'the doc declares every agent once');
  for (const name of AGENTS) {
    const tools = splitTools(frontmatter(readAgent(name)).fields.tools);
    for (const tool of tools) assert.ok(universe.includes(tool), `${name}: ${tool} is in the declared universe`);
    assert.deepEqual(tools, roles[name].tools, `${name}: tools equal the doc row`);
    assert.equal(new Set(tools).size, tools.length, `${name}: no duplicate tool`);
  }
  assert.ok(!splitTools(frontmatter(readAgent('github-drain-publisher')).fields.tools).includes('Write'),
    'the publisher holds no Write tool');
});

test('each agent names the model the doc declares for it', () => {
  const roles = docRoles();
  for (const name of AGENTS) {
    assert.equal(frontmatter(readAgent(name)).fields.model, roles[name].model, `${name}: model equals the doc row`);
  }
});

test('the coordinator and the reviewer carry no GitHub write command', () => {
  const write = /\bgh (?:pr (?:merge|ready|edit|review|comment|close|create)|issue (?:close|comment|edit|create)|api\s+(?:-X|--method)\s*(?!GET))\b|\bgit push\b/;
  for (const name of AGENTS.filter((n) => !WRITERS.includes(n))) {
    const offenders = commandLines(readAgent(name), write);
    assert.deepEqual(offenders, [], `${name} carries no GitHub write command`);
  }
});

test('every merge instruction in the agents and the doc carries --match-head-commit and no widening flag', () => {
  const texts = [...AGENTS.map(readAgent), readDoc()];
  let merges = 0;
  for (const text of texts) {
    for (const line of commandLines(text, /gh pr merge/)) {
      merges += 1;
      assert.match(line, /--match-head-commit/, `merge line requires the head match: ${line}`);
      assert.doesNotMatch(line, /--(?:admin|auto|delete-branch|rebase|merge)\b/, `merge line has no widening flag: ${line}`);
    }
  }
  assert.ok(merges >= 2, 'the publisher and the doc both state the merge form');
  assert.match(readAgent('github-drain-publisher'), /gh pr merge N --repo OWNER\/NAME --squash --match-head-commit <headSha>/);
});

test('the publisher gh write commands are exactly the four the doc declares', () => {
  const four = [
    'gh pr ready N --repo OWNER/NAME',
    'gh pr merge N --repo OWNER/NAME --squash --match-head-commit <headSha>',
    'gh pr edit N --repo OWNER/NAME --body-file <bodyFile>',
    'gh issue close M --repo OWNER/NAME --comment "<closeComment>"',
  ];
  const publisher = readAgent('github-drain-publisher');
  const doc = readDoc();
  for (const command of four) {
    assert.ok(publisher.includes(command), `publisher states: ${command}`);
    assert.ok(doc.includes(command), `doc states: ${command}`);
  }
  const writes = new Set(commandLines(publisher, /^gh (?:pr (?:ready|merge|edit)|issue close) /).map((l) => l.trim()));
  assert.deepEqual([...writes].sort(), [...four].sort(), 'no fifth write command form in the publisher');
  assert.doesNotMatch(publisher, /^\s*(?:git push|gh pr review|gh pr comment|gh pr create)\b/m);
});

test('the publisher refusal vocabulary and the doc agree code for code', () => {
  const docCodes = codesInTable(section(readDoc(), 'Publisher refusal vocabulary'));
  const publisherCodes = codesInTable(section(readAgent('github-drain-publisher'), 'Verification, in this order, each a refusal with its name'));
  assert.ok(docCodes.length >= 10, `the doc declares the vocabulary: ${docCodes.length} codes`);
  assert.deepEqual([...publisherCodes].sort(), [...docCodes].sort());
  for (const code of ['HEAD_MISMATCH', 'MARKER_MISSING', 'VERDICT_MISSING', 'AXIS_MISSING', 'SHA_NOT_BOUND', 'CHECKS_NOT_GREEN', 'NOT_MERGEABLE']) {
    assert.ok(docCodes.includes(code), `${code} is in the vocabulary`);
  }
});

test('the reviewer binds to one full SHA on one detached clean clone, one of two verdicts, and a byte-identical tree', () => {
  const reviewer = readAgent('github-drain-reviewer');
  for (const code of ['SHA_NOT_FULL', 'SUBJECT_COMMIT_MISMATCH', 'SUBJECT_NOT_DETACHED', 'SUBJECT_DIRTY', 'AXIS_INVALID']) {
    assert.ok(reviewer.includes(`\`${code}\``), `reviewer names ${code}`);
    assert.ok(readDoc().includes(`\`${code}\``), `doc names ${code}`);
  }
  assert.match(reviewer, /40 hex characters/);
  assert.match(reviewer, /exactly `Spec` or `Standards`/);
  assert.match(reviewer, /Exactly one token, `APPROVE` or `REQUEST_CHANGES`/);
  assert.match(reviewer, /byte-identical at start and end/);
  assert.match(reviewer, /node scripts\/architecture-drift\.mjs --base <baseSha>/);
  assert.doesNotMatch(reviewer, /^\s*gh pr review\b/m, 'the reviewer never submits a GitHub review');
});

test('the coordinator classification vocabulary and next lanes match the doc', () => {
  const coordinator = readAgent('github-drain-coordinator');
  const doc = readDoc();
  for (const cls of ['draft', 'conflicting', 'unreviewed', 'single-axis', 'dual-approved', 'merge-ready', 'changes-requested', 'unknown']) {
    assert.ok(coordinator.includes(`\`${cls}\``), `coordinator classifies ${cls}`);
    assert.ok(doc.includes(`\`${cls}\``), `doc declares ${cls}`);
  }
  for (const lane of ['review Spec', 'review Standards', 'bounded repair', 'reconcile', 'publish']) {
    assert.ok(coordinator.includes(`\`${lane}\``), `coordinator decides lane ${lane}`);
    assert.ok(doc.includes(`\`${lane}\``), `doc declares lane ${lane}`);
  }
  assert.match(coordinator, /GITHUB_DRAIN_LEDGER_COMPLETE/);
  assert.match(coordinator, /derives the README gate counter from the tests directory/);
  assert.match(coordinator, /`UNKNOWN` is not conflict evidence/);
});

test('the bus is still six verbs and no kernel or script file names a drain agent', () => {
  assert.deepEqual([...BUS_VERBS].sort(), ['ack', 'handoff', 'heartbeat', 'inbox', 'register', 'send']);
  for (const dir of ['src', 'scripts']) {
    for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.mjs'))) {
      const text = readFileSync(join(ROOT, dir, file), 'utf8');
      assert.ok(!text.includes('github-drain-'), `${dir}/${file} does not reach for an agent`);
      assert.ok(!text.includes('.claude/agents'), `${dir}/${file} does not load an agent`);
    }
  }
});

test('the agents, the doc, and this gate are LF-only and end with a newline', () => {
  const files = [...AGENTS.map(agentPath), DOC_PATH, fileURLToPath(import.meta.url)];
  for (const file of files) {
    const bytes = readFileSync(file);
    assert.equal(bytes.indexOf(0x0d), -1, `${file} has zero CR bytes`);
    assert.equal(bytes[bytes.length - 1], 0x0a, `${file} ends with LF`);
  }
});

test('every rule row in the doc cites at least one file:line anchor into the fleet evidence', () => {
  const rows = section(readDoc(), 'Rules and the evidence that motivated them')
    .split('\n')
    .filter((line) => /^\| [A-Z`]/.test(line) && !line.startsWith('| Rule '));
  assert.ok(rows.length >= 15, `rules are tabulated: ${rows.length}`);
  for (const row of rows) {
    const cells = row.split(' | ');
    assert.equal(cells.length, 3, `three cells: ${row.slice(0, 60)}`);
    assert.match(cells[2], /`[\w./-]+\.(?:md|ps1|txt|mjs):\d+(?:-\d+)?`/, `evidence cell cites file:line - ${cells[0]}`);
  }
});

test('the doc designs it twice: at least three alternatives and exactly one chosen', () => {
  const doc = readDoc();
  const alternatives = [...doc.matchAll(/^### ([A-D])\. .+$/gm)].map((m) => m[1]);
  assert.ok(alternatives.length >= 3, `alternatives: ${alternatives.join(', ')}`);
  const chosen = [...doc.matchAll(/^### [A-D]\. .+\(chosen\)$/gm)];
  assert.equal(chosen.length, 1, 'exactly one alternative is chosen');
  assert.match(doc, /^## Should an Ed25519 grant gate the publisher\?$/m);
  assert.match(doc, /^Yes, in R1\./m);
});
