---
id: 01
title: Redact invalid tokens from errors
status: verified
risk: very-low
urgency: urgent
scope: error reporting and token validation
---

**Status:** Verified; implementation and validation complete.

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

## Verification evidence

- `src/router.ts` now emits only the token's last four characters in the diagnostic while preserving
  the full token as the event argument used for token removal.
- `src/router.spec.ts` verifies that invalid-token errors omit the complete token and retain the
  redacted suffix.
- `npx vitest run src/router.spec.ts`: passed (16 tests).
- `npm run lint`: passed.
- `npx tsc --noEmit`: passed.
- `npm test`: passed (111 tests).
- `npm run build`: passed.
