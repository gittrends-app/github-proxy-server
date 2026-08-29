# Agent roadmap

## Mission and scope

This roadmap guides agents implementing the enhancement dossier in small, reviewable increments.
The mission is to improve security, correctness, operability, and developer experience without
changing unrelated behavior. The dossier itself is documentation-only; its recommendations are not
implemented by creating these files.

The numbered order in [README.md](./README.md) is the authoritative risk order. Dependencies can
make a later item wait for an earlier item even when the later item has a smaller isolated change.

## Status vocabulary

Use these statuses in recommendation frontmatter:

- `planned`: documented, not started, and not implemented.
- `in-progress`: an assigned implementation is actively being changed.
- `blocked`: work cannot proceed until a named dependency or decision is resolved.
- `implemented`: code and tests are complete, but the review gate is not yet closed.
- `verified`: review and required validation are complete, with evidence recorded.
- `deferred`: intentionally postponed with a reason and owner/decision recorded.

Every agent must update the relevant recommendation status as work changes. Do not mark an item
`implemented` or `verified` based only on documentation edits.

## Ordered phases and dependencies

1. **Baseline and security containment (01-03).** Redact secrets, reject partial authentication,
   and decide/enforce the exact status namespace. These are urgent and should precede public
   deployment changes.
2. **Contract corrections (04-06).** Standardize unsupported-method responses, forwarded metadata,
   and the package-manager/audit path. Item 05 should coordinate its trust decision with item 12;
   item 06 precedes optional documentation cleanup.
3. **Resource safety and configuration (07-10).** Fix lifecycle ownership, validate configuration,
   harden rate-limit refresh, and make errors/cancellation state-aware. Items 07 and 09 should land
   before architectural dispatch work; item 10 coordinates with request lifetime limits.
4. **Boundary and capacity work (11-13).** Decide monitoring exposure, correct HTTP forwarding,
   and bound bodies, queues, and request lifetime. Item 13 establishes limits needed by the
   dispatcher.
5. **Architecture (14).** Replace polling with an event-driven bounded dispatcher only after the
   lifecycle, refresh, cancellation, and queue-boundary contracts are stable.
6. **Optional cleanup (15).** Refresh documentation and developer experience after package-manager
   and CI decisions settle. It may be scheduled independently when it does not conflict with an
   active lane.

## Suggested roles and validation ownership

- **Explorer:** maps the exact implementation surface and existing tests; does not edit source.
- **Oracle:** resolves behavior, security, compatibility, and deployment decisions; records the
  rationale before implementation.
- **Fixer:** makes the smallest scoped code change and adds regression tests.
- **Librarian:** updates the relevant recommendation, README, changelog-style evidence, and status.
- **Designer:** owns layout, styling, visual hierarchy, responsive behavior, and animation when a
  user-facing design decision is required; do not assign those decisions to a code fixer.
- **Observer:** runs the assigned validation, watches regressions/resource behavior, and records
  command output or other evidence.

The orchestrator owns validation for this dossier and decides which checks are assigned for each
implementation. Agents must not silently broaden validation scope. The implementing agent reports
what was run and what was skipped; the observer/orchestrator records the authoritative result.

## Lane and write-scope rules

- One active implementation lane owns a recommendation and its directly related tests at a time.
- A lane may write only the source, tests, configuration, and documentation explicitly named by its
  recommendation. Ask the orchestrator before crossing lanes.
- The librarian may update the recommendation status and evidence, but must not rewrite unrelated
  recommendations.
- Do not combine security, dependency, dispatcher, or broad formatting rewrites in one change.
- Avoid broad rewrites and opportunistic refactors. Preserve unrelated behavior and existing APIs
  unless the recommendation explicitly requires a contract decision.
- Before editing, check for another active lane's files and coordinate overlapping paths, especially
  `src/router.ts`, `src/server.ts`, `src/cli.ts`, `README.md`, and CI/package files.

## Per-recommendation workflow

1. Read the relevant recommendation file, this roadmap, and the exact repository paths cited there.
2. Confirm the status is `planned`, identify dependencies, and obtain unresolved decisions from the
   orchestrator/oracle.
3. Set the item to `in-progress` and record the implementation lane and scope.
4. Make a focused change; avoid broad rewrites.
5. Add regression tests for the changed behavior, including security and boundary cases where
   applicable. Do not claim an item is done without tests unless the recommendation explicitly has
   no runtime behavior.
6. Run the validation assigned by the orchestrator and preserve command/result evidence.
7. Have the observer/orchestrator review the diff and gates. Set `implemented`, then `verified`
   only after the required review and validation are complete; otherwise record `blocked` or
   `deferred` with the reason.
8. Report changed files, tests, commands, failures/skips, and evidence. Update the recommendation
   status and implementation notes without altering historical evidence.

## Security and secret-redaction rules

- Never commit, print, paste, or include full GitHub tokens, passwords, authorization headers, or
  other credentials in source, tests, logs, issue text, or dossier evidence.
- Use placeholders and last-four-or-shorter representations only; tests must assert that secrets do
  not appear in errors or logs.
- Treat inbound Host and forwarded headers as untrusted until the selected trust policy says
  otherwise.
- Do not weaken authentication or expose monitoring to make tests or health checks pass.
- Redact command output and audit artifacts before reporting them. If a secret is encountered,
  stop, remove it from the working output, and notify the orchestrator.

## Required validation commands

Unless the orchestrator assigns a narrower set, the project validation baseline is:

```text
npm run lint
npx tsc --noEmit
npm test
npm run build
```

Use the repository's selected package manager after item 06 settles the path; CI currently invokes
the Yarn equivalents at `.github/workflows/ci.yml:37-38`, `54-56`, and `71-72`. For dependency work,
run the supported lockfile-aware audit command and record its limitations: Yarn previously reported
68 production advisories (1 critical, 24 high), while `npm audit` is unavailable without an npm
lockfile. Run focused tests in addition to, not instead of, the assigned baseline when the change
affects a specific path.

## Review gates

- **Scope gate:** only the named recommendation and its dependencies changed.
- **Security gate:** secrets remain redacted; authentication, status, trust, and monitoring exposure
  decisions are explicit.
- **Regression gate:** focused and required tests cover the changed contract.
- **Resource gate:** timers, listeners, sockets, queues, body memory, and cancellation have clear
  ownership where relevant.
- **Operational gate:** configuration, deployment, health checks, and package-manager instructions
  remain reproducible.
- **Evidence gate:** the recommendation status, validation commands, results, and known skips are
  recorded before verification.

## Definition of done

The dossier is complete when every recommendation has a deliberate status, implementation lanes
have respected the ordered dependencies and write scopes, planned work is not misrepresented as
implemented, relevant regression tests exist for runtime changes, assigned validation has been run
by the orchestrator or reported as skipped, review gates have passed, and agents have reported
concrete file and command evidence.
