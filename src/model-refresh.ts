import type { OfficialCatalog } from './auth/official.js'
import { profileLoginHeld } from './login-exchange.js'
import type { Account, ModelPresentation } from './routing/types.js'
import type { StateStore } from './storage/store.js'

export const MODEL_LIST_TTL_MS = 6 * 60 * 60 * 1_000
export const MODEL_LIST_RETRY_MS = 15 * 60 * 1_000

const REFRESHABLE = new Set<Account['state']>(['READY', 'DRAINING', 'COOLDOWN'])

/** Observed capacity outlives a list refresh; the official list owns everything else. */
function mergeMetadata(
  fresh: Record<string, ModelPresentation>,
  old: Record<string, ModelPresentation> | undefined,
): Record<string, ModelPresentation> {
  return Object.fromEntries(
    Object.entries(fresh).map(([id, entry]) => {
      const seen = old?.[id]
      return [
        id,
        {
          ...entry,
          ...(seen?.contextWindow === undefined ? {} : { contextWindow: seen.contextWindow }),
          ...(seen?.maxOutputTokens === undefined ? {} : { maxOutputTokens: seen.maxOutputTokens }),
        },
      ]
    }),
  )
}

/** Keeps saved model lists current in the background; a failed read keeps the last good list. */
export class ModelListRefresher {
  #running: Promise<void> | undefined
  readonly #failedAt = new Map<string, number>()

  constructor(
    readonly state: () => StateStore,
    readonly read: (profileRef: string) => Promise<OfficialCatalog>,
    readonly now: () => number = Date.now,
    readonly ttlMs = MODEL_LIST_TTL_MS,
    readonly retryMs = MODEL_LIST_RETRY_MS,
  ) {}

  refreshIfStale(): Promise<void> {
    this.#running ??= this.#refresh().finally(() => {
      this.#running = undefined
    })
    return this.#running
  }

  async #refresh(): Promise<void> {
    let store: StateStore
    try {
      store = this.state()
    } catch {
      return
    }
    const now = this.now()
    const stale = store
      .list<Account>('accounts')
      .filter(
        (a) =>
          REFRESHABLE.has(a.state) &&
          (a.modelsRefreshedAt ?? a.verifiedAt) + this.ttlMs <= now &&
          (this.#failedAt.get(a.identity) ?? -Infinity) + this.retryMs <= now &&
          !profileLoginHeld(store, a.profileRef),
      )
    for (const account of stale) {
      try {
        const catalog = await this.read(account.profileRef)
        if (catalog.identity !== account.identity || !Object.keys(catalog.models).length)
          throw new Error('official model list unusable for this account')
        store.transaction(() => {
          const current = store.get<Account>('accounts', account.identity)
          if (!current) return
          store.set('accounts', account.identity, {
            ...current,
            models: catalog.models,
            modelMetadata: mergeMetadata(catalog.modelMetadata, current.modelMetadata),
            modelsRefreshedAt: this.now(),
          })
        })
        this.#failedAt.delete(account.identity)
      } catch {
        this.#failedAt.set(account.identity, this.now())
      }
    }
  }
}
