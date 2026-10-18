import type { ToolResultBlock } from '../src/tool-result.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ToolCallBlock } from '@deepseek-ai/dsh-llm'
import {
  canonicalToolJson,
  MCP_HANDLER_REGISTRATION_TIMEOUT_MS,
  PendingTools,
  toMcpToolResult,
} from '../src/pending-tools.js'
import type { ClaudePluginError } from '../src/errors.js'
import { describeFailureDetail } from '../src/failure-evidence.js'

function call(id: string, name: string, args = '{}'): ToolCallBlock {
  return { type: 'tool-call', id: id as never, name, arguments: args }
}

function result(id: string, text = id, isError = false): ToolResultBlock {
  return {
    type: 'tool-result',
    toolCallId: id as never,
    content: [{ type: 'text', text }],
    isError,
  }
}

function fixture(timeoutMs = 10_000) {
  const failures: ClaudePluginError[] = []
  const pending = new PendingTools(timeoutMs, (error) => failures.push(error))
  return { failures, pending }
}

afterEach(() => vi.useRealTimers())

describe('pending DSH tool correlation', () => {
  it('correlates the SDK-normalized Unicode input with the unchanged DSH-emitted arguments', async () => {
    const { pending } = fixture()
    const registered = pending.register({
      id: 'unicode',
      name: 'bash',
      arguments: { command: "grep '[\u3040-\u30ff]'" },
      generation: 1,
    })
    const emitted = String.raw`{"command":"grep '[\\u3040-\\u30ff]'"}`
    await pending.assertBoundary([call('unicode', 'bash', emitted)], 1)
    await pending.resolveBatch([result('unicode', 'NOOP')])
    await expect(registered).resolves.toMatchObject({ content: [{ text: 'NOOP' }] })
  })

  it('does not accept a different tool input merely because the emitted input contains Unicode escapes', async () => {
    const { pending } = fixture()
    const registered = pending.register({
      id: 'unicode',
      name: 'bash',
      arguments: { command: 'echo \u3041' },
      generation: 1,
    })
    const rejected = expect(registered).rejects.toThrow(/arguments disagree/)
    await expect(
      pending.assertBoundary([call('unicode', 'bash', String.raw`{"command":"echo \\u3040"}`)], 1),
    ).rejects.toThrow(/arguments disagree/)
    await rejected
  })

  it('canonicalizes JSON and rejects values that cannot cross the tool protocol', async () => {
    expect(canonicalToolJson({ z: 1, a: [{ y: true, x: null }] })).toBe(
      '{"a":[{"x":null,"y":true}],"z":1}',
    )
    expect(canonicalToolJson(JSON.parse('{"__proto__":{"safe":true}}'))).toBe(
      '{"__proto__":{"safe":true}}',
    )
    expect(() => canonicalToolJson(new Date())).toThrow(/plain objects/)
    expect(() => canonicalToolJson({ invalid: undefined })).toThrow(/non-JSON value/)
    expect(() => canonicalToolJson({ invalid: Number.POSITIVE_INFINITY })).toThrow(/non-JSON value/)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => canonicalToolJson(cyclic)).toThrow(/cycle/)
    const { isError: _isError, ...withoutIsError } = result('a')
    expect(await toMcpToolResult(withoutIsError)).toEqual({
      content: [{ type: 'text', text: 'a' }],
    })
    await expect(
      toMcpToolResult({
        ...result('a'),
        content: [{ type: 'reasoning', text: 'hidden' }],
      }),
    ).rejects.toThrow(/unsupported/)
  })

  it('accepts multi-tool boundaries and out-of-order DSH completion without swapping results', async () => {
    const { pending } = fixture()
    const first = pending.register({
      id: 'a',
      name: 'read',
      arguments: { path: '/a' },
      generation: 1,
    })
    const second = pending.register({
      id: 'b',
      name: 'read',
      arguments: { path: '/b' },
      generation: 1,
    })
    await pending.assertBoundary(
      [call('b', 'read', '{"path":"/b"}'), call('a', 'read', '{"path":"/a"}')],
      1,
    )
    await pending.resolveBatch([result('b', 'B', true), result('a', 'A')])
    await expect(first).resolves.toMatchObject({ content: [{ text: 'A' }], isError: false })
    await expect(second).resolves.toMatchObject({ content: [{ text: 'B' }], isError: true })
  })

  it.each([
    ['unknown ID', [call('other', 'read')], 1, /unknown/],
    ['missing ID', [call('a', 'read')], 1, /absent/],
    ['stale generation', [call('a', 'read'), call('b', 'read')], 2, /stale/],
    ['mismatched name', [call('a', 'write'), call('b', 'read')], 1, /names disagree/],
  ])('fails closed for a %s boundary', async (_name, calls, generation, pattern) => {
    const { failures, pending } = fixture()
    const a = pending.register({ id: 'a', name: 'read', arguments: {}, generation: 1 })
    const b = pending.register({ id: 'b', name: 'read', arguments: {}, generation: 1 })
    await expect(pending.assertBoundary(calls as ToolCallBlock[], generation)).rejects.toThrow(
      pattern as RegExp,
    )
    await expect(a).rejects.toThrow()
    await expect(b).rejects.toThrow()
    expect(failures).toHaveLength(1)
  })

  it('records diagnostic details for ID mismatch when count matches', async () => {
    const { failures, pending } = fixture()
    const registered = pending.register({
      id: 'toolu_original',
      name: 'read',
      arguments: {},
      generation: 1,
    })

    let thrown: unknown
    try {
      await pending.assertBoundary([call('toolu_retried', 'read')], 1)
    } catch (error) {
      thrown = error
    }

    await expect(registered).rejects.toThrow()
    expect(thrown).toBeDefined()
    expect(failures).toHaveLength(1)

    const detail = describeFailureDetail(thrown)
    expect(detail).toBeDefined()
    expect(detail).toMatchObject({
      expectedCount: 1,
      registeredCount: 1,
      mismatchedIds: 1,
    })
  })

  it('records diagnostic details for multi-tool ID mismatch scenario', async () => {
    const { failures, pending } = fixture()
    const regA = pending.register({ id: 'a', name: 'read', arguments: {}, generation: 1 })
    const regB = pending.register({ id: 'b', name: 'write', arguments: {}, generation: 1 })
    const regC = pending.register({ id: 'c', name: 'edit', arguments: {}, generation: 1 })

    let thrown: unknown
    try {
      // 'a' matches, but 'x' is the first unknown ID (fails immediately)
      await pending.assertBoundary(
        [call('a', 'read'), call('x', 'write'), call('y', 'edit')],
        1,
      )
    } catch (error) {
      thrown = error
    }

    await expect(regA).rejects.toThrow()
    await expect(regB).rejects.toThrow()
    await expect(regC).rejects.toThrow()
    expect(thrown).toBeDefined()
    expect(failures).toHaveLength(1)

    // mismatchedIds is 1 because error throws at first unknown ID (fail-fast)
    const detail = describeFailureDetail(thrown)
    expect(detail).toBeDefined()
    expect(detail).toMatchObject({
      expectedCount: 3,
      registeredCount: 3,
      mismatchedIds: 1,
    })
  })

  it('rejects duplicate Claude IDs and stale, duplicate, unknown, or missing DSH results', async () => {
    const duplicate = fixture()
    const first = duplicate.pending.register({
      id: 'same',
      name: 'read',
      arguments: {},
      generation: 1,
    })
    await expect(
      duplicate.pending.register({
        id: 'same',
        name: 'read',
        arguments: {},
        generation: 1,
      }),
    ).rejects.toThrow(/repeated/)
    await expect(first).rejects.toThrow()

    for (const [label, results, pattern] of [
      ['unknown', [result('other')], /unknown/],
      ['missing', [], /omitted/],
      ['duplicate', [result('a'), result('a')], /repeated/],
    ] as const) {
      const current = fixture()
      const promise = current.pending.register({
        id: 'a',
        name: 'read',
        arguments: {},
        generation: 1,
      })
      await expect(current.pending.resolveBatch(results)).rejects.toThrow(pattern)
      await expect(promise, label).rejects.toThrow()
    }

    const stale = fixture()
    const completed = stale.pending.register({
      id: 'a',
      name: 'read',
      arguments: {},
      generation: 1,
    })
    await stale.pending.resolveBatch([result('a')])
    await completed
    await expect(stale.pending.resolveBatch([result('a')])).rejects.toThrow(/stale or duplicate/)
  })

  it('times out and rejects every parked handler with one stable failure', async () => {
    vi.useFakeTimers()
    const { failures, pending } = fixture(100)
    const promise = pending.register({
      id: 'slow',
      name: 'read',
      arguments: {},
      generation: 1,
    })
    const rejection = expect(promise).rejects.toMatchObject({ code: 'CLAUDE_TOOL_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(101)
    await rejection
    expect(failures).toHaveLength(1)
    expect(failures[0]?.code).toBe('CLAUDE_TOOL_TIMEOUT')
  })

  it('fails when canonical arguments disagree and when a handler is cancelled', async () => {
    const mismatch = fixture()
    const mismatched = mismatch.pending.register({
      id: 'a',
      name: 'read',
      arguments: { path: '/expected' },
      generation: 1,
    })
    await expect(
      mismatch.pending.assertBoundary([call('a', 'read', '{"path":"/other"}')], 1),
    ).rejects.toThrow(/arguments disagree/)
    await expect(mismatched).rejects.toThrow()

    const cancelled = fixture()
    const controller = new AbortController()
    const promise = cancelled.pending.register({
      id: 'a',
      name: 'read',
      arguments: {},
      generation: 1,
      signal: controller.signal,
    })
    controller.abort()
    await expect(promise).rejects.toThrow(/cancelled/)
  })

  it('waits for handler registration and fails closed when registration never arrives', async () => {
    const delayed = fixture()
    const boundary = delayed.pending.assertBoundary([call('late', 'read')], 1)
    const parked = delayed.pending.register({
      id: 'late',
      name: 'read',
      arguments: {},
      generation: 1,
    })
    await boundary
    await delayed.pending.resolveBatch([result('late')])
    await expect(parked).resolves.toMatchObject({ content: [{ text: 'late' }] })

    const staggered = fixture()
    let boundarySettled = false
    const multiBoundary = staggered.pending
      .assertBoundary([call('a', 'read'), call('b', 'read')], 1)
      .then(() => {
        boundarySettled = true
      })
    const first = staggered.pending.register({
      id: 'a',
      name: 'read',
      arguments: {},
      generation: 1,
    })
    await Promise.resolve()
    expect(boundarySettled).toBe(false)
    const second = staggered.pending.register({
      id: 'b',
      name: 'read',
      arguments: {},
      generation: 1,
    })
    await multiBoundary
    await staggered.pending.resolveBatch([result('a'), result('b')])
    await Promise.all([first, second])

    vi.useFakeTimers()
    const absent = fixture()
    const timedOut = expect(
      absent.pending.assertBoundary([call('never', 'read')], 1),
    ).rejects.toThrow(/did not register/)
    await vi.advanceTimersByTimeAsync(MCP_HANDLER_REGISTRATION_TIMEOUT_MS + 1)
    await timedOut
    expect(absent.failures).toHaveLength(1)
  })

  it('rejects aborted waits, already-aborted handlers, and invalid registrations', async () => {
    const waiting = fixture()
    const boundaryController = new AbortController()
    const boundary = expect(
      waiting.pending.assertBoundary([call('a', 'read')], 1, boundaryController.signal),
    ).rejects.toThrow(/aborted/)
    boundaryController.abort()
    await boundary

    const cancelled = fixture()
    const callController = new AbortController()
    callController.abort()
    await expect(
      cancelled.pending.register({
        id: 'a',
        name: 'read',
        arguments: {},
        generation: 1,
        signal: callController.signal,
      }),
    ).rejects.toThrow(/cancelled/)

    for (const registration of [
      { id: '', name: 'read', arguments: {}, generation: 1 },
      { id: 'x'.repeat(513), name: 'read', arguments: {}, generation: 1 },
      { id: 'a', name: '', arguments: {}, generation: 1 },
      { id: 'a', name: 'read', arguments: {}, generation: 0 },
      { id: 'a', name: 'read', arguments: { invalid: undefined }, generation: 1 },
    ]) {
      const invalid = fixture()
      await expect(invalid.pending.register(registration)).rejects.toThrow()
      await expect(
        invalid.pending.register({ id: 'later', name: 'read', arguments: {}, generation: 1 }),
      ).rejects.toThrow()
      expect(invalid.failures).toHaveLength(1)
    }
  })

  it('rejects duplicate boundaries, malformed arguments, and explicit disposal', async () => {
    for (const [ids, calls, pattern] of [
      [['a', 'b'], [call('a', 'read'), call('a', 'read')], /duplicate/],
      [['a'], [call('a', 'read', '{')], /malformed/],
      [['a'], [call('a', 'read', '[]')], /JSON object/],
    ] as const) {
      const current = fixture()
      const rejected = ids.map((id) =>
        expect(
          current.pending.register({ id, name: 'read', arguments: {}, generation: 1 }),
        ).rejects.toThrow(),
      )
      await expect(current.pending.assertBoundary(calls, 1)).rejects.toThrow(pattern)
      await Promise.all(rejected)
    }

    const disposed = fixture()
    const parked = disposed.pending.register({
      id: 'a',
      name: 'read',
      arguments: {},
      generation: 1,
    })
    expect(disposed.pending.snapshots).toEqual([
      { id: 'a', name: 'read', arguments: '{}', generation: 1 },
    ])
    const rejected = expect(parked).rejects.toThrow(/disposed/)
    disposed.pending.dispose()
    disposed.pending.dispose()
    await rejected
  })
})
