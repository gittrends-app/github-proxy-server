---
id: 02
title: Fail closed for partial authentication
status: verified
risk: very-low
urgency: urgent
scope: CLI authentication configuration
---

**Status:** Verified; implementation, review, and authoritative project validation are complete.

## Problem

Authentication is only configured when both username and password are present, so a partial
configuration can silently leave the proxy unauthenticated.

## Evidence

- Authentication configuration is constructed in `src/cli.ts` and previously omitted when only one
  credential was supplied.
- The server middleware consumes that optional object at `src/server.ts:122-125`.
- `src/cli.ts` now rejects partial authentication before creating or listening on the proxy server,
  using a stable error that contains no credential values.
- `src/cli.spec.ts` covers username-only and password-only startup rejection, neither/both
  configuration, and credential redaction in the configuration error.
- Existing protected-request coverage in `src/server.spec.ts` confirms valid complete credentials
  continue to authenticate, while no-auth coverage confirms neither credential keeps authentication
  disabled.

## Expected benefit

Misconfigured deployments fail closed instead of unexpectedly exposing proxy endpoints.

## Dependencies/decisions

Define whether exactly one credential is a startup error and what message/exit behavior should be
used. Coordinate the decision with the status-exception item and deployment documentation.

## Implementation notes

Detect a username/password mismatch during startup, reject the configuration, and retain the
current successful path when both credentials are supplied. Do not log credential values.

## Validation plan

Focused tests cover username-only, password-only, neither, and both credentials. The proxy does not
start for partial configuration, and existing protected-request tests cover valid authentication.

Focused evidence: `npx vitest run src/cli.spec.ts src/server.spec.ts` — 77 tests passed.

## Definition of done

- Partial authentication configuration is rejected before serving traffic.
- Complete authentication configuration behaves as intended.
- Tests and command evidence are reported.

## Verification evidence

- `src/cli.ts` rejects username-only and password-only configuration before creating or listening on
  the proxy server, without logging credential values.
- `src/cli.spec.ts` covers partial-auth startup failures, credential redaction, and neither/both
  configuration paths.
- `npx vitest run src/cli.spec.ts src/server.spec.ts`: passed (77 tests).
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- `npm test`: passed (117 tests).
- `npm run build`: passed.
- `git diff --check`: passed.
