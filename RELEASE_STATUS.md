# Release status — 2026-10-02

`@asuha/dsh-claude-model-provider@0.1.0-next.3` is published on [npm](https://www.npmjs.com/package/@asuha/dsh-claude-model-provider/v/0.1.0-next.3) with the `next` tag and as a [GitHub prerelease](https://github.com/asuhacoder/dsh-claude-model-provider/releases/tag/v0.1.0-next.3), using personal accounts `asuha` and `asuhacoder`.

The actual active DSH Web profile now depends on the exact npm version `0.1.0-next.3`, replacing the temporary GitHub release URL and local artifact installations. After restart, a real Claude Opus response and a DSH-owned file read both passed. All 159 installed package files match the published tarball. Configuration and other plugin dependencies were unchanged; all 56 sessions and six provider groups present immediately before the npm switch were preserved. The original pre-integration baseline of 53 sessions and five provider groups was also preserved during initial integration.

npm publication, active DSH installation and post-installation verification are complete. **One release-metadata task remains:** npm automatically added `latest` during the initial staged publication, even though the publish command specified `--tag next`. Both `next` and `latest` currently point to this prerelease. Removal of `latest` requires separate npm Web authentication; the first authentication wait expired without completion. The package remains explicitly experimental and has not met the stable-release gate.

PRs #1 and #2 implemented the integration and catalog fix, and PR #3 recorded the GitHub release verification. All required CI checks passed before merging. Human PR approval is not required; the five CI protections remain enabled.

The model catalog fix passed 260 tests, typecheck/build and unchanged coverage thresholds (statements 94.76%, branches 90.33%, functions 94.86%, lines 96.56%). Empty-profile installation, Subscription Plugin composition, runtime module identity and removal/recovery passed. Existing provider network routes were not tested.

Artifact SHA-256: `f213f6a5621fad29593ba3885bbd4c2f33403bf1df6c774b487ac41eaf4b62ab`.
Source commit: `a3e57eb3ce6ee09c04037a1aaf2903043b05b348`.
The npm registry SHA-512 integrity and downloaded tarball bytes were checked against that immutable artifact. Publication and installation evidence is recorded separately; post-publication documentation commits do not replace the released tarball.

Evidence: [npm publication](evidence/npm-publication-next3.json), [active DSH npm installation](evidence/active-web-npm-next3.json), [isolated installation](evidence/coexist-next3.json), [source CI](https://github.com/asuhacoder/dsh-claude-model-provider/actions/runs/36914865274).

Initial npm publication used the authenticated local maintainer and has no npm provenance. The local build signature is not independent verification. npm trusted publishing/OIDC enrollment remains a separate follow-up.

The predictor remains shadow-only. Real two-account isolation, independent production repair infrastructure, full third-party network coverage, server-effective effort, forced SDK compaction, visual browser testing, representative efficiency measurements and a 24-hour canary remain unverified. The maintainer explicitly authorized this experimental release without waiting for a second account or those historical acceptance items. They remain unverified in the acceptance record and are not represented as passed.
