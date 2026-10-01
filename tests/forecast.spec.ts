import { it, expect } from 'vitest'
import {
  calibrate,
  simulate,
  projectDemand,
  shadowForecast,
  type DebitSample,
} from '../src/routing/forecast.js'
import type { Account } from '../src/routing/types.js'
const now = 1000000
const a = (identity: string): Account => ({
  identity,
  aliases: [],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  models: { opus: ['low'] },
  windows: [
    { key: 'short', scope: '*', epoch: 'a', observedAt: now, remainingWork: 10, source: 'fixture' },
  ],
  parallelLimit: 1,
})
const samples: DebitSample[] = Array.from({ length: 10 }, (_, i) => ({
  identity: 'A',
  window: 'short',
  cohort: 'opus:low:small:small',
  epochBefore: 'e',
  epochAfter: 'e',
  before: 0.1,
  after: 0.12 + i * 0.001,
  completed: 1,
  observedAt: now - i,
  externalUsage: false,
  isolated: true,
}))
it('calibrates only comparable, isolated, fresh observations and rejects mixed resets or external usage', () => {
  expect(calibrate(samples, 'A', 'short', 'opus:low:small:small', now)).toMatchObject({
    samples: 10,
    confidence: 'sufficient',
  })
  for (const change of [
    { externalUsage: true },
    { isolated: false },
    { epochAfter: 'other' },
    { after: 0.101 },
    { observedAt: now + 1 },
    { identity: 'B' },
    { completed: 0 },
    { before: -1 },
    { after: 2 },
  ])
    expect(
      calibrate(
        samples.map((s) => ({ ...s, ...change })),
        'A',
        'short',
        'opus:low:small:small',
        now,
      ),
    ).toBeUndefined()
  expect(calibrate(samples.slice(0, 7), 'A', 'short', 'opus:low:small:small', now)).toBeUndefined()
  expect(
    calibrate(
      samples.map((s, i) => ({ ...s, after: i < 6 ? 0.11 : 0.9 })),
      'A',
      'short',
      'opus:low:small:small',
      now,
    ),
  ).toBeUndefined()
})
it('simulates sticky bindings, cold costs, real reset capacity and parallel limits without inventing refill', () => {
  const jobs = [
    { at: now, session: 'x', work: 1, durationMs: 10 },
    { at: now + 1, session: 'y', identity: 'A', work: 1, durationMs: 1 },
    { at: now + 11, session: 'x', work: 1, durationMs: 1 },
    { at: now + 20, session: 'z', identity: 'A', work: 2, durationMs: 1 },
  ]
  const pool = [
    { account: a('A'), capacity: 2, coldCost: 1, resetAt: now + 15, refill: 4 },
    { account: a('B'), capacity: 10, coldCost: 0 },
  ]
  expect(simulate(pool, jobs, 'A', now)).toMatchObject({ completed: 2, missed: 2, coldCost: 2 })
  expect(
    simulate(
      pool.map(({ refill, ...s }) => s),
      jobs,
      'A',
      now,
    ),
  ).toMatchObject({ completed: 1, missed: 3 })
  expect(simulate(pool, [], 'B', now).completed).toBe(0)
})
it('uses only natural past demand with deterministic capped projection', () => {
  const h = Array.from({ length: 12 }, (_, i) => ({ at: now - i * 100, work: 1, durationMs: 10 }))
  expect(projectDemand(h, now, 17)).toEqual(
    projectDemand([...h, { at: now + 1, work: 999, durationMs: 10 }], now, 17),
  )
  expect(projectDemand(h, now, 17)).toHaveLength(64)
  expect(projectDemand([], now, 17)).toEqual([])
})
it('keeps shadow predictions inactive and falls back for unknown capacity, data or calculation budget', () => {
  const req = { session: 's', requestId: 'r', model: 'opus', effort: 'low', now },
    h = Array.from({ length: 12 }, (_, i) => ({ at: now - i * 100, work: 1, durationMs: 10 })),
    pool = [a('A'), a('B')]
  expect(shadowForecast(pool, req, [], h)).toMatchObject({
    mode: 'shadow',
    reason: 'holdout-required-before-activation',
  })
  expect(shadowForecast(pool, req, [], []).reason).toBe('insufficient-demand-observations')
  expect(shadowForecast([{ ...a('A'), windows: [] }], req, [], h).reason).toBe(
    'insufficient-capacity-observations',
  )
  let t = 0
  expect(shadowForecast(pool, req, [], h, () => (t += 60)).reason).toBe('calculation-budget')
})
it('applies model-family limits to verified full model identifiers without blocking other families', async () => {
  const { blockedUntil, matchesScope } = await import('../src/routing/router.js')
  const x = a('A')
  x.windows = [
    {
      key: 'opus',
      scope: 'opus',
      epoch: 'a',
      observedAt: now,
      source: 'sdk',
      hardBlockedUntil: now + 100,
    },
  ]
  expect(blockedUntil(x, 'claude-opus-4-8', now)).toBe(now + 100)
  expect(blockedUntil(x, 'claude-sonnet-4-6', now)).toBeUndefined()
  expect(matchesScope('custom', 'claude-custom-1')).toBe(false)
  expect(matchesScope('*', 'anything')).toBe(true)
})
