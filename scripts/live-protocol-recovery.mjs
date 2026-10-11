import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
if (!process.argv.includes('--live') || !arg('--state') || !arg('--report'))
  throw new Error('EXPLICIT_LIVE_STATE_AND_PRIVATE_REPORT_REQUIRED')
const library = resolve(arg('--library') ?? 'lib')
const { ClaudeCodeAdapter, resolveConfig } = await import(pathToFileURL(join(library, 'index.js')))
const { SubscriptionProvider } = await import(pathToFileURL(join(library, 'sessions/provider.js')))
const { StateStore } = await import(pathToFileURL(join(library, 'storage/store.js')))
const { verifyAccount } = await import(pathToFileURL(join(library, 'auth/official.js')))
const { StickyRouter, blockedUntil } = await import(
  pathToFileURL(join(library, 'routing/router.js'))
)
const originalCwd = process.cwd(),
  root = mkdtempSync(join(tmpdir(), 'dsh-protocol-live-'))
const reportPath = resolve(arg('--report'))
const source = new StateStore(resolve(arg('--state')), { readOnly: true })
const account = source
  .list('accounts')
  .find(
    (a) =>
      a.state === 'READY' &&
      a.extraUsageOffConfirmedAt &&
      blockedUntil(a, 'opus', Date.now()) === undefined,
  )
source.close()
if (!account) throw new Error('NO_CONFIRMED_AVAILABLE_SUBSCRIPTION_ACCOUNT')
const ctx = new Context(),
  fibers = [],
  checks = [],
  report = {
    status: 'RUNNING',
    scope:
      'real DSH LlmRuntime, isolated SubscriptionProvider, official SDK/CLI, no-op DSH tool only',
    checks,
  }
let provider,
  removeAdapter,
  messages = [],
  toolsExecuted = 0
const sessionId = randomUUID(),
  model = 'opus'
const config = resolveConfig({
  stateDirectory: join(root, 'state'),
  maxGenerations: 6,
  queueTimeoutMs: 30000,
  requestTimeoutMs: 120000,
})
const tools = [
  {
    name: 'bash',
    description:
      'A harmless protocol fixture. Does not execute commands, write files or access the network. Returns NOOP_OK.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' } },
      required: ['command'],
      additionalProperties: false,
    },
  },
]
const user = (text) =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
function install() {
  provider = new SubscriptionProvider(ctx.subprocess, config)
  removeAdapter = ctx.llm.registerAdapter(
    ['claude-sdk-local'],
    new ClaudeCodeAdapter(config, provider),
  )
}
async function close() {
  removeAdapter?.()
  await provider?.dispose()
}
function record(name, facts) {
  const row = { name, ...facts }
  checks.push(row)
  console.log(JSON.stringify(row))
}
async function generate(name, expectedKind) {
  const chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: 'claude-sdk-local',
    model,
    reasoningEffort: 'low',
    sessionId,
    system:
      'This is a harmless DSH protocol test. Native tools are disabled. The only executable tool is the no-op dsh MCP bash fixture. A deliberately unavailable name must not execute; correct it after rejection. Follow the latest user instruction. Be brief.',
    messages,
    tools,
    signal: AbortSignal.timeout(120000),
  }))
    chunks.push(chunk)
  const terminal = chunks.findLast((c) => c.type === 'finish'),
    blocks = chunks.filter((c) => c.type === 'block-end').map((c) => c.block)
  const expectedFailure = arg('--expect-failure')
  if (expectedFailure) {
    if (terminal?.reason.kind !== 'error' || terminal.reason.failure.code !== expectedFailure) {
      record(name, {
        pass: false,
        expectedFailure,
        actualFailure: terminal?.reason.failure?.code,
        actualFinish: terminal?.reason.kind,
      })
      throw new Error('EXPECTED_BASELINE_FAILURE_NOT_REPRODUCED')
    }
    record(name, {
      pass: true,
      expectedFailure,
      actualFailure: terminal.reason.failure.code,
      toolsExecuted,
    })
    return { baselineFailure: true }
  }
  if (terminal?.reason.kind !== expectedKind)
    throw new Error(
      name + ':' + (terminal?.reason.failure?.code ?? terminal?.reason.kind ?? 'MISSING_FINISH'),
    )
  messages.push(
    createAssistantMessage({
      source: { provider: 'claude-sdk-local', model, replayState: terminal.replayState },
      content: blocks,
    }),
  )
  const calls = blocks.filter((b) => b.type === 'tool-call')
  record(name, {
    pass: true,
    finish: terminal.reason.kind,
    dshToolCalls: calls.length,
    hasExactResumeAnchor: !!terminal.replayState?.response?.claude,
    toolsExecuted,
  })
  return { blocks, calls }
}
function receipt(calls, validate) {
  if (calls.length !== 1 || calls[0].name !== 'bash')
    throw new Error('EXPECTED_EXACTLY_ONE_DSH_NOOP')
  validate?.(JSON.parse(calls[0].arguments))
  toolsExecuted++
  messages.push(
    createToolResultMessage({
      callId: calls[0].id,
      content: [{ type: 'text', text: 'NOOP_OK' }],
      isError: false,
    }),
  )
}
try {
  process.chdir(root)
  fibers.push(await ctx.plugin(LlmRuntime), await ctx.plugin(LocalSubprocessRuntime))
  install()
  const verified = await verifyAccount(
    provider.store,
    config.claudeCommand,
    'protocol-fixture',
    account.profileRef,
    true,
  )
  new StickyRouter(provider.store).register({ ...verified, parallelLimit: 1 })
  messages = [
    user(
      'First deliberately issue a tool_use named exactly bash WITHOUT an MCP prefix, command NOOP. It is intentionally unavailable and must not execute. After its rejection recover by calling mcp__dsh__bash exactly once with command NOOP. Finally reply DONE.',
    ),
  ]
  const bare = await generate('bare-name-recovery', 'tool-calls')
  if (!bare.baselineFailure) {
    receipt(bare.calls, (args) => {
      if (args.command !== 'NOOP') throw new Error('NOOP_ARGUMENT_CHANGED')
    })
    await generate('tool-receipt-continuation', 'stop')
    if (toolsExecuted !== 1) throw new Error('DUPLICATE_TOOL_EXECUTION')
    await close()
    install()
    messages.push(user('After restarting the provider, reply COLD_OK without tools.'))
    await generate('cold-restart-after-unavailable-tool', 'stop')
    messages.push(
      user(
        String.raw`Call mcp__dsh__bash exactly once. Set command to the EXACT string printf '[\u3040-\u30ff] \ud83d\ude00 \u0009 \\u0041'. Preserve every backslash literally. Then reply DONE.`,
      ),
    )
    const unicode = await generate('unicode-tool-boundary', 'tool-calls')
    receipt(unicode.calls, (args) => {
      if (!args.command.includes(String.raw`\u3040`) || !args.command.includes(String.raw`\u0009`))
        throw new Error('STREAMED_UNICODE_WAS_REWRITTEN')
    })
    await generate('unicode-tool-receipt-continuation', 'stop')
    if (toolsExecuted !== 2) throw new Error('DUPLICATE_TOOL_EXECUTION')
    record('exactly-once-noop-effects', { pass: true, toolsExecuted })
  }
  report.status = 'PASSED'
} catch (error) {
  report.status = 'FAILED'
  report.failureCode = error.code ?? error.message
  process.exitCode = 1
} finally {
  await close().catch(() => {})
  for (const fiber of fibers.reverse()) await fiber.dispose()
  process.chdir(originalCwd)
  mkdirSync(resolve(reportPath, '..'), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(
    JSON.stringify({
      status: report.status,
      failureCode: report.failureCode,
      privateReport: reportPath,
    }),
  )
}
