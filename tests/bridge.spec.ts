import { describe, expect, it, vi } from 'vitest'
import type { SDKMessage, SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, Message, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import {
  BridgeManager,
  type AttachmentReader,
  ClaudeCodeAdapter,
  type ClaudeQuery,
  type ClaudeQueryFactory,
  type ClaudeQueryRequest,
  resolveConfig,
} from '../src/index.js'
import { AsyncQueue } from '../src/async-queue.js'

const sdkSession = '11111111-1111-4111-8111-111111111111'

function sdk(value: unknown): SDKMessage {
  return value as SDKMessage
}

function envelope(event: unknown): SDKMessage {
  return sdk({
    type: 'stream_event',
    event,
    parent_tool_use_id: null,
    uuid: crypto.randomUUID(),
    session_id: sdkSession,
  })
}

function textTurn(text: string, inputTokens: number, outputTokens: number): SDKMessage[] {
  return [
    envelope({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: null },
    }),
    ...[...text].map((character) =>
      envelope({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: character },
      }),
    ),
    envelope({ type: 'content_block_stop', index: 0 }),
    sdk({
      type: 'assistant',
      message: {
        id: crypto.randomUUID(),
        role: 'assistant',
        model: 'sonnet',
        content: [{ type: 'text', text, citations: null }],
      },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
      session_id: sdkSession,
    }),
    sdk({
      type: 'result',
      subtype: 'success',
      is_error: false,
      stop_reason: 'end_turn',
      modelUsage: {
        sonnet: {
          inputTokens,
          outputTokens,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
      uuid: crypto.randomUUID(),
      session_id: sdkSession,
    }),
  ]
}

function errorTurn(): SDKMessage[] {
  return [
    sdk({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      stop_reason: null,
      errors: ['No conversation found for resume target'],
      modelUsage: {},
      uuid: crypto.randomUUID(),
      session_id: sdkSession,
    }),
  ]
}

function user(id: string, text: string): Message {
  return {
    id: id as never,
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

function assistant(id: string, text: string, model = 'default', replayState?: unknown): Message {
  return {
    id: id as never,
    role: 'assistant',
    content: [{ type: 'text', text }],
    source: {
      kind: 'model',
      provider: 'claude-sdk-local',
      model,
      ...(replayState === undefined ? {} : { replayState }),
    },
  }
}

function request(
  messages: Message[],
  sessionId: string,
  extra: Partial<GenerateOptions> = {},
): GenerateOptions {
  return {
    provider: 'claude-sdk-local',
    model: 'default',
    messages,
    sessionId: sessionId as never,
    system: 'DSH owns the harness.',
    ...extra,
  }
}

async function collect(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const values: StreamChunk[] = []
  for await (const value of iterable) values.push(value)
  return values
}

async function collectUntilFinish(iterable: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const values: StreamChunk[] = []
  for await (const value of iterable) {
    values.push(value)
    if (value.type === 'finish') break
  }
  return values
}

class FakeQuery implements ClaudeQuery {
  readonly output = new AsyncQueue<SDKMessage>()
  readonly inputs: SDKUserMessage[] = []
  readonly models: string[] = []
  readonly efforts: Array<string | null | undefined> = []
  closed = false
  readonly consumed: Promise<void>

  constructor(
    prompt: AsyncIterable<SDKUserMessage>,
    readonly onTurn: (query: FakeQuery, turn: number) => Promise<void> | void,
  ) {
    this.consumed = this.#consume(prompt)
  }

  async #consume(prompt: AsyncIterable<SDKUserMessage>): Promise<void> {
    let turn = 0
    try {
      for await (const input of prompt) {
        this.inputs.push(input)
        if (input.shouldQuery === true) await this.onTurn(this, turn++)
      }
    } catch {
      // Bridge invalidation deliberately fails the SDK input queue.
    }
  }

  emit(messages: readonly SDKMessage[]): void {
    for (const message of messages) this.output.push(message)
  }

  fail(error: unknown): void {
    this.output.fail(error)
  }

  setModel(model: string): Promise<void> {
    this.models.push(model)
    return Promise.resolve()
  }

  applyFlagSettings(settings: { effortLevel?: string | null }): Promise<void> {
    this.efforts.push(settings.effortLevel)
    return Promise.resolve()
  }

  interrupt(): Promise<void> {
    return Promise.resolve()
  }

  close(): void {
    this.closed = true
    this.output.close()
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return this.output
  }
}

function harness(
  onTurn: (query: FakeQuery, turn: number, queryIndex: number) => Promise<void> | void,
  config = resolveConfig({ defaultModel: 'sonnet' }),
  attachments?: AttachmentReader,
) {
  const requests: ClaudeQueryRequest[] = []
  const queries: FakeQuery[] = []
  const queryFactory: ClaudeQueryFactory = (queryRequest) => {
    const queryIndex = requests.length
    requests.push(queryRequest)
    const query = new FakeQuery(queryRequest.prompt, (current, turn) =>
      onTurn(current, turn, queryIndex),
    )
    queries.push(query)
    return query
  }
  const resolveExecutable = vi.fn(() => Promise.resolve('/usr/local/bin/claude'))
  const subprocess = { resolveExecutable } as unknown as SubprocessRuntime
  const manager = new BridgeManager(subprocess, config, queryFactory, attachments)
  const adapter = new ClaudeCodeAdapter(config, manager)
  return { adapter, manager, queries, requests, resolveExecutable }
}

describe('per-session Claude bridge', () => {
  it('closes a truncated query before exposing its finish and does not promise native resume', async () => {
    const fixture = harness((q) => {
      const events = textTurn('partial', 1, 1).slice(0, -1)
      q.emit([
        envelope({
          type: 'message_start',
          message: { usage: { input_tokens: 7, output_tokens: 1 } },
        }),
        ...events,
        envelope({
          type: 'message_delta',
          delta: { stop_reason: 'max_tokens' },
          usage: { output_tokens: 128 },
        }),
      ])
    })
    try {
      const chunks = await collect(
        fixture.adapter.stream(request([user('u1', 'long answer')], 'bounded', { maxTokens: 128 })),
      )
      expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'max-tokens' } })
      expect(fixture.queries[0]?.closed).toBe(true)
      expect(fixture.manager.activeBridgeCount).toBe(0)
    } finally {
      await fixture.manager.dispose()
    }
  })
  it('applies maxTokens at process start and rebuilds when that limit changes', async () => {
    const fixture = harness((q) => q.emit(textTurn('summary', 1, 1)))
    const initial = [user('u1', 'summarize')]
    try {
      const first = await collect(
        fixture.adapter.stream(
          request(initial, 'summary', { purpose: 'compaction', maxTokens: 8192 }),
        ),
      )
      expect(first.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
      expect(fixture.requests[0]?.options.env).toMatchObject({
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
      })
      const second = await collect(
        fixture.adapter.stream(
          request([...initial, assistant('a1', 'summary'), user('u2', 'shorter')], 'summary', {
            purpose: 'compaction',
            maxTokens: 1024,
          }),
        ),
      )
      expect(second.at(-1)).toMatchObject({ reason: { kind: 'stop' } })
      expect(fixture.requests).toHaveLength(2)
      expect(fixture.requests[1]?.options.env).toMatchObject({
        CLAUDE_CODE_MAX_OUTPUT_TOKENS: '1024',
      })
    } finally {
      await fixture.manager.dispose()
    }
  })
  it('starts an isolated SDK query and streams one complete text turn', async () => {
    const fixture = harness((query) => query.emit(textTurn('hello', 7, 5)))
    const chunks = await collect(
      fixture.adapter.stream(
        request([user('u1', 'hi')], 'session-a', { reasoningEffort: 'high' as never }),
      ),
    )
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toHaveLength(5)
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
      replayState: { response: { kind: 'dsh-claude-plugin/replay', phase: 'settled' } },
    })
    expect(chunks.filter((chunk) => chunk.type === 'finish')).toHaveLength(1)
    expect(fixture.resolveExecutable).toHaveBeenCalledWith('claude', undefined, undefined)
    const sdkOptions = fixture.requests[0]?.options
    expect(sdkOptions).toMatchObject({
      allowedTools: ['mcp__dsh__*'],
      cwd: process.cwd(),
      hooks: {},
      includePartialMessages: true,
      managedSettings: { disableAllHooks: true },
      mcpServers: { dsh: expect.objectContaining({ type: 'sdk', name: 'dsh' }) },
      model: 'sonnet',
      effort: 'high',
      pathToClaudeCodeExecutable: '/usr/local/bin/claude',
      permissionMode: 'dontAsk',
      persistSession: true,
      plugins: [],
      settings: { disableAllHooks: true },
      settingSources: [],
      skills: [],
      strictMcpConfig: true,
      systemPrompt: 'DSH owns the harness.',
      tools: [],
    })
    expect(sdkOptions?.spawnClaudeCodeProcess).toBeTypeOf('function')
    expect(fixture.queries[0]?.inputs).toHaveLength(1)
    await fixture.manager.dispose()
  })

  it('resolves a durable DSH image into the live SDK prompt without changing history', async () => {
    const attachment: ImageAttachmentRef = {
      attachmentId: 'sha256:bridge-image' as never,
      mediaType: 'image/png',
      bytes: 4,
      width: 1,
      height: 1,
    }
    const readImageRequest = vi.fn(async () => ({
      variantId: 'variant:bridge-image' as never,
      attachment,
      data: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]),
      mediaType: 'image/png' as const,
      bytes: 4,
      width: 1,
      height: 1,
      depth: 'uchar' as const,
      space: 'srgb' as const,
      hasAlpha: true,
    }))
    const attachments: AttachmentReader = {
      imageLimits: {
        maxImageBytes: 8 * 1_024 * 1_024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 20 * 1_024 * 1_024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8_000,
        mediaTypes: ['image/png'],
      },
      readImageRequest,
    }
    const fixture = harness(
      (query) => query.emit(textTurn('seen', 2, 1)),
      resolveConfig(),
      attachments,
    )
    const imageMessage: Message = {
      id: 'image-message' as never,
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text: 'describe' },
        { type: 'image', attachment },
      ],
    }
    const chunks = await collect(fixture.adapter.stream(request([imageMessage], 'image-session')))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(readImageRequest).toHaveBeenCalledOnce()
    expect(fixture.queries[0]?.inputs[0]?.message.content).toEqual([
      { type: 'text', text: 'describe' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'iVBORw==' },
      },
    ])
    expect(imageMessage.content[1]).toEqual({ type: 'image', attachment })
    await fixture.manager.dispose()
  })

  it('reuses context, changes model and effort between turns, and subtracts cumulative usage', async () => {
    const fixture = harness((query, turn) => {
      query.emit(turn === 0 ? textTurn('one', 10, 3) : textTurn('two', 16, 8))
    })
    const u1 = user('u1', 'first')
    await collect(fixture.adapter.stream(request([u1], 'session-a')))
    const chunks = await collect(
      fixture.adapter.stream(
        request([u1, assistant('a1', 'one'), user('u2', 'second')], 'session-a', {
          model: 'opus',
          reasoningEffort: 'medium' as never,
        }),
      ),
    )
    expect(fixture.queries).toHaveLength(1)
    expect(fixture.queries[0]?.models).toEqual(['opus'])
    expect(fixture.queries[0]?.efforts).toEqual(['medium'])
    expect(chunks.find((chunk) => chunk.type === 'usage')).toEqual({
      type: 'usage',
      usage: {
        inputTokens: 6,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    })
    await fixture.manager.dispose()
  })

  it('commits a successful turn before a finish-first consumer stops iteration', async () => {
    const fixture = harness((query, turn) =>
      query.emit(turn === 0 ? textTurn('one', 1, 1) : textTurn('two', 2, 2)),
    )
    const u1 = user('u1', 'first')
    const first = await collectUntilFinish(
      fixture.adapter.stream(request([u1], 'finish-first-session')),
    )
    expect(first.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })

    await collect(
      fixture.adapter.stream(
        request([u1, assistant('a1', 'one'), user('u2', 'second')], 'finish-first-session'),
      ),
    )
    expect(fixture.queries).toHaveLength(1)
    expect(fixture.queries[0]?.inputs).toHaveLength(2)
    await fixture.manager.dispose()
  })

  it('cold-resumes an exact durable prefix by forking at the stored Claude entry', async () => {
    const first = harness((query) => query.emit(textTurn('one', 10, 3)))
    const u1 = user('u1', 'remember blue')
    const firstChunks = await collect(first.adapter.stream(request([u1], 'session-a')))
    const replayState = firstChunks.find((chunk) => chunk.type === 'finish')?.replayState
    expect(replayState).toBeDefined()
    await first.manager.dispose()

    const resumed = harness((query) => query.emit(textTurn('two', 2, 2)))
    const followUp = 'what did I ask you to remember?'
    const u2 = user('u2', followUp)
    const chunks = await collect(
      resumed.adapter.stream(
        request([u1, assistant('a1', 'one', 'default', replayState), u2], 'session-a'),
      ),
    )
    expect(resumed.requests[0]?.options).toMatchObject({
      resume: sdkSession,
      forkSession: true,
    })
    expect(resumed.requests[0]?.options.resumeSessionAt).toMatch(/^[0-9a-f]{8}-[0-9a-f-]{27}$/)
    expect(resumed.queries[0]?.inputs).toHaveLength(1)
    expect(resumed.queries[0]?.inputs[0]?.message).toEqual({
      role: 'user',
      content: [{ type: 'text', text: followUp }],
    })
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.text)
        .join(''),
    ).toBe('two')
    await resumed.manager.dispose()
  })

  it('falls back to degraded replay when an exact resume target is unavailable', async () => {
    const seed = harness((query) => query.emit(textTurn('one', 1, 1)))
    const u1 = user('u1', 'remember this')
    const seedChunks = await collect(seed.adapter.stream(request([u1], 'session-a')))
    const replayState = seedChunks.find((chunk) => chunk.type === 'finish')?.replayState
    await seed.manager.dispose()

    const recovered = harness((query, _turn, queryIndex) =>
      query.emit(queryIndex === 0 ? errorTurn() : textTurn('recovered', 1, 1)),
    )
    const chunks = await collect(
      recovered.adapter.stream(
        request(
          [u1, assistant('a1', 'one', 'default', replayState), user('u2', 'continue')],
          'session-a',
        ),
      ),
    )
    expect(recovered.queries).toHaveLength(2)
    expect(recovered.requests[0]?.options.resume).toBe(sdkSession)
    expect(recovered.requests[1]?.options.resume).toBeUndefined()
    expect(recovered.queries[1]?.inputs[0]?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('DSH degraded transcript replay'),
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await recovered.manager.dispose()
  })

  it('evicts only settled idle sessions and closes their live query', async () => {
    vi.useFakeTimers()
    try {
      const fixture = harness(
        (query) => query.emit(textTurn('idle', 1, 1)),
        resolveConfig({ sessionIdleMs: 100 }),
      )
      await collect(fixture.adapter.stream(request([user('u1', 'go')], 'idle-session')))
      expect(fixture.manager.activeBridgeCount).toBe(1)
      expect(fixture.queries[0]?.closed).toBe(false)
      await vi.advanceTimersByTimeAsync(101)
      expect(fixture.manager.activeBridgeCount).toBe(0)
      expect(fixture.queries[0]?.closed).toBe(true)
      await fixture.manager.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries one pre-observable transport crash with degraded durable history', async () => {
    const fixture = harness((query, _turn, queryIndex) => {
      if (queryIndex === 0) query.fail(new Error('fixture process crashed'))
      else query.emit(textTurn('recovered', 1, 1))
    })
    const chunks = await collect(
      fixture.adapter.stream(request([user('u1', 'recover this')], 'retry-session')),
    )
    expect(fixture.queries).toHaveLength(2)
    expect(fixture.queries[0]?.closed).toBe(true)
    expect(fixture.queries[1]?.inputs[0]?.message.content[0]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('DSH degraded transcript replay'),
    })
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    await fixture.manager.dispose()
  })

  it('does not retry after any current-generation output became observable', async () => {
    const fixture = harness((query) => {
      query.emit([
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'visible' },
        }),
      ])
      queueMicrotask(() => query.fail(new Error('crashed after output')))
    })
    const chunks = await collect(
      fixture.adapter.stream(request([user('u1', 'do not duplicate')], 'observed-session')),
    )
    expect(fixture.queries).toHaveLength(1)
    expect(chunks.filter((chunk) => chunk.type === 'text-delta')).toEqual([
      { type: 'text-delta', index: 0, text: 'visible' },
    ])
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CLAUDE_TRANSPORT_ERROR' } },
    })
    await fixture.manager.dispose()
  })

  it('reports the protocol failure when closing the SDK query also throws', async () => {
    const fixture = harness((query) => {
      const close = query.close.bind(query)
      query.close = () => {
        close()
        throw new Error('fixture close failed')
      }
      query.emit([
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'orphan' },
        }),
      ])
    })
    const chunks = await collect(
      fixture.adapter.stream(request([user('u1', 'malformed')], 'close-failure-session')),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'error', failure: { code: 'CLAUDE_PROTOCOL_ERROR' } },
    })
    await fixture.manager.dispose()
  })

  it('isolates different DSH sessions into different SDK queries', async () => {
    const fixture = harness((query, _turn, queryIndex) =>
      query.emit(textTurn(`answer-${queryIndex}`, 1, 1)),
    )
    await Promise.all([
      collect(fixture.adapter.stream(request([user('a', 'a')], 'session-a'))),
      collect(fixture.adapter.stream(request([user('b', 'b')], 'session-b'))),
    ])
    expect(fixture.queries).toHaveLength(2)
    expect(fixture.resolveExecutable).toHaveBeenCalledTimes(2)
    await fixture.manager.dispose()
  })

  it('serializes concurrent turns for the same DSH session', async () => {
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const fixture = harness(async (query, turn) => {
      if (turn === 0) await gate
      query.emit(turn === 0 ? textTurn('one', 1, 1) : textTurn('two', 2, 2))
    })
    const u1 = user('u1', 'first')
    const first = collect(fixture.adapter.stream(request([u1], 'session-a')))
    await vi.waitFor(() => expect(fixture.queries[0]?.inputs).toHaveLength(1))
    const second = collect(
      fixture.adapter.stream(
        request([u1, assistant('a1', 'one'), user('u2', 'second')], 'session-a', {
          model: 'opus',
        }),
      ),
    )
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(fixture.queries[0]?.inputs).toHaveLength(1)
    expect(fixture.queries[0]?.models).toEqual([])
    releaseFirst()
    await Promise.all([first, second])
    expect(fixture.queries[0]?.inputs).toHaveLength(2)
    expect(fixture.queries[0]?.models).toEqual(['opus'])
    await fixture.manager.dispose()
  })

  it('aborts before output and during output without leaving a reusable bridge', async () => {
    const before = harness(() => undefined)
    const beforeController = new AbortController()
    beforeController.abort('cancelled')
    expect(
      await collect(
        before.adapter.stream(
          request([user('u', 'go')], 'before', { signal: beforeController.signal }),
        ),
      ),
    ).toEqual([
      {
        type: 'finish',
        reason: {
          kind: 'aborted',
          failure: expect.objectContaining({ code: 'CLAUDE_ABORTED' }),
        },
      },
    ])
    expect(before.queries).toHaveLength(0)

    const duringController = new AbortController()
    const during = harness((query) => {
      query.emit([
        envelope({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '', citations: null },
        }),
        envelope({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text: 'partial' },
        }),
      ])
      queueMicrotask(() => duringController.abort('stop'))
    })
    const chunks = await collect(
      during.adapter.stream(
        request([user('u', 'go')], 'during', { signal: duringController.signal }),
      ),
    )
    expect(chunks.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'aborted', failure: { code: 'CLAUDE_ABORTED' } },
    })
    expect(during.queries[0]?.closed).toBe(true)
    await Promise.all([before.manager.dispose(), during.manager.dispose()])
  })

  it('removes the request abort listener after a successful result', async () => {
    const controller = new AbortController()
    const fixture = harness((query, turn) =>
      query.emit(turn === 0 ? textTurn('one', 1, 1) : textTurn('two', 2, 2)),
    )
    const u1 = user('u1', 'first')
    await collect(fixture.adapter.stream(request([u1], 'session-a', { signal: controller.signal })))
    controller.abort('late')
    expect(fixture.queries[0]?.closed).toBe(false)
    await collect(
      fixture.adapter.stream(
        request([u1, assistant('a1', 'one'), user('u2', 'second')], 'session-a'),
      ),
    )
    expect(fixture.queries).toHaveLength(1)
    await fixture.manager.dispose()
  })

  it('rebuilds from canonical history when the system prompt changes', async () => {
    const fixture = harness((query) => query.emit(textTurn('one', 1, 1)))
    const u1 = user('u1', 'first')
    await collect(fixture.adapter.stream(request([u1], 'session-a')))
    const changed = await collect(
      fixture.adapter.stream(
        request([u1, assistant('a1', 'one'), user('u2', 'second')], 'session-a', {
          system: 'changed',
        }),
      ),
    )
    expect(changed.at(-1)).toMatchObject({
      type: 'finish',
      reason: { kind: 'stop' },
    })
    expect(fixture.queries).toHaveLength(2)
    expect(fixture.requests[1]?.options.systemPrompt).toBe('changed')
    expect(fixture.queries[0]?.closed).toBe(true)
    await fixture.manager.dispose()
  })

  it('continues a pruned image history and recovers an over-budget replay through DSH image offload', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47])
    const ref = (index: number): ImageAttachmentRef => ({
      attachmentId: `sha256:shot-${index}` as never,
      mediaType: 'image/png',
      bytes: png.byteLength,
      width: 1,
      height: 1,
    })
    const attachments: AttachmentReader = {
      imageLimits: {
        maxImageBytes: 8 * 1_024 * 1_024,
        maxImagesPerMessage: 20,
        maxMessageImageBytes: 20 * 1_024 * 1_024,
        maxImagePixels: 64_000_000,
        maxImageDimension: 8_000,
        mediaTypes: ['image/png'],
      },
      readImageRequest: vi.fn(async (attachment: ImageAttachmentRef) => ({
        variantId: `variant:${String(attachment.attachmentId)}` as never,
        attachment,
        data: png,
        mediaType: 'image/png' as const,
        bytes: png.byteLength,
        width: 1,
        height: 1,
        depth: 'uchar' as const,
        space: 'srgb' as const,
        hasAlpha: true,
      })),
    }
    const screenshots = (id: string, text: string, from: number, count: number): Message => ({
      id: id as never,
      role: 'user',
      source: { kind: 'user' },
      content: [
        { type: 'text', text },
        ...Array.from({ length: count }, (_, index) => ({
          type: 'image' as const,
          attachment: ref(from + index),
        })),
      ],
    })
    const fixture = harness(
      (query, _turn, queryIndex) => query.emit(textTurn(queryIndex === 0 ? 'one' : 'next', 1, 1)),
      resolveConfig(),
      attachments,
    )
    const replayOf = (queryIndex: number) => {
      const content = fixture.queries[queryIndex]?.inputs[0]?.message.content
      if (content === undefined || typeof content === 'string') throw new Error('expected blocks')
      return {
        images: content.filter((block) => block.type === 'image').length,
        transcript: content[0]?.type === 'text' ? content[0].text : '',
      }
    }
    try {
      const u1 = screenshots('u1', `tool output ${'x'.repeat(4_000)}`, 0, 15)
      const u2 = screenshots('u2', 'more screenshots', 15, 14)
      await collect(fixture.adapter.stream(request([u1], 'pruned-images')))
      await collect(
        fixture.adapter.stream(request([u1, assistant('a1', 'one'), u2], 'pruned-images')),
      )
      expect(fixture.queries).toHaveLength(1)

      const pruned = screenshots('u1', 'tool output [middle pruned]', 0, 15)
      const continued = await collect(
        fixture.adapter.stream(
          request(
            [
              pruned,
              assistant('a1', 'one'),
              u2,
              assistant('a2', 'one'),
              user('u3', 'text-only follow-up'),
            ],
            'pruned-images',
          ),
        ),
      )
      expect(continued.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      expect(replayOf(1).images).toBe(29)
      expect(replayOf(1).transcript).toContain('text-only follow-up')

      const oversized = (first: Message): Message[] => [
        first,
        ...Array.from({ length: 5 }, (_, index) => [
          assistant(`reply-${index}`, 'noted'),
          screenshots(`more-${index}`, 'batch', 20 + index * 20, index === 4 ? 1 : 20),
        ]).flat(),
        assistant('reply-last', 'noted'),
        user('ask', 'still there?'),
      ]
      const first = screenshots('first', 'batch', 0, 20)
      const rejected = await collect(
        fixture.adapter.stream(request(oversized(first), 'over-budget')),
      )
      expect(rejected).toEqual([
        {
          type: 'finish',
          reason: {
            kind: 'error',
            failure: expect.objectContaining({ code: 'IMAGE_OFFLOAD_REQUIRED', offloadImages: 1 }),
          },
        },
      ])

      const offloaded: Message = {
        ...first,
        content: first.content.map((block, index) =>
          block.type === 'image' && index === 1 ? { ...block, offloaded: true as const } : block,
        ),
      }
      const recovered = await collect(
        fixture.adapter.stream(request(oversized(offloaded), 'over-budget')),
      )
      expect(recovered.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
      const replay = replayOf(fixture.queries.length - 1)
      expect(replay.images).toBe(100)
      expect(
        replay.transcript.match(/image omitted to fit request image limits; sha256:shot-\d+\./g),
      ).toEqual(['image omitted to fit request image limits; sha256:shot-0.'])
    } finally {
      await fixture.manager.dispose()
    }
  })
})
