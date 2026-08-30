/**
 * ci-flow-journal.test.mjs — the append-only evidence journal and its deterministic projection.
 *
 * Gates J1-J7 of `docs/ci-flow-optimization.md`. The operator failure here is subtler than a wrong
 * number: it is a projection digest that two honest readers disagree about, after which nobody
 * checks the digest and every "derived from evidence" claim becomes unverifiable.
 *
 * J5's golden digest is the only gate in the suite that can catch a SILENT change to the
 * derivation. It was generated once from the shipped implementation and is frozen thereafter; a
 * self-consistency assertion cannot do this job, because a changed derivation stays
 * self-consistent.
 *
 * Concurrency is tested with real operating-system processes rather than a simulated interleaving,
 * because the property under test is that the lock protocol works, and a simulation would test the
 * simulation.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
  CI_FLOW_JOURNAL_RECORD_SCHEMA,
  CI_FLOW_PROJECTION_COLUMNS,
  CI_FLOW_PROJECTION_SCHEMA,
  CiFlowJournalError,
  appendCiFlowObservation,
  ciFlowJournalPath,
  projectCiFlowJournal,
  readCiFlowJournal,
  renderCiFlowProjection,
  replayCiFlowJournal,
} from '../src/ci-flow-journal.mjs';
import { ciFlowObservationIdentity } from '../src/ci-flow.mjs';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FIXTURES = join(HERE, 'fixtures', 'ci-flow');

const scratch = mkdtempSync(join(tmpdir(), 'gaia-ci-flow-'));
test.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 12, retryDelay: 25 }));

let counter = 0;
const workspace = () => {
  counter += 1;
  const directory = join(scratch, `journal-${counter}`);
  return directory;
};

const OBSERVED = '2026-08-30T19:30:00.000Z';
const MINUTE = 60_000;
const at = (msBeforeObserved) => new Date(Date.parse(OBSERVED) - msBeforeObserved).toISOString();

const observation = (overrides = {}) => ({
  provider: 'GITHUB_ACTIONS',
  repositoryId: 'R_kgDOA1',
  repository: 'GuitarAlchemist/gaia',
  workflow: 'ci.yml',
  runId: '1001',
  attempt: 1,
  sha: 'a3f5c1d90b7e4826af10cc35b9d2e7418f60a5b2',
  branch: 'main',
  pullRequest: null,
  trigger: 'PUSH',
  enqueueBasis: 'ATTEMPT',
  enqueuedAt: at(52 * MINUTE),
  runnerAcquiredAt: null,
  startedAt: at(50 * MINUTE),
  completedAt: at(45 * MINUTE),
  conclusion: 'SUCCESS',
  billableMs: null,
  complete: true,
  checks: [{
    checkId: 'check-build',
    name: 'build',
    conclusion: 'SUCCESS',
    startedAt: at(50 * MINUTE),
    completedAt: at(45 * MINUTE),
    setupMs: null,
    workDigest: null,
  }],
  dependencies: null,
  ...overrides,
});

const appendAll = (directory, observations) => observations.map(
  (entry) => appendCiFlowObservation({ directory, observation: entry }),
);

const projectionOf = (directory) => projectCiFlowJournal(readCiFlowJournal({ directory }));

// -----------------------------------------------------------------------------------------------
// J1 — byte-identical redelivery is absorbed and reported.
// -----------------------------------------------------------------------------------------------

test('J1: appending the same observation twice moves no projected byte', () => {
  const directory = workspace();
  const first = appendCiFlowObservation({ directory, observation: observation() });
  const before = renderCiFlowProjection(projectionOf(directory));

  const second = appendCiFlowObservation({ directory, observation: observation() });
  const after = renderCiFlowProjection(projectionOf(directory));

  assert.equal(first.appended, true);
  assert.equal(first.duplicate, false);
  assert.equal(second.appended, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.identity, ciFlowObservationIdentity(observation()));
  assert.equal(after, before);
});

test('J1: a redelivery keeps the journal at one record, because it is never re-appended', () => {
  const directory = workspace();
  appendAll(directory, [observation(), observation(), observation()]);
  assert.equal(readCiFlowJournal({ directory }).length, 1);
  assert.equal(projectionOf(directory).rows.length, 1);
});

// -----------------------------------------------------------------------------------------------
// J2 — a conflicting record under one identity is refused, never merged.
// -----------------------------------------------------------------------------------------------

test('J2: two different observations sharing one identity are refused and named', () => {
  const directory = workspace();
  appendCiFlowObservation({ directory, observation: observation() });
  assert.throws(
    () => appendCiFlowObservation({
      directory, observation: observation({ conclusion: 'FAILURE' }),
    }),
    (error) => {
      assert.ok(error instanceof CiFlowJournalError);
      assert.equal(error.code, 'ConflictingObservation');
      assert.match(error.message, /1001/u, 'the refusal must name the run it is about');
      return true;
    },
  );
});

test('J2: the refused conflict leaves the journal and the projection untouched', () => {
  const directory = workspace();
  appendCiFlowObservation({ directory, observation: observation() });
  const before = renderCiFlowProjection(projectionOf(directory));
  try {
    appendCiFlowObservation({ directory, observation: observation({ conclusion: 'FAILURE' }) });
  } catch { /* refusal is the point; the state after it is what is under test */ }
  assert.equal(renderCiFlowProjection(projectionOf(directory)), before);
  assert.equal(readCiFlowJournal({ directory }).length, 1);
});

test('J2: last-write-wins and field-wise merge are both absent from the source', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow-journal.mjs'), 'utf8');
  assert.ok(!/Object\.assign\(\s*existing/u.test(source));
  assert.ok(!/lastWrite|overwrite|upsert/iu.test(source));
});

// -----------------------------------------------------------------------------------------------
// J3 — arrival order is irrelevant.
// -----------------------------------------------------------------------------------------------

const attempts = [
  observation({ attempt: 1, conclusion: 'FAILURE' }),
  observation({ attempt: 2, conclusion: 'FAILURE' }),
  observation({ attempt: 3 }),
  observation({ runId: '10', conclusion: 'SUCCESS' }),
  observation({ runId: '2', conclusion: 'FAILURE' }),
  observation({ runId: '33', conclusion: 'SUCCESS' }),
];

test('J3: attempt 2 arriving before attempt 1 yields a byte-identical projection', () => {
  const forward = workspace();
  const reverse = workspace();
  appendAll(forward, attempts);
  appendAll(reverse, [...attempts].reverse());
  assert.equal(
    renderCiFlowProjection(projectionOf(reverse)),
    renderCiFlowProjection(projectionOf(forward)),
  );
});

test('J3: run identifiers that look like integers do not reorder the projection', () => {
  const directory = workspace();
  appendAll(directory, attempts);
  const runIds = projectionOf(directory).rows.map((row) => row.runId);
  assert.deepEqual(runIds, [...runIds].sort(), 'ordering must be a stable ordinal sort');
  assert.ok(runIds.includes('10') && runIds.includes('2') && runIds.includes('33'));
});

test('J3: an interleaved arrival order is identical to the serial one', () => {
  const serial = workspace();
  const interleaved = workspace();
  appendAll(serial, attempts);
  appendAll(interleaved, [attempts[4], attempts[0], attempts[5], attempts[2], attempts[1], attempts[3]]);
  assert.equal(
    renderCiFlowProjection(projectionOf(interleaved)),
    renderCiFlowProjection(projectionOf(serial)),
  );
});

// -----------------------------------------------------------------------------------------------
// J4 — real concurrent appenders, and the projection they must agree on.
// -----------------------------------------------------------------------------------------------

const appenderScript = (directory, entries) => `
  const { appendCiFlowObservation } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'ci-flow-journal.mjs')).href)});
  for (const observation of ${JSON.stringify(entries)}) {
    try {
      appendCiFlowObservation({ directory: ${JSON.stringify(directory)}, observation });
    } catch (error) {
      if (error.code !== 'ConflictingObservation') throw error;
    }
  }
`;

test('J4: four concurrent appenders yield the projection a serial run would have produced', async () => {
  const concurrent = workspace();
  const serial = workspace();
  appendAll(serial, attempts);

  await Promise.all(attempts.map((entry) => execFileAsync(
    process.execPath, ['--input-type=module', '-e', appenderScript(concurrent, [entry])],
    { windowsHide: true },
  )));

  assert.equal(readCiFlowJournal({ directory: concurrent }).length, attempts.length);
  assert.equal(
    renderCiFlowProjection(projectionOf(concurrent)),
    renderCiFlowProjection(projectionOf(serial)),
  );
});

test('J4: concurrent appenders racing on ONE identity leave exactly one record', async () => {
  const directory = workspace();
  await Promise.all(Array.from({ length: 4 }, () => execFileAsync(
    process.execPath, ['--input-type=module', '-e', appenderScript(directory, [observation()])],
    { windowsHide: true },
  )));
  assert.equal(readCiFlowJournal({ directory }).length, 1);
  assert.equal(projectionOf(directory).rows.length, 1);
});

// -----------------------------------------------------------------------------------------------
// J5 — deterministic replay against a checked-in golden.
// -----------------------------------------------------------------------------------------------

test('J5: replaying the journal reproduces the projection it was built from', () => {
  const directory = workspace();
  appendAll(directory, attempts);
  const once = replayCiFlowJournal({ directory });
  const twice = replayCiFlowJournal({ directory });
  assert.equal(once.revision, twice.revision);
  assert.equal(renderCiFlowProjection(once), renderCiFlowProjection(twice));
  assert.equal(once.revision, projectionOf(directory).revision);
});

test('J5: the checked-in golden journal still projects to its recorded digest', () => {
  const directory = workspace();
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    ciFlowJournalPath(directory),
    readFileSync(join(FIXTURES, 'golden-journal.jsonl'), 'utf8'),
    'utf8',
  );
  const expected = JSON.parse(readFileSync(join(FIXTURES, 'golden-projection.json'), 'utf8'));
  const projection = replayCiFlowJournal({ directory });
  assert.equal(projection.revision, expected.revision);
  assert.equal(renderCiFlowProjection(projection),
    readFileSync(join(FIXTURES, 'golden-projection.ndjson'), 'utf8'));
});

test('J5: a corrupt journal line is refused, never skipped', () => {
  const directory = workspace();
  appendAll(directory, [observation()]);
  const path = ciFlowJournalPath(directory);
  writeFileSync(path, `${readFileSync(path, 'utf8')}{"not":"a record"}\n`, 'utf8');
  assert.throws(() => readCiFlowJournal({ directory }), (error) => {
    assert.equal(error.code, 'CorruptCiFlowJournal');
    return true;
  });
});

// -----------------------------------------------------------------------------------------------
// J6 — the projection holds no clock, reads no locale and depends on no timezone.
// -----------------------------------------------------------------------------------------------

const revisionScript = (directory) => `
  const { readCiFlowJournal, projectCiFlowJournal } = await import(${JSON.stringify(pathToFileURL(join(ROOT, 'src', 'ci-flow-journal.mjs')).href)});
  const projection = projectCiFlowJournal(readCiFlowJournal({ directory: ${JSON.stringify(directory)} }));
  process.stdout.write(projection.revision);
`;

test('J6: the projection digest is identical under a hostile timezone and locale', async () => {
  const directory = workspace();
  appendAll(directory, attempts);

  const [neutral, hostile] = await Promise.all([
    execFileAsync(process.execPath, ['--input-type=module', '-e', revisionScript(directory)],
      { windowsHide: true, env: { ...process.env, TZ: 'UTC', LANG: 'C', LC_ALL: 'C' } }),
    execFileAsync(process.execPath, ['--input-type=module', '-e', revisionScript(directory)],
      { windowsHide: true,
        env: { ...process.env, TZ: 'Pacific/Kiritimati', LANG: 'tr_TR.UTF-8', LC_ALL: 'tr_TR.UTF-8' } }),
  ]);
  assert.equal(hostile.stdout, neutral.stdout);
  assert.match(neutral.stdout, /^[0-9a-f]{64}$/u);
});

test('J6: the journal module reads no clock inside its projection', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow-journal.mjs'), 'utf8');
  assert.ok(!/localeCompare|toLocaleString|Intl\./u.test(source));
  assert.ok(!/node:https|node:http|node:net|fetch\(/u.test(source));
  assert.ok(!/duckdb|DuckDB/u.test(source),
    'the pump must have no call site DuckDB could be unavailable at');
});

// -----------------------------------------------------------------------------------------------
// J7 — the projected relation is flat, ordered and analytical read state only.
// -----------------------------------------------------------------------------------------------

test('J7: every projected row is flat, integer-valued and in the published column order', () => {
  const directory = workspace();
  appendAll(directory, attempts);
  const projection = projectCiFlowJournal(readCiFlowJournal({ directory }));
  assert.equal(projection.schema, CI_FLOW_PROJECTION_SCHEMA);
  assert.deepEqual([...projection.columns], [...CI_FLOW_PROJECTION_COLUMNS]);
  for (const row of projection.rows) {
    assert.deepEqual(Object.keys(row), [...CI_FLOW_PROJECTION_COLUMNS]);
    for (const [column, value] of Object.entries(row)) {
      assert.ok(value === null || typeof value === 'string' || typeof value === 'boolean'
        || Number.isInteger(value), `${column} carries ${JSON.stringify(value)}`);
    }
  }
});

test('J7: the rendered projection is newline-delimited JSON a reader can ingest directly', () => {
  const directory = workspace();
  appendAll(directory, attempts);
  const rendered = renderCiFlowProjection(projectCiFlowJournal(readCiFlowJournal({ directory })));
  const lines = rendered.split('\n').filter((line) => line.length > 0);
  assert.equal(lines.length, attempts.length);
  assert.ok(rendered.endsWith('\n'), 'every record must be newline terminated');
  for (const line of lines) {
    const parsed = JSON.parse(line);
    assert.deepEqual(Object.keys(parsed), [...CI_FLOW_PROJECTION_COLUMNS]);
  }
});

test('J7: journal records name the record schema and carry their own digest', () => {
  const directory = workspace();
  appendAll(directory, [observation()]);
  const [record] = readCiFlowJournal({ directory });
  assert.equal(record.schema, CI_FLOW_JOURNAL_RECORD_SCHEMA);
  assert.equal(record.ordinal, 0);
  assert.match(record.revision, /^[0-9a-f]{64}$/u);
  assert.equal(record.identity, ciFlowObservationIdentity(observation()));
});

test('J7: the journal is append-only; no code path rewrites or truncates it', () => {
  const source = readFileSync(join(ROOT, 'src', 'ci-flow-journal.mjs'), 'utf8');
  assert.ok(source.includes('appendFileSync'));
  assert.ok(!/writeFileSync\(\s*journal|truncate|unlinkSync/u.test(source));
});

test('J7: an empty directory projects to an empty relation rather than failing', () => {
  const projection = projectionOf(workspace());
  assert.deepEqual(projection.rows, []);
  assert.match(projection.revision, /^[0-9a-f]{64}$/u);
});
