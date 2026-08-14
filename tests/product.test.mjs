/**
 * product.test.mjs — the plugin is a plugin, and it is the one we think it is.
 *
 * Manifest shape, bundled-server wiring, transport surface, and the absence of any
 * developer-only absolute path in anything that ships.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUS_VERBS, NEVER_GRANTABLE, PROTOCOL_VERSION } from '../src/bus-core.mjs';
import { transportChecks, templateChecks, manifestChecks, ecosystemChecks } from '../src/verify.mjs';
import { pluginRoot, bundledServerPath } from '../src/templates.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(ROOT, '.codex-plugin', 'plugin.json'), 'utf8'));
const mcp = JSON.parse(readFileSync(join(ROOT, '.mcp.json'), 'utf8'));

/** Every file that ships, excluding the caller's own data directory (which is elsewhere). */
function shippedFiles(dir = ROOT, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) shippedFiles(full, acc);
    else acc.push(full);
  }
  return acc;
}

// ---------------------------------------------------------------------------

test('the plugin manifest is present and names this plugin', () => {
  assert.equal(manifest.name, 'gaia-interagent');
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, 'strict semver');
  assert.ok(manifest.description.length > 0);
  assert.ok(manifest.author?.name, 'author.name is required by the validator');
  assert.equal(manifest.skills, './skills/');
  assert.equal(manifest.mcpServers, './.mcp.json');
});

test('the manifest interface block carries every field plugin validation requires', () => {
  const iface = manifest.interface;
  for (const field of ['displayName', 'shortDescription', 'longDescription', 'developerName', 'category']) {
    assert.ok(typeof iface[field] === 'string' && iface[field].trim().length > 0, `interface.${field}`);
  }
  assert.ok(Array.isArray(iface.capabilities) && iface.capabilities.every((c) => typeof c === 'string' && c.trim()));
  assert.ok(iface.defaultPrompt !== undefined || iface.default_prompt !== undefined);
  assert.ok(Array.isArray(iface.defaultPrompt) ? iface.defaultPrompt.length <= 3 : true, 'at most three starter prompts');
});

test('the manifest declares no field plugin validation rejects', () => {
  const allowed = new Set(['id', 'name', 'version', 'description', 'skills', 'apps', 'mcpServers',
    'interface', 'author', 'homepage', 'repository', 'license', 'keywords']);
  for (const key of Object.keys(manifest)) assert.ok(allowed.has(key), `unexpected manifest field: ${key}`);
  assert.ok(!('hooks' in manifest), 'hooks is rejected by plugin validation');
  assert.ok(!('apps' in manifest) || existsSync(join(ROOT, '.app.json')), 'apps only when .app.json exists');
});

test('.mcp.json declares exactly one stdio server, and it is the bundled one', () => {
  const names = Object.keys(mcp.mcpServers);
  assert.deepEqual(names, ['gaia-interagent'], 'one server, named for the product');
  const entry = mcp.mcpServers['gaia-interagent'];
  assert.equal(entry.type, 'stdio', 'stdio transport only — no url, no http, no socket');
  assert.ok(!('url' in entry), 'an MCP server with a url would be a network transport');
  assert.equal(entry.command, 'node');
  assert.ok(entry.args.some((a) => a.includes('mcp-server.mjs')), `args point at the bundled server: ${entry.args}`);
  assert.ok(existsSync(bundledServerPath()), `the bundled server exists at ${bundledServerPath()}`);
});

test('nothing that ships contains a developer-only absolute path', () => {
  const offenders = [];
  const pattern = /[A-Za-z]:\\(?:Users|tmp)\\[^\s"'`,)]+|\/(?:home|Users)\/[A-Za-z0-9._-]+\//g;
  for (const file of shippedFiles()) {
    if (/\.(png|jpg|jpeg|gif|ico|pyc)$/i.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    const hits = text.match(pattern) ?? [];
    // A path shown as an *example of what not to do* inside a comment is still a
    // leak if it names a real developer directory, so there is no exemption here.
    if (hits.length) offenders.push(`${file}: ${[...new Set(hits)].join(', ')}`);
  }
  assert.deepEqual(offenders, [], 'shipped files must be machine-independent');
});

test('nothing that ships looks like a credential', () => {
  const secretish = [
    /\bsk-[A-Za-z0-9]{16,}/, /\bghp_[A-Za-z0-9]{20,}/, /\bAKIA[0-9A-Z]{16}\b/,
    /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/,
    /\bANTHROPIC_API_KEY\s*=\s*["'][^"']+["']/, /\bOPENAI_API_KEY\s*=\s*["'][^"']+["']/,
  ];
  const offenders = [];
  for (const file of shippedFiles()) {
    if (/\.(png|jpg|jpeg|gif|ico|pyc)$/i.test(file)) continue;
    const text = readFileSync(file, 'utf8');
    for (const re of secretish) if (re.test(text)) offenders.push(`${file}: ${re}`);
  }
  assert.deepEqual(offenders, []);
});

test('no stackdump, dump, or stray temp artifact ships', () => {
  const junk = shippedFiles().filter((f) => /\.(stackdump|dmp|tmp|swp|orig|rej)$|(^|[\\/])core\.\d+$/i.test(f));
  assert.deepEqual(junk, []);
});

test('the shipped sources open no listener and use no shell transport', () => {
  const result = transportChecks(pluginRoot());
  assert.ok(result.ok, result.detail);
});

test('the distributed config templates are placeholder-only', () => {
  const result = templateChecks();
  assert.ok(result.ok, result.detail);
});

test('the manifest checks the product runs on itself all pass', () => {
  for (const c of manifestChecks(pluginRoot())) assert.ok(c.ok, `${c.name}: ${c.detail}`);
});

test('the shipped ecosystem verdicts match the adapter analysis', () => {
  for (const c of ecosystemChecks()) assert.ok(c.ok, `${c.name}: ${c.detail}`);
});

test('the gate count the README states is the gate count that ships', () => {
  // The README carried 154 while the suite ran 200: the one class of defect a product
  // whose whole pitch is verified claims cannot ship, because it means a reader has to
  // re-measure the documents. Maintaining a second copy of a figure the runner already
  // prints is what let it drift, so the second copy is now checked rather than trusted.
  const testsDir = join(ROOT, 'tests');
  const declared = readdirSync(testsDir)
    .filter((f) => f.endsWith('.test.mjs'))
    .reduce((total, f) => total + (readFileSync(join(testsDir, f), 'utf8').match(/^test\(/gm) ?? []).length, 0);

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const stated = [...readme.matchAll(/(\d+)\s+(?:gates|`node:test` gates)/g)].map((m) => Number(m[1]));
  assert.ok(stated.length >= 2, `the README states its gate count: found ${JSON.stringify(stated)}`);
  for (const n of stated) {
    assert.equal(n, declared, `README says ${n} gates; ${declared} test() declarations ship`);
  }
});

test('the bus surface is six verbs and none of them is privileged', () => {
  assert.deepEqual([...BUS_VERBS].sort(), ['ack', 'handoff', 'heartbeat', 'inbox', 'register', 'send']);
  for (const verb of BUS_VERBS) {
    for (const privileged of NEVER_GRANTABLE) {
      assert.ok(!verb.includes(privileged), `${verb} is not named like ${privileged}`);
    }
  }
});

test('the server source declares the six verbs and no seventh, statically', () => {
  const src = readFileSync(bundledServerPath(), 'utf8');
  const declared = [...src.matchAll(/^\s{4}name: '([a-z-]+)',$/gm)].map((m) => m[1]);
  assert.deepEqual(declared.sort(), [...BUS_VERBS].sort(), `TOOLS declares: ${declared.join(', ')}`);
});

test('the protocol version is the product one, not the prototype one', () => {
  assert.match(PROTOCOL_VERSION, /^gaia-interagent-bus\//);
});

test('a skill ships and has the frontmatter plugin validation requires', () => {
  const skillsRoot = join(ROOT, 'skills');
  const dirs = readdirSync(skillsRoot).filter((d) => statSync(join(skillsRoot, d)).isDirectory());
  assert.ok(dirs.length >= 1, 'at least one skill');
  for (const dir of dirs) {
    const text = readFileSync(join(skillsRoot, dir, 'SKILL.md'), 'utf8');
    assert.ok(text.startsWith('---\n'), `${dir} starts with frontmatter`);
    const end = text.indexOf('\n---', 4);
    assert.ok(end > 0, `${dir} frontmatter is closed`);
    const front = text.slice(4, end);
    assert.match(front, /^name:\s*\S+/m, `${dir} declares name`);
    assert.match(front, /^description:\s*\S+/m, `${dir} declares description`);
    assert.doesNotMatch(front, /disable[-_]model[-_]invocation:\s*true/, `${dir} stays model-invocable`);
  }
});

test('LICENSE, NOTICE, and the engineering doctrine ship', () => {
  assert.ok(existsSync(join(ROOT, 'LICENSE')));
  assert.ok(existsSync(join(ROOT, 'NOTICE')));
  assert.ok(readFileSync(join(ROOT, 'NOTICE'), 'utf8').includes('peer-sessions-wmux'),
    'NOTICE credits the wmux helper this product adapts rather than reimplements');

  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const doctrinePath = join(ROOT, 'docs', 'engineering-and-research-principles.md');
  assert.ok(existsSync(doctrinePath), 'the normative engineering doctrine ships');
  assert.ok(readme.includes('docs/engineering-and-research-principles.md'),
    'the product entry point links to the doctrine');

  const doctrine = readFileSync(doctrinePath, 'utf8');
  const requiredPrinciples = [
    'ENG-01', 'ENG-02', 'ENG-03', 'ENG-04', 'ENG-05', 'ENG-06', 'ENG-07', 'ENG-08',
    'SCI-01', 'SCI-02', 'SCI-03', 'SCI-04', 'SCI-05', 'SCI-06', 'SCI-07',
  ];
  for (const id of requiredPrinciples) {
    assert.equal(doctrine.match(new RegExp(`^### ${id} —`, 'gm'))?.length ?? 0, 1,
      `${id} is declared exactly once`);
  }
  for (const requiredPhrase of [
    'Freshness, quality, acceptance, and authority remain independent axes.',
    'A marker is evidence that work stopped, not evidence that its claims are true.',
    'Alternative generation is advisory.',
  ]) {
    assert.ok(doctrine.includes(requiredPhrase), `doctrine retains: ${requiredPhrase}`);
  }
});
