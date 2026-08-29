---
id: 05
title: Correct forwarded metadata
status: planned
risk: low
urgency: normal
scope: proxy request headers and upstream metadata
---

**Status:** Planned; not yet implemented.

## Problem

Forwarded metadata is derived after the host header has been deleted, and protocol detection checks
the wrong request-socket property. Upstream requests therefore receive incorrect host/protocol data.

## Evidence

- Host deletion and forwarded-header ordering, including the protocol check, are at
  `src/proxy-client.ts:56-66`.

## Expected benefit

GitHub and downstream consumers receive consistent client, host, and protocol metadata at the proxy
boundary.

## Dependencies/decisions

Decide the trusted source for forwarded headers, including whether an existing `x-forwarded-for`
value may be retained. Coordinate trust-proxy and external-base-url decisions with item 12.

## Implementation notes

Capture the inbound host before deleting it, use a correct protocol source, and define behavior for
proxy chains without trusting spoofable headers by default.

## Validation plan

Add proxy-client tests that inspect outgoing host/protocol/forwarded headers for representative HTTP
and HTTPS requests and for absent host data. Verify existing authorization/header behavior.

## Definition of done

- Forwarded host and protocol values are derived in the intended order.
- The selected trust policy is documented and tested.
- No unrelated proxy header behavior changes.
