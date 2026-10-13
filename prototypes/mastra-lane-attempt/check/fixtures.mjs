/**
 * Deterministic fixtures for the checks: zero-LLM Mastra workflows, an in-memory store, a
 * coordinator clock the test drives, and Gaia attempts. Nothing here touches the network.
 */
import { Mastra } from '@mastra/core';
import { InMemoryStore } from '@mastra/core/storage';
import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

const empty = z.object({});
const count = z.object({ n: z.number() });

/** A coordinator clock: each read returns the current instant, then moves it on by `tickMs`. */
export function coordinatorClock(startIso, tickMs = 1_000) {
  let t = Date.parse(startIso);
  const clock = () => {
    const at = new Date(t).toISOString();
    t += tickMs;
    return at;
  };
  clock.peek = () => new Date(t).toISOString();
  clock.advance = (ms) => { t += ms; };
  return clock;
}

/** A Gaia attempt starting at `startedAt`, with its deadline and heartbeat timeout in ms. */
export function gaiaAttempt({ startedAt, deadlineMs = 600_000, heartbeatTimeoutMs = 60_000, attemptNumber = 1 }) {
  return {
    laneId: 'mastra-proto',
    attemptNumber,
    startedAt,
    deadline: new Date(Date.parse(startedAt) + deadlineMs).toISOString(),
    heartbeatTimeoutMs,
  };
}

/** A Mastra instance over one in-memory store, logging nothing. */
export function mastraWith(workflows, storage = new InMemoryStore()) {
  return new Mastra({ storage, workflows, logger: false });
}

const add = (id, k) => createStep({
  id, inputSchema: count, outputSchema: count,
  execute: async ({ inputData }) => ({ n: inputData.n + k }),
});

/** Three sequential steps, no pause. */
export function threeSteps() {
  return createWorkflow({ id: 'three-steps', inputSchema: count, outputSchema: count })
    .then(add('prepare', 1)).then(add('build', 10)).then(add('report', 100)).commit();
}

/** prepare, then a gate that suspends until `{ approved: true }` arrives, then publish. */
export function approval() {
  const gate = createStep({
    id: 'gate', inputSchema: count, outputSchema: count,
    suspendSchema: z.object({ ask: z.string() }), resumeSchema: z.object({ approved: z.boolean() }),
    execute: async ({ inputData, resumeData, suspend }) => {
      if (resumeData?.approved !== true) return await suspend({ ask: `publish ${inputData.n}?` });
      return inputData;
    },
  });
  return createWorkflow({ id: 'approval', inputSchema: count, outputSchema: count })
    .then(add('prepare', 1)).then(gate).then(add('publish', 1000)).commit();
}

/**
 * start, then `work`, which records a side effect and waits for `release()` while ignoring the
 * abort signal, as a provider call that does not honour cancellation would, then finish.
 */
export function stubbornWork() {
  const effects = [];
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const work = createStep({
    id: 'work', inputSchema: count, outputSchema: count,
    execute: async ({ inputData }) => {
      effects.push('work started');
      await released;
      effects.push('work finished its side effect');
      return inputData;
    },
  });
  const workflow = createWorkflow({ id: 'stubborn', inputSchema: count, outputSchema: count })
    .then(add('start', 1)).then(work).then(add('finish', 1)).commit();
  return { workflow, effects, release: () => release() };
}

/** One step that counts a side effect, then hangs while `hang.on` is true. */
export function countedEffect(hang) {
  const ledger = { effects: 0 };
  const effect = createStep({
    id: 'effect', inputSchema: empty, outputSchema: z.object({ effects: z.number() }),
    execute: async () => {
      ledger.effects += 1;
      if (hang.on) await new Promise(() => {});
      return { effects: ledger.effects };
    },
  });
  const build = () => createWorkflow({ id: 'counted', inputSchema: empty, outputSchema: z.object({ effects: z.number() }) })
    .then(effect).commit();
  return { build, ledger };
}

/** Let pending microtasks and timers run. */
export const settle = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));
