import { t } from './client-locale.js'
import { expect, it, vi } from 'vitest'
import { createElement as h, type ComponentType } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { apply } from '../src/client/index.js'

const hostCopy: Record<string, string> = {
  'message.turnError': 'このターンは失敗しました',
  'message.failure.quota': 'リクエストのクォータを使い切りました。',
}

function HostTurnError(props: { node: { data: { message: string; code?: string } } }) {
  const { message, code } = props.node.data
  return h(
    'div',
    { role: 'status', className: 'turnErrorRow' },
    h('span', { 'data-state-dot': 'error', className: 'turnErrorDot' }),
    h(
      'div',
      { className: 'turnErrorCopy' },
      h('span', { className: 'turnErrorTitle' }, hostCopy['message.turnError']),
      h(
        'span',
        { className: 'turnErrorMessage' },
        code === 'QUOTA' ? hostCopy['message.failure.quota'] : message,
      ),
    ),
    code === undefined ? null : h('code', { className: 'turnErrorCode' }, code),
  )
}

interface Entry {
  options: { name: string; key?: string; id?: string; inject?: () => Record<string, unknown> }
  component: ComponentType<Record<string, unknown>>
}

function hostSlots(withPlugin: boolean, rpc = { call: vi.fn() }) {
  const entries: Entry[] = []
  const slots = {
    inject: (_name: string, fn: () => unknown) => fn(),
    register: (options: Entry['options'], component: Entry['component']) => {
      entries.push({ options, component })
    },
  }
  slots.register({ name: 'conversation.chat.node', key: 'turn-error' }, HostTurnError as never)
  if (withPlugin)
    apply({
      get: (name: string) =>
        ({
          slots,
          connection: { rpc },
          locale: { register: () => () => undefined, bind: () => t },
        })[name],
      effect: (effect: () => unknown) => effect(),
    } as never)
  const render = (entry: Entry, owner: Record<string, unknown>) =>
    h(entry.component, { ...owner, ...entry.options.inject?.(), t })
  return {
    node(key: string, owner: Record<string, unknown>) {
      const winner = entries.findLast(
        (entry) => entry.options.name === 'conversation.chat.node' && entry.options.key === key,
      )
      return winner === undefined ? null : render(winner, owner)
    },
    turnTail(owner: Record<string, unknown>) {
      return entries
        .filter((entry) => entry.options.name === 'conversation.chat.turnTail')
        .map((entry) => render(entry, owner))
    },
  }
}

function failedTurn(message: string, code: string) {
  return {
    turn: 3,
    status: 'closed',
    end: {
      type: 'turn/end',
      data: { turn: 3, reason: { kind: 'error', error: { message, code } } },
    },
  }
}

async function renderJson(element: ReturnType<typeof h> | null) {
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(h('div', null, element))
  })
  const json = tree.toJSON()
  tree.unmount()
  return json
}

it.each([
  ['QUOTA', 'quota exhausted upstream'],
  ['POOL_UNAVAILABLE', 'POOL_UNAVAILABLE'],
])('leaves the host turn-error row for %s exactly as without the plugin', async (code, message) => {
  const node = { data: { message, code } }
  const absent = await renderJson(hostSlots(false).node('turn-error', { node }))
  const present = await renderJson(hostSlots(true).node('turn-error', { node }))
  expect(present).toEqual(absent)
  const text = JSON.stringify(present)
  expect(text).toContain('このターンは失敗しました')
  expect(text).toContain('turnErrorDot')
  if (code === 'QUOTA') expect(text).toContain('リクエストのクォータを使い切りました。')
  const tail = hostSlots(true).turnTail({ turn: failedTurn(message, code), seq: 9 })
  for (const element of tail) expect(await renderJson(element)).toEqual(await renderJson(null))
})

it('keeps the host row and adds the re-login panel under a login-required turn', async () => {
  const message = 'SUBSCRIPTION_LOGIN_REQUIRED: primary · /claude-login primary'
  const node = { data: { message, code: 'SUBSCRIPTION_LOGIN_REQUIRED' } }
  const rpc = { call: vi.fn() }
  const host = hostSlots(true, rpc)
  expect(await renderJson(host.node('turn-error', { node }))).toEqual(
    await renderJson(hostSlots(false).node('turn-error', { node })),
  )
  const tail = host.turnTail({ turn: failedTurn(message, 'SUBSCRIPTION_LOGIN_REQUIRED'), seq: 9 })
  expect(tail).toHaveLength(1)
  let tree!: ReactTestRenderer
  await act(async () => {
    tree = create(h('div', null, ...tail))
  })
  expect(
    tree.root
      .findAllByType('button')
      .some((button) => button.children.includes('Start official login')),
  ).toBe(true)
  expect(rpc.call).not.toHaveBeenCalled()
  tree.unmount()
})

it('adds nothing under a turn that is still open or ended without an error', async () => {
  const host = hostSlots(true)
  for (const turn of [
    { turn: 1, status: 'open', end: undefined },
    {
      turn: 2,
      status: 'closed',
      end: { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
    },
  ])
    for (const element of host.turnTail({ turn, seq: 1 }))
      expect(await renderJson(element)).toEqual(await renderJson(null))
})
