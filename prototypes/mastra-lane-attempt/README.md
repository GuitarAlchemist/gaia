# Prototype: a Mastra workflow run as a Gaia lane attempt

Status: prototype. It is not part of the Gaia product, it grants no authority, and nothing in
Gaia imports it. The evaluation it supports is
[docs/research/2026-10-13-mastra-evaluation.md](../../docs/research/2026-10-13-mastra-evaluation.md).

Gaia's lane-attempt core (`src/lane-attempt.mjs`, [its decision table](../../docs/lane-attempt-decisions.md))
decides one running attempt from heartbeats, a completion marker and abort orders. It has no
executor yet. This prototype gives it one: a zero-LLM [Mastra](https://mastra.ai) workflow. The
core is used unchanged, and Mastra stays outside it.

```
Mastra run ──fullStream chunks──▶ attempt observer ──HEARTBEAT / MARKER──▶ replayLaneAttempt ──▶ decision
                                    (src/, pure)        ABORT ◀── coordinator order
```

- `src/attempt-observer.mjs` maps each chunk to a lane-attempt event:
  - the start and the result of the n-th declared step become a heartbeat `L<n>`;
  - a successful finish becomes the marker.
- A suspension and any other finish add nothing. An abort is the coordinator's order. Every event
  carries the coordinator's instant, so Mastra's own timestamps decide nothing.
- `check/` holds six experiments, written as `node:test` checks. They run against
  `@mastra/core` 1.75.0, pinned exactly in `package-lock.json`.

## Run it

With the Node pinned in `../../.node-version`:

```sh
npm ci --ignore-scripts
npm run check
```

The checks use no model, no API key, and no network: E6 replaces `fetch` before Mastra loads.
`check/*.check.mjs` does not match the default `node --test` patterns, so the Gaia suite never
loads these files. `node_modules/` stays ignored.

## What the checks establish

| Check | Observation at `@mastra/core` 1.75.0 |
| --- | --- |
| E1 | A finished run is decided `COMPLETE` (`T_EXIT_CLEAN`) by the unchanged core. Past the deadline, the same run's marker is late and quarantined. A step the caller did not declare is refused. |
| E2 | A suspension that waits for a person is silence. The heartbeat timeout ends the attempt. Mastra still accepts the later resume and completes the run. The core keeps its first decision and quarantines the late output. Anyone holding the run id can resume; only the resume schema is checked. |
| E3 | `run.cancel()` marks the run `canceled` and aborts a signal. A step that ignores the signal still performs its side effect afterwards. |
| E4 | A coordinator abort is decided `ABORTED` with `SEND_LANE_ABORTED`. A canceled run refuses a later resume (`This workflow run was not suspended`). |
| E5 | A quiet run stays `running` in storage. A second instance over the same store lists it and `restart()`s it. The side effect runs twice, while the first execution is still alive. |
| E6 | Workflow runs make no request. Mastra's PostHog telemetry is on by default and reaches `fetch` through its feature-usage call. `MASTRA_TELEMETRY_DISABLED=1` stops it. |

Five mechanism-revert mutants of the observer each fail at least one check:
- no step heartbeats;
- a marker on any finish;
- a suspension read as a heartbeat;
- an undeclared step ignored;
- Mastra's clock deciding.

## Limits

- **Workflows covered:** sequential workflows only.
- **Not run:** a parallel branch, a nested workflow, a durable agent, an LLM, libSQL or Postgres
  storage, and a second operating-system process.
- **E5 setup:** E5 shares one in-memory store between two Mastra instances in one process.
- **Durable agents:** the Mastra documentation describes run claims and write fencing for durable
  agents on libSQL and Postgres. This prototype does not exercise them.
