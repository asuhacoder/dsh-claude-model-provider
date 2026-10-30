import { createElement as h, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { LoginTarget, LoginView, ParsedLoginFailure } from '../login-view.js'
import { parseAuthorizationCode, parseLoginRequiredMessage } from '../login-view.js'
import { RouteBlocked } from '../routing/types.js'

export interface LoginRpc {
  call(
    channel: string,
    method: string,
    payload: unknown,
  ): Promise<
    { ok: true; value: { exchange?: LoginView } } | { ok: false; error: { message: string } }
  >
}

// One browser open per attempt survives a remount of the same exchange.
const openedAttempts = new Set<string>()

function targetFields(target: ParsedLoginFailure | LoginTarget): Record<string, string> {
  switch (target.kind) {
    case 'alias':
      return { alias: target.alias }
    case 'profile':
      return 'alias' in target && target.alias !== undefined
        ? { profile: target.profile, alias: target.alias }
        : { profile: target.profile }
    case 'identity':
      return { id: target.identity, alias: target.alias }
    default: {
      const _exhaustive: never = target
      return _exhaustive
    }
  }
}

function failureText(error: unknown): string {
  return error instanceof RouteBlocked ? error.code : 'LOGIN_CODE_REJECTED'
}

export function LoginExchangePanel(props: {
  rpc: LoginRpc
  target: ParsedLoginFailure | LoginTarget
  extraUsageOff?: boolean
}) {
  const [view, setView] = useState<LoginView>()
  const [error, setError] = useState('')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const fields = targetFields(props.target)
  // A fresh object would restart the one-second poll on every keystroke.
  const fieldKey = JSON.stringify(fields)
  const polling =
    view?.phase === 'opening' || view?.phase === 'needs_code' || view?.phase === 'finishing'

  useEffect(() => {
    if (view?.phase !== 'needs_code') return
    if (openedAttempts.has(view.attempt)) return
    openedAttempts.add(view.attempt)
    globalThis.window?.open(view.authorizeUrl, '_blank', 'noopener,noreferrer')
  }, [view])

  useEffect(() => {
    if (!polling || view === undefined) return
    let stopped = false
    const timer = setInterval(() => {
      void props.rpc
        .call('/api', 'claude-sdk-local.login', { op: 'read', ...fields })
        .then((result) => {
          if (stopped) return
          if (!result.ok) {
            setError(result.error.message)
            return
          }
          if (result.value.exchange) setView(result.value.exchange)
        })
    }, 1000)
    return () => {
      stopped = true
      clearInterval(timer)
    }
  }, [polling, view?.phase, view?.attempt, fieldKey, props.rpc])

  async function open(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await props.rpc.call('/api', 'claude-sdk-local.login', {
        op: 'open',
        attempt: crypto.randomUUID(),
        extraUsageOff: props.extraUsageOff === true,
        ...fields,
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      if (result.value.exchange) setView(result.value.exchange)
    } catch (caught) {
      setError(failureText(caught))
    } finally {
      setBusy(false)
    }
  }

  async function paste(): Promise<void> {
    if (view?.phase !== 'needs_code') return
    let parsed: string
    try {
      parsed = parseAuthorizationCode(code)
    } catch (caught) {
      setError(failureText(caught))
      return
    }
    setBusy(true)
    setError('')
    try {
      const result = await props.rpc.call('/api', 'claude-sdk-local.login', {
        op: 'paste',
        attempt: view.attempt,
        code: parsed,
        ...fields,
      })
      if (!result.ok) {
        setError(result.error.message)
        return
      }
      setCode('')
      if (result.value.exchange) setView(result.value.exchange)
    } catch (caught) {
      setError(failureText(caught))
    } finally {
      setBusy(false)
    }
  }

  const pasteVisible =
    view === undefined ||
    view.phase === 'opening' ||
    view.phase === 'needs_code' ||
    view.phase === 'finishing'
  return h(
    'div',
    null,
    h(
      'button',
      { type: 'button', disabled: busy, onClick: () => void open() },
      '公式ログインを開始',
    ),
    view?.phase === 'needs_code'
      ? h(
          'a',
          { href: view.authorizeUrl, target: '_blank', rel: 'noopener noreferrer' },
          'Claudeのログインページを開く',
        )
      : null,
    pasteVisible
      ? h(
          'label',
          null,
          'コード ',
          h('input', {
            value: code,
            autoComplete: 'off',
            disabled: busy || view?.phase !== 'needs_code',
            onChange: (event: ChangeEvent<HTMLInputElement>) => setCode(event.target.value),
          }),
          h(
            'button',
            {
              type: 'button',
              disabled: busy || view?.phase !== 'needs_code',
              onClick: () => void paste(),
            },
            'コードを送信',
          ),
        )
      : null,
    view?.phase === 'ready' ? h('p', null, 'ログイン済み') : null,
    view?.phase === 'failed' ? h('p', { role: 'alert' }, view.failureCode) : null,
    error ? h('p', { role: 'alert' }, error) : null,
  )
}

/** The host already draws the failure text. This adds the login control beside that text. */
export function ClaudeTurnError(props: { message: string; code?: string; rpc: LoginRpc }) {
  if (props.code !== 'SUBSCRIPTION_LOGIN_REQUIRED') return null
  const parsed = parseLoginRequiredMessage(props.message)
  if (!parsed) return null
  return h(
    'div',
    null,
    h('p', null, props.message),
    h(LoginExchangePanel, { rpc: props.rpc, target: parsed }),
  )
}
