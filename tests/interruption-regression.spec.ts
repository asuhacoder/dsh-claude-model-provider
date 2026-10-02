import { describe, it, expect } from 'vitest'
import {
  createUserMessage,
  createAssistantMessage,
  createToolResultMessage,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { LiveInputCursor } from '../src/input.js'
import { degradedReplayText } from '../src/replay.js'
import { ClaudeOutputTranslator } from '../src/output.js'
import { UsageTracker } from '../src/usage.js'
import { filterClaudeEnvironment, sdkEnvironment } from '../src/process.js'
import { accountModelInfo } from '../src/models.js'
import type { Account } from '../src/routing/types.js'
import { resolveCliState } from '../src/cli-state.js'

const user = (text: string) =>
  createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
const call = { type: 'tool-call' as const, id: 'once' as never, name: 'write', arguments: '{}' }
const assistant = createAssistantMessage({
  source: { provider: 'claude-sdk-local', model: 'opus' },
  content: [call],
})
const receipt = createToolResultMessage({
  callId: call.id,
  content: [{ type: 'text', text: 'already-written' }],
  isError: false,
})
const request = (
  messages: GenerateOptions['messages'],
  extra: Partial<GenerateOptions> = {},
): GenerateOptions => ({ provider: 'claude-sdk-local', model: 'opus', messages, ...extra })

describe('interruption regressions', () => {
  it.each(['approval=never', 'runtime=danger-full-access', 'Return UPDATED instead'])(
    'rebuilds mixed tool results plus %s with all receipts and updates',
    async (text) => {
      const initial = [user('write once')],
        cursor = new LiveInputCursor()
      await cursor.prepareStep(request(initial))
      cursor.commit(initial, { model: 'opus', content: [call] })
      const messages = [...initial, assistant, receipt, user(text)]
      await expect(cursor.prepareStep(request(messages))).rejects.toMatchObject({
        code: 'CLAUDE_COLD_REPLAY_UNSUPPORTED',
      })
      const rebuilt = await new LiveInputCursor().prepareStep(request(messages), {
        forceDegraded: true,
      })
      expect(rebuilt).toMatchObject({ kind: 'prompt', start: { mode: 'degraded' } })
      expect(JSON.stringify(rebuilt)).toContain('already-written')
      expect(JSON.stringify(rebuilt)).toContain(text)
    },
  )
  it('refuses missing, duplicate and uncorrelated receipts before rebuilding', async () => {
    const initial = [user('write once')],
      cursor = new LiveInputCursor()
    await cursor.prepareStep(request(initial))
    cursor.commit(initial, { model: 'opus', content: [call] })
    for (const receipts of [
      [],
      [receipt, receipt],
      [{ ...receipt, toolCallId: 'wrong' as never }],
    ]) {
      await expect(
        cursor.prepareStep(request([...initial, assistant, ...receipts, user('update')])),
      ).rejects.toMatchObject({ code: 'CLAUDE_UNSUPPORTED_INPUT' })
    }
  })
  it('accepts compaction output limits and rejects invalid values before starting SDK', async () => {
    await expect(
      new LiveInputCursor().prepareStep(
        request([user('summarize')], { purpose: 'compaction', maxTokens: 8192 }),
      ),
    ).resolves.toMatchObject({ kind: 'prompt' })
    for (const maxTokens of [0, -1, 1.5, NaN, Infinity, 128001]) {
      await expect(
        new LiveInputCursor().prepareStep(request([user('summarize')], { maxTokens })),
      ).rejects.toMatchObject({ code: 'CLAUDE_UNSUPPORTED_INPUT' })
    }
    expect(
      filterClaudeEnvironment(
        {
          ...sdkEnvironment([]),
          CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
          ANTHROPIC_API_KEY: 'secret',
        },
        [],
      ),
    ).toMatchObject({ CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192' })
    expect(filterClaudeEnvironment({ ANTHROPIC_API_KEY: 'secret' }, [])).not.toHaveProperty(
      'ANTHROPIC_API_KEY',
    )
  })
  it('preserves multibyte histories over 256 KiB and enforces the UTF-8 byte guard without truncating receipts', () => {
    const messages = [user('日本語'.repeat(40000)), assistant, receipt, user('continue')]
    const text = degradedReplayText(messages)
    expect(Buffer.byteLength(text)).toBeGreaterThan(262144)
    expect(text).toContain('already-written')
    expect(degradedReplayText(messages, Buffer.byteLength(text))).toBe(text)
    expect(() => degradedReplayText(messages, Buffer.byteLength(text) - 1)).toThrow(
      /compact the DSH history/,
    )
  })
  it.each([
    ['error_max_turns', 'CLAUDE_MAX_TURNS'],
    ['error_max_budget_usd', 'CLAUDE_MAX_BUDGET'],
    ['error_during_execution', 'CLAUDE_EXECUTION_FAILED'],
    ['error_max_structured_output_retries', 'CLAUDE_STRUCTURED_OUTPUT_RETRIES'],
  ])('keeps %s distinguishable without exposing SDK error payloads', (subtype, code) => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    const chunks = translator.accept({
      type: 'result',
      subtype,
      is_error: true,
      num_turns: 12,
      modelUsage: {},
      errors: ['secret-token user-prompt tool-arguments'],
      stop_reason: null,
    } as unknown as SDKMessage)
    expect(chunks.at(-1)).toMatchObject({
      reason: { kind: 'error', failure: { code, message: expect.stringContaining('turns=12') } },
    })
    expect(JSON.stringify(chunks)).not.toMatch(/secret-token|user-prompt|tool-arguments/)
  })
  it('advertises a conservative capacity, using the smallest verified account capacity', () => {
    const a: Account = {
      identity: 'a',
      aliases: [],
      profileRef: 'default',
      state: 'READY',
      verifiedAt: 1,
      models: { opus: [] },
      windows: [],
      parallelLimit: 1,
    }
    expect(accountModelInfo([a], 'claude-sdk-local', 'opus', 'opus').context?.contextWindow).toBe(
      200000,
    )
    const extended = { ...a, modelMetadata: { opus: { contextWindow: 1000000 } } }
    expect(
      accountModelInfo([extended], 'claude-sdk-local', 'opus', 'opus').context?.contextWindow,
    ).toBe(1000000)
    expect(
      accountModelInfo([a, extended], 'claude-sdk-local', 'opus', 'opus').context?.contextWindow,
    ).toBe(200000)
  })
  it('resolves CLI state from the composed profile and refuses ambiguous failure', async () => {
    const base = {
      home: '/fixture/dsh',
      cwd: '/fixture/dsh/profiles/web',
      modulePath: '/fixture/plugin.js',
    }
    const dump = async () =>
      '- id: llm-claude-sdk-local\n  config:\n    stateDirectory: /fixture/web-state\n'
    expect(await resolveCliState([], { ...base, dump })).toBe('/fixture/web-state')
    expect(
      await resolveCliState(['--state', '/explicit'], {
        ...base,
        dump: async () => {
          throw new Error('must not run')
        },
      }),
    ).toBe('/explicit')
    expect(
      await resolveCliState(['--dsh-profile', 'web'], { ...base, cwd: '/outside', dump }),
    ).toBe('/fixture/web-state')
    await expect(
      resolveCliState([], {
        ...base,
        dump: async () => {
          throw new Error('secret')
        },
      }),
    ).rejects.toMatchObject({ code: 'PROFILE_STATE_UNRESOLVED' })
    await expect(resolveCliState(['--state'], base)).rejects.toMatchObject({
      code: 'CLI_OPTION_VALUE_REQUIRED',
    })
  })
})
