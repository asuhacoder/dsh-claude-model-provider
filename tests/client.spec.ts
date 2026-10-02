import { it, expect, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { Section, apply } from '../src/client/index.js'
it('renders local account management, honest unknowns and user-driven controls', async () => {
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
  const rpc = { call: vi.fn(async () => ({ ok: true as const, value: status })) }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(Section, { rpc } as never))
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
  apply({ get: (name: string) => (name === 'slots' ? slots : { rpc }) } as never)
  expect(register.mock.calls[0]?.[0].id).toBe('claude-sdk-local')
  expect(register.mock.calls[0]?.[0].label()).toContain('Claude')
  expect(register.mock.calls[0]?.[0].inject()).toEqual({ rpc })
})
