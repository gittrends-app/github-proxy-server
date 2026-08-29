---
id: 09
title: Harden rate-limit refresh against outages and malformed responses
status: planned
risk: moderate
urgency: high
scope: rate-limit fetching, parsing, refresh scheduling, and token workers
---

**Status:** Planned; not yet implemented.

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

## Validation plan

Test network failure, non-success responses, malformed JSON/resource data, backoff, stale state, and
successful refresh. Verify refresh fan-out and that no promise rejection is unhandled.

## Definition of done

- Refresh failures are contained, observable, and bounded by the selected retry policy.
- Valid responses update all required resource state from the intended refresh path.
- Tests cover outages and malformed responses with reported evidence.
