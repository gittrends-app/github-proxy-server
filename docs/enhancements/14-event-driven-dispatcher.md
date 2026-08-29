---
id: 14
title: Replace per-worker polling with an event-driven bounded dispatcher
status: planned
risk: highest
urgency: normal
scope: scheduling architecture, queue notification, fairness, and bounded dispatch
---

**Status:** Planned; not yet implemented.

## Problem

Workers poll every 100ms, enqueueing does not notify workers, queue removal is O(n), and each token
creates four workers. This makes dispatch latency, fairness, and resource behavior harder to bound.

## Evidence

- Polling is implemented at `src/router.ts:276-287`.
- Queue enqueueing has no notification at `src/router.ts:301-306`.
- Dequeue uses O(n) `shift()` at `src/router.ts:308-310`.
- Four workers per token are created at `src/router.ts:394-409`.

## Expected benefit

Dispatch reacts immediately to available work, has explicit fairness and capacity behavior, and
avoids unnecessary polling and queue scans.

## Dependencies/decisions

Defer this item until lifecycle cleanup, rate-limit refresh, cancellation, and queue-boundary work
has landed. Define fairness, per-token/resource capacity, notification ownership, and overload
behavior before changing the scheduling architecture.

## Implementation notes

Replace polling with explicit queue/worker notifications and a bounded dispatcher. Preserve resource
routing, rate-limit constraints, cancellation, and intentional retry behavior. Avoid changing all
dispatch semantics in one untested rewrite.

## Validation plan

Benchmark and test dispatch latency, fairness across tokens/resources, capacity limits, retries,
shutdown, cancellation, and queue saturation. Compare behavior against the bounded queue and
request-lifetime contract from item 13.

## Definition of done

- Polling is removed or isolated behind a documented compatibility fallback.
- Dispatcher capacity, fairness, notification, and overload semantics are tested.
- Performance and regression evidence demonstrate no loss of supported proxy behavior.
