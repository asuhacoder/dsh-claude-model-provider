# Compatibility repair

The six-hour metadata workflow saves exact npm dist-tags/integrities and the default-branch SHA. It does not presently dispatch or publish AI repairs automatically. An isolated maintainer runner must consume an allowlisted job, use the pinned base, cap attempts at three, deduplicate the fingerprint for six hours and keep secrets out of the candidate workspace. Run ops/repair-worker.mjs with a maintainer-owned runner config after provisioning that boundary. The broken provider is never the repair client's route.

Candidate patches are untrusted. Run protected-branch checks independently at the exact candidate SHA; reject modified tests/policy, external upload instructions and unsigned or mismatched PASS evidence. No automated merge is enabled while semantic classification or live verification is incomplete. A separate publisher App may commit only bot/compat/* and open a PR; it cannot change rules or publish npm. This deployment remains an explicit bootstrap item, not an already-tested E2E claim.

## Completed local pipeline

`pnpm test:ops` exercises the scheduler policy, fingerprint deduplication, six-hour failure cooldown, three-attempt/one-hour bound, protected-path rejection, a separate worker process, a verifier using unchanged base tests, signed candidate/artifact/base/policy evidence, a scoped draft PR payload, and next/promotion/rollback decisions. `ops/fixture-e2e.mjs` creates a real Git fixture and fixes a deliberate upstream argument-shape break. Fault injection rejects weakened assertions, test deletion, workflow permission edits, fake PASS output and secret/network payloads.

The production boundary is still explicit: isolated worker/verifier infrastructure and a restricted publisher GitHub App must be provisioned before processing untrusted repository patches. Separate local directories and child processes are tested but are not claimed as an OS security boundary. Candidate code never supplies the verification key or protected tests. `ops/pipeline.mjs` accepts these services separately; no automatic merge is enabled. Model usage is not scheduled by metadata checks.

The watcher invokes the candidate workflow when the pinned tuple changes. Candidate dependencies are pinned to observed versions and recorded in an artifact; compatibility uses a disposable checkout. CI never changes the installed user's CLI or active sessions. Registry packages install with lifecycle scripts disabled.

The release workflow defaults to rehearsal. Optional `publish=true` requires main, the `npm-next` environment and npm trusted publishing; it checks the SHA-256 and publishes the exact rehearsed tarball. No long-lived npm token is passed to a worker. Latest promotion remains a separately approved, signed-evidence and canary decision; no stable readiness is inferred from fixture tests.
