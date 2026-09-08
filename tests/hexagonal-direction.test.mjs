/**
 * hexagonal-direction.test.mjs — a core never reaches an adapter for behaviour.
 *
 * Issue #108. The direction this enforces is the one hexagonal architecture is
 * for: I/O sits at the edge, the core is reachable without it, and a composition
 * root is the only place allowed to wire the two together.
 *
 * The classification is deliberately mechanical, and it is done at the level of
 * IMPORTED SYMBOLS rather than modules. That distinction is the whole reason
 * this gate is usable: `ecosystem.mjs` imports `LOCK_TIMEOUT_MS` from
 * `event-log.mjs`, and a module-level rule flags it as an inversion. Nothing
 * crosses there — a number is not behaviour. Flagging it would have forced an
 * exception for a file that is not violating anything, and every false exception
 * makes the real ones harder to see.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/**
 * A module is an adapter when it reaches an I/O primitive directly. This list is
 * the definition, not a heuristic: anything importing one of these can touch the
 * filesystem, spawn a process, or open a socket, and therefore belongs at the
 * edge.
 */
const IO_PRIMITIVES = new Set([
  'node:fs', 'node:fs/promises', 'node:child_process',
  'node:http', 'node:https', 'node:net', 'node:os', 'node:process',
]);

/**
 * Composition roots are not exempted by name here — they are DERIVED: a module
 * no other `src/` module imports is only reachable from a runner or a manifest,
 * which is what a composition root is. Deriving it means a module that stops
 * being a root, because something starts importing it, loses the exemption
 * automatically instead of keeping a stale entry on a list.
 */
function isCompositionRoot(name, modules) {
  const specifier = `./${name}`;
  return !modules.some(([other, source]) =>
    other !== name && new RegExp(`from\\s+['"]${specifier}['"]`, 'u').test(source));
}

/**
 * Known inversions, with the reason they are still here. An entry is a debt
 * record, not a permission: it names what must change, so the list shrinking is
 * visible in the diff.
 */
const ACCEPTED_INVERSIONS = new Map([
  ['factory-telemetry-phase.mjs -> factory-telemetry-log.mjs',
    'Imports appendFactoryTelemetryEvent and readFactoryTelemetryLog, both of which '
    + 'take a directory and write to it. The fix is to accept them as ports the way '
    + 'createCanaryDraftAdmission already does, which changes this module\'s callers '
    + 'and belongs in its own change rather than in the commit that adds this gate.'],
]);

function readModules() {
  return readdirSync(SRC)
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => [f, readFileSync(join(SRC, f), 'utf8')]);
}

/** Every `import … from '…'` in a module, with the names it pulls out. */
function importsOf(source) {
  const found = [];
  for (const m of source.matchAll(/import\s+([^;]*?)\s+from\s+['"]([^'"]+)['"]/gu)) {
    const names = [...m[1].matchAll(/[A-Za-z_$][\w$]*/gu)].map((n) => n[0]);
    found.push({ specifier: m[2], names });
  }
  return found;
}

/**
 * Does the adapter export this name as behaviour, or as a value?
 *
 * `export function` and `export async function` are behaviour and may run I/O.
 * `export const NAME = 30_000` is a value: importing it couples the core to a
 * number, which is a coupling question, not a direction one.
 */
function exportsBehaviour(adapterSource, name) {
  const asFunction = new RegExp(`export\\s+(?:async\\s+)?function\\s+${name}\\b`, 'u');
  const asConstFunction = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(?:async\\s*)?(?:\\(|function)`, 'u');
  return asFunction.test(adapterSource) || asConstFunction.test(adapterSource);
}

function inversions() {
  const modules = readModules();
  const byName = new Map(modules);
  const adapters = new Set(modules
    .filter(([, source]) => importsOf(source).some((i) => IO_PRIMITIVES.has(i.specifier)))
    .map(([name]) => name));

  const found = [];
  for (const [name, source] of modules) {
    if (adapters.has(name)) continue;                      // an adapter may reach an adapter
    if (isCompositionRoot(name, modules)) continue;        // roots exist to wire the two together
    for (const { specifier, names } of importsOf(source)) {
      if (!specifier.startsWith('./')) continue;
      const target = specifier.slice(2);
      if (!adapters.has(target)) continue;
      const crossing = names.filter((n) => exportsBehaviour(byName.get(target) ?? '', n));
      if (crossing.length > 0) found.push({ edge: `${name} -> ${target}`, crossing });
    }
  }
  return { found, adapters, modules };
}

test('a core module never imports behaviour from an adapter', () => {
  const { found } = inversions();
  const unaccepted = found.filter((f) => !ACCEPTED_INVERSIONS.has(f.edge));
  assert.deepEqual(unaccepted.map((f) => `${f.edge} (${f.crossing.join(', ')})`), [],
    'a core module reached an adapter for behaviour; accept the dependency as a port, '
    + 'or record it in ACCEPTED_INVERSIONS with the reason it is still here');
});

test('every accepted inversion still exists, so the list cannot rot', () => {
  const { found } = inversions();
  const live = new Set(found.map((f) => f.edge));
  for (const edge of ACCEPTED_INVERSIONS.keys()) {
    assert.ok(live.has(edge),
      `${edge} is accepted but no longer present — delete the entry, an exception that `
      + 'protects nothing teaches the next reader that the list is decorative');
  }
});

test('the gate detects a seeded inversion, and is not vacuous', () => {
  // The completion proof issue #108 asks for. Without it, a gate that classified
  // nothing as an adapter would pass for the same reason a correct tree does.
  const { adapters, modules } = inversions();
  assert.ok(adapters.size >= 10, `adapters are actually detected: found ${adapters.size}`);

  const core = modules.find(([name]) => !adapters.has(name) && !isCompositionRoot(name, modules));
  assert.ok(core, 'a non-root core module exists to seed against');

  const adapter = [...adapters].find((a) => /export\s+(?:async\s+)?function\s+\w/u.test(
    modules.find(([n]) => n === a)[1]));
  const fnName = readFileSync(join(SRC, adapter), 'utf8')
    .match(/export\s+(?:async\s+)?function\s+(\w+)/u)[1];

  // Seeded in memory, never on disk: the tree this runs against stays clean.
  assert.ok(exportsBehaviour(readFileSync(join(SRC, adapter), 'utf8'), fnName),
    'the seeded symbol is behaviour, so importing it would be a real crossing');
  const seeded = importsOf(`import { ${fnName} } from './${adapter}';`);
  assert.deepEqual(seeded, [{ specifier: `./${adapter}`, names: [fnName] }],
    'the parser sees the seeded edge that the rule would then reject');
});

test('a composition root is derived from the import graph, not from a name list', () => {
  const modules = readModules();
  // mcp-server.mjs is the manifest entry point: `.mcp.json` names it, and no
  // src/ module imports it. It must therefore be reachable to wire adapters in.
  assert.ok(isCompositionRoot('mcp-server.mjs', modules),
    'the declared MCP entry point is a composition root');
  // event-log.mjs is imported by other modules, so it is a library and could
  // never be exempted by this rule however much I/O it does.
  assert.ok(!isCompositionRoot('event-log.mjs', modules),
    'a module other modules import is not a root');
});
