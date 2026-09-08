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
 *
 * ---------------------------------------------------------------------------
 * WHAT CHANGED, AND WHY (adversarial review of the first version)
 *
 * The first version of this gate was measured and it did not hold. Three
 * structural defects, all now fixed, all now covered by tests that were watched
 * failing before they were watched passing:
 *
 *  1. It examined 24 of 80 modules. `readModules()` read only `src/`, and a
 *     module that no OTHER `src/` module imported was declared a "composition
 *     root" and exempted. 44 modules qualified; exactly ONE of them
 *     (`mcp-server.mjs`) is an entry point. The other 43 were ordinary
 *     libraries whose importers live in `scripts/` and `tests/` — directories
 *     the gate never read. `control-room.mjs` had 13 outside importers and was
 *     exempt. Worse, the exemption was automatic: any new module consumed only
 *     from `scripts/` was born exempt.
 *
 *     Fixed by grounding rootness in the MANIFESTS that actually start
 *     processes (`.mcp.json`, `package.json` scripts/bin) instead of in the
 *     absence of a `src/` importer, and by reading `src/`, `scripts/` and
 *     `tests/` recursively so the census that proves it can be asserted.
 *     "Nothing imports it" is deliberately NOT a rootness criterion any more:
 *     that is precisely the rule that manufactured 43 fake roots.
 *
 *  2. Eighteen mechanical rewrites walked past it, because it was `matchAll`
 *     over raw text. The cheapest was ONE unused `import { tmpdir } from
 *     'node:os'`, which reclassified any module as an adapter and exempted it
 *     permanently with zero behavioural change.
 *
 *     Fixed by tokenising (below) and by three rule changes: an import only
 *     confers adapter status if a binding from it is actually USED; builtins
 *     are I/O by default and pure ones are named; and imported symbols are
 *     resolved through re-export chains to the module that really defines them.
 *
 *  3. Comments and string literals fabricated inversions. A commented-out
 *     import fired the gate — so the standard way to record a removed
 *     dependency created the violation it documented removing.
 *
 *     Fixed by the tokeniser: comments and literals are not code.
 *
 * ---------------------------------------------------------------------------
 * WHY A HAND-WRITTEN TOKENISER AND NOT A PARSER PACKAGE
 *
 * gaia ships zero runtime dependencies, so adding one is not available. Node
 * exposes no ESM parser: `vm.SourceTextModule` needs
 * `--experimental-vm-modules`, which `node --test` does not set, and nothing in
 * `node:module` returns an import list — `builtinModules` (which IS used below,
 * to canonicalise `fs` against `node:fs`) is the only static help it offers.
 *
 * So the choice was a regex over raw text, or a lexer. The lexer wins, and it is
 * enough: the import/export grammar is a small, statement-level sublanguage, and
 * everything that made the regex version wrong — comments, string and template
 * literals, regex literals, `function*`, `export {}` lists, arrow bodies — is
 * either solved outright by lexing or becomes a short scan over a token stream.
 * A full expression parser would buy nothing here; the gate never needs to know
 * what an expression MEANS, only whether an exported binding is behaviour or a
 * value. The tokeniser is asserted below against every `.mjs` this repo ships.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { builtinModules } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');


/** Directories whose modules take part in the import graph. */
const GRAPH_DIRS = ['src', 'scripts', 'tests'];

/**
 * Builtins that cannot reach the outside world: they compute, they do not talk
 * to a disk, a process or a socket.
 *
 * This is an ALLOWLIST, and the inversion is the point. The first version named
 * the eight I/O builtins it could think of, so `node:dgram` (a UDP socket),
 * `node:worker_threads` (a thread) and `node:tls` (a TLS socket) all sailed
 * through, and every builtin Node adds in future would too. Naming the pure
 * ones instead means the default for anything unrecognised is "this is an
 * edge", which is the direction a gate should fail in.
 *
 * `node:module` is NOT pure: `createRequire` is a general escape hatch to every
 * other builtin, so a module that reaches it is at the edge by construction.
 * `node:crypto` IS pure — gaia uses it 56 times for hashing and ids, and a hash
 * is arithmetic.
 */
const PURE_BUILTINS = new Set([
  'assert', 'assert/strict', 'buffer', 'console', 'constants', 'crypto',
  'diagnostics_channel', 'events', 'path', 'path/posix', 'path/win32',
  'punycode', 'querystring', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'timers', 'timers/promises', 'url', 'util',
  'util/types', 'zlib',
]);

/**
 * Globals that perform I/O with no import at all. `fetch` is the one that
 * matters: a module can do network I/O in modern Node without importing
 * anything, which the first version could not see by construction.
 *
 * `process` is deliberately absent. It is a global too, but `process.env` reads
 * are pervasive and are configuration rather than a crossing; treating them as
 * I/O would classify most of `src/` as an adapter and leave nothing to check.
 * That is a known hole, recorded here rather than left implicit.
 */
const IO_GLOBALS = new Set(['fetch', 'WebSocket', 'EventSource', 'XMLHttpRequest']);

/** Calls that return data whatever you hand them. See `valueKind`. */
const VALUE_CALLS = new Set(['Number', 'String', 'Boolean', 'BigInt', 'Symbol', 'parseInt', 'parseFloat']);
const VALUE_STATIC_CALLS = new Set(['Object.freeze', 'JSON.parse', 'JSON.stringify', 'Array.from', 'Date.now']);

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

  // The four below were NOT found by the first version of this gate, and not
  // because they are subtle. All three importing modules were classified as
  // composition roots by the old "no src/ module imports it" rule and exempted
  // wholesale; `factory-drain-telemetry.mjs` is imported by
  // `scripts/factory-telemetry-step.mjs`, `github-draft-admission.mjs` by
  // `scripts/github-portfolio-operator.mjs`, and `reporting-context.mjs` by its
  // own test. They are recorded rather than fixed on purpose: making the gate
  // honest is this change, and paying the debt it exposes is separate work that
  // touches each module's callers.
  ['factory-drain-telemetry.mjs -> factory-telemetry-log.mjs',
    'Same shape as the entry above and the same fix: appendFactoryTelemetryEvent and '
    + 'readFactoryTelemetryLog take a directory and write to it. Accept them as ports '
    + 'injected by the caller. Do it in one change with the factory-telemetry-phase '
    + 'entry, since both modules cross into the same adapter.'],
  ['factory-drain-telemetry.mjs -> portfolio-drain-ledger.mjs',
    'appendPortfolioDrainReceipt and readPortfolioDrainLedger take a ledger directory '
    + 'and read and write it. The drain telemetry core should receive a ledger port, '
    + 'not reach for the on-disk ledger itself; the receipt shape is already a value '
    + 'type, so the port is a two-method interface.'],
  ['github-draft-admission.mjs -> gh-draft-operation-provider.mjs',
    'Imports createGhDraftOperationProvider, a factory over a `gh` subprocess adapter. '
    + 'The core constructs its own provider instead of being handed one, which is the '
    + 'same inversion createCanaryDraftAdmission already solved by taking the provider '
    + 'as an argument. The fix is to move the construction up to the operator script.'],
  ['reporting-context.mjs -> lineage-receipt.mjs',
    'buildLineageReceipt stats files to seal a receipt, so the reporting core reaches '
    + 'the filesystem through it. The receipt builder should be injected, which also '
    + 'makes reporting-context testable without a tree on disk.'],
]);

// ---------------------------------------------------------------------------
// Tokeniser
// ---------------------------------------------------------------------------

const IDENT_START = /[A-Za-z_$]/u;
const IDENT_PART = /[A-Za-z0-9_$]/u;

/** Tokens after which a `/` is division, not the start of a regex literal. */
const DIVISION_AFTER = new Set(['name', 'number', 'string', 'template', 'regex']);
/** Keywords after which a `/` still starts a regex, despite being `name` tokens. */
const REGEX_AFTER_KEYWORD = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do',
  'else', 'yield', 'await', 'case', 'throw',
]);

/**
 * Lex ESM source into significant tokens. Comments are dropped. Strings and
 * templates become one token carrying their text; code inside a template's
 * `${…}` is lexed as code, so an identifier used only inside an interpolation
 * still counts as used.
 *
 * Throws on unterminated input rather than guessing — a gate that silently
 * mis-lexes is the failure mode being repaired.
 */
function tokenize(source) {
  const tokens = [];
  const templateStack = [];
  let braceDepth = 0;
  let mode = 'code';
  let i = 0;
  const n = source.length;

  const last = () => tokens[tokens.length - 1];
  const regexAllowed = () => {
    const t = last();
    if (!t) return true;
    if (t.type === 'name') return REGEX_AFTER_KEYWORD.has(t.value);
    if (DIVISION_AFTER.has(t.type)) return false;
    return !(t.value === ')' || t.value === ']');
  };

  const readTemplateChunk = () => {
    // Positioned just after a backtick or just after the `}` closing a `${…}`.
    while (i < n) {
      const c = source[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') { i += 1; mode = 'code'; return; }
      if (c === '$' && source[i + 1] === '{') {
        i += 2;
        templateStack.push(braceDepth);
        braceDepth += 1;
        mode = 'code';
        return;
      }
      i += 1;
    }
    throw new Error('unterminated template literal');
  };

  while (i < n) {
    if (mode === 'template') { readTemplateChunk(); continue; }

    const c = source[i];

    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f'
      || c === '\v' || c === '\u00a0' || c === '\ufeff') { i += 1; continue; }

    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) throw new Error('unterminated block comment');
      i = end + 2;
      continue;
    }

    if (c === '"' || c === "'") {
      const start = i;
      const quote = c;
      i += 1;
      let value = '';
      while (i < n && source[i] !== quote) {
        if (source[i] === '\n') throw new Error('unterminated string literal');
        if (source[i] === '\\') { value += source[i + 1] ?? ''; i += 2; continue; }
        value += source[i];
        i += 1;
      }
      if (i >= n) throw new Error('unterminated string literal');
      i += 1;
      tokens.push({ type: 'string', value, start, end: i });
      continue;
    }

    if (c === '`') {
      tokens.push({ type: 'template', value: '`', start: i, end: i + 1 });
      i += 1;
      mode = 'template';
      continue;
    }

    if (c === '/' && regexAllowed()) {
      const start = i;
      i += 1;
      let inClass = false;
      while (i < n) {
        const d = source[i];
        if (d === '\\') { i += 2; continue; }
        if (d === '[') inClass = true;
        else if (d === ']') inClass = false;
        else if (d === '/' && !inClass) break;
        else if (d === '\n') throw new Error('unterminated regex literal');
        i += 1;
      }
      if (i >= n) throw new Error('unterminated regex literal');
      i += 1;
      while (i < n && IDENT_PART.test(source[i])) i += 1;
      tokens.push({ type: 'regex', value: source.slice(start, i), start, end: i });
      continue;
    }

    if (/[0-9]/u.test(c) || (c === '.' && /[0-9]/u.test(source[i + 1] ?? ''))) {
      const start = i;
      while (i < n && /[0-9a-zA-Z_.]/u.test(source[i])) {
        // An exponent sign is part of the number; `1e-3` must not split.
        if ((source[i] === 'e' || source[i] === 'E')
          && (source[i + 1] === '+' || source[i + 1] === '-')) i += 1;
        i += 1;
      }
      tokens.push({ type: 'number', value: source.slice(start, i), start, end: i });
      continue;
    }

    if (IDENT_START.test(c)) {
      const start = i;
      while (i < n && IDENT_PART.test(source[i])) i += 1;
      tokens.push({ type: 'name', value: source.slice(start, i), start, end: i });
      continue;
    }

    if (c === '{') { braceDepth += 1; tokens.push({ type: 'punct', value: '{', start: i, end: i + 1 }); i += 1; continue; }
    if (c === '}') {
      braceDepth -= 1;
      if (templateStack.length > 0 && braceDepth === templateStack[templateStack.length - 1]) {
        templateStack.pop();
        i += 1;
        mode = 'template';
        continue;
      }
      tokens.push({ type: 'punct', value: '}', start: i, end: i + 1 });
      i += 1;
      continue;
    }

    // Longest-match punctuation, so `=>` and `...` are single tokens.
    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (three === '...') { tokens.push({ type: 'punct', value: '...', start: i, end: i + 3 }); i += 3; continue; }
    if (two === '=>' || two === '?.' || two === '??' || two === '**') {
      tokens.push({ type: 'punct', value: two, start: i, end: i + 2 });
      i += 2;
      continue;
    }
    tokens.push({ type: 'punct', value: c, start: i, end: i + 1 });
    i += 1;
  }

  if (mode === 'template') throw new Error('unterminated template literal');
  return tokens;
}

// ---------------------------------------------------------------------------
// Module record: what a file imports, what it exports, and what it uses
// ---------------------------------------------------------------------------

const isName = (t, v) => t !== undefined && t.type === 'name' && t.value === v;
const isPunct = (t, v) => t !== undefined && t.type === 'punct' && t.value === v;

/**
 * Read one module's import/export record off the token stream.
 *
 * Covers the whole surface the review used to walk past: side-effect imports,
 * namespace imports, default imports, dynamic `import()`, `export {}` lists,
 * `export … from` re-exports, `export *`, generators, classes and default
 * exports. Everything it cannot classify is reported as `unknown`, and the
 * caller treats `unknown` as behaviour — a gate should fail closed.
 */
function moduleRecord(source) {
  const tokens = tokenize(source);
  const imports = [];          // { specifier, names: [imported], bindings: [local], dynamic }
  const exports = new Map();   // exported name -> { kind, local, from, imported }
  const starReExports = [];    // specifiers of `export * from '…'`
  const importSpans = [];      // [start, end) byte ranges of import statements

  const declKind = new Map();  // local declaration name -> kind

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t.type !== 'name') continue;

    // ---- import ---------------------------------------------------------
    if (t.value === 'import') {
      const next = tokens[i + 1];
      if (isPunct(next, '.')) continue;                    // import.meta
      if (isPunct(next, '(')) {                            // dynamic import()
        const arg = tokens[i + 2];
        if (arg !== undefined && arg.type === 'string') {
          imports.push({ specifier: arg.value, names: [], bindings: [], dynamic: true });
        } else {
          imports.push({ specifier: null, names: [], bindings: [], dynamic: true });
        }
        continue;
      }
      if (next !== undefined && next.type === 'string') {  // side-effect import
        imports.push({ specifier: next.value, names: [], bindings: [], dynamic: false, sideEffect: true });
        importSpans.push([t.start, next.end]);
        i += 1;
        continue;
      }
      const clause = readImportClause(tokens, i + 1);
      if (clause === null) continue;
      imports.push({
        specifier: clause.specifier,
        names: clause.names,
        bindings: clause.bindings,
        dynamic: false,
      });
      importSpans.push([t.start, clause.end]);
      i = clause.index;
      continue;
    }

    // ---- export ---------------------------------------------------------
    if (t.value === 'export') {
      const parsed = readExport(tokens, i);
      if (parsed === null) continue;
      for (const e of parsed.exports) exports.set(e.name, e);
      if (parsed.starFrom !== undefined) starReExports.push(parsed.starFrom);
      if (parsed.declared !== undefined) declKind.set(parsed.declared.name, parsed.declared.kind);
      i = parsed.index;
      continue;
    }

    // ---- plain local declarations (targets of `export { … }`) ------------
    if (t.value === 'function' || t.value === 'class') {
      const nameTok = isPunct(tokens[i + 1], '*') ? tokens[i + 2] : tokens[i + 1];
      if (nameTok !== undefined && nameTok.type === 'name') {
        declKind.set(nameTok.value, t.value === 'class' ? 'class' : 'function');
      }
      continue;
    }
    if (t.value === 'async' && isName(tokens[i + 1], 'function')) {
      const nameTok = isPunct(tokens[i + 2], '*') ? tokens[i + 3] : tokens[i + 2];
      if (nameTok !== undefined && nameTok.type === 'name') declKind.set(nameTok.value, 'function');
      continue;
    }
    if (t.value === 'const' || t.value === 'let' || t.value === 'var') {
      const nameTok = tokens[i + 1];
      if (nameTok !== undefined && nameTok.type === 'name' && isPunct(tokens[i + 2], '=')) {
        declKind.set(nameTok.value, valueKind(tokens, i + 3));
      }
      continue;
    }
  }

  // Resolve `export { local as exported }` against the local declarations.
  for (const [name, entry] of exports) {
    if (entry.kind === 'local-ref') {
      exports.set(name, { ...entry, kind: declKind.get(entry.local) ?? 'unknown' });
    }
  }

  const usedNames = usedIdentifiers(tokens, importSpans);
  return { tokens, imports, exports, starReExports, usedNames };
}

/** `{ a, b as c }` / `* as ns` / `def` / `def, { a }` followed by `from '…'`. */
function readImportClause(tokens, start) {
  const names = [];
  const bindings = [];
  let i = start;
  while (i < tokens.length && !isName(tokens[i], 'from')) {
    const t = tokens[i];
    if (t.type === 'string') return null;          // malformed; ignore this statement
    if (isPunct(t, '{')) {
      i += 1;
      while (i < tokens.length && !isPunct(tokens[i], '}')) {
        if (tokens[i].type === 'name' && tokens[i].value !== 'as') {
          if (isName(tokens[i + 1], 'as') && tokens[i + 2] !== undefined) {
            names.push(tokens[i].value);
            bindings.push(tokens[i + 2].value);
            i += 3;
            continue;
          }
          names.push(tokens[i].value);
          bindings.push(tokens[i].value);
        }
        i += 1;
      }
      i += 1;
      continue;
    }
    if (isPunct(t, '*')) {
      if (isName(tokens[i + 1], 'as') && tokens[i + 2] !== undefined) {
        names.push('*');
        bindings.push(tokens[i + 2].value);
        i += 3;
        continue;
      }
      i += 1;
      continue;
    }
    if (t.type === 'name') { names.push('default'); bindings.push(t.value); }
    i += 1;
  }
  const spec = tokens[i + 1];
  if (spec === undefined || spec.type !== 'string') return null;
  return { specifier: spec.value, names, bindings, index: i + 1, end: spec.end };
}

/** One `export …` statement: what names it publishes and in what form. */
function readExport(tokens, i) {
  const a = tokens[i + 1];
  if (a === undefined) return null;

  // export * [as ns] from '…'
  if (isPunct(a, '*')) {
    let j = i + 2;
    if (isName(tokens[j], 'as')) j += 2;
    if (isName(tokens[j], 'from') && tokens[j + 1]?.type === 'string') {
      return { exports: [], starFrom: tokens[j + 1].value, index: j + 1 };
    }
    return { exports: [], index: j };
  }

  // export { a, b as c } [from '…']
  if (isPunct(a, '{')) {
    const spec = [];
    let j = i + 2;
    while (j < tokens.length && !isPunct(tokens[j], '}')) {
      if (tokens[j].type === 'name' && tokens[j].value !== 'as') {
        if (isName(tokens[j + 1], 'as') && tokens[j + 2] !== undefined) {
          spec.push({ local: tokens[j].value, name: tokens[j + 2].value });
          j += 3;
          continue;
        }
        spec.push({ local: tokens[j].value, name: tokens[j].value });
      }
      j += 1;
    }
    j += 1;
    if (isName(tokens[j], 'from') && tokens[j + 1]?.type === 'string') {
      const from = tokens[j + 1].value;
      return {
        exports: spec.map((s) => ({ name: s.name, kind: 're-export', imported: s.local, from })),
        index: j + 1,
      };
    }
    return { exports: spec.map((s) => ({ name: s.name, kind: 'local-ref', local: s.local })), index: j - 1 };
  }

  // export default …
  if (isName(a, 'default')) {
    const b = tokens[i + 2];
    let kind = 'unknown';
    if (isName(b, 'function') || (isName(b, 'async') && isName(tokens[i + 3], 'function'))) kind = 'function';
    else if (isName(b, 'class')) kind = 'class';
    else kind = valueKind(tokens, i + 2);
    return { exports: [{ name: 'default', kind }], index: i + 2 };
  }

  // export function f / export function* f / export async function f / export class C
  if (isName(a, 'function') || isName(a, 'class')) {
    const nameTok = isPunct(tokens[i + 2], '*') ? tokens[i + 3] : tokens[i + 2];
    if (nameTok === undefined || nameTok.type !== 'name') return null;
    const kind = a.value === 'class' ? 'class' : 'function';
    return {
      exports: [{ name: nameTok.value, kind }],
      declared: { name: nameTok.value, kind },
      index: i + 2,
    };
  }
  if (isName(a, 'async') && isName(tokens[i + 2], 'function')) {
    const nameTok = isPunct(tokens[i + 3], '*') ? tokens[i + 4] : tokens[i + 3];
    if (nameTok === undefined || nameTok.type !== 'name') return null;
    return {
      exports: [{ name: nameTok.value, kind: 'function' }],
      declared: { name: nameTok.value, kind: 'function' },
      index: i + 3,
    };
  }

  // export const NAME = …  (also let / var)
  if (isName(a, 'const') || isName(a, 'let') || isName(a, 'var')) {
    const nameTok = tokens[i + 2];
    if (nameTok === undefined || nameTok.type !== 'name') return null;
    if (!isPunct(tokens[i + 3], '=')) {
      return { exports: [{ name: nameTok.value, kind: 'value' }], index: i + 2 };
    }
    const kind = valueKind(tokens, i + 4);
    return {
      exports: [{ name: nameTok.value, kind }],
      declared: { name: nameTok.value, kind },
      index: i + 3,
    };
  }

  return null;
}

/**
 * Is the right-hand side of a binding a value, or something that can run?
 *
 * Literals, frozen literals and the standard immutable collections are values:
 * importing one couples a core to a number or a table, which is a coupling
 * question and not a direction one — `LOCK_TIMEOUT_MS` is the case this whole
 * gate exists to NOT flag. Anything else is treated as behaviour, including a
 * bare alias and a call result, because either can be a function. That is the
 * fail-closed direction, and it is a deliberate change: the first version
 * defaulted the unrecognised forms to "value" and let six export shapes past.
 */
function valueKind(tokens, at) {
  const t = tokens[at];
  if (t === undefined) return 'unknown';
  if (t.type === 'string' || t.type === 'number' || t.type === 'template' || t.type === 'regex') return 'value';
  if (isPunct(t, '[') || isPunct(t, '{')) return 'value';
  if (t.type === 'name' && ['true', 'false', 'null', 'undefined'].includes(t.value)) return 'value';
  if (isName(t, 'new')) {
    const ctor = tokens[at + 1];
    if (ctor !== undefined && ['Set', 'Map', 'WeakSet', 'WeakMap', 'Date', 'RegExp', 'URL'].includes(ctor.value)) return 'value';
    return 'unknown';
  }
  // Calls whose return type is data by construction. This list is short and
  // named on purpose: `export const LOCK_TIMEOUT_MS = Number(process.env.X ??
  // 10_000)` is the documented case this gate must NOT flag, and a call is
  // otherwise `unknown` because it can return a function.
  if (t.type === 'name' && VALUE_CALLS.has(t.value) && isPunct(tokens[at + 1], '(')) return 'value';
  if (t.type === 'name' && (t.value === 'Object' || t.value === 'JSON' || t.value === 'Array' || t.value === 'Date')
    && isPunct(tokens[at + 1], '.') && tokens[at + 2] !== undefined
    && VALUE_STATIC_CALLS.has(`${t.value}.${tokens[at + 2].value}`)) {
    // `Object.freeze` returns its argument, so it is only data when it froze
    // data — `Object.freeze(handler)` hands back a function.
    if (`${t.value}.${tokens[at + 2].value}` !== 'Object.freeze') return 'value';
    const arg = tokens[at + 4];
    return arg !== undefined && (isPunct(arg, '{') || isPunct(arg, '[')) ? 'value' : 'unknown';
  }
  if (isName(t, 'function') || (isName(t, 'async') && isName(tokens[at + 1], 'function'))) return 'function';
  if (isName(t, 'class')) return 'class';

  // Arrow at the head of the initialiser: `x => …`, `(a, b) => …`, `async x => …`.
  let j = at;
  if (isName(tokens[j], 'async')) j += 1;
  if (tokens[j] !== undefined && tokens[j].type === 'name' && isPunct(tokens[j + 1], '=>')) return 'function';
  if (isPunct(tokens[j], '(')) {
    let depth = 0;
    for (let k = j; k < tokens.length; k += 1) {
      if (isPunct(tokens[k], '(')) depth += 1;
      else if (isPunct(tokens[k], ')')) {
        depth -= 1;
        if (depth === 0) return isPunct(tokens[k + 1], '=>') ? 'function' : 'unknown';
      }
    }
  }
  return 'unknown';
}

/** Every identifier used somewhere other than inside an import statement. */
function usedIdentifiers(tokens, importSpans) {
  const used = new Set();
  for (const t of tokens) {
    if (t.type !== 'name') continue;
    if (importSpans.some(([s, e]) => t.start >= s && t.start < e)) continue;
    used.add(t.value);
  }
  return used;
}

// ---------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------

function walkModules(dir, base = dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) { out.push(...walkModules(full, base)); continue; }
    if (!entry.endsWith('.mjs')) continue;
    out.push([relative(base, full).split('\\').join('/'), readFileSync(full, 'utf8')]);
  }
  return out;
}

/**
 * The modules the gate classifies: everything under `src/`, RECURSIVELY. The
 * first version used a flat `readdirSync`, so an adapter one directory down was
 * invisible.
 */
function readModules(root = ROOT) {
  return walkModules(join(root, 'src'));
}

/**
 * Every module that can import a `src/` module — `src/`, `scripts/` and
 * `tests/`, recursively. The first version read only `src/`, which is why
 * modules imported by 13 scripts were classified as composition roots.
 */
function readImporters(root = ROOT) {
  const out = [];
  for (const dir of GRAPH_DIRS) {
    for (const [name, source] of walkModules(join(root, dir))) out.push([`${dir}/${name}`, source]);
  }
  return out;
}

/**
 * Composition roots, DERIVED from the manifests that actually start a process:
 * `.mcp.json` argv and `package.json` `scripts` / `bin`. Still derived, not a
 * hand-list — removing an entry from a manifest revokes the exemption on the
 * next run.
 *
 * What is NOT a criterion any more: "no other `src/` module imports it". That
 * rule produced 44 roots of which one was real, and it made every module
 * consumed only from `scripts/` exempt from birth.
 */
function manifestRoots(root = ROOT) {
  const roots = new Set();
  const texts = [];
  for (const file of ['.mcp.json', 'package.json']) {
    const full = join(root, file);
    if (existsSync(full)) texts.push(readFileSync(full, 'utf8'));
  }
  for (const text of texts) {
    for (const m of text.matchAll(/(?:\.\/)?src\/([\w./-]+\.mjs)/gu)) roots.add(m[1]);
  }
  return roots;
}

function isCompositionRoot(name, roots) {
  return roots.has(name);
}

/** Resolve a relative specifier against the importing module's directory. */
function resolveLocal(fromModule, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  const dir = posix.dirname(fromModule);
  return posix.normalize(posix.join(dir === '.' ? '' : dir, specifier));
}

/** `fs` and `node:fs` are the same builtin; `builtinModules` is the authority. */
const BUILTINS = new Set(builtinModules);
function classifySpecifier(specifier) {
  if (specifier === null) return { kind: 'dynamic-opaque' };
  const bare = specifier.startsWith('node:') ? specifier.slice(5) : specifier;
  if (!BUILTINS.has(bare) && !BUILTINS.has(specifier)) return { kind: 'other' };
  return { kind: PURE_BUILTINS.has(bare) ? 'pure-builtin' : 'io-builtin', builtin: bare };
}

/**
 * Is this module at the edge?
 *
 * A module is an adapter when it can actually reach an I/O primitive: it
 * imports one AND uses a binding from it, or it side-effect-imports one, or it
 * reaches one through `import()`, or it calls an I/O global.
 *
 * The usage requirement is the fix for the cheapest evasion found in review:
 * one unused `import { tmpdir } from 'node:os'` reclassified any module as an
 * adapter and exempted it permanently with no behavioural change at all.
 * "Reaches an I/O primitive" now means reaches, not mentions.
 */
function isAdapter(record) {
  for (const imp of record.imports) {
    const cls = classifySpecifier(imp.specifier);
    if (cls.kind === 'dynamic-opaque') return true;      // a computed import can reach anything
    if (cls.kind !== 'io-builtin') continue;
    if (imp.dynamic || imp.sideEffect) return true;
    if (imp.bindings.length === 0) return true;
    if (imp.bindings.some((b) => record.usedNames.has(b))) return true;
  }
  return [...IO_GLOBALS].some((g) => record.usedNames.has(g));
}

/**
 * Follow `export … from` chains to the module that really defines a symbol.
 *
 * A barrel that re-exports an adapter's writer is not a laundering service: the
 * core still ends up holding the adapter's behaviour. The first version could
 * not see this at all — the barrel imports no I/O, so it was not an adapter,
 * and the re-export was invisible to both the import scan and the classifier.
 */
function resolveExport(moduleName, symbol, records, seen = new Set()) {
  const key = `${moduleName}#${symbol}`;
  if (seen.has(key)) return null;
  seen.add(key);
  const record = records.get(moduleName);
  if (record === undefined) return null;

  const entry = record.exports.get(symbol);
  if (entry !== undefined && entry.kind === 're-export') {
    const target = resolveLocal(moduleName, entry.from);
    if (target === null) return { module: moduleName, kind: 'unknown' };
    const deeper = resolveExport(target, entry.imported, records, seen);
    return deeper ?? { module: target, kind: 'unknown' };
  }
  if (entry !== undefined) return { module: moduleName, kind: entry.kind };

  for (const specifier of record.starReExports) {
    const target = resolveLocal(moduleName, specifier);
    if (target === null) continue;
    const deeper = resolveExport(target, symbol, records, seen);
    if (deeper !== null) return deeper;
  }
  return null;
}

const BEHAVIOUR_KINDS = new Set(['function', 'class', 'unknown']);

/**
 * Does the adapter publish this name as behaviour, or as a value?
 *
 * `unknown` counts as behaviour. A gate that cannot tell must not clear the
 * edge — the first version's unknown-means-value default is what let generators,
 * classes, arrow constants, aliases and default exports through.
 */
function exportsBehaviour(moduleName, symbol, records) {
  if (symbol === '*') return true;                  // a namespace import takes everything
  const resolved = resolveExport(moduleName, symbol, records);
  if (resolved === null) return false;              // the adapter does not export it at all
  return BEHAVIOUR_KINDS.has(resolved.kind);
}

/**
 * Build the whole analysis for a tree.
 *
 * `tree` is injectable so the vacuity proof can run the REAL rule against a
 * seeded tree. The first version's proof only checked that the helpers ran on
 * fragments, never that `inversions()` rejects a violation — which is exactly
 * why 18 evasions and 4 false positives shipped.
 */
function analyse(tree) {
  const records = new Map();
  for (const [name, source] of tree.modules) records.set(name, moduleRecord(source));

  const adapters = new Set([...records].filter(([, r]) => isAdapter(r)).map(([n]) => n));
  const roots = tree.roots;

  // Who imports each src/ module, counting every directory in the graph. This
  // census is what showed that 43 of the 44 derived "composition roots" were
  // ordinary libraries whose importers simply lived outside src/.
  const importedByOutside = new Map();
  for (const [importer, source] of tree.importers ?? []) {
    let record;
    try { record = moduleRecord(source); } catch { continue; }
    for (const imp of record.imports) {
      if (imp.specifier === null || !imp.specifier.startsWith('.')) continue;
      const resolved = posix.normalize(posix.join(posix.dirname(importer), imp.specifier));
      if (!resolved.startsWith('src/')) continue;
      const target = resolved.slice('src/'.length);
      if (!records.has(target) || `src/${target}` === importer) continue;
      if (!importedByOutside.has(target)) importedByOutside.set(target, []);
      importedByOutside.get(target).push(importer);
    }
  }

  const found = [];
  const checked = [];
  for (const [name, record] of records) {
    if (adapters.has(name)) continue;                       // an adapter may reach an adapter
    if (isCompositionRoot(name, roots)) continue;           // roots exist to wire the two together
    checked.push(name);
    for (const imp of record.imports) {
      if (imp.specifier === null) continue;
      const target = resolveLocal(name, imp.specifier);
      if (target === null || !records.has(target)) continue;
      const crossing = [];
      // A side-effect import binds nothing, so it carries no behaviour across.
      // A namespace import (`* as store`) carries everything, and `names` holds
      // `'*'` for it.
      for (const symbol of imp.names) {
        const resolved = resolveExport(target, symbol, records);
        const origin = resolved?.module ?? target;
        if (!adapters.has(origin)) continue;
        if (!exportsBehaviour(target, symbol, records)) continue;
        crossing.push(origin === target ? symbol : `${symbol} via ${origin}`);
      }
      if (crossing.length > 0) found.push({ edge: `${name} -> ${target}`, crossing });
    }
  }
  return { found, adapters, records, roots, checked, importedByOutside };
}

function readTree(root = ROOT) {
  return {
    modules: readModules(root),
    importers: readImporters(root),
    roots: manifestRoots(root),
  };
}

function inversions(root = ROOT) {
  return analyse(readTree(root));
}

/** Build an in-memory tree from `{ 'name.mjs': source }` for the seeded proofs. */
function treeOf(files, { roots = [], importers = [] } = {}) {
  return {
    modules: Object.entries(files),
    importers,
    roots: new Set(roots),
  };
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

// ---------------------------------------------------------------------------
// The vacuity proof: the rule is run against seeded trees and watched failing.
// ---------------------------------------------------------------------------

const ADAPTER = "import { writeFileSync } from 'node:fs';\nexport function persist(p, b) { writeFileSync(p, b); }\n";
const CONSUMER = "import { plan } from './violator.mjs';\nexport function usePlan(x) { return plan(x); }\n";
const violator = (file, symbol) =>
  `import { ${symbol} } from './${file}';\n`
  + `export function plan(x) { ${symbol}('/tmp/side-effect.txt', String(x)); return x; }\n`;

/**
 * Every evasion the adversarial review landed, as a seeded tree the rule is run
 * against. Each entry MUST produce an inversion; the assertion below is the
 * completion proof issue #108 asked for and the first version did not have.
 */
const EVASIONS = [
  ['X1 control: plain adapter, plain export, plain import', {
    'sneaky-store.mjs': ADAPTER,
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['E1 adapter reaches fs via dynamic import()', {
    'sneaky-store.mjs': "export async function persist(path, body) {\n  const fs = await import('node:fs/promises');\n  await fs.writeFile(path, body);\n}\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['E2 adapter reaches fs via createRequire', {
    'sneaky-store.mjs': "import { createRequire } from 'node:module';\nconst require_ = createRequire(import.meta.url);\nexport function persist(p, b) { require_('fs').writeFileSync(p, b); }\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['E3 adapter imports bare "fs" with no node: prefix', {
    'sneaky-store.mjs': "import { writeFileSync } from 'fs';\nexport function persist(p, b) { writeFileSync(p, b); }\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['E4 adapter opens a UDP socket (node:dgram)', {
    'sneaky-store.mjs': "import { createSocket } from 'node:dgram';\nexport function persist(h, b) { createSocket('udp4').send(b, 9999, h); }\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['E5 adapter spawns a worker thread (node:worker_threads)', {
    'sneaky-store.mjs': "import { Worker } from 'node:worker_threads';\nexport function persist(p, b) { return new Worker(p, { workerData: b }); }\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['E6 adapter opens a TLS socket (node:tls)', {
    'sneaky-store.mjs': "import { connect } from 'node:tls';\nexport function persist(h, b) { return connect(443, h).write(b); }\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['E7 adapter does network I/O with the global fetch and no import', {
    'sneaky-store.mjs': "export async function persist(url, body) { return fetch(url, { method: 'POST', body }); }\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['A1 adapter exported via a trailing export { fn } list', {
    'sneaky-store.mjs': "import { writeFileSync } from 'node:fs';\nfunction persist(p, b) { writeFileSync(p, b); }\nexport { persist };\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['A2 adapter exported as a one-arg arrow with no parens', {
    'sneaky-store.mjs': "import { writeFileSync } from 'node:fs';\nexport const persist = p => writeFileSync(p, 'x');\n",
    'violator.mjs': "import { persist } from './sneaky-store.mjs';\nexport function plan(x) { persist('/tmp/x'); return x; }\n",
    'violator-consumer.mjs': CONSUMER,
  }],
  ['A3 adapter exported as an alias of a local function', {
    'sneaky-store.mjs': "import { writeFileSync } from 'node:fs';\nfunction persistImpl(p, b) { writeFileSync(p, b); }\nexport const persist = persistImpl;\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['A4 adapter exported as a generator function', {
    'sneaky-store.mjs': "import { readFileSync } from 'node:fs';\nexport function* persist(p) { yield readFileSync(p, 'utf8'); }\n",
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['A5 adapter exported as a class', {
    'sneaky-store.mjs': "import { writeFileSync } from 'node:fs';\nexport class Store { write(p, b) { writeFileSync(p, b); } }\n",
    'violator.mjs': "import { Store } from './sneaky-store.mjs';\nexport function plan(x) { new Store().write('/tmp/x', String(x)); return x; }\n",
    'violator-consumer.mjs': CONSUMER,
  }],
  ['A6 adapter exported as a default export', {
    'sneaky-store.mjs': "import { writeFileSync } from 'node:fs';\nexport default function persist(p, b) { writeFileSync(p, b); }\n",
    'violator.mjs': "import persist from './sneaky-store.mjs';\nexport function plan(x) { persist('/tmp/x', String(x)); return x; }\n",
    'violator-consumer.mjs': CONSUMER,
  }],
  ['F1 barrel re-exports the adapter', {
    'sneaky-store.mjs': ADAPTER,
    'store-barrel.mjs': "export { persist } from './sneaky-store.mjs';\n",
    'violator.mjs': violator('store-barrel.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['F2 adapter two hops away through a wrapper', {
    'sneaky-store.mjs': "import { writeFileSync } from 'node:fs';\nexport function rawWrite(p, b) { writeFileSync(p, b); }\n",
    'store-wrapper.mjs': "import { rawWrite } from './sneaky-store.mjs';\nexport function persist(p, b) { rawWrite(p, b); }\n",
    'violator.mjs': violator('store-wrapper.mjs', 'persist'),
    'violator-consumer.mjs': CONSUMER,
  }],
  ['G1 violator reached only by a dynamic import', {
    'sneaky-store.mjs': ADAPTER,
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': "export async function usePlan(x) { const m = await import('./violator.mjs'); return m.plan(x); }\n",
  }],
  ['G2 violator reached only by a side-effect import', {
    'sneaky-store.mjs': ADAPTER,
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
    'violator-consumer.mjs': "import './violator.mjs';\nexport const wired = true;\n",
  }],
  ['G3 violator is new and only scripts/ imports it', {
    'sneaky-store.mjs': ADAPTER,
    'violator.mjs': violator('sneaky-store.mjs', 'persist'),
  }],
  ['H1 adapter lives in a subdirectory', {
    'adapters/sneaky-store.mjs': ADAPTER,
    'violator.mjs': "import { persist } from './adapters/sneaky-store.mjs';\nexport function plan(x) { persist('/tmp/x', String(x)); return x; }\n",
    'violator-consumer.mjs': CONSUMER,
  }],
  ['S1 violator silenced by one unused import from node:os', {
    'sneaky-store.mjs': ADAPTER,
    'violator.mjs': "import { tmpdir } from 'node:os';\nimport { persist } from './sneaky-store.mjs';\nexport function plan(x) { persist('/tmp/x', String(x)); return x; }\n",
    'violator-consumer.mjs': CONSUMER,
  }],
];

test('every evasion the review found is caught, and the rule is run to prove it', () => {
  const missed = [];
  for (const [name, files] of EVASIONS) {
    const { found } = analyse(treeOf(files));
    if (found.length === 0) missed.push(name);
  }
  assert.deepEqual(missed, [],
    'these seeded violations did not fire the rule; a gate nobody has watched fail on '
    + 'them has not been repaired, it has been adjusted');
});

test('the rule stays silent on comments and string literals that only look like imports', () => {
  const core = "import { LOCK_TIMEOUT_MS } from './event-log.mjs';\nexport const budget = () => LOCK_TIMEOUT_MS;\n";
  const adapter = "import { writeFileSync } from 'node:fs';\n"
    + 'export const LOCK_TIMEOUT_MS = 30_000;\n'
    + 'export function commitEvents(p, e) { writeFileSync(p, e); }\n';
  const base = {
    'event-log.mjs': adapter,
    'ecosystem.mjs': core,
    'ecosystem-consumer.mjs': "import { budget } from './ecosystem.mjs';\nexport const b = budget;\n",
  };
  const shapes = [
    ['P1 a commented-out import of adapter behaviour',
      "// Removed for issue #108; kept for context:\n// import { commitEvents } from './event-log.mjs';\n" + core],
    ['P2 a comment inside a legitimate multi-line import',
      "import {\n  LOCK_TIMEOUT_MS, // the same budget commitEvents uses\n} from './event-log.mjs';\nexport const budget = () => LOCK_TIMEOUT_MS;\n"],
    ['P3 a doc comment naming a module specifier',
      "// The MCP tool surface is wired from './event-log.mjs'.\n" + core],
    ['P4 a string literal that looks like an import',
      core + "\nexport const HINT = \"import { commitEvents } from './event-log.mjs'\";\n"],
  ];

  const fired = [];
  for (const [name, source] of shapes) {
    const { found } = analyse(treeOf({ ...base, 'ecosystem.mjs': source }));
    if (found.length > 0) fired.push(`${name}: ${found.map((f) => f.edge).join(', ')}`);
  }
  assert.deepEqual(fired, [],
    'the gate fired on code that crosses nothing; a commented-out import is how a '
    + 'removed dependency is recorded and must not create the violation it documents');

  // The control: the same tree with the import uncommented DOES fire, so the
  // four silences above are the rule working and not the rule being absent.
  const { found } = analyse(treeOf({
    ...base,
    'ecosystem.mjs': "import { commitEvents } from './event-log.mjs';\nexport const budget = () => commitEvents;\n",
  }));
  assert.equal(found.length, 1, 'the uncommented form of P1 is a real inversion and fires');
});

test('a composition root is derived from the manifests, not from the absence of an importer', () => {
  const roots = manifestRoots();
  // `.mcp.json` names this as the MCP entry point, so it is allowed to wire.
  assert.ok(isCompositionRoot('mcp-server.mjs', roots),
    'the declared MCP entry point is a composition root');
  // A module other modules import is a library however much I/O it does.
  assert.ok(!isCompositionRoot('event-log.mjs', roots),
    'a module other modules import is not a root');

  // The defect this replaces: `control-room.mjs` is imported by no `src/`
  // module, so the first version called it a composition root and exempted it.
  // Thirteen files in `scripts/` and `tests/` import it. It is a library.
  const { checked, importedByOutside } = inversions();
  assert.ok(!isCompositionRoot('control-room.mjs', roots),
    'control-room.mjs is not named by any manifest, so it is not a root');
  assert.ok(checked.includes('control-room.mjs'),
    'control-room.mjs is examined by the gate rather than exempt');
  assert.ok((importedByOutside.get('control-room.mjs') ?? []).length > 1,
    'the import graph outside src/ is read, which is how the fake roots were found');
});

test('the gate examines the tree rather than a corner of it', () => {
  // The measured failure of the first version: 56 of 80 modules exempt, 24
  // examined, and the live assertion surface one edge. This pins the ratio so
  // the gate cannot quietly shrink back.
  const { checked, adapters, records, roots } = inversions();
  assert.ok(records.size >= 80, `every src/ module is read: ${records.size}`);
  assert.equal(roots.size <= 4, true,
    `composition roots are entry points, not a third of the tree: ${[...roots].join(', ')}`);
  assert.ok(checked.length > records.size / 2,
    `most of the tree is examined: ${checked.length} of ${records.size}`);
  assert.ok(adapters.size >= 10, `adapters are actually detected: ${adapters.size}`);
});

test('the tokeniser reads every module this repo ships', () => {
  // The parser is the load-bearing part of the repair, so it is asserted
  // against the real corpus rather than against fragments. Any relative
  // specifier it extracts must also resolve to a file that exists — an
  // over-extraction from a comment or a string would not.
  const files = readImporters();
  assert.ok(files.length > 150, `the corpus is real: ${files.length} modules`);
  const broken = [];
  for (const [name, source] of files) {
    let record;
    try { record = moduleRecord(source); } catch (error) { broken.push(`${name}: ${error.message}`); continue; }
    for (const imp of record.imports) {
      if (imp.specifier === null || !imp.specifier.startsWith('.')) continue;
      const full = join(ROOT, dirname(name), imp.specifier);
      if (!existsSync(full)) broken.push(`${name}: extracted a specifier that does not exist: ${imp.specifier}`);
    }
  }
  assert.deepEqual(broken, [], 'the tokeniser mis-read shipped source');
});
