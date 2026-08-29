---
id: 06
title: Establish one reproducible package-manager and dependency-audit path
status: planned
risk: low/moderate
urgency: normal
scope: dependency manifests, lockfiles, CI, and container builds
---

**Status:** Planned; not yet implemented.

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

## Expected benefit

Fresh installs, CI, containers, and security audits use the same dependency resolution and produce
actionable results.

## Dependencies/decisions

Choose Yarn or npm consistently, including the committed lockfile, CI cache/install commands, and
Docker installation. Triage reachable advisories rather than treating the audit count alone as a
removal plan. Confirm dependency usage before removing anything.

## Implementation notes

Align manifests, lockfile handling, workflow commands, and Docker context/install instructions with
the selected package manager. Review the named dependencies and record why each remains or is removed.

## Validation plan

Run a clean install with the selected manager, CI-equivalent lint/build/test commands, container
build checks, and the supported audit command. Record the Yarn advisory caveat and do not claim npm
audit support without an npm lockfile.

## Definition of done

- One package manager and lockfile are authoritative across local, CI, and Docker paths.
- Reachable production advisories are triaged with evidence.
- Dependency usage decisions and reproducible install/audit results are reported.
