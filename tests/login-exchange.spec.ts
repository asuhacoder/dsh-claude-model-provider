import { describe, expect, it } from 'vitest'
import { publicFailureMessage } from '../src/errors.js'
import { claudeLoginResult } from '../src/login-command.js'
import {
  admitLogin,
  accountAllowsLogin,
  bindLoginGate,
  extractAuthorizeUrl,
  LOGIN_CHILD_TIMEOUT_MS,
  profileLoginHeld,
  ProfileLoginGate,
  resolveLoginTarget,
  stepLogin,
  toLoginView,
} from '../src/login-exchange.js'
import type { ExchangeState, LoginEffect, LoginEvent } from '../src/login-exchange.js'
import {
  failureCode,
  formatLoginRequiredMessage,
  parseAlias,
  parseAttemptId,
  parseAuthorizationCode,
  parseLoginPayload,
  parseLoginRequiredMessage,
  parseProfileRef,
} from '../src/login-view.js'
import type { Account, AccountState } from '../src/routing/types.js'
import { RouteBlocked } from '../src/routing/types.js'

const SAMPLE_CODE = 'test-code-value'
const SAMPLE_URL = 'https://claude.com/oauth/authorize?state=fixture'
const ATTEMPT = '00000000-0000-4000-8000-000000000001'
const OTHER_ATTEMPT = '00000000-0000-4000-8000-000000000002'

function blocked(code: string): RouteBlocked {
  return new RouteBlocked(code)
}

function messageOf(run: () => void): string {
  try {
    run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  return ''
}

function row(
  identity: string,
  profileRef: string,
  state: AccountState,
  aliases: string[] = [],
  extraUsageOffConfirmedAt?: number,
): Account {
  return {
    identity,
    aliases,
    profileRef,
    state,
    verifiedAt: 1,
    ...(extraUsageOffConfirmedAt === undefined ? {} : { extraUsageOffConfirmedAt }),
    models: {},
    windows: [],
    parallelLimit: 4,
  }
}

describe('login payload parsers', () => {
  it('accepts a printable code and rejects a url, a token prefix, and whitespace', () => {
    expect(parseAuthorizationCode(SAMPLE_CODE)).toBe(SAMPLE_CODE)
    for (const value of [
      'abc',
      `${SAMPLE_CODE} `,
      'bad code',
      `${SAMPLE_URL}`,
      `sk-ant-${SAMPLE_CODE}`,
      'not ascii é',
      'x'.repeat(1025),
    ]) {
      const message = messageOf(() => parseAuthorizationCode(value))
      expect(message).toBe('LOGIN_CODE_REJECTED')
      expect(message).not.toContain(SAMPLE_CODE)
      expect(message).not.toContain('claude.com')
      expect(message).not.toContain('sk-ant-')
      expect(message).not.toContain('fixture')
    }
  })

  it('parses open, paste, close, and read without keeping a rejected code', () => {
    const attempt = parseAttemptId(ATTEMPT)
    expect(parseAlias('primary')).toBe('primary')
    expect(parseProfileRef('default')).toBe('default')
    expect(parseProfileRef('/tmp/claude-primary')).toBe('/tmp/claude-primary')
    expect(messageOf(() => parseProfileRef('relative'))).toBe('PROFILE_MUST_BE_ABSOLUTE')
    expect(messageOf(() => parseAlias('has space'))).toBe('INVALID_ALIAS')
    expect(messageOf(() => parseAttemptId('not-a-uuid'))).toBe('INVALID_PAYLOAD')

    expect(
      parseLoginPayload({ op: 'open', attempt: ATTEMPT, alias: 'primary', extraUsageOff: true }),
    ).toEqual({
      op: 'open',
      attempt,
      target: { kind: 'alias', alias: 'primary' },
      extraUsageOff: true,
    })
    expect(
      parseLoginPayload({
        op: 'open',
        attempt: ATTEMPT,
        profile: '/tmp/claude-primary',
        alias: 'primary',
        extraUsageOff: 'yes',
      }),
    ).toMatchObject({
      extraUsageOff: false,
      target: { kind: 'profile', profile: '/tmp/claude-primary' },
    })
    expect(
      parseLoginPayload({
        op: 'open',
        attempt: ATTEMPT,
        id: 'A',
        alias: 'primary',
        profile: '/tmp/ignored',
      }),
    ).toMatchObject({ target: { kind: 'identity', identity: 'A', alias: 'primary' } })
    expect(parseLoginPayload({ op: 'read', profile: 'default' })).toEqual({
      op: 'read',
      target: { kind: 'profile', profile: 'default' },
    })
    expect(
      parseLoginPayload({ op: 'paste', attempt: ATTEMPT, alias: 'primary', code: SAMPLE_CODE }),
    ).toMatchObject({ op: 'paste', code: SAMPLE_CODE })
    expect(parseLoginPayload({ op: 'close', attempt: ATTEMPT, alias: 'primary' })).toMatchObject({
      op: 'close',
    })
    expect(
      messageOf(() =>
        parseLoginPayload({ op: 'paste', attempt: ATTEMPT, alias: 'primary', code: SAMPLE_URL }),
      ),
    ).toBe('LOGIN_CODE_REJECTED')
    expect(messageOf(() => parseLoginPayload(null))).toBe('INVALID_PAYLOAD')
    expect(messageOf(() => parseLoginPayload({ op: 'nope', alias: 'primary' }))).toBe(
      'INVALID_PAYLOAD',
    )
  })

  it('round-trips the login-required label and ignores every other code', () => {
    const named = blocked('SUBSCRIPTION_LOGIN_REQUIRED')
    named.accountLabel = 'asuhasub'
    const namedMessage = publicFailureMessage(named, 'SUBSCRIPTION_LOGIN_REQUIRED')
    expect(namedMessage).toBe(
      'SUBSCRIPTION_LOGIN_REQUIRED: asuhasub · /claude-login asuhasub',
    )
    expect(namedMessage).toBe(formatLoginRequiredMessage('asuhasub'))
    expect(parseLoginRequiredMessage(namedMessage)).toEqual({ kind: 'alias', alias: 'asuhasub' })
    expect(parseLoginRequiredMessage('SUBSCRIPTION_LOGIN_REQUIRED: asuhasub')).toEqual({
      kind: 'alias',
      alias: 'asuhasub',
    })

    const path = blocked('SUBSCRIPTION_LOGIN_REQUIRED')
    path.accountLabel = '/tmp/claude-primary'
    expect(
      parseLoginRequiredMessage(publicFailureMessage(path, 'SUBSCRIPTION_LOGIN_REQUIRED')),
    ).toEqual({
      kind: 'profile',
      profile: '/tmp/claude-primary',
    })
    expect(parseLoginRequiredMessage(formatLoginRequiredMessage('default'))).toEqual({
      kind: 'alias',
      alias: 'default',
    })
    expect(parseLoginRequiredMessage('POOL_UNAVAILABLE: primary')).toBeUndefined()
    expect(parseLoginRequiredMessage('SUBSCRIPTION_LOGIN_REQUIRED: relative/path')).toBeUndefined()
    expect(claudeLoginResult(' primary')).toEqual({ kind: 'success' })
    expect(claudeLoginResult('not a label')).toEqual({ kind: 'error', text: 'INVALID_PAYLOAD' })
    expect(JSON.stringify(claudeLoginResult('sk-ant-fixture pasted'))).not.toContain('sk-ant')
    expect(failureCode(blocked('ALIAS_IDENTITY_CHANGED'))).toBe('ALIAS_IDENTITY_CHANGED')
    expect(failureCode(new Error(SAMPLE_CODE))).toBe('LOGIN_INCOMPLETE')
    expect(String(failureCode(new Error(SAMPLE_URL)))).not.toContain('fixture')
    expect(String(failureCode(new Error(SAMPLE_CODE)))).not.toContain(SAMPLE_CODE)
  })
})

describe('login exchange reducer', () => {
  const attempt = parseAttemptId(ATTEMPT)
  const other = parseAttemptId(OTHER_ATTEMPT)
  const profileRef = parseProfileRef('/tmp/claude-primary')
  const code = parseAuthorizationCode(SAMPLE_CODE)
  const url = extractAuthorizeUrl(`${SAMPLE_URL}\n`)
  if (url === undefined) throw new Error('allowlisted fixture url was dropped')

  const spawning: ExchangeState = {
    phase: 'spawning',
    attempt,
    accountLabel: 'primary',
    profileRef,
  }
  const awaiting: ExchangeState = { ...spawning, phase: 'awaiting_code', authorizeUrl: url }
  const writing: ExchangeState = { ...awaiting, phase: 'writing_code' }
  const verifying: ExchangeState = {
    phase: 'verifying',
    attempt,
    accountLabel: 'primary',
    profileRef,
  }
  const ready: ExchangeState = { phase: 'ready', attempt, accountLabel: 'primary', profileRef }
  const failed: ExchangeState = {
    phase: 'failed',
    attempt,
    accountLabel: 'primary',
    profileRef,
    failureCode: failureCode(blocked('LOGIN_INCOMPLETE')),
  }
  const states: ExchangeState[] = [
    { phase: 'idle' },
    spawning,
    awaiting,
    writing,
    verifying,
    ready,
    failed,
  ]
  const begin = {
    type: 'begin' as const,
    attempt,
    accountLabel: 'primary',
    profileRef,
  }
  const events: LoginEvent[] = [
    begin,
    { ...begin, attempt: other },
    { type: 'authorize_url', url },
    { type: 'paste', attempt, code },
    { type: 'paste', attempt: other, code },
    { type: 'child_exit', ok: true },
    { type: 'child_exit', ok: false },
    { type: 'verify_ok' },
    { type: 'verify_failed', failureCode: failureCode(blocked('ALIAS_IDENTITY_CHANGED')) },
    { type: 'cancel', attempt },
    { type: 'cancel', attempt: other },
    { type: 'timeout' },
  ]

  function effectsOf(effects: readonly LoginEffect[]): string[] {
    return effects.map((effect) => effect.type)
  }

  it('keeps the sample code off the state for every event', () => {
    for (const state of states) {
      for (const event of events) {
        const step = stepLogin(state, event)
        expect(JSON.stringify(step.state)).not.toContain(SAMPLE_CODE)
        expect(JSON.stringify(step.state)).not.toContain('sk-ant-')
        for (const effect of step.effects) {
          if (effect.type === 'write_code') continue
          expect(JSON.stringify(effect)).not.toContain(SAMPLE_CODE)
          expect(JSON.stringify(effect)).not.toContain(SAMPLE_URL)
        }
        if (
          step.state.phase === 'failed' ||
          step.state.phase === 'ready' ||
          step.state.phase === 'verifying'
        )
          expect(JSON.stringify(step.state)).not.toContain('fixture')
      }
    }
  })

  it('does not spawn again when begin repeats during the active attempt', () => {
    const started = stepLogin({ phase: 'idle' }, begin)
    expect(started.state.phase).toBe('spawning')
    expect(effectsOf(started.effects)).toEqual(['spawn', 'arm_timer'])
    const repeated = stepLogin(started.state, { ...begin, attempt: other })
    expect(repeated.reaction).toBe('ignore')
    expect(repeated.effects).toEqual([])
    expect(repeated.state).toEqual(started.state)
  })

  it('writes the code once and ignores a second paste', () => {
    const first = stepLogin(awaiting, { type: 'paste', attempt, code })
    expect(first.reaction).toBe('applied')
    expect(first.state.phase).toBe('writing_code')
    expect(first.effects).toEqual([{ type: 'write_code', code }])
    expect(JSON.stringify(first.state)).not.toContain(SAMPLE_CODE)
    const second = stepLogin(first.state, { type: 'paste', attempt, code })
    expect(second.reaction).toBe('ignore')
    expect(second.effects).toEqual([])
    expect(second.state).toEqual(first.state)
  })

  it('rejects paste while the child is still spawning', () => {
    const step = stepLogin(spawning, { type: 'paste', attempt, code })
    expect(step.reaction).toBe('reject_not_ready')
    expect(step.effects).toEqual([])
    expect(step.state).toEqual(spawning)
  })

  it('verifies when the child exits 0 before a paste', () => {
    const step = stepLogin(spawning, { type: 'child_exit', ok: true })
    expect(step.state.phase).toBe('verifying')
    expect(effectsOf(step.effects)).toEqual(['clear_timer', 'discard_buffer', 'verify'])
    expect(JSON.stringify(step.state)).not.toContain(SAMPLE_URL)
  })

  it('fails an incomplete child and releases the gate on timeout', () => {
    expect(LOGIN_CHILD_TIMEOUT_MS).toBe(180_000)
    const step = stepLogin(awaiting, { type: 'timeout' })
    expect(step.state).toMatchObject({ phase: 'failed', failureCode: 'LOGIN_INCOMPLETE' })
    expect(effectsOf(step.effects)).toEqual([
      'kill',
      'clear_timer',
      'discard_buffer',
      'release_gate',
    ])
    expect(JSON.stringify(step.state)).not.toContain('fixture')
    expect(stepLogin(verifying, { type: 'timeout' }).reaction).toBe('ignore')
  })

  it('cancels the active attempt and leaves a different attempt running', () => {
    const step = stepLogin(writing, { type: 'cancel', attempt })
    expect(step.state).toMatchObject({ phase: 'failed', failureCode: 'LOGIN_CANCELLED' })
    expect(effectsOf(step.effects)).toContain('release_gate')
    expect(stepLogin(writing, { type: 'cancel', attempt: other }).reaction).toBe('ignore')
    expect(stepLogin(step.state, { type: 'cancel', attempt }).reaction).toBe('ignore')
  })

  it('starts a clean attempt after ready or failed and keeps the same attempt', () => {
    const done = stepLogin(verifying, { type: 'verify_ok' })
    expect(done.state.phase).toBe('ready')
    expect(effectsOf(done.effects)).toContain('release_gate')
    expect(stepLogin(done.state, begin).reaction).toBe('ignore')
    const restarted = stepLogin(done.state, { ...begin, attempt: other })
    expect(restarted.state.phase).toBe('spawning')
    expect(effectsOf(restarted.effects)).toEqual(['spawn', 'arm_timer'])

    const mismatch = stepLogin(verifying, {
      type: 'verify_failed',
      failureCode: failureCode(blocked('ALIAS_IDENTITY_CHANGED')),
    })
    expect(mismatch.state).toMatchObject({ phase: 'failed', failureCode: 'ALIAS_IDENTITY_CHANGED' })
    expect(JSON.stringify(mismatch.state)).not.toContain(SAMPLE_URL)
    expect(stepLogin(mismatch.state, begin).reaction).toBe('ignore')
    expect(stepLogin(failed, { type: 'verify_ok' }).reaction).toBe('ignore')
  })

  it('derives the browser view and omits the url except while the code is needed', () => {
    expect(messageOf(() => toLoginView({ phase: 'idle' }))).toBe('LOGIN_NOT_READY')
    expect(toLoginView(spawning).phase).toBe('opening')
    const needs = toLoginView(awaiting)
    expect(needs).toMatchObject({ phase: 'needs_code', authorizeUrl: url })
    const finishing = toLoginView(writing)
    expect(finishing.phase).toBe('finishing')
    expect(JSON.stringify(finishing)).not.toContain('fixture')
    expect(JSON.stringify(toLoginView(verifying))).not.toContain('fixture')
    expect(toLoginView(ready).phase).toBe('ready')
    expect(toLoginView(failed)).toMatchObject({ phase: 'failed', failureCode: 'LOGIN_INCOMPLETE' })
    const captured = stepLogin(spawning, { type: 'authorize_url', url })
    expect(captured.state.phase).toBe('awaiting_code')
    expect(captured.effects).toEqual([{ type: 'discard_buffer' }])
    expect(stepLogin(awaiting, { type: 'authorize_url', url }).reaction).toBe('ignore')
  })
})

describe('login admission', () => {
  it('admits a logged-out ready row, auth required, suspended, disabled, and a new profile', () => {
    for (const state of ['READY', 'AUTH_REQUIRED', 'SUSPENDED', 'DISABLED'] as const) {
      expect(accountAllowsLogin(state)).toBe(true)
      expect(admitLogin({ rowStates: [state], reservationsForProfile: 0 })).toEqual({ ok: true })
    }
    expect(admitLogin({ rowStates: [], reservationsForProfile: 0 })).toEqual({ ok: true })
  })

  it('refuses draining and cooldown before it looks at reservations', () => {
    for (const state of ['DRAINING', 'COOLDOWN'] as const) {
      expect(accountAllowsLogin(state)).toBe(false)
      expect(admitLogin({ rowStates: [state], reservationsForProfile: 1 })).toEqual({
        ok: false,
        code: 'ACCOUNT_NOT_READY',
      })
    }
  })

  it('refuses open when this profile already has a reservation', () => {
    expect(admitLogin({ rowStates: ['READY'], reservationsForProfile: 1 })).toEqual({
      ok: false,
      code: 'PROFILE_LOGIN_BUSY',
    })
    expect(admitLogin({ rowStates: ['AUTH_REQUIRED'], reservationsForProfile: 0 })).toEqual({
      ok: true,
    })
  })

  it('uses the stored profile for an alias and refuses an alias owned by another profile', () => {
    const accounts = [
      row('A', '/tmp/claude-primary', 'READY', ['primary']),
      row('B', '/tmp/claude-other', 'DISABLED', []),
    ]
    expect(
      resolveLoginTarget({ kind: 'alias', alias: parseAlias('primary') }, accounts, false),
    ).toMatchObject({
      profileRef: '/tmp/claude-primary',
      alias: 'primary',
      accountLabel: 'primary',
      rowStates: ['READY'],
      extraUsageOff: false,
    })
    expect(
      messageOf(() =>
        resolveLoginTarget({ kind: 'alias', alias: parseAlias('missing') }, accounts, false),
      ),
    ).toBe('ACCOUNT_NOT_FOUND')
    expect(
      messageOf(() =>
        resolveLoginTarget(
          {
            kind: 'profile',
            profile: parseProfileRef('/tmp/claude-new'),
            alias: parseAlias('primary'),
          },
          accounts,
          false,
        ),
      ),
    ).toBe('ALIAS_IDENTITY_CHANGED')

    const added = resolveLoginTarget(
      {
        kind: 'profile',
        profile: parseProfileRef('/tmp/claude-new'),
        alias: parseAlias('fresh'),
      },
      accounts,
      true,
    )
    expect(added).toMatchObject({
      profileRef: '/tmp/claude-new',
      alias: 'fresh',
      rowStates: [],
      extraUsageOff: true,
    })
    expect(
      resolveLoginTarget(
        { kind: 'profile', profile: parseProfileRef('/tmp/claude-primary') },
        accounts,
        false,
      ),
    ).toMatchObject({ alias: 'primary', profileRef: '/tmp/claude-primary' })

    const disabled = resolveLoginTarget(
      { kind: 'identity', identity: 'B', alias: parseAlias('revived') },
      accounts,
      false,
    )
    expect(disabled).toMatchObject({
      profileRef: '/tmp/claude-other',
      alias: 'revived',
      accountLabel: 'revived',
      rowStates: ['DISABLED'],
    })
    expect(
      messageOf(() =>
        resolveLoginTarget(
          { kind: 'identity', identity: 'B', alias: parseAlias('primary') },
          accounts,
          false,
        ),
      ),
    ).toBe('ALIAS_IDENTITY_CHANGED')
    expect(
      messageOf(() =>
        resolveLoginTarget(
          { kind: 'identity', identity: 'missing', alias: parseAlias('revived') },
          accounts,
          false,
        ),
      ),
    ).toBe('ACCOUNT_NOT_FOUND')
    expect(
      messageOf(() =>
        resolveLoginTarget(
          { kind: 'profile', profile: parseProfileRef('/tmp/nobody') },
          accounts,
          false,
        ),
      ),
    ).toBe('ACCOUNT_NOT_FOUND')
  })

  it('keeps extra usage confirmation from the stored row', () => {
    const accounts = [row('A', 'default', 'SUSPENDED', ['primary'], 10)]
    expect(
      resolveLoginTarget({ kind: 'alias', alias: parseAlias('primary') }, accounts, false),
    ).toMatchObject({
      profileRef: 'default',
      extraUsageOff: true,
      rowStates: ['SUSPENDED'],
    })
  })
})

describe('authorize url allowlist', () => {
  it('keeps the first allowlisted https url and drops everything else', () => {
    expect(extractAuthorizeUrl(`${SAMPLE_URL}\n`)).toBe(SAMPLE_URL)
    expect(extractAuthorizeUrl(SAMPLE_URL)).toBeUndefined()
    expect(extractAuthorizeUrl(`\u001b[32m${SAMPLE_URL}\u001b[0m\r\n`)).toBe(SAMPLE_URL)
    expect(extractAuthorizeUrl(`https://accounts.claude.ai/login\n`)).toBe(
      'https://accounts.claude.ai/login',
    )
    expect(extractAuthorizeUrl(`${SAMPLE_URL}).\n`)).toBe(SAMPLE_URL)
    expect(extractAuthorizeUrl(`https://evil.example/a ${SAMPLE_URL}\n`)).toBe(SAMPLE_URL)
    const mixed = extractAuthorizeUrl(`${SAMPLE_URL}\n${SAMPLE_CODE}\n`)
    expect(mixed).toBe(SAMPLE_URL)
    expect(mixed).not.toContain(SAMPLE_CODE)

    for (const blockedUrl of [
      'https://localhost/oauth/authorize?state=fixture\n',
      'https://api.localhost/oauth\n',
      'http://127.0.0.1/callback\n',
      'https://127.0.0.1/callback\n',
      'https://[::1]/oauth\n',
      'https://user:test-code-value@claude.com/oauth\n',
      'https://claude.ai.evil.example/oauth\n',
      'http://claude.com/oauth\n',
      'https://2130706433/oauth\n',
    ]) {
      expect(extractAuthorizeUrl(blockedUrl)).toBeUndefined()
    }
  })
})

describe('profile login gate', () => {
  it('reports a hold only for the store the gate is bound to', () => {
    const gate = new ProfileLoginGate()
    const store = {}
    const other = {}
    expect(profileLoginHeld(store, 'default')).toBe(false)
    bindLoginGate(store, gate)
    expect(profileLoginHeld(store, '/tmp/claude-primary')).toBe(false)
    gate.hold('/tmp/claude-primary')
    expect(gate.holds('/tmp/claude-primary')).toBe(true)
    expect(profileLoginHeld(store, '/tmp/claude-primary')).toBe(true)
    expect(profileLoginHeld(store, 'default')).toBe(false)
    expect(profileLoginHeld(other, '/tmp/claude-primary')).toBe(false)
    gate.release('/tmp/claude-primary')
    gate.release('/tmp/claude-primary')
    expect(profileLoginHeld(store, '/tmp/claude-primary')).toBe(false)
  })
})
