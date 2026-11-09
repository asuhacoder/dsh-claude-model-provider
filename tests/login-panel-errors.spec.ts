import { t } from './client-locale.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { ClaudeLoginCard, ClaudeLoginTail, LoginExchangePanel } from '../src/client/login-panel.js'
import type { LoginRpc } from '../src/client/login-panel.js'
import { parseLoginLabel, type LoginView } from '../src/login-view.js'
import { RouteBlocked } from '../src/routing/types.js'

const needsCode = {
  phase: 'needs_code',
  accountLabel: 'primary',
  profileRef: 'default',
  attempt: '00000000-0000-4000-8000-000000000002',
  authorizeUrl: 'https://claude.com/oauth/authorize?state=errors',
} as LoginView

afterEach(() => {
  vi.unstubAllGlobals()
})

function alerts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.props.role === 'alert')
    .map((node) => node.children.join(''))
}

async function click(tree: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    tree.root
      .findAllByType('button')
      .find((button) => button.children.includes(label))!
      .props.onClick()
  })
}

async function waitingPanel(close: LoginRpc['call']): Promise<ReactTestRenderer> {
  vi.stubGlobal('window', { open: vi.fn() })
  const call = vi.fn<LoginRpc['call']>(async (_channel, _method, payload) =>
    (payload as { op: string }).op === 'open'
      ? { ok: true, value: { exchange: needsCode } }
      : close(_channel, _method, payload),
  )
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(LoginExchangePanel, { t, rpc: { call }, target: parseLoginLabel('primary')! }),
    )
  })
  await click(tree, 'Start official login')
  return tree
}

it('shows the RPC error when cancel is refused and keeps the login open', async () => {
  const tree = await waitingPanel(async () => ({ ok: false, error: { message: 'LOGIN_BUSY' } }))
  await click(tree, 'Cancel')
  expect(alerts(tree)).toEqual(['LOGIN_BUSY'])
  expect(tree.root.findAllByType('a')).toHaveLength(1)
  tree.unmount()
})

it('shows the blocked code when cancel throws', async () => {
  const tree = await waitingPanel(async () => {
    throw new RouteBlocked('LOGIN_NOT_COMMITTED')
  })
  await click(tree, 'Cancel')
  expect(alerts(tree)).toEqual(['LOGIN_NOT_COMMITTED'])
  tree.unmount()
})

it('keeps the current view when cancel returns no exchange', async () => {
  const tree = await waitingPanel(async () => ({ ok: true, value: {} }))
  await click(tree, 'Cancel')
  expect(alerts(tree)).toEqual([])
  expect(tree.root.findAllByType('a')).toHaveLength(1)
  tree.unmount()
})

it.each([
  ['no turn', undefined],
  ['an open turn', {}],
  ['a turn that ended without an error', { end: { data: { reason: { kind: 'completed' } } } }],
  [
    'a login-required failure without a message',
    {
      end: { data: { reason: { kind: 'error', error: { code: 'SUBSCRIPTION_LOGIN_REQUIRED' } } } },
    },
  ],
  [
    'a login-required message under another code',
    {
      end: {
        data: {
          reason: {
            kind: 'error',
            error: { message: 'SUBSCRIPTION_LOGIN_REQUIRED: primary', code: 'POOL_UNAVAILABLE' },
          },
        },
      },
    },
  ],
])('adds nothing to the turn tail for %s', async (_case, turn) => {
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(ClaudeLoginTail, { t, rpc: { call: vi.fn() }, ...(turn ? { turn } : {}) }),
    )
  })
  expect(tree.toJSON()).toBeNull()
  tree.unmount()
})

it('rejects a login card without arguments', async () => {
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(ClaudeLoginCard, { t, rpc: { call: vi.fn() } }))
  })
  expect(alerts(tree)).toEqual(['INVALID_PAYLOAD'])
  tree.unmount()
})
