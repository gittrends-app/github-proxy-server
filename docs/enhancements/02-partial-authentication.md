---
id: 02
title: Fail closed for partial authentication
status: planned
risk: very-low
urgency: urgent
scope: CLI authentication configuration
---

**Status:** Planned; not yet implemented.

## Problem

Authentication is only configured when both username and password are present, so a partial
configuration can silently leave the proxy unauthenticated.

## Evidence

- The conditional construction of the authentication object is at `src/cli.ts:105-111`.
- The server middleware consumes that optional object at `src/server.ts:122-125`.

## Expected benefit

Misconfigured deployments fail closed instead of unexpectedly exposing proxy endpoints.

## Dependencies/decisions

Define whether exactly one credential is a startup error and what message/exit behavior should be
used. Coordinate the decision with the status-exception item and deployment documentation.

## Implementation notes

Detect a username/password mismatch during startup, reject the configuration, and retain the
current successful path when both credentials are supplied. Do not log credential values.

## Validation plan

Add tests for username-only, password-only, neither, and both credentials. Verify the proxy does not
start for partial configuration and that valid protected requests still authenticate.

## Definition of done

- Partial authentication configuration is rejected before serving traffic.
- Complete authentication configuration behaves as intended.
- Tests and command evidence are reported.
