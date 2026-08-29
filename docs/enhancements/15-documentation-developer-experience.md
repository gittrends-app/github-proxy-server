---
id: 15
title: Documentation and developer-experience cleanup
status: planned
risk: low
urgency: optional
scope: README, CLI help, package-manager guidance, hooks, and Biome configuration
---

**Status:** Planned; not yet implemented. **Priority:** Optional cleanup.

## Problem

Project documentation and developer tooling contain small consistency and clarity gaps that can
mislead contributors or operators, but do not require product behavior changes.

## Evidence

- The README badge is at `README.md:3`.
- Package-manager commands are at `README.md:49-55`.
- CLI help text includes the relevant wording at `src/cli.ts:64` and `src/cli.ts:68`.
- README wording appears at `README.md:118-120`.
- The pre-commit hook is at `.husky/pre-commit:1-2`.
- Limited Biome rules are configured at `biome.json:25-33`.

## Expected benefit

Contributors get accurate commands, clearer help, and consistent automated feedback with less setup
friction.

## Dependencies/decisions

Apply this cleanup after the package-manager decision in item 06 and any CI policy decisions in the
earlier items. Keep scope limited to documentation and developer-experience consistency.

## Implementation notes

Refresh stale badges and package commands, correct CLI/README wording, review hook behavior, and
document only Biome rules that the project intentionally supports. Do not use this item to hide
failures or perform a broad formatting rewrite.

## Validation plan

Verify every documented command against the selected package manager, inspect CLI help output, and
run the existing hook/lint checks after any configuration change.

## Definition of done

- README, CLI help, hooks, and Biome guidance are internally consistent.
- Documented commands are reproducible.
- Changes remain limited to optional cleanup and evidence is reported.
