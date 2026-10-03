import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
} from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { ClaudeCodeAdapter, resolveConfig, degradedReplayText } from '../lib/index.js'
import { SubscriptionProvider } from '../lib/sessions/provider.js'
import { StateStore } from '../lib/storage/store.js'
import { verifyAccount } from '../lib/auth/official.js'
import { StickyRouter } from '../lib/routing/router.js'
import { resolveCliState } from '../lib/cli-state.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i < 0 ? undefined : process.argv[i + 1]
}
if (!process.argv.includes('--live') || !arg('--state') || !arg('--report')) {
  console.error(
    'Usage: node scripts/live-interruption.mjs --live --state <existing-confirmed-state> --report <private-report>',
  )
  process.exit(2)
}
const reportPath = resolve(arg('--report')),
  original = process.cwd(),
  root = mkdtempSync(join(tmpdir(), 'claude-interruption-'))
const checks = [],
  ctx = new Context(),
  fibers = [],
  stateDirectory = join(root, 'state')
const system =
  'DSH owns tools and history. Follow current user instructions. Tool receipts are completed work and must not be repeated. Respond briefly. Do not call a tool unless explicitly requested.'
const tools = [
  {
    name: 'dsh_probe',
    description: 'DSH-owned no-op fixture. Returns its nonce.',
    parameters: {
      type: 'object',
      properties: { nonce: { type: 'string' } },
      required: ['nonce'],
      additionalProperties: false,
    },
  },
]
const user = (text) =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
let provider,
  removeAdapter,
  model,
  calls = 0,
  toolExecutions = 0,
  messages = [],
  sessionId = randomUUID()
let config = resolveConfig({
  stateDirectory,
  requestTimeoutMs: 120000,
  queueTimeoutMs: 30000,
  maxGenerations: 50,
})
const output = {
  status: 'RUNNING',
  scope:
    'real DSH LlmRuntime, SubscriptionProvider, managed SDK/official Claude; isolated state; no-op tools only',
  checks,
}
function record(name, data = {}) {
  const row = { name, pass: true, ...data }
  checks.push(row)
  console.log(JSON.stringify(row))
}
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
  provider = undefined
}
async function generate(name, expected, extra = {}) {
  if (++calls > 18) throw new Error('LIVE_BUDGET_EXCEEDED')
  const start = Date.now(),
    chunks = []
  for await (const chunk of ctx.llm.stream({
    provider: 'claude-sdk-local',
    model,
    reasoningEffort: 'low',
    sessionId,
    system,
    messages,
    tools,
    signal: AbortSignal.timeout(120000),
    ...extra,
  }))
    chunks.push(chunk)
  const terminal = chunks.findLast((c) => c.type === 'finish'),
    blocks = chunks.filter((c) => c.type === 'block-end').map((c) => c.block)
  const text = blocks
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
  const expectedKind = extra.expectedKind ?? 'stop'
  if (terminal?.reason.kind !== expectedKind)
    throw new Error(
      name + ':' + (terminal?.reason.failure?.code ?? terminal?.reason.kind ?? 'MISSING_TERMINAL'),
    )
  if (expected !== undefined && !text.includes(expected)) throw new Error(name + ':REPLY_MISMATCH')
  messages.push(
    createAssistantMessage({
      source: { provider: 'claude-sdk-local', model, replayState: terminal.replayState },
      content: blocks,
    }),
  )
  const usage = chunks.filter((c) => c.type === 'usage').map((c) => c.usage)
  record(name, {
    durationMs: Date.now() - start,
    finish: terminal.reason.kind,
    usage,
    ...(terminal.reason.failure ? { failureCode: terminal.reason.failure.code } : {}),
  })
  return { blocks, text, terminal, usage }
}
function receipts(blocks) {
  const pending = blocks.filter((b) => b.type === 'tool-call')
  if (pending.length !== 1 || pending[0].name !== 'dsh_probe')
    throw new Error('EXPECTED_ONE_NOOP_TOOL')
  toolExecutions++
  messages.push(
    createToolResultMessage({
      callId: pending[0].id,
      content: [{ type: 'text', text: JSON.parse(pending[0].arguments).nonce }],
      isError: false,
    }),
  )
}
try {
  const source = new StateStore(resolve(arg('--state')), { readOnly: true })
  let account
  try {
    account = source.list('accounts').find((a) => a.state === 'READY' && a.extraUsageOffConfirmedAt)
  } finally {
    source.close()
  }
  if (!account) throw new Error('NO_CONFIRMED_SUBSCRIPTION_ACCOUNT')
  model = account.models.sonnet ? 'sonnet' : 'opus'
  process.chdir(root)
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  install()
  new StickyRouter(provider.store).register(
    await verifyAccount(
      provider.store,
      config.claudeCommand,
      'regression',
      account.profileRef,
      true,
    ),
  )
  output.model = model
  const info = await ctx.llm.resolveModelInfo('claude-sdk-local', model)
  if (!(info.context?.contextWindow > 0)) throw new Error('MISSING_CONTEXT_WINDOW')
  record('DSH-context-capacity', { contextWindow: info.context.contextWindow })
  messages = [user('Remember the marker ORCHID_527. Reply exactly READY.')]
  await generate('initial-real-generation', 'READY')
  messages.push(user('Call dsh_probe exactly once with nonce RECEIPT_1, then report its result.'))
  receipts(
    (await generate('first-DSH-tool-call', undefined, { expectedKind: 'tool-calls' })).blocks,
  )
  await generate('ordinary-tool-result-continuation', 'RECEIPT_1')
  messages.push(user('Call dsh_probe exactly once with nonce RECEIPT_2, then report its result.'))
  receipts(
    (await generate('second-DSH-tool-call', undefined, { expectedKind: 'tool-calls' })).blocks,
  )
  messages.push(
    user('Runtime update: user approval policy is never.'),
    user('Runtime update: current sandbox policy is danger-full-access.'),
    user(
      'The previous tool is complete. Do not call it again. Reply only UPDATED RECEIPT_2 ORCHID_527.',
    ),
  )
  await generate('tool-receipt-plus-policy-runtime-user-update', 'UPDATED RECEIPT_2 ORCHID_527')
  if (toolExecutions !== 2) throw new Error('DUPLICATE_TOOL_EXECUTION')
  record('completed-tools-executed-once', { toolExecutions })
  messages.push(user('Without using tools, reply with the remembered marker only.'))
  await generate('warm-continuation-after-rebuild', 'ORCHID_527')
  const history = messages
  messages = [
    user(
      'Summarize this DSH conversation for continuation. Include the remembered marker and completed tool receipts; state that tools must not be repeated.\n' +
        JSON.stringify(history),
    ),
  ]
  const summary = await generate('compaction-purpose-with-maxTokens', 'ORCHID_527', {
    purpose: 'compaction',
    maxTokens: 8192,
    tools: [],
  })
  messages = [
    user('The following summary is the current DSH history:\n' + summary.text),
    user('Reply with the remembered marker only. Do not use tools.'),
  ]
  await generate('continue-after-history-compaction', 'ORCHID_527', { tools: [] })
  await close()
  install()
  messages.push(user('After restarting the provider, reply with the remembered marker only.'))
  await generate('cold-provider-restart-retains-history', 'ORCHID_527', { tools: [] })
  sessionId = randomUUID()
  messages = [
    user(
      'Remember LONG_HISTORY_684. The following is irrelevant padding:\n' +
        'padding '.repeat(35000),
    ),
    createAssistantMessage({
      source: { provider: 'claude-sdk-local', model },
      content: [{ type: 'text', text: 'Acknowledged.' }],
    }),
    user('Reply only with the remembered LONG_HISTORY marker, without tools.'),
  ]
  const bytes = Buffer.byteLength(degradedReplayText(messages))
  if (bytes <= 262144) throw new Error('LONG_HISTORY_FIXTURE_TOO_SMALL')
  await generate('cold-replay-over-256KiB', 'LONG_HISTORY_684', { tools: [] })
  record('long-replay-fixture-size', { bytes })
  sessionId = randomUUID()
  messages = [
    user(
      'Output the numbers from 1 through 5000, one per line. Do not summarize or abbreviate. Start immediately. Do not use tools.',
    ),
  ]
  const limited = await generate('enforced-small-output-token-limit', undefined, {
    tools: [],
    maxTokens: 128,
    expectedKind: 'max-tokens',
  })
  if (!limited.usage.some((u) => u.outputTokens > 0 && u.outputTokens <= 128))
    throw new Error('OUTPUT_LIMIT_NOT_OBSERVED')
  await close()
  config = resolveConfig({ ...config, maxGenerations: 1 })
  install()
  sessionId = randomUUID()
  messages = [user('Call dsh_probe exactly once with nonce TURN_LIMIT, then report its result.')]
  receipts(
    (await generate('max-turns-tool-boundary', undefined, { expectedKind: 'tool-calls' })).blocks,
  )
  const capped = await generate('max-turns-reason-is-visible', undefined, { expectedKind: 'error' })
  if (capped.terminal.reason.failure?.code !== 'CLAUDE_MAX_TURNS')
    throw new Error('MAX_TURNS_NOT_CLASSIFIED')
  await close()
  config = resolveConfig({ ...config, maxGenerations: 50 })
  install()
  messages.push(user('The tool already completed. Do not use tools. Reply RECOVERED.'))
  await generate('continue-after-max-turns-without-reexecution', 'RECOVERED')
  const cliState = await resolveCliState(['--dsh-profile', 'web'])
  if (resolve(cliState) !== resolve(arg('--state'))) throw new Error('CLI_STATE_MISMATCH')
  record('management-CLI-matches-GUI-state')
  output.status = 'PASSED'
} catch (error) {
  output.status = 'FAILED'
  output.failure =
    error instanceof Error && /^[A-Za-z0-9_:-]+$/.test(error.message)
      ? error.message
      : 'LIVE_VERIFICATION_FAILED'
  console.log(JSON.stringify({ status: output.status, failure: output.failure }))
  process.exitCode = 1
} finally {
  await close()
  for (const fiber of fibers.reverse()) await fiber.dispose()
  process.chdir(original)
  output.modelSteps = calls
  output.toolExecutions = toolExecutions
  output.finishedAt = new Date().toISOString()
  mkdirSync(resolve(reportPath, '..'), { recursive: true })
  writeFileSync(reportPath, JSON.stringify(output, null, 2) + '\n', { mode: 0o600 })
  rmSync(root, { recursive: true, force: true })
}
