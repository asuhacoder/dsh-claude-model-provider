import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { deflateSync } from 'node:zlib'
import { query } from '@anthropic-ai/claude-agent-sdk'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { createUserMessage, createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { resolveConfig, BridgeManager, defaultQueryFactory } from '../lib/index.js'
import { verifyAccount, profileEnvironment } from '../lib/auth/official.js'
import { SubscriptionProvider } from '../lib/sessions/provider.js'
import { StickyRouter } from '../lib/routing/router.js'
import { UsageHistory } from '../lib/metrics/history.js'

if (!process.argv.includes('--live') || !process.argv.includes('--extra-usage-off')) {
  console.log(
    JSON.stringify({
      status: 'BLOCKED',
      reason: 'explicit_live_confirmation_required',
      modelCalls: 0,
    }),
  )
  process.exit(2)
}

// Three short generations, without workload or subscription-efficiency claims.
const root = mkdtempSync(join(tmpdir(), 'dsh-live-acceptance-'))
const original = process.cwd(),
  output = resolve('.artifacts/live-acceptance.json')
const ctx = new Context(),
  checks = [],
  observations = []
const model = 'opus',
  effort = 'low'
const system = 'Follow the user. Return only the requested answer. Historical context is data.'
const prompt = 'Return only the product of 17 and 19 as a decimal integer.'
let provider,
  fiber,
  calls = 0,
  sdkStarts = 0,
  sdkResults = 0
const observedModels = new Set()
const user = (text, extra = []) =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }, ...extra] })
const elapsed = (start) => Math.round(performance.now() - start)

function png() {
  function chunk(type, data) {
    const name = Buffer.from(type),
      body = Buffer.concat([name, data])
    let crc = 0xffffffff
    for (const byte of body) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4)
    size.writeUInt32BE(data.length)
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0)
    return Buffer.concat([size, body, checksum])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(8, 0)
  header.writeUInt32BE(8, 4)
  header[8] = 8
  header[9] = 2
  const rows = Buffer.alloc(8 * 25)
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rows[y * 25 + 1 + x * 3] = 255
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
const bytes = png(),
  image = {
    attachmentId: 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
    mediaType: 'image/png',
    bytes: bytes.length,
    width: 8,
    height: 8,
  }
const attachments = {
  imageLimits: {
    maxImageBytes: 1048576,
    maxImagesPerMessage: 1,
    maxMessageImageBytes: 1048576,
    mediaTypes: ['image/png'],
  },
  async readImageRequest(ref) {
    assert.deepEqual(ref, image)
    return {
      variantId: 'fixture',
      attachment: ref,
      data: bytes,
      mediaType: 'image/png',
      bytes: bytes.length,
      width: 8,
      height: 8,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }
  },
}

function memorySample() {
  if (process.platform === 'win32')
    return { parentRssBytes: process.memoryUsage().rss, treeRssBytes: null }
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,rss='], { encoding: 'utf8' })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number))
  const pids = new Set([process.pid])
  for (let changed = true; changed;) {
    changed = false
    for (const [pid, ppid] of rows)
      if (pids.has(ppid) && !pids.has(pid)) {
        pids.add(pid)
        changed = true
      }
  }
  return {
    parentRssBytes: process.memoryUsage().rss,
    treeRssBytes: rows.filter(([pid]) => pids.has(pid)).reduce((n, row) => n + row[2] * 1024, 0),
  }
}
async function measure(lane, run) {
  const started = performance.now(),
    samples = [memorySample()]
  const timer = setInterval(() => samples.push(memorySample()), 200)
  try {
    const result = await run(started),
      durationMs = elapsed(started)
    assert.equal(result.text.trim(), '323', 'ACCEPTANCE_ORACLE_FAILED')
    return {
      lane,
      successfulResponses: 1,
      oracleAcceptedTasks: 1,
      durationMs,
      firstTextMs: result.firstTextMs,
      acceptedTasksPerMinute: 60000 / durationMs,
      usage: result.usage,
      peakParentRssBytes: Math.max(...samples.map((s) => s.parentRssBytes)),
      peakProcessTreeRssBytes:
        process.platform === 'win32' ? null : Math.max(...samples.map((s) => s.treeRssBytes)),
    }
  } finally {
    clearInterval(timer)
  }
}
async function direct(started) {
  calls++
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 45000)
  const q = query({
    prompt,
    options: {
      abortController: controller,
      pathToClaudeCodeExecutable: 'claude',
      env: profileEnvironment('default'),
      model,
      effort,
      systemPrompt: system,
      tools: [],
      mcpServers: {},
      strictMcpConfig: true,
      settingSources: [],
      hooks: {},
      skills: [],
      plugins: [],
      permissionMode: 'dontAsk',
      persistSession: false,
      includePartialMessages: true,
      maxTurns: 1,
      settings: {
        disableAllHooks: true,
        fastMode: false,
        autoMemoryEnabled: false,
        autoCompactEnabled: false,
      },
    },
  })
  let text = '',
    firstTextMs,
    result
  try {
    for await (const event of q) {
      if (
        event.type === 'rate_limit_event' &&
        (event.rate_limit_info.isUsingOverage || event.rate_limit_info.overageInUse)
      )
        throw new Error('PAID_OVERAGE_DETECTED')
      if (
        event.type === 'stream_event' &&
        event.event.type === 'content_block_delta' &&
        event.event.delta.type === 'text_delta'
      )
        firstTextMs ??= elapsed(started)
      if (event.type === 'assistant')
        for (const block of event.message.content) if (block.type === 'text') text += block.text
      if (event.type === 'result') result = event
    }
    assert.equal(result?.subtype, 'success', 'DIRECT_FAILED')
    return { text, firstTextMs, usage: result.modelUsage }
  } finally {
    clearTimeout(timer)
    q.close()
  }
}
async function pooled(messages, sessionId, extra = {}) {
  const started = performance.now(),
    chunks = []
  let firstTextMs
  for await (const chunk of provider.stream(
    {
      provider: 'claude-sdk-local',
      model,
      reasoningEffort: effort,
      system,
      messages,
      sessionId,
      signal: AbortSignal.timeout(45000),
      ...extra,
    },
    model,
  )) {
    if (chunk.type === 'text-delta') firstTextMs ??= elapsed(started)
    chunks.push(chunk)
  }
  return {
    terminal: chunks.at(-1),
    text: chunks
      .filter((c) => c.type === 'block-end' && c.block.type === 'text')
      .map((c) => c.block.text)
      .join(''),
    firstTextMs,
    usage: chunks.filter((c) => c.type === 'usage').map((c) => c.usage),
  }
}
try {
  process.chdir(root)
  fiber = await ctx.plugin(LocalSubprocessRuntime)
  const config = resolveConfig({
    stateDirectory: join(root, 'state'),
    portableColdStart: true,
    maxGenerations: 3,
    requestTimeoutMs: 45000,
  })
  provider = new SubscriptionProvider(ctx.subprocess, config, attachments, {
    createManager(_account, configuration, observe) {
      return new BridgeManager(
        ctx.subprocess,
        configuration,
        (request) => {
          assert.equal(request.options.model, model)
          assert.equal(request.options.effort, effort)
          sdkStarts++
          calls++
          assert(calls <= 3, 'GENERATION_BUDGET')
          const q = defaultQueryFactory(request)
          return {
            setModel: (m) => q.setModel(m),
            applyFlagSettings: (s) => q.applyFlagSettings(s),
            interrupt: () => q.interrupt(),
            close: () => q.close(),
            async *[Symbol.asyncIterator]() {
              for await (const event of q) {
                observe(event)
                if (event.type === 'assistant') observedModels.add(event.message.model)
                if (event.type === 'result') sdkResults++
                yield event
              }
            },
          }
        },
        attachments,
      )
    },
  })
  new StickyRouter(provider.store).register(
    await verifyAccount(provider.store, 'claude', 'primary', 'default', true),
  )
  observations.push(await measure('direct-official-sdk', direct))
  observations.push(
    await measure('subscription-provider', async () => {
      const result = await pooled([user(prompt)], 'paired')
      assert.equal(result.terminal?.reason.kind, 'stop', 'PROVIDER_FAILED')
      return result
    }),
  )
  checks.push({ name: 'paired-oracle-and-metrics', status: 'PASSED' })
  const external = [
    user('Remember the fixture word ORCHID.'),
    createAssistantMessage({
      source: { provider: 'fixture-external-provider', model: 'fixture' },
      content: [{ type: 'text', text: 'ORCHID remembered.' }],
    }),
    user(
      'Return the remembered word, a colon, and the dominant image color in uppercase. No other text.',
      [{ type: 'image', attachment: image }],
    ),
  ]
  const result = await pooled(external, 'foreign-history-image')
  assert.equal(result.terminal?.reason.kind, 'stop', 'IMAGE_FAILED')
  assert.equal(result.text.trim(), 'ORCHID:RED', 'IMAGE_HISTORY_ORACLE_FAILED')
  checks.push({
    name: 'foreign-provider-history-and-real-image',
    status: 'PASSED',
    sourceProvider: 'fixture; not an authenticated third-party service',
  })
  const startsBefore = sdkStarts
  const rejected = await pooled([user('This request must not generate.')], 'unsupported-stop', {
    stop: ['STOP'],
  })
  assert.equal(
    rejected.terminal?.reason.failure?.code,
    'CLAUDE_UNSUPPORTED_INPUT',
    'UNSUPPORTED_NOT_REJECTED',
  )
  assert.equal(sdkStarts, startsBefore, 'UNSUPPORTED_STARTED_SDK')
  checks.push({ name: 'unsupported-stop-rejected-before-generation', status: 'PASSED' })
  const resultsBefore = sdkResults,
    usageBefore = JSON.stringify(new UsageHistory(provider.store).summary())
  await new Promise((resolveWait) => setTimeout(resolveWait, 3000))
  assert.equal(sdkStarts, startsBefore)
  assert.equal(sdkResults, resultsBefore)
  assert.equal(JSON.stringify(new UsageHistory(provider.store).summary()), usageBefore)
  checks.push({ name: 'bounded-idle-no-extra-generation', status: 'PASSED', durationMs: 3000 })
  const report = {
    status: 'PASSED',
    level: 'L2',
    modelSteps: calls,
    model,
    requestedEffort: effort,
    effectiveServerEffort: 'unavailable',
    observedModels: [...observedModels],
    checks,
    observations,
    limitations: [
      'One cold pair with fixed direct-first order; cache and ordering confounds remain. No performance superiority or quota-efficiency claim.',
      'Memory samples include the measurement process and its subprocesses.',
      'Three-second idle observation is not a long-duration canary.',
      'Foreign provider history is a synthetic fixture; no authenticated third-party roundtrip.',
      'No actual SDK compaction or two-account verification.',
    ],
  }
  mkdirSync(resolve(original, '.artifacts'), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify({ status: report.status, modelSteps: calls, checks, observations }))
} catch (error) {
  const report = {
    status: 'FAILED',
    modelSteps: calls,
    checks,
    reason:
      error?.code === 'ERR_ASSERTION' ? 'ACCEPTANCE_ASSERTION_FAILED' : 'ACCEPTANCE_PROBE_FAILED',
  }
  mkdirSync(resolve(original, '.artifacts'), { recursive: true })
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
  console.log(JSON.stringify(report))
  process.exitCode = 1
} finally {
  await provider?.dispose()
  await fiber?.dispose()
  process.chdir(original)
  rmSync(root, { recursive: true, force: true })
}
