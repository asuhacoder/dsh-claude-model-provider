# DSH Claude Model Provider

Unofficial Claude subscription provider for DeepSeek Harness. A derivative of snowan/dsh-claude-plugin (MIT). DSH keeps history, tool execution and permission decisions; the unmodified official Claude Agent SDK/CLI supplies inference.

**Experimental.** Development checks use DSH **0.2.1-rc.5**, SDK **0.3.286**, official host CLI **2.1.283**, and Node **24.14.0**. The recorded local text and DSH-owned tool round trip, including a warm query, was run on DSH **0.2.0-rc.2** on macOS arm64. See [implementation evidence](IMPLEMENTATION_REPORT.md) and [capabilities](CAPABILITY_REPORT.json) for exact boundaries. Real multi-account authentication and production release automation are not verified. SDK runtime parity is 2.1.286; the separately installed host CLI is deliberately not upgraded.

English · [日本語](README.ja.md) · [简体中文](README.zh.md) · [License](LICENSE) · [Attribution](THIRD_PARTY_NOTICES.md) · [Usage/distribution terms](COMPLIANCE.md)

## Install the experimental npm plugin

```sh
dsh plugin --profile web add @asuha/dsh-claude-model-provider@next --ignore-scripts
```

The npm `next` tag selects the most recently published experimental version. The current version is `0.1.0-next.7`; see [release status](RELEASE_STATUS.md) for the publication record. The previous fixed-version GitHub release is also installable:

```sh
dsh plugin --profile web add https://github.com/asuhacoder/dsh-claude-model-provider/releases/download/v0.1.0-next.4/asuha-dsh-claude-model-provider-0.1.0-next.4.tgz --ignore-scripts
```

The `next` tag contains experimental releases. Version `0.1.0-next.4` displays official Claude model names and versions, preserves official descriptions and order, and removes the redundant default row. It retains the empty-effort catalog fix from `0.1.0-next.3`.

## Build a tarball

Download the repository's experimental tarball or build it:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm release:dry-run
dsh plugin --profile web add ./dist/asuha-dsh-claude-model-provider-0.1.0-next.7.tgz --ignore-scripts
```

The plugin only adds `claude-sdk-local`; it does not change the selected model or replace the Subscription Plugin. Restart DSH and select **Claude Subscription / Claude Opus 5.5**. Model names, versions, descriptions and ordering come from the official Claude model list. The legacy `default` ID still works in existing conversations but is no longer an extra picker entry. After upgrading, use **Verify connection** in Claude settings to refresh the saved model names.

Before generation, register your existing official login in DSH Settings → Claude Subscription. Alternatively, while DSH is stopped, use the installed CLI (no token copying):

```sh
claude auth login
dsh plugin --profile web exec dsh-claude-model-provider accounts add primary --extra-usage-off
dsh plugin --profile web exec dsh-claude-model-provider doctor --offline
```

`--extra-usage-off` records your confirmation that Extra usage is OFF; verify it in Claude settings before using the flag. API keys, alternate gateways/backends and unidentified authentication routes are rejected. No API fallback or account rotation after a policy refusal is supported. After a tarball install, the binary is `dsh-claude-model-provider` in the installed DSH profile; from source use `node lib/provider-cli.js`.

When a turn fails because the Claude login expired, the failure row has **Start official login** for that account. The same control is under Settings → Claude Subscription, and `/claude-login <account>` still opens it. The page link is the only browser open. Paste the code into the card. **Cancel** stops the attempt, and after a failure **Log in again** starts a new one. A ready account keeps serving until the new login is verified. A login for a different Claude account does not replace the saved credentials. DSH stays up. If the headless pool uses the same profile and is not running, it is marked ready too. If that pool is running, stop it and run `dsh plugin --profile headless exec dsh-claude-model-provider accounts verify <alias>`. `accounts add --login` still needs DSH stopped, because that command opens its own database writer.

Profiles may be added with `accounts add <alias> --profile <absolute-directory> --login --extra-usage-off`. An official subscription organization identity, hashed with a local salt, deduplicates profiles conservatively; a shared organization does not multiply capacity. Separate Keychain identity isolation must be verified before relying on multiple real accounts.

## Interface language

The settings page and login cards are available in English and Simplified Chinese, and follow the DSH language setting. Japanese is provided for this README only; with any other DSH language the screens are in English.

## Behavior

- Healthy sessions remain on their account. Local reservations spread new sessions; quota windows are intersected. Unknown usage remains unknown. No 95% cutoff or artificial cache pings.
- SDK tools and settings are restricted to the DSH MCP bridge. Tool calls are correlated by exact provider IDs and return to DSH. A persistent ledger refuses a duplicate call ID while that receipt is still stored, and it stops on an uncertain outcome. The ledger keeps every unsettled call and at most 1024 settled receipts. Older settled receipts are deleted. General exactly-once external side effects are not promised.
- A warm query persists across tool steps. Changed system/history/tool catalogs rebuild from DSH's canonical history. Portable cold replay is a user-role JSON envelope; it is not native role-equivalent replay. Reasoning is not transplanted across cold accounts/models.
- Offline diagnostics queue no model prompt. Live probes require explicit flags. Tokens/cache counters remain separate from actual subscription balances and monetary charges.
- The baseline router is active. The advanced predictive optimizer and live calibration are incomplete; no efficiency improvement is advertised.

## Interruption repair in next.5

`0.1.0-next.5` promotes the locally verified `0.1.0-next.4.local.2` repair. Mixed tool receipts and user/runtime updates rebuild the query from the complete DSH history before the parked MCP continuation resumes. Missing, duplicate, or mismatched receipts still fail closed. Typed SDK limits and execution failures retain distinct public codes without copying SDK error payloads.

DSH receives conservative 200k context metadata for known Claude families until account-specific SDK usage reports its capacity. Summary requests support `maxTokens`; at truncation the bridge closes before Claude Code internally retries, leaving continuation to DSH. Usage at this boundary includes the observed main response; auxiliary SDK usage/cost is unavailable. Portable replay keeps a configurable 4 MiB memory guard (`maxReplayBytes`, at most 64 MiB), never silently truncating history. DSH remains responsible for token-based compaction.

Defaults are `queueTimeoutMs=120000`, `requestTimeoutMs=600000` after account admission, and `maxGenerations=50`. Queue time no longer consumes the execution deadline. These are bounded operational defaults, not empirically optimal settings.

## Configuration for long-running sessions

`maxGenerations` controls the maximum SDK turns (tool call rounds) before the session requires a continuation prompt. The default of 50 may be insufficient for computer-use plugins or other scenarios requiring many tool actions. Configure it via the plugin config:

```typescript
{
  maxGenerations: 200  // Allow up to 200 turns per session; range 1-1000
}
```

For computer-use workflows, values of 100-500 are typical. Higher values increase the risk of runaway sessions; consider using explicit continuation prompts for extended tasks. The Claude SDK does not currently support automatic continuation; when `CLAUDE_MAX_TURNS` is reached, the user must send a continuation message. Implementing automatic continuation is technically feasible but carries safety risks and is deferred.

The management CLI preserves executable permissions, supports bin symlinks, and bundles its JavaScript peers so it can start outside the DSH host loader. It resolves its installed/current DSH profile's composed state directory. Use `--dsh-profile web` from elsewhere, or `--state /absolute/private/state` to override it. Failed profile resolution never silently opens another store. `accounts list` reports the selected directory.

`test:live:interruption` requires `--live`, `--state` pointing to an account with existing Extra usage OFF confirmation, and a private `--report` destination. It uses isolated state and no-op tools. A 14-request real test covered mixed notifications, compaction-purpose generation, restart recovery, a 281 KB replay, 128-token truncation, and max-turn recovery. Long-running stability, all GUI automatic-compaction paths, and multiple real accounts are outside that test.

## Verification and recovery

```sh
pnpm verify
pnpm test:install
pnpm test:coexist
pnpm test:live:single -- --live --extra-usage-off
pnpm bench:routing
pnpm compat:probe
pnpm release:dry-run
```

No account is needed for `verify`, install/coexistence or the synthetic benchmark. L4 returns `BLOCKED` without real distinct-account evidence. See [bootstrap](BOOTSTRAP_CHECKLIST.md) and [operations](ops/repair-runbook.md).

Uninstall with `dsh plugin --profile web remove @asuha/dsh-claude-model-provider --config.ignore-scripts=true --config.offline=true --yes`. Keep a copy of the original profile manifest and known-good tarball first. This never intentionally removes official Claude authentication or DSH history. The default private state directory is `$DSH_HOME/claude-sdk-local`, or `~/.dsh/claude-sdk-local`; a stale writer lock after a crash requires verifying the recorded PID is dead before removing only the lock. See the [incident runbook](ops/incident-runbook.md).
