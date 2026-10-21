import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeOutputTranslator } from '../src/output.js'
import { UsageTracker } from '../src/usage.js'
import { ClaudePluginError } from '../src/errors.js'
import { describeFailureDetail } from '../src/failure-evidence.js'

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
    const usage = new UsageTracker(),
      translator = new ClaudeOutputTranslator(usage, true)
    const chunks = acceptAll(translator, [
      envelope({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 21,
            output_tokens: 1,
            cache_read_input_tokens: 3,
            cache_creation_input_tokens: 2,
          },
        },
      }),
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'partial', citations: null },
      }),
      assistant([{ type: 'text', text: 'partial', citations: null }]),
      envelope({ type: 'content_block_stop', index: 0 }),
      envelope({
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens' },
        usage: { output_tokens: 128 },
      }),
    ])
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
    expect(chunks.at(-2)).toEqual({
      type: 'usage',
      usage: { inputTokens: 21, outputTokens: 128, cacheReadTokens: 3, cacheWriteTokens: 2 },
    })
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

  it('reports each DSH step its own API-call usage instead of the SDK-turn aggregate', () => {
    // One live SDK turn spanning a DSH tool boundary. DSH treats each step's
    // usage as that request's prompt size; the cumulative SDK result total is
    // ~N requests large and falsely triggers compaction pressure.
    const tracker = new UsageTracker()
    const toolStep = new ClaudeOutputTranslator(tracker)
    const first = acceptAll(toolStep, [
      envelope({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 10,
            output_tokens: 1,
            cache_read_input_tokens: 1000,
            cache_creation_input_tokens: 200,
          },
        },
      }),
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__read', input: {} },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
      assistant([{ type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__read', input: {} }]),
    ])
    expect(first.slice(-2)).toEqual([
      {
        type: 'usage',
        usage: { inputTokens: 10, outputTokens: 1, cacheReadTokens: 1000, cacheWriteTokens: 200 },
      },
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])

    const finalStep = new ClaudeOutputTranslator(tracker)
    const second = acceptAll(finalStep, [
      // The tool-use call's trailing events arrive after DSH's tool boundary.
      envelope({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } }),
      envelope({ type: 'message_stop' }),
      envelope({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 5,
            output_tokens: 1,
            cache_read_input_tokens: 1210,
            cache_creation_input_tokens: 60,
          },
        },
      }),
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'done', citations: null },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
      assistant([{ type: 'text', text: 'done', citations: null }]),
      envelope({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }),
      envelope({ type: 'message_stop' }),
      result({
        modelUsage: {
          'claude-haiku-4-5': { inputTokens: 70_000, outputTokens: 12 },
          'claude-opus-5-5': {
            inputTokens: 15,
            outputTokens: 70,
            cacheReadInputTokens: 2210,
            cacheCreationInputTokens: 260,
          },
        },
      }),
    ])
    expect(second.slice(-2)).toEqual([
      {
        type: 'usage',
        usage: { inputTokens: 5, outputTokens: 69, cacheReadTokens: 1210, cacheWriteTokens: 60 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ])
    // The SDK aggregate, including auxiliary models, stays in the snapshot.
    expect(tracker.snapshot.inputTokens).toBe(70_015)
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

  it.each([
    [
      'a regex range',
      String.raw`{"command":"grep -P '[\\u3040-\\u309f]' notes.txt"}`,
      { command: "grep -P '[\u3040-\u309f]' notes.txt" },
    ],
    [
      'a surrogate pair inside generated code',
      String.raw`{"path":"/a.ts","content":"const face = '\\ud83d\\ude00'"}`,
      { path: '/a.ts', content: "const face = '\u{1f600}'" },
    ],
    [
      'an escaped backslash and a control escape that Claude Code leaves alone',
      String.raw`{"command":"printf '\\\\u0041 \\u0009 \\u00e9'"}`,
      { command: String.raw`printf '\\u0041 \u0009 ` + "\u00e9'" },
    ],
  ])(
    'reconciles %s that Claude Code unescaped and keeps the emitted arguments for DSH',
    (_name, emitted, completedInput) => {
      const translator = new ClaudeOutputTranslator(new UsageTracker())
      const chunks = acceptAll(translator, [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: {
            type: 'tool_use',
            id: 'toolu_unicode',
            name: 'mcp__dsh__bash',
            input: {},
          },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: emitted },
        }),
        assistant([
          { type: 'tool_use', id: 'toolu_unicode', name: 'mcp__dsh__bash', input: completedInput },
        ]),
        envelope({ type: 'content_block_stop', index: 0 }),
      ])
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
      expect(translator.toolCalls).toEqual([
        { type: 'tool-call', id: 'toolu_unicode', name: 'bash', arguments: emitted },
      ])
    },
  )

  it.each([
    ['a different character', String.raw`{"command":"echo \\u3040"}`, { command: 'echo \u3041' }],
    [
      'an escape Claude Code would not have produced',
      '{"command":"echo \u3040"}',
      { command: String.raw`echo \u3040` },
    ],
    [
      'an unescaped Windows path',
      String.raw`{"command":"type C:\\users\\u00e9"}`,
      { command: 'type C:\\users\u00e9' },
    ],
  ])('still rejects completed arguments that differ by %s', (_name, emitted, completedInput) => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    acceptAll(translator, [
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_unicode', name: 'mcp__dsh__bash', input: {} },
      }),
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: emitted },
      }),
      assistant([
        { type: 'tool_use', id: 'toolu_unicode', name: 'mcp__dsh__bash', input: completedInput },
      ]),
    ])
    expect(() => translator.accept(envelope({ type: 'content_block_stop', index: 0 }))).toThrow(
      /did not reconcile/,
    )
  })

  it('describes the first reconciliation difference in failure evidence', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    let thrown: unknown
    try {
      acceptAll(translator, [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__bash', input: {} },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' },
        }),
        assistant([
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__edit', input: { command: 'echo hi' } },
        ]),
        envelope({ type: 'content_block_stop', index: 0 }),
      ])
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ClaudePluginError)
    expect(describeFailureDetail(thrown)).toMatchObject({
      partialBlocks: 1,
      completedBlocks: 1,
      firstDifference: 'index:0:name',
    })
  })

  it('describes a block count mismatch in failure evidence', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    let thrown: unknown
    try {
      acceptAll(translator, [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__bash', input: {} },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' },
        }),
        assistant([
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__bash', input: { command: 'echo hi' } },
          { type: 'tool_use', id: 'toolu_2', name: 'mcp__dsh__bash', input: {} },
        ]),
        envelope({ type: 'content_block_stop', index: 0 }),
      ])
    } catch (error) {
      thrown = error
    }
    expect(describeFailureDetail(thrown)).toMatchObject({
      partialBlocks: 1,
      completedBlocks: 2,
      firstDifference: 'count:1:2',
    })
  })

  it('describes a completed text mismatch beside a matching tool call in failure evidence', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    let thrown: unknown
    try {
      acceptAll(translator, [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__bash', input: {} },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' },
        }),
        envelope({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '', citations: null },
        }),
        envelope({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'streamed note' },
        }),
        assistant([
          { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__bash', input: { command: 'echo hi' } },
          { type: 'text', text: 'altered note' },
        ]),
        envelope({ type: 'content_block_stop', index: 0 }),
        envelope({ type: 'content_block_stop', index: 1 }),
      ])
    } catch (error) {
      thrown = error
    }
    expect(describeFailureDetail(thrown)).toMatchObject({
      partialBlocks: 2,
      completedBlocks: 2,
      firstDifference: 'index:1:content',
    })
  })

  it('describes a completed block type mismatch in failure evidence', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    let thrown: unknown
    try {
      acceptAll(translator, [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'mcp__dsh__bash', input: {} },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' },
        }),
        envelope({
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'text', text: '', citations: null },
        }),
        envelope({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'note' },
        }),
        assistant([
          { type: 'text', text: 'note' },
          { type: 'tool_use', id: 'toolu_9', name: 'mcp__dsh__bash', input: { command: 'echo hi' } },
        ]),
        envelope({ type: 'content_block_stop', index: 0 }),
        envelope({ type: 'content_block_stop', index: 1 }),
      ])
    } catch (error) {
      thrown = error
    }
    expect(describeFailureDetail(thrown)).toMatchObject({
      partialBlocks: 2,
      completedBlocks: 2,
      firstDifference: 'index:0:type:tool-call:text',
    })
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

  it('ignores unknown stream event types to tolerate new SDK events like ping', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    const unknownEvent = envelope({ type: 'ping', timestamp: Date.now() })
    const chunks = translator.accept(unknownEvent)
    expect(chunks).toEqual([])
    expect(translator.complete).toBe(false)

    const anotherUnknown = envelope({ type: 'heartbeat', interval: 1000 })
    const moreChunks = translator.accept(anotherUnknown)
    expect(moreChunks).toEqual([])

    const finalChunks = acceptAll(translator, [
      envelope({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: 'after unknown', citations: null },
      }),
      envelope({ type: 'content_block_stop', index: 0 }),
      assistant([{ type: 'text', text: 'after unknown', citations: null }]),
      result(),
    ])
    expect(finalChunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
    expect(translator.complete).toBe(true)
  })

  it('tracks ignored event types in the usage record for diagnostics', () => {
    const usage = new UsageTracker()
    const translator = new ClaudeOutputTranslator(usage)
    translator.accept(envelope({ type: 'ping', timestamp: 1 }))
    translator.accept(envelope({ type: 'ping', timestamp: 2 }))
    translator.accept(envelope({ type: 'heartbeat', interval: 1000 }))

    expect(usage.snapshot.ignoredEventTypes).toEqual({ ping: 2, heartbeat: 1 })
  })
})

describe('Claude model refusal', () => {
  const explanation = 'This request looks like it targets systems you do not own.'
  const fallbackBlock = {
    type: 'fallback',
    from: { model: 'claude-opus-4-1' },
    to: { model: 'claude-sonnet-4-5' },
    trigger: { type: 'refusal', category: 'cyber' },
  }
  const refusalNotice = (subtype: string) =>
    sdk({
      type: 'system',
      subtype,
      trigger: 'refusal',
      direction: 'retry',
      original_model: 'claude-opus-4-1',
      fallback_model: 'claude-sonnet-4-5',
      request_id: null,
      api_refusal_category: 'cyber',
      api_refusal_explanation: explanation,
      content: 'Switched to a fallback model',
      uuid: crypto.randomUUID(),
      session_id: session,
    })

  it.each([
    ['a refusal-fallback notice', [refusalNotice('model_refusal_fallback')], explanation],
    ['a no-fallback refusal notice', [refusalNotice('model_refusal_no_fallback')], explanation],
    [
      'a streamed fallback block',
      [
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'Let me look at', citations: null },
        }),
        envelope({ type: 'content_block_stop', index: 0 }),
        envelope({ type: 'content_block_start', index: 1, content_block: fallbackBlock }),
      ],
      'cyber',
    ],
    ['a completed fallback block', [assistant([fallbackBlock])], 'cyber'],
    ['a refusal stop reason', [result({ stop_reason: 'refusal' })], 'declined'],
  ])('ends the turn as a visible refusal on %s', (_name, messages, visible) => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    const chunks = acceptAll(translator, messages)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: {
        kind: 'error',
        failure: { code: 'CLAUDE_MODEL_REFUSAL', message: expect.stringContaining(visible) },
      },
    })
    expect(translator.complete).toBe(true)
  })

  it('keeps other unknown content types as protocol errors', () => {
    const mystery = { type: 'mystery' }
    for (const messages of [
      [envelope({ type: 'content_block_start', index: 0, content_block: mystery })],
      [assistant([mystery])],
    ]) {
      expect(() => acceptAll(new ClaudeOutputTranslator(new UsageTracker()), messages)).toThrow(
        expect.objectContaining({ code: 'CLAUDE_PROTOCOL_ERROR' }),
      )
    }
  })
})
