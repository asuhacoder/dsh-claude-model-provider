import { describe, expect, it } from 'vitest'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import { ClaudeOutputTranslator } from '../src/output.js'
import { UsageTracker } from '../src/usage.js'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'

const sdk = (value: unknown) =>
  ({ session_id: 'fixture', parent_tool_use_id: null, ...(value as object) }) as SDKMessage
const partial = (event: unknown) => sdk({ type: 'stream_event', event })
function tool(translator: ClaudeOutputTranslator, id: string, name: string, index = 0) {
  return [
    partial({
      type: 'content_block_start',
      index,
      content_block: { type: 'tool_use', id, name, input: {} },
    }),
    partial({
      type: 'content_block_delta',
      index,
      delta: { type: 'input_json_delta', partial_json: '{"command":"NOOP"}' },
    }),
    sdk({
      type: 'assistant',
      uuid: id,
      message: { content: [{ type: 'tool_use', id, name, input: { command: 'NOOP' } }] },
    }),
    partial({ type: 'content_block_stop', index }),
  ].flatMap((message) => translator.accept(message))
}
const denial = (
  id: string,
  content = '<tool_use_error>Error: No such tool available: bash</tool_use_error>',
  isError = true,
) =>
  sdk({
    type: 'user',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content }],
    },
  })
const result = () =>
  sdk({
    type: 'result',
    subtype: 'success',
    is_error: false,
    stop_reason: 'end_turn',
    modelUsage: {},
  })
const recovering = () => new ClaudeOutputTranslator(new UsageTracker(), false, true)
const recoveringWithCatalog = (tools: string[]) =>
  new ClaudeOutputTranslator(new UsageTracker(), false, true, new Set(tools))

describe('SDK rejection of unavailable tools', () => {
  it('lets the SDK reject a bare tool, then exposes only the corrected DSH MCP call', () => {
    const translator = recovering()
    expect(tool(translator, 'bad', 'bash')).toEqual([])
    expect(translator.accept(denial('bad'))).toEqual([])
    const chunks = tool(translator, 'good', 'mcp__dsh__bash')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(translator.toolCalls.map((call) => [call.id, call.name])).toEqual([['good', 'bash']])
  })

  it('does not release a valid parallel call before the unavailable call is proven rejected', () => {
    const translator = recovering()
    tool(translator, 'bad', 'bash')
    const chunks = tool(translator, 'good', 'mcp__dsh__bash', 1)
    expect(chunks.some((chunk) => chunk.type === 'finish')).toBe(false)
    expect(translator.complete).toBe(false)
    expect(translator.accept(denial('bad'))).toEqual([
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ])
  })

  it.each([
    ['missing rejection', undefined],
    ['ordinary failure after possible execution', denial('bad', 'command failed')],
    ['a successful result', denial('bad', undefined, false)],
    ['a different call ID', denial('other')],
    [
      'a different tool name',
      denial('bad', '<tool_use_error>Error: No such tool available: write</tool_use_error>'),
    ],
  ])('keeps a %s fail-closed', (_name, receipt) => {
    const translator = recovering()
    tool(translator, 'bad', 'bash')
    if (receipt) translator.accept(receipt)
    expect(() => translator.accept(result())).toThrow(/non-DSH tool/)
  })

  it('keeps the public translator strict unless the managed bridge enables recovery', () => {
    const translator = new ClaudeOutputTranslator(new UsageTracker())
    expect(() => tool(translator, 'bad', 'bash')).toThrow(/non-DSH tool/)
  })

  it('preserves the corrected call when the next SDK generation reuses a closed block index', () => {
    const translator = recovering()
    const assembler = new BlockAssembler()
    const first = [
      partial({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'thinking', thinking: 'planning' },
      }),
      sdk({
        type: 'assistant',
        message: { content: [{ type: 'thinking', thinking: 'planning' }] },
      }),
      partial({ type: 'content_block_stop', index: 0 }),
    ].flatMap((message) => translator.accept(message))
    const bad = tool(translator, 'bad', 'bash', 1)
    const rejected = translator.accept(denial('bad'))
    const corrected = tool(translator, 'good', 'mcp__dsh__bash', 0)
    for (const chunk of [...first, ...bad, ...rejected, ...corrected]) assembler.push(chunk)
    expect(
      assembler
        .blocks()
        .filter((block) => block.type === 'tool-call')
        .map((call) => call.id),
    ).toEqual(['good'])
  })
})

describe('Unknown DSH tool recovery', () => {
  it('ignores a DSH-prefixed tool not in the catalog and marks it as already denied', () => {
    const translator = recoveringWithCatalog(['bash', 'read'])
    const unknownChunks = tool(translator, 'bad', 'mcp__dsh__press_key')
    expect(unknownChunks).toEqual([])
    expect(translator.complete).toBe(false)
    expect(translator.toolCalls).toHaveLength(0)
  })

  it('processes known DSH tools normally alongside unknown ones', () => {
    const translator = recoveringWithCatalog(['bash'])
    const unknownChunks = tool(translator, 'bad', 'mcp__dsh__press_key')
    expect(unknownChunks).toEqual([])
    const knownChunks = tool(translator, 'good', 'mcp__dsh__bash', 1)
    expect(knownChunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(translator.toolCalls.map((call) => [call.id, call.name])).toEqual([['good', 'bash']])
  })

  it('completes immediately for unknown DSH tools without waiting for denial', () => {
    const translator = recoveringWithCatalog(['bash'])
    tool(translator, 'unknown', 'mcp__dsh__press_key')
    const knownChunks = tool(translator, 'good', 'mcp__dsh__bash', 1)
    expect(knownChunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(translator.complete).toBe(true)
  })

  it('still requires SDK denial for non-DSH unavailable tools even with catalog', () => {
    const translator = recoveringWithCatalog(['bash'])
    const bareChunks = tool(translator, 'bare', 'write')
    expect(bareChunks).toEqual([])
    const knownChunks = tool(translator, 'good', 'mcp__dsh__bash', 1)
    expect(knownChunks.some((c) => c.type === 'finish')).toBe(false)
    expect(translator.complete).toBe(false)
    const afterDenial = translator.accept(
      denial('bare', '<tool_use_error>Error: No such tool available: write</tool_use_error>'),
    )
    expect(afterDenial).toEqual([{ type: 'finish', reason: { kind: 'tool-calls' } }])
  })

  it('treats all DSH-prefixed tools as known when no catalog is provided', () => {
    const translator = recovering()
    const chunks = tool(translator, 'any', 'mcp__dsh__anything')
    expect(chunks.some((c) => c.type === 'tool-call-delta')).toBe(true)
    expect(translator.toolCalls.map((c) => c.name)).toEqual(['anything'])
  })

  it('regression: unknown DSH tool does not brick the session', () => {
    const translator = recoveringWithCatalog(['bash'])
    tool(translator, 'unknown', 'mcp__dsh__press_key')
    const knownChunks = tool(translator, 'good', 'mcp__dsh__bash', 1)
    expect(knownChunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(translator.toolCalls).toHaveLength(1)
    expect(translator.toolCalls[0]?.name).toBe('bash')
  })
})
