import { describe, expect, it, vi } from 'vitest'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SubscriptionProvider } from '../src/sessions/provider.js'
import { resolveConfig } from '../src/index.js'
import { StickyRouter } from '../src/routing/router.js'
import type { Account } from '../src/routing/types.js'

const fake = vi.hoisted(() => ({
  authenticate: vi.fn(),
}))
vi.mock('../src/auth/official.js', () => ({
  assertAccount: (...args: unknown[]) => fake.authenticate(...args),
}))

const account = (id: string): Account => ({
  identity: id,
  aliases: [id],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  extraUsageOffConfirmedAt: 1,
  models: { opus: ['low'] },
  windows: [],
  parallelLimit: 2,
})
const request = (): GenerateOptions => ({
  provider: 'claude-sdk-local',
  model: 'opus',
  sessionId: 'diagnostics-session' as never,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
})

async function collect(provider: SubscriptionProvider): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of provider.stream(request(), 'opus')) chunks.push(chunk)
  return chunks
}

describe('subscription provider debug diagnostics', () => {
  it('emits generation diagnostics through the wired logger', async () => {
    const logger = { debug: vi.fn() }
    const subprocess = {
      resolveExecutable: () => Promise.resolve('/usr/local/bin/claude'),
    } as unknown as SubprocessRuntime
    const p = new SubscriptionProvider(
      subprocess,
      resolveConfig({ stateDirectory: ':memory:', debug: true }),
      undefined,
      { logger },
    )
    new StickyRouter(p.store).register(account('A'))
    try {
      const [finish] = await collect(p)
      expect(finish).toMatchObject({
        type: 'finish',
        reason: { kind: 'error' },
      })
      const lines = logger.debug.mock.calls.map((call) => String(call[1]))
      expect(lines.some((line) => line.includes('"event":"generation.start"'))).toBe(true)
      expect(lines.some((line) => line.includes('"event":"generation.fail"'))).toBe(true)
    } finally {
      await p.dispose()
    }
  })
})
