import type {
  SDKAssistantMessageError,
  SDKMessage,
  SDKResultMessage,
} from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock, FinishReason, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import { CLAUDE_ERROR_CODES, claudeError, protocolError } from './errors.js'
import { asCallId, canonicalToolJson } from './pending-tools.js'
import { dshToolName } from './tool-server.js'
import { UsageTracker } from './usage.js'

type OpenBlock =
  | { readonly type: 'text'; text: string }
  | { readonly type: 'reasoning'; text: string }
  | {
      readonly type: 'tool-call'
      readonly id: string
      readonly name: string
      arguments: string
      readonly startedWithArguments: boolean
    }

function resultFailure(error: SDKAssistantMessageError | undefined, result: SDKResultMessage) {
  switch (error) {
    case 'authentication_failed':
    case 'oauth_org_not_allowed':
    case 'account_on_hold':
    case 'billing_error':
    case 'verification_required':
    case 'cloud_credential_error':
      return claudeError(
        CLAUDE_ERROR_CODES.authenticationFailed,
        'Claude Code authentication or account access failed; run `claude auth login` and retry',
      )
    case 'model_not_found':
      return claudeError(
        CLAUDE_ERROR_CODES.modelNotFound,
        'Claude Code rejected the selected model',
      )
    case 'rate_limit':
      return claudeError(CLAUDE_ERROR_CODES.rateLimited, 'Claude Code rate limit was reached')
    case 'invalid_request':
      return claudeError(
        CLAUDE_ERROR_CODES.invalidRequest,
        'Claude Code rejected the request; check model capacity and request controls',
      )
    default:
      if (result.subtype !== 'success') {
        const failures = {
          error_max_turns: [
            CLAUDE_ERROR_CODES.maxTurns,
            'Claude Code reached maxGenerations; continue with the saved DSH tool receipts or raise the configured limit',
          ],
          error_max_budget_usd: [
            CLAUDE_ERROR_CODES.maxBudget,
            'Claude Code reached its configured budget limit',
          ],
          error_max_structured_output_retries: [
            CLAUDE_ERROR_CODES.structuredOutputRetries,
            'Claude Code exhausted structured-output retries',
          ],
          error_during_execution: [
            CLAUDE_ERROR_CODES.executionFailed,
            'Claude Code failed during execution',
          ],
        } as const
        const [code, description] = failures[result.subtype]
        const turns =
          Number.isSafeInteger(result.num_turns) && result.num_turns >= 0
            ? result.num_turns
            : 'unknown'
        // errors can contain prompt text, paths or secrets. Preserve typed facts only.
        return claudeError(
          code,
          `${description} (SDK subtype=${result.subtype}, turns=${turns}, errorCount=${result.errors?.length ?? 0})`,
        )
      }
      return claudeError(
        CLAUDE_ERROR_CODES.transportError,
        `Claude Code ended the turn with ${error ?? 'an unknown execution error'}`,
      )
  }
}

function sameBlocks(left: readonly ContentBlock[], right: readonly ContentBlock[]): boolean {
  if (left.length !== right.length) return false
  return left.every((block, index) => {
    const other = right[index]
    if (other === undefined || block.type !== other.type) return false
    if (block.type === 'tool-call' && other.type === 'tool-call') {
      if (block.id !== other.id || block.name !== other.name) return false
      try {
        return (
          canonicalToolJson(JSON.parse(block.arguments)) ===
          canonicalToolJson(JSON.parse(other.arguments))
        )
      } catch {
        return false
      }
    }
    return JSON.stringify(block) === JSON.stringify(other)
  })
}

function finish(reason: FinishReason): StreamChunk {
  return { type: 'finish', reason }
}

function completedToolArguments(input: unknown): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw protocolError('Claude completed non-object tool arguments')
  }
  try {
    return canonicalToolJson(input)
  } catch (error: unknown) {
    throw protocolError('Claude completed invalid JSON tool arguments', error)
  }
}

/** One-turn state machine translating authoritative SDK partial events into DSH chunks. */
export class ClaudeOutputTranslator {
  readonly #open = new Map<number, OpenBlock>()
  readonly #closed: ContentBlock[] = []
  readonly #completed: ContentBlock[] = []
  #assistantError: SDKAssistantMessageError | undefined
  #messageStopReason: string | null | undefined
  #sessionId: string | undefined
  #lastAssistantUuid: string | undefined
  #complete = false
  #terminalReason: FinishReason | undefined
  #truncatedAtBoundary = false
  #partialUsage: TokenUsage = { inputTokens: 0, outputTokens: 0 }

  constructor(
    readonly usage: UsageTracker,
    readonly stopAtOutputLimit = false,
  ) {}

  get truncatedAtBoundary(): boolean {
    return this.#truncatedAtBoundary
  }

  get complete(): boolean {
    return this.#complete
  }

  get outputBlocks(): readonly ContentBlock[] {
    return this.#closed
  }

  get terminalReason(): FinishReason | undefined {
    return this.#terminalReason
  }

  get sessionId(): string | undefined {
    return this.#sessionId
  }

  get lastAssistantUuid(): string | undefined {
    return this.#lastAssistantUuid
  }

  get toolCalls(): readonly Extract<ContentBlock, { type: 'tool-call' }>[] {
    return this.#closed.filter(
      (block): block is Extract<ContentBlock, { type: 'tool-call' }> => block.type === 'tool-call',
    )
  }

  #observeSession(message: { session_id?: string }): void {
    if (message.session_id === undefined) return
    if (this.#sessionId === undefined) this.#sessionId = message.session_id
    else if (this.#sessionId !== message.session_id) {
      throw protocolError('Claude SDK changed session identity inside one live bridge')
    }
  }

  #partial(message: Extract<SDKMessage, { type: 'stream_event' }>): StreamChunk[] {
    if (message.parent_tool_use_id !== null) {
      throw protocolError('Claude emitted subagent output while native tools were disabled')
    }
    const event = message.event
    switch (event.type) {
      case 'message_start':
        if (!this.stopAtOutputLimit) return []
        this.#partialUsage = {
          inputTokens: event.message.usage.input_tokens,
          outputTokens: event.message.usage.output_tokens,
          cacheReadTokens: event.message.usage.cache_read_input_tokens ?? 0,
          cacheWriteTokens: event.message.usage.cache_creation_input_tokens ?? 0,
        }
        return []
      case 'message_stop':
        return []
      case 'message_delta':
        this.#messageStopReason = event.delta.stop_reason
        this.#partialUsage = { ...this.#partialUsage, outputTokens: event.usage.output_tokens }
        if (this.stopAtOutputLimit && event.delta.stop_reason === 'max_tokens') {
          if (this.#open.size > 0)
            throw protocolError('Claude output limit arrived with open content blocks')
          this.#reconcile()
          this.#truncatedAtBoundary = true
          this.#complete = true
          this.#terminalReason = { kind: 'max-tokens' }
          // Claude Code normally retries truncation internally. DSH owns the next
          // step, so stop before that hidden continuation and report observed usage.
          return [
            { type: 'usage', usage: this.usage.finishPartial(this.#partialUsage) },
            finish(this.#terminalReason),
          ]
        }
        return []
      case 'content_block_start': {
        if (!Number.isSafeInteger(event.index) || event.index < 0 || this.#open.has(event.index)) {
          throw protocolError(`invalid or duplicate Claude content block index ${event.index}`)
        }
        const content = event.content_block
        let block: OpenBlock
        if (content.type === 'text') block = { type: 'text', text: content.text }
        else if (content.type === 'thinking') {
          block = { type: 'reasoning', text: content.thinking }
        } else if (content.type === 'tool_use') {
          if (
            content.input === null ||
            typeof content.input !== 'object' ||
            Array.isArray(content.input)
          ) {
            throw protocolError('Claude tool-use input must start as a JSON object')
          }
          const initial =
            Object.keys(content.input).length === 0 ? '' : completedToolArguments(content.input)
          block = {
            type: 'tool-call',
            id: content.id,
            name: dshToolName(content.name),
            arguments: initial,
            startedWithArguments: initial.length > 0,
          }
        } else {
          throw protocolError(
            `Claude emitted unsupported ${JSON.stringify(content.type)} content while only DSH MCP tools were enabled`,
          )
        }
        this.#open.set(event.index, block)
        const chunks: StreamChunk[] = [
          { type: 'block-start', index: event.index, blockType: block.type },
        ]
        if (block.type === 'tool-call') {
          chunks.push({
            type: 'tool-call-delta',
            index: event.index,
            id: asCallId(block.id),
            name: block.name,
            argumentsDelta: block.arguments,
          })
        } else if (block.text.length > 0) {
          chunks.push(
            block.type === 'text'
              ? { type: 'text-delta', index: event.index, text: block.text }
              : { type: 'reasoning-delta', index: event.index, text: block.text },
          )
        }
        return chunks
      }
      case 'content_block_delta': {
        const block = this.#open.get(event.index)
        if (block === undefined) {
          throw protocolError(`Claude delta referenced unopened content block ${event.index}`)
        }
        const delta = event.delta
        if (delta.type === 'signature_delta') return []
        if (delta.type === 'text_delta' && block.type === 'text') {
          block.text += delta.text
          return [{ type: 'text-delta', index: event.index, text: delta.text }]
        }
        if (delta.type === 'thinking_delta' && block.type === 'reasoning') {
          block.text += delta.thinking
          return [{ type: 'reasoning-delta', index: event.index, text: delta.thinking }]
        }
        if (delta.type === 'input_json_delta' && block.type === 'tool-call') {
          if (block.startedWithArguments && delta.partial_json.length > 0) {
            throw protocolError('Claude streamed tool arguments after a non-empty tool-use start')
          }
          block.arguments += delta.partial_json
          return [
            {
              type: 'tool-call-delta',
              index: event.index,
              id: asCallId(block.id),
              argumentsDelta: delta.partial_json,
            },
          ]
        }
        throw protocolError(
          `Claude emitted ${JSON.stringify(delta.type)} for a ${block.type} content block`,
        )
      }
      case 'content_block_stop': {
        const block = this.#open.get(event.index)
        if (block === undefined) {
          throw protocolError(`Claude stopped unopened content block ${event.index}`)
        }
        this.#open.delete(event.index)
        const content = this.#materialize(block)
        this.#closed.push(content)
        const chunks: StreamChunk[] = [{ type: 'block-end', index: event.index, block: content }]
        if (
          this.#open.size === 0 &&
          this.#assistantError === undefined &&
          this.#completed.some((entry) => entry.type === 'tool-call')
        ) {
          this.#reconcile()
          this.#complete = true
          this.#terminalReason = { kind: 'tool-calls' }
          chunks.push(finish(this.#terminalReason))
        }
        return chunks
      }
    }
  }

  #materialize(block: OpenBlock): ContentBlock {
    if (block.type === 'text') return { type: 'text', text: block.text }
    if (block.type === 'reasoning') return { type: 'reasoning', text: block.text }
    const rawArguments = block.arguments.length === 0 ? '{}' : block.arguments
    let parsed: unknown
    try {
      parsed = JSON.parse(rawArguments)
    } catch (error: unknown) {
      throw protocolError('Claude completed malformed JSON tool arguments', error)
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw protocolError('Claude completed non-object tool arguments')
    }
    return {
      type: 'tool-call',
      id: asCallId(block.id),
      name: block.name,
      arguments: rawArguments,
    }
  }

  #assistant(message: Extract<SDKMessage, { type: 'assistant' }>): StreamChunk[] {
    if (message.parent_tool_use_id !== null) {
      throw protocolError(
        'Claude emitted a subagent assistant message while native tools were disabled',
      )
    }
    this.#lastAssistantUuid = message.uuid
    this.#assistantError ??= message.error
    for (const block of message.message.content) {
      if (block.type === 'text') this.#completed.push({ type: 'text', text: block.text })
      else if (block.type === 'thinking') {
        this.#completed.push({ type: 'reasoning', text: block.thinking })
      } else if (block.type === 'tool_use') {
        this.#completed.push({
          type: 'tool-call',
          id: asCallId(block.id),
          name: dshToolName(block.name),
          arguments: completedToolArguments(block.input),
        })
      } else if (message.error === undefined) {
        throw protocolError(
          `Claude completed unsupported ${JSON.stringify(block.type)} content while only DSH MCP tools were enabled`,
        )
      }
    }
    if (
      this.#assistantError === undefined &&
      this.#completed.some((block) => block.type === 'tool-call')
    ) {
      if (this.#open.size > 0) return []
      this.#reconcile()
      this.#complete = true
      this.#terminalReason = { kind: 'tool-calls' }
      return [finish(this.#terminalReason)]
    }
    return []
  }

  #reconcile(): void {
    if (this.#closed.length > 0 && this.#completed.length === 0) {
      throw protocolError('Claude omitted completed assistant reconciliation messages')
    }
    if (this.#completed.length > 0 && !sameBlocks(this.#closed, this.#completed)) {
      throw protocolError('Claude partial and completed assistant content did not reconcile')
    }
  }

  #result(message: SDKResultMessage): StreamChunk[] {
    if (this.#open.size > 0) throw protocolError('Claude result arrived with open content blocks')
    const chunks: StreamChunk[] = [
      {
        type: 'usage',
        usage: this.usage.delta(message.modelUsage, message.usage, message.total_cost_usd),
      },
    ]
    const maxTokens =
      this.#assistantError === 'max_output_tokens' || message.stop_reason === 'max_tokens'
    if (maxTokens) {
      this.#complete = true
      this.#terminalReason = { kind: 'max-tokens' }
      chunks.push(finish(this.#terminalReason))
      return chunks
    }
    if (message.subtype !== 'success' || message.is_error || this.#assistantError !== undefined) {
      const error = resultFailure(this.#assistantError, message)
      this.#complete = true
      this.#terminalReason = { kind: 'error', failure: error.failure }
      chunks.push(finish(this.#terminalReason))
      return chunks
    }
    this.#reconcile()
    const stopReason = message.stop_reason ?? this.#messageStopReason
    if (stopReason === 'tool_use') {
      throw protocolError('Claude ended with tool_use without a reconciled DSH MCP tool boundary')
    }
    if (
      stopReason !== null &&
      stopReason !== undefined &&
      stopReason !== 'end_turn' &&
      stopReason !== 'stop_sequence'
    ) {
      throw protocolError(`Claude returned unsupported stop reason ${JSON.stringify(stopReason)}`)
    }
    this.#complete = true
    this.#terminalReason = { kind: 'stop' }
    chunks.push(finish(this.#terminalReason))
    return chunks
  }

  accept(message: SDKMessage): StreamChunk[] {
    if (this.#complete) throw protocolError('Claude emitted output after the terminal result')
    if (message.type === 'system' && message.subtype === 'compact_boundary')
      throw protocolError('SDK_COMPACTION_REQUIRES_DSH_RESYNC')
    if (message.type === 'system' && message.subtype === 'model_refusal_fallback')
      throw protocolError('UNREQUESTED_MODEL_FALLBACK')
    this.#observeSession(message)
    if (message.type === 'stream_event') return this.#partial(message)
    if (message.type === 'assistant') return this.#assistant(message)
    if (message.type === 'result') return this.#result(message)
    return []
  }
}
