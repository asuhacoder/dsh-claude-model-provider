export type AccountState =
  'READY' | 'DRAINING' | 'COOLDOWN' | 'AUTH_REQUIRED' | 'SUSPENDED' | 'DISABLED'
export interface QuotaWindow {
  key: string
  scope: string // '*' or an exact model; observations never manufacture a quota.
  epoch: string
  observedAt: number
  resetsAt?: number
  utilization?: number
  remainingWork?: number
  hardBlockedUntil?: number
  source: 'sdk' | 'fixture' | 'estimate'
}
export interface ModelPresentation {
  displayName?: string
  description?: string
  resolvedModel?: string
  contextWindow?: number
  maxOutputTokens?: number
}
export interface Account {
  identity: string
  aliases: string[]
  profileRef: string // 'default' or a path; never credential contents.
  state: AccountState
  verifiedAt: number
  extraUsageOffConfirmedAt?: number
  models: Record<string, string[]>
  modelMetadata?: Record<string, ModelPresentation>
  windows: QuotaWindow[]
  isDefault?: boolean
  parallelLimit: number
}
export interface Binding {
  key: string
  identity: string
  model: string
  effort?: string
  generation: number
  sdkSessionId?: string
  historyRevision?: string
  prefixDigest?: string
  systemDigest?: string
  toolDigest?: string
  attachmentDigest?: string
  runtimeVersion?: string
  committedCursor: number
  pendingTools: string[]
  reason: string
}
export interface Reservation {
  requestId: string
  identity: string
  session: string
  epochs: Record<string, string>
  predictedWork: number
  createdAt: number
}
export class RouteBlocked extends Error {
  accountLabel?: string
  constructor(
    readonly code: string,
    readonly retryAt?: number,
    options?: ErrorOptions,
  ) {
    super(code, options)
    this.name = 'RouteBlocked'
  }
}
export const ACCOUNT_ALIAS = /^[A-Za-z0-9_-]{1,48}$/

export function visibleAccountLabel(value: string): string | undefined {
  if (value === 'default' || ACCOUNT_ALIAS.test(value)) return value
  const absolute = value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
  if (!absolute || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) return undefined
  return value
}

/** Alias when one is safe to show, otherwise the profile path when that path is safe to show. */
export function preferredAccountLabel(aliases: readonly string[], profileRef: string): string {
  const alias = aliases.find((item) => ACCOUNT_ALIAS.test(item))
  if (alias !== undefined) return alias
  return visibleAccountLabel(profileRef) ?? profileRef
}

export function subscriptionLoginRequired(label: string): RouteBlocked {
  const blocked = new RouteBlocked('SUBSCRIPTION_LOGIN_REQUIRED')
  const visible = visibleAccountLabel(label)
  if (visible !== undefined) blocked.accountLabel = visible
  return blocked
}
