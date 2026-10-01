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
export interface Account {
  identity: string
  aliases: string[]
  profileRef: string // 'default' or a path; never credential contents.
  state: AccountState
  verifiedAt: number
  extraUsageOffConfirmedAt?: number
  models: Record<string, string[]>
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
  constructor(
    readonly code: string,
    readonly retryAt?: number,
  ) {
    super(code)
    this.name = 'RouteBlocked'
  }
}
