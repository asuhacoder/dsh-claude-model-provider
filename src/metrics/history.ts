import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { StateStore } from '../storage/store.js'
export interface UsageRecord {
  id: string
  session: string
  identity: string
  model: string
  effort?: string
  startedAt: number
  finishedAt: number
  firstOutputAt?: number
  outcome: 'response' | 'tool-boundary' | 'error' | 'aborted'
  attempts: number
  usage: TokenUsage
  quotaEpochs: Record<string, string>
  sdkRetries: number
}
const fields = [
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const
export function addUsage(left: TokenUsage, right: TokenUsage): TokenUsage {
  const result = { ...left }
  for (const key of fields) {
    const value = right[key]
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new Error('INVALID_USAGE_COUNTER')
    if (value !== undefined) result[key] = (left[key] ?? 0) + value
  }
  return result
}
/** Stores final SDK usage deltas once per request, including consumed failed work. */
export class UsageHistory {
  constructor(
    readonly store: StateStore,
    readonly limit = 512,
  ) {}
  record(entry: UsageRecord): void {
    this.store.transaction(() => {
      if (this.store.get('usage', entry.id)) return
      this.store.set('usage', entry.id, entry)
      const totals = this.store.get<{
        responses: number
        toolBoundaries: number
        failed: number
        usage: TokenUsage
      }>('metrics', entry.identity) ?? {
        responses: 0,
        toolBoundaries: 0,
        failed: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
      }
      if (entry.outcome === 'response') totals.responses++
      else if (entry.outcome === 'tool-boundary') totals.toolBoundaries++
      else totals.failed++
      totals.usage = addUsage(totals.usage, entry.usage)
      this.store.set('metrics', entry.identity, totals)
      const entries = this.store
        .list<UsageRecord>('usage')
        .sort((a, b) => a.finishedAt - b.finishedAt)
      for (const old of entries.slice(0, Math.max(0, entries.length - this.limit)))
        this.store.delete('usage', old.id)
    })
  }
  recent(): UsageRecord[] {
    return this.store.list<UsageRecord>('usage').sort((a, b) => a.startedAt - b.startedAt)
  }
  summary(): {
    responses: number
    toolBoundaries: number
    failed: number
    usage: TokenUsage
    acceptedTasks: null
  } {
    const values = this.store.list<{
      responses: number
      toolBoundaries: number
      failed: number
      usage: TokenUsage
    }>('metrics')
    return values.reduce<{
      responses: number
      toolBoundaries: number
      failed: number
      usage: TokenUsage
      acceptedTasks: null
    }>(
      (a, b) => ({
        responses: a.responses + b.responses,
        toolBoundaries: a.toolBoundaries + b.toolBoundaries,
        failed: a.failed + b.failed,
        usage: addUsage(a.usage, b.usage),
        acceptedTasks: null,
      }),
      {
        responses: 0,
        toolBoundaries: 0,
        failed: 0,
        usage: { inputTokens: 0, outputTokens: 0 },
        acceptedTasks: null,
      },
    )
  }
}
