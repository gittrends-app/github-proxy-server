---
id: 15
title: Documentation and developer-experience cleanup
status: verified
risk: low
urgency: optional
scope: README, CLI help, package-manager guidance, hooks, and Biome configuration
---

**Status:** Verified; final review and validation are complete. **Priority:** Optional cleanup.

## Problem

Project documentation and developer tooling contain small consistency and clarity gaps that can
mislead contributors or operators, but do not require product behavior changes.

## Evidence

- The README badge is at `README.md:3`.
- Package-manager commands are at `README.md:49-55`.
- CLI help text includes the relevant wording at `src/cli.ts:112-116`.
- The synchronized CLI help snapshot appears at `README.md:133-157`.
- The pre-commit hook is at `.husky/pre-commit:1-2`.
- Limited Biome rules are configured at `biome.json:25-33`.

## Expected benefit

Contributors get accurate commands, clearer help, and consistent automated feedback with less setup
friction.

## Dependencies/decisions

Apply this cleanup after the package-manager decision in item 06 and any CI policy decisions in the
earlier items. Keep scope limited to documentation and developer-experience consistency.

## Implementation notes

The README now references the existing `ci.yml` workflow, uses Yarn 1.22.22 with Node.js >=24, and
documents frozen installation, test, lint, typecheck, build, and pre-commit checks. CLI help wording
was corrected without changing option names, defaults, parsing, or runtime behavior. The hook now
uses the same Yarn commands as the contributor instructions. The Biome schema URL matches the
locked Biome 2.3.11 tool, while its intentionally limited `noConsole` and `noExplicitAny` rules are
unchanged. No dependencies, workflows, public options, or product behavior were changed.

## Validation plan

Verified with Yarn 1.22.22 and Node.js v24.19.0 using `yarn test`, `yarn lint`, `npx tsc --noEmit`,
`yarn build`, `node dist/cli.js --help`, and `git diff --check`. The generated help output was
compared with the synchronized README snapshot; the full test suite passed with 232 tests.

## Definition of done

- README, CLI help, hooks, and Biome guidance are internally consistent.
- Documented commands are reproducible.
- Changes remain limited to optional cleanup and evidence is reported.
