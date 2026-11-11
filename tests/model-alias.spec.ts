import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { type GenerateOptions, type StreamChunk } from '@deepseek-ai/dsh-llm'
import { ClaudeCodeAdapter, PROVIDER_ID, resolveConfig } from '../src/index.js'
import { StickyRouter } from '../src/routing/router.js'
import type { Account } from '../src/routing/types.js'
import { StateStore } from '../src/storage/store.js'
import { AccountController } from '../src/ui/controller.js'

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
// Claude Code 2.1.322 lists Fable 5.2 only as the `fable` row, whose resolvedModel is the real id.
const account = (): Account => ({
  identity: 'org-a',
  aliases: ['main'],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  extraUsageOffConfirmedAt: 1,
  models: { fable: EFFORTS, 'claude-fable-5-1': ['low', 'high'] },
  modelMetadata: {
    fable: { displayName: 'Fable 5.2', resolvedModel: 'claude-fable-5-2' },
    'claude-fable-5-1': { displayName: 'Fable 5.1', resolvedModel: 'claude-fable-5-1' },
  },
  windows: [],
  parallelLimit: 4,
})

function adapter(routed: string[] = []): ClaudeCodeAdapter {
  return new ClaudeCodeAdapter(resolveConfig({ defaultModel: 'fable' }), {
    accounts: () => [account()],
    async *stream(_options: GenerateOptions, model: string): AsyncIterable<StreamChunk> {
      routed.push(model)
      yield { type: 'finish', reason: { kind: 'stop' } } as StreamChunk
    },
  })
}

async function withRuntime(run: (ctx: Context) => Promise<void>): Promise<void> {
  const ctx = new Context()
  const fiber = await ctx.plugin(LlmRuntime)
  const remove = ctx.llm.registerAdapter([PROVIDER_ID], adapter())
  try {
    await run(ctx)
  } finally {
    remove()
    await fiber.dispose()
  }
}

describe('a real Claude model id that the CLI lists only under an alias', () => {
  it('resolves to the alias row the CLI says it resolves to', async () => {
    await withRuntime(async (ctx) => {
      const info = await ctx.llm.resolveModelInfo(PROVIDER_ID, 'claude-fable-5-2')
      expect(info).toMatchObject({ id: 'claude-fable-5-2', name: 'Claude Fable 5.2' })
      expect(info.reasoning?.efforts.map((e) => e.id)).toEqual(EFFORTS)
    })
  })

  it('routes a turn for the real id to an account that lists the alias', async () => {
    const routed: string[] = []
    const chunks: StreamChunk[] = []
    for await (const chunk of adapter(routed).stream({
      provider: PROVIDER_ID,
      model: 'claude-fable-5-2',
      messages: [
        {
          id: 'u1' as never,
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          source: { kind: 'user' },
        },
      ],
    } as GenerateOptions))
      chunks.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    const store = new StateStore(':memory:')
    try {
      store.set('accounts', 'org-a', account())
      const route = new StickyRouter(store).route({
        session: 's',
        requestId: 'r',
        model: routed[0]!,
        effort: 'xhigh',
        now: 1,
      })
      expect(route).toMatchObject({ identity: 'org-a', effort: 'xhigh' })
    } finally {
      store.close()
    }
  })

  it('still rejects an id that no listed row is or resolves to', async () => {
    await withRuntime(async (ctx) => {
      await expect(ctx.llm.resolveModelInfo(PROVIDER_ID, 'claude-fable-9-9')).rejects.toMatchObject(
        {
          code: 'CLAUDE_INVALID_MODEL',
        },
      )
    })
  })

  it('accepts the real id as the default model in account management', async () => {
    const store = new StateStore(':memory:')
    try {
      store.set('accounts', 'org-a', account())
      const controller = new AccountController(() => store, 'claude')
      await controller.execute('setModel', { model: 'claude-fable-5-2' })
      expect(controller.status()).toMatchObject({ defaultModel: 'fable' })
      await expect(
        controller.execute('setModel', { model: 'claude-fable-9-9' }),
      ).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_UNAVAILABLE' })
    } finally {
      store.close()
    }
  })
})
