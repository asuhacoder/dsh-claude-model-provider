# Implementation and verification — 2026-10-02

This is an **experimental, incomplete implementation** of the supplied provider design. Source owner: `asuhacoder/dsh-session-provider`; package: `@asuhacoder/dsh-session-provider@0.1.0-next.1`. No npm publication has occurred. [Machine-readable acceptance](acceptance-results.json) tracks all 54 acceptance IDs separately; [compatibility evidence](compatibility-evidence.json) records the final artifact and actual execution scope.

## Working implementation

The unmodified official Claude SDK/CLI serves inference through DSH's LLM and managed subprocess services. DSH owns tools, results and history. The provider rejects alternate billing environments, uses official authentication status, stores only private profile references and salted identity hashes, and requires user confirmation that Extra usage is OFF. The source does not read credential files or Keychain records.

A persistent local store holds sticky bindings, quota windows, reservations and a tool receipt ledger. Only a confirmed quota block allows switching accounts, at a safe request boundary. Suspension, authentication failure and uncertain tool outcomes stop. Warm queries survive ordinary tool steps. Changed history/system/tools rebuild from DSH's canonical history; cold replay uses a user-role JSON envelope and does not claim native-role equivalence. No predictive optimizer or automatic account failback is active.

## Executed evidence

- TypeScript checking/build and 207 regression tests passed locally, including an independent 100-seed × 1,000-event sticky-state simulation and provider-boundary tests.
- Three operations policy tests and package lint passed.
- Real DSH `LlmRuntime` → managed process → official SDK text and no-op tool roundtrip passed. Each bounded smoke scenario used three model steps. The account-managed path also passed. These were source-build tests, not a signed live test of a published tarball.
- The control-only doctor initialized the SDK/MCP bridge and advertised no native tool, with zero model prompts. It reports a version warning because host CLI 2.1.283 differs from bundled SDK parity 2.1.286.
- Final packed clean-install/coexistence/removal results and hash are in `compatibility-evidence.json`. The fixture isolates HOME/DSH_HOME, uses the official plugin command and runtime resolver, and compares configuration before/after. It does not exercise authenticated Codex/Grok network routes or the complete WebUI.
- Synthetic routing latency covers 32 accounts and 1,000 selections only. It does not demonstrate subscription efficiency, completed-task throughput, TTFT or memory improvements.
- Coverage is measured separately from `pnpm verify`. The inherited 90% thresholds remain unchanged. See `compatibility-evidence.json` for the measured result; passing unit tests is not a coverage-gate pass.

## Work still required

1. Dedicated account-management WebUI, accurate per-account capability presentation, complete concurrency waiting and global circuit-breaker behavior.
2. Demand/reset/cache predictors, holdout comparisons, usage persistence/calibration and comparable live efficiency measurements.
3. Same-request pre-output quota continuation, complete race/fault matrix, live history/model/cancel scenarios, L3 real-account-plus-fake-peer harness, and L4 distinct-account isolation/continuation runner.
4. Watcher-to-new-tuple compatibility dispatch, isolated AI repair PR pipeline, independent protected verification, durable job deduplication, notifications and separate publisher deployment. Current workflows are keyless checks/metadata snapshots/package rehearsals; the repair worker is a launcher.
5. npm ownership/trusted publisher setup, independently verified release evidence, canary and promotion/rollback. No stable release readiness is claimed.

The second-account and npm-authentication gaps are external setup boundaries. The other items above are implementation/test gaps, not permission requests. The provided `test:live:multi` command currently returns BLOCKED and is not a completed L4 harness.

## Reproduction and recovery

Use Node 24.14.0 and pnpm 11.1.2, then run `pnpm install --frozen-lockfile --ignore-scripts`, `pnpm verify`, `pnpm test:ops`, `pnpm test:coexist`, and `pnpm release:dry-run`. The install test uses the exact tarball created by the release rehearsal when supplied via `--tarball`.

Run `node lib/provider-cli.js doctor --offline` without generation. An explicitly authorized short smoke is `node scripts/live-smoke.mjs --live --extra-usage-off --pooled`; it needs an account registered in the private validation state. The scripts deliberately do not change global login, global DSH configuration or an existing selected model.

See [bootstrap](BOOTSTRAP_CHECKLIST.md), [incident recovery](ops/incident-runbook.md), [repair deployment](ops/repair-runbook.md), and [service terms boundary](COMPLIANCE.md). Live evidence is summarized without transcripts, credentials, profile paths or organization identifiers.
