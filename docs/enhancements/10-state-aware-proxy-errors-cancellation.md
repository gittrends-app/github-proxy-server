---
id: 10
title: Make proxy errors and cancellation state-aware
status: planned
risk: moderate
urgency: high
scope: proxy error responses, sockets, abort signals, and cancellation
---

**Status:** Planned; not yet implemented.

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

## Validation plan

Extend tests for timeout, upstream connection failure, client disconnect, completed response, and
partial response cases. Confirm no duplicate response writes and that in-flight work is cancelled.

## Definition of done

- Error handling is conditional on accurate request/response state.
- Cancellation reaches the active upstream operation.
- Existing and new timeout/disconnect regression tests pass.
