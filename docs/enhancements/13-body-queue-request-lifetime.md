---
id: 13
title: Bound request bodies, queue residency, and end-to-end request lifetime
status: verified
risk: high
urgency: high
scope: request bodies, queues, overload handling, and timeout budgets
---

**Status:** Verified; focused and full validation are complete.

## Problem

Request bodies are fully buffered, proxy body reads are outside the existing fetch timeout window,
and queues have no depth or end-to-end request-lifetime bound.

## Evidence

- Request-body buffering and active timeout handling are implemented in `src/proxy-client.ts`.
- Bounded queue contexts, deadline timers, cancellation, and rejection responses are implemented in
  `src/router.ts`.
- New limits are validated and propagated through `src/cli.ts` and `src/server.ts`.

## Expected benefit

Memory use, queue latency, and work held for disconnected clients become bounded, and overload is
reported predictably instead of accumulating indefinitely.

## Dependencies/decisions

Define maximum body size, queue depth, queue-wait timeout, total request lifetime, and overload
status/response. Coordinate cancellation with item 10 and defer dispatcher changes until these
queue boundaries are explicit.

## Implementation notes

The proxy enforces a 1 MiB default request-body limit before buffering (configurable from 1–16 MiB),
with a typed `PAYLOAD_TOO_LARGE` error and a deterministic `413` response. Queue capacity is shared
per resource at `live workers × maxQueueDepthPerWorker`; full queues return `503` with
`Retry-After: 1`. Queue contexts track absolute queue and lifetime deadlines, remove expired work,
share one abort controller through retries and active proxy work, and clean up disconnect and
destruction listeners. Queue expiry returns `504` with `Request expired in proxy queue`, while total
lifetime expiry returns `504` with `Request lifetime exceeded`. The existing upstream request timeout
continues to use its existing `502` behavior.

## Validation plan

Test body-size boundaries, slow uploads, queue saturation, queue expiry, client disconnects, and
end-to-end timeout behavior. Measure that rejected overload does not grow queue residency without
bound.

## Definition of done

- Body, queue, wait, and total-lifetime limits are configured and documented.
- Overload and timeout responses are deterministic.
- Regression tests cover memory-sensitive and cancellation-sensitive paths.

## Configuration

| Option | Environment | Default | Range |
| --- | --- | ---: | ---: |
| `maxRequestBodyBytes` | `GPS_MAX_REQUEST_BODY_BYTES` | 1 MiB | 1–16 MiB |
| `maxQueueDepthPerWorker` | `GPS_MAX_QUEUE_DEPTH` | 50 | 1–1000 |
| `queueWaitTimeout` | `GPS_QUEUE_WAIT_TIMEOUT` | 30,000 ms | 1–120,000 ms |
| `requestLifetimeTimeout` | `GPS_REQUEST_LIFETIME_TIMEOUT` | 120,000 ms | 1–600,000 ms |

## Validation evidence

- Focused proxy, router, server, and CLI suites: 224 tests passed.
- Full test suite: 224 tests passed.
- Biome lint, TypeScript checking, production build, and `git diff --check` passed.
