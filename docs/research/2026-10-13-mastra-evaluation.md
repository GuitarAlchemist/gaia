# Mastra evaluation: an executor under Gaia's lane-attempt contract

Date: 2026-10-13  
Status: research synthesis with a prototype; advisory; no implementation or effect authority  
Question: should Gaia adopt, emulate, integrate or refuse [Mastra](https://mastra.ai), and where would it sit in Gaia's control plane?  
Method: the one the [agent-platform benchmark](2026-08-30-agent-platform-capability-benchmark.md#method-and-evidence-labels) defines, with the same evidence labels, plus a prototype whose checks are reproduced here.

## Executive verdict

**Integrate Mastra as an executor behind Gaia's attempt contract; do not adopt it as Gaia's control plane; refuse it as a source of authority.**

Mastra is a TypeScript framework for agents and workflows. Its workflow engine is a good executor:
- typed sequential steps;
- a stream of step events;
- suspend and resume backed by persisted snapshots.

The prototype in [`prototypes/mastra-lane-attempt/`](../../prototypes/mastra-lane-attempt/README.md) drives one zero-LLM workflow run as one Gaia lane attempt. Gaia's existing decision core, `src/lane-attempt.mjs`, decides it unchanged.

The same checks show four places where Mastra's semantics are weaker than Gaia's control-plane contract. Gaia therefore has to keep each of them on its own side of the seam:

1. **Resume is not authority.** Anyone holding a run id can resume a suspended run. Only the resume payload's schema is checked: no grant, intent digest or expiry (E2).
2. **Cancel is cooperative.** `run.cancel()` marks the run `canceled` and aborts a signal. A step that ignores the signal still performs its side effect (E3).
3. **Recovery re-executes.** `restart()` from a second instance runs a step's side effect again while the first execution is still alive. Recovery is at-least-once and, in this setup, unfenced (E5).
4. **Telemetry is on by default.** Mastra ships PostHog telemetry with an embedded project key, enabled unless `MASTRA_TELEMETRY_DISABLED` is set (E6).

The prototype also exposes a gap on Gaia's side. Its lane-attempt contract has no "waiting for a person" state. A Mastra human-in-the-loop pause therefore reads as a hang and ends the attempt by heartbeat timeout (E2). That is a Gaia design question, recorded below as a proposal, not decided here.

## Pinned comparison points

| System | Comparison revision | Notes |
|---|---|---|
| Gaia | `0c53129b1154ef8cd311aa2a2d2743783bbef353` (`origin/main`, 2026-10-14) | `src/lane-attempt.mjs` used unchanged |
| Mastra | [`@mastra/core@1.75.0`](https://github.com/mastra-ai/mastra/releases/tag/%40mastra%2Fcore%401.75.0), published to npm 2026-10-07 | Node `>=22.13.0`; peer `zod` `^3.25 \|\| ^4`, pinned here at `4.1.12`. 152 packages with `npm install --ignore-scripts`, none with an install script. Licenses: Apache-2.0 15, MIT 125, ISC 5, BSD-2/3 4, BlueOak 2, AFL-2.1/BSD-3 1. |

Mastra's repository [`LICENSE.md`](https://github.com/mastra-ai/mastra/blob/main/LICENSE.md) is Apache-2.0, except for any directory named `ee/`, which has its own license. This evaluation imports no `ee/` path. The prototype ran on Gaia's pinned Node v26.8.1.

On 2026-10-14, `npm audit` reports one moderate advisory in the installed tree: [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c), a denial of service through unbounded precision specifiers in `sprintf-js` up to 1.1.3.
- The installed `sprintf-js` 1.0.3 arrives through `@mastra/core` → `gray-matter` 4.0.3 → `js-yaml` 3 → `argparse` 1, and npm counts the five packages of that chain as affected.
- `@mastra/core` 1.76.0 and 1.77.0 still require `gray-matter` `^4.0.3`, which is the latest `gray-matter`. npm's only offered fix is a downgrade to `@mastra/core` 1.0.4.
- The prototype does not measure whether its code path reaches `gray-matter`. A Gaia adapter would carry the advisory until that chain moves.

## What Mastra offers

All of this is a **first-party claim** unless a check below reproduces it.

- **Workflows.** [Workflows](https://mastra.ai/docs/workflows/overview.md) are typed steps with branching, parallel paths, loops, sleeps, streaming, retries and nested workflows.
  - [Suspend and resume](https://mastra.ai/docs/workflows/suspend-and-resume.md) is backed by [snapshots](https://mastra.ai/docs/workflows/snapshots.md) in a configured store: libSQL, Postgres, MongoDB, Upstash, DynamoDB and others.
  - [Time travel](https://mastra.ai/docs/workflows/time-travel.md) and [scheduled workflows](https://mastra.ai/docs/workflows/scheduled-workflows.md) are documented too.
  - Workflows can also run on Inngest or Temporal as [workflow runners](https://mastra.ai/docs/deployment/workflow-runners.md).
- **Agents.** They have tools, structured output and [human-in-the-loop approvals](https://mastra.ai/docs/agents/human-in-the-loop.md). [Subagents](https://mastra.ai/docs/subagents.md) and a [model router](https://mastra.ai/models.md) over many providers and [gateways](https://mastra.ai/models/gateways.md) are documented.
- **Harness.** [Durable agents](https://mastra.ai/docs/harness/durable-agents.md) add crash recovery, resumable streams and run ownership. Run claims are renewed every 10 s and lapse after 30 s. Write fencing applies on the in-memory, libSQL, Turso and Postgres stores. Goals, schedules and signals are documented alongside.
- **Supporting pieces.** [Memory](https://mastra.ai/docs/memory/overview.md), RAG, [evals](https://mastra.ai/docs/evals/overview.md) with gates and verdicts, [tracing and metrics](https://mastra.ai/docs/observability/tracing/overview.md) with OpenTelemetry export, [MCP](https://mastra.ai/docs/connections/mcp.md) and [A2A](https://mastra.ai/docs/connections/a2a.md) connections, [sandboxes](https://mastra.ai/docs/sandbox/overview.md), a [browser](https://mastra.ai/docs/browser.md), a Hono [server](https://mastra.ai/docs/server/overview.md) with [auth](https://mastra.ai/docs/auth/overview.md), and Studio.
- **Mastra Factory.** [Mastra Factory](https://mastra.ai/factory) is "an open source environment" for issue intake, triage, planning, building and pull-request review, with configurable stages. It is the closest peer of Gaia's own factory. It was not run here.
- **Mastra Platform.** The platform is paid hosting: the Factory page lists $0, $250/month and custom tiers, metered by observability events and CPU hours. Nothing here uses it.

## The prototype

`prototypes/mastra-lane-attempt/` is a separate package with its own manifest and lockfile. It imports `src/lane-attempt.mjs` by relative path, and nothing in Gaia imports it. Its observer, `src/attempt-observer.mjs`, is pure. It turns each chunk of a run's `fullStream` into a lane-attempt event:
- the start and the result of the n-th declared step become a heartbeat `L<n>`;
- a successful finish becomes the marker;
- a suspension, or a finish with another status, adds nothing;
- an abort is the coordinator's order.

Every event carries the coordinator's instant, and Mastra's own `startedAt` decides nothing. The checks are deterministic, use no model and no network, and run with `npm run check`.

| Check | Question | Observation (**Verified** at `@mastra/core@1.75.0`) | Reading for Gaia |
|---|---|---|---|
| E1 | Can a Mastra run feed the lane-attempt core without changing it? | A three-step run gives `L1 L1 L2 L2 L3 L3 MARKER` and is decided `COMPLETE` with `T_EXIT_CLEAN`. Run past its deadline, the same run is `DEADLINE_EXCEEDED` with `QUARANTINE_LATE_OUTPUT`. A step the caller did not declare is refused (`UndeclaredStep`). | The seam is the observer. No seventh verb, no kernel import. |
| E2 | What is a human-in-the-loop pause? | A suspension adds no event. After the 60 s heartbeat timeout the attempt is `HEARTBEAT_TIMEOUT`. A resume ten minutes later still completes the Mastra run (`success`); the core keeps its first decision and quarantines the late output. With an answer inside 60 s the attempt completes. A handle built from the run id alone resumes the run; the schema rejects `approved: 'yes'` and nothing else is asked. | A pause cannot be told from a hang (Gaia gap). Mastra's resume is not authority (refuse). |
| E3 | Does cancel stop work? | After the timeout, `run.cancel()` stores `canceled` and the stream ends `canceled`. A step that ignores the abort signal still records its side effect afterwards. No later step runs. | `STOP_ATTEMPT_PROCESS` needs a process boundary, not `cancel()`. |
| E4 | Is an abort honoured? | The coordinator's order is decided `ABORTED` with `SEND_LANE_ABORTED`. The canceled run refuses a later resume: "This workflow run was not suspended". | Usable as-is. |
| E5 | What does recovery do? | A step records a side effect and goes quiet. The run stays `running` in the store. A second Mastra instance over the same store lists it as active and `restart()`s it. The side effect count reaches 2 while the first execution has not ended. | Re-driving is a new Gaia attempt after the stop is proven. Mastra's restart must stay off for side-effecting work (`autoRestartActiveRuns: false`). |
| E6 | Does it phone home? | Workflow runs make no request with telemetry at its default. Mastra's own feature-usage call reaches PostHog through `fetch` when `MASTRA_TELEMETRY_DISABLED` is unset; with it set to `1`, nothing is sent. The spy answers every request itself. | Any Gaia adapter sets `MASTRA_TELEMETRY_DISABLED=1`. |

**Controls.** Five mechanism-revert mutants of the observer each fail at least one check, and the observer was restored byte for byte after each:
- no step heartbeats;
- a marker on any finish;
- a suspension read as a heartbeat;
- an undeclared step ignored;
- Mastra's clock deciding.

A first version of E2 let the third mutant survive; E2 now pins the exact event sequence up to the pause.

**What this does not establish.**
- **Not exercised:**
  - no LLM, tool, memory or durable agent ran;
  - no libSQL or Postgres store was used;
  - there was no second operating-system process;
  - no parallel or nested workflow was observed;
  - Mastra Factory and the Platform were not run.
- **Durable agents:** the run ownership and write fencing their documentation describes may close E5's gap for them. That is a **first-party claim** not tested here.
- **Telemetry entry points:** E6 measures the in-process workflow path and one telemetry entry point, not the CLI, the dev server or the deployer.

## Normalized capability reading

Same legend as the [benchmark matrix](2026-08-30-agent-platform-capability-benchmark.md#normalized-capability-matrix): **N** native, **I** integration, **P** partial, **A** advisory, **—** not verified. Marks without a check are first-party claims at the pinned version's documentation.

| Capability | Mastra | Reading for Gaia |
|---|---:|---|
| Orchestration and fanout | N | Workflows (verified E1–E5) and subagents. A candidate executor behind the executor manifest (benchmark P1 #5). |
| Provider/model routing | N | A model router and gateways. No resolution receipt in Gaia's sense (benchmark P0 #2). |
| Planning and skills | P | Skills, goals and the Factory's stages. |
| Memory and RAG | N | Out of scope here. |
| Long-running jobs | N/P | Snapshots and restart are verified (E2, E5), but restart is at-least-once and was unfenced for plain workflows (E5). Durable-agent claims and fencing are first-party. |
| Self-improvement | P | Evals, datasets and experiments. Nothing autonomous was observed. |
| Tools and MCP | N | MCP client and server, and A2A. |
| Browser and computer use | N/I | Browser and sandbox computer surfaces. |
| Scheduling and triggers | N | Scheduled workflows, schedules and signals. |
| Multi-repo GitHub automation | P | The Factory's issue and pull-request intake. Not run. |
| Observability | N | Tracing, metrics and logs with an OpenTelemetry exporter. PostHog telemetry is on by default (E6). |
| Fault recovery | P | Restart re-executes (E5). Cancel is cooperative (E3). |
| Security and sandboxing | P | Auth providers and sandboxes are documented. Resume has no authority check (E2). |
| Costs and quotas | P | Usage metrics. No hard ceiling was found. |
| Remote friendliness | N | A Hono server, client SDK and A2A. Gaia keeps no listener. |
| Human approval | P | Suspend and resume plus tool approvals. They carry no exact intent, expiry or single use (E2). |

## Adoption ledger

- **Integrate.** A Mastra workflow runs as an executor behind a Gaia attempt, through an observer like the prototype's.
  - The adapter runs Mastra in a separate process, so Gaia's stop is real (E3).
  - It sets `MASTRA_TELEMETRY_DISABLED=1` (E6) and `autoRestartActiveRuns: false` (E5).
  - It never lets a Mastra resume stand in for a Gaia grant (E2).
  - This is benchmark P1 #5, the executor manifest. No new kernel verb is needed.
- **Emulate.**
  - The run-ownership design of durable agents: a claim with a renewal interval and a lapse, fencing writes by the claim's generation. It is the concrete shape of benchmark P0 #1, the durable attempt contract with lease and fencing.
  - Their resumable stream with an event offset, for benchmark P1 #6, the transport-isolated event adapter.
- **Refuse.**
  - Mastra suspend and resume as Gaia's approval mechanism.
  - Mastra Factory or a Mastra server as Gaia's control plane. It would replace exact-intent approval, evidence receipts and the publisher boundary with product stages.
  - Automatic boot-time restart of side-effecting runs.
  - Default-on telemetry in any Gaia process.

## Gaia gap the prototype exposes

`src/lane-attempt.mjs` decides `CONTINUE`, `COMPLETE`, `DEADLINE_EXCEEDED`, `HEARTBEAT_TIMEOUT` and `ABORTED`. A run that waits for a person is indistinguishable from a hung one (E2). Raising the heartbeat timeout would blind the coordinator to real hangs.

Two shapes are possible:
- **End the attempt at the suspension** with a resumable compensation, and treat the resume as a new attempt that needs a Gaia grant.
- **Add a waiting decision** with its own deadline, entered only on an executor claim the coordinator can verify.

The first keeps the core as it is and binds the resume to Gaia authority; the second changes the decision table and the lane net. This evaluation proposes the first for a follow-up and decides neither.

## Instruction coverage

The prototype introduces a third-party dependency, a lockfile and a new top-level directory, `prototypes/`. They stay outside the product:
- the root `package.json` still has no dependency;
- `node_modules/` stays ignored;
- the checks' file names fall outside the default `node --test` patterns;
- none of the architecture gate's sensitive paths change.

The `.gitignore` comment that said the product has no dependency and no lockfile now names this exception. Disposition: covered, with that one update within scope.

## Reproduce

```sh
cd prototypes/mastra-lane-attempt
npm ci --ignore-scripts
npm run check   # 11 tests, 11 pass
```
