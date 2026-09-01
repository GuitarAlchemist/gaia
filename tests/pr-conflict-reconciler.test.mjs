/**
 * pr-conflict-reconciler.test.mjs — slice 1 of issue #82: the read-only detector and the
 * deterministic classifier, and nothing that touches a branch.
 *
 * Gates C1-C16 and the mechanism reverts of `docs/pr-conflict-reconciler.md`.
 *
 * The operator failure behind this file is that a merge conflict is a terminal hole in the pump:
 * GitHub exposes it and no durable Gaia transition owns it, so a pull request stays open until a
 * human notices. The danger in fixing that is the opposite error — a reconciler that invents a
 * conflict from `mergeable=UNKNOWN`, invents the paths GitHub never returned, guesses at a
 * semantic overlap, or acts for a generation that has already moved. Most of what is asserted
 * here is therefore what the classifier refuses to say.
 *
 * Four spec corrections are gated here, each from a verified read of the tooling:
 *
 *  1. No GitHub field carries conflicting paths. Paths are injected evidence with a named source,
 *     and a reading whose mergeability was not bound to the exact base/head OIDs may not carry
 *     them at all (C5, C6).
 *  2. The `ort` merge driver resolves a byte-identical add/add with an equal file mode silently,
 *     so that entry never appears in `merge-tree` output. A fixture is test evidence, not an
 *     authoritative production strategy; slice 1 therefore reserves automatic classification
 *     but registers no strategy (C8-C11).
 *  3. `workKey` is not `generation`. One pull request has one work key for its whole life and a
 *     new generation per base/head pair; a claim carrying a foreign work key is a mis-delivery,
 *     not a supersession, and the generation itself must parse back to that same PR (C12-C14).
 *  4. `EXACT_OIDS` is not a caller assertion: the binding carries independently observed base and
 *     head OIDs and both must equal the observation before it can classify (C6).
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  PR_CONFLICT_CLAIM_FIELDS,
  PR_CONFLICT_CLASSIFICATIONS,
  PR_CONFLICT_CLASSIFICATION_FIELDS,
  PR_CONFLICT_CLASSIFICATION_SCHEMA,
  PR_CONFLICT_ENTRY_FIELDS,
  PR_CONFLICT_ENTRY_KINDS,
  PR_CONFLICT_EVIDENCE_SOURCES,
  PR_CONFLICT_FILE_MODES,
  PR_CONFLICT_MERGEABILITIES,
  PR_CONFLICT_MERGEABILITY_BINDINGS,
  PR_CONFLICT_OBSERVATION_FIELDS,
  PR_CONFLICT_OBSERVATION_SCHEMA,
  PR_CONFLICT_PROTECTED_PATH_PREFIXES,
  PR_CONFLICT_REFUSALS,
  PR_CONFLICT_STRATEGIES,
  PR_CONFLICT_STRATEGY_REGISTRY,
  PR_CONFLICT_STRATEGY_REGISTRY_VERSION,
  PrConflictError,
  classifyPrConflict,
  prConflictGeneration,
  prConflictWorkKey,
  requirePrConflictObservation,
} from '../src/pr-conflict-reconciler.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const AT = '2026-09-01T18:04:00.000Z';
const REPOSITORY = 'GuitarAlchemist/gaia';
const PULL_REQUEST = 83;
const BASE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const MERGE_BASE = 'd'.repeat(40);
const SAME = '1'.repeat(64);
const OTHER = '2'.repeat(64);

const scratch = mkdtempSync(join(tmpdir(), 'gaia-prc-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(
      (key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`,
    ).join(',')}}`;
  }
  return JSON.stringify(value);
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** Load a one-expression mutant of the shipped module, so a gate can be shown to be a mechanism. */
async function importMutant(name, mutate) {
  const source = readFileSync(join(ROOT, 'src', 'pr-conflict-reconciler.mjs'), 'utf8');
  const mutated = mutate(source);
  assert.notEqual(mutated, source, `mutant ${name} changed nothing`);
  const rewritten = mutated.replaceAll(
    "from './", `from '${pathToFileURL(join(ROOT, 'src')).href}/`,
  );
  const path = join(scratch, `${name}.mjs`);
  writeFileSync(path, rewritten, 'utf8');
  return import(pathToFileURL(path).href);
}

/** A byte-identical add/add: same blob, same mode. Reachable only from a fixture source. */
const identicalEntry = (overrides = {}) => ({
  path: 'src/added.mjs',
  kind: 'ADD_ADD',
  baseDigest: SAME,
  headDigest: SAME,
  baseMode: '100644',
  headMode: '100644',
  binary: false,
  ...overrides,
});

/** The add/add a real merge does report: identical blob, differing mode. A permission change. */
const modeEntry = (overrides = {}) => identicalEntry({ headMode: '100755', ...overrides });

/** An ordinary semantic overlap. */
const overlapEntry = (overrides = {}) => identicalEntry({
  path: 'src/engine.mjs', kind: 'MODIFY_MODIFY', headDigest: OTHER, ...overrides,
});

function observation(overrides = {}) {
  const mergeability = overrides.mergeability ?? 'CONFLICTING';
  const conflicting = mergeability === 'CONFLICTING';
  return {
    schema: PR_CONFLICT_OBSERVATION_SCHEMA,
    observedAt: AT,
    repository: REPOSITORY,
    pullRequest: PULL_REQUEST,
    baseRef: 'main',
    headRef: 'codex/issue-82-conflict-reconciler-r0',
    baseOid: BASE,
    headOid: HEAD,
    mergeBaseOid: MERGE_BASE,
    mergeability,
    mergeabilityBinding: 'EXACT_OIDS',
    conflictEvidence: conflicting ? 'MERGE_TREE' : 'NONE',
    conflicts: conflicting ? [overlapEntry()] : [],
    conflictsComplete: conflicting,
    ...overrides,
  };
}

/** A conflicting observation whose paths came from an injected fixture rather than a merge. */
const fixture = (conflicts, overrides = {}) => observation({
  conflictEvidence: 'INJECTED_FIXTURE', conflicts, conflictsComplete: true, ...overrides,
});

const classify = (overrides = {}, claim = null) => classifyPrConflict({
  observation: observation(overrides), claim,
});

const claimOn = (baseOid = BASE, headOid = HEAD) => ({
  workKey: prConflictWorkKey({ repository: REPOSITORY, pullRequest: PULL_REQUEST }),
  generation: prConflictGeneration({
    repository: REPOSITORY, pullRequest: PULL_REQUEST, baseOid, headOid,
  }),
});

// -------------------------------------------------------------------------------------------
// C1-C4 — the three readings, kept apart, with only one token able to mean "conflict".
// -------------------------------------------------------------------------------------------

test('C1: mergeable=UNKNOWN is incomplete evidence and never becomes a conflict', () => {
  const reading = classify({ mergeability: 'UNKNOWN' });
  assert.equal(reading.classification, 'UNKNOWN');
  assert.equal(reading.strategy, null, 'nothing is proposed from an unknown reading');
  assert.deepEqual(reading.conflictPaths, [], 'an unknown reading names no conflicting path');
  assert.deepEqual(reading.refusals, [], 'and refuses nothing, because it claims nothing');
  assert.notEqual(reading.classification, 'ESCALATION_REQUIRED');
  assert.notEqual(reading.classification, 'AUTO_RESOLVABLE');
});

test('C1: an UNKNOWN reading that carries conflict evidence is refused, not read', () => {
  // Structural rather than advisory: there is nowhere to put a conflicting path on a reading that
  // has not proven a conflict, so the incident cannot be spelled in the first place.
  for (const bad of [
    { mergeability: 'UNKNOWN', conflicts: [overlapEntry()], conflictsComplete: false },
    { mergeability: 'UNKNOWN', conflictEvidence: 'MERGE_TREE', conflicts: [] },
    { mergeability: 'UNKNOWN', conflicts: [], conflictsComplete: true },
    { mergeability: 'CLEAN', conflicts: [overlapEntry()], conflictsComplete: true },
  ]) {
    assert.throws(() => requirePrConflictObservation(observation(bad)), PrConflictError,
      `${canonicalJson(bad)} is refused`);
  }
});

test('C2: a CLEAN reading classifies as CLEAN and proposes nothing', () => {
  const reading = classify({ mergeability: 'CLEAN' });
  assert.equal(reading.classification, 'CLEAN');
  assert.equal(reading.strategy, null);
  assert.deepEqual(reading.conflictPaths, []);
  assert.deepEqual(reading.refusals, []);
  assert.equal(reading.conflictEvidence, 'NONE');
});

test('C3: exactly one mergeability token can produce a conflicting classification', () => {
  const conflicting = ['AUTO_RESOLVABLE', 'ESCALATION_REQUIRED'];
  for (const mergeability of PR_CONFLICT_MERGEABILITIES) {
    const reading = classify({ mergeability });
    const isConflict = conflicting.includes(reading.classification);
    assert.equal(isConflict, mergeability === 'CONFLICTING',
      `${mergeability} may conclude a conflict only if it is the CONFLICTING token`);
  }
});

test('C3: an authoritatively CONFLICTING reading binds the exact generation and paths', () => {
  const reading = classify({
    conflicts: [overlapEntry({ path: 'src/b.mjs' }), overlapEntry({ path: 'src/a.mjs' })],
  });
  assert.equal(reading.mergeability, 'CONFLICTING');
  assert.equal(reading.classification, 'ESCALATION_REQUIRED',
    'a proven conflict never degrades back to UNKNOWN or CLEAN');
  assert.equal(reading.baseOid, BASE);
  assert.equal(reading.headOid, HEAD);
  assert.equal(reading.mergeBaseOid, MERGE_BASE);
  assert.equal(reading.generation, prConflictGeneration({
    repository: REPOSITORY, pullRequest: PULL_REQUEST, baseOid: BASE, headOid: HEAD,
  }), 'the reading carries the same idempotency key the claim will use');
  assert.deepEqual(reading.conflictPaths, ['src/a.mjs', 'src/b.mjs'],
    'the exact paths, ordinally ordered so two readers agree');
});

test('C4: a CONFLICTING reading with an exhausted, empty enumeration is incoherent', () => {
  assert.throws(
    () => requirePrConflictObservation(observation({ conflicts: [], conflictsComplete: true })),
    PrConflictError,
  );
});

// -------------------------------------------------------------------------------------------
// C5-C7 — paths are injected evidence with a named source, bound to the exact OIDs.
// -------------------------------------------------------------------------------------------

test('C5: conflicting paths carry the source that produced them, never a fabricated one', () => {
  assert.deepEqual([...PR_CONFLICT_EVIDENCE_SOURCES], ['NONE', 'MERGE_TREE', 'INJECTED_FIXTURE'],
    'no GitHub mergeability field carries conflicting paths, so no source claims it does');
  assert.equal(classify().conflictEvidence, 'MERGE_TREE',
    'the reading republishes where its paths came from, so a later reader can weigh them');
  assert.throws(
    () => requirePrConflictObservation(observation({ conflictEvidence: 'GITHUB_MERGEABLE' })),
    PrConflictError, 'a source outside the closed set cannot be invented at the call site',
  );
  assert.throws(
    () => requirePrConflictObservation(observation({ conflictEvidence: 'NONE' })),
    PrConflictError, 'and paths with no named source are refused rather than trusted',
  );
});

test('C6: mergeability not bound to the exact base and head OIDs reads as UNKNOWN', () => {
  // GitHub computes mergeability asynchronously against whatever the base is at the time, and the
  // OIDs are read separately. An unbound reading is a reading about some other pair of commits.
  assert.deepEqual([...PR_CONFLICT_MERGEABILITY_BINDINGS], ['UNBOUND', 'EXACT_OIDS']);
  const reading = classify({
    mergeabilityBinding: 'UNBOUND', conflictEvidence: 'NONE', conflicts: [], conflictsComplete: false,
  });
  assert.equal(reading.classification, 'UNKNOWN',
    'an unbound CONFLICTING is not a conflict, it is a reading nobody tied to this generation');
  assert.deepEqual(reading.conflictPaths, []);
  assert.deepEqual(reading.refusals, []);
});

test('C6: EXACT_OIDS carries independently observed OIDs equal to the observation', () => {
  assert.ok(PR_CONFLICT_OBSERVATION_FIELDS.includes('bindingBaseOid'));
  assert.ok(PR_CONFLICT_OBSERVATION_FIELDS.includes('bindingHeadOid'));
  assert.doesNotThrow(() => requirePrConflictObservation(observation({
    bindingBaseOid: BASE, bindingHeadOid: HEAD,
  })));
  for (const bad of [
    { bindingBaseOid: null },
    { bindingHeadOid: null },
    { bindingBaseOid: 'a'.repeat(40) },
    { bindingHeadOid: 'e'.repeat(40) },
    { bindingBaseOid: BASE.toUpperCase() },
    { bindingHeadOid: 'f'.repeat(41) },
  ]) {
    assert.throws(() => requirePrConflictObservation(observation({
      bindingBaseOid: BASE, bindingHeadOid: HEAD, ...bad,
    })), PrConflictError,
      `${canonicalJson(bad)} cannot forge an exact binding`);
  }
});

test('C6: UNBOUND carries null binding OIDs and remains UNKNOWN without conflict evidence', () => {
  const unbound = observation({
    mergeabilityBinding: 'UNBOUND', conflictEvidence: 'NONE', conflicts: [], conflictsComplete: false,
    bindingBaseOid: null, bindingHeadOid: null,
  });
  assert.equal(unbound.bindingBaseOid, null);
  assert.equal(unbound.bindingHeadOid, null);
  assert.equal(classifyPrConflict({ observation: unbound, claim: null }).classification, 'UNKNOWN');
  for (const bad of [
    { ...unbound, bindingBaseOid: BASE },
    { ...unbound, bindingHeadOid: HEAD },
  ]) {
    assert.throws(() => requirePrConflictObservation(bad), PrConflictError,
      'an unbound token cannot smuggle independently bound OIDs');
  }
});

test('C6: an unbound reading may not carry conflict evidence at all', () => {
  for (const bad of [
    { mergeabilityBinding: 'UNBOUND' },
    { mergeabilityBinding: 'UNBOUND', conflicts: [], conflictsComplete: true },
    { mergeabilityBinding: 'UNBOUND', conflictEvidence: 'MERGE_TREE', conflicts: [], conflictsComplete: false },
  ]) {
    assert.throws(() => requirePrConflictObservation(observation(bad)), PrConflictError,
      `${canonicalJson(bad)} is refused`);
  }
});

test('C7: an incomplete conflict enumeration escalates however safe the entries look', () => {
  const reading = classifyPrConflict({
    observation: fixture([identicalEntry()], { conflictsComplete: false }), claim: null,
  });
  assert.equal(reading.classification, 'ESCALATION_REQUIRED');
  assert.ok(reading.refusals.includes('EVIDENCE_INCOMPLETE'));
  assert.equal(reading.strategy, null);
});

// -------------------------------------------------------------------------------------------
// C8-C11 — the closed, versioned registry, and the add/add contradiction resolved.
// -------------------------------------------------------------------------------------------

test('C8: a synthetic byte-identical fixture is evidence, not an automatic strategy', () => {
  const reading = classifyPrConflict({
    observation: fixture([identicalEntry({ path: 'src/one.mjs' }), identicalEntry({ path: 'src/two.mjs' })]),
    claim: null,
  });
  assert.equal(reading.classification, 'ESCALATION_REQUIRED');
  assert.equal(reading.strategy, null);
  assert.deepEqual(reading.refusals, ['UNREGISTERED_CONFLICT_KIND']);
  assert.deepEqual(reading.conflictPaths, ['src/one.mjs', 'src/two.mjs']);
});

test('C9: a merge cannot have reported a byte-identical add/add, and evidence saying so is refused', () => {
  // Verified against the shipped tooling: the `ort` driver resolves an add/add whose two blobs and
  // modes agree without reporting it. Evidence carrying one did not come from a merge, so it is
  // refused here rather than auto-resolved on a claim the merge already made.
  assert.throws(
    () => requirePrConflictObservation(observation({ conflicts: [identicalEntry()] })),
    PrConflictError,
  );
  assert.doesNotThrow(
    () => requirePrConflictObservation(fixture([identicalEntry()])),
    'the same entry from a declared fixture is admissible — the refusal is about provenance',
  );
});

test('C10: the add/add a merge does report — identical blob, differing mode — escalates', () => {
  for (const source of ['MERGE_TREE', 'INJECTED_FIXTURE']) {
    const reading = classifyPrConflict({
      observation: observation({
        conflictEvidence: source, conflicts: [modeEntry()], conflictsComplete: true,
      }),
      claim: null,
    });
    assert.equal(reading.classification, 'ESCALATION_REQUIRED', `${source} mode change escalates`);
    assert.deepEqual(reading.refusals, ['MODE_CHANGE'],
      'identical bytes under a changed permission is a permission change, which always escalates');
    assert.equal(reading.strategy, null);
  }
});

test('C10: a mode outside the closed set, or a missing one, is refused not guessed', () => {
  assert.deepEqual([...PR_CONFLICT_FILE_MODES], ['100644', '100755', '120000', '160000']);
  for (const bad of [{ headMode: '0644' }, { headMode: 644 }, { baseMode: 'rwx' }]) {
    assert.throws(
      () => requirePrConflictObservation(fixture([identicalEntry(bad)])),
      PrConflictError, `${canonicalJson(bad)} is refused`,
    );
  }
  const unproven = classifyPrConflict({
    observation: fixture([identicalEntry({ headMode: null })]), claim: null,
  });
  assert.deepEqual(unproven.refusals, ['EVIDENCE_INCOMPLETE'],
    'a mode nobody read is recorded as unread, never as unchanged');
});

test('C11: every conflict kind escalates while slice 1 has no authoritative strategy', () => {
  for (const kind of PR_CONFLICT_ENTRY_KINDS) {
    const reading = classifyPrConflict({
      observation: fixture([identicalEntry({ kind, headDigest: OTHER })]), claim: null,
    });
    assert.equal(reading.classification, 'ESCALATION_REQUIRED', `${kind} must escalate`);
    assert.equal(reading.strategy, null, `${kind} names no strategy`);
    assert.ok(reading.refusals.length > 0, `${kind} says why`);
    for (const refusal of reading.refusals) {
      assert.ok(PR_CONFLICT_REFUSALS.includes(refusal), `${refusal} is a registered refusal`);
    }
  }
});

test('C11: unproven, differing, binary and protected content each escalate by name', () => {
  const cases = [
    [identicalEntry({ headDigest: OTHER }), 'CONTENT_NOT_IDENTICAL'],
    [identicalEntry({ headDigest: null }), 'EVIDENCE_INCOMPLETE'],
    [identicalEntry({ binary: true }), 'BINARY_CONTENT'],
    [overlapEntry(), 'SEMANTIC_SOURCE_OVERLAP'],
    [identicalEntry({ kind: 'MODIFY_DELETE', headDigest: null }), 'UNREGISTERED_CONFLICT_KIND'],
  ];
  for (const [entry, refusal] of cases) {
    const reading = classifyPrConflict({ observation: fixture([entry]), claim: null });
    assert.equal(reading.classification, 'ESCALATION_REQUIRED');
    assert.deepEqual(reading.refusals, [refusal], `${entry.path} ${entry.kind} -> ${refusal}`);
  }
});

test('C11: a protected path escalates even when its two sides are byte-identical', () => {
  assert.ok(PR_CONFLICT_PROTECTED_PATH_PREFIXES.length > 0);
  for (const prefix of PR_CONFLICT_PROTECTED_PATH_PREFIXES) {
    const reading = classifyPrConflict({
      observation: fixture([identicalEntry({ path: `${prefix}anything.yml` })]), claim: null,
    });
    assert.equal(reading.classification, 'ESCALATION_REQUIRED', `${prefix} must escalate`);
    assert.deepEqual(reading.refusals, ['PROTECTED_PATH']);
  }
  for (const path of [
    '.github/workflows/ci.yml', '.github/CODEOWNERS', '.env', 'ARCHITECTURE.md', 'SECURITY.md',
    'docs/contracts/schema.json',
  ]) {
    const reading = classifyPrConflict({
      observation: fixture([identicalEntry({ path })]), claim: null,
    });
    assert.deepEqual(reading.refusals, ['PROTECTED_PATH'], `${path} is protected`);
  }
});

test('C11: one unsafe entry in an otherwise mechanical set escalates the whole reading', () => {
  const reading = classifyPrConflict({
    observation: fixture([identicalEntry({ path: 'src/one.mjs' }), overlapEntry({ path: 'src/two.mjs' })]),
    claim: null,
  });
  assert.equal(reading.classification, 'ESCALATION_REQUIRED',
    'a partially mechanical set is not partially applied');
  assert.deepEqual(reading.refusals, ['SEMANTIC_SOURCE_OVERLAP']);
  assert.deepEqual(reading.conflictPaths, ['src/one.mjs', 'src/two.mjs'],
    'and the escalation names every conflicting path, not only the refused one');
});

test('C11: the strategy registry is closed, versioned, and empty until production evidence exists', () => {
  assert.equal(PR_CONFLICT_STRATEGY_REGISTRY_VERSION, 'gaia-pr-conflict-strategies/2');
  assert.deepEqual([...PR_CONFLICT_STRATEGIES], [],
    'fixture-only evidence does not register an automatic production strategy');
  assert.deepEqual(Object.keys(PR_CONFLICT_STRATEGY_REGISTRY).sort(), [...PR_CONFLICT_STRATEGIES],
    'the registry and its published vocabulary cannot drift apart');
  for (const id of PR_CONFLICT_STRATEGIES) {
    assert.match(id, /^[A-Z][A-Z_]*\/[1-9][0-9]*$/u, 'every strategy carries its own version');
    assert.equal(typeof PR_CONFLICT_STRATEGY_REGISTRY[id].admits, 'function');
    assert.ok(Object.isFrozen(PR_CONFLICT_STRATEGY_REGISTRY[id]));
  }
  assert.ok(Object.isFrozen(PR_CONFLICT_STRATEGY_REGISTRY));
  assert.equal(classify().registry, PR_CONFLICT_STRATEGY_REGISTRY_VERSION,
    'every reading names the registry version it was decided under');
});

// -------------------------------------------------------------------------------------------
// C12-C14 — work identity, generation identity, supersession.
// -------------------------------------------------------------------------------------------

test('C12: the work key is stable across generations; the generation is not', () => {
  const workKey = prConflictWorkKey({ repository: REPOSITORY, pullRequest: PULL_REQUEST });
  assert.match(workKey, /^[0-9a-f]{64}$/u);
  assert.equal(workKey, prConflictWorkKey({
    repository: REPOSITORY.toLowerCase(), pullRequest: PULL_REQUEST,
  }), 'one pull request has one work key however its owner/name was spelled');
  assert.notEqual(workKey, prConflictWorkKey({ repository: REPOSITORY, pullRequest: 84 }));

  const first = prConflictGeneration({
    repository: REPOSITORY, pullRequest: PULL_REQUEST, baseOid: BASE, headOid: HEAD,
  });
  const moved = prConflictGeneration({
    repository: REPOSITORY, pullRequest: PULL_REQUEST, baseOid: 'a'.repeat(40), headOid: HEAD,
  });
  assert.notEqual(first, moved, 'a moved base is a different generation');
  assert.equal(classify().workKey, workKey, 'and the reading carries both, separately');
  assert.equal(classify().generation, first);
});

test('C13: a claim held against a moved base or head is SUPERSEDED before any effect', () => {
  for (const stale of [claimOn('a'.repeat(40), HEAD), claimOn(BASE, 'e'.repeat(40))]) {
    const reading = classify({}, stale);
    assert.equal(reading.classification, 'SUPERSEDED');
    assert.equal(reading.strategy, null, 'a stale claimant is handed no repair to attempt');
    assert.deepEqual(reading.conflictPaths, [],
      "nor the new generation's paths, which are not its to act on");
    assert.deepEqual(reading.refusals, []);
    assert.equal(reading.generation, prConflictGeneration({
      repository: REPOSITORY, pullRequest: PULL_REQUEST, baseOid: BASE, headOid: HEAD,
    }), 'the reading names the generation that now holds, so the loser knows what beat it');
  }
});

test('C13: supersession is decided before mergeability is read at all', () => {
  const stale = claimOn(BASE, 'e'.repeat(40));
  for (const mergeability of PR_CONFLICT_MERGEABILITIES) {
    assert.equal(classify({ mergeability }, stale).classification, 'SUPERSEDED', mergeability);
  }
  assert.equal(
    classify({ mergeabilityBinding: 'UNBOUND', conflictEvidence: 'NONE', conflicts: [], conflictsComplete: false }, stale)
      .classification,
    'SUPERSEDED', 'and before the binding is read',
  );
});

test('C13: a claim on the observed generation is not superseded', () => {
  assert.equal(classify({}, claimOn()).classification, 'ESCALATION_REQUIRED');
  assert.equal(classify({}, null).classification, 'ESCALATION_REQUIRED',
    'and an unclaimed observation classifies on its own evidence');
});

test('C14: a claim carrying a foreign work key is a mis-delivery, not a supersession', () => {
  const foreign = {
    workKey: prConflictWorkKey({ repository: REPOSITORY, pullRequest: 84 }),
    generation: claimOn().generation,
  };
  assert.throws(() => classifyPrConflict({ observation: observation(), claim: foreign }),
    PrConflictError, 'answering a claim about another pull request would be the worse failure');
});

test('C14: a forged generation cannot borrow the observation work key', () => {
  const workKey = claimOn().workKey;
  for (const generation of [
    `Other/Repo#999:${'a'.repeat(40)}:${'b'.repeat(40)}`,
    `${REPOSITORY}#999:${'a'.repeat(40)}:${'b'.repeat(40)}`,
    `Other/Repo#${PULL_REQUEST}:${'a'.repeat(40)}:${'b'.repeat(40)}`,
    `${REPOSITORY}#${PULL_REQUEST}:${'a'.repeat(41)}:${'b'.repeat(40)}`,
    `${REPOSITORY}#${PULL_REQUEST}:${'a'.repeat(40)}:${'b'.repeat(63)}`,
    `${REPOSITORY}#${PULL_REQUEST}:${'A'.repeat(40)}:${'b'.repeat(40)}`,
  ]) {
    assert.throws(
      () => classifyPrConflict({ observation: observation(), claim: { workKey, generation } }),
      PrConflictError,
      `${generation} is a malformed or foreign identity, not a stale generation`,
    );
  }
  assert.equal(classify({}, claimOn('a'.repeat(64), 'e'.repeat(64))).classification, 'SUPERSEDED',
    'a valid stale SHA-256 generation of this same PR remains superseded');
});

test('C14: a malformed claim is refused, not treated as no claim', () => {
  assert.deepEqual([...PR_CONFLICT_CLAIM_FIELDS], ['generation', 'workKey']);
  for (const bad of [
    '', 42, {}, { workKey: claimOn().workKey }, { generation: claimOn().generation },
    { ...claimOn(), lane: 'ix' }, { workKey: 'short', generation: claimOn().generation },
    { workKey: claimOn().workKey, generation: `${REPOSITORY}#83` },
  ]) {
    assert.throws(() => classifyPrConflict({ observation: observation(), claim: bad }),
      PrConflictError, `${canonicalJson(bad)} is not silently read as unclaimed`);
  }
});

// -------------------------------------------------------------------------------------------
// C15 — closed vocabulary and determinism.
// -------------------------------------------------------------------------------------------

test('C15: the emitted vocabulary is closed on every axis', () => {
  assert.deepEqual([...PR_CONFLICT_CLASSIFICATIONS],
    ['UNKNOWN', 'CLEAN', 'AUTO_RESOLVABLE', 'ESCALATION_REQUIRED', 'SUPERSEDED']);
  assert.deepEqual([...PR_CONFLICT_MERGEABILITIES], ['UNKNOWN', 'CLEAN', 'CONFLICTING']);
  assert.deepEqual([...PR_CONFLICT_REFUSALS], ['BINARY_CONTENT', 'CONTENT_NOT_IDENTICAL',
    'EVIDENCE_INCOMPLETE', 'MODE_CHANGE', 'PROTECTED_PATH', 'SEMANTIC_SOURCE_OVERLAP',
    'UNREGISTERED_CONFLICT_KIND']);
  for (const list of [PR_CONFLICT_CLASSIFICATIONS, PR_CONFLICT_MERGEABILITIES,
    PR_CONFLICT_ENTRY_KINDS, PR_CONFLICT_REFUSALS, PR_CONFLICT_STRATEGIES,
    PR_CONFLICT_OBSERVATION_FIELDS, PR_CONFLICT_ENTRY_FIELDS, PR_CONFLICT_CLAIM_FIELDS,
    PR_CONFLICT_EVIDENCE_SOURCES, PR_CONFLICT_MERGEABILITY_BINDINGS, PR_CONFLICT_FILE_MODES,
    PR_CONFLICT_CLASSIFICATION_FIELDS, PR_CONFLICT_PROTECTED_PATH_PREFIXES]) {
    assert.ok(Object.isFrozen(list), 'a published vocabulary is frozen');
  }
  const reading = classify();
  assert.deepEqual(Object.keys(reading).sort(), [...PR_CONFLICT_CLASSIFICATION_FIELDS],
    'a reading carries exactly the declared fields — no extra, no missing');
  assert.equal(reading.schema, PR_CONFLICT_CLASSIFICATION_SCHEMA);
  assert.ok(PR_CONFLICT_CLASSIFICATIONS.includes(reading.classification));
});

test('C15: an unknown field, or a value outside a closed set, is refused not ignored', () => {
  assert.throws(() => requirePrConflictObservation({ ...observation(), lane: 'ix' }),
    PrConflictError);
  assert.throws(
    () => requirePrConflictObservation(fixture([{ ...identicalEntry(), reason: 'x' }])),
    PrConflictError, 'an unknown field on a conflict entry is refused too',
  );
  assert.throws(() => requirePrConflictObservation(observation({ mergeability: 'DIRTY' })),
    PrConflictError, 'provider vocabulary is normalised by the producer, not widened here');
  assert.throws(
    () => requirePrConflictObservation(fixture([identicalEntry({ kind: 'SUBMODULE' })])),
    PrConflictError,
  );
});

test('C15: incoherent identity is refused rather than repaired', () => {
  for (const bad of [
    { baseOid: 'not-an-oid' }, { headOid: '' }, { baseOid: BASE.toUpperCase() },
    { repository: 'gaia' }, { pullRequest: 0 }, { pullRequest: 1.5 },
    { observedAt: '2026-09-01' }, { mergeBaseOid: 'zz' },
  ]) {
    assert.throws(() => requirePrConflictObservation(observation(bad)), PrConflictError,
      `${canonicalJson(bad)} is refused`);
  }
  for (const bad of [
    { path: '../escape.mjs' }, { path: '/abs.mjs' }, { path: '' },
    { baseDigest: 'short' }, { binary: 'false' },
  ]) {
    assert.throws(() => requirePrConflictObservation(fixture([identicalEntry(bad)])),
      PrConflictError, `${canonicalJson(bad)} is refused`);
  }
});

test('C15: replaying the same observation yields a byte-identical reading', () => {
  const given = fixture([
    identicalEntry({ path: 'src/b.mjs' }), overlapEntry({ path: 'src/a.mjs' }),
  ]);
  const first = classifyPrConflict({ observation: given, claim: null });
  for (let i = 0; i < 64; i += 1) {
    const again = classifyPrConflict({ observation: given, claim: null });
    assert.equal(canonicalJson(again), canonicalJson(first), 'replay is byte-identical');
    assert.equal(again.revision, first.revision);
  }
  assert.equal(first.revision, sha256(canonicalJson(
    Object.fromEntries(Object.entries(first).filter(([key]) => key !== 'revision')),
  )), 'and the revision is the digest of exactly the reading it is published on');
});

test('C15: neither key order nor conflict order changes the reading', () => {
  const a = fixture([identicalEntry({ path: 'src/a.mjs' }), identicalEntry({ path: 'src/b.mjs' })]);
  const b = { ...Object.fromEntries(Object.entries(a).reverse()), conflicts: [...a.conflicts].reverse() };
  assert.equal(
    classifyPrConflict({ observation: b, claim: null }).revision,
    classifyPrConflict({ observation: a, claim: null }).revision,
    'two producers that enumerated the same conflict in a different order agree',
  );
});

test('C15: two concurrent identical observations seal one receipt, not two', () => {
  const given = observation();
  const one = classifyPrConflict({ observation: given, claim: claimOn() });
  const two = classifyPrConflict({ observation: { ...given }, claim: { ...claimOn() } });
  assert.equal(one.revision, two.revision, 'duplicate delivery converges on one logical receipt');
});

test('C15: refusals are a sorted, deduplicated set, so two escalations compare', () => {
  const reading = classifyPrConflict({
    observation: fixture([
      overlapEntry({ path: 'src/z.mjs' }),
      identicalEntry({ path: 'src/y.mjs', binary: true }),
      overlapEntry({ path: 'src/x.mjs' }),
    ]),
    claim: null,
  });
  assert.deepEqual(reading.refusals, ['BINARY_CONTENT', 'SEMANTIC_SOURCE_OVERLAP']);
  assert.deepEqual(reading.conflictPaths, ['src/x.mjs', 'src/y.mjs', 'src/z.mjs']);
});

// -------------------------------------------------------------------------------------------
// C16 — the slice boundary, held by a scan of the shipped source.
// -------------------------------------------------------------------------------------------

test('C16: classification is read-only — the observation it was given is not touched', () => {
  const given = observation();
  const before = canonicalJson(given);
  const reading = classifyPrConflict({ observation: given, claim: null });
  assert.equal(canonicalJson(given), before, 'the input is not rewritten, sorted or annotated');
  assert.equal(reading.effect, 'NONE');
  assert.equal(reading.authority, 'NONE');
  assert.ok(Object.isFrozen(reading), 'and the reading itself cannot be edited after the fact');
  assert.ok(Object.isFrozen(reading.conflictPaths) && Object.isFrozen(reading.refusals));
});

test('C16: the slice-1 module holds no effect, no authority, no provider and no clock', () => {
  const source = readFileSync(join(ROOT, 'src', 'pr-conflict-reconciler.mjs'), 'utf8');
  const specifiers = [...source.matchAll(/^import\s[^;]*?from\s+'([^']+)';$/gmu)].map((m) => m[1]);
  assert.deepEqual(specifiers.sort(), ['./local-lane-observation.mjs', 'node:crypto'],
    'a read-only classifier imports a digest and a shared instant predicate, and nothing else');
  for (const forbidden of [
    /\bnode:(fs|child_process|net|http|https|tls|dgram|worker_threads)\b/u,
    /\brequire\s*\(/u, /\bimport\s*\(/u, /\bfetch\s*\(/u, /\bXMLHttpRequest\b/u,
    /\bexecSync\b/u, /\bspawn(?:Sync)?\s*\(/u, /\bprocess\.(env|argv|cwd)\b/u,
    /\bDate\.now\b/u, /\bnew\s+Date\b/u, /\bsetTimeout\b/u, /\bMath\.random\b/u,
    /\bOctokit\b/u, /\bAuthorization\b/u, /\bGITHUB_TOKEN\b/u, /\brerere\b/u,
    /--force\b/u, /--theirs\b/u, /--ours\b/u, /\bgit\s+(?:merge|commit|push|checkout)\b/u,
  ]) {
    assert.ok(!forbidden.test(source), `slice 1 contains no ${forbidden}`);
  }
  assert.ok(!/duckdb/iu.test(source), 'DuckDB owns no claim, lock, retry or effect authority');
});

test('C16: the reading is provider-neutral — it names no GitHub API surface', () => {
  const text = canonicalJson(classify());
  for (const token of ['api.github.com', 'graphql', 'node_id', 'mergeable_state', 'html_url']) {
    assert.ok(!text.includes(token), `the reading carries no ${token}`);
  }
});

test('C16: the design document names the slice-1 boundary this module implements', () => {
  const doc = readFileSync(join(ROOT, 'docs', 'pr-conflict-reconciler.md'), 'utf8');
  for (const claim of ['UNKNOWN', 'CLEAN', 'CONFLICTING', 'AUTO_RESOLVABLE',
    'ESCALATION_REQUIRED', 'SUPERSEDED', 'repo#pr:baseOid:headOid']) {
    assert.ok(doc.includes(claim), `the design names ${claim}`);
  }
  for (const absent of [
    'persist a GitHub-backed receipt', 'receipt records owner', 'one active writer',
    'with owner, deadline',
  ]) {
    assert.ok(!doc.includes(absent), `slice 1 must not claim unshipped behavior: ${absent}`);
  }
});

// -------------------------------------------------------------------------------------------
// Mechanism reverts — each shows a gate tests the mechanism rather than the outcome.
// -------------------------------------------------------------------------------------------

test('MR1: reading UNKNOWN as a conflict is the fabrication this slice exists to stop', async () => {
  const mutant = await importMutant('unknown-as-conflict', (source) => source.replace(
    "if (verified.mergeability === 'UNKNOWN') return cleanReading(verified, identity, 'UNKNOWN');",
    "if (verified.mergeability === 'UNKNOWN') return cleanReading(verified, identity, 'ESCALATION_REQUIRED');",
  ));
  const given = observation({ mergeability: 'UNKNOWN' });
  assert.equal(
    mutant.classifyPrConflict({ observation: given, claim: null }).classification,
    'ESCALATION_REQUIRED',
    'the mutant escalates a pull request nobody proved was conflicting — a fabricated blocker',
  );
  assert.equal(classifyPrConflict({ observation: given, claim: null }).classification, 'UNKNOWN',
    'and the shipped rule keeps incomplete evidence incomplete');
});

test('MR2: accepting a stale generation is what lets an old actor act after it lost', async () => {
  const mutant = await importMutant('stale-generation-accepted', (source) => source.replace(
    'if (claimed !== null && claimed.generation !== identity.generation) {',
    'if (false) {',
  ));
  const given = fixture([identicalEntry()]);
  const stale = claimOn('a'.repeat(40), HEAD);
  const mutated = mutant.classifyPrConflict({ observation: given, claim: stale });
  assert.equal(mutated.classification, 'ESCALATION_REQUIRED',
    'the mutant hands the current generation conflict evidence to a claimant whose base moved');
  const shipped = classifyPrConflict({ observation: given, claim: stale });
  assert.equal(shipped.classification, 'SUPERSEDED',
    'and the shipped rule ends the stale claimant before any effect is proposed');
  assert.equal(shipped.strategy, null);
});

test('MR3: dropping binding-OID equality admits a forged EXACT_OIDS token', async () => {
  const mutant = await importMutant('binding-oid-equality-removed', (source) => source.replace(
    'if (value.bindingBaseOid !== value.baseOid || value.bindingHeadOid !== value.headOid) {',
    'if (false) {',
  ));
  const forged = observation({ bindingBaseOid: 'a'.repeat(40) });
  assert.equal(
    mutant.classifyPrConflict({ observation: forged, claim: null }).classification,
    'ESCALATION_REQUIRED',
    'without equality, a caller assertion reaches conflicting classification',
  );
  assert.throws(() => classifyPrConflict({ observation: forged, claim: null }), PrConflictError,
    'the shipped schema refuses evidence bound to another base');
});

test('MR4: dropping an exact protected path loses its safety refusal', async () => {
  const mutant = await importMutant('protected-exact-path-removed', (source) => source.replace(
    'PR_CONFLICT_PROTECTED_PATHS.includes(path)',
    'false',
  ));
  const protectedFixture = fixture([identicalEntry({ path: 'SECURITY.md' })]);
  assert.deepEqual(
    mutant.classifyPrConflict({ observation: protectedFixture, claim: null }).refusals,
    ['UNREGISTERED_CONFLICT_KIND'],
    'the mutant no longer identifies the security policy as protected',
  );
  assert.deepEqual(
    classifyPrConflict({ observation: protectedFixture, claim: null }).refusals,
    ['PROTECTED_PATH'],
  );
});

test('MR5: reinstating fixture-only automatic classification violates the empty registry', async () => {
  const mutant = await importMutant('synthetic-auto-reinstated', (source) => source.replace(
    "return 'UNREGISTERED_CONFLICT_KIND'; // no authoritative slice-1 strategy admits this entry",
    'return null; // mutant treats a synthetic shape as automatically admitted',
  ).replace(
    'return escalationReading(observation, identity, conflictPaths, refusals);',
    "if (refusals.size === 0) return reading(observation, identity, { classification: 'AUTO_RESOLVABLE', strategy: 'IDENTICAL_ADD_ADD/1', conflictPaths, conflictEvidence: observation.conflictEvidence });\n  return escalationReading(observation, identity, conflictPaths, refusals);",
  ));
  const synthetic = fixture([identicalEntry()]);
  const mutated = mutant.classifyPrConflict({ observation: synthetic, claim: null });
  assert.equal(mutated.classification, 'AUTO_RESOLVABLE');
  assert.ok(!mutant.PR_CONFLICT_STRATEGIES.includes(mutated.strategy),
    'the forged automatic verdict is not backed by the closed registry');
  assert.equal(classifyPrConflict({ observation: synthetic, claim: null }).classification,
    'ESCALATION_REQUIRED');
});
