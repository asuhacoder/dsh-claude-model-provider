import { createHash } from 'node:crypto'
import { StateStore } from '../storage/store.js'
import {
  RouteBlocked,
  type Account,
  type Binding,
  type QuotaWindow,
  type Reservation,
} from './types.js'
export interface RouteRequest {
  session: string
  requestId: string
  model: string
  effort?: string
  now: number
}
export function blockedUntil(account: Account, model: string, now: number): number | undefined {
  const values = account.windows
    .filter((w) => (w.scope === '*' || w.scope === model) && (w.hardBlockedUntil ?? 0) > now)
    .map((w) => w.hardBlockedUntil!)
  return values.length ? Math.max(...values) : undefined
}
export function availableWork(
  account: Account,
  model: string,
  now: number,
  reservations: readonly Reservation[],
): number | undefined {
  const windows = account.windows.filter(
    (w) => (w.scope === '*' || w.scope === model) && (w.resetsAt === undefined || w.resetsAt > now),
  )
  if (!windows.length || windows.some((w) => w.remainingWork === undefined)) return undefined
  return Math.max(
    0,
    Math.min(
      ...windows.map(
        (w) =>
          w.remainingWork! -
          reservations
            .filter((r) => r.identity === account.identity && r.epochs[w.key] === w.epoch)
            .reduce((n, r) => n + r.predictedWork, 0),
      ),
    ),
  )
}
function tie(session: string, id: string): string {
  return createHash('sha256')
    .update(session + '\0' + id)
    .digest('hex')
}
export function choose(
  accounts: readonly Account[],
  req: RouteRequest,
  reservations: readonly Reservation[],
  excluded = new Set<string>(),
): Account {
  const unique = [...new Map(accounts.map((a) => [a.identity, a])).values()]
  const candidates = unique.filter(
    (a) =>
      !excluded.has(a.identity) &&
      ['READY', 'DRAINING', 'COOLDOWN'].includes(a.state) &&
      a.models[req.model] !== undefined &&
      (req.effort === undefined || a.models[req.model]!.includes(req.effort)) &&
      blockedUntil(a, req.model, req.now) === undefined &&
      reservations.filter((r) => r.identity === a.identity).length < a.parallelLimit,
  )
  if (!candidates.length) {
    const times = unique
      .map((a) => blockedUntil(a, req.model, req.now))
      .filter((v): v is number => v !== undefined)
    throw new RouteBlocked('POOL_UNAVAILABLE', times.length ? Math.min(...times) : undefined)
  }
  const load = (a: Account) => reservations.filter((r) => r.identity === a.identity).length
  // Work estimates are comparable; percentages across plans are deliberately not.
  candidates.sort(
    (a, b) =>
      load(a) - load(b) ||
      Number(a.state === 'DRAINING') - Number(b.state === 'DRAINING') ||
      (availableWork(b, req.model, req.now, reservations) ?? 0) -
        (availableWork(a, req.model, req.now, reservations) ?? 0) ||
      tie(req.session, a.identity).localeCompare(tie(req.session, b.identity)),
  )
  // If all estimates say exhausted, admit at most one real job per identity.
  const first = candidates.find(
    (a) => (availableWork(a, req.model, req.now, reservations) ?? 1) > 0 || load(a) === 0,
  )
  if (!first) throw new RouteBlocked('ESTIMATE_PROBE_IN_FLIGHT')
  return first
}
export class StickyRouter {
  constructor(readonly store: StateStore) {}
  register(account: Account): void {
    const old = this.store.get<Account>('accounts', account.identity)
    this.store.set(
      'accounts',
      account.identity,
      old
        ? {
            ...account,
            aliases: [...new Set([...old.aliases, ...account.aliases])],
            windows: old.windows,
          }
        : account,
    )
  }
  route(req: RouteRequest): Binding {
    return this.store.transaction(() => {
      const reservations = this.store.list<Reservation>('reservations')
      const previous = this.store.get<Binding>('bindings', req.session)
      let binding: Binding
      if (previous) {
        const account = this.store.get<Account>('accounts', previous.identity)
        if (!account || !['READY', 'DRAINING', 'COOLDOWN'].includes(account.state))
          throw new RouteBlocked('BOUND_ACCOUNT_UNAVAILABLE')
        const until = blockedUntil(account, req.model, req.now)
        if (until !== undefined) throw new RouteBlocked('BOUND_ACCOUNT_COOLDOWN', until)
        if (
          account.models[req.model] === undefined ||
          (req.effort !== undefined && !account.models[req.model]!.includes(req.effort))
        )
          throw new RouteBlocked('MODEL_CAPABILITY_UNAVAILABLE')
        if (reservations.some((r) => r.session === req.session))
          throw new RouteBlocked('SESSION_BUSY')
        if (
          reservations.filter((r) => r.identity === account.identity).length >=
          account.parallelLimit
        )
          throw new RouteBlocked('ACCOUNT_QUEUE')
        binding =
          previous.model === req.model && previous.effort === req.effort
            ? previous
            : {
                ...previous,
                model: req.model,
                ...(req.effort ? { effort: req.effort } : {}),
                generation: previous.generation + 1,
                reason: 'explicit-model-or-effort-change',
              }
        if (req.effort === undefined) delete binding.effort
      } else {
        const account = choose(this.store.list<Account>('accounts'), req, reservations)
        binding = {
          key: req.session,
          identity: account.identity,
          model: req.model,
          ...(req.effort ? { effort: req.effort } : {}),
          generation: 1,
          committedCursor: 0,
          pendingTools: [],
          reason: 'work-conserving-sticky',
        }
      }
      const account = this.store.get<Account>('accounts', binding.identity)!
      this.store.set('bindings', req.session, binding)
      this.store.set('reservations', req.requestId, {
        requestId: req.requestId,
        session: req.session,
        identity: binding.identity,
        createdAt: req.now,
        predictedWork: 1,
        epochs: Object.fromEntries(account.windows.map((w) => [w.key, w.epoch])),
      } satisfies Reservation)
      return binding
    })
  }
  release(requestId: string): void {
    this.store.delete('reservations', requestId)
  }
  observe(identity: string, window: QuotaWindow): void {
    const a = this.store.get<Account>('accounts', identity)
    if (!a) return
    const old = a.windows.find((w) => w.key === window.key && w.scope === window.scope)
    if (old && old.observedAt > window.observedAt) return
    a.windows = a.windows.filter((w) => !(w.key === window.key && w.scope === window.scope))
    a.windows.push(window)
    this.store.set('accounts', identity, a)
  }
  migrate(req: RouteRequest, reason: 'quota', safeBoundary: boolean): Binding {
    if (reason !== 'quota' || !safeBoundary) throw new RouteBlocked('UNSAFE_MIGRATION')
    return this.store.transaction(() => {
      const old = this.store.get<Binding>('bindings', req.session)
      if (!old || old.pendingTools.length) throw new RouteBlocked('OUTCOME_UNKNOWN')
      const previousAccount = this.store.get<Account>('accounts', old.identity)
      if (!previousAccount || !['READY', 'DRAINING', 'COOLDOWN'].includes(previousAccount.state))
        throw new RouteBlocked('BOUND_ACCOUNT_UNAVAILABLE')
      if (blockedUntil(previousAccount, req.model, req.now) === undefined)
        throw new RouteBlocked('QUOTA_MIGRATION_UNCONFIRMED')
      if (this.store.list<Reservation>('reservations').some((r) => r.session === req.session))
        throw new RouteBlocked('SESSION_BUSY')
      const account = choose(
        this.store.list<Account>('accounts'),
        req,
        this.store.list<Reservation>('reservations'),
        new Set([old.identity]),
      )
      const next: Binding = {
        ...old,
        identity: account.identity,
        generation: old.generation + 1,
        reason: 'confirmed-quota-migration',
      }
      delete next.sdkSessionId
      this.store.set('bindings', req.session, next)
      return next
    })
  }
  fence(session: string, generation: number): void {
    if (this.store.get<Binding>('bindings', session)?.generation !== generation)
      throw new RouteBlocked('STALE_GENERATION')
  }
}
