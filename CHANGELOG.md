# Changelog

## 0.1.0-next.5 — 2026-10-03

Promote the locally verified `0.1.0-next.4.local.2` interruption repair to an experimental release. Preserve mixed tool receipts and runtime notifications when rebuilding from DSH history; distinguish SDK limits and request failures; expose context capacity and bounded summary output; separate queue and execution deadlines; and repair the installed management CLI's executable, dependency and profile resolution. Source verification passed 281 tests, typecheck, build and coverage. Prior real-account verification covered 14 source requests and three installed-package requests; it was performed on the local predecessor, not the renamed release artifact. See README.md for unverified boundaries.

## 0.1.0-next.4 — 2026-10-02

Display official Claude model names, versions, descriptions and ordering, remove the redundant default picker row, and preserve legacy default selections. Released on GitHub; npm publication of this version was not completed.

## 0.1.0-next.3 — 2026-10-02

Fix the real DSH model catalog rejecting the entire Claude provider when Haiku has no supported reasoning effort. Omit unavailable reasoning metadata and verify the complete catalog through the actual DSH LLM service. Tested in an existing Web profile with real Claude text and a DSH file read, preserving other provider groups and existing sessions. This is an experimental `next` release; real two-account isolation and independent production repair infrastructure remain unverified.

## 0.1.0-next.1 — 2026-10-02

Initial experimental derivative: DSH 0.2.0-rc.2 and SDK 0.3.286; DSH-owned tool round trips; warm sessions; canonical rebuild on history/system changes; subscription-only preflight; persistent sticky account bindings, reservations and tool ledger; profile coexistence checks and redacted evidence. See IMPLEMENTATION_REPORT.md for exact verified and incomplete scope.
