import { parseProfileRef } from './login-view.js'
import type {
  Alias,
  AttemptId,
  AuthorizationCode,
  AuthorizeUrl,
  FailureCode,
  LoginTarget,
  LoginView,
  ProfileRef,
} from './login-view.js'
import { ACCOUNT_ALIAS, preferredAccountLabel, RouteBlocked } from './routing/types.js'
import type { Account, AccountState } from './routing/types.js'

export const LOGIN_CHILD_TIMEOUT_MS = 180_000

export type ExchangeState =
  | { readonly phase: 'idle' }
  | {
      readonly phase: 'spawning'
      readonly attempt: AttemptId
      readonly accountLabel: string
      readonly profileRef: ProfileRef
    }
  | {
      readonly phase: 'awaiting_code'
      readonly attempt: AttemptId
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly authorizeUrl: AuthorizeUrl
    }
  | {
      readonly phase: 'writing_code'
      readonly attempt: AttemptId
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly authorizeUrl: AuthorizeUrl
    }
  | {
      readonly phase: 'verifying'
      readonly attempt: AttemptId
      readonly accountLabel: string
      readonly profileRef: ProfileRef
    }
  | {
      readonly phase: 'ready'
      readonly attempt: AttemptId
      readonly accountLabel: string
      readonly profileRef: ProfileRef
    }
  | {
      readonly phase: 'failed'
      readonly attempt: AttemptId
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly failureCode: FailureCode
    }

export type LoginEvent =
  | {
      readonly type: 'begin'
      readonly attempt: AttemptId
      readonly accountLabel: string
      readonly profileRef: ProfileRef
    }
  | { readonly type: 'authorize_url'; readonly url: AuthorizeUrl }
  | { readonly type: 'paste'; readonly attempt: AttemptId; readonly code: AuthorizationCode }
  | { readonly type: 'child_exit'; readonly ok: boolean }
  | { readonly type: 'verify_ok' }
  | { readonly type: 'verify_failed'; readonly failureCode: FailureCode }
  | { readonly type: 'cancel'; readonly attempt: AttemptId }
  | { readonly type: 'timeout' }

export type LoginEffect =
  | { readonly type: 'spawn' }
  | { readonly type: 'arm_timer' }
  | { readonly type: 'clear_timer' }
  | { readonly type: 'write_code'; readonly code: AuthorizationCode }
  | { readonly type: 'kill' }
  | { readonly type: 'verify' }
  | { readonly type: 'release_gate' }
  | { readonly type: 'discard_buffer' }

export interface LoginStep {
  readonly state: ExchangeState
  readonly effects: readonly LoginEffect[]
  /** `reject_not_ready` is an RPC error. `ignore` keeps the current attempt. */
  readonly reaction: 'applied' | 'ignore' | 'reject_not_ready'
}

export interface ResolvedLogin {
  readonly profileRef: ProfileRef
  readonly alias: Alias
  readonly accountLabel: string
  readonly rowStates: readonly AccountState[]
  readonly extraUsageOff: boolean
}

const STOP_EFFECTS: readonly LoginEffect[] = [
  { type: 'kill' },
  { type: 'clear_timer' },
  { type: 'discard_buffer' },
  { type: 'release_gate' },
]

const INCOMPLETE = 'LOGIN_INCOMPLETE' as FailureCode
const CANCELLED = 'LOGIN_CANCELLED' as FailureCode

type Labeled = Exclude<ExchangeState, { phase: 'idle' }>
type BeginEvent = Extract<LoginEvent, { type: 'begin' }>

function ignore(state: ExchangeState): LoginStep {
  return { state, effects: [], reaction: 'ignore' }
}

function rejectNotReady(state: ExchangeState): LoginStep {
  return { state, effects: [], reaction: 'reject_not_ready' }
}

function fail(state: Labeled, failureCode: FailureCode): LoginStep {
  return {
    state: {
      phase: 'failed',
      attempt: state.attempt,
      accountLabel: state.accountLabel,
      profileRef: state.profileRef,
      failureCode,
    },
    effects: STOP_EFFECTS,
    reaction: 'applied',
  }
}

function succeed(state: Labeled): LoginStep {
  return {
    state: {
      phase: 'ready',
      attempt: state.attempt,
      accountLabel: state.accountLabel,
      profileRef: state.profileRef,
    },
    effects: STOP_EFFECTS,
    reaction: 'applied',
  }
}

function spawn(event: BeginEvent): LoginStep {
  return {
    state: {
      phase: 'spawning',
      attempt: event.attempt,
      accountLabel: event.accountLabel,
      profileRef: event.profileRef,
    },
    effects: [{ type: 'spawn' }, { type: 'arm_timer' }],
    reaction: 'applied',
  }
}

/** The child timer must not fail a verify that outlives the CLI. */
function beginVerify(state: Labeled): LoginStep {
  return {
    state: {
      phase: 'verifying',
      attempt: state.attempt,
      accountLabel: state.accountLabel,
      profileRef: state.profileRef,
    },
    effects: [{ type: 'clear_timer' }, { type: 'discard_buffer' }, { type: 'verify' }],
    reaction: 'applied',
  }
}

function onBegin(state: ExchangeState, event: BeginEvent): LoginStep {
  switch (state.phase) {
    case 'idle':
      return spawn(event)
    case 'ready':
    case 'failed':
      if (event.attempt === state.attempt) return ignore(state)
      return spawn(event)
    case 'spawning':
    case 'awaiting_code':
    case 'writing_code':
    case 'verifying':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function onAuthorize(
  state: ExchangeState,
  event: Extract<LoginEvent, { type: 'authorize_url' }>,
): LoginStep {
  switch (state.phase) {
    case 'spawning':
      return {
        state: {
          phase: 'awaiting_code',
          attempt: state.attempt,
          accountLabel: state.accountLabel,
          profileRef: state.profileRef,
          authorizeUrl: event.url,
        },
        effects: [{ type: 'discard_buffer' }],
        reaction: 'applied',
      }
    case 'idle':
    case 'awaiting_code':
    case 'writing_code':
    case 'verifying':
    case 'ready':
    case 'failed':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function onPaste(state: ExchangeState, event: Extract<LoginEvent, { type: 'paste' }>): LoginStep {
  switch (state.phase) {
    case 'spawning':
      return rejectNotReady(state)
    case 'awaiting_code':
      if (event.attempt !== state.attempt) return ignore(state)
      return {
        state: { ...state, phase: 'writing_code' },
        effects: [{ type: 'write_code', code: event.code }],
        reaction: 'applied',
      }
    case 'idle':
    case 'writing_code':
    case 'verifying':
    case 'ready':
    case 'failed':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function onChildExit(
  state: ExchangeState,
  event: Extract<LoginEvent, { type: 'child_exit' }>,
): LoginStep {
  switch (state.phase) {
    case 'spawning':
    case 'awaiting_code':
    case 'writing_code':
      return event.ok ? beginVerify(state) : fail(state, INCOMPLETE)
    case 'idle':
    case 'verifying':
    case 'ready':
    case 'failed':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function onVerifyOk(state: ExchangeState): LoginStep {
  switch (state.phase) {
    case 'verifying':
      return succeed(state)
    case 'idle':
    case 'spawning':
    case 'awaiting_code':
    case 'writing_code':
    case 'ready':
    case 'failed':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function onVerifyFailed(
  state: ExchangeState,
  event: Extract<LoginEvent, { type: 'verify_failed' }>,
): LoginStep {
  switch (state.phase) {
    case 'verifying':
      return fail(state, event.failureCode)
    case 'idle':
    case 'spawning':
    case 'awaiting_code':
    case 'writing_code':
    case 'ready':
    case 'failed':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function onCancel(state: ExchangeState, event: Extract<LoginEvent, { type: 'cancel' }>): LoginStep {
  switch (state.phase) {
    case 'spawning':
    case 'awaiting_code':
    case 'writing_code':
      if (event.attempt !== state.attempt) return ignore(state)
      return fail(state, CANCELLED)
    case 'idle':
    case 'verifying':
    case 'ready':
    case 'failed':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

function onTimeout(state: ExchangeState): LoginStep {
  switch (state.phase) {
    case 'spawning':
    case 'awaiting_code':
    case 'writing_code':
      return fail(state, INCOMPLETE)
    case 'idle':
    case 'verifying':
    case 'ready':
    case 'failed':
      return ignore(state)
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

export function stepLogin(state: ExchangeState, event: LoginEvent): LoginStep {
  switch (event.type) {
    case 'begin':
      return onBegin(state, event)
    case 'authorize_url':
      return onAuthorize(state, event)
    case 'paste':
      return onPaste(state, event)
    case 'child_exit':
      return onChildExit(state, event)
    case 'verify_ok':
      return onVerifyOk(state)
    case 'verify_failed':
      return onVerifyFailed(state, event)
    case 'cancel':
      return onCancel(state, event)
    case 'timeout':
      return onTimeout(state)
    default: {
      const _exhaustive: never = event
      return _exhaustive
    }
  }
}

/** `idle` is the absence of a record, so it has no view. */
export function toLoginView(state: ExchangeState): LoginView {
  switch (state.phase) {
    case 'idle':
      throw new RouteBlocked('LOGIN_NOT_READY')
    case 'spawning':
      return {
        phase: 'opening',
        accountLabel: state.accountLabel,
        profileRef: state.profileRef,
        attempt: state.attempt,
      }
    case 'awaiting_code':
      return {
        phase: 'needs_code',
        accountLabel: state.accountLabel,
        profileRef: state.profileRef,
        attempt: state.attempt,
        authorizeUrl: state.authorizeUrl,
      }
    case 'writing_code':
    case 'verifying':
      return {
        phase: 'finishing',
        accountLabel: state.accountLabel,
        profileRef: state.profileRef,
        attempt: state.attempt,
      }
    case 'ready':
      return {
        phase: 'ready',
        accountLabel: state.accountLabel,
        profileRef: state.profileRef,
        attempt: state.attempt,
      }
    case 'failed':
      return {
        phase: 'failed',
        accountLabel: state.accountLabel,
        profileRef: state.profileRef,
        attempt: state.attempt,
        failureCode: state.failureCode,
      }
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

export function accountAllowsLogin(state: AccountState): boolean {
  switch (state) {
    case 'READY':
    case 'AUTH_REQUIRED':
    case 'SUSPENDED':
    case 'DISABLED':
      return true
    case 'DRAINING':
    case 'COOLDOWN':
      return false
    default: {
      const _exhaustive: never = state
      return _exhaustive
    }
  }
}

/**
 * Empty `rowStates` is a new profile and is admitted.
 * A reservation is refused only after every row is allowed to log in.
 */
export function admitLogin(input: {
  readonly rowStates: readonly AccountState[]
  readonly reservationsForProfile: number
}):
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'ACCOUNT_NOT_READY' | 'PROFILE_LOGIN_BUSY' } {
  for (const state of input.rowStates) {
    if (!accountAllowsLogin(state)) return { ok: false, code: 'ACCOUNT_NOT_READY' }
  }
  if (input.reservationsForProfile > 0) return { ok: false, code: 'PROFILE_LOGIN_BUSY' }
  return { ok: true }
}

function rowsFor(accounts: readonly Account[], profileRef: string): Account[] {
  return accounts.filter((account) => account.profileRef === profileRef)
}

function aliasOwners(accounts: readonly Account[], alias: string): Account[] {
  return accounts.filter((account) => account.aliases.includes(alias))
}

function assertAliasOnProfile(
  accounts: readonly Account[],
  alias: string,
  profileRef: string,
): void {
  if (aliasOwners(accounts, alias).some((account) => account.profileRef !== profileRef))
    throw new RouteBlocked('ALIAS_IDENTITY_CHANGED')
}

function storedAlias(rows: readonly Account[]): Alias {
  for (const row of rows) {
    const alias = row.aliases.find((item) => ACCOUNT_ALIAS.test(item))
    if (alias !== undefined) return alias as Alias
  }
  throw new RouteBlocked('ACCOUNT_NOT_FOUND')
}

function confirmedOff(rows: readonly Account[], requested: boolean): boolean {
  return requested || rows.some((row) => row.extraUsageOffConfirmedAt !== undefined)
}

function resolved(
  profileRef: ProfileRef,
  alias: Alias,
  rows: readonly Account[],
  extraUsageOff: boolean,
): ResolvedLogin {
  return {
    profileRef,
    alias,
    accountLabel: preferredAccountLabel([alias, ...rows.flatMap((row) => row.aliases)], profileRef),
    rowStates: rows.map((row) => row.state),
    extraUsageOff: confirmedOff(rows, extraUsageOff),
  }
}

/** An alias that already belongs to a different profileRef is refused before a child exists. */
export function resolveLoginTarget(
  target: LoginTarget,
  accounts: readonly Account[],
  extraUsageOff: boolean,
): ResolvedLogin {
  switch (target.kind) {
    case 'alias': {
      const owners = aliasOwners(accounts, target.alias)
      const owner = owners[0]
      if (owner === undefined) throw new RouteBlocked('ACCOUNT_NOT_FOUND')
      const profileRef = parseProfileRef(owner.profileRef)
      if (owners.some((account) => account.profileRef !== profileRef))
        throw new RouteBlocked('ALIAS_IDENTITY_CHANGED')
      const rows = rowsFor(accounts, profileRef)
      return resolved(profileRef, target.alias, rows, extraUsageOff)
    }
    case 'profile': {
      const rows = rowsFor(accounts, target.profile)
      const alias = target.alias ?? storedAlias(rows)
      if (target.alias !== undefined) assertAliasOnProfile(accounts, target.alias, target.profile)
      return resolved(target.profile, alias, rows, extraUsageOff)
    }
    case 'identity': {
      const row = accounts.find((account) => account.identity === target.identity)
      if (row === undefined) throw new RouteBlocked('ACCOUNT_NOT_FOUND')
      const profileRef = parseProfileRef(row.profileRef)
      assertAliasOnProfile(accounts, target.alias, profileRef)
      return resolved(profileRef, target.alias, rowsFor(accounts, profileRef), extraUsageOff)
    }
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}

const gates = new WeakMap<object, ProfileLoginGate>()

export class ProfileLoginGate {
  readonly #held = new Set<string>()

  holds(profileRef: string): boolean {
    return this.#held.has(profileRef)
  }

  hold(profileRef: string): void {
    this.#held.add(profileRef)
  }

  release(profileRef: string): void {
    this.#held.delete(profileRef)
  }
}

/** Missing gate means the profile is not held. */
export function profileLoginHeld(store: object, profileRef: string): boolean {
  return gates.get(store)?.holds(profileRef) ?? false
}

export function bindLoginGate(store: object, gate: ProfileLoginGate): void {
  gates.set(store, gate)
}

const CSI = /\u001b\[[0-?]*[ -/]*[@-~]/g
const HTTP_URL = /https:\/\/[^\s<>"']+/g
const TRAILING_PUNCT = /[),.;\]]+$/
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/

function allowHost(host: string): boolean {
  if (host.length === 0) return false
  if (host === 'localhost' || host.endsWith('.localhost')) return false
  if (host.includes(':') || IPV4.test(host) || /^\d+$/.test(host)) return false
  return (
    host === 'claude.ai' ||
    host === 'claude.com' ||
    host.endsWith('.claude.ai') ||
    host.endsWith('.claude.com')
  )
}

function allowUrl(candidate: string): boolean {
  if (candidate.length === 0 || candidate.length > 4096) return false
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return false
  return allowHost(url.hostname.toLowerCase().replace(/\.$/, ''))
}

/**
 * A URL must be followed by whitespace so a split chunk is not treated as complete.
 * Localhost, userinfo, and raw addresses are not links.
 */
export function extractAuthorizeUrl(buffered: string): AuthorizeUrl | undefined {
  const text = buffered.replace(CSI, '').replaceAll('\r', '')
  for (const match of text.matchAll(HTTP_URL)) {
    const token = match[0]
    const start = match.index
    if (token === undefined || start === undefined) continue
    const after = text[start + token.length]
    if (after === undefined || !/\s/.test(after)) continue
    const candidate = token.replace(TRAILING_PUNCT, '')
    if (!allowUrl(candidate)) continue
    return candidate as AuthorizeUrl
  }
  return undefined
}
