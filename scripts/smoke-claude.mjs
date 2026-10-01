import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as claudePlugin from '../lib/index.js'

const require = createRequire(import.meta.url)
const sdkPackage = JSON.parse(
  readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'package.json')),
)

const policy = process.argv.includes('--bundled') ? 'bundled-only' : 'host-only'
const prompt = 'Reply with exactly DSH_CLAUDE_SMOKE_OK and nothing else.'
const ctx = new Context()
const fibers = []
const chunks = []
const started = performance.now()
let success = false

try {
  fibers.push(await ctx.plugin(LlmRuntime))
  fibers.push(await ctx.plugin(LocalSubprocessRuntime))
  fibers.push(await ctx.plugin(claudePlugin, { executablePolicy: policy }))
  for await (const chunk of ctx.llm.stream({
    provider: 'claude-sdk-local',
    model: 'default',
    messages: [
      createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }),
    ],
  })) {
    chunks.push(chunk)
  }
  const text = chunks
    .filter((chunk) => chunk.type === 'text-delta')
    .map((chunk) => chunk.text)
    .join('')
  const terminal = chunks.findLast((chunk) => chunk.type === 'finish')
  success = terminal?.reason.kind === 'stop' && text.trim() === 'DSH_CLAUDE_SMOKE_OK'
  process.stdout.write(
    `${JSON.stringify(
      {
        success,
        policy,
        sdkVersion: sdkPackage.version,
        nodeVersion: process.version,
        durationMs: Math.round(performance.now() - started),
        text,
        chunks,
      },
      null,
      2,
    )}\n`,
  )
} finally {
  for (const fiber of fibers.reverse()) await fiber.dispose()
}

if (!success) process.exitCode = 1
