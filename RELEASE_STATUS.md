# Release status — 2026-10-02

The public GitHub prerelease is available. npm publication is **held**, not completed. The maintainer authorized publication after the remaining work is complete and explicitly waived the need for a second real Claude account. That waiver does not convert unexecuted tests to passes or waive the other remaining tasks.

## Ready

- Personal GitHub owner: `asuhacoder`; authenticated npm owner/scope: `asuha` / `@asuha`.
- Candidate: `@asuha/dsh-claude-model-provider@0.1.0-next.2`, intended dist-tag `next`.
- Immutable candidate SHA-256: `2ea519b5c2c19d846cf991ef5a2bac47f73fcc60cf58b227d55f42beca25cb24`.
- This exact tarball passed installation, real single-account generation and an authenticated npm dry run. The corrected workflow command also passed its dry run.
- The implementation passed 258 regression tests, unchanged coverage gates and three-OS CI. Follow-up evidence adds three short real model steps covering measurements, image input, foreign-provider fixture history, unsupported input and bounded idle behavior.
- Two-account L4 evidence remains unavailable and is waived as a release condition.

## Remaining conditions

| Item | Current boundary |
| --- | --- |
| Protected main / PR #1 | GitHub requires one approving review. The PR changes authentication/routing boundaries; no administrative override has been performed. The scheduled watcher and publish lane require main. |
| Independent repair deployment | Worker/verifier OS and network isolation, verifier key custody, a restricted publisher GitHub App and official client login are not provisioned. A local process fixture is not that service. |
| npm automated publisher | Local login works. The initial package and npm-side trusted publisher enrollment are still absent; OIDC/provenance have not been demonstrated by a real publication. |
| Browser verification | The browser's admin policy check denied access. Settings components, authenticated RPC and server startup are verified; the actual browser screen is not. |
| Other evidence | Full authenticated third-party-provider coexistence/roundtrip, server-effective effort, induced SDK compaction, longer idle/canary coverage and representative efficiency comparison remain incomplete. Exact acceptance IDs and scopes remain in `acceptance-results.json`. |

The predictor remains in shadow because the synthetic holdout contains regressions. No performance superiority or production-readiness claim is made. `latest` promotion additionally requires independent signed verification and the 24-hour canary; neither follows merely from npm login or elapsed time.

## Next publication action

Resolve the non-waived conditions, then publish the exact verified candidate to `next` and verify the registry's integrity and installed contents. Initial package creation may require npm's interactive authentication; enroll the protected GitHub-hosted publisher afterward. Do not silently disable provenance or weaken branch/environment rules to make the existing automation run. A narrower experimental release before all conditions are met requires an explicit change to the maintainer's publication condition.

Evidence: `evidence/npm-authenticated-rehearsal.json`, `evidence/live-acceptance.json`, `compatibility-evidence.json`.
