import { t, translator } from './client-locale.js'
import { it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { dictionaries, NS } from '../src/client/messages.js'
import { Section, apply, inject } from '../src/client/index.js'
const status = {
  defaultModel: 'opus',
  accounts: [
    {
      id: 'A',
      aliases: ['primary'],
      state: 'READY',
      verifiedAt: 1,
      isDefault: true,
      billingSafety: 'user-confirmed-off',
      inFlight: 1,
      models: { opus: ['low', 'max'] },
      modelMetadata: { opus: { displayName: 'Opus 5.5' } },
      windows: [],
      lastRouteReason: null,
    },
    {
      id: 'B',
      aliases: ['second'],
      state: 'READY',
      billingSafety: 'unverified',
      inFlight: 0,
      models: { haiku: [] },
      windows: [
        { key: 'five', remaining: 0.5, resetsAt: 10000, observedAt: 1 },
        { key: 'unknown', remaining: null, observedAt: 2 },
      ],
      lastRouteReason: 'confirmed-quota-migration',
    },
  ],
  usage: {
    responses: 1,
    toolBoundaries: 2,
    failed: 0,
    usage: { inputTokens: 4, outputTokens: 2 },
  },
}

it('renders local account management, honest unknowns and user-driven controls', async () => {
  const rpc = { call: vi.fn(async () => ({ ok: true as const, value: status })) }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(Section, { t, rpc } as never))
  })
  expect(JSON.stringify(tree.toJSON())).toContain('不明')
  expect(rpc.call).toHaveBeenCalledTimes(1)
  expect(
    tree.root.findAllByType('option').map((o) => [o.props.value, o.children.join('')]),
  ).toEqual([
    ['opus', 'Claude Opus 5.5'],
    ['haiku', 'Claude Haiku'],
  ])
  expect(JSON.stringify(tree.toJSON())).not.toContain('公式SDK')
  const inputs = tree.root.findAllByType('input')
  await act(async () => {
    inputs[0]!.props.onChange({ target: { value: 'new' } })
    inputs[1]!.props.onChange({ target: { value: '/tmp/profile' } })
    inputs[2]!.props.onChange({ target: { checked: true } })
  })
  await act(async () => {
    tree.root
      .findAllByType('button')
      .find((b) => b.children.includes('既存の公式ログインを接続'))!
      .props.onClick()
  })
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.add', {
    alias: 'new',
    profile: '/tmp/profile',
    extraUsageOff: true,
  })
  await act(async () => {
    tree.root.findByType('select').props.onChange({ target: { value: 'haiku' } })
  })
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.setModel', { model: 'haiku' })
  rpc.call.mockRejectedValueOnce(new Error('fixture failure'))
  await act(async () => {
    tree.root.findAllByType('button')[0]!.props.onClick()
  })
  expect(JSON.stringify(tree.toJSON())).toContain('fixture failure')
  rpc.call.mockRejectedValueOnce('failure')
  await act(async () => {
    tree.root.findAllByType('button')[0]!.props.onClick()
  })
  expect(JSON.stringify(tree.toJSON())).toContain('操作を完了できませんでした')
  tree.unmount()
  const register = vi.fn(),
    slots = { inject: (_n: unknown, fn: () => unknown) => fn(), register }
  const locale = {
    register: vi.fn(() => vi.fn()),
    getLocale: () => ({ active: 'ja', locales: [{ id: 'en' }, { id: 'zh' }] }),
    addLanguage: vi.fn(() => vi.fn()),
    bind: vi.fn(() => t),
  }
  const disposers: (() => void)[] = []
  apply({
    get: (name: string) =>
      ({ slots, connection: { rpc }, locale })[name as 'slots' | 'connection' | 'locale'],
    effect: (effect: () => () => void) => disposers.push(effect()),
  } as never)
  expect(inject).toContain('locale')
  expect(locale.register.mock.calls).toEqual(
    Object.entries(dictionaries).map(([id, dict]) => [NS, id, dict]),
  )
  expect(locale.addLanguage).toHaveBeenCalledWith({ id: 'ja', label: '日本語', fallback: 'en' })
  expect(locale.bind).toHaveBeenCalledWith(NS)
  expect(disposers).toHaveLength(4)
  for (const dispose of disposers) {
    dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  }
  expect(register.mock.calls.every(([options]) => options.locale === NS)).toBe(true)
  expect(register).toHaveBeenCalledTimes(3)
  expect(register.mock.calls[0]?.[0].id).toBe('claude-sdk-local')
  expect(register.mock.calls[0]?.[0].label()).toContain('Claude')
  expect(register.mock.calls[0]?.[0].inject()).toEqual({ rpc })
  expect(register.mock.calls[1]?.[0].key).toBe('claude-login')
  expect(register.mock.calls[1]?.[0].inject()).toEqual({ rpc })
  expect(register.mock.calls[2]?.[0].key).toBe('turn-error')
  expect(register.mock.calls[2]?.[0].inject()).toEqual({ rpc })
})

it('keeps a Japanese language pack registered by another plugin', () => {
  const addLanguage = vi.fn()
  const locale = {
    register: vi.fn(() => vi.fn()),
    getLocale: () => ({ active: 'ja', locales: [{ id: 'en' }, { id: 'zh' }, { id: 'ja' }] }),
    addLanguage,
    bind: () => t,
  }
  const slots = {
    inject: (_name: string, callback: () => unknown) => callback(),
    register: vi.fn(),
  }
  apply({
    get: (name: string) =>
      ({ slots, connection: { rpc: { call: vi.fn() } }, locale })[
        name as 'slots' | 'connection' | 'locale'
      ],
    effect: (effect: () => () => void) => effect(),
  } as never)
  expect(addLanguage).not.toHaveBeenCalled()
  expect(locale.register).toHaveBeenCalledTimes(3)
})

it('renders the same account fixture in English without Japanese text', async () => {
  const rpc = { call: vi.fn(async () => ({ ok: true as const, value: status })) }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(Section, { rpc, t: translator('en') } as never))
  })
  const text = JSON.stringify(tree.toJSON())
  expect(text).toContain('Add account')
  expect(text).toContain('Connect existing official login')
  expect(text).toContain('Start official login')
  expect(text).toContain('In flight 1')
  expect(text).toContain('Remaining 50%')
  expect(text).toContain('confirmed-quota-migration')
  expect(text).not.toMatch(/[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u)
  tree.unmount()
})
