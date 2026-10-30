import { createElement as h, useEffect, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import { listedAccountModels, modelPresentation } from '../model-presentation.js'
import type { Alias, LoginView, ProfileRef } from '../login-view.js'
import { ACCOUNT_ALIAS } from '../routing/types.js'
import type { AccountController } from '../ui/controller.js'
import { ClaudeLoginCard, LoginExchangePanel } from './login-panel.js'
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
  account: Status['accounts'][number]
  rpc: Rpc
  busy: boolean
  run: (action: string, payload: unknown) => Promise<void>
}) {
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
      props.account.aliases.join(', ') || '無効',
      props.account.isDefault ? ' • 既定' : '',
    ),
    h(
      'p',
      null,
      `${props.account.state} · 推論中 ${props.account.inFlight} · 追加使用量 ${props.account.billingSafety === 'user-confirmed-off' ? 'OFF確認済み' : '未確認'}`,
    ),
    h(
      'p',
      null,
      'モデル／思考の強さ: ',
      Object.entries(props.account.models)
        .map(
          ([m, e]) =>
            modelPresentation(m, props.account.modelMetadata?.[m]).name +
            ' (' +
            (e.join(', ') || '指定なし') +
            ')',
        )
        .join(' / '),
    ),
    ...(props.account.windows.length
      ? props.account.windows.map((w) =>
          h(
            'p',
            { key: w.key },
            `${w.key}: 残量 ${w.remaining === null ? '不明' : Math.round(w.remaining * 100) + '%'} · リセット ${w.resetsAt ? new Date(w.resetsAt).toLocaleString() : '不明'} · 観測 ${new Date(w.observedAt).toLocaleString()}`,
          ),
        )
      : [h('p', { key: 'unknown' }, '利用枠の残量・リセット: 不明')]),
    h('p', null, '直近の処理理由: ', props.account.lastRouteReason ?? 'まだ利用していません'),
    props.account.state === 'DISABLED' || known === undefined
      ? h(
          'label',
          null,
          '表示名 ',
          h('input', {
            value: typed,
            maxLength: 48,
            onChange: (event: ChangeEvent<HTMLInputElement>) => setTyped(event.target.value),
          }),
        )
      : null,
    props.account.state === 'DISABLED' || known === undefined
      ? h(LoginExchangePanel, {
          rpc: props.rpc,
          target: { kind: 'identity', identity: props.account.id, alias: typed as Alias },
        })
      : h(LoginExchangePanel, {
          rpc: props.rpc,
          target: { kind: 'alias', alias: known as Alias },
        }),
    known !== undefined
      ? h(
          'div',
          null,
          button('接続を確認', 'verify', { alias: known }),
          button('既定にする', 'setDefault', { alias: known }),
          button('接続を外す', 'remove', { alias: known }),
        )
      : null,
  )
}
export const inject = ['slots', 'connection']
export function Section({ rpc }: { rpc: Rpc }) {
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
      setError(e instanceof Error ? e.message : '操作を完了できませんでした')
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
    h('h2', null, 'Claude サブスクリプション'),
    h(
      'p',
      null,
      '公式Claudeログインを使います。追加使用量はClaude側でOFFにしてください。残量の更新のために推論することはありません。',
    ),
    state
      ? h(
          'p',
          null,
          '待機中 ',
          state.pending?.filter((x) => x.phase.startsWith('waiting')).length ?? 0,
        )
      : null,
    error ? h('p', { role: 'alert', style: { color: '#c44' } }, error) : null,
    h(
      'div',
      null,
      button('状態を更新', 'status', {}),
      busy ? h('span', { role: 'status' }, ' 処理中…') : null,
    ),
    h(
      'fieldset',
      { disabled: busy },
      h('legend', null, 'アカウントを追加'),
      h(
        'label',
        null,
        '表示名 ',
        h('input', {
          value: alias,
          onChange: (e: React.ChangeEvent<HTMLInputElement>) => setAlias(e.target.value),
          maxLength: 48,
        }),
      ),
      h(
        'label',
        null,
        ' 公式プロファイル（空欄で標準） ',
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
        ' Claudeの追加使用量がOFFであることを確認しました',
      ),
      button('既存の公式ログインを接続', 'add', draft),
      h(LoginExchangePanel, {
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
          '既存の会話で「default」を選択している場合のモデル ',
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
          `完了応答 ${state.usage.responses} · ツール待ち ${state.usage.toolBoundaries} · 失敗／中断 ${state.usage.failed} · 入力 ${state.usage.usage.inputTokens} · 出力 ${state.usage.usage.outputTokens} tokens`,
        )
      : null,
  )
}
export function apply(ctx: Context) {
  const slots = ctx.get('slots') as {
      inject: (name: string, fn: () => unknown) => void
      register: (options: unknown, component: unknown) => unknown
    },
    connection = ctx.get('connection') as { rpc: Rpc }
  slots.inject('settings.section', () =>
    slots.register(
      {
        name: 'settings.section',
        id: 'claude-sdk-local',
        order: 91,
        label: () => 'Claude サブスクリプション',
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
        inject: () => ({ rpc: connection.rpc }),
      },
      ClaudeLoginCard,
    ),
  )
}
