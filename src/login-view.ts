import { ACCOUNT_ALIAS, RouteBlocked, visibleAccountLabel } from './routing/types.js'

declare const brand: unique symbol
type Brand<T, B extends string> = T & { readonly [brand]: B }

export type AttemptId = Brand<string, 'AttemptId'>
export type Alias = Brand<string, 'Alias'>
export type ProfileRef = Brand<string, 'ProfileRef'>
export type AuthorizationCode = Brand<string, 'AuthorizationCode'>
export type AuthorizeUrl = Brand<string, 'AuthorizeUrl'>
export type FailureCode = Brand<string, 'FailureCode'>

export type LoginTarget =
  | { readonly kind: 'alias'; readonly alias: Alias }
  | { readonly kind: 'profile'; readonly profile: ProfileRef; readonly alias?: Alias }
  | { readonly kind: 'identity'; readonly identity: string; readonly alias: Alias }

export type ParsedLoginFailure =
  | { readonly kind: 'alias'; readonly alias: Alias }
  | { readonly kind: 'profile'; readonly profile: ProfileRef }

export type LoginIntent =
  | {
      readonly op: 'open'
      readonly attempt: AttemptId
      readonly target: LoginTarget
      readonly extraUsageOff: boolean
    }
  | {
      readonly op: 'paste'
      readonly attempt: AttemptId
      readonly target: LoginTarget
      readonly code: AuthorizationCode
    }
  | { readonly op: 'close'; readonly attempt: AttemptId; readonly target: LoginTarget }
  | { readonly op: 'read'; readonly target: LoginTarget }

export type LoginView =
  | {
      readonly phase: 'opening'
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly attempt: AttemptId
    }
  | {
      readonly phase: 'needs_code'
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly attempt: AttemptId
      readonly authorizeUrl: AuthorizeUrl
    }
  | {
      readonly phase: 'finishing'
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly attempt: AttemptId
    }
  | {
      readonly phase: 'ready'
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly attempt: AttemptId
    }
  | {
      readonly phase: 'failed'
      readonly accountLabel: string
      readonly profileRef: ProfileRef
      readonly attempt: AttemptId
      readonly failureCode: FailureCode
    }

const ATTEMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const STABLE_CODE = /^[A-Z][A-Z0-9_]{0,63}$/
const PRINTABLE = /^[\x21-\x7E]+$/

export function parseAttemptId(value: unknown): AttemptId {
  if (typeof value !== 'string' || !ATTEMPT_ID.test(value))
    throw new RouteBlocked('INVALID_PAYLOAD')
  return value as AttemptId
}

export function parseAlias(value: unknown): Alias {
  if (typeof value !== 'string' || !ACCOUNT_ALIAS.test(value))
    throw new RouteBlocked('INVALID_ALIAS')
  return value as Alias
}

function absoluteProfile(value: string): boolean {
  return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
}

export function parseProfileRef(value: unknown): ProfileRef {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024)
    throw new RouteBlocked('INVALID_PROFILE')
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new RouteBlocked('INVALID_PROFILE')
  if (value !== 'default' && !absoluteProfile(value))
    throw new RouteBlocked('PROFILE_MUST_BE_ABSOLUTE')
  return value as ProfileRef
}

export function parseAuthorizationCode(value: unknown): AuthorizationCode {
  if (
    typeof value !== 'string' ||
    value.length < 4 ||
    value.length > 1024 ||
    !PRINTABLE.test(value)
  )
    throw new RouteBlocked('LOGIN_CODE_REJECTED')
  if (value.includes('://') || value.includes('sk-ant-'))
    throw new RouteBlocked('LOGIN_CODE_REJECTED')
  return value as AuthorizationCode
}

export function failureCode(value: unknown): FailureCode {
  if (value instanceof RouteBlocked && STABLE_CODE.test(value.code))
    return value.code as FailureCode
  return 'LOGIN_INCOMPLETE' as FailureCode
}

function parseIdentity(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 128 || !PRINTABLE.test(value))
    throw new RouteBlocked('INVALID_PAYLOAD')
  return value
}

function parseTarget(body: Record<string, unknown>): LoginTarget {
  if (body.id !== undefined) {
    return { kind: 'identity', identity: parseIdentity(body.id), alias: parseAlias(body.alias) }
  }
  if (body.profile !== undefined) {
    const profile = parseProfileRef(body.profile)
    if (body.alias === undefined) return { kind: 'profile', profile }
    return { kind: 'profile', profile, alias: parseAlias(body.alias) }
  }
  if (body.alias !== undefined) return { kind: 'alias', alias: parseAlias(body.alias) }
  throw new RouteBlocked('INVALID_PAYLOAD')
}

export function parseLoginPayload(payload: unknown): LoginIntent {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload))
    throw new RouteBlocked('INVALID_PAYLOAD')
  const body = payload as Record<string, unknown>
  const target = parseTarget(body)
  switch (body.op) {
    case 'read':
      return { op: 'read', target }
    case 'open':
      return {
        op: 'open',
        attempt: parseAttemptId(body.attempt),
        target,
        extraUsageOff: body.extraUsageOff === true,
      }
    case 'paste':
      return {
        op: 'paste',
        attempt: parseAttemptId(body.attempt),
        target,
        code: parseAuthorizationCode(body.code),
      }
    case 'close':
      return { op: 'close', attempt: parseAttemptId(body.attempt), target }
    default:
      throw new RouteBlocked('INVALID_PAYLOAD')
  }
}

export const LOGIN_REQUIRED_PREFIX = 'SUBSCRIPTION_LOGIN_REQUIRED: '
export const LOGIN_COMMAND = 'claude-login'
const LOGIN_COMMAND_HINT = ` · /${LOGIN_COMMAND} `

export function formatLoginRequiredMessage(label: string): string {
  return `${LOGIN_REQUIRED_PREFIX}${label}${LOGIN_COMMAND_HINT}${label}`
}

export function parseLoginLabel(label: string): ParsedLoginFailure | undefined {
  if (label === 'default' || ACCOUNT_ALIAS.test(label))
    return { kind: 'alias', alias: label as Alias }
  if (visibleAccountLabel(label) === label && absoluteProfile(label))
    return { kind: 'profile', profile: label as ProfileRef }
  return undefined
}

export function parseLoginRequiredMessage(message: string): ParsedLoginFailure | undefined {
  if (!message.startsWith(LOGIN_REQUIRED_PREFIX)) return undefined
  let label = message.slice(LOGIN_REQUIRED_PREFIX.length)
  const hintAt = label.indexOf(LOGIN_COMMAND_HINT)
  if (hintAt !== -1) label = label.slice(0, hintAt)
  return parseLoginLabel(label)
}
