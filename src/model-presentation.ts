import type { Account, ModelPresentation } from './routing/types.js'

/** Keep provider request IDs separate from names shown to people. */
export function modelPresentation(id: string, metadata?: ModelPresentation) {
  const official = metadata?.displayName?.trim()
  const versioned = /^claude-(opus|sonnet|haiku|fable)-(\d+(?:-\d{1,2})*)(?:-(\d{8}))?$/i.exec(id)
  const family = /^(opus|sonnet|haiku|fable)$/i.exec(id)?.[1]
  const title = (value: string) => value[0]!.toUpperCase() + value.slice(1).toLowerCase()
  const name = official
    ? /^Claude\b/i.test(official)
      ? official
      : `Claude ${official}`
    : versioned
      ? `Claude ${title(versioned[1]!)} ${versioned[2]!.replaceAll('-', '.')}${versioned[3] ? ` (${versioned[3]})` : ''}`
      : family
        ? `Claude ${title(family)}`
        : id
  const description =
    metadata?.description?.trim() ||
    (family && !official
      ? 'Claude selects the version for this alias. Refresh the connection in Claude Subscription settings to show its current version.'
      : undefined)
  return { name, ...(description ? { description } : {}) }
}

type CatalogAccount = Pick<Account, 'state' | 'models' | 'modelMetadata' | 'verifiedAt'>

/** Preserve the official ordering; prefer metadata from the most recently verified account. */
export function listedAccountModels(accounts: readonly CatalogAccount[]) {
  const active = accounts
    .filter((a) => a.state !== 'DISABLED' && a.state !== 'SUSPENDED')
    .sort((a, b) => b.verifiedAt - a.verifiedAt)
  const ids = [...new Set(active.flatMap((a) => Object.keys(a.models)))].filter(
    (id) => id !== 'default',
  )
  return ids.map((id) => ({
    id,
    ...modelPresentation(
      id,
      active.find((a) => a.models[id] !== undefined && a.modelMetadata?.[id]?.displayName)
        ?.modelMetadata?.[id],
    ),
  }))
}
