# Enhancement dossier

This dossier records the project-improvement recommendations from the prior analysis. It expands the
earlier grouped analysis into 15 actionable work items, ordered from lowest to highest implementation
risk. Recommendations 01 through 07 are **verified**; recommendations 08 through 15 are currently
**planned**.

## Project baseline

The verified baseline from the prior analysis is:

- Lint passed.
- Production type-check passed.
- Tests passed: **110/110**.
- Dependency audit caveat: Yarn reported **68 production advisories**, including **1 critical** and
  **24 high**. `npm audit` is unavailable without an npm lockfile.

These findings describe implementation and regression risk, not issue severity. A low-risk item can
still address a serious security concern; conversely, a high-risk item is high because changing it
may affect behavior broadly, not because the underlying issue is necessarily severe.

## Recommendations

| # | Recommendation | Risk | Urgency |
| ---: | --- | --- | --- |
| 01 | [Redact invalid tokens from errors](./01-redact-invalid-tokens.md) | Very low | Urgent |
| 02 | [Fail closed for partial authentication](./02-partial-authentication.md) | Very low | Urgent |
| 03 | [Tighten the exact status exception](./03-exact-status-exception.md) | Very low | Urgent |
| 04 | [Correct standard unsupported-method responses](./04-standard-unsupported-method-responses.md) | Low | Normal |
| 05 | [Correct forwarded metadata](./05-forwarded-metadata.md) | Low | Normal |
| 06 | [Establish one package-manager and audit path](./06-package-manager-audit-path.md) | Low/moderate | Normal |
| 07 | [Fix worker/router lifecycle leaks](./07-worker-router-lifecycle-leaks.md) | Low/moderate | Normal |
| 08 | [Validate numeric and token configuration](./08-numeric-token-configuration.md) | Moderate | Normal |
| 09 | [Harden rate-limit refresh](./09-rate-limit-refresh.md) | Moderate | High |
| 10 | [Make proxy errors and cancellation state-aware](./10-state-aware-proxy-errors-cancellation.md) | Moderate | High |
| 11 | [Replace or isolate swagger-stats monitoring](./11-swagger-stats-monitoring.md) | Moderate | Normal |
| 12 | [Correct HTTP forwarding semantics](./12-http-forwarding-semantics.md) | Moderate/high | High |
| 13 | [Bound body, queue, and request lifetime](./13-body-queue-request-lifetime.md) | High | High |
| 14 | [Use an event-driven bounded dispatcher](./14-event-driven-dispatcher.md) | Highest | Normal |
| 15 | [Documentation and developer-experience cleanup](./15-documentation-developer-experience.md) | Low | Optional |

## Reading and execution guidance

Read [AGENT-ROADMAP.md](./AGENT-ROADMAP.md) before implementing any item. Each recommendation
contains the evidence, decisions, implementation notes, validation plan, and definition of done
needed for a focused change. The numeric order is authoritative for filenames and index order;
dependencies may require waiting for an earlier item before starting a later one.
