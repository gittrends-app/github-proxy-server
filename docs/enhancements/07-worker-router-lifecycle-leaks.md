---
id: 07
title: Fix worker and router lifecycle leaks
status: planned
risk: low/moderate
urgency: normal
scope: worker timers, queues, agents, listeners, and shutdown
---

**Status:** Planned; not yet implemented.

## Problem

Worker and router lifecycle paths can leave timers, queues, agents, or listeners alive, and router
destruction mutates the collection being traversed.

## Evidence

- Router destruction mutates `clients` during `forEach` at `src/router.ts:461-463`.
- Refresh intervals are created and discarded at `src/router.ts:404-406`.
- Worker cleanup is at `src/router.ts:289-297`.
- Each worker creates its own Agent at `src/router.ts:101-112`.
- The global listener limit is raised at `src/cli.ts:90`.
- CLI shutdown currently closes only the server at `src/cli.ts:152-161`.

## Expected benefit

Repeated setup/teardown, token changes, tests, and process shutdown release resources predictably
without masking listener growth.

## Dependencies/decisions

Define ownership for refresh timers, workers, Agents, and the router; decide whether an Agent is
shared or explicitly closed. Coordinate with rate-limit refresh and dispatcher changes.

## Implementation notes

Track every timer and resource that must be disposed, destroy workers before removing collection
entries or iterate over a stable snapshot, and make CLI shutdown destroy the router as well as the
HTTP server. Avoid using a global listener limit as lifecycle management.

## Validation plan

Add lifecycle tests for add/remove/destroy and repeated startup/shutdown, including timer cleanup
and queue cancellation. Check listener/resource behavior without relying on a raised global limit.

## Definition of done

- Router and worker teardown is idempotent and complete.
- Refresh timers, queues, Agents, and listeners have defined ownership and cleanup.
- Regression tests demonstrate no skipped clients or retained lifecycle resources.
