---
id: 13
title: Bound request bodies, queue residency, and end-to-end request lifetime
status: planned
risk: high
urgency: high
scope: request bodies, queues, overload handling, and timeout budgets
---

**Status:** Planned; not yet implemented.

## Problem

Request bodies are fully buffered, proxy body reads are outside the existing fetch timeout window,
and queues have no depth or end-to-end request-lifetime bound.

## Evidence

- Body buffering is implemented at `src/proxy-client.ts:68-72` and `src/proxy-client.ts:149-158`.
- The timeout setup and fetch boundary are at `src/proxy-client.ts:41-42` and `src/proxy-client.ts:74-85`.
- Queues are unbounded at `src/router.ts:301-315`.
- Requests are enqueued at `src/router.ts:371-385`.

## Expected benefit

Memory use, queue latency, and work held for disconnected clients become bounded, and overload is
reported predictably instead of accumulating indefinitely.

## Dependencies/decisions

Define maximum body size, queue depth, queue-wait timeout, total request lifetime, and overload
status/response. Coordinate cancellation with item 10 and defer dispatcher changes until these
queue boundaries are explicit.

## Implementation notes

Enforce limits before unbounded buffering, account for body-read and queue-wait time in the request
budget, remove abandoned work, and select an explicit overload response. Preserve supported request
semantics while avoiding broad streaming rewrites without tests.

## Validation plan

Test body-size boundaries, slow uploads, queue saturation, queue expiry, client disconnects, and
end-to-end timeout behavior. Measure that rejected overload does not grow queue residency without
bound.

## Definition of done

- Body, queue, wait, and total-lifetime limits are configured and documented.
- Overload and timeout responses are deterministic.
- Regression tests cover memory-sensitive and cancellation-sensitive paths.
