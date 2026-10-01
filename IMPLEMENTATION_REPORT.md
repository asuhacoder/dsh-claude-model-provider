# Implementation and verification — next.2

Personal GitHub: `asuhacoder/dsh-claude-model-provider`. The current package is `@asuha/dsh-claude-model-provider@0.1.0-next.2`; the original next.1 artifact used `@asuhacoder`. npm has not been published. This is an experimental provider with explicit external verification boundaries, not a stable-production claim. All 54 original acceptance IDs remain individually tracked in [acceptance-results.json](acceptance-results.json).

## Implemented

- Official SDK/CLI inference under DSH-owned tools/history; subscription authentication and Extra usage confirmation, with paid-overage signals stopping generation.
- Transactional sticky bindings, identity deduplication, scoped quota windows, abortable session and account queues, deadlines, generation fences, safe pre-output quota continuation, bounded retries and a persisted provider circuit.
- Tool receipt ledger: committed DSH results allow continuation; unknown outcomes stop. Account changes never reuse another account's SDK session. Cancellation while queued does not cancel an earlier request.
- SDK usage persisted per account and attempt, including failed work; separate cache counters, TTFT and retry observations. Completed responses are not mislabeled as accepted tasks.
- DSH settings screen for connecting/removing/verifying official profiles, optional official login, account preference, verified model/effort catalog, quota unknowns/reset/observation times, active requests and usage. No credential fields or custom OAuth callback.
- Read-only diagnostics while the provider is active; explicit dead-PID lock recovery. One local writer remains the supported topology.
- Deterministic quota calibration and bounded demand/reset/cold-cost simulation, 50ms fallback and holdout comparisons. The predictor remains shadow-only: the synthetic holdout includes regressions. Real debit learning is not claimed without isolated comparable observations.
- Watcher-to-pinned-candidate compatibility workflow, bounded repair orchestration and dedup/cooldown policy, protected verifier evidence, scoped draft publisher contract, exact-artifact npm-next OIDC lane, and promotion/rollback policy.

## Executed evidence

`pnpm typecheck`, the regression suite, unchanged 90% coverage gates, `pnpm test:ops`, package build/lint and packed installation/coexistence/removal have been run. Exact results and artifact hashes are recorded separately in `compatibility-evidence.json` and `evidence/`.

The new live matrix used nine short model steps on one real account: edited history, changed system prompt, changed tool catalog, DSH permission denial, explicit model change, cancellation and recovery, process restart and portable history. A temporary external project configuration supplied instruction/hook/MCP canaries; none executed. The canonical remembered value survived the edit and restart. Another one-step L3 hybrid check crossed a fixture quota boundary from the real account to a fake peer, carried a committed tool receipt and did not fail back after reset. This is clearly labeled L3, not evidence of two real identities.

The local repair E2E creates a real Git fixture, introduces an upstream signature break, runs a separate worker process and verifies the candidate against unchanged tests in a separate directory. Fault tests reject test/permission tampering, fake PASS and secret/network payloads. This demonstrates the orchestration and policy; separate local processes are not claimed as an OS isolation boundary. A bounded direct official SDK coding-client probe runs independently of this provider.

## Remaining external and evidence boundaries

- npm scope authentication and trusted-publisher enrollment are not available. Publication remains blocked; the next lane and dry run are implemented.
- A second real Claude identity is not available. The L4 runner is implemented, requires two profile references and rechecks official identities before/after inference; it returns BLOCKED with zero inference when absent or duplicated.
- Production isolation for untrusted repair candidates, verifier signing-key custody and a restricted publisher GitHub App require deployment. The local fixture/policy tests do not substitute for that deployment.
- No 24-hour canary, account exhaustion load test, induced real SDK compaction, complete authenticated third-party-provider network matrix, or superior real subscription-efficiency claim is made. These exceed the completed short connectivity checks. Cold replay remains a user-role context envelope, not native multi-role replay.

## Reproduction

Node 24.14.0 and pnpm 11.1.2. Install with lifecycle scripts disabled, then use `pnpm verify`, `pnpm test:coverage`, `pnpm test:ops`, `pnpm bench:forecast`, `pnpm test:coexist`, and `pnpm release:dry-run`. Live commands require both `--live` and `--extra-usage-off`: `scripts/live-matrix.mjs`, `scripts/live-hybrid.mjs`, `scripts/live-multi.mjs`, and `scripts/live-repair-client.mjs`. They record sanitized summaries, not credentials, account identifiers, private profile paths or conversation bodies.
