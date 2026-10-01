import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import type { Account } from '../src/routing/types.js'
import {
  ClaudeCodeAdapter,
  resolveConfig,
  BUILTIN_MODEL_ALIASES,
  modelCatalog,
  PROVIDER_ID,
  resolvedModelInfo,
  resolveClaudeEffort,
  resolveClaudeModel,
  validateModelId,
} from '../src/index.js'

describe('Claude model aliases', () => {
  it.each([{ efforts: [] }, { efforts: ['future-effort'] }])(
    'keeps the DSH catalog valid when Haiku has no supported effort: %j',
    async ({ efforts }) => {
      const ctx = new Context()
      const fiber = await ctx.plugin(LlmRuntime)
      const account: Account = {
        identity: 'fixture',
        aliases: ['fixture'],
        profileRef: 'default',
        state: 'READY',
        verifiedAt: 1,
        models: { opus: ['low', 'high'], haiku: efforts },
        windows: [],
        parallelLimit: 1,
      }
      const remove = ctx.llm.registerAdapter(
        [PROVIDER_ID],
        new ClaudeCodeAdapter(resolveConfig({ defaultModel: 'haiku' }), {
          accounts: () => [account],
          async *stream() {
            throw new Error('catalog validation must not generate')
          },
        }),
      )
      try {
        const catalog = await ctx.llm.listModels(PROVIDER_ID)
        const models = await Promise.all(
          catalog.map((model) => ctx.llm.resolveModelInfo(PROVIDER_ID, model.id)),
        )
        expect(models.map((model) => model.id)).toEqual(['default', 'haiku', 'opus'])
        expect(models[0]?.reasoning).toBeUndefined()
        expect(models[1]?.reasoning).toBeUndefined()
        expect(models[2]?.reasoning?.efforts.map((effort) => effort.id)).toEqual(['low', 'high'])
      } finally {
        remove()
        await fiber.dispose()
      }
    },
  )
  it('advertises the stable aliases in preferred order', () => {
    const models = modelCatalog('opus')
    expect(models.map((model) => model.id)).toEqual(BUILTIN_MODEL_ALIASES)
    expect(models[0]).toMatchObject({
      provider: PROVIDER_ID,
      id: 'default',
      name: 'Claude Opus (default)',
      inputModalities: ['text', 'image'],
    })
    expect(Object.isFrozen(models)).toBe(true)
    expect(modelCatalog('claude-opus-4-1')[0]?.name).toBe('claude-opus-4-1 (default)')
  })

  it('maps only the default alias and preserves explicit Claude model names', () => {
    expect(resolveClaudeModel('default', 'sonnet')).toBe('sonnet')
    expect(() => resolveClaudeModel('default', 'default')).toThrow('concrete Claude model')
    expect(resolveClaudeModel('opus', 'sonnet')).toBe('opus')
    expect(resolveClaudeModel('claude-sonnet-4-5-20250929', 'haiku')).toBe(
      'claude-sonnet-4-5-20250929',
    )
  })

  it('keeps the requested DSH id while describing the resolved default', () => {
    expect(resolvedModelInfo(PROVIDER_ID, 'default', 'haiku')).toMatchObject({
      provider: PROVIDER_ID,
      id: 'default',
      name: 'Claude Haiku (default)',
      description: 'Claude Code alias resolving to haiku',
    })
    expect(resolvedModelInfo(PROVIDER_ID, 'sonnet', 'haiku')).toMatchObject({
      id: 'sonnet',
      name: 'Claude Sonnet',
      description: 'Claude Code model sonnet',
      reasoning: {
        efforts: [{ id: 'low' }, { id: 'medium' }, { id: 'high' }, { id: 'xhigh' }, { id: 'max' }],
      },
    })
  })

  it('maps the conservative Claude effort vocabulary and rejects unsupported levels', () => {
    expect(resolveClaudeEffort(undefined)).toBeUndefined()
    expect(resolveClaudeEffort('medium')).toBe('medium')
    expect(resolveClaudeEffort('max')).toBe('max')
    expect(() => resolveClaudeEffort('unsupported')).toThrow(/low, medium, high/)
  })

  it.each(['', ' sonnet', 'sonnet ', 'line\nbreak', 'x'.repeat(257)])(
    'rejects invalid model id %j',
    (model) => {
      expect(() => validateModelId(model)).toThrow()
    },
  )

  it('rejects a mismatched provider', () => {
    expect(() => resolvedModelInfo('other', 'sonnet', 'sonnet')).toThrow(
      expect.objectContaining({ code: 'CLAUDE_INVALID_PROVIDER' }),
    )
  })
})
