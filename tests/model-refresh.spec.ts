import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import { ClaudeCodeAdapter, PROVIDER_ID, resolveConfig } from '../src/index.js'
import type { OfficialCatalog } from '../src/auth/official.js'
import { MODEL_LIST_RETRY_MS, MODEL_LIST_TTL_MS, ModelListRefresher } from '../src/model-refresh.js'
import { StickyRouter } from '../src/routing/router.js'
import type { Account } from '../src/routing/types.js'
import { SubscriptionProvider } from '../src/sessions/provider.js'
import { StateStore } from '../src/storage/store.js'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const savedAccount = (): Account => ({
  identity: 'org-a',
  aliases: ['main'],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 0,
  extraUsageOffConfirmedAt: 0,
  models: { opus: EFFORTS, 'claude-fable-5-1': EFFORTS },
  modelMetadata: {
    opus: { displayName: 'Opus 5.5', contextWindow: 1_000_000 },
    'claude-fable-5-1': { displayName: 'Fable 5.1' },
  },
  windows: [
    { key: 'five_hour', scope: '*', epoch: 'e', observedAt: 0, source: 'sdk', utilization: 0.2 },
  ],
  isDefault: true,
  parallelLimit: 4,
})
const withFable52 = (identity = 'org-a'): OfficialCatalog => ({
  identity,
  models: { opus: EFFORTS, 'claude-fable-5-1': EFFORTS, 'claude-fable-5-2': EFFORTS },
  modelMetadata: {
    opus: { displayName: 'Opus 5.5', description: 'Most capable', resolvedModel: 'claude-opus-5-5' },
    'claude-fable-5-1': { displayName: 'Fable 5.1' },
    'claude-fable-5-2': { displayName: 'Fable 5.2', description: 'Newest Fable' },
  },
})

function fixture(read: (profileRef: string) => Promise<OfficialCatalog>, start = MODEL_LIST_TTL_MS) {
  const store = new StateStore(':memory:')
  store.set('accounts', 'org-a', savedAccount())
  let now = start
  const refresher = new ModelListRefresher(() => store, read, () => now)
  return {
    store,
    refresher,
    advance: (ms: number) => (now += ms),
    account: () => store.get<Account>('accounts', 'org-a')!,
  }
}

describe('background model list refresh', () => {
  it('adds a newly released official model to a stale saved list without Verify', async () => {
    const read = vi.fn(async () => withFable52())
    const { store, refresher, account } = fixture(read)
    try {
      await refresher.refreshIfStale()
      expect(read).toHaveBeenCalledWith('default')
      expect(account().models['claude-fable-5-2']).toEqual(EFFORTS)
      expect(account()).toMatchObject({
        aliases: ['main'],
        state: 'READY',
        isDefault: true,
        verifiedAt: 0,
        modelsRefreshedAt: MODEL_LIST_TTL_MS,
        windows: [{ key: 'five_hour', utilization: 0.2 }],
      })
      expect(account().modelMetadata?.opus).toEqual({
        displayName: 'Opus 5.5',
        description: 'Most capable',
        resolvedModel: 'claude-opus-5-5',
        contextWindow: 1_000_000,
      })
      const route = new StickyRouter(store).route({
        session: 's',
        requestId: 'r',
        model: 'claude-fable-5-2',
        effort: 'xhigh',
        now: MODEL_LIST_TTL_MS,
      })
      expect(route).toMatchObject({ identity: 'org-a', model: 'claude-fable-5-2', effort: 'xhigh' })
    } finally {
      store.close()
    }
  })

  it('keeps the last good list when the official read fails, and retries later', async () => {
    const read = vi
      .fn<(profileRef: string) => Promise<OfficialCatalog>>()
      .mockRejectedValueOnce(new Error('AUTH_STATUS_TIMEOUT'))
      .mockResolvedValue(withFable52())
    const { store, refresher, account, advance } = fixture(read)
    try {
      await refresher.refreshIfStale()
      expect(account()).toEqual(savedAccount())
      await refresher.refreshIfStale()
      expect(read).toHaveBeenCalledTimes(1)
      advance(MODEL_LIST_RETRY_MS)
      await refresher.refreshIfStale()
      expect(account().models['claude-fable-5-2']).toEqual(EFFORTS)
    } finally {
      store.close()
    }
  })

  it.each([
    ['a different subscription', withFable52('org-b')],
    ['an empty list', { identity: 'org-a', models: {}, modelMetadata: {} }],
  ])('keeps the saved list when the profile returns %s', async (_label, catalog) => {
    const { store, refresher, account } = fixture(async () => catalog)
    try {
      await refresher.refreshIfStale()
      expect(account()).toEqual(savedAccount())
    } finally {
      store.close()
    }
  })

  it('leaves a recently refreshed list alone and shares one read between concurrent callers', async () => {
    const read = vi.fn(async () => withFable52())
    const { store, refresher, advance } = fixture(read)
    try {
      await Promise.all([refresher.refreshIfStale(), refresher.refreshIfStale()])
      expect(read).toHaveBeenCalledTimes(1)
      advance(MODEL_LIST_TTL_MS - 1)
      await refresher.refreshIfStale()
      expect(read).toHaveBeenCalledTimes(1)
      advance(1)
      await refresher.refreshIfStale()
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      store.close()
    }
  })

  it('shows the new model in the DSH picker with its efforts once the stale list refreshes', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(LlmRuntime)
    const readModelCatalog = vi.fn(async () => withFable52())
    const provider = new SubscriptionProvider(
      {} as SubprocessRuntime,
      resolveConfig({ stateDirectory: ':memory:' }),
      undefined,
      { readModelCatalog, now: () => MODEL_LIST_TTL_MS },
    )
    provider.store.set('accounts', 'org-a', savedAccount())
    const remove = ctx.llm.registerAdapter(
      [PROVIDER_ID],
      new ClaudeCodeAdapter(provider.config, provider),
    )
    try {
      const before = await ctx.llm.listModels(PROVIDER_ID)
      expect(before.map((m) => m.id)).not.toContain('claude-fable-5-2')
      expect(readModelCatalog).toHaveBeenCalledTimes(1)
      await provider.refreshStaleModels()
      const after = await ctx.llm.listModels(PROVIDER_ID)
      expect(after.find((m) => m.id === 'claude-fable-5-2')).toMatchObject({
        name: 'Claude Fable 5.2',
        description: 'Newest Fable',
      })
      const info = await ctx.llm.resolveModelInfo(PROVIDER_ID, 'claude-fable-5-2')
      expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
      expect(readModelCatalog).toHaveBeenCalledTimes(1)
      expect(readModelCatalog.mock.calls[0]?.slice(1)).toEqual(['claude', 'default'])
    } finally {
      remove()
      await fiber.dispose()
      await provider.dispose()
    }
  })
})
