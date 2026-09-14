/**
 * duckdb-ix-petri.mjs — the DuckDB extension port through which IX's Petri-net analysis reaches Gaia.
 *
 * WHAT THIS IS FOR
 * ----------------
 * `bootstrap-deadlock.mjs` declares nets and reads analyses; it enumerates nothing. The enumeration
 * is IX's `ix_petri_analyze(net VARCHAR, max_states BIGINT) -> VARCHAR`, carried by the loadable
 * `ix.duckdb_extension` (the pattern ADR issue #107 names as option (b)). This Adapter opens a
 * disposable in-memory store on the optional `@duckdb/node-api` client, loads that extension from
 * the file the caller names, and returns one analysis document per net. It writes nothing, keeps
 * nothing, and decides nothing: a reading is made by the core, from the returned document.
 *
 * WHAT EACH ABSENCE MEANS
 * -----------------------
 * Every missing piece is a named refusal, never an empty result:
 * - `DuckDbClientAbsent` — the optional client is not installed (the CI case);
 * - `IxExtensionLoadFailed` — the file is not a loadable extension for this engine;
 * - `IxPetriFunctionAbsent` — an extension loaded but carries no `ix_petri_analyze` (every IX
 *   release up to and including v0.5.0);
 * - `IxPetriAnalysisRefused` — the function refused the net (IX names the reason).
 *
 * Loading an extension that DuckDB has not signed requires `allow_unsigned_extensions`. The flag
 * is set on this Adapter's own throwaway instance only, which never opens a database file.
 */

import { resolve } from 'node:path';

export const IX_PETRI_DUCKDB_CLIENT = '@duckdb/node-api';
export const IX_PETRI_FUNCTION = 'ix_petri_analyze';

export const IX_PETRI_STATEMENTS = Object.freeze({
  functionPresent: `SELECT count(*) AS n FROM duckdb_functions() WHERE function_name = '${IX_PETRI_FUNCTION}'`,
  analyze: `SELECT ${IX_PETRI_FUNCTION}($1, CAST($2 AS BIGINT)) AS analysis`,
});

export class IxPetriDuckDbError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'IxPetriDuckDbError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new IxPetriDuckDbError(code, message);
}

/** A single-quoted SQL string literal. `LOAD` takes no bound parameter. */
const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;

/**
 * Analyse `nets` with IX through the extension at `extensionFile`, under an explicit state budget.
 *
 * Returns `{ maxStates, analyses: [{ net, analysis }] }` in input order, where `analysis` is the
 * parsed IX document.
 */
export async function analyzeNetsWithIxPetri({ nets, maxStates, extensionFile } = {}, {
  loadApi = () => import(IX_PETRI_DUCKDB_CLIENT),
} = {}) {
  if (!Array.isArray(nets) || nets.length === 0
    || nets.some((net) => net === null || typeof net !== 'object' || typeof net.name !== 'string')) {
    fail('NetsInvalid', 'nets must be a non-empty list of named nets');
  }
  if (!Number.isSafeInteger(maxStates) || maxStates < 1) fail('MaxStatesInvalid', 'maxStates must be a positive integer');
  if (typeof extensionFile !== 'string' || extensionFile.trim() !== extensionFile || extensionFile.length === 0) {
    fail('IxExtensionUnnamed', 'the extension file must be named explicitly');
  }
  if (typeof loadApi !== 'function') fail('InvalidAdapter', 'loadApi must be a function');

  let api;
  try {
    api = await loadApi();
  } catch {
    fail('DuckDbClientAbsent', `optional ${IX_PETRI_DUCKDB_CLIENT} is unavailable`);
  }
  const instance = await api.DuckDBInstance.create(':memory:', { allow_unsigned_extensions: 'true' });
  const connection = await instance.connect();
  try {
    try {
      await connection.run(`LOAD ${sqlLiteral(resolve(extensionFile).replaceAll('\\', '/'))}`);
    } catch {
      fail('IxExtensionLoadFailed', 'the IX extension could not be loaded');
    }
    const [{ n }] = (await connection.runAndReadAll(IX_PETRI_STATEMENTS.functionPresent)).getRowObjects();
    if (Number(n) === 0) fail('IxPetriFunctionAbsent', `the loaded extension has no ${IX_PETRI_FUNCTION}`);

    const analyses = [];
    for (const net of nets) {
      let rows;
      try {
        rows = (await connection.runAndReadAll(IX_PETRI_STATEMENTS.analyze, [JSON.stringify(net), maxStates])).getRowObjects();
      } catch (error) {
        fail('IxPetriAnalysisRefused', String(error?.message ?? error));
      }
      analyses.push({ net: net.name, analysis: JSON.parse(rows[0].analysis) });
    }
    return { maxStates, analyses };
  } finally {
    connection.closeSync();
    instance.closeSync();
  }
}
