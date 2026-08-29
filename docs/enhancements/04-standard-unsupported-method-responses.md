---
id: 04
title: Correct standard unsupported-method responses
status: planned
risk: low
urgency: normal
scope: HTTP method routing and response status handling
---

**Status:** Planned; not yet implemented.

## Problem

Unsupported methods return a non-standard status code, making the proxy harder for clients and
intermediaries to interpret.

## Evidence

- `ProxyRouterResponse.PROXY_ERROR` is status 600 at `src/router.ts:317-319`.
- Unsupported method routing is defined at `src/server.ts:176-187`.

## Expected benefit

Clients receive a standard HTTP response for unsupported operations while intentional write-method
rejection remains explicit.

## Dependencies/decisions

Choose the appropriate standard 4xx status and response contract. Preserve the intentional rejection
of write methods rather than turning them into proxied writes.

## Implementation notes

Change only the unsupported-method response path and any associated response type/name. Keep GET and
GraphQL POST routing unchanged unless tests demonstrate a directly related defect.

## Validation plan

Add route tests for DELETE, PATCH, PUT, and unsupported POST paths, asserting the selected standard
status and message. Confirm supported GET and `/graphql` POST behavior remains unchanged.

## Definition of done

- Unsupported methods return the selected standard status.
- Intentional write-method rejection is preserved.
- Regression tests and validation evidence are reported.
