---
id: 12
title: Correct HTTP forwarding semantics at the proxy boundary
status: planned
risk: moderate/high
urgency: high
scope: request/response headers, hop-by-hop semantics, links, and proxy trust
---

**Status:** Planned; not yet implemented.

## Problem

The proxy copies headers without hop-by-hop filtering, flattens upstream response headers, and
rewrites links to hard-coded HTTP while trusting the inbound Host value.

## Evidence

- Request header copying is at `src/proxy-client.ts:48-60`.
- Response header flattening is at `src/proxy-client.ts:86-113`.
- No hop-by-hop filtering is present in those forwarding paths.
- Link rewriting hard-codes HTTP and uses inbound Host at `src/router.ts:147-153`.

## Expected benefit

Requests and responses follow HTTP proxy semantics, preserve meaningful metadata, and generate links
that match the externally visible deployment URL.

## Dependencies/decisions

Define the hop-by-hop header policy, trusted proxy behavior, and external base URL configuration.
Coordinate forwarded metadata changes with item 05 and timeout/stream work with item 13.

## Implementation notes

Filter connection-specific headers on both directions, preserve valid multi-value semantics, and
derive link rewriting from an explicit trusted external scheme/host rather than an untrusted inbound
value.

## Validation plan

Add integration tests for hop-by-hop headers, multi-value response headers, forwarded requests, and
HTTP/HTTPS external URL combinations. Verify redirects and Link headers under the selected trust
configuration.

## Definition of done

- Header forwarding follows the documented HTTP semantics.
- Link rewriting uses the selected trusted external URL policy.
- Integration/regression tests cover the proxy boundary and evidence is reported.
