# Release status — 2026-10-03

## Current candidate: 0.1.0-next.5

This version promotes the interruption repair previously tested as the unpublished `0.1.0-next.4.local.2` build. npm publication is pending maintainer authentication. It must be published under `next`, without assigning `latest`. `publishConfig.tag` now defaults to `next`; local maintainer publication explicitly disables provenance rather than claiming an unavailable CI attestation.

The repair source is commit `d2ac12e1bfc5d7977525db76da1018a489ed2051`. Fresh local verification on October 3 passed 281 tests, typecheck, build, coverage thresholds and nine operations tests. Coverage: statements 94.72%, branches 90.43%, functions 95.10%, lines 96.68%. The predecessor's real-account tests covered 14 source requests and three installed-package requests, including mixed-notification recovery and warm continuation. These historical results do not claim live testing of the newly versioned artifact. Final artifact installation and publication are recorded separately.

Public versions increment the prerelease counter (`next.3`, `next.4`, `next.5`) under the planned `0.1.0` release. Each published version is immutable and must map to one source revision and exact tarball. Local-only suffixes are not public release versions. `next` is the experimental npm channel; `latest` is reserved for a separately approved stable release. As checked on October 3 before publication, npm still points both `next` and `latest` at `next.3`; the stale `latest` tag requires authenticated cleanup.

The browser client is intentionally loaded by the DSH browser module loader. publint reports its existing CommonJS/browser wrapper as incompatible with a direct Node ESM import; direct Node import of the browser client is not a supported usage. The provider and installed management CLI are verified separately.

## Current display fix: 0.1.0-next.4

[Version 0.1.0-next.4](https://github.com/asuhacoder/dsh-claude-model-provider/releases/tag/v0.1.0-next.4) is published as a GitHub prerelease and installed from that public release URL in the active DSH Web profile. [PR #5](https://github.com/asuhacoder/dsh-claude-model-provider/pull/5) is merged after all five required CI jobs passed.

The picker and settings use official model names, versions, descriptions and order. The current account reports Claude Opus 5.5, Claude Fable 5.1, Claude Sonnet 5.5 and Claude Haiku 4.5, followed by older versioned models. The provider label is Claude Subscription. The duplicate default row is removed while legacy default selections remain resolvable. Older saved accounts retain compatibility and can update their metadata with Check connection.

Validation: 263 tests, typecheck, build, coverage and required CI passed. The active DSH catalog and a real Claude response passed. All 59 sessions and four provider groups present immediately before this update were preserved. All 163 installed package files match the public artifact. The original global default model, configuration and other plugin dependencies were restored/verified unchanged after the smoke test. Visual browser verification was not performed.

SHA-256: `7b643c0d58d1b56b919c682e92d113605a5df33759597d05a2742cbb059cc239`; implementation commit: `9dd0bdd`.

npm publication was attempted with the authenticated maintainer account, but npm requires an additional Web authentication for this publish. It is pending; the active DSH already uses the published GitHub package. The earlier npm latest-tag cleanup below is also still pending. Release verification details are attached as `next4-verification.json` to the GitHub release.

## Previous npm release: 0.1.0-next.3

`@asuha/dsh-claude-model-provider@0.1.0-next.3` is published on [npm](https://www.npmjs.com/package/@asuha/dsh-claude-model-provider/v/0.1.0-next.3) with the `next` tag and as a [GitHub prerelease](https://github.com/asuhacoder/dsh-claude-model-provider/releases/tag/v0.1.0-next.3), using personal accounts `asuha` and `asuhacoder`.

The actual active DSH Web profile now depends on the exact npm version `0.1.0-next.3`, replacing the temporary GitHub release URL and local artifact installations. After restart, a real Claude Opus response and a DSH-owned file read both passed. All 159 installed package files match the published tarball. Configuration and other plugin dependencies were unchanged; all 56 sessions and six provider groups present immediately before the npm switch were preserved. The original pre-integration baseline of 53 sessions and five provider groups was also preserved during initial integration.

npm publication, active DSH installation and post-installation verification are complete. **One release-metadata task remains:** npm automatically added `latest` during the initial staged publication, even though the publish command specified `--tag next`. Both `next` and `latest` currently point to this prerelease. Removal of `latest` requires separate npm Web authentication; the first authentication wait expired without completion. The package remains explicitly experimental and has not met the stable-release gate.

PRs #1 and #2 implemented the integration and catalog fix, and PR #3 recorded the GitHub release verification. All required CI checks passed before merging. Human PR approval is not required; the five CI protections remain enabled.

The model catalog fix passed 260 tests, typecheck/build and unchanged coverage thresholds (statements 94.76%, branches 90.33%, functions 94.86%, lines 96.56%). Empty-profile installation, Subscription Plugin composition, runtime module identity and removal/recovery passed. Existing provider network routes were not tested.

Artifact SHA-256: `f213f6a5621fad29593ba3885bbd4c2f33403bf1df6c774b487ac41eaf4b62ab`.
Source commit: `a3e57eb3ce6ee09c04037a1aaf2903043b05b348`.
The npm registry SHA-512 integrity and downloaded tarball bytes were checked against that immutable artifact. Publication and installation evidence is recorded separately; post-publication documentation commits do not replace the released tarball.

Evidence: [npm publication](https://github.com/asuhacoder/dsh-claude-model-provider/blob/main/evidence/npm-publication-next3.json), [active DSH npm installation](https://github.com/asuhacoder/dsh-claude-model-provider/blob/main/evidence/active-web-npm-next3.json), [isolated installation](https://github.com/asuhacoder/dsh-claude-model-provider/blob/main/evidence/coexist-next3.json), [source CI](https://github.com/asuhacoder/dsh-claude-model-provider/actions/runs/36914865274).

Initial npm publication used the authenticated local maintainer and has no npm provenance. The local build signature is not independent verification. npm trusted publishing/OIDC enrollment remains a separate follow-up.

The predictor remains shadow-only. Real two-account isolation, independent production repair infrastructure, full third-party network coverage, server-effective effort, forced SDK compaction, visual browser testing, representative efficiency measurements and a 24-hour canary remain unverified. The maintainer explicitly authorized this experimental release without waiting for a second account or those historical acceptance items. They remain unverified in the acceptance record and are not represented as passed.
