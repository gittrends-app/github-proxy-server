---
id: 03
title: Tighten the exact status exception
status: verified
risk: very-low
urgency: urgent
scope: status endpoint authentication and deployment guidance
---

**Status:** Verified; review and the parent orchestrator's validation gate are complete.

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

The selected public surface is `/status` and the nested `/status/*` namespace. This preserves the
swagger-stats redirect from `/status` to `/status/` while excluding lookalike paths such as
`/status-other`. HTTP requires TLS termination at a trusted boundary when credentials or traffic
cross an untrusted network.

## Implementation notes

Implement the selected route matcher rather than a general prefix check. Keep the status behavior
needed by health checks and update deployment examples to reflect the chosen boundary.

## Implementation evidence

- `src/server.ts` now exempts only `/status` or paths beginning with the explicit `/status/` route
  boundary.
- `src/server.spec.ts` covers unauthenticated `/status` and `/status/` health access, while
  `/status-other` and `/status-metrics` remain protected with configured authentication.
- `README.md` documents the public status namespace, the all-interface plain-HTTP CLI listener,
  and the requirement for trusted HTTPS/TLS termination across untrusted networks.
- Focused validation: `npx vitest run src/server.spec.ts` — 22 tests passed.
- Final validation: Yarn lint, TypeScript, all 120 tests, production build, Docker image build, and
  the built-container health check passed.

## Validation plan

Test `/status`, intended nested status paths, and lookalike paths such as `/status-other` under
authentication. Verify the Docker health check and documented HTTP deployment behavior.

## Definition of done

- The exact status exception is documented and enforced.
- Lookalike paths require authentication.
- Health behavior and TLS-boundary guidance are validated and reported.
