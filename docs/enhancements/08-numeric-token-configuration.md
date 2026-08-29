---
id: 08
title: Validate numeric and token configuration at startup
status: planned
risk: moderate
urgency: normal
scope: CLI option parsing and credential validation
---

**Status:** Planned; not yet implemented.

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

## Validation plan

Test invalid and boundary values for every numeric option, supported token formats, duplicates, and
startup failure behavior. Run normal startup tests with default values.

## Definition of done

- All numeric configuration has finite, bounded validation.
- Supported token formats are explicitly defined and validated.
- Startup errors are safe, clear, tested, and reported.
