import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { SubscriptionProvider, type ProviderDependencies } from '../src/sessions/provider.js'
import { resolveConfig } from '../src/index.js'
import { StickyRouter } from '../src/routing/router.js'
import { subscriptionLoginRequired, type Account } from '../src/routing/types.js'

const RECHECK_INTERVAL_MS = 60_000
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
const request = (session = 's'): GenerateOptions => ({
  provider: 'claude-sdk-local',
  model: 'opus',
  sessionId: session as never,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
})
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const authFailure: StreamChunk = {
  type: 'finish',
  reason: {
    kind: 'error',
    failure: { code: 'CLAUDE_AUTHENTICATION_FAILED', message: 'CLAUDE_AUTHENTICATION_FAILED' },
  },
}
const authError = {
  type: 'assistant',
  error: 'authentication_failed',
  message: { role: 'assistant', content: [] },
  parent_tool_use_id: null,
  session_id: 'sdk',
  uuid: 'u1',
} as unknown as SDKMessage
const errorResult = {
  type: 'result',
  subtype: 'success',
  is_error: true,
  result: 'Failed to authenticate. API Error: 401',
  session_id: 'sdk',
  uuid: 'u2',
} as unknown as SDKMessage

async function collect(p: SubscriptionProvider, r = request()) {
  const out: StreamChunk[] = []
  for await (const c of p.stream(r, 'opus')) out.push(c)
  return out
}
const failedWith = (code: string) => ({ reason: { kind: 'error', failure: { code } } })

const dirs: string[] = []
const providers: SubscriptionProvider[] = []
afterEach(async () => {
  for (const p of providers.splice(0)) await p.dispose()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})
function stateDirectory(pool: string): string {
  const root = mkdtempSync(join(tmpdir(), 'auth-recheck-'))
  dirs.push(root)
  return join(root, pool)
}
function provider(directory: string, deps: ProviderDependencies, register = true) {
  const p = new SubscriptionProvider(
    {} as SubprocessRuntime,
    resolveConfig({ stateDirectory: directory }),
    {} as never,
    { authenticate: async () => {}, ...deps },
  )
  providers.push(p)
  if (register) new StickyRouter(p.store).register(acct('A'))
  return p
}
const stateOf = (p: SubscriptionProvider) => p.store.get<Account>('accounts', 'A')!.state
function pin(p: SubscriptionProvider, billing = false) {
  const a = p.store.get<Account>('accounts', 'A')!
  a.state = 'AUTH_REQUIRED'
  if (billing) delete a.extraUsageOffConfirmedAt
  p.store.set('accounts', 'A', a)
}

describe.each(['claude-sdk-web', 'claude-sdk-local'])('AUTH_REQUIRED recovery (%s)', (pool) => {
  it('keeps the account ready after a transient authentication failure', async () => {
    let streams = 0
    const p = provider(stateDirectory(pool), {
      now: () => 1_000_000,
      createManager: (_a, _c, observe) => ({
        dispose: async () => {},
        async *stream() {
          if (++streams === 1) {
            observe(authError)
            observe(errorResult)
            yield authFailure
          } else yield stop
        },
      }),
    })
    expect((await collect(p)).at(-1)).toMatchObject(failedWith('CLAUDE_AUTHENTICATION_FAILED'))
    expect(stateOf(p)).toBe('READY')
    expect((await collect(p)).at(-1)).toEqual(stop)
    expect(streams).toBe(2)
  })

  it('restores a bound AUTH_REQUIRED account when the login check passes and runs the turn', async () => {
    let streams = 0
    const p = provider(stateDirectory(pool), {
      now: () => 1_000_000,
      createManager: () => ({
        dispose: async () => {},
        async *stream() {
          streams++
          yield stop
        },
      }),
    })
    expect((await collect(p)).at(-1)).toEqual(stop)
    pin(p)
    expect((await collect(p)).at(-1)).toEqual(stop)
    expect(streams).toBe(2)
    expect(stateOf(p)).toBe('READY')
  })

  it('restores an AUTH_REQUIRED account for a new session and runs the turn', async () => {
    let streams = 0
    const p = provider(stateDirectory(pool), {
      now: () => 1_000_000,
      createManager: () => ({
        dispose: async () => {},
        async *stream() {
          streams++
          yield stop
        },
      }),
    })
    pin(p)
    expect((await collect(p, request('fresh'))).at(-1)).toEqual(stop)
    expect(streams).toBe(1)
    expect(stateOf(p)).toBe('READY')
  })

  it('keeps a really expired login pinned and rechecks it at most once per interval', async () => {
    const directory = stateDirectory(pool)
    let clock = 1_000_000,
      expired = false,
      checks = 0
    const deps: ProviderDependencies = {
      now: () => clock,
      authenticate: async () => {
        checks++
        if (expired) throw subscriptionLoginRequired('A')
      },
      createManager: (_a, _c, observe) => ({
        dispose: async () => {},
        async *stream() {
          expired = true
          observe(authError)
          observe(errorResult)
          yield authFailure
        },
      }),
    }
    const first = provider(directory, deps)
    expect((await collect(first)).at(-1)).toMatchObject(failedWith('CLAUDE_AUTHENTICATION_FAILED'))
    expect(stateOf(first)).toBe('AUTH_REQUIRED')
    const afterPin = checks
    expect((await collect(first)).at(-1)).toMatchObject(failedWith('BOUND_ACCOUNT_UNAVAILABLE'))
    expect(checks).toBe(afterPin)
    await first.dispose()

    clock += RECHECK_INTERVAL_MS / 2
    const second = provider(directory, deps, false)
    expect((await collect(second)).at(-1)).toMatchObject(failedWith('BOUND_ACCOUNT_UNAVAILABLE'))
    expect(checks).toBe(afterPin)

    clock += RECHECK_INTERVAL_MS
    expect((await collect(second)).at(-1)).toMatchObject(failedWith('BOUND_ACCOUNT_UNAVAILABLE'))
    expect(checks).toBe(afterPin + 1)
    expect(stateOf(second)).toBe('AUTH_REQUIRED')
  })

  it('never rechecks an account pinned for extra usage', async () => {
    let checks = 0
    const p = provider(stateDirectory(pool), {
      now: () => 1_000_000,
      authenticate: async () => {
        checks++
      },
      createManager: () => ({
        dispose: async () => {},
        async *stream() {
          yield stop
        },
      }),
    })
    expect((await collect(p)).at(-1)).toEqual(stop)
    pin(p, true)
    const before = checks
    expect((await collect(p)).at(-1)).toMatchObject(failedWith('BOUND_ACCOUNT_UNAVAILABLE'))
    expect((await collect(p, request('fresh'))).at(-1)).toMatchObject(
      failedWith('POOL_UNAVAILABLE'),
    )
    expect(checks).toBe(before)
    expect(stateOf(p)).toBe('AUTH_REQUIRED')
  })
})
