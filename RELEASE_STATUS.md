# Release status — 2026-10-02

The maintainer has authorized an experimental npm release after verification in the actual active DSH, followed by replacement with the published npm plugin. PR approval and real two-account testing are not release prerequisites. This supersedes the previous all-other-tasks hold; remaining limitations are still reported honestly.

Candidate: `@asuha/dsh-claude-model-provider@0.1.0-next.3`, npm tag `next`, personal GitHub `asuhacoder` and npm scope `@asuha`.

The actual Web profile exposed a catalog bug for models without effort options. The fix passed 260 tests and the unchanged coverage thresholds. The active DSH successfully completed an Opus response and a DSH file read while preserving existing provider groups and sessions. PR #1 is merged, and GitHub no longer requires an approving review; required CI checks remain.

The final tarball is being verified for publication. Its SHA-256 is `f213f6a5621fad29593ba3885bbd4c2f33403bf1df6c774b487ac41eaf4b62ab`. Publication and registry installation evidence will be recorded separately so the verified tarball remains immutable.

Initial publication uses the authenticated local maintainer. It does not create npm provenance. A local build signature must not be described as independent verification. npm-side trusted publishing/OIDC enrollment remains a separate follow-up after initial package creation.

The predictor remains shadow-only. Real two-account isolation, independent production repair infrastructure, full third-party network coverage, server-effective effort, forced SDK compaction, visual browser testing, representative efficiency measurements and a 24-hour canary remain unverified. These limitations do not block the specifically authorized experimental release and do not imply stable readiness or superiority. No `latest` promotion is intended.
