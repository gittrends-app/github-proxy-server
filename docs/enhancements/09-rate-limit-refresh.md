---
id: 09
title: Harden rate-limit refresh against outages and malformed responses
status: verified
risk: moderate
urgency: high
scope: rate-limit fetching, parsing, refresh scheduling, and token workers
---

**Status:** Verified; review and final validation are complete.

## Problem

Rate-limit refresh fetches and parses remote data without a resilient failure policy. Initial and
interval refresh promises are not handled, and each token creates four refresh streams.

## Evidence

- Fetch and response parsing are at `src/router.ts:216-235`.
- Initial and interval refresh handling is at `src/router.ts:399-406`.
- Four workers per token, each with refresh behavior, are created at `src/router.ts:394-409`.

## Expected benefit

GitHub outages or malformed responses do not produce unhandled failures or unsafe scheduling, and
refresh traffic is reduced without losing resource-specific state.

## Dependencies/decisions

Define stale-state behavior, retry/backoff limits, malformed-response handling, and whether one
`/rate_limit` response should fan out to all resource workers for a token.

## Implementation notes

Handle fetch, HTTP, JSON, and resource-shape failures explicitly. Centralize or coordinate refresh
per token, preserve safe stale values, and emit actionable redacted diagnostics.

The implementation makes up to three attempts per token refresh, with 250ms then 500ms bounded
backoff (capped at 2000ms). A successful response must contain validated `core`, `search`,
`code_search`, and `graphql` resources before any worker state changes. Failed refreshes retain
previous values, report only the token suffix, and detached initial/interval refreshes are contained.
Manual refreshes reject on failure and emit `ready` only after all tokens refresh successfully; a
single in-flight refresh is coalesced per token and its response is fanned out to all four workers.
Each attempt uses an item-09-owned `AbortController` bounded by the configured request timeout.
Each client owns its active controller, attempt timeout, and retry timer; token removal and router
destruction cancel and await that work, preventing later fetches or diagnostics for removed tokens.

## Validation plan

Test network failure, non-success responses, malformed JSON/resource data, backoff, stale state, and
successful refresh. Verify refresh fan-out and that no promise rejection is unhandled.

## Definition of done

- Refresh failures are contained, observable, and bounded by the selected retry policy.
- Valid responses update all required resource state from the intended refresh path.
- Tests cover outages and malformed responses with reported evidence.

## Implementation evidence

- `src/router.ts` centralizes one validated `/rate_limit` fetch per token, bounded retry/backoff,
  stale-state preservation, coalescing, worker fan-out, abortable attempt timeouts, and per-client
  retry-timer cleanup within the item 07 ownership model.
- `src/router.spec.ts` covers fan-out, coalescing, retry bounds, stale values, malformed responses,
  manual failure behavior, destruction during refresh, removed-token cancellation, retry recovery,
  and one-fetch-per-token behavior across multiple tokens.
- Final validation: focused router tests (35 passed), full test suite (155 passed), Yarn lint,
  TypeScript, and production build passed.
