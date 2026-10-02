import type { ToolResultBlock } from './tool-result.js'
import { cwd as processCwd } from 'node:process'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ContentBlock, GenerateOptions, RequestMessage as Message } from '@deepseek-ai/dsh-llm'
import { ClaudeContentEncoder } from './content.js'
import { CLAUDE_ERROR_CODES, claudeError, protocolError, unsupportedInput } from './errors.js'
import { PROVIDER_ID } from './models.js'
import { planColdStart } from './replay.js'

function contentEqual(left: readonly ContentBlock[], right: readonly ContentBlock[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function messageEqual(left: Message, right: Message): boolean {
  return (
    left.id === right.id &&
    left.role === right.role &&
    JSON.stringify(left.source) === JSON.stringify(right.source) &&
    contentEqual(left.content, right.content)
  )
}

export interface CommittedAssistant {
  readonly model: string
  readonly content: readonly ContentBlock[]
}

export type ClaudeStartPlan =
  | { readonly mode: 'fresh' | 'degraded' }
  | {
      readonly mode: 'exact'
      readonly resume: string
      readonly resumeSessionAt: string
      readonly forkSession: true
    }

export type LiveInputPlan =
  | {
      readonly kind: 'prompt'
      readonly messages: SDKUserMessage[]
      readonly start?: ClaudeStartPlan
    }
  | { readonly kind: 'tool-results'; readonly results: ToolResultBlock[] }

export interface PrepareStepOptions {
  readonly forceDegraded?: boolean
  readonly maxReplayBytes?: number
}

/** Enforce the Claude streaming-input contract at the final queue boundary. */
export function assertSdkUserInput(message: SDKUserMessage): void {
  const candidate = message as unknown as {
    readonly type?: unknown
    readonly message?: { readonly role?: unknown }
  }
  if (candidate.type !== 'user' || candidate.message?.role !== 'user') {
    throw protocolError('Claude SDK streaming input must contain only user-role messages')
  }
}

function toolResult(message: Message): ToolResultBlock {
  if (message.role !== 'tool' || message.source.kind !== 'tool' || message.content.length === 0) {
    throw unsupportedInput('a Claude tool boundary requires nonempty DSH tool-role content')
  }
  if (String(message.toolCallId) !== String(message.source.callId)) {
    throw unsupportedInput('DSH tool-result message correlation is unsupported')
  }
  return {
    type: 'tool-result',
    toolCallId: message.toolCallId,
    content: message.content,
    ...(message.isError === undefined ? {} : { isError: message.isError }),
  }
}

/** Tracks the exact DSH prefix already represented by a live SDK query. */
export class LiveInputCursor {
  #prefix: readonly Message[] = []
  #assistant: CommittedAssistant | undefined

  constructor(readonly encoder = new ClaudeContentEncoder()) {}

  async prepareStep(
    options: GenerateOptions,
    control: PrepareStepOptions = {},
  ): Promise<LiveInputPlan> {
    if (options.temperature !== undefined) {
      throw unsupportedInput('Claude Code does not expose DSH temperature control')
    }
    if (
      options.maxTokens !== undefined &&
      (!Number.isSafeInteger(options.maxTokens) ||
        options.maxTokens < 1 ||
        options.maxTokens > 128_000)
    ) {
      throw unsupportedInput('Claude maxTokens must be an integer between 1 and 128000')
    }
    if ((options.stop?.length ?? 0) > 0) {
      throw unsupportedInput('Claude Code does not expose DSH stop sequences')
    }
    let offset = 0
    let start: ClaudeStartPlan | undefined
    if (this.#prefix.length > 0) {
      if (options.messages.length < this.#prefix.length) {
        throw claudeError(
          CLAUDE_ERROR_CODES.coldReplayUnsupported,
          'DSH history is shorter than the live Claude query prefix',
        )
      }
      for (const [index, prior] of this.#prefix.entries()) {
        const current = options.messages[index]
        if (current === undefined || !messageEqual(prior, current)) {
          throw claudeError(
            CLAUDE_ERROR_CODES.coldReplayUnsupported,
            `DSH history diverged from the live Claude query at message index ${index}`,
          )
        }
      }
      offset = this.#prefix.length
      const assistant = this.#assistant
      const mirrored = options.messages[offset]
      if (
        assistant === undefined ||
        mirrored?.role !== 'assistant' ||
        mirrored.source.kind !== 'model' ||
        mirrored.source.provider !== PROVIDER_ID ||
        mirrored.source.model !== assistant.model ||
        !contentEqual(mirrored.content, assistant.content)
      ) {
        throw claudeError(
          CLAUDE_ERROR_CODES.coldReplayUnsupported,
          'DSH history does not contain the exact assistant response held by the live Claude query',
        )
      }
      offset += 1
    } else {
      if (options.messages.length === 0) {
        throw unsupportedInput('Claude generation requires new user content')
      }
      if (!['user', 'tool'].includes(options.messages.at(-1)?.role ?? '')) {
        throw unsupportedInput('Claude generation requires new user content after prior history')
      }
      const cold = planColdStart(
        options.messages,
        options.system,
        processCwd(),
        control.forceDegraded,
        control.maxReplayBytes,
      )
      if (cold.mode === 'degraded') {
        return {
          kind: 'prompt',
          messages: [
            await this.encoder.degradedMessage(options.messages, cold.text, options.signal),
          ],
          start: { mode: 'degraded' },
        }
      }
      offset = options.messages.length - cold.pending.length
      start =
        cold.mode === 'exact'
          ? {
              mode: 'exact',
              resume: cold.resume,
              resumeSessionAt: cold.resumeSessionAt,
              forkSession: true,
            }
          : { mode: 'fresh' }
    }

    const pending = options.messages.slice(offset)
    if (pending.length === 0) throw unsupportedInput('Claude generation requires new user content')
    if (this.#assistant?.content.some((block) => block.type === 'tool-call') === true) {
      const results = pending.filter((message) => message.role === 'tool').map(toolResult)
      const calls = this.#assistant.content.filter((block) => block.type === 'tool-call')
      const ids = new Set(results.map((result) => String(result.toolCallId)))
      if (
        ids.size !== results.length ||
        results.length !== calls.length ||
        !calls.every((call) => ids.has(String(call.id)))
      ) {
        throw unsupportedInput(
          'a Claude tool boundary requires exactly one correlated result for every tool call',
        )
      }
      const notifications = pending.filter((message) => message.role !== 'tool')
      if (notifications.length > 0) {
        // A second querying SDK frame can race the parked MCP continuation. Rebuild
        // before resolving it, with all receipts and user updates in DSH order.
        await this.encoder.userMessages(notifications, options.signal)
        throw claudeError(
          CLAUDE_ERROR_CODES.coldReplayUnsupported,
          'DSH notifications at a tool boundary require a receipt-preserving rebuild',
        )
      }
      return { kind: 'tool-results', results }
    }
    this.encoder.assertMessages(pending)
    return {
      kind: 'prompt',
      messages: [await this.encoder.userMessages(pending, options.signal)],
      ...(start === undefined ? {} : { start }),
    }
  }

  async prepare(options: GenerateOptions): Promise<SDKUserMessage[]> {
    const plan = await this.prepareStep(options)
    if (plan.kind !== 'prompt') {
      throw unsupportedInput('tool results must resume the live Claude MCP call')
    }
    return plan.messages
  }

  commit(messages: readonly Message[], assistant: CommittedAssistant): void {
    this.#prefix = [...messages]
    this.#assistant = {
      model: assistant.model,
      content: assistant.content.map((block) => Object.freeze({ ...block })) as ContentBlock[],
    }
  }
}
