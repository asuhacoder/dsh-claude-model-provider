# Release status — 2026-10-02

`@asuha/dsh-claude-model-provider@0.1.0-next.3` is published as an experimental [GitHub prerelease](https://github.com/asuhacoder/dsh-claude-model-provider/releases/tag/v0.1.0-next.3) under personal account `asuhacoder`. The actual active DSH Web profile now uses that public release URL instead of a local file. A real Claude Opus response and a DSH-owned file read both passed after installation and restart. All 159 installed package files match the immutable release tarball; five existing provider groups and 53 pre-existing sessions were preserved.

**npm publication is not complete.** Account `asuha` is authenticated, but publishing requires an additional npm Web authentication. Browser automation could not verify its admin-enforced policy and was not used to bypass that check. The official npm CLI challenge expired without completion. After maintainer authentication, publish the same tarball with `--tag next`, replace the active Web dependency with the npm registry version, and repeat the response/tool checks. The GitHub URL installation is usable while this step remains pending.

The maintainer authorized an experimental release after verification in the actual active DSH. PR approval and real two-account testing are not release prerequisites. This supersedes the previous all-other-tasks hold; remaining limitations are still reported honestly. PRs #1 and #2 are merged, and all five required CI checks passed. PR approval is no longer required; CI protections remain enabled.

The active profile exposed a model catalog bug for models without effort options. The fix passed 260 tests, typecheck/build and the unchanged coverage thresholds (statements 94.76%, branches 90.33%, functions 94.86%, lines 96.56%). Empty-profile installation, Subscription Plugin composition, runtime module identity and removal/recovery passed. Existing provider network routes were not tested.

Artifact SHA-256: `f213f6a5621fad29593ba3885bbd4c2f33403bf1df6c774b487ac41eaf4b62ab`.
Source commit: `a3e57eb3ce6ee09c04037a1aaf2903043b05b348`.
Publication and installation evidence is recorded separately so the verified tarball remains immutable. Post-publication documentation commits do not replace that artifact.

Evidence: [active DSH](evidence/active-web-github-next3.json), [GitHub publication](evidence/github-publication-next3.json), [isolated installation](evidence/coexist-next3.json), [CI](https://github.com/asuhacoder/dsh-claude-model-provider/actions/runs/36914865274).

Initial npm publication uses the authenticated local maintainer and will not create npm provenance. The local build signature is not independent verification. npm-side trusted publishing/OIDC enrollment remains a separate follow-up after initial package creation.

The predictor remains shadow-only. Real two-account isolation, independent production repair infrastructure, full third-party network coverage, server-effective effort, forced SDK compaction, visual browser testing, representative efficiency measurements and a 24-hour canary remain unverified. These limitations do not block the specifically authorized experimental release and do not imply stable readiness or superiority. No `latest` promotion is intended.
