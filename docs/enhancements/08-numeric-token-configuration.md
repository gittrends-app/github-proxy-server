---
id: 08
title: Validate numeric and token configuration at startup
status: verified
risk: moderate
urgency: normal
scope: CLI option parsing and credential validation
---

**Status:** Verified; review and final validation are complete.

## Problem

Numeric CLI values are parsed directly, while token validation applies a hard 40-character rule
that may not describe all supported GitHub credential formats.

## Evidence

- Number parsers are used at `src/cli.ts:30-35` and `src/cli.ts:47-57`.
- The multiplier parser is at `src/cli.ts:18-24`, with its option at `src/cli.ts:58-63`.
- Router options are applied at `src/router.ts:352-359`.
- The hard 40-character token rule is at `src/server.ts:80-84` and is also described in
  `AGENTS.md:183-186`.

## Expected benefit

Invalid, non-finite, negative, or unsafe operational settings fail at startup, while valid GitHub
credential formats are accepted deliberately.

## Dependencies/decisions

Define supported GitHub credential formats and bounded validation for opaque tokens. Set valid
ranges and defaults for port, timeout, minimum remaining requests, and multiplier.

## Implementation notes

Introduce explicit parsers/validators with clear option-specific errors. Keep secrets out of error
messages and preserve the selected credential-format policy in operator documentation.

The supported numeric ranges are port `0..65535`, request timeout `1..120000` milliseconds, minimum
remaining `0..5000`, and time-budget multiplier `1..10`. Integer settings must be safe integers;
the multiplier also accepts finite decimal values. Supported credentials are legacy 40-character
alphanumeric credentials, `ghp_`, `gho_`, `ghu_`, `ghs_`, and `ghr_` credentials with 36-character
alphanumeric suffixes, and `github_pat_` credentials with an 82-character alphanumeric/underscore
suffix.

## Validation plan

Test invalid and boundary values for every numeric option, supported token formats, duplicates, and
startup failure behavior. Run normal startup tests with default values.

## Definition of done

- All numeric configuration has finite, bounded validation.
- Supported token formats are explicitly defined and validated.
- Startup errors are safe, clear, tested, and reported.

## Implementation evidence

- `src/router.ts` provides shared numeric and credential validators for direct router configuration.
- `src/cli.ts` applies option-specific parsers to flags and environment-backed values.
- `src/server.ts` validates direct server options and delegates credential validation consistently.
- `src/cli.spec.ts` and `src/server.spec.ts` cover numeric boundaries, malformed values, credential
  formats, duplicates, and startup validation failures.
- Final validation: focused CLI/server/router tests (119 passed), full test suite (146 passed), Yarn
  lint, TypeScript, and production build passed.
