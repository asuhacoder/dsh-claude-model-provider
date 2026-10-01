import { spawn } from 'node:child_process'
import { StateStore } from '../storage/store.js'
import { StickyRouter } from '../routing/router.js'
import { RouteBlocked, type Account, type Binding, type Reservation } from '../routing/types.js'
import { verifyAccount, profileEnvironment } from '../auth/official.js'
import { UsageHistory } from '../metrics/history.js'
import { KeyedQueue } from '../routing/control.js'

export async function officialLogin(command: string, profile: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, ['auth', 'login', '--claudeai'], {
      env: profileEnvironment(profile),
      stdio: 'inherit',
      timeout: 180000,
    })
    child.once('error', () => reject(new RouteBlocked('LOGIN_START_FAILED')))
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new RouteBlocked('LOGIN_INCOMPLETE')),
    )
  })
}
export class AccountController {
  readonly locks = new KeyedQueue()
  constructor(
    readonly state: () => StateStore,
    readonly command: string,
    readonly defaults = { model: 'opus' },
    readonly deps: {
      verify?: typeof verifyAccount
      login?: typeof officialLogin
      pending?: () => readonly { phase: string; identity?: string }[]
    } = {},
  ) {}
  status() {
    const s = this.state(),
      reservations = s.list<Reservation>('reservations'),
      bindings = s.list<Binding>('bindings')
    return {
      pending: this.deps.pending?.() ?? [],
      defaultModel: s.get<string>('preferences', 'default-model') ?? this.defaults.model,
      accounts: s.list<Account>('accounts').map((a) => ({
        id: a.identity,
        aliases: a.aliases,
        state: a.state,
        verifiedAt: a.verifiedAt,
        billingSafety: a.extraUsageOffConfirmedAt ? 'user-confirmed-off' : 'unverified',
        isDefault: a.isDefault ?? false,
        inFlight: reservations.filter((r) => r.identity === a.identity).length,
        models: a.models,
        windows: a.windows.map((w) => ({
          ...w,
          remaining:
            w.utilization === undefined || (w.resetsAt !== undefined && w.resetsAt <= Date.now())
              ? null
              : Math.max(0, 1 - w.utilization),
        })),
        lastRouteReason: bindings.filter((b) => b.identity === a.identity).at(-1)?.reason ?? null,
      })),
      usage: new UsageHistory(s).summary(),
    }
  }
  async execute(action: string, payload: unknown): Promise<unknown> {
    if (action === 'status') return this.status()
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      throw new RouteBlocked('INVALID_PAYLOAD')
    const p = payload as Record<string, unknown>,
      s = this.state()
    if (action === 'setModel') {
      if (
        typeof p.model !== 'string' ||
        !s
          .list<Account>('accounts')
          .some((a) => a.state !== 'DISABLED' && a.models[p.model as string])
      )
        throw new RouteBlocked('MODEL_CAPABILITY_UNAVAILABLE')
      s.set('preferences', 'default-model', p.model)
      return this.status()
    }
    if (typeof p.alias !== 'string' || !/^[A-Za-z0-9_-]{1,48}$/.test(p.alias))
      throw new RouteBlocked('INVALID_ALIAS')
    const alias = p.alias,
      release = await this.locks.acquire('account-management')
    try {
      const old = s.list<Account>('accounts').find((a) => a.aliases.includes(alias))
      if (action === 'add' || action === 'verify' || action === 'login') {
        if (action === 'verify' && !old) throw new RouteBlocked('ACCOUNT_NOT_FOUND')
        if (p.profile !== undefined && typeof p.profile !== 'string')
          throw new RouteBlocked('INVALID_PROFILE')
        const profile = typeof p.profile === 'string' ? p.profile : (old?.profileRef ?? 'default')
        profileEnvironment(profile)
        if (action === 'login') {
          if (s.list<Reservation>('reservations').length)
            throw new RouteBlocked('LOGIN_REQUIRES_IDLE')
          s.set('meta', 'auth-mutation', true)
          try {
            await (this.deps.login ?? officialLogin)(this.command, profile)
          } finally {
            s.delete('meta', 'auth-mutation')
          }
        }
        const account = await (this.deps.verify ?? verifyAccount)(
          s,
          this.command,
          alias,
          profile,
          p.extraUsageOff === true || Boolean(old?.extraUsageOffConfirmedAt),
        )
        if (old && old.identity !== account.identity)
          throw new RouteBlocked('ALIAS_IDENTITY_CHANGED')
        if (old?.isDefault) account.isDefault = true
        new StickyRouter(s).register(account)
      } else {
        if (!old) throw new RouteBlocked('ACCOUNT_NOT_FOUND')
        if (action === 'remove') {
          if (s.list<Reservation>('reservations').some((r) => r.identity === old.identity))
            throw new RouteBlocked('ACCOUNT_BUSY')
          old.aliases = old.aliases.filter((a) => a !== alias)
          if (!old.aliases.length) {
            old.state = 'DISABLED'
            delete old.isDefault
          }
          s.set('accounts', old.identity, old)
        } else if (action === 'setDefault') {
          if (old.state === 'DISABLED') throw new RouteBlocked('ACCOUNT_NOT_READY')
          s.transaction(() => {
            for (const a of s.list<Account>('accounts'))
              s.set('accounts', a.identity, { ...a, isDefault: a.identity === old.identity })
          })
        } else throw new RouteBlocked('UNKNOWN_ACTION')
      }
      return this.status()
    } finally {
      release()
    }
  }
}
