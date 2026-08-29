---
id: 06
title: Establish one reproducible package-manager and dependency-audit path
status: verified
risk: low/moderate
urgency: normal
scope: dependency manifests, lockfiles, CI, and container builds
---

**Status:** Verified; parent review and validation are complete.

## Problem

Local, CI, and Docker dependency installation paths are inconsistent, making installs and advisory
triage less reproducible.

## Evidence

- The tracked Yarn lockfile is excluded by `.dockerignore:6`.
- CI uses Yarn at `.github/workflows/ci.yml:37`, `54`, and `71`.
- Docker forces npm in `.dockerignore`/`Dockerfile:4-8`, `23-25`.
- Direct dependencies are listed in `package.json:46-58`.
- `dotenv-override-true` and `https-proxy-agent` are likely unused; `ip` is used only for host
  display (`package.json:49`, `src/cli.ts:9`, `127`).
- `swagger-stats@0.99.7` requires the runtime peer `prom-client`; `prom-client@^14.2.0` is now a
  direct production dependency so the Yarn Classic production image includes it.

## Expected benefit

Fresh installs, CI, containers, and security audits use the same dependency resolution and produce
actionable results.

## Dependencies/decisions

Yarn Classic is authoritative because the repository already tracks `yarn.lock`, CI already uses
Yarn, and the existing developer instructions use Yarn. `package.json` pins the package manager to
`yarn@1.22.22`; installs use the lockfile without rewriting it. Docker and CI enable Corepack before
running the same frozen install.

Triage confirmed that `dotenv-override-true` and `https-proxy-agent` have no source imports, so they
were removed from the manifest and lockfile. `ip` remains because `src/cli.ts` uses `ip.address()`
to display the listening host. Yarn still reports the known `ip` advisory: it has no patched release,
and this application does not call the affected `isPublic` API. No source change was required.

## Implementation notes

Aligned the manifest, Yarn lockfile, Docker build context/install commands, and all CI install steps
with Yarn Classic. The Docker context now includes `yarn.lock`; dependency and release stages both
use `yarn install --frozen-lockfile`, with production dependencies selected in the release stage.
CI uses the same frozen install in each job and retains setup-node's Yarn cache.

The dependency-only Yarn audit completed with 182 packages and reported 68 advisories (8 low,
35 moderate, 24 high, and 1 critical). The remaining findings are primarily transitive packages
used by `swagger-stats` and the existing direct `lodash`, `undici`, and `ip` dependencies. This is
an audit baseline and triage record, not a claim that all upstream advisories are fixed; Yarn Classic
reports advisories but does not provide a general automatic remediation path. `npm audit` remains
unsupported because no npm lockfile is authoritative.

## Validation plan

Run a clean/frozen install with Yarn, CI-equivalent lint/build/test commands, container build checks,
and `yarn audit --groups dependencies`. Record the Yarn advisory caveat and do not claim npm audit
support without an npm lockfile.

Implementation checks:

- `yarn install --ignore-scripts`: passed and regenerated the lockfile after removing the two unused
  dependencies.
- `yarn install --frozen-lockfile --ignore-scripts`: passed.
- `yarn audit --groups dependencies`: completed with exit code 30 because of the non-zero advisory
  result above.
- `npm audit`: not run; npm has no authoritative lockfile in this repository.
- `git diff --check`: passed.
- Parent validation: Yarn lint, TypeScript, all 120 tests, production build, Docker image build, and
  the built-container health check passed.

## Definition of done

- One package manager and lockfile are authoritative across local, CI, and Docker paths.
- Reachable production advisories are triaged with evidence.
- Dependency usage decisions and reproducible install/audit results are reported.
