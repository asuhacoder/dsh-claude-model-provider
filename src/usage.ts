import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { CLAUDE_ERROR_CODES, claudeError } from './errors.js'

export interface ModelUsageSnapshot {
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly webSearchRequests: number
  readonly costUsd: number
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly canonicalModel?: string
  readonly provider?: string
}

export interface UsageSnapshot {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens?: number
  readonly costUsd?: number
  readonly queryCostUsd?: number
  readonly models?: readonly ModelUsageSnapshot[]
}

export interface UsageTelemetryDelta {
  readonly reasoningTokens?: number
  readonly costUsd: number
  readonly queryCostUsd: number
}

interface TurnUsageDetails {
  readonly output_tokens_details?: {
    readonly thinking_tokens?: number | null
  } | null
}

const ZERO_USAGE: UsageSnapshot = Object.freeze({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  costUsd: 0,
  queryCostUsd: 0,
  models: Object.freeze([]),
})

function counter(value: unknown, field: string): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw claudeError(
      CLAUDE_ERROR_CODES.usageEpochReset,
      `Claude usage field ${field} must be a non-negative safe integer`,
    )
  }
  return value
}

function money(value: unknown, field: string): number {
  if (value === undefined) return 0
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw claudeError(
      CLAUDE_ERROR_CODES.usageEpochReset,
      `Claude usage field ${field} must be a finite non-negative number`,
    )
  }
  return value
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) {
    throw claudeError(
      CLAUDE_ERROR_CODES.usageEpochReset,
      `Claude usage field ${field} must be a non-empty bounded string`,
    )
  }
  return value
}

function modelSnapshot(model: string, entry: Partial<ModelUsage>): ModelUsageSnapshot {
  const checkedModel = optionalString(model, 'model key')
  if (checkedModel === undefined) {
    throw claudeError(CLAUDE_ERROR_CODES.usageEpochReset, 'Claude usage model key is missing')
  }
  const canonicalModel = optionalString(entry.canonicalModel, `${model}.canonicalModel`)
  const provider = optionalString(entry.provider, `${model}.provider`)
  return Object.freeze({
    model: checkedModel,
    inputTokens: counter(entry.inputTokens, `${model}.inputTokens`),
    outputTokens: counter(entry.outputTokens, `${model}.outputTokens`),
    cacheReadTokens: counter(entry.cacheReadInputTokens, `${model}.cacheReadInputTokens`),
    cacheWriteTokens: counter(entry.cacheCreationInputTokens, `${model}.cacheCreationInputTokens`),
    webSearchRequests: counter(entry.webSearchRequests, `${model}.webSearchRequests`),
    costUsd: money(entry.costUSD, `${model}.costUSD`),
    contextWindow: counter(entry.contextWindow, `${model}.contextWindow`),
    maxOutputTokens: counter(entry.maxOutputTokens, `${model}.maxOutputTokens`),
    ...(canonicalModel === undefined ? {} : { canonicalModel }),
    ...(provider === undefined ? {} : { provider }),
  })
}

export function sumModelUsage(
  usage: Readonly<Record<string, Partial<ModelUsage>>> | undefined,
): UsageSnapshot {
  const models = Object.entries(usage ?? {})
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([model, entry]) => modelSnapshot(model, entry))
  const total = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  }
  for (const entry of models) {
    total.inputTokens += entry.inputTokens
    total.outputTokens += entry.outputTokens
    total.cacheReadTokens += entry.cacheReadTokens
    total.cacheWriteTokens += entry.cacheWriteTokens
    total.costUsd += entry.costUsd
  }
  for (const [field, value] of Object.entries(total)) {
    if (field === 'costUsd') money(value, field)
    else counter(value, field)
  }
  return Object.freeze({
    ...total,
    reasoningTokens: 0,
    queryCostUsd: 0,
    models: Object.freeze(models),
  })
}

function turnReasoningTokens(usage: TurnUsageDetails | undefined): number | undefined {
  const value = usage?.output_tokens_details?.thinking_tokens
  if (value === null || value === undefined) return undefined
  return counter(value, 'usage.output_tokens_details.thinking_tokens')
}

function decreased(current: UsageSnapshot, previous: UsageSnapshot): boolean {
  return (
    current.inputTokens < previous.inputTokens ||
    current.outputTokens < previous.outputTokens ||
    current.cacheReadTokens < previous.cacheReadTokens ||
    current.cacheWriteTokens < previous.cacheWriteTokens ||
    (current.costUsd ?? 0) < (previous.costUsd ?? 0) ||
    (current.queryCostUsd ?? 0) < (previous.queryCostUsd ?? 0)
  )
}

export class UsageTracker {
  #previous: UsageSnapshot = ZERO_USAGE
  #lastDelta: UsageTelemetryDelta = Object.freeze({ costUsd: 0, queryCostUsd: 0 })

  get snapshot(): UsageSnapshot {
    return this.#previous
  }

  get telemetryDelta(): UsageTelemetryDelta {
    return this.#lastDelta
  }

  /** Observed main-loop usage when the query is closed before its aggregate result.
   * Auxiliary usage/cost is unavailable at this boundary and is not invented.
   */
  finishPartial(usage: TokenUsage): TokenUsage {
    const delta = {
      inputTokens: counter(usage.inputTokens, 'partial.inputTokens'),
      outputTokens: counter(usage.outputTokens, 'partial.outputTokens'),
      cacheReadTokens: counter(usage.cacheReadTokens, 'partial.cacheReadTokens'),
      cacheWriteTokens: counter(usage.cacheWriteTokens, 'partial.cacheWriteTokens'),
    }
    this.#previous = Object.freeze({
      ...this.#previous,
      inputTokens: this.#previous.inputTokens + delta.inputTokens,
      outputTokens: this.#previous.outputTokens + delta.outputTokens,
      cacheReadTokens: this.#previous.cacheReadTokens + delta.cacheReadTokens,
      cacheWriteTokens: this.#previous.cacheWriteTokens + delta.cacheWriteTokens,
    })
    this.#lastDelta = Object.freeze({ costUsd: 0, queryCostUsd: 0 })
    return delta
  }

  delta(
    usage: Readonly<Record<string, Partial<ModelUsage>>> | undefined,
    turnUsage?: TurnUsageDetails,
    totalCostUsd?: number,
  ): TokenUsage {
    const aggregate = sumModelUsage(usage)
    const reasoning = turnReasoningTokens(turnUsage)
    const queryCostUsd =
      totalCostUsd === undefined
        ? (this.#previous.queryCostUsd ?? 0)
        : money(totalCostUsd, 'total_cost_usd')
    const current: UsageSnapshot = Object.freeze({
      ...aggregate,
      reasoningTokens: (this.#previous.reasoningTokens ?? 0) + (reasoning ?? 0),
      queryCostUsd,
    })
    if (decreased(current, this.#previous)) {
      throw claudeError(
        CLAUDE_ERROR_CODES.usageEpochReset,
        'Claude cumulative usage moved backwards within one live query epoch',
      )
    }
    const delta: TokenUsage = {
      inputTokens: current.inputTokens - this.#previous.inputTokens,
      outputTokens: current.outputTokens - this.#previous.outputTokens,
      cacheReadTokens: current.cacheReadTokens - this.#previous.cacheReadTokens,
      cacheWriteTokens: current.cacheWriteTokens - this.#previous.cacheWriteTokens,
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
    }
    this.#lastDelta = Object.freeze({
      ...(reasoning === undefined ? {} : { reasoningTokens: reasoning }),
      costUsd: (current.costUsd ?? 0) - (this.#previous.costUsd ?? 0),
      queryCostUsd: queryCostUsd - (this.#previous.queryCostUsd ?? 0),
    })
    this.#previous = current
    return delta
  }

  resetEpoch(): void {
    this.#previous = ZERO_USAGE
    this.#lastDelta = Object.freeze({ costUsd: 0, queryCostUsd: 0 })
  }
}
