---
id: 05
title: Correct forwarded metadata
status: verified
risk: low
urgency: normal
scope: proxy request headers and upstream metadata
---

**Status:** Verified; review and the parent orchestrator's validation gate are complete.

## Problem

Forwarded metadata was derived after the host header had been deleted, and protocol detection checked
the wrong request-socket property. Upstream requests therefore received incorrect host/protocol data.

## Evidence

- Host deletion and forwarded-header ordering, including the protocol check, are at
  `src/proxy-client.ts:56-66`.

## Expected benefit

GitHub and downstream consumers receive consistent client, host, and protocol metadata at the proxy
boundary.

## Dependencies/decisions

The default policy does not trust inbound `x-forwarded-for`, `x-forwarded-host`, or
`x-forwarded-proto` values. Existing forwarded values, including proxy-chain entries, are discarded
and replaced with metadata from the immediate connection: `remoteAddress`, `socket.encrypted`, and
the inbound `Host` captured before it is removed. A missing host produces an empty
`x-forwarded-host` value. Generated values are written after `modifyHeaders`, so an inbound value
cannot be retained accidentally by the normal proxy path.

This is intentionally a fail-safe policy for deployments where clients can reach this boundary
directly. Future item 12 must define any opt-in trusted-proxy chain policy and its external base URL
semantics; it must not infer trust from the presence of forwarded headers. Item 12 is not implemented
here.

## Implementation notes

Capture the inbound host before deleting it, use `req.socket.encrypted` for protocol detection, and
overwrite spoofable forwarded headers with immediate-connection metadata by default.

## Validation plan

Proxy-client tests inspect outgoing host/protocol/forwarded headers for representative HTTP and HTTPS
requests, absent host data, and spoofed forwarded values. Existing authorization/header behavior
remains covered by the proxy-client suite.

## Validation evidence

- `npx vitest run src/proxy-client.spec.ts`
- `git diff --check`
- Final validation: Yarn lint, TypeScript, all 120 tests, production build, Docker image build, and
  the built-container health check passed.

## Definition of done

- Forwarded host and protocol values are derived in the intended order.
- The selected trust policy is documented and tested.
- No unrelated proxy header behavior changes.
