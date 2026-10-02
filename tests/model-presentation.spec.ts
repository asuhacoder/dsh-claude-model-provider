import { expect, it } from 'vitest'
import { modelPresentation } from '../src/model-presentation.js'
import { accountModelCatalog, accountModelInfo, PROVIDER_ID } from '../src/models.js'
import type { Account } from '../src/routing/types.js'

const account: Account = {
  identity: 'fixture',
  aliases: ['primary'],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  windows: [],
  parallelLimit: 1,
  models: { opus: ['low'], fable: ['high'], 'claude-fable-5': ['high'], haiku: [] },
  modelMetadata: {
    opus: { displayName: 'Opus 5.5', description: 'For complex work' },
    fable: { displayName: 'Fable 5.1', description: 'For tough challenges' },
    haiku: { displayName: 'Claude Haiku 4.5' },
  },
}

it('uses official names, descriptions and ordering while preserving request IDs', () => {
  const catalog = accountModelCatalog([account], 'opus')
  expect(catalog.map((m) => [m.id, m.name])).toEqual([
    ['opus', 'Claude Opus 5.5'],
    ['fable', 'Claude Fable 5.1'],
    ['claude-fable-5', 'Claude Fable 5'],
    ['haiku', 'Claude Haiku 4.5'],
  ])
  for (const model of catalog) {
    expect(accountModelInfo([account], PROVIDER_ID, model.id, 'opus')).toMatchObject(model)
  }
  expect(accountModelInfo([account], PROVIDER_ID, 'default', 'opus')).toMatchObject({
    id: 'default',
    name: 'Claude Opus 5.5',
    description: 'For complex work',
    reasoning: { efforts: [{ id: 'low' }] },
  })
})

it('supports older stored accounts without guessing the version of an alias', () => {
  const { modelMetadata: _old, ...legacy } = account
  legacy.models = { opus: ['low'], 'claude-opus-5': [], 'claude-fable-5-1': [] }
  expect(accountModelCatalog([legacy], 'opus').map((m) => m.name)).toEqual([
    'Claude Opus',
    'Claude Opus 5',
    'Claude Fable 5.1',
  ])
  expect(modelPresentation('opus').description).toContain('Refresh the connection')
  expect(modelPresentation('claude-sonnet-4-5-20250929').name).toBe('Claude Sonnet 4.5 (20250929)')
  expect(modelPresentation('custom-model').name).toBe('custom-model')
})

it('uses the most recent active metadata consistently in lists and resolution', () => {
  const newer = {
    ...account,
    identity: 'new',
    verifiedAt: 2,
    modelMetadata: { opus: { displayName: 'Opus 5.6' } },
  }
  const suspended = {
    ...newer,
    state: 'SUSPENDED' as const,
    verifiedAt: 3,
    modelMetadata: { opus: { displayName: 'Opus 99' } },
  }
  expect(accountModelCatalog([account, newer, suspended], 'opus')[0]?.name).toBe('Claude Opus 5.6')
  expect(accountModelInfo([account, newer, suspended], PROVIDER_ID, 'opus', 'opus').name).toBe(
    'Claude Opus 5.6',
  )
})
