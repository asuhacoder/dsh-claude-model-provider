import { createElement as h, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { listedAccountModels, modelPresentation } from '../model-presentation.js'
import type { Alias, LoginView, ProfileRef } from '../login-view.js'
import { ACCOUNT_ALIAS } from '../routing/types.js'
import type { AccountController } from '../ui/controller.js'
import { ClaudeLoginCard, ClaudeTurnError, LoginExchangePanel } from './login-panel.js'
import { dictionaries, japanese, NS, type Translate } from './messages.js'
type Status = ReturnType<AccountController['status']>
type Screen = Status & { exchange?: LoginView }
interface Rpc {
  call(
    channel: string,
    method: string,
    payload: unknown,
  ): Promise<{ ok: true; value: Screen } | { ok: false; error: { message: string } }>
}
function AccountArticle(props: {
  t: Translate
  account: Status['accounts'][number]
  rpc: Rpc
  busy: boolean
  run: (action: string, payload: unknown) => Promise<void>
}) {
  const { t } = props
  const [typed, setTyped] = useState('')
  const known = props.account.aliases.find((item) => ACCOUNT_ALIAS.test(item))
  const button = (text: string, action: string, payload: unknown) =>
    h(
      'button',
      { type: 'button', disabled: props.busy, onClick: () => void props.run(action, payload) },
      text,
    )
  return h(
    'article',
    { style: { border: '1px solid #8885', borderRadius: 8, padding: 16 } },
    h(
      'h3',
      null,
      props.account.isDefault
        ? t('defaultAccount', { aliases: props.account.aliases.join(', ') || t('disabled') })
        : props.account.aliases.join(', ') || t('disabled'),
    ),
    h(
      'p',
      null,
      t('accountStatus', {
        state: props.account.state,
        inFlight: props.account.inFlight,
        billingSafety: t(
          props.account.billingSafety === 'user-confirmed-off' ? 'extraUsageOff' : 'unverified',
        ),
      }),
    ),
    h(
      'p',
      null,
      t('models', {
        models: Object.entries(props.account.models)
          .map(([model, efforts]) =>
            t('modelEffort', {
              model: modelPresentation(model, props.account.modelMetadata?.[model]).name,
              effort: efforts.join(', ') || t('unspecified'),
            }),
          )
          .join(' / '),
      }),
    ),
    ...(props.account.windows.length
      ? props.account.windows.map((w) =>
          h(
            'p',
            { key: w.key },
            t('usageWindow', {
              key: w.key,
              remaining: w.remaining === null ? t('unknown') : Math.round(w.remaining * 100) + '%',
              resetsAt: w.resetsAt ? new Date(w.resetsAt).toLocaleString() : t('unknown'),
              observedAt: new Date(w.observedAt).toLocaleString(),
            }),
          ),
        )
      : [h('p', { key: 'unknown' }, t('unknownUsageWindow'))]),
    h('p', null, t('lastRouteReason', { reason: props.account.lastRouteReason ?? t('notUsed') })),
    props.account.state === 'DISABLED' || known === undefined
      ? h(
          'label',
          null,
          t('displayName'),
          h('input', {
            value: typed,
            maxLength: 48,
            onChange: (event: ChangeEvent<HTMLInputElement>) => setTyped(event.target.value),
          }),
        )
      : null,
    props.account.state === 'DISABLED' || known === undefined
      ? h(LoginExchangePanel, {
          t,
          rpc: props.rpc,
          target: { kind: 'identity', identity: props.account.id, alias: typed as Alias },
        })
      : h(LoginExchangePanel, {
          t,
          rpc: props.rpc,
          target: { kind: 'alias', alias: known as Alias },
        }),
    known !== undefined
      ? h(
          'div',
          null,
          button(t('verifyConnection'), 'verify', { alias: known }),
          button(t('setDefault'), 'setDefault', { alias: known }),
          button(t('removeConnection'), 'remove', { alias: known }),
        )
      : null,
  )
}
export const inject = ['slots', 'connection', 'locale']
export function Section({ rpc, t }: { rpc: Rpc; t: Translate }) {
  const [state, setState] = useState<Status>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [alias, setAlias] = useState('primary'),
    [profile, setProfile] = useState(''),
    [off, setOff] = useState(false)
  async function run(action: string, payload: unknown = {}) {
    setBusy(true)
    setError('')
    try {
      const result = await rpc.call('/api', 'claude-sdk-local.' + action, payload)
      if (!result.ok) throw new Error(result.error.message)
      setState(result.value)
    } catch (e) {
      setError(e instanceof Error ? e.message : t('operationFailed'))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => {
    void run('status')
  }, [])
  const button = (text: string, action: string, payload: unknown) =>
    h('button', { type: 'button', disabled: busy, onClick: () => void run(action, payload) }, text)
  const draft = { alias, ...(profile ? { profile } : {}), extraUsageOff: off }
  return h(
    'section',
    { style: { maxWidth: 960, padding: 24, display: 'grid', gap: 16 } },
    h('h2', null, t('title')),
    h('p', null, t('description')),
    state
      ? h(
          'p',
          null,
          t('waiting', {
            count: state.pending?.filter((x) => x.phase.startsWith('waiting')).length ?? 0,
          }),
        )
      : null,
    error ? h('p', { role: 'alert', style: { color: '#c44' } }, error) : null,
    h(
      'div',
      null,
      button(t('refreshStatus'), 'status', {}),
      busy ? h('span', { role: 'status' }, t('processing')) : null,
    ),
    h(
      'fieldset',
      { disabled: busy },
      h('legend', null, t('addAccount')),
      h(
        'label',
        null,
        t('displayName'),
        h('input', {
          value: alias,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value),
          maxLength: 48,
        }),
      ),
      h(
        'label',
        null,
        t('officialProfile'),
        h('input', {
          value: profile,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setProfile(e.target.value),
        }),
      ),
      h(
        'label',
        { style: { display: 'block' } },
        h('input', {
          type: 'checkbox',
          checked: off,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setOff(e.target.checked),
        }),
        t('confirmExtraUsageOff'),
      ),
      button(t('connectExistingLogin'), 'add', draft),
      h(LoginExchangePanel, {
        t,
        rpc,
        target: {
          kind: 'profile',
          profile: (profile === '' ? 'default' : profile) as ProfileRef,
          alias: alias as Alias,
        },
        extraUsageOff: off,
      }),
    ),
    state
      ? h(
          'label',
          null,
          t('defaultConversationModel'),
          h(
            'select',
            {
              value: state.defaultModel,
              disabled: busy,
              onChange: (e: React.ChangeEvent<HTMLSelectElement>) =>
                void run('setModel', { model: e.target.value }),
            },
            listedAccountModels(state.accounts).map((m) =>
              h('option', { key: m.id, value: m.id }, m.name),
            ),
          ),
        )
      : null,
    ...(state?.accounts ?? []).map((account) =>
      h(AccountArticle, {
        t,
        key: account.id,
        account,
        rpc,
        busy,
        run,
      }),
    ),
    state
      ? h(
          'p',
          null,
          t('usageSummary', {
            responses: state.usage.responses,
            toolBoundaries: state.usage.toolBoundaries,
            failed: state.usage.failed,
            inputTokens: state.usage.usage.inputTokens,
            outputTokens: state.usage.usage.outputTokens,
          }),
        )
      : null,
  )
}
export function apply(ctx: Context) {
  const slots = ctx.get('slots') as {
      inject: (name: string, fn: () => unknown) => void
      register: (options: unknown, component: unknown) => unknown
    },
    connection = ctx.get('connection') as { rpc: Rpc },
    locale = ctx.get('locale') as {
      register: (namespace: string, id: string, dict: Record<string, string>) => () => void
      getLocale: () => { active: string; locales: readonly { id: string }[] }
      addLanguage: (language: { id: string; label: string; fallback: string }) => () => void
      bind: (namespace: string) => Translate
    }
  for (const [id, dict] of Object.entries(dictionaries)) {
    ctx.effect(() => locale.register(NS, id, dict))
  }
  if (!locale.getLocale().locales.some((language) => language.id === 'ja')) {
    ctx.effect(() => locale.addLanguage(japanese))
  }
  const t = locale.bind(NS)
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'claude-sdk-local',
        order: 91,
        label: () => t('title'),
        locale: NS,
        inject: () => ({ rpc: connection.rpc }),
      },
      Section,
    ),
  )
  slots.inject('conversation.chat.commandview', () =>
    slots.register(
      {
        name: 'conversation.chat.commandview',
        key: 'claude-login',
        locale: NS,
        inject: () => ({ rpc: connection.rpc }),
      },
      ClaudeLoginCard,
    ),
  )
  slots.inject('conversation.chat.node', () =>
    slots.register(
      {
        name: 'conversation.chat.node',
        key: 'turn-error',
        locale: NS,
        inject: () => ({ rpc: connection.rpc }),
      },
      ClaudeTurnError,
    ),
  )
}
