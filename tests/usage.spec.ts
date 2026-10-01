import { describe, expect, it } from 'vitest'
import { sumModelUsage, UsageTracker } from '../src/usage.js'

describe('cumulative Claude usage', () => {
  it('sums every model and emits only per-turn deltas', () => {
    const tracker = new UsageTracker()
    expect(
      tracker.delta({
        sonnet: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 3,
          cacheCreationInputTokens: 2,
        },
        haiku: {
          inputTokens: 5,
          outputTokens: 1,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      }),
    ).toEqual({
      inputTokens: 15,
      outputTokens: 5,
      cacheReadTokens: 3,
      cacheWriteTokens: 2,
    })
    expect(
      tracker.delta({
        sonnet: {
          inputTokens: 12,
          outputTokens: 10,
          cacheReadInputTokens: 8,
          cacheCreationInputTokens: 2,
        },
        haiku: {
          inputTokens: 5,
          outputTokens: 2,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 1,
        },
      }),
    ).toEqual({
      inputTokens: 2,
      outputTokens: 7,
      cacheReadTokens: 5,
      cacheWriteTokens: 1,
    })
  })

  it('treats missing optional counters and an empty catalog as zero', () => {
    expect(sumModelUsage(undefined)).toMatchObject({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
      queryCostUsd: 0,
      models: [],
    })
    expect(sumModelUsage({ sonnet: { inputTokens: 1, outputTokens: 2 } })).toMatchObject({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
      models: [{ model: 'sonnet', inputTokens: 1, outputTokens: 2 }],
    })
  })

  it('retains per-model cost metadata and maps per-turn thinking tokens', () => {
    const tracker = new UsageTracker()
    expect(
      tracker.delta(
        {
          sonnet: {
            inputTokens: 8,
            outputTokens: 5,
            cacheReadInputTokens: 2,
            cacheCreationInputTokens: 1,
            webSearchRequests: 1,
            costUSD: 0.0125,
            contextWindow: 200_000,
            maxOutputTokens: 64_000,
            canonicalModel: 'claude-sonnet-4-6',
            provider: 'firstParty',
          },
        },
        { output_tokens_details: { thinking_tokens: 3 } },
        0.0125,
      ),
    ).toEqual({
      inputTokens: 8,
      outputTokens: 5,
      cacheReadTokens: 2,
      cacheWriteTokens: 1,
      reasoningTokens: 3,
    })
    expect(tracker.telemetryDelta).toEqual({
      reasoningTokens: 3,
      costUsd: 0.0125,
      queryCostUsd: 0.0125,
    })
    expect(tracker.snapshot).toMatchObject({
      reasoningTokens: 3,
      costUsd: 0.0125,
      queryCostUsd: 0.0125,
      models: [
        {
          model: 'sonnet',
          webSearchRequests: 1,
          canonicalModel: 'claude-sonnet-4-6',
          provider: 'firstParty',
        },
      ],
    })
  })

  it('rejects invalid counters and a backwards cumulative epoch', () => {
    expect(() => sumModelUsage({ sonnet: { inputTokens: -1 } })).toThrow(
      /non-negative safe integer/,
    )
    expect(() => sumModelUsage({ sonnet: { outputTokens: 1.5 } })).toThrow(
      /non-negative safe integer/,
    )
    expect(() => sumModelUsage({ sonnet: { costUSD: Number.NaN } })).toThrow(
      /finite non-negative number/,
    )
    const tracker = new UsageTracker()
    tracker.delta({ sonnet: { inputTokens: 9, outputTokens: 4 } })
    expect(() => tracker.delta({ sonnet: { inputTokens: 8, outputTokens: 4 } })).toThrow(
      /moved backwards/,
    )
  })

  it('accepts a lower snapshot only after an explicit query-epoch reset', () => {
    const tracker = new UsageTracker()
    tracker.delta({ sonnet: { inputTokens: 20, outputTokens: 10 } })
    tracker.resetEpoch()
    expect(tracker.delta({ sonnet: { inputTokens: 2, outputTokens: 1 } })).toMatchObject({
      inputTokens: 2,
      outputTokens: 1,
    })
  })
})
