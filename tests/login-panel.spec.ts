import { t } from './client-locale.js'
import { afterEach, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { Section } from '../src/client/index.js'
import { ClaudeLoginCard, ClaudeTurnError, LoginExchangePanel } from '../src/client/login-panel.js'
import type { LoginRpc } from '../src/client/login-panel.js'
import type { LoginTarget, LoginView } from '../src/login-view.js'
import { RouteBlocked } from '../src/routing/types.js'

const SAMPLE_CODE = 'test-code-value'
const SAMPLE_URL = 'https://claude.com/oauth/authorize?state=fixture'
const ATTEMPT = '00000000-0000-4000-8000-000000000001'

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

function view(phase: LoginView['phase'], attempt = ATTEMPT): LoginView {
  if (phase === 'needs_code') {
    return {
      phase,
      accountLabel: 'primary',
      profileRef: 'default',
      attempt,
      authorizeUrl: SAMPLE_URL,
    } as LoginView
  }
  if (phase === 'failed') {
    return {
      phase,
      accountLabel: 'primary',
      profileRef: 'default',
      attempt,
      failureCode: 'LOGIN_INCOMPLETE',
    } as LoginView
  }
  return { phase, accountLabel: 'primary', profileRef: 'default', attempt } as LoginView
}

function alerts(tree: ReactTestRenderer): string[] {
  return tree.root
    .findAll((node) => node.props.role === 'alert')
    .map((node) => node.children.join(''))
}

async function click(tree: ReactTestRenderer, label: string, scope: ReactTestInstance = tree.root) {
  await act(async () => {
    scope
      .findAllByType('button')
      .find((button) => button.children.includes(label))!
      .props.onClick()
  })
}

it('leaves a non-login failure unchanged and waits for a click on login required', async () => {
  const rpc = { call: vi.fn() }
  let plain!: ReactTestRenderer
  await act(async () => {
    plain = create(
      createElement(ClaudeTurnError, {
        t,
        message: 'POOL_UNAVAILABLE',
        code: 'POOL_UNAVAILABLE',
        rpc,
      }),
    )
  })
  expect(JSON.stringify(plain.toJSON())).toContain('POOL_UNAVAILABLE')
  expect(plain.root.findAllByType('button')).toHaveLength(0)
  expect(plain.root.findAllByType('input')).toHaveLength(0)
  plain.unmount()

  let unread!: ReactTestRenderer
  await act(async () => {
    unread = create(
      createElement(ClaudeTurnError, {
        t,
        message: 'SUBSCRIPTION_LOGIN_REQUIRED',
        code: 'SUBSCRIPTION_LOGIN_REQUIRED',
        rpc,
      }),
    )
  })
  expect(JSON.stringify(unread.toJSON())).toContain('SUBSCRIPTION_LOGIN_REQUIRED')
  expect(unread.root.findAllByType('button')).toHaveLength(0)
  unread.unmount()

  let hosted!: ReactTestRenderer
  await act(async () => {
    hosted = create(
      createElement(ClaudeTurnError, {
        t,
        rpc,
        node: {
          data: {
            message: 'SUBSCRIPTION_LOGIN_REQUIRED: primary · /claude-login primary',
            code: 'SUBSCRIPTION_LOGIN_REQUIRED',
          },
        },
      }),
    )
  })
  expect(
    hosted.root
      .findAllByType('button')
      .some((button) => button.children.includes('Start official login')),
  ).toBe(true)
  hosted.unmount()

  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(ClaudeTurnError, {
        t,
        message: 'SUBSCRIPTION_LOGIN_REQUIRED: primary',
        code: 'SUBSCRIPTION_LOGIN_REQUIRED',
        rpc,
      }),
    )
  })
  expect(JSON.stringify(tree.toJSON())).toContain('SUBSCRIPTION_LOGIN_REQUIRED: primary')
  expect(JSON.stringify(tree.toJSON())).not.toContain('応答できませんでした')
  expect(tree.root.findAllByType('input')).toHaveLength(1)
  expect(tree.root.findAllByType('input')[0]!.props.autoComplete).toBe('off')
  expect(rpc.call).not.toHaveBeenCalled()
  rpc.call.mockResolvedValueOnce({ ok: true, value: { exchange: view('needs_code') } })
  await click(tree, 'Start official login')
  expect(rpc.call).toHaveBeenCalledTimes(1)
  expect(rpc.call).toHaveBeenCalledWith(
    '/api',
    'claude-sdk-local.login',
    expect.objectContaining({ op: 'open', alias: 'primary', extraUsageOff: false }),
  )
  tree.unmount()

  const cardRpc = { call: vi.fn(async () => ({ ok: true as const, value: {} })) }
  let card!: ReactTestRenderer
  await act(async () => {
    card = create(createElement(ClaudeLoginCard, { t, rpc: cardRpc, node: { args: ' primary' } }))
  })
  expect(
    card.root
      .findAllByType('button')
      .some((button) => button.children.includes('Start official login')),
  ).toBe(true)
  expect(cardRpc.call).not.toHaveBeenCalled()
  card.unmount()

  let rejected!: ReactTestRenderer
  await act(async () => {
    rejected = create(
      createElement(ClaudeLoginCard, { t, rpc: cardRpc, node: { args: ' sk-ant-fixture pasted' } }),
    )
  })
  expect(JSON.stringify(rejected.toJSON())).toContain('INVALID_PAYLOAD')
  expect(JSON.stringify(rejected.toJSON())).not.toContain('sk-ant-fixture')
  rejected.unmount()
})

it('opens the login page once, keeps the address out of storage and errors, and polls', async () => {
  vi.useFakeTimers()
  const open = vi.fn()
  const storage = { setItem: vi.fn(), getItem: vi.fn(), removeItem: vi.fn() }
  vi.stubGlobal('window', { open })
  vi.stubGlobal('localStorage', storage)
  const exchange = view('needs_code', '00000000-0000-4000-8000-000000000005')
  const rpc: LoginRpc = {
    call: vi.fn(async (_channel: string, _method: string, payload: unknown) => {
      const op = (payload as { op?: string }).op
      if (op === 'read') return { ok: true as const, value: { exchange: { ...exchange } } }
      return { ok: true as const, value: { exchange } }
    }),
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(LoginExchangePanel, {
        t,
        rpc,
        target: { kind: 'alias', alias: 'primary' } as LoginTarget,
      }),
    )
  })
  expect(rpc.call).not.toHaveBeenCalled()
  await click(tree, 'Start official login')
  expect(open).toHaveBeenCalledTimes(1)
  expect(open).toHaveBeenCalledWith(SAMPLE_URL, '_blank', 'noopener,noreferrer')
  const link = tree.root.findByType('a')
  expect(link.children).toEqual(['Open the Claude login page'])
  expect(link.props.href).toBe(SAMPLE_URL)
  expect(link.props.target).toBe('_blank')
  expect(link.props.rel).toBe('noopener noreferrer')
  expect(alerts(tree).join('')).not.toContain('fixture')
  expect(storage.setItem).not.toHaveBeenCalled()
  await click(tree, 'Cancel')
  expect(rpc.call).toHaveBeenCalledWith(
    '/api',
    'claude-sdk-local.login',
    expect.objectContaining({ op: 'close', attempt: exchange.attempt, alias: 'primary' }),
  )
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(open).toHaveBeenCalledTimes(1)
  const reads = vi
    .mocked(rpc.call)
    .mock.calls.filter((call) => call[2] && (call[2] as { op?: string }).op === 'read')
  expect(reads).toHaveLength(1)
  expect(reads[0]?.[2]).toEqual({ op: 'read', alias: 'primary' })
  tree.unmount()
})

it('rejects a link pasted as a code and clears the field after a code is accepted', async () => {
  const exchange = view('needs_code', '00000000-0000-4000-8000-000000000002')
  const ready = view('ready', exchange.attempt)
  const rpc = {
    call: vi.fn(async (_channel: string, _method: string, payload: { op?: string }) => {
      if (payload.op === 'paste') return { ok: true as const, value: { exchange: ready } }
      return { ok: true as const, value: { exchange } }
    }),
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(LoginExchangePanel, {
        t,
        rpc,
        target: { kind: 'profile', profile: '/tmp/claude-primary' } as LoginTarget,
      }),
    )
  })
  await click(tree, 'Start official login')
  const input = () =>
    tree.root.findAllByType('input').find((node) => node.props.autoComplete === 'off')!
  await act(async () => {
    input().props.onChange({ target: { value: SAMPLE_URL } })
  })
  await click(tree, 'Submit code')
  expect(alerts(tree)).toEqual(['LOGIN_CODE_REJECTED'])
  expect(alerts(tree).join('')).not.toContain(SAMPLE_CODE)
  expect(alerts(tree).join('')).not.toContain('fixture')
  expect(rpc.call.mock.calls.filter((call) => call[2].op === 'paste')).toHaveLength(0)
  await act(async () => {
    input().props.onChange({ target: { value: SAMPLE_CODE } })
  })
  await click(tree, 'Submit code')
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.login', {
    op: 'paste',
    attempt: exchange.attempt,
    code: SAMPLE_CODE,
    profile: '/tmp/claude-primary',
  })
  expect(tree.root.findAllByType('input')).toHaveLength(0)
  expect(JSON.stringify(tree.toJSON())).toContain('Logged in')
  expect(alerts(tree).join('')).not.toContain(SAMPLE_CODE)
  tree.unmount()
})

it('shows a failure code without the paste field', async () => {
  const rpc = {
    call: vi.fn(async () => ({ ok: true as const, value: { exchange: view('failed') } })),
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(LoginExchangePanel, {
        t,
        rpc,
        target: { kind: 'alias', alias: 'primary' } as LoginTarget,
      }),
    )
  })
  await click(tree, 'Start official login')
  expect(alerts(tree)).toEqual(['LOGIN_INCOMPLETE'])
  expect(
    tree.root.findAllByType('button').some((button) => button.children.includes('Log in again')),
  ).toBe(true)
  expect(tree.root.findAllByType('input')).toHaveLength(0)
  expect(JSON.stringify(tree.toJSON())).not.toContain(SAMPLE_URL)
  expect(JSON.stringify(tree.toJSON())).not.toContain(SAMPLE_CODE)
  tree.unmount()
})

it('shows only the server code when open or paste is refused', async () => {
  const refused = {
    call: vi.fn(async () => ({ ok: false as const, error: { message: 'PROFILE_LOGIN_BUSY' } })),
  }
  let busy!: ReactTestRenderer
  await act(async () => {
    busy = create(
      createElement(LoginExchangePanel, {
        t,
        rpc: refused,
        target: { kind: 'alias', alias: 'primary' } as LoginTarget,
      }),
    )
  })
  await click(busy, 'Start official login')
  expect(alerts(busy)).toEqual(['PROFILE_LOGIN_BUSY'])
  busy.unmount()

  const exploded = {
    call: vi.fn(async () => {
      throw new Error(SAMPLE_URL)
    }),
  }
  let blown!: ReactTestRenderer
  await act(async () => {
    blown = create(
      createElement(LoginExchangePanel, {
        t,
        rpc: exploded,
        target: { kind: 'alias', alias: 'primary' } as LoginTarget,
      }),
    )
  })
  await click(blown, 'Start official login')
  expect(alerts(blown)).toEqual(['LOGIN_CODE_REJECTED'])
  expect(JSON.stringify(blown.toJSON())).not.toContain('fixture')
  blown.unmount()

  const blocked = {
    call: vi.fn(async (_channel: string, _method: string, payload: { op?: string }) => {
      if (payload.op === 'paste') throw new RouteBlocked('LOGIN_NOT_READY')
      return {
        ok: true as const,
        value: { exchange: view('needs_code', '00000000-0000-4000-8000-000000000003') },
      }
    }),
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(LoginExchangePanel, {
        t,
        rpc: blocked,
        target: { kind: 'alias', alias: 'primary' } as LoginTarget,
      }),
    )
  })
  await click(tree, 'Start official login')
  await act(async () => {
    tree.root.findAllByType('input')[0]!.props.onChange({ target: { value: SAMPLE_CODE } })
  })
  await click(tree, 'Submit code')
  expect(alerts(tree)).toEqual(['LOGIN_NOT_READY'])
  expect(alerts(tree).join('')).not.toContain(SAMPLE_CODE)
  expect(tree.root.findAllByType('input')[0]!.props.value).toBe(SAMPLE_CODE)
  tree.unmount()
})

it('shows a refused read or paste as the code alone', async () => {
  vi.useFakeTimers()
  const exchange = view('needs_code', '00000000-0000-4000-8000-000000000006')
  const rpc = {
    call: vi.fn(async (_channel: string, _method: string, payload: { op?: string }) => {
      if (payload.op === 'read')
        return { ok: false as const, error: { message: 'PROFILE_LOGIN_BUSY' } }
      if (payload.op === 'paste')
        return { ok: false as const, error: { message: 'LOGIN_NOT_READY' } }
      return { ok: true as const, value: { exchange } }
    }),
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(LoginExchangePanel, {
        t,
        rpc,
        target: { kind: 'alias', alias: 'primary' } as LoginTarget,
      }),
    )
  })
  await click(tree, 'Start official login')
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(alerts(tree)).toEqual(['PROFILE_LOGIN_BUSY'])
  expect(alerts(tree).join('')).not.toContain('fixture')
  await act(async () => {
    tree.root.findAllByType('input')[0]!.props.onChange({ target: { value: SAMPLE_CODE } })
  })
  await click(tree, 'Submit code')
  expect(alerts(tree)).toEqual(['LOGIN_NOT_READY'])
  expect(alerts(tree).join('')).not.toContain(SAMPLE_CODE)
  expect(tree.root.findAllByType('input')[0]!.props.value).toBe(SAMPLE_CODE)
  tree.unmount()
})

it('polls while the login is opening and does not open a page before a code is required', async () => {
  vi.useFakeTimers()
  const open = vi.fn()
  vi.stubGlobal('window', { open })
  const exchange = view('opening', '00000000-0000-4000-8000-000000000004')
  const rpc = {
    call: vi.fn(async (_channel: string, _method: string, payload: { op?: string }) => {
      if (payload.op === 'read')
        return { ok: true as const, value: { exchange: view('finishing', exchange.attempt) } }
      return { ok: true as const, value: { exchange } }
    }),
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(
      createElement(LoginExchangePanel, {
        t,
        rpc,
        target: { kind: 'alias', alias: 'primary' } as LoginTarget,
      }),
    )
  })
  await click(tree, 'Start official login')
  expect(open).not.toHaveBeenCalled()
  expect(tree.root.findAllByType('input')[0]!.props.disabled).toBe(true)
  await click(tree, 'Submit code')
  expect(rpc.call.mock.calls.filter((call) => call[2].op === 'paste')).toHaveLength(0)
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000)
  })
  expect(open).not.toHaveBeenCalled()
  expect(rpc.call.mock.calls.filter((call) => call[2].op === 'read')).toHaveLength(1)
  tree.unmount()
})

it('sends the typed profile from the add form and the status id for a disabled row', async () => {
  const disabled = {
    id: 'D',
    aliases: [] as string[],
    state: 'DISABLED',
    billingSafety: 'unverified',
    isDefault: false,
    inFlight: 0,
    models: {},
    windows: [],
    lastRouteReason: null,
  }
  const authRequired = {
    ...disabled,
    id: 'A',
    aliases: ['primary'],
    state: 'AUTH_REQUIRED',
  }
  const status = {
    pending: [],
    defaultModel: 'opus',
    accounts: [disabled, authRequired],
    usage: {
      responses: 0,
      toolBoundaries: 0,
      failed: 0,
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  }
  const rpc = {
    call: vi.fn(async (channel: string, method: string) => {
      expect(channel).toBe('/api')
      if (method === 'claude-sdk-local.status') return { ok: true as const, value: status }
      return { ok: true as const, value: status }
    }),
  }
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(createElement(Section, { t, rpc } as never))
  })
  expect(rpc.call).toHaveBeenCalledTimes(1)
  expect(rpc.call).toHaveBeenCalledWith('/api', 'claude-sdk-local.status', {})
  await click(tree, 'Start official login')
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.login', {
    op: 'open',
    attempt: expect.any(String),
    extraUsageOff: false,
    profile: 'default',
    alias: 'primary',
  })

  const inputs = tree.root.findAllByType('input')
  await act(async () => {
    inputs[0]!.props.onChange({ target: { value: 'other' } })
    inputs[1]!.props.onChange({ target: { value: '/tmp/profile' } })
    inputs[2]!.props.onChange({ target: { checked: true } })
  })
  await click(tree, 'Start official login')
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.login', {
    op: 'open',
    attempt: expect.any(String),
    extraUsageOff: true,
    profile: '/tmp/profile',
    alias: 'other',
  })

  const articles = tree.root.findAllByType('article')
  expect(articles[0]!.findByType('h3').children).toContain('Disabled')
  expect(articles[0]!.findAllByType('p')[0]!.children.join('')).toContain('DISABLED')
  expect(
    articles[0]!
      .findAllByType('button')
      .some((button) => button.children.includes('Verify connection')),
  ).toBe(false)
  const revived = articles[0]!
    .findAllByType('input')
    .find((input) => input.props.autoComplete !== 'off')!
  await act(async () => {
    revived.props.onChange({ target: { value: 'revived' } })
  })
  await click(tree, 'Start official login', articles[0]!)
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.login', {
    op: 'open',
    attempt: expect.any(String),
    extraUsageOff: false,
    id: 'D',
    alias: 'revived',
  })

  await click(tree, 'Start official login', articles[1]!)
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.login', {
    op: 'open',
    attempt: expect.any(String),
    extraUsageOff: false,
    alias: 'primary',
  })
  await click(tree, 'Verify connection', articles[1]!)
  expect(rpc.call).toHaveBeenLastCalledWith('/api', 'claude-sdk-local.verify', { alias: 'primary' })
  expect(articles[1]!.findAllByType('p')[0]!.children.join('')).toContain('AUTH_REQUIRED')
  tree.unmount()
})
