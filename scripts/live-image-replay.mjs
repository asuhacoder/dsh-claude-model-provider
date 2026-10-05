import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createAssistantMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { officialStatus } from '../lib/auth/official.js'
import { BridgeManager, ClaudeCodeAdapter, resolveConfig } from '../lib/index.js'
import { png } from './png-fixture.mjs'

if (!process.argv.includes('--live') || !process.argv.includes('--extra-usage-off')) {
  console.log(
    JSON.stringify({ status: 'BLOCKED', reason: 'explicit_live_and_extra_usage_off_required' }),
  )
  process.exit(2)
}
const flag = (name, fallback) => {
  const index = process.argv.indexOf(name)
  return index === -1 ? fallback : process.argv[index + 1]
}
const model = flag('--model', 'opus')
const only = flag('--only', undefined)

const RED = [255, 0, 0]
const BLUE = [0, 0, 255]
const GRAY = [128, 128, 128]
const store = new Map()
function image(size, colour) {
  const data = png(size, colour)
  const attachment = {
    attachmentId: `sha256:${randomUUID()}`,
    mediaType: 'image/png',
    bytes: data.byteLength,
    width: size,
    height: size,
  }
  store.set(attachment.attachmentId, data)
  return { type: 'image', attachment }
}
// Serves the stored bytes unresized so the request reaches Claude exactly as generated.
const attachments = {
  imageLimits: {
    maxImageBytes: 20 * 1_024 * 1_024,
    maxImagesPerMessage: 20,
    maxMessageImageBytes: 200 * 1_024 * 1_024,
    maxImagePixels: 64_000_000,
    maxImageDimension: 8_192,
    mediaTypes: ['image/png'],
  },
  async readImageRequest(attachment) {
    const data = store.get(attachment.attachmentId)
    return {
      variantId: `variant:${attachment.attachmentId}`,
      attachment,
      data,
      mediaType: 'image/png',
      bytes: data.byteLength,
      width: attachment.width,
      height: attachment.height,
      depth: 'uchar',
      space: 'srgb',
      hasAlpha: false,
    }
  },
}

const cases = [
  { name: 'replay-29', count: 29, firstSize: 64, expect: 'stop' },
  { name: 'replay-100', count: 100, firstSize: 64, expect: 'stop' },
  { name: 'replay-101', count: 101, firstSize: 64, expect: 'IMAGE_OFFLOAD_REQUIRED' },
  { name: 'replay-20-large', count: 20, firstSize: 2400, expect: 'stop' },
  { name: 'replay-21-large', count: 21, firstSize: 2400, expect: 'stop' },
].filter((entry) => only === undefined || only.split(',').includes(entry.name))

const ctx = new Context()
const fibers = []
const results = []
let manager
try {
  await officialStatus('claude', 'default')
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  // portableColdStart forces every cold start through the degraded replay frame.
  const config = resolveConfig({ defaultModel: model, maxGenerations: 2, portableColdStart: true })
  manager = new BridgeManager(ctx.subprocess, config, undefined, attachments)
  ctx.llm.registerAdapter(['claude-sdk-local'], new ClaudeCodeAdapter(config, manager))
  for (const entry of cases) {
    const blocks = Array.from({ length: entry.count }, (_, index) =>
      index === 0
        ? image(entry.firstSize, RED)
        : image(64, index === entry.count - 1 ? BLUE : GRAY),
    )
    // DSH admits at most 20 images per message, so the history spreads them out.
    const messages = []
    for (let from = 0; from < blocks.length; from += 20) {
      messages.push(
        createUserMessage({
          source: { kind: 'user' },
          content: [{ type: 'text', text: 'screenshots' }, ...blocks.slice(from, from + 20)],
        }),
        createAssistantMessage({
          source: { provider: 'claude-sdk-local', model },
          content: [{ type: 'text', text: 'noted' }],
        }),
      )
    }
    messages.push(
      createUserMessage({
        source: { kind: 'user' },
        content: [
          {
            type: 'text',
            text: `Each replay image is one solid colour. Name the colour of DSH replay image 1 and of DSH replay image ${entry.count}. Reply exactly: first=<colour> last=<colour>`,
          },
        ],
      }),
    )
    const chunks = []
    for await (const part of ctx.llm.stream({
      provider: 'claude-sdk-local',
      model,
      reasoningEffort: 'low',
      system: 'Answer in one short line.',
      sessionId: randomUUID(),
      messages,
      signal: AbortSignal.timeout(180_000),
    }))
      chunks.push(part)
    const finish = chunks.findLast((part) => part.type === 'finish')
    const answer = chunks
      .filter((part) => part.type === 'block-end' && part.block.type === 'text')
      .map((part) => part.block.text)
      .join('')
    const outcome = finish?.reason.kind === 'stop' ? 'stop' : finish?.reason.failure?.code
    const seen = outcome !== 'stop' || /first=red\s+last=blue/i.test(answer)
    results.push({
      name: entry.name,
      images: entry.count,
      firstImagePixels: entry.firstSize,
      expected: entry.expect,
      outcome,
      pass: outcome === entry.expect && seen,
      ...(outcome === 'stop' ? { answer } : { failure: finish?.reason.failure }),
      usage: chunks.filter((part) => part.type === 'usage').map((part) => part.usage),
    })
  }
  const report = {
    status: results.every((entry) => entry.pass) ? 'PASSED' : 'FAILED',
    scope:
      'real DSH LlmRuntime + managed subprocess + official SDK; degraded replay frames with generated PNG fixtures served unresized',
    model,
    results,
  }
  mkdirSync('.artifacts', { recursive: true })
  writeFileSync('.artifacts/live-image-replay.json', `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify(report, null, 2))
  if (report.status !== 'PASSED') process.exitCode = 1
} catch (error) {
  console.log(JSON.stringify({ status: 'FAILED', code: error?.code ?? error?.message, results }))
  process.exitCode = 1
} finally {
  await manager?.dispose()
  for (const fiber of fibers.reverse()) await fiber.dispose()
}
