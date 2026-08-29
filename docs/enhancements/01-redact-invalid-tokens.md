---
id: 01
title: Redact invalid tokens from errors
status: planned
risk: very-low
urgency: urgent
scope: error reporting and token validation
---

**Status:** Planned; not yet implemented.

## Problem

An invalid GitHub token is included in an emitted error message, allowing secret material to reach
logs and error listeners.

## Evidence

- The full token is interpolated in `src/router.ts:223-227`.
- The error is forwarded by `src/router.ts:399-401` and `src/server.ts:169-170`.
- CLI error handling exposes the event at `src/cli.ts:116-119`.
- A safer last-four-character logging pattern already exists at `src/router.ts:249-259`.

## Expected benefit

Invalid credentials can be diagnosed without exposing the token in logs, events, or CLI output.

## Dependencies/decisions

Use the existing last-four pattern or an equivalent fixed redaction. Decide whether tests should
assert that the complete token never occurs in emitted errors.

## Implementation notes

Replace the full-token interpolation with a redacted representation and preserve the invalid-token
signal and existing error propagation. Do not change token values used for authentication.

## Validation plan

Add a regression test for invalid-token error emission that checks the full token is absent and the
diagnostic redaction remains useful. Run the required project checks in the roadmap.

## Definition of done

- No invalid-token error contains the full token.
- Existing error forwarding and invalid-token behavior remain intact.
- Regression coverage and validation evidence are reported.
