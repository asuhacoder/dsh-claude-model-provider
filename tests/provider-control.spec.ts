import { describe, it, expect, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  SubscriptionProvider,
  type ProviderDependencies,
  observeSdk,
  type AttemptObservation,
} from '../src/sessions/provider.js'
import { resolveConfig } from '../src/index.js'
import { StickyRouter } from '../src/routing/router.js'
import { RouteBlocked, type Account, type Binding } from '../src/routing/types.js'
import { StateStore } from '../src/storage/store.js'
import { UsageHistory, addUsage } from '../src/metrics/history.js'
import { ProviderCircuit, KeyedQueue, CapacitySignal, abortable } from '../src/routing/control.js'
const acct = (id: string): Account => ({
  identity: id,
  aliases: [id],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  extraUsageOffConfirmedAt: 1,
  models: { opus: ['low'], sonnet: [] },
  windows: [],
  parallelLimit: 1,
})
const request = (session = 's', signal?: AbortSignal): GenerateOptions => ({
  provider: 'claude-sdk-local',
  model: 'opus',
  sessionId: session as never,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  ...(signal ? { signal } : {}),
})
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const failure: StreamChunk = {
  type: 'finish',
  reason: { kind: 'error', failure: { code: 'SDK_ERROR', message: 'SDK_ERROR' } },
}
const quota = {
  type: 'rate_limit_event',
  rate_limit_info: {
    status: 'rejected',
    rateLimitType: 'five_hour',
    resetsAt: Date.now() / 1000 + 60,
  },
} as SDKMessage
async function collect(p: SubscriptionProvider, r = request()) {
  const out: StreamChunk[] = []
  for await (const c of p.stream(r, 'opus')) out.push(c)
  return out
}
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { resolve, promise }
}
function provider(deps: ProviderDependencies) {
  const p = new SubscriptionProvider(
    {} as SubprocessRuntime,
    resolveConfig({ stateDirectory: ':memory:' }),
    {} as never,
    { authenticate: async () => {}, ...deps },
  )
  new StickyRouter(p.store).register(acct('A'))
  return p
}
describe('request isolation and controlled migration', () => {
  it('gives a queued request its full execution deadline after admission', async () => {
    vi.useFakeTimers()
    let calls = 0
    const p = provider({ requestTimeoutMs: 40, queueTimeoutMs: 100,
      createManager: () => ({ dispose: async () => {}, async *stream(options) {
        const delay = ++calls === 1 ? 25 : 30
        await abortable(new Promise((r) => setTimeout(r, delay)), options.signal)
        yield stop
      } }),
    })
    try {
      const first = collect(p)
      await vi.advanceTimersByTimeAsync(0)
      const second = collect(p, request('queued'))
      await vi.advanceTimersByTimeAsync(55)
      expect((await first).at(-1)).toEqual(stop)
      expect((await second).at(-1)).toEqual(stop)
    } finally { await p.dispose(); vi.useRealTimers() }
  })
  it('reports queue expiry separately and leaves the predecessor running', async () => {
    vi.useFakeTimers()
    let disposed = 0
    const p = provider({ requestTimeoutMs: 100, queueTimeoutMs: 10,
      createManager: () => ({ dispose: async () => { disposed++ }, async *stream(options) {
        await abortable(new Promise((r) => setTimeout(r, 30)), options.signal)
        yield stop
      } }),
    })
    try {
      const first = collect(p)
      await vi.advanceTimersByTimeAsync(0)
      const second = collect(p, request('queued'))
      await vi.advanceTimersByTimeAsync(11)
      expect((await second).at(-1)).toMatchObject({ reason: { kind: 'error', failure: { code: 'QUEUE_DEADLINE' } } })
      expect(disposed).toBe(0)
      await vi.advanceTimersByTimeAsync(20)
      expect((await first).at(-1)).toEqual(stop)
    } finally { await p.dispose(); vi.useRealTimers() }
  })
  it.each(['terminal', 'throw'])(
    'migrates before output after typed quota (%s), preserving consumed work on each account',
    async (mode) => {
      const used: string[] = []
      let first = true
      const p = provider({
        createManager: (a, _c, observe) => ({
          dispose: async () => {},
          async *stream() {
            used.push(a.identity)
            yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
            if (first) {
              first = false
              observe(quota)
              if (mode === 'throw') throw new Error('transport wrapper')
              yield failure
            } else yield stop
          },
        }),
      })
      new StickyRouter(p.store).register(acct('B'))
      try {
        const out = await collect(p)
        expect(out.at(-1)).toEqual(stop)
        expect(new Set(used).size).toBe(2)
        const h = new UsageHistory(p.store)
        expect(
          h
            .recent()
            .map((x) => x.outcome)
            .sort(),
        ).toEqual(['error', 'response'])
        expect(h.summary().usage).toEqual({ inputTokens: 4, outputTokens: 2 })
        expect(h.summary().acceptedTasks).toBeNull()
        expect(p.store.list('reservations')).toEqual([])
      } finally {
        await p.dispose()
      }
    },
  )
  it.each(['visible', 'retry', 'suspended', 'auth', 'request', 'billing'])(
    'never rotates for %s boundary',
    async (mode) => {
      let creates = 0
      const p = provider({
        createManager: (_a, _c, observe) => {
          creates++
          return {
            dispose: async () => {},
            async *stream() {
              if (mode === 'visible') yield { type: 'text-delta', index: 0, text: 'partial' }
              if (['visible', 'retry'].includes(mode)) observe(quota)
              if (mode === 'retry')
                observe({
                  type: 'system',
                  subtype: 'api_retry',
                  attempt: 1,
                  error: 'rate_limit',
                  retry_delay_ms: 1,
                } as SDKMessage)
              if (!['visible', 'retry'].includes(mode))
                observe({
                  type: 'assistant',
                  error: (
                    {
                      suspended: 'account_on_hold',
                      auth: 'authentication_failed',
                      request: 'invalid_request',
                      billing: 'billing_error',
                    } as Record<string, string>
                  )[mode],
                } as SDKMessage)
              yield failure
            },
          }
        },
      })
      new StickyRouter(p.store).register(acct('B'))
      try {
        expect((await collect(p)).at(-1)).toEqual(failure)
        expect(creates).toBe(1)
      } finally {
        await p.dispose()
      }
    },
  )
  it('cancelling a queued same-session request preserves its running predecessor', async () => {
    const entered = deferred(),
      release = deferred()
    let disposed = 0,
      calls = 0
    const p = provider({
      createManager: () => ({
        dispose: async () => {
          disposed++
        },
        async *stream() {
          calls++
          entered.resolve()
          await release.promise
          yield stop
        },
      }),
    })
    try {
      const running = collect(p)
      await entered.promise
      const c = new AbortController()
      const queued = collect(p, request('s', c.signal))
      c.abort()
      expect((await queued).at(-1)).toMatchObject({ reason: { kind: 'aborted' } })
      expect(disposed).toBe(0)
      release.resolve()
      expect((await running).at(-1)).toEqual(stop)
      expect(calls).toBe(1)
    } finally {
      release.resolve()
      await p.dispose()
    }
  })
  it('queues a different session on account capacity and wakes on release', async () => {
    const entered = deferred(),
      release = deferred()
    let calls = 0
    const p = provider({
      createManager: () => ({
        dispose: async () => {},
        async *stream() {
          calls++
          if (calls === 1) {
            entered.resolve()
            await release.promise
          }
          yield stop
        },
      }),
    })
    try {
      const a = collect(p)
      await entered.promise
      const b = collect(p, request('second'))
      await new Promise((r) => setTimeout(r, 5))
      expect(calls).toBe(1)
      release.resolve()
      await Promise.all([a, b])
      expect(calls).toBe(2)
    } finally {
      release.resolve()
      await p.dispose()
    }
  })
  it('holds the authentication lock until underlying status finishes after caller cancellation', async () => {
    const entered = deferred(),
      release = deferred()
    let calls = 0
    const p = provider({
      authenticate: async () => {
        calls++
        if (calls === 1) {
          entered.resolve()
          await release.promise
        }
      },
      createManager: () => ({
        dispose: async () => {},
        async *stream() {
          yield stop
        },
      }),
    })
    try {
      const c = new AbortController()
      const a = collect(p, request('s', c.signal))
      await entered.promise
      c.abort()
      await a
      const b = collect(p, request('second'))
      await new Promise((r) => setTimeout(r, 5))
      expect(calls).toBe(1)
      release.resolve()
      expect((await b).at(-1)).toEqual(stop)
      expect(calls).toBe(2)
    } finally {
      release.resolve()
      await p.dispose()
    }
  })
  it('ends a capacity wait at its deadline and can dispose with auth in progress', async () => {
    const entered = deferred(),
      release = deferred()
    const p = provider({
      requestTimeoutMs: 30,
      authenticate: async () => {
        entered.resolve()
        await release.promise
      },
      createManager: () => ({
        dispose: async () => {},
        async *stream() {
          yield stop
        },
      }),
    })
    const a = collect(p)
    await entered.promise
    expect((await collect(p, request('other'))).at(-1)).toMatchObject({
      reason: { failure: { code: 'REQUEST_DEADLINE' } },
    })
    await a
    await p.dispose()
    release.resolve()
    await new Promise((r) => setTimeout(r, 1))
    expect(() => p.store).toThrow('PROVIDER_CLOSED')
  })
  it('drops an abandoned stream and releases its reservation', async () => {
    let disposed = 0
    const p = provider({
      createManager: () => ({
        dispose: async () => {
          disposed++
        },
        async *stream() {
          yield { type: 'text-delta', index: 0, text: 'part' }
          yield stop
        },
      }),
    })
    try {
      for await (const _ of p.stream(request(), 'opus')) break
      expect(disposed).toBe(1)
      expect(p.store.list('reservations')).toEqual([])
      expect(new UsageHistory(p.store).recent()[0]?.outcome).toBe('aborted')
    } finally {
      await p.dispose()
    }
  })
})
describe('typed observations, budgets and usage', () => {
  it('updates the requested model capacity from the official main model, excluding helper usage', () => {
    const s = new StateStore(':memory:'), r = new StickyRouter(s)
    r.register(acct('A'))
    const b = r.route({ session: 's', requestId: 'r', model: 'opus', now: 1 })
    const observation: AttemptObservation = { sdkRetries: 0 }
    try {
      observeSdk(s, r, b, observation, { type: 'system', subtype: 'init', model: 'claude-opus-5-5' } as SDKMessage, 2)
      observeSdk(s, r, b, observation, { type: 'result', modelUsage: {
        'helper-model': { contextWindow: 32000, maxOutputTokens: 4096 },
        'claude-opus-5-5': { contextWindow: 1000000, maxOutputTokens: 128000 },
      } } as unknown as SDKMessage, 3)
      expect(s.get<Account>('accounts', 'A')?.modelMetadata?.opus).toMatchObject({ contextWindow: 1000000, maxOutputTokens: 128000 })
      expect(s.get<Account>('accounts', 'A')?.modelMetadata).not.toHaveProperty('helper-model')
    } finally { s.close() }
  })
  it('records model-scoped windows, detects overage and fences late events', () => {
    const s = new StateStore(':memory:'),
      r = new StickyRouter(s)
    r.register(acct('A'))
    const b = r.route({ session: 's', requestId: 'r', model: 'opus', now: 1 })
    const o: AttemptObservation = { sdkRetries: 0 }
    observeSdk(
      s,
      r,
      b,
      o,
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'rejected', rateLimitType: 'seven_day_opus' },
      } as SDKMessage,
      2,
    )
    expect(s.get<Account>('accounts', 'A')?.windows[0]).toMatchObject({
      scope: 'opus',
      epoch: 'unknown',
      hardBlockedUntil: Number.MAX_SAFE_INTEGER,
    })
    expect(o.failure).toBe('quota')
    expect(() =>
      observeSdk(
        s,
        r,
        b,
        o,
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'allowed', isUsingOverage: true },
        } as SDKMessage,
        3,
      ),
    ).toThrow('EXTRA_USAGE_DETECTED')
    expect(s.get<Account>('accounts', 'A')?.extraUsageOffConfirmedAt).toBeUndefined()
    expect(s.get<Account>('accounts', 'A')?.state).toBe('AUTH_REQUIRED')
    expect(() => observeSdk(s, r, { ...b, generation: 10 }, o, quota, 4)).toThrow(
      'STALE_GENERATION',
    )
    s.close()
  })
  it.each(['server_error', 'overloaded', 'rate_limit'])('caps SDK retries for %s', (error) => {
    const s = new StateStore(':memory:'),
      r = new StickyRouter(s)
    r.register(acct('A'))
    const b = r.route({ session: 's', requestId: 'r', model: 'opus', now: 1 })
    const o: AttemptObservation = { sdkRetries: 0 }
    expect(() =>
      observeSdk(
        s,
        r,
        b,
        o,
        {
          type: 'system',
          subtype: 'api_retry',
          attempt: 3,
          error,
          retry_delay_ms: 40,
        } as SDKMessage,
        2,
      ),
    ).toThrow('SDK_RETRY_BUDGET_EXHAUSTED')
    expect(o.sdkRetries).toBe(1)
    s.close()
  })
  it('opens the shared circuit, permits one half-open probe, resets and ages failures', () => {
    const s = new StateStore(':memory:'),
      c = new ProviderCircuit(s, 2, 10)
    c.enter('a', 1)
    c.fail(1)
    c.fail(2)
    expect(() => c.enter('b', 3)).toThrow('PROVIDER_CIRCUIT_OPEN')
    c.enter('p', 13)
    expect(() => c.enter('q', 14)).toThrow()
    c.release('q')
    c.release('p')
    c.enter('q', 15)
    c.success()
    c.enter('x', 16)
    c.fail(100000)
    c.fail(200000)
    c.enter('x', 200001)
    s.close()
  })
  it('deduplicates usage, retains cumulative failed costs when pruning, rejects invalid counters', () => {
    const s = new StateStore(':memory:'),
      h = new UsageHistory(s, 1)
    const row = {
      id: '1',
      session: 's',
      identity: 'A',
      model: 'opus',
      startedAt: 1,
      finishedAt: 2,
      outcome: 'tool-boundary' as const,
      attempts: 1,
      usage: { inputTokens: 4, outputTokens: 1, cacheReadTokens: 2 },
      quotaEpochs: {},
      sdkRetries: 0,
    }
    h.record(row)
    h.record(row)
    h.record({ ...row, id: '2', outcome: 'error' })
    expect(h.recent()).toHaveLength(1)
    expect(h.summary()).toMatchObject({
      toolBoundaries: 1,
      failed: 1,
      usage: { inputTokens: 8, outputTokens: 2, cacheReadTokens: 4 },
    })
    expect(() => addUsage(row.usage, { inputTokens: -1, outputTokens: 0 })).toThrow(
      'INVALID_USAGE_COUNTER',
    )
    s.close()
  })
  it('removes cancelled queue waiters, supports notifications, and propagates abort', async () => {
    const q = new KeyedQueue(),
      release = await q.acquire('a'),
      c = new AbortController()
    const waiting = q.acquire('a', c.signal)
    c.abort()
    await expect(waiting).rejects.toThrow('ABORTED')
    release()
    ;(await q.acquire('a'))()
    await expect(q.acquire('a', AbortSignal.abort())).rejects.toThrow()
    await expect(abortable(Promise.resolve(1))).resolves.toBe(1)
    const n = new CapacitySignal(),
      w = n.wait(100)
    n.notify()
    await w
    await n.wait(1)
    await expect(n.wait(10, AbortSignal.abort())).rejects.toThrow()
  })
})
it.each([
  'oauth_org_not_allowed',
  'verification_required',
  'cloud_credential_error',
  'model_not_found',
  'max_output_tokens',
  'server_error',
  'overloaded',
  'rate_limit',
  'unknown',
])('classifies official assistant failure %s without manufacturing quota', (error) => {
  const s = new StateStore(':memory:'),
    r = new StickyRouter(s)
  r.register(acct('A'))
  const b = r.route({ session: 's', requestId: 'r', model: 'opus', now: 1 }),
    o: AttemptObservation = { sdkRetries: 0 }
  observeSdk(s, r, b, o, { type: 'assistant', error } as SDKMessage, 2)
  expect(o.failure).not.toBe('quota')
  expect(s.get<Account>('accounts', 'A')?.windows).toEqual([])
  s.close()
})
it('returns missing terminal, preserves generic error redaction and blocks auth mutation', async () => {
  const p = provider({ createManager: () => ({ dispose: async () => {}, async *stream() {} }) })
  try {
    expect((await collect(p)).at(-1)).toMatchObject({
      reason: { failure: { code: 'MISSING_TERMINAL' } },
    })
    p.store.set('meta', 'auth-mutation', true)
    expect((await collect(p)).at(-1)).toMatchObject({ reason: { failure: { code: 'AUTH_BUSY' } } })
  } finally {
    await p.dispose()
  }
})
it.each([{ errorCode: 'credits_required' }, { rateLimitType: 'overage' }, { overageInUse: true }])(
  'blocks paid-overage indicators %j instead of quota migration',
  (info) => {
    const s = new StateStore(':memory:'),
      r = new StickyRouter(s)
    r.register(acct('A'))
    const b = r.route({ session: 's', requestId: 'r', model: 'opus', now: 1 }),
      o: AttemptObservation = { sdkRetries: 0 }
    expect(() =>
      observeSdk(
        s,
        r,
        b,
        o,
        {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'rejected', ...info },
        } as unknown as SDKMessage,
        2,
      ),
    ).toThrow('EXTRA_USAGE_DETECTED')
    expect(o.failure).toBe('billing')
    s.close()
  },
)
