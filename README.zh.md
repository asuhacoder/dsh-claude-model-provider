# DSH Claude Model Provider

[English](README.md) · [日本語](README.ja.md) · 简体中文

面向 DeepSeek Harness 的非官方 Claude 订阅提供方插件，基于 snowan/dsh-claude-plugin（MIT）改写。历史记录、工具执行和权限决定仍由 DSH 负责；推理由未经修改的官方 Claude Agent SDK/CLI 完成。

**实验版本。** 开发时的检查对象为 DSH **0.2.1-rc.5**、SDK **0.3.286**、官方主机 CLI **2.1.283** 和 Node **24.14.0**。已记录的本地文本应答与 DSH 工具往返（含 warm query）是在 macOS arm64 上的 DSH **0.2.0-rc.2** 中完成的。确切范围见[实现报告](IMPLEMENTATION_REPORT.md)和[能力清单](CAPABILITY_REPORT.json)。多个真实账号的认证以及正式发布自动化尚未验证。SDK 运行时对应 2.1.286；单独安装的主机 CLI 有意未升级。

[许可证](LICENSE) · [署名](THIRD_PARTY_NOTICES.md) · [使用与分发条款](COMPLIANCE.md)

## 安装实验版 npm 插件

```sh
dsh plugin --profile web add @asuha/dsh-claude-model-provider@next --ignore-scripts
```

npm 的 `next` 标签指向最近发布的实验版本。当前版本为 `0.1.0-next.7`，发布记录见[发布状态](RELEASE_STATUS.md)。也可以安装之前固定版本的 GitHub 发布包：

```sh
dsh plugin --profile web add https://github.com/asuhacoder/dsh-claude-model-provider/releases/download/v0.1.0-next.4/asuha-dsh-claude-model-provider-0.1.0-next.4.tgz --ignore-scripts
```

`next` 标签包含实验版本。`0.1.0-next.4` 起显示官方 Claude 模型名称和版本，保留官方说明和顺序，并去掉多余的默认行。它也保留了 `0.1.0-next.3` 中对无推理强度模型的目录修复。

## 构建 tarball

下载仓库的实验版 tarball，或自行构建：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm release:dry-run
dsh plugin --profile web add ./dist/asuha-dsh-claude-model-provider-0.1.0-next.7.tgz --ignore-scripts
```

插件只添加 `claude-sdk-local`，不会更改已选模型，也不会替换 Subscription Plugin。重启 DSH 后选择 **Claude Subscription / Claude Opus 5.5**。模型名称、版本、说明和顺序来自官方 Claude 模型列表。旧的 `default` ID 在已有对话中仍可使用，但不再作为额外条目出现在选择器中。升级后，可在 Claude 设置中使用 **验证连接** 刷新已保存的模型名称。

生成前，请在 DSH 设置 → Claude 订阅 中登记已有的官方登录。也可以在 DSH 停止时使用已安装的 CLI（不会复制令牌）：

```sh
claude auth login
dsh plugin --profile web exec dsh-claude-model-provider accounts add primary --extra-usage-off
dsh plugin --profile web exec dsh-claude-model-provider doctor --offline
```

`--extra-usage-off` 用于记录你已确认 Extra usage 为关闭状态；使用该参数前请先在 Claude 设置中确认。API 密钥、替代网关或后端以及无法识别的认证方式都会被拒绝。不支持 API 回退，也不会在策略拒绝后轮换账号。通过 tarball 安装后，可执行文件为所安装 DSH 配置中的 `dsh-claude-model-provider`；从源码运行时使用 `node lib/provider-cli.js`。

如果某一轮因 Claude 登录过期而失败，失败行中会出现该账号的 **开始官方登录**。设置 → Claude 订阅 中有相同的控件，`/claude-login <账号>` 也仍可打开它。唯一会打开的浏览器页面是登录链接。把授权码粘贴到卡片中。**取消** 会停止本次尝试；失败后，**重新登录** 会开始新的尝试。处于就绪状态的账号在新登录验证完成前继续提供服务。用另一个 Claude 账号完成授权不会替换已保存的凭据。DSH 无需重启。如果 headless 池使用同一配置且未运行，它也会被标记为就绪。如果该池正在运行，请先停止它，再执行 `dsh plugin --profile headless exec dsh-claude-model-provider accounts verify <alias>`。`accounts add --login` 仍需在 DSH 停止时使用，因为该命令会打开自己的数据库写入端。

可以用 `accounts add <alias> --profile <absolute-directory> --login --extra-usage-off` 添加配置。插件以本地盐值哈希官方订阅组织身份，保守地对配置去重；共享同一组织不会增加容量。依赖多个真实账号之前，必须先验证各自的钥匙串身份是否隔离。

## 界面语言

设置页和登录卡片支持英语和简体中文，并跟随 DSH 的语言设置切换。日语仅提供 README；DSH 使用其他语言时，界面显示英语。

## 行为

- 正常的会话保持在原账号上。本地预留用于分散新会话；配额窗口取交集。未知的用量保持未知。没有 95% 截断，也没有人为的缓存 ping。
- SDK 工具和设置仅限于 DSH MCP 桥接。工具调用按提供方 ID 精确关联并返回 DSH。持久化账本在回执仍保存期间拒绝重复的调用 ID，并在结果不确定时停止。账本保留所有未结算的调用，以及最多 1024 条已结算回执，更早的已结算回执会被删除。不承诺外部副作用的通用恰好一次语义。
- warm query 在工具步骤之间保持。system、历史或工具目录发生变化时，从 DSH 的规范历史重建。可移植的冷重放是 user 角色的 JSON 封装，并非与原生角色等价的重放。推理内容不会跨冷账号或模型移植。
- 离线诊断不会向模型发送提示。实时探测需要显式参数。令牌和缓存计数与实际订阅余额及费用分开记录。
- 基线路由器已启用。高级预测优化器和实时校准尚未完成；不宣称任何效率提升。

## next.5 的中断修复

`0.1.0-next.5` 发布了本地验证过的 `0.1.0-next.4.local.2` 修复。混合的工具回执与用户或运行时更新，会在暂停的 MCP 续接恢复之前，从完整的 DSH 历史重建 query。缺失、重复或不匹配的回执仍会安全失败。带类型的 SDK 限制和执行失败保留各自的公开代码，不复制 SDK 错误内容。

在账号专属的 SDK 用量报告容量之前，DSH 会收到已知 Claude 系列保守的 200k 上下文元数据。摘要请求支持 `maxTokens`；截断时，桥接会在 Claude Code 内部重试之前关闭，把续接交给 DSH。此边界上的用量包含已观测到的主响应；辅助 SDK 的用量和费用无法获得。可移植重放有可配置的 4 MiB 内存保护（`maxReplayBytes`，最大 64 MiB），从不静默截断历史。基于令牌的压缩仍由 DSH 负责。

默认值为 `queueTimeoutMs=120000`、账号受理后的 `requestTimeoutMs=600000`，以及 `maxGenerations=50`。排队时间不再占用执行期限。这些是有界的运行默认值，并非经实测得出的最优设置。

## 长时间会话的配置

`maxGenerations` 控制会话需要续接提示之前的最大 SDK 轮数（工具调用轮次）。默认的 50 可能不足以支持 computer-use 插件或其他需要大量工具操作的场景。可在插件配置中调整：

```typescript
{
  maxGenerations: 200  // 每个会话最多 200 轮；范围 1-1000
}
```

computer-use 工作流通常使用 100-500。值越大，失控会话的风险越高；长任务请考虑使用显式的续接提示。Claude SDK 目前不支持自动续接；达到 `CLAUDE_MAX_TURNS` 时，用户需要发送续接消息。自动续接在技术上可行，但有安全风险，暂不实现。

管理 CLI 保留可执行权限，支持 bin 符号链接，并打包其 JavaScript 依赖，因此可以在 DSH 主机加载器之外启动。它会解析所安装或当前 DSH 配置的组合状态目录。从其他位置运行时使用 `--dsh-profile web`，或用 `--state /absolute/private/state` 覆盖。配置解析失败时绝不会静默打开另一个存储。`accounts list` 会显示所选目录。

`test:live:interruption` 需要 `--live`、指向已记录 Extra usage 关闭确认的账号的 `--state`，以及私有的 `--report` 输出位置。它使用隔离的状态和无副作用的工具。一次 14 个请求的真实测试覆盖了混合通知、以压缩为目的的生成、重启恢复、281 KB 重放、128 令牌截断和最大轮数恢复。长期稳定性、GUI 自动压缩的全部路径以及多个真实账号不在该测试范围内。

## 验证与恢复

```sh
pnpm verify
pnpm test:install
pnpm test:coexist
pnpm test:live:single -- --live --extra-usage-off
pnpm bench:routing
pnpm compat:probe
pnpm release:dry-run
```

`verify`、安装与共存测试以及合成基准都不需要账号。没有真实的不同账号证据时，L4 返回 `BLOCKED`。参见[初始设置](BOOTSTRAP_CHECKLIST.md)和[运维](ops/repair-runbook.md)。

卸载命令为 `dsh plugin --profile web remove @asuha/dsh-claude-model-provider --config.ignore-scripts=true --config.offline=true --yes`。请先保留原始配置清单和已知可用的 tarball 副本。卸载不会有意删除官方 Claude 认证或 DSH 历史。默认私有状态目录为 `$DSH_HOME/claude-sdk-local` 或 `~/.dsh/claude-sdk-local`；崩溃后残留的写入锁，需要先确认记录的 PID 已不存在，再只删除该锁。参见[事故处理手册](ops/incident-runbook.md)。
