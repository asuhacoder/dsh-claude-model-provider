# Third-party notices

The bridge, MCP correlation, content encoder, diagnostics, replay helpers and their regression tests derive from snowan/dsh-claude-plugin (MIT). The full upstream copyright and MIT grant are retained in LICENSE. Source revision: 13b5d9d63a8dc95792620f2c2c83f2f32a5d7036. Changes include DSH 0.2 message/attachment compatibility, provider namespace, non-invasive composition, safer diagnostics, billing and account routing, state/ledger storage, packaging and operations.

Other evaluated references: daveycodez/dsh-llm-agent-bridge and V1ki/dsh-plugin-subscriptions (MIT); no authentication implementation was copied from either. The latter is an independent coexistence target, not a runtime dependency.

The Claude Agent SDK and official Claude Code runtime retain Anthropic's own licenses and terms. They are dependencies, not relicensed by this project's MIT license. DSH/Cordis and MCP SDK remain their respective upstream packages. Exact versions and integrity hashes are in compatibility.lock.json and pnpm-lock.yaml.
