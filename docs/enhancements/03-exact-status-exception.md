---
id: 03
title: Tighten the exact status exception
status: planned
risk: very-low
urgency: urgent
scope: status endpoint authentication and deployment guidance
---

**Status:** Planned; not yet implemented.

## Problem

The authentication bypass uses a broad path prefix, which can expose routes beyond the intended
status endpoint namespace.

## Evidence

- The broad `req.path.startsWith('/status')` bypass is at `src/server.ts:122-125`.
- The server binds to `0.0.0.0` at `src/cli.ts:121`.
- HTTP startup and usage examples appear in `README.md:84-104`.

## Expected benefit

Only the deliberately public status surface is exempted from authentication, reducing accidental
exposure when the service is reachable on a network interface.

## Dependencies/decisions

Decide whether the exception is exact `/status` only or the intended `/status/*` namespace. Warn
and document that HTTP requires TLS termination at a trusted boundary when credentials or traffic
cross an untrusted network.

## Implementation notes

Implement the selected route matcher rather than a general prefix check. Keep the status behavior
needed by health checks and update deployment examples to reflect the chosen boundary.

## Validation plan

Test `/status`, intended nested status paths, and lookalike paths such as `/status-other` under
authentication. Verify the Docker health check and documented HTTP deployment behavior.

## Definition of done

- The exact status exception is documented and enforced.
- Lookalike paths require authentication.
- Health behavior and TLS-boundary guidance are validated and reported.
