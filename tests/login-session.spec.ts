import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type SubprocessRuntime from '@deepseek-ai/dsh-subprocess'
import { resolveConfig } from '../src/index.js'
import { bindLoginGate, profileLoginHeld, ProfileLoginGate } from '../src/login-exchange.js'
import { parseLoginPayload } from '../src/login-view.js'
import type { LoginIntent } from '../src/login-view.js'
import { choose, StickyRouter } from '../src/routing/router.js'
import type { Account, AccountState, Binding, Reservation } from '../src/routing/types.js'
import { SubscriptionProvider } from '../src/sessions/provider.js'
import { StateStore } from '../src/storage/store.js'
import { AccountController } from '../src/ui/controller.js'
import type { LoginPty, LoginPtyExit } from '../src/ui/login-pty.js'
import { runProviderCli } from '../src/provider-cli.js'

const SAMPLE_CODE = 'test-code-value'
const SAMPLE_URL = 'https://claude.com/oauth/authorize?state=fixture'
const ATTEMPT = '00000000-0000-4000-8000-000000000001'
const ATTEMPT_2 = '00000000-0000-4000-8000-000000000002'

class FakePty implements LoginPty {
  readonly writes: string[] = []
  killed = false
  urlOnData = false
  exitOnRegister = false
  exitCode = 0
  readonly #data: ((chunk: string) => void)[] = []
  readonly #exit: ((event: LoginPtyExit) => void)[] = []

  write(bytes: string): void {
    this.writes.push(bytes)
  }
  kill(): void {
    this.killed = true
  }
  onData(listener: (chunk: string) => void): void {
    this.#data.push(listener)
    if (this.urlOnData) listener(`${SAMPLE_URL}\n`)
  }
  onExit(listener: (event: LoginPtyExit) => void): void {
    this.#exit.push(listener)
    if (this.exitOnRegister) listener({ exitCode: this.exitCode, signal: 0 })
  }
  emit(chunk: string): void {
    for (const listener of this.#data) listener(chunk)
  }
  finish(exitCode = 0): void {
    for (const listener of this.#exit) listener({ exitCode, signal: 0 })
  }
}

function row(state: AccountState, profileRef: string, alias: string, identity = 'A'): Account {
  return {
    identity,
    aliases: alias === '' ? [] : [alias],
    profileRef,
    state,
    verifiedAt: 1,
    extraUsageOffConfirmedAt: 1,
    models: { opus: ['low'] },
    windows: [{ key: 'five', scope: '*', epoch: '1', observedAt: 1, source: 'sdk' }],
    parallelLimit: 2,
    isDefault: true,
  }
}

function open(alias: string, extra: Record<string, unknown> = {}, attempt = ATTEMPT): LoginIntent {
  return parseLoginPayload({ op: 'open', attempt, alias, ...extra })
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return sources(path)
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
  })
}

it('does not spawn twice and writes the authorization code once', async () => {
  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('READY', 'default', 'primary'))
  const pty = new FakePty()
  pty.urlOnData = true
  const spawnLogin = vi.fn(() => pty)
  const verify = vi.fn(async () => row('READY', 'default', 'primary'))
  const c = new AccountController(() => s, 'claude', undefined, { verify, spawnLogin })
  try {
    const first = await c.login(open('primary'))
    const second = await c.login(open('primary', {}, ATTEMPT_2))
    expect(spawnLogin).toHaveBeenCalledOnce()
    expect(second.exchange).toEqual(first.exchange)
    expect(first.exchange.phase).toBe('needs_code')
    await c.login(
      parseLoginPayload({ op: 'paste', attempt: ATTEMPT, alias: 'primary', code: SAMPLE_CODE }),
    )
    await c.login(
      parseLoginPayload({ op: 'paste', attempt: ATTEMPT, alias: 'primary', code: SAMPLE_CODE }),
    )
    expect(pty.writes).toEqual([`${SAMPLE_CODE}\r`])
    expect(JSON.stringify(first.accounts)).not.toContain('profileRef')
    expect(JSON.stringify(first.accounts)).not.toContain('authorizeUrl')
    expect(JSON.stringify(first.accounts)).not.toContain('fixture')
  } finally {
    c.dispose()
    s.close()
  }
})

it('keeps the sample code and url out of failures and stored rows', async () => {
  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('AUTH_REQUIRED', '/tmp/claude-primary', 'primary'))
  const written: unknown[] = []
  const set = s.set.bind(s)
  s.set = (collection, key, value) => {
    written.push(value)
    return set(collection, key, value)
  }
  const pty = new FakePty()
  pty.exitOnRegister = true
  const verify = vi.fn(async () => {
    throw new Error(`${SAMPLE_CODE} ${SAMPLE_URL}`)
  })
  const c = new AccountController(() => s, 'claude', undefined, {
    verify,
    spawnLogin: () => pty,
  })
  try {
    const failed = await c.login(open('primary', { profile: '/tmp/claude-primary' }))
    expect(failed.exchange).toMatchObject({ phase: 'failed', failureCode: 'LOGIN_INCOMPLETE' })
    expect(JSON.stringify(failed)).not.toContain(SAMPLE_CODE)
    expect(JSON.stringify(failed)).not.toContain('fixture')
    expect(JSON.stringify(written)).not.toContain(SAMPLE_CODE)
    expect(JSON.stringify(written)).not.toContain('fixture')
    expect(s.get<Account>('accounts', 'A')?.state).toBe('AUTH_REQUIRED')
    await expect(
      c.execute('login', {
        op: 'paste',
        attempt: ATTEMPT_2,
        alias: 'primary',
        code: SAMPLE_URL,
      }),
    ).rejects.toThrow('LOGIN_CODE_REJECTED')
  } catch (error) {
    expect(String(error)).not.toContain(SAMPLE_CODE)
    expect(String(error)).not.toContain('fixture')
    throw error
  } finally {
    c.dispose()
    s.close()
  }
})

it('ends ready for the same org and keeps the previous row when the org changes', async () => {
  for (const state of ['READY', 'AUTH_REQUIRED', 'SUSPENDED', 'DISABLED'] as const) {
    const s = new StateStore(':memory:')
    const alias = state === 'DISABLED' ? '' : 'primary'
    s.set('accounts', 'A', row(state, '/tmp/claude-primary', alias))
    const written: unknown[] = []
    const set = s.set.bind(s)
    s.set = (collection, key, value) => {
      written.push(value)
      return set(collection, key, value)
    }
    const pty = new FakePty()
    pty.exitOnRegister = true
    const verify = vi.fn(async () => row('READY', '/tmp/claude-primary', 'primary'))
    const c = new AccountController(() => s, 'claude', undefined, {
      verify,
      spawnLogin: () => pty,
    })
    try {
      const intent =
        state === 'DISABLED'
          ? parseLoginPayload({ op: 'open', attempt: ATTEMPT, id: 'A', alias: 'primary' })
          : open('primary')
      const done = await c.login(intent)
      expect(done.exchange.phase).toBe('ready')
      expect(s.get<Account>('accounts', 'A')).toMatchObject({ state: 'READY', identity: 'A' })
      expect(JSON.stringify(written)).not.toContain(SAMPLE_CODE)
      expect(JSON.stringify(written)).not.toContain('fixture')
      expect(written.some((value) => JSON.stringify(value).includes('"state":"READY"'))).toBe(true)
    } finally {
      c.dispose()
      s.close()
    }
  }

  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('DISABLED', '/tmp/claude-primary', ''))
  const pty = new FakePty()
  pty.exitOnRegister = true
  const verify = vi.fn(async () => row('READY', '/tmp/claude-primary', 'primary', 'B'))
  const c = new AccountController(() => s, 'claude', undefined, { verify, spawnLogin: () => pty })
  try {
    const changed = await c.login(
      parseLoginPayload({ op: 'open', attempt: ATTEMPT, id: 'A', alias: 'primary' }),
    )
    expect(changed.exchange).toMatchObject({
      phase: 'failed',
      failureCode: 'ALIAS_IDENTITY_CHANGED',
    })
    expect(s.get<Account>('accounts', 'A')?.state).toBe('DISABLED')
    expect(s.get('accounts', 'B')).toBeUndefined()
    expect(JSON.stringify(changed)).not.toContain(SAMPLE_CODE)
    expect(JSON.stringify(changed)).not.toContain('fixture')
  } finally {
    c.dispose()
    s.close()
  }
})

it('does not spawn for draining or cooldown', async () => {
  for (const state of ['DRAINING', 'COOLDOWN'] as const) {
    const s = new StateStore(':memory:')
    s.set('accounts', 'A', row(state, 'default', 'primary'))
    const spawnLogin = vi.fn(() => new FakePty())
    const c = new AccountController(() => s, 'claude', undefined, { spawnLogin })
    try {
      await expect(c.login(open('primary'))).rejects.toThrow('ACCOUNT_NOT_READY')
      expect(spawnLogin).not.toHaveBeenCalled()
    } finally {
      c.dispose()
      s.close()
    }
  }
})

it('refuses a reservation on this profile and allows one on another', async () => {
  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('READY', 'default', 'primary'))
  s.set('accounts', 'B', row('READY', '/tmp/claude-other', 'other', 'B'))
  s.set('bindings', 'live', {
    key: 'live',
    identity: 'A',
    model: 'opus',
    generation: 4,
    committedCursor: 0,
    pendingTools: [],
    reason: 'work-conserving-sticky',
  })
  s.set('reservations', 'r', {
    requestId: 'r',
    identity: 'A',
    session: 'live',
    epochs: {},
    predictedWork: 1,
    createdAt: 1,
  })
  const spawnLogin = vi.fn(() => new FakePty())
  const c = new AccountController(() => s, 'claude', undefined, { spawnLogin })
  try {
    await expect(c.login(open('primary'))).rejects.toThrow('PROFILE_LOGIN_BUSY')
    expect(spawnLogin).not.toHaveBeenCalled()
    expect(s.get<Binding>('bindings', 'live')?.generation).toBe(4)
    expect(s.get<Binding>('bindings', 'live')?.reason).toBe('work-conserving-sticky')
    s.delete('reservations', 'r')
    s.set('reservations', 'other', {
      requestId: 'other',
      identity: 'B',
      session: 'other-live',
      epochs: {},
      predictedWork: 1,
      createdAt: 1,
    })
    const pty = new FakePty()
    pty.urlOnData = true
    spawnLogin.mockImplementation(() => pty)
    const opened = await c.login(open('primary'))
    expect(opened.exchange.phase).toBe('needs_code')
    expect(spawnLogin).toHaveBeenCalledOnce()
    expect(s.get<Binding>('bindings', 'live')?.generation).toBe(4)
  } finally {
    c.dispose()
    s.close()
  }
})

it('verifies when the child exits 0 before a paste', async () => {
  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('READY', 'default', 'primary'))
  const pty = new FakePty()
  pty.exitOnRegister = true
  const verify = vi.fn(async () => row('READY', 'default', 'primary'))
  const c = new AccountController(() => s, 'claude', undefined, { verify, spawnLogin: () => pty })
  try {
    const done = await c.login(open('primary'))
    expect(done.exchange.phase).toBe('ready')
    expect(pty.writes).toEqual([])
    expect(verify).toHaveBeenCalledOnce()
    expect(s.get<Account>('accounts', 'A')?.state).toBe('READY')
  } finally {
    c.dispose()
    s.close()
  }
})

it('fails an incomplete login on timeout and releases the gate', async () => {
  vi.useFakeTimers()
  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('READY', 'default', 'primary'))
  const pty = new FakePty()
  const c = new AccountController(() => s, 'claude', undefined, { spawnLogin: () => pty })
  try {
    const opened = await c.login(open('primary'))
    expect(opened.exchange.phase).toBe('opening')
    expect(profileLoginHeld(s, 'default')).toBe(true)
    await vi.advanceTimersByTimeAsync(180_000)
    const after = await c.login(parseLoginPayload({ op: 'read', alias: 'primary' }))
    expect(after.exchange).toMatchObject({ phase: 'failed', failureCode: 'LOGIN_INCOMPLETE' })
    expect(profileLoginHeld(s, 'default')).toBe(false)
    expect(pty.killed).toBe(true)
  } finally {
    c.dispose()
    s.close()
    vi.useRealTimers()
  }
})

it('lets two profiles exchange at the same time', async () => {
  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('READY', 'default', 'primary'))
  s.set('accounts', 'B', row('READY', '/tmp/claude-other', 'other', 'B'))
  const ptys: FakePty[] = []
  const c = new AccountController(() => s, 'claude', undefined, {
    spawnLogin: () => {
      const pty = new FakePty()
      pty.urlOnData = true
      ptys.push(pty)
      return pty
    },
  })
  try {
    const [first, second] = await Promise.all([
      c.login(open('primary')),
      c.login(open('other', { profile: '/tmp/claude-other' })),
    ])
    expect(first.exchange.phase).toBe('needs_code')
    expect(second.exchange.phase).toBe('needs_code')
    expect(ptys).toHaveLength(2)
    expect(profileLoginHeld(s, 'default')).toBe(true)
    expect(profileLoginHeld(s, '/tmp/claude-other')).toBe(true)
  } finally {
    c.dispose()
    s.close()
  }
})

it('routes another account when one profile is held', () => {
  const s = new StateStore(':memory:')
  const primary = row('READY', 'default', 'primary')
  const other = row('READY', '/tmp/claude-other', 'other', 'B')
  const router = new StickyRouter(s)
  router.register(primary)
  router.register(other)
  const gate = new ProfileLoginGate()
  bindLoginGate(s, gate)
  gate.hold('default')
  const req = { session: 'fresh', requestId: 'r', model: 'opus', now: 1 }
  expect(
    choose([primary, other], req, [], new Set(), (ref) => profileLoginHeld(s, ref)).identity,
  ).toBe('B')
  expect(router.route(req).identity).toBe('B')
  s.set('bindings', 'pinned', {
    key: 'pinned',
    identity: 'A',
    model: 'opus',
    generation: 4,
    committedCursor: 0,
    pendingTools: [],
    reason: 'work-conserving-sticky',
  })
  expect(() =>
    router.route({ session: 'pinned', requestId: 'held', model: 'opus', now: 1 }),
  ).toThrow('SUBSCRIPTION_LOGIN_REQUIRED')
  expect(
    s.list<Reservation>('reservations').some((reservation) => reservation.identity === 'A'),
  ).toBe(false)
  expect(s.get<Binding>('bindings', 'pinned')?.generation).toBe(4)
  s.close()
})

it('retires only an idle manager for the profile being logged in', async () => {
  const disposed = { A: vi.fn(async () => {}), B: vi.fn(async () => {}) }
  const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
  const p = new SubscriptionProvider(
    {} as SubprocessRuntime,
    resolveConfig({ stateDirectory: ':memory:' }),
    undefined,
    {
      authenticate: async () => {},
      createManager: (account) => ({
        dispose: account.identity === 'A' ? disposed.A : disposed.B,
        async *stream() {
          yield stop
        },
      }),
    },
  )
  const request = (session: string): GenerateOptions => ({
    provider: 'claude-sdk-local',
    model: 'opus',
    sessionId: session as never,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })
  const primary = row('READY', 'default', 'primary')
  new StickyRouter(p.store).register(primary)
  try {
    for await (const _chunk of p.stream(request('a'), 'opus'));
    new StickyRouter(p.store).register(row('READY', '/tmp/claude-other', 'other', 'B'))
    p.store.set('accounts', 'A', { ...primary, state: 'DISABLED' })
    for await (const _chunk of p.stream(request('b'), 'opus'));
    p.store.set('accounts', 'A', primary)
    const bindings = p.store.list<Binding>('bindings')
    const boundA = bindings.find((binding) => binding.identity === 'A')
    const boundB = bindings.find((binding) => binding.identity === 'B')
    expect(boundA?.generation).toBe(1)
    expect(boundB?.generation).toBe(1)
    const gate = new ProfileLoginGate()
    bindLoginGate(p.store, gate)
    gate.hold('default')
    const held: StreamChunk[] = []
    for await (const chunk of p.stream(request('a'), 'opus')) held.push(chunk)
    expect(held.at(-1)).toMatchObject({
      reason: { failure: { code: 'SUBSCRIPTION_LOGIN_REQUIRED' } },
    })
    expect(disposed.A).not.toHaveBeenCalled()
    p.store.set('reservations', 'busy', {
      requestId: 'busy',
      identity: 'A',
      session: boundA!.key,
      epochs: {},
      predictedWork: 1,
      createdAt: 1,
    })
    p.retireIdle('default')
    expect(p.store.get<Binding>('bindings', boundA!.key)?.generation).toBe(1)
    expect(disposed.A).not.toHaveBeenCalled()
    p.store.delete('reservations', 'busy')
    p.retireIdle('default')
    expect(p.store.get<Binding>('bindings', boundA!.key)).toMatchObject({
      generation: 2,
      reason: 'profile-relogin',
    })
    expect(p.store.get<Binding>('bindings', boundA!.key)?.sdkSessionId).toBeUndefined()
    expect(disposed.A).toHaveBeenCalledOnce()
    expect(disposed.B).not.toHaveBeenCalled()
    expect(p.store.get<Binding>('bindings', boundB!.key)?.generation).toBe(1)
    p.retireIdle('default')
    expect(p.store.get<Binding>('bindings', boundA!.key)?.generation).toBe(2)
    expect(disposed.A).toHaveBeenCalledOnce()
    gate.release('default')
    disposed.A.mockImplementation(async () => {
      throw new Error('child already gone')
    })
    for await (const _chunk of p.stream(request('a'), 'opus'));
    p.retireIdle('default')
    await expect(disposed.A.mock.results.at(-1)?.value).rejects.toThrow('child already gone')
    expect(p.store.get<Binding>('bindings', boundA!.key)?.generation).toBe(3)
    expect(disposed.A).toHaveBeenCalledTimes(2)
  } finally {
    await p.dispose()
  }
})

it('prints the authorize url once on the cli and leaves it out of the status json', async () => {
  const s = new StateStore(':memory:')
  const pty = new FakePty()
  pty.urlOnData = true
  const verify = vi.fn(async () => row('READY', '/tmp/claude-primary', 'primary'))
  const c = new AccountController(() => s, 'claude', undefined, {
    verify,
    spawnLogin: () => {
      pty.write = (bytes) => {
        pty.writes.push(bytes)
        pty.finish(0)
      }
      return pty
    },
  })
  const urls: string[] = []
  const output = vi.fn()
  try {
    expect(
      await runProviderCli(
        ['accounts', 'add', 'primary', '--login', '--profile', '/tmp/claude-primary'],
        {
          store: () => s,
          controller: () => c,
          output,
          loginIo: {
            writeUrl(url) {
              urls.push(url)
            },
            readLine: async () => SAMPLE_CODE,
          },
        },
      ),
    ).toBe(0)
    expect(urls).toEqual([SAMPLE_URL])
    expect(pty.writes).toEqual([`${SAMPLE_CODE}\r`])
    expect(JSON.stringify(output.mock.calls)).not.toContain(SAMPLE_URL)
    expect(JSON.stringify(output.mock.calls)).not.toContain(SAMPLE_CODE)
    expect(JSON.stringify(output.mock.calls)).not.toContain('fixture')
  } finally {
    c.dispose()
    s.close()
  }
})

it('verifies a cli login that exits before asking for a code', async () => {
  const s = new StateStore(':memory:')
  s.set('accounts', 'A', row('READY', 'default', 'primary'))
  const pty = new FakePty()
  pty.exitOnRegister = true
  const verify = vi.fn(async () => row('READY', 'default', 'primary'))
  const readLine = vi.fn(async () => SAMPLE_CODE)
  const writeUrl = vi.fn()
  const c = new AccountController(() => s, 'claude', undefined, { verify, spawnLogin: () => pty })
  try {
    expect(
      await runProviderCli(['accounts', 'add', 'primary', '--login'], {
        store: () => s,
        controller: () => c,
        output: vi.fn(),
        loginIo: { writeUrl, readLine },
      }),
    ).toBe(0)
    expect(readLine).not.toHaveBeenCalled()
    expect(writeUrl).not.toHaveBeenCalled()
    expect(verify).toHaveBeenCalledOnce()
  } finally {
    c.dispose()
    s.close()
  }
})

it('fails accounts add --login with STATE_IN_USE before a child exists', async () => {
  const spawnLogin = vi.fn()
  const output = vi.fn()
  expect(
    await runProviderCli(['accounts', 'add', 'primary', '--login'], {
      output,
      store: () => {
        throw new Error('STATE_IN_USE: held')
      },
      controller: () => {
        spawnLogin()
        throw new Error('controller constructed')
      },
    }),
  ).toBe(2)
  expect(output).toHaveBeenCalledWith({ status: 'BLOCKED', code: 'STATE_IN_USE' })
  expect(spawnLogin).not.toHaveBeenCalled()
})

it('keeps gate writes out of the router and the provider', () => {
  for (const path of ['src/routing/router.ts', 'src/sessions/provider.ts']) {
    const text = readFileSync(path, 'utf8')
    expect(text).toContain('profileLoginHeld')
    expect(text).not.toContain('bindLoginGate')
    expect(text).not.toContain('ProfileLoginGate')
    expect(text).not.toContain('.hold(')
    expect(text).not.toContain('gate.release')
  }
  for (const path of sources('src')) {
    const text = readFileSync(path, 'utf8')
    if (!path.endsWith(`${join('src', 'ui', 'login-pty.ts')}`))
      expect(text).not.toContain("from 'node-pty'")
    if (
      !path.endsWith(`${join('src', 'ui', 'controller.ts')}`) &&
      !path.endsWith(`${join('src', 'ui', 'login-pty.ts')}`)
    )
      expect(text).not.toContain('login-pty')
  }
  for (const path of sources('src/client')) {
    const text = readFileSync(path, 'utf8')
    expect(text).not.toContain('login-exchange')
    expect(text).not.toContain('login-pty')
  }
})
