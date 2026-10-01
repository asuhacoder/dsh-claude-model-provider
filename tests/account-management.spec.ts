import { it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { StateStore, recoverStateLock } from '../src/storage/store.js'
import { AccountController } from '../src/ui/controller.js'
import { accountRoute, registerAccountUi, actions, type ProviderRoute } from '../src/ui/rpc.js'
import { runProviderCli } from '../src/provider-cli.js'
import { accountModelCatalog, accountModelInfo } from '../src/models.js'
import { type Account, RouteBlocked } from '../src/routing/types.js'
const account = (alias = 'one'): Account => ({
  identity: 'A',
  aliases: [alias],
  profileRef: 'default',
  state: 'READY',
  verifiedAt: 1,
  extraUsageOffConfirmedAt: 1,
  models: { opus: ['low', 'high', 'max'], haiku: [] },
  windows: [],
  parallelLimit: 1,
})
function setup() {
  const s = new StateStore(':memory:')
  const verify = vi.fn(async (_s, _c, alias) => account(alias))
  const login = vi.fn(async () => {})
  const c = new AccountController(() => s, 'claude', undefined, { verify, login })
  return { s, c, verify, login }
}
it('manages verified aliases, defaults, removal, unknown quota and usage without disclosing profiles', async () => {
  const { s, c, verify, login } = setup()
  try {
    await c.execute('add', { alias: 'one', extraUsageOff: true })
    await c.execute('add', { alias: 'two' })
    expect(c.status().accounts).toHaveLength(1)
    await c.execute('setDefault', { alias: 'one' })
    await c.execute('verify', { alias: 'one' })
    await c.execute('setModel', { model: 'haiku' })
    expect(c.status()).toMatchObject({
      defaultModel: 'haiku',
      accounts: [{ isDefault: true, aliases: ['one', 'two'] }],
    })
    expect(JSON.stringify(c.status())).not.toContain('profileRef')
    await c.execute('remove', { alias: 'one' })
    expect(c.status().accounts[0]?.aliases).toEqual(['two'])
    await c.execute('login', { alias: 'two', profile: 'default' })
    expect(login).toHaveBeenCalledOnce()
    await c.execute('remove', { alias: 'two' })
    expect(c.status().accounts[0]?.state).toBe('DISABLED')
    expect(verify).toHaveBeenCalledTimes(4)
  } finally {
    s.close()
  }
})
it('blocks invalid inputs, active removal/login, alias identity replacement and invalid models', async () => {
  const { s, c, verify } = setup()
  try {
    for (const [action, payload, code] of [
      ['add', null, 'INVALID_PAYLOAD'],
      ['add', { alias: 'bad name' }, 'INVALID_ALIAS'],
      ['add', { alias: 'a', profile: 2 }, 'INVALID_PROFILE'],
      ['add', { alias: 'a', profile: 'relative' }, 'PROFILE_MUST_BE_ABSOLUTE'],
      ['verify', { alias: 'missing' }, 'ACCOUNT_NOT_FOUND'],
      ['remove', { alias: 'missing' }, 'ACCOUNT_NOT_FOUND'],
      ['setModel', { model: 'missing' }, 'MODEL_CAPABILITY_UNAVAILABLE'],
    ] as const)
      await expect(c.execute(action, payload)).rejects.toThrow(code)
    await c.execute('add', { alias: 'one' })
    s.set('reservations', 'r', { identity: 'A' })
    await expect(c.execute('remove', { alias: 'one' })).rejects.toThrow('ACCOUNT_BUSY')
    await expect(c.execute('login', { alias: 'one' })).rejects.toThrow('LOGIN_REQUIRES_IDLE')
    s.delete('reservations', 'r')
    await expect(c.execute('unknown', { alias: 'one' })).rejects.toThrow('UNKNOWN_ACTION')
    verify.mockResolvedValue({ ...account(), identity: 'B' })
    await expect(c.execute('verify', { alias: 'one' })).rejects.toThrow('ALIAS_IDENTITY_CHANGED')
    const a = account()
    a.state = 'DISABLED'
    s.set('accounts', 'A', a)
    await expect(c.execute('setDefault', { alias: 'one' })).rejects.toThrow('ACCOUNT_NOT_READY')
  } finally {
    s.close()
  }
})
it('advertises only verified active capabilities and labels missing quota as unknown', () => {
  const { s, c } = setup()
  const a = account()
  a.windows = [
    { key: 'x', scope: '*', epoch: '1', observedAt: 1, source: 'sdk' },
    { key: 'y', scope: '*', epoch: '1', observedAt: 2, utilization: 0.8, source: 'sdk' },
  ]
  delete a.extraUsageOffConfirmedAt
  s.set('accounts', 'A', a)
  expect(c.status().accounts[0]).toMatchObject({
    billingSafety: 'unverified',
    windows: [{ remaining: null }, { remaining: expect.closeTo(0.2) }],
  })
  expect(accountModelCatalog([a], 'opus').map((m) => m.id)).toEqual(['default', 'haiku', 'opus'])
  expect(
    accountModelInfo([a], 'claude-sdk-local', 'default', 'opus').reasoning?.efforts.map(
      (e) => e.id,
    ),
  ).toEqual(['low', 'high', 'max'])
  expect(() => accountModelInfo([], 'claude-sdk-local', 'opus', 'opus')).toThrow()
  expect(accountModelCatalog([{ ...a, state: 'DISABLED' }], 'opus')).toEqual([])
  s.close()
})
it('validates authenticated host RPC envelopes and returns only redacted errors', async () => {
  const { s, c } = setup(),
    route = accountRoute('status', c)
  const req = (
    body: unknown,
    headers: Record<string, string> = { 'content-type': 'application/json' },
  ) =>
    new Request('http://localhost/api/claude-sdk-local.status', {
      method: 'POST',
      headers,
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  expect((await route.fetch(new Request('http://localhost/'))).status).toBe(405)
  expect((await route.fetch(req('{}', {}))).status).toBe(415)
  expect((await route.fetch(req('oops'))).status).toBe(400)
  expect((await route.fetch(req('x'.repeat(8193)))).status).toBe(413)
  expect((await route.fetch(req('null'))).status).toBe(400)
  const valid = {
    type: 'client-request',
    rpcId: '1',
    method: 'claude-sdk-local.status',
    payload: {},
  }
  expect(await (await route.fetch(req(valid))).json()).toMatchObject({
    type: 'server-response',
    rpcId: '1',
    result: { ok: true },
  })
  for (const body of [{ ...valid, method: 'other' }, { ...valid, type: 'other' }, {}])
    expect(await (await route.fetch(req(body))).json()).toMatchObject({
      result: { ok: false, error: { code: 'INVALID_ENVELOPE' } },
    })
  const errorRoute = accountRoute('add', c)
  expect(
    await (
      await errorRoute.fetch(
        req({ ...valid, method: 'claude-sdk-local.add', payload: { alias: 'x', profile: 2 } }),
      )
    ).json(),
  ).toMatchObject({ result: { ok: false, error: { code: 'INVALID_PROFILE' } } })
  const routes: ProviderRoute[] = []
  const ctx = {
    inject: (_names: unknown, fn: (c: unknown) => void) =>
      fn({
        get: () => ({
          fetch: {
            register: (r: ProviderRoute) => {
              routes.push(r)
              return async () => {}
            },
          },
        }),
        effect: (fn: () => unknown) => fn(),
      }),
  }
  registerAccountUi(ctx as never, c)
  expect(routes).toHaveLength(actions.length)
  s.close()
})
it('supports safe read-only diagnostics during a live writer and explicit dead-lock recovery', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-state-'))
  try {
    const writer = new StateStore(dir)
    writer.set('fixture', 'x', 1)
    const reader = new StateStore(dir, { readOnly: true })
    expect(reader.get('fixture', 'x')).toBe(1)
    expect(() => reader.set('fixture', 'x', 2)).toThrow()
    reader.close()
    expect(() => recoverStateLock(dir)).toThrow('STATE_IN_USE')
    writer.close()
    writeFileSync(join(dir, 'writer.lock'), JSON.stringify({ pid: 2147483647, owner: 'dead' }))
    expect(recoverStateLock(dir).status).toBe('STALE_LOCK_RECOVERED')
    expect(() => recoverStateLock(dir)).toThrow('RECOVERY_LOCK_UNREADABLE')
    writeFileSync(join(dir, 'writer.lock'), '{}')
    expect(() => recoverStateLock(dir)).toThrow('RECOVERY_LOCK_INVALID')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
it('runs CLI account and diagnostic operations without executing on import', async () => {
  for (const args of [
    [],
    ['accounts', 'list'],
    ['accounts', 'add', 'one', '--extra-usage-off'],
    ['accounts', 'add', 'one', '--login', '--profile', 'default'],
    ['accounts', 'remove', 'one'],
    ['explain-route'],
    ['diagnostics', 'export', '--redacted'],
  ]) {
    const { s, c } = setup()
    s.set('accounts', 'A', account())
    s.set('bindings', 'one', { key: 'one', identity: 'A' })
    const out = vi.fn()
    expect(await runProviderCli(args, { store: () => s, controller: () => c, output: out })).toBe(0)
    expect(out).toHaveBeenCalledOnce()
  }
  const out = vi.fn()
  expect(
    await runProviderCli(['accounts', 'add'], {
      store: () => new StateStore(':memory:'),
      output: out,
    }),
  ).toBe(2)
  expect(out).toHaveBeenLastCalledWith({ status: 'BLOCKED', code: 'ALIAS_REQUIRED' })
  expect(
    await runProviderCli(['accounts', 'list'], {
      store: () => {
        throw new Error('private secret')
      },
      output: out,
    }),
  ).toBe(1)
  expect(JSON.stringify(out.mock.calls)).not.toContain('private secret')
})
it('separates offline doctor, guarded live doctor, recovery and diagnostic failure', async () => {
  const output = vi.fn(),
    doctor = vi.fn(async () => ({ overall: 'pass' }) as never),
    status = vi.fn(async () => ({ loggedIn: true }))
  expect(await runProviderCli(['doctor', '--offline'], { output, doctor, status })).toBe(0)
  expect(status).not.toHaveBeenCalled()
  expect(await runProviderCli(['doctor', '--live'], { output, doctor, status })).toBe(2)
  expect(
    await runProviderCli(['doctor', '--live', '--budget-generations', '0'], {
      output,
      doctor,
      status,
    }),
  ).toBe(2)
  expect(
    await runProviderCli(['doctor', '--live', '--extra-usage-off'], { output, doctor, status }),
  ).toBe(0)
  expect(status).toHaveBeenCalledOnce()
  doctor.mockResolvedValue({ overall: 'fail' } as never)
  expect(await runProviderCli(['doctor'], { output, doctor })).toBe(1)
  expect(
    await runProviderCli(['doctor', '--recover'], {
      output,
      recover: () => ({ status: 'STALE_LOCK_RECOVERED' }),
    }),
  ).toBe(0)
  expect(
    await runProviderCli(['accounts', 'list'], {
      output,
      store: () => {
        throw new RouteBlocked('TEST')
      },
    }),
  ).toBe(2)
})
