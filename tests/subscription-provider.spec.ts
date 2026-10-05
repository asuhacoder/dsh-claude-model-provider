import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createToolResultMessage,
  type GenerateOptions,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import { SubscriptionProvider } from '../src/sessions/provider.js'
import { resolveConfig } from '../src/index.js'
import { StickyRouter } from '../src/routing/router.js'
import type { Account, Binding } from '../src/routing/types.js'
import { RouteBlocked } from '../src/routing/types.js'
import { imageOffloadRequired } from '../src/errors.js'

const fake = vi.hoisted(() => ({
  chunks: [] as StreamChunk[],
  error: undefined as unknown,
  authenticate: vi.fn(),
  streams: vi.fn(),
  dispose: vi.fn(),
}))
vi.mock('../src/auth/official.js', () => ({
  assertAccount: (...args: unknown[]) => fake.authenticate(...args),
}))
vi.mock('../src/bridge.js', () => ({
  defaultQueryFactory: vi.fn(),
  BridgeManager: class {
    async *stream(options: GenerateOptions) {
      fake.streams(options)
      if (fake.error !== undefined) throw fake.error
      yield* fake.chunks
    }
    async dispose() {
      fake.dispose()
    }
  },
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
  sessionId: 'test-session' as never,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
})
async function collect(provider: SubscriptionProvider, options = request()) {
  const chunks: StreamChunk[] = []
  for await (const c of provider.stream(options, 'opus')) chunks.push(c)
  return chunks
}
const provider = () =>
  new SubscriptionProvider({} as SubprocessRuntime, resolveConfig({ stateDirectory: ':memory:' }))
beforeEach(() => {
  vi.clearAllMocks()
  fake.authenticate.mockResolvedValue(undefined)
  fake.chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
  fake.error = undefined
})
describe('subscription provider request boundary', () => {
  it('blocks an empty pool before any SDK stream', async () => {
    const p = provider()
    try {
      expect(await collect(p)).toMatchObject([
        { type: 'finish', reason: { kind: 'error', failure: { code: 'POOL_UNAVAILABLE' } } },
      ])
      expect(fake.streams).not.toHaveBeenCalled()
      expect(p.store.list('reservations')).toEqual([])
    } finally {
      await p.dispose()
    }
  })
  it('reports the image count DSH must offload so the harness can recover the turn', async () => {
    const p = provider()
    new StickyRouter(p.store).register(account('A'))
    fake.error = imageOffloadRequired('replay retains 29 images', 9)
    try {
      expect(await collect(p)).toEqual([
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: {
              code: 'IMAGE_OFFLOAD_REQUIRED',
              message: 'dsh-claude-plugin: replay retains 29 images',
              offloadImages: 9,
            },
          },
        },
      ])
    } finally {
      await p.dispose()
    }
  })
  it('releases a reservation when official identity verification rejects', async () => {
    const p = provider()
    new StickyRouter(p.store).register(account('A'))
    fake.authenticate.mockRejectedValue(new RouteBlocked('PROFILE_IDENTITY_CHANGED'))
    try {
      expect(await collect(p)).toMatchObject([
        { reason: { failure: { code: 'PROFILE_IDENTITY_CHANGED' } } },
      ])
      expect(fake.streams).not.toHaveBeenCalled()
      expect(p.store.list('reservations')).toEqual([])
    } finally {
      await p.dispose()
    }
  })
  it('keeps a healthy account, then migrates only after confirmed quota at a safe boundary', async () => {
    const p = provider(),
      r = new StickyRouter(p.store)
    r.register(account('A'))
    r.register(account('B'))
    try {
      await collect(p)
      const first = p.store.list<Binding>('bindings')[0]!
      await collect(p)
      expect(p.store.list<Binding>('bindings')[0]!.identity).toBe(first.identity)
      r.observe(first.identity, {
        key: 'five',
        scope: '*',
        epoch: 'one',
        observedAt: Date.now(),
        hardBlockedUntil: Date.now() + 60000,
        source: 'fixture',
      })
      expect(await collect(p)).toMatchObject([{ reason: { kind: 'stop' } }])
      const second = p.store.list<Binding>('bindings')[0]!
      expect(second.identity).not.toBe(first.identity)
      expect(second.generation).toBe(2)
      expect(fake.dispose).toHaveBeenCalledOnce()
      expect(p.store.list('reservations')).toEqual([])
    } finally {
      await p.dispose()
    }
  })
  it('requires a committed DSH tool receipt before continuation and never repeats a tool', async () => {
    const p = provider()
    new StickyRouter(p.store).register(account('A'))
    try {
      fake.chunks = [
        {
          type: 'block-end',
          index: 0,
          block: { type: 'tool-call', id: 'call-1' as never, name: 'ping', arguments: '{}' },
        },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ]
      await collect(p)
      expect(await collect(p)).toMatchObject([{ reason: { failure: { code: 'OUTCOME_UNKNOWN' } } }])
      expect(fake.streams).toHaveBeenCalledOnce()
      const next = request()
      next.messages = [
        ...next.messages,
        createToolResultMessage({
          callId: 'call-1' as never,
          content: [{ type: 'text', text: 'done' }],
          isError: false,
        }),
      ]
      fake.chunks = [{ type: 'finish', reason: { kind: 'stop' } }]
      expect(await collect(p, next)).toMatchObject([{ reason: { kind: 'stop' } }])
      expect(p.store.list<{ state: string }>('ledger')[0]!.state).toBe('COMMITTED')
      expect(p.store.list('reservations')).toEqual([])
    } finally {
      await p.dispose()
    }
  })
  it('does not migrate after authentication suspension or cancellation', async () => {
    const p = provider(),
      r = new StickyRouter(p.store)
    r.register(account('A'))
    r.register(account('B'))
    try {
      await collect(p)
      const binding = p.store.list<Binding>('bindings')[0]!,
        a = p.store.get<Account>('accounts', binding.identity)!
      a.state = 'SUSPENDED'
      p.store.set('accounts', a.identity, a)
      expect(await collect(p)).toMatchObject([
        { reason: { failure: { code: 'BOUND_ACCOUNT_UNAVAILABLE' } } },
      ])
      const aborted = { ...request(), signal: AbortSignal.abort() }
      expect(await collect(p, aborted)).toMatchObject([{ reason: { kind: 'aborted' } }])
      expect(fake.streams).toHaveBeenCalledOnce()
      expect(p.store.list('reservations')).toEqual([])
    } finally {
      await p.dispose()
    }
  })
})
