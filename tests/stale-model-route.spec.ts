import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import type { OfficialCatalog } from '../src/auth/official.js'
import { resolveConfig } from '../src/index.js'
import { MODEL_LIST_TTL_MS } from '../src/model-refresh.js'
import type { Account, QuotaWindow } from '../src/routing/types.js'
import { SubscriptionProvider } from '../src/sessions/provider.js'

const NOW = 10 * MODEL_LIST_TTL_MS
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const weeklyBlock: QuotaWindow = {
  key: 'seven_day',
  scope: '*',
  epoch: 'w',
  observedAt: NOW,
  resetsAt: NOW + 36 * 60 * 60 * 1_000,
  utilization: 1,
  hardBlockedUntil: NOW + 36 * 60 * 60 * 1_000,
  source: 'sdk',
}
const account = (identity: string, patch: Partial<Account>): Account => ({
  identity,
  aliases: [identity],
  profileRef: identity === 'primary' ? 'default' : '/profiles/second',
  state: 'READY',
  verifiedAt: 0,
  extraUsageOffConfirmedAt: 1,
  modelsRefreshedAt: 0,
  models: { opus: EFFORTS, sonnet: EFFORTS },
  windows: [],
  parallelLimit: 4,
  ...patch,
})
const secondCatalog: OfficialCatalog = {
  identity: 'second',
  models: { opus: EFFORTS, sonnet: EFFORTS },
  modelMetadata: {},
}
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const request: GenerateOptions = {
  provider: 'claude-sdk-local',
  model: 'opus',
  sessionId: 'headless-turn' as never,
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
}

const providers: SubscriptionProvider[] = []
afterEach(async () => {
  for (const p of providers.splice(0)) await p.dispose()
})

type ReadCatalog = (profileRef: string) => Promise<OfficialCatalog>

function headlessProvider(readCatalog: ReadCatalog) {
  const served: string[] = []
  const p = new SubscriptionProvider(
    {} as SubprocessRuntime,
    resolveConfig({ stateDirectory: ':memory:', queueTimeoutMs: 50 }),
    {} as never,
    {
      authenticate: async () => {},
      now: () => NOW,
      readModelCatalog: (_store, _command, profileRef) => readCatalog(profileRef),
      createManager: (a) => ({
        dispose: async () => {},
        async *stream() {
          served.push(a.identity)
          yield stop
        },
      }),
    },
  )
  providers.push(p)
  p.store.set(
    'accounts',
    'primary',
    account('primary', { isDefault: true, windows: [weeklyBlock] }),
  )
  p.store.set('accounts', 'second', account('second', { models: { sonnet: EFFORTS } }))
  return { p, served }
}

async function finish(p: SubscriptionProvider): Promise<StreamChunk | undefined> {
  let last: StreamChunk | undefined
  for await (const chunk of p.stream(request, 'opus')) last = chunk
  return last
}

describe('a turn that only a stale model list blocks', () => {
  it('rereads the stale list and runs on the account that gained the model, without any picker call', async () => {
    const read = vi.fn<ReadCatalog>(async () => secondCatalog)
    const { p, served } = headlessProvider(read)
    expect(await finish(p)).toEqual(stop)
    expect(served).toEqual(['second'])
    expect(read).toHaveBeenCalledWith('/profiles/second')
    expect(p.store.get<Account>('accounts', 'second')).toMatchObject({
      models: secondCatalog.models,
      modelsRefreshedAt: NOW,
    })
  })

  it('still reports the pool unavailable when the fresh list lacks the model too', async () => {
    const read = vi.fn<ReadCatalog>(async (profileRef) =>
      profileRef === 'default'
        ? { identity: 'primary', models: { opus: EFFORTS }, modelMetadata: {} }
        : { ...secondCatalog, models: { sonnet: EFFORTS } },
    )
    const { p, served } = headlessProvider(read)
    expect(await finish(p)).toMatchObject({
      reason: { kind: 'error', failure: { code: 'POOL_UNAVAILABLE' } },
    })
    expect(served).toEqual([])
    expect(read).toHaveBeenCalledTimes(2)
  })
})
