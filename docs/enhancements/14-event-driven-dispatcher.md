---
id: 14
title: Replace per-worker polling with an event-driven bounded dispatcher
status: verified
risk: highest
urgency: normal
scope: scheduling architecture, queue notification, fairness, and bounded dispatch
---

**Status:** Verified; focused and full validation are complete.

## Problem

Workers previously polled every 100ms and enqueueing did not notify workers. This made dispatch
latency, fairness, and resource behavior harder to bound.

## Evidence

- `ProxyRouter` now owns per-resource dispatch state and schedules one coalesced microtask per
  notification burst.
- Workers notify the router when they become available, update rate limits, reset their time budget,
  retry work, or complete work.
- Dispatch uses per-resource round-robin selection and atomic worker reservations.
- A single reset wake timer is maintained per resource when all eligible workers are rate-limited.
- Router-owned budget reset scheduling replaces per-worker budget polling.

## Expected benefit

Dispatch reacts immediately to available work, has explicit fairness and capacity behavior, and
avoids unnecessary polling and repeated dispatch passes.

## Dependencies/decisions

Defer this item until lifecycle cleanup, rate-limit refresh, cancellation, and queue-boundary work
has landed. Define fairness, per-token/resource capacity, notification ownership, and overload
behavior before changing the scheduling architecture.

## Implementation notes

Polling was replaced with explicit queue/worker notifications and a bounded dispatcher. Resource
routing, rate-limit constraints, cancellation, retry behavior, queue capacity, and shared request
contexts remain unchanged.

## Validation plan

Validation covers dispatch latency, round-robin fairness, capacity limits, retries, shutdown,
cancellation, reset wakeups, worker destruction, and queue saturation. The item-14 focused tests
use direct queue inspection, mocked worker scheduling, and fake timers; no network throughput is
measured.

### Reproducible evidence

Commands run from the repository root:

```text
npx vitest run src/router.spec.ts --reporter=dot
npx vitest run src/router.spec.ts -t "enqueue notification|next request immediately|resource dispatch queues|round-robin|atomic concurrency|dispatcher timers|exhausted worker"
```

Observed results:

- Focused dispatcher checks: 7 passed.
- Complete router suite: 75 passed.
- Full project suite: 232 passed across 4 files.
- TypeScript, Biome lint, production build, and `git diff --check`: passed.
- Enqueue dispatch occurs after the next microtask; no 100ms polling advance is required.
- Exhausted-budget fake-timer coverage observed zero schedule/dequeue notifications through 59,999ms;
  one dispatch occurred at the 60,000ms budget reset.
- Two-worker round-robin order was exactly `[0, 1, 0, 1]`; the existing multi-token integration
  check observed every configured token serving work.
- Saturated capacity returned HTTP 503 with `Retry-After: 1`; adding a token increased capacity,
  and removing it restored the bounded worker count.

Timer accounting after refresh completion is linear only for the existing per-token refresh
intervals: 1, 10, and 100 tokens create respectively 1, 10, and 100 refresh intervals. The
dispatcher itself uses one global budget-reset timer, zero idle resource wake timers, and at most
one rate-reset wake timer per resource; it creates no per-worker polling intervals. The measured
steady-state dispatcher timer count is therefore one for each of 1/10/100 tokens when no resource
is rate-limited (or up to five including four resource wake timers while blocked).

Baseline commit `6882049` was not benchmarked: it has polling-driven scheduling and no equivalent
deterministic dispatcher boundary, so a wall-clock comparison would conflate polling, network, and
test-harness timing. No throughput claim is made.

## Definition of done

- Polling is removed or isolated behind a documented compatibility fallback.
- Dispatcher capacity, fairness, notification, and overload semantics are tested.
- Performance and regression evidence demonstrate no loss of supported proxy behavior.
