# Scale and lanes: what is actually proven

The supported default is **4 live lanes per workspace**. This document is the evidence
behind that number, and the honest statement of what is not behind it.

## The claim ladder

| Lanes | Status | What backs it |
| --- | --- | --- |
| **4** | **SUPPORTED DEFAULT** | Four concurrent client+server process pairs against one log, exercised in this product's own suite (`four lanes register, and a fifth is refused`) plus the ported cross-process concurrency gates. |
| 6 | NEXT VALIDATION TARGET | Nothing with real Claude/Codex lanes. Allowed only under `--experimental-lanes`, and labelled experimental in the output. |
| 8 | UNPROVEN WITH REAL CLIENTS | Only identical Node workers have been measured at 8 and 16. Allowed only under `--experimental-lanes`. |
| >8 | REFUSED ALWAYS | Nothing above 8 has been measured at all, with any client. |

`--experimental-lanes` records that an operator accepted an unproven limit. It creates
no evidence and changes no default.

## What the N-writer measurements do and do not prove

The 4/8/16-writer probes this design inherits ran **identical Node client+server
pairs** against one data directory. They prove:

- ids are unique across processes (`act-NNNN`, `msg-NNNN` dense and monotonic);
- the JSONL stays one complete record per line under contention;
- replay is deterministic and byte-identical across processes;
- the degradation mode under a stuck lock is fail-closed, not corrupting.

They do **not** prove:

- throughput, or latency under a real model turn;
- heterogeneity — a Claude lane and a Codex lane are not two Node workers, and their
  call patterns, timeouts, and idle behaviour differ;
- behaviour on a log of 10^4-10^5 events, which no measurement has covered;
- anything about a lane that stalls mid-call.

The single missing experiment, named by the reviews this product descends from and
still missing here, is **the same probe with real Claude and Codex lanes**. Until that
runs, 6 and 8 stay where they are.

## Why the ceiling is where it is

Per-call cost is **O(events x actors)** under one global lock on a log that never
compacts. Both factors grow with lanes:

- more lanes means more actors, so each event costs more to apply;
- more lanes means more events, so there are more events to apply;
- more lanes means more contention on the single lock.

So lane count enters the cost roughly quadratically while the lock serialises the
whole thing. Four is not a round number chosen for tidiness; it is the largest count
this product has actually exercised end to end.

## What would raise the default

All three, together:

1. A bounded-cost read path — a cached tail offset, or snapshot plus tail — so
   per-call cost stops being O(events x actors). This is a design change, not a tuning
   knob, and it is deliberately not implemented here.
2. A probe with **real** Claude and Codex lanes at the target count, on a log of
   realistic size, with the same id-uniqueness, JSONL-integrity and replay-determinism
   assertions the Node-worker probes make.
3. An answer for what happens when one lane wedges the lock, since there is still no
   automatic recovery.

Raising the number in `src/lanes.mjs` without (1) and (2) would make this document a
lie. The number and its evidence live in the same file for that reason.

## Operating inside the limit

- One lane type, one checkout, one writer scope, one result path, one completion
  marker per lane.
- Preserve one mutable writer per repository.
- `status` reports `overSupportedLaneLimit` so a workspace that drifted past 4 by some
  other route is visible.
- A lane unseen for 30 s is `stale`, not gone: still registered, still addressable.
  Partial reachability is the normal case.
- `wmux-lanes sweep` marks exited and stale lanes with an ordinary durable `send`. It
  signals no process and closes no surface.
