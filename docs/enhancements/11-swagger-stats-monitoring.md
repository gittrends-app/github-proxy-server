---
id: 11
title: Replace or isolate public swagger-stats monitoring
status: verified
risk: moderate
urgency: normal
scope: monitoring middleware, public status surface, and health checks
---

**Status:** Verified; review and final validation are complete.

## Problem

The optional swagger-stats middleware exposes a monitoring URI that is also excluded from basic
authentication, creating a public observability surface whose necessity and boundary are unclear.

## Evidence

- The dependency is declared at `package.json:56`.
- Middleware and public URI configuration are at `src/server.ts:154-161`.
- The authentication bypass is at `src/server.ts:122-125`.
- README documents public monitoring at `README.md:104`.
- Docker health checking uses the status path at `Dockerfile:33-34`.

## Expected benefit

Health checks remain reliable while operational metrics are either removed, protected, or isolated
according to an explicit exposure policy.

## Dependencies/decisions

Decide between health-only status and a separately protected metrics surface. Preserve the Docker
health behavior and determine whether swagger-stats remains an approved dependency.

## Implementation notes

Separate liveness/readiness behavior from detailed monitoring if needed, restrict monitoring access
to the intended trust boundary, and update dependency and README guidance consistently.

The selected policy keeps only `GET /status` and `GET /status/` public, with a small JSON health
response. Unknown `/status/*` paths return `404` before proxy routing. swagger-stats remains an
intentional optional runtime dependency and, when enabled, uses the isolated `/metrics` namespace
for its UI, stats, metrics, and logout paths. The existing Basic Auth middleware protects all
metrics paths when credentials are configured. When monitoring is disabled, `/metrics` is reserved
and returns `404`; the Docker health check remains on `/status`.

## Validation plan

Test enabled and disabled monitoring, authenticated and unauthenticated status/metrics access, and
the Docker health check. Verify the selected monitoring contract without exposing request secrets.

## Definition of done

- Monitoring exposure and authentication policy are explicit.
- Health checks continue to work.
- Dependency, route, documentation, and regression evidence support the selected design.

## Implementation evidence

- `src/server.ts` provides the public health routes, blocks unknown `/status/*` paths, and configures
  swagger-stats under `/metrics` only when monitoring is enabled.
- `src/server.spec.ts` covers enabled/disabled monitoring, both public health forms, protected and
  authenticated metrics, status lookalikes, and the `/status` Docker health contract.
- `README.md` documents the exposure and authentication policy.
- Final validation: focused server tests (28 passed), full test suite (165 passed), Yarn lint,
  TypeScript, production build, Docker image build, and the built-container health check passed.
