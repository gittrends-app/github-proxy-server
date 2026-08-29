---
id: 10
title: Make proxy errors and cancellation state-aware
status: verified
risk: moderate
urgency: high
scope: proxy error responses, sockets, abort signals, and cancellation
---

**Status:** Verified; review and final validation are complete.

## Problem

The error path may send a response and then destroy it, checks the wrong request socket state, and
uses an abort controller that is never assigned to the request context.

## Evidence

- Send-then-destroy behavior is at `src/router.ts:197-211`.
- The request context declares an optional controller at `src/router.ts:18-21`, but the proxy call
  does not assign one before `src/router.ts:209`.
- Existing error and cancellation tests are at `src/router.spec.ts:101-113` and `src/router.spec.ts:172-185`.

## Expected benefit

Disconnected clients and upstream failures do not trigger duplicate writes, noisy socket errors, or
ineffective cancellation.

## Dependencies/decisions

Coordinate request-body and stream timeout behavior with item 13. Define which side owns abort
controllers and which response/socket states permit an error response.

## Implementation notes

Make cancellation state explicit, attach the active controller to the request context, guard writes
with the correct response/request state, and avoid destroying a response after a completed send.

The router owns one controller for each active request and passes it to `ProxyClient`; request,
socket, and response-close events abort that controller. Proxy operations race request-body reads,
upstream reads, and backpressure waits against the signal. Error handling sends `502` only when the
request is connected and no response has started, destroys only a connected partial response, and
leaves completed or disconnected responses untouched. Existing request timeout behavior remains the
only timeout boundary coordinated here; no item 13 body, queue, overload, or lifetime limits are
introduced.
Worker destruction aborts request-owned controllers before response teardown and task settlement.
Response streaming rechecks cancellation and downstream state before status/header mutation, each
chunk, drain wait, and terminal `end`; readers are best-effort cancelled and released on abort.

## Validation plan

Extend tests for timeout, upstream connection failure, client disconnect, completed response, and
partial response cases. Confirm no duplicate response writes and that in-flight work is cancelled.

## Definition of done

- Error handling is conditional on accurate request/response state.
- Cancellation reaches the active upstream operation.
- Existing and new timeout/disconnect regression tests pass.

## Implementation evidence

- `src/router.ts` attaches active request controllers, aborts on disconnect, and uses
  `headersSent`, `writableEnded`, `destroyed`, and request/socket state before writing or destroying;
  worker teardown aborts active requests before settling them.
- `src/proxy-client.ts` accepts the router-owned controller and makes body, upstream, and stream
  operations cancellation-aware, with response-state guards and drain-listener cleanup.
- `src/router.spec.ts` covers timeout, upstream failure, client disconnect, completed responses,
  partial responses, and cancellation propagation.
- Final validation: focused proxy/router tests (70 passed), full test suite (163 passed), Yarn lint,
  TypeScript, and production build passed.
