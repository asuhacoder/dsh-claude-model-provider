# DSH Session Provider

Unofficial Claude subscription provider for DeepSeek Harness. A derivative of snowan/dsh-claude-plugin (MIT). DSH keeps history, tool execution and permission decisions; the unmodified official Claude Agent SDK/CLI supplies inference.

**Experimental.** Verified locally with DSH **0.2.0-rc.2**, SDK **0.3.286**, official host CLI **2.1.283**, Node **24.14.0**, macOS arm64. Actual text and a DSH-owned no-op tool round trip passed, including a warm query. See [implementation evidence](IMPLEMENTATION_REPORT.md) and [capabilities](CAPABILITY_REPORT.json) for exact boundaries. Real multi-account authentication and production release automation are not verified. SDK runtime parity is 2.1.286; the separately installed host CLI is deliberately not upgraded.

[日本語](README.ja.md) · [License](LICENSE) · [Attribution](THIRD_PARTY_NOTICES.md) · [Usage/distribution terms](COMPLIANCE.md)

## Install the experimental npm plugin

```sh
dsh plugin --profile web add @asuha/dsh-claude-model-provider@next --ignore-scripts
```

The `next` tag contains experimental releases. Version `0.1.0-next.3` fixes a model-catalog failure caused by models with no effort selector. It was exercised in an existing DSH Web profile alongside its existing providers, including a real response and a DSH file-tool round trip.

## Build a tarball

Download the repository's experimental tarball or build it:

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm release:dry-run
dsh plugin --profile web add ./dist/asuha-dsh-claude-model-provider-0.1.0-next.3.tgz --ignore-scripts
```

The plugin only adds `claude-sdk-local`; it does not change the selected model or replace the Subscription Plugin. Restart DSH and select **Claude (official SDK) / opus**. The default alias resolves to Opus.

Before generation, register your existing official login in DSH Settings → Claude 公式SDK. Alternatively, while DSH is stopped, use the installed CLI (no token copying):

```sh
claude auth login
dsh plugin --profile web exec dsh-claude-model-provider accounts add primary --extra-usage-off
dsh plugin --profile web exec dsh-claude-model-provider doctor --offline
```

`--extra-usage-off` records your confirmation that Extra usage is OFF; verify it in Claude settings before using the flag. API keys, alternate gateways/backends and unidentified authentication routes are rejected. No API fallback or account rotation after a policy refusal is supported. After a tarball install, the binary is `dsh-claude-model-provider` in the installed DSH profile; from source use `node lib/provider-cli.js`.

Profiles may be added with `accounts add <alias> --profile <absolute-directory> --login --extra-usage-off`. An official subscription organization identity, hashed with a local salt, deduplicates profiles conservatively; a shared organization does not multiply capacity. Separate Keychain identity isolation must be verified before relying on multiple real accounts.

## Behavior

- Healthy sessions remain on their account. Local reservations spread new sessions; quota windows are intersected. Unknown usage remains unknown. No 95% cutoff or artificial cache pings.
- SDK tools and settings are restricted to the DSH MCP bridge. Tool calls are correlated by exact provider IDs and return to DSH. A persistent ledger refuses duplicate IDs and stops on an uncertain outcome; general exactly-once external side effects are not promised.
- A warm query persists across tool steps. Changed system/history/tool catalogs rebuild from DSH's canonical history. Portable cold replay is a user-role JSON envelope; it is not native role-equivalent replay. Reasoning is not transplanted across cold accounts/models.
- Offline diagnostics queue no model prompt. Live probes require explicit flags. Tokens/cache counters remain separate from actual subscription balances and monetary charges.
- The baseline router is active. The advanced predictive optimizer and live calibration are incomplete; no efficiency improvement is advertised.

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
