import type { Account, Reservation } from './types.js'
import { availableWork, blockedUntil, choose, type RouteRequest } from './router.js'
export interface DebitSample {
  identity: string
  window: string
  cohort: string
  epochBefore: string
  epochAfter: string
  before: number
  after: number
  completed: number
  observedAt: number
  externalUsage: boolean
  isolated: boolean
}
export interface Calibration {
  median: number
  upper: number
  samples: number
  confidence: 'sufficient'
}
/** Utilization is learned within one identity/window/cohort, never across plan names. */
export function calibrate(
  samples: readonly DebitSample[],
  identity: string,
  window: string,
  cohort: string,
  now: number,
): Calibration | undefined {
  const values = samples
    .filter(
      (s) =>
        s.identity === identity &&
        s.window === window &&
        s.cohort === cohort &&
        s.epochBefore === s.epochAfter &&
        !s.externalUsage &&
        s.isolated &&
        s.observedAt <= now &&
        now - s.observedAt <= 7 * 86400000 &&
        s.completed > 0 &&
        Number.isFinite(s.before) &&
        s.before >= 0 &&
        s.after <= 1 &&
        s.after > s.before &&
        s.after - s.before >= 0.005,
    )
    .map((s) => (s.after - s.before) / s.completed)
    .sort((a, b) => a - b)
  if (values.length < 8) return undefined
  const median = values[Math.floor(values.length / 2)]!,
    upper = values[Math.min(values.length - 1, Math.ceil(values.length * 0.9) - 1)]!
  if (upper > median * 4) return undefined
  return { median, upper, samples: values.length, confidence: 'sufficient' }
}
export interface Arrival {
  at: number
  work: number
  durationMs: number
  session: string
  identity?: string
}
export interface ForecastAccount {
  account: Account
  capacity: number
  resetAt?: number
  refill?: number
  coldCost: number
}
export interface ForecastResult {
  identity: string
  completed: number
  missed: number
  coldCost: number
  expiryWaste: number
}
/** Bounded discrete event simulation. Future refill requires an explicitly known capacity. */
export function simulate(
  pool: readonly ForecastAccount[],
  arrivals: readonly Arrival[],
  firstIdentity: string,
  now: number,
  model = 'opus',
): ForecastResult {
  const horizon = now + 7 * 86400000,
    states = new Map(
      pool.map((a) => [
        a.account.identity,
        { ...a, left: a.capacity, ends: [] as number[], reset: false },
      ]),
    )
  let completed = 0,
    missed = 0,
    coldCost = 0,
    expiryWaste = 0
  const bindings = new Map<string, string>()
  const ordered = arrivals
    .filter((a) => a.at >= now && a.at <= horizon)
    .slice(0, 64)
    .sort((a, b) => a.at - b.at)
  for (let i = 0; i < ordered.length; i++) {
    const job = ordered[i]!
    for (const state of states.values()) {
      state.ends = state.ends.filter((t) => t > job.at)
      if (
        !state.reset &&
        state.resetAt !== undefined &&
        state.resetAt <= job.at &&
        state.refill !== undefined
      ) {
        expiryWaste += state.left
        state.left = state.refill
        state.reset = true
      }
    }
    const fixed = job.identity ?? bindings.get(job.session) ?? (i === 0 ? firstIdentity : undefined)
    const choices = [...states.values()].filter(
      (s) =>
        (fixed === undefined || s.account.identity === fixed) &&
        s.ends.length < s.account.parallelLimit &&
        blockedUntil(s.account, model, job.at) === undefined &&
        s.left >= job.work + (bindings.has(job.session) ? 0 : s.coldCost),
    )
    choices.sort(
      (a, b) =>
        a.ends.length - b.ends.length ||
        b.left - a.left ||
        a.account.identity.localeCompare(b.account.identity),
    )
    const selected = choices[0]
    if (!selected) {
      missed++
      continue
    }
    const cost = bindings.has(job.session) ? 0 : selected.coldCost
    selected.left -= job.work + cost
    selected.ends.push(job.at + job.durationMs)
    bindings.set(job.session, selected.account.identity)
    completed++
    coldCost += cost
  }
  return { identity: firstIdentity, completed, missed, coldCost, expiryWaste }
}
export interface DemandObservation {
  at: number
  work: number
  durationMs: number
}
export function projectDemand(
  history: readonly DemandObservation[],
  now: number,
  seed: number,
): Arrival[] {
  const past = history
    .filter((h) => h.at <= now && h.at >= now - 7 * 86400000 && h.work > 0 && h.durationMs > 0)
    .sort((a, b) => a.at - b.at)
  if (past.length < 8) return []
  const gaps = past
    .slice(1)
    .map((h, i) => Math.max(1, h.at - past[i]!.at))
    .sort((a, b) => a - b)
  const interval = gaps[Math.floor(gaps.length / 2)]!
  let rng = seed >>> 0,
    at = now
  const jobs: Arrival[] = []
  for (let i = 0; i < 64; i++) {
    rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0
    const sample = past[rng % past.length]!
    if (i) at += Math.max(1, interval * (0.75 + (rng % 51) / 100))
    if (at > now + 7 * 86400000) break
    jobs.push({ at, work: sample.work, durationMs: sample.durationMs, session: 'forecast-' + i })
  }
  return jobs
}
export function shadowForecast(
  accounts: readonly Account[],
  req: RouteRequest,
  reservations: readonly Reservation[],
  history: readonly DemandObservation[],
  clock = () => performance.now(),
): { mode: 'shadow'; baseline: string; predicted?: string; reason: string; elapsedMs: number } {
  const start = clock(),
    baseline = choose(accounts, req, reservations).identity
  const pool = accounts
    .filter(
      (a) =>
        ['READY', 'DRAINING', 'COOLDOWN'].includes(a.state) &&
        a.models[req.model] !== undefined &&
        (req.effort === undefined || a.models[req.model]!.includes(req.effort)) &&
        blockedUntil(a, req.model, req.now) === undefined,
    )
    .map((a) => ({
      account: a,
      capacity: availableWork(a, req.model, req.now, reservations),
      coldCost: 0,
    }))
  if (pool.some((a) => a.capacity === undefined) || !pool.length)
    return {
      mode: 'shadow',
      baseline,
      reason: 'insufficient-capacity-observations',
      elapsedMs: clock() - start,
    }
  const arrivals = projectDemand(history, req.now, 17)
  if (!arrivals.length)
    return {
      mode: 'shadow',
      baseline,
      reason: 'insufficient-demand-observations',
      elapsedMs: clock() - start,
    }
  const scores: ForecastResult[] = []
  for (const candidate of pool) {
    if (clock() - start > 50)
      return { mode: 'shadow', baseline, reason: 'calculation-budget', elapsedMs: clock() - start }
    scores.push(
      simulate(pool as ForecastAccount[], arrivals, candidate.account.identity, req.now, req.model),
    )
  }
  scores.sort(
    (a, b) =>
      b.completed - a.completed ||
      a.missed - b.missed ||
      a.coldCost - b.coldCost ||
      a.expiryWaste - b.expiryWaste ||
      a.identity.localeCompare(b.identity),
  )
  return {
    mode: 'shadow',
    baseline,
    predicted: scores[0]!.identity,
    reason: 'holdout-required-before-activation',
    elapsedMs: clock() - start,
  }
}
