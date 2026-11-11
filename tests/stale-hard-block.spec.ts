import { describe, expect, it } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { SubscriptionProvider, type ProviderDependencies } from '../src/sessions/provider.js'
import { resolveConfig } from '../src/index.js'
import { StickyRouter } from '../src/routing/router.js'
import { RouteBlocked, type Account, type QuotaWindow } from '../src/routing/types.js'
import { StateStore } from '../src/storage/store.js'

const HOUR = 3_600_000
const HARD_BLOCK_PROBE_INTERVAL_MS = 5 * 60_000
const acct = (id: string, windows: QuotaWindow[] = []): Account => ({
  identity: id,
  aliases: [id],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  extraUsageOffConfirmedAt: 1,
  models: { opus: ['low'] },
  windows,
  parallelLimit: 4,
})
const fiveHourBlock = (observedAt: number, until: number): QuotaWindow => ({
  key: 'five_hour',
  scope: '*',
  epoch: String(until),
  observedAt,
  resetsAt: until,
  utilization: 1,
  hardBlockedUntil: until,
  source: 'sdk',
})
const rateLimit = (status: 'allowed' | 'rejected', resetsAtMs: number): SDKMessage =>
  ({
    type: 'rate_limit_event',
    rate_limit_info: {
      status,
      rateLimitType: 'five_hour',
      resetsAt: resetsAtMs / 1000,
      utilization: status === 'allowed' ? 0 : 1,
    },
  }) as SDKMessage
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const failure: StreamChunk = {
  type: 'finish',
  reason: { kind: 'error', failure: { code: 'SDK_ERROR', message: 'SDK_ERROR' } },
}
const request = (): GenerateOptions => ({
  provider: 'claude-sdk-local',
  model: 'opus',
  sessionId: 'stale-block' as never,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})
async function collect(p: SubscriptionProvider) {
  const out: StreamChunk[] = []
  for await (const c of p.stream(request(), 'opus')) out.push(c)
  return out
}
function provider(deps: ProviderDependencies) {
  return new SubscriptionProvider(
    {} as SubprocessRuntime,
    resolveConfig({ stateDirectory: ':memory:', queueTimeoutMs: 50 }),
    {} as never,
    { authenticate: async () => {}, ...deps },
  )
}
function blockAccount(p: SubscriptionProvider, observedAt: number, until: number) {
  const a = p.store.get<Account>('accounts', 'A')!
  a.windows = [fiveHourBlock(observedAt, until)]
  p.store.set('accounts', 'A', a)
}
const req = (session: string, now: number) => ({ session, requestId: session, model: 'opus', now })

describe('a stored hard block yields to fresh evidence', () => {
  it('admits one probe through a block older than the probe interval and holds the rest', () => {
    const now = 10 * HOUR
    const s = new StateStore(':memory:')
    const r = new StickyRouter(s)
    r.register(acct('A', [fiveHourBlock(now - HARD_BLOCK_PROBE_INTERVAL_MS, now + 2 * HOUR)]))
    expect(r.route(req('probe', now)).identity).toBe('A')
    let blocked: unknown
    try {
      r.route(req('second', now))
    } catch (error) {
      blocked = error
    }
    expect(blocked).toBeInstanceOf(RouteBlocked)
    expect((blocked as RouteBlocked).code).toBe('POOL_UNAVAILABLE')
    s.close()
  })
  it('keeps a fresh block and points retry at the next probe, not the stored reset', () => {
    const now = 10 * HOUR
    const s = new StateStore(':memory:')
    const r = new StickyRouter(s)
    r.register(acct('A', [fiveHourBlock(now - 1000, now + 2 * HOUR)]))
    let blocked: unknown
    try {
      r.route(req('s', now))
    } catch (error) {
      blocked = error
    }
    expect((blocked as RouteBlocked).code).toBe('POOL_UNAVAILABLE')
    expect((blocked as RouteBlocked).retryAt).toBe(now - 1000 + HARD_BLOCK_PROBE_INTERVAL_MS)
    s.close()
  })
  it('clears a bound account block when Claude reports the window allowed again', async () => {
    let streams = 0
    let event: SDKMessage | undefined
    const p = provider({
      createManager: (_a, _c, observe) => ({
        dispose: async () => {},
        async *stream() {
          streams++
          if (event) observe(event)
          yield stop
        },
      }),
    })
    new StickyRouter(p.store).register(acct('A'))
    try {
      expect((await collect(p)).at(-1)).toEqual(stop)
      const now = Date.now()
      blockAccount(p, now - HARD_BLOCK_PROBE_INTERVAL_MS - 1, now + 2 * HOUR)
      event = rateLimit('allowed', now + 5 * HOUR)
      expect((await collect(p)).at(-1)).toEqual(stop)
      const window = p.store.get<Account>('accounts', 'A')!.windows[0]!
      expect(window.hardBlockedUntil).toBeUndefined()
      expect(window.utilization).toBe(0)
      expect((await collect(p)).at(-1)).toEqual(stop)
      expect(streams).toBe(3)
    } finally {
      await p.dispose()
    }
  })
  it('clears the block after a successful turn that carried no rate-limit event', async () => {
    const p = provider({
      createManager: () => ({
        dispose: async () => {},
        async *stream() {
          yield stop
        },
      }),
    })
    new StickyRouter(p.store).register(acct('A'))
    try {
      const now = Date.now()
      blockAccount(p, now - HARD_BLOCK_PROBE_INTERVAL_MS - 1, Number.MAX_SAFE_INTEGER)
      expect((await collect(p)).at(-1)).toEqual(stop)
      expect(p.store.get<Account>('accounts', 'A')!.windows[0]!.hardBlockedUntil).toBeUndefined()
    } finally {
      await p.dispose()
    }
  })
  it('keeps and refreshes the block when the probe is rate-limited again', async () => {
    let streams = 0
    const now = Date.now()
    const later = now + 3 * HOUR
    const p = provider({
      createManager: (_a, _c, observe) => ({
        dispose: async () => {},
        async *stream() {
          streams++
          observe(rateLimit('rejected', later))
          yield failure
        },
      }),
    })
    new StickyRouter(p.store).register(acct('A'))
    try {
      blockAccount(p, now - HARD_BLOCK_PROBE_INTERVAL_MS - 1, now + 2 * HOUR)
      expect((await collect(p)).at(-1)).toMatchObject({ reason: { kind: 'error' } })
      const window = p.store.get<Account>('accounts', 'A')!.windows[0]!
      expect(window.hardBlockedUntil).toBe((later / 1000) * 1000)
      expect(window.observedAt).toBeGreaterThanOrEqual(now)
      expect((await collect(p)).at(-1)).toMatchObject({ reason: { kind: 'error' } })
      expect(streams).toBe(1)
    } finally {
      await p.dispose()
    }
  })
})
