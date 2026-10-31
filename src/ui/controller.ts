import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { profileEnvironment, verifyAccount } from '../auth/official.js'
import {
  admitLogin,
  bindLoginGate,
  extractAuthorizeUrl,
  LOGIN_CHILD_TIMEOUT_MS,
  LOGIN_CODE_TIMEOUT_MS,
  ProfileLoginGate,
  resolveLoginTarget,
  stepLogin,
  toLoginView,
} from '../login-exchange.js'
import type { ExchangeState, LoginEffect, LoginEvent } from '../login-exchange.js'
import {
  discardStagingKeychain,
  installDarwinKeychain,
  installVerifiedCredentials,
  mirrorProfileReady,
} from '../login-install.js'
import { failureCode, parseLoginPayload, parseProfileRef } from '../login-view.js'
import type { Alias, LoginIntent, LoginView, ProfileRef } from '../login-view.js'
import { UsageHistory } from '../metrics/history.js'
import { KeyedQueue } from '../routing/control.js'
import { StickyRouter } from '../routing/router.js'
import { RouteBlocked, type Account, type Binding, type Reservation } from '../routing/types.js'
import { StateStore } from '../storage/store.js'
import { spawnLoginPty, type LoginPty } from './login-pty.js'

const SCRAPE_LIMIT = 65_536

interface ExchangeRecord {
  state: ExchangeState
  profileRef: ProfileRef
  alias: Alias
  extraUsageOff: boolean
  previousIdentity: string | undefined
  stagingDir: string
  buffer: string
  child: LoginPty | undefined
  timer: ReturnType<typeof setTimeout> | undefined
  verifyTask: Promise<void> | undefined
}

function routeBindings(store: StateStore): (identity: string) => string | null {
  if (!store.indexed || store.missingIndexKey('bindings')) {
    const bindings = store.list<Binding>('bindings')
    return (identity) =>
      bindings.filter((binding) => binding.identity === identity).at(-1)?.reason ?? null
  }
  return (identity) =>
    store.queryValues<Binding>(
      `SELECT value FROM state INDEXED BY state_binding_identity
       WHERE collection = 'bindings' AND k1 = ? ORDER BY key DESC LIMIT 1`,
      identity,
    )[0]?.reason ?? null
}

function terminal(state: ExchangeState): boolean {
  return state.phase === 'ready' || state.phase === 'failed'
}

export class AccountController {
  readonly locks = new KeyedQueue()
  readonly gate = new ProfileLoginGate()
  readonly exchanges = new Map<string, ExchangeRecord>()
  #depth = 0

  constructor(
    readonly state: () => StateStore,
    readonly command: string,
    readonly defaults = { model: 'opus' },
    readonly deps: {
      verify?: typeof verifyAccount
      spawnLogin?: (command: string, profileRef: ProfileRef) => LoginPty
      pending?: () => readonly { phase: string; identity?: string }[]
      retireIdle?: (profileRef: string) => void
    } = {},
  ) {}

  status() {
    const s = this.state(),
      reservations = s.list<Reservation>('reservations'),
      bindings = routeBindings(s)
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
        ...(a.modelMetadata ? { modelMetadata: a.modelMetadata } : {}),
        windows: a.windows.map((w) => ({
          ...w,
          remaining:
            w.utilization === undefined || (w.resetsAt !== undefined && w.resetsAt <= Date.now())
              ? null
              : Math.max(0, 1 - w.utilization),
        })),
        lastRouteReason: bindings(a.identity),
      })),
      usage: new UsageHistory(s).summary(),
    }
  }

  async execute(action: string, payload: unknown): Promise<unknown> {
    if (action === 'status') return this.status()
    if (action === 'login') return this.login(parseLoginPayload(payload))
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
      if (action === 'add' || action === 'verify') {
        if (action === 'verify' && !old) throw new RouteBlocked('ACCOUNT_NOT_FOUND')
        if (p.profile !== undefined && typeof p.profile !== 'string')
          throw new RouteBlocked('INVALID_PROFILE')
        const profile = typeof p.profile === 'string' ? p.profile : (old?.profileRef ?? 'default')
        profileEnvironment(profile)
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

  async login(
    intent: LoginIntent,
  ): Promise<ReturnType<AccountController['status']> & { exchange: LoginView }> {
    switch (intent.op) {
      case 'open': {
        const record = await this.#begin(intent)
        if (record.verifyTask) await record.verifyTask
        return this.#respond(record)
      }
      case 'paste':
        return this.#paste(intent)
      case 'close':
        return this.#close(intent)
      case 'read':
        return this.#read(intent.target)
      default: {
        const _exhaustive: never = intent
        return _exhaustive
      }
    }
  }

  dispose(): void {
    for (const [profile, record] of this.exchanges) {
      if (record.timer !== undefined) clearTimeout(record.timer)
      record.timer = undefined
      this.#kill(record)
      record.buffer = ''
      this.#discardStaging(record)
      this.gate.release(profile)
    }
    this.exchanges.clear()
  }

  async #begin(intent: Extract<LoginIntent, { op: 'open' }>): Promise<ExchangeRecord> {
    const release = await this.locks.acquire('account-management')
    let profile: ProfileRef | undefined
    let inserted = false
    let stagingDir = ''
    try {
      const store = this.state()
      bindLoginGate(store, this.gate)
      const accounts = store.list<Account>('accounts')
      const resolved = resolveLoginTarget(intent.target, accounts, intent.extraUsageOff)
      profile = resolved.profileRef
      const existing = this.exchanges.get(resolved.profileRef)
      if (
        existing &&
        existing.state.phase !== 'idle' &&
        (!terminal(existing.state) || existing.state.attempt === intent.attempt)
      )
        return existing
      const admitted = admitLogin({
        rowStates: resolved.rowStates,
        reservationsForProfile: this.#reservations(store, resolved.profileRef),
      })
      if (!admitted.ok) throw new RouteBlocked(admitted.code)
      const previous = this.#previous(intent.target, accounts, resolved.profileRef, resolved.alias)
      stagingDir = mkdtempSync(join(tmpdir(), 'dsh-claude-login-'))
      const created: ExchangeRecord = {
        state: { phase: 'idle' },
        profileRef: resolved.profileRef,
        alias: resolved.alias,
        extraUsageOff: resolved.extraUsageOff,
        previousIdentity: previous,
        stagingDir,
        buffer: '',
        child: undefined,
        timer: undefined,
        verifyTask: undefined,
      }
      if (!resolved.rowStates.includes('READY')) this.gate.hold(resolved.profileRef)
      this.exchanges.set(resolved.profileRef, created)
      inserted = true
      this.#apply(created, {
        type: 'begin',
        attempt: intent.attempt,
        accountLabel: resolved.accountLabel,
        profileRef: resolved.profileRef,
      })
      return created
    } catch (error) {
      if (inserted && profile !== undefined) {
        const record = this.exchanges.get(profile)
        if (record?.timer !== undefined) clearTimeout(record.timer)
        if (record) {
          this.#kill(record)
          this.#discardStaging(record)
        }
        this.gate.release(profile)
        this.exchanges.delete(profile)
      } else if (stagingDir !== '') rmSync(stagingDir, { recursive: true, force: true })
      throw error
    } finally {
      release()
    }
  }

  async #paste(intent: Extract<LoginIntent, { op: 'paste' }>) {
    const record = this.#require(intent.target)
    const result = this.#apply(record, {
      type: 'paste',
      attempt: intent.attempt,
      code: intent.code,
    })
    if (result.reaction === 'reject_not_ready') throw new RouteBlocked('LOGIN_NOT_READY')
    if (record.verifyTask) await record.verifyTask
    return this.#respond(record)
  }

  async #close(intent: Extract<LoginIntent, { op: 'close' }>) {
    const record = this.#require(intent.target)
    this.#apply(record, { type: 'cancel', attempt: intent.attempt })
    return this.#respond(record)
  }

  async #read(target: LoginIntent['target']) {
    const record = this.#require(target)
    if (record.verifyTask) await record.verifyTask
    return this.#respond(record)
  }

  #require(target: LoginIntent['target']): ExchangeRecord {
    const resolved = resolveLoginTarget(target, this.state().list<Account>('accounts'), false)
    const record = this.exchanges.get(resolved.profileRef)
    if (!record || record.state.phase === 'idle') throw new RouteBlocked('LOGIN_NOT_READY')
    return record
  }

  #respond(record: ExchangeRecord): ReturnType<AccountController['status']> & { exchange: LoginView } {
    if (record.state.phase === 'idle') throw new RouteBlocked('LOGIN_NOT_READY')
    return { ...this.status(), exchange: toLoginView(record.state) }
  }

  #reservations(store: StateStore, profileRef: string): number {
    const identities = new Set(
      store
        .list<Account>('accounts')
        .filter((account) => account.profileRef === profileRef)
        .map((account) => account.identity),
    )
    return store
      .list<Reservation>('reservations')
      .filter((reservation) => identities.has(reservation.identity)).length
  }

  #previous(
    target: LoginIntent['target'],
    accounts: readonly Account[],
    profileRef: string,
    alias: string,
  ): string | undefined {
    switch (target.kind) {
      case 'identity':
        return target.identity
      case 'alias':
      case 'profile':
        return (
          accounts.find(
            (account) => account.profileRef === profileRef && account.aliases.includes(alias),
          )?.identity ?? accounts.find((account) => account.profileRef === profileRef)?.identity
        )
      default: {
        const _exhaustive: never = target
        return _exhaustive
      }
    }
  }

  #apply(
    record: ExchangeRecord,
    event: LoginEvent,
  ): { reaction: 'applied' | 'ignore' | 'reject_not_ready'; verify: boolean } {
    this.#depth += 1
    try {
      const step = stepLogin(record.state, event)
      if (step.reaction !== 'applied') return { reaction: step.reaction, verify: false }
      record.state = step.state
      let verify = false
      for (const effect of step.effects) {
        if (this.#effect(record, effect)) verify = true
      }
      if (terminal(record.state)) this.#discardStaging(record)
      if (verify) this.#requestVerify(record)
      return { reaction: 'applied', verify }
    } finally {
      this.#depth -= 1
      if (this.#depth === 0) this.#drain(record)
    }
  }

  #effect(record: ExchangeRecord, effect: LoginEffect): boolean {
    switch (effect.type) {
      case 'spawn':
        record.child = (this.deps.spawnLogin ?? spawnLoginPty)(
          this.command,
          parseProfileRef(record.stagingDir),
        )
        record.child.onData((chunk) => {
          if (record.state.phase !== 'spawning') return
          record.buffer = (record.buffer + chunk).slice(-SCRAPE_LIMIT)
          if (this.#depth === 0) this.#drain(record)
        })
        record.child.onExit((event) => {
          const ok = event.exitCode === 0 && (event.signal === undefined || event.signal === 0)
          this.#apply(record, { type: 'child_exit', ok })
        })
        return false
      case 'arm_timer':
        if (
          record.state.phase !== 'spawning' &&
          record.state.phase !== 'awaiting_code' &&
          record.state.phase !== 'writing_code'
        )
          return false
        if (record.timer !== undefined) clearTimeout(record.timer)
        record.timer = setTimeout(
          () => {
            record.timer = undefined
            this.#apply(record, { type: 'timeout' })
          },
          effect.limit === 'code' ? LOGIN_CODE_TIMEOUT_MS : LOGIN_CHILD_TIMEOUT_MS,
        )
        record.timer.unref()
        return false
      case 'clear_timer':
        if (record.timer !== undefined) clearTimeout(record.timer)
        record.timer = undefined
        return false
      case 'write_code':
        record.child?.write(effect.code + '\r')
        return false
      case 'kill':
        this.#kill(record)
        return false
      case 'verify':
        return true
      case 'release_gate':
        this.gate.release(record.profileRef)
        return false
      case 'discard_buffer':
        record.buffer = ''
        return false
      default: {
        const _exhaustive: never = effect
        return _exhaustive
      }
    }
  }

  #drain(record: ExchangeRecord): void {
    if (record.state.phase !== 'spawning' || record.buffer.length === 0) return
    const url = extractAuthorizeUrl(record.buffer)
    if (url === undefined) return
    this.#apply(record, { type: 'authorize_url', url })
  }

  #kill(record: ExchangeRecord): void {
    record.child?.kill()
  }

  #discardStaging(record: ExchangeRecord): void {
    if (record.stagingDir === '') return
    const stagingDir = record.stagingDir
    rmSync(stagingDir, { recursive: true, force: true })
    record.stagingDir = ''
    discardStagingKeychain(stagingDir)
  }

  #requestVerify(record: ExchangeRecord): void {
    if (record.verifyTask) return
    record.verifyTask = this.#verify(record)
  }

  async #verify(record: ExchangeRecord): Promise<void> {
    let account: Account
    try {
      account = await (this.deps.verify ?? verifyAccount)(
        this.state(),
        this.command,
        record.alias,
        record.stagingDir,
        record.extraUsageOff,
      )
    } catch (error) {
      await this.#settle(record, { type: 'verify_failed', failureCode: failureCode(error) })
      return
    }
    if (account.state !== 'READY') {
      await this.#settle(record, {
        type: 'verify_failed',
        failureCode: failureCode(new RouteBlocked('LOGIN_INCOMPLETE')),
      })
      return
    }
    await this.#settle(record, { type: 'verify_ok' }, account)
  }

  async #settle(
    record: ExchangeRecord,
    event: Extract<LoginEvent, { type: 'verify_ok' | 'verify_failed' }>,
    account?: Account,
  ): Promise<void> {
    const release = await this.locks.acquire('account-management')
    try {
      if (this.exchanges.get(record.profileRef) !== record || record.state.phase !== 'verifying')
        return
      if (event.type === 'verify_failed') {
        this.#apply(record, event)
        return
      }
      if (account === undefined || account.state !== 'READY') {
        this.#apply(record, {
          type: 'verify_failed',
          failureCode: failureCode(new RouteBlocked('LOGIN_INCOMPLETE')),
        })
        return
      }
      const store = this.state()
      const previous = record.previousIdentity
        ? store.get<Account>('accounts', record.previousIdentity)
        : undefined
      if (previous && previous.identity !== account.identity) {
        this.#apply(record, {
          type: 'verify_failed',
          failureCode: failureCode(new RouteBlocked('ALIAS_IDENTITY_CHANGED')),
        })
        return
      }
      const committed = { ...account, profileRef: record.profileRef }
      if (previous?.isDefault) committed.isDefault = true
      try {
        const fileInstalled = installVerifiedCredentials(record.stagingDir, record.profileRef)
        if (!fileInstalled || process.platform === 'darwin')
          await installDarwinKeychain(record.stagingDir, record.profileRef)
      } catch (error) {
        this.#apply(record, { type: 'verify_failed', failureCode: failureCode(error) })
        return
      }
      new StickyRouter(store).register(committed)
      this.deps.retireIdle?.(record.profileRef)
      mirrorProfileReady(store.directory, committed)
      this.#apply(record, { type: 'verify_ok' })
    } finally {
      release()
    }
  }
}
