import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeOutputTranslator } from '../src/output.js'
import { UsageTracker } from '../src/usage.js'

const session = '11111111-1111-4111-8111-111111111111'

function sdk(value: unknown): SDKMessage {
  return value as SDKMessage
}

function envelope(event: unknown): SDKMessage {
  return sdk({
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: session,
  })
}

function assistant(content: unknown[], error?: string): SDKMessage {
  return sdk({
    type: 'assistant',
    message: { id: 'msg', role: 'assistant', model: 'sonnet', content },
    parent_tool_use_id: null,
    error,
    uuid: crypto.randomUUID(),
    session_id: session,
  })
}

function result(overrides: Record<string, unknown> = {}): SDKMessage {
  return sdk({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    modelUsage: {
      sonnet: {
        inputTokens: 5,
        outputTokens: 3,
        cacheReadInputTokens: 2,
        cacheCreationInputTokens: 1,
      },
    },
    uuid: crypto.randomUUID(),
    session_id: session,
    ...overrides,
  })
}

function acceptAll(translator: ClaudeOutputTranslator, messages: SDKMessage[]) {
  return messages.flatMap((message) => translator.accept(message))
}

describe('Claude output translation', () => {
  it('stops at the first native truncation before hidden SDK continuation', () => {
    const usage = new UsageTracker(), translator = new ClaudeOutputTranslator(usage, true)
    const chunks = acceptAll(translator, [
      envelope({ type: 'message_start', message: { usage: { input_tokens: 21, output_tokens: 1, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } } }),
      envelope({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial', citations: null } }),
      assistant([{ type: 'text', text: 'partial', citations: null }]),
      envelope({ type: 'content_block_stop', index: 0 }),
      envelope({ type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 128 } }),
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(chunks.at(-2)).toEqual({ type: 'usage', usage: { inputTokens: 21, outputTokens: 128, cacheReadTokens: 3, cacheWriteTokens: 2 } })
    expect(translator.truncatedAtBoundary).toBe(true)
    expect(usage.snapshot.outputTokens).toBe(128)
    expect(() => translator.accept(result())).toThrow(/after the terminal result/)
  })
  it('streams fragmented thinking and text in order, reconciles, accounts, and finishes once', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    const chunks = acceptAll(translator, [
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: '' },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'rea', estimated_tokens: null },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: 'son', estimated_tokens: null },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
      assistant([{ type: 'thinking', thinking: 'reason', signature: 'opaque' }]),
      envelope({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'text', text: 'hel', citations: null },
      }),
      envelope({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'text_delta', text: 'lo' },
      }),
      envelope({ type: 'content_block_stop', index: 1 }),
      assistant([{ type: 'text', text: 'hello', citations: null }]),
      envelope({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: {},
        context_management: null,
      }),
      result(),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'rea' },
      { type: 'reasoning-delta', index: 0, text: 'son' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'reason' } },
      { type: 'block-start', index: 1, blockType: 'text' },
      { type: 'text-delta', index: 1, text: 'hel' },
      { type: 'text-delta', index: 1, text: 'lo' },
      { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
      {
        type: 'usage',
        usage: {
          inputTokens: 5,
          outputTokens: 3,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
        },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    expect(translator.complete).toBe(true)
    expect(() => translator.accept(result())).toThrow(/after the terminal result/)
  })

  it('maps max output tokens and authentication errors to stable finishes', () => {
    const max = new ClaudeOutputTranslator(new UsageTracker())
    expect(max.accept(result({ stop_reason: 'max_tokens' })).at(-1)).toEqual({
      type: 'finish',
      reason: { kind: 'max-tokens' },
    })
    const auth = new ClaudeOutputTranslator(new UsageTracker())
    auth.accept(assistant([], 'authentication_failed'))
    expect(auth.accept(result({ is_error: true })).at(-1)).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'CLAUDE_AUTHENTICATION_FAILED' },
      },
    })
  })

  it('maps available thinking-token detail while retaining cost telemetry off-stream', () => {
    const tracker = new UsageTracker()
    const translator = new ClaudeOutputTranslator(tracker)
    const chunks = translator.accept(
      result({
        total_cost_usd: 0.02,
        usage: { output_tokens_details: { thinking_tokens: 2 } },
        modelUsage: {
          sonnet: {
            inputTokens: 5,
            outputTokens: 4,
            cacheReadInputTokens: 0,
            cacheCreationInputTokens: 0,
            costUSD: 0.02,
          },
        },
      }),
    )
    expect(chunks[0]).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 5,
        outputTokens: 4,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: 2,
      },
    })
    expect(tracker.telemetryDelta).toEqual({
      reasoningTokens: 2,
      costUsd: 0.02,
      queryCostUsd: 0.02,
    })
  })

  it('streams a DSH MCP call with raw JSON arguments and stops at the tool boundary', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    const chunks = acceptAll(translator, [
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_read_1',
          name: 'mcp__dsh__read',
          input: {},
        },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":' },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '"/fixture"}' },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_read_1',
          name: 'mcp__dsh__read',
          input: { path: '/fixture' },
        },
      ]),
    ])
    expect(chunks).toEqual([
      { type: 'block-start', index: 0, blockType: 'tool-call' },
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'toolu_read_1',
        name: 'read',
        argumentsDelta: '',
      },
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'toolu_read_1',
        argumentsDelta: '{"path":',
      },
      {
        type: 'tool-call-delta',
        index: 0,
        id: 'toolu_read_1',
        argumentsDelta: '"/fixture"}',
      },
      {
        type: 'block-end',
        index: 0,
        block: {
          type: 'tool-call',
          id: 'toolu_read_1',
          name: 'read',
          arguments: '{"path":"/fixture"}',
        },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
    expect(translator.toolCalls).toEqual([
      {
        type: 'tool-call',
        id: 'toolu_read_1',
        name: 'read',
        arguments: '{"path":"/fixture"}',
      },
    ])
  })

  it('accepts current Claude assistant reconciliation before content_block_stop', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    const chunks = acceptAll(translator, [
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_read_late_stop',
          name: 'mcp__dsh__read',
          input: {},
        },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path": "/fixture"}' },
      }),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_read_late_stop',
          name: 'mcp__dsh__read',
          input: { path: '/fixture' },
        },
      ]),
      envelope({ type: 'content_block_stop', index: 0 }),
    ])
    expect(chunks.at(-2)).toEqual({
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: 'toolu_read_late_stop',
        name: 'read',
        arguments: '{"path": "/fixture"}',
      },
    })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('rejects a late tool stop when the assistant content does not reconcile', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    translator.accept(
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_bad_late_stop',
          name: 'mcp__dsh__read',
          input: {},
        },
      }),
    )
    translator.accept(
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"path":"/partial"}' },
      }),
    )
    translator.accept(
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_bad_late_stop',
          name: 'mcp__dsh__read',
          input: { path: '/completed' },
        },
      ]),
    )
    expect(() => translator.accept(envelope({ type: 'content_block_stop', index: 0 }))).toThrow(
      /did not reconcile/,
    )
  })

  it('accepts complete and empty tool arguments while rejecting malformed tool JSON', () => {
    const complete = new ClaudeOutputTranslator(new UsageTracker())
    const chunks = acceptAll(complete, [
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_complete',
          name: 'mcp__dsh__read',
          input: { z: 1, a: true },
        },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
      assistant([
        {
          type: 'tool_use',
          id: 'toolu_complete',
          name: 'mcp__dsh__read',
          input: { a: true, z: 1 },
        },
      ]),
    ])
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-call-delta',
        argumentsDelta: '{"a":true,"z":1}',
      }),
    )

    const empty = new ClaudeOutputTranslator(new UsageTracker())
    expect(
      acceptAll(empty, [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_empty',
            name: 'mcp__dsh__ping',
            input: {},
          },
        }),
        envelope({ type: 'content_block_stop', index: 0 }),
        assistant([{ type: 'tool_use', id: 'toolu_empty', name: 'mcp__dsh__ping', input: {} }]),
      ]),
    ).toContainEqual(
      expect.objectContaining({
        type: 'block-end',
        block: expect.objectContaining({ arguments: '{}' }),
      }),
    )

    for (const messages of [
      [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_bad',
            name: 'mcp__dsh__read',
            input: {},
          },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{' },
        }),
        envelope({ type: 'content_block_stop', index: 0 }),
      ],
      [assistant([{ type: 'tool_use', id: 'toolu_bad', name: 'mcp__dsh__read', input: null }])],
      [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_bad',
            name: 'mcp__dsh__read',
            input: { ready: true },
          },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        }),
      ],
    ]) {
      expect(() =>
        acceptAll(new ClaudeOutputTranslator(new UsageTracker()), messages as SDKMessage[]),
      ).toThrow()
    }
  })

  it.each([
    [
      'delta without start',
      [
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'x' },
        }),
      ],
    ],
    [
      'unsupported tool block',
      [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 't', name: 'Read', input: {} },
        }),
      ],
    ],
    [
      'open block at result',
      [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        }),
        result(),
      ],
    ],
  ])('rejects malformed protocol: %s', (_name, messages) => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    expect(() => acceptAll(translator, messages as SDKMessage[])).toThrow()
  })

  it('rejects partial/completed mismatches, missing completion, and tool stop', () => {
    const partial = [
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '', citations: null },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
    ]
    expect(() =>
      acceptAll(new ClaudeOutputTranslator(new UsageTracker()), [...partial, result()]),
    ).toThrow(/omitted completed/)
    expect(() =>
      acceptAll(new ClaudeOutputTranslator(new UsageTracker()), [
        ...partial,
        assistant([{ type: 'text', text: 'wrong' }]),
        result(),
      ]),
    ).toThrow(/did not reconcile/)
    expect(() =>
      new ClaudeOutputTranslator(new UsageTracker()).accept(result({ stop_reason: 'tool_use' })),
    ).toThrow(/without a reconciled/)
  })

  it('accepts informational events, message bookends, signatures, and an empty stop-sequence turn', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    const chunks = acceptAll(translator, [
      sdk({ type: 'status', status: 'compacting', uuid: crypto.randomUUID() }),
      envelope({ type: 'message_start', message: {} }),
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'seed' },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'signature_delta', signature: 'opaque' },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
      assistant([{ type: 'thinking', thinking: 'seed', signature: 'opaque' }]),
      envelope({ type: 'message_stop' }),
      result({ stop_reason: 'stop_sequence' }),
    ])
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'seed' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('maps model, rate-limit, and generic SDK errors', () => {
    for (const [error, code] of [
      ['model_not_found', 'CLAUDE_MODEL_NOT_FOUND'],
      ['rate_limit', 'CLAUDE_RATE_LIMITED'],
      ['overloaded', 'CLAUDE_TRANSPORT_ERROR'],
    ]) {
      const translator = new ClaudeOutputTranslator(new UsageTracker())
      translator.accept(assistant([], error))
      expect(translator.accept(result({ is_error: true })).at(-1)).toMatchObject({
        reason: { kind: 'error', failure: { code } },
      })
    }
    const noCategory = new ClaudeOutputTranslator(new UsageTracker())
    expect(
      noCategory.accept(result({ subtype: 'error_during_execution', is_error: true })).at(-1),
    ).toMatchObject({ reason: { failure: { code: 'CLAUDE_EXECUTION_FAILED' } } })
  })

  it.each([
    [
      'session change',
      [
        envelope({ type: 'message_start', message: {} }),
        sdk({ ...result(), session_id: '22222222-2222-4222-8222-222222222222' }),
      ],
    ],
    [
      'subagent partial',
      [sdk({ ...envelope({ type: 'message_stop' }), parent_tool_use_id: 'tool-1' })],
    ],
    ['subagent assistant', [sdk({ ...assistant([]), parent_tool_use_id: 'tool-1' })]],
    [
      'duplicate block',
      [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
      ],
    ],
    ['stop unopened block', [envelope({ type: 'content_block_stop', index: 9 })]],
    [
      'delta type mismatch',
      [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'wrong', estimated_tokens: null },
        }),
      ],
    ],
    [
      'unsupported completed block',
      [assistant([{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} }])],
    ],
    ['unsupported stop reason', [result({ stop_reason: 'pause_turn' })]],
  ])('rejects additional fail-closed protocol case: %s', (_name, messages) => {
    expect(() =>
      acceptAll(new ClaudeOutputTranslator(new UsageTracker()), messages as SDKMessage[]),
    ).toThrow()
  })
})
