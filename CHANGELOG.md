# Changelog

## Unreleased

Record why a request failed. A failed attempt now stores payload-free evidence in its usage record in `state.sqlite`: the public failure code, the request phase, each exception in the cause chain as a name, an optional code and up to five stack locations, the kind and time of the last SDK event, and the exit code and signal of the Claude process when it had exited. Exception messages, prompts, tool arguments and stderr are not stored. A failure without a stable code still reports `SUBSCRIPTION_PROVIDER_FAILED`, and its message now names the exception type, the first stack location and the usage record ID. A cleanup failure no longer replaces the first failure: the provider returns the original code when disposing the bridge rejects, and the bridge keeps a protocol failure when closing the SDK query throws. Debug diagnostics include the same cause chain. These changes were verified with mocked bridges only; no real-account request exercised them.

Continue a session after DSH prunes old tool output. The provider then rebuilds the conversation as one replay frame that carries every retained image. That frame now accepts up to 100 images, which is the Claude request limit, instead of the 20-image DSH upload limit for a single message. When a replay still exceeds 100 images or the DSH image byte budget, the provider fails the request with `IMAGE_OFFLOAD_REQUIRED` and the count of oldest images to offload. DSH records a durable offload and retries, where the turn previously ended with `CLAUDE_UNSUPPORTED_INPUT`. Images that DSH marked as offloaded reach Claude as placeholder text that names the attachment and its read-only path.

Real-account verification on macOS with `opus`: replay frames of 29 and 100 images completed and the model identified the first and last image; frames of 20 and 21 images that include a 2400-pixel image completed; a 101-image frame returned `IMAGE_OFFLOAD_REQUIRED` with `offloadImages: 1` before any model call (`pnpm test:live:image-replay`). A packed tarball installed into a temporary `dsh headless` profile completed a cold resume in which the harness logged the rejected attempt, an `image/offload` event, and a successful retry whose placeholder path resolved to the stored PNG (`pnpm test:live:image-offload`). A single new step that carries more than 100 images still fails with `CLAUDE_UNSUPPORTED_INPUT`.

## 0.1.0-next.5 — 2026-10-03

Promote the locally verified `0.1.0-next.4.local.2` interruption repair to an experimental release. Preserve mixed tool receipts and runtime notifications when rebuilding from DSH history; distinguish SDK limits and request failures; expose context capacity and bounded summary output; separate queue and execution deadlines; and repair the installed management CLI's executable, dependency and profile resolution. Ignore unrelated Windows drives when detecting a profile, and allow management CLI help without resolving state. Local macOS source verification passed 282 tests, typecheck, build and coverage; one Windows-only regression is exercised in CI. Prior real-account verification covered 14 source requests and three installed-package requests; it was performed on the local predecessor, not the renamed release artifact. See README.md for unverified boundaries.

## 0.1.0-next.4 — 2026-10-02

Display official Claude model names, versions, descriptions and ordering, remove the redundant default picker row, and preserve legacy default selections. Released on GitHub; npm publication of this version was not completed.

## 0.1.0-next.3 — 2026-10-02

Fix the real DSH model catalog rejecting the entire Claude provider when Haiku has no supported reasoning effort. Omit unavailable reasoning metadata and verify the complete catalog through the actual DSH LLM service. Tested in an existing Web profile with real Claude text and a DSH file read, preserving other provider groups and existing sessions. This is an experimental `next` release; real two-account isolation and independent production repair infrastructure remain unverified.

## 0.1.0-next.1 — 2026-10-02

Initial experimental derivative: DSH 0.2.0-rc.2 and SDK 0.3.286; DSH-owned tool round trips; warm sessions; canonical rebuild on history/system changes; subscription-only preflight; persistent sticky account bindings, reservations and tool ledger; profile coexistence checks and redacted evidence. See IMPLEMENTATION_REPORT.md for exact verified and incomplete scope.
